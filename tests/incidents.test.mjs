/** Entirely synthetic local fixtures. No inference, provider calls, or home-directory writes. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../scripts/lib.mjs';
import { incidentSnapshot, needsIncident, tryWriteIncident, writeIncident } from '../scripts/incidents.mjs';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-incidents-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const at = '2026-01-01T00:00:00.000Z';
const report = (status = 'missing_submission') => ({
  run_id: 'synthetic-run', skill_version: '1.6.1', created_at: at, updated_at: at, finished_at: at,
  agents: [{ id: 'synthetic-worker', status, elapsed_seconds: 2, model: { provider: 'synthetic-provider', requested_model: 'synthetic-model' },
    limits: { max_turns: 2 }, limit_usage: { requests: 2, tool_calls: 1 }, stop_causes: [status],
    changes: [{ file: 'synthetic.js', action: 'modify', before_sha256: sha256('before'), after_sha256: sha256('after') }] }]
});
const usage = () => ({ requests: [
  { agent_id: 'synthetic-worker', status: 'stop', seconds: 1, billed_usd: 0.12, estimate_usd: 0.50, usage: { output: 100, reasoning: 90 } },
  { agent_id: 'synthetic-worker', status: 'error', seconds: 2, estimate_usd: 0.03 },
  { agent_id: 'synthetic-worker', status: 'in_flight', reserved_usd: 10 }
] });
function save(root, r = report(), u = usage()) {
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(r), { mode: 0o600 });
  fs.writeFileSync(path.join(root, 'usage.json'), JSON.stringify(u), { mode: 0o600 });
}

test('incident files are private, idempotent, structural and preserve truthful cost categories', t => {
  const root = fixture(t); save(root);
  const before = fs.readFileSync(path.join(root, 'report.json'), 'utf8');
  const first = writeIncident(root), repeated = writeIncident(root);
  assert.equal(first.status, 'written'); assert.equal(repeated.status, 'existing');
  assert.equal(first.fingerprint, repeated.fingerprint);
  assert.equal(fs.statSync(path.join(root, 'incidents')).mode & 0o777, 0o700);
  assert.equal(fs.statSync(first.json).mode & 0o777, 0o600);
  assert.equal(fs.statSync(first.markdown).mode & 0o777, 0o600);
  const { snapshot } = JSON.parse(fs.readFileSync(first.json));
  assert.equal(snapshot.workers[0].worker_id_sha256, sha256('synthetic-worker'));
  assert.equal(snapshot.workers[0].candidates[0].after_sha256, sha256('after'));
  assert.deepEqual(snapshot.requests.costs, { provider_reported_usd: 0.12, reconciled_request_count: 1,
    estimated_unreconciled_usd: 0.03, unresolved_request_count: 2, unpriced_request_count: 1 });
  assert.deepEqual(snapshot.requests.tokens.reasoning, { observed_request_count: 1, total: 90 });
  assert.deepEqual(snapshot.requests.tokens.input, { observed_request_count: 0, total: null });
  assert.equal(fs.readFileSync(path.join(root, 'report.json'), 'utf8'), before);
  assert.match(fs.readFileSync(first.markdown, 'utf8'), /Process state is unverified/);
  assert.doesNotMatch(fs.readFileSync(first.json, 'utf8'), /synthetic\.js|synthetic-worker|synthetic-provider|synthetic-model/);
});

test('allowlist excludes injected secrets, URLs, prompts, output, raw errors, reasons and arbitrary keys', t => {
  const root = fixture(t), secret = 'SECRET_CANARY', url = 'https://sensitive.invalid/?token=SECRET_CANARY';
  const r = report(secret), u = usage();
  Object.assign(r, { objective: secret, source_repo: secret, cancellation_signal: secret, orchestration_errors: [{ error: secret }], apiKey: secret });
  Object.assign(r.agents[0], { id: secret, task: secret, warnings: [secret], failure_class: secret, failure_hint: secret,
    partial_output: { text: secret }, submission: { summary: secret, completion: secret, remaining_work: [secret] },
    model: { provider: url, requested_model: secret, requested_effort: secret, endpoint: url },
    limits: { max_turns: secret, [secret]: 1 }, changes: [{ file: secret, after: secret, action: secret, after_sha256: secret }],
    stop_causes: [secret], last_activity_at: secret, elapsed_seconds: secret, artifact_identity: { artifact_sha256: secret } });
  Object.assign(u.requests[0], { id: secret, agent_id: secret, response_id: secret, status: secret, raw: secret, error: secret, apiKey: secret, base_url: url });
  const result = writeIncident(root, { report: r, usage: u, phase: secret, failure_code: secret, [secret]: secret });
  const output = fs.readFileSync(result.json, 'utf8') + fs.readFileSync(result.markdown, 'utf8');
  assert.doesNotMatch(output, /SECRET_CANARY|https:|sensitive\.invalid|apiKey|base_url/);
  const { snapshot } = JSON.parse(fs.readFileSync(result.json));
  assert.equal(snapshot.workers[0].status, 'unknown');
  assert.equal(snapshot.workers[0].limits.max_turns, null);
  assert.equal(snapshot.workers[0].remaining_work_count, 1);
  assert.equal(snapshot.orchestration_error_count, 1);
});

test('recovery from missing, corrupt and in-flight artifacts records uncertainty, not death or free requests', t => {
  const root = fixture(t);
  const missing = writeIncident(root);
  const empty = JSON.parse(fs.readFileSync(missing.json)).snapshot;
  assert.deepEqual(empty.provenance, { report: 'missing', usage: 'missing' });
  assert.equal(empty.requests.costs, null); assert.equal(empty.worker_count, null);
  fs.writeFileSync(path.join(root, 'report.json'), '{"SECRET_CANARY":');
  const corrupt = writeIncident(root);
  assert.notEqual(missing.fingerprint, corrupt.fingerprint);
  const broken = JSON.parse(fs.readFileSync(corrupt.json)).snapshot;
  assert.equal(broken.provenance.report, 'unreadable_or_invalid');
  const running = report('running'); delete running.finished_at;
  save(root, running);
  const fallback = writeIncident(root, { phase: 'recovery', failure_code: 'unfinished_run' });
  const snapshot = JSON.parse(fs.readFileSync(fallback.json)).snapshot;
  assert.equal(snapshot.process_state, 'unverified');
  assert.ok(snapshot.uncertainty.includes('run_completion_unconfirmed'));
  assert.deepEqual(snapshot.categories, ['unfinished']);
  assert.equal(snapshot.requests.costs.unpriced_request_count, 1);
  assert.equal(fs.existsSync(missing.json), true); assert.equal(fs.existsSync(corrupt.json), true);
});

test('changed snapshots and curated Markdown are append-only; no existing report is overwritten', t => {
  const root = fixture(t); save(root);
  const first = writeIncident(root); fs.appendFileSync(first.markdown, '\nHost review: preserved.\n');
  const revised = writeIncident(root);
  assert.notEqual(first.markdown, revised.markdown); assert.equal(first.fingerprint, revised.fingerprint);
  assert.match(fs.readFileSync(first.markdown, 'utf8'), /Host review: preserved/);
  assert.equal(writeIncident(root).markdown, revised.markdown);
  save(root, report('partial'));
  const partial = writeIncident(root); assert.notEqual(first.fingerprint, partial.fingerprint);
  assert.deepEqual(JSON.parse(fs.readFileSync(partial.json)).snapshot.categories, ['partial']);
});

test('curated JSON is preserved but never silently reused as generated allowlisted output', t => {
  const root = fixture(t); save(root);
  const first = writeIncident(root), edited = JSON.parse(fs.readFileSync(first.json));
  edited.private_note = 'SECRET_CANARY'; fs.writeFileSync(first.json, JSON.stringify(edited, null, 2) + '\n');
  const second = writeIncident(root);
  assert.notEqual(first.json, second.json);
  assert.match(fs.readFileSync(first.json, 'utf8'), /SECRET_CANARY/);
  assert.doesNotMatch(fs.readFileSync(second.json, 'utf8'), /SECRET_CANARY/);
  fs.chmodSync(second.json, 0o644);
  assert.equal(tryWriteIncident(root).status, 'unavailable');
});

test('output symlinks/hardlinks are refused and source links are not read', t => {
  const root = fixture(t), outside = path.join(root, 'outside'); fs.mkdirSync(outside, { mode: 0o700 });
  fs.symlinkSync(outside, path.join(root, 'incidents'));
  assert.deepEqual(tryWriteIncident(root), { status: 'unavailable', code: 'incident_write_failed' });
  assert.deepEqual(fs.readdirSync(outside), []); fs.unlinkSync(path.join(root, 'incidents'));
  const file = path.join(outside, 'secret.json'); fs.writeFileSync(file, '{"run_id":"SECRET_CANARY"}');
  fs.symlinkSync(file, path.join(root, 'report.json')); fs.linkSync(file, path.join(root, 'usage.json'));
  const result = writeIncident(root);
  const snapshot = JSON.parse(fs.readFileSync(result.json)).snapshot;
  assert.deepEqual(snapshot.provenance, { report: 'unreadable_or_invalid', usage: 'unreadable_or_invalid' });
  assert.equal(snapshot.run_id_sha256, null);
  fs.linkSync(result.json, path.join(root, 'duplicate.json'));
  assert.equal(tryWriteIncident(root).status, 'unavailable');
  const linkedRoot = path.join(root, 'linked-root'); fs.symlinkSync(outside, linkedRoot);
  assert.equal(tryWriteIncident(linkedRoot).status, 'unavailable');
});

test('non-private existing incident directories and partial publication fail safely', t => {
  const root = fixture(t); save(root);
  fs.mkdirSync(path.join(root, 'incidents'), { mode: 0o755 }); fs.chmodSync(path.join(root, 'incidents'), 0o755);
  const before = fs.readFileSync(path.join(root, 'report.json'), 'utf8');
  assert.equal(tryWriteIncident(root).status, 'unavailable');
  assert.equal(fs.readFileSync(path.join(root, 'report.json'), 'utf8'), before);
  fs.chmodSync(path.join(root, 'incidents'), 0o700);
  const first = writeIncident(root); fs.unlinkSync(first.markdown);
  const next = writeIncident(root); assert.notEqual(first.json, next.json);
  assert.equal(fs.existsSync(first.json), true);
});

test('incident trigger distinguishes incomplete/skipped/operational/partial outcomes from completion claims', t => {
  const root = fixture(t);
  assert.equal(needsIncident(report('completed')), false);
  for (const status of ['partial', 'blocked', 'not_started', 'error', 'timeout', 'orchestration_error', 'running', 'missing_submission']) assert.equal(needsIncident(report(status)), true);
  const claim = report('completed'); claim.agents[0].submission = { completion: 'partial' };
  assert.equal(needsIncident(claim), true);
  const r = report('completed'); r.orchestration_errors = [{}]; assert.equal(needsIncident(r), true);
  assert.equal(needsIncident(null), true);
  const result = incidentSnapshot(root, { report: { agents: [{ status: 'error' }, { status: 'partial' }, { status: 'not_started' }] }, usage: { requests: [] }, phase: 'preflight', failure_code: 'preflight_failed' });
  assert.deepEqual(result.categories, ['not_started', 'operational', 'partial']);
  assert.equal(result.failure_code, 'preflight_failed');
});

test('unknown costs stay unknown and hostile numeric/collection values are bounded', t => {
  const root = fixture(t), r = report();
  r.agents = Array.from({ length: 260 }, () => ({ status: 'partial', changes: Array.from({ length: 1001 }, () => ({})) }));
  const snapshot = incidentSnapshot(root, { report: r, usage: { requests: [null, { billed_usd: -1, estimate_usd: NaN }, { billed_usd: Infinity }] } });
  assert.equal(snapshot.workers.length, 256); assert.equal(snapshot.worker_count, 260);
  assert.ok(snapshot.uncertainty.includes('worker_details_truncated'));
  assert.equal(snapshot.workers[0].candidates.length, 1000); assert.equal(snapshot.workers[0].candidate_count, 1001);
  assert.equal(snapshot.requests.costs.unpriced_request_count, 3); assert.equal(snapshot.requests.invalid_record_count, 1);
  assert.ok(snapshot.uncertainty.includes('request_worker_attribution_unknown'));
  assert.equal(snapshot.workers[0].requests.costs, null);
});

test('standalone recovery command reports paths and fixed errors without leaking raw filesystem errors', t => {
  const root = fixture(t), command = fileURLToPath(new URL('../scripts/incidents.mjs', import.meta.url));
  const okay = spawnSync(process.execPath, [command, '--out', root], { encoding: 'utf8' });
  assert.equal(okay.status, 0); assert.equal(JSON.parse(okay.stdout).status, 'written');
  const absent = spawnSync(process.execPath, [command, '--out', path.join(root, 'SECRET_CANARY')], { encoding: 'utf8' });
  assert.equal(absent.status, 4); assert.doesNotMatch(absent.stdout + absent.stderr, /SECRET_CANARY|ENOENT/);
  assert.equal(JSON.parse(absent.stdout).code, 'incident_write_failed');
});
