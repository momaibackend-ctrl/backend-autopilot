// What the control plane can prove about a task's change -- not what an agent says about it.
//
// An agent reported "everything transferred" while the working repository did not compile; the
// owner had no way to tell a report from a fact. This assembles one answer from the control
// plane's own records only: what ran, at which commit, with which numbers, and where the runs
// are. Its verdict is PROVEN only when the records show it, and every missing piece is named.
// It is read-only and never blocks work: the gate is the merge, not the question.
import { z } from "zod";
import type { AutopilotService } from "../../core/src/application.js";
import type { StateStore } from "../../core/src/ports.js";
import type { Artifact, Project, Task, TestReport } from "../../schemas/src/index.js";

export const changeProofInputSchema = { projectId: z.string().uuid(), taskId: z.string().uuid() };
export const changeProofToolDescription =
  "Read-only. The evidence for one task's change, from the control plane's own records only -- never from an agent's report: the commit and branch, tests executed (totals, failing tests by name, property-based counts and seeds), the independent review, the security scan, full HTTP E2E (verdict, commit, coverage of documented operations, scenarios, comparison with the reference) and the pull request, each with links to the runs, plus a verdict: PROVEN only when the records show every piece at the latest commit, otherwise NOT_PROVEN with each missing piece named. Quote its verdict, numbers and links when reporting work; a claim it does not show is not evidence.";

export interface ProofDependencies {
  store: StateStore;
  service: AutopilotService;
  readArtifact?: (projectId: string, artifactId: string) => Promise<Artifact>;
}

async function content(deps: ProofDependencies, artifact: Artifact | undefined): Promise<unknown> {
  if (!artifact) return undefined;
  if (artifact.storage && deps.readArtifact) return (await deps.readArtifact(artifact.projectId, artifact.id).catch(() => artifact)).content;
  return artifact.content;
}

const latest = (artifacts: Artifact[], kind: string, match: (value: Artifact) => boolean = () => true) =>
  [...artifacts].reverse().find((artifact) => artifact.kind === kind && artifact.status === "AVAILABLE" && match(artifact));

export async function changeProof(deps: ProofDependencies, project: Project, task: Task) {
  const [artifacts, runs, readiness, resources] = await Promise.all([
    deps.store.listArtifacts(project.id, task.id),
    deps.store.listRuns(project.id, task.id),
    deps.service.taskReadiness(project.id, task.id),
    deps.store.listResources(project.id),
  ]);
  const lastRun = [...runs].reverse().find((run) => run.commitSha);
  const commit = lastRun?.commitSha;
  const jobs = await deps.store.listExecutionJobs(project.id, task.id);
  const lastJob = [...jobs].reverse().find((job) => job.kind !== "HTTP_E2E");
  const repository = resources.find((resource) => resource.resourceId === lastJob?.resourceId)?.externalReference;

  const testReport = (await content(deps, latest(artifacts, "TEST_REPORT"))) as TestReport | undefined;
  const review = (await content(deps, latest(artifacts, "REVIEW_REPORT"))) as { result?: string; failures?: string[]; warnings?: string[] } | undefined;
  const security = (await content(deps, latest(artifacts, "SECURITY_REPORT"))) as { passed?: boolean } | undefined;
  const pullRequest = (await content(deps, latest(artifacts, "PULL_REQUEST_REPORT"))) as { pullRequest?: { number?: number; url?: string }; merged?: boolean } | undefined;
  const e2eArtifact = latest(artifacts, "VALIDATION_REPORT", (artifact) => (artifact.content as { suite?: string } | undefined)?.suite === "HTTP_E2E");
  const e2e = (await content(deps, e2eArtifact)) as
    | { verdict?: string; commitSha?: string; workflowRunUrl?: string; failure?: { class?: string; message?: string }; evidence?: { collection?: { summary?: { passedScenarios?: number; scenarios?: number; passedRequests?: number; requests?: number }; coverage?: { coveredOperations?: number; totalOperations?: number } }; parity?: { verdict?: string; differenceCount?: number; comparedSteps?: number } } }
    | undefined;
  const testJobUrl = [...jobs].reverse().find((job) => job.kind !== "HTTP_E2E" && job.workflowRunUrl)?.workflowRunUrl;

  const missing: string[] = [];
  if (!commit) missing.push("no published commit for this task");
  if (!testReport) missing.push("no test report");
  else if (!testReport.passed) missing.push(`tests failed${testReport.failedTests?.length ? `: ${testReport.failedTests.map((value) => value.test).join("; ")}` : ""}`);
  if (testReport?.propertyBased?.required && testReport.propertyBased.status !== "PASS") missing.push(`property-based layer is ${testReport.propertyBased.status}`);
  if (!review) missing.push("no independent review");
  else if (review.result === "FAIL") missing.push(`review failed: ${(review.failures ?? []).join("; ")}`);
  if (security && security.passed === false) missing.push("security scan failed");
  if (e2e && e2e.verdict !== "PROVEN") missing.push(`HTTP E2E is ${e2e.verdict}: ${e2e.failure?.class ?? ""} ${e2e.failure?.message ?? ""}`.trim());
  if (e2e && commit && e2e.commitSha !== commit) missing.push(`HTTP E2E ran at ${e2e.commitSha?.slice(0, 12)}, not at the latest commit ${commit.slice(0, 12)}`);
  for (const blocker of readiness.blockers) missing.push(`${blocker.code}: ${blocker.reason}`);
  const unique = [...new Set(missing)];
  const verdict = task.state === "READY" && unique.length === 0 ? ("PROVEN" as const) : ("NOT_PROVEN" as const);

  return {
    task: { key: task.externalKey, title: task.title, state: task.state },
    ...(repository ? { repository } : {}),
    ...(lastRun?.branch ? { branch: lastRun.branch } : {}),
    ...(commit ? { commit } : {}),
    tests: testReport
      ? {
          passed: testReport.passed,
          ...(testReport.testTotals ? { executed: testReport.testTotals } : {}),
          suites: testReport.suites.map((suite) => ({ type: suite.type, passed: suite.passed })),
          ...(testReport.failedTests?.length ? { failedTests: testReport.failedTests } : {}),
          ...(testReport.propertyBased ? { propertyBased: { status: testReport.propertyBased.status, properties: testReport.propertyBased.properties, generatedCases: testReport.propertyBased.generatedCases, replaySeeds: testReport.propertyBased.replaySeeds.slice(0, 5) } } : {}),
          finishedAt: testReport.finishedAt,
          ...(testJobUrl ? { runUrl: testJobUrl } : {}),
        }
      : null,
    review: review ? { result: review.result, failures: review.failures ?? [], warnings: (review.warnings ?? []).slice(0, 10) } : null,
    security: security ? { passed: security.passed !== false } : null,
    httpE2e: e2e
      ? {
          verdict: e2e.verdict,
          commit: e2e.commitSha,
          atLatestCommit: Boolean(commit) && e2e.commitSha === commit,
          ...(e2e.failure ? { failure: e2e.failure } : {}),
          ...(e2e.evidence?.collection?.coverage ? { coverage: { covered: e2e.evidence.collection.coverage.coveredOperations, total: e2e.evidence.collection.coverage.totalOperations } } : {}),
          ...(e2e.evidence?.collection?.summary ? { scenarios: { passed: e2e.evidence.collection.summary.passedScenarios, total: e2e.evidence.collection.summary.scenarios }, requests: { passed: e2e.evidence.collection.summary.passedRequests, total: e2e.evidence.collection.summary.requests } } : {}),
          ...(e2e.evidence?.parity ? { parity: { verdict: e2e.evidence.parity.verdict, differences: e2e.evidence.parity.differenceCount, comparedSteps: e2e.evidence.parity.comparedSteps } } : {}),
          ...(e2e.workflowRunUrl ? { runUrl: e2e.workflowRunUrl } : {}),
        }
      : null,
    pullRequest: pullRequest?.pullRequest ? { number: pullRequest.pullRequest.number, url: pullRequest.pullRequest.url, merged: Boolean(pullRequest.merged) } : null,
    verdict,
    missing: unique,
    howToRead: "This is the control plane's record, not an agent's report. Quote the verdict, the numbers and the run links; anything it does not show has not been proven.",
  };
}
