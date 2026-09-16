# Reliability audit — pi 1.4.0

Two independent review passes over the 1.2.0/1.3.0 runner were merged for this release. The findings below identify reproducible stopping mechanisms. Where a finding is supported by an observed live run, that run is cited from [the validation record](validation.md); the rest are reproducible from the source and the offline fixtures, not from logs of a real interruption. No live model benchmark was performed, and this release was not live validated at all.

## Findings and treatment

| Finding | Consequence | Treatment in 1.4.0 |
| --- | --- | --- |
| Twelve `max_turns` actually means twelve provider requests, including tool iterations | A multi-file investigation can exhaust the allowance well before twelve substantial work steps | Explain the semantics, expose used-versus-allocated counters, allow smaller role-specific allocations beneath an explicitly authorized plan ceiling |
| 600 seconds was both the total worker lifetime and each request's timeout | Slow reasoning, repeated requests and between-response billing lookups consume the same allocation, and one stalled request is indistinguishable from an exhausted worker | Separate request and worker timers; retain the original ceilings; expose the stop layer |
| The host command has its own lifetime | The enclosing process can end before Pi's own deadline; a yielded live handle can be mistaken for termination | Host execution guidance, separate SDK activity metadata, no automatic duplicate run |
| Final submission consumed the same unrestricted tool/turn allowance as investigation | **Observed live:** a reviewer read thirteen files across nine requests averaging 67 s and timed out at 600 s with no submission, for $0.38 | Reserve finishing turns, time and a tool slot inside existing quotas, enforced both at request boundaries and on every tool call, with submission-only tools |
| A normal final assistant message without `submit_result` ended the worker | A plan, preliminary diagnosis or otherwise useful text produced `missing_submission` with no recovery | One bounded same-session follow-up by default, preserving model, effort, limits and history |
| `length` stopped the worker without a structured partial result | **Observed live:** a final request spent 31,455 of 32,768 output tokens on reasoning and submitted nothing, for $0.17 | At most one submission-only follow-up; a truncated edit is never executed or replayed |
| Candidates were exported only at normal worker cleanup | A hard process kill could lose otherwise finished candidate edits | Checkpoint candidates after completed edit tools, plus result and usage metadata during execution |
| Conservative max-output and input cost reservations could stop before actual spending reached $2/$5 | A reservation rejection looked like spent-budget exhaustion | Explicit admission arithmetic in `last_admission`; reserved, estimated and reported amounts stay distinct |
| Serialized bytes were treated as a conservative token ceiling | Context could be rejected even when an exact model tokenizer would allow it | Expose the estimate method and its inputs; retain the cautious behavior and recommend smaller packets |
| Runtime allocations were absent from routing profiles | A short allocation could unfairly appear to show a poor model or strategy | Include own and companion allocations and the operational `failure_kind: "limit"`; keep incomplete work out of completed-success promotion |
| Ordinary editing failures were mixed with authorization violations | A failed exact-match replacement was recorded as a policy breach | Separate mechanical tool errors from explicit capability denials; a real denial now stops the worker |
| A moving alias is billed under the dated build of its catalog target | **Observed live:** `~x-ai/grok-latest` billed as `x-ai/grok-4.6-20260810` was flagged as an unauthorized model at reconciliation | Record the target's canonical slug at resolution; the authorized identity set includes it. Matching remains exact |

## Defaults retained, not silently increased

Twelve requests, sixty tool calls, 600 worker seconds, a model-capped 32,768-output-token ceiling, $2 per worker and $5 per run plan remain the defaults. The model pool, provider and routing choices, and the requested xhigh/max policy are unchanged.

The runtime defaults are 600 seconds per request (capped by remaining worker time), the SDK-event idle timeout disabled, two reserved finalization requests, up to 120 reserved seconds, one completion repair and fifteen-second local heartbeats. Reserves are inside existing quotas. The 120-second figure comes from the observed timeout above, where the worker had read everything and needed a turn to write: a shorter reserve would not have been enough on that route. The finalization time window is capped at one quarter of the worker lifetime, and it cannot rescue an already expired in-flight request.

A larger implementation allocation such as 32 requests, 120 tools and 1,800 seconds is a host-authorized example, not a benchmarked best setting. It does not raise the spending guards or the enclosing host-command timeout. A narrow read-only reviewer can receive smaller limits than an implementer in the same plan. Resource grants and completion claims do not change the host's sole authority to validate and integrate.

## Safe recovery contract

Normal-stop recovery may retain the originally approved tools when enough allowance remains. Length-stop recovery is submission-only. All recovery uses the same in-memory session, request count, model, effort, worker deadline, candidate overlay and cost ledger. There is no whole-run automatic retry, new budget or provider fallback, and SDK provider retries remain disabled.

An explicit refusal, permission denial, identity mismatch, cancellation or established exhausted allowance does not trigger a restart. Text-only refusal detection is conservative and best-effort. A structured result may declare complete, partial or blocked; partial and blocked require concrete remaining work. Even a complete claim must be independently checked by the host.

Candidate checkpoints and a bounded public-text excerpt survive many interruptions, but they are not a transcript-resume format. Structured thinking blocks, signatures and raw tool arguments are not persisted. After process death the host must review the preserved material and construct a new authorized packet, retaining the original learning task ID and accounting for prior spending.

## Research comparison

- **Pi upstream Agent SDK 0.85.1:** natural no-tool completion ends the loop; the prompt/follow-up lifecycle and `shouldStopAfterTurn` support bounded orchestration. Its agent loop rejects length-truncated tool calls, and this project does not try to complete a malformed edit from a truncated response.
- **nicobailon/pi-subagents:** its documented default is thirty minutes for foreground and plain single-agent async runs, not for every execution mode. Async single-agent runs support a pre-deadline checkpoint steer. Soft tool budgets request finalization; hard restrictions do not block final text. Retained resume and durable lifecycle artifacts are explicit features. Its documentation cautions against treating tool counts as mutation-safe implementation boundaries.
- **tintinweb/pi-subagents:** graceful max-turn handling steers a wrap-up, permits up to five grace turns, then aborts. Its thirty-second grouped-notification window does not kill unfinished agents. This project's finishing reserve differs intentionally: it stays within the user's authorized maximum instead of adding unaccounted turns.
- **Claude Code SDK:** custom and general-purpose subagents can return partial max-turn results and resume with retained history; documented explicit partial marking requires Claude Code 2.1.246+. This is a native SDK capability, not something this Pi-based skill inherits automatically.
- **Host boundary:** Claude's documented Bash command default is two minutes and its model-selectable maximum defaults to ten minutes; installed settings can differ. Codex's upstream execution interface distinguishes wait/yield from actual process timeout; its current one-shot variant defaults to ten seconds, which is not a claim about every Desktop configuration. The exposed host tool and the returned process status are authoritative.
- **OpenRouter reasoning:** reasoning and visible output share the output cap on most providers. A length stop with no visible answer can still be billed. Smaller output caps are therefore not a universal fix for reservation problems at high reasoning effort.

Sources and links are in [the troubleshooting guide](../docs/troubleshooting.md) and [research references](research.md). These are independently maintained projects; documented features are not guarantees that every version behaves identically.

## Remaining limitations and next priorities

1. **No durable same-session resume after process death.** Adding it needs versioned transcripts and state, compatible provider signatures, model and permission identity checks, source staleness checks, idempotent edit handling and cost continuity. Do not solve this by replaying a prompt or copying signed reasoning into an incompatible session.
2. **No process-isolated supervisor.** Abort is cooperative. A blocking dependency or an adapter ignoring abort can delay termination; a supervisor with graceful-stop/kill escalation is a separate architectural change. Checkpointing is per-file atomic, not a transaction or a guarantee against every kill boundary.
3. **Conservative context and spending admission remains.** A trustworthy model-aware tokenizer and sharper documented per-provider reservations would reduce false rejections. Do not substitute an optimistic fixed bytes-per-token ratio and call it a hard cap.
4. **Billing lookups consume worker time.** Decoupling them would require retaining safe provisional reservations and model-identity checks before later actions. The current design favors correctness and accounting visibility over throughput.
5. **No automatic compaction or transport-error retry loop.** Both need careful preservation of permissions, evidence, interrupted-request charges and non-replayed mutations. The host can narrow the next phase; this version does not add these behaviors silently.
6. **Not live validated.** Offline tests and supplied SDK fixtures cannot establish real provider behavior, host lifetimes, billing accuracy or useful outcome gains. The 1.3.0 live session informed the design but was run against the previous runner. See [validation](validation.md).

## Diagnose an existing failed run

```sh
node /absolute/path/to/pi/scripts/pi.mjs diagnose --out /absolute/path/to/run
```

This works with 1.2.0 and 1.3.0 artifacts and requires no SDK, key, network or new inference. Compare its output with the outer host command's actual timeout, exit code and signal. A report still marked `running` could indicate either a live process or abrupt termination: the artifacts alone do not establish which. Retain candidates, verify hashes and source state, and do not start a duplicate paid run blindly.
