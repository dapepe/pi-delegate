## pi

The current primary host (Codex or Claude Code) is the sole orchestrator and integration decision maker. It may delegate bounded work to Pi when the expected value justifies the cost and the user/workspace policy permits the required external data transfer. Read-only is the default. Candidate-write permission requires an explicit file list; the main checkout is never writable by a Pi worker. The host decides which findings/edits to accept, validates them, and reports usefulness and cost.

Use the following preferences when compiling the `pi` run plan. The JSON is a policy override for this skill, not native Pi or native host configuration. The host must copy the resolved settings into the plan's `policy`; the helper does not parse this Markdown.

```json
{
  "preferred_provider": "openrouter",
  "preferred_models": [
    "x-ai/grok-latest",
    "google/gemini-3.8-flash",
    "deepseek/deepseek-v4.1-flash",
    "deepseek/deepseek-v4-pro",
    "meta/muse-spark-1.3"
  ],
  "model_aliases": {
    "x-ai/grok-latest": "~x-ai/grok-latest"
  },
  "default_effort": "xhigh",
  "complex_effort": "max",
  "effort_policy": "best_supported",
  "max_agents": 3,
  "max_parallel": 2,
  "max_turns": 12,
  "max_tool_calls": 60,
  "timeout_seconds": 600,
  "request_timeout_seconds": 600,
  "finalization_turns": 2,
  "finalization_seconds": 120,
  "max_completion_repairs": 1,
  "per_agent_budget_usd": 2,
  "session_budget_usd": 5,
  "openrouter_routing": {
    "require_parameters": true,
    "data_collection": "deny",
    "allow_fallbacks": false
  }
}
```

`preferred_provider` is Pi's API provider/gateway. OpenRouter's upstream hosting provider is a different setting: use `openrouter_routing.order` for an ordered preference or `only` for an exclusive allowlist. Do not invent provider slugs. `zdr: true` may be added when required; do not assume `data_collection: deny` alone guarantees zero retention or regional residency.

Request xhigh for nontrivial tasks and max for especially complex/high-consequence tasks. Use the live model catalog to resolve capabilities; disclose all effort mappings and aliases. Do not silently change models to obtain a requested setting. Choose models case by case, normally one or two, rather than always running the entire list.

`max_turns` counts provider requests, including tool iterations and completion repairs. Finalization reserves part of the existing allowance rather than adding quota. Match the enclosing host-command lifetime to the authorized work; inspect `diagnose` output and partial checkpoints rather than restarting blindly. A larger task allocation needs explicit policy authorization; a per-worker `limits` object may only reduce a plan ceiling.

Independent reviewers must not see each other's conclusions before their first pass. Resolve differences through evidence/tests. Report accepted, rejected and deferred recommendations; distinguish provider-reported charges, estimates and unknown cost. The host should supply a brief usefulness rating with its reason after validation.

### Project-learning policy

When the user explicitly initializes `.pi/learning`, the current host may record its independently validated assessments, including failures, cost and rework, as described by the skill. Treat recent scope/host/model/strategy-matched observations as tentative routing evidence, not a global ranking or permission grant. Never let a worker grade itself, edit instructions, raise budgets or skip validation.

The local learning mode determines promotion: `propose` needs user approval; explicit `auto` permits eligible updates after host review. Only the managed learned block in root `AGENTS.md` may be updated by the helper. Preserve all human policy and nested instructions. Do not copy these prose settings into the inference plan's `policy`: learning uses a separate, locally initialized config.

Do not send model-performance history to independent workers. Reuse a stable task identifier across retries; separate host/model versions, effort, task scope, strategy, runtime allocation and team configurations. Record an established limit failure as operational, not as evidence of incorrect model reasoning. Keep private telemetry out of Git and publish only brief, evidence-backed preferences. Record late regressions and withdraw invalid guidance; learning never justifies extra paid experiments.

For Claude Code, append a standalone `@AGENTS.md` to the project's existing `CLAUDE.md` after checking imports, or use the explicit `learn init --claude-import` setup. Do not replace existing project instructions or create a circular import.
