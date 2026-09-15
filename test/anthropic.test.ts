/**
 * Anthropic Messages protocol tests.
 *
 * This module is pure, so every body here is an ordinary (non-Effect) test: an
 * `expect` that throws inside `Effect.gen` is swallowed as a fiber defect and the
 * test passes vacuously, and there is no reason to invite that when no effect is
 * involved.
 */
import { describe, expect, test } from "bun:test"
import type * as Chat from "../src/canonical.ts"
import {
  chunkToEvents,
  errorBody,
  finishEvents,
  newStreamState,
  toAnthropic,
  toCanonical
} from "../src/anthropic/convert.ts"
import type {
  AnthropicRequest,
  AnthropicStreamState,
  ToolUseBlock
} from "../src/anthropic/types.ts"

/** Index without a non-null assertion, failing loudly when the element is absent. */
const at = <T>(items: ReadonlyArray<T>, index: number): T => {
  const item = items[index]
  if (item === undefined) throw new Error(`expected an element at index ${index}`)
  return item
}

const request = (overrides: Partial<AnthropicRequest>): AnthropicRequest => ({
  model: "claude-sonnet-4",
  max_tokens: 1024,
  messages: [{ role: "user", content: "hi" }],
  ...overrides
})

const usageOf = (overrides: Partial<Chat.Usage>): Chat.Usage => ({
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
  cached_tokens: 0,
  reasoning_tokens: 0,
  ...overrides
})

const responseOf = (message: Chat.Message, finish: string | null): Chat.Response => ({
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 0,
  model: "m",
  choices: [{ index: 0, message, finish_reason: finish }],
  usage: usageOf({})
})

const chunkOf = (
  delta: Chat.ChunkDelta,
  options: { finish?: string | null; usage?: Chat.Usage | null } = {}
): Chat.Chunk => ({
  id: "chatcmpl-1",
  object: "chat.completion.chunk",
  created: 0,
  model: "m",
  choices: [{ index: 0, delta, finish_reason: options.finish ?? null }],
  usage: options.usage ?? null
})

const toolFragment = (call: Chat.ToolCall): Chat.ChunkDelta => ({ tool_calls: [call] })

const callOf = (index: number, id: string, name: string, args: string): Chat.ToolCall => ({
  index,
  id,
  type: "function",
  function: { name, arguments: args }
})

/** Drive a whole stream through the two emitters, as the HTTP handler does. */
const streamEvents = (
  chunks: ReadonlyArray<Chat.Chunk>,
  usage: Chat.Usage
): { state: AnthropicStreamState; events: ReadonlyArray<{ event: string; data: Record<string, unknown> }> } => {
  const state = newStreamState("msg_1", "claude-sonnet-4")
  const events = chunks.flatMap((chunk) => [...chunkToEvents(chunk, state)])
  return { state, events: [...events, ...finishEvents(state, usage)] }
}

const indicesOf = (
  events: ReadonlyArray<{ event: string; data: Record<string, unknown> }>,
  event: string
): Array<number> =>
  events
    .filter((entry) => entry.event === event)
    .map((entry) => entry.data.index)
    .filter((index): index is number => typeof index === "number")

describe("toCanonical", () => {
  test("a string system becomes the leading system message", () => {
    const { request: chat, model } = toCanonical(
      request({ system: "be brief", messages: [{ role: "user", content: "hi" }] })
    )
    expect(model).toBe("claude-sonnet-4")
    expect(chat.messages).toHaveLength(2)
    expect(at(chat.messages, 0)).toEqual({ role: "system", content: "be brief" })
    expect(at(chat.messages, 1)).toEqual({ role: "user", content: "hi" })
    expect(chat.max_tokens).toBe(1024)
    expect(chat.stream).toBe(false)
  })

  test("a system block array is joined into one system message", () => {
    const { request: chat } = toCanonical(
      request({
        system: [
          { type: "text", text: "be brief" },
          { type: "text", text: "cite sources" }
        ]
      })
    )
    expect(at(chat.messages, 0)).toEqual({ role: "system", content: "be brief\n\ncite sources" })
  })

  test("stop_sequences map to stop and top_k survives on metadata", () => {
    const { request: chat } = toCanonical(
      request({
        stop_sequences: ["\n\nHuman:", "STOP"],
        top_k: 40,
        thinking: { type: "enabled", budget_tokens: 2048 }
      })
    )
    expect(chat.stop).toEqual(["\n\nHuman:", "STOP"])
    expect(chat.metadata).toEqual({ top_k: 40, thinking: { type: "enabled", budget_tokens: 2048 } })
  })

  test("request metadata is preserved alongside top_k", () => {
    const { request: chat } = toCanonical(
      request({ metadata: { user_id: "u1" }, top_k: 7, temperature: 0.2, top_p: 0.9 })
    )
    expect(chat.metadata).toEqual({ user_id: "u1", top_k: 7 })
    expect(chat.temperature).toBe(0.2)
    expect(chat.top_p).toBe(0.9)
  })

  test("tools are un-nested and tool_choice is translated", () => {
    const tool = {
      name: "get_weather",
      description: "Look up weather",
      input_schema: { type: "object", properties: { city: { type: "string" } } }
    }
    const any = toCanonical(request({ tools: [tool], tool_choice: { type: "any" } }))
    expect(any.request.tools).toEqual([
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Look up weather",
          parameters: { type: "object", properties: { city: { type: "string" } } }
        }
      }
    ])
    expect(any.request.tool_choice).toBe("required")

    const named = toCanonical(request({ tool_choice: { type: "tool", name: "get_weather" } }))
    expect(named.request.tool_choice).toEqual({ type: "function", function: { name: "get_weather" } })

    const auto = toCanonical(request({ tool_choice: { type: "auto" } }))
    expect(auto.request.tool_choice).toBe("auto")
  })

  test("a tool_use assistant turn keeps its calls and its arguments round-trip", () => {
    const { request: chat } = toCanonical(
      request({
        messages: [
          { role: "user", content: "weather in SF?" },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "needs a lookup" },
              { type: "text", text: "checking" },
              { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "SF" } }
            ]
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "17C" }]
          }
        ]
      })
    )

    const assistant = at(chat.messages, 1)
    expect(assistant.role).toBe("assistant")
    expect(assistant.content).toBe("checking")
    expect(assistant.reasoning_content).toBe("needs a lookup")
    expect(assistant.tool_calls).toEqual([
      { id: "toolu_1", type: "function", function: { name: "get_weather", arguments: '{"city":"SF"}' } }
    ])
    const args = at(assistant.tool_calls ?? [], 0).function.arguments
    expect(JSON.parse(args)).toEqual({ city: "SF" })

    expect(at(chat.messages, 2)).toEqual({
      role: "tool",
      tool_call_id: "toolu_1",
      content: "17C"
    })
  })

  test("two tool_result blocks in one user message become two tool messages", () => {
    const { request: chat } = toCanonical(
      request({
        messages: [
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "toolu_1", content: "17C" },
              { type: "tool_result", tool_use_id: "toolu_2", content: [{ type: "text", text: "sunny" }] }
            ]
          }
        ]
      })
    )
    expect(chat.messages).toEqual([
      { role: "tool", tool_call_id: "toolu_1", content: "17C" },
      { role: "tool", tool_call_id: "toolu_2", content: "sunny" }
    ])
  })

  test("a base64 image becomes a data URL and a url source passes through", () => {
    const { request: chat } = toCanonical(
      request({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: "AAAB" }
              },
              { type: "image", source: { type: "url", url: "https://example.com/cat.png" } }
            ]
          }
        ]
      })
    )
    expect(at(chat.messages, 0).content).toEqual([
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAB" } },
      { type: "image_url", image_url: { url: "https://example.com/cat.png" } }
    ])
  })
})

describe("toAnthropic", () => {
  test("content, tool_use and reasoning blocks come out in render order", () => {
    const body = toAnthropic(
      responseOf(
        {
          role: "assistant",
          content: "It is sunny.",
          reasoning_content: "checked the forecast",
          tool_calls: [
            { id: "toolu_1", type: "function", function: { name: "get_weather", arguments: '{"city":"SF"}' } }
          ]
        },
        "tool_calls"
      ),
      { id: "msg_1", model: "claude-sonnet-4" }
    )

    expect(body.id).toBe("msg_1")
    expect(body.type).toBe("message")
    expect(body.role).toBe("assistant")
    expect(body.model).toBe("claude-sonnet-4")
    expect(body.content).toEqual([
      { type: "thinking", thinking: "checked the forecast" },
      { type: "text", text: "It is sunny." },
      { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "SF" } }
    ])
    expect(body.stop_reason).toBe("tool_use")
    expect(body.stop_sequence).toBeNull()
    const tool = at(body.content, 2) as ToolUseBlock
    expect(tool.input).toEqual({ city: "SF" })
  })

  test("stop_reason covers all four mappings plus the null fallback", () => {
    const reasonFor = (finish: string | null): string | null =>
      toAnthropic(responseOf({ role: "assistant", content: "x" }, finish), {
        id: "m",
        model: "claude-sonnet-4"
      }).stop_reason

    expect(reasonFor("stop")).toBe("end_turn")
    expect(reasonFor("length")).toBe("max_tokens")
    expect(reasonFor("tool_calls")).toBe("tool_use")
    expect(reasonFor("content_filter")).toBe("stop_sequence")
    expect(reasonFor(null)).toBe("end_turn")
    expect(reasonFor("something_new")).toBe("end_turn")
  })

  test("usage maps onto Anthropic's token fields including the cache read", () => {
    const response: Chat.Response = {
      ...responseOf({ role: "assistant", content: "x" }, "stop"),
      usage: usageOf({
        prompt_tokens: 100,
        completion_tokens: 25,
        total_tokens: 125,
        cached_tokens: 60,
        reasoning_tokens: 0
      })
    }
    const body = toAnthropic(response, { id: "m", model: "claude-sonnet-4" })
    expect(body.usage).toEqual({
      input_tokens: 100,
      output_tokens: 25,
      cache_read_input_tokens: 60
    })
  })

  test("unparseable tool arguments yield an empty input rather than throwing", () => {
    const body = toAnthropic(
      responseOf(
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "toolu_1", type: "function", function: { name: "get_weather", arguments: '{"city":' } }
          ]
        },
        "tool_calls"
      ),
      { id: "m", model: "claude-sonnet-4" }
    )
    expect(body.content).toEqual([{ type: "tool_use", id: "toolu_1", name: "get_weather", input: {} }])
  })
})

describe("streaming", () => {
  test("the full event sequence for text", () => {
    const { events } = streamEvents(
      [
        chunkOf({ role: "assistant", content: "" }, { usage: usageOf({ prompt_tokens: 11, total_tokens: 15 }) }),
        chunkOf({ content: "Hello" }),
        chunkOf({ content: ", world" }),
        chunkOf({ content: "" }, { finish: "stop" })
      ],
      usageOf({ prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 })
    )

    expect(events.map((entry) => entry.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop"
    ])
    expect(events[0]?.data.message).toMatchObject({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4",
      content: [],
      stop_reason: null,
      usage: { input_tokens: 11, output_tokens: 0 }
    })
    expect(events[1]?.data).toEqual({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })
    expect(events[2]?.data).toEqual({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } })
    expect(events[3]?.data).toEqual({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: ", world" } })
    expect(events[4]?.data).toEqual({ type: "content_block_stop", index: 0 })
    expect(events[5]?.data).toEqual({
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { input_tokens: 11, output_tokens: 4, cache_read_input_tokens: 0 }
    })
    expect(events[6]?.data).toEqual({ type: "message_stop" })
  })

  test("thinking streams before text and block indices are contiguous from 0", () => {
    const { events } = streamEvents(
      [
        chunkOf({ role: "assistant", reasoning_content: "hmm" }),
        chunkOf({ content: "answer" }),
        chunkOf({ content: "" }, { finish: "stop" })
      ],
      usageOf({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 })
    )

    expect(events.map((entry) => entry.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop"
    ])
    expect(indicesOf(events, "content_block_start")).toEqual([0, 1])
    expect(events[1]?.data.content_block).toEqual({ type: "thinking", thinking: "" })
    expect(events[2]?.data.delta).toEqual({ type: "thinking_delta", thinking: "hmm" })
    expect(events[4]?.data.content_block).toEqual({ type: "text", text: "" })
    expect(events[5]?.data.delta).toEqual({ type: "text_delta", text: "answer" })
  })

  test("a tool call streams partial_json and closes its block", () => {
    const { state, events } = streamEvents(
      [
        chunkOf(toolFragment(callOf(0, "toolu_1", "get_weather", ""))),
        chunkOf(toolFragment(callOf(0, "", "", '{"city":'))),
        chunkOf(toolFragment(callOf(0, "", "", '"SF"}'))),
        chunkOf({}, { finish: "tool_calls" })
      ],
      usageOf({ prompt_tokens: 9, completion_tokens: 6, total_tokens: 15, cached_tokens: 4 })
    )

    expect(events.map((entry) => entry.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop"
    ])
    expect(events[1]?.data).toEqual({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_1", name: "get_weather", input: {} }
    })
    expect(events[2]?.data.delta).toEqual({ type: "input_json_delta", partial_json: '{"city":' })
    expect(events[3]?.data.delta).toEqual({ type: "input_json_delta", partial_json: '"SF"}' })
    expect(JSON.parse(at([...state.tools.values()], 0).arguments)).toEqual({ city: "SF" })
    expect(events[5]?.data.delta).toEqual({ stop_reason: "tool_use", stop_sequence: null })
    expect(events[5]?.data.usage).toEqual({
      input_tokens: 9,
      output_tokens: 6,
      cache_read_input_tokens: 4
    })
  })

  test("interleaved tool calls get distinct contiguous indices", () => {
    const { events } = streamEvents(
      [
        chunkOf(toolFragment(callOf(0, "toolu_1", "a", ""))),
        chunkOf(toolFragment(callOf(1, "toolu_2", "b", ""))),
        chunkOf(toolFragment(callOf(0, "", "", '{"x":1}'))),
        chunkOf({}, { finish: "tool_calls" })
      ],
      usageOf({})
    )

    expect(indicesOf(events, "content_block_start")).toEqual([0, 1, 0])
    expect(indicesOf(events, "content_block_stop")).toEqual([0, 1, 0])
    expect(events.map((entry) => entry.event).at(-1)).toBe("message_stop")
  })

  test("every opened block is closed exactly once and stop precedes the finish events", () => {
    const { events } = streamEvents(
      [
        chunkOf({ role: "assistant", reasoning_content: "think" }),
        chunkOf({ content: "hi" }),
        chunkOf(toolFragment(callOf(0, "toolu_1", "get_weather", "{}"))),
        chunkOf({}, { finish: "tool_calls" })
      ],
      usageOf({})
    )

    const started = indicesOf(events, "content_block_start")
    const stopped = indicesOf(events, "content_block_stop")
    expect(started).toEqual([0, 1, 2])
    expect(stopped).toEqual([0, 1, 2])
    expect(new Set(stopped).size).toBe(stopped.length)

    const names = events.map((entry) => entry.event)
    const lastStop = names.lastIndexOf("content_block_stop")
    expect(lastStop).toBeLessThan(names.indexOf("message_delta"))
    expect(names.slice(-2)).toEqual(["message_delta", "message_stop"])
  })

  test("the message terminates with message_stop and never a [DONE] sentinel", () => {
    const { events } = streamEvents(
      [chunkOf({ content: "done" }), chunkOf({ content: "" }, { finish: "stop" })],
      usageOf({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 })
    )

    const names = events.map((entry) => entry.event)
    expect(names.at(-1)).toBe("message_stop")
    expect(names).not.toContain("[DONE]")
    expect(JSON.stringify(events)).not.toContain("[DONE]")
    expect(names.filter((name) => name === "message_stop")).toHaveLength(1)
  })

  test("an empty chunk still opens the message exactly once", () => {
    const state = newStreamState("msg_1", "claude-sonnet-4")
    expect(chunkToEvents(chunkOf({ content: "a" }), state).filter((e) => e.event === "message_start")).toHaveLength(1)
    expect(chunkToEvents(chunkOf({ content: "b" }), state).filter((e) => e.event === "message_start")).toHaveLength(0)
  })

  test("errorBody uses Anthropic's error envelope", () => {
    expect(errorBody("invalid_request_error", "max_tokens: required")).toEqual({
      type: "error",
      error: { type: "invalid_request_error", message: "max_tokens: required" }
    })
  })
})
