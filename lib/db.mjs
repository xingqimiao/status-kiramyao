/**
 * Storage: two tables, and nothing that needs a build step.
 *
 * The handoff settled the shape and it survives contact with the queries: every
 * reading the page needs is a row in `probes`, and every published figure is a row
 * in `metrics`. There is no rollup table because there does not need to be one —
 * 90 days at a 30-minute cadence is ~4,300 probe rows per component plus ~90 CN
 * samples, and a `GROUP BY` over that is not work.
 *
 * `node:sqlite` is still flagged experimental, which is why the systemd unit sets
 * `NODE_NO_WARNINGS=1`. It is used rather than a dependency because the whole point
 * of this service is that it has no runtime dependencies to keep patched on a box
 * the operator reaches twice a year.
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const SCHEMA = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS probes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    -- 'local' (our own probe) or 'boce' (the mainland-China sample).
    source      TEXT    NOT NULL,
    -- 'site' | 'hrt_api' | 'comments_api' | 'hrt_web'
    component   TEXT    NOT NULL,
    at          INTEGER NOT NULL,
    ok          INTEGER NOT NULL,
    status_code INTEGER,
    latency_ms  REAL,
    error       TEXT,
    -- boce's per-node resolved region. The DNS signal, captured because it comes
    -- free with the HTTP check that is being paid for anyway.
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
`

export function openDb(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec(SCHEMA)
  return db
}

/**
 * Storage helpers, bound to one database handle.
 *
 * A factory rather than module-level functions so the tests can hold two
 * independent databases without either reaching into the other's connection.
 */
export function createStore(db) {
  const insertProbe = db.prepare(`
    INSERT INTO probes (source, component, at, ok, status_code, latency_ms, error, region)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const insertMetric = db.prepare('INSERT OR REPLACE INTO metrics (at, key, value) VALUES (?, ?, ?)')
  const recentProbes = db.prepare('SELECT * FROM probes WHERE at >= ? ORDER BY at ASC')
  const componentProbes = db.prepare(
    'SELECT * FROM probes WHERE component = ? AND at >= ? ORDER BY at ASC',
  )
  const sourceProbes = db.prepare(
    'SELECT * FROM probes WHERE source = ? AND at >= ? ORDER BY at ASC',
  )
  const latestProbe = db.prepare('SELECT * FROM probes WHERE component = ? ORDER BY at DESC LIMIT 1')
  const latestMetric = db.prepare('SELECT * FROM metrics WHERE key = ? ORDER BY at DESC LIMIT 1')
  const metricSeries = db.prepare('SELECT * FROM metrics WHERE key = ? AND at >= ? ORDER BY at ASC')

  return {
    /**
     * Record one reading.
     *
     * `at` defaults to now but is a parameter because the probe loop stamps a
     * whole round with one timestamp — a round that takes four seconds should not
     * produce readings four seconds apart, and the day boundaries it feeds are
     * exact.
     */
    addProbe({ source = 'local', component, at = Date.now(), ok, statusCode = null, latencyMs = null, error = null, region = null }) {
      insertProbe.run(
        source, component, at, ok ? 1 : 0,
        statusCode, latencyMs, error, region,
      )
    },

    addMetric(key, value, at = Date.now()) {
      insertMetric.run(at, key, value === null || value === undefined ? null : String(value))
    },

    /** Probes for one component since `since`, oldest first. */
    probesFor(component, since) {
      return componentProbes.all(component, since).map(fromRow)
    },

    /** Probes from one source since `since`, oldest first — used for the CN strip. */
    probesFrom(source, since) {
      return sourceProbes.all(source, since).map(fromRow)
    },

    /** Everything since `since`, for the incident pass across all components. */
    allProbes(since) {
      return recentProbes.all(since).map(fromRow)
    },

    latestFor(component) {
      const row = latestProbe.get(component)
      return row ? fromRow(row) : null
    },

    latestMetric(key) {
      const row = latestMetric.get(key)
      return row ? { at: row.at, value: row.value } : null
    },

    metricHistory(key, since) {
      return metricSeries.all(key, since).map((r) => ({ at: r.at, value: r.value }))
    },

    /**
     * Drop probe rows older than the window.
     *
     * Kept finite on purpose. The status page reads a 90-day window, and the CN
     * samples are the only thing here that was paid for — losing them to unbounded
     * growth on a small box would be the expensive kind of tidy.
     */
    prune(cutoff) {
      db.prepare('DELETE FROM probes WHERE at < ?').run(cutoff)
      db.prepare('DELETE FROM metrics WHERE at < ?').run(cutoff)
    },

    close() {
      db.close()
    },
  }
}

function fromRow(row) {
  return {
    id: row.id,
    source: row.source,
    component: row.component,
    at: row.at,
    ok: row.ok === 1,
    statusCode: row.status_code,
    latencyMs: row.latency_ms,
    error: row.error,
    region: row.region,
  }
}
