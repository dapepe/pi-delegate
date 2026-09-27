/** Explicit host-side preferences setup. No inference, credential reads, environment edits or automatic run defaults. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { TextDecoder } from 'node:util';
import { assert, mergePolicy, validatePlan, sha256, inside } from './lib.mjs';
import { isCompatibleProvider } from './compatible.mjs';

const DEFAULTS = JSON.parse(fs.readFileSync(new URL('../defaults.json', import.meta.url), 'utf8'));
export const DEFAULT_POLICY_FILE = path.join(os.homedir(), '.config', 'pi', 'policy.json');
const MAX_BYTES = 1024 * 1024;
const decoder = new TextDecoder('utf8', { fatal: true });
const json = value => JSON.stringify(value, null, 2) + '\n';
const READINESS_NOTE = 'Local policy validation only. Credentials, installed model catalogs, endpoint access, capabilities, pricing and live inference have not been checked. Saved preferences do not authorize a task or change raw run behavior.';
const SECRET_PATTERN = /\b(?:sk-(?:or-v1-)?[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{25,}|AKIA[A-Z0-9]{16})\b/;
const RESERVED_FILES = new Set(['credentials.json', 'auth.json', 'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'defaults.json', 'settings.json', 'config.json', 'report.json', 'usage.json', 'snapshot.json', 'assessment.json', 'result.json', 'history.json', 'proposal.json', 'workflow.json', 'supervision.json']);
function allowedFile(filename, { output = false, plan = false } = {}) {
  assert(typeof filename === 'string', 'Expected a setup JSON file path');
  const absolute = path.resolve(filename), name = path.basename(absolute).toLowerCase();
  assert(name.endsWith('.json'), 'Setup policy and plan files must use the .json extension');
  assert(!(output ? RESERVED_FILES.has(name) : ['credentials.json', 'auth.json'].includes(name)), 'Setup cannot read credential files or replace package, instruction or runtime-state files');
  const parts = absolute.split(path.sep).map(part => part.toLowerCase());
  assert(!parts.some(part => ['.git', '.ssh', '.aws', '.azure', '.gnupg', '.agents', '.codex', '.claude', 'node_modules', 'secrets'].includes(part)) && !parts.some((part, index) => part === '.pi' && ['learning', 'insights'].includes(parts[index + 1])), 'Setup paths must not target agent instructions, credentials or runtime state');
  if (output && !plan) assert(!['plan.json', 'job.json'].includes(name), 'Save a reusable policy to a policy filename, not a task-plan filename');
  return absolute;
}

// Refuse user-created links in any component. macOS's fixed /tmp and /var OS aliases
// are resolved once so its normal temporary directory remains usable in offline tests.
function safePath(filename) {
  assert(typeof filename === 'string' && filename.length > 0 && filename.length <= 4096 && !/[\x00-\x1f\x7f]/.test(filename), 'Expected a bounded file path');
  const absolute = path.resolve(filename), parsed = path.parse(absolute);
  let current = parsed.root;
  const parts = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (stat.isSymbolicLink()) {
      const osAlias = process.platform === 'darwin' && index === 0 && ['tmp', 'var', 'etc'].includes(part) && fs.realpathSync(current) === `/private/${part}`;
      assert(osAlias, 'Refusing a symbolic link in the setup path');
      current = fs.realpathSync(current); stat = fs.lstatSync(current);
    }
    if (index < parts.length - 1) assert(stat.isDirectory(), 'Setup file parent is not a directory');
    else { assert(stat.isFile(), 'Setup path is not a regular file'); assert(stat.nlink === 1, 'Refusing a hardlinked setup file'); }
  }
  return current;
}

function readFile(filename, optional = false) {
  const file = safePath(allowedFile(filename));
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); }
  catch (error) { if (optional && error.code === 'ENOENT') return { file, raw: null, sha256: null }; throw error; }
  try {
    const stat = fs.fstatSync(fd);
    assert(stat.isFile() && stat.nlink === 1 && stat.size <= MAX_BYTES, 'Setup input must be a bounded regular file without hardlinks');
    const buffer = Buffer.alloc(MAX_BYTES + 1); let length = 0, n;
    while (length < buffer.length && (n = fs.readSync(fd, buffer, length, buffer.length - length, null)) > 0) length += n;
    const bytes = buffer.subarray(0, length);
    assert(length <= MAX_BYTES && !bytes.includes(0), 'Setup input is oversized or binary');
    return { file, raw: decoder.decode(bytes), sha256: sha256(bytes) };
  } finally { fs.closeSync(fd); }
}

function parsePolicy(raw) {
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error('Policy input must be valid JSON; input contents were not printed'); }
  assert(value && typeof value === 'object' && !Array.isArray(value), 'Policy must be a plain JSON object');
  // Policy already forbids credential fields; reject common embedded credential strings
  // too, without echoing their values. This is not a general-purpose secret detector.
  const visit = (item, depth = 0) => {
    assert(depth <= 16, 'Policy nesting is too deep');
    if (typeof item === 'string') assert(!SECRET_PATTERN.test(item), 'Policy contains a possible raw credential; use an environment variable reference');
    else if (item && typeof item === 'object') for (const [key, child] of Object.entries(item)) {
      assert(!/^(?:api[_-]?key|access[_-]?token|authorization|password|credential[s]?|secret|token)$/i.test(key), 'Policy must not contain raw credential fields; use an environment variable reference');
      assert(!SECRET_PATTERN.test(key), 'Policy contains a possible raw credential field name');
      visit(child, depth + 1);
    }
  };
  visit(value);
  assert(!value.preferred_provider || value.preferred_provider === DEFAULTS.preferred_provider || Object.hasOwn(value, 'preferred_models'), 'A changed preferred_provider requires an explicit preferred_models list');
  const effective = mergePolicy(DEFAULTS, value);
  if (isCompatibleProvider(effective, effective.preferred_provider)) {
    const models = effective.openai_compatible_providers[effective.preferred_provider].models;
    assert(effective.preferred_models.every(model => Object.hasOwn(models, model)), 'Every preferred compatible model must have an exact approved declaration');
  }
  return { policy: value, effective_policy: effective };
}

function summary(policy) {
  return {
    preferred_provider: policy.preferred_provider, preferred_models: policy.preferred_models,
    default_effort: policy.default_effort, complex_effort: policy.complex_effort, effort_policy: policy.effort_policy,
    allow_model_exceptions: policy.allow_model_exceptions,
    limits: Object.fromEntries(['max_agents', 'max_parallel', 'max_turns', 'max_tool_calls', 'timeout_seconds', 'request_timeout_seconds', 'max_output_tokens', 'max_context_bytes', 'per_agent_budget_usd', 'session_budget_usd'].map(key => [key, policy[key]])),
    compatible_routes: Object.entries(policy.openai_compatible_providers).map(([provider, route]) => ({ provider, base_url: route.base_url, allow_insecure_http: route.allow_insecure_http === true, auth: route.auth,
      models: Object.entries(route.models).map(([id, model]) => ({ id, supported_efforts: model.supported_efforts, context_window: model.context_window, declared_max_output_tokens: model.max_output_tokens, effective_output_ceiling: Math.min(policy.max_output_tokens, model.max_output_tokens), ...(model.supported_efforts.includes('off') ? { required_worker_effort: 'off' } : {}) })), capability_status: 'declared_not_probed' })),
    credentials_status: 'not_checked'
  };
}

export function showSetup(config = DEFAULT_POLICY_FILE) {
  const read = readFile(config, true);
  const parsed = read.raw === null ? { policy: null, effective_policy: mergePolicy(DEFAULTS) } : parsePolicy(read.raw);
  return { configured: read.raw !== null, file: read.file, sha256: read.sha256, ...parsed, summary: summary(parsed.effective_policy), note: READINESS_NOTE };
}

export function checkSetup(config) {
  const read = readFile(config), parsed = parsePolicy(read.raw);
  return { valid: true, file: read.file, sha256: read.sha256, explicit_keys: Object.keys(parsed.policy).sort(), ...parsed, summary: summary(parsed.effective_policy), note: READINESS_NOTE };
}

function writePrivate(filename, contents, expectedHash, { privateParent = false, plan = false, outsideRepo = null } = {}) {
  assert(Buffer.byteLength(contents) <= MAX_BYTES, 'Setup output exceeds its byte limit');
  let file = safePath(allowedFile(filename, { output: true, plan })), parent = path.dirname(file);
  if (outsideRepo) assert(!inside(outsideRepo, file), 'Compiled task plans must remain outside the task repository');
  // Recursive creation only affects missing directories, never permissions on existing ones.
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  file = safePath(file); parent = path.dirname(file);
  if (outsideRepo) assert(!inside(outsideRepo, file), 'Compiled task plan output resolves inside the task repository');
  if (privateParent && process.platform !== 'win32') {
    const stat = fs.statSync(parent);
    assert((stat.mode & 0o077) === 0 && (!process.getuid || stat.uid === process.getuid()), 'Reusable policy needs an existing owner-only parent directory or a new private directory; setup will not chmod a shared directory');
  }
  // Serialize cooperating setup writers across the hash check and publication.
  // Never infer that an existing lock is stale or remove another writer's lock.
  const lock = `${file}.setup.lock`;
  let lockFd;
  try { lockFd = fs.openSync(lock, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Setup output is locked; inspect the active writer or interrupted write before retrying');
    throw error;
  }
  const lockIdentity = fs.fstatSync(lockFd);
  let primaryError;
  try {
    fs.writeFileSync(lockFd, json({ schema_version: 1, pid: process.pid, created_at: new Date().toISOString() }));
    const previous = readFile(file, true);
    assert(previous.sha256 === expectedHash, expectedHash === null ? 'Output already exists; show its SHA-256 and explicitly provide --replace-sha for a policy replacement' : 'Existing policy hash changed; review it again before replacement');
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, contents, { flag: 'wx', mode: 0o600 });
    try {
      assert(readFile(file, true).sha256 === expectedHash, 'Concurrent setup output change; review before retrying');
      if (expectedHash === null) fs.linkSync(temporary, file);
      else fs.renameSync(temporary, file);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    return { file, sha256: sha256(contents), replaced: previous.raw !== null,
      permissions: process.platform === 'win32' ? 'File mode requested; verify private Windows directory ACLs separately' : '0600 file; newly created directories 0700' };
  } catch (error) { primaryError = error; throw error; }
  finally {
    let cleanupError;
    try { fs.closeSync(lockFd); } catch (error) { cleanupError = error; }
    try {
      const current = fs.lstatSync(lock);
      assert(current.isFile() && current.dev === lockIdentity.dev && current.ino === lockIdentity.ino, 'Setup write lock changed during publication');
      fs.unlinkSync(lock);
    } catch (error) { cleanupError = error; }
    if (cleanupError && !primaryError) throw new Error('Setup output may have been saved but write lock cleanup failed; inspect it before retrying');
  }
}

export function saveSetup(config, out = DEFAULT_POLICY_FILE, replaceSha = null) {
  assert(replaceSha === null || /^[a-f0-9]{64}$/.test(replaceSha), '--replace-sha must be the exact SHA-256 from setup show');
  const checked = checkSetup(config);
  const saved = writePrivate(out, json(checked.policy), replaceSha, { privateParent: true });
  return { saved: true, ...saved, source_file: checked.file, explicit_keys: checked.explicit_keys, summary: checked.summary, note: READINESS_NOTE };
}

export function compileSetupPlan(config, input, out) {
  const checked = checkSetup(config), source = readFile(input);
  let plan;
  try { plan = JSON.parse(source.raw); } catch { throw new Error('Task plan must be valid JSON; input contents were not printed'); }
  assert(plan && typeof plan === 'object' && !Array.isArray(plan), 'Task plan must be an object');
  const overrides = plan.policy === undefined ? {} : plan.policy;
  // Validate policy data independently before any output. Per-plan overrides deliberately
  // win; the host must encode applicable project/user constraints before compiling.
  const merged = mergePolicy(checked.effective_policy, overrides);
  parsePolicy(json(merged));
  assert(plan.policy_sources === undefined || Array.isArray(plan.policy_sources), 'policy_sources must be an array');
  const compiled = validatePlan({ ...plan, policy: merged, policy_sources: [...new Set([...(plan.policy_sources || []), checked.file])] }, DEFAULTS);
  const written = writePrivate(out, json(compiled), null, { plan: true, outsideRepo: compiled.repo_root });
  return { compiled: true, ...written, input_plan: source.file, config_file: checked.file, config_sha256: checked.sha256,
    override_keys: Object.keys(overrides).sort(), overrides, policy_sources: compiled.policy_sources, summary: summary(compiled.policy),
    note: 'The new plan contains the effective policy explicitly. Review file grants, endpoints, worker models, effort and limits under current user/project instructions before the usual check and host-native supervised run. No snapshot or inference was performed.' };
}

export function setupMain(argv = []) {
  const command = argv[0] || 'show', options = {};
  const allowed = { show: ['config'], check: ['config'], save: ['config', 'out', 'replace-sha'], plan: ['config', 'plan', 'out'] };
  if (command === 'help') {
    assert(argv.length === 1, 'setup help takes no options');
    return { usage: ['setup show [--config FILE]', 'setup check --config FILE', 'setup save --config FILE [--out FILE] [--replace-sha HASH]', 'setup plan --config FILE --plan INPUT --out NEW_PLAN'], default_policy_file: DEFAULT_POLICY_FILE, note: READINESS_NOTE };
  }
  assert(Object.hasOwn(allowed, command), 'Unknown setup command; use setup help');
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    assert(flag.startsWith('--') && allowed[command].includes(flag.slice(2)), `Unsupported setup ${command} option`);
    const key = flag.slice(2), value = argv[index + 1];
    assert(value && !value.startsWith('--') && !Object.hasOwn(options, key), 'Setup options need one value and cannot be repeated');
    options[key] = value;
  }
  if (command === 'show') return showSetup(options.config);
  assert(options.config, '--config is required');
  if (command === 'check') return checkSetup(options.config);
  if (command === 'save') return saveSetup(options.config, options.out, options['replace-sha']);
  assert(options.plan && options.out, 'setup plan requires --plan and --out');
  return compileSetupPlan(options.config, options.plan, options.out);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(setupMain(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
