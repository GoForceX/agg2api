# agg2api

An LLM API gateway that puts several upstream providers behind **one OpenAI-compatible
surface**. Point your existing SDK at it, name a model, and agg2api decides which
provider serves the request.

Three **client** protocols are exposed, and any of them can be routed to any upstream
kind:

| Client protocol | Endpoint | Errors |
|---|---|---|
| OpenAI Chat Completions | `POST /v1/chat/completions` | OpenAI envelope |
| OpenAI Responses | `POST /v1/responses` | OpenAI envelope |
| Anthropic Messages | `POST /anthropic/v1/messages` | Anthropic envelope |

Each protocol reports failures in its **own** error shape, so the matching SDK
handles them without special-casing the gateway.

Supported upstream kinds:

| Kind | What it is | Notes |
|---|---|---|
| `openai-chat` | OpenAI **Chat Completions** and every clone of it (vLLM, DeepSeek, SiliconFlow, Ollama, …) | also the kind to use for `anthropic`-style proxies that expose a chat route |
| `openai-responses` | OpenAI **Responses API** (`POST /v1/responses`) | native; streaming events and non-streaming output are both handled |
| `workbuddy2api` | [Sliverkiss/workbuddy2api](https://github.com/Sliverkiss/workbuddy2api) | Chat Completions plus its multi-account `/status` endpoint, surfaced as **credit balances** |

The gateway pivots on Chat Completions internally: protocol adapters translate
inbound requests to it and outbound responses back, so no upstream kind needs to speak
more than one protocol.

## Contents

- [Quick start](#quick-start)
- [Client protocols](#client-protocols)
- [How routing works](#how-routing-works)
- [Session affinity](#session-affinity-cache-aware-routing)
- [Models: discovery and naming](#models-discovery-and-naming)
- [workbuddy2api credits](#workbuddy2api-credits)
- [Admin API](#admin-api)
- [Dashboard](#dashboard)
- [Configuration](#configuration)
- [Architecture](#architecture)
- [Development](#development)

## Quick start

Requires [Bun](https://bun.sh) ≥ 1.4.

```bash
bun install

# Build the admin UI (it is a separate static build; no SSR)
cd web && bun install && bun run build && cd ..

# Run
AGG2API_ADMIN_TOKEN=change-me bun run start
```

The gateway listens on `:8787` and the dashboard is at
<http://127.0.0.1:8787/admin/>.

Then add a provider — through the UI, or directly:

```bash
curl -s localhost:8787/admin/api/providers \
  -H "Authorization: Bearer change-me" \
  -H 'Content-Type: application/json' \
  -d '{
        "name": "openai",
        "kind": "openai-chat",
        "base_url": "https://api.openai.com",
        "api_key": "sk-...",
        "priority": 100
      }'

# Pull its model list, then publish those models as routes
curl -sX POST localhost:8787/admin/api/discover    -H "Authorization: Bearer change-me"
curl -sX POST localhost:8787/admin/api/routes/sync -H "Authorization: Bearer change-me"

# Use it
curl -s localhost:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
```

`/v1` requires no client key by default, which is only sensible on a loopback bind.
Set `require_client_key` and create keys under **API Keys** before exposing it.

## How routing works

A **route** is what clients ask for: a public model name mapped to one or more
`(provider, upstream model)` targets, each with a priority. When a request arrives:

1. Candidates are resolved from the route, dropping disabled targets, disabled
   providers, and any provider whose circuit breaker is open.
2. The remaining candidates are ordered by the route's strategy (falling back to
   the gateway default).
3. They are tried in order. A failed attempt retries the same provider up to its
   `max_retries`, then moves on.

Two strategies:

- **`priority`** — strict descending priority. The top provider takes every request
  until it fails. Use this when one upstream is cheaper or faster and the rest are
  a fallback.
- **`weighted`** — a weighted *permutation*: candidates are ordered by a weighted
  random draw, so a higher priority is tried first more often while every candidate
  still appears exactly once. This is what "call proportionally by priority" means
  for a request that must end up somewhere — load is shared without giving up the
  failover chain.

When several providers serve the same model, the route lists all of them; the
dashboard shows which one the current configuration prefers.

**Failover is decided before the client sees anything.** A streaming request opens
the upstream and only starts writing the response once the provider has accepted it.
After that point the gateway has committed — a mid-stream failure is reported in the
stream and cannot be retried against another provider, because the response has
already begun.

### Session affinity (cache-aware routing)

Providers cache prompt *prefixes*, so the same conversation served twice by the same
provider pays for the cached prefix instead of re-reading it. Spreading one
conversation across providers destroys that. So the gateway pins a session to the
provider that served it and tries that provider first on later turns.

The session key is derived from a **sampled identity** — the system prompt plus the
opening user turn — not from a random id. That choice is what makes the affinity pay
off: it is what an upstream keys its cache on, and it is stable as the conversation
grows, so the key does not change on every follow-up. Clients that send no session id
still get affinity, which is the common case.

For the long-context agent workload this is aimed at, two details matter:

- **The system prompt is sampled, not truncated.** A coding agent's prompt (tool
  catalogue plus environment block) easily exceeds any reasonable hash budget, so the
  head, tail and a few evenly spaced interior slices are hashed. Truncating instead
  would drop the user's turn entirely and collapse every session in a workspace onto one
  pin; concatenating it whole would make the key change whenever the agent injects a
  fresh date or `cwd`.
- **Only the opening user turn is part of the identity**, and assistant/tool content is
  excluded. Agent loops resend the whole history and append tool results containing
  timestamps and directory listings, so hashing those would change the key on nearly
  every request.

The result is stable for the whole life of an append-only conversation while still
separating distinct sessions. The tradeoff: a meaningful change inside an *unsampled*
region of a very large prompt is invisible to the key. That is acceptable because
affinity is an optimisation — a wrongly reused pin still routes to a working provider.

- **Opt-in per request**: send `x-session-id: <id>` to name the session explicitly. That
  wins outright over prefix inference and keeps affinity working even when the client's
  own history has changed.
- **Tenant-scoped**: pins are keyed per client API key, so two callers sending an
  identical prompt never share one, and one tenant cannot steer another's routing.
- **A hint, never a constraint**: the pinned provider is moved to the front of the
  candidate list and *every* other candidate is retained, so a pinned provider that
  fails falls through to the normal order. A provider whose breaker is open is filtered
  out before affinity is applied — affinity never resurrects a provider that is down.
- **The pin follows reality**: after a successful request the pin is updated to the
  provider that actually served it, so once a failover happens later turns stop
  retrying the dead provider. A failed request records nothing — a failure is not
  evidence about where a cache lives.
- **Bounded and disposable**: pins expire after `session_ttl_ms` idle and are evicted
  past `session_max_entries`. The store is in-process, so losing it on restart costs one
  cold prefix, never correctness. Set `session_ttl_ms` to `0` for pure load balancing.

`bun run affinity` is the end-to-end proof: two upstreams behind one model under the
`weighted` strategy, asserting that a conversation sticks, that a different session is
routed independently, that an explicit id wins, and that a dead pin falls back and then
moves. Run it with `AFFINITY_OFF=1` to see the stickiness checks fail.

**Circuit breaker.** Repeated failures open a provider's breaker with exponential
backoff (bounded by `breaker_cooldown_max_ms`), so a dead upstream stops being
retried on every request. State is persisted, so a restart does not immediately
hammer it again.

## Models: discovery and naming

Model lists are **discovered**, not hand-maintained. Each provider is queried
through its own protocol:

- `openai-chat` and `workbuddy2api` → `GET {base}/v1/models`
- `openai-responses` → `GET {base}/v1/models`

Discovery runs in the background (`discovery_interval_s`) and on demand from the UI.

Per provider you can:

- **Rename** models: `model_rename` maps an upstream id to a public one
  (`{"gpt-4o-mini": "fast"}`). This is how you give one name to several providers'
  models so they can be routed together.
- **Filter** with `model_allow` / `model_deny` globs, matched against the *public*
  name so an allowlist can refer to a rename.

### Model capabilities

Each discovered model carries what it **accepts and emits** — text, image, audio,
video, pdf — plus whether it does tool calls, reasoning and structured output. This is
what `/v1/models` reports, and what the route editor shows next to the chosen model.

Capabilities come from two sources, tried in this order, and the answer records which
one it used:

| Tier | Source | When |
|---|---|---|
| 1 | **Upstream self-report** | The provider's model list carries modality fields (OpenRouter's `architecture.input_modalities`, `architecture.modality`, `supports_images`, …) |
| 2 | **[models.dev](https://models.dev)**, provider-scoped | The provider is identified by its `base_url` host, and lists the model |
| 3 | **models.dev**, id vote | The provider is unknown (a self-hosted proxy, a bare IP); the id is matched across the catalogue |

The tiers are ordered by trust, and the *source* travels with the answer — the admin UI
prints `上游自报` / `models.dev` / `models.dev 推断` beside the capability tags, because a
claim the provider made about itself and one inferred from a third-party catalogue are
not equally trustworthy.

Why tier 2 exists rather than a single global id → capabilities table: roughly a third
of the ids in models.dev appear under **several providers with disagreeing modalities**
(394 of the 1084 multi-provider ids). A reseller may serve a feature-limited variant of
a model another provider serves in full, so a global lookup answers confidently and
wrongly. Scoping to the provider by base URL is what makes the answer about *your*
upstream.

Tier 3 declines to answer on a genuinely split vote, and an id nothing matches yields
`capabilities: null` — "unknown" is reported as unknown rather than defaulted to
text-only. Fetching models.dev is best-effort: if it fails, the gateway logs nothing
fatal, keeps serving, and simply reports no inference for that refresh.

`routes/sync` reconciles routes with what discovery can see. It creates a route for
each newly discovered public model and drops routes whose model has disappeared.
**A route you have curated by hand — one with multiple targets — is never
rewritten**, because silently discarding that curation is worse than a stale route.

## workbuddy2api credits

workbuddy2api fronts a pool of CodeBuddy accounts. agg2api reads its `/status`
endpoint and shows the **total remaining credits** and the **per-account
breakdown** (nickname, realm, cooling, disabled) on the dashboard, refreshing them
alongside discovery.

The pool's total is **summed from the per-account balances**, and the healthy count
is the number of accounts that are neither cooling nor disabled. workbuddy2api's own
`total` / `healthy` fields are counts of accounts, not balances, so they are not
trusted when rows are present — reading `total` as a balance showed a two-account
pool holding 7032 credits as "2". They are used only when a build reports a balance
with no account rows.

A failed refresh stores the error next to the last known figures rather than
blanking them, so stale numbers are visible as stale.

## Client protocols

### `POST /v1/chat/completions`

OpenAI Chat Completions. `stream: true` returns SSE.

```bash
curl -N localhost:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"fast","messages":[{"role":"user","content":"hi"}],"stream":true}'
```

### `POST /v1/responses`

OpenAI Responses API, including streaming events (`response.created`,
`response.output_text.delta`, `response.completed`, …) and `function_call` items.

```bash
curl localhost:8787/v1/responses \
  -H 'Content-Type: application/json' \
  -d '{"model":"fast","input":"hi"}'
```

### Optional request headers

| Header | Effect |
|---|---|
| `x-session-id` | Names the session for [cache affinity](#session-affinity-cache-aware-routing). Wins over prefix inference, so it keeps a conversation pinned even when its prompt changes. |
| `x-request-id` | Correlation id, echoed into the usage log. Generated when absent. |

### `POST /anthropic/v1/messages`

Anthropic Messages, including streaming (`event:`-named SSE frames) and tool use.

```bash
curl localhost:8787/anthropic/v1/messages \
  -H 'Content-Type: application/json' \
  -d '{"model":"fast","max_tokens":256,"messages":[{"role":"user","content":"hi"}]}'
```

Point an Anthropic SDK at the gateway by setting its base URL to the gateway's
`/anthropic` prefix — the SDK appends `/v1/messages` itself, so:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787/anthropic
export ANTHROPIC_API_KEY=<client key>
```

`max_tokens` is required, exactly as the real API requires it. The key may be sent as
`x-api-key` (what the SDKs do) or as an `Authorization: Bearer` header.

Protocol details worth knowing:

- `system` (string or text-block array) becomes a leading system message.
- `tools[].input_schema` maps onto the canonical function parameters, and a canonical
  tool call comes back as a `tool_use` block with its `input` **parsed** from JSON (an
  unparsable argument string yields `{}` rather than an error).
- `tool_result` blocks become `tool` messages; several in one user message become
  several messages.
- `reasoning_content` is surfaced as `thinking` blocks, ordered before the text.
- `finish_reason` maps onto `stop_reason`: `stop`→`end_turn`, `length`→`max_tokens`,
  `tool_calls`→`tool_use`, `content_filter`→`stop_sequence`.
- Usage reports `input_tokens` / `output_tokens`, and the gateway's cached-token count
  as `cache_read_input_tokens` — the field Anthropic clients read for prefix-cache
  savings.
- Streaming is `message_start` → `content_block_*` → `message_delta` → `message_stop`.
  There is **no** `[DONE]` sentinel, because the Anthropic protocol does not define one.

### `GET /v1/models` and `GET /anthropic/v1/models`

The models available right now. **Both paths exist and return different shapes, because
the two protocols define the same path with incompatible bodies** — which is why the
Anthropic surface is mounted under `/anthropic` rather than sharing `/v1`:

- `GET /v1/models` — OpenAI's list: `{object:"list", data:[{id, object:"model", created,
  owned_by, …}]}`, plus `context_length`, `max_output_tokens`, `capabilities`,
  `supports_images` and the serving providers where known as gateway extensions.
- `GET /anthropic/v1/models` — Anthropic's list: `{data, first_id, last_id, has_more}`
  where each entry is `{type:"model", id, display_name, created_at, max_input_tokens,
  max_tokens}`. `created_at` is an RFC 3339 string, and the pagination cursors are
  present (with `has_more: false`) because the SDKs read them.

### Errors

Each protocol uses its own envelope.

OpenAI (`/v1/chat/completions`, `/v1/responses`):

```json
{ "error": { "message": "…", "type": "upstream_error", "code": "rate_limit" } }
```

Anthropic (`/anthropic/v1/messages`):

```json
{ "type": "error", "error": { "type": "not_found_error", "message": "…" } }
```

Routing failures are `404` (unknown model) or `503` (every provider cooling down);
an upstream error keeps the provider's own status where it has one. On the Anthropic
side those map to `not_found_error` and `overloaded_error` respectively.

## Admin API

All under `/admin/api`, guarded by `Authorization: Bearer <admin_token>`.
Provider and client-key secrets are never returned — keys are masked.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/overview` | header counters, total credits, uptime |
| `GET` | `/config` | providers (with models, credits, breaker state), routes, keys, settings |
| `GET` | `/usage?window=<ms>&bucket=<ms>` | usage summary + time series |
| `GET` | `/usage/log?limit&offset&model&provider_id&errors_only` | request log page + filtered totals |
| `POST` `PUT` `DELETE` | `/providers[/:id]` | manage providers |
| `POST` | `/providers/:id/discover` | refresh one provider's models |
| `POST` | `/providers/:id/credits` | refresh workbuddy2api credits |
| `POST` | `/providers/:id/test` | one-shot completion against a provider |
| `POST` | `/discover` | refresh every provider |
| `POST` `PUT` `DELETE` | `/routes[/:public_model]` | manage routes |
| `POST` | `/routes/sync` | reconcile routes with discovery |
| `POST` `PUT` `DELETE` | `/keys[/:id]` | manage client keys |

## Dashboard

A React + TanStack Query single-page app (hash-routed, no SSR), served from
`web/dist` at `/admin/`. Five views:

- **Dashboard** — provider health, model/route/key counts, total credits, and for a
  chosen window: requests, errors, tokens, **cache rate**, latency, and cost, with a
  request-volume chart and a per-provider breakdown.
- **Providers** — every provider with kind, priority, enabled state, model count,
  live credits (with a refresh button and per-account detail), breaker state, and
  actions to edit, test, discover, or delete.
- **Routes** — per-model strategy, display name, and an editable target list with a
  provider and upstream-model picker.
- **API Keys** — client keys with RPM limits and model scoping; the generated key is
  shown once on creation.
- **Usage** — aggregate tables by model / provider / key and a filterable,
  paginated request log with totals for the filtered set.

**Cache rate** is `cached_tokens / prompt_tokens` over the window: the share of
prompt tokens a provider served from its own prompt cache. Providers that report
nothing contribute zero to both sides, so the figure reflects real cache hits rather
than being inflated by missing data, and it reads `—` when the window has no prompt
tokens at all.

## Configuration

Boot settings come from `config.example.json`, overridable by environment
(`AGG2API_PORT`, `AGG2API_DB_PATH`, `AGG2API_ADMIN_TOKEN`, … — the prefix is `AGG2API_` plus the key uppercased). Providers, routes and keys
live in SQLite and are edited at runtime — nothing there needs a restart.

| Key | Default | Meaning |
|---|---|---|
| `host` / `port` | `0.0.0.0` / `8787` | listen address |
| `db_path` | `./data/agg2api.db` | SQLite file |
| `admin_token` | *(empty)* | guards `/admin/*`. An empty token is refused unless `host` is loopback |
| `require_client_key` | `false` | make `/v1` require a key from the `api_keys` table |
| `default_strategy` | `priority` | `priority` or `weighted` |
| `request_timeout_ms` | `300000` | per-attempt upstream deadline |
| `max_body_bytes` | `16777216` | request body cap |
| `log_retention_days` | `30` | usage rows older than this are pruned hourly (`0` keeps all) |
| `discovery_interval_s` | `3600` | background discovery cadence (`0` disables). Also the models.dev capability refresh cadence |
| `breaker_failure_threshold` | `3` | Consecutive failures before a provider is taken out of rotation. `0` disables the breaker entirely; any value above `0` is the count that must be reached. A success resets the count. |
| `breaker_cooldown_base_ms` / `_max_ms` | `5000` / `300000` | backoff bounds |
| `session_ttl_ms` | `1800000` | idle lifetime of a session→provider pin for cache affinity; `0` disables |
| `session_max_entries` | `10000` | max tracked sessions, oldest evicted first |
| `web_root` | `./web/dist` | serve a different build directory |

Per-provider pricing (`input_price` / `output_price`, per million tokens) drives the
cost column. Leave them unset and cost is reported as `0` rather than guessed —
`null` pricing is unknown, not free.

## Architecture

```
client ──► /v1/chat/completions ─┐
          /v1/responses         ─┤
     /anthropic/v1/messages       ─┤
                                 ▼
                        ┌─────────────────┐
                        │  v1 handlers    │  client protocol ⇄ canonical chat
                        └────────┬────────┘
                                 ▼
                        ┌─────────────────┐
                        │    executor     │  resolve → order → retry → failover
                        └────────┬────────┘   breaker, usage accounting
                                 ▼
                 ┌───────────────┼───────────────┐
                 ▼               ▼               ▼
          openai-chat     openai-responses   workbuddy2api
                 └───────────────┼───────────────┘
                                 ▼
                          ┌─────────────┐
                          │   SQLite    │  providers · routes · keys · usage
                          └─────────────┘
```

The gateway pivots on a **canonical chat model** (`src/canonical.ts`). Every
protocol boundary is crossed exactly once: handlers convert client ↔ canonical,
adapters convert canonical ↔ upstream. Nothing else knows about wire formats.

```
src/
  canonical.ts         the pivot format
  domain.ts            stored records, shared by SQL, the admin API and the UI
  config.ts            boot settings (pure resolver + schema)
  db/                  migrations, connection, repositories
  upstream/
    adapter.ts         the Adapter interface every provider kind implements
    http.ts            shared HTTP plumbing and error classification
    sse.ts             SSE parsing and framing
    openai-chat.ts     OpenAI JSON ⇄ canonical
    chat-adapter.ts    openai-chat adapter
    workbuddy.ts       workbuddy2api adapter + credits
    responses-adapter.ts
  responses/           Responses API types and conversions
  anthropic/           Anthropic Messages types and conversions
  models/
    capabilities.ts    model capabilities: upstream claim → models.dev → id vote
  gateway/
    router.ts          candidate ordering (pure)
    sessions.ts        cache-affinity pins (pure key derivation + bounded store)
    executor.ts        resolution, retries, failover, breaker
    accounting.ts      usage → cost → SQLite
    discovery.ts       model discovery, route sync, credits
  http/
    api.ts             the HttpApi declaration (contract)
    handlers-v1.ts     client-facing endpoints (chat, responses, models)
    handlers-anthropic.ts  Anthropic Messages endpoint
    admin/handlers.ts  admin endpoints
    static.ts          admin UI hosting
  main.ts              boot and layer assembly
web/                   React + TanStack admin SPA (built to web/dist)
```

Built on **Effect** for typed effects, structured concurrency and interruption —
which is what makes cancelling a client request reliably cancel the upstream call.

## Deployment

**First time here? Follow [TUTORIAL.md](TUTORIAL.md)** — a step-by-step walkthrough with
the expected output at each step, including the two steps people most often miss (routing
has to be *published* after discovery, and `require_client_key` must be turned on only
*after* creating a key).

See **[DEPLOY.md](DEPLOY.md)** for Docker Compose (recommended), a single binary, and
systemd, plus the reverse-proxy settings that matter — chiefly: do not buffer `/v1/*`
(it breaks streaming) and do not cache `/admin/`'s HTML (it serves stale bundles).

The short version:

```bash
cp .env.example .env
sed -i "s/^AGG2API_ADMIN_TOKEN=.*/AGG2API_ADMIN_TOKEN=$(openssl rand -hex 32)/" .env
docker compose up -d --build
```

A fresh gateway has no providers, so `/v1` answers 404 for every model and `/healthz`
reports `degraded` until you add one and run discovery plus route sync. That is the
health check doing its job, not a fault.

## Development

```bash
bun run dev          # watch mode
bun x tsc --noEmit   # typecheck
bun test             # unit + HTTP integration tests (130 tests)
bun run smoke        # end-to-end against mock upstreams (31 checks)
bun run affinity     # proves cache-affinity routing, incl. failover (9 checks)
bun run failover     # shows which provider serves the turn after a failover
bun run tutorial     # executes every deployment step against a mock upstream
bun run breaker-share  # a client's bad request must not 503 the provider for others
bun run route-strategy # a route's own strategy must reach the router
bun run demo         # seeded instance on :8799 for poking at the UI
bun run build        # single-file binary → dist/agg2api

cd web && bun run dev   # dashboard with HMR, proxying /admin/api to :8787
```

`scripts/smoke.ts` is the end-to-end check: it boots mock upstreams, starts the real
gateway, configures providers through the admin API, and exercises both client
protocols (buffered and streaming), discovery, renaming, failover, credits and the
usage dashboard. `scripts/demo.ts` does the same but stays up with generated traffic.

`bun run build` produces a self-contained binary. It resolves `web/dist` relative to
the working directory when run from the project root; ship the build directory
alongside the binary, or set `web_root` to its absolute path.
