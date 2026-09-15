/**
 * End-to-end smoke test.
 *
 * Boots mock upstreams (an OpenAI-compatible provider and a workbuddy2api
 * provider), starts the real gateway against a throwaway database, configures
 * providers through the **admin API** exactly as the UI would, and then exercises
 * every client-facing path: discovery, `/v1/models`, buffered and streamed Chat
 * Completions, buffered and streamed Responses, credits, and the usage dashboard.
 *
 * The point is to exercise the assembled program rather than units: routing,
 * adapters, conversion, accounting and persistence all have to work together for
 * this to pass.
 *
 * Usage: bun run scripts/smoke.ts
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const ADMIN_TOKEN = "smoke-admin-token"

interface Check {
  readonly name: string
  readonly ok: boolean
  readonly detail: string
}

const checks: Check[] = []

const check = (name: string, ok: boolean, detail: string): void => {
  checks.push({ name, ok, detail })
  const mark = ok ? "\u001b[32mPASS\u001b[0m" : "\u001b[31mFAIL\u001b[0m"
  console.log(`${mark}  ${name}${detail === "" ? "" : ` — ${detail}`}`)
}

// ---------------------------------------------------------------------------
// Mock upstreams
// ---------------------------------------------------------------------------

const encoder = new TextEncoder()

const chunk = (payload: unknown): Uint8Array => encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)

/**
 * An OpenAI-compatible upstream that also serves `/status` so it can act as a
 * workbuddy2api provider. Reports cached tokens and a trailing usage chunk so the
 * cache-rate path and the streaming accounting path are both exercised.
 */
const mockUpstream = () => {
  let chatCalls = 0
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)

      if (url.pathname === "/v1/models") {
        return Response.json({
          object: "list",
          data: [
            { id: "mock-fast", context_length: 32000, max_output_tokens: 1024 },
            { id: "mock-smart", context_length: 128000, max_output_tokens: 8192, supports_images: true },
            { id: "mock-unlisted" }
          ]
        })
      }

      if (url.pathname === "/status") {
        return Response.json({
          total: 42,
          healthy: 2,
          accounts: [
            { uid: "acct-1", nickname: "primary", credits: 30, cooling: false },
            { uid: "acct-2", nickname: "backup", credits: 12, cooling: true }
          ]
        })
      }

      if (url.pathname === "/v1/chat/completions") {
        chatCalls += 1
        const body = (await request.json()) as { stream?: boolean; model?: string; tools?: unknown[] }
        const model = body.model ?? "mock-fast"
        const id = `chatcmpl-mock-${chatCalls}`
        const created = Math.floor(Date.now() / 1000)

        // When the caller offers tools, answer with a tool call instead of text so the
        // gateway's tool_use conversion is exercised against a realistic upstream reply.
        if (Array.isArray(body.tools) && body.tools.length > 0) {
          return Response.json({
            id,
            object: "chat.completion",
            created,
            model,
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call_mock_1",
                      type: "function",
                      function: { name: "get_weather", arguments: '{"city":"Paris"}' }
                    }
                  ]
                },
                finish_reason: "tool_calls"
              }
            ],
            usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 }
          })
        }

        if (body.stream !== true) {
          return Response.json({
            id,
            object: "chat.completion",
            created,
            model,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: `reply from ${model}` },
                finish_reason: "stop"
              }
            ],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 25,
              total_tokens: 125,
              prompt_tokens_details: { cached_tokens: 60 }
            }
          })
        }

        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            // Deliberately split one frame across two writes: a gateway that
            // reassembles SSE by chunk rather than by line will corrupt this.
            const first = JSON.stringify({
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{ index: 0, delta: { role: "assistant", content: "hel" }, finish_reason: null }]
            })
            controller.enqueue(encoder.encode(`data: ${first.slice(0, 20)}`))
            await Bun.sleep(10)
            controller.enqueue(encoder.encode(`${first.slice(20)}\n\n`))

            controller.enqueue(
              chunk({
                id,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [{ index: 0, delta: { content: "lo world" }, finish_reason: null }]
              })
            )
            controller.enqueue(
              chunk({
                id,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
              })
            )
            // Usage-only trailing chunk, as include_usage produces.
            controller.enqueue(
              chunk({
                id,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [],
                usage: {
                  prompt_tokens: 100,
                  completion_tokens: 25,
                  total_tokens: 125,
                  prompt_tokens_details: { cached_tokens: 60 }
                }
              })
            )
            controller.enqueue(encoder.encode("data: [DONE]\n\n"))
            controller.close()
          }
        })
        return new Response(stream, {
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache" }
        })
      }

      return new Response("not found", { status: 404 })
    }
  })
  return { server, base: `http://127.0.0.1:${server.port}`, calls: () => chatCalls }
}

/** A second upstream, so routing across providers can be observed. */
const secondaryUpstream = () => {
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/v1/models") {
        return Response.json({ object: "list", data: [{ id: "backup-model" }] })
      }
      if (url.pathname === "/v1/chat/completions") {
        const body = (await request.json()) as { model?: string }
        return Response.json({
          id: "chatcmpl-backup",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: body.model ?? "backup-model",
          choices: [
            { index: 0, message: { role: "assistant", content: "from backup" }, finish_reason: "stop" }
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
        })
      }
      return new Response("not found", { status: 404 })
    }
  })
  return { server, base: `http://127.0.0.1:${server.port}` }
}

/** A provider whose every request fails, to prove failover and breaker behavior. */
const brokenUpstream = () => {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/v1/models") {
        return Response.json({ object: "list", data: [{ id: "broken-model" }] })
      }
      return Response.json(
        { error: { message: "upstream is unwell", type: "server_error" } },
        { status: 503 }
      )
    }
  })
  return { server, base: `http://127.0.0.1:${server.port}` }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const admin = (base: string, path: string, init?: RequestInit) =>
  fetch(`${base}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ADMIN_TOKEN}`,
      ...(init?.headers ?? {})
    }
  })

const client = (base: string, path: string, init?: RequestInit) =>
  fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) }
  })

/** Read an SSE body into the list of decoded payloads, excluding the terminator. */
const readSse = async (response: Response): Promise<Array<Record<string, unknown>>> => {
  const text = await response.text()
  const payloads: Array<Record<string, unknown>> = []
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue
    const raw = line.slice(6).trim()
    if (raw === "[DONE]" || raw === "") continue
    try {
      payloads.push(JSON.parse(raw) as Record<string, unknown>)
    } catch {
      // A malformed frame is itself a failure worth surfacing.
      payloads.push({ __unparsable: raw })
    }
  }
  return payloads
}

/**
 * Read an Anthropic SSE body: the event names in order plus the raw text.
 *
 * Anthropic frames carry the type in the `event:` field rather than in the payload,
 * so the names must be collected separately — and the raw body is kept because the
 * absence of a `[DONE]` terminator is itself part of the contract.
 */
const readNamedSse = async (
  response: Response
): Promise<{ names: string[]; payloads: Array<Record<string, unknown>>; text: string }> => {
  const text = await response.text()
  const names: string[] = []
  const payloads: Array<Record<string, unknown>> = []
  for (const line of text.split("\n")) {
    if (line.startsWith("event: ")) names.push(line.slice(7).trim())
    if (line.startsWith("data: ")) {
      const raw = line.slice(6).trim()
      if (raw === "" || raw === "[DONE]") continue
      try {
        payloads.push(JSON.parse(raw) as Record<string, unknown>)
      } catch {
        payloads.push({ __unparsable: raw })
      }
    }
  }
  return { names, payloads, text }
}

/** Parse JSON, returning null and keeping the raw text for diagnostics. */
const jsonOrNull = async <T>(response: Response): Promise<{ value: T | null; text: string }> => {
  const text = await response.text()
  try {
    return { value: JSON.parse(text) as T, text }
  } catch {
    return { value: null, text }
  }
}

const main = async () => {
  const workdir = await mkdtemp(join(tmpdir(), "agg2api-smoke-"))
  const primary = mockUpstream()
  const secondary = secondaryUpstream()
  const broken = brokenUpstream()

  const port = 0 // ask the OS for a free port via the gateway's own bind
  const gatewayPort = 18_000 + Math.floor(Math.random() * 2000)
  const base = `http://127.0.0.1:${gatewayPort}`

  const gateway = Bun.spawn(["bun", "run", "src/main.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGG2API_PORT: String(gatewayPort),
      AGG2API_HOST: "127.0.0.1",
      // Must match the config key `db_path`; a mismatch silently falls back to the
      // default file and makes runs share state.
      AGG2API_DB_PATH: join(workdir, "smoke.db"),
      AGG2API_ADMIN_TOKEN: ADMIN_TOKEN,
      // Keep the background pass out of the way; discovery is driven explicitly.
      AGG2API_DISCOVERY_INTERVAL_S: "0",
      AGG2API_LOG_RETENTION_DAYS: "0"
    },
    stdout: "pipe",
    stderr: "pipe"
  })

  const logs: string[] = []
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      logs.push(decoder.decode(value))
    }
  }
  void pump(gateway.stdout as ReadableStream<Uint8Array>)
  void pump(gateway.stderr as ReadableStream<Uint8Array>)

  /** Wait for the gateway to answer, so the test never races startup. */
  const waitForReady = async (): Promise<boolean> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const response = await fetch(`${base}/v1/models`, {
          headers: { authorization: `Bearer ${ADMIN_TOKEN}` }
        })
        if (response.status < 500) return true
      } catch {
        // Not listening yet.
      }
      await Bun.sleep(100)
    }
    return false
  }

  try {
    if (!(await waitForReady())) {
      check("gateway starts", false, `no response on ${base}; logs:\n${logs.join("")}`)
      return
    }
    check("gateway starts and serves /v1", true, base)

    // --- configure providers through the admin API, as the UI does ----------
    const createProvider = async (body: Record<string, unknown>): Promise<number> => {
      const response = await admin(base, "/admin/api/providers", {
        method: "POST",
        body: JSON.stringify(body)
      })
      if (!response.ok) throw new Error(`provider create failed: ${response.status} ${await response.text()}`)
      const created = (await response.json()) as { id: number }
      return created.id
    }

    const primaryId = await createProvider({
      name: "primary",
      kind: "openai-chat",
      base_url: primary.base,
      api_key: "upstream-key",
      priority: 100,
      input_price: 3,
      output_price: 15
    })
    const backupId = await createProvider({
      name: "backup",
      kind: "openai-chat",
      base_url: secondary.base,
      api_key: "upstream-key",
      priority: 1
    })
    const brokenId = await createProvider({
      name: "broken",
      kind: "openai-chat",
      base_url: broken.base,
      api_key: "upstream-key",
      priority: 999
    })
    const workbuddyId = await createProvider({
      name: "workbuddy",
      kind: "workbuddy2api",
      base_url: primary.base,
      api_key: "upstream-key",
      priority: 50
    })
    check("admin: create providers", true, `ids ${primaryId}, ${backupId}, ${brokenId}, ${workbuddyId}`)

    // --- discovery ---------------------------------------------------------
    const discoverResponse = await admin(base, "/admin/api/discover", { method: "POST" })
    const discoveredParsed = await jsonOrNull<{
      results: Array<{ provider_id: number; models: unknown[]; error: string | null }>
    }>(discoverResponse)
    const discovered = discoveredParsed.value ?? { results: [] }
    const primaryDiscovery = discovered.results.find((result) => result.provider_id === primaryId)
    check(
      "admin: discovery lists upstream models",
      discoverResponse.ok && (primaryDiscovery?.models.length ?? 0) === 3,
      `${primaryDiscovery?.models.length ?? 0} models`
    )

    // --- automatic model naming (discovery → routes) ------------------------
    const syncResponse = await admin(base, "/admin/api/routes/sync", { method: "POST" })
    const syncedParsed = await jsonOrNull<{ created: string[] }>(syncResponse)
    const synced = syncedParsed.value ?? { created: [] }
    check(
      "admin: routes synced from discovery",
      syncResponse.ok && synced.created.includes("mock-fast"),
      `created ${synced.created.join(", ") || "none"}`
    )

    // --- custom model naming ----------------------------------------------
    const renameResponse = await admin(base, `/admin/api/providers/${primaryId}`, {
      method: "PUT",
      body: JSON.stringify({ model_rename: { "mock-smart": "super-model" } })
    })
    await admin(base, "/admin/api/discover", { method: "POST" })
    await admin(base, "/admin/api/routes/sync", { method: "POST" })
    const modelsResponse = await client(base, "/v1/models")
    const modelsParsed = await jsonOrNull<{ data: Array<{ id: string }> }>(modelsResponse)
    const models = modelsParsed.value ?? { data: [] }
    const ids = models.data.map((entry) => entry.id)
    check(
      "custom model naming: renamed id is published",
      renameResponse.ok && ids.includes("super-model"),
      ids.join(", ")
    )

    // --- /v1/models shape --------------------------------------------------
    const card = models.data.find((entry) => entry.id === "mock-fast") as
      | { context_length?: number | null; providers?: string[] }
      | undefined
    check(
      "/v1/models exposes metadata and providers",
      card?.context_length === 32_000 && (card?.providers?.length ?? 0) > 0,
      `context_length=${card?.context_length} providers=${card?.providers?.join(",")}`
    )

    // --- buffered chat completion ------------------------------------------
    const buffered = await client(base, "/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "mock-fast", messages: [{ role: "user", content: "hi" }] })
    })
    const bufferedParsed = await jsonOrNull<{
      choices?: Array<{ message: { content: string } }>
      model?: string
    }>(buffered)
    const bufferedBody = bufferedParsed.value ?? {}
    check(
      "chat completions (buffered) returns provider content",
      buffered.ok && bufferedBody.choices?.[0]?.message.content === "reply from mock-fast",
      `status=${buffered.status} body=${bufferedParsed.text.slice(0, 300)}`
    )
    check(
      "buffered response reports the public model name",
      bufferedBody.model === "mock-fast",
      String(bufferedBody.model)
    )

    // --- streamed chat completion -----------------------------------------
    const streamed = await client(base, "/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "mock-fast",
        messages: [{ role: "user", content: "hi" }],
        stream: true
      })
    })
    const chunks = await readSse(streamed)
    const text = chunks
      .map((payload) => {
        const choices = payload.choices as Array<{ delta?: { content?: string } }> | undefined
        return choices?.[0]?.delta?.content ?? ""
      })
      .join("")
    check(
      "chat completions (streaming) reassembles a frame split across writes",
      text === "hello world",
      JSON.stringify(text)
    )
    check(
      "streaming terminates with [DONE]",
      (await (async () => {
        const raw = await client(base, "/v1/chat/completions", {
          method: "POST",
          body: JSON.stringify({ model: "mock-fast", messages: [], stream: true })
        })
        const body = await raw.text()
        return body.trimEnd().endsWith("data: [DONE]")
      })()),
      "terminator present"
    )

    // --- Responses API -----------------------------------------------------
    const responsesBuffered = await client(base, "/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "mock-fast", input: "hello" })
    })
    const responsesParsed = await jsonOrNull<{
      object?: string
      output?: Array<{ type: string; content?: Array<{ text?: string }> }>
      usage?: { input_tokens: number; output_tokens: number }
    }>(responsesBuffered)
    const responsesBody = responsesParsed.value ?? {}
    check(
      "responses (buffered) returns a spec-shaped response",
      responsesBuffered.ok &&
        responsesBody.object === "response" &&
        (responsesBody.output ?? []).some((item) => item.type === "message"),
      `object=${responsesBody.object} status=${responsesBuffered.status} body=${responsesParsed.text.slice(0, 300)}`
    )
    check(
      "responses maps tokens onto input/output",
      responsesBody.usage?.input_tokens === 100 && responsesBody.usage?.output_tokens === 25,
      JSON.stringify(responsesBody.usage)
    )

    const responsesStreamed = await client(base, "/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "mock-fast", input: "hello", stream: true })
    })
    const events = await readSse(responsesStreamed)
    const types = events.map((event) => String(event.type))
    check(
      "responses (streaming) emits a spec event sequence",
      types.includes("response.created") &&
        types.includes("response.output_text.delta") &&
        types.includes("response.completed"),
      types.slice(0, 3).join(", ") + ` … ${types.at(-1)}`
    )

    // --- Anthropic Messages API --------------------------------------------
    const messagesBuffered = await client(base, "/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "mock-fast",
        max_tokens: 256,
        messages: [{ role: "user", content: "hello" }]
      })
    })
    const messagesParsed = await jsonOrNull<{
      type?: string
      content?: Array<{ type: string; text?: string }>
      stop_reason?: string
      usage?: { input_tokens: number; output_tokens: number }
    }>(messagesBuffered)
    const messagesBody = messagesParsed.value ?? {}
    check(
      "anthropic (buffered) returns a spec-shaped message",
      messagesBuffered.ok &&
        messagesBody.type === "message" &&
        messagesBody.content?.[0]?.text === "reply from mock-fast" &&
        messagesBody.stop_reason === "end_turn",
      `type=${messagesBody.type} stop_reason=${messagesBody.stop_reason} status=${messagesBuffered.status} body=${messagesParsed.text.slice(0, 300)}`
    )
    check(
      "anthropic maps tokens onto input/output",
      (messagesBody.usage?.input_tokens ?? 0) > 0 && (messagesBody.usage?.output_tokens ?? 0) > 0,
      JSON.stringify(messagesBody.usage)
    )

    const messagesStreamed = await client(base, "/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "mock-fast",
        max_tokens: 256,
        messages: [{ role: "user", content: "hello" }],
        stream: true
      })
    })
    const named = await readNamedSse(messagesStreamed)
    check(
      "anthropic (streaming) emits the named event sequence",
      named.names.includes("message_start") &&
        named.names.includes("content_block_delta") &&
        named.names.includes("message_stop"),
      named.names.join(", ")
    )
    check(
      "anthropic streaming carries no [DONE] terminator",
      messagesStreamed.ok && !named.text.includes("[DONE]"),
      `${named.text.length} bytes`
    )

    // --- Anthropic: tool calls become tool_use blocks with parsed input -----
    const toolResponse = await client(base, "/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "mock-fast",
        max_tokens: 256,
        messages: [{ role: "user", content: "weather in Paris?" }],
        tools: [
          {
            name: "get_weather",
            description: "Look up the weather",
            input_schema: { type: "object", properties: { city: { type: "string" } } }
          }
        ]
      })
    })
    const toolBody = (await jsonOrNull<{
      content?: Array<{ type: string; name?: string; input?: unknown }>
      stop_reason?: string
    }>(toolResponse)).value ?? {}
    const toolUse = toolBody.content?.find((block) => block.type === "tool_use")
    check(
      "anthropic maps a tool call onto a tool_use block with parsed input",
      toolResponse.ok && toolUse?.name === "get_weather" && (toolUse?.input as { city?: string })?.city === "Paris",
      `stop_reason=${toolBody.stop_reason} input=${JSON.stringify(toolUse?.input)}`
    )
    check(
      "anthropic reports tool_calls as stop_reason tool_use",
      toolBody.stop_reason === "tool_use",
      String(toolBody.stop_reason)
    )

    // --- Anthropic uses its own error envelope, not OpenAI's ---------------
    const anthropicError = await client(base, "/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "ghost-model", max_tokens: 16, messages: [{ role: "user", content: "hi" }] })
    })
    const anthropicErrorBody = await jsonOrNull<{ type?: string; error?: { type?: string } }>(anthropicError)
    check(
      "anthropic errors use the Anthropic envelope",
      anthropicError.status === 404 &&
        anthropicErrorBody.value?.type === "error" &&
        anthropicErrorBody.value?.error?.type === "not_found_error",
      `status=${anthropicError.status} body=${JSON.stringify(anthropicErrorBody.value).slice(0, 160)}`
    )

    // --- failover ----------------------------------------------------------
    // "broken" has the highest priority, so it is tried first and must be
    // abandoned for a healthy provider without the caller seeing an error.
    const failoverResponse = await client(base, "/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "backup-model", messages: [{ role: "user", content: "hi" }] })
    })
    check(
      "unknown model is reported as 404, not a 500",
      (await client(base, "/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "does-not-exist", messages: [] })
      })).status === 404,
      "404"
    )
    check(
      "a model on a failing provider still resolves via failover",
      failoverResponse.ok,
      `status=${failoverResponse.status}`
    )

    // --- credits -----------------------------------------------------------
    const creditsResponse = await admin(base, `/admin/api/providers/${workbuddyId}/credits`, {
      method: "POST"
    })
    const creditsParsed = await jsonOrNull<{
      credits: { total: number; healthy: number; accounts: unknown[] } | null
    }>(creditsResponse)
    const creditsBody = creditsParsed.value ?? { credits: null }
    check(
      "workbuddy2api credits are fetched and stored",
      creditsResponse.ok &&
        creditsBody.credits?.total === 42 &&
        creditsBody.credits?.accounts.length === 2,
      `status=${creditsResponse.status} body=${creditsParsed.text.slice(0, 200)}`
    )

    // --- usage / cache rate ------------------------------------------------
    const usageResponse = await admin(base, "/admin/api/usage?window=3600000")
    const usageParsed = await jsonOrNull<{
      summary: {
        requests: number
        cache_rate: number | null
        prompt_tokens: number
        cached_tokens: number
        cost: number
        by_provider: Array<{ key: string }>
      }
    }>(usageResponse)
    const usage = usageParsed.value ?? {
      summary: { requests: 0, cache_rate: null, prompt_tokens: 0, cached_tokens: 0, cost: 0, by_provider: [] }
    }
    check(
      "usage dashboard records the requests made above",
      usageResponse.ok && usage.summary.requests >= 5,
      `requests=${usage.summary.requests}`
    )
    check(
      "cache rate is derived from provider-reported cached tokens",
      usage.summary.cache_rate !== null && usage.summary.cache_rate > 0,
      `cache_rate=${usage.summary.cache_rate}`
    )
    check(
      "cost is computed from per-provider pricing",
      usage.summary.cost > 0,
      `cost=${usage.summary.cost}`
    )

    const logResponse = await admin(base, "/admin/api/usage/log?limit=5")
    const logParsed = await jsonOrNull<{ total: number; rows: unknown[]; totals: { requests: number } }>(
      logResponse
    )
    const log = logParsed.value ?? { total: 0, rows: [], totals: { requests: 0 } }
    check(
      "usage log paginates with filtered totals",
      logResponse.ok && log.rows.length <= 5 && log.totals.requests > 0,
      `${log.rows.length} of ${log.total} rows`
    )

    const overviewResponse = await admin(base, "/admin/api/overview")
    const overviewParsed = await jsonOrNull<{ providers_total: number; credits_total: number | null }>(
      overviewResponse
    )
    const overview = overviewParsed.value ?? { providers_total: 0, credits_total: null }
    check(
      "overview summarises providers and credits",
      overviewResponse.ok && overview.providers_total === 4 && (overview.credits_total ?? 0) > 0,
      `providers=${overview.providers_total} credits=${overview.credits_total}`
    )

    // --- client keys -------------------------------------------------------
    // Creation must reveal the secret: no later read can, so masking it here would
    // leave the operator with a key they cannot use.
    const keyResponse = await admin(base, "/admin/api/keys", {
      method: "POST",
      body: JSON.stringify({ name: "smoke-client" })
    })
    const keyCreated = (await jsonOrNull<{ key?: string; masked?: string }>(keyResponse)).value ?? {}
    check(
      "creating a client key reveals the secret exactly once",
      keyResponse.ok &&
        typeof keyCreated.key === "string" &&
        keyCreated.key.startsWith("sk-agg-") &&
        keyCreated.masked !== keyCreated.key,
      `key=${keyCreated.key?.slice(0, 12)}… masked=${keyCreated.masked}`
    )

    const keyList = (await jsonOrNull<{ keys: Array<{ key?: string; masked?: string }> }>(
      await admin(base, "/admin/api/config")
    )).value ?? { keys: [] }
    check(
      "listing client keys masks the secret",
      keyList.keys.length > 0 && keyList.keys.every((entry) => entry.key === undefined),
      `${keyList.keys.length} keys, none exposing the secret`
    )

    // --- health probe ------------------------------------------------------
    // Unauthenticated by design, because Docker HEALTHCHECK and orchestrator probes
    // cannot carry a token.
    const healthResponse = await fetch(`${base}/healthz`)
    const health = (await jsonOrNull<{ status?: string; providers_enabled?: number }>(healthResponse)).value ?? {}
    check(
      "/healthz reports ok without a token",
      healthResponse.status === 200 && health.status === "ok",
      `status=${healthResponse.status} body=${JSON.stringify(health)}`
    )

    // --- auth --------------------------------------------------------------
    const unauthenticated = await fetch(`${base}/admin/api/overview`)
    check(
      "admin API rejects a missing token",
      unauthenticated.status === 401,
      `status=${unauthenticated.status}`
    )

    // --- admin UI ----------------------------------------------------------
    const ui = await fetch(`${base}/admin/`)
    const uiBody = await ui.text()
    check(
      "admin UI is served",
      ui.status === 200 && uiBody.includes("<div id=\"root\"") ,
      `status=${ui.status} bytes=${uiBody.length}`
    )
    void port
  } finally {
    gateway.kill()
    primary.server.stop(true)
    secondary.server.stop(true)
    broken.server.stop(true)
    await rm(workdir, { recursive: true, force: true })
  }

  const failed = checks.filter((entry) => !entry.ok)
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
  if (failed.length > 0) {
    console.log("\nFailures:")
    for (const entry of failed) console.log(`  - ${entry.name}: ${entry.detail}`)
    process.exit(1)
  }
}

await main()
