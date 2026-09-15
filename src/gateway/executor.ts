/**
 * Request execution: provider selection, retries, failover and breaker updates.
 *
 * The design constraint that shapes everything here is *when a failure becomes
 * visible to the client*:
 *
 * - `execute` (non-streaming) runs an attempt to completion before returning, so a
 *   failure is always recoverable — the next candidate simply gets a turn.
 * - `executeStream` opens the upstream and returns its `ProviderStream` only once
 *   the provider has accepted the request (`Adapter.stream` fails on
 *   connection/headers, not on body). After that point the gateway has already
 *   committed: a mid-stream failure cannot be retried, because bytes are on the
 *   wire and the next provider would have to start the response over.
 *
 * So failover is decided entirely before the first byte reaches the client, and
 * everything after the commit is the adapter's problem.
 */
import * as Effect from "effect/Effect"
import * as SqlClient from "@effect/sql/SqlClient"
import * as HttpClient from "@effect/platform/HttpClient"
import type * as Chat from "../canonical.ts"
import type { ProviderAttempt, ProviderKind, RoutingStrategy } from "../domain.ts"
import { ProviderError, RoutingError, providerError } from "../errors.ts"
import type { Adapter, Completion, ProviderStream, Target } from "../upstream/adapter.ts"
import { openaiChatAdapter } from "../upstream/chat-adapter.ts"
import { responsesAdapter } from "../upstream/responses-adapter.ts"
import { workbuddyAdapter } from "../upstream/workbuddy.ts"
import { getProviderStatus, recordFailure, recordSuccess, type BreakerPolicy } from "../db/health.ts"
import { resolveTargets } from "../db/routes.ts"
import { orderCandidates, type Candidate } from "./router.ts"
import { Sessions, preferPinned } from "./sessions.ts"
import { AppSettings } from "./settings.ts"

/**
 * One provider attempt, recorded for the usage log and the admin UI.
 *
 * Aliased from the domain schema because the failure trail travels on `ProviderError`,
 * which the handler that writes the usage row is the one to read.
 */
export type Attempt = ProviderAttempt

/** The provider that a request was ultimately served by. */
export interface Committed {
  readonly target: Target
  readonly model: string
  readonly attempts: ReadonlyArray<Attempt>
  /** Time from call entry to the provider accepting the request. 0 for non-streaming. */
  readonly ttft_ms: number
}

export interface RequestContext {
  readonly request_id: string
  readonly public_model: string
  readonly strategy: RoutingStrategy
  /**
   * Session identity for cache affinity. `null` opts out — used by probes and tests
   * where pinning would only add nondeterminism.
   */
  readonly session_key?: string | null
}

const ADAPTERS: Record<ProviderKind, Adapter> = {
  "openai-chat": openaiChatAdapter,
  "openai-responses": responsesAdapter,
  workbuddy2api: workbuddyAdapter
}

const now = (): number => Date.now()

const attemptOf = (
  target: Target,
  status: number,
  error: ProviderError | null,
  latencyMs: number
): Attempt => ({
  provider_id: target.provider.id,
  provider_name: target.provider.name,
  provider_kind: target.provider.kind,
  upstream_model: target.upstream_model,
  status,
  error_kind: error === null ? null : error.kind,
  error_message: error === null ? null : error.message,
  latency_ms: latencyMs
})

/** Result of candidate selection: the order to try, plus the affinity decision. */
interface Plan {
  readonly candidates: ReadonlyArray<Candidate>
  /** Provider the session is pinned to, when one applied to this plan. */
  readonly pinned_provider_id: number | null
}

/**
 * Build the ordered candidate list, or explain why there is none.
 *
 * Affinity is applied here rather than inside `orderCandidates` so that candidate
 * *selection* (which providers are eligible) stays separate from candidate
 * *ordering* (which is tried first). A pinned provider that the breaker has taken out
 * of rotation is therefore never resurrected by affinity — it never reaches the
 * ordering step.
 */
const plan = (
  ctx: RequestContext,
  strategy: RoutingStrategy,
  settings: { breaker_failure_threshold: number }
): Effect.Effect<
  Plan,
  RoutingError,
  SqlClient.SqlClient | Sessions
> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const resolved = yield* resolveTargets(sql, ctx.public_model).pipe(Effect.orDie)

    if (resolved.targets.length === 0) {
      return yield* Effect.fail(
        new RoutingError({
          reason: "unknown_model",
          message: `no provider is configured for model "${ctx.public_model}"`,
          model: ctx.public_model
        })
      )
    }

    // A provider is skipped while its breaker is open. Skipping happens here, before
    // ordering, so the weights of the remaining candidates are unaffected.
    const usable: Candidate[] = []
    let skipped = 0
    for (const entry of resolved.targets) {
      if (settings.breaker_failure_threshold <= 0) {
        usable.push({ target: { provider: entry.provider, upstream_model: entry.target.upstream_model }, priority: entry.target.priority })
        continue
      }
      const status = yield* getProviderStatus(sql, entry.provider.id).pipe(Effect.orDie)
      if (status.open_until > now()) {
        skipped += 1
        continue
      }
      usable.push({
        target: { provider: entry.provider, upstream_model: entry.target.upstream_model },
        priority: entry.target.priority
      })
    }

    if (usable.length === 0) {
      return yield* Effect.fail(
        new RoutingError({
          reason: "all_unavailable",
          message: `every provider for "${ctx.public_model}" is cooling down (${skipped} skipped)`,
          model: ctx.public_model
        })
      )
    }

    // A route's own strategy wins over the gateway default, so per-model routing is
    // honoured rather than silently ignored.
    const ordered = orderCandidates(usable, resolved.strategy ?? strategy, Math.random)

    // Cache affinity: try the provider that served this session last, first. This is
    // only a preference — `preferPinned` is a stable reorder, so an unavailable or
    // failing pin still falls through to the strategy's own order.
    const sessions = yield* Sessions
    const key = ctx.session_key ?? null
    if (key === null) return { candidates: ordered, pinned_provider_id: null }

    const pinned = sessions.lookup(key)
    if (pinned === null) return { candidates: ordered, pinned_provider_id: null }

    const applied = preferPinned(ordered, pinned)
    // A pin naming a provider no longer in the candidate list is stale; forgetting it
    // stops a dead pin from being consulted on every turn of the conversation.
    if (applied === ordered && !ordered.some((candidate) => candidate.target.provider.id === pinned)) {
      sessions.forget(key)
      return { candidates: ordered, pinned_provider_id: null }
    }

    return { candidates: applied, pinned_provider_id: applied === ordered ? null : pinned }
  })

/** Load the settings the executor needs, via the context tag. */
const limits = Effect.map(AppSettings, (settings) => ({
  request_timeout_ms: settings.request_timeout_ms,
  breaker_failure_threshold: settings.breaker_failure_threshold,
  breaker_cooldown_base_ms: settings.breaker_cooldown_base_ms,
  breaker_cooldown_max_ms: settings.breaker_cooldown_max_ms
}))

/**
 * Result of running one candidate to its conclusion.
 *
 * Both arms carry the attempt log so the caller can accumulate it without
 * inspecting which arm it got — the attempts of a *failed* candidate still belong
 * in the usage record.
 */
type AttemptResult<A> =
  | { readonly ok: true; readonly value: A; readonly target: Target; readonly latency_ms: number; readonly attempts: ReadonlyArray<Attempt> }
  | { readonly ok: false; readonly error: ProviderError; readonly attempts: ReadonlyArray<Attempt> }

/**
 * Run one attempt against a candidate, retrying it in place up to its own limit.
 *
 * Per-provider retries absorb transient blips (a dropped connection, one 429)
 * without spending the rest of the candidate list, which is cheaper than failing
 * over when the provider is fine and only the attempt was unlucky.
 */
const attemptWithRetries = <A>(
  candidate: Candidate,
  limits: {
    request_timeout_ms: number
    breaker_failure_threshold: number
    breaker_cooldown_base_ms: number
    breaker_cooldown_max_ms: number
  },
  run: (target: Target) => Effect.Effect<A, ProviderError, HttpClient.HttpClient>
): Effect.Effect<AttemptResult<A>, never, HttpClient.HttpClient | SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const target = candidate.target
    const attempts: Attempt[] = []
    const extra = Math.max(0, target.provider.max_retries)

    let last: ProviderError | null = null
    for (let tryIndex = 0; tryIndex <= extra; tryIndex += 1) {
      const started = now()
      const result = yield* run(target).pipe(
        // `timeoutFail` rather than `timeout`: it keeps the error channel as
        // ProviderError instead of widening it to TimeoutException, so a timeout
        // flows through the same retry/failover logic as any other failure.
        Effect.timeoutFail({
          duration: limits.request_timeout_ms,
          onTimeout: () =>
            providerError({
              provider_id: target.provider.id,
              provider_name: target.provider.name,
              kind: "timeout",
              status: 0,
              message: `provider timed out after ${limits.request_timeout_ms}ms`
            })
        }),
        Effect.either
      )
      const latency = now() - started

      if (result._tag === "Right") {
        attempts.push(attemptOf(target, 200, null, latency))
        yield* recordSuccess(sql, target.provider.id, latency).pipe(Effect.orDie)
        return { ok: true, value: result.right, target, latency_ms: latency, attempts }
      }

      const failure = result.left

      last = failure
      attempts.push(attemptOf(target, failure.status, failure, latency))

      // The caller went away; retrying or failing over would spend an upstream
      // request on a response nobody will read.
      if (failure.kind === "aborted") {
        return { ok: false, error: failure, attempts }
      }

      // A malformed request is malformed at every provider, so retrying is pure
      // waste. Surfaced immediately instead of after exhausting the candidates.
      //
      // Deliberately not recorded as a provider failure: the request was rejected
      // because the *caller* sent it wrong, so the provider answered correctly. Writing
      // it to the breaker would let one caller's bad body remove a healthy provider for
      // every other caller — and /v1 admits anonymous callers by default, so it could be
      // renewed indefinitely. The attempt still reaches the usage log via `attempts`.
      if (failure.kind === "invalid_request") {
        return { ok: false, error: failure, attempts }
      }

      if (!failure.retryable) break
      if (tryIndex < extra) {
        yield* Effect.sleep(Math.min(failure.retry_after_ms ?? 0, 5_000))
      }
    }

    const error = last ?? providerError({
      provider_id: target.provider.id,
      provider_name: target.provider.name,
      kind: "upstream",
      status: 0,
      message: "provider failed without reporting a reason"
    })
    yield* recordFailure(sql, target.provider.id, error.message, {
      threshold: limits.breaker_failure_threshold,
      base_ms: limits.breaker_cooldown_base_ms,
      max_ms: limits.breaker_cooldown_max_ms
    }).pipe(Effect.orDie)
    return { ok: false, error, attempts }
  })

/** Walk the candidate list until one succeeds, accumulating attempt records. */
const walk = <A>(
  ctx: RequestContext,
  candidates: ReadonlyArray<Candidate>,
  settings: {
    request_timeout_ms: number
    breaker_failure_threshold: number
    breaker_cooldown_base_ms: number
    breaker_cooldown_max_ms: number
  },
  run: (target: Target) => Effect.Effect<A, ProviderError, HttpClient.HttpClient>
): Effect.Effect<
  { value: A; target: Target; latency_ms: number; attempts: ReadonlyArray<Attempt> },
  ProviderError,
  HttpClient.HttpClient | SqlClient.SqlClient
> =>
  Effect.gen(function* () {
    const all: Attempt[] = []
    let last: ProviderError | null = null

    for (const candidate of candidates) {
      const result = yield* attemptWithRetries(candidate, settings, run)

      all.push(...result.attempts)

      if (result.ok) {
        return {
          value: result.value,
          target: result.target,
          latency_ms: result.latency_ms,
          attempts: all
        }
      }

      last = result.error

      // Stop immediately for the failures that no other provider can fix: the
      // caller went away, or the request itself is malformed.
      if (result.error.kind === "aborted" || result.error.kind === "invalid_request") {
        return yield* Effect.fail(result.error)
      }
    }

    // Reporting the last concrete failure is more useful to the caller than a
    // generic "all providers failed": it names a provider and a reason. The trail of
    // every candidate tried rides along, because this is the only point that knows it —
    // and a request that failed over across three providers must not be logged as one
    // attempt.
    // The trail of every candidate tried rides along, because this is the only point that
    // knows it: without it a request that failed over across three providers is logged as
    // a single attempt, and a route that is mostly failing over looks healthy.
    //
    // Rebuilt through the factory rather than spread from `last`: `message` is an Error
    // getter rather than an own property, so `{...last}` silently drops it.
    return yield* Effect.fail(
      last === null
        ? providerError({
            provider_id: 0,
            provider_name: "none",
            kind: "upstream",
            status: 502,
            message: `no provider could serve "${ctx.public_model}"`,
            attempts: all
          })
        : providerError({
            provider_id: last.provider_id,
            provider_name: last.provider_name,
            kind: last.kind,
            status: last.status,
            message: last.message,
            retry_after_ms: last.retry_after_ms,
            body: last.body,
            attempts: all
          })
    )
  })

/** Run a request to completion on the first provider that answers. */
export const execute = (
  ctx: RequestContext,
  request: Chat.Request
): Effect.Effect<
  { committed: Committed; completion: Completion },
  RoutingError | ProviderError,
  HttpClient.HttpClient | SqlClient.SqlClient | AppSettings | Sessions
> =>
  Effect.gen(function* () {
    const settings = yield* limits
    const planned = yield* plan(ctx, ctx.strategy, settings)

    const outcome = yield* walk(ctx, planned.candidates, settings, (target) =>
      ADAPTERS[target.provider.kind].complete(target, request)
    )

    const committed: Committed = {
      target: outcome.target,
      model: outcome.value.model ?? outcome.target.upstream_model,
      attempts: outcome.attempts,
      ttft_ms: 0
    }
    yield* remember(planned, outcome.target, ctx)
    return { committed, completion: outcome.value }
  })

/**
 * Open a streaming request.
 *
 * The returned `ProviderStream` is live: the provider has already accepted the
 * request, so any failure after this point is the caller's to report mid-stream.
 */
export const executeStream = (
  ctx: RequestContext,
  request: Chat.Request
): Effect.Effect<
  { committed: Committed; stream: ProviderStream },
  RoutingError | ProviderError,
  HttpClient.HttpClient | SqlClient.SqlClient | AppSettings | Sessions
> =>
  Effect.gen(function* () {
    const settings = yield* limits
    const planned = yield* plan(ctx, ctx.strategy, settings)
    const started = now()

    const outcome = yield* walk(ctx, planned.candidates, settings, (target) =>
      ADAPTERS[target.provider.kind].stream(target, request)
    )

    const committed: Committed = {
      target: outcome.target,
      model: outcome.value.model,
      attempts: outcome.attempts,
      // Time to the provider *accepting* the request, not to the first token: the
      // gateway commits here, so this is the failover-relevant figure.
      ttft_ms: now() - started
    }
    yield* remember(planned, outcome.target, ctx)
    return { committed, stream: outcome.value }
  })

/**
 * Update the session pin after a successful request.
 *
 * Two cases matter. When the request was *not* served by the pinned provider the pin
 * was wrong or its provider failed, so it is replaced with the one that actually
 * worked — otherwise every later turn would keep trying the bad pin and relying on the
 * fallback. When there was no pin, one is recorded so the next turn can hit the cache.
 *
 * Nothing is recorded when the caller supplied no session key, and nothing is recorded
 * on failure: a pin is a claim about where a conversation's cache lives, and a failed
 * request is not evidence about that.
 */
const remember = (
  planned: Plan,
  target: Target,
  ctx: RequestContext
): Effect.Effect<void, never, Sessions> =>
  Effect.gen(function* () {
    const key = ctx.session_key ?? null
    if (key === null) return
    const sessions = yield* Sessions
    sessions.record(key, target.provider.id)
    void planned
  })

/** Adapter for a provider kind, for callers that need discovery or a raw call. */
export const adapterFor = (kind: ProviderKind): Adapter => ADAPTERS[kind]

/** Exposed for the admin "test connection" action, which probes a single provider. */
export const probeProvider = (
  target: Target,
  request: Chat.Request
): Effect.Effect<Completion, ProviderError, HttpClient.HttpClient> =>
  ADAPTERS[target.provider.kind].complete(target, request)
