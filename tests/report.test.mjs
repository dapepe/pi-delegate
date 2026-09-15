import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAssessment, markdownReport } from '../scripts/report.mjs';
import { costSummary } from '../scripts/lib.mjs';
const report=()=>({run_id:'test-run',objective:'Review fixture',costs:costSummary([{billed_usd:0.12},{estimate_usd:0.03},{}]),agents:[{id:'review',role:'reviewer',mode:'read',status:'completed',elapsed_seconds:1,model:{requested_model:'example/model',resolved_model:'example/model',provider:'openrouter',requested_effort:'xhigh',effective_pi_effort:'max'},costs:costSummary([{billed_usd:0.12}]),coverage:{reads:[],searches:[]},submission:{summary:'One finding',findings:[{id:'F1',title:'Fixture issue',severity:'high',confidence:'medium',file:'a.js',line:1,evidence:'test evidence'}]}}]});
const assessment=()=>({run_id:'test-run',assessed_by:'Codex',overall_value:'Useful after independently validating F1',workers:[{agent_id:'review',usefulness_0_to_3:2,reason:'Found a reproducible bug'}],decisions:[{agent_id:'review',finding_id:'F1',decision:'accept',reason:'Confirmed',validation:'Codex ran the reproduction',integration:'Codex applied a minimal change'}]});
test('unassessed reports never invent usefulness, free requests, or completed tests',()=>{const s=markdownReport(report());assert.match(s,/Not assessed by Codex/);assert.match(s,/Unpriced requests: \*\*1\*\*/);assert.match(s,/\$0.120000/);assert.match(s,/\$0.030000/);assert.match(s,/cannot execute tests/);});
test('only a complete run-specific Codex assessment is accepted',()=>{assert.deepEqual(validateAssessment(assessment(),report()),assessment());for(const patch of [{run_id:'other'},{assessed_by:'worker'},{workers:[]},{decisions:[]}])assert.throws(()=>validateAssessment({...assessment(),...patch},report()));});
test('assessment requires valid score, independent validation and actual finding references',()=>{for(const modify of [a=>a.workers[0].usefulness_0_to_3=4,a=>a.decisions[0].finding_id='invented',a=>a.decisions[0].validation='',a=>a.decisions.push({...a.decisions[0]})]){const a=assessment();modify(a);assert.throws(()=>validateAssessment(a,report()));}});
test('failed workers also need explicit value judgments',()=>{const r=report();r.agents.push({id:'failed',status:'error'});assert.throws(()=>validateAssessment(assessment(),r));const a=assessment();a.workers.push({agent_id:'failed',usefulness_0_to_3:0,reason:'No reliable result'});assert.doesNotThrow(()=>validateAssessment(a,r));});
test('rendering does not mutate raw facts or silently mark candidates integrated',()=>{const r=report(),before=JSON.stringify(r);r.agents[0].changes=[{file:'a.js'}];const copy=JSON.stringify(r),s=markdownReport(r,assessment());assert.match(s,/runner did not integrate/);assert.match(s,/Codex: accept/);assert.equal(JSON.stringify(r),copy);assert.notEqual(copy,before);});

test('Claude Code assessments match the recorded host and retain host-specific cost exclusion',()=>{
  const r=report();r.orchestrator='claude-code';const a=assessment();a.assessed_by='Claude Code';assert.doesNotThrow(()=>validateAssessment(a,r));
  const s=markdownReport(r,a);assert.match(s,/excludes Claude Code/);assert.match(s,/Claude Code: accept/);assert.throws(()=>validateAssessment(assessment(),r));
  r.orchestrator='other-agent';assert.throws(()=>markdownReport(r,a));
});
