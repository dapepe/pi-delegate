/** Shared synthetic transport for Durable process-crash tests. Never uses a live endpoint. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import { openRouterModel } from '../scripts/lib.mjs';
import { inspectDurable, runDurable } from '../scripts/durable.mjs';

const defaults = JSON.parse(fs.readFileSync(new URL('../defaults.json', import.meta.url)));
export const model = openRouterModel({ id: defaults.preferred_models[1], reasoning: { supported_efforts: ['high', 'max'] },
  pricing: { prompt: '0.000001', completion: '0.000002' }, context_length: 128000, top_provider: { max_completion_tokens: 32768 } }, defaults.openrouter_routing);
export const submission = { summary: 'Synthetic snapshot inspected; tests not run by worker', findings: [], proposed_tests: [], open_questions: [], completion: 'complete', remaining_work: [] };
export function dependencies(directory, crash = '', responses = null) {
  globalThis.fetch = async () => { throw new Error('Unexpected external fetch in Durable fixtures'); };
  let calls = 0;
  const die = () => process.kill(process.pid, 'SIGKILL');
  return {
    runtimeLabel: 'installed_durable_sdk_mock_transport',
    keyFor: () => 'synthetic-fixture-key-not-real',
    resolve: async () => ({ model, metadata: { provider: 'openrouter', requested_model: model.id, resolved_model: model.id,
      effective_pi_effort: 'max', configured_provider_effort: 'max', max_output_tokens: 1000 } }),
    adapter: () => ({ streamSimple: (selected, context, options) => openrouterProvider().streamSimple(selected, context, { ...options, fetch: async (input, init) => {
      calls++;
      const payload = JSON.parse(await new Request(input, init).text());
      fs.appendFileSync(path.join(directory, 'synthetic-payloads.jsonl'), JSON.stringify(payload) + '\n', { mode: 0o600 });
      const readDone = context.messages.some(message => message.role === 'toolResult' && message.toolName === 'read_file');
      const action = responses?.[calls - 1] || { name: readDone ? 'submit_result' : 'read_file', args: readDone ? submission : { path: 'a.js' } };
      const delta = action.text ? { content: action.text } : { tool_calls: [{ index: 0, id: `fixture-${calls}-${action.name}`, type: 'function', function: { name: action.name, arguments: JSON.stringify(action.args) } }] };
      const base = { id: `fixture-response-${calls}`, model: selected.id, object: 'chat.completion.chunk', created: 1 };
      const chunks = [{ ...base, choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] },
        { ...base, choices: [{ index: 0, delta: {}, finish_reason: action.finish || (action.text ? 'stop' : 'tool_calls') }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }];
      return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    } }) }),
    fetchGeneration: async () => ({ data: { total_cost: 0.00003, model: model.id } }),
    onProgress: event => { if (crash === 'admission' && event.type === 'request_started') die(); },
    durableHooks: { afterToolCommit: ({ tool }) => { if (crash === `commit:${tool}`) die(); },
      afterResponse: () => { if (crash === 'response') die(); } }
  };
}
export function approval(directory, inspected = inspectDurable(directory)) {
  return { reviewed_by: 'codex', native_agent_id: 'synthetic-recovery-native', previous_process_dead: true, artifact_fingerprint: inspected.artifact_fingerprint };
}
// Invoked only by the subprocess tests; no implicit execution on import.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = process.argv[2], crash = process.argv[3];
  await runDurable(directory, null, dependencies(directory, crash));
}
