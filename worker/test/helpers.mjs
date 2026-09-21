/**
 * Test helpers. The Worker's storage interface is D1; these wrap node:sqlite with the
 * subset of the D1 prepared-statement API the Worker uses, so the port can be exercised
 * for real without a network or a wrangler install.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const MIGRATION = readFileSync(resolve(import.meta.dirname, '..', 'migrations', '0001_init.sql'), 'utf8')

/** An in-memory database with exactly the D1 migration applied (no WAL, no AUTOINCREMENT). */
export function openMigratedDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(MIGRATION)
  return db
}

const result = (results) => ({ results, success: true, meta: {} })

function bound(stmt, args) {
  return {
    all: async () => result(stmt.all(...args)),
    first: async () => stmt.all(...args)[0] ?? null,
    run: async () => { stmt.run(...args); return result([]) },
  }
}

/** The D1 binding surface createD1Store uses: prepare().bind()/.all()/.first()/.run(), batch, exec. */
export function fakeD1(db) {
  return {
    prepare(sql) {
      const stmt = db.prepare(sql)
      return {
        bind: (...args) => bound(stmt, args),
        all: async () => result(stmt.all()),
        first: async () => stmt.all()[0] ?? null,
        run: async () => { stmt.run(); return result([]) },
      }
    },
    async batch(stmts) {
      return Promise.all(stmts.map((s) => s.run()))
    },
    async exec(sql) {
      db.exec(sql)
    },
  }
}
