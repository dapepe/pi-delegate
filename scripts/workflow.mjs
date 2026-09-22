/** Host-controlled sequences and bounded loops. No worker tools, automatic transitions or integration. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  assert, text, isNumber, inside, hostLabel, validatePlan, captureSnapshot, manifestOf,
  verifySnapshot, readSource, costSummary, sha256, checkRel
} from './lib.mjs';
import { readArtifactIdentity } from './evaluation.mjs';
import { readLocal, writeLocal, localPath, bytesHash, jsonText } from './project-files.mjs';

const defaults = JSON.parse(fs.readFileSync(new URL('../defaults.json', import.meta.url), 'utf8'));
const terminal = new Set(['goal_achieved', 'limit_reached', 'stalled', 'blocked']);
const operational = new Set(['provider_rate_limit', 'provider_error', 'request_timeout', 'timeout', 'output_limit_reasoning']);
const slug = (v, label) => { text(v, label, 64); assert(/^[a-z][a-z0-9_-]*$/.test(v), `${label} must be a portable lowercase identifier`); return v; };
function object(value, keys, label) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  for (const key of Object.keys(value)) assert(keys.includes(key), `Unknown ${label} field: ${key}`);
}
function strings(value, label, min = 1) {
  assert(Array.isArray(value) && value.length >= min && value.length <= 32, `${label} must contain ${min}–32 entries`);
  value.forEach(v => text(v, label, 4000));
}
function reference(value, steps, label) {
  object(value, ['step', 'agent'], label);
  const step = steps.find(s => s.id === value.step);
  assert(step, `${label} must reference an earlier declared step`);
  assert(step.plan.agents.some(a => a.id === value.agent && a.mode === 'write'), `${label} must reference a candidate-write worker`);
}

export function validateWorkflow(input) {
  object(input, ['schema_version', 'task_id', 'objective', 'orchestrator', 'repo_root', 'criteria', 'limits', 'loop', 'steps'], 'workflow');
  assert(input.schema_version === 1, 'Unsupported workflow schema_version');
  slug(input.task_id, 'task_id'); text(input.objective, 'objective', 8000); hostLabel(input.orchestrator);
  const repo = fs.realpathSync(input.repo_root);
  assert(fs.statSync(repo).isDirectory(), 'repo_root must be a directory');
  assert(Array.isArray(input.criteria) && input.criteria.length > 0 && input.criteria.length <= 8, 'Workflow needs 1–8 closing criteria');
  const ids = new Set();
  for (const c of input.criteria) {
    object(c, ['id', 'requirement'], 'criterion'); slug(c.id, 'criterion.id'); text(c.requirement, 'criterion.requirement', 4000);
    assert(!ids.has(c.id), 'Duplicate closing criterion'); ids.add(c.id);
  }
  object(input.limits, ['budget_usd', 'timeout_seconds'], 'limits');
  assert(isNumber(input.limits.budget_usd) && input.limits.budget_usd > 0, 'Workflow budget must be positive');
  assert(Number.isInteger(input.limits.timeout_seconds) && input.limits.timeout_seconds > 0 && input.limits.timeout_seconds <= 86400, 'Workflow timeout must be 1–86400 seconds');
  assert(Array.isArray(input.steps) && input.steps.length > 0 && input.steps.length <= 16, 'Workflow needs 1–16 steps');
  const steps = [], assignments = new Set();
  for (const s of input.steps) {
    object(s, ['id', 'title', 'input', 'plan'], 'step'); slug(s.id, 'step.id'); text(s.title, 'step.title', 300);
    assert(!steps.some(v => v.id === s.id), 'Duplicate step id');
    if (s.input !== 'baseline') reference(s.input, steps, 'step.input');
    const plan = validatePlan(s.plan, defaults);
    assert(plan.repo_root === repo && plan.orchestrator === input.orchestrator, 'Every step must retain the workflow repository and host');
    assert(plan.evaluation?.task_id === input.task_id, 'Every step needs evaluation with the same workflow task_id');
    for (const worker of plan.evaluation.workers) {
      assert(!assignments.has(worker.assignment_id), 'Assignments must be distinct across steps'); assignments.add(worker.assignment_id);
      assert(worker.attempt_index === 1, 'Workflow template attempt_index must start at 1');
    }
    steps.push({ ...s, plan });
  }
  if (input.loop !== undefined) {
    object(input.loop, ['max_iterations', 'repeat_from'], 'loop');
    assert(Number.isInteger(input.loop.max_iterations) && input.loop.max_iterations >= 1 && input.loop.max_iterations <= 100, 'Loop needs an explicit limit of 1–100 iterations');
    assert(steps[0].input === 'baseline', 'The first loop step must start at the baseline');
    if (input.loop.repeat_from !== undefined) reference(input.loop.repeat_from, steps, 'loop.repeat_from');
  }
  return { ...input, repo_root: repo, steps };
}

// Display data is never interpreted as Mermaid syntax, HTML, terminal escapes or Markdown links.
const plain = value => String(value).replace(/[\x00-\x1f\x7f]/g, ' ');
const md = value => plain(value).replace(/[\\`*_{}\[\]<>()|!#~]/g, c => `\\${c}`);
const mermaid = value => plain(value).replace(/[&"<>`#]/g, c => `#${c.charCodeAt(0)};`);
const briefText = value => { const s = plain(value).replace(/\s+/g, ' '); return md(s.length > 240 ? `${s.slice(0, 237)}...` : s); };
const scopeText = files => files.slice(0, 5).map(md).join(', ') + (files.length > 5 ? `, +${files.length - 5} paths (see contract)` : '');
export function workflowDiagram(workflow, format = 'auto', mermaidSupported = false) {
  assert(['auto', 'mermaid', 'ascii'].includes(format), 'Diagram must be auto, mermaid or ascii');
  const useMermaid = format === 'mermaid' || format === 'auto' && mermaidSupported;
  const labels = workflow.steps.map(s => `${s.title}: ${s.plan.agents.map(a => `${a.role} / ${a.provider}/${a.model}`).join(' + ')}`);
  if (!useMermaid) {
    const rows = labels.flatMap((label, i) => [`[${i + 1}. ${plain(label)}]`, '    |', '[Host: inspect output and authorize handoff]', '    |']);
    rows.push('[Host: validate closing criteria]', '    |-- met --> [Goal achieved; host decides integration]');
    if (workflow.loop) rows.push(`    |-- unmet + progress + limits allow --> [Repeat from step 1; max ${workflow.loop.max_iterations} cycles]`);
    rows.push('    +-- otherwise --> [Stop; report remaining work]');
    return '```text\n' + rows.join('\n') + '\n```';
  }
  const rows = ['flowchart TD'];
  labels.forEach((label, i) => {
    rows.push(`  S${i}["${mermaid(label)}"] --> H${i}["Host: inspect output and authorize handoff"]`);
    if (i + 1 < labels.length) rows.push(`  H${i} --> S${i + 1}`);
  });
  rows.push(`  H${labels.length - 1} --> G{"Host: closing criteria satisfied?"}`, '  G -- Yes --> D["Goal achieved; host decides integration"]');
  if (workflow.loop) rows.push('  G -- No --> L{"Progress and limits allow another cycle?"}', `  L -- "Yes; max ${workflow.loop.max_iterations} cycles" --> S0`, '  L -- No --> X["Stop; report remaining work"]');
  else rows.push('  G -- No --> X["Stop; report remaining work"]');
  return '```mermaid\n' + rows.join('\n') + '\n```';
}
export function workflowBrief(workflow, options = {}) {
  const rows = [`Goal: ${md(workflow.objective)}`, '',
    `Host: ${hostLabel(workflow.orchestrator)}. ${workflow.loop ? `Loop: at most ${workflow.loop.max_iterations} complete cycles` : 'Sequence: one pass'}. Shared soft allowance: $${workflow.limits.budget_usd}; ${workflow.limits.timeout_seconds} seconds from the first run, including host review.`, '',
    '| Step | Assignment | Provider / model | Effort | Access | Selection reason |', '| --- | --- | --- | --- | --- | --- |'];
  for (const s of workflow.steps) for (const a of s.plan.agents) rows.push(`| ${md(s.title)} | ${md(a.role)}: ${briefText(a.task)} | ${md(a.provider)}/${md(a.model)} | ${a.effort} requested | ${a.mode === 'read' ? 'Read-only' : 'Candidate-write'}; read: ${scopeText(a.read_files)}; write: ${scopeText(a.write_files) || 'none'} | ${briefText(a.selection_reason)} |`);
  rows.push('', 'Handoffs:');
  for (const s of workflow.steps) rows.push(`- ${md(s.title)}: ${s.input === 'baseline' ? 'original project baseline' : `host-reviewed candidate from ${md(s.input.step)} / ${md(s.input.agent)}`}.`);
  if (workflow.loop?.repeat_from) rows.push(`- Next cycle starts from ${md(workflow.loop.repeat_from.step)} / ${md(workflow.loop.repeat_from.agent)} in the previous cycle.`);
  rows.push('', 'Host-verified completion criteria:');
  workflow.criteria.forEach(c => rows.push(`- ${md(c.id)}: ${md(c.requirement)}`));
  rows.push('', 'Stop on exhausted limits, no meaningful progress, or a blocker. Model agreement alone does not close the workflow. Model availability and effective effort are checked before inference; this preview makes no availability or cost estimate claim.', '',
    workflowDiagram(workflow, options.diagram, options.mermaidSupported));
  return rows.join('\n') + '\n';
}

export async function checkWorkflow(workflow, dependencies = {}) {
  const makeResolver = dependencies.makeResolver || (await import('./pi.mjs')).makeResolver;
  const workers = [];
  for (const step of workflow.steps) {
    const resolve = await makeResolver(step.plan.policy);
    for (const agent of step.plan.agents) {
      const { metadata } = await resolve(agent);
      workers.push({ step: step.id, agent: agent.id, ...metadata });
    }
  }
  return { valid: true, workers, note: 'Metadata only; no inference. Catalog presence does not establish account access or future route availability. Run still rechecks each phase.' };
}

function readJson(root, rel) { const raw = readLocal(root, rel); assert(raw !== null, `Missing workflow artifact: ${rel}`); return JSON.parse(raw); }
function open(directory) {
  assert(!fs.lstatSync(directory).isSymbolicLink(), 'Workflow directory must not be a symlink');
  const root = fs.realpathSync(directory), raw = readLocal(root, 'workflow-state.json');
  assert(raw !== null, 'Missing workflow state');
  const state = JSON.parse(raw);
  assert(state.schema_version === 1, 'Unsupported workflow state schema');
  const workflow = validateWorkflow(readJson(root, 'workflow.json'));
  assert(state.workflow_sha256 === sha256(jsonText(workflow)), 'Workflow changed; do not revise an active contract in place');
  assert(!inside(workflow.repo_root, root), 'Workflow state must be outside the source repository');
  assert(Number.isInteger(state.revision) && Number.isInteger(state.iteration) && Number.isInteger(state.step_index) && state.step_index >= 0 && state.step_index < workflow.steps.length, 'Invalid workflow cursor');
  assert(['ready', 'running', 'awaiting_host', ...terminal].includes(state.status) && Array.isArray(state.runs) && Array.isArray(state.decisions), 'Invalid workflow state');
  return { root, state, workflow, raw };
}
function save(ctx) {
  ctx.state.revision++;
  const next = jsonText(ctx.state);
  writeLocal(ctx.root, 'workflow-state.json', next, bytesHash(ctx.raw)); ctx.raw = next;
}
async function locked(directory, fn) {
  const ctx = open(directory), lock = localPath(ctx.root, '.workflow-lock');
  try { fs.mkdirSync(lock, { mode: 0o700 }); }
  catch (e) { if (e.code === 'EEXIST') throw new Error('Workflow is locked. Verify no run is active before manually removing a stale .workflow-lock.'); throw e; }
  try { return await fn(open(directory)); } finally { fs.rmdirSync(lock); }
}
export function initWorkflow(input, directory) {
  const workflow = validateWorkflow(input), target = path.resolve(directory);
  assert(!inside(workflow.repo_root, target), 'Workflow output must be outside the repository');
  assert(!fs.existsSync(target), 'Workflow output already exists');
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  assert(!inside(workflow.repo_root, fs.realpathSync(path.dirname(target))), 'Workflow parent resolves inside the repository');
  fs.mkdirSync(target, { mode: 0o700 });
  const root = fs.realpathSync(target);
  for (const rel of ['runs', 'handoffs']) fs.mkdirSync(path.join(root, rel), { mode: 0o700 });
  writeLocal(root, 'workflow.json', jsonText(workflow), null);
  const state = { schema_version: 1, workflow_sha256: sha256(jsonText(workflow)), revision: 1, status: 'ready', iteration: 1, step_index: 0, started_at: null, runs: [], decisions: [], remaining_work: [], reason: null };
  writeLocal(root, 'workflow-state.json', jsonText(state), null);
  return { out: root, ...state, note: 'No inference. Show the delegation brief before the first run.' };
}

function runPath(ctx, run) { slug(run.id, 'run.id'); return localPath(ctx.root, `runs/${run.id}`); }
function accounting(ctx) {
  const requests = []; let held = 0, missing = 0;
  for (const run of ctx.state.runs) {
    const rel = `runs/${slug(run.id, 'run.id')}/usage.json`;
    const raw = readLocal(ctx.root, rel);
    if (raw === null) { if (run.status !== 'preflight_failed') { held += run.allocation_usd; missing++; } continue; }
    const usage = JSON.parse(raw); assert(Array.isArray(usage.requests), 'Invalid run usage ledger');
    requests.push(...usage.requests);
  }
  const costs = costSummary(requests);
  return { ...costs, all_requests_reconciled: costs.all_requests_reconciled && missing === 0, missing_ledger_run_count: missing, missing_ledger_reserve_usd: held, remaining_budget_usd: Math.max(0, ctx.workflow.limits.budget_usd - costs.provisional_budget_basis_usd - held), label: `Pi delegation cost; excludes ${hostLabel(ctx.workflow.orchestrator)}` };
}
export function workflowStatus(directory, now = Date.now()) {
  const ctx = open(directory), costs = accounting(ctx);
  return { ...ctx.state, next_step: ctx.workflow.steps[ctx.state.step_index].id, costs,
    remaining_seconds: ctx.state.started_at === null ? ctx.workflow.limits.timeout_seconds : Math.max(0, ctx.workflow.limits.timeout_seconds - (now - ctx.state.started_at) / 1000),
    note: 'Host decisions are attestations, not proof of tests. No candidate is integrated by workflow commands.' };
}

function acceptedRun(ctx, ref, iteration) {
  const matches = ctx.state.runs.filter(r => r.step === ref.step && r.iteration === iteration && r.accepted);
  assert(matches.length, 'Candidate producer has no host-accepted run'); return matches.at(-1);
}
function identities(ctx, run) {
  const root = runPath(ctx, run), plan = readJson(root, 'plan.json'), snapshot = readJson(root, 'snapshot.json');
  return Object.fromEntries(plan.agents.map(a => [a.id, readLocal(root, `${a.id}/result.json`) === null ? null : readArtifactIdentity(root, a.id, { plan, snapshot }).artifact_sha256]));
}
function unchangedArtifacts(ctx, run) {
  assert(JSON.stringify(identities(ctx, run)) === JSON.stringify(run.artifacts), 'Run artifacts changed after completion or host review');
}
function handoff(ctx, ref, iteration, nextPlan) {
  const run = acceptedRun(ctx, ref, iteration); unchangedArtifacts(ctx, run);
  const root = runPath(ctx, run), previous = readJson(root, 'plan.json'), snapshot = readJson(root, 'snapshot.json');
  assert(verifySnapshot(previous.repo_root, snapshot.files, previous.policy.max_file_bytes).length === 0, 'Candidate baseline is stale; host must replan');
  const identity = readArtifactIdentity(root, ref.agent, { plan: previous, snapshot });
  const changes = new Map(identity.manifest.map(m => [m.path, m]));
  const selected = [...new Set([...nextPlan.read_files, ...nextPlan.agents.flatMap(a => a.write_files)])];
  const contents = new Map();
  for (const rel of selected) {
    checkRel(rel);
    const changed = changes.get(rel);
    if (changed?.deleted) { contents.set(rel, null); continue; }
    if (changed) {
      const content = readSource(localPath(root, `${ref.agent}/candidate`), rel, nextPlan.policy.max_file_bytes);
      assert(content.hash === changed.sha256, 'Candidate changed during handoff'); contents.set(rel, content); continue;
    }
    // An input cannot quietly acquire context which the producer never saw.
    assert(Object.hasOwn(snapshot.files, rel) || nextPlan.agents.some(a => a.write_files.includes(rel)), `Handoff source was not in the producer snapshot: ${rel}`);
    const original = snapshot.files[rel] ?? null;
    const content = readSource(previous.repo_root, rel, nextPlan.policy.max_file_bytes, true);
    assert((content?.hash ?? null) === (original?.sha256 ?? null), `Handoff baseline changed: ${rel}`);
    contents.set(rel, content);
  }
  const name = `input-${crypto.randomUUID()}`, dest = localPath(ctx.root, `handoffs/${name}`);
  fs.mkdirSync(dest, { mode: 0o700 });
  for (const [rel, value] of contents) if (value !== null) {
    const target = path.join(dest, rel); fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, value.content, { flag: 'wx', mode: 0o600 });
  }
  nextPlan.repo_root = dest;
  // Deleted paths are absent. Previously new writable paths become readable in the next cycle.
  nextPlan.read_files = [...new Set([...nextPlan.read_files, ...nextPlan.agents.flatMap(a => a.write_files)])].filter(f => contents.get(f) !== null);
  for (const a of nextPlan.agents) a.read_files = [...new Set([...a.read_files, ...a.write_files])].filter(f => contents.get(f) !== null);
  return { producer_run: run.id, producer_agent: ref.agent, artifact_sha256: identity.artifact_sha256, root: dest,
    files: Object.fromEntries([...contents].map(([rel, value]) => [rel, value === null ? null : { sha256: value.hash, bytes: value.bytes }])) };
}

/** Execute exactly one phase. The host must explicitly record a decision before another can run. */
export async function runWorkflow(directory, packet = {}, dependencies = {}) {
  object(packet, ['context', 'tasks'], 'packet');
  if (packet.context !== undefined) text(packet.context, 'packet.context');
  if (packet.tasks !== undefined) { assert(packet.tasks && typeof packet.tasks === 'object' && !Array.isArray(packet.tasks), 'packet.tasks must be an object'); Object.values(packet.tasks).forEach(t => text(t, 'packet task')); }
  return locked(directory, async ctx => {
    const { state, workflow } = ctx, now = dependencies.now || Date.now;
    assert(state.status === 'ready', `Workflow is ${state.status}; host review is required before another run`);
    const costs = accounting(ctx), startedAt = state.started_at ?? now(), deadline = startedAt + workflow.limits.timeout_seconds * 1000;
    if (costs.remaining_budget_usd <= 0 || deadline <= now()) {
      state.status = 'limit_reached'; state.reason = costs.remaining_budget_usd <= 0 ? 'workflow_budget' : 'workflow_timeout';
      if (!state.remaining_work.length) state.remaining_work = ['Closing criteria have not been established.']; save(ctx); return workflowStatus(ctx.root, now());
    }
    const step = workflow.steps[state.step_index], plan = structuredClone(step.plan);
    if (packet.tasks) for (const id of Object.keys(packet.tasks)) assert(plan.agents.some(a => a.id === id), `Unknown packet worker: ${id}`);
    if (packet.context !== undefined) plan.context = packet.context;
    for (const a of plan.agents) if (packet.tasks?.[a.id] !== undefined) a.task = packet.tasks[a.id];
    const prior = state.runs.filter(r => r.step === step.id && r.iteration === state.iteration).at(-1);
    if (prior) {
      assert(state.decisions.at(-1)?.action === 'retry', 'A phase cannot be replayed without a host retry decision');
      const old = readJson(runPath(ctx, prior), 'plan.json');
      const changed = Number(old.context !== plan.context) + plan.agents.filter(a => old.agents.find(b => b.id === a.id).task !== a.task).length;
      assert(changed === 1, 'A narrowed retry must change exactly one context or worker task packet');
    }
    const attempt = state.runs.filter(r => r.step === step.id).length + 1;
    for (const w of plan.evaluation.workers) w.attempt_index = attempt;
    let input = null;
    if (state.step_index === 0 && state.iteration > 1 && workflow.loop?.repeat_from) input = handoff(ctx, workflow.loop.repeat_from, state.iteration - 1, plan);
    else if (step.input !== 'baseline') input = handoff(ctx, step.input, state.iteration, plan);
    plan.policy.session_budget_usd = Math.min(plan.policy.session_budget_usd, costs.remaining_budget_usd);
    const validated = validatePlan(plan, defaults), expected = manifestOf(captureSnapshot(validated));
    if (input) for (const [rel, value] of Object.entries(expected)) {
      const original = input.files[rel];
      assert(Object.hasOwn(input.files, rel) && (value?.sha256 ?? null) === (original?.sha256 ?? null) && (value?.bytes ?? null) === (original?.bytes ?? null), `Materialized candidate input changed: ${rel}`);
    }
    const run = { id: `run-${crypto.randomUUID()}`, step: step.id, iteration: state.iteration, attempt_index: attempt, status: 'running', allocation_usd: plan.policy.session_budget_usd, input, accepted: false };
    state.started_at ??= startedAt; state.runs.push(run); state.status = 'running'; save(ctx);
    const out = runPath(ctx, run);
    try {
      const execute = dependencies.executeJob || (await import('./pi.mjs')).executeJob;
      await execute(plan, out, { ...dependencies, deadlineMs: deadline,
        validateSnapshot: (_plan, actual) => assert(JSON.stringify(actual) === JSON.stringify(expected), 'Input snapshot changed before execution') });
      run.status = 'finished'; run.artifacts = identities(ctx, run);
    } catch (e) {
      // Before executeJob writes usage it has not called the provider. Missing ledgers after
      // a hard kill remain reserved instead; the persisted running marker prevents a replay.
      run.status = fs.existsSync(path.join(out, 'usage.json')) ? 'failed' : 'preflight_failed';
      run.error = 'Phase failed; inspect runner artifacts and host error before deciding what to do.';
      state.status = 'awaiting_host'; save(ctx); throw e;
    }
    state.status = 'awaiting_host'; save(ctx);
    return { out, workflow: workflowStatus(ctx.root, now()) };
  });
}

function closingChecks(workflow, checks) {
  assert(Array.isArray(checks) && checks.length === workflow.criteria.length, 'Host must assess every closing criterion');
  const seen = new Set();
  for (const check of checks) {
    object(check, ['id', 'result', 'evidence'], 'check');
    assert(workflow.criteria.some(c => c.id === check.id) && !seen.has(check.id), 'Unknown or duplicate closing criterion'); seen.add(check.id);
    assert(['passed', 'failed', 'unknown', 'not_run'].includes(check.result), 'Invalid closing result'); strings(check.evidence, 'check.evidence');
  }
  return checks.every(c => c.result === 'passed');
}
export async function decideWorkflow(directory, decision, now = Date.now()) {
  object(decision, ['revision', 'run_id', 'assessed_by', 'action', 'evidence', 'checks', 'progress', 'remaining_work', 'reason'], 'decision');
  assert(['advance', 'repeat', 'complete', 'retry', 'stop'].includes(decision.action), 'Invalid workflow decision');
  strings(decision.evidence, 'decision.evidence');
  return locked(directory, async ctx => {
    const { state, workflow } = ctx;
    assert(state.status === 'awaiting_host' || ['ready', 'running'].includes(state.status) && decision.action === 'stop', 'Workflow is not awaiting host review');
    assert(decision.revision === state.revision, 'Stale workflow decision');
    assert(decision.assessed_by === hostLabel(workflow.orchestrator), 'Only the current host may assess a workflow');
    const run = state.runs.at(-1); assert(decision.run_id === (run?.id ?? null), 'Decision must identify the current run (null before any run)');
    let report = null, complete = false;
    if (run?.status === 'finished' && decision.action !== 'stop') {
      unchangedArtifacts(ctx, run); report = readJson(runPath(ctx, run), 'report.json');
      const ids = workflow.steps[state.step_index].plan.agents.map(a => a.id).sort();
      assert(JSON.stringify(report.agents.map(a => a.id).sort()) === JSON.stringify(ids), 'Run report workers differ from the workflow phase');
      complete = report.agents.every(a => {
        const original = readLocal(runPath(ctx, run), `${slug(a.id, 'worker id')}/result.json`);
        if (original === null) return false;
        const result = JSON.parse(original);
        return a.status === 'completed' && result.status === 'completed' && result.submission?.completion === 'complete';
      });
    }
    const last = state.step_index === workflow.steps.length - 1;
    if (decision.action === 'advance') {
      assert(complete && !last, 'Advance requires a complete nonfinal phase; partial or failed work must be reported');
      run.accepted = true; state.step_index++; state.status = 'ready';
    } else if (decision.action === 'complete' || decision.action === 'repeat') {
      assert(complete && last, 'Closing a cycle requires all phases to finish successfully');
      // Revalidate all accepted producers/consumers, including earlier-cycle source provenance.
      for (const r of state.runs.filter(r => r.accepted || r.id === run.id)) {
        unchangedArtifacts(ctx, r);
        const source = readJson(runPath(ctx, r), 'snapshot.json');
        assert(verifySnapshot(source.repo_root, source.files, source.max_file_bytes).length === 0, 'Reviewed snapshot changed; host must replan');
      }
      const passed = closingChecks(workflow, decision.checks);
      if (decision.action === 'complete') {
        assert(passed, 'Goal cannot be achieved with failed, unknown or unrun closing checks');
        assert(!decision.remaining_work?.length, 'Completed workflow cannot have remaining work');
        state.status = 'goal_achieved'; state.remaining_work = []; run.accepted = true;
      } else {
        assert(workflow.loop && !passed, 'Repeat requires a loop with unmet closing criteria');
        assert(typeof decision.progress === 'boolean', 'Repeat needs a host assessment of meaningful progress');
        strings(decision.remaining_work, 'remaining_work'); state.remaining_work = decision.remaining_work;
        const costs = accounting(ctx);
        if (!decision.progress) { state.status = 'stalled'; state.reason = 'no_meaningful_progress'; }
        else if (state.iteration >= workflow.loop.max_iterations || costs.remaining_budget_usd <= 0 || now >= state.started_at + workflow.limits.timeout_seconds * 1000) { state.status = 'limit_reached'; state.reason = 'iteration_budget_or_time_limit'; }
        else { run.accepted = true; state.iteration++; state.step_index = 0; state.status = 'ready'; }
      }
    } else if (decision.action === 'retry') {
      assert(report && !complete && report.agents.some(a => operational.has(a.failure_class)) && report.agents.every(a => a.status === 'completed' || operational.has(a.failure_class)), 'Only an operational failure permits a retry');
      assert(state.runs.filter(r => r.step === run.step && r.iteration === run.iteration).length < 2, 'Only one narrowed retry per phase and cycle');
      text(decision.reason, 'retry reason', 4000); state.status = 'ready';
    } else {
      strings(decision.remaining_work, 'remaining_work');
      assert(['blocked', 'stalled', 'limit_reached'].includes(decision.reason), 'Stop reason must be blocked, stalled or limit_reached');
      state.status = decision.reason; state.reason = decision.reason; state.remaining_work = decision.remaining_work;
    }
    state.decisions.push({ ...decision, recorded_at: new Date(now).toISOString() }); save(ctx);
    return workflowStatus(ctx.root, now);
  });
}

export async function workflowMain(argv) {
  const command = argv[0] || 'help', opts = {};
  const allowed = { init: ['file', 'out'], preview: ['file', 'out', 'diagram', 'mermaid-supported'], check: ['file', 'out'], status: ['out'], run: ['out', 'packet'], decide: ['out', 'decision'], help: [] };
  assert(Object.hasOwn(allowed, command), `Unknown workflow command: ${command}`);
  for (let i = 1; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    assert(argv[i].startsWith('--') && allowed[command].includes(key) && !Object.hasOwn(opts, key), `Unknown or duplicate option: ${argv[i]}`);
    assert(argv[i + 1] && !argv[i + 1].startsWith('--'), `Missing value for ${argv[i]}`); opts[key] = argv[i + 1];
  }
  const jsonFile = file => { assert(file, 'Required JSON file option missing'); return JSON.parse(readLocal(path.dirname(path.resolve(file)), path.basename(file))); };
  if (command === 'help') return 'pi workflow\n  init --file WORKFLOW.json --out NEW_DIRECTORY_OUTSIDE_REPO\n  preview (--file WORKFLOW.json | --out WORKFLOW_DIRECTORY) [--diagram auto|mermaid|ascii] [--mermaid-supported true|false]\n  check (--file WORKFLOW.json | --out WORKFLOW_DIRECTORY)\n  status --out WORKFLOW_DIRECTORY\n  run --out WORKFLOW_DIRECTORY [--packet HOST_PACKET.json]\n  decide --out WORKFLOW_DIRECTORY --decision HOST_DECISION.json\n\nOnly run performs paid inference, exactly one phase. Check queries model metadata; other commands are local. The host reviews and records each transition. No command integrates candidates.';
  if (command === 'init') { assert(opts.out, '--out required'); return initWorkflow(jsonFile(opts.file), opts.out); }
  if (command === 'preview' || command === 'check') {
    assert(Boolean(opts.file) !== Boolean(opts.out), 'Supply either --file or --out');
    assert(opts['mermaid-supported'] === undefined || ['true', 'false'].includes(opts['mermaid-supported']), 'mermaid-supported must be true or false');
    const workflow = opts.file ? validateWorkflow(jsonFile(opts.file)) : open(opts.out).workflow;
    if (command === 'check') return checkWorkflow(workflow);
    return workflowBrief(workflow, { diagram: opts.diagram || 'auto', mermaidSupported: opts['mermaid-supported'] === 'true' });
  }
  assert(opts.out, '--out required');
  if (command === 'status') return workflowStatus(opts.out);
  if (command === 'decide') return decideWorkflow(opts.out, jsonFile(opts.decision));
  const result = await runWorkflow(opts.out, opts.packet ? jsonFile(opts.packet) : {}, { onProgress: event => console.error(JSON.stringify(event)) });
  if (result.out && readJson(result.out, 'report.json').agents.some(a => a.status !== 'completed' || a.submission?.completion !== 'complete')) process.exitCode = 2;
  return result;
}
