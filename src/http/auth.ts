/**
 * Client authentication and per-key admission control.
 *
 * `/v1/*` is the surface exposed to callers. When `require_client_key` is off (the
 * default for a loopback deployment) requests are anonymous but still usable; when
 * on, a key must exist in `api_keys` and be enabled.
 *
 * Rate limiting is per key, in-process, via a sliding window. That is the right
 * shape here: the gateway is a single process, and a limiter that survives a
 * restart or coordinates across replicas would need shared state the rest of the
 * design does not have.
 */
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as SqlClient from "@effect/sql/SqlClient"
import type { ApiKey } from "../domain.ts"
import { getKeyByValue, touchKey } from "../db/keys.ts"
import { AppSettings } from "../gateway/settings.ts"
import { badRequest, forbidden, rateLimited, unauthorized } from "../errors.ts"
import type { ClientError } from "../errors.ts"

/** The caller identity attached to a request once admitted. */
export interface Caller {
  readonly id: number | null
  readonly name: string | null
  /** Model allowlist; empty means every model. */
  readonly allowed_models: ReadonlyArray<string>
}

/** Anonymous callers are permitted only when the gateway does not require a key. */
export const ANONYMOUS: Caller = { id: null, name: null, allowed_models: [] }

/** Pull the bearer token out of an `Authorization` header. */
export const bearerToken = (header: string | null): string | null => {
  if (header === null) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match?.[1]?.trim() ?? null
}

/**
 * Resolve the caller for a request.
 *
 * A presented-but-unknown key is always rejected, even when keys are not required:
 * silently downgrading a typo'd key to anonymous access would make a
 * misconfiguration look like success and hand out unauthenticated traffic.
 */
export const authenticate = (
  authorization: string | null
): Effect.Effect<Caller, ClientError, SqlClient.SqlClient | AppSettings> =>
  Effect.gen(function* () {
    const settings = yield* AppSettings
    const token = bearerToken(authorization)

    if (token === null) {
      if (!settings.require_client_key) return ANONYMOUS
      return yield* Effect.fail(unauthorized("missing bearer token"))
    }

    const sql = yield* SqlClient.SqlClient
    const found = yield* getKeyByValue(sql, token).pipe(Effect.orDie)
    if (Option.isNone(found)) {
      return yield* Effect.fail(unauthorized("invalid API key"))
    }

    const key: ApiKey = found.value
    if (!key.enabled) {
      return yield* Effect.fail(forbidden("this API key is disabled"))
    }

    yield* touchKey(sql, key.id).pipe(Effect.orDie)
    return { id: key.id, name: key.name, allowed_models: key.allowed_models }
  })

/** Reject a model the caller's key is not scoped to. */
export const assertModelAllowed = (caller: Caller, model: string): Effect.Effect<void, ClientError> => {
  if (caller.allowed_models.length === 0) return Effect.void
  if (caller.allowed_models.includes(model)) return Effect.void
  return Effect.fail(
    forbidden(`this API key may not use model "${model}"; allowed: ${caller.allowed_models.join(", ")}`)
  )
}

/**
 * Sliding-window rate limiter keyed by client API key.
 *
 * Only the timestamps inside the current window are kept, so memory is bounded by
 * the number of active keys rather than by request volume.
 */
const windows = new Map<string, number[]>()

export const rateLimiter = (key: string, limitPerMinute: number): Effect.Effect<void, ClientError> => {
  if (limitPerMinute <= 0) return Effect.void

  const now = Date.now()
  const cutoff = now - 60_000
  const recent = (windows.get(key) ?? []).filter((ts) => ts > cutoff)

  if (recent.length >= limitPerMinute) {
    const oldest = recent[0] ?? now
    const retryAfter = Math.max(1, Math.ceil((oldest + 60_000 - now) / 1000))
    windows.set(key, recent)
    return Effect.fail(
      rateLimited(`rate limit of ${limitPerMinute} requests/minute exceeded; retry in ${retryAfter}s`)
    )
  }

  recent.push(now)
  windows.set(key, recent)
  return Effect.void
}

/** Identity used as the rate-limit bucket for a caller. */
export const limiterKeyFor = (caller: Caller, clientIp: string | null): string =>
  caller.id === null ? `ip:${clientIp ?? "unknown"}` : `key:${caller.id}`

/** Look up the rate limit configured for a caller's key. */
export const rateLimitFor = (
  caller: Caller
): Effect.Effect<number, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    if (caller.id === null) return 0
    const sql = yield* SqlClient.SqlClient
    const keys = yield* Effect.orDie(
      sql<{ rate_limit_rpm: number }>`SELECT rate_limit_rpm FROM api_keys WHERE id = ${caller.id}`
    )
    return keys[0]?.rate_limit_rpm ?? 0
  })

/** Validate that a request body carried a usable `model`. */
export const requireModel = (body: Record<string, unknown>): Effect.Effect<string, ClientError> => {
  const model = body.model
  if (typeof model !== "string" || model.trim() === "") {
    return Effect.fail(badRequest("`model` is required and must be a non-empty string", "model"))
  }
  return Effect.succeed(model)
}
