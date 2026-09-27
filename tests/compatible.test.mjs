/** Synthetic route declarations only. No credentials or local endpoints are used. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mergePolicy, validatePlan, sha256 } from '../scripts/lib.mjs';
import { validateCompatibleProviders, compatibleKeyFor, resolveCompatibleModel, compatibleConfigurationFingerprint } from '../scripts/compatible.mjs';
import { buildLearningRun, aggregateLearning, initLearning, LEARNING_DEFAULTS } from '../scripts/learning.mjs';
import { aggregateStats, recommendFromStats } from '../scripts/stats.mjs';
import { beginRunInventory, readRunInventory } from '../scripts/insights-store.mjs';
import { runtimeLimits } from '../scripts/runtime.mjs';

const defaults = JSON.parse(fs.readFileSync(new URL('../defaults.json', import.meta.url)));
const provider = 'compatible:fixture';
const declaration = () => ({ context_window: 128000, max_output_tokens: 4096, supports_tools: true, supported_efforts: ['high', 'max'], rates_usd_per_million: { input: 1, output: 2, cacheRead: 1, cacheWrite: 1 } });
const config = () => ({ base_url: 'https://fixture.invalid/v1', auth: { type: 'env', env: 'PI_FIXTURE_TOKEN' }, models: { 'fixture/model': declaration() } });
const policy = () => mergePolicy(defaults, { preferred_provider: provider, preferred_models: ['fixture/model'], openai_compatible_providers: { [provider]: config() } });
const agent = () => ({ id: 'worker', model: 'fixture/model', provider, effort: 'xhigh', task: 'Synthetic review', selection_reason: 'Synthetic route test', mode: 'read' });

test('compatible declarations are exact data-only allowlists with explicit rates and transport approval', () => {
  assert.doesNotThrow(() => policy());
  const invalid = [c => c.module = '/tmp/plugin.mjs', c => c.headers = { Authorization: 'secret' }, c => c.auth.key = 'secret', c => c.auth.type = 'auto', c => c.base_url = 'https://user:secret@fixture.invalid/v1', c => c.base_url += '?secret=x', c => c.base_url += '#x', c => c.base_url = 'http://fixture.invalid/v1', c => delete c.models['fixture/model'].rates_usd_per_million.output, c => c.models['fixture/model'].rates_usd_per_million.input = -1, c => c.models['fixture/model'].supports_tools = false, c => c.models['fixture/model'].supported_efforts = ['low'], c => c.models['fixture/model'].compat = { body: { unsafe: true } }];
  for (const edit of invalid) { const c = config(); edit(c); assert.throws(() => validateCompatibleProviders({ [provider]: c })); }
  const c = config(); c.base_url = 'http://infrastructure.invalid:8080/v1'; c.allow_insecure_http = true;
  assert.doesNotThrow(() => validateCompatibleProviders({ [provider]: c }));
  assert.throws(() => validateCompatibleProviders({ openai: c }));
});

test('compatible credential lookup cannot fall back to unrelated OpenAI credentials', () => {
  const p = policy();
  assert.throws(() => compatibleKeyFor(p, provider, { OPENAI_API_KEY: 'unrelated-synthetic' }), /Missing explicitly configured/);
  assert.equal(compatibleKeyFor(p, provider, { PI_FIXTURE_TOKEN: 'fixture-only' }), 'fixture-only');
  p.openai_compatible_providers[provider].auth = { type: 'none' };
  assert.equal(compatibleKeyFor(p, provider, { OPENAI_API_KEY: 'unrelated-synthetic' }), 'pi-explicit-no-auth');
});

test('compatible resolver declares unverified capabilities, exact identities and transparent effort', () => {
  const p = policy(), resolved = resolveCompatibleModel(p, agent());
  assert.equal(resolved.metadata.effective_pi_effort, 'max');
  assert.equal(resolved.metadata.effort_mapping, 'raised_to_next_supported');
  assert.match(resolved.metadata.capability_source, /not probed/);
  assert.equal(resolved.model.provider, provider);
  assert.equal(resolved.model.id, 'fixture/model');
  assert.throws(() => resolveCompatibleModel(p, { ...agent(), model: 'fixture/other' }), /not approved/);
  p.effort_policy = 'strict'; assert.throws(() => resolveCompatibleModel(p, agent()), /strict/);
});

test('non-reasoning models need both a declaration approval and explicit worker effort off', () => {
  const p = policy(), m = p.openai_compatible_providers[provider].models['fixture/model'];
  m.supported_efforts = ['off'];
  assert.throws(() => resolveCompatibleModel(p, { ...agent(), effort: 'off' }), /non_reasoning_approval/);
  m.non_reasoning_approval = 'Synthetic local non-reasoning evaluation approved.';
  assert.throws(() => resolveCompatibleModel(p, agent()), /no silent effort downgrade/);
  const resolved = resolveCompatibleModel(p, { ...agent(), effort: 'off' });
  assert.equal(resolved.model.reasoning, false); assert.equal(resolved.metadata.configured_provider_effort, null);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-compatible-policy-'));
  try {
    const input = { repo_root: repo, objective: 'Synthetic policy test', read_files: ['a.js'], policy: p, agents: [{ ...agent(), effort: 'off' }] };
    assert.equal(validatePlan(input, defaults).agents[0].effort, 'off');
    input.agents[0].model = 'unapproved'; assert.throws(() => validatePlan(input, defaults));
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('route fingerprints separate endpoints and declared capabilities without storing credentials', () => {
  const p = policy(), original = compatibleConfigurationFingerprint(p, provider, 'fixture/model');
  p.openai_compatible_providers[provider].base_url = 'https://other-fixture.invalid/v1';
  assert.notEqual(compatibleConfigurationFingerprint(p, provider, 'fixture/model'), original);
  const second = compatibleConfigurationFingerprint(p, provider, 'fixture/model');
  p.openai_compatible_providers[provider].models['fixture/model'].max_output_tokens++;
  assert.notEqual(compatibleConfigurationFingerprint(p, provider, 'fixture/model'), second);
});

function learningFixture(p) {
  const a = agent(), metadata = resolveCompatibleModel(p, a).metadata;
  const report = { mode: 'pi_sdk', run_id: 'synthetic-run', source_repo: '/synthetic', orchestrator: 'codex', created_at: '2026-09-25T10:00:00Z', finished_at: '2026-09-25T10:01:00Z', agents: [{ id: a.id, mode: 'read', status: 'completed', policy_violations: [], model: metadata }] };
  const assessment = { run_id: report.run_id, assessed_by: 'Codex', overall_value: 'Synthetic evidence only.', decisions: [], workers: [{ agent_id: a.id, usefulness_0_to_3: 2, reason: 'Synthetic evidence only.' }], learning: { task_id: 'fixture', task_type: 'review', scope: 'synthetic', complexity: 'bounded', strategy: 'single-review', strategy_version: 'v1', workers: [{ agent_id: a.id, role: 'correctness-review', outcome: 'useful', validation: 'passed', evidence: ['Synthetic evidence only.'], failure_kind: 'none', regression: 'none-observed', rework: 'none' }] } };
  const usage = { requests: [{ agent_id: a.id, response_model: a.model, estimate_usd: 0.1 }] };
  const plan = { repo_root: '/synthetic', orchestrator: 'codex', policy: p, agents: [a] };
  const config = { ...LEARNING_DEFAULTS, project_id: '11111111-1111-1111-1111-111111111111' };
  return { report, assessment, usage, plan, config, snapshot: { repo_root: '/synthetic', files: {} } };
}
const learningRecord = f => buildLearningRun(f.config, f.report, f.assessment, f.usage, f.plan, f.snapshot);
test('learning binds compatible evidence to the saved configuration and rejects missing or changed fingerprints', () => {
  const f = learningFixture(policy()), record = learningRecord(f), fingerprint = f.report.agents[0].model.configuration_fingerprint;
  assert.equal(record.observations[0].profile.configuration_fingerprint, fingerprint);
  assert.equal(record.observations[0].profile.team[0].configuration_fingerprint, fingerprint);
  const changed = learningFixture(policy()); changed.plan.policy.openai_compatible_providers[provider].base_url = 'https://new.invalid/v1';
  assert.throws(() => learningRecord(changed), /differs/);
  delete f.report.agents[0].model.configuration_fingerprint; assert.throws(() => learningRecord(f), /valid configuration fingerprint/);
  const old = structuredClone(record); delete old.observations[0].profile.configuration_fingerprint;
  assert.throws(() => aggregateLearning({ runs: [{ current: old }] }, f.config), /valid configuration fingerprint/);
});

test('statistics separate compatible endpoints and recommendations refuse evidence from an old endpoint', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-compatible-stats-'));
  try {
    const p = policy(), original = learningFixture(p), first = learningRecord(original);
    const otherPolicy = policy(); otherPolicy.openai_compatible_providers[provider].base_url = 'https://new.invalid/v1';
    const other = learningFixture(otherPolicy); other.report.run_id = other.assessment.run_id = 'synthetic-other'; other.assessment.learning.task_id = 'other';
    const second = learningRecord(other);
    fs.mkdirSync(path.join(base, '.pi/learning'), { recursive: true });
    fs.writeFileSync(path.join(base, '.pi/learning/history.json'), JSON.stringify({ schema_version: 1, project_id: original.config.project_id, runs: [{ current: first, key: first.key }, { current: second, key: second.key }] }));
    const stats = aggregateStats({ repos: [base], period: 'all', now: Date.parse('2026-09-26T00:00:00Z') });
    assert.equal(stats.models.length, 2);
    const recommendations = recommendFromStats(stats, original.plan).recommendations;
    assert.equal(recommendations[0].shortlist.length, 1);
    const onlyOld = { ...stats, models: stats.models.filter(m => m.model.configuration_fingerprint !== first.observations[0].profile.configuration_fingerprint) };
    assert.equal(recommendFromStats(onlyOld, original.plan).recommendations[0].shortlist[0].profile_key, null);
    const oldCompanion = structuredClone(stats.models.find(m => m.model.configuration_fingerprint === first.observations[0].profile.configuration_fingerprint));
    oldCompanion.model.compatible_team_fingerprints.push('a'.repeat(64));
    assert.equal(recommendFromStats({ ...stats, models: [oldCompanion] }, original.plan).recommendations[0].shortlist[0].profile_key, null);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('built-in profile byte shape and digest remain unchanged for legacy and v2 assessment profiles', () => {
  for (const version of [1, 2]) {
    const f = learningFixture(policy()), a = f.report.agents[0], spec = f.plan.agents[0];
    a.model.provider = spec.provider = 'openrouter'; f.plan.policy = defaults;
    if (version === 2) {
      const criterion = { id: 'criterion', requirement: 'Synthetic criterion' }, artifact = 'f'.repeat(64);
      f.assessment.schema_version = 2;
      Object.assign(f.assessment.workers[0], { quality_0_to_3: 2, quality_reason: 'Synthetic', artifact_sha256: artifact, integration_status: 'candidate_only', criterion_results: [{ id: criterion.id, result: 'passed', evidence: ['Synthetic'] }] });
      a.artifact_identity = { artifact_sha256: artifact };
      const { workers, ...evaluation } = f.assessment.learning;
      f.report.evaluation = f.plan.evaluation = { schema_version: 1, ...evaluation, workers: [{ agent_id: spec.id, assignment_id: 'fixture-assignment', attempt_index: 1, criteria: [criterion] }] };
    }
    const observation = learningRecord(f).observations[0], limits = runtimeLimits(defaults, a.model.max_output_tokens);
    const expected = {
      ...(version === 2 ? { profile_schema_version: 2 } : {}),
      host: 'codex', host_model: 'unknown', host_version: 'unknown', task_type: 'review', scope: 'synthetic', complexity: 'bounded', strategy: 'single-review', strategy_version: 'v1', role: 'correctness-review', provider: 'openrouter', requested_model: 'fixture/model', resolved_model: 'fixture/model', model_identity: 'fixture/model', observed_models: ['fixture/model'], upstream_providers: [], requested_effort: 'xhigh', effective_effort: 'max', mode: 'read', runtime_limits: limits,
      team: [{ role: 'correctness-review', provider: 'openrouter', model_identity: 'fixture/model', effective_effort: 'max', mode: 'read', runtime_limits: limits }], skill_version: 'legacy', sdk_version: 'unknown'
    };
    assert.equal(JSON.stringify(observation.profile), JSON.stringify(expected));
    assert.equal(observation.profile_id, sha256(JSON.stringify(expected)).slice(0, 16));
  }
});

test('compact inventory retains route fingerprints without retaining endpoint URLs', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-compatible-inventory-'));
  try {
    initLearning(repo);
    const f = learningFixture(policy()); f.plan.repo_root = f.report.source_repo = repo;
    beginRunInventory(repo, f);
    const inventory = readRunInventory(repo), serialized = JSON.stringify(inventory);
    assert.ok(serialized.includes(f.report.agents[0].model.configuration_fingerprint));
    assert.ok(serialized.includes(f.report.agents[0].model.endpoint_fingerprint));
    assert.ok(!serialized.includes('fixture.invalid'));
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});
test('local-only reconciliation needs no cloud credential and retains unknown billing', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-compatible-billing-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const usage = { requests: [{ id: 'worker:1', agent_id: 'worker', provider, response_id: 'synthetic', estimate_usd: 0.01 }] };
  const report = { run_id: 'synthetic', orchestrator: 'codex', created_at: '2026-09-27T00:00:00.000Z', finished_at: '2026-09-27T00:01:00.000Z', agents: [{ id: 'worker', status: 'completed', model: { provider, resolved_model: 'fixture/model' } }] };
  fs.writeFileSync(path.join(base, 'usage.json'), JSON.stringify(usage));
  fs.writeFileSync(path.join(base, 'report.json'), JSON.stringify(report));
  // Block credential reads and transport in the child without changing its home.
  const guard = path.join(base, 'guard.mjs');
  fs.writeFileSync(guard, `import fs from 'node:fs';
const read = fs.readFileSync;
fs.readFileSync = function(file, ...args) {
  if (String(file).endsWith('credentials.json')) throw new Error('Credential reads forbidden in synthetic reconciliation');
  return read.call(this, file, ...args);
};
globalThis.fetch = async () => { throw new Error('Network forbidden in synthetic reconciliation'); };
`);
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(guard).href, fileURLToPath(new URL('../scripts/pi.mjs', import.meta.url)), 'reconcile', '--out', base], {
    encoding: 'utf8', env: { ...process.env, OPENROUTER_API_KEY: '' }
  });
  assert.equal(result.status, 0, result.stderr);
  const costs = JSON.parse(result.stdout);
  assert.equal(costs.provider_reported_usd, 0); assert.equal(costs.unresolved_request_count, 1);
  assert.equal(costs.estimated_unreconciled_usd, 0.01);
});
