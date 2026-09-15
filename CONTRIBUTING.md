# Contributing

Use Node.js **22.19.0 or newer** and work from the repository root.

```sh
npm install --ignore-scripts
npm run check:sdk
npm test
npm run test:sdk
npm run package
```

`npm test` uses dependency-free fixtures. `npm run test:sdk` requires the pinned
SDK but mocks its transport; it must not make paid inference calls. Treat an SDK
contract failure as an integration issue to investigate, not a reason to weaken
the assertion. Add a regression test for policy, permission, ledger, or reporting
changes. Keep tests portable across Linux, macOS, and Windows; mark genuinely
platform-specific assertions explicitly.

Only run the optional paid smoke check after deliberate approval:

```sh
npm run smoke -- --allow-paid
```

Never introduce automatic smoke inference in install hooks, CI, or pull-request
workflows. Do not commit API keys, real run artifacts, private source, or full
reasoning traces. Use synthetic fixtures and redacted diagnostics.

Preserve the design invariants: the current primary host makes all integration decisions; workers
have bounded file tools; candidate writes never affect the real checkout;
model/provider substitutions require explicit policy; unknown costs stay unknown;
The host supplies usefulness assessments after validation. Any relaxation of those
boundaries requires an explicit design discussion and threat-model update.

Keep the skill name `pi` and keep SKILL.md focused on instructions. Put deeper
material in docs/ or references/. Update the configuration example, documentation,
changelog, and tests together when changing the plan schema or defaults.

A genuine package-lock.json is intentionally absent from the initial offline
source bundle. Generate it with npm on a trusted connected machine, inspect and
commit it before releasing a dependency-locked build. Do not handcraft integrity
hashes. Use `npm ci --ignore-scripts` once the lockfile is committed.

Publishing and release checks are described in [docs/releasing.md](docs/releasing.md).
Contributions are distributed under the [MIT license](LICENSE).

## Multi-host and learning changes

Test both `codex` and `claude-code` metadata and install targets. Preserve the primary host as decision maker; do not add recursive delegation, broad skill tool grants, hooks or auto commits. Learning changes require tests for opt-in, host attestations, distinct-task counting, changed models/teams, late costs/regressions, deterministic bounded text, stale proposals and human instruction preservation. Use synthetic evidence only and keep private history out of fixtures.
