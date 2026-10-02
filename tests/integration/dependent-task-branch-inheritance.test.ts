import { describe, expect, it, vi } from 'vitest';
import { AsyncExecutionCoordinator } from '../../packages/core/src/async-execution.js';
import { deterministicTaskBranch } from '../../packages/core/src/branch.js';
import { testService } from '../helpers/service.js';

async function sandboxProject() {
  const { store, service } = testService();
  const project = await service.projectCreate({ name: 'Chain', slug: `chain-${crypto.randomUUID()}`, sourceType: 'LOCAL', environment: 'SANDBOX', autonomyMode: 'GUARDED' });
  const resource = await service.resourceRegister({ projectId: project.id, type: 'GITHUB_REPOSITORY', provider: 'github', externalReference: 'sandbox-owner/sandbox-repository', environment: 'SANDBOX', permissions: ['READ', 'WRITE'], secretRefs: [] });
  return { store, service, project, resource };
}

async function verifiedReadyTask(store: Awaited<ReturnType<typeof sandboxProject>>['store'], service: Awaited<ReturnType<typeof sandboxProject>>['service'], projectId: string, externalKey: string) {
  const task = await service.taskCreate({ projectId, externalKey, title: `Predecessor ${externalKey}`, description: 'd', requirements: ['r'], relationships: [] });
  const commitSha = crypto.randomUUID().replace(/-/g, '').padEnd(40, '0');
  const branch = `autopilot/${externalKey}-predecessor`;
  await store.updateTask({ ...task, state: 'READY' });
  await store.saveArtifact({ id: crypto.randomUUID(), projectId, taskId: task.id, kind: 'FINAL_CHANGE_MANIFEST', schemaVersion: '1', content: { verifiedCommitSha: commitSha }, contentHash: 'hash', status: 'AVAILABLE', createdAt: new Date().toISOString() } as never);
  await store.saveRun({ id: crypto.randomUUID(), projectId, taskId: task.id, operationId: `${externalKey}-run`, status: 'SUCCEEDED', commitSha, branch, platformVersion: '1', workflowVersion: '1', policyVersion: '1', startedAt: new Date().toISOString() } as never);
  return { task, commitSha, branch };
}

async function dependentTask(service: Awaited<ReturnType<typeof sandboxProject>>['service'], projectId: string, externalKey: string, dependsOnTaskIds: string[]) {
  const task = await service.taskCreate({ projectId, externalKey, title: 'Dependent', description: 'd', requirements: ['r'], relationships: dependsOnTaskIds.map(targetTaskId => ({ type: 'DEPENDS_ON' as const, targetTaskId })) });
  await service.taskAnalyze(projectId, task.id);
  await service.taskPlan(projectId, task.id);
  return task;
}

describe('dependent task branch inheritance', () => {
  it('inherits the verified predecessor branch and commit for a single DEPENDS_ON', async () => {
    const { store, service, project, resource } = await sandboxProject();
    const predecessor = await verifiedReadyTask(store, service, project.id, 'CORE-BE-01');
    const dependent = await dependentTask(service, project.id, 'CORE-BE-02', [predecessor.task.id]);
    const coordinator = new AsyncExecutionCoordinator(store, { dispatch: vi.fn(async () => ({ workflowRunId: 'wf-1' })) });
    const { job } = await coordinator.enqueueImplementation({ projectId: project.id, taskId: dependent.id, operationId: 'chain-op-1', changes: [{ path: 'src/b.js', content: 'export const b = true;\n' }] }, resource.resourceId);
    expect(job.baseBranch).toBe(predecessor.branch);
    expect(job.baseCommitSha).toBe(predecessor.commitSha);
  });

  it('does not set a base branch when there are no dependencies', async () => {
    const { store, service, project, resource } = await sandboxProject();
    const task = await service.taskCreate({ projectId: project.id, externalKey: 'SOLO-1', title: 'Solo', description: 'd', requirements: ['r'], relationships: [] });
    await service.taskAnalyze(project.id, task.id);
    await service.taskPlan(project.id, task.id);
    const coordinator = new AsyncExecutionCoordinator(store, { dispatch: vi.fn(async () => ({})) });
    const { job } = await coordinator.enqueueImplementation({ projectId: project.id, taskId: task.id, operationId: 'solo-op-1', changes: [{ path: 'src/a.js', content: 'export const a = true;\n' }] }, resource.resourceId);
    expect(job.baseBranch).toBeUndefined();
    expect(job.baseCommitSha).toBeUndefined();
  });

  it('fails closed and BLOCKs the task when a READY predecessor has no resolvable evidence', async () => {
    const { store, service, project, resource } = await sandboxProject();
    const unevidenced = await service.taskCreate({ projectId: project.id, externalKey: 'CORE-BE-03', title: 'No evidence', description: 'd', requirements: ['r'], relationships: [] });
    await store.updateTask({ ...unevidenced, state: 'READY' });
    const dependent = await dependentTask(service, project.id, 'CORE-BE-04', [unevidenced.id]);
    const coordinator = new AsyncExecutionCoordinator(store, { dispatch: vi.fn(async () => ({})) });
    await expect(coordinator.enqueueImplementation({ projectId: project.id, taskId: dependent.id, operationId: 'chain-op-2', changes: [{ path: 'src/c.js', content: 'export const c = true;\n' }] }, resource.resourceId)).rejects.toMatchObject({ code: 'DEPENDENCY_BLOCKED' });
    expect((await service.taskGet(project.id, dependent.id)).state).toBe('BLOCKED');
  });

  // Branch continuity is a property of one ref. A REBASE job publishes onto a throwaway
  // `...-rebase-<base>` branch, so inheriting "the last job that has any commitSha" handed the
  // next job a commit from a lineage its own branch never contained -- which the runner can only
  // read as divergence, permanently, because every later job re-inherited the same value.
  it('inherits the continuity commit only from a job on the same branch', async () => {
    const { store, service, project, resource } = await sandboxProject();
    const task = await service.taskCreate({ projectId: project.id, externalKey: 'TRANSFER-1', title: 'Runtime completeness', description: 'd', requirements: ['r'], relationships: [] });
    await service.taskAnalyze(project.id, task.id);
    await service.taskPlan(project.id, task.id);
    const taskBranch = deterministicTaskBranch(task);
    const publishedOnTaskBranch = 'a'.repeat(40);
    const publishedOnRebaseBranch = 'b'.repeat(40);
    const base = { projectId: project.id, taskId: task.id, resourceId: resource.resourceId, payload: {}, attempt: 0, queuedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await store.createExecutionJob({ ...base, id: crypto.randomUUID(), operationId: 'transfer-implementation', kind: 'IMPLEMENTATION', status: 'SUCCEEDED', branch: taskBranch, commitSha: publishedOnTaskBranch } as never);
    await store.createExecutionJob({ ...base, id: crypto.randomUUID(), operationId: 'transfer-rebase-run', kind: 'REBASE', status: 'FAILED', branch: `${taskBranch}-rebase-${'c'.repeat(12)}`, commitSha: publishedOnRebaseBranch } as never);

    const coordinator = new AsyncExecutionCoordinator(store, { dispatch: vi.fn(async () => ({})) });
    const { job } = await coordinator.enqueueImplementation({ projectId: project.id, taskId: task.id, operationId: 'transfer-op-next', changes: [{ path: 'src/e.js', content: 'export const e = true;\n' }] }, resource.resourceId);
    expect(job.branch).toBe(taskBranch);
    expect(job.commitSha).toBe(publishedOnTaskBranch);
  });

  it('carries no continuity commit when the only published one belongs to another branch', async () => {
    const { store, service, project, resource } = await sandboxProject();
    const task = await service.taskCreate({ projectId: project.id, externalKey: 'TRANSFER-2', title: 'Rebase only', description: 'd', requirements: ['r'], relationships: [] });
    await service.taskAnalyze(project.id, task.id);
    await service.taskPlan(project.id, task.id);
    await store.createExecutionJob({ projectId: project.id, taskId: task.id, resourceId: resource.resourceId, payload: {}, attempt: 0, queuedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), id: crypto.randomUUID(), operationId: 'rebase-only-run', kind: 'REBASE', status: 'FAILED', branch: `${deterministicTaskBranch(task)}-rebase-${'c'.repeat(12)}`, commitSha: 'd'.repeat(40) } as never);

    const coordinator = new AsyncExecutionCoordinator(store, { dispatch: vi.fn(async () => ({})) });
    const { job } = await coordinator.enqueueImplementation({ projectId: project.id, taskId: task.id, operationId: 'rebase-only-next', changes: [{ path: 'src/f.js', content: 'export const f = true;\n' }] }, resource.resourceId);
    expect(job.commitSha).toBeUndefined();
  });

  it('fails closed and BLOCKs the task when two predecessors resolve to conflicting bases', async () => {
    const { store, service, project, resource } = await sandboxProject();
    const first = await verifiedReadyTask(store, service, project.id, 'CORE-BE-05');
    const second = await verifiedReadyTask(store, service, project.id, 'CORE-BE-06');
    const dependent = await dependentTask(service, project.id, 'CORE-BE-07', [first.task.id, second.task.id]);
    const coordinator = new AsyncExecutionCoordinator(store, { dispatch: vi.fn(async () => ({})) });
    await expect(coordinator.enqueueImplementation({ projectId: project.id, taskId: dependent.id, operationId: 'chain-op-3', changes: [{ path: 'src/d.js', content: 'export const d = true;\n' }] }, resource.resourceId)).rejects.toMatchObject({ code: 'DEPENDENCY_BLOCKED' });
    expect((await service.taskGet(project.id, dependent.id)).state).toBe('BLOCKED');
  });
});
