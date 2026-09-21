#!/usr/bin/env node
/**
 * One command that checks all three freshness layers against the LIVE origins.
 *
 *   node worker/verify-freshness.mjs
 *
 * Run it after the origin patch (worker/ORIGIN-CONTRACT.md) is deployed. It exits non-zero
 * if any target fails a layer, so it is usable as a cutover gate.
 *
 * Caveat it prints and honours: Node's fetch has no `cf` request option, so the Worker-only
 * `cacheTtl: 0` half of layer 1 cannot be exercised from a laptop; worker/test/probe.test.mjs
 * asserts that the option is sent.
 */
import { probeFresh, probeNonce } from './src/probe.mjs'

/** Kept in sync with worker/wrangler.toml [vars]; see ORIGIN-CONTRACT.md section 2. */
const TARGETS = [
  { component: 'comments_api', url: 'https://api.kiramyao.com/comments/health', echo: true },
  { component: 'hrt_api', url: 'https://api.kiramyao.com/hrt/health', echo: true },
  { component: 'hrt_mcp', url: 'https://api.kiramyao.com/hrt/mcp/health', echo: true },
  { component: 'hrt_web', url: 'https://hrt.kiramyao.com/.well-known/status-probe.txt', echo: false },
  { component: 'site_overseas', url: 'https://kiramyao.com/.well-known/status-probe.txt', echo: false },
]

/** Node's fetch would choke on (or silently ignore) the Workers-only `cf` option. Strip it. */
const fetchImpl = (url, opts = {}) => {
  const { cf, ...rest } = opts
  return fetch(url, rest)
}

const isCached = (r) => /^(HIT|STALE|UPDATING)$/i.test(r.cacheStatus ?? '') || (r.ageSeconds ?? 0) > 0
const pad = (s, n) => String(s).padEnd(n)

let failed = false
for (const target of TARGETS) {
  const a = await probeFresh(target.url, { nonce: probeNonce(), expectEcho: target.echo, fetchImpl })
  const b = await probeFresh(target.url, { nonce: probeNonce(), expectEcho: target.echo, fetchImpl })

  const layer1 = a.nonce !== b.nonce
  const layer2 = a.nonCacheable && b.nonCacheable && !isCached(a) && !isCached(b)
  const layer3 = target.echo ? (a.echoed && b.echoed) : null
  const pass = a.ok && b.ok
  if (!pass) failed = true

  console.log('')
  console.log(`${pad(target.component, 15)} ${target.url}`)
  console.log(`${pad('', 15)} status=${a.statusCode ?? 'ERR'}  cache-control=${JSON.stringify(a.cacheControl || 'absent')}  cf-cache-status=${a.cacheStatus ?? '-'}  age=${a.ageSeconds ?? '-'}`)
  console.log(`${pad('', 15)} layer1 unique-url=${layer1 ? 'PASS' : 'FAIL'}  `
    + `layer2 non-reusable=${layer2 ? 'PASS' : 'FAIL'}  `
    + `layer3 nonce-echo=${layer3 === null ? 'n/a (static)' : (layer3 ? 'PASS' : 'FAIL')}  => ${pass ? 'PASS' : 'FAIL'}`)
  if (!a.ok && a.error) console.log(`${pad('', 15)} reason: ${a.error}`)
}

console.log('')
console.log(failed
  ? 'RESULT: FAIL -- a layer is not working. Apply worker/ORIGIN-CONTRACT.md and re-run.'
  : 'RESULT: PASS -- all three layers verified live.')
process.exitCode = failed ? 1 : 0
