/**
 * Route storage.
 *
 * A route maps one public model name onto the providers that can serve it. This
 * is what the operator curates when they want several upstreams behind one name,
 * and what `syncRoutes` builds automatically from discovery.
 */
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as SqlClient from "@effect/sql/SqlClient"
import type { SqlError } from "@effect/sql/SqlError"
import type { Provider, Route, RouteInput, RouteTarget, RoutingStrategy } from "../domain.ts"
import { asBool, bool, now } from "./support.ts"
import { rowCount } from "./write.ts"
import { listProviders } from "./providers.ts"

interface RouteRow {
  readonly public_model: string
  readonly strategy: string | null
  readonly enabled: number
  readonly display_name: string | null
  readonly created_at: number
  readonly updated_at: number
}

interface TargetRow {
  readonly public_model: string
  readonly provider_id: number
  readonly upstream_model: string
  readonly priority: number
  readonly enabled: number
}

const isStrategy = (value: string | null): value is RoutingStrategy =>
  value === "priority" || value === "weighted"

/**
 * Load routes, optionally restricted to one public model.
 *
 * Targets are fetched per route rather than joined into the same query: joining
 * would duplicate the route row per target and force the caller to regroup.
 */
const loadRoutes = (
  sql: SqlClient.SqlClient,
  publicModel: string | null
): Effect.Effect<ReadonlyArray<Route>, SqlError> =>
  Effect.gen(function* () {
    const rows =
      publicModel === null
        ? yield* sql<RouteRow>`SELECT public_model, strategy, enabled, display_name, created_at, updated_at
            FROM routes ORDER BY public_model`
        : yield* sql<RouteRow>`SELECT public_model, strategy, enabled, display_name, created_at, updated_at
            FROM routes WHERE public_model = ${publicModel}`

    const out: Route[] = []
    for (const row of rows) {
      const targets = yield* sql<TargetRow>`SELECT public_model, provider_id, upstream_model, priority, enabled
        FROM route_targets WHERE public_model = ${row.public_model}
        ORDER BY priority DESC, provider_id ASC, upstream_model ASC`
      out.push({
        public_model: row.public_model,
        strategy: isStrategy(row.strategy) ? row.strategy : null,
        enabled: asBool(row.enabled),
        display_name: row.display_name,
        targets: targets.map(
          (target): RouteTarget => ({
            provider_id: target.provider_id,
            upstream_model: target.upstream_model,
            priority: target.priority,
            enabled: asBool(target.enabled)
          })
        ),
        created_at: row.created_at,
        updated_at: row.updated_at
      })
    }
    return out
  })

export const listRoutes = (
  sql: SqlClient.SqlClient
): Effect.Effect<ReadonlyArray<Route>, SqlError> => loadRoutes(sql, null)

export const getRoute = (
  sql: SqlClient.SqlClient,
  publicModel: string
): Effect.Effect<Option.Option<Route>, SqlError> =>
  Effect.map(loadRoutes(sql, publicModel), (routes) => Option.fromNullable(routes[0]))

export const countRoutes = (sql: SqlClient.SqlClient): Effect.Effect<number, SqlError> =>
  Effect.map(
    sql<{ count: number }>`SELECT COUNT(*) AS count FROM routes`,
    (rows) => rows[0]?.count ?? 0
  )

/** Write `route_targets` for one public model, replacing whatever was there. */
const replaceTargets = (
  sql: SqlClient.SqlClient,
  publicModel: string,
  targets: ReadonlyArray<RouteTarget>
): Effect.Effect<void, SqlError> =>
  Effect.gen(function* () {
    yield* sql`DELETE FROM route_targets WHERE public_model = ${publicModel}`
    for (const target of targets) {
      yield* sql`
        INSERT INTO route_targets (public_model, provider_id, upstream_model, priority, enabled)
        VALUES (${publicModel}, ${target.provider_id}, ${target.upstream_model},
                ${target.priority}, ${bool(target.enabled)})
        ON CONFLICT (public_model, provider_id, upstream_model) DO UPDATE SET
          priority = excluded.priority,
          enabled = excluded.enabled
      `
    }
  })

/**
 * Create or replace a route.
 *
 * Upsert rather than insert-only: the admin UI's "add route" and the automatic
 * sync both address a route by its public model, and having one of them fail on a
 * duplicate key would make the UI depend on whether sync had already run.
 */
export const createRoute = (
  sql: SqlClient.SqlClient,
  input: RouteInput
): Effect.Effect<Route, SqlError> =>
  // One transaction: the upsert and the target replacement are a single logical write,
  // and `replaceTargets` deletes before it inserts. Without this, a failure part-way
  // through leaves the route committed with its targets already deleted — an enabled
  // route that serves nothing while reporting a 500.
  Effect.gen(function* () {
    const ts = now()
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          INSERT INTO routes (public_model, strategy, enabled, display_name, created_at, updated_at)
          VALUES (${input.public_model}, ${input.strategy ?? null}, ${bool(input.enabled ?? true)},
                  ${input.display_name ?? null}, ${ts}, ${ts})
          ON CONFLICT (public_model) DO UPDATE SET
            strategy = excluded.strategy,
            enabled = excluded.enabled,
            display_name = excluded.display_name,
            updated_at = excluded.updated_at
        `
        yield* replaceTargets(sql, input.public_model, input.targets)
      })
    )
    const created = yield* getRoute(sql, input.public_model)
    return yield* Option.match(created, {
      onNone: () => Effect.die(new Error("route vanished immediately after upsert")),
      onSome: (route) => Effect.succeed(route)
    })
  })

export const updateRoute = (
  sql: SqlClient.SqlClient,
  publicModel: string,
  patch: Partial<RouteInput>
): Effect.Effect<Option.Option<Route>, SqlError> =>
  Effect.gen(function* () {
    const existing = yield* getRoute(sql, publicModel)
    if (Option.isNone(existing)) return Option.none()

    const assignments: Array<readonly [string, unknown]> = []
    if (patch.strategy !== undefined) assignments.push(["strategy", patch.strategy] as const)
    if (patch.enabled !== undefined) assignments.push(["enabled", bool(patch.enabled)] as const)
    if (patch.display_name !== undefined) {
      assignments.push(["display_name", patch.display_name] as const)
    }
    // Field updates and target replacement commit together for the same reason as in
    // `createRoute`: a partial failure would otherwise leave the row changed with no
    // targets, or with the new fields but the old targets.
    yield* sql.withTransaction(
      Effect.gen(function* () {
        if (assignments.length > 0) {
          yield* sql.unsafe(
            `UPDATE routes SET ${assignments.map(([column]) => `${column} = ?`).join(", ")}, updated_at = ? WHERE public_model = ?`,
            [...assignments.map(([, value]) => value), now(), publicModel]
          )
        }
        if (patch.targets !== undefined) {
          yield* replaceTargets(sql, publicModel, patch.targets)
        }
      })
    )
    return yield* getRoute(sql, publicModel)
  })

export const deleteRoute = (
  sql: SqlClient.SqlClient,
  publicModel: string
): Effect.Effect<number, SqlError> =>
  rowCount(sql`DELETE FROM routes WHERE public_model = ${publicModel} RETURNING public_model`)

/**
 * Resolve the providers that can serve a public model, best first.
 *
 * A candidate is dropped unless both the route target and the provider are
 * enabled, so disabling a provider immediately removes it from every route
 * without rewriting those routes. Ordering uses the target's priority first —
 * that is where an operator expresses "prefer provider A for this model" — then
 * the provider's own priority, then id for a stable tie-break.
 */
export const resolveTargets = (
  sql: SqlClient.SqlClient,
  publicModel: string
): Effect.Effect<
  { readonly targets: ReadonlyArray<{ target: RouteTarget; provider: Provider }>; readonly strategy: RoutingStrategy | null },
  SqlError
> =>
  Effect.gen(function* () {
    const route = yield* sql<{ enabled: number; strategy: string | null }>`
      SELECT enabled, strategy FROM routes WHERE public_model = ${publicModel}
    `
    const routeRow = route[0]
    if (routeRow === undefined || !asBool(routeRow.enabled)) return { targets: [], strategy: null }
    // The route's own strategy, or null to fall back to the gateway default. Reading it
    // here is what makes the per-route setting take effect: it was stored, surfaced in
    // the UI and documented, but never consulted, so every route routed with the default.
    const strategy = isStrategy(routeRow.strategy) ? routeRow.strategy : null

    const rows = yield* sql<
      TargetRow & { provider_enabled: number; provider_priority: number }
    >`
      SELECT t.public_model, t.provider_id, t.upstream_model, t.priority, t.enabled,
             p.enabled AS provider_enabled, p.priority AS provider_priority
      FROM route_targets t
      JOIN providers p ON p.id = t.provider_id
      WHERE t.public_model = ${publicModel} AND t.enabled = 1 AND p.enabled = 1
      ORDER BY t.priority DESC, p.priority DESC, t.provider_id ASC, t.upstream_model ASC
    `

    const providers = yield* listProviders(sql)
    const byId = new Map(providers.map((provider) => [provider.id, provider]))
    const out: Array<{ target: RouteTarget; provider: Provider }> = []
    for (const row of rows) {
      const provider = byId.get(row.provider_id)
      if (provider === undefined) continue
      out.push({
        target: {
          provider_id: row.provider_id,
          upstream_model: row.upstream_model,
          priority: row.priority,
          enabled: asBool(row.enabled)
        },
        provider
      })
    }
    return { targets: out, strategy }
  })
