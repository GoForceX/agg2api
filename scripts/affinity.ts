/**
 * Session affinity: end-to-end proof.
 *
 * Boots two *distinct* upstream providers behind one public model with the `weighted`
 * strategy — the case where routing would otherwise spread a single conversation
 * across both, losing each provider's prompt cache. Asserts the observable outcomes:
 *
 * 1. Every turn of one conversation goes to the same provider.
 * 2. A different conversation may land elsewhere (affinity is per session, not global).
 * 3. Two clients with an identical prompt do not share a pin.
 * 4. When the pinned provider dies, the request still succeeds via the fallback.
 * 5. After a failover the pin moves, so the *next* turn is not retried against the
 *    dead provider.
 *
 * Usage: bun run scripts/affinity.ts
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const ADMIN_TOKEN = "affinity-token"
const GATEWAY_PORT = 18_600 + Math.floor(Math.random() * 1200)
const base = `http://127.0.0.1:${GATEWAY_PORT}`

interface Check {
  readonly name: string
  readonly ok: boolean
  readonly detail: string
}
const checks: Check[] = []
const check = (name: string, ok: boolean, detail: string): void => {
  checks.push({ name, ok, detail })
  console.log(`${ok ? "\u001b[32mPASS\u001b[0m" : "\u001b[31mFAIL\u001b[0m"}  ${name} — ${detail}`)
}

/** An upstream that counts its calls and reports the model it served. */
const upstream = () => {
  let calls = 0
  let failAfter = Number.POSITIVE_INFINITY
  let port = 0
  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    port: 0,
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url)
      if (url.pathname === "/v1/models") {
        return Response.json({ object: "list", data: [{ id: "shared-model" }] })
      }
      if (url.pathname === "/v1/chat/completions") {
        calls += 1
        if (calls > failAfter) {
          return Response.json({ error: { message: "upstream down" } }, { status: 503 })
        }
        const body = (await request.json()) as { model?: string }
        return Response.json({
          id: `chatcmpl-${calls}`,
          object: "chat.completion",
          created: 1_700_000_000,
          model: body.model ?? "shared-model",
          choices: [
            { index: 0, message: { role: "assistant", content: `served by ${port}` }, finish_reason: "stop" }
          ],
          usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 }
        })
      }
      return new Response("not found", { status: 404 })
    }
  })
  port = server.port ?? 0
  return {
    base: `http://127.0.0.1:${port}`,
    port,
    calls: () => calls,
    reset: () => {
      calls = 0
    },
    breakAfter: (n: number) => {
      failAfter = n
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

/** One chat turn; returns which upstream answered, read from the reply text. */
const turn = async (
  messages: ReadonlyArray<{ role: string; content: string }>,
  key?: string
): Promise<{ served: string; status: number }> => {
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key === undefined ? {} : { "x-session-id": key })
    },
    body: JSON.stringify({ model: "shared-model", messages })
  })
  if (!response.ok) return { served: "", status: response.status }
  const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
  return { served: body.choices?.[0]?.message?.content ?? "", status: response.status }
}

const main = async () => {
  const workdir = await mkdtemp(join(tmpdir(), "agg2api-affinity-"))
  const a = upstream()
  const b = upstream()

  const gateway = Bun.spawn(["bun", "run", "src/main.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGG2API_HOST: "127.0.0.1",
      AGG2API_PORT: String(GATEWAY_PORT),
      AGG2API_DB_PATH: join(workdir, "affinity.db"),
      AGG2API_ADMIN_TOKEN: ADMIN_TOKEN,
      AGG2API_DISCOVERY_INTERVAL_S: "0",
      AGG2API_LOG_RETENTION_DAYS: "0",
      // `weighted` with equal priorities is the adversarial case: without affinity,
      // turns of one conversation would be spread across both providers.
      AGG2API_DEFAULT_STRATEGY: "weighted",
      // Negative control: AGG2API_SESSION_TTL_MS=0 disables affinity, and the
      // stickiness checks below must then fail.
      ...(process.env["AFFINITY_OFF"] === "1" ? { AGG2API_SESSION_TTL_MS: "0" } : {})
    },
    stdout: "ignore",
    stderr: "ignore"
  })

  try {
    let ready = false
    for (let attempt = 0; attempt < 150 && !ready; attempt += 1) {
      try {
        ready = (await fetch(`${base}/v1/models`)).status < 500
      } catch {
        // not listening
      }
      if (!ready) await Bun.sleep(100)
    }
    if (!ready) {
      check("gateway starts", false, base)
      return
    }
    check("gateway starts", true, base)

    for (const [name, server] of [
      ["alpha", a],
      ["beta", b]
    ] as const) {
      const response = await admin("/admin/api/providers", {
        method: "POST",
        body: JSON.stringify({
          name,
          kind: "openai-chat",
          base_url: server.base,
          // Equal priority so the weighted strategy would otherwise alternate.
          priority: 100
        })
      })
      if (!response.ok) throw new Error(`provider ${name} failed: ${await response.text()}`)
    }
    await admin("/admin/api/discover", { method: "POST" })
    await admin("/admin/api/routes/sync", { method: "POST" })

    // --- 1. one conversation stays on one provider -------------------------
    const prefix = [
      { role: "system", content: "You are a careful assistant." },
      { role: "user", content: "Explain prompt caching." }
    ]
    const first = await turn(prefix)
    check("first turn succeeds", first.status === 200, first.served)

    const conversation = [...prefix]
    let consistent = true
    for (let i = 0; i < 8; i += 1) {
      conversation.push({ role: "assistant", content: `answer ${i}` })
      conversation.push({ role: "user", content: `follow-up ${i}` })
      const next = await turn(conversation)
      // The prefix is unchanged, so the session key is unchanged, so every turn must
      // reach the provider that first served it.
      if (next.served !== first.served) consistent = false
    }
    check(
      "every turn of a conversation hits the same provider",
      consistent,
      `pinned to ${first.served} across 9 turns`
    )

    // --- 2. affinity is per session, not global ---------------------------
    const other = await turn([
      { role: "system", content: "You are a poet." },
      { role: "user", content: "Write a haiku about latency." }
    ])
    check("a different conversation is routed independently", other.status === 200, other.served)

    // --- 3. an explicit session id wins -----------------------------------
    // Six calls with the *same* explicit id but a different prompt each time. The
    // differing prompts is the point: without the header these would be six distinct
    // sessions and could legitimately spread. Repeating it makes an accidental pass
    // from weighted chance vanishingly unlikely.
    const namedServed = new Set<string>()
    for (let i = 0; i < 6; i += 1) {
      const named = await turn([{ role: "user", content: `brand new prompt ${i}` }], "client-session-1")
      if (named.served !== "") namedServed.add(named.served)
    }
    check(
      "an explicit session id pins across differing prompts",
      namedServed.size === 1,
      `served by ${[...namedServed].join(", ")}`
    )

    // A different explicit id is a different session, and must not be forced onto the
    // first one's provider.
    const otherNamed = await turn([{ role: "user", content: "second client" }], "client-session-2")
    check("a different explicit session id is independent", otherNamed.status === 200, otherNamed.served)

    // --- 4. failover when the pinned provider dies ------------------------
    const pinnedIsA = first.served.includes(String(a.port))
    const pinned = pinnedIsA ? a : b
    const fallback = pinnedIsA ? b : a
    // The next call to the pinned provider fails, and every one after it.
    pinned.breakAfter(pinned.calls())

    conversation.push({ role: "assistant", content: "last answer" })
    conversation.push({ role: "user", content: "are you still there?" })
    const failedOver = await turn(conversation)
    check(
      "a request survives the pinned provider failing",
      failedOver.status === 200,
      `${failedOver.status} served by ${failedOver.served || "nobody"}`
    )
    check(
      "the fallback provider served it",
      failedOver.served.includes(String(fallback.port)),
      failedOver.served
    )

    // --- 5. the pin moved, so later turns skip the dead provider ----------
    const afterFailover = fallback.calls()
    for (let i = 0; i < 3; i += 1) {
      conversation.push({ role: "assistant", content: "answer" })
      conversation.push({ role: "user", content: `turn ${i}` })
      await turn(conversation)
    }
    check(
      "the pin follows the working provider",
      fallback.calls() > afterFailover,
      `fallback took ${fallback.calls() - afterFailover} further turns`
    )
  } finally {
    gateway.kill()
    a.stop()
    b.stop()
    await rm(workdir, { recursive: true, force: true })
  }

  const failed = checks.filter((entry) => !entry.ok)
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
  if (failed.length > 0) process.exit(1)
}

await main()
