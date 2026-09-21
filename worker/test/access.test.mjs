/**
 * Access verification, against real RS256 signatures.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateKeyPairSync, sign } from 'node:crypto'

import { verifyAccessJwt } from '../src/access.mjs'
import { handleAdmin } from '../src/admin.mjs'
import { createD1Store } from '../src/db.mjs'
import { openMigratedDb, fakeD1 } from './helpers.mjs'

const TEAM = 'team.cloudflareaccess.com'
const AUD = 'aud-tag-123'
const KID = 'key-1'
const NOW = Date.UTC(2026, 8, 17, 12, 0, 0)

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' }

const b64 = (value) => Buffer.from(value).toString('base64url')
function makeToken(overrides = {}, { key = privateKey, kid = KID } = {}) {
  const header = { alg: 'RS256', kid, typ: 'JWT' }
  const payload = {
    iss: `https://${TEAM}`,
    aud: [AUD],
    exp: Math.floor(NOW / 1000) + 3600,
    iat: Math.floor(NOW / 1000) - 60,
    email: 'ops@example.com',
    sub: 'sub-1',
    ...overrides,
  }
  const body = `${b64(JSON.stringify(header))}.${b64(JSON.stringify(payload))}`
  const signature = sign('RSA-SHA256', Buffer.from(body), key)
  return `${body}.${signature.toString('base64url')}`
}

const jwksFetch = async () => ({ ok: true, json: async () => ({ keys: [jwk] }) })
const config = { access: { teamDomain: TEAM, aud: AUD }, publicOrigin: 'https://status.kiramyao.com', basePath: '' }
const opts = { fetchImpl: jwksFetch, now: NOW }

test('a correctly signed assertion from the right team is accepted', async () => {
  const result = await verifyAccessJwt(makeToken(), config, opts)
  assert.equal(result.ok, true)
  assert.equal(result.email, 'ops@example.com')
})

test('no assertion at all is refused', async () => {
  assert.equal((await verifyAccessJwt(null, config, opts)).ok, false)
})

test('a wrong audience is refused', async () => {
  const result = await verifyAccessJwt(makeToken({ aud: ['someone-else'] }), config, opts)
  assert.equal(result.ok, false)
  assert.match(result.error, /audience/)
})

test('an expired assertion is refused', async () => {
  const result = await verifyAccessJwt(makeToken({ exp: Math.floor(NOW / 1000) - 10 }), config, opts)
  assert.equal(result.ok, false)
  assert.match(result.error, /expired/)
})

test('a wrong issuer is refused', async () => {
  const result = await verifyAccessJwt(makeToken({ iss: 'https://evil.example' }), config, opts)
  assert.equal(result.ok, false)
  assert.match(result.error, /issuer/)
})

test('a tampered signature is refused', async () => {
  const token = makeToken()
  const parts = token.split('.')
  const bad = `${parts[0]}.${parts[1]}.${'A'.repeat(parts[2].length)}`
  const result = await verifyAccessJwt(bad, config, opts)
  assert.equal(result.ok, false)
})

test('a token signed by a different key is refused', async () => {
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const result = await verifyAccessJwt(makeToken({}, { key: other.privateKey }), config, opts)
  assert.equal(result.ok, false)
})

test('an unknown kid is refused', async () => {
  const result = await verifyAccessJwt(makeToken({}, { kid: 'nope' }), config, opts)
  assert.equal(result.ok, false)
  assert.match(result.error, /key/)
})

test('the admin route answers 403 (not a redirect) when the assertion is missing', async () => {
  const store = createD1Store(fakeD1(openMigratedDb()))
  const request = new Request('https://status.kiramyao.com/admin')
  const response = await handleAdmin(request, {}, config, store, opts)
  assert.equal(response.status, 403)
  assert.equal(response.headers.get('location'), null, 'no redirect loop')
})
