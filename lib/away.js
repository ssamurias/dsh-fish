/**
 * 「你不在的时候」：把空档期她做了什么，摊在你回来第一眼能看到的地方。
 *
 * 为什么不是通知：她没有时效性——一条视频你今天不看，明天看也一样。
 * 所以不往外推，只在你回到 DSH 时告诉你错过了什么。
 *
 * 口径（全部只读，不改事件流、不写任何东西）：
 *   - 起点 = 你最后一次开口的时间（`meta seen:<ISO>`）；从没开过口就从第一条事件算。
 *   - 醒了 N 次（`meta wake:`）、看了 M 条（`browse:` 记账里的 BV 去重）、
 *     说了 K 句话（`utterance`，不含没认领的聊天行）、写了 J 篇日记（`meta diary:`）。
 *   - 日记只报**篇数**，永不报内容——看不看得到是 `diary.visible` 那件事。
 */
import { readEvents } from './store.js'
import { parseBrowseLine } from './browse.js'
import { parseWatchedLine } from './whatseen.js'

function tsOf(e) {
  const raw = e?.ts
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  const t = Date.parse(String(raw ?? ''))
  return Number.isFinite(t) ? t : 0
}

/**
 * 你最后一次露面的时间（毫秒）。从没露面返回 0。
 *
 * 口径与 `absence.js` 的 `lastSeenAt` 必须一致（两处算的是同一件事，分别给
 * 观测台的「你不在的时候」和冷落检测用）：`meta seen:` 为主，`heard` 兜底。
 * 2026-11-02（用户 m01280）之前这里只认 seen:，和 absence 一起漏掉了侧栏聊天。
 */
export function lastSeenMs(events) {
  let best = 0
  for (const e of events ?? []) {
    if (e?.type === 'heard') {
      const v = tsOf(e)
      if (v && v > best) best = v
      continue
    }
    if (e?.type !== 'meta') continue
    const t = String(e.text ?? '')
    if (!t.startsWith('seen:')) continue
    const v = Date.parse(t.slice(5).trim())
    if (Number.isFinite(v) && v > best) best = v
  }
  return best
}

/** 起点：最后一次露面；没有就用最早一条事件的时间。都没有返回 0。 */
export function awaySince(events) {
  const seen = lastSeenMs(events)
  if (seen) return seen
  let first = 0
  for (const e of events ?? []) {
    const t = tsOf(e)
    if (t && (!first || t < first)) first = t
  }
  return first
}

/**
 * @returns {{since:number,days:number,wakes:number,videos:number,watched:number,said:number,diaries:number,quiet:boolean}}
 */
export function summarizeAway(events, { now = Date.now(), maxDays = 60 } = {}) {
  const since = awaySince(events)
  const zero = { since, days: 0, wakes: 0, videos: 0, watched: 0, said: 0, diaries: 0, quiet: true }
  if (!since) return zero

  const floor = Math.max(since, now - maxDays * 86400_000)
  const days = Math.max(0, Math.floor((now - since) / 86400_000))
  let wakes = 0
  let said = 0
  let diaries = 0
  const bvids = new Set()
  // 2026-10-30：videos 数的是 `browse:` 记账（翻到过，没有画面）；
  // 真要回答"她不在的时候看了几条片子"，得数 `watched:`。两个都留着，界面各说各的。
  const watchedBvids = new Set()

  for (const e of events ?? []) {
    const t = tsOf(e)
    if (t && t < floor) continue
    const type = String(e?.type ?? '')
    // uncommitted 是上次聊天的回复：seen: 在第一句人话时写，它要等回合结束，
    // 所以必然落在「不在」窗口里，不算他不在时她说的。
    if (type === 'utterance') {
      if (!(Array.isArray(e.flags) && e.flags.includes('uncommitted'))) said++
      continue
    }
    if (type === 'diary') { diaries++; continue }
    if (type === 'meta') {
      const txt = String(e.text ?? '')
      if (txt.startsWith('wake:')) { wakes++; continue }
      if (txt.startsWith('diary:')) { diaries++; continue }
      const seenLine = parseWatchedLine(txt)
      if (seenLine) { if (seenLine.bvid) watchedBvids.add(seenLine.bvid); continue }
      // 记账分片：browse: 是第一片，browse-more: 是后续，两片都要算
      const got = parseBrowseLine(txt)
      if (got) {
        for (const it of got.arr) {
          const b = String(it?.bvid ?? '')
          if (b) bvids.add(b)
        }
      }
    }
  }

  return {
    since,
    days,
    wakes,
    videos: bvids.size,
    watched: watchedBvids.size,
    said,
    diaries,
    quiet: wakes === 0 && said === 0 && bvids.size === 0 && watchedBvids.size === 0 && diaries === 0,
  }
}

/** 直接给观测台用：读事件流再汇总，永不抛。 */
export async function readAway(root, opts = {}) {
  try {
    const { events } = await readEvents(root)
    return summarizeAway(events, opts)
  } catch {
    return { since: 0, days: 0, wakes: 0, videos: 0, said: 0, diaries: 0, quiet: true }
  }
}
