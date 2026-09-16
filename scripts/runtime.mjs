/** Dependency-free stop diagnostics and deadline arithmetic. No inference, source writes, or hidden-reasoning storage. */
import fs from 'node:fs';
import path from 'node:path';
import { workerPolicy, classifyStop, isNumber } from './lib.mjs';

export const RUNTIME_LIMIT_KEYS = [
  'max_turns', 'max_tool_calls', 'timeout_seconds', 'request_timeout_seconds',
  'stream_idle_timeout_seconds', 'finalization_turns', 'finalization_seconds',
  'max_completion_repairs', 'heartbeat_seconds', 'per_agent_budget_usd', 'session_budget_usd'
];
export function runtimeLimits(policy, maxOutputTokens = policy.max_output_tokens) {
  return Object.fromEntries(RUNTIME_LIMIT_KEYS.map(k => [k, policy[k]]).concat([['max_output_tokens', maxOutputTokens]]));
}
/**
 * The finishing allowance reserved *inside* the authorized ceilings, never added to them.
 * Turns cannot consume the only request; the time reserve is capped at a quarter of the worker
 * lifetime so a short timeout does not start in finalization.
 */
export function finalizationReserve(policy) {
  return {
    turns: Math.min(policy.finalization_turns ?? 0, Math.max(0, policy.max_turns - 1)),
    seconds: Math.min(policy.finalization_seconds ?? 0, policy.timeout_seconds / 4)
  };
}
export function shouldFinalize(policy, requests, toolCalls, elapsedSeconds) {
  const { turns, seconds } = finalizationReserve(policy);
  return (turns > 0 && requests >= policy.max_turns - turns) ||
    toolCalls >= policy.max_tool_calls - 1 ||
    (seconds > 0 && elapsedSeconds >= policy.timeout_seconds - seconds);
}
export function publicText(message, redact = s => s, limit = 2000) {
  // Never persist thinking blocks, signatures, tool arguments, or provider raw payloads.
  let text = '', truncated = false;
  for (const part of message?.content || []) if (part.type === 'text' && typeof part.text === 'string') {
    const remaining = Math.max(0, limit - text.length);
    text += part.text.slice(0, remaining);
    if (part.text.length > remaining) truncated = true;
  }
  // The redactor imposes its own bound, so never report a complete excerpt that it shortened.
  const redacted = redact(text);
  return { text: redacted, truncated: truncated || redacted.length < text.length };
}
export function isExplicitRefusal(message) {
  if (message?.refusal || message?.content?.some(p => p.type === 'refusal')) return true;
  // Conservative best-effort detection for SDKs that represent provider refusals as text.
  const text = publicText(message).text.trim();
  return /^(?:(?:i(?:'m| am) sorry|sorry)[,.!]?\s*(?:but\s*)?)?i (?:cannot|can't|won't|am unable to) (?:help|assist|comply|fulfill)\b/i.test(text);
}
/**
 * Which layer of the system stopped the worker, and what the host should do about it. This
 * answers "where did it stop"; `classifyStop` in lib.mjs answers "does this say anything about
 * the model, and may it be retried". Every status must appear in both tables.
 */
const STOPS = {
  completed: ['complete_claim', 'A structured completion claim was received. The host still must validate the result.'],
  partial: ['partial', 'The worker declared unfinished work. Review remaining_work and the checkpoint; do not call it complete.'],
  blocked: ['blocked', 'The worker declared a blocker. The host must resolve or repacket it without increasing worker authority implicitly.'],
  timeout: ['worker_wall_time', 'The total worker deadline expired. Split the task or explicitly authorize a longer worker limit and a compatible host-command lifetime.'],
  request_timeout: ['request_wall_time', 'One provider request exceeded request_timeout_seconds. Check request timing/provider availability before increasing it.'],
  stream_idle_timeout: ['provider_inactivity', 'No SDK provider event arrived within the opt-in idle window. This does not prove the model was idle; hidden reasoning may produce no visible events.'],
  turn_limit: ['request_count', 'max_turns counts provider requests, including tool iterations and completion repairs, not just user tasks. Narrow the work or explicitly increase the allocation.'],
  tool_limit: ['tool_count', 'The tool allowance is exhausted. Check repeated reads/errors and narrow the packet.'],
  budget_limit: ['budget', 'The worker or run soft budget has been reached. Reconcile unresolved costs before authorizing more spending.'],
  budget_reservation_limit: ['budget_reservation', 'The next conservative input plus maximum-output reservation would exceed remaining budget. This is not proof that the budget was actually spent. Inspect last_admission.'],
  context_limit: ['context_guard', 'The conservative byte-based context guard rejected the request. It is not an exact token count. Repacket with fewer files/shorter excerpts; do not silently discard constraints.'],
  output_limit: ['output_tokens', 'The provider returned length: reasoning and visible output may share the output-token allowance. Inspect usage; large edits should use smaller replacements. No truncated tool call may execute.'],
  missing_submission: ['completion_protocol', 'The model stopped without a valid submit_result, and bounded completion repair did not produce one. Inspect public output and candidate checkpoints.'],
  model_mismatch: ['identity', 'A returned model identity differs from the authorized catalog identities. No automatic fallback or retry is permitted.'],
  policy_violation: ['permissions', 'A worker attempted an unauthorized file action. No automatic continuation; inspect the denial and preserved candidates.'],
  refusal: ['refusal', 'A provider/worker refusal was observed. Do not retry to circumvent it.'],
  cancelled: ['external_signal', 'Cancellation was requested (for example by the host or user). A caught signal does not identify who sent it. No automatic restart.'],
  aborted: ['provider_or_external_abort', 'The provider/SDK reported an abort. Compare worker/request timers and the host-command result; do not assume a specific cause.'],
  error: ['provider_or_runtime', 'Inspect the sanitized warning and request status. Authentication/routing/context errors are not solved by blind retries.'],
  orchestration_error: ['runner', 'The runner failed outside a normal worker result. Inspect orchestration_errors before any retry.'],
  running: ['unfinished', 'No final worker result is recorded. It may still be running or may have been killed. Check the host task handle and last checkpoint; do not launch a duplicate blindly.'],
  starting: ['unfinished', 'The worker has not reached a final checkpoint. Check the host-command result.'],
  not_started: ['not_started', 'This worker was not launched; inspect the recorded reason and preceding workers.']
};
export const STOP_STATUSES = Object.freeze(Object.keys(STOPS));
export function explainStop(status) {
  const [layer, advice] = STOPS[status] || ['unknown', 'This status is not recognized by this version. Retain artifacts and inspect the host-command result.'];
  return { layer, advice };
}
export function diagnoseRun(directory) {
  // This runs on artifacts of runs that already went wrong, so every optional part is read
  // defensively: a missing or malformed section is reported as unknown, never as a crash.
  const load = (name, fallback) => {
    try { return JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')); }
    catch (e) { if (fallback === undefined) throw e; return fallback; }
  };
  const report = load('report.json');
  const plan = load('plan.json', {});
  const usage = load('usage.json', { requests: [] });
  const requests = Array.isArray(usage.requests) ? usage.requests : [];
  return {
    run_id: report.run_id, skill_version: report.skill_version || 'unknown', finished: Boolean(report.finished_at),
    last_updated_at: report.updated_at || report.finished_at || report.created_at,
    cancellation_signal: report.cancellation_signal || null,
    orchestration_errors: report.orchestration_errors || [],
    note: 'Local artifact diagnosis, not proof of the cause of an external kill. No network or paid inference. Older 1.2.0/1.3.0 artifacts are supported; fields those runners never captured stay unknown.',
    workers: (report.agents || []).map(a => {
      const spec = (plan.agents || []).find(s => s.id === a.id);
      const records = requests.filter(r => r.agent_id === a.id);
      // A per-worker allocation from a partial artifact must not make diagnosis itself fail.
      let limits = a.limits;
      if (!limits) {
        try { limits = runtimeLimits(workerPolicy(plan.policy || {}, spec?.limits), a.model?.max_output_tokens); }
        catch { limits = runtimeLimits(plan.policy || {}, a.model?.max_output_tokens); }
      }
      // Old artifacts predate the recorded classification; derive it from what they do carry.
      const classification = a.failure_class ? { failure_class: a.failure_class, failure_hint: a.failure_hint ?? null, suggested_learning_failure_kind: a.suggested_learning_failure_kind ?? null }
        : classifyStop({ status: a.status, warnings: a.warnings || [], usage: records.at(-1)?.usage ?? null, max_output_tokens: limits.max_output_tokens, timing: a.timing ?? null, finalization_seconds: limits.finalization_seconds, timeout: limits.timeout_seconds });
      return {
        id: a.id, status: a.status, reason: a.reason || null, ...explainStop(a.status), ...classification,
        limits,
        usage: a.limit_usage || { requests: records.length, tool_calls: null, elapsed_seconds: a.elapsed_seconds },
        timing: a.timing || null, deadline: a.deadline || null,
        stop_causes: a.stop_causes || [], last_admission: a.last_admission || null,
        last_activity_at: a.last_activity_at || null, last_provider_event_at: a.last_provider_event_at || null,
        finalization: a.finalization || null, recovery_events: a.recovery_events || [],
        candidate_changes: a.changes || [], submission_completion: a.submission?.completion || null,
        remaining_work: a.submission?.remaining_work || [],
        partial_output: a.partial_output || null,
        warnings: a.warnings || [],
        requests: records.map(r => ({ id: r.id, status: r.status, response_id: r.response_id,
          started_at: r.started_at, finished_at: r.finished_at, request_timeout_seconds: r.request_timeout_seconds,
          seconds: isNumber(r.seconds) ? r.seconds : null,
          usage: r.usage, billed_usd: r.billed_usd, estimate_usd: r.estimate_usd, reserved_usd: r.reserved_usd }))
      };
    })
  };
}
