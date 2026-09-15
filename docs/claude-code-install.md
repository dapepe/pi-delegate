# Claude Code installation

Use the [complete cross-host installation guide](install.md).

From the extracted repository root:

```sh
node scripts/install.mjs --host claude-code
cd "$HOME/.claude/skills/pi"
npm install --ignore-scripts
npm run check:sdk
npm test
npm run test:sdk
node scripts/pi.mjs auth
node scripts/pi.mjs doctor
```

Use the installer's printed path when `CLAUDE_CONFIG_DIR` is set. Run `auth`
yourself, not through Claude. It is unnecessary when `OPENROUTER_API_KEY` is
already available to the execution environment.

Start Claude Code inside your task project, then invoke `/pi` with the task.
Restart the host if a newly created top-level skills directory is not detected.
The primary Claude conversation remains the orchestrator; Pi workers do not
inherit Claude's native tools, its entire transcript, or its writable memory.
They use the same bounded runner as the Codex installation.

Plans identify `"orchestrator": "claude-code"`; assessments identify
`"assessed_by": "Claude Code"`. Cost reports exclude Claude Code orchestration
cost, which this runner does not observe. Host-model and host-version metadata
are optional; unknown means unknown, not an inferred model name.

To share project settings and learning with Codex, use a root CLAUDE.md import
of AGENTS.md. The explicit `learn init --claude-import` helper is described in
[installation](install.md) and [project learning](learning.md). Do not use two
independent, automatically edited copies of the learned preferences.

The skill works through normal host tools; it does not bypass permission prompts,
install a proxy, redirect Claude's own model calls, or expose the OpenRouter key
to workers. `/pi` is a direct local skill, not `/plugin-name:pi`.

This release has offline host-path, prompt, report and learning tests. Actual
Claude Code UI discovery and paid execution still need a local smoke test.

Sources: [Claude Code skills](https://code.claude.com/docs/en/skills),
[Claude memory and AGENTS.md bridge](https://code.claude.com/docs/en/memory).
