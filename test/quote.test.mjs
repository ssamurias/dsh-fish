import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveSelf, DAY_MS } from '../lib/derive.js'
import { findTemplate } from '../lib/events.js'

// 0.9.8 的收尾两张卡：
//   quote_one  回到看过的那一条，抄一句原话（鱼八股 g5 后半）
//   look_back  改口之后，回头看当初那个自己（L5 的完整形态）

const NOW = Date.parse('2026-11-10T12:00:00Z')
const ago = (n) => NOW - n * DAY_MS

const looked = (bvid, title, daysAgo, id) => ({
  id: id ?? `ev_${bvid}`,
  type: 'meta',
  text: title ? `looked:${bvid} ${title}` : `looked:${bvid}`,
  ts: ago(daysAgo),
  day: 40,
})

test('lookedRecent：只收带标题的，没标题的旧记录不进', () => {
  const m = deriveSelf([looked('BV1aa', '一个标题', 2)], { now: NOW })
  assert.equal(m.lookedRecent.length, 1)
  assert.equal(m.lookedRecent[0].bvid, 'BV1aa')
  assert.equal(m.lookedRecent[0].title, '一个标题')

  const bare = deriveSelf([looked('BV1bb', '', 2)], { now: NOW })
  assert.deepEqual(bare.lookedRecent, [])
})

test('lookedRecent：同一个 bvid 只留最近一次，按时间从早到晚排', () => {
  const m = deriveSelf(
    [
      looked('BV1aa', '旧标题', 5, 'ev_a1'),
      looked('BV1bb', '第二条', 3, 'ev_b1'),
      looked('BV1aa', '新标题', 1, 'ev_a2'),
    ],
    { now: NOW },
  )
  assert.deepEqual(
    m.lookedRecent.map((v) => `${v.bvid}:${v.title}`),
    ['BV1bb:第二条', 'BV1aa:新标题'],
  )
})

test('quote_one：没看过带标题的东西时永远不出', () => {
  const t = findTemplate('quote_one')
  assert.ok(t, 'quote_one 必须登记在 CATALOG 里')
  assert.equal(t.cond({ lookedRecent: [] }), false)
  assert.equal(t.cond({}), false)
  assert.equal(t.cond({ lookedRecent: [{ bvid: 'BV1aa', title: 'x' }] }), true)
})

test('quote_one：提示词带着那一条的标题，要求抄原话、一字不改', () => {
  const t = findTemplate('quote_one')
  const text = t.prompt({ lookedRecent: [{ bvid: 'BV1aa', title: '为什么我不推荐这个' }, { bvid: 'BV1bb', title: '最后一条' }] })
  assert.match(text, /最后一条/)
  assert.match(text, /原话/)
  assert.match(text, /一个字都不用改/)
  // 允许「没有」：不许把「必须不同意」写成硬要求
  assert.match(text, /没有一句让你不同意/)
})

test('look_back：没改过口时永远不出', () => {
  const t = findTemplate('look_back')
  assert.ok(t, 'look_back 必须登记在 CATALOG 里')
  assert.equal(t.cond({ refuted: [] }), false)
  assert.equal(t.cond({}), false)
})

test('look_back：提示词并排旧话与新话，并问了「当时是哪里没看见」', () => {
  const t = findTemplate('look_back')
  const text = t.prompt({
    refuted: [{ oldText: '我觉得这条视频讲得很透', newText: '其实它只讲了结论，没给证据', at: ago(9) }],
  })
  assert.match(text, /我觉得这条视频讲得很透/)
  assert.match(text, /其实它只讲了结论，没给证据/)
  assert.match(text, /当时是哪里没看见/)
  // 不要求忏悔，也不许她多认：这句必须在
  assert.match(text, /不用给自己找台阶/)
})

test('两张卡都不把「等级」「分数」念给她听', () => {
  for (const id of ['quote_one', 'look_back']) {
    const t = findTemplate(id)
    const text = t.prompt({
      lookedRecent: [{ bvid: 'BV1aa', title: '一条' }],
      refuted: [{ oldText: '旧', newText: '新', at: ago(3) }],
    })
    assert.doesNotMatch(text, /等级|可信度|分数|打分/)
  }
})
