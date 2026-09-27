# Private delegation incidents

Incomplete, skipped, failed, and interrupted delegations need an operational record even when project learning is off. The runner and host supervisor save structural incident snapshots in `RUN/incidents/`. A preflight failure before a run exists uses the private supervision directory selected for that attempt. No incident operation writes project learning state, changes permissions or budgets, launches inference, retries a worker, or integrates a candidate.

The dedicated host supervisor should inspect its actual task/process handle and the saved run before deciding what happened. If the runner was interrupted before its final incident hook, recover a snapshot locally:

```sh
node scripts/pi.mjs incident --out /absolute/private/run
```

The standalone equivalent is `node scripts/incidents.mjs --out /absolute/private/run`. Both return the JSON and Markdown paths. Recovery does not establish that the process is dead: a checkpoint can be unfinished while a worker still runs. Missing or corrupt artifacts remain explicit uncertainty; a hard kill cannot execute its own cleanup hook. Do not launch another worker merely because a checkpoint looks unfinished.

Each snapshot contains fixed status/category codes, timestamps, numerical limits and counters, candidate content hashes and counts, hashed worker/model identities, and request/cost summaries. Numerical token counts, including a reasoning-token count when reported, carry the number of observed requests; they never include reasoning text. A missing ledger means unknown costs. Provider-reported charges, unreconciled estimates and unpriced requests stay separate, and a reservation is never a charge. Host and supervisor costs are excluded.

Incident artifacts deliberately omit objectives, prompts, file paths, source text, public partial output, reasoning, submissions, raw exceptions, freeform provider messages, endpoint URLs and credential values. Arbitrary fields are excluded by an allowlist rather than pattern redaction. Original worker/model identifiers are hashed, so correlate them with the private run locally; hashes are correlation handles, not an anonymization guarantee. Source hashes can also reveal whether known content was used. Review before sharing.

Operational failures, limits, refusals, missing submissions, partial claims and skipped workers remain separate categories. These are diagnostic observations. They are neither model-quality rankings nor proof that a task succeeded or failed for a particular cause. The host still validates results and owns integration decisions.

New incident directories are mode `0700`; JSON and Markdown files are mode `0600`. The writer rejects symlink/hardlinked artifacts, refuses an existing non-private incident directory, and uses exclusive file publication. It never follows linked report/usage files; those inputs are marked unavailable. Existing curated reports are retained. Repeating the same snapshot reuses an unchanged pair; changed snapshots and curated pairs produce additional files. Keep curation in a separate local note when practical.

The writer bounds artifact reads and saved collections. Missing, malformed, oversized or unsafe inputs produce uncertainty rather than fabricated details. If incident publication itself fails, callers receive a fixed `incident_write_failed` code and preserve the original run outcome. No raw error is copied into the incident response.

## Integration API

```js
import { needsIncident, tryWriteIncident } from './incidents.mjs';

if (needsIncident(report)) {
  const incident = tryWriteIncident(out, {
    report,
    usage: { requests },
    phase: 'execution',
    failure_code: 'worker_incomplete'
  });
  // Surface incident.json / incident.markdown, or incident.code when unavailable.
  // Do not turn a diagnostic write failure into a different execution outcome.
}
```

`writeIncident(directory, envelope)` throws on publication failure; `tryWriteIncident` returns `{ status: 'unavailable', code: 'incident_write_failed' }`. Successful calls return `status` (`written` or `existing`), `fingerprint`, `json`, and `markdown`. Omit `report`/`usage` to read bounded local `report.json`/`usage.json`; supply `null` to declare an unavailable input. `incidentMain(args)` provides the command handler.

The caller creates or chooses the directory. For a preflight failure use the already authorized private supervision directory, pass `phase: 'preflight'` and `failure_code: 'preflight_failed'`, and retain the original error only through existing host-local diagnostics. Do not substitute a global cache directory or create an opt-in project directory automatically.

Allowed phases are `preflight`, `execution`, `recovery`, and `supervision`. Failure codes are `preflight_failed`, `execution_failed`, `supervision_failed`, `worker_incomplete`, `orchestration_error`, `unfinished_run`, `missing_artifacts`, `invalid_artifacts`, `host_interrupted`, and `unknown`. Unrecognized phase/code values are not copied through.

The initial incident schema is version 1 and is independent of learning-state schemas. Snapshots are append-only; no learning migration, promotion rule, or model grouping changes are involved. Tests use synthetic fixtures only and do not demonstrate live provider or host-UI behavior.
