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
 */
export const COMPONENTS = [
  {
    id: 'site_cn',
    label: '本站（中国大陆）',
    note: '拨测节点采样',
    source: 'boce',
    /** Driven by boce, so it has no URL of its own to probe locally. */
    local: false,
  },
  {
    id: 'site_overseas',
    label: '本站（海外）',
    note: '新加坡直连',
    source: 'local',
    local: true,
    envKey: 'SITE_URL',
    fallback: 'https://kiramyao.com/',
  },
  {
    id: 'hrt_web',
    label: 'Kira 记录',
    note: '',
    source: 'local',
    local: true,
    envKey: 'HRT_WEB_URL',
    fallback: 'https://hrt.kiramyao.com/',
  },
  {
    id: 'hrt_api',
    label: 'HRT 接口',
    note: '',
    source: 'local',
    local: true,
    envKey: 'HRT_HEALTH_URL',
    fallback: 'https://api.kiramyao.com/hrt/health',
  },
  {
    id: 'comments_api',
    label: '评论接口',
    note: '',
    source: 'local',
    local: true,
    envKey: 'COMMENTS_HEALTH_URL',
    fallback: 'https://api.kiramyao.com/comments/health',
  },
]

/** The ids that the local probe loop should hit. */
export const LOCAL_COMPONENT_IDS = COMPONENTS.filter((c) => c.local).map((c) => c.id)
