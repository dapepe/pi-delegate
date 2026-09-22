# Changelog

## 1.5.0 — 2026-09-22

Adds a host-graded feedback loop and project-aware local insights while preserving the
existing delegation and learning boundaries.

### Added — assignments and evaluation

- Optional `plan.evaluation` metadata gives each task a stable `task_id`, task type, scope,
  complexity, strategy, focus tags and preregistered criteria for each assignment/attempt.
  New plans use one default `sparring-partner` role; legacy role identifiers remain readable.
- Assessment schema 2 adds independent `quality_0_to_3`/`null`, quality evidence, exact criterion
  results, original artifact identity and integration disposition alongside the existing usefulness
  score. Quality answers whether the original assignment met its contract; usefulness records
  incremental host value. Host repairs do not raise the original grade. Schema-1 assessments remain
  readable and default promotion thresholds are unchanged.
- Durable, sanitized project run inventory at `.pi/learning/runs.json` records every opt-in attempt,
  including failed, retried and unassessed work, separately from raw caches and routing history.
  Project identity, assessment state and cost coverage remain visible without prompts, source text or
  absolute raw-run paths.
- Local finalization/status workflow produces a receipt and clear next action. Recording and
  finalization never run inference, apply preferences or silently rewrite history.

### Added — insights

- `stats --repo ... --period 7d|30d|90d|all --format json|markdown [--tui]` reads project inventory,
  legacy history and explicitly named raw runs. `--repo` is repeatable; JSON, Markdown and the
  dependency-free TUI use the same aggregation.
- The TUI exposes Overview, Models, Focus, Tasks and Learning views with project identity, model
  versions, assessment coverage, quality/usefulness, reliability and cost buckets.
- `recommend --plan ...` provides a dry, explainable advisory shortlist constrained by the existing
  plan's authorized models, privacy, effort, permissions and budgets. Sparse evidence falls back to
  current defaults and never changes policy.
- Spending keeps every attempt and separates provider-reported charges, unresolved estimates and
  unknown requests. Quality/usefulness views are task-balanced; host cost remains excluded.

### Compatibility and validation

This release is additive: legacy plans, assessments, history and role IDs remain readable, with no
global telemetry, automatic promotion, dependency-based TUI or silent migration. Local SDK,
synthetic/offline execution, strict finalization/replay, TUI, validator, package and audit checks
passed. One authorized read-only OpenRouter review used DeepSeek v4 Pro canonical `20260423` at
`xhigh` over three repository files; five requests reconciled to `$0.042198529` excluding Codex.
The host accepted one reproduced parse/hash race, the F3 read-time-hash fix and strict finalization
were verified, and durable/raw statistics plus the same-plan advisory dimensions agree. Details and
the limits of this single observational run are in [the validation record](references/validation.md).

## 1.4.0 — 2026-09-16

Merges an independent second review pass into 1.3.0. 1.3.0 answered "the worker stopped and
produced nothing" with a time-based grace window; this release adds the parts that window could
not cover — an allowance that reaches the end of a long task, partial work that survives, and an
honest name for what actually stopped.

### Added — long-running work

- **Reserved finishing allowance.** `finalization_turns` (2) and `finalization_seconds` (120,
  capped at a quarter of `timeout_seconds`) are reserved *inside* the existing ceilings, never
  added to them. In that window the worker is offered only `submit_result`, its system prompt says
  so, and the capability layer refuses every other tool even if the model calls one that was not
  offered. The last tool slot is reserved the same way. Finalization also starts early when the
  *next* round trip would not fit the remaining budget or context, so pressure produces a submitted
  partial result instead of a refusal with nothing to show. This replaces `submit_grace_seconds`,
  whose 120-second refusal window and tool-result warnings are preserved inside it.
- **Bounded completion repair** (`max_completion_repairs`, default 1, maximum 3, `0` disables).
  A model that ends its turn with a plan instead of a submission gets one same-session follow-up
  with its approved tools; a `length` stop gets a submission-only follow-up and its truncated edit
  is never replayed. Repairs reuse the same model, effort, request counter, deadline, permissions
  and cost ledger — they are not fresh runs, and they do not reset any limit.
- **Mid-run checkpoints.** Candidate files are exported atomically after each completed edit tool,
  with reverted or deleted exports removed; counters, coverage, submission and usage are written
  on every request boundary, tool result and heartbeat. A killed process no longer loses finished
  candidate work. A set of files is still not a transaction.
- **Independent timers.** `request_timeout_seconds` (600, capped by remaining worker time) makes
  one slow request distinguishable from a worker that ran out of total time.
  `stream_idle_timeout_seconds` (0, opt-in) cancels on SDK-event inactivity;
  `heartbeat_seconds` (15) emits local liveness and a checkpoint without calling any model.
- **Per-worker `limits`.** A plan agent may reduce `max_turns`, `max_tool_calls`,
  `timeout_seconds`, `request_timeout_seconds`, `max_output_tokens` and `per_agent_budget_usd`
  below the plan ceiling. It can never raise one.

### Added — better results

- **Honest outcomes.** `submit_result` takes `completion` (`complete`, `partial`, `blocked`) and
  `remaining_work`. Partial and blocked claims must name concrete remaining work; a complete claim
  may not list any. `partial` and `blocked` are their own worker statuses. Legacy submissions
  without these fields are still accepted. Every claim remains a claim for the host to validate.
- **`diagnose --out RUN_DIRECTORY`**: local stop diagnosis with no SDK, key, network or inference.
  It reports the stop layer, recorded versus used allowance, the admission arithmetic, SDK activity
  timestamps, checkpoints and remaining work. It reads 1.2.0 and 1.3.0 artifacts and derives the
  classification those runners never recorded.
- **Salvaged public output.** A bounded, key-scrubbed excerpt of visible assistant text is kept
  when no submission arrives. Thinking blocks, signatures and raw tool arguments are never stored.
- **Mechanical tool errors are separated from permission violations.** A failed exact-match
  replacement used to be recorded as a policy breach; only a denied capability is one now, and a
  real violation stops the worker instead of letting it continue.
- **Explicit refusals and identity mismatches bypass the repair loop.** Refusal detection for
  unstructured text is conservative and best-effort.
- `failure_class` now covers `partial`, `blocked`, `request_timeout`, `stream_idle_timeout`,
  `refusal`, `policy_violation` and the unfinished states, and a new learning `failure_kind` of
  `limit` records a resource failure as operational rather than as poor model reasoning.
- `check` reports each worker's allocation and finishing reserve and warns about write scope
  against `max_turns`, a capped `finalization_seconds`, and host-command lifetime.
- `report.md` renders the stop layer, allowance used versus allocated, finalization trigger,
  completion claim, remaining work and unvalidated public output.

### Learning

Routing profiles now record the worker's runtime allocation and its companions'. Trials run under
different allowances are separate profiles and are no longer pooled as the same routing evidence,
and a resource-limited attempt cannot become a permanent negative verdict on a model. Observations
retain the stop diagnostic, failure class, allowance usage and recovery events.

**Migration:** profiles recorded before 1.4.0 have no `runtime_limits` and therefore hash to
different profile IDs than otherwise identical 1.4.0 runs. Existing history stays readable and its
evidence is preserved; the old and new profiles simply do not pool, so a preference near its
promotion floor may need one further run under the current allocation before it is promoted again.
Nothing is rewritten or deleted, and no threshold changed.

### Unchanged boundaries

The 12-request, 60-tool, 600-second, $2-per-worker and $5-per-plan ceilings, the model pool and the
effort policy are unchanged. No quota reset, effort downgrade, provider retry, automatic fallback,
persistent transcript resume, detached supervisor, shell tool or automatic integration was added.
Cancellation remains cooperative: a heartbeat proves the runner's event loop is alive, not that the
provider is making progress, and it cannot extend the enclosing host command's own lifetime.

### Validation

142 offline tests and 6 installed-SDK synthetic-transport tests pass on macOS with Node 22.23.1.
No live inference was run for this release; every long-running claim above is tested against
fixtures and a deterministic fake clock, not against a real provider. See
[the validation record](references/validation.md) and [the reliability audit](references/reliability-audit.md).

## 1.3.0 — 2026-09-15

Shaped by the first live session: four runs on a real repository through Claude Code, in
which three of four attempts at one review role produced nothing for reasons that had
nothing to do with the task.

### Added

- `submit_grace_seconds` (default 120): in the final window before `timeout_seconds` a
  worker may only call `submit_result`, and every tool result warns it from twice that
  window. A worker that had read every file and then timed out before writing was the
  most expensive failure observed.
- Per-worker `failure_class`, `failure_hint` and `suggested_learning_failure_kind`, plus
  `timing` (per-request seconds) and `deadline` counters, in `result.json`, `report.json`
  and `report.md`. Provider rate limits, provider errors, latency timeouts and
  reasoning-exhausted output limits are named as operational failures, distinct from
  refusals, budgets and identity mismatches.
- `ledger --out DIRECTORY`: totals the reconciled ledgers of several run directories (the
  phases of one task) with the host label, keeping reported charges, unreconciled
  estimates and unpriced requests apart.
- `check` prints a per-worker `summary` and an `advice` list: clamped effort, a large
  packet against the timeout, or a context with no submission cap.
- `request_finished` progress events carry the request's wall-clock seconds; a
  `deadline_warning` event is emitted once per worker.

### Fixed

- A moving alias billed under the dated build of its catalog target was flagged as an
  unauthorized model at reconciliation (`~x-ai/grok-latest` → target `x-ai/grok-4.6`,
  billed `x-ai/grok-4.6-20260810`). The resolver now records the target's canonical slug
  and the authorized identity set includes it, in the runner, in `reconcile` and in
  learning. Matching remains exact.
- `readSource` compared a resolved file path against an unresolved root, so on macOS
  (where the temp directory is a symlink) an unresolved root made every file look as if it
  had escaped. Roots are now resolved before the containment check.
- Two installer tests compared against an unresolved temp path and failed on macOS.

### Guidance

- SKILL.md now separates operational failures (one narrowed retry, same worker and task
  id, change exactly one thing) from decisions (no retry without authorization), asks for
  an explicit submission cap in every packet, and documents where a worker's output lives.

### Validation

110 offline tests, `check:sdk` and the three installed-SDK tests pass on macOS with Node
22.23.1 and a genuinely generated lockfile. Live inference: see the validation record.

## 1.2.0 — 2026-09-14

### Added

- Claude Code support alongside Codex: primary-host skill instructions, explicit plan/assessment host metadata, correct authority labels and host-cost exclusion.
- Installer `--host codex|claude-code|both`, personal/repository paths, Claude config relocation, preflight/rollback behavior and no overwrites.
- Optional local project learning: host-validated outcomes, role/strategy/ensemble profiles, separate host/model/version/effort/scope evidence, and fixed-template AGENTS preferences.
- Opt-in `off`/`propose`/`auto` modes; record, summarize, propose, review and apply stages; explicit CLAUDE-to-AGENTS import setup.
- Distinct-task sample floors, accounting of retries, operational-failure separation, bounded/expiring guidance, late-cost/regression revisions and preserved audit history.
- Host-only instruction-file writes with marked-block limits, file/link checks, locks, stale-content checks and tamper detection for proposals.
- Multi-host/learning templates, documentation and updated primary-source research.

### Hardened

- Workers cannot read/write project instruction files or learning state.
- Changed companion teams and resolved model identities are not pooled as the same routing profile.
- Useful learning needs captured model/effort/request metadata and independent validation; later retries/outages cannot extend older evidence freshness.

### Validation

103 offline tests pass in the preparation environment. Actual SDK installation, live inference/billing, host UI behavior and cross-platform CI remain unexecuted; see [the validation record](references/validation.md).

## 1.1.0 — 2026-09-14

The skill, display name, package, installation directory, commands, and release
archive now use the name **pi**.

### Added

- Cross-platform source installer, local doctor, interactive credential setup,
  and Desktop installation guide with explicit environment and secret handling.
- Independent-review and phased-workflow guidance based on three primary-source
  Pi subagent implementations; Codex remains the only orchestrator.
- Structured usefulness assessments with complete finding dispositions and a
  Markdown report separating recorded facts from Codex's judgments.
- Per-worker source retrieval coverage and concise execution progress metadata.
- Dependency-free regression tests plus separately runnable installed-SDK tests
  with mocked transport; explicit opt-in public-fixture live smoke command.
- MIT license, security/contributor docs, CI matrix, publication instructions,
  and deterministic, allowlisted source ZIP packaging with SHA-256 checksum.

### Fixed

- SDK package metadata lookup now resolves an exported entry point rather than
  importing an unexported package.json subpath.
- A synthetic error after a completed response no longer overwrites that
  request's usage or reconciled charge. Interrupted generation IDs are retained.
- Unpriced and in-flight requests retain provisional budget reservations;
  concurrent workers cannot both reserve the same remaining soft budget.
- Zero-filled usage is not interpreted as proof of a free request. Late cost
  reconciliation also checks model identity and flags unexpected substitutions.
- Additional path, Unicode/case-collision, policy-type, source-size, and evidence
  checks fail closed. Uncreated candidate files cannot be cited as evidence.
- Every authorized worker is represented in the final report, even when a
  startup failure prevents it from running.

### Validation

See [references/validation.md](references/validation.md) for actual test evidence
and unexecuted checks. No live-inference or Desktop compatibility claim is made
from fixture tests.

## 1.0.0 — Initial prototype

Bounded Pi SDK delegation, explicit model preferences, isolated candidate edits,
evidence validation, source snapshot checks, and provider cost reconciliation.
