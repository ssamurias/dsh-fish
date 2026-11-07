/**
 * bili.js —— B 站只读客户端（她"刷站"的唯一入口）
 *
 * 为什么不用第三方库：插件不能有 dependencies（避坑指南：多装一个包就可能把旧核心包拖进来）。
 * 所以这里只用 Node 内置的 fetch + crypto + zlib。
 *
 * 实测结论（2026-10-22 在本机逐条探过，见 04-小工具/bili-probe/probe*.mjs）：
 *   ✅ 无需登录：popular / ranking / view / reply(type=1&oid=aid) / tags / related
 *                / popular/precious / 弹幕 xml(oid=cid, deflate-raw)
 *   ⚠️ 需 wbi 签名：search/**、space/**、player/wbi/v2
 *        —— 不签名会拿到 -412「request was banned」；签名后**不带 cookie 也能用**
 *   ⚠️ 需 buvid：/x/frontend/finger/spi 拿 buvid3/buvid4，带上能显著降低被风控概率
 *   ❌ 需登录：字幕（AI 字幕）、AI 总结、空间页 arc/search、历史/收藏
 *        —— 所以 P2 **不依赖字幕**，她"看视频"靠的是 标题/简介/标签/热评/弹幕
 *
 * 设计约束：
 *   1. **永不抛出**。任何方法都返回 { ok, data, code, message }。一次失败不能污染唤醒流程。
 *   2. **限流**。串行 + 最小间隔（默认 800ms + 0–500ms 抖动，设置页可调），
 *      避免把本机 IP 刷成 -412。机房 IP 需要更慢——所以间隔不写死。
 *   3. **风控熔断**（issue #5 重做）。读/写两级分开，读 60 秒起、写 5 分钟起，
 *      连续复发才翻倍；**只关自己那一级**。签名接口的 -412 先当"密钥过期"重试一次，
 *      仍失败才算真风控。以前是一刀切 30 分钟全局冷却，一次偶发失败能把插件打死半天。
 *   4. **不下载视频**。只读元数据与文本——没有版权面，也不需要 1GB 转写模型。
 */

import { createHash } from 'node:crypto'
import { inflateRawSync, inflateSync, gunzipSync } from 'node:zlib'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const API = 'https://api.bilibili.com'

/** wbi 混淆表（B 站前端写死的常量，不是密钥） */
const MIXIN = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
]

/** 这些返回码代表"被风控了"，不是"接口坏了" */
const RISK_CODES = new Set([-352, -412, -509])

/**
 * 风控熔断（issue #5 重做，2026-10-28）。
 *
 * 原来的写法是**全局一个 30 分钟闸**：任何一次 -412 就把所有接口一起关掉。
 * 在机房 IP / 无 cookie 的场景下，搜索这类"本来就容易 -412"的接口只要踩一次，
 * 接下来的热门、看视频、看画面、写评论全被挡在门外半小时——
 * 一次偶发失败被放大成"插件半小时不干活"。issue #5 报的就是这个。
 *
 * 现在分两级，且**只关自己那一级**：
 *   - 读：起点 60 秒，连续复发翻倍，上限 10 分钟。读请求不该被一次失手打死。
 *   - 写：起点 5 分钟，翻倍，上限 30 分钟。写被风控的代价高，保守些。
 * 任意一次同类请求成功就把该级的连击计数清零——"恢复正常"要能被感知到。
 */
const RISK_READ_BASE_MS = 60_000
const RISK_READ_MAX_MS = 10 * 60_000
const RISK_WRITE_BASE_MS = 5 * 60_000
const RISK_WRITE_MAX_MS = 30 * 60_000

function freshRisk() {
  return { until: 0, streak: 0 }
}
const RISK = { read: freshRisk(), write: freshRisk() }

/**
 * 请求节奏（issue #5 第二条诉求：间隔可配置）。
 *
 * 放在模块级而不是 createClient 的参数里：客户端被 look / watch / scheduler /
 * comment / video 等七八处各自 new 出来，逐个传参会漏（漏一处就是固定 800ms）。
 * 启动时由 index.js 读设置调一次 setPacing，**所有**客户端跟着变。
 */
const PACE = { minIntervalMs: 800, jitterMs: 500 }

/**
 * 排队本身也放在模块级（issue #67）：上一次请求的时间和那条队。
 *
 * 原来 lastReq / chain 是 createClient 闭包里的，翻视频、查回复、看画面、观测台各 new 一个客户端，
 * 彼此不排队，可以同一毫秒一起打出去；新客户端的 lastReq 是 0，第一条请求也不等。
 * 节奏防的是同一个 IP 被刷红，所以和 PACE、RISK 一样整个进程共用一份。
 * 队里只排到响应头回来（raw 有 12 秒超时），读响应体不占队。
 */
const QUEUE = { lastReq: 0, chain: Promise.resolve() }

/**
 * 坏值一律回默认，**绝不当成 0**：0 间隔等于把限速关掉，是最危险的错值。
 * null / '' 也算坏值（Number(null) === 0，不特判就会静默变成不限速）。
 */
function paceNum(v, dflt) {
  if (v === null || v === undefined || v === '') return dflt
  const n = Number(v)
  return Number.isFinite(n) ? n : dflt
}

export function setPacing(o = {}) {
  PACE.minIntervalMs = Math.max(200, Math.min(120_000, paceNum(o.minIntervalMs, 800)))
  PACE.jitterMs = Math.max(0, Math.min(60_000, paceNum(o.jitterMs, 500)))
}

export function getPacing() {
  return { ...PACE }
}

/** 测试用：清掉熔断状态 */
export function resetRisk() {
  RISK.read = freshRisk()
  RISK.write = freshRisk()
}

/** @param {'read'|'write'} kind */
export function inCooldown(kind = 'read', now = Date.now()) {
  const r = RISK[String(kind) === 'write' ? 'write' : 'read']
  return now < r.until
}

/** 记一次风控命中，返回本次冷却时长（毫秒） */
function noteRisk(kind, now) {
  const k = kind === 'write' ? 'write' : 'read'
  const r = RISK[k]
  r.streak = Math.min(20, r.streak + 1)
  const base = k === 'write' ? RISK_WRITE_BASE_MS : RISK_READ_BASE_MS
  const cap = k === 'write' ? RISK_WRITE_MAX_MS : RISK_READ_MAX_MS
  const ms = Math.min(cap, base * 2 ** (r.streak - 1))
  r.until = now + ms
  return ms
}

/** 一次成功就说明已经恢复，连击清零 */
function noteOk(kind) {
  const r = RISK[kind === 'write' ? 'write' : 'read']
  r.streak = 0
  r.until = 0
}

/** 冷却多久（给日志/提示用，0 = 没在冷却） */
export function cooldownLeft(kind = 'read', now = Date.now()) {
  const r = RISK[String(kind) === 'write' ? 'write' : 'read']
  return Math.max(0, r.until - now)
}

/**
 * 内存里还剩多久（毫秒）。给观测台用：这一层是进程内的，重启就没了，
 * 和 risk.js 落盘的那份是两个口径，界面要把两句话分开说。
 */
export function memoryCooldown(now = Date.now()) {
  return {
    readMs: Math.max(0, RISK.read.until - now),
    writeMs: Math.max(0, RISK.write.until - now),
    readStreak: RISK.read.streak,
    writeStreak: RISK.write.streak,
  }
}

const fmtWait = (ms) => (ms >= 60_000 ? `${Math.ceil(ms / 60_000)} 分钟` : `${Math.ceil(ms / 1000)} 秒`)

/**
 * wbi 签名密钥：从 nav 接口的 img_url / sub_url 各取文件名，按 MIXIN 表打成 32 位。
 * @param {string} imgKey
 * @param {string} subKey
 */
export function mixinKey(imgKey, subKey) {
  const s = String(imgKey ?? '') + String(subKey ?? '')
  let out = ''
  for (const i of MIXIN) out += s[i] ?? ''
  return out.slice(0, 32)
}

/**
 * 给参数签名，返回可直接拼到 URL 后面的 query 串。
 * 规则：按键名排序 → 值去掉 !'()* → encodeURIComponent → 拼 mk 后取 md5 → w_rid
 */
export function signQuery(params, mk, wts = Math.floor(Date.now() / 1000)) {
  const all = { ...params, wts }
  const q = Object.keys(all)
    .sort()
    .map((k) => {
      const v = String(all[k] ?? '').replace(/[!'()*]/g, '')
      return `${encodeURIComponent(k)}=${encodeURIComponent(v)}`
    })
    .join('&')
  const w_rid = createHash('md5').update(q + mk).digest('hex')
  return `${q}&w_rid=${w_rid}`
}

/** 弹幕/评论里常见的 HTML 实体 */
export function unescapeHtml(s) {
  return String(s ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

/** 搜索结果标题里带 <em class="keyword"> 高亮，去掉标签 */
export function stripEm(s) {
  return unescapeHtml(String(s ?? '').replace(/<[^>]*>/g, ''))
}

/** 秒 → 3:07 / 1:02:03 */
export function fmtDur(sec) {
  const n = Math.max(0, Math.round(Number(sec) || 0))
  const h = Math.floor(n / 3600)
  const m = Math.floor((n % 3600) / 60)
  const s = n % 60
  const pad = (x) => String(x).padStart(2, '0')
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/**
 * 解析弹幕 XML（<d p="时间,模式,字号,颜色,时间戳,池,uid,rowid">内容</d>）
 * @returns {{t:number,text:string}[]} 按时间升序
 */
export function parseDanmaku(xml) {
  const out = []
  const re = /<d\s+p="([^"]*)"[^>]*>([\s\S]*?)<\/d>/g
  let m
  while ((m = re.exec(String(xml ?? '')))) {
    const p = m[1].split(',')
    const t = Number(p[0])
    const text = unescapeHtml(m[2]).trim()
    if (!Number.isFinite(t) || !text) continue
    if (text.length > 60) continue
    out.push({ t, text })
  }
  out.sort((a, b) => a.t - b.t)
  return out
}

/**
 * 从一堆弹幕里均匀抽 n 条，返回带时间标签的"观众在第 X 分 Y 秒说"。
 * 为什么不按热度：弹幕没有赞数；均匀采样更接近"真的在看"。
 * 过滤掉纯符号、纯数字、复读机（同一文本出现 >3 次只留一次）。
 */
export function sampleDanmaku(list, n = 8, durationSec = 0) {
  const clean = []
  const seen = new Map()
  for (const d of list) {
    const t = String(d.text ?? '')
    if (!t || /^[\s\p{P}\p{S}\d]+$/u.test(t)) continue
    if (t.length <= 1) continue
    const c = (seen.get(t) ?? 0) + 1
    seen.set(t, c)
    if (c > 3) continue
    clean.push(d)
  }
  if (!clean.length) return []
  const want = Math.max(0, Math.min(Number(n) || 0, clean.length))
  if (!want) return []
  // 按时间分桶，每桶取一条 —— 这样抽出来的是"贯穿全片"的，不是开头挤成一堆
  const dur = Number(durationSec) > 0 ? Number(durationSec) : clean[clean.length - 1].t || 1
  const buckets = Array.from({ length: want }, () => [])
  for (const d of clean) {
    const idx = Math.min(want - 1, Math.floor((d.t / dur) * want))
    buckets[idx].push(d)
  }
  const picked = []
  for (let i = 0; i < want; i++) {
    const b = buckets[i]
    if (!b.length) continue
    // 桶内取中间那条，避开最吵的第一条
    picked.push(b[Math.floor(b.length / 2)])
  }
  // 桶不够（弹幕集中在中间）时用剩下的补满
  if (picked.length < want) {
    for (const d of clean) {
      if (picked.length >= want) break
      if (!picked.includes(d)) picked.push(d)
    }
  }
  return picked.sort((a, b) => a.t - b.t)
}

/**
 * 把 cookie 串整理干净（允许从 Netscape cookies.txt 或 "a=1; b=2" 传入）
 */
export function normalizeCookie(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return ''
  if (s.includes('\t')) {
    const pairs = []
    for (const line of s.split(/\r?\n/)) {
      if (!line || line.startsWith('#')) continue
      const p = line.split('\t')
      if (p.length >= 7 && p[5]) pairs.push(`${p[5]}=${p[6]}`)
    }
    return pairs.join('; ')
  }
  return s
}

/**
 * 建一个客户端。fetch 可注入（单测不打真网）。
 */
export function createClient(opts = {}) {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const now = opts.now ?? (() => Date.now())
  // 间隔与抖动（issue #5：要可配）。显式传了就听传入的；没传就**运行时**读 PACE——
  // 这样设置页改完不需要重建客户端，已经在排队的请求也会用新节奏。
  const minInt = () => {
    const v = Number(opts.minIntervalMs)
    return Number.isFinite(v) && v > 0 ? v : PACE.minIntervalMs
  }
  const jitInt = () => {
    if (opts.jitterMs !== undefined && opts.jitterMs !== null) {
      const v = Number(opts.jitterMs)
      return Number.isFinite(v) && v >= 0 ? v : PACE.jitterMs
    }
    return PACE.jitterMs
  }
  const rnd = opts.random ?? Math.random
  const timeoutMs = opts.timeoutMs ?? 12_000
  const logger = opts.log ?? (() => {})

  let cookie = normalizeCookie(opts.cookie)
  let buvid = ''
  let buvidFailAt = 0
  let mk = ''
  let mkAt = 0

  /** 串行 + 最小间隔 + 随机抖动：所有客户端的请求排同一条队（QUEUE），避免并发把 IP 刷红 */
  function throttle(fn) {
    const run = QUEUE.chain.then(async () => {
      const gap = minInt() + Math.floor(rnd() * Math.max(0, jitInt()))
      // 上一条可能是别的客户端发的，时钟不一定是同一个（测试注入 now、系统时间回拨），
      // 算出来的间隔是负的时只等一个 gap。
      const wait = Math.min(gap, gap - (now() - QUEUE.lastReq))
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      QUEUE.lastReq = now()
      return fn()
    })
    QUEUE.chain = run.catch(() => {})
    return run
  }

  function cookieHeader() {
    const parts = []
    if (buvid) parts.push(buvid)
    if (cookie) parts.push(cookie)
    return parts.join('; ')
  }

  async function raw(url, { referer, cookieOverride, method = 'GET', body } = {}) {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), timeoutMs)
    try {
      const r = await fetchImpl(url, {
        method,
        signal: ctl.signal,
        body,
        headers: {
          'user-agent': UA,
          referer: referer ?? 'https://www.bilibili.com/',
          accept: 'application/json, text/plain, */*',
          'accept-language': 'zh-CN,zh;q=0.9',
          ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
          ...(cookieOverride !== null && cookieHeader() ? { cookie: cookieOverride ?? cookieHeader() } : {}),
        },
      })
      return r
    } finally {
      clearTimeout(t)
    }
  }

  /**
   * csrf 令牌 = cookie 里的 bili_jct。**没有它所有写操作都会被拒**（-111 / -101）。
   * 从 cookie 串里抠出来，不从别处拿 —— 它是登录凭据的一部分，不单独存。
   */
  function csrf() {
    const m = /(?:^|;\s*)bili_jct=([^;]+)/.exec(String(cookie ?? ''))
    return m ? m[1] : ''
  }

  /**
   * 写操作统一出口（发评论 / 回复评论 / 点赞）。**全部走 POST 表单**。
   *
   * 三条硬约束（写操作比读操作危险得多）：
   *   1. **必须登录**：没 cookie 一律返回 NOT_LOGIN，不试探。
   *   2. **必须有 csrf**：取不到就 NO_CSRF，不发请求（发了也只会拿到 -111）。
   *   3. **风控冷却期间宁可不写**：写操作被风控的代价远大于少发一条评论。
   */
  async function apiPost(path, form = {}, o = {}) {
    if (!cookie) return { ok: false, code: 'NOT_LOGIN', message: '没有登录凭据', data: null }
    const token = csrf()
    if (!token) return { ok: false, code: 'NO_CSRF', message: 'cookie 里没有 bili_jct，写不了', data: null }
    if (now() < RISK.write.until) {
      return { ok: false, code: 'COOLDOWN', message: `B站风控冷却中，还要约 ${fmtWait(RISK.write.until - now())}才能写`, data: null }
    }
    try {
      const body = new URLSearchParams({ ...form, csrf: token, csrf_token: token }).toString()
      const r = await throttle(() => raw(API + path, { referer: o.referer, method: 'POST', body }))
      const text = await r.text()
      let j
      try {
        j = JSON.parse(text)
      } catch {
        return { ok: false, code: 'BAD_JSON', message: `非 JSON（HTTP ${r.status}）`, data: null }
      }
      if (j?.code !== 0) {
        if (RISK_CODES.has(j?.code)) {
          const ms = noteRisk('write', now())
          logger(`写操作风控 ${j?.code}，${fmtWait(ms)}后再试`)
        }
        return { ok: false, code: j?.code, message: j?.message ?? String(j?.code), data: null }
      }
      noteOk('write')
      return { ok: true, code: 0, message: 'OK', data: j?.data ?? null }
    } catch (err) {
      return { ok: false, code: 'NETWORK', message: String(err?.message ?? err), data: null }
    }
  }

  /** 拿 buvid3/buvid4（不带它搜索容易被 -412） */
  async function ensureBuvid() {
    if (buvid) return true
    // 拿不到就 10 分钟内别再试：普通接口每次请求前都会走到这里，失败不能让请求数翻倍
    if (buvidFailAt && now() - buvidFailAt < 10 * 60_000) return false
    try {
      const r = await throttle(() => raw(`${API}/x/frontend/finger/spi`))
      const j = await r.json()
      const b3 = j?.data?.b_3
      const b4 = j?.data?.b_4
      if (!b3) { buvidFailAt = now(); return false }
      buvid = `buvid3=${b3}${b4 ? `; buvid4=${b4}` : ''}`
      return true
    } catch (err) {
      buvidFailAt = now()
      logger('buvid failed', err?.message ?? err)
      return false
    }
  }

  /** 拿 wbi 密钥（缓存 6 小时；密钥按天轮换） */
  async function ensureMk(force = false) {
    if (!force && mk && now() - mkAt < 6 * 3600_000) return true
    try {
      await ensureBuvid()
      const r = await throttle(() => raw(`${API}/x/web-interface/nav`))
      const j = await r.json()
      const w = j?.data?.wbi_img ?? {}
      const imgKey = String(w.img_url ?? '').split('/').pop().split('.')[0]
      const subKey = String(w.sub_url ?? '').split('/').pop().split('.')[0]
      if (!imgKey || !subKey) return false
      mk = mixinKey(imgKey, subKey)
      mkAt = now()
      return true
    } catch (err) {
      logger('wbi failed', err?.message ?? err)
      return false
    }
  }

  /**
   * 统一出口：GET 一个 JSON 接口，吞掉所有异常。
   * @param {string} path 以 / 开头
   * @param {object} params
   * @param {{signed?:boolean, referer?:string, label?:string}} o
   */
  async function api(path, params = {}, o = {}) {
    if (now() < RISK.read.until) {
      return {
        ok: false,
        code: 'COOLDOWN',
        message: `风控冷却中，${fmtWait(RISK.read.until - now())}后再试`,
        data: null,
      }
    }
    try {
      let url = API + path
      if (o.signed) {
        if (!(await ensureMk(o.forceMk))) return { ok: false, code: 'NO_WBI', message: '取不到签名密钥', data: null }
        url += `?${signQuery(params, mk, Math.floor(now() / 1000))}`
      } else {
        // 不签名的接口也要带 buvid3（2026-10-29 实测）：一个 cookie 都不带时，
        // /x/web-interface/view 多半直接回 -412，读熔断随即把这一轮的标签/热评/弹幕全关掉，
        // 定时刷站拼出来的素材只剩标题和播放量。带上匿名 buvid 就正常，不需要登录。
        if (!/(?:^|;\s*)buvid3=/.test(cookie)) await ensureBuvid()
        const q = Object.keys(params)
          .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== '')
          .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(params[k]))}`)
          .join('&')
        if (q) url += `?${q}`
      }
      const r = await throttle(() => raw(url, { referer: o.referer }))
      const text = await r.text()
      let j
      try {
        j = JSON.parse(text)
      } catch {
        return { ok: false, code: 'BAD_JSON', message: `非 JSON（HTTP ${r.status}）`, data: null }
      }
      const code = j?.code
      if (code !== 0) {
        if (RISK_CODES.has(code)) {
          /**
           * 签名接口的 -412 有两种原因：真的被风控；以及 wbi 密钥过期/换了。
           * 后者换一次密钥重试就能好（密钥按天轮换，进程开着一整天就会踩到）。
           * 以前一律当风控处理 → 整整半小时所有接口全死。issue #5 的第一现场。
           * 所以：签名接口先强制刷一次密钥重试；仍失败才认作真风控。
           */
          if (o.signed && !o.retried) {
            logger(`签名接口 ${code}，刷新 wbi 后重试一次`)
            return api(path, params, { ...o, forceMk: true, retried: true })
          }
          const ms = noteRisk('read', now())
          logger(`风控代码 ${code}，${fmtWait(ms)}内不再请求`)
        }
        return { ok: false, code, message: j?.message ?? String(code), data: null }
      }
      noteOk('read')
      return { ok: true, code: 0, message: 'OK', data: j?.data ?? null }
    } catch (err) {
      return { ok: false, code: 'NETWORK', message: String(err?.message ?? err), data: null }
    }
  }

  // ---------------- 具体接口 ----------------

  /** 热门：全站综合热门 */
  async function popular(ps = 20) {
    const r = await api('/x/web-interface/popular', { ps: Math.min(50, ps), pn: 1 })
    return r.ok ? { ...r, data: (r.data?.list ?? []).map(toVideo) } : { ...r, data: [] }
  }

  /** 排行榜：rid=0 全站，其它是分区 */
  async function ranking(rid = 0, type = 'all') {
    const r = await api('/x/web-interface/ranking/v2', { rid, type })
    return r.ok ? { ...r, data: (r.data?.list ?? []).map(toVideo) } : { ...r, data: [] }
  }

  /** 入站必刷（老片，自带"时间感"） */
  async function precious(pageSize = 20) {
    const r = await api('/x/web-interface/popular/precious', { page_size: Math.min(50, pageSize), page: 1 })
    return r.ok ? { ...r, data: (r.data?.list ?? []).map(toVideo) } : { ...r, data: [] }
  }

  /** 搜索（必须签名） */
  async function search(keyword, { page = 1, pageSize = 10 } = {}) {
    const kw = String(keyword ?? '').trim().slice(0, 40)
    if (!kw) return { ok: false, code: 'EMPTY', message: '关键词是空的', data: [] }
    const r = await api(
      '/x/web-interface/search/type',
      { search_type: 'video', keyword: kw, page, page_size: Math.min(20, pageSize) },
      { signed: true, referer: `https://search.bilibili.com/all?keyword=${encodeURIComponent(kw)}` },
    )
    if (!r.ok) return { ...r, data: [] }
    const list = (r.data?.result ?? []).map((v) => ({ ...toVideo(v), title: stripEm(v.title) }))
    return { ...r, data: list }
  }

  /** 相关推荐（"她看完一条，平台又推给她什么"） */
  async function related(bvid, limit = 10) {
    const r = await api('/x/web-interface/archive/related', { bvid })
    return r.ok ? { ...r, data: (r.data ?? []).slice(0, limit).map(toVideo) } : { ...r, data: [] }
  }

  /** 视频详情（简介全文在这里） */
  async function view(bvid) {
    const r = await api('/x/web-interface/view', { bvid })
    if (!r.ok) return r
    const d = r.data ?? {}
    return {
      ok: true,
      code: 0,
      message: 'OK',
      data: {
        ...toVideo(d),
        desc: String(d.desc ?? ''),
        pubdate: d.pubdate ? new Date(d.pubdate * 1000).toISOString() : null,
        cid: d.pages?.[0]?.cid ?? null,
        replyCount: d.stat?.reply ?? 0,
      },
    }
  }

  /** 标签（比标题更能说明"这是什么") */
  async function tags(bvid) {
    const r = await api('/x/tag/archive/tags', { bvid })
    return r.ok ? { ...r, data: (r.data ?? []).map((t) => t.tag_name).filter(Boolean) } : { ...r, data: [] }
  }

  /**
   * 评论。sort=1 按时间，sort=2 按热度。
   * 注意：oid 要传 **aid**（数字），传 bvid 会 -404「啥都木有」。
   */
  async function replies(aid, { sort = 2, ps = 10, pn = 1 } = {}) {
    const r = await api('/x/v2/reply', { type: 1, oid: aid, sort, ps: Math.min(20, ps), pn })
    if (!r.ok) return { ...r, data: [] }
    const list = (r.data?.replies ?? []).map((x) => ({
      rpid: Number(x.rpid) || 0,
      mid: Number(x.mid) || 0,
      like: Number(x.like) || 0,
      user: x.member?.uname ?? '',
      text: String(x.content?.message ?? ''),
      replies: Number(x.rcount) || 0,
      ctime: Number(x.ctime) || 0,
    }))
    return { ...r, data: list, total: r.data?.page?.count ?? 0 }
  }

  /**
   * 某条评论下面的楼中楼（只支持两层，B 站就两层）。
   * root 是**那条主评论的 rpid**（不是 aid）。
   */
  async function subReplies(aid, rootRpid, { ps = 20, pn = 1 } = {}) {
    const r = await api('/x/v2/reply/reply', { type: 1, oid: aid, root: rootRpid, ps: Math.min(20, ps), pn })
    if (!r.ok) return { ...r, data: [] }
    const list = (r.data?.replies ?? []).map((x) => ({
      rpid: Number(x.rpid) || 0,
      mid: Number(x.mid) || 0,
      user: x.member?.uname ?? '',
      text: String(x.content?.message ?? ''),
      ctime: Number(x.ctime) || 0,
    }))
    return { ...r, data: list, total: r.data?.page?.count ?? 0 }
  }

  /**
   * 弹幕。oid 要传 **cid**（不是 aid，不是 bvid）。
   * 返回 deflate-raw 压缩的 XML，需要手动解压。
   */
  async function danmaku(cid) {
    if (!cid) return { ok: false, code: 'NO_CID', message: '没有 cid', data: [] }
    if (now() < RISK.read.until) {
      return { ok: false, code: 'COOLDOWN', message: `风控冷却中，${fmtWait(RISK.read.until - now())}后再试`, data: [] }
    }
    try {
      const r = await throttle(() =>
        raw(`https://api.bilibili.com/x/v1/dm/list.so?oid=${cid}`, {
          referer: 'https://www.bilibili.com/',
        }),
      )
      const buf = Buffer.from(await r.arrayBuffer())
      let xml = ''
      for (const fn of [inflateRawSync, inflateSync, gunzipSync]) {
        try {
          xml = fn(buf).toString('utf8')
          break
        } catch {
          /* 换下一种 */
        }
      }
      if (!xml) xml = buf.toString('utf8')
      return { ok: true, code: 0, message: 'OK', data: parseDanmaku(xml) }
    } catch (err) {
      return { ok: false, code: 'NETWORK', message: String(err?.message ?? err), data: [] }
    }
  }

  /**
   * 字幕（需要登录）。P2 不依赖它，但保留：一旦用户把有效 cookie 填进来，
   * 她就能读到官方/AI 字幕，比弹幕扎实得多。
   */
  async function subtitle(bvid, cid) {
    const r = await api('/x/player/wbi/v2', { bvid, cid }, { signed: true })
    if (!r.ok) return { ...r, data: [] }
    const subs = r.data?.subtitle?.subtitles ?? []
    if (!subs.length) return { ok: false, code: 'NO_SUB', message: '这条没有字幕轨（或需要登录）', data: [] }
    const out = []
    for (const s of subs.slice(0, 2)) {
      const url = String(s.subtitle_url ?? '')
      if (!url.startsWith('http')) continue
      try {
        const rr = await throttle(() => raw(url))
        const j = await rr.json()
        for (const line of j?.body ?? []) {
          out.push({ t: Number(line.from) || 0, text: String(line.content ?? '').trim() })
        }
      } catch {
        /* 单轨失败不影响其它 */
      }
      if (out.length) break
    }
    return out.length
      ? { ok: true, code: 0, message: 'OK', data: out }
      : { ok: false, code: 'NO_SUB', message: '字幕拉取失败', data: [] }
  }

  /** 是否登录（只用于观测台显示"能不能读字幕"，不参与 persona） */
  async function whoami() {
    const r = await api('/x/web-interface/nav')
    return {
      ok: Boolean(r.ok),
      isLogin: Boolean(r.data?.isLogin),
      uname: r.data?.uname ?? '',
      mid: r.data?.mid ?? 0,
    }
  }

  /**
   * 发一条评论（在视频下面）。**写操作，需要登录 cookie + bili_jct**。
   *
   * @param {number} aid 视频 aid（不是 bvid —— bvid 会 -404）
   * @param {string} message 正文
   * @returns {Promise<{ok:boolean, code:any, message:string, data:{rpid:number}|null}>}
   */
  async function replyAdd(aid, message) {
    const msg = String(message ?? '').trim()
    if (!msg) return { ok: false, code: 'EMPTY', message: '评论是空的', data: null }
    if (msg.length > 1000) return { ok: false, code: 'TOO_LONG', message: '太长了（B 站上限 1000 字）', data: null }
    const r = await apiPost('/x/v2/reply/add', { oid: aid, type: 1, message: msg, plat: 1 }, {
      referer: `https://www.bilibili.com/video/av${aid}`,
    })
    if (!r.ok) return r
    return { ok: true, code: 0, message: 'OK', data: { rpid: Number(r.data?.rpid) || 0 } }
  }

  /**
   * 回复**别人的一条评论**（楼中楼）。
   *
   * 参数必须是两个不同的 rpid：
   *   root   = 这条楼的**主评论** rpid（她那条评论本身）
   *   parent = 要回的那一条 rpid
   * 传错（比如两个都传主评论）B 站不会报错，但回复会平铺在主楼下而不是挂在被回复者下面
   * —— 看起来像"她对着空气说话"，很容易被当成"没回"。
   */
  async function replyReply(aid, rootRpid, parentRpid, message) {
    const msg = String(message ?? '').trim()
    if (!msg) return { ok: false, code: 'EMPTY', message: '回复是空的', data: null }
    if (msg.length > 1000) return { ok: false, code: 'TOO_LONG', message: '太长了（B 站上限 1000 字）', data: null }
    if (!rootRpid || !parentRpid) return { ok: false, code: 'NO_TARGET', message: '不知道在回哪一条', data: null }
    const r = await apiPost('/x/v2/reply/add', {
      oid: aid, type: 1, message: msg, root: rootRpid, parent: parentRpid, plat: 1,
    }, { referer: `https://www.bilibili.com/video/av${aid}` })
    if (!r.ok) return r
    return { ok: true, code: 0, message: 'OK', data: { rpid: Number(r.data?.rpid) || 0 } }
  }

  /** 是否已登录 + mid（写操作前的自检，观测台也用它显示"能不能发"） */
  async function me() {
    if (!cookie) return { ok: false, isLogin: false, mid: 0, uname: '', canWrite: false, why: '没有 cookie' }
    const w = await whoami()
    return { ...w, canWrite: Boolean(w.isLogin && csrf()), why: w.isLogin ? (csrf() ? '' : 'cookie 里没有 bili_jct') : 'cookie 已失效' }
  }

  /**
   * 取播放地址。**只用来抽几帧看画面**，不下载整段视频。
   * fnval=16 → DASH（视频轨与音频轨分开），我们只要视频轨，音频一点都不要。
   * 返回的 url 带有效期（约两小时），并且需要 Referer + UA + cookie 才拉得动——
   * 这三样由调用方（video.js）拼进 ffmpeg 的 -headers。
   */
  async function playurl(bvid, cid, o = {}) {
    if (!bvid || !cid) return { ok: false, code: 'BAD_ARG', message: '缺 bvid 或 cid', data: null }
    const r = await api('/x/player/playurl', { bvid, cid, qn: o.qn ?? 64, fnval: 16, fourk: 0 })
    if (!r.ok) return r
    const d = r.data ?? {}
    const v = d.dash?.video?.[0]
    const url = v?.baseUrl ?? v?.base_url ?? d.durl?.[0]?.url ?? ''
    return {
      ok: Boolean(url),
      code: r.code,
      message: url ? 'OK' : '没有可用的视频地址',
      data: { url, duration: d.timelength ? d.timelength / 1000 : 0, width: v?.width ?? 0, height: v?.height ?? 0 },
    }
  }

  /**
   * 短链 / 页面链接 → BV 号（2026-10-28，用户 m01284：他递来一条链接，她得打得开）
   *
   * b23.tv 会 302 到 www.bilibili.com/video/BV…，raw() 默认跟随重定向，
   * 所以 r.url 就是落地地址；跟随被关掉时再从正文里抠一次。
   * 只认 BV：详情接口只吃 bvid，av 号在这里一律不接。
   */
  async function resolveUrl(url) {
    const u = String(url ?? '').trim().replace(/[)\],。；;，]+$/, '')
    if (!u) return { ok: false, code: 'BAD_ARG', message: '没有链接', data: null }
    const short = /^(?:https?:\/\/)?(?:b23\.tv|bili2233\.cn)\//i.test(u)
    const have = /BV[0-9A-Za-z]{10}/.exec(u)
    if (have && !short) return { ok: true, code: 0, message: 'OK', data: { bvid: have[0], url: u } }
    if (!/^https?:\/\//i.test(u)) return { ok: false, code: 'BAD_URL', message: '这不是链接', data: null }
    if (now() < RISK.read.until) {
      return { ok: false, code: 'COOLDOWN', message: `风控冷却中，${fmtWait(RISK.read.until - now())}后再试`, data: null }
    }
    try {
      const r = await throttle(() => raw(u))
      const final = String(r?.url ?? '')
      const hit = /BV[0-9A-Za-z]{10}/.exec(final)
      if (hit) return { ok: true, code: 0, message: 'OK', data: { bvid: hit[0], url: final } }
      const text = await r.text().catch(() => '')
      const hit2 = /BV[0-9A-Za-z]{10}/.exec(text)
      if (hit2) return { ok: true, code: 0, message: 'OK', data: { bvid: hit2[0], url: final } }
      return { ok: false, code: 'NOT_VIDEO', message: '这个链接点开不是一条视频', data: null }
    } catch (err) {
      return { ok: false, code: 'NETWORK', message: String(err?.message ?? err).slice(0, 120), data: null }
    }
  }

  return {
    popular,
    ranking,
    precious,
    search,
    related,
    resolveUrl,
    view,
    playurl,
    tags,
    replies,
    subReplies,
    replyAdd,
    replyReply,
    me,
    danmaku,
    subtitle,
    whoami,
    // 测试用
    _internal: { ensureMk, ensureBuvid, get mk() { return mk }, get cookie() { return cookie }, csrf },
    setCookie(c) {
      cookie = normalizeCookie(c)
      return cookie
    },
  }
}

/** 各种来源的视频对象字段不统一，统一成一个形状 */
function toVideo(v) {
  const stat = v.stat ?? {}
  const owner = v.owner ?? {}
  return {
    bvid: String(v.bvid ?? ''),
    aid: Number(v.aid) || 0,
    title: String(v.title ?? '').trim(),
    duration: Number(v.duration) || parseDur(v.duration),
    up: String(owner.name ?? v.author ?? '').trim(),
    mid: Number(owner.mid ?? v.mid) || 0,
    view: Number(stat.view ?? v.play) || 0,
    like: Number(stat.like ?? v.like) || 0,
    reply: Number(stat.reply ?? v.video_review) || 0,
    danmaku: Number(stat.danmaku ?? v.danmaku) || 0,
    tname: String(v.tname ?? '').trim(),
    pic: String(v.pic ?? '').trim(),
  }
}

/** "12:34" → 754 */
function parseDur(x) {
  const m = String(x ?? '').match(/^(\d+):(\d{1,2})$/)
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0
}
