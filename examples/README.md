# Examples

These are **schema examples, not runnable tasks or live result evidence**. Replace absolute repository paths, exact source paths, context, model-selection reasons and all assessment identifiers with actual authorized values.

- [read-only.plan.json](read-only.plan.json): one Codex-hosted read-only review.
- [implementation.plan.json](implementation.plan.json): a Claude Code-hosted candidate implementer with a larger allocation, plus an independent read-only reviewer held below that ceiling by its own `limits`.
- [claude-code.plan.json](claude-code.plan.json): equivalent Claude Code host metadata.
- [plan template](../templates/plan.example.json): candidate plus independent baseline reviewer.
- [workflow template](../templates/workflow.example.json): a synthetic implement → candidate review loop, with a shared budget, three-cycle ceiling and host-verified closing criteria. Remove `loop` and use strategy `sequence` for one ordered pass. See [workflow commands](../docs/workflow-contracts.md).
- [assessment template](../templates/assessment.example.json): normal host judgments.
- [learning assessment template](../templates/learning-assessment.example.json): conservative, initially unvalidated learning fields; set the actual host and actual evidence.
- [legacy assessment template](../templates/assessment.legacy.example.json): schema-1 assessment retained to demonstrate additive reading of older runs.

No example enables paid inference, modifies a real checkout or supplies a credential. A `mode: write` worker edits an isolated overlay exported as `candidate/` and `candidate.patch`; the host applies what it accepts. A same-plan reviewer does not see a candidate patch. Read [workflows](../docs/workflows.md) and [learning](../docs/learning.md) before treating multi-phase observations as evidence.

The main plan template includes the optional evaluation contract: a stable task ID, task/scope metadata, six standard focus labels (custom lowercase tags are also allowed), and criteria tied to each plan agent and attempt. Existing plans without `evaluation` remain valid; `read-only.plan.json` is intentionally kept as a legacy-compatible example.
