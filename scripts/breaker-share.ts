/**
 * A malformed request from one caller must not take the provider out of rotation.
 *
 * The upstream rejects the request (400), which is the client's fault, not the
 * provider's. If that is written to the breaker, an anonymous caller can hold a model
 * at 503 for every other caller by repeating it.
 *
 * Usage: bun run scripts/breaker-share.ts
 */
const TOKEN = "breaker-token"
const PORT = 19_500 + Math.floor(Math.random() * 400)
const ROOT = `http://127.0.0.1:${PORT}`

const upstream = () => {
  const server = Bun.serve({
    port: 0,
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url)
      if (url.pathname === "/v1/models") {
        return Response.json({ object: "list", data: [{ id: "m1" }] })
      }
      if (url.pathname === "/v1/chat/completions") {
        const body = (await request.json()) as { messages?: unknown[] }
        // Reject a malformed request the way a real provider does.
        if (!Array.isArray(body.messages) || body.messages.length === 0) {
          return Response.json({ error: { message: "messages is required" } }, { status: 400 })
        }
        return Response.json({
          id: "c1",
          object: "chat.completion",
          created: 1,
          model: "m1",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        })
      }
      return new Response("nf", { status: 404 })
    }
  })
  return { base: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

const up = upstream()
const workdir = `/tmp/breaker-share-${Date.now()}`
await Bun.write(`${workdir}/.keep`, "")

const gateway = Bun.spawn(["bun", "run", "src/main.ts"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    AGG2API_HOST: "127.0.0.1",
    AGG2API_PORT: String(PORT),
    AGG2API_DB_PATH: `${workdir}/x.db`,
    AGG2API_ADMIN_TOKEN: TOKEN,
    AGG2API_DISCOVERY_INTERVAL_S: "0"
  },
  stdout: "ignore",
  stderr: "ignore"
})

const admin = (path: string, init: RequestInit = {}) =>
  fetch(`${ROOT}${path}`, { ...init, headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) } })

const chat = (body: unknown) =>
  fetch(`${ROOT}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  })

try {
  for (let i = 0; i < 150; i += 1) {
    try {
      if ((await fetch(`${ROOT}/healthz`)).status > 0) break
    } catch {}
    await Bun.sleep(100)
  }

  await admin("/admin/api/providers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "solo", kind: "openai-chat", base_url: up.base, api_key: "k", priority: 100 })
  })
  await admin("/admin/api/discover", { method: "POST" })
  await admin("/admin/api/routes/sync", { method: "POST" })

  const good = () => chat({ model: "m1", messages: [{ role: "user", content: "hi" }] })

  console.log(`1. well-formed request          -> ${(await good()).status}`)
  console.log(`2. malformed request (no messages) -> ${(await chat({ model: "m1", messages: [] })).status}`)

  const after = await good()
  const text = await after.text()
  console.log(`3. next well-formed request     -> ${after.status}`)
  if (after.status !== 200) {
    console.log(`   body: ${text.slice(0, 160)}`)
    console.log("\n\x1b[31mFAIL: a client's bad request removed the provider for everyone\x1b[0m")
  } else {
    console.log("\n\x1b[32mPASS: the provider stayed in rotation\x1b[0m")
  }
} finally {
  gateway.kill()
  up.stop()
  await Bun.$`rm -rf ${workdir}`.quiet()
}
