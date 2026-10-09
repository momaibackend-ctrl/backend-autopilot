// The evidence an environment run produces, and the failure classes it names. Kept free of Node
// builtins so the control plane (Edge) can validate and read it without bundling the executor.
import { z } from "zod";

export const ENVIRONMENT_EVIDENCE_VERSION = "1";

export const failureClassSchema = z.enum([
  "PLAN_UNRESOLVED",
  "INFRASTRUCTURE_UNAVAILABLE",
  "DEPENDENCY_UNAVAILABLE",
  "BUILD_FAILED",
  "ENVIRONMENT_BOOT_FAILED",
  "HEALTH_CHECK_FAILED",
  "NO_SCENARIOS",
  "SCENARIO_FAILED",
  "COVERAGE_INCOMPLETE",
  "CONTRACT_GAP",
]);
export type FailureClass = z.infer<typeof failureClassSchema>;

export const environmentStepSchema = z.object({
  phase: z.enum(["dependency", "install", "build", "prepare", "start", "health", "collection"]),
  name: z.string(),
  status: z.enum(["PASSED", "FAILED", "SKIPPED"]),
  durationMs: z.number().int().nonnegative(),
  exitCode: z.number().int().optional(),
  logTail: z.string().optional(),
});
export const environmentEvidenceSchema = z.object({
  evidenceVersion: z.literal(ENVIRONMENT_EVIDENCE_VERSION),
  startedAt: z.string(),
  completedAt: z.string(),
  durationMs: z.number().int().nonnegative(),
  plan: z.unknown(),
  outcome: z.object({
    verdict: z.enum(["PROVEN", "NOT_PROVEN"]),
    failure: z.object({ class: failureClassSchema, step: z.string(), message: z.string() }).optional(),
    reasons: z.array(z.string()),
  }),
  steps: z.array(environmentStepSchema),
  health: z.object({ ready: z.boolean(), path: z.string().optional(), status: z.number().int().optional(), attempts: z.number().int(), durationMs: z.number().int() }).optional(),
  applicationLogTail: z.string().optional(),
  collection: z.unknown().optional(),
  scenarioReports: z.array(z.unknown()),
  /** What the Postman import skipped or warned about, so a thin import is visible in the evidence. */
  collectionImport: z.unknown().optional(),
});
export type EnvironmentEvidence = z.infer<typeof environmentEvidenceSchema>;
