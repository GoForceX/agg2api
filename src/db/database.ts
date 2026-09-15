/**
 * Database layer.
 *
 * Two things here are easy to get wrong and produce failures that look unrelated
 * to their cause:
 *
 * 1. **One connection per database.** SQLite's `:memory:` gives *every new
 *    connection its own empty database*. Building the client layer and then
 *    providing it to a separate migration layer therefore migrates one connection
 *    and serves queries from another, yielding "no such table" at the first query.
 *    Both `layer` and `testLayer` build one client and reuse it for everything.
 *
 * 2. **Migrations are embedded, not loaded from disk.** The gateway compiles to a
 *    single binary with no migrations directory beside it, so `@effect/sql`'s
 *    file-based Migrator would only add `Path`/`CommandExecutor` requirements for
 *    reading files that are already in memory.
 */
import { BunFileSystem } from "@effect/platform-bun"
import * as FileSystem from "@effect/platform/FileSystem"
import * as SqlClient from "@effect/sql/SqlClient"
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { dirname } from "node:path"
import { migrations } from "./migrations.ts"

/**
 * PRAGMAs that matter for a gateway.
 *
 * WAL lets the discovery loop write while requests read, which matters because
 * every request appends usage. `busy_timeout` turns lock contention into a short
 * wait instead of an immediate `SQLITE_BUSY`. `foreign_keys` is OFF by default in
 * SQLite and the schema relies on it for cascade deletes.
 */
const PRAGMAS = [
  "PRAGMA journal_mode = WAL",
  "PRAGMA synchronous = NORMAL",
  "PRAGMA busy_timeout = 5000",
  "PRAGMA foreign_keys = ON"
]

/**
 * Apply PRAGMAs and pending migrations on the given connection.
 *
 * Each migration runs in its own transaction, so a failure leaves the recorded
 * version untouched and the next start retries from a consistent state.
 */
const migrate = (filename: string): Effect.Effect<void, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    // `:memory:` has no WAL and rejects the pragma on some builds, so only the
    // file-backed case sets journal-related options.
    const pragmas = filename === ":memory:" ? ["PRAGMA foreign_keys = ON"] : PRAGMAS
    for (const pragma of pragmas) {
      yield* sql.unsafe(pragma)
    }

    yield* sql.unsafe(
      `CREATE TABLE IF NOT EXISTS agg2api_migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      )`
    )

    const applied = yield* sql<{ id: number }>`SELECT id FROM agg2api_migrations`
    const done = new Set(applied.map((row) => row.id))

    for (const migration of migrations) {
      if (done.has(migration.id)) continue
      yield* sql.withTransaction(
        Effect.gen(function* () {
          for (const statement of migration.statements) {
            yield* sql.unsafe(statement)
          }
          yield* sql`INSERT INTO agg2api_migrations (id, name, applied_at)
            VALUES (${migration.id}, ${migration.name}, ${Date.now()})`
        })
      )
    }
  }).pipe(Effect.orDie)

/** Create the parent directory so a fresh checkout can start without manual setup. */
const prepareDirectory = (filename: string) =>
  Effect.gen(function* () {
    if (filename === ":memory:" || filename.startsWith("file:")) return
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(dirname(filename), { recursive: true }).pipe(Effect.orDie)
  })

/**
 * Live database backed by `filename`.
 *
 * Migration runs during layer construction, so anything holding a `SqlClient` is
 * guaranteed to be talking to a migrated schema.
 */
export const layer = (
  filename: string
): Layer.Layer<SqlClient.SqlClient, never, FileSystem.FileSystem> =>
  Layer.unwrapEffect(
    Effect.map(prepareDirectory(filename), () => {
      const client = Layer.orDie(SqliteClient.layer({ filename }))
      const migrated = Layer.effectDiscard(migrate(filename)).pipe(Layer.provide(client))
      return Layer.merge(client, migrated)
    })
  )

/** In-memory database with the same schema. Used by tests and smoke scripts. */
export const testLayer: Layer.Layer<SqlClient.SqlClient> = Layer.unwrapEffect(
  Effect.map(prepareDirectory(":memory:"), () => {
    const client = Layer.orDie(SqliteClient.layer({ filename: ":memory:" }))
    const migrated = Layer.effectDiscard(migrate(":memory:")).pipe(Layer.provide(client))
    return Layer.merge(client, migrated)
  })
).pipe(Layer.provide(BunFileSystem.layer))

/** Run an effect against a fresh in-memory database. */
export const withTestDatabase = <A, E>(
  effect: Effect.Effect<A, E, SqlClient.SqlClient>
): Effect.Effect<A, E> => effect.pipe(Effect.provide(testLayer))

/** The filesystem-backed database used by the running server. */
export const liveLayer = (filename: string): Layer.Layer<SqlClient.SqlClient> =>
  Layer.provide(layer(filename), BunFileSystem.layer)
