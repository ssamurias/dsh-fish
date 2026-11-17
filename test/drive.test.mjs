import test from 'node:test'
import assert from 'node:assert/strict'

import { DRIVE, deskHasMaterial, driveCost, driveOf } from '../lib/drive.js'

const HOUR = 3_600_000
const NOW = Date.parse('2026-11-05T09:00:00+08:00')
const spend = (hoursAgo) => ({ type: 'meta', text: 'drive-spend:2026-11-05:1', ts: NOW - hoursAgo * HOUR })

test('一件记录都没有：不急着动', () => {
  const r = driveOf({ events: [], now: NOW })
  assert.equal(r.value, 0)
  assert.equal(r.ready, false)
  assert.match(r.why, /还没有任何记录/)
  assert.equal(r.threshold, DRIVE.threshold)
})

test('从来没主动过：从出生那一刻算起，不是永远停在 0.00', () => {
  const born13 = driveOf({ events: [{ type: 'seed', text: '', ts: NOW - 13 * HOUR }], now: NOW })
  assert.equal(born13.ready, true)
  assert.ok(Math.abs(born13.value - 1) < 1e-9)

  const born5 = driveOf({ events: [{ type: 'seed', text: '', ts: NOW - 5 * HOUR }], now: NOW })
  assert.equal(born5.ready, false)
  assert.ok(Math.abs(born5.value - 5 * DRIVE.growthPerHour) < 1e-9)
  assert.match(born5.why, /还没攒够/)
})

test('刚出生就动过：出生锚点让位给最近那次行动', () => {
  const r = driveOf({ events: [{ type: 'seed', ts: NOW - 11 * 24 * HOUR }, spend(0.5)], now: NOW })
  assert.equal(r.ready, false)
  assert.match(r.why, /两小时/)
})

test('出生很久、一直没机会：攒到顶也是 1.00，不超过阈值语义', () => {
  const r = driveOf({ events: [{ type: 'seed', ts: NOW - 11 * 24 * HOUR }], now: NOW })
  assert.equal(r.value, 1)
  assert.equal(r.ready, true)
})

test('刚动过：两小时之内一律不动', () => {
  const r = driveOf({ events: [spend(0.5)], now: NOW })
  assert.equal(r.ready, false)
  assert.match(r.why, /两小时/)
})

test('底噪按小时线性长：5 小时还没到，10 小时到了', () => {
  const five = driveOf({ events: [spend(5)], now: NOW })
  assert.equal(five.ready, false)
  assert.ok(Math.abs(five.value - 5 * DRIVE.growthPerHour) < 1e-9)
  const ten = driveOf({ events: [spend(10)], now: NOW })
  assert.equal(ten.ready, true)
  assert.ok(Math.abs(ten.value - 10 * DRIVE.growthPerHour) < 1e-9)
  assert.equal(ten.why, '')
})

test('桌上有东西：冲动把「该醒」提前（但封顶 0.4）', () => {
  const plain = driveOf({ events: [spend(5)], now: NOW })
  const withDesk = driveOf({ events: [spend(5)], now: NOW, desk: { gaps: 2, stale: 3, echo: true } })
  assert.equal(plain.ready, false)
  assert.equal(withDesk.ready, true)
  assert.equal(withDesk.boosts, DRIVE.boostCap)
  // 没有回音时只有两笔小的
  const half = driveOf({ events: [spend(5)], now: NOW, desk: { gaps: 1, stale: 0 } })
  assert.ok(Math.abs(half.boosts - DRIVE.boostGap) < 1e-9)
})

test('兴趣回灌：手上有惦记的事，也算一笔冲动', () => {
  const base = driveOf({ events: [spend(4.5)], now: NOW })
  const fav = driveOf({ events: [spend(4.5)], now: NOW, desk: { favorite: true } })
  assert.equal(fav.boosts, DRIVE.boostInterest)
  assert.ok(fav.value > base.value)
})

test('上次开口没人接：底噪打折', () => {
  const events = [
    { type: 'meta', text: 'proactive-turn:2026-11-05:1', ts: NOW - 5 * HOUR },
    spend(5),
  ]
  const r = driveOf({ events, now: NOW })
  assert.equal(r.damp, DRIVE.dampUnanswered)
  assert.ok(r.value < 5 * DRIVE.growthPerHour)
})

test('上次开口有人接了：不打折', () => {
  const events = [
    { type: 'meta', text: 'proactive-turn:2026-11-05:1', ts: NOW - 5 * HOUR },
    { type: 'heard', text: '嗯', ts: NOW - 4 * HOUR },
    spend(5),
  ]
  const r = driveOf({ events, now: NOW })
  assert.equal(r.damp, 1)
})

test('活得越久，攒得越快一点：成长档位抬高底噪速度', () => {
  const one = driveOf({ events: [spend(3)], now: NOW, stage: 1 })
  const four = driveOf({ events: [spend(3)], now: NOW, stage: 4 })
  assert.ok(four.value > one.value)
  assert.ok(Math.abs(four.speed - DRIVE.growthPerHour * (1 + 0.06 * 3)) < 1e-9)
  // 封顶在阈值之内：四档也不会几小时就顶穿
  assert.equal(driveOf({ events: [spend(3)], now: NOW, stage: 4 }).ready, false)
})

test('劲儿只算不花：动一次的钱是给记账用的常数', () => {
  assert.equal(driveCost(), DRIVE.cost)
  // 本函数没有副作用：同一个输入算两次结果一样
  const events = [spend(9)]
  assert.deepEqual(driveOf({ events, now: NOW }), driveOf({ events, now: NOW }))
})

test('空桌不醒：桌上一件材料都没有时，劲儿再满也不算有话说', () => {
  assert.equal(deskHasMaterial({ gaps: 0, stale: 0, echo: false, favorite: false }), false)
  assert.equal(deskHasMaterial(null), false)
  assert.equal(deskHasMaterial({ gaps: 1, stale: 0, echo: false, favorite: false }), true)
  assert.equal(deskHasMaterial({ gaps: 0, stale: 2, echo: false, favorite: false }), true)
  assert.equal(deskHasMaterial({ gaps: 0, stale: 0, echo: true, favorite: false }), true)
  assert.equal(deskHasMaterial({ gaps: 0, stale: 0, echo: false, favorite: true }), true)
})
