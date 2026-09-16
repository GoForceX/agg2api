/**
 * Admin HTTP middleware.
 *
 * One responsibility, which belongs at the request boundary rather than in any
 * individual handler: **serve the static admin UI** for `/admin/*`. The frontend needs
 * a wildcard file route, which an `HttpApiEndpoint` path cannot express, so it is
 * mounted as middleware around the whole app.
 *
 * Authorising `/admin/api/*` used to live here as a path-prefix check. It now lives on
 * the admin API group itself (`src/http/admin/auth.ts`), because a prefix comparison
 * cannot agree with a router that normalises casing, duplicate slashes and
 * percent-escapes — every such variant reached the admin handlers unauthenticated.
 *
 * Lives in its own module rather than inline in `main.ts` so it can be mounted by
 * tests — entry points run on import and cannot be reused.
 */
import type * as HttpApp from "@effect/platform/HttpApp"
import * as HttpServerRequest from "@effect/platform/HttpServerRequest"
import * as HttpServerResponse from "@effect/platform/HttpServerResponse"
import * as Effect from "effect/Effect"
import { serve as serveAdminUi } from "../static.ts"

export const adminMiddleware =
  (options: { readonly web_root: string; readonly max_body_bytes: number }) =>
  (httpApp: HttpApp.Default): HttpApp.Default<never, never> =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const pathname = new URL(request.url, "http://localhost").pathname
      // `/admin/api/*` also starts with `/admin/`, so it must be matched separately:
      // otherwise this middleware would answer every API call with the SPA shell. The
      // API itself is authorised by the group middleware, not here.
      const isAdminApi = pathname === "/admin/api" || pathname.startsWith("/admin/api/")

      // The admin surface needs its own cap: `max_body_bytes` is enforced by the client
      // handlers, and the admin group's payload is decoded by the platform, which buffers
      // the whole body — so an oversized admin payload was accepted while the identical
      // body on `/v1` was refused. Checked from `content-length` because the point is to
      // refuse before the body is read; a chunked payload without the header is bounded by
      // the platform's own limit.
      if (isAdminApi) {
        const declared = Number(request.headers["content-length"] ?? "0")
        if (Number.isFinite(declared) && declared > options.max_body_bytes) {
          return HttpServerResponse.unsafeJson(
            {
              status: 400,
              error: "invalid_request",
              detail: `request body exceeds ${options.max_body_bytes} bytes`
            },
            { status: 400 }
          )
        }
      }

      if (!isAdminApi && (pathname === "/admin" || pathname.startsWith("/admin/"))) {
        return yield* serveAdminUi(request, { root: options.web_root })
      }

      return yield* httpApp
    })
