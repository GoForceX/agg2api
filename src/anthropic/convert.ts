/**
 * Anthropic Messages ⇄ canonical chat translation.
 *
 * Everything here is a plain function: no Effect, no HTTP, no clock beyond the
 * nothing at all. That is deliberate — the protocol bridge is the part most likely
 * to be wrong and the part hardest to observe in production, so it is kept
 * separable and directly testable.
 *
 * The two directions are asymmetric on purpose. Reading an Anthropic body is
 * defensive: Anthropic content is a list of typed blocks, so a single message can
 * carry several meanings at once (`tool_result` blocks in a user turn, `thinking`
 * beside text in an assistant turn) and the readers below split them into the
 * canonical messages they correspond to. Writing one is prescriptive: the emitted
 * stream must satisfy clients that validate block indices and expect every opened
 * block to be closed before the next one starts.
 *
 * Provider-specific request knobs (`top_k`, `thinking`) have no canonical field.
 * Canonical `extras` exists only on messages, and neither field would mean
 * anything on one, so they ride in `metadata`: a request-level bag every provider
 * adapter already forwards untouched. Inventing a `reasoning_effort` from a
 * `budget_tokens` would misreport an intent the caller never expressed.
 */
import type * as Chat from "../canonical.ts"
import { EMPTY_USAGE } from "../canonical.ts"
import { asNumber, asRecordArray, asString, isRecord } from "../json.ts"
import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicRequest,
  AnthropicResponse,
  AnthropicStreamState,
  AnthropicToolBlockState,
  AnthropicUsage
} from "./types.ts"

type Json = Record<string, unknown>

/** Read an untrusted value as a record without casting. */
const recordOf = (value: unknown): Json => (isRecord(value) ? value : {})

const textOf = (value: unknown): string => (typeof value === "string" ? value : "")

// ---------------------------------------------------------------------------
// Request: Anthropic body → canonical chat request
// ---------------------------------------------------------------------------

/**
 * `system` is a top-level field in this protocol, not a message role, and it may
 * be either a string or an array of text blocks. Canonical chat has exactly one
 * spelling for it, so both forms collapse into the text of a leading system
 * message; a single block keeps its text verbatim, several are separated by a
 * blank line, since that is what a provider reading the joined string expects to
 * see between paragraphs.
 */
const systemText = (system: unknown): string | null => {
  if (typeof system === "string") return system === "" ? null : system
  const blocks = asRecordArray(system)
  if (blocks.length === 0) return null
  const text = blocks.map((block) => textOf(block.text)).join("\n\n")
  return text === "" ? null : text
}

/**
 * A base64 image becomes a `data:` URL because canonical images are URLs; the
 * media type has to survive into the URI or the upstream cannot decode the bytes.
 * A source the gateway cannot express is dropped rather than forwarded malformed,
 * which would turn one odd block into a failed request.
 */
const toImagePart = (source: unknown): Chat.ImagePart | null => {
  const value = recordOf(source)
  const type = textOf(value.type)
  if (type === "base64") {
    return {
      type: "image_url",
      image_url: { url: `data:${textOf(value.media_type)};base64,${textOf(value.data)}` }
    }
  }
  if (type === "url") return { type: "image_url", image_url: { url: textOf(value.url) } }
  return null
}

/** Collapse a single text part to a plain string; upstreams accept both, but the string is what they expect. */
const contentOf = (parts: ReadonlyArray<Chat.ContentPart>): Chat.Message["content"] => {
  if (parts.length === 0) return null
  const only = parts[0]
  if (parts.length === 1 && only !== undefined && only.type === "text" && typeof only.text === "string") {
    return only.text
  }
  return [...parts]
}

/**
 * A `tool_use` block's `input` is already-parsed JSON, while canonical tool calls
 * carry the arguments as a string because that is what every chat provider
 * expects to stream back. Re-encoding here is what makes the round trip stable.
 */
const toToolCall = (block: Json): Chat.ToolCall => ({
  id: textOf(block.id),
  type: "function",
  function: {
    name: textOf(block.name),
    arguments: JSON.stringify(isRecord(block.input) ? block.input : {})
  }
})

/** A tool result's content is text, an image, or an array of either. */
const toToolResultContent = (content: unknown): Chat.Message["content"] => {
  if (typeof content === "string") return content
  const blocks = asRecordArray(content)
  const parts: Array<Chat.ContentPart> = []
  for (const block of blocks) {
    const type = textOf(block.type)
    if (type === "text") {
      parts.push({ type: "text", text: textOf(block.text) })
      continue
    }
    if (type === "image") {
      const part = toImagePart(block.source)
      if (part !== null) parts.push(part)
    }
  }
  return contentOf(parts) ?? ""
}

/**
 * Turn Anthropic messages into canonical ones.
 *
 * The interesting case is the block list. Canonical chat has one `tool_call_id`
 * per message, so a user turn carrying two `tool_result` blocks must become two
 * `tool` messages — folding them into one would orphan the second result from the
 * call it answers. Text and images around those results keep their relative order
 * by flushing the pending content before each result.
 */
const toMessages = (value: unknown): Array<Chat.Message> => {
  const out: Array<Chat.Message> = []

  for (const message of asRecordArray(value)) {
    const role: AnthropicMessage["role"] = textOf(message.role) === "assistant" ? "assistant" : "user"
    const content = message.content
    if (typeof content === "string") {
      out.push({ role, content })
      continue
    }

    let parts: Array<Chat.ContentPart> = []
    let calls: Array<Chat.ToolCall> = []
    let reasoning: Array<string> = []

    const flush = (): void => {
      if (parts.length === 0 && calls.length === 0 && reasoning.length === 0) return
      out.push({
        role,
        content: contentOf(parts),
        ...(calls.length === 0 ? {} : { tool_calls: calls }),
        ...(reasoning.length === 0 ? {} : { reasoning_content: reasoning.join("") })
      })
      parts = []
      calls = []
      reasoning = []
    }

    for (const block of asRecordArray(content)) {
      const type = textOf(block.type)
      if (type === "text") {
        parts.push({ type: "text", text: textOf(block.text) })
        continue
      }
      if (type === "image") {
        const part = toImagePart(block.source)
        if (part !== null) parts.push(part)
        continue
      }
      if (type === "tool_use") {
        calls.push(toToolCall(block))
        continue
      }
      if (type === "tool_result") {
        flush()
        out.push({
          role: "tool",
          tool_call_id: textOf(block.tool_use_id),
          content: toToolResultContent(block.content)
        })
        continue
      }
      if (type === "thinking") {
        reasoning.push(textOf(block.thinking))
        continue
      }
      // An unrecognised block carries no canonical meaning, but forwarding it as an
      // opaque part is safer than dropping it: the caller believes it sent it.
      parts.push({ ...block })
    }
    flush()
  }
  return out
}

/**
 * Anthropic tools are flat; canonical tools nest the same fields under
 * `function`, which is what upstream chat providers accept.
 */
const toChatTool = (tool: Json): Chat.Tool => ({
  type: "function",
  function: {
    name: textOf(tool.name),
    ...(asString(tool.description) === null ? {} : { description: textOf(tool.description) }),
    ...(tool.input_schema === undefined ? {} : { parameters: tool.input_schema })
  }
})

/**
 * `any` means "must call some tool", which canonical chat spells `required`; a
 * named tool choice keeps the caller's name, and an unnamed one degrades to
 * `auto` rather than sending an unnameable requirement upstream.
 */
const toChatToolChoice = (choice: unknown): unknown => {
  const value = recordOf(choice)
  const type = textOf(value.type)
  if (type === "any") return "required"
  if (type === "none") return "none"
  if (type === "tool") {
    const name = asString(value.name)
    return name === null ? "auto" : { type: "function", function: { name } }
  }
  return "auto"
}

/**
 * Convert a client Anthropic request into a canonical chat request.
 *
 * The returned `model` is the public id the caller asked for; the router renames
 * it to a provider-side id later, so this must not consult any mapping.
 */
export const toCanonical = (request: AnthropicRequest): { request: Chat.Request; model: string } => {
  const raw = recordOf(request)
  const messages: Array<Chat.Message> = []
  const system = systemText(raw.system)
  if (system !== null) messages.push({ role: "system", content: system })
  messages.push(...toMessages(raw.messages))

  const metadata: Json = isRecord(raw.metadata) ? { ...raw.metadata } : {}
  const topK = asNumber(raw.top_k)
  if (topK !== null) metadata.top_k = topK
  if (isRecord(raw.thinking)) metadata.thinking = raw.thinking

  const stops = Array.isArray(raw.stop_sequences)
    ? raw.stop_sequences.filter((sequence): sequence is string => typeof sequence === "string")
    : []
  const maxTokens = asNumber(raw.max_tokens)
  const temperature = asNumber(raw.temperature)
  const topP = asNumber(raw.top_p)
  const toolChoice = raw.tool_choice === undefined ? undefined : toChatToolChoice(raw.tool_choice)

  const chat: Chat.Request = {
    model: textOf(raw.model),
    messages,
    stream: raw.stream === true,
    ...(maxTokens === null ? {} : { max_tokens: maxTokens }),
    ...(temperature === null ? {} : { temperature }),
    ...(topP === null ? {} : { top_p: topP }),
    ...(stops.length === 0 ? {} : { stop: stops }),
    ...(Array.isArray(raw.tools) ? { tools: asRecordArray(raw.tools).map(toChatTool) } : {}),
    ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
    ...(Object.keys(metadata).length === 0 ? {} : { metadata })
  }
  return { request: chat, model: chat.model }
}

// ---------------------------------------------------------------------------
// Response: canonical chat response → Anthropic body
// ---------------------------------------------------------------------------

/**
 * Canonical usage → Anthropic usage.
 *
 * `cached_tokens` is reported as `cache_read_input_tokens` because that is the
 * field an Anthropic client reads to see prefix-cache savings; leaving it out
 * would make a cached request look like a full-price one. `cache_creation` is not
 * reported: the gateway never writes a provider cache on the caller's behalf, so
 * claiming writes would overstate spend.
 */
export const toAnthropicUsage = (usage: Chat.Usage): AnthropicUsage => ({
  input_tokens: usage.prompt_tokens,
  output_tokens: usage.completion_tokens,
  cache_read_input_tokens: usage.cached_tokens
})

/** The four Anthropic stop reasons the gateway can distinguish; everything else finishes a turn. */
const STOP_REASONS: Record<string, string> = {
  stop: "end_turn",
  length: "max_tokens",
  tool_calls: "tool_use",
  content_filter: "stop_sequence"
}

const stopReason = (finish: string | null): string => (finish === null ? "end_turn" : STOP_REASONS[finish] ?? "end_turn")

/**
 * A tool call's arguments are a JSON string on the canonical side and a parsed
 * object on this one. A truncated stream leaves the string unparseable, so the
 * fallback matters: throwing here would fail a response the provider did serve.
 */
const jsonArguments = (text: string): Json => {
  try {
    const parsed: unknown = JSON.parse(text)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

const contentText = (content: Chat.Message["content"] | undefined): string => {
  if (typeof content === "string") return content
  return asRecordArray(content)
    .map((part) => textOf(part.text))
    .join("")
}

/**
 * Build an Anthropic message from a canonical response.
 *
 * Block order is part of the contract: a thinking block precedes the text it
 * explains, and tool calls follow it, because clients render blocks in order and a
 * thinking block that arrived after the answer reads as commentary on a turn that
 * has already finished.
 */
export const toAnthropic = (
  response: Chat.Response,
  opts: { id: string; model: string }
): AnthropicResponse => {
  const choice = response.choices[0]
  const message = choice?.message
  const content: Array<AnthropicContentBlock> = []

  const reasoning = message?.reasoning_content
  if (typeof reasoning === "string" && reasoning !== "") {
    content.push({ type: "thinking", thinking: reasoning })
  }
  const text = contentText(message?.content)
  if (text !== "") content.push({ type: "text", text })
  for (const call of message?.tool_calls ?? []) {
    content.push({
      type: "tool_use",
      id: call.id,
      name: call.function.name,
      input: jsonArguments(call.function.arguments)
    })
  }

  return {
    id: opts.id,
    type: "message",
    role: "assistant",
    model: opts.model,
    content,
    stop_reason: stopReason(choice?.finish_reason ?? null),
    stop_sequence: null,
    usage: toAnthropicUsage(response.usage ?? { ...EMPTY_USAGE })
  }
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

/** The open block is named by kind, not by index, so the emitter can close it without bookkeeping. */
export const newStreamState = (id: string, model: string): AnthropicStreamState => ({
  id,
  model,
  usage: { input_tokens: 0, output_tokens: 0 },
  index: 0,
  open: null,
  open_index: -1,
  open_tool: null,
  tools: new Map<number, AnthropicToolBlockState>(),
  stop_reason: "end_turn",
  started: false
})

/** Emit the closing event for whatever block is open, if any. */
const closeBlock = (state: AnthropicStreamState, events: Array<Json>): void => {
  if (state.open === null) return
  events.push({ type: "content_block_stop", index: state.open_index })
  state.open = null
  state.open_tool = null
}

/**
 * Open a text or thinking block, closing whatever preceded it.
 *
 * Anthropic names blocks by index and the index space is per message, so an index
 * is allocated at open time — the only moment at which the block's position is
 * known — and never reused for a different block.
 */
const openContentBlock = (
  state: AnthropicStreamState,
  kind: "text" | "thinking",
  events: Array<Json>
): number => {
  if (state.open === kind) return state.open_index
  closeBlock(state, events)
  state.open = kind
  state.open_index = state.index++
  state.open_tool = null
  events.push({
    type: "content_block_start",
    index: state.open_index,
    content_block: kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" }
  })
  return state.open_index
}

/**
 * Open a `tool_use` block, or resume one that a later fragment addresses.
 *
 * Providers stream a call's id and name on its first fragment and only arguments
 * afterwards, keyed by tool-call index, so the block is announced once per index.
 * A provider that interleaves fragments of two calls forces a re-announcement of
 * the earlier block: the protocol has no way to address a closed index, and
 * dropping the fragments would truncate the arguments.
 */
const openToolBlock = (
  state: AnthropicStreamState,
  key: number,
  fragment: Chat.ToolCall,
  events: Array<Json>
): AnthropicToolBlockState => {
  const existing = state.tools.get(key)
  if (state.open === "tool_use" && state.open_tool === key && existing !== undefined) return existing
  closeBlock(state, events)
  const block: AnthropicToolBlockState = existing ?? {
    index: state.index++,
    id: fragment.id,
    name: fragment.function.name,
    arguments: ""
  }
  if (block.id === "") block.id = fragment.id
  if (block.name === "") block.name = fragment.function.name
  state.tools.set(key, block)
  state.open = "tool_use"
  state.open_index = block.index
  state.open_tool = key
  events.push({
    type: "content_block_start",
    index: block.index,
    content_block: { type: "tool_use", id: block.id, name: block.name, input: {} }
  })
  return block
}

/** The upstream tool-call index, falling back to position when unlabelled. */
const callIndex = (call: Chat.ToolCall, position: number): number => asNumber(call.index) ?? position

/**
 * Translate one canonical chunk into the Anthropic events it implies.
 *
 * The accumulator is mutated because block identity is assigned lazily, on the
 * first delta that needs it: a block cannot be announced before its first payload
 * arrives, yet every later delta of that block must name the index chosen then.
 * Content is read reasoning-first so a turn that thinks before answering opens its
 * blocks in the order the client renders them.
 */
export const chunkToEvents = (
  chunk: Chat.Chunk,
  state: AnthropicStreamState
): ReadonlyArray<{ event: string; data: Json }> => {
  const events: Array<Json> = []

  const usage = chunk.usage
  if (usage !== null) {
    state.usage = {
      input_tokens: usage.prompt_tokens,
      output_tokens: 0,
      cache_read_input_tokens: usage.cached_tokens
    }
  }

  if (!state.started) {
    state.started = true
    events.push({
      type: "message_start",
      message: {
        id: state.id,
        type: "message",
        role: "assistant",
        model: state.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: state.usage
      }
    })
  }

  for (const choice of chunk.choices) {
    if (choice.finish_reason !== null) state.stop_reason = stopReason(choice.finish_reason)
    const delta = choice.delta

    const reasoning = delta.reasoning_content
    if (typeof reasoning === "string" && reasoning !== "") {
      const index = openContentBlock(state, "thinking", events)
      events.push({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: reasoning } })
    }

    const content = delta.content
    if (typeof content === "string" && content !== "") {
      const index = openContentBlock(state, "text", events)
      events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: content } })
    }

    for (const [position, fragment] of (delta.tool_calls ?? []).entries()) {
      const block = openToolBlock(state, callIndex(fragment, position), fragment, events)
      const fragmentText = fragment.function.arguments
      if (fragmentText === "") continue
      block.arguments += fragmentText
      events.push({
        type: "content_block_delta",
        index: block.index,
        delta: { type: "input_json_delta", partial_json: fragmentText }
      })
    }
  }

  return events.map((data) => ({ event: textOf(data.type), data }))
}

/**
 * Close the message: the open block first, then the final usage and stop reason.
 *
 * Anthropic has no `[DONE]` sentinel, so `message_stop` is what tells a client the
 * response is complete; a stream that ended without it would look truncated to an
 * SDK and be retried.
 */
export const finishEvents = (
  state: AnthropicStreamState,
  usage: Chat.Usage
): ReadonlyArray<{ event: string; data: Json }> => {
  const events: Array<Json> = []
  closeBlock(state, events)
  events.push({
    type: "message_delta",
    delta: { stop_reason: state.stop_reason, stop_sequence: null },
    usage: toAnthropicUsage(usage)
  })
  events.push({ type: "message_stop" })
  return events.map((data) => ({ event: textOf(data.type), data }))
}

/**
 * Anthropic's error envelope, which is what its SDKs parse.
 *
 * A failure before the first byte gets an HTTP status; a failure mid-stream can
 * only be reported as an event, and losing the shape here would surface as an
 * opaque parse error rather than a diagnosable message.
 */
export const errorBody = (type: string, message: string): Json => ({
  type: "error",
  error: { type, message }
})
