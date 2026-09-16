/**
 * Server-sent events, both directions.
 *
 * Inbound: turn an upstream's SSE body into a stream of JSON payloads. Outbound:
 * frame canonical chunk payloads as SSE for the client. Both are `Stream`-based
 * so backpressure and interruption propagate naturally — a client that stops
 * reading stops the upstream read, which is what actually cancels the provider
 * request.
 */
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { isRecord } from "../json.ts"

export const DONE = "[DONE]"

/** SSE frames are separated by a blank line; `\r\n` is used by a few providers. */
const isBlank = (line: string): boolean => line === "" || line === "\r"

/**
 * Parse an SSE byte stream into payload strings.
 *
 * Handles multi-line `data:` fields per the SSE spec, `\r\n` line endings, and
 * `:` comment lines used as keep-alives. `[DONE]` terminates the stream, and the
 * `event:` field is consumed but ignored — every supported provider leaves the
 * event type implicit in the JSON `type`/`object` fields.
 */
export const parse = (
  body: Stream.Stream<Uint8Array, unknown>
): Stream.Stream<string, unknown> =>
  body.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    // A frame is only emitted once a blank line closes it, so a body that ends without
    // one loses its final frame — which is normally the `usage` chunk. Providers do this
    // whenever they close the connection right after the last event, so synthesise the
    // terminator rather than dropping the payload. The sentinel cannot collide with real
    // input because `splitLines` never yields an empty line itself.
    Stream.concat(Stream.succeed("")),
    Stream.mapAccum(
      // Accumulates the `data:` lines of the frame currently being read.
      [] as ReadonlyArray<string>,
      (buffered, line): readonly [ReadonlyArray<string>, string | null] => {
        const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line
        if (isBlank(trimmed)) {
          if (buffered.length === 0) return [[], null] as const
          const payload = buffered.join("\n")
          return [[], payload === DONE ? DONE : payload] as const
        }
        if (trimmed.startsWith(":")) return [buffered, null] as const
        if (trimmed.startsWith("data:")) {
          const value = trimmed.slice(5)
          return [[...buffered, value.startsWith(" ") ? value.slice(1) : value], null] as const
        }
        // `event:` / `id:` / `retry:` carry nothing the gateway needs.
        return [buffered, null] as const
      }
    ),
    Stream.filter((payload): payload is string => payload !== null),
    Stream.takeWhile((payload) => payload !== DONE)
  )

/**
 * Decode an SSE payload into a JSON object, dropping malformed frames.
 *
 * A provider that emits a truncated final frame (common when a stream is cut
 * short) must not fail the whole response: the chunks already delivered are
 * valid, and the usage accumulator reports what it saw.
 */
export const decode = (
  payloads: Stream.Stream<string, unknown>
): Stream.Stream<Record<string, unknown>, unknown> =>
  payloads.pipe(
    Stream.map((payload) => {
      try {
        const parsed: unknown = JSON.parse(payload)
        return isRecord(parsed) ? parsed : null
      } catch {
        return null
      }
    }),
    Stream.filter((value): value is Record<string, unknown> => value !== null)
  )

/** Frame one payload as an SSE event. */
export const frame = (payload: string): string => `data: ${payload}\n\n`

/**
 * Frame a named SSE event, which is what the Anthropic protocol uses.
 *
 * Anthropic clients dispatch on the `event:` field rather than on a `type` inside the
 * payload, so the name is load-bearing and cannot be omitted the way it can for
 * OpenAI's unnamed `data:` frames.
 */
export const namedFrame = (event: string, payload: string): string =>
  `event: ${event}\ndata: ${payload}\n\n`

/** Encode named events for a response body. */
export const namedBody = <E>(
  events: Stream.Stream<{ readonly event: string; readonly data: string }, E>
): Stream.Stream<Uint8Array, E> =>
  events.pipe(Stream.map((entry) => encoder.encode(namedFrame(entry.event, entry.data))))

const encoder = new TextEncoder()

/**
 * Encode framed payloads as the byte stream an HTTP response body needs.
 *
 * `terminate` is read *after* the upstream stream ends, not before: a handler that
 * converted a failure into a final error frame does so via `catchAll`, which makes the
 * stream complete successfully — so an unconditional terminator would be appended after
 * that error frame and tell the client a truncated response finished normally. The
 * Anthropic path never had this problem because it appends nothing.
 */
export const encode = <E>(
  payloads: Stream.Stream<string, E>,
  terminate: () => boolean = () => true
): Stream.Stream<Uint8Array, E> =>
  payloads.pipe(
    Stream.map((payload) => encoder.encode(frame(payload))),
    // Append the terminator after the stream ends so every client sees it, even
    // when the upstream closed without one (EOF without `[DONE]`).
    Stream.concat(
      Stream.suspend(() =>
        terminate() ? Stream.succeed(encoder.encode(frame(DONE))) : Stream.empty
      )
    )
  )

/** Header set that keeps intermediaries from buffering an SSE response. */
export const HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  // nginx and similar will otherwise buffer the whole body before forwarding.
  "x-accel-buffering": "no"
}

/** Wrap a raw chunk payload stream with the framing HTTP needs. */
export const responseBody = <E>(
  payloads: Stream.Stream<string, E>,
  terminate: () => boolean = () => true
): Stream.Stream<Uint8Array, E> => encode(payloads, terminate)

/** A stream that emits an SSE error frame and then terminates. */
export const errorFrame = (message: string, code: string): Stream.Stream<string> =>
  Stream.succeed(JSON.stringify({ error: { message, code, type: "upstream_error" } }))

export const discard = <E, R>(stream: Stream.Stream<unknown, E, R>): Effect.Effect<void, E, R> =>
  stream.pipe(Stream.runDrain)
