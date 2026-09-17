/**
 * Domain records: providers, routes, client keys, usage.
 *
 * These schemas are simultaneously the SQLite row mapping, the admin API
 * contract, and the types the gateway core operates on. One definition, so the
 * UI can never drift from what the server stores.
 */
import * as Schema from "effect/Schema"
import { ModelCapabilities } from "./models/capabilities.ts"

/**
 * Extra in-provider attempts, bounded at both ends.
 *
 * Unbounded, this is a denial-of-service on the gateway's own host: the retry loop
 * terminates only when the provider stops failing, and a 503 without `Retry-After`
 * retries with no delay at all, so one client request can issue thousands of upstream
 * calls. Ten is far above any useful setting — the retry exists to absorb a blip, and a
 * provider that has failed ten times in a row is not having a blip.
 */
export const MAX_RETRIES = 10

/** Upstream protocol family. */
export const ProviderKind = Schema.Literal("openai-chat", "openai-responses", "workbuddy2api")
export type ProviderKind = typeof ProviderKind.Type

/** How to pick among several providers serving the same public model. */
export const RoutingStrategy = Schema.Literal("priority", "weighted")
export type RoutingStrategy = typeof RoutingStrategy.Type

export const StringMap = Schema.Record({ key: Schema.String, value: Schema.String })

// --- provider --------------------------------------------------------------

/** A provider as stored and edited. `api_key` is write-only in the admin API. */
export const Provider = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  kind: ProviderKind,
  /** Origin without a trailing slash, e.g. `https://api.openai.com`. */
  base_url: Schema.String,
  api_key: Schema.String,
  headers: StringMap,
  /** Higher wins under `priority`; doubles as the weight under `weighted`. */
  priority: Schema.Number,
  enabled: Schema.Boolean,
  /** Upstream model id → public model id, applied after discovery. */
  model_rename: StringMap,
  /** Glob allowlist for discovered ids; empty means "allow everything". */
  model_allow: Schema.Array(Schema.String),
  /** Glob denylist, applied after the allowlist. */
  model_deny: Schema.Array(Schema.String),
  /** Cost per 1M prompt tokens. `null` = unknown, reported as unpriced. */
  input_price: Schema.NullOr(Schema.Number),
  output_price: Schema.NullOr(Schema.Number),
  currency: Schema.String,
  /**
   * Extra in-provider attempts on a retryable failure before the router moves on.
   * `0` (default) fails over to the next provider immediately.
   */
  max_retries: Schema.Int.pipe(Schema.between(0, MAX_RETRIES)),
  created_at: Schema.Number,
  updated_at: Schema.Number
})
export type Provider = typeof Provider.Type

/** Fields an operator may set. Absent = leave unchanged on update. */
export const ProviderInput = Schema.Struct({
  name: Schema.String,
  kind: ProviderKind,
  base_url: Schema.String,
  api_key: Schema.optional(Schema.String),
  headers: Schema.optional(StringMap),
  priority: Schema.optional(Schema.Number),
  enabled: Schema.optional(Schema.Boolean),
  model_rename: Schema.optional(StringMap),
  model_allow: Schema.optional(Schema.Array(Schema.String)),
  model_deny: Schema.optional(Schema.Array(Schema.String)),
  input_price: Schema.optional(Schema.NullOr(Schema.Number)),
  output_price: Schema.optional(Schema.NullOr(Schema.Number)),
  currency: Schema.optional(Schema.String),
  max_retries: Schema.optional(Schema.Int.pipe(Schema.between(0, MAX_RETRIES)))
})
export type ProviderInput = typeof ProviderInput.Type

/**
 * One provider attempt, as recorded for the usage log and the admin UI.
 *
 * Lives here rather than beside the executor because the failure trail travels on
 * `ProviderError`: a request that exhausted every candidate still has to report how
 * many providers it tried and which one failed last, and the error is what reaches
 * the handler that writes the usage row.
 */
export const ProviderAttempt = Schema.Struct({
  provider_id: Schema.Number,
  provider_name: Schema.String,
  provider_kind: ProviderKind,
  upstream_model: Schema.String,
  status: Schema.Number,
  error_kind: Schema.NullOr(Schema.String),
  error_message: Schema.NullOr(Schema.String),
  latency_ms: Schema.Number
})
export type ProviderAttempt = typeof ProviderAttempt.Type

/** A model discovered on a provider. */
export const DiscoveredModel = Schema.Struct({
  provider_id: Schema.Number,
  upstream_id: Schema.String,
  public_id: Schema.String,
  context_length: Schema.NullOr(Schema.Number),
  max_output_tokens: Schema.NullOr(Schema.Number),
  /**
   * What the model accepts and emits. `null` when nothing could be established — a
   * provider that does not report it and a `models.dev` id that matched nothing.
   *
   * Deliberately not a boolean: "we do not know" and "no images" are different answers,
   * and collapsing them told every client that an unrecognised model was text-only.
   */
  capabilities: Schema.NullOr(ModelCapabilities),
  owned_by: Schema.NullOr(Schema.String),
  last_seen: Schema.Number
})
export type DiscoveredModel = typeof DiscoveredModel.Type

/** One account inside a workbuddy2api upstream. */
export const CreditsAccount = Schema.Struct({
  uid: Schema.String,
  nickname: Schema.optional(Schema.String),
  realm: Schema.optional(Schema.String),
  credits: Schema.Number,
  cooling: Schema.optional(Schema.Boolean),
  disabled: Schema.optional(Schema.Boolean),
  disabled_reason: Schema.optional(Schema.String)
})
export type CreditsAccount = typeof CreditsAccount.Type

/** workbuddy2api credit snapshot: the aggregated total plus per-account detail. */
export const Credits = Schema.Struct({
  provider_id: Schema.Number,
  total: Schema.Number,
  healthy: Schema.Number,
  accounts: Schema.Array(CreditsAccount),
  fetched_at: Schema.Number,
  error: Schema.NullOr(Schema.String)
})
export type Credits = typeof Credits.Type

/** Runtime breaker state for a provider. */
export const ProviderStatus = Schema.Struct({
  provider_id: Schema.Number,
  consecutive_failures: Schema.Number,
  /** Epoch ms until the breaker reopens the provider; 0 = healthy. */
  open_until: Schema.Number,
  last_error: Schema.NullOr(Schema.String),
  last_error_at: Schema.Number,
  last_success_at: Schema.Number,
  last_latency_ms: Schema.Number
})
export type ProviderStatus = typeof ProviderStatus.Type

export const EMPTY_STATUS: ProviderStatus = {
  provider_id: 0,
  consecutive_failures: 0,
  open_until: 0,
  last_error: null,
  last_error_at: 0,
  last_success_at: 0,
  last_latency_ms: 0
}

// --- routes ----------------------------------------------------------------

/** One (provider, upstream model) pair capable of serving a public model. */
export const RouteTarget = Schema.Struct({
  provider_id: Schema.Number,
  upstream_model: Schema.String,
  priority: Schema.Number,
  enabled: Schema.Boolean
})
export type RouteTarget = typeof RouteTarget.Type

export const Route = Schema.Struct({
  public_model: Schema.String,
  /** `null` = inherit the gateway default strategy. */
  strategy: Schema.NullOr(RoutingStrategy),
  enabled: Schema.Boolean,
  display_name: Schema.NullOr(Schema.String),
  /**
   * Whether `routes/sync` owns this route.
   *
   * Explicit rather than inferred from the target count: sync creates multi-target
   * routes itself when several providers serve one model, so a count-based test
   * reclassified its own output as operator-curated and stopped reconciling it.
   * An operator editing a route through the admin API clears this, handing ownership
   * back to them.
   */
  auto: Schema.Boolean,
  targets: Schema.Array(RouteTarget),
  created_at: Schema.Number,
  updated_at: Schema.Number
})
export type Route = typeof Route.Type

export const RouteInput = Schema.Struct({
  public_model: Schema.String,
  /** Set by `routes/sync`; absent from operator input, which always clears it. */
  auto: Schema.optional(Schema.Boolean),
  strategy: Schema.optional(Schema.NullOr(RoutingStrategy)),
  enabled: Schema.optional(Schema.Boolean),
  display_name: Schema.optional(Schema.NullOr(Schema.String)),
  targets: Schema.Array(RouteTarget)
})
export type RouteInput = typeof RouteInput.Type

// --- client keys -----------------------------------------------------------

export const ApiKey = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  /** Only present in creation responses; list/detail mask it. */
  key: Schema.String,
  enabled: Schema.Boolean,
  /** Requests per minute allowed; 0 = unlimited. */
  rate_limit_rpm: Schema.Number,
  allowed_models: Schema.Array(Schema.String),
  created_at: Schema.Number,
  last_used_at: Schema.Number,
  total_requests: Schema.Number
})
export type ApiKey = typeof ApiKey.Type

export const ApiKeyInput = Schema.Struct({
  name: Schema.String,
  /** Omit to have the gateway generate one. */
  key: Schema.optional(Schema.String),
  enabled: Schema.optional(Schema.Boolean),
  rate_limit_rpm: Schema.optional(Schema.Number),
  allowed_models: Schema.optional(Schema.Array(Schema.String))
})
export type ApiKeyInput = typeof ApiKeyInput.Type

/**
 * A client key as returned by creation — the only time the secret is revealed.
 *
 * The secret must be shown exactly once, at creation, because it cannot be recovered
 * afterwards: the list and detail views return only `masked`. Without this the UI could
 * not tell the operator what to paste into their client, and the key would be unusable.
 * Update responses deliberately use `ApiKeyMasked` so a routine edit cannot leak it.
 */
export const ApiKeyCreated = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  masked: Schema.String,
  /** The full secret. Present only here. */
  key: Schema.String,
  enabled: Schema.Boolean,
  rate_limit_rpm: Schema.Number,
  allowed_models: Schema.Array(Schema.String),
  created_at: Schema.Number,
  last_used_at: Schema.Number,
  total_requests: Schema.Number
})
export type ApiKeyCreated = typeof ApiKeyCreated.Type

/** A client key as returned by list/detail — the secret itself is masked. */
export const ApiKeyMasked = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  masked: Schema.String,
  enabled: Schema.Boolean,
  rate_limit_rpm: Schema.Number,
  allowed_models: Schema.Array(Schema.String),
  created_at: Schema.Number,
  last_used_at: Schema.Number,
  total_requests: Schema.Number
})
export type ApiKeyMasked = typeof ApiKeyMasked.Type

// --- usage -----------------------------------------------------------------

export const ENDPOINTS = ["chat", "responses", "anthropic"] as const
export const Endpoint = Schema.Literal(...ENDPOINTS)
export type Endpoint = typeof Endpoint.Type

/** One completed gateway request. Written once, never updated. */
export const UsageEntry = Schema.Struct({
  request_id: Schema.String,
  ts: Schema.Number,
  api_key_id: Schema.NullOr(Schema.Number),
  api_key_name: Schema.NullOr(Schema.String),
  endpoint: Endpoint,
  stream: Schema.Boolean,
  public_model: Schema.String,
  provider_id: Schema.NullOr(Schema.Number),
  provider_name: Schema.NullOr(Schema.String),
  provider_kind: Schema.NullOr(ProviderKind),
  upstream_model: Schema.NullOr(Schema.String),
  prompt_tokens: Schema.Number,
  completion_tokens: Schema.Number,
  cached_tokens: Schema.Number,
  reasoning_tokens: Schema.Number,
  cost: Schema.Number,
  currency: Schema.String,
  /** Provider attempts made; 1 means the first candidate worked. */
  attempts: Schema.Number,
  status: Schema.Number,
  error_kind: Schema.NullOr(Schema.String),
  error_message: Schema.NullOr(Schema.String),
  latency_ms: Schema.Number,
  ttft_ms: Schema.Number,
  client_ip: Schema.NullOr(Schema.String),
  user_agent: Schema.NullOr(Schema.String)
})
export type UsageEntry = typeof UsageEntry.Type

/** Aggregate row for the dashboard tables. */
export const UsageAggregate = Schema.Struct({
  key: Schema.String,
  requests: Schema.Number,
  errors: Schema.Number,
  prompt_tokens: Schema.Number,
  completion_tokens: Schema.Number,
  cached_tokens: Schema.Number,
  reasoning_tokens: Schema.Number,
  cost: Schema.Number,
  avg_latency_ms: Schema.Number,
  avg_ttft_ms: Schema.Number,
  /** Output tokens per second per request; `null` when nothing was long enough to measure. */
  avg_tps: Schema.NullOr(Schema.Number)
})
export type UsageAggregate = typeof UsageAggregate.Type

/**
 * Rollup shown at the top of the dashboard.
 *
 * `cache_rate` is `cached_tokens / prompt_tokens` over the window: the share of
 * prompt tokens the providers served from their own prompt caches. Providers that
 * report nothing contribute 0 to both sides, so the rate is never inflated by
 * missing data.
 */
export const UsageSummary = Schema.Struct({
  window_ms: Schema.Number,
  requests: Schema.Number,
  errors: Schema.Number,
  prompt_tokens: Schema.Number,
  completion_tokens: Schema.Number,
  cached_tokens: Schema.Number,
  reasoning_tokens: Schema.Number,
  cost: Schema.Number,
  /**
   * Currencies the summed `cost` is drawn from.
   *
   * A provider's currency is operator-settable, and `cost` was summed across all of them —
   * so a USD provider and a CNY provider produced one meaningless total. Reported rather
   * than converted: the gateway has no exchange rates, and inventing one would be worse
   * than showing the unit. More than one entry means the total is not a single amount.
   */
  currencies: Schema.Array(Schema.String),
  cache_rate: Schema.NullOr(Schema.Number),
  avg_latency_ms: Schema.NullOr(Schema.Number),
  avg_ttft_ms: Schema.NullOr(Schema.Number),
  /**
   * Output tokens per second, `completion_tokens / (latency_ms - ttft_ms)`.
   *
   * The window between the first token and the last is the only part of the request
   * that scales with generation, so queueing and prompt processing are excluded: a
   * long prompt that was processed slowly does not make the model look slow, and a
   * cache hit that skipped the prompt phase does not make it look fast.
   *
   * `null` when no request in the window produced a positive generation window —
   * including every non-streaming request, where `ttft_ms` is 0 by construction and
   * the whole latency would otherwise be counted as generation time.
   */
  avg_tps: Schema.NullOr(Schema.Number),
  by_model: Schema.Array(UsageAggregate),
  by_provider: Schema.Array(UsageAggregate),
  by_key: Schema.Array(UsageAggregate)
})
export type UsageSummary = typeof UsageSummary.Type

/** Bucketed time series point for the dashboard charts. */
export const UsagePoint = Schema.Struct({
  ts: Schema.Number,
  requests: Schema.Number,
  errors: Schema.Number,
  prompt_tokens: Schema.Number,
  completion_tokens: Schema.Number,
  cached_tokens: Schema.Number,
  cost: Schema.Number,
  avg_latency_ms: Schema.NullOr(Schema.Number),
  avg_ttft_ms: Schema.NullOr(Schema.Number),
  /** Output tokens per second over the bucket; `null` when nothing in it was measurable. */
  tps: Schema.NullOr(Schema.Number)
})
export type UsagePoint = typeof UsagePoint.Type
