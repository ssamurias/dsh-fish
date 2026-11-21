import test from 'node:test'
import assert from 'node:assert/strict'
import { personaBudget, personaLine } from '../lib/persona.js'
import { anchorSection, recentAnchors, ANCHOR_MAX, ANCHOR_READ_MAX } from '../lib/speechanchor.js'

const NOW = Date.parse('2026-11-13T12:00:00Z')
const DAY = 24 * 60 * 60 * 1000

function model(over = {}) {
  return {
    day: 40,
    stage: 2,
    name: null,
    absenceDays: 0,
    growthDays: 30,
    diaries: 3,
    diaryCount: 3,
    beliefs: [],
    scars: [],
    tensions: [],
    solid: [],
    faded: [],
    refuted: [],
    refusals: [],
    selfmodAttempts: [],
    facts: { hurts: 0 },
    narrative: null,
    recentHeard: [],
    lookedRecent: [],
    ...over,
  }
}

const belief = (id, text, since, extra = {}) => ({
  id,
  text,
  since: new Date(since).toISOString(),
  status: 'active',
  verdict: null,
  confidence: 0.5,
  topic: '',
  ...extra,
})

test('最近能引的素材：只收 7 天内、按时间从新到旧、最多 3 条', () => {
  const m = model({
    recentHeard: [
      { at: NOW - 1 * DAY, text: '我不喜欢被叫宝宝。' },
      { at: NOW - 20 * DAY, text: '太老的，不要。' },
    ],
    beliefs: [
      belief('ev_a', '我觉得评论区那句话放哪都成立。', NOW - 2 * DAY),
      belief('ev_b', '我不同意把「有道理」当回答。', NOW - 30 * DAY),
    ],
    lookedRecent: [{ bvid: 'BV1xx411c7mD', title: '一条视频', at: NOW - 3 * DAY }],
  })
  const got = recentAnchors(m, { now: NOW })
  assert.equal(got.length, ANCHOR_MAX)
  assert.deepEqual(got.map((x) => x.kind), ['heard', 'belief', 'looked'])
  assert.ok(got[0].text.includes('宝宝'))
  assert.ok(!got.some((x) => x.text.includes('太老的')))
})

test('群里说的不算，停下不动的判断不算', () => {
  const m = model({
    recentHeard: [{ at: NOW - DAY, text: '群里那句场面话。', scene: 'group' }],
    beliefs: [belief('ev_c', '我已经改口了。', NOW - DAY, { status: 'refined' })],
  })
  assert.deepEqual(recentAnchors(m, { now: NOW }), [])
})

test('那段话：没有素材时不编，直接说没有', () => {
  const s = anchorSection(model(), { now: NOW })
  assert.match(s, /关于把话说到具体处/)
  assert.match(s, /最近没有能引的东西/)
  assert.match(s, /别编一句来引/)
  assert.match(s, /挂不上就直说「这个我接不上」/)
})

test('那段话：有素材时写进来路和日期，并说明「能用就用」', () => {
  const m = model({
    recentHeard: [{ at: NOW - DAY, text: '我不喜欢被叫宝宝。' }],
    beliefs: [belief('ev_a', '我觉得这句话放哪都成立。', NOW - 2 * DAY)],
    lookedRecent: [{ bvid: 'BV1xx411c7mD', title: '一条视频', at: NOW - 3 * DAY }],
  })
  const s = anchorSection(m, { now: NOW })
  assert.match(s, /说过：「我不喜欢被叫宝宝。」/)
  // 1.0.7（issue #165）：判断单独一档，不再和 heard 挤同一个池子。
  assert.match(s, /你自己认领过的：/)
  assert.match(s, /「我觉得这句话放哪都成立。」/)
  assert.match(s, /你看过：《一条视频》/)
  assert.match(s, /能用就用，用不上别硬套/)
})

test('issue #165：heard 再多也挤不掉她自己的判断', () => {
  const m = model({
    recentHeard: [
      { at: NOW - 1 * DAY, text: '他说的第一句。' },
      { at: NOW - 2 * DAY, text: '他说的第二句。' },
      { at: NOW - 3 * DAY, text: '他说的第三句。' },
    ],
    beliefs: [belief('ev_a', '我自己站住的一句。', NOW - 5 * DAY)],
  })
  const s = anchorSection(m, { now: NOW })
  assert.match(s, /你自己认领过的：/)
  assert.match(s, /我自己站住的一句/)
  // 「最近能引到的」那一档自己也有上限，不会把整段撑长。
  assert.equal(
    recentAnchors(m, { now: NOW, limit: ANCHOR_READ_MAX, kinds: ['heard', 'looked', 'material'] }).length,
    ANCHOR_READ_MAX,
  )
})

test('issue #165：老判断只要最近还被提起 / 检验，就还能被引', () => {
  const stale = belief('ev_a', '半年前就站住的一句。', NOW - 180 * DAY, { lastTouchedAt: NOW - 2 * DAY })
  const cold = belief('ev_b', '没人再提的那句。', NOW - 120 * DAY)
  const s = anchorSection(model({ beliefs: [stale, cold] }), { now: NOW })
  assert.match(s, /半年前就站住的一句/)
  assert.ok(!s.includes('没人再提的那句'), '过了 90 天没被提起的判断不再摆出来')
})

test('recentAnchors 的 kinds 可选：不传时仍是四类同池、按时间取前 limit 条', () => {
  const m = model({
    recentHeard: [{ at: NOW - DAY, text: '他说的。' }],
    beliefs: [belief('ev_a', '我说的。', NOW - 2 * DAY)],
    lookedRecent: [{ bvid: 'BV1xx411c7mD', title: '一条视频', at: NOW - 3 * DAY }],
  })
  assert.deepEqual(recentAnchors(m, { now: NOW }).map((x) => x.kind), ['heard', 'belief', 'looked'])
  assert.deepEqual(recentAnchors(m, { now: NOW, kinds: ['belief'] }).map((x) => x.kind), ['belief'])
})

test('默认不出这一段；打开才出，且不计入身份段预算', () => {
  const m = model({ beliefs: [belief('ev_a', '我不同意把「有道理」当回答。', NOW - DAY)] })
  const off = personaLine(m, { now: NOW, budget: 600 })
  assert.ok(!off.includes('关于把话说到具体处'))

  const tiny = personaLine(m, { now: NOW, budget: 1, anchor: true })
  const tinyOff = personaLine(m, { now: NOW, budget: 1 })
  assert.ok(tiny.includes('关于把话说到具体处'), '预算再小，这一段也在')
  assert.ok(tiny.length > tinyOff.length)
  // 预算统计的是她自己长出来的那部分，不含这一段。
  const b = personaBudget(m, { now: NOW, budget: 1 })
  assert.ok(b.budget === 1)
})

test('代词跟着设置走（{T} 填成她）', () => {
  const m = model({ recentHeard: [{ at: NOW - DAY, text: '我不喜欢被叫宝宝。' }] })
  const s = personaLine(m, { now: NOW, anchor: true, pronoun: '她' })
  assert.match(s, /她 \d+ 月 \d+ 日说过/)
  assert.ok(!s.includes('{T}'))
})
