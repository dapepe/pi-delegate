/** Project-local, host-reviewed routing memory. No LLM calls, shell, commits, or worker tool access. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { assert, text, cleanRel, sha256, hostLabel, costSummary, isNumber, inside, authorizedIdentities } from './lib.mjs';
import { validateAssessment } from './report.mjs';
import { projectRoot, localPath, readLocal, writeLocal, bytesHash, jsonText, loadJson, ensureState, withLock, plainLines, claudeImportText } from './project-files.mjs';
export const START = '<!-- pi:learned:start -->', END = '<!-- pi:learned:end -->';
const DIR = '.pi/learning', CONFIG = `${DIR}/config.json`, HISTORY = `${DIR}/history.json`, PROPOSAL = `${DIR}/proposal.json`;
const DAY = 86400000;
export const LEARNING_DEFAULTS = Object.freeze({ schema_version: 1, mode: 'propose', min_distinct_tasks: 3, min_useful_fraction: 0.75, max_age_days: 90, max_rules: 6, max_block_bytes: 4096 });
export const STRATEGIES = Object.freeze({
  'single-review': 'one bounded independent review',
  'parallel-independent': 'independent first passes on a common factual baseline',
  'scout-then-candidate': 'a scoped scout followed by a host-prepared candidate task',
  'candidate-then-review': 'a candidate followed by a separate host-scoped read-only review',
  'design-challenge': 'a focused challenge to a proposed design',
  'edge-case-review': 'a targeted edge-case and test review'
});
const ROLES = ['scout', 'candidate', 'correctness-review', 'test-review', 'design-challenger'];
const slug = (value, label) => { text(value, label, 120); assert(/^[a-z0-9][a-z0-9_.-]*$/.test(value), `${label} must be a lowercase non-sensitive identifier`); return value; };
const digest = value => sha256(JSON.stringify(value));
// Only identifier-like rendered data enters AGENTS.md. No free-form worker or reflection text is imported.
const inline = value => String(value ?? 'unknown').replace(/[^A-Za-z0-9_./:~+ -]/g, c => encodeURIComponent(c)).slice(0, 180);
export function validateLearningConfig(config) {
  assert(config && typeof config === 'object', 'Missing learning config; run learn init');
  const keys = new Set([...Object.keys(LEARNING_DEFAULTS), 'project_id']);
  for (const k of Object.keys(config)) assert(keys.has(k), `Unknown learning config: ${k}`);
  assert(config.schema_version === 1 && ['off', 'propose', 'auto'].includes(config.mode), 'Invalid learning schema or mode');
  assert(typeof config.project_id === 'string' && /^[a-f0-9-]{36}$/.test(config.project_id), 'Invalid project learning identity');
  for (const [key, min, max] of [['min_distinct_tasks', 3, 100], ['max_age_days', 1, 365], ['max_rules', 1, 6], ['max_block_bytes', 512, 4096]]) assert(Number.isInteger(config[key]) && config[key] >= min && config[key] <= max, `Invalid ${key}`);
  assert(isNumber(config.min_useful_fraction) && config.min_useful_fraction >= 0.75 && config.min_useful_fraction <= 1, 'min_useful_fraction must be 0.75–1');
  return config;
}
function configOf(root) { return validateLearningConfig(loadJson(root, CONFIG)); }
function historyOf(root, config) {
  const history = loadJson(root, HISTORY, { schema_version: 1, project_id: config.project_id, runs: [] });
  assert(history.schema_version === 1 && history.project_id === config.project_id && Array.isArray(history.runs) && history.runs.length <= 10000, 'Invalid or foreign project history');
  for (const run of history.runs) assert(run && run.current && run.current.project_id === config.project_id && run.key === run.current.key && Array.isArray(run.current.observations), 'Invalid history run');
  return history;
}
export function initLearning(repo, { mode = 'propose', claudeImport = false } = {}) {
  assert(['off', 'propose', 'auto'].includes(mode), 'mode must be off, propose, or auto');
  const root = projectRoot(repo);
  // Preflight project Markdown before creating private state or writing either instruction file.
  const agents = readLocal(root, 'AGENTS.md', 1024 * 1024), claude = claudeImport ? readLocal(root, 'CLAUDE.md', 1024 * 1024) : null;
  if (claudeImport) { plainLines(agents || ''); claudeImportText(claude || ''); }
  ensureState(root);
  return withLock(root, () => {
    let config = loadJson(root, CONFIG);
    if (config) { validateLearningConfig(config); assert(config.mode === mode, 'Already initialized with a different mode; use learn mode --mode VALUE explicitly'); }
    else { config = { ...LEARNING_DEFAULTS, mode, project_id: crypto.randomUUID() }; writeLocal(root, CONFIG, jsonText(config), null); }
    const changed = [];
    if (claudeImport) {
      if (agents === null && writeLocal(root, 'AGENTS.md', '# Project instructions\n', null, 0o644)) changed.push('AGENTS.md');
      if (writeLocal(root, 'CLAUDE.md', claudeImportText(claude || ''), bytesHash(claude), 0o644)) changed.push('CLAUDE.md');
    }
    return { initialized: true, mode: config.mode, instruction_files_changed: changed, warnings: fs.existsSync(path.join(root, 'AGENTS.override.md')) ? ['Root AGENTS.override.md can hide AGENTS.md in Codex. Resolve instruction precedence manually; no override file was changed.'] : [], note: 'Local opt-in only. Raw history is ignored by Git. No model calls or commits.' };
  });
}
export function setLearningMode(repo, mode) {
  assert(['off', 'propose', 'auto'].includes(mode), 'Invalid learning mode');
  const root = projectRoot(repo);
  return withLock(root, () => {
    const before = readLocal(root, CONFIG), config = configOf(root); config.mode = mode;
    writeLocal(root, CONFIG, jsonText(config), bytesHash(before));
    return { mode, note: 'Mode changes do not delete prior AGENTS.md guidance. Remove its marked block manually to retire shared guidance.' };
  });
}
export function validateLearningAssessment(assessment, report) {
  validateAssessment(assessment, report);
  const l = assessment.learning;
  assert(l && typeof l === 'object', 'assessment.learning is required; use the learning assessment template');
  for (const k of Object.keys(l)) assert(['task_id','task_type','scope','complexity','strategy','strategy_version','workers'].includes(k), `Unknown learning field: ${k}`);
  slug(l.task_id, 'task_id'); slug(l.task_type, 'task_type'); slug(l.strategy_version, 'strategy_version');
  assert(l.scope === '.' || (typeof l.scope === 'string' && cleanRel(l.scope)), 'scope must be . or a relative project path');
  assert(['bounded', 'complex'].includes(l.complexity), 'complexity must be bounded or complex');
  assert(Object.hasOwn(STRATEGIES, l.strategy), 'Use a documented strategy; add and test new strategy vocabulary in the skill, not in worker output');
  assert(Array.isArray(l.workers) && l.workers.length === report.agents.length, 'Learning must cover every worker');
  const seen = new Set();
  for (const w of l.workers) {
    for (const k of Object.keys(w)) assert(['agent_id','role','outcome','validation','evidence','failure_kind','regression','rework'].includes(k), `Unknown learning worker field: ${k}`);
    const a = report.agents.find(a => a.id === w.agent_id), score = assessment.workers.find(a => a.agent_id === w.agent_id)?.usefulness_0_to_3;
    assert(a && !seen.has(w.agent_id), 'Unknown or duplicate learning worker'); seen.add(w.agent_id);
    assert(ROLES.includes(w.role), 'Invalid normalized learning role');
    assert(['useful','neutral','harmful','inconclusive'].includes(w.outcome), 'Invalid outcome');
    assert(['passed','failed','not-run'].includes(w.validation), 'Invalid validation');
    assert(['none','model','provider','packet','host','unknown'].includes(w.failure_kind), 'Invalid failure_kind');
    assert(['none-observed','confirmed','not-checked'].includes(w.regression), 'Invalid regression state');
    assert(['none','minor','major','unknown'].includes(w.rework), 'Invalid rework');
    assert(Array.isArray(w.evidence) && w.evidence.length <= 20 && w.evidence.every(e => typeof e === 'string' && e.trim() && e.length <= 2000), 'Evidence must be a bounded, sanitized string array');
    assert(w.validation === 'not-run' || w.evidence.length > 0, 'Validation needs host evidence references');
    if (w.outcome === 'useful') assert(score >= 2 && w.validation === 'passed' && w.failure_kind === 'none' && w.regression === 'none-observed' && a.status === 'completed' && !(a.policy_violations?.length) && !['major','unknown'].includes(w.rework), 'Useful routing evidence needs a completed, independently validated contribution without regression or major/unknown rework');
    if (w.outcome === 'harmful' || w.regression === 'confirmed') assert(w.evidence.length > 0 && w.validation !== 'not-run', 'Negative quality evidence requires independent validation');
    if (w.regression === 'confirmed') assert(w.outcome === 'harmful', 'A confirmed regression must be classified harmful');
  }
  return l;
}
export function buildLearningRun(config, report, assessment, usage, plan, snapshot) {
  const l = validateLearningAssessment(assessment, report), host = report.orchestrator || 'codex';
  hostLabel(host);
  assert(report.mode === 'pi_sdk', 'Synthetic/offline runner output cannot become live project-learning evidence');
  assert(report.finished_at && Number.isFinite(Date.parse(report.finished_at)) && report.created_at && Number.isFinite(Date.parse(report.created_at)), 'Run needs valid start and completion timestamps');
  assert((plan.orchestrator || 'codex') === host, 'Plan/report host mismatch');
  assert(plan.repo_root === report.source_repo && snapshot.repo_root === report.source_repo, 'Run source provenance mismatch');
  assert(Array.isArray(usage.requests), 'Missing usage ledger');
  const key = digest([config.project_id, report.run_id, report.created_at]);
  // Incremental value can depend on companion workers. Do not pool changed ensembles.
  const team = report.agents.map(a => {
    const spec = plan.agents.find(w => w.id === a.id); assert(spec, 'Worker is absent from saved plan');
    const m = a.model || {};
    return { role: l.workers.find(w => w.agent_id === a.id).role,
      provider: m.provider || spec.provider || plan.policy.preferred_provider,
      model_identity: m.catalog_alias_target?.slug || m.canonical_slug || m.resolved_model || spec.model,
      effective_effort: m.effective_pi_effort || 'unknown', mode: a.mode };
  }).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const observations = report.agents.map(a => {
    const evaluation = l.workers.find(w => w.agent_id === a.id), score = assessment.workers.find(w => w.agent_id === a.id);
    const spec = plan.agents.find(w => w.id === a.id); assert(spec, 'Worker is absent from saved plan');
    const requests = usage.requests.filter(r => r.agent_id === a.id), m = a.model || {};
    assert(evaluation.outcome !== 'useful' || (requests.length > 0 && m.resolved_model && m.effective_pi_effort), 'Useful learning needs captured request metadata and resolved model/effort');
    const modelIds = [...new Set(requests.flatMap(r => [r.billed_model, r.response_model]).filter(Boolean))].sort();
    const expected = new Set(authorizedIdentities(m));
    const mismatch = modelIds.some(id => !expected.has(id)) || a.status === 'model_mismatch';
    assert(evaluation.outcome !== 'useful' || !mismatch, 'A model identity mismatch cannot support a useful routing preference');
    const profile = {
      host, host_model: report.orchestrator_model || 'unknown', host_version: report.orchestrator_version || 'unknown',
      task_type: l.task_type, scope: l.scope, complexity: l.complexity, strategy: l.strategy, strategy_version: l.strategy_version, role: evaluation.role,
      provider: m.provider || spec.provider || plan.policy.preferred_provider,
      requested_model: m.requested_model || spec.model, resolved_model: m.resolved_model || spec.model,
      model_identity: m.catalog_alias_target?.slug || m.canonical_slug || m.resolved_model || spec.model,
      observed_models: modelIds, upstream_providers: [...new Set(requests.map(r => r.upstream_provider).filter(Boolean))].sort(),
      requested_effort: m.requested_effort || spec.effort, effective_effort: m.effective_pi_effort || 'unknown', mode: a.mode,
      team, skill_version: report.skill_version || 'legacy', sdk_version: report.sdk_version_target || 'unknown'
    };
    return { profile, profile_id: digest(profile).slice(0, 16), agent_id: a.id, task_id: l.task_id,
      at: report.finished_at, status: a.status, usefulness: score.usefulness_0_to_3,
      outcome: evaluation.outcome, validation: evaluation.validation, failure_kind: evaluation.failure_kind,
      regression: evaluation.regression, rework: evaluation.rework, evidence_sha256: digest(evaluation.evidence),
      evidence_count: evaluation.evidence.length, identity_mismatch: mismatch,
      elapsed_seconds: isNumber(a.elapsed_seconds) ? a.elapsed_seconds : null, costs: costSummary(requests) };
  });
  return { key, project_id: config.project_id, run_id: report.run_id, created_at: report.created_at, task_id: l.task_id,
    assessed_by: assessment.assessed_by, artifact_hashes: { report: digest(report), assessment: digest(assessment), usage: digest(usage), plan: digest(plan), snapshot: digest(snapshot) }, observations };
}
export function recordLearning(repo, out, assessmentPath, { revise = false } = {}) {
  const root = projectRoot(repo), runDir = projectRoot(out);
  assert(!inside(root, runDir), 'Run artifacts must be outside the task repository');
  const report = loadJson(runDir, 'report.json'), usage = loadJson(runDir, 'usage.json'), plan = loadJson(runDir, 'plan.json'), snapshot = loadJson(runDir, 'snapshot.json');
  assert(report && projectRoot(report.source_repo) === root, 'Run belongs to a different project');
  const assessment = assessmentPath ? loadJson(projectRoot(path.dirname(path.resolve(assessmentPath))), path.basename(assessmentPath)) : loadJson(runDir, 'assessment.json');
  return withLock(root, () => {
    const config = configOf(root); assert(config.mode !== 'off', 'Project learning is off');
    const record = buildLearningRun(config, report, assessment, usage, plan, snapshot);
    const before = readLocal(root, HISTORY), history = historyOf(root, config), old = history.runs.find(r => r.key === record.key);
    if (old && digest(old.current) === digest(record)) return { recorded: false, duplicate: true, key: record.key };
    if (old) {
      assert(revise, 'This run was already recorded with different evidence; use --revise after reviewing late costs or regressions');
      assert(old.current.task_id === record.task_id, 'A revision cannot turn an old task into a new independent sample');
      old.revisions.push(old.current); old.current = record;
    } else history.runs.push({ key: record.key, current: record, revisions: [] });
    assert(history.runs.length <= 10000, 'History limit reached; archive it explicitly before recording more');
    writeLocal(root, HISTORY, jsonText(history), bytesHash(before));
    return { recorded: true, revised: Boolean(old), key: record.key, workers: record.observations.length, mode: config.mode, next: 'Review learn summary, then learn propose. Only a host-reviewed learn apply can modify the marked AGENTS.md block.' };
  });
}
export function aggregateLearning(history, config, now = Date.now()) {
  const groups = new Map(); let expired = 0;
  for (const run of history.runs) for (const o of run.current.observations) {
    assert(o.profile_id === digest(o.profile).slice(0, 16), 'Learning profile integrity mismatch');
    const age = now - Date.parse(o.at);
    if (!Number.isFinite(age) || age < -300000 || age > config.max_age_days * DAY) { expired++; continue; }
    let g = groups.get(o.profile_id);
    if (!g) { g = { profile_id: o.profile_id, profile: o.profile, observations: [], tasks: new Map() }; groups.set(o.profile_id, g); }
    g.observations.push(o);
    if (!g.tasks.has(o.task_id)) g.tasks.set(o.task_id, []);
    g.tasks.get(o.task_id).push(o);
  }
  const profiles = [...groups.values()].map(g => {
    const observations = g.observations, tasks = [...g.tasks.values()];
    const harmful = o => (o.outcome === 'harmful' && ['model','none'].includes(o.failure_kind) && o.validation !== 'not-run') || o.regression === 'confirmed' || o.identity_mismatch;
    const useful = o => o.outcome === 'useful' && o.validation === 'passed' && o.usefulness >= 2 && o.status === 'completed' && o.regression === 'none-observed' && o.failure_kind === 'none' && !o.identity_mismatch;
    const usefulTasks = tasks.filter(list => list.some(useful) && !list.some(harmful)).length;
    const harmfulTasks = tasks.filter(list => list.some(harmful)).length;
    const qualityTasks = tasks.filter(list => list.some(o => ['none','model'].includes(o.failure_kind) && o.validation !== 'not-run')).length;
    const fraction = qualityTasks ? usefulTasks / qualityTasks : 0;
    const seconds = observations.map(o => o.elapsed_seconds).filter(isNumber).sort((a,b) => a-b);
    const costs = observations.reduce((c,o) => ({ reported_usd: c.reported_usd + o.costs.provider_reported_usd, estimated_unreconciled_usd: c.estimated_unreconciled_usd + o.costs.estimated_unreconciled_usd, unpriced_requests: c.unpriced_requests + o.costs.unpriced_request_count, unresolved_requests: c.unresolved_requests + o.costs.unresolved_request_count }), {reported_usd:0,estimated_unreconciled_usd:0,unpriced_requests:0,unresolved_requests:0});
    const reasons = [];
    if (usefulTasks < config.min_distinct_tasks) reasons.push('insufficient_distinct_validated_tasks');
    if (fraction < config.min_useful_fraction) reasons.push('insufficient_useful_fraction');
    if (harmfulTasks) reasons.push('contradictory_or_regression_evidence');
    return { profile_id: g.profile_id, profile: g.profile, attempts: observations.length, distinct_tasks: tasks.length, quality_evaluated_tasks: qualityTasks,
      useful_tasks: usefulTasks, harmful_tasks: harmfulTasks, useful_fraction: fraction,
      operational_failures: observations.filter(o => ['provider','packet','host','unknown'].includes(o.failure_kind)).length,
      mean_usefulness: observations.reduce((sum,o) => sum + o.usefulness,0) / observations.length,
      median_seconds: seconds.length ? (seconds[Math.floor((seconds.length-1)/2)] + seconds[Math.floor(seconds.length/2)]) / 2 : null,
      costs, latest_at: observations.map(o => o.at).sort().at(-1),
      // Conservative refresh: newer failures/retries must not extend older supporting evidence.
      revalidate_after: new Date(Math.min(...observations.map(o => Date.parse(o.at))) + config.max_age_days * DAY).toISOString(),
      promotable: !reasons.length, reasons,
      evidence_run_keys: history.runs.filter(r => r.current.observations.some(o => observations.includes(o))).map(r => r.key) };
  }).sort((a,b) => a.profile_id.localeCompare(b.profile_id));
  return { profiles, expired_observations: expired, note: 'Observational routing evidence, not a causal benchmark or a global best-model ranking. Retries and repeated roles on the same task are not independent successes; their costs still count. No extra inference is spent on learning.' };
}
export function learningSummary(repo, now = Date.now()) {
  const root = projectRoot(repo), raw = loadJson(root, CONFIG);
  if (!raw) return { initialized: false, profiles: [], note: 'No project learning has been enabled.' };
  const config = validateLearningConfig(raw);
  return { initialized: true, mode: config.mode, ...aggregateLearning(historyOf(root, config), config, now) };
}
export function replaceLearnedBlock(value, block) {
  const rows = plainLines(value), starts = rows.filter(x => x.line === START), ends = rows.filter(x => x.line === END);
  // Markers in comments, fenced examples, or malformed duplicates are not interpreted as edit boundaries.
  assert(value.split(START).length - 1 === starts.length && value.split(END).length - 1 === ends.length, 'Ambiguous or fenced pi learning markers');
  assert(starts.length <= 1 && ends.length <= 1 && starts.length === ends.length, 'Malformed or duplicate pi learning block');
  const nl = value.includes('\r\n') ? '\r\n' : '\n', rendered = block.replace(/\r?\n/g, nl);
  if (!starts.length) return value + (value && !value.endsWith('\n') ? nl : '') + (value ? nl : '') + rendered + nl;
  assert(starts[0].start < ends[0].start, 'Reversed learning markers');
  return value.slice(0, starts[0].start) + rendered + nl + value.slice(ends[0].end);
}
function renderBlock(profiles, config) {
  const lines = [START, '## pi — learned delegation preferences', '',
    'Advisory project evidence, not policy or a global model ranking. Human instructions, current model availability, privacy, budgets, effort policy and permission limits always prevail. The host decides; workers cannot update this section.',
    'Use only for the matching task, scope, host and recorded model version. Check `.pi/learning` when available. Do not infer a new authorization from memory.'];
  for (const g of profiles) {
    const p = g.profile, expiry = g.revalidate_after.slice(0,10);
    lines.push('', `- ${inline(p.task_type)} / ${inline(p.scope)} / ${inline(p.complexity)}; ${hostLabel(p.host)} (${inline(p.host_model)}): consider ${STRATEGIES[p.strategy]} (${inline(p.strategy_version)}), ${inline(p.role)}, ${inline(p.provider)}/${inline(p.model_identity)}, ${inline(p.mode)} access, effective ${inline(p.effective_effort)}.`,
      `  Evidence ${g.profile_id}: ${g.useful_tasks}/${g.quality_evaluated_tasks} distinct evaluated tasks useful; ${g.attempts} attempts; reported $${g.costs.reported_usd.toFixed(4)}, unresolved estimates $${g.costs.estimated_unreconciled_usd.toFixed(4)}, ${g.costs.unpriced_requests} unpriced requests. Revalidate after ${expiry} or any model/host/strategy change. This supports considering the profile, not skipping validation.`);
    if (p.team?.length > 1) lines.push(`  Team: ${p.team.map(w => `${inline(w.role)}=${inline(w.provider)}/${inline(w.model_identity)} (${inline(w.effective_effort)}, ${inline(w.mode)})`).join('; ')}. Do not assume the same contribution with a different team.`);
  }
  if (!profiles.length) lines.push('', 'No promoted preference currently meets the evidence threshold. Use current authorized defaults; do not invent a model ranking.');
  lines.push(END);
  const value = lines.join('\n'); assert(Buffer.byteLength(value) <= config.max_block_bytes, 'Selected learning summary exceeds its byte limit; select fewer profiles'); return value;
}
function prepareProposal(root, profiles, now) {
  const config = configOf(root); assert(config.mode !== 'off', 'Project learning is off');
  const history = historyOf(root, config), summary = aggregateLearning(history, config, now);
  const eligible = summary.profiles.filter(p => p.promotable);
  let chosen;
  if (profiles) {
    assert(new Set(profiles).size === profiles.length, 'Duplicate profile selection');
    chosen = profiles.map(id => { const p = eligible.find(p => p.profile_id === id); assert(p, `Profile is not eligible for promotion: ${id}`); return p; });
    assert(chosen.length <= config.max_rules, 'Too many profiles');
  } else {
    // A proposal is not a decision. Prefer well-supported profiles, not a globally cheap or high-scoring model.
    chosen = eligible.sort((a,b) => b.useful_tasks - a.useful_tasks || a.profile_id.localeCompare(b.profile_id)).slice(0, config.max_rules);
    while (chosen.length) { try { renderBlock(chosen, config); break; } catch { chosen.pop(); } }
  }
  chosen.sort((a,b) => a.profile_id.localeCompare(b.profile_id));
  const before = readLocal(root, 'AGENTS.md', 1024 * 1024), block = renderBlock(chosen, config);
  const after = replaceLearnedBlock(before || '', block);
  assert(Buffer.byteLength(after) <= 32768, 'AGENTS.md would exceed 32 KiB; reduce project instructions rather than silently raising host limits');
  return { schema_version: 1, project_id: config.project_id, agents_before_sha256: bytesHash(before), agents_after_sha256: sha256(after),
    history_sha256: bytesHash(readLocal(root, HISTORY)), config_sha256: bytesHash(readLocal(root, CONFIG)),
    profile_ids: chosen.map(p => p.profile_id), block, changed: after !== before, after };
}
export function proposeLearning(repo, { profiles = null, now = Date.now() } = {}) {
  const root = projectRoot(repo);
  return withLock(root, () => {
    const proposal = prepareProposal(root, profiles, now), { after: _after, ...publicProposal } = proposal;
    writeLocal(root, PROPOSAL, jsonText(publicProposal), bytesHash(readLocal(root, PROPOSAL)));
    return { ...publicProposal, proposal_file: PROPOSAL, note: 'Review this exact block and selected profiles before learn apply. No AGENTS.md edit occurred.' };
  });
}
export function applyLearning(repo, { reviewedBy, approve = false, now = Date.now() } = {}) {
  hostLabel(reviewedBy); assert(reviewedBy, '--reviewed-by codex|claude-code is required');
  const root = projectRoot(repo);
  return withLock(root, () => {
    const config = configOf(root); assert(config.mode !== 'off', 'Project learning is off');
    assert(config.mode === 'auto' || approve, 'Propose mode requires explicit --approve after user approval; auto mode still requires host review');
    const saved = loadJson(root, PROPOSAL); assert(saved?.project_id === config.project_id, 'No valid proposal for this project');
    const fresh = prepareProposal(root, saved.profile_ids, now), { after, ...expected } = fresh;
    assert(digest(saved) === digest(expected), 'Stale or edited proposal; regenerate and review it again');
    const changed = writeLocal(root, 'AGENTS.md', after, saved.agents_before_sha256, 0o644);
    writeLocal(root, `${DIR}/last-promotion.json`, jsonText({ reviewed_by: hostLabel(reviewedBy), at: new Date(now).toISOString(), profile_ids: saved.profile_ids, before_sha256: saved.agents_before_sha256, after_sha256: saved.agents_after_sha256, changed }), bytesHash(readLocal(root, `${DIR}/last-promotion.json`)));
    return { changed, file: 'AGENTS.md', selected_profiles: saved.profile_ids, reviewed_by: hostLabel(reviewedBy), note: 'Only the marked learning block was updated. No code was integrated or committed. Review the diff.' };
  });
}
function parseArgs(args) {
  const command = args[0] || 'help', o = {};
  const flags = new Set(['claude-import','revise','approve']), values = new Set(['repo','mode','out','assessment','profiles','reviewed-by']);
  for (let i = 1; i < args.length; i++) {
    assert(args[i].startsWith('--'), `Invalid option ${args[i]}`); const k = args[i].slice(2);
    assert(!Object.hasOwn(o,k) && (flags.has(k) || values.has(k)), `Unknown or duplicate option ${args[i]}`);
    if (flags.has(k)) o[k] = true;
    else { assert(args[i+1] && !args[i+1].startsWith('--'), `Missing value for ${args[i]}`); o[k] = args[++i]; }
  }
  const allowed = { help: [], init: ['repo','mode','claude-import'], mode: ['repo','mode'], record: ['repo','out','assessment','revise'], summary: ['repo'], propose: ['repo','profiles'], apply: ['repo','reviewed-by','approve'] };
  assert(Object.hasOwn(allowed,command), `Unknown learn command: ${command}`);
  for (const k of Object.keys(o)) assert(allowed[command].includes(k), `--${k} is not used by learn ${command}`);
  return { command, o };
}
export function learningMain(args) {
  const { command, o } = parseArgs(args);
  if (command === 'help') { console.log('pi learn (local, no inference)\n  init --repo ROOT [--mode propose|auto|off] [--claude-import]\n  mode --repo ROOT --mode propose|auto|off\n  record --repo ROOT --out RUN [--assessment FILE] [--revise]\n  summary --repo ROOT\n  propose --repo ROOT [--profiles ID,ID | --profiles none]\n  apply --repo ROOT --reviewed-by codex|claude-code [--approve]\n\nNo AGENTS.md edits during record/propose. apply needs a fresh, host-reviewed proposal. Propose mode also needs --approve. Auto is local opt-in, not unattended execution.'); return; }
  assert(o.repo, '--repo is required'); let result;
  if (command === 'init') result = initLearning(o.repo, { mode: o.mode || 'propose', claudeImport: Boolean(o['claude-import']) });
  if (command === 'mode') result = setLearningMode(o.repo, o.mode);
  if (command === 'record') { assert(o.out, '--out is required'); result = recordLearning(o.repo, o.out, o.assessment, { revise: Boolean(o.revise) }); }
  if (command === 'summary') result = learningSummary(o.repo);
  if (command === 'propose') result = proposeLearning(o.repo, { profiles: o.profiles === 'none' ? [] : o.profiles ? o.profiles.split(',') : null });
  if (command === 'apply') result = applyLearning(o.repo, { reviewedBy: o['reviewed-by'], approve: Boolean(o.approve) });
  console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { learningMain(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exitCode = 1; }
}
