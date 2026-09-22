# Pi insights and evaluation

Pi 1.5.0 keeps the feedback loop local and inspectable. A run captures what was attempted, the project involved, the selected model and version, request usage, status and cost coverage. The host can then add an assessment that answers two different questions:

- **Quality (0–3 or unknown):** did the original assignment meet its criteria?
- **Usefulness (0–3):** how much incremental value did the result provide to the host?

A clean, independently verified review can have high quality and usefulness 1. A host repair, rewrite or later integration does not raise the original worker's quality grade. Workers never grade themselves.

## Before the run

Describe the question or decision in `objective` and `context`, name the source and constraints, and state the expected contribution, success evidence and uncertainty in the worker task. Add the optional `evaluation` block to the plan when the assignment should be measurable across attempts:

```json
{
  "schema_version": 1,
  "task_id": "security-header-review",
  "task_type": "security",
  "scope": "src/http",
  "complexity": "bounded",
  "strategy": "single-review",
  "strategy_version": "v1",
  "focus": ["security", "completeness"],
  "workers": [{
    "agent_id": "review",
    "assignment_id": "headers-review",
    "attempt_index": 1,
    "criteria": [{
      "id": "evidence",
      "requirement": "Tie each material claim to inspected source and state remaining uncertainty."
    }]
  }]
}
```

Use one default `sparring-partner` role. The six suggested focus labels are `correctness`, `completeness`, `security`, `maintainability`, `design`, and `planning`; custom lowercase tags are allowed. Focus labels are filters, not a requirement to disagree or produce findings. The assignment can cover bugs, security, gaps, abandoned files, implementation or design alternatives, reviews, plans, specifications and task definitions.

Keep `task_id` stable across retries and phases of one real task. Keep the same `assignment_id` for a retry and increment its `attempt_index` (starting at 1); use a new `assignment_id` only for a genuinely different assignment. This lets the statistics view balance quality and usefulness by distinct task while still charging every attempt.

## Record and assess

Project learning is opt-in. Initialize the project before the first run if you want durable coverage:

```sh
node scripts/pi.mjs learn init --repo /absolute/project/root --mode propose
```

The runner writes a compact sanitized record to `.pi/learning/runs.json` when the project is initialized and the mode is not `off`. The inventory is separate from raw run artifacts and legacy `history.json`. It stores project identity, task and assignment IDs, status, model metadata, assessment state, usage and cost buckets, and criterion IDs only; it never stores prompts, source text, criterion requirement text or an absolute raw-run path. No project initialization means no hidden global collection: the run output reports that inventory recording was skipped and tells the host the next action.

After reviewing the original result and running independent checks, write schema 2 from [the assessment template](../templates/assessment.example.json). Include every worker, including failed, skipped and unassessed workers. For each v2 worker supply `quality_0_to_3` or `null`, `quality_reason`, exact preregistered criterion results (`passed`, `failed`, `inconclusive` or `not_run`), evidence references for passed/failed criteria, the original submission/candidate `artifact_sha256` (or `null` when the worker has no numeric grade), and `integration_status` (`accepted_unmodified` or `accepted_modified` when applicable). A numeric grade requires a saved submission/candidate artifact identity, complete criteria coverage and evidence; otherwise validation rejects it. The runner stores the digest in each worker's `result.json`; the host can recompute and verify it with the public local helper (no inference):

```sh
node --input-type=module -e "import { readArtifactIdentity } from '/absolute/path/to/pi/scripts/evaluation.mjs'; console.log(readArtifactIdentity('/private/run', 'candidate').artifact_sha256)"
```

`finalize` performs the same bounded read from the saved plan, snapshot, result and candidate files before accepting a numeric grade. Keep findings and their accept/reject/defer decisions unchanged. Schema-1 assessments remain readable; use [the legacy example](../templates/assessment.legacy.example.json) to recognize the older shape.

Use the local finalization step after the assessment is ready:

```sh
node scripts/pi.mjs finalize --repo /absolute/project/root --out /private/run \
  --assessment /private/run/assessment.json
```

Finalization is a receipt and status transition. It may save or validate the assessment, update the compact inventory, and, when learning is initialized and enabled, record valid learning evidence before reporting whether a reviewed promotion remains. An ordinary finalize can close an assessed run while recording failed or incomplete workers for review; add `--require-complete` when every worker must be complete. Invalid assessment input fails closed without replacing a previous valid receipt. It does not run tests, invoke a model, apply `AGENTS.md`, integrate a candidate or silently migrate history. If finalization cannot complete, preserve the receipt/error and follow its explicit next action. Rerunning finalization for the same evidence is idempotent; a new delegation retry keeps its `task_id` and `assignment_id`, increments `attempt_index`, and records its own charge.

Use `learn status` for the project-local state and next action:

```sh
node scripts/pi.mjs learn status --repo /absolute/project/root
```

The status output reports initialization and mode, and with `--out` can include the selected run's inventory lifecycle and finalization receipt. `record`, `propose` and status inspection do not edit instructions. Only a separately reviewed `learn apply` changes the managed block, and `propose` mode still needs user approval.

## Read statistics

All output formats use the same local aggregation. Reads do not call a model or reconcile billing:

```sh
node scripts/pi.mjs stats --repo /absolute/project/root --period 30d --format json
node scripts/pi.mjs stats --repo /absolute/project/root --period 90d --format markdown
node scripts/pi.mjs stats --repo /absolute/project/root --period all --tui
node scripts/pi.mjs stats --repo /project/one --repo /project/two --period 7d --format json
```

`--period` accepts `7d`, `30d`, `90d` or `all`. `--repo` may be repeated. `--out /private/raw-runs` accepts either one raw run directory or a parent whose immediate child directories are raw runs; it does not recurse, and it never writes to those directories. The project selector and evidence summary show whether data came from durable inventory, legacy history or compact rows whose raw artifacts are unavailable.

The dependency-free TUI has five views:

| View | Shows |
| --- | --- |
| Overview | Selected project, period, attempts, completion/failure status, assessment coverage and spending buckets |
| Models | Model and version, role, task count, quality/usefulness coverage, host/access detail and evidence availability |
| Focus areas | Results grouped by standard or custom focus tag, with task-balanced grades and evidence coverage |
| Tasks | Original task IDs, assignments, retries, statuses, grades, reasons and all attempt costs |
| Learning | Per-project learning mode, lifecycle status and next action, with host-reviewed quality/usefulness and the observational caveat |

The TUI is an inspection surface, not a recommendation engine. Unknown grades, missing raw evidence and unresolved charges remain visible. Reasoning-token counts are sub-counts of output and cache fields are provider-reported fields; they are not added twice.

For a dry, explainable shortlist limited to the models already authorized by a plan:

```sh
node scripts/pi.mjs recommend --repo /absolute/project/root \
  --period 90d --format markdown --plan /private/plan.json
```

Recommendations expose the evidence used, exact configuration differences, task coverage and cautions. Sparse or mismatched evidence falls back to the plan's existing authorized defaults. The command cannot add models, change effort, loosen privacy, raise budgets, grant candidate writes or apply learning.

Spending includes every attempt in the selected period: retries, failures, rejected suggestions and runs that have no assessment. Provider-reported charges, unresolved estimates and unpriced requests stay separate. Host cost is excluded. Quality/usefulness summaries use the latest assignment outcome for a distinct task so retries do not overweight a model, while the cost total retains every attempt. This is descriptive project evidence, not a causal model ranking.

## Compatibility and privacy

Pi 1.5.0 is additive. Plans without `evaluation`, schema-1 assessments, pre-1.5.0 `history.json`, and legacy role IDs remain readable. A schema-2 assessment creates new versioned evaluation metadata and a `profile_schema_version: 2` profile; its dated catalog-alias identity is kept separate from older alias-era profile records. Existing schema-1 history is not rewritten or silently pooled with those new v2 profiles. There is no silent migration, history rewrite or threshold change. New durable inventory is created only by the explicit project learning setup and normal run recording path; a malformed or foreign file fails closed.

The inventory and learning history are project-local and ignored by Git. No global telemetry, background collector or automatic cross-project learning exists. Project names, paths, task IDs and model metadata can still identify sensitive work; choose bounded non-sensitive IDs and do not publish `.pi/learning` or raw run directories.
