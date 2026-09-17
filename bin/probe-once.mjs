#!/usr/bin/env node
/**
 * Run one probe round and print what happened, without starting the server.
 *
 * For the operator: this is how you answer "is it the target or is it me" before
 * reading any code, and how a first deploy is verified without waiting for the
 * first interval. It writes to the same database the service uses.
 *
 *   node bin/probe-once.mjs            # local probes + metrics
 *   node bin/probe-once.mjs --boce     # also spend the boce call
 */
import { loadConfig } from '../lib/config.mjs'
import { openDb, createStore } from '../lib/db.mjs'
import { runLocalProbes, runBoceProbe, readHrtStats, readCommentsStats, readStoryCount } from '../lib/probe.mjs'

const config = loadConfig()
const db = openDb(config.dataFile)
const store = createStore(db)

const withBoce = process.argv.includes('--boce')

process.stdout.write('local probes:\n')
const results = await runLocalProbes(store, config.targets)
for (const r of results) {
  const status = r.ok ? 'ok  ' : 'FAIL'
  process.stdout.write(
    `  ${status} ${r.component.padEnd(16)} ${String(r.statusCode ?? '-').padEnd(5)} ${String(r.latencyMs).padStart(5)}ms ${r.error ?? ''}\n`,
  )
}

process.stdout.write('\ndata guardian:\n')
const [hrt, comments, stories] = await Promise.all([
  readHrtStats(config.stats.hrt),
  readCommentsStats(config.stats.comments),
  readStoryCount(config.stats.stories),
])
process.stdout.write(`  hrt      ${hrt.ok ? `${hrt.accounts} accounts, ${hrt.records} records, ${hrt.selfDeletions} self-deletions` : `unavailable (${hrt.error})`}\n`)
process.stdout.write(`  comments ${comments.ok ? `${comments.users} users, ${comments.comments} comments` : `unavailable (${comments.error})`}\n`)
process.stdout.write(`  stories  ${stories.ok ? `${stories.stories} preserved` : `unavailable (${stories.error})`}\n`)

if (withBoce) {
  process.stdout.write('\nboce (this spends wav-points):\n')
  if (!config.boce.enabled) {
    process.stdout.write('  disabled — set BOCE_ENABLED=true and BOCE_API_KEY to spend it\n')
  } else {
    const result = await runBoceProbe(store, config.boce)
    process.stdout.write(`  ${JSON.stringify(result)}\n`)
  }
}

store.close()
