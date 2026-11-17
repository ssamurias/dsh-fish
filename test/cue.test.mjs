import test from 'node:test'
import assert from 'node:assert/strict'
import { cueLineFrom, rememberHuman, clearHuman, cueFor, CUE_TTL_MS } from '../lib/cue.js'

const SINCE = '2026-11-01T04:00:00.000Z'

function belief(over = {}) {
  return {
    status: 'active',
    topic: '叫老大',
    text: '我想叫他老大。',
    since: SINCE,
    ...over,
  }
}

test('他这句话碰到 topic：摆一条原话和日期，不判对错', () => {
  const line = cueLineFrom({ beliefs: [belief()] }, '今天还是叫老大吧')
  assert.match(line, /^## 这一句碰到的旧话/)
  assert.match(line, /你以前说过：「我想叫他老大。」（11-01）/)
  assert.match(line, /只是你当时说过，不代表现在也这么想/)
  assert.doesNotMatch(line, /对|错|正确|错误/)
})

test('没有碰到 topic / 没有判断：不摆', () => {
  assert.equal(cueLineFrom({ beliefs: [belief()] }, '今天天气不错'), '')
  assert.equal(cueLineFrom({ beliefs: [] }, '叫老大'), '')
  assert.equal(cueLineFrom(null, '叫老大'), '')
  assert.equal(cueLineFrom({ beliefs: [belief()] }, ''), '')
})

test('同一个 topic 有多条：取最近的一条', () => {
  const line = cueLineFrom({
    beliefs: [
      belief({ text: '早先那句。', since: '2026-10-01T04:00:00.000Z' }),
      belief({ text: '后来那句。', since: '2026-11-03T04:00:00.000Z' }),
    ],
  }, '叫老大')
  assert.match(line, /后来那句/)
  assert.doesNotMatch(line, /早先那句/)
})

test('旧话太长：按码点截到 80 字，带省略号', () => {
  const long = '叫'.repeat(100)
  const line = cueLineFrom({ beliefs: [belief({ text: long })] }, '叫老大')
  assert.match(line, /…/)
  assert.equal([...line].filter((c) => c === '叫').length, 80)
})

test('规矩、单字 topic、已改口、空正文都不摆', () => {
  assert.equal(cueLineFrom({ beliefs: [belief({ topic: '规矩' })] }, '规矩'), '')
  assert.equal(cueLineFrom({ beliefs: [belief({ topic: '人' })] }, '人'), '')
  assert.equal(cueLineFrom({ beliefs: [belief({ status: 'refined' })] }, '叫老大'), '')
  assert.equal(cueLineFrom({ beliefs: [belief({ text: '   ' })] }, '叫老大'), '')
})

test('这一轮的 cue 在 clear 之后不再留着', () => {
  rememberHuman('s1', '叫老大')
  // 这个文件没有调用过 deriveSelf，lastDerived 为空：不摆，但也不能抛。
  assert.equal(cueFor('s1'), '')
  clearHuman('s1')
  assert.equal(cueFor('s1'), '')
})

test('turn/end 丢了也有兜底：15 分钟后不再摆上一句', () => {
  const model = { beliefs: [belief()] }
  const t0 = Date.parse(SINCE) + 1000
  rememberHuman('ttl', '叫老大', { at: t0 })
  assert.match(cueFor('ttl', { now: t0 + 1000, model }), /你以前说过/)
  assert.equal(cueFor('ttl', { now: t0 + CUE_TTL_MS + 1, model }), '')
  clearHuman('ttl')
})
