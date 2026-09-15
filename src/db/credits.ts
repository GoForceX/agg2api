/**
 * workbuddy2api credit snapshots.
 *
 * Credits are the whole reason this gateway knows about workbuddy2api at all: the
 * upstream is a pool of funded accounts, and an operator needs to see how much
 * budget is left and which accounts are cooling. The snapshot is stored rather
 * than fetched on demand so the dashboard stays fast and keeps working when the
 * upstream is unreachable — the timestamp and `error` field make staleness
 * visible instead of silent.
 */
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as SqlClient from "@effect/sql/SqlClient"
import type { SqlError } from "@effect/sql/SqlError"
import type { Credits, CreditsAccount } from "../domain.ts"
import { fromJsonObject } from "./support.ts"
import { asBoolean, asNumber, asRecordArray, asString } from "../json.ts"

interface CreditsRow {
  readonly provider_id: number
  readonly payload: string
  readonly fetched_at: number
  readonly error: string | null
}

const toCredits = (row: CreditsRow): Credits => {
  const payload = fromJsonObject(row.payload)
  const accounts = asRecordArray(payload.accounts).map(toAccount)
  return {
    provider_id: row.provider_id,
    total: asNumber(payload.total) ?? accounts.reduce((sum, account) => sum + account.credits, 0),
    healthy: asNumber(payload.healthy) ?? accounts.length,
    accounts,
    fetched_at: row.fetched_at,
    error: row.error
  }
}

const toAccount = (raw: Record<string, unknown>): CreditsAccount => ({
  uid: asString(raw.uid) ?? asString(raw.id) ?? "unknown",
  nickname: asString(raw.nickname) ?? undefined,
  realm: asString(raw.realm) ?? undefined,
  credits: asNumber(raw.credits) ?? 0,
  cooling: asBoolean(raw.cooling) ?? undefined,
  disabled: asBoolean(raw.disabled) ?? undefined,
  disabled_reason: asString(raw.disabled_reason) ?? undefined
})

export const getCredits = (
  sql: SqlClient.SqlClient,
  providerId: number
): Effect.Effect<Option.Option<Credits>, SqlError> =>
  sql<CreditsRow>`SELECT provider_id, payload, fetched_at, error FROM credits_snapshot WHERE provider_id = ${providerId}`.pipe(
    Effect.map((rows) => Option.map(Option.fromNullable(rows[0]), toCredits))
  )

export const listCredits = (
  sql: SqlClient.SqlClient
): Effect.Effect<ReadonlyArray<Credits>, SqlError> =>
  sql<CreditsRow>`SELECT provider_id, payload, fetched_at, error FROM credits_snapshot`.pipe(
    Effect.map((rows) => rows.map(toCredits))
  )

/**
 * Store the latest snapshot for a provider.
 *
 * Overwrites unconditionally: the snapshot is a point-in-time view, and keeping
 * history would double the storage for no operator benefit — the usage log is
 * where history lives.
 */
export const saveCredits = (
  sql: SqlClient.SqlClient,
  providerId: number,
  snapshot: {
    total: number
    healthy: number
    accounts: ReadonlyArray<CreditsAccount>
    fetched_at: number
    error: string | null
  }
): Effect.Effect<void, SqlError> =>
  Effect.asVoid(sql`
    INSERT INTO credits_snapshot (provider_id, payload, fetched_at, error)
    VALUES (
      ${providerId},
      ${JSON.stringify({ total: snapshot.total, healthy: snapshot.healthy, accounts: snapshot.accounts })},
      ${snapshot.fetched_at},
      ${snapshot.error}
    )
    ON CONFLICT (provider_id) DO UPDATE SET
      payload = excluded.payload,
      fetched_at = excluded.fetched_at,
      error = excluded.error
  `)

export const deleteCredits = (
  sql: SqlClient.SqlClient,
  providerId: number
): Effect.Effect<void, SqlError> =>
  Effect.asVoid(sql`DELETE FROM credits_snapshot WHERE provider_id = ${providerId}`)
