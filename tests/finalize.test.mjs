import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { finalizeRun } from '../scripts/finalize.mjs';
import { initLearning, recordLearning } from '../scripts/learning.mjs';
import { beginRunInventory, readRunInventory, updateRunInventory } from '../scripts/insights-store.mjs';
import { costSummary, sha256 } from '../scripts/lib.mjs';

const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
function fixture({ learning = false, status = 'completed' } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-finalize-'));
  const repo = path.join(base, 'repo'), out = path.join(base, 'run');
  fs.mkdirSync(repo); fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# Instructions\n');
  if (learning) initLearning(repo, { mode: 'propose' });
  fs.mkdirSync(out, { mode: 0o700 });
  const report = {
    schema_version: 2, run_id: 'run-finalize', mode: 'pi_sdk', created_at: '2026-09-22T10:00:00.000Z', finished_at: '2026-09-22T10:01:00.000Z',
    source_repo: repo, orchestrator: 'codex', orchestrator_model: 'fixture-host', orchestrator_version: 'fixture-1', skill_version: '1.5.0', sdk_version_target: '0.85.1',
    objective: 'Synthetic finalization fixture', agents: [{ id: 'worker', role: 'sparring-partner', mode: 'read', status,
      model: { provider: 'openrouter', requested_model: 'fixture/model', resolved_model: 'fixture/model', canonical_slug: 'fixture/model', requested_effort: 'xhigh', effective_pi_effort: 'xhigh' },
      submission: status === 'completed' ? { summary: 'Synthetic submission', findings: [] } : { summary: 'Synthetic partial submission', findings: [], completion: 'partial', remaining_work: ['Synthetic remaining work'] },
      costs: costSummary([]), policy_violations: [] }], costs: costSummary([]), evaluation: null
  };
  const plan = { repo_root: repo, orchestrator: 'codex', policy: { preferred_provider: 'openrouter' }, agents: [{ id: 'worker', role: 'sparring-partner', task: 'Synthetic', model: 'fixture/model', provider: 'openrouter', mode: 'read', effort: 'xhigh', read_files: ['AGENTS.md'], write_files: [] }] };
  const snapshot = { repo_root: repo, files: {} };
  const usage = { schema_version: 1, requests: [], costs: costSummary([]) };
  json(path.join(out, 'report.json'), report); json(path.join(out, 'plan.json'), plan); json(path.join(out, 'snapshot.json'), snapshot); json(path.join(out, 'usage.json'), usage);
  const assessment = value => ({ run_id: 'run-finalize', assessed_by: 'Codex', overall_value: value, workers: [{ agent_id: 'worker', usefulness_0_to_3: 1, reason: 'Synthetic host assessment' }], decisions: [] });
  return { base, repo, out, report, plan, snapshot, usage, assessment, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test('missing assessment can be repaired, while stale assessment retries preserve the accepted fingerprint', () => {
  const f = fixture();
  try {
    const missing = finalizeRun(f.out);
    assert.equal(missing.exit_code, 4);
    const assessmentA = path.join(f.base, 'assessment-a.json'); json(assessmentA, f.assessment('A'));
    const accepted = finalizeRun(f.out, { assessmentPath: assessmentA });
    assert.equal(accepted.exit_code, 0);
    const acceptedFile = fs.readFileSync(path.join(f.out, 'assessment.json'), 'utf8');
    const assessmentB = path.join(f.base, 'assessment-b.json'); json(assessmentB, f.assessment('B'));
    const stale = finalizeRun(f.out, { assessmentPath: assessmentB });
    assert.equal(stale.exit_code, 4);
    assert.equal(stale.assessment.status, 'stale');
    assert.equal(stale.fingerprint, accepted.fingerprint);
    assert.notEqual(stale.observed_fingerprint, accepted.fingerprint);
    assert.equal(fs.readFileSync(path.join(f.out, 'assessment.json'), 'utf8'), acceptedFile);
    const repeated = finalizeRun(f.out, { assessmentPath: assessmentB });
    assert.equal(repeated.exit_code, 4);
    assert.equal(repeated.fingerprint, accepted.fingerprint);
    assert.equal(fs.readFileSync(path.join(f.out, 'assessment.json'), 'utf8'), acceptedFile);
    const revised = finalizeRun(f.out, { assessmentPath: assessmentB, revise: true });
    assert.equal(revised.exit_code, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.out, 'assessment.json'))).overall_value, 'B');
  } finally { f.cleanup(); }
});

test('a report mutation after parsing cannot produce a reusable mismatched receipt', () => {
  const f = fixture({ status: 'completed' });
  const originalOpen = fs.openSync;
  let mutated = false;
  try {
    const assessment = path.join(f.base, 'assessment-race.json'); json(assessment, f.assessment('race'));
    fs.openSync = function (filename, ...args) {
      if (!mutated && filename === path.join(f.out, 'plan.json')) {
        mutated = true;
        fs.openSync = originalOpen;
        const changed = structuredClone(f.report);
        changed.agents[0].status = 'partial';
        changed.agents[0].submission.completion = 'partial';
        json(path.join(f.out, 'report.json'), changed);
      }
      return originalOpen.call(fs, filename, ...args);
    };
    const first = finalizeRun(f.out, { assessmentPath: assessment, requireComplete: true });
    fs.openSync = originalOpen;
    assert.equal(mutated, true);
    assert.equal(first.exit_code, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.out, 'report.json'))).agents[0].status, 'partial');
    const replay = finalizeRun(f.out, { requireComplete: true });
    assert.equal(replay.exit_code, 4);
    assert.equal(replay.assessment.status, 'stale');
    assert.ok(replay.blockers.some(blocker => blocker.code === 'stale_finalization'));
  } finally { fs.openSync = originalOpen; f.cleanup(); }
});

test('--require-complete remains an explicit completion gate when replaying the same receipt', () => {
  const f = fixture({ status: 'partial' });
  try {
    const assessment = path.join(f.base, 'assessment.json'); json(assessment, f.assessment('partial'));
    const ordinary = finalizeRun(f.out, { assessmentPath: assessment });
    assert.equal(ordinary.exit_code, 0);
    const required = finalizeRun(f.out, { requireComplete: true });
    assert.equal(required.exit_code, 4);
    assert.ok(required.blockers.some(blocker => blocker.code === 'require_complete'));
    const ordinaryAgain = finalizeRun(f.out);
    assert.equal(ordinaryAgain.exit_code, 0);
  } finally { f.cleanup(); }
});

test('inventory records all request costs and unknown token dimensions without source text', () => {
  const f = fixture({ learning: true });
  try {
    const request = { agent_id: 'worker', provider: 'openrouter', response_id: 'synthetic-response', billed_usd: 0.12, usage: { input: 10, output: 20, cacheRead: 3, cacheWrite: 4 } };
    const usage = { requests: [request], costs: costSummary([request]) };
    const started = beginRunInventory(f.repo, { report: f.report, plan: f.plan, usage: { requests: [], costs: costSummary([]) } });
    assert.equal(started.recorded, true);
    f.report.finished_at = '2026-09-22T10:01:00.000Z';
    const updated = updateRunInventory(f.repo, { report: f.report, plan: f.plan, usage, lifecycle: 'completed' });
    assert.equal(updated.recorded, true);
    const inventory = readRunInventory(f.repo);
    assert.equal(inventory.runs.length, 1);
    assert.equal(inventory.runs[0].costs.provider_reported_usd, 0.12);
    assert.equal(inventory.runs[0].workers[0].request_count, 1);
    assert.deepEqual(inventory.runs[0].workers[0].tokens, { input: 10, output: 20, reasoning: null, cache_read: 3, cache_write: 4, total: 37, known_requests: { input: 1, output: 1, reasoning: 0, cache_read: 1, cache_write: 1, total: 1 } });
    assert.equal('objective' in inventory.runs[0], false);
    assert.equal(JSON.stringify(inventory).includes('Synthetic'), false);
  } finally { f.cleanup(); }
});

test('numeric v2 quality cannot reuse an identity saved in report.json after result bytes disappear', () => {
  const f = fixture();
  try {
    const artifact = sha256('forged');
    f.report.evaluation = { schema_version: 1, task_id: 'task-v2', task_type: 'bugfix', scope: '.', complexity: 'bounded', strategy: 'single-review', strategy_version: 'v1', focus: ['correctness'], workers: [{ agent_id: 'worker', assignment_id: 'assignment-1', attempt_index: 1, criteria: [{ id: 'criterion', requirement: 'Synthetic criterion' }] }] };
    f.plan.evaluation = structuredClone(f.report.evaluation);
    f.report.agents[0].artifact_identity = { schema_version: 1, artifact_sha256: artifact };
    json(path.join(f.out, 'plan.json'), f.plan);
    json(path.join(f.out, 'report.json'), f.report);
    const assessment = f.assessment('v2'); assessment.schema_version = 2; assessment.workers[0].quality_0_to_3 = 2; assessment.workers[0].quality_reason = 'Synthetic'; assessment.workers[0].criterion_results = [{ id: 'criterion', result: 'passed', evidence: ['Synthetic'] }]; assessment.workers[0].artifact_sha256 = artifact; assessment.workers[0].integration_status = 'candidate_only';
    const file = path.join(f.base, 'assessment-v2.json'); json(file, assessment);
    assert.throws(() => finalizeRun(f.out, { assessmentPath: file }), /actual saved submission\/candidate artifact identity/);
  } finally { f.cleanup(); }
});

test('finalization and learning reject a report evaluation changed after preregistration', () => {
  const f = fixture({ learning: true });
  try {
    const evaluation = { schema_version: 1, task_id: 'task-provenance', task_type: 'bugfix', scope: '.', complexity: 'bounded', strategy: 'single-review', strategy_version: 'v1', focus: ['correctness'], workers: [{ agent_id: 'worker', assignment_id: 'assignment-1', attempt_index: 1, criteria: [{ id: 'criterion', requirement: 'Use the saved fixture.' }] }] };
    f.plan.evaluation = evaluation;
    f.report.evaluation = structuredClone(evaluation);
    f.report.evaluation.workers[0].criteria[0].requirement = 'Changed after the plan was saved.';
    json(path.join(f.out, 'plan.json'), f.plan);
    json(path.join(f.out, 'report.json'), f.report);
    assert.throws(() => finalizeRun(f.out), /report evaluation differs from the preregistered plan evaluation/);
    assert.throws(() => recordLearning(f.repo, f.out, null), /report evaluation differs from the preregistered plan evaluation/);
  } finally { f.cleanup(); }
});
