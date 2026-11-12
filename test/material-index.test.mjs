// 素材索引（1.0.0，用户 m05089）
//
// 只记原话：她看过的视频里，最多三句「谁说的、哪一句」。
// 不记简介全文、不记弹幕、不记整页字幕——正文进事件流会变成第二个素材库。
//
// 验四件事：
//   1. 一行的形状（bvid + {t,d,q}），原话压成一行
//   2. 最多三句
//   3. 同一个 bvid 只记一次
//   4. 回忆里读得成人话、只收 60 天内的

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveSelf, DAY_MS } from '../lib/derive.js'
import { materialIndexLine, indexedMaterialKeys, MAT_PREFIX } from '../lib/material.js'
import { searchEvents, renderRecall } from '../lib/recall.js'

const NOW = Date.parse('2026-11-13T12:00:00Z')
const iso = (ms) => new Date(ms).toISOString()

function pack(o = {}) {
  return {
    video: {
      bvid: o.bvid ?? 'BV1xx411c7mD',
      title: o.title ?? '这条视频说了什么',
      up: '某UP',
      duration: 300,
      view: 1000,
      like: 10,
    },
    desc: o.desc ?? '简介第一句。简介第二句。',
    pubdate: o.pubdate ?? '2026-11-10',
    tags: ['测试'],
    comments: o.comments ?? [
      { text: '我觉得这个说法不对，太绝对了。', like: 20 },
      { text: '有道理。', like: 5 },
    ],
    danmaku: [],
  }
}

test('素材索引：一行只记原话，带标题与日期', () => {
  const line = materialIndexLine(pack(), { date: '2026-11-13' })
  assert.ok(line)
  assert.ok(line.startsWith(`${MAT_PREFIX}BV1xx411c7mD `))
  const payload = JSON.parse(line.slice(line.indexOf(' ') + 1))
  assert.equal(payload.t, '这条视频说了什么')
  assert.equal(payload.d, '2026-11-13')
  assert.ok(Array.isArray(payload.q) && payload.q.length > 0)
  assert.ok(payload.q.every((q) => typeof q.x === 'string' && q.x.length > 0))
  // 原话里不该有换行——事件流一行一条。
  assert.ok(!payload.q.some((q) => q.x.includes('\n')))
})

test('素材索引：最多三句', () => {
  const many = pack({
    comments: [
      { text: '不同意，这个说法太绝对。', like: 9 },
      { text: '反对，数据来源呢。', like: 8 },
      { text: '未必吧，我觉得夸大了。', like: 7 },
      { text: '标题党。', like: 6 },
    ],
  })
  const payload = JSON.parse(materialIndexLine(many).slice(materialIndexLine(many).indexOf(' ') + 1))
  assert.ok(payload.q.length <= 3, `实际 ${payload.q.length} 句`)
})

test('素材索引：同一个 bvid 只记一次', () => {
  const a = materialIndexLine(pack(), { date: '2026-11-13' })
  const b = materialIndexLine(pack({ title: '换了个标题' }), { date: '2026-11-13' })
  const keys = indexedMaterialKeys([
    { type: 'meta', text: a },
    { type: 'meta', text: b },
    { type: 'meta', text: 'looked:BV1xx411c7mD 这条视频说了什么' },
  ])
  assert.equal(keys.size, 1)
  assert.ok(keys.has('BV1xx411c7mD'))
})

test('素材索引：回忆里读成一句人话', () => {
  const line = materialIndexLine(pack(), { date: '2026-11-13' })
  const evs = [{ id: 'ev_mat', type: 'meta', text: line, ts: iso(NOW - DAY_MS), day: 10 }]
  const { rows } = searchEvents(evs, '这条视频说了什么', { now: NOW })
  const text = renderRecall(rows)
  assert.match(text, /看过/)
  assert.match(text, /里面有一句/)
  assert.match(text, /11 月 13 日/)
  // 不能把机器写法直接摆给她。
  assert.doesNotMatch(text, /mat:bili:/)
})

test('素材索引：只收 60 天内的，最多 30 条', () => {
  const lines = []
  for (let i = 0; i < 40; i += 1) {
    lines.push({
      type: 'meta',
      text: materialIndexLine(pack({ bvid: `BV1xx411c7m${String.fromCharCode(65 + (i % 26))}` }), { date: '2026-11-01' }),
      ts: iso(NOW - (i + 1) * DAY_MS),
      day: 10,
    })
  }
  // 太老的那条不算。
  lines.push({ type: 'meta', text: materialIndexLine(pack({ bvid: 'BV1old411c7mD' }), { date: '2026-08-01' }), ts: iso(NOW - 120 * DAY_MS), day: 3 })
  const m = deriveSelf(lines, { now: NOW })
  assert.ok(Array.isArray(m.materials))
  assert.ok(m.materials.length <= 30)
  assert.ok(!m.materials.some((x) => x.key === 'BV1old411c7mD'))
  assert.ok(m.materials.every((x) => Array.isArray(x.quotes) && x.quotes.length > 0))
})
