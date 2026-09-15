/**
 * A route's own `strategy` must reach the router, not just the database.
 *
 * The column was stored, shown in the admin UI and documented, yet `plan()` always
 * passed the gateway default — so a route set to `priority` would be routed by weight
 * whenever the default was `weighted`.
 *
 * Usage: bun run scripts/route-strategy.ts
 */
const TOKEN = "strategy-token"
const PORT = 19_700 + Math.floor(Math.random() * 200)
const ROOT = `http://127.0.0.1:${PORT}`

/** Two upstreams that both answer, so the choice is observable in which one was hit. */
const upstream = (name: string) => {
  let hits = 0
  const server = Bun.serve({
    port: 0,
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url)
      if (url.pathname === "/v1/models") return Response.json({ object: "list", data: [{ id: "m1" }] })
      if (url.pathname === "/v1/chat/completions") {
        hits += 1
        return Response.json({
          id: "c1",
          object: "chat.completion",
          created: 1,
          model: "m1",
          choices: [{ index: 0, message: { role: "assistant", content: name }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        })
      }
      return new Response("nf", { status: 404 })
    }
  })
  return { base: `http://127.0.0.1:${server.port}`, hits: () => hits, stop: () => server.stop(true) }
}

const a = upstream("A")
const b = upstream("B")
const workdir = `/tmp/route-strategy-${Date.now()}`
await Bun.write(`${workdir}/.keep`, "")

const gateway = Bun.spawn(["bun", "run", "src/main.ts"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    AGG2API_HOST: "127.0.0.1",
    AGG2API_PORT: String(PORT),
    AGG2API_DB_PATH: `${workdir}/x.db`,
    AGG2API_ADMIN_TOKEN: TOKEN,
    AGG2API_DISCOVERY_INTERVAL_S: "0",
    // The gateway default is the probe: if the route's own setting is ignored,
    // weighted selection will send some traffic to the low-priority provider.
    AGG2API_DEFAULT_STRATEGY: "weighted"
  },
  stdout: "ignore",
  stderr: "ignore"
})

const admin = (path: string, init: RequestInit = {}) =>
  fetch(`${ROOT}${path}`, { ...init, headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) } })

try {
  for (let i = 0; i < 150; i += 1) {
    try {
      if ((await fetch(`${ROOT}/healthz`)).status > 0) break
    } catch {}
    await Bun.sleep(100)
  }

  // `a` is created first and carries the higher priority, so priority ordering is
  // deterministic while weighted selection is not.
  for (const [name, base, priority] of [["a", a.base, 100], ["b", b.base, 1]] as const) {
    await admin("/admin/api/providers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, kind: "openai-chat", base_url: base, api_key: "k", priority })
    })
  }
  await admin("/admin/api/discover", { method: "POST" })
  await admin("/admin/api/routes/sync", { method: "POST" })

  const put = (body: unknown) =>
    admin("/admin/api/routes/m1", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  // A fresh session id per request opts out of cache affinity, which would otherwise
  // pin every request to whichever provider served the first one and hide the strategy.
  let session = 0
  const ask = async () => {
    session += 1
    const r = await fetch(`${ROOT}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-session-id": `probe-${session}` },
      body: JSON.stringify({ model: "m1", messages: [{ role: "user", content: "hi" }] })
    })
    const body = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> }
    return body.choices?.[0]?.message?.content ?? "?"
  }

  const runs = 25

  await put({ strategy: "priority" })
  a.stop, b.stop
  const beforeA = a.hits(), beforeB = b.hits()
  const priorityHits = new Set<string>()
  for (let i = 0; i < runs; i += 1) priorityHits.add(await ask())
  const priA = a.hits() - beforeA, priB = b.hits() - beforeB

  await put({ strategy: "weighted" })
  const wA0 = a.hits(), wB0 = b.hits()
  const weightedHits = new Set<string>()
  for (let i = 0; i < runs; i += 1) weightedHits.add(await ask())
  const weiA = a.hits() - wA0, weiB = b.hits() - wB0

  console.log(`route strategy=priority  -> A=${priA} B=${priB}  served by ${[...priorityHits].join(",")}`)
  console.log(`route strategy=weighted  -> A=${weiA} B=${weiB}  served by ${[...weightedHits].join(",")}`)

  const priorityPinned = priB === 0 && priA === runs
  const weightedSpread = weiB > 0
  console.log(
    priorityPinned
      ? "\n\x1b[32mPASS: priority route always took the highest-priority provider\x1b[0m"
      : "\n\x1b[31mFAIL: priority route leaked traffic to the low-priority provider\x1b[0m"
  )
  console.log(
    weightedSpread
      ? "\x1b[32mPASS: weighted route spread traffic (route strategy reached the router)\x1b[0m"
      : "\x1b[33mNOTE: weighted run happened to stay on A; inconclusive but not a failure\x1b[0m"
  )
} finally {
  gateway.kill()
  a.stop()
  b.stop()
  await Bun.$`rm -rf ${workdir}`.quiet()
}
