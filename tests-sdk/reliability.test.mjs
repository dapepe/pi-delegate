/** Pinned real Agent/adapter with synthetic SSE only. No network, credentials, or paid inference. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Agent } from '@earendil-works/pi-agent-core';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import { createTwoFilesPatch } from 'diff';
import { openRouterModel } from '../scripts/lib.mjs';
import { executeJob } from '../scripts/pi.mjs';

const defaults = JSON.parse(fs.readFileSync(new URL('../defaults.json', import.meta.url)));
const model = openRouterModel({ id: defaults.preferred_models[1], reasoning: { supported_efforts: ['max'] }, pricing: { prompt: '0.000001', completion: '0.000002' }, context_length: 128000, top_provider: { max_completion_tokens: 32768 } }, defaults.openrouter_routing);
globalThis.fetch = async () => { throw new Error('Unexpected external fetch in synthetic reliability tests'); };
const submission = { summary: 'Synthetic evidence ready for host review.', findings: [], proposed_tests: [], open_questions: [], completion: 'complete', remaining_work: [] };
const tool = (name, args) => ({ tool_calls: [{ index: 0, id: `synthetic-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
function sse(delta, count = 1, finish = 'tool_calls') {
  const base = { id: `synthetic-generation-${count}`, model: model.id, object: 'chat.completion.chunk', created: 1 };
  const chunks = [
    { ...base, choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
  ];
  return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
}

test('pinned SDK rejects a fractional timeout before mocked transport', { timeout: 10000 }, async () => {
  let fetched = false;
  const timeoutMs = (600 - 32.041) * 1000;
  assert.ok(!Number.isInteger(timeoutMs), 'Synthetic subtraction must reproduce fractional milliseconds');
  const message = await openrouterProvider().streamSimple(model, { systemPrompt: 'Synthetic validation.', messages: [{ role: 'user', content: 'OK', timestamp: 1 }] }, {
    apiKey: 'synthetic-key-not-real', timeoutMs, maxRetries: 0,
    fetch: async () => { fetched = true; return sse({ content: 'OK' }, 1, 'stop'); }
  }).result();
  assert.equal(message.stopReason, 'error');
  assert.match(message.errorMessage, /timeout must be an integer/);
  assert.equal(fetched, false);
});

async function runSynthetic(t, responses, { policy = {}, mode = 'write', elapsedAfterFirstResponse = 0 } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-sdk-reliability-')), repo = path.join(base, 'repo');
  fs.mkdirSync(repo); fs.writeFileSync(path.join(repo, 'a.js'), 'export const n = 1;\n');
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const input = { repo_root: repo, objective: 'Synthetic reliability regression', read_files: ['a.js'], policy, agents: [{ id: 'worker', role: 'sparring-partner', task: mode === 'read' ? 'Review n; submit at most 8 findings.' : 'Inspect and stage n=2; submit at most 8 findings.', model: model.id, mode, write_files: mode === 'read' ? [] : ['a.js'], selection_reason: 'Synthetic SDK contract fixture.' }] };
  let time = 100000, calls = 0;
  const payloads = [], timeouts = [], provider = openrouterProvider();
  const result = await executeJob(input, path.join(base, 'run'), {
    Agent, runtimeLabel: 'installed_sdk_mock_transport', now: () => time, keyFor: () => 'synthetic-key-not-real', createPatch: createTwoFilesPatch,
    resolve: async () => ({ model, metadata: { provider: 'openrouter', requested_model: model.id, resolved_model: model.id, requested_effort: 'xhigh', effective_pi_effort: 'max', configured_provider_effort: 'max', max_output_tokens: 1000 } }),
    adapter: () => ({ streamSimple: (selected, context, options) => {
      timeouts.push(options.timeoutMs);
      return provider.streamSimple(selected, context, { ...options, fetch: async (input, init) => {
        payloads.push(JSON.parse(await new Request(input, init).text()));
        assert.ok(calls < responses.length, 'No request beyond the scripted authorized allowance');
        const response = responses[calls++];
        if (calls === 1) time += elapsedAfterFirstResponse;
        return sse(response.delta, calls, response.finish ?? 'tool_calls');
      } });
    } }), fetchGeneration: async () => ({ data: { total_cost: 0.00003, model: model.id, provider_name: 'synthetic' } })
  });
  return { ...result, payloads, timeouts, calls, repo };
}

test('read-only normal-stop repair offers only submission and preserves the original allowance', { timeout: 20000 }, async t => {
  const r = await runSynthetic(t, [
    { delta: tool('read_file', { path: 'a.js' }) },
    { delta: { content: 'Review evidence collected, but no structured submission.' }, finish: 'stop' },
    { delta: tool('submit_result', submission) }
  ], { mode: 'read' });
  const worker = r.report.agents[0];
  assert.equal(worker.status, 'completed');
  assert.equal(worker.limit_usage.completion_repairs, 1);
  assert.equal(worker.limits.max_turns, defaults.max_turns);
  assert.equal(worker.limits.timeout_seconds, defaults.timeout_seconds);
  assert.equal(worker.limits.session_budget_usd, defaults.session_budget_usd);
  assert.equal(worker.recovery_events[0].mode, 'finalization_only');
  assert.equal(worker.recovery_events[0].trigger, 'missing_submission');
  assert.deepEqual(r.payloads[2].tools.map(tool => tool.function.name), ['submit_result']);
  assert.match(JSON.stringify(r.payloads[2].messages), /FINALIZATION ONLY/);
  assert.equal(r.report.costs.request_count, 3);
  assert.equal(worker.changes.length, 0);
});

test('read-only repair cannot keep asking when the model ignores submission', { timeout: 20000 }, async t => {
  const r = await runSynthetic(t, [
    { delta: { content: 'I will investigate later.' }, finish: 'stop' },
    { delta: { content: 'Still no submission.' }, finish: 'stop' }
  ], { mode: 'read' });
  assert.equal(r.report.agents[0].status, 'missing_submission');
  assert.equal(r.report.agents[0].submission, null);
  assert.equal(r.calls, 2);
  assert.deepEqual(r.payloads[1].tools.map(tool => tool.function.name), ['submit_result']);
  assert.equal(r.report.agents[0].limit_usage.completion_repairs, 1);
});

test('runner floors fractional remaining milliseconds before the real SDK transport', { timeout: 20000 }, async t => {
  const r = await runSynthetic(t, [
    { delta: tool('read_file', { path: 'a.js' }) }, { delta: tool('submit_result', submission) }
  ], { elapsedAfterFirstResponse: 32041 });
  assert.equal(r.report.agents[0].status, 'completed');
  assert.equal(r.calls, 2);
  assert.deepEqual(r.timeouts, [600000, 567959]);
  const usage = JSON.parse(fs.readFileSync(path.join(r.out, 'usage.json')));
  assert.equal(usage.requests[1].request_timeout_seconds, 567.959);
});

test('real Agent receives only submit_result within the original request reserve', { timeout: 20000 }, async t => {
  const r = await runSynthetic(t, [
    { delta: tool('read_file', { path: 'a.js' }) },
    { delta: tool('write_file', { path: 'a.js', content: 'export const n = 2;\n' }) },
    { delta: tool('submit_result', submission) }
  ], { policy: { max_turns: 4, finalization_turns: 2 } });
  assert.equal(r.report.agents[0].status, 'completed');
  assert.equal(r.calls, 3); assert.equal(r.report.costs.request_count, 3);
  assert.equal(r.report.agents[0].limits.max_turns, 4);
  assert.equal(r.report.agents[0].finalization.requests_used, 2);
  assert.deepEqual(r.payloads[2].tools.map(tool => tool.function.name), ['submit_result']);
  assert.match(JSON.stringify(r.payloads[2].messages), /FINALIZATION ONLY/);
  assert.equal(fs.readFileSync(path.join(r.repo, 'a.js'), 'utf8'), 'export const n = 1;\n');
  assert.equal(fs.readFileSync(path.join(r.out, 'worker/candidate/a.js'), 'utf8'), 'export const n = 2;\n');
});

test('a model that ignores both reserve requests still stops at the hard ceiling with its candidate preserved', { timeout: 20000 }, async t => {
  const r = await runSynthetic(t, [
    { delta: tool('read_file', { path: 'a.js' }) },
    { delta: tool('write_file', { path: 'a.js', content: 'export const n = 2;\n' }) },
    { delta: { content: 'I intend to submit soon.' }, finish: 'stop' },
    { delta: { content: 'Still no structured submission.' }, finish: 'stop' }
  ], { policy: { max_turns: 4, finalization_turns: 2, max_completion_repairs: 1 } });
  assert.equal(r.report.agents[0].status, 'turn_limit');
  assert.equal(r.calls, 4); assert.equal(r.report.costs.request_count, 4);
  assert.equal(r.report.agents[0].limits.max_turns, 4);
  assert.equal(r.report.agents[0].limit_usage.completion_repairs, 1);
  for (const payload of r.payloads.slice(2)) assert.deepEqual(payload.tools.map(tool => tool.function.name), ['submit_result']);
  assert.equal(r.report.agents[0].submission, null);
  assert.equal(r.report.agents[0].changes.length, 1);
  assert.equal(fs.readFileSync(path.join(r.out, 'worker/candidate/a.js'), 'utf8'), 'export const n = 2;\n');
});
