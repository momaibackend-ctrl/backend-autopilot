import type { Artifact } from '../../schemas/src/index.js';

// Whether a change is observable in operation, decided from the change itself.
//
// The rule this replaces was `plan.requirements.some(x=>/observ|log/i.test(x)) || riskLevel==='LOW'`.
// It never read a line of the code it was judging, and it was wrong in both directions at once.
//
// False negative: risk level is set by the planner as `scope.database.intended ? MEDIUM : LOW`, so a
// task the scope classifier read as touching the database became MEDIUM, and then only the literal
// substrings "observ" or "log" appearing somewhere in the plan's requirements could pass the gate.
// A task whose requirements happened not to use those words failed observability permanently: no
// amount of structured logging, metrics, spans or telemetry tests could change the answer, because
// none of them are inputs to it. Re-running execution re-ran the same expression over the same
// unchanged plan.
//
// False positive: the repository's own demo task passes this gate today on the strength of the
// phrase "Structured logging and observable errors" in its requirements, while the implementation
// it ships contains no logger, no metric and no span anywhere.
//
// So the gate is decided here from the CODE_DIFF artifact the execution runner writes. Three
// outcomes, and the reason for each is recorded on the review rather than being silently folded
// into a boolean:
//
//   PRESENT        the added lines carry at least one named observability signal
//   NOT_APPLICABLE the change adds no operational code -- docs, tests, migrations, contracts only
//   MISSING        operational code was added and nothing observable came with it
//
// NOT_APPLICABLE is what keeps this from becoming the mirror image of the old bug. A gate that can
// only be passed by adding log lines teaches everyone to add log lines, so a docs or test-only
// change is not asked for telemetry it has no place to put.

/** A named shape that makes a change observable to an operator at runtime. */
export interface ObservabilitySignal {
  id: string;
  pattern: RegExp;
}

// Deliberately anchored on call shapes rather than bare words. `log` alone matches "login",
// "logic", "catalog" and "dialog", which is how a substring test comes to certify code that has no
// observability in it whatsoever.
export const observabilitySignals: ObservabilitySignal[] = [
  {
    id: 'structured-logging',
    pattern: /\b(?:log|logger|logging)\s*\.\s*(?:trace|debug|info|warn|warning|error|fatal)\b|\bLoggerFactory\b|\bgetLogger\s*\(|\bKotlinLogging\b|\bslf4j\b|\bconsole\s*\.\s*(?:info|warn|error)\b|\bpino\s*\(|\bwinston\b|\bstructuredLog\w*/i,
  },
  {
    id: 'metrics',
    pattern: /\bmeterRegistry\b|\bmicrometer\b|\bprometheus\b|\b(?:Counter|Timer|Gauge|DistributionSummary)\s*\.\s*builder\b|\bmetrics?\s*\.\s*(?:counter|gauge|timer|record|increment|observe|histogram)\b|@Timed\b|@Counted\b/i,
  },
  {
    id: 'tracing',
    pattern: /\btracer\b|\bstartSpan\b|\bwithSpan\b|\bSpan\s*\.\s*current\b|\bopentelemetry\b|\botel\b|\btraceId\b|\bspanId\b|@Observed\b|\bMDC\s*\.\s*put\b/i,
  },
  {
    id: 'health-endpoint',
    pattern: /\bactuator\b|\bhealthCheck\b|["'`]\/(?:health|healthz|readyz|livez|metrics)["'`]/i,
  },
];

export type ObservabilityStatus = 'PRESENT' | 'NOT_APPLICABLE' | 'MISSING';

export interface ObservabilityEvidence {
  status: ObservabilityStatus;
  reason: string;
  signals: string[];
  operationalFiles: string[];
}

// Files whose contents cannot emit anything at runtime. A migration, an OpenAPI document, a README
// or a test is not a place telemetry belongs, so a change made only of these is not asked for it.
const nonOperational =
  /(?:^|\/)(?:docs?|\.github|migrations?|db\/migration)\//i;
const nonOperationalExtension =
  /\.(?:md|markdown|txt|rst|adoc|json|ya?ml|toml|ini|properties|sql|lock|gradle|gradlew|bat|png|jpe?g|svg|ico|gitignore|gitattributes|editorconfig)$/i;
const testPath = /(?:^|\/)(?:tests?|__tests__|spec|specs|testFixtures)\//i;
const testFile = /\.(?:test|spec)\.[cm]?[jt]sx?$|(?:Test|Tests|Spec|IT)\.(?:kt|java|scala|groovy)$/;

export function isOperationalFile(path: string): boolean {
  if (nonOperational.test(path)) return false;
  if (nonOperationalExtension.test(path)) return false;
  if (testPath.test(path) || testFile.test(path)) return false;
  return true;
}

/** The newest CODE_DIFF the execution runner wrote for this task, if it wrote one at all. */
export function latestCodeDiff(artifacts: Artifact[]): { diff?: string; changedFiles?: string[] } | undefined {
  const artifact = [...artifacts].reverse().find((value) => value.kind === 'CODE_DIFF');
  if (!artifact) return undefined;
  const content = artifact.content as { diff?: unknown; changedFiles?: unknown };
  return {
    ...(typeof content?.diff === 'string' ? { diff: content.diff } : {}),
    ...(Array.isArray(content?.changedFiles) ? { changedFiles: content.changedFiles.filter((value): value is string => typeof value === 'string') } : {}),
  };
}

export function assessObservability(change: { diff?: string; changedFiles?: string[] } | undefined): ObservabilityEvidence {
  // Fail closed. Without the diff there is nothing to judge, and answering PASS here would restore
  // exactly the property that made the old gate worthless: a verdict reached without evidence.
  if (!change)
    return { status: 'MISSING', reason: 'No CODE_DIFF artifact was written for this task, so there is no implementation to inspect.', signals: [], operationalFiles: [] };

  const operationalFiles = (change.changedFiles ?? []).filter(isOperationalFile);
  // Added lines only: an observability call that a change DELETES is not evidence that the change
  // is observable, and unchanged context lines belong to code this task did not write.
  const added = (change.diff ?? '')
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .join('\n');
  const signals = observabilitySignals.filter((signal) => signal.pattern.test(added)).map((signal) => signal.id);

  if (signals.length)
    return { status: 'PRESENT', reason: `The change adds observability: ${signals.join(', ')}.`, signals, operationalFiles };
  if (!operationalFiles.length)
    return { status: 'NOT_APPLICABLE', reason: 'The change adds no operational code -- only documentation, tests, migrations or contracts -- so it has nowhere to emit telemetry from.', signals: [], operationalFiles };
  return {
    status: 'MISSING',
    reason: `The change adds operational code (${operationalFiles.slice(0, 5).join(', ')}${operationalFiles.length > 5 ? `, +${operationalFiles.length - 5} more` : ''}) but adds no structured logging, metric, span or health signal.`,
    signals: [],
    operationalFiles,
  };
}
