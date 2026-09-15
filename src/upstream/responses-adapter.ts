/**
 * OpenAI Responses adapter.
 *
 * The gateway's canonical model is chat-shaped, so this adapter carries both
 * translations itself: the canonical request is rebuilt as a Responses body on the
 * way out, and the item-oriented Responses payload is folded back into chat
 * choices on the way in. `convert.ts` holds both directions as pure functions; this
 * file is only the wire half.
 *
 * Like the chat adapter, the HTTP call is issued *before* `stream` succeeds, so a
 * provider that rejects the request fails while the gateway has still written
 * nothing to the client — which is what makes trying the next candidate safe.
 */
import * as HttpClient from "@effect/platform/HttpClient"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import type * as Chat from "../canonical.ts"
import type { Provider } from "../domain.ts"
import { ProviderError, providerError } from "../errors.ts"
import { asBoolean, asNumber, asRecordArray, asString, isRecord } from "../json.ts"
import { eventsToChunk, fromResponses, toResponsesBody } from "../responses/convert.ts"
import type { Adapter, UpstreamModel } from "./adapter.ts"
import { getRequest } from "./chat-adapter.ts"
import { decodeJson, execute, postJson, transportFailure } from "./http.ts"
import * as sse from "./sse.ts"

const RESPONSES_PATH = "/v1/responses"
const MODELS_PATH = "/v1/models"

/** Read a provider's model listing into the gateway's discovery shape. */
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
    // Kept verbatim so provider-specific fields still reach the admin UI.
    raw: entry
  }
}

/**
 * List the provider's models.
 *
 * A body that is not the expected shape yields an empty array rather than a
 * failure: a provider answering something else at this path simply has nothing to
 * enumerate, and failing here would stall discovery for every other provider.
 * Transport and HTTP failures still surface as `ProviderError`.
 */
const listModels = (
  provider: Provider
): Effect.Effect<ReadonlyArray<UpstreamModel>, ProviderError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const response = yield* execute(provider, getRequest(provider, MODELS_PATH))
    const body = yield* response.text.pipe(Effect.mapError((cause) => transportFailure(provider, cause)))
    const json = yield* decodeJson(provider, body).pipe(Effect.orElseSucceed((): unknown => null))
    if (!isRecord(json)) return []
    return asRecordArray(json.data)
      .map(toUpstreamModel)
      .filter((model): model is UpstreamModel => model !== null)
  })

/** Parse one SSE payload, keeping malformed frames out of the conversion. */
const parsePayload = (payload: string): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(payload)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Recognise an upstream-reported failure event.
 *
 * A provider signals a mid-stream fault by *event*, not by status — the 200 and
 * its headers already went out — so these are the only signal that the turn did not
 * finish. `sse.decode` would be the natural reader here, but it drops unparsable
 * frames silently, which is exactly the wrong behaviour for the one frame that must
 * never be lost.
 */
const failureOf = (event: Record<string, unknown>, provider: Provider): ProviderError | null => {
  const type = asString(event.type)
  const isFailure = type === "response.failed" || type === "response.error"
  if (!isFailure && !isRecord(event.error)) return null

  const response = isRecord(event.response) ? event.response : {}
  const error = isRecord(response.error)
    ? response.error
    : isRecord(event.error)
      ? event.error
      : {}
  const detail = asString(error.message) ?? asString(event.message)

  return providerError({
    provider_id: provider.id,
    provider_name: provider.name,
    kind: "upstream",
    // The request itself succeeded; the failure is inside the response body.
    status: 200,
    message: detail ?? (type === null ? "upstream reported an error" : `upstream reported ${type}`),
    body: JSON.stringify(event)
  })
}

export const responsesAdapter: Adapter = {
  kind: "openai-responses",

  complete: (target, request) =>
    Effect.gen(function* () {
      const { provider, upstream_model } = target
      const body = { ...toResponsesBody(request, upstream_model), stream: false }
      const response = yield* execute(provider, postJson(provider, RESPONSES_PATH, body))
      const payload = yield* response.text.pipe(Effect.mapError((cause) => transportFailure(provider, cause)))
      const json = yield* decodeJson(provider, payload)
      const parsed = fromResponses(json, upstream_model)
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
      const body = { ...toResponsesBody(request, model), stream: true }

      // Run here rather than inside the returned stream: a rejected request must be
      // observable before the gateway commits to this provider.
      const response = yield* execute(provider, postJson(provider, RESPONSES_PATH, body))
      const chunks = response.stream.pipe(
        sse.parse,
        Stream.map(parsePayload),
        Stream.filter((event): event is Record<string, unknown> => event !== null),
        Stream.mapEffect((event) => {
          const failure = failureOf(event, provider)
          if (failure !== null) return Effect.fail(failure)
          return Effect.succeed(eventsToChunk(event, model))
        }),
        Stream.filter((chunk): chunk is Chat.Chunk => chunk !== null),
        // A `ProviderError` raised above is already classified; everything else is
        // a transport failure from the body stream itself.
        Stream.mapError((cause: unknown): ProviderError =>
          cause instanceof ProviderError ? cause : transportFailure(provider, cause)
        )
      )
      return { model, sse: chunks }
    }),

  listModels
}
