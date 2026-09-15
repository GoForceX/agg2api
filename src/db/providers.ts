/**
 * Provider and model-catalogue storage.
 *
 * Provider rows hold operator-editable configuration; the model catalogue is
 * written by discovery and read by the admin UI and route editor. Both live here
 * because they share the same conversion helpers and are always used together.
 */
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as SqlClient from "@effect/sql/SqlClient"
import type { SqlError } from "@effect/sql/SqlError"
import type { DiscoveredModel, Provider, ProviderInput, ProviderKind } from "../domain.ts"
import { asBool, bool, fromJsonStringMap, fromJsonStrings, now, toJson } from "./support.ts"
import { rowCount } from "./write.ts"

/** Raw `providers` row as SQLite returns it. */
interface ProviderRow {
  readonly id: number
  readonly name: string
  readonly kind: string
  readonly base_url: string
  readonly api_key: string
  readonly headers: string
  readonly priority: number
  readonly enabled: number
  readonly model_rename: string
  readonly model_allow: string
  readonly model_deny: string
  readonly input_price: number | null
  readonly output_price: number | null
  readonly currency: string
  readonly max_retries: number
  readonly created_at: number
  readonly updated_at: number
}

const toProvider = (row: ProviderRow): Provider => ({
  id: row.id,
  name: row.name,
  // A row written by an older/newer build could hold an unknown kind; falling back
  // to the OpenAI-compatible protocol keeps the provider usable instead of making
  // the whole config endpoint unreadable.
  kind: isProviderKind(row.kind) ? row.kind : "openai-chat",
  base_url: row.base_url,
  api_key: row.api_key,
  headers: fromJsonStringMap(row.headers),
  priority: row.priority,
  enabled: asBool(row.enabled),
  model_rename: fromJsonStringMap(row.model_rename),
  model_allow: fromJsonStrings(row.model_allow),
  model_deny: fromJsonStrings(row.model_deny),
  input_price: row.input_price,
  output_price: row.output_price,
  currency: row.currency,
  max_retries: row.max_retries,
  created_at: row.created_at,
  updated_at: row.updated_at
})

const isProviderKind = (value: string): value is ProviderKind =>
  value === "openai-chat" || value === "openai-responses" || value === "workbuddy2api"

const PROVIDER_COLUMNS = `id, name, kind, base_url, api_key, headers, priority, enabled,
  model_rename, model_allow, model_deny, input_price, output_price, currency,
  max_retries, created_at, updated_at`

export const listProviders = (
  sql: SqlClient.SqlClient
): Effect.Effect<ReadonlyArray<Provider>, SqlError> =>
  sql<ProviderRow>`SELECT ${sql.unsafe(PROVIDER_COLUMNS)} FROM providers ORDER BY priority DESC, id ASC`.pipe(
    Effect.map((rows) => rows.map(toProvider))
  )

export const getProvider = (
  sql: SqlClient.SqlClient,
  id: number
): Effect.Effect<Option.Option<Provider>, SqlError> =>
  sql<ProviderRow>`SELECT ${sql.unsafe(PROVIDER_COLUMNS)} FROM providers WHERE id = ${id}`.pipe(
    Effect.map((rows) => Option.map(Option.fromNullable(rows[0]), toProvider))
  )

export const createProvider = (
  sql: SqlClient.SqlClient,
  input: ProviderInput
): Effect.Effect<Provider, SqlError> =>
  Effect.gen(function* () {
    const ts = now()
    const rows = yield* sql<{ id: number }>`
      INSERT INTO providers (
        name, kind, base_url, api_key, headers, priority, enabled,
        model_rename, model_allow, model_deny, input_price, output_price,
        currency, max_retries, created_at, updated_at
      ) VALUES (
        ${input.name}, ${input.kind}, ${input.base_url}, ${input.api_key ?? ""},
        ${toJson(input.headers ?? {})}, ${input.priority ?? 100}, ${bool(input.enabled ?? true)},
        ${toJson(input.model_rename ?? {})}, ${toJson(input.model_allow ?? [])},
        ${toJson(input.model_deny ?? [])}, ${input.input_price ?? null},
        ${input.output_price ?? null}, ${input.currency ?? "USD"}, ${input.max_retries ?? 0},
        ${ts}, ${ts}
      ) RETURNING id
    `
    const created = yield* getProvider(sql, rows[0]?.id ?? 0)
    // The INSERT and SELECT share one connection with no interleaving, so the row
    // is guaranteed to exist; a miss means the schema is not what we think it is.
    return yield* Option.match(created, {
      onNone: () => Effect.die(new Error("provider vanished immediately after insert")),
      onSome: (provider) => Effect.succeed(provider)
    })
  })

/**
 * Patch a provider.
 *
 * Only keys present on `patch` are written. `api_key` is special-cased: an absent
 * key means "leave the stored secret alone", which is what lets the edit form
 * submit without ever receiving the current secret.
 */
export const updateProvider = (
  sql: SqlClient.SqlClient,
  id: number,
  patch: Partial<ProviderInput>
): Effect.Effect<Option.Option<Provider>, SqlError> =>
  Effect.gen(function* () {
    const assignments: Array<readonly [string, unknown]> = []
    const push = (column: string, value: unknown) => {
      if (value !== undefined) assignments.push([column, value] as const)
    }

    push("name", patch.name)
    push("kind", patch.kind)
    push("base_url", patch.base_url)
    push("api_key", patch.api_key)
    push("headers", patch.headers === undefined ? undefined : toJson(patch.headers))
    push("priority", patch.priority)
    push("enabled", patch.enabled === undefined ? undefined : bool(patch.enabled))
    push("model_rename", patch.model_rename === undefined ? undefined : toJson(patch.model_rename))
    push("model_allow", patch.model_allow === undefined ? undefined : toJson(patch.model_allow))
    push("model_deny", patch.model_deny === undefined ? undefined : toJson(patch.model_deny))
    push("input_price", patch.input_price)
    push("output_price", patch.output_price)
    push("currency", patch.currency)
    push("max_retries", patch.max_retries)

    if (assignments.length > 0) {
      const values = assignments.map(([, value]) => value)
      yield* sql.unsafe(
        `UPDATE providers SET ${assignments.map(([column]) => `${column} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
        [...values, now(), id]
      )
    }
    return yield* getProvider(sql, id)
  })

export const deleteProvider = (
  sql: SqlClient.SqlClient,
  id: number
): Effect.Effect<number, SqlError> =>
  rowCount(sql`DELETE FROM providers WHERE id = ${id} RETURNING id`)

// --- model catalogue -------------------------------------------------------

interface ModelRow {
  readonly provider_id: number
  readonly upstream_id: string
  readonly public_id: string
  readonly context_length: number | null
  readonly max_output_tokens: number | null
  readonly supports_images: number
  readonly owned_by: string | null
  readonly last_seen: number
}

const toModel = (row: ModelRow): DiscoveredModel => ({
  provider_id: row.provider_id,
  upstream_id: row.upstream_id,
  public_id: row.public_id,
  context_length: row.context_length,
  max_output_tokens: row.max_output_tokens,
  supports_images: asBool(row.supports_images),
  owned_by: row.owned_by,
  last_seen: row.last_seen
})

const MODEL_COLUMNS = `provider_id, upstream_id, public_id, context_length,
  max_output_tokens, supports_images, owned_by, last_seen`

export const listModels = (
  sql: SqlClient.SqlClient
): Effect.Effect<ReadonlyArray<DiscoveredModel>, SqlError> =>
  sql<ModelRow>`SELECT ${sql.unsafe(MODEL_COLUMNS)} FROM provider_models ORDER BY provider_id, public_id`.pipe(
    Effect.map((rows) => rows.map(toModel))
  )

export const listModelsForProvider = (
  sql: SqlClient.SqlClient,
  providerId: number
): Effect.Effect<ReadonlyArray<DiscoveredModel>, SqlError> =>
  sql<ModelRow>`SELECT ${sql.unsafe(MODEL_COLUMNS)} FROM provider_models WHERE provider_id = ${providerId} ORDER BY public_id`.pipe(
    Effect.map((rows) => rows.map(toModel))
  )

export const listModelsForPublicId = (
  sql: SqlClient.SqlClient,
  publicId: string
): Effect.Effect<ReadonlyArray<DiscoveredModel>, SqlError> =>
  sql<ModelRow>`SELECT ${sql.unsafe(MODEL_COLUMNS)} FROM provider_models WHERE public_id = ${publicId} ORDER BY provider_id`.pipe(
    Effect.map((rows) => rows.map(toModel))
  )

/**
 * Replace a provider's catalogue with the freshly discovered set.
 *
 * Upserts by `(provider_id, upstream_id)` so a rediscovered model keeps its
 * identity, then deletes rows the provider no longer advertises — otherwise a
 * model the provider dropped would stay routable forever and every request for it
 * would 404 upstream. Returns the public ids added and removed so the admin UI can
 * report what a refresh actually changed.
 */
export const replaceProviderModels = (
  sql: SqlClient.SqlClient,
  providerId: number,
  models: ReadonlyArray<DiscoveredModel>
): Effect.Effect<{ added: ReadonlyArray<string>; removed: ReadonlyArray<string> }, SqlError> =>
  Effect.gen(function* () {
    const before = yield* listModelsForProvider(sql, providerId)
    const previousIds = new Set(before.map((model) => model.upstream_id))
    const incomingIds = new Set(models.map((model) => model.upstream_id))
    const previousPublic = new Map(before.map((model) => [model.upstream_id, model.public_id]))

    for (const model of models) {
      yield* sql`
        INSERT INTO provider_models (
          provider_id, upstream_id, public_id, context_length, max_output_tokens,
          supports_images, owned_by, raw, last_seen
        ) VALUES (
          ${providerId}, ${model.upstream_id}, ${model.public_id}, ${model.context_length},
          ${model.max_output_tokens}, ${bool(model.supports_images)}, ${model.owned_by},
          '{}', ${model.last_seen}
        )
        ON CONFLICT (provider_id, upstream_id) DO UPDATE SET
          public_id = excluded.public_id,
          context_length = excluded.context_length,
          max_output_tokens = excluded.max_output_tokens,
          supports_images = excluded.supports_images,
          owned_by = excluded.owned_by,
          last_seen = excluded.last_seen
      `
    }

    const gone = [...previousIds].filter((id) => !incomingIds.has(id))
    if (gone.length > 0) {
      for (const upstreamId of gone) {
        yield* sql`DELETE FROM provider_models WHERE provider_id = ${providerId} AND upstream_id = ${upstreamId}`
      }
    }

    const added = models.filter((model) => !previousIds.has(model.upstream_id)).map((model) => model.public_id)
    const removed = gone.map((id) => previousPublic.get(id) ?? id)
    return { added, removed }
  })
