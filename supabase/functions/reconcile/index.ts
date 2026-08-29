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
  const candidates = (await Promise.all(projects.map(project => runtime.store.listExecutionJobs(project.id)))).flat().filter(job => activeJobStatuses.includes(job.status));
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
