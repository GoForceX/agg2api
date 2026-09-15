/**
 * Admin frontend hosting.
 *
 * The UI is a static client-side app (React + TanStack, hash-routed) built into
 * `web/dist`. There is no server-side rendering, so this module's entire job is to
 * hand out files.
 *
 * Two details are load-bearing:
 *
 * - Paths are resolved against the web root and then verified to still be *inside*
 *   it. A naive `join` would let `../../etc/passwd` escape the directory.
 * - Files are read from disk rather than embedded, because the frontend is a
 *   separate build step. A missing build produces an actionable message instead of
 *   a blank page, and the JSON API keeps working regardless.
 */
import { BunFileSystem } from "@effect/platform-bun"
import * as FileSystem from "@effect/platform/FileSystem"
import type * as HttpServerRequest from "@effect/platform/HttpServerRequest"
import * as HttpServerResponse from "@effect/platform/HttpServerResponse"
import * as Effect from "effect/Effect"
import { join, resolve, sep } from "node:path"

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8"
}

const contentTypeFor = (path: string): string => {
  const dot = path.lastIndexOf(".")
  if (dot < 0) return "application/octet-stream"
  return CONTENT_TYPES[path.slice(dot).toLowerCase()] ?? "application/octet-stream"
}

const NOT_BUILT = `<!doctype html>
<meta charset="utf-8">
<title>agg2api admin</title>
<body style="font:14px/1.6 system-ui;max-width:42rem;margin:4rem auto;padding:0 1rem">
<h1>Admin UI not built</h1>
<p>The gateway is running, but the frontend bundle is missing.</p>
<pre style="background:#f4f4f5;padding:1rem;border-radius:.5rem">cd web &amp;&amp; bun install &amp;&amp; bun run build</pre>
<p>The JSON API under <code>/admin/api</code> is available now, so the gateway itself is unaffected.</p>
</body>`

/** Read a file, or `null` when it is absent or unreadable. */
const readIfPresent = (
  path: string
): Effect.Effect<Uint8Array | null, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    if (!(yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false)))) return null
    return yield* fs.readFile(path).pipe(Effect.orElseSucceed(() => null))
  })

/**
 * Serve the admin UI for a request.
 *
 * A request for the mount point itself (`/admin`) redirects to `/admin/` so that
 * the bundle's relative URLs resolve against the right base. Unknown paths fall
 * back to `index.html` — the app routes on the hash, so any path under the mount
 * point legitimately belongs to it.
 */
export const serve = (
  request: HttpServerRequest.HttpServerRequest,
  options: { root: string }
): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
  serveWith(request, options).pipe(Effect.provide(BunFileSystem.layer))

const serveWith = (
  request: HttpServerRequest.HttpServerRequest,
  options: { root: string }
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const url = new URL(request.url, "http://localhost")
    const base = resolve(options.root)

    if (url.pathname === "/admin") {
      return HttpServerResponse.redirect("/admin/", { status: 308 })
    }

    const relative = url.pathname.replace(/^\/admin\/?/, "")
    const candidate = resolve(base, relative === "" ? "index.html" : relative)

    // Containment check: `resolve` collapses `..` segments, so a traversal attempt
    // lands outside `base` and is refused rather than followed.
    if (candidate !== base && !candidate.startsWith(base + sep)) {
      return HttpServerResponse.text("forbidden", { status: 403 })
    }

    const found = yield* readIfPresent(candidate)
    if (found !== null) {
      return HttpServerResponse.raw(found, {
        status: 200,
        headers: {
          "content-type": contentTypeFor(candidate),
          "cache-control": candidate.endsWith("index.html")
            ? "no-cache"
            : "public, max-age=31536000, immutable"
        }
      })
    }

    const index = join(base, "index.html")
    const shell = yield* readIfPresent(index)
    if (shell === null) {
      return HttpServerResponse.text(NOT_BUILT, { status: 503, contentType: "text/html; charset=utf-8" })
    }
    return HttpServerResponse.raw(shell, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" }
    })
  })
