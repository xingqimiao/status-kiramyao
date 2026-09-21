#!/usr/bin/env node
/**
 * Export the origin's node:sqlite history as SQL that D1 can import.
 *
 * This is the migration step for the data (the schema is worker/migrations/). The two
 * databases are both SQLite, so the rows move as plain INSERTs; what does not transfer
 * is anything the Worker no longer reads, and events (manual declarations) are
 * deliberately not exported -- the new admin authors those from scratch.
 *
 *   node bin/export-d1.mjs --days=90 > /tmp/status.sql
 *   npx wrangler d1 execute kira-status --remote --file /tmp/status.sql
 *
 * There is no BEGIN/COMMIT wrapper: D1 does not support explicit transactions in an
 * import, and the table is empty at that point. Verify the counts before and after.
 */
import { DatabaseSync } from 'node:sqlite'

import { loadConfig } from '../lib/config.mjs'

const DAY_MS = 24 * 60 * 60 * 1000
const daysArg = process.argv.find((a) => a.startsWith('--days='))
const days = Number(daysArg ? daysArg.split('=')[1] : 90)
if (!Number.isFinite(days) || days <= 0) {
  process.stderr.write('--days must be a positive number\n')
  process.exit(2)
}

const config = loadConfig()
const db = new DatabaseSync(config.dataFile, { readOnly: true })
const cutoff = Date.now() - days * DAY_MS

const sql = (value) => {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL'
  return `'${String(value).replace(/'/g, "''")}'`
}

const probes = db.prepare(
  'SELECT source, component, at, ok, status_code, latency_ms, error, region FROM probes WHERE at >= ? ORDER BY at',
).all(cutoff)
const metrics = db.prepare('SELECT at, key, value FROM metrics WHERE at >= ? ORDER BY at').all(cutoff)
db.close()

const out = []
out.push('-- kira-status: origin history exported for D1')
out.push(`-- window: last ${days} days; probes=${probes.length} metrics=${metrics.length}`)
out.push('-- Import into an empty database (the migration creates the tables).')
out.push('')

for (const p of probes) {
  out.push(
    'INSERT INTO probes (source, component, at, ok, status_code, latency_ms, error, region) VALUES ('
    + [p.source, p.component, p.at, p.ok, p.status_code, p.latency_ms, p.error, p.region].map(sql).join(', ') + ');',
  )
}
out.push('')
for (const m of metrics) {
  out.push('INSERT OR REPLACE INTO metrics (at, key, value) VALUES ('
    + [m.at, m.key, m.value].map(sql).join(', ') + ');')
}
process.stdout.write(out.join('\n') + '\n')
