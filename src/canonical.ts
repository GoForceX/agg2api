/**
 * Canonical chat model — the single pivot format for the whole gateway.
 *
 * Adapters translate between this shape and their upstream protocol. HTTP
 * handlers translate between this shape and the client protocol (Chat
 * Completions or Responses). Nothing else crosses a protocol boundary.
 */
import * as Schema from "effect/Schema"

// --- messages --------------------------------------------------------------

export const TextPart = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String
})

export const ImagePart = Schema.Struct({
  type: Schema.Literal("image_url"),
  image_url: Schema.Struct({
    url: Schema.String,
    detail: Schema.optional(Schema.String)
  })
})

/** Unknown parts (audio, files, provider extensions) survive round-trips untouched. */
export const OpaquePart = Schema.Record({ key: Schema.String, value: Schema.Unknown })

export const ContentPart = Schema.Union(TextPart, ImagePart, OpaquePart)

export const ToolCall = Schema.Struct({
  /** Position in a streaming delta; absent on a complete message. */
  index: Schema.optional(Schema.Number),
  id: Schema.String,
  type: Schema.Literal("function"),
  function: Schema.Struct({
    name: Schema.String,
    arguments: Schema.String
  })
})

export const Message = Schema.Struct({
  role: Schema.Literal("system", "developer", "user", "assistant", "tool"),
  content: Schema.NullOr(Schema.Union(Schema.String, Schema.Array(ContentPart))),
  name: Schema.optional(Schema.String),
  tool_calls: Schema.optional(Schema.Array(ToolCall)),
  tool_call_id: Schema.optional(Schema.String),
  /** DeepSeek-style reasoning trace; preserved so multi-turn replay works. */
  reasoning_content: Schema.optional(Schema.NullOr(Schema.String)),
  refusal: Schema.optional(Schema.NullOr(Schema.String)),
  extras: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown }))
})

export const Tool = Schema.Struct({
  type: Schema.Literal("function"),
  function: Schema.Struct({
    name: Schema.String,
    description: Schema.optional(Schema.String),
    parameters: Schema.optional(Schema.Unknown),
    strict: Schema.optional(Schema.Boolean)
  })
})

export const Usage = Schema.Struct({
  prompt_tokens: Schema.Number,
  completion_tokens: Schema.Number,
  total_tokens: Schema.Number,
  /** Subset of prompt_tokens served from the provider's cache; 0 when unreported. */
  cached_tokens: Schema.Number,
  reasoning_tokens: Schema.Number,
  prompt_tokens_details: Schema.optional(Schema.NullOr(Schema.Record({ key: Schema.String, value: Schema.Unknown }))),
  completion_tokens_details: Schema.optional(Schema.NullOr(Schema.Record({ key: Schema.String, value: Schema.Unknown })))
})

export const EMPTY_USAGE: Usage = {
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
  cached_tokens: 0,
  reasoning_tokens: 0
}

// --- requests / responses --------------------------------------------------

export const ResponseFormat = Schema.Unknown

export const Request = Schema.Struct({
  model: Schema.String,
  messages: Schema.Array(Message),
  stream: Schema.optional(Schema.Boolean),
  stream_options: Schema.optional(
    Schema.NullOr(Schema.Struct({ include_usage: Schema.optional(Schema.Boolean) }))
  ),
  max_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
  max_completion_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
  temperature: Schema.optional(Schema.NullOr(Schema.Number)),
  top_p: Schema.optional(Schema.NullOr(Schema.Number)),
  stop: Schema.optional(Schema.NullOr(Schema.Union(Schema.String, Schema.Array(Schema.String)))),
  presence_penalty: Schema.optional(Schema.NullOr(Schema.Number)),
  frequency_penalty: Schema.optional(Schema.NullOr(Schema.Number)),
  logit_bias: Schema.optional(Schema.NullOr(Schema.Record({ key: Schema.String, value: Schema.Number }))),
  logprobs: Schema.optional(Schema.NullOr(Schema.Boolean)),
  top_logprobs: Schema.optional(Schema.NullOr(Schema.Number)),
  n: Schema.optional(Schema.NullOr(Schema.Number)),
  seed: Schema.optional(Schema.NullOr(Schema.Number)),
  response_format: Schema.optional(Schema.NullOr(ResponseFormat)),
  tools: Schema.optional(Schema.NullOr(Schema.Array(Tool))),
  tool_choice: Schema.optional(Schema.NullOr(Schema.Unknown)),
  parallel_tool_calls: Schema.optional(Schema.NullOr(Schema.Boolean)),
  user: Schema.optional(Schema.NullOr(Schema.String)),
  reasoning_effort: Schema.optional(Schema.NullOr(Schema.String)),
  metadata: Schema.optional(Schema.NullOr(Schema.Record({ key: Schema.String, value: Schema.Unknown })))
})

export const FinishReason = Schema.NullOr(Schema.String)

export const Choice = Schema.Struct({
  index: Schema.Number,
  message: Message,
  finish_reason: FinishReason
})

export const Response = Schema.Struct({
  id: Schema.String,
  object: Schema.Literal("chat.completion"),
  created: Schema.Number,
  model: Schema.String,
  choices: Schema.Array(Choice),
  usage: Schema.NullOr(Usage),
  system_fingerprint: Schema.optional(Schema.NullOr(Schema.String))
})

/** One `chat.completion.chunk` delta. */
export const ChunkDelta = Schema.Struct({
  role: Schema.optional(Schema.String),
  content: Schema.optional(Schema.NullOr(Schema.String)),
  reasoning_content: Schema.optional(Schema.NullOr(Schema.String)),
  tool_calls: Schema.optional(Schema.Array(ToolCall)),
  refusal: Schema.optional(Schema.NullOr(Schema.String))
})

export const Chunk = Schema.Struct({
  id: Schema.String,
  object: Schema.Literal("chat.completion.chunk"),
  created: Schema.Number,
  model: Schema.String,
  choices: Schema.Array(
    Schema.Struct({
      index: Schema.Number,
      delta: ChunkDelta,
      finish_reason: FinishReason
    })
  ),
  usage: Schema.NullOr(Usage)
})

export type TextPart = typeof TextPart.Type
export type ImagePart = typeof ImagePart.Type
export type ContentPart = typeof ContentPart.Type
export type ToolCall = typeof ToolCall.Type
export type Message = typeof Message.Type
export type Tool = typeof Tool.Type
export type Usage = typeof Usage.Type
export type Request = typeof Request.Type
export type Choice = typeof Choice.Type
export type Response = typeof Response.Type
export type ChunkDelta = typeof ChunkDelta.Type
export type Chunk = typeof Chunk.Type
