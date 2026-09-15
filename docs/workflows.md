# Host-controlled workflows

These are decision patterns for the host, not automatic pipelines or preassigned model specialties. Choose the smallest pattern that meaningfully reduces uncertainty.

## One bounded second opinion

Use one read-only worker to challenge a proposed explanation, API design, or bug diagnosis. The host provides relevant source and acceptance criteria, independently checks the returned evidence, and decides whether further work is warranted. Do not delegate a trivial change just because the skill is available.

## Independent two-model review

Select two authorized models, preferably from different families, and distinct roles such as correctness and edge-case/test coverage. Give both the same factual baseline but not each other's conclusions. Their recommendations are hypotheses, not votes.

The host groups duplicates by root cause, reproduces important claims, and compares contradictory evidence. A third call is justified only by a specific unresolved question or materially missing perspective. Stop when a decision is adequately supported; no open-ended debate loop.

## Scout, then an informed implementation phase

When context is unclear, delegate a small read-only scout task first. Its artifact should identify relevant code, observable behavior, and missing information. The host reads that result and decides which source to inspect and what implementation work to authorize.

Only then create a new plan for candidate work. Carry forward selected verified facts and acceptance criteria, not the scout's full conversation or instructions. The runner has no automatic resume/compaction/chain command, and the scout cannot grant permissions to another worker.

## Candidate implementer plus baseline reviewer

The example plan runs one candidate-write worker and one independent read-only reviewer. Each sees the **original snapshot**. The reviewer does not see the other worker's edits, so its report must not be presented as a patch review.

The host first inspects the candidate. For independent post-change review, prepare an explicitly scoped temporary snapshot containing the selected candidate plus necessary unchanged source. Authorize a new read-only plan against that snapshot. Keep the real checkout untouched until the host accepts changes, and track that the reviewer checked the temporary baseline. Do not run unreviewed candidate build scripts while preparing the snapshot.

The host then validates and integrates only chosen changes using its normal tools. Confirm the original dependency hashes immediately before integration and review the actual current files when stale. Partial acceptance is expected; there is no auto-cherry-pick or merge.

## Refactoring and parallel implementation

Prefer independent files or logically separable changes. Even though each worker has an isolated candidate, overlapping edits still require a human-quality reconciliation decision by the host. A clean patch application is not proof that two proposals compose correctly. Check shared invariants, tests, public APIs, error handling, and dependency changes.

## Evidence-backed project learning

After independent validation, the current primary host may record an assessment when learning is explicitly enabled. Same-task retries/phases retain one task identifier; roles, team, host/model/version, effort, permission and task scope remain part of the profile. Raw local history is ignored, not uploaded. Only eligible host-reviewed advisory preferences may enter the marked `AGENTS.md` section.

`record`/`summary`/`propose` do not modify instructions. A separately reviewed `apply` does; `propose` mode also needs user approval, while `auto` is explicit local opt-in. No training, reflection-model call, autonomous recursion or Git commit occurs. See [learning](learning.md) for thresholds, late regression corrections and limits.

A run against a different temporary candidate-review repository is not evidence of source provenance for the real repository. Keep its artifacts/costs separate; the host may cite the review as validation of an original-project candidate but must not relabel its source or count it as a new independent task. Per-profile costs are not complete multi-phase workflow costs.

## Retrying a failed worker

Read the worker's `failure_class` before deciding anything. Three failures observed in live use, and what each one deserves:

- **A slow route timed out after reading everything.** The per-request timing shows minutes per turn; the packet was not the problem. Retry once with the same worker id and task, fewer files, and either a longer `timeout_seconds` or another authorized family. The grace window makes the worker submit what it has before the cut-off, so a second timeout with no output means the route, not the task.
- **Upstream rate limit (429).** Wait, or move to another authorized model. Record it as a provider failure in the assessment; it is not evidence about the model's quality either way.
- **The whole output budget went to reasoning.** The model never called `submit_result`. Add an explicit cap to the task packet (word count and finding count), keep the packet small, and prefer a model that submits early. Raising `max_output_tokens` rarely helps.

One narrowed retry per failure kind, changing exactly one thing, is the limit. Keep every phase's run directory and total them with `ledger`; a retry costs money whether or not it produces anything.

## Spending and stopping

Treat each additional phase as another spending decision. Keep the phases of one task as sibling run directories and aggregate them with `ledger --out PARENT` against the user's total authorization. A single plan's `$5` default is not permission to spend `$5` repeatedly until a worker agrees.

Stop on sufficient evidence, repeated unproductive attempts, missing permissions, unavailable routes, or exhausted budget. Preserve and report costs for failures, rejected proposals, and inconclusive reviews. A failed worker may still cost money; a clean review may still be useful.

Research basis: [primary-source comparison](../references/research.md). The bounded runner and the host-only transitions are this project's design choices, not claims that the referenced implementations share the same restrictions.
