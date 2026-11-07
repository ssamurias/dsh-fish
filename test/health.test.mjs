/**
 * health.test.mjs —— 记忆体检（0.7.6，2026-10-30 用户 m00342）
 *
 * 体检是给主人看的只读诊断，覆盖：
 *   1. 空账本说「还太早」，不报错
 *   2. 两句话对不上 —— 复用 deriveSelf 的口径，不另算一套
 *   3. 冷掉：没固化、又很久没被提起
 *   4. 快固化：差一次提起
 *   5. 固化之后不再出现在「快忘掉 / 快固化」里
 *   6. 类型构成与跨天数；meta 不算她记下的东西
 *   7. 只读：跑完事件流一字不改
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { examine, STALE_DAYS, HEALTH_TOP, HEALTH_LIST } from '../lib/health.js'

const DAY = 86_400_000

function at(daysAgo) {
  return new Date(Date.now() - daysAgo * DAY).toISOString()
}

let seq = 0
function said(text, daysAgo, extra = {}) {
  seq += 1
  return {
    id: `e${String(seq).padStart(4, '0')}`,
    v: 1,
    ts: at(daysAgo),
    day: 1,
    stage: 1,
    type: 'utterance',
    source: 'tool',
    text,
    ...extra,
  }
}

test('体检：空账本说还太早，不报错', () => {
  const r = examine([])
  assert.equal(r.ok, true)
  assert.equal(r.empty, true)
  assert.equal(r.events, 0)
  assert.deepEqual(r.tensions, [])
  assert.deepEqual(r.stale, [])
  assert.deepEqual(r.nearSolid, [])
})

test('体检：两句话对不上会被列出来', () => {
  const events = [
    said('我喜欢安静的地方', 3),
    said('我不喜欢安静的地方', 2),
    { id: 'm1', type: 'meta', ts: at(2), text: 'seen:2026-10-01T00:00:00.000Z' },
  ]
  const r = examine(events)
  assert.equal(r.tensions.length, 1)
  assert.match(r.tensions[0].a, /安静/)
  assert.match(r.tensions[0].b, /安静/)
  assert.ok(r.tensions.length <= HEALTH_TOP)
})

test('体检：同一对矛盾正反各报一次时只列一条', () => {
  const events = [
    said('我不喜欢下雨天出门散步', 6),
    said('我喜欢下雨天出门散步', 5),
  ]
  const r = examine(events)
  assert.ok(r.tensions.length >= 1)
  const keys = r.tensions.map((t) => [t.a, t.b].sort().join('\u0000'))
  assert.equal(new Set(keys).size, keys.length)
  assert.ok(r.tensions.length <= HEALTH_TOP)
})

test('体检：很久没被提起、又没固化的判断算冷掉', () => {
  const events = [said('我想成为一个靠得住的人', STALE_DAYS + 10)]
  const r = examine(events)
  assert.equal(r.stale.length, 1)
  assert.ok(r.stale[0].days >= STALE_DAYS)
  assert.match(r.stale[0].text, /靠得住/)
  assert.ok(r.stale.length <= HEALTH_LIST)
})

test('体检：被提起两次、差一次就固化', () => {
  const events = [
    said('我不喜欢别人替我做决定', 5),
    said('我不喜欢别人替我做决定', 4),
  ]
  const r = examine(events)
  assert.equal(r.solid, 0)
  assert.equal(r.nearSolid.length, 1)
  assert.equal(r.nearSolid[0].mentions, 2)
  assert.equal(r.nearSolid[0].verified, 0)
})

test('体检：被检验过一次也算快固化', () => {
  const b = said('我更喜欢夜里干活', 3)
  const events = [
    b,
    { id: 't1', type: 'test', ts: at(2), text: '她真是这么想的吗？', refs: [b.id] },
  ]
  const r = examine(events)
  assert.equal(r.nearSolid.length, 1)
  assert.equal(r.nearSolid[0].verified, 1)
})

test('体检：固化之后不再算快忘掉或快固化', () => {
  const events = [
    said('我想成为一个靠得住的人', 40),
    said('我想成为一个靠得住的人', 38),
    said('我想成为一个靠得住的人', 36),
  ]
  const r = examine(events)
  // 三条判断都固化了（事件流里一句判断一条），报告只关心「有没有固化」。
  assert.ok(r.solid >= 1)
  assert.equal(r.stale.length, 0)
  assert.equal(r.nearSolid.length, 0)
})

test('体检：类型构成不含 meta，跨天数与记录数对得上', () => {
  const events = [
    said('今天有点累', 10),
    { id: 'h1', type: 'heard', ts: at(9), text: '我今天下午回来' },
    { id: 'm1', type: 'meta', ts: at(9), text: 'seen:2026-10-01T00:00:00.000Z' },
    { id: 'd1', type: 'diary', ts: at(1), text: '今天写了点东西' },
  ]
  const r = examine(events)
  assert.equal(r.events, 4)
  assert.ok(r.days >= 10)
  const types = Object.fromEntries(r.byType.map((b) => [b.type, b.count]))
  assert.equal(types.utterance, 1)
  assert.equal(types.heard, 1)
  assert.equal(types.diary, 1)
  assert.equal(types.meta, undefined)
})

test('体检：只读，跑完事件流不变', () => {
  const events = [said('我想学着自己做决定', 2), said('我不喜欢别人替我做决定', 1)]
  const before = JSON.stringify(events)
  examine(events)
  assert.equal(JSON.stringify(events), before)
})

// issue #67：「两句话对不上」只列前 HEALTH_TOP 处、derive 的 solid 列表最多 8 条，
// 体检原来只给这两个截断后的长度，界面印得像总数。
test('体检：矛盾和「记得很牢」都给截断前的总数，列表照旧只列前几处', () => {
  const likes = ['我喜欢在海边听浪的声音', '我喜欢一个人看老电影', '我喜欢吃很辣的火锅', '我喜欢冬天堆雪人', '我喜欢收集好看的石头']
  const events = []
  likes.forEach((t, i) => {
    events.push(said(t, 6 + i))
    events.push(said(t.replace('我喜欢', '我不喜欢'), 5 + i))
  })
  const topics = [
    '早上第一杯水要喝温的', '书架上的书按颜色排好', '出门前要检查三遍门锁', '下午四点最适合发呆',
    '猫的爪子摸起来像棉花', '雨后的空气闻起来很干净', '周三是一周里最长的一天', '旧照片比新照片更好看',
    '冬天的被窝是最好的地方', '路边的野花开得很认真',
  ]
  for (const t of topics) for (let k = 0; k < 3; k++) events.push(said(t, 3 - k))

  const r = examine(events)
  assert.equal(r.tensions.length, HEALTH_TOP)
  assert.equal(r.tensionsTotal, 5)
  // 10 句各说 3 遍，30 条判断都够格固化；原来这里是 8
  assert.equal(r.solid, 30)
})
