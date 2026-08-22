import { describe, expect, it, vi } from 'vitest';
import { AsyncExecutionCoordinator } from '../../packages/core/src/async-execution.js';
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
