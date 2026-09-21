/**
 * Rendering. Server-rendered HTML, no build step, no framework.
 *
 * The one rule that shapes the markup: **the page reads a cache and never triggers
 * a probe.** It is handed a snapshot the probe loop already wrote. Wiring a probe
 * to a request would make page traffic the boce bill, which is the single most
 * expensive mistake available here — `deploy/BOCE.md` states it as an operating
 * rule because nothing in the code can enforce it against a future edit.
 *
 * Escaping is centralised in `esc` and applied to every interpolated value. The
 * only untrusted inputs are upstream error strings and story titles from a
 * catalogue we do not control.
 *
 * Icons are inlined from **reicon** (`check-circle`, `alert-triangle`, `x-circle`,
 * `info-circle`, all Filled). They are pasted as path data rather than loaded: the
 * page carries a `default-src 'none'` policy with only `img-src 'self'`, so the one
 * fetch it permits is the same-origin favicon; an inline SVG is not a fetch at all.
 * Each is a single `currentColor` path, so the state colour comes from the
 * enclosing element's `--tone`.
 */
import { STATES, STATUS_UTC_OFFSET_MS } from './aggregate.mjs'

const esc = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;')

/**
 * The product this page reports on. Named once so the SEO title, the description
 * and the metric labels rename together. The component row's own label lives in
 * `components.mjs`, deliberately, so the display name can change without the id
 * beside it moving.
 */
const PRODUCT = 'Kira HRT Tracker'

/** An absolute URL for this deployment, for canonical / OG / robots / sitemap. */
function publicUrl(config, path) {
  return `${config.publicOrigin}${config.basePath}${path}`
}

const STATE_LABEL = {
  green: '正常运行',
  amber: '部分异常',
  red: '服务中断',
  grey: '无数据',
}

/**
 * An absolute time as `YYYY-MM-DD HH:MM` in the page's fixed GMT+8 day.
 *
 * The same zone the cells are cut in, so a timestamp next to those cells cannot
 * disagree with them about what "today" is.
 */
function statusTime(atMs) {
  return new Date(atMs + STATUS_UTC_OFFSET_MS).toISOString().replace('T', ' ').slice(0, 16)
}

/**
 * reicon glyphs, one per state. A bare coloured dot says a state exists; an icon
 * says which one, and it is the only part of a row that survives being read on a
 * phone in sunlight.
 */
const STATE_ICON = {
  green: 'M22 12C22 17.5228 17.5228 22 12 22C6.47715 22 2 17.5228 2 12C2 6.47715 6.47715 2 12 2C17.5228 2 22 6.47715 22 12ZM16.0303 8.96967C16.3232 9.26256 16.3232 9.73744 16.0303 10.0303L11.0303 15.0303C10.7374 15.3232 10.2626 15.3232 9.96967 15.0303L7.96967 13.0303C7.67678 12.7374 7.67678 12.2626 7.96967 11.9697C8.26256 11.6768 8.73744 11.6768 9.03033 11.9697L10.5 13.4393L12.7348 11.2045L14.9697 8.96967C15.2626 8.67678 15.7374 8.67678 16.0303 8.96967Z',
  amber: 'M5.31171 10.7615C8.23007 5.58716 9.68925 3 12 3C14.3107 3 15.7699 5.58716 18.6883 10.7615L19.0519 11.4063C21.4771 15.7061 22.6897 17.856 21.5937 19.428C20.4978 21 17.7864 21 12.3637 21H11.6363C6.21356 21 3.50217 21 2.40626 19.428C1.31034 17.856 2.52291 15.7061 4.94805 11.4063L5.31171 10.7615ZM12 7.25C12.4142 7.25 12.75 7.58579 12.75 8V13C12.75 13.4142 12.4142 13.75 12 13.75C11.5858 13.75 11.25 13.4142 11.25 13V8C11.25 7.58579 11.5858 7.25 12 7.25ZM12 17C12.5523 17 13 16.5523 13 16C13 15.4477 12.5523 15 12 15C11.4477 15 11 15.4477 11 16C11 16.5523 11.4477 17 12 17Z',
  red: 'M22 12C22 17.5228 17.5228 22 12 22C6.47715 22 2 17.5228 2 12C2 6.47715 6.47715 2 12 2C17.5228 2 22 6.47715 22 12ZM8.96963 8.96965C9.26252 8.67676 9.73739 8.67676 10.0303 8.96965L12 10.9393L13.9696 8.96967C14.2625 8.67678 14.7374 8.67678 15.0303 8.96967C15.3232 9.26256 15.3232 9.73744 15.0303 10.0303L13.0606 12L15.0303 13.9696C15.3232 14.2625 15.3232 14.7374 15.0303 15.0303C14.7374 15.3232 14.2625 15.3232 13.9696 15.0303L12 13.0607L10.0303 15.0303C9.73742 15.3232 9.26254 15.3232 8.96965 15.0303C8.67676 14.7374 8.67676 14.2625 8.96965 13.9697L10.9393 12L8.96963 10.0303C8.67673 9.73742 8.67673 9.26254 8.96963 8.96965Z',
  grey: 'M22 12C22 17.5228 17.5228 22 12 22C6.47715 22 2 17.5228 2 12C2 6.47715 6.47715 2 12 2C17.5228 2 22 6.47715 22 12ZM12 17.75C12.4142 17.75 12.75 17.4142 12.75 17V11C12.75 10.5858 12.4142 10.25 12 10.25C11.5858 10.25 11.25 10.5858 11.25 11V17C11.25 17.4142 11.5858 17.75 12 17.75ZM12 7C12.5523 7 13 7.44772 13 8C13 8.55228 12.5523 9 12 9C11.4477 9 11 8.55228 11 8C11 7.44772 11.4477 7 12 7Z',
}

/**
 * The banner's two lines. The title is the verdict; the detail says what the
 * verdict is based on, and never claims more than the probes show — the grey case
 * exists precisely so a page with no data cannot sound like a page with good news.
 */
const OVERALL_VERDICT = {
  green: { title: '所有系统正常运行', detail: '我们没有发现任何影响服务的问题。' },
  amber: { title: '部分服务异常', detail: '有服务出现异常，正在跟踪，详见下方故障记录。' },
  red: { title: '服务中断', detail: '有服务正在中断，详见下方故障记录。' },
  grey: { title: '暂无监测数据', detail: '还没有足够的探测结果，无法判断当前状态。' },
}

/**
 * What the banner calls a manual declaration. The severity -> state mapping itself is
 * logic and lives in the Worker's manual.mjs; only the words are here.
 */
const MANUAL_LABEL = {
  partial: '部分服务异常',
  full: '服务中断',
  maintenance: '维护中',
}

/** One state icon. `size` is in CSS pixels; the glyph is 24×24 by design. */
function stateIcon(state, size = 20) {
  const d = STATE_ICON[state] ?? STATE_ICON.grey
  return `<svg class="ic s-${esc(state)}" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="${d}" fill="currentColor"/></svg>`
}

/**
 * A component row: name, live state icon, uptime, and the 90-day strip.
 *
 * The strip is the page. A single status dot answers "is it up now", which the
 * reader can already see from their own request; the strip answers "has it been
 * up", which is the question that brings someone to a status page.
 */
function componentRow(component) {
  const cells = component.days.map((d) => {
    const title = `${d.day} · ${STATE_LABEL[d.state]}`
    return `<span class="cell s-${esc(d.state)}" title="${esc(title)}"></span>`
  }).join('')

  const uptimeText = component.uptime === null
    ? '—'
    : `${(component.uptime * 100).toFixed(component.uptime >= 0.9995 ? 2 : 1)}%`

  // The two site rows share a label and differ only by note, so everything that
  // reads the row back to a person — the accessible name here, the incident copy
  // elsewhere — has to carry both.
  const name = component.note ? `${component.label} · ${component.note}` : component.label

  /**
   * The span this row's numbers actually cover -- the days from its first reading to
   * today, not the configured window. The strip still draws the whole window (a day with
   * no reading has to stay a grey cell, or a three-week outage would compress into
   * three), but nothing here states a span longer than the row's own data.
   */
  const spanDays = component.windowDays
  const uptimeUnit = spanDays > 0 ? `uptime ${spanDays}d` : 'uptime'
  const stripSpan = spanDays > 0 ? `最近 ${spanDays} 天` : '暂无数据'

  return `
    <section class="row">
      <div class="row-head">
        <div class="row-name">
          ${stateIcon(component.state, 18)}
          <span class="row-label">${esc(component.label)}</span>
          ${component.note ? `<span class="note">${esc(component.note)}</span>` : ''}
        </div>
        <div class="row-uptime"><span class="num">${esc(uptimeText)}</span><span class="unit">${esc(uptimeUnit)}</span></div>
      </div>
      <div class="strip" role="img" aria-label="${esc(`${name}：${stripSpan}`)}">${cells}</div>
    </section>`
}

function incidentList(incidents, windowDays) {
  if (incidents.length === 0) {
    return `<p class="empty">最近 ${esc(windowDays)} 天没有记录到故障。</p>`
  }
  const rows = incidents.slice(0, 10).map((i) => {
    const when = statusTime(i.startedAt)
    const duration = i.ongoing ? ongoingLabel(i) : formatDuration(i.durationMs)
    return `
      <li class="incident">
        ${stateIcon(i.ongoing ? 'red' : 'amber', 16)}
        <span class="inc-when">${esc(when)}</span>
        <span class="inc-what">${esc(i.label ?? i.component)} · ${esc(duration)}</span>
        ${i.lastError ? `<span class="inc-err">${esc(i.lastError)}</span>` : ''}
      </li>`
  }).join('')
  return `<ul class="incidents">${rows}</ul>`
}

/**
 * How to describe an incident with no recovery on record.
 *
 * 「持续中」 is only honest when we are in fact watching continuously. The CN row is
 * sampled once a day, so the last reading is up to 24 hours old: calling that "ongoing"
 * tells the reader the site is down right now, which we have not measured. Detail is
 * carried by the neighbouring error line — "2 of 28 nodes" — so this states only the
 * freshness and leaves the magnitude to that.
 */
function ongoingLabel(incident) {
  const intervalMinutes = incident.intervalMinutes ?? 30
  const hours = intervalMinutes / 60
  if (hours >= 6) {
    // A slow cadence: say that the latest sample failed, not that it is still failing.
    return '最近一次采样失败'
  }
  return '持续中'
}

function formatDuration(ms) {
  const minutes = Math.round(ms / 60_000)
  // A zero-length incident is a real reading — one failed probe, then success on the
  // next one — and "0 分钟" reads like a bug. Say what actually happened.
  if (minutes < 1) return '单次探测失败'
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时 ${minutes % 60} 分钟`
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`
}

/** A metric tile. `value === null` renders "—", never a fabricated number. */
function metric(label, value, hint) {
  const shown = value === null || value === undefined ? '—' : String(value)
  return `
    <div class="metric">
      <div class="metric-value">${esc(shown)}</div>
      <div class="metric-label">${esc(label)}</div>
      ${hint ? `<div class="metric-hint">${esc(hint)}</div>` : ''}
    </div>`
}

/**
 * The whole page.
 *
 * Section order follows the handoff's model — the overall banner answers the only
 * question most visitors have, then the per-component detail for anyone who wants
 * more, then the data-guardian figures, which are a different kind of statement and
 * belong last.
 */
export function renderPage(snapshot, config) {
  const generated = statusTime(snapshot.generatedAt)
  const overall = snapshot.overall
  const verdict = OVERALL_VERDICT[overall] ?? OVERALL_VERDICT.grey

  const rows = snapshot.components.map(componentRow).join('')

  /**
   * Everything a crawler sees is in this head, because there is no script to run
   * and no second request to hide anything in. The absolute URLs come from
   * `publicOrigin` rather than the request's Host, so a canonical link cannot be
   * spoofed by the header that asked for the page.
   *
   * A JSON endpoint is not a page: `/history.json` is a machine alternate, so it
   * gets rel=alternate rather than a canonical of its own.
   */
  const canonical = publicUrl(config, '/')
  // The title is the page's own, as it was before: this is the status page for
  // KiraMyao's services, so it is named after what it covers, not after the product it
  // happens to monitor. PRODUCT belongs in the row that reports on that product and in
  // the metric labels, where it identifies a thing being measured -- not in the page's
  // own name.
  const title = `${config.siteName} 服务状态`
  /**
   * The spans every window-stating string on the page uses, derived from the readings
   * rather than from `HISTORY_DAYS`: the page's own span for the strip header and the
   * incident window, and the availability figure's span for the description that names
   * it. A page four days old must not say 90.
   *
   * The configured window is the fallback only when nothing has been measured at all,
   * where there is no data span to state.
   */
  const windowDays = snapshot.windowDays > 0 ? snapshot.windowDays : config.historyDays
  const availabilityDays = snapshot.guardian.availabilityDays > 0
    ? snapshot.guardian.availabilityDays
    : config.historyDays
  const description = `${config.siteName} 服务的实时状态与最近 ${availabilityDays} 天可用性，覆盖 ${PRODUCT}、评论区与站点本身。`
  const image = publicUrl(config, '/icon-512.png')

  /**
   * The banner. Two independent readings are on it, and the manual one never hides the
   * probe one:
   *
   *   - `snapshot.overall` is already worse(probe, manual); a manual declaration can
   *     raise it but `overallManualState` maps "no declaration" to grey, so it cannot
   *     lower it.
   *   - when a declaration is in force the banner states it, prints the reason and the
   *     GMT+8 start time, and *also* prints the probe verdict underneath. When the two
   *     disagree the line says so, because "manual says recovered, nothing else does" is
   *     the exact sentence a reader needs.
   *
   * The Node service hands this function a snapshot with no `manual` field, so it takes
   * the first branch and renders exactly as before.
   */
  const manual = snapshot.manual
  const probeVerdict = manual ? (OVERALL_VERDICT[manual.probeState] ?? OVERALL_VERDICT.grey) : null

  let banner = `
  <div class="banner s-${esc(overall)}">
    <div class="banner-head">
      ${stateIcon(overall, 20)}
      <span class="verdict">${esc(verdict.title)}</span>
    </div>
    <p class="banner-body">${esc(verdict.detail)}</p>
    ${manual && manual.mismatch && manual.mismatch.kind === 'resolved-but-failing' ? `<p class="banner-note">运维已宣判恢复，但自动探测仍显示「${esc(probeVerdict.title)}」。</p>` : ''}
  </div>`

  if (manual && manual.active) {
    const manualTitle = MANUAL_LABEL[manual.active.severity] ?? '人工宣判'
    banner = `
  <div class="banner s-${esc(overall)}">
    <div class="banner-head">
      ${stateIcon(overall, 20)}
      <span class="verdict">${esc(manualTitle)}</span>
    </div>
    <p class="banner-body">${esc(manual.active.reason)}</p>
    <p class="banner-meta">运维发布 · 自 ${esc(statusTime(manual.active.startedAt))} GMT+8 起${manual.active.createdBy ? ` · ${esc(manual.active.createdBy)}` : ''}</p>
    <p class="banner-note">自动探测：${esc(probeVerdict.title)}${manual.active.state !== manual.probeState ? '（与人工宣判不一致）' : ''}</p>
  </div>`
  }

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta name="color-scheme" content="dark light">
<link rel="icon" type="image/png" sizes="32x32" href="${esc(config.basePath)}/favicon-32.png">
<link rel="icon" type="image/png" sizes="192x192" href="${esc(config.basePath)}/icon-192.png">
<link rel="apple-touch-icon" sizes="180x180" href="${esc(config.basePath)}/apple-touch-icon.png">
<link rel="alternate" type="application/json" href="${esc(config.basePath)}/history.json">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${esc(config.siteName)}">
<meta property="og:locale" content="zh_CN">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:image:width" content="512">
<meta property="og:image:height" content="512">
<meta property="og:image:alt" content="${esc(`${config.siteName} 图标`)}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(image)}">
<style>${STYLES}</style>
</head>
<body>
<main>
  <header class="head">
    <h1>${esc(config.siteName)}</h1>
    <p class="updated">更新于 ${esc(generated)} GMT+8</p>
  </header>

  ${banner}

  <section aria-labelledby="sys-h">
    <div class="section-head">
      <h2 id="sys-h">系统状态</h2>
      <span class="window">最近 ${esc(windowDays)} 天</span>
    </div>
    ${rows}
  </section>

  <!--
    The visitor tiles read 访问量, never 访客. Cloudflare's uniq/uniques field is not
    available on this plan, so the number of *people* cannot be read from it; the
    visits field is what the API actually returns, and labelling that "visitors" would
    invent a figure. Both tiles show "—" when Cloudflare is unconfigured, like any
    other metric. Backticks are avoided here: this is inside a template literal.

    Neither the comment-user count nor the origin database reading has a tile. The
    comment *count* answers the same question with a superset, and the owner asked for
    the slot to stay empty rather than be filled with something else. Both numbers are
    still carried in the snapshot and in history.json; the disk reading is the one
    origin fact the page shows.
  -->
  <section aria-labelledby="guard-h" class="guardian">
    <h2 id="guard-h">数据守护</h2>
    <p class="guard-note">这些数字来自服务的公开聚合接口，只包含计数，不包含任何标识信息。</p>
    <div class="metrics">
      ${metric(PRODUCT + ' 账户', snapshot.guardian.accounts)}
      ${metric('连续可用性', snapshot.guardian.availability, snapshot.guardian.availabilityHint)}
      ${metric('自助删除累计', snapshot.guardian.selfDeletions, '用户主动删除的数据')}
      ${metric('评论条数', snapshot.guardian.comments)}
      ${metric('已保存的故事', snapshot.guardian.stories)}
      ${metric('kiramyao.com 访问量', snapshot.guardian.visitsSite, snapshot.guardian.visitsHint)}
      ${metric(PRODUCT + ' 访问量', snapshot.guardian.visitsTracker, snapshot.guardian.visitsHint)}
      ${snapshot.guardian.origin ? metric('磁盘占用', snapshot.guardian.origin.diskUsedPct === null ? null : `${snapshot.guardian.origin.diskUsedPct}%`, snapshot.guardian.origin.diskFreeGb === null ? '' : `剩余 ${snapshot.guardian.origin.diskFreeGb} GB`) : ''}
    </div>
  </section>

  <section aria-labelledby="inc-h">
    <h2 id="inc-h">故障记录</h2>
    ${incidentList(snapshot.incidents, windowDays)}
  </section>

  <footer>
    <p>页面每 ${esc(config.probeIntervalMinutes)} 分钟更新一次探测结果。历史数据保留 ${esc(config.historyDays)} 天。</p>
    <p>所有日期均按 GMT+8 显示；数据最多可能有 5 分钟延迟。</p>
    <p>${esc(config.siteName)} · <a href="${esc(config.basePath)}/history.json">history.json</a></p>
  </footer>
</main>
</body>
</html>`
}

/**
 * The machine-readable history.
 *
 * Exported alongside the page rather than instead of it: the handoff asked for it in
 * place of an email-subscription backend, which is a v1 simplification the README
 * states plainly. Anyone who wants to watch the numbers can poll this.
 */
export function renderHistory(snapshot, config) {
  return JSON.stringify({
    generated_at: new Date(snapshot.generatedAt).toISOString(),
    overall: snapshot.overall,
    // The probe verdict is published next to the manual one so a consumer of the JSON
    // can tell a human declaration from a measurement, exactly as the page does.
    probe_overall: snapshot.probeOverall ?? undefined,
    manual: snapshot.manual ?? null,
    components: snapshot.components.map((c) => ({
      id: c.id,
      label: c.label,
      state: c.state,
      uptime: c.uptime,
      window_days: c.windowDays,
      days: c.days,
    })),
    guardian: snapshot.guardian,
    incidents: snapshot.incidents,
  }, null, 2)
}

/**
 * robots.txt and sitemap.xml.
 *
 * Only `/` is a page. `/history.json` is a machine alternate (declared with
 * `rel=alternate`; a JSON body has nothing to index), `/health` is liveness for
 * the proxy, and incidents have no URLs of their own — they are rendered inside
 * the page. So the sitemap lists exactly one location and says so, rather than
 * padding itself with endpoints a crawler would only fail to index.
 */
export function renderRobots(config) {
  return `User-agent: *
Allow: /

Sitemap: ${publicUrl(config, '/sitemap.xml')}
`
}

export function renderSitemap(config) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${esc(publicUrl(config, '/'))}</loc></url>
</urlset>
`
}

/**
 * Dark-first, matching the app's own design language: near-black surfaces,
 * hairline separation, no shadows. Values copied rather than imported because this
 * is a separate service with its own stylesheet and no build step — and a shared
 * token file would be the first step toward a build.
 *
 * The names are `md.sys` roles so they mean the same thing here as in the app. The
 * `--state-*` set is an extension: MD3 defines `error` but has no success or warning
 * role, and a status page cannot say "all systems operational" without one.
 *
 * `--tone` is the only thing a `s-<state>` class sets; every consumer reads it. That
 * keeps one mapping from state to colour instead of one per component, which is how
 * the banner and a 90-day cell stay the same colour by construction.
 */
const STYLES = `
:root {
  color-scheme: dark light;

  --md-sys-color-surface: #0d0d12;
  --md-sys-color-surface-container: #16171d;
  --md-sys-color-on-surface: #f4f5f7;
  --md-sys-color-on-surface-variant: #a2a4ad;
  --md-sys-color-outline-variant: #272930;

  --state-ok: #4ade80;
  --state-warn: #f5d08a;
  --state-error: #ff8f85;
  --state-idle: #3a3c45;

  --md-sys-shape-corner-extra-small: 4px;
  --md-sys-shape-corner-small: 8px;
  --md-sys-shape-corner-medium: 12px;

  /* Default for anything that forgot its state class: unknown, not healthy. */
  --tone: var(--state-idle);
}
@media (prefers-color-scheme: light) {
  :root {
    --md-sys-color-surface: #faf9f7;
    --md-sys-color-surface-container: #ffffff;
    --md-sys-color-on-surface: #1a1a1f;
    --md-sys-color-on-surface-variant: #5c5f6b;
    --md-sys-color-outline-variant: #e4e5ea;

    --state-ok: #15803d;
    --state-warn: #a16207;
    --state-error: #b91c1c;
    --state-idle: #c7c9d1;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--md-sys-color-surface);
  color: var(--md-sys-color-on-surface);
  font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", "PingFang SC", sans-serif;
  -webkit-font-smoothing: antialiased;
}
main { max-width: 46rem; margin: 0 auto; padding: 3rem 1.25rem 5rem; }

.head { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
h1 { font-size: 1.75rem; font-weight: 700; margin: 0; letter-spacing: -0.02em; }
h2 { font-size: 0.9375rem; font-weight: 600; margin: 2.5rem 0 0.5rem; }
.updated { color: var(--md-sys-color-on-surface-variant); font-size: 0.8125rem; margin: 0; font-variant-numeric: tabular-nums; }

/* The state class maps to a tone and nothing else. */
.s-green { --tone: var(--state-ok); }
.s-amber { --tone: var(--state-warn); }
.s-red { --tone: var(--state-error); }
.s-grey { --tone: var(--state-idle); }

.ic { flex: none; display: block; color: var(--tone); }

.banner {
  margin-top: 1.5rem;
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-medium);
  background: var(--md-sys-color-surface-container);
  overflow: hidden;
  /* The neutral pair above is the fallback for a browser without color-mix(); the
     two below tint the border and fill from the state tone when it is supported. */
  border-color: color-mix(in srgb, var(--tone) 40%, var(--md-sys-color-outline-variant));
  background: color-mix(in srgb, var(--tone) 8%, var(--md-sys-color-surface-container));
}
.banner-head { display: flex; align-items: center; gap: 0.625rem; padding: 0.9375rem 1.125rem; }
.banner-head .ic { color: var(--tone); }
.verdict { font-weight: 600; font-size: 1rem; color: var(--tone); }
.banner-body {
  margin: 0; padding: 0.8125rem 1.125rem;
  border-top: 1px solid color-mix(in srgb, var(--tone) 25%, var(--md-sys-color-outline-variant));
  font-size: 0.9375rem;
}
.banner-meta { margin: 0; padding: 0 1.125rem 0.75rem; color: var(--md-sys-color-on-surface-variant); font-size: 0.75rem; font-variant-numeric: tabular-nums; }
.banner-note { margin: 0; padding: 0.625rem 1.125rem; border-top: 1px solid var(--md-sys-color-outline-variant); color: var(--md-sys-color-on-surface-variant); font-size: 0.8125rem; }

.section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; margin: 2.5rem 0 0.5rem; }
.section-head h2 { margin: 0; }
.window { color: var(--md-sys-color-on-surface-variant); font-size: 0.8125rem; flex: none; }

.row { padding: 1rem 0; border-bottom: 1px solid var(--md-sys-color-outline-variant); }
.row-head { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
.row-name { display: flex; align-items: center; gap: 0.5rem; font-weight: 600; min-width: 0; }
.note { color: var(--md-sys-color-on-surface-variant); font-weight: 400; font-size: 0.75rem; }
.row-uptime { display: flex; align-items: baseline; gap: 0.375rem; flex: none; }
.num { font-variant-numeric: tabular-nums; font-weight: 500; }
.unit { color: var(--md-sys-color-on-surface-variant); font-size: 0.75rem; }

.strip { display: flex; gap: 2px; margin-top: 0.75rem; }
.cell { flex: 1; height: 26px; border-radius: var(--md-sys-shape-corner-extra-small); min-width: 0; background: var(--tone); }

.guardian { margin-top: 3rem; }
.guard-note { color: var(--md-sys-color-on-surface-variant); font-size: 0.8125rem; margin: 0 0 1rem; }
.metrics {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); gap: 1px;
  background: var(--md-sys-color-outline-variant);
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-medium); overflow: hidden;
}
.metric { background: var(--md-sys-color-surface-container); padding: 1rem 1.125rem; }
.metric-value { font-size: 1.5rem; font-weight: 600; font-variant-numeric: tabular-nums; }
.metric-label { color: var(--md-sys-color-on-surface-variant); font-size: 0.8125rem; margin-top: 0.125rem; }
.metric-hint { color: var(--md-sys-color-on-surface-variant); font-size: 0.6875rem; margin-top: 0.25rem; opacity: 0.8; }

.incidents { list-style: none; margin: 0; padding: 0; }
.incident { display: flex; align-items: center; gap: 0.625rem; padding: 0.75rem 0; border-bottom: 1px solid var(--md-sys-color-outline-variant); flex-wrap: wrap; }
.inc-when { font-variant-numeric: tabular-nums; color: var(--md-sys-color-on-surface-variant); font-size: 0.8125rem; }
.inc-what { font-weight: 500; }
.inc-err { color: var(--md-sys-color-on-surface-variant); font-size: 0.75rem; width: 100%; padding-left: 1.5rem; word-break: break-word; }
.empty { color: var(--md-sys-color-on-surface-variant); }

footer { margin-top: 3.5rem; padding-top: 1.5rem; border-top: 1px solid var(--md-sys-color-outline-variant); color: var(--md-sys-color-on-surface-variant); font-size: 0.75rem; }
footer p { margin: 0.25rem 0; }
a { color: inherit; }

@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
`
