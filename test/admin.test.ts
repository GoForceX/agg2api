/**
 * Admin handler behaviour.
 *
 * The handlers are invoked as plain functions rather than over a socket: what the
 * tests need to pin down is how they translate database rows and upstream outcomes,
 * and routing them through a server would add the platform's plumbing — which the
 * frozen contract already fixes — in front of both.
 *
 * `runScoped` is load-bearing. An `expect` that throws inside `Effect.gen` kills the
 * fiber instead of rejecting a promise, so a test that awaited the effect directly
 * would pass no matter what its assertions said; `helpers.ts` rethrows the defect.
 */
import { describe, expect, test } from "bun:test"
import * as FetchHttpClient from "@effect/platform/FetchHttpClient"
import type * as HttpClient from "@effect/platform/HttpClient"
import * as SqlClient from "@effect/sql/SqlClient"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { DEFAULTS, type Settings } from "../src/config.ts"
import type { DiscoveredModel, UsageEntry } from "../src/domain.ts"
import { testLayer } from "../src/db/database.ts"
import { saveCredits } from "../src/db/credits.ts"
import { insertUsage } from "../src/db/usage.ts"
import { createKey, getKey } from "../src/db/keys.ts"
import { createProvider, getProvider, listProviders, replaceProviderModels } from "../src/db/providers.ts"
import { createRoute, listRoutes } from "../src/db/routes.ts"
import { getProviderStatus, recordFailure } from "../src/db/health.ts"
import { Sessions, makeSessionStore } from "../src/gateway/sessions.ts"
import { AppSettings, StartedAt } from "../src/gateway/settings.ts"
import { admin } from "../src/http/admin/handlers.ts"
import { runScoped, runWith } from "./helpers.ts"

const SETTINGS: Settings = { ...DEFAULTS, default_strategy: "weighted", require_client_key: true }
const STARTED_AT = Date.now() - 120_000

/** Database-backed handlers also need the boot settings, the start time and the
 *  session store (the overview reports affinity effectiveness). */
const seedServices = <A, E, R>(
  effect: Effect.Effect<A, E, R | AppSettings | StartedAt | Sessions>
): Effect.Effect<A, E, R> =>
  effect.pipe(
    Effect.provideService(AppSettings, SETTINGS),
    Effect.provideService(StartedAt, STARTED_AT),
    Effect.provideService(
      Sessions,
      makeSessionStore({ ttl_ms: SETTINGS.session_ttl_ms, max_entries: SETTINGS.session_max_entries })
    )
  )

const runDb = <A, E>(
  effect: Effect.Effect<A, E, SqlClient.SqlClient | AppSettings | StartedAt | Sessions>
): Promise<A> => runScoped(seedServices(effect))

/** Same, with a live HTTP client for the handlers that talk to an upstream. */
const runUpstream = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    SqlClient.SqlClient | AppSettings | StartedAt | Sessions | HttpClient.HttpClient
  >
): Promise<A> => runWith(Effect.provide(seedServices(effect), testLayer), FetchHttpClient.layer)

const model = (upstreamId: string, publicId: string): DiscoveredModel => ({
  provider_id: 0,
  upstream_id: upstreamId,
  public_id: publicId,
  context_length: 128_000,
  max_output_tokens: 4_096,
  capabilities: null,
  owned_by: "test",
  last_seen: Date.now()
})

const usage = (over: Partial<UsageEntry>): UsageEntry => ({
  request_id: crypto.randomUUID(),
  ts: Date.now(),
  api_key_id: null,
  api_key_name: null,
  endpoint: "chat",
  stream: false,
  public_model: "shared",
  provider_id: null,
  provider_name: "p",
  provider_kind: "openai-chat",
  upstream_model: "shared",
  prompt_tokens: 0,
  completion_tokens: 0,
  cached_tokens: 0,
  reasoning_tokens: 0,
  cost: 0,
  currency: "USD",
  attempts: 1,
  status: 200,
  error_kind: null,
  error_message: null,
  latency_ms: 0,
  ttft_ms: 0,
  client_ip: null,
  user_agent: null,
  ...over
})

describe("admin.config", () => {
  test("masks every provider secret and fills in the full detail shape", async () => {
    const snapshot = await runDb(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const long = yield* createProvider(sql, {
          name: "long",
          kind: "openai-chat",
          base_url: "https://api.example.com",
          api_key: "sk-test-secret-value"
        })
        // Short enough that any prefix would expose the whole secret.
        yield* createProvider(sql, {
          name: "short",
          kind: "workbuddy2api",
          base_url: "https://pool.example.com",
          api_key: "abc"
        })

        yield* replaceProviderModels(sql, long.id, [model("up-gpt", "public-gpt")])
        yield* saveCredits(sql, long.id, {
          total: 42,
          healthy: 1,
          accounts: [{ uid: "u1", credits: 42 }],
          fetched_at: 1_700_000_000_000,
          error: null
        })
        yield* createRoute(sql, {
          public_model: "public-gpt",
          strategy: "weighted",
          enabled: true,
          display_name: "GPT",
          targets: [{ provider_id: long.id, upstream_model: "up-gpt", priority: 7, enabled: true }]
        })
        yield* createKey(sql, { name: "client", key: "sk-client-key-abcdefghij" })

        return yield* admin.config()
      })
    )

    expect(snapshot.providers).toHaveLength(2)
    const long = snapshot.providers.find((detail) => detail.provider.name === "long")
    const short = snapshot.providers.find((detail) => detail.provider.name === "short")
    if (long === undefined || short === undefined) throw new Error("both providers must be in the snapshot")

    expect(long.provider.api_key).toBe("sk-t…")
    expect(long.provider.api_key).not.toContain("secret")
    expect(short.provider.api_key).toBe("…")
    // Everything else about the row must survive unmasked.
    expect(long.provider.base_url).toBe("https://api.example.com")
    expect(long.provider.kind).toBe("openai-chat")

    expect(long.models).toHaveLength(1)
    expect(long.models[0]?.public_id).toBe("public-gpt")
    expect(long.models[0]?.upstream_id).toBe("up-gpt")
    expect(long.models[0]?.provider_id).toBe(long.provider.id)
    expect(long.models[0]?.context_length).toBe(128_000)

    expect(long.credits?.total).toBe(42)
    expect(long.credits?.accounts[0]?.uid).toBe("u1")
    expect(short.credits).toBeNull()

    expect(long.status.provider_id).toBe(long.provider.id)
    expect(long.status.open_until).toBe(0)

    expect(long.routed_models).toEqual(["public-gpt"])
    expect(short.routed_models).toEqual([])

    expect(snapshot.routes).toHaveLength(1)
    expect(snapshot.routes[0]?.targets[0]?.priority).toBe(7)
    expect(snapshot.keys).toHaveLength(1)
    // `maskKey` keeps a six-character prefix and the last four, and never the whole
    // secret, which is what the key list has to show.
    expect(snapshot.keys[0]?.masked).toBe("sk-cli…ghij")
    expect(snapshot.keys[0]?.masked).not.toBe("sk-client-key-abcdefghij")
    expect(snapshot.settings).toEqual({
      default_strategy: "weighted",
      require_client_key: true,
      request_timeout_ms: DEFAULTS.request_timeout_ms,
      discovery_interval_s: DEFAULTS.discovery_interval_s
    })
  })

  test("an unset provider secret is reported as empty rather than as a mask", async () => {
    const snapshot = await runDb(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* createProvider(sql, {
          name: "keyless",
          kind: "openai-chat",
          base_url: "http://localhost:11434"
        })
        return yield* admin.config()
      })
    )

    expect(snapshot.providers[0]?.provider.api_key).toBe("")
  })
})

describe("admin.overview", () => {
  test("counts created rows, sums pool credits and reports uptime", async () => {
    const overview = await runDb(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const enabled = yield* createProvider(sql, {
          name: "enabled",
          kind: "openai-chat",
          base_url: "https://a.example.com",
          api_key: "k",
          enabled: true
        })
        const disabled = yield* createProvider(sql, {
          name: "disabled",
          kind: "workbuddy2api",
          base_url: "https://b.example.com",
          api_key: "k",
          enabled: false
        })
        const funded = yield* createProvider(sql, {
          name: "funded",
          kind: "workbuddy2api",
          base_url: "https://c.example.com",
          api_key: "k",
          enabled: true
        })

        yield* replaceProviderModels(sql, enabled.id, [model("a", "shared"), model("b", "only-a")])
        yield* replaceProviderModels(sql, funded.id, [model("c", "shared")])
        yield* createRoute(sql, {
          public_model: "shared",
          strategy: null,
          enabled: true,
          display_name: null,
          targets: [{ provider_id: enabled.id, upstream_model: "a", priority: 100, enabled: true }]
        })
        yield* createKey(sql, { name: "one" })
        yield* createKey(sql, { name: "two" })

        for (const [id, total] of [
          [funded.id, 120.5],
          [disabled.id, 4.5],
          [enabled.id, 999]
        ] as const) {
          yield* saveCredits(sql, id, { total, healthy: 1, accounts: [], fetched_at: Date.now(), error: null })
        }

        return yield* admin.overview()
      })
    )

    expect(overview.providers_total).toBe(3)
    expect(overview.providers_enabled).toBe(2)
    expect(overview.models).toBe(2)
    expect(overview.routes).toBe(1)
    expect(overview.keys).toBe(2)
    // Only workbuddy2api balances are budget, and the non-pool 999 is not one.
    expect(overview.credits_total).toBe(125)
    expect(overview.uptime_s).toBeGreaterThanOrEqual(119)
    // The dead provider was never marked unhealthy, so nothing is open yet.
    expect(overview.providers_open).toBe(0)
  })

  test("counts a provider whose breaker is still open, and ignores an expired one", async () => {
    const outcome = await runDb(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const cooling = yield* createProvider(sql, {
          name: "cooling",
          kind: "openai-chat",
          base_url: "https://a.example.com",
          api_key: "k"
        })
        const recovered = yield* createProvider(sql, {
          name: "recovered",
          kind: "openai-chat",
          base_url: "https://b.example.com",
          api_key: "k"
        })
        // One failure each: `threshold: 1` is what actually opens a breaker, so this
        // states the policy rather than pre-baking the deadline.
        yield* recordFailure(sql, cooling.id, "boom", { threshold: 1, base_ms: 60_000, max_ms: 300_000 })
        yield* recordFailure(sql, recovered.id, "boom", { threshold: 1, base_ms: 0, max_ms: 0 })
        const overview = yield* admin.overview()
        const status = yield* getProviderStatus(sql, recovered.id)
        return { overview, status }
      })
    )

    expect(outcome.overview.providers_open).toBe(1)
    expect(outcome.status.last_error).toBe("boom")
  })

  test("an empty gateway reports no credit total and no traffic", async () => {
    const overview = await runDb(admin.overview())

    expect(overview.providers_total).toBe(0)
    expect(overview.providers_enabled).toBe(0)
    expect(overview.providers_open).toBe(0)
    expect(overview.models).toBe(0)
    expect(overview.routes).toBe(0)
    expect(overview.keys).toBe(0)
    expect(overview.credits_total).toBeNull()
    expect(overview.uptime_s).toBeGreaterThanOrEqual(119)
  })
})

describe("admin provider mutations", () => {
  test("rejects an unknown kind and a base_url that is not an http URL", async () => {
    const outcome = await runDb(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        // The payload type forbids this; the handler must refuse it anyway, since
        // the check is what stops a bad value reaching the database.
        const badKind = yield* Effect.flip(
          admin.providerCreate({
            payload: {
              name: "x",
              kind: "openai-nonsense" as "openai-chat",
              base_url: "https://a.example.com"
            }
          })
        )
        const badUrl = yield* Effect.flip(
          admin.providerCreate({
            payload: { name: "x", kind: "openai-chat", base_url: "api.example.com" }
          })
        )
        const emptyUrl = yield* Effect.flip(
          admin.providerCreate({ payload: { name: "x", kind: "openai-chat", base_url: "   " } })
        )
        const badPatch = yield* Effect.flip(
          admin.providerUpdate({ path: { 0: 1 }, payload: { base_url: "ftp://a.example.com" } })
        )
        return { badKind, badUrl, emptyUrl, badPatch, rows: yield* listProviders(sql) }
      })
    )

    // Asserted on behaviour, not wording: each rejected input must name the offending
    // field and leave nothing stored. The old wording check broke when the message stopped
    // saying "non-empty", which is not what the test is about.
    // Asserted on behaviour, not wording: the offending value is named and nothing is
    // stored. The old check pinned the exact phrase "non-empty", which broke as soon as the
    // message changed — it was testing the wording rather than the rejection.
    expect(outcome.badKind.status).toBe(400)
    expect(outcome.badKind.detail).toContain("openai-nonsense")
    for (const rejected of [outcome.badUrl, outcome.emptyUrl, outcome.badPatch]) {
      expect(rejected.status).toBe(400)
      expect(rejected.detail ?? "").toContain("base_url")
    }
    expect(outcome.rows).toHaveLength(0)
  })

  test("updating a missing provider is a 404 and deleting an existing one removes it", async () => {
    const outcome = await runDb(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const created = yield* createProvider(sql, {
          name: "gone",
          kind: "openai-chat",
          base_url: "https://a.example.com",
          api_key: "k"
        })

        const missingUpdate = yield* Effect.flip(
          admin.providerUpdate({ path: { 0: 9_999 }, payload: { priority: 5 } })
        )
        const missingDelete = yield* Effect.flip(admin.providerDelete({ path: { 0: 9_999 } }))
        yield* admin.providerDelete({ path: { 0: created.id } })
        const afterDelete = yield* getProvider(sql, created.id)
        const twice = yield* Effect.flip(admin.providerDelete({ path: { 0: created.id } }))

        const duplicate = yield* admin.providerCreate({
          payload: { name: "gone", kind: "openai-chat", base_url: "https://d.example.com", api_key: "k" }
        })

        return { missingUpdate, missingDelete, afterDelete, twice, duplicate }
      })
    )

    expect(outcome.missingUpdate.error).toBe("not found")
    expect(outcome.missingUpdate.detail).toContain("9999")
    expect(outcome.missingDelete.error).toBe("not found")
    expect(Option.isNone(outcome.afterDelete)).toBe(true)
    expect(outcome.twice.error).toBe("not found")
    // Names are not unique, so re-creating one under the same name is allowed.
    expect(outcome.duplicate.name).toBe("gone")
  })

  test("a patch merges over the stored row and leaves the secret alone", async () => {
    const outcome = await runDb(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const created = yield* createProvider(sql, {
          name: "keep",
          kind: "openai-chat",
          base_url: "https://a.example.com",
          api_key: "sk-original",
          priority: 100,
          max_retries: 0
        })
        const patched = yield* admin.providerUpdate({ path: { 0: created.id }, payload: { priority: 250 } })
        const cleared = yield* admin.providerUpdate({ path: { 0: created.id }, payload: { input_price: null } })
        const stored = yield* getProvider(sql, created.id)
        return { patched, cleared, stored }
      })
    )

    expect(outcome.patched.priority).toBe(250)
    expect(outcome.patched.name).toBe("keep")
    expect(outcome.patched.base_url).toBe("https://a.example.com")
    expect(outcome.cleared.input_price).toBeNull()
    expect(Option.getOrThrow(outcome.stored).api_key).toBe("sk-original")
  })
})

describe("admin.usageLog", () => {
  test("totals cover the whole filtered set, not just the returned page", async () => {
    const page = await runDb(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        for (let index = 0; index < 4; index += 1) {
          yield* insertUsage(sql, usage({ public_model: "shared", status: 500, prompt_tokens: 10, cost: 2 }))
        }
        yield* insertUsage(sql, usage({ public_model: "shared", status: 200, prompt_tokens: 1_000, cost: 9 }))
        yield* insertUsage(sql, usage({ public_model: "other", status: 500, prompt_tokens: 1_000, cost: 50 }))

        return yield* admin.usageLog({ urlParams: { limit: "1", errors_only: "true", model: "shared" } })
      })
    )

    expect(page.rows).toHaveLength(1)
    expect(page.total).toBe(4)
    expect(page.totals.requests).toBe(4)
    expect(page.totals.prompt_tokens).toBe(40)
    expect(page.totals.completion_tokens).toBe(0)
    expect(page.totals.cost).toBe(8)
  })

  test("filters by provider and clamps the page size", async () => {
    const outcome = await runDb(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* insertUsage(sql, usage({ public_model: "m0", provider_id: 4, provider_name: "four" }))
        yield* insertUsage(sql, usage({ public_model: "m1", provider_id: 4, provider_name: "four" }))
        yield* insertUsage(sql, usage({ public_model: "m2", provider_id: 5, provider_name: "five" }))

        const oversized = yield* admin.usageLog({ urlParams: { limit: "10000" } })
        const byProvider = yield* admin.usageLog({ urlParams: { provider_id: "4" } })
        const offset = yield* admin.usageLog({ urlParams: { limit: "1", offset: "2" } })
        const defaulted = yield* admin.usageLog({ urlParams: {} })
        return { oversized, byProvider, offset, defaulted }
      })
    )

    // 10000 clamps to the 500 maximum, which is above the three rows present.
    expect(outcome.oversized.rows).toHaveLength(3)
    expect(outcome.byProvider.total).toBe(2)
    expect(outcome.byProvider.rows.map((row) => row["public_model"])).toEqual(["m1", "m0"])
    expect(outcome.offset.rows).toHaveLength(1)
    expect(outcome.offset.total).toBe(3)
    expect(outcome.defaulted.rows).toHaveLength(3)
  })
})

describe("admin.usage", () => {
  test("defaults to a 24h window and reflects the recorded traffic", async () => {
    const result = await runDb(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* insertUsage(
          sql,
          usage({ public_model: "shared", prompt_tokens: 100, cached_tokens: 25, status: 200 })
        )
        yield* insertUsage(sql, usage({ public_model: "shared", status: 502, cost: 1 }))
        return yield* admin.usage({ urlParams: {} })
      })
    )

    expect(result.summary.window_ms).toBe(24 * 60 * 60 * 1000)
    expect(result.summary.requests).toBe(2)
    expect(result.summary.errors).toBe(1)
    expect(result.summary.prompt_tokens).toBe(100)
    expect(result.summary.cache_rate).toBe(0.25)
    expect(result.summary.cost).toBe(1)
    expect(result.summary.by_model.map((row) => row.key)).toEqual(["shared"])
    expect(result.series.reduce((sum, point) => sum + point.requests, 0)).toBe(2)
  })

  test("parses an explicit window and clamps the bucket to a full minute", async () => {
    const result = await runDb(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* insertUsage(sql, usage({}))
        return yield* admin.usage({ urlParams: { window: "60000", bucket: "5" } })
      })
    )

    expect(result.summary.window_ms).toBe(60_000)
    expect(result.series.length).toBeGreaterThanOrEqual(1)
    for (const point of result.series) expect(point.ts % 60_000).toBe(0)
  })
})

describe("admin.providerTest", () => {
  test("a reachable provider reports ok with the model's reply", async () => {
    const seen: Array<{ path: string; body: Record<string, unknown> }> = []
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        seen.push({
          path: new URL(request.url).pathname,
          body: (await request.json()) as Record<string, unknown>
        })
        return Response.json({
          id: "chatcmpl-1",
          object: "chat.completion",
          created: 1_700_000_000,
          model: "up-gpt",
          choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 }
        })
      }
    })
    const port = server.port ?? 0
    try {
      const result = await runUpstream(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const provider = yield* createProvider(sql, {
            name: "mock",
            kind: "openai-chat",
            base_url: `http://127.0.0.1:${port}`,
            api_key: "sk-mock"
          })
          yield* replaceProviderModels(sql, provider.id, [model("up-gpt", "public-gpt")])
          return yield* admin.providerTest({ path: { 0: provider.id }, payload: {} })
        })
      )

      expect(result.ok).toBe(true)
      expect(result.model).toBe("public-gpt")
      expect(result.reply).toBe("pong")
      expect(result.error).toBeNull()
      expect(result.latency_ms).toBeGreaterThanOrEqual(0)
      expect(seen).toHaveLength(1)
      expect(seen[0]?.path).toBe("/v1/chat/completions")
      expect(seen[0]?.body.model).toBe("up-gpt")
      expect(seen[0]?.body.stream).toBe(false)
    } finally {
      void server.stop(true)
    }
  })

  test("a requested model overrides the first discovered one", async () => {
    const requested: unknown[] = []
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        requested.push(((await request.json()) as Record<string, unknown>).model)
        return Response.json({
          id: "chatcmpl-2",
          object: "chat.completion",
          created: 1,
          model: "second",
          choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        })
      }
    })
    const port = server.port ?? 0
    try {
      const result = await runUpstream(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const provider = yield* createProvider(sql, {
            name: "mock",
            kind: "openai-chat",
            base_url: `http://127.0.0.1:${port}`,
            api_key: "sk-mock"
          })
          yield* replaceProviderModels(sql, provider.id, [model("first", "alpha"), model("second", "beta")])
          const byPublic = yield* admin.providerTest({ path: { 0: provider.id }, payload: { model: "beta" } })
          const byUpstream = yield* admin.providerTest({ path: { 0: provider.id }, payload: { model: "first" } })
          return { byPublic, byUpstream }
        })
      )

      expect(result.byPublic.ok).toBe(true)
      expect(result.byPublic.model).toBe("beta")
      expect(result.byUpstream.model).toBe("first")
      expect(requested).toEqual(["second", "first"])
    } finally {
      void server.stop(true)
    }
  })

  test("a dead port reports ok:false with an error instead of failing the endpoint", async () => {
    // Bind and release a port, so something is guaranteed not to be listening.
    const probe = Bun.serve({ port: 0, fetch: () => new Response("") })
    const deadPort = probe.port ?? 0
    void probe.stop(true)

    const result = await runUpstream(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const provider = yield* createProvider(sql, {
          name: "dead",
          kind: "openai-chat",
          base_url: `http://127.0.0.1:${deadPort}`,
          api_key: "sk-dead"
        })
        yield* replaceProviderModels(sql, provider.id, [model("up-gpt", "public-gpt")])
        return yield* admin.providerTest({ path: { 0: provider.id }, payload: {} })
      })
    )

    expect(result.ok).toBe(false)
    expect(result.model).toBe("public-gpt")
    expect(result.reply).toBeNull()
    expect(result.error).toContain(":")
  })

  test("a provider that rejects the probe reports the upstream reason", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ error: { message: "invalid api key" } }, { status: 401 })
    })
    const port = server.port ?? 0
    try {
      const result = await runUpstream(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const provider = yield* createProvider(sql, {
            name: "bad-key",
            kind: "openai-chat",
            base_url: `http://127.0.0.1:${port}`,
            api_key: "sk-wrong"
          })
          yield* replaceProviderModels(sql, provider.id, [model("up-gpt", "public-gpt")])
          return yield* admin.providerTest({ path: { 0: provider.id }, payload: {} })
        })
      )

      expect(result.ok).toBe(false)
      expect(result.error).toContain("invalid api key")
    } finally {
      void server.stop(true)
    }
  })

  test("a provider with nothing to test reports ok:false rather than failing", async () => {
    const result = await runUpstream(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const provider = yield* createProvider(sql, {
          name: "empty",
          kind: "openai-chat",
          base_url: "http://127.0.0.1:1",
          api_key: "k"
        })
        return yield* admin.providerTest({ path: { 0: provider.id }, payload: {} })
      })
    )

    expect(result.ok).toBe(false)
    expect(result.model).toBe("")
    expect(result.error).toContain("no model to test")
  })

  test("probing an unknown provider id is a not-found failure", async () => {
    const failure = await runUpstream(
      Effect.gen(function* () {
        return yield* Effect.flip(admin.providerTest({ path: { 0: 4_242 }, payload: {} }))
      })
    )

    expect(failure.error).toBe("not found")
    expect(failure.detail).toContain("4242")
  })
})

describe("admin routes", () => {
  test("a target naming a missing provider is a bad request, not a storage failure", async () => {
    const outcome = await runDb(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const create = yield* Effect.flip(
          admin.routeCreate({
            payload: {
              public_model: "ghost",
              targets: [{ provider_id: 77, upstream_model: "m", priority: 1, enabled: true }]
            }
          })
        )
        const update = yield* Effect.flip(
          admin.routeUpdate({
            path: { 0: "ghost" },
            payload: { targets: [{ provider_id: 77, upstream_model: "m", priority: 1, enabled: true }] }
          })
        )
        return { create, update, routes: yield* listRoutes(sql) }
      })
    )

    expect(outcome.create.error).toBe("bad request")
    expect(outcome.create.detail).toContain("77")
    expect(outcome.update.error).toBe("bad request")
    expect(outcome.routes).toHaveLength(0)
  })

  test("create, patch with no targets, and delete round-trip; a missing route is a 404", async () => {
    const outcome = await runDb(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const provider = yield* createProvider(sql, {
          name: "p",
          kind: "openai-chat",
          base_url: "https://a.example.com",
          api_key: "k"
        })
        const created = yield* admin.routeCreate({
          payload: {
            public_model: "shared",
            strategy: null,
            display_name: null,
            targets: [{ provider_id: provider.id, upstream_model: "up", priority: 100, enabled: true }]
          }
        })
        const patched = yield* admin.routeUpdate({
          path: { 0: "shared" },
          payload: { enabled: false, display_name: "Nice name" }
        })
        const missingUpdate = yield* Effect.flip(admin.routeUpdate({ path: { 0: "nope" }, payload: {} }))
        const missingDelete = yield* Effect.flip(admin.routeDelete({ path: { 0: "nope" } }))
        yield* admin.routeDelete({ path: { 0: "shared" } })
        return { created, patched, missingUpdate, missingDelete, remaining: yield* listRoutes(sql) }
      })
    )

    expect(outcome.created.strategy).toBeNull()
    expect(outcome.created.targets[0]?.upstream_model).toBe("up")
    expect(outcome.patched.enabled).toBe(false)
    expect(outcome.patched.display_name).toBe("Nice name")
    // The patch carried no targets, so the existing one must survive.
    expect(outcome.patched.targets).toHaveLength(1)
    expect(outcome.missingUpdate.error).toBe("not found")
    expect(outcome.missingDelete.error).toBe("not found")
    expect(outcome.remaining).toHaveLength(0)
  })

  test("a sync over an empty catalogue reports no work and leaves routes alone", async () => {
    await runUpstream(
      Effect.gen(function* () {
        const result = yield* admin.routesSync()
        expect(result.created).toEqual([])
        expect(result.updated).toEqual([])
        expect(result.removed).toEqual([])
      })
    )
  })
})

describe("admin keys", () => {
  test("create masks the generated secret, update patches in place, missing ids 404", async () => {
    const outcome = await runDb(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const created = yield* admin.keyCreate({ payload: { name: "client", rate_limit_rpm: 60 } })
        const stored = yield* getKey(sql, created.id)
        const patched = yield* admin.keyUpdate({
          path: { 0: created.id },
          payload: { enabled: false, allowed_models: ["gpt-*"] }
        })
        const missing = yield* Effect.flip(admin.keyUpdate({ path: { 0: 1_234 }, payload: { enabled: false } }))
        const missingDelete = yield* Effect.flip(admin.keyDelete({ path: { 0: 1_234 } }))
        yield* admin.keyDelete({ path: { 0: created.id } })
        const afterDelete = yield* getKey(sql, created.id)
        return { created, stored, patched, missing, missingDelete, afterDelete }
      })
    )

    expect(outcome.created.name).toBe("client")
    expect(Option.getOrThrow(outcome.stored).key.startsWith("sk-agg-")).toBe(true)
    // The response is a mask, not the secret the row holds.
    expect(outcome.created.masked).not.toBe(Option.getOrThrow(outcome.stored).key)
    expect(outcome.created.masked).toContain("…")
    expect(outcome.patched.enabled).toBe(false)
    expect(outcome.patched.name).toBe("client")
    expect(outcome.patched.rate_limit_rpm).toBe(60)
    expect(outcome.patched.allowed_models).toEqual(["gpt-*"])
    expect(outcome.missing.error).toBe("not found")
    expect(outcome.missingDelete.error).toBe("not found")
    expect(Option.isNone(outcome.afterDelete)).toBe(true)
  })
})

describe("admin discovery", () => {
  test("discoverAll reports an unreachable provider inside the result", async () => {
    const results = await runUpstream(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* createProvider(sql, {
          name: "dead",
          kind: "openai-chat",
          base_url: "http://127.0.0.1:1",
          api_key: "k",
          enabled: true
        })
        const response = yield* admin.discoverAll()
        return response.results
      })
    )

    expect(results).toHaveLength(1)
    expect(results[0]?.models).toEqual([])
    expect(results[0]?.error).toContain(":")
  })

  test("providerDiscover stores what the upstream advertises", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({
          data: [
            { id: "up-a", owned_by: "mock", context_length: 8_192 },
            { id: "up-b", owned_by: "mock" }
          ]
        })
    })
    const port = server.port ?? 0
    try {
      const result = await runUpstream(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const provider = yield* createProvider(sql, {
            name: "mock",
            kind: "openai-chat",
            base_url: `http://127.0.0.1:${port}`,
            api_key: "sk-mock",
            model_rename: { "up-b": "renamed-b" }
          })
          return yield* admin.providerDiscover({ path: { 0: provider.id } })
        })
      )

      expect(result.error).toBeNull()
      expect(result.provider_id).toBeGreaterThan(0)
      expect(result.models.map((entry) => entry.public_id).sort()).toEqual(["renamed-b", "up-a"])
      expect([...result.created].sort()).toEqual(["renamed-b", "up-a"])
      expect(result.removed).toEqual([])
    } finally {
      void server.stop(true)
    }
  })

  test("a discovery failure is reported in the result, and the endpoint still succeeds", async () => {
    const result = await runUpstream(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const provider = yield* createProvider(sql, {
          name: "dead",
          kind: "openai-chat",
          base_url: "http://127.0.0.1:1",
          api_key: "k"
        })
        yield* replaceProviderModels(sql, provider.id, [model("kept", "kept")])
        return yield* admin.providerDiscover({ path: { 0: provider.id } })
      })
    )

    expect(result.error).not.toBeNull()
    // The previously discovered catalogue is preserved rather than wiped.
    expect(result.models.map((entry) => entry.public_id)).toEqual(["kept"])
  })

  test("providerCredits reports the stored snapshot and refreshes a pool provider", async () => {
    const result = await runUpstream(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const chat = yield* createProvider(sql, {
          name: "chat",
          kind: "openai-chat",
          base_url: "http://127.0.0.1:1",
          api_key: "k"
        })
        const before = yield* admin.providerCredits({ path: { 0: chat.id } })
        yield* saveCredits(sql, chat.id, {
          total: 7,
          healthy: 1,
          accounts: [{ uid: "u", credits: 7 }],
          fetched_at: Date.now(),
          error: null
        })
        const after = yield* admin.providerCredits({ path: { 0: chat.id } })
        return { before, after }
      })
    )

    expect(result.before.credits).toBeNull()
    expect(result.before.error).toBeNull()
    expect(result.after.credits?.total).toBe(7)
    expect(result.after.error).toBeNull()
  })

  test("probing credits for an unknown provider id is a not-found failure", async () => {
    const failure = await runUpstream(
      Effect.gen(function* () {
        return yield* Effect.flip(admin.providerCredits({ path: { 0: 9_999 } }))
      })
    )

    expect(failure.error).toBe("not found")
    expect(failure.detail).toContain("9999")
  })
})

describe("admin error reporting", () => {
  test("a storage failure never leaks the statement or its bound parameters", async () => {
    // Dropping the table is the only way to reach the SqlError path without mocking
    // the driver; the raw error message quotes the failing statement together with
    // its bound parameters, and a provider row binds its API key as one of them.
    const failure = await runDb(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* createProvider(sql, {
          name: "secretive",
          kind: "openai-chat",
          base_url: "https://a.example.com",
          api_key: "sk-super-secret"
        })
        yield* sql.unsafe("DROP TABLE providers")
        return yield* Effect.flip(admin.config())
      })
    )

    expect(failure.error).toBe("database error")
    expect(failure.detail).not.toContain("SELECT")
    expect(failure.detail).not.toContain("sk-super-secret")
    expect(failure.detail).not.toContain("Failed to execute statement")
  })
})
