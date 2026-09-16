# Examples

These are **schema examples, not runnable tasks or live result evidence**. Replace absolute repository paths, exact source paths, context, model-selection reasons and all assessment identifiers with actual authorized values.

- [read-only.plan.json](read-only.plan.json): one Codex-hosted read-only review.
- [implementation.plan.json](implementation.plan.json): a Claude Code-hosted candidate implementer with a larger allocation, plus an independent read-only reviewer held below that ceiling by its own `limits`.
- [claude-code.plan.json](claude-code.plan.json): equivalent Claude Code host metadata.
- [plan template](../templates/plan.example.json): candidate plus independent baseline reviewer.
- [assessment template](../templates/assessment.example.json): normal host judgments.
- [learning assessment template](../templates/learning-assessment.example.json): conservative, initially unvalidated learning fields; set the actual host and actual evidence.

No example enables paid inference, modifies a real checkout or supplies a credential. A `mode: write` worker edits an isolated overlay exported as `candidate/` and `candidate.patch`; the host applies what it accepts. A same-plan reviewer does not see a candidate patch. Read [workflows](../docs/workflows.md) and [learning](../docs/learning.md) before treating multi-phase observations as evidence.
