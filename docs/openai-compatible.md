# OpenAI-compatible inference routes

Pi can use an explicitly approved OpenAI Chat Completions endpoint, including infrastructure you operate. The existing installed Pi SDK supplies the adapter; no additional dependencies or server installation are required. This supports streamed text and named function tools over `/chat/completions`. It does not claim every server advertising “OpenAI compatible” implements tool calling, reasoning effort, or usage accounting correctly.

The [example policy](../examples/openai-compatible.policy.json) is a **synthetic configuration template**, not a verified server or model. Replace the endpoint, exact served model ID, context/output limits, effort capabilities, and all four estimate rates after checking your deployment. Zero rates are explicitly allowed for an evaluation with no metered inference charge; they do not measure electricity, hardware or operating costs. A missing rate is rejected instead of silently treated as free.

Place the declarations in the plan's `policy.openai_compatible_providers`. A provider ID must be `compatible:<portable-name>`; use a separate name for each intended route. Each provider has exactly one approved `base_url` and a dictionary of exact approved model IDs. Only those models can run. Default provider/model selection still applies, including the existing explicit exception rule for a nonpreferred model.

```json
{
  "preferred_provider": "compatible:lab",
  "preferred_models": ["served-model-version"],
  "openai_compatible_providers": {
    "compatible:lab": {
      "base_url": "https://inference.example.invalid/v1",
      "auth": { "type": "env", "env": "PI_LAB_API_KEY" },
      "models": {
        "served-model-version": {
          "context_window": 131072,
          "max_output_tokens": 8192,
          "supports_tools": true,
          "supported_efforts": ["high", "max"],
          "rates_usd_per_million": { "input": 0.2, "output": 0.8, "cacheRead": 0.2, "cacheWrite": 0.2 }
        }
      }
    }
  }
}
```

All numbers and capabilities above are illustrative. Capability metadata says **policy declaration; endpoint not probed**, never “verified.” `check` and model resolution do not send inference requests or download server models. Run live evaluations only under the user's existing approval for that exact endpoint, model and data. The plan's snapshots, isolated candidate writes, budgets, request ceilings and primary-host review remain in force.

## Authentication and transport

Authentication must be `{ "type": "env", "env": "EXACT_VARIABLE_NAME" }` or explicitly `{ "type": "none" }`. The latter removes the Authorization header before transport. There is no fallback to `OPENAI_API_KEY`, the built-in OpenAI credential file, or another provider. If you explicitly name `OPENAI_API_KEY`, that exact reference is honored, so a separate route-specific variable is preferable. Key values must never appear in plans or reports.

URLs cannot contain credentials, query strings, fragments or backslashes. HTTPS is the default. An HTTP endpoint, including localhost or an internal network host, requires `allow_insecure_http: true` on its exact declaration. Pi only POSTs to the configured base plus `/chat/completions`; redirects and unexpected destinations fail closed. Endpoint approval does not assert that DNS, server ownership, or the infrastructure is trusted. No server discovery, authentication probing, shell, arbitrary request headers, body overrides, or executable adapter paths are accepted in policy.

## Reasoning and local models

Reasoning routes must declare at least one of `high`, `xhigh`, or `max`. Workers continue to request `xhigh` or `max`; mapping to the highest supported declared level is recorded transparently and the existing strict policy rejects mapping. The wire parameter is standard Chat Completions `reasoning_effort`.

For a model that cannot accept reasoning effort, explicitly declare both:

```json
{
  "supported_efforts": ["off"],
  "non_reasoning_approval": "Approved evaluation of this local non-reasoning model."
}
```

Its plan worker must also set `"effort": "off"`. Omitting that worker setting fails instead of downgrading a high-reasoning request. This approval changes the permitted reasoning setting only; it does not expand files, tools, budgets, endpoints or model IDs. A reasoning server that needs custom body parameters instead of standard `reasoning_effort` is not supported by this adapter without a reviewed implementation change.

## Compatibility controls

The optional per-model `compat` object accepts only these fields:

| Field | Default | Purpose |
| --- | --- | --- |
| `max_tokens_field` | `max_tokens` | Choose `max_tokens` or `max_completion_tokens`. |
| `supports_usage_in_streaming` | `true` | Send `stream_options.include_usage`; false supports servers rejecting that field. |
| `supports_strict_mode` | `false` | Include the SDK's function schema strictness field. |
| `supports_developer_role` | `false` | Use developer role where supported. |
| `requires_tool_result_name` | `false` | Include function name in tool results. |
| `requires_assistant_after_tool_result` | `false` | Apply the SDK's required assistant continuation compatibility. |
| `requires_reasoning_content` | `false` | Replay the SDK's reasoning-content field for servers requiring it. |

Every boolean is an operator declaration. Errors remain errors; the runner does not try another endpoint, model, key, or protocol automatically. A returned model identity different from the exact approved identity stops the worker as `model_mismatch`. A missing usage record stays unpriced. Supplied estimate rates never become provider-reconciled charges.

Official server documentation illustrates why declarations need deployment-specific review: [vLLM's compatible server](https://github.com/vllm-project/vllm/blob/main/docs/serving/online_serving/openai_compatible_server.md) documents the served API and tool configuration, and [vLLM reasoning outputs](https://docs.vllm.ai/en/latest/features/reasoning_outputs/) documents model-dependent reasoning behavior. Those are capability references, not validation of your deployment.

## Learning identity and migration

Compatible report metadata records SHA-256 fingerprints of the canonical endpoint and the complete effective route/model declaration. The configuration fingerprint includes endpoint, authentication **reference** (never its value), exact provider/model identity, context/output limits, costs and SDK serialization settings. Requested effort is recorded separately. Changing a server behind an unchanged URL or replacing weights under an unchanged model ID cannot be detected automatically; use a new route name or versioned served model ID for that change.

Compatible learning profiles and each compatible team member add `configuration_fingerprint` to their existing profile identity. Compact project history retains fingerprints, not endpoint URLs. This additive identity extension preserves existing built-in schema-1 and schema-2 profile bytes and digests. Existing built-in observations need no migration. Older compatible observations without a valid configuration fingerprint cannot support promotion; do not fabricate a fingerprint for historical evidence. Re-run under a new approved declaration or reconstruct it only from the original saved plan and report under explicit host review.

Recording verifies the report fingerprint against its saved plan. Statistics keep different fingerprints separate. Recommendations only match compatible evidence against the current declaration's fingerprint; changing the endpoint under a reused route name cannot inherit the old server's observed successes. Promoted guidance displays the full required fingerprint and must be revalidated after any configuration or served-model change. These observations remain local opt-in evidence, not causal rankings.
