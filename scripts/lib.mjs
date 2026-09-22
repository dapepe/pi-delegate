/** Dependency-free policy, snapshot and capability layer. No model-generated code is executed. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { TextDecoder } from 'node:util';
import { ROLE_DEFAULT, validateEvaluation } from './evaluation.mjs';

export const HOSTS = Object.freeze({ codex: 'Codex', 'claude-code': 'Claude Code' });
export function hostLabel(host = 'codex') { assert(Object.hasOwn(HOSTS, host), 'Orchestrator must be codex or claude-code'); return HOSTS[host]; }

export const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const PROVIDERS = new Set(['openrouter', 'openai', 'anthropic', 'google']);
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
export const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
export const isNumber = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
export const inside = (root, candidate) => {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
};
export function assert(test, message) { if (!test) throw new Error(message); }
export function text(value, label, max = 80000) {
  assert(typeof value === 'string' && value.trim().length > 0 && value.length <= max, `${label}: expected a nonempty string (max ${max} characters)`);
  return value;
}
export function cleanRel(value) {
  text(value, 'path', 1024);
  assert(!path.posix.isAbsolute(value) && !value.includes('\\') && !/[\x00-\x1f\x7f:<>"|?*]/.test(value), `Invalid relative path: ${value}`);
  const parts = value.split('/');
  assert(parts.every(p => p && p !== '.' && p !== '..'), `Unsafe relative path: ${value}`);
  assert(parts.every(p => !/[. ]$/.test(p) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p)), `Nonportable relative path: ${value}`);
  assert(!value.startsWith('~'), `Home expansion is not allowed: ${value}`);
  return value;
}
export function deniedPath(value) {
  const parts = cleanRel(value).toLowerCase().split('/');
  return parts.some(p => ['.git', '.ssh', '.aws', '.azure', '.gnupg', '.pi', '.agents', '.codex', '.claude', 'node_modules', 'secrets', '.venv'].includes(p)) ||
    parts.some(p => p === '.env' || p.startsWith('.env.') || /\.(pem|key|p12|pfx|keystore)$/.test(p) ||
      ['auth.json', 'credentials.json', 'credentials', '.npmrc', '.netrc', 'id_rsa', 'id_ed25519', 'agents.md', 'agents.override.md', 'claude.md', 'claude.local.md'].includes(p));
}
export function checkRel(value) {
  cleanRel(value);
  assert(!deniedPath(value), `Sensitive or agent-configuration path is not delegable: ${value}`);
  return value;
}
export function readSource(root, rel, maxBytes, mayBeMissing = false) {
  checkRel(rel);
  const parts = rel.split('/');
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (e) { if (e.code === 'ENOENT' && mayBeMissing) return null; throw e; }
    assert(!stat.isSymbolicLink(), `Symlink rejected: ${rel}`);
    assert(i === parts.length - 1 ? stat.isFile() : stat.isDirectory(), `Not a regular source path: ${rel}`);
    assert(i !== parts.length - 1 || stat.size <= maxBytes, `File too large: ${rel}`);
  }
  // Compare real path against real path: on macOS the temp root is itself a symlink
  // (/var → /private/var), and an unresolved root made every file look as if it had escaped.
  assert(inside(fs.realpathSync(root), fs.realpathSync(current)), `Path escapes source root: ${rel}`);
  // O_NOFOLLOW closes the final-component symlink race on supporting platforms.
  const fd = fs.openSync(current, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    assert(stat.isFile() && stat.size <= maxBytes, `File changed while reading: ${rel}`);
    // Read at most the approved ceiling even if another local process grows the file.
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0, read;
    while (length < buffer.length && (read = fs.readSync(fd, buffer, length, buffer.length - length, null)) > 0) length += read;
    const bytes = buffer.subarray(0, length);
    assert(bytes.length <= maxBytes && !bytes.includes(0), `Binary or oversized file: ${rel}`);
    const content = decoder.decode(bytes);
    return { content, hash: sha256(bytes), bytes: bytes.length, mode: stat.mode & 0o777 };
  } finally { fs.closeSync(fd); }
}
export function mergePolicy(defaults, override = {}) {
  assert(override && typeof override === 'object' && !Array.isArray(override), 'policy must be an object');
  for (const key of Object.keys(override)) assert(Object.hasOwn(defaults, key), `Unknown policy key: ${key}`);
  for (const k of ['model_aliases', 'openrouter_routing']) if (Object.hasOwn(override, k)) assert(override[k] && typeof override[k] === 'object' && !Array.isArray(override[k]), `${k} must be an object`);
  const p = { ...defaults, ...override,
    model_aliases: { ...defaults.model_aliases, ...(override.model_aliases || {}) },
    openrouter_routing: { ...defaults.openrouter_routing, ...(override.openrouter_routing || {}) }
  };
  assert(PROVIDERS.has(p.preferred_provider), 'Supported providers: openrouter, openai, anthropic, google');
  assert(Array.isArray(p.preferred_models) && p.preferred_models.length && p.preferred_models.every(x => typeof x === 'string' && x.length), 'preferred_models must be a nonempty string array');
  assert(['xhigh', 'max'].includes(p.default_effort) && ['xhigh', 'max'].includes(p.complex_effort), 'Default and complex effort must be xhigh or max');
  assert(['best_supported', 'strict'].includes(p.effort_policy), 'effort_policy must be best_supported or strict');
  for (const k of ['max_agents', 'max_parallel', 'max_turns', 'max_tool_calls', 'timeout_seconds', 'request_timeout_seconds', 'heartbeat_seconds', 'max_output_tokens', 'max_file_bytes', 'max_context_bytes']) {
    assert(Number.isInteger(p[k]) && p[k] > 0, `${k} must be a positive integer`);
  }
  for (const k of ['stream_idle_timeout_seconds', 'finalization_turns', 'finalization_seconds', 'max_completion_repairs']) {
    assert(Number.isInteger(p[k]) && p[k] >= 0, `${k} must be a nonnegative integer`);
  }
  assert(p.max_completion_repairs <= 3, 'max_completion_repairs must be <=3');
  assert(p.finalization_seconds < p.timeout_seconds, 'finalization_seconds must be shorter than timeout_seconds');
  assert(p.finalization_turns < p.max_turns, 'finalization_turns must leave at least one working request');
  // setTimeout silently misfires past 2^31-1 ms; refuse a value that cannot be armed honestly.
  for (const k of ['timeout_seconds', 'request_timeout_seconds', 'stream_idle_timeout_seconds', 'heartbeat_seconds']) assert(p[k] <= 86400, `${k} must be <=86400 to avoid timer overflow`);
  for (const k of ['per_agent_budget_usd', 'session_budget_usd']) assert(isNumber(p[k]) && p[k] > 0, `${k} must be positive`);
  assert(typeof p.allow_model_exceptions === 'boolean', 'allow_model_exceptions must be a boolean');
  assert(p.model_aliases && typeof p.model_aliases === 'object' && !Array.isArray(p.model_aliases), 'model_aliases must be an object');
  for (const [k, v] of Object.entries(p.model_aliases)) { text(k, 'alias name', 200); text(v, 'alias target', 200); }
  const route = p.openrouter_routing;
  const routeKeys = new Set(['require_parameters', 'data_collection', 'allow_fallbacks', 'zdr', 'order', 'only', 'ignore', 'max_price']);
  for (const k of Object.keys(route)) assert(routeKeys.has(k), `Unsupported routing key: ${k}`);
  assert(route.require_parameters === true, 'require_parameters must remain true');
  assert(['deny', 'allow'].includes(route.data_collection), 'data_collection must be deny or allow');
  assert(typeof route.allow_fallbacks === 'boolean', 'allow_fallbacks must be boolean');
  if (route.zdr !== undefined) assert(typeof route.zdr === 'boolean', 'zdr must be boolean');
  for (const k of ['order', 'only', 'ignore']) if (route[k] !== undefined) assert(Array.isArray(route[k]) && route[k].every(x => typeof x === 'string'), `${k} must be a string array`);
  if (route.max_price !== undefined) {
    assert(route.max_price && typeof route.max_price === 'object' && !Array.isArray(route.max_price), 'max_price must be an object');
    for (const [k, v] of Object.entries(route.max_price)) assert(['prompt', 'completion', 'request', 'image', 'audio'].includes(k) && isNumber(v), 'max_price contains an invalid key or value');
  }
  return p;
}
/**
 * A per-worker allocation. It may only *reduce* an authorized plan ceiling: a narrow read-only
 * reviewer can be given less than an implementer in the same plan, but no worker can grant
 * itself more time, requests, tools, output or budget than the host authorized.
 */
export const WORKER_LIMIT_KEYS = ['max_turns', 'max_tool_calls', 'timeout_seconds', 'request_timeout_seconds', 'max_output_tokens', 'per_agent_budget_usd'];
export function workerPolicy(policy, limits = {}) {
  assert(limits && typeof limits === 'object' && !Array.isArray(limits), 'Worker limits must be an object');
  for (const [key, value] of Object.entries(limits)) {
    assert(WORKER_LIMIT_KEYS.includes(key), `Unknown worker limit: ${key}`);
    assert(isNumber(value) && value > 0 && (key === 'per_agent_budget_usd' || Number.isInteger(value)), `Invalid worker limit: ${key}`);
    assert(value <= policy[key], `Worker ${key} cannot exceed the plan ceiling`);
  }
  return { ...policy, ...limits };
}
export function chooseEffort(requested, supported, policy = 'best_supported') {
  assert(['xhigh', 'max'].includes(requested), 'Requested effort must be xhigh or max');
  assert(Array.isArray(supported) && supported.length, 'No verified reasoning effort metadata; choose another model or refresh its catalog');
  const known = LEVELS.filter(x => supported.includes(x));
  assert(known.some(x => ['high', 'xhigh', 'max'].includes(x)), 'Model does not expose a verified high-reasoning setting');
  if (known.includes(requested)) return { requested, effective: requested, mapping: 'exact' };
  assert(policy !== 'strict', `Model does not support requested effort ${requested}; strict policy forbids mapping`);
  const above = known.find(x => LEVELS.indexOf(x) > LEVELS.indexOf(requested));
  const effective = above || known.at(-1);
  return { requested, effective, mapping: above ? 'raised_to_next_supported' : 'clamped_to_highest_supported' };
}
export function resolveCatalogModel(catalog, requested, aliases = {}) {
  assert(Array.isArray(catalog), 'Invalid OpenRouter model catalog');
  let item = catalog.find(m => m.id === requested);
  let alias = null;
  if (!item && Object.hasOwn(aliases, requested)) {
    item = catalog.find(m => m.id === aliases[requested]);
    if (item) alias = { from: requested, to: item.id, source: 'explicit_policy_alias' };
  }
  assert(item, `Model not in live catalog: ${requested}. No fuzzy or unapproved fallback is allowed.`);
  assert(item.supported_parameters?.includes('tools'), `Model does not advertise tool calling: ${item.id}`);
  assert(item.architecture?.input_modalities?.includes('text') && item.architecture?.output_modalities?.includes('text'), `Text I/O unavailable: ${item.id}`);
  return { item, alias };
}
export function openRouterModel(item, routing) {
  const supported = item.reasoning?.supported_efforts;
  assert(Array.isArray(supported), `No supported_efforts metadata for ${item.id}`);
  const pricing = item.pricing || {};
  const rate = (key, fallback) => {
    const value = pricing[key] ?? fallback;
    assert(value !== undefined && isNumber(Number(value)), `Missing/invalid ${key} pricing for ${item.id}`);
    return Number(value) * 1e6;
  };
  const cost = { input: rate('prompt'), output: rate('completion'), cacheRead: rate('input_cache_read', pricing.prompt), cacheWrite: rate('input_cache_write', pricing.prompt) };
  // Use conservative maximum published rates for estimates, including time/length overrides.
  // These remain estimates, not the OpenRouter account charge.
  for (const tier of pricing.overrides || []) {
    for (const [source, target] of [['prompt', 'input'], ['completion', 'output'], ['input_cache_read', 'cacheRead'], ['input_cache_write', 'cacheWrite']]) {
      if (tier[source] !== undefined && isNumber(Number(tier[source]))) cost[target] = Math.max(cost[target], Number(tier[source]) * 1e6);
    }
  }
  const limit = item.top_provider?.max_completion_tokens;
  assert(Number.isInteger(limit) && limit > 0 && Number.isInteger(item.context_length), `Missing context/output limits: ${item.id}`);
  return {
    id: item.id, name: item.name || item.id, api: 'openai-completions', provider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1', reasoning: true, input: ['text'], cost,
    contextWindow: item.context_length, maxTokens: limit,
    thinkingLevelMap: Object.fromEntries(LEVELS.map(x => [x, supported.includes(x) ? x : x === 'off' && supported.includes('none') ? 'none' : null])),
    compat: { thinkingFormat: 'openrouter', maxTokensField: 'max_tokens', openRouterRouting: routing }
  };
}
export function validatePlan(input, defaults) {
  assert(input && typeof input === 'object' && !Array.isArray(input), 'Plan must be an object');
  const allowed = new Set(['repo_root', 'objective', 'context', 'policy', 'policy_sources', 'read_files', 'agents', 'evaluation', 'orchestrator', 'orchestrator_model', 'orchestrator_version']);
  for (const key of Object.keys(input)) assert(allowed.has(key), `Unknown plan key: ${key}`);
  const orchestrator = input.orchestrator ?? 'codex';
  hostLabel(orchestrator);
  for (const key of ['orchestrator_model', 'orchestrator_version']) if (input[key] != null) text(input[key], key, 200);
  const policy = mergePolicy(defaults, input.policy);
  const repo = fs.realpathSync(text(input.repo_root, 'repo_root', 4096));
  assert(fs.statSync(repo).isDirectory(), 'repo_root must be a directory');
  text(input.objective, 'objective');
  assert(input.context === undefined || (typeof input.context === 'string' && Buffer.byteLength(input.context) <= policy.max_context_bytes), 'context must be a bounded string');
  assert(input.policy_sources === undefined || (Array.isArray(input.policy_sources) && input.policy_sources.length <= 50 && input.policy_sources.every(v => typeof v === 'string' && v.length <= 4096)), 'policy_sources must be a bounded string array');
  assert(Array.isArray(input.read_files) && input.read_files.length <= 256 && input.read_files.length, 'read_files must enumerate at least one file; directories/globs are not accepted');
  const readFiles = [...new Set(input.read_files.map(checkRel))];
  assert(Array.isArray(input.agents) && input.agents.length > 0 && input.agents.length <= policy.max_agents, 'Agent count exceeds policy or is empty');
  const ids = new Set();
  const agents = input.agents.map(a => {
    assert(a && typeof a === 'object' && !Array.isArray(a), 'Each agent must be an object');
    for (const k of ['read_files', 'write_files']) if (a[k] !== undefined) assert(Array.isArray(a[k]) && a[k].length <= 256, `${k} must be an array of at most 256 paths`);
    const keys = new Set(['id', 'role', 'task', 'model', 'provider', 'mode', 'read_files', 'write_files', 'effort', 'selection_reason', 'model_exception_reason', 'limits']);
    for (const k of Object.keys(a)) assert(keys.has(k), `Unknown agent field: ${k}`);
    assert(typeof a.id === 'string' && /^[a-z][a-z0-9_-]{0,47}$/.test(a.id) && !ids.has(a.id), 'Agent IDs must be unique, portable lowercase names');
    cleanRel(a.id); // Output directories must also be portable on Windows.
    ids.add(a.id);
    const role = a.role ?? ROLE_DEFAULT;
    text(role, 'role', 300); text(a.task, 'task'); text(a.selection_reason, 'selection_reason', 4000); text(a.model, 'model', 200);
    const provider = a.provider || policy.preferred_provider;
    assert(PROVIDERS.has(provider), `Unsupported provider: ${provider}`);
    if (provider !== policy.preferred_provider || !policy.preferred_models.includes(a.model)) {
      assert(policy.allow_model_exceptions && typeof a.model_exception_reason === 'string' && a.model_exception_reason.trim().length > 0 && a.model_exception_reason.length <= 4000, `Nonpreferred provider/model ${provider}/${a.model} needs allow_model_exceptions and model_exception_reason`);
    }
    assert(['read', 'write'].includes(a.mode), 'Each agent needs an explicit read or write mode');
    const accessible = a.read_files === undefined ? readFiles : [...new Set(a.read_files.map(checkRel))];
    assert(accessible.every(f => readFiles.includes(f)), 'Per-agent read_files must be a subset of the plan snapshot');
    const writable = [...new Set((a.write_files || []).map(checkRel))];
    assert(a.mode !== 'read' || writable.length === 0, 'Read-only agent cannot have write_files');
    assert(a.mode !== 'write' || writable.length > 0, 'Write agent requires explicit write_files');
    const effort = a.effort || policy.default_effort;
    assert(['xhigh', 'max'].includes(effort), 'Each requested effort must be xhigh or max');
    workerPolicy(policy, a.limits); // A per-worker allocation may narrow the plan ceiling, never raise it.
    return { ...a, role, provider, effort, read_files: accessible, write_files: writable };
  });
  const paths = [...new Set([...readFiles, ...agents.flatMap(a => a.write_files)])];
  const portable = new Set();
  for (const file of paths) {
    const key = file.normalize('NFC').toLowerCase();
    assert(!portable.has(key), `Case/Unicode-colliding path grant: ${file}`);
    portable.add(key);
  }
  for (const file of portable) {
    const parts = file.split('/');
    while (parts.length > 1) { parts.pop(); assert(!portable.has(parts.join('/')), 'File/directory path grants overlap'); }
  }
  const evaluation = input.evaluation === undefined ? undefined : validateEvaluation(input.evaluation, agents);
  return { ...input, orchestrator, repo_root: repo, policy, read_files: readFiles, agents, ...(evaluation ? { evaluation } : {}) };
}
export function captureSnapshot(plan) {
  const baseline = new Map();
  let size = 0;
  for (const rel of plan.read_files) {
    const item = readSource(plan.repo_root, rel, plan.policy.max_file_bytes);
    size += item.bytes;
    baseline.set(rel, item);
  }
  for (const agent of plan.agents) for (const rel of agent.write_files) {
    const item = baseline.has(rel) ? baseline.get(rel) : readSource(plan.repo_root, rel, plan.policy.max_file_bytes, true);
    assert(item === null || agent.read_files.includes(rel), `Existing write target must also be readable by that agent: ${rel}`);
    if (!baseline.has(rel)) baseline.set(rel, item);
  }
  assert(size + Buffer.byteLength(plan.context || '') <= plan.policy.max_context_bytes, 'Snapshot/context is too large; select fewer files');
  // Recheck snapshot dependencies before the first model request.
  const mismatch = verifySnapshot(plan.repo_root, manifestOf(baseline), plan.policy.max_file_bytes);
  assert(mismatch.length === 0, `Source changed during snapshot creation: ${mismatch.join(', ')}`);
  return baseline;
}
export function manifestOf(baseline) {
  return Object.fromEntries([...baseline].map(([file, record]) => [file, record ? { sha256: record.hash, bytes: record.bytes, mode: record.mode } : null]));
}
export function verifySnapshot(repo, manifest, maxBytes = 524288) {
  const changes = [];
  for (const [rel, original] of Object.entries(manifest)) {
    try {
      const current = readSource(repo, rel, maxBytes, true);
      if ((original?.sha256 ?? null) !== (current?.hash ?? null) || (original && current && original.mode !== current.mode)) changes.push(rel);
    } catch { changes.push(rel); }
  }
  return changes;
}
const schema = (properties = {}, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const string = (maxLength = 5000) => ({ type: 'string', maxLength });
const strings = (maxItems = 50) => ({ type: 'array', items: string(), maxItems });
const resultSchema = schema({
  summary: string(10000),
  findings: { type: 'array', maxItems: 30, items: schema({
    id: string(80), title: string(400), severity: { enum: ['critical', 'high', 'medium', 'low', 'info'], type: 'string' },
    confidence: { enum: ['high', 'medium', 'low'], type: 'string' },
    file: string(1024), line: { type: 'integer', minimum: 1 }, evidence: string(6000), recommendation: string(6000)
  }) },
  proposed_tests: strings(30), open_questions: strings(30),
  completion: { type: 'string', enum: ['complete', 'partial', 'blocked'] }, remaining_work: strings(30)
}, ['summary', 'findings', 'proposed_tests', 'open_questions']);
export function validateSubmission(value, files) {
  text(value.summary, 'summary', 10000);
  // An honest partial result is worth more than a false completion, so both are accepted — but a
  // worker that declares unfinished work must say what is left, and a complete claim may not.
  if (value.completion !== undefined) assert(['complete', 'partial', 'blocked'].includes(value.completion), 'Invalid completion claim');
  if (value.remaining_work !== undefined) assert(Array.isArray(value.remaining_work) && value.remaining_work.length <= 30 && value.remaining_work.every(s => typeof s === 'string' && s.trim() && s.length <= 5000), 'remaining_work must be a bounded string array');
  if (['partial', 'blocked'].includes(value.completion)) assert(value.remaining_work?.length > 0, 'Partial or blocked results must identify remaining work');
  if (value.completion === 'complete') assert(!value.remaining_work?.length, 'A complete result cannot list remaining work');
  assert(Array.isArray(value.findings) && value.findings.length <= 30, 'findings must be an array with <=30 items');
  const ids = new Set();
  for (const f of value.findings) {
    text(f.id, 'finding id', 80); assert(!ids.has(f.id), 'Duplicate finding ID'); ids.add(f.id);
    text(f.title, 'finding title', 400); text(f.evidence, 'evidence', 6000); text(f.recommendation, 'recommendation', 6000);
    assert(['critical', 'high', 'medium', 'low', 'info'].includes(f.severity), 'Invalid severity');
    assert(['high', 'medium', 'low'].includes(f.confidence), 'Invalid confidence');
    assert(files.has(f.file) && typeof files.get(f.file) === 'string', `Finding cites an unavailable path: ${f.file}`);
    const content = files.get(f.file);
    assert(Number.isInteger(f.line) && f.line >= 1 && f.line <= Math.max(1, (content || '').split('\n').length), 'Evidence line is outside the file');
  }
  for (const key of ['proposed_tests', 'open_questions']) {
    assert(Array.isArray(value[key]) && value[key].length <= 30 && value[key].every(s => typeof s === 'string' && s.length <= 5000), `${key} must be a bounded string array`);
  }
  return structuredClone(value);
}
/**
 * Every exact identity under which a resolved worker model may legitimately be returned or
 * billed: the resolved id, its canonical slug, and — for a moving alias — the catalog alias
 * target and that target's own canonical (dated) slug. All four come from the live catalog;
 * nothing here is fuzzy. A moving alias such as `~x-ai/grok-latest` is billed under the dated
 * build of its target, and without the last entry every such run was flagged as a mismatch.
 */
export function authorizedIdentities(metadata = {}) {
  return [...new Set([
    metadata.resolved_model, metadata.canonical_slug,
    metadata.catalog_alias_target?.slug, metadata.catalog_alias_target?.canonical_slug
  ].filter(Boolean))];
}

/**
 * Explain a worker's terminal status to the host, separating operational failures (which say
 * nothing about the model and may justify one narrowed retry) from limits, refusals and honest
 * partial results that need a decision. `suggested_learning_failure_kind` maps onto the learning
 * vocabulary; it is a suggestion for the host's assessment, never recorded automatically.
 * Every status here also has an entry in the stop-layer table in runtime.mjs.
 */
export function classifyStop({ status, warnings = [], usage = null, max_output_tokens = null, timing = null, finalization_seconds = null, timeout = null, remaining_work = [] }) {
  const out = (failure_class, failure_hint, suggested_learning_failure_kind) => ({ failure_class, failure_hint, suggested_learning_failure_kind });
  if (status === 'completed') return out('none', null, 'none');
  const text = warnings.map(w => String(w)).join(' ');
  const left = remaining_work.length ? ` The worker named ${remaining_work.length} remaining item(s).` : '';
  if (status === 'partial') return out('partial', `The worker submitted evidence and declared the assignment unfinished.${left} Its findings may still be useful; the work is not complete. Repacket the remainder rather than retrying the whole task.`, 'none');
  if (status === 'blocked') return out('blocked', `The worker submitted a blocker rather than a result.${left} Resolve the blocker or narrow the packet; do not widen its authority to work around it.`, 'packet');
  if (status === 'output_limit') {
    const reasoning = usage?.reasoning ?? 0, output = usage?.output ?? 0;
    if (output > 0 && reasoning >= 0.8 * output) {
      return out('output_limit_reasoning',
        `The final request spent ${reasoning} of ${output} output tokens on reasoning (limit ${max_output_tokens ?? 'unknown'}) and never called submit_result. ` +
        'Put an explicit submission cap in the task (for example: under 1,200 words, at most 8 findings), narrow the packet, or choose a model that submits earlier. Raising max_output_tokens rarely helps.', 'packet');
    }
    return out('output_limit', 'The final response hit the output token limit before submit_result, and the submission-only repair did not produce one either. Cap the submission size in the task packet or ask for fewer findings.', 'packet');
  }
  if (status === 'timeout') {
    const mean = timing?.mean_request_seconds, n = timing?.requests ?? 0;
    const slow = isNumber(mean) && mean >= 60;
    const latency = slow ? ` ${n} request(s) averaged ${Math.round(mean)} s each, so the wall clock went to provider latency rather than to a large packet.` : '';
    return out('timeout',
      `The worker reached timeout_seconds (${timeout ?? 'unknown'}) without submitting.${latency} ` +
      `Retry at most once with fewer read_files, a higher timeout_seconds, or another authorized model; the reserved finishing window (${finalization_seconds ?? 'unknown'} s) refused non-submit tools only at the end.`,
      // Minutes per request is the route's latency, not an allocation the host chose badly.
      slow ? 'provider' : 'limit');
  }
  if (status === 'request_timeout') return out('request_timeout', `A single provider request exceeded request_timeout_seconds while the worker deadline still had time left. This is provider latency or a stalled route, not a packet the worker could not finish. Check the per-request timing before raising any limit.`, 'provider');
  if (status === 'stream_idle_timeout') return out('stream_idle_timeout', 'The opt-in SDK-event idle timer fired. A quiet reasoning model is not necessarily stuck: this guard is disabled by default and proves only that no visible event arrived.', 'provider');
  if (status === 'error') {
    if (/\b429\b|rate.?limit/i.test(text)) return out('provider_rate_limit', 'The provider or gateway rate-limited the request (HTTP 429). Transient, and no evidence about the model: wait and retry once, or use another authorized model.', 'provider');
    if (/\b5\d\d\b|overload|unavailable|ECONN|socket|network|timed? ?out/i.test(text)) return out('provider_error', 'The provider or network failed (5xx or connection error). Transient: retry once later or use another authorized route. Not model-quality evidence.', 'provider');
    return out('error', 'The worker stopped on an error the runner could not classify. Read the warnings before deciding whether a retry is justified.', 'unknown');
  }
  if (status === 'aborted') return out('aborted', 'The provider or SDK reported an abort. Compare the worker and request timers with the host-command result before assuming a cause.', 'unknown');
  if (status === 'model_mismatch') return out('model_mismatch', 'The provider returned or billed a model identity outside the authorized set. Do not retry blindly; check the alias and catalog identities first.', 'provider');
  if (status === 'refusal') return out('refusal', 'A provider or worker refusal was observed. Detection of unstructured refusal text is conservative and best-effort. Do not re-run to circumvent it.', 'model');
  if (status === 'policy_violation') return out('policy_violation', 'The worker attempted a file action outside its grant and was denied. Inspect the denial and the preserved candidate; do not widen permissions to make the same attempt succeed.', 'model');
  if (['budget_limit', 'budget_reservation_limit'].includes(status)) return out('budget', `The soft budget guard stopped the worker. ${status === 'budget_reservation_limit' ? 'A reservation is not spent money: inspect last_admission before concluding the budget was consumed.' : ''} A retry needs explicit authorization.`.trim(), 'host');
  if (status === 'context_limit') return out('context_limit', 'The packet exceeded the conservative byte-based context ceiling, which is not an exact token count. Narrow read_files; do not compact.', 'packet');
  if (['turn_limit', 'tool_limit'].includes(status)) return out(status, `The worker used every allowed ${status === 'turn_limit' ? 'provider request (tool iterations and completion repairs count)' : 'tool call'} without submitting. Narrow the task, allocate more explicitly, or tell it to read each file once and then submit.`, 'limit');
  if (status === 'missing_submission') return out('missing_submission', 'The worker ended without calling submit_result, and bounded completion repair did not produce one. Inspect the public output and candidate checkpoint before deciding whether another attempt is worthwhile.', 'unknown');
  if (status === 'cancelled') return out('cancelled', 'The run was cancelled by the host or an external signal. A caught signal does not identify who sent it.', 'host');
  if (status === 'orchestration_error') return out('orchestration_error', 'The runner failed outside a normal worker result. Inspect orchestration_errors before any retry.', 'host');
  if (['running', 'starting'].includes(status)) return out('unfinished', 'No final worker result was recorded. The process may still be live or may have been killed; the artifacts alone do not establish which. Check the host task handle before launching a duplicate.', 'unknown');
  if (status === 'not_started') return out('not_started', 'This worker was never launched. Inspect the recorded reason and the preceding workers.', 'host');
  return out(String(status), null, 'unknown');
}

export function createCapabilities(agent, baseline, policy, stopped = () => false, orchestrator = 'codex', controls = {}) {
  const host = hostLabel(orchestrator);
  // The model sees only these Maps. Tools never resolve a model-supplied path against disk.
  const initial = new Map(agent.read_files.map(f => [f, baseline.get(f).content]));
  for (const f of agent.write_files) if (!initial.has(f)) initial.set(f, null);
  const overlay = new Map(initial);
  const writable = new Set(agent.write_files);
  const state = { submitted: null, tool_calls: 0, rejected_tool_calls: 0, policy_violations: [], tool_errors: [], reads: [], searches: [], deadline: { warnings: 0, refusals: 0 } };
  const response = value => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], details: {} });
  // The runner reserves finishing allowance at request boundaries; a single request can still
  // spend minutes in tool calls, so the same reserve is enforced here on every call.
  const reserve = Number.isInteger(controls.finalizationSeconds) ? controls.finalizationSeconds : 0;
  const remaining = () => { const value = controls.remainingSeconds ? controls.remainingSeconds() : null; return typeof value === 'number' && Number.isFinite(value) ? value : null; };
  const wrap = (name, description, parameters, fn) => ({
    name, label: name, description, parameters, executionMode: 'sequential',
    execute: async (_id, args, signal) => {
      assert(!signal?.aborted && !stopped(), 'Run is stopped');
      assert(!state.submitted, 'Result already submitted; no further actions permitted');
      // Finalization: a worker that read everything and then ran out of time, tool calls or
      // turns before writing anything has spent the whole budget for nothing. In the reserved
      // window only submit_result is accepted. This is not a policy violation by the worker.
      const left = name === 'submit_result' ? null : remaining();
      const outOfTime = left !== null && reserve > 0 && left <= reserve;
      if (name !== 'submit_result' && (controls.finalizing?.() || outOfTime || state.tool_calls >= policy.max_tool_calls - 1)) {
        state.rejected_tool_calls++;
        if (outOfTime) state.deadline.refusals++;
        throw new Error(outOfTime
          ? `Time budget nearly spent: about ${Math.max(0, Math.round(left))} s remain. Only submit_result is permitted now. Submit what you have and set completion to partial with the remaining work.`
          : 'Finalization only: the remaining allowance is reserved for submit_result. Submit partial or blocked work honestly.');
      }
      assert(state.tool_calls < policy.max_tool_calls, 'Tool-call limit reached');
      state.tool_calls++;
      let value;
      try { value = await fn(args); }
      catch (e) {
        // An exact-match miss is an ordinary mistake; only a denied capability is a violation.
        const item = { tool: name, message: String(e.message).slice(0, 1000) };
        state.tool_errors.push(item);
        if (e.code === 'PI_POLICY') state.policy_violations.push(item);
        throw e;
      }
      if (left !== null && reserve > 0 && left <= 2 * reserve && value?.content?.[0]?.type === 'text') {
        state.deadline.warnings++;
        if (state.deadline.warnings === 1 && controls.onWarning) controls.onWarning(left);
        value.content[0].text += `\n\n[pi] About ${Math.max(0, Math.round(left))} s remain before the hard timeout. Call submit_result soon; in the last ${reserve} s no other tool is accepted.`;
      }
      return value;
    }
  });
  const authorized = fn => { try { return fn(); } catch (e) { e.code = 'PI_POLICY'; throw e; } };
  const requireRead = rel => authorized(() => { cleanRel(rel); assert(overlay.has(rel) && overlay.get(rel) !== null, `File not in readable snapshot: ${rel}`); return overlay.get(rel); });
  const requireWrite = rel => authorized(() => { checkRel(rel); assert(agent.mode === 'write' && writable.has(rel), `Write not authorized: ${rel}`); });
  const put = (rel, content) => {
    requireWrite(rel);
    assert(typeof content === 'string' && !content.includes('\0') && Buffer.byteLength(content) <= policy.max_file_bytes, 'Write must be bounded UTF-8 text');
    // Prevent invalid surrogate replacement from making manifest hashes ambiguous.
    assert(Buffer.from(content).toString('utf8') === content, 'Unpaired UTF-16 surrogate in content');
    let bytes = Buffer.byteLength(content);
    for (const [file, value] of overlay) if (file !== rel && value !== null) bytes += Buffer.byteLength(value);
    assert(bytes <= policy.max_context_bytes, 'Candidate exceeds total byte limit');
    overlay.set(rel, content);
    return response({ staged: rel, bytes: Buffer.byteLength(content), integrated: false });
  };
  const tools = [
    wrap('list_files', 'List files available in the isolated snapshot; no host filesystem access.', schema(), () => response([...overlay].filter(([, v]) => v !== null).map(([f]) => f))),
    wrap('read_file', 'Read numbered lines from one allowlisted snapshot file. Defaults: line 1, 200 lines. Max 400 lines/80000 characters.', schema({ path: string(1024), start_line: { type: 'integer', minimum: 1 }, line_count: { type: 'integer', minimum: 1, maximum: 400 } }, ['path']), a => {
      const data = requireRead(a.path).split('\n');
      const start = a.start_line ?? 1, count = a.line_count ?? 200;
      assert(Number.isInteger(start) && start > 0 && Number.isInteger(count) && count > 0 && count <= 400, 'Invalid line range');
      state.reads.push({ file: a.path, start_line: start, line_count: Math.min(count, Math.max(0, data.length - start + 1)) });
      return response({ path: a.path, total_lines: data.length, lines: data.slice(start - 1, start - 1 + count).map((x, i) => `${start + i}: ${x}`).join('\n').slice(0, 80000) });
    }),
    wrap('search_files', 'Literal substring search of accessible text files, not a regex or shell command; at most 100 hits.', schema({ query: string(1000) }), a => {
      text(a.query, 'query', 1000); state.searches.push({ query: a.query, files_searched: [...overlay].filter(([,v]) => v !== null).map(([f]) => f) }); const hits = [];
      for (const [file, value] of overlay) if (value !== null) {
        for (const [i, line] of value.split('\n').entries()) if (line.includes(a.query)) {
          hits.push({ file, line: i + 1, text: line.slice(0, 1000) });
          if (hits.length >= 100) return response({ hits, truncated: true });
        }
      }
      return response({ hits, truncated: false });
    })
  ];
  if (agent.mode === 'write') tools.push(
    wrap('write_file', 'Stage full candidate text in an explicitly authorized path. Never writes to the source repository.', schema({ path: string(1024), content: string(policy.max_file_bytes) }), a => put(a.path, a.content)),
    wrap('replace_text', 'Stage an exact single-match replacement in an authorized candidate file.', schema({ path: string(1024), old_text: string(policy.max_file_bytes), new_text: string(policy.max_file_bytes) }), a => {
      requireWrite(a.path); const value = requireRead(a.path);
      assert(typeof a.new_text === 'string', 'new_text must be a string');
      text(a.old_text, 'old_text', policy.max_file_bytes);
      const at = value.indexOf(a.old_text);
      assert(at >= 0 && value.indexOf(a.old_text, at + 1) < 0, 'old_text must match exactly once');
      return put(a.path, value.slice(0, at) + a.new_text + value.slice(at + a.old_text.length));
    }),
    wrap('delete_file', 'Stage deletion of an explicitly authorized candidate file; no source deletion.', schema({ path: string(1024) }), a => {
      requireWrite(a.path); requireRead(a.path); overlay.set(a.path, null); return response({ staged_deletion: a.path, integrated: false });
    })
  );
  tools.push(wrap('submit_result', `Submit the final evidence-based proposal to ${host} and finish. Set completion to complete, partial or blocked, and list remaining_work when unfinished. Tests are proposed, not executed. Do not rate your own usefulness.`, resultSchema, a => {
    // Findings for existing paths cite the original snapshot, even after editing/deletion.
    // Findings for newly created paths cite the candidate.
    const evidenceFiles = new Map([...overlay].map(([f, value]) => [f, initial.get(f) ?? value]));
    state.submitted = validateSubmission(a, evidenceFiles);
    return { ...response({ submitted: true, integration_authority: `${host} only` }), terminate: true };
  }));
  return { tools, state, initial, overlay,
    changes: () => [...overlay].filter(([file, content]) => content !== initial.get(file)).map(([file, content]) => ({ file, before: initial.get(file), after: content }))
  };
}
export function costSummary(requests) {
  let known = 0, estimated = 0, billed = 0, unresolved = 0, unpriced = 0, byok = 0;
  for (const r of requests) {
    if (isNumber(r.billed_usd)) { known += r.billed_usd; billed++; }
    else { unresolved++; if (isNumber(r.estimate_usd)) estimated += r.estimate_usd; else unpriced++; }
    if (r.is_byok && isNumber(r.upstream_inference_cost_usd)) byok += r.upstream_inference_cost_usd;
  }
  return {
    request_count: requests.length, reconciled_request_count: billed,
    provider_reported_usd: known,
    unresolved_request_count: unresolved, estimated_unreconciled_usd: estimated,
    unpriced_request_count: unpriced,
    all_requests_reconciled: unresolved === 0,
    provisional_budget_basis_usd: budgetBasis(requests),
    reported_byok_upstream_usd: byok,
    excludes: ['Host orchestration cost (Codex or Claude Code)', 'taxes and payment fees', 'unreported upstream/BYOK charges'],
    note: 'Do not add all Pi estimates to provider-reported charges. Reasoning is already included in output tokens. USD guards are soft between requests; in-flight calls can overshoot.'
  };
}

/** Conservative reservations include in-flight and unpriced attempts, never billed as actual spend. */
export function budgetBasis(requests) {
  return requests.reduce((sum, r) => sum + (isNumber(r.billed_usd) ? r.billed_usd :
    isNumber(r.estimate_usd) ? r.estimate_usd : isNumber(r.reserved_usd) ? r.reserved_usd : 0), 0);
}
export function reserveEstimate(model, inputBytes, maxOutputTokens) {
  // Byte count is deliberately conservative for text; this is not a tokenizer or billing guarantee.
  const inputRate = Math.max(model.cost.input, model.cost.cacheRead, model.cost.cacheWrite);
  return (inputBytes * inputRate + maxOutputTokens * model.cost.output) / 1e6;
}
