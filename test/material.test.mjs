/**
 * 素材的统一形状与来源分级（0.9.8 / M3）
 *
 * 这一层不产生新内容，只回答三个问题：
 *   这条素材是什么？里面哪几句是原话？哪几句能当证据？
 * 所以测试也只盯这三件事——尤其「原文不改写」。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { GRADE, isDissent, pickDisputes, toMaterial, quotesOf } from '../lib/material.js'
import { absorb, renderItem } from '../lib/browse.js'
import { normalizeConfig } from '../lib/settings.js'

const v = (over = {}) => ({
  bvid: 'BV1xx411c7mD', aid: 1001, title: '一个普通的视频', up: '某UP', mid: 42,
  duration: 600, view: 100000, like: 5000, danmaku: 200, ...over,
})

function fakeClient(over = {}) {
  const calls = []
  const base = {
    view: async () => ({ ok: true, data: { desc: '这是简介', pubdate: 1700000000, cid: 555, aid: 1001, title: '标题', up: '某UP' } }),
    tags: async () => ({ ok: true, data: ['日常'] }),
    replies: async () => ({ ok: true, data: [] }),
    danmaku: async () => ({ ok: true, data: [] }),
  }
  const c = { calls }
  for (const [k, fn] of Object.entries({ ...base, ...over })) {
    c[k] = async (...a) => { calls.push([k, ...a]); return fn(...a) }
  }
  return c
}

test('分级只有三级，且是冻结的', () => {
  assert.deepEqual({ ...GRADE }, { FACT: 1, OPINION: 2, FICTION: 3 })
  assert.ok(Object.isFrozen(GRADE))
  assert.throws(() => { GRADE.FACT = 9 })
})

test('isDissent 只认明确的反对，不认普通转折词', () => {
  assert.equal(isDissent('我不同意这个说法'), true)
  assert.equal(isDissent('其实这里说错了'), true)
  assert.equal(isDissent('这个标题党，夸大太多'), true)
  // 转折词不算反例——不然每条评论都能被选成「不同意见」
  assert.equal(isDissent('但是我觉得还挺好看的'), false)
  assert.equal(isDissent('其实还行'), false)
  assert.equal(isDissent(''), false)
})

test('pickDisputes：按序取、最多两条、同一句不重复', () => {
  const list = [
    { text: '热评一', like: 99 },
    { text: '我不同意，这里说错了', like: 30 },
    { text: '我不同意，这里说错了', like: 30 },
    { text: '这个说法不靠谱', like: 9 },
    { text: '又在夸大', like: 1 },
  ]
  const got = pickDisputes(list, { max: 2 })
  assert.deepEqual(got.map((x) => x.text), ['我不同意，这里说错了', '这个说法不靠谱'])
  assert.equal(pickDisputes([]).length, 0)
})

test('pickDisputes：真的按赞数排，不是照传进来的顺序取', () => {
  // 2026-11-13（issue #135）：传进来的是 B 站热度序（赞数不单调），
  // 注释从 0.9.8 起就说「按点赞降序」，代码却照顺序取。
  const hotOrder = [
    { text: '我不同意这个说法', like: 5 },
    { text: '这不靠谱', like: 300 },
    { text: '其实还行', like: 900 },
  ]
  const got = pickDisputes(hotOrder, { max: 2 })
  assert.deepEqual(got.map((x) => x.text), ['这不靠谱', '我不同意这个说法'])
})

test('toMaterial：一条素材就是 source / key / at / 原话 / 能不能核对', () => {
  const m = toMaterial({
    video: v(), desc: '这是简介', pubdate: 1700000000000,
    tags: ['日常'], comments: [{ text: '热评', like: 9 }],
    disputes: [{ text: '我不同意', like: 3 }],
    danmaku: [{ t: 5, text: '弹幕一句' }],
  })
  assert.equal(m.source, 'bili')
  assert.equal(m.key, 'BV1xx411c7mD')
  assert.equal(m.at, 1700000000000)
  assert.equal(m.title, '一个普通的视频')
  assert.equal(m.canVerify, true)
  assert.ok(m.facts.length >= 4)
  assert.ok(m.quotes.length >= 4)
})

test('toMaterial：事实是 1 级，别人说的话一律 2 级', () => {
  const m = toMaterial({
    video: v(), desc: '这是简介', pubdate: 1700000000000,
    tags: [], comments: [{ text: '热评', like: 9 }],
    disputes: [], danmaku: [{ t: 5, text: '弹幕一句' }],
  })
  for (const f of m.facts) assert.equal(f.grade, GRADE.FACT, `事实被标成别的级：${f.label}`)
  for (const q of m.quotes) assert.equal(q.grade, GRADE.OPINION, `原话被标成别的级：${q.text}`)
  assert.deepEqual(quotesOf(m, GRADE.OPINION).map((q) => q.text).sort(), ['弹幕一句', '热评', '这是简介'].sort())
})

test('toMaterial：引文一个字都不改写（只去首尾空白）', () => {
  // 里面留一个连续两个空格：证明不是「压空白」，只裁两端。
  const desc = '  原文里的空格、标点：都保留，包括「引号」和  123。  '
  const m = toMaterial({ video: v(), desc, tags: [], comments: [], danmaku: [] })
  const q = m.quotes.find((x) => x.kind === 'desc')
  assert.equal(q.text, desc.trim())
  assert.ok(q.text.includes('和  123'))
})

test('toMaterial：没有任何可核对的事实 → canVerify false', () => {
  const m = toMaterial({ video: { bvid: 'BVx', title: 't' }, tags: [], comments: [], danmaku: [] })
  assert.equal(m.canVerify, false)
  assert.deepEqual(m.facts, [])
})

test('absorb：热评按赞取前 N 条，不同意见从后面挑，且多要 6 条', async () => {
  const cfg = normalizeConfig({ browse: { deepRead: 2, danmaku: 0 } })
  const replies = async () => ({
    ok: true,
    data: [
      { text: '热评一', like: 99 },
      { text: '热评二', like: 8 },
      { text: '普通评论甲', like: 5 },
      { text: '我不同意，这里说错了', like: 3 },
      { text: '普通评论乙', like: 1 },
      { text: '这个说法不靠谱', like: 1 },
    ],
  })
  const c = fakeClient({ replies })
  const p = await absorb(c, v(), cfg)
  assert.deepEqual(p.comments.map((x) => x.text), ['热评一', '热评二'])
  assert.deepEqual(p.disputes.map((x) => x.text), ['我不同意，这里说错了', '这个说法不靠谱'])
  const call = c.calls.find((x) => x[0] === 'replies')
  assert.equal(call[2].ps, 8, '要 2 条热评，但请求要 2+6 条才找得到反例')
})

test('absorb：评论里没有反例时 disputes 为空数组，不硬凑', async () => {
  const cfg = normalizeConfig({ browse: { deepRead: 2, danmaku: 0 } })
  const c = fakeClient({ replies: async () => ({ ok: true, data: [{ text: '热评一', like: 9 }, { text: '热评二', like: 8 }] }) })
  const p = await absorb(c, v(), cfg)
  assert.deepEqual(p.disputes, [])
})

test('renderItem：简介标明是 UP 主自己写的，不同意见单独一行', () => {
  const s = renderItem({
    video: v({ title: '标题', duration: 125 }), desc: '简介文字', pubdate: 1700000000000,
    tags: ['标签A'], comments: [{ text: '热评', like: 9 }],
    disputes: [{ text: '我不同意这个说法', like: 3 }],
    danmaku: [{ t: 65, text: '弹幕' }],
  }, 0)
  assert.match(s, /简介（UP 主自己写的）：简介文字/)
  assert.match(s, /\[评论 9 赞\] 热评/)
  assert.match(s, /\[不同意见 3\] 我不同意这个说法/)
  for (const w of ['好看', '推荐', '值得', '有意思']) assert.ok(!s.includes(w))
})
