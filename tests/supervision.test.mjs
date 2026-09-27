/** Synthetic native-supervisor receipts. No real model or host spawn is claimed. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initSupervision, runSupervision, inspectSupervision, reviewSupervision } from '../scripts/supervision.mjs';
import { openRouterModel } from '../scripts/lib.mjs';

const defaults = JSON.parse(fs.readFileSync(new URL('../defaults.json', import.meta.url)));
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-supervision-')), repo = path.join(base, 'repo'), out = path.join(base, 'supervision');
  fs.mkdirSync(repo); fs.writeFileSync(path.join(repo, 'a.js'), 'export const n = 1;\n');
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const plan = { repo_root: repo, objective: 'Synthetic review', read_files: ['a.js'],
    agents: [{ id: 'worker', model: defaults.preferred_models[1], mode: 'read', task: 'Inspect n', selection_reason: 'Synthetic test' }] };
  return { base, repo, out, plan, init: () => initSupervision(plan, out, 'fixture-native-123') };
}
function executionDependencies() {
  const model = openRouterModel({ id: defaults.preferred_models[1], reasoning: { supported_efforts: ['max'] },
    pricing: { prompt: '0.000001', completion: '0.000002' }, context_length: 128000, top_provider: { max_completion_tokens: 1000 } }, defaults.openrouter_routing);
  class FakeAgent {
    constructor(options) { this.options = options; this.listeners = []; }
    subscribe(fn) { this.listeners.push(fn); }
    abort() {}
    async prompt() {
      const initial = this.options.initialState;
      this.options.streamFn(model, { systemPrompt: initial.systemPrompt, messages: [], tools: initial.tools }, {});
      for (const fn of this.listeners) await fn({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'toolUse', responseId: 'synthetic', responseModel: model.id, usage: { totalTokens: 10, cost: { total: 0.001 } } } });
      await initial.tools.find(t => t.name === 'submit_result').execute('synthetic', { summary: 'Synthetic completed review', findings: [], proposed_tests: [], open_questions: [], completion: 'complete', remaining_work: [] });
    }
  }
  return { Agent: FakeAgent, keyFor: () => 'synthetic-key', createPatch: () => '',
    resolve: async () => ({ model, metadata: { requested_model: model.id, resolved_model: model.id, provider: 'openrouter', requested_effort: 'xhigh', effective_pi_effort: 'max', configured_provider_effort: 'max', max_output_tokens: 1000 } }),
    adapter: () => ({ streamSimple: () => {} }), fetchGeneration: async () => ({ data: { total_cost: 0.001, model: model.id } }) };
}
function review(inspected) {
  return { native_agent_id: inspected.native_agent_id, artifact_fingerprint: inspected.artifact_fingerprint, verdict: 'ready_for_host',
    summary: 'Synthetic advisory review; main host still validates.', workers: [{ id: 'worker', evidence: ['Read original submission and scope; synthetic fixture.'], concerns: [] }] };
}
test('supervision records an explicit native ID and freezes approved plan and source snapshot', async t => {
  const f = fixture(t), initialized = f.init();
  assert.equal(initialized.native_agent_id, 'fixture-native-123');
  assert.match(initialized.provenance, /cannot independently authenticate/);
  fs.writeFileSync(path.join(f.repo, 'a.js'), 'changed');
  await assert.rejects(runSupervision(f.out, executionDependencies()), /Source snapshot changed/);
  assert.equal(inspectSupervision(f.out).status, 'failed');
  assert.equal(fs.existsSync(path.join(f.out, 'run')), false);
  assert.ok(fs.existsSync(path.join(f.out, 'incidents')));
});
test('supervised execution cannot replay, and reviewed artifacts remain bound to the native agent', async t => {
  const f = fixture(t); f.init();
  const result = await runSupervision(f.out, executionDependencies());
  assert.equal(result.status, 'awaiting_review');
  assert.equal(result.agents[0].status, 'completed');
  await assert.rejects(runSupervision(f.out, executionDependencies()), /already started/);
  const inspected = inspectSupervision(f.out);
  const bad = review(inspected); bad.native_agent_id = 'different-agent';
  await assert.rejects(reviewSupervision(f.out, bad), /registered native supervisor/);
  const receipt = await reviewSupervision(f.out, review(inspected));
  assert.equal(receipt.status, 'reviewed');
  const saved = JSON.parse(fs.readFileSync(path.join(f.out, 'supervisor-review.json')));
  assert.match(saved.authority, /Primary host/);
  assert.equal(fs.readFileSync(path.join(f.repo, 'a.js'), 'utf8'), 'export const n = 1;\n');
});
test('supervisor cannot accept stale evidence or omit a failed worker', async t => {
  const f = fixture(t); f.init(); await runSupervision(f.out, executionDependencies());
  const inspected = inspectSupervision(f.out);
  const incomplete = review(inspected); incomplete.workers = [];
  await assert.rejects(reviewSupervision(f.out, incomplete), /every assigned/);
  fs.appendFileSync(path.join(f.out, 'run/usage.json'), '\n');
  await assert.rejects(reviewSupervision(f.out, review(inspected)), /Artifacts changed/);
});
test('a fresh inspection still rejects a changed approved snapshot', async t => {
  const f = fixture(t); f.init(); await runSupervision(f.out, executionDependencies());
  const file = path.join(f.out, 'run/snapshot.json'), snapshot = JSON.parse(fs.readFileSync(file));
  snapshot.files['a.js'].sha256 = '0'.repeat(64); fs.writeFileSync(file, JSON.stringify(snapshot));
  assert.throws(() => inspectSupervision(f.out), /approved supervision snapshot/);
});
test('post-review artifact changes invalidate the review receipt without hiding its history', async t => {
  const f = fixture(t); f.init(); await runSupervision(f.out, executionDependencies());
  await reviewSupervision(f.out, review(inspectSupervision(f.out)));
  assert.equal(inspectSupervision(f.out).review_current, true);
  fs.appendFileSync(path.join(f.out, 'run/usage.json'), '\n');
  assert.equal(inspectSupervision(f.out).review_current, false);
});
test('supervision refuses approved-plan edits, linked output and repository-local output', t => {
  const f = fixture(t);
  assert.throws(() => initSupervision(f.plan, path.join(f.repo, 'supervision'), 'native'), /outside|inside the source/);
  f.init(); fs.appendFileSync(path.join(f.out, 'approved-plan.json'), '\n');
  assert.throws(() => inspectSupervision(f.out), /plan changed/);
});
test('supervision refuses linked state or run artifacts', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t); f.init(); await runSupervision(f.out, executionDependencies());
  const state = path.join(f.out, 'run/usage.json'), other = path.join(f.base, 'other.json');
  fs.renameSync(state, other); fs.symlinkSync(other, state);
  assert.throws(() => inspectSupervision(f.out), /symlink/);
});
test('a linked output parent cannot create directories in the task source', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t), link = path.join(f.base, 'alias'); fs.symlinkSync(f.repo, link);
  assert.throws(() => initSupervision(f.plan, path.join(link, 'must-not-create', 'supervision'), 'native'), /inside the source/);
  assert.equal(fs.existsSync(path.join(f.repo, 'must-not-create')), false);
});
test('preflight failure preserves its cause and writes a private structural incident', async t => {
  const f = fixture(t); f.init();
  await assert.rejects(runSupervision(f.out, { executeJob: async () => { throw new Error('synthetic missing capability'); } }), error => {
    assert.equal(error.message, 'synthetic missing capability'); assert.ok(error.incident?.json); return true;
  });
  assert.equal(inspectSupervision(f.out).status, 'failed');
  const incidentFiles = fs.readdirSync(path.join(f.out, 'incidents'));
  assert.ok(incidentFiles.some(file => file.endsWith('.md')));
  for (const name of incidentFiles) assert.doesNotMatch(fs.readFileSync(path.join(f.out, 'incidents', name), 'utf8'), /synthetic missing capability/);
});
test('diagnostic path and state errors cannot mask the original execution error', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t); f.init();
  const original = new Error('synthetic original execution failure');
  await assert.rejects(runSupervision(f.out, { executeJob: async () => {
    fs.symlinkSync(f.repo, path.join(f.out, 'run'));
    fs.unlinkSync(path.join(f.out, 'supervision-state.json'));
    fs.symlinkSync(path.join(f.repo, 'a.js'), path.join(f.out, 'supervision-state.json'));
    throw original;
  } }), error => {
    assert.equal(error, original);
    assert.equal(error.incident.code, 'incident_write_failed');
    assert.equal(error.supervision_persistence_error, 'supervision_state_write_failed');
    return true;
  });
});
