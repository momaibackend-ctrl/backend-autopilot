import type { ImplementationPlan, VerificationDecision, VerificationLayer, VerificationProfile } from "../../schemas/src/index.js";
import { classifyScope, clauses, type ScopeClassification } from "./scope-classification.js";

// Which verification layers a task needs, decided from the task's own text before a line of it is
// implemented.
//
// The gap this closes is concrete. CORE-BE-01..21 shipped with unit, domain, contract, integration,
// migration, security and regression tests, real PostgreSQL/Redis/MinIO coverage, and every one of
// those suites green -- and not one generative test anywhere in the core. The layers that ran
// answered "does this behave correctly on the inputs a developer thought to write down?". Nothing
// in the pipeline ever asked whether a rollout bucketing rule stays monotonic across every
// userId x threshold pair, or whether startOfLocalDay <= instant < endOfLocalDay survives a DST
// boundary in an arbitrary zone. Repository and integration tests cannot answer that question --
// they cover a different class of risk entirely -- so the absence went unnoticed until all 21 tasks
// were already merged and only a human reading the final result caught it.
//
// The fix is not "Kotlin implies jqwik". Property-based testing earns nothing on CRUD, DTO mapping,
// a thin adapter or a static registry, and demanding it there would teach everyone to route around
// the gate. It is required where an algorithmic invariant exists, refused where none does, and --
// the part that makes the gate trustworthy -- the refusal is recorded with its reason instead of
// being silently skipped.

export const VERIFICATION_PROFILE_VERSION = "1";

/** A named reason a task's code carries an algorithmic invariant worth generating inputs against. */
export interface PropertyTrigger {
  id: string;
  pattern: RegExp;
  reason: string;
}

export const propertyTriggers: PropertyTrigger[] = [
  {
    id: "state-machine",
    pattern: /\bstate[- ]machines?\b|\blifecycles?\b|\bstate transitions?\b|\bstatus transitions?\b|\btransition (?:table|rules?|graph)\b|\bworkflow states?\b/i,
    reason: "state-machine: a lifecycle admits input orderings no hand-written example enumerates",
  },
  {
    id: "time/DST",
    pattern: /\btime[- ]?zones?\b|\bdst\b|\bdaylight\b|\butc\b|\binstants?\b|\bcalendar\b|\bstart of (?:the )?(?:local )?day\b|\bdate ranges?\b|\brecurrence\b|\bscheduling\b|\bcron\b/i,
    reason: "time/DST: local-day and interval invariants break only in zones and on dates nobody lists by hand",
  },
  {
    id: "numeric",
    pattern: /\bcurrenc(?:y|ies)\b|\bmoney\b|\bprices?\b|\bamounts?\b|\brounding\b|\bpercent(?:age)?s?\b|\bdecimals?\b|\barithmetic\b|\bquotas?\b|\bbudgets?\b|\bbilling\b/i,
    reason: "numeric: rounding and accumulation errors surface at magnitudes examples rarely reach",
  },
  {
    id: "deterministic-bucketing",
    pattern: /\bhash(?:ing|ed|es)?\b|\bbucket(?:ing|s|ed)?\b|\brollouts?\b|\bfeature flags?\b|\bshard(?:ing|s)?\b|\bdeterministic\b|\bsampling\b|\bpartition(?:ing|s)?\b/i,
    reason: "deterministic hashing/bucketing: monotonicity and stability are mathematical claims over the whole input space",
  },
  {
    id: "idempotency",
    pattern: /\bidempoten(?:t|cy|ce)\b|\bdeduplicat(?:e|ion|ing)\b|\bde-?dup\b|\bexactly[- ]once\b|\bat[- ]least[- ]once\b|\breplay(?:ed|ing)?\b|\bretr(?:y|ies|ied)\b/i,
    reason: "idempotency/deduplication: f(f(x)) equals f(x) has to hold for every input, not for three",
  },
  {
    id: "parsing",
    pattern: /\bpars(?:e|es|er|ers|ing|ed)\b|\bserial(?:ize|izes|ization|izer|ized)\b|\bdeserial\w*\b|\bencod(?:e|es|ing|ed)\b|\bdecod(?:e|es|ing|ed)\b|\bcodec\b|\bnormali[sz]\w+\b|\bround[- ]?trips?\b/i,
    reason: "parsers/serializers: round-trip equality is the definition of correctness here",
  },
  {
    id: "ordering",
    pattern: /\border(?:ing|ed)\b|\bsort(?:ing|ed)?\b|\bmonotonic\w*\b|\bboundar(?:y|ies)\b|\bbounds\b|\bclamp\w*\b|\bpagination\b|\bcursors?\b|\bpriorit(?:y|ies|isation|ization)\b/i,
    reason: "ordering/monotonicity/bounds: the claim is universally quantified over inputs",
  },
  {
    id: "algorithmic-transform",
    pattern: /\bmerg(?:e|es|ing)\b|\bdiff(?:ing|s)?\b|\bgraphs?\b|\btopological\b|\bconflict resolution\b|\baggregat\w+\b|\brecursi\w+\b|\btraversals?\b/i,
    reason: "complex data transformation: the output space is far too large to sample by hand",
  },
  {
    id: "declared-invariant",
    pattern: /\binvariants?\b|\bproperty[- ]based\b|\bgenerative tests?\b|\bmust always\b|\bfor (?:all|every) (?:input|value|case)\b/i,
    reason: "the task states an invariant in so many words, which is exactly what a property encodes",
  },
];

// Shapes where generating a thousand inputs buys nothing: the behaviour is a straight-line mapping
// with no invariant to violate. Recorded so a NOT_APPLICABLE verdict can say which shape it matched.
const propertyExclusions: { id: string; pattern: RegExp }[] = [
  { id: "crud", pattern: /\bcrud\b|\bcreate[,/ ]read[,/ ]update\b/i },
  { id: "dto-mapping", pattern: /\bdtos?\b|\bmapp(?:er|ing) (?:layer|only)\b/i },
  { id: "thin-adapter", pattern: /\bthin adapter\b|\bpass[- ]through adapter\b|\bwrappers? (?:around|over)\b/i },
  { id: "static-registry", pattern: /\bstatic (?:registry|catalog|lookup|table)\b|\bconstants? (?:file|table)\b/i },
];

function decide(layer: VerificationLayer, required: boolean, reasons: string[]): VerificationDecision {
  return {
    layer,
    status: required ? "REQUIRED" : "NOT_APPLICABLE",
    reasons: reasons.length ? reasons : ["no signal in the task text argued for this layer"],
  };
}

/** Every property trigger the task text fires, in declaration order. */
export function propertyReasons(text: string): string[] {
  const parts = clauses(text);
  return propertyTriggers
    .filter((trigger) => parts.some((clause) => trigger.pattern.test(clause)))
    .map((trigger) => trigger.reason);
}

function propertyDecision(text: string): VerificationDecision {
  const reasons = propertyReasons(text);
  if (reasons.length) return decide("PROPERTY", true, reasons);
  const excluded = propertyExclusions.find((exclusion) => exclusion.pattern.test(text));
  return decide("PROPERTY", false, [
    excluded
      ? `${excluded.id}: no algorithmic invariant to generate against`
      : "no state machine, time/DST, numeric, hashing/bucketing, idempotency, parsing, ordering or transformation signal; generated inputs would only restate the unit tests",
  ]);
}

function truncate(value: string) {
  return value.length > 160 ? `${value.slice(0, 157)}...` : value;
}

export function buildVerificationProfile(
  text: string,
  scope: ScopeClassification = classifyScope(text),
): VerificationProfile {
  const apiRefusal = scope.api.negatedEvidence[0];
  const dbRefusal = scope.database.negatedEvidence[0];
  return {
    profileVersion: VERIFICATION_PROFILE_VERSION,
    decisions: [
      decide("UNIT", true, ["every task's own logic is verified before anything else runs"]),
      decide("INTEGRATION", true, ["persisted state and adapters are exercised against real dependencies"]),
      propertyDecision(text),
      decide("CONTRACT", scope.api.mentioned, scope.api.mentioned ? ["the task describes a contract surface, internal or public"] : []),
      decide("MIGRATION", scope.database.mentioned, scope.database.mentioned ? ["the task describes schema or migration work"] : []),
      decide("SECURITY", true, ["authorization and ownership are enforced on every task"]),
      decide("REGRESSION", true, ["previously verified behaviour has to survive this change"]),
      // The two evidence layers below are what the READY gate actually demands artifacts for, and
      // they follow intent rather than mention -- that separation is the whole negative-scope fix.
      decide(
        "HTTP_CONTRACT",
        scope.api.intended,
        scope.api.intended
          ? scope.api.evidence.slice(0, 2).map(truncate)
          : [apiRefusal ? `the task rules a public HTTP surface out: "${truncate(apiRefusal)}"` : "the task describes no HTTP surface"],
      ),
      decide(
        "MIGRATION_MANIFEST",
        scope.database.intended,
        scope.database.intended
          ? scope.database.evidence.slice(0, 2).map(truncate)
          : [dbRefusal ? `the task rules a schema change out: "${truncate(dbRefusal)}"` : "the task describes no schema change"],
      ),
    ],
  };
}

export function layerStatus(profile: VerificationProfile | undefined, layer: VerificationLayer) {
  return profile?.decisions.find((decision) => decision.layer === layer)?.status;
}

export function requiresLayer(profile: VerificationProfile | undefined, layer: VerificationLayer) {
  return layerStatus(profile, layer) === "REQUIRED";
}

/** The executable suites the profile demands, in the canonical order the plan records them. */
export function requiredSuites(profile: VerificationProfile): ImplementationPlan["testsRequired"] {
  const order: ImplementationPlan["testsRequired"] = ["UNIT", "INTEGRATION", "PROPERTY", "CONTRACT", "MIGRATION", "SECURITY", "REGRESSION"];
  return order.filter((suite) => requiresLayer(profile, suite));
}
