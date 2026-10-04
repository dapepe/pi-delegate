/** Local Durable contract/inspection tests; SDK installation and inference unnecessary. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { initDurable, inspectDurable, durableMain } from '../scripts/durable.mjs';
import { mergeDurableLedger } from '../scripts/runtime.mjs';
const defaults = JSON.parse(fs.readFileSync(new URL('../defaults.json', import.meta.url)));
test('Durable init requires explicit transcript retention and rejects writes/multiple workers', { skip: process.platform === 'win32' }, t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-durable-local-')), repo = path.join(base, 'repo'); fs.mkdirSync(repo); fs.writeFileSync(path.join(repo, 'a.js'), 'fixture\n');
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const plan = { repo_root: repo, objective: 'Synthetic local contract', read_files: ['a.js'], agents: [{ id: 'reader', role: 'sparring partner', task: 'Read', mode: 'read', model: defaults.preferred_models[1], selection_reason: 'Fixture' }] };
  const out = path.join(base, 'session');
  assert.throws(() => initDurable(plan, out, 'synthetic-native', false), /retention approval/);
  assert.throws(() => initDurable({ ...plan, agents: [{ ...plan.agents[0], mode: 'write', write_files: ['a.js'] }] }, out, 'synthetic-native', true), /read-only/);
  assert.throws(() => initDurable({ ...plan, agents: [plan.agents[0], { ...plan.agents[0], id: 'other' }] }, out, 'synthetic-native', true), /one standalone/);
  initDurable(plan, out, 'synthetic-native', true);
  assert.equal(inspectDurable(out).requests, null); assert.equal(inspectDurable(out).costs, null);
  assert.equal(fs.existsSync(path.join(out, 'transcript')), false);
  fs.chmodSync(path.join(out, 'durable.json'), 0o644);
  assert.throws(() => inspectDurable(out), /private/);
});
test('Durable CLI help/inspection are local and fail closed on undocumented options', async () => {
  assert.match(await durableMain(['help']), /Only run\/resume can perform paid inference/);
  await assert.rejects(durableMain(['help', '--auto-resume', 'true']), /Unknown or duplicate/);
  const cli = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/pi.mjs', import.meta.url)), 'durable', 'help'], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr); assert.match(cli.stdout, /retain-transcript approved/);
});
test('Durable ledger merging preserves known charges and forward admissions, refusing ambiguous identities', () => {
  const first = { id: 'reader:1', agent_id: 'reader', provider: 'openrouter', requested_model: 'fixture', resolved_model: 'fixture', started_at: '2026-10-03T00:00:00Z', reserved_usd: 0.01, billed_usd: null };
  const known = { ...first, billed_usd: 3, billed_model: 'fixture', billing_source: 'Synthetic billing' };
  const forward = { ...first, id: 'reader:2', started_at: '2026-10-03T00:00:01Z' };
  assert.equal(mergeDurableLedger([known], [first])[0].billed_usd, 3);
  const merged = mergeDurableLedger([first], [known, forward]);
  assert.equal(merged[0].billed_usd, 3); assert.equal(merged.length, 2);
  assert.throws(() => mergeDurableLedger([known], [{ ...known, billed_usd: 4 }]), /Conflicting known/);
  assert.throws(() => mergeDurableLedger([first], [{ ...known, resolved_model: 'other' }]), /Conflicting Durable request/);
  assert.throws(() => mergeDurableLedger([first], [known, { ...forward, id: first.id }]), /duplicate/);
  assert.equal(first.billed_usd, null);
  const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0.00001, output: 0.00001, cacheRead: 0, cacheWrite: 0, total: 0.00002 } };
  const observed = mergeDurableLedger([{ ...first, status: 'in_flight', estimate_usd: null, usage: null }], [{ ...first, status: 'toolUse', estimate_usd: 0.00002, usage }]);
  assert.deepEqual(observed[0].usage, usage); assert.equal(observed[0].estimate_usd, 0.00002); assert.equal(observed[0].status, 'toolUse');
  assert.equal(observed[0].billed_usd, null);
  assert.equal(mergeDurableLedger([first], [{ ...first, estimate_usd: 0, usage: { ...usage, totalTokens: 0 } }])[0].estimate_usd, undefined);
});
