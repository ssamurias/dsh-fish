/**
 * quiet-browse.test.mjs —— 2026-11-07（用户 m00365）恢复自动刷之后的那一层
 *
 * 这一层守的是「自动刷不再挂在叫醒上」之后最容易坏掉的四处：
 *   1. 两扇门：配置里的自动刷开关、每天几次，关着就一步都不走
 *   2. 节奏：一天几次要摊开，不能一进时段就一口气刷完
 *   3. 记账：只取、只记 `browse:`，不动会话、不叫醒
 *   4. 便条：醒来只带一行「今天又翻到了什么」，多了不带
 *
 * 全部用假 client，不联网。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { quietBrowse, browseDigestLine, countPhrase } from '../lib/scheduler.js'
import { browseGapMs, lastBrowseAt, itemsFromEvents } from '../lib/browse.js'
import { glancedItems } from '../lib/whatseen.js'
import { normalizeConfig, dateKey } from '../lib/settings.js'
import { readEvents, appendEvent } from '../lib/store.js'

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fish-quiet-'))
  try { return await fn(root) } finally { await rm(root, { recursive: true, force: true }) }
}

const v = (over = {}) => ({
  bvid: 'BVquiet1',
  title: '安静刷的一条',
  up: '某UP',
  duration: 300,
  view: 12345,
  pic: '//i0.hdslb.com/bfs/archive/x.jpg',
  ...over,
})

function fakeClient(over = {}) {
  const base = {
    popular: async () => ({ ok: true, data: [v({ bvid: 'BVq1', title: '安静刷的一条' })] }),
    ranking: async () => ({ ok: true, data: [v({ bvid: 'BVq2', title: '安静刷的二条' })] }),
    precious: async () => ({ ok: true, data: [] }),
    search: async () => ({ ok: true, data: [] }),
    related: async () => ({ ok: true, data: [] }),
    view: async (bvid) => ({ ok: true, data: { desc: `简介 ${bvid}`, pubdate: 1700000000, cid: 555, aid: 1001, title: `标题 ${bvid}`, up: '某UP' } }),
    tags: async () => ({ ok: true, data: ['日常'] }),
    replies: async () => ({ ok: true, data: [] }),
    danmaku: async () => ({ ok: true, data: [] }),
  }
  const c = {}
  for (const [k, fn] of Object.entries({ ...base, ...over })) c[k] = async (...a) => fn(...a)
  return c
}

const cfgOf = (over = {}) => normalizeConfig({
  browse: { enabled: true, perDay: 4, topN: 1, deepRead: 0, danmaku: 0, voices: false, window: ['00:00', '23:59'], ...over },
})

const NOW = new Date('2026-11-07T12:00:00+08:00')
const DK = dateKey(NOW)

// ---------------------------------------------------------------- 两扇门

test('quietBrowse：自动刷关着 → 一步都不走，连 client 都不碰', async () => {
  await withRoot(async (root) => {
    let touched = 0
    const c = fakeClient({ popular: async () => { touched++; return { ok: true, data: [v()] } } })
    const r = await quietBrowse(root, { day: 2, stage: 2 }, cfgOf({ enabled: false }), DK, { client: c, now: NOW, force: true })
    assert.equal(r.ok, false)
    assert.equal(r.picks.length, 0)
    assert.match(r.note, /自动刷没开/)
    assert.equal(touched, 0)
  })
})

test('quietBrowse：今天的次数用完了 → 不刷，也不写 browse 行', async () => {
  await withRoot(async (root) => {
    await appendEvent({ type: 'meta', text: `browse:${DK} []`, ts: NOW.toISOString() }, { day: 2, stage: 2, source: 'system' }, root)
    const r = await quietBrowse(root, { day: 2, stage: 2 }, cfgOf({ perDay: 1 }), DK, { client: fakeClient(), now: NOW })
    assert.equal(r.ok, false)
    assert.match(r.note, /次数用完/)
    const { events } = await readEvents(root)
    assert.equal(itemsFromEvents(events, DK).length, 0)
  })
})

test('quietBrowse：不在上网时段 → 不刷；强行（按钮）时绕过时段', async () => {
  await withRoot(async (root) => {
    const cfg = cfgOf({ window: ['02:00', '03:00'] })
    const blocked = await quietBrowse(root, { day: 2, stage: 2 }, cfg, DK, { client: fakeClient(), now: NOW })
    assert.equal(blocked.ok, false)
    assert.match(blocked.note, /上网时段/)

    const forced = await quietBrowse(root, { day: 2, stage: 2 }, cfg, DK, { client: fakeClient(), now: NOW, force: true })
    assert.equal(forced.ok, true)
    assert.ok(forced.picks.length >= 1)
  })
})

// ---------------------------------------------------------------- 节奏

test('quietBrowse：成功一趟会落 browse 行；紧接着再来一趟会被间隔挡住', async () => {
  await withRoot(async (root) => {
    const cfg = cfgOf({ perDay: 4 })
    const first = await quietBrowse(root, { day: 2, stage: 2 }, cfg, DK, { client: fakeClient(), now: NOW })
    assert.equal(first.ok, true)
    assert.ok(first.picks.length >= 1)

    const { events } = await readEvents(root)
    assert.ok(itemsFromEvents(events, DK).length >= 1)
    assert.ok(events.some((e) => e?.type === 'meta' && String(e.text).startsWith(`browse:${DK} `)))
    assert.ok(lastBrowseAt(events) > 0)

    const second = await quietBrowse(root, { day: 2, stage: 2 }, cfg, DK, { client: fakeClient(), now: NOW })
    assert.equal(second.ok, false)
    assert.match(second.note, /还没到下一趟/)
  })
})

test('browseGapMs：一天几次要摊开；极端值有上下限', () => {
  assert.equal(browseGapMs(1), 12 * 60 * 60_000)
  assert.equal(browseGapMs(4), 3 * 60 * 60_000)
  assert.equal(browseGapMs(24), 30 * 60_000)
  assert.equal(browseGapMs(100), 30 * 60_000)
  assert.equal(browseGapMs(0), 12 * 60 * 60_000)
})

test('quietBrowse：tick 传进来的是毫秒数，也要认（别把时钟悄悄换成「此刻」）', async () => {
  await withRoot(async (root) => {
    const cfg = cfgOf({ window: ['02:00', '03:00'] })
    const r = await quietBrowse(root, { day: 2, stage: 2 }, cfg, DK, { client: fakeClient(), now: NOW.getTime() })
    assert.equal(r.ok, false)
    assert.match(r.note, /上网时段/)
  })
})

// ---------------------------------------------------------------- 便条

test('browseDigestLine：空的不带；最多三条，其余只说「等」；没标题用号', () => {
  assert.equal(browseDigestLine([]), '')
  assert.equal(browseDigestLine([{ title: '' }]), '')

  const line = browseDigestLine([
    { bvid: 'BV1', title: '一号' },
    { bvid: 'BV2', title: '' },
    { bvid: 'BV3', title: '三号' },
    { bvid: 'BV4', title: '四号' },
  ])
  assert.match(line, /翻到了 4 条/)
  assert.match(line, /《一号》/)
  assert.match(line, /BV2/)
  assert.match(line, /《三号》/)
  assert.match(line, /等/)
  assert.doesNotMatch(line, /《四号》/)
  assert.match(line, /自己点开/)
})

// 2026-11-07（用户 m00758）：今天还没醒过才说「今天」；醒过一次就只说这段。

test('browseDigestLine：给了 since 就说「上次醒来之后」，条数一多只说大概', () => {
  const items = Array.from({ length: 24 }, (_, i) => ({ bvid: `BV${i}`, title: `第${i}条` }))
  const fresh = browseDigestLine(items, { since: Date.parse('2026-11-07T09:00:00+08:00') })
  assert.match(fresh, /^上次醒来之后，你自己又翻到了/)
  assert.match(fresh, /二十多条/)
  assert.doesNotMatch(fresh, /24 条/)

  const first = browseDigestLine(items)
  assert.match(first, /^今天你自己又翻到了/)

  assert.equal(countPhrase(0), '0 条')
  assert.equal(countPhrase(4), '4 条')
  assert.equal(countPhrase(10), '10 条')
  assert.equal(countPhrase(11), '十几条')
  assert.equal(countPhrase(19), '十几条')
  assert.equal(countPhrase(20), '二十多条')
  assert.equal(countPhrase(45), '四十多条')
  assert.equal(countPhrase(80), '八十多条')
})

// ---------------------------------------------------------------- 便条只带「上次醒来之后」

test('glancedItems：给了 since 就只算这之后翻的；她自己的 look: 也一样（不让同一行每次都重念）', async () => {
  const early = '2026-11-07T01:00:00+08:00'
  const late = '2026-11-07T09:00:00+08:00'
  const since = Date.parse('2026-11-07T06:00:00+08:00')
  const events = [
    { type: 'meta', ts: early, text: `browse:${DK} [{"bvid":"BVold","title":"早先翻的"}]` },
    { type: 'meta', ts: late, text: `browse:${DK} [{"bvid":"BVnew","title":"刚翻的"}]` },
    { type: 'meta', ts: early, text: `look:${DK} BVown {"title":"她早先点开的"}` },
  ]
  const all = glancedItems(events, DK).map((x) => x.bvid)
  assert.deepEqual(all.sort(), ['BVnew', 'BVold', 'BVown'])

  const fresh = glancedItems(events, DK, { since }).map((x) => x.bvid)
  assert.deepEqual(fresh, ['BVnew'])
})
