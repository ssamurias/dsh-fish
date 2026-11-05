import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { FREE_NOTE, QUIET_DAYS, THINK_EVERY_DAYS, freeWakeFor, keepWorldOnWake, quietDays } from '../lib/freewake.js'

const meta = (text) => ({ type: 'meta', text })
const DAY = 86_400_000
const NOW = Date.parse('2026-11-05T09:00:00+08:00')
// 一件「她自己动过」的旧事：兜底的窗口从它往后算。
const old = (daysAgo) => ({ type: 'meta', text: `drive-spend:2026-10-01:1`, ts: NOW - daysAgo * DAY })

test('要摆旧句子的那一次：这一轮空着，材料优先', () => {
  const r = freeWakeFor({ tableText: '这次隔了 9 个小时。\n- 「一句旧的」', model: { day: 4 }, dk: '2026-11-05' })
  assert.equal(r.kind, 'table')
  assert.equal(r.note, FREE_NOTE)
})

test('只有空白的材料不算摆料', () => {
  const r = freeWakeFor({ tableText: '   ', model: { day: 4 }, dk: '2026-11-05', config: { memory: { thinkEveryDays: 0 } } })
  assert.equal(r, null)
})

test('空窗满七天：兜底补一次空醒', () => {
  // 2026-11-05（用户 m02008）：触发从「每 3 天一次」的日历改成兜底窗口——
  // 过去 QUIET_DAYS 天她一件事都没动过，才补这一次。
  const r = freeWakeFor({ events: [old(QUIET_DAYS + 1)], dk: '2026-11-05', now: NOW })
  assert.equal(r.kind, 'think')
  assert.equal(THINK_EVERY_DAYS, 3)
  assert.equal(QUIET_DAYS, 7)
})

test('空窗不到七天：不补（劲儿该管的时候不插队）', () => {
  assert.equal(freeWakeFor({ events: [old(3)], dk: '2026-11-05', now: NOW }), null)
})

test('quietDays：认她自己的事，也认主动开口与劲儿开的回合', () => {
  const events = [
    { type: 'utterance', text: '一句', ts: NOW - 2 * DAY },
    meta('proactive-turn:2026-11-05:1'),
  ]
  events[1].ts = NOW - 5 * DAY
  assert.equal(Math.round(quietDays(events, NOW)), 2)
  assert.equal(quietDays([], NOW), null)
})

test('「停下来想一想」那一天不空：同一天不叠两件事', () => {
  assert.equal(freeWakeFor({ model: { day: 3 }, dk: '2026-11-05' }), null)
  assert.equal(freeWakeFor({ model: { day: 6 }, dk: '2026-11-05' }), null)
})

test('同一天只空一次：think:<dk> 记过就不再空', () => {
  const events = [old(QUIET_DAYS + 1), meta('think:2026-11-05')]
  events[1].ts = NOW
  assert.equal(freeWakeFor({ events, dk: '2026-11-05', now: NOW }), null)
})

test('昨天空过：那也算「她自己动过」，今天不接着空', () => {
  // 空醒本身也是一件事（她一个人待了一轮）。所以昨天记过 think，
  // 窗口就回到一天——不然「空过之后更容易再空」，会连成一片。
  const events = [old(QUIET_DAYS + 1), meta('think:2026-11-04')]
  events[1].ts = NOW - DAY
  assert.equal(freeWakeFor({ events, dk: '2026-11-05', now: NOW }), null)
})

test('把空醒关掉：thinkEveryDays 0 就只保留摆料那一种', () => {
  const config = { memory: { thinkEveryDays: 0 } }
  const events = [old(QUIET_DAYS + 1)]
  assert.equal(freeWakeFor({ events, dk: '2026-11-05', now: NOW, config }), null)
  assert.equal(freeWakeFor({ tableText: '一句旧的', events, dk: '2026-11-05', now: NOW, config })?.kind, 'table')
})

test('没有任何基线时不算空窗：新号不补', () => {
  assert.equal(freeWakeFor({ dk: '2026-11-05', now: NOW }), null)
})

test('空醒的收尾句不派活、不提梦、也不催', () => {
  assert.doesNotMatch(FREE_NOTE, /梦/)
  assert.doesNotMatch(FREE_NOTE, /应该|必须|记得|别忘了/)
  assert.match(FREE_NOTE, /这一轮是你自己的/)
  assert.match(FREE_NOTE, /也可以什么都不做/)
})

test('摆料那一轮不摆世界：只有 think 和普通叫醒才看 B 站、才摆桌子', () => {
  // 2026-11-05（用户 m01128）：table 那轮连 B 站和惦记清单都不带。
  assert.equal(keepWorldOnWake({ kind: 'table', note: FREE_NOTE }), false)
  assert.equal(keepWorldOnWake({ kind: 'think', note: FREE_NOTE }), true)
  assert.equal(keepWorldOnWake(null), true)
})

test('叫醒拼装处真的按这个判据走：世界在门内，工具常量在门外', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const src = readFileSync(join(here, '..', 'lib', 'scheduler.js'), 'utf8')
  assert.match(src, /const showWorld = keepWorldOnWake\(free\) \|\| deps\.forceBrowse === true/)
  assert.match(src, /showWorld \? await lookBeforeWake/)
  const gate = src.indexOf('if (showWorld) {')
  const desk = src.indexOf('const desk = deskFor({')
  const tool = src.indexOf("parts.push('', TOOL_ASK_NOTE)")
  // 桌子在门内，工具句在门外——工具句不是活，是她世界里的常量。
  assert.ok(gate > 0 && desk > gate, '桌子应该在 showWorld 门内')
  assert.ok(tool > desk, '工具句应该在桌子之后、仍然每次都说')
})
