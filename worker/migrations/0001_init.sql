-- 0001_init.sql — the D1 schema.
--
-- Ported from lib/db.mjs. Two changes from the node:sqlite original, both forced:
--
--   1. PRAGMA journal_mode = WAL is gone. D1 supports only a fixed PRAGMA allow-list
--      (table_list, table_info, optimize, foreign_keys, ...), not journal_mode; D1
--      manages durability itself.
--   2. AUTOINCREMENT is gone. D1 runs SQLite, where "INTEGER PRIMARY KEY" is already
--      the rowid alias; AUTOINCREMENT only adds a sequence table D1 recommends avoiding.
--      Nothing here depends on ids being gap-free or monotonic.
--
-- The two history tables keep their exact column names, so the existing SELECT/INSERT
-- statements port with only the async D1 calling convention changed (worker/src/db.mjs).

CREATE TABLE IF NOT EXISTS probes (
    id          INTEGER PRIMARY KEY,
    -- 'local' (the old in-Worker probe; no longer written -- see worker/src/index.mjs),
    -- 'external' (the out-of-zone prober's report, worker/src/ingest.mjs) or 'boce' (the
    -- mainland-China sample; the Worker does not run boce, but the column stays so an
    -- import from the origin keeps its shape).
    source      TEXT    NOT NULL,
    component   TEXT    NOT NULL,
    at          INTEGER NOT NULL,
    ok          INTEGER NOT NULL,
    status_code INTEGER,
    latency_ms  REAL,
    error       TEXT,
    region      TEXT
);
CREATE INDEX IF NOT EXISTS idx_probes_component_at ON probes(component, at);
CREATE INDEX IF NOT EXISTS idx_probes_source_at    ON probes(source, at);

CREATE TABLE IF NOT EXISTS metrics (
    at    INTEGER NOT NULL,
    key   TEXT    NOT NULL,
    value TEXT,
    PRIMARY KEY (at, key)
);
CREATE INDEX IF NOT EXISTS idx_metrics_key_at ON metrics(key, at);

-- Manual declarations, authored only through the Cloudflare Access-gated /admin.
--
-- One row per declaration. An event is in force from started_at until resolved_at is
-- set by the explicit "declare recovered" action; a NULL resolved_at means "still in
-- force". Severity is a closed enum, and reason is the only free-text field in the
-- database -- it is authored by an authenticated operator, never by the heartbeat.
CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY,
    severity    TEXT    NOT NULL CHECK (severity IN ('partial', 'full', 'maintenance')),
    reason      TEXT    NOT NULL,
    -- When the condition took effect (operator-supplied, may precede the entry).
    started_at  INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    created_by  TEXT    NOT NULL,
    -- When the operator declared recovery; NULL while the declaration is in force.
    resolved_at INTEGER,
    resolved_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_resolved ON events(resolved_at);
CREATE INDEX IF NOT EXISTS idx_events_started  ON events(started_at);
