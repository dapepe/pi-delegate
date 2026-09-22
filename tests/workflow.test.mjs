/** Synthetic fixtures only: no SDK, credentials, network or paid inference. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { validateWorkflow, workflowBrief, workflowDiagram, initWorkflow, runWorkflow, decideWorkflow, workflowStatus, workflowMain, checkWorkflow } from '../scripts/workflow.mjs';
import { openRouterModel } from '../scripts/lib.mjs';
import { STRATEGIES as evaluationStrategies } from '../scripts/evaluation.mjs';
import { STRATEGIES as learningStrategies } from '../scripts/learning.mjs';

const defaults = JSON.parse(fs.readFileSync(new URL('../defaults.json', import.meta.url), 'utf8'));
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const submission = completion => ({ summary: 'Synthetic result; host tests still required.', findings: [], proposed_tests: [], open_questions: [], completion, remaining_work: completion === 'complete' ? [] : ['Unfinished fixture work'] });
function fixture(t, loop = false) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-workflow-'))), repo = path.join(base, 'repo'), out = path.join(base, 'workflow');
  fs.mkdirSync(repo); fs.writeFileSync(path.join(repo, 'a.js'), 'original\n');
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const phase = (id, mode, model) => ({ id, title: id, input: id === 'implement' ? 'baseline' : { step: 'implement', agent: 'worker' }, plan: {
    orchestrator: 'codex', repo_root: repo, objective: `Synthetic ${id}`, context: 'Keep the response under 100 words.',
    policy: { max_agents: 1, max_parallel: 1 }, read_files: ['a.js'],
    agents: [{ id: 'worker', role: 'sparring-partner', model, effort: 'xhigh', mode, write_files: mode === 'write' ? ['a.js'] : [], task: `Synthetic ${id} assignment`, selection_reason: 'Synthetic exact model fixture' }],
    evaluation: { schema_version: 1, task_id: 'synthetic-task', task_type: 'bugfix', scope: '.', complexity: 'bounded', strategy: loop ? 'bounded-loop' : 'sequence', strategy_version: 'v1', focus: ['correctness'], workers: [{ agent_id: 'worker', assignment_id: `${id}-assignment`, attempt_index: 1, criteria: [{ id: 'work', requirement: `Complete ${id}` }] }] }
  } });
  const workflow = { schema_version: 1, task_id: 'synthetic-task', objective: 'Synthetic workflow', orchestrator: 'codex', repo_root: repo,
    criteria: [{ id: 'tests', requirement: 'Host regression checks pass' }, { id: 'findings', requirement: 'Host resolves blocking findings' }], limits: { budget_usd: 5, timeout_seconds: 3600 },
    steps: [phase('implement', 'write', defaults.preferred_models[2]), phase('review', 'read', defaults.preferred_models[1])],
    ...(loop ? { loop: { max_iterations: 3, repeat_from: { step: 'implement', agent: 'worker' } } } : {}) };
  const dependencies = (behavior, charge = 0.01, extra = {}) => {
    class SyntheticAgent {
      constructor(o) { this.o = o; this.listeners = []; }
      subscribe(fn) { this.listeners.push(fn); }
      abort() { this.aborted = true; }
      async prompt() {
        await this.o.streamFn(this.o.initialState.model, this.o.initialState, {});
        for (const fn of this.listeners) await fn({ type: 'message_end', message: { role: 'assistant', stopReason: 'toolUse', responseId: 'synthetic', responseModel: this.o.initialState.model.id, usage: { input: 10, output: 5, totalTokens: 15, cost: { total: charge } } } });
        await behavior(this);
      }
      tool(name, args) { return this.o.initialState.tools.find(t => t.name === name).execute('synthetic', args); }
      submit(completion = 'complete') { return this.tool('submit_result', submission(completion)); }
    }
    return { Agent: SyntheticAgent, keyFor: () => 'SYNTHETIC', createPatch: () => 'synthetic diff',
      resolve: async a => ({ model: openRouterModel({ id: a.model, reasoning: { supported_efforts: ['high', 'max'] }, pricing: { prompt: '0.000001', completion: '0.000002' }, context_length: 128000, top_provider: { max_completion_tokens: 32768 } }, defaults.openrouter_routing), metadata: { provider: 'openrouter', requested_model: a.model, resolved_model: a.model, requested_effort: 'xhigh', effective_pi_effort: 'max', configured_provider_effort: 'max', max_output_tokens: 1000 } }),
      adapter: () => ({ streamSimple: () => undefined }), fetchGeneration: async () => { throw new Error('Synthetic billing unavailable; use the estimate'); }, ...extra };
  };
  const run = (behavior, charge, extra, packet) => runWorkflow(out, packet || {}, dependencies(behavior || (a => a.submit()), charge, extra));
  const decision = (action, extra = {}) => { const s = workflowStatus(out); return { revision: s.revision, run_id: s.runs.at(-1).id, assessed_by: 'Codex', action, evidence: ['Synthetic host inspection'], ...extra }; };
  const decide = (action, extra) => decideWorkflow(out, decision(action, extra));
  const checks = result => workflow.criteria.map(c => ({ id: c.id, result, evidence: ['Synthetic host check'] }));
  return { base, repo, out, workflow, run, dependencies, decision, decide, checks, init: () => initWorkflow(workflow, out) };
}

test('workflow validation rejects unknown fields, unbounded loops, foreign hosts/tasks and forward handoffs', t => {
  const f = fixture(t, true);
  assert.equal(validateWorkflow(f.workflow).steps.length, 2);
  for (const mutate of [w => { w.shell = 'bad'; }, w => { w.loop.max_iterations = 0; }, w => { w.loop.loop = {}; }, w => { w.steps[0].input = { step: 'review', agent: 'worker' }; }, w => { w.steps[1].plan.orchestrator = 'claude-code'; }, w => { w.steps[1].plan.evaluation.task_id = 'other'; }, w => { w.steps[1].plan.evaluation.workers[0].assignment_id = 'implement-assignment'; }, w => { w.steps[0].plan.agents[0].model = 'unapproved'; }]) {
    const w = structuredClone(f.workflow); mutate(w); assert.throws(() => validateWorkflow(w));
  }
  for (const strategy of ['sequence', 'bounded-loop']) { assert.ok(evaluationStrategies.includes(strategy)); assert.ok(Object.hasOwn(learningStrategies, strategy)); }
});

test('preview uses the same sequence and loop edges in Mermaid and ASCII and escapes labels', t => {
  const f = fixture(t, true), w = validateWorkflow(f.workflow);
  w.steps[0].title = 'Edit "x" <script> `bad`\nnode';
  const ascii = workflowDiagram(w), diagram = workflowDiagram(w, 'auto', true), brief = workflowBrief(w);
  assert.match(ascii, /^```text/); assert.match(ascii, /Repeat from step 1; max 3 cycles/);
  assert.match(diagram, /^```mermaid/); assert.match(diagram, /H0 --> S1/); assert.match(diagram, /--> S0/);
  assert.doesNotMatch(diagram, /<script>|`bad`|Edit "x"/); assert.match(brief, /Candidate-write/); assert.match(brief, /Host-verified completion/);
  delete w.loop; assert.doesNotMatch(workflowDiagram(w, 'mermaid'), /--> S0/);
});

test('sequence hands the actual candidate to a different reviewer without changing the checkout', async t => {
  const f = fixture(t); f.init();
  const first = await f.run(async a => { await a.tool('replace_text', { path: 'a.js', old_text: 'original', new_text: 'candidate' }); await a.submit(); });
  await assert.rejects(f.run(), /host review/);
  await f.decide('advance');
  const review = await f.run(async a => {
    assert.equal(a.o.initialState.model.id, defaults.preferred_models[1]);
    const content = await a.tool('read_file', { path: 'a.js' }); assert.match(JSON.stringify(content), /candidate/); await a.submit();
  });
  assert.notEqual(json(path.join(first.out, 'snapshot.json')).repo_root, json(path.join(review.out, 'snapshot.json')).repo_root);
  const done = await f.decide('complete', { checks: f.checks('passed') });
  assert.equal(done.status, 'goal_achieved'); assert.equal(done.costs.estimated_unreconciled_usd, 0.02);
  assert.equal(fs.readFileSync(path.join(f.repo, 'a.js'), 'utf8'), 'original\n');
});

test('loop keeps task/assignment identity, carries candidate and feedback, and totals every iteration', async t => {
  const f = fixture(t, true); f.init();
  await f.run(async a => { await a.tool('replace_text', { path: 'a.js', old_text: 'original', new_text: 'v1' }); await a.submit(); });
  await f.decide('advance'); await f.run();
  await f.decide('repeat', { checks: f.checks('failed'), progress: true, remaining_work: ['Refine the candidate'] });
  const next = await f.run(async a => { assert.match(JSON.stringify(await a.tool('read_file', { path: 'a.js' })), /v1/); await a.submit(); }, 0.02, {}, { tasks: { worker: 'Fix the host-validated remaining issue' } });
  const plan = json(path.join(next.out, 'plan.json'));
  assert.equal(plan.evaluation.task_id, 'synthetic-task'); assert.equal(plan.evaluation.workers[0].assignment_id, 'implement-assignment'); assert.equal(plan.evaluation.workers[0].attempt_index, 2);
  assert.match(plan.agents[0].task, /remaining issue/); assert.equal(plan.policy.session_budget_usd, 4.98);
  assert.equal(next.workflow.costs.estimated_unreconciled_usd, 0.04);
});

test('loop reports stalled or limit reached instead of success', async t => {
  for (const progress of [false, true]) {
    const f = fixture(t, true); f.workflow.loop.max_iterations = 1; f.init();
    await f.run(); await f.decide('advance'); await f.run();
    const result = await f.decide('repeat', { checks: f.checks('failed'), progress, remaining_work: ['Goal unmet'] });
    assert.equal(result.status, progress ? 'limit_reached' : 'stalled'); await assert.rejects(f.run(), /host review/);
  }
});

test('closing checks bind to the current host, revision, run and exact criterion set', async t => {
  const f = fixture(t); f.init(); await f.run(); await f.decide('advance'); await f.run();
  for (const patch of [{ assessed_by: 'Claude Code' }, { revision: 0 }, { run_id: 'other' }, { checks: f.checks('failed') }, { checks: f.checks('unknown') }, { checks: f.checks('not_run') }, { checks: [] }, { remaining_work: ['Still unfinished'] }]) {
    await assert.rejects(decideWorkflow(f.out, f.decision('complete', { checks: f.checks('passed'), ...patch })));
  }
  assert.equal(workflowStatus(f.out).status, 'awaiting_host');
});

test('partial output cannot advance even when its process completed cleanly', async t => {
  const f = fixture(t); f.init(); await f.run(a => a.submit('partial'));
  await assert.rejects(f.decide('advance'), /complete nonfinal phase/);
  const result = await f.decide('stop', { reason: 'blocked', remaining_work: ['Candidate incomplete'] }); assert.equal(result.status, 'blocked');
});

test('changed candidate bytes, input source, or saved contract refuse handoff', async t => {
  for (const kind of ['candidate', 'source', 'contract']) {
    const f = fixture(t); f.init(); const result = await f.run(async a => { await a.tool('replace_text', { path: 'a.js', old_text: 'original', new_text: 'candidate' }); await a.submit(); }); await f.decide('advance');
    if (kind === 'candidate') fs.writeFileSync(path.join(result.out, 'worker/candidate/a.js'), 'changed');
    if (kind === 'source') fs.writeFileSync(path.join(f.repo, 'a.js'), 'changed');
    if (kind === 'contract') { const name = path.join(f.out, 'workflow.json'), w = json(name); w.limits.budget_usd *= 2; fs.writeFileSync(name, JSON.stringify(w)); }
    await assert.rejects(f.run(), /changed|stale|hash/);
  }
});

test('new and deleted files are represented in the candidate snapshot and repeat input', async t => {
  const f = fixture(t, true); fs.writeFileSync(path.join(f.repo, 'removed.js'), 'remove');
  f.workflow.steps[0].plan.read_files.push('removed.js'); f.workflow.steps[0].plan.agents[0].write_files.push('removed.js', 'new.js');
  f.workflow.steps[1].plan.read_files.push('removed.js', 'new.js'); f.init();
  await f.run(async a => { await a.tool('delete_file', { path: 'removed.js' }); await a.tool('write_file', { path: 'new.js', content: 'added' }); await a.submit(); });
  await f.decide('advance'); const review = await f.run();
  const p = json(path.join(review.out, 'plan.json')); assert.ok(!p.read_files.includes('removed.js')); assert.ok(p.read_files.includes('new.js')); assert.equal(fs.existsSync(path.join(p.repo_root, 'removed.js')), false);
  await f.decide('repeat', { checks: f.checks('failed'), progress: true, remaining_work: ['Refinement'] });
  const repeat = await f.run(); const rp = json(path.join(repeat.out, 'plan.json')); assert.ok(rp.agents[0].read_files.includes('new.js'));
});

test('workflow spending is shared and an overshooting charge prevents a later phase', async t => {
  const f = fixture(t); f.workflow.limits.budget_usd = 0.1; f.init();
  await f.run(undefined, 0.2); await f.decide('advance');
  const result = await f.run(); assert.equal(result.status, 'limit_reached'); assert.equal(result.runs.length, 1); assert.equal(result.costs.estimated_unreconciled_usd, 0.2);
});

test('unknown charges retain their reservations and reconciliation replaces estimates', async t => {
  const f = fixture(t); f.init(); const result = await f.run(); const usagePath = path.join(result.out, 'usage.json'), usage = json(usagePath);
  usage.requests[0].estimate_usd = null; usage.requests[0].billed_usd = null; usage.requests[0].reserved_usd = 0.4; fs.writeFileSync(usagePath, JSON.stringify(usage));
  let s = workflowStatus(f.out); assert.equal(s.costs.unpriced_request_count, 1); assert.equal(s.costs.remaining_budget_usd, 4.6);
  usage.requests[0].billed_usd = 0.05; fs.writeFileSync(usagePath, JSON.stringify(usage));
  s = workflowStatus(f.out); assert.equal(s.costs.remaining_budget_usd, 4.95); assert.equal(s.costs.estimated_unreconciled_usd, 0);
});

test('host review time counts toward the shared deadline and metadata delays cannot start paid inference', async t => {
  const f = fixture(t); f.workflow.limits.timeout_seconds = 10; f.init(); let time = 100000;
  const result = await f.run(undefined, 0.01, { now: () => time }); await f.decide('advance'); time += 11000;
  assert.equal((await f.run(undefined, 0.01, { now: () => time })).status, 'limit_reached'); assert.equal(result.workflow.runs.length, 1);
  const g = fixture(t); g.workflow.limits.timeout_seconds = 10; g.init(); time = 100000;
  const deps = g.dependencies(a => a.submit(), 0.01, { now: () => time }), resolve = deps.resolve;
  deps.resolve = async a => { time += 11000; return resolve(a); };
  const delayed = await runWorkflow(g.out, {}, deps); assert.equal(delayed.workflow.costs.request_count, 0);
});

test('workflow lock blocks duplicate execution and missing ledgers never become free spend', async t => {
  const f = fixture(t); f.init(); fs.mkdirSync(path.join(f.out, '.workflow-lock')); await assert.rejects(f.run(), /locked/); fs.rmdirSync(path.join(f.out, '.workflow-lock'));
  const result = await f.run(); fs.unlinkSync(path.join(result.out, 'usage.json'));
  const status = workflowStatus(f.out); assert.equal(status.costs.remaining_budget_usd, 0); assert.equal(status.costs.missing_ledger_reserve_usd, 5);
  assert.equal(status.costs.missing_ledger_run_count, 1); assert.equal(status.costs.all_requests_reconciled, false);
});

test('CLI previews are local, fail closed on unsupported flags, and preserve existing commands', async t => {
  const f = fixture(t); f.init();
  assert.match(await workflowMain(['preview', '--out', f.out]), /```text/);
  await assert.rejects(workflowMain(['preview', '--out', f.out, '--mermaid-supported', 'maybe']));
  await assert.rejects(workflowMain(['run', '--out', f.out, '--shell', 'bad']));
  const cli = fileURLToPath(new URL('../scripts/pi.mjs', import.meta.url));
  const help = spawnSync(process.execPath, [cli, 'workflow', 'help'], { encoding: 'utf8' }); assert.equal(help.status, 0, help.stderr); assert.match(help.stdout, /exactly one phase/);
  const legacy = spawnSync(process.execPath, [cli, 'help'], { encoding: 'utf8' }); assert.equal(legacy.status, 0, legacy.stderr); assert.match(legacy.stdout, /run --plan/);
});

test('all-model metadata preflight reports effective effort and fails if a later model is missing', async t => {
  const f = fixture(t), workflow = validateWorkflow(f.workflow), seen = [];
  const result = await checkWorkflow(workflow, { makeResolver: () => async a => { seen.push(a.model); return { metadata: { resolved_model: a.model, requested_effort: 'xhigh', effective_pi_effort: 'high' } }; } });
  assert.deepEqual(seen, workflow.steps.map(s => s.plan.agents[0].model)); assert.equal(result.workers[1].effective_pi_effort, 'high');
  await assert.rejects(checkWorkflow(workflow, { makeResolver: () => async a => { if (a.mode === 'read') throw new Error('Synthetic unavailable model'); return { metadata: {} }; } }), /unavailable/);
});

test('operational retry requires a changed packet, preserves the budget, and cannot repeat blindly', async t => {
  const f = fixture(t); f.init();
  const fail = async () => { throw new Error('429 rate limit synthetic fixture'); };
  const first = await f.run(fail);
  assert.equal(json(path.join(first.out, 'report.json')).agents[0].failure_class, 'provider_rate_limit');
  await f.decide('retry', { reason: 'Narrow the submission to the one necessary behavior' });
  await assert.rejects(f.run(), /change exactly one/);
  const second = await f.run(fail, 0.01, {}, { tasks: { worker: 'Inspect only the one behavior; submit under 100 words' } });
  assert.equal(second.workflow.runs.length, 2); assert.equal(second.workflow.costs.estimated_unreconciled_usd, 0.02);
  assert.equal(json(path.join(second.out, 'plan.json')).evaluation.workers[0].attempt_index, 2);
  await assert.rejects(f.decide('retry', { reason: 'Try again' }), /Only one/);
});

test('a non-operational error cannot authorize an operational retry', async t => {
  const f = fixture(t); f.init(); const result = await f.run(async () => { throw new Error('Synthetic refusal'); });
  const report = json(path.join(result.out, 'report.json')); assert.notEqual(report.agents[0].failure_class, 'provider_rate_limit');
  await assert.rejects(f.decide('retry', { reason: 'Try again' }), /Only an operational/);
});

test('a host can record a blocker before any run or after a failed handoff', async t => {
  const f = fixture(t); f.init();
  const result = await decideWorkflow(f.out, { revision: 1, run_id: null, assessed_by: 'Codex', action: 'stop', reason: 'blocked', evidence: ['Synthetic route unavailable before inference'], remaining_work: ['Resolve route availability'] });
  assert.equal(result.status, 'blocked'); assert.equal(result.costs.request_count, 0);
  const g = fixture(t); g.init(); await g.run(); await g.decide('advance'); fs.writeFileSync(path.join(g.repo, 'a.js'), 'changed');
  await assert.rejects(g.run(), /stale/);
  assert.equal((await g.decide('stop', { reason: 'blocked', remaining_work: ['Replan against changed source'] })).status, 'blocked');
});

test('hard-killed runs can be stopped after host process inspection, retaining unknown exposure', async t => {
  const f = fixture(t); f.init();
  const file = path.join(f.out, 'workflow-state.json'), state = json(file);
  state.status = 'running'; state.started_at = Date.now(); state.runs.push({ id: 'run-interrupted', step: 'implement', iteration: 1, attempt_index: 1, status: 'running', allocation_usd: 2, accepted: false });
  fs.writeFileSync(file, JSON.stringify(state));
  await assert.rejects(f.run(), /host review/);
  const result = await f.decide('stop', { reason: 'blocked', remaining_work: ['Inspect interrupted artifacts and billing'], evidence: ['Synthetic host confirmation: no active process remains'] });
  assert.equal(result.status, 'blocked'); assert.equal(result.costs.missing_ledger_reserve_usd, 2);
});

test('parallel independent workers remain independent within a phase', async t => {
  const f = fixture(t), implement = f.workflow.steps[0].plan;
  implement.policy.max_agents = 2; implement.policy.max_parallel = 2;
  implement.agents.push({ ...implement.agents[0], id: 'independent', mode: 'read', write_files: [], model: defaults.preferred_models[1] });
  implement.evaluation.workers.push({ ...implement.evaluation.workers[0], agent_id: 'independent', assignment_id: 'independent-assignment' });
  f.init();
  const result = await f.run(async a => {
    if (a.o.initialState.model.id === defaults.preferred_models[1]) assert.match(JSON.stringify(await a.tool('read_file', { path: 'a.js' })), /original/);
    else await a.tool('replace_text', { path: 'a.js', old_text: 'original', new_text: 'candidate' });
    await a.submit();
  });
  assert.equal(json(path.join(result.out, 'report.json')).agents.length, 2); assert.equal((await f.decide('advance')).status, 'ready');
});

test('handoffs cannot expand source scope and reject symlinked output state', async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.repo, 'extra.js'), 'not seen by producer'); f.workflow.steps[1].plan.read_files.push('extra.js'); f.init();
  await f.run(); await f.decide('advance'); await assert.rejects(f.run(), /not in the producer snapshot/);
  assert.throws(() => initWorkflow(f.workflow, path.join(f.repo, 'state')), /outside/);
  if (process.platform !== 'win32') {
    const link = path.join(f.base, 'linked-workflow'); fs.symlinkSync(f.out, link); assert.throws(() => workflowStatus(link), /symlink/);
  }
});

test('the shipped synthetic template validates after replacing repository and host paths', t => {
  const f = fixture(t), template = JSON.parse(fs.readFileSync(new URL('../templates/workflow.example.json', import.meta.url), 'utf8'));
  template.repo_root = f.repo; template.orchestrator = 'claude-code';
  for (const s of template.steps) { s.plan.repo_root = f.repo; s.plan.orchestrator = 'claude-code'; }
  assert.equal(validateWorkflow(template).orchestrator, 'claude-code'); assert.match(workflowBrief(validateWorkflow(template)), /Host: Claude Code/);
});
