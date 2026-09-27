/** Synthetic profiles and plans in temporary directories. No home writes, credentials, network or inference. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { showSetup, checkSetup, saveSetup, compileSetupPlan, setupMain } from '../scripts/setup.mjs';
import { sha256 } from '../scripts/lib.mjs';

const defaults = JSON.parse(fs.readFileSync(new URL('../defaults.json', import.meta.url)));
const cli = fileURLToPath(new URL('../scripts/setup.mjs', import.meta.url));
const piCli = fileURLToPath(new URL('../scripts/pi.mjs', import.meta.url));
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-setup-config-'))), repo = path.join(root, 'repo');
  fs.mkdirSync(repo); fs.writeFileSync(path.join(repo, 'sample.js'), '// synthetic source\n');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'draft-policy.json'), plan = path.join(root, 'task-plan.json');
  const policy = { max_turns: 20, max_output_tokens: 4096, session_budget_usd: 4 };
  const input = { repo_root: repo, objective: 'Synthetic setup compile test', read_files: ['sample.js'], agents: [{ id: 'review', model: defaults.preferred_models[1], mode: 'read', task: 'Review only synthetic data', selection_reason: 'Synthetic setup test' }] };
  const put = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  put(source, policy); put(plan, input);
  return { root, repo, source, plan, policy, input, put };
}

test('unconfigured show discloses bundled defaults without creating directories or scanning credentials', t => {
  const f = fixture(t), absent = path.join(f.root, 'not-created', 'policy.json');
  const result = showSetup(absent);
  assert.equal(result.configured, false); assert.equal(result.sha256, null); assert.equal(result.policy, null);
  assert.deepEqual(result.effective_policy, defaults); assert.equal(result.summary.credentials_status, 'not_checked');
  assert.equal(fs.existsSync(path.dirname(absent)), false); assert.match(result.note, /not been checked/);
});

test('check validates reusable plain policy and reports exact explicit preferences without writing', t => {
  const f = fixture(t), before = fs.readFileSync(f.source);
  const result = checkSetup(f.source);
  assert.equal(result.valid, true); assert.equal(result.sha256, sha256(before));
  assert.deepEqual(result.explicit_keys, ['max_output_tokens', 'max_turns', 'session_budget_usd']);
  assert.equal(result.summary.limits.max_turns, 20); assert.equal(result.effective_policy.preferred_provider, defaults.preferred_provider);
  assert.deepEqual(fs.readFileSync(f.source), before);
  assert.deepEqual(fs.readdirSync(f.root).sort(), ['draft-policy.json', 'repo', 'task-plan.json']);
});

test('provider changes require explicit model choices and compatible model declarations stay exact', t => {
  const f = fixture(t);
  f.put(f.source, { preferred_provider: 'openai' }); assert.throws(() => checkSetup(f.source), /explicit preferred_models/);
  f.put(f.source, { preferred_provider: 'openai', preferred_models: ['synthetic-unverified-id'] });
  assert.equal(checkSetup(f.source).valid, true); assert.match(checkSetup(f.source).note, /model catalogs/);
  const compatible = JSON.parse(fs.readFileSync(new URL('../examples/openai-compatible.policy.json', import.meta.url)));
  f.put(f.source, compatible); assert.equal(checkSetup(f.source).valid, true);
  assert.equal(checkSetup(f.source).summary.compatible_routes[0].models[0].effective_output_ceiling, 4096);
  compatible.preferred_models = ['undeclared-model']; f.put(f.source, compatible); assert.throws(() => checkSetup(f.source), /exact approved declaration/);
});

test('save creates a private profile and replacements require the current content hash', t => {
  const f = fixture(t), out = path.join(f.root, 'private-profile', 'policy.json');
  const first = saveSetup(f.source, out);
  assert.equal(first.saved, true); assert.equal(first.replaced, false); assert.equal(first.sha256, sha256(fs.readFileSync(out)));
  if (process.platform !== 'win32') { assert.equal(fs.statSync(path.dirname(out)).mode & 0o777, 0o700); assert.equal(fs.statSync(out).mode & 0o777, 0o600); }
  assert.deepEqual(JSON.parse(fs.readFileSync(out)), f.policy);
  assert.throws(() => saveSetup(f.source, out), /already exists/);
  f.put(f.source, { ...f.policy, max_turns: 22 });
  assert.throws(() => saveSetup(f.source, out, '0'.repeat(64)), /hash changed/);
  const second = saveSetup(f.source, out, first.sha256);
  assert.equal(second.replaced, true); assert.equal(showSetup(out).effective_policy.max_turns, 22);
  assert.throws(() => saveSetup(f.source, out, first.sha256), /hash changed/);
});

test('save refuses to chmod existing shared directories or modify reserved targets', t => {
  const f = fixture(t), shared = path.join(f.root, 'shared'); fs.mkdirSync(shared, { mode: 0o755 });
  if (process.platform !== 'win32') {
    fs.chmodSync(shared, 0o755);
    assert.throws(() => saveSetup(f.source, path.join(shared, 'policy.json')), /owner-only parent/);
    assert.equal(fs.statSync(shared).mode & 0o777, 0o755); assert.deepEqual(fs.readdirSync(shared), []);
  }
  for (const name of ['AGENTS.md', 'credentials.json', 'auth.json', 'package.json', 'package-lock.json', 'defaults.json', 'settings.json', 'config.json', 'history.json', 'report.json', 'plan.json']) {
    assert.throws(() => saveSetup(f.source, path.join(f.root, name)));
    assert.equal(fs.existsSync(path.join(f.root, name)), false);
  }
  assert.throws(() => saveSetup(f.source, path.join(f.repo, '.pi', 'learning', 'policy.json')), /runtime state/);
  assert.equal(fs.existsSync(path.join(f.repo, '.pi')), false);
});

test('setup serializes replacement writers and preserves a competing or interrupted lock', t => {
  const f = fixture(t), out = path.join(f.root, 'private-profile', 'policy.json');
  const initial = saveSetup(f.source, out), lock = `${out}.setup.lock`, before = fs.readFileSync(out);
  fs.writeFileSync(lock, 'synthetic interrupted writer\n', { mode: 0o600 });
  assert.throws(() => saveSetup(f.source, out, initial.sha256), /output is locked/);
  assert.deepEqual(fs.readFileSync(out), before);
  assert.equal(fs.readFileSync(lock, 'utf8'), 'synthetic interrupted writer\n');
  fs.unlinkSync(lock);
  f.put(f.source, { ...f.policy, max_turns: 22 });
  const rename = fs.renameSync;
  let competingWriteAttempted = false;
  fs.renameSync = (...args) => {
    if (args[1] === out) {
      competingWriteAttempted = true;
      assert.throws(() => saveSetup(f.source, out, initial.sha256), /output is locked/);
      assert.deepEqual(fs.readFileSync(out), before);
    }
    return rename(...args);
  };
  try { saveSetup(f.source, out, initial.sha256); }
  finally { fs.renameSync = rename; }
  assert.equal(competingWriteAttempted, true);
  assert.equal(showSetup(out).effective_policy.max_turns, 22);
  assert.equal(fs.existsSync(lock), false);
  assert.throws(() => saveSetup(f.source, out, initial.sha256), /hash changed/);
  assert.equal(fs.existsSync(lock), false);
});

test('secret-like fields, strings and field names are rejected without echoing values', t => {
  const f = fixture(t), fakeSecret = 'sk-synthetic-credential-12345678901234567890';
  const cases = [{ api_key: fakeSecret }, { [fakeSecret]: 1 }, { preferred_models: [fakeSecret] }, { model_aliases: { fixture: fakeSecret } }, { openai_compatible_providers: { 'compatible:bad': { auth: { type: 'env', key: fakeSecret } } } }];
  for (const value of cases) {
    f.put(f.source, value);
    assert.throws(() => checkSetup(f.source), error => !error.message.includes(fakeSecret));
    const result = spawnSync(process.execPath, [cli, 'check', '--config', f.source], { encoding: 'utf8' });
    assert.equal(result.status, 1); assert.ok(!(result.stdout + result.stderr).includes(fakeSecret));
  }
  const credentialFile = path.join(f.root, 'credentials.json'); f.put(credentialFile, { secret: fakeSecret });
  assert.throws(() => showSetup(credentialFile), /credential files/);
});

test('setup rejects symlink paths, hardlinked profiles and oversized input', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t), link = path.join(f.root, 'linked.json'), hard = path.join(f.root, 'hard.json');
  fs.symlinkSync(f.source, link); assert.throws(() => checkSetup(link), /symbolic link/);
  fs.linkSync(f.source, hard); assert.throws(() => checkSetup(hard), /hardlink/); fs.unlinkSync(hard);
  const directory = path.join(f.root, 'linked-directory'); fs.symlinkSync(f.repo, directory);
  assert.throws(() => saveSetup(f.source, path.join(directory, 'nested', 'policy.json')), /symbolic link/);
  assert.equal(fs.existsSync(path.join(f.repo, 'nested')), false);
  fs.writeFileSync(f.source, ' '.repeat(1024 * 1024 + 1)); assert.throws(() => checkSetup(f.source), /bounded/);
});

test('plan compilation materializes reviewed preferences and per-task overrides without hidden runtime reads', t => {
  const f = fixture(t), out = path.join(f.root, 'compiled-plan.json');
  f.input.policy = { max_turns: 8, session_budget_usd: 2 }; f.input.policy_sources = ['User project instructions']; f.put(f.plan, f.input);
  const result = compileSetupPlan(f.source, f.plan, out), compiled = JSON.parse(fs.readFileSync(out));
  assert.deepEqual(result.override_keys, ['max_turns', 'session_budget_usd']); assert.deepEqual(result.overrides, f.input.policy);
  assert.equal(compiled.policy.max_turns, 8); assert.equal(compiled.policy.max_output_tokens, 4096); assert.equal(compiled.policy.session_budget_usd, 2);
  assert.deepEqual(compiled.policy_sources, ['User project instructions', f.source]);
  assert.equal(compiled.agents[0].provider, defaults.preferred_provider); assert.equal(compiled.agents[0].effort, defaults.default_effort);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.plan)), f.input); assert.deepEqual(fs.readdirSync(f.repo), ['sample.js']);
  assert.throws(() => compileSetupPlan(f.source, f.plan, out), /already exists/);
  assert.match(result.note, /No snapshot or inference/);
});

test('compiled plan outputs stay outside the repository and cannot follow links before mkdir', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t), inside = path.join(f.repo, 'not-created', 'plan.json');
  assert.throws(() => compileSetupPlan(f.source, f.plan, inside), /outside the task repository/);
  assert.equal(fs.existsSync(path.dirname(inside)), false);
  const alias = path.join(f.root, 'source-link'); fs.symlinkSync(f.repo, alias);
  assert.throws(() => compileSetupPlan(f.source, f.plan, path.join(alias, 'not-created', 'plan.json')), /symbolic link/);
  assert.equal(fs.existsSync(path.dirname(inside)), false);
  f.input.policy = null; f.put(f.plan, f.input); assert.throws(() => compileSetupPlan(f.source, f.plan, path.join(f.root, 'null-policy-plan.json')), /policy must be an object/);
});

test('standalone and pi setup CLI paths support explicit local check and reject unsupported/duplicate flags', t => {
  const f = fixture(t);
  for (const args of [[cli, 'check', '--config', f.source], [piCli, 'setup', 'check', '--config', f.source]]) {
    const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).valid, true);
  }
  for (const args of [['check'], ['show', '--out', 'x'], ['save', '--config', f.source, '--config', f.source], ['plan', '--config', f.source], ['unknown'], ['help', '--config', f.source]]) assert.throws(() => setupMain(args));
  const invalid = spawnSync(process.execPath, [cli, 'save', '--config'], { encoding: 'utf8' }); assert.equal(invalid.status, 1);
});
