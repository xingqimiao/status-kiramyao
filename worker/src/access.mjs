/**
 * Cloudflare Access assertion verification, inside the Worker.
 *
 * The Access policy is attached to the hostname. status.kiramyao.com/admin is behind it,
 * but the Worker itself is a separate ingress: a workers.dev route (or a preview URL)
 * usually is not covered by that policy. So the Worker does not trust that Access ran.
 * It requires a `Cf-Access-Jwt-Assertion` that it verifies itself -- RS256 signature
 * against the team's published JWKS, plus issuer, audience and expiry -- and anything
 * that fails is a 403, never a redirect.
 *
 * The JWKS is cached in the isolate for ten minutes; it is published by Access, not by
 * the reader, so this is a server-side request and the page's no-third-party promise
 * is untouched.
 */

const JWKS_TTL_MS = 10 * 60 * 1000
let jwksCache = { at: 0, team: '', keys: [] }

function b64urlToBytes(value) {
  const s = String(value).replace(/-/g, '+').replace(/_/g, '/')
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  const binary = atob(s + pad)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

function b64urlToJson(value) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(value)))
}

async function loadJwks(team, { fetchImpl, now }) {
  if (jwksCache.team === team && now - jwksCache.at < JWKS_TTL_MS && jwksCache.keys.length > 0) {
    return { ok: true, keys: jwksCache.keys }
  }
  try {
    const res = await fetchImpl(`https://${team}/cdn-cgi/access/certs`)
    if (!res.ok) return { ok: false, error: `JWKS HTTP ${res.status}` }
    const body = await res.json()
    const keys = Array.isArray(body?.keys) ? body.keys : []
    if (keys.length === 0) return { ok: false, error: 'JWKS had no keys' }
    jwksCache = { at: now, team, keys }
    return { ok: true, keys }
  } catch (error) {
    return { ok: false, error: `JWKS fetch failed: ${error?.message ?? error}` }
  }
}

/**
 * Verify one assertion. Returns { ok: true, email, sub, payload } or { ok: false, error }.
 * Never throws: the caller turns a failure into 403.
 */
export async function verifyAccessJwt(token, config, { fetchImpl = fetch, now = Date.now() } = {}) {
  const team = config.access?.teamDomain
  if (!team) return { ok: false, error: 'ACCESS_TEAM_DOMAIN not configured' }
  if (!config.access?.aud) return { ok: false, error: 'ACCESS_AUD not configured' }
  if (!token || typeof token !== 'string') return { ok: false, error: 'no assertion' }

  const parts = token.split('.')
  if (parts.length !== 3) return { ok: false, error: 'malformed assertion' }

  let header
  let payload
  try {
    header = b64urlToJson(parts[0])
    payload = b64urlToJson(parts[1])
  } catch {
    return { ok: false, error: 'undecodable assertion' }
  }
  if (header.alg !== 'RS256') return { ok: false, error: `unexpected alg ${header.alg}` }

  const jwks = await loadJwks(team, { fetchImpl, now })
  if (!jwks.ok) return jwks
  const jwk = jwks.keys.find((k) => k.kid === header.kid)
  if (!jwk) return { ok: false, error: 'signing key not found' }

  let valid = false
  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      { ...jwk, alg: 'RS256', use: 'sig' },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    )
    valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      b64urlToBytes(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    )
  } catch (error) {
    return { ok: false, error: `signature check failed: ${error?.message ?? error}` }
  }
  if (!valid) return { ok: false, error: 'signature invalid' }

  if (payload.iss !== `https://${team}`) return { ok: false, error: 'issuer mismatch' }
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
  if (!aud.includes(config.access.aud)) return { ok: false, error: 'audience mismatch' }

  const nowSec = Math.floor(now / 1000)
  if (typeof payload.exp === 'number' && nowSec >= payload.exp) return { ok: false, error: 'expired' }
  if (typeof payload.nbf === 'number' && nowSec < payload.nbf - 30) return { ok: false, error: 'not yet valid' }

  return {
    ok: true,
    email: payload.email ?? payload.sub ?? 'unknown',
    sub: payload.sub ?? null,
    payload,
  }
}

/** Constant-time-ish string compare for the heartbeat token. */
export function timingSafeEqual(a, b) {
  const x = String(a ?? '')
  const y = String(b ?? '')
  if (x.length !== y.length) return false
  let diff = 0
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i)
  return diff === 0
}
