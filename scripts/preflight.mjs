/** Local planning advice only. No inference, model ranking, or increased allocations. */
import { workerPolicy } from './lib.mjs';
import { finalizationReserve } from './runtime.mjs';

// A numeric cap in either the shared context or the worker task is sufficient.
// Merely mentioning findings/words is not itself a submission bound.
const HAS_SUBMISSION_CAP = /\b\d[\d,]*\s*(?:words?|findings|characters?|tokens?)\b/i;

/** Accept a validated plan and optional resolved metadata rows from `check`. */
export function preflightAdvice(plan, models = []) {
  const advice = [];
  for (const agent of plan.agents) {
    const policy = workerPolicy(plan.policy, agent.limits);
    const reserve = finalizationReserve(policy);
    const workingRequests = policy.max_turns - reserve.turns;
    const model = models.find(row => row.agent === agent.id);
    if (model?.effort_mapping && model.effort_mapping !== 'exact') advice.push(`${agent.id}: requested ${model.requested_effort} is not supported; the run will be reported as ${model.effective_pi_effort}. Do not describe it as ${model.requested_effort}.`);
    if (agent.read_files.length > 8 && policy.timeout_seconds <= 600) advice.push(`${agent.id}: ${agent.read_files.length} files against timeout_seconds ${policy.timeout_seconds}. On a slow route each request can take minutes; consider fewer files, an explicitly authorized longer timeout, or splitting the work into scout and implementation phases.`);
    if (agent.mode === 'write' && workingRequests < 25) advice.push(`${agent.id}: ${policy.max_turns} provider requests leave ${workingRequests} investigation/edit request(s) before ${reserve.turns} reserved finishing request(s). Estimate sequential reads and edit operations, not writable file count: one dense file can need many replacements. Narrow the candidate or explicitly allocate enough requests; this is a heuristic, not proof the task cannot finish.`);
    if (policy.max_tool_calls > workingRequests) advice.push(`${agent.id}: max_tool_calls ${policy.max_tool_calls} exceeds the ${workingRequests} working provider requests before the finishing reserve. If the model makes one sequential tool call per response, the request limit binds first. A response can contain multiple tool calls, so this is planning advice, not an unreachable-tool-count calculation.`);
    if (reserve.seconds < policy.finalization_seconds) advice.push(`${agent.id}: finalization_seconds ${policy.finalization_seconds} is capped to ${Math.floor(reserve.seconds)} s, a quarter of timeout_seconds ${policy.timeout_seconds}.`);
    if (!HAS_SUBMISSION_CAP.test(`${plan.context || ''}\n${agent.task || ''}`)) advice.push(`${agent.id}: the shared context and worker task state no numeric submission cap. Say how long the submission may be (for example under 1,200 words, at most 8 findings); reasoning may share the output-token allowance with the visible submission.`);
  }
  return advice;
}
