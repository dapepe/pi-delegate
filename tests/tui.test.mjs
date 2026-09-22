import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

import { createTuiController, renderFrame, runTui, sanitizeTerminalText, TABS } from '../scripts/tui.mjs';

const previewStats = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'tui-preview.json'), 'utf8'));

function syntheticStats() {
  return {
    schema_version: 1,
    generated_at: '2026-09-22T12:00:00.000Z',
    period: { name: '30d', start: '2026-08-23T12:00:00.000Z', end: '2026-09-22T12:00:00.000Z' },
    selection: { projects: [
      { project_id: 'alpha-id', project_name: 'Alpha', path: '/tmp/alpha' },
      { project_id: 'beta-id', project_name: 'Alpha', path: '/tmp/beta' }
    ] },
    summary: { latest_assignments: 4, distinct_tasks: 3, latest_completed: 2, latest_failed: 1, latest_incomplete: 1, stale_checkpoints: 1, assignment_metadata_missing: 1,
      assessed_coverage: { usefulness: 2 }, quality: { mean: 2, assessed: 2, denominator: 3 }, usefulness: { mean: 2.5, assessed: 2, denominator: 3 } },
    costs: { known_usd: 0.1234, estimated_usd: 0.02, unknown_charge_requests: 1, request_count: 5, token_totals: { input: 100, input_known: 5, output: 50, output_known: 4, reasoning: 10, reasoning_known: 2, cache_read: 20, cache_read_known: 3, cache_write: 5, cache_write_known: 1, total: 165, total_known: 5 } },
    models: [{ profile_key: 'm1', label: 'openrouter/model-v1 · xhigh · codex', role: 'review', distinct_tasks: 2, latest_assignments: 2, total_attempts: 3, retry_attempts: 1,
      quality: { mean: 2, assessed: 2, denominator: 2 }, usefulness: { mean: 2.5, assessed: 2, denominator: 2 }, model: { provider: 'openrouter', resolved_model: 'model-v1', model_identity: 'model-v1', requested_model: 'model-v1', host: 'codex', effective_effort: 'xhigh', mode: 'read' }, raw_evidence_available: false }],
    focus_areas: [{ tag: 'security', assignments: 2, distinct_tasks: 2, quality: { mean: 2, assessed: 1, denominator: 2 }, usefulness: { mean: 2, assessed: 1, denominator: 2 }, raw_evidence_available: true }],
    tasks: [{ task_id: 'task-1', task_label: 'Review auth', project_name: 'Alpha', repo_path: '/tmp/alpha', attempts: [{ at: '2026-09-20', status: 'completed' }], latest: { at: '2026-09-20', status: 'completed', model: { resolved_model: 'model-v1', provider: 'openrouter', effective_effort: 'xhigh' }, quality_0_to_3: 2, usefulness_0_to_3: 3 } }]
  };
}

test('renderFrame is deterministic, responsive, and sanitizes untrusted display text', () => {
  const stats = syntheticStats();
  stats.tasks[0].task_label = 'Review\u001b[31m\u0007 auth';
  const first = renderFrame({ data: stats, tab: 0, projectIndex: 2 }, 110, 24, { color: false });
  const second = renderFrame({ data: stats, tab: 0, projectIndex: 2 }, 110, 24, { color: false });
  assert.equal(first, second);
  assert.match(first, /Alpha/);
  assert.match(first, /All 2 selected projects/);
  assert.match(first, /input 100 \(5\/5\)/);
  assert.match(first, /attempts per recent task/);
  assert.doesNotMatch(first, /\u001b/);
  for (const line of first.split('\n')) assert.ok(line.length <= 110);
  const narrow = renderFrame({ data: stats, tab: 3, projectIndex: 0 }, 36, 12, { color: false });
  assert.ok(narrow.split('\n').length <= 12);
  for (const line of narrow.split('\n')) assert.ok(line.length <= 36);
  assert.match(renderFrame({ data: stats, tab: 1 }, 100, 10, { color: true }), /\u001b\[/);
});

test('overview keeps token totals unknown until a measured count is available', () => {
  const stats = syntheticStats();
  stats.costs.token_totals.input = 0;
  stats.costs.token_totals.input_known = 0;
  const frame = renderFrame({ data: stats, tab: 0 }, 110, 24, { color: false });
  assert.match(frame, /input -- \(0\/5\)/);
});

test('summary cards use four, two, and compact layouts without exceeding the terminal budget', () => {
  const widths = [[110, /ASSIGNMENTS.*QUALITY.*USEFULNESS.*SPEND/], [70, /ASSIGNMENTS/], [36, /^A /m]];
  for (const [width, marker] of widths) {
    const frame = renderFrame({ data: previewStats, tab: 0, projectIndex: previewStats.selection.projects.length }, width, 24, { color: false });
    assert.match(frame, marker);
    for (const line of frame.split('\n')) assert.ok(line.length <= width, `${width}-column line exceeded budget: ${line}`);
  }
  const colored = renderFrame({ data: previewStats, tab: 0, projectIndex: 2 }, 36, 12, { color: true });
  assert.match(colored, /\u001b\[/);
  assert.match(colored, /\u001b\[0m/);
});

test('project switch selects project_views and Learning shows per-project lifecycle state', () => {
  const controller = createTuiController(previewStats);
  controller.handleKey('5');
  const combined = controller.render(80, 20, { color: false });
  assert.match(combined, /Alpha/);
  assert.match(combined, /Beta/);
  assert.match(combined, /Run learn init/);
  assert.match(controller.render(80, 20, { color: false }), /Review proposal/);
  controller.handleKey('p');
  assert.match(controller.render(80, 20, { color: false }), /Alpha/);
  controller.handleKey('p');
  const beta = controller.render(80, 20, { color: false });
  assert.match(beta, /Beta/);
  assert.match(beta, /Run learn init/);
  assert.match(beta, /uninitialized/);
});

test('selected rows scroll and asynchronous reload replaces the data', async () => {
  const many = structuredClone(previewStats);
  many.models = Array.from({ length: 12 }, (_, index) => ({
    profile_key: `model-${index}`, label: `model-${index}`, role: 'sparring-partner', distinct_tasks: index + 1,
    quality: { mean: null, assessed: 0, denominator: 0 }, usefulness: { mean: null, assessed: 0, denominator: 0 },
    model: { provider: 'fixture', resolved_model: `model-${index}`, requested_model: `model-${index}`, host: 'codex', effective_effort: 'xhigh', mode: 'read' }
  }));
  let changed = 0;
  const next = structuredClone(previewStats); next.generated_at = '2026-09-22T13:00:00.000Z';
  const controller = createTuiController(many, { reload: async () => next, onChange: () => { changed++; } });
  controller.handleKey('2');
  for (let i = 0; i < 8; i++) controller.handleKey('j');
  assert.match(controller.render(44, 12, { color: false }), /model-8/);
  controller.handleKey('r');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(controller.state.data.generated_at, next.generated_at);
  assert.ok(changed >= 2);
});

test('controller handles tabs, search, project cycle, details, and quit', () => {
  const controller = createTuiController(syntheticStats());
  assert.equal(controller.state.tab, 0);
  controller.handleKey('2'); assert.equal(controller.state.tab, 1);
  controller.handleKey('j'); assert.equal(controller.state.selected, 0); // one synthetic model row
  controller.handleKey('/');
  controller.handleKey('m'); controller.handleKey('o'); controller.handleKey('q'); controller.handleKey('j'); controller.handleKey('p'); controller.handleKey('r');
  assert.equal(controller.state.search, 'moqjpr');
  controller.handleKey('enter'); assert.equal(controller.state.searching, false);
  controller.handleKey('p'); assert.equal(controller.state.projectIndex, 0);
  controller.handleKey('p'); assert.equal(controller.state.projectIndex, 1);
  controller.handleKey('enter'); assert.equal(controller.state.detail, true);
  controller.handleKey('esc'); assert.equal(controller.state.detail, false);
  controller.handleKey('\u0003'); assert.equal(controller.state.exited, true);
  assert.equal(TABS.length, 5);
});

test('runTui restores raw mode and redraws on resize before Ctrl-C', async () => {
  class FakeInput extends EventEmitter {
    constructor() { super(); this.isTTY = true; this.isRaw = false; this.readableEncoding = null; }
    setRawMode(value) { this.isRaw = value; }
    setEncoding(value) { this.readableEncoding = value; }
    resume() { this.resumed = true; }
    pause() { this.paused = true; }
  }
  const input = new FakeInput();
  const writes = [];
  const output = { isTTY: true, columns: 80, rows: 18, write(value) { writes.push(value); } };
  const pending = runTui(syntheticStats(), { input, output, color: false });
  input.emit('resize');
  input.emit('data', '\u0003');
  const state = await pending;
  assert.equal(state, undefined);
  assert.equal(input.isRaw, false);
  assert.equal(input.paused, true);
  assert.ok(writes.some(value => value.includes('\u001b[2J')));
  assert.ok(writes.some(value => value.includes('\u001b[0m')));
});

test('sanitizeTerminalText removes ANSI and C0/C1 controls', () => {
  assert.equal(sanitizeTerminalText('\u001b]8;;https://bad\u0007click\u001b]8;;\u0007\u0000\u009b'), 'click');
});
