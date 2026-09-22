import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { aggregateStats, recommendFromStats, statsMarkdown } from '../scripts/stats.mjs';
import { initLearning } from '../scripts/learning.mjs';
import { readRunInventory } from '../scripts/insights-store.mjs';
import { beginRunInventory, updateRunInventory } from '../scripts/insights-store.mjs';

const NOW = '2026-09-22T00:00:00Z';
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-stats-'));
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'README.md'), '# Synthetic fixture\n');
  initLearning(repo, { mode: 'propose' });
  const entries = [
    { id: 'run-a1', created: '2026-09-10', task: 'task-a', assignment: 'assign-a', quality: 2, usefulness: 3, cost: 0.10, tags: ['correctness', 'security'] },
    { id: 'run-a2', created: '2026-09-11', task: 'task-a', assignment: 'assign-a', quality: 3, usefulness: 2, cost: 0.20, tags: ['correctness', 'security'] },
    { id: 'run-b1', created: '2026-09-12', task: 'task-b', assignment: 'assign-b1', quality: 1, usefulness: 1, cost: 0.03, tags: ['correctness'] },
    { id: 'run-b2', created: '2026-09-13', task: 'task-b', assignment: 'assign-b2', quality: 1, usefulness: 1, cost: 0.04, tags: ['correctness'] },
    { id: 'run-c', created: '2026-09-14', task: 'task-c', assignment: 'assign-c', quality: null, usefulness: 2, cost: 0.05, tags: ['security'] },
    { id: 'run-unknown', created: '2026-09-15', task: 'task-d', assignment: null, quality: 3, usefulness: 3, cost: 0.06, tags: ['planning'] }
  ];
  for (const entry of entries) {
    const createdAt = `${entry.created}T10:00:00Z`, finishedAt = `${entry.created}T10:01:00Z`;
    const evaluation = { schema_version: 1, task_id: entry.task, task_type: 'bugfix', scope: 'src', complexity: 'bounded', strategy: 'single-review', strategy_version: 'v1', focus: entry.tags,
      workers: [{ agent_id: 'review', assignment_id: entry.assignment || null, attempt_index: 1, criteria: [{ id: 'review', requirement: 'Synthetic criterion' }] }] };
    const plan = { repo_root: repo, objective: 'Synthetic statistics fixture', orchestrator: 'codex', read_files: ['README.md'], policy: {}, agents: [{ id: 'review', role: 'correctness-review', task: 'Synthetic review', model: 'fixture/model-v1', provider: 'openrouter', mode: 'read', read_files: ['README.md'], write_files: [], effort: 'xhigh' }], evaluation };
    const report = { mode: 'pi_sdk', run_id: entry.id, created_at: createdAt, finished_at: finishedAt, source_repo: repo, orchestrator: 'codex', orchestrator_model: 'synthetic-host', orchestrator_version: 'fixture', evaluation,
      agents: [{ id: 'review', role: 'correctness-review', mode: 'read', status: entry.status || 'completed', model: { provider: 'openrouter', requested_model: 'fixture/model-v1', resolved_model: 'fixture/model-v1', canonical_slug: 'fixture/model-v1', requested_effort: 'xhigh', effective_pi_effort: 'xhigh' }, limits: { max_turns: 12 } }] };
    const usage = { requests: [{ agent_id: 'review', billed_usd: entry.cost, usage: { input: 0, output: 0, totalTokens: 0 } }] };
    const assessment = { run_id: entry.id, assessed_by: 'Codex', overall_value: 'Synthetic host assessment', decisions: [], workers: [{ agent_id: 'review', usefulness_0_to_3: entry.usefulness, quality_0_to_3: entry.quality, reason: 'Synthetic fixture', integration_status: 'candidate_only' }] };
    beginRunInventory(repo, { report, plan, usage });
    updateRunInventory(repo, { report, plan, usage, assessment, lifecycle: 'completed', assessmentStatus: 'valid', assessmentSchemaVersion: 2 });
  }
  const inventory = readRunInventory(repo);
  const projectId = inventory.project_id;
  // Legacy spend remains in the source union but the same run is deduplicated.
  const duplicate = inventory.runs.find(row => row.run_id === 'run-a2');
  writeJson(path.join(repo, '.pi/learning/history.json'), { schema_version: 1, project_id: projectId, runs: [{ key: duplicate.key, current: { ...duplicate, observations: duplicate.workers } }] });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, repo, projectId, runs: inventory.runs, entries };
}

test('aggregation keeps retries in cost, uses latest explicit assignments for task-balanced grades, and keeps overlap tags descriptive', t => {
  const f = fixture(t);
  const stats = aggregateStats({ repos: [f.repo], period: 'all', now: NOW });
  assert.equal(stats.summary.distinct_tasks, 4);
  assert.equal(stats.summary.latest_assignments, 4); // task-d rows are excluded from judged assignment metrics.
  assert.equal(stats.summary.quality.mean, 2); // task A=3, task B=(1+1)/2, task C unknown.
  assert.equal(stats.summary.quality.assessed, 2);
  assert.equal(stats.summary.quality.denominator, 3);
  assert.equal(stats.summary.usefulness.mean, 1.667); // A=2, B=1, C=2, balanced by task.
  assert.equal(stats.costs.request_count, 6);
  assert.equal(stats.costs.known_usd, 0.48);
  assert.equal(stats.summary.assignment_metadata_missing, 1);
  assert.equal(stats.focus_areas.find(row => row.tag === 'correctness').assignments, 3);
  assert.equal(stats.focus_areas.find(row => row.tag === 'security').assignments, 2);
  assert.equal(stats.models[0].total_attempts, 6);
  assert.equal(stats.models[0].retry_attempts, 1);
  assert.equal(stats.models[0].model.profile_schema_version, 2);
  assert.equal(stats.learning.projects[0].mode, 'propose');
  assert.equal(stats.learning.projects[0].status, 'completed');
});

test('unknown charge and token categories stay separate, with reasoning a subset of output', t => {
  const f = fixture(t);
  f.runs[0].workers[0].costs = { request_count: 1, provider_reported_usd: 0.1, reconciled_request_count: 1 };
  f.runs[0].workers[0].tokens = { input: 100, output: 40, reasoning: 10, cache_read: 20, cache_write: 5, total: 165, known_requests: { input: 1, output: 1, reasoning: 1, cache_read: 1, cache_write: 1, total: 1 } };
  f.runs[4].workers[0].costs = { request_count: 1, provider_reported_usd: null, unpriced_request_count: 1 };
  writeJson(path.join(f.repo, '.pi/learning/runs.json'), { schema_version: 1, project_id: f.projectId, runs: f.runs });
  const stats = aggregateStats({ repos: [f.repo], period: 'all', now: NOW });
  assert.equal(stats.costs.unknown_charge_requests, 1);
  assert.equal(stats.costs.token_totals.input, 100);
  assert.equal(stats.costs.token_totals.output, 40);
  assert.equal(stats.costs.token_totals.reasoning, 10);
  assert.equal(stats.costs.token_totals.cache_read, 20);
  assert.equal(stats.costs.token_totals.total, 165);
  assert.equal(stats.costs.token_totals.requests, 6);
  assert.match(stats.costs.note, /not summed twice/);
});

test('a newer raw assessment with an unknown grade does not resurrect a stale durable grade', t => {
  const f = fixture(t);
  const out = path.join(f.base, 'raw');
  writeJson(path.join(out, 'report.json'), { run_id: 'run-a2', mode: 'pi_sdk', source_repo: f.repo, created_at: '2026-09-11T10:00:00Z', finished_at: '2026-09-21T10:00:00Z', orchestrator: 'codex', agents: [{ id: 'review', role: 'reviewer', mode: 'read', status: 'completed', model: { provider: 'openrouter', requested_model: 'fixture/model-v1', resolved_model: 'fixture/model-v1', canonical_slug: 'fixture/model-v1', effective_pi_effort: 'xhigh' }, costs: { request_count: 1, provider_reported_usd: 0.22 } }] });
  writeJson(path.join(out, 'usage.json'), { requests: [{ agent_id: 'review', billed_usd: 0.22, usage: { input: 10, output: 4, totalTokens: 14 } }] });
  writeJson(path.join(out, 'plan.json'), { task_id: 'task-a', task_type: 'bugfix', scope: 'src', focus: ['correctness'], workers: [{ agent_id: 'review', assignment_id: 'assign-a' }] });
  writeJson(path.join(out, 'assessment.json'), { run_id: 'run-a2', assessed_by: 'Codex', overall_value: 'Synthetic raw assessment', decisions: [], workers: [{ agent_id: 'review', usefulness_0_to_3: 2, reason: 'Synthetic fixture' }], learning: { task_id: 'task-a', workers: [{ agent_id: 'review', role: 'correctness-review', assignment_id: 'assign-a' }] } });
  const stats = aggregateStats({ repos: [f.repo], out, period: 'all', now: NOW });
  const rawProfile = stats.models.find(row => row.raw_evidence_available);
  assert.ok(rawProfile);
  assert.equal(rawProfile.quality.mean, null); // The stale durable grade is not reused for the newer raw record.
  assert.equal(stats.evidence.kinds.raw, 1);
  assert.ok(stats.evidence.missing_raw_evidence_rows > 0);
});

test('foreign legacy history is excluded and reported instead of being relabeled', t => {
  const f = fixture(t);
  const foreign = { ...f.runs[0], key: 'foreign-run-key', run_id: 'foreign-run', project_id: 'foreign-project', observations: f.runs[0].workers };
  writeJson(path.join(f.repo, '.pi/learning/history.json'), {
    schema_version: 1,
    project_id: 'foreign-project',
    runs: [{ key: foreign.key, current: foreign }]
  });
  const stats = aggregateStats({ repos: [f.repo], period: 'all', now: NOW });
  assert.equal(stats.summary.assignments, 6);
  assert.equal(stats.costs.request_count, 6);
  assert.deepEqual(stats.evidence.legacy_projects, []);
  assert.match(stats.evidence.issues.join('\n'), /different project/);
});

test('a raw evaluation mismatch clears the grade while retaining its measured charge', t => {
  const f = fixture(t);
  const out = path.join(f.base, 'raw-mismatch');
  const evaluation = focus => ({ schema_version: 1, task_id: 'task-a', task_type: 'bugfix', scope: 'src', complexity: 'bounded', strategy: 'single-review', strategy_version: 'v1', focus,
    workers: [{ agent_id: 'review', assignment_id: 'assign-a', attempt_index: 1, criteria: [{ id: 'review', requirement: 'Synthetic criterion' }] }] });
  writeJson(path.join(out, 'report.json'), { run_id: 'run-a2', mode: 'pi_sdk', source_repo: f.repo, created_at: '2026-09-11T10:00:00Z', finished_at: '2026-09-21T10:00:00Z', orchestrator: 'codex', evaluation: evaluation(['security']), agents: [{ id: 'review', role: 'reviewer', mode: 'read', status: 'completed', model: { provider: 'openrouter', requested_model: 'fixture/model-v1', resolved_model: 'fixture/model-v1', canonical_slug: 'fixture/model-v1', effective_pi_effort: 'xhigh' } }] });
  writeJson(path.join(out, 'usage.json'), { requests: [{ agent_id: 'review', billed_usd: 0.22, usage: { input: 10, output: 4, totalTokens: 14 } }] });
  writeJson(path.join(out, 'plan.json'), { task_id: 'task-a', evaluation: evaluation(['correctness']), workers: [{ agent_id: 'review', assignment_id: 'assign-a' }] });
  writeJson(path.join(out, 'assessment.json'), { run_id: 'run-a2', assessed_by: 'Codex', overall_value: 'Synthetic raw assessment', decisions: [], workers: [{ agent_id: 'review', usefulness_0_to_3: 3, quality_0_to_3: 3, reason: 'Synthetic fixture' }] });
  const stats = aggregateStats({ repos: [f.repo], out, period: 'all', now: NOW });
  assert.equal(stats.costs.request_count, 6);
  assert.equal(stats.costs.known_usd, 0.5); // raw usage replaces the durable .20 charge for the same run.
  assert.equal(stats.summary.quality.assessed, 1); // task-a's newer mismatched assessment is unknown.
  assert.equal(stats.summary.usefulness.assessed, 2); // task-a is unknown; task-b and task-c remain measured.
  assert.match(stats.evidence.issues.join('\n'), /assessment is stale/);
  assert.equal(stats.evidence.kinds.raw, 1);
  assert.equal(stats.models[0].quality.assessed, 1);
});

test('an empty per-worker ledger does not reuse a team report charge', t => {
  const f = fixture(t);
  const out = path.join(f.base, 'raw-team');
  const model = { provider: 'openrouter', requested_model: 'fixture/model-v1', resolved_model: 'fixture/model-v1', canonical_slug: 'fixture/model-v1', effective_pi_effort: 'xhigh' };
  writeJson(path.join(out, 'report.json'), { run_id: 'run-team', mode: 'pi_sdk', source_repo: f.repo, created_at: '2026-09-20T10:00:00Z', finished_at: '2026-09-20T10:01:00Z', orchestrator: 'codex', costs: { request_count: 2, provider_reported_usd: 0.4 }, agents: [
    { id: 'first', role: 'reviewer', mode: 'read', status: 'completed', model },
    { id: 'skipped', role: 'reviewer', mode: 'read', status: 'not_started', model, costs: { request_count: 2, provider_reported_usd: 0.4 } }
  ] });
  writeJson(path.join(out, 'usage.json'), { requests: [{ agent_id: 'first', billed_usd: 0.2, usage: { input: 10, output: 4, totalTokens: 14 } }] });
  const stats = aggregateStats({ repos: [f.repo], out, period: 'all', now: NOW });
  assert.equal(stats.costs.request_count, 7); // six durable fixture requests plus one raw ledger request.
  assert.equal(stats.costs.known_usd, 0.68);
  assert.equal(stats.evidence.kinds.raw, 2);
});

test('recommendation stays inside configured model pool and explains sparse evidence without ranking causally', t => {
  const f = fixture(t);
  const stats = aggregateStats({ repos: [f.repo], period: '90d', now: NOW });
  const plan = { __file: '/tmp/synthetic.plan.json', orchestrator: 'codex', policy: { preferred_provider: 'openrouter', preferred_models: ['fixture/model-v1', 'fixture/model-v2'] }, agents: [{ id: 'review', role: 'correctness-review', model: 'fixture/model-v1', effort: 'xhigh', task_type: 'bugfix', scope: 'src', focus: ['correctness'] }] };
  const result = recommendFromStats(stats, plan);
  assert.equal(result.recommendations[0].authorized_candidates.length, 2);
  assert.equal(result.recommendations[0].shortlist.some(row => row.configured_model === 'fixture/model-v2'), true);
  assert.equal(result.evidence.causal_model_ranking, false);
  assert.equal(result.evidence.no_new_permissions_effort_budget_or_model_exceptions, true);
  assert.equal(result.evidence.exact_configuration_view, false);
  assert.equal(Object.hasOwn(result.evidence, 'exact_profile_matches'), false);
});

test('durable host metadata remains visible without claiming an exact learning profile', t => {
  const f = fixture(t);
  f.runs[0].host = { ...f.runs[0].host, skill_version: 'synthetic-skill', sdk_version_target: 'synthetic-sdk' };
  writeJson(path.join(f.repo, '.pi/learning/runs.json'), { schema_version: 1, project_id: f.projectId, runs: f.runs });
  const stats = aggregateStats({ repos: [f.repo], period: 'all', now: NOW });
  const hostProfile = stats.models.find(row => row.model.skill_version === 'synthetic-skill');
  assert.ok(hostProfile);
  assert.equal(hostProfile.model.sdk_version, 'synthetic-sdk');
  assert.equal(hostProfile.model.host_version, 'fixture');
  assert.deepEqual(hostProfile.profile_ids, []);
  assert.equal(hostProfile.single_known_profile_id, null);
  const plan = { __file: '/tmp/synthetic.plan.json', orchestrator: 'codex', policy: { preferred_provider: 'openrouter', preferred_models: ['fixture/model-v1'] }, agents: [{ id: 'review', role: 'correctness-review', model: 'fixture/model-v1', effort: 'xhigh', task_type: 'bugfix', scope: 'src', focus: ['correctness'] }] };
  const result = recommendFromStats(stats, plan);
  assert.equal(result.evidence.exact_configuration_view, false);
  assert.equal(result.evidence.descriptive_model_focus_view, true);
});

test('raw and durable records keep the same model facts and normalized recommendation dimensions', t => {
  const f = fixture(t);
  const run = f.runs[0];
  const limits = { max_turns: 12, max_tool_calls: 30, timeout_seconds: 600, request_timeout_seconds: 600, max_output_tokens: 32768, per_agent_budget_usd: 2 };
  const evaluation = { schema_version: 1, task_id: run.task_id, task_type: 'bugfix', scope: 'src', complexity: 'bounded', strategy: 'single-review', strategy_version: 'v1', focus: ['completeness', 'correctness'],
    workers: [{ agent_id: 'review', assignment_id: 'assign-a', attempt_index: 1, criteria: [{ id: 'review', requirement: 'Synthetic criterion' }] }] };
  for (const item of f.runs) item.lifecycle = 'finalized';
  run.host = { ...run.host, skill_version: 'synthetic-skill', sdk_version_target: 'synthetic-sdk' };
  run.evaluation = evaluation;
  run.workers[0].limits = limits;
  run.workers[0].upstream_providers = ['StreamLake'];
  writeJson(path.join(f.repo, '.pi/learning/runs.json'), { schema_version: 1, project_id: f.projectId, runs: f.runs });
  const durable = aggregateStats({ repos: [f.repo], period: 'all', now: NOW });
  const out = path.join(f.base, 'raw-equivalent');
  const model = { provider: 'openrouter', requested_model: 'fixture/model-v1', resolved_model: 'fixture/model-v1', canonical_slug: 'fixture/model-v1', requested_effort: 'xhigh', effective_pi_effort: 'xhigh' };
  const report = { mode: 'pi_sdk', run_id: run.run_id, created_at: run.created_at, finished_at: run.finished_at, source_repo: f.repo, orchestrator: 'codex', orchestrator_model: 'synthetic-host', orchestrator_version: 'fixture', skill_version: 'synthetic-skill', sdk_version_target: 'synthetic-sdk', evaluation,
    agents: [{ id: 'review', role: 'correctness-review', mode: 'read', status: 'completed', model, limits }] };
  writeJson(path.join(out, 'report.json'), report);
  writeJson(path.join(out, 'plan.json'), { repo_root: f.repo, evaluation, agents: [{ id: 'review', role: 'correctness-review', model: 'fixture/model-v1', provider: 'openrouter', mode: 'read', limits }] });
  writeJson(path.join(out, 'usage.json'), { requests: [{ agent_id: 'review', provider: 'openrouter', upstream_provider: 'StreamLake', billed_usd: 0.10, usage: { input: 10, output: 4, totalTokens: 14 } }] });
  writeJson(path.join(out, 'assessment.json'), { schema_version: 2, run_id: run.run_id, assessed_by: 'Codex', overall_value: 'Synthetic raw assessment', decisions: [], workers: [{ agent_id: 'review', usefulness_0_to_3: 2, quality_0_to_3: null, quality_reason: 'No numeric quality grade in this synthetic record.', criterion_results: [{ id: 'review', result: 'inconclusive', evidence: [] }], artifact_sha256: null, integration_status: 'not_applicable', reason: 'Synthetic fixture' }] });
  const joined = aggregateStats({ repos: [f.repo], out, period: 'all', now: NOW });
  const durableModel = durable.models.find(row => row.model.skill_version === 'synthetic-skill');
  const joinedModel = joined.models.find(row => row.model.skill_version === 'synthetic-skill');
  assert.ok(durableModel && joinedModel);
  assert.equal(joined.evidence.invalid_assessment_rows, 0);
  assert.equal(joined.evidence.kinds.raw, 1);
  assert.deepEqual(joinedModel.model, durableModel.model);
  assert.equal(joinedModel.profile_key, durableModel.profile_key);
  for (const key of ['upstream_providers', 'runtime_limits', 'profile_schema_version', 'skill_version', 'sdk_version']) assert.deepEqual(joinedModel.model[key], durableModel.model[key]);
  assert.equal(joined.learning.projects[0].lifecycle, 'finalized');
  const plan = { orchestrator: 'codex', policy: { preferred_provider: 'openrouter', preferred_models: ['fixture/model-v1'], max_turns: 12, max_tool_calls: 30, timeout_seconds: 600, request_timeout_seconds: 600, max_output_tokens: 32768, per_agent_budget_usd: 2 }, evaluation,
    agents: [{ id: 'review', role: 'correctness-review', model: 'fixture/model-v1', provider: 'openrouter', mode: 'read', effort: 'xhigh' }] };
  const durableRecommendation = recommendFromStats(durable, plan);
  const joinedRecommendation = recommendFromStats(joined, plan);
  const durableAdvice = durableRecommendation.recommendations[0].shortlist.find(row => row.profile_key === durableModel.profile_key);
  const joinedAdvice = joinedRecommendation.recommendations[0].shortlist.find(row => row.profile_key === joinedModel.profile_key);
  assert.ok(durableAdvice && joinedAdvice);
  for (const advice of [durableAdvice, joinedAdvice]) assert.equal(advice.dimensions.some(dimension => ['focus tags', 'runtime limits'].includes(dimension.label) && dimension.status !== 'match'), false);
});

test('an explicitly empty raw ledger replaces, rather than resurrects, durable run cost', t => {
  const f = fixture(t);
  const out = path.join(f.base, 'raw-empty-ledger');
  writeJson(path.join(out, 'report.json'), { run_id: 'run-a2', mode: 'pi_sdk', source_repo: f.repo, created_at: '2026-09-11T10:00:00Z', finished_at: '2026-09-21T10:00:00Z', orchestrator: 'codex', costs: { request_count: 9, provider_reported_usd: 9 }, agents: [{ id: 'review', role: 'reviewer', mode: 'read', status: 'completed', model: { provider: 'openrouter', requested_model: 'fixture/model-v1', resolved_model: 'fixture/model-v1', canonical_slug: 'fixture/model-v1', effective_pi_effort: 'xhigh' } }] });
  writeJson(path.join(out, 'usage.json'), { requests: [] });
  const stats = aggregateStats({ repos: [f.repo], out, period: 'all', now: NOW });
  assert.equal(stats.costs.request_count, 5);
  assert.equal(stats.costs.known_usd, 0.28);
});

test('markdown reports unknown denominators and stable project identity', t => {
  const f = fixture(t);
  const markdown = statsMarkdown(aggregateStats({ repos: [f.repo], period: '30d', now: NOW }));
  assert.match(markdown, /repo/);
  assert.match(markdown, /assessed/);
  assert.match(markdown, /Observational evidence/);
});
