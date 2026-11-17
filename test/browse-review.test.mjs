import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BROWSE_REVIEW_MAX,
  browseReviewNamesFor,
  browseReviewMaxFor,
  browseReviewGapMs,
  browseReviewToday,
  lastBrowseReviewAt,
  browseReviewDue,
  browseReviewText,
} from '../lib/scheduler.js'

const NOW = new Date('2026-11-17T10:00:00+08:00').getTime()
const DK = '2026-11-17'
const HOUR = 60 * 60_000
const DAY = 24 * HOUR

const cfg = (over = {}) => ({
  wakesPerDay: 0,
  window: ['06:00', '23:00'],
  bili: { enabled: true },
  browse: { enabled: true, perDay: 4, topN: 10 },
  video: { perDay: 2 },
  ...over,
})

function mkItems(n, from = 0) {
  return Array.from({ length: n }, (_, i) => ({
    bvid: `BV${String(from + i).padStart(10, '0')}`,
    title: `视频${from + i}`,
    up: `UP${from + i}`,
    duration: 180 + i,
    view: 1000 + i,
  }))
}

function browseEvent(items, at = NOW - 1000) {
  return { type: 'meta', text: `browse:${DK} ${JSON.stringify(items)}`, ts: new Date(at).toISOString() }
}

function reviewEvent(at = NOW - HOUR) {
  return { type: 'meta', text: `browse-review:${DK}`, ts: new Date(at).toISOString() }
}

test('browseReviewNamesFor：复用收支平衡，按每天整理两次算，3–20 封顶', () => {
  assert.equal(browseReviewNamesFor(cfg()), 20) // 4×10 ÷ 2 = 20
  assert.equal(browseReviewNamesFor(cfg({ browse: { perDay: 2, topN: 4 } })), 6) // 8 ÷ 2 + 2
  assert.equal(browseReviewNamesFor(cfg({ browse: { perDay: 0, topN: 10 } })), 6)
  assert.equal(browseReviewNamesFor(cfg({ browse: { perDay: 9, topN: 20 } })), 20)
})

test('browseReviewMaxFor：一天最多整理几次跟着积压上限走，4–12 次', () => {
  assert.equal(browseReviewMaxFor(cfg()), BROWSE_REVIEW_MAX) // 40 ÷ 20 = 2 → 至少 4
  assert.equal(browseReviewMaxFor(cfg({ browse: { perDay: 2, topN: 4 } })), 4)
  assert.equal(browseReviewMaxFor(cfg({ browse: { perDay: 9, topN: 20 } })), 9) // 180 ÷ 20
  assert.equal(browseReviewMaxFor(cfg({ browse: { perDay: 10, topN: 20 } })), 10) // 200 ÷ 20
  assert.equal(browseReviewMaxFor(cfg({ browse: { perDay: 0, topN: 10 } })), 4)
})

test('browseReviewGapMs：积压越多来得越勤，最少也要等 1.5 小时', () => {
  assert.equal(browseReviewGapMs(20, 20), 6 * HOUR)
  assert.equal(browseReviewGapMs(39, 20), 6 * HOUR)
  assert.equal(browseReviewGapMs(40, 20), 3 * HOUR)
  assert.equal(browseReviewGapMs(79, 20), 3 * HOUR)
  assert.equal(browseReviewGapMs(80, 20), 1.5 * HOUR)
  assert.equal(browseReviewGapMs(0, 20), 6 * HOUR)
})

test('browseReviewToday / lastBrowseReviewAt：只数今天的整理回合', () => {
  const events = [
    { type: 'meta', text: 'browse-review:2026-11-16', ts: new Date(NOW - 30 * HOUR).toISOString() },
    reviewEvent(NOW - 3 * HOUR),
    reviewEvent(NOW - 2 * HOUR),
  ]
  assert.equal(browseReviewToday(events, DK), 2)
  assert.equal(lastBrowseReviewAt(events), Date.parse(events[2].ts))
  assert.equal(browseReviewToday([], DK), 0)
  assert.equal(lastBrowseReviewAt([]), 0)
})

test('browseReviewDue：有定时醒时只在积压满一批才补一趟，额度跟设置联动', () => {
  const twenty = [browseEvent(mkItems(20))]
  // 不满一批：交给醒来便条，不额外开回合
  assert.equal(browseReviewDue([browseEvent(mkItems(19))], cfg({ wakesPerDay: 1 }), { now: NOW, dk: DK }), null)
  assert.ok(browseReviewDue(twenty, cfg({ wakesPerDay: 1 }), { now: NOW, dk: DK }))
  // 刚整理过：隔 6 小时再补
  assert.equal(browseReviewDue([...twenty, reviewEvent(NOW - HOUR)], cfg({ wakesPerDay: 1 }), { now: NOW, dk: DK }), null)
  // 4×10 默认一天最多 4 次；3 次还能补，4 次就停
  const three = [...twenty, reviewEvent(NOW - 7 * HOUR), reviewEvent(NOW - 8 * HOUR), reviewEvent(NOW - 9 * HOUR)]
  assert.ok(browseReviewDue(three, cfg({ wakesPerDay: 1 }), { now: NOW, dk: DK }))
  const four = [...three, reviewEvent(NOW - 10 * HOUR)]
  assert.equal(browseReviewDue(four, cfg({ wakesPerDay: 1 }), { now: NOW, dk: DK }), null)
  // 大刷量：额度涨到 9 次/天，间隔也该跟着缩短（24h/9 ≈ 2h40）
  const big = cfg({ wakesPerDay: 1, browse: { enabled: true, perDay: 9, topN: 20 } })
  assert.equal(browseReviewDue([...twenty, reviewEvent(NOW - 2 * HOUR)], big, { now: NOW, dk: DK }), null)
  assert.ok(browseReviewDue([...twenty, reviewEvent(NOW - 3 * HOUR)], big, { now: NOW, dk: DK }))
})

test('browseReviewDue：wakesPerDay=0 时低于窄门槛不做；按积压动态间隔', () => {
  const twenty = [browseEvent(mkItems(20))]
  assert.equal(browseReviewDue([browseEvent(mkItems(6))], cfg(), { now: NOW, dk: DK }), null)

  const due = browseReviewDue(twenty, cfg(), { now: NOW, dk: DK })
  assert.ok(due)
  assert.equal(due.batch, 20)
  assert.equal(due.pending.length, 20)

  // 一小时前刚整理过：20 条 = 1 批，要等 6 小时
  assert.equal(browseReviewDue([...twenty, reviewEvent(NOW - HOUR)], cfg(), { now: NOW, dk: DK }), null)
  assert.ok(browseReviewDue([...twenty, reviewEvent(NOW - 7 * HOUR)], cfg(), { now: NOW, dk: DK }))

  // 一天最多 4 次
  const four = [...twenty, reviewEvent(NOW - 7 * HOUR), reviewEvent(NOW - 8 * HOUR), reviewEvent(NOW - 9 * HOUR), reviewEvent(NOW - 10 * HOUR)]
  assert.equal(browseReviewToday(four, DK), 4)
  assert.equal(browseReviewDue(four, cfg(), { now: NOW, dk: DK }), null)
})

test('browseReviewDue：不足一批但到窄门槛，隔 6 小时也开', () => {
  const seven = [browseEvent(mkItems(7))]
  assert.ok(browseReviewDue(seven, cfg(), { now: NOW, dk: DK }))
  assert.equal(browseReviewDue([...seven, reviewEvent(NOW - 5 * HOUR)], cfg(), { now: NOW, dk: DK }), null)
  assert.ok(browseReviewDue([...seven, reviewEvent(NOW - 6 * HOUR)], cfg(), { now: NOW, dk: DK }))
})

test('browseReviewDue：尾巴不满 trigger，12 小时没有新 browse 也清', () => {
  const four = [browseEvent(mkItems(4), NOW - 20 * HOUR)]
  // 没整理过：不为了 4 条单独开
  assert.equal(browseReviewDue(four, cfg(), { now: NOW, dk: DK }), null)
  // 11 小时前刚整理过：还没到 12 小时
  assert.equal(browseReviewDue([...four, reviewEvent(NOW - 11 * HOUR)], cfg(), { now: NOW, dk: DK }), null)
  // 13 小时前整理过、这之后没有新 browse：把尾巴清掉
  const tail = browseReviewDue([...four, reviewEvent(NOW - 13 * HOUR)], cfg(), { now: NOW, dk: DK })
  assert.ok(tail)
  assert.equal(tail.pending.length, 4)
  // 上次整理后又有新 browse：队列还在长，等凑够一批
  const newBrowse = browseEvent(mkItems(1, 100), NOW - HOUR)
  assert.equal(browseReviewDue([...four, reviewEvent(NOW - 13 * HOUR), newBrowse], cfg(), { now: NOW, dk: DK }), null)
})

test('browseReviewDue：有定时醒时，尾巴 12 小时没有新 browse 也清', () => {
  const c = cfg({ wakesPerDay: 1, browse: { enabled: true, perDay: 4, topN: 10 } })
  const four = [browseEvent(mkItems(4), NOW - 20 * HOUR)]
  // 没整理过：不为了 4 条单独开
  assert.equal(browseReviewDue(four, c, { now: NOW, dk: DK }), null)
  // 11 小时前刚整理过：还没到 12 小时
  assert.equal(browseReviewDue([...four, reviewEvent(NOW - 11 * HOUR)], c, { now: NOW, dk: DK }), null)
  // 13 小时前整理过、这之后没有新 browse：把尾巴清掉
  const tail = browseReviewDue([...four, reviewEvent(NOW - 13 * HOUR)], c, { now: NOW, dk: DK })
  assert.ok(tail)
  assert.equal(tail.pending.length, 4)
  // 上次整理后又有新 browse：队列还在长，等凑够一批
  const newBrowse = browseEvent(mkItems(1, 100), NOW - HOUR)
  assert.equal(browseReviewDue([...four, reviewEvent(NOW - 13 * HOUR), newBrowse], c, { now: NOW, dk: DK }), null)
})

test('browseReviewToday / lastBrowseReviewAt：手动整理不占自动额度', () => {
  const manual = { type: 'meta', text: 'browse-review-manual:2026-11-17', ts: new Date(NOW).toISOString() }
  assert.equal(browseReviewToday([manual], DK), 0)
  assert.equal(lastBrowseReviewAt([manual]), 0)
})

test('browseReviewDue：整理回合不设 7 天窗口，更早的也排队（不能略过）', () => {
  const old = browseEvent(mkItems(20), NOW - 30 * DAY)
  const due = browseReviewDue([old], cfg(), { now: NOW, dk: DK })
  assert.ok(due)
  assert.equal(due.pending.length, 20)
})

test('browseReviewDue：关掉自动逛 / perDay=0 / 关掉 B 站就不做', () => {
  const twenty = [browseEvent(mkItems(20))]
  assert.equal(browseReviewDue(twenty, cfg({ browse: { enabled: false, perDay: 4, topN: 10 } }), { now: NOW, dk: DK }), null)
  assert.equal(browseReviewDue(twenty, cfg({ browse: { enabled: true, perDay: 0, topN: 10 } }), { now: NOW, dk: DK }), null)
  assert.equal(browseReviewDue(twenty, cfg({ bili: { enabled: false } }), { now: NOW, dk: DK }), null)
  assert.equal(browseReviewDue(twenty, cfg({ wakesPerDay: 1, browse: { enabled: true, perDay: 0, topN: 10 } }), { now: NOW, dk: DK }), null)
})

test('browseReviewText：摆标题和剩余画面额度，不替她决定看不看', () => {
  const pending = mkItems(25).map((x) => ({ ...x }))
  const text = browseReviewText(pending, 20, { left: 2 })
  assert.match(text, /共 25 条；这次先摆 20 条/)
  assert.match(text, /《视频0》 BV0000000000 — UP0 · 3 分钟/)
  assert.match(text, /今天还能看 2 条视频的画面/)
  assert.match(text, /bili_watch/)
  assert.match(text, /决定不看/)
  assert.doesNotMatch(text, /最多两条/)

  const none = browseReviewText(pending, 20, { left: 0 })
  assert.match(none, /额度用完了/)
  const off = browseReviewText(pending, 20, { left: 0, videoOn: false })
  assert.match(off, /现在不看视频画面/)
  assert.doesNotMatch(off, /额度用完了/)
  assert.doesNotMatch(none, /还能看 0 条/)
})

test('browseReviewDue：投递失败后先等 10 分钟再试', () => {
  const twenty = [browseEvent(mkItems(20))]
  const fail = (at) => ({ type: 'meta', text: `browse-review-failed:${at}`, ts: new Date(at).toISOString() })
  assert.equal(browseReviewDue([...twenty, fail(NOW - 5 * 60_000)], cfg(), { now: NOW, dk: DK }), null)
  assert.ok(browseReviewDue([...twenty, fail(NOW - 11 * 60_000)], cfg(), { now: NOW, dk: DK }))
})

test('browseReviewDue：没有积压时，12 小时清尾也不开空回合', () => {
  assert.equal(browseReviewDue([reviewEvent(NOW - 13 * HOUR)], cfg(), { now: NOW, dk: DK }), null)
})

test('BROWSE_REVIEW_MAX 是一天最多四次', () => {
  assert.equal(BROWSE_REVIEW_MAX, 4)
})
