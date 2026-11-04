import test from 'node:test'
import assert from 'node:assert/strict'

import { INTEREST_MIN_HITS, hasInterest, interestOf, renderInterest, topicsOf } from '../lib/interest.js'

const DAY = 86_400_000
const NOW = Date.parse('2026-11-05T09:00:00+08:00')
const said = (text, daysAgo = 0) => ({ type: 'utterance', text, ts: NOW - daysAgo * DAY })

test('只认她说的话：主人的、系统的都不算', () => {
  const items = topicsOf([
    { type: 'heard', text: '我在想那只猫到底去过哪里', ts: NOW },
    { type: 'meta', text: '我在想那只猫到底去过哪里', ts: NOW },
  ])
  assert.equal(items.length, 0)
})

test('碎片与整段都不算一个主题', () => {
  const items = topicsOf([said('嗯'), said('我'.repeat(80))])
  assert.equal(items.length, 0)
})

test('同一句反复出现：够两次才算「反复」', () => {
  const once = interestOf([said('我在想那只猫到底去过哪里', 1)], NOW)
  assert.equal(once.length, 0)
  const twice = interestOf([
    said('我在想那只猫到底去过哪里', 3),
    said('我在想那只猫到底去过哪里', 1),
  ], NOW)
  assert.equal(twice.length, 1)
  assert.equal(twice[0].hits, 2)
  assert.equal(INTEREST_MIN_HITS, 2)
})

test('用最近一次的原话当代表，不重复也不丢时间', () => {
  const items = interestOf([
    said('我在想那只猫到底去过哪里', 3),
    said('那只猫到底去过哪里呢', 1),
  ], NOW)
  assert.equal(items.length, 1)
  assert.equal(items[0].text, '那只猫到底去过哪里呢')
})

test('两件事：摆分量更重的那一件', () => {
  const items = interestOf([
    said('我在想那只猫到底去过哪里', 2),
    said('我在想那只猫到底去过哪里', 3),
    said('窗台上那盆花为什么一直不开', 1),
  ], NOW)
  assert.equal(items.length, 1)
  assert.match(items[0].text, /猫/)
})

test('刚提过要打对折：二十四小时内不算新鲜到顶', () => {
  const fresh = interestOf([said('我在想那只猫到底去过哪里', 2), said('我在想那只猫到底去过哪里', 0)], NOW)
  const older = interestOf([said('我在想那只猫到底去过哪里', 5), said('我在想那只猫到底去过哪里', 2)], NOW)
  assert.ok(fresh[0].weight < older[0].weight)
})

test('两周前的老话题：分量随半衰掉下去（但还认得出来）', () => {
  // 注意：最近 24 小时内提过会额外打对折（腻），所以这里用「两天前」当近期样本。
  const recent = interestOf([said('我在想那只猫到底去过哪里', 2), said('我在想那只猫到底去过哪里', 3)], NOW)
  const old = interestOf([said('我在想那只猫到底去过哪里', 25), said('我在想那只猫到底去过哪里', 26)], NOW)
  assert.ok(old[0].weight < recent[0].weight / 2)
})

test('摆到桌上只有一句话，不带分数与次数', () => {
  const items = interestOf([said('我在想那只猫到底去过哪里', 1), said('我在想那只猫到底去过哪里', 2)], NOW)
  const line = renderInterest(items)
  assert.equal(line, '最近你总回到「我在想那只猫到底去过哪里」这件事上。')
  assert.doesNotMatch(line, /\d/)
})

test('没有兴趣时：空串、hasInterest 为假', () => {
  assert.equal(renderInterest([]), '')
  assert.equal(renderInterest(null), '')
  assert.equal(hasInterest([], NOW), false)
  assert.equal(hasInterest([said('我在想那只猫到底去过哪里', 1), said('我在想那只猫到底去过哪里', 2)], NOW), true)
})
