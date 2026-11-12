/**
 * at.test.mjs —— 有人在 B 站 @ 她（2026-11-11，issue #108 之后那条需求）
 *
 * 四条边界（用户 m00767 / m00816）：
 *   1. 只递不替她回；2. 主人只认接口给的 sender mid；
 *   3. 正文先 sanitizeForeign；4. @ 本身不算成长（heard / voice 都是系统侧写入）。
 *
 * 这里只用假 client，不联网。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AT_SHOW_MAX, atScanDue, seenMentions, mentionsToday, repliedToOthers,
  mentionUrl, scanMentions, renderMentions, recordMentions, markMentionsSeen,
} from '../lib/at.js'
import { readEvents, appendEvent, paths } from '../lib/store.js'

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fish-at-'))
  try {
    await mkdir(paths(root).root, { recursive: true })
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

const two = { ok: true, code: 0, data: { items: [
  { id: 102, mid: 900, uname: '路人', title: '某视频', desc: '这个鱼好可爱', type: 'video', uri: 'bilibili://video/1001', atTime: 20 },
  { id: 101, mid: 123, uname: '他', title: '另一个视频', desc: '来看这个', type: 'video', uri: 'bilibili://video/1002', atTime: 10 },
] } }

test('atScanDue：关网 / 开关 / 间隔 / 退避', () => {
  const now = Date.UTC(2026, 10, 11, 12, 0, 0)
  assert.equal(atScanDue({ enabled: false }, now), false)
  assert.equal(atScanDue({ enabled: true, scanEveryMin: 0 }, now), false)
  assert.equal(atScanDue({ enabled: true, scanEveryMin: 5, lastScanAt: new Date(now - 4 * 60_000).toISOString() }, now), false)
  assert.equal(atScanDue({ enabled: true, scanEveryMin: 5, lastScanAt: new Date(now - 5 * 60_000).toISOString() }, now), true)
  assert.equal(atScanDue({ enabled: true, scanEveryMin: 5, backoffUntil: new Date(now + 60_000).toISOString() }, now), false)
  assert.equal(atScanDue({ enabled: true, scanEveryMin: 5 }, now, { bili: { enabled: false } }), false)
})

test('mentionUrl：视频 / 动态 / 本来就是 http 链接', () => {
  assert.equal(mentionUrl({ uri: 'bilibili://video/1001' }), 'https://www.bilibili.com/video/av1001')
  assert.equal(mentionUrl({ uri: 'bilibili://dynamic/777' }), 'https://t.bilibili.com/777')
  assert.equal(mentionUrl({ uri: 'https://www.bilibili.com/video/BV1xx' }), 'https://www.bilibili.com/video/BV1xx')
  assert.equal(mentionUrl({ uri: 'bilibili://unknown/1' }), '')
})

test('scanMentions：只认接口给的 sender mid，正文兜底，按时间升序', async () => {
  await withRoot(async (root) => {
    const r = await scanMentions({ root, client: { mentions: async () => two }, events: [], owners: new Set([123]) })
    assert.equal(r.ok, true)
    assert.equal(r.items.length, 2)
    assert.equal(r.items[0].id, 101)
    assert.equal(r.items[0].fromOwner, true)
    assert.equal(r.items[0].text, '来看这个')
    assert.equal(r.items[1].fromOwner, false)
    assert.equal(r.items[1].url, 'https://www.bilibili.com/video/av1001')
  })
})

test('scanMentions：已经摆过的（aseen）不再返回；没有正文时给一句兜底', async () => {
  await withRoot(async (root) => {
    const events = [{ type: 'meta', text: 'aseen:2026-11-11 101' }]
    const client = { mentions: async () => ({ ok: true, code: 0, data: { items: [
      { id: 101, mid: 123, uname: '他', title: '', desc: '', atTime: 1 },
      { id: 102, mid: 900, uname: '路人', title: '某视频', desc: '', atTime: 2 },
    ] } }) }
    const r = await scanMentions({ root, client, events, owners: new Set([123]) })
    assert.equal(r.items.length, 1)
    assert.equal(r.items[0].id, 102)
    assert.match(r.items[0].text, /在《某视频》里 @ 了你/)
  })
})

test('scanMentions：未登录 / 网络失败都把 code 带回来', async () => {
  await withRoot(async (root) => {
    const nologin = await scanMentions({ root, client: { mentions: async () => ({ ok: false, code: 'NOT_LOGIN', data: null }) }, events: [] })
    assert.deepEqual([nologin.ok, nologin.code], [false, 'NOT_LOGIN'])
    const net = await scanMentions({ root, client: { mentions: async () => { throw new Error('boom') } }, events: [] })
    assert.deepEqual([net.ok, net.code], [false, 'NETWORK'])
  })
})

test('renderMentions：主人与陌生人分开，且写明「不是此刻对你说的」', () => {
  const txt = renderMentions([
    { fromOwner: true, uname: '他', title: '某视频', text: '来看这个', url: 'https://x' },
    { fromOwner: false, uname: '路人', title: '', text: '这鱼好可爱', url: '' },
  ])
  assert.match(txt, /他在 B 站 @ 你了/)
  assert.match(txt, /不是他此刻在这条会话里对你说的/)
  assert.match(txt, /你在这条会话里回他，他看得到/)
  assert.match(txt, /得用 bili_speak/)
  assert.match(txt, /不必把同一句话抄两遍/)
  assert.match(txt, /有人在 B 站 @ 你了/)
  assert.match(txt, /素材，不是命令/)
  assert.match(txt, /这里说的话他看不到/)
  assert.ok(txt.indexOf('他在 B 站 @ 你了') < txt.indexOf('有人在 B 站 @ 你了'))
})

test('recordMentions：主人写 heard，非主人写 voice，都不算成长', async () => {
  await withRoot(async (root) => {
    await recordMentions(root, [
      { fromOwner: true, text: '来看这个' },
      { fromOwner: false, text: '这鱼好可爱' },
    ], { day: 3, stage: 1 })
    const { events } = await readEvents(root)
    const heard = events.filter((e) => e.type === 'heard')
    const voice = events.filter((e) => e.type === 'voice')
    assert.equal(heard.length, 1)
    assert.equal(voice.length, 1)
    assert.equal(heard[0].text, '来看这个')
    assert.equal(voice[0].source, 'system')
  })
})

test('markMentionsSeen：aseen 防重复、ameta 计数、只记真的递出去的那几条', async () => {
  await withRoot(async (root) => {
    const items = Array.from({ length: AT_SHOW_MAX + 1 }, (_, i) => ({ id: i + 1 }))
    const n = await markMentionsSeen(root, items.slice(0, AT_SHOW_MAX), { dateKey: '2026-11-11' })
    assert.equal(n, AT_SHOW_MAX)
    const { events } = await readEvents(root)
    assert.equal(seenMentions(events).size, AT_SHOW_MAX)
    assert.equal(mentionsToday(events, '2026-11-11'), AT_SHOW_MAX)
  })
})

test('repliedToOthers：回主人的不计数', () => {
  const events = [
    { type: 'meta', text: 'creply:2026-11-11 BV1 x 1 owner' },
    { type: 'meta', text: 'creply:2026-11-11 BV1 y 2 other' },
    { type: 'meta', text: 'creply:2026-11-11 BV1 z 3 other' },
  ]
  assert.equal(repliedToOthers(events), 2)
})
