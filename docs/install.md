# Install pi in Codex and Claude Code

The root of this repository is one portable skill named **pi**. This is not a
Claude plugin and does not replace the native Codex or Claude Code agent.

## Prerequisites

Use Node.js **22.19.0 or newer** and npm in the same execution environment as the
host. The SDK remains pinned to **Pi 0.85.1**; no separate global Pi CLI is needed.
An approved OpenRouter API key and external-data authorization are required for
inference. Local setup and offline tests do not make inference requests.

## Choose the host

Extract the ZIP or clone this repository, then run from its root:

```sh
node scripts/install.mjs --host both
```

| Option | Personal destination | Project destination with `--repo /project` |
| --- | --- | --- |
| `--host codex` (default) | `~/.agents/skills/pi` | `/project/.agents/skills/pi` |
| `--host claude-code` (`claude` also accepted) | `~/.claude/skills/pi` | `/project/.claude/skills/pi` |
| `--host both` | Both personal folders | Both project folders |

For example:

```sh
node scripts/install.mjs --host claude-code --repo /absolute/path/to/project
```

An explicitly set `CLAUDE_CONFIG_DIR` changes the personal Claude destination to
`$CLAUDE_CONFIG_DIR/skills/pi`. It does not redirect a repository installation.
Use the paths printed by the installer, rather than assuming the default.

Existing destinations are never overwritten. Move an old copy **outside every
host skill-discovery directory** before replacing it. There is no force flag.
Both-host installation preflights both destinations before copying. On a normal
copy failure, newly created destinations are removed; preexisting data is not.
A process crash can leave an incomplete new copy: inspect and move it before
retrying. Install operations do not run npm, read credentials, modify host
permissions, or edit the task project's AGENTS.md/CLAUDE.md.

## Install dependencies in each destination

Both-host mode creates independent copies. In **each** printed destination run:

```sh
npm install --ignore-scripts
npm run check:sdk
npm test
npm run test:sdk
```

Use `npm ci --ignore-scripts` instead when a reviewed lockfile exists. On Windows
PowerShell, `npm.cmd` avoids PowerShell execution-policy ambiguity. For a default
personal Claude installation:

```powershell
Set-Location (Join-Path $HOME '.claude/skills/pi')
npm.cmd install --ignore-scripts
npm.cmd run check:sdk
npm.cmd test
npm.cmd run test:sdk
```

Install Windows tools from Windows and WSL tools from WSL; their home directories,
Node installations, skill discovery and credentials are separate. Do not assume
a skill installed in WSL automatically appears in a native Desktop host.

## Credentials

From either installed copy, run these yourself in a terminal:

```sh
node scripts/pi.mjs auth
node scripts/pi.mjs doctor
```

`auth` accepts hidden input. It stores a **plaintext, not encrypted** key in
`~/.config/pi/credentials.json`, outside the skill and task project. Both copies
share this file when running under the same OS user and environment. POSIX uses
owner-only permissions; Windows setup requests a protected current-user directory
ACL. Prefer a restricted OpenRouter key. Never paste a key into an AI chat.
`OPENROUTER_API_KEY` in the actual execution environment takes precedence over the
file. A terminal export does not necessarily reach an app launched elsewhere.
See [security](security.md) for platform limits; the script never loads `.env`.

## Invoke

Codex: choose **pi** in its Skills picker; CLI/IDE surfaces accept `$pi`. Restart
Codex if a newly installed skill does not appear.

Claude Code: start a local session in the task project and enter:

```text
/pi Investigate this bug with two independent preferred models. Keep the
reviewer read-only. Validate and integrate only useful changes, report costs,
and maintain project learning only within the configured learning mode.
```

Do not install as a namespaced Claude plugin unless a namespaced command is
actually desired. Direct skill installation retains `/pi`. This project does
not set `context: fork`, a host-model override, `allowed-tools`, permission
bypasses, or hooks. Both hosts may discover the skill from its description;
external spending and source disclosure still require applicable authorization.
For manual-only invocation, Claude supports `disable-model-invocation: true`
in skill frontmatter, while Codex supports `allow_implicit_invocation: false`
in `agents/openai.yaml`. Change the appropriate host setting deliberately.

Local Claude personal skills do not by themselves install into Cowork or remote
cloud sessions. Remote environments need their own dependencies, credentials and
approved network access. This release specifically targets local Codex and
Claude Code skill execution, not a tested cloud integration.

## Shared project instructions and optional learning

Do not copy this repository's contributor AGENTS.md over your project's file.
Append relevant settings from `templates/AGENTS.example.md` instead.

Claude Code loads CLAUDE.md rather than AGENTS.md. A standalone import bridges
the shared project instructions without maintaining two copies:

```markdown
@AGENTS.md
```

To create the bridge and opt into local learning explicitly, use an installed
runner's absolute path:

```sh
node /absolute/path/to/pi/scripts/pi.mjs learn init --repo /project --mode propose --claude-import
```

This preserves existing Markdown and appends the import only if a standalone
active import is not already present. It creates an empty titled AGENTS.md when
needed for that explicit bridge, but does not add model settings or successful
learning claims. Root AGENTS.override.md and nested instruction precedence still
apply. The helper does not edit override files or resolve import cycles: inspect
existing imports and use `/context` in Claude to check what actually loaded.

Use `--mode auto` instead of `propose` to authorize host-reviewed updates without
asking on every later session. Auto is not a background process or worker write
authority. Read [learning](learning.md) before enabling it.

## Primary references (checked September 14, 2026)

[Codex skill locations and invocation](https://developers.openai.com/codex/skills),
[Claude skill locations and command naming](https://code.claude.com/docs/en/skills),
[Claude shared AGENTS.md import](https://code.claude.com/docs/en/memory#agentsmd),
[Claude environment configuration](https://code.claude.com/docs/en/env-vars),
[Pi SDK runtime requirement](https://raw.githubusercontent.com/earendil-works/pi/v0.85.1/packages/agent/package.json).
