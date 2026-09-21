/**
 * The manual-declaration backend, behind Cloudflare Access.
 *
 * Two independent gates, deliberately:
 *   1. the Access application on status.kiramyao.com (hostname-level), and
 *   2. verifyAccessJwt() below, which the Worker runs itself because a workers.dev
 *      route would otherwise reach this handler without the policy.
 * Failure is a 403 response, never a redirect -- a redirect is what turns a bad
 * assertion into a login loop.
 *
 * The audit identity is Access's own claim (email / sub); there is no account system
 * here and nothing is typed by the operator as "who I am".
 */
import { verifyAccessJwt } from './access.mjs'
import { STATUS_UTC_OFFSET_MS } from '../../lib/aggregate.mjs'
import { ADMIN_HEADERS } from './http.mjs'

const SEVERITIES = new Set(['partial', 'full', 'maintenance'])
const REASON_MAX = 1000

const esc = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;')

/** The page's GMT+8 clock, not the Worker's UTC one. */
const statusTime = (atMs) => new Date(atMs + STATUS_UTC_OFFSET_MS).toISOString().replace('T', ' ').slice(0, 16)

function deny(error) {
  return new Response(`forbidden\n${error}\n`, {
    status: 403,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', ...ADMIN_HEADERS },
  })
}

function bad(error) {
  return new Response(`bad request\n${error}\n`, {
    status: 400,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', ...ADMIN_HEADERS },
  })
}

export async function handleAdmin(request, env, config, store, { now = Date.now(), fetchImpl = fetch } = {}) {
  const assertion = request.headers.get('Cf-Access-Jwt-Assertion')
  const verdict = await verifyAccessJwt(assertion, config, { fetchImpl, now })
  if (!verdict.ok) return deny(verdict.error)

  if (request.method === 'POST') {
    // The form is same-origin; a cross-site post would carry a foreign Origin. This is
    // defence in depth behind the Access cookie, not a replacement for it.
    const origin = request.headers.get('Origin') ?? refererOrigin(request.headers.get('Referer'))
    if (origin !== config.publicOrigin) return deny('cross-origin form submission')

    let form
    try {
      form = await request.formData()
    } catch {
      return bad('expected a form body')
    }
    const action = String(form.get('action') ?? '')

    if (action === 'create') {
      const severity = String(form.get('severity') ?? '')
      const reason = String(form.get('reason') ?? '').trim()
      if (!SEVERITIES.has(severity)) return bad('severity must be partial, full or maintenance')
      if (reason.length < 1 || reason.length > REASON_MAX) return bad(`reason must be 1..${REASON_MAX} characters`)
      const startedAt = parseStartedAt(form.get('started_at'), now)
      if (startedAt === null) return bad('started_at must be YYYY-MM-DDTHH:MM (GMT+8)')
      await store.createEvent({ severity, reason, startedAt, createdAt: now, createdBy: verdict.email })
    } else if (action === 'resolve') {
      const id = Number(form.get('id'))
      if (!Number.isInteger(id) || id <= 0) return bad('a numeric event id is required')
      // Returns null if it was already resolved; a double submit does not rewrite the
      // audit trail. Either way the operator lands back on the list.
      await store.resolveEvent(id, { resolvedAt: now, resolvedBy: verdict.email })
    } else {
      return bad('unknown action')
    }

    return Response.redirect(`${config.publicOrigin}${config.basePath}/admin`, 303)
  }

  const events = await store.listEvents(50)
  return new Response(renderAdmin(events, verdict, config), {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...ADMIN_HEADERS },
  })
}

/**
 * A datetime-local value is wall-clock with no zone. The operator's and the page's
 * clock are both GMT+8 (the day boundary is), so it is interpreted as GMT+8 explicitly.
 * Empty means "now".
 */
function parseStartedAt(raw, now) {
  const value = String(raw ?? '').trim()
  if (value === '') return now
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null
  const ms = Date.parse(`${value}:00+08:00`)
  return Number.isFinite(ms) ? ms : null
}

function refererOrigin(referer) {
  if (!referer) return null
  try {
    return new URL(referer).origin
  } catch {
    return null
  }
}

function renderAdmin(events, verdict, config) {
  const active = events.filter((e) => e.resolvedAt == null)
  const resolved = events.filter((e) => e.resolvedAt != null).slice(0, 10)
  const action = `${config.basePath}/admin/events`

  const row = (e) => {
    const state = e.resolvedAt == null
      ? '<span class="on">生效中</span>'
      : `<span class="off">已恢复 ${esc(statusTime(e.resolvedAt))} GMT+8</span>`
    const resolve = e.resolvedAt == null
      ? `<form method="post" action="${esc(action)}" class="inline">
           <input type="hidden" name="action" value="resolve">
           <input type="hidden" name="id" value="${esc(e.id)}">
           <button>宣判恢复</button>
         </form>`
      : ''
    return `<tr>
      <td>${esc(e.severity)}</td>
      <td class="reason">${esc(e.reason)}</td>
      <td>${esc(statusTime(e.startedAt))} GMT+8</td>
      <td>${esc(e.createdBy)}<br><span class="dim">${esc(statusTime(e.createdAt))} GMT+8</span></td>
      <td>${state}</td>
      <td>${resolve}</td>
    </tr>`
  }

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>状态后台 · ${esc(config.siteName)}</title>
<style>
:root { color-scheme: dark light; --fg:#f4f5f7; --bg:#0d0d12; --line:#272930; --dim:#a2a4ad; --ok:#4ade80; --err:#ff8f85; }
@media (prefers-color-scheme: light) { :root { --fg:#1a1a1f; --bg:#faf9f7; --line:#e4e5ea; --dim:#5c5f6b; --ok:#15803d; --err:#b91c1c; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", sans-serif; }
main { max-width: 56rem; margin: 0 auto; padding: 2.5rem 1.25rem 5rem; }
h1 { font-size:1.5rem; margin:0 0 .25rem; } h2 { font-size:.95rem; margin:2rem 0 .75rem; }
.who { color:var(--dim); font-size:.8125rem; }
form.stack { display:grid; gap:.75rem; max-width:34rem; }
label { display:grid; gap:.25rem; font-size:.8125rem; color:var(--dim); }
select,input,textarea { font:inherit; padding:.5rem .6rem; border:1px solid var(--line); border-radius:8px; background:transparent; color:var(--fg); }
textarea { min-height:5rem; resize:vertical; }
button { font:inherit; padding:.5rem 1rem; border:1px solid var(--line); border-radius:8px; background:transparent; color:var(--fg); cursor:pointer; }
table { width:100%; border-collapse:collapse; font-size:.8125rem; }
th,td { text-align:left; padding:.5rem .5rem; border-bottom:1px solid var(--line); vertical-align:top; }
td.reason { max-width:22rem; word-break:break-word; }
.dim { color:var(--dim); } .on { color:var(--err); } .off { color:var(--ok); }
form.inline { display:inline; margin:0; }
p.note { color:var(--dim); font-size:.8125rem; }
</style>
</head>
<body><main>
<h1>状态后台</h1>
<p class="who">已通过 Cloudflare Access 验证：<b>${esc(verdict.email)}</b></p>
<p class="note">手动宣判只会上调严重度，永远不会把仍然失败的探测结果显示为正常。公开页会同时显示人工状态与探测事实。</p>

<section>
<h2>发布事件</h2>
<form class="stack" method="post" action="${esc(action)}">
  <input type="hidden" name="action" value="create">
  <label>严重度
    <select name="severity">
      <option value="partial">部分出错（partial）</option>
      <option value="full">全面出错（full）</option>
      <option value="maintenance">维护中（maintenance）</option>
    </select>
  </label>
  <label>生效时间（GMT+8，留空为现在）<input type="datetime-local" name="started_at"></label>
  <label>原因（会原样显示在公开页）<textarea name="reason" maxlength="${REASON_MAX}" required></textarea></label>
  <div><button>发布</button></div>
</form>
</section>

<section>
<h2>生效中（${active.length}）</h2>
${active.length ? `<table><tbody>${active.map(row).join('')}</tbody></table>` : '<p class="note">没有生效中的手动宣判。</p>'}
</section>

<section>
<h2>最近已恢复（${resolved.length}）</h2>
${resolved.length ? `<table><tbody>${resolved.map(row).join('')}</tbody></table>` : '<p class="note">没有记录。</p>'}
</section>
</main></body></html>`
}
