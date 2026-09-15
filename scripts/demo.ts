/**
 * Development/demo server.
 *
 * Starts mock upstreams, boots the gateway against them, seeds providers through
 * the admin API, sends a burst of real traffic so the dashboard has data, and then
 * stays up. Intended for driving the UI by hand or in a browser; `scripts/smoke.ts`
 * is the automated equivalent.
 *
 * Usage: bun run scripts/demo.ts
 */
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const ADMIN_TOKEN = process.env["DEMO_ADMIN_TOKEN"] ?? "demo-token"
const GATEWAY_PORT = Number(process.env["DEMO_PORT"] ?? 8799)

const encoder = new TextEncoder()
const chunk = (payload: unknown): Uint8Array => encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)

/** A provider that answers quickly and reports cached tokens. */
const fastUpstream = () => {
  let calls = 0
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)

      if (url.pathname === "/v1/models") {
        return Response.json({
          object: "list",
          data: [
            { id: "demo-mini", context_length: 128000, max_output_tokens: 4096 },
            { id: "demo-pro", context_length: 200000, max_output_tokens: 8192, supports_images: true },
            { id: "demo-embed" }
          ]
        })
      }

      if (url.pathname === "/status") {
        return Response.json({
          total: 18_420,
          healthy: 2,
          accounts: [
            { uid: "u-1001", nickname: "primary", realm: "cn", credits: 12_300, cooling: false },
            { uid: "u-1002", nickname: "backup", realm: "cn", credits: 6_000, cooling: true },
            { uid: "u-1003", nickname: "expired", realm: "global", credits: 120, disabled: true, disabled_reason: "402 quota" }
          ]
        })
      }

      if (url.pathname === "/v1/chat/completions") {
        calls += 1
        const body = (await request.json()) as { stream?: boolean; model?: string }
        const model = body.model ?? "demo-mini"
        const id = `chatcmpl-demo-${calls}`
        const created = Math.floor(Date.now() / 1000)

        if (body.stream !== true) {
          return Response.json({
            id,
            object: "chat.completion",
            created,
            model,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: `This is a demo reply from ${model}.` },
                finish_reason: "stop"
              }
            ],
            usage: {
              prompt_tokens: 1200,
              completion_tokens: 180,
              total_tokens: 1380,
              prompt_tokens_details: { cached_tokens: 900 }
            }
          })
        }

        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            for (const piece of ["This ", "is ", "a ", "streamed ", "demo ", "reply."]) {
              controller.enqueue(
                chunk({
                  id,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  choices: [{ index: 0, delta: { content: piece }, finish_reason: null }]
                })
              )
              await Bun.sleep(30)
            }
            controller.enqueue(
              chunk({
                id,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
              })
            )
            controller.enqueue(
              chunk({
                id,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [],
                usage: {
                  prompt_tokens: 1200,
                  completion_tokens: 180,
                  total_tokens: 1380,
                  prompt_tokens_details: { cached_tokens: 900 }
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
  return { server, base: `http://127.0.0.1:${server.port}` }
}

/** A second provider that always fails, so the breaker and error rows are visible. */
const flakyUpstream = () => {
  let calls = 0
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/v1/models") {
        return Response.json({ object: "list", data: [{ id: "demo-pro" }] })
      }
      calls += 1
      // Fail the first few calls, then recover — so the dashboard shows both open
      // and recovered breaker states.
      if (calls <= 3) {
        return Response.json({ error: { message: "temporarily overloaded" } }, { status: 503 })
      }
      const body = (await request.json()) as { model?: string }
      return Response.json({
        id: `chatcmpl-flaky-${calls}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model ?? "demo-pro",
        choices: [
          { index: 0, message: { role: "assistant", content: "Recovered on the second provider." }, finish_reason: "stop" }
        ],
        usage: { prompt_tokens: 800, completion_tokens: 90, total_tokens: 890, prompt_tokens_details: { cached_tokens: 200 } }
      })
    }
  })
  return { server, base: `http://127.0.0.1:${server.port}` }
}

const admin = (path: string, init?: RequestInit) =>
  fetch(`http://127.0.0.1:${GATEWAY_PORT}${path}`, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_TOKEN}`, ...(init?.headers ?? {}) }
  })

const client = (path: string, body: unknown) =>
  fetch(`http://127.0.0.1:${GATEWAY_PORT}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  })

const main = async () => {
  const workdir = await mkdtemp(join(tmpdir(), "agg2api-demo-"))
  const fast = fastUpstream()
  const flaky = flakyUpstream()

  const gateway = Bun.spawn(["bun", "run", "src/main.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGG2API_PORT: String(GATEWAY_PORT),
      AGG2API_HOST: "127.0.0.1",
      AGG2API_DB_PATH: join(workdir, "demo.db"),
      AGG2API_ADMIN_TOKEN: ADMIN_TOKEN,
      AGG2API_DISCOVERY_INTERVAL_S: "300",
      AGG2API_LOG_RETENTION_DAYS: "0"
    },
    stdout: "inherit",
    stderr: "inherit"
  })

  const ready = async (): Promise<boolean> => {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/v1/models`)
        if (response.status < 500) return true
      } catch {
        // not listening yet
      }
      await Bun.sleep(100)
    }
    return false
  }

  if (!(await ready())) {
    console.error("gateway did not start")
    gateway.kill()
    process.exit(1)
  }

  const createProvider = async (body: Record<string, unknown>): Promise<number> => {
    const response = await admin("/admin/api/providers", { method: "POST", body: JSON.stringify(body) })
    if (!response.ok) throw new Error(`create failed: ${await response.text()}`)
    return ((await response.json()) as { id: number }).id
  }

  await createProvider({
    name: "demo-fast",
    kind: "openai-chat",
    base_url: fast.base,
    api_key: "demo-upstream-key",
    priority: 200,
    input_price: 0.5,
    output_price: 1.5,
    model_rename: { "demo-pro": "demo-pro" }
  })
  await createProvider({
    name: "demo-flaky",
    kind: "openai-chat",
    base_url: flaky.base,
    api_key: "demo-upstream-key",
    priority: 100
  })
  await createProvider({
    name: "demo-workbuddy",
    kind: "workbuddy2api",
    base_url: fast.base,
    api_key: "demo-upstream-key",
    priority: 50
  })

  await admin("/admin/api/discover", { method: "POST" })
  await admin("/admin/api/routes/sync", { method: "POST" })
  await admin("/admin/api/keys", {
    method: "POST",
    body: JSON.stringify({ name: "demo-client", rate_limit_rpm: 600, allowed_models: [] })
  })

  // Make the route for demo-pro prefer the healthy provider so the preferred-target
  // indicator in the UI has something meaningful to show.
  await admin("/admin/api/routes/demo-pro", {
    method: "PUT",
    body: JSON.stringify({ strategy: "weighted", display_name: "Demo Pro (weighted)" })
  })

  // Generate traffic so the dashboard is not empty. Includes a few failures by
  // asking for a model only the flaky provider serves.
  const models = ["demo-mini", "demo-pro", "demo-embed"]
  for (let round = 0; round < 14; round += 1) {
    const model = models[round % models.length] ?? "demo-mini"
    if (round % 4 === 0) {
      await client("/v1/chat/completions", {
        model,
        messages: [{ role: "user", content: "hello" }],
        stream: true
      }).then((response) => response.text())
    } else {
      await client("/v1/chat/completions", {
        model,
        messages: [{ role: "user", content: "hello" }]
      }).then((response) => response.text())
    }
  }
  await client("/v1/responses", { model: "demo-mini", input: "hello" }).then((response) => response.text())
  for (let i = 0; i < 3; i += 1) {
    await client("/anthropic/v1/messages", {
      model: "demo-mini",
      max_tokens: 128,
      messages: [{ role: "user", content: "hello from anthropic" }]
    }).then((response) => response.text())
  }
  await client("/v1/chat/completions", { model: "nope-missing", messages: [] }).then((response) => response.text())
  await admin("/admin/api/providers/3/credits", { method: "POST" })

  console.log(`\n  agg2api demo ready`)
  console.log(`    dashboard : http://127.0.0.1:${GATEWAY_PORT}/admin/`)
  console.log(`    admin token: ${ADMIN_TOKEN}`)
  console.log(`    OpenAI API : http://127.0.0.1:${GATEWAY_PORT}/v1`)
  console.log(`    Anthropic  : http://127.0.0.1:${GATEWAY_PORT}/anthropic`)
  console.log(`    database   : ${join(workdir, "demo.db")}\n`)

  const shutdown = () => {
    gateway.kill()
    fast.server.stop(true)
    flaky.server.stop(true)
    process.exit(0)
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
  // Park forever; the signal handlers above are the only exit.
  await Promise.withResolvers<void>().promise
}

await main()
