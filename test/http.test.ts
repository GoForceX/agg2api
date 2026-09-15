/**
 * HTTP-level integration test.
 *
 * Boots the real `src/main.ts` process against a throwaway database and mock
 * upstreams, then drives it over HTTP. This is where the regressions live that unit
 * tests cannot see: path-parameter decoding, which error schema wins for a given
 * status code, admin authorization, and whether a failure is recorded in the usage
 * log at all.
 *
 * A separate SQLite connection reads the same file the gateway wrote, so assertions
 * check what was actually persisted rather than what an API claimed.
 *
 * The gateway is spawned as a subprocess rather than assembled in-process because
 * that is exactly what runs in production; rebuilding the layer graph here would test
 * a different composition than the one that ships. Startup is awaited by polling for
 * readiness, which is the only deterministic signal a child process offers.
 *
 * Usage: bun test test/http.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const ADMIN_TOKEN = "http-test-token"

type Mock = { readonly base: string; readonly stop: () => void }

/** Mock upstream: model listing, buffered and streaming chat, and credits. */
const mockUpstream = (): Mock => {
  const encoder = new TextEncoder()
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)

      if (url.pathname === "/v1/models") {
        return Response.json({
          object: "list",
          data: [{ id: "test-model", context_length: 8000, max_output_tokens: 512 }]
        })
      }

      if (url.pathname === "/status") {
        return Response.json({ total: 500, healthy: 1, accounts: [{ uid: "u1", credits: 500 }] })
      }

      if (url.pathname === "/v1/chat/completions") {
        const body = (await request.json()) as { stream?: boolean; model?: string }
        const model = body.model ?? "test-model"
        const usage = {
          prompt_tokens: 200,
          completion_tokens: 10,
          total_tokens: 210,
          prompt_tokens_details: { cached_tokens: 150 }
        }

        if (body.stream !== true) {
          return Response.json({
            id: "chatcmpl-test",
            object: "chat.completion",
            created: 1_700_000_000,
            model,
            choices: [
              { index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }
            ],
            usage
          })
        }

        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const frame = (payload: unknown) => encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)
            controller.enqueue(
              frame({
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                created: 1_700_000_000,
                model,
                choices: [{ index: 0, delta: { content: "po" }, finish_reason: null }]
              })
            )
            // The usage-only trailing chunk: streaming accounting depends on it.
            controller.enqueue(
              frame({
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                created: 1_700_000_000,
                model,
                choices: [{ index: 0, delta: { content: "ng" }, finish_reason: "stop" }],
                usage
              })
            )
            controller.enqueue(encoder.encode("data: [DONE]\n\n"))
            controller.close()
          }
        })
        return new Response(stream, { headers: { "content-type": "text/event-stream" } })
      }

      return new Response("not found", { status: 404 })
    }
  })
  return { base: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

let workdir = ""
let upstream: Mock
let gateway: ReturnType<typeof Bun.spawn>
let base = ""
let db: Database

const request = (path: string, init?: RequestInit) => fetch(`${base}${path}`, init)

const admin = (path: string, init?: RequestInit) =>
  request(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ADMIN_TOKEN}`,
      ...(init?.headers ?? {})
    }
  })

const chat = (body: unknown) =>
  request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  })

const createProvider = async (body: Record<string, unknown>): Promise<number> => {
  const response = await admin("/admin/api/providers", { method: "POST", body: JSON.stringify(body) })
  if (!response.ok) throw new Error(`provider create failed ${response.status}: ${await response.text()}`)
  return ((await response.json()) as { id: number }).id
}

beforeAll(async () => {
  workdir = await mkdtemp(join(tmpdir(), "agg2api-http-"))
  const dbPath = join(workdir, "test.db")
  upstream = mockUpstream()

  // `port: 0` is not used because the OS-assigned port must be known in advance to
  // reach the child; a random high port keeps parallel runs from colliding.
  const port = 20_000 + Math.floor(Math.random() * 8_000)
  base = `http://127.0.0.1:${port}`

  gateway = Bun.spawn(["bun", "run", "src/main.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGG2API_HOST: "127.0.0.1",
      AGG2API_PORT: String(port),
      AGG2API_DB_PATH: dbPath,
      AGG2API_ADMIN_TOKEN: ADMIN_TOKEN,
      AGG2API_DISCOVERY_INTERVAL_S: "0",
      AGG2API_LOG_RETENTION_DAYS: "0"
    },
    stdout: "ignore",
    stderr: "ignore"
  })

  let ready = false
  for (let attempt = 0; attempt < 150 && !ready; attempt += 1) {
    try {
      ready = (await request("/v1/models")).status < 500
    } catch {
      // Not listening yet.
    }
    if (!ready) await Bun.sleep(100)
  }
  if (!ready) throw new Error(`gateway did not become ready on ${base}`)

  db = new Database(dbPath)

  await createProvider({
    name: "primary",
    kind: "openai-chat",
    base_url: upstream.base,
    input_price: 1000,
    output_price: 2000
  })
  await admin("/admin/api/discover", { method: "POST" })
  await admin("/admin/api/routes/sync", { method: "POST" })
})

afterAll(async () => {
  db?.close()
  gateway?.kill()
  upstream?.stop()
  if (workdir !== "") await rm(workdir, { recursive: true, force: true })
})

describe("admin API over HTTP", () => {
  test("authorises the admin surface and rejects a bad token", async () => {
    expect((await admin("/admin/api/overview")).status).toBe(200)
    expect((await request("/admin/api/overview")).status).toBe(401)
    expect(
      (await request("/admin/api/overview", { headers: { authorization: "Bearer wrong" } })).status
    ).toBe(401)

    // The UI must load unauthenticated, because prompting for a token is its job.
    expect((await request("/admin/")).status).toBe(200)
  })

  test("decodes a numeric path parameter and updates the row", async () => {
    const id = await createProvider({ name: "patchable", kind: "openai-chat", base_url: upstream.base })

    // A numeric path parameter arrives as a string. Declaring `Schema.Number` makes
    // the router reject every id with a 400 before the handler ever runs.
    const updated = await admin(`/admin/api/providers/${id}`, {
      method: "PUT",
      body: JSON.stringify({ priority: 7 })
    })
    expect(updated.status).toBe(200)
    expect(((await updated.json()) as { priority: number }).priority).toBe(7)
  })

  test("reports 404 for a missing row and 400 for an invalid payload", async () => {
    // A single error schema reused across statuses makes the encoder pick whichever
    // variant the group saw first, so every failure returns that one status.
    expect(
      (
        await admin("/admin/api/providers/999999", {
          method: "PUT",
          body: JSON.stringify({ priority: 1 })
        })
      ).status
    ).toBe(404)

    expect(
      (
        await admin("/admin/api/providers", {
          method: "POST",
          body: JSON.stringify({ name: "x", kind: "not-a-kind", base_url: "https://x.test" })
        })
      ).status
    ).toBe(400)

    expect(
      (
        await admin("/admin/api/providers", {
          method: "POST",
          body: JSON.stringify({ name: "y", kind: "openai-chat", base_url: "" })
        })
      ).status
    ).toBe(400)
  })

  test("deletes an existing provider and then reports it missing", async () => {
    const id = await createProvider({ name: "doomed", kind: "openai-chat", base_url: upstream.base })
    expect((await admin(`/admin/api/providers/${id}`, { method: "DELETE" })).status).toBe(204)
    expect((await admin(`/admin/api/providers/${id}`, { method: "DELETE" })).status).toBe(404)
  })

  test("masks provider secrets in the config payload", async () => {
    const id = await createProvider({
      name: "secretive",
      kind: "openai-chat",
      base_url: upstream.base,
      api_key: "sk-super-secret-value"
    })

    const response = await admin("/admin/api/config")
    expect(response.status).toBe(200)
    const text = await response.text()
    // The secret must not appear anywhere in the payload, not merely be masked in
    // the field the UI happens to read.
    expect(text).not.toContain("sk-super-secret-value")

    const config = JSON.parse(text) as { providers: Array<{ provider: { id: number; api_key: string } }> }
    const entry = config.providers.find((item) => item.provider.id === id)
    expect(entry).toBeDefined()
    expect((entry?.provider.api_key ?? "").length).toBeGreaterThan(0)
  })

  test("reports credits for a workbuddy2api provider", async () => {
    const id = await createProvider({ name: "wb", kind: "workbuddy2api", base_url: upstream.base })
    const response = await admin(`/admin/api/providers/${id}/credits`, { method: "POST" })
    expect(response.status).toBe(200)

    const body = (await response.json()) as { credits: { total: number; accounts: unknown[] } | null }
    expect(body.credits?.total).toBe(500)
    expect(body.credits?.accounts.length).toBe(1)
  })
})

describe("v1 over HTTP", () => {
  test("buffers a chat completion and reports the public model name", async () => {
    const response = await chat({ model: "test-model", messages: [{ role: "user", content: "hi" }] })
    expect(response.status).toBe(200)

    const body = (await response.json()) as {
      object: string
      model: string
      choices: Array<{ message: { content: string } }>
    }
    expect(body.object).toBe("chat.completion")
    expect(body.choices[0]?.message.content).toBe("pong")
    expect(body.model).toBe("test-model")
  })

  test("streams a completion and accounts for the trailing usage chunk", async () => {
    const response = await chat({
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      stream: true
    })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")

    const text = await response.text()
    expect(text).toContain('"content":"po"')
    expect(text).toContain('"content":"ng"')
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true)

    // Streaming usage only arrives in the trailing chunk. If the accumulator misses
    // it, every streamed request is recorded as zero tokens.
    const row = db
      .query<{ prompt_tokens: number; cached_tokens: number }, []>(
        `SELECT prompt_tokens, cached_tokens FROM usage_log WHERE stream = 1 ORDER BY id DESC LIMIT 1`
      )
      .get()
    expect(row?.prompt_tokens).toBe(200)
    expect(row?.cached_tokens).toBe(150)
  })

  test("serves the Responses API from a chat-completions provider", async () => {
    const response = await request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "test-model", input: "hello" })
    })
    expect(response.status).toBe(200)

    const body = (await response.json()) as {
      object: string
      output: Array<{ type: string }>
      usage: { input_tokens: number; output_tokens: number }
    }
    expect(body.object).toBe("response")
    expect(body.output.some((item) => item.type === "message")).toBe(true)
    expect(body.usage.input_tokens).toBe(200)
    expect(body.usage.output_tokens).toBe(10)
  })

  test("records an unknown-model failure instead of dropping it", async () => {
    const count = () =>
      db
        .query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM usage_log WHERE status = 404`)
        .get()?.count ?? 0

    const before = count()
    expect((await chat({ model: "does-not-exist", messages: [] })).status).toBe(404)

    // A request that never reached a provider must still be visible, or the
    // dashboard's error rate under-reports real failures.
    expect(count()).toBe(before + 1)

    const row = db
      .query<{ public_model: string; error_kind: string }, []>(
        `SELECT public_model, error_kind FROM usage_log WHERE status = 404 ORDER BY id DESC LIMIT 1`
      )
      .get()
    expect(row?.public_model).toBe("does-not-exist")
    expect(row?.error_kind).toBe("unknown_model")
  })

  test("lists models with discovery metadata and prices a request", async () => {
    const response = await request("/v1/models")
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      object: string
      data: Array<{ id: string; context_length: number | null }>
    }
    expect(body.object).toBe("list")
    expect(body.data.find((model) => model.id === "test-model")?.context_length).toBe(8000)

    // 200/1e6*1000 prompt + 10/1e6*2000 completion = 0.22 for the buffered call.
    const cost = db
      .query<{ cost: number }, []>(
        `SELECT cost FROM usage_log WHERE public_model = 'test-model' ORDER BY id DESC LIMIT 1`
      )
      .get()?.cost
    expect(cost).toBeCloseTo(0.22, 10)
  })
})
