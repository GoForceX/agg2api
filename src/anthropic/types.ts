/**
 * Anthropic Messages API wire shapes.
 *
 * Anthropic is a *client* protocol for this gateway: requests are read here and
 * converted to the canonical chat model, responses are converted back. The shapes
 * below are therefore the provider's, not a normalised form — in particular
 * `system` is a top-level field rather than a message role, tools are flat
 * (`name`/`input_schema` on the tool, not nested under `function`), and the
 * content of a turn is an array of typed blocks rather than a string.
 *
 * Blocks matter beyond cosmetics: `tool_result` is a *user* block and `tool_use`
 * is an *assistant* block, so a single Anthropic message can expand into several
 * canonical messages (see `convert.ts`).
 */
import * as Schema from "effect/Schema"

// --- content blocks --------------------------------------------------------

export const TextBlock = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String
})

export const Base64ImageSource = Schema.Struct({
  type: Schema.Literal("base64"),
  media_type: Schema.String,
  data: Schema.String
})

export const UrlImageSource = Schema.Struct({
  type: Schema.Literal("url"),
  url: Schema.String
})

export const ImageBlock = Schema.Struct({
  type: Schema.Literal("image"),
  source: Schema.Union(Base64ImageSource, UrlImageSource)
})

export const ToolUseBlock = Schema.Struct({
  type: Schema.Literal("tool_use"),
  id: Schema.String,
  name: Schema.String,
  /** Already-parsed arguments here, unlike OpenAI's JSON string. */
  input: Schema.Record({ key: Schema.String, value: Schema.Unknown })
})

export const ToolResultBlock = Schema.Struct({
  type: Schema.Literal("tool_result"),
  tool_use_id: Schema.String,
  content: Schema.optional(
    Schema.Union(Schema.String, Schema.Array(Schema.Union(TextBlock, ImageBlock)))
  ),
  is_error: Schema.optional(Schema.Boolean)
})

export const ThinkingBlock = Schema.Struct({
  type: Schema.Literal("thinking"),
  thinking: Schema.String,
  signature: Schema.optional(Schema.String)
})

export const AnthropicContentBlock = Schema.Union(
  TextBlock,
  ImageBlock,
  ToolUseBlock,
  ToolResultBlock,
  ThinkingBlock
)

// --- messages --------------------------------------------------------------

export const AnthropicMessage = Schema.Struct({
  role: Schema.Literal("user", "assistant"),
  content: Schema.Union(Schema.String, Schema.Array(AnthropicContentBlock))
})

// --- request ---------------------------------------------------------------

/** A tool, flat: `input_schema` sits on the tool rather than under `function`. */
export const AnthropicTool = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  input_schema: Schema.Record({ key: Schema.String, value: Schema.Unknown })
})

export const AnthropicToolChoice = Schema.Struct({
  type: Schema.Literal("auto", "any", "tool", "none"),
  /** Only meaningful for `type: "tool"`. */
  name: Schema.optional(Schema.String)
})

export const AnthropicThinking = Schema.Struct({
  type: Schema.Literal("enabled", "disabled"),
  budget_tokens: Schema.optional(Schema.Number)
})

export const AnthropicRequest = Schema.Struct({
  model: Schema.String,
  /** Required by Anthropic; there is no "unset" spelling of this field. */
  max_tokens: Schema.Number,
  messages: Schema.Array(AnthropicMessage),
  system: Schema.optional(Schema.Union(Schema.String, Schema.Array(TextBlock))),
  stream: Schema.optional(Schema.Boolean),
  temperature: Schema.optional(Schema.Number),
  top_p: Schema.optional(Schema.Number),
  top_k: Schema.optional(Schema.Number),
  stop_sequences: Schema.optional(Schema.Array(Schema.String)),
  tools: Schema.optional(Schema.Array(AnthropicTool)),
  tool_choice: Schema.optional(AnthropicToolChoice),
  metadata: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  thinking: Schema.optional(AnthropicThinking)
})

// --- response --------------------------------------------------------------

export const AnthropicUsage = Schema.Struct({
  input_tokens: Schema.Number,
  output_tokens: Schema.Number,
  /** Tokens served from the prompt cache; the gateway reports its `cached_tokens` here. */
  cache_read_input_tokens: Schema.optional(Schema.Number),
  cache_creation_input_tokens: Schema.optional(Schema.Number)
})

export const AnthropicResponse = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("message"),
  role: Schema.Literal("assistant"),
  model: Schema.String,
  content: Schema.Array(AnthropicContentBlock),
  stop_reason: Schema.NullOr(Schema.String),
  stop_sequence: Schema.NullOr(Schema.String),
  usage: AnthropicUsage
})

// --- streaming -------------------------------------------------------------

/** The block a stream currently has open; Anthropic streams one at a time. */
export type AnthropicOpenBlock = "text" | "thinking" | "tool_use"

/**
 * One in-flight `tool_use` block, keyed by the upstream tool-call index.
 *
 * The fragments are buffered as well as forwarded because the announcement
 * (`content_block_start`) carries only the id and name: the arguments exist solely
 * as `partial_json` deltas, so a consumer that inspects the state after the stream
 * (the handler's usage accounting, diagnostics) can only see the call whole if it
 * is reassembled here.
 */
export interface AnthropicToolBlockState {
  /** Content-block index, fixed when the block was announced. */
  readonly index: number
  id: string
  name: string
  arguments: string
}

/**
 * Mutable accumulator for one streaming message.
 *
 * Emission is incremental, so identity (block index, whether a block is open) has
 * to live outside the emitted events; mutability is what keeps `chunkToEvents` a
 * pure function of `(chunk, state)` rather than a state machine the caller threads
 * by hand. Anthropic assigns block indices in open order and clients dispatch on
 * them, so `index` is the stream's identity space, not an implementation detail.
 */
export interface AnthropicStreamState {
  readonly id: string
  readonly model: string
  /** Usage seen so far, so `message_start` can report a known input count. */
  usage: AnthropicUsage
  /** Next content-block index; Anthropic numbers blocks contiguously from 0. */
  index: number
  open: AnthropicOpenBlock | null
  /** Index of the open block; meaningless when `open` is null. */
  open_index: number
  /** Upstream tool-call index behind the open block, when it is a `tool_use`. */
  open_tool: number | null
  /** Tool blocks by upstream tool-call index. */
  readonly tools: Map<number, AnthropicToolBlockState>
  /** Mapped from the first `finish_reason` seen; drives the terminal `message_delta`. */
  stop_reason: string
  /** Whether `message_start` has been emitted; it is sent exactly once. */
  started: boolean
}

export type TextBlock = typeof TextBlock.Type
export type Base64ImageSource = typeof Base64ImageSource.Type
export type UrlImageSource = typeof UrlImageSource.Type
export type ImageBlock = typeof ImageBlock.Type
export type ToolUseBlock = typeof ToolUseBlock.Type
export type ToolResultBlock = typeof ToolResultBlock.Type
export type ThinkingBlock = typeof ThinkingBlock.Type
export type AnthropicContentBlock = typeof AnthropicContentBlock.Type
export type AnthropicMessage = typeof AnthropicMessage.Type
export type AnthropicTool = typeof AnthropicTool.Type
export type AnthropicToolChoice = typeof AnthropicToolChoice.Type
export type AnthropicThinking = typeof AnthropicThinking.Type
export type AnthropicRequest = typeof AnthropicRequest.Type
export type AnthropicUsage = typeof AnthropicUsage.Type
export type AnthropicResponse = typeof AnthropicResponse.Type
