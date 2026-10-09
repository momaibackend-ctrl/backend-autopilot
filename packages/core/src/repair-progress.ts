import type { Artifact, TestReport } from "../../schemas/src/index.js";

// Whether repairs are making progress, measured by the cause of each failure rather than by how
// many there have been (ADR 022).
//
// The gate used to stop a task after a fixed number of failed attempts. That stopped exactly the
// caller who was making progress -- three different failures fixed one after another read the same
// as one failure retried three times -- and it never told anyone what to do differently. Repairs in
// this control plane are never automatic: each one is a new change set an agent chose to send, so
// the counter was not protecting against a runaway loop either. What does need catching is a
// repair that does not change the cause. This module fingerprints each failure from its own
// evidence and reports how many consecutive attempts reproduced the same cause.

/** Same cause this many times in a row means the last hypotheses did not reach it. */
export const STAGNATION_THRESHOLD = 3;

function hash(text: string) {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value.toString(16).padStart(8, "0");
}

/** The cause of a failed test run, from which suites failed and how. Stable across attempts. */
export function testFailureFingerprint(report: TestReport): string | undefined {
  // Persisted reports are read back as they were stored, including older or partial shapes; only
  // an explicit failure counts, and missing parts are treated as absent rather than trusted.
  if (report?.passed !== false) return undefined;
  const suites = Array.isArray(report.suites) ? report.suites : [];
  const failed = suites.filter((suite) => !suite?.passed).map((suite) => `${suite?.type}:${suite?.exitCode}`).sort();
  // A failing generative suite is the same cause while it fails on the same replay seeds.
  const seeds = report.propertyBased?.status === "FAIL" && Array.isArray(report.propertyBased.replaySeeds) ? report.propertyBased.replaySeeds : [];
  const counterexample = report.propertyBased?.status === "FAIL" ? ["property", ...[...seeds].sort()] : [];
  return hash(["tests", ...failed, ...counterexample].join("|"));
}

export interface RepairProgress {
  /** Failed verifications recorded for the task, oldest first. */
  failures: number;
  /** How many of the most recent failures share the latest cause. */
  consecutiveSameCause: number;
  stagnating: boolean;
  latestFingerprint?: string;
  /** What to do next, phrased for the agent sending the repair. */
  guidance?: string;
}

/**
 * Reads every failed verification of a task in order -- failed test reports and NOT_PROVEN HTTP E2E
 * evidence -- and says whether the latest repairs changed the cause.
 */
export function repairProgress(artifacts: Artifact[]): RepairProgress {
  const fingerprints: string[] = [];
  const ordered = [...artifacts].sort((left, right) => String(left.createdAt ?? "").localeCompare(String(right.createdAt ?? "")));
  for (const artifact of ordered) {
    if (artifact.status !== "AVAILABLE") continue;
    if (artifact.kind === "TEST_REPORT") {
      const fingerprint = testFailureFingerprint(artifact.content as TestReport);
      if (fingerprint) fingerprints.push(fingerprint);
    } else if (artifact.kind === "VALIDATION_REPORT") {
      const content = artifact.content as { suite?: string; verdict?: string; diagnosis?: { fingerprint?: string } } | undefined;
      if (content?.suite === "HTTP_E2E" && content.verdict === "NOT_PROVEN" && content.diagnosis?.fingerprint) fingerprints.push(`e2e:${content.diagnosis.fingerprint}`);
    }
  }
  const latest = fingerprints.at(-1);
  let consecutive = 0;
  for (let index = fingerprints.length - 1; index >= 0 && fingerprints[index] === latest; index -= 1) consecutive += 1;
  const stagnating = consecutive >= STAGNATION_THRESHOLD;
  return {
    failures: fingerprints.length,
    consecutiveSameCause: consecutive,
    stagnating,
    ...(latest ? { latestFingerprint: latest } : {}),
    ...(stagnating
      ? {
          guidance: `The same cause has failed ${consecutive} attempts in a row, so the last fixes did not reach it. Do not send another variation of the same change: read the full failing output (artifact_read with tail:true, superadmin_http_e2e_get for its diagnosis and logs), reproduce the failure in the smallest possible case, check the neighbouring layer it may come from (contract, scenario, environment manifest, migration, dependency version), and only then send a repair based on the new hypothesis.`,
        }
      : latest
        ? { guidance: consecutive > 1 ? `The latest cause repeated ${consecutive} times; make sure the next repair targets it directly.` : "The latest repair changed the cause: that is progress. Fix the new cause the same way." }
        : {}),
  };
}
