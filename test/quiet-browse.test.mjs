/**
 * quiet-browse.test.mjs —— 2026-11-07（用户 m00365）恢复自动刷之后的那一层
 *
 * 这一层守的是「自动刷不再挂在叫醒上」之后最容易坏掉的四处：
 *   1. 两扇门：配置里的自动刷开关、每天几次，关着就一步都不走
 *   2. 节奏：一天几次要摊开，不能一进时段就一口气刷完
 *   3. 记账：只取、只记 `browse:`，不动会话、不叫醒
 *   4. 便条：醒来只带一行「最近又翻到了什么」，多了不带
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
import { pendingGlances } from '../lib/whatseen.js'
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
  assert.match(line, /bili_watch/)
  assert.doesNotMatch(line, /自己点开/, '她手上没有界面，别用「点开」指代她的动作')
})

// 2026-11-11（用户反馈）：便条改成跨天的队列，就不好再说「今天」——前一晚刷到的也算在里面。
// 也不再按「上次醒来之后」切时间段：同一个口径两套说法，难念准。

test('browseDigestLine：只说「最近」，条数一多只说大概', () => {
  const items = Array.from({ length: 24 }, (_, i) => ({ bvid: `BV${i}`, title: `第${i}条` }))
  const line = browseDigestLine(items)
  assert.match(line, /^最近你自己又翻到了/)
  assert.match(line, /二十多条/)
  assert.doesNotMatch(line, /24 条/)
  assert.doesNotMatch(line, /今天/, '跨天攒的，说「今天」会撒谎')

  assert.equal(countPhrase(0), '0 条')
  assert.equal(countPhrase(4), '4 条')
  assert.equal(countPhrase(10), '10 条')
  assert.equal(countPhrase(11), '十几条')
  assert.equal(countPhrase(19), '十几条')
  assert.equal(countPhrase(20), '二十多条')
  assert.equal(countPhrase(45), '四十多条')
  assert.equal(countPhrase(80), '八十多条')
})

// ---------------------------------------------------------------- 便条是个队列，不是一段窗口

test('pendingGlances：跨天的照样排着；念过的划掉；看过的画面不再当「只是翻到过」', () => {
  const now = Date.parse('2026-11-11T09:00:00+08:00')
  const at = (h) => new Date(now - h * 3600_000).toISOString()
  const events = [
    // 前天晚上刷到的：旧口径按「今天」算会整个丢掉，现在要留着
    { type: 'meta', ts: at(36), text: `browse:2026-11-09 [{"bvid":"BV1aaaaaaaaa","title":"前天翻的"}]` },
    // 昨夜刷到的第二批，其中一条昨天已经念过了
    { type: 'meta', ts: at(12), text: `browse:2026-11-10 [{"bvid":"BV2bbbbbbbbb","title":"念过的"},{"bvid":"BV3ccccccccc","title":"没念过的"}]` },
    { type: 'meta', ts: at(6), text: `digest:2026-11-10 BV2bbbbbbbbb` },
    // 她自己点名点开的那条也算
    { type: 'meta', ts: at(3), text: `look:2026-11-11 BV4ddddddddd {"title":"她点开的"}` },
    // 已经看过画面的，不该再当「只是翻到过」
    { type: 'meta', ts: at(2), text: `watched:2026-11-11 BV3ccccccccc` },
  ]
  const got = pendingGlances(events, { now }).map((x) => x.bvid)
  assert.deepEqual(got, ['BV1aaaaaaaaa', 'BV4ddddddddd'])

  // 七天之内的都在，七年前的不要
  const old = [{ type: 'meta', ts: new Date(now - 8 * 86_400_000).toISOString(), text: 'browse:2026-11-03 [{"bvid":"BV5eeeeeeeee"}]' }]
  assert.deepEqual(pendingGlances(old, { now }).map((x) => x.bvid), [])
})

test('pendingGlances：念不完的留着，下一次醒来接着排（不因为「上次醒来太早」被滤掉）', () => {
  const now = Date.parse('2026-11-11T21:00:00+08:00')
  const at = (h) => new Date(now - h * 3600_000).toISOString()
  const batch = JSON.stringify([
    { bvid: 'BVaaaaaaaaaa', title: '一号' },
    { bvid: 'BVbbbbbbbbbb', title: '二号' },
    { bvid: 'BVcccccccccc', title: '三号' },
    { bvid: 'BVdddddddddd', title: '四号' },
    { bvid: 'BVeeeeeeeeee', title: '五号' },
  ])
  const events = [
    { type: 'meta', ts: at(5), text: `browse:2026-11-11 ${batch}` },
    // 上一次醒来念了前三条
    { type: 'meta', ts: at(4), text: 'digest:2026-11-11 BVaaaaaaaaaa BVbbbbbbbbbb BVcccccccccc' },
  ]
  const got = pendingGlances(events, { now }).map((x) => [x.bvid, x.title])
  assert.deepEqual(got, [['BVdddddddddd', '四号'], ['BVeeeeeeeeee', '五号']], '剩下两条还在队列里')
})
