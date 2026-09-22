#!/usr/bin/env node
/** Host-only run finalization.  No inference, integration, or AGENTS.md apply occurs here. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { assert, sha256 } from './lib.mjs';
import { markdownReport, validateAssessment } from './report.mjs';
import { validateLearningAssessment, recordLearning, learningSummary, proposeLearning } from './learning.mjs';
import { evaluationsMatch, readArtifactIdentity } from './evaluation.mjs';
import { readLocal } from './project-files.mjs';
import { backfillRunInventory, readRunInventory, updateRunInventory } from './insights-store.mjs';

export class FinalizeError extends Error {
  constructor(message, exitCode = 1) { super(message); this.name = 'FinalizeError'; this.exitCode = exitCode; }
}
const fail = (message, code = 1) => { throw new FinalizeError(message, code); };
const MAX_BYTES = 16 * 1024 * 1024;

function regularFile(filename, label, base = null) {
  const resolved = path.resolve(filename);
  if (base) {
    const root = path.resolve(base), rel = path.relative(root, resolved);
    if (rel === '' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) fail(`${label} is outside its trusted directory`);
    let current = root;
    for (const part of rel.split(path.sep)) {
      current = path.join(current, part);
      let item; try { item = fs.lstatSync(current); } catch (e) { fail(`${label} is unavailable: ${e.message}`); }
      if (item.isSymbolicLink()) fail(`${label} contains a symlink component`);
    }
  }
  let stat; try { stat = fs.lstatSync(resolved); } catch (e) { fail(`${label} is unavailable: ${e.message}`); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_BYTES) fail(`${label} must be a bounded regular file`);
  const fd = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const current = fs.fstatSync(fd); if (!current.isFile() || current.nlink !== 1 || current.size > MAX_BYTES) fail(`${label} changed while reading`);
    const bytes = Buffer.alloc(MAX_BYTES + 1); let length = 0, count;
    while (length < bytes.length && (count = fs.readSync(fd, bytes, length, bytes.length - length, null)) > 0) length += count;
    if (length > MAX_BYTES) fail(`${label} grew beyond the bounded limit`);
    return bytes.subarray(0, length);
  } finally { fs.closeSync(fd); }
}
function jsonFile(root, filename) {
  try { return readJsonRecord(root, filename).value; }
  catch (e) { if (e instanceof FinalizeError) throw e; fail(`Invalid ${filename}: ${e.message}`); }
}
function readJsonRecord(root, filename) {
  const bytes = regularFile(path.join(root, filename), filename, root);
  const hash = sha256(bytes);
  try { return { value: JSON.parse(bytes.toString('utf8')), hash }; }
  catch (e) { fail(`Invalid ${filename}: ${e.message}`); }
}
function outside(root, target) {
  const rel = path.relative(root, target);
  return rel !== '' && (rel.startsWith('..' + path.sep) || path.isAbsolute(rel));
}
function loadRun(out, repoAssertion = null) {
  const runDir = path.resolve(out);
  let stat; try { stat = fs.lstatSync(runDir); } catch (e) { fail(`Run directory is unavailable: ${e.message}`); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Run output must be a regular directory');
  const reportRecord = readJsonRecord(runDir, 'report.json');
  const planRecord = readJsonRecord(runDir, 'plan.json');
  const snapshotRecord = readJsonRecord(runDir, 'snapshot.json');
  const usageRecord = readJsonRecord(runDir, 'usage.json');
  const report = reportRecord.value, plan = planRecord.value, snapshot = snapshotRecord.value, usage = usageRecord.value;
  if (!report.run_id || !report.source_repo || !plan.repo_root || snapshot.repo_root !== report.source_repo) fail('Run provenance is incomplete or inconsistent');
  if (!Array.isArray(usage.requests)) fail('Usage ledger must contain requests');
  let repo; try { repo = fs.realpathSync(repoAssertion || report.source_repo); } catch (e) { fail(`Repository assertion is unavailable: ${e.message}`); }
  try {
    if (fs.realpathSync(report.source_repo) !== repo || fs.realpathSync(plan.repo_root) !== repo || fs.realpathSync(snapshot.repo_root) !== repo) fail('Run does not belong to the asserted repository');
  } catch (e) { if (e instanceof FinalizeError) throw e; fail(`Run repository provenance is unavailable: ${e.message}`); }
  if (!outside(repo, fs.realpathSync(runDir))) fail('Run artifacts must be outside the task repository');
  return { runDir, repo, report, plan, snapshot, usage, read_hashes: { report: reportRecord.hash, plan: planRecord.hash, snapshot: snapshotRecord.hash, usage: usageRecord.hash } };
}
function artifactReport(run) {
  const report = structuredClone(run.report);
  for (const agent of report.agents || []) {
    if (typeof agent.id !== 'string' || !/^[a-z][a-z0-9._-]{0,63}$/.test(agent.id)) fail('Report worker ID is not a safe artifact directory name');
    delete agent.artifact_identity;
    const resultFile = path.join(run.runDir, agent.id, 'result.json');
    if (!fs.existsSync(resultFile)) continue;
    try { agent.artifact_identity = readArtifactIdentity(run.runDir, agent.id, { plan: run.plan, snapshot: run.snapshot }); }
    catch (e) { fail(`Cannot establish artifact identity for ${agent.id}: ${e.message}`); }
  }
  return report;
}
function assessmentFingerprint(run, assessment = null, reportForValidation = null) {
  return sha256(JSON.stringify({ report: run.read_hashes.report, plan: run.read_hashes.plan, snapshot: run.read_hashes.snapshot, usage: run.read_hashes.usage, artifacts: (reportForValidation?.agents || []).map(agent => [agent.id, agent.artifact_identity?.artifact_sha256 || null]), assessment: assessment ? sha256(JSON.stringify(assessment)) : null }));
}
function assessmentStatus(assessment) { return assessment ? 'valid' : 'missing'; }
function writeAtomic(filename, value) {
  const temp = `${filename}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  fs.renameSync(temp, filename);
}
function loadSavedReceipt(runDir) {
  const file = path.join(runDir, 'finalization.json');
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(regularFile(file, 'finalization.json', runDir).toString('utf8')); } catch { return null; }
}
function completeBlockers(report, assessment, requireComplete) {
  const blockers = [];
  if (!assessment) blockers.push({ code: 'assessment_missing', message: 'A run-specific host assessment is required before finalization can be complete.', action: 'Provide --assessment FILE or save assessment.json.' });
  const incomplete = (report.agents || []).filter(agent => agent.status !== 'completed' || !agent.submission || ['partial', 'blocked'].includes(agent.submission?.completion));
  if (requireComplete && incomplete.length) blockers.push({ code: 'require_complete', message: '--require-complete requested a complete worker set.', action: 'Resolve every worker status and completion claim.' });
  return blockers;
}
function incompleteWorkers(report) {
  return (report.agents || []).filter(agent => agent.status !== 'completed' || !agent.submission || ['partial', 'blocked'].includes(agent.submission?.completion)).map(agent => agent.id);
}
function learningConfig(repo) {
  const raw = readLocal(repo, '.pi/learning/config.json');
  if (raw === null) return null;
  try { return JSON.parse(raw); } catch (e) { fail(`Invalid project learning config: ${e.message}`); }
}
function inventoryUpdate(run, assessment, lifecycle, schemaVersion) {
  try {
    const args = { report: run.report, plan: run.plan, usage: run.usage, assessment, lifecycle, assessmentStatus: assessment ? 'valid' : 'missing', assessmentSchemaVersion: schemaVersion };
    const existing = readRunInventory(run.repo)?.runs.find(record => record.run_id === run.report.run_id);
    return existing ? { status: 'updated', ...updateRunInventory(run.repo, args) } : { status: 'backfilled', ...backfillRunInventory(run.repo, run.runDir, { lifecycle, assessmentStatus: assessment ? 'valid' : 'missing', assessmentSchemaVersion: schemaVersion, assessment }) };
  } catch (e) { return { status: 'warning', warning: String(e.message).slice(0, 800) }; }
}

/**
 * Validate and finalize one explicitly named run.  A receipt is the only file
 * written besides an optional run-local assessment and report.md; report.json
 * remains the execution record of fact.
 */
export function finalizeRun(out, { assessmentPath = null, repo = null, revise = false, requireComplete = false } = {}) {
  const run = loadRun(out, repo), prior = loadSavedReceipt(run.runDir);
  if (!evaluationsMatch(run.report.evaluation, run.plan.evaluation)) {
    fail('Saved report evaluation differs from the preregistered plan evaluation');
  }
  const config = learningConfig(run.repo);
  let assessment = null, schemaVersion = null, assessmentFile = path.join(run.runDir, 'assessment.json');
  if (assessmentPath) {
    const source = path.resolve(assessmentPath);
    try { assessment = JSON.parse(regularFile(source, 'assessment file', path.dirname(source)).toString('utf8')); }
    catch (e) { if (e instanceof FinalizeError) throw e; fail(`Invalid assessment JSON: ${e.message}`); }
  } else if (fs.existsSync(assessmentFile)) assessment = jsonFile(run.runDir, 'assessment.json');
  const reportForValidation = artifactReport(run);
  if (assessment) {
    try {
      assessment = validateAssessment(assessment, reportForValidation);
      schemaVersion = assessment.schema_version ?? 1;
      if (schemaVersion === 2 && assessment.learning) validateLearningAssessment(assessment, reportForValidation);
    } catch (e) { fail(`Assessment is invalid: ${e.message}`); }
  }
  const fingerprint = assessmentFingerprint(run, assessment, reportForValidation);
  const retryable = prior && (prior.recording?.status === 'blocked' || prior.inventory?.status === 'warning' || prior.publication?.status === 'warning' || (config && config.mode !== 'off' && prior.recording?.status === 'skipped' && /uninitialized|off/i.test(prior.recording?.reason || '')));
  const sameCompletionRequirement = prior && Boolean(prior.require_complete) === Boolean(requireComplete);
  // A receipt made while assessment was missing is an incomplete bookkeeping
  // attempt, not accepted evidence. Supplying the first assessment may repair
  // it directly. Once a valid assessment was accepted, later fact/assessment
  // changes require --revise; a stale receipt keeps that requirement visible.
  const priorStale = prior?.assessment?.status === 'stale' || prior?.blockers?.some(blocker => blocker.code === 'stale_finalization');
  const priorAccepted = prior?.assessment?.status === 'valid' || priorStale;
  if (prior && prior.fingerprint === fingerprint && sameCompletionRequirement && !revise && !retryable && !priorStale) return { ...structuredClone(prior), exit_code: prior.exit_code ?? (prior.blockers?.length ? 4 : 0) };
  const stale = prior && !revise && priorAccepted && prior.fingerprint !== fingerprint;
  if (stale) {
    const staleReceipt = {
      schema_version: 1, run_id: run.report.run_id, fingerprint: prior.fingerprint, observed_fingerprint: fingerprint, require_complete: Boolean(requireComplete),
      created_at: run.report.created_at, finalized_at: new Date().toISOString(), source_repo: run.repo,
      assessment: { status: 'stale', schema_version: prior.assessment?.schema_version ?? schemaVersion, file: fs.existsSync(assessmentFile) ? 'assessment.json' : null, sha256: prior.assessment?.sha256 ?? null },
      recording: prior.recording || { status: 'stale' }, publication: prior.publication || { status: 'stale' }, inventory: prior.inventory || { status: 'stale' },
      blockers: [{ code: 'stale_finalization', message: 'Run facts or assessment changed after the previous finalization receipt.', action: 'Review the changes and pass --revise.' }],
      next_action: 'Review stale run data and rerun finalize --revise.', exit_code: 4
    };
    writeAtomic(path.join(run.runDir, 'finalization.json'), staleReceipt);
    return staleReceipt;
  }
  if (assessment && assessmentPath) writeAtomic(assessmentFile, assessment);
  const blockers = stale ? [{ code: 'stale_finalization', message: 'Run facts or assessment changed after the previous finalization receipt.', action: 'Review the changes and pass --revise.' }] : completeBlockers(reportForValidation, assessment, requireComplete);
  let recording = { status: 'skipped', reason: config && config.mode !== 'off' ? 'No valid assessment supplied; learning recording is pending.' : 'Project learning is uninitialized or off.' };
  let publication = { status: 'skipped', reason: 'No learning record was created.' };
  if (config && config.mode !== 'off' && assessment && !stale) {
    try {
      // recordLearning reloads report.json and enriches artifact identities from
      // the actual candidate bytes before validating useful v2 evidence.
      recording = { status: 'recorded', ...recordLearning(run.repo, run.runDir, assessmentFile, { revise }) };
    } catch (e) { recording = { status: 'blocked', reason: String(e.message).slice(0, 800) }; blockers.push({ code: 'learning_record', message: recording.reason, action: 'Review the assessment, provenance, and any stale prior record.' }); }
    if (recording.status === 'recorded' && !recording.duplicate) {
      try {
        const summary = learningSummary(run.repo);
        const eligible = summary.profiles.filter(profile => profile.promotable);
        publication = eligible.length ? { status: 'prepared', ...proposeLearning(run.repo) } : { status: 'not_ready', eligible_profiles: 0, reason: 'No profile currently meets the existing promotion floor.' };
      } catch (e) { publication = { status: 'warning', reason: String(e.message).slice(0, 800) }; blockers.push({ code: 'learning_proposal', message: publication.reason, action: 'Review local learning state before proposing publication.' }); }
    } else if (recording.status === 'recorded' && recording.duplicate) publication = { status: 'unchanged', reason: 'This exact run evidence was already recorded; no new material proposal was prepared.' };
  }
  const inventory = inventoryUpdate(run, assessment, stale ? 'running' : blockers.length ? 'failed' : 'finalized', schemaVersion);
  const receipt = {
    schema_version: 1, run_id: run.report.run_id, fingerprint, require_complete: Boolean(requireComplete), created_at: run.report.created_at, finalized_at: new Date().toISOString(),
    source_repo: run.repo,
    assessment: { status: stale ? 'stale' : assessmentStatus(assessment), schema_version: schemaVersion, file: assessment ? 'assessment.json' : null, sha256: assessment ? sha256(JSON.stringify(assessment)) : null },
    incomplete_workers: incompleteWorkers(reportForValidation),
    recording, publication, inventory, blockers,
    next_action: blockers.length ? (stale ? 'Review stale run data and rerun finalize --revise.' : 'Resolve the listed blockers, then rerun finalization.') : publication.status === 'prepared' ? 'Review the exact proposal; apply only through a separate host-reviewed learn apply.' : 'No further finalization action is required.'
  };
  receipt.exit_code = blockers.length ? 4 : 0;
  writeAtomic(path.join(run.runDir, 'finalization.json'), receipt);
  try {
    const statusLines = [
      '', '## Finalization', '',
      `Assessment: **${receipt.assessment.status}**${receipt.assessment.schema_version ? ` (schema ${receipt.assessment.schema_version})` : ''}.`,
      `Learning recording: **${receipt.recording.status}**. Publication proposal: **${receipt.publication.status}**.`,
      `Inventory: **${receipt.inventory.status}**.`, '',
      `${receipt.incomplete_workers.length ? `Incomplete workers recorded for review: ${receipt.incomplete_workers.join(', ')}.` : 'All workers report complete.'}`, '',
      `Next action: ${receipt.next_action}`
    ];
      fs.writeFileSync(path.join(run.runDir, 'report.md'), markdownReport(reportForValidation, assessment) + statusLines.join('\n') + '\n', { mode: 0o600 });
  }
  catch (e) { receipt.report_markdown_warning = String(e.message).slice(0, 800); }
  return receipt;
}

function parseArgs(args) {
  const values = new Set(['out', 'assessment', 'repo']); const flags = new Set(['revise', 'require-complete']); const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]; assert(arg.startsWith('--'), `Invalid option ${arg}`); const key = arg.slice(2);
    assert(!Object.hasOwn(options, key) && (values.has(key) || flags.has(key)), `Unknown or duplicate option ${arg}`);
    if (flags.has(key)) options[key] = true;
    else { assert(args[i + 1] && !args[i + 1].startsWith('--'), `Missing value for ${arg}`); options[key] = args[++i]; }
  }
  assert(options.out, '--out is required'); return options;
}
export function finalizeMain(args) {
  try {
    const options = parseArgs(args), result = finalizeRun(options.out, { assessmentPath: options.assessment || null, repo: options.repo || null, revise: Boolean(options.revise), requireComplete: Boolean(options['require-complete']) });
    console.log(JSON.stringify(result, null, 2));
    if (result.exit_code) process.exitCode = result.exit_code;
    return result;
  } catch (e) {
    const error = e instanceof FinalizeError ? e : new FinalizeError(e.message);
    console.error(JSON.stringify({ status: 'invalid', error: error.message }, null, 2)); process.exitCode = error.exitCode; return null;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) finalizeMain(process.argv.slice(2));
