/**
 * HTTP surface contract.
 *
 * Declared before any handler is written so the server and the frontend are
 * built against the same shape. Everything lives in one `HttpApi` with two
 * groups:
 *
 *   `v1`    — client-facing, speaks OpenAI (Chat Completions and Responses) plus
 *             the Anthropic Messages API.
 *   `admin` — operator-facing, speaks the gateway's own JSON.
 *
 * Errors use two envelopes. `v1` returns OpenAI's `{error:{message,type,code}}`
 * so existing SDKs surface failures normally, except `/v1/messages`, which returns
 * Anthropic's `{type:"error",error:{type,message}}` because an Anthropic SDK reads
 * that shape; `admin` returns the gateway's own `{error, detail}` because the UI
 * renders it directly.
 */
import * as HttpApi from "@effect/platform/HttpApi"
import * as HttpApiEndpoint from "@effect/platform/HttpApiEndpoint"
import * as HttpApiGroup from "@effect/platform/HttpApiGroup"
import * as HttpApiSchema from "@effect/platform/HttpApiSchema"
import * as Schema from "effect/Schema"
import { ModelCapabilities } from "../models/capabilities.ts"
import { AdminAuth } from "./admin/auth.ts"
import { AdminUnauthorized } from "./admin/errors.ts"
import { ApiKeyCreated, ApiKeyInput, ApiKeyMasked, Credits, Provider, ProviderInput, ProviderStatus, Route, RouteInput, UsageAggregate, UsagePoint, UsageSummary } from "../domain.ts"
import { DiscoveredModel } from "../domain.ts"

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

/** Raw JSON body. Gateway payloads are passed through largely untouched, and the
 *  precise accepted fields differ per protocol, so validation happens in the
 *  handler where a protocol-specific error message can be produced. */
const UnknownBody = Schema.Record({ key: Schema.String, value: Schema.Unknown })

export const ErrorEnvelope = Schema.Struct({
  error: Schema.Struct({
    message: Schema.String,
    type: Schema.String,
    code: Schema.NullOr(Schema.String)
  })
})
export type ErrorEnvelope = typeof ErrorEnvelope.Type

/**
 * Admin failures use the gateway's own flat envelope, because the dashboard renders
 * it verbatim.
 *
 * Two details are load-bearing, both learned the hard way. `HttpApiBuilder` collects
 * a group's error schemas into a union, encodes a failure with the first member that
 * fits, and derives the HTTP status from that member's annotation:
 *
 * 1. The `status` field is a literal discriminator. Without it the four schemas are
 *    structurally identical, so the union cannot tell them apart and every failure is
 *    encoded as — and therefore returned with the status of — whichever member came
 *    first.
 * 2. Each schema carries `AnnotationStatus`, which is what actually sets the response
 *    status code. Declaring `{status}` on `addError` alone does not propagate to the
 *    encoder.
 */
const adminError = <const S extends 400 | 401 | 404 | 500>(status: S) =>
  Schema.Struct({
    status: Schema.Literal(status),
    error: Schema.String,
    detail: Schema.optional(Schema.String)
  }).annotations({
    identifier: `AdminError${status}`,
    [HttpApiSchema.AnnotationStatus]: status
  })

export const AdminBadRequest = adminError(400)
/**
 * Shared with the auth middleware, which is why it comes from `admin/errors.ts` rather
 * than being built by the `adminError` factory below: the middleware's declared failure
 * and the group's declared 401 have to be one and the same schema for the encoder to
 * find a member of its union that fits.
 */
export { AdminUnauthorized }
export const AdminNotFound = adminError(404)
export const AdminServerError = adminError(500)

/** Union of every admin failure shape, for handlers that type their error channel. */
export const AdminError = Schema.Union(AdminBadRequest, AdminUnauthorized, AdminNotFound, AdminServerError)
export type AdminError = typeof AdminError.Type

/** `/v1/models` entry, in OpenAI's list shape. */
export const ModelCard = Schema.Struct({
  id: Schema.String,
  object: Schema.Literal("model"),
  created: Schema.Number,
  owned_by: Schema.String,
  display_name: Schema.optional(Schema.NullOr(Schema.String)),
  /** Populated from discovery when a provider reported it. */
  context_length: Schema.optional(Schema.NullOr(Schema.Number)),
  max_output_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
  /**
   * What the model accepts and emits.
   *
   * `null` — not `false` — when nothing could be established, so a client can tell
   * "unknown" from "cannot accept images". `supports_images` is kept alongside as the
   * derived OpenAI-style boolean, because clients written before this field existed
   * still read it.
   */
  capabilities: Schema.optional(Schema.NullOr(ModelCapabilities)),
  supports_images: Schema.optional(Schema.Boolean),
  /** Every provider that can serve this model, for operator visibility. */
  providers: Schema.optional(Schema.Array(Schema.String))
})
export type ModelCard = typeof ModelCard.Type

// ---------------------------------------------------------------------------
// Admin payloads
// ---------------------------------------------------------------------------

/** Everything the dashboard needs for one provider, in a single response. */
export const ProviderDetail = Schema.Struct({
  provider: Provider,
  models: Schema.Array(DiscoveredModel),
  credits: Schema.NullOr(Credits),
  status: ProviderStatus,
  /** Provider id → public model ids it serves, derived from routes. */
  routed_models: Schema.Array(Schema.String)
})
export type ProviderDetail = typeof ProviderDetail.Type

/** The full configuration the UI edits, fetched in one call. */
export const ConfigSnapshot = Schema.Struct({
  providers: Schema.Array(ProviderDetail),
  routes: Schema.Array(Route),
  keys: Schema.Array(ApiKeyMasked),
  /** Read-only server settings, so the UI can show which config file shape is live. */
  settings: Schema.Struct({
    default_strategy: Schema.Literal("priority", "weighted"),
    require_client_key: Schema.Boolean,
    request_timeout_ms: Schema.Number,
    discovery_interval_s: Schema.Number
  }),
  /**
   * Whether the models.dev capability catalogue is loaded.
   *
   * Surfaced because its absence is otherwise invisible: a gateway that cannot reach
   * models.dev reports `capabilities: null` for every model whose provider does not
   * describe itself, which looks exactly like "these models genuinely have no
   * capabilities". Without this an operator has no way to tell the two apart.
   */
  capabilities_index: Schema.Struct({
    loaded: Schema.Boolean,
    models: Schema.Number,
    age_ms: Schema.NullOr(Schema.Number),
    error: Schema.NullOr(Schema.String)
  })
})
export type ConfigSnapshot = typeof ConfigSnapshot.Type

/** Discovery result after a manual refresh, for the UI's toast. */
export const DiscoveryResult = Schema.Struct({
  provider_id: Schema.Number,
  models: Schema.Array(DiscoveredModel),
  created: Schema.Array(Schema.String),
  removed: Schema.Array(Schema.String),
  error: Schema.NullOr(Schema.String)
})
export type DiscoveryResult = typeof DiscoveryResult.Type

/** Result of asking a provider for its credits. */
export const CreditsResult = Schema.Struct({
  provider_id: Schema.Number,
  credits: Schema.NullOr(Credits),
  error: Schema.NullOr(Schema.String)
})
export type CreditsResult = typeof CreditsResult.Type

/** One provider test-connection result. */
export const TestResult = Schema.Struct({
  ok: Schema.Boolean,
  latency_ms: Schema.Number,
  model: Schema.String,
  reply: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String)
})
export type TestResult = typeof TestResult.Type

/** Health summary used by the dashboard header. */
export const Overview = Schema.Struct({
  providers_total: Schema.Number,
  providers_enabled: Schema.Number,
  providers_open: Schema.Number,
  models: Schema.Number,
  routes: Schema.Number,
  keys: Schema.Number,
  credits_total: Schema.NullOr(Schema.Number),
  uptime_s: Schema.Number,
  /**
   * Cache-affinity effectiveness. `hits / lookups` is the share of requests that were
   * able to reuse a previously chosen provider, which is the number that says whether
   * affinity is earning its cache hits.
   */
  sessions: Schema.Struct({
    tracked: Schema.Number,
    lookups: Schema.Number,
    hits: Schema.Number,
    misses: Schema.Number
  })
})
export type Overview = typeof Overview.Type

// ---------------------------------------------------------------------------
// Client-facing group
// ---------------------------------------------------------------------------

const v1 = HttpApiGroup.make("v1")
  .add(
    HttpApiEndpoint.post("chatCompletions")`/v1/chat/completions`
      .setPayload(UnknownBody)
      // No success schema: the handler returns an `HttpServerResponse` itself so it
      // can choose between a buffered JSON body and a streaming SSE body.
      .addError(ErrorEnvelope, { status: 400 })
      .addError(ErrorEnvelope, { status: 401 })
      .addError(ErrorEnvelope, { status: 403 })
      .addError(ErrorEnvelope, { status: 404 })
      .addError(ErrorEnvelope, { status: 429 })
      .addError(ErrorEnvelope, { status: 502 })
      .addError(ErrorEnvelope, { status: 503 })
  )
  .add(
    HttpApiEndpoint.post("responses")`/v1/responses`
      .setPayload(UnknownBody)
      // No success schema: the handler returns an `HttpServerResponse` itself so it
      // can choose between a buffered JSON body and a streaming SSE body.
      .addError(ErrorEnvelope, { status: 400 })
      .addError(ErrorEnvelope, { status: 401 })
      .addError(ErrorEnvelope, { status: 403 })
      .addError(ErrorEnvelope, { status: 404 })
      .addError(ErrorEnvelope, { status: 429 })
      .addError(ErrorEnvelope, { status: 502 })
      .addError(ErrorEnvelope, { status: 503 })
  )
  .add(
    HttpApiEndpoint.get("models")`/v1/models`
      .addSuccess(Schema.Struct({ object: Schema.Literal("list"), data: Schema.Array(ModelCard) }))
      .addError(ErrorEnvelope, { status: 401 })
      .addError(ErrorEnvelope, { status: 403 })
      .addError(ErrorEnvelope, { status: 429 })
  )
  .add(
    HttpApiEndpoint.get("model")`/v1/models/${Schema.String}`
      .addSuccess(ModelCard)
      .addError(ErrorEnvelope, { status: 401 })
      .addError(ErrorEnvelope, { status: 403 })
      .addError(ErrorEnvelope, { status: 404 })
      .addError(ErrorEnvelope, { status: 429 })
  )

// ---------------------------------------------------------------------------
// Anthropic group
// ---------------------------------------------------------------------------

/**
 * Anthropic's `ModelInfo`, which is a different shape from OpenAI's `Model` under the
 * same path — `type` rather than `object`, `created_at` as an RFC 3339 string rather
 * than a Unix `created`, and `max_input_tokens` rather than `context_length`. The
 * Anthropic SDKs parse exactly this, so serving them the OpenAI object leaves
 * `display_name` and the token limits undefined.
 */
/**
 * Anthropic's error envelope.
 *
 * Unlike OpenAI's, it carries no `code` and no nested `param`: the error *type* is the
 * machine-readable part, and a message. Declared here so the contract describes what
 * the handlers emit rather than only the success shape.
 */
export const AnthropicErrorEnvelope = Schema.Struct({
  type: Schema.Literal("error"),
  error: Schema.Struct({
    type: Schema.String,
    message: Schema.String
  })
})
export type AnthropicErrorEnvelope = typeof AnthropicErrorEnvelope.Type

export const AnthropicModelInfo = Schema.Struct({
  type: Schema.Literal("model"),
  id: Schema.String,
  display_name: Schema.String,
  created_at: Schema.String,
  /** Anthropic's own field; the SDKs surface it to callers. */
  capabilities: Schema.NullOr(ModelCapabilities),
  max_input_tokens: Schema.NullOr(Schema.Number),
  max_tokens: Schema.NullOr(Schema.Number)
})
export type AnthropicModelInfo = typeof AnthropicModelInfo.Type

/**
 * Anthropic's list envelope. `first_id`, `last_id` and `has_more` are not optional:
 * the SDKs read them to populate their pagination cursors, and a missing key is
 * undefined rather than an empty page.
 */
export const AnthropicModelList = Schema.Struct({
  data: Schema.Array(AnthropicModelInfo),
  first_id: Schema.NullOr(Schema.String),
  last_id: Schema.NullOr(Schema.String),
  has_more: Schema.Boolean
})

/**
 * The Anthropic surface.
 *
 * Mounted under `/anthropic` rather than alongside the OpenAI paths. Both protocols
 * define `GET /v1/models` with the same path and incompatible bodies, so a single
 * mount point cannot answer both — and `<host>/anthropic` is the base URL the
 * Anthropic SDKs are configured with, so `base_url` plus the SDK's own `/v1/...`
 * produces exactly these paths.
 */
const anthropic = HttpApiGroup.make("anthropic")
  .add(
    HttpApiEndpoint.post("messages")`/anthropic/v1/messages`
      .setPayload(UnknownBody)
      // No success schema: the handler returns an `HttpServerResponse` itself so it
      // can choose between a buffered JSON body and a streaming SSE body.
      .addError(AnthropicErrorEnvelope, { status: 400 })
      .addError(AnthropicErrorEnvelope, { status: 401 })
      .addError(AnthropicErrorEnvelope, { status: 403 })
      .addError(AnthropicErrorEnvelope, { status: 404 })
      .addError(AnthropicErrorEnvelope, { status: 429 })
      .addError(AnthropicErrorEnvelope, { status: 502 })
      .addError(AnthropicErrorEnvelope, { status: 503 })
  )
  .add(
    HttpApiEndpoint.get("models")`/anthropic/v1/models`
      .addSuccess(AnthropicModelList)
      .addError(AnthropicErrorEnvelope, { status: 401 })
      .addError(AnthropicErrorEnvelope, { status: 403 })
      .addError(AnthropicErrorEnvelope, { status: 429 })
  )
  .add(
    HttpApiEndpoint.get("model")`/anthropic/v1/models/${Schema.String}`
      .addSuccess(AnthropicModelInfo)
      .addError(AnthropicErrorEnvelope, { status: 401 })
      .addError(AnthropicErrorEnvelope, { status: 403 })
      .addError(AnthropicErrorEnvelope, { status: 404 })
      .addError(AnthropicErrorEnvelope, { status: 429 })
  )

// ---------------------------------------------------------------------------
// Ops group
// ---------------------------------------------------------------------------

/**
 * Liveness/readiness report.
 *
 * Unauthenticated by design: orchestrators, load balancers and Docker's
 * `HEALTHCHECK` cannot carry a bearer token. It therefore exposes counts only —
 * never provider names, URLs or keys — and is safe to leave open.
 */
export const HealthReport = Schema.Struct({
  status: Schema.Literal("ok", "degraded"),
  providers_total: Schema.Number,
  providers_enabled: Schema.Number,
  routes: Schema.Number,
  /** Why the gateway is degraded, for a human reading a failed probe. */
  detail: Schema.optional(Schema.String)
})
export type HealthReport = typeof HealthReport.Type

const ops = HttpApiGroup.make("ops").add(
  HttpApiEndpoint.get("healthz")`/healthz`
    .addSuccess(HealthReport)
    .addError(HealthReport, { status: 503 })
)

// ---------------------------------------------------------------------------
// Admin group
// ---------------------------------------------------------------------------

/**
 * Admin failures are declared on the group rather than per endpoint.
 *
 * `HttpApiGroup.addError` propagates the schema to every endpoint in the group, which
 * is what makes each endpoint's error channel the full union rather than whichever
 * single status a per-endpoint declaration named. Declaring them individually also
 * meant a handler returning a 404 failure could not typecheck against an endpoint that
 * had only declared 401.
 */
const admin = HttpApiGroup.make("admin")
  // Authentication rides the group, so the router's own matching decides what is
  // guarded. A path-prefix check in middleware could be bypassed with casing or
  // duplicate slashes that the router normalises but a prefix comparison does not.
  .middleware(AdminAuth)
  .addError(AdminBadRequest, { status: 400 })
  .addError(AdminUnauthorized, { status: 401 })
  .addError(AdminNotFound, { status: 404 })
  .addError(AdminServerError, { status: 500 })
  .add(
    HttpApiEndpoint.get("overview")`/admin/api/overview`
      .addSuccess(Overview)
  )
  .add(
    HttpApiEndpoint.get("config")`/admin/api/config`
      .addSuccess(ConfigSnapshot)
  )
  .add(
    HttpApiEndpoint.get("usage")`/admin/api/usage`
      .setUrlParams(
        Schema.Struct({
          /** Milliseconds of history to summarise, ending now. */
          window: Schema.optional(Schema.String),
          /** Inclusive range bounds in epoch ms; both must be present to take effect. */
          from: Schema.optional(Schema.String),
          to: Schema.optional(Schema.String),
          /** Bucket width in milliseconds for the time series. */
          bucket: Schema.optional(Schema.String)
        })
      )
      .addSuccess(
        Schema.Struct({
          summary: UsageSummary,
          series: Schema.Array(UsagePoint)
        })
      )
  )
  .add(
    /**
     * A coarse request histogram over the whole retained history.
     *
     * The chart's range selector needs to show what there is to select *before* a range
     * is chosen, so this deliberately ignores any range: it is the overview the brush
     * slides over. Returned at a fixed resolution rather than the viewer's bucket width,
     * because it is a shape to aim at, not a chart to read.
     */
    HttpApiEndpoint.get("usageOverview")`/admin/api/usage/overview`
      .setUrlParams(
        Schema.Struct({
          /** History to cover in milliseconds. */
          window: Schema.optional(Schema.String),
          /** Number of points to reduce it to. */
          points: Schema.optional(Schema.String)
        })
      )
      .addSuccess(
        Schema.Struct({
          from: Schema.Number,
          to: Schema.Number,
          series: Schema.Array(UsagePoint)
        })
      )
  )
  .add(
    HttpApiEndpoint.get("usageLog")`/admin/api/usage/log`
      .setUrlParams(
        Schema.Struct({
          limit: Schema.optional(Schema.String),
          offset: Schema.optional(Schema.String),
          model: Schema.optional(Schema.String),
          provider_id: Schema.optional(Schema.String),
          errors_only: Schema.optional(Schema.String)
        })
      )
      .addSuccess(
        Schema.Struct({
          total: Schema.Number,
          rows: Schema.Array(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
          /** Per-column aggregates over the whole filtered set, not just the page. */
          totals: Schema.Struct({
            requests: Schema.Number,
            prompt_tokens: Schema.Number,
            completion_tokens: Schema.Number,
            cached_tokens: Schema.Number,
            cost: Schema.Number
          })
        })
      )
  )
  .add(
    HttpApiEndpoint.post("providerCreate")`/admin/api/providers`
      .setPayload(ProviderInput)
      .addSuccess(Provider)
  )
  .add(
    HttpApiEndpoint.put("providerUpdate")`/admin/api/providers/${Schema.NumberFromString}`
      .setPayload(Schema.partial(ProviderInput))
      .addSuccess(Provider)
  )
  .add(
    HttpApiEndpoint.del("providerDelete")`/admin/api/providers/${Schema.NumberFromString}`
      .addSuccess(HttpApiSchema.Empty(204))
  )
  .add(
    HttpApiEndpoint.post("providerDiscover")`/admin/api/providers/${Schema.NumberFromString}/discover`
      .addSuccess(DiscoveryResult)
  )
  .add(
    HttpApiEndpoint.post("providerCredits")`/admin/api/providers/${Schema.NumberFromString}/credits`
      .addSuccess(CreditsResult)
  )
  .add(
    HttpApiEndpoint.post("providerTest")`/admin/api/providers/${Schema.NumberFromString}/test`
      .setPayload(Schema.Struct({ model: Schema.optional(Schema.String) }))
      .addSuccess(TestResult)
  )
  .add(
    HttpApiEndpoint.post("discoverAll")`/admin/api/discover`
      .addSuccess(Schema.Struct({ results: Schema.Array(DiscoveryResult) }))
  )
  .add(
    HttpApiEndpoint.post("routeCreate")`/admin/api/routes`
      .setPayload(RouteInput)
      .addSuccess(Route)
  )
  .add(
    HttpApiEndpoint.put("routeUpdate")`/admin/api/routes/${Schema.String}`
      .setPayload(Schema.partial(RouteInput))
      .addSuccess(Route)
  )
  .add(
    HttpApiEndpoint.del("routeDelete")`/admin/api/routes/${Schema.String}`
      .addSuccess(HttpApiSchema.Empty(204))
  )
  .add(
    HttpApiEndpoint.post("routesSync")`/admin/api/routes/sync`
      .addSuccess(
        Schema.Struct({
          created: Schema.Array(Schema.String),
          updated: Schema.Array(Schema.String),
          removed: Schema.Array(Schema.String)
        })
      )
  )
  .add(
    HttpApiEndpoint.post("keyCreate")`/admin/api/keys`
      .setPayload(ApiKeyInput)
      // Creation is the only endpoint that returns the secret, so the operator can copy
      // it once. Every other read masks it.
      .addSuccess(ApiKeyCreated)
  )
  .add(
    HttpApiEndpoint.put("keyUpdate")`/admin/api/keys/${Schema.NumberFromString}`
      .setPayload(Schema.partial(ApiKeyInput))
      .addSuccess(ApiKeyMasked)
  )
  .add(
    HttpApiEndpoint.del("keyDelete")`/admin/api/keys/${Schema.NumberFromString}`
      .addSuccess(HttpApiSchema.Empty(204))
  )

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export const api = HttpApi.make("agg2api").add(v1).add(anthropic).add(ops).add(admin)

/** Aggregates visible in the usage summary. */
export const UsageBreakdown = Schema.Literal("model", "provider", "key")
export type UsageBreakdown = typeof UsageBreakdown.Type

export { UsageAggregate, UsagePoint, UsageSummary }
