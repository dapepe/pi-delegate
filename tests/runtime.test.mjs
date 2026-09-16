/** Runtime behaviour: deadlines, finalization, bounded repair, checkpoints, failure classes, alias billing, ledgers. Fixtures are synthetic. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  mergePolicy, validatePlan, captureSnapshot, createCapabilities, workerPolicy,
  validateSubmission, classifyStop, authorizedIdentities, openRouterModel, costSummary
} from '../scripts/lib.mjs';
import { aggregateLedger } from '../scripts/report.mjs';
import { executeJob } from '../scripts/pi.mjs';
import { shouldFinalize, finalizationReserve, publicText, diagnoseRun, explainStop, STOP_STATUSES } from '../scripts/runtime.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const defaults = JSON.parse(fs.readFileSync(path.join(root, 'defaults.json'), 'utf8'));
const answer = (completion = 'complete') => ({
  summary: 'Evidence for host review; tests not run.', findings: [], proposed_tests: [], open_questions: [],
  completion, remaining_work: completion === 'complete' ? [] : ['Host must finish the remaining investigation.']
});
const invoke = (caps, name, args) => caps.tools.find(t => t.name === name).execute('test', args, new AbortController().signal);

function clock() {
  let time = 100000;
  const handles = [];
  const make = (fn, ms, interval) => { const h = { fn, ms, interval, active: true }; handles.push(h); return h; };
  return {
    now: () => time, advance: ms => { time += ms; }, handles,
    fire: (ms, interval = false) => {
      const h = handles.find(x => x.active && x.ms === ms && x.interval === interval);
      assert.ok(h, `No active ${ms}ms timer`); if (!interval) h.active = false; h.fn();
    },
    timers: {
      setTimeout: (fn, ms) => make(fn, ms, false), clearTimeout: h => { if (h) h.active = false; },
      setInterval: (fn, ms) => make(fn, ms, true), clearInterval: h => { if (h) h.active = false; }
    }
  };
}

function fixture(t, policy = {}, agent = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-runtime-')), repo = path.join(base, 'repo'), out = path.join(base, 'run');
  fs.mkdirSync(repo); fs.writeFileSync(path.join(repo, 'a.js'), 'export const n = 1;\n');
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const model = openRouterModel({
    id: defaults.preferred_models[1], reasoning: { supported_efforts: ['high', 'max'] },
    pricing: { prompt: '0.000001', completion: '0.000002' }, context_length: 128000, top_provider: { max_completion_tokens: 32768 }
  }, defaults.openrouter_routing);
  const plan = {
    repo_root: repo, objective: 'Finish a bounded assignment', read_files: ['a.js'], policy,
    agents: [{ id: 'worker', model: model.id, role: 'investigator', mode: 'write', write_files: ['a.js'], task: 'Investigate n', selection_reason: 'Test fixture', ...agent }]
  };
  let instance;
  class FakeAgent {
    constructor(o) { this.o = o; this.listeners = []; this.prompts = 0; instance = this; }
    subscribe(fn) { this.listeners.push(fn); }
    async emit(e) { for (const fn of this.listeners) await fn(e); }
    abort() { this.aborted = true; }
    async prompt(text) { this.prompts++; this.promptText = text; await this.behavior(this); }
    request(context = { systemPrompt: this.o.initialState.systemPrompt, tools: this.o.initialState.tools, messages: [] }) {
      this.context = context; return this.o.streamFn(model, context, {});
    }
    async finish(stopReason = 'stop', content = [], extra = {}) {
      await this.emit({ type: 'message_end', message: { role: 'assistant', stopReason, content, responseId: `gen-${this.prompts}`, responseModel: model.id, usage: { input: 10, output: 5, reasoning: 2, totalTokens: 15, cost: { total: 0.00002 } }, ...extra } });
    }
    async tool(name, args) {
      const result = await this.o.initialState.tools.find(t => t.name === name).execute('call', args);
      await this.emit({ type: 'tool_execution_end', toolName: name, isError: false });
      return result;
    }
  }
  const run = async (behavior, extra = {}) => {
    FakeAgent.prototype.behavior = behavior;
    const dependencies = {
      Agent: FakeAgent, keyFor: () => 'FIXTURE-PRIVATE-KEY', createPatch: (_a, _b, before, after) => `${before}=>${after}`,
      resolve: async () => ({ model, metadata: { requested_model: model.id, resolved_model: model.id, canonical_slug: model.id, provider: 'openrouter', requested_effort: 'xhigh', effective_pi_effort: 'max', configured_provider_effort: 'max', max_output_tokens: 1000 } }),
      adapter: () => ({ streamSimple: (_m, c, opts) => { instance.sentContext = c; instance.sentOptions = opts; } }),
      fetchGeneration: async () => ({ data: { total_cost: 0.00003, model: model.id } }), ...extra
    };
    return executeJob(plan, out, dependencies);
  };
  return { base, repo, out, plan, model, run, agent: () => instance };
}

test('every stop status has both a layer and a retry classification', () => {
  for (const status of STOP_STATUSES) {
    assert.equal(typeof explainStop(status).layer, 'string');
    assert.ok(classifyStop({ status }).failure_class, `${status} has no failure class`);
  }
  assert.equal(explainStop('running').layer, 'unfinished');
  assert.match(explainStop('running').advice, /may still be running/);
});

test('the finishing allowance is reserved inside the authorized limit, never above it', () => {
  assert.equal(shouldFinalize(defaults, 9, 0, 1), false);
  assert.equal(shouldFinalize(defaults, 10, 0, 1), true);
  assert.equal(shouldFinalize(defaults, 1, 59, 1), true);
  assert.equal(shouldFinalize(defaults, 1, 1, 480), true);
  assert.equal(shouldFinalize({ ...defaults, max_turns: 1, finalization_turns: 0 }, 0, 0, 0), false);
  // The time reserve is capped at a quarter of the worker lifetime, so a short worker does not start finalizing.
  assert.equal(finalizationReserve({ ...defaults, timeout_seconds: 200 }).seconds, 50);
  assert.equal(finalizationReserve(defaults).seconds, 120);
});

test('runtime policy rejects overflow, unbounded repair and a reserve that leaves no work', () => {
  assert.equal(mergePolicy(defaults, {}).finalization_seconds, 120);
  for (const bad of [
    { timeout_seconds: 2147483647 }, { stream_idle_timeout_seconds: -1 }, { max_completion_repairs: 4 },
    { request_timeout_seconds: 0 }, { finalization_turns: -1 }, { finalization_seconds: 600 }, { finalization_turns: 12 }
  ]) assert.throws(() => mergePolicy(defaults, bad));
});

test('worker allocations may reduce but cannot raise authorized ceilings', () => {
  assert.equal(workerPolicy(defaults, { max_turns: 6 }).max_turns, 6);
  for (const limits of [{ max_turns: 13 }, { per_agent_budget_usd: 3 }, { max_parallel: 1 }, { max_turns: 0 }, { max_output_tokens: 0.5 }, null]) {
    assert.throws(() => workerPolicy(defaults, limits));
  }
});

test('partial and blocked submissions require unfinished work; a complete claim cannot list it', () => {
  assert.equal(validateSubmission(answer('partial'), new Map()).completion, 'partial');
  assert.equal(validateSubmission(answer('blocked'), new Map()).completion, 'blocked');
  assert.equal(validateSubmission({ summary: 'legacy', findings: [], proposed_tests: [], open_questions: [] }, new Map()).completion, undefined);
  assert.throws(() => validateSubmission({ ...answer('partial'), remaining_work: [] }, new Map()));
  assert.throws(() => validateSubmission({ ...answer(), remaining_work: ['not done'] }, new Map()));
});

test('captured public output excludes reasoning blocks and tool arguments, and marks truncation', () => {
  const captured = publicText({ content: [
    { type: 'thinking', thinking: 'PRIVATE REASONING' }, { type: 'text', text: '123456789' }, { type: 'toolCall', arguments: { secret: 'x' } }
  ] }, s => s, 4);
  assert.deepEqual(captured, { text: '1234', truncated: true });
});

test('near the deadline tool results warn once, and inside the finishing window only submit_result is accepted', async t => {
  const f = fixture(t);
  const p = validatePlan(f.plan, defaults);
  let left = 1000; const warnings = [];
  const caps = createCapabilities(p.agents[0], captureSnapshot(p), p.policy, () => false, 'claude-code', {
    finalizationSeconds: 120, remainingSeconds: () => left, onWarning: v => warnings.push(v)
  });
  let r = await invoke(caps, 'read_file', { path: 'a.js' });
  assert.doesNotMatch(r.content[0].text, /remain before the hard timeout/);
  left = 200; r = await invoke(caps, 'read_file', { path: 'a.js' });
  assert.match(r.content[0].text, /About 200 s remain/); assert.deepEqual(warnings, [200]);
  await invoke(caps, 'search_files', { query: 'n' });
  assert.deepEqual(warnings, [200]); assert.equal(caps.state.deadline.warnings, 2);
  left = 90;
  await assert.rejects(invoke(caps, 'read_file', { path: 'a.js' }), /Only submit_result is permitted/);
  assert.equal(caps.state.deadline.refusals, 1);
  assert.equal(caps.state.policy_violations.length, 0, 'a deadline refusal is not a worker violation');
  const done = await invoke(caps, 'submit_result', answer('partial'));
  assert.equal(done.terminate, true); assert.equal(caps.state.submitted.completion, 'partial');
});

test('no deadline source means no warnings or refusals', async t => {
  const f = fixture(t);
  const p = validatePlan(f.plan, defaults);
  const caps = createCapabilities(p.agents[0], captureSnapshot(p), p.policy);
  const r = await invoke(caps, 'read_file', { path: 'a.js' });
  assert.doesNotMatch(r.content[0].text, /\[pi\]/);
  assert.deepEqual(caps.state.deadline, { warnings: 0, refusals: 0 });
});

test('the final tool slot stays reserved for submission even after repeated denied investigation', async t => {
  const f = fixture(t);
  const p = validatePlan(f.plan, mergePolicy(defaults, { max_tool_calls: 2 }));
  const caps = createCapabilities(p.agents[0], captureSnapshot(p), p.policy);
  await invoke(caps, 'read_file', { path: 'a.js' });
  for (let i = 0; i < 3; i++) await assert.rejects(invoke(caps, 'read_file', { path: 'a.js' }), /reserved/);
  await invoke(caps, 'submit_result', answer('partial'));
  assert.equal(caps.state.tool_calls, 2); assert.equal(caps.state.rejected_tool_calls, 3);
});

test('ordinary exact-replacement mistakes are tool errors, not permission violations', async t => {
  const f = fixture(t);
  const p = validatePlan(f.plan, defaults);
  const caps = createCapabilities(p.agents[0], captureSnapshot(p), p.policy);
  await assert.rejects(invoke(caps, 'replace_text', { path: 'a.js', old_text: 'not there', new_text: 'x' }));
  assert.equal(caps.state.tool_errors.length, 1); assert.equal(caps.state.policy_violations.length, 0);
  await assert.rejects(invoke(caps, 'read_file', { path: 'unauthorized.js' }));
  assert.equal(caps.state.policy_violations.length, 1);
});

test('a premature normal stop receives one bounded continuation without losing task permissions', async t => {
  const f = fixture(t);
  const { report } = await f.run(async a => {
    await a.request();
    if (a.prompts === 1) { await a.finish('stop', [{ type: 'text', text: 'I will inspect this now.' }]); return; }
    assert.ok(a.sentContext.tools.some(x => x.name === 'read_file'));
    await a.tool('read_file', { path: 'a.js' }); await a.finish(); await a.tool('submit_result', answer());
  });
  assert.equal(report.agents[0].status, 'completed'); assert.equal(report.costs.request_count, 2);
  assert.equal(report.agents[0].recovery_events[0].mode, 'bounded_continuation');
  assert.equal(report.agents[0].limit_usage.completion_repairs, 1);
});

test('repeated premature stops cannot create an unbounded recovery loop', async t => {
  const f = fixture(t);
  const { report } = await f.run(async a => { await a.request(); await a.finish(); });
  assert.equal(report.agents[0].status, 'missing_submission');
  assert.equal(report.costs.request_count, 2);
  assert.equal(report.agents[0].failure_class, 'missing_submission');
});

test('completion repair can be disabled explicitly', async t => {
  const f = fixture(t, { max_completion_repairs: 0 });
  const { report } = await f.run(async a => { await a.request(); await a.finish(); });
  assert.equal(report.agents[0].status, 'missing_submission'); assert.equal(report.costs.request_count, 1);
});

test('output truncation gets a submission-only recovery and cannot execute the truncated edit', async t => {
  const f = fixture(t);
  const { report, out } = await f.run(async a => {
    await a.request();
    if (a.prompts === 1) { await a.finish('length', [], { usage: { input: 10, output: 2000, reasoning: 1990, totalTokens: 2010, cost: { total: 0.00002 } } }); return; }
    assert.deepEqual(a.sentContext.tools.map(x => x.name), ['submit_result']);
    await assert.rejects(a.tool('write_file', { path: 'a.js', content: 'bad' }), /Finalization only/);
    await a.finish(); await a.tool('submit_result', answer('partial'));
  });
  const worker = report.agents[0];
  assert.equal(worker.status, 'partial');
  assert.equal(worker.recovery_events[0].trigger, 'output_limit');
  assert.equal(worker.failure_class, 'partial');
  assert.equal(fs.readFileSync(path.join(f.repo, 'a.js'), 'utf8'), 'export const n = 1;\n');
  assert.match(fs.readFileSync(path.join(out, 'report.md'), 'utf8'), /Remaining work \(worker claim\)/);
});

test('an unrecovered truncation is reported as an output limit with its reasoning split', async t => {
  const f = fixture(t, { max_completion_repairs: 0 });
  const { report, out } = await f.run(async a => {
    await a.request();
    await a.finish('length', [], { usage: { input: 10, output: 2000, reasoning: 1990, totalTokens: 2010, cost: { total: 0.00002 } } });
  });
  const worker = report.agents[0];
  assert.equal(worker.status, 'output_limit');
  assert.equal(worker.failure_class, 'output_limit_reasoning');
  assert.equal(worker.suggested_learning_failure_kind, 'packet');
  assert.equal(worker.timing.requests, 1);
  assert.equal(typeof worker.timing.mean_request_seconds, 'number');
  const md = fs.readFileSync(path.join(out, 'report.md'), 'utf8');
  assert.match(md, /Failure class: output_limit_reasoning/);
  assert.match(md, /Incomplete: output_limit \(output_tokens\)/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'worker', 'result.json'), 'utf8')).failure_class, 'output_limit_reasoning');
});

test('reserved finalization exposes only submit_result and adds no requests', async t => {
  const f = fixture(t, { max_turns: 4 });
  const { report } = await f.run(async a => {
    for (let i = 0; i < 3; i++) {
      await a.request();
      if (i === 2) assert.deepEqual(a.sentContext.tools.map(x => x.name), ['submit_result']);
      await a.finish('toolUse');
    }
    await a.tool('submit_result', answer('partial'));
  });
  assert.equal(report.agents[0].status, 'partial'); assert.equal(report.costs.request_count, 3);
  assert.equal(report.agents[0].finalization.trigger, 'reserved_allowance');
});

test('the hard request limit is not reset by completion repair', async t => {
  const f = fixture(t, { max_turns: 1, finalization_turns: 0 });
  const { report } = await f.run(async a => { await a.request(); await a.finish(); });
  assert.equal(report.agents[0].status, 'turn_limit'); assert.equal(report.costs.request_count, 1);
  assert.equal(report.agents[0].suggested_learning_failure_kind, 'limit');
});

test('a request timeout is labeled independently and does not trigger repair', async t => {
  const f = fixture(t, { timeout_seconds: 5, request_timeout_seconds: 1, finalization_seconds: 1 }), c = clock();
  const { report } = await f.run(async a => {
    await a.request(); c.advance(1000); c.fire(1000);
    assert.equal(a.aborted, true); await a.finish('aborted');
  }, c);
  assert.equal(report.agents[0].status, 'request_timeout');
  assert.equal(report.agents[0].recovery_events.length, 0);
  assert.equal(report.agents[0].suggested_learning_failure_kind, 'provider');
  assert.ok(c.handles.every(h => !h.active), 'every timer is cleared');
});

test('the worker deadline stays distinct from the per-request timeout', async t => {
  const f = fixture(t, { timeout_seconds: 5, request_timeout_seconds: 3, finalization_seconds: 1 }), c = clock();
  const { report } = await f.run(async a => { await a.request(); c.advance(5000); c.fire(5000); await a.finish('aborted'); }, c);
  assert.equal(report.agents[0].status, 'timeout'); assert.equal(report.agents[0].recovery_events.length, 0);
});

test('the optional idle timeout resets on provider events rather than runner heartbeats', async t => {
  const f = fixture(t, { stream_idle_timeout_seconds: 2 }), c = clock();
  const { report } = await f.run(async a => {
    await a.request(); c.advance(1000);
    await a.emit({ type: 'message_update', message: { role: 'assistant', responseId: 'gen-idle', content: [{ type: 'thinking', thinking: 'not for disk' }] } });
    assert.equal(c.handles.filter(h => h.active && h.ms === 2000).length, 1);
    c.advance(2000); c.fire(2000); await a.finish('aborted');
  }, c);
  assert.equal(report.agents[0].status, 'stream_idle_timeout');
  assert.equal(report.agents[0].partial_output, null, 'thinking blocks are never persisted');
});

test('the default idle guard is disabled; the heartbeat checkpoints without generating inference', async t => {
  const f = fixture(t), c = clock(), events = [];
  const { report } = await f.run(async a => {
    await a.request(); c.advance(15000); c.fire(15000, true);
    assert.equal(a.aborted, undefined);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.out, 'worker/result.json'), 'utf8')).status, 'running');
    await a.finish(); await a.tool('submit_result', answer());
  }, { ...c, onProgress: e => events.push(e) });
  assert.equal(report.costs.request_count, 1);
  assert.ok(events.some(e => e.type === 'heartbeat'));
});

test('a candidate checkpoint survives before completion and reverted exports are removed', async t => {
  const f = fixture(t);
  const { report } = await f.run(async a => {
    await a.request(); await a.finish('toolUse');
    await a.tool('write_file', { path: 'a.js', content: 'export const n = 2;\n' });
    assert.equal(fs.readFileSync(path.join(f.out, 'worker/candidate/a.js'), 'utf8'), 'export const n = 2;\n');
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.out, 'worker/result.json'), 'utf8')).status, 'running');
    await a.tool('delete_file', { path: 'a.js' });
    assert.equal(fs.existsSync(path.join(f.out, 'worker/candidate/a.js')), false);
    await a.tool('submit_result', answer('partial'));
  });
  assert.equal(report.agents[0].changes[0].action, 'delete');
  assert.equal(fs.readFileSync(path.join(f.repo, 'a.js'), 'utf8'), 'export const n = 1;\n');
});

test('an explicit refusal does not enter the completion-repair loop', async t => {
  const f = fixture(t);
  const { report } = await f.run(async a => {
    await a.request();
    await a.finish('stop', [{ type: 'text', text: "I'm sorry, but I cannot assist with this request." }]);
  });
  assert.equal(report.agents[0].status, 'refusal');
  assert.equal(report.costs.request_count, 1);
  assert.equal(report.agents[0].recovery_events.length, 0);
  assert.match(report.agents[0].partial_output.text, /cannot assist/);
});

test('permission violations prevent automatic continuation', async t => {
  const f = fixture(t);
  const { report } = await f.run(async a => {
    await a.request(); await a.finish('toolUse');
    await assert.rejects(a.tool('read_file', { path: 'unauthorized.js' }));
  });
  assert.equal(report.agents[0].status, 'policy_violation');
  assert.equal(report.costs.request_count, 1);
});

test('a generation ID from the stream start survives a thrown connection error', async t => {
  const f = fixture(t);
  const { report } = await f.run(async a => {
    await a.request();
    await a.emit({ type: 'message_start', message: { role: 'assistant', responseId: 'gen-start', content: [] } });
    throw new Error('Connection ended');
  });
  const usage = JSON.parse(fs.readFileSync(path.join(f.out, 'usage.json'), 'utf8'));
  assert.equal(usage.requests[0].response_id, 'gen-start');
  assert.equal(report.costs.reconciled_request_count, 1);
  assert.equal(report.agents[0].recovery_events.length, 0);
});

test('a budget reservation denial exposes its arithmetic without claiming actual spending', async t => {
  const f = fixture(t, { per_agent_budget_usd: 0.000001 });
  const { report } = await f.run(async a => { await a.request(); });
  const worker = report.agents[0];
  assert.equal(worker.status, 'budget_reservation_limit');
  assert.equal(report.costs.request_count, 0);
  assert.ok(worker.last_admission.reservation_usd > worker.last_admission.remaining_worker_budget_usd);
  assert.match(worker.failure_hint, /not spent money/);
});

test('worker-specific limits appear in the report and cap output without reducing reasoning', async t => {
  const f = fixture(t, {}, { limits: { max_turns: 3, max_output_tokens: 500 } });
  const { report } = await f.run(async a => {
    await a.request();
    assert.equal(a.sentOptions.maxTokens, 500);
    assert.equal(a.o.initialState.thinkingLevel, 'max');
    await a.finish(); await a.tool('submit_result', answer());
  });
  assert.equal(report.agents[0].limits.max_turns, 3);
  assert.equal(report.agents[0].model.max_output_tokens, 500);
});

test('failure classes separate provider outages and packet problems from model quality', () => {
  assert.deepEqual(classifyStop({ status: 'completed' }), { failure_class: 'none', failure_hint: null, suggested_learning_failure_kind: 'none' });
  const reasoning = classifyStop({ status: 'output_limit', usage: { output: 31455, reasoning: 31455 }, max_output_tokens: 32768 });
  assert.equal(reasoning.failure_class, 'output_limit_reasoning');
  assert.match(reasoning.failure_hint, /31455 of 31455/);
  assert.equal(reasoning.suggested_learning_failure_kind, 'packet');
  assert.equal(classifyStop({ status: 'output_limit', usage: { output: 1000, reasoning: 10 } }).failure_class, 'output_limit');
  const rate = classifyStop({ status: 'error', warnings: ['429: {"message":"Provider returned error","code":429}'] });
  assert.equal(rate.failure_class, 'provider_rate_limit');
  assert.equal(rate.suggested_learning_failure_kind, 'provider');
  assert.equal(classifyStop({ status: 'error', warnings: ['HTTP 503 upstream unavailable'] }).failure_class, 'provider_error');
  assert.equal(classifyStop({ status: 'error', warnings: ['Turn limit reached'] }).failure_class, 'error');
  const slow = classifyStop({ status: 'timeout', timing: { requests: 9, mean_request_seconds: 66.6 }, finalization_seconds: 120, timeout: 600 });
  assert.match(slow.failure_hint, /9 request\(s\) averaged 67 s/);
  assert.equal(slow.suggested_learning_failure_kind, 'provider');
  assert.equal(classifyStop({ status: 'timeout', timing: { requests: 3, mean_request_seconds: 5 } }).suggested_learning_failure_kind, 'limit');
  assert.equal(classifyStop({ status: 'budget_limit' }).suggested_learning_failure_kind, 'host');
  assert.equal(classifyStop({ status: 'model_mismatch' }).failure_class, 'model_mismatch');
  // An honest partial result is not an operational failure and must not be recorded as one.
  assert.equal(classifyStop({ status: 'partial', remaining_work: ['x'] }).suggested_learning_failure_kind, 'none');
  assert.equal(classifyStop({ status: 'blocked', remaining_work: ['x'] }).suggested_learning_failure_kind, 'packet');
});

test('a moving alias billed under the dated build of its catalog target is the authorized model', async t => {
  assert.deepEqual(
    authorizedIdentities({ resolved_model: '~x/latest', canonical_slug: '~x/latest', catalog_alias_target: { slug: 'x/v4', canonical_slug: 'x/v4-20260810' } }),
    ['~x/latest', 'x/v4', 'x/v4-20260810']);
  assert.deepEqual(authorizedIdentities({}), []);
  const aliasTarget = { name: 'X v4', slug: 'x/v4', canonical_slug: 'x/v4-20260810' };
  const resolveWithAlias = model => async () => ({ model, metadata: {
    requested_model: '~x/latest', resolved_model: model.id, canonical_slug: model.id, catalog_alias_target: aliasTarget,
    provider: 'openrouter', requested_effort: 'xhigh', effective_pi_effort: 'max', configured_provider_effort: 'max', max_output_tokens: 1000 } });
  // The alias target's dated build is the identity the provider actually bills: it is authorized.
  const f = fixture(t);
  const { report } = await f.run(
    async a => { await a.request(); await a.finish('stop', [], { responseModel: 'x/v4' }); await a.tool('submit_result', answer()); },
    { resolve: resolveWithAlias(f.model), fetchGeneration: async () => ({ data: { total_cost: 0.00003, model: 'x/v4-20260810' } }) });
  assert.equal(report.agents[0].status, 'completed');
  assert.equal(report.agents[0].failure_class, 'none');
  // An unrelated dated build is still a real substitution, not an alias artefact.
  const g = fixture(t);
  const stale = await g.run(
    async a => { await a.request(); await a.finish('stop', [], { responseModel: 'x/v4' }); },
    { resolve: resolveWithAlias(g.model), fetchGeneration: async () => ({ data: { total_cost: 0.00003, model: 'x/v5-20261001' } }) });
  assert.equal(stale.report.agents[0].status, 'model_mismatch');
  assert.equal(stale.report.agents[0].failure_class, 'model_mismatch');
});

test('a ledger sums phases without merging reported charges into estimates', () => {
  const run = (id, requests, agents, orchestrator = 'claude-code') => ({ run_id: id, created_at: `2026-09-15T0${id.at(-1)}:00:00Z`, orchestrator, objective: `Phase ${id}`, costs: costSummary(requests), agents });
  const ledger = aggregateLedger([
    run('run1', [{ billed_usd: 0.5 }, { billed_usd: 0.07 }], [{ id: 'a', status: 'completed' }, { id: 'b', status: 'timeout', failure_class: 'timeout' }]),
    run('run2', [{ estimate_usd: 0.2 }, {}], [{ id: 'b', status: 'error', failure_class: 'provider_rate_limit' }])
  ]);
  assert.equal(ledger.totals.provider_reported_usd, 0.57);
  assert.equal(ledger.totals.estimated_unreconciled_usd, 0.2);
  assert.equal(ledger.totals.unpriced_request_count, 1);
  assert.equal(ledger.totals.request_count, 4);
  assert.equal(ledger.totals.all_requests_reconciled, false);
  assert.equal(ledger.label, 'Pi delegation cost; excludes Claude Code');
  assert.equal(ledger.runs[1].agents[0].failure_class, 'provider_rate_limit');
  assert.match(aggregateLedger([run('run3', [], [], 'codex'), run('run4', [], [], 'claude-code')]).label, /Codex \/ Claude Code/);
  assert.throws(() => aggregateLedger([]));
});

test('legacy artifact diagnosis and the CLI work without a provider key or SDK', t => {
  const f = fixture(t); fs.mkdirSync(f.out, { recursive: true });
  fs.writeFileSync(path.join(f.out, 'plan.json'), JSON.stringify({ ...f.plan, policy: defaults }));
  fs.writeFileSync(path.join(f.out, 'report.json'), JSON.stringify({ run_id: 'legacy', skill_version: '1.2.0', agents: [{ id: 'worker', status: 'turn_limit', elapsed_seconds: 15 }] }));
  const diagnosis = diagnoseRun(f.out);
  assert.equal(diagnosis.workers[0].layer, 'request_count');
  // A 1.2.0 artifact has no recorded classification; it is derived rather than left blank.
  assert.equal(diagnosis.workers[0].failure_class, 'turn_limit');
  assert.equal(diagnosis.finished, false);
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/pi.mjs'), 'diagnose', '--out', f.out], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).finished, false);
});

test('a redactor that shortens the excerpt is reported as truncation, not as complete output', () => {
  const message = { content: [{ type: 'text', text: 'key SECRET here' }] };
  assert.deepEqual(publicText(message, s => s.replace('SECRET', '')), { text: 'key  here', truncated: true });
  assert.deepEqual(publicText(message), { text: 'key SECRET here', truncated: false });
});

test('diagnosis of a truncated or malformed run reports unknowns instead of crashing', t => {
  const f = fixture(t); fs.mkdirSync(f.out, { recursive: true });
  // Only report.json survived, its policy is gone, and a worker carries an impossible allocation.
  fs.writeFileSync(path.join(f.out, 'plan.json'), JSON.stringify({ policy: {}, agents: [{ id: 'worker', limits: { max_turns: 8 } }] }));
  fs.writeFileSync(path.join(f.out, 'report.json'), JSON.stringify({ run_id: 'killed', cancellation_signal: 'SIGTERM', agents: [{ id: 'worker', status: 'running' }] }));
  const diagnosis = diagnoseRun(f.out);
  assert.equal(diagnosis.finished, false);
  assert.equal(diagnosis.cancellation_signal, 'SIGTERM');
  assert.equal(diagnosis.workers[0].layer, 'unfinished');
  assert.match(diagnosis.workers[0].advice, /do not launch a duplicate blindly/);
  assert.deepEqual(diagnosis.workers[0].requests, []);
  // A report with no agents at all is still a readable diagnosis.
  fs.writeFileSync(path.join(f.out, 'report.json'), JSON.stringify({ run_id: 'empty' }));
  assert.deepEqual(diagnoseRun(f.out).workers, []);
});
