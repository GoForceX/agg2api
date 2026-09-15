/**
 * Admin HTTP middleware.
 *
 * Two responsibilities that both belong at the request boundary rather than in any
 * individual handler:
 *
 * - **Authorise `/admin/api/*`.** Doing it once here rather than in each of the
 *   eighteen handlers means an endpoint added later cannot silently miss the check.
 * - **Serve the static admin UI** for `/admin/*`. The frontend needs a wildcard file
 *   route, which an `HttpApiEndpoint` path cannot express, so it is mounted as
 *   middleware around the whole app.
 *
 * Lives in its own module rather than inline in `main.ts` so it can be mounted by
 * tests — entry points run on import and cannot be reused.
 */
import type * as HttpApp from "@effect/platform/HttpApp"
import * as HttpServerRequest from "@effect/platform/HttpServerRequest"
import * as HttpServerResponse from "@effect/platform/HttpServerResponse"
import * as Effect from "effect/Effect"
import { authorizeAdmin } from "./errors.ts"
import { serve as serveAdminUi } from "../static.ts"

export const adminMiddleware =
  (options: { readonly web_root: string; readonly admin_token: string }) =>
  (httpApp: HttpApp.Default): HttpApp.Default<never, never> =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const pathname = new URL(request.url, "http://localhost").pathname
      // `/admin/api/*` also starts with `/admin/`, so it must be matched separately:
      // otherwise this middleware would answer every API call with the SPA shell.
      const isAdminApi = pathname === "/admin/api" || pathname.startsWith("/admin/api/")

      if (isAdminApi) {
        const denied = authorizeAdmin(request.headers["authorization"] ?? null, options.admin_token)
        if (denied !== null) {
          return HttpServerResponse.unsafeJson(
            { error: denied.error, detail: denied.detail },
            { status: 401 }
          )
        }
      }

      if (!isAdminApi && (pathname === "/admin" || pathname.startsWith("/admin/"))) {
        return yield* serveAdminUi(request, { root: options.web_root })
      }

      return yield* httpApp
    })
