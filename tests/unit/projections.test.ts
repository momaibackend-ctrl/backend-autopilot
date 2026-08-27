import { describe, expect, it } from "vitest";
import {
  apiView,
  capabilitiesView,
  databaseView,
  lifecycleRail,
  taskSummaryFrom,
  taskTimeline,
  validationHistoryView,
} from "../../packages/operator-console/src/projections.js";
import type { Artifact, AuditEvent, Resource, Run, Task, Transition } from "../../packages/schemas/src/index.js";

const projectId = "22222222-2222-2222-2222-222222222222";
const taskId = "11111111-1111-1111-1111-111111111111";

const artifact = (kind: Artifact["kind"], content: unknown, over: Partial<Artifact> = {}): Artifact =>
  ({
    id: `${kind}-${Math.random()}`,
    projectId,
    taskId,
    kind,
    schemaVersion: "5",
    content,
    contentHash: "h",
    status: "AVAILABLE",
    createdAt: "2026-08-27T10:00:00.000Z",
    ...over,
  }) as unknown as Artifact;

const run = (over: Partial<Run> = {}): Run =>
  ({
    id: "run-1",
    projectId,
    taskId,
    operationId: "op-1",
    status: "SUCCEEDED",
    branch: "autopilot/CORE-BE-09",
    commitSha: "37cca37390a6d1deebe1a56c05f66a0161926eb1",
    startedAt: "2026-08-27T10:10:00.000Z",
    ...over,
  }) as unknown as Run;

describe("console projections", () => {
  it("gives every timeline event a status the console can render", () => {
    // The deployed console fed raw Transition rows straight to tone(event.status), which calls
    // .toUpperCase() -- undefined there crashed the whole task page.
    const transitions = [
      { id: "t1", taskId, from: "PLANNED", to: "IMPLEMENTING", reason: "queued", actor: "a", inputArtifactIds: [], outputArtifactIds: [], timestamp: "2026-08-27T10:05:00.000Z" },
      { id: "t2", taskId, from: "TESTING", to: "READY", reason: "gates passed", actor: "a", inputArtifactIds: [], outputArtifactIds: [], timestamp: "2026-08-27T10:20:00.000Z" },
    ] as unknown as Transition[];

    const events = taskTimeline(transitions, [run()]);

    expect(events).toHaveLength(3);
    for (const event of events) {
      expect(typeof event.status).toBe("string");
      expect(event.status.length).toBeGreaterThan(0);
      expect(() => event.status.toUpperCase()).not.toThrow();
    }
    // Merged and ordered: transition, run, transition.
    expect(events.map((e) => e.kind)).toEqual(["STATE", "RUN", "STATE"]);
  });

  it("keeps the rail meaningful for BLOCKED and FAILED tasks", () => {
    const ready = lifecycleRail("READY");
    expect(ready.interrupted).toBe(false);
    expect(ready.rungs).toHaveLength(7);
    expect(ready.rungs.every((rung) => rung.complete)).toBe(true);
    expect(ready.rungs.filter((rung) => rung.current)).toHaveLength(1);

    // A naive indexOf would return -1 here and render an entirely empty rail for exactly the
    // tasks an operator most needs to inspect.
    for (const state of ["BLOCKED", "FAILED"]) {
      const rail = lifecycleRail(state);
      expect(rail.interrupted).toBe(true);
      expect(rail.interruptedBy).toBe(state);
      expect(rail.rungs.some((rung) => rung.complete)).toBe(true);
      expect(rail.rungs.every((rung) => !rung.current)).toBe(true);
    }
  });

  it("enriches a task from snapshot slices without cross-task bleed", () => {
    const other = "99999999-9999-9999-9999-999999999999";
    const summary = taskSummaryFrom({
      task: { id: taskId, projectId, externalKey: "CORE-BE-09", state: "READY" } as unknown as Task,
      artifacts: [
        artifact("CI_REPORT", { ci: { success: true } }),
        artifact("REVIEW_REPORT", { result: "PASS", warnings: ["w"] }),
        artifact("CI_REPORT", { ci: { success: false } }, { taskId: other }),
      ],
      runs: [run(), run({ id: "foreign", taskId: other, commitSha: "dead" })],
    });

    expect(summary.branch).toBe("autopilot/CORE-BE-09");
    expect(summary.artifactCount).toBe(2);
    expect(summary.warnings).toEqual(["w"]);
    expect(summary.ci).toEqual({ ci: { success: true } });
  });

  it("builds the database and api views the console actually reads", () => {
    const resources = [
      { resourceId: "r1", projectId, type: "DATABASE", provider: "supabase", status: "ACTIVE", externalReference: "db", secretRefs: [], permissions: [], environment: "SANDBOX" },
    ] as unknown as Resource[];
    const artifacts = [
      artifact("MIGRATION_MANIFEST", { migrations: [] }),
      artifact("VALIDATION_REPORT", {
        schema: { tables: [{ table_schema: "public", table_name: "users" }, { table_schema: "auth", table_name: "hidden" }] },
      }),
      artifact("API_CONTRACT", { contracts: [{ document: { paths: { "/health": {} } } }] }),
    ];

    const database = databaseView(resources, artifacts);
    expect(database.provider).toBe("supabase");
    expect(database.migrations).toHaveLength(1);
    // Only the public schema is surfaced.
    expect(database.schema?.tables).toHaveLength(1);
    expect(database.schemaDiff).toContain("+ table public.users");

    expect(apiView(artifacts).contracts).toHaveLength(1);
    expect(validationHistoryView(artifacts)).toHaveLength(1);
  });

  it("reports capabilities from evidence and never invents a live probe", () => {
    const audit = [
      { id: "a1", timestamp: "2026-08-20T00:00:00.000Z", actor: "bootstrap-agent", action: "bootstrap.github.ci_verified", projectId, reason: "r", result: { success: true } },
    ] as unknown as AuditEvent[];

    const proven = capabilitiesView({ audit, artifacts: [] });
    expect(proven.evidence.ci).toMatchObject({ status: "LIVE_TESTED" });
    expect(proven.evidence.remoteWrite).toMatchObject({ status: "NOT_VERIFIED" });
    // With no snapshot it must say so rather than claim an interface is live.
    expect(proven.note).toMatch(/not measurable/i);

    const withSnapshot = capabilitiesView({
      audit,
      artifacts: [artifact("CAPABILITY_SNAPSHOT", { capturedAt: "2026-08-21T00:00:00.000Z", git: { local: { status: "LIVE_TESTED" } } })],
    });
    expect(withSnapshot.snapshotCapturedAt).toBe("2026-08-21T00:00:00.000Z");
    expect(withSnapshot.note).toMatch(/evidence-of-record/i);
  });
});
