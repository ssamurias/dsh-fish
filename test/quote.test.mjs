import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveSelf, DAY_MS } from '../lib/derive.js'
import { findTemplate, daysAgoOf } from '../lib/events.js'
import { validateEvent } from '../lib/schema.js'

// 0.9.8 的收尾两张卡：
//   quote_one  回到看过的那一条，抄一句原话（鱼八股 g5 后半）
//   look_back  改口之后，回头看当初那个自己（L5 的完整形态）

const NOW = Date.parse('2026-11-10T12:00:00Z')
const ago = (n) => NOW - n * DAY_MS
// 真事件流里的 ts 是 ISO 字符串（validateEvent 写的），夹具照这个形态造；
// 以前这里用毫秒数，Number(ts) 的毛病测不出来。
const iso = (n) => new Date(ago(n)).toISOString()
const CTX = { now: NOW }

const looked = (bvid, title, daysAgo, id) => ({
  id: id ?? `ev_${bvid}`,
  type: 'meta',
  text: title ? `looked:${bvid} ${title}` : `looked:${bvid}`,
  ts: iso(daysAgo),
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
    refuted: [{ oldText: '我觉得这条视频讲得很透', newText: '其实它只讲了结论，没给证据', at: iso(9), oldAt: iso(30) }],
  }, CTX)
  // 天数是旧话的（30 天前说的），不是改口那天的（9 天前）
  assert.match(text, /^你 30 天前说过：/)
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
      refuted: [{ oldText: '旧', newText: '新', at: iso(3), oldAt: iso(8) }],
    }, CTX)
    assert.doesNotMatch(text, /等级|可信度|分数|打分/)
  }
})

// ---------------------------------------------------------------- 哪一天

// 用 validateEvent 造事件：和真事件流同一个形态（ts 是 ISO 字符串）。
const real = (raw, daysAgo, day) => validateEvent(raw, {
  day, stage: 2, now: ago(daysAgo),
  source: ['meta', 'voice', 'seed'].includes(raw.type) ? 'system' : 'tool',
})

function story() {
  const seed = real({ type: 'seed', text: '种子' }, 40, 1)
  const said = real({ type: 'utterance', text: '我觉得这件事很简单。' }, 30, 11)
  const revise = real({ type: 'revise', text: '这件事不简单，后面那一半我当时没看见。', refs: [said.id], verdict: 'refuted' }, 10, 31)
  return [seed, said, revise]
}

test('daysAgoOf：按本地日历日数，毫秒数和 ISO 字符串都认，算不出来是 null', () => {
  const now = new Date(2026, 10, 10, 9, 0).getTime()
  assert.equal(daysAgoOf(new Date(2026, 10, 10, 0, 5).getTime(), now), 0)
  // 昨晚 22:30 到今天 9:00 不到 24 小时，也是昨天
  assert.equal(daysAgoOf(new Date(2026, 10, 9, 22, 30).getTime(), now), 1)
  assert.equal(daysAgoOf(new Date(2026, 10, 7, 23, 59).toISOString(), now), 3)
  // 在未来的不出负数
  assert.equal(daysAgoOf(new Date(2026, 10, 12, 9, 0).getTime(), now), 0)
  for (const bad of [undefined, null, '', 'not-a-date', 0, NaN]) assert.equal(daysAgoOf(bad, now), null)
})

test('look_back：真事件（ISO ts）下写的是旧话那天，不再永远是「1 天前」', () => {
  const events = story()
  assert.equal(typeof events[1].ts, 'string')
  const m = deriveSelf(events, { now: NOW })
  assert.equal(m.refuted.length, 1)
  // 旧话 30 天前说的，10 天前改的口：两个时间都留着
  assert.equal(m.refuted[0].oldAt, events[1].ts)
  assert.equal(m.refuted[0].at, events[2].ts)
  const text = findTemplate('look_back').prompt(m, CTX)
  assert.match(text, /^你 30 天前说过：「我觉得这件事很简单。」/)
})

test('look_back：当天、昨天说的照实写；不知道哪天就不写天数', () => {
  const t = findTemplate('look_back')
  const one = (oldAt) => t.prompt({ refuted: [{ oldText: '旧', newText: '新', at: iso(0), oldAt }] }, CTX)
  assert.match(one(iso(0)), /^你今天说过：/)
  assert.match(one(iso(1)), /^你昨天说过：/)
  assert.match(one(iso(3)), /^你 3 天前说过：/)
  for (const bad of [undefined, 'not-a-date']) {
    const text = one(bad)
    assert.match(text, /^你之前说过：/)
    assert.doesNotMatch(text, /天前/)
  }
})

test('lookedRecent：真事件（ISO ts）下同一个 bvid 留最近一次，最后一条是最近看的', () => {
  const events = [
    real({ type: 'seed', text: '种子' }, 40, 1),
    real({ type: 'meta', text: 'looked:BV1aa 第一条' }, 5, 36),
    real({ type: 'meta', text: 'looked:BV1bb 第二条' }, 3, 38),
    real({ type: 'meta', text: 'looked:BV1aa 第一条' }, 1, 40),
  ]
  const m = deriveSelf(events, { now: NOW })
  assert.deepEqual(m.lookedRecent.map((v) => v.bvid), ['BV1bb', 'BV1aa'])
  assert.equal(m.lookedRecent[1].at, Date.parse(events[3].ts))
  assert.ok(m.lookedRecent.every((v) => v.at > 0), 'at 是毫秒数，不是 0')
  // 卡问的是最近看的那条，而且它是昨天看的
  const text = findTemplate('quote_one').prompt(m, CTX)
  assert.match(text, /^你昨天看过《第一条》/)
})

test('quote_one：几天前看的不说成「今天」', () => {
  const t = findTemplate('quote_one')
  const one = (at) => t.prompt({ lookedRecent: [{ bvid: 'BV1aa', title: '一条', at }] }, CTX)
  assert.match(one(ago(0)), /^你今天看过《一条》/)
  assert.match(one(ago(3)), /^你 3 天前看过《一条》/)
  assert.doesNotMatch(one(ago(3)), /今天/)
  // 没有时间的旧形态：不编日子
  assert.match(one(undefined), /^你之前看过《一条》/)
})

test('someone_said：六天前读到的评论不说成「今天」', () => {
  const events = [
    real({ type: 'seed', text: '种子' }, 40, 1),
    real({ type: 'voice', text: '这个视频其实把因果讲反了。', refs: ['BV1cc'] }, 6, 35),
  ]
  const m = deriveSelf(events, { now: NOW })
  assert.ok(m.freshVoice, '7 天内还没认下的那条照旧摆着')
  const t = findTemplate('someone_said')
  assert.equal(t.cond(m), true)
  const text = t.prompt(m, CTX)
  assert.match(text, /^你 6 天前在评论区读到一个人写：「这个视频其实把因果讲反了。」/)
  assert.doesNotMatch(text, /今天/)

  const today = deriveSelf([events[0], real({ type: 'voice', text: '这个视频其实把因果讲反了。', refs: ['BV1cc'] }, 0, 41)], { now: NOW })
  assert.match(t.prompt(today, CTX), /^你今天在评论区读到一个人写：/)
})

test('someone_said：评论没带时间时按成长日的差写，两样都没有就只说「之前」', () => {
  const t = findTemplate('someone_said')
  assert.match(t.prompt({ day: 21, freshVoice: { text: '一句话', day: 19 } }, CTX), /^你 2 天前在评论区读到/)
  assert.match(t.prompt({ freshVoice: { text: '一句话' } }, CTX), /^你之前在评论区读到/)
})
