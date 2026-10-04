# Long-running work and Pi 1.0

The skill pins Agent Core, Pi AI and the experimental Pi Durable package to
**1.0.0**, with Chord **1.0.0**. Ordinary supervision remains the default: bounded
live workers, completion repair, isolated candidate checkpoints and host-controlled
workflows. The optional Durable path stores a transcript and supports explicit,
host-present recovery for **one standalone read-only worker on POSIX**.

## Larger tasks while the host stays active

Select an allocation from the work, not the number of files. Separate scouting,
candidate implementation and independent review when one assignment combines too
many decisions. Use the workflow wrapper for an ordered sequence so phases share
the original budget, deadline and host-checked closing criteria.

For a reviewer, put a numeric output cap in the task/shared context, ask for each
file to be read once with batched reads where practical, and require a successfully
validated `submit_result`. A cap is not a finding quota or a guarantee of delivery.
Give excerpts their own granted path and physical line numbering; put original
source coordinates in evidence. Fix a rejected submission rather than claiming
the tool accepted it. Read-only normal-stop repair offers only submission using
existing evidence. If work remains, submit partial or blocked. Candidate
implementers retain bounded continuation after a normal stop.

Allocate requests for reads, replacements and finishing. Each provider request
has a deadline, and the enclosing host command must accommodate worker waves plus
metadata, billing and cleanup. Increasing worker time alone does not increase
request time or host lifetime. Preserve the live process handle across yielded
responses and use the host's wait tools. Heartbeats establish runner liveness,
not provider progress. Durable is also supervised; it creates no daemon or
unattended continuation.

Accept findings only after checking original evidence and criteria. Record
completion, quality and usefulness separately. A later successful repair does
not change the original submission's grade, and retries of one task do not
provide independent model-ranking successes.

## Recover ordinary supervision

1. Inspect native-agent and process handles. A `running` checkpoint alone does
   not establish death. Keep waiting on a live handle; do not relaunch.
2. Inspect `diagnose --out RUN`, candidate identities and the cost ledger. Preserve
   a private `incident --out RUN` snapshot when needed. These inspect locally;
   incident recovery does not resume a worker or release an execution lock.
   Missing/corrupt reports yield explicit artifact states and unknown completion;
   empty diagnostics do not establish zero workers or zero cost.
3. When death is established, review surviving candidates and the source snapshot
   before constructing a new bounded assignment. Keep task/assignment identity,
   increment its attempt index and account for prior spending and unknown charges.
4. Return the interrupted receipt to the primary host. Do not delete its lock or
   reset `running` to restart ordinary supervision. A fresh approved packet is
   another attempt, not transcript resume. Existing runs have no stored transcript
   that can be retroactively converted into a Durable session.

## What upstream shipped on October 1, 2026

Pi 1.0 adds Codemode/MCP, virtual models, deferred tools, cache warming and
transcript-aware prompt changes. Durable execution is a separate **experimental**
package whose API can change without notice. See the
[Pi 1.0 announcement](https://earendil.com/posts/pi-1-0/) and
[Durable announcement](https://earendil.com/posts/pi-durable/).

Durable supplies stored conversations/tasks, replay policies, document state,
compaction and usage accounting. Its storage needs a single owning process;
upstream does not provide cross-process locking. This skill chooses private
JSONL with `fsync: true`, adds an exclusive ownership protocol and disables
compaction, deferred work and automatic retries. It installs no default coding,
shell, MCP, environment or subagent extension. Upstream capabilities outside
this adapter are not skill permissions. See the
[versioned Durable README](https://github.com/earendil-works/pi/blob/v1.0.0/packages/durable/README.md).

## Optional Durable execution

Use ordinary supervision for candidate edits, teams or workflows. Durable is
useful when a bounded read-only investigation needs to survive process death
while its primary host can review recovery. Before enabling it for actual work,
obtain explicit approval to retain a private full transcript. This can contain
selected source and provider-native reasoning/signatures; the approval to install
the dependency does not authorize retention for every project.

Spawn the actual native execution/review supervisor and register its returned ID
from the primary host. Choose a new directory outside the task repository:

```sh
node /absolute/path/to/pi/scripts/pi.mjs durable init --plan /private/plan.json --out /private/session --agent-id ACTUAL_NATIVE_ID --retain-transcript approved
```

The plan must have exactly one read-only worker with the existing exact file,
model, effort and allocation grants. Initialization is local and performs no
inference. It freezes the approved plan and source manifest. It refuses existing
output and links; the session directory/files must have private POSIX modes and
belong to the current user. This first adapter refuses Windows instead of making
an untested private-ACL claim.

The registered supervisor runs the bounded process and retains its live handle:

```sh
node /absolute/path/to/pi/scripts/pi.mjs durable run --out /private/session
```

This is paid inference under the approved plan. The adapter uses the same runner
admission guards, tool capabilities, validated submissions and billing ledger as
ordinary supervision. It commits admission to a single fsynced `run/recovery.json`
before dispatch; `run/report.json` and `run/usage.json` are normal diagnostics.
Read/search tools operate on the frozen snapshot. Safe tool receipts and
capability counters commit to Durable document state; replay returns a committed
receipt without performing or counting that tool twice. `submit_result` also
commits a receipt before publication and terminates the conversation.

Private transcript storage is under `SESSION/transcript`. It is separate from
incidents, learning and the source release. Plans, snapshots and transcripts
remain host-local. The adapter supplies no credential store or environment;
provider keys stay in the approved runner's memory. Provider error messages
are scrubbed before storage. Keep this directory out of backups/shares unless
separately authorized. After primary-host review and any needed local evidence
retention, the host may delete the whole session using normal authorized file
operations. There is no automatic deletion schedule.

## Explicit crash recovery

`inspect` is dependency-free and local. It hashes artifacts and reports ownership,
original deadline, request count and provisional budget exposure without loading
transcript content into output or opening a scheduler:

```sh
node /absolute/path/to/pi/scripts/pi.mjs durable inspect --out /private/session
```

If delayed provider billing needs refreshing, the host can run
`reconcile --out SESSION/run` before creating a recovery approval. For Durable
sessions it takes the ownership/maintenance mutex, rejects live or unknown owners,
and updates both recovery and diagnostic ledgers. Inspection and resume also
preserve known billing from a diagnostic ledger written before that synchronization;
conflicting known charges or request identities fail closed.

When the original process is genuinely dead, the **primary host** checks its
native handle, inspected artifacts, current source, unresolved charges and
remaining original authorization. It spawns a new actual native supervisor and
writes a private approval with exactly these fields:

```json
{
  "reviewed_by": "codex",
  "native_agent_id": "ACTUAL_NEW_NATIVE_ID",
  "previous_process_dead": true,
  "artifact_fingerprint": "EXACT_FINGERPRINT_FROM_INSPECT"
}
```

Use `claude-code` when that is the plan's primary host. The new supervisor runs:

```sh
node /absolute/path/to/pi/scripts/pi.mjs durable resume --out /private/session --approval /private/recovery-approval.json
```

The CLI cannot authenticate native agents or host approval; these are explicit
host attestations bound to inspected bytes. It rejects an alive PID, another
hostname, unknown process death, changed artifacts/source/model resolution,
missing recovery data or a settled session. It serializes ownership replacement
with an exclusive recovery mutex, archives the old owner receipt and records the
new one. A stale recovery mutex or incomplete ownership transaction fails closed;
return to the primary host, inspect exposure and construct a fresh approved
attempt rather than clearing locks blindly.

Resume does not restart the original elapsed deadline, request count, tool count,
completion repair allowance, effort or budget. Interrupted requests keep their
reservations and unknown charges. Replaying a pending generation is another
provider dispatch and consumes another request/reservation. This can conservatively
charge the allowance for an admission that died before reaching transport; it is
never reported as known provider billing. Previously captured OpenRouter generation
IDs are reconciled before further work; absent billing stays unknown. A committed
submission can finish recovery without another model request.

Recovery opens the harness only after host approval, exclusive ownership and
contract checks. Opening alone does not run tasks. Submission/wait are the explicit
scheduling boundary. Cancelling a wait is insufficient upstream; the adapter's
abort targets the conversation's owned work. Abort and timeout are cooperative,
so a blocked dependency still requires the host's process tools. Ordinary exits,
errors and cancellation settle the session; `resume` is for hard interruption,
not an automatic retry of a settled failure.

## Advisory review and learning

After execution, the current native supervisor inspects the results and prepares:

```json
{
  "native_agent_id": "CURRENT_ACTUAL_NATIVE_ID",
  "artifact_fingerprint": "EXACT_FINGERPRINT_FROM_INSPECT",
  "verdict": "ready_for_host",
  "summary": "Evidence inspected, remaining uncertainty and concerns."
}
```

`verdict` may also be `needs_work` or `blocked`. Store the advisory receipt with
`durable review --out SESSION --review REVIEW.json`. `inspect` exposes
`review_current`; changed reviewed artifacts invalidate it. This Durable receipt
is separate from ordinary `supervise review` and preserves each owner's history.
The primary host still checks source evidence, judges quality, performs any tests
and controls all integration. No command applies code.

Experimental Durable runs are intentionally excluded from project learning
inventory, ordinary finalization and preference promotion. Their local reports
and recovery ledger remain available for cost/evidence inspection. Supporting
backend-specific learning profiles is a later change requiring explicit schema,
identity and migration tests; do not relabel these reports as `pi_sdk`.

## Migration and validation

The ordinary SDK migration replaces removed `shouldStopAfterTurn` with `finishTurn`.
Submission-only finalization now appends a transcript system/tool-removal delta
and retains the execution guard. Existing constraints remain in force. The
[versioned Agent changelog](https://github.com/earendil-works/pi/blob/v1.0.0/packages/agent/CHANGELOG.md)
explains the upstream API transition.

Existing plans, reports and learning history are not rewritten. Ordinary new
reports declare SDK `1.0.0`; existing profile identity already includes SDK version,
so older evidence stays separate. Promotion thresholds/model-version grouping
rules are unchanged. New result checkpoint fields `pending_completion` and
`halt_reason` are additive. Durable contract/state and recovery ledger each start
at schema 1; unsupported versions fail closed. No old transcript is manufactured
from public excerpts, and no implicit storage migration occurs.

Installed-SDK tests use synthetic SSE and actual subprocess `SIGKILL` boundaries
before dispatch and after safe read/submission commits. They check preserved
reservations, counters/deadlines, duplicate prevention, changed grants and bounded
repair. These are local synthetic results, not proof of live provider behavior,
quality, power-failure recovery or host UI integration. See the current
[validation record](../references/validation.md). Live smoke tests need separate
spending approval; installation updates and system changes keep their normal
explicit authorization.
