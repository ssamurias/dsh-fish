import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { shownCount, buildSections, foldOlderBeliefs, BELIEF_SHOWN } from '../lib/persona.js'
import { normalizeConfig, DEFAULTS } from '../lib/settings.js'
import { renderSelfDoc } from '../lib/selfdoc.js'

// 2026-10-25：用户问「想让她记住更多能不能调」。
// 原来 BELIEF_SHOWN 写死在 persona.js，docBudget 调多大都只摆 3 条。
// 现在做成 memory.beliefsShown（1–8），selfdoc 与 /memory 报数同源。

const beliefs = Array.from({ length: 10 }, (_, i) => ({ id: `b${i}`, text: `判断编号${i}`, since: '2026-10-01', confidence: 0.6 }))

function model(extra = {}) {
  return {
    seed: '你是一条会自己长起来的鱼。',
    beliefs,
    solid: [],
    tensions: [],
    refusals: [],
    scars: [],
    selfmodAttempts: [],
    refuted: [],
    narrative: null,
    facts: { refused: 0, hurts: 0, scars: 0, scarsResolved: 0 },
    day: 3,
    growthDays: 30,
    stage: 1,
    ...extra,
  }
}

function beliefSection(text) {
  const head = text.indexOf('## 你自己说过的话')
  assert.ok(head >= 0, '必须有判断段')
  const rest = text.slice(head + 1)
  const next = rest.indexOf('\n## ')
  return next >= 0 ? rest.slice(0, next) : rest
}

test('shownCount：默认 3，夹在 1–8', () => {
  assert.equal(BELIEF_SHOWN, 3)
  assert.equal(shownCount(undefined), 3)
  assert.equal(shownCount(0), 1)
  assert.equal(shownCount(1), 1)
  assert.equal(shownCount(5), 5)
  assert.equal(shownCount(9), 8)
  assert.equal(shownCount(2.6), 3, '四舍五入')
  assert.equal(shownCount('abc'), 3, '非数字回默认')
})

test('摆几条由 opts.shown 决定：5 条就是 5 行', () => {
  const text = buildSections(model(), { shown: 5 }).map((s) => s.text).join('\n')
  const seg = beliefSection(text)
  assert.equal((seg.match(/^- 判断编号/gm) || []).length, 5)
  assert.ok(seg.includes('判断编号4'))
  assert.ok(!seg.includes('判断编号5'), '第 6 条不该逐条摆')
})

test('调成 1 条时只剩一条，其余折进「更早以前」', () => {
  const text = buildSections(model(), { shown: 1 }).map((s) => s.text).join('\n')
  const seg = beliefSection(text)
  assert.equal((seg.match(/^- 判断编号/gm) || []).length, 1)
  const old = text.slice(text.indexOf('## 更早以前'))
  assert.ok(old.includes('判断编号1'), '折行从第 2 条开始')
  assert.ok(old.includes('记不清原话了'), `折叠行要交代还有多少条：${old.slice(0, 80)}`)
})

test('foldOlderBeliefs 的起点跟着 shown 走', () => {
  const a = foldOlderBeliefs(beliefs, 3)
  assert.ok(a.includes('判断编号3') && !a.includes('判断编号2；'), 'shown=3 从第 4 条开始折')
  const b = foldOlderBeliefs(beliefs, 6)
  assert.ok(b.includes('判断编号6') && !b.includes('判断编号5；'), 'shown=6 从第 7 条开始折')
})

test('身份文档（renderSelfDoc）也认 shown', () => {
  const base = renderSelfDoc(model(), { budget: 4000 })
  assert.equal((beliefSection(base).match(/^- 判断编号/gm) || []).length, 3, '不传就是 3 条')
  const wide = renderSelfDoc(model(), { budget: 4000, shown: 6 })
  assert.equal((beliefSection(wide).match(/^- 判断编号/gm) || []).length, 6)
})

test('配置项：默认 3，越界被夹回 1–8', () => {
  assert.equal(DEFAULTS.memory.beliefsShown, 3)
  assert.equal(normalizeConfig({}).memory.beliefsShown, 3)
  assert.equal(normalizeConfig({ memory: { beliefsShown: 0 } }).memory.beliefsShown, 1)
  assert.equal(normalizeConfig({ memory: { beliefsShown: 99 } }).memory.beliefsShown, 8)
  assert.equal(normalizeConfig({ memory: { beliefsShown: '5' } }).memory.beliefsShown, 5)
})

test('客户端：设置项、buildConfig、上限表都在', () => {
  const src = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  // 2026-11-08：标签改名「眼前的判断条数」——它只决定逐条摆几条，不决定她记得住多少。
  assert.ok(src.includes("label: '眼前的判断条数'"), '设置项标签')
  assert.ok(src.includes('beliefsShown: Number(beliefsShown)'), 'buildConfig 要提交它')
  // 校验表里的名字跟控件名一致，报错时才对得上是哪一项（上下限不变）。
  assert.ok(src.includes("['眼前的判断条数', beliefsShown, 1, 8]"), '坏值校验表')
  assert.ok(src.includes('setBeliefsShown(Number(cfg.memory?.beliefsShown ?? 3))'), 'load 要读它')
})

test('观测台与身份文档同源：/memory 用 shownCount 而不是写死的常量', () => {
  const src = fs.readFileSync(new URL('../lib/observe.js', import.meta.url), 'utf8')
  assert.ok(src.includes('shownCount(config?.memory?.beliefsShown ?? BELIEF_SHOWN)'))
  assert.ok(
    src.includes('personaBudget(model, { budget, withBans: model?.persona?.imported !== true, shown: shownCap })'),
    '禁不禁用要跟身份文档同源，并且只认事件流里的导入标记（备份/恢复搬来的 config 不算）',
  )
  assert.ok(src.includes('Math.min(shownCap, model.beliefs.length)'))
})

test('白名单里额外放行的工具要念给她听（0.6.1，用户 m01371）', () => {
  const base = renderSelfDoc(model(), { budget: 4000 })
  assert.ok(!base.includes('qq_send_message'), '没放行就不提')
  const withQq = renderSelfDoc(model(), { budget: 4000, extraTools: ['qq_send_message', 'qq_get_unread_messages', 'qq_reply'] })
  assert.ok(withQq.includes('qq_send_message'))
  assert.ok(withQq.includes('qq_get_unread_messages'))
  assert.ok(withQq.includes('qq_reply'))
  assert.ok(withQq.includes('也在你手边'), '要说清这是她能用的手，不是权限事故')
})

