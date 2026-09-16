# Early stops, partial results, and safe continuation

This guide applies to `pi` 1.4.0. The diagnosis command also reads 1.2.0 and 1.3.0 artifacts. Do not delete a failed run or launch the same plan again merely because the host stopped displaying output.

## Identify the layer before changing limits

From the installed `pi` directory:

```sh
node scripts/pi.mjs diagnose --out /absolute/path/to/the/run
```

This is local inspection: no model, API key, SDK import, paid inference, or file modification. It reads `report.json`, `plan.json`, and, when present, `usage.json`. Use the output directory printed by the original `run` command, or inspect `~/.cache/pi/`. Older directories are accepted; fields the old runner never captured stay unknown, and the stop classification is derived from what they do carry.

`finished: false` does **not** prove a crash. Check the existing Codex terminal-session handle or Claude task/command result. The process might still be working. A SIGKILL, host restart, or power loss cannot be diagnosed conclusively from a `running` checkpoint alone. Capture the host's exit code, signal, timestamps and stderr alongside the artifacts. Prefer sanitized excerpts over sharing source-bearing run folders.

| Status | What it means | Appropriate response |
| --- | --- | --- |
| `partial` / `blocked` | The worker submitted evidence and explicitly declared remaining work | Not a completed assignment. Decide what to verify, finish or repacket; partial findings can still be useful. |
| `timeout` | Total per-worker deadline; default 600 seconds | Narrow the slice or explicitly authorize more worker time; also accommodate the enclosing host-command lifetime. |
| `request_timeout` | One provider request hit its separate timeout; default 600 seconds, capped by remaining worker time | Inspect request timings and provider behavior. Raising only the worker timeout will not remove this limit. |
| `stream_idle_timeout` | Opt-in SDK-event inactivity timeout | A quiet reasoning model need not be stuck. Disabled by default; a heartbeat does not reset it. |
| `turn_limit` | Request count reached `max_turns` | The default 12 is **12 provider requests**, including tool iterations and completion repairs, not 12 user tasks. |
| `tool_limit` | Tool allowance exhausted | Inspect repeated reads and errors; one final tool slot is reserved for submission. |
| `budget_reservation_limit` | Input-byte estimate plus full output allowance cannot be reserved within the remaining worker/run budget | Inspect `last_admission`; this can happen before any paid request. Reserved dollars are not spent dollars. |
| `budget_limit` | Soft measured or estimated budget already reached | Reconcile; new spending needs authorization. |
| `context_limit` | Conservative context admission failed | The runner uses serialized bytes as a cautious token ceiling, not an exact tokenizer. Reduce context and excerpts; do not silently compact away constraints. |
| `output_limit` | Provider returned `length`, and the submission-only repair did not produce a result either | Reasoning may have consumed the output allowance. Cap the submission size in the packet and use smaller edits. |
| `missing_submission` | Model stopped without `submit_result`; repair exhausted or disabled | Inspect the public output and checkpoint, then decide whether a new scoped assignment is worthwhile. |
| `error` / `aborted` | Provider, SDK or runtime interruption | Inspect sanitized warnings, timing and usage; avoid blind retries. |
| `policy_violation` / `model_mismatch` / `refusal` | Permission, model identity or explicit refusal problem | No automatic continuation or bypass. Refusal text recognition is conservative and best-effort. |

Each worker result also carries `failure_class`, `failure_hint` and `suggested_learning_failure_kind`. The layer above says *where* it stopped; the failure class says whether that stop is evidence about the model and whether one narrowed retry is justified. See [configuration](configuration.md#failure-classes).

## Defaults and separate boundaries

The plan ceilings are unchanged: 12 requests, 60 tool calls, 600 worker seconds, 32,768 maximum output tokens, $2 per worker, $5 per run plan. Workers queued behind others get their own timer when they start. With three workers and concurrency two, the enclosing process may need **two waves**, not only one worker's timeout. Preflight, billing and cleanup add overhead. Billing lookups currently run between responses and consume worker wall time.

The runtime controls are:

```json
{
  "request_timeout_seconds": 600,
  "stream_idle_timeout_seconds": 0,
  "finalization_turns": 2,
  "finalization_seconds": 120,
  "max_completion_repairs": 1,
  "heartbeat_seconds": 15
}
```

`finalization_turns` reserves the last requests **inside** `max_turns`; with defaults, finalization starts before request 11. It does not give 12+2 requests. The time reserve is capped at one quarter of the worker timeout. It is observed at the next request boundary *and* on every tool call, so a single long request cannot spend the reserve on further investigation. From twice the reserve before the deadline, every tool result carries the remaining seconds. Finalization also starts when the tool allowance is nearly exhausted, when the next two conservative reservations would not fit, or when the context approaches its guard. It cannot rescue an already expired in-flight request.

In finalization mode only `submit_result` is offered, and the capability layer rejects investigative and edit tools even when the model calls one absent from the offered list. A partial or blocked result must list `remaining_work`; a complete result cannot. A worker's completeness claim is still subject to host validation.

A premature normal stop can receive one follow-up in the **same in-memory Pi session**, retaining approved tools when allowance remains. A `length` stop receives one **submission-only** follow-up; truncated edits are never replayed. Every repair uses the same request counter, worker deadline, effort, model, access grants and cost ledger. Set `max_completion_repairs: 0` to disable it. No automatic provider retry, model fallback or quota reset occurs; the SDK's internal `maxRetries` remains zero.

## Allocate by role rather than remove all limits

For a larger candidate implementation, the host may explicitly authorize, for example, 32 requests, 120 tools and 1,800 worker seconds while keeping the 600-second individual request deadline. This is an illustrative policy choice, not a measured optimum and not a changed default:

```json
{
  "max_turns": 32,
  "max_tool_calls": 120,
  "timeout_seconds": 1800,
  "request_timeout_seconds": 600
}
```

The existing $2/$5 guards still apply unless separately authorized. Larger time and turn limits do not help when the cost reservation or context guard is the actual blocker. Do not reduce the output allowance reflexively at `max` effort: on many providers the same allowance covers reasoning plus visible output.

An individual worker can receive a **smaller** allocation using `limits`:

```json
{
  "limits": {
    "max_turns": 12,
    "max_tool_calls": 50,
    "timeout_seconds": 600,
    "request_timeout_seconds": 300,
    "per_agent_budget_usd": 1
  }
}
```

Only the documented request, tool, time, output and per-worker-budget keys are allowed, and a worker allocation may not exceed any plan ceiling. Model and reasoning selection are unchanged. Split large work into scout, narrowly scoped implementation and independent verification rather than asking one worker to investigate everything and deliver a broad rewrite.

## Host execution is another layer

Claude Code documents `BASH_DEFAULT_TIMEOUT_MS` as 120,000 ms and `BASH_MAX_TIMEOUT_MS` as 600,000 ms by default. These are **host command controls**, not Pi inference controls. `API_TIMEOUT_MS` concerns Claude's own API calls, not this runner's OpenRouter requests. Check the actual tool call, version, active settings and any managed policy. An enclosing timeout can stop the runner before its own limit. Do not have the installer silently change host settings.

Codex's open-source unified-exec handler treats `yield_time_ms` as a wait interval and can return a process or session ID for further interaction. A yielded command is not automatically a killed command. Keep the original handle and inspect its actual state rather than launching duplicate paid runs. The same upstream source also has a one-shot mode whose command timeout defaults to 10,000 ms and which cannot resume a timed-out process; this is not proof that any particular Desktop build uses that mode. Desktop, CLI and tool surfaces differ: use the tool contract actually exposed by the installed host, not guessed flags. Avoid tight model-driven status polling.

The runner emits a compact heartbeat without invoking a model. A heartbeat proves only that the runner's event loop responded, not that the provider is making progress, and it cannot extend an outer host deadline. SDK event timestamps are recorded separately as `last_provider_event_at`. Transport comments or keepalives not surfaced as SDK events do not reset the optional idle timer.

## Checkpoint recovery is not full session resume

Candidate edits are atomically exported after completed edit-tool events, and result, coverage and usage metadata are checkpointed during the run. A bounded public-text excerpt is saved without structured thinking blocks or raw tool arguments. Reverted or deleted candidate exports are removed. The real checkout is never modified.

A kill can lose the latest uncheckpointed event. Updates across candidate, result and usage files are not one database transaction. Treat an interrupted checkpoint as unvalidated material; verify recorded candidate hashes and the source snapshot before using it.

This release has **in-process continuation**, not a persistent transcript resume command and not a detached daemon. After the process dies, the host must review the checkpoint and deliberately construct a new bounded task packet. Preserve the original learning task ID and account for the cost of all attempts. Do not call a fresh run a resumed session or claim it preserves provider reasoning or signatures.

Cancellation is cooperative via the Pi SDK. An adapter that ignores abort, or an event-loop-blocking dependency, cannot be forcibly isolated inside this process. True per-worker process supervision with graceful-stop/kill escalation and durable compatible transcripts is a separate future hardening step, not implemented here.

## Learning separates resource failure from quality

Use `failure_kind: "limit"` for a validated timeout, quota or context-admission outcome; it is an operational failure, not evidence that the model's reasoning was wrong. Provider, packet, host and unknown causes remain distinct. A timeout alone cannot establish causality or justify a negative model-quality lesson.

Runtime allocations, effective output allowance, completion recovery and companion-worker allocations contribute to local profile metadata. Trials with different allowances no longer pool as the same routing profile. Independently useful partial findings can be accepted by the host, but an incomplete assignment is not promoted as a successful completed strategy. Any changed strategy or task allocation needs the same host review as model selection.

## Sources checked 2026-09-15

- [Pi 0.85.1 Agent loop](https://raw.githubusercontent.com/earendil-works/pi/v0.85.1/packages/agent/src/agent-loop.ts): natural stopping, tool termination, and rejected truncated tool calls.
- [Pi 0.85.1 Agent lifecycle](https://raw.githubusercontent.com/earendil-works/pi/v0.85.1/packages/agent/src/agent.ts): prompt versus continuation and cooperative abort.
- [nicobailon tool reference](https://raw.githubusercontent.com/nicobailon/pi-subagents/main/docs/tool-reference.md): pre-deadline checkpoint requests, soft/hard budgets, separate tool/run limits and retained resume.
- [nicobailon observability](https://raw.githubusercontent.com/nicobailon/pi-subagents/main/docs/observability.md): lifecycle artifacts and bounded inspection.
- [tintinweb README](https://raw.githubusercontent.com/tintinweb/pi-subagents/master/README.md): graceful turn-limit handling with five grace turns, and batch-notification windows distinct from killing workers.
- [Claude SDK subagents](https://code.claude.com/docs/en/agent-sdk/subagents): marked partial results and transcript-preserving resume; version qualifications apply.
- [Claude environment variables](https://code.claude.com/docs/en/env-vars): host command and API timeouts.
- [Codex unified-exec handler](https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/tools/handlers/unified_exec.rs): yield and timeout fields; see also [command handling](https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs). This is current upstream source, not a guarantee about every shipped Desktop version.
- [OpenRouter reasoning](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens): combined reasoning/output allowance and `length` stops.
