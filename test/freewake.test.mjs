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

test('叫醒拼装处：世界在门内，够不着的那件事桌上有一行，常驻工具句已经撤掉', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const src = readFileSync(join(here, '..', 'lib', 'scheduler.js'), 'utf8')
  // 0.9.0（用户 m02562）：刷站不再挂在唤醒上，所有醒来都不摆世界。
  assert.match(src, /const showWorld = false/)
  const desk = src.indexOf('const desk = deskFor({')
  assert.ok(desk > 0, '桌子还在')
  // 2026-11-07（用户 m01602 拍板 B + D）：原来每次醒来都 push 的 TOOL_ASK_NOTE 撤了。
  // 它读两天就成了系统的吩咐，不是她的念头。现在两处代替它：
  //   B —— blockedTalk() 末尾补一句（lib/restrict.js），只在被拦下那一下出现；
  //   D —— 攒进劲儿里，醒的时候作为桌上一行（wishesOf + deskFor 的 wishes）。
  // 只管代码，不管注释里提到它（注释是撤销记录，留着有用）。
  assert.doesNotMatch(src, /import[^\n]*TOOL_ASK_NOTE/, '常驻工具句不该再被引进叫醒')
  assert.doesNotMatch(src, /parts\.push\([^\n]*TOOL_ASK_NOTE/, '常驻工具句不该再摆进正文')
  assert.match(src, /wishes: wishesOf\(/, '够不着的那件事要并进桌子')
})

test('「兴趣」关掉之后不再摆旧句子：否则每 6 小时还会因为旧句子空醒一次（issue #42）', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const src = readFileSync(join(here, '..', 'lib', 'scheduler.js'), 'utf8')
  // 判据必须挂在 interest.enabled 上：旧句子属于「桌上那几样东西」里的一样。
  assert.match(src, /const staleOn = config\?\.interest\?\.enabled !== false/)
  assert.match(src, /if \(staleOn && !dreamOn\(evs, model\.day\)\.length\)/)

  // 纯函数这一层也钉住：tableText 为空就不再判成 table。
  assert.equal(freeWakeFor({ tableText: '', events: [old(QUIET_DAYS + 1)], dk: '2026-11-05', now: NOW }).kind, 'think')
})

test('设置页关掉「自己找点事做」：空窗再久也不空醒，桌子照摆', () => {
  const off = { memory: { selfWake: false } }
  assert.equal(freeWakeFor({ events: [old(QUIET_DAYS + 1)], dk: '2026-11-05', now: NOW, config: off }), null)
  // 摆料优先，不受这个开关影响：桌上真有东西时这一轮照开。
  const nl = String.fromCharCode(10)
  const table = freeWakeFor({ tableText: '距你上次醒来，隔了 9 个小时。' + nl + '- 「一句旧的」', dk: '2026-11-05', now: NOW, config: off })
  assert.equal(table.kind, 'table')
  // 没写这个键就是开着（老配置不因为升级变安静）。
  assert.equal(freeWakeFor({ events: [old(QUIET_DAYS + 1)], dk: '2026-11-05', now: NOW, config: {} }).kind, 'think')
})

test('quietDays：没认领的聊天行不算她自己动过，每天有人聊也等得到兜底', () => {
  const chat = (daysAgo, flags = ['uncommitted']) => ({ type: 'utterance', text: '聊天里回的一句', flags, ts: NOW - daysAgo * DAY })
  const events = [old(QUIET_DAYS + 3), chat(1), chat(2, ['selfmod', 'uncommitted'])]
  assert.equal(Math.round(quietDays(events, NOW)), QUIET_DAYS + 3)
  assert.equal(freeWakeFor({ events, dk: '2026-11-05', now: NOW }).kind, 'think')
  // 只有聊天行、一件她自己的事都没有：还是「没有基线」，不补。
  assert.equal(quietDays([chat(1)], NOW), null)
  assert.equal(freeWakeFor({ events: [chat(1)], dk: '2026-11-05', now: NOW }), null)
})

test('quietDays：想改自己也是她自己动过，selfmod 照算', () => {
  const events = [old(QUIET_DAYS + 3), { type: 'utterance', text: '我想让他把我改得更外向一点。', flags: ['selfmod'], ts: NOW - 2 * DAY }]
  assert.equal(Math.round(quietDays(events, NOW)), 2)
  assert.equal(freeWakeFor({ events, dk: '2026-11-05', now: NOW }), null)
})
