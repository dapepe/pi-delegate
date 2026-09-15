# Contributor instructions for pi

These instructions govern maintaining this repository, not the user's task
project. Project examples are under templates/. Keep the skill name `pi`.

The current primary host (Codex or Claude Code) remains sole orchestrator,
permission grantor, validator, integration decision maker and learning reviewer.
Preserve isolated candidate writes, exact file/model allowlists, truthful costs,
and no shell, automatic code integration, recursive delegation or silent fallback.
Workers must not access instruction files, credentials, or learning state.

Project learning is local opt-in. Preserve human instructions outside the managed
AGENTS.md block; never turn evidence into wider permissions, budgets or privacy
grants. Record failures and uncertain outcomes, do not manufacture evidence, and
keep observed success distinct from causal model rankings. Changes to the state
schema, model-version grouping or promotion rules need tests and migration notes.
Do not commit project memory, prompts, real source, credentials or reasoning traces.

Use Node >=22.19.0 for SDK execution. Run `npm test` after changes. When dependencies
are installed, run `npm run check:sdk` and `npm run test:sdk`; these use no paid
inference. Never run an explicitly paid smoke test without the user's approval.
Use synthetic fixtures and label them as such. Do not fabricate lockfiles, passing
CI, live results, model capabilities, costs or host UI validation.

Before release, inspect the allowlist and run `npm run package`. The installer
must not overwrite installations or edit a task project's instructions. Only the
explicit learning setup/application commands may change their documented project
files. They must retain conflict detection and host review. Preserve normal host
approvals and sandbox protections in all installation and execution instructions.
