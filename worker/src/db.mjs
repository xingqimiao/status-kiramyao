/**
 * Storage, on D1.
 *
 * The two history tables and every SELECT are lifted from lib/db.mjs; what changed is
 * the calling convention, and one shape decision:
 *
 *   - D1 is asynchronous (PreparedStatement.bind(...).all()/first()/run()), so the
 *     store's methods are async and the snapshot assembler awaits them once per
 *     request. That is the whole of the port for CRUD.
 *
 *   - The old `allProbes(since)` returned every row and did the grouping in JS. D1
 *     bills and CPU-charges rows *read*, and a 90-day window at a 10-minute cadence is
 *     ~13,000 rows per component, so shipping them into the Worker every request would
 *     be ~65,000 rows of deserialization inside a 10 ms (Free) CPU budget. The
 *     aggregate queries below push the grouping into SQL and return a few hundred rows
 *     instead: day counts (~450), newest round (<=5), compressed runs (a handful), and
 *     failing probes only. worker/test/port.test.mjs proves the result equals the
 *     JS-side lib/snapshot.mjs over the same seeded data.
 */

export function createD1Store(db) {
  const all = async (sql, ...args) => (await db.prepare(sql).bind(...args).all()).results ?? []
  const one = async (sql, ...args) => db.prepare(sql).bind(...args).first()

  return {
    /** One probe reading. Same columns as lib/db.mjs addProbe. */
    async addProbe({ source = 'local', component, at = Date.now(), ok, statusCode = null, latencyMs = null, error = null, region = null }) {
      await db.prepare(
        'INSERT INTO probes (source, component, at, ok, status_code, latency_ms, error, region) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(source, component, at, ok ? 1 : 0, statusCode, latencyMs, error, region).run()
    },

    /**
     * One external prober round, replaced atomically.
     *
     * The prober cannot say "this is a retry", so the round is its timestamp bucket
     * (worker/src/ingest.mjs derives it). Deleting that `at` before inserting makes a
     * repeated POST a no-op rather than a second round, and D1's batch is one
     * transaction, so a half-written round cannot survive. `region` stays NULL: the
     * closed ingest schema has no field for it, and it is boce's per-node dimension.
     */
    async replaceExternalProbes(at, rows) {
      await db.batch([
        db.prepare("DELETE FROM probes WHERE source = 'external' AND at = ?").bind(at),
        ...rows.map((row) => db.prepare(
          'INSERT INTO probes (source, component, at, ok, status_code, latency_ms, error, region) '
          + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ).bind('external', row.component, at, row.ok ? 1 : 0, row.statusCode, row.latencyMs, row.error, null)),
      ])
    },

    /** Same INSERT OR REPLACE as lib/db.mjs. value is stringified, null stays null. */
    async addMetric(key, value, at = Date.now()) {
      await db.prepare('INSERT OR REPLACE INTO metrics (at, key, value) VALUES (?, ?, ?)')
        .bind(at, key, value === null || value === undefined ? null : String(value)).run()
    },

    /** Per-component, per-GMT+8-day totals. The day cut is the same expression the page uses. */
    dayCounts(since, offsetMs) {
      return all(
        'SELECT component, CAST((at + ?) / 86400000 AS INTEGER) AS day_index, COUNT(*) AS total, SUM(ok) AS ok '
        + 'FROM probes WHERE at >= ? GROUP BY component, day_index',
        offsetMs, since,
      )
    },

    /** The newest round per component: what currentState judges. */
    newestRounds(since) {
      return all(
        'SELECT component, at, total, ok FROM ('
        + '  SELECT component, at, COUNT(*) AS total, SUM(ok) AS ok, '
        + '         ROW_NUMBER() OVER (PARTITION BY component ORDER BY at DESC) AS rn '
        + '  FROM probes WHERE at >= ? GROUP BY component, at'
        + ') WHERE rn = 1',
        since,
      )
    },

    /**
     * Probe runs, collapsed in SQL. A healthy 90-day window is one row per component
     * instead of 13,000. This is the input `incidentsFromRuns` expects (from/lastAt/n),
     * so the incident rule itself stays in one place (lib/incidents.mjs).
     */
    runs(since) {
      return all(
        'WITH ordered AS ('
        + '  SELECT component, at, ok, LAG(ok) OVER (PARTITION BY component ORDER BY at) AS prev '
        + '  FROM probes WHERE at >= ?'
        + '), marked AS ('
        + '  SELECT component, at, ok, SUM(CASE WHEN prev IS NULL OR prev <> ok THEN 1 ELSE 0 END) '
        + '         OVER (PARTITION BY component ORDER BY at ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS grp '
        + '  FROM ordered'
        + ') '
        + 'SELECT component, ok, MIN(at) AS from_at, MAX(at) AS last_at, COUNT(*) AS n '
        + 'FROM marked GROUP BY component, grp, ok ORDER BY component, from_at',
        since,
      )
    },

    /**
     * Only the failing probes. Failed runs need one row per failure to reconstruct
     * `failedProbes` and the last error; a healthy window returns nothing. Ceiling: a
     * window that was failing the whole time returns one row per probe. ponytail: the
     * upgrade path is a per-run `last_error` column if that ever matters.
     */
    failedProbes(since) {
      return all(
        'SELECT component, at, error FROM probes WHERE at >= ? AND ok = 0 ORDER BY component, at',
        since,
      )
    },

    /** The newest reading for one component, for the health check. */
    latestProbe(component) {
      return one(
        'SELECT at, ok, status_code AS statusCode, latency_ms AS latencyMs, error '
        + 'FROM probes WHERE component = ? ORDER BY at DESC LIMIT 1',
        component,
      )
    },

    /** Newest value per metric key. Same semantics as lib/db.mjs latestMetric. */
    async latestMetrics() {
      const rows = await all(
        'SELECT m.key AS key, m.value AS value, m.at AS at FROM metrics m '
        + 'JOIN (SELECT key, MAX(at) AS at FROM metrics GROUP BY key) x '
        + 'ON x.key = m.key AND x.at = m.at',
      )
      const map = new Map()
      for (const row of rows) map.set(row.key, { value: row.value, at: row.at })
      return map
    },

    // --- manual declarations (the Access-gated /admin) ------------------------

    async listEvents(limit = 50) {
      const rows = await all(
        'SELECT id, severity, reason, started_at, created_at, created_by, resolved_at, resolved_by '
        + 'FROM events ORDER BY created_at DESC, id DESC LIMIT ?',
        limit,
      )
      return rows.map(fromEventRow)
    },

    /** Returns the new row. INSERT ... RETURNING id is one statement, so no last_rowid race. */
    async createEvent({ severity, reason, startedAt, createdAt, createdBy }) {
      const row = await one(
        'INSERT INTO events (severity, reason, started_at, created_at, created_by) '
        + 'VALUES (?, ?, ?, ?, ?) RETURNING id, severity, reason, started_at, created_at, created_by, resolved_at, resolved_by',
        severity, reason, startedAt, createdAt, createdBy,
      )
      return fromEventRow(row)
    },

    /**
     * "Declare recovered": sets resolved_at exactly once. Returns the row, or null if
     * it was already resolved (so a double submit is a no-op rather than a rewrite of
     * the audit trail).
     */
    async resolveEvent(id, { resolvedAt, resolvedBy }) {
      const row = await one(
        'UPDATE events SET resolved_at = ?, resolved_by = ? WHERE id = ? AND resolved_at IS NULL '
        + 'RETURNING id, severity, reason, started_at, created_at, created_by, resolved_at, resolved_by',
        resolvedAt, resolvedBy, id,
      )
      return row ? fromEventRow(row) : null
    },

    /** Drop history outside the window, exactly as lib/db.mjs prune. */
    async prune(cutoff) {
      await db.batch([
        db.prepare('DELETE FROM probes WHERE at < ?').bind(cutoff),
        db.prepare('DELETE FROM metrics WHERE at < ?').bind(cutoff),
      ])
    },
  }
}

function fromEventRow(row) {
  if (!row) return null
  return {
    id: row.id,
    severity: row.severity,
    reason: row.reason,
    startedAt: row.started_at,
    createdAt: row.created_at,
    createdBy: row.created_by,
    resolvedAt: row.resolved_at ?? null,
    resolvedBy: row.resolved_by ?? null,
  }
}
