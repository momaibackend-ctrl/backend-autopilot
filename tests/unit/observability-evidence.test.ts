import { describe, expect, it } from 'vitest';
import { IndependentReviewer } from '../../packages/execution-engine/src/index.js';
import { assessObservability } from '../../packages/execution-engine/src/observability-evidence.js';
import { systemClock } from '../../packages/core/src/ports.js';
import type { Artifact, ImplementationPlan, TestReport } from '../../packages/schemas/src/index.js';

// The bug this pins down was deterministic and unfixable from the outside. The old check was
// `plan.requirements.some(x=>/observ|log/i.test(x)) || plan.riskLevel==='LOW'`, so a task whose
// planner had set MEDIUM risk and whose requirements happened not to contain the substrings
// "observ" or "log" evaluated to `false || false` on every attempt. Adding structured logging,
// metrics, spans and telemetry tests to the implementation could not change the answer, because
// none of them were inputs to it -- while a task that shipped no observability at all passed on
// the strength of one word in its plan.

const codeDiff = (diff: string, changedFiles: string[]): Artifact =>
  ({ id: 'CODE_DIFF-1', projectId: 'p', taskId: 't', kind: 'CODE_DIFF', schemaVersion: '1', content: { diff, changedFiles }, contentHash: 'h', status: 'AVAILABLE', createdAt: systemClock.now() }) as unknown as Artifact;
const artifact = (kind: Artifact['kind']): Artifact =>
  ({ id: `${kind}-1`, projectId: 'p', taskId: 't', kind, schemaVersion: '5', content: {}, contentHash: 'h', status: 'AVAILABLE', createdAt: systemClock.now() }) as unknown as Artifact;

describe('observability evidence', () => {
  it('reads an added logging call as evidence', () => {
    const evidence = assessObservability({ diff: '+++ b/src/Notes.kt\n+  log.info("note.created", mapOf("status" to status))', changedFiles: ['src/Notes.kt'] });
    expect(evidence).toMatchObject({ status: 'PRESENT', signals: ['structured-logging'] });
  });

  it('reads added metrics and tracing as evidence', () => {
    expect(assessObservability({ diff: '+ meterRegistry.counter("notes.created").increment()', changedFiles: ['src/Notes.kt'] }).status).toBe('PRESENT');
    expect(assessObservability({ diff: '+ tracer.startSpan("notes.create").use { }', changedFiles: ['src/Notes.kt'] }).status).toBe('PRESENT');
  });

  it('does not accept a word that merely contains "log"', () => {
    const evidence = assessObservability({ diff: '+ fun login(catalog: Dialog) = logicFor(catalog)', changedFiles: ['src/Auth.kt'] });
    expect(evidence.status).toBe('MISSING');
  });

  it('does not accept observability the change removes', () => {
    const evidence = assessObservability({ diff: '- log.info("note.created")\n+ return service.create(owner, body)', changedFiles: ['src/Notes.kt'] });
    expect(evidence.status).toBe('MISSING');
  });

  it('asks nothing of a change with no operational code', () => {
    const evidence = assessObservability({ diff: '+ # Notes\n+ a doc line', changedFiles: ['docs/notes.md', 'migrations/003_notes.sql', 'src/__tests__/notes.test.ts'] });
    expect(evidence.status).toBe('NOT_APPLICABLE');
  });

  it('fails closed when execution wrote no CODE_DIFF to inspect', () => {
    expect(assessObservability(undefined).status).toBe('MISSING');
  });
});

describe('independent review observability gate', () => {
  const basePlan = (overrides: Partial<ImplementationPlan>): ImplementationPlan =>
    ({
      taskId: crypto.randomUUID(),
      goal: 'Public flow API',
      requirements: ['Expose the seven-period onboarding flow'],
      affectedDomains: ['flow'],
      dataOwners: ['user'],
      filesExpectedToChange: ['src/Flow.kt'],
      databaseChanges: [],
      apiChanges: [],
      events: [],
      securityConsiderations: ['Ownership is enforced on every read'],
      dependencies: [],
      testsRequired: ['UNIT', 'REGRESSION'],
      rollbackStrategy: 'Revert the task commit; the change is idempotent',
      openQuestions: [],
      riskLevel: 'MEDIUM',
      approved: false,
      createdAt: systemClock.now(),
      ...overrides,
    }) as ImplementationPlan;
  const report: TestReport = { passed: true, suites: [{ type: 'UNIT', passed: true }, { type: 'REGRESSION', passed: true }] } as unknown as TestReport;
  const review = (plan: ImplementationPlan, diff: Artifact | undefined) =>
    new IndependentReviewer(systemClock).review(plan, report, [artifact('ARCHITECTURE_REVIEW'), ...(diff ? [diff] : [])]);

  it('passes a MEDIUM-risk plan whose requirements never say "log", when the code is observable', () => {
    const outcome = review(basePlan({}), codeDiff('+ log.info("flow.period_advanced", mapOf("period" to period))', ['src/Flow.kt']));
    expect(outcome.checks['observability']).toBe(true);
    expect(outcome.failures).not.toContain('observability');
  });

  it('fails a LOW-risk plan that ships no observability, which risk level alone used to wave through', () => {
    const outcome = review(basePlan({ riskLevel: 'LOW' }), codeDiff('+ fun advance(period: Int) = period + 1', ['src/Flow.kt']));
    expect(outcome.checks['observability']).toBe(false);
    expect(outcome.failures).toContain('observability');
  });

  it('records the reason for its verdict instead of returning a bare boolean', () => {
    const outcome = review(basePlan({}), codeDiff('+ fun advance(period: Int) = period + 1', ['src/Flow.kt']));
    expect(outcome.warnings.join(' ')).toContain('observability MISSING');
    expect(outcome.warnings.join(' ')).toContain('src/Flow.kt');
  });
});
