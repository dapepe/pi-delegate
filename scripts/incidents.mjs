#!/usr/bin/env node
/** Private, host-only structural diagnostics. Never store worker text or raw errors here. */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { sha256 } from './lib.mjs';
import { localPath, readLocal, writeLocal, jsonText } from './project-files.mjs';
import { STOP_STATUSES, RUNTIME_LIMIT_KEYS } from './runtime.mjs';

const STATUSES = new Set([...STOP_STATUSES, 'unknown']);
const REQUEST_STATUSES = new Set([...STATUSES, 'in_flight', 'interrupted', 'stop', 'length', 'toolUse']);
const PHASES = new Set(['execution', 'preflight', 'recovery', 'supervision']);
const FAILURE_CODES = new Set(['preflight_failed', 'execution_failed', 'supervision_failed', 'worker_incomplete', 'orchestration_error', 'unfinished_run', 'missing_artifacts', 'invalid_artifacts', 'host_interrupted', 'unknown']);
const EFFORTS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const FAILURE_CLASSES = new Set([...STATUSES, 'none', 'unfinished', 'budget', 'output_limit_reasoning', 'provider_rate_limit', 'provider_error']);
const TOKEN_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'totalTokens'];
const OPERATIONAL = new Set(['error', 'request_timeout', 'stream_idle_timeout', 'aborted', 'orchestration_error', 'model_mismatch']);
const LIMITS = new Set(['timeout', 'turn_limit', 'tool_limit', 'budget_limit', 'budget_reservation_limit', 'context_limit', 'output_limit']);
const MAX_WORKERS = 256;
const obj = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const enumeration = (value, choices, fallback = null) => choices.has(value) ? value : fallback;
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 ? sha256(value) : null;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null;
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) && Number.isFinite(Date.parse(value)) ? value : null;
const numericFields = (value, keys) => Object.fromEntries(keys.map(key => [key, number(obj(value)[key])]));
const count = value => Array.isArray(value) ? value.length : null;

function category(status) {
  if (status === 'completed') return 'completion_claim';
  if (status === 'partial' || status === 'blocked') return status;
  if (OPERATIONAL.has(status)) return 'operational';
  if (LIMITS.has(status)) return 'limit';
  if (status === 'missing_submission') return 'completion_protocol';
  if (status === 'policy_violation') return 'permissions';
  if (status === 'refusal') return 'refusal';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'not_started') return 'not_started';
  if (status === 'running' || status === 'starting') return 'unfinished';
  return 'unknown';
}

function summarizeRequests(requests) {
  if (!Array.isArray(requests)) return { available: false, request_count: null, status_counts: {}, costs: null, timing: null, tokens: null };
  const statuses = {}, seconds = [], costs = {
    provider_reported_usd: 0, reconciled_request_count: 0,
    estimated_unreconciled_usd: 0, unresolved_request_count: 0, unpriced_request_count: 0
  };
  const tokens = Object.fromEntries(TOKEN_FIELDS.map(key => [key, { observed_request_count: 0, total: null }]));
  let invalid = 0;
  for (const entry of requests) {
    const request = obj(entry), status = enumeration(request.status, REQUEST_STATUSES, 'unknown');
    statuses[status] = (statuses[status] || 0) + 1;
    if (request !== entry) invalid++;
    const billed = number(request.billed_usd), estimated = number(request.estimate_usd), elapsed = number(request.seconds);
    if (elapsed !== null) seconds.push(elapsed);
    for (const key of TOKEN_FIELDS) {
      const value = number(obj(request.usage)[key]);
      if (value !== null) {
        const previous = tokens[key];
        previous.total = previous.observed_request_count === 0 ? value : previous.total === null ? null : number(previous.total + value);
        previous.observed_request_count++;
      }
    }
    if (billed !== null) { costs.provider_reported_usd += billed; costs.reconciled_request_count++; }
    else {
      costs.unresolved_request_count++;
      if (estimated !== null) costs.estimated_unreconciled_usd += estimated;
      else costs.unpriced_request_count++;
    }
  }
  // Extreme/invalid input must not turn overflow into a claim of a zero charge.
  for (const key of ['provider_reported_usd', 'estimated_unreconciled_usd']) costs[key] = number(costs[key]);
  return {
    available: true, request_count: requests.length, invalid_record_count: invalid,
    status_counts: Object.fromEntries(Object.entries(statuses).sort(([a], [b]) => a.localeCompare(b))), costs, tokens,
    timing: {
      observed_request_count: seconds.length,
      mean_request_seconds: seconds.length ? number(seconds.reduce((sum, n) => sum + n, 0) / seconds.length) : null,
      max_request_seconds: seconds.length ? seconds.reduce((max, n) => Math.max(max, n), 0) : null
    }
  };
}

function safeWorker(value, index, requests) {
  const worker = obj(value), model = obj(worker.model);
  const status = enumeration(worker.status, STATUSES, 'unknown');
  const matching = Array.isArray(requests) && typeof worker.id === 'string' && requests.every(record => typeof obj(record).agent_id === 'string')
    ? requests.filter(record => obj(record).agent_id === worker.id) : null;
  const changes = Array.isArray(worker.changes) ? worker.changes : null;
  return {
    index, worker_id_sha256: identity(worker.id), status, category: category(status), failure_class: enumeration(worker.failure_class, FAILURE_CLASSES),
    mode: enumeration(worker.mode, new Set(['read', 'write'])),
    provider_sha256: identity(model.provider), requested_model_sha256: identity(model.requested_model), resolved_model_sha256: identity(model.resolved_model),
    requested_effort: enumeration(model.requested_effort, EFFORTS), effective_pi_effort: enumeration(model.effective_pi_effort, EFFORTS),
    started_at: timestamp(worker.started_at), finished_at: timestamp(worker.finished_at), last_activity_at: timestamp(worker.last_activity_at),
    elapsed_seconds: number(worker.elapsed_seconds),
    limits: numericFields(worker.limits, [...RUNTIME_LIMIT_KEYS, 'max_output_tokens']),
    limit_usage: numericFields(worker.limit_usage, ['requests', 'tool_calls', 'rejected_tool_calls', 'elapsed_seconds', 'completion_repairs']),
    deadline: numericFields(worker.deadline, ['warnings', 'refusals']),
    stop_causes: Array.isArray(worker.stop_causes) ? [...new Set(worker.stop_causes.filter(status => STATUSES.has(status)))].sort() : [],
    submission_completion: enumeration(obj(worker.submission).completion, new Set(['complete', 'partial', 'blocked'])),
    remaining_work_count: count(obj(worker.submission).remaining_work),
    warning_count: count(worker.warnings), policy_violation_count: count(worker.policy_violations), tool_error_count: count(worker.tool_errors),
    artifact_sha256: hash(obj(worker.artifact_identity).artifact_sha256), candidate_count: count(changes),
    candidates: (changes || []).slice(0, 1000).map(change => ({
      action: enumeration(obj(change).action, new Set(['add', 'modify', 'delete'])),
      before_sha256: hash(obj(change).before_sha256), after_sha256: hash(obj(change).after_sha256)
    })),
    candidates_truncated: Boolean(changes && changes.length > 1000),
    requests: summarizeRequests(matching)
  };
}

function loadInput(directory, name, supplied, envelope) {
  if (Object.hasOwn(envelope, supplied)) {
    const value = envelope[supplied];
    return obj(value) === value ? { state: 'supplied', value } : { state: 'invalid', value: null };
  }
  try {
    const raw = readLocal(directory, name);
    if (raw === null) return { state: 'missing', value: null };
    const value = JSON.parse(raw);
    return obj(value) === value ? { state: 'read', value } : { state: 'invalid', value: null };
  } catch {
    // No exception text is retained: parsers and filesystem errors can include source and paths.
    return { state: 'unreadable_or_invalid', value: null };
  }
}

/** True for a failed/skipped/incomplete run. A completion claim still needs host review. */
export function needsIncident(report) {
  return !report || !timestamp(report.finished_at) || !Array.isArray(report.agents) || report.agents.length === 0 ||
    report.agents.some(agent => obj(agent).status !== 'completed' || ['partial', 'blocked'].includes(obj(obj(agent).submission).completion)) ||
    (Array.isArray(report.orchestration_errors) && report.orchestration_errors.length > 0);
}

/** Only explicitly selected primitive structural fields reach the persistent diagnostic. */
export function incidentSnapshot(directory, envelope = {}) {
  const reportInput = loadInput(directory, 'report.json', 'report', envelope);
  const usageInput = loadInput(directory, 'usage.json', 'usage', envelope);
  const report = obj(reportInput.value), usage = obj(usageInput.value);
  const agents = Array.isArray(report.agents) ? report.agents : null;
  const requests = Array.isArray(usage.requests) ? usage.requests : null;
  const workers = (agents || []).slice(0, MAX_WORKERS).map((agent, index) => safeWorker(agent, index, requests));
  const uncertainty = [];
  if (!['read', 'supplied'].includes(reportInput.state)) uncertainty.push('report_unavailable');
  if (!['read', 'supplied'].includes(usageInput.state)) uncertainty.push('usage_unavailable');
  if (!agents) uncertainty.push('worker_list_unknown');
  if (!requests) uncertainty.push('request_ledger_unknown');
  if (requests && requests.some(record => typeof obj(record).agent_id !== 'string')) uncertainty.push('request_worker_attribution_unknown');
  if (!timestamp(report.finished_at)) uncertainty.push('run_completion_unconfirmed');
  if (agents && agents.length > MAX_WORKERS) uncertainty.push('worker_details_truncated');
  if (workers.some(worker => worker.status === 'unknown')) uncertainty.push('unknown_worker_status');
  return {
    schema_version: 1,
    phase: enumeration(envelope.phase, PHASES, 'recovery'), failure_code: enumeration(envelope.failure_code, FAILURE_CODES),
    provenance: { report: reportInput.state, usage: usageInput.state },
    run_id_sha256: identity(report.run_id),
    skill_version: typeof report.skill_version === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(report.skill_version) ? report.skill_version : null,
    created_at: timestamp(report.created_at), updated_at: timestamp(report.updated_at), finished_at: timestamp(report.finished_at),
    process_state: 'unverified', uncertainty,
    worker_count: agents ? agents.length : null,
    orchestration_error_count: count(report.orchestration_errors),
    categories: [...new Set(workers.map(worker => worker.category))].sort(), workers,
    requests: summarizeRequests(requests),
    privacy: 'Structural allowlist only. No prompts, source paths/text, provider messages, endpoint URLs, credential values, or reasoning traces. Identifiers are hashes, not anonymization guarantees.',
    interpretation: 'Statuses and submission claims are observations, not model rankings or validated task outcomes. An unfinished checkpoint does not establish that a process died. Costs exclude host/supervisor usage; estimates, reported charges, and unpriced requests stay separate.'
  };
}

function markdown(incident) {
  const { snapshot } = incident;
  const show = value => value === null || value === undefined ? 'unknown' : String(value);
  const costs = snapshot.requests.costs;
  const lines = ['# Pi delegation incident', '', `Recorded: ${incident.recorded_at}`, '', `Fingerprint: ${incident.fingerprint}`, '',
    `Phase: ${snapshot.phase}. Failure code: ${show(snapshot.failure_code)}.`, '',
    `Report: ${snapshot.provenance.report}. Usage: ${snapshot.provenance.usage}. Workers: ${show(snapshot.worker_count)}.`, '',
    '**Process state is unverified.** Check the host process/task handle before retrying or treating the run as terminated.', '',
    `Uncertainty: ${snapshot.uncertainty.join(', ') || 'No structural gaps detected; outcomes still need review.'}`, '',
    `Provider-reported USD: ${show(costs?.provider_reported_usd)}. Unreconciled estimated USD: ${show(costs?.estimated_unreconciled_usd)}. Unpriced requests: ${show(costs?.unpriced_request_count)}. Unknown is not zero.`, '',
    '| Worker index | Status | Category | Elapsed seconds | Candidate count | Requests |',
    '| --- | --- | --- | --- | --- | --- |'];
  for (const worker of snapshot.workers) lines.push(`| ${worker.index} | ${worker.status} | ${worker.category} | ${show(worker.elapsed_seconds)} | ${show(worker.candidate_count)} | ${show(worker.requests.request_count)} |`);
  lines.push('', snapshot.interpretation, '', snapshot.privacy, '',
    'Review the original private run artifacts locally to correlate hashed identities. Do not attach original prompts, source, provider messages or credentials to a shared issue without separate review.', '');
  return lines.join('\n');
}

function directoryRoot(directory) {
  const absolute = path.resolve(directory), stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('incident_directory_invalid');
  return fs.realpathSync(absolute);
}

// POSIX mode bits do not describe Windows access. As in credential setup, apply
// a protected current-user ACL only to a directory this call just created.
// Existing directories/files are checked without changing their permissions.
function windowsPrivate(paths, createDirectory = null) {
  const command = `$ErrorActionPreference='Stop'; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;
if ($env:PI_INCIDENT_NEW_DIRECTORY) {
  $acl=New-Object System.Security.AccessControl.DirectorySecurity;
  $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false);
  $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow');
  $acl.AddAccessRule($rule); Set-Acl -LiteralPath $env:PI_INCIDENT_NEW_DIRECTORY -AclObject $acl;
}
foreach ($p in (ConvertFrom-Json -InputObject $env:PI_INCIDENT_PERMISSION_PATHS)) {
  $acl=Get-Acl -LiteralPath $p; $full=$false;
  foreach ($rule in $acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq 'Allow') {
      if ($rule.IdentityReference.Value -ne $sid.Value) { throw 'incident_acl_not_private' }
      if (($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl) { $full=$true }
    }
  }
  if (-not $full) { throw 'incident_acl_not_private' }
}`;
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      stdio: 'pipe', timeout: 15000,
      env: { ...process.env, PI_INCIDENT_NEW_DIRECTORY: createDirectory || '', PI_INCIDENT_PERMISSION_PATHS: JSON.stringify(paths) }
    });
  } catch { throw new Error('incident_windows_permissions_invalid'); }
}

/** Append an immutable snapshot. Existing curated files are never overwritten. */
export function writeIncident(directory, envelope = {}) {
  const root = directoryRoot(directory);
  const snapshot = incidentSnapshot(root, envelope), fingerprint = sha256(JSON.stringify(snapshot));
  const incident = { schema_version: 1, fingerprint, recorded_at: new Date().toISOString(), snapshot };
  const destination = localPath(root, 'incidents');
  let created = false;
  try { fs.mkdirSync(destination, { mode: 0o700 }); created = true; } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = fs.lstatSync(localPath(root, 'incidents'));
  if (!stat.isDirectory() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) throw new Error('incident_directory_not_private');
  if (process.platform === 'win32') windowsPrivate([destination], created ? destination : null);
  for (let revision = 0; revision < 1000; revision++) {
    const base = `incidents/${fingerprint}${revision ? `.${revision}` : ''}`, json = `${base}.json`, md = `${base}.md`;
    const priorJson = readLocal(root, json), priorMarkdown = readLocal(root, md);
    const existing = [json, md].filter(file => (file === json ? priorJson : priorMarkdown) !== null).map(file => localPath(root, file));
    if (process.platform === 'win32' && existing.length) windowsPrivate(existing);
    else for (const file of existing) {
      if ((fs.statSync(file).mode & 0o077) !== 0) throw new Error('incident_file_not_private');
    }
    if (priorJson !== null || priorMarkdown !== null) {
      let prior; try { prior = JSON.parse(priorJson); } catch { continue; }
      if (prior?.fingerprint === fingerprint && JSON.stringify(prior.snapshot) === JSON.stringify(snapshot) &&
          timestamp(prior.recorded_at) && priorJson === jsonText({ schema_version: 1, fingerprint, recorded_at: prior.recorded_at, snapshot }) && priorMarkdown === markdown(prior)) {
        return { status: 'existing', fingerprint, json: path.join(root, json), markdown: path.join(root, md) };
      }
      continue;
    }
    writeLocal(root, json, jsonText(incident), null, 0o600);
    writeLocal(root, md, markdown(incident), null, 0o600);
    return { status: 'written', fingerprint, json: path.join(root, json), markdown: path.join(root, md) };
  }
  throw new Error('incident_revision_limit');
}

/** Diagnostic failures must not replace the run's actual outcome or leak exception text. */
export function tryWriteIncident(directory, envelope = {}) {
  try { return writeIncident(directory, envelope); }
  catch { return { status: 'unavailable', code: 'incident_write_failed' }; }
}

export function incidentMain(args) {
  if (args.length !== 2 || args[0] !== '--out' || !args[1] || args[1].startsWith('--')) {
    console.error(JSON.stringify({ status: 'invalid', code: 'usage', usage: 'incident --out RUN' }));
    process.exitCode = 2; return null;
  }
  const result = tryWriteIncident(args[1], { phase: 'recovery' });
  console.log(JSON.stringify(result, null, 2));
  if (result.status === 'unavailable') process.exitCode = 4;
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) incidentMain(process.argv.slice(2));
