import 'dotenv/config';
import { LiveGitHubAdapter } from '../packages/adapters/github/src/index.js';
import { AuditLog } from '../packages/audit/src/index.js';
import { systemClock, uuidGenerator } from '../packages/core/src/ports.js';
import { CommandPolicy, CommandRunner } from '../packages/execution-engine/src/index.js';
import { PostgrestStateStore } from '../packages/project-registry/src/index.js';
import type { Resource } from '../packages/schemas/src/index.js';

// One-time registration of momaibackend-ctrl/backend-autopilot itself as a WRITE-able sandbox
// resource, through the same verified-provider identity/ownership/ADMIN checks already used for
// momnabackend (LiveGitHubAdapter.registerExistingSandboxRepository), so the Superadmin MCP (and
// so ChatGPT, remotely) can target Backend Autopilot's own repository for self-repair
// (task_execute/job_create) without going through the local stdio MCP.
//
// Uses the same PostgREST-backed StateStore as the deployed Edge Function -- this machine only
// holds Supabase REST credentials for the control plane, not a raw Postgres connection string --
// and calls LiveGitHubAdapter directly rather than SandboxBootstrapService.registerGithubRepository,
// because that method resolves its working directory from the registered project's
// `workspacePath`, which is intentionally blank for this remotely-operated project.
const projectId = process.env['AUTOPILOT_REGISTER_PROJECT_ID'] ?? 'ac6d68be-272c-4bca-aab1-cd1a442cf960';
const githubAccountResourceId = process.env['AUTOPILOT_REGISTER_GITHUB_ACCOUNT_RESOURCE_ID'] ?? '778306fd-8f26-48dc-afe0-5ce5bbf46096';
const repository = 'momaibackend-ctrl/backend-autopilot';

// `gh` calls made by LiveGitHubAdapter inherit process.env; force them to act as the registered
// sandbox identity regardless of which account happens to be active in the local `gh` keyring.
process.env['GH_TOKEN'] = required('AUTOPILOT_GITHUB_TOKEN');

const store = new PostgrestStateStore(required('AUTOPILOT_CONTROL_SUPABASE_URL'), required('AUTOPILOT_CONTROL_SUPABASE_SERVICE_ROLE_KEY'));
const commands = new CommandRunner(new CommandPolicy(), systemClock);
const github = new LiveGitHubAdapter(commands);
const audit = new AuditLog(store, uuidGenerator, systemClock);

const existing = await store.findResource(projectId, repository);
if (existing) {
  console.log(JSON.stringify({ level: 'info', event: 'resource.already_registered', resourceId: existing.resourceId, permissions: existing.permissions }));
} else {
  const account = await store.getResource(githubAccountResourceId);
  if (!account || account.projectId !== projectId) throw new Error('Registered GitHub sandbox account resource not found');
  const metadata = await github.registerExistingSandboxRepository(account, { workspace: process.cwd(), repository, correlationId: projectId });
  const resource: Resource = { type: 'GITHUB_REPOSITORY', provider: 'github', externalReference: metadata.nameWithOwner, projectId, environment: 'SANDBOX', permissions: ['READ', 'WRITE', 'ADMIN'], status: 'ACTIVE', secretRefs: [], resourceId: uuidGenerator.next(), createdAt: systemClock.now() };
  await store.createResource(resource);
  await audit.record({ actor: 'register-self-resource-script', action: 'bootstrap.github.repository_registered', projectId, resourceId: resource.resourceId, input: { repository }, result: { success: true, metadata }, reason: 'Human explicitly authorized allowlisting momaibackend-ctrl/backend-autopilot itself so the Superadmin MCP can target it for self-repair', correlationId: projectId });
  console.log(JSON.stringify({ level: 'info', event: 'resource.registered', resourceId: resource.resourceId, permissions: resource.permissions, metadata }));
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
