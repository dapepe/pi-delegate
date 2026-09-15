# Changelog

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
