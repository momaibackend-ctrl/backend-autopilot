import type { Artifact, ImplementationPlan, IndependentReview, TestReport } from '../../schemas/src/index.js';
import type { Clock } from '../../core/src/ports.js';
import { requiresLayer } from '../../core/src/verification-profile.js';

export class IndependentReviewer {
  constructor(private clock:Clock){}
  review(plan:ImplementationPlan,testReport:TestReport,artifacts:Artifact[]):IndependentReview{
    const kinds=new Set(artifacts.map(a=>a.kind));
    // The generative layer is checked on its own rather than folded into testAdequacy: a PROPERTY
    // suite can be green while nothing was ever generated, and that distinction is the entire
    // reason this check exists. It reads the parsed counts, not the suite's exit code.
    const propertyRequired=requiresLayer(plan.verification,'PROPERTY');
    const checks={requirementsCoverage:plan.requirements.length>0,architectureConsistency:kinds.has('ARCHITECTURE_REVIEW'),security:plan.securityConsiderations.length>0,dataOwnership:plan.dataOwners.length>0,apiCompatibility:plan.apiChanges.length===0||kinds.has('API_CONTRACT'),migrationSafety:plan.databaseChanges.length===0||kinds.has('MIGRATION_MANIFEST'),testAdequacy:testReport.passed&&plan.testsRequired.every(type=>testReport.suites.some(s=>s.type===type&&s.passed)),propertyBasedAdequacy:!propertyRequired||(testReport.propertyBased?.status==='PASS'&&kinds.has('PROPERTY_BASED_REPORT')),errorHandling:plan.testsRequired.includes('REGRESSION'),raceConditions:plan.securityConsiderations.some(x=>/race|concurr|ownership/i.test(x)),idempotency:/idemp/i.test(plan.rollbackStrategy)||plan.databaseChanges.length===0,observability:plan.requirements.some(x=>/observ|log/i.test(x))||plan.riskLevel==='LOW',rollback:plan.rollbackStrategy.length>0};
    const failures=Object.entries(checks).filter(([,ok])=>!ok).map(([name])=>name);return {result:failures.length?'FAIL':'PASS',checks,warnings:[],failures,reviewedAt:this.clock.now()};
  }
}
