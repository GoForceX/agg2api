# agg2api — production image.
#
# Two stages with a real purpose:
#   1. `web`   builds the admin UI (a Vite build that needs dev dependencies).
#   2. `final` compiles the server to one Bun binary, on top of the `bun` image so the
#      runtime can also serve as the health probe.
#
# The final stage does NOT install the project's dependencies: `bun build --compile`
# bundles them into the binary, and the resulting image carries no node_modules, no
# TypeScript and no build tooling.
#
# The database is deliberately absent. It is state, and state belongs on a volume —
# see docker-compose.yml.

# --- stage 1: build the admin UI -------------------------------------------
FROM oven/bun:1.4-slim AS web

WORKDIR /build/web
# Lockfile first, so editing source does not re-install dependencies.
COPY web/package.json web/bun.lock ./
RUN bun install --frozen-lockfile

COPY web/ ./
RUN bun run build

# --- stage 2: compile the server, then run it -------------------------------
FROM oven/bun:1.4-slim AS final

# `oven/bun:*-slim` is Debian 13 with CA certificates and `useradd` already present,
# but no `curl` — which is why the health check below uses Bun's own fetch instead of
# adding a package. That also keeps the image off the network during build, so it can
# be built in a restricted environment.

WORKDIR /app

# Unprivileged by default, with the data directory owned by that user so a mounted
# volume inherits usable permissions instead of needing a chown on the host.
RUN mkdir -p /app/data \
  && useradd --system --create-home --uid 10001 agg2api \
  && chown -R agg2api:agg2api /app

# Dependencies are needed to compile the binary but must not survive into the image;
# they are installed here and deleted in the same layer that builds, below.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src/ ./src/

# `--minify` shrinks the bundle; the binary embeds every runtime dependency, so the
# sources and node_modules are removed afterwards and must not be copied again.
RUN bun build --compile --minify --outfile /app/agg2api src/main.ts \
  && rm -rf /app/node_modules /app/src /app/tsconfig.json /app/package.json /app/bun.lock

# The UI is read from disk at runtime rather than embedded in the binary.
COPY --from=web --chown=agg2api:agg2api /build/web/dist ./web/dist
RUN chown agg2api:agg2api /app/agg2api

COPY config.example.json ./config.example.json

USER agg2api

# Defaults mirror src/config.ts, so the image runs with no configuration at all.
# `AGG2API_ADMIN_TOKEN` is intentionally NOT defaulted: the server refuses to start
# without it on a non-loopback bind, which is the correct failure mode.
ENV AGG2API_HOST=0.0.0.0 \
    AGG2API_PORT=8787 \
    AGG2API_DB_PATH=/app/data/agg2api.db

EXPOSE 8787

# Hits the unauthenticated health endpoint, which answers 503 when the gateway has no
# usable provider or no routes. A TCP check would pass on an instance that fails every
# request, so this checks the thing that actually matters.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "const r = await fetch(`http://127.0.0.1:${process.env.AGG2API_PORT ?? 8787}/healthz`); process.exit(r.ok ? 0 : 1)"]

ENTRYPOINT ["/app/agg2api"]
