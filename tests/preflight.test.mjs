/** Synthetic planning fixtures; no catalog request or paid inference. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { preflightAdvice } from '../scripts/preflight.mjs';
const defaults = JSON.parse(fs.readFileSync(new URL('../defaults.json', import.meta.url)));
const plan = (policy = {}, agent = {}, context = 'Return at most 8 findings.') => ({
  policy: { ...defaults, ...policy }, context,
  agents: [{ id: 'worker', task: 'Stage a synthetic change.', read_files: ['one.js'], write_files: ['one.js'], mode: 'write', ...agent }]
});

test('the reported single-file 14-request/50-tool plan receives operation and sequential-use advice', () => {
  const advice = preflightAdvice(plan({ max_turns: 14, max_tool_calls: 50 }));
  assert.ok(advice.some(value => /14 provider requests leave 12 investigation\/edit request\(s\) before 2 reserved/.test(value)));
  assert.ok(advice.some(value => /one dense file can need many replacements/.test(value)));
  assert.ok(advice.some(value => /one sequential tool call per response/.test(value)));
  assert.ok(advice.some(value => /response can contain multiple tool calls/.test(value)));
  assert.ok(!advice.some(value => /36.*unreachable/.test(value)));
});

test('a small turn allocation increase does not hide write advice and allocations remain unchanged', () => {
  for (const max_turns of [12, 14, 20]) {
    const input = plan({ max_turns });
    const before = structuredClone(input);
    assert.ok(preflightAdvice(input).some(value => /Estimate sequential reads and edit operations/.test(value)));
    assert.deepEqual(input, before);
  }
});

test('worker allocation and capped reserves determine the usable working requests', () => {
  const input = plan({ max_turns: 30 }, { limits: { max_turns: 6 } });
  assert.ok(preflightAdvice(input).some(value => /6 provider requests leave 4/.test(value)));
  assert.ok(preflightAdvice(plan({ timeout_seconds: 40 })).some(value => /capped to 10 s/.test(value)));
});

test('a submission cap may be in the task or shared context, but a bare mention is insufficient', () => {
  assert.ok(!preflightAdvice(plan()).some(value => /no numeric submission cap/.test(value)));
  assert.ok(!preflightAdvice(plan({}, { task: 'Return under 1,200 words.' }, '')).some(value => /no numeric submission cap/.test(value)));
  assert.ok(preflightAdvice(plan({}, { task: 'Return findings and few words.' }, '')).some(value => /no numeric submission cap/.test(value)));
});

test('read workers do not receive write advice and optional effort metadata stays truthful', () => {
  const input = plan({}, { mode: 'read', write_files: [] });
  const advice = preflightAdvice(input, [{ agent: 'worker', effort_mapping: 'best_supported', requested_effort: 'xhigh', effective_pi_effort: 'high' }]);
  assert.ok(!advice.some(value => /Estimate sequential reads and edit operations/.test(value)));
  assert.ok(advice.some(value => /reported as high/.test(value)));
});
