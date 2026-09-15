/**
 * Write-statement helpers.
 *
 * A failing write is a programmer error — a missing migration, a column renamed
 * without updating its query — rather than a condition the caller can recover
 * from. These wrappers let repository code express that once instead of every call
 * site spraying `orDie`/`asVoid`.
 */
import * as Effect from "effect/Effect"
import type { SqlError } from "@effect/sql/SqlError"
import type { Statement } from "@effect/sql/Statement"

export const insertRow = (statement: Statement<unknown>): Effect.Effect<void, SqlError> =>
  Effect.asVoid(statement)

/**
 * Rows affected by a write.
 *
 * Counts returned rows, so callers must append `RETURNING id`. That is deliberate:
 * the driver does not surface SQLite's `changes()` for a statement that returns no
 * rows, so relying on a `changes` column silently reports 0 for every DELETE and
 * makes "not found" indistinguishable from "deleted the wrong thing" — which is
 * exactly the bug this helper exists to prevent.
 */
export const rowCount = (statement: Statement<unknown>): Effect.Effect<number, SqlError> =>
  Effect.map(statement, (rows) => rows.length)
