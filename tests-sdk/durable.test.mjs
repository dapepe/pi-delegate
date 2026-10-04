/** Real pinned Durable/AI SDK, synthetic SSE and process death. No paid inference. */
import nodeTest from 'node:test';
import { fileURLToPath } from 'node:url';
const test = (name, options, body) => nodeTest(name, { ...options, skip: process.platform === 'win32' }, body);
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { initDurable, inspectDurable, runDurable, reviewDurable } from '../scripts/durable.mjs';
import { runSupervision } from '../scripts/supervision.mjs';
import { reconcileRun } from '../scripts/pi.mjs';
import { model, submission, dependencies, approval } from './durable-fixture.mjs';
const json = file => JSON.parse(fs.readFileSync(file));
function fixture(t, policy = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-durable-test-')), repo = path.join(base, 'repo');
  fs.mkdirSync(repo); fs.writeFileSync(path.join(repo, 'a.js'), 'export const n = 1;\n');
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const plan = { repo_root: repo, objective: 'Synthetic Durable conformance', read_files: ['a.js'], policy,
    agents: [{ id: 'worker', role: 'sparring partner', task: 'Inspect n and submit', mode: 'read', model: model.id, selection_reason: 'Synthetic transport fixture' }] };
  const directory = path.join(base, 'session');
  initDurable(plan, directory, 'synthetic-native', true);
  return { base, repo, directory, plan };
}
const records = dir => json(path.join(dir, 'run/recovery.json'));
const payloads = dir => fs.readFileSync(path.join(dir, 'synthetic-payloads.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
function crash(directory, trigger) {
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('./durable-fixture.mjs', import.meta.url)), directory, trigger], { timeout: 10000, encoding: 'utf8' });
  assert.equal(child.signal, 'SIGKILL', child.stderr); assert.equal(inspectDurable(directory).owner_process_alive, false);
}

test('Durable retains a private transcript, shares guarded submission/costs and requires advisory review', { timeout: 15000 }, async t => {
  const { directory, repo } = fixture(t);
  const result = await runDurable(directory, null, dependencies(directory));
  assert.equal(result.agents[0].status, 'completed');
  const recovery = records(directory), worker = recovery.report.agents[0];
  assert.equal(recovery.report.sdk_version_target, '1.0.0'); assert.equal(recovery.report.mode, 'installed_durable_sdk_mock_transport');
  assert.equal(worker.coverage.reads.length, 1); assert.equal(worker.limit_usage.tool_calls, 2);
  assert.equal(recovery.requests.length, 2); assert.equal(recovery.report.costs.provider_reported_usd, 0.00006);
  assert.match(recovery.report.notes.join('\n'), /Private Durable transcripts/);
  assert.equal(fs.readFileSync(path.join(repo, 'a.js'), 'utf8'), 'export const n = 1;\n');
  assert.ok(fs.readdirSync(path.join(directory, 'transcript')).length > 0);
  const inspected = inspectDurable(directory);
  assert.equal(inspected.owner, null); assert.equal(inspected.status, 'awaiting_review');
  await assert.rejects(runDurable(directory, null, dependencies(directory)), /settled/);
  await assert.rejects(runSupervision(directory), /already started/);
  await reviewDurable(directory, { native_agent_id: result.native_agent_id, artifact_fingerprint: inspected.artifact_fingerprint, verdict: 'ready_for_host', summary: 'Synthetic advisory review only.' });
  assert.equal(inspectDurable(directory).status, 'reviewed');
  assert.equal(inspectDurable(directory).review_current, true);
  fs.appendFileSync(path.join(directory, 'run/report.md'), '\nSynthetic post-review mutation.\n');
  assert.equal(inspectDurable(directory).review_current, false);
});
test('crash before dispatch keeps its reservation and counts a resumed dispatch as another request', { timeout: 15000 }, async t => {
  const { directory } = fixture(t); crash(directory, 'admission');
  const before = records(directory), inspected = inspectDurable(directory);
  assert.equal(before.requests.length, 1); assert.equal(before.requests[0].status, 'in_flight');
  assert.equal(before.requests[0].billed_usd, null); assert.ok(before.requests[0].reserved_usd > 0);
  const startedAt = json(path.join(directory, 'durable-state.json')).started_at;
  await assert.rejects(runDurable(directory, { ...approval(directory), artifact_fingerprint: 'wrong' }, dependencies(directory)), /changed since/);
  const result = await runDurable(directory, approval(directory), dependencies(directory));
  assert.equal(result.agents[0].status, 'completed');
  const after = records(directory);
  assert.equal(after.requests.length, 3); assert.deepEqual(after.requests.map(item => item.id), ['worker:1', 'worker:2', 'worker:3']);
  assert.equal(after.requests[0].status, 'interrupted'); assert.equal(after.requests[0].reserved_usd, before.requests[0].reserved_usd);
  assert.equal(after.report.costs.unpriced_request_count, 1); assert.equal(after.report.costs.all_requests_reconciled, false);
  assert.equal(after.report.agents[0].started_at, startedAt);
  assert.equal(inspectDurable(directory).original_deadline_at, inspected.original_deadline_at);
  assert.equal(payloads(directory).length, 2);
});
for (const tool of ['read_file', 'submit_result']) test(`crash after ${tool} receipt commit replays safely without another read/submission`, { timeout: 15000 }, async t => {
  const { directory } = fixture(t); crash(directory, `commit:${tool}`);
  const countBefore = payloads(directory).length;
  const result = await runDurable(directory, approval(directory), dependencies(directory));
  assert.equal(result.agents[0].status, 'completed');
  const recovery = records(directory), worker = recovery.report.agents[0];
  assert.equal(recovery.requests.length, 2); assert.equal(worker.limit_usage.tool_calls, 2);
  assert.equal(worker.coverage.reads.length, 1); assert.deepEqual(worker.submission, submission);
  assert.equal(payloads(directory).length, tool === 'submit_result' ? countBefore : countBefore + 1);
});
test('recovery refuses a live owner and source drift before dispatch', { timeout: 15000 }, async t => {
  const { directory, repo } = fixture(t); crash(directory, 'admission');
  const ownerFile = path.join(directory, 'durable.lock/owner.json'), oldOwner = json(ownerFile);
  fs.writeFileSync(ownerFile, JSON.stringify({ ...oldOwner, pid: process.pid }));
  await assert.rejects(runDurable(directory, approval(directory), dependencies(directory)), /alive or its death is unknown/);
  fs.writeFileSync(ownerFile, JSON.stringify(oldOwner));
  fs.writeFileSync(path.join(repo, 'a.js'), 'changed\n');
  await assert.rejects(runDurable(directory, approval(directory), dependencies(directory)), /snapshot changed/);
  assert.equal(payloadsExist(directory), false);
});
function payloadsExist(directory) { return fs.existsSync(path.join(directory, 'synthetic-payloads.jsonl')); }
test('resumed requests obey the original turn ceiling', { timeout: 15000 }, async t => {
  const { directory } = fixture(t, { max_turns: 1, finalization_turns: 0, max_completion_repairs: 0 });
  crash(directory, 'admission');
  const result = await runDurable(directory, approval(directory), dependencies(directory));
  assert.equal(result.agents[0].status, 'turn_limit'); assert.equal(records(directory).requests.length, 1); assert.equal(payloadsExist(directory), false);
});
test('recovery refuses missing ledgers and changed model capabilities without inference', { timeout: 15000 }, async t => {
  for (const failure of ['ledger', 'model']) {
    const { directory } = fixture(t); crash(directory, 'admission');
    const deps = dependencies(directory);
    if (failure === 'ledger') fs.unlinkSync(path.join(directory, 'run/recovery.json'));
    else { const resolve = deps.resolve; deps.resolve = async () => { const result = await resolve(); return { ...result, model: { ...result.model, contextWindow: 64000 } }; }; }
    await assert.rejects(runDurable(directory, approval(directory), deps), failure === 'ledger' ? /recovery ledger/ : /capabilities changed/);
    assert.equal(payloadsExist(directory), false);
  }
});
test('a refreshed catalog observation timestamp does not change a recovery grant', { timeout: 15000 }, async t => {
  const { directory } = fixture(t); crash(directory, 'admission');
  const frozenFile = path.join(directory, 'durable-model.json'), frozen = json(frozenFile);
  frozen.metadata.checked_at = '2026-10-01T00:00:00Z'; fs.writeFileSync(frozenFile, JSON.stringify(frozen));
  const deps = dependencies(directory), resolve = deps.resolve;
  deps.resolve = async () => { const resolved = await resolve(); resolved.metadata.checked_at = '2026-10-03T00:00:00Z'; return resolved; };
  assert.equal((await runDurable(directory, approval(directory), deps)).agents[0].status, 'completed');
});
test('billing maintenance syncs recovery, preserves known charges and blocks resumed overspending', { timeout: 15000 }, async t => {
  const { directory } = fixture(t); crash(directory, 'response');
  // Synthetic delayed billing: first response was initially unavailable.
  for (const file of ['run/recovery.json', 'run/usage.json']) {
    const value = json(path.join(directory, file)), request = value.requests[0];
    request.billed_usd = null; delete request.reconciled_at; fs.writeFileSync(path.join(directory, file), JSON.stringify(value));
  }
  const ownerFile = path.join(directory, 'durable.lock/owner.json'), oldOwner = json(ownerFile);
  fs.writeFileSync(ownerFile, JSON.stringify({ ...oldOwner, pid: process.pid }));
  await assert.rejects(reconcileRun(path.join(directory, 'run'), { keyFor: () => 'fixture', fetchGeneration: async () => ({ data: { total_cost: 100, model: model.id } }) }), /settled or confirmed-dead/);
  fs.writeFileSync(ownerFile, JSON.stringify(oldOwner));
  await reconcileRun(path.join(directory, 'run'), { keyFor: () => 'fixture', fetchGeneration: async () => ({ data: { total_cost: 100, model: model.id } }) });
  assert.equal(records(directory).requests[0].billed_usd, 100);
  const deps = dependencies(directory); deps.fetchGeneration = async () => { throw new Error('Synthetic billing unavailable after known charge'); };
  const count = payloads(directory).length, result = await runDurable(directory, approval(directory), deps);
  assert.equal(result.agents[0].status, 'budget_limit'); assert.equal(payloads(directory).length, count);
  assert.equal(records(directory).requests[0].billed_usd, 100); assert.equal(records(directory).requests.length, 1);
});
test('recovery preserves billing reconciled into an older diagnostic-only ledger', { timeout: 15000 }, async t => {
  const { directory } = fixture(t); crash(directory, 'response');
  const recovery = records(directory); recovery.requests[0].billed_usd = null; fs.writeFileSync(path.join(directory, 'run/recovery.json'), JSON.stringify(recovery));
  const file = path.join(directory, 'run/usage.json'), usage = json(file); usage.requests[0].billed_usd = 100; fs.writeFileSync(file, JSON.stringify(usage));
  assert.equal(inspectDurable(directory).costs.provider_reported_usd, 100);
  const count = payloads(directory).length, result = await runDurable(directory, approval(directory), dependencies(directory));
  assert.equal(result.agents[0].status, 'budget_limit'); assert.equal(payloads(directory).length, count);
  assert.equal(records(directory).requests[0].billed_usd, 100);
});
test('a crash between ledger writes preserves observed usage and unreconciled SDK estimates', { timeout: 15000 }, async t => {
  const { directory } = fixture(t); crash(directory, 'response');
  const usage = json(path.join(directory, 'run/usage.json'));
  usage.requests[0].billed_usd = null; fs.writeFileSync(path.join(directory, 'run/usage.json'), JSON.stringify(usage));
  const recovery = records(directory);
  Object.assign(recovery.requests[0], { billed_usd: null, estimate_usd: null, usage: null, status: 'in_flight' });
  fs.writeFileSync(path.join(directory, 'run/recovery.json'), JSON.stringify(recovery));
  const deps = dependencies(directory); deps.fetchGeneration = async () => { throw new Error('Synthetic billing unavailable'); };
  assert.equal((await runDurable(directory, approval(directory), deps)).agents[0].status, 'completed');
  const after = records(directory);
  assert.deepEqual(after.requests[0].usage, usage.requests[0].usage);
  assert.equal(after.requests[0].estimate_usd, usage.requests[0].estimate_usd);
  assert.equal(after.requests[0].billed_usd, null);
  assert.ok(after.report.costs.estimated_unreconciled_usd > 0);
  assert.equal(after.report.costs.unpriced_request_count, 0);
});
test('host review and process downtime cannot restart the original elapsed deadline', { timeout: 15000 }, async t => {
  const { directory } = fixture(t); crash(directory, 'admission');
  const inspected = inspectDurable(directory), deps = dependencies(directory);
  deps.now = () => Date.parse(inspected.original_deadline_at) + 1000;
  const result = await runDurable(directory, approval(directory), deps);
  assert.equal(result.agents[0].status, 'timeout'); assert.equal(records(directory).requests.length, 1);
  assert.equal(inspectDurable(directory).original_deadline_at, inspected.original_deadline_at); assert.equal(payloadsExist(directory), false);
});
test('Durable normal-stop repair serializes submission-only tools and remains bounded', { timeout: 15000 }, async t => {
  const { directory } = fixture(t);
  await runDurable(directory, null, dependencies(directory, '', [{ text: 'Here is my plan.' }, { name: 'submit_result', args: { ...submission, completion: 'partial', remaining_work: ['Inspect n'] } }]));
  const requests = payloads(directory);
  assert.deepEqual(requests[1].tools.map(tool => tool.function.name), ['submit_result']);
  assert.equal(records(directory).report.agents[0].status, 'partial');
});
