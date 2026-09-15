/**
 * Error taxonomy.
 *
 * Three layers, each with a distinct responsibility:
 *
 * - `ProviderError`  — one upstream attempt failed. Carries the retryability
 *   verdict the executor uses to decide between retrying and failing over.
 * - `RoutingError`   — no usable candidate existed before any upstream call.
 * - `ClientError`    — the caller's request was rejected. Rendered to the client
 *   in OpenAI's error envelope; never retried.
 */
import * as Schema from "effect/Schema"

export const ProviderErrorKind = Schema.Literal(
  /** 401/403 — the provider's credential is bad. Never retried. */
  "auth",
  /** 429 — throttled. Retryable, may carry `Retry-After`. */
  "rate_limit",
  /** 402 / insufficient_quota — the account is out of budget. Retryable elsewhere. */
  "quota",
  /** 404 — model or path missing on this provider. Fail over, do not retry here. */
  "not_found",
  /** 400/422 — the request itself is unacceptable. Retrying anywhere will not help. */
  "invalid_request",
  /** 5xx — provider fault. Retryable. */
  "upstream",
  /** Deadline exceeded. Retryable. */
  "timeout",
  /** DNS/TCP/TLS failure or a malformed response. Retryable. */
  "network",
  /** The client hung up. Not retryable and not the provider's fault. */
  "aborted"
)
export type ProviderErrorKind = typeof ProviderErrorKind.Type

export class ProviderError extends Schema.TaggedError<ProviderError>()("ProviderError", {
  provider_id: Schema.Number,
  provider_name: Schema.String,
  kind: ProviderErrorKind,
  /** HTTP status when there was a response; 0 for transport failures. */
  status: Schema.Number,
  message: Schema.String,
  /** Whether another attempt could plausibly succeed. Derived from `kind`. */
  retryable: Schema.Boolean,
  /** Provider-supplied backoff hint, ms. */
  retry_after_ms: Schema.NullOr(Schema.Number),
  /** Truncated upstream body, for the admin UI and logs. */
  body: Schema.NullOr(Schema.String)
}) {
  /** A short tag for the `error_kind` column and log correlation. */
  get label(): string {
    return this.kind
  }
}

/** Kinds worth a second attempt, either here or on another provider. */
const RETRYABLE: ReadonlySet<ProviderErrorKind> = new Set<ProviderErrorKind>([
  "rate_limit",
  "quota",
  "upstream",
  "timeout",
  "network"
])

export const isRetryable = (kind: ProviderErrorKind): boolean => RETRYABLE.has(kind)

/** Kinds that mean "this provider cannot serve this request" — always fail over. */
const FAILOVER_ONLY: ReadonlySet<ProviderErrorKind> = new Set<ProviderErrorKind>(["not_found", "invalid_request"])

export const isFailoverOnly = (kind: ProviderErrorKind): boolean => FAILOVER_ONLY.has(kind)

export const providerError = (init: {
  provider_id: number
  provider_name: string
  kind: ProviderErrorKind
  status?: number
  message: string
  retry_after_ms?: number | null
  body?: string | null
}): ProviderError =>
  new ProviderError({
    provider_id: init.provider_id,
    provider_name: init.provider_name,
    kind: init.kind,
    status: init.status ?? 0,
    message: init.message,
    retryable: isRetryable(init.kind),
    retry_after_ms: init.retry_after_ms ?? null,
    // Bodies go to the admin UI and the error column; cap them so one verbose
    // upstream cannot bloat the database.
    body:
      init.body === undefined || init.body === null || init.body.length <= 2048
        ? (init.body ?? null)
        : `${init.body.slice(0, 2048)}…`
  })

/** No provider can serve the requested model right now. */
export class RoutingError extends Schema.TaggedError<RoutingError>()("RoutingError", {
  reason: Schema.Literal("unknown_model", "model_disabled", "no_provider", "all_unavailable"),
  message: Schema.String,
  model: Schema.String
}) {}

/**
 * The caller's request was rejected. `status` and `code` map onto the OpenAI
 * error envelope so existing SDKs surface a familiar shape.
 */
export class ClientError extends Schema.TaggedError<ClientError>()("ClientError", {
  status: Schema.Number,
  code: Schema.String,
  message: Schema.String,
  param: Schema.NullOr(Schema.String)
}) {}

export const unauthorized = (message: string): ClientError =>
  new ClientError({ status: 401, code: "invalid_api_key", message, param: null })

export const badRequest = (message: string, param: string | null = null): ClientError =>
  new ClientError({ status: 400, code: "invalid_request_error", message, param })

export const notFound = (message: string, param: string | null = null): ClientError =>
  new ClientError({ status: 404, code: "not_found_error", message, param })

export const forbidden = (message: string): ClientError =>
  new ClientError({ status: 403, code: "permission_denied", message, param: null })

export const rateLimited = (message: string): ClientError =>
  new ClientError({ status: 429, code: "rate_limit_exceeded", message, param: null })
