/** Host-present, opt-in Durable sessions. Local inspection never starts a scheduler. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { assert, inside, sha256, validatePlan, captureSnapshot, manifestOf, workerPolicy, budgetBasis, costSummary } from './lib.mjs';
import { initSupervision } from './supervision.mjs';
import { readLocal, writeLocal, jsonText, bytesHash } from './project-files.mjs';
import { tryWriteIncident } from './incidents.mjs';
import { mergeDurableLedger } from './runtime.mjs';
const defaults = JSON.parse(fs.readFileSync(new URL('../defaults.json', import.meta.url)));
const hash = value => sha256(jsonText(value));
export function durableModelIdentity(resolved) {
  const { checked_at: _observationTimestamp, ...metadata } = resolved.metadata;
  const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
  return hash(stable({ model: resolved.model, metadata }));
}
const read = (root, file) => { const value = readLocal(root, file); assert(value !== null, `Missing Durable artifact: ${file}`); return JSON.parse(value); };
function privateTree(root) {
  assert(process.platform !== 'win32', 'This experimental Durable backend requires POSIX private file modes');
  const files = [];
  function visit(directory, relative = '') {
    const stat = fs.lstatSync(directory);
    assert(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0 && stat.uid === process.getuid(), 'Durable storage must be an owned private directory without links');
    for (const entry of fs.readdirSync(directory).sort()) {
      const rel = relative ? `${relative}/${entry}` : entry, filename = path.join(root, rel), info = fs.lstatSync(filename);
      assert(!info.isSymbolicLink(), 'Linked Durable artifacts are forbidden');
      if (info.isDirectory()) visit(filename, rel);
      else {
        assert(info.isFile() && info.nlink === 1 && (info.mode & 0o077) === 0 && info.uid === process.getuid(), 'Durable artifacts must be private owned regular files without hard links');
        files.push({ path: rel, sha256: sha256(fs.readFileSync(filename)) });
      }
    }
  }
  visit(root); return files;
}
function open(directory) {
  const target = path.resolve(directory);
  assert(fs.existsSync(target) && !fs.lstatSync(target).isSymbolicLink(), 'Durable session directory is missing or linked');
  const root = fs.realpathSync(target), files = privateTree(root);
  const contract = read(root, 'durable.json'), stateRaw = readLocal(root, 'durable-state.json');
  assert(stateRaw !== null, 'Missing Durable state');
  const state = JSON.parse(stateRaw), supervision = read(root, 'supervision.json');
  assert(contract.schema_version === 1 && state.schema_version === 1 && contract.backend === 'pi-durable-jsonl-1.0.0', 'Unsupported Durable contract; no implicit migration');
  assert(state.contract_sha256 === hash(contract) && contract.supervision_sha256 === hash(supervision), 'Durable contract changed');
  const rawPlan = readLocal(root, 'approved-plan.json');
  assert(sha256(rawPlan) === supervision.plan_sha256, 'Approved Durable plan changed');
  const plan = validatePlan(JSON.parse(rawPlan), defaults);
  assert(!inside(plan.repo_root, root), 'Durable storage must remain outside the source repository');
  assert(plan.agents.length === 1 && plan.agents[0].mode === 'read', 'Durable supports one standalone read-only worker');
  const owner = fs.existsSync(path.join(root, 'durable.lock/owner.json')) ? read(root, 'durable.lock/owner.json') : null;
  if (owner) assert(typeof owner.nonce === 'string' && /^[0-9a-f-]{36}$/.test(owner.nonce), 'Invalid Durable owner receipt');
  return { root, files, contract, state, stateHash: bytesHash(stateRaw), supervision, plan, owner };
}
function alive(owner) {
  if (!owner || owner.hostname !== os.hostname() || !Number.isInteger(owner.pid) || owner.pid <= 0) return null;
  try { process.kill(owner.pid, 0); return true; } catch (error) { return error.code === 'ESRCH' ? false : null; }
}
const fingerprint = ctx => hash(ctx.files);
function save(ctx) {
  const value = jsonText(ctx.state);
  writeLocal(ctx.root, 'durable-state.json', value, ctx.stateHash);
  const file = fs.openSync(path.join(ctx.root, 'durable-state.json'), 'r');
  try { fs.fsyncSync(file); } finally { fs.closeSync(file); }
  const directory = fs.openSync(ctx.root, 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  ctx.stateHash = bytesHash(value);
}
export function initDurable(input, directory, nativeAgentId, retainTranscript) {
  assert(retainTranscript === true, 'Durable requires explicit private transcript/possibly reasoning retention approval');
  assert(process.platform !== 'win32', 'This experimental Durable backend requires POSIX private file modes');
  const plan = validatePlan(input, defaults);
  assert(plan.agents.length === 1 && plan.agents[0].mode === 'read', 'Durable supports one standalone read-only worker; use ordinary supervision for candidates/workflows');
  const registered = initSupervision(plan, directory, nativeAgentId), root = registered.out;
  const contract = { schema_version: 1, backend: 'pi-durable-jsonl-1.0.0', supervision_sha256: hash(read(root, 'supervision.json')),
    retain_private_transcript: true, fsync: true, automatic_compaction: false, automatic_retries: false,
    authority: 'Primary host approves each recovery. Transcript may contain source, provider reasoning/signatures; never copy to incidents, learning or releases.' };
  writeLocal(root, 'durable.json', jsonText(contract), null);
  writeLocal(root, 'durable-state.json', jsonText({ schema_version: 1, contract_sha256: hash(contract), status: 'registered', owners: [], review: null }), null);
  return inspectDurable(root);
}
export function inspectDurable(directory) {
  const ctx = open(directory), recoveryFile = readLocal(ctx.root, 'run/recovery.json');
  const recovery = recoveryFile === null ? null : JSON.parse(recoveryFile);
  const usageFile = readLocal(ctx.root, 'run/usage.json');
  const requests = recovery ? mergeDurableLedger(recovery.requests, usageFile === null ? [] : JSON.parse(usageFile).requests) : null;
  const deadline = ctx.state.started_at ? Date.parse(ctx.state.started_at) + workerPolicy(ctx.plan.policy, ctx.plan.agents[0].limits).timeout_seconds * 1000 : null;
  return { out: ctx.root, status: ctx.state.status, artifact_fingerprint: fingerprint(ctx),
    native_agent_id: ctx.state.owners.at(-1)?.native_agent_id ?? ctx.supervision.native_agent_id,
    owner: ctx.owner, owner_process_alive: alive(ctx.owner), original_deadline_at: deadline === null ? null : new Date(deadline).toISOString(),
    remaining_seconds: deadline === null ? null : Math.max(0, (deadline - Date.now()) / 1000),
    requests: requests?.length ?? null, budget_exposure_usd: requests ? budgetBasis(requests) : null,
    costs: requests ? costSummary(requests) : null, review: ctx.state.review,
    review_current: ctx.state.review ? ctx.state.review.reviewed_artifacts_sha256 === hash(ctx.files.filter(file => file.path !== 'durable-state.json')) : null,
    note: 'Local structural inspection; no scheduler or provider call. A PID check does not authenticate a native agent. Missing ledger means unknown exposure.' };
}
async function claim(directory, approval, dependencies) {
  let ctx = open(directory);
  assert(['registered', 'running'].includes(ctx.state.status), 'Durable session has settled; inspect and review it rather than rerunning');
  const resume = ctx.state.status === 'running';
  if (resume) {
    assert(approval && Object.keys(approval).every(key => ['reviewed_by', 'previous_process_dead', 'artifact_fingerprint', 'native_agent_id'].includes(key)), 'Invalid Durable recovery approval fields');
    assert(approval?.reviewed_by === ctx.plan.orchestrator && approval.previous_process_dead === true, 'Recovery requires primary-host review and confirmed process death');
    assert(approval.artifact_fingerprint === fingerprint(ctx), 'Durable artifacts changed since primary-host inspection');
    assert(typeof approval.native_agent_id === 'string' && /^[a-zA-Z0-9_./:-]{1,200}$/.test(approval.native_agent_id), 'Recovery needs an actual new native supervisor ID');
    assert(ctx.owner && alive(ctx.owner) === false, 'Prior Durable owner is alive or its death is unknown; keep the native handle and wait');
  } else assert(!approval, 'Recovery approval is only valid for an interrupted session');
  // A separate exclusive mutex protects stale-owner replacement from two recovering
  // processes. A crash during this tiny ownership transaction fails closed.
  const mutex = path.join(ctx.root, 'durable-recovery.lock');
  try { fs.mkdirSync(mutex, { mode: 0o700 }); } catch (error) { if (error.code === 'EEXIST') throw new Error('Durable ownership operation already active; return to host'); throw error; }
  let owner;
  try {
    const lock = path.join(ctx.root, 'durable.lock');
    if (resume) {
      const fresh = open(directory);
      const filtered = fresh.files.filter(file => !file.path.startsWith('durable-recovery.lock/'));
      assert(hash(filtered) === approval.artifact_fingerprint && alive(fresh.owner) === false, 'Durable ownership changed during recovery');
      fs.renameSync(lock, path.join(ctx.root, `owner-${ctx.owner.nonce}`));
    }
    try { fs.mkdirSync(lock, { mode: 0o700 }); } catch (error) { if (error.code === 'EEXIST') throw new Error('Durable session already has an owner; never dispatch duplicate work'); throw error; }
    owner = { pid: process.pid, hostname: os.hostname(), nonce: crypto.randomUUID(), native_agent_id: resume ? approval.native_agent_id : ctx.supervision.native_agent_id, claimed_at: new Date().toISOString() };
    writeLocal(ctx.root, 'durable.lock/owner.json', jsonText(owner), null);
    ctx.state.owners.push(owner);
    if (!resume) ctx.state.started_at = new Date((dependencies.now || Date.now)()).toISOString();
    ctx.state.status = 'running';
    if (resume) (ctx.state.recoveries ||= []).push({ ...approval, at: owner.claimed_at });
    save(ctx);
    const supervisionState = read(ctx.root, 'supervision-state.json');
    supervisionState.status = 'durable_managed';
    const raw = readLocal(ctx.root, 'supervision-state.json');
    writeLocal(ctx.root, 'supervision-state.json', jsonText(supervisionState), bytesHash(raw));
  } finally { fs.rmdirSync(mutex); }
  return { ctx, owner, resume };
}
export async function runDurable(directory, approval = null, dependencies = {}) {
  const { ctx, owner, resume } = await claim(directory, approval, dependencies);
  try {
    assert(hash(manifestOf(captureSnapshot(ctx.plan))) === ctx.supervision.snapshot_sha256, 'Source snapshot changed; return to primary host');
    if (resume) assert(readLocal(ctx.root, 'run/recovery.json') !== null && readLocal(ctx.root, 'durable-model.json') !== null, 'Interrupted before a recovery ledger/model was committed; use a fresh approved attempt');
    const { executeJob, writeJson } = await import('./pi.mjs');
    const { durableAgentClass } = await import('./durable-agent.mjs');
    const Agent = durableAgentClass(path.join(ctx.root, 'transcript'), dependencies.durableHooks);
    const frozen = resume ? read(ctx.root, 'durable-model.json') : null;
    const startedAtMs = Date.parse(ctx.state.started_at);
    const result = await executeJob(ctx.plan, path.join(ctx.root, 'run'), { ...dependencies, Agent, durable: true, resume, startedAtMs,
      validateSnapshot: (_plan, snapshot) => assert(hash(snapshot) === ctx.supervision.snapshot_sha256, 'Durable source snapshot changed'),
      validateModel: (_spec, resolved) => {
        if (frozen) assert(durableModelIdentity(resolved) === durableModelIdentity(frozen), 'Resolved model, effort or catalog capabilities changed; no implicit resume migration');
        else writeJson(path.join(ctx.root, 'durable-model.json'), resolved, true);
      },
      agentOptions: ({ caps, result: worker, checkpoint }) => ({ persistence: { caps, result: worker, checkpoint } })
    });
    ctx.state.status = 'awaiting_review'; ctx.state.finished_at = new Date().toISOString(); save(ctx);
    return { out: ctx.root, run: result.out, native_agent_id: owner.native_agent_id, status: ctx.state.status, costs: result.report.costs, agents: result.report.agents.map(worker => ({ id: worker.id, status: worker.status })) };
  } catch (error) {
    ctx.state.status = 'failed'; ctx.state.finished_at = new Date().toISOString();
    ctx.state.incident = tryWriteIncident(fs.existsSync(path.join(ctx.root, 'run')) ? path.join(ctx.root, 'run') : ctx.root,
      { phase: 'supervision', failure_code: 'supervision_failed' });
    save(ctx); throw error;
  } finally {
    // A hard kill leaves the owner receipt for explicit recovery. Ordinary errors
    // settle the session and cannot silently restart it.
    fs.rmSync(path.join(ctx.root, 'durable.lock'), { recursive: true });
  }
}
export async function reviewDurable(directory, review) {
  const ctx = open(directory);
  assert(['awaiting_review', 'failed'].includes(ctx.state.status) && !ctx.owner, 'Wait for Durable owner to settle before reviewing');
  assert(review && Object.keys(review).every(key => ['native_agent_id', 'artifact_fingerprint', 'verdict', 'summary'].includes(key)), 'Invalid Durable review fields');
  assert(review.native_agent_id === ctx.state.owners.at(-1)?.native_agent_id && review.artifact_fingerprint === fingerprint(ctx), 'Review supervisor or artifacts changed');
  assert(['ready_for_host', 'needs_work', 'blocked'].includes(review.verdict) && typeof review.summary === 'string' && review.summary.length > 0 && review.summary.length <= 4000, 'Invalid Durable advisory review');
  ctx.state.review = { ...review, reviewed_artifacts_sha256: hash(ctx.files.filter(file => file.path !== 'durable-state.json')),
    reviewed_at: new Date().toISOString(), authority: 'Advisory only; primary host validates findings, integration and learning.' };
  ctx.state.status = 'reviewed'; save(ctx); return inspectDurable(directory);
}
/** Serialize local billing maintenance with recovery; never touch a live owner. */
export async function withDurableMaintenance(runDirectory, operation) {
  const ctx = open(path.dirname(path.resolve(runDirectory)));
  assert(path.join(ctx.root, 'run') === fs.realpathSync(runDirectory), 'Wrong Durable run directory');
  assert(!ctx.owner || alive(ctx.owner) === false, 'Durable billing maintenance requires a settled or confirmed-dead owner');
  const mutex = path.join(ctx.root, 'durable-recovery.lock');
  try { fs.mkdirSync(mutex, { mode: 0o700 }); } catch (error) { if (error.code === 'EEXIST') throw new Error('Durable ownership/maintenance operation already active'); throw error; }
  try {
    const current = open(ctx.root);
    assert(!current.owner || alive(current.owner) === false, 'Durable owner became active before maintenance');
    return await operation();
  } finally { fs.rmdirSync(mutex); }
}
export async function durableMain(argv) {
  const command = argv[0] || 'help', options = {};
  const allowed = { init: ['plan', 'out', 'agent-id', 'retain-transcript'], run: ['out'], inspect: ['out'], resume: ['out', 'approval'], review: ['out', 'review'], help: [] };
  assert(Object.hasOwn(allowed, command), 'Unknown Durable command');
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index].replace(/^--/, '');
    assert(argv[index].startsWith('--') && allowed[command].includes(key) && !Object.hasOwn(options, key), 'Unknown or duplicate Durable option');
    assert(argv[index + 1] && !argv[index + 1].startsWith('--'), `Missing value for ${argv[index]}`); options[key] = argv[index + 1];
  }
  if (command === 'help') return 'pi durable (experimental, one read-only worker, POSIX)\n  init --plan PLAN --out NEW_PRIVATE_DIRECTORY --agent-id ACTUAL_NATIVE_ID --retain-transcript approved\n  inspect --out SESSION\n  run --out SESSION\n  resume --out SESSION --approval PRIMARY_HOST_APPROVAL.json\n  review --out SESSION --review NATIVE_ADVISORY_REVIEW.json\nOnly run/resume can perform paid inference. Transcript retention must be explicitly approved. No unattended recovery, compaction, shell, edits or recursive delegation.';
  assert(options.out, '--out is required');
  const input = file => { assert(file, 'Required JSON file missing'); const absolute = path.resolve(file); return read(path.dirname(absolute), path.basename(absolute)); };
  if (command === 'init') return initDurable(input(options.plan), options.out, options['agent-id'], options['retain-transcript'] === 'approved');
  if (command === 'inspect') return inspectDurable(options.out);
  if (command === 'review') return reviewDurable(options.out, input(options.review));
  const result = await runDurable(options.out, command === 'resume' ? input(options.approval) : null, { onProgress: value => console.error(JSON.stringify(value)) });
  if (result.agents.some(worker => worker.status !== 'completed')) process.exitCode = 2;
  return result;
}
