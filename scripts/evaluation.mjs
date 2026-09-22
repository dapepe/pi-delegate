/**
 * Task classification, optional run evaluation metadata, and artifact identity.
 *
 * This module is deliberately dependency-free.  Evaluation data describes the
 * host's task packet; it never grants a worker a file, tool, model, or budget.
 * The runner may expose a worker's criteria in its prompt, but stores the
 * complete host-authored evaluation in the plan and report.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const EVALUATION_SCHEMA_VERSION = 1;
export const ROLE_DEFAULT = 'sparring-partner';

export const TASK_TYPES = Object.freeze([
  'bugfix', 'feature', 'refactor', 'security', 'performance', 'testing',
  'documentation', 'architecture', 'design', 'planning', 'investigation',
  'migration', 'release', 'review'
]);

export const FOCUS_TAGS = Object.freeze([
  'correctness', 'completeness', 'security', 'maintainability', 'design', 'planning'
]);

export const STRATEGIES = Object.freeze([
  'single-review', 'parallel-independent', 'scout-then-candidate',
  'candidate-then-review', 'design-challenge', 'edge-case-review', 'sequence', 'bounded-loop'
]);

const MAX_FOCUS = 8;
const MAX_CRITERIA = 8;
const MAX_WORKERS = 32;
const MAX_MANIFEST_FILES = 4096;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;

function fail(message) { throw new Error(message); }
function assert(condition, message) { if (!condition) fail(message); }
function boundedString(value, label, max = 5000) {
  assert(typeof value === 'string' && value.trim().length > 0 && value.length <= max, `${label}: expected a nonempty string (max ${max} characters)`);
  assert(!value.includes('\0'), `${label}: NUL bytes are not allowed`);
  return value;
}
function slug(value, label, max = 96) {
  boundedString(value, label, max);
  assert(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(value), `${label} must be a lowercase portable identifier`);
  return value;
}
function relPath(value, label = 'scope') {
  boundedString(value, label, 2048);
  assert(value === '.' || (!path.posix.isAbsolute(value) && !value.includes('\\') &&
    !value.split('/').some(part => !part || part === '.' || part === '..') &&
    !/[\x00-\x1f\x7f:<>"|?*]/.test(value)), `${label} must be a safe relative project path`);
  return value;
}

function allowedObject(value, fields, label) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  for (const key of Object.keys(value)) assert(fields.has(key), `Unknown ${label} field: ${key}`);
}

function agentIdsOf(agentsOrPlan) {
  const agents = Array.isArray(agentsOrPlan) ? agentsOrPlan : agentsOrPlan?.agents;
  if (!agents) return null;
  assert(Array.isArray(agents), 'agents must be an array');
  return agents.map(agent => {
    assert(agent && typeof agent === 'object' && typeof agent.id === 'string', 'Each agent needs an id');
    return agent.id;
  });
}

/**
 * Validate the optional plan.evaluation block.  Passing a plan or its agents
 * as the second argument additionally checks that every worker assignment is
 * tied to exactly one authorized plan agent.
 */
export function validateEvaluation(input, agentsOrPlan = null) {
  assert(input && typeof input === 'object' && !Array.isArray(input), 'evaluation must be an object');
  allowedObject(input, new Set(['schema_version', 'task_id', 'task_type', 'scope', 'complexity', 'strategy', 'strategy_version', 'focus', 'workers']), 'evaluation');
  assert(input.schema_version === EVALUATION_SCHEMA_VERSION, `Unsupported evaluation schema_version: ${input.schema_version}`);
  slug(input.task_id, 'evaluation.task_id', 128);
  // The built-ins are suggestions for consistent host classification.  A
  // bounded custom slug remains valid so projects do not need a new release to
  // describe a genuinely different task class.
  slug(input.task_type, 'evaluation.task_type', 64);
  relPath(input.scope, 'evaluation.scope');
  assert(['bounded', 'complex'].includes(input.complexity), 'evaluation.complexity must be bounded or complex');
  assert(STRATEGIES.includes(input.strategy), `Unsupported evaluation.strategy: ${input.strategy}`);
  slug(input.strategy_version, 'evaluation.strategy_version', 64);

  assert(Array.isArray(input.focus) && input.focus.length <= MAX_FOCUS, 'evaluation.focus must be an array of at most 8 tags');
  const focus = new Set();
  for (const tag of input.focus) {
    slug(tag, 'evaluation.focus tag', 48);
    assert(!focus.has(tag), `Duplicate evaluation.focus tag: ${tag}`);
    focus.add(tag);
    assert(FOCUS_TAGS.includes(tag) || /^[a-z][a-z0-9-]{0,31}$/.test(tag), `Invalid evaluation.focus tag: ${tag}`);
  }

  assert(Array.isArray(input.workers) && input.workers.length > 0 && input.workers.length <= MAX_WORKERS, 'evaluation.workers must be a bounded nonempty array');
  const knownAgentIds = agentIdsOf(agentsOrPlan);
  const seenAgents = new Set(), seenAssignments = new Set();
  for (const worker of input.workers) {
    allowedObject(worker, new Set(['agent_id', 'assignment_id', 'attempt_index', 'criteria']), 'evaluation worker');
    slug(worker.agent_id, 'evaluation worker.agent_id', 64);
    slug(worker.assignment_id, 'evaluation worker.assignment_id', 128);
    assert(Number.isInteger(worker.attempt_index) && worker.attempt_index >= 1 && worker.attempt_index <= 999, 'evaluation worker.attempt_index must be an integer from 1 to 999');
    assert(Array.isArray(worker.criteria) && worker.criteria.length > 0 && worker.criteria.length <= MAX_CRITERIA, 'Each evaluation worker needs 1–8 criteria');
    assert(!seenAgents.has(worker.agent_id), `Duplicate evaluation worker: ${worker.agent_id}`);
    seenAgents.add(worker.agent_id);
    if (knownAgentIds) {
      assert(knownAgentIds.includes(worker.agent_id), `Evaluation references unknown agent: ${worker.agent_id}`);
    }
    const assignmentKey = `${worker.assignment_id}#${worker.attempt_index}`;
    assert(!seenAssignments.has(assignmentKey), `Duplicate evaluation assignment attempt: ${assignmentKey}`);
    seenAssignments.add(assignmentKey);
    const criteria = new Set();
    for (const criterion of worker.criteria) {
      allowedObject(criterion, new Set(['id', 'requirement']), 'evaluation criterion');
      slug(criterion.id, 'evaluation criterion.id', 48);
      assert(!criteria.has(criterion.id), `Duplicate evaluation criterion: ${criterion.id}`);
      criteria.add(criterion.id);
      boundedString(criterion.requirement, 'evaluation criterion.requirement', 1200);
    }
  }
  if (knownAgentIds) {
    assert(seenAgents.size === knownAgentIds.length, 'evaluation.workers must cover every plan agent exactly once');
  }
  return structuredClone(input);
}

/**
 * Classify a task before execution using explicit host input where available.
 * This is a deterministic aid for the host, never an inference call or a
 * substitute for an explicitly supplied evaluation block.
 */
export function classifyTask({ task_type, scope = '.', complexity = 'bounded', strategy = 'single-review', strategy_version = 'v1', focus = [] } = {}) {
  assert(task_type, 'Host task classification must supply task_type before execution');
  boundedString(task_type, 'task_type', 64);
  assert(['bounded', 'complex'].includes(complexity), 'complexity must be bounded or complex');
  relPath(scope, 'scope');
  assert(STRATEGIES.includes(strategy), `Unsupported strategy: ${strategy}`);
  slug(strategy_version, 'strategy_version', 64);
  assert(Array.isArray(focus), 'focus must be an array');
  const result = { task_type, scope, complexity, strategy, strategy_version, focus };
  // Reuse the strict metadata validator with one synthetic assignment.  This
  // function is a host-side classification check, not a keyword guesser.
  const checked = validateEvaluation({ schema_version: 1, task_id: 'classification', ...result, workers: [{ agent_id: 'classification-agent', assignment_id: 'classification', attempt_index: 1, criteria: [{ id: 'classified', requirement: 'The host supplied explicit task metadata.' }] }] });
  return { task_type: checked.task_type, scope: checked.scope, complexity: checked.complexity, strategy: checked.strategy, strategy_version: checked.strategy_version, focus: checked.focus };
}

/** Create a host-authored evaluation block from already classified metadata. */
export function createEvaluation({ task_id, task_type, scope = '.', complexity = 'bounded', strategy = 'single-review', strategy_version = 'v1', focus = [], workers = [] } = {}) {
  return validateEvaluation({ schema_version: EVALUATION_SCHEMA_VERSION, task_id, task_type, scope, complexity, strategy, strategy_version, focus, workers });
}

/** Render only the criteria assigned to one worker for inclusion in its prompt. */
export function evaluationCriteriaPrompt(evaluation, agentId) {
  if (!evaluation) return '';
  const checked = validateEvaluation(evaluation);
  const worker = checked.workers.find(item => item.agent_id === agentId);
  if (!worker) return '';
  const lines = [
    `Evaluation criteria for assignment ${worker.assignment_id} attempt ${worker.attempt_index}:`,
    ...worker.criteria.map((criterion, index) => `${index + 1}. [${criterion.id}] ${criterion.requirement}`),
    'Address each criterion in your submission evidence. Criteria are host requirements; they do not add permissions or tools.'
  ];
  return lines.join('\n');
}

// Stable JSON is used for artifact identities.  It is intentionally local to
// this module so persisted hashes never depend on object insertion order.
function canonical(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
    return value;
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return { type: 'bytes', sha256: sha256(value), bytes: value.byteLength };
  if (Array.isArray(value)) return value.map(canonical);
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function safeArtifactPath(value) {
  boundedString(value, 'artifact path', 2048);
  assert(!path.posix.isAbsolute(value) && !value.includes('\\') && !value.split('/').some(part => !part || part === '.' || part === '..'), `Unsafe artifact path: ${value}`);
  return value;
}
function hashBytes(value) {
  const bytes = Buffer.isBuffer(value) ? value : value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(String(value), 'utf8');
  assert(bytes.length <= MAX_ARTIFACT_BYTES, 'Artifact bytes exceed the bounded identity limit');
  return { sha256: sha256(bytes), bytes: bytes.length };
}
function manifestEntries(input) {
  if (input == null) return [];
  const values = input instanceof Map ? [...input.entries()].map(([file, content]) => ({ path: file, content })) : Array.isArray(input) ? input : Object.entries(input).map(([file, content]) => ({ path: file, content }));
  assert(values.length <= MAX_MANIFEST_FILES, 'Artifact manifest has too many files');
  const entries = values.map(entry => {
    const file = safeArtifactPath(entry.path ?? entry.file);
    const content = entry.content;
    let digest;
    if (entry.sha256 && entry.bytes !== undefined && content === undefined) {
      assert(/^[a-f0-9]{64}$/.test(entry.sha256), `Invalid artifact hash for ${file}`);
      assert(Number.isInteger(entry.bytes) && entry.bytes >= 0, `Invalid artifact size for ${file}`);
      digest = { sha256: entry.sha256, bytes: entry.bytes };
    } else digest = hashBytes(content ?? '');
    assert(entry.deleted === undefined || typeof entry.deleted === 'boolean', `Invalid deletion marker for ${file}`);
    return { path: file, ...digest, ...(entry.deleted ? { deleted: true } : {}) };
  }).sort((a, b) => a.path.localeCompare(b.path));
  for (let i = 1; i < entries.length; i++) assert(entries[i - 1].path !== entries[i].path, `Duplicate artifact path: ${entries[i].path}`);
  return entries;
}

/**
 * Compute separate identities for the original structured submission and the
 * candidate bytes.  The returned artifact_sha256 covers both identities and
 * the sorted manifest, so changing either side changes the final identity.
 */
export function computeArtifactIdentity({ submission = null, candidate = null, candidateBytes = null, manifest = null, snapshot = null } = {}) {
  const submissionSha = submission === null || submission === undefined ? null : sha256(JSON.stringify(canonical(submission)));
  const candidateInput = manifest ?? candidate ?? candidateBytes;
  const entries = manifestEntries(candidateInput);
  const candidateSha = entries.length || candidateInput !== null && candidateInput !== undefined
    ? sha256(JSON.stringify(entries)) : null;
  const snapshotValue = snapshot && typeof snapshot === 'object' && snapshot.files ? snapshot.files : snapshot;
  const snapshotSha = snapshotValue === null || snapshotValue === undefined ? null : sha256(JSON.stringify(canonical(snapshotValue)));
  const artifactSha = sha256(JSON.stringify({ schema_version: 1, submission_sha256: submissionSha, candidate_sha256: candidateSha, snapshot_sha256: snapshotSha, manifest: entries }));
  return { schema_version: 1, artifact_sha256: artifactSha, submission_sha256: submissionSha, candidate_sha256: candidateSha, snapshot_sha256: snapshotSha, manifest: entries };
}
export const artifactIdentity = computeArtifactIdentity;

/** Compare the host report's preregistered evaluation with the saved plan. */
export function evaluationsMatch(reportEvaluation, planEvaluation) {
  return JSON.stringify(canonical(reportEvaluation ?? null)) === JSON.stringify(canonical(planEvaluation ?? null));
}

function readRegularFile(filename, maxBytes) {
  assert(Number.isInteger(maxBytes) && maxBytes > 0 && maxBytes <= MAX_ARTIFACT_BYTES, 'Artifact read limit is outside the bounded identity limit');
  const stat = fs.lstatSync(filename);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, `Unsafe artifact file: ${filename}`);
  assert(stat.size <= maxBytes, `Artifact file exceeds ${maxBytes} bytes: ${filename}`);
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const current = fs.fstatSync(fd);
    assert(current.isFile() && current.nlink === 1 && current.size <= maxBytes, `Artifact file changed while reading: ${filename}`);
    const buffer = Buffer.alloc(maxBytes + 1); let length = 0, count;
    while (length < buffer.length && (count = fs.readSync(fd, buffer, length, buffer.length - length, null)) > 0) length += count;
    assert(length <= maxBytes, `Artifact file grew beyond ${maxBytes} bytes: ${filename}`);
    return buffer.subarray(0, length);
  } finally { fs.closeSync(fd); }
}
function secureChild(root, rel) {
  const rootStat = fs.lstatSync(root); assert(rootStat.isDirectory() && !rootStat.isSymbolicLink(), `Unsafe artifact directory: ${root}`);
  const parts = rel.split('/'); let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    assert(!stat.isSymbolicLink(), `Symlink in artifact path: ${rel}`);
  }
  return current;
}

/** Read the actual saved submission and only the authorized candidate files. */
export function readArtifactIdentity(runDir, agentId, { maxBytes = 8 * 1024 * 1024, plan = null, snapshot = null } = {}) {
  assert(path.isAbsolute(runDir), 'runDir must be an absolute path');
  slug(agentId, 'agent_id', 64);
  assert(Number.isInteger(maxBytes) && maxBytes > 0 && maxBytes <= MAX_ARTIFACT_BYTES, 'Artifact read limit is outside the bounded identity limit');
  const runStat = fs.lstatSync(runDir); assert(runStat.isDirectory() && !runStat.isSymbolicLink(), 'runDir must be a regular directory');
  const runRoot = fs.realpathSync(runDir);
  const worker = secureChild(runRoot, agentId);
  const resultFile = path.join(worker, 'result.json');
  assert(fs.existsSync(resultFile), `Missing worker result: ${agentId}`);
  const result = JSON.parse(readRegularFile(resultFile, maxBytes).toString('utf8'));
  if (!plan) {
    const planFile = secureChild(runRoot, 'plan.json');
    plan = JSON.parse(readRegularFile(planFile, maxBytes).toString('utf8'));
  }
  const authorized = plan?.agents?.find(item => item.id === agentId)?.write_files || [];
  assert(Array.isArray(authorized) && authorized.length <= 256, 'Saved plan write_files are not bounded');
  for (const rel of authorized) safeArtifactPath(rel);
  const changes = Array.isArray(result.changes) ? result.changes : [];
  const changeByPath = new Map();
  for (const change of changes) {
    assert(change && typeof change === 'object' && !changeByPath.has(change.file), 'Duplicate candidate change entry');
    safeArtifactPath(change.file);
    assert(['add', 'modify', 'delete'].includes(change.action), `Invalid candidate change action: ${change.action}`);
    assert(change.before_sha256 === null || /^[a-f0-9]{64}$/.test(change.before_sha256), 'Invalid candidate before hash');
    assert(change.after_sha256 === null || /^[a-f0-9]{64}$/.test(change.after_sha256), 'Invalid candidate after hash');
    if (change.action === 'add') assert(change.before_sha256 === null && change.after_sha256 !== null, 'Invalid add change hashes');
    if (change.action === 'modify') assert(change.before_sha256 !== null && change.after_sha256 !== null, 'Invalid modify change hashes');
    if (change.action === 'delete') assert(change.after_sha256 === null && change.before_sha256 !== null, 'Invalid delete change hashes');
    changeByPath.set(change.file, change);
  }
  const manifest = [];
  let totalBytes = 0;
  let snapshotValue = snapshot;
  if (snapshotValue === null) {
    const snapshotFile = path.join(runRoot, 'snapshot.json');
    if (fs.existsSync(snapshotFile)) snapshotValue = JSON.parse(readRegularFile(snapshotFile, maxBytes).toString('utf8')).files || null;
  }
  const snapshotFiles = snapshotValue?.files || snapshotValue;
  const candidateRoot = fs.existsSync(path.join(worker, 'candidate')) ? secureChild(worker, 'candidate') : null;
  // Stat every authorized candidate first, so a set of large files cannot make
  // the bounded read budget fail only after several reads have happened.
  const candidateSizes = new Map();
  for (const rel of authorized) {
    const change = changeByPath.get(rel); if (change?.action === 'delete' || !candidateRoot) continue;
    const filename = path.join(candidateRoot, ...rel.split('/'));
    if (!fs.existsSync(filename)) continue;
    const stat = fs.lstatSync(filename); assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, `Unsafe candidate file: ${rel}`);
    assert(stat.size <= maxBytes, `Candidate file exceeds ${maxBytes} bytes: ${rel}`);
    totalBytes += stat.size; assert(totalBytes <= MAX_ARTIFACT_BYTES, 'Candidate artifact bytes exceed the bounded identity limit');
    candidateSizes.set(rel, stat.size);
  }
  totalBytes = 0;
  for (const rel of authorized) {
    const change = changeByPath.get(rel);
    if (change?.action === 'delete') {
      const before = snapshotFiles?.[rel];
      assert(before && typeof before === 'object' && before.sha256 === change.before_sha256 && Number.isInteger(before.bytes) && before.bytes >= 0, `Deleted candidate does not match snapshot: ${rel}`);
      manifest.push({ path: rel, sha256: change.before_sha256, bytes: before.bytes, deleted: true });
      continue;
    }
    const filename = candidateRoot ? path.join(candidateRoot, ...rel.split('/')) : null;
    if (!filename || !fs.existsSync(filename)) {
      assert(!change || change.action === 'delete' || change.after_sha256 === null, `Missing saved candidate bytes: ${rel}`);
      continue;
    }
    const data = readRegularFile(secureChild(candidateRoot, rel), maxBytes);
    totalBytes += data.length;
    assert(candidateSizes.get(rel) === data.length, `Candidate file changed while hashing: ${rel}`);
    if (change) assert(sha256(data) === change.after_sha256, `Candidate bytes do not match saved change hash: ${rel}`);
    manifest.push({ path: rel, content: data });
  }
  // A candidate change outside the exact plan grant is invalid evidence rather
  // than an invitation to scan or hash arbitrary run-directory content.
  for (const change of changes) assert(authorized.includes(change.file), `Candidate change is outside authorized write_files: ${change.file}`);
  return computeArtifactIdentity({ submission: result.submission ?? null, manifest, snapshot: snapshotValue });
}
export const artifactIdentityFromRun = readArtifactIdentity;
