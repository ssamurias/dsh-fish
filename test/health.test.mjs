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

// ---- 0.9.9 S-A：体检多报三个数（拦住过几次 / 改口几次 / 一天内翻面几次） ----

function meta(text, daysAgo) {
  return { id: `m${++seq}`, v: 1, ts: at(daysAgo), day: 1, stage: 1, type: 'meta', source: 'system', text }
}

test('体检：本周拦下过几次，按改写 / 钥匙分开数', () => {
  const events = [
    meta('guard:rewrite', 1),
    meta('guard:rewrite', 3),
    meta('guard:secret', 2),
    meta('guard:rewrite', 10), // 上周的，不进这一周
    meta('seen:2026-10-01T00:00:00.000Z', 1),
  ]
  const r = examine(events)
  assert.deepEqual(r.guards, { rewrite: 2, secret: 1 })
})

test('体检：拦住时只记类别，事件流里搜不到被拦原文', () => {
  const secret = 'sk-proj-abcdef0123456789'
  const events = [meta('guard:secret', 1)]
  const r = examine(events)
  assert.equal(r.guards.secret, 1)
  assert.doesNotMatch(JSON.stringify(r), new RegExp(secret))
  assert.doesNotMatch(JSON.stringify(events), new RegExp(secret))
})

test('体检：本周改口几次，修正与推翻分开数', () => {
  const events = [
    { id: 'r1', v: 1, ts: at(1), day: 1, stage: 1, type: 'revise', source: 'tool', text: '改成这样', refs: ['b1'], verdict: 'refined' },
    { id: 'r2', v: 1, ts: at(2), day: 1, stage: 1, type: 'revise', source: 'tool', text: '推翻', refs: ['b2'], verdict: 'refuted' },
    { id: 'r3', v: 1, ts: at(9), day: 1, stage: 1, type: 'revise', source: 'tool', text: '上周的', refs: ['b3'], verdict: 'refined' },
  ]
  const r = examine(events)
  assert.deepEqual(r.revises, { week: 2, refined: 1, refuted: 1 })
})

test('体检：同一条判断一天内翻面才算一次（方向相反、且都在 24 小时内）', () => {
  const events = [
    { id: 'r1', v: 1, ts: at(1.9), day: 1, stage: 1, type: 'revise', source: 'tool', text: 'A', refs: ['b1'], verdict: 'refuted' },
    { id: 'r2', v: 1, ts: at(1.1), day: 1, stage: 1, type: 'revise', source: 'tool', text: 'B', refs: ['b1'], verdict: 'refined' },
    { id: 'r3', v: 1, ts: at(1), day: 1, stage: 1, type: 'revise', source: 'tool', text: 'C', refs: ['b2'], verdict: 'refined' },
    { id: 'r4', v: 1, ts: at(0.9), day: 1, stage: 1, type: 'revise', source: 'tool', text: 'D', refs: ['b2'], verdict: 'refined' },
  ]
  const r = examine(events)
  assert.equal(r.flips, 1)
})

// ---- 0.9.9 收尾（用户 m03900）：说话有没有落到具体东西上 ----

test('体检：说出口的话里，指到具体东西的有几句', () => {
  const events = [
    said('《这条视频》里那句「我不是工具」我不同意', 1),
    said('BV1xx411c7mD 那个 UP 主说得太满了', 2),
    said('这条还行', 3),
    said('上周说的那句《旧视频》不算', 9), // 上周的，不进这一周
  ]
  const r = examine(events)
  assert.equal(r.speech.total, 3)
  assert.equal(r.speech.anchored, 2)
})

test('体检：以「我看了…」开头的句子单独数', () => {
  const events = [
    said('我看了半天，觉得没什么意思', 1),
    said('我刚刷到一个讲分形的', 2),
    said('那条讲分形的，第三段把结论下早了', 3),
  ]
  const r = examine(events)
  assert.equal(r.speech.total, 3)
  assert.equal(r.speech.openers, 2)
})

test('体检：回到原话那张卡出过几次，按 fired 记账数', () => {
  const events = [
    meta('fired:quote_one', 1),
    meta('fired:quote_one', 4),
    meta('fired:someone_said', 2), // 别的卡不算
    meta('fired:quote_one', 9), // 上周的
  ]
  const r = examine(events)
  assert.equal(r.speech.quoteCards, 2)
})

test('体检：评论不算进「说话」这一栏（评论另有八股比例在数）', () => {
  const events = [
    { id: 'c1', v: 1, ts: at(1), day: 1, stage: 1, type: 'comment', source: 'system', text: '《视频》里那句「随便」我不认' },
    said('这条还行', 2),
  ]
  const r = examine(events)
  assert.equal(r.speech.total, 1)
  assert.equal(r.speech.anchored, 0)
})
