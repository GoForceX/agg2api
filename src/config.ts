/**
 * Boot configuration.
 *
 * Precedence is fixed and intentionally boring: built-in defaults < `config.json`
 * < environment variables. Providers, routes and client keys are NOT here — they
 * live in SQLite so the UI can change them without a restart.
 *
 * Resolution is a pure function so the precedence rules are unit-testable and the
 * server can boot from either a file or the environment alone.
 */
import * as Effect from "effect/Effect"
import * as FileSystem from "@effect/platform/FileSystem"
import * as Schema from "effect/Schema"

const positive = Schema.Int.pipe(Schema.positive())

/** Validated boot settings consumed by the rest of the app. */
export const Settings = Schema.Struct({
  host: Schema.String,
  port: positive,
  db_path: Schema.String,
  /**
   * Bearer token guarding `/admin/*`. Empty disables admin auth, which is only
   * safe on a loopback bind — `resolve` refuses the combination otherwise.
   */
  admin_token: Schema.String,
  /** When true, `/v1/*` requires a key that exists in the `api_keys` table. */
  require_client_key: Schema.Boolean,
  default_strategy: Schema.Literal("priority", "weighted"),
  request_timeout_ms: positive,
  connect_timeout_ms: positive,
  max_body_bytes: positive,
  /** Usage rows older than this are pruned hourly. 0 keeps everything. */
  log_retention_days: Schema.Number.pipe(Schema.nonNegative()),
  /** How often to refresh the upstream model catalogue. 0 disables. */
  discovery_interval_s: Schema.Number.pipe(Schema.nonNegative()),
  breaker_failure_threshold: Schema.Number.pipe(Schema.nonNegative()),
  breaker_cooldown_base_ms: positive,
  breaker_cooldown_max_ms: positive,
  /**
   * Idle lifetime of a session→provider pin, in ms. Providers cache prompt prefixes,
   * so routing a conversation to the same provider repeatedly turns its prefix into a
   * cache hit. 0 disables affinity (pure load balancing).
   */
  session_ttl_ms: Schema.Number.pipe(Schema.nonNegative()),
  /** Upper bound on tracked sessions; the oldest pins are evicted first. */
  session_max_entries: Schema.Number.pipe(Schema.nonNegative()),
  web_root: Schema.NullOr(Schema.String)
})

export type Settings = typeof Settings.Type

export const DEFAULTS: Settings = {
  host: "0.0.0.0",
  port: 8787,
  db_path: "./data/agg2api.db",
  admin_token: "",
  require_client_key: false,
  default_strategy: "priority",
  request_timeout_ms: 300_000,
  connect_timeout_ms: 30_000,
  max_body_bytes: 16 * 1024 * 1024,
  log_retention_days: 30,
  discovery_interval_s: 3600,
  breaker_failure_threshold: 3,
  breaker_cooldown_base_ms: 5_000,
  breaker_cooldown_max_ms: 300_000,
  session_ttl_ms: 1_800_000,
  session_max_entries: 10_000,
  web_root: null
}

/** Keys the JSON file may set. Unknown keys are ignored rather than fatal. */
const FILE_KEYS = {
  host: "string",
  port: "number",
  db_path: "string",
  admin_token: "string",
  require_client_key: "boolean",
  default_strategy: "string",
  request_timeout_ms: "number",
  connect_timeout_ms: "number",
  max_body_bytes: "number",
  log_retention_days: "number",
  discovery_interval_s: "number",
  breaker_failure_threshold: "number",
  breaker_cooldown_base_ms: "number",
  breaker_cooldown_max_ms: "number",
  session_ttl_ms: "number",
  session_max_entries: "number",
  web_root: "string"
} as const

export class ConfigError extends Schema.TaggedError<ConfigError>()("ConfigError", {
  source: Schema.String,
  message: Schema.String
}) {}

const ENV_PREFIX = "AGG2API_"

/**
 * Merge defaults with a JSON object and an environment map.
 *
 * Values of the wrong JSON type are rejected loudly: a string `"8787"` port is a
 * typo an operator wants to hear about, not silently accepted.
 */
export const resolve = (
  file: Record<string, unknown>,
  env: Record<string, string | undefined>
): Effect.Effect<Settings, ConfigError> =>
  Effect.gen(function* () {
    const merged: Record<string, unknown> = { ...DEFAULTS }

    for (const [key, expected] of Object.entries(FILE_KEYS)) {
      if (!(key in file)) continue
      const value = file[key]
      if (value === null && key === "web_root") {
        merged[key] = null
        continue
      }
      if (typeof value !== expected) {
        return yield* Effect.fail(
          new ConfigError({
            source: "config.json",
            message: `"${key}" must be a ${expected}, got ${describe(value)}`
          })
        )
      }
      merged[key] = value
    }

    for (const [key, expected] of Object.entries(FILE_KEYS)) {
      const name = `${ENV_PREFIX}${key.toUpperCase()}`
      const raw = env[name]
      if (raw === undefined) continue
      // A blank value means "unset", not zero or empty. Compose env files, systemd
      // `Environment=` and `docker run -e NAME=` all produce one when the source
      // variable is undefined, and coercing it is actively harmful: "" as a number is
      // 0, which *disables* retention, discovery and session affinity, and "" as a
      // path makes the admin file mount root at the process working directory.
      if (raw === "") continue
      if (expected === "string") {
        merged[key] = raw
      } else if (expected === "boolean") {
        if (raw !== "true" && raw !== "false") {
          return yield* Effect.fail(
            new ConfigError({
              source: `${ENV_PREFIX}${key.toUpperCase()}`,
              message: `must be "true" or "false", got ${JSON.stringify(raw)}`
            })
          )
        }
        merged[key] = raw === "true"
      } else {
        const parsed = Number(raw)
        if (!Number.isFinite(parsed)) {
          return yield* Effect.fail(
            new ConfigError({
              source: `${ENV_PREFIX}${key.toUpperCase()}`,
              message: `must be a number, got ${JSON.stringify(raw)}`
            })
          )
        }
        merged[key] = parsed
      }
    }

    const decoded = yield* Schema.decodeUnknown(Settings)(merged).pipe(
      Effect.mapError(
        (error) => new ConfigError({ source: "settings", message: String(error) })
      )
    )

    // A blank path from config.json is the same hazard as a blank environment variable:
    // it would root the admin file mount at the process working directory. Normalising
    // here covers both sources.
    const settings: Settings = {
      ...decoded,
      web_root: decoded.web_root !== null && decoded.web_root.trim() !== "" ? decoded.web_root : null
    }

    // An unauthenticated admin surface on a public interface is a misconfiguration
    // worth refusing outright: it exposes provider keys and lets anyone repoint traffic.
    if (settings.admin_token === "" && !isLoopback(settings.host)) {
      return yield* Effect.fail(
        new ConfigError({
          source: "admin_token",
          message:
            `admin_token is empty while host is ${settings.host}. ` +
            `Set admin_token, or bind host to 127.0.0.1 to run unauthenticated locally.`
        })
      )
    }

    return settings
  })

const isLoopback = (host: string): boolean =>
  host === "127.0.0.1" || host === "::1" || host === "localhost"

const describe = (value: unknown): string =>
  value === null ? "null" : Array.isArray(value) ? "array" : typeof value

export interface LoadOptions {
  readonly path: string | null
  readonly env: Record<string, string | undefined>
}

/**
 * Read `path` (when it exists) and resolve the effective settings.
 *
 * A missing file is normal — env-only deployments are supported. A file that
 * exists but cannot be parsed is fatal.
 */
export const load = (options: LoadOptions): Effect.Effect<Settings, ConfigError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    let file: Record<string, unknown> = {}
    if (options.path !== null) {
      const fs = yield* FileSystem.FileSystem
      const exists = yield* fs.exists(options.path).pipe(
        Effect.mapError((cause) => new ConfigError({ source: options.path ?? "", message: String(cause) }))
      )
      if (exists) {
        const contents = yield* fs.readFileString(options.path).pipe(
          Effect.mapError((cause) => new ConfigError({ source: options.path ?? "", message: String(cause) }))
        )
        file = yield* parseFile(contents, options.path)
      }
    }
    return yield* resolve(file, options.env)
  })

const parseFile = (contents: string, path: string): Effect.Effect<Record<string, unknown>, ConfigError> =>
  Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: (): unknown => JSON.parse(contents),
      catch: (cause) =>
        new ConfigError({
          source: path,
          message: `invalid JSON: ${cause instanceof Error ? cause.message : String(cause)}`
        })
    })
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return yield* Effect.fail(
        new ConfigError({ source: path, message: "top level must be a JSON object" })
      )
    }
    return parsed as Record<string, unknown>
  })
