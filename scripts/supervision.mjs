/** Host-native supervisor receipts. Native spawn/wait tools belong to the host, not Node. */
import fs from 'node:fs';
import path from 'node:path';
import { assert, text, inside, sha256, validatePlan, captureSnapshot, manifestOf } from './lib.mjs';
import { readArtifactIdentity } from './evaluation.mjs';
import { readLocal, writeLocal, localPath, bytesHash, jsonText } from './project-files.mjs';

const defaults = JSON.parse(fs.readFileSync(new URL('../defaults.json', import.meta.url), 'utf8'));
const read = (root, rel) => { const raw = readLocal(root, rel); assert(raw !== null, `Missing supervision artifact: ${rel}`); return JSON.parse(raw); };
const agentId = value => { text(value, 'native agent ID', 200); assert(/^[a-zA-Z0-9_./:-]+$/.test(value), 'Invalid native agent ID'); return value; };

function open(directory) {
  const target = path.resolve(directory);
  assert(fs.lstatSync(target).isDirectory() && !fs.lstatSync(target).isSymbolicLink(), 'Supervision output must be a regular directory');
  const root = fs.realpathSync(target), contract = read(root, 'supervision.json'), state = read(root, 'supervision-state.json');
  assert(contract.schema_version === 1 && state.schema_version === 1, 'Unsupported supervision schema');
  const planRaw = readLocal(root, 'approved-plan.json');
  assert(planRaw !== null && sha256(planRaw) === contract.plan_sha256, 'Approved supervision plan changed; return to the primary host');
  assert(state.contract_sha256 === sha256(jsonText(contract)), 'Supervision contract changed');
  assert(!inside(contract.repo_root, root), 'Supervision artifacts must remain outside the source repository');
  return { root, contract, state, plan: JSON.parse(planRaw) };
}
function save(ctx) {
  const raw = readLocal(ctx.root, 'supervision-state.json');
  writeLocal(ctx.root, 'supervision-state.json', jsonText(ctx.state), bytesHash(raw));
}
async function locked(directory, fn) {
  const ctx = open(directory), lock = localPath(ctx.root, 'supervision.lock');
  try { fs.mkdirSync(lock, { mode: 0o700 }); }
  catch (e) { if (e.code === 'EEXIST') throw new Error('Supervisor operation is already running; inspect the native task and process handles before recovery'); throw e; }
  let result;
  try { result = await fn(open(directory)); }
  catch (error) {
    try { fs.rmdirSync(lock); } catch { error.supervision_lock_warning = 'supervision_lock_cleanup_failed'; }
    throw error;
  }
  try { fs.rmdirSync(lock); }
  catch { return { ...result, supervision_warning: 'supervision_lock_cleanup_failed' }; }
  return result;
}

export function initSupervision(input, directory, nativeAgentId) {
  const plan = validatePlan(input, defaults), target = path.resolve(directory);
  agentId(nativeAgentId);
  assert(!inside(plan.repo_root, target), 'Supervision output must be outside the source repository');
  assert(!fs.existsSync(target), 'Supervision output already exists; never overwrite or restart it');
  // Resolve the nearest existing parent before mkdir: /tmp aliases or a linked
  // ancestor must not create even empty directories inside the task checkout.
  let ancestor = path.dirname(target);
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const canonicalTarget = path.resolve(fs.realpathSync(ancestor), path.relative(ancestor, target));
  assert(!inside(plan.repo_root, canonicalTarget), 'Supervision parent resolves inside the source repository');
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  assert(!inside(plan.repo_root, fs.realpathSync(path.dirname(target))), 'Supervision parent resolves inside the source repository');
  const snapshot = manifestOf(captureSnapshot(plan));
  fs.mkdirSync(target, { mode: 0o700 });
  const root = fs.realpathSync(target), planText = jsonText(plan);
  const contract = { schema_version: 1, orchestrator: plan.orchestrator, native_agent_id: nativeAgentId,
    repo_root: plan.repo_root, plan_sha256: sha256(planText), snapshot_sha256: sha256(jsonText(snapshot)),
    registered_at: new Date().toISOString(),
    provenance: 'Host-attested ID from an actual native spawn result; this CLI cannot independently authenticate native agents.',
    authority: 'Execution and advisory review only. The primary host retains permissions, integration, final validation, assessment and learning.' };
  const state = { schema_version: 1, contract_sha256: sha256(jsonText(contract)), status: 'registered', review: null, incident: null };
  writeLocal(root, 'approved-plan.json', planText, null);
  writeLocal(root, 'supervision.json', jsonText(contract), null);
  writeLocal(root, 'supervision-state.json', jsonText(state), null);
  return { out: root, ...contract, status: state.status, run: path.join(root, 'run') };
}

async function incident(ctx, phase, failureCode) {
  try {
    const { tryWriteIncident } = await import('./incidents.mjs');
    const run = localPath(ctx.root, 'run');
    const directory = fs.existsSync(run) ? run : ctx.root;
    return tryWriteIncident(directory, { phase, failure_code: failureCode });
  } catch { return { status: 'unavailable', code: 'incident_write_failed' }; }
}

export async function runSupervision(directory, dependencies = {}) {
  return locked(directory, async ctx => {
    assert(ctx.state.status === 'registered', 'This supervised plan has already started; never start a duplicate worker');
    ctx.state.status = 'running'; ctx.state.started_at = new Date().toISOString(); save(ctx);
    let result;
    try {
      const execute = dependencies.executeJob || (await import('./pi.mjs')).executeJob;
      result = await execute(ctx.plan, path.join(ctx.root, 'run'), { ...dependencies,
        validateSnapshot: (_plan, snapshot) => assert(sha256(jsonText(snapshot)) === ctx.contract.snapshot_sha256, 'Source snapshot changed since the primary host registered the plan') });
    } catch (e) {
      ctx.state.status = 'failed'; ctx.state.finished_at = new Date().toISOString();
      ctx.state.incident = await incident(ctx, 'supervision', 'supervision_failed');
      try { save(ctx); } catch { e.supervision_persistence_error = 'supervision_state_write_failed'; }
      // Preserve the original error and expose the durable incident location to callers.
      e.supervision_directory = ctx.root; e.incident = ctx.state.incident; throw e;
    }
    ctx.state.status = 'awaiting_review'; ctx.state.finished_at = new Date().toISOString();
    if (result.report.agents.some(a => a.status !== 'completed')) ctx.state.incident = await incident(ctx, 'execution', 'worker_incomplete');
    let persistenceError = null;
    try { save(ctx); } catch { persistenceError = 'supervision_state_write_failed'; }
    return { out: ctx.root, run: result.out, native_agent_id: ctx.contract.native_agent_id,
      status: persistenceError ? 'review_persistence_failed' : ctx.state.status, persistence_error: persistenceError,
      agents: result.report.agents.map(a => ({ id: a.id, status: a.status })), costs: result.report.costs, incident: ctx.state.incident };
  });
}

export function inspectSupervision(directory) {
  const ctx = open(directory), run = localPath(ctx.root, 'run');
  const artifacts = {};
  for (const rel of ['plan.json', 'snapshot.json', 'report.json', 'usage.json']) {
    const raw = readLocal(ctx.root, `run/${rel}`);
    artifacts[rel] = raw === null ? null : sha256(raw);
  }
  const workers = [];
  if (artifacts['report.json']) {
    const report = read(run, 'report.json'), plan = read(run, 'plan.json'), snapshot = read(run, 'snapshot.json');
    assert(sha256(jsonText(plan)) === ctx.contract.plan_sha256, 'Executed plan differs from the approved supervision plan');
    assert(report.orchestrator === ctx.contract.orchestrator, 'Run host differs from supervision contract');
    assert(snapshot.repo_root === ctx.contract.repo_root && report.source_repo === ctx.contract.repo_root, 'Run source differs from supervision contract');
    assert(sha256(jsonText(snapshot.files)) === ctx.contract.snapshot_sha256, 'Run snapshot differs from the approved supervision snapshot');
    for (const spec of ctx.plan.agents) {
      const result = readLocal(run, `${spec.id}/result.json`);
      const identity = result === null ? null : readArtifactIdentity(run, spec.id, { plan, snapshot }).artifact_sha256;
      artifacts[`${spec.id}/result.json`] = result === null ? null : sha256(result);
      artifacts[`${spec.id}/candidate`] = identity;
      const worker = report.agents.find(a => a.id === spec.id);
      workers.push({ id: spec.id, status: worker?.status ?? 'unknown', model: worker?.model ?? null,
        artifact_sha256: identity, changes: worker?.changes ?? [], submission: worker?.submission ?? null });
    }
  }
  const fingerprint = sha256(jsonText({ contract: ctx.state.contract_sha256, artifacts }));
  return { out: ctx.root, run, native_agent_id: ctx.contract.native_agent_id, status: ctx.state.status,
    artifact_fingerprint: fingerprint, artifacts, workers, review: ctx.state.review,
    review_current: ctx.state.review ? ctx.state.review.artifact_fingerprint === fingerprint : null, incident: ctx.state.incident,
    note: 'Inspect original files and candidate bytes. Fingerprints bind a review to artifacts; they do not prove correctness or that a native agent exists.' };
}

export async function reviewSupervision(directory, review) {
  return locked(directory, async ctx => {
    assert(['awaiting_review', 'failed'].includes(ctx.state.status), 'Wait for the supervised process to settle before reviewing; recover interrupted runs with incident --out');
    assert(review && typeof review === 'object' && !Array.isArray(review), 'Supervisor review must be an object');
    for (const key of Object.keys(review)) assert(['native_agent_id', 'artifact_fingerprint', 'verdict', 'workers', 'summary'].includes(key), `Unknown supervisor review field: ${key}`);
    assert(review.native_agent_id === ctx.contract.native_agent_id, 'Review must identify the registered native supervisor');
    const inspected = inspectSupervision(ctx.root);
    assert(review.artifact_fingerprint === inspected.artifact_fingerprint, 'Artifacts changed since supervisor inspection');
    assert(['ready_for_host', 'needs_work', 'blocked'].includes(review.verdict), 'Review verdict must be ready_for_host, needs_work or blocked');
    text(review.summary, 'review.summary', 4000);
    assert(Array.isArray(review.workers) && review.workers.length === ctx.plan.agents.length, 'Review must cover every assigned Pi worker, including failures');
    const seen = new Set();
    for (const row of review.workers) {
      assert(row && Object.keys(row).every(k => ['id', 'evidence', 'concerns'].includes(k)), 'Invalid supervisor worker review fields');
      assert(ctx.plan.agents.some(a => a.id === row.id) && !seen.has(row.id), 'Unknown or duplicate reviewed worker'); seen.add(row.id);
      for (const key of ['evidence', 'concerns']) {
        assert(Array.isArray(row[key]) && row[key].length <= 8 && (key !== 'evidence' || row[key].length > 0), `review.workers.${key} must have ${key === 'evidence' ? '1' : '0'}–8 entries`);
        row[key].forEach(value => text(value, `review.workers.${key}`, 1500));
      }
    }
    const receipt = { ...review, reviewed_at: new Date().toISOString(), authority: 'Advisory native-supervisor review. Primary host validation and integration are still required.' };
    writeLocal(ctx.root, 'supervisor-review.json', jsonText(receipt), null);
    ctx.state.status = 'reviewed'; ctx.state.review = { verdict: review.verdict, artifact_fingerprint: review.artifact_fingerprint, file: 'supervisor-review.json' }; save(ctx);
    return { out: ctx.root, ...ctx.state };
  });
}

export async function supervisionMain(argv) {
  const command = argv[0] || 'help', options = {};
  const allowed = { init: ['plan', 'out', 'agent-id'], run: ['out'], inspect: ['out'], review: ['out', 'review'], help: [] };
  assert(Object.hasOwn(allowed, command), `Unknown supervise command: ${command}`);
  for (let i = 1; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    assert(argv[i].startsWith('--') && allowed[command].includes(key) && !Object.hasOwn(options, key), `Unknown or duplicate option: ${argv[i]}`);
    assert(argv[i + 1] && !argv[i + 1].startsWith('--'), `Missing value for ${argv[i]}`); options[key] = argv[i + 1];
  }
  if (command === 'help') return 'pi supervise\n  init --plan PLAN.json --out NEW_PRIVATE_DIRECTORY --agent-id ACTUAL_NATIVE_ID\n  run --out SUPERVISION_DIRECTORY\n  inspect --out SUPERVISION_DIRECTORY\n  review --out SUPERVISION_DIRECTORY --review REVIEW.json\nOnly run performs inference. The primary host must first spawn a real native sub-agent and register its returned ID. The CLI cannot create or authenticate native agents.';
  assert(options.out, '--out is required');
  const input = file => { assert(file, 'Required JSON file is missing'); return read(path.dirname(path.resolve(file)), path.basename(file)); };
  if (command === 'init') return initSupervision(input(options.plan), options.out, options['agent-id']);
  if (command === 'inspect') return inspectSupervision(options.out);
  if (command === 'review') return reviewSupervision(options.out, input(options.review));
  const result = await runSupervision(options.out, { onProgress: event => console.error(JSON.stringify(event)) });
  if (result.persistence_error || result.supervision_warning || result.agents.some(a => a.status !== 'completed')) process.exitCode = 2;
  return result;
}
