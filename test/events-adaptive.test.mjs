import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CATALOG, findTemplate, scaledDay, scaledAge, scaledGap } from '../lib/events.js'
import { pick } from '../lib/generator.js'
import { gateNeed, deriveSelf, stageBounds, DAY_MS } from '../lib/derive.js'
import { normalizeConfig } from '../lib/settings.js'

// 2026-11-08 成长周期自适应。
// 守三件事：
//   1. 30 天是基准：所有 helper 在 growthDays=30 时与原值逐一相等。
//   2. 7 / 14 天不是把 30 天等比压扁就完事——长内容（约定、三集弧）要主动让路，
//      门也要降到一次证据，否则她会被锁在 stage 1。
//   3. 卡只读模型/上下文，不读配置里的周期；周期只改「什么时候能出」。

function model(over = {}) {
  return {
    seed: '你不是助手。你刚开始存在。',
    day: 10, growthDays: 30, stage: 2, stageName: '自主', name: null,
    beliefs: [], beliefCount: 0, refuted: [], refusals: [], selfmodAttempts: [],
    reunions: [], corrected: 0, tested: [],
    needs: { autonomy: 0, competence: 0, relatedness: 0 },
    facts: { refused: 0, revises: 0, corrected: 0 },
    stageGate: { passed: [], pending: null, forced: [], gateStage: 4 },
    absenceDays: 0, narrative: null, ...over,
  }
}
const today = (o = {}) => ({ dateKey: '2026-11-08', sent: 0, questions: 0, proactive: 0, ...o })
const at = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString()

function ev(id, type, day, text, extra = {}) {
  const t0 = Date.parse('2026-10-01T00:00:00Z')
  return {
    id, ts: new Date(t0 + (day - 1) * DAY_MS).toISOString(), day, stage: 1,
    type, source: 'tool', text, refs: [], verdict: null, confidence: 0.6, flags: [], ...extra,
  }
}

test('周期缩放：30 天时与原值逐一相等', () => {
  const m30 = model({ growthDays: 30 })
  assert.equal(scaledDay(m30, 8), 8)
  assert.equal(scaledDay(m30, 16), 16)
  assert.equal(scaledDay(m30, 26), 26)
  assert.equal(scaledDay(m30, 6), 6)
  assert.equal(scaledDay(m30, 5), 5)
  assert.equal(scaledDay(m30, 4), 4)
  assert.equal(scaledAge(m30, 14), 14)
  assert.equal(scaledGap(m30, 3), 3)
  assert.equal(scaledGap(m30, 7), 7)
})

test('周期缩放：7 / 14 / 60 天按比例，长内容有下限', () => {
  const m7 = model({ growthDays: 7 })
  assert.equal(scaledDay(m7, 8), 2)
  assert.equal(scaledDay(m7, 16), 4)
  assert.equal(scaledDay(m7, 26), 6)
  assert.equal(scaledDay(m7, 4), 1)
  assert.equal(scaledAge(m7, 14), 3, '判断至少得有三天的年龄，才谈得上「以前」')
  assert.equal(scaledGap(m7, 3), 1)

  const m14 = model({ growthDays: 14 })
  assert.equal(scaledDay(m14, 8), 4)
  assert.equal(scaledDay(m14, 6), 3)
  assert.equal(scaledDay(m14, 5), 2)
  assert.equal(scaledGap(m14, 3), 1)

  const m60 = model({ growthDays: 60 })
  assert.equal(scaledDay(m60, 8), 16)
  assert.equal(scaledDay(m60, 16), 32)
  assert.equal(scaledDay(m60, 26), 52)
  assert.equal(scaledGap(m60, 3), 6)
})

test('say_no：拒绝提前到 stage 1，7 天周期第二天就能出', () => {
  const t = findTemplate('say_no')
  assert.equal(t.stage, 1, '拒绝是进入自主阶段之前就该长的东西，不能锁在门后面')
  const m7 = model({ growthDays: 7, stage: 1, day: 2 })
  assert.equal(t.cond(m7), true)
  assert.equal(t.cond({ ...m7, day: 1 }), false)
  // 30 天口径不变：第 8 天才出，拒绝两次以后停。
  const m30 = model({ growthDays: 30, stage: 1, day: 8 })
  assert.equal(t.cond(m30), true)
  assert.equal(t.cond({ ...m30, day: 7 }), false)
  assert.equal(t.cond({ ...m30, facts: { refused: 2 } }), false)
})

test('plan_make / arc_try_start：7 天不硬开长内容，12 天起放行', () => {
  const make = findTemplate('plan_make')
  assert.equal(make.cond(model({ growthDays: 7, day: 2, beliefCount: 1 })), false)
  assert.equal(make.cond(model({ growthDays: 14, day: 2, beliefCount: 1 })), false)
  assert.equal(make.cond(model({ growthDays: 14, day: 3, beliefCount: 1 })), true)

  const arc = findTemplate('arc_try_start')
  assert.equal(arc.cond(model({ growthDays: 7, day: 2, beliefCount: 2 })), false)
  assert.equal(arc.cond(model({ growthDays: 13, day: 2, beliefCount: 2 })), true, '13 天也放行：压缩后仍走得完三集')
  assert.equal(arc.cond(model({ growthDays: 14, day: 1, beliefCount: 2 })), false)
  assert.equal(arc.cond(model({ growthDays: 14, day: 2, beliefCount: 2 })), true)
})

test('echo_old：短周期的「旧」按比例提前，但仍至少有三天', () => {
  const t = findTemplate('echo_old')
  const m7 = model({ growthDays: 7, stage: 3, day: 4 })
  const fresh = model({ ...m7, beliefs: [{ id: 'b1', text: '刚下的判断', since: at(2) }] })
  assert.equal(t.cond(fresh, { now: Date.now() }), false)
  const old = model({ ...m7, beliefs: [{ id: 'b1', text: '我总先想他爱听什么', since: at(3) }] })
  assert.equal(t.cond(old, { now: Date.now() }), true)
})

test('plan_due：到期间隔随周期缩放，7 天隔一天就认', () => {
  const t = findTemplate('plan_due')
  const now = Date.now()
  const oneDay = new Map([['plan_make', { id: 'plan_make', count: 1, lastAt: now - 1 * DAY_MS }]])
  const threeDays = new Map([['plan_make', { id: 'plan_make', count: 1, lastAt: now - 3 * DAY_MS }]])

  assert.equal(t.cond(model({ growthDays: 7 }), { now, fired: oneDay }), true)
  assert.equal(t.cond(model({ growthDays: 30 }), { now, fired: oneDay }), false)
  assert.equal(t.cond(model({ growthDays: 30 }), { now, fired: threeDays }), true)
})

test('任意天数都落在自己的阶段里：13 / 59 / 90 / 180 的里程碑不越界', () => {
  for (const g of [13, 59, 90, 180]) {
    const b = stageBounds(g)
    const m = model({ growthDays: g })
    assert.ok(scaledDay(m, 8) <= b[0], `${g} 天：say_no 不能晚于 stage 1 结束`)
    assert.ok(scaledDay(m, 16) <= b[1], `${g} 天：use_tool 不能晚于 stage 2 结束`)
    assert.ok(scaledDay(m, 26) <= b[2], `${g} 天：leave_something 不能晚于 stage 3 结束`)
    const arcStart = scaledDay(m, 5)
    const arcEnd = arcStart + scaledGap(m, 3) + scaledGap(m, 7)
    assert.ok(arcStart < b[1], `${g} 天：三集弧要在 stage 2 内起头`)
    assert.ok(arcEnd <= g, `${g} 天：三集弧要在这一局结束前走完`)
  }
})

test('门阈值：短周期各要一次，30 天以上仍是两次', () => {
  assert.deepEqual(gateNeed(7), { trust: 1, autonomy: 1, competence: 1 })
  assert.deepEqual(gateNeed(14), { trust: 1, autonomy: 1, competence: 1 })
  assert.deepEqual(gateNeed(30), { trust: 1, autonomy: 2, competence: 2 })
  assert.deepEqual(gateNeed(60), { trust: 1, autonomy: 2, competence: 2 })
  assert.deepEqual(gateNeed(5), { trust: 1, autonomy: 1, competence: 1 }, '低于 7 天也按 7 天算')
})

test('短周期真的能走完门：同样的证据在 7 天到 stage 3，在 30 天还停在 stage 1', () => {
  const t0 = Date.parse('2026-10-01T00:00:00Z')
  const evs = [
    ev('s', 'seed', 1, '种', { source: 'system' }),
    ev('b', 'utterance', 2, '我不喜欢被安排。'),
    ev('r', 'refusal', 3, '这件事我不做。'),
    ev('v', 'revise', 4, '我改一下。', { verdict: 'refined', refs: ['b'] }),
  ]
  const m7 = deriveSelf(evs, { now: t0 + 4 * DAY_MS, growthDays: 7 })
  const m30 = deriveSelf(evs, { now: t0 + 4 * DAY_MS, growthDays: 30 })
  assert.ok(m7.stage >= 3, `7 天周期应该走到 stage 3，实际 ${m7.stage}`)
  assert.equal(m30.stage, 1, '30 天周期里 1 次拒绝还不够过自主门')
  assert.equal(m30.stageGate.pending, 'autonomy')
})

test('门加权：她卡在自主门时，能催生拒绝的卡先出', () => {
  const cfg = normalizeConfig({})
  const m = model({
    growthDays: 7, stage: 1, day: 2, beliefCount: 1,
    stageGate: { passed: ['trust'], pending: 'autonomy', forced: [], gateStage: 2 },
    needs: { autonomy: 1, competence: 1, relatedness: 1 },
  })
  const events = CATALOG
    .filter((t) => !['say_no', 'notice_one'].includes(t.id))
    .map((t) => ({ type: 'meta', text: `fired:${t.id}`, ts: new Date().toISOString() }))
  const r = pick(m, cfg, today(), events)
  assert.equal(r?.template?.id, 'say_no', '自主门没过的短周期里，先让她学会拒绝')
})
