/**
 * The freshness contract: a unique URL, a cache bypass on the request, no-store required
 * on the response, and the nonce echo where the origin can give it.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { COMPONENTS } from '../../lib/components.mjs'
import { createD1Store } from '../src/db.mjs'
import { runWorkerProbeRound } from '../src/probe.mjs'
import { openMigratedDb, fakeD1 } from './helpers.mjs'

const NOW = Date.UTC(2026, 8, 17, 12, 0, 0)

const makeConfig = () => ({
  probeIntervalMinutes: 10,
  targets: Object.fromEntries(COMPONENTS.filter((c) => c.local).map((c) => [c.id, `https://${c.id}.example/`])),
  echoNonce: Object.fromEntries(COMPONENTS.map((c) => [c.id, !!c.echoNonce])),
})

const store = () => createD1Store(fakeD1(openMigratedDb()))

function goodResponse(url, { body = null } = {}) {
  const nonce = new URL(url).searchParams.get('nonce')
  return new Response(body ?? JSON.stringify({ ok: true, nonce }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache',
      'X-Probe-Nonce': nonce,
    },
  })
}

test('every probe uses a unique URL and asks Cloudflare not to cache it', async () => {
  const calls = []
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, opts })
    return goodResponse(url)
  }
  await runWorkerProbeRound(store(), makeConfig(), { now: NOW, fetchImpl })

  const nonces = calls.map((c) => new URL(c.url).searchParams.get('nonce'))
  assert.equal(new Set(nonces).size, nonces.length, 'every probe URL is unique')
  assert.ok(nonces.every((n) => n && n.length >= 16), 'the nonce is meaningful')
  for (const call of calls) {
    assert.deepEqual(call.opts.cf, { cacheTtl: 0, cacheEverything: false })
    assert.equal(call.opts.headers['Cache-Control'], 'no-cache')
    assert.equal(call.opts.headers.Pragma, 'no-cache')
  }
})

test('a 200 that does not echo the nonce is a failure, not a pass', async () => {
  const results = await runWorkerProbeRound(store(), makeConfig(), {
    now: NOW,
    fetchImpl: async () => new Response('{"ok":true}', {
      status: 200,
      headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate', Pragma: 'no-cache' },
    }),
  })
  const api = results.find((r) => r.component === 'hrt_api')
  assert.equal(api.ok, false, 'a replayed or non-reflecting response is not evidence of an origin')
  assert.match(api.error, /nonce not echoed/)
  // A static row (echoNonce false) is allowed through on layers 1 and 2.
  const site = results.find((r) => r.component === 'site_overseas')
  assert.equal(site.ok, true)
})

test('a response without no-store is a failure', async () => {
  const results = await runWorkerProbeRound(store(), makeConfig(), {
    now: NOW,
    fetchImpl: async (url) => goodResponse(url, {}).headers.get('cache-control') && new Response(
      JSON.stringify({ nonce: new URL(url).searchParams.get('nonce') }),
      { status: 200, headers: { 'Cache-Control': 'public, max-age=60' } },
    ),
  })
  const api = results.find((r) => r.component === 'hrt_api')
  assert.equal(api.ok, false)
  assert.match(api.error, /non-reusable/)
})

test('cf-cache-status: HIT is a failure even with a correct body', async () => {
  const results = await runWorkerProbeRound(store(), makeConfig(), {
    now: NOW,
    fetchImpl: async (url) => {
      const nonce = new URL(url).searchParams.get('nonce')
      return new Response(JSON.stringify({ nonce }), {
        status: 200,
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          Pragma: 'no-cache',
          'cf-cache-status': 'HIT',
        },
      })
    },
  })
  const api = results.find((r) => r.component === 'hrt_api')
  assert.equal(api.ok, false)
  assert.match(api.error, /cached copy/)
})

test('an Age header older than the request is a failure', async () => {
  const results = await runWorkerProbeRound(store(), makeConfig(), {
    now: NOW,
    fetchImpl: async (url) => {
      const nonce = new URL(url).searchParams.get('nonce')
      return new Response(JSON.stringify({ nonce }), {
        status: 200,
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          Pragma: 'no-cache',
          Age: '42',
        },
      })
    },
  })
  assert.equal(results.find((r) => r.component === 'hrt_api').ok, false)
})

test('a genuinely fresh, echoing, no-store response passes', async () => {
  const results = await runWorkerProbeRound(store(), makeConfig(), {
    now: NOW,
    fetchImpl: async (url) => goodResponse(url),
  })
  assert.ok(results.every((r) => r.ok), JSON.stringify(results.map((r) => [r.component, r.error])))
})

test('max-age=0 with must-revalidate counts as non-reusable (what Pages emits)', async () => {
  const results = await runWorkerProbeRound(store(), makeConfig(), {
    now: NOW,
    fetchImpl: async (url) => {
      const nonce = new URL(url).searchParams.get('nonce')
      return new Response(JSON.stringify({ nonce }), {
        status: 200,
        headers: { 'Cache-Control': 'public, max-age=0, must-revalidate' },
      })
    },
  })
  assert.ok(results.every((r) => r.ok), JSON.stringify(results.map((r) => [r.component, r.error])))
})
