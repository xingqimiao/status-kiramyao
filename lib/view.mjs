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
 */
import { STATES } from './aggregate.mjs'

const esc = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;')

const STATE_LABEL = {
  green: '正常运行',
  amber: '部分异常',
  red: '服务中断',
  grey: '无数据',
}

const OVERALL_VERDICT = {
  green: '所有系统正常运行',
  amber: '部分服务异常',
  red: '服务中断',
  grey: '暂无监测数据',
}

/**
 * A component row: name, live pill, uptime, and the 90-day strip.
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

  return `
    <section class="row">
      <div class="row-head">
        <div class="row-name">
          <span class="dot s-${esc(component.state)}" aria-hidden="true"></span>
          <span>${esc(component.label)}</span>
          ${component.note ? `<span class="note">${esc(component.note)}</span>` : ''}
        </div>
        <div class="row-uptime"><span class="num">${esc(uptimeText)}</span><span class="unit">uptime ${component.windowDays}d</span></div>
      </div>
      <div class="strip" role="img" aria-label="${esc(`${component.label}：最近 ${component.windowDays} 天`)}">${cells}</div>
    </section>`
}

function incidentList(incidents, windowDays) {
  if (incidents.length === 0) {
    return `<p class="empty">最近 ${esc(windowDays)} 天没有记录到故障。</p>`
  }
  const rows = incidents.slice(0, 10).map((i) => {
    const when = new Date(i.startedAt).toISOString().replace('T', ' ').slice(0, 16)
    const duration = i.ongoing
      ? '持续中'
      : formatDuration(i.durationMs)
    return `
      <li class="incident">
        <span class="dot s-${i.ongoing ? 'red' : 'amber'}" aria-hidden="true"></span>
        <span class="inc-when">${esc(when)}</span>
        <span class="inc-what">${esc(i.label ?? i.component)} · ${esc(duration)}</span>
        ${i.lastError ? `<span class="inc-err">${esc(i.lastError)}</span>` : ''}
      </li>`
  }).join('')
  return `<ul class="incidents">${rows}</ul>`
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
  const generated = new Date(snapshot.generatedAt).toISOString().replace('T', ' ').slice(0, 16)
  const overall = snapshot.overall

  const rows = snapshot.components.map(componentRow).join('')

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(config.siteName)}</title>
<meta name="description" content="Kira 服务的实时状态与历史可用性。">
<meta name="color-scheme" content="dark light">
<link rel="alternate" type="application/json" href="${esc(config.basePath)}/history.json">
<style>${STYLES}</style>
</head>
<body>
<main>
  <header class="head">
    <h1>${esc(config.siteName)}</h1>
    <p class="updated">更新于 ${esc(generated)} UTC</p>
  </header>

  <div class="banner s-${esc(overall)}">
    <span class="dot s-${esc(overall)}" aria-hidden="true"></span>
    <span class="verdict">${esc(OVERALL_VERDICT[overall] ?? OVERALL_VERDICT.grey)}</span>
  </div>

  <section aria-labelledby="sys-h">
    <h2 id="sys-h">系统状态</h2>
    ${rows}
  </section>

  <section aria-labelledby="guard-h" class="guardian">
    <h2 id="guard-h">数据守护</h2>
    <p class="guard-note">这些数字来自服务的公开聚合接口，只包含计数，不包含任何标识信息。</p>
    <div class="metrics">
      ${metric('Kira 记录账户', snapshot.guardian.accounts)}
      ${metric('连续可用性', snapshot.guardian.availability, snapshot.guardian.availabilityHint)}
      ${metric('自助删除累计', snapshot.guardian.selfDeletions, '用户主动删除的数据')}
      ${metric('评论用户', snapshot.guardian.commentUsers)}
      ${metric('评论条数', snapshot.guardian.comments)}
      ${metric('已保存的故事', snapshot.guardian.stories)}
    </div>
  </section>

  <section aria-labelledby="inc-h">
    <h2 id="inc-h">故障记录</h2>
    ${incidentList(snapshot.incidents, config.historyDays)}
  </section>

  <footer>
    <p>页面每 ${esc(config.probeIntervalMinutes)} 分钟更新一次探测结果。历史数据保留 ${esc(config.historyDays)} 天。</p>
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
 * Dark-first, matching the app's own design language: near-black surfaces,
 * hairline separation, no shadows. Values copied rather than imported because this
 * is a separate service with its own stylesheet and no build step — and a shared
 * token file would be the first step toward a build.
 */
const STYLES = `
:root {
  --bg: #0d0d12;
  --surface: #16171d;
  --line: #272930;
  --text: #f4f5f7;
  --muted: #a2a4ad;
  --green: #4ade80;
  --amber: #f5d08a;
  --red: #ff8f85;
  --grey: #3a3c45;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg: #faf9f7;
    --surface: #ffffff;
    --line: #e4e5ea;
    --text: #1a1a1f;
    --muted: #5c5f6b;
    --green: #15803d;
    --amber: #a16207;
    --red: #b91c1c;
    --grey: #c7c9d1;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", "PingFang SC", sans-serif;
  -webkit-font-smoothing: antialiased;
}
main { max-width: 46rem; margin: 0 auto; padding: 3rem 1.25rem 5rem; }
.head { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
h1 { font-size: 1.5rem; font-weight: 600; margin: 0; letter-spacing: -0.01em; }
h2 { font-size: 0.8125rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin: 2.5rem 0 0.5rem; }
.updated { color: var(--muted); font-size: 0.8125rem; margin: 0; font-variant-numeric: tabular-nums; }

.banner {
  display: flex; align-items: center; gap: 0.625rem;
  margin-top: 1.5rem; padding: 0.875rem 1.125rem;
  background: var(--surface); border: 1px solid var(--line); border-radius: 12px;
}
.verdict { font-weight: 500; }

.dot { width: 9px; height: 9px; border-radius: 50%; flex: none; display: inline-block; }
.s-green { background: var(--green); }
.s-amber { background: var(--amber); }
.s-red { background: var(--red); }
.s-grey { background: var(--grey); }

.row { padding: 1rem 0; border-bottom: 1px solid var(--line); }
.row-head { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; }
.row-name { display: flex; align-items: center; gap: 0.5rem; font-weight: 500; }
.note { color: var(--muted); font-weight: 400; font-size: 0.75rem; }
.row-uptime { display: flex; align-items: baseline; gap: 0.375rem; flex: none; }
.num { font-variant-numeric: tabular-nums; font-weight: 500; }
.unit { color: var(--muted); font-size: 0.75rem; }

.strip { display: flex; gap: 2px; margin-top: 0.75rem; }
.cell { flex: 1; height: 26px; border-radius: 2px; min-width: 0; }
.strip:hover .cell { border-radius: 2px; }

.guardian { margin-top: 3rem; }
.guard-note { color: var(--muted); font-size: 0.8125rem; margin: 0 0 1rem; }
.metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
.metric { background: var(--surface); padding: 1rem 1.125rem; }
.metric-value { font-size: 1.375rem; font-weight: 600; font-variant-numeric: tabular-nums; }
.metric-label { color: var(--muted); font-size: 0.8125rem; margin-top: 0.125rem; }
.metric-hint { color: var(--muted); font-size: 0.6875rem; margin-top: 0.25rem; opacity: 0.75; }

.incidents { list-style: none; margin: 0; padding: 0; }
.incident { display: flex; align-items: center; gap: 0.625rem; padding: 0.75rem 0; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
.inc-when { font-variant-numeric: tabular-nums; color: var(--muted); font-size: 0.8125rem; }
.inc-what { font-weight: 500; }
.inc-err { color: var(--muted); font-size: 0.75rem; width: 100%; padding-left: 1.5rem; word-break: break-word; }
.empty { color: var(--muted); }

footer { margin-top: 3.5rem; padding-top: 1.5rem; border-top: 1px solid var(--line); color: var(--muted); font-size: 0.75rem; }
footer p { margin: 0.25rem 0; }
a { color: inherit; }

@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
`
