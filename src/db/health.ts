/**
 * Provider health and circuit-breaker state.
 *
 * The breaker is what stops a dead provider from being retried by every request.
 * State is persisted rather than in-memory so a restart does not immediately
 * hammer an upstream that was already known to be failing.
 */
import * as Effect from "effect/Effect"
import * as SqlClient from "@effect/sql/SqlClient"
import type { SqlError } from "@effect/sql/SqlError"
import type { ProviderStatus } from "../domain.ts"
import { EMPTY_STATUS } from "../domain.ts"
import { now } from "./support.ts"

interface StatusRow {
  readonly provider_id: number
  readonly consecutive_failures: number
  readonly open_until: number
  readonly last_error: string | null
  readonly last_error_at: number
  readonly last_success_at: number
  readonly last_latency_ms: number
}

const toStatus = (row: StatusRow): ProviderStatus => ({
  provider_id: row.provider_id,
  consecutive_failures: row.consecutive_failures,
  open_until: row.open_until,
  last_error: row.last_error,
  last_error_at: row.last_error_at,
  last_success_at: row.last_success_at,
  last_latency_ms: row.last_latency_ms
})

const STATUS_COLUMNS = `provider_id, consecutive_failures, open_until, last_error,
  last_error_at, last_success_at, last_latency_ms`

/**
 * Breaker state for one provider.
 *
 * A provider that has never succeeded and never failed has no row; reporting
 * `EMPTY_STATUS` (closed, zero failures) is the correct default rather than an
 * error, because a healthy but unused provider is indistinguishable from one that
 * was just added.
 */
export const getProviderStatus = (
  sql: SqlClient.SqlClient,
  providerId: number
): Effect.Effect<ProviderStatus, SqlError> =>
  sql<StatusRow>`SELECT ${sql.unsafe(STATUS_COLUMNS)} FROM provider_health WHERE provider_id = ${providerId}`.pipe(
    Effect.map((rows) => {
      const row = rows[0]
      return row === undefined ? { ...EMPTY_STATUS, provider_id: providerId } : toStatus(row)
    })
  )

export const listProviderStatuses = (
  sql: SqlClient.SqlClient
): Effect.Effect<ReadonlyArray<ProviderStatus>, SqlError> =>
  sql<StatusRow>`SELECT ${sql.unsafe(STATUS_COLUMNS)} FROM provider_health`.pipe(
    Effect.map((rows) => rows.map(toStatus))
  )

/**
 * Record a successful call, closing the breaker.
 *
 * Latency is stored only on success because it is displayed as "how fast is this
 * provider when it works"; averaging failures into it would make a flapping
 * provider look slow rather than broken.
 */
export const recordSuccess = (
  sql: SqlClient.SqlClient,
  providerId: number,
  latencyMs: number
): Effect.Effect<void, SqlError> =>
  Effect.asVoid(sql`
    INSERT INTO provider_health (provider_id, consecutive_failures, open_until, last_success_at, last_latency_ms)
    VALUES (${providerId}, 0, 0, ${now()}, ${latencyMs})
    ON CONFLICT (provider_id) DO UPDATE SET
      consecutive_failures = 0,
      open_until = 0,
      last_success_at = excluded.last_success_at,
      last_latency_ms = excluded.last_latency_ms
  `)

/**
 * Record a failed call and open the breaker until `openUntil`.
 *
 * The previous `last_error`/`last_error_at` are always refreshed, including on a
 * failure that leaves the breaker closed, so the UI can show the most recent
 * reason a provider degraded even when it has not been taken out of rotation.
 */
export const recordFailure = (
  sql: SqlClient.SqlClient,
  providerId: number,
  error: string,
  openUntil: number
): Effect.Effect<void, SqlError> =>
  Effect.asVoid(sql`
    INSERT INTO provider_health (provider_id, consecutive_failures, open_until, last_error, last_error_at)
    VALUES (${providerId}, 1, ${openUntil}, ${error}, ${now()})
    ON CONFLICT (provider_id) DO UPDATE SET
      consecutive_failures = provider_health.consecutive_failures + 1,
      open_until = excluded.open_until,
      last_error = excluded.last_error,
      last_error_at = excluded.last_error_at
  `)

/** Clear breaker state for a provider, e.g. after an operator fixes its credentials. */
export const resetProviderHealth = (
  sql: SqlClient.SqlClient,
  providerId: number
): Effect.Effect<void, SqlError> =>
  Effect.asVoid(sql`DELETE FROM provider_health WHERE provider_id = ${providerId}`)
