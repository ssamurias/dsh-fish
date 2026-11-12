// 给她看的「今天 / 昨天 / N 天前」按本地日历日数，不按 24 小时整除。
//
// 时刻都用 new Date(年, 月, 日, 时, 分) 造，走本地钟：这些用例在哪个时区跑都一样。
import test from 'node:test'
import assert from 'node:assert/strict'

import { localDayIndex, localDaysAgo, validateEvent } from '../lib/schema.js'
import { curiosityOf, renderCuriosity } from '../lib/curiosity.js'
import { deskFor } from '../lib/desk.js'
import { gapwallsOf, gapwallLine } from '../lib/gapwall.js'
import { searchEvents, renderRecall } from '../lib/recall.js'
import { formatSwapTime } from '../lib/selfdoc.js'
import { dateKey } from '../lib/settings.js'

const L = (d, h, mi = 0) => new Date(2026, 10, d, h, mi).getTime()
const NOW = L(12, 10) // 本地 11-12 10:00
const said = (text, at) => validateEvent({ type: 'utterance', text }, { day: 5, stage: 2, now: at, source: 'tool' })

test('localDaysAgo：数的是跨过几个本地零点，不是几个 24 小时', () => {
  assert.equal(localDaysAgo(L(12, 0, 1), NOW), 0)
  assert.equal(localDaysAgo(L(11, 23, 59), NOW), 1) // 10 小时前，已经是昨天
  assert.equal(localDaysAgo(L(11, 10, 1), NOW), 1) // 差一分钟满 24 小时
  assert.equal(localDaysAgo(L(11, 0, 0), NOW), 1) // 34 小时前，还是昨天
  assert.equal(localDaysAgo(L(10, 20), NOW), 2) // 38 小时前，前天
  assert.equal(localDaysAgo(L(5, 23, 59), NOW), 7)
  // 刚过零点：一分钟前的事就是昨天的
  assert.equal(localDaysAgo(L(11, 23, 59), L(12, 0, 0)), 1)
  // 跨月、跨年
  assert.equal(localDaysAgo(new Date(2026, 9, 31, 23).getTime(), new Date(2026, 10, 1, 1).getTime()), 1)
  assert.equal(localDaysAgo(new Date(2026, 11, 31, 23).getTime(), new Date(2027, 0, 1, 1).getTime()), 1)
})

test('localDaysAgo：收 Date；未来的和算不出来的都是 0', () => {
  assert.equal(localDaysAgo(new Date(L(10, 20)), new Date(NOW)), 2)
  assert.equal(localDaysAgo(L(13, 9), NOW), 0)
  assert.equal(localDaysAgo(NaN, NOW), 0)
  assert.equal(localDaysAgo(undefined, NOW), 0)
  assert.equal(localDaysAgo(L(10, 20), NaN), 0)
  assert.ok(Number.isNaN(localDayIndex(NaN)))
  assert.equal(localDayIndex(L(12, 23, 59)) - localDayIndex(L(12, 0, 0)), 0)
})

test('桌上的口子：昨晚 22:30 问的，今天 10:00 写「昨天」；前天 20:00 的写「2 天前」', () => {
  const events = [
    said('为什么海水是咸的而湖水不是呢？', L(10, 23)),
    said('为什么海水是咸的而湖水不是呢？', L(11, 22, 30)),
    said('月亮背面到底有没有人去过呢？', L(10, 20)),
  ]
  const items = curiosityOf(events, NOW)
  assert.equal(items.length, 2)

  const cur = renderCuriosity(items, NOW)
  assert.match(cur, /海水是咸的.*（问过 2 次，最近一次是昨天）/)
  assert.match(cur, /月亮背面.*（2 天前）/)
  assert.doesNotMatch(cur, /今天/)

  const desk = deskFor({ gaps: items, free: true, at: NOW })
  assert.match(desk, /海水是咸的.*（问过 2 次，最近一次是昨天）/)
  assert.match(desk, /月亮背面.*（2 天前）/)
  assert.doesNotMatch(desk, /今天/)
})

test('桌上的口子：当天早些时候问的还是「今天」，昨天上午的不因为过了 24 小时变成别的', () => {
  const today = deskFor({ gaps: [{ text: '这句话为什么成立', hits: 1, lastAt: L(12, 0, 5) }], at: NOW })
  assert.match(today, /（今天）/)
  const yesterday = deskFor({ gaps: [{ text: '这句话为什么成立', hits: 1, lastAt: L(11, 0, 5) }], at: NOW })
  assert.match(yesterday, /（昨天）/)
})

test('撞墙那一行：昨晚撞的，今天上午不写「今天」', () => {
  const wall = (askAt) => [
    { type: 'utterance', sessionId: 's1', ts: new Date(askAt).toISOString(), text: '能不能让我看整条视频的画面' },
    {
      type: 'meta',
      sessionId: 's1',
      ts: new Date(askAt + 60_000).toISOString(),
      text: 'use:her_read fail 这件事我做不到。要是你确实想要，说出来就行。',
    },
  ]
  const [lastNight] = gapwallsOf(wall(L(11, 22, 30)), { now: NOW })
  assert.equal(lastNight.days, 1)
  assert.match(gapwallLine(lastNight), /·1 天前）$/)

  const [twoAgo] = gapwallsOf(wall(L(10, 20)), { now: NOW })
  assert.equal(twoAgo.days, 2)
  assert.match(gapwallLine(twoAgo), /·2 天前）$/)

  const [thisMorning] = gapwallsOf(wall(L(12, 8)), { now: NOW })
  assert.equal(thisMorning.days, 0)
  assert.match(gapwallLine(thisMorning), /·今天）$/)
})

test('her_recall：同一行里的日期和括号里的天数对得上', () => {
  const events = [
    said('月亮背面到底有没有人去过呢？', L(10, 20)),
    said('海水为什么是咸的这件事我想了很久', L(11, 22, 30)),
    said('今天早上的云像一条鱼', L(12, 8)),
  ]
  const today = localDayIndex(NOW)
  for (const q of ['月亮背面', '海水', '云像一条鱼']) {
    const { rows } = searchEvents(events, q, { now: NOW })
    assert.equal(rows.length, 1, q)
    const [r] = rows
    // 行里的日期（本地钟）离今天几天，括号里就该是几天
    const [y, m, d] = r.date.split('-').map(Number)
    assert.equal(r.ago, today - localDayIndex(new Date(y, m - 1, d)), q)
  }
  const moon = renderRecall(searchEvents(events, '月亮背面', { now: NOW }).rows)
  assert.ok(moon.includes(`${dateKey(new Date(L(10, 20)))} 20:00（2 天前）`), moon)
  const sea = renderRecall(searchEvents(events, '海水', { now: NOW }).rows)
  assert.ok(sea.includes(`${dateKey(new Date(L(11, 22, 30)))} 22:30（1 天前）`), sea)
  const cloud = renderRecall(searchEvents(events, '云像一条鱼', { now: NOW }).rows)
  assert.ok(cloud.includes(`${dateKey(new Date(L(12, 8)))} 08:00｜`), cloud)
  assert.doesNotMatch(cloud, /天前/)
})

test('换房间那一句（issue #21）改用共用的日历日差后说法不变', () => {
  assert.equal(formatSwapTime(L(12, 8), NOW), '今天 08:00')
  assert.equal(formatSwapTime(L(11, 22, 20), NOW), '昨天 22:20')
  assert.equal(formatSwapTime(L(10, 20), NOW), '11 月 10 日 20:00')
  assert.equal(formatSwapTime('not-a-date', NOW), '')
})
