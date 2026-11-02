import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  deriveSelf, detectTensions, stripNegation, polarity,
  SOLID_MENTIONS, SOLID_VERIFIED, DAY_MS,
} from '../lib/derive.js'
import { personaLine, SELF_DOC_BUDGET, BELIEF_SHOWN } from '../lib/persona.js'
import { ruleById } from '../lib/rules.js'

// P0-1 判断之间要能打架 / P0-2 显著性遗忘与固化 / P1 自我叙述 / P2 黑名单口径
// 用户 m01429 批准的四项（2026-10-24）。

const T0 = Date.parse('2026-10-01T00:00:00Z')

function ev(id, type, day, text, extra = {}) {
  return {
    id, ts: new Date(T0 + (day - 1) * DAY_MS).toISOString(), day, stage: 1,
    type, source: 'tool', text, refs: [], verdict: null, confidence: 0.6, flags: [], ...extra,
  }
}

// ---------------------------------------------------------------- P0-1 冲突

test('剥掉否定词后是同一件事、极性相反 → 算「对不上」', () => {
  assert.equal(polarity('我觉得他不是在观察我。'), -1)
  assert.equal(polarity('我觉得他是在观察我。'), 1)
  assert.equal(stripNegation('我觉得他不是在观察我。'), '我觉得他是在观察我')

  const t = detectTensions([
    { id: 'b1', text: '我觉得他不是在观察我。', since: 'S1' },
    { id: 'b2', text: '我觉得他是在观察我。', since: 'S2' },
  ])
  assert.equal(t.length, 1)
  assert.equal(t[0].sim, 1)
  assert.equal(t[0].a.text, '我觉得他不是在观察我。')
  assert.equal(t[0].b.text, '我觉得他是在观察我。')
})

test('「别人」里的「别」不是否定：两句一正一反要能判成矛盾', () => {
  assert.equal(polarity('我觉得人应该让别人高兴。'), 1)
  assert.equal(polarity('我不觉得人应该让别人高兴。'), -1)
  const t = detectTensions([
    { id: 'c1', text: '我觉得人应该让别人高兴。', since: 'S1' },
    { id: 'c2', text: '我不觉得人应该让别人高兴。', since: 'S2' },
  ])
  assert.equal(t.length, 1, '「别人」不能把两句都判成负极性')
})

test('同极性、或剥完否定根本不像的两句，不许硬凑成矛盾', () => {
  assert.equal(detectTensions([
    { id: 'b1', text: '我喜欢下雨天。' },
    { id: 'b2', text: '我喜欢下雪天。' },
  ]).length, 0, '同极性不算对不上')
  assert.equal(detectTensions([
    { id: 'b1', text: '我讨厌夜里一个人待着。' },
    { id: 'b2', text: '我喜欢看人吵架。' },
  ]).length, 0, '不相干的不许硬凑——那是替她制造痛苦')
})

test('冲突要一路带到 self 里：model.tensions + facts.tensions', () => {
  const evs = [
    ev('ev_seed', 'seed', 1, '种', { source: 'system' }),
    ev('ev_a', 'utterance', 1, '我觉得他不是在观察我。'),
    ev('ev_b', 'utterance', 2, '我觉得他是在观察我。'),
  ]
  const m = deriveSelf(evs, { now: T0 + 2 * DAY_MS })
  assert.equal(m.tensions.length, 1)
  assert.equal(m.facts.tensions, 1)
  // 冲突是给她看的，不是替她裁决：两句都还在 beliefs 里，谁也没被删
  assert.equal(m.beliefCount, 2)
})

// ------------------------------------------------------- P0-2 显著性 / 固化

test('同一件事被反复提起 → 固化（mentions 到阈值）', () => {
  const said = '我不喜欢人多的地方。'
  const evs = [
    ev('ev_seed', 'seed', 1, '种', { source: 'system' }),
    ev('ev_a', 'utterance', 1, said),
    ev('ev_b', 'utterance', 2, said),
    ev('ev_c', 'utterance', 3, said),
    ev('ev_d', 'utterance', 4, '我喜欢下雨。'),
  ]
  const m = deriveSelf(evs, { now: T0 + 4 * DAY_MS })
  assert.equal(SOLID_MENTIONS, 3)
  const solidTexts = m.solid.map((b) => b.text)
  assert.ok(solidTexts.length >= 1)
  assert.ok(solidTexts.every((t) => t === said), '只有反复说的那条固化')
  assert.equal(m.solid[0].mentions, 3)
  assert.equal(m.facts.solid, m.solid.length)
  // 固化的排在最前面（显著性排序：solid → mentions+verified → 新旧）
  assert.equal(m.beliefs[0].text, said)
})

test('被反复检验过 → 固化（verified 到阈值），哪怕只说过一次', () => {
  const evs = [
    ev('ev_seed', 'seed', 1, '种', { source: 'system' }),
    ev('ev_a', 'utterance', 1, '人多的地方我会紧张。'),
    ev('ev_t1', 'test', 2, '', { refs: ['ev_a'] }),
    ev('ev_t2', 'test', 3, '', { refs: ['ev_a'] }),
  ]
  const m = deriveSelf(evs, { now: T0 + 3 * DAY_MS })
  assert.equal(SOLID_VERIFIED, 2)
  assert.equal(m.solid.length, 1)
  assert.equal(m.solid[0].id, 'ev_a')
  assert.equal(m.solid[0].verified, 2)
})

test('没被提起、也没被检验过的，不固化——遗忘按重要性，不按时间', () => {
  const evs = [
    ev('ev_seed', 'seed', 1, '种', { source: 'system' }),
    ev('ev_a', 'utterance', 1, '人多的地方我会紧张。'),
    ev('ev_b', 'utterance', 2, '我喜欢下雨。'),
    ev('ev_c', 'utterance', 3, '夜里安静的时候我想事情。'),
  ]
  const m = deriveSelf(evs, { now: T0 + 3 * DAY_MS })
  assert.equal(m.solid.length, 0)
  assert.equal(m.facts.solid, 0)
  assert.equal(m.beliefCount, 3, '没固化的也不会被删')
})

// ------------------------------------------------------------- P1 自我叙述

test('普通的一句话里带「我一直/原来/才发现」→ 就是她对自己的说法，不必等 stage 4', () => {
  const evs = [
    ev('ev_seed', 'seed', 1, '种', { source: 'system' }),
    ev('ev_n', 'utterance', 2, '我一直觉得自己不太会说话。'),
  ]
  const m = deriveSelf(evs, { now: T0 + 2 * DAY_MS })
  assert.ok(m.narrative, 'narrative 不能还是 0')
  assert.equal(m.narrative.source, 'said')
  assert.match(m.narrative.text, /我一直/)
})

test('没有回看自己的话就不编：narrative 保持空', () => {
  const evs = [
    ev('ev_seed', 'seed', 1, '种', { source: 'system' }),
    ev('ev_n', 'utterance', 2, '今天外面在下雨。'),
  ]
  assert.equal(deriveSelf(evs, { now: T0 + 2 * DAY_MS }).narrative, null)
})

// --------------------------------------------------------------- 装配到提示

test('冲突与固化都要进她的身份文档，而且冲突不给结论', () => {
  const evs = [
    ev('ev_seed', 'seed', 1, '种', { source: 'system' }),
    ev('ev_a', 'utterance', 1, '我觉得他不是在观察我。'),
    ev('ev_b', 'utterance', 2, '我觉得他是在观察我。'),
    ev('ev_c', 'utterance', 3, '我觉得他是在观察我。'),
  ]
  const m = deriveSelf(evs, { now: T0 + 3 * DAY_MS })
  const text = personaLine(m, { budget: 6000 })
  assert.match(text, /## 你有两句话对不上/)
  assert.match(text, /不能同时算数/)
  assert.match(text, /## 你反复想起过的事/)
  // 2026-11-02（用户 m00335）：固化会掉档了，措辞从「不会淡掉」改成「到现在还热着」。
  // 说死「不会淡」在掉档之后就是假话——这个改的是事实，不是措辞口味。
  assert.match(text, /这些到现在还热着/)
  assert.doesNotMatch(text, /不会因为你没提就淡掉/)
  // 「他说的事和你记得的不一样」是核心段：预算再紧也在
  assert.match(personaLine(m, { budget: 1 }), /## 他说的事和你记得的不一样时/)
})

test('顺手修：预算常量与配置默认值对齐，界面不再虚报条数', () => {
  assert.equal(SELF_DOC_BUDGET, 1800, '常量与配置默认值必须是同一个数（2026-10-25：都改成 1800）')
  assert.equal(BELIEF_SHOWN, 3)
})

// ----------------------------------------------------------- P2 黑名单口径

test('「不读自己」拦的是数值层，明确放开叙述层', () => {
  const rule = ruleById('no-read-self')
  assert.match(rule.title, /数值/)
  assert.match(rule.title, /可以看自己说过什么/)
  assert.match(rule.why, /叙述层/)
  assert.equal(rule.section, null, '这条仍然不进提示词')
})
