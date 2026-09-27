/** Render measured facts separately from the host's explicitly supplied judgments. */
import { assert, text, isNumber, hostLabel } from './lib.mjs';
import { explainStop } from './runtime.mjs';
const cell = value => String(value ?? 'unknown').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '');
const money = n => isNumber(n) ? `$${n.toFixed(6)}` : 'unknown';
const HEX64 = /^[a-f0-9]{64}$/;
const CRITERION_RESULTS = new Set(['passed', 'failed', 'inconclusive', 'not_run']);
const INTEGRATION_STATUSES = new Set(['not_assessed', 'not_applicable', 'candidate_only', 'accepted_modified', 'accepted_unmodified', 'rejected', 'deferred', 'unknown']);
const WORKER_V2_FIELDS = ['agent_id', 'usefulness_0_to_3', 'reason', 'unique_validated_findings', 'duplicate_findings', 'unverified_findings', 'quality_0_to_3', 'quality_reason', 'criterion_results', 'artifact_sha256', 'integration_status'];
const object = (value, label) => assert(value && typeof value === 'object' && !Array.isArray(value), `${label}: expected an object`);
const enumMessage = (label, value, allowed) => `${label}: received ${JSON.stringify(value)}; expected one of ${[...allowed].join(', ')}`;

/** Validate local assessment structure without claiming a run, artifact, or finding was verified. */
export function validateAssessmentShape(input) {
  object(input, 'assessment');
  const schemaVersion = input.schema_version ?? 1;
  assert(schemaVersion === 1 || schemaVersion === 2, enumMessage('assessment.schema_version', schemaVersion, [1, 2]));
  text(input.run_id, 'assessment.run_id');
  assert(['Codex', 'Claude Code'].includes(input.assessed_by), enumMessage('assessment.assessed_by', input.assessed_by, ['Codex', 'Claude Code']));
  text(input.overall_value, 'assessment.overall_value', 8000);
  assert(Array.isArray(input.workers), 'assessment.workers: expected an array');
  assert(Array.isArray(input.decisions) && input.decisions.length <= 1000, 'assessment.decisions: expected an array with at most 1000 items');
  const seen = new Set();
  for (const [index, w] of input.workers.entries()) {
    const label = `assessment.workers[${index}]`;
    object(w, label);
    text(w.agent_id, `${label}.agent_id`);
    assert(!seen.has(w.agent_id), `${label}.agent_id: duplicate assessment worker ${JSON.stringify(w.agent_id)}`); seen.add(w.agent_id);
    assert(Number.isInteger(w.usefulness_0_to_3) && w.usefulness_0_to_3 >= 0 && w.usefulness_0_to_3 <= 3, `${label}.usefulness_0_to_3: expected an integer from 0 to 3`);
    text(w.reason, `${label}.reason`, 8000);
    for (const key of ['unique_validated_findings', 'duplicate_findings', 'unverified_findings']) if (w[key] !== undefined) assert(Number.isInteger(w[key]) && w[key] >= 0, `${label}.${key}: expected a nonnegative integer`);
    if (schemaVersion === 2) {
      for (const key of Object.keys(w)) assert(WORKER_V2_FIELDS.includes(key), `${label}.${key}: unknown assessment v2 worker field; allowed fields: ${WORKER_V2_FIELDS.join(', ')}`);
      assert(Object.hasOwn(w, 'quality_0_to_3'), `${label}.quality_0_to_3: required (use null when unknown)`);
      assert(w.quality_0_to_3 === null || (Number.isInteger(w.quality_0_to_3) && w.quality_0_to_3 >= 0 && w.quality_0_to_3 <= 3), `${label}.quality_0_to_3: expected an integer from 0 to 3 or null`);
      text(w.quality_reason, `${label}.quality_reason`, 4000);
      assert(Array.isArray(w.criterion_results) && w.criterion_results.length <= 8, `${label}.criterion_results: expected an array with at most 8 items`);
      const ids = new Set();
      for (const [criterionIndex, criterion] of w.criterion_results.entries()) {
        const criterionLabel = `${label}.criterion_results[${criterionIndex}]`;
        object(criterion, criterionLabel);
        for (const key of Object.keys(criterion)) assert(['id', 'result', 'evidence'].includes(key), `${criterionLabel}.${key}: unknown criterion result field; allowed fields: id, result, evidence`);
        text(criterion.id, `${criterionLabel}.id`, 64);
        assert(!ids.has(criterion.id), `${criterionLabel}.id: duplicate criterion result ${JSON.stringify(criterion.id)}`); ids.add(criterion.id);
        assert(CRITERION_RESULTS.has(criterion.result), enumMessage(`${criterionLabel}.result`, criterion.result, CRITERION_RESULTS));
        assert(Array.isArray(criterion.evidence) && criterion.evidence.length <= 4, `${criterionLabel}.evidence: expected an array with at most 4 nonempty strings, each at most 1200 characters`);
        for (const [evidenceIndex, evidence] of criterion.evidence.entries()) text(evidence, `${criterionLabel}.evidence[${evidenceIndex}]`, 1200);
        if (criterion.result === 'passed' || criterion.result === 'failed') assert(criterion.evidence.length > 0, `${criterionLabel}.evidence: passed/failed criteria require at least 1 evidence string (maximum 4)`);
      }
      assert(w.artifact_sha256 === null || (typeof w.artifact_sha256 === 'string' && HEX64.test(w.artifact_sha256)), `${label}.artifact_sha256: expected 64 lowercase SHA-256 hex characters or null`);
      assert(INTEGRATION_STATUSES.has(w.integration_status), enumMessage(`${label}.integration_status`, w.integration_status, INTEGRATION_STATUSES));
      if (w.quality_0_to_3 !== null) {
        assert(w.artifact_sha256 !== null, `${label}.artifact_sha256: a numeric quality grade must identify the original submission/candidate artifact`);
        assert(w.criterion_results.some(criterion => ['passed', 'failed'].includes(criterion.result) && criterion.evidence.length > 0), `${label}.criterion_results: a numeric quality grade needs meaningful passed/failed criterion evidence`);
      }
    }
  }
  const decisions = new Set();
  for (const [index, d] of input.decisions.entries()) {
    const label = `assessment.decisions[${index}]`;
    object(d, label);
    text(d.agent_id, `${label}.agent_id`); text(d.finding_id, `${label}.finding_id`);
    const id = JSON.stringify([d.agent_id, d.finding_id]);
    assert(!decisions.has(id), `${label}: duplicate finding decision`); decisions.add(id);
    assert(['accept', 'reject', 'defer'].includes(d.decision), enumMessage(`${label}.decision`, d.decision, ['accept', 'reject', 'defer']));
    text(d.reason, `${label}.reason`, 8000); text(d.validation, `${label}.validation`, 8000); text(d.integration, `${label}.integration`, 8000);
  }
  return structuredClone({ ...input, ...(input.schema_version === undefined ? {} : { schema_version: schemaVersion }) });
}

/** Full validation also binds the assessment to the run's original host and actual evidence. */
export function validateAssessment(input, report) {
  const checked = validateAssessmentShape(input);
  const host = hostLabel(report.orchestrator);
  assert(input.run_id === report.run_id, `assessment.run_id: expected this run ${JSON.stringify(report.run_id)}`);
  assert(input.assessed_by === host, `assessment.assessed_by: expected the run's primary host ${host}`);
  assert(input.workers.length === report.agents.length, `assessment.workers: assess every worker, including failures and skipped workers (expected ${report.agents.length})`);
  for (const [index, w] of input.workers.entries()) {
    const label = `assessment.workers[${index}]`, agent = report.agents.find(a => a.id === w.agent_id);
    assert(agent, `${label}.agent_id: unknown assessment worker ${JSON.stringify(w.agent_id)}`);
    if (input.schema_version === 2) {
      const expected = report.evaluation?.workers?.find(item => item.agent_id === w.agent_id)?.criteria || [];
      assert(report.evaluation && expected.length > 0, `${label}.criterion_results: assessment v2 requires the preregistered plan evaluation and criteria`);
      const expectedIds = new Set(expected.map(item => item.id));
      assert(w.criterion_results.length === expectedIds.size, `${label}.criterion_results: report every preregistered criterion exactly once (expected ${expectedIds.size}: ${[...expectedIds].join(', ')})`);
      for (const [criterionIndex, criterion] of w.criterion_results.entries()) assert(expectedIds.has(criterion.id), `${label}.criterion_results[${criterionIndex}].id: not in the plan evaluation; expected one of ${[...expectedIds].join(', ')}`);
      if (w.quality_0_to_3 !== null) {
        assert(agent.artifact_identity?.artifact_sha256, `${label}.quality_0_to_3: a numeric quality grade requires an actual saved submission/candidate artifact identity`);
        assert(w.artifact_sha256 === agent.artifact_identity.artifact_sha256, `${label}.artifact_sha256: does not match the saved worker artifact`);
      }
    }
  }
  const decisions = new Set();
  for (const [index, d] of input.decisions.entries()) {
    const label = `assessment.decisions[${index}]`, agent = report.agents.find(a => a.id === d.agent_id);
    assert(agent, `${label}.agent_id: unknown decision worker ${JSON.stringify(d.agent_id)}`);
    assert(agent.submission?.findings?.some(f => f.id === d.finding_id), `${label}.finding_id: must reference an actual submitted finding for this worker`);
    decisions.add(JSON.stringify([d.agent_id, d.finding_id]));
  }
  // Every submitted finding must be dispositioned; a clean review can still score 1.
  for (const a of report.agents) for (const f of a.submission?.findings || []) assert(decisions.has(JSON.stringify([a.id, f.id])), `assessment.decisions: every submitted finding needs an explicit decision, including defer (missing ${a.id}/${f.id})`);
  return checked;
}

/** Machine-readable shape aid. Cross-file evidence checks still require validateAssessment. */
export function assessmentSchema() {
  const string = maxLength => ({ type: 'string', minLength: 1, maxLength, pattern: String.raw`\S` });
  const score = { type: 'integer', minimum: 0, maximum: 3 };
  const worker = {
    type: 'object', required: ['agent_id', 'usefulness_0_to_3', 'reason'],
    properties: {
      agent_id: string(80000), usefulness_0_to_3: score, reason: string(8000),
      ...Object.fromEntries(['unique_validated_findings', 'duplicate_findings', 'unverified_findings'].map(key => [key, { type: 'integer', minimum: 0 }]))
    }
  };
  const criterion = { type: 'object', additionalProperties: false, required: ['id', 'result', 'evidence'], properties: {
    id: string(64), result: { enum: [...CRITERION_RESULTS] }, evidence: { type: 'array', maxItems: 4, items: string(1200) }
  }, allOf: [{ if: { properties: { result: { enum: ['passed', 'failed'] } } }, then: { properties: { evidence: { minItems: 1 } } } }] };
  const workerV2 = { ...worker, additionalProperties: false, required: [...worker.required, 'quality_0_to_3', 'quality_reason', 'criterion_results', 'artifact_sha256', 'integration_status'], properties: {
    ...worker.properties, quality_0_to_3: { anyOf: [score, { type: 'null' }] }, quality_reason: string(4000),
    criterion_results: { type: 'array', maxItems: 8, items: criterion },
    artifact_sha256: { anyOf: [{ type: 'string', pattern: '^[a-f0-9]{64}$' }, { type: 'null' }] }, integration_status: { enum: [...INTEGRATION_STATUSES] }
  }, allOf: [{ if: { properties: { quality_0_to_3: { type: 'integer' } } }, then: { properties: {
    artifact_sha256: { type: 'string' }, criterion_results: { contains: { properties: { result: { enum: ['passed', 'failed'] }, evidence: { minItems: 1 } } } }
  } } }] };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema', title: 'Pi host assessment (shape only)',
    description: 'Local shape validation does not verify run identity, assessor authority, original artifact hashes, criterion coverage, finding references, or duplicate identities. Use validateAssessment against the saved run before integration or learning.',
    type: 'object', required: ['run_id', 'assessed_by', 'overall_value', 'workers', 'decisions'],
    properties: {
      schema_version: { enum: [1, 2, null], default: 1, description: 'Omitted or null retains the legacy schema-1 default.' }, run_id: string(80000), assessed_by: { enum: ['Codex', 'Claude Code'] }, overall_value: string(8000),
      workers: { type: 'array', items: worker }, decisions: { type: 'array', maxItems: 1000, items: { type: 'object', required: ['agent_id', 'finding_id', 'decision', 'reason', 'validation', 'integration'], properties: {
        agent_id: string(80000), finding_id: string(80000), decision: { enum: ['accept', 'reject', 'defer'] }, reason: string(8000), validation: string(8000), integration: string(8000)
      } } }
    },
    allOf: [{ if: { required: ['schema_version'], properties: { schema_version: { const: 2 } } }, then: { properties: { workers: { items: workerV2 } } } }]
  };
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
