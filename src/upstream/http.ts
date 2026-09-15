/**
 * Shared HTTP plumbing for adapters.
 *
 * Every adapter talks to its provider through these helpers so that error
 * classification, header handling and timeouts behave identically across
 * protocols. Getting the classification wrong is what makes a gateway flap — a
 * 400 misfiled as retryable burns every provider before failing, and a 429
 * misfiled as fatal takes a healthy provider out of rotation — so it lives in
 * exactly one place.
 */
import * as HttpClient from "@effect/platform/HttpClient"
import type * as HttpClientResponse from "@effect/platform/HttpClientResponse"
import * as HttpClientRequest from "@effect/platform/HttpClientRequest"
import * as Effect from "effect/Effect"
import type { Provider, ProviderKind } from "../domain.ts"
import { providerError, type ProviderError, type ProviderErrorKind } from "../errors.ts"

/** Join a provider base URL with a path, tolerating either side's slashes. */
export const url = (base: string, path: string): string =>
  `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`

/**
 * Build a POST request carrying `body` as JSON.
 *
 * Provider `headers` are applied first so an operator can override anything the
 * gateway sets, then `Authorization` is applied — unless the operator already
 * supplied one, which is how a provider that wants a custom auth scheme (or no
 * auth at all, on a local runtime) is expressed.
 */
export const postJson = (
  provider: Provider,
  path: string,
  body: unknown,
  extra?: Record<string, string>
): HttpClientRequest.HttpClientRequest => {
  const base = HttpClientRequest.post(url(provider.base_url, path), {
    headers: { "content-type": "application/json", accept: "application/json" }
  }).pipe(HttpClientRequest.bodyText(JSON.stringify(body), "application/json"))
  const withProvider = HttpClientRequest.setHeaders(base, provider.headers)
  const withExtra = extra === undefined ? withProvider : HttpClientRequest.setHeaders(withProvider, extra)
  if (hasHeader(provider.headers, "authorization") || provider.api_key === "") return withExtra
  return HttpClientRequest.setHeader(withExtra, "authorization", `Bearer ${provider.api_key}`)
}

const hasHeader = (headers: Record<string, string>, name: string): boolean =>
  Object.keys(headers).some((key) => key.toLowerCase() === name)

/**
 * Classify an HTTP status into the provider-error taxonomy.
 *
 * 404 is deliberately `not_found` rather than `upstream`: on an aggregator it
 * almost always means "this provider does not host this model", which is a
 * failover signal, not a provider outage worth tripping the breaker for.
 */
export const classifyStatus = (status: number): ProviderErrorKind => {
  if (status === 401 || status === 403) return "auth"
  if (status === 402) return "quota"
  if (status === 404) return "not_found"
  if (status === 408) return "timeout"
  if (status === 429) return "rate_limit"
  if (status === 400 || status === 422 || status === 413) return "invalid_request"
  if (status >= 500) return "upstream"
  return "upstream"
}

/** Parse a `Retry-After` header (delta-seconds or HTTP-date) into milliseconds. */
export const retryAfterMs = (value: string | undefined): number | null => {
  if (value === undefined || value.trim() === "") return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const date = Date.parse(value)
  if (Number.isNaN(date)) return null
  return Math.max(0, date - Date.now())
}

/** Pull a human-readable message out of an OpenAI-shaped error body. */
export const errorMessageFrom = (body: string, fallback: string): string => {
  if (body.trim() === "") return fallback
  try {
    const parsed: unknown = JSON.parse(body)
    if (parsed !== null && typeof parsed === "object") {
      const record = parsed as { error?: unknown; message?: unknown; msg?: unknown }
      const error = record.error
      if (typeof error === "string") return error
      if (error !== null && typeof error === "object") {
        const inner = error as { message?: unknown }
        if (typeof inner.message === "string" && inner.message !== "") return inner.message
      }
      if (typeof record.message === "string" && record.message !== "") return record.message
      // Many Chinese providers answer `{"msg": "..."}` instead.
      if (typeof record.msg === "string" && record.msg !== "") return record.msg
    }
  } catch {
    // Not JSON — fall through to a trimmed raw body.
  }
  return body.length > 500 ? `${body.slice(0, 500)}…` : body
}

/**
 * Turn a transport-level failure into a `ProviderError`.
 *
 * Everything reaching here is a connectivity problem rather than an HTTP status,
 * so it is retryable; the two exceptions are an aborted fiber (client hung up)
 * and a timeout, which are distinguished so the executor can tell "the caller
 * left" from "the provider stalled".
 */
export const transportFailure = (provider: Provider, cause: unknown): ProviderError => {
  const message = cause instanceof Error ? cause.message : String(cause)
  const name = cause instanceof Error ? cause.name : ""
  const kind: ProviderErrorKind =
    name === "TimeoutError" || /timeout|timed out|deadline/i.test(message) ? "timeout" : "network"
  return providerError({
    provider_id: provider.id,
    provider_name: provider.name,
    kind,
    status: 0,
    message
  })
}

/**
 * Run an upstream HTTP call, mapping both transport failures and non-2xx
 * statuses onto `ProviderError`.
 *
 * A successful response is returned untouched — including for statuses the
 * caller may want to inspect, which is why the status check is explicit rather
 * than `filterStatusOk`.
 */
export const execute = (
  provider: Provider,
  request: HttpClientRequest.HttpClientRequest
): Effect.Effect<HttpClientResponse.HttpClientResponse, ProviderError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const response = yield* client.execute(request).pipe(
      Effect.catchAll((cause) => Effect.fail(transportFailure(provider, cause)))
    )
    if (response.status >= 200 && response.status < 300) return response

    const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
    const kind = classifyStatus(response.status)
    return yield* Effect.fail(
      providerError({
        provider_id: provider.id,
        provider_name: provider.name,
        kind,
        status: response.status,
        message: errorMessageFrom(body, `upstream responded ${response.status}`),
        retry_after_ms: retryAfterMs(response.headers["retry-after"]),
        body
      })
    )
  })

/** Read a response body as JSON, reporting malformed payloads as provider faults. */
export const decodeJson = (provider: Provider, body: string): Effect.Effect<unknown, ProviderError> =>
  Effect.try({
    try: (): unknown => JSON.parse(body),
    catch: (cause) =>
      providerError({
        provider_id: provider.id,
        provider_name: provider.name,
        kind: "upstream",
        status: 200,
        message: `malformed JSON from upstream: ${cause instanceof Error ? cause.message : String(cause)}`,
        body
      })
  })

/** Header map used for every adapter's outbound request, for log correlation. */
export const correlationHeaders = (requestId: string): Record<string, string> => ({
  "x-request-id": requestId
})

export const KIND_PATHS: Record<ProviderKind, string> = {
  "openai-chat": "/v1/chat/completions",
  "openai-responses": "/v1/responses",
  // workbuddy2api is OpenAI-compatible and mounts the same route.
  workbuddy2api: "/v1/chat/completions"
}
