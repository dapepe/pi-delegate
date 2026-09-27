/** Real installed SDK with synthetic SSE fetch only. Never contacts a live endpoint. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Agent } from '@earendil-works/pi-agent-core';
import { createTwoFilesPatch } from 'diff';
import { mergePolicy } from '../scripts/lib.mjs';
import { resolveCompatibleModel, compatibleKeyFor, loadCompatibleAdapter } from '../scripts/compatible.mjs';
import { executeJob } from '../scripts/pi.mjs';

globalThis.fetch = async () => { throw new Error('Unexpected external fetch in compatible SDK tests'); };
const defaults = JSON.parse(fs.readFileSync(new URL('../defaults.json', import.meta.url)));
const provider = 'compatible:synthetic', modelId = 'fixture/model';
const policy = () => mergePolicy(defaults, {
  preferred_provider: provider, preferred_models: [modelId],
  openai_compatible_providers: { [provider]: {
    base_url: 'https://fixture.invalid/v1', auth: { type: 'env', env: 'PI_SYNTHETIC_TOKEN' },
    models: { [modelId]: { context_window: 128000, max_output_tokens: 2000, supports_tools: true, supported_efforts: ['high', 'max'], rates_usd_per_million: { input: 1, output: 2, cacheRead: 1, cacheWrite: 1 } } }
  } }
});
const context = { systemPrompt: 'Synthetic test', messages: [{ role: 'user', content: 'Fixture', timestamp: 1 }] };
const sse = (delta, finish = 'stop', responseModel = modelId) => {
  const base = { id: 'synthetic-response', model: responseModel, object: 'chat.completion.chunk', created: 1 };
  const chunks = [{ ...base, choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] }, { ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }];
  return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
};

test('compatible real SDK serializes approved model, effort, limits and only its explicit credential', async () => {
  const p = policy(), { model } = resolveCompatibleModel(p, { provider, model: modelId, effort: 'xhigh' });
  let calls = 0;
  const adapter = await loadCompatibleAdapter(p, provider, async request => {
    calls++; assert.equal(request.url, 'https://fixture.invalid/v1/chat/completions');
    assert.equal(request.redirect, 'error'); assert.equal(request.credentials, 'omit');
    assert.equal(request.headers.get('authorization'), 'Bearer synthetic-configured-token');
    assert.equal(request.headers.get('openai-organization'), null); assert.equal(request.headers.get('openai-project'), null);
    const body = await request.json(); assert.equal(body.model, modelId); assert.equal(body.reasoning_effort, 'max');
    assert.equal(body.max_tokens, 1000); assert.equal(body.stream_options.include_usage, true); assert.equal(body.store, undefined);
    return sse({ content: 'Synthetic answer' });
  });
  const result = await adapter.streamSimple(model, context, { reasoning: 'max', apiKey: compatibleKeyFor(p, provider, { PI_SYNTHETIC_TOKEN: 'synthetic-configured-token', OPENAI_API_KEY: 'do-not-send-this-synthetic-key' }), maxTokens: 1000 }).result();
  assert.equal(result.stopReason, 'stop', result.errorMessage); assert.equal(calls, 1); assert.equal(result.responseModel || result.model, modelId);
});

test('explicit unauthenticated non-reasoning route sends no authorization and no reasoning effort', async () => {
  const p = policy(), config = p.openai_compatible_providers[provider]; config.auth = { type: 'none' };
  config.models[modelId].supported_efforts = ['off']; config.models[modelId].non_reasoning_approval = 'Explicit synthetic test approval';
  config.models[modelId].compat = { max_tokens_field: 'max_completion_tokens', supports_usage_in_streaming: false };
  const { model } = resolveCompatibleModel(p, { provider, model: modelId, effort: 'off' });
  const adapter = await loadCompatibleAdapter(p, provider, async request => {
    assert.equal(request.headers.get('authorization'), null);
    const body = await request.json(); assert.equal(body.reasoning_effort, undefined); assert.equal(body.stream_options, undefined); assert.equal(body.max_completion_tokens, 1000);
    return sse({ content: 'Non-reasoning fixture' });
  });
  const result = await adapter.streamSimple(model, context, { reasoning: 'off', apiKey: 'accidental-unrelated-key-must-be-ignored', maxTokens: 1000 }).result();
  assert.equal(result.stopReason, 'stop', result.errorMessage);
});

test('redirects, changed destinations and mutated payloads fail closed without fallback or retries', async () => {
  const p = policy(), { model } = resolveCompatibleModel(p, { provider, model: modelId, effort: 'max' });
  let calls = 0;
  const adapter = await loadCompatibleAdapter(p, provider, async () => { calls++; return new Response('', { status: 307, headers: { location: 'https://unapproved.invalid' } }); });
  const options = { reasoning: 'max', apiKey: 'synthetic-key', maxTokens: 1000 };
  const result = await adapter.streamSimple(model, context, options).result();
  assert.equal(result.stopReason, 'error'); assert.equal(calls, 1);
  assert.throws(() => adapter.streamSimple({ ...model, baseUrl: 'https://unapproved.invalid' }, context, options), /approved route/);
  const mutated = await adapter.streamSimple(model, context, { ...options, onPayload: body => ({ ...body, model: 'unapproved-model' }) }).result();
  assert.equal(mutated.stopReason, 'error'); assert.equal(calls, 1);
  assert.match(mutated.errorMessage, /approved model/);
});

async function executeFixture(t, mismatch = false) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-compatible-sdk-')), repo = path.join(base, 'repo'); fs.mkdirSync(repo); fs.writeFileSync(path.join(repo, 'a.js'), 'export const n = 1;\n');
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const p = policy();
  const calls = [['write_file', { path: 'a.js', content: 'export const n = 2;\n' }], ['submit_result', { summary: 'Synthetic candidate; no tests run', findings: [], proposed_tests: [], open_questions: [], completion: 'complete', remaining_work: [] }]];
  let count = 0;
  const adapter = await loadCompatibleAdapter(p, provider, async request => {
    const payload = await request.json(); assert.equal(payload.model, modelId); assert.equal(payload.reasoning_effort, 'max');
    if (mismatch) return sse({ content: 'Wrong model fixture' }, 'stop', 'other/model');
    assert.ok(count < calls.length); const [name, args] = calls[count++];
    return sse({ tool_calls: [{ index: 0, id: `fixture-tool-${count}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, 'tool_calls');
  });
  const input = { repo_root: repo, objective: 'Synthetic compatible SDK candidate test', read_files: ['a.js'], policy: p, agents: [{ id: 'worker', provider, model: modelId, mode: 'write', write_files: ['a.js'], task: 'Stage synthetic n=2', selection_reason: 'Synthetic SDK test' }] };
  const result = await executeJob(input, path.join(base, 'run'), { Agent, runtimeLabel: 'installed_sdk_mock_transport', keyFor: () => 'synthetic-key', resolve: async a => resolveCompatibleModel(p, a), adapter: () => adapter, createPatch: createTwoFilesPatch });
  return { ...result, repo, count };
}
test('real compatible Agent stages isolated candidate tools and submits without touching source', async t => {
  const result = await executeFixture(t);
  assert.equal(result.report.agents[0].status, 'completed'); assert.equal(result.count, 2);
  assert.equal(fs.readFileSync(path.join(result.repo, 'a.js'), 'utf8'), 'export const n = 1;\n');
  assert.equal(fs.readFileSync(path.join(result.out, 'worker/candidate/a.js'), 'utf8'), 'export const n = 2;\n');
  assert.equal(result.report.costs.provider_reported_usd, 0); assert.equal(result.report.costs.all_requests_reconciled, false);
});
test('a compatible endpoint returning an unauthorized model remains model_mismatch', async t => {
  const result = await executeFixture(t, true);
  assert.equal(result.report.agents[0].status, 'model_mismatch'); assert.equal(result.report.costs.request_count, 1);
});
