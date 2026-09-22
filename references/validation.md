# Validation record — pi 1.6.0

Executed locally on September 22, 2026, on macOS with Node 22.23.1:

- Release preparation used `npm ci --ignore-scripts` with the tracked lockfile;
  `npm audit` reported zero vulnerabilities. Dependency versions are unchanged.
- `npm test`: 194 tests passed, zero failures. New synthetic coverage exercises ordered
  candidate handoffs, different phase models, parallel baseline isolation, loop closure,
  no-progress/iteration stops, shared costs/reservations/deadlines, narrowed retries,
  stale source/artifact rejection, host/revision checks, interrupted-run reporting,
  Mermaid/ASCII output and template/CLI validation.
- `npm run check:sdk`: installed exports, version pins, effort mapping, construction and
  diff generation passed without provider requests.
- `npm run test:sdk`: six installed-SDK tests passed using synthetic transport.
- Skill quick validator and `git diff --check`: passed.
- Release allowlist inspection included the workflow module, synthetic tests, template
  and guide, with no private workflow state, run, handoff or dependency paths.

No paid inference, live provider workflow, actual harness diagram rendering, CI run,
or Windows/Linux execution was performed during feature validation. Dependencies and
system settings were unchanged. Host validation records remain attestations;
these tests do not prove that a real host makes correct qualitative decisions.

---

# Validation record — pi 1.5.0

## Executed locally on September 22, 2026 (macOS, Node 22.23.1)

| Check | Observed result |
| --- | --- |
| `npm run check:sdk` | Passed with the installed SDK: exports, version pins, effort mapping, construction and diff generation |
| `npm run test:sdk` | Passed with the installed SDK and synthetic transport |
| Offline execution and finalization flow | Passed with an actual `executeJob` using an explicit synthetic/offline test worker: the saved result artifact digest matched a recomputation, a schema-2 assessment was accepted, `finalize` exited 0, and an idempotent replay exited 0. No live learning or inference was used. |
| Dependency-free TUI tests and primary-host PTY check | Passed for responsive rendering, project views, token/cost coverage, scrolling, reload, search, detail views and terminal cleanup. The refreshed `r` view showed the updated timestamp and Learning showed `no_runs` with its next action; `q` and Ctrl-C exited cleanly without dumping JSON state. |
| Skill quick validator and `git diff --check` | Passed |
| `npm test` and SDK checks | Passed on the primary host; the final test count is intentionally omitted here. |
| `npm run package` | Passed on the primary host: ZIP/CRC/checksum validation and the allowlist found no `.pi`, `runs`, `node_modules` or credential content. Archive hashes and entry counts are intentionally omitted. |
| `npm audit` | Passed: 0 vulnerabilities reported |
| Live read-only provider check | One real read-only OpenRouter review used DeepSeek v4 Pro, canonical `20260423`, at `xhigh` over three repository files. It ran for 389.493 seconds across five requests; all requests reconciled to `$0.042198529`, excluding Codex. The source snapshot was unchanged before integration and no identity mismatch occurred. |
| Host assessment and learning review | Six findings were reported: the host accepted one reproduced parse/hash race and rejected five as false positives, intended legacy behavior or fail-closed behavior. Original quality was `1/3`; usefulness was `2/3`. Preregistered evidence/actionability failed while coverage passed. No promotion was made from one observation. |
| F3 artifact identity and finalization | The read-time-hash fix was reviewed. `finalize --require-complete` exited 0, persisted the schema-2 grade, recorded learning and finalized the inventory; no eligible profile was found and no `AGENTS.md` apply occurred. An idempotent replay exited 0 without changing the result. |
| Durable/raw statistics cross-check | Durable and raw model records and group keys agree; the joined lifecycle is `finalized`, and costs, grades and token totals match. The same-plan recommendation matched all 12 descriptive dimensions, including focus set and runtime. It remains advisory and makes no exact-profile claim. |

The primary host completed the local validation checks, the authorized live read-only provider check, the F3 read-time-hash verification and the final statistics cross-check.

### Not validated for 1.5.0

This is one observational run, not a model benchmark. Other providers, routes, hosts and platform runtimes were not live validated. No raw prompts, source text or history are recorded in this validation document.

---

# Validation record — pi 1.4.0

## Executed on September 16, 2026 (macOS 27.0, Node 22.23.1)

| Check | Observed result |
| --- | --- |
| `npm test` | **142 passed; 0 failures** (110 from 1.3.0, plus 32 covering finalization, bounded repair, independent timers, checkpoints, worker allocations, partial/blocked claims, refusal handling, tool-error separation, `diagnose`, and a guard that every shipped example plan validates against the bundled defaults) |
| `npm run check:sdk` | Passed: exports, version pins, effort mapping, Agent construction, diff generation |
| `npm run test:sdk` | **6 passed** with the installed SDK and synthetic transport (3 from 1.3.0, plus continuation after a premature normal stop, refusal of a length-truncated edit, and a reduced per-worker allocation) |
| `node --check` on all `.mjs` files | Passed |
| `npm run package` | Allowlisted contents; no private or runtime files in the release tree |

The runtime tests use an injected clock and timer table rather than real waiting, so every deadline, heartbeat and idle-timeout assertion is deterministic. A fake clock proves the runner's own arithmetic and ordering; it proves nothing about a real provider's latency.

### Not validated for this release

**No live inference was run for 1.4.0.** Every claim about long-running behavior above is tested against fixtures, not against a real provider, host or billing system. The live session recorded under 1.3.0 below motivated this design but was run against the previous runner: it is evidence for the problem, not for the fix. Also unvalidated here: Codex Desktop and Claude Code application behavior, Windows and Linux runtime, the published CI matrix, real cost reconciliation at these settings, and whether the reserved finishing window and bounded repair actually raise the rate of useful submissions. That last question needs a real session with the same models and packets, compared honestly against the 1.3.0 results below.

---

# Validation record — pi 1.3.0

## Executed on September 15, 2026 (macOS, Node 22.23.1, npm with registry access)

| Check | Observed result |
| --- | --- |
| `npm install --ignore-scripts` | Resolved the pinned graph; a genuine `package-lock.json` was generated; 0 vulnerabilities reported |
| `npm run check:sdk` | Passed: exports, version pins, effort mapping, Agent construction, diff generation |
| `npm test` | **110 passed; 0 failures** (103 existing plus 7 new runtime tests; 4 existing tests had failed on macOS because of the `/var` → `/private/var` symlink and were fixed) |
| `npm run test:sdk` | **3 passed** with the installed SDK and synthetic transport |

### Live inference, first real session

Host: Claude Code. Provider: OpenRouter with the bundled routing (`data_collection: deny`, no fallbacks). Task: three read-only reviews of a private Node/TypeScript repository (source and documentation only; no private data files). Four runs, reconciled against OpenRouter generation billing:

| Worker | Model · effective effort | Result | Reconciled charge |
| --- | --- | --- | --- |
| design challenger | `meta/muse-spark-1.3` · max | completed, 55 s, 10 findings | $0.0997 |
| security reviewer | `deepseek/deepseek-v4-pro` · xhigh | completed, 372 s, 7 findings | $0.0871 |
| correctness reviewer, run 1 | `~x-ai/grok-latest` · xhigh | **timeout** at 600 s after reading 13 files; 9 requests averaging 67 s (three at 120–135 s); no submission | $0.3847, then flagged `model_mismatch` at reconciliation because it was billed as `x-ai/grok-4.6-20260810` (fixed in 1.3.0) |
| correctness reviewer, run 2 | `deepseek/deepseek-v4.1-flash` · max | **error**: upstream HTTP 429 at turn 4 | $0.0028 + 1 unpriced request |
| correctness reviewer, run 3 | `google/gemini-3.8-flash` · high (clamped from xhigh) | **output_limit**: final request used 31,455 of 32,768 output tokens, all reasoning; no submission | $0.1658 |
| correctness reviewer, run 4 | `deepseek/deepseek-v4-pro` · xhigh | completed, 333 s, 6 findings, with a hard word cap in the packet | $0.0553 |

Pi delegation cost for the session, excluding Claude Code: **$0.7955** provider-reported plus one unpriced request. The three failures motivated the grace window, the failure classes, the `check` advice and the alias-identity fix in this release. The observations are one session on one repository; they are not a benchmark of the preferred models.

---

# Validation record — pi 1.2.0

Prepared **September 14, 2026**. Executed checks are distinguished from supplied-but-unexecuted checks. This is not a security audit, a real-host certification, a model benchmark or evidence that project learning improves outcomes.

## Executed in the preparation environment

Linux, Node.js **22.16.0**, npm **10.9.2**. This Node can run the dependency-free tests but is **below** the pinned Pi SDK minimum of 22.19.0. It is not an approved live runtime.

| Check | Observed result |
| --- | --- |
| `npm test` | **103 passed; 0 failures, 0 skipped, 0 cancelled** |
| `node --check` on all `.mjs` files | **18 modules passed** |
| JSON files | **7 parsed** |
| YAML metadata/workflows | **3 parsed**, plus shared SKILL frontmatter |
| Skill name / portability | `pi`; only standard name/description frontmatter; no fork/tool grants |
| Local Markdown links | All local targets exist |
| `doctor` without SDK/key | Correctly reported not-ready, no network or secret values |
| `auth` without interactive TTY | Refused before credential writes, exit 1 |
| `smoke` without paid opt-in | Refused before inference, exit 1 |
| Real-source both-host installer | Two complete source copies in a temporary repository; bytes checked; original project AGENTS/CLAUDE unchanged |
| Learning CLI in temporary project | Explicit import preserved human text; proposal did not edit AGENTS; reviewed empty-profile apply and repeat no-op checked |
| Source archive | Allowlisted contents, source-byte matches, ZIP CRC/root paths, exclusion checks and identical-input two-build determinism verified |

The actual offline test log is [offline-test-results.txt](offline-test-results.txt). Test Agent/model/usage data are synthetic and explicitly labeled in the test source. A test fixture can exercise a real-report schema without becoming proof of actual inference. No real project learning observations are shipped.

## Coverage added for this release

Both-host installation paths, Claude config relocation, no-overwrite preflight, instruction preservation, actual-host plan/report/assessment labels, and worker refusal of instruction/memory paths are tested.

Learning tests cover opt-in modes, explicit bridge behavior, stable task IDs, retry cost/sample handling, changed host/model/version/scope/strategy/team/effort/access/upstream configurations, operational failures versus model quality, validation floors, insufficient evidence, unknown/late charges, model mismatch, negative evidence, late regression revisions and withdrawal, expiration, fresh metadata requirements, fixed-vocabulary lessons, proposal tampering/staleness, manual-content preservation, bounded Markdown, lock/link/file checks and actual CLI argument handling. Nested private learning/host state is rejected from distribution.

Existing tests cover candidate overlays, no worker shell/network tools, source containment and portable names, secret paths, evidence validation, snapshot staleness, model/effort resolution, request reservations, error/cancellation accounting, source retrieval logs, credential lookup, report dispositions and source packaging.

These checks cannot prove that an assessment is truthful or that a model's findings are correct. `assessed_by` and `--reviewed-by` are trusted-host attestations, not process authentication or a substitute for test evidence.

## Not successfully validated here

| Check | Status and reason |
| --- | --- |
| Dependency installation / genuine lockfile | Registry DNS lookup failed (`curl` exit 6); no dependency graph or lockfile was fabricated |
| `npm run check:sdk` | Invoked but failed with `ERR_MODULE_NOT_FOUND`; installed SDK compatibility was not tested |
| `npm run test:sdk` | Three real-SDK/synthetic-transport tests are supplied, not executed because packages are absent |
| Paid OpenRouter or native-provider inference | Not performed; no approved live call/key |
| Real provider cost reconciliation | Fixture-tested only, no live generation |
| Codex Desktop or Claude Code application discovery/execution | Documentation-based instructions; neither application was exercised |
| macOS/Windows runtime and Windows ACL/filesystem behavior | Not executed on those operating systems |
| Published GitHub Actions matrix | Supplied workflow, not run on GitHub |
| Real project learning performance | No real observations, outcome benchmark or causal comparison collected |

The separate installed-SDK suite uses the pinned SDK with synthetic HTTP/SSE responses to test serialization, usage, tool events, candidate export and stopping. It is not included in the 103 offline passing tests and does not validate paid endpoints or either host UI.

## Connected-machine validation before a release tag

Use Node >=22.19.0 and a trusted registry connection, then run from the repository root:

```sh
npm install --ignore-scripts
npm run check:sdk
npm test
npm run test:sdk
npm run package
```

Inspect and commit the genuinely generated `package-lock.json`; then prefer `npm ci --ignore-scripts`. Check fresh Codex-only, Claude-only and both-host installs, the actual host invocation/approval flow, and shared instruction import behavior. Do not mistake CLI fixture checks for a real-app check.

After separate explicit approval of external cost, `npm run smoke -- --allow-paid` uses a tiny public fixture rather than private source. Verify returned identity/effort, structured completion, source immutability and reported/unknown charges. Its $0.25 guard is soft, not a guaranteed ceiling. Record any real results honestly before approving private-source use.
