import type { ArchitectureRule, ImplementationPlan } from '../../schemas/src/index.js';

export class ArchitectureGuard {
  review(plan:ImplementationPlan,rules:ArchitectureRule[],declaredDependencies:string[]=[]){
    const violations:{ruleId:string;message:string}[]=[];
    for(const rule of rules){
      if(rule.type==='FORBID_PATH'&&plan.filesExpectedToChange.some(p=>new RegExp(rule.pattern).test(p)))violations.push({ruleId:rule.id,message:rule.message});
      if(rule.type==='REQUIRE_TEST'&&!plan.testsRequired.includes(rule.test))violations.push({ruleId:rule.id,message:rule.message});
      if(rule.type==='FORBID_DEPENDENCY'&&declaredDependencies.includes(rule.dependency))violations.push({ruleId:rule.id,message:rule.message});
      if(rule.type==='REQUIRE_SECURITY_CONSIDERATION'&&!plan.securityConsiderations.some(v=>v.toLowerCase().includes(rule.term.toLowerCase())))violations.push({ruleId:rule.id,message:rule.message});
    }
    return {passed:violations.length===0,violations,policyVersion:'1'};
  }
}
