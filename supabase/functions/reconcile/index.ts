import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { systemClock, uuidGenerator } from '../../../packages/core/src/ports.ts';
import { recoverStalledWork } from '../../../packages/core/src/stall-recovery.ts';
import type { ExecutionJob } from '../../../packages/schemas/src/index.ts';
import { createEdgeRuntime, json, required } from '../_shared/edge-runtime.ts';

// The scheduled reconciler. Every rule lives in packages/core/src/stall-recovery.ts (ADR 028):
// stalled work is resumed as a new attempt instead of parking its task in BLOCKED.
//
// Cost matters because nobody watches this caller: it runs every fifteen minutes. The store reads
// only active job statuses, and full job documents only for those few (see ExecutionJobSummary for
// the egress incident that shaped this). Making each run cheap is what keeps the quota; the cadence
// stays, because stuck-job recovery is exactly what it exists for.
Deno.serve(async request => {
  if (request.headers.get('authorization') !== `Bearer ${required('AUTOPILOT_RECONCILE_TOKEN')}`) return json({ error: 'unauthorized' }, 401);
  const runtime = createEdgeRuntime(), token = required('AUTOPILOT_GITHUB_DISPATCH_TOKEN'), repository = required('AUTOPILOT_CONTROL_REPOSITORY');
  const workflowRun = async (job: ExecutionJob) => {
    const response = await fetch(`https://api.github.com/repos/${repository}/actions/runs/${job.workflowRunId}`, { headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'user-agent': 'backend-autopilot/0.5', 'x-github-api-version': '2022-11-28' } });
    // A run id GitHub will not answer for is not proof of anything; elapsed-time rules decide.
    if (!response.ok) return 'UNAVAILABLE' as const;
    const run = await response.json() as { status: string; conclusion?: string; html_url?: string };
    return { status: run.status, conclusion: run.conclusion, ...(run.html_url ? { htmlUrl: run.html_url } : {}) };
  };
  const results = await recoverStalledWork({ store: runtime.store, clock: systemClock, ids: uuidGenerator, dispatchers: { execution: runtime.dispatcher, httpE2e: runtime.httpE2eDispatcher }, workflowRun });
  return json({ checked: results.length, results });
});
