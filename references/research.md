# Research: multi-model Pi delegation

Reviewed September 14, 2026. These are primary project/documentation sources, not a benchmark or a claim that every feature has been tested locally. Upstream `main` branches and model aliases can change. This repository does not vendor these extensions.

## Pi's official subagent example

[Upstream example and role-based workflows](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/subagent) · [README source](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/examples/extensions/subagent/README.md).

The example separates subagent context, offers single/parallel/chained execution, and demonstrates scout/planner/worker/reviewer roles with usage visibility. It shows why a small reusable role is more useful than simply adding another undifferentiated assistant.

**Adopted here:** focused tasks, context separation, independent parallel workers, per-worker metadata, and cancellation handling. **Changed:** The current primary host controls transitions between phases; this runner supplies explicit in-memory tools instead of spawning a shell-capable Pi process. Separate model context alone is not a filesystem permission boundary.

## nicobailon/pi-subagents

[Repository](https://github.com/nicobailon/pi-subagents) · [model configuration](https://raw.githubusercontent.com/nicobailon/pi-subagents/main/docs/models.md) · [observability](https://raw.githubusercontent.com/nicobailon/pi-subagents/main/docs/observability.md).

This implementation documents scoped roles, parallel reviews for different concerns, council-style opinions, model configuration precedence, and compact progress/artifact handling. Those are useful patterns for obtaining a distinct perspective without flooding the parent context.

**Adopted here:** role-specific packets, independent first-pass opinions, exact per-worker model selections, concise progress, evidence artifacts, and cost visibility. **Not adopted:** detached jobs, autonomous resume chains, full transcript sharing, or low-thinking defaults that would conflict with the requested `xhigh`/`max` policy. A council is treated as evidence collection, not a majority-vote authority.

## tintinweb/pi-subagents

[Repository, agent-type configuration and model resolution](https://github.com/tintinweb/pi-subagents).

The project exposes model/thinking/tool configuration, scoped delegation, worktree options, and effective model-resolution visibility. Its documented tolerant resolution and fallback options illustrate why configuration and the actual run identity should be reported separately.

**Adopted here:** explicit access per worker and requested-versus-effective settings. **Deliberately different:** no fuzzy model lookup, hidden cross-provider fallback, nested delegation, background execution, automatic commits, or unrestricted worktree tools. This project chooses capability-limited candidates because the current primary host must remain the sole integration decision maker.

## Technical verification sources

[Pi Agent 0.85.1 API](https://raw.githubusercontent.com/earendil-works/pi/v0.85.1/packages/agent/README.md) and [Agent implementation](https://raw.githubusercontent.com/earendil-works/pi/v0.85.1/packages/agent/src/agent.ts) support the chosen tool/event/stop-hook integration. Pi 0.85.1 awaits event subscribers and can emit a synthetic zero-usage error after a failure; the ledger must not overwrite an earlier completed request with that event.

[Pi AI package metadata](https://raw.githubusercontent.com/earendil-works/pi/v0.85.1/packages/ai/package.json) does not expose `package.json` as a public export. The earlier checker used an incompatible metadata lookup; the revised checker resolves the installed entry and walks to package metadata instead.

[OpenRouter generation metadata](https://openrouter.ai/docs/api/api-reference/generations/get-request-%26-usage-metadata-for-a-generation) provides reported generation cost. [Pi OpenRouter-compatible usage parsing](https://raw.githubusercontent.com/earendil-works/pi/v0.85.1/packages/ai/src/api/openai-completions.ts) computes normalized SDK estimates, so the implementation keeps estimates distinct from generation charges and does not add reasoning tokens a second time.

## Practical conclusions for this skill

Use one focused contribution by default; add independent models for important uncertainty. Scope permission and data explicitly. Preserve exact identity and real cost provenance. Require the host to verify evidence and assess incremental value. Stop unproductive phases instead of spawning agents until they agree. Those are this project's design recommendations, not measured performance claims about the preferred models.


## September 14 follow-up: host interoperability

The [Claude Code skills documentation](https://code.claude.com/docs/en/skills) identifies personal `.claude/skills/<name>` and project skill directories, `/name` invocation, and optional execution/permission extensions. `context: fork` starts a child context; `allowed-tools` grants tools during invocation. Neither belongs in this skill: the primary host must remain the orchestrator and the existing approval policy must remain intact. A standalone skill preserves the short `/pi` name; a Claude plugin adds a namespace. Local personal skills are not automatically provisioned to Cowork/cloud sessions.

The [Codex skill documentation](https://developers.openai.com/codex/skills) identifies personal `.agents/skills` and repository discovery. Its host-specific metadata stays in `agents/openai.yaml`; the main `SKILL.md` is portable. The [Claude configuration reference](https://code.claude.com/docs/en/settings) documents `CLAUDE_CONFIG_DIR`; the installer respects it for personal Claude installations, not repository paths.

The [Claude memory guide](https://code.claude.com/docs/en/memory) explicitly distinguishes `CLAUDE.md` from `AGENTS.md` and gives `@AGENTS.md` as the shared-instruction bridge. This version uses that explicit import rather than duplicating two learned summaries. It preserves human content and never creates the bridge as an implicit install side effect. The [Codex instruction guide](https://developers.openai.com/codex/guides/agents-md) explains overrides, hierarchy and the default combined 32-KiB instruction budget; an updater for root AGENTS cannot supersede those semantics.

## mcollina/pi-self-learning

[Project README](https://raw.githubusercontent.com/mcollina/pi-self-learning/main/README.md).

This extension describes task reflections, daily/monthly records, a compact durable core, and frequency/recency scoring. It also supports a reflection model and commits to a dedicated memory repository. The useful structural idea is separating detailed history from small reusable guidance rather than injecting the entire history into every task.

**Adopted:** local observations, a bounded distilled summary and explicit freshness. **Deliberately different:** the current host validates outcomes; workers neither grade themselves nor write lessons; aggregation is deterministic and does not call an extra model; evidence/revisions remain local; there is no automatic Git commit, cross-project learning transfer or permissions workaround. The original extension is not installed or bundled.

## Delegation permission inheritance

The [tintinweb nested-subagent documentation](https://github.com/tintinweb/pi-subagents#nested-subagents) explicitly warns that a child uses its own tools/extensions and does not inherit the parent's restrictions. A nominally read-only parent can gain write/command capabilities through an authorized child. This supports retaining this skill's **no-recursion** boundary rather than assuming read-only intent propagates through arbitrary agent trees. It is a design reason, not a finding of an unpatched vulnerability in that project.

The same project exposes durable memory scopes and requested-versus-effective model/effort behavior. Here, those identities form separate learning profiles, including companion worker configuration. A model's incremental value in one ensemble is not assumed to transfer to another.

## Context-file research: useful caution, not proof of improvement

[Evaluating AGENTS.md: Are Repository-Level Context Files Helpful for Coding Agents?](https://arxiv.org/abs/2602.11988), Gloaguen and colleagues, submitted February 12, 2026; version 2 dated June 23, 2026. The current abstract reports that context files did not generally improve success across its evaluated settings and increased average inference cost by over 20%. It distinguishes useful nonstandard practices from unhelpful repository overviews and calls for evaluating performance claims.

[Do Context Files Help Coding Agents? A Two-Agent Ablation Study on Real Repositories](https://arxiv.org/abs/2607.27250), Khatri, submitted July 28, 2026. The abstract describes 17 tasks, three repositories and 288 evaluated runs using Claude Code and Codex. It reports no measurable correctness change from its context strategies and notes agent-specific task difficulty. Its bounded setting should not be generalized into a universal claim about all instructions or all model-routing memory.

These are research reports/preprints, not validation of **this** implementation or the user's model pool. The abstract-level findings motivate short, task-specific guidance, visible evidence counts, separate host profiles and easy withdrawal of disproven lessons. They do not prove that the chosen three-task/75%/90-day heuristics are optimal or statistically sufficient. This release includes no genuine performance history and claims no measured improvement.

## What not to add without separate evaluation

Do not attach a self-improvement hook to every turn, let workers rewrite policy, treat repeated attempts as independent wins, call more models merely to populate a leaderboard, or optimize only reported worker cost while ignoring host rework and later regressions. Prefer occasional justified alternative-model trials on real tasks, within existing authorization. Keep final selection with the host and make individual decisions auditable.

## 1.4.0 reliability follow-up — checked September 15, 2026

This pass focused on early stopping rather than broader agent autonomy. It compared documented behavior, not benchmark results. The exact local findings/fixes and remaining limitations are in [the reliability audit](reliability-audit.md).

| Primary source | Relevant behavior and scope | Decision for this project |
| --- | --- | --- |
| [Pi Agent loop 0.85.1](https://raw.githubusercontent.com/earendil-works/pi/v0.85.1/packages/agent/src/agent-loop.ts) and [lifecycle](https://raw.githubusercontent.com/earendil-works/pi/v0.85.1/packages/agent/src/agent.ts) | Natural stop, follow-up handling, cooperative abort and rejected truncated tool calls | Bounded same-session repair; submission-only after length; no replayed mutation |
| [nicobailon tool reference](https://raw.githubusercontent.com/nicobailon/pi-subagents/main/docs/tool-reference.md) | Thirty-minute default only for specified run modes; async single-agent pre-deadline checkpoints; soft/hard budgets; retained resume and writer-specific cautions | Reserve finalization within existing limits, narrow writer tasks, distinguish configured deadline from safe completion |
| [nicobailon observability](https://raw.githubusercontent.com/nicobailon/pi-subagents/main/docs/observability.md) | Explicit lifecycle artifacts and inspectable progress | Candidate/metadata checkpoints and a dependency-free diagnostic command, not terminal scraping |
| [tintinweb graceful limits](https://raw.githubusercontent.com/tintinweb/pi-subagents/master/README.md) | Wrap-up steering and five grace turns; notification grouping timeout is not worker termination | Separate finalization from hard stop, but reserve rather than silently add turns |
| [Claude SDK subagents](https://code.claude.com/docs/en/agent-sdk/subagents) | Resumable custom/general-purpose workers and partial max-turn results; marking requires 2.1.246+ | Honest partial/blocked schema; clearly disclose that this project has no persistent transcript resume |
| [Claude environment variables](https://code.claude.com/docs/en/env-vars) | Separate Bash, API and subagent-stall timers | Check the enclosing host-command lifetime; do not assume Claude's API timeout configures Pi |
| [Codex unified-exec interface](https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/tools/handlers/unified_exec.rs) and [command handling](https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs) | Separate yield/wait and process timeout controls | Keep actual live task handles; no duplicate run after a mere yield; installed tool contract takes precedence |
| [OpenRouter reasoning/output accounting](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens) | Reasoning competes with visible output on most providers; a length stop can consume paid output without a visible answer | Preserve effort policy, disclose output/admission numbers, prefer small edits and deliberate allocations |

Resource failures are now recorded separately from quality outcomes, and routing profiles include runtime allowances. This is a correction for confounding in local observational history, not a claim to remove selection bias or establish causality.
