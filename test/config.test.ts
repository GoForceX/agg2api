import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import { DEFAULTS, resolve } from "../src/config.ts"
import { run } from "./helpers.ts"

const ok = (file: Record<string, unknown>, env: Record<string, string | undefined> = {}) =>
  run(resolve(file, { AGG2API_ADMIN_TOKEN: "token", ...env }))

/** Resolve and keep the failure instead of rethrowing it. */
const attempt = (file: Record<string, unknown>, env: Record<string, string | undefined> = {}) =>
  run(resolve(file, env).pipe(Effect.either))

describe("config resolution", () => {
  test("falls back to the built-in defaults", async () => {
    const settings = await ok({})
    expect(settings.port).toBe(DEFAULTS.port)
    expect(settings.host).toBe(DEFAULTS.host)
    expect(settings.default_strategy).toBe("priority")
    expect(settings.db_path).toBe(DEFAULTS.db_path)
  })

  test("the file overrides defaults", async () => {
    const settings = await ok({ port: 9000, host: "127.0.0.1", default_strategy: "weighted" })
    expect(settings.port).toBe(9000)
    expect(settings.host).toBe("127.0.0.1")
    expect(settings.default_strategy).toBe("weighted")
  })

  test("the environment overrides the file", async () => {
    const settings = await ok(
      { port: 9000, discovery_interval_s: 60 },
      { AGG2API_PORT: "9100", AGG2API_DISCOVERY_INTERVAL_S: "0" }
    )
    expect(settings.port).toBe(9100)
    // 0 is meaningful here ("disable"), so it must survive rather than be treated
    // as absent and replaced by the default.
    expect(settings.discovery_interval_s).toBe(0)
  })

  test("booleans arrive from the environment as strings", async () => {
    expect((await ok({}, { AGG2API_REQUIRE_CLIENT_KEY: "true" })).require_client_key).toBe(true)
    expect((await ok({}, { AGG2API_REQUIRE_CLIENT_KEY: "false" })).require_client_key).toBe(false)
  })

  test("rejects a wrongly typed file value instead of coercing it", async () => {
    // A string port is a typo; silently accepting it would start a server the
    // operator cannot reach.
    const outcome = await attempt({ port: "8787" }, { AGG2API_ADMIN_TOKEN: "token" })
    expect(outcome._tag).toBe("Left")
    if (outcome._tag === "Left") {
      expect(outcome.left.message).toContain("port")
    }
  })

  test("rejects a malformed environment value", async () => {
    const outcome = await attempt({}, { AGG2API_ADMIN_TOKEN: "token", AGG2API_PORT: "not-a-number" })
    expect(outcome._tag).toBe("Left")
  })

  test("refuses an empty admin token on a non-loopback bind", async () => {
    const exposed = await attempt({ host: "0.0.0.0", admin_token: "" }, {})
    expect(exposed._tag).toBe("Left")
    if (exposed._tag === "Left") {
      expect(exposed.left.source).toBe("admin_token")
    }

    // The same configuration on loopback is allowed, so local development does not
    // require inventing a token.
    const local = await run(
      resolve({ host: "127.0.0.1", admin_token: "" }, {}).pipe(Effect.orDie)
    )
    expect(local.admin_token).toBe("")
  })

  test("rejects a non-positive port", async () => {
    const outcome = await attempt({ port: -1 }, { AGG2API_ADMIN_TOKEN: "token" })
    expect(outcome._tag).toBe("Left")
  })

  test("rejects a negative retention window", async () => {
    const outcome = await attempt({ log_retention_days: -5 }, { AGG2API_ADMIN_TOKEN: "token" })
    expect(outcome._tag).toBe("Left")
  })
})
