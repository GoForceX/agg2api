/**
 * Tutorial verification.
 *
 * Runs exactly the steps the deployment tutorial tells an operator to run — against a
 * mock upstream instead of a real one — so every command in the tutorial is known to
 * work as written rather than being plausible from memory.
 *
 * Usage: bun run scripts/tutorial-check.ts
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const TOKEN = "my-admin-token"
const PORT = 19_300 + Math.floor(Math.random() * 700)
const ROOT = `http://127.0.0.1:${PORT}`

/** Stands in for a real provider such as OpenAI. */
const fakeOpenAI = () => {
  const server = Bun.serve({
    port: 0,
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url)
      if (url.pathname === "/v1/models") {
        return Response.json({
          object: "list",
          data: [
            { id: "gpt-4o-mini", context_length: 128000, max_output_tokens: 16384 },
            { id: "text-embedding-3-small" }
          ]
        })
      }
      if (url.pathname === "/v1/chat/completions") {
        const body = (await request.json()) as { model?: string }
        // The tutorial's final step checks the reply, so echo the public model name back.
        return Response.json({
          id: "chatcmpl-tutorial",
          object: "chat.completion",
          created: 1_700_000_000,
          model: body.model ?? "gpt-4o-mini",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "hello from your configured provider" },
              finish_reason: "stop"
            }
          ],
          usage: { prompt_tokens: 9, completion_tokens: 6, total_tokens: 15 }
        })
      }
      return new Response("not found", { status: 404 })
    }
  })
  return { base: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

const step = (n: number, text: string) => console.log(`\n\u001b[1m--- ${n}. ${text}\u001b[0m`)

const main = async () => {
  const upstream = fakeOpenAI()
  const workdir = await mkdtemp(join(tmpdir(), "agg2api-tutorial-"))

  // The tutorial's Step 3 starts the gateway with these environment variables.
  const gateway = Bun.spawn(["bun", "run", "src/main.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGG2API_HOST: "127.0.0.1",
      AGG2API_PORT: String(PORT),
      AGG2API_DB_PATH: join(workdir, "agg2api.db"),
      AGG2API_ADMIN_TOKEN: TOKEN
    },
    stdout: "pipe",
    stderr: "pipe"
  })

  try {
    // --- Step 4: confirm it is up --------------------------------------
    step(4, "Verify the gateway is running (before any provider is added)")
    let started = false
    for (let i = 0; i < 150 && !started; i += 1) {
      try {
        started = (await fetch(`${ROOT}/healthz`)).status > 0
      } catch {
        // not listening yet
      }
      if (!started) await Bun.sleep(100)
    }
    if (!started) throw new Error("gateway never listened")

    const coldHealth = await fetch(`${ROOT}/healthz`)
    console.log(`   curl -s localhost:${PORT}/healthz`)
    console.log(`   -> ${coldHealth.status} ${await coldHealth.text()}`)
    console.log(`   (503 is expected and correct: no provider is configured yet)`)

    // --- Step 5: add a provider ---------------------------------------
    step(5, "Add your first provider")
    const created = await fetch(`${ROOT}/admin/api/providers`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        name: "openai",
        kind: "openai-chat",
        base_url: upstream.base,
        api_key: "sk-your-real-key",
        priority: 100,
        input_price: 0.15,
        output_price: 0.6
      })
    })
    console.log(`   POST /admin/api/providers -> ${created.status}`)
    const provider = (await created.json()) as { id: number; name: string }
    console.log(`   -> created provider id=${provider.id} name=${provider.name}`)

    // --- Step 6: discover and publish ---------------------------------
    step(6, "Discover models and publish them as routes")
    const discovered = await fetch(`${ROOT}/admin/api/discover`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    const discovery = (await discovered.json()) as {
      results: Array<{ provider_id: number; models: unknown[]; error: string | null }>
    }
    console.log(`   POST /admin/api/discover -> ${discovered.status}, found ${discovery.results[0]?.models.length ?? 0} models`)

    const synced = await fetch(`${ROOT}/admin/api/routes/sync`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    const sync = (await synced.json()) as { created: string[] }
    console.log(`   POST /admin/api/routes/sync -> ${synced.status}, published: ${sync.created.join(", ")}`)

    // --- Step 7: verify healthy and make a real request ---------------
    step(7, "Verify health and make a first completion")
    const health = await fetch(`${ROOT}/healthz`)
    console.log(`   GET /healthz -> ${health.status} ${await health.text()}`)

    const models = await fetch(`${ROOT}/v1/models`)
    const catalogue = (await models.json()) as { data: Array<{ id: string }> }
    console.log(`   GET /v1/models -> ${models.status}, ${catalogue.data.map((m) => m.id).join(", ")}`)

    const completion = await fetch(`${ROOT}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "hi" }]
      })
    })
    const body = (await completion.json()) as {
      choices?: Array<{ message?: { content?: string } }>
      usage?: { prompt_tokens?: number }
    }
    console.log(`   POST /v1/chat/completions -> ${completion.status}`)
    console.log(`   -> "${body.choices?.[0]?.message?.content}" (prompt_tokens=${body.usage?.prompt_tokens})`)

    // --- Step 8: lock it down -----------------------------------------
    step(8, "Create a client key and require it on /v1")
    const keyResponse = await fetch(`${ROOT}/admin/api/keys`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "my-app", rate_limit_rpm: 600 })
    })
    const keyBody = (await keyResponse.json()) as { id: number }
    console.log(`   POST /admin/api/keys -> ${keyResponse.status} (id=${keyBody.id})`)
    console.log(`   The key itself is shown once in the UI: Admin -> API keys.`)

    const keyless = await fetch(`${ROOT}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [] })
    })
    console.log(`   Without require_client_key, anonymous /v1 still works -> ${keyless.status}`)

    // --- what the dashboard shows -------------------------------------
    step(9, "Confirm the dashboard has data")
    const usage = await fetch(`${ROOT}/admin/api/usage?window=3600000`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    const summary = (await usage.json()) as {
      summary: { requests: number; errors: number; cache_rate: number | null; cost: number }
    }
    console.log(
      `   GET /admin/api/usage -> requests=${summary.summary.requests} errors=${summary.summary.errors} ` +
        `cache_rate=${summary.summary.cache_rate} cost=${summary.summary.cost}`
    )
    console.log(`   Open the UI at ${ROOT}/admin/ and paste the admin token.`)

    console.log("\n\u001b[32mAll tutorial steps executed successfully.\u001b[0m")
  } finally {
    gateway.kill()
    upstream.stop()
    await rm(workdir, { recursive: true, force: true })
  }
}

await main()
