/**
 * Admin failure reporting.
 *
 * The admin group reports failures with the gateway's own flat envelope
 * (`{error, detail}`) rather than OpenAI's nested one, because the dashboard renders
 * it verbatim.
 *
 * There is one class per status rather than a single error carrying a status field.
 * `HttpApiBuilder` gathers a group's error schemas into a union and encodes a failure
 * with the first member that fits, deriving the HTTP status from that member — so a
 * single shape registered under four statuses made *every* failure come back as
 * whichever status was declared first (401). Distinct types with a literal `status`
 * discriminator are what let the encoder pick the right one.
 */
import type { SqlError } from "@effect/sql/SqlError"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

/** Reason phrase per status, so every failure carries an operator-readable label. */
const REASON = {
  400: "bad request",
  401: "unauthorized",
  404: "not found",
  500: "internal server error"
} as const

/** Fields shared by every admin failure, matching the frozen `AdminError` schema. */
const envelope = <const S extends keyof typeof REASON>(status: S) => ({
  status: Schema.Literal(status),
  error: Schema.String,
  detail: Schema.optional(Schema.String)
})

/** The submitted payload is unacceptable. */
export class AdminBadRequest extends Schema.TaggedError<AdminBadRequest>()(
  "AdminBadRequest",
  envelope(400)
) {}

/** The caller is not authorised. */
export class AdminUnauthorized extends Schema.TaggedError<AdminUnauthorized>()(
  "AdminUnauthorized",
  envelope(401)
) {}

/** No row has the identity the request named. */
export class AdminNotFound extends Schema.TaggedError<AdminNotFound>()(
  "AdminNotFound",
  envelope(404)
) {}

/** The gateway failed to serve an otherwise valid request. */
export class AdminServerError extends Schema.TaggedError<AdminServerError>()(
  "AdminServerError",
  envelope(500)
) {}

/**
 * Any admin failure.
 *
 * Handlers name this in their error channels, so adding a status later does not ripple
 * through every signature.
 */
export type AdminFailure = AdminBadRequest | AdminUnauthorized | AdminNotFound | AdminServerError

/** The submitted payload is unacceptable; `detail` names the field and the reason. */
export const badRequest = (detail: string): AdminBadRequest =>
  new AdminBadRequest({ status: 400, error: REASON[400], detail })

/** No row has the identity the request named. */
export const notFound = (detail: string): AdminNotFound =>
  new AdminNotFound({ status: 404, error: REASON[404], detail })

/** The caller is not authorised. */
export const unauthorized = (detail: string): AdminUnauthorized =>
  new AdminUnauthorized({ status: 401, error: REASON[401], detail })

/**
 * Run a repository call, replacing any `SqlError` with the admin envelope.
 *
 * `SqlError.message` quotes the failing statement together with its bound parameters,
 * and provider rows bind their API key as one of those parameters — so the message
 * must never reach the client. It goes to the server log instead, where an operator
 * can read it without it being published to whoever holds the admin UI.
 */
export const fromStorage = <A, R>(
  operation: string,
  effect: Effect.Effect<A, SqlError, R>
): Effect.Effect<A, AdminServerError, R> =>
  effect.pipe(
    Effect.tapError((error) => Effect.logError(`admin: ${operation} failed`, error)),
    Effect.mapError(
      () =>
        // The operator-facing part is the failed operation; the driver's message stays
        // in the log. "database error" is deliberately generic so the envelope can
        // never carry a fragment of the statement or its bound values.
        new AdminServerError({ status: 500, error: "database error", detail: `${operation} failed` })
    )
  )

/**
 * Verify the admin bearer token.
 *
 * Constant-time comparison: a byte-wise early return would leak the token's prefix to
 * anyone able to time responses, which for a value guarding provider credentials is
 * worth the cost.
 *
 * An empty configured token means admin auth is disabled. `resolve` in `src/config.ts`
 * refuses that combination on a non-loopback bind, so this is only reachable when the
 * operator asked for it on localhost.
 */
export const authorizeAdmin = (
  authorization: string | null,
  expected: string
): AdminUnauthorized | null => {
  if (expected === "") return null

  const provided =
    authorization !== null && /^Bearer\s+/i.test(authorization.trim())
      ? authorization.trim().replace(/^Bearer\s+/i, "").trim()
      : ""

  if (provided.length === expected.length && timingSafeEqual(provided, expected)) return null
  return unauthorized("missing or invalid admin token")
}

/**
 * Constant-time string comparison over the raw bytes.
 *
 * Length is compared first so the loop below can index both operands in lockstep; the
 * length of a fixed-format token is not itself a secret.
 */
const timingSafeEqual = (a: string, b: string): boolean => {
  const left = new TextEncoder().encode(a)
  const right = new TextEncoder().encode(b)
  if (left.length !== right.length) return false
  let diff = 0
  for (let index = 0; index < left.length; index += 1) {
    diff |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }
  return diff === 0
}
