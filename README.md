# pi Delegate

**Codex or Claude Code decides. Pi workers investigate, challenge, and propose.**

A standalone skill for bounded multi-model coding delegation through Pi. The current host selects models, roles, context, thinking effort and permissions; independently validates the results; and alone decides what to integrate. Optional project-local learning turns validated outcomes into compact, reviewed routing preferences in `AGENTS.md`.

The repository root is the complete skill. Its name and install directory are **pi** on both hosts. This is an independent MIT-licensed project, not an official OpenAI, Anthropic, Pi or OpenRouter product.

**Validation:** 110 dependency-free tests pass, and the installed-SDK checks pass on macOS with Node 22.23. Live inference and billing reconciliation have been exercised in one real four-run session (Claude Code host, OpenRouter); real host-application discovery on Codex Desktop remains unexercised. See [the exact validation record](references/validation.md); this is not an audited security boundary or a benchmark of the preferred models.

## Install

Requires **Node.js 22.19.0+**, npm, a local host able to run the scripts, and an approved model-provider key. Pi SDK is pinned to **0.85.1**; a separate global Pi CLI is not needed. [Pinned SDK requirement](https://raw.githubusercontent.com/earendil-works/pi/v0.85.1/packages/agent/package.json).

Extract the ZIP or clone the repository, then run from its root:

```sh
node scripts/install.mjs --host both
```

Use `--host codex` or `--host claude-code` for one host. The default remains Codex for compatibility.

| Host | Personal installation | Invocation |
| --- | --- | --- |
| Codex | `~/.agents/skills/pi` | Select **pi** in Desktop Skills; `$pi` in CLI/IDE |
| Claude Code | `~/.claude/skills/pi` | `/pi` |

These are the hosts' documented skill locations. Claude's `CLAUDE_CONFIG_DIR` is honored for a relocated personal configuration. [Codex skills](https://developers.openai.com/codex/skills), [Claude Code skills](https://code.claude.com/docs/en/skills).

Install dependencies and check **each installed copy**. On macOS/Linux:

```sh
cd "$HOME/.agents/skills/pi"
npm install --ignore-scripts
npm run check:sdk
npm test
npm run test:sdk

cd "$HOME/.claude/skills/pi"
npm install --ignore-scripts
npm run check:sdk
npm test
npm run test:sdk
```

Skip the copy you did not install, and adjust the Claude path for a custom config directory. PowerShell instructions are in [installation](docs/install.md). The installer refuses to overwrite existing directories and preflights both targets before copying. It does not install dependencies, change either application's settings, modify task-project instructions, or grant tools. For an update, preserve/review your existing installation before moving it aside and installing a fresh one; do not silently overwrite local changes.

Run credential setup **yourself in a terminal**, once for the shared local credential file:

```sh
node scripts/pi.mjs auth
node scripts/pi.mjs doctor
```

Alternatively supply `OPENROUTER_API_KEY` through the approved execution environment. The optional file is `~/.config/pi/credentials.json`: **plaintext, not encrypted**, with POSIX owner-only permissions or requested Windows current-user directory ACLs. No key belongs in a chat, plan, repository, or `AGENTS.md`. See [security and platform caveats](docs/security.md).

Select **pi** in Codex Desktop or enter `/pi` in Claude Code. Restart a session if a newly created skill directory is not discovered. Example Claude request:

```text
/pi Investigate this bug using two independent models from my preferred pool.
Keep the reviewer read-only. Grant candidate-write access only where useful.
Independently verify every accepted contribution before integration.
Report usefulness and Pi cost. Use project learning only when it is enabled.
```

For repository-only installation, add `--repo /absolute/project/root`; the corresponding destinations are `.agents/skills/pi` and `.claude/skills/pi`. A local installation does not provision remote/Cowork sessions or bypass host sandbox/network approval. Full guides: [both hosts](docs/install.md), [Codex Desktop](docs/desktop-install.md), [Claude Code](docs/claude-code-install.md).

## Authority and isolation

Read workers receive only bounded list/read/search and structured-result tools. Write workers additionally create, replace and delete explicitly authorized **candidate** files in their private in-memory overlay. They cannot change the actual checkout, execute commands or tests, invoke arbitrary network tools, load extensions, recursively delegate, commit, merge, or push. Instruction and memory files are not delegable source or write targets.

Each worker sees an isolated snapshot of selected current source, including authorized uncommitted changes. A same-plan reviewer sees the original baseline, not another worker's edits. The host inspects candidates, runs actual validation, checks snapshot freshness, and integrates only chosen changes with its normal tools. Agreement is not a vote to merge.

These are restrictions on **model tools**, not an operating-system sandbox for the trusted Node process and dependencies. Read-only still permits approved source to be sent to a model provider. See [security](docs/security.md).

## Defaults and configuration

OpenRouter remains the preferred gateway, with this preferred pool:

```text
x-ai/grok-latest
google/gemini-3.8-flash
deepseek/deepseek-v4.1-flash
deepseek/deepseek-v4-pro
meta/muse-spark-1.3
```

The configured explicit alias for `x-ai/grok-latest` is `~x-ai/grok-latest`. The runner rechecks the live catalog, records exact requested/resolved/returned identities and refuses unavailable or unauthorized substitutions. The list is a preference, not a promise of permanent availability or account access. [OpenRouter catalog](https://openrouter.ai/api/v1/models).

Request `xhigh`, or `max` for more complex work. `best_supported` resolves exact, otherwise next higher supported, otherwise highest available; all mappings are reported. `strict` refuses non-exact mappings. No fixed model specialty or performance ranking is invented.

Defaults allow at most three workers, two concurrent, $2 per worker and $5 per **run plan**. These are soft request-boundary guards, not billing guarantees or authorization for repeated $5 phases. The host must track the user's total approved spend across runs. OpenRouter gateway preference and upstream hosting-provider/privacy restrictions are separate settings.

Append the relevant [AGENTS.md configuration example](templates/AGENTS.example.md) to existing human-maintained project instructions. The host resolves instruction precedence and compiles a validated JSON plan; the runner never parses arbitrary Markdown as executable configuration. Set the actual `orchestrator` to `codex` or `claude-code`; assessments use `Codex` or `Claude Code`. See [configuration](docs/configuration.md).

## Optional project learning

Learning is a project-specific routing aid, **not model training or an autonomous self-improvement loop**. The host records validated outcomes, reviews aggregated evidence, then decides what is worth promoting. Workers cannot assess themselves or write instructions.

```sh
node scripts/pi.mjs learn init --repo /absolute/project/root --mode propose --claude-import
```

`--claude-import` explicitly appends `@AGENTS.md` to `CLAUDE.md` without replacing existing instructions. Claude Code documents this bridge because it does not read `AGENTS.md` automatically. Installation alone does not add it. [Claude memory](https://code.claude.com/docs/en/memory).

`propose` requires user approval before an instruction update. Choose `auto` explicitly to let the primary host apply eligible **host-reviewed** updates without approval each time. Neither mode creates a background job, reflection-model call, or automatic commit.

Private ignored history lives under `.pi/learning`; only the small managed `AGENTS.md` block is intended for sharing. Default eligibility requires three distinct validated useful tasks, at least 75% useful among quality-evaluated tasks, and no contradictory validated harm in 90 days. These are policy heuristics, not statistical confidence. Same-task retries do not inflate sample counts; their costs still count. Host/model/effort/scope/strategy changes and changed worker teams remain separate. Late regressions can revise evidence and withdraw a preference.

The generated block is advisory, at most six profiles and 4,096 bytes. It cannot change human policy, provider lists, budgets, permissions or validation requirements. Record/propose do not edit instructions; a separately reviewed apply does. See [the complete learning lifecycle](docs/learning.md), including corrections, expiry, privacy, provenance and concurrency limitations.

## Commands and artifacts

Run from the skill directory or use an absolute runner path. Common commands:

```sh
node scripts/pi.mjs check --plan /private/plan.json
node scripts/pi.mjs run --plan /private/plan.json
node scripts/pi.mjs reconcile --out /private/run
node scripts/pi.mjs verify --out /private/run
node scripts/pi.mjs report --out /private/run --assessment /private/run/assessment.json
node scripts/pi.mjs ledger --out /private/runs-for-this-task
node scripts/pi.mjs learn help
```

`ledger` is local: it totals the reconciled ledgers of several run directories (the phases of one task) under one parent, labelled for the host. Each worker result also carries a `failure_class` and hint separating provider outages and packet problems from model quality, per-request timing, and the deadline counters of the submit grace window.

`check` and `models` use provider metadata, not inference; `doctor`, `verify`, `report` and learning are local. `run` performs **paid inference**. Reconciliation requests billing metadata. The optional `npm run smoke -- --allow-paid` requires explicit approval and uses a public synthetic fixture, not a user's source.

Run folders are outside the task repository, by default under `~/.cache/pi/<run-id>`. They contain normalized plan/snapshot metadata, usage and report files, per-worker structured results/events, candidate patches/files, and the host's optional assessment. No full reasoning transcript is retained, but source snippets and candidate content can still be private. Do not publish run folders. [Artifact/workflow details](docs/workflows.md).

Reports separate provider-reported charges, unresolved estimates and unknown requests; unknown is never zero. OpenRouter reconciliation uses generation `total_cost` when available and does not add an estimate on top of a reconciled charge. Host costs are excluded and the report names the actual host. Failed/rejected attempts remain in the ledger. [OpenRouter generation metadata](https://openrouter.ai/docs/api/api-reference/generations/get-request-%26-usage-metadata-for-a-generation).

The host scores each worker 0–3, states its independently checked contribution, and explicitly accepts, rejects or defers every finding. Proposed tests are not executed tests. Reports and learning rely on truthful host attestations; they do not prove those judgments automatically.

## Research, validation and publishing

This version incorporates focused/isolated subagents, explicit effective configuration and bounded learning from upstream/community patterns. It deliberately omits recursive privilege expansion, automatic commits, unrestricted shell workers and worker-authored authoritative memory. [Primary sources and tradeoffs](references/research.md).

The project includes source, templates, 110 offline tests, separate installed-SDK tests, cross-platform installation helpers, a CI matrix, MIT license, contribution/security guidance and deterministic allowlisted ZIP packaging. The CI matrix is supplied, not claimed to have run. [Executed and unexecuted checks](references/validation.md).

Publish the **contents** of the extracted `pi` directory as the GitHub repository root. On a networked machine with supported Node, generate and review a genuine `package-lock.json`, run the SDK checks, and commit the lock. None is fabricated in this archive. Build a distributable archive with:

```sh
npm run package
```

This writes `dist/pi.zip` and `dist/SHA256SUMS`, excluding dependencies, credentials, Git metadata and private runtime state. See [the release checklist](docs/releasing.md). No repository has been created or published on your behalf.
