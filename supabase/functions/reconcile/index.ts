import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { systemClock, uuidGenerator } from '../../../packages/core/src/ports.ts';
import { activeJobStatuses, classifyExecutionJob, type WorkflowRunView } from '../../../packages/core/src/execution-reconciliation.ts';
import { WorkflowEngine } from '../../../packages/workflow-engine/src/index.ts';
import type { ExecutionJob } from '../../../packages/schemas/src/index.ts';
import { createEdgeRuntime, json, required } from '../_shared/edge-runtime.ts';

// Every active job is a candidate now, not only the few that happen to carry a workflow run id.
// A job GitHub never started has no run id by construction, and that was precisely the case this
// reconciler could not see -- see packages/core/src/execution-reconciliation.ts.
Deno.serve(async request => {
  if (request.headers.get('authorization') !== `Bearer ${required('AUTOPILOT_RECONCILE_TOKEN')}`) return json({ error: 'unauthorized' }, 401);
  const runtime = createEdgeRuntime(), token = required('AUTOPILOT_GITHUB_DISPATCH_TOKEN'), repository = required('AUTOPILOT_CONTROL_REPOSITORY');
  const projects = await runtime.store.listProjects();
  // Statuses first; payloads only where they are genuinely needed.
  //
  // This is the one caller in the system that runs unattended on a timer, so an unbounded read here
  // is not a slow page someone notices -- it is quota spent every fifteen minutes with nobody
  // watching. `payload`, `result` and `error` average 29 kB per row and reach 202 kB (see
  // ExecutionJobSummary), so listing full jobs to read their statuses moved about 5 MB per project
  // per run. At 96 runs a day that exhausted the project's entire monthly egress allowance in
  // roughly ten days and left every service on it restricted with HTTP 402.
  //
  // Every other caller had already been migrated to the summary read; this one was missed precisely
  // because it is the one nobody watches. Active jobs are normally zero, so the full envelope --
  // which classifyExecutionJob and the write-backs below do need -- is now fetched for those few
  // and for nothing else.
  //
  // The status filter is applied in the store, not here, so the poll reads only what is in flight.
  // Filtering after the read would still have made the cost proportional to everything that ever
  // ran -- which is the shape that failed -- and the table only grows.
  //
  // The 15-minute cadence is deliberately unchanged. Making each run cheap is what fixes the quota;
  // slowing the schedule down would instead delay the stuck-job recovery this exists to perform.
  const active = (await Promise.all(projects.map(project => runtime.store.listExecutionJobSummaries(project.id, undefined, activeJobStatuses)))).flat();
  const candidates = (await Promise.all(active.map(summary => runtime.store.getExecutionJob(summary.projectId, summary.id)))).filter((job): job is ExecutionJob => Boolean(job));
  const results = [];
  for (const job of candidates) {
    let workflowRun: WorkflowRunView | undefined;
    let queryFailed = false;
    if (job.workflowRunId) {
      const response = await fetch(`https://api.github.com/repos/${repository}/actions/runs/${job.workflowRunId}`, { headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'user-agent': 'backend-autopilot/0.5', 'x-github-api-version': '2022-11-28' } });
      if (response.ok) {
        const run = await response.json() as { status: string; conclusion?: string; html_url?: string };
        workflowRun = { status: run.status, conclusion: run.conclusion };
        if (run.html_url && run.html_url !== job.workflowRunUrl) await runtime.store.updateExecutionJob({ ...job, workflowRunUrl: run.html_url, updatedAt: systemClock.now() });
      } else {
        // A run id that GitHub will not answer for is not proof of anything, so the job falls back
        // to the elapsed-time rules rather than being left untouched forever.
        queryFailed = true;
      }
    }
    const decision = classifyExecutionJob({ job, now: systemClock.now(), workflowRun });
    if (decision.action !== 'TERMINALIZE') {
      results.push({ jobId: job.id, action: decision.action, reason: decision.reason, ...(queryFailed ? { workflowQuery: 'FAILED' } : {}) });
      continue;
    }
    const now = systemClock.now();
    const updated: ExecutionJob = { ...job, status: decision.status, leaseExpiresAt: now, finishedAt: now, updatedAt: now, error: { code: decision.code, message: decision.reason, remediation: decision.remediation } };
    await runtime.store.updateExecutionJob(updated);
    if (job.runId) {
      const storedRun = await runtime.store.getRun(job.projectId, job.runId);
      if (storedRun?.status === 'RUNNING') await runtime.store.updateRun({ ...storedRun, status: decision.status === 'BLOCKED' ? 'BLOCKED' : 'FAILED', finishedAt: now });
    }
    const task = await runtime.store.getTask(job.projectId, job.taskId);
    if (task && task.state === 'IMPLEMENTING') await new WorkflowEngine(runtime.store, uuidGenerator, systemClock).transition(task, 'BLOCKED', `${decision.code}: ${decision.reason}`, 'serverless-reconciler');
    results.push({ jobId: job.id, action: 'TERMINALIZE', status: decision.status, code: decision.code, reason: decision.reason });
  }
  return json({ checked: candidates.length, results });
});
