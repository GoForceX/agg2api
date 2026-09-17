/**
 * Usage accounting.
 *
 * One row per completed gateway request, written once and never updated. Every
 * dashboard figure derives from this table, so the aggregate queries here define
 * what the operator sees.
 *
 * The load-bearing decision is that `cached_tokens` is a *subset* of
 * `prompt_tokens`, not a separate counter. Providers that report no cache
 * information contribute 0 to both sides of the ratio, so the resulting cache rate
 * means "share of prompt tokens served from a provider cache" and is never
 * inflated by missing data. A provider that reports nothing simply pulls the
 * aggregate toward zero rather than making it meaningless.
 */
import * as Effect from "effect/Effect"
import * as SqlClient from "@effect/sql/SqlClient"
import type { SqlError } from "@effect/sql/SqlError"
import type { UsageAggregate, UsageEntry, UsagePoint, UsageSummary } from "../domain.ts"
import { insertRow, rowCount } from "./write.ts"

interface SummaryRow {
  readonly requests: number
  readonly errors: number
  readonly prompt_tokens: number
  readonly completion_tokens: number
  readonly cached_tokens: number
  readonly reasoning_tokens: number
  readonly cost: number
  readonly avg_latency_ms: number | null
  readonly avg_ttft_ms: number | null
  /**
   * Sum of generation windows and sum of the tokens produced in them.
   *
   * Kept as two sums rather than an average of per-row rates: averaging rates would
   * weight a 5-token reply the same as a 50,000-token one, so one quick short request
   * could dominate the figure. Summing first makes the result the throughput of the
   * whole window's generation time.
   */
  readonly generation_ms: number
  readonly generation_tokens: number
}

interface AggregateRow extends SummaryRow {
  readonly key: string | null
}

interface SeriesRow {
  readonly ts: number
  readonly requests: number
  readonly errors: number
  readonly prompt_tokens: number
  readonly completion_tokens: number
  readonly cached_tokens: number
  readonly cost: number
  readonly generation_ms: number
  readonly generation_tokens: number
  readonly avg_latency_ms: number | null
  readonly avg_ttft_ms: number | null
}

/**
 * An inclusive time range, in epoch milliseconds.
 *
 * A range is used instead of a "window ending now" because the chart's brush selects
 * a slice of history that has already happened: the operator picks the two ends, and
 * neither of them moves on its own.
 */
export interface UsageRange {
  readonly from: number
  readonly to: number
}

/** A window measured back from now, as the callers that do not take a range want. */
export const rangeOf = (windowMs: number, now = Date.now()): UsageRange => ({
  from: now - windowMs,
  to: now
})

export const insertUsage = (
  sql: SqlClient.SqlClient,
  entry: UsageEntry
): Effect.Effect<void, SqlError> =>
  insertRow(sql`
    INSERT INTO usage_log (
      request_id, ts, api_key_id, api_key_name, endpoint, stream, public_model,
      provider_id, provider_name, provider_kind, upstream_model,
      prompt_tokens, completion_tokens, cached_tokens, reasoning_tokens,
      cost, currency, attempts, status, error_kind, error_message,
      latency_ms, ttft_ms, client_ip, user_agent
    ) VALUES (
      ${entry.request_id}, ${entry.ts}, ${entry.api_key_id}, ${entry.api_key_name},
      ${entry.endpoint}, ${entry.stream ? 1 : 0}, ${entry.public_model},
      ${entry.provider_id}, ${entry.provider_name}, ${entry.provider_kind}, ${entry.upstream_model},
      ${entry.prompt_tokens}, ${entry.completion_tokens}, ${entry.cached_tokens},
      ${entry.reasoning_tokens}, ${entry.cost}, ${entry.currency}, ${entry.attempts},
      ${entry.status}, ${entry.error_kind}, ${entry.error_message},
      ${entry.latency_ms}, ${entry.ttft_ms}, ${entry.client_ip}, ${entry.user_agent}
    )
  `)

/**
 * Average latency/TTFT are computed only over rows that actually have a timing.
 *
 * The generation window — `latency - ttft` — exists only for a *streamed* request:
 * `ttft_ms` measures how long the upstream took to start answering, which is the
 * failover-relevant figure the gateway commits on, and the non-streaming path records
 * 0 because it never observes a first byte. Subtracting a 0 would count the whole
 * request as generation time, so those rows are excluded from TPS rather than
 * contributing a wrong one. A stream whose only token *was* the first token leaves a
 * zero-length window, which is also excluded: there is no rate to measure.
 */
const GENERATION_WINDOW = "CASE WHEN ttft_ms > 0 AND latency_ms > ttft_ms THEN latency_ms - ttft_ms END"
const GENERATION_TOKENS = `CASE WHEN ttft_ms > 0 AND latency_ms > ttft_ms THEN completion_tokens END`

const SUMMARY_COLUMNS = `
  COUNT(*) AS requests,
  SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors,
  COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
  COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
  COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
  COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
  COALESCE(SUM(cost), 0) AS cost,
  AVG(CASE WHEN latency_ms > 0 THEN latency_ms END) AS avg_latency_ms,
  AVG(CASE WHEN ttft_ms > 0 THEN ttft_ms END) AS avg_ttft_ms,
  COALESCE(SUM(${GENERATION_WINDOW}), 0) AS generation_ms,
  COALESCE(SUM(${GENERATION_TOKENS}), 0) AS generation_tokens
`

/** Tokens per second over summed generation time; `null` when nothing was measurable. */
const tokensPerSecond = (generationMs: number, tokens: number): number | null =>
  generationMs > 0 && tokens > 0 ? tokens / (generationMs / 1000) : null

const emptyAggregate = (key: string): UsageAggregate => ({
  key,
  requests: 0,
  errors: 0,
  prompt_tokens: 0,
  completion_tokens: 0,
  cached_tokens: 0,
  reasoning_tokens: 0,
  cost: 0,
  avg_latency_ms: 0,
  avg_ttft_ms: 0,
  avg_tps: null
})

const toAggregate = (row: AggregateRow): UsageAggregate => ({
  // Grouping on a nullable column (api_key_name is NULL for keyless access) would
  // otherwise produce a nameless row in the UI table.
  key: row.key ?? "unknown",
  requests: row.requests,
  errors: row.errors,
  prompt_tokens: row.prompt_tokens,
  completion_tokens: row.completion_tokens,
  cached_tokens: row.cached_tokens,
  reasoning_tokens: row.reasoning_tokens,
  cost: row.cost,
  avg_latency_ms: row.avg_latency_ms ?? 0,
  avg_ttft_ms: row.avg_ttft_ms ?? 0,
  avg_tps: tokensPerSecond(row.generation_ms, row.generation_tokens)
})

export const summary = (
  sql: SqlClient.SqlClient,
  range: UsageRange
): Effect.Effect<UsageSummary, SqlError> =>
  Effect.gen(function* () {
    const from = range.from
    const to = range.to

    const totals = yield* sql<SummaryRow>`
      SELECT ${sql.unsafe(SUMMARY_COLUMNS)} FROM usage_log WHERE ts >= ${from} AND ts <= ${to}
    `
    const overall = totals[0]

    const byModel = yield* sql<AggregateRow>`
      SELECT public_model AS key, ${sql.unsafe(SUMMARY_COLUMNS)}
      FROM usage_log WHERE ts >= ${from} AND ts <= ${to}
      GROUP BY public_model ORDER BY requests DESC
    `
    // Grouped on identity, labelled with the current name. Grouping on the *name* merged
    // two providers that happen to share one and split a single provider's history in two
    // when it was renamed — the log stores both the id and the name it had at the time, so
    // the id is what the breakdown must key on. The joined name is preferred over the
    // logged snapshot so a rename is reflected rather than showing stale labels, and the
    // snapshot remains the fallback for a provider that has since been deleted.
    const byProvider = yield* sql<AggregateRow>`
      SELECT COALESCE(p.name, MAX(usage_log.provider_name), 'unknown') AS key,
             ${sql.unsafe(SUMMARY_COLUMNS)}
      FROM usage_log LEFT JOIN providers p ON p.id = usage_log.provider_id
      WHERE ts >= ${from} AND ts <= ${to}
      GROUP BY usage_log.provider_id ORDER BY requests DESC
    `
    const byKey = yield* sql<AggregateRow>`
      SELECT COALESCE(k.name, MAX(usage_log.api_key_name), 'unknown') AS key,
             ${sql.unsafe(SUMMARY_COLUMNS)}
      FROM usage_log LEFT JOIN api_keys k ON k.id = usage_log.api_key_id
      WHERE ts >= ${from} AND ts <= ${to}
      GROUP BY usage_log.api_key_id ORDER BY requests DESC
    `

    // Read alongside the totals so the dashboard can say when a sum spans currencies.
    const currencyRows = yield* sql<{ currency: string | null }>`
      SELECT DISTINCT currency FROM usage_log WHERE ts >= ${from} AND ts <= ${to}
    `
    const currencies = currencyRows
      .map((row) => row.currency)
      .filter((value): value is string => value !== null && value !== "")
      .sort()

    const promptTokens = overall?.prompt_tokens ?? 0
    const cachedTokens = overall?.cached_tokens ?? 0
    const requests = overall?.requests ?? 0

    return {
      window_ms: Math.max(0, to - from),
      requests,
      errors: overall?.errors ?? 0,
      prompt_tokens: promptTokens,
      completion_tokens: overall?.completion_tokens ?? 0,
      cached_tokens: cachedTokens,
      reasoning_tokens: overall?.reasoning_tokens ?? 0,
      cost: overall?.cost ?? 0,
      currencies,
      // Guard the division: a window with no prompt tokens has no defined cache
      // rate, and reporting 0% would read as "caching is broken" rather than "no
      // traffic".
      cache_rate: promptTokens === 0 ? null : cachedTokens / promptTokens,
      avg_latency_ms: requests === 0 ? null : (overall?.avg_latency_ms ?? null),
      avg_ttft_ms: requests === 0 ? null : (overall?.avg_ttft_ms ?? null),
      avg_tps: tokensPerSecond(overall?.generation_ms ?? 0, overall?.generation_tokens ?? 0),
      by_model: byModel.length > 0 ? byModel.map(toAggregate) : [],
      by_provider: byProvider.length > 0 ? byProvider.map(toAggregate) : [],
      by_key: byKey.length > 0 ? byKey.map(toAggregate) : []
    }
  })

export const series = (
  sql: SqlClient.SqlClient,
  range: UsageRange,
  bucketMs: number
): Effect.Effect<ReadonlyArray<UsagePoint>, SqlError> =>
  Effect.gen(function* () {
    const from = range.from
    const to = range.to
    const width = Math.max(1, Math.floor(bucketMs))
    // Group by the bucket *expression* (ordinal 1), never by the `ts` alias: SQLite
    // resolves an ambiguous name to the input column, so grouping by `ts` groups by the
    // raw millisecond timestamp and emits one row per request instead of per bucket —
    // which flattened every chart into a per-request plot with duplicate React keys.
    const rows = yield* sql<SeriesRow>`
      SELECT (ts / ${width}) * ${width} AS ts,
             COUNT(*) AS requests,
             SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors,
             COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
             COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
             COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
             COALESCE(SUM(cost), 0) AS cost,
             COALESCE(SUM(${sql.unsafe(GENERATION_WINDOW)}), 0) AS generation_ms,
             COALESCE(SUM(${sql.unsafe(GENERATION_TOKENS)}), 0) AS generation_tokens,
             AVG(CASE WHEN latency_ms > 0 THEN latency_ms END) AS avg_latency_ms,
             AVG(CASE WHEN ttft_ms > 0 THEN ttft_ms END) AS avg_ttft_ms
      FROM usage_log WHERE ts >= ${from} AND ts <= ${to}
      GROUP BY 1 ORDER BY 1 ASC
    `
    return rows.map((row) => ({
      ts: row.ts,
      requests: row.requests,
      errors: row.errors,
      prompt_tokens: row.prompt_tokens,
      completion_tokens: row.completion_tokens,
      cached_tokens: row.cached_tokens,
      cost: row.cost,
      avg_latency_ms: row.avg_latency_ms,
      avg_ttft_ms: row.avg_ttft_ms,
      tps: tokensPerSecond(row.generation_ms, row.generation_tokens)
    }))
  })

export interface LogPageOptions {
  readonly limit: number
  readonly offset: number
  readonly model: string | null
  readonly providerId: number | null
  readonly errorsOnly: boolean
}

export interface LogPage {
  readonly total: number
  readonly rows: ReadonlyArray<Record<string, unknown>>
  readonly totals: {
    readonly requests: number
    readonly prompt_tokens: number
    readonly completion_tokens: number
    readonly cached_tokens: number
    readonly cost: number
  }
}

/**
 * One page of the request log, plus totals for the whole filtered set.
 *
 * The totals deliberately cover every matching row rather than the page: an
 * operator filtering for errors wants the total cost of those errors, not the
 * cost of the fifty rows currently on screen.
 */
export const logPage = (
  sql: SqlClient.SqlClient,
  opts: LogPageOptions
): Effect.Effect<LogPage, SqlError> =>
  Effect.gen(function* () {
    // Filters are expressed as OR-ed term pairs so the SQL stays a single static
    // statement rather than string-built, which keeps the parameters bound.
    const model = opts.model
    const providerId = opts.providerId
    const errorsOnly = opts.errorsOnly

    const where = sql`
      WHERE (${model} IS NULL OR public_model = ${model})
        AND (${providerId} IS NULL OR provider_id = ${providerId})
        AND (${errorsOnly} = 0 OR status >= 400)
    `

    const totalRows = yield* sql<{ total: number }>`SELECT COUNT(*) AS total FROM usage_log ${where}`
    const aggregateRows = yield* sql<{
      requests: number
      prompt_tokens: number
      completion_tokens: number
      cached_tokens: number
      cost: number
    }>`
      SELECT COUNT(*) AS requests,
             COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
             COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
             COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
             COALESCE(SUM(cost), 0) AS cost
      FROM usage_log ${where}
    `

    const rows = yield* sql<Record<string, unknown>>`
      SELECT request_id, ts, api_key_name, endpoint, stream, public_model,
             provider_id, provider_name, provider_kind, upstream_model,
             prompt_tokens, completion_tokens, cached_tokens, reasoning_tokens,
             cost, currency, attempts, status, error_kind, error_message,
             latency_ms, ttft_ms, client_ip,
             -- Per-request throughput, computed here so the formula has one definition
             -- rather than a second copy in the client. NULL for a non-streaming request
             -- (ttft_ms is 0) or one whose only token was the first: there is no
             -- generation window to divide by.
             CASE WHEN ttft_ms > 0 AND latency_ms > ttft_ms
                  THEN completion_tokens * 1000.0 / (latency_ms - ttft_ms)
             END AS tps
      FROM usage_log ${where}
      ORDER BY ts DESC, id DESC
      LIMIT ${opts.limit} OFFSET ${opts.offset}
    `

    const totals = aggregateRows[0]
    return {
      total: totalRows[0]?.total ?? 0,
      rows,
      totals: {
        requests: totals?.requests ?? 0,
        prompt_tokens: totals?.prompt_tokens ?? 0,
        completion_tokens: totals?.completion_tokens ?? 0,
        cached_tokens: totals?.cached_tokens ?? 0,
        cost: totals?.cost ?? 0
      }
    }
  })

/** Delete rows older than `cutoffMs`. Returns how many were removed. */
export const purgeOlderThan = (
  sql: SqlClient.SqlClient,
  cutoffMs: number
): Effect.Effect<number, SqlError> =>
  rowCount(sql`DELETE FROM usage_log WHERE ts < ${cutoffMs} RETURNING id`)

/** Distinct public models seen recently, for the log filter dropdown. */
export const recentModels = (
  sql: SqlClient.SqlClient
): Effect.Effect<ReadonlyArray<string>, SqlError> =>
  Effect.map(
    sql<{ public_model: string }>`SELECT DISTINCT public_model FROM usage_log ORDER BY public_model`,
    (rows) => rows.map((row) => row.public_model)
  )

export { emptyAggregate }
