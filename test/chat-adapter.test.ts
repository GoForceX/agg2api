/**
 * Adapter behaviour against mock upstreams.
 *
 * These run the real adapters over a real socket rather than stubbing the HTTP
 * layer, because the properties under test — where a failure becomes observable,
 * and whether a frame split across TCP writes survives reassembly — are exactly
 * the ones a stub would paper over.
 */
import { describe, expect, test } from "bun:test"
import * as FetchHttpClient from "@effect/platform/FetchHttpClient"
import type * as HttpClient from "@effect/platform/HttpClient"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import type { Provider } from "../src/domain.ts"
import type { ProviderError } from "../src/errors.ts"
import type { Target } from "../src/upstream/adapter.ts"
import { openaiChatAdapter } from "../src/upstream/chat-adapter.ts"
import { fetchCredits, workbuddyAdapter } from "../src/upstream/workbuddy.ts"

const layer = FetchHttpClient.layer

const run = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(layer)))

/** Run an effect expected to fail, surfacing the typed error. */
const runFailure = <A>(effect: Effect.Effect<A, ProviderError, HttpClient.HttpClient>): Promise<ProviderError> =>
  Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.flip))

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

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const provider = (port: number, over: Partial<Provider> = {}): Provider => ({
  id: 1,
  name: "mock",
  kind: "openai-chat",
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
  updated_at: 0,
  ...over
})

const target = (port: number, over: Partial<Provider> = {}): Target => ({
  provider: provider(port, over),
  upstream_model: "upstream-model"
})

const request = (over: Partial<Parameters<typeof openaiChatAdapter.complete>[1]> = {}) => ({
  model: "public-model",
  messages: [{ role: "user" as const, content: "hello" }],
  ...over
})

const encoder = new TextEncoder()

describe("openaiChatAdapter.complete", () => {
  test("normalises usage reported as prompt_tokens_details.cached_tokens", async () => {
    let seen: Record<string, unknown> = {}
    const mock = serve(async (req) => {
      seen = (await req.json()) as Record<string, unknown>
      return json({
        id: "chatcmpl-1",
        object: "chat.completion",
        created: 1_737_000_000,
        model: "upstream-model",
        choices: [
          { index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }
        ],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          prompt_tokens_details: { cached_tokens: 40 }
        }
      })
    })
    try {
      const completion = await run(openaiChatAdapter.complete(target(mock.port), request()))

      expect(seen.model).toBe("upstream-model")
      expect(completion.response.usage?.prompt_tokens).toBe(100)
      expect(completion.response.usage?.completion_tokens).toBe(20)
      expect(completion.response.usage?.cached_tokens).toBe(40)
      // The provider echoed the requested model, so there is no swap to report.
      expect(completion.model).toBeNull()
      expect(completion.response.choices[0]?.message.content).toBe("hi")
    } finally {
      await mock.stop()
    }
  })
})

describe("openaiChatAdapter.stream", () => {
  test("reassembles content split across two writes and keeps the usage-only chunk", async () => {
    const first = { index: 0, delta: { content: "Hel" }, finish_reason: null }
    const second = { index: 0, delta: { content: "lo" }, finish_reason: "stop" }
    const head = `data: ${JSON.stringify({
      id: "chunk-1",
      object: "chat.completion.chunk",
      created: 1,
      model: "upstream-model",
      choices: [first]
    })}`
    const rest = `\n\ndata: ${JSON.stringify({
      id: "chunk-2",
      object: "chat.completion.chunk",
      created: 1,
      model: "upstream-model",
      choices: [second]
    })}\n\ndata: ${JSON.stringify({
      id: "chunk-3",
      object: "chat.completion.chunk",
      created: 1,
      model: "upstream-model",
      choices: [],
      usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 }
    })}\n\ndata: [DONE]\n\n`
    // The body is pull-driven, so the consumer has already taken one chunk before
    // the next exists: the frame really does arrive in two separate writes, with no
    // timing assumption to flake on.
    let step = 0
    let sent: Record<string, unknown> = {}
    const mock = serve(async (req) => {
      sent = (await req.json()) as Record<string, unknown>
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            // Cut the first frame mid-payload — the parser must not emit it yet.
            if (step === 0) controller.enqueue(encoder.encode(head.slice(0, head.length - 8)))
            else if (step === 1) controller.enqueue(encoder.encode(head.slice(-8) + rest))
            else {
              controller.close()
              return
            }
            step += 1
          }
        }),
        { headers: { "content-type": "text/event-stream" } }
      )
    })
    try {
      const upstream = await run(
        openaiChatAdapter.stream(
          target(mock.port),
          request({ stream: true, stream_options: { include_usage: false } })
        )
      )
      const chunks = Array.from(await run(Stream.runCollect(upstream.sse)))

      expect(upstream.model).toBe("upstream-model")
      expect(chunks.flatMap((chunk) => chunk.choices.map((choice) => choice.delta.content ?? "")).join("")).toBe(
        "Hello"
      )
      expect(chunks).toHaveLength(3)
      expect(chunks[1]?.choices[0]?.finish_reason).toBe("stop")

      // The last chunk carries only usage — the accumulator's billing source.
      const usage = chunks.at(-1)?.usage
      expect(usage?.prompt_tokens).toBe(7)
      expect(usage?.completion_tokens).toBe(2)
      expect(usage?.total_tokens).toBe(9)

      // Billing reads the trailing usage chunk, so the flag is forced even though
      // the canonical request never asked for it.
      expect(sent.stream_options).toEqual({ include_usage: true })
      expect(sent.stream).toBe(true)
    } finally {
      await mock.stop()
    }
  })

  test("keeps the usage chunk when upstream closes without a trailing blank line", async () => {
    // Providers routinely close straight after the last event, leaving the final frame
    // unterminated. Dropping it loses the usage chunk — the only source of cached-token
    // counts — so every such request would be billed as zero cache hits.
    const content = { index: 0, delta: { content: "Hi" }, finish_reason: null }
    const body =
      `data: ${JSON.stringify({
        id: "chunk-1",
        object: "chat.completion.chunk",
        created: 1,
        model: "upstream-model",
        choices: [content]
      })}\n\n` +
      `data: ${JSON.stringify({
        id: "chunk-2",
        object: "chat.completion.chunk",
        created: 1,
        model: "upstream-model",
        choices: [],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 5,
          total_tokens: 105,
          prompt_tokens_details: { cached_tokens: 60 }
        }
      })}`
    const mock = serve(() => new Response(body, { headers: { "content-type": "text/event-stream" } }))
    try {
      const upstream = await run(openaiChatAdapter.stream(target(mock.port), request({ stream: true })))
      const chunks = Array.from(await run(Stream.runCollect(upstream.sse)))

      expect(chunks.flatMap((chunk) => chunk.choices.map((choice) => choice.delta.content ?? "")).join("")).toBe("Hi")
      const usage = chunks.at(-1)?.usage
      expect(usage?.prompt_tokens).toBe(100)
      expect(usage?.cached_tokens).toBe(60)
    } finally {
      await mock.stop()
    }
  })
})

describe("failures", () => {
  test("a 429 is a retryable rate_limit error before the stream opens", async () => {
    const mock = serve(
      () =>
        new Response(JSON.stringify({ error: { message: "slow down" } }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "2" }
        })
    )
    try {
      const complete = await runFailure(openaiChatAdapter.complete(target(mock.port), request()))
      expect(complete.kind).toBe("rate_limit")
      expect(complete.retryable).toBe(true)
      expect(complete.retry_after_ms).toBe(2000)
      expect(complete.status).toBe(429)

      // `stream` must reject too: the gateway commits to a provider only after
      // this effect succeeds, so a rejection has to reach the caller here.
      const stream = await runFailure(openaiChatAdapter.stream(target(mock.port), request({ stream: true })))
      expect(stream.kind).toBe("rate_limit")
      expect(stream.retryable).toBe(true)
    } finally {
      await mock.stop()
    }
  })

  test("a transport failure is a retryable network error", async () => {
    // Bind then release a port so nothing is listening on it.
    const dead = serve(() => json({}))
    const port = dead.port
    await dead.stop()

    const error = await runFailure(openaiChatAdapter.listModels(provider(port)))
    expect(error.kind).toBe("network")
    expect(error.retryable).toBe(true)
    expect(error.status).toBe(0)
  })
})

describe("shared chat path", () => {
  test("workbuddy2api posts to the same route and reports a swapped model", async () => {
    let path = ""
    const mock = serve(async (req) => {
      path = new URL(req.url).pathname
      return json({
        id: "chatcmpl-2",
        object: "chat.completion",
        created: 1,
        model: "upstream-model-v2",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 }
      })
    })
    try {
      const completion = await run(
        workbuddyAdapter.complete(target(mock.port, { kind: "workbuddy2api" }), request())
      )

      expect(path).toBe("/v1/chat/completions")
      expect(workbuddyAdapter.kind).toBe("workbuddy2api")
      expect(completion.model).toBe("upstream-model-v2")
    } finally {
      await mock.stop()
    }
  })
})

describe("listModels", () => {
  test("authenticates the listing request and lets operator headers win", async () => {
    const seen: Array<Record<string, string>> = []
    const mock = serve((req) => {
      seen.push(Object.fromEntries(req.headers.entries()))
      return json({ data: [] })
    })
    try {
      await run(openaiChatAdapter.listModels(provider(mock.port)))
      await run(
        openaiChatAdapter.listModels(
          provider(mock.port, { api_key: "", headers: { Authorization: "X-Custom tok" } })
        )
      )
      await run(openaiChatAdapter.listModels(provider(mock.port, { api_key: "" })))

      expect(seen[0]?.authorization).toBe("Bearer sk-test")
      expect(seen[0]?.accept).toBe("application/json")
      // An operator-supplied scheme is passed through untouched.
      expect(seen[1]?.authorization).toBe("X-Custom tok")
      // No key configured means no credential at all.
      expect(seen[2]?.authorization).toBeUndefined()
    } finally {
      await mock.stop()
    }
  })

  test("reports an unreadable payload as not enumerated, not as an empty catalogue", async () => {
    const envelope = serve(() => json({ error: { message: "unauthorized" } }))
    const html = serve(() => new Response("<html>gateway</html>", { status: 200 }))
    const empty = serve(() => json({ data: [] }))
    try {
      // A proxy error envelope under HTTP 200 must not read as "this provider has no
      // models": discovery replaces the stored catalogue with the result, so that would
      // delete every model and route.
      expect(await run(openaiChatAdapter.listModels(provider(envelope.port)))).toEqual({
        models: [],
        enumerated: false
      })
      expect(await run(openaiChatAdapter.listModels(provider(html.port)))).toEqual({
        models: [],
        enumerated: false
      })
      // A genuine empty catalogue is authoritative.
      expect(await run(openaiChatAdapter.listModels(provider(empty.port)))).toEqual({
        models: [],
        enumerated: true
      })
    } finally {
      await Promise.all([envelope.stop(), html.stop(), empty.stop()])
    }
  })

  test("reads capability metadata nested under top_provider and keeps the rest in raw", async () => {
    const mock = serve(() =>
      json({
        data: [
          {
            id: "m1",
            owned_by: "workbuddy",
            top_provider: { context_length: 128_000, max_output_tokens: 8192 },
            meta: { supports_images: true },
            reasoning_supported_efforts: ["low", "high"]
          },
          { owned_by: "nobody" }
        ]
      })
    )
    try {
      const { models, enumerated } = await run(
        workbuddyAdapter.listModels(provider(mock.port, { kind: "workbuddy2api" }))
      )

      expect(enumerated).toBe(true)
      expect(models).toHaveLength(1)
      expect(models[0]?.id).toBe("m1")
      expect(models[0]?.context_length).toBe(128_000)
      expect(models[0]?.max_output_tokens).toBe(8192)
      expect(models[0]?.supports_images).toBe(true)
      expect(models[0]?.owned_by).toBe("workbuddy")
      expect(models[0]?.raw).toMatchObject({ reasoning_supported_efforts: ["low", "high"] })
    } finally {
      await mock.stop()
    }
  })
})

describe("fetchCredits", () => {
  test("maps a two-account snapshot and derives the totals when absent", async () => {
    const mock = serve((req) => {
      expect(new URL(req.url).pathname).toBe("/status")
      return json({
        accounts: [
          { uid: "u1", nickname: "one", realm: "cn", credits: 10.5 },
          { uid: "u2", credits: 4.25, cooling: true, disabled_reason: "cooldown" }
        ]
      })
    })
    try {
      const credits = await run(fetchCredits(provider(mock.port, { kind: "workbuddy2api" })))

      expect(credits.provider_id).toBe(1)
      expect(credits.total).toBe(14.75)
      expect(credits.healthy).toBe(1)
      expect(credits.accounts).toHaveLength(2)
      expect(credits.accounts[0]?.nickname).toBe("one")
      expect(credits.accounts[1]?.cooling).toBe(true)
      expect(credits.accounts[1]?.disabled_reason).toBe("cooldown")
      expect(credits.error).toBeNull()
      expect(credits.fetched_at).toBeGreaterThan(0)
    } finally {
      await mock.stop()
    }
  })

  test("reads a snapshot nested under data and derives the totals from the rows", async () => {
    // The payload's own `total` is the *number of accounts in the pool*, not a balance,
    // so it must not be read as one: doing so reported a two-account pool holding 7032
    // credits as "2". `healthy` is derived for the same reason.
    const mock = serve(() =>
      json({
        data: {
          accounts: [
            { uid: "u1", credits: 2256 },
            { uid: "u2", credits: 4776, cooling: true }
          ],
          total: 2,
          healthy: 2
        }
      })
    )
    try {
      const credits = await run(fetchCredits(provider(mock.port, { kind: "workbuddy2api" })))

      expect(credits.total).toBe(7032)
      expect(credits.healthy).toBe(1)
      expect(credits.accounts).toHaveLength(2)
    } finally {
      await mock.stop()
    }
  })

  test("falls back to the payload's own figures when it lists no accounts", async () => {
    // A build that states a balance and no rows is still usable.
    const mock = serve(() => json({ accounts: [], total: 500, healthy: 3 }))
    try {
      const credits = await run(fetchCredits(provider(mock.port, { kind: "workbuddy2api" })))
      expect(credits.total).toBe(500)
      expect(credits.healthy).toBe(3)
    } finally {
      await mock.stop()
    }
  })

  test("fails on a 200 whose body is an error instead of reporting an empty pool", async () => {
    // Proxies commonly report failure as HTTP 200 with an error body. Reading that as a
    // zero-credit pool would show a funded account as empty and — because the caller
    // stores a successful snapshot — destroy the last known balance.
    const mock = serve(() => json({ error: { message: "unauthorized" } }))
    try {
      const failure = await runFailure(fetchCredits(provider(mock.port, { kind: "workbuddy2api" })))
      expect(failure.kind).toBe("network")
      expect(failure.status).toBe(200)
      expect(failure.message).toBe("unauthorized")
    } finally {
      await mock.stop()
    }
  })

  test("accepts an empty but well-formed pool", async () => {
    const mock = serve(() => json({ accounts: [], total: 0, healthy: 0 }))
    try {
      const credits = await run(fetchCredits(provider(mock.port, { kind: "workbuddy2api" })))
      expect(credits.total).toBe(0)
      expect(credits.accounts).toHaveLength(0)
      expect(credits.error).toBeNull()
    } finally {
      await mock.stop()
    }
  })
})
