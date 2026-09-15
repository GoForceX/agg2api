/**
 * Admin authentication as a group-level middleware.
 *
 * This deliberately does **not** parse the request path.
 *
 * The previous implementation gated on the literal prefix `/admin/api` computed from
 * `new URL(request.url).pathname`, while the router underneath matches routes
 * case-insensitively, collapses duplicate slashes, decodes percent-escapes and ignores
 * trailing slashes. Every path that differed from the literal prefix therefore skipped
 * the check while still routing to an admin handler — `/ADMIN/API/OVERVIEW`,
 * `//admin/api/overview`, `/%61dmin/api/overview` and `/admin/api/overview/` all reached
 * the admin API unauthenticated, including `POST` creates and the config endpoint that
 * returns provider credentials.
 *
 * Attaching the check to the group means the router itself decides what is protected:
 * a route that matches an admin endpoint is an admin request by construction, so the
 * guard cannot drift from routing. It also removes the need to reimplement the
 * router's normalisation rules, which is what made the prefix comparison wrong.
 */
import * as HttpApiMiddleware from "@effect/platform/HttpApiMiddleware"
import * as HttpServerRequest from "@effect/platform/HttpServerRequest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { AdminUnauthorized, authorizeAdmin } from "./errors.ts"

/**
 * Marker service the `admin` group depends on.
 *
 * The service value *is* the per-request hook: `HttpApiBuilder` runs it before the
 * handler and encodes its failure with the group's error schemas.
 */
export class AdminAuth extends HttpApiMiddleware.Tag<AdminAuth>()("AdminAuth", {
  failure: AdminUnauthorized
}) {}

/**
 * Verify the configured bearer token on every request routed to the admin group.
 *
 * An empty configured token disables the check; `resolve` in `src/config.ts` refuses
 * that combination on a non-loopback bind, so it is only reachable on localhost.
 */
export const adminAuthLayer = (admin_token: string): Layer.Layer<AdminAuth> =>
  Layer.succeed(
    AdminAuth,
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const denied = authorizeAdmin(request.headers["authorization"] ?? null, admin_token)
      if (denied !== null) return yield* Effect.fail(denied)
    })
  )
