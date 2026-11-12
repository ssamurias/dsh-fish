import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveSelf, DAY_MS } from '../lib/derive.js'
import { buildSections } from '../lib/persona.js'
import { normalizeTopic, validateEvent } from '../lib/schema.js'
import { CATALOG } from '../lib/events.js'
import { fillOwner } from '../lib/pronoun.js'

// 1.0 话题索引（R §8.9 / L6 地基）：
//   - `topic` 是她自己给的短标签，可选、只在 utterance/revise 上落库
//   - 判断冲突：他新说的话里出现同一个词、且方向相反 → 并排摆原文，不给指令
//   - 同一个标签下两句话 → `same_thread` 卡（比较，不是合并）

const NOW = Date.parse('2026-11-12T12:00:00Z')
const ago = (n) => new Date(NOW - n * DAY_MS).toISOString()
const NL = String.fromCharCode(10)

const ev = (o) => ({
  id: o.id,
  v: 4,
  ts: o.ts,
  day: 30,
  stage: 3,
  type: o.type,
  source: o.source ?? 'tool',
  text: o.text,
  refs: o.refs ?? [],
  verdict: o.verdict ?? null,
  confidence: 0.6,
  flags: o.flags ?? [],
  ...(o.topic ? { topic: o.topic } : {}),
  ...(o.scene ? { scene: o.scene } : {}),
})

function model(over = {}) {
  return {
    seed: '你是一条会自己长起来的鱼。',
    day: 40,
    stage: 3,
    stageGate: { passed: ['trust'] },
    beliefs: [],
    refusals: [],
    scars: [],
    tensions: [],
    solid: [],
    faded: [],
    refuted: [],
    selfmodAttempts: [],
    facts: { hurts: 0 },
    narrative: null,
    name: null,
    absenceDays: 0,
    looseSaid: [],
    conflicts: [],
    topicPairs: [],
    ...over,
  }
}

// 模板句里写的是 `{T}`（主人代词占位），渲染时才填；测试里按默认「他」填掉，
// 断言的才是她真正看到的那份文字。
const textOf = (m, o = {}) =>
  fillOwner(buildSections(m, { shown: 3, ...o }).map((s) => s.text).join(NL), '他')

test('话题标签：压空白、去引号、截到 12 字', () => {
  assert.equal(normalizeTopic('  「叫 老大」 '), '叫 老大')
  assert.equal(normalizeTopic('一二三四五六七八九十十一十二'), '一二三四五六七八九十十一')
  assert.equal(normalizeTopic(''), '')
})

test('话题标签：只落在 utterance / revise 上，别的事件带它也不收', () => {
  const a = validateEvent({ type: 'utterance', text: '我不喜欢被叫老大。', topic: '叫老大' }, { day: 2, stage: 1, now: NOW })
  assert.equal(a.topic, '叫老大')
  const b = validateEvent({ type: 'heard', text: '叫老大挺好的', topic: '叫老大' }, { day: 2, stage: 1, now: NOW, source: 'system' })
  assert.equal(b.topic, undefined)
})

test('判断带上话题，没给话题的按空串算', () => {
  const m = deriveSelf(
    [
      ev({ id: 'ev_a', type: 'utterance', ts: ago(3), text: '我不喜欢被叫老大。', topic: '叫老大' }),
      ev({ id: 'ev_b', type: 'utterance', ts: ago(2), text: '看评论比看视频累。' }),
    ],
    { now: NOW },
  )
  assert.equal(m.beliefs.find((b) => b.id === 'ev_a')?.topic, '叫老大')
  assert.equal(m.beliefs.find((b) => b.id === 'ev_b')?.topic, '')
})

test('判断冲突：他私下说的那句里有同一个词、方向相反 → 出 1 条', () => {
  const m = deriveSelf(
    [
      ev({ id: 'ev_a', type: 'utterance', ts: ago(6), text: '我不喜欢被叫老大。', topic: '叫老大' }),
      ev({ id: 'ev_h', type: 'heard', ts: ago(1), text: '叫老大挺好的，显得亲近。' }),
    ],
    { now: NOW },
  )
  assert.equal(m.conflicts.length, 1)
  assert.equal(m.conflicts[0].beliefText, '我不喜欢被叫老大。')
  assert.ok(m.conflicts[0].heardText.includes('叫老大'))
})

test('判断冲突：群里的、超过 14 天的、方向相同的都不摆', () => {
  const base = [ev({ id: 'ev_a', type: 'utterance', ts: ago(6), text: '我不喜欢被叫老大。', topic: '叫老大' })]
  const group = deriveSelf(
    [...base, ev({ id: 'ev_h', type: 'heard', ts: ago(1), text: '叫老大挺好的。', scene: 'group' })],
    { now: NOW },
  )
  assert.equal(group.conflicts.length, 0, '群里的热闹不算他在跟我说')
  const old = deriveSelf(
    [...base, ev({ id: 'ev_h', type: 'heard', ts: ago(20), text: '叫老大挺好的。' })],
    { now: NOW },
  )
  assert.equal(old.conflicts.length, 0, '太旧的不摆')
  const same = deriveSelf(
    [...base, ev({ id: 'ev_h', type: 'heard', ts: ago(1), text: '我也不喜欢被叫老大。' })],
    { now: NOW },
  )
  assert.equal(same.conflicts.length, 0, '方向相同不是冲突')
})

test('话题对：同一标签下两句判断 → 一对；不同标签不配', () => {
  const m = deriveSelf(
    [
      ev({ id: 'ev_a', type: 'utterance', ts: ago(9), text: '被叫老大不舒服。', topic: '叫老大' }),
      ev({ id: 'ev_b', type: 'utterance', ts: ago(2), text: '叫老大这件事，取决于谁叫。', topic: '叫老大' }),
      ev({ id: 'ev_c', type: 'utterance', ts: ago(1), text: '评论区越短越难写。', topic: '评论区' }),
    ],
    { now: NOW },
  )
  assert.equal(m.topicPairs.length, 1)
  assert.equal(m.topicPairs[0].topic, '叫老大')
  assert.equal(m.topicPairs[0].b.text, '叫老大这件事，取决于谁叫。')
})

test('身份文档：冲突只并排两行原文，不给指令', () => {
  const text = textOf(
    model({
      conflicts: [
        {
          heardAt: ago(1),
          heardText: '叫老大挺好的，显得亲近。',
          beliefId: 'ev_a',
          beliefAt: ago(6),
          beliefText: '我不喜欢被叫老大。',
          topic: '叫老大',
        },
      ],
    }),
  )
  assert.ok(text.includes('## 他说过的话，和你的判断'))
  assert.ok(text.includes('叫老大挺好的'))
  assert.ok(text.includes('我不喜欢被叫老大。'))
  assert.ok(!text.includes('你应该'), '并排就够了，不加指令')
  assert.ok(!text.includes('他错了') && !text.includes('你错了'), '不判定谁对')
})

test('same_thread：没有话题对时不出，有对时并排两句话并留「拿不准」出口', () => {
  const card = CATALOG.find((c) => c.id === 'same_thread')
  assert.ok(card, '卡在目录里')
  assert.equal(card.asks, false, '这是让她想，不是让她提问')
  assert.equal(card.cond(model()), false)
  const m = model({
    topicPairs: [
      { topic: '叫老大', a: { id: 'ev_a', text: '被叫老大不舒服。', since: ago(9) }, b: { id: 'ev_b', text: '叫老大取决于谁叫。', since: ago(2) } },
    ],
  })
  assert.equal(card.cond(m), true)
  const p = card.prompt(m)
  assert.ok(p.includes('「叫老大」'))
  assert.ok(p.includes('被叫老大不舒服。'))
  assert.ok(p.includes('叫老大取决于谁叫。'))
  assert.ok(p.includes('拿不准'), '允许她说拿不准')
  assert.ok(!p.includes('等级'), '不做判断分级')
})
