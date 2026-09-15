# Codex Desktop installation

Use the [complete installation guide](install.md) for requirements, credentials,
Windows/WSL details, updates and both-host installation.

From the extracted `pi` folder:

```sh
node scripts/install.mjs --host codex
cd "$HOME/.agents/skills/pi"
npm install --ignore-scripts
npm run check:sdk
npm test
npm run test:sdk
node scripts/pi.mjs auth
node scripts/pi.mjs doctor
```

Run credential setup yourself in a terminal, not through Codex. Select **pi**
in the Desktop Skills picker; restart the app if the newly installed skill does
not appear. Codex CLI/IDE surfaces support `$pi`. Picker details can differ by
surface; selecting the actual listed skill is preferable to guessing a mention
syntax. The name remains `pi` in every host.

For repository scope, use `--repo /absolute/project` with the installer. For
Codex and Claude Code together, use `--host both` and install dependencies in
each printed destination. The installer never overwrites an old installation
or edits the task project's instructions. Move the previous skill copy outside
all skill-discovery directories before an upgrade.

Plans default to `orchestrator: codex` for backward compatibility. New Codex
plans should set it explicitly. Codex remains the sole reviewer and integrator
in its session; Claude Code is not started as a second orchestrator.

Project learning can be shared through AGENTS.md. Codex's ordinary instruction
precedence still applies: root AGENTS.override.md can replace AGENTS.md and
nested instructions can supersede it. The learning updater does not rewrite
those files or raise the combined context budget. See [learning](learning.md).

Sources: [Codex skills](https://developers.openai.com/codex/skills),
[AGENTS.md precedence](https://developers.openai.com/codex/guides/agents-md).
