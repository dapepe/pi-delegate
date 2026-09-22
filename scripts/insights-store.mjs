/**
 * Project-local, sanitized run inventory.
 *
 * This is intentionally separate from the raw run directory and learning
 * history.  It is a compact status/statistics index for an opted-in project;
 * it never stores prompts, source text, assessment reasons, or an absolute
 * path to a run directory.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { projectRoot, readLocal, writeLocal, jsonText, withLock, bytesHash } from './project-files.mjs';
import { assert, isNumber, costSummary } from './lib.mjs';

export const INVENTORY_SCHEMA_VERSION = 1;
export const INVENTORY_FILE = '.pi/learning/runs.json';
const CONFIG_FILE = '.pi/learning/config.json';
const MAX_RUNS = 10000;
const MAX_WORKERS = 256;
const MAX_TEXT = 160;
const LIFECYCLES = new Set(['planned', 'running', 'completed', 'failed', 'cancelled', 'finalized']);
const ASSESSMENT_STATUSES = new Set(['missing', 'saved', 'valid', 'invalid', 'stale']);

function fail(message) { throw new Error(message); }
function assertObject(value, label) { assert(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`); }
function safeText(value, label, max = MAX_TEXT) {
  if (value === null || value === undefined) return null;
  assert(typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f]/.test(value), `${label} must be bounded text`);
  return value;
}
function iso(value, label) {
  if (value === null || value === undefined) return null;
  assert(typeof value === 'string' && Number.isFinite(Date.parse(value)), `${label} must be an ISO timestamp`);
  return value;
}
function stableJson(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(stableJson);
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableJson(value[key])]));
}
function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(stableJson(value))).digest('hex'); }
function projectIdOf(config) {
  assert(config?.schema_version === 1 && typeof config.project_id === 'string' && /^[a-f0-9-]{36}$/.test(config.project_id), 'Invalid project learning config');
  assert(['off', 'propose', 'auto'].includes(config.mode), 'Invalid project learning mode');
  return config.project_id;
}
function readConfig(root) {
  const raw = readLocal(root, CONFIG_FILE);
  if (raw === null) return null;
  let config; try { config = JSON.parse(raw); } catch { fail('Invalid project learning config JSON'); }
  projectIdOf(config);
  return config;
}
function boundedNumber(value) { return isNumber(value) ? value : null; }
function sumToken(records, names) {
  const values = records.map(item => names.map(name => item?.usage?.[name]).find(value => isNumber(value))).filter(isNumber);
  return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
}
function tokensFor(records) {
  const input = sumToken(records, ['input', 'inputTokens', 'prompt_tokens', 'promptTokens']);
  const output = sumToken(records, ['output', 'outputTokens', 'completion_tokens', 'completionTokens']);
  const reasoning = sumToken(records, ['reasoning', 'reasoningTokens', 'reasoning_tokens']);
  const cacheRead = sumToken(records, ['cacheRead', 'cache_read', 'input_cache_read', 'cacheReadTokens']);
  const cacheWrite = sumToken(records, ['cacheWrite', 'cache_write', 'input_cache_write', 'cacheWriteTokens']);
  // Pi SDK input excludes cache dimensions. Derive total only when all four
  // dimensions are known for every request; never turn an unknown dimension
  // into zero or trust a provider total with different semantics.
  const complete = records.every(item => {
    const usage = item?.usage || {};
    return ['input', 'output', 'cacheRead', 'cacheWrite'].every(name => {
      const aliases = { input: ['input', 'inputTokens', 'prompt_tokens', 'promptTokens'], output: ['output', 'outputTokens', 'completion_tokens', 'completionTokens'], cacheRead: ['cacheRead', 'cache_read', 'input_cache_read', 'cacheReadTokens'], cacheWrite: ['cacheWrite', 'cache_write', 'input_cache_write', 'cacheWriteTokens'] }[name];
      return aliases.some(alias => isNumber(usage[alias]));
    });
  });
  const total = records.length && complete && input !== null && output !== null && cacheRead !== null && cacheWrite !== null
    ? input + output + cacheRead + cacheWrite : null;
  return {
    input, output, reasoning, cache_read: cacheRead, cache_write: cacheWrite, total,
    known_requests: {
      input: records.filter(item => item?.usage && ['input', 'inputTokens', 'prompt_tokens', 'promptTokens'].some(key => isNumber(item.usage[key]))).length,
      output: records.filter(item => item?.usage && ['output', 'outputTokens', 'completion_tokens', 'completionTokens'].some(key => isNumber(item.usage[key]))).length,
      reasoning: records.filter(item => item?.usage && ['reasoning', 'reasoningTokens', 'reasoning_tokens'].some(key => isNumber(item.usage[key]))).length,
      cache_read: records.filter(item => item?.usage && ['cacheRead', 'cache_read', 'input_cache_read', 'cacheReadTokens'].some(key => isNumber(item.usage[key]))).length,
      cache_write: records.filter(item => item?.usage && ['cacheWrite', 'cache_write', 'input_cache_write', 'cacheWriteTokens'].some(key => isNumber(item.usage[key]))).length,
      total: records.filter(item => {
        const usage = item?.usage || {};
        return [
          ['input', 'inputTokens', 'prompt_tokens', 'promptTokens'],
          ['output', 'outputTokens', 'completion_tokens', 'completionTokens'],
          ['cacheRead', 'cache_read', 'input_cache_read', 'cacheReadTokens'],
          ['cacheWrite', 'cache_write', 'input_cache_write', 'cacheWriteTokens']
        ].every(keys => keys.some(key => isNumber(usage[key])));
      }).length
    }
  };
}
function modelCompact(model) {
  if (!model || typeof model !== 'object') return null;
  const fields = ['provider', 'requested_model', 'resolved_model', 'canonical_slug', 'requested_effort', 'effective_pi_effort', 'capability_source', 'checked_at'];
  const compact = Object.fromEntries(fields.filter(key => model[key] !== undefined && model[key] !== null).map(key => [key, safeText(String(model[key]), `model.${key}`, 512)]));
  if (model.catalog_alias_target && typeof model.catalog_alias_target === 'object') compact.catalog_alias_target = Object.fromEntries(['slug', 'canonical_slug'].filter(key => model.catalog_alias_target[key]).map(key => [key, safeText(String(model.catalog_alias_target[key]), `model.catalog_alias_target.${key}`, 512)]));
  return compact;
}
function workerCompact(agent, usageRequests, assessmentWorker = null) {
  const requests = usageRequests.filter(request => request.agent_id === agent.id);
  const costs = costSummary(requests);
  return {
    agent_id: safeText(agent.id, 'worker.agent_id', 96), role: safeText(agent.role || 'sparring-partner', 'worker.role', 240),
    mode: safeText(agent.mode, 'worker.mode', 32), status: safeText(agent.status, 'worker.status', 64),
    elapsed_seconds: boundedNumber(agent.elapsed_seconds), failure_class: safeText(agent.failure_class, 'worker.failure_class', 96),
    suggested_learning_failure_kind: safeText(agent.suggested_learning_failure_kind, 'worker.suggested_learning_failure_kind', 96),
    limits: agent.limits && typeof agent.limits === 'object' ? Object.fromEntries(Object.entries(agent.limits).filter(([key, value]) => ['max_turns', 'max_tool_calls', 'timeout_seconds', 'request_timeout_seconds', 'max_output_tokens', 'per_agent_budget_usd'].includes(key) && isNumber(value))) : null,
    limit_usage: agent.limit_usage && typeof agent.limit_usage === 'object' ? Object.fromEntries(Object.entries(agent.limit_usage).filter(([key, value]) => ['requests', 'tool_calls', 'elapsed_seconds', 'completion_repairs'].includes(key) && isNumber(value))) : null,
    model: modelCompact(agent.model), request_count: requests.length, tokens: tokensFor(requests),
    upstream_providers: [...new Set(requests.map(request => request.upstream_provider).filter(value => typeof value === 'string' && value.length <= 256))].sort(),
    assessment: assessmentWorker ? {
      usefulness_0_to_3: assessmentWorker.usefulness_0_to_3 ?? null,
      quality_0_to_3: assessmentWorker.quality_0_to_3 ?? null,
      integration_status: assessmentWorker.integration_status ?? null,
      criterion_results: Array.isArray(assessmentWorker.criterion_results) ? assessmentWorker.criterion_results.map(item => ({ id: item.id, result: item.result, evidence_count: Array.isArray(item.evidence) ? item.evidence.length : 0 })) : null
    } : null,
    costs: {
      request_count: costs.request_count, reconciled_request_count: costs.reconciled_request_count,
      provider_reported_usd: costs.provider_reported_usd, unresolved_request_count: costs.unresolved_request_count,
      estimated_unreconciled_usd: costs.estimated_unreconciled_usd, unpriced_request_count: costs.unpriced_request_count,
      reported_byok_upstream_usd: costs.reported_byok_upstream_usd, all_requests_reconciled: costs.all_requests_reconciled
    }
  };
}
function planCompact(plan) {
  const evaluation = plan?.evaluation;
  const evaluatedWorkers = Array.isArray(evaluation?.workers) ? evaluation.workers.map(worker => ({
    agent_id: worker.agent_id, assignment_id: worker.assignment_id, attempt_index: worker.attempt_index,
    criteria: worker.criteria.map(criterion => ({ id: criterion.id }))
  })) : [];
  const workers = evaluatedWorkers.length ? evaluatedWorkers : (plan?.agents || []).map(agent => ({ agent_id: agent.id, assignment_id: null, attempt_index: null, criteria: [] }));
  return {
    task_type: evaluation?.task_type ?? null, scope: evaluation?.scope ?? null,
    complexity: evaluation?.complexity ?? null, strategy: evaluation?.strategy ?? null,
    strategy_version: evaluation?.strategy_version ?? null, focus: Array.isArray(evaluation?.focus) ? [...evaluation.focus] : [],
    workers
  };
}
function evaluationCompact(evaluation) {
  if (!evaluation) return null;
  return {
    schema_version: evaluation.schema_version, task_id: evaluation.task_id, task_type: evaluation.task_type,
    scope: evaluation.scope, complexity: evaluation.complexity, strategy: evaluation.strategy,
    strategy_version: evaluation.strategy_version, focus: [...evaluation.focus],
    workers: evaluation.workers.map(worker => ({ agent_id: worker.agent_id, assignment_id: worker.assignment_id,
      attempt_index: worker.attempt_index, criteria: worker.criteria.map(criterion => ({ id: criterion.id })) }))
  };
}
function costsCompact(costs = {}) {
  return {
    request_count: boundedNumber(costs.request_count) ?? 0, reconciled_request_count: boundedNumber(costs.reconciled_request_count) ?? 0,
    provider_reported_usd: boundedNumber(costs.provider_reported_usd) ?? 0,
    unresolved_request_count: boundedNumber(costs.unresolved_request_count) ?? 0,
    estimated_unreconciled_usd: boundedNumber(costs.estimated_unreconciled_usd) ?? 0,
    unpriced_request_count: boundedNumber(costs.unpriced_request_count) ?? 0,
    reported_byok_upstream_usd: boundedNumber(costs.reported_byok_upstream_usd) ?? 0,
    all_requests_reconciled: costs.all_requests_reconciled === true
  };
}
const compactCriterionResults = new Set(['passed', 'failed', 'inconclusive', 'not_run']);
const compactIntegrationStatuses = new Set(['not_assessed', 'not_applicable', 'candidate_only', 'accepted_modified', 'accepted_unmodified', 'rejected', 'deferred', 'unknown']);
function allowedKeys(value, keys, label) {
  assertObject(value, label);
  for (const key of Object.keys(value)) assert(keys.has(key), `Unknown ${label} field: ${key}`);
}
function nullableNonNegative(value, label) { assert(value === null || (isNumber(value) && value >= 0), `${label} must be a nonnegative number or null`); }
function compactTokens(tokens, label) {
  allowedKeys(tokens, new Set(['input', 'output', 'reasoning', 'cache_read', 'cache_write', 'total', 'known_requests']), label);
  for (const key of ['input', 'output', 'reasoning', 'cache_read', 'cache_write', 'total']) nullableNonNegative(tokens[key], `${label}.${key}`);
  allowedKeys(tokens.known_requests, new Set(['input', 'output', 'reasoning', 'cache_read', 'cache_write', 'total']), `${label}.known_requests`);
  for (const key of ['input', 'output', 'reasoning', 'cache_read', 'cache_write', 'total']) assert(Number.isInteger(tokens.known_requests[key]) && tokens.known_requests[key] >= 0, `${label}.known_requests.${key} must be a nonnegative integer`);
}
function compactCriteria(criteria, label) {
  if (criteria === null) return;
  assert(Array.isArray(criteria) && criteria.length <= 8, `${label} must be null or an array of at most 8 items`);
  const ids = new Set();
  for (const criterion of criteria) {
    allowedKeys(criterion, new Set(['id', 'result', 'evidence_count']), label);
    assert(safeText(criterion.id, `${label}.id`, 96) !== null, `${label}.id is required`); assert(!ids.has(criterion.id), `Duplicate ${label} id`); ids.add(criterion.id);
    assert(compactCriterionResults.has(criterion.result), `Invalid ${label} result`);
    assert(Number.isInteger(criterion.evidence_count) && criterion.evidence_count >= 0 && criterion.evidence_count <= 4, `Invalid ${label} evidence_count`);
  }
}
function compactAssessmentWorker(worker, label) {
  allowedKeys(worker, new Set(['agent_id', 'usefulness_0_to_3', 'quality_0_to_3', 'integration_status', 'criterion_results']), label);
  assert(safeText(worker.agent_id, `${label}.agent_id`, 96) !== null, `${label}.agent_id is required`);
  for (const key of ['usefulness_0_to_3', 'quality_0_to_3']) assert(worker[key] === null || (Number.isInteger(worker[key]) && worker[key] >= 0 && worker[key] <= 3), `${label}.${key} must be 0–3 or null`);
  assert(worker.integration_status === null || compactIntegrationStatuses.has(worker.integration_status), `Invalid ${label}.integration_status`);
  compactCriteria(worker.criterion_results, `${label}.criterion_results`);
}
function assessmentWorkers(assessment) { return new Map((assessment?.workers || []).map(worker => [worker.agent_id, worker])); }
function workerList(plan, report) {
  const byId = new Map((report?.agents || []).map(agent => [agent.id, agent]));
  return (plan?.agents || []).map(agent => byId.get(agent.id) || { id: agent.id, role: agent.role || 'sparring-partner', mode: agent.mode, status: 'not_started', model: { requested_model: agent.model, provider: agent.provider || plan?.policy?.preferred_provider, requested_effort: agent.effort || plan?.policy?.default_effort } })
    .concat((report?.agents || []).filter(agent => !plan?.agents?.some(spec => spec.id === agent.id)));
}
function usageCompact(usage, report, plan, assessment) {
  assert(Array.isArray(usage?.requests), 'Usage ledger requests are required for inventory');
  const requests = usage.requests;
  const costs = costsCompact(costSummary(requests));
  const evaluated = assessmentWorkers(assessment);
  return { request_count: requests.length, costs, workers: workerList(plan, report).map(agent => workerCompact(agent, requests, evaluated.get(agent.id))) };
}
function runRecord({ config, report, plan, usage, assessment = null, lifecycle = 'running', assessmentStatus = 'missing', assessmentSchemaVersion = null, expectedRoot = null }) {
  assertObject(report, 'report'); assertObject(plan, 'plan');
  const projectId = projectIdOf(config), root = projectRoot(report.source_repo);
  if (expectedRoot) assert(root === projectRoot(expectedRoot), 'Run provenance does not match the asserted repository');
  const createdAt = iso(report.created_at, 'report.created_at');
  const runId = safeText(report.run_id, 'report.run_id', 256); assert(runId, 'report.run_id is required');
  assert(LIFECYCLES.has(lifecycle), `Invalid inventory lifecycle: ${lifecycle}`);
  assert(ASSESSMENT_STATUSES.has(assessmentStatus), `Invalid inventory assessment status: ${assessmentStatus}`);
  assert(Array.isArray(usage?.requests), 'Usage ledger requests are required for inventory');
  const requests = usage.requests, costs = costsCompact(costSummary(requests));
  const evaluated = assessmentWorkers(assessment);
  const workers = workerList(plan, report).map(agent => workerCompact(agent, requests, evaluated.get(agent.id)));
  const taskId = plan.evaluation?.task_id ?? null;
  const key = digest([projectId, runId, createdAt]);
  return {
    key, run_id: runId, project_id: projectId,
    project_name: path.basename(root) || root,
    created_at: createdAt, finished_at: iso(report.finished_at, 'report.finished_at'), task_id: taskId,
    lifecycle, assessment: { status: assessmentStatus, schema_version: assessmentSchemaVersion, workers: [...evaluated.values()].map(worker => ({
      agent_id: worker.agent_id, usefulness_0_to_3: worker.usefulness_0_to_3 ?? null,
      quality_0_to_3: worker.quality_0_to_3 ?? null, integration_status: worker.integration_status ?? null,
      criterion_results: Array.isArray(worker.criterion_results) ? worker.criterion_results.map(item => ({ id: item.id, result: item.result, evidence_count: Array.isArray(item.evidence) ? item.evidence.length : 0 })) : null
    })) },
    host: { orchestrator: report.orchestrator ?? 'codex', orchestrator_model: report.orchestrator_model ?? null, orchestrator_version: report.orchestrator_version ?? null, skill_version: report.skill_version ?? null, sdk_version_target: report.sdk_version_target ?? null },
    costs, workers, plan: planCompact(plan), usage: usageCompact(usage, report, plan, assessment), evaluation: evaluationCompact(plan.evaluation)
  };
}
function validateRecord(record, projectId) {
  assertObject(record, 'inventory run');
  const allowed = new Set(['key', 'run_id', 'project_id', 'project_name', 'created_at', 'finished_at', 'task_id', 'lifecycle', 'assessment', 'costs', 'workers', 'plan', 'usage', 'evaluation', 'host']);
  for (const key of Object.keys(record)) assert(allowed.has(key), `Unknown inventory run field: ${key}`);
  for (const field of ['key', 'run_id', 'project_id', 'project_name', 'created_at', 'lifecycle', 'task_id', 'assessment', 'costs', 'workers', 'plan', 'usage', 'evaluation']) assert(Object.hasOwn(record, field), `Inventory run missing ${field}`);
  assert(record.project_id === projectId && typeof record.key === 'string' && /^[a-f0-9]{64}$/.test(record.key), 'Inventory run identity mismatch');
  assert(record.key === digest([projectId, record.run_id, record.created_at]), 'Inventory run key does not match its identity');
  safeText(record.run_id, 'inventory.run_id', 256); safeText(record.project_name, 'inventory.project_name', 256); safeText(record.task_id, 'inventory.task_id', 128);
  iso(record.created_at, 'inventory.created_at'); iso(record.finished_at, 'inventory.finished_at');
  assert(LIFECYCLES.has(record.lifecycle), 'Invalid inventory lifecycle');
  allowedKeys(record.assessment, new Set(['status', 'schema_version', 'workers']), 'inventory assessment');
  assert(ASSESSMENT_STATUSES.has(record.assessment.status), 'Invalid inventory assessment status');
  assert(record.assessment.schema_version === null || record.assessment.schema_version === 1 || record.assessment.schema_version === 2, 'Invalid inventory assessment schema version');
  assert(Array.isArray(record.assessment.workers) && record.assessment.workers.length <= MAX_WORKERS, 'Invalid inventory assessment workers');
  const assessedIds = new Set();
  for (const worker of record.assessment.workers) { compactAssessmentWorker(worker, 'inventory assessment worker'); assert(!assessedIds.has(worker.agent_id), 'Duplicate inventory assessment worker'); assessedIds.add(worker.agent_id); }
  assert(Array.isArray(record.workers) && record.workers.length <= MAX_WORKERS && Array.isArray(record.usage?.workers) && record.usage.workers.length <= MAX_WORKERS, 'Invalid inventory worker summary');
  const workerIds = new Set();
  for (const worker of record.workers) {
    allowedKeys(worker, new Set(['agent_id', 'role', 'mode', 'status', 'elapsed_seconds', 'failure_class', 'suggested_learning_failure_kind', 'limits', 'limit_usage', 'model', 'request_count', 'tokens', 'upstream_providers', 'assessment', 'costs']), 'inventory worker');
    assert(typeof worker.agent_id === 'string' && !workerIds.has(worker.agent_id), 'Duplicate inventory worker'); workerIds.add(worker.agent_id);
    safeText(worker.agent_id, 'inventory worker.agent_id', 96); safeText(worker.role, 'inventory worker.role', 240); safeText(worker.mode, 'inventory worker.mode', 32); safeText(worker.status, 'inventory worker.status', 64);
    nullableNonNegative(worker.elapsed_seconds, 'inventory worker.elapsed_seconds');
    if (worker.failure_class !== null) safeText(worker.failure_class, 'inventory worker.failure_class', 96);
    if (worker.suggested_learning_failure_kind !== null) safeText(worker.suggested_learning_failure_kind, 'inventory worker.suggested_learning_failure_kind', 96);
    assert(worker.limits === null || typeof worker.limits === 'object', 'Invalid inventory worker limits');
    assert(worker.limit_usage === null || typeof worker.limit_usage === 'object', 'Invalid inventory worker limit_usage');
    assert(worker.model === null || typeof worker.model === 'object', 'Invalid inventory model metadata');
    assert(Number.isInteger(worker.request_count) && worker.request_count >= 0, 'Invalid inventory worker request_count');
    compactTokens(worker.tokens, 'inventory worker tokens');
    assert(Array.isArray(worker.upstream_providers) && worker.upstream_providers.every(value => typeof value === 'string' && value.length <= 256), 'Invalid inventory upstream providers');
    assert(worker.assessment === null || typeof worker.assessment === 'object', 'Invalid inventory worker assessment');
    if (worker.assessment) compactAssessmentWorker({ agent_id: worker.agent_id, ...worker.assessment }, 'inventory worker assessment');
    assert(worker.costs && typeof worker.costs === 'object' && worker.tokens && typeof worker.tokens === 'object', 'Invalid inventory worker accounting');
  }
  allowedKeys(record.plan, new Set(['task_type', 'scope', 'complexity', 'strategy', 'strategy_version', 'focus', 'workers']), 'inventory plan');
  assert(Array.isArray(record.plan.workers) && record.plan.workers.length <= MAX_WORKERS, 'Invalid inventory plan snapshot');
  assert(Array.isArray(record.plan.focus) && record.plan.focus.length <= 8 && record.plan.focus.every(value => typeof value === 'string'), 'Invalid inventory plan focus');
  for (const worker of record.plan.workers) {
    allowedKeys(worker, new Set(['agent_id', 'assignment_id', 'attempt_index', 'criteria']), 'inventory plan worker');
    safeText(worker.agent_id, 'inventory plan worker.agent_id', 96);
    assert(worker.assignment_id === null || typeof worker.assignment_id === 'string', 'Invalid inventory assignment_id');
    assert(worker.attempt_index === null || (Number.isInteger(worker.attempt_index) && worker.attempt_index >= 1 && worker.attempt_index <= 999), 'Invalid inventory attempt_index');
    assert(Array.isArray(worker.criteria) && worker.criteria.length <= 8, 'Invalid inventory criteria');
    for (const criterion of worker.criteria) { allowedKeys(criterion, new Set(['id']), 'inventory plan criterion'); safeText(criterion.id, 'inventory plan criterion.id', 96); }
  }
  allowedKeys(record.usage, new Set(['request_count', 'costs', 'workers']), 'inventory usage');
  assert(Number.isInteger(record.usage.request_count) && record.usage.request_count >= 0, 'Invalid inventory usage request_count');
  assert(record.usage.costs && typeof record.usage.costs === 'object', 'Invalid inventory usage snapshot');
  for (const worker of record.usage.workers) { assert(typeof worker === 'object' && worker, 'Invalid inventory usage worker'); compactTokens(worker.tokens, 'inventory usage worker tokens'); }
  if (record.evaluation !== null) {
    allowedKeys(record.evaluation, new Set(['schema_version', 'task_id', 'task_type', 'scope', 'complexity', 'strategy', 'strategy_version', 'focus', 'workers']), 'inventory evaluation');
    assert(record.evaluation.schema_version === 1, 'Invalid inventory evaluation schema version');
    assert(Array.isArray(record.evaluation.focus) && record.evaluation.focus.length <= 8, 'Invalid inventory evaluation focus');
    assert(Array.isArray(record.evaluation.workers) && record.evaluation.workers.length <= MAX_WORKERS, 'Invalid inventory evaluation workers');
    for (const worker of record.evaluation.workers) { allowedKeys(worker, new Set(['agent_id', 'assignment_id', 'attempt_index', 'criteria']), 'inventory evaluation worker'); assert(Array.isArray(worker.criteria) && worker.criteria.length <= 8, 'Invalid inventory evaluation criteria'); }
  }
  if (record.host !== undefined) { allowedKeys(record.host, new Set(['orchestrator', 'orchestrator_model', 'orchestrator_version', 'skill_version', 'sdk_version_target']), 'inventory host'); for (const [key, value] of Object.entries(record.host)) if (value !== null) safeText(value, `inventory host.${key}`, 256); }
  assert(!Object.hasOwn(record, 'run_path'), 'Absolute run paths are not allowed in project inventory');
  return record;
}
function readInventoryUnlocked(root, config) {
  const projectId = projectIdOf(config), raw = readLocal(root, INVENTORY_FILE);
  if (raw === null) return { schema_version: INVENTORY_SCHEMA_VERSION, project_id: projectId, runs: [] };
  let inventory; try { inventory = JSON.parse(raw); } catch { fail('Invalid project run inventory JSON'); }
  assert(inventory.schema_version === INVENTORY_SCHEMA_VERSION && inventory.project_id === projectId && Array.isArray(inventory.runs) && inventory.runs.length <= MAX_RUNS, 'Invalid or foreign project run inventory');
  const keys = new Set();
  for (const record of inventory.runs) { validateRecord(record, projectId); assert(!keys.has(record.key), 'Duplicate inventory run key'); keys.add(record.key); }
  return inventory;
}

/** Read-only inventory access.  Uninitialized projects return null and never create state. */
export function readRunInventory(repo) {
  const root = projectRoot(repo), config = readConfig(root);
  if (!config) return null;
  return structuredClone(readInventoryUnlocked(root, config));
}

function updateUnlocked(root, config, record, { create = true } = {}) {
  const inventory = readInventoryUnlocked(root, config), at = inventory.runs.findIndex(item => item.key === record.key);
  if (at < 0) {
    assert(create, `Run is absent from project inventory: ${record.run_id}`);
    assert(inventory.runs.length < MAX_RUNS, 'Project run inventory limit reached');
    inventory.runs.push(record);
  } else inventory.runs[at] = record;
  const before = readLocal(root, INVENTORY_FILE);
  writeLocal(root, INVENTORY_FILE, jsonText(inventory), bytesHash(before));
  return { recorded: true, key: record.key, lifecycle: record.lifecycle, inventory: record };
}

/** Create the durable record before a worker request is started. */
export function beginRunInventory(repo, { report, plan, usage = { requests: [], costs: costSummary([]) } } = {}) {
  const root = projectRoot(repo), config = readConfig(root);
  if (!config || config.mode === 'off') return { recorded: false, warning: 'Project learning is uninitialized or off; run inventory was not recorded.' };
  if (report?.mode && report.mode !== 'pi_sdk') return { recorded: false, warning: 'Synthetic/offline runner output is not entered into project inventory.' };
  return withLock(root, () => updateUnlocked(root, config, runRecord({ config, report, plan, usage, lifecycle: 'running', expectedRoot: root }), { create: true }));
}

/** Update the compact record after execution, assessment, or finalization. */
export function updateRunInventory(repo, { report, plan, usage, assessment = null, lifecycle, assessmentStatus = 'missing', assessmentSchemaVersion = null } = {}) {
  const root = projectRoot(repo), config = readConfig(root);
  if (!config || config.mode === 'off') return { recorded: false, warning: 'Project learning is uninitialized or off; run inventory was not updated.' };
  assert(lifecycle, 'lifecycle is required');
  return withLock(root, () => updateUnlocked(root, config, runRecord({ config, report, plan, usage, assessment, lifecycle, assessmentStatus, assessmentSchemaVersion, expectedRoot: root }), { create: false }));
}

/**
 * Backfill one explicitly named genuine run directory.  This never scans a
 * parent directory and never accepts a run whose report points elsewhere.
 */
export function backfillRunInventory(repo, runDir, { lifecycle = 'completed', assessmentStatus = 'missing', assessmentSchemaVersion = null, assessment = null } = {}) {
  const root = projectRoot(repo), runStat = fs.lstatSync(runDir);
  assert(runStat.isDirectory() && !runStat.isSymbolicLink(), 'Run directory must be a regular directory');
  const resolvedRun = fs.realpathSync(runDir);
  const relative = path.relative(root, resolvedRun);
  assert(relative !== '' && relative.startsWith('..' + path.sep) && !path.isAbsolute(relative), 'Run artifacts must be outside the task repository');
  const read = file => {
    const value = readLocal(resolvedRun, file, 8 * 1024 * 1024);
    assert(value !== null, `Missing run artifact: ${file}`);
    try { return JSON.parse(value); } catch (e) { fail(`Invalid run artifact JSON: ${file}: ${e.message}`); }
  };
  const report = read('report.json'), plan = read('plan.json'), usage = read('usage.json'), snapshot = read('snapshot.json');
  assert(report.mode === 'pi_sdk', 'Synthetic/offline runner output cannot become project run inventory');
  assert(projectRoot(report.source_repo) === root && projectRoot(plan.repo_root) === root && projectRoot(snapshot.repo_root) === root && snapshot.files && typeof snapshot.files === 'object', 'Run provenance does not match the asserted repository');
  assert(Array.isArray(usage.requests), 'Run usage ledger is missing request records');
  return beginOrUpdateRunInventory(root, { report, plan, usage, assessment, lifecycle, assessmentStatus, assessmentSchemaVersion });
}
function beginOrUpdateRunInventory(root, args) {
  const config = readConfig(root);
  if (!config || config.mode === 'off') return { recorded: false, warning: 'Project learning is uninitialized or off; run inventory was not updated.' };
  return withLock(root, () => updateUnlocked(root, config, runRecord({ config, ...args, expectedRoot: root }), { create: true }));
}

export function inventoryForRun(repo, runId) {
  const inventory = readRunInventory(repo);
  if (!inventory) return null;
  return inventory.runs.find(record => record.run_id === runId) || null;
}
