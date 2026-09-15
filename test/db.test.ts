import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as SqlClient from "@effect/sql/SqlClient"
import { runScoped } from "./helpers.ts"
import { createProvider, deleteProvider, getProvider, listModels, listModelsForProvider, listProviders, replaceProviderModels, updateProvider } from "../src/db/providers.ts"
import { createRoute, deleteRoute, getRoute, listRoutes, resolveTargets, updateRoute } from "../src/db/routes.ts"
import { createKey, deleteKey, getKeyByValue, listKeys, maskKey, touchKey, updateKey } from "../src/db/keys.ts"
import { getProviderStatus, listProviderStatuses, recordFailure, recordSuccess, resetProviderHealth } from "../src/db/health.ts"
import { getCredits, listCredits, saveCredits } from "../src/db/credits.ts"
import { insertUsage, logPage, purgeOlderThan, summary } from "../src/db/usage.ts"
import type { DiscoveredModel, UsageEntry } from "../src/domain.ts"

const model = (id: string, publicId = id): DiscoveredModel => ({
  provider_id: 0,
  upstream_id: id,
  public_id: publicId,
  context_length: 128000,
  max_output_tokens: 4096,
  supports_images: false,
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
  public_model: "gpt-test",
  provider_id: null,
  provider_name: "p",
  provider_kind: "openai-chat",
  upstream_model: "gpt-test",
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

describe("providers", () => {
  test("create, update, get and delete round-trip", async () => {
    await runScoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const created = yield* createProvider(sql, {
          name: "OpenAI",
          kind: "openai-chat",
          base_url: "https://api.openai.com",
          api_key: "sk-secret",
          priority: 50,
          headers: { "x-org": "acme" }
        })

        expect(created.id).toBeGreaterThan(0)
        expect(created.enabled).toBe(true)
        expect(created.headers).toEqual({ "x-org": "acme" })
        expect(created.currency).toBe("USD")

        // A patch that omits api_key must leave the stored secret alone — this is
        // what lets the edit form submit without the operator re-entering it.
        const patched = yield* updateProvider(sql, created.id, { name: "OpenAI 2", priority: 10 })
        expect(Option.isSome(patched)).toBe(true)
        const after = Option.getOrThrow(patched)
        expect(after.name).toBe("OpenAI 2")
        expect(after.priority).toBe(10)
        expect(after.api_key).toBe("sk-secret")

        expect((yield* listProviders(sql)).length).toBe(1)
        expect(yield* deleteProvider(sql, created.id)).toBe(1)
        expect(Option.isNone(yield* getProvider(sql, created.id))).toBe(true)
      })
    )
  })

  test("replaceProviderModels adds new ids and removes departed ones", async () => {
    await runScoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const provider = yield* createProvider(sql, {
          name: "p",
          kind: "openai-chat",
          base_url: "https://example.test"
        })

        const first = yield* replaceProviderModels(sql, provider.id, [
          { ...model("a"), provider_id: provider.id },
          { ...model("b"), provider_id: provider.id }
        ])
        expect([...first.added].sort()).toEqual(["a", "b"])
        expect(first.removed).toEqual([])

        const second = yield* replaceProviderModels(sql, provider.id, [
          { ...model("b"), provider_id: provider.id },
          { ...model("c"), provider_id: provider.id }
        ])
        expect(second.added).toEqual(["c"])
        expect(second.removed).toEqual(["a"])
        expect((yield* listModelsForProvider(sql, provider.id)).map((m) => m.upstream_id)).toEqual(["b", "c"])
        expect((yield* listModels(sql)).length).toBe(2)
      })
    )
  })
})

describe("routes", () => {
  test("targets resolve ordered by priority and exclude disabled providers", async () => {
    await runScoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const low = yield* createProvider(sql, {
          name: "low",
          kind: "openai-chat",
          base_url: "https://low.test",
          priority: 1
        })
        const high = yield* createProvider(sql, {
          name: "high",
          kind: "openai-chat",
          base_url: "https://high.test",
          priority: 99
        })
        const off = yield* createProvider(sql, {
          name: "off",
          kind: "openai-chat",
          base_url: "https://off.test",
          priority: 500,
          enabled: false
        })

        yield* createRoute(sql, {
          public_model: "shared",
          strategy: "priority",
          targets: [
            { provider_id: low.id, upstream_model: "low-1", priority: 10, enabled: true },
            { provider_id: high.id, upstream_model: "high-1", priority: 20, enabled: true },
            { provider_id: off.id, upstream_model: "off-1", priority: 999, enabled: true },
            { provider_id: high.id, upstream_model: "high-2", priority: 5, enabled: false }
          ]
        })

        const resolved = yield* resolveTargets(sql, "shared")
        // Priority wins over provider priority, the disabled target and the
        // disabled provider are both filtered, and the provider row is joined in.
        expect(resolved.map((r) => r.target.upstream_model)).toEqual(["high-1", "low-1"])
        expect(resolved[0]?.provider.name).toBe("high")

        const route = Option.getOrThrow(yield* getRoute(sql, "shared"))
        expect(route.strategy).toBe("priority")
        expect(route.targets.length).toBe(4)

        // Disabling the route itself removes every candidate.
        yield* updateRoute(sql, "shared", { enabled: false })
        expect(yield* resolveTargets(sql, "shared")).toEqual([])

        yield* deleteRoute(sql, "shared")
        expect((yield* listRoutes(sql)).length).toBe(0)
      })
    )
  })
})

describe("keys", () => {
  test("masks on read, matches on the real value, and counts usage", async () => {
    await runScoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const created = yield* createKey(sql, { name: "app", rate_limit_rpm: 60 })
        expect(created.key.startsWith("sk-agg-")).toBe(true)

        const listed = yield* listKeys(sql)
        expect(listed.length).toBe(1)
        expect(listed[0]?.masked).toBe(maskKey(created.key))
        expect(listed[0]?.masked).not.toContain(created.key)

        expect(Option.isSome(yield* getKeyByValue(sql, created.key))).toBe(true)
        expect(Option.isNone(yield* getKeyByValue(sql, "sk-agg-wrong"))).toBe(true)

        yield* touchKey(sql, created.id)
        yield* touchKey(sql, created.id)
        const after = yield* listKeys(sql)
        expect(after[0]?.total_requests).toBe(2)
        expect(after[0]?.last_used_at).toBeGreaterThan(0)

        yield* updateKey(sql, created.id, { enabled: false, allowed_models: ["gpt-test"] })
        const updated = yield* listKeys(sql)
        expect(updated[0]?.enabled).toBe(false)
        expect(updated[0]?.allowed_models).toEqual(["gpt-test"])

        expect(yield* deleteKey(sql, created.id)).toBe(1)
      })
    )
  })

  test("short keys are fully masked", () => {
    expect(maskKey("short")).toBe("…")
    expect(maskKey("sk-agg-0123456789abcdef")).toBe("sk-agg…cdef")
  })
})

describe("health", () => {
  test("failure accumulates and success closes the breaker", async () => {
    await runScoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const provider = yield* createProvider(sql, {
          name: "p",
          kind: "openai-chat",
          base_url: "https://p.test"
        })

        expect((yield* getProviderStatus(sql, provider.id)).consecutive_failures).toBe(0)

        const openUntil = Date.now() + 60_000
        yield* recordFailure(sql, provider.id, "boom", openUntil)
        yield* recordFailure(sql, provider.id, "boom again", openUntil)
        const failed = yield* getProviderStatus(sql, provider.id)
        expect(failed.consecutive_failures).toBe(2)
        expect(failed.open_until).toBe(openUntil)
        expect(failed.last_error).toBe("boom again")

        yield* recordSuccess(sql, provider.id, 42)
        const healthy = yield* getProviderStatus(sql, provider.id)
        expect(healthy.consecutive_failures).toBe(0)
        expect(healthy.open_until).toBe(0)
        expect(healthy.last_latency_ms).toBe(42)
        // The error text survives a recovery so the UI can still show why it failed.
        expect(healthy.last_error).toBe("boom again")

        expect((yield* listProviderStatuses(sql)).length).toBe(1)
        yield* resetProviderHealth(sql, provider.id)
        expect((yield* listProviderStatuses(sql)).length).toBe(0)
      })
    )
  })
})

describe("credits", () => {
  test("stores and rehydrates a snapshot including per-account detail", async () => {
    await runScoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const provider = yield* createProvider(sql, {
          name: "wb",
          kind: "workbuddy2api",
          base_url: "https://wb.test"
        })

        expect(Option.isNone(yield* getCredits(sql, provider.id))).toBe(true)

        yield* saveCredits(sql, provider.id, {
          total: 300,
          healthy: 1,
          accounts: [
            { uid: "u1", nickname: "primary", credits: 200, cooling: false },
            { uid: "u2", credits: 100, cooling: true, disabled_reason: "402" }
          ],
          fetched_at: 1700,
          error: null
        })

        const stored = Option.getOrThrow(yield* getCredits(sql, provider.id))
        expect(stored.total).toBe(300)
        expect(stored.healthy).toBe(1)
        expect(stored.fetched_at).toBe(1700)
        expect(stored.accounts.length).toBe(2)
        expect(stored.accounts[0]?.nickname).toBe("primary")
        expect(stored.accounts[1]?.cooling).toBe(true)
        expect(stored.accounts[1]?.disabled_reason).toBe("402")
        expect((yield* listCredits(sql)).length).toBe(1)
      })
    )
  })
})

describe("usage", () => {
  test("summary computes cache rate and buckets by model, provider and key", async () => {
    await runScoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient

        yield* insertUsage(
          sql,
          usage({
            public_model: "a",
            provider_name: "p1",
            api_key_name: "k1",
            prompt_tokens: 1000,
            completion_tokens: 100,
            cached_tokens: 800,
            cost: 1.5,
            latency_ms: 100,
            ttft_ms: 40
          })
        )
        yield* insertUsage(
          sql,
          usage({
            public_model: "a",
            provider_name: "p1",
            api_key_name: "k2",
            prompt_tokens: 1000,
            completion_tokens: 200,
            // A provider that reports nothing about caching must pull the rate
            // down rather than being excluded from it.
            cached_tokens: 0,
            cost: 2.5,
            latency_ms: 300,
            ttft_ms: 60
          })
        )

        const result = yield* summary(sql, 60_000)
        expect(result.requests).toBe(2)
        expect(result.errors).toBe(0)
        expect(result.prompt_tokens).toBe(2000)
        expect(result.cached_tokens).toBe(800)
        expect(result.cache_rate).toBeCloseTo(0.4, 10)
        expect(result.cost).toBeCloseTo(4, 10)
        expect(result.avg_latency_ms).toBeCloseTo(200, 10)
        expect(result.avg_ttft_ms).toBeCloseTo(50, 10)

        expect(result.by_model.length).toBe(1)
        expect(result.by_model[0]?.key).toBe("a")
        expect(result.by_model[0]?.requests).toBe(2)
        expect(result.by_provider.map((row) => row.key)).toEqual(["p1"])
        expect([...result.by_key.map((row) => row.key)].sort()).toEqual(["k1", "k2"])

        // An empty window has no defined cache rate — null, not a misleading 0%.
        const empty = yield* summary(sql, -1)
        expect(empty.requests).toBe(0)
        expect(empty.cache_rate).toBeNull()
        expect(empty.avg_latency_ms).toBeNull()
      })
    )
  })

  test("log page totals cover the whole filtered set, not just the page", async () => {
    await runScoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient

        for (let i = 0; i < 5; i += 1) {
          yield* insertUsage(
            sql,
            usage({
              public_model: "m1",
              provider_id: 1,
              provider_name: "p1",
              prompt_tokens: 100,
              cached_tokens: 10,
              cost: 1,
              latency_ms: 10,
              ttft_ms: 5,
              status: i < 2 ? 500 : 200,
              error_kind: i < 2 ? "upstream" : null
            })
          )
        }
        yield* insertUsage(
          sql,
          usage({ public_model: "m2", provider_id: 2, provider_name: "p2", prompt_tokens: 500, cost: 9 })
        )

        const page = yield* logPage(sql, {
          limit: 2,
          offset: 0,
          model: null,
          providerId: null,
          errorsOnly: false
        })
        expect(page.rows.length).toBe(2)
        expect(page.total).toBe(6)
        expect(page.totals.requests).toBe(6)
        expect(page.totals.prompt_tokens).toBe(1000)
        expect(page.totals.cost).toBeCloseTo(14, 10)

        const errors = yield* logPage(sql, {
          limit: 10,
          offset: 0,
          model: null,
          providerId: null,
          errorsOnly: true
        })
        expect(errors.total).toBe(2)
        expect(errors.totals.requests).toBe(2)

        const byModel = yield* logPage(sql, {
          limit: 10,
          offset: 0,
          model: "m2",
          providerId: null,
          errorsOnly: false
        })
        expect(byModel.total).toBe(1)
        expect(byModel.totals.prompt_tokens).toBe(500)

        const byProvider = yield* logPage(sql, {
          limit: 10,
          offset: 0,
          model: null,
          providerId: 1,
          errorsOnly: false
        })
        expect(byProvider.total).toBe(5)

        expect(yield* purgeOlderThan(sql, Date.now() + 1000)).toBe(6)
        expect((yield* summary(sql, 60_000)).requests).toBe(0)
      })
    )
  })
})
