# Deploying agg2api

Three ways, in order of how much they ask of you: **Docker Compose** (recommended),
**a single binary**, or **from source**. All three run the same server.

Before any of them, know the two things that decide whether a deployment is safe:

1. **`AGG2API_ADMIN_TOKEN` is mandatory off loopback.** The admin API manages provider
   credentials and can repoint traffic. If `host` is not a loopback address and the
   token is empty, the gateway **refuses to start** rather than come up with an open
   admin API. That is deliberate: a silent misconfiguration here is worse than a failed
   boot.
2. **State is one SQLite file.** Providers, routes, client keys and the usage log live
   in `AGG2API_DB_PATH`. Back it up, keep it on a volume, and do not let two gateways
   share one file.

---

## 1. Docker Compose (recommended)

```bash
cp .env.example .env
sed -i "s/^AGG2API_ADMIN_TOKEN=.*/AGG2API_ADMIN_TOKEN=$(openssl rand -hex 32)/" .env

docker compose up -d --build
docker compose logs -f agg2api
```

Then add a provider. The gateway starts with an empty catalogue — no providers, no
routes — so `/v1` returns 404 for every model until you feed it one:

```bash
TOKEN=$(grep '^AGG2API_ADMIN_TOKEN=' .env | cut -d= -f2)

# 1. add an upstream
curl -s localhost:8787/admin/api/providers \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"openai","kind":"openai-chat",
       "base_url":"https://api.openai.com","api_key":"sk-...","priority":100}'

# 2. discover its models, then publish them as routes
curl -sX POST localhost:8787/admin/api/discover    -H "Authorization: Bearer $TOKEN"
curl -sX POST localhost:8787/admin/api/routes/sync -H "Authorization: Bearer $TOKEN"

# 3. it is now healthy
curl -s localhost:8787/healthz            # {"status":"ok",...}
```

Or do all of it in the UI at <http://127.0.0.1:8787/admin/>.

The compose file publishes the port on **host loopback only**. That is the safe
default — the gateway holds provider credentials, so exposing it publicly requires TLS
and authentication in front of it. Change `"127.0.0.1:8787:8787"` to `"8787:8787"` when
you have decided that deliberately.

### About the health check

`/healthz` is unauthenticated, because `HEALTHCHECK`, Kubernetes probes and load
balancers cannot send a bearer token. It reports the gateway as **degraded (503)** when
it has no enabled provider or no routes — the states in which it would fail every
completion request. A plain TCP check would pass in exactly those states.

So a freshly started container is `unhealthy` until you add a provider and sync routes.
That is accurate, not a bug: it is telling you the gateway cannot serve yet. Once
configured it flips to `healthy`:

```bash
docker compose ps              # STATUS: healthy
curl -s localhost:8787/healthz # {"status":"ok","providers_enabled":1,...}
```

### Updating

```bash
git pull
docker compose up -d --build
```

Schema migrations run automatically at startup and are recorded in
`agg2api_migrations`; they are additive, so a downgrade needs a database restore.

### Backup and restore

The database is the only state. Back it up with SQLite's own tooling rather than `cp`,
which can capture a torn write while WAL is active:

```bash
docker compose exec agg2api sh -c \
  'command -v sqlite3 >/dev/null || exit 1; sqlite3 /app/data/agg2api.db ".backup /tmp/backup.db"'
docker compose cp agg2api:/tmp/backup.db ./agg2api-backup.db
```

The runtime image has no `sqlite3`, so the practical alternative is a volume-level
snapshot while the container is stopped (`docker compose stop` then copy the volume).
Pick whichever your infrastructure already supports; what matters is not copying a live
WAL database byte-for-byte.

---

## 2. Single binary

`bun run build` produces a self-contained binary; the runtime image is just that binary
plus `web/dist` and a CA bundle. No Bun, Node or `node_modules` is needed to run it.

```bash
bun run build          # → dist/agg2api
bun run build:web      # → web/dist   (the binary serves this from disk)

mkdir -p /opt/agg2api/data
cp dist/agg2api /opt/agg2api/
cp -r web/dist /opt/agg2api/web/dist

cat > /opt/agg2api/.env <<EOF
AGG2API_ADMIN_TOKEN=$(openssl rand -hex 32)
AGG2API_HOST=127.0.0.1
AGG2API_DB_PATH=/opt/agg2api/data/agg2api.db
EOF

cd /opt/agg2api && ./agg2api
```

`AGG2API_HOST=127.0.0.1` with an empty token is also allowed, for local use only.

**The UI is read from disk, not embedded.** The binary resolves `web/dist` relative to
the working directory (then relative to its own location), so run it from a directory
containing `web/dist` or set `AGG2API_WEB_ROOT=/absolute/path`. Without it the gateway
still serves `/v1` and `/admin/api` and returns an explanatory page at `/admin/`.

### systemd

```ini
# /etc/systemd/system/agg2api.service
[Unit]
Description=agg2api LLM gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=agg2api
WorkingDirectory=/opt/agg2api
EnvironmentFile=/opt/agg2api/.env
ExecStart=/opt/agg2api/agg2api
Restart=always
RestartSec=3

# Hardening: the service only needs its own directory and outbound HTTPS.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/agg2api/data

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now agg2api
curl -s localhost:8787/healthz
```

---

## 3. From source

For development, or when you want to run a branch:

```bash
bun install
cd web && bun install && bun run build && cd ..

AGG2API_ADMIN_TOKEN=dev-token bun run start     # or `bun run dev` to watch
```

---

## Putting it behind a reverse proxy

Two rules, and they are not optional:

1. **Do not buffer `/v1/*`.** Object stores, CDNs and some proxies buffer response
   bodies, which breaks streaming: the client sees nothing until the whole completion
   finishes. The gateway sends `X-Accel-Buffering: no`, which nginx honours, but check
   your own proxy's buffering setting too.
2. **Do not cache `/admin/`'s HTML.** The UI bundle is content-hashed and safe to cache
   forever; `index.html` is not. If a proxy caches it, users keep loading a stale bundle
   after an upgrade and appear to be missing new features.

Raise the read timeout past your slowest completion — a long reasoning response can
easily exceed the 60s default — and allow large request bodies if clients send images.

```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;

    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;

    # Streaming: never buffer the response.
    proxy_buffering off;
    proxy_cache off;

    # Long generations: 0 disables the read timeout entirely.
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;

    # Client uploads (images in messages).
    client_max_body_size 32m;
}

# The SPA shell must not be cached; its assets may be.
location = /admin/index.html {
    proxy_pass http://127.0.0.1:8787;
    add_header Cache-Control "no-cache" always;
}
```

Give the gateway the real client IP so per-IP rate limiting and the usage log are
accurate — it reads `CF-Connecting-IP` first, then the first entry of
`X-Forwarded-For`, so either header works.

---

## Configuration reference

Every setting has a default, so the gateway runs with no configuration at all. Values
come from `config.json` (if present), then environment variables, which win. The prefix
is `AGG2API_` plus the key uppercased — `db_path` → `AGG2API_DB_PATH`.

| Variable | Default | Notes |
|---|---|---|
| `AGG2API_HOST` | `0.0.0.0` | Bind address. During local development prefer `127.0.0.1`. |
| `AGG2API_PORT` | `8787` | |
| `AGG2API_DB_PATH` | `./data/agg2api.db` | **Must be on persistent storage.** |
| `AGG2API_ADMIN_TOKEN` | *(empty)* | Required off loopback. `openssl rand -hex 32`. |
| `AGG2API_REQUIRE_CLIENT_KEY` | `false` | Turn on only after creating keys, or `/v1` starts returning 401. |
| `AGG2API_DEFAULT_STRATEGY` | `priority` | `priority` or `weighted`. |
| `AGG2API_REQUEST_TIMEOUT_MS` | `300000` | Per-attempt upstream deadline. |
| `AGG2API_MAX_BODY_BYTES` | `16777216` | |
| `AGG2API_DISCOVERY_INTERVAL_S` | `3600` | `0` disables background refresh. |
| `AGG2API_LOG_RETENTION_DAYS` | `30` | **`0` keeps everything and grows without bound.** |
| `AGG2API_BREAKER_FAILURE_THRESHOLD` | `3` | **On/off switch only** — any value > 0 enables the breaker, `0` disables it. Not yet compared against a failure count, so one failure removes a provider for the whole cooldown. |
| `AGG2API_BREAKER_COOLDOWN_BASE_MS` / `_MAX_MS` | `5000` / `300000` | Bounds of the exponential cooldown. |
| `AGG2API_SESSION_TTL_MS` | `1800000` | Cache-affinity pin lifetime; `0` disables. |
| `AGG2API_SESSION_MAX_ENTRIES` | `10000` | Tracked sessions before the oldest pins are evicted. |
| `AGG2API_CONNECT_TIMEOUT_MS` | `30000` | TCP/TLS connect deadline. |
| `AGG2API_WEB_ROOT` | `./web/dist` | Set when the UI is not beside the binary. |

A config file is also supported: `agg2api --config /etc/agg2api/config.json`, or
`AGG2API_CONFIG=/path`. See `config.example.json` for the full shape.

---

## Operating it

**Adding a provider is not enough — you must sync routes.** Discovery fills the model
catalogue; `routes/sync` turns that catalogue into routable public models. Until then
every request 404s and `/healthz` reports degraded.

**Protect the admin token like the provider keys it guards.** It can read and rewrite
every upstream credential.

**Watch these on the dashboard**, because each means something is misconfigured rather
than merely busy:

- *Breakers open* — providers are failing; check the per-provider last error.
- *Cache rate* — near zero with a stable workload means session affinity is off
  (`AGG2API_SESSION_TTL_MS=0`), or clients are sending fresh prefixes each turn.
- *Errors* — 404s here usually mean a route points at a model the provider no longer
  serves; re-run discovery and sync.
- *Cost* — stays 0 unless you set `input_price`/`output_price` per provider.

**Scaling.** The gateway is single-process by design. Session affinity and per-key rate
limits are in-process and the database is SQLite, so running several replicas against
one file will not work as expected: affinity divides between them (halving cache hits)
and SQLite will serialise writes. For more throughput, raise concurrency on one larger
instance instead — the workload is IO-bound on upstream requests.
