# Guided setup and reusable preferences

Ask the current Codex or Claude Code host: **“Set up Pi with my preferred providers and models.”** The host should inspect existing preferences with `setup show`, ask a few focused questions, prepare a plain policy JSON file, and show the exact proposed settings before saving. A conversational setup is the default; the same steps below work from a terminal. There is no extra wizard dependency.

Start with these choices:

1. Provider and exact preferred model IDs. For a local or infrastructure endpoint, also ask for its exact base URL, model IDs, supported function tools, context/output limits, reasoning settings and estimate rates. Use the [compatible-provider guide](openai-compatible.md); declarations are not live validation.
2. Effort policy: preserve `xhigh`/`max` requests with transparent supported-effort mapping, or require exact support. A specifically approved non-reasoning compatible model also requires `effort: off` on each task worker; it cannot become a silent global downgrade.
3. Per-worker and total budgets, maximum agents/parallelism, requests, tools, time, output and context. Explain that a request limit can bind before a tool limit. Keep defaults unless a deliberate change is wanted.
4. Data boundaries: which endpoints may receive task snapshots, any OpenRouter retention/routing restrictions, and whether private infrastructure permits explicit HTTP. Choosing a provider does not authorize arbitrary project files or disclosure of source.
5. Preference location: the private user profile is convenient across projects; an explicitly named private project-local profile or multiple named profiles also work. Project/user instructions govern each task and must be reflected in the materialized plan overrides.

Do not ask the user to paste keys into chat or policy JSON. Compatible authentication uses an exact environment-variable **name** or explicit unauthenticated mode. Setup does not read environment credentials, credential files, or endpoint status, and it does not install servers, dependencies, model weights, or change system settings.

## Inspect and validate

```sh
node scripts/pi.mjs setup show
node scripts/pi.mjs setup check --config /private/path/pi-policy-draft.json
```

The default saved profile is `~/.config/pi/policy.json`. If it is absent, `show` reports `configured: false`, discloses the bundled fallback defaults, and creates nothing. An explicit profile can be inspected with `setup show --config FILE`. The output includes the file's SHA-256 for conflict-aware replacement.

Profiles are plain policy JSON, compatible with the existing `models --config` format. They can contain only explicit overrides:

```json
{
  "preferred_provider": "openai",
  "preferred_models": ["replace-with-an-exact-model-id"],
  "default_effort": "xhigh",
  "complex_effort": "max",
  "effort_policy": "best_supported",
  "max_agents": 3,
  "max_parallel": 2,
  "per_agent_budget_usd": 2,
  "session_budget_usd": 5
}
```

This is an illustrative configuration, not a verified model recommendation. Changing the preferred provider requires an explicit model list so OpenRouter defaults cannot silently carry over. Every preferred compatible model must have an exact declaration in that route's registry. `check` validates the policy schema only and never claims the model exists or the server is reachable. Separate `models --config FILE` uses the existing metadata path; OpenRouter catalog access involves a network request and must follow the host's normal permissions. Neither command runs inference.

The summary separates global preferences from each compatible model's declared limits and efforts. A global output ceiling of 32,768 tokens with a model declaration of 4,096 permits at most 4,096 for that model. An off-only model still requires the task worker's explicit `effort: off` even when the global default remains `xhigh`. The normal task-plan check reports the resolved worker settings.

## Save an approved profile

```sh
node scripts/pi.mjs setup save --config /private/path/pi-policy-draft.json
node scripts/pi.mjs setup save --config /private/path/pi-policy-draft.json --out /private/path/my-pi/policy.json
```

Saving is an explicit action, not a side effect of inspection, checking or running. New directories use mode `0700`; files use `0600`. Existing reusable-profile parent directories must already be owner-only on POSIX systems. Setup refuses to change permissions on a shared directory. Windows users must verify the selected directory's private ACLs; requesting a POSIX file mode does not establish Windows ACL privacy.

An existing profile is never overwritten just because the path matches. Inspect it, review the proposed change, then use its exact current hash:

```sh
node scripts/pi.mjs setup save --config /private/path/pi-policy-draft.json --replace-sha REPLACE_WITH_CURRENT_SHA256
```

Use `--out` as well when replacing a named profile. A changed file hash, symlink or hardlink fails closed. Only JSON profile/plan artifacts are accepted; setup refuses credential files and reserved package, instruction, and runtime-state destinations. It never edits `AGENTS.md`, host configuration, shell startup files or credentials. Unknown schema fields and common API-key-like strings are rejected without echoing those strings. This check cannot detect every possible secret; keep all credential values out of profiles.

An exclusive `<output>.setup.lock` serializes setup writers around the hash check and save. An abruptly interrupted write may leave this private lock behind; inspect the recorded process and output before manually removing a confirmed stale lock. Setup never assumes a lock is stale or retries a competing write automatically. This coordinates setup commands; it cannot prevent another editor from changing a file outside the protocol.

## Materialize a task plan

```sh
node scripts/pi.mjs setup plan \
  --config /private/path/my-pi/policy.json \
  --plan /private/path/draft-plan.json \
  --out /private/path/approved-plan.json
```

The host prepares the draft task plan with exact readable/writable files, worker assignments, model IDs and applicable user/project constraints. Compilation applies bundled defaults, then saved preferences, then explicit draft-plan policy overrides. It writes a new plan outside the task repository, appends the profile path to `policy_sources`, and reports which override keys took precedence. Existing output files are refused; the input plan remains unchanged.

Review the generated plan and the override summary before the normal plan check and [host-native supervision](supervision.md). The compiler validates task-plan structure but does not capture source snapshots or run workers. Preferences never grant a broader model, file, privacy, effort, or budget permission than the user approved for the task.

Raw `run` continues to use the plan's explicit policy. It does not silently load a user profile. This makes each submitted plan reviewable and avoids an unnoticed profile edit changing an already prepared delegation.

For automation or another host, `node scripts/setup.mjs` provides the same `show`, `check`, `save` and `plan` commands. Every save and compilation remains explicit.
