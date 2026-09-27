import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { validateAssessment, validateAssessmentShape, assessmentSchema, markdownReport } from '../scripts/report.mjs';
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

function syntheticV2() {
  const r = report(), a = assessment(), artifact = 'a'.repeat(64);
  r.agents[0].artifact_identity = { artifact_sha256: artifact };
  r.evaluation = { workers: [{ agent_id: 'review', criteria: [{ id: 'behavior', requirement: 'Check the synthetic behavior.' }] }] };
  a.schema_version = 2;
  Object.assign(a.workers[0], { quality_0_to_3: 2, quality_reason: 'Synthetic validated result.', artifact_sha256: artifact, integration_status: 'accepted_modified', criterion_results: [{ id: 'behavior', result: 'passed', evidence: ['Synthetic host execution result.'] }] });
  return { r, a };
}

test('assessment diagnostics identify the exact enum field, supplied value and allowed values', () => {
  const cases = [
    [a => a.workers[0].criterion_results[0].result = 'pass', /assessment\.workers\[0\]\.criterion_results\[0\]\.result: received "pass"; expected one of passed, failed, inconclusive, not_run/],
    [a => a.workers[0].integration_status = 'integrated_with_changes', /assessment\.workers\[0\]\.integration_status: received "integrated_with_changes"; expected one of .*accepted_modified.*accepted_unmodified/],
    [a => a.decisions[0].decision = 'yes', /assessment\.decisions\[0\]\.decision: received "yes"; expected one of accept, reject, defer/]
  ];
  for (const [change, expected] of cases) {
    const { a, r } = syntheticV2(); change(a);
    assert.throws(() => validateAssessment(a, r), expected);
  }
});

test('assessment evidence diagnostics state array and string bounds with field paths', () => {
  const { a, r } = syntheticV2();
  a.workers[0].criterion_results[0].evidence = Array(11).fill('Synthetic evidence');
  assert.throws(() => validateAssessment(a, r), /criterion_results\[0\]\.evidence: expected an array with at most 4 nonempty strings, each at most 1200 characters/);
  a.workers[0].criterion_results[0].evidence = ['x'.repeat(1201)];
  assert.throws(() => validateAssessment(a, r), /criterion_results\[0\]\.evidence\[0\].*max 1200 characters/);
});

test('local shape validation needs no run but never replaces artifact and criterion verification', () => {
  const { a, r } = syntheticV2();
  const before = structuredClone(a);
  assert.deepEqual(validateAssessmentShape(a), a);
  assert.deepEqual(a, before);
  assert.deepEqual(validateAssessment(a, r), a);
  a.run_id = 'different-run';
  assert.doesNotThrow(() => validateAssessmentShape(a));
  assert.throws(() => validateAssessment(a, r), /assessment\.run_id.*expected this run/);
  a.run_id = r.run_id;
  a.workers[0].artifact_sha256 = 'b'.repeat(64);
  assert.doesNotThrow(() => validateAssessmentShape(a));
  assert.throws(() => validateAssessment(a, r), /artifact_sha256.*does not match/);
  a.workers[0].artifact_sha256 = 'a'.repeat(64);
  a.workers[0].criterion_results[0].id = 'not-preregistered';
  assert.throws(() => validateAssessment(a, r), /criterion_results\[0\]\.id.*expected one of behavior/);
});

test('assessment shape rejects malformed objects and exports all documented enums and bounds', () => {
  for (const value of [null, [], { ...assessment(), workers: [null] }, { ...assessment(), decisions: [null] }]) assert.throws(() => validateAssessmentShape(value), /expected an object/);
  const schema = assessmentSchema(), worker = schema.allOf[0].then.properties.workers.items;
  assert.deepEqual(worker.properties.criterion_results.items.properties.result.enum, ['passed', 'failed', 'inconclusive', 'not_run']);
  assert.equal(worker.properties.criterion_results.items.properties.evidence.maxItems, 4);
  assert.equal(worker.properties.criterion_results.items.properties.evidence.items.maxLength, 1200);
  assert.ok(worker.properties.integration_status.enum.includes('accepted_modified'));
  assert.match(schema.description, /Use validateAssessment against the saved run/);
  assert.equal(validateAssessment({ ...assessment(), schema_version: null }, report()).schema_version, 1);
});

test('assessment CLI emits a schema and validates shape or run without inference or file writes', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-assessment-cli-'));
  try {
    const cli = fileURLToPath(new URL('../scripts/pi.mjs', import.meta.url));
    const guard = path.join(base, 'no-network.mjs'), assessmentFile = path.join(base, 'assessment.json');
    fs.writeFileSync(guard, 'globalThis.fetch = async () => { throw new Error("Synthetic test forbids all network"); };\n');
    fs.writeFileSync(assessmentFile, JSON.stringify(assessment()));
    fs.writeFileSync(path.join(base, 'report.json'), JSON.stringify(report()));
    const before = new Map(fs.readdirSync(base).map(name => [name, fs.readFileSync(path.join(base, name), 'utf8')]));
    const run = args => spawnSync(process.execPath, ['--import', guard, cli, ...args], { cwd: base, encoding: 'utf8' });
    const schema = run(['assessment-schema']);
    assert.equal(schema.status, 0, schema.stderr);
    assert.equal(JSON.parse(schema.stdout).title, 'Pi host assessment (shape only)');
    for (const [options, expected] of [[[], 'shape_only'], [['--out', base], 'run_and_artifact_bound']]) {
      const result = run(['validate-assessment', '--assessment', assessmentFile, ...options]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).validation, expected);
    }
    assert.deepEqual(new Map(fs.readdirSync(base).map(name => [name, fs.readFileSync(path.join(base, name), 'utf8')])), before);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
