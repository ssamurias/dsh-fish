import test from 'node:test'
import assert from 'node:assert/strict'

import { FREE_NOTE, THINK_EVERY_DAYS, freeWakeFor } from '../lib/freewake.js'

const meta = (text) => ({ type: 'meta', text })

test('要摆旧句子的那一次：这一轮空着，材料优先', () => {
  const r = freeWakeFor({ tableText: '这次隔了 9 个小时。\n- 「一句旧的」', model: { day: 4 }, dk: '2026-11-05' })
  assert.equal(r.kind, 'table')
  assert.equal(r.note, FREE_NOTE)
})

test('只有空白的材料不算摆料', () => {
  const r = freeWakeFor({ tableText: '   ', model: { day: 4 }, dk: '2026-11-05', config: { memory: { thinkEveryDays: 0 } } })
  assert.equal(r, null)
})

test('到日子的那一次空醒：没有材料也空着', () => {
  // 默认每 3 天一次，占 day % 3 === 2（「停下来想一想」占 0，错开）
  const r = freeWakeFor({ model: { day: 2 }, dk: '2026-11-05' })
  assert.equal(r.kind, 'think')
  assert.equal(THINK_EVERY_DAYS, 3)
})

test('「停下来想一想」那一天不空：同一天不叠两件事', () => {
  assert.equal(freeWakeFor({ model: { day: 3 }, dk: '2026-11-05' }), null)
  assert.equal(freeWakeFor({ model: { day: 6 }, dk: '2026-11-05' }), null)
})

test('同一天只空一次：think:<dk> 记过就不再空', () => {
  const events = [meta('think:2026-11-05')]
  assert.equal(freeWakeFor({ model: { day: 5 }, events, dk: '2026-11-05' }), null)
  // 换一天又到了日子，照常空
  assert.equal(freeWakeFor({ model: { day: 5 }, events, dk: '2026-11-06' })?.kind, 'think')
})

test('别的日子记的账不算今天', () => {
  const events = [meta('think:2026-11-04')]
  assert.equal(freeWakeFor({ model: { day: 5 }, events, dk: '2026-11-05' })?.kind, 'think')
})

test('把空醒关掉：thinkEveryDays 0 就只保留摆料那一种', () => {
  const config = { memory: { thinkEveryDays: 0 } }
  assert.equal(freeWakeFor({ model: { day: 2 }, dk: '2026-11-05', config }), null)
  assert.equal(freeWakeFor({ tableText: '一句旧的', model: { day: 2 }, dk: '2026-11-05', config })?.kind, 'table')
})

test('第一天不空：刚来的那天没有「自己的打算」可言', () => {
  assert.equal(freeWakeFor({ model: { day: 1 }, dk: '2026-11-05', config: { memory: { thinkEveryDays: 3 } } }), null)
})

test('空醒的收尾句不派活、不提梦、也不催', () => {
  assert.doesNotMatch(FREE_NOTE, /梦/)
  assert.doesNotMatch(FREE_NOTE, /应该|必须|记得|别忘了/)
  assert.match(FREE_NOTE, /这一轮是你自己的/)
  assert.match(FREE_NOTE, /也可以什么都不做/)
})
