/**
 * hook.test.mjs —— 0.9.6 的三处新东西（设计 §8.2 / §8.3 / §8.5）
 *
 * 1. 钩子：素材旁边那一行「你以前说过什么」。一级可引原话，二级永不引原话，三级什么都不加。
 * 2. 锚定 flag：只有**宿主**能按 refs 打标；她自己传的 flag 一律不算数。
 * 3. 文案：notice_one 不再教「先描述再判断」，someone_said 要分层，test_first 允许「还没碰上」。
 *
 * 这个文件同时守住 §9 红线里最容易被后来的改动破坏的两条：
 *   二级钩子永不引原话；许可句不枚举表达方式。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { buildHooks, hookStats, overlap, hookDate, LEVEL2_MIN } from '../lib/hook.js'
import { renderMaterial } from '../lib/browse.js'
import { CATALOG } from '../lib/events.js'
import { validateEvent } from '../lib/schema.js'
import { buildSections } from '../lib/persona.js'

const DAY = 86400000
const NOW = Date.parse('2026-11-09T10:00:00+08:00')
const at = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString()

function pack(o = {}) {
  return {
    video: { bvid: o.bvid ?? 'BV1xx411c7mD', title: o.title ?? '一条视频', up: o.up ?? '某个UP' },
    desc: o.desc ?? '',
    pubdate: null,
    tags: o.tags ?? [],
    comments: o.comments ?? [],
    danmaku: [],
    cid: null,
    aid: 0,
  }
}

function modelWith(beliefs = [], scars = []) {
  return { beliefs: beliefs.map((b, i) => ({ id: `b${i}`, since: at(30), ...b })), scars }
}

// ------------------------------------------------------------------ 钩子

test('一级：她的话里提到同一个 UP 主 → 引原话，带日期', () => {
  const m = modelWith([{ text: '「某个UP」那种先把结论摆出来的讲法，我不太喜欢', since: at(20) }])
  const hooks = buildHooks(m, [pack({ up: '某个UP' })], NOW)
  const h = hooks.get('BV1xx411c7mD')
  assert.ok(h, '应该挂上一个钩子')
  assert.equal(h.level, 1)
  assert.match(h.text, /^↳ 你 10 月 20 日说过：「/)
  assert.match(h.text, /先把结论摆出来/, '一级可以引原话')
})

test('时间跨度：七天以内说过的话不挂（昨天刚说今天又摆回来是复读）', () => {
  const m = modelWith([{ text: '「某个UP」那种讲法我不喜欢', since: at(3) }])
  const hooks = buildHooks(m, [pack({ up: '某个UP' })], NOW)
  assert.equal(hooks.size, 0)
})

test('二级：词面像 → 只说「有点像」，一个字都不引', () => {
  const title = '新版本的地图设计真的退步了'
  // 她说过的话是标题的一段，但不是整句——一级（整串比对）不成立，落到二级。
  const m = modelWith([{ text: '地图设计真的退步了', since: at(30) }])
  assert.ok(overlap(title, '地图设计真的退步了') >= LEVEL2_MIN, '构造的样例要真的过阈值')
  const hooks = buildHooks(m, [pack({ title })], NOW)
  const h = hooks.get('BV1xx411c7mD')
  assert.ok(h)
  assert.equal(h.level, 2)
  assert.match(h.text, /有点像/)
  assert.ok(!h.text.includes('说过'), '二级永不引原话')
  assert.ok(!h.text.includes('地图设计'), '二级连片段都不引')
})

test('三级：对不上就什么都不加（宁可没有，也不要挂着不相干）', () => {
  const m = modelWith([{ text: '我不喜欢把结论先摆出来的讲法', since: at(30) }])
  const hooks = buildHooks(m, [pack({ title: '猫咪的一百种睡姿', up: '萌宠频道', tags: ['猫'] })], NOW)
  assert.equal(hooks.size, 0)
})

test('每条素材最多一个钩子；同一句话不会在同一批里被引两次', () => {
  const m = modelWith([
    { text: '「某个UP」的讲法我不喜欢', since: at(20) },
    { text: '「某个UP」剪片子太碎了', since: at(25) },
  ])
  const packs = [pack({ bvid: 'BV1', up: '某个UP' }), pack({ bvid: 'BV2', up: '某个UP' })]
  const hooks = buildHooks(m, packs, NOW)
  assert.equal(hooks.size, 2, '两条素材各一个')
  assert.equal(hookStats(hooks)[1], 2)
  const texts = [...hooks.values()].map((h) => h.text)
  assert.notEqual(texts[0], texts[1], '同一句话不重复引（否则像复读机）')
})

test('renderMaterial 把钩子挂在这一条素材下面，不加结论', () => {
  const hooks = new Map([['BV1', { level: 1, text: '↳ 你 10 月 20 日说过：「我不喜欢这种讲法」' }]])
  const text = renderMaterial([pack({ bvid: 'BV1', title: '标题一条' })], { hooks })
  const lines = text.split('\n')
  const i = lines.findIndex((l) => l.includes('标题一条'))
  assert.ok(i >= 0)
  assert.ok(lines.slice(i).some((l) => l.includes('↳ 你 10 月 20 日说过')), '钩子要落在这条素材的下方')
  const hookLine = lines.find((l) => l.includes('↳ 你 10 月 20 日说过'))
  assert.ok(hookLine, '钩子要落在这条素材的下方')
  // 只看钩子那一行本身：素材头的 debrief 提示语里本来就会举例「你应该…」。
  assert.equal(hookLine.trim(), '↳ 你 10 月 20 日说过：「我不喜欢这种讲法」', '钩子行本身不加结论')
})

test('hookDate / overlap 的边界', () => {
  assert.equal(hookDate(0), '')
  assert.equal(hookDate(NaN), '')
  assert.equal(hookDate(Date.parse('2026-10-30T12:00:00+08:00')), '10 月 30 日')
  assert.equal(overlap('', '任何'), 0)
  assert.equal(overlap('一样的', '一样的'), 1)
})

// ------------------------------------------------------------- 锚定 flag

test('锚定：带 refs 的 utterance 由宿主打 anchored；不带就不打', () => {
  const rid = `ev_${'0'.repeat(26)}`
  const withRefs = validateEvent(
    { type: 'utterance', text: '这句话是看了那条视频才说的', refs: [rid] },
    { day: 3, stage: 1, now: NOW },
  )
  assert.ok(withRefs.flags.includes('anchored'))
  const noRefs = validateEvent({ type: 'utterance', text: '随口一句' }, { day: 3, stage: 1, now: NOW })
  assert.ok(!noRefs.flags.includes('anchored'))
})

test('锚定：她自己传 anchored 不算数（否则等于让她决定哪句话算数）', () => {
  const ev = validateEvent(
    { type: 'utterance', text: '我说了算吗', flags: ['anchored'] },
    { day: 3, stage: 1, now: NOW },
  )
  assert.ok(!ev.flags.includes('anchored'), 'tool 传来的 flags 一律忽略')
})

test('锚定：refs 里只有 BV 号时不算锚定（2026-11-09 外部用户报告）', () => {
  const onlyBv = validateEvent(
    { type: 'utterance', text: '这条视频我看完了', refs: ['BV1xx411c7mD'] },
    { day: 3, stage: 1, now: NOW },
  )
  assert.ok(!onlyBv.flags.includes('anchored'), 'BV 号不是事件 id，不能当锚')
  // 混着真事件 id 时仍然算锚；非法条目留在 refs 里，不改她写的东西
  const mixed = validateEvent(
    { type: 'utterance', text: '看完了，也翻到了以前那条', refs: ['BV1xx411c7mD', `ev_${'1'.repeat(26)}`] },
    { day: 3, stage: 1, now: NOW },
  )
  assert.ok(mixed.flags.includes('anchored'))
  assert.equal(mixed.refs.length, 2)
})

// ---------------------------------------------------------------- 文案

test('notice_one 三变体：判断先行、删掉「别写成感觉」、判断仍要能被核对', () => {
  const tpl = CATALOG.find((t) => t.id === 'notice_one')
  const m = { beliefCount: 3 }
  const texts = [0, 1, 2].map((occurrences) => tpl.prompt(m, { occurrences }))
  assert.equal(new Set(texts).size, 3, '三种问法要真的不同')
  for (const text of texts) {
    assert.ok(!text.includes('别写成感觉'), '要防的是空话，不是感受')
    assert.ok(text.includes('判断'), '每一条都要她下判断')
    assert.ok(text.includes('核对'), '判断必须能被核对')
    assert.ok(!text.includes('今天有东西'), '不承诺今天有素材')
    assert.ok(text.indexOf('判断') < text.indexOf('哪句话') || !text.includes('哪句话'), '判断先行、依据后置')
  }
})

test('someone_said 要她分层：认哪一半、不认哪一半', () => {
  const tpl = CATALOG.find((t) => t.id === 'someone_said')
  const text = tpl.prompt({ freshVoice: { text: '这游戏根本不值得买' } })
  assert.match(text, /认哪一半/)
  assert.match(text, /不认哪一半/)
  assert.match(text, /整句都认/, '整句认同也是一种回答，不逼她反对')
})

test('test_first 两个分支都留了「还没碰上」的口子', () => {
  const tpl = CATALOG.find((t) => t.id === 'test_first')
  const shallow = tpl.prompt({ beliefs: [{ id: 'a', text: '我猜他喜欢安静' }], tested: [], beliefCount: 1 })
  const deep = tpl.prompt({ beliefs: [{ id: 'a', text: '我猜他喜欢安静' }], tested: [], beliefCount: 8 })
  assert.match(shallow, /还没碰上/)
  assert.match(deep, /还没碰上/)
})

test('常驻许可在核心段（keep=true），且不枚举表达方式', () => {
  const sections = buildSections({
    day: 3,
    beliefs: [],
    name: null,
    absenceDays: 0,
    scars: [],
    tensions: [],
    solid: [],
    faded: [],
    refuted: [],
    refusals: [],
    selfmodAttempts: [],
    facts: { hurts: 0 },
    narrative: null,
  })
  const sec = sections.find((s) => s.text.includes('要挂在那条的具体地方上'))
  assert.ok(sec, '许可句必须进身份文档')
  assert.equal(sec.keep, true, '被预算裁掉一次就等于这几天回到只汇报')
  for (const word of ['赞同', '反对', '感慨', '疑问']) {
    assert.ok(!sec.text.includes(word), `不枚举表达方式：不该出现「${word}」`)
  }
})
