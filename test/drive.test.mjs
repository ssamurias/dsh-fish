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
  const born8 = driveOf({ events: [{ type: 'seed', text: '', ts: NOW - 8 * HOUR }], now: NOW })
  assert.equal(born8.ready, true)
  assert.ok(Math.abs(born8.value - 0.96) < 1e-9)

  const born2 = driveOf({ events: [{ type: 'seed', text: '', ts: NOW - 2 * HOUR }], now: NOW })
  assert.equal(born2.ready, false)
  assert.ok(Math.abs(born2.value - 0.24) < 1e-9)
  assert.match(born2.why, /还没攒够/)
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

test('底噪按小时线性长：3 小时还没到，7 小时到了', () => {
  const three = driveOf({ events: [spend(3)], now: NOW })
  assert.equal(three.ready, false)
  assert.ok(Math.abs(three.value - 0.36) < 1e-9)
  const seven = driveOf({ events: [spend(7)], now: NOW })
  assert.equal(seven.ready, true)
  assert.ok(Math.abs(seven.value - 0.84) < 1e-9)
  assert.equal(seven.why, '')
})

test('桌上有东西：冲动把「该醒」提前（但封顶 0.3）', () => {
  const plain = driveOf({ events: [spend(4.5)], now: NOW })
  const withDesk = driveOf({ events: [spend(4.5)], now: NOW, desk: { gaps: 2, stale: 3, echo: true } })
  assert.equal(plain.ready, false)
  assert.equal(withDesk.ready, true)
  assert.equal(withDesk.boosts, DRIVE.boostCap)
  // 没有回音时只有两笔小的
  const half = driveOf({ events: [spend(4.5)], now: NOW, desk: { gaps: 1, stale: 0 } })
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
  assert.ok(Math.abs(four.speed - 0.12 * (1 + 0.06 * 3)) < 1e-9)
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
