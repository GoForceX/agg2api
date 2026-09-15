/**
 * Client API-key storage.
 *
 * Keys authenticate `/v1/*` callers. The secret is stored in plaintext because it
 * must be comparable on every request, so the protection is that the value never
 * leaves the server: every read path except `getKeyByValue`/`getKey` returns a
 * masked form instead.
 */
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as SqlClient from "@effect/sql/SqlClient"
import type { SqlError } from "@effect/sql/SqlError"
import type { ApiKey, ApiKeyInput, ApiKeyMasked } from "../domain.ts"
import { asBool, bool, fromJsonStrings, now, toJson } from "./support.ts"
import { rowCount } from "./write.ts"

interface KeyRow {
  readonly id: number
  readonly name: string
  readonly key: string
  readonly enabled: number
  readonly rate_limit_rpm: number
  readonly allowed_models: string
  readonly created_at: number
  readonly last_used_at: number
  readonly total_requests: number
}

const toKey = (row: KeyRow): ApiKey => ({
  id: row.id,
  name: row.name,
  key: row.key,
  enabled: asBool(row.enabled),
  rate_limit_rpm: row.rate_limit_rpm,
  allowed_models: fromJsonStrings(row.allowed_models),
  created_at: row.created_at,
  last_used_at: row.last_used_at,
  total_requests: row.total_requests
})

/**
 * Reveal enough of a key to identify it in a list without exposing it.
 *
 * The prefix is useful (it identifies the key's origin) but the suffix alone is
 * not recoverable, and short keys are masked entirely so a stray short value can
 * never be reconstructed from the list view.
 */
export const maskKey = (key: string): string =>
  key.length <= 10 ? "…" : `${key.slice(0, 6)}…${key.slice(-4)}`

const toMasked = (row: KeyRow): ApiKeyMasked => ({
  id: row.id,
  name: row.name,
  masked: maskKey(row.key),
  enabled: asBool(row.enabled),
  rate_limit_rpm: row.rate_limit_rpm,
  allowed_models: fromJsonStrings(row.allowed_models),
  created_at: row.created_at,
  last_used_at: row.last_used_at,
  total_requests: row.total_requests
})

const KEY_COLUMNS = `id, name, key, enabled, rate_limit_rpm, allowed_models,
  created_at, last_used_at, total_requests`

export const listKeys = (
  sql: SqlClient.SqlClient
): Effect.Effect<ReadonlyArray<ApiKeyMasked>, SqlError> =>
  sql<KeyRow>`SELECT ${sql.unsafe(KEY_COLUMNS)} FROM api_keys ORDER BY id DESC`.pipe(
    Effect.map((rows) => rows.map(toMasked))
  )

/** Look up a key by its secret. This is the hot path for every `/v1` request. */
export const getKeyByValue = (
  sql: SqlClient.SqlClient,
  key: string
): Effect.Effect<Option.Option<ApiKey>, SqlError> =>
  sql<KeyRow>`SELECT ${sql.unsafe(KEY_COLUMNS)} FROM api_keys WHERE key = ${key}`.pipe(
    Effect.map((rows) => Option.map(Option.fromNullable(rows[0]), toKey))
  )

export const getKey = (
  sql: SqlClient.SqlClient,
  id: number
): Effect.Effect<Option.Option<ApiKey>, SqlError> =>
  sql<KeyRow>`SELECT ${sql.unsafe(KEY_COLUMNS)} FROM api_keys WHERE id = ${id}`.pipe(
    Effect.map((rows) => Option.map(Option.fromNullable(rows[0]), toKey))
  )

export const countKeys = (sql: SqlClient.SqlClient): Effect.Effect<number, SqlError> =>
  Effect.map(
    sql<{ count: number }>`SELECT COUNT(*) AS count FROM api_keys`,
    (rows) => rows[0]?.count ?? 0
  )

/** Generate a key with enough entropy that guessing it is not a concern. */
export const generateKey = (): string =>
  `sk-agg-${[...crypto.getRandomValues(new Uint8Array(16))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`

export const createKey = (
  sql: SqlClient.SqlClient,
  input: ApiKeyInput
): Effect.Effect<ApiKey, SqlError> =>
  Effect.gen(function* () {
    const key = input.key ?? generateKey()
    const ts = now()
    const rows = yield* sql<{ id: number }>`
      INSERT INTO api_keys (name, key, enabled, rate_limit_rpm, allowed_models, created_at, last_used_at, total_requests)
      VALUES (${input.name}, ${key}, ${bool(input.enabled ?? true)}, ${input.rate_limit_rpm ?? 0},
              ${toJson(input.allowed_models ?? [])}, ${ts}, 0, 0)
      RETURNING id
    `
    const created = yield* getKey(sql, rows[0]?.id ?? 0)
    return yield* Option.match(created, {
      onNone: () => Effect.die(new Error("key vanished immediately after insert")),
      onSome: (value) => Effect.succeed(value)
    })
  })

export const updateKey = (
  sql: SqlClient.SqlClient,
  id: number,
  patch: Partial<ApiKeyInput>
): Effect.Effect<Option.Option<ApiKey>, SqlError> =>
  Effect.gen(function* () {
    const assignments: Array<readonly [string, unknown]> = []
    if (patch.name !== undefined) assignments.push(["name", patch.name] as const)
    if (patch.key !== undefined) assignments.push(["key", patch.key] as const)
    if (patch.enabled !== undefined) assignments.push(["enabled", bool(patch.enabled)] as const)
    if (patch.rate_limit_rpm !== undefined) {
      assignments.push(["rate_limit_rpm", patch.rate_limit_rpm] as const)
    }
    if (patch.allowed_models !== undefined) {
      assignments.push(["allowed_models", toJson(patch.allowed_models)] as const)
    }
    if (assignments.length > 0) {
      yield* sql.unsafe(
        `UPDATE api_keys SET ${assignments.map(([column]) => `${column} = ?`).join(", ")} WHERE id = ?`,
        [...assignments.map(([, value]) => value), id]
      )
    }
    return yield* getKey(sql, id)
  })

export const deleteKey = (
  sql: SqlClient.SqlClient,
  id: number
): Effect.Effect<number, SqlError> =>
  rowCount(sql`DELETE FROM api_keys WHERE id = ${id} RETURNING id`)

/**
 * Record a successful authenticated request.
 *
 * Deliberately fire-and-forget: this runs on every request and its failure is not
 * worth failing an otherwise successful completion for.
 */
export const touchKey = (sql: SqlClient.SqlClient, id: number): Effect.Effect<void, SqlError> =>
  Effect.asVoid(
    sql`UPDATE api_keys SET last_used_at = ${now()}, total_requests = total_requests + 1 WHERE id = ${id}`
  )
