import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveSelf, DAY_MS } from '../lib/derive.js'
import { buildSections } from '../lib/persona.js'
import { searchEvents, renderRecall } from '../lib/recall.js'
import { seenBvids, metaTitle } from '../lib/browse.js'

// 0.9.7 T1/T2/T3：
//   T1 身份段末尾摆一句她自己说过、但没认领的话（最多 1 条、21 天内、有开关）
//   T2 `looked:` 记账带标题
//   T3 她看过的那条能被 her_recall 翻到，且读成人话

const NOW = Date.parse('2026-11-09T12:00:00Z')
const ago = (n) => new Date(NOW - n * DAY_MS).toISOString()
const NL = String.fromCharCode(10)

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
    ...over,
  }
}

const textOf = (m, o = {}) => buildSections(m, { shown: 3, ...o }).map((s) => s.text).join(NL)
const HEAD = '## 你最近说过的几句话'

test('回声段：只摆一句，摆最近的那句', () => {
  const text = textOf(model({
    looseSaid: [
      { id: 'ev_a', at: ago(9), text: '我觉得被算法推着看东西，和在菜市场被人塞传单差不多。', refs: ['ev_1'] },
      { id: 'ev_b', at: ago(3), text: '有些话说出来就是为了让人反驳的。', refs: ['ev_2'] },
    ],
  }), { now: NOW })
  assert.ok(text.includes(HEAD), '有料就摆这一节')
  assert.ok(text.includes('「有些话说出来就是为了让人反驳的。」'))
  assert.ok(!text.includes('菜市场'), '一次只摆一条，不能变成语录墙')
})

test('回声段：超过 21 天的不摆——那是旧账，不是「最近说过」', () => {
  const text = textOf(model({
    looseSaid: [{ id: 'ev_a', at: ago(22), text: '这句话已经放了三个星期。', refs: ['ev_1'] }],
  }), { now: NOW })
  assert.ok(!text.includes(HEAD))
})

test('回声段：关掉开关就整段消失，事件流里的话不受影响', () => {
  const m = model({ looseSaid: [{ id: 'ev_a', at: ago(2), text: '关掉以后这句话不该出现。', refs: ['ev_1'] }] })
  const on = textOf(m, { now: NOW, echo: true })
  const off = textOf(m, { now: NOW, echo: false })
  assert.ok(on.includes('关掉以后这句话不该出现。'))
  assert.ok(!off.includes(HEAD))
})

test('回声段：复述式的开头不进来（「我看了…」不是她自己的想法）', () => {
  const text = textOf(model({
    looseSaid: [{ id: 'ev_a', at: ago(2), text: '我看了这条视频，讲了算法怎么推荐内容。', refs: ['ev_1'] }],
  }), { now: NOW })
  assert.ok(!text.includes(HEAD))
})

test('derive：只有带来源的未认领的话进回声池', () => {
  const evs = [
    {
      id: 'ev_1', ts: ago(5), day: 5, stage: 1, type: 'utterance', source: 'system',
      text: '这句带了来源。', refs: ['ev_x'], verdict: null, confidence: 0.5,
      flags: ['uncommitted', 'anchored'],
    },
    {
      id: 'ev_2', ts: ago(4), day: 6, stage: 1, type: 'utterance', source: 'system',
      text: '这句没带来源。', refs: [], verdict: null, confidence: 0.5,
      flags: ['uncommitted'],
    },
  ]
  const m = deriveSelf(evs, { now: NOW })
  assert.deepEqual(m.looseSaid.map((x) => x.text), ['这句带了来源。'])
})

test('回忆里翻得到她看过的那条，读得出来是「看过」不是一串编号', () => {
  const evs = [{ id: 'ev_l', type: 'meta', text: 'looked:BV1xx411c7mD 一条讲算法推荐的视频', ts: ago(2) }]
  const { rows } = searchEvents(evs, '算法推荐', { now: NOW })
  assert.equal(rows.length, 1)
  const txt = renderRecall(rows)
  assert.ok(txt.includes('你那天看过：《一条讲算法推荐的视频》'))
  assert.ok(!txt.includes('BV1xx411c7mD'), '编号不念给她听')
})

test('没标题的 looked: 与安静刷的 browsed: 都不进回忆', () => {
  const evs = [
    { id: 'ev_a', type: 'meta', text: 'looked:BV1xx411c7mD', ts: ago(2) },
    { id: 'ev_b', type: 'meta', text: 'browsed:BV1yy411c7mD 算法推荐', ts: ago(2) },
  ]
  assert.equal(searchEvents(evs, '算法推荐', { now: NOW }).rows.length, 0)
})

test('seenBvids：带标题的 looked 行仍只按 bvid 去重', () => {
  const s = seenBvids([{ type: 'meta', text: 'looked:BV1 标题 里有空格', ts: ago(1) }], { now: NOW })
  assert.deepEqual([...s], ['BV1'])
})

test('metaTitle：压成一行、去掉控制字符、最多 80 字', () => {
  assert.equal(metaTitle('  标题\n换行\t制表  '), '标题 换行 制表')
  assert.equal(metaTitle('长'.repeat(200)).length, 80)
  assert.equal(metaTitle(undefined), '')
})

test('回声段：摆出来的话不带「（她主动说）」这个工具旁注', () => {
  const text = textOf(model({
    looseSaid: [{ id: 'ev_a', at: ago(1), text: '（她主动说）我其实不喜欢被叫宝宝。', refs: ['ev_1'] }],
  }), { now: NOW })
  assert.ok(text.includes('「我其实不喜欢被叫宝宝。」'))
  assert.ok(!text.includes('（她主动说）'), '旁注是我们加的标注，不是她的话')
})
