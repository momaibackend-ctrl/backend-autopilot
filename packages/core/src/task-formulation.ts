import { classifyScope } from './scope-classification.js';
import type { TaskComponent } from '../../schemas/src/index.js';

/**
 * Why a proposed task cannot be planned as written, in terms its author can act on.
 *
 * An autonomous caller that submits an underspecified task does not find out at submission time.
 * It finds out several minutes later, when the planner produces a plan nobody asked for, or a READY
 * gate demands evidence the task was never scoped to produce -- by which point the failure looks
 * like a platform fault rather than a wording problem, and the caller retries instead of rewriting.
 * Every finding below therefore names the field, says what is wrong with it, and gives the concrete
 * change that would fix it. "Add more detail" is never an acceptable fix string here.
 */
export interface FormulationFinding {
  /** Stable machine-readable identifier, so a caller can branch on the kind of problem. */
  code: string;
  /** BLOCKING prevents planning; ADVISORY still lets the task through but makes the result worse. */
  severity: 'BLOCKING' | 'ADVISORY';
  field: 'title' | 'description' | 'requirements' | 'component' | 'externalKey';
  problem: string;
  fix: string;
}

export interface TaskFormulationInput {
  title?: string | undefined;
  description?: string | undefined;
  requirements?: string[] | undefined;
  externalKey?: string | undefined;
  component?: TaskComponent | undefined;
}

export interface TaskFormulationVerdict {
  /** True when nothing BLOCKING was found; advisory findings may still be present. */
  acceptable: boolean;
  findings: FormulationFinding[];
  /** How the scope classifier read the text, so the author can see the reading it will be planned against. */
  understoodAs: { apiChange: boolean; databaseChange: boolean };
}

// Words that carry a judgement no artifact can settle. "Fast" has no failing value; "p95 under
// 200 ms" does. This list is about measurability, not style -- it is deliberately short, because a
// formulation gate that argues about prose gets worked around rather than satisfied.
const unverifiableCue = /\b(fast|quick|slow|efficient|optimal|clean|nice|good|better|best|robust|scalable|user[- ]friendly|properly|correctly|as needed|improve|enhance)\b/i;
// Two unrelated deliverables in one task produce one branch, one review and one READY gate for work
// that has to be verified -- and reverted -- separately.
const conjunctionCue = /\b(?:and also|as well as|additionally|plus also)\b|;\s*(?:then\s+)?(?:also\s+)?(?:add|implement|create|build|expose|migrate)\b/i;
const placeholderCue = /\b(tbd|todo|fixme|xxx|placeholder|to be (?:defined|decided|determined))\b/i;
const requestsSurface = /\b(?:add|expose|create|implement)\b[^.]{0,60}\b(?:endpoint|route|api)\b/i;

const minimumDescription = 40;
const minimumRequirement = 12;

export function validateTaskFormulation(input: TaskFormulationInput): TaskFormulationVerdict {
  const findings: FormulationFinding[] = [];
  const title = (input.title ?? '').trim();
  const description = (input.description ?? '').trim();
  const requirements = (input.requirements ?? []).map((value) => value.trim()).filter((value) => value.length > 0);
  const scope = classifyScope([title, description, ...requirements].join('\n'));

  if (!title)
    findings.push({ code: 'TITLE_MISSING', severity: 'BLOCKING', field: 'title', problem: 'The task has no title.', fix: 'Give one line naming the deliverable, for example: Add idempotent POST /payments/refunds endpoint.' });
  else if (title.length < 12)
    findings.push({ code: 'TITLE_TOO_SHORT', severity: 'ADVISORY', field: 'title', problem: `The title is ${title.length} characters and does not identify a deliverable on its own.`, fix: 'Name the thing being built and where it lives, for example: Add refund endpoint to the payments module.' });

  if (!description)
    findings.push({ code: 'DESCRIPTION_MISSING', severity: 'BLOCKING', field: 'description', problem: 'The task has no description, so there is nothing to plan from.', fix: 'State three things: what exists now, what must exist after, and which existing behaviour must not change.' });
  else if (description.length < minimumDescription)
    findings.push({ code: 'DESCRIPTION_TOO_THIN', severity: 'BLOCKING', field: 'description', problem: `The description is ${description.length} characters, so any plan derived from it would be guesswork.`, fix: `Write at least ${minimumDescription} characters covering current behaviour, required behaviour, and what must stay unchanged.` });

  if (placeholderCue.test(description))
    findings.push({ code: 'DESCRIPTION_PLACEHOLDER', severity: 'BLOCKING', field: 'description', problem: 'The description still contains an unresolved placeholder (TBD, TODO, to be decided).', fix: 'Resolve the decision before submitting. An undecided requirement cannot be implemented or verified, and the gate will not be able to say why it failed.' });

  if (requirements.length === 0)
    findings.push({ code: 'REQUIREMENTS_MISSING', severity: 'BLOCKING', field: 'requirements', problem: 'The task states no requirements, so no gate can decide whether it is done.', fix: 'List each acceptance criterion as one observable statement, for example: POST /refunds returns 409 when the payment is already refunded.' });

  requirements.forEach((requirement, index) => {
    const position = index + 1;
    if (requirement.length < minimumRequirement)
      findings.push({ code: 'REQUIREMENT_TOO_SHORT', severity: 'ADVISORY', field: 'requirements', problem: `Requirement ${position} ("${requirement}") is too short to be checked.`, fix: 'State the observable outcome: which input, against which endpoint or unit, producing which result.' });
    else if (unverifiableCue.test(requirement))
      findings.push({ code: 'REQUIREMENT_NOT_VERIFIABLE', severity: 'BLOCKING', field: 'requirements', problem: `Requirement ${position} ("${requirement}") asks for a quality with no failing value, so no test can refute it.`, fix: 'Replace the judgement with a measurement or an observable behaviour, for example: p95 latency under 200 ms at 50 rps, instead of: fast.' });
    if (placeholderCue.test(requirement))
      findings.push({ code: 'REQUIREMENT_PLACEHOLDER', severity: 'BLOCKING', field: 'requirements', problem: `Requirement ${position} contains an unresolved placeholder.`, fix: 'Decide the value before submitting; a gate cannot verify a TBD.' });
  });

  if (conjunctionCue.test(description))
    findings.push({ code: 'MULTIPLE_DELIVERABLES', severity: 'ADVISORY', field: 'description', problem: 'The description reads as more than one deliverable joined together.', fix: 'Split it into separate tasks linked with DEPENDS_ON. One task produces one branch, one review and one READY gate, so two deliverables inside it cannot be verified, exported or reverted independently.' });

  // The component binding is what keeps a project from becoming an undifferentiated pile. It is
  // what makes one implementation exportable on its own, and what stops shared foundation work and
  // module work from being mixed inside a single change.
  if (!input.component)
    findings.push({ code: 'COMPONENT_MISSING', severity: 'BLOCKING', field: 'component', problem: 'The task is bound neither to the backend core nor to a named module, so its output cannot be exported on its own.', fix: 'Set component to {"kind":"CORE"} for shared foundation work, or {"kind":"MODULE","name":"<module-slug>"} for work that must stay self-contained and separately exportable.' });
  else if (input.component.kind === 'MODULE' && !input.component.name)
    findings.push({ code: 'COMPONENT_MODULE_UNNAMED', severity: 'BLOCKING', field: 'component', problem: 'The task is bound to a module, but the module has no name.', fix: 'Give the module a lowercase slug, for example: {"kind":"MODULE","name":"payments"}.' });

  if (input.externalKey !== undefined && !/^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/.test(input.externalKey))
    findings.push({ code: 'EXTERNAL_KEY_SHAPE', severity: 'ADVISORY', field: 'externalKey', problem: `externalKey "${input.externalKey}" does not follow the PREFIX-SCOPE-NN convention already used across this control plane.`, fix: 'Use an uppercase, hyphenated key such as CORE-BE-09 or PAYMENTS-API-02, so tasks sort and group predictably for a human reading the console.' });

  // The planner reads this same text, and a task that both denies and requests an HTTP surface
  // produces a plan whose READY gate then demands an API contract the task was never scoped to
  // create -- the exact shape of failure scope-classification.ts exists to prevent.
  //
  // The contradiction is the coexistence of an explicit denial with an explicit request, not the
  // classifier's final verdict: the classifier weighs the evidence and picks a side, so by the time
  // it has answered, the fact that the text argued with itself is exactly what has been lost.
  if (scope.api.negatedEvidence.length > 0 && requestsSurface.test(description))
    findings.push({
      code: 'SCOPE_API_CONTRADICTION',
      severity: 'BLOCKING',
      field: 'description',
      problem: 'The description both asks for an HTTP surface and denies changing one, so it cannot be planned either way.',
      fix: `Say which is true, then remove the other statement. The denial reads: ${scope.api.negatedEvidence.join('; ')}. It currently classifies as ${scope.api.intended ? 'an API change' : 'no API change'}.`,
    });

  return {
    acceptable: !findings.some((finding) => finding.severity === 'BLOCKING'),
    findings,
    understoodAs: { apiChange: scope.api.intended, databaseChange: scope.database.intended },
  };
}
