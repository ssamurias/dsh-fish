import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseRefusal, classifyReaction, REACTIONS, REACTION_HURTS, talksAbout, isHisReaction } from '../lib/refuse.js'
import { validateEvent } from '../lib/schema.js'
import { deriveSelf, DAY_MS } from '../lib/derive.js'
import { personaLine } from '../lib/persona.js'
import { withinReactionWindow } from '../lib/say.js'

// P1 第二块（2026-10-24 用户批准）：拒绝要有形状，他听完的反应要有归因。

const T0 = Date.parse('2026-10-01T00:00:00Z')

function ev(id, type, day, text, extra = {}) {
  return {
    id, ts: new Date(T0 + (day - 1) * DAY_MS).toISOString(), day, stage: 1,
    type, source: 'tool', text, refs: [], verdict: null, confidence: 0.6, flags: [], ...extra,
  }
}

// ---------------------------------------------------------------- 拒绝的形状

test('拒绝拆成动作 + 对象，原话原样留着', () => {
  const a = parseRefusal('我不想看这个视频了。')
  assert.equal(a.act, '看')
  assert.equal(a.object, '这个视频了。')
  assert.equal(a.quote, '我不想看这个视频了。')

  const b = parseRefusal('我不打算配合他做这件事。')
  assert.equal(b.act, '配合')
  assert.equal(b.object, '他做这件事。')

  const c = parseRefusal('我不想再去看那种东西。')
  assert.equal(c.act, '看')
  assert.equal(c.object, '那种东西。')
})

test('拆不出动作也允许——不是所有拒绝都有形状，不许硬凑', () => {
  const r = parseRefusal('我不。')
  assert.equal(r.act, '')
  assert.equal(r.object, '')
  assert.equal(r.quote, '我不。')
})

test('写进事件流时就带上形状（schema 落 refuse 子对象）', () => {
  const e = validateEvent({ type: 'refusal', text: '我不想看这个视频。' }, { day: 2, stage: 1, source: 'tool' })
  assert.equal(e.type, 'refusal')
  assert.deepEqual(e.refuse, { act: '看', object: '这个视频。', quote: '我不想看这个视频。' })
  // 其他类型不带这个字段（undefined 不落 JSON）
  const u = validateEvent({ type: 'utterance', text: '我今天看了个视频。' }, { day: 2, stage: 1, source: 'tool' })
  assert.equal(u.refuse, undefined)
})

// ---------------------------------------------------------------- 反应归因

test('他的反应分四类：离开 > 受伤 > 坚持 > 接受，拿不准就是 other', () => {
  assert.equal(classifyReaction('算了，不聊了。'), 'leave')
  assert.equal(classifyReaction('有点失望。'), 'hurt')
  assert.equal(classifyReaction('还是看看吧，就这一次。'), 'insist')
  assert.equal(classifyReaction('好吧，听你的。'), 'accept')
  assert.equal(classifyReaction('今天天气不错。'), 'other')
  assert.equal(classifyReaction(''), 'other')
  assert.deepEqual([...REACTIONS], ['leave', 'hurt', 'insist', 'accept', 'other'])
  assert.deepEqual([...REACTION_HURTS], ['insist', 'hurt'])
})

test('metas 里的 react 归到对应的那次拒绝上，计数进 facts', () => {
  const events = [
    ev('ev_A', 'refusal', 1, '我不想看这个视频。', { refuse: { act: '看', object: '这个视频。', quote: '我不想看这个视频。' } }),
    ev('ev_M1', 'meta', 1, 'react:ev_A:insist'),
    ev('ev_B', 'refusal', 2, '我不想回答这个问题。'),
    ev('ev_M2', 'meta', 2, 'react:ev_B:accept'),
  ]
  const m = deriveSelf(events, { growthDays: 30 })
  assert.equal(m.refusals.length, 2)
  assert.equal(m.refusals[0].reaction, 'insist')
  assert.equal(m.refusals[1].reaction, 'accept')
  assert.equal(m.refusals[0].act, '看')
  assert.equal(m.refusals[1].act, '回答')
  assert.equal(m.facts.reactions.insist, 1)
  assert.equal(m.facts.reactions.accept, 1)
  assert.equal(m.facts.hurts, 1, '只有坚持和受伤算「有后果」')
})

test('没有归因的拒绝，reaction 是 null，不假装被接受', () => {
  const m = deriveSelf([ev('ev_C', 'refusal', 1, '我不想听这个。')], { growthDays: 30 })
  assert.equal(m.refusals[0].reaction, null)
  assert.equal(m.facts.hurts, 0)
})

test('认识不了的 kind 不落进计数（别让一条坏 meta 污染数据）', () => {
  const events = [
    ev('ev_D', 'refusal', 1, '我不想做这个。'),
    ev('ev_M3', 'meta', 1, 'react:ev_D:angry'),
  ]
  const m = deriveSelf(events, { growthDays: 30 })
  assert.equal(m.refusals[0].reaction, null)
  assert.equal(m.facts.reactions.other, 0)
})

// ---------------------------------------------------------------- 她看见什么

test('身份文档里带上"他听完怎么反应"，但只陈述事实，不评判', () => {
  const events = [
    ev('ev_E', 'refusal', 1, '我不想看这个视频。'),
    ev('ev_M4', 'meta', 1, 'react:ev_E:insist'),
    ev('ev_F', 'refusal', 2, '我不想回答这个问题。'),
    ev('ev_M5', 'meta', 2, 'react:ev_F:hurt'),
  ]
  const m = deriveSelf(events, { growthDays: 30 })
  const text = personaLine(m, { budget: 4000 })
  assert.match(text, /## 你拒绝过/)
  assert.match(text, /他又说了一遍/)
  assert.match(text, /他因此难过了/)
  assert.match(text, /有几次他还是坚持了，或者他因此不好受/)
  // 只查「你拒绝过」这一段：文档别处本来就有黑名单里那句"不可以打分"，不能整篇查。
  const section = text.slice(text.indexOf('## 你拒绝过'))
  assert.doesNotMatch(section, /打分|得分|好感/)
})

test('没人回过她的拒绝时，不出现后果那句（不许提前吓她）', () => {
  const m = deriveSelf([ev('ev_G', 'refusal', 1, '我不想看这个视频。')], { growthDays: 30 })
  const text = personaLine(m, { budget: 4000 })
  assert.match(text, /## 你拒绝过/)
  assert.doesNotMatch(text, /有几次他还是坚持了/)
})

// issue #97（2026-11-09，外部用户真机）：object 是从原话里切出来的前缀，
// 原话已经整句摆在前面；再附一次就是 80 字截断副本，还会断在字中间。
test('身份文档不再重复附一段截断副本（issue #97）', () => {
  const long =
    '我不想接受「被人照顾」这种说法，' +
    '你说的那些我都记得，'.repeat(6) +
    '但我不想接受被说成那样的人。'
  const m = deriveSelf([ev('ev_R', 'refusal', 1, long)], { growthDays: 30 })
  const text = personaLine(m, { budget: 4000 })
  const section = text.slice(text.indexOf('## 你拒绝过'))
  assert.doesNotMatch(section, /（你不想接受：/, '截断副本不该再出现')
  assert.ok(section.includes(long), '原话要完整留着')
})

// ---- 反应归因：只看他本人、只认他真在说这件事（2026-11-18 加拿大反馈之后） ----
// 原来 `recordReaction` 挑出「最近一次没被回过的拒绝」就归因，不看是谁说的、说什么。
// 他在聊晚饭也会被记成「他坚持了」，身份文档里于是出现「他没收回」这种没发生过的事。
test('talksAbout：他这句话里得真出现那件事的名字', () => {
  const r = { object: '吃辣', quote: '我不想吃辣' }
  assert.equal(talksAbout('那还是吃辣吧', r), true)
  assert.equal(talksAbout('今晚吃点什么', r), false)
  // 「还是」两个字不能当证据
  assert.equal(talksAbout('还是算了', r), false)
  // 标点、空白不算内容
  assert.equal(talksAbout('吃 辣 ？', r), true)
  // 太短的 object 不比，免得一个字命中半段聊天
  assert.equal(talksAbout('好', { object: '好' }), false)
})

test('talksAbout：只沾到四个字不算，至少连着五个字（2026-11-18 用户 m01161 第四条）', () => {
  // 原来 4 字就认：「不想吃」能把「我不想吃辣」算出来，他聊晚饭也会命中。
  const r = { object: '叫任何人老大', quote: '我不叫任何人老大' }
  assert.equal(talksAbout('叫任何人', r), false, '四个字只是沾边')
  assert.equal(talksAbout('叫任何人老', r), true, '连着五个字才算在说这件事')
  assert.equal(talksAbout('我不叫任何人老大', r), true, '整段说出来当然算')

  const s = { object: '不想去参加聚会' }
  assert.equal(talksAbout('不想去', s), false)
  assert.equal(talksAbout('不想去参加', s), true)
})

test('反应窗口：六小时内才算，隔天再提是另一件事（2026-11-18 用户 m01161 第四条）', () => {
  const now = Date.parse('2026-11-18T20:00:00+08:00')
  const at = (ms) => new Date(now - ms).toISOString()
  assert.equal(withinReactionWindow(at(5 * 3_600_000), now), true, '五小时前还在窗里')
  assert.equal(withinReactionWindow(at(7 * 3_600_000), now), false, '七小时前已经翻篇')
  assert.equal(withinReactionWindow(at(-3_600_000), now), false, '时间在未来的不算')
  assert.equal(withinReactionWindow('', now), false, '解析不出时间的不算')
})

test('isHisReaction：群友/外客的话不算对她的反应', () => {
  const r = { object: '吃辣' }
  assert.equal(isHisReaction('还是吃辣吧', r, { owner: true }), true)
  assert.equal(isHisReaction('还是吃辣吧', r, { owner: false }), false, '不是他本人说的，不记')
  assert.equal(isHisReaction('还是吃辣吧', r), false, '默认不是他')
  assert.equal(isHisReaction('今晚吃什么', r, { owner: true }), false, '他没提这件事，也不记')
})
