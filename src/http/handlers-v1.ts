/**
 * Client-facing `/v1` handlers: Chat Completions, Responses and model listing.
 *
 * Each handler returns an `HttpServerResponse` directly rather than a typed
 * success value, for two reasons: the streaming endpoints must emit SSE, and the
 * client-facing error envelope is OpenAI's `{error:{message,type,code}}` rather
 * than the shape an `HttpApi` error schema would produce.
 *
 * The streaming path carries the design's central constraint. `executeStream`
 * commits to a provider before returning, so once the first byte is written the
 * gateway can no longer fail over. Usage is therefore accumulated as chunks flow
 * and persisted in an `ensuring` finaliser, which runs on normal completion, on a
 * mid-stream provider error, and on client disconnect alike — a request that was
 * cut short still appears in the dashboard for what it consumed.
 */
import * as HttpApiBuilder from "@effect/platform/HttpApiBuilder"
import * as HttpServerRequest from "@effect/platform/HttpServerRequest"
import * as HttpServerResponse from "@effect/platform/HttpServerResponse"
import * as Effect from "effect/Effect"
import * as SqlClient from "@effect/sql/SqlClient"
import * as Stream from "effect/Stream"
import * as Chat from "../canonical.ts"
import type { Endpoint, RoutingStrategy } from "../domain.ts"
import { ProviderError, RoutingError, badRequest, notFound, type ClientError } from "../errors.ts"
import { AppSettings } from "../gateway/settings.ts"
import { execute, executeStream } from "../gateway/executor.ts"
import { catalogue, modelMetadata } from "../gateway/discovery.ts"
import { newUsageAccumulator, recordFailure, recordSuccess, type Episode } from "../gateway/accounting.ts"
import { sessionKey } from "../gateway/sessions.ts"
import { health as healthz } from "./healthz.ts"
import * as sse from "../upstream/sse.ts"
import { api, type HealthReport, type ModelCard } from "./api.ts"
import { authenticate, assertModelAllowed, limiterKeyFor, rateLimitFor, rateLimiter, requireModel, type Caller } from "./auth.ts"
import { toResponses, toResponsesRequest, responsesStreamPayloads } from "../responses/convert.ts"
import { anthropicErrors, anthropicMessages } from "./handlers-anthropic.ts"

// ---------------------------------------------------------------------------
// Error rendering
// ---------------------------------------------------------------------------

/**
 * Map any gateway failure onto an OpenAI-shaped error.
 *
 * A `ProviderError` that already carries an HTTP status passes through: the
 * provider's own 429 or 404 is more informative than a generic 502, and it is what
 * an SDK's retry logic keys on.
 */
/**
 * OpenAI's `type` for a given status.
 *
 * `type` is what an SDK's retry and error-class logic keys on, so it has to agree with
 * the status: every client error used to be reported as `invalid_request_error`, which
 * told a caller that exceeded its rate limit that its request was malformed.
 */
const errorTypeFor = (status: number): string => {
  if (status === 401) return "authentication_error"
  if (status === 403) return "permission_error"
  if (status === 429) return "rate_limit_error"
  if (status === 404) return "not_found_error"
  if (status >= 500) return "api_error"
  return "invalid_request_error"
}

const renderError = (error: ClientError | RoutingError | ProviderError) => {
  if (error._tag === "ClientError") {
    return { status: error.status, code: error.code, type: errorTypeFor(error.status), message: error.message }
  }
  if (error._tag === "RoutingError") {
    const unavailable = error.reason === "all_unavailable"
    return {
      status: unavailable ? 503 : 404,
      code: error.reason,
      type: errorTypeFor(unavailable ? 503 : 404),
      message: error.message
    }
  }
  return {
    status: error.status >= 400 && error.status < 600 ? error.status : 502,
    code: error.kind,
    type: "upstream_error",
    message: error.message
  }
}

const errorResponse = (
  error: ClientError | RoutingError | ProviderError
): HttpServerResponse.HttpServerResponse => {
  const rendered = renderError(error)
  return HttpServerResponse.unsafeJson(
    { error: { message: rendered.message, type: rendered.type, code: rendered.code } },
    { status: rendered.status }
  )
}

const internalError = (): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.unsafeJson(
    { error: { message: "internal gateway error", type: "api_error", code: "internal_error" } },
    { status: 500 }
  )

// ---------------------------------------------------------------------------
// Request context
// ---------------------------------------------------------------------------

interface CallerContext {
  readonly caller: Caller
  readonly episode: Episode
  readonly body: Record<string, unknown>
  readonly strategy: RoutingStrategy
  /**
   * Inputs for cache affinity: the client's explicit session header (if any) and the
   * caller identity used to scope the pin. The key itself is computed per handler from
   * the *canonical* messages, because the two client protocols spell them differently.
   */
  readonly affinity: { readonly explicit: string | null; readonly tenant: string }
  /** Session key for a set of canonical messages, or `null` when unpinnable. */
  readonly affinityKey: (messages: ReadonlyArray<Chat.Message>) => string | null
}

const header = (headers: Record<string, string | undefined>, name: string): string | null => {
  const value = headers[name] ?? headers[name.toLowerCase()]
  return typeof value === "string" && value !== "" ? value : null
}

/**
 * Shared preamble: identify the caller, enforce admission control, and build the
 * episode that both the success and failure paths record against.
 */
export const openEpisode = (
  endpoint: Endpoint,
  /** `/v1/models` carries no model, so extraction is opt-in per endpoint. */
  options: { require_model: boolean } = { require_model: true }
): Effect.Effect<
  Omit<CallerContext, "affinityKey">,
  ClientError,
  HttpServerRequest.HttpServerRequest | SqlClient.SqlClient | AppSettings
> =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const settings = yield* AppSettings

    // A declared length is only a cheap early rejection: a chunked request sends no
    // Content-Length at all, so trusting the header alone let an arbitrarily large body
    // be buffered by an unauthenticated caller.
    const contentLength = header(request.headers, "content-length")
    if (contentLength !== null) {
      const length = Number(contentLength)
      if (Number.isFinite(length) && length > settings.max_body_bytes) {
        return yield* Effect.fail(badRequest(`request body exceeds ${settings.max_body_bytes} bytes`))
      }
    }
    const tooLarge = badRequest(`request body exceeds ${settings.max_body_bytes} bytes`)

    const caller = yield* authenticate(header(request.headers, "authorization"))
    const clientIp =
      header(request.headers, "cf-connecting-ip") ??
      header(request.headers, "x-forwarded-for")?.split(",")[0]?.trim() ??
      null

    yield* rateLimiter(limiterKeyFor(caller, clientIp), yield* rateLimitFor(caller))

    // Read the body through the stream so the cap is enforced while consuming, which is
    // the only way it can apply to a chunked request. `runFoldEffect` stops at the first
    // chunk that crosses the limit, so nothing beyond it is buffered.
    interface BodyRead {
      readonly chunks: ReadonlyArray<Uint8Array>
      readonly bytes: number
      readonly over: boolean
    }
    const empty: BodyRead = { chunks: [], bytes: 0, over: false }
    const raw = yield* request.stream.pipe(
      Stream.runFoldEffect(
        empty,
        (state: BodyRead, chunk: Uint8Array): Effect.Effect<BodyRead> => {
          if (state.over) return Effect.succeed(state)
          const bytes = state.bytes + chunk.length
          if (bytes > settings.max_body_bytes) return Effect.succeed({ ...state, bytes, over: true })
          return Effect.succeed({ chunks: [...state.chunks, chunk], bytes, over: false })
        }
      ),
      Effect.orElseSucceed(() => empty)
    )
    if (raw.over) return yield* Effect.fail(tooLarge)

    const text = new TextDecoder().decode(Buffer.concat(raw.chunks.map((chunk) => Buffer.from(chunk))))
    const parsed: unknown = yield* Effect.try(() => JSON.parse(text) as unknown).pipe(
      Effect.orElseSucceed(() => null)
    )
    const body =
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {}

    // Model extraction is a separate concern from admission control: listing models
    // is an authenticated operation that names no model.
    const model = options.require_model ? yield* requireModel(body) : ""
    if (options.require_model) yield* assertModelAllowed(caller, model)

    return {
      caller,
      body,
      strategy: settings.default_strategy,
      // Scoped per client key, so two tenants sending identical prompts never share a
      // pin, and so one tenant cannot steer another's routing.
      affinity: {
        explicit: header(request.headers, "x-session-id"),
        tenant: caller.id === null ? `ip:${clientIp ?? "anon"}` : `key:${caller.id}`
      },
      episode: {
        request_id: header(request.headers, "x-request-id") ?? crypto.randomUUID(),
        endpoint,
        stream: body.stream === true,
        public_model: model,
        started_at: Date.now(),
        caller_id: caller.id,
        caller_name: caller.name,
        client_ip: clientIp,
        user_agent: header(request.headers, "user-agent")
      }
    }
  })

/**
 * Cache-affinity key for a canonical request, or `null` when there is nothing to pin
 * on. Attached to the context so both protocol handlers derive it the same way.
 */
export const withAffinity = (context: Omit<CallerContext, "affinityKey">): CallerContext => ({
  ...context,
  affinityKey: (messages) =>
    messages.length === 0
      ? null
      : sessionKey({
          explicit: context.affinity.explicit,
          tenant: context.affinity.tenant,
          model: context.episode.public_model,
          messages
        })
})

// ---------------------------------------------------------------------------
// Chat Completions
// ---------------------------------------------------------------------------

/**
 * Narrow a client body onto the canonical request.
 *
 * Fields are copied explicitly rather than spread: a client must not be able to
 * smuggle an arbitrary key past validation into the upstream request, and this is
 * also where non-OpenAI extensions are dropped.
 */
const toCanonicalRequest = (body: Record<string, unknown>, model: string): Chat.Request => {
  const number = (key: string) => (typeof body[key] === "number" ? (body[key] as number) : undefined)
  const text = (key: string) => (typeof body[key] === "string" ? (body[key] as string) : undefined)

  return {
    model,
    messages: Array.isArray(body.messages) ? (body.messages as Chat.Message[]) : [],
    stream: body.stream === true,
    stream_options:
      body.stream_options !== null && typeof body.stream_options === "object"
        ? (body.stream_options as Chat.Request["stream_options"])
        : undefined,
    max_tokens: number("max_tokens"),
    max_completion_tokens: number("max_completion_tokens"),
    temperature: number("temperature"),
    top_p: number("top_p"),
    stop: body.stop as Chat.Request["stop"],
    presence_penalty: number("presence_penalty"),
    frequency_penalty: number("frequency_penalty"),
    logprobs: typeof body.logprobs === "boolean" ? body.logprobs : undefined,
    top_logprobs: number("top_logprobs"),
    n: number("n"),
    seed: number("seed"),
    response_format: body.response_format,
    tools: Array.isArray(body.tools) ? (body.tools as Chat.Tool[]) : undefined,
    tool_choice: body.tool_choice,
    parallel_tool_calls:
      typeof body.parallel_tool_calls === "boolean" ? body.parallel_tool_calls : undefined,
    user: text("user"),
    reasoning_effort: text("reasoning_effort")
  }
}

/**
 * Fold a completed chunk stream back into one non-streaming response.
 *
 * Used by the Responses endpoint, which must answer `stream: false` callers from a
 * provider that only ever streams.
 */
export const aggregate = (
  chunks: ReadonlyArray<Chat.Chunk>,
  fallbackModel: string
): Chat.Response => {
  const first = chunks[0]
  const text: string[] = []
  const reasoning: string[] = []
  const toolCalls = new Map<number, Chat.ToolCall>()
  let finish: string | null = null
  let usage: Chat.Usage | null = null

  for (const chunk of chunks) {
    if (chunk.usage !== null) usage = chunk.usage
    for (const choice of chunk.choices) {
      if (choice.delta.content !== undefined && choice.delta.content !== null) {
        text.push(choice.delta.content)
      }
      if (choice.delta.reasoning_content !== undefined && choice.delta.reasoning_content !== null) {
        reasoning.push(choice.delta.reasoning_content)
      }
      for (const call of choice.delta.tool_calls ?? []) {
        const index = call.index ?? 0
        const existing = toolCalls.get(index) ?? {
          id: "",
          type: "function" as const,
          function: { name: "", arguments: "" }
        }
        // Argument fragments arrive spread across chunks and must be concatenated
        // in arrival order; the id and name appear only on the first fragment.
        toolCalls.set(index, {
          id: existing.id === "" ? call.id : existing.id,
          type: "function",
          function: {
            name: existing.function.name === "" ? call.function.name : existing.function.name,
            arguments: existing.function.arguments + call.function.arguments
          }
        })
      }
      if (choice.finish_reason !== null) finish = choice.finish_reason
    }
  }

  const calls = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => call)
  return {
    id: first?.id ?? `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: first?.created ?? Math.floor(Date.now() / 1000),
    model: first?.model ?? fallbackModel,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text.length > 0 ? text.join("") : null,
          ...(reasoning.length > 0 ? { reasoning_content: reasoning.join("") } : {}),
          ...(calls.length > 0 ? { tool_calls: calls } : {})
        },
        finish_reason: finish
      }
    ],
    usage: usage ?? { ...Chat.EMPTY_USAGE }
  }
}

/**
 * Persist the outcome once a stream finishes, however it finishes.
 *
 * Takes the `SqlClient` explicitly and provides it to the recording effects so the
 * resulting `Effect` has no requirements — this runs after the handler returned,
 * so nothing would be left to satisfy them.
 *
 * The failure is read lazily via a getter because the stream may still fail after
 * this finaliser is constructed.
 */
export const settle = (
  sql: SqlClient.SqlClient,
  episode: Episode,
  committed: Parameters<typeof recordSuccess>[1],
  accumulator: ReturnType<typeof newUsageAccumulator>,
  failure: () => ProviderError | null
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const failed = failure()
    if (failed === null) {
      yield* effectProvideService(
        recordSuccess(episode, committed, accumulator.usage(), committed.ttft_ms),
        sql
      )
      return
    }
    yield* effectProvideService(
      recordFailure(episode, {
        status: 502,
        error_kind: failed.kind,
        error_message: failed.message,
        attempts: committed.attempts
      }),
      sql
    )
  })

const effectProvideService = <A, E>(
  effect: Effect.Effect<A, E, SqlClient.SqlClient>,
  sql: SqlClient.SqlClient
): Effect.Effect<A, E> => Effect.provideService(effect, SqlClient.SqlClient, sql)

const chatCompletions = (holder: EpisodeHolder) => Effect.gen(function* () {
  // Captured here, not required by the returned stream: the platform consumes the
  // response body after this effect has finished, so any requirement left on the
  // stream could never be satisfied.
  const sql = yield* SqlClient.SqlClient
  const context = withAffinity(yield* openEpisode("chat"))
  holder.episode = context.episode
  const request = toCanonicalRequest(context.body, context.episode.public_model)
  const routing = {
    request_id: context.episode.request_id,
    public_model: context.episode.public_model,
    strategy: context.strategy,
    session_key: context.affinityKey(request.messages)
  }

  if (request.stream === true) {
    const opened = yield* executeStream(routing, request)
    const accumulator = newUsageAccumulator()
    let failed: ProviderError | null = null

    const body = sse.responseBody(
      opened.stream.sse.pipe(
        Stream.tap((chunk) => Effect.sync(() => accumulator.add(chunk))),
        Stream.map((chunk) => JSON.stringify(chunk)),
        Stream.catchAll((error: ProviderError) =>
          Effect.sync(() => {
            failed = error
            // The client already has a 200 and partial content. The only honest
            // signal left is an error frame ahead of the terminator.
            return JSON.stringify({
              error: { message: error.message, type: "upstream_error", code: error.kind }
            })
          })
        ),
        Stream.ensuring(
          settle(
            sql,
            context.episode,
            opened.committed,
            accumulator,
            () => failed
          )
        )
      )
    )

    return HttpServerResponse.stream(body, { status: 200, headers: sse.HEADERS })
  }

  const result = yield* execute(routing, request)
  yield* recordSuccess(
    context.episode,
    result.committed,
    result.completion.response.usage ?? { ...Chat.EMPTY_USAGE },
    0
  )

  return HttpServerResponse.unsafeJson({
    ...result.completion.response,
    // Report the public name the caller asked for, not the provider's internal id.
    model: context.episode.public_model
  })
})

// ---------------------------------------------------------------------------
// Responses API
// ---------------------------------------------------------------------------

const responses = (holder: EpisodeHolder) => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const context = withAffinity(yield* openEpisode("responses"))
  holder.episode = context.episode
  const publicModel = context.episode.public_model
  const converted = toResponsesRequest(context.body as never, publicModel)
  const routing = {
    request_id: context.episode.request_id,
    public_model: publicModel,
    strategy: context.strategy,
    // Derived from the converted canonical messages, so the Responses protocol gets the
    // same affinity as Chat Completions despite spelling its input differently.
    session_key: context.affinityKey(converted.messages)
  }

  if (context.episode.stream) {
    const opened = yield* executeStream(routing, converted)
    const accumulator = newUsageAccumulator()
    let failed: ProviderError | null = null
    const responseId = `resp_${context.episode.request_id}`

    const body = sse.responseBody(
      responsesStreamPayloads(opened.stream.sse, responseId, publicModel, accumulator).pipe(
        Stream.catchAll((error: ProviderError) =>
          Effect.sync(() => {
            failed = error
            return JSON.stringify({
              type: "response.failed",
              response: {
                id: responseId,
                object: "response",
                status: "failed",
                model: publicModel,
                error: { code: error.kind, message: error.message }
              }
            })
          })
        ),
        Stream.ensuring(
          settle(
            sql,
            context.episode,
            opened.committed,
            accumulator,
            () => failed
          )
        )
      )
    )
    return HttpServerResponse.stream(body, { status: 200, headers: sse.HEADERS })
  }

  const result = yield* execute(routing, converted)
  yield* recordSuccess(
    context.episode,
    result.committed,
    result.completion.response.usage ?? { ...Chat.EMPTY_USAGE },
    0
  )
  return HttpServerResponse.unsafeJson(
    toResponses(result.completion.response, {
      id: `resp_${context.episode.request_id}`,
      model: publicModel,
      created: result.completion.response.created
    })
  )
})

// ---------------------------------------------------------------------------
// Model listing
// ---------------------------------------------------------------------------

const models = Effect.gen(function* () {
  // Admission control only; the call itself is what authenticates the request.
  yield* openEpisode("chat", { require_model: false })
  const entries = yield* catalogue()

  const cards: ModelCard[] = []
  for (const entry of entries) {
    const metadata = yield* modelMetadata(entry.public_model)
    cards.push({
      id: entry.public_model,
      object: "model",
      created: 1700000000,
      owned_by: "agg2api",
      display_name: entry.display_name,
      context_length: metadata?.context_length ?? null,
      max_output_tokens: metadata?.max_output_tokens ?? null,
      supports_images: metadata?.supports_images ?? false,
      providers: [...entry.providers]
    })
  }
  return { object: "list" as const, data: cards }
})

const modelCard = Effect.gen(function* () {
  yield* openEpisode("chat", { require_model: false })
  const request = yield* HttpServerRequest.HttpServerRequest
  const id = decodeURIComponent(new URL(request.url, "http://localhost").pathname.replace(/^\/v1\/models\//, ""))

  const metadata = yield* modelMetadata(id)
  if (metadata === null) {
    const live = yield* catalogue()
    if (!live.some((entry) => entry.public_model === id)) {
      // 404, not 400: the request is well-formed, the model simply does not exist. The
      // endpoint declares a 404 for exactly this case, and every OpenAI-shaped client
      // maps a 400 to "my request was malformed".
      return yield* Effect.fail(notFound(`no such model: ${id}`, "model"))
    }
  }

  const card: ModelCard = {
    id,
    object: "model",
    created: 1700000000,
    owned_by: "agg2api",
    display_name: null,
    context_length: metadata?.context_length ?? null,
    max_output_tokens: metadata?.max_output_tokens ?? null,
    supports_images: metadata?.supports_images ?? false
  }
  return card
})

// ---------------------------------------------------------------------------
// Group assembly
// ---------------------------------------------------------------------------

/**
 * Carries the episode the handler created, so a failure can be attributed.
 *
 * Populated once the request has been admitted and its model resolved; failures
 * before that point (bad key, malformed body) have no model to log against and are
 * deliberately not recorded, since an unauthenticated caller could otherwise fill
 * the log.
 */
export interface EpisodeHolder {
  episode: Episode | null
}

/**
 * How a protocol renders a failure.
 *
 * The three client protocols differ only in their error envelope, so `guard` takes
 * the two shapes it needs rather than being duplicated per protocol — a second copy
 * is exactly how one protocol's envelope silently stops being applied.
 */
export interface ErrorRenderer {
  /** A typed gateway failure, with the status its envelope should carry. */
  readonly failure: (error: ClientError | RoutingError | ProviderError) => HttpServerResponse.HttpServerResponse
  /** A defect, which is a gateway bug rather than a rejected request. */
  readonly internal: () => HttpServerResponse.HttpServerResponse
}

/** Render any failure as the OpenAI envelope. */
const openAiErrors: ErrorRenderer = { failure: errorResponse, internal: internalError }

/**
 * Render any failure using the calling protocol's envelope.
 *
 * Every failure that has an episode is recorded first. Without this a request that
 * never reached a provider — an unknown model, or every provider cooling down —
 * would vanish from the dashboard entirely, making the error rate look better than
 * it is.
 */
export const guard = <A, R>(
  effect: Effect.Effect<A, ClientError | RoutingError | ProviderError, R>,
  holder: EpisodeHolder,
  toResponse: (value: A) => HttpServerResponse.HttpServerResponse,
  render: ErrorRenderer = openAiErrors
) =>
  effect.pipe(
    Effect.map(toResponse),
    Effect.catchAll((error) =>
      Effect.gen(function* () {
        const rendered = renderError(error)
        const episode = holder.episode
        if (episode !== null) {
          const sql = yield* SqlClient.SqlClient
          yield* recordFailure(episode, {
            status: rendered.status,
            error_kind: rendered.code,
            error_message: rendered.message,
            // An attempt log is not available here; a ProviderError at least names the
            // upstream it came from, which is what makes the provider breakdown
            // actionable. A routing failure has no provider to attribute at all.
            attempts: [],
            attribution:
              error._tag === "ProviderError"
                ? {
                    provider_id: error.provider_id,
                    provider_name: error.provider_name,
                    provider_kind: null,
                    upstream_model: null
                  }
                : null
          }).pipe(Effect.provideService(SqlClient.SqlClient, sql))
        }
        if (error._tag === "ProviderError") {
          yield* Effect.logWarning("upstream failure", {
            provider: error.provider_name,
            kind: error.kind,
            status: error.status,
            message: error.message
          })
        }
        return render.failure(error)
      })
    ),
    // A defect here is a gateway bug. It must still produce a valid error envelope
    // rather than an empty 500, so the client's SDK sees something actionable.
    Effect.catchAllDefect((defect) =>
      Effect.logError("unhandled defect in /v1 handler", defect).pipe(Effect.as(render.internal()))
    )
  )

/**
 * The `ops` group: the unauthenticated health probe.
 *
 * Registered here rather than in its own file because it needs no services beyond the
 * database, and keeping the three handler groups side by side makes it obvious that
 * only `v1` and `admin` are gated by credentials.
 */
export const opsHandlers = HttpApiBuilder.group(api, "ops", (h) =>
  h.handle("healthz", () =>
    Effect.gen(function* () {
      const report = yield* healthz()
      // A degraded gateway must not answer 200, or orchestrators would keep routing
      // traffic to an instance that fails every completion.
      if (report.status !== "ok") {
        return yield* Effect.fail({ ...report, status: report.status } as HealthReport & { status: "degraded" })
      }
      return report
    })
  )
)

export const v1Handlers = HttpApiBuilder.group(api, "v1", (h) =>
  h
    .handleRaw("chatCompletions", () => {
      const holder: EpisodeHolder = { episode: null }
      return guard(chatCompletions(holder), holder, (response) => response)
    })
    .handleRaw("responses", () => {
      const holder: EpisodeHolder = { episode: null }
      return guard(responses(holder), holder, (response) => response)
    })
    .handleRaw("messages", () => {
      const holder: EpisodeHolder = { episode: null }
      // Anthropic clients read `{type:"error",error:{type,message}}`, not OpenAI's
      // envelope, so this endpoint renders failures through its own renderer.
      return guard(anthropicMessages(holder), holder, (response) => response, anthropicErrors)
    })
    .handleRaw("models", () => {
      const holder: EpisodeHolder = { episode: null }
      return guard(models, holder, (value) => HttpServerResponse.unsafeJson(value))
    })
    .handleRaw("model", () => {
      const holder: EpisodeHolder = { episode: null }
      return guard(modelCard, holder, (card) => HttpServerResponse.unsafeJson(card))
    })
)
