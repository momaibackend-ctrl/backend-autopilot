import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { systemClock, uuidGenerator } from '../../../packages/core/src/ports.ts';
import { applyHeartbeatWatchdog } from '../../../packages/core/src/reconcile.ts';
import { WorkflowEngine } from '../../../packages/workflow-engine/src/index.ts';
import type { ExecutionJob } from '../../../packages/schemas/src/index.ts';
import { createEdgeRuntime, json, required } from '../_shared/edge-runtime.ts';

Deno.serve(async request => {
  if (request.headers.get('authorization') !== `Bearer ${required('AUTOPILOT_RECONCILE_TOKEN')}`) return json({ error: 'unauthorized' }, 401);
  const runtime = createEdgeRuntime(), token = required('AUTOPILOT_GITHUB_DISPATCH_TOKEN'), repository = required('AUTOPILOT_CONTROL_REPOSITORY');
  const projects = await runtime.store.listProjects();
  const candidates = (await Promise.all(projects.map(project => runtime.store.listExecutionJobs(project.id)))).flat().filter(job => ['DISPATCHED', 'CLAIMED', 'RUNNING'].includes(job.status) && job.workflowRunId);
  const results: Array<{ jobId: string; status: string }> = [];
  for (const job of candidates) {
    const response = await fetch(`https://api.github.com/repos/${repository}/actions/runs/${job.workflowRunId}`, { headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'user-agent': 'backend-autopilot/0.5', 'x-github-api-version': '2022-11-28' } });
    if (!response.ok) { const watchdog = await applyHeartbeatWatchdog(runtime.store, systemClock, uuidGenerator, job, 'QUERY_FAILED'); results.push({ jobId: job.id, status: watchdog.action === 'presumed_dead' ? 'UNVERIFIED' : 'QUERY_FAILED' }); continue; }
    const run = await response.json() as { status: string; conclusion?: string; html_url?: string };
    if (run.status !== 'completed') { const watchdog = await applyHeartbeatWatchdog(runtime.store, systemClock, uuidGenerator, job, run.status); results.push({ jobId: job.id, status: watchdog.action === 'presumed_dead' ? 'UNVERIFIED' : run.status }); continue; }
    // GitHub itself confirms the run ended without ever reaching a durable completion callback --
    // this is a stronger, immediate signal than heartbeat staleness, so it bypasses the watchdog
    // tiers entirely and force-terminates right away, exactly as before this change.
    const status = conclusion(job, run.conclusion);
    const updated: ExecutionJob = { ...job, status, workflowRunUrl: run.html_url ?? job.workflowRunUrl, leaseExpiresAt: systemClock.now(), finishedAt: systemClock.now(), updatedAt: systemClock.now(), error: { code: `GITHUB_ACTIONS_${(run.conclusion ?? 'UNKNOWN').toUpperCase()}`, message: 'Execution ended before its durable completion callback' } };
    await runtime.store.updateExecutionJob(updated);
    if (job.runId) { const storedRun = await runtime.store.getRun(job.projectId, job.runId); if (storedRun?.status === 'RUNNING') await runtime.store.updateRun({ ...storedRun, status: status === 'BLOCKED' ? 'BLOCKED' : 'FAILED', finishedAt: systemClock.now() }); }
    const task = await runtime.store.getTask(job.projectId, job.taskId);
    if (task && task.state === 'IMPLEMENTING') await new WorkflowEngine(runtime.store, uuidGenerator, systemClock).transition(task, 'BLOCKED', 'GitHub Actions ended without durable completion callback', 'serverless-reconciler');
    results.push({ jobId: job.id, status });
  }
  return json({ checked: candidates.length, results });
});

function conclusion(_job: ExecutionJob, value?: string): ExecutionJob['status'] { if (value === 'cancelled') return 'CANCELLED'; if (value === 'timed_out') return 'TIMED_OUT'; return 'FAILED'; }
