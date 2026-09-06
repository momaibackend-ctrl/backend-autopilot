import 'dotenv/config';
import { LiveGitHubAdapter } from '../packages/adapters/github/src/index.js';
import { AuditLog } from '../packages/audit/src/index.js';
import { systemClock, uuidGenerator } from '../packages/core/src/ports.js';
import { CommandPolicy, CommandRunner } from '../packages/execution-engine/src/index.js';
import { PostgrestStateStore } from '../packages/project-registry/src/index.js';
import type { Resource } from '../packages/schemas/src/index.js';

// One-time registration of an organization-owned repository the sandbox identity does not own but
// has been explicitly handed ADMIN on, so the Superadmin MCP (and so ChatGPT, remotely) can target
// it. This is the organization counterpart of register-self-resource.ts and deliberately reuses the
// same verified-provider path: LiveGitHubAdapter.registerExistingSandboxRepository still proves,
// against GitHub itself, that the repository's owner matches the account being registered and that
// the active identity holds ADMIN on that exact repository. What changed is only that ADMIN, rather
// than owning the namespace, is now accepted as that proof -- an organization login can never equal
// `gh api user .login`, so no organization repository could otherwise be allowlisted at all.
//
// The GITHUB_ACCOUNT row is therefore written *after* the repository check passes, never before: the
// namespace is registered on the strength of a repository the identity demonstrably administers,
// not on an unverified assertion that the organization is ours to use.
//
// Uses the same PostgREST-backed StateStore as the deployed Edge Function -- this machine only holds
// Supabase REST credentials for the control plane, not a raw Postgres connection string -- and calls
// LiveGitHubAdapter directly rather than SandboxBootstrapService.registerGithubRepository, because
// that method resolves its working directory from the registered project's `workspacePath`, which is
// intentionally blank for a remotely-operated project.
const projectId = required('AUTOPILOT_REGISTER_PROJECT_ID');
const repository = required('AUTOPILOT_REGISTER_REPOSITORY');
const [organization] = repository.split('/');
if (!organization) throw new Error('AUTOPILOT_REGISTER_REPOSITORY must use owner/name format');

// `gh` calls made by LiveGitHubAdapter inherit process.env; force them to act as the registered
// sandbox identity regardless of which account happens to be active in the local `gh` keyring.
process.env['GH_TOKEN'] = required('AUTOPILOT_GITHUB_TOKEN');

const store = new PostgrestStateStore(required('AUTOPILOT_CONTROL_SUPABASE_URL'), required('AUTOPILOT_CONTROL_SUPABASE_SERVICE_ROLE_KEY'));
const commands = new CommandRunner(new CommandPolicy(), systemClock);
const github = new LiveGitHubAdapter(commands);
const audit = new AuditLog(store, uuidGenerator, systemClock);

const existingRepository = await store.findResource(projectId, repository);
if (existingRepository) {
  console.log(JSON.stringify({ level: 'info', event: 'resource.already_registered', resourceId: existingRepository.resourceId, permissions: existingRepository.permissions }));
} else {
  const existingAccount = await store.findResource(projectId, organization);
  const account: Resource = existingAccount ?? { type: 'GITHUB_ACCOUNT', provider: 'github', externalReference: organization, projectId, environment: 'SANDBOX', permissions: ['READ', 'WRITE', 'ADMIN'], status: 'ACTIVE', secretRefs: [], resourceId: uuidGenerator.next(), createdAt: systemClock.now() };
  const metadata = await github.registerExistingSandboxRepository(account, { workspace: process.cwd(), repository, correlationId: projectId });
  if (!existingAccount) {
    await store.createResource(account);
    await audit.record({ actor: 'register-organization-repository-script', action: 'bootstrap.github.identity_registered', projectId, resourceId: account.resourceId, input: { organization }, result: { success: true }, reason: `Human explicitly authorized ${organization} as a GitHub namespace after the sandbox identity proved ADMIN on ${repository}`, correlationId: projectId });
  }
  const resource: Resource = { type: 'GITHUB_REPOSITORY', provider: 'github', externalReference: metadata.nameWithOwner, projectId, environment: 'SANDBOX', permissions: ['READ', 'WRITE', 'ADMIN'], status: 'ACTIVE', secretRefs: [], resourceId: uuidGenerator.next(), createdAt: systemClock.now() };
  await store.createResource(resource);
  await audit.record({ actor: 'register-organization-repository-script', action: 'bootstrap.github.repository_registered', projectId, resourceId: resource.resourceId, input: { repository }, result: { success: true, metadata }, reason: `Human explicitly allowlisted the organization-owned repository ${repository}, which the sandbox identity administers as an explicitly invited collaborator`, correlationId: projectId });
  console.log(JSON.stringify({ level: 'info', event: 'resource.registered', accountResourceId: account.resourceId, resourceId: resource.resourceId, permissions: resource.permissions, metadata }));
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
