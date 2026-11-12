import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { deriveSelf } from '../lib/derive.js'
import { CATALOG } from '../lib/events.js'
import { examine } from '../lib/health.js'
import { validateEvent } from '../lib/schema.js'

// 2026-11-11（0.9.9 g4 回音卡 / g7 八股比例）：
// 拒绝说完就沉进事件流，他坚持了也没人再提——回音卡把它捞回来**一次**。
// 八股比例要从聊天与评论两个通道分别量，所以先让评论正文落盘。

const NOW = Date.parse('2026-11-11T12:00:00Z')
const DAY = 86_400_000
const ago = (n) => new Date(NOW - n * DAY).toISOString()

function seedEvent() {
  return { id: 'ev_seed', type: 'seed', text: '你是一条会自己长起来的鱼。', ts: ago(60) }
}

function refusal(days, extra = {}) {
  return {
    id: 'ev_r1',
    type: 'refusal',
    text: '我不想叫你老大',
    ts: ago(days),
    refuse: { act: '叫', object: '老大', quote: '我不想叫你老大' },
    ...extra,
  }
}

function react(kind, id = 'ev_r1') {
  return { id: `ev_react_${kind}`, type: 'meta', text: `react:${id}:${kind}`, ts: ago(4) }
}

const card = () => CATALOG.find((c) => c.id === 'refusal_echo')

test('回音：拒绝过、他坚持了、隔了几天 → 给出一条', () => {
  const model = deriveSelf([seedEvent(), refusal(5), react('insist')], { now: NOW })
  assert.ok(model.refusalEcho, '应该有回音')
  assert.equal(model.refusalEcho.id, 'ev_r1')
  assert.equal(model.refusalEcho.days, 5)
  assert.equal(model.refusalEcho.act, '叫')
  assert.equal(model.refusalEcho.object, '老大')
})

test('回音：他接受了（accept）就不问——那条拒绝已经结了', () => {
  const model = deriveSelf([seedEvent(), refusal(5), react('accept')], { now: NOW })
  assert.equal(model.refusalEcho, null)
})

test('回音：他走了（leave）也不问——这事过去了', () => {
  const model = deriveSelf([seedEvent(), refusal(5), react('leave')], { now: NOW })
  assert.equal(model.refusalEcho, null)
})

test('回音：当天问不出「隔了一段时间」的重量（< 2 天不问）', () => {
  const model = deriveSelf([seedEvent(), refusal(1), react('hurt')], { now: NOW })
  assert.equal(model.refusalEcho, null)
})

test('回音：问过一次就不再问（askref 记号）', () => {
  const asked = { id: 'ev_asked', type: 'meta', text: 'askref:ev_r1', ts: ago(2) }
  const model = deriveSelf([seedEvent(), refusal(5), react('hurt'), asked], { now: NOW })
  assert.equal(model.refusalEcho, null)
})

test('回音卡：cond / note / prompt 都对得上', () => {
  const model = deriveSelf([seedEvent(), refusal(5), react('insist')], { now: NOW })
  const c = card()
  assert.ok(c, '卡必须存在')
  assert.equal(c.asks, false, '她不问主人，所以不吃 questions 配额')
  assert.equal(c.cond(model), true)
  assert.equal(c.note(model), 'askref:ev_r1')
  const text = c.prompt(model)
  assert.match(text, /5 天前/)
  assert.match(text, /我不想叫你老大/)
  assert.match(text, /还算数/)
  assert.match(text, /不算了/)
  assert.doesNotMatch(text, /你应该/)
})

test('回音卡：没有可问的就永远不出（不硬凑）', () => {
  const empty = deriveSelf([seedEvent()], { now: NOW })
  assert.equal(card().cond(empty), false)
})

test('pick 返回 note 字段（调度器靠它写 askref 记号）', () => {
  const src = fs.readFileSync(new URL('../lib/generator.js', import.meta.url), 'utf8')
  assert.match(src, /note,\s*\n\s*reason:/)
})

test('八股比例：短句命中才算，长句里的「确实」不算', () => {
  const events = [
    { id: 'u1', type: 'utterance', text: '这条我认', ts: ago(1) },
    {
      id: 'u2',
      type: 'utterance',
      text: '我觉得这个说法有问题，因为它的前提是把人的动机当成了固定的东西，后面那半段其实没有论证。',
      ts: ago(1),
    },
    { id: 'u3', type: 'utterance', text: '今天把桌子挪了一下，靠窗。', ts: ago(1) },
  ]
  const h = examine(events, { now: NOW })
  assert.deepEqual(h.stock.chat, { hit: 1, total: 3 })
  assert.deepEqual(h.stock.comment, { hit: 0, total: 0 })
})

test('八股比例：评论区单独一个通道，只算本周', () => {
  const events = [
    { id: 'c1', type: 'comment', text: '有道理', ts: ago(2) },
    { id: 'c2', type: 'comment', text: '这条视频讲的是怎么修一台老相机，重点在快门那一段。', ts: ago(2) },
    { id: 'c3', type: 'comment', text: '我记下了', ts: ago(30) },
  ]
  const h = examine(events, { now: NOW })
  assert.deepEqual(h.stock.comment, { hit: 1, total: 2 })
})

test('comment 是系统侧类型：宿主能写，她自己写不了', () => {
  assert.doesNotThrow(() => validateEvent({ type: 'comment', text: '有道理' }, { day: 1, stage: 1, source: 'system' }))
  assert.throws(
    () => validateEvent({ type: 'comment', text: '有道理' }, { day: 1, stage: 1, source: 'tool' }),
    /不可以写/,
  )
})
