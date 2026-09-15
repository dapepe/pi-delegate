/** Runtime behaviour learned from the first live runs: deadlines, failure classes, alias billing, ledgers. Fixtures are synthetic. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergePolicy, validatePlan, captureSnapshot, createCapabilities, classifyStop, authorizedIdentities, openRouterModel, costSummary } from '../scripts/lib.mjs';
import { aggregateLedger } from '../scripts/report.mjs';
import { executeJob } from '../scripts/pi.mjs';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const defaults = JSON.parse(fs.readFileSync(path.join(root, 'defaults.json'), 'utf8'));
function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-runtime-')), repo = path.join(base, 'repo'), out = path.join(base, 'run');
  fs.mkdirSync(repo); fs.writeFileSync(path.join(repo, 'a.js'), 'export const n = 1;\n');
  const plan = { repo_root: repo, objective: 'Review the source', read_files: ['a.js'], agents: [{ id: 'review', role: 'reviewer', task: 'Inspect n', model: defaults.preferred_models[1], mode: 'read', selection_reason: 'Independent evidence' }] };
  return { base, repo, out, plan, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}
const submission = () => ({ summary: 'Review complete', findings: [], proposed_tests: [], open_questions: [] });
const invoke = (caps, name, args) => caps.tools.find(t => t.name === name).execute('test', args, new AbortController().signal);
const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 2, totalTokens: 15, cost: { input: 0.00001, output: 0.00001, cacheRead: 0, cacheWrite: 0, total: 0.00002 } };
function dependencies(plan, behavior, extra = {}) {
  const id = plan.agents[0].model;
  const model = openRouterModel({ id, reasoning: { supported_efforts: ['high', 'max'] }, pricing: { prompt: '0.000001', completion: '0.000002' }, context_length: 128000, top_provider: { max_completion_tokens: 32768 } }, defaults.openrouter_routing);
  class FixtureAgent {
    constructor(options) { this.o = options; this.listeners = []; }
    subscribe(fn) { this.listeners.push(fn); }
    async emit(e) { for (const fn of this.listeners) await fn(e); }
    abort() { this.aborted = true; }
    async prompt() { await behavior(this); }
    async request() { return this.o.streamFn(model, { messages: [], systemPrompt: 'test' }, {}); }
    async finish(extra = {}) { await this.emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'toolUse', responseId: 'gen-fixture', usage, ...extra } }); }
    async submit() { await this.o.initialState.tools.find(t => t.name === 'submit_result').execute('s', submission()); }
  }
  return { Agent: FixtureAgent, keyFor: () => 'OFFLINE_KEY', resolve: async a => ({ model, metadata: { provider: 'openrouter', requested_model: a.model, resolved_model: id, requested_effort: 'xhigh', effective_pi_effort: 'max', configured_provider_effort: 'max', max_output_tokens: 1000 } }), adapter: () => ({ streamSimple: () => undefined }), fetchGeneration: async () => ({ data: { total_cost: 0.00003, model: id } }), createPatch: () => '', ...extra };
}

test('submit grace window is a positive integer shorter than the timeout', () => {
  assert.equal(mergePolicy(defaults, {}).submit_grace_seconds, 120);
  assert.equal(mergePolicy(defaults, { timeout_seconds: 900, submit_grace_seconds: 180 }).submit_grace_seconds, 180);
  for (const bad of [{ submit_grace_seconds: 600 }, { submit_grace_seconds: 0 }, { submit_grace_seconds: 1.5 }, { timeout_seconds: 100 }]) assert.throws(() => mergePolicy(defaults, bad));
});
test('near the deadline tool results warn once, and inside the grace window only submit_result is accepted', async () => {
  const f = fixture(); try {
    const p = validatePlan(f.plan, defaults); const snapshot = captureSnapshot(p);
    let left = 1000; const warnings = [];
    const caps = createCapabilities(p.agents[0], snapshot, p.policy, () => false, 'claude-code', { remainingSeconds: () => left, onWarning: v => warnings.push(v) });
    let r = await invoke(caps, 'read_file', { path: 'a.js' });
    assert.doesNotMatch(r.content[0].text, /remain before the hard timeout/);
    left = 200; r = await invoke(caps, 'read_file', { path: 'a.js' });
    assert.match(r.content[0].text, /About 200 s remain/); assert.deepEqual(warnings, [200]);
    await invoke(caps, 'search_files', { query: 'n' }); assert.deepEqual(warnings, [200]); assert.equal(caps.state.deadline.warnings, 2);
    left = 90;
    await assert.rejects(invoke(caps, 'read_file', { path: 'a.js' }), /Only submit_result is permitted/);
    assert.equal(caps.state.deadline.refusals, 1); assert.equal(caps.state.policy_violations.length, 0, 'a deadline refusal is not a worker violation');
    const done = await invoke(caps, 'submit_result', submission());
    assert.equal(done.terminate, true); assert.ok(caps.state.submitted);
  } finally { f.cleanup(); }
});
test('no deadline source means no warnings or refusals', async () => {
  const f = fixture(); try {
    const p = validatePlan(f.plan, defaults); const caps = createCapabilities(p.agents[0], captureSnapshot(p), p.policy);
    const r = await invoke(caps, 'read_file', { path: 'a.js' });
    assert.doesNotMatch(r.content[0].text, /\[pi\]/); assert.deepEqual(caps.state.deadline, { warnings: 0, refusals: 0 });
  } finally { f.cleanup(); }
});
test('failure classes separate provider outages and packet problems from model quality', () => {
  assert.deepEqual(classifyStop({ status: 'completed' }), { failure_class: 'none', failure_hint: null, suggested_learning_failure_kind: 'none' });
  const reasoning = classifyStop({ status: 'output_limit', usage: { output: 31455, reasoning: 31455 }, max_output_tokens: 32768 });
  assert.equal(reasoning.failure_class, 'output_limit_reasoning'); assert.match(reasoning.failure_hint, /31455 of 31455/); assert.equal(reasoning.suggested_learning_failure_kind, 'packet');
  assert.equal(classifyStop({ status: 'output_limit', usage: { output: 1000, reasoning: 10 } }).failure_class, 'output_limit');
  const rate = classifyStop({ status: 'error', warnings: ['429: {"message":"Provider returned error","code":429}'] });
  assert.equal(rate.failure_class, 'provider_rate_limit'); assert.equal(rate.suggested_learning_failure_kind, 'provider');
  assert.equal(classifyStop({ status: 'error', warnings: ['HTTP 503 upstream unavailable'] }).failure_class, 'provider_error');
  assert.equal(classifyStop({ status: 'error', warnings: ['Turn limit reached'] }).failure_class, 'error');
  const slow = classifyStop({ status: 'timeout', timing: { requests: 9, mean_request_seconds: 66.6 }, grace: 120, timeout: 600 });
  assert.match(slow.failure_hint, /9 request\(s\) averaged 67 s/); assert.equal(slow.suggested_learning_failure_kind, 'provider');
  assert.equal(classifyStop({ status: 'timeout', timing: { requests: 3, mean_request_seconds: 5 } }).suggested_learning_failure_kind, 'packet');
  assert.equal(classifyStop({ status: 'budget_limit' }).suggested_learning_failure_kind, 'host');
  assert.equal(classifyStop({ status: 'model_mismatch' }).failure_class, 'model_mismatch');
});
test('a moving alias billed under the dated build of its catalog target is the authorized model', async () => {
  assert.deepEqual(authorizedIdentities({ resolved_model: '~x/latest', canonical_slug: '~x/latest', catalog_alias_target: { slug: 'x/v4', canonical_slug: 'x/v4-20260810' } }), ['~x/latest', 'x/v4', 'x/v4-20260810']);
  assert.deepEqual(authorizedIdentities({}), []);
  const f = fixture(); try {
    const d = dependencies(f.plan, async a => { await a.request(); await a.finish({ responseModel: 'x/v4' }); await a.submit(); }, { fetchGeneration: async () => ({ data: { total_cost: 0.00003, model: 'x/v4-20260810' } }) });
    const resolve = d.resolve; d.resolve = async a => { const r = await resolve(a); r.metadata.catalog_alias_target = { name: 'X v4', slug: 'x/v4', canonical_slug: 'x/v4-20260810' }; return r; };
    const { report } = await executeJob(f.plan, f.out, d);
    assert.equal(report.agents[0].status, 'completed'); assert.equal(report.agents[0].failure_class, 'none');
    fs.rmSync(f.out, { recursive: true });
    const stale = dependencies(f.plan, async a => { await a.request(); await a.finish({ responseModel: 'x/v4' }); await assert.rejects(a.submit()); }, { fetchGeneration: async () => ({ data: { total_cost: 0.00003, model: 'x/v5-20261001' } }) });
    stale.resolve = d.resolve;
    assert.equal((await executeJob(f.plan, f.out, stale)).report.agents[0].status, 'model_mismatch');
  } finally { f.cleanup(); }
});
test('results carry timing, deadline counters and a failure class the report renders', async () => {
  const f = fixture(); try {
    const events = [];
    const d = dependencies(f.plan, async a => { await a.request(); await a.finish({ stopReason: 'length', usage: { ...usage, output: 2000, reasoning: 1990 } }); }, { onProgress: e => events.push(e) });
    const { report, out } = await executeJob(f.plan, f.out, d);
    const a = report.agents[0];
    assert.equal(a.status, 'output_limit'); assert.equal(a.failure_class, 'output_limit_reasoning'); assert.equal(a.suggested_learning_failure_kind, 'packet');
    assert.equal(a.timing.requests, 1); assert.ok(typeof a.timing.mean_request_seconds === 'number'); assert.deepEqual(a.deadline, { warnings: 0, refusals: 0 });
    assert.ok(events.some(e => e.type === 'request_finished' && typeof e.seconds === 'number'));
    const md = fs.readFileSync(path.join(out, 'report.md'), 'utf8');
    assert.match(md, /Failure class: output_limit_reasoning/); assert.match(md, /Timing: 1 request\(s\)/);
    const saved = JSON.parse(fs.readFileSync(path.join(out, 'review', 'result.json'), 'utf8'));
    assert.equal(saved.failure_class, 'output_limit_reasoning');
  } finally { f.cleanup(); }
});
test('a ledger sums phases without merging reported charges into estimates', () => {
  const run = (id, requests, agents, orchestrator = 'claude-code') => ({ run_id: id, created_at: `2026-09-15T0${id.at(-1)}:00:00Z`, orchestrator, objective: `Phase ${id}`, costs: costSummary(requests), agents });
  const ledger = aggregateLedger([
    run('run1', [{ billed_usd: 0.5 }, { billed_usd: 0.07 }], [{ id: 'a', status: 'completed' }, { id: 'b', status: 'timeout', failure_class: 'timeout' }]),
    run('run2', [{ estimate_usd: 0.2 }, {}], [{ id: 'b', status: 'error', failure_class: 'provider_rate_limit' }])
  ]);
  assert.equal(ledger.totals.provider_reported_usd, 0.57); assert.equal(ledger.totals.estimated_unreconciled_usd, 0.2); assert.equal(ledger.totals.unpriced_request_count, 1);
  assert.equal(ledger.totals.request_count, 4); assert.equal(ledger.totals.all_requests_reconciled, false);
  assert.equal(ledger.label, 'Pi delegation cost; excludes Claude Code'); assert.equal(ledger.runs[1].agents[0].failure_class, 'provider_rate_limit');
  assert.match(aggregateLedger([run('run3', [], [], 'codex'), run('run4', [], [], 'claude-code')]).label, /Codex \/ Claude Code/);
  assert.throws(() => aggregateLedger([]));
});
