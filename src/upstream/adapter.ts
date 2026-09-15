/**
 * Upstream adapter contract.
 *
 * Every provider kind is reached through this one interface. The gateway core
 * knows nothing about protocols: it hands an adapter a canonical chat request and
 * a resolved target, and gets back either canonical chat bytes (streaming) or a
 * canonical chat response (non-streaming). All protocol translation lives in the
 * adapter, on both directions of the wire.
 *
 * The single most important property is *when* a failure is observable:
 *
 *   `complete`  fails with `ProviderError` before returning anything.
 *   `stream`    is an Effect that fails only on connection/headers. Once it
 *               succeeds, the provider has accepted the request, so the gateway
 *               can stop routing and commit to this provider. The returned
 *               `ProviderStream` then yields canonical chunk payloads.
 *
 * Neither call takes an `AbortSignal`: cancellation is Effect fiber interruption,
 * which the HTTP layer already triggers on client disconnect and which propagates
 * through `Stream` consumption. Adapters must therefore wire their HTTP effects
 * so that interrupting the consuming fiber aborts the upstream request.
 *
 * That split is what makes failover safe: the gateway never emits a byte to the
 * client until an upstream has definitively accepted the request.
 */
import type * as HttpClient from "@effect/platform/HttpClient"
import type * as Effect from "effect/Effect"
import type * as Stream from "effect/Stream"
import type { Provider, ProviderKind } from "../domain.ts"
import type { ProviderError } from "../errors.ts"
import type * as Chat from "../canonical.ts"

/** A resolved upstream target: which provider, and which of its model ids. */
export interface Target {
  readonly provider: Provider
  /** Provider-side model id, after route resolution and before public naming. */
  readonly upstream_model: string
}

/** Outcome of a non-streaming upstream call. */
export interface Completion {
  /** Canonical chat response, with `usage` always populated (zeros if unreported). */
  readonly response: Chat.Response
  /** Provider-reported model id when it differs from the one requested. */
  readonly model: string | null
}

/**
 * A live upstream response that has already been accepted.
 *
 * `sse` emits **canonical** `chat.completion.chunk` JSON payloads *without* the
 * `data: ` prefix and without `[DONE]` — framing is the HTTP layer's job, so
 * adapters stay encoding-agnostic and testable.
 */
export interface ProviderStream {
  readonly sse: Stream.Stream<Chat.Chunk, ProviderError>
  /** Provider-reported model id, available before the first chunk. */
  readonly model: string
}

/** A model as reported by the provider's own listing endpoint. */
export interface UpstreamModel {
  readonly id: string
  readonly context_length: number | null
  readonly max_output_tokens: number | null
  readonly owned_by: string | null
  /**
   * Provider payload, kept verbatim.
   *
   * Load-bearing beyond display: capability inference reads the upstream's own
   * modality fields out of here, and upstreams disagree so much about where those
   * live that parsing in one place beats one parser per adapter.
   */
  readonly raw: unknown
}

/** Everything an adapter needs that is not the provider row itself. */
export interface AdapterDeps {
  readonly client: HttpClient.HttpClient
  readonly request_timeout_ms: number
}

export interface Adapter {
  readonly kind: ProviderKind
  /**
   * Call the provider once, non-streaming, and normalise the result.
   *
   * Force-non-stream applies to the *upstream* call only: for a provider whose
   * native API is streaming-only this means the adapter aggregates internally.
   * For an `openai-responses` provider it means asking for `stream: false`.
   */
  readonly complete: (
    target: Target,
    request: Chat.Request
  ) => Effect.Effect<Completion, ProviderError, HttpClient.HttpClient>

  /**
   * Open a streaming call.
   *
   * The Effect fails with `ProviderError` if the provider rejects the request or
   * the transport cannot be established. On success the provider has accepted it
   * and `ProviderStream.sse` yields canonical chunk payloads until the upstream
   * stream ends.
   */
  readonly stream: (
    target: Target,
    request: Chat.Request
  ) => Effect.Effect<ProviderStream, ProviderError, HttpClient.HttpClient>

  /**
   * List the provider's models. Used by the discovery loop.
   *
   * Adapters that cannot enumerate models return an empty array rather than
   * failing, so one unsupported provider never stalls discovery for the rest.
   *
   * `enumerated` distinguishes "the provider advertises no models" from "the response
   * could not be read as a catalogue" — a proxy error envelope under HTTP 200, an empty
   * object, or HTML. Both produce zero models, but only the first is authoritative:
   * discovery replaces the stored catalogue with whatever it receives, so treating an
   * unreadable response as an empty list would delete every model and every route built
   * from it, turning a transient upstream fault into a persistent 404 outage.
   */
  readonly listModels: (
    provider: Provider
  ) => Effect.Effect<{ readonly models: ReadonlyArray<UpstreamModel>; readonly enumerated: boolean }, ProviderError, HttpClient.HttpClient>
}
