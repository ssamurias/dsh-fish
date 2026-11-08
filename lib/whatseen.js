/**
 * whatseen.js —— 「她今天看了什么」的唯一口径（2026-10-30，用户 m0xxxx 客户反馈）
 *
 * 问题是这么来的：报告、历史、状态窗三处都从 `browse:` 记账取数，
 * 而 `browse:` 记的是**她翻列表时读过的标题/简介/评论/弹幕**——
 * 一件跟「有没有真的看见画面」无关的事。于是她只扫了眼标题，
 * 日志里也写成「看了」。客户当场否认："我没看过，我只是点开瞄了一眼。"
 *
 * 事件流里其实一直有两种东西，只是从来没人分开读过：
 *   `watched:<日期> <bvid>`  —— 真的抽了帧、真的看过画面（唯一凭证）
 *   `browse:` / `look:`      —— 翻到过 / 点了标题，只有字，没有画面
 *
 * 所以这里只做一件事：把这两类分开，给上层的报告、历史、状态窗**同一份口径**。
 * 三层各写一份判断的后果是同一件事在三个地方各说各话——原来就是这么坏掉的。
 *
 * 关于 `hand:<日期> <bvid>`（他单独递过来的那条）：
 * 它只表示"他递了"，不表示"她看了"。所以它自己不进「看过」，
 * 只用来给已经看过的条目打一个「他递过来的」标记，以及统计"递了还没看"。
 */

import { parseBrowseLine } from './browse.js'

/** 视频的公开地址。她看的东西必须是用户能点开的。 */
export function videoUrl(bvid) {
  const b = String(bvid ?? '').trim()
  return /^BV[0-9A-Za-z]{10}$/.test(b) ? `https://www.bilibili.com/video/${b}` : ''
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * 解析一条带日期的记账行：
 *   `watched:2026-10-30 BV1xx411c7mD`
 *   `watched:2026-10-30 BV1xx411c7mD {"title":"…","up":"…","duration":183}`
 *
 * 两种形状都要认：老事件只有 BV 号（0.8.1 之前落的全是这种），
 * 新事件多带一段 JSON 展示信息。**向后兼容靠这里，不靠调用方各判断一次。**
 *
 * @returns {{dk:string, bvid:string, info:object|null}|null}
 */
function parseDated(text, prefix) {
  const t = String(text ?? '')
  if (!t.startsWith(prefix)) return null
  const rest = t.slice(prefix.length)
  const sp = rest.indexOf(' ')
  if (sp < 0) return null
  const dk = rest.slice(0, sp).trim()
  if (!DAY_RE.test(dk)) return null
  const tail = rest.slice(sp + 1).trim()
  const bvid = tail.split(/\s+/)[0] ?? ''
  if (!bvid) return null
  let info = null
  const brace = tail.indexOf('{')
  if (brace >= 0) {
    try {
      const o = JSON.parse(tail.slice(brace))
      if (o && typeof o === 'object' && !Array.isArray(o)) info = o
    } catch {
      info = null // 坏 JSON 就当没有展示信息，BV 号照样能用
    }
  }
  return { dk, bvid, info }
}

export const parseWatchedLine = (t) => parseDated(t, 'watched:')
export const parseLookLine = (t) => parseDated(t, 'look:')
export const parseHandLine = (t) => parseDated(t, 'hand:')

function num(x) {
  return Number(x) || 0
}

/**
 * 今天**真的看过画面**的条目（`watched:`）。按事件顺序，bvid 去重。
 * 老事件没有标题等展示信息时留空——上层要能优雅显示成裸 BV 号。
 */
export function watchedItems(events, dk) {
  const out = []
  const seen = new Set()
  const handed = new Set()
  for (const e of events ?? []) {
    if (e?.type !== 'meta') continue
    const h = parseHandLine(e.text)
    if (h && h.dk === dk) handed.add(h.bvid)
  }
  for (const e of events ?? []) {
    if (e?.type !== 'meta') continue
    const got = parseWatchedLine(e.text)
    if (!got || got.dk !== dk || seen.has(got.bvid)) continue
    seen.add(got.bvid)
    const i = got.info ?? {}
    out.push({
      bvid: got.bvid,
      title: String(i.title ?? '').slice(0, 120),
      up: String(i.up ?? '').slice(0, 60),
      duration: num(i.duration),
      view: num(i.view),
      url: videoUrl(got.bvid),
      handed: handed.has(got.bvid),
      how: 'watch',
    })
  }
  return out
}

/**
 * 今天翻到过、但没看画面的条目。
 *
 * 两种来源合成一份：
 *   1. `browse:` / `browse-more:` 记账（刷站时读过的标题与评论）
 *   2. `look:<日期> <bvid>`（她自己点名要点开的那条）
 * 已经在 `watched:` 里的剔除——看过的画面不该退回到"只是翻到过"。
 *
 * 展示信息优先取 `browse:` 记账（它一直有标题/UP/时长），
 * 没有就用 `look:` 行里带的 JSON，再没有就只剩 BV 号。
 */
export function glancedItems(events, dk, opts = {}) {
  // 2026-11-07（用户 m00365）：`since` 只给「醒来时那一行便条」用——
  // 它只该报**上一次醒来之后**新翻到的，不然每隔几小时醒来都同三条标题。
  const since = Number(opts.since ?? 0) || 0
  const fresh = (e) => {
    if (!since) return true
    const at = Date.parse(e?.ts ?? '') || 0
    return at >= since
  }
  const watched = new Set(watchedItems(events, dk).map((x) => x.bvid))
  const index = new Map()
  const browse = []
  for (const e of events ?? []) {
    if (e?.type !== 'meta' || !fresh(e)) continue
    const got = parseBrowseLine(e.text, dk)
    if (!got) continue
    for (const it of got.arr) {
      const b = String(it?.bvid ?? '')
      if (!b) continue
      if (!index.has(b)) index.set(b, it) // 先到先得：同一 BV 只留第一份展示信息
      if (!browse.includes(b)) browse.push(b)
    }
  }

  const handed = new Set()
  for (const e of events ?? []) {
    if (e?.type !== 'meta') continue
    const got = parseHandLine(e.text)
    if (got && got.dk === dk) handed.add(got.bvid)
  }

  const out = []
  const seen = new Set()
  const push = (bvid, extra) => {
    const b = String(bvid ?? '')
    if (!b || watched.has(b) || seen.has(b)) return
    seen.add(b)
    const it = index.get(b) ?? {}
    out.push({
      bvid: b,
      title: String(it.title ?? extra?.title ?? '').slice(0, 120),
      up: String(it.up ?? extra?.up ?? '').slice(0, 60),
      duration: num(it.duration ?? extra?.duration),
      view: num(it.view ?? extra?.view),
      url: videoUrl(b),
      handed: handed.has(b),
      how: 'glance',
    })
  }

  for (const b of browse) push(b)
  for (const e of events ?? []) {
    if (e?.type !== 'meta') continue
    // 便条只该报「上次醒来之后」新添的，她自己点开的也算——否则同一行会被每次醒来重念一遍。
    if (!fresh(e)) continue
    const got = parseLookLine(e.text)
    if (got && got.dk === dk) push(got.bvid, got.info)
  }
  return out
}

/** 他今天递过来、她一眼都没看的（`hand:` 里不在上面两档的） */
export function handedUnseen(events, dk) {
  const seen = new Set([
    ...watchedItems(events, dk).map((x) => x.bvid),
    ...glancedItems(events, dk).map((x) => x.bvid),
  ])
  const out = []
  const have = new Set()
  for (const e of events ?? []) {
    if (e?.type !== 'meta') continue
    const got = parseHandLine(e.text)
    if (!got || got.dk !== dk || seen.has(got.bvid) || have.has(got.bvid)) continue
    have.add(got.bvid)
    out.push({ bvid: got.bvid, url: videoUrl(got.bvid) })
  }
  return out
}

/**
 * 醒来便条「已经提过谁」（2026-11-08，用户 m00187 第 4 条）。
 *
 * 问题：连醒三次，三次都念同一条视频。安静刷每隔一阵就把同一个列表再记一遍
 * `browse:`，于是「上次醒来之后新翻到的」永远包含那几条老标题——只按时间过滤拦不住。
 *
 * 做法：那一行真念出去的 BV 号记一笔 `digest:<日期> BV… BV…`，下一行跳过它们。
 * 不删不改任何账，只是「上次说过了，这次不说了」。窗口 7 天：一周后同一个视频
 * 再被刷到，还能重新提一次（不然她那个列表就永远只剩新冒出来的几条）。
 */
export const DIGEST_PREFIX = 'digest:'
export const DIGEST_REMEMBER_DAYS = 7

const DAY_MS = 86_400_000

/** `digest:2026-11-08 BV1xx411c7mD BV1yy…` → `{dk, ids}`；不是这一行返回 null。 */
export function parseDigestLine(text) {
  const t = String(text ?? '')
  if (!t.startsWith(DIGEST_PREFIX)) return null
  const rest = t.slice(DIGEST_PREFIX.length)
  const sp = rest.indexOf(' ')
  const dk = (sp < 0 ? rest : rest.slice(0, sp)).trim()
  if (!DAY_RE.test(dk)) return null
  const ids = (sp < 0 ? [] : rest.slice(sp + 1).trim().split(/\s+/)).filter((b) => /^BV[0-9A-Za-z]{10}$/.test(b))
  if (!ids.length) return null
  return { dk, ids }
}

/** 最近 `days` 天里，便条提过哪些 BV 号。 */
export function digestMentioned(events = [], { now = Date.now(), days = DIGEST_REMEMBER_DAYS } = {}) {
  const out = new Set()
  const floor = now - Math.max(0, Number(days) || 0) * DAY_MS
  for (const e of events ?? []) {
    if (e?.type !== 'meta') continue
    const got = parseDigestLine(e.text)
    if (!got) continue
    const at = Date.parse(e?.ts ?? '') || 0
    if (at < floor) continue
    for (const b of got.ids) out.add(b)
  }
  return out
}

/**
 * 一天的全部口径，一次取齐。上层（报告 / 状态窗 / 历史）都用这个，不再各拼一次。
 * @returns {{watched:object[], glanced:object[], handed:object[]}}
 */
export function seenOn(events, dk) {
  return {
    watched: watchedItems(events, dk),
    glanced: glancedItems(events, dk),
    handed: handedUnseen(events, dk),
  }
}
