import type { Artifact, AuditEvent, ExecutionJob, Run, Task } from "../../schemas/src/index.js";

// One delivery record per task: what was asked for, what was actually built, what was proven, and
// whether it reached the repository's default branch.
//
// Gate verdicts come exclusively from durable per-task artifacts. The pull request and merge
// prefer artifacts too, falling back to the audit log only for tasks delivered before the MCP
// tools learned to persist PULL_REQUEST_REPORT (see resolveDelivery). Both sources are only
// trustworthy because PostgrestStateStore.many() pages explicitly -- PostgREST caps an unbounded
// GET at 1000 rows and returns the truncated page with a 200, which on this project silently hid
// everything after 2026-08-23 and turned real PASS verdicts into PENDING.

export type DeliveryGateStatus = "PASS" | "FAIL" | "PENDING";

export interface DeliverySuite {
  type: string;
  passed: boolean;
  exitCode?: number;
}

export interface DeliveryRecord {
  taskId: string;
  externalKey: string;
  /**
   * Upstream tracker reference (e.g. a Qira key) parsed out of the task title/description. Tasks
   * carry no dedicated tracker field, so this is a best-effort read of what the operator wrote and
   * is surfaced as `sourceRefDerived: true` -- never presented as a verified upstream link.
   */
  sourceRef?: string;
  sourceRefDerived: boolean;
  title: string;
  state: Task["state"];
  repairAttempts: number;
  branch?: string;
  commitSha?: string;
  /** Attempts that actually reached the repository, i.e. produced a commit. */
  attempts: number;
  failedAttempts: number;
  tests: { status: DeliveryGateStatus; suites: DeliverySuite[]; finishedAt?: string };
  ci: { status: DeliveryGateStatus; conclusion?: string; url?: string; headSha?: string; stack?: string; toolchain?: Record<string, unknown> };
  review: { status: DeliveryGateStatus; failures: string[]; warnings: number; reviewedAt?: string };
  /** The FINAL_CHANGE_MANIFEST commit -- the exact SHA every READY gate was proven against. */
  verifiedCommitSha?: string;
  pullRequest?: { number: number; url: string };
  merged: boolean;
  mergedIntoBranch?: string;
  mergedCommitSha?: string;
  /** Set when a rebase transfer ran; ALREADY_INTEGRATED means the base already carried the work. */
  rebaseStatus?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface DeliverySummary {
  total: number;
  merged: number;
  ready: number;
  inFlight: number;
  blocked: number;
  failed: number;
  testsPassing: number;
  reviewPassing: number;
}

// The leading lookbehind is what keeps a multi-segment key from matching its own tail: without it
// "CORE-BE-07" yields the bogus candidate "BE-07", which is neither the task's key nor an upstream
// reference. A real tracker key is never preceded by a hyphen or another key character.
const trackerKey = /(?<![A-Z0-9-])([A-Z][A-Z0-9]{1,15}-\d{1,6})\b/g;

/**
 * Picks the tracker reference that is NOT the task's own externalKey. A title like
 * "Momna CORE-BE-07 / MOMNA-843 — ..." carries both the autopilot key and the upstream one; only
 * the upstream one is useful here.
 */
export function deriveSourceRef(task: Pick<Task, "externalKey" | "title" | "description">) {
  const own = task.externalKey.toUpperCase();
  const seen = new Set<string>();
  for (const text of [task.title, task.description]) {
    for (const match of text.matchAll(trackerKey)) {
      const candidate = match[1]?.toUpperCase();
      if (!candidate || candidate === own || seen.has(candidate)) continue;
      // A key that merely extends the task's own key (CORE-BE-07 inside CORE-BE-07-EVIDENCE) is
      // the same work item, not an upstream reference.
      if (candidate.startsWith(own) || own.startsWith(candidate)) continue;
      seen.add(candidate);
    }
  }
  return [...seen][0];
}

const latest = (artifacts: Artifact[], kind: Artifact["kind"]) =>
  artifacts.filter((value) => value.kind === kind && value.status === "AVAILABLE").at(-1);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/**
 * Resolves the pull request and merge for one task.
 *
 * PULL_REQUEST_REPORT artifacts are the durable record, but they only started being written once
 * the MCP delivery path learned to persist them -- every task merged before that has its evidence
 * solely in the audit log. Audit is authoritative for the action itself (it is what `mutate`
 * writes on a successful tool call), so it is used as the historical fallback rather than showing
 * genuinely-merged epics as unmerged. Artifacts win when both exist.
 */
function resolveDelivery(taskId: string, artifacts: Artifact[], audit: AuditEvent[]) {
  const reports = artifacts.filter(
    (value) => value.kind === "PULL_REQUEST_REPORT" && value.status === "AVAILABLE",
  );
  const mergedReport = [...reports].reverse().find((value) => asRecord(value.content).merged === true);
  const fromArtifact = asRecord((mergedReport ?? reports.at(-1))?.content);
  if (Object.keys(fromArtifact).length) return fromArtifact;

  const entries = audit.filter((event) => {
    if (!/^mcp\.sandbox_pull_request_(open|merge)$/.test(event.action)) return false;
    const payload = asRecord(asRecord((event as { input?: unknown }).input).payload);
    return payload.taskId === taskId;
  });
  const mergedEvent = [...entries].reverse().find((event) => asRecord(event.result).merged === true);
  return asRecord((mergedEvent ?? entries.at(-1))?.result);
}

export function deliveryForTask(input: {
  task: Task;
  runs: Run[];
  artifacts: Artifact[];
  jobs?: ExecutionJob[];
  audit?: AuditEvent[];
}): DeliveryRecord {
  const runs = input.runs.filter((run) => run.taskId === input.task.id);
  const artifacts = input.artifacts.filter((value) => value.taskId === input.task.id);
  const jobs = (input.jobs ?? []).filter((job) => job.taskId === input.task.id);

  const testContent = asRecord(latest(artifacts, "TEST_REPORT")?.content);
  const suites = Array.isArray(testContent.suites)
    ? (testContent.suites as Record<string, unknown>[]).map((suite) => ({
        type: String(suite.type ?? "UNKNOWN"),
        passed: suite.passed === true,
        ...(typeof suite.exitCode === "number" ? { exitCode: suite.exitCode } : {}),
      }))
    : [];

  const ciContent = asRecord(latest(artifacts, "CI_REPORT")?.content);
  const ci = asRecord(ciContent.ci);

  const reviewContent = asRecord(latest(artifacts, "REVIEW_REPORT")?.content);
  const failures = Array.isArray(reviewContent.failures) ? reviewContent.failures.map(String) : [];

  const manifest = asRecord(latest(artifacts, "FINAL_CHANGE_MANIFEST")?.content);

  const pullContent = resolveDelivery(input.task.id, artifacts, input.audit ?? []);
  const pull = asRecord(pullContent.pullRequest);

  const rebase = asRecord(latest(artifacts, "REBASE_REPORT")?.content);

  const lastCommitRun = [...runs].reverse().find((run) => run.commitSha);
  const succeeded = runs.filter((run) => run.status === "SUCCEEDED");

  const testStatus: DeliveryGateStatus = suites.length === 0 ? "PENDING" : testContent.passed === true ? "PASS" : "FAIL";
  const ciStatus: DeliveryGateStatus =
    ci.success === undefined ? "PENDING" : ci.success === true ? "PASS" : "FAIL";
  const reviewStatus: DeliveryGateStatus =
    reviewContent.result === undefined ? "PENDING" : reviewContent.result === "PASS" ? "PASS" : "FAIL";

  const sourceRef = deriveSourceRef(input.task);

  return {
    taskId: input.task.id,
    externalKey: input.task.externalKey,
    ...(sourceRef ? { sourceRef } : {}),
    sourceRefDerived: true,
    title: input.task.title,
    state: input.task.state,
    repairAttempts: input.task.repairAttempts,
    ...(lastCommitRun?.branch ? { branch: lastCommitRun.branch } : {}),
    ...(lastCommitRun?.commitSha ? { commitSha: lastCommitRun.commitSha } : {}),
    attempts: runs.filter((run) => run.commitSha).length || jobs.filter((job) => job.commitSha).length,
    failedAttempts: runs.filter((run) => run.status === "FAILED").length,
    tests: {
      status: testStatus,
      suites,
      ...(typeof testContent.finishedAt === "string" ? { finishedAt: testContent.finishedAt } : {}),
    },
    ci: {
      status: ciStatus,
      ...(typeof ci.conclusion === "string" ? { conclusion: ci.conclusion } : {}),
      ...(typeof ci.url === "string" ? { url: ci.url } : {}),
      ...(typeof ci.headSha === "string" ? { headSha: ci.headSha } : {}),
      ...(typeof ciContent.detectedStack === "string" ? { stack: ciContent.detectedStack } : {}),
      ...(ciContent.toolchain ? { toolchain: asRecord(ciContent.toolchain) } : {}),
    },
    review: {
      status: reviewStatus,
      failures,
      warnings: Array.isArray(reviewContent.warnings) ? reviewContent.warnings.length : 0,
      ...(typeof reviewContent.reviewedAt === "string" ? { reviewedAt: reviewContent.reviewedAt } : {}),
    },
    ...(typeof manifest.verifiedCommitSha === "string" ? { verifiedCommitSha: manifest.verifiedCommitSha } : {}),
    ...(typeof pull.number === "number" && typeof pull.url === "string"
      ? { pullRequest: { number: pull.number, url: pull.url } }
      : {}),
    merged: pullContent.merged === true,
    ...(typeof pullContent.defaultBranch === "string" ? { mergedIntoBranch: pullContent.defaultBranch } : {}),
    ...(typeof pullContent.verifiedCommitSha === "string" ? { mergedCommitSha: pullContent.verifiedCommitSha } : {}),
    ...(typeof rebase.status === "string" ? { rebaseStatus: rebase.status } : {}),
    ...(runs[0]?.startedAt ? { startedAt: runs[0].startedAt } : {}),
    ...(typeof succeeded.at(-1)?.finishedAt === "string"
      ? { completedAt: succeeded.at(-1)!.finishedAt as string }
      : {}),
  };
}

export function deliverySummary(records: DeliveryRecord[]): DeliverySummary {
  return {
    total: records.length,
    merged: records.filter((value) => value.merged).length,
    ready: records.filter((value) => value.state === "READY").length,
    inFlight: records.filter((value) => !["READY", "FAILED", "BLOCKED", "INGESTED"].includes(value.state)).length,
    blocked: records.filter((value) => value.state === "BLOCKED").length,
    failed: records.filter((value) => value.state === "FAILED").length,
    testsPassing: records.filter((value) => value.tests.status === "PASS").length,
    reviewPassing: records.filter((value) => value.review.status === "PASS").length,
  };
}

/**
 * Delivery view for one project. Tasks that never reached execution (no run, no gate evidence) are
 * kept: an operator asking "what happened to this epic" needs to see that the answer is "nothing
 * yet", not have it omitted.
 */
export function deliveryForProject(input: {
  tasks: Task[];
  runs: Run[];
  artifacts: Artifact[];
  jobs?: ExecutionJob[];
  audit?: AuditEvent[];
}) {
  const records = input.tasks
    .filter((task) => !task.deletedAt)
    .map((task) =>
      deliveryForTask({
        task,
        runs: input.runs,
        artifacts: input.artifacts,
        ...(input.jobs ? { jobs: input.jobs } : {}),
        ...(input.audit ? { audit: input.audit } : {}),
      }),
    )
    .sort((a, b) => a.externalKey.localeCompare(b.externalKey, undefined, { numeric: true }));
  return { summary: deliverySummary(records), records };
}
