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
let providerId = 0

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
      AGG2API_LOG_RETENTION_DAYS: "0",
      // Small enough that the body-cap test can prove the limit is enforced while
      // reading a chunked stream, without buffering megabytes in a test.
      AGG2API_MAX_BODY_BYTES: "65536"
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

  providerId = await createProvider({
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

  test("authorises every path spelling the router maps to an admin endpoint", async () => {
    // The router matches case-insensitively, collapses duplicate slashes, decodes
    // percent-escapes and ignores a trailing slash. A guard built on a literal
    // `/admin/api` prefix therefore protected only the canonical spelling, and every
    // variant below reached the handlers — including writes and the endpoint that
    // returns provider credentials — without a token.
    const bypasses = [
      "/ADMIN/API/OVERVIEW",
      "//admin/api/overview",
      "///admin/api/overview",
      "/%61dmin/api/overview",
      "/ADMIN/API/OVERVIEW/",
      "/admin/API/Overview",
      "/ADMIN/API/../API/overview"
    ]
    for (const path of bypasses) {
      const response = await fetch(`${base}${path}`)
      const text = await response.text()
      // The invariant is that no spelling yields admin data without a token. Each one
      // is either rejected outright, or served the SPA shell by the static mount —
      // which matches the literal lowercase `/admin/` prefix, so a mixed-case path
      // never reaches the API and falls through to the shell instead.
      const rejected = response.status === 401
      const shell = text.includes("<div id=\"root\">")
      expect({ path, safe: rejected || shell, adminData: text.includes("providers_total") }).toEqual({
        path,
        safe: true,
        adminData: false
      })
    }

    // Every one of these routed to the admin API before the fix, so each must now be
    // rejected rather than merely not leaking.
    for (const path of bypasses.filter((candidate) => candidate !== "/admin/API/Overview")) {
      expect({ path, status: (await fetch(`${base}${path}`)).status }).toEqual({ path, status: 401 })
    }

    // And a write, which is the consequence that matters.
    const write = await fetch(`${base}//admin/api/keys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "bypass" })
    })
    expect(write.status).toBe(401)

    // A token still works on a non-canonical spelling, so the fix rejects nothing
    // legitimate.
    const allowed = await fetch(`${base}//admin/api/overview`, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` }
    })
    expect(allowed.status).toBe(200)
  })

  test("reports an error type that matches the status", async () => {
    // `type` is what an SDK's retry and error-class logic keys on. Every client error
    // used to be reported as `invalid_request_error`, so a caller that exceeded its rate
    // limit was told its request was malformed.
    const disabled = await createProvider({
      name: "disabled-provider",
      kind: "openai-chat",
      base_url: upstream.base,
      enabled: false
    })

    const limited = await admin("/admin/api/keys", {
      method: "POST",
      body: JSON.stringify({ name: "tight", rate_limit_rpm: 1, allowed_models: ["nothing-matches"] })
    })
    const key = ((await limited.json()) as { key: string }).key

    // Rate limit: the second call exceeds 1 rpm.
    await request("/v1/models", { headers: { authorization: `Bearer ${key}` } })
    const throttled = await request("/v1/models", { headers: { authorization: `Bearer ${key}` } })
    expect(throttled.status).toBe(429)
    expect(((await throttled.json()) as { error: { type: string } }).error.type).toBe("rate_limit_error")

    // A key scoped to some other model: 403, not 400. The allowlist is enforced per
    // model on a completion, not on the catalogue listing.
    const scoped = await admin("/admin/api/keys", {
      method: "POST",
      body: JSON.stringify({ name: "scoped", allowed_models: ["only-this"] })
    })
    const scopedKey = ((await scoped.json()) as { key: string }).key
    const forbidden = await request("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${scopedKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "hi" }] })
    })
    expect(forbidden.status).toBe(403)
    expect(((await forbidden.json()) as { error: { type: string } }).error.type).toBe("permission_error")

    void disabled
  })

  test("returns 404 for an unknown model rather than 400", async () => {
    // Anonymous, since `require_client_key` is off here: an admin bearer token would be
    // treated as an unknown client key by the /v1 auth path.
    const response = await request("/v1/models/does-not-exist")
    expect(response.status).toBe(404)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("not_found_error")
  })

  test("never echoes a provider credential in a write response", async () => {
    // The response body of a write ends up in shell history, CI logs and debugging
    // proxies, so a credential must go in and never come back out.
    const secret = "sk-write-secret-1234567890"
    const created = await admin("/admin/api/providers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "echo", kind: "openai-chat", base_url: upstream.base, api_key: secret })
    })
    expect(created.status).toBe(200)
    expect(await created.text()).not.toContain(secret)

    const config = (await (await admin("/admin/api/config")).json()) as {
      providers: Array<{ provider: { id: number; api_key: string } }>
    }
    const id = config.providers.at(-1)?.provider.id ?? 0

    const updated = await admin(`/admin/api/providers/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ priority: 42 })
    })
    expect(updated.status).toBe(200)
    expect(await updated.text()).not.toContain(secret)

    // The edit form still has something to show, and the stored value is unchanged.
    const masked = config.providers.at(-1)?.provider.api_key ?? ""
    expect(masked).not.toBe("")
    expect(masked).not.toBe(secret)
  })

  test("caps a chunked request body, which declares no Content-Length", async () => {
    // `content-length` is only a cheap early rejection. A chunked request omits it
    // entirely, so trusting the header let an unauthenticated caller have an arbitrarily
    // large body buffered. The cap is now enforced while reading the stream.
    // The shared gateway runs with AGG2API_MAX_BODY_BYTES=65536 (see the env above).
    // The body must be a *stream*: a buffer body still gets a Content-Length, which the
    // header check would catch and which would leave the streaming path untested.
    const chunk = new TextEncoder().encode(`{"model":"test-model","messages":[],"pad":"${"x".repeat(8192)}"}`)
    let sent = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 256 * 1024) {
          controller.close()
          return
        }
        controller.enqueue(chunk)
        sent += chunk.length
      }
    })

    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      // Required by fetch whenever the body is a stream.
      duplex: "half"
    } as RequestInit & { duplex: "half" })

    expect(response.status).toBe(400)
    const payload = (await response.json()) as { error?: { message?: string } }
    expect(payload.error?.message ?? "").toContain("exceeds")
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

describe("input bounds and in-band failures", () => {
  test("rejects an out-of-range max_retries instead of looping forever", async () => {
    // `max_retries` bounds a loop that only ends when the provider stops failing, and a
    // 503 without `Retry-After` retries with no delay — so an unbounded value turns one
    // client request into thousands of upstream calls.
    for (const bad of [11, -1, 1_000_000, 2.5]) {
      const response = await admin("/admin/api/providers", {
        method: "POST",
        body: JSON.stringify({ name: `bad-${bad}`, kind: "openai-chat", base_url: upstream.base, max_retries: bad })
      })
      expect(response.status).toBe(400)
    }
    for (const good of [0, 3, 10]) {
      const response = await admin("/admin/api/providers", {
        method: "POST",
        body: JSON.stringify({ name: `ok-${good}`, kind: "openai-chat", base_url: upstream.base, max_retries: good })
      })
      expect(response.status).toBe(200)
    }
  })
})

describe("model metadata resolution", () => {
  test("reads metadata through the route's targets, not by matching the public id", async () => {
    // A route's `public_model` and a provider's `public_id` are different namespaces. A
    // pool reports `test-model` but an operator (or a rename) may route it as something
    // else; a lookup keyed on the provider's own name found nothing and reported
    // `capabilities: null`, which is indistinguishable from "this model supports nothing".
    const aliased = "aliased-model"
    const created = await admin("/admin/api/routes", {
      method: "POST",
      body: JSON.stringify({
        public_model: aliased,
        strategy: null,
        enabled: true,
        display_name: "Aliased",
        targets: [{ provider_id: providerId, upstream_model: "test-model", priority: 100, enabled: true }]
      })
    })
    expect(created.status).toBe(200)

    const listed = (await (await request("/v1/models")).json()) as {
      data: Array<{
        id: string
        display_name: string | null
        context_length: number | null
        max_output_tokens: number | null
        capabilities: { input: string[] } | null
      }>
    }
    const row = listed.data.find((model) => model.id === aliased)
    expect(row).toBeDefined()
    // `test-model` is synthetic: the upstream reports only limits, and models.dev has no
    // entry for it, so `capabilities: null` is the honest answer here. The point of the
    // test is that the *limits* resolve through the alias — before the fix this row was
    // wholly empty, because the lookup matched the provider's public id and found nothing.
    expect(row?.context_length).toBe(8000)
    expect(row?.max_output_tokens).toBe(512)
    expect(row?.capabilities).toBeNull()

    // The single-model view must agree with the list rather than reporting no name.
    const single = (await (await request(`/v1/models/${aliased}`)).json()) as {
      display_name: string | null
      context_length: number | null
    }
    expect(single.display_name).toBe("Aliased")
    expect(single.context_length).toBe(8000)

    // The Anthropic listing reads the same resolution.
    const anthropic = (await (await request("/anthropic/v1/models")).json()) as {
      data: Array<{ id: string; max_input_tokens: number | null }>
    }
    expect(anthropic.data.find((model) => model.id === aliased)?.max_input_tokens).toBe(8000)
  })
})

describe("protocol surfaces", () => {
  test("keeps the OpenAI and Anthropic model listings on separate paths", async () => {
    // Both protocols define `GET /v1/models` with incompatible bodies — OpenAI's
    // `{object,data:[{object:"model",created,...}]}` against Anthropic's
    // `{data,first_id,last_id,has_more}` with `type`/`created_at`/`max_input_tokens` —
    // so a single mount point cannot answer both.
    const openai = await request("/v1/models")
    expect(openai.status).toBe(200)
    const openaiBody = (await openai.json()) as Record<string, unknown>
    expect(openaiBody.object).toBe("list")
    expect(Array.isArray(openaiBody.data)).toBe(true)
    expect(openaiBody.first_id).toBeUndefined()

    const anthropic = await request("/anthropic/v1/models")
    expect(anthropic.status).toBe(200)
    const anthropicBody = (await anthropic.json()) as {
      data: Array<Record<string, unknown>>
      first_id: string | null
      last_id: string | null
      has_more: boolean
    }
    // The SDKs read the cursors, so their absence is not an empty page but a crash.
    expect(anthropicBody.has_more).toBe(false)
    expect(anthropicBody.last_id).toBe((anthropicBody.data.at(-1)?.id as string | undefined) ?? null)

    const entry = anthropicBody.data[0]
    expect(entry?.type).toBe("model")
    expect(typeof entry?.created_at).toBe("string")
    expect(typeof entry?.display_name).toBe("string")
    expect(entry).toHaveProperty("max_input_tokens")
    expect(entry).toHaveProperty("max_tokens")
    // Anthropic's object has no `object`/`created`/`context_length` fields.
    expect(entry?.object).toBeUndefined()
    expect(entry?.created).toBeUndefined()
    expect(entry?.context_length).toBeUndefined()
  })

  test("serves Messages under /anthropic and nowhere else", async () => {
    const body = JSON.stringify({ model: "test-model", max_tokens: 16, messages: [{ role: "user", content: "hi" }] })
    const headers = { "content-type": "application/json" }

    const moved = await request("/anthropic/v1/messages", { method: "POST", headers, body })
    expect(moved.status).toBe(200)
    expect(((await moved.json()) as { type: string }).type).toBe("message")

    // The old path must not linger as an alias.
    const gone = await request("/v1/messages", { method: "POST", headers, body })
    expect(gone.status).toBe(404)
  })

  test("accepts an Anthropic client key sent as x-api-key", async () => {
    // The Anthropic SDKs authenticate with `x-api-key` and send no Authorization header
    // at all, so a bearer-only check rejected every Anthropic client.
    const body = JSON.stringify({ model: "test-model", max_tokens: 16, messages: [{ role: "user", content: "hi" }] })
    const response = await request("/anthropic/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "anything", "anthropic-version": "2023-06-01" },
      body
    })
    // Keys are not required in this configuration, and a *presented* key is validated
    // rather than downgraded, so an unknown one is rejected as such — not as "missing".
    expect(response.status).toBe(401)
    expect(((await response.json()) as { error: { message: string } }).error.message).toContain("key")
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
