/**
 * Read-only project statistics and routing advice for Pi.
 *
 * This module intentionally has no dependency on a model SDK.  It accepts the
 * compact inventory written by the learning runner, the legacy learning
 * history, and explicitly supplied run directories.  All three are converted
 * into the same observation shape before any aggregation is performed.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { projectRoot, readLocal, localPath } from './project-files.mjs';
import { readRunInventory as readCoreRunInventory } from './insights-store.mjs';
import { validateAssessment } from './report.mjs';
import { evaluationsMatch, readArtifactIdentity } from './evaluation.mjs';
import { mergePolicy, validatePlan, workerPolicy } from './lib.mjs';

const DAY = 86_400_000;
const MAX_JSON_BYTES = 32 * 1024 * 1024;
const MAX_REASON_CHARS = 4_000;
const MAX_TASKS = 10_000;
const MAX_REASONS = 12;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const ANSI = /\u001b(?:\][^\u0007]*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~]|[PX^_][^\u001b]*(?:\u001b\\))/g;
const PROJECT_HOME = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULTS = JSON.parse(fs.readFileSync(path.join(PROJECT_HOME, 'defaults.json'), 'utf8'));

export const STATS_SCHEMA_VERSION = 1;
export const PERIODS = Object.freeze({ '7d': 7, '30d': 30, '90d': 90, all: null });
export const FOCUS_TAGS = Object.freeze(['correctness', 'completeness', 'security', 'maintainability', 'design', 'planning', 'custom']);
const MODEL_LIMIT_KEYS = Object.freeze(['max_turns', 'max_tool_calls', 'timeout_seconds', 'request_timeout_seconds', 'max_output_tokens', 'per_agent_budget_usd']);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function number(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonNegative(value) {
  const n = number(value);
  return n !== null && n >= 0 ? n : null;
}

function integer(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function firstNumber(...values) {
  for (const value of values) {
    const n = number(value);
    if (n !== null) return n;
  }
  return null;
}

function firstInteger(...values) {
  for (const value of values) {
    const n = integer(value);
    if (n !== null) return n;
  }
  return null;
}

function cleanText(value, max = MAX_REASON_CHARS) {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(ANSI, '').replace(CONTROL, ' ').replace(/[ \t]+/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}

function safeText(value, fallback = 'unknown', max = 240) {
  return cleanText(value, max) || fallback;
}

function dateValue(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value < 10_000_000_000 ? value * 1000 : value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function isoDate(value) {
  const time = dateValue(value);
  return time === null ? null : new Date(time).toISOString();
}

function compareTime(a, b) {
  return (dateValue(a) ?? 0) - (dateValue(b) ?? 0);
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

function pathIdentity(root) {
  const resolved = path.resolve(root);
  return { path: resolved, name: path.basename(resolved) || resolved };
}

function projectIdentity(root, projectId = null, projectName = null) {
  const p = pathIdentity(root);
  return {
    project_id: cleanText(projectId, 160) || null,
    project_name: safeText(projectName, p.name, 160),
    path: p.path
  };
}

function lstatFile(file, label = file) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  assert(!stat.isSymbolicLink(), `Refusing symlink: ${label}`);
  assert(stat.isFile() && stat.nlink === 1 && stat.size <= MAX_JSON_BYTES, `Not a bounded regular file: ${label}`);
  return stat;
}

function readJsonFile(file, optional = true) {
  const parent = path.dirname(file);
  const name = path.basename(file);
  let text;
  try { text = readLocal(projectRoot(parent), name, MAX_JSON_BYTES); }
  catch (error) {
    if (error.code === 'ENOENT' && optional) return null;
    throw error;
  }
  if (text === null) {
    if (optional) return null;
    throw new Error(`Missing file: ${file}`);
  }
  assert(!text.includes('\0'), `Binary file is not readable: ${file}`);
  try { return JSON.parse(text); } catch (error) { throw new Error(`Invalid JSON in ${file}: ${error.message}`); }
}

function readConfig(root) {
  return readJsonFile(path.join(root, '.pi', 'learning', 'config.json'));
}

/**
 * Store contract used by stats.  The learning writer may expose this function
 * from learning.mjs, but the reader also understands the on-disk inventory so
 * stats remains usable while a host is upgrading between versions.
 */
export function readRunInventory(repo) {
  // Reuse the learning store's validation and provenance rules. Stats remains
  // read-only; a malformed store is reported as an evidence issue by the
  // caller, while explicitly supplied raw artifacts can still be inspected.
  return readCoreRunInventory(projectRoot(repo));
}

function readLegacyHistory(root, expectedProjectId = null) {
  const file = path.join(root, '.pi', 'learning', 'history.json');
  const history = readJsonFile(file);
  if (history === null) return null;
  assert(history && history.schema_version === 1 && typeof history.project_id === 'string' && Array.isArray(history.runs), 'Invalid legacy learning history');
  if (expectedProjectId) assert(history.project_id === expectedProjectId, 'Legacy learning history belongs to a different project');
  for (const entry of history.runs) {
    assert(entry && entry.current && entry.current.project_id === history.project_id && entry.key === entry.current.key && Array.isArray(entry.current.observations), 'Invalid legacy learning run');
  }
  return history;
}

function modelField(value, ...keys) {
  if (!value || typeof value !== 'object') return null;
  for (const key of keys) if (value[key] !== undefined && value[key] !== null && value[key] !== '') return value[key];
  return null;
}

function normalizeTags(...sources) {
  const values = [];
  for (const source of sources) {
    if (Array.isArray(source)) values.push(...source);
    else if (typeof source === 'string') values.push(...source.split(/[\s,;/]+/));
    else if (source && typeof source === 'object') values.push(...Object.keys(source).filter(k => source[k]));
  }
  const seen = new Set();
  const tags = [];
  for (const raw of values) {
    const value = cleanText(raw, 80)?.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!value || seen.has(value)) continue;
    seen.add(value);
    tags.push(FOCUS_TAGS.includes(value) ? value : value === 'custom' ? 'custom' : `custom:${value}`);
  }
  return tags.sort().slice(0, 12);
}

function normalizeFocus(task, assignment, observation, agent, planAgent) {
  const explicit = normalizeTags(
    task?.focus_tags, task?.focus, task?.tags,
    assignment?.focus_tags, assignment?.focus, assignment?.tags,
    observation?.focus_tags, observation?.focus, observation?.tags,
    agent?.focus_tags, agent?.focus, planAgent?.focus_tags, planAgent?.focus
  );
  return explicit.length ? explicit : [];
}

function usageFields(usage) {
  const u = usage && typeof usage === 'object' ? usage : {};
  // Providers vary in naming. Reasoning is deliberately retained as a
  // sub-count of output instead of being added to output a second time.
  const input = firstInteger(u.input, u.input_tokens, u.prompt_tokens, u.prompt);
  const output = firstInteger(u.output, u.output_tokens, u.completion_tokens, u.completion);
  const reasoning = firstInteger(u.reasoning, u.reasoning_tokens, u.thinking_tokens);
  const cacheRead = firstInteger(u.cacheRead, u.cache_read, u.cache_read_tokens, u.input_cache_read);
  const cacheWrite = firstInteger(u.cacheWrite, u.cache_write, u.cache_write_tokens, u.input_cache_write);
  const total = firstInteger(u.totalTokens, u.total_tokens, u.total);
  return { input, output, reasoning, cache_read: cacheRead, cache_write: cacheWrite, total };
}

function emptyTokens() {
  return { requests: 0, input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0, total: 0,
    input_known: 0, output_known: 0, reasoning_known: 0, cache_read_known: 0, cache_write_known: 0, total_known: 0 };
}

function addTokens(target, value) {
  for (const key of ['input', 'output', 'reasoning', 'cache_read', 'cache_write', 'total']) {
    if (value[key] !== null) { target[key] += value[key]; target[`${key}_known`]++; }
  }
  target.requests++;
}

function normalizeRequestCosts(requests = [], fallback = null) {
  const rows = Array.isArray(requests) ? requests : [];
  const costs = { request_count: rows.length, known_usd: 0, estimated_usd: 0, unknown_charge_requests: 0,
    reconciled_request_count: 0, estimated_request_count: 0, token_totals: emptyTokens(), byok_upstream_usd: 0, ledger_present: false };
  for (const row of rows) {
    const billed = nonNegative(row?.billed_usd);
    const estimate = nonNegative(row?.estimate_usd);
    if (billed !== null) { costs.known_usd += billed; costs.reconciled_request_count++; }
    else if (estimate !== null) { costs.estimated_usd += estimate; costs.estimated_request_count++; }
    else costs.unknown_charge_requests++;
    const byok = nonNegative(row?.upstream_inference_cost_usd);
    if (byok !== null) costs.byok_upstream_usd += byok;
    addTokens(costs.token_totals, usageFields(row?.usage));
  }
  if (!rows.length && fallback && typeof fallback === 'object') {
    costs.request_count = firstInteger(fallback.request_count, fallback.requests) ?? 0;
    costs.reconciled_request_count = firstInteger(fallback.reconciled_request_count) ?? 0;
    costs.known_usd = nonNegative(fallback.provider_reported_usd) ?? nonNegative(fallback.known_usd) ?? 0;
    costs.estimated_usd = nonNegative(fallback.estimated_unreconciled_usd) ?? nonNegative(fallback.estimated_usd) ?? 0;
    costs.unknown_charge_requests = firstInteger(fallback.unpriced_request_count, fallback.unknown_charge_requests) ?? Math.max(0, costs.request_count - costs.reconciled_request_count);
    costs.byok_upstream_usd = nonNegative(fallback.reported_byok_upstream_usd) ?? 0;
  }
  for (const key of ['known_usd', 'estimated_usd', 'byok_upstream_usd']) costs[key] = Number(costs[key].toFixed(8));
  return costs;
}

function mergeCosts(target, value) {
  for (const key of ['request_count', 'reconciled_request_count', 'estimated_request_count', 'unknown_charge_requests']) target[key] += value[key] || 0;
  for (const key of ['known_usd', 'estimated_usd', 'byok_upstream_usd']) target[key] += value[key] || 0;
  for (const key of ['requests', 'input', 'output', 'reasoning', 'cache_read', 'cache_write', 'total', 'input_known', 'output_known', 'reasoning_known', 'cache_read_known', 'cache_write_known', 'total_known']) target.token_totals[key] += value.token_totals[key] || 0;
}

function emptyCost() {
  return { request_count: 0, reconciled_request_count: 0, estimated_request_count: 0, unknown_charge_requests: 0,
    known_usd: 0, estimated_usd: 0, byok_upstream_usd: 0, token_totals: emptyTokens(), ledger_present: false };
}

function modelInfo(raw = {}, planAgent = {}, report = {}) {
  const model = raw && typeof raw === 'object' ? raw : {};
  const canonical = cleanText(modelField(model, 'canonical_slug', 'model_identity') ?? modelField(planAgent, 'canonical_slug', 'model_identity'), 180);
  const aliasTarget = cleanText(model.catalog_alias_target?.slug ?? model.catalog_alias_target ?? planAgent.catalog_alias_target?.slug ?? planAgent.catalog_alias_target, 180);
  const resolved = cleanText(modelField(model, 'resolved_model', 'model', 'slug', 'requested_model') ?? modelField(planAgent, 'resolved_model', 'model', 'slug'), 180);
  const requested = cleanText(modelField(model, 'requested_model', 'model') ?? modelField(planAgent, 'requested_model', 'model'), 180);
  const provider = cleanText(modelField(model, 'provider') ?? modelField(planAgent, 'provider'), 80);
  const host = cleanText(report.orchestrator ?? model.host ?? model.host_name, 80) || 'unknown';
  const upstream = modelField(model, 'upstream_providers', 'upstream_provider');
  const upstreamProviders = Array.isArray(upstream) ? upstream.map(x => safeText(x)).sort() : upstream ? [safeText(upstream)] : [];
  const effort = cleanText(modelField(model, 'effective_pi_effort', 'effective_effort', 'effort') ?? modelField(planAgent, 'effective_effort', 'effort'), 40);
  const requestedEffort = cleanText(modelField(model, 'requested_effort') ?? modelField(planAgent, 'requested_effort', 'effort'), 40);
  const runtime = modelField(model, 'runtime_limits', 'limits') ?? modelField(planAgent, 'runtime_limits', 'limits');
  const limits = runtime && typeof runtime === 'object' ? Object.fromEntries(MODEL_LIMIT_KEYS.filter(k => number(runtime[k]) !== null).map(k => [k, runtime[k]])) : {};
  const team = modelField(model, 'team') ?? modelField(planAgent, 'team');
  const teamKey = Array.isArray(team) ? team.map(entry => `${safeText(entry?.role)}/${safeText(entry?.provider)}/${safeText(entry?.model_identity ?? entry?.resolved_model)}/${safeText(entry?.effective_effort)}`).sort().join('|') : cleanText(team, 1000) || '';
  const skillVersion = cleanText(modelField(model, 'skill_version') ?? modelField(planAgent, 'skill_version') ?? report.skill_version, 120);
  const sdkVersion = cleanText(modelField(model, 'sdk_version') ?? modelField(planAgent, 'sdk_version') ?? report.sdk_version_target ?? report.sdk_version, 120);
  // Legacy learning profiles omit this marker; v2 profiles carry it. Keep the
  // distinction in the grouping key rather than silently pooling two schemas.
  const profileSchemaVersion = firstInteger(modelField(model, 'profile_schema_version') ?? modelField(planAgent, 'profile_schema_version'));
  return {
    provider: provider || 'unknown', requested_model: requested || 'unknown', resolved_model: resolved || 'unknown', canonical_slug: canonical || null, alias_target: aliasTarget || null,
    model_identity: canonical || aliasTarget || resolved || requested || 'unknown',
    upstream_providers: upstreamProviders, requested_effort: requestedEffort || 'unknown', effective_effort: effort || 'unknown',
    host, host_model: safeText(report.orchestrator_model ?? model.host_model), host_version: safeText(report.orchestrator_version ?? model.host_version),
    mode: cleanText(model.mode ?? planAgent.mode, 40) || 'unknown', runtime_limits: limits, team_key: teamKey,
    profile_schema_version: profileSchemaVersion, skill_version: skillVersion || null, sdk_version: sdkVersion || null
  };
}

function profileKey(model, role) {
  return JSON.stringify({ provider: model.provider, resolved_model: model.resolved_model, canonical_slug: model.canonical_slug, alias_target: model.alias_target, model_identity: model.model_identity, requested_model: model.requested_model,
    upstream_providers: model.upstream_providers, requested_effort: model.requested_effort, effective_effort: model.effective_effort,
    host: model.host, host_model: model.host_model, host_version: model.host_version, mode: model.mode,
    runtime_limits: model.runtime_limits, team_key: model.team_key, profile_schema_version: model.profile_schema_version,
    skill_version: model.skill_version, sdk_version: model.sdk_version, role: role || 'unknown' });
}

function assessmentWorker(assessment, agentId) {
  return (assessment?.workers || []).find(row => row?.agent_id === agentId) || null;
}

function reportEvaluationWorker(report, agentId) {
  return (report?.evaluation?.workers || report?.evaluation?.assignments || []).find(row => row?.agent_id === agentId) || null;
}

function learningWorker(assessment, agentId) {
  return (assessment?.learning?.workers || []).find(row => row?.agent_id === agentId) || null;
}

function rawObservation({ project, report, assessment, assessmentStatus = 'valid', plan, usage, agent, runPath, sourceKind = 'raw' }) {
  const agentId = agent?.id ?? agent?.agent_id ?? 'unknown-agent';
  const planAgent = [...(plan?.workers || []), ...(plan?.agents || [])].find(row => row?.id === agentId || row?.agent_id === agentId) || {};
  const evaluation = plan?.evaluation || report?.evaluation || {};
  const evaluationWorker = [...(plan?.evaluation?.workers || []), ...(report?.evaluation?.workers || [])].find(row => row?.agent_id === agentId) || {};
  const learning = learningWorker(assessment, agentId);
  const judged = assessmentWorker(assessment, agentId) || reportEvaluationWorker(report, agentId);
  const learningTask = assessment?.learning && typeof assessment.learning === 'object' ? assessment.learning : {};
  const task = {
    task_id: learningTask.task_id ?? evaluation.task_id ?? plan?.task_id,
    task_type: learningTask.task_type ?? evaluation.task_type ?? plan?.task_type,
    scope: learningTask.scope ?? evaluation.scope ?? plan?.scope,
    complexity: learningTask.complexity ?? evaluation.complexity ?? plan?.complexity,
    strategy: learningTask.strategy ?? evaluation.strategy ?? plan?.strategy,
    strategy_version: learningTask.strategy_version ?? evaluation.strategy_version ?? plan?.strategy_version,
    focus: learningTask.focus ?? evaluation.focus ?? plan?.focus,
    focus_tags: learningTask.focus_tags ?? evaluation.focus ?? plan?.focus
  };
  const role = cleanText(learning?.role ?? agent?.role ?? planAgent.role, 80) || 'unknown';
  const tags = normalizeFocus(task, learning, agent, planAgent);
  const createdAt = isoDate(report?.created_at ?? report?.started_at ?? report?.finished_at);
  const finishedAt = isoDate(report?.finished_at ?? report?.created_at);
  // An existing usage ledger is authoritative, including an empty per-worker
  // slice for a skipped worker. Fall back to compact report costs only when
  // the ledger itself is absent, otherwise a team-level charge can be counted
  // again for every worker with no request.
  const usageRows = Array.isArray(usage?.requests) ? usage.requests.filter(row => row?.agent_id === agentId) : null;
  const costs = usageRows === null ? normalizeRequestCosts([], agent?.costs ?? report?.costs) : normalizeRequestCosts(usageRows);
  costs.ledger_present = usageRows !== null;
  const upstreamFromLedger = [...new Set((usageRows || []).flatMap(row => Array.isArray(row?.upstream_providers)
    ? row.upstream_providers : row?.upstream_provider ? [row.upstream_provider] : []))].map(value => cleanText(value, 180)).filter(Boolean);
  const rawModel = agent?.model && typeof agent.model === 'object' ? agent.model : {};
  const model = modelInfo({
    ...rawModel,
    runtime_limits: Object.keys(rawModel.runtime_limits || {}).length ? rawModel.runtime_limits : agent?.limits,
    upstream_providers: Array.isArray(rawModel.upstream_providers) && rawModel.upstream_providers.length ? rawModel.upstream_providers : upstreamFromLedger,
    profile_schema_version: rawModel.profile_schema_version ?? (assessmentStatus === 'valid' ? (assessment?.schema_version ?? 1) : null)
  }, planAgent, report);
  const status = cleanText(agent?.status, 50) || 'unknown';
  const outcome = cleanText(learning?.outcome ?? agent?.outcome, 50);
  const taskId = cleanText(task?.task_id ?? agent?.task_id ?? planAgent.task_id, 180) || `run:${safeText(report?.run_id, digest(runPath || createdAt || agentId))}`;
  const taskLabel = cleanText(task?.task_label ?? task?.label ?? planAgent.task ?? report?.objective, 240);
  const sourceRepo = report?.source_repo ? path.resolve(String(report.source_repo)) : project.path;
  const rawReason = cleanText(judged?.reason ?? learning?.reason ?? agent?.reason, MAX_REASON_CHARS);
  const quality = firstInteger(judged?.quality_0_to_3, judged?.quality, judged?.quality_score, learning?.quality_0_to_3, learning?.quality);
  const usefulness = firstInteger(judged?.usefulness_0_to_3, judged?.usefulness, learning?.usefulness_0_to_3, agent?.usefulness_0_to_3);
  const explicitAssignmentId = cleanText(learning?.assignment_id ?? task?.assignment_id ?? evaluationWorker.assignment_id ?? agent?.assignment_id ?? planAgent.assignment_id, 180);
  const assignmentId = explicitAssignmentId || `${taskId}|${role}|${tags.slice().sort().join(',')}`;
  return {
    source_kind: sourceKind, source_path: runPath || null, project: projectIdentity(project.path, project.project_id, project.project_name),
    project_id: project.project_id, project_name: project.project_name, repo_path: sourceRepo,
    profile_id: cleanText(agent?.profile_id ?? agent?.model?.profile_id ?? learning?.profile_id, 180),
    run_id: cleanText(report?.run_id ?? runPath, 180) || 'unknown-run', created_at: createdAt, finished_at: finishedAt,
    at: finishedAt || createdAt, task_id: taskId, assignment_id: assignmentId, assignment_metadata_missing: !explicitAssignmentId, task_label: taskLabel,
    task_type: cleanText(task?.task_type ?? task?.type, 100), scope: cleanText(task?.scope, 300), complexity: cleanText(task?.complexity, 40),
    strategy: cleanText(task?.strategy, 100), strategy_version: cleanText(task?.strategy_version, 80), focus_tags: tags,
    agent_id: safeText(agentId, 'unknown-agent', 160), role, model, status, outcome, attempt_index: firstInteger(learning?.attempt_index, agent?.attempt_index, evaluationWorker.attempt_index, planAgent.attempt_index),
    validation: cleanText(learning?.validation, 50), failure_kind: cleanText(learning?.failure_kind, 50),
    regression: cleanText(learning?.regression, 50), rework: cleanText(learning?.rework, 50),
    quality_0_to_3: quality, usefulness_0_to_3: usefulness, reason: rawReason,
    evidence_count: firstInteger(learning?.evidence_count, learning?.evidence?.length, 0) ?? 0,
    raw_evidence_available: sourceKind === 'raw' && assessmentStatus === 'valid', raw_artifacts_available: sourceKind === 'raw', assessment_status: assessmentStatus, costs,
    stale_checkpoint: ['running', 'in_flight'].includes(status),
    source_repo: sourceRepo
  };
}

function durableObservation({ project, run, observation, sourceKind, sourcePath }) {
  const o = observation || {};
  const report = { orchestrator: o.profile?.host ?? o.host ?? run.orchestrator ?? run.host?.orchestrator, orchestrator_model: o.profile?.host_model ?? run.orchestrator_model ?? run.host?.orchestrator_model, orchestrator_version: o.profile?.host_version ?? run.orchestrator_version ?? run.host?.orchestrator_version,
    skill_version: o.profile?.skill_version ?? o.skill_version ?? run.host?.skill_version ?? run.skill_version,
    sdk_version_target: o.profile?.sdk_version ?? o.sdk_version ?? run.host?.sdk_version_target ?? run.sdk_version_target };
  const profile = o.profile || {};
  const profileId = cleanText(o.profile_id ?? profile.profile_id, 180);
  const evaluationMetadata = o.evaluation_metadata || {};
  const modelValue = o.model && typeof o.model === 'object' ? o.model : {};
  const evaluation = run.evaluation || {};
  const assessmentStatus = run.assessment?.status || 'legacy';
  const assessmentUsable = (sourceKind === 'legacy' && !['invalid', 'stale', 'missing'].includes(assessmentStatus)) || assessmentStatus === 'valid' || assessmentStatus === 'saved';
  const profileSchemaVersion = firstInteger(profile.profile_schema_version, o.profile_schema_version,
    sourceKind === 'legacy' ? 1 : (run.assessment?.schema_version === 1 || run.assessment?.schema_version === 2 ? run.assessment.schema_version : null));
  const task = {
    task_id: o.task_id ?? evaluation.task_id ?? run.task_id,
    task_type: profile.task_type ?? o.task_type ?? evaluation.task_type ?? run.plan?.task_type,
    scope: profile.scope ?? o.scope ?? evaluation.scope ?? run.plan?.scope,
    complexity: profile.complexity ?? o.complexity ?? evaluation.complexity ?? run.plan?.complexity,
    strategy: profile.strategy ?? o.strategy ?? evaluation.strategy ?? run.plan?.strategy,
    strategy_version: profile.strategy_version ?? o.strategy_version ?? evaluation.strategy_version ?? run.plan?.strategy_version,
    focus_tags: o.focus_tags ?? evaluationMetadata.focus ?? profile.focus_tags ?? evaluation.focus ?? run.plan?.focus
  };
  const agent = {
    id: o.agent_id, role: profile.role ?? o.role, status: o.status, model: {
      ...modelValue,
      provider: profile.provider ?? o.provider ?? modelValue.provider, requested_model: profile.requested_model ?? o.requested_model ?? modelValue.requested_model,
      resolved_model: profile.resolved_model ?? o.resolved_model ?? modelValue.resolved_model, canonical_slug: profile.model_identity ?? modelValue.canonical_slug,
      requested_effort: profile.requested_effort ?? o.requested_effort ?? modelValue.requested_effort, effective_pi_effort: profile.effective_effort ?? o.effective_effort ?? modelValue.effective_pi_effort,
      mode: profile.mode ?? o.mode ?? modelValue.mode, runtime_limits: profile.runtime_limits ?? o.runtime_limits ?? modelValue.runtime_limits, team: profile.team ?? o.team ?? modelValue.team,
      upstream_providers: o.upstream_providers ?? modelValue.upstream_providers,
      profile_schema_version: profileSchemaVersion ?? modelValue.profile_schema_version,
      skill_version: profile.skill_version ?? o.skill_version ?? modelValue.skill_version ?? report.skill_version,
      sdk_version: profile.sdk_version ?? o.sdk_version ?? modelValue.sdk_version ?? report.sdk_version_target
    }
  };
  const assessment = { learning: { ...task, workers: [{ agent_id: o.agent_id, role: profile.role ?? o.role, outcome: o.outcome,
    validation: o.validation, failure_kind: o.failure_kind, regression: o.regression, rework: o.rework, evidence_count: o.evidence_count }], },
    workers: [{ agent_id: o.agent_id,
      usefulness_0_to_3: assessmentUsable ? firstInteger(o.usefulness_0_to_3, o.usefulness) : null,
      quality_0_to_3: assessmentUsable ? firstInteger(o.quality_0_to_3, o.quality, evaluationMetadata.quality_0_to_3) : null,
      reason: sourceKind === 'raw' ? o.reason : null }] };
  const result = rawObservation({ project, report: { ...report, run_id: run.run_id, created_at: run.created_at, finished_at: run.finished_at ?? run.at, source_repo: project.path }, assessment,
    assessmentStatus, plan: {}, usage: { requests: [] }, agent, runPath: sourcePath, sourceKind });
  result.created_at = isoDate(run.created_at ?? o.created_at ?? o.at);
  result.finished_at = isoDate(run.finished_at ?? o.finished_at ?? o.at);
  result.at = isoDate(o.at ?? run.finished_at ?? run.created_at);
  result.run_id = cleanText(o.run_id ?? run.run_id ?? run.id, 180) || result.run_id;
  const assignmentId = cleanText(o.assignment_id ?? o.assignment ?? evaluationMetadata.assignment_id, 180);
  result.assignment_id = assignmentId || result.assignment_id;
  result.assignment_metadata_missing = !assignmentId;
  result.attempt_index = firstInteger(o.attempt_index, evaluationMetadata.attempt_index);
  result.profile_id = profileId;
  result.quality_0_to_3 = assessmentUsable ? firstInteger(o.quality_0_to_3, o.quality, evaluationMetadata.quality_0_to_3, result.quality_0_to_3) : null;
  result.usefulness_0_to_3 = assessmentUsable ? firstInteger(o.usefulness_0_to_3, o.usefulness, result.usefulness_0_to_3) : null;
  // Durable state has no free-form assessment reasons. Keep reasons only when
  // this row came from the explicitly supplied raw artifact set.
  result.reason = sourceKind === 'raw' ? cleanText(o.reason, MAX_REASON_CHARS) : null;
  // Durable records intentionally omit prompts, source, and free-form reasons.
  // A numeric evidence count is metadata, not the raw evidence itself.
  result.raw_evidence_available = sourceKind === 'raw';
  result.costs = normalizeRequestCosts([], o.costs);
  result.costs.token_totals = normalizeDurableTokens(o.tokens ?? o.usage ?? o.costs?.tokens);
  result.source_kind = sourceKind;
  result.revision = o.revision ?? null;
  result.lifecycle = cleanText(run.lifecycle, 40);
  return result;
}

function normalizeDurableTokens(raw) {
  const target = emptyTokens();
  const tokens = usageFields(raw);
  const known = raw?.known_requests && typeof raw.known_requests === 'object' ? raw.known_requests : {};
  for (const key of ['input', 'output', 'reasoning', 'cache_read', 'cache_write', 'total']) {
    if (tokens[key] !== null) {
      target[key] = tokens[key];
      target[`${key}_known`] = firstInteger(known[key], known[key.replace('cache_', 'cache')]) ?? 1;
    }
  }
  target.requests = firstInteger(raw?.requests, raw?.request_count,
    ...Object.values(known).map(value => firstInteger(value)).filter(value => value !== null)) ?? 0;
  return target;
}

function legacyObservations(root, project, history) {
  const rows = [];
  for (const entry of history?.runs || []) {
    const current = entry?.current || entry;
    for (const observation of current?.observations || []) rows.push(durableObservation({ project, run: current, observation, sourceKind: 'legacy', sourcePath: path.join(root, '.pi', 'learning', 'history.json') }));
  }
  return rows;
}

function inventoryObservations(project, inventory) {
  const rows = [];
  for (const run of inventory?.runs || []) {
    const observations = run?.observations || run?.assignments || [];
    const sourcePath = path.join(project.path, '.pi', 'learning', 'runs.json');
    const planWorkers = run?.plan?.workers || run?.plan?.agents || [];
    const assessmentWorkers = run?.assessment?.workers || run?.evaluation?.workers || run?.workers_evaluation || [];
    if (observations.length) {
      for (const observation of observations) rows.push(durableObservation({ project, run, observation, sourceKind: 'inventory', sourcePath }));
      continue;
    }
    // Current compact inventory rows keep worker identity, exact model
    // resolution, costs and token summaries beside sanitized evaluation data.
    // Expand that shape into the same observation used by legacy history.
    if (Array.isArray(run?.workers) && run.workers.length) {
      for (let workerIndex = 0; workerIndex < run.workers.length; workerIndex++) {
        const worker = run.workers[workerIndex];
        const planWorker = planWorkers.find(item => item?.agent_id === worker?.agent_id || item?.id === worker?.agent_id) || {};
        const assessed = assessmentWorkers.find(item => item?.agent_id === worker?.agent_id) || {};
        const nestedAssessment = worker?.assessment && typeof worker.assessment === 'object' ? worker.assessment : {};
        const observation = {
          ...worker,
          role: worker.role ?? planWorker.role,
          assignment_id: worker.assignment_id ?? planWorker.assignment_id,
          attempt_index: worker.attempt_index ?? planWorker.attempt_index,
          // The current inventory keeps host grades under worker.assessment;
          // run.assessment is the same grade set when a finalized assessment
          // was saved. Preserve explicit nulls as unknown rather than falling
          // back to an older value.
          quality_0_to_3: Object.hasOwn(nestedAssessment, 'quality_0_to_3') ? nestedAssessment.quality_0_to_3 : (Object.hasOwn(assessed, 'quality_0_to_3') ? assessed.quality_0_to_3 : (worker.quality_0_to_3 ?? assessed.quality)),
          usefulness_0_to_3: Object.hasOwn(nestedAssessment, 'usefulness_0_to_3') ? nestedAssessment.usefulness_0_to_3 : (Object.hasOwn(assessed, 'usefulness_0_to_3') ? assessed.usefulness_0_to_3 : (worker.usefulness_0_to_3 ?? assessed.usefulness_0_to_3 ?? assessed.usefulness)),
          outcome: worker.outcome ?? assessed.outcome,
          validation: worker.validation ?? assessed.validation,
          failure_kind: worker.failure_kind ?? assessed.failure_kind,
          regression: worker.regression ?? assessed.regression,
          rework: worker.rework ?? assessed.rework,
          status: worker.status ?? run.lifecycle,
          // If an old compact record only has one run-level cost summary, give
          // it to one worker so the run is not silently multiplied by team size.
          costs: worker.costs ?? (workerIndex === 0 ? run.costs : null),
          tokens: worker.tokens ?? worker.usage ?? run.usage,
          runtime_limits: worker.limits,
          upstream_providers: worker.upstream_providers,
          model: {
            ...(worker.model || {}),
            provider: worker.model?.provider ?? worker.provider, resolved_model: worker.model?.resolved_model ?? worker.resolved_model,
            requested_model: worker.model?.requested_model ?? worker.requested_model, canonical_slug: worker.model?.canonical_slug ?? worker.canonical_slug,
            requested_effort: worker.model?.requested_effort ?? worker.requested_effort, effective_pi_effort: worker.model?.effective_pi_effort ?? worker.effective_pi_effort,
            runtime_limits: worker.model?.runtime_limits ?? worker.runtime_limits ?? worker.limits, mode: worker.model?.mode ?? worker.mode,
            profile_schema_version: worker.model?.profile_schema_version ?? (run.assessment?.schema_version === 2 ? 2 : run.assessment?.schema_version === 1 ? 1 : null)
          }
        };
        rows.push(durableObservation({ project, run, observation, sourceKind: 'inventory', sourcePath }));
      }
    } else rows.push(durableObservation({ project, run, observation: run, sourceKind: 'inventory', sourcePath }));
  }
  return rows;
}

function immediateRunDirs(out) {
  const root = projectRoot(out);
  if (readLocal(root, 'report.json', MAX_JSON_BYTES) !== null) return [root];
  const direct = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = localPath(root, entry.name);
    if (readLocal(candidate, 'report.json', MAX_JSON_BYTES) !== null) direct.push(candidate);
  }
  return direct.sort();
}

function rawRunDirs(out) {
  if (!out) return [];
  return immediateRunDirs(path.resolve(out));
}

function rawObservations(out, projects, issues = []) {
  const rows = [];
  for (const dir of rawRunDirs(out)) {
    const report = readJsonFile(path.join(dir, 'report.json'), false);
    let sourceRepo = null;
    if (report?.source_repo) {
      try { sourceRepo = projectRoot(path.resolve(String(report.source_repo))); } catch { sourceRepo = null; }
    }
    const project = projects.find(p => sourceRepo && p.path === sourceRepo) || (sourceRepo ? projects.find(p => path.resolve(p.path) === sourceRepo) : null);
    if (!project) continue;
    let assessment = readJsonFile(path.join(dir, 'assessment.json'));
    const plan = readJsonFile(path.join(dir, 'plan.json'));
    const usage = readJsonFile(path.join(dir, 'usage.json'));
    let assessmentStatus = assessment ? 'valid' : 'missing';
    for (const agent of report?.agents || []) delete agent.artifact_identity;
    let evaluationMatches = true;
    try { evaluationMatches = evaluationsMatch(report?.evaluation ?? null, plan?.evaluation ?? null); }
    catch (error) { evaluationMatches = false; issues.push(`Raw run ${safeText(report?.run_id)} evaluation unavailable: ${cleanText(error.message, 500)}`); }
    if (!evaluationMatches) {
      assessmentStatus = 'stale';
      assessment = null;
      issues.push(`Raw run ${safeText(report?.run_id)} assessment is stale: report and plan evaluation metadata differ`);
    }
    if (assessment) {
      // Assessment v2 quality is accepted only when the original saved
      // submission/candidate identity is available. Validation is host-side;
      // malformed or stale grades remain unknown while usage still counts.
      if ((assessment.schema_version ?? 1) === 2) {
        const snapshot = readJsonFile(path.join(dir, 'snapshot.json'));
        for (const agent of report?.agents || []) {
          try {
            // Never trust an identity serialized in report.json. Numeric v2
            // quality must be re-anchored to the bytes still present here.
            // Check the worker directory name before probing it. This keeps a
            // malformed report from turning an explicit raw read into a path
            // traversal attempt, while validation below still reports the
            // assessment as unknown rather than manufacturing a grade.
            if (!/^[a-z][a-z0-9._-]{0,63}$/.test(String(agent.id || ''))) throw new Error('unsafe worker artifact id');
            if (fs.existsSync(path.join(dir, agent.id, 'result.json'))) agent.artifact_identity = readArtifactIdentity(dir, agent.id, { plan, snapshot });
          } catch (error) { issues.push(`Raw run ${safeText(report?.run_id)} worker ${safeText(agent.id)} artifact identity unavailable: ${cleanText(error.message, 500)}`); }
        }
      }
      try { assessment = validateAssessment(assessment, report); }
      catch (error) { issues.push(`Raw run ${safeText(report?.run_id)} assessment unavailable: ${cleanText(error.message, 500)}`); assessmentStatus = 'invalid'; assessment = null; }
    }
    for (let agentIndex = 0; agentIndex < (report?.agents || []).length; agentIndex++) {
      const sourceAgent = report.agents[agentIndex];
      const agent = { ...sourceAgent };
      // Without a usage ledger, a run-level report cost has no worker
      // allocation. Preserve it once for the first worker rather than
      // multiplying the team charge by the number of workers.
      if (!Array.isArray(usage?.requests) && !Object.hasOwn(agent, 'costs') && agentIndex > 0) agent.costs = { request_count: 0 };
      if (!Array.isArray(usage?.requests) && !Object.hasOwn(agent, 'costs') && agentIndex === 0) agent.costs = report?.costs || null;
      rows.push(rawObservation({ project, report, assessment, assessmentStatus, plan, usage, agent, runPath: dir }));
    }
  }
  return rows;
}

function canonicalRunKey(row) {
  return [row.project_id || row.repo_path || row.project_name, row.run_id || 'unknown', row.created_at || row.at || 'unknown'].join('|');
}

function canonicalObservationKey(row) {
  return [canonicalRunKey(row), row.agent_id || row.role || 'unknown'].join('|');
}

function mergeObservationRows(rows) {
  const byKey = new Map();
  const costFallback = (preferred, fallback) => {
    const primary = preferred || emptyCost();
    const secondary = fallback || emptyCost();
    // A raw artifact set is authoritative when it has a request ledger. If
    // it omits usage entirely, retain the compact ledger's measured costs
    // without adding the same run a second time.
    // An explicitly present raw request ledger is authoritative even when it
    // is empty: an empty ledger means no billable worker requests. Only a raw
    // row with no ledger may borrow a compact durable charge.
    if (primary.ledger_present === true) return primary;
    if (secondary.ledger_present === true) return secondary;
    if ((primary.request_count || 0) > 0 || (secondary.request_count || 0) === 0) return primary;
    return secondary;
  };
  for (const row of rows) {
    const key = canonicalObservationKey(row);
    const old = byKey.get(key);
    if (!old) { byKey.set(key, row); continue; }
    // Prefer durable current records over legacy, and raw records over compact
    // records because raw assessments can carry reasons and quality labels.
    const rank = { legacy: 1, inventory: 2, raw: 3 };
    const selected = (rank[row.source_kind] || 0) >= (rank[old.source_kind] || 0) ? row : old;
    const other = selected === row ? old : row;
    if (selected.source_kind !== 'raw') selected.reason ||= other.reason;
    if (!selected.lifecycle && other.lifecycle) selected.lifecycle = other.lifecycle;
    // A newer raw record with an unknown or invalid grade must stay unknown.
    // Never resurrect a stale compact grade or raw-evidence flag merely
    // because the deduped row came from a durable source.
    selected.costs = costFallback(selected.costs, other.costs);
    byKey.set(key, selected);
  }
  return [...byKey.values()].sort((a, b) => compareTime(a.at || a.created_at, b.at || b.created_at) || String(a.run_id).localeCompare(String(b.run_id)) || String(a.agent_id).localeCompare(String(b.agent_id)));
}

function periodBounds(period, now) {
  assert(Object.hasOwn(PERIODS, period), `period must be 7d, 30d, 90d, or all`);
  const end = dateValue(now) ?? Date.now();
  const days = PERIODS[period];
  return { start: days === null ? null : end - days * DAY, end, period };
}

function inPeriod(row, bounds) {
  const at = dateValue(row.at || row.finished_at || row.created_at);
  return at !== null && at <= bounds.end && (bounds.start === null || at >= bounds.start);
}

function taskKey(row) {
  return [row.project_id || row.repo_path || row.project_name, row.task_id || row.run_id, row.assignment_id || row.role].join('|');
}

function latestAssignments(rows, { includeUnknownAssignments = false } = {}) {
  const latest = new Map();
  for (const row of rows) {
    if (!includeUnknownAssignments && row.assignment_metadata_missing) continue;
    const key = taskKey(row);
    const old = latest.get(key);
    if (!old || compareTime(row.at || row.created_at, old.at || old.created_at) >= 0) latest.set(key, row);
  }
  return [...latest.values()];
}

function statusKind(row) {
  const status = String(row.status || '').toLowerCase();
  if (status === 'completed' || status === 'complete') return 'completed';
  if (['turn_limit', 'tool_limit', 'timeout', 'aborted', 'error', 'orchestration_error', 'model_mismatch', 'budget_limit', 'policy_violation', 'request_timeout'].includes(status)) return 'failed';
  if (['running', 'in_flight', 'partial', 'blocked', 'not_started', 'missing_submission', 'cancelled'].includes(status)) return 'incomplete';
  if (row.outcome === 'harmful') return 'failed';
  return 'unknown';
}

function executionKind(row) {
  const status = String(row.status || '').toLowerCase();
  if (status === 'completed' || status === 'complete') return 'completed';
  if (['running', 'in_flight'].includes(status)) return 'stale_checkpoint';
  if (['partial', 'blocked', 'missing_submission'].includes(status)) return 'honest_incomplete';
  if (['not_started', 'cancelled'].includes(status)) return 'not_started';
  if (['turn_limit', 'tool_limit', 'timeout', 'aborted', 'error', 'orchestration_error', 'model_mismatch', 'budget_limit', 'policy_violation', 'request_timeout'].includes(status)) return 'execution_failure';
  return 'unknown';
}

function qualityKind(row) {
  return row.quality_0_to_3 === null || row.quality_0_to_3 === undefined ? null : row.quality_0_to_3;
}

function usefulnessKind(row) {
  return row.usefulness_0_to_3 === null || row.usefulness_0_to_3 === undefined ? null : row.usefulness_0_to_3;
}

function metric(rows, field) {
  const byTask = new Map();
  const allTasks = new Set();
  for (const row of rows) {
    const key = `${row.project_id || row.repo_path}|${row.task_id}`;
    allTasks.add(key);
    const value = field(row);
    if (Number.isInteger(value) && value >= 0 && value <= 3) {
      if (!byTask.has(key)) byTask.set(key, []);
      byTask.get(key).push(value);
    }
  }
  const taskMeans = [...byTask.values()].map(values => values.reduce((sum, value) => sum + value, 0) / values.length);
  return { mean: taskMeans.length ? Number((taskMeans.reduce((sum, value) => sum + value, 0) / taskMeans.length).toFixed(3)) : null,
    assessed: taskMeans.length, assessed_attempts: [...byTask.values()].reduce((sum, values) => sum + values.length, 0), denominator: allTasks.size, values_known: taskMeans.length > 0 };
}

function addReasons(target, row) {
  if (!row.reason || target.length >= MAX_REASONS) return;
  const key = `${row.task_id}|${row.reason}`;
  if (target.some(reason => reason.key === key)) return;
  target.push({ key, task_id: row.task_id, assignment_id: row.assignment_id, at: row.at, text: row.reason, source: row.source_kind });
}

function displayModel(model) {
  const upstream = model.upstream_providers?.length ? ` via ${model.upstream_providers.join(',')}` : '';
  const identity = model.model_identity && model.model_identity !== model.resolved_model ? ` [${model.model_identity}]` : '';
  const host = model.host && model.host !== 'unknown' ? ` · ${model.host}` : '';
  return `${model.provider}/${model.resolved_model}${identity} · ${model.effective_effort}${upstream}${host}`;
}

function aggregateProfiles(rows) {
  const latest = latestAssignments(rows);
  const groups = new Map();
  const ensure = row => {
    const key = profileKey(row.model, row.role);
    let group = groups.get(key);
    if (!group) {
      group = { profile_key: digest(key), model: row.model, role: row.role, profile_ids: new Set(), profile_id_missing_rows: 0, focus_tags: new Set(), all_rows: [], latest_rows: [], distinct_tasks: new Set(), observed_tasks: new Set(), statuses: { completed: 0, failed: 0, incomplete: 0, unknown: 0 }, useful_tasks: new Set(), harmful_tasks: new Set(), reasons: [], costs: emptyCost(), raw_evidence_count: 0, contexts: new Set() };
      groups.set(key, group);
    }
    if (row.profile_id) group.profile_ids.add(row.profile_id);
    else group.profile_id_missing_rows++;
    for (const tag of row.focus_tags || []) group.focus_tags.add(tag);
    group.contexts.add(JSON.stringify({ task_type: row.task_type, scope: row.scope, complexity: row.complexity, strategy: row.strategy, strategy_version: row.strategy_version, focus_tags: row.focus_tags || [], host: row.model.host, effort: row.model.effective_effort, mode: row.model.mode, runtime_limits: row.model.runtime_limits }));
    group.all_rows.push(row); group.observed_tasks.add(`${row.project_id || row.repo_path}|${row.task_id}`); group.statuses[statusKind(row)]++;
    mergeCosts(group.costs, row.costs);
    return group;
  };
  for (const row of rows) ensure(row);
  for (const row of latest) {
    const group = groups.get(profileKey(row.model, row.role));
    group.latest_rows.push(row); group.distinct_tasks.add(`${row.project_id || row.repo_path}|${row.task_id}`);
    if (usefulnessKind(row) !== null && usefulnessKind(row) >= 2) group.useful_tasks.add(`${row.project_id || row.repo_path}|${row.task_id}`);
    if (row.outcome === 'harmful') group.harmful_tasks.add(`${row.project_id || row.repo_path}|${row.task_id}`);
    addReasons(group.reasons, row);
    if (row.raw_evidence_available) group.raw_evidence_count++;
  }
  return [...groups.values()].map(group => {
    const distinct = group.distinct_tasks.size;
    const quality = metric(group.latest_rows, qualityKind);
    const usefulness = metric(group.latest_rows, usefulnessKind);
    const profileIds = [...group.profile_ids].sort();
    const out = { profile_key: group.profile_key, label: displayModel(group.model), model: group.model, role: group.role, profile_ids: profileIds, profile_id_missing_rows: group.profile_id_missing_rows, single_known_profile_id: profileIds.length === 1 && group.profile_id_missing_rows === 0 ? profileIds[0] : null, focus_tags: [...group.focus_tags].sort(), contexts: [...group.contexts].map(value => JSON.parse(value)),
      latest_assignments: group.latest_rows.length, total_attempts: group.all_rows.length, retry_attempts: 0, distinct_tasks: distinct, observed_distinct_tasks: group.observed_tasks.size, statuses: group.statuses,
      quality, usefulness, useful_tasks: group.useful_tasks.size, harmful_tasks: group.harmful_tasks.size,
      assessed_coverage: { quality: quality.assessed, usefulness: usefulness.assessed, total: group.latest_rows.length },
      raw_evidence_available: group.raw_evidence_count > 0, reasons: group.reasons.map(({ key, ...reason }) => reason), costs: group.costs };
    out.retry_attempts = Math.max(0, group.all_rows.filter(row => !row.assignment_metadata_missing).length - group.latest_rows.length);
    return out;
  }).sort((a, b) => b.distinct_tasks - a.distinct_tasks || b.usefulness.assessed - a.usefulness.assessed || a.label.localeCompare(b.label));
}

function aggregateFocus(rows) {
  const groups = new Map();
  for (const row of latestAssignments(rows)) {
    const tags = row.focus_tags?.length ? row.focus_tags : ['unspecified'];
    for (const tag of tags) {
      let group = groups.get(tag);
      if (!group) group = { tag, assignments: 0, distinct_tasks: new Set(), rows: [], reasons: [], raw_evidence_count: 0 };
      group.assignments++; group.rows.push(row); group.distinct_tasks.add(`${row.project_id || row.repo_path}|${row.task_id}`);
      addReasons(group.reasons, row);
      if (row.raw_evidence_available) group.raw_evidence_count++;
      groups.set(tag, group);
    }
  }
  return [...groups.values()].map(group => ({ tag: group.tag, assignments: group.assignments, distinct_tasks: group.distinct_tasks.size,
    quality: metric(group.rows, qualityKind), usefulness: metric(group.rows, usefulnessKind),
    assessed_coverage: { quality: metric(group.rows, qualityKind).assessed, usefulness: metric(group.rows, usefulnessKind).assessed, total: group.assignments },
    raw_evidence_available: group.raw_evidence_count > 0, reasons: group.reasons.map(({ key, ...reason }) => reason) })).sort((a, b) => b.assignments - a.assignments || a.tag.localeCompare(b.tag));
}

function aggregateTasks(rows) {
  const byTask = new Map();
  for (const row of rows) {
    const key = `${row.project_id || row.repo_path}|${row.task_id}`;
    let task = byTask.get(key);
    if (!task) task = { key, project_id: row.project_id, project_name: row.project_name, repo_path: row.repo_path, task_id: row.task_id, task_label: row.task_label,
      task_type: row.task_type, scope: row.scope, focus_tags: new Set(), attempts: [], latest: null };
    for (const tag of row.focus_tags || []) task.focus_tags.add(tag);
    if (!task.task_label && row.task_label) task.task_label = row.task_label;
    task.attempts.push({ run_id: row.run_id, assignment_id: row.assignment_id, attempt_index: row.attempt_index, agent_id: row.agent_id, role: row.role, at: row.at,
      status: row.status, outcome: row.outcome, quality_0_to_3: row.quality_0_to_3, usefulness_0_to_3: row.usefulness_0_to_3,
      model: row.model, reason: row.reason, source_kind: row.source_kind, costs: row.costs, stale_checkpoint: row.stale_checkpoint });
    if (!task.latest || compareTime(row.at || row.created_at, task.latest.at || task.latest.created_at) >= 0) task.latest = row;
    byTask.set(key, task);
  }
  return [...byTask.values()].sort((a, b) => compareTime(b.latest?.at, a.latest?.at) || String(a.task_id).localeCompare(String(b.task_id))).slice(0, MAX_TASKS).map(task => ({ ...task,
    focus_tags: [...task.focus_tags].sort(), attempts: task.attempts.sort((a, b) => compareTime(b.at, a.at)), latest: task.latest ? { run_id: task.latest.run_id, assignment_id: task.latest.assignment_id,
      at: task.latest.at, status: task.latest.status, outcome: task.latest.outcome, quality_0_to_3: task.latest.quality_0_to_3, usefulness_0_to_3: task.latest.usefulness_0_to_3,
      model: task.latest.model, reason: task.latest.reason, stale_checkpoint: task.latest.stale_checkpoint } : null }));
}

function aggregateCosts(rows) {
  const costs = emptyCost();
  for (const row of rows) mergeCosts(costs, row.costs || emptyCost());
  for (const key of ['known_usd', 'estimated_usd', 'byok_upstream_usd']) costs[key] = Number(costs[key].toFixed(8));
  const denominator = costs.request_count || costs.token_totals.requests || 0;
  costs.token_coverage = Object.fromEntries(['input', 'output', 'reasoning', 'cache_read', 'cache_write', 'total'].map(key => [key, {
    known_requests: costs.token_totals[`${key}_known`], request_count: denominator,
    complete: denominator > 0 && costs.token_totals[`${key}_known`] >= denominator
  }]));
  return costs;
}

function countRows(rows) {
  const counts = { rows: rows.length, runs: new Set(), distinct_tasks: new Set(), assignments: rows.length, completed: 0, failed: 0, incomplete: 0, unknown: 0, stale_checkpoints: 0, unassessed: 0, quality_assessed: 0, usefulness_assessed: 0, raw_evidence_rows: 0, assignment_metadata_missing: 0,
    execution: { completed: 0, execution_failures: 0, honest_incomplete: 0, not_started: 0, stale_checkpoints: 0, unknown: 0 }, quality_outcomes: { useful: 0, neutral: 0, harmful: 0, inconclusive: 0, unknown: 0 } };
  for (const row of rows) {
    counts.runs.add(canonicalRunKey(row)); counts.distinct_tasks.add(`${row.project_id || row.repo_path}|${row.task_id}`);
    counts[statusKind(row)]++;
    counts.execution[executionKind(row)]++;
    const outcome = String(row.outcome || '').toLowerCase();
    if (outcome === 'useful') counts.quality_outcomes.useful++;
    else if (outcome === 'harmful') counts.quality_outcomes.harmful++;
    else if (outcome === 'neutral') counts.quality_outcomes.neutral++;
    else if (outcome === 'inconclusive') counts.quality_outcomes.inconclusive++;
    else counts.quality_outcomes.unknown++;
    if (row.stale_checkpoint) counts.stale_checkpoints++;
    if (row.assignment_metadata_missing) counts.assignment_metadata_missing++;
    if (qualityKind(row) === null && usefulnessKind(row) === null) counts.unassessed++;
    if (qualityKind(row) !== null) counts.quality_assessed++;
    if (usefulnessKind(row) !== null) counts.usefulness_assessed++;
    if (row.raw_evidence_available) counts.raw_evidence_rows++;
  }
  return { ...counts, runs: counts.runs.size, distinct_tasks: counts.distinct_tasks.size };
}

function sourceSummary(rows, projects, inventorySources, issues = []) {
  const sourceKinds = Object.fromEntries([...new Set(rows.map(row => row.source_kind))].sort().map(kind => [kind, rows.filter(row => row.source_kind === kind).length]));
  const missingRaw = rows.filter(row => !row.raw_evidence_available).length;
  const invalidAssessments = rows.filter(row => row.assessment_status === 'invalid').length;
  return { kinds: sourceKinds, durable_projects: inventorySources.filter(source => source.inventory).map(source => source.project.project_id || source.project.path),
    legacy_projects: inventorySources.filter(source => source.legacy).map(source => source.project.project_id || source.project.path),
    missing_raw_evidence_rows: missingRaw, invalid_assessment_rows: invalidAssessments, issues: issues.map(issue => safeText(issue, 'unavailable evidence', 500)), projects: projects.map(project => ({ project_id: project.project_id, project_name: project.project_name, path: project.path })) };
}

function buildCombined(rows, projects, period, bounds, inventorySources, generatedAt, issues = []) {
  const allRows = mergeObservationRows(rows);
  const filtered = allRows.filter(row => inPeriod(row, bounds));
  const latest = latestAssignments(filtered);
  const counts = countRows(filtered);
  const latestCounts = countRows(latest);
  const costs = aggregateCosts(filtered); // includes retries and all attempts in the window.
  const quality = metric(latest, qualityKind);
  const usefulness = metric(latest, usefulnessKind);
  const sameProject = (row, project) => project.project_id ? row.project_id === project.project_id : row.repo_path === project.path;
  const learningProjects = projects.map(project => {
    const projectRows = filtered.filter(row => sameProject(row, project));
    const projectLatest = latestAssignments(projectRows);
    const projectCounts = countRows(projectRows);
    const projectLatestCounts = countRows(projectLatest);
    const projectQuality = metric(projectLatest, qualityKind);
    const projectUsefulness = metric(projectLatest, usefulnessKind);
    const latestRun = projectRows.slice().sort((a, b) => compareTime(a.at || a.created_at, b.at || b.created_at)).at(-1) || null;
    const lifecycle = latestRun?.lifecycle || (latestRun ? statusKind(latestRun) : null);
    let status = 'no_runs';
    if (!project.learning_initialized) status = 'uninitialized';
    else if (project.learning_mode === 'off') status = 'off';
    else if (lifecycle === 'running') status = 'stale_checkpoint';
    else if (lifecycle) status = lifecycle;
    let nextAction = 'collect host-reviewed evidence';
    if (status === 'uninitialized') nextAction = 'initialize project learning explicitly';
    else if (status === 'off') nextAction = 'enable project learning before relying on recommendations';
    else if (status === 'stale_checkpoint') nextAction = 'inspect the latest checkpoint; live status is unavailable';
    else if (status === 'failed' || status === 'cancelled') nextAction = 'review the latest run failure before collecting more evidence';
    else if (latestRun?.assessment_status && !['valid', 'saved', 'legacy'].includes(latestRun.assessment_status)) nextAction = 'review or repair the latest assessment evidence';
    else if (status === 'no_runs') nextAction = 'run an opted-in task to collect evidence';
    return { project_id: project.project_id, project_name: project.project_name, label: project.project_name, path: project.path,
      initialized: project.learning_initialized === true, mode: project.learning_mode, status, lifecycle,
      next_action: nextAction, runs: projectCounts.runs, assignments: projectCounts.assignments, latest_assignments: projectLatest.length,
      unassessed: projectLatestCounts.unassessed,
      assessed_coverage: { quality: projectQuality.assessed, usefulness: projectUsefulness.assessed, total: projectLatest.length },
      quality: projectQuality, usefulness: projectUsefulness };
  });
  return {
    schema_version: STATS_SCHEMA_VERSION, generated_at: generatedAt, period: { name: period, start: bounds.start === null ? null : new Date(bounds.start).toISOString(), end: new Date(bounds.end).toISOString() },
    selection: { projects: projects.map(project => ({ project_id: project.project_id, project_name: project.project_name, path: project.path })), explicit: true },
    summary: { ...counts, latest_assignments: latest.length, latest_completed: latestCounts.completed, latest_failed: latestCounts.failed, latest_incomplete: latestCounts.incomplete,
      unassessed: latestCounts.unassessed, assessed_coverage: { quality: latestCounts.quality_assessed, usefulness: latestCounts.usefulness_assessed, total: latest.length }, quality, usefulness },
    costs: { ...costs, note: 'Known provider charges, unreconciled estimates, and unknown requests stay separate. Reasoning is a sub-count of output. The SDK-normalized input field excludes cache read/write; totalTokens is authoritative when present, so token categories are not summed twice.' },
    models: aggregateProfiles(filtered), focus_areas: aggregateFocus(filtered), tasks: aggregateTasks(filtered),
    learning: { observational: true, causal_model_ranking: false, latest_assignment_attempts_only_for_quality: true, retries_in_costs: true, tags_overlap_total: false, projects: learningProjects },
    evidence: sourceSummary(allRows, projects, inventorySources, issues)
  };
}

function readProjects(repos) {
  const roots = repos?.length ? repos : [process.cwd()];
  const seen = new Set();
  return roots.map(repo => projectRoot(path.resolve(repo))).filter(root => { if (seen.has(root)) return false; seen.add(root); return true; }).map(root => {
    const config = readConfig(root);
    return { ...projectIdentity(root, config?.project_id, config?.project_name ?? config?.name),
      learning_mode: cleanText(config?.mode, 20), learning_initialized: Boolean(config) };
  });
}

function collectRows(projects, out) {
  const rows = [];
  const inventorySources = [];
  const issues = [];
  for (const project of projects) {
    let inventory = null;
    try { inventory = readRunInventory(project.path); }
    catch (error) { issues.push(`${project.project_name}: durable inventory unavailable (${cleanText(error.message, 500) || 'invalid data'})`); }
    const source = { project, inventory: Boolean(inventory), legacy: false };
    const inventoryProjectName = inventory?.project_name ?? inventory?.runs?.find(run => run?.project_name)?.project_name;
    if (inventory?.project_id && !project.project_id) project.project_id = cleanText(inventory.project_id, 160);
    if (inventoryProjectName && project.project_name === path.basename(project.path)) project.project_name = safeText(inventoryProjectName, project.project_name, 160);
    if (inventory) rows.push(...inventoryObservations(project, inventory));
    // Keep older history in the union. Dedupe by project/run/created_at below;
    // an inventory appearing later must not hide historical spend.
    let legacy = null;
    try { legacy = readLegacyHistory(project.path, project.project_id); }
    catch (error) { issues.push(`${project.project_name}: legacy history unavailable (${cleanText(error.message, 500) || 'invalid data'})`); }
    source.legacy = Boolean(legacy);
    if (legacy) rows.push(...legacyObservations(project.path, project, legacy));
    inventorySources.push(source);
  }
  rows.push(...rawObservations(out, projects, issues));
  return { rows, inventorySources, issues };
}

function nowIso(now = Date.now()) { return new Date(dateValue(now) ?? Date.now()).toISOString(); }

export function aggregateStats({ repos = [], out = null, period = '30d', now = Date.now() } = {}) {
  const projects = readProjects(repos);
  const bounds = periodBounds(period, now);
  const collected = collectRows(projects, out);
  const combined = buildCombined(collected.rows, projects, period, bounds, collected.inventorySources, nowIso(now), collected.issues);
  combined.project_views = projects.map(project => buildCombined(collected.rows.filter(row => row.project_id === project.project_id || row.repo_path === project.path), [project], period, bounds, collected.inventorySources.filter(source => source.project.path === project.path), combined.generated_at, collected.issues));
  return combined;
}

function markdownCell(value) {
  return safeText(value, 'unknown', 500).replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ');
}

function money(value) { return number(value) === null ? '--' : `$${value.toFixed(6)}`; }
function measuredMoney(value, knownRequests) { return knownRequests > 0 ? money(value) : '--'; }
function measuredToken(tokens, key, denominator) {
  const known = Number.isInteger(tokens?.[`${key}_known`]) ? tokens[`${key}_known`] : 0;
  if (known <= 0) return `-- (0/${denominator} requests known)`;
  return `${tokens[key]} (${known}/${denominator} requests known)`;
}

export function statsMarkdown(stats) {
  const s = stats || {};
  const projects = s.selection?.projects || [];
  const lines = [`# Pi statistics`, '', `Period: **${markdownCell(s.period?.name)}** · projects: **${projects.length}**`, ''];
  if (projects.length) lines.push(`Selection: ${projects.map(project => `${markdownCell(project.project_name)} (${markdownCell(project.path)})`).join('; ')}`, '');
  const summary = s.summary || {}, quality = summary.quality || {}, usefulness = summary.usefulness || {};
  lines.push(`Assignments: **${summary.assignments ?? 0}** (${summary.latest_assignments ?? 0} latest); distinct tasks: **${summary.distinct_tasks ?? 0}**; completed: **${summary.latest_completed ?? 0}**; failed: **${summary.latest_failed ?? 0}**; incomplete: **${summary.latest_incomplete ?? 0}**.`,
    `Quality: ${quality.mean === null ? 'unavailable' : `${quality.mean}/3`} (${quality.assessed ?? 0}/${quality.denominator ?? 0} assessed); usefulness: ${usefulness.mean === null ? 'unavailable' : `${usefulness.mean}/3`} (${usefulness.assessed ?? 0}/${usefulness.denominator ?? 0} assessed).`,
    '', '## Costs', '', `Requests: **${s.costs?.request_count ?? 0}**; provider-reported: **${measuredMoney(s.costs?.known_usd, s.costs?.reconciled_request_count ?? 0)}**; unreconciled estimates: **${measuredMoney(s.costs?.estimated_usd, s.costs?.estimated_request_count ?? 0)}**; unknown charges: **${s.costs?.unknown_charge_requests ?? 0}**.`,
    `Input tokens: ${measuredToken(s.costs?.token_totals, 'input', s.costs?.request_count ?? 0)}; output tokens: ${measuredToken(s.costs?.token_totals, 'output', s.costs?.request_count ?? 0)}; reasoning sub-count: ${measuredToken(s.costs?.token_totals, 'reasoning', s.costs?.request_count ?? 0)}; cache read/write: ${measuredToken(s.costs?.token_totals, 'cache_read', s.costs?.request_count ?? 0)} / ${measuredToken(s.costs?.token_totals, 'cache_write', s.costs?.request_count ?? 0)}; total: ${measuredToken(s.costs?.token_totals, 'total', s.costs?.request_count ?? 0)}.`,
    '', '## Models', '', '| Model / host | Role | Tasks | Quality | Usefulness | Evidence |', '| --- | --- | ---: | ---: | ---: | --- |');
  for (const model of s.models || []) lines.push(`| ${markdownCell(model.label)} | ${markdownCell(model.role)} | ${model.distinct_tasks} | ${model.quality?.mean === null ? 'unavailable' : `${model.quality.mean}/3 (${model.quality.assessed}/${model.quality.denominator})`} | ${model.usefulness?.mean === null ? 'unavailable' : `${model.usefulness.mean}/3 (${model.usefulness.assessed}/${model.usefulness.denominator})`} | ${model.raw_evidence_available ? 'raw available' : 'compact only'} |`);
  lines.push('', '## Focus areas', '', '| Focus | Assignments | Tasks | Quality | Usefulness |', '| --- | ---: | ---: | ---: | ---: |');
  for (const focus of s.focus_areas || []) lines.push(`| ${markdownCell(focus.tag)} | ${focus.assignments} | ${focus.distinct_tasks} | ${focus.quality?.mean === null ? 'unavailable' : `${focus.quality.mean}/3 (${focus.quality.assessed}/${focus.quality.denominator})`} | ${focus.usefulness?.mean === null ? 'unavailable' : `${focus.usefulness.mean}/3 (${focus.usefulness.assessed}/${focus.usefulness.denominator})`} |`);
  if (Array.isArray(s.recommendations)) {
    lines.push('', '## Recommendations', '', 'Dry advisory shortlist constrained to the plan’s current authorized model/provider pool. Evidence is descriptive and does not establish a causal ranking.', '');
    for (const recommendation of s.recommendations) {
      lines.push(`### ${markdownCell(recommendation.role)} (${markdownCell(recommendation.agent_id)})`, '', `Current authorized default: **${markdownCell(recommendation.requested_model)}** at **${markdownCell(recommendation.requested_effort)}**. Candidates considered: **${recommendation.candidates_considered ?? 0}**.`);
      for (const candidate of recommendation.shortlist || []) {
        const score = candidate.quality?.mean === null || candidate.quality?.mean === undefined ? 'unavailable' : `${candidate.quality.mean}/3 (${candidate.quality.assessed}/${candidate.quality.denominator})`;
        lines.push(`- **${markdownCell(candidate.configured_model)}** (${markdownCell(candidate.label)}): ${candidate.distinct_tasks ?? 0} distinct task(s); quality ${score}; ${candidate.context_comparable === false ? 'mixed or mismatched task context; ' : ''}${candidate.caution ? markdownCell(candidate.caution) : 'descriptive evidence only'}.`);
        for (const reason of candidate.reasons || []) lines.push(`  - ${markdownCell(reason)}`);
      }
      lines.push(`Fallback: **${recommendation.fallback?.use_current_authorized_default ? 'use current authorized default' : 'unavailable'}** — ${markdownCell(recommendation.fallback?.reason)}`, '');
    }
    if (s.recommendation_note) lines.push(markdownCell(s.recommendation_note), '');
  }
  lines.push('', '## Evidence limits', '', `Source rows: ${Object.entries(s.evidence?.kinds || {}).map(([key, value]) => `${key} ${value}`).join(', ') || 'none'}. Missing raw evidence rows: ${s.evidence?.missing_raw_evidence_rows ?? 0}.`, 'Observational evidence is descriptive; it does not establish a causal model ranking. Latest assignment attempts drive quality and usefulness, while retries remain in costs.', '');
  return lines.join('\n');
}

function planData(file) {
  const resolved = path.resolve(file);
  const raw = readJsonFile(resolved, false);
  // The CLI receives a saved, host-validated plan. Reuse the same policy and
  // evaluation validation here so recommendations cannot quietly invent a
  // model pool or lose the preregistered task dimensions.
  const plan = validatePlan(raw, DEFAULTS);
  plan.__file = resolved;
  return { file: resolved, plan };
}

function recommendationPolicy(plan) {
  return mergePolicy(DEFAULTS, plan?.policy || {});
}

function effectivePlanLimits(policy, limits) {
  try {
    const normalized = workerPolicy(policy, limits || {});
    return Object.fromEntries(MODEL_LIMIT_KEYS.map(key => [key, normalized[key]]));
  } catch {
    return Object.fromEntries(MODEL_LIMIT_KEYS.filter(key => number(limits?.[key]) !== null).map(key => [key, limits[key]]));
  }
}

function authorizedPlanModels(plan) {
  const policy = recommendationPolicy(plan);
  const evaluation = plan?.evaluation || {};
  const evaluationWorkers = Array.isArray(evaluation.workers) ? evaluation.workers : [];
  const agents = Array.isArray(plan?.agents) && plan.agents.length ? plan.agents : (plan?.workers || []).filter(agent => agent?.model || agent?.requested_model);
  const models = [];
  for (const agent of agents) {
    const agentId = agent?.id ?? agent?.agent_id;
    const evaluated = evaluationWorkers.find(worker => worker?.agent_id === agentId) || {};
    const requested = cleanText(agent?.model ?? agent?.requested_model, 180);
    const provider = cleanText(agent?.provider ?? policy.preferred_provider, 80) || 'unknown';
    const effort = cleanText(agent?.effort ?? policy.default_effort, 40) || 'unknown';
    if (requested) models.push({ requested_model: requested, provider, requested_effort: effort, agent_id: safeText(agentId, 'unknown-agent', 100), role: safeText(agent?.role, 'unknown', 100), task: cleanText(agent?.task, 240),
      task_type: cleanText(agent?.task_type ?? evaluation.task_type, 100), scope: cleanText(agent?.scope ?? evaluation.scope, 300), complexity: cleanText(agent?.complexity ?? evaluation.complexity, 40),
      strategy: cleanText(agent?.strategy ?? evaluation.strategy, 100), strategy_version: cleanText(agent?.strategy_version ?? evaluation.strategy_version, 80),
      focus_tags: normalizeTags(agent?.focus_tags ?? agent?.focus, evaluation.focus), assignment_id: cleanText(evaluated.assignment_id, 180), attempt_index: firstInteger(evaluated.attempt_index),
      mode: cleanText(agent?.mode, 40), runtime_limits: effectivePlanLimits(policy, agent?.limits ?? agent?.runtime_limits), host: cleanText(plan?.orchestrator, 80) || 'unknown' });
  }
  return models;
}

function authorizedModelPool(plan, planModel) {
  const policy = recommendationPolicy(plan);
  // A configured pool belongs to its configured provider. If an agent has an
  // explicitly exceptional provider, carrying OpenRouter names over to it
  // would manufacture an authorization that the saved plan does not contain.
  const configured = [
    ...(planModel.provider === policy.preferred_provider ? policy.preferred_models : []),
    planModel.requested_model
  ].filter(Boolean);
  const seen = new Set();
  return configured.map(model => cleanText(model, 180)).filter(model => model && !seen.has(model) && seen.add(model)).map(requested_model => ({ requested_model,
    provider: requested_model === planModel.requested_model ? planModel.provider : policy.preferred_provider, requested_effort: planModel.requested_effort,
    mode: planModel.mode, runtime_limits: planModel.runtime_limits, host: planModel.host, focus_tags: planModel.focus_tags, task_type: planModel.task_type, scope: planModel.scope,
    complexity: planModel.complexity, strategy: planModel.strategy, strategy_version: planModel.strategy_version }));
}

function compareDimension(actual, requested, label) {
  if (requested === null || requested === undefined || requested === '' || requested === 'unknown') return { label, status: 'unavailable', actual: actual ?? null, requested: requested ?? null };
  if (actual === null || actual === undefined || actual === '' || actual === 'unknown') return { label, status: 'unknown', actual: actual ?? null, requested };
  return { label, status: String(actual) === String(requested) ? 'match' : 'different', actual, requested };
}

function comparableLimits(value) {
  return Object.fromEntries(MODEL_LIMIT_KEYS.filter(key => number(value?.[key]) !== null).map(key => [key, value[key]]));
}

function profileDimensions(profile, candidate) {
  const contexts = profile.contexts || [];
  const contextMatches = context => (!candidate.task_type || context.task_type === candidate.task_type) &&
    (!candidate.scope || context.scope === candidate.scope) &&
    (!candidate.complexity || context.complexity === candidate.complexity) &&
    (!candidate.strategy || context.strategy === candidate.strategy) &&
    (!candidate.strategy_version || context.strategy_version === candidate.strategy_version) &&
    (!candidate.focus_tags?.length || candidate.focus_tags.every(tag => (context.focus_tags || []).includes(tag)));
  const context = contexts.find(contextMatches) || contexts[0] || {};
  const comparable = contexts.length > 0 && contexts.every(contextMatches);
  const dimensions = [
    compareDimension(profile.model.requested_model, candidate.requested_model, 'requested model'),
    compareDimension(profile.model.provider, candidate.provider, 'provider'),
    compareDimension(profile.model.effective_effort, candidate.requested_effort, 'effective effort'),
    compareDimension(profile.model.host, candidate.host, 'host'),
    compareDimension(profile.model.mode, candidate.mode, 'access mode'),
    compareDimension(context.task_type, candidate.task_type, 'task type'),
    compareDimension(context.scope, candidate.scope, 'scope'),
    compareDimension(context.complexity, candidate.complexity, 'complexity'),
    compareDimension(context.strategy, candidate.strategy, 'strategy'),
    compareDimension(context.strategy_version, candidate.strategy_version, 'strategy version'),
    compareDimension(JSON.stringify(comparableLimits(profile.model.runtime_limits)), JSON.stringify(comparableLimits(candidate.runtime_limits)), 'runtime limits'),
    compareDimension((profile.focus_tags || []).join(','), (candidate.focus_tags || []).join(','), 'focus tags')
  ];
  if (contexts.length > 1 && !comparable) dimensions.push({ label: 'recorded context', status: 'mixed', actual: `${contexts.length} contexts`, requested: 'one matching context' });
  else if (!contexts.length) dimensions.push({ label: 'recorded context', status: 'unknown', actual: null, requested: 'one matching context' });
  return dimensions;
}

function recommendationReason(profile, candidate, dimensions) {
  const reasons = [];
  if (profile.distinct_tasks >= 2) reasons.push(`${profile.distinct_tasks} distinct task(s) in the selected window`);
  else reasons.push('only one distinct task in the selected window');
  if (profile.usefulness?.assessed) reasons.push(`usefulness ${profile.usefulness.mean}/3 across ${profile.usefulness.assessed}/${profile.usefulness.denominator} latest assignment(s)`);
  else reasons.push('usefulness is unavailable');
  if (profile.quality?.assessed) reasons.push(`quality ${profile.quality.mean}/3 across ${profile.quality.assessed}/${profile.quality.denominator} latest assignment(s)`);
  else reasons.push('quality is unavailable');
  if (!profile.raw_evidence_available) reasons.push('raw reasons and assessments are unavailable');
  for (const dimension of dimensions.filter(value => ['different', 'unknown', 'mixed'].includes(value.status))) reasons.push(`${dimension.label} ${dimension.status}: observed ${dimension.actual ?? '--'}, plan ${dimension.requested ?? '--'}`);
  return reasons;
}

export function recommendFromStats(stats, plan) {
  const planModels = authorizedPlanModels(plan);
  const recommendations = [];
  let descriptiveDimensionMatches = 0;
  for (const planModel of planModels) {
    const pool = authorizedModelPool(plan, planModel);
    const shortlist = [];
    for (const candidate of pool) {
      const matches = (stats.models || []).filter(profile => (profile.model.requested_model === candidate.requested_model || profile.model.resolved_model === candidate.requested_model || profile.model.model_identity === candidate.requested_model) && profile.model.provider === candidate.provider);
      for (const profile of matches.slice(0, 2)) {
        const dimensions = profileDimensions(profile, candidate);
        if (dimensions.length > 0 && dimensions.every(dimension => dimension.status === 'match')) descriptiveDimensionMatches++;
        const contextCaution = dimensions.some(dimension => ['mixed', 'different', 'unknown'].includes(dimension.status) && ['task type', 'scope', 'complexity', 'strategy', 'strategy version', 'focus tags', 'recorded context'].includes(dimension.label));
        shortlist.push({ profile_key: profile.profile_key, label: profile.label, configured_model: candidate.requested_model, distinct_tasks: profile.distinct_tasks,
          quality: profile.quality, usefulness: profile.usefulness, dimensions, context_comparable: !contextCaution,
          reasons: recommendationReason(profile, candidate, dimensions), caution: contextCaution || profile.distinct_tasks < 3 || !profile.usefulness?.assessed || !profile.quality?.assessed || profile.harmful_tasks ? 'insufficient, mixed-context, or contradictory evidence; current authorized defaults remain the fallback' : null });
      }
      if (!matches.length) shortlist.push({ profile_key: null, label: `${candidate.provider}/${candidate.requested_model} · no matching evidence`, configured_model: candidate.requested_model,
        distinct_tasks: 0, quality: { mean: null, assessed: 0, denominator: 0 }, usefulness: { mean: null, assessed: 0, denominator: 0 }, dimensions: [], reasons: ['no matching evidence for this authorized configured model'], caution: 'insufficient evidence; current authorized defaults remain the fallback' });
    }
    recommendations.push({ agent_id: planModel.agent_id, role: planModel.role, requested_model: planModel.requested_model, requested_effort: planModel.requested_effort,
      authorized_candidates: pool.map(candidate => ({ model: candidate.requested_model, provider: candidate.provider, effort: candidate.requested_effort })), candidates_considered: shortlist.length, shortlist, fallback: { use_current_authorized_default: true, reason: 'Evidence is advisory and must match the current policy and configuration.' } });
  }
  return { schema_version: STATS_SCHEMA_VERSION, kind: 'recommendation', generated_at: stats.generated_at, period: stats.period, selection: stats.selection,
    plan: { file: plan?.__file || null, authorized_models: planModels }, recommendations,
    evidence: { stats_source: stats.evidence, exact_configuration_view: false, descriptive_dimension_matches: descriptiveDimensionMatches > 0, descriptive_dimension_match_count: descriptiveDimensionMatches, descriptive_model_focus_view: true, causal_model_ranking: false,
      no_new_permissions_effort_budget_or_model_exceptions: true },
    note: 'Dry advisory only. Suggestions do not change the plan, policy, permissions, budget, effort, model allowlist, or host review requirements.' };
}

function parseArgs(args) {
  const argv = [...args];
  let command = argv.shift() || 'stats';
  if (!['stats', 'recommend'].includes(command)) { argv.unshift(command); command = 'stats'; }
  const options = { repo: [], period: command === 'recommend' ? '90d' : '30d', format: 'json', tui: false };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    assert(token.startsWith('--'), `Invalid option: ${token}`);
    const name = token.slice(2);
    if (name === 'tui') { assert(!options.tui, 'Duplicate --tui'); options.tui = true; continue; }
    assert(['repo', 'out', 'period', 'format', 'plan'].includes(name), `Unknown option: ${token}`);
    assert(i + 1 < argv.length && !argv[i + 1].startsWith('--'), `Missing value for --${name}`);
    const value = argv[++i];
    if (name === 'repo') options.repo.push(value);
    else { assert(!seen.has(name), `Duplicate --${name}`); seen.add(name); options[name] = value; }
  }
  assert(Object.hasOwn(PERIODS, options.period), '--period must be 7d, 30d, 90d, or all');
  assert(['json', 'markdown'].includes(options.format), '--format must be json or markdown');
  if (options.tui) assert(command === 'stats', '--tui is only valid for stats');
  if (command === 'recommend') assert(options.plan, 'recommend requires --plan FILE');
  return { command, options };
}

/**
 * CLI entry point. The host CLI can call this with process.argv.slice(2), or
 * with the command omitted for a direct stats invocation.
 */
export function statsMain(args = [], io = {}) {
  const { command, options } = parseArgs(args);
  const stats = aggregateStats({ repos: options.repo, out: options.out, period: options.period });
  if (command === 'recommend') {
    const loaded = planData(options.plan);
    const result = recommendFromStats(stats, loaded.plan);
    if (options.format === 'markdown') return statsMarkdown({ ...stats, recommendations: result.recommendations, recommendation_evidence: result.evidence, recommendation_note: result.note });
    return result;
  }
  if (options.tui) {
    // Dynamic import keeps the stats reader usable in non-TTY environments and
    // avoids a module cycle between the renderer and the aggregator.
    const reload = async () => aggregateStats({ repos: options.repo, out: options.out, period: options.period });
    return import('./tui.mjs').then(({ runTui }) => runTui(stats, { ...io, reload: io.reload || reload }));
  }
  return options.format === 'markdown' ? statsMarkdown(stats) : stats;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = statsMain(process.argv.slice(2));
    if (result && typeof result.then === 'function') result.then(value => { if (value !== undefined) console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2)); }).catch(error => { console.error(error.message); process.exitCode = 1; });
    else if (result !== undefined) console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
