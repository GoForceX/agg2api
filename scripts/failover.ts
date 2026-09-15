/**
 * Failover and affinity interaction.
 *
 * Answers one concrete operational question: after a pinned provider fails and the
 * request falls back, which provider serves the *next* request?
 *
 * Two upstreams behind one public model with equal priority. `alpha` is pinned by the
 * first request, then begins failing. The script reports, per request, which upstream
 * served it and how many attempts were made — the attempt count is what reveals whether
 * the pinned provider was tried (and failed) or skipped entirely by its breaker.
 *
 * Usage: bun run scripts/failover.ts
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const ADMIN_TOKEN = "failover-token"
const PORT = 19_100 + Math.floor(Math.random() * 900)
const base = `http://127.0.0.1:${PORT}`

interface Upstream {
  readonly name: string
  readonly base: string
  readonly port: number
  readonly calls: () => number
  readonly failFrom: (n: number) => void
  readonly stop: () => void
}

const upstream = (name: string): Upstream => {
  let calls = 0
  let failAt = Number.POSITIVE_INFINITY
  let port = 0
  const server = Bun.serve({
    port: 0,
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url)
      if (url.pathname === "/v1/models") {
        return Response.json({ object: "list", data: [{ id: "solo" }] })
      }
      if (url.pathname !== "/v1/chat/completions") {
        return new Response("not found", { status: 404 })
      }
      calls += 1
      if (calls >= failAt) {
        return Response.json({ error: { message: `${name} is down` } }, { status: 503 })
      }
      return Response.json({
        id: `chatcmpl-${name}-${calls}`,
        object: "chat.completion",
        created: 1_700_000_000,
        model: "solo",
        choices: [
          { index: 0, message: { role: "assistant", content: name }, finish_reason: "stop" }
        ],
        usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 }
      })
    }
  })
  port = server.port ?? 0
  return {
    name,
    base: `http://127.0.0.1:${port}`,
    port,
    calls: () => calls,
    failFrom: (n) => {
      failAt = n
    },
    stop: () => server.stop(true)
  }
}

const admin = (path: string, init?: RequestInit) =>
  fetch(`${base}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ADMIN_TOKEN}`,
      ...(init?.headers ?? {})
    }
  })

/** Send one turn of a pinned conversation; report who served it. */
const turn = async (messages: ReadonlyArray<{ role: string; content: string }>) => {
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "solo", messages })
  })
  if (!response.ok) return { served: `HTTP ${response.status}`, attempts: -1 }
  const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
  return { served: body.choices?.[0]?.message?.content ?? "?", attempts: -1 }
}

/** Current breaker state per provider, as the gateway sees it right now. */
const breakers = async (): Promise<string> => {
  const response = await admin("/admin/api/config")
  const body = (await response.json()) as {
    providers: Array<{
      provider: { name: string }
      status: { consecutive_failures: number; open_until: number }
    }>
  }
  const now = Date.now()
  return body.providers
    .map((entry) => {
      const left = entry.status.open_until - now
      return left > 0 ? `${entry.provider.name}:OPEN(${Math.round(left / 1000)}s)` : `${entry.provider.name}:ok`
    })
    .join(" ")
}

/** Read back the attempt count the gateway recorded for the newest request. */
const lastAttempts = async (): Promise<number> => {
  const response = await admin("/admin/api/usage/log?limit=1")
  const body = (await response.json()) as { rows?: Array<{ attempts?: number; provider_name?: string }> }
  return body.rows?.[0]?.attempts ?? -1
}

const main = async () => {
  const workdir = await mkdtemp(join(tmpdir(), "agg2api-failover-"))
  const alpha = upstream("alpha")
  const beta = upstream("beta")

  const gateway = Bun.spawn(["bun", "run", "src/main.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGG2API_HOST: "127.0.0.1",
      AGG2API_PORT: String(PORT),
      AGG2API_DB_PATH: join(workdir, "failover.db"),
      AGG2API_ADMIN_TOKEN: ADMIN_TOKEN,
      AGG2API_DISCOVERY_INTERVAL_S: "0",
      AGG2API_LOG_RETENTION_DAYS: "0"
    },
    stdout: "ignore",
    stderr: "ignore"
  })

  const report: string[] = []
  try {
    let ready = false
    for (let attempt = 0; attempt < 150 && !ready; attempt += 1) {
      try {
        ready = (await fetch(`${base}/v1/models`)).status < 500
      } catch {
        // not listening yet
      }
      if (!ready) await Bun.sleep(100)
    }
    if (!ready) throw new Error("gateway did not start")

    for (const server of [alpha, beta]) {
      const response = await admin("/admin/api/providers", {
        method: "POST",
        body: JSON.stringify({
          name: server.name,
          kind: "openai-chat",
          base_url: server.base,
          // Equal priority, and the strategy is `priority`, so the order is decided by
          // provider id: alpha (created first) is preferred, beta is the fallback.
          priority: 100
        })
      })
      if (!response.ok) throw new Error(`provider ${server.name}: ${await response.text()}`)
    }
    await admin("/admin/api/discover", { method: "POST" })
    await admin("/admin/api/routes/sync", { method: "POST" })

    const convo = [
      { role: "system", content: "You are terse." },
      { role: "user", content: "which provider are you?" }
    ]

    // --- request 1: establishes the pin --------------------------------
    const first = await turn(convo)
    report.push(`request 1 (pin established)      -> ${first.served}, attempts=${await lastAttempts()}  [${await breakers()}]`)

    // --- make alpha fail from its next call ----------------------------
    alpha.failFrom(alpha.calls() + 1)

    convo.push({ role: "assistant", content: first.served })
    convo.push({ role: "user", content: "again?" })
    const second = await turn(convo)
    report.push(`request 2 (pin fails)            -> ${second.served}, attempts=${await lastAttempts()}  [${await breakers()}]`)

    // --- request 3, immediately: is the failed provider retried? -------
    convo.push({ role: "assistant", content: second.served })
    convo.push({ role: "user", content: "third" })
    const third = await turn(convo)
    report.push(`request 3 (immediate)            -> ${third.served}, attempts=${await lastAttempts()}  [${await breakers()}]`)

    // --- request 4, well after any cooldown would expire -----------------
    // Past the base cooldown, so if the pinned provider had been taken out of rotation
    // it would be eligible again by now and we could see whether the pin still points
    // at it. With the default threshold of 3 and single failures per turn, it never
    // left rotation — hence `alpha:ok` throughout.
    await Bun.sleep(6_000)
    convo.push({ role: "assistant", content: third.served })
    convo.push({ role: "user", content: "fourth" })
    const fourth = await turn(convo)
    report.push(`request 4 (after cooldown)       -> ${fourth.served}, attempts=${await lastAttempts()}  [${await breakers()}]`)

    // --- request 5: now make the *fallback* fail too -------------------
    beta.failFrom(beta.calls() + 1)
    convo.push({ role: "assistant", content: fourth.served })
    convo.push({ role: "user", content: "fifth" })
    const fifth = await turn(convo)
    report.push(`request 5 (pin also fails)       -> ${fifth.served}, attempts=${await lastAttempts()}  [${await breakers()}]`)

    // --- request 6: alpha has recovered and is healthy again -----------
    // Does the pin ever return to the provider that originally warmed the cache?
    await Bun.sleep(8_000)
    // Both upstreams healthy again, so the only remaining question is where the pin
    // points. The gateway does not probe, so a pin only moves on an actual attempt.
    alpha.failFrom(alpha.calls() + 1_000_000)
    beta.failFrom(beta.calls() + 1_000_000)
    convo.push({ role: "assistant", content: fifth.served })
    convo.push({ role: "user", content: "sixth" })
    const sixth = await turn(convo)
    report.push(`request 6 (both recovered)       -> ${sixth.served}, attempts=${await lastAttempts()}  [${await breakers()}]`)

    console.log(report.join("\n"))
  } finally {
    gateway.kill()
    alpha.stop()
    beta.stop()
    await rm(workdir, { recursive: true, force: true })
  }
}

await main()
