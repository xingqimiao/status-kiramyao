/**
 * The component register: the ids, labels and order the page uses.
 *
 * One list, imported by both the config (which keys its probe targets by these ids)
 * and the snapshot (which renders them). They were written separately at first, and
 * they disagreed — the config used `hrtWeb` where the snapshot looked for
 * `hrt_web` — which made every component read "grey" while the probes were in fact
 * running and recording. Nothing caught it until the end-to-end test asserted a
 * probe had landed, which is exactly why that test spawns the real server instead
 * of calling the render function.
 *
 * `site_cn` has no local target: it is driven by the boce adapter alone.
 *
 * Labels name the *thing being watched*, not the vantage point it is watched from.
 * The two site rows differ only in where the probe runs, so they share a name and
 * are told apart by `note` — "本站" said nothing a reader could act on, and
 * "Kira 记录" was an in-house shorthand for a product that has a real name.
 */
export const COMPONENTS = [
  {
    id: 'site_cn',
    label: 'kiramyao.com',
    note: 'CN',
    source: 'boce',
    /** Driven by boce, so it has no URL of its own to probe locally. */
    local: false,
  },
  {
    id: 'site_overseas',
    label: 'kiramyao.com',
    note: 'Global',
    source: 'local',
    local: true,
    // Pure static (Cloudflare Pages): it cannot echo the probe nonce, so its
    // freshness evidence stops at a unique URL plus a no-store response.
    echoNonce: false,
    envKey: 'SITE_URL',
    fallback: 'https://kiramyao.com/',
  },
  {
    id: 'hrt_web',
    label: 'Kira HRT Tracker',
    note: '',
    source: 'local',
    local: true,
    // The tracker web app: files, not app code, so no nonce echo. Its honesty is
    // bounded like site_overseas -- unique URL + no-store only.
    echoNonce: false,
    envKey: 'HRT_WEB_URL',
    fallback: 'https://hrt.kiramyao.com/',
  },
  {
    id: 'hrt_api',
    label: 'Tracker API',
    note: '',
    source: 'local',
    local: true,
    // App code we control: it echoes ?nonce= and sets no-store.
    echoNonce: true,
    envKey: 'HRT_HEALTH_URL',
    fallback: 'https://api.kiramyao.com/hrt/health',
  },
  {
    id: 'hrt_mcp',
    label: 'Tracker MCP',
    note: '',
    source: 'local',
    local: true,
    echoNonce: true,
    envKey: 'HRT_MCP_HEALTH_URL',
    /**
     * The MCP endpoint's own readiness route, not `/mcp` itself. That one resolves
     * a bearer before it answers, so a probe without a credential would read 401 and
     * call a healthy service broken, and a probe with one would be reporting the
     * credential. This is the tokenless half -- it says the adapter is mounted and
     * which protocol version it speaks.
     */
    fallback: 'https://api.kiramyao.com/hrt/mcp/health',
  },
  {
    id: 'comments_api',
    label: 'Comments API',
    note: '',
    source: 'local',
    local: true,
    echoNonce: true,
    envKey: 'COMMENTS_HEALTH_URL',
    fallback: 'https://api.kiramyao.com/comments/health',
  },
]

/** The ids that the local probe loop should hit. */
export const LOCAL_COMPONENT_IDS = COMPONENTS.filter((c) => c.local).map((c) => c.id)
