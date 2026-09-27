/** Explicit, data-only OpenAI Chat Completions routes. No discovery, code loading from policy, or credential fallback. */
import crypto from 'node:crypto';

const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const NO_AUTH_KEY = 'pi-explicit-no-auth'; // SDK requires a nonempty key; never sent over the wire.
const check = (ok, message) => { if (!ok) throw new Error(message); };
const object = (value, label) => check(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
const keys = (value, allowed, label) => { object(value, label); for (const key of Object.keys(value)) check(allowed.includes(key), `Unsupported ${label} field: ${key}`); };
const text = (value, label, max = 200) => check(typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value), `${label} must be bounded nonempty text without control characters`);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

export function compatibleEndpoint(config) {
  text(config.base_url, 'compatible base_url', 2048);
  let url;
  try { url = new URL(config.base_url); } catch { throw new Error('Invalid compatible base_url'); }
  check(['https:', 'http:'].includes(url.protocol), 'Compatible base_url requires HTTPS or explicitly approved HTTP');
  check(url.protocol !== 'http:' || config.allow_insecure_http === true, 'HTTP requires allow_insecure_http: true for this exact endpoint');
  check(!url.username && !url.password && !url.search && !url.hash && !/[?#\\]/.test(config.base_url), 'Compatible base_url cannot contain credentials, query, fragment or backslash');
  check(url.href.replace(/\/$/, '') === config.base_url.replace(/\/$/, ''), 'Compatible base_url must be a canonical absolute URL');
  return url.href.replace(/\/$/, '');
}

export function validateCompatibleProviders(registry = {}) {
  object(registry, 'openai_compatible_providers');
  check(Object.keys(registry).length <= 32, 'At most 32 compatible routes are allowed');
  for (const [provider, config] of Object.entries(registry)) {
    check(/^compatible:[a-z][a-z0-9_-]{0,47}$/.test(provider), 'Compatible provider IDs must use compatible:<portable-name>');
    keys(config, ['base_url', 'allow_insecure_http', 'auth', 'models'], 'compatible provider');
    if (config.allow_insecure_http !== undefined) check(typeof config.allow_insecure_http === 'boolean', 'allow_insecure_http must be boolean');
    compatibleEndpoint(config);
    keys(config.auth, ['type', 'env'], 'compatible auth');
    check(['none', 'env'].includes(config.auth.type), 'Compatible auth.type must be none or env');
    if (config.auth.type === 'env') check(typeof config.auth.env === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/.test(config.auth.env), 'Compatible auth.env must name one exact environment variable');
    else check(config.auth.env === undefined, 'auth none cannot include an environment variable');
    object(config.models, 'compatible models');
    check(Object.keys(config.models).length > 0 && Object.keys(config.models).length <= 256, 'Compatible route needs 1–256 exact model declarations');
    for (const [id, model] of Object.entries(config.models)) {
      text(id, 'compatible model ID');
      keys(model, ['context_window', 'max_output_tokens', 'supports_tools', 'supported_efforts', 'non_reasoning_approval', 'rates_usd_per_million', 'compat'], 'compatible model');
      for (const key of ['context_window', 'max_output_tokens']) check(Number.isSafeInteger(model[key]) && model[key] > 0, `Compatible ${key} must be a positive safe integer`);
      check(model.max_output_tokens < model.context_window, 'Compatible output limit must leave input room in the context window');
      check(model.supports_tools === true, 'Compatible models must explicitly declare supports_tools: true');
      const efforts = model.supported_efforts;
      check(Array.isArray(efforts) && efforts.length > 0 && new Set(efforts).size === efforts.length && efforts.every(e => LEVELS.includes(e)), 'Compatible supported_efforts must explicitly enumerate unique supported levels');
      if (efforts.length === 1 && efforts[0] === 'off') text(model.non_reasoning_approval, 'non_reasoning_approval', 2000);
      else {
        check(efforts.some(e => ['high', 'xhigh', 'max'].includes(e)) && !efforts.includes('off'), 'Reasoning routes must expose high/xhigh/max; non-reasoning routes use only off with explicit approval');
        check(model.non_reasoning_approval === undefined, 'non_reasoning_approval applies only to an off-only model');
      }
      keys(model.rates_usd_per_million, ['input', 'output', 'cacheRead', 'cacheWrite'], 'compatible rates');
      for (const rate of ['input', 'output', 'cacheRead', 'cacheWrite']) check(typeof model.rates_usd_per_million[rate] === 'number' && Number.isFinite(model.rates_usd_per_million[rate]) && model.rates_usd_per_million[rate] >= 0, `Compatible ${rate} pricing must be explicitly declared, including zero`);
      const compat = model.compat || {};
      keys(compat, ['max_tokens_field', 'supports_usage_in_streaming', 'supports_strict_mode', 'supports_developer_role', 'requires_tool_result_name', 'requires_assistant_after_tool_result', 'requires_reasoning_content'], 'compatible serialization');
      if (compat.max_tokens_field !== undefined) check(['max_tokens', 'max_completion_tokens'].includes(compat.max_tokens_field), 'Unsupported max_tokens_field');
      for (const [key, value] of Object.entries(compat)) if (key !== 'max_tokens_field') check(typeof value === 'boolean', `Compatible ${key} must be boolean`);
    }
  }
  return registry;
}

export const isCompatibleProvider = (policy, provider) => typeof provider === 'string' && Object.hasOwn(policy.openai_compatible_providers || {}, provider);
function routeFor(policy, provider) {
  check(isCompatibleProvider(policy, provider), `No explicitly approved compatible route: ${provider}`);
  const config = policy.openai_compatible_providers[provider];
  validateCompatibleProviders({ [provider]: config });
  return config;
}

export function compatibleKeyFor(policy, provider, env = process.env) {
  const { auth } = routeFor(policy, provider);
  if (auth.type === 'none') return NO_AUTH_KEY;
  const value = Object.hasOwn(env, auth.env) ? env[auth.env] : null;
  check(typeof value === 'string' && value.trim().length > 0, `Missing explicitly configured ${auth.env}; no credential fallback is allowed`);
  const key = value.trim();
  check(key.length <= 8192 && !/\s|[\x00-\x1f\x7f]/.test(key), 'Invalid compatible API credential');
  return key;
}

export function resolveCompatibleModel(policy, agent) {
  const config = routeFor(policy, agent.provider);
  check(Object.hasOwn(config.models, agent.model), `Exact model is not approved for ${agent.provider}: ${agent.model}`);
  const declaration = config.models[agent.model], supported = declaration.supported_efforts;
  const reasoning = !supported.includes('off');
  let effective = agent.effort, mapping = 'exact';
  if (!reasoning) check(agent.effort === 'off', 'Approved non-reasoning model requires explicit agent effort: off; no silent effort downgrade');
  else {
    check(['xhigh', 'max'].includes(agent.effort), 'Reasoning route requires requested effort xhigh or max');
    if (!supported.includes(agent.effort)) {
      check(policy.effort_policy !== 'strict', `Model does not support requested effort ${agent.effort}; strict policy forbids mapping`);
      const known = LEVELS.filter(e => supported.includes(e));
      effective = known.find(e => LEVELS.indexOf(e) > LEVELS.indexOf(agent.effort)) || known.at(-1);
      mapping = LEVELS.indexOf(effective) > LEVELS.indexOf(agent.effort) ? 'raised_to_next_supported' : 'clamped_to_highest_supported';
    }
  }
  const compat = declaration.compat || {}, baseUrl = compatibleEndpoint(config);
  const model = {
    id: agent.model, name: agent.model, provider: agent.provider, api: 'openai-completions', baseUrl,
    reasoning, input: ['text'], contextWindow: declaration.context_window, maxTokens: declaration.max_output_tokens,
    cost: { ...declaration.rates_usd_per_million },
    thinkingLevelMap: Object.fromEntries(LEVELS.map(e => [e, reasoning && supported.includes(e) ? e : null])),
    compat: {
      thinkingFormat: 'openai', supportsStore: false, supportsLongCacheRetention: false,
      supportsReasoningEffort: reasoning, supportsFinishReason: true,
      maxTokensField: compat.max_tokens_field || 'max_tokens',
      supportsUsageInStreaming: compat.supports_usage_in_streaming ?? true,
      supportsStrictMode: compat.supports_strict_mode ?? false,
      supportsDeveloperRole: compat.supports_developer_role ?? false,
      requiresToolResultName: compat.requires_tool_result_name ?? false,
      requiresAssistantAfterToolResult: compat.requires_assistant_after_tool_result ?? false,
      requiresReasoningContentOnAssistantMessages: compat.requires_reasoning_content ?? false
    }
  };
  // Hash canonical field order so equivalent declarations share a fingerprint. Never include a key value.
  const configuration = { base_url: baseUrl, auth: config.auth, model };
  const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])])) : value;
  return { model, metadata: {
    requested_model: agent.model, resolved_model: agent.model, provider: agent.provider, alias: null,
    catalog_alias_target: null, canonical_slug: null,
    endpoint: baseUrl, endpoint_fingerprint: hash(baseUrl), configuration_fingerprint: hash(JSON.stringify(stable(configuration))),
    capability_source: 'Explicit host-approved OpenAI-compatible policy declaration; endpoint and capabilities not probed',
    checked_at: new Date().toISOString(), supported_efforts: [...supported], requested_effort: agent.effort,
    effective_pi_effort: effective, effort_mapping: mapping, configured_provider_effort: reasoning ? effective : null,
    ...(reasoning ? {} : { non_reasoning_approval: declaration.non_reasoning_approval }),
    max_output_tokens: Math.min(policy.max_output_tokens, model.maxTokens), rates_for_estimate_usd_per_million: model.cost,
    pricing_note: 'Host-declared estimates; no provider billing reconciliation. Explicit zero rates do not establish zero infrastructure cost.',
    openrouter_routing: null
  } };
}

/** Identity of an approved route/model declaration, independent of the caller's requested effort. */
export function compatibleConfigurationFingerprint(policy, provider, model) {
  const config = routeFor(policy, provider);
  check(Object.hasOwn(config.models, model), 'Compatible fingerprint requires an explicitly configured model');
  const effort = config.models[model].supported_efforts.includes('off') ? 'off' : 'max';
  return resolveCompatibleModel({ ...policy, effort_policy: 'best_supported' }, { provider, model, effort }).metadata.configuration_fingerprint;
}

/** The only custom-route adapter uses an installed static SDK import. fetcher is a host-only test seam. */
export async function loadCompatibleAdapter(policy, provider, fetcher = globalThis.fetch) {
  // Snapshot policy data so later caller mutation cannot silently expand the destination/model grants.
  const config = structuredClone(routeFor(policy, provider));
  const frozenPolicy = { ...policy, openai_compatible_providers: { [provider]: config } };
  const endpoint = `${compatibleEndpoint(config)}/chat/completions`;
  const { streamSimple } = await import('@earendil-works/pi-ai/api/openai-completions');
  return { streamSimple(selected, context, options = {}) {
    check(selected.provider === provider && selected.baseUrl === compatibleEndpoint(config), 'Compatible request changed the approved route');
    check(Object.hasOwn(config.models, selected.id), 'Compatible request changed the approved model');
    const reasoning = !config.models[selected.id].supported_efforts.includes('off');
    const { model } = resolveCompatibleModel({ ...frozenPolicy, effort_policy: 'best_supported' }, { provider, model: selected.id, effort: reasoning ? 'max' : 'off' });
    const supported = config.models[model.id].supported_efforts;
    const effort = options.reasoning ?? (model.reasoning ? null : 'off');
    check(supported.includes(effort), 'Compatible request changed or omitted the approved reasoning effort');
    check(!options.headers || Object.keys(options.headers).length === 0, 'Custom headers are not permitted for compatible routes');
    check(Number.isInteger(options.maxTokens) && options.maxTokens > 0 && options.maxTokens <= Math.min(frozenPolicy.max_output_tokens, model.maxTokens), 'Compatible request exceeds the approved output limit');
    const key = config.auth.type === 'none' ? NO_AUTH_KEY : options.apiKey;
    check(typeof key === 'string' && key.length > 0, 'Compatible request requires its explicitly configured API credential');
    const verifyPayload = payload => {
      check(payload && payload.model === model.id && payload.stream === true && !Object.hasOwn(payload, 'models'), 'Compatible request changed the approved model or stream contract');
      check(model.reasoning ? payload.reasoning_effort === effort : !Object.hasOwn(payload, 'reasoning_effort'), 'Compatible request did not serialize the expected reasoning effort');
      check(payload[model.compat.maxTokensField] === options.maxTokens, 'Compatible request changed its output limit');
      return payload;
    };
    return streamSimple(model, context, {
      ...options, apiKey: key, cacheRetention: 'none', maxRetries: 0,
      onPayload: async (payload, selectedModel) => {
        const next = options.onPayload ? await options.onPayload(payload, selectedModel) : payload;
        return verifyPayload(next ?? payload);
      },
      fetch: async (input, init) => {
        const request = new Request(input, { ...init, redirect: 'error' });
        check(request.url === endpoint && request.method === 'POST', 'Compatible transport attempted an unapproved destination or method');
        verifyPayload(JSON.parse(await request.clone().text()));
        const headers = new Headers(request.headers);
        for (const header of ['authorization', 'cookie', 'proxy-authorization', 'openai-organization', 'openai-project']) headers.delete(header);
        if (config.auth.type === 'env') headers.set('authorization', `Bearer ${key}`);
        const response = await fetcher(new Request(request, { headers, redirect: 'error', credentials: 'omit' }));
        check(!response.redirected && !(response.status >= 300 && response.status < 400) && (!response.url || response.url === endpoint), 'Compatible endpoint redirects are forbidden');
        return response;
      }
    });
  } };
}
