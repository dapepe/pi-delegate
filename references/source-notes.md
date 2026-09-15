# Source and version notes

Checked September 14, 2026. Live model catalogs and desktop UI behavior can change; pinned code references below describe the targeted SDK, not an unspecified latest release.

| Topic | Primary source |
| --- | --- |
| Local skill discovery, metadata, invocation | https://learn.chatgpt.com/docs/build-skills |
| Pi SDK package / minimum runtime | https://raw.githubusercontent.com/earendil-works/pi/v0.85.1/packages/agent/package.json |
| Pi Agent APIs | https://raw.githubusercontent.com/earendil-works/pi/v0.85.1/packages/agent/README.md |
| Awaited events and synthetic failures | https://raw.githubusercontent.com/earendil-works/pi/v0.85.1/packages/agent/src/agent.ts |
| Tool execution and stopping | https://raw.githubusercontent.com/earendil-works/pi/v0.85.1/packages/agent/src/agent-loop.ts |
| Pi AI package exports | https://raw.githubusercontent.com/earendil-works/pi/v0.85.1/packages/ai/package.json |
| OpenRouter adapter | https://raw.githubusercontent.com/earendil-works/pi/v0.85.1/packages/ai/src/providers/openrouter.ts |
| Reasoning payload and normalized usage | https://raw.githubusercontent.com/earendil-works/pi/v0.85.1/packages/ai/src/api/openai-completions.ts |
| Plain JSON Schema tool validation | https://raw.githubusercontent.com/earendil-works/pi/v0.85.1/packages/ai/src/utils/validation.ts |
| Current OpenRouter model metadata | https://openrouter.ai/api/v1/models |
| Generation charges | https://openrouter.ai/docs/api/api-reference/generations/get-request-%26-usage-metadata-for-a-generation |
| Usage accounting | https://openrouter.ai/docs/cookbook/administration/usage-accounting |
| Actions checkout | https://github.com/actions/checkout |
| Actions setup-node | https://github.com/actions/setup-node |
| Actions upload-artifact | https://github.com/actions/upload-artifact |

The preferred model pool is user configuration, not a recommendation that every model will remain available or meet every task's requirements. Model identity and effort are checked before each run; no archived price table is used to report actual charges.

For community delegation patterns and explicit differences, see [research](research.md). For executed versus unexecuted checks, see [validation](validation.md).


## Multi-host and learning follow-up

Rechecked September 14, 2026:

| Topic | Primary source |
| --- | --- |
| Claude Code skills, invocation, fork/tool-grant behavior | https://code.claude.com/docs/en/skills |
| Claude instruction imports and AGENTS bridge | https://code.claude.com/docs/en/memory |
| Claude configuration relocation | https://code.claude.com/docs/en/settings |
| Codex instruction hierarchy and context limit | https://developers.openai.com/codex/guides/agents-md |
| Pi self-learning history/core pattern | https://raw.githubusercontent.com/mcollina/pi-self-learning/main/README.md |
| Nested delegation and child privilege behavior | https://github.com/tintinweb/pi-subagents#nested-subagents |
| Context-file evaluation (current v2) | https://arxiv.org/abs/2602.11988 |
| Two-host context-file ablation | https://arxiv.org/abs/2607.27250 |

The research papers were reviewed through their abstract/version pages. Their findings are scoped to their evaluated agents/tasks; no full-paper replication or live model benchmark was performed. The sources informed design choices, not a claim of proven learning gains.
