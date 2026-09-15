/**
 * A gateway seeded with the reported wb2api payload, for checking the admin UI in a
 * browser: two accounts holding 2256 and 4776 credits, against a `/status` whose
 * `total` is the account count rather than a balance.
 *
 * Usage: bun run scripts/ui-check.ts   (then open the printed /admin/ URL)
 */
export {}

const upstream = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/v1/models") {
      return Response.json({
        object: "list",
        data: [
          { id: "gpt-5", context_length: 128000, max_output_tokens: 16384 },
          { id: "claude-fable-5", context_length: 200000 }
        ]
      })
    }
    if (url.pathname === "/status") {
      return Response.json({
        total: 2,
        healthy: 2,
        accounts: [
          {
            uid: "0080b333-74f2-4ca6-bca0-a375698bd152",
            nickname: "18600388769",
            realm: "cn",
            credits: 2256,
            cooling: false,
            disabled: false
          },
          {
            uid: "8e61a3cf-f125-438b-910c-0273de1f3d15",
            nickname: "goforcex",
            realm: "cn",
            credits: 4776,
            cooling: false,
            disabled: false
          }
        ]
      })
    }
    if (url.pathname === "/v1/chat/completions") {
      return Response.json({
        id: "c1",
        object: "chat.completion",
        created: 1,
        model: "gpt-5",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 1200,
          completion_tokens: 80,
          total_tokens: 1280,
          prompt_tokens_details: { cached_tokens: 900 }
        }
      })
    }
    return new Response("not found", { status: 404 })
  }
})

const PORT = 18_960
const gateway = Bun.spawn(["bun", "run", "src/main.ts"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    AGG2API_HOST: "127.0.0.1",
    AGG2API_PORT: String(PORT),
    AGG2API_DB_PATH: `/tmp/ui-check-${Date.now()}.db`,
    AGG2API_ADMIN_TOKEN: "uitoken",
    AGG2API_DISCOVERY_INTERVAL_S: "0"
  },
  stdout: "ignore",
  stderr: "ignore"
})

const admin = (path: string, init: RequestInit = {}) =>
  fetch(`http://127.0.0.1:${PORT}${path}`, {
    ...init,
    headers: { authorization: "Bearer uitoken", ...(init.headers ?? {}) }
  })

for (let attempt = 0; attempt < 150; attempt += 1) {
  try {
    if ((await fetch(`http://127.0.0.1:${PORT}/healthz`)).status > 0) break
  } catch {
    // not listening yet
  }
  await Bun.sleep(100)
}

const created = await admin("/admin/api/providers", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    name: "wb2api-主账号",
    kind: "workbuddy2api",
    base_url: `http://127.0.0.1:${upstream.port}`,
    api_key: "sk-demo-upstream-key",
    priority: 100
  })
})
const providerId = ((await created.json()) as { id: number }).id

await admin("/admin/api/discover", { method: "POST" })
await admin("/admin/api/routes/sync", { method: "POST" })
await admin(`${"/admin/api/providers"}/${providerId}`, { method: "PUT" })
await admin("/admin/api/keys", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "示例应用", rate_limit_rpm: 600 })
})

// Generate traffic so the dashboard and usage views have something to render.
for (let index = 0; index < 6; index += 1) {
  await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5", messages: [{ role: "user", content: `hi ${index}` }] })
  })
}

console.log(`READY http://127.0.0.1:${PORT}/admin/  adminToken=uitoken providerId=${providerId}`)

// Stay up until the parent kills the process.
await Bun.sleep(600_000)
gateway.kill()
upstream.stop(true)
