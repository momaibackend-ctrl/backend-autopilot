/**
 * Which tasks are waiting on their caller rather than on the platform.
 *
 * A task whose execution job has finished unsuccessfully does not stop and does not fail: the
 * lifecycle returns it to IMPLEMENTING for a repair attempt, and there it stays until someone sends
 * one. That is the design, but it made such a task invisible. It is not in `activeJobs` -- its job
 * is finished -- and not in `failedGates`, which only covers tasks whose own state is FAILED or
 * BLOCKED. So CORE-BE-25 sat in IMPLEMENTING for eight hours with a FAILED job and appeared in no
 * overview at all, and the only way to discover it was to already know its id.
 *
 * This is deliberately computed from tasks and job summaries the caller has already loaded: no
 * extra query, so an overview can always afford to answer "what is waiting on me". The precise next
 * call comes from task_status.readiness.nextAction; this only says which tasks to ask about.
 */

/** Nothing further happens to a task in one of these states unless someone asks for it. */
const terminalTaskStates = new Set(['READY', 'FAILED']);
/** A job in one of these is still the platform's turn; anything else has handed the task back. */
const liveJobStatuses = new Set(['QUEUED', 'DISPATCHING', 'DISPATCHED', 'CLAIMED', 'RUNNING']);

export interface AwaitingTask {
  taskId: string;
  externalKey: string;
  title: string;
  state: string;
  /** How the last execution ended, or NONE when the task has never been executed. */
  lastJobStatus: string;
  repairAttempts: number;
  updatedAt: string;
  /** Whole hours since the task last changed, so a long-forgotten one is obvious at a glance. */
  idleHours: number;
  why: string;
}

export function awaitingCaller(input: {
  tasks: Array<{ id: string; externalKey: string; title: string; state: string; repairAttempts?: number; updatedAt: string }>;
  jobs: Array<{ taskId: string; status: string; updatedAt: string }>;
  now: string;
}): AwaitingTask[] {
  const latestJob = new Map<string, { status: string; updatedAt: string }>();
  for (const job of input.jobs) {
    const seen = latestJob.get(job.taskId);
    if (!seen || seen.updatedAt < job.updatedAt) latestJob.set(job.taskId, { status: job.status, updatedAt: job.updatedAt });
  }
  const nowMs = Date.parse(input.now);
  return input.tasks
    .filter((task) => !terminalTaskStates.has(task.state))
    .filter((task) => !input.jobs.some((job) => job.taskId === task.id && liveJobStatuses.has(job.status)))
    .map((task) => {
      const last = latestJob.get(task.id);
      const lastJobStatus = last?.status ?? 'NONE';
      return {
        taskId: task.id,
        externalKey: task.externalKey,
        title: task.title,
        state: task.state,
        lastJobStatus,
        repairAttempts: task.repairAttempts ?? 0,
        updatedAt: task.updatedAt,
        idleHours: Math.max(0, Math.floor((nowMs - Date.parse(task.updatedAt)) / 3_600_000)),
        why: reasonFor(task.state, lastJobStatus),
      };
    })
    .sort((a, b) => b.idleHours - a.idleHours);
}

function reasonFor(state: string, lastJobStatus: string): string {
  if (state === 'BLOCKED') return 'BLOCKED by an unmet dependency or a policy gate. Read task_status.readiness.blockers for which one.';
  if (lastJobStatus === 'NONE') return `In ${state} and never executed. It is waiting for its first execution.`;
  if (['FAILED', 'TIMED_OUT'].includes(lastJobStatus))
    return `Its last execution ended ${lastJobStatus} and the lifecycle returned it to ${state} for a repair attempt. Read the failing log with artifact_read(tail:true), then send the repair through task_status.readiness.nextAction.`;
  if (lastJobStatus === 'CANCELLED') return `Its last execution was CANCELLED, so ${state} is where it was left. Re-execute it or close it out.`;
  return `In ${state} with its last execution ${lastJobStatus}. Nothing is running, so it is waiting on the next call from you.`;
}
