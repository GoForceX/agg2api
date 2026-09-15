/**
 * OpenAI Chat Completions adapters.
 *
 * `openai-chat` and `workbuddy2api` are the same protocol on the wire — the latter
 * is a reverse proxy in front of the former's routes — so one factory produces
 * both and the kinds differ only in discovery extras and credits.
 *
 * The gateway's failover contract decides the shape of `stream`: the HTTP call is
 * issued *before* the returned effect succeeds. A provider that rejects the
 * request therefore fails here, while the gateway has still written nothing to the
 * client, which is what makes trying the next candidate safe.
 */
import * as HttpClient from "@effect/platform/HttpClient"
import * as HttpClientRequest from "@effect/platform/HttpClientRequest"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import type * as Chat from "../canonical.ts"
import type { Provider } from "../domain.ts"
import type { ProviderError } from "../errors.ts"
import { asBoolean, asNumber, asRecordArray, asString, isRecord } from "../json.ts"
import type { Adapter, UpstreamModel } from "./adapter.ts"
import { decodeJson, execute, KIND_PATHS, postJson, transportFailure, url } from "./http.ts"
import { fromUpstreamChunk, fromUpstreamResponse, toUpstreamBody } from "./openai-chat.ts"
import * as sse from "./sse.ts"

const MODELS_PATH = "/v1/models"

/**
 * Build an authenticated GET, mirroring `postJson`'s header ordering because the
 * platform exposes no GET counterpart: operator headers first so they can
 * override anything, then the bearer token — unless they supplied their own
 * `authorization`, which is how a custom auth scheme (or a local runtime that
 * wants none) is expressed.
 */
export const getRequest = (
  provider: Provider,
  path: string
): HttpClientRequest.HttpClientRequest => {
  const base = HttpClientRequest.get(url(provider.base_url, path)).pipe(
    HttpClientRequest.setHeaders({ accept: "application/json" })
  )
  const withProvider = HttpClientRequest.setHeaders(base, provider.headers)
  if (hasAuthorization(provider.headers) || provider.api_key === "") return withProvider
  return HttpClientRequest.setHeaders(withProvider, { authorization: `Bearer ${provider.api_key}` })
}

const hasAuthorization = (headers: Record<string, string>): boolean =>
  Object.keys(headers).some((key) => key.toLowerCase() === "authorization")

/**
 * Read a `/v1/models` payload.
 *
 * OpenAI answers `{data: [{id, owned_by}]}`; aggregators in front of it add
 * capability metadata, either flat or nested under `meta` / `top_provider`.
 * Entries are kept verbatim in `raw` so fields the gateway does not model — for
 * example workbuddy2api's `reasoning_supported_efforts` — still reach the admin
 * UI instead of being flattened away.
 */
const parseModels = (raw: unknown): ReadonlyArray<UpstreamModel> => {
  if (!isRecord(raw)) return []
  return asRecordArray(raw.data)
    .map(toUpstreamModel)
    .filter((model): model is UpstreamModel => model !== null)
}

const toUpstreamModel = (entry: Record<string, unknown>): UpstreamModel | null => {
  // An entry with no id cannot be addressed in a request, so it is not a model.
  const id = asString(entry.id)
  if (id === null) return null

  const meta = isRecord(entry.meta) ? entry.meta : null
  const topProvider = isRecord(entry.top_provider) ? entry.top_provider : null
  const pick = (key: string): unknown => entry[key] ?? meta?.[key] ?? topProvider?.[key]

  return {
    id,
    context_length: asNumber(pick("context_length")),
    max_output_tokens: asNumber(pick("max_output_tokens")),
    supports_images: asBoolean(pick("supports_images")) ?? false,
    owned_by: asString(pick("owned_by")),
    raw: entry
  }
}

/**
 * List the provider's models.
 *
 * A body that cannot be read as `{data: [...]}` is reported as not enumerated rather
 * than as an empty catalogue: the caller replaces stored models with the result, so
 * conflating the two would delete the catalogue on a transient upstream fault.
 * Transport and HTTP failures still surface as `ProviderError`.
 */
const listModels = (
  provider: Provider
): Effect.Effect<
  { readonly models: ReadonlyArray<UpstreamModel>; readonly enumerated: boolean },
  ProviderError,
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const response = yield* execute(provider, getRequest(provider, MODELS_PATH))
    const body = yield* response.text.pipe(
      Effect.mapError((cause) => transportFailure(provider, cause))
    )
    const json = yield* decodeJson(provider, body).pipe(Effect.orElseSucceed((): unknown => null))
    // `data` must be an actual array. An error envelope, an empty object or HTML all
    // fail this test, while a genuine `{data: []}` passes it.
    const enumerated = isRecord(json) && Array.isArray(json.data)
    return { models: parseModels(json), enumerated }
  })

/**
 * Build the chat-completions adapter for `kind`.
 *
 * Only the kinds that mount the Chat Completions route are accepted; an
 * `openai-responses` provider would otherwise silently be posted to the wrong
 * path.
 */
export const chatCompletion = (kind: "openai-chat" | "workbuddy2api"): Adapter => ({
  kind,

  complete: (target, request) =>
    Effect.gen(function* () {
      const { provider, upstream_model } = target
      const response = yield* execute(
        provider,
        postJson(provider, KIND_PATHS[kind], toUpstreamBody(request, upstream_model, { stream: false }))
      )
      const body = yield* response.text.pipe(
        Effect.mapError((cause) => transportFailure(provider, cause))
      )
      const json = yield* decodeJson(provider, body)
      const parsed = fromUpstreamResponse(json, upstream_model)
      return {
        response: parsed,
        // The caller needs to know when the provider swapped the model: a renamed
        // upstream is the usual cause of "I asked for X and got Y".
        model: parsed.model === upstream_model ? null : parsed.model
      }
    }),

  stream: (target, request) =>
    Effect.gen(function* () {
      const { provider, upstream_model: model } = target
      const body = toUpstreamBody(request, model, { stream: true })
      const requested = isRecord(body.stream_options) ? body.stream_options : {}
      // The gateway bills from the trailing usage chunk, so include_usage is
      // forced on even when the caller asked otherwise.
      body.stream_options = { ...requested, include_usage: true }

      // `execute` is run here rather than inside the returned stream: a rejected
      // request must be observable before the gateway commits to this provider.
      const response = yield* execute(provider, postJson(provider, KIND_PATHS[kind], body))
      const chunks = response.stream.pipe(
        sse.parse,
        sse.decode,
        Stream.map((raw) => fromUpstreamChunk(raw, model)),
        Stream.filter((chunk): chunk is Chat.Chunk => chunk !== null),
        Stream.mapError((cause) => transportFailure(provider, cause))
      )
      return { model, sse: chunks }
    }),

  listModels
})

export const openaiChatAdapter: Adapter = chatCompletion("openai-chat")
