#!/usr/bin/env node
/** Verify the installed SDK contract without authentication or inference. */
import assert from 'node:assert/strict';
import { installedPackage } from './environment.mjs';
import { Agent } from '@earendil-works/pi-agent-core';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import { createTwoFilesPatch } from 'diff';
import { openRouterModel } from './lib.mjs';

const [major, minor] = process.versions.node.split('.').map(Number);
assert.ok(major > 22 || (major === 22 && minor >= 19), 'Node >=22.19.0 is required');
for (const name of ['@earendil-works/pi-agent-core', '@earendil-works/pi-ai']) {
  const installed = installedPackage(name).version;
  assert.equal(installed, '0.85.1', `Unexpected ${name} version; review the SDK contract before upgrading`);
}
const adapter = openrouterProvider();
assert.equal(typeof adapter.getModels, 'function');
assert.equal(typeof adapter.streamSimple, 'function');
const model = openRouterModel({
  id: 'offline/contract-check', name: 'Offline contract check',
  architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  supported_parameters: ['tools', 'reasoning'], reasoning: { supported_efforts: ['high', 'max'] },
  pricing: { prompt: '0.000001', completion: '0.000002' },
  context_length: 128000, top_provider: { max_completion_tokens: 32768 }
}, { require_parameters: true });
const levels = getSupportedThinkingLevels(model);
assert.ok(levels.includes('max'));
assert.ok(!levels.includes('xhigh'));
const agent = new Agent({
  initialState: { model, systemPrompt: 'Offline contract check.', thinkingLevel: 'max', messages: [], tools: [] },
  streamFn: () => { throw new Error('No inference is permitted during this contract check'); },
  shouldStopAfterTurn: () => true, toolExecution: 'sequential'
});
assert.equal(typeof agent.prompt, 'function');
assert.equal(typeof agent.subscribe, 'function');
assert.equal(typeof agent.abort, 'function');
const patch = createTwoFilesPatch('a/a.txt', 'b/a.txt', 'before\n', 'after\n', '', '', { context: 3 });
assert.ok(patch.includes('-before\n+after'));
console.log('Installed SDK exports, version pins, model effort mapping, Agent construction and diff generation passed. No provider request was made.');
