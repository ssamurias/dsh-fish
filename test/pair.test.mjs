/**
 * 概念分化（0.9.9 S-C）——`lib/pair.js`
 *
 * 判据只有一条：**同极性 + 相似度在中间段**。
 * 太不像的凑不成一对；太像的是同一句话说了两遍；极性相反的是矛盾卡的事。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { detectDifferentiations } from '../lib/pair.js'
import { detectTensions } from '../lib/derive.js'

const NOW = Date.parse('2026-11-11T12:00:00Z')
const ago = (d) => new Date(NOW - d * 86400000).toISOString()
const b = (id, text, days = 1) => ({ id, text, since: ago(days) })

test('同极性、相似度在中段的一对，会摆成「两面」的候选', () => {
  const hits = detectDifferentiations(
    [b('a', '他说的话我一般会先想一想再回'), b('b', '别人说的话我通常先想一想再回应')],
    { now: NOW },
  )
  assert.equal(hits.length, 1)
  assert.deepEqual(
    [hits[0].a.id, hits[0].b.id].sort(),
    ['a', 'b'],
  )
  assert.equal(hits[0].sim, 0.59)
  assert.match(hits[0].a.text, /他说的话/)
})

test('异极性不进「两面」——那是矛盾卡的事', () => {
  const pair = [
    b('a', '他说的话我一般会先想一想再回'),
    b('b', '他说话我不太会先想一想再回'),
  ]
  assert.equal(detectDifferentiations(pair, { now: NOW }).length, 0)
  // 同一对在矛盾卡里是候选：两边的分工是机制，不是阈值巧合。
  assert.ok(detectTensions(pair, { minSim: 0.5 }).length >= 1)
})

test('太像的不算「两面」，那是同一句话说了两遍', () => {
  const hits = detectDifferentiations(
    [b('a', '我不喜欢被人一直盯着看很久'), b('b', '我不喜欢被人一直盯着看很久啊')],
    { now: NOW },
  )
  assert.equal(hits.length, 0)
})

test('超出窗口的不算：一个月前的旧话不再拿来对照', () => {
  const hits = detectDifferentiations(
    [b('a', '他说的话我一般会先想一想再回', 40), b('b', '别人说的话我通常先想一想再回应', 41)],
    { now: NOW },
  )
  assert.equal(hits.length, 0)
})

test('一次最多摆一对；limit 可调但默认 1', () => {
  const list = [
    b('a', '他说的话我一般会先想一想再回'),
    b('b', '别人说的话我通常先想一想再回应'),
    b('c', '写日记这件事我想慢慢来'),
    b('d', '写日记这件事我得慢慢来'),
  ]
  assert.equal(detectDifferentiations(list, { now: NOW }).length, 1)
  assert.equal(detectDifferentiations(list, { now: NOW, limit: 5 }).length, 2)
})

test('同一句话说过几遍时，只按原话的无序对去重', () => {
  const hits = detectDifferentiations(
    [
      b('a1', '他说的话我一般会先想一想再回'),
      b('a2', '他说的话我一般会先想一想再回'),
      b('b', '别人说的话我通常先想一想再回应'),
    ],
    { now: NOW, limit: 5 },
  )
  assert.equal(hits.length, 1)
})

test('缺字段、空文本不会把她带崩', () => {
  assert.deepEqual(detectDifferentiations([], { now: NOW }), [])
  assert.deepEqual(detectDifferentiations([{ id: 'x', text: '   ' }], { now: NOW }), [])
  assert.deepEqual(detectDifferentiations([{ id: 'x', text: '有四个字了' }], { now: NOW }), [])
})

test('只看最近 pool 条：判断一多，不把整本账两两比一遍', () => {
  // 一对能配上的旧话排在更早的位置，前面 61 条互不相干（同一句说两遍的相似度 1.0，本就不算「两面」）。
  const topics = ['雨下了一整天', '买了两斤橘子回来', '电脑又蓝屏了一次', '楼下的猫生小猫了', '把旧照片翻出来看', '电费单子到了']
  const filler = Array.from({ length: 61 }, (_, i) => b(`f${i}`, topics[i % topics.length]))
  const pair = [
    b('a', '他说的话我一般会先想一想再回', 2),
    b('b', '别人说的话我通常先想一想再回应', 2),
  ]
  // 默认池子 60 条：那两句被更近的 61 条挤出去，宁可不问，也不让醒来那条路卡 30 秒。
  assert.equal(detectDifferentiations([...filler, ...pair], { now: NOW }).length, 0)
  // 池子放大就照旧找得到——阈值没变，只是候选变少。
  const wide = detectDifferentiations([...filler, ...pair], { now: NOW, pool: 100, limit: 5 })
  assert.ok(wide.some((h) => [h.a.id, h.b.id].sort().join() === 'a,b'))
})

test('pool 小到 2 也认得出一对，不会因为夹了 1 就退化成空', () => {
  const hits = detectDifferentiations(
    [b('a', '他说的话我一般会先想一想再回'), b('b', '别人说的话我通常先想一想再回应')],
    { now: NOW, pool: 1 },
  )
  assert.equal(hits.length, 1)
})
