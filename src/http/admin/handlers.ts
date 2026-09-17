/**
 * Admin group implementation.
 *
 * Every endpoint in the `admin` group of `../api.ts` is implemented here. The
 * handlers are grouped in the `admin` object rather than inlined into the builder
 * chain so they can be invoked directly from tests — the alternative, exercising
 * them through a live server, would test the platform's plumbing more than the
 * handler logic.
 *
 * Two rules apply to the whole group:
 *
 * - A storage failure is reported as `AdminFailure` and never as the raw
 *   `SqlError`, whose message quotes the failing statement together with its bound
 *   parameters (including a provider's API key).
 * - Upstream trouble — discovery, credits, a failed connection test — is *data*,
 *   not an error: it is reported in the result's `error` field so the dashboard can
 *   show it next to the provider it belongs to.
 */
import * as HttpApiBuilder from "@effect/platform/HttpApiBuilder"
import type * as HttpClient from "@effect/platform/HttpClient"
import * as SqlClient from "@effect/sql/SqlClient"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type { ApiKey, ApiKeyCreated, ApiKeyInput, ApiKeyMasked, Provider, ProviderInput, ProviderStatus, Route, RouteInput, RouteTarget, UsagePoint, UsageSummary } from "../../domain.ts"
import { ProviderKind } from "../../domain.ts"
import type * as Chat from "../../canonical.ts"
import { providerError } from "../../errors.ts"
import { getCredits, listCredits } from "../../db/credits.ts"
import { getProviderStatus, listProviderStatuses } from "../../db/health.ts"
import { countKeys, createKey, deleteKey, listKeys, maskKey, updateKey } from "../../db/keys.ts"
import { createProvider, deleteProvider, getProvider, listModels, listModelsForProvider, listProviders, updateProvider } from "../../db/providers.ts"
import { createRoute, deleteRoute, listRoutes, updateRoute } from "../../db/routes.ts"
import { logPage, series, summary } from "../../db/usage.ts"
import { discoverAll as discoverEveryProvider, discoverProvider, refreshCredits, syncRoutes } from "../../gateway/discovery.ts"
import { indexStatus } from "../../models/capabilities.ts"
import { probeProvider } from "../../gateway/executor.ts"
import { Sessions } from "../../gateway/sessions.ts"
import { AppSettings, StartedAt } from "../../gateway/settings.ts"
import type { Completion, Target } from "../../upstream/adapter.ts"
import type { ConfigSnapshot, CreditsResult, DiscoveryResult, Overview, ProviderDetail, TestResult } from "../api.ts"
import { api } from "../api.ts"
import { badRequest, fromStorage, notFound, type AdminFailure } from "./errors.ts"

/** Default history summarised by `/usage` when the query string omits one. */
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000
/** Points per window when the caller does not choose a bucket width. */
const BUCKETS_PER_WINDOW = 48
/** Below a minute a chart bucket holds at most a request or two, so it is never useful. */
const MIN_BUCKET_MS = 60_000
const DEFAULT_LOG_LIMIT = 50
const MAX_LOG_LIMIT = 500
/**
 * Deadline for a connection test.
 *
 * Deliberately much shorter than `request_timeout_ms`: the operator is watching a
 * button that a five-minute gateway timeout would leave spinning.
 */
const TEST_TIMEOUT_MS = 15_000

/**
 * The frozen contract declares numeric path params (`/providers/${Schema.Number}`),
 * which the router produces under the single positional key `0`.
 */
interface NumberPath {
  readonly path: { readonly 0: number }
}
interface ModelPath {
  readonly path: { readonly 0: string }
}

/** Read a positive number from a query string; absent or unparseable falls back. */
const positiveParam = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const integerParam = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback
}

const optionalFilter = (raw: string | undefined): string | null =>
  raw === undefined || raw.trim() === "" ? null : raw

/** Read an optional numeric filter; absent or unparseable means "no filter". */
const optionalNumber = (raw: string | undefined): number | null => {
  const text = optionalFilter(raw)
  if (text === null) return null
  const parsed = Number(text)
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null
}

/**
 * Mask a stored provider secret for the config response.
 *
 * `Provider.api_key` is part of the schema the UI edits, so it cannot simply be
 * omitted — but the dashboard has no use for the value itself. A short key is
 * masked entirely, since a prefix would otherwise reveal it in full.
 */
const maskApiKey = (apiKey: string): string =>
  apiKey === "" ? "" : apiKey.length <= 8 ? "…" : `${apiKey.slice(0, 4)}…`

/**
 * Header names that carry a credential, matched case-insensitively.
 *
 * The same set the adapters treat as authentication (`hasHeader(headers, "authorization")`
 * in `upstream/http.ts`): a provider can be authenticated entirely through a header
 * instead of `api_key`, and masking only `api_key` left those credentials in the response
 * body of every config load, provider create and provider update.
 */
const CREDENTIAL_HEADER = /^(authorization|proxy-authorization|x-api-key|api-key|x-goog-api-key)$/i

/**
 * Mask provider headers for a response.
 *
 * Non-credential headers are returned untouched — they are ordinary configuration the
 * operator needs to see and edit (`anthropic-beta`, trace headers, routing hints).
 */
const maskHeaders = (headers: Record<string, string>): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    out[name] = CREDENTIAL_HEADER.test(name) ? maskApiKey(value) : value
  }
  return out
}

/**
 * Restore masked credentials the caller did not actually change.
 *
 * A masked value is indistinguishable from a real one by shape, so the comparison is
 * against the *stored* provider's mask: only a value that round-tripped unchanged is
 * restored. Anything else — a new secret, or a deliberately cleared one — is left alone.
 */
const unmaskUnchangedHeaders = (
  incoming: Record<string, string>,
  stored: Record<string, string>
): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(incoming)) {
    const current = Object.entries(stored).find(([key]) => key.toLowerCase() === name.toLowerCase())
    out[name] =
      current !== undefined && CREDENTIAL_HEADER.test(name) && value === maskApiKey(current[1])
        ? current[1]
        : value
  }
  return out
}

/** A provider row as the admin API returns it: credentials never leave in the clear. */
const toMaskedProvider = (provider: Provider): Provider => ({
  ...provider,
  api_key: maskApiKey(provider.api_key),
  headers: maskHeaders(provider.headers)
})

const toMaskedKey = (key: ApiKey): ApiKeyMasked => ({
  id: key.id,
  name: key.name,
  masked: maskKey(key.key),
  enabled: key.enabled,
  rate_limit_rpm: key.rate_limit_rpm,
  allowed_models: key.allowed_models,
  created_at: key.created_at,
  last_used_at: key.last_used_at,
  total_requests: key.total_requests
})

/** Public models served by `providerId`, in route order. */
const routedModels = (routes: ReadonlyArray<Route>, providerId: number): ReadonlyArray<string> => {
  const out: string[] = []
  for (const route of routes) {
    if (route.targets.some((target) => target.provider_id === providerId)) out.push(route.public_model)
  }
  return out
}

/** Load a provider or fail with the 404 the endpoint declares. */
const requireProvider = (
  sql: SqlClient.SqlClient,
  id: number
): Effect.Effect<Provider, AdminFailure> =>
  Effect.gen(function* () {
    const found = yield* fromStorage(`loading provider ${id}`, getProvider(sql, id))
    if (Option.isNone(found)) return yield* Effect.fail(notFound(`provider ${id} does not exist`))
    return found.value
  })

/**
 * Reject a provider payload the storage layer would accept but the gateway cannot
 * use.
 *
 * Only fields actually present are checked, because an update is a patch: an absent
 * `base_url` means "keep the stored one", not "must be set".
 */
/**
 * Validate a provider's `base_url` and return the value that should be stored.
 *
 * It returns the value rather than only checking it, so what is stored is exactly what was
 * validated. Previously the field was trimmed for the check and stored untrimmed, so
 * `" https://api.openai.com "` was accepted, reported as healthy, and then failed every
 * request with `InvalidUrl` — an outage caused by a value this API had already passed.
 * `startsWith("http")` also accepted a bare `"http"`, which builds the unusable
 * `http/v1/chat/completions`.
 */
const normaliseBaseUrl = (raw: string): Effect.Effect<string, AdminFailure> => {
  const baseUrl = raw.trim().replace(/\/+$/, "")
  if (!/^https?:\/\/[^\s/]+/.test(baseUrl)) {
    return Effect.fail(
      badRequest('base_url must be an absolute http(s) URL with a host, e.g. "https://api.openai.com"')
    )
  }
  return Effect.succeed(baseUrl)
}

/** Validate the provider kind, which is a closed set. */
const assertProviderKind = (input: Partial<ProviderInput>): Effect.Effect<void, AdminFailure> =>
  input.kind === undefined || Schema.is(ProviderKind)(input.kind)
    ? Effect.void
    : Effect.fail(badRequest(`kind "${input.kind}" is not a known provider kind`))

/**
 * Check that every target names a provider that exists.
 *
 * `route_targets.provider_id` is a foreign key, so an unknown id would otherwise
 * surface as a storage failure — a 500 for what is really a bad request.
 */
const assertTargetsExist = (
  sql: SqlClient.SqlClient,
  targets: ReadonlyArray<RouteTarget>
): Effect.Effect<void, AdminFailure> =>
  Effect.gen(function* () {
    for (const target of targets) {
      const found = yield* fromStorage(
        `checking provider ${target.provider_id}`,
        getProvider(sql, target.provider_id)
      )
      if (Option.isNone(found)) {
        return yield* Effect.fail(
          badRequest(`target names provider ${target.provider_id}, which does not exist`)
        )
      }
    }
  })

/** Assistant text of a probe completion, or `null` when the provider returned none. */
const replyText = (completion: Completion): string | null => {
  const content = completion.response.choices[0]?.message.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    const text = content
      .filter((part): part is Chat.TextPart => part.type === "text")
      .map((part) => part.text)
      .join("")
    return text === "" ? null : text
  }
  return null
}

/**
 * The endpoint implementations, keyed by the endpoint names declared in `api.ts`.
 *
 * Exported so tests can call them as plain functions: the handler contract is
 * ordinary Effect code, and running it directly is what makes the assertions
 * meaningful.
 */
export const admin = {
  /** Dashboard header: how much is configured, and how much of it is healthy. */
  overview: (): Effect.Effect<Overview, AdminFailure, SqlClient.SqlClient | StartedAt | Sessions> =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const startedAt = yield* StartedAt
      const sessions = yield* Sessions

      const providers = yield* fromStorage("loading providers", listProviders(sql))
      const models = yield* fromStorage("loading the model catalogue", listModels(sql))
      const routes = yield* fromStorage("loading routes", listRoutes(sql))
      const keys = yield* fromStorage("counting client keys", countKeys(sql))
      const credits = yield* fromStorage("loading credit snapshots", listCredits(sql))
      // One query rather than a health lookup per provider; a provider without a
      // health row has never failed, so its breaker is closed.
      const statuses = yield* fromStorage("loading provider health", listProviderStatuses(sql))

      const now = Date.now()
      const openIds = new Set(
        statuses.filter((status) => status.open_until > now).map((status) => status.provider_id)
      )
      const enabled = providers.filter((provider) => provider.enabled)

      // Credits only exist for workbuddy2api, so a gateway with none of those
      // reports "unknown" rather than a misleading 0.
      const budgeted = new Set(
        providers.filter((provider) => provider.kind === "workbuddy2api").map((provider) => provider.id)
      )
      const creditsTotal =
        budgeted.size === 0
          ? null
          : credits
              .filter((snapshot) => budgeted.has(snapshot.provider_id))
              .reduce((sum, snapshot) => sum + snapshot.total, 0)

      return {
        providers_total: providers.length,
        providers_enabled: enabled.length,
        providers_open: enabled.filter((provider) => openIds.has(provider.id)).length,
        models: new Set(models.map((model) => model.public_id)).size,
        routes: routes.length,
        keys,
        credits_total: creditsTotal,
        uptime_s: Math.max(0, Math.floor((now - startedAt) / 1000)),
        sessions: sessions.stats()
      }
    }),

  /** Everything the dashboard edits, in one call. */
  config: (): Effect.Effect<ConfigSnapshot, AdminFailure, SqlClient.SqlClient | AppSettings> =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const settings = yield* AppSettings

      const providers = yield* fromStorage("loading providers", listProviders(sql))
      const routes = yield* fromStorage("loading routes", listRoutes(sql))
      const keys = yield* fromStorage("loading client keys", listKeys(sql))

      const details: ProviderDetail[] = []
      for (const provider of providers) {
        const models = yield* fromStorage(
          `loading models for provider ${provider.id}`,
          listModelsForProvider(sql, provider.id)
        )
        const credits = yield* fromStorage(
          `loading credits for provider ${provider.id}`,
          getCredits(sql, provider.id)
        )
        const status: ProviderStatus = yield* fromStorage(
          `loading health for provider ${provider.id}`,
          getProviderStatus(sql, provider.id)
        )
        details.push({
          // The secret is replaced rather than removed: the edit form round-trips
          // `api_key` and renders this value as a "leave untouched to keep" hint.
          provider: toMaskedProvider(provider),
          models,
          credits: Option.getOrNull(credits),
          status,
          routed_models: routedModels(routes, provider.id)
        })
      }

      return {
        providers: details,
        routes,
        keys,
        settings: {
          default_strategy: settings.default_strategy,
          require_client_key: settings.require_client_key,
          request_timeout_ms: settings.request_timeout_ms,
          discovery_interval_s: settings.discovery_interval_s
        },
        capabilities_index: indexStatus()
      }
    }),

  /** Usage rollup plus its bucketed time series, over the requested window. */
  usage: (req: {
    readonly urlParams: { readonly window?: string; readonly bucket?: string }
  }): Effect.Effect<
    { readonly summary: UsageSummary; readonly series: ReadonlyArray<UsagePoint> },
    AdminFailure,
    SqlClient.SqlClient
  > =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const windowMs = positiveParam(req.urlParams.window, DEFAULT_WINDOW_MS)
      const bucketMs = Math.max(
        MIN_BUCKET_MS,
        positiveParam(req.urlParams.bucket, Math.floor(windowMs / BUCKETS_PER_WINDOW))
      )

      const rollup = yield* fromStorage("summarising usage", summary(sql, windowMs))
      const buckets = yield* fromStorage("bucketising usage", series(sql, windowMs, bucketMs))
      return { summary: rollup, series: buckets }
    }),

  /** One page of the request log, plus totals over the whole filtered set. */
  usageLog: (req: {
    readonly urlParams: {
      readonly limit?: string
      readonly offset?: string
      readonly model?: string
      readonly provider_id?: string
      readonly errors_only?: string
    }
  }): Effect.Effect<
    { readonly total: number; readonly rows: ReadonlyArray<Record<string, unknown>>; readonly totals: { readonly requests: number; readonly prompt_tokens: number; readonly completion_tokens: number; readonly cached_tokens: number; readonly cost: number } },
    AdminFailure,
    SqlClient.SqlClient
  > =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const limit = Math.min(MAX_LOG_LIMIT, Math.max(1, integerParam(req.urlParams.limit, DEFAULT_LOG_LIMIT)))
      // Clamped at both ends: SQLite's integer range is the limit, and a value past it
      // reached `OFFSET` and failed the driver with "datatype mismatch" — a 500 for what is
      // a nonsense query parameter. `limit` next to it was already clamped this way.
      const offset = Math.min(
        Number.MAX_SAFE_INTEGER,
        Math.max(0, integerParam(req.urlParams.offset, 0))
      )
      const errorsOnly = req.urlParams.errors_only === "true" || req.urlParams.errors_only === "1"

      return yield* fromStorage("reading the usage log", logPage(sql, {
        limit,
        offset,
        model: optionalFilter(req.urlParams.model),
        providerId: optionalNumber(req.urlParams.provider_id),
        errorsOnly
      }))
    }),

  providerCreate: (req: {
    readonly payload: ProviderInput
  }): Effect.Effect<Provider, AdminFailure, SqlClient.SqlClient> =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* assertProviderKind(req.payload)
      const base_url = yield* normaliseBaseUrl(req.payload.base_url)
      const created = yield* fromStorage(
        "creating provider",
        createProvider(sql, { ...req.payload, base_url })
      )
      // The credential goes in, never back out: a response body ends up in shell
      // history, CI logs and debugging proxies. `/config` already masks it, and the
      // dashboard renders that masked hint rather than this field.
      return toMaskedProvider(created)
    }),

  providerUpdate: (
    req: NumberPath & { readonly payload: Partial<ProviderInput> }
  ): Effect.Effect<Provider, AdminFailure, SqlClient.SqlClient> =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const id = req.path[0]
      yield* assertProviderKind(req.payload)
      const normalised = {
        ...req.payload,
        ...(req.payload.base_url === undefined
          ? {}
          : { base_url: yield* normaliseBaseUrl(req.payload.base_url) })
      }

      // An edit form round-trips every field it was shown, and credentials are shown
      // masked — so an untouched credential arrives back as its own mask. Writing that
      // through would replace a working secret with "sk-a…" and silently break the
      // provider, so a value that is exactly the mask of the *stored* one means
      // "unchanged" and is restored. Anything else — a new secret, or a deliberate
      // clear to "" — is left alone.
      const existing = yield* fromStorage(`loading provider ${id}`, getProvider(sql, id))
      const restoreApiKey =
        Option.isSome(existing) && normalised.api_key === maskApiKey(existing.value.api_key)
      const payload =
        Option.isNone(existing)
          ? normalised
          : {
              ...normalised,
              // Each credential is restored independently: an edit that never touched
              // `headers` must still have its key protected, and vice versa.
              ...(normalised.headers === undefined
                ? {}
                : { headers: unmaskUnchangedHeaders(normalised.headers, existing.value.headers) }),
              ...(restoreApiKey ? { api_key: existing.value.api_key } : {})
            }
      const updated = yield* fromStorage(`updating provider ${id}`, updateProvider(sql, id, payload))
      if (Option.isNone(updated)) return yield* Effect.fail(notFound(`provider ${id} does not exist`))
      return toMaskedProvider(updated.value)
    }),

  providerDelete: (req: NumberPath): Effect.Effect<void, AdminFailure, SqlClient.SqlClient> =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const id = req.path[0]
      const removed = yield* fromStorage(`deleting provider ${id}`, deleteProvider(sql, id))
      if (removed === 0) return yield* Effect.fail(notFound(`provider ${id} does not exist`))
    }),

  providerDiscover: (
    req: NumberPath
  ): Effect.Effect<DiscoveryResult, AdminFailure, SqlClient.SqlClient | HttpClient.HttpClient> =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const provider = yield* requireProvider(sql, req.path[0])
      // Discovery reports an unreachable provider in `error` instead of failing, so
      // one bad upstream never turns into a failed admin action.
      return yield* discoverProvider(provider)
    }),

  providerCredits: (
    req: NumberPath
  ): Effect.Effect<CreditsResult, AdminFailure, SqlClient.SqlClient | HttpClient.HttpClient> =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const provider = yield* requireProvider(sql, req.path[0])
      return yield* refreshCredits(provider)
    }),

  /**
   * Send one trivial completion to a provider.
   *
   * The result is always returned: a provider that rejects the probe (bad key,
   * unknown model, dead socket) is exactly what the operator asked to find out, so
   * an upstream error must not fail the endpoint.
   */
  providerTest: (
    req: NumberPath & { readonly payload: { readonly model?: string } }
  ): Effect.Effect<TestResult, AdminFailure, SqlClient.SqlClient | HttpClient.HttpClient> =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const provider = yield* requireProvider(sql, req.path[0])
      const models = yield* fromStorage(
        `loading models for provider ${provider.id}`,
        listModelsForProvider(sql, provider.id)
      )

      const requested = req.payload.model
      const named = requested === undefined || requested.trim() === "" ? null : requested.trim()
      const first = models[0]
      // The operator may name either the public model or the upstream id; both are
      // accepted because the model table is the only place the mapping exists.
      const match = named === null ? undefined : models.find((model) => model.public_id === named || model.upstream_id === named)
      const upstreamModel = named === null ? first?.upstream_id : (match?.upstream_id ?? named)

      if (upstreamModel === undefined) {
        return {
          ok: false,
          latency_ms: 0,
          model: "",
          reply: null,
          error: "no model to test: this provider has no discovered models and none was requested"
        }
      }

      const publicModel = named ?? first?.public_id ?? upstreamModel
      const target: Target = { provider, upstream_model: upstreamModel }
      const request: Chat.Request = {
        model: upstreamModel,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 16
      }

      const started = Date.now()
      const outcome = yield* probeProvider(target, request).pipe(
        Effect.timeoutFail({
          duration: TEST_TIMEOUT_MS,
          onTimeout: () =>
            providerError({
              provider_id: provider.id,
              provider_name: provider.name,
              kind: "timeout",
              status: 0,
              message: `test timed out after ${TEST_TIMEOUT_MS}ms`
            })
        }),
        Effect.map((completion) => ({ ok: true as const, completion })),
        Effect.catchAll((error) => Effect.succeed({ ok: false as const, error }))
      )
      const latency = Date.now() - started

      if (!outcome.ok) {
        return {
          ok: false,
          latency_ms: latency,
          model: publicModel,
          reply: null,
          error: `${outcome.error.kind}: ${outcome.error.message}`
        }
      }
      return {
        ok: true,
        latency_ms: latency,
        model: publicModel,
        reply: replyText(outcome.completion),
        error: null
      }
    }),

  discoverAll: (): Effect.Effect<
    { readonly results: ReadonlyArray<DiscoveryResult> },
    AdminFailure,
    SqlClient.SqlClient | HttpClient.HttpClient
  > => Effect.map(discoverEveryProvider(), (results) => ({ results })),

  routeCreate: (req: {
    readonly payload: RouteInput
  }): Effect.Effect<Route, AdminFailure, SqlClient.SqlClient> =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* assertTargetsExist(sql, req.payload.targets)
      return yield* fromStorage("creating route", createRoute(sql, req.payload))
    }),

  routeUpdate: (
    req: ModelPath & { readonly payload: Partial<RouteInput> }
  ): Effect.Effect<Route, AdminFailure, SqlClient.SqlClient> =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const publicModel = req.path[0]
      if (req.payload.targets !== undefined) yield* assertTargetsExist(sql, req.payload.targets)
      const updated = yield* fromStorage(
        `updating route ${publicModel}`,
        updateRoute(sql, publicModel, req.payload)
      )
      if (Option.isNone(updated)) {
        return yield* Effect.fail(notFound(`no route for model "${publicModel}"`))
      }
      return updated.value
    }),

  routeDelete: (req: ModelPath): Effect.Effect<void, AdminFailure, SqlClient.SqlClient> =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const publicModel = req.path[0]
      const removed = yield* fromStorage(`deleting route ${publicModel}`, deleteRoute(sql, publicModel))
      if (removed === 0) return yield* Effect.fail(notFound(`no route for model "${publicModel}"`))
    }),

  /** Rebuild the auto-managed routes from the discovered catalogue. */
  routesSync: (): Effect.Effect<
    { readonly created: ReadonlyArray<string>; readonly updated: ReadonlyArray<string>; readonly removed: ReadonlyArray<string> },
    AdminFailure,
    SqlClient.SqlClient | HttpClient.HttpClient
  > => syncRoutes(),

  keyCreate: (req: {
    readonly payload: ApiKeyInput
  }): Effect.Effect<ApiKeyCreated, AdminFailure, SqlClient.SqlClient> =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const created = yield* fromStorage("creating client key", createKey(sql, req.payload))
      // The one place the secret is returned: masking it here would leave the operator
      // with a key they cannot use, since no later read can reveal it.
      return { ...toMaskedKey(created), key: created.key }
    }),

  keyUpdate: (
    req: NumberPath & { readonly payload: Partial<ApiKeyInput> }
  ): Effect.Effect<ApiKeyMasked, AdminFailure, SqlClient.SqlClient> =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const id = req.path[0]
      const updated = yield* fromStorage(`updating client key ${id}`, updateKey(sql, id, req.payload))
      if (Option.isNone(updated)) return yield* Effect.fail(notFound(`client key ${id} does not exist`))
      return toMaskedKey(updated.value)
    }),

  keyDelete: (req: NumberPath): Effect.Effect<void, AdminFailure, SqlClient.SqlClient> =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const id = req.path[0]
      const removed = yield* fromStorage(`deleting client key ${id}`, deleteKey(sql, id))
      if (removed === 0) return yield* Effect.fail(notFound(`client key ${id} does not exist`))
    })
}

export const adminHandlers = HttpApiBuilder.group(api, "admin", (h) =>
  h
    .handle("overview", admin.overview)
    .handle("config", admin.config)
    .handle("usage", admin.usage)
    .handle("usageLog", admin.usageLog)
    .handle("providerCreate", admin.providerCreate)
    .handle("providerUpdate", admin.providerUpdate)
    .handle("providerDelete", admin.providerDelete)
    .handle("providerDiscover", admin.providerDiscover)
    .handle("providerCredits", admin.providerCredits)
    .handle("providerTest", admin.providerTest)
    .handle("discoverAll", admin.discoverAll)
    .handle("routeCreate", admin.routeCreate)
    .handle("routeUpdate", admin.routeUpdate)
    .handle("routeDelete", admin.routeDelete)
    .handle("routesSync", admin.routesSync)
    .handle("keyCreate", admin.keyCreate)
    .handle("keyUpdate", admin.keyUpdate)
    .handle("keyDelete", admin.keyDelete)
)
