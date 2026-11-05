/**
 * update.js —— 「有没有新版本」
 *
 * 为什么这件事得放在插件里做（用户 2026-10-25 提）：这个插件是从 GitHub 装的，
 * 装完之后**没有任何东西会告诉用户作者又发了新版**——DSH 面板不管插件的升级，
 * `dsh plugin add github:...` 也不会自己去比对。于是用户永远停在装的那一天。
 *
 * 五条约束（和 B §8 那套一致：这不是"她"的事，是"插件维护"的事）：
 *   1. **只读、只出网、不落盘。** 不写任何文件、不产生子进程、不改自己的代码。
 *   2. **地址全部硬编码。** 不接受客户端传进来的 URL —— 否则这就是一个现成的 SSRF 口子。
 *   3. **永不抛。** 连不通是常态（国内 GitHub 时通时不通），失败要如实说出来，
 *      不能让设置页因为一次网络失败就崩掉一整节。
 *   4. **不自动检查。** 只在用户点「检查更新」时跑一次。她运行期一次都不查版本——
 *      她不需要知道自己是几号版本，那是装她的人的事。
 *   5. **多源并发。** 直连 api.github.com 经常被重置，所以同时戳几个（镜像 + jsDelivr），
 *      哪个先回来用哪个。多个都成功时取**版本号最大**的那个（镜像会滞后）。
 *
 * 注：0.6.14 起「下载并把包换上去」是另一条链路（`lib/selfupdate.js`），只在用户点了
 * 确认之后才跑；**这个文件仍旧只查版本号**，不下载、不落盘、不起子进程。
 */

/** 仓库：所有请求都指向这里。改仓库只改这一处。 */
export const REPO = 'ssamurias/dsh-fish'
export const REPO_URL = `https://github.com/${REPO}`
export const RELEASES_URL = `${REPO_URL}/releases`

/**
 * npm 包名（2026-11-05 起官方安装源）。
 * `dsh-fish` 这个裸名在 2026-09-11 被别的账号占走了，所以发的是 scoped 全名。
 * 版本号以 npm 为准：GitHub 的 tag / package.json 可能忘了 bump，npm 上不去就发不了版。
 */
export const NPM_PKG = '@ssamurias/dsh-fish'
export const NPM_URL = `https://www.npmjs.com/package/${NPM_PKG}`

/**
 * 版本号来源，按"越靠前越权威"排列（但同时发，不是串行）。
 * `pick` 从 JSON 里取版本字段：Release 给 `tag_name`，package.json 给 `version`。
 */
const SOURCES = [
  {
    name: 'npm',
    // scoped 包在 registry 里要写成 %2F；这条同时说明"装得到的最新版是哪个"。
    url: `https://registry.npmjs.org/@ssamurias%2Fdsh-fish/latest`,
    pick: (j) => j?.version,
  },
  {
    name: 'GitHub API',
    url: `https://api.github.com/repos/${REPO}/releases/latest`,
    pick: (j) => j?.tag_name,
  },
  {
    name: 'GitHub API（tags）',
    url: `https://api.github.com/repos/${REPO}/tags?per_page=1`,
    pick: (j) => (Array.isArray(j) && j[0] ? j[0].name : ''),
  },
  {
    name: 'ghfast 镜像',
    url: `https://ghfast.top/https://raw.githubusercontent.com/${REPO}/main/package.json`,
    pick: (j) => j?.version,
  },
  {
    name: 'ghproxy 镜像',
    url: `https://ghproxy.net/https://raw.githubusercontent.com/${REPO}/main/package.json`,
    pick: (j) => j?.version,
  },
  {
    name: 'jsDelivr',
    url: `https://cdn.jsdelivr.net/gh/${REPO}@main/package.json`,
    pick: (j) => j?.version,
  },
  {
    name: 'GitHub RAW',
    url: `https://raw.githubusercontent.com/${REPO}/main/package.json`,
    pick: (j) => j?.version,
  },
]

/** `v1.2.3` / `1.2.3` / ` 1.2.3 ` → `[1,2,3]`；认不出就是 null。 */
function parseVersion(v) {
  const m = String(v ?? '').trim().match(/^[vV]?(\d+)\.(\d+)\.(\d+)/)
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** 规范化成 `1.2.3`，认不出给空串。 */
export function normalizeVersion(v) {
  const p = parseVersion(v)
  return p ? p.join('.') : ''
}

/**
 * 比版本：a 比 b 新返回 1，一样返回 0，更旧返回 -1。
 * 认不出的版本一律返回 0（当成"说不清"，不要因此谎报有更新）。
 */
export function compareVersion(a, b) {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return 0
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1
  }
  return 0
}

async function probe(src, fetchImpl, signal) {
  const res = await fetchImpl(src.url, {
    signal,
    headers: {
      accept: 'application/json',
      // GitHub API 没有 UA 会直接 403。
      'user-agent': 'dsh-fish-update-check',
    },
  })
  if (!res || !res.ok) throw new Error(`${src.name} 返回 ${res ? res.status : '没有响应'}`)
  const json = typeof res.json === 'function' ? await res.json() : null
  const version = normalizeVersion(src.pick(json))
  if (!version) throw new Error(`${src.name} 里没有版本号`)
  return { version, source: src.name }
}

/**
 * 查一次有没有新版。
 *
 * @param {{current?:string, timeoutMs?:number, fetchImpl?:Function}} [opts]
 * @returns {Promise<{ok:boolean, current:string, latest?:string, hasUpdate?:boolean,
 *   source?:string, repo:string, url:string, checkedAt:string, error?:string}>}
 *
 * 注意 timeoutMs 是整个并发批次的预算，不是每个源的：用户点一下只该等这么久。
 * 这里**故意不 unref 定时器**——2026-10-25 在 lib/say.js 上踩过这个坑：
 * 当它可能是唯一还挂着的句柄时，unref 会让事件循环提前收尾、Promise 永远等不到 resolve。
 * 定时器在 finally 里 clearTimeout，正常运行不会拖住进程。
 */
export async function checkUpdate({ current = '', timeoutMs = 6000, fetchImpl = globalThis.fetch } = {}) {
  const checkedAt = new Date().toISOString()
  // 版本号统一规范化：调用方传 `v0.3.0` 还是 `0.3.0` 都一样。
  // 认不出来就是空串 —— 那时**不能**谎报"有新版"（见下面 hasUpdate）。
  const cur = normalizeVersion(current)
  const base = { current: cur || String(current ?? ''), repo: REPO_URL, url: RELEASES_URL, checkedAt }

  if (typeof fetchImpl !== 'function') {
    return { ...base, ok: false, error: '这个环境里没有 fetch，查不了。' }
  }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), Math.max(200, Number(timeoutMs) || 6000))
  let results
  try {
    results = await Promise.allSettled(SOURCES.map((s) => probe(s, fetchImpl, ctrl.signal)))
  } finally {
    clearTimeout(timer)
  }

  // 多个源都成功时取版本号最大的：镜像和 jsDelivr 都有缓存，可能比直连旧。
  let best = null
  for (const r of results) {
    if (r.status !== 'fulfilled' || !r.value) continue
    if (!best || compareVersion(r.value.version, best.version) > 0) best = r.value
  }

  if (!best) {
    return {
      ...base,
      ok: false,
      error: `连不上 GitHub（等了 ${Math.round((Number(timeoutMs) || 6000) / 1000)} 秒）。国内时通时不通，过一会儿再试，或者开一下网络工具。`,
    }
  }

  return {
    ...base,
    ok: true,
    latest: best.version,
    source: best.source,
    // 不知道当前版本（读不到）时**不下判断**：既不说有新版本，也不说已经最新。
    // 谎报"有更新"会让人白下一趟；谎报"最新"更糟——他可能就一直停在旧版。
    known: Boolean(cur),
    hasUpdate: cur ? compareVersion(best.version, cur) > 0 : false,
  }
}
