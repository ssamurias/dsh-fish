/**
 * browse.js —— 她"刷 B 站"这件事
 *
 * 分工严格区分（这是 P2 的核心设计）：
 *   **代码负责"看见什么"**：拉列表、过滤黑名单、去重、深读评论弹幕、控长度。
 *   **她负责"怎么想"**：看什么值得停、信不信、要不要写、写什么。
 * 代码绝不生成任何"感想"——一旦代码替她总结，她就只是一个内容管道。
 *
 * 三条硬约束：
 *   1. **只读**。不登录、不点赞、不投币、不评论、不下载视频。没有版权面，也没有账号风险。
 *   2. **永不抛出**。网络失败 = 今天没逛到东西，不是故障。醒来流程不能因此中断。
 *   3. **素材不是指令**。所有网络文本统一走 capture.debrief() 现立牌子，
 *      标题里的「你应该…」只是别人写下的字。
 */

import { debrief } from './capture.js'
import { tsMs } from './schema.js'
import { appendEvent, readEvents } from './store.js'
import { dateKey } from './settings.js'
// 评论区里别人的话（2026-10-24，用户 m02454）：一轮浏览最多留 1 条给她读。
import { recordVoice } from './voices.js'

/**
 * 每阶段从哪拿东西：早期看老片（时间感），后期看热门/排行（世界的动静）。
 *
 * 2026-10-27（用户 m00763）：阶段 1 不再只吃「入站必刷」那一份固定片单。
 * 重置会清空事件流，seen 变空、阶段回到 1，而「入站必刷」是 98 条全站老片的
 * 固定榜——只吃它，每次重置首批都是同样四条。改成老片 + 热门 + 全站排行 +
 * 轮换的分区排行多路混，候选再打散，并列分数不再按接口顺序固定。
 */
const SOURCES = {
  1: ['precious', 'popular', 'ranking', 'ranking-tid'],
  2: ['popular'],
  3: ['popular', 'ranking'],
  4: ['ranking', 'popular'],
}

/**
 * 可轮换的分区（B 站分区 rid）。刻意避开鬼畜(119)这类容易被黑名单扫掉的区，
 * 也避开番剧/影视这种拿不到正片的区——拿回来全是遮挡广告没有意义。
 */
const RANKING_TIDS = [1, 3, 4, 5, 36, 129, 160, 181, 188, 211]

/** 从池子里不重复抽 n 个分区（rand 可注入，测试才稳定） */
function pickTids(rand, n) {
  const pool = [...RANKING_TIDS]
  const out = []
  for (let i = 0; i < n && pool.length; i++) {
    out.push(pool.splice(Math.floor(rand() * pool.length), 1)[0])
  }
  return out
}

/** Fisher-Yates。并列分数的先后由它决定，所以并列不再固定成接口顺序。 */
function shuffle(list, rand) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    const t = list[i]
    list[i] = list[j]
    list[j] = t
  }
  return list
}

/** 素材总长上限：超过就砍（防止一次唤醒吃掉几千 token） */
const MAX_MATERIAL_CHARS = 6000

/**
 * 黑名单命中判定。返回命中的关键词/up，未命中返回 null。
 * 支持三种：标题/UP名/标签里的关键词、屏蔽的 mid、时长过短。
 */
export function avoidHit(v, cfg, tags = []) {
  const av = cfg?.avoid ?? {}
  const mid = String(v?.mid ?? '')
  if (mid && (av.upMids ?? []).some((m) => String(m) === mid)) return `up:${mid}`
  const kw = (cfg?.avoid?.keywords ?? []).map(String).filter(Boolean)
  if (kw.length) {
    const hay = `${v?.title ?? ''}\u0000${v?.up ?? ''}\u0000${(tags ?? []).join('\u0000')}`
    for (const k of kw) if (hay.includes(k)) return k
  }
  return null
}

/**
 * 打分：只反映"值不值得停一下"，不反映她的喜好（喜好只有她自己知道）。
 * 依据：中等时长更好消化；点赞率说明内容密度；有弹幕说明有人在看。
 */
export function scoreOf(v) {
  const dur = Number(v?.duration ?? 0)
  let s = 1
  if (dur >= 180 && dur <= 1500) s += 0.6
  else if (dur > 1500) s += 0.15
  else s -= 0.2
  const view = Number(v?.view ?? 0)
  const like = Number(v?.like ?? 0)
  if (view > 0 && like > 0) {
    const rate = like / view
    if (rate > 0.05) s += 0.5
    else if (rate > 0.02) s += 0.25
  }
  if (Number(v?.danmaku ?? 0) > 50) s += 0.15
  return s
}

/**
 * 过滤 + 排序。纯函数，好测。
 * @param {object[]} list
 * @param {object} cfg
 * @param {{seen?:Set<string>, limit?:number}} o
 */
export function rankVideos(list, cfg, o = {}) {
  const seen = o.seen instanceof Set ? o.seen : new Set(o.seen ?? [])
  const minDur = Number(cfg?.avoid?.minDuration ?? 60)
  const out = []
  const usedBvid = new Set()
  // 被「看过」摘掉几条（issue #16 第一半）：调用方要能分清
  // 「平台这次没给」和「翻到的都看过了」。传了 stats 就往里累加，返回值形状不变。
  const stats = o.stats && typeof o.stats === 'object' ? o.stats : null
  if (stats && !Number.isFinite(stats.hiddenSeen)) stats.hiddenSeen = 0
  for (const v of Array.isArray(list) ? list : []) {
    if (!v?.bvid) continue
    if (seen.has(v.bvid)) {
      if (stats) stats.hiddenSeen += 1
      continue
    }
    if (usedBvid.has(v.bvid)) continue
    const dur = Number(v.duration ?? 0)
    if (minDur > 0 && dur > 0 && dur < minDur) continue
    if (avoidHit(v, cfg)) continue
    usedBvid.add(v.bvid)
    out.push({ v, score: scoreOf(v) })
  }
  out.sort((a, b) => b.score - a.score)
  const limit = Math.max(1, Math.min(20, Number(o.limit ?? 5)))
  return out.slice(0, limit).map((x) => x.v)
}

/** 播放量中文：12.3万 / 1.2亿 / 3456 */
export function fmtCount(n) {
  const v = Number(n) || 0
  if (v >= 1e8) return `${(v / 1e8).toFixed(1)}亿`
  if (v >= 1e4) return `${(v / 1e4).toFixed(1)}万`
  return String(v)
}

/**
 * 深读一条：详情（简介）+ 标签 + 热评 + 弹幕抽样。
 * 每一项都是独立 try：评论挂了不影响弹幕，弹幕挂了不影响简介。
 */
export async function absorb(client, v, cfg, o = {}) {
  const out = {
    video: v,
    desc: '',
    pubdate: null,
    tags: [],
    comments: [],
    danmaku: [],
    cid: null,
    aid: Number(v?.aid) || 0,
  }

  try {
    // 调用方已经把详情取回来了就不再取一次（what=video 那条路要两次请求变一次）
    const d = o.view ?? await client.view(v.bvid)
    if (d?.ok && d.data) {
      out.desc = String(d.data.desc ?? '').replace(/\s+/g, ' ').trim().slice(0, 400)
      out.pubdate = d.data.pubdate ?? null
      out.cid = d.data.cid ?? null
      out.aid = Number(d.data.aid) || out.aid
      if (!out.video.title) out.video.title = d.data.title
      if (!out.video.up) out.video.up = d.data.up
    }
  } catch { /* 详情失败就只靠列表信息 */ }

  try {
    const t = await client.tags(v.bvid)
    if (t?.ok) out.tags = (t.data ?? []).slice(0, 6)
  } catch { /* ignore */ }

  // 标签也可能是黑名单命中项 —— 这一步必须在深读之后再做一次，
  // 否则「标题干净但标签是鬼畜」的视频会漏过第一次过滤。
  if (avoidHit(v, cfg, out.tags)) return { ...out, blocked: avoidHit(v, cfg, out.tags) }

  const nComments = Math.max(0, Math.min(20, Number(cfg?.browse?.deepRead ?? 0)))
  if (nComments > 0 && out.aid) {
    try {
      const r = await client.replies(out.aid, { sort: 2, ps: nComments })
      if (r?.ok) {
        out.comments = (r.data ?? [])
          .map((c) => ({
            text: String(c.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
            like: Number(c.like) || 0,
          }))
          .filter((c) => c.text)
          .slice(0, nComments)
      }
    } catch { /* ignore */ }
  }

  const nDm = Math.max(0, Math.min(30, Number(cfg?.browse?.danmaku ?? 8)))
  if (nDm > 0 && out.cid) {
    try {
      const d = await client.danmaku(out.cid)
      if (d?.ok) {
        const { sampleDanmaku } = await import('./bili.js')
        out.danmaku = sampleDanmaku(d.data ?? [], nDm, Number(v.duration ?? 0))
      }
    } catch { /* ignore */ }
  }

  return out
}

/** 一条视频 → 给人读的几行（不含任何评价词） */
export function renderItem(p, i) {
  const v = p.video
  const lines = []
  const dur = v.duration
    ? `${Math.floor(Number(v.duration) / 60)}分${String(Number(v.duration) % 60).padStart(2, '0')}秒`
    : ''
  const meta = [
    dur,
    v.up ? `UP：${v.up}` : '',
    v.view ? `${fmtCount(v.view)}播放` : '',
    v.like ? `${fmtCount(v.like)}赞` : '',
    p.pubdate ? `发布于 ${String(p.pubdate).slice(0, 10)}` : '',
  ].filter(Boolean)
  lines.push(`〔${i + 1}〕${v.bvid}  ${v.title}`)
  if (meta.length) lines.push(`     ${meta.join(' · ')}`)
  if (p.tags.length) lines.push(`     标签：${p.tags.join(' / ')}`)
  if (p.desc) lines.push(`     简介：${p.desc}`)
  for (const c of p.comments) lines.push(`     [热评 ${c.like}] ${c.text}`)
  if (p.danmaku.length) {
    // issue #67：弹幕是按时间均匀抽的，这里再截前 8 条就只剩开头；等距挑 8 条。
    const all = p.danmaku
    const picked = all.length <= 8 ? all : Array.from({ length: 8 }, (_, i) => all[Math.round(i * (all.length - 1) / 7)])
    const parts = picked.map((d) => {
      const m = Math.floor(d.t / 60)
      const s = String(Math.floor(d.t % 60)).padStart(2, '0')
      return `${m}:${s} ${d.text}`
    })
    lines.push(`     弹幕：${parts.join(' ｜ ')}`)
  }
  return lines.join('\n')
}

/** 拼成整块素材（最后统一套一次 debrief，而不是每条套一层——省 token） */
export function renderMaterial(packs, o = {}) {
  if (!packs.length) return ''
  const body = packs.map((p, i) => renderItem(p, i)).join('\n\n')
  const head = o.head === undefined
    ? `${packs.length} 条。平台按它的算法推的，没有经过你的同意。`
    : String(o.head)
  const text = debrief(body, 'B站')
  let out = head ? `${head}\n\n${text}` : text
  if (out.length > MAX_MATERIAL_CHARS) {
    out = out.slice(0, MAX_MATERIAL_CHARS) + '\n\n（后面的内容太长，没加载完。）'
  }
  return out
}

/**
 * 多久以内算「刚看过」。
 *
 * 2026-11-01（issue #16 第一半，用户 m03454）：这份集合原来只增不减、不分日期、
 * 也不分是谁看的——看过一次就等于永久判了它死刑。真机例子：才浅那条《魔刀千刃》
 * 在 10-30 看过一眼，之后不管搜什么词都再也进不来，而 B 站客户端里它就排第一。
 * 一周是个够用的尺度：够挡住「同一批东西连着推」，又不至于把老东西锁死。
 */
export const SEEN_TTL_DAYS = 7

/**
 * 已经看过的 bvid（来自 meta `looked:<bvid>`，只认最近 SEEN_TTL_DAYS 天）。
 * @param {object[]} events
 * @param {{now?:number, days?:number}} [o] now 只为测试注入；days<=0 表示不过期（老行为）
 */
export function seenBvids(events, o = {}) {
  const days = Number(o.days ?? SEEN_TTL_DAYS)
  const now = Number(o.now ?? Date.now())
  const ttl = days > 0 ? days * 86400000 : 0
  const s = new Set()
  for (const e of events ?? []) {
    if (e?.type !== 'meta') continue
    const t = String(e.text ?? '')
    if (!t.startsWith('looked:')) continue
    // 读不到时间的老事件（schema 定型前的手写档、单测夹具）按「还算看过」处理：
    // 宁可少推一条，也不能因为时间查不出来就把她刚看完的又端回她面前。
    const at = tsMs(e)
    if (ttl > 0 && at > 0 && now - at > ttl) continue
    s.add(t.slice(7).trim())
  }
  return s
}

/**
 * 自动刷翻到过、但**没摆到她面前**的那些（meta `browsed:<bvid>`，同样只认最近
 * SEEN_TTL_DAYS 天）。
 *
 * 和 `looked:` 分开记：安静刷不投递会话，翻到的东西她一条都没看见——记成「看过」，
 * 她自己去看时就会被 `seenBvids` 挡掉，得到一句「翻到的 N 条都看过了」（issue #62
 * 第 3 条，2026-11-09 用户拍板）。这份只给自动刷自己去重用，不进她看的路。
 * @param {object[]} events
 * @param {{now?:number, days?:number}} [o]
 */
export function browsedBvids(events, o = {}) {
  const days = Number(o.days ?? SEEN_TTL_DAYS)
  const now = Number(o.now ?? Date.now())
  const ttl = days > 0 ? days * 86400000 : 0
  const s = new Set()
  for (const e of events ?? []) {
    if (e?.type !== 'meta') continue
    const t = String(e.text ?? '')
    if (!t.startsWith('browsed:')) continue
    const at = tsMs(e)
    if (ttl > 0 && at > 0 && now - at > ttl) continue
    s.add(t.slice(8).trim())
  }
  return s
}

/** 今天已经刷过几次（meta `browse:YYYY-MM-DD`） */
export function browseCountToday(events, dk = dateKey()) {
  let n = 0
  for (const e of events ?? []) {
    if (e?.type !== 'meta') continue
    const t = String(e.text ?? '')
    if (t.startsWith('browse:') && t.includes(dk)) n++
  }
  return n
}

/** 最近一次刷站是什么时候（毫秒；没有就是 0）。安静刷用来摊开一天里的几次。 */
export function lastBrowseAt(events = []) {
  let last = 0
  for (const e of events ?? []) {
    if (e?.type !== 'meta') continue
    if (!String(e.text ?? '').startsWith('browse:')) continue
    const at = tsMs(e)
    if (at > last) last = at
  }
  return last
}

/**
 * 两次「安静刷」之间至少要隔多久（2026-11-07，用户 m00365）。
 *
 * 一天刷 4 次不等于 08:00 连着刷 4 回：把 12 小时按次数摊开，最少 30 分钟。
 * 配额（perDay）仍然是硬上限，这里只管节奏。
 */
export function browseGapMs(perDay = 1) {
  const n = Math.max(1, Math.min(24, Number(perDay) || 1))
  return Math.max(30, Math.floor((12 * 60) / n)) * 60_000
}

/**
 * 从事件流里还原某天看了哪些视频。
 *
 * 为什么把条目写进 meta 而不是另开一个 JSON 文件：
 *   事件流不能删除记录，是唯一可信源。报告是派生品，必须能从事件流重建。
 *   如果条目单独落一个文件，删掉重算就对不上了。
 *
 * meta 形状：`browse:2026-10-22 [{"bvid":"BV…","title":"…","up":"…","duration":183,"view":12345}]`
 */
/** 一条 meta 正文的实用上限（宿主 schema 会拒更长的），分片按这个切 */
export const BROWSE_CHUNK_MAX = 1800

/** 记账行的两个前缀：第一片 `browse:`，后续分片 `browse-more:`（顺序=事件顺序） */
const BROWSE_PREFIXES = ['browse:', 'browse-more:']

/**
 * 从一条 meta 正文里切出「某一天的条目数组」。
 *
 * 一次刷站看的那几条装不进一条 meta（单项带封面地址约 350 字），所以记账会分片：
 * 第一片 `browse:<日期> [...]`，其余 `browse-more:<日期> [...]`。
 * 读的一方必须两个前缀都认——只认第一个前缀，就只看得见第一片。
 * 2026-10-28 用户反馈的「累计看过 14 个、抽屉里只有 4 条」正是这个：每次刷站
 * 只落下前 4 条，其余被静默砍掉。
 *
 * @param {string} text meta 正文
 * @param {string} [dk] 只要这一天；不给就取行里自带的那天
 * @returns {{dk:string, arr:object[]}|null}
 */
export function parseBrowseLine(text, dk) {
  const t = String(text ?? '')
  for (const pre of BROWSE_PREFIXES) {
    if (!t.startsWith(pre)) continue
    const rest = t.slice(pre.length)
    const sp = rest.indexOf(' ')
    if (sp < 0) return null
    const day = rest.slice(0, sp).trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null
    if (dk && day !== dk) return null
    const json = rest.slice(sp + 1).trim()
    if (!json.startsWith('[')) return null
    try {
      const arr = JSON.parse(json)
      return Array.isArray(arr) ? { dk: day, arr } : null
    } catch {
      return null // 坏行跳过，不让读的一方崩
    }
  }
  return null
}

export function itemsFromEvents(events, dk = dateKey()) {
  const out = []
  const seen = new Set()
  for (const e of events ?? []) {
    if (e?.type !== 'meta') continue
    const got = parseBrowseLine(e.text, dk)
    if (!got) continue
    for (const it of got.arr) {
      const bvid = String(it?.bvid ?? '')
      if (!bvid || seen.has(bvid)) continue
      seen.add(bvid)
      out.push(it)
    }
  }
  return out
}

/**
 * 把条目切成若干片，每片 JSON 不超过 max 字。
 * 单项放不进就让它独占一片（不砍字段，宁可略超也不丢数据）。
 */
export function chunkBrowseItems(slim, max = BROWSE_CHUNK_MAX) {
  const chunks = []
  let cur = []
  for (const it of slim) {
    if (cur.length && JSON.stringify([...cur, it]).length > max) {
      chunks.push(cur)
      cur = [it]
    } else {
      cur = [...cur, it]
    }
  }
  if (cur.length) chunks.push(cur)
  return chunks
}

/** 落"今天看了这些"的记账（供报告与配额共用）：条目多就分片写多条 meta */
export async function recordBrowse(root, dk, picks, model) {
  const slim = (picks ?? []).slice(0, 20).map((p) => ({
    bvid: String(p.bvid ?? ''),
    title: String(p.title ?? '').slice(0, 80),
    up: String(p.up ?? '').slice(0, 40),
    duration: Number(p.duration) || 0,
    view: Number(p.view) || 0,
    pic: String(p.pic ?? '').slice(0, 200),
  })).filter((p) => p.bvid)
  if (!slim.length) return null
  const meta = { day: Number(model?.day ?? 0), stage: Number(model?.stage ?? 1), source: 'system' }
  let last = null
  const chunks = chunkBrowseItems(slim)
  for (let i = 0; i < chunks.length; i++) {
    const pre = i === 0 ? 'browse:' : 'browse-more:'
    try {
      last = await appendEvent(
        { type: 'meta', text: `${pre}${dk} ${JSON.stringify(chunks[i])}` },
        meta,
        root,
      )
    } catch {
      return last // 分片写失败就停：已落下的算数，不静默改写成半条
    }
  }
  return last
}

/**
 * 找一批候选视频。多来源混合后统一排序，避免只吃一个榜单。
 * 任何一路失败都只让候选变少，不让整件事失败。
 */
export async function candidates(client, model, cfg, o = {}) {
  const stage = Number(model?.stage ?? 1)
  const sources = o.sources ?? SOURCES[stage] ?? SOURCES[1]
  const seen = o.seen ?? new Set()
  const want = Math.max(1, Math.min(20, Number(cfg?.browse?.topN ?? 5)))
  // 随机源可注入：真跑用 Math.random，测试给固定序列才稳。
  const rand = typeof o.rand === 'function' ? o.rand : Math.random

  // 分区榜每次轮换几个不同的区：同样一次重置，也不再撞上同一批分区榜。
  const nTid = Math.max(0, Math.min(4, Number(cfg?.browse?.rankingTids ?? 2)))
  const tids = pickTids(rand, nTid)
  const expanded = []
  for (const src of sources) {
    if (src === 'ranking-tid') {
      for (const tid of tids) expanded.push(`tid:${tid}`)
    } else expanded.push(src)
  }

  const lists = []
  for (const src of expanded) {
    try {
      const r = src === 'popular'
        ? await client.popular(want * 3)
        : src === 'ranking'
          ? await client.ranking(0, 'all')
          : src.startsWith('tid:')
            ? await client.ranking(Number(src.slice(4)), 'all')
            : await client.precious(want * 3)
      if (r?.ok && Array.isArray(r.data)) lists.push(...r.data)
    } catch { /* 单路失败忽略 */ }
  }

  // 额外关键词（环境变量性质：用户想看她的世界里有这类东西，不是给她设性格）
  for (const kw of (cfg?.browse?.keywords ?? []).slice(0, 3)) {
    try {
      const r = await client.search(kw, { pageSize: want * 2 })
      if (r?.ok && Array.isArray(r.data)) lists.push(...r.data)
    } catch { /* ignore */ }
  }

  // 先打散再排序：分数不同的照旧按分数，并列的先后不再固定成接口顺序。
  return rankVideos(shuffle(lists, rand), cfg, { seen, limit: want, stats: o.stats })
}

/**
 * 完整一轮：拿候选 → 深读 → 拼素材。返回 { ok, text, picks, note }。永不抛出。
 */
export async function gather(client, model, cfg, o = {}) {
  const note = []
  try {
    const dk = o.dk ?? dateKey()
    const events = o.events ?? (await readEvents(o.root).then((r) => r.events).catch(() => []))
    // `mark`：这一趟翻到的该怎么记账。安静刷（mark: 'browsed'）没有把东西摆到她面前，
    // 不能记 `looked:`；`voice: false` 同理——没看见的字不替她记（2026-11-09 用户拍板）。
    const mark = o.mark === 'browsed' ? 'browsed' : 'looked'
    const seen = o.seen ?? (mark === 'browsed'
      ? new Set([...seenBvids(events), ...browsedBvids(events)])
      : seenBvids(events))
    const stats = { hiddenSeen: 0 }
    const list = await candidates(client, model, cfg, { seen, sources: o.sources, stats })
    if (!list.length) {
      // 2026-11-01（issue #16 第一半）：原来只会说「都是看过的或被过滤了」，
      // 把「看过」和「被过滤」混成一句 —— 前者是她自己走过的路，后者是别人的判断。
      const n = Number(stats.hiddenSeen ?? 0)
      return {
        ok: false,
        text: '',
        picks: [],
        note: n > 0 ? `翻到的 ${n} 条都看过了。想看哪条，把号给我。` : '没有可看的（平台这会儿没给）',
      }
    }

    const packs = []
    for (const v of list) {
      try {
        const p = await absorb(client, v, cfg)
        if (p.blocked) { note.push(`${v.bvid} 标签命中黑名单(${p.blocked})`); continue }
        packs.push(p)
      } catch (err) {
        note.push(`${v.bvid} 深读失败：${String(err?.message ?? err).slice(0, 60)}`)
      }
    }
    if (!packs.length) return { ok: false, text: '', picks: [], note: note.join('；') || '没有可看的' }

    // 记账，下次不再推同一条（只在真正拼进素材时才算）。`browsed:` 是自动刷自己的账：
    // 它挡住的只有别的自动刷，不挡她自己去看（见 seenBvids / browsedBvids）。
    for (const p of packs) {
      try {
        await appendEvent(
          { type: 'meta', text: `${mark}:${p.video.bvid}` },
          { day: Number(model?.day ?? 0), stage: Number(model?.stage ?? 1), source: 'system' },
          o.root,
        )
      } catch { /* 记账失败不影响这次浏览 */ }
    }

    // 评论区里别人的话：从刚读到的一堆热评里挑一条留给她（可能挑不到）。
    // 挑不到是正常的——占比要小是用户明确要求的，不是每次都非得有。
    const voice = o.voice === false ? null : await recordVoice({ packs, events, model, root: o.root, cfg })

    return {
      ok: true,
      text: renderMaterial(packs),
      voice: voice ? { text: voice.text, why: voice.why, across: voice.across ?? 1 } : null,
      picks: packs.map((p) => ({
        bvid: p.video.bvid,
        title: p.video.title,
        up: p.video.up,
        duration: p.video.duration,
        view: p.video.view,
        pic: String(p.video.pic ?? ''),
      })),
      note: note.join('；'),
      dk,
    }
  } catch (err) {
    return { ok: false, text: '', picks: [], note: String(err?.message ?? err) }
  }
}

/** 她的说明书里要加的一段（她不认识配置文件，只知道"有这么个工具"） */
export const LOOK_BRIEF = [
  '你还有一个工具 bili_look，可以去看一眼 B 站：',
  // 2026-11-09（用户 m00002）：能力地图第二层补到它自己身上——先给处境，再列 what。
  '什么时候想起它——想看点什么、或者想知道平台这会儿在把什么推到你面前的时候。',
  '  what=home    首页把什么推到你面前',
  '  what=search  搜一个词（要带 keyword）',
  '  what=related 看某个视频之后，平台又接着推什么（要带 bvid）',
  '  what=video   看指定的那一条（要带 bvid：BV 号，或者他递过来的链接）',
  '  what=replies 看你自己发过的评论下面有没有人回你（可带 bvid 只看那一条）',
  '它只读，不会留下任何痕迹，也不会让别人知道你在看。',
  '它能给你标题、简介、标签、热评、弹幕——给不了视频画面。',
  '和 growth_commit 一样，你不用它也可以。',
].join('\n')

/**
 * 关着时的「上网」那一节（P3，2026-11-07）。
 * 门不拆：整节消失会让她以为这件事根本不存在；只把门上的话换成「这会儿」。
 */
export const LOOK_OFF_BRIEF = [
  '这会儿出不去。以前翻过、看过的东西还在；等能出去的时候，你会先看到它们。',
].join('\n')

/**
 * 他丢来一条视频的时候怎么办。
 *
 * 为什么要分成两档：如果"有链接就看"写成规矩，
 * 那她就没有拒绝的余地了——而"能拒绝"正是她长出自己的前提。
 * 所以这里写的不是命令，是**分辨**：哪句是要求，哪句只是在问她。
 *
 * 措辞刻意保持"我"的口吻，跟 LOOK_BRIEF 一样是身份的一部分，
 * 不是一条给模型看的规则。
 */
export const WATCH_RULE = [
  '他有时会丢一条视频给我。两种说法，不一样：',
  '  他说"必须看""帮我看""一定要看"——那是在要求我。先看，再说话。',
  '  他说"可以看""要不要看""有没有兴趣"——那只是问我。我可以不看。',
  '不想看的时候，直接问他：为什么要看这个，这是什么。',
  '我本来就不知道该看什么。问一句不丢人。',
  '',
  '看了之后想说什么，就在那一条下面说——不用等平台把它推到我面前。',
  '没看过的不去说：不是谁递过来的手续，是我不想替自己没读的东西表态。',
].join('\n')
