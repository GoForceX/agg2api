/**
 * Wire shapes of the admin JSON API. Kept hand-written rather than generated so
 * the client fails loudly at the boundary (see `toLogRow`) instead of silently
 * rendering `undefined`.
 */

export type ProviderKind = "openai-chat" | "openai-responses" | "workbuddy2api"
export type RoutingStrategy = "priority" | "weighted"
export type StringMap = Record<string, string>

export type Provider = {
  id: number
  name: string
  kind: ProviderKind
  base_url: string
  /** Masked on read; write-only. */
  api_key: string
  headers: StringMap
  priority: number
  enabled: boolean
  model_rename: StringMap
  model_allow: string[]
  model_deny: string[]
  input_price: number | null
  output_price: number | null
  currency: string
  max_retries: number
  created_at: number
  updated_at: number
}

export type ProviderInput = {
  name: string
  kind: ProviderKind
  base_url: string
  api_key?: string
  headers?: StringMap
  priority?: number
  enabled?: boolean
  model_rename?: StringMap
  model_allow?: string[]
  model_deny?: string[]
  input_price?: number | null
  output_price?: number | null
  currency?: string
  max_retries?: number
}

export type ModelCapabilities = {
  input: string[]
  output: string[]
  tool_call: boolean | null
  reasoning: boolean | null
  structured_output: boolean | null
  attachment: boolean | null
  /** Which tier answered: the provider itself, or a models.dev lookup. */
  source: "upstream" | "models.dev" | "models.dev-nearest"
}

export type DiscoveredModel = {
  provider_id: number
  upstream_id: string
  public_id: string
  context_length: number | null
  max_output_tokens: number | null
  /** `null` means unknown, which is not the same as "text only". */
  capabilities: ModelCapabilities | null
  owned_by: string | null
  last_seen: number
}

export type CreditsAccount = {
  uid: string
  nickname?: string
  realm?: string
  credits: number
  cooling?: boolean
  disabled?: boolean
  disabled_reason?: string
}

export type Credits = {
  provider_id: number
  total: number
  healthy: number
  accounts: CreditsAccount[]
  fetched_at: number
  error: string | null
}

export type ProviderStatus = {
  provider_id: number
  consecutive_failures: number
  /** Epoch ms the breaker stays open until; 0 = healthy. */
  open_until: number
  last_error: string | null
  last_error_at: number
  last_success_at: number
  last_latency_ms: number
}

export type ProviderDetail = {
  provider: Provider
  models: DiscoveredModel[]
  credits: Credits | null
  status: ProviderStatus
  routed_models: string[]
}

export type RouteTarget = {
  provider_id: number
  upstream_model: string
  priority: number
  enabled: boolean
}

export type Route = {
  public_model: string
  strategy: RoutingStrategy | null
  enabled: boolean
  display_name: string | null
  targets: RouteTarget[]
  created_at: number
  updated_at: number
}

export type RouteInput = {
  public_model: string
  strategy?: RoutingStrategy | null
  enabled?: boolean
  display_name?: string | null
  targets: RouteTarget[]
}

export type ApiKeyMasked = {
  id: number
  name: string
  masked: string
  enabled: boolean
  rate_limit_rpm: number
  allowed_models: string[]
  created_at: number
  last_used_at: number
  total_requests: number
}

export type ApiKeyInput = {
  name: string
  key?: string
  enabled?: boolean
  rate_limit_rpm?: number
  allowed_models?: string[]
}

/** Creation is the only response allowed to carry the secret itself. */
export type ApiKeyCreated = ApiKeyMasked & { key?: string }

export type Settings = {
  default_strategy: RoutingStrategy
  require_client_key: boolean
  request_timeout_ms: number
  discovery_interval_s: number
}

export type AdminConfig = {
  providers: ProviderDetail[]
  routes: Route[]
  keys: ApiKeyMasked[]
  settings: Settings
  /** Whether models.dev is loaded; its absence is why capabilities can be null. */
  capabilities_index: {
    loaded: boolean
    models: number
    age_ms: number | null
    error: string | null
  }
}

export type Overview = {
  providers_total: number
  providers_enabled: number
  providers_open: number
  models: number
  routes: number
  keys: number
  credits_total: number
  uptime_s: number
  /** Cache-affinity effectiveness: `hits / lookups` is the share of requests that
   *  reused a previously chosen provider. */
  sessions: {
    tracked: number
    lookups: number
    hits: number
    misses: number
  }
}

export type UsageAggregate = {
  key: string
  requests: number
  errors: number
  prompt_tokens: number
  completion_tokens: number
  cached_tokens: number
  reasoning_tokens: number
  cost: number
  avg_latency_ms: number
  avg_ttft_ms: number
}

export type UsageSummary = {
  window_ms: number
  requests: number
  errors: number
  prompt_tokens: number
  completion_tokens: number
  cached_tokens: number
  reasoning_tokens: number
  cost: number
  cache_rate: number | null
  avg_latency_ms: number | null
  avg_ttft_ms: number | null
  by_model: UsageAggregate[]
  by_provider: UsageAggregate[]
  by_key: UsageAggregate[]
}

export type UsagePoint = {
  ts: number
  requests: number
  errors: number
  prompt_tokens: number
  completion_tokens: number
  cached_tokens: number
  cost: number
}

export type UsageResponse = {
  summary: UsageSummary
  series: UsagePoint[]
}

export type UsageTotals = {
  requests: number
  prompt_tokens: number
  completion_tokens: number
  cached_tokens: number
  cost: number
}

/** `rows` arrive as opaque records; `toLogRow` narrows them once. */
export type UsageLogResponse = {
  total: number
  rows: Record<string, unknown>[]
  totals: UsageTotals
}

export type UsageLogRow = {
  request_id: string
  ts: number
  endpoint: string
  stream: boolean
  public_model: string
  provider_name: string | null
  provider_kind: string | null
  prompt_tokens: number
  completion_tokens: number
  cached_tokens: number
  cost: number
  attempts: number
  status: number
  error_kind: string | null
  error_message: string | null
  latency_ms: number
  ttft_ms: number
  api_key_name: string | null
}

export type DiscoveryResult = {
  provider_id: number
  models: DiscoveredModel[]
  created: string[]
  removed: string[]
  error: string | null
}

export type CreditsResult = {
  provider_id: number
  credits: Credits | null
  error: string | null
}

export type ProviderTestResult = {
  ok: boolean
  latency_ms: number
  model: string
  reply: string
  error: string | null
}

export type RouteSyncResult = {
  created: string[]
  updated: string[]
  removed: string[]
}
