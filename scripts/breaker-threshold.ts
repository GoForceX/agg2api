/**
 * Circuit-breaker threshold semantics.
 *
 * `breaker_failure_threshold` is the number of *consecutive* failures that takes a
 * provider out of rotation. The distinction matters operationally: with the count
 * unread, every failure was fatal, so one flaky call removed a healthy provider for
 * the whole cooldown — for every caller, since the breaker is shared.
 *
 * Drives it through the real HTTP path so the count, the trip, and the cooldown are
 * all observed end to end rather than asserted against the repository directly.
 *
 * Usage: bun run scripts/breaker-threshold.ts
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const ADMIN_TOKEN = "breaker-threshold-token"
const THRESHOLD = 3
const BASE_MS = 4_000
const PORT = 19_100 + Math.floor(Math.random() * 900)
const base = `http://127.0.0.1:${PORT}`

let healthy = true
let calls = 0
const upstream = Bun.serve({
  port: 0,
  fetch(request: Request): Response {
    const url = new URL(request.url)
    if (url.pathname === "/v1/models") return Response.json({ object: "list", data: [{ id: "solo" }] })
    if (url.pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 })
    calls += 1
    if (!healthy) return Response.json({ error: { message: "upstream is down" } }, { status: 503 })
    return Response.json({
      id: `chatcmpl-${calls}`,
      object: "chat.completion",
      created: 1_700_000_000,
      model: "solo",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 }
    })
  }
})

const dir = await mkdtemp(join(tmpdir(), "agg2api-breaker-"))
const gateway = Bun.spawn(["bun", "run", "src/main.ts"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    AGG2API_HOST: "127.0.0.1",
    AGG2API_PORT: String(PORT),
    AGG2API_DB_PATH: join(dir, "breaker.db"),
    AGG2API_ADMIN_TOKEN: ADMIN_TOKEN,
    AGG2API_DISCOVERY_INTERVAL_S: "0",
    AGG2API_BREAKER_FAILURE_THRESHOLD: String(THRESHOLD),
    AGG2API_BREAKER_COOLDOWN_BASE_MS: String(BASE_MS),
    AGG2API_BREAKER_COOLDOWN_MAX_MS: "300000"
  },
  stdout: "ignore",
  stderr: "ignore"
})

const admin = (path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_TOKEN}`, ...(init.headers ?? {}) }
  })

interface Turn {
  readonly status: number
  readonly body: string
}

const turn = async (): Promise<Turn> => {
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // max_retries 0: one client request is exactly one upstream attempt, so the
    // failure count advances once per turn and the threshold is observable.
    body: JSON.stringify({ model: "solo", messages: [{ role: "user", content: "hi" }] })
  })
  return { status: response.status, body: await response.text() }
}

/**
 * Whether any provider is out of rotation.
 *
 * Read from the admin overview rather than the DB: `providers_open` is the field the
 * dashboard itself renders, so this asserts what an operator actually sees.
 */
const anyOpen = async (): Promise<boolean> => {
  const body = (await (await admin("/admin/api/overview")).json()) as { providers_open: number }
  return body.providers_open > 0
}

/**
 * A tripped breaker fails *fast*: the request is rejected by routing before any
 * upstream call, so the provider's error names the cooldown. An un-tripped provider is
 * actually tried, and the failure carries the upstream's own message.
 */
const coolingDown = (t: Turn): boolean => t.body.includes("cooling down")

const checks: Array<[string, boolean]> = []
const check = (label: string, ok: boolean, detail: string): void => {
  checks.push([label, ok])
  console.log(`${ok ? "PASS" : "FAIL"}  ${label} — ${detail}`)
}

try {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${base}/healthz`)).status > 0) break } catch {}
    await Bun.sleep(100)
  }

  await admin("/admin/api/providers", {
    method: "POST",
    body: JSON.stringify({
      name: "solo-upstream", kind: "openai-chat",
      base_url: `http://127.0.0.1:${upstream.port}`, api_key: "k", max_retries: 0
    })
  })
  await admin("/admin/api/discover", { method: "POST" })
  await admin("/admin/api/routes/sync", { method: "POST" })

  check("a healthy request succeeds", (await turn()).status === 200, "status 200")

  healthy = false
  const first = await turn()
  check(
    `1 failure (threshold ${THRESHOLD}) keeps the provider in rotation`,
    first.status === 503 && !(await anyOpen()) && !coolingDown(first),
    `status=${first.status} tried=${!coolingDown(first)} open=${await anyOpen()}`
  )

  const second = await turn()
  check(
    "2 failures still keep it in rotation",
    second.status === 503 && !(await anyOpen()) && !coolingDown(second),
    `status=${second.status} tried=${!coolingDown(second)} open=${await anyOpen()}`
  )

  const third = await turn()
  check(
    `the ${THRESHOLD}rd failure trips the breaker`,
    await anyOpen(),
    `open=${await anyOpen()} failures=${THRESHOLD}`
  )

  // The delay counts failures *past* the threshold, so the first trip waits `base`,
  // not `base * 2^threshold` (32s here, against 4s).
  const trippedAt = Date.now()
  const duringCooldown = await turn()
  check(
    "a request during cooldown fails fast without spending an upstream call",
    duringCooldown.status === 503 && coolingDown(duringCooldown),
    `status=${duringCooldown.status} body=${duringCooldown.body.slice(0, 80)}`
  )

  const callsBefore = calls
  await Bun.sleep(1_000)
  const stillCooling = await turn()
  check(
    "the cooldown lasts about the base interval, not a multiple of it",
    coolingDown(stillCooling) && calls === callsBefore,
    `after 1s: cooling=${coolingDown(stillCooling)} upstream_calls_delta=${calls - callsBefore}`
  )

  const waitMs = Math.max(0, BASE_MS + 1_500 - (Date.now() - trippedAt))
  await Bun.sleep(waitMs)
  healthy = true
  const recovered = await turn()
  check(
    "a success after the cooldown closes the breaker",
    recovered.status === 200 && !(await anyOpen()),
    `status=${recovered.status} open=${await anyOpen()} waited=${Math.round((BASE_MS + 1_500) / 1000)}s`
  )

  const afterTrip = await turn()
  healthy = false
  const firstAfterRecovery = await turn()
  check(
    "the failure count restarts after a success",
    firstAfterRecovery.status === 503 && !coolingDown(firstAfterRecovery) && !(await anyOpen()),
    `status=${firstAfterRecovery.status} open=${await anyOpen()}`
  )
  void afterTrip
} finally {
  gateway.kill()
  upstream.stop(true)
  await rm(dir, { recursive: true, force: true })
}

const failed = checks.filter(([, ok]) => !ok)
if (failed.length > 0) {
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
  process.exit(1)
}
console.log(`\n${checks.length}/${checks.length} checks passed`)
