import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cleanRel, deniedPath, chooseEffort, mergePolicy, resolveCatalogModel, openRouterModel,
  validatePlan, captureSnapshot, manifestOf, verifySnapshot, createCapabilities, costSummary,
  readSource, sha256
} from '../scripts/lib.mjs';
import { reconcileRecord, executeJob } from '../scripts/pi.mjs';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const defaults = JSON.parse(fs.readFileSync(path.join(root, 'defaults.json'), 'utf8'));
const makeFixture = () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-test-'));
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src/a.js'), 'export const value = 1;\n');
  return { repo, cleanup: () => fs.rmSync(repo, { recursive: true, force: true }) };
};
const makePlan = repo => ({
  repo_root: repo, objective: 'Review a source file', read_files: ['src/a.js'],
  agents: [{ id: 'review', model: defaults.preferred_models[1], role: 'reviewer', mode: 'read', task: 'Inspect value', selection_reason: 'Independent opinion' }]
});
const modelRecord = (id = 'test/model') => ({
  id, name: id, supported_parameters: ['tools', 'reasoning'],
  architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  reasoning: { supported_efforts: ['high', 'max'] }, pricing: { prompt: '0.000001', completion: '0.000002' },
  context_length: 100000, top_provider: { max_completion_tokens: 32768 }
});
const submission = () => ({ summary: 'Inspection complete.', findings: [], proposed_tests: ['Run the existing tests.'], open_questions: [] });
const callTool = async (caps, name, args) => {
  const tool = caps.tools.find(t => t.name === name);
  assert.ok(tool, `Missing test tool ${name}`);
  return tool.execute('test', args, new AbortController().signal);
};

test('paths reject traversal, absolute paths, control characters and Windows escapes', () => {
  for (const bad of ['../secret', '/etc/passwd', 'a/../b', 'a//b', 'C:\\x', 'a\\b', 'a\nb', './a', '~/.ssh/id']) assert.throws(() => cleanRel(bad));
  assert.equal(cleanRel('src/a.js'), 'src/a.js');
});
test('sensitive and runtime configuration paths are denied', () => {
  for (const bad of ['.env', '.env.local', 'x/.git/config', '.pi/settings.json', '.agents/skills/x/SKILL.md', 'x/token.pem', '.npmrc']) assert.equal(deniedPath(bad), true);
  assert.equal(deniedPath('src/environment.js'), false);
});
test('effort is exact when supported', () => assert.deepEqual(chooseEffort('max', ['high', 'max']), { requested: 'max', effective: 'max', mapping: 'exact' }));
test('xhigh maps upward to max rather than silently down to high', () => assert.equal(chooseEffort('xhigh', ['high', 'max']).effective, 'max'));
test('max maps to highest supported and strict mapping rejects it', () => {
  assert.equal(chooseEffort('max', ['low', 'high']).effective, 'high');
  assert.throws(() => chooseEffort('max', ['high'], 'strict'));
  assert.throws(() => chooseEffort('xhigh', undefined));
  assert.throws(() => chooseEffort('xhigh', ['off', 'low']));
});
test('unknown configuration keys and incompatible defaults fail closed', () => {
  assert.throws(() => mergePolicy(defaults, { mystery: true }));
  assert.throws(() => mergePolicy(defaults, { default_effort: 'low' }));
  assert.throws(() => mergePolicy(defaults, { openrouter_routing: { require_parameters: false } }));
  assert.throws(() => mergePolicy(defaults, { session_budget_usd: -1 }));
});
test('model resolution is exact or explicitly aliased, never fuzzy', () => {
  const record = modelRecord('~x-ai/grok-latest');
  assert.throws(() => resolveCatalogModel([record], 'x-ai/grok-latest'));
  const found = resolveCatalogModel([record], 'x-ai/grok-latest', defaults.model_aliases);
  assert.equal(found.alias.source, 'explicit_policy_alias');
  assert.equal(found.item.id, '~x-ai/grok-latest');
  assert.throws(() => resolveCatalogModel([{ ...record, supported_parameters: [] }], record.id));
});
test('OpenRouter model maps every unsupported effort explicitly to null', () => {
  const model = openRouterModel(modelRecord(), defaults.openrouter_routing);
  assert.equal(model.thinkingLevelMap.xhigh, null);
  assert.equal(model.thinkingLevelMap.max, 'max');
  assert.equal(model.cost.input, 1);
  assert.equal(model.compat.thinkingFormat, 'openrouter');
});
test('rate estimates use maximum published overrides, not a stale bargain rate', () => {
  const record = modelRecord(); record.pricing.overrides = [{ prompt: '0.000003' }];
  assert.equal(openRouterModel(record, {}).cost.input, 3);
});
test('snapshot preserves current uncommitted bytes and detects subsequent staleness', () => {
  const f = makeFixture();
  try {
    const plan = validatePlan(makePlan(f.repo), defaults); const snapshot = captureSnapshot(plan);
    assert.equal(snapshot.get('src/a.js').content, 'export const value = 1;\n');
    const manifest = manifestOf(snapshot); assert.deepEqual(verifySnapshot(f.repo, manifest), []);
    fs.writeFileSync(path.join(f.repo, 'src/a.js'), 'changed\n');
    assert.deepEqual(verifySnapshot(f.repo, manifest), ['src/a.js']);
  } finally { f.cleanup(); }
});
test('symlink sources and missing/binary/oversized sources are rejected', (t) => {
  const f = makeFixture();
  try {
    let linked = false;
    try { fs.symlinkSync(path.join(f.repo, 'src/a.js'), path.join(f.repo, 'linked.js')); linked = true; }
    catch (e) { if (process.platform !== 'win32' || !['EPERM','EACCES'].includes(e.code)) throw e; t.diagnostic('Symlink assertion unavailable without Windows symlink privilege; remaining source tests still run.'); }
    if (linked) assert.throws(() => readSource(f.repo, 'linked.js', 1000));
    assert.throws(() => readSource(f.repo, 'src/a.js', 2));
    fs.writeFileSync(path.join(f.repo, 'binary'), Buffer.from([0, 1]));
    assert.throws(() => readSource(f.repo, 'binary', 1000));
    assert.throws(() => readSource(f.repo, 'missing', 1000));
    assert.equal(readSource(f.repo, 'missing', 1000, true), null);
  } finally { f.cleanup(); }
});
test('a read-only worker has no write, shell, subprocess or network tool', async () => {
  const f = makeFixture();
  try {
    const p = validatePlan(makePlan(f.repo), defaults); const caps = createCapabilities(p.agents[0], captureSnapshot(p), p.policy);
    assert.deepEqual(caps.tools.map(t => t.name), ['list_files', 'read_file', 'search_files', 'submit_result']);
    await assert.rejects(callTool(caps, 'read_file', { path: '../secret' }));
    await assert.rejects(callTool(caps, 'read_file', { path: 'unlisted.js' }));
  } finally { f.cleanup(); }
});
test('write permission requires an explicit list; read-only cannot smuggle write_files', () => {
  const f = makeFixture();
  try {
    const input = makePlan(f.repo); input.agents[0].write_files = ['src/a.js'];
    assert.throws(() => validatePlan(input, defaults));
    input.agents[0].mode = 'write'; input.agents[0].write_files = [];
    assert.throws(() => validatePlan(input, defaults));
  } finally { f.cleanup(); }
});
test('candidate edits stay in memory and do not alter another worker or the repository', async () => {
  const f = makeFixture();
  try {
    const input = makePlan(f.repo); Object.assign(input.agents[0], { mode: 'write', write_files: ['src/a.js', 'src/new.js'] });
    const p = validatePlan(input, defaults); const snapshot = captureSnapshot(p);
    const caps = createCapabilities(p.agents[0], snapshot, p.policy); const other = createCapabilities(p.agents[0], snapshot, p.policy);
    await callTool(caps, 'replace_text', { path: 'src/a.js', old_text: '= 1', new_text: '= 2' });
    await callTool(caps, 'write_file', { path: 'src/new.js', content: 'new\n' });
    await assert.rejects(callTool(caps, 'write_file', { path: 'src/other.js', content: 'bad' }));
    assert.equal(fs.readFileSync(path.join(f.repo, 'src/a.js'), 'utf8'), 'export const value = 1;\n');
    assert.equal(other.overlay.get('src/a.js'), 'export const value = 1;\n');
    assert.equal(fs.existsSync(path.join(f.repo, 'src/new.js')), false);
    assert.equal(caps.changes().length, 2);
  } finally { f.cleanup(); }
});
test('existing write targets must be included in the worker read set', () => {
  const f = makeFixture();
  try {
    fs.writeFileSync(path.join(f.repo, 'other.js'), 'not supplied\n');
    const input = makePlan(f.repo); Object.assign(input.agents[0], { mode: 'write', write_files: ['other.js'] });
    assert.throws(() => captureSnapshot(validatePlan(input, defaults)));
  } finally { f.cleanup(); }
});
test('new candidate files are absent in baseline; concurrent creation invalidates snapshot', () => {
  const f = makeFixture();
  try {
    const input = makePlan(f.repo); Object.assign(input.agents[0], { mode: 'write', write_files: ['src/new.js'] });
    const snapshot = captureSnapshot(validatePlan(input, defaults));
    assert.equal(snapshot.get('src/new.js'), null);
    fs.writeFileSync(path.join(f.repo, 'src/new.js'), 'user change\n');
    assert.deepEqual(verifySnapshot(f.repo, manifestOf(snapshot)), ['src/new.js']);
  } finally { f.cleanup(); }
});
test('submission validates evidence and terminates further tool use', async () => {
  const f = makeFixture();
  try {
    const p = validatePlan(makePlan(f.repo), defaults); const caps = createCapabilities(p.agents[0], captureSnapshot(p), p.policy);
    const bad = submission(); bad.findings = [{ id: 'F1', title: 'Claim', severity: 'high', confidence: 'high', file: 'unseen.js', line: 1, evidence: 'E', recommendation: 'R' }];
    await assert.rejects(callTool(caps, 'submit_result', bad));
    const result = await callTool(caps, 'submit_result', submission());
    assert.equal(result.terminate, true);
    await assert.rejects(callTool(caps, 'read_file', { path: 'src/a.js' }));
  } finally { f.cleanup(); }
});
test('a billed request is not double-counted with its estimate; missing cost is unknown', () => {
  const value = costSummary([{ billed_usd: 0.2, estimate_usd: 0.3 }, { billed_usd: null, estimate_usd: 0.1 }, { billed_usd: null, estimate_usd: null }]);
  assert.equal(value.provider_reported_usd, 0.2); assert.equal(value.estimated_unreconciled_usd, 0.1);
  assert.equal(value.unpriced_request_count, 1); assert.equal(value.all_requests_reconciled, false);
  assert.equal(costSummary([{ billed_usd: 0 }]).all_requests_reconciled, true);
});
test('reconciliation uses generation total_cost and is idempotent', async () => {
  const r = { provider: 'openrouter', response_id: 'gen-1', billed_usd: null };
  let calls = 0;
  const fetcher = async () => { calls++; return { data: { total_cost: 0.123, provider_name: 'Example', model: 'test/model', is_byok: false } }; };
  await reconcileRecord(r, 'SECRET', fetcher); await reconcileRecord(r, 'SECRET', fetcher);
  assert.equal(r.billed_usd, 0.123); assert.equal(calls, 1);
});
test('failed billing lookup does not invent a zero charge or log the key', async () => {
  const r = { provider: 'openrouter', response_id: 'gen-1', billed_usd: null };
  await reconcileRecord(r, 'MYKEY', async () => { throw new Error('Unavailable MYKEY'); });
  assert.equal(r.billed_usd, null); assert.ok(!r.reconciliation_error.includes('MYKEY'));
});
class FakeAgent {
  constructor(options) { this.options = options; this.listeners = []; }
  subscribe(fn) { this.listeners.push(fn); }
  abort() {}
  async emit(event) { for (const fn of this.listeners) await fn(event); }
  async prompt() {
    const o = this.options;
    await o.streamFn(o.initialState.model, { systemPrompt: 'test', messages: [] }, {});
    const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 2, totalTokens: 15, cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 } };
    await this.emit({ type: 'message_end', message: { role: 'assistant', responseId: 'gen-fixture', stopReason: 'toolUse', content: [], usage } });
    const tools = o.initialState.tools;
    const write = tools.find(t => t.name === 'write_file');
    if (write) await write.execute('w', { path: 'src/a.js', content: 'export const value = 2;\n' });
    await tools.find(t => t.name === 'submit_result').execute('s', submission());
    assert.equal(o.shouldStopAfterTurn(), true);
  }
}
test('offline runner integration preserves source, writes candidate artifacts and bills each request once', async () => {
  const f = makeFixture(); const out = f.repo + '-output';
  try {
    const input = makePlan(f.repo); Object.assign(input.agents[0], { mode: 'write', write_files: ['src/a.js'] });
    const raw = modelRecord(input.agents[0].model); const model = openRouterModel(raw, defaults.openrouter_routing);
    const { report } = await executeJob(input, out, {
      Agent: FakeAgent, keyFor: () => 'TEST_KEY',
      resolve: async a => ({ model, metadata: { requested_model: a.model, resolved_model: a.model, effective_pi_effort: 'max', configured_provider_effort: 'max', max_output_tokens: 1000 } }),
      adapter: () => ({ streamSimple: async () => undefined }),
      fetchGeneration: async () => ({ data: { total_cost: 0.025, model: raw.id, provider_name: 'fixture' } }),
      createPatch: (a, b, before, after) => `--- ${a}\n+++ ${b}\n-test patch stub\n`
    });
    assert.equal(report.mode, 'offline_test_double');
    assert.equal(report.agents[0].status, 'completed');
    assert.equal(report.agents[0].changes.length, 1);
    assert.equal(report.costs.provider_reported_usd, 0.025);
    assert.equal(report.costs.estimated_unreconciled_usd, 0);
    assert.equal(report.source_snapshot_still_current, true);
    assert.equal(report.usefulness_assessment, null);
    assert.equal(fs.readFileSync(path.join(out, 'review/candidate/src/a.js'), 'utf8'), 'export const value = 2;\n');
    assert.equal(fs.readFileSync(path.join(f.repo, 'src/a.js'), 'utf8'), 'export const value = 1;\n');
    assert.ok(!fs.readFileSync(path.join(out, 'report.json'), 'utf8').includes('TEST_KEY'));
  } finally { f.cleanup(); fs.rmSync(out, { recursive: true, force: true }); }
});


test('findings keep original evidence lines after candidate deletion', async () => {
  const f = makeFixture();
  try {
    fs.writeFileSync(path.join(f.repo, 'src/a.js'), 'first\nsecond\nthird\n');
    const input = makePlan(f.repo); Object.assign(input.agents[0], { mode: 'write', write_files: ['src/a.js'] });
    const p = validatePlan(input, defaults); const caps = createCapabilities(p.agents[0], captureSnapshot(p), p.policy);
    await callTool(caps, 'delete_file', { path: 'src/a.js' });
    const answer = submission();
    answer.findings = [{ id: 'F1', title: 'Dead code', severity: 'low', confidence: 'high', file: 'src/a.js', line: 3, evidence: 'third', recommendation: 'Remove obsolete code.' }];
    await callTool(caps, 'submit_result', answer);
    assert.equal(caps.state.submitted.findings[0].line, 3);
  } finally { f.cleanup(); }
});

test('every shipped example and template validates against the bundled defaults',()=>{
  // A hand-edited defaults.json once silently replaced two pool models; the examples caught it.
  const defaults=JSON.parse(fs.readFileSync(path.join(root,'defaults.json'),'utf8'));
  for(const f of ['examples/read-only.plan.json','examples/claude-code.plan.json','examples/implementation.plan.json','templates/plan.example.json']){
    const plan=JSON.parse(fs.readFileSync(path.join(root,f),'utf8'));
    const repo=fs.mkdtempSync(path.join(os.tmpdir(),'pi-example-'));
    try{
      for(const rel of plan.read_files){const t=path.join(repo,...rel.split('/'));fs.mkdirSync(path.dirname(t),{recursive:true});fs.writeFileSync(t,'// fixture\n');}
      const valid=validatePlan({...plan,repo_root:repo},defaults);
      assert.ok(valid.agents.length>0,`${f} has no agents`);
      for(const a of valid.agents) assert.ok(defaults.preferred_models.includes(a.model)||a.model_exception_reason,`${f}: ${a.model} is outside the preferred pool without a stated exception`);
    } finally {fs.rmSync(repo,{recursive:true,force:true});}
  }
});
test('the documented model pool in README matches the bundled defaults',()=>{
  const defaults=JSON.parse(fs.readFileSync(path.join(root,'defaults.json'),'utf8'));
  const readme=fs.readFileSync(path.join(root,'README.md'),'utf8');
  const block=readme.match(/preferred pool:\n+```text\n([^`]+)```/);
  assert.ok(block,'README no longer documents the preferred pool in a text block after "preferred pool:"');
  assert.deepEqual(block[1].trim().split('\n').map(s=>s.trim()),defaults.preferred_models);
});
