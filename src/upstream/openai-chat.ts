/**
 * OpenAI Chat Completions translation, shared by the `openai-chat` and
 * `workbuddy2api` adapters.
 *
 * Both speak the same wire protocol, so the only difference between them is
 * discovery and credits; everything below converts between the canonical model
 * and OpenAI's JSON.
 *
 * Usage normalisation is the delicate part. Providers disagree about how to
 * report cached and reasoning tokens, and the dashboard's cache-rate metric is
 * only meaningful if every provider is read the same way. `normalizeUsage`
 * therefore checks each known spelling rather than assuming one.
 */
import type * as Chat from "../canonical.ts"
import { EMPTY_USAGE } from "../canonical.ts"
import { asRecordArray, firstNumber, isRecord } from "../json.ts"

type Json = Record<string, unknown>

/**
 * Read a usage object from any provider dialect into canonical form.
 *
 * Cached tokens are looked up in prompt-details first, then in the top-level
 * spellings used by DeepSeek (`prompt_cache_hit_tokens`) and Anthropic-style
 * clones (`cache_read_input_tokens`). Copilot-style upstreams report
 * `cached_tokens` directly on the usage object.
 */
export const normalizeUsage = (raw: unknown): Chat.Usage => {
  if (!isRecord(raw)) return { ...EMPTY_USAGE }

  const promptDetails = isRecord(raw.prompt_tokens_details) ? raw.prompt_tokens_details : null
  const completionDetails = isRecord(raw.completion_tokens_details) ? raw.completion_tokens_details : null
  // Some providers nest Anthropic-style counters under `cache_creation`/`cache_read`.
  const cacheRead = isRecord(raw.cache_read) ? raw.cache_read : null

  const prompt = firstNumber(raw.prompt_tokens, raw.input_tokens)
  const completion = firstNumber(raw.completion_tokens, raw.output_tokens)
  const cached = firstNumber(
    promptDetails?.cached_tokens,
    promptDetails?.cache_read_tokens,
    raw.cached_tokens,
    raw.prompt_cache_hit_tokens,
    raw.cache_read_input_tokens,
    cacheRead?.input_tokens
  )
  const reasoning = firstNumber(
    completionDetails?.reasoning_tokens,
    raw.reasoning_tokens,
    raw.completion_thinking_tokens
  )

  // Cached tokens are a subset of the prompt; a provider that reports more than
  // it billed would otherwise push the dashboard's cache rate above 100%.
  const boundedCached = Math.max(0, Math.min(cached, prompt))
  const total = firstNumber(raw.total_tokens, prompt + completion)

  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total === 0 ? prompt + completion : total,
    cached_tokens: boundedCached,
    reasoning_tokens: reasoning,
    prompt_tokens_details: promptDetails,
    completion_tokens_details: completionDetails
  }
}

/** Build the upstream request body from a canonical request. */
export const toUpstreamBody = (
  request: Chat.Request,
  upstreamModel: string,
  options: { stream: boolean }
): Json => {
  const body: Json = {
    model: upstreamModel,
    messages: request.messages.map(toUpstreamMessage),
    stream: options.stream
  }

  if (request.stream_options !== undefined && request.stream_options !== null) {
    body.stream_options = request.stream_options
  }
  if (request.max_completion_tokens !== undefined && request.max_completion_tokens !== null) {
    body.max_completion_tokens = request.max_completion_tokens
  } else if (request.max_tokens !== undefined && request.max_tokens !== null) {
    body.max_tokens = request.max_tokens
  }
  // Spread the remaining optional fields verbatim; `undefined`/`null` are dropped
  // so providers never receive an explicit null they would reject.
  for (const key of [
    "temperature",
    "top_p",
    "stop",
    "presence_penalty",
    "frequency_penalty",
    "logit_bias",
    "logprobs",
    "top_logprobs",
    "n",
    "seed",
    "response_format",
    "tools",
    "tool_choice",
    "parallel_tool_calls",
    "user",
    "reasoning_effort",
    "metadata"
  ] as const) {
    const value = request[key]
    if (value !== undefined && value !== null) body[key] = value
  }
  return body
}

/**
 * Convert a canonical assistant message into OpenAI's message shape.
 *
 * `reasoning_content` is re-emitted because providers that use it expect the
 * trace replayed on the next turn; dropping it degrades multi-turn behaviour on
 * those upstreams.
 */
export const toUpstreamMessage = (message: Chat.Message): Json => {
  const out: Json = { role: message.role, content: message.content }
  if (message.name !== undefined) out.name = message.name
  if (message.tool_calls !== undefined) out.tool_calls = message.tool_calls
  if (message.tool_call_id !== undefined) out.tool_call_id = message.tool_call_id
  if (message.reasoning_content !== undefined && message.reasoning_content !== null) {
    out.reasoning_content = message.reasoning_content
  }
  if (message.refusal !== undefined && message.refusal !== null) out.refusal = message.refusal
  if (message.extras !== undefined) Object.assign(out, message.extras)
  return out
}

/** Convert a provider's OpenAI-shaped response JSON into canonical form. */
export const fromUpstreamResponse = (raw: unknown, fallbackModel: string): Chat.Response => {
  const json = isRecord(raw) ? raw : {}
  const choices = Array.isArray(json.choices) ? json.choices : []
  const model = typeof json.model === "string" && json.model !== "" ? json.model : fallbackModel

  return {
    id: typeof json.id === "string" && json.id !== "" ? json.id : `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: firstNumber(json.created) || Math.floor(Date.now() / 1000),
    model,
    choices: choices.filter(isRecord).map((choice, index) => {
      const message = isRecord(choice.message) ? choice.message : {}
      const content = message.content
      return {
        index: firstNumber(choice.index) || index,
        message: {
          role: "assistant",
          content:
            typeof content === "string" || content === null || Array.isArray(content)
              ? (content as Chat.Message["content"])
              : null,
          tool_calls: Array.isArray(message.tool_calls)
            ? (message.tool_calls as Chat.ToolCall[])
            : undefined,
          reasoning_content:
            typeof message.reasoning_content === "string" ? message.reasoning_content : undefined,
          refusal: typeof message.refusal === "string" ? message.refusal : undefined
        },
        finish_reason: typeof choice.finish_reason === "string" ? choice.finish_reason : null
      }
    }),
    usage: normalizeUsage(json.usage),
    system_fingerprint: typeof json.system_fingerprint === "string" ? json.system_fingerprint : null
  }
}

/**
 * Detect a failure the provider reports *inside* the stream.
 *
 * A provider cannot report a mid-generation failure by status — the 200 and its headers
 * went out with the first chunk — so the ones that do not simply drop the connection
 * send `{"error": {...}}` as a final SSE frame instead. That frame carries no choices, so
 * the chunk converter drops it as "nothing to forward", and the client is left with
 * partial text followed by a clean terminator reading as a complete response.
 *
 * The Anthropic and Responses paths already surface their equivalent
 * (`response.failed`/`response.error`); this is the chat path's missing half.
 */
export const inBandErrorOf = (raw: unknown): { message: string; body: unknown } | null => {
  if (!isRecord(raw)) return null
  const error = raw.error
  if (!isRecord(error)) return null
  const message = typeof error.message === "string" && error.message !== "" ? error.message : null
  const code = typeof error.code === "string" ? error.code : null
  const type = typeof error.type === "string" ? error.type : null
  // Plain `error` objects are how OpenAI-shaped providers report every failure in this
  // position, so any non-empty envelope is treated as one rather than guessing at codes.
  const detail = message ?? code ?? type ?? "upstream reported an error"
  return { message: detail, body: raw }
}

/**
 * Convert one upstream OpenAI chat chunk into canonical form.
 *
 * Returns `null` for chunks that carry nothing the gateway forwards — notably the
 * usage-only chunk a provider emits when `stream_options.include_usage` is set,
 * whose usage is captured separately by the caller.
 */
export const fromUpstreamChunk = (raw: unknown, fallbackModel: string): Chat.Chunk | null => {
  const json = isRecord(raw) ? raw : {}
  const rawChoices = Array.isArray(json.choices) ? json.choices.filter(isRecord) : []
  const model = typeof json.model === "string" && json.model !== "" ? json.model : fallbackModel

  const choices = rawChoices.map((choice, index) => {
    const delta = isRecord(choice.delta) ? choice.delta : {}
    const toolCalls = asRecordArray(delta.tool_calls).map((call, callIndex) => {
        const record = isRecord(call) ? call : {}
        const fn = isRecord(record.function) ? record.function : {}
      return {
        // Providers omit `index` on some frames; falling back to position keeps
        // argument fragments attributable to the right call.
        index: firstNumber(record.index) || callIndex,
        id: typeof record.id === "string" ? record.id : "",
        type: "function" as const,
        function: {
          name: typeof fn.name === "string" ? fn.name : "",
          arguments: typeof fn.arguments === "string" ? fn.arguments : ""
        }
      }
    })

    const normalized: Chat.ChunkDelta = {
      ...(typeof delta.role === "string" ? { role: delta.role } : {}),
      ...(typeof delta.content === "string" || delta.content === null
        ? { content: delta.content as string | null }
        : {}),
      ...(typeof delta.reasoning_content === "string" || delta.reasoning_content === null
        ? { reasoning_content: delta.reasoning_content as string | null }
        : {}),
      ...(typeof delta.refusal === "string" || delta.refusal === null
        ? { refusal: delta.refusal as string | null }
        : {}),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
    }

    return {
      index: firstNumber(choice.index) || index,
      delta: normalized,
      finish_reason: typeof choice.finish_reason === "string" ? choice.finish_reason : null
    }
  })

  const hasUsage = isRecord(json.usage)
  if (choices.length === 0 && !hasUsage) return null

  return {
    id: typeof json.id === "string" && json.id !== "" ? json.id : `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion.chunk",
    created: firstNumber(json.created) || Math.floor(Date.now() / 1000),
    model,
    choices,
    usage: hasUsage ? normalizeUsage(json.usage) : null
  }
}

/** Extract a usage object from a chunk, for the streaming accumulator. */
export const chunkUsage = (chunk: Chat.Chunk): Chat.Usage | null => chunk.usage
