/**
 * Responses ⇄ canonical chat translation.
 *
 * Everything here is a plain function: no Effect, no HTTP, no clock beyond
 * `Date.now()` for the two fields the protocols require (`created_at`,
 * `created`). That is deliberate — the protocol bridge is the part most likely to
 * be wrong and the part hardest to observe in production, so it is kept
 * separable and directly testable.
 *
 * The directions are deliberately asymmetric. Reading a Responses body is
 * defensive: an unrecognised item is dropped rather than fatal, because providers
 * add item types faster than the gateway can model them. Writing one is
 * prescriptive: the emitted stream must satisfy clients that validate event
 * ordering and `sequence_number` contiguity.
 */
import * as Stream from "effect/Stream"
import type * as Chat from "../canonical.ts"
import { EMPTY_USAGE } from "../canonical.ts"
import type { ProviderError } from "../errors.ts"
import type { UsageAccumulator } from "../gateway/accounting.ts"
import { asNumber, asRecordArray, asString, isRecord } from "../json.ts"
import { normalizeUsage } from "../upstream/openai-chat.ts"
import type {
  FunctionCallState,
  OutputFunctionCallItem,
  OutputMessageItem,
  OutputReasoningItem,
  ResponsesOutputItem,
  ResponsesRequest,
  ResponsesResponse,
  ResponsesStreamState,
  ResponsesUsage
} from "./types.ts"

type Json = Record<string, unknown>

/** Read an untrusted value as a record without casting. */
const recordOf = (value: unknown): Json => (isRecord(value) ? value : {})

const textOf = (value: unknown): string => (typeof value === "string" ? value : "")

/** Concatenate the text parts of a Responses part array, ignoring other kinds. */
const partsText = (parts: unknown): string =>
  asRecordArray(parts)
    .map((part) => textOf(part.text))
    .join("")

const itemId = (prefix: string): string => `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`

// ---------------------------------------------------------------------------
// Request: Responses body → canonical chat request
// ---------------------------------------------------------------------------

/**
 * Convert one Responses content-part array into canonical content parts.
 *
 * `input_image` is flat (`image_url` is the string itself) while canonical
 * `ImagePart` nests it, so images must be reshaped rather than copied. Unknown
 * part types survive as opaque records: dropping them would silently discard,
 * say, a file attachment the caller believes it sent.
 */
const toContentParts = (content: unknown): Chat.Message["content"] => {
  if (typeof content === "string") return content
  return asRecordArray(content).map((part): Chat.ContentPart => {
    const type = textOf(part.type)
    if (type === "input_text" || type === "output_text" || type === "text") {
      return { type: "text", text: textOf(part.text) }
    }
    if (type === "input_image") {
      const detail = asString(part.detail)
      const url = textOf(part.image_url)
      return {
        type: "image_url",
        image_url: detail === null ? { url } : { url, detail }
      }
    }
    return { ...part }
  })
}

/** Content-part types that stand alone as an input item, with no container. */
const CONTENT_PART_TYPES: Record<string, true> = {
  input_text: true,
  input_image: true,
  output_text: true,
  text: true
}

const isContentPart = (type: string): boolean => CONTENT_PART_TYPES[type] === true

/**
 * Turn the `input` field into canonical messages.
 *
 * A Responses turn is a flat item list, so the Chat form only appears once runs
 * of `function_call` items are folded into a single assistant message carrying
 * `tool_calls`; a tool result that arrived before those calls were flushed would
 * otherwise be orphaned from the call it answers. Reasoning items are dropped —
 * canonical chat has no place for them — but their `encrypted_content` is carried
 * on the following assistant message's `extras`, because a client replaying a
 * turn hands back the blob the provider minted and expects it forwarded intact.
 */
const toMessages = (input: unknown): Array<Chat.Message> => {
  const messages: Array<Chat.Message> = []
  let calls: Array<Chat.ToolCall> = []
  let encrypted: string | null = null

  const flush = (): void => {
    if (calls.length === 0) return
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: calls,
      ...(encrypted === null ? {} : { extras: { encrypted_content: encrypted } })
    })
    calls = []
    encrypted = null
  }

  if (typeof input === "string") {
    if (input !== "") messages.push({ role: "user", content: input })
    return messages
  }

  for (const item of asRecordArray(input)) {
    const type = textOf(item.type)
    if (type === "function_call") {
      const callId = asString(item.call_id) ?? asString(item.id)
      calls.push({
        id: callId ?? itemId("call"),
        type: "function",
        function: { name: textOf(item.name), arguments: textOf(item.arguments) }
      })
      continue
    }
    if (type === "function_call_output") {
      flush()
      messages.push({
        role: "tool",
        content: typeof item.output === "string" ? item.output : partsText(item.output),
        tool_call_id: textOf(item.call_id)
      })
      continue
    }
    if (type === "reasoning") {
      const blob = asString(item.encrypted_content)
      if (blob !== null) encrypted = blob
      continue
    }
    if (type === "message") {
      flush()
      const role = textOf(item.role)
      messages.push({
        role: role === "system" || role === "developer" || role === "assistant" ? role : "user",
        content: toContentParts(item.content)
      })
      continue
    }
    if (isContentPart(type)) {
      flush()
      messages.push({ role: "user", content: toContentParts([item]) })
      continue
    }
    // An unknown item type carries no canonical meaning; forwarding it would risk
    // a malformed upstream request, so it is dropped.
  }
  flush()
  return messages
}

/**
 * Convert a Responses tool (flat) into the canonical tool (nested).
 *
 * The nesting is not cosmetic: upstream chat providers reject the flat form, and
 * silently forwarding it turns a tools request into a 400 from a provider whose
 * message does not mention tools at all.
 */
const toChatTool = (tool: Record<string, unknown>): Chat.Tool => ({
  type: "function",
  function: {
    name: textOf(tool.name),
    ...(asString(tool.description) === null ? {} : { description: textOf(tool.description) }),
    ...(tool.parameters === undefined ? {} : { parameters: tool.parameters }),
    ...(typeof tool.strict === "boolean" ? { strict: tool.strict } : {})
  }
})

/** `text.format` → `response_format`, but only for the structured types. */
const toResponseFormat = (format: unknown): unknown => {
  const value = recordOf(format)
  const type = textOf(value.type)
  if (type === "json_object") return { type: "json_object" }
  if (type === "json_schema") {
    const name = asString(value.name)
    return {
      type: "json_schema",
      json_schema: {
        ...(name === null ? {} : { name }),
        schema: value.schema,
        ...(typeof value.strict === "boolean" ? { strict: value.strict } : {})
      }
    }
  }
  return undefined
}

const toChatToolChoice = (choice: unknown): unknown => {
  const value = recordOf(choice)
  if (textOf(value.type) !== "function") return choice
  const name = asString(value.name) ?? asString(recordOf(value.function).name)
  return name === null ? "auto" : { type: "function", function: { name } }
}

/**
 * Convert a client Responses request into a canonical chat request.
 *
 * The returned `model` is the public id the caller asked for; the router renames
 * it to a provider-side id later, so this must not consult any mapping.
 */
export const toCanonical = (request: ResponsesRequest): { request: Chat.Request; model: string } => {
  const raw = recordOf(request)
  const messages = toMessages(raw.input)
  const instructions = asString(raw.instructions)
  if (instructions !== null) messages.unshift({ role: "system", content: instructions })

  const reasoning = isRecord(raw.reasoning) ? raw.reasoning : null
  const effort = reasoning === null ? null : asString(reasoning.effort)
  const format = isRecord(raw.text) ? toResponseFormat(raw.text.format) : undefined
  const maxOutput = asNumber(raw.max_output_tokens)
  const temperature = asNumber(raw.temperature)
  const topP = asNumber(raw.top_p)
  const user = asString(raw.user)
  const toolChoice = raw.tool_choice === undefined ? undefined : toChatToolChoice(raw.tool_choice)

  const chat: Chat.Request = {
    model: textOf(raw.model),
    messages,
    stream: raw.stream === true,
    ...(maxOutput === null ? {} : { max_completion_tokens: maxOutput }),
    ...(temperature === null ? {} : { temperature }),
    ...(topP === null ? {} : { top_p: topP }),
    ...(Array.isArray(raw.tools) ? { tools: asRecordArray(raw.tools).map(toChatTool) } : {}),
    ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
    ...(typeof raw.parallel_tool_calls === "boolean"
      ? { parallel_tool_calls: raw.parallel_tool_calls }
      : {}),
    ...(effort === null ? {} : { reasoning_effort: effort }),
    ...(format === undefined ? {} : { response_format: format }),
    ...(user === null ? {} : { user }),
    ...(isRecord(raw.metadata) ? { metadata: raw.metadata } : {})
  }
  return { request: chat, model: chat.model }
}

/**
 * The entry point the HTTP handler uses: a raw Responses body in, a canonical
 * request out, with the caller's public model name authoritative over whatever
 * the body claimed.
 */
export const toResponsesRequest = (body: unknown, model: string): Chat.Request => {
  // `body` is the client's raw JSON; every field below is read defensively, so
  // the cast only names the shape being interpreted.
  const request = body as ResponsesRequest
  return { ...toCanonical(request).request, model }
}

/**
 * The reverse direction, for the adapter: a canonical request as the *upstream*
 * Responses body.
 *
 * Canonical content parts become `input_*` parts (the output-only `output_text`
 * type is rejected on input by OpenAI), and system turns are lifted into
 * `instructions` because a Responses `input` has no system role.
 */
export const toResponsesBody = (request: Chat.Request, model: string): Record<string, unknown> => {
  const input: Array<Json> = []
  const instructions: Array<string> = []

  const asContent = (content: Chat.Message["content"]): unknown => {
    if (typeof content === "string") return content
    if (content === null) return ""
    return content.map((part): Json => {
      const record = recordOf(part)
      const type = textOf(record.type)
      if (type === "image_url") {
        const image = recordOf(record.image_url)
        const detail = asString(image.detail)
        return {
          type: "input_image",
          image_url: textOf(image.url),
          ...(detail === null ? {} : { detail })
        }
      }
      if (type === "text") return { type: "input_text", text: textOf(record.text) }
      return record
    })
  }

  for (const message of request.messages) {
    if (message.role === "system" || message.role === "developer") {
      const text = typeof message.content === "string" ? message.content : partsText(message.content)
      if (text !== "") instructions.push(text)
      continue
    }
    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.tool_call_id ?? "",
        output: typeof message.content === "string" ? message.content : partsText(message.content)
      })
      continue
    }
    // An assistant turn's text can arrive as a content-part array (a client echoing back
    // what it received), so it needs the same extraction the `system` and `tool` branches
    // use — otherwise the turn is dropped and two user turns become adjacent.
    const text = typeof message.content === "string" ? message.content : partsText(message.content)
    if (message.role === "assistant") {
      // Text precedes the calls it accompanies, matching how the items are read
      // back on the next turn.
      if (text !== "") {
        input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text }] })
      }
      for (const call of message.tool_calls ?? []) {
        input.push({
          type: "function_call",
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments
        })
      }
      continue
    }
    input.push({ type: "message", role: "user", content: asContent(message.content) })
  }

  const body: Json = { model, input }
  if (instructions.length > 0) body.instructions = instructions.join("\n\n")
  if (request.max_completion_tokens !== undefined && request.max_completion_tokens !== null) {
    body.max_output_tokens = request.max_completion_tokens
  } else if (request.max_tokens !== undefined && request.max_tokens !== null) {
    body.max_output_tokens = request.max_tokens
  }
  if (request.temperature !== undefined && request.temperature !== null) body.temperature = request.temperature
  if (request.top_p !== undefined && request.top_p !== null) body.top_p = request.top_p
  if (request.parallel_tool_calls !== undefined && request.parallel_tool_calls !== null) {
    body.parallel_tool_calls = request.parallel_tool_calls
  }
  if (request.user !== undefined && request.user !== null) body.user = request.user
  if (request.metadata !== undefined && request.metadata !== null) body.metadata = request.metadata
  if (request.reasoning_effort !== undefined && request.reasoning_effort !== null) {
    body.reasoning = { effort: request.reasoning_effort }
  }
  if (request.tools !== undefined && request.tools !== null) {
    // Tools are flat on the wire, so the nesting has to be undone here.
    body.tools = request.tools.map((tool) => ({
      type: "function",
      name: tool.function.name,
      ...(tool.function.description === undefined ? {} : { description: tool.function.description }),
      ...(tool.function.parameters === undefined ? {} : { parameters: tool.function.parameters }),
      ...(tool.function.strict === undefined ? {} : { strict: tool.function.strict })
    }))
  }
  if (request.tool_choice !== undefined && request.tool_choice !== null) {
    const choice = recordOf(request.tool_choice)
    body.tool_choice =
      textOf(choice.type) === "function"
        ? { type: "function", name: textOf(recordOf(choice.function).name) }
        : request.tool_choice
  }
  const format = recordOf(request.response_format)
  const formatType = textOf(format.type)
  if (formatType === "json_object") body.text = { format: { type: "json_object" } }
  else if (formatType === "json_schema") {
    const schema = recordOf(format.json_schema)
    body.text = {
      format: {
        type: "json_schema",
        ...(asString(schema.name) === null ? {} : { name: asString(schema.name) }),
        schema: schema.schema,
        ...(typeof schema.strict === "boolean" ? { strict: schema.strict } : {})
      }
    }
  }
  return body
}

// ---------------------------------------------------------------------------
// Response: canonical chat response → Responses body
// ---------------------------------------------------------------------------

/** Canonical usage → Responses usage, including both detail sub-objects. */
export const toResponsesUsage = (usage: Chat.Usage): ResponsesUsage => ({
  input_tokens: usage.prompt_tokens,
  input_tokens_details: { cached_tokens: usage.cached_tokens },
  output_tokens: usage.completion_tokens,
  output_tokens_details: { reasoning_tokens: usage.reasoning_tokens },
  total_tokens: usage.total_tokens
})

/**
 * Responses usage → canonical usage, via the shared normaliser.
 *
 * Folding the Responses spellings into the chat ones before normalising keeps one
 * definition of "cached" and "reasoning" tokens for every provider the dashboard
 * reads, rather than a second definition that drifts.
 */
export const fromResponsesUsage = (raw: unknown): Chat.Usage => {
  const value = recordOf(raw)
  if (Object.keys(value).length === 0) return { ...EMPTY_USAGE }
  const input = isRecord(value.input_tokens_details) ? value.input_tokens_details : null
  const output = isRecord(value.output_tokens_details) ? value.output_tokens_details : null
  return normalizeUsage({
    prompt_tokens: value.input_tokens,
    completion_tokens: value.output_tokens,
    total_tokens: value.total_tokens,
    ...(input === null ? {} : { prompt_tokens_details: { cached_tokens: input.cached_tokens } }),
    ...(output === null ? {} : { completion_tokens_details: { reasoning_tokens: output.reasoning_tokens } })
  })
}

const outputMessage = (text: string): OutputMessageItem => ({
  type: "message",
  id: itemId("msg"),
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text, annotations: [] }]
})

const outputReasoning = (text: string): OutputReasoningItem => ({
  type: "reasoning",
  id: itemId("rs"),
  summary: [{ type: "summary_text", text }],
  content: [],
  encrypted_content: null,
  status: "completed"
})

const outputFunctionCall = (call: Chat.ToolCall): OutputFunctionCallItem => ({
  type: "function_call",
  id: call.id === "" ? itemId("fc") : call.id,
  call_id: call.id === "" ? itemId("call") : call.id,
  name: call.function.name,
  arguments: call.function.arguments,
  status: "completed"
})

/**
 * Build a Responses body from a canonical response.
 *
 * Output order matters: a reasoning item is placed *before* the message it
 * explains, because clients render items in order and a reasoning item after the
 * text reads as commentary on a turn that has already finished.
 */
export const toResponses = (
  response: Chat.Response,
  opts: { id: string; model: string; created: number }
): ResponsesResponse => {
  const message = response.choices[0]?.message
  const content = typeof message?.content === "string" ? message.content : ""
  const calls = message?.tool_calls ?? []
  const output: Array<ResponsesOutputItem> = []

  if (typeof message?.reasoning_content === "string" && message.reasoning_content !== "") {
    output.push(outputReasoning(message.reasoning_content))
  }
  // A turn that only called tools still gets its (empty) message item: clients
  // index output by item and expect a stable shape across turns.
  if (content !== "" || calls.length === 0) output.push(outputMessage(content))
  for (const call of calls) output.push(outputFunctionCall(call))

  return {
    id: opts.id,
    object: "response",
    created_at: opts.created,
    status: "completed",
    model: opts.model,
    output,
    output_text: content,
    usage: toResponsesUsage(response.usage ?? { ...EMPTY_USAGE })
  }
}

// ---------------------------------------------------------------------------
// Response: Responses body → canonical chat response (upstream direction)
// ---------------------------------------------------------------------------

/**
 * Read a provider's Responses payload into canonical form.
 *
 * Everything unknown is tolerated: a provider that adds an item type or omits
 * `usage` must still yield a usable response, because the alternative is failing a
 * request the provider actually served.
 */
export const fromResponses = (raw: unknown, model: string): Chat.Response => {
  const json = recordOf(raw)
  const text: Array<string> = []
  const reasoning: Array<string> = []
  const calls: Array<Chat.ToolCall> = []
  let refusal: string | null = null

  for (const item of asRecordArray(json.output)) {
    const type = textOf(item.type)
    if (type === "message") {
      for (const part of asRecordArray(item.content)) {
        const partType = textOf(part.type)
        if (partType === "refusal") refusal = textOf(part.refusal)
        else if (isContentPart(partType)) text.push(textOf(part.text))
      }
      continue
    }
    if (type === "reasoning") {
      const summary = partsText(item.summary)
      const body = partsText(item.content)
      const joined = summary === "" ? body : summary
      if (joined !== "") reasoning.push(joined)
      continue
    }
    if (type === "function_call") {
      calls.push({
        // `call_id` is what a replayed turn refers to; the item id is the only
        // fallback when an aggregator omits it.
        id: asString(item.call_id) ?? textOf(item.id),
        type: "function",
        function: { name: textOf(item.name), arguments: textOf(item.arguments) }
      })
    }
  }

  return {
    id: asString(json.id) ?? `resp_${crypto.randomUUID()}`,
    object: "chat.completion",
    created: asNumber(json.created_at) ?? Math.floor(Date.now() / 1000),
    model: asString(json.model) ?? model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text.length === 0 ? null : text.join(""),
          ...(reasoning.length === 0 ? {} : { reasoning_content: reasoning.join("") }),
          ...(refusal === null ? {} : { refusal }),
          ...(calls.length === 0 ? {} : { tool_calls: calls })
        },
        finish_reason: calls.length > 0 ? "tool_calls" : "stop"
      }
    ],
    usage: fromResponsesUsage(json.usage)
  }
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

export const newStreamState = (id: string, model: string): ResponsesStreamState => ({
  id,
  model,
  created: Math.floor(Date.now() / 1000),
  sequence: 0,
  started: false,
  output: [],
  message_id: null,
  message_index: null,
  message_text: "",
  reasoning_id: null,
  reasoning_index: null,
  reasoning_text: "",
  calls: new Map<number, FunctionCallState>(),
  completed: false
})

/** Every event takes the next sequence number; contiguity is a client contract. */
const take = (state: ResponsesStreamState): number => state.sequence++

const functionCallItem = (call: FunctionCallState, status: "in_progress" | "completed"): Json => ({
  type: "function_call",
  id: call.id,
  call_id: call.call_id,
  name: call.name,
  arguments: call.arguments,
  status
})

/**
 * Announce a function-call item the first time its index is seen.
 *
 * Argument fragments arrive spread across chunks and only the first one carries
 * the id and name, so the item is opened once and later fragments attach to it by
 * index. `output_index` is allocated here, at announcement time, because that is
 * the only moment at which the position in `output` is known.
 */
const openCall = (
  state: ResponsesStreamState,
  fragment: Chat.ToolCall,
  index: number,
  events: Array<Json>
): FunctionCallState => {
  const existing = state.calls.get(index)
  if (existing !== undefined) {
    if (existing.name === "") existing.name = fragment.function.name
    if (existing.call_id === "" && fragment.id !== "") existing.call_id = fragment.id
    return existing
  }
  const call: FunctionCallState = {
    id: itemId("fc"),
    call_id: fragment.id,
    name: fragment.function.name,
    arguments: "",
    output_index: state.output.length
  }
  state.calls.set(index, call)
  state.output.push(functionCallItem(call, "in_progress"))
  events.push({
    type: "response.output_item.added",
    sequence_number: take(state),
    output_index: call.output_index,
    item: functionCallItem(call, "in_progress")
  })
  return call
}

/** The upstream tool-call index, falling back to position when unlabelled. */
const callIndex = (call: Chat.ToolCall, position: number): number =>
  asNumber(recordOf(call).index) ?? position

/**
 * Translate one canonical chunk into the Responses events it implies.
 *
 * The accumulator is mutated because item identity is assigned lazily, on the
 * first delta that needs it: the message item cannot exist before its first text
 * arrives, yet every later delta of that same turn must name the id and index
 * chosen then.
 */
export const chunkToEvents = (
  chunk: Chat.Chunk,
  state: ResponsesStreamState
): ReadonlyArray<Record<string, unknown>> => {
  const events: Array<Json> = []
  if (!state.started) {
    state.started = true
    events.push({
      type: "response.created",
      sequence_number: take(state),
      response: {
        id: state.id,
        object: "response",
        created_at: state.created,
        status: "in_progress",
        model: state.model,
        output: []
      }
    })
  }

  for (const choice of chunk.choices) {
    const delta = choice.delta

    const reasoning = delta.reasoning_content
    if (typeof reasoning === "string" && reasoning !== "") {
      if (state.reasoning_id === null) {
        state.reasoning_id = itemId("rs")
        state.reasoning_index = state.output.length
        state.output.push({
          type: "reasoning",
          id: state.reasoning_id,
          summary: [],
          content: [],
          encrypted_content: null,
          status: "in_progress"
        })
        events.push({
          type: "response.output_item.added",
          sequence_number: take(state),
          output_index: state.reasoning_index,
          item: state.output[state.reasoning_index] ?? {}
        })
      }
      state.reasoning_text += reasoning
      events.push({
        type: "response.reasoning_summary_text.delta",
        sequence_number: take(state),
        item_id: state.reasoning_id,
        output_index: state.reasoning_index,
        summary_index: 0,
        delta: reasoning
      })
    }

    const content = delta.content
    if (typeof content === "string" && content !== "") {
      if (state.message_id === null) {
        state.message_id = itemId("msg")
        state.message_index = state.output.length
        state.output.push({
          type: "message",
          id: state.message_id,
          role: "assistant",
          status: "in_progress",
          content: []
        })
        events.push({
          type: "response.output_item.added",
          sequence_number: take(state),
          output_index: state.message_index,
          item: state.output[state.message_index] ?? {}
        })
        events.push({
          type: "response.content_part.added",
          sequence_number: take(state),
          item_id: state.message_id,
          output_index: state.message_index,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] }
        })
      }
      state.message_text += content
      events.push({
        type: "response.output_text.delta",
        sequence_number: take(state),
        item_id: state.message_id,
        output_index: state.message_index,
        content_index: 0,
        delta: content
      })
    }

    for (const [position, fragment] of (delta.tool_calls ?? []).entries()) {
      const call = openCall(state, fragment, callIndex(fragment, position), events)
      const fragmentText = fragment.function.arguments
      if (fragmentText === "") continue
      call.arguments += fragmentText
      events.push({
        type: "response.function_call_arguments.delta",
        sequence_number: take(state),
        item_id: call.id,
        output_index: call.output_index,
        delta: fragmentText
      })
    }
  }
  return events
}

/** Replace in-progress placeholders with the finished items, preserving order. */
const finalizedItems = (state: ResponsesStreamState): Array<Json> => {
  const byIndex = new Map<number, FunctionCallState>()
  for (const call of state.calls.values()) byIndex.set(call.output_index, call)

  return state.output.map((item, index) => {
    if (index === state.reasoning_index) {
      return {
        type: "reasoning",
        id: state.reasoning_id,
        summary: state.reasoning_text === "" ? [] : [{ type: "summary_text", text: state.reasoning_text }],
        content: [],
        encrypted_content: null,
        status: "completed"
      }
    }
    if (index === state.message_index) {
      return {
        type: "message",
        id: state.message_id,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: state.message_text, annotations: [] }]
      }
    }
    const call = byIndex.get(index)
    return call === undefined ? item : functionCallItem(call, "completed")
  })
}

const terminalEvent = (state: ResponsesStreamState, usage: Chat.Usage, sequence: number): Json => ({
  type: "response.completed",
  sequence_number: sequence,
  response: {
    id: state.id,
    object: "response",
    created_at: state.created,
    status: "completed",
    model: state.model,
    output: finalizedItems(state),
    usage: toResponsesUsage(usage)
  }
})

/**
 * The terminal event, emitted exactly once.
 *
 * Idempotent so a caller that completes both on the upstream's own terminal frame
 * and at end-of-stream cannot consume two sequence numbers or emit two finals.
 */
export const completedEvent = (
  state: ResponsesStreamState,
  usage: Chat.Usage
): Record<string, unknown> => {
  if (state.completed) return terminalEvent(state, usage, Math.max(0, state.sequence - 1))
  state.completed = true
  return terminalEvent(state, usage, take(state))
}

/**
 * Tool-call identity learned from `response.output_item.added`.
 *
 * The delta that follows carries only the item id, so without this the function name
 * and `call_id` are unrecoverable: the name appears nowhere else in the stream, and
 * `call_id` (what a replayed `tool_result` must reference) is distinct from the item id.
 */
export type PendingToolCall = { readonly name: string; readonly call_id: string }

/**
 * Translate one Responses event back into a canonical chunk.
 *
 * Only the delta events carry chat-shaped information. The terminal
 * `response.completed` is the exception: its usage is the only place a Responses
 * stream reports billing.
 *
 * `pending` accumulates the state the delta events omit — which tools have been
 * announced, and under what name and call id. It is mutated rather than returned
 * because events are processed in one ordered pass, and it is required rather than
 * defaulted so a caller cannot silently lose tool identity by re-creating it per event.
 */
export const eventsToChunk = (
  event: Record<string, unknown>,
  model: string,
  pending: Map<string, PendingToolCall>
): Chat.Chunk | null => {
  const type = textOf(event.type)
  const delta = textOf(event.delta)
  const created = Math.floor(Date.now() / 1000)
  const id = asString(event.item_id)

  // Names the tool before any argument fragment arrives. Returning null keeps the
  // item envelope out of the chunk stream, so usage is still counted exactly once.
  if (type === "response.output_item.added") {
    const item = recordOf(event.item)
    const itemId = asString(item.id)
    if (textOf(item.type) === "function_call" && itemId !== null) {
      pending.set(itemId, {
        name: asString(item.name) ?? "",
        // `call_id` is what the upstream expects echoed back; the item id is a fallback
        // for providers that omit it.
        call_id: asString(item.call_id) ?? itemId
      })
    }
    return null
  }

  if (type === "response.output_text.delta") {
    return {
      id: id ?? `resp_${crypto.randomUUID()}`,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
      usage: null
    }
  }
  if (type === "response.reasoning_summary_text.delta") {
    return {
      id: id ?? `resp_${crypto.randomUUID()}`,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { reasoning_content: delta }, finish_reason: null }],
      usage: null
    }
  }
  if (type === "response.function_call_arguments.delta") {
    const index = asNumber(event.output_index) ?? 0
    const announced = id === null ? undefined : pending.get(id)
    return {
      id: id ?? `resp_${crypto.randomUUID()}`,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index,
                id: announced?.call_id ?? id ?? "",
                type: "function",
                function: { name: announced?.name ?? "", arguments: delta }
              }
            ] as Chat.ToolCall[]
          },
          finish_reason: null
        }
      ],
      usage: null
    }
  }
  if (type === "response.completed") {
    const response = recordOf(event.response)
    // A Responses stream reports the tool-call ending only here, so the finish reason
    // has to be derived now. Without it an Anthropic client sees `end_turn` on a turn
    // that requires a tool and stops instead of executing it.
    const calledTool = asRecordArray(response.output).some((item) => textOf(item.type) === "function_call")
    return {
      id: asString(response.id) ?? `resp_${crypto.randomUUID()}`,
      object: "chat.completion.chunk",
      created: asNumber(response.created_at) ?? created,
      model: asString(response.model) ?? model,
      choices: calledTool
        ? [{ index: 0, delta: {}, finish_reason: "tool_calls" }]
        : [],
      usage: fromResponsesUsage(response.usage)
    }
  }
  return null
}

/**
 * Canonical chunk stream → Responses SSE payloads, for a caller that asked to
 * stream.
 *
 * The accumulator is fed here rather than by the caller so that every exit path —
 * including a stream cut short by a provider fault — still accounts for what was
 * delivered. The terminal event is deferred to end-of-stream because the usage it
 * carries does not exist until the last chunk has been seen.
 */
export const responsesStreamPayloads = (
  chunks: Stream.Stream<Chat.Chunk, ProviderError>,
  responseId: string,
  publicModel: string,
  accumulator: UsageAccumulator
): Stream.Stream<string, ProviderError> =>
  Stream.suspend(() => {
    const state = newStreamState(responseId, publicModel)
    return chunks.pipe(
      Stream.mapConcat((chunk): ReadonlyArray<Record<string, unknown>> => {
        accumulator.add(chunk)
        return chunkToEvents(chunk, state)
      }),
      Stream.concat(Stream.suspend(() => Stream.succeed(completedEvent(state, accumulator.usage())))),
      Stream.map((event) => JSON.stringify(event))
    )
  })
