/**
 * OpenAI Responses API wire shapes.
 *
 * The Responses protocol is *item*-oriented where Chat Completions is
 * message-oriented: a turn is a list of typed items (`message`, `function_call`,
 * `reasoning`, `function_call_output`) rather than a list of role-tagged
 * messages, and a tool is described flat instead of nested under `function`.
 * Both differences are what the conversion layer exists to bridge, so the shapes
 * here are deliberately the provider's, not a normalised form.
 *
 * The gateway reads untrusted provider payloads defensively (see `convert.ts`),
 * because providers add fields constantly and a strict parse would turn a
 * harmless addition into an outage.
 */
import * as Schema from "effect/Schema"

// --- content parts ---------------------------------------------------------

export const TextInputPart = Schema.Struct({
  type: Schema.Literal("input_text"),
  text: Schema.String
})

export const ImageInputPart = Schema.Struct({
  type: Schema.Literal("input_image"),
  /** A URL or `data:` URI. Flat here, unlike Chat Completions' nested `image_url`. */
  image_url: Schema.String,
  detail: Schema.optional(Schema.String)
})

export const OutputTextPart = Schema.Struct({
  type: Schema.Literal("output_text"),
  text: Schema.String,
  annotations: Schema.Array(Schema.Unknown)
})

export const RefusalPart = Schema.Struct({
  type: Schema.Literal("refusal"),
  refusal: Schema.String
})

export const ResponsesContentPart = Schema.Union(
  TextInputPart,
  ImageInputPart,
  OutputTextPart,
  RefusalPart
)

// --- input items -----------------------------------------------------------

export const InputMessageItem = Schema.Struct({
  type: Schema.Literal("message"),
  role: Schema.Literal("system", "developer", "user", "assistant"),
  content: Schema.Union(Schema.String, Schema.Array(ResponsesContentPart))
})

export const FunctionCallItem = Schema.Struct({
  type: Schema.Literal("function_call"),
  /** Provider-side item id; absent when a client replays a previous turn. */
  id: Schema.optional(Schema.String),
  call_id: Schema.String,
  name: Schema.String,
  arguments: Schema.String,
  status: Schema.optional(Schema.String)
})

export const FunctionCallOutputItem = Schema.Struct({
  type: Schema.Literal("function_call_output"),
  call_id: Schema.String,
  output: Schema.String
})

export const ReasoningItem = Schema.Struct({
  type: Schema.Literal("reasoning"),
  id: Schema.optional(Schema.String),
  summary: Schema.optional(
    Schema.Array(Schema.Struct({ type: Schema.Literal("summary_text"), text: Schema.String }))
  ),
  content: Schema.optional(
    Schema.Array(Schema.Struct({ type: Schema.Literal("reasoning_text"), text: Schema.String }))
  ),
  /**
   * Opaque provider-encrypted trace. Only the provider that minted it can replay
   * it, so the gateway preserves it verbatim or drops the whole item.
   */
  encrypted_content: Schema.optional(Schema.NullOr(Schema.String))
})

export const ResponsesInputItem = Schema.Union(
  InputMessageItem,
  FunctionCallItem,
  FunctionCallOutputItem,
  ReasoningItem,
  ResponsesContentPart
)

// --- output items ----------------------------------------------------------

const ItemStatus = Schema.Literal("in_progress", "completed", "incomplete")

export const OutputMessageItem = Schema.Struct({
  type: Schema.Literal("message"),
  id: Schema.String,
  role: Schema.Literal("assistant"),
  status: ItemStatus,
  content: Schema.Array(OutputTextPart)
})

export const OutputReasoningItem = Schema.Struct({
  type: Schema.Literal("reasoning"),
  id: Schema.String,
  summary: Schema.Array(Schema.Struct({ type: Schema.Literal("summary_text"), text: Schema.String })),
  content: Schema.Array(Schema.Struct({ type: Schema.Literal("reasoning_text"), text: Schema.String })),
  encrypted_content: Schema.NullOr(Schema.String),
  status: ItemStatus
})

export const OutputFunctionCallItem = Schema.Struct({
  type: Schema.Literal("function_call"),
  id: Schema.String,
  call_id: Schema.String,
  name: Schema.String,
  arguments: Schema.String,
  status: ItemStatus
})

export const ResponsesOutputItem = Schema.Union(
  OutputMessageItem,
  OutputReasoningItem,
  OutputFunctionCallItem
)

// --- request ---------------------------------------------------------------

/** A tool, flat: `name`/`parameters` sit on the tool, not under `function`. */
export const ResponsesTool = Schema.Struct({
  type: Schema.Literal("function"),
  name: Schema.String,
  description: Schema.optional(Schema.String),
  parameters: Schema.optional(Schema.Unknown),
  strict: Schema.optional(Schema.Boolean)
})

export const ResponsesReasoning = Schema.Struct({
  effort: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.String)
})

/** `text.format` replaces Chat Completions' `response_format`. */
export const ResponsesTextFormat = Schema.Struct({
  type: Schema.Literal("text", "json_object", "json_schema"),
  name: Schema.optional(Schema.String),
  schema: Schema.optional(Schema.Unknown),
  strict: Schema.optional(Schema.Boolean)
})

export const ResponsesText = Schema.Struct({
  format: Schema.optional(ResponsesTextFormat)
})

export const ResponsesRequest = Schema.Struct({
  model: Schema.String,
  input: Schema.Union(Schema.String, Schema.Array(ResponsesInputItem)),
  instructions: Schema.optional(Schema.NullOr(Schema.String)),
  stream: Schema.optional(Schema.Boolean),
  max_output_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
  temperature: Schema.optional(Schema.NullOr(Schema.Number)),
  top_p: Schema.optional(Schema.NullOr(Schema.Number)),
  tools: Schema.optional(Schema.Array(ResponsesTool)),
  tool_choice: Schema.optional(Schema.Unknown),
  parallel_tool_calls: Schema.optional(Schema.Boolean),
  reasoning: Schema.optional(ResponsesReasoning),
  text: Schema.optional(ResponsesText),
  store: Schema.optional(Schema.Boolean),
  previous_response_id: Schema.optional(Schema.NullOr(Schema.String)),
  metadata: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  user: Schema.optional(Schema.String)
})

// --- response --------------------------------------------------------------

export const ResponsesUsage = Schema.Struct({
  input_tokens: Schema.Number,
  input_tokens_details: Schema.Struct({ cached_tokens: Schema.Number }),
  output_tokens: Schema.Number,
  output_tokens_details: Schema.Struct({ reasoning_tokens: Schema.Number }),
  total_tokens: Schema.Number
})

export const ResponsesResponse = Schema.Struct({
  id: Schema.String,
  object: Schema.Literal("response"),
  created_at: Schema.Number,
  status: Schema.Literal("in_progress", "completed", "incomplete", "failed"),
  model: Schema.String,
  output: Schema.Array(ResponsesOutputItem),
  output_text: Schema.optional(Schema.String),
  usage: Schema.NullOr(ResponsesUsage),
  /** Echoed request fields, so a client can match a response to its request. */
  instructions: Schema.optional(Schema.NullOr(Schema.String)),
  max_output_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
  temperature: Schema.optional(Schema.NullOr(Schema.Number)),
  top_p: Schema.optional(Schema.NullOr(Schema.Number)),
  tools: Schema.optional(Schema.Array(ResponsesTool)),
  tool_choice: Schema.optional(Schema.Unknown),
  parallel_tool_calls: Schema.optional(Schema.Boolean),
  reasoning: Schema.optional(ResponsesReasoning),
  text: Schema.optional(ResponsesText),
  store: Schema.optional(Schema.Boolean),
  previous_response_id: Schema.optional(Schema.NullOr(Schema.String)),
  metadata: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  user: Schema.optional(Schema.String),
  error: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        code: Schema.String,
        message: Schema.String
      })
    )
  )
})

// --- streaming -------------------------------------------------------------

/**
 * Mutable accumulator for one streaming response.
 *
 * Events are emitted incrementally, so each one must be able to name the item and
 * output index it belongs to; those indices exist only as they are assigned, in
 * arrival order. Identity (`sequence`) therefore has to live outside the emitted
 * events, and mutability is what keeps `chunkToEvents` a pure function of
 * `(chunk, state)` rather than a state machine the caller has to thread.
 */
export interface ResponsesStreamState {
  readonly id: string
  readonly model: string
  readonly created: number
  /** Next `sequence_number`; every emitted event takes one and increments it. */
  sequence: number
  /** Whether the one-shot `response.created` event has been emitted. */
  started: boolean
  /** Items completed so far, in output order. */
  output: Array<Record<string, unknown>>
  /** Message item state: assigned lazily, when the first content arrives. */
  message_id: string | null
  message_index: number | null
  message_text: string
  /** Reasoning item state, assigned when the first reasoning delta arrives. */
  reasoning_id: string | null
  reasoning_index: number | null
  reasoning_text: string
  /** Open function calls, keyed by the upstream tool-call index. */
  readonly calls: Map<number, FunctionCallState>
  /** Whether the terminal `response.completed` event has been emitted. */
  completed: boolean
}

/**
 * One in-flight `function_call` output item.
 *
 * `call_id` and `name` are mutable because some providers send them only on a
 * later fragment of the same call, after the item has already been announced.
 */
export interface FunctionCallState {
  readonly id: string
  call_id: string
  name: string
  arguments: string
  readonly output_index: number
}

export type TextInputPart = typeof TextInputPart.Type
export type ImageInputPart = typeof ImageInputPart.Type
export type OutputTextPart = typeof OutputTextPart.Type
export type ResponsesContentPart = typeof ResponsesContentPart.Type
export type InputMessageItem = typeof InputMessageItem.Type
export type FunctionCallItem = typeof FunctionCallItem.Type
export type FunctionCallOutputItem = typeof FunctionCallOutputItem.Type
export type ReasoningItem = typeof ReasoningItem.Type
export type ResponsesInputItem = typeof ResponsesInputItem.Type
export type OutputMessageItem = typeof OutputMessageItem.Type
export type OutputReasoningItem = typeof OutputReasoningItem.Type
export type OutputFunctionCallItem = typeof OutputFunctionCallItem.Type
export type ResponsesOutputItem = typeof ResponsesOutputItem.Type
export type ResponsesTool = typeof ResponsesTool.Type
export type ResponsesReasoning = typeof ResponsesReasoning.Type
export type ResponsesTextFormat = typeof ResponsesTextFormat.Type
export type ResponsesText = typeof ResponsesText.Type
export type ResponsesRequest = typeof ResponsesRequest.Type
export type ResponsesUsage = typeof ResponsesUsage.Type
export type ResponsesResponse = typeof ResponsesResponse.Type
