import type { PropertyBasedReport } from '../../schemas/src/index.js';

// Proof that generative tests actually ran.
//
// A green `gradle test` exit code says nothing about whether a single property was ever generated:
// a build with zero property tests and a build with nine of them exit 0 identically. That is
// precisely how CORE-BE-01..21 reached merge with a full green suite and no generative layer at
// all. So the PROPERTY layer is never satisfied by a suite status. It is satisfied by counts and
// seeds parsed out of the runner's own output -- and when that output cannot be found, the honest
// answer is UNVERIFIED, never a pass.

// jqwik prints one report block per property. `tries` is the number of generated calls; `checks`
// excludes the ones an assumption rejected. Both are anchored to line starts so a property whose
// own failure message happens to contain "tries = " cannot inflate the count.
const triesLine = /^\s*tries\s*=\s*(\d+)/gm;
const checksLine = /^\s*checks\s*=\s*(\d+)/gm;
const seedLine = /^\s*seed\s*=\s*(-?\d+)/gm;
const shrinkingOff = /^\s*shrinking\s*=\s*OFF/mi;
const shrunkSample = /^\s*Shrunk Sample\b/gm;
const originalSample = /^\s*Original Sample\b/gm;
const jqwikBanner = /\|-+jqwik-+/;

// fast-check stays silent on success, so its output can only ever prove a failure. A passing
// fast-check run has to be evidenced by a report file instead -- see readPropertyReportFile.
const fastCheckFailure = /Property failed after (\d+) test/g;
const fastCheckSeed = /\bseed\s*[:=]\s*(-?\d+)/gi;

function count(pattern: RegExp, text: string) {
  return [...text.matchAll(pattern)].length;
}

function sum(pattern: RegExp, text: string) {
  return [...text.matchAll(pattern)].reduce((total, match) => total + Number(match[1] ?? 0), 0);
}

export interface ParsedPropertyRun {
  framework: PropertyBasedReport['framework'];
  properties: number;
  generatedCases: number;
  shrinking: PropertyBasedReport['shrinking'];
  replaySeeds: string[];
  counterexamples: number;
}

/** Reads a real runner transcript. Returns undefined when no generative framework spoke at all. */
export function parsePropertyRunnerOutput(stdout: string): ParsedPropertyRun | undefined {
  const properties = count(triesLine, stdout);
  if (properties > 0 || jqwikBanner.test(stdout)) {
    const shrunk = count(shrunkSample, stdout);
    const original = count(originalSample, stdout);
    // `checks` is the honest count of cases that actually reached the property body; `tries`
    // includes calls an assumption rejected. Prefer checks and fall back to tries.
    const checks = sum(checksLine, stdout);
    return {
      framework: 'jqwik',
      properties,
      generatedCases: checks || sum(triesLine, stdout),
      shrinking: shrinkingOff.test(stdout) ? 'DISABLED' : 'ENABLED',
      replaySeeds: [...stdout.matchAll(seedLine)].map((match) => String(match[1])),
      counterexamples: Math.max(shrunk, original),
    };
  }
  const failures = count(fastCheckFailure, stdout);
  if (failures > 0) {
    return {
      framework: 'fast-check',
      properties: failures,
      generatedCases: sum(fastCheckFailure, stdout),
      shrinking: 'ENABLED',
      replaySeeds: [...stdout.matchAll(fastCheckSeed)].map((match) => String(match[1])),
      counterexamples: failures,
    };
  }
  return undefined;
}

/**
 * A target project whose runner is silent on success (fast-check, and any custom harness) can hand
 * the gate the same numbers directly. The file is evidence the project wrote about its own run --
 * it is validated, not trusted blindly: a file claiming zero properties still fails the gate below.
 */
export function parsePropertyReportFile(content: string): ParsedPropertyRun | undefined {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const properties = Number(value['properties'] ?? 0);
  const generatedCases = Number(value['generatedCases'] ?? value['cases'] ?? 0);
  if (!Number.isFinite(properties) || !Number.isFinite(generatedCases)) return undefined;
  const framework = value['framework'];
  const seeds = Array.isArray(value['replaySeeds']) ? (value['replaySeeds'] as unknown[]).map(String) : [];
  return {
    framework: framework === 'jqwik' || framework === 'fast-check' ? framework : 'UNKNOWN',
    properties: Math.max(0, Math.trunc(properties)),
    generatedCases: Math.max(0, Math.trunc(generatedCases)),
    shrinking: value['shrinking'] === false ? 'DISABLED' : value['shrinking'] === true ? 'ENABLED' : 'UNKNOWN',
    replaySeeds: seeds,
    counterexamples: Math.max(0, Math.trunc(Number(value['counterexamples'] ?? 0)) || 0),
  };
}

export interface PropertyEvidenceInput {
  /** Whether the approved plan's verification profile demands this layer. */
  required: boolean;
  /** Exit status of the suite the properties ran inside; a pass here is necessary, never sufficient. */
  suitePassed: boolean;
  parsed?: ParsedPropertyRun | undefined;
  source: PropertyBasedReport['evidence'];
}

export function buildPropertyBasedReport(input: PropertyEvidenceInput): PropertyBasedReport {
  const empty = { properties: 0, generatedCases: 0, replaySeeds: [] as string[], counterexamples: 0 };
  if (!input.required) {
    // Properties that ran anyway are still recorded; the layer simply is not gated on them.
    return {
      required: false,
      framework: input.parsed?.framework ?? 'UNKNOWN',
      status: 'NOT_APPLICABLE',
      evidence: input.parsed ? input.source : 'NONE',
      properties: input.parsed?.properties ?? empty.properties,
      generatedCases: input.parsed?.generatedCases ?? empty.generatedCases,
      shrinking: input.parsed?.shrinking ?? 'UNKNOWN',
      replaySeeds: input.parsed?.replaySeeds ?? empty.replaySeeds,
      counterexamples: input.parsed?.counterexamples ?? empty.counterexamples,
      reasons: ['the approved verification profile does not require a generative layer for this task'],
    };
  }
  if (!input.parsed) {
    return {
      required: true,
      framework: 'UNKNOWN',
      status: 'UNVERIFIED',
      evidence: 'NONE',
      ...empty,
      shrinking: 'UNKNOWN',
      reasons: [
        'No generative framework reported a run. A passing build is not evidence: add jqwik (JVM) or fast-check (Node) properties, or emit reports/property-based-report.json, so the number of generated cases and the replay seed can be recorded.',
      ],
    };
  }
  const reasons: string[] = [];
  let status: PropertyBasedReport['status'] = 'PASS';
  if (input.parsed.counterexamples > 0) {
    status = 'FAIL';
    reasons.push(`${input.parsed.counterexamples} counterexample(s) were shrunk out of the generated inputs; replay with seed ${input.parsed.replaySeeds.at(-1) ?? '(unrecorded)'}`);
  } else if (!input.suitePassed) {
    status = 'FAIL';
    reasons.push('the suite carrying the properties failed');
  } else if (input.parsed.properties === 0) {
    status = 'UNVERIFIED';
    reasons.push('the framework was present but executed no properties, so nothing was generated');
  } else {
    reasons.push(`${input.parsed.properties} propert(y|ies) generated ${input.parsed.generatedCases} case(s) with no counterexample`);
  }
  return {
    required: true,
    framework: input.parsed.framework,
    status,
    evidence: input.source,
    properties: input.parsed.properties,
    generatedCases: input.parsed.generatedCases,
    shrinking: input.parsed.shrinking,
    replaySeeds: input.parsed.replaySeeds,
    counterexamples: input.parsed.counterexamples,
    reasons,
  };
}
