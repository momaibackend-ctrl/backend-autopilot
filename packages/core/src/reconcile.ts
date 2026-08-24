import type { ExecutionCheckpoint, ExecutionJob } from '../../schemas/src/index.js';
import type { Clock, IdGenerator, StateStore } from './ports.js';

// A job's own heartbeat is silent proof of nothing on its own -- a slow DB write, a cron tick
// delayed under load, or a momentary network blip can all produce a couple of missed beats on a
// perfectly healthy job. So staleness is handled in two tiers: SUSPECTED just records evidence
// and leaves the job RUNNING (self-heals the moment a heartbeat lands again); only HARD_CEILING
// of continuous silence -- 30x the 30s heartbeat interval -- moves the job to UNVERIFIED.
export const HEARTBEAT_SUSPECTED_MS = 2 * 60_000;
export const HEARTBEAT_HARD_CEILING_MS = 15 * 60_000;

export type HeartbeatDecision =
  | { action: 'none' }
  | { action: 'record'; step: 'WATCHDOG_HEARTBEAT_RECOVERED' | 'WATCHDOG_STALE_SUSPECTED'; evidence: Record<string, unknown> }
  | { action: 'presumed_dead'; evidence: Record<string, unknown> };

// Pure decision: no I/O, so every branch (healthy, newly suspected, still suspected, recovered,
// presumed dead) is a plain input/output unit test with no store or fetch to fake.
export function evaluateHeartbeat(input: { job: ExecutionJob; now: string; lastWatchdogStep?: string | undefined; lastKnownGithubStatus: string }): HeartbeatDecision {
  if (input.job.status !== 'RUNNING') return { action: 'none' };
  const lastSignal = input.job.heartbeatAt ?? input.job.updatedAt;
  const ageMs = new Date(input.now).getTime() - new Date(lastSignal).getTime();
  const evidence = { heartbeatAgeMs: ageMs, lastHeartbeatAt: input.job.heartbeatAt ?? null, lastKnownGithubStatus: input.lastKnownGithubStatus, observedAt: input.now };
  if (ageMs < HEARTBEAT_SUSPECTED_MS) {
    if (input.lastWatchdogStep === 'WATCHDOG_STALE_SUSPECTED') return { action: 'record', step: 'WATCHDOG_HEARTBEAT_RECOVERED', evidence };
    return { action: 'none' };
  }
  if (ageMs < HEARTBEAT_HARD_CEILING_MS) {
    if (input.lastWatchdogStep === 'WATCHDOG_STALE_SUSPECTED') return { action: 'none' };
    return { action: 'record', step: 'WATCHDOG_STALE_SUSPECTED', evidence };
  }
  return { action: 'presumed_dead', evidence: { ...evidence, workflowRunUrl: input.job.workflowRunUrl ?? null } };
}

// Only RUNNING jobs carry a live heartbeat -- QUEUED/DISPATCHED/CLAIMED staleness is already
// covered by lease expiry in claim_execution_job. This never touches task.state: unlike GitHub
// itself confirming a run ended, presumed-dead is an inference from silence, not a confirmation,
// and stacking one automatic judgment call on another is deliberately avoided.
export async function applyHeartbeatWatchdog(store: StateStore, clock: Clock, ids: IdGenerator, job: ExecutionJob, lastKnownGithubStatus: string): Promise<{ jobId: string; action: HeartbeatDecision['action'] }> {
  if (job.status !== 'RUNNING') return { jobId: job.id, action: 'none' };
  const now = clock.now();
  const existing = await store.listCheckpoints(job.projectId, job.id);
  const lastWatchdog = [...existing].reverse().find(c => c.step.startsWith('WATCHDOG_'));
  const decision = evaluateHeartbeat({ job, now, lastWatchdogStep: lastWatchdog?.step, lastKnownGithubStatus });
  if (decision.action === 'none') return { jobId: job.id, action: 'none' };
  const nextSeq = existing.reduce((max, c) => Math.max(max, c.seq), -1) + 1;
  const record = (step: ExecutionCheckpoint['step'], data: unknown) => store.saveCheckpoint({ id: ids.next(), jobId: job.id, projectId: job.projectId, taskId: job.taskId, seq: nextSeq, step, data, createdAt: now });

  if (decision.action === 'record') { await record(decision.step, decision.evidence); return { jobId: job.id, action: 'record' }; }

  // Re-confirm right before the terminal write: makes a second concurrent/duplicate tick a no-op
  // instead of a double transition, without relying solely on the next tick's candidate filter.
  const fresh = await store.getExecutionJob(job.projectId, job.id);
  if (!fresh || fresh.status !== 'RUNNING') return { jobId: job.id, action: 'none' };
  await record('WATCHDOG_PRESUMED_DEAD', decision.evidence);
  const ageMinutes = Math.round((decision.evidence['heartbeatAgeMs'] as number) / 60_000);
  await store.updateExecutionJob({ ...fresh, status: 'UNVERIFIED', leaseExpiresAt: now, finishedAt: now, updatedAt: now, error: { code: 'HEARTBEAT_PRESUMED_DEAD', message: `No heartbeat for ${ageMinutes} minutes and GitHub Actions has not confirmed the run ended` } });
  if (fresh.runId) { const run = await store.getRun(fresh.projectId, fresh.runId); if (run?.status === 'RUNNING') await store.updateRun({ ...run, status: 'UNVERIFIED', finishedAt: now }); }
  return { jobId: job.id, action: 'presumed_dead' };
}
