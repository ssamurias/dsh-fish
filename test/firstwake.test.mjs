import test from 'node:test'
import assert from 'node:assert/strict'
import { FIRST_WAKE_GAP_HOURS, FIRST_WAKE_HOUR, firstWakeOfDay } from '../lib/firstwake.js'

const at = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime()
const iso = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi).toISOString()
const wake = (y, mo, d, h, mi = 0) => ({ type: 'meta', text: `wake:2026-11-14 test_first`, ts: iso(y, mo, d, h, mi) })

test('过夜后的第一次醒来：隔了 10 小时，算', () => {
  const now = at(2026, 11, 14, 9)
  assert.equal(firstWakeOfDay([wake(2026, 11, 13, 23)], now), true)
})

test('凌晨 0:30 醒过一次，9:00 仍是当天第一次「早上醒来」', () => {
  const now = at(2026, 11, 14, 9)
  const events = [wake(2026, 11, 13, 23), wake(2026, 11, 14, 0, 30)]
  assert.equal(firstWakeOfDay(events, now), true)
})

test('凌晨 4 点前不算醒来', () => {
  assert.equal(firstWakeOfDay([wake(2026, 11, 13, 23)], at(2026, 11, 14, 3, 30)), false)
})

test('当天 4 点后已经醒过一次，就不再说「你刚醒」', () => {
  const now = at(2026, 11, 14, 9)
  assert.equal(firstWakeOfDay([wake(2026, 11, 13, 23), wake(2026, 11, 14, 5)], now), false)
})

test('两个小时前他还在说话，这次不算睡醒', () => {
  const now = at(2026, 11, 14, 9)
  const events = [
    wake(2026, 11, 13, 23),
    { type: 'utterance', text: '一句判断', ts: iso(2026, 11, 14, 7, 30) },
  ]
  assert.equal(firstWakeOfDay(events, now), false)
})

test('sleep: 是夜间 think 的槽位，不是「睡过一觉」', () => {
  const now = at(2026, 11, 14, 9)
  const events = [
    wake(2026, 11, 13, 23),
    { type: 'meta', text: 'sleep:2026-11-14', ts: iso(2026, 11, 14, 3) },
  ]
  assert.equal(firstWakeOfDay(events, now), true)
  // 也不因为它而把 gap 算短
  const late = [
    { type: 'utterance', text: '一句判断', ts: iso(2026, 11, 14, 7) },
  ]
  assert.equal(firstWakeOfDay(late, now), false)
})

test('没有基线时不猜', () => {
  assert.equal(firstWakeOfDay([], at(2026, 11, 14, 9)), false)
  assert.equal(firstWakeOfDay([{ type: 'seed', text: '种子', ts: iso(2026, 10, 1, 9) }], at(2026, 11, 14, 9)), true)
})

test('间隔门槛就是常量本身', () => {
  const now = at(2026, 11, 14, 9)
  const just = now - FIRST_WAKE_GAP_HOURS * 3_600_000
  assert.equal(firstWakeOfDay([{ type: 'utterance', text: 'x', ts: new Date(just).toISOString() }], now), true)
  assert.equal(firstWakeOfDay([{ type: 'utterance', text: 'x', ts: new Date(just + 60_000).toISOString() }], now), false)
  assert.equal(FIRST_WAKE_HOUR, 4)
})
