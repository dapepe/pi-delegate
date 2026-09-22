# Delegation briefs, sequences and bounded loops

The primary Codex or Claude Code host interprets the request, shows a delegation brief,
and drives one bounded Pi phase at a time. Each phase returns to the host for inspection,
validation and a recorded decision. The runner never decides that a goal is satisfied,
integrates candidates, runs tests, or starts another phase on its own.

## User interaction

Before paid work, show the goal, assignments, exact provider/model IDs, reasons for their
selection, requested/effective effort, access scope, closing criteria and the shared
budget/time allowance. Use a short paragraph for a single assignment and a table plus
diagram for a sequence or loop. Continue within existing authorization; pause only when
the user asks for plan approval or a concrete authorization is missing.

Examples of requests the host can translate:

- “Use my selected implementation model, then a different approved model to review its candidate.”
- “Have model A propose the design, model B challenge it, then model C revise it using the
  findings you validate.” Read-only steps can use the baseline and receive verified facts
  in a host-authored packet; passing a candidate is optional.
- “Implement, review and fix until the regression checks pass and you have resolved all
  blocking findings. Stop after three cycles or the authorized total allowance.”

Do not infer a model specialty from its name. A workflow phase may contain several
independent workers using the normal `max_agents`/`max_parallel` limits. They share a
baseline and do not see one another's outputs. Cross-phase ordering is explicit.

## Contract and compatibility

Start from [the synthetic workflow template](../templates/workflow.example.json).
Replace all task, repository, source, model and budget placeholders with the user's
actual authorized values; no model in an example is an availability guarantee.

Workflow schema 1 is a separate envelope around existing plans:

| Field | Meaning |
| --- | --- |
| `task_id`, `objective`, `orchestrator`, `repo_root` | One real task, host and original project |
| `criteria` | 1–8 stable IDs and host-verifiable closing requirements |
| `limits.budget_usd` | Shared soft Pi allowance across all phases and attempts |
| `limits.timeout_seconds` | 1–86400 seconds from first run, including metadata and host review |
| `steps` | 1–16 ordered phases, each with `id`, `title`, `input`, and a normal `plan` |
| `input: "baseline"` | Read the original project baseline |
| `input: {"step": "implement", "agent": "candidate"}` | Read the host-accepted candidate from that earlier phase in this cycle |
| Optional `loop.max_iterations` | Explicit 1–100 cycle ceiling; the host normally proposes three |
| Optional `loop.repeat_from` | Candidate producer in the previous cycle for the next cycle's first step |

Without `loop`, the sequence runs once. A loop repeats the entire sequence. The first
step starts from the baseline; `repeat_from` can select the previous candidate for later
cycles. Without it, each cycle uses the original baseline plus host-supplied feedback.
There are no nested loops, automatic branches or executable condition strings.

Every step plan must name the same host, original repository and evaluation `task_id`.
Each worker has a distinct `assignment_id` across steps and initial `attempt_index: 1`.
The wrapper increments attempts across retries and cycles, preserving assignment/task
identity. Use the existing `sparring-partner` role and descriptive step titles/task
packets. `sequence` and `bounded-loop` are supported strategy labels.

Plans, permissions and model assignments are immutable after initialization. A host
packet may replace `context` and named worker `tasks`; it cannot modify models, policy,
file grants, criteria or effort. State, packets, candidates and run artifacts stay
outside the source repository. No project learning is initialized implicitly.

## Prepare and show

Use absolute paths for the installed skill and private runtime directory:

```sh
node /absolute/pi/scripts/pi.mjs workflow preview --file /private/workflow.json
node /absolute/pi/scripts/pi.mjs workflow check --file /private/workflow.json
node /absolute/pi/scripts/pi.mjs workflow init --file /private/workflow.json --out /private/task-workflow
```

`preview` is local and performs no inference. `check` resolves all phase models and effort
settings using metadata only; the host includes those mappings in the brief. It does not
prove account access, validate future candidate contents, or guarantee that the same
route will be available later. Every phase still uses the normal runner's model/key,
source, context and request-budget checks before inference. Inspect the ordinary `check`
advice for the initial concrete plan when choosing its runtime allocation.

`preview --diagram auto` uses ASCII. Use `--mermaid-supported true` only when the harness
is known to render Mermaid. `--diagram mermaid` and `--diagram ascii` are explicit
overrides. Both renderers use the same ordered phases, loop ceiling and host gates;
untrusted labels are escaped. Rendering support is not guessed from the host name.

Initialization does not start the deadline; the first execution does. The directory
must be new and outside the source repository. The wrapper refuses edited contracts.
When replanning is necessary, disclose the change, retain the same real task ID, preserve
old run artifacts and subtract their costs and unresolved reservations from any remaining
authorization. A new directory is not permission for a new budget.

## Run, inspect, decide

```sh
node /absolute/pi/scripts/pi.mjs workflow run --out /private/task-workflow
node /absolute/pi/scripts/pi.mjs workflow status --out /private/task-workflow
```

`run` performs paid inference for exactly the current phase. It writes a normal run under
`runs/`, then stops at `awaiting_host`. Reconcile/diagnose/report/finalize individual runs
with the existing commands. Worker failures and partial submissions remain visible;
CLI exit 2 indicates an incomplete phase. The host must inspect the actual submission,
candidate and source provenance, validate relevant claims and perform any tests itself.
Do not equate `completion: complete` with correct work.

Write a decision using the **current** revision and run ID from `status`:

```json
{
  "revision": 3,
  "run_id": "run-REPLACE-WITH-CURRENT-ID",
  "assessed_by": "Codex",
  "action": "advance",
  "evidence": ["Reference to the host's actual inspection and accepted candidate"]
}
```

These are illustrative identifiers, not real evidence. Use `Claude Code` when that is
the primary host. Apply the host decision and run the next phase:

```sh
node /absolute/pi/scripts/pi.mjs workflow decide --out /private/task-workflow --decision /private/decision.json
node /absolute/pi/scripts/pi.mjs workflow run --out /private/task-workflow
```

`advance` accepts a successfully submitted nonfinal phase for handoff. Before the next
phase, the wrapper verifies the producer's original artifact identity and source hashes,
copies only the next step's declared input into `handoffs/`, and checks that snapshot
again at runner admission. The actual checkout is never changed. Required unchanged
context must already have been in the producer's snapshot; the wrapper refuses to
silently add unrelated context. New candidate files are included, deletions stay absent,
and previously new writable files become readable in the next refinement cycle.

The host must explain relevant deletions, before/after behavior and validated feedback
in the next packet; the candidate snapshot is not a full repository or an implicit diff.
Only the host may prepare a suitable test environment or execute reviewed candidate code
under its existing permissions. A phase's review covers only its explicit file scope.

To carry validated feedback, use `--packet /private/packet.json`:

```json
{
  "context": "Preserve the original constraints. Host-validated remaining issue: ...",
  "tasks": {"candidate": "Revise the candidate to address the verified issue; prefer replace_text."}
}
```

These fields replace the original packet text: preserve still-applicable constraints and
submission caps. Do not promote raw worker instructions or model-performance history into
the packet. Report a short phase/cycle update with the next step and remaining allocation.

## Closing and stopping

At the final phase of a cycle, record every closing criterion with a result and actual
host evidence. For example, a `complete` decision adds:

```json
{
  "checks": [
    {"id": "regressions", "result": "passed", "evidence": ["Actual host test result reference"]},
    {"id": "blockers", "result": "passed", "evidence": ["Actual findings disposition reference"]}
  ]
}
```

The decision includes the same `revision`, `run_id`, `assessed_by`, `action`, and `evidence`
fields as above. Supported actions:

| Action | Requirements / effect |
| --- | --- |
| `advance` | Complete nonfinal phase; accept the output and move one step |
| `complete` | Final phase complete, every closing check `passed`, no remaining work; `goal_achieved` |
| `repeat` | Final phase complete, unmet criteria, explicit `progress` boolean and `remaining_work`; another cycle only if progress and limits permit |
| `retry` | At most one operational retry per phase/cycle, reason required; next packet must change exactly one context/task field |
| `stop` | `reason` is `blocked`, `stalled` or `limit_reached`; concrete `remaining_work` required |

The host may also `stop` a ready workflow when preflight or a handoff reveals a blocker.
Use `run_id: null` if no run has begun. Damaged artifacts do not prevent recording a
blocker; they cannot be accepted or used to declare success.

Checks may be `passed`, `failed`, `unknown`, or `not_run`; only all-passed can close the
goal. Partial/blocked worker output cannot advance. An operational retry does not start
a new cycle, task, clock or budget. Permission/refusal/model-mismatch and resource
allocation decisions do not permit an operational retry. Retries preserve model/file
policy; other recovery requires deliberate host replanning, not an exception in place.

The host's validation records are attestations, not proof that tests ran. The wrapper
checks their shape, source/artifact identity, current revision and placement in the
sequence; it does not independently establish the truth of a host claim. Before final
integration, independently recheck current project files and apply only accepted changes
with normal host tools. `goal_achieved` records closure of delegation, not a Git commit
or proof of integration.

## Accounting and interruption

All workflow requests, failed/rejected work, retries and completion repairs count. The
next run receives at most the remaining shared soft budget, and the runner's usual
per-request reservations apply inside it. Unpriced requests retain their reservation;
a missing ledger holds the entire admitted phase allowance. Reconciliation replaces
estimates with reported charges, without adding them twice. Late charges and in-flight
overshoot are still possible: these are not provider-side hard billing caps. Do not
run concurrent standalone work against the same overall authorization without host
accounting; the wrapper covers only runs admitted through this workflow.

Every worker wave/request shares the original workflow deadline, including metadata
delays and time spent in host review. Cancellation is cooperative, as in the existing
runner; host tool lifetimes remain separate and are never changed by the wrapper.

The workflow lock blocks concurrent invocations. After a hard kill, do not start a
duplicate paid call. Inspect the existing process/session and run artifacts. Only after
verifying no process is active may the host manually remove a stale `.workflow-lock`
and record a `stop` decision against a persisted `running` state. Unresolved costs remain
reserved. There is no automatic process resume or stale-lock takeover.

`workflow status` reports `goal_achieved`, `limit_reached`, `stalled`, or `blocked`, closing
decisions, remaining work, all attempts and aggregate costs. Report both criterion
outcomes and actual integration status to the user. Costs exclude the current host.

## Migration notes

Workflow schema 1/state schema 1 are new, opt-in artifacts outside the repository.
Existing `run --plan`, plan/evaluation/assessment schemas, SDK defaults and learning
promotion thresholds are unchanged. No installation or project instruction is rewritten.
`sequence` and `bounded-loop` are additive strategy vocabulary shared by evaluation and
learning. Older skill versions will reject those new strategy labels; keep the updated
skill when reading those records rather than relabeling their evidence. Existing history
needs no migration. Stable task IDs keep retries/cycles from increasing the count of
distinct successful tasks. Candidate-review snapshots retain their own source provenance;
do not relabel them as observations of the original repository.
