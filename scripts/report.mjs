/** Render measured facts separately from the host's explicitly supplied judgments. */
import { assert, text, isNumber, hostLabel } from './lib.mjs';
import { explainStop } from './runtime.mjs';
const cell = value => String(value ?? 'unknown').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '');
const money = n => isNumber(n) ? `$${n.toFixed(6)}` : 'unknown';
const HEX64 = /^[a-f0-9]{64}$/;
const CRITERION_RESULTS = new Set(['passed', 'failed', 'inconclusive', 'not_run']);
const INTEGRATION_STATUSES = new Set(['not_assessed', 'not_applicable', 'candidate_only', 'accepted_modified', 'accepted_unmodified', 'rejected', 'deferred', 'unknown']);
export function validateAssessment(input, report) {
  const host = hostLabel(report.orchestrator);
  assert(input && input.run_id === report.run_id && input.assessed_by === host, `Assessment must identify this run and ${host} as the assessor`);
  const schemaVersion = input.schema_version ?? 1;
  assert(schemaVersion === 1 || schemaVersion === 2, `Unsupported assessment schema_version: ${schemaVersion}`);
  text(input.overall_value, 'overall_value', 8000);
  assert(Array.isArray(input.workers) && input.workers.length === report.agents.length, 'Assess every worker, including failures and skipped workers');
  assert(Array.isArray(input.decisions) && input.decisions.length <= 1000, 'decisions must be a bounded array');
  const seen = new Set();
  for (const w of input.workers) {
    assert(report.agents.some(a => a.id === w.agent_id) && !seen.has(w.agent_id), 'Unknown or duplicate assessment worker'); seen.add(w.agent_id);
    assert(Number.isInteger(w.usefulness_0_to_3) && w.usefulness_0_to_3 >= 0 && w.usefulness_0_to_3 <= 3, 'Usefulness must be 0–3');
    text(w.reason, 'worker assessment reason', 8000);
    for (const k of ['unique_validated_findings', 'duplicate_findings', 'unverified_findings']) if (w[k] !== undefined) assert(Number.isInteger(w[k]) && w[k] >= 0, `${k} must be a nonnegative integer`);
    if (schemaVersion === 2) {
      for (const key of Object.keys(w)) assert(['agent_id', 'usefulness_0_to_3', 'reason', 'unique_validated_findings', 'duplicate_findings', 'unverified_findings', 'quality_0_to_3', 'quality_reason', 'criterion_results', 'artifact_sha256', 'integration_status'].includes(key), `Unknown assessment v2 worker field: ${key}`);
      assert(Object.hasOwn(w, 'quality_0_to_3'), 'Assessment v2 workers must include quality_0_to_3 (or null)');
      assert(w.quality_0_to_3 === null || (Number.isInteger(w.quality_0_to_3) && w.quality_0_to_3 >= 0 && w.quality_0_to_3 <= 3), 'quality_0_to_3 must be 0–3 or null');
      text(w.quality_reason, 'quality_reason', 4000);
      assert(Array.isArray(w.criterion_results) && w.criterion_results.length <= 8, 'criterion_results must be an array with at most 8 items');
      const ids = new Set();
      for (const criterion of w.criterion_results) {
        assert(criterion && typeof criterion === 'object' && !Array.isArray(criterion), 'Each criterion result must be an object');
        for (const key of Object.keys(criterion)) assert(['id', 'result', 'evidence'].includes(key), `Unknown criterion result field: ${key}`);
        text(criterion.id, 'criterion result id', 64); assert(!ids.has(criterion.id), 'Duplicate criterion result id'); ids.add(criterion.id);
        assert(CRITERION_RESULTS.has(criterion.result), 'Invalid criterion result');
        assert(Array.isArray(criterion.evidence) && criterion.evidence.length <= 4 && criterion.evidence.every(e => typeof e === 'string' && e.trim() && e.length <= 1200), 'Criterion evidence must be a bounded string array');
        if (criterion.result === 'passed' || criterion.result === 'failed') assert(criterion.evidence.length > 0, 'Passed/failed criteria need evidence');
      }
      assert(w.artifact_sha256 === null || (typeof w.artifact_sha256 === 'string' && HEX64.test(w.artifact_sha256)), 'artifact_sha256 must be a SHA-256 hex string or null');
      assert(typeof w.integration_status === 'string' && INTEGRATION_STATUSES.has(w.integration_status), 'Invalid integration_status');
      const agent = report.agents.find(a => a.id === w.agent_id);
      const expected = report.evaluation?.workers?.find(item => item.agent_id === w.agent_id)?.criteria || [];
      assert(report.evaluation && expected.length > 0, 'Assessment v2 requires the preregistered plan evaluation and criteria');
      const expectedIds = new Set(expected.map(item => item.id));
      assert(w.criterion_results.length === expectedIds.size, 'Assessment v2 must report every preregistered criterion exactly once');
      for (const criterion of w.criterion_results) assert(expectedIds.has(criterion.id), `Criterion result is not in the plan evaluation: ${criterion.id}`);
      assert(new Set(w.criterion_results.map(criterion => criterion.id)).size === expectedIds.size, 'Assessment v2 criterion coverage is incomplete or duplicated');
      if (w.quality_0_to_3 !== null) {
        assert(agent.artifact_identity?.artifact_sha256, 'A numeric quality grade requires an actual saved submission/candidate artifact identity');
        assert(w.artifact_sha256 !== null, 'A numeric quality grade must identify the original submission/candidate artifact');
        assert(w.criterion_results.some(criterion => ['passed', 'failed'].includes(criterion.result) && criterion.evidence.length > 0), 'A numeric quality grade needs meaningful passed/failed criterion evidence');
        assert(w.artifact_sha256 === agent.artifact_identity.artifact_sha256, 'Assessment artifact_sha256 does not match the saved worker artifact');
      }
    }
  }
  assert(seen.size === report.agents.length, 'Assess every worker, including failures and skipped workers');
  const decisions = new Set();
  for (const d of input.decisions) {
    const agent = report.agents.find(a => a.id === d.agent_id);
    assert(agent, 'Unknown decision worker');
    assert(agent.submission?.findings?.some(f => f.id === d.finding_id), 'Decision must reference an actual submitted finding');
    const id = `${d.agent_id}:${d.finding_id}`;
    assert(!decisions.has(id), 'Duplicate finding decision'); decisions.add(id);
    assert(['accept','reject','defer'].includes(d.decision), 'Decision must be accept, reject, or defer');
    text(d.reason, 'decision reason', 8000); text(d.validation, 'independent validation', 8000); text(d.integration, 'integration', 8000);
  }
  // Every submitted finding must be dispositioned; a clean review can still score 1.
  for (const a of report.agents) for (const f of a.submission?.findings || []) assert(decisions.has(`${a.id}:${f.id}`), 'Every submitted finding needs an explicit decision, including defer');
  return structuredClone({ ...input, ...(input.schema_version === undefined ? {} : { schema_version: schemaVersion }) });
}
/**
 * Sum several run ledgers — the phases of one task — into one labelled total. Each run keeps
 * its own ledger; this only adds them, keeping provider-reported charges, unreconciled
 * estimates and unpriced requests apart, because "separate runs do not share a ledger" used
 * to mean the host summed four JSON files by hand.
 */
export function aggregateLedger(runs) {
  assert(Array.isArray(runs) && runs.length, 'At least one run is required');
  const keys = ['request_count', 'reconciled_request_count', 'provider_reported_usd', 'unresolved_request_count', 'estimated_unreconciled_usd', 'unpriced_request_count'];
  const totals = Object.fromEntries(keys.map(k => [k, 0]));
  const hosts = new Set();
  const rows = runs.map(r => {
    hosts.add(hostLabel(r.orchestrator || 'codex'));
    const c = r.costs || {};
    for (const k of keys) totals[k] += isNumber(c[k]) ? c[k] : 0;
    return {
      run_id: r.run_id, created_at: r.created_at ?? null, objective: r.objective ?? null,
      costs: Object.fromEntries(keys.map(k => [k, isNumber(c[k]) ? c[k] : 0])),
      agents: (r.agents || []).map(a => ({ id: a.id, status: a.status, failure_class: a.failure_class ?? null, usefulness: a.usefulness?.usefulness_0_to_3 ?? null }))
    };
  });
  // Sums of provider decimals accumulate binary noise; eight places is finer than any charge.
  for (const k of ['provider_reported_usd', 'estimated_unreconciled_usd']) totals[k] = Number(totals[k].toFixed(8));
  return {
    runs: rows,
    totals: { ...totals, all_requests_reconciled: totals.unresolved_request_count === 0 },
    label: `Pi delegation cost; excludes ${[...hosts].join(' / ')}`,
    note: 'Sum of separate run ledgers. Provider-reported charges and unreconciled estimates stay apart; an unpriced request is unknown, not zero. Reconcile each run first.'
  };
}
export function markdownReport(report, assessment = null) {
  if (assessment) validateAssessment(assessment, report);
  const c = report.costs, host = hostLabel(report.orchestrator);
  const lines = ['# pi session report', '', `Run: ${cell(report.run_id)}`, '', cell(report.objective), '',
    `**Pi delegation cost; excludes ${host}.**`, '',
    `Provider-reported charges: **${money(c.provider_reported_usd)}** across ${c.reconciled_request_count} reconciled request(s).`,
    `Unreconciled estimates: **${money(c.estimated_unreconciled_usd)}**. Unpriced requests: **${c.unpriced_request_count}**.`,
    `Total requests: ${c.request_count}. Fully reconciled: ${c.all_requests_reconciled ? 'yes' : 'no'}. Unknown is not zero; reservations are not charges.`, '',
    '| Worker / role | Model / provider | Access | Effort requested → effective | Status / seconds | Reported / estimated USD | Usefulness |',
    '| --- | --- | --- | --- | --- | --- | --- |'];
  for (const a of report.agents) {
    const w = assessment?.workers.find(w => w.agent_id === a.id), m=a.model || {}, cost=a.costs || {};
    const assessed = w ? `${w.usefulness_0_to_3}/3 — ${cell(w.reason)}${assessment?.schema_version === 2 ? `; quality ${w.quality_0_to_3 === null ? 'unknown' : `${w.quality_0_to_3}/3`}` : ''}` : `Not assessed by ${host}`;
    lines.push(`| ${cell(a.id)} / ${cell(a.role)} | ${cell(m.resolved_model || m.requested_model)} / ${cell(m.provider)} | ${cell(a.mode)} | ${cell(m.requested_effort)} → ${cell(m.effective_pi_effort)} | ${cell(a.status)} / ${cell(a.elapsed_seconds)} | ${money(cost.provider_reported_usd)} / ${money(cost.estimated_unreconciled_usd)} | ${assessed} |`);
  }
  lines.push('', '## Findings and decisions', '');
  for (const a of report.agents) {
    lines.push(`### ${cell(a.id)}`, '', cell(a.submission?.summary || 'No completed structured submission.'), '');
    if (a.status !== 'completed') {
      const diagnostic = a.stop_diagnostic || explainStop(a.status);
      lines.push(`**Incomplete: ${cell(a.status)} (${cell(diagnostic.layer)}).** ${cell(diagnostic.advice)}`, '');
    }
    if (a.limit_usage && a.limits) lines.push(`Allowance used: ${cell(a.limit_usage.requests)}/${cell(a.limits.max_turns)} provider requests; ${cell(a.limit_usage.tool_calls)}/${cell(a.limits.max_tool_calls)} tool calls; ${cell(a.limit_usage.elapsed_seconds)}/${cell(a.limits.timeout_seconds)} worker seconds. Completion repairs: ${cell(a.limit_usage.completion_repairs)}.`, '');
    if (a.finalization) lines.push(`Finalization trigger: ${cell(a.finalization.trigger)}. Reserved inside existing limits, not extra permission or budget.`, '');
    if (a.submission?.completion && a.submission.completion !== 'complete') lines.push(`Worker completion claim: ${cell(a.submission.completion)}. This is the worker's claim, not a validated outcome.`, '');
    if (a.submission?.remaining_work?.length) lines.push(`Remaining work (worker claim): ${a.submission.remaining_work.map(cell).join('; ')}`, '');
    if (!a.submission && a.partial_output?.text) lines.push(`Unvalidated public output${a.partial_output.truncated ? ' (truncated)' : ''}: ${cell(a.partial_output.text)}`, '');
    for (const f of a.submission?.findings || []) {
      const d = assessment?.decisions.find(d => d.agent_id === a.id && d.finding_id === f.id);
      lines.push(`**${cell(f.id)} — ${cell(f.title)}** (${cell(f.severity)}, worker confidence ${cell(f.confidence)})`, '',
        `Evidence location: ${cell(f.file)}:${cell(f.line)}. ${cell(f.evidence)}`, '',
        d ? `**${host}: ${d.decision}.** ${cell(d.reason)} Validation: ${cell(d.validation)} Integration: ${cell(d.integration)}` : '**Not independently assessed.**', '');
    }
    if (a.changes?.length) lines.push(`Candidate files: ${a.changes.map(x=>cell(x.file)).join(', ')}. The runner did not integrate them.`, '');
    if (a.coverage) lines.push(`Coverage log: ${a.coverage.reads.length} explicit read(s), ${a.coverage.searches.length} search(es). This measures retrieval, not comprehension.`, '');
    if (a.warnings?.length) lines.push(`Warnings: ${a.warnings.map(cell).join('; ')}`, '');
    if (a.failure_class && a.failure_class !== 'none') lines.push(`Failure class: ${cell(a.failure_class)} (suggested learning failure_kind: ${cell(a.suggested_learning_failure_kind)}). ${cell(a.failure_hint)}`, '');
    if (a.timing && isNumber(a.timing.mean_request_seconds)) lines.push(`Timing: ${a.timing.requests} request(s), mean ${a.timing.mean_request_seconds} s, max ${a.timing.max_request_seconds} s${a.deadline ? `; deadline warnings ${a.deadline.warnings}, tool calls refused in the finishing window ${a.deadline.refusals}` : ''}.`, '');
  }
  lines.push('## Overall value', '', assessment ? cell(assessment.overall_value) : `Awaiting ${host} assessment. Workers cannot grade themselves.`, '',
    `Workers cannot execute tests. Any tests mentioned in their submissions are proposals. Validation and integration statements above, when present, are supplied by ${host}, not automatically proven by this report renderer.`, '',
    `Snapshot current at runner completion: ${report.source_snapshot_still_current ?? 'unknown'}. Re-run verify immediately before integration.`, '');
  return lines.join('\n');
}
