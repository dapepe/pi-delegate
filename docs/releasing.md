# Publish and maintain pi on GitHub

## Source layout

Publish the contents of the extracted `pi` directory as the repository root. That root contains `SKILL.md`, `README.md`, `package.json`, `scripts/`, and the other project files. Do not publish only the ZIP or add an extra nested `pi/pi` level. The package is marked `private: true` to prevent accidental npm publication under the unrelated short npm name; it does not prevent a public GitHub repository.

## Resolve and validate dependencies

The following sentence records an earlier package-preparation environment; it is historical, not validation of the 1.5.0 release. This repository now tracks its reviewed `package-lock.json`; release validation still needs to be run on a trusted networked machine with Node 22.19.0 or newer.

On a trusted networked machine with the required Node version:

```sh
npm ci --ignore-scripts
npm run check:sdk
npm test
npm run test:sdk
npm audit
```

Inspect the resolved dependency graph and audit output rather than running automatic breaking upgrades. Commit the **genuinely generated `package-lock.json`**. Direct dependency pins alone do not freeze the full graph. Later clean installs should use `npm ci --ignore-scripts`. When changing Pi versions, update the version checks/overrides and validate the adapter contract explicitly; do not hide failures by weakening assertions.

The installed-SDK tests use synthetic HTTP responses. For endpoint confidence, separately perform an approved smoke test using a restricted key and the public fixture:

```sh
node scripts/smoke.mjs --allow-paid
```

This is paid inference with soft $0.25 guards, not a guaranteed maximum charge. It does not access a real project. Record real results and actual/unknown billing separately; do not label a mock-transport result as a live test. Do not publish keys or private run artifacts.

## Create the repository

After reviewing the source and generated lockfile:

```sh
git init -b main
git add .
git diff --cached --stat
git diff --cached
git commit -m "Add pi multi-host delegation skill"
```

For a new checkout, create the GitHub repository, then use its actual remote, for example:

```sh
git remote add origin git@github.com:YOUR-ACCOUNT/pi.git
git push -u origin main
```

`YOUR-ACCOUNT` is deliberately a placeholder. These are manual host operations; record the actual repository, remote, push and publication results for the release instead of inferring them from this document.

## CI and release ZIP

`.github/workflows/ci.yml` runs offline tests and installed-SDK mock-transport checks on Linux, macOS, and Windows. A Node 22.19.0 job checks the declared minimum; other jobs use Node 24. Workflows request read-only repository permission, do not persist checkout credentials, and receive no model API keys. The workflow was authored but not run during package preparation.

Because this repository tracks `package-lock.json`, CI uses `npm ci --ignore-scripts`. If a future branch lacks a lock, resolve and review it before release rather than presenting a newly resolved graph as reproducible. The Actions major versions were checked against their official repositories on September 14, 2026. For stricter supply-chain policy, replace version tags with verified full commit SHAs and maintain them through review.

Build the shareable source archive locally:

```sh
npm run package
```

This creates `dist/pi.zip` and `dist/SHA256SUMS`. Given identical input bytes, the packager produces deterministic entries with fixed timestamps and sorted paths. It includes a genuine lockfile when one exists, but never bundles `node_modules` or runtime credentials. Check the contents and checksum, update the changelog, then attach these two files to a GitHub release. There is no auto-publish workflow with write credentials.

After a reviewed release commit:

```sh
git tag v1.6.0
git push origin v1.6.0
```

Choose a new tag rather than replacing an already published one. GitHub's automatic source download and the curated `pi.zip` are separate artifacts; the latter always has the installation root `pi/`.

## Installation from a published repository

Users can clone your actual repository into a normal source directory and run `node scripts/install.mjs --host both`, or clone directly into an empty `~/.agents/skills/pi` or `~/.claude/skills/pi` directory. They must still install dependencies and supply their own approved credentials. Never include a shared key.

The built-in Codex skill installer can also be asked to install from an actual repository URL, but it does not substitute for this project's dependency and credential checks. Standalone local skill distribution is the target here. A directory-listed OpenAI plugin would require separate plugin packaging and review; no such listing is claimed.

## Final release checklist

Review secrets and license notices, commit the resolved lock, pass offline and installed-SDK tests, document any live smoke result honestly, inspect defaults/permissions/budgets, verify the generated ZIP, and keep actual run folders outside the repository. Update `references/validation.md` with real evidence rather than preserving a stale passing badge.

## Multi-host and learning release checks

Keep the standalone skill named `pi`; a Claude plugin would add a namespace and is not needed here. Check fresh Codex-only, Claude-only and both-host installations, including custom `CLAUDE_CONFIG_DIR`. Never overwrite local customizations during an update. Test the actual host-specific run/assessment metadata and both invocation surfaces before claiming host compatibility.

Use synthetic temporary projects for learning tests. Do not publish `.pi/learning`, real assessments, API keys or private model-performance history. Verify the shared Markdown bridge preserves human content, promotion cannot lower safety policy, and duplicate retries/late regressions do not create fake routing wins. For 1.5.0 also verify the optional plan evaluation contract, schema-1 compatibility, schema-2 quality/usefulness separation, exact criterion/artifact checks, inventory recording, finalization receipt/status, all-attempt spending, task-balanced grades, and the same JSON/Markdown/TUI aggregation. The release notes' validation section must remain marked as awaiting host-verified results until the primary host records actual checks; do not turn fixture or static review into a live host claim.
