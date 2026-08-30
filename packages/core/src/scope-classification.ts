// What a task actually intends to touch, read from its own words.
//
// The planner used to answer this with a bare keyword scan, and the scan could not tell "add a REST
// endpoint" from "do not add public HTTP APIs". Every task that ruled an API out in writing still
// got `apiChanges` in its plan, and the READY gate then demanded an API_CONTRACT artifact for a
// surface the task was explicitly forbidden to create. CORE-BE-07, 09 and 10 each burned a blind
// repair loop on it; CORE-QA-02 hit the same wall on both axes at once (MISSING_API_CONTRACT and
// MISSING_MIGRATION_MANIFEST) for a task whose requirements forbid public HTTP APIs and involve no
// migration at all.
//
// An explicit INTERNAL_ONLY declaration was the first fix, but it only ever covered the API axis
// and only when an author remembered the exact word. Negation is the general form of that signal:
// a clause that mentions an API while being governed by "do not", "without" or "rather than" is
// evidence AGAINST the change, and counting it as evidence for one is the bug.

/** One axis of intent, with the clauses that argued for and against it kept for the audit trail. */
export interface ScopeSignal {
  /** The subject came up at all -- enough to justify extra test coverage, never enough to demand evidence. */
  mentioned: boolean;
  /** The task actually asks for this change; only this drives required gate evidence. */
  intended: boolean;
  /** Clauses that read as a genuine request for the change. */
  evidence: string[];
  /** Clauses that mention the subject only to rule it out. */
  negatedEvidence: string[];
  /** Clauses that name the subject as test coverage or evidence rather than as work to do. */
  verificationOnlyEvidence: string[];
}

export interface ScopeClassification {
  api: ScopeSignal;
  database: ScopeSignal;
}

// Word-bounded so "restart" -- present in the standard dirty-workspace-recovery requirement on
// every single task -- cannot masquerade as a REST mention.
// Hyphen-aware boundaries, not plain \b. A hyphenated compound is one lexeme: "direct-table-access"
// names a test rule, not a database table, and "rest-parameter" is not a REST surface. \b treats
// the hyphen as a boundary and so reads the fragment as the whole word, which is how a task that
// touches no database at all was made to owe a MIGRATION_MANIFEST.
const apiPattern = /(?<![\w-])(?:apis?|rest|endpoints?|openapi|http)(?![\w-])/i;

// `schema` is deliberately absent: Zod schemas, JSON schemas and artifact schemas appear in nearly
// every control-plane task and have nothing to do with a database. It is admitted below only in a
// clause that also carries real database vocabulary.
const databasePattern = /(?<![\w-])(?:database|postgres(?:ql)?|migrations?|sql|tables?|columns?)(?![\w-])/i;
const qualifiedSchemaPattern = /(?<![\w-])(?:database|db|table|sql|postgres(?:ql)?)\s+schema(?![\w-])|(?<![\w-])schema\s+(?:migrations?|changes?)(?![\w-])/i;

// A cue that appears BEFORE the subject in the same clause turns a mention into a refusal. After
// the subject it means something else entirely ("add a REST endpoint; it is not optional"), so
// position is part of the rule rather than a detail of the regex.
const negationCue =
  /\b(?:do not|does not|don't|doesn't|did not|never|no|not|without|avoid(?:ing)?|refrain from|must not|should not|shall not|cannot|instead of|rather than|neither|nor|excluding|out of scope|outside the scope)\b/i;

// Narrow on purpose. "Preserve existing REST paths" is a promise to leave the surface alone; a
// broader "existing" match would also swallow "add an endpoint to the existing API", which is a
// genuine request.
const preservationCue = /\b(?:preserve[sd]?|preserving|unchanged|do not change|no changes? to|backward[- ]compatible|backwards[- ]compatible)\b/i;

/** The deliberate, author-written declaration that a contract stays internal. Overrides everything. */
const internalOnlyCue = /\binternal[_\- ]?only\b/i;

// A clause can name an API or a database while asking for neither. CORE-QA-02's requirements say
// "retain and rerun all existing ... PostgreSQL migration/repository ... tests" -- a list of test
// kinds to re-run -- and "treat HTTP/load/E2E evidence as supplemental", a statement about which
// evidence counts. Read as requests, those two clauses are exactly what made the task owe a
// migration manifest and an API contract it was never meant to produce, and plain negation does
// not catch them: neither clause contains a refusal, they simply are not asking for anything.
//
// The guard is the implementation verb. A clause that talks about tests, coverage or evidence
// without one is describing verification, not work; "add a REST endpoint and its contract tests"
// keeps its verb and so keeps reading as intent.
const verificationContext = /\btests?\b|\btested\b|\bsuites?\b|\bcoverage\b|\bevidence\b|\bartifacts?\b|\bci\b|\bcriterion\b/i;
const implementationVerb =
  /\b(?:add|adds|adding|implement|implements|implementing|expose|exposes|exposing|create|creates|creating|introduce|introduces|introducing|build|builds|building|define|defines|defining|write|writes|writing|provide|provides|providing|publish|publishes|publishing|migrate|migrates|migrating)\b/i;

/** Sentence and list-item boundaries; a requirement bullet is its own clause. */
export function clauses(text: string): string[] {
  return text
    .split(/(?<=[.;:!?])\s+|\r?\n+|\s+[-*\u2022]\s+/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function negatesSubject(clause: string, subjectIndex: number): boolean {
  const before = clause.slice(0, subjectIndex);
  return negationCue.test(before) || preservationCue.test(clause);
}

function signal(text: string, matches: (clause: string) => number, override: boolean): ScopeSignal {
  const evidence: string[] = [];
  const negatedEvidence: string[] = [];
  const verificationOnlyEvidence: string[] = [];
  for (const clause of clauses(text)) {
    const index = matches(clause);
    if (index < 0) continue;
    if (override || negatesSubject(clause, index)) negatedEvidence.push(clause);
    else if (verificationContext.test(clause) && !implementationVerb.test(clause)) verificationOnlyEvidence.push(clause);
    else evidence.push(clause);
  }
  const mentioned = evidence.length + negatedEvidence.length + verificationOnlyEvidence.length > 0;
  return { mentioned, intended: evidence.length > 0, evidence, negatedEvidence, verificationOnlyEvidence };
}

function apiIndex(clause: string): number {
  return clause.search(apiPattern);
}

// "database adapter", "postgres driver", "connection url" name a piece of code, and
// "postgresql://" names a URL scheme. None of them is a schema change. What follows the keyword
// decides which is meant, and without this a task about fixing a connection-string parser was made
// to owe a MIGRATION_MANIFEST -- twice: once for its description, once for the requirement that
// enumerates the URL spellings it has to accept.
const componentQualifier = /^(?::\/\/)|^[\s-]*(?:adapters?|drivers?|clients?|connections?|urls?|uris?|pools?|settings?|providers?|dialects?|credentials?|strings?|libraries|library)\b/i;

function databaseIndex(clause: string): number {
  for (const match of clause.matchAll(new RegExp(databasePattern.source, "gi"))) {
    const index = match.index ?? -1;
    if (index < 0) continue;
    const after = clause.slice(index + match[0].length);
    if (componentQualifier.test(after)) continue;
    return index;
  }
  return clause.search(qualifiedSchemaPattern);
}

export function classifyScope(text: string): ScopeClassification {
  return {
    api: signal(text, apiIndex, internalOnlyCue.test(text)),
    database: signal(text, databaseIndex, false),
  };
}
