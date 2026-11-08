/**
 * 她看过什么 —— 把事件流里已有的记账还原成给人看的历史。
 *
 * 为什么要单独一个模块（2026-10-23 用户提）：
 * 她在会话里说「有一条是一个人跑不起来了」，用户却不知道是哪条，
 * 于是既没法接话、也没法判断她到底被什么打动了。
 * 数据本来就在（每次刷站都记了 browse:<dk>），缺的只是一个**能点开的出口**。
 * 这里不新增任何落盘，只做读取与格式化。
 *
 * 2026-10-30 改（客户反馈）：原来只读 `browse:`，于是"真的看了画面"的那几条
 * 和"只扫了眼标题"的混在一起，一律叫"看过"。现在 `watched:` 那一档单独标出来
 * （`how:'watch'`），并且排在当天最前面——它是唯一有画面的凭证。
 *
 * 2026-11-07 改（用户反馈）：0.9.0 起刷站不再挂在唤醒上，她自己去翻的记录写在
 * `look:` 里，而这个函数以前只认 `watched:` 与 `browse:`——于是 0.9.x 之后她
 * 自己点开看过的东西**一条都不进历史列表**，用户看到的永远是 9 月底那批旧记录。
 * 现在补上 `look:`（她那轮真的读过这一条，但没有画面，归到 `how:'glance'`）。
 */

import { parseBrowseLine } from './browse.js'
import { videoUrl, parseWatchedLine, parseLookLine } from './whatseen.js'

export { videoUrl }

/**
 * 按日期倒序分组的历史。
 *
 * @param {Array} events 事件流
 * @param {{days?:number, limit?:number}} opts days=取最近几天（默认 14），limit=每天最多几条（默认 200）
 * @returns {Array<{date:string, items:Array<{bvid,title,up,duration,view,url,how:'watch'|'glance'}>}>}
 */
export function historyFromEvents(events, opts = {}) {
  const days = Math.max(1, Math.min(366, Number(opts.days) || 14))
  const limit = Math.max(1, Math.min(500, Number(opts.limit) || 200))
  const groups = new Map()
  const bucketOf = (dk) => {
    if (!groups.has(dk)) groups.set(dk, [])
    return groups.get(dk)
  }

  // 先收「真的看过画面」的：它们必须排在当天最前，且不能被后面的翻到过顶掉。
  for (const e of events ?? []) {
    if (e?.type !== 'meta') continue
    const got = parseWatchedLine(e.text)
    if (!got) continue
    const bucket = bucketOf(got.dk)
    if (bucket.some((x) => x.bvid === got.bvid)) continue
    const i = got.info ?? {}
    bucket.push({
      bvid: got.bvid,
      title: String(i.title ?? '').slice(0, 120),
      up: String(i.up ?? '').slice(0, 60),
      duration: Number(i.duration) || 0,
      view: Number(i.view) || 0,
      url: videoUrl(got.bvid),
      how: 'watch',
    })
  }

  // 她自己点开看的那几条（0.9.x 起的正常来源）。没有画面，所以排在 watched 之后、
  // browse 之前，并且同样按 bvid 去重——同一条先看过画面就不再重复出现。
  for (const e of events ?? []) {
    if (e?.type !== 'meta') continue
    const got = parseLookLine(e.text)
    if (!got) continue
    const bucket = bucketOf(got.dk)
    if (bucket.some((x) => x.bvid === got.bvid)) continue
    const i = got.info ?? {}
    bucket.push({
      bvid: got.bvid,
      title: String(i.title ?? '').slice(0, 120),
      up: String(i.up ?? '').slice(0, 60),
      duration: Number(i.duration) || 0,
      view: Number(i.view) || 0,
      url: videoUrl(got.bvid),
      how: 'glance',
    })
  }

  for (const e of events ?? []) {
    if (e?.type !== 'meta') continue
    const got = parseBrowseLine(e.text)
    if (!got) continue // 坏行、别的天、别的 meta 都跳过
    const { dk, arr } = got
    const bucket = bucketOf(dk)
    const have = new Set(bucket.map((x) => x.bvid))
    for (const it of Array.isArray(arr) ? arr : []) {
      const bvid = String(it?.bvid ?? '')
      if (!bvid || have.has(bvid)) continue
      have.add(bvid)
      bucket.push({
        bvid,
        title: String(it?.title ?? '').slice(0, 120),
        up: String(it?.up ?? '').slice(0, 60),
        duration: Number(it?.duration) || 0,
        view: Number(it?.view) || 0,
        url: videoUrl(bvid),
        how: 'glance',
      })
    }
  }

  return [...groups.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .slice(0, days)
    .map(([date, items]) => ({ date, items: items.slice(0, limit) }))
}

/**
 * 她这一次看到了什么，压成几行带链接的清单，放进唤醒上下文。
 *
 * 只给标题、UP 名、链接，**不给"重点在第几分钟"**——
 * 标好重点她就只会复述，那是摘要，不是她看见的东西。
 */
export function renderWatchList(items, max = 6) {
  const list = (items ?? []).filter((x) => x?.bvid).slice(0, max)
  if (!list.length) return ''
  const lines = list.map((x, i) => {
    const t = String(x.title ?? '').slice(0, 60) || x.bvid
    const u = x.url || videoUrl(x.bvid)
    const up = x.up ? `（${x.up}）` : ''
    return `${i + 1}. ${t}${up}${u ? ` — ${u}` : ''}`
  })
  return ['## 你今天翻到过的，就是这几条', ...lines].join('\n')
}
