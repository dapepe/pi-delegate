# Project-local learning

**Yes to evidence-backed routing preferences; no to self-reinforcing agent folklore.**

This feature helps the current host inspect delegation quality, usefulness, reliability and spending for a similar future task. It does not train model weights, prove a globally best model, upload feedback, run a reflection model, or spend on automatic experiments. Codex and Claude Code remain the sole reviewers and integration decision makers. The local helper aggregates **host-authored assessments**, not workers' opinions of themselves.

Pi 1.5.0 adds a small evaluation contract to plans and a durable run inventory. A plan may name a question or decision through its objective/context, scope, stable task ID, focus labels and criteria for each assignment. The default worker role is `sparring-partner`; older role identifiers remain readable. Use the six suggested focus labels (`correctness`, `completeness`, `security`, `maintainability`, `design`, `planning`) or bounded custom tags. Focus labels organize evidence; they do not require disagreement or a finding quota.

## Enable it deliberately

Installation does not enable learning in any task repository. From an installed skill directory, choose a project explicitly:

```sh
node scripts/pi.mjs learn init --repo /absolute/project/root --mode propose --claude-import
```

`--claude-import` is optional. It appends a standalone `@AGENTS.md` to the project's `CLAUDE.md`, preserving existing contents. If needed, it creates a minimal shared `AGENTS.md`. Without that flag, initialization changes neither instruction file. Review the bridge diff and existing import graph; do not introduce circular imports. The helper recognizes standalone `@AGENTS.md` and `@./AGENTS.md` outside fenced examples, not every possible inline import spelling.

Claude Code documents this bridge because it does not automatically read `AGENTS.md`. Codex uses its normal instruction-file hierarchy. A root `AGENTS.override.md` can hide root `AGENTS.md` in Codex; initialization warns but does not edit overrides. Nested instructions retain their normal scope. [Claude memory](https://code.claude.com/docs/en/memory), [Codex project instructions](https://developers.openai.com/codex/guides/agents-md).

| Mode | Record and propose | Edit the learned block |
| --- | --- | --- |
| `off` | Recording and proposals are refused; existing history can be inspected | Refused |
| `propose` (initial default) | Host records verified outcomes and reviews a draft | Requires host review **and user approval** (`--approve`) |
| `auto` (explicit project opt-in) | Same evidence and review requirements | Host may apply an eligible reviewed draft without asking for approval each time |

`auto` means permission for the current host to perform this bounded update. It does **not** install a hook, launch a background process, let workers edit memory, automatically commit changes, or bypass the host's normal permission system. Setting it is an explicit user/project decision:

```sh
node scripts/pi.mjs learn mode --repo /absolute/project/root --mode auto
```

Local opt-in is not carried to teammates through Git. Each clone/worktree has its own `.pi/learning` state unless the user explicitly provisions it. Do not copy another project's history to manufacture evidence.

## Two layers, different trust levels

The local directory is created with an internal `.gitignore` that ignores its contents:

```text
.pi/learning/config.json           project identity, mode, evidence limits
.pi/learning/history.json          observations, costs, artifact hashes, revisions
.pi/learning/runs.json             sanitized inventory of every recorded attempt
.pi/learning/proposal.json         exact proposed block and source hashes
.pi/learning/last-promotion.json    last host attestation and before/after hashes
```

Raw run artifacts remain outside the task repository. The history does not store full worker transcripts, source snippets, free-form reflections, or validation-evidence text. It stores sanitized task IDs/scope, model/host metadata, numeric outcomes and costs, plus evidence digests/counts. `runs.json` is a separate compact inventory for coverage and spending; it may contain project identity, run/assignment IDs, status, assessment state, cost buckets and preregistered criterion IDs, but never criterion requirement text or a raw `run_path`. Task IDs, paths and metadata can still be sensitive; choose non-sensitive identifiers. Ignoring files is not encryption, access control, or protection against `git add -f`. The helper never uploads history or sends global telemetry.

Only a compact reviewed block is suitable for sharing in `AGENTS.md`. Default limits are **six profiles maximum and 4,096 bytes total**, often fewer profiles when ensemble descriptions are long. The updater preserves all human content outside these exact standalone markers:

```html
<!-- pi:learned:start -->
<!-- pi:learned:end -->
```

Do not insert marker examples into the real project's `AGENTS.md`: fenced or duplicate markers deliberately fail closed. The shared block contains deterministic advisory sentences drawn from a fixed strategy vocabulary and validated identifiers, not arbitrary model-written instructions. Model/provider policy, budgets, permission grants, test requirements, and all human-maintained text remain untouched.

## What constitutes evidence

After reviewing each worker and independently validating its claims, the host writes a normal assessment plus a `learning` object. Start from [the template](../templates/learning-assessment.example.json), replacing every example identifier and outcome. Every worker needs an evaluation, including failures and skipped workers. Schema 2 adds a separate quality grade, criterion results and original artifact identity; schema 1 remains readable for older runs.

Use the **same `task_id` for retries and phases of the same real task**. A new filename, run ID, worker, host, or session is not a new task. `task_type`, `scope`, and `complexity` describe the actual work. `strategy_version` identifies the host's task-packet/process recipe; increment it when that recipe materially changes, not after every result.

The recorded profile separates host and known host-model/version, task class/scope/complexity, strategy/version, focus tags, default or legacy role, complete same-plan worker team, assignment and attempt identity, requested/resolved/observed model identity, upstream provider, requested/effective effort, read versus candidate-write permission, runtime allocations (including companion-worker allocations and the effective output allowance), and skill/SDK versions. Suggested task types are useful filters, but a bounded lowercase custom type is allowed when the work does not fit them. A changed ensemble or resolved moving-alias target is not pooled with the old configuration. Unknown host identity is recorded as unknown, never invented; assess unknown-version history conservatively and reset the strategy version when the effective host changes.

Schema-2 assessments create new `evaluation_metadata` records and `profile_schema_version: 2` profiles. Versioned catalog-alias identities in those profiles remain separate from older schema-1 alias-era profiles; existing history is not rewritten or silently pooled during this additive update.

Supported strategy labels:

| Label | Meaning |
| --- | --- |
| `single-review` | One bounded independent opinion |
| `parallel-independent` | Independent first passes on a common factual baseline |
| `scout-then-candidate` | Scout, then a new candidate phase scoped by the host |
| `candidate-then-review` | Candidate, then a separately scoped review phase |
| `design-challenge` | Focused challenge to a proposed design |
| `edge-case-review` | Targeted edge-case/test investigation |

New plans use one default role, `sparring-partner`, and let the assignment and focus tags describe the angle. Historical normalized roles (`scout`, `candidate`, `correctness-review`, `test-review`, and `design-challenger`) remain readable so existing records do not change meaning. For phased work, the team field describes the **current plan**, not an invented record of earlier/later phases. Use a consistent strategy version to identify the broader recipe and assess all phase costs separately.

A useful observation requires a completed worker, captured request/resolved model-effort metadata, host usefulness score at least 2/3, independently passed validation with evidence references, no policy violation/identity mismatch, no observed regression, and no major or unknown rework. In schema 2, a positive quality outcome also needs a non-null quality grade, passed or appropriately inconclusive criteria, and the artifact identity checked when a candidate or submission exists. A clean review may score high quality and usefulness 1 for useful assurance without becoming a routing win. Proposed tests alone do not establish passed validation. Negative quality claims also require host evidence. A host repair or later rewrite never raises the original worker's quality grade.

Use `failure_kind` to distinguish model-quality failures from provider outages, inadequate packets, host mistakes or unknown causes. `failure_kind: "limit"` records an established time, request, tool, context or budget-admission failure as operational, not as a negative reasoning verdict. The stop diagnostic, actual allowance usage and completion-repair metadata are retained in the observation. Do not infer a cause from an unfinished artifact alone, and do not promote an incomplete assignment as a completed success even when some partial findings were useful. Operational failures stay visible with their costs; they are not silently counted as incorrect model answers. They should still influence the host's practical reliability judgment. Confirmed regressions veto a positive preference.

## Default promotion floor

A profile becomes eligible only after **at least three distinct useful tasks**, at least **75% useful among quality-evaluated distinct tasks**, and no contradictory validated harm or identity mismatch in the window. The defaults look back **90 days**. A same-task retry can recover useful evidence but cannot create multiple independent successes; all its recorded attempt costs remain. Contradictory validated evidence on that task prevents calling it useful.

These are deliberately small, conservative **policy heuristics, not statistical confidence guarantees**. Selection bias, task difficulty, host skill, unobserved rework and tiny samples still matter. Do not infer a causal comparison or replace a reviewer because one profile passed the floor. Route justified real tasks to alternatives within the existing authorization; never create extra paid work merely to improve a score.

The learning summary reports task-balanced counts and quality/usefulness evidence. The separate [insights workflow](insights.md) reports every recorded attempt, including unassessed, failed, rejected and retried work, with provider-reported charges, unreconciled estimates and unknown requests. It does not turn these into a universal scalar quality/price ranking. Host execution cost and time are not measured. Reported per-worker or per-plan amounts are not complete end-to-end workflow costs.

Thresholds can be made stricter in the local config. The schema refuses fewer than three useful tasks, a useful fraction below 0.75, more than six rules, or a block above 4,096 bytes. A host still decides which **eligible** profiles are worth publishing; eligibility alone is not a decision.

## Record → review → finalize → propose → apply

After an actual run, complete integration checks and reconcile available costs. Then:

```sh
node scripts/pi.mjs learn record --repo /absolute/project/root --out /private/run \
  --assessment /private/run/assessment.json
node scripts/pi.mjs finalize --repo /absolute/project/root --out /private/run \
  --assessment /private/run/assessment.json
node scripts/pi.mjs learn summary --repo /absolute/project/root
node scripts/pi.mjs learn status --repo /absolute/project/root
node scripts/pi.mjs learn propose --repo /absolute/project/root
```

`record`, `finalize`, `summary`, `status` and `propose` leave `AGENTS.md` untouched. `finalize` is a local receipt/status transition: it validates the named run and optional assessment, updates the durable run inventory, and, when learning is initialized, enabled and the assessment is valid, records the run automatically. An ordinary finalize can close an assessed run while recording failed or incomplete workers for review; add `--require-complete` when every worker must be complete. Invalid assessment input fails closed without replacing a previous valid receipt. It reports the remaining action. It does not run tests, invoke inference, apply a candidate or promote a preference. If the project is uninitialized or mode is `off`, the receipt says recording was skipped and gives the host the explicit next action. `propose` suggests the most-supported eligible profiles that fit the size limit; this is draft selection, not a global ranking. To control selection, pass `--profiles ID,ID`, using IDs from the current summary. `--profiles none` deliberately clears all promoted preferences while leaving a small advisory block.

The host must inspect the candidate block and evidence before applying. In `propose` mode, after user approval:

```sh
node scripts/pi.mjs learn apply --repo /absolute/project/root \
  --reviewed-by claude-code --approve
```

Use `--reviewed-by codex` in Codex. In explicitly authorized `auto` mode the same host review is required but `--approve` is not. The helper rebuilds the candidate from current evidence and checks the saved hashes; changed instructions, config, history or edited proposal text require a fresh proposal/review. The host then reviews the Git diff. Nothing is committed automatically. Do not apply merely to refresh counts/costs every run: publish material routing changes, newly sufficient evidence, needed expiry reviews or withdrawals. Fresh detailed statistics can remain local without generating constant shared-file churn.

The root `AGENTS.md` must remain at most 32 KiB under this helper's conservative check. Codex's **combined** instruction-file limit can be reached sooner by ancestor/override instructions; the helper is not a complete host context-budget auditor. Importing a long file into Claude does not make its context cost disappear. Keep the summary much smaller than the maximum.

Recording is idempotent. It requires report/plan/snapshot provenance for the specified project and rejects deliberately labeled offline runner doubles. Evidence from a review against a **different temporary repository** cannot be relabeled as a run against the real project. Such a review may support the host's validation of the original candidate, but its run and costs remain separate; do not present original-project history as complete accounting for all phases.

## Correct and retire lessons

After a late regression, model-identity mismatch, or delayed billing result, update the original host assessment/usage through normal review and reconciliation. Then use:

```sh
node scripts/pi.mjs learn record --repo /absolute/project/root --out /private/run --revise
node scripts/pi.mjs learn summary --repo /absolute/project/root
node scripts/pi.mjs learn propose --repo /absolute/project/root
```

A revision preserves prior observations for audit, keeps the same task identity, and replaces rather than adds the current attempt's accounting. Review/apply the new proposal to withdraw a disproven preference. A changed history invalidates any old outstanding proposal. Nothing silently rewrites a shared file at record time, even when a regression is confirmed.

Expired observations are excluded. A published preference includes a conservative refresh date based on its oldest included evidence; a newer outage/retry cannot extend older support. There is no background expiration edit. The host checks applicability and expiry before reuse and proposes removals as needed.

To pause collection, set mode `off`. **This does not erase the already-published block.** Retire profiles with `--profiles none` and a reviewed apply before switching off, or manually remove the exact managed block. Do not remove unrelated instructions.

## Trust and research limitations

`assessed_by`, `--reviewed-by`, validation references and outcome labels are **trusted-host attestations**, not cryptographic proof that tests ran or that the current process is that host. The helper prevents worker-tool access, rejects malformed input and stale proposals, but cannot make a dishonest or compromised host truthful. Use human review and a stronger OS sandbox for that threat model.

Learning writes use a cooperating-operation lock, bounded UTF-8 files, symlink/hardlink refusal, temporary replacement and repeated hash checks. These are not a transactional database or perfect compare-and-swap against an uncooperative local process. A crash may leave a lock or partially completed multi-file bookkeeping. Check actual files before removing a stale lock or retrying; do not run concurrent manual edits during promotion. Local Windows behavior still needs validation.

The design borrows the useful separation of raw observations and compact reusable memory from Pi community work. Recent context-file research gives reason to avoid long or unnecessary instructions, not a guarantee that this feature improves any project. See [research](../references/research.md) for primary sources and scoped findings.
