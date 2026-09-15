/**
 * Schema migrations.
 *
 * Statements are embedded rather than read from disk because the gateway ships as
 * a single compiled binary — there is no migrations directory to ship alongside it.
 * That also makes `@effect/sql/Migrator` the wrong tool here: its file-system
 * loader, `Path` and `CommandExecutor` requirements would exist only to read files
 * that are already in memory.
 *
 * Each entry is applied once and recorded in `agg2api_migrations`. Append new
 * entries with the next id; never edit or reorder a released one, because a
 * database that already applied it will not run it again.
 */
export interface Migration {
  readonly id: number
  readonly name: string
  /** Applied in order, inside a single transaction. One statement per entry. */
  readonly statements: ReadonlyArray<string>
}

export const migrations: ReadonlyArray<Migration> = [
  {
    id: 1,
    name: "initial",
    statements: [
      `CREATE TABLE providers (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        name            TEXT    NOT NULL,
        kind            TEXT    NOT NULL,
        base_url        TEXT    NOT NULL,
        api_key         TEXT    NOT NULL DEFAULT '',
        headers         TEXT    NOT NULL DEFAULT '{}',
        priority        INTEGER NOT NULL DEFAULT 100,
        enabled         INTEGER NOT NULL DEFAULT 1,
        model_rename    TEXT    NOT NULL DEFAULT '{}',
        model_allow     TEXT    NOT NULL DEFAULT '[]',
        model_deny      TEXT    NOT NULL DEFAULT '[]',
        input_price     REAL,
        output_price    REAL,
        currency        TEXT    NOT NULL DEFAULT 'USD',
        max_retries     INTEGER NOT NULL DEFAULT 0,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
      )`,

      `CREATE TABLE provider_models (
        provider_id       INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
        upstream_id       TEXT    NOT NULL,
        public_id         TEXT    NOT NULL,
        context_length    INTEGER,
        max_output_tokens INTEGER,
        supports_images   INTEGER NOT NULL DEFAULT 0,
        owned_by          TEXT,
        raw               TEXT    NOT NULL DEFAULT '{}',
        last_seen         INTEGER NOT NULL,
        PRIMARY KEY (provider_id, upstream_id)
      )`,
      `CREATE INDEX provider_models_public ON provider_models (public_id)`,

      `CREATE TABLE routes (
        public_model TEXT    PRIMARY KEY,
        strategy     TEXT,
        enabled      INTEGER NOT NULL DEFAULT 1,
        display_name TEXT,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      )`,

      `CREATE TABLE route_targets (
        public_model   TEXT    NOT NULL REFERENCES routes(public_model) ON DELETE CASCADE,
        provider_id    INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
        upstream_model TEXT    NOT NULL,
        priority       INTEGER NOT NULL DEFAULT 100,
        enabled        INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (public_model, provider_id, upstream_model)
      )`,

      `CREATE TABLE api_keys (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        name             TEXT    NOT NULL,
        key              TEXT    NOT NULL UNIQUE,
        enabled          INTEGER NOT NULL DEFAULT 1,
        rate_limit_rpm   INTEGER NOT NULL DEFAULT 0,
        allowed_models   TEXT    NOT NULL DEFAULT '[]',
        created_at       INTEGER NOT NULL,
        last_used_at     INTEGER NOT NULL DEFAULT 0,
        total_requests   INTEGER NOT NULL DEFAULT 0
      )`,

      `CREATE TABLE usage_log (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id        TEXT    NOT NULL,
        ts                INTEGER NOT NULL,
        api_key_id        INTEGER,
        api_key_name      TEXT,
        endpoint          TEXT    NOT NULL,
        stream            INTEGER NOT NULL DEFAULT 0,
        public_model      TEXT    NOT NULL,
        provider_id       INTEGER,
        provider_name     TEXT,
        provider_kind     TEXT,
        upstream_model    TEXT,
        prompt_tokens     INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        cached_tokens     INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens  INTEGER NOT NULL DEFAULT 0,
        cost              REAL    NOT NULL DEFAULT 0,
        currency          TEXT    NOT NULL DEFAULT 'USD',
        attempts          INTEGER NOT NULL DEFAULT 1,
        status            INTEGER NOT NULL DEFAULT 200,
        error_kind        TEXT,
        error_message     TEXT,
        latency_ms        INTEGER NOT NULL DEFAULT 0,
        ttft_ms           INTEGER NOT NULL DEFAULT 0,
        client_ip         TEXT,
        user_agent        TEXT
      )`,
      `CREATE INDEX usage_log_ts ON usage_log (ts)`,
      `CREATE INDEX usage_log_provider ON usage_log (provider_id, ts)`,
      `CREATE INDEX usage_log_model ON usage_log (public_model, ts)`,
      `CREATE INDEX usage_log_key ON usage_log (api_key_id, ts)`,

      `CREATE TABLE provider_health (
        provider_id          INTEGER PRIMARY KEY REFERENCES providers(id) ON DELETE CASCADE,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        open_until           INTEGER NOT NULL DEFAULT 0,
        last_error           TEXT,
        last_error_at        INTEGER NOT NULL DEFAULT 0,
        last_success_at      INTEGER NOT NULL DEFAULT 0,
        last_latency_ms      INTEGER NOT NULL DEFAULT 0
      )`,

      `CREATE TABLE credits_snapshot (
        provider_id INTEGER PRIMARY KEY REFERENCES providers(id) ON DELETE CASCADE,
        payload     TEXT    NOT NULL,
        fetched_at  INTEGER NOT NULL,
        error       TEXT
      )`
    ]
  }
]
