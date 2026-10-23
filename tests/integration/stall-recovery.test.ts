import { describe, expect, it } from "vitest";
import { RESUME_BACKOFF_CEILING_MINUTES, recoverStalledWork, resumeDelayMinutes, type StallRecoveryDependencies } from "../../packages/core/src/stall-recovery.js";
import { uuidGenerator } from "../../packages/core/src/ports.js";
import { MemoryStateStore } from "../../packages/project-registry/src/memory-store.js";
import type { ExecutionJob, Project, Run, Task } from "../../packages/schemas/src/index.js";

const start = Date.parse("2026-10-23T12:00:00.000Z");
const minutes = (value: number) => new Date(start + value * 60_000).toISOString();

async function world(kind: ExecutionJob["kind"] = "IMPLEMENTATION") {
  const store = new MemoryStateStore();
  let now = minutes(0);
  const clock = { now: () => now };
  const project: Project = { id: crypto.randomUUID(), name: "P", slug: `p-${crypto.randomUUID()}`, sourceType: "MCP", environment: "SANDBOX", autonomyMode: "AUTONOMOUS_STAGING", status: "ACTIVE", workspacePath: "", createdAt: now, updatedAt: now };
  await store.createProject(project);
  const task: Task = { id: crypto.randomUUID(), projectId: project.id, externalKey: "T-1", title: "t", description: "d", requirements: ["r"], state: "IMPLEMENTING", relationships: [], repairAttempts: 0, createdAt: now, updatedAt: now };
  await store.createTask(task);
  const run: Run = { id: crypto.randomUUID(), projectId: project.id, taskId: task.id, operationId: "op-original-1", status: "RUNNING", platformVersion: "1", workflowVersion: "1", policyVersion: "1", startedAt: now } as Run;
  await store.saveRun(run);
  const job: ExecutionJob = { id: crypto.randomUUID(), projectId: project.id, taskId: task.id, resourceId: crypto.randomUUID(), runId: run.id, operationId: "op-original-1", kind, status: "DISPATCHED", payload: { changes: [{ path: "a.txt", content: "a\n" }] }, branch: "autopilot/t-1", baseCommitSha: "a".repeat(40), attempt: 0, queuedAt: now, updatedAt: now };
  await store.createExecutionJob(job);
  const dispatched: ExecutionJob[] = [];
  let refuse = false;
  const github: Record<string, { status: string; conclusion?: string }> = {};
  const deps: StallRecoveryDependencies = {
    store,
    clock,
    ids: uuidGenerator,
    dispatchers: {
      execution: { dispatch: async (value) => { if (refuse) throw new Error("GitHub said 503"); dispatched.push(value); return {}; } },
      httpE2e: { dispatch: async (value) => { dispatched.push(value); return {}; } },
    },
    workflowRun: async (value) => (value.workflowRunId ? github[value.workflowRunId] : undefined),
  };
  const jobs = async () => (await store.listExecutionJobs(project.id, task.id)).sort((left, right) => left.queuedAt.localeCompare(right.queuedAt) || left.attempt - right.attempt);
  return { store, deps, project, task, run, job, dispatched, github, jobs, at: (value: number) => (now = minutes(value)), refuse: (value: boolean) => (refuse = value) };
}

describe("resume back-off", () => {
  it("starts immediately, then doubles from 15 minutes and never exceeds the ceiling", () => {
    const delays = Array.from({ length: 30 }, (_, index) => resumeDelayMinutes(index + 1));
    expect(delays.slice(0, 7)).toEqual([0, 15, 30, 60, 120, 240, 360]);
    for (let index = 1; index < delays.length; index += 1) expect(delays[index]).toBeGreaterThanOrEqual(delays[index - 1]!);
    expect(Math.max(...delays)).toBe(RESUME_BACKOFF_CEILING_MINUTES);
  });
});

describe("stalled work is resumed, not parked", () => {
  it("ends a job nobody picked up, starts the same work again at once, and keeps the task and run going", async () => {
    const { store, deps, task, run, job, dispatched, jobs, at } = await world();
    at(20);
    const results = await recoverStalledWork(deps);
    expect(results.map((value) => value.action)).toEqual(["RESUMED", "DISPATCHED"]);
    const [stalled, next] = await jobs();
    expect(stalled).toMatchObject({ id: job.id, status: "FAILED", error: { code: "EXECUTION_NEVER_STARTED", remediation: expect.stringContaining("Resumed automatically") } });
    expect(next).toMatchObject({ status: "DISPATCHED", operationId: "op-original-1#resume-1", attempt: 1, runId: run.id, payload: job.payload, branch: job.branch, baseCommitSha: job.baseCommitSha, resume: { of: job.id, root: job.id, attempt: 1, cause: "EXECUTION_NEVER_STARTED", consecutiveSameCause: 1 } });
    expect(dispatched.map((value) => value.id)).toEqual([next!.id]);
    expect((await store.getTask(task.projectId, task.id))?.state).toBe("IMPLEMENTING");
    expect((await store.getRun(task.projectId, run.id))?.status).toBe("RUNNING");
    expect((await store.listAudit(task.projectId)).map((event) => event.action)).toEqual(["execution.job.resumed", "execution.job.dispatched"]);
  });

  it("waits longer each time the same cause repeats, and dispatches when the wait is over", async () => {
    const { deps, jobs, at } = await world();
    at(20);
    await recoverStalledWork(deps);
    // Attempt 1 is dispatched at 20 and again never picked up.
    at(40);
    expect((await recoverStalledWork(deps)).map((value) => value.action)).toEqual(["RESUMED"]);
    const second = (await jobs()).at(-1)!;
    expect(second).toMatchObject({ status: "QUEUED", operationId: "op-original-1#resume-2", resume: { attempt: 2, consecutiveSameCause: 2, notBefore: minutes(55) } });
    at(50);
    expect((await recoverStalledWork(deps)).map((value) => value.action)).toEqual(["WAIT"]);
    at(56);
    expect((await recoverStalledWork(deps)).map((value) => value.action)).toEqual(["DISPATCHED"]);
    expect((await jobs()).at(-1)?.status).toBe("DISPATCHED");
  });

  it("starts over at once when the cause changes", async () => {
    const { deps, jobs, at, github, store } = await world();
    at(20);
    await recoverStalledWork(deps);
    const attempt = (await jobs()).at(-1)!;
    await store.updateExecutionJob({ ...attempt, workflowRunId: "77" });
    github["77"] = { status: "completed", conclusion: "failure" };
    at(25);
    await recoverStalledWork(deps);
    expect((await jobs()).at(-1)).toMatchObject({ status: "DISPATCHED", resume: { attempt: 2, cause: "GITHUB_ACTIONS_FAILURE", consecutiveSameCause: 1 } });
  });

  it("keeps a refused dispatch queued with its reason, and tries again later", async () => {
    const { deps, jobs, at, refuse } = await world();
    refuse(true);
    at(20);
    expect((await recoverStalledWork(deps)).map((value) => value.action)).toEqual(["RESUMED", "DISPATCH_DEFERRED"]);
    expect((await jobs()).at(-1)).toMatchObject({ status: "QUEUED", resume: { lastDispatchError: "GitHub said 503", notBefore: minutes(35) } });
    refuse(false);
    at(36);
    expect((await recoverStalledWork(deps)).map((value) => value.action)).toEqual(["DISPATCHED"]);
  });

  it("resumes an HTTP E2E verification through its own workflow", async () => {
    const { deps, dispatched, at } = await world("HTTP_E2E");
    at(20);
    await recoverStalledWork(deps);
    expect(dispatched.map((value) => value.kind)).toEqual(["HTTP_E2E"]);
  });

  it("leaves a run a person cancelled in GitHub stopped", async () => {
    const { store, deps, task, job, jobs, github, at } = await world();
    await store.updateExecutionJob({ ...job, workflowRunId: "99" });
    github["99"] = { status: "completed", conclusion: "cancelled" };
    at(5);
    expect((await recoverStalledWork(deps)).map((value) => value.action)).toEqual(["TERMINALIZE"]);
    expect(await jobs()).toHaveLength(1);
    expect((await store.getTask(task.projectId, task.id))?.state).toBe("BLOCKED");
  });

  it("waits for a job that is still within its grace period", async () => {
    const { deps, at } = await world();
    at(5);
    expect((await recoverStalledWork(deps)).map((value) => value.action)).toEqual(["WAIT"]);
  });
});
