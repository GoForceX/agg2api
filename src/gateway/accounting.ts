/**
 * Usage recording.
 *
 * One function that turns an episode's outcome into a persisted `UsageEntry`,
 * called from every exit path of a request — success, upstream failure, and routing
 * failure alike. Centralising it is what keeps the dashboard honest: a request that
 * never reached a provider still shows up as an error row rather than vanishing.
 */
import * as Effect from "effect/Effect"
import * as SqlClient from "@effect/sql/SqlClient"
import * as Chat from "../canonical.ts"
import type { Endpoint, Provider, ProviderKind, UsageEntry } from "../domain.ts"
import { insertUsage } from "../db/usage.ts"
import type { Attempt, Committed } from "../gateway/executor.ts"

export interface Episode {
  readonly request_id: string
  readonly endpoint: Endpoint
  readonly stream: boolean
  readonly public_model: string
  readonly started_at: number
  readonly caller_id: number | null
  readonly caller_name: string | null
  readonly client_ip: string | null
  readonly user_agent: string | null
}

/**
 * Cost from token counts and per-million-token prices.
 *
 * Unknown pricing (`null`) yields 0 rather than a guess, because a fabricated cost
 * is worse than an absent one: `cost` is summed across providers on the dashboard,
 * so invented numbers would silently corrupt the total.
 */
export const computeCost = (
  usage: Chat.Usage,
  inputPrice: number | null,
  outputPrice: number | null
): number => {
  const input = inputPrice === null ? 0 : (usage.prompt_tokens / 1_000_000) * inputPrice
  const output = outputPrice === null ? 0 : (usage.completion_tokens / 1_000_000) * outputPrice
  return Number.isFinite(input + output) ? input + output : 0
}

const elapsed = (since: number): number => Math.max(0, Date.now() - since)

/**
 * Record a successful request.
 *
 * `attempts` counts every provider try, so a request that needed two providers is
 * visible as such — that is the signal for "this route is mostly failing over".
 */
export const recordSuccess = (
  episode: Episode,
  committed: Committed,
  usage: Chat.Usage,
  ttftMs: number
): Effect.Effect<void, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const provider = committed.target.provider

    const entry: UsageEntry = {
      request_id: episode.request_id,
      ts: Date.now(),
      api_key_id: episode.caller_id,
      api_key_name: episode.caller_name,
      endpoint: episode.endpoint,
      stream: episode.stream,
      public_model: episode.public_model,
      provider_id: provider.id,
      provider_name: provider.name,
      provider_kind: provider.kind as ProviderKind,
      upstream_model: committed.target.upstream_model,
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      cached_tokens: usage.cached_tokens,
      reasoning_tokens: usage.reasoning_tokens,
      cost: computeCost(usage, provider.input_price, provider.output_price),
      currency: provider.currency,
      attempts: Math.max(1, committed.attempts.length),
      status: 200,
      error_kind: null,
      error_message: null,
      latency_ms: elapsed(episode.started_at),
      ttft_ms: ttftMs,
      client_ip: episode.client_ip,
      user_agent: episode.user_agent
    }

    yield* insertUsage(sql, entry).pipe(Effect.orDie)
  })

/**
 * Which upstream a failure should be attributed to when no attempt log exists.
 *
 * The executor records an `Attempt` per try, so successes and exhausted failovers are
 * fully attributed. A failure surfaced directly from an `execute` call has no attempt
 * log at the caller, so it passes this instead. `provider_kind` is nullable because
 * the error carries only an id and a name — guessing a kind would put a plausible but
 * false value in the dashboard's provider breakdown.
 */
export interface FailureAttribution {
  readonly provider_id: number
  readonly provider_name: string
  readonly provider_kind: ProviderKind | null
  readonly upstream_model: string | null
}

export interface FailureDetails {
  readonly status: number
  readonly error_kind: string
  readonly error_message: string
  /** Attempts made before giving up; empty when routing failed outright. */
  readonly attempts: ReadonlyArray<Attempt>
  readonly attribution?: FailureAttribution | null
  /**
   * Tokens the provider reported before the request failed.
   *
   * A stream that delivered content and a usage frame and *then* broke consumed real
   * tokens and was billed for none of them, so a workload that fails often looked
   * cheaper than one that succeeds. Zero when nothing was reported.
   */
  readonly usage?: Chat.Usage | null
  /** The provider that served the partial response, for pricing it. */
  readonly provider?: Provider | null
}

/**
 * Record a failed request.
 *
 * The provider columns come from the last attempt, when there was one: a request
 * that failed over twice before erroring is far more useful attributed to the
 * provider that finally failed than to the model alone.
 */
export const recordFailure = (
  episode: Episode,
  failure: FailureDetails
): Effect.Effect<void, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const last = failure.attempts[failure.attempts.length - 1]
    const attribution = failure.attribution ?? null
    const usage = failure.usage ?? null

    const entry: UsageEntry = {
      request_id: episode.request_id,
      ts: Date.now(),
      api_key_id: episode.caller_id,
      api_key_name: episode.caller_name,
      endpoint: episode.endpoint,
      stream: episode.stream,
      public_model: episode.public_model,
      provider_id: last?.provider_id ?? attribution?.provider_id ?? null,
      provider_name: last?.provider_name ?? attribution?.provider_name ?? null,
      provider_kind: last?.provider_kind ?? attribution?.provider_kind ?? null,
      upstream_model: last?.upstream_model ?? attribution?.upstream_model ?? null,
      prompt_tokens: usage?.prompt_tokens ?? 0,
      completion_tokens: usage?.completion_tokens ?? 0,
      cached_tokens: usage?.cached_tokens ?? 0,
      reasoning_tokens: usage?.reasoning_tokens ?? 0,
      // Priced with the provider that served the partial response: an unknown one yields 0
      // rather than a guess, matching `computeCost`'s contract.
      cost:
        usage === undefined || usage === null
          ? 0
          : computeCost(usage, failure.provider?.input_price ?? null, failure.provider?.output_price ?? null),
      currency: failure.provider?.currency ?? "USD",
      attempts: Math.max(1, failure.attempts.length),
      status: failure.status,
      error_kind: failure.error_kind,
      error_message: failure.error_message.slice(0, 1000),
      latency_ms: elapsed(episode.started_at),
      ttft_ms: 0,
      client_ip: episode.client_ip,
      user_agent: episode.user_agent
    }

    yield* insertUsage(sql, entry).pipe(Effect.orDie)
  })

/** Accumulates tokens across a stream, including the usage-only trailing chunk. */
export interface UsageAccumulator {
  readonly add: (chunk: Chat.Chunk) => void
  readonly usage: () => Chat.Usage
  /** Characters of assistant text seen, used to detect an empty completion. */
  readonly textLength: () => number
}

/**
 * Build an accumulator for a streaming response.
 *
 * Streaming responses report usage only in a final chunk that carries no choices,
 * and some providers omit it entirely. Counting deltas as a fallback would be a
 * guess at tokenisation, so the accumulator reports whatever the provider stated
 * and zero otherwise — the same rule as non-streaming, which keeps the dashboard's
 * numbers comparable across providers.
 */
export const newUsageAccumulator = (): UsageAccumulator => {
  let current: Chat.Usage = { ...Chat.EMPTY_USAGE }
  let text = 0

  return {
    add: (chunk) => {
      if (chunk.usage !== null) current = chunk.usage
      for (const choice of chunk.choices) {
        text += choice.delta.content?.length ?? 0
        text += choice.delta.reasoning_content?.length ?? 0
      }
    },
    usage: () => current,
    textLength: () => text
  }
}
