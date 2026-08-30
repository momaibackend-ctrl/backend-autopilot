import 'dotenv/config';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { ArtifactStore } from '../packages/artifact-store/src/index.js';
import { SupabaseStorageArtifactBlobStore } from '../packages/adapters/supabase/src/artifact-storage.js';
import { LocalGitAdapter } from '../packages/adapters/git/src/index.js';
import { AutopilotService } from '../packages/core/src/application.js';
import { PolicyViolation } from '../packages/core/src/errors.js';
import { systemClock, uuidGenerator } from '../packages/core/src/ports.js';
import { dimensionOutcome, parseJUnitResults, type ExecutedTest } from '../packages/core/src/epic-check-plan.js';
import { CommandPolicy, CommandRunner, ExecutionEngine, StackAwareTestExecutor, buildPropertyBasedReport, detectStack, parsePropertyRunnerOutput } from '../packages/execution-engine/src/index.js';
import { requireProjectGithubRepository } from '../packages/core/src/repository-guard.js';
import { PostgresStateStore } from '../packages/project-registry/src/index.js';
import type { EpicDimension, EpicVerificationReport } from '../packages/schemas/src/index.js';

// Produces the evidence the epic gate judges.
//
// The single rule that makes this trustworthy is the immutable checkout. Everything below runs
// against ONE commit, checked out detached and verified by SHA before anything else happens. A run
// that took half its results from one `main` and half from a `main` that moved underneath it would
// produce a report about a state that never existed -- which is precisely the failure mode the epic
// gate was built to end, so reproducing it here would be self-defeating.
//
// The second rule is that this script never decides whether the epic passes. It records what ran,
// attributes results to dimensions, and hands the verdict to superadmin_epic_verify. It cannot mark
// its own homework.

const RUNNER_VERSION = 'epic-verification/1';

const inputSchema = z.object({
  projectId: z.string().uuid(),
  epicKey: z.string().min(1),
  headSha: z.string().regex(/^[0-9a-f]{40}$/),
  resourceId: z.string().uuid(),
  externalKeyPrefix: z.string().min(1).optional(),
  taskIds: z.array(z.string().uuid()).optional(),
  /**
   * Maps the target project's own integration variable names onto the disposable services this
   * runner provisions. Project data, not control-plane knowledge: Autopilot must not carry any
   * particular backend's variable names in its source.
   */
  serviceEnv: z.record(z.enum(['POSTGRES_URL', 'REDIS_URL', 'S3_ENDPOINT', 'S3_ACCESS_KEY', 'S3_SECRET_KEY', 'S3_BUCKET'])).default({}),
});

const input = inputSchema.parse(JSON.parse(required('AUTOPILOT_EPIC_INPUT')));
const store = new PostgresStateStore(required('DATABASE_URL'));
const githubToken = required('AUTOPILOT_GITHUB_TOKEN');
const actor = `github-actions:${process.env['GITHUB_RUN_ID'] ?? '0'}:${process.env['GITHUB_RUN_ATTEMPT'] ?? '1'}`;
const workflowRunUrl =
  process.env['GITHUB_SERVER_URL'] && process.env['GITHUB_REPOSITORY'] && process.env['GITHUB_RUN_ID']
    ? `${process.env['GITHUB_SERVER_URL']}/${process.env['GITHUB_REPOSITORY']}/actions/runs/${process.env['GITHUB_RUN_ID']}`
    : undefined;

try {
  const commands = new CommandRunner(new CommandPolicy(), systemClock);
  const blobs = new SupabaseStorageArtifactBlobStore(required('SUPABASE_URL'), required('SUPABASE_SERVICE_ROLE_KEY'));
  const service = new AutopilotService({
    store,
    execution: new ExecutionEngine(new LocalGitAdapter(commands), systemClock),
    tests: new StackAwareTestExecutor(commands, systemClock),
    git: new LocalGitAdapter(commands),
    commands,
    artifactBlobs: blobs,
  });
  const artifacts = new ArtifactStore(store, uuidGenerator, systemClock, blobs);

  const resource = await requireProjectGithubRepository(store, input.projectId, input.resourceId);
  if (resource.environment !== 'SANDBOX') throw new PolicyViolation('Epic verification targets an allowlisted sandbox repository only');

  // Ask the gate what this epic owes BEFORE running anything, so the run covers the dimensions the
  // members actually declared rather than a fixed list this script decided on.
  const preflight = await service.epicVerification(
    { projectId: input.projectId, epicKey: input.epicKey, headSha: input.headSha, repository: resource.externalReference, ...select() },
    actor,
  );
  const required_ = preflight.report.dimensions.filter((value) => value.requirement === 'REQUIRED').map((value) => value.dimension);
  log('info', 'epic.preflight', { required: required_, members: preflight.report.members.length });

  const workspace = await checkoutExactCommit(resource.externalReference);
  // Each effective member proved its work at some commit; this asks git whether that commit is
  // actually reachable from the head being released. A member verified on a branch that never
  // landed is green about work nobody is shipping.
  const containment = await commitContainment(workspace, preflight.report);
  log('info', 'epic.containment', containment);
  const stack = await detectStack(workspace);
  const { tests, transcript } = await runSuite(workspace, stack);
  log('info', 'epic.suite.complete', { stack, tests: tests.length });

  // The whole transcript, kept as evidence. Without it a failed dimension reports which tests
  // failed but never why, and the run log carries only this script's own verdict events -- which is
  // how the first real epic run produced six failures nobody could diagnose without re-running it.
  const transcriptHash = createHash('sha256').update(transcript).digest('hex');
  const transcriptArtifact = await artifacts.write(input.projectId, 'COMMAND_STDOUT', {
    epicKey: input.epicKey,
    headSha: input.headSha,
    scope: 'EPIC_VERIFICATION_SUITE',
    sha256: transcriptHash,
    transcript,
  });
  log('info', 'epic.transcript.recorded', { artifactId: transcriptArtifact.id, sha256: transcriptHash, bytes: transcript.length });

  const parsed = parsePropertyRunnerOutput(transcript);
  // Scoped to the property suite on purpose. Deriving this from "did anything in the build fail"
  // reported INVARIANTS as failed because five unrelated integration tests failed -- attributing
  // one dimension's verdict to another dimension's problem, which is the opposite of the point.
  const propertyTestsFailed = dimensionOutcome('INVARIANTS', tests).failedTests.length > 0;
  const propertyReport = buildPropertyBasedReport({
    required: required_.includes('INVARIANTS'),
    suitePassed: !propertyTestsFailed,
    parsed,
    source: parsed ? 'PARSED_RUNNER_OUTPUT' : 'NONE',
  });

  for (const dimension of required_) {
    const outcome = dimensionOutcome(
      dimension,
      tests,
      undefined,
      dimension === 'INVARIANTS' ? { passed: propertyReport.status === 'PASS', detail: propertyReport.reasons.join('; ') } : undefined,
    );
    await service.epicEvidenceRecord(
      {
        projectId: input.projectId,
        operationId: `epic-${input.epicKey}-${dimension}-${input.headSha.slice(0, 12)}`,
        epicKey: input.epicKey,
        dimension,
        commitSha: input.headSha,
        passed: outcome.passed,
        repository: resource.externalReference,
        detail: outcome.failedTests.length ? `${outcome.detail}: ${outcome.failedTests.slice(0, 5).join(', ')}` : outcome.detail,
        ...(process.env['GITHUB_RUN_ID'] ? { workflowRunId: process.env['GITHUB_RUN_ID'] } : {}),
        ...(workflowRunUrl ? { workflowRunUrl } : {}),
        artifactHash: transcriptHash,
        runnerVersion: RUNNER_VERSION,
      },
      actor,
    );
    log(outcome.passed ? 'info' : 'warn', 'epic.dimension', { dimension, passed: outcome.passed, matched: outcome.matched, detail: outcome.detail });
  }

  const verified = await service.epicVerification(
    { projectId: input.projectId, epicKey: input.epicKey, headSha: input.headSha, repository: resource.externalReference, persist: true, containment, ...select() },
    actor,
  );
  const report = verified.report;
  log('info', 'epic.verification.complete', {
    result: report.result,
    trust: report.trust,
    missing: report.missingDimensions,
    artifactId: verified.persisted?.id,
  });
  for (const blocker of report.blockers) log('warn', 'epic.blocker', { code: blocker.code, reason: blocker.reason });
  if (report.result !== 'PASS') {
    console.error(`Epic ${input.epicKey} is BLOCKED at ${input.headSha}: ${report.blockers.map((b) => b.code).join(', ')}`);
    process.exitCode = 1;
  }
} finally {
  await store.close();
}

/** Asks git, per member, whether the commit it was verified at is an ancestor of the epic head. */
async function commitContainment(workspace: string, report: EpicVerificationReport) {
  const commands = new CommandRunner(new CommandPolicy(), systemClock);
  const containment: Record<string, boolean> = {};
  for (const member of report.members) {
    if (member.supersededBy || !member.verifiedCommitSha) continue;
    const known = await commands.run({ command: 'git', args: ['cat-file', '-e', `${member.verifiedCommitSha}^{commit}`], cwd: workspace, taskId: uuidGenerator.next(), allowed: ['READ'] });
    if (known.record.exitCode !== 0) {
      // The commit is not in this clone at all -- a squash-merge or a deleted branch. Unknown is
      // not the same as absent, so it is left unset rather than reported as unreachable.
      log('warn', 'epic.containment.unknown_commit', { externalKey: member.externalKey, commitSha: member.verifiedCommitSha });
      continue;
    }
    const ancestor = await commands.run({ command: 'git', args: ['merge-base', '--is-ancestor', member.verifiedCommitSha, input.headSha], cwd: workspace, taskId: uuidGenerator.next(), allowed: ['READ'] });
    containment[member.taskId] = ancestor.record.exitCode === 0;
  }
  return containment;
}

function select() {
  return input.taskIds?.length ? { taskIds: input.taskIds } : { externalKeyPrefix: input.externalKeyPrefix! };
}

/**
 * Clones and pins to the exact commit. Detached on purpose: a branch name would let the target move
 * between the checkout and the last suite, and the whole report is a claim about one commit.
 */
async function checkoutExactCommit(repository: string) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new PolicyViolation('Registered repository identity is invalid');
  const root = process.env['RUNNER_TEMP'] ?? process.cwd();
  const workspace = await mkdtemp(join(root, 'autopilot-epic-'));
  const commands = new CommandRunner(new CommandPolicy(), systemClock);
  const env = { GH_TOKEN: githubToken };
  const run = async (command: string, args: string[], cwd: string, allowed: ('READ' | 'BUILD' | 'NETWORK' | 'TEST')[]) => {
    const result = await commands.run({ command, args, cwd, taskId: uuidGenerator.next(), allowed, env });
    if (result.record.exitCode !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr.slice(0, 400)}`);
    return result;
  };
  await run('gh', ['auth', 'setup-git'], root, ['NETWORK']);
  await run('gh', ['repo', 'clone', repository, workspace, '--', '--no-tags'], root, ['NETWORK']);
  await run('git', ['checkout', '--detach', input.headSha], workspace, ['BUILD']);
  const head = await run('git', ['rev-parse', 'HEAD'], workspace, ['READ']);
  const actual = head.stdout.trim();
  if (actual !== input.headSha) throw new Error(`Checkout did not pin the requested commit (wanted ${input.headSha}, got ${actual})`);
  log('info', 'epic.checkout.pinned', { repository, headSha: actual });
  return workspace;
}

async function runSuite(workspace: string, stack: string) {
  const commands = new CommandRunner(new CommandPolicy(), systemClock);
  const env = serviceEnvironment();
  const taskId = uuidGenerator.next();
  const command = stack === 'KOTLIN_GRADLE' ? join(workspace, 'gradlew') : 'pnpm';
  const args = stack === 'KOTLIN_GRADLE' ? ['build', '--no-daemon', '--console=plain'] : ['test'];
  // A failing suite is a result, not a crash: the dimensions it failed have to be recorded as
  // failures rather than losing the whole run.
  const result = await commands.run({ command, args, cwd: workspace, taskId, allowed: ['TEST', 'BUILD'], env });
  const tests = await collectJUnitResults(workspace);
  const transcript = `${result.stdout}\n${result.stderr}`;
  if (result.record.exitCode !== 0) {
    // Surfaced in the run log too, not only in the artifact: the first thing anyone does with a red
    // epic run is open the log, and finding only a verdict there sends them re-running it by hand.
    console.log(transcript.split(/\r?\n/).slice(-150).join('\n'));
  }
  return { tests, transcript };
}

/** Applies the project's own variable names to this run's disposable services. */
function serviceEnvironment(): Record<string, string> {
  const canonical: Record<string, string | undefined> = {
    POSTGRES_URL: process.env['AUTOPILOT_EPIC_POSTGRES_URL'],
    REDIS_URL: process.env['AUTOPILOT_EPIC_REDIS_URL'],
    S3_ENDPOINT: process.env['AUTOPILOT_EPIC_S3_ENDPOINT'],
    S3_ACCESS_KEY: process.env['AUTOPILOT_EPIC_S3_ACCESS_KEY'],
    S3_SECRET_KEY: process.env['AUTOPILOT_EPIC_S3_SECRET_KEY'],
    S3_BUCKET: process.env['AUTOPILOT_EPIC_S3_BUCKET'],
  };
  const env: Record<string, string> = {};
  for (const [name, key] of Object.entries(input.serviceEnv)) {
    const value = canonical[key];
    if (value) env[name] = value;
    else log('warn', 'epic.service_env.absent', { name, key });
  }
  return env;
}

async function collectJUnitResults(workspace: string): Promise<ExecutedTest[]> {
  const roots = ['build/test-results', 'target/surefire-reports', 'test-results'];
  const tests: ExecutedTest[] = [];
  for (const relative of roots) {
    for (const file of await xmlFiles(join(workspace, relative))) {
      try {
        tests.push(...parseJUnitResults(await readFile(file, 'utf8')));
      } catch (error) {
        log('warn', 'epic.results.unreadable', { file, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return tests;
}

async function xmlFiles(directory: string): Promise<string[]> {
  const found: string[] = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await xmlFiles(path)));
    else if (entry.name.endsWith('.xml')) found.push(path);
  }
  return found;
}

function log(level: string, event: string, fields: Record<string, unknown>) {
  console.log(JSON.stringify({ level, event, epicKey: input.epicKey, headSha: input.headSha, ...fields }));
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export type { EpicDimension };
