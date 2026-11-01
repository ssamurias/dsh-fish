/**
 * biliqr.js —— B 站扫码登录（宿主侧，2026-11-01）
 *
 * 为什么要有这一半：
 *   设置页原来只能让人打开 F12 手动抄 SESSDATA + bili_jct（COOKIE_HINT 那一整段），
 *   抄错一个字符就"登不上、也不说是哪儿不对"。扫码是把这段手工活交给手机 App。
 *
 * 为什么不在浏览器里直接请求 B 站：
 *   那条 generate / poll 接口没有 CORS 头，页面里 fetch 一律被浏览器挡死。
 *   所以二维码的生成、轮询、换 cookie 全在宿主这一侧做，页面只跟 `/dsh-fish/bili/qr*` 说话。
 *
 * 三条安全约定（比功能本身重要）：
 *   1. **key 与 cookie 只活在内存里**。没点「确认」之前不落盘、不进日志、不回给页面。
 *      页面拿到的只有「登的是谁」（昵称 + uid），永远拿不到 cookie 原文 —— 和 /owner 同一条规矩。
 *   2. **确认才写盘**。轮询到 DONE 只是把 cookie 攥在 pending 里，写 owner.json 要人再点一次。
 *   3. **过期就不认**。180 秒之后既不再轮询，也不接受 save；丢掉就是丢掉，下次重新生成。
 *
 * 状态机：waiting → scanned → confirmed → （人点确认）saved
 *              ↘ expired / gone / error
 */

import { readOwner } from './store.js'
import { publicOwner, saveOwner, saveAccount } from './owner.js'
import { createClient } from './bili.js'
import { qrSvg } from './qr.js'

const GEN_URL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main-fe-header'
const pollUrl = (key) => `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?source=main-fe-header&qrcode_key=${encodeURIComponent(key)}`

// B 站对这个接口比较挑 UA：拿 node 默认 UA 去问，偶尔会直接给 -412。
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

export const QR_TTL_MS = 180_000
const FORGET_MS = QR_TTL_MS + 120_000 // 过期之后再留一会儿：让人还能看到"已过期"而不是"不存在"
const MAX_PENDING = 3
const MIN_POLL_GAP_MS = 800
const MIN_START_GAP_MS = 1_200

// 只留这几个键，和 owner.js 的 COOKIE_NAMES 对齐（buvid3 有时给、有时不给，有就留着）。
const WANT = ['SESSDATA', 'bili_jct', 'buvid3', 'DedeUserID', 'DedeUserID__ckMd5', 'sid']

/** 把 Set-Cookie 那几行里我们要的键抠出来。 */
function pickCookies(headers) {
  let lines = []
  try {
    if (typeof headers?.getSetCookie === 'function') lines = headers.getSetCookie() ?? []
  } catch { lines = [] }
  if (!lines.length) {
    const raw = headers?.get?.('set-cookie') ?? ''
    // 兜底：没有 getSetCookie 的老运行时。expires 里也有逗号，所以只在"逗号后面跟着 name="处切。
    if (raw) lines = String(raw).split(/,(?=\s*[A-Za-z0-9_]+=)/)
  }
  const got = {}
  for (const line of lines) {
    const head = String(line).split(';')[0]
    const i = head.indexOf('=')
    if (i <= 0) continue
    const name = head.slice(0, i).trim()
    const value = head.slice(i + 1).trim()
    if (WANT.includes(name) && value) got[name] = value
  }
  return got
}

/** 拼成 owner.json 里那种 `a=1; b=2` 的形状（顺序固定，测试好比对）。 */
function joinCookies(got) {
  return WANT.filter((n) => got[n]).map((n) => `${n}=${got[n]}`).join('; ')
}

/**
 * 建一个扫码登录的小机器。把 fetch / 时钟 / 随机数都做成可注入，
 * 单测就不用打真网（和 bili.js 的 createClient 一个路数）。
 */
export function createQrLogin(opts = {}) {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const now = opts.now ?? (() => Date.now())
  const log = opts.log ?? (() => {})

  /** @type {Map<string, {key:string,url:string,createdAt:number,lastPollAt:number,state:string,cookie:string,account:{mid:string,name:string}|null,canWrite:boolean,note:string}>} */
  const pending = new Map()
  let lastStart = 0

  function sweep() {
    const t = now()
    for (const [k, e] of pending) {
      if (t - e.createdAt > FORGET_MS) pending.delete(k)
    }
    // 超出上限就先丢最老的：这是本机上的登录窗口，不是缓存，不心疼。
    while (pending.size > MAX_PENDING) {
      const oldest = [...pending.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0]
      if (!oldest) break
      pending.delete(oldest[0])
    }
  }

  async function request(url) {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 12_000)
    try {
      return await fetchImpl(url, {
        signal: ctl.signal,
        headers: {
          'user-agent': UA,
          referer: 'https://www.bilibili.com/',
          accept: 'application/json, text/plain, */*',
          'accept-language': 'zh-CN,zh;q=0.9',
        },
      })
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 生成一张新码。返回里的 svg 直接给页面当图用：
   * 登录 URL 里有 qrcode_key，走第三方图片服务等于把钥匙递出去。
   */
  async function start() {
    sweep()
    const t = now()
    if (t - lastStart < MIN_START_GAP_MS) {
      return { ok: false, why: '刚生成过，等一秒再点。', retryAfterMs: MIN_START_GAP_MS - (t - lastStart) }
    }
    lastStart = t

    let res
    try {
      res = await request(GEN_URL)
    } catch (err) {
      return { ok: false, why: `连不上 B 站：${String(err?.message ?? err).slice(0, 60)}` }
    }
    let body
    try {
      body = JSON.parse(await res.text())
    } catch {
      return { ok: false, why: `B 站回的不是 JSON（HTTP ${res.status}）` }
    }
    const url = String(body?.data?.url ?? '')
    const key = String(body?.data?.qrcode_key ?? '')
    if (body?.code !== 0 || !url || !key) {
      return { ok: false, why: `B 站没给码：${body?.code ?? '?'} ${body?.message ?? ''}`.trim() }
    }

    let svg = ''
    try {
      svg = qrSvg(url, { ec: 'M', scale: 6, margin: 3 })
    } catch (err) {
      // 画不出来多半是 URL 长得超出预期：宁可当场说清楚，也别给一张扫不出的图。
      return { ok: false, why: `二维码画不出来：${String(err?.message ?? err).slice(0, 60)}` }
    }

    pending.set(key, {
      key,
      url,
      createdAt: t,
      lastPollAt: 0,
      state: 'waiting',
      cookie: '',
      account: null,
      canWrite: false,
      note: '',
    })
    // 放进去之后再收一次：MAX_PENDING 管的是"此刻攥着几把钥匙"，不是"放之前有几把"。
    sweep()
    return { ok: true, key, svg, ttlMs: QR_TTL_MS, expiresAt: t + QR_TTL_MS }
  }

  /** 轮询一次。页面每秒问一次也没关系：真请求有 800ms 的下限。 */
  async function poll(key) {
    sweep()
    const e = pending.get(String(key ?? ''))
    if (!e) return { state: 'gone', why: '这张码已经不在了，重新点「扫码登录」。' }

    if (e.state === 'confirmed') {
      return { state: 'confirmed', account: e.account, canWrite: e.canWrite, note: e.note }
    }
    if (e.state === 'saved') return { state: 'saved', account: e.account }
    if (e.state === 'expired') return { state: 'expired', why: '二维码过期了，点「刷新」换一张。' }

    const t = now()
    if (t - e.createdAt > QR_TTL_MS) {
      e.state = 'expired'
      return { state: 'expired', why: '二维码过期了，点「刷新」换一张。' }
    }
    // 太密就回上次的结果，不打扰 B 站
    if (t - e.lastPollAt < MIN_POLL_GAP_MS) {
      return { state: e.state, throttled: true, expiresAt: e.createdAt + QR_TTL_MS }
    }
    e.lastPollAt = t

    let res
    try {
      res = await request(pollUrl(e.key))
    } catch (err) {
      return { state: e.state, why: `连不上 B 站：${String(err?.message ?? err).slice(0, 60)}`, expiresAt: e.createdAt + QR_TTL_MS }
    }

    let body
    const text = await res.text().catch(() => '')
    try {
      body = JSON.parse(text)
    } catch {
      return { state: e.state, why: `B 站回的不是 JSON（HTTP ${res.status}）`, expiresAt: e.createdAt + QR_TTL_MS }
    }
    // 顶层 code 不对（-412 风控之类）：这次不算数，接着轮询
    if (body?.code !== 0) {
      return { state: e.state, why: `B 站：${body?.code} ${body?.message ?? ''}`.trim(), expiresAt: e.createdAt + QR_TTL_MS }
    }

    const code = Number(body?.data?.code ?? body?.code)
    if (code === 86101) {
      e.state = 'waiting'
      return { state: 'waiting', expiresAt: e.createdAt + QR_TTL_MS }
    }
    if (code === 86090) {
      e.state = 'scanned'
      return { state: 'scanned', why: '扫到了，在手机上点一下「确认登录」。', expiresAt: e.createdAt + QR_TTL_MS }
    }
    if (code === 86038) {
      e.state = 'expired'
      return { state: 'expired', why: '二维码过期了，点「刷新」换一张。' }
    }
    if (code !== 0) {
      return { state: e.state, why: `B 站：${code} ${body?.data?.message ?? ''}`.trim(), expiresAt: e.createdAt + QR_TTL_MS }
    }

    // ---- 到这里就是登录成功了 ----
    const cookie = joinCookies(pickCookies(res.headers))
    if (!/SESSDATA=/.test(cookie)) {
      e.state = 'error'
      e.note = '扫码成功了，但 B 站没把 SESSDATA 发下来'
      log('扫码成功但没有 SESSDATA，放弃这次登录')
      return { state: 'error', why: e.note }
    }
    if (!/bili_jct=/.test(cookie)) {
      // 没有 bili_jct 就发不了评论——但仍是可以登录的账号，让人自己决定要不要存。
      e.note = '这份登录里没有 bili_jct：能看，不能评论。'
    }
    e.cookie = cookie
    e.state = 'confirmed'

    // 认一下这是谁。认不出来（网络抖动）不算失败：cookie 已经拿到了。
    let account = null
    let canWrite = false
    try {
      const client = createClient({ cookie, fetchImpl, now })
      const me = await client.me()
      if (me?.isLogin) {
        account = { mid: String(me.mid ?? ''), name: String(me.uname ?? '') }
        canWrite = Boolean(me.canWrite)
        if (!canWrite && !e.note) e.note = '这份登录不能发评论（少了 bili_jct 或已失效）。'
      } else if (!e.note) {
        e.note = 'cookie 拿到了，但暂时认不出是哪个账号。'
      }
    } catch (err) {
      if (!e.note) e.note = `cookie 拿到了，但认账号时连不上 B 站：${String(err?.message ?? err).slice(0, 40)}`
    }
    e.account = account
    e.canWrite = canWrite
    log(`扫码登录确认：${account ? `${account.name}(uid ${account.mid})` : '未知账号'}`)
    return { state: 'confirmed', account, canWrite, note: e.note }
  }

  /**
   * 人点了「确认」才写盘。
   * 只写 cookie 的 owner.json 与只读的 account —— 领养人那两格（mid / nickname）一个字都不碰。
   */
  async function save(key, root) {
    sweep()
    const e = pending.get(String(key ?? ''))
    if (!e) return { ok: false, why: '这张码已经不在了，重新扫码。' }
    if (e.state !== 'confirmed') return { ok: false, why: '还没扫码确认，先别存。' }
    if (now() - e.createdAt > QR_TTL_MS) {
      e.state = 'expired'
      pending.delete(e.key)
      return { ok: false, why: '这张码过期了，重新扫码再存。' }
    }
    const r = await saveOwner({ cookie: e.cookie }, root)
    if (!r.ok) return { ok: false, why: r.note || '没存上。' }
    let owner = r.owner
    if (e.account?.mid) {
      try {
        owner = await saveAccount({ mid: e.account.mid, uname: e.account.name }, root)
      } catch { /* account 只是"记一下是谁"，写不进去不影响 cookie 已存 */ }
    }
    e.cookie = ''
    e.state = 'saved'
    pending.delete(e.key)
    return { ok: true, note: '存下了。', owner: owner ?? publicOwner(await readOwner(root)) }
  }

  /** 关浮层 / 点取消：把这张码连同攥着的 cookie 一起忘掉。 */
  function drop(key) {
    const e = pending.get(String(key ?? ''))
    if (e) {
      e.cookie = ''
      pending.delete(e.key)
    }
    return { ok: true }
  }

  /** 插件卸载时清干净（内存里的凭据不该比进程活得久）。 */
  function clear() {
    for (const e of pending.values()) e.cookie = ''
    pending.clear()
  }

  /** 只看不写：单测和自检用。 */
  function peek(key) {
    const e = pending.get(String(key ?? ''))
    return e ? { state: e.state, hasCookie: Boolean(e.cookie), account: e.account } : null
  }

  return { start, poll, save, drop, clear, peek, size: () => pending.size }
}