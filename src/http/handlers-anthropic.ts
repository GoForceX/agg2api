/**
 * Client-facing `POST /v1/messages`: the Anthropic Messages API.
 *
 * Anthropic is a *client* protocol only — the body converts to the canonical chat
 * model and the existing executor routes it to whichever provider serves the model.
 * Everything that is not protocol-specific (admission control, routing, accounting,
 * affinity) is shared with the OpenAI handlers in `./handlers-v1.ts`; only the wire
 * shapes differ:
 *
 * - Failures use Anthropic's `{type:"error",error:{type,message}}` envelope, because
 *   an Anthropic SDK reads that shape and would show a raw body otherwise.
 * - Streaming uses named SSE events and has no `[DONE]` terminator — the response
 *   simply ends after `message_stop`. `sse.encode` would append a terminator this
 *   protocol does not define, so `namedBody` is used instead.
 */
import * as HttpApiBuilder from "@effect/platform/HttpApiBuilder"
import * as HttpRouter from "@effect/platform/HttpRouter"
import * as HttpServerRequest from "@effect/platform/HttpServerRequest"
import * as HttpServerResponse from "@effect/platform/HttpServerResponse"
import * as Effect from "effect/Effect"
import * as SqlClient from "@effect/sql/SqlClient"
import * as Stream from "effect/Stream"
import {
  chunkToEvents,
  errorBody,
  finishEvents,
  newStreamState,
  toAnthropic,
  toCanonical
} from "../anthropic/convert.ts"
import * as Chat from "../canonical.ts"
import { notFound, type ClientError, type ProviderError, type RoutingError } from "../errors.ts"
import { newUsageAccumulator, recordSuccess, type UsageAccumulator } from "../gateway/accounting.ts"
import { execute, executeStream } from "../gateway/executor.ts"
import * as sse from "../upstream/sse.ts"
import { api, type AnthropicModelInfo } from "./api.ts"
import { guard, modelCatalogue, openEpisode, settle, withAffinity, type EpisodeHolder, type ErrorRenderer } from "./handlers-v1.ts"

// ---------------------------------------------------------------------------
// Error rendering
// ---------------------------------------------------------------------------

interface RenderedFailure {
  readonly status: number
  readonly type: string
  readonly message: string
}

/**
 * Map the gateway's failure taxonomy onto Anthropic's error types.
 *
 * The type names are Anthropic's own — its SDKs surface `error.type` to the caller —
 * while the statuses stay exactly what the OpenAI envelope would have used, which is
 * what an SDK's retry logic keys on. `ClientError` is a rejected request, and 429 is
 * the one case in that class Anthropic names separately.
 */
const renderFailure = (error: ClientError | RoutingError | ProviderError): RenderedFailure => {
  if (error._tag === "ClientError") {
    return {
      status: error.status,
      type: error.status === 429 ? "rate_limit_error" : "invalid_request_error",
      message: error.message
    }
  }
  if (error._tag === "RoutingError") {
    const unavailable = error.reason === "all_unavailable"
    return {
      status: unavailable ? 503 : 404,
      type: unavailable ? "overloaded_error" : "not_found_error",
      message: error.message
    }
  }
  return {
    // A provider's own status is more informative than a generic 502, and it is what
    // a client's retry logic reacts to.
    status: error.status >= 400 && error.status < 600 ? error.status : 502,
    type: "api_error",
    message: error.message
  }
}

const errorResponse = (
  error: ClientError | RoutingError | ProviderError
): HttpServerResponse.HttpServerResponse => {
  const rendered = renderFailure(error)
  return HttpServerResponse.unsafeJson(errorBody(rendered.type, rendered.message), { status: rendered.status })
}

/**
 * Anthropic's envelope, handed to the shared `guard`.
 *
 * The guard still records the failure against the episode, so error rates in the
 * dashboard stay comparable across the three client protocols.
 */
export const anthropicErrors: ErrorRenderer = {
  failure: errorResponse,
  internal: () =>
    HttpServerResponse.unsafeJson(errorBody("api_error", "internal gateway error"), { status: 500 })
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** One named SSE frame, in the shape `namedBody` frames. */
interface AnthropicEvent {
  readonly event: string
  readonly data: string
}

/**
 * Canonical chunk stream → Anthropic SSE frames.
 *
 * The accumulator is fed here rather than by the caller so that every exit path —
 * including a stream cut short by a provider fault — still accounts for what was
 * delivered. The closing `message_delta`/`message_stop` pair is deferred to
 * end-of-stream because the usage it carries does not exist until the last chunk has
 * been seen, and `finishEvents` closes any content block left open.
 */
const streamFrames = (
  chunks: Stream.Stream<Chat.Chunk, ProviderError>,
  id: string,
  publicModel: string,
  accumulator: UsageAccumulator
): Stream.Stream<AnthropicEvent, ProviderError> =>
  Stream.suspend(() => {
    const state = newStreamState(id, publicModel)
    return chunks.pipe(
      Stream.mapConcat((chunk) => {
        accumulator.add(chunk)
        return chunkToEvents(chunk, state)
      }),
      Stream.concat(Stream.suspend(() => Stream.fromIterable(finishEvents(state, accumulator.usage())))),
      Stream.map((entry): AnthropicEvent => ({ event: entry.event, data: JSON.stringify(entry.data) }))
    )
  })

export const anthropicMessages = (holder: EpisodeHolder) => Effect.gen(function* () {
  // Captured here, not required by the returned stream: the platform consumes the
  // response body after this effect has finished, so any requirement left on the
  // stream could never be satisfied.
  const sql = yield* SqlClient.SqlClient
  const context = withAffinity(yield* openEpisode("anthropic"))
  holder.episode = context.episode
  const publicModel = context.episode.public_model
  // Only the canonical form is used: routing is keyed on the public model the caller
  // named, which `openEpisode` already resolved (and validated) before conversion.
  const { request } = toCanonical(context.body as never)
  const routing = {
    request_id: context.episode.request_id,
    public_model: publicModel,
    strategy: context.strategy,
    // Derived from the converted canonical messages, so the Anthropic protocol gets
    // the same cache affinity as Chat Completions and Responses.
    session_key: context.affinityKey(request.messages)
  }
  const messageId = `msg_${context.episode.request_id}`

  if (context.episode.stream) {
    const opened = yield* executeStream(routing, request)
    const accumulator = newUsageAccumulator()
    let failed: ProviderError | null = null

    const body = sse.namedBody(
      streamFrames(opened.stream.sse, messageId, publicModel, accumulator).pipe(
        // The client already has a 200 and partial content. The only honest signal
        // left is an `error` frame, and because Anthropic terminates the stream after
        // it, the switch happens outside the finishing events: no `message_stop` is
        // emitted for a message that never completed.
        Stream.catchAll((error: ProviderError) => {
          failed = error
          return Stream.succeed<AnthropicEvent>({
            event: "error",
            data: JSON.stringify(errorBody(renderFailure(error).type, error.message))
          })
        }),
        Stream.ensuring(
          settle(sql, context.episode, opened.committed, accumulator, () => failed)
        )
      )
    )

    return HttpServerResponse.stream(body, { status: 200, headers: sse.HEADERS })
  }

  const result = yield* execute(routing, request)
  const response = result.completion.response
  yield* recordSuccess(
    context.episode,
    result.committed,
    response.usage ?? { ...Chat.EMPTY_USAGE },
    0
  )

  // The public name the caller asked for, not the provider's internal model id.
  return HttpServerResponse.unsafeJson(toAnthropic(response, { id: messageId, model: publicModel }))
})

// ---------------------------------------------------------------------------
// Model listing
// ---------------------------------------------------------------------------

/**
 * Anthropic's model catalogue.
 *
 * Separate from the OpenAI listing because the two protocols disagree about the shape,
 * not just the envelope: `type` instead of `object`, `max_input_tokens` instead of
 * `context_length`, and `created_at` as an RFC 3339 string instead of the Unix `created`
 * the OpenAI object carries. The Anthropic SDKs parse this shape, so serving them the
 * OpenAI object leaves `display_name` and the token limits undefined.
 */
const anthropicModels = Effect.gen(function* () {
  yield* openEpisode("chat", { require_model: false })
  const entries = yield* modelCatalogue

  const data: AnthropicModelInfo[] = entries.map(({ entry, metadata }) => ({
    type: "model" as const,
    id: entry.public_model,
    // Anthropic's `display_name` is not nullable; the public id is the honest fallback.
    display_name: entry.display_name ?? entry.public_model,
    // The gateway does not track per-model release dates, so the epoch is stated rather
    // than invented. Clients only render it.
    created_at: new Date(0).toISOString(),
    capabilities: metadata?.capabilities ?? null,
    max_input_tokens: metadata?.context_length ?? null,
    max_tokens: metadata?.max_output_tokens ?? null
  }))

  // No pagination: the catalogue is returned whole, and the cursors must still be
  // present because the SDKs read them to populate their pagination state.
  return {
    data,
    first_id: data[0]?.id ?? null,
    last_id: data.at(-1)?.id ?? null,
    has_more: false
  }
})

const anthropicModel = Effect.gen(function* () {
  yield* openEpisode("chat", { require_model: false })
  // The router's decoded parameter; see `modelCard` for why re-parsing `request.url` was
  // both a 500 (a malformed escape after a `;`) and a source of phantom 404s.
  const id = (yield* HttpRouter.params)["0"] ?? ""

  const entries = yield* modelCatalogue
  const found = entries.find((entry) => entry.entry.public_model === id)
  if (found === undefined) {
    return yield* Effect.fail(notFound(`no such model: ${id}`))
  }

  const card: AnthropicModelInfo = {
    type: "model",
    id,
    display_name: found.entry.display_name ?? id,
    created_at: new Date(0).toISOString(),
    capabilities: found.metadata?.capabilities ?? null,
    max_input_tokens: found.metadata?.context_length ?? null,
    max_tokens: found.metadata?.max_output_tokens ?? null
  }
  return card
})

export const anthropicHandlers = HttpApiBuilder.group(api, "anthropic", (h) =>
  h
    .handleRaw("messages", () => {
      const holder: EpisodeHolder = { episode: null }
      // Anthropic clients read `{type:"error",error:{type,message}}`, not OpenAI's
      // envelope, so this endpoint renders failures through its own renderer.
      return guard(anthropicMessages(holder), holder, (response) => response, anthropicErrors)
    })
    .handleRaw("models", () => {
      const holder: EpisodeHolder = { episode: null }
      return guard(anthropicModels, holder, (value) => HttpServerResponse.unsafeJson(value), anthropicErrors)
    })
    .handleRaw("model", () => {
      const holder: EpisodeHolder = { episode: null }
      return guard(anthropicModel, holder, (value) => HttpServerResponse.unsafeJson(value), anthropicErrors)
    })
)
