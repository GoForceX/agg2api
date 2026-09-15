/**
 * Responses protocol conversion and adapter behaviour.
 *
 * The pure conversions are asserted directly because they are the part of the
 * bridge most likely to be wrong and least visible in production. The adapter gets
 * one test over a real socket, because the property that matters there — a
 * `response.failed` event surfacing as a typed failure — cannot be observed with a
 * stubbed HTTP layer.
 */
import { describe, expect, test } from "bun:test"
import * as FetchHttpClient from "@effect/platform/FetchHttpClient"
import type * as HttpClient from "@effect/platform/HttpClient"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import type * as Chat from "../src/canonical.ts"
import type { Provider } from "../src/domain.ts"
import type { ProviderError } from "../src/errors.ts"
import {
  chunkToEvents,
  completedEvent,
  eventsToChunk,
  fromResponses,
  newStreamState,
  toCanonical,
  toResponses
} from "../src/responses/convert.ts"
import { responsesAdapter } from "../src/upstream/responses-adapter.ts"

const layer = FetchHttpClient.layer

const run = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(layer)))

interface Mock {
  readonly port: number
  readonly stop: () => Promise<void>
}

const serve = (fetch: (request: Request) => Response | Promise<Response>): Mock => {
  const server = Bun.serve({ port: 0, fetch })
  const port = server.port
  if (port === undefined) {
    void server.stop(true)
    throw new Error("mock upstream did not bind a port")
  }
  return { port, stop: () => server.stop(true) }
}

const provider = (port: number): Provider => ({
  id: 7,
  name: "mock-responses",
  kind: "openai-responses",
  base_url: `http://127.0.0.1:${port}`,
  api_key: "sk-test",
  headers: {},
  priority: 0,
  enabled: true,
  model_rename: {},
  model_allow: [],
  model_deny: [],
  input_price: null,
  output_price: null,
  currency: "USD",
  max_retries: 0,
  created_at: 0,
  updated_at: 0
})

const chunk = (delta: Chat.ChunkDelta, over: Partial<Chat.Chunk> = {}): Chat.Chunk => ({
  id: "resp_1",
  object: "chat.completion.chunk",
  created: 1_737_000_000,
  model: "public-model",
  choices: [{ index: 0, delta, finish_reason: null }],
  usage: null,
  ...over
})

describe("toCanonical", () => {
  test("a string input becomes one user message", () => {
    const { request, model } = toCanonical({ model: "public-model", input: "hello there" })

    expect(model).toBe("public-model")
    expect(request.messages).toEqual([{ role: "user", content: "hello there" }])
    expect(request.stream).toBe(false)
  })

  test("an input_image part is reshaped into the nested canonical form", () => {
    const { request } = toCanonical({
      model: "m",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "what is this?" },
            { type: "input_image", image_url: "https://example.com/a.png", detail: "high" }
          ]
        }
      ]
    })

    expect(request.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image_url", image_url: { url: "https://example.com/a.png", detail: "high" } }
        ]
      }
    ])
  })

  test("a function_call and its output fold into an assistant turn and a tool result", () => {
    const { request } = toCanonical({
      model: "m",
      input: [
        { type: "message", role: "user", content: "weather?" },
        { type: "function_call", call_id: "call_1", name: "get_weather", arguments: '{"city":"Paris"}' },
        { type: "function_call_output", call_id: "call_1", output: "18C" }
      ]
    })

    expect(request.messages).toEqual([
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"Paris"}' }
          }
        ]
      },
      { role: "tool", content: "18C", tool_call_id: "call_1" }
    ])
  })

  test("instructions lead, tools are nested, and max_output_tokens becomes max_completion_tokens", () => {
    const { request } = toCanonical({
      model: "m",
      instructions: "be terse",
      input: "hi",
      max_output_tokens: 64,
      temperature: 0.5,
      reasoning: { effort: "high" },
      text: { format: { type: "json_object" } },
      tools: [{ type: "function", name: "f", description: "d", parameters: { type: "object" }, strict: true }],
      stream: true
    })

    expect(request.messages[0]).toEqual({ role: "system", content: "be terse" })
    expect(request.max_completion_tokens).toBe(64)
    expect(request.temperature).toBe(0.5)
    expect(request.reasoning_effort).toBe("high")
    expect(request.response_format).toEqual({ type: "json_object" })
    expect(request.stream).toBe(true)
    // The flat Responses tool must not reach a chat provider as-is.
    expect(request.tools).toEqual([
      {
        type: "function",
        function: { name: "f", description: "d", parameters: { type: "object" }, strict: true }
      }
    ])
  })
})

describe("toResponses", () => {
  test("maps content, tool calls and usage", () => {
    const response: Chat.Response = {
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 1_737_000_000,
      model: "upstream-model",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "the answer",
            reasoning_content: "because",
            tool_calls: [
              { id: "call_9", type: "function", function: { name: "lookup", arguments: '{"q":1}' } }
            ]
          },
          finish_reason: "tool_calls"
        }
      ],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        cached_tokens: 40,
        reasoning_tokens: 5
      }
    }

    const out = toResponses(response, { id: "resp_1", model: "public-model", created: 1_737_000_000 })

    expect(out.object).toBe("response")
    expect(out.status).toBe("completed")
    expect(out.model).toBe("public-model")
    expect(out.output.map((item) => item.type)).toEqual(["reasoning", "message", "function_call"])

    const message = out.output[1]
    expect(message?.type).toBe("message")
    if (message?.type === "message") {
      expect(message.content[0]?.text).toBe("the answer")
      expect(message.role).toBe("assistant")
    }
    const call = out.output[2]
    if (call?.type === "function_call") {
      expect(call.call_id).toBe("call_9")
      expect(call.name).toBe("lookup")
      expect(call.arguments).toBe('{"q":1}')
    }
    expect(out.usage).toEqual({
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 40 },
      output_tokens: 20,
      output_tokens_details: { reasoning_tokens: 5 },
      total_tokens: 120
    })
    expect(out.output_text).toBe("the answer")
  })
})

describe("fromResponses", () => {
  test("round-trips a Responses body back into canonical form", () => {
    const raw = {
      id: "resp_abc",
      object: "response",
      created_at: 1_737_000_000,
      status: "completed",
      model: "upstream-model",
      output: [
        { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "because" }] },
        {
          type: "message",
          id: "msg_1",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "the answer", annotations: [] }]
        },
        {
          type: "function_call",
          id: "fc_1",
          call_id: "call_9",
          name: "lookup",
          arguments: '{"q":1}',
          status: "completed"
        }
      ],
      usage: {
        input_tokens: 100,
        input_tokens_details: { cached_tokens: 40 },
        output_tokens: 20,
        output_tokens_details: { reasoning_tokens: 5 },
        total_tokens: 120
      }
    }

    const back = fromResponses(raw, "fallback")
    const round = toResponses(back, { id: "resp_abc", model: "public-model", created: 1_737_000_000 })

    expect(round.id).toBe("resp_abc")
    expect(round.output.map((item) => item.type)).toEqual(["reasoning", "message", "function_call"])
    expect(round.usage).toEqual(raw.usage)
    const message = round.output[1]
    if (message?.type === "message") expect(message.content[0]?.text).toBe("the answer")

    // Chat-side reading of the same payload.
    expect(back.choices[0]?.message.content).toBe("the answer")
    expect(back.choices[0]?.message.reasoning_content).toBe("because")
    expect(back.choices[0]?.message.tool_calls?.[0]?.function.name).toBe("lookup")
    expect(back.choices[0]?.finish_reason).toBe("tool_calls")
    expect(back.usage?.cached_tokens).toBe(40)
    expect(back.usage?.reasoning_tokens).toBe(5)
    expect(back.usage?.total_tokens).toBe(120)
  })

  test("tolerates a body with no output and no usage", () => {
    const back = fromResponses({ id: "resp_x" }, "fallback")

    expect(back.model).toBe("fallback")
    expect(back.choices[0]?.message.content).toBeNull()
    expect(back.choices[0]?.finish_reason).toBe("stop")
    expect(back.usage?.prompt_tokens).toBe(0)
  })
})

describe("streaming events", () => {
  test("emits created, item, delta events in order with contiguous sequence numbers", () => {
    const state = newStreamState("resp_1", "public-model")
    const events = [
      ...chunkToEvents(chunk({ role: "assistant" }), state),
      ...chunkToEvents(chunk({ reasoning_content: "why" }), state),
      ...chunkToEvents(chunk({ content: "Hel" }), state),
      ...chunkToEvents(chunk({ content: "lo" }), state),
      ...chunkToEvents(
        chunk({
          tool_calls: [
            { index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: '{"q"' } }
          ]
        }),
        state
      ),
      ...chunkToEvents(
        chunk({
          tool_calls: [{ index: 0, id: "", type: "function", function: { name: "", arguments: ":1}" } }]
        }),
        state
      ),
      completedEvent(state, {
        prompt_tokens: 7,
        completion_tokens: 3,
        total_tokens: 10,
        cached_tokens: 2,
        reasoning_tokens: 1
      })
    ]

    expect(events[0]?.type).toBe("response.created")
    expect(events.map((event) => event.sequence_number)).toEqual(events.map((_, index) => index))
    expect(events.at(-1)?.type).toBe("response.completed")

    const types = events.map((event) => event.type)
    expect(types.indexOf("response.output_item.added")).toBeLessThan(types.indexOf("response.output_text.delta"))
    expect(types).toContain("response.content_part.added")
    expect(types).toContain("response.reasoning_summary_text.delta")

    // The delta events carry the deltas, not just announcements of them.
    expect(events.filter((event) => event.type === "response.output_text.delta").map((event) => event.delta)).toEqual(
      ["Hel", "lo"]
    )
    expect(
      events
        .filter((event) => event.type === "response.function_call_arguments.delta")
        .map((event) => event.delta)
    ).toEqual(['{"q"', ":1}"])

    const final = events.at(-1)
    const response = final?.response
    if (response === undefined || typeof response !== "object" || response === null) {
      throw new Error("terminal event carried no response object")
    }
    const output = (response as { output: Array<Record<string, unknown>> }).output
    expect(output.map((item) => item.type)).toEqual(["reasoning", "message", "function_call"])
    // Argument fragments are joined before the item is reported as finished.
    expect(output[2]?.arguments).toBe('{"q":1}')
    expect(output[1]?.status).toBe("completed")
  })

  test("a second terminal event does not consume another sequence number", () => {
    const state = newStreamState("resp_1", "m")
    chunkToEvents(chunk({ content: "x" }), state)
    const first = completedEvent(state, {
      prompt_tokens: 1,
      completion_tokens: 1,
      total_tokens: 2,
      cached_tokens: 0,
      reasoning_tokens: 0
    })
    const second = completedEvent(state, {
      prompt_tokens: 1,
      completion_tokens: 1,
      total_tokens: 2,
      cached_tokens: 0,
      reasoning_tokens: 0
    })

    expect(second.sequence_number).toBe(first.sequence_number)
    expect(state.sequence).toBe(Number(first.sequence_number) + 1)
  })

  test("eventsToChunk keeps only the delta events and the terminal usage", () => {
    expect(eventsToChunk({ type: "response.output_item.added" }, "m")).toBeNull()
    expect(eventsToChunk({ type: "response.content_part.added" }, "m")).toBeNull()

    const text = eventsToChunk(
      { type: "response.output_text.delta", item_id: "msg_1", delta: "hi" },
      "m"
    )
    expect(text?.choices[0]?.delta.content).toBe("hi")

    const reasoning = eventsToChunk(
      { type: "response.reasoning_summary_text.delta", item_id: "rs_1", delta: "why" },
      "m"
    )
    expect(reasoning?.choices[0]?.delta.reasoning_content).toBe("why")

    const args = eventsToChunk(
      { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 2, delta: '{"q"' },
      "m"
    )
    expect(args?.choices[0]?.delta.tool_calls?.[0]?.function.arguments).toBe('{"q"')

    const terminal = eventsToChunk(
      {
        type: "response.completed",
        response: {
          id: "resp_1",
          model: "upstream-model",
          created_at: 5,
          usage: {
            input_tokens: 4,
            input_tokens_details: { cached_tokens: 1 },
            output_tokens: 2,
            output_tokens_details: { reasoning_tokens: 1 },
            total_tokens: 6
          }
        }
      },
      "m"
    )
    expect(terminal?.choices).toEqual([])
    expect(terminal?.usage?.prompt_tokens).toBe(4)
    expect(terminal?.usage?.completion_tokens).toBe(2)
    expect(terminal?.usage?.cached_tokens).toBe(1)
    expect(terminal?.usage?.reasoning_tokens).toBe(1)
  })
})

describe("responsesAdapter", () => {
  test("streams a Responses body as canonical chunks", async () => {
    const frames = [
      { type: "response.created", sequence_number: 0, response: { id: "resp_9", model: "upstream-model" } },
      { type: "response.output_item.added", sequence_number: 1, output_index: 0, item: { type: "message" } },
      {
        type: "response.output_text.delta",
        sequence_number: 2,
        item_id: "msg_1",
        output_index: 0,
        delta: "Hel"
      },
      {
        type: "response.output_text.delta",
        sequence_number: 3,
        item_id: "msg_1",
        output_index: 0,
        delta: "lo"
      },
      {
        type: "response.completed",
        sequence_number: 4,
        response: {
          id: "resp_9",
          model: "upstream-model",
          created_at: 1_737_000_000,
          usage: {
            input_tokens: 7,
            input_tokens_details: { cached_tokens: 2 },
            output_tokens: 3,
            output_tokens_details: { reasoning_tokens: 1 },
            total_tokens: 10
          }
        }
      }
    ]
    let sent: Record<string, unknown> = {}
    let path = ""
    const mock = serve(async (req) => {
      path = new URL(req.url).pathname
      sent = (await req.json()) as Record<string, unknown>
      return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" }
      })
    })

    try {
      const upstream = await run(
        responsesAdapter.stream(
          { provider: provider(mock.port), upstream_model: "upstream-model" },
          { model: "public-model", messages: [{ role: "user", content: "hi" }], stream: true }
        )
      )
      const chunks = Array.from(await run(Stream.runCollect(upstream.sse)))

      expect(responsesAdapter.kind).toBe("openai-responses")
      expect(path).toBe("/v1/responses")
      // The adapter owns the Responses body shape: canonical messages must be
      // translated back into `input`, not posted as chat messages.
      expect(sent.stream).toBe(true)
      expect(sent.input).toEqual([{ type: "message", role: "user", content: "hi" }])

      expect(upstream.model).toBe("upstream-model")
      expect(chunks.flatMap((c) => c.choices.map((choice) => choice.delta.content ?? "")).join("")).toBe("Hello")
      // The terminal frame carries the billing usage and no choices.
      const usage = chunks.at(-1)?.usage
      expect(usage?.prompt_tokens).toBe(7)
      expect(usage?.cached_tokens).toBe(2)
      expect(usage?.reasoning_tokens).toBe(1)
      expect(chunks.at(-1)?.choices).toEqual([])
    } finally {
      await mock.stop()
    }
  })

  test("a response.failed event fails the stream with a typed error", async () => {
    const frames = [
      { type: "response.created", sequence_number: 0, response: { id: "resp_9", model: "upstream-model" } },
      { type: "response.output_text.delta", sequence_number: 1, item_id: "msg_1", delta: "par" },
      {
        type: "response.failed",
        sequence_number: 2,
        response: { id: "resp_9", status: "failed", error: { code: "server_error", message: "upstream blew up" } }
      }
    ]
    const mock = serve(
      () =>
        new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""), {
          headers: { "content-type": "text/event-stream" }
        })
    )

    try {
      const upstream = await run(
        responsesAdapter.stream(
          { provider: provider(mock.port), upstream_model: "upstream-model" },
          { model: "public-model", messages: [{ role: "user", content: "hi" }], stream: true }
        )
      )
      const error = await Effect.runPromise(
        Effect.flip(Stream.runCollect(upstream.sse).pipe(Effect.provide(layer)))
      )

      expect(error.kind).toBe("upstream")
      expect(error.message).toBe("upstream blew up")
      expect(error.retryable).toBe(true)
    } finally {
      await mock.stop()
    }
  })

  test("complete() folds a Responses body into a canonical response", async () => {
    let path = ""
    const mock = serve(async (req) => {
      path = new URL(req.url).pathname
      return new Response(
        JSON.stringify({
          id: "resp_1",
          object: "response",
          created_at: 1_737_000_000,
          status: "completed",
          model: "upstream-model",
          output: [
            {
              type: "message",
              id: "msg_1",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "hi there", annotations: [] }]
            }
          ],
          usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 }
        }),
        { headers: { "content-type": "application/json" } }
      )
    })

    try {
      const completion = await run(
        responsesAdapter.complete(
          { provider: provider(mock.port), upstream_model: "upstream-model" },
          { model: "public-model", messages: [{ role: "user", content: "hi" }] }
        )
      )

      expect(path).toBe("/v1/responses")
      expect(completion.response.choices[0]?.message.content).toBe("hi there")
      expect(completion.response.usage?.prompt_tokens).toBe(5)
      // The provider echoed the requested model, so there is no swap to report.
      expect(completion.model).toBeNull()
    } finally {
      await mock.stop()
    }
  })

  test("listModels enumerates the provider and yields [] on an unusable body", async () => {
    const seen: Array<Record<string, string>> = []
    const mock = serve((req) => {
      seen.push(Object.fromEntries(req.headers.entries()))
      return new Response(JSON.stringify({ data: [{ id: "gpt-x", owned_by: "openai" }] }), {
        headers: { "content-type": "application/json" }
      })
    })
    const broken = serve(() => new Response("<html>nope</html>"))

    try {
      const models = await run(responsesAdapter.listModels(provider(mock.port)))

      expect(seen[0]?.authorization).toBe("Bearer sk-test")
      expect(models.map((model) => model.id)).toEqual(["gpt-x"])
      expect(models[0]?.owned_by).toBe("openai")
      // A body that is not the expected shape means "nothing to enumerate".
      expect(await run(responsesAdapter.listModels(provider(broken.port)))).toEqual([])
    } finally {
      await Promise.all([mock.stop(), broken.stop()])
    }
  })

  test("a rejected request fails before the stream opens", async () => {
    const mock = serve(
      () =>
        new Response(JSON.stringify({ error: { message: "unknown model" } }), {
          status: 404,
          headers: { "content-type": "application/json" }
        })
    )

    try {
      const error = await Effect.runPromise(
        Effect.flip(
          responsesAdapter
            .stream(
              { provider: provider(mock.port), upstream_model: "upstream-model" },
              { model: "public-model", messages: [{ role: "user", content: "hi" }], stream: true }
            )
            .pipe(Effect.provide(layer))
        )
      ) as ProviderError

      expect(error.kind).toBe("not_found")
      expect(error.status).toBe(404)
    } finally {
      await mock.stop()
    }
  })
})
