# Configuration

## Precedence and AGENTS.md

The host resolves the current user request and applicable project instructions, then uses bundled defaults where nothing more specific is authorized. Project Markdown is not executable configuration. `templates/AGENTS.example.md` documents a convention; the host copies the resolved values into the plan's `policy` and lists the instruction sources in `policy_sources`.

`defaults.json` is the schema-defining default object. Unknown policy keys fail closed. Nested `model_aliases` and `openrouter_routing` are merged with defaults; lists such as `preferred_models`, routing `only`, and `order` replace the relevant list. There is no automatic network configuration download or dynamic module name in a plan.

## Policy fields

| Field | Bundled value / rule |
| --- | --- |
| `preferred_provider` | `openrouter`; supported native alternatives: `openai`, `anthropic`, `google` |
| `preferred_models` | Five supplied preferred IDs; selects a pool, not a mandatory fan-out |
| `model_aliases` | Explicit `x-ai/grok-latest` → `~x-ai/grok-latest`; no fuzzy matching |
| `allow_model_exceptions` | `false`; a nonpreferred model **or provider** also needs the worker's written exception reason |
| `default_effort` / `complex_effort` | `xhigh` / `max`; the host chooses per task |
| `effort_policy` | `best_supported`, or `strict` to prohibit effort mapping |
| `max_agents` / `max_parallel` | `3` / `2` |
| `max_turns` / `max_tool_calls` | `12` provider requests / `60` tool attempts per worker; completion repairs count, and the last tool slot is reserved for submission |
| `timeout_seconds` | `600` total worker seconds; cooperative cancellation, not a hard process watchdog |
| `request_timeout_seconds` | `600` per provider request, capped by the remaining worker time |
| `stream_idle_timeout_seconds` | `0` (disabled); optional SDK-event inactivity cancellation. It does not prove the model is idle |
| `finalization_turns` / `finalization_seconds` | `2` / `120`, reserved **within**, not added to, the existing ceilings; the time reserve is capped at one quarter of `timeout_seconds`. In that window only `submit_result` is accepted, and every tool result warns from twice that window |
| `max_completion_repairs` | `1`; integer 0–3, same-session follow-up inside the original allocation. `0` disables it |
| `heartbeat_seconds` | `15`; local liveness and checkpointing only, no model call and no extension of host deadlines |
| `per_agent_budget_usd` / `session_budget_usd` | `2` / `5`, soft USD guards; session here means **one run plan** |
| `max_output_tokens` | `32768`, also capped by the selected model's published output limit |
| `max_file_bytes` | `524288` per source/candidate file |
| `max_context_bytes` | `8388608` for snapshot/context; an additional conservative model-context ceiling applies |
| `openrouter_routing` | `require_parameters: true`, `data_collection: deny`, `allow_fallbacks: false` |

Budgets reserve conservative capacity before requests, including concurrent and unpriced attempts. Catalog rates, token estimates, endpoint behavior, and accounting delays can differ; a dollar guard is not a guaranteed billing cap. Separate runner invocations have separate ledgers. The host must account for all phases against the user's overall authorization.

The context ceiling treats serialized bytes conservatively; it is not a model tokenizer. It can reject a request that would fit in the model's actual context. Narrow the packet rather than silently compacting away constraints or evidence.

## Plan shape

```json
{
  "orchestrator": "claude-code",
  "repo_root": "/absolute/path/to/repository",
  "objective": "Independently inspect a bounded behavior",
  "context": "Acceptance criteria, user-authorized constraints, and sanitized project instructions",
  "policy_sources": ["CLAUDE.md", "AGENTS.md"],
  "policy": { "max_agents": 1, "max_parallel": 1 },
  "read_files": ["src/example.ts"],
  "agents": [{
    "id": "review",
    "role": "sparring-partner",
    "model": "google/gemini-3.8-flash",
    "mode": "read",
    "effort": "xhigh",
    "selection_reason": "Obtain one independent view of this material uncertainty",
    "task": "Inspect the stated behavior and cite concrete source evidence"
  }]
}
```

Replace the repository and source path; this is a schema example, not a runnable task. At least one source file is required. Up to 256 plan source paths are supported. Worker IDs must be portable lowercase names, starting with a letter, without reserved Windows device names. Unknown fields fail closed.

Each worker can specify a `read_files` subset; omitted means all enumerated plan source files. `mode` is always required. `role` is optional and defaults to `sparring-partner`; older role identifiers remain readable for compatibility. `mode: write` also requires a nonempty `write_files` array. Existing write targets must appear in that worker's readable set. New write paths can be absent in the original source, but paths may not collide by case/Unicode or overlap as file/directory names. Candidate writes change an in-memory overlay and are checkpointed outside the checkout after each completed edit tool. No tool writes to the real source.

## Optional evaluation contract

`plan.evaluation` is an additive, host-authored contract. It gives a delegation a stable identity and a small amount of context for later assessment; it does not grant a worker a file, tool, model, budget or permission. Plans without this block remain valid and are read as legacy runs.

```json
{
  "schema_version": 1,
  "task_id": "cache-invalidation-review",
  "task_type": "bugfix",
  "scope": "src/cache",
  "complexity": "bounded",
  "strategy": "single-review",
  "strategy_version": "v1",
  "focus": ["correctness", "completeness"],
  "workers": [{
    "agent_id": "review",
    "assignment_id": "cache-review",
    "attempt_index": 1,
    "criteria": [{
      "id": "evidence",
      "requirement": "Cite the relevant behavior and state what would confirm or falsify the diagnosis."
    }]
  }]
}
```

The surrounding `objective`, `context`, `read_files`, and worker `task` carry the question or decision, source scope, constraints, expected contribution, success evidence and uncertainty. `task_id` is a stable lowercase identifier for the real task and must stay the same across retries and phases. `assignment_id` identifies an assignment; `attempt_index` starts at one and increments for a retry. Every plan agent must have exactly one evaluation worker entry. Each criterion has a portable `id` and a concrete `requirement`, with at most eight criteria per worker. Assessment criteria must cover the preregistered IDs exactly; do not add a new criterion during grading.

The built-in focus labels are `correctness`, `completeness`, `security`, `maintainability`, `design`, and `planning`. A plan may add bounded lowercase custom tags. Focus labels are filters for review; they do not require disagreement or a minimum finding count. Suggested task types include bugfix, feature, refactor, security, performance, testing, documentation, architecture, design, planning, investigation, migration, release and review; a bounded lowercase custom task type is also allowed. The default strategy is `single-review`; use the other fixed strategy labels only when the host actually uses that workflow.

The runner validates this block when present and includes only the criteria for the assigned worker in its prompt. It stores the complete host-authored block in the report for provenance. A malformed evaluation block fails closed; deleting it to make a plan pass changes the recorded contract and should be a deliberate host decision.

`provider` may be omitted to use the preferred provider. A nonpreferred provider/model requires both policy authorization and `model_exception_reason`. Provider credentials never belong in the plan. Native model IDs must match the installed Pi provider's catalog exactly; OpenRouter IDs are not automatically translated to native names. Native costs are estimates unless separately reconciled by the operator; the included reconciliation command is OpenRouter-specific.

## Worker allocations and completion

An optional per-agent `limits` object may reduce `max_turns`, `max_tool_calls`, `timeout_seconds`, `request_timeout_seconds`, `max_output_tokens` and `per_agent_budget_usd` below the plan ceilings. It cannot increase them or alter authority, provider, model or effort. Raise a ceiling only through an authorized plan policy, then bound each role separately. A smaller output cap may leave insufficient room for both reasoning and the answer.

Submissions should include `completion` (`complete`, `partial` or `blocked`) and `remaining_work`. Partial and blocked submissions require at least one concrete remaining-work item; a complete submission cannot list unfinished work. Legacy submissions omitting these fields are still accepted. In all cases completeness and correctness are host-validated claims, not guarantees from schema validation.

See [troubleshooting](troubleshooting.md) for finalization, bounded repair, host command lifetimes, the `diagnose` fields and the difference between checkpoints and a full persistent resume. Normal-stop repair can retain the approved tools; length-stop repair is submission-only. No automatic provider retry or fresh-run restart occurs.

## Model identity and thinking

The OpenRouter resolver queries `/api/v1/models` before inference and requires exact or explicitly aliased IDs, text I/O, tools, usable reasoning metadata, and context/output/pricing metadata. Missing capabilities cause rejection. Availability in a catalog does not establish your account's access, a compatible live route, or successful tool use.

`best_supported` resolves the requested level in this order: exact → next higher advertised level → highest advertised level. At least a verified high-level reasoning setting is required. `strict` permits exact only. The report preserves requested Pi effort, effective Pi effort, outgoing provider effort, and any provider-returned effort metadata. It cannot audit a provider's internal computation.

Moving aliases can change their target; prefer versioned identities for repeatable evaluations. The runner records catalog canonical identities and rejects unrelated returned/billed model identities. Late billing reconciliation can surface a mismatch after the run; the host must revisit any affected decision.

An alias is billed under the dated build of its target: `~x-ai/grok-latest` resolves to the catalog target `x-ai/grok-4.6`, and the generation is billed as that target's canonical slug, for example `x-ai/grok-4.6-20260810`. The resolver looks the target up in the same live catalog and records its canonical slug in `catalog_alias_target.canonical_slug`; the authorized identity set is exactly the resolved id, its canonical slug, the alias target and the target's canonical slug. Nothing is matched by prefix.

Sources: [OpenRouter catalog](https://openrouter.ai/api/v1/models), [Pi OpenRouter serialization](https://raw.githubusercontent.com/earendil-works/pi/v0.85.1/packages/ai/src/api/openai-completions.ts).

## Gateway versus upstream provider

`preferred_provider: openrouter` chooses the gateway. OpenRouter's `only`, `order`, and `ignore` routing lists concern its **underlying hosting providers**, not the model authors or the host orchestrator. This implementation accepts those lists and the supported `max_price`, `zdr`, and data-collection options, with `require_parameters` fixed to true.

A provider fallback within OpenRouter is distinct from switching models. The default disables such fallbacks; policy can authorize them explicitly. There is never an outgoing `models` fallback list. Restrictive routing can make a catalog-listed model unavailable. Do not silently relax a user's privacy or hosting preference to make a request succeed.

`data_collection: deny` is not a claim that every relevant system retains no data. Use an explicit `zdr: true` and account controls where zero-retention eligibility is required, subject to current provider terms. Neither replaces permission to disclose source in the first place. [OpenRouter routing reference](https://openrouter.ai/docs/guides/routing/provider-selection).

## Host assessment

`assessment.json` has `run_id`, `assessed_by: "Codex"` or `assessed_by: "Claude Code"` matching the actual host, `overall_value`, `workers`, and `decisions`. Every worker, including failed and skipped workers, needs a usefulness score from 0–3 plus a concrete reason. In schema 2, each worker also supplies `quality_0_to_3` or `null`, a `quality_reason`, bounded `criterion_results`, an `artifact_sha256` or `null`, and an `integration_status`. Quality answers whether the original assignment met its criteria; usefulness answers the incremental value to the host. A clean, independently verified review can have high quality and usefulness 1. Host repair, later rewriting or final integration does not raise the original worker's quality grade.

The allowed criterion results are `passed`, `failed`, `inconclusive`, and `not_run`; passed or failed results need evidence references. A numeric quality grade requires complete preregistered criterion coverage, evidence for passed/failed criteria, an actual saved submission/candidate artifact identity, and a matching original artifact hash. Integration is a fact about the disposition of the original artifact (`not_assessed`, `not_applicable`, `candidate_only`, `accepted_unmodified`, `accepted_modified`, `rejected`, `deferred`, or `unknown`), not a substitute for quality. Optional counts distinguish unique validated, duplicate, and unverified findings. Every submitted finding needs one accept/reject/defer record with reason, independent validation, and integration status. Schema-1 assessments remain readable and continue to use usefulness only; use [the legacy template](../templates/assessment.legacy.example.json) when documenting that compatibility.

The reporter refuses a worker self-assessment, wrong run ID, missing worker/finding, duplicate decision, unknown finding, or invalid score. It does not fabricate those judgments and does not prove their factual correctness. Keep the underlying result files unchanged.

## Failure classes

Each worker result carries `failure_class`, `failure_hint` and `suggested_learning_failure_kind`, derived from the terminal status, the recorded warnings, the final request's usage and the per-request timing. They explain; they never retry.

| `failure_class` | Meaning | Suggested learning kind |
| --- | --- | --- |
| `none` | Completed with a submission | `none` |
| `partial` | The worker submitted evidence and named remaining work | `none` |
| `blocked` | The worker submitted a blocker rather than a result | `packet` |
| `provider_rate_limit` | HTTP 429 from the gateway or upstream; transient | `provider` |
| `provider_error` | 5xx or connection failure; transient | `provider` |
| `timeout` | Hit `timeout_seconds` without submitting; the hint says whether the wall clock went to per-request latency (mean request time is reported) or to the allocation | `provider` when requests averaged a minute or more, else `limit` |
| `request_timeout` | One request exceeded `request_timeout_seconds` while the worker deadline still had time | `provider` |
| `stream_idle_timeout` | The opt-in SDK-event idle guard fired | `provider` |
| `output_limit_reasoning` | The final response spent its output budget on reasoning and never submitted | `packet` |
| `output_limit` | The final response hit the output limit | `packet` |
| `context_limit` | The conservative byte-based context guard rejected the request | `packet` |
| `turn_limit`, `tool_limit` | A runner allowance was exhausted without a submission | `limit` |
| `refusal`, `policy_violation` | An explicit refusal, or a denied file action | `model` |
| `budget` | Soft budget exhausted | `host` |
| `model_mismatch` | Returned or billed identity outside the authorized set | `provider` |
| `error`, `missing_submission` | Unclassified | `unknown` |

The suggested kind is a hint for the host's assessment vocabulary (`none`, `model`, `provider`, `packet`, `host`, `limit`, `unknown`); the host decides what to record. `stop_diagnostic` (which layer stopped the worker), `timing` (request count, mean and maximum request seconds), `deadline` (warnings shown, tool calls refused in the finishing window), `limit_usage` (used versus allocated, including completion repairs), `finalization`, `recovery_events` and `last_admission` are stored beside it and rendered in `report.md`. `diagnose` reads all of them back without a key or network.

## Ledger across runs

Each run keeps its own `usage.json`. `ledger --out DIRECTORY` accepts one run directory or a parent whose immediate children are run directories, re-derives each run's costs from its `usage.json`, and prints per-run rows and totals labelled for the host, with provider-reported charges, unreconciled estimates and unpriced requests kept apart. Reconcile every run first; the ledger adds, it does not fetch.

## Host metadata and learning are separate from model policy

Plan `orchestrator` is `codex` or `claude-code` (legacy plans default to Codex). Optional `orchestrator_model` and `orchestrator_version` must be actual known values, or null/omitted; never guess them. They describe the primary host, not a worker model. Costs and assessment-author checks use this host.

Claude uses applicable `CLAUDE.md` and imports; the shared-project bridge is `@AGENTS.md`. Read [installation](install.md) before altering instructions. The helper never interprets Markdown as executable configuration.

Optional `assessment.learning` metadata is validated by the separate local learning command, not used to grant inference permissions. Local `.pi/learning/config.json` controls opt-in and evidence thresholds. Do not put learning keys into plan `policy`; unknown inference-policy keys fail closed. The durable run inventory in `.pi/learning/runs.json` is separate from raw run directories and records sanitized metadata even when no assessment is supplied; it keeps preregistered criterion IDs without requirement text. See [learning](learning.md), [insights](insights.md), and [the template](../templates/learning-assessment.example.json).
