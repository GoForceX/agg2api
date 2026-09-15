/**
 * Model discovery, route synchronisation and credit refresh.
 *
 * Discovery is what keeps the gateway's model list honest: upstreams add and
 * retire models constantly, and a gateway whose catalogue is typed in by hand goes
 * stale within weeks. Every provider is queried through its adapter's `listModels`,
 * which already tolerates providers that cannot enumerate.
 */
import * as Effect from "effect/Effect"
import * as HttpClient from "@effect/platform/HttpClient"
import * as Option from "effect/Option"
import * as SqlClient from "@effect/sql/SqlClient"
import type { Credits, DiscoveredModel, Provider } from "../domain.ts"
import { isRecord } from "../json.ts"
import { createProvider, listModels, listModelsForProvider, listProviders, replaceProviderModels } from "../db/providers.ts"
import { getCredits, saveCredits } from "../db/credits.ts"
import { createRoute, listRoutes, resolveTargets } from "../db/routes.ts"
import type { UpstreamModel } from "../upstream/adapter.ts"
import { adapterFor } from "./executor.ts"
import {
  cachedIndex,
  refreshIndex,
  resolveModel,
  reportedCapabilities,
  type CatalogueIndex
} from "../models/capabilities.ts"
import { fetchCredits } from "../upstream/workbuddy.ts"

export interface DiscoveryResult {
  readonly provider_id: number
  readonly models: ReadonlyArray<DiscoveredModel>
  readonly created: ReadonlyArray<string>
  readonly removed: ReadonlyArray<string>
  readonly error: string | null
}

/**
 * Apply a provider's rename map and allow/deny globs to one discovered id.
 *
 * Order matters: an explicit rename wins outright, then the denylist, then the
 * allowlist. Filtering after renaming means an operator can allow a public name
 * that the upstream spells differently — which is the actual use case for
 * renaming, not cosmetic aliasing.
 */
const matchGlob = (pattern: string, value: string): boolean => {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")
  return new RegExp(`^${escaped}$`).test(value)
}

const publicIdFor = (provider: Provider, upstreamId: string): string => {
  const renamed = provider.model_rename[upstreamId]
  if (renamed !== undefined && renamed !== "") return renamed
  return upstreamId
}

const isAllowed = (provider: Provider, publicId: string): boolean => {
  if (provider.model_deny.some((pattern) => matchGlob(pattern, publicId))) return false
  if (provider.model_allow.length === 0) return true
  return provider.model_allow.some((pattern) => matchGlob(pattern, publicId))
}

/**
 * Discover one provider's models and store them.
 *
 * A discovery failure is reported rather than thrown: one unreachable provider must
 * not stop the others from refreshing, and the admin UI shows the error next to
 * that provider.
 */
/**
 * Resolve a discovered model's capabilities and limits.
 *
 * Kept in one function because both come from the same three-tier lookup: computing them
 * at separate call sites is how the two would end up disagreeing about which tier
 * answered, and about which model they answered for.
 */
const factsFor = (
  index: CatalogueIndex | null,
  provider: Provider,
  model: UpstreamModel
): { capabilities: DiscoveredModel["capabilities"]; context_length: number | null; max_output_tokens: number | null } => {
  const facts = resolveModel(index, {
    upstreamId: model.id,
    baseUrl: provider.base_url,
    reported: isRecord(model.raw) ? reportedCapabilities(model.raw) : null,
    // The provider's own numbers are tier 1 for limits, just as its modality claims are
    // for capabilities.
    reportedContextLength: model.context_length,
    reportedMaxOutput: model.max_output_tokens
  })
  return {
    capabilities: facts.capabilities,
    context_length: facts.context_length,
    max_output_tokens: facts.max_output_tokens
  }
}

export const discoverProvider = (
  provider: Provider,
  /** `models.dev` index. When omitted it is taken from the shared cache. */
  index?: CatalogueIndex | null
): Effect.Effect<DiscoveryResult, never, HttpClient.HttpClient | SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const adapter = adapterFor(provider.kind)

    // Resolved from the cache rather than defaulted to `null`: the admin UI's per-provider
    // refresh has no index of its own, and defaulting there rewrote every capability it had
    // already inferred back to `null` — a refresh that loses data.
    const client = yield* HttpClient.HttpClient
    const catalogue = index === undefined ? yield* cachedIndex(client) : index

    const listed = yield* adapter.listModels(provider).pipe(
      Effect.map((models) => ({ ok: true as const, models })),
      Effect.catchAll((error) => Effect.succeed({ ok: false as const, error }))
    )

    if (!listed.ok) {
      const existing = yield* listModelsForProvider(sql, provider.id).pipe(Effect.orDie)
      return {
        provider_id: provider.id,
        models: existing,
        created: [],
        removed: [],
        error: `${listed.error.kind}: ${listed.error.message}`
      }
    }

    // An unreadable listing is not an empty catalogue. Replacing the stored models with
    // nothing would delete them and, through the route sync that follows, delete every
    // route built from them — so a transient proxy fault would become a persistent 404
    // outage. The previous catalogue is kept and the condition is reported instead.
    if (!listed.models.enumerated) {
      const existing = yield* listModelsForProvider(sql, provider.id).pipe(Effect.orDie)
      return {
        provider_id: provider.id,
        models: existing,
        created: [],
        removed: [],
        error: "upstream returned no readable model list; keeping the last known catalogue"
      }
    }

    const ts = Date.now()
    const mapped: DiscoveredModel[] = []
    for (const model of listed.models.models) {
      const publicId = publicIdFor(provider, model.id)
      if (!isAllowed(provider, publicId)) continue
      mapped.push({
        provider_id: provider.id,
        upstream_id: model.id,
        public_id: publicId,
        ...factsFor(catalogue, provider, model),
        owned_by: model.owned_by,
        last_seen: ts
      })
    }

    const changed = yield* replaceProviderModels(sql, provider.id, mapped).pipe(Effect.orDie)
    return {
      provider_id: provider.id,
      models: mapped,
      created: changed.added,
      removed: changed.removed,
      error: null
    }
  })

/** Discover every enabled provider, concurrently. */
export const discoverAll = (): Effect.Effect<
  ReadonlyArray<DiscoveryResult>,
  never,
  HttpClient.HttpClient | SqlClient.SqlClient
> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const providers = yield* listProviders(sql).pipe(Effect.orDie)
    const enabled = providers.filter((provider) => provider.enabled)

    // Fetched once per pass, not per provider: it is a single shared document, and a
    // fetch per provider would multiply a 4 MB download by the size of the fleet.
    const client = yield* HttpClient.HttpClient
    const index = yield* refreshIndex(client)

    return yield* Effect.forEach(enabled, (provider) => discoverProvider(provider, index), {
      concurrency: 4
    })
  })

export interface DiscoveredCredits {
  readonly provider_id: number
  readonly credits: Credits | null
  readonly error: string | null
}

/**
 * Refresh and store a workbuddy2api provider's credit snapshot.
 *
 * A failed refresh still writes a snapshot, with `error` set and the account list
 * empty: the dashboard then shows "last known at T, error: …" instead of silently
 * displaying stale numbers as if they were current.
 */
export const refreshCredits = (
  provider: Provider
): Effect.Effect<DiscoveredCredits, never, HttpClient.HttpClient | SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    if (provider.kind !== "workbuddy2api") {
      const existing = yield* getCredits(sql, provider.id).pipe(Effect.orDie)
      return { provider_id: provider.id, credits: Option.getOrNull(existing), error: null }
    }

    const result = yield* fetchCredits(provider).pipe(
      Effect.map((credits) => ({ ok: true as const, credits })),
      Effect.catchAll((error) =>
        Effect.succeed({ ok: false as const, message: `${error.kind}: ${error.message}` })
      )
    )

    if (!result.ok) {
      const previous = yield* getCredits(sql, provider.id).pipe(Effect.orDie)
      const failed: Credits = {
        provider_id: provider.id,
        total: Option.match(previous, { onNone: () => 0, onSome: (value) => value.total }),
        healthy: Option.match(previous, { onNone: () => 0, onSome: (value) => value.healthy }),
        accounts: Option.match(previous, { onNone: () => [], onSome: (value) => value.accounts }),
        fetched_at: Date.now(),
        error: result.message
      }
      yield* saveCredits(sql, provider.id, failed).pipe(Effect.orDie)
      return { provider_id: provider.id, credits: failed, error: result.message }
    }

    yield* saveCredits(sql, provider.id, {
      total: result.credits.total,
      healthy: result.credits.healthy,
      accounts: result.credits.accounts,
      fetched_at: result.credits.fetched_at,
      error: null
    }).pipe(Effect.orDie)
    return { provider_id: provider.id, credits: result.credits, error: null }
  })

export interface RouteSyncResult {
  readonly created: ReadonlyArray<string>
  readonly updated: ReadonlyArray<string>
  readonly removed: ReadonlyArray<string>
}

/**
 * Reconcile auto-generated routes with the discovered catalogue.
 *
 * Only routes the gateway itself created are touched, and they are marked by
 * carrying a single target. A route an operator has curated — several targets,
 * hand-set priorities — is never rewritten, because silently discarding that
 * curation is worse than leaving a route slightly stale.
 *
 * Public models that no longer exist on any provider are dropped, since a route
 * pointing at nothing only produces 404s.
 */
export const syncRoutes = (): Effect.Effect<
  RouteSyncResult,
  never,
  SqlClient.SqlClient | HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const providers = yield* listProviders(sql).pipe(Effect.orDie)
    const existing = yield* listRoutes(sql).pipe(Effect.orDie)
    const byModel = new Map(existing.map((route) => [route.public_model, route]))

    // Public model → the providers that can serve it, best provider first.
    const wanted = new Map<string, Array<{ provider_id: number; upstream_model: string }>>()
    for (const provider of providers) {
      if (!provider.enabled) continue
      const models = yield* listModelsForProvider(sql, provider.id).pipe(Effect.orDie)
      for (const model of models) {
        const list = wanted.get(model.public_id) ?? []
        list.push({ provider_id: provider.id, upstream_model: model.upstream_id })
        wanted.set(model.public_id, list)
      }
    }

    const created: string[] = []
    const updated: string[] = []
    const removed: string[] = []

    for (const [publicModel, targets] of wanted) {
      const route = byModel.get(publicModel)
      const isAutoManaged = route === undefined || route.targets.length <= 1

      if (route === undefined) {
        yield* createRoute(sql, {
          public_model: publicModel,
          // Inherit the gateway strategy: an operator who wants weighted routing
          // sets it globally or overrides the routes they care about.
          strategy: null,
          enabled: true,
          display_name: null,
          targets: targets.map((target) => ({
            provider_id: target.provider_id,
            upstream_model: target.upstream_model,
            priority: 100,
            enabled: true
          }))
        }).pipe(Effect.orDie)
        created.push(publicModel)
        continue
      }

      // A curated multi-target route keeps whatever the operator configured.
      if (!isAutoManaged) continue

      const desired = targets.map((target) => ({
        provider_id: target.provider_id,
        upstream_model: target.upstream_model,
        priority: 100,
        enabled: true
      }))
      const current = route.targets.map((target) => `${target.provider_id}:${target.upstream_model}`).sort()
      const next = desired.map((target) => `${target.provider_id}:${target.upstream_model}`).sort()
      if (current.join("|") === next.join("|")) continue

      yield* createRoute(sql, {
        public_model: publicModel,
        strategy: route.strategy,
        enabled: route.enabled,
        display_name: route.display_name,
        targets: desired
      }).pipe(Effect.orDie)
      updated.push(publicModel)
    }

    for (const route of existing) {
      if (wanted.has(route.public_model)) continue
      // Preserve a route the operator built by hand even if discovery no longer
      // sees the model; they may be pointing at an upstream we cannot enumerate.
      if (route.targets.length > 1) continue
      yield* sql`DELETE FROM routes WHERE public_model = ${route.public_model}`.pipe(Effect.orDie)
      removed.push(route.public_model)
    }

    return { created, updated, removed }
  })

/** Models reachable right now, for `/v1/models`. */
export const catalogue = (): Effect.Effect<
  ReadonlyArray<{ public_model: string; display_name: string | null; providers: ReadonlyArray<string> }>,
  never,
  SqlClient.SqlClient
> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const routes = yield* listRoutes(sql).pipe(Effect.orDie)
    const providers = yield* listProviders(sql).pipe(Effect.orDie)
    const nameById = new Map(providers.map((provider) => [provider.id, provider.name]))

    const out: Array<{ public_model: string; display_name: string | null; providers: string[] }> = []
    for (const route of routes) {
      if (!route.enabled) continue
      const resolved = yield* resolveTargets(sql, route.public_model).pipe(Effect.orDie)
      if (resolved.targets.length === 0) continue
      out.push({
        public_model: route.public_model,
        display_name: route.display_name,
        providers: resolved.targets.map((entry) => nameById.get(entry.target.provider_id) ?? "unknown")
      })
    }
    return out
  })

/**
 * Metadata for one public model, taken from the providers its route actually targets.
 *
 * Resolved through the route's targets rather than by matching `provider_models.public_id`
 * against the requested name. Those are two different namespaces: a route's `public_model`
 * is chosen by the operator (or generated from the upstream's public id), while a
 * provider's `public_id` is whatever its own catalogue says. A pool that reports
 * `cn:glm-5.3` and a route named `glm-5.3` are the same model, but a lookup keyed on the
 * provider's name finds nothing and reports `capabilities: null` for a model that has
 * capabilities — which reads exactly like "this model supports nothing".
 */
export const modelMetadata = (
  publicModel: string
): Effect.Effect<DiscoveredModel | null, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const resolved = yield* resolveTargets(sql, publicModel).pipe(Effect.orDie)

    const matches: DiscoveredModel[] = []
    for (const entry of resolved.targets) {
      const models = yield* listModelsForProvider(sql, entry.target.provider_id).pipe(Effect.orDie)
      // Keyed on the *upstream* id, which is what the provider itself calls the model and
      // therefore what its discovered row is stored under.
      const match = models.find((model) => model.upstream_id === entry.target.upstream_model)
      if (match !== undefined) matches.push(match)
    }

    // Prefer an entry that carries capabilities and limits: providers report differing
    // amounts of metadata, and the richest answer is the most useful to a client. Falling
    // back to a bare entry would report `null` for a model another provider described.
    return (
      matches.find((model) => model.capabilities !== null && model.context_length !== null) ??
      matches.find((model) => model.capabilities !== null) ??
      matches.find((model) => model.context_length !== null) ??
      matches[0] ??
      null
    )
  })

export { createProvider }
