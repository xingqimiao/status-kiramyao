/**
 * The small HTTP surface shared by the public page and the admin. Headers are the same
 * ones server.mjs sets; the public policy stays script-free and third-party-free.
 */
export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
}

/** The admin page has forms, so form-action 'self'; still no scripts, still no-store. */
export const ADMIN_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
}

export function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...headers },
  })
}

export function text(status, body, headers = {}) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS, ...headers },
  })
}

export function html(status, body, headers = {}) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...SECURITY_HEADERS, ...headers },
  })
}

export function stripBasePath(pathname, config) {
  if (!config.basePath) return pathname
  if (pathname === config.basePath) return '/'
  if (pathname.startsWith(`${config.basePath}/`)) return pathname.slice(config.basePath.length)
  return null
}
