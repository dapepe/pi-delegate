# Security and privacy boundary

## What this implementation restricts

The model receives only explicitly supplied tools. Those tools operate on allowlisted text maps, not arbitrary host paths. Read-only workers have no write capability; authorized write workers modify only a private candidate overlay. There is no model-exposed shell, process execution, general network tool, extension loader, delegation tool, commit/merge/push operation, or integration command.

Snapshots reject sensitive path patterns, symlinks, traversal, binaries, unbounded text, reserved Windows names, and case/Unicode collisions. Existing write paths must also be readable. Source hashes and modes support a staleness check. The source-reading code limits the bytes read even when another process grows the file.

The runner exports candidates outside the source repository, refuses an existing run output directory, and does not execute candidate text. Models cannot mutate another worker's candidate map. Submissions terminate tool use; findings must reference available files and in-range lines. This validates structure, not truth.

## Runtime and checkpoint boundary

Finalization and completion repair cannot grant additional permissions, switch models, lower effort, reset counters or start a fresh budget. A length-truncated edit is never executed or replayed. Refusal detection for unstructured text is conservative and best-effort, not a universal classifier. Permission denials and explicit refusal signals do not authorize automatic continuation; a denied capability stops the worker.

Candidate files and metadata are checkpointed with atomic per-file replacements; a set of files is not a transaction. A crash can leave mismatched generations or lose the latest event. Review candidate hashes and source staleness before integration. A bounded public assistant-text excerpt is retained for diagnosis, but structured thinking blocks, signatures and raw tool arguments are not persisted. Public text and candidates can still contain selected source: keep run directories private and inspect them before sharing.

Worker, request and optional SDK-event idle timers use cooperative SDK abort. They do not forcibly kill a blocked dependency or provide worker-process isolation. Heartbeats indicate event-loop liveness, not provider progress, and they do not extend outer host timeouts. No detached supervisor or durable transcript resume is implemented. See [troubleshooting](troubleshooting.md).

## What this does not guarantee

This is **not an operating-system sandbox**, independent security audit, or protection against a compromised Node binary, SDK dependency, host, provider, privileged local user, or malicious actor executing arbitrary code as the same user. The trusted host process has filesystem and network capabilities that are not exposed as model tools. Prompt instructions are not themselves a security boundary.

Source files can still contain unrecognized secrets. Sensitive-name filtering does not detect every credential or private datum. An explicitly allowlisted confidential file will be transmitted when a worker reads it. The host must minimize/sanitize context and honor source-sharing restrictions. Read-only protects modification, not confidentiality. Do not send source to any external model without the necessary authorization.

Parent-directory filesystem races, hard links, local administrator access, and platform permission behavior are not eliminated by the model-tool layer. `O_NOFOLLOW` is used where available for the final source component; it is not equivalent to a fully isolated filesystem namespace. Use a host sandbox/container and egress controls appropriate to your environment when stronger isolation is required.

Candidates and recommendations can be wrong or malicious. The host must inspect and validate them before running any changed code or integrating it. A plausible file/line citation, matching hash, or complete assessment is not proof of correctness. No worker may authorize a new model, expand permissions, approve external sharing, or set its own usefulness score.

## Credentials

Environment keys take precedence over `~/.config/pi/credentials.json`. The skill does not read repository `.env`, upstream Pi `auth.json`, shell startup files, or arbitrary key paths named in task plans. The model never receives credential values in its context or tools. Known credential values and common key-shaped strings are redacted from caught error messages.

The optional `auth` command requires an interactive terminal and hidden input. It stores **plaintext, not encrypted** data. On POSIX, it sets the final directory to mode 700 and writes the file at mode 600; reads reject broad file permissions and wrong ownership. On Windows, it uses PowerShell to set a new protected current-user directory ACL before writing the replacement file. Failure to set that ACL prevents new secret bytes from being written by the command.

Windows credential reads do not independently prove the complete ACL of a manually created file; use `auth` or approved environment injection, and inspect local protection yourself. Windows ACL operations and desktop sandbox access were not exercised in the preparation environment. This is not Windows Credential Manager, macOS Keychain, or an encrypted secret store. Backups, administrators, other programs running as you, and host tools with sufficient authority may access the key. Do not use shared/untrusted configuration directories.

Keep secrets out of chat, shell arguments, `AGENTS.md`, plans, logs, issues, and source control. To revoke a key, revoke it at the provider; deleting a local file alone does not revoke provider access. Delete/replace the local file manually only after checking which credentials it contains. Installation/updating does not touch it.

## Billing, routing, and identity

The runner records attempted requests, available usage, model identities, response IDs, and provider-reported generation charges. A connection can fail after charging. Missing response IDs or delayed metadata can leave cost unknown. Reservations and limits are soft safeguards, not guaranteed billing ceilings, and a separate run has a separate ledger.

An upstream provider can return a model identity that differs from the requested alias. Known catalog canonical identities are allowed and recorded; unrelated identities are flagged. Late reconciliation can reveal a mismatch after a run. Treat mismatches as grounds to revisit the relevant results, not as permission to silently accept another model.

OpenRouter routing constraints can reduce available routes. Do not relax data or provider restrictions automatically. Different provider retention/training policies and BYOK charges may apply. Source sharing and cost approval remain the user's decisions.

## Artifacts and retention

The implementation stores compact metadata instead of full transcripts/reasoning traces. Nevertheless, task text, source snippets, findings, proposed tests, and candidate files can contain private code. Run directories default to private user cache storage and remain there until the user deletes them. There is no scheduled cleanup, background daemon, or telemetry upload added by this project.

The release/install allowlist excludes dependencies, `.git`, arbitrary root files, credentials, and runtime directories. It also rejects obvious secret files inside allowed directories. This is not a secret scanner for all strings: review the final ZIP and `git diff --cached` before publishing. Do not add real session artifacts to examples or attach them to public issues without careful redaction.

## Development and disclosure

CI must use synthetic fixtures and no provider credentials. Do not run fork pull requests with secrets or `pull_request_target`. Keep dependencies locked after genuine resolution and review version upgrades alongside SDK contract tests. See [SECURITY.md](../SECURITY.md), [validation](../references/validation.md), and [release process](releasing.md).

## Host-only instruction learning

Worker read and write paths deny instruction files (`AGENTS.md`, `AGENTS.override.md`, `CLAUDE.md`, `CLAUDE.local.md`) and agent configuration/memory directories. Only the separate trusted-host learning command can edit the root managed AGENTS section after explicit project initialization. The installer itself never edits task-project instructions. `learn init --claude-import` is a separately requested exception that may create the shared root file and append its Claude import.

No free-form worker reflection becomes an instruction. Promotion uses fixed templates, identifier escaping, minimum evidence rules, a bounded block, stale-content hashes and cooperating-operation locks. `--reviewed-by` and assessment authors are attestations, not authentication of a process or proof that tests ran. The trusted host can still supply false observations; normal review remains essential.

Private telemetry is Git-ignored but is not encrypted or automatically purged. Local read/write checks do not eliminate all filesystem races, protect against other programs running as the user, or provide atomic transactions across multiple files. After crashes, inspect existing instructions/state before recovering a lock. Expiry/revision is not an automatic background edit; explicitly review and apply retirement. Windows learning filesystem behavior remains untested here. See [learning](learning.md).
