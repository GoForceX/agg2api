/**
 * Application entry point.
 *
 * Boot order is enforced by the layering rather than by sequencing code: settings
 * load from file and environment, the database opens and migrates, then the HTTP
 * server starts. Boot failures are fatal — a gateway that comes up with an
 * unreadable database or a port it does not own would fail every request anyway,
 * and failing loudly is far easier to diagnose than failing per-request.
 */
import { BunFileSystem } from "@effect/platform-bun"
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as FetchHttpClient from "@effect/platform/FetchHttpClient"
import * as HttpApiBuilder from "@effect/platform/HttpApiBuilder"
import * as HttpServer from "@effect/platform/HttpServer"
import * as SqlClient from "@effect/sql/SqlClient"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schedule from "effect/Schedule"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { load, type Settings } from "./config.ts"
import { liveLayer } from "./db/database.ts"
import { listProviders } from "./db/providers.ts"
import { purgeOlderThan } from "./db/usage.ts"
import { discoverAll, refreshCredits } from "./gateway/discovery.ts"
import { Sessions, makeSessionStore } from "./gateway/sessions.ts"
import { AppSettings, StartedAt } from "./gateway/settings.ts"
import { adminHandlers } from "./http/admin/handlers.ts"
import { adminAuthLayer } from "./http/admin/auth.ts"
import { adminMiddleware } from "./http/admin/middleware.ts"
import { api } from "./http/api.ts"
import { opsHandlers, v1Handlers } from "./http/handlers-v1.ts"

/**
 * Locate the built admin UI.
 *
 * `import.meta.dir` is the source directory under `bun run` but an internal virtual
 * path inside a compiled binary, so it cannot be the only candidate. The working
 * directory is checked first because launching from the project root is the normal
 * case for both a source run and the compiled binary; `web_root` overrides everything.
 */
const defaultWebRoot = (): string => {
  const candidates = [
    resolve(process.cwd(), "web", "dist"),
    resolve(import.meta.dir, "..", "web", "dist")
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return candidates[0] as string
}

/** Read `--config <path>` from argv, falling back to an environment variable. */
const configPath = (): string | null => {
  const args = process.argv.slice(2)
  const index = args.indexOf("--config")
  if (index >= 0 && args[index + 1] !== undefined) return args[index + 1] as string
  return process.env["AGG2API_CONFIG"] ?? null
}

/**
 * Background maintenance: model discovery, credit refresh and log retention.
 *
 * These share one scheduled fiber rather than owning separate timers, because they
 * refresh the same upstream metadata and a single pass is easier to reason about
 * than three interleaving ones. Failures are logged and retried next tick: a
 * gateway serving from a slightly stale catalogue beats one that exits because a
 * provider was briefly unreachable.
 */
const maintenance = Effect.gen(function* () {
  const settings = yield* AppSettings
  const sql = yield* SqlClient.SqlClient

  const pass = Effect.gen(function* () {
    const results = yield* discoverAll()
    for (const result of results) {
      if (result.error !== null) {
        yield* Effect.logWarning("model discovery failed", {
          provider_id: result.provider_id,
          error: result.error
        })
      }
    }
    const added = results.flatMap((result) => result.created)
    const removed = results.flatMap((result) => result.removed)
    if (added.length + removed.length > 0) {
      yield* Effect.logInfo("model discovery updated the catalogue", { added, removed })
    }

    const providers = yield* listProviders(sql).pipe(Effect.orDie)
    for (const provider of providers) {
      if (provider.kind !== "workbuddy2api" || !provider.enabled) continue
      const credits = yield* refreshCredits(provider)
      if (credits.error !== null) {
        yield* Effect.logWarning("credit refresh failed", {
          provider_id: provider.id,
          error: credits.error
        })
      }
    }
  })

  const prune = Effect.gen(function* () {
    if (settings.log_retention_days <= 0) return
    const removed = yield* purgeOlderThan(
      sql,
      Date.now() - settings.log_retention_days * 86_400_000
    ).pipe(Effect.orDie)
    if (removed > 0) {
      yield* Effect.logInfo("pruned usage log", {
        removed,
        retention_days: settings.log_retention_days
      })
    }
  })

  if (settings.discovery_interval_s > 0) {
    yield* pass.pipe(
      Effect.catchAllCause((cause) => Effect.logWarning("discovery pass failed", cause)),
      Effect.repeat(Schedule.spaced(`${settings.discovery_interval_s} seconds`)),
      Effect.forkScoped
    )
  }

  yield* prune.pipe(
    Effect.catchAllCause((cause) => Effect.logWarning("usage pruning failed", cause)),
    Effect.repeat(Schedule.spaced("1 hours")),
    Effect.forkScoped
  )
})

/**
 * The whole application as one layer.
 *
 * Requirements are satisfied by an explicit `provide` chain rather than by
 * `Layer.mergeAll`, which combines *outputs* without feeding one member into
 * another's requirements. `provideMerge` is used for the HTTP server so its
 * `HttpServer` stays in the output — the program needs it to read the bound port.
 */
const coreLayers = (settings: Settings) =>
  Layer.mergeAll(
    Layer.succeed(AppSettings, settings),
    Layer.succeed(StartedAt, Date.now()),
    Layer.succeed(
      Sessions,
      makeSessionStore({ ttl_ms: settings.session_ttl_ms, max_entries: settings.session_max_entries })
    ),
    FetchHttpClient.layer
  )

const application = (settings: Settings) => {
  // `??` alone is not enough: an empty string is "present" and would resolve to the
  // process working directory, exposing the database and repository files through the
  // unauthenticated /admin/* mount.
  const webRoot = settings.web_root !== null && settings.web_root.trim() !== "" ? settings.web_root : defaultWebRoot()

  const core = coreLayers(settings)

  // `provideMerge` rather than `provide` throughout: the program itself needs
  // AppSettings, SqlClient, HttpClient and HttpServer, which plain `provide` would
  // consume and hide.
  return HttpApiBuilder.serve(
    adminMiddleware({ web_root: webRoot })
  ).pipe(
    Layer.provide(HttpApiBuilder.api(api)),
    // The admin group's middleware is resolved when its routes are built, so the guard
    // is supplied to the group layers rather than to the server.
    Layer.provide(
      Layer.mergeAll(v1Handlers, opsHandlers, adminHandlers).pipe(
        Layer.provide(adminAuthLayer(settings.admin_token))
      )
    ),
    Layer.provideMerge(core),
    Layer.provideMerge(liveLayer(settings.db_path)),
    Layer.provideMerge(BunHttpServer.layer({ hostname: settings.host, port: settings.port }))
  )
}

/** Announce the bound address, then idle. The server runs on its own fibers. */
const program = (settings: Settings) =>
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer
    const port = server.address._tag === "TcpAddress" ? server.address.port : settings.port

    yield* maintenance

    yield* Effect.logInfo(`agg2api listening on http://${settings.host}:${port}`)
    yield* Effect.logInfo(`admin UI: http://127.0.0.1:${port}/admin/`)
    if (settings.admin_token === "") {
      yield* Effect.logWarning("admin_token is empty: the admin API is unauthenticated")
    }
    if (!settings.require_client_key) {
      yield* Effect.logInfo("/v1 accepts anonymous requests (set require_client_key to enforce keys)")
    }

    yield* Effect.never
  })

/** Load settings, then boot. Settings must resolve before the database layer. */
const boot = Effect.gen(function* () {
  const settings = yield* load({ path: configPath(), env: process.env }).pipe(
    Effect.provide(BunFileSystem.layer)
  )
  return yield* program(settings).pipe(Effect.provide(application(settings)), Effect.scoped)
})

BunRuntime.runMain(
  boot.pipe(
    Effect.catchAllCause((cause) =>
      Effect.logError("agg2api failed to start", cause).pipe(
        Effect.zipRight(Effect.sync(() => process.exit(1)))
      )
    )
  )
)
