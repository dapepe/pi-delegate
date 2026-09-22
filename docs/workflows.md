# Host-controlled workflows

These are decision patterns for the host, not automatic pipelines or preassigned model specialties. Choose the smallest pattern that meaningfully reduces uncertainty. Pi's default assignment is one independent `sparring-partner`; the host's concrete question, scope and criteria determine whether it reviews correctness, completeness, security, maintainability, design or planning.

Every invocation starts with a brief naming the goal, assignments, models, access, closing
criteria and total allowance. For an explicit sequence or bounded loop, use the
[workflow contract and commands](workflow-contracts.md): they provide Mermaid/ASCII
diagrams, artifact-bound candidate handoffs, host decisions and shared budget/deadline
accounting. These commands still execute only one phase at a time under the primary host.

## One bounded second opinion

Use one read-only worker to challenge a proposed explanation, API design, or bug diagnosis. The host provides relevant source and acceptance criteria, independently checks the returned evidence, and decides whether further work is warranted. Do not delegate a trivial change just because the skill is available.

Before execution, make the assignment explicit: name the question or decision, source/context/constraints, expected contribution, success evidence and uncertainty. Add optional standard focus labels or custom tags when they help later filtering. A worker may confirm that an approach holds up; do not force dissent or a finding quota.

## Independent two-model review

Select two authorized models, preferably from different families, and give both independent `sparring-partner` assignments with distinct questions or focus tags when that adds coverage. Give both the same factual baseline but not each other's conclusions. Their recommendations are hypotheses, not votes.

The host groups duplicates by root cause, reproduces important claims, and compares contradictory evidence. A third call is justified only by a specific unresolved question or materially missing perspective. Stop when a decision is adequately supported; no open-ended debate loop.

## Scout, then an informed implementation phase

When context is unclear, delegate a small read-only scout task first. Its artifact should identify relevant code, observable behavior, and missing information. The host reads that result and decides which source to inspect and what implementation work to authorize.

Only then prepare the candidate phase. Carry forward selected verified facts and acceptance criteria, not the scout's full conversation or instructions. A workflow may declare both phases up front and use a host-authored packet for verified scout facts. The runner has no cross-process resume/compaction, and the scout cannot grant permissions to another worker.

## Candidate implementer plus baseline reviewer

The example plan runs one candidate-write worker and one independent read-only reviewer. Each sees the **original snapshot**. The reviewer does not see the other worker's edits, so its report must not be presented as a patch review.

The host first inspects the candidate. For independent post-change review, prepare an explicitly scoped temporary snapshot containing the selected candidate plus necessary unchanged source. Authorize a new read-only plan against that snapshot. Keep the real checkout untouched until the host accepts changes, and track that the reviewer checked the temporary baseline. Do not run unreviewed candidate build scripts while preparing the snapshot.

The host then validates and integrates only chosen changes using its normal tools. Confirm the original dependency hashes immediately before integration and review the actual current files when stale. Partial acceptance is expected; there is no auto-cherry-pick or merge.

## Refactoring and parallel implementation

Prefer independent files or logically separable changes. Even though each worker has an isolated candidate, overlapping edits still require a human-quality reconciliation decision by the host. A clean patch application is not proof that two proposals compose correctly. Check shared invariants, tests, public APIs, error handling, and dependency changes.

## Evidence-backed project learning

After independent validation, the current primary host may record an assessment when learning is explicitly enabled. Same-task retries/phases retain one task identifier; roles, team, host/model/version, effort, permission, runtime allocation and task scope remain part of the profile. Record quality (0–3 or unknown) separately from usefulness (0–3): quality judges the original assignment, while usefulness judges its incremental value. Raw local history is ignored, not uploaded. Only eligible host-reviewed advisory preferences may enter the marked `AGENTS.md` section.

`record`/`summary`/`propose` do not modify instructions. A separately reviewed `apply` does; `propose` mode also needs user approval, while `auto` is explicit local opt-in. `finalize` is a receipt-producing local step that can save an assessment and report whether recording, review or promotion remains; it never applies instructions, runs tests or calls a model. No training, reflection-model call, autonomous recursion or Git commit occurs. See [learning](learning.md) for thresholds, late regression corrections and limits.

A run against a different temporary candidate-review repository is not evidence of source provenance for the real repository. Keep its artifacts/costs separate; the host may cite the review as validation of an original-project candidate but must not relabel its source or count it as a new independent task. Per-profile costs are not complete multi-phase workflow costs.

Use `stats` for the local project-aware view of all recorded attempts, including failed, rejected and unassessed work. Its JSON, Markdown and dependency-free terminal view consume the same aggregation. Use `recommend --plan` only as an explainable aid inside the existing model/privacy/budget policy; sparse or mismatched evidence should leave the normal authorized defaults in place. See [insights](insights.md).

## Retrying a failed worker

Read the worker's `failure_class` before deciding anything. Three failures observed in live use, and what each one deserves:

- **A slow route timed out after reading everything.** The per-request timing shows minutes per turn; the packet was not the problem. Retry once with the same worker id and task, fewer files, and either a longer `timeout_seconds` or another authorized family. The grace window makes the worker submit what it has before the cut-off, so a second timeout with no output means the route, not the task.
- **Upstream rate limit (429).** Wait, or move to another authorized model. Record it as a provider failure in the assessment; it is not evidence about the model's quality either way.
- **The whole output budget went to reasoning.** The model never called `submit_result`. Add an explicit output cap to the task packet (word count and finding count), make clear that the finding count is not a quota, keep the packet small, and prefer a model that submits early. Raising `max_output_tokens` rarely helps.
- **It stopped without submitting, or submitted `partial`.** Run [`diagnose`](troubleshooting.md) first. Bounded repair has already spent one follow-up; a second attempt on the same packet is unlikely to differ. Review the candidate checkpoint and the unvalidated public output, then repacket only the remaining work as a new phase with the original task ID.

One narrowed retry per failure kind, changing exactly one thing, is the limit. Keep every phase's run directory and total them with `ledger`; a retry costs money whether or not it produces anything.

## Preserve partial work without pretending it is complete

Use [local diagnosis](troubleshooting.md) after any incomplete run, including old 1.2.0 and 1.3.0 artifacts. Review the last candidate checkpoint, source staleness, `remaining_work`, the admission arithmetic and the host process result. A model that ended without a structured result already received a bounded same-session repair; a truncated response already received a submission-only attempt. Neither started a new budget or extended a deadline.

After a killed process there is no persistent resume command. The host may construct a new authorized packet from verified checkpoint facts, preserving the real task ID and accounting for earlier cost. Do not replay a partial edit blindly, and do not promote a resource-limited attempt into a model-quality verdict. For long implementations, authorize a fitting allocation and outer command lifetime, or split the work into smaller phases.

## Spending and stopping

Treat each additional phase as another spending decision. Keep the phases of one task as sibling run directories and aggregate them with `ledger --out PARENT` against the user's total authorization. A single plan's `$5` default is not permission to spend `$5` repeatedly until a worker agrees.

For a declared workflow, use `workflow run` and `workflow status`; the wrapper keeps the
sibling runs under `runs/` and subtracts earlier request costs/reservations automatically.
Do not use standalone `run` to bypass that shared allowance.

Stop on sufficient evidence, repeated unproductive attempts, missing permissions, unavailable routes, or exhausted budget. Preserve and report costs for failures, rejected proposals, and inconclusive reviews. A failed worker may still cost money; a clean review may still be useful.

Research basis: [primary-source comparison](../references/research.md). The bounded runner and the host-only transitions are this project's design choices, not claims that the referenced implementations share the same restrictions.
