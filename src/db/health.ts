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

/** Breaker cooldown policy, as configured. `threshold <= 0` disables the breaker. */
export interface BreakerPolicy {
  readonly threshold: number
  readonly base_ms: number
  readonly max_ms: number
}

/**
 * How long a provider stays out of rotation after its `consecutiveFailures`-th
 * failure, or `0` to leave the breaker closed.
 *
 * Exponential in the count so a provider that is briefly flapping recovers quickly,
 * while one that is genuinely down is retried rarely. Capped so a provider is never
 * permanently abandoned.
 *
 * The count is compared here, *after* incrementing, rather than at the point a
 * candidate is skipped. A skip test of `open_until > now` alone treats every failure
 * as fatal unless `open_until` is held at 0 below the threshold — and then one unlucky
 * attempt would take a healthy provider out for the whole cooldown, which is how a
 * single flaky call removes a provider for every caller at once.
 */
export const breakerDeadline = (consecutiveFailures: number, policy: BreakerPolicy): number => {
  if (policy.threshold <= 0) return 0
  if (consecutiveFailures < policy.threshold) return 0
  // The exponent counts failures *past* the threshold, so the first trip waits
  // `base_ms` rather than `base_ms * 2^threshold`.
  const exponent = Math.min(consecutiveFailures - policy.threshold, 16)
  return now() + Math.min(policy.max_ms, policy.base_ms * 2 ** exponent)
}

/**
 * Record a failed call, opening the breaker once the policy's threshold is reached.
 *
 * The previous `last_error`/`last_error_at` are always refreshed, including on a
 * failure that leaves the breaker closed, so the UI can show the most recent reason a
 * provider degraded even when it has not been taken out of rotation.
 *
 * The failure count is read and written here, in one place, because the deadline
 * depends on the incremented count: computing it from a caller-supplied count would
 * let two concurrent failures against one provider both observe the old value and
 * both decline to trip.
 */
export const recordFailure = (
  sql: SqlClient.SqlClient,
  providerId: number,
  error: string,
  policy: BreakerPolicy
): Effect.Effect<void, SqlError> =>
  // Both statements run in one transaction. The deadline is a function of the
  // *incremented* count, and this is the only place that count is known: reading it
  // first and writing it back would let two concurrent failures against one provider
  // both observe the old value, so neither would trip the breaker.
  sql.withTransaction(
    Effect.gen(function* () {
      const rows = yield* sql<{ readonly consecutive_failures: number }>`
        INSERT INTO provider_health (provider_id, consecutive_failures, open_until, last_error, last_error_at)
        VALUES (${providerId}, 1, 0, ${error}, ${now()})
        ON CONFLICT (provider_id) DO UPDATE SET
          consecutive_failures = provider_health.consecutive_failures + 1,
          last_error = excluded.last_error,
          last_error_at = excluded.last_error_at
        RETURNING consecutive_failures
      `
      const failures = rows[0]?.consecutive_failures ?? 1
      yield* sql`
        UPDATE provider_health
        SET open_until = ${breakerDeadline(failures, policy)}
        WHERE provider_id = ${providerId}
      `
    })
  )

/** Clear breaker state for a provider, e.g. after an operator fixes its credentials. */
export const resetProviderHealth = (
  sql: SqlClient.SqlClient,
  providerId: number
): Effect.Effect<void, SqlError> =>
  Effect.asVoid(sql`DELETE FROM provider_health WHERE provider_id = ${providerId}`)
