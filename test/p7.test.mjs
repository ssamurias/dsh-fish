/**
 * P7：你不在的时候 / 封面图
 *
 * 两件事都是"你回来后能不能接上话"的一部分：
 *   - 你不在的时候：告诉你错过了什么（只报数，日记只报篇数）
 *   - 封面图：她说的那条视频长什么样，一眼认得出来
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { summarizeAway, lastSeenMs, awaySince, readAway } from '../lib/away.js'
import { isBvid, normPic, coverPath, coverLines, coverDir, fetchCover } from '../lib/cover.js'
import { itemsFromEvents, recordBrowse } from '../lib/browse.js'
import { paths } from '../lib/store.js'

const BV1 = 'BV1MN4y177PB'
const BV2 = 'BV1BK411L7DJ'

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fish-p7-'))
}

function ev(type, text, ts) {
  return { type, text, ts, day: 1, stage: 1 }
}

test('away：按「你最后一次露面」之后的事件计数', () => {
  const t0 = Date.parse('2026-10-20T12:00:00Z')
  const day = 86400_000
  const events = [
    ev('meta', 'seen:2026-10-20T12:00:00Z', t0),
    ev('meta', `wake:2026-10-21 why_here`, t0 + day),
    ev('meta', `wake:2026-10-22 why_here`, t0 + 2 * day),
    ev('meta', `browse:2026-10-21 [{"bvid":"${BV1}"},{"bvid":"${BV2}"}]`, t0 + day),
    ev('meta', `browse:2026-10-22 [{"bvid":"${BV1}"}]`, t0 + 2 * day),
    ev('utterance', '我不太确定。', t0 + day),
    ev('utterance', '嗯。', t0 + 2 * day + 1000),
    ev('meta', 'diary:2026-10-21', t0 + day),
  ]
  const r = summarizeAway(events, { now: t0 + 3 * day })
  assert.equal(r.days, 3)
  assert.equal(r.wakes, 2)
  assert.equal(r.videos, 2, '同一条视频跨两天只算一条')
  assert.equal(r.said, 2)
  assert.equal(r.diaries, 1)
  assert.equal(r.quiet, false)
})

test('away：上次聊天的回复（uncommitted）不算她不在时说的话', () => {
  const day = 86400_000
  const t0 = Date.parse('2026-10-20T12:00:00Z')
  const chat = (text, ts) => ({ ...ev('utterance', text, ts), flags: ['uncommitted'] })
  // seen: 在第一句人话时写，uncommitted 要等回合结束，所以它们必然排在 seen 之后。
  const events = [
    ev('meta', 'seen:2026-10-20T12:00:00Z', t0),
    chat('嗯，我在。', t0 + 30_000),
    chat('你说。', t0 + 31_000),
  ]
  const r = summarizeAway(events, { now: t0 + 2 * day })
  assert.equal(r.days, 2)
  assert.equal(r.said, 0)
  assert.equal(r.quiet, true, '她什么也没做，不该出那张卡')

  const claimed = summarizeAway([...events, ev('utterance', '这句她认领了。', t0 + day)], { now: t0 + 2 * day })
  assert.equal(claimed.said, 1, '认领的话照常算')
  assert.equal(claimed.quiet, false)
})

test('away：没有 seen 时从最早一条事件算起', () => {
  const t0 = Date.parse('2026-10-20T12:00:00Z')
  const events = [ev('seed', '你不是助手。', t0), ev('utterance', '诶。', t0 + 1000)]
  assert.equal(lastSeenMs(events), 0)
  assert.equal(awaySince(events), t0)
  const r = summarizeAway(events, { now: t0 + 2 * 86400_000 })
  assert.equal(r.days, 2)
  assert.equal(r.said, 1)
})

test('away：什么都没有时 quiet 为真、不抛', () => {
  const r = summarizeAway([], { now: Date.now() })
  assert.equal(r.quiet, true)
  assert.equal(r.days, 0)
})

test('away：坏掉的 browse 行不会让整张卡片崩', () => {
  const t0 = Date.parse('2026-10-20T12:00:00Z')
  const events = [
    ev('meta', 'seen:2026-10-20T12:00:00Z', t0),
    ev('meta', 'browse:2026-10-21 [{"bvid":', t0 + 1000),
    ev('meta', `browse:2026-10-21 [{"bvid":"${BV1}"}]`, t0 + 2000),
  ]
  const r = summarizeAway(events, { now: t0 + 86400_000 })
  assert.equal(r.videos, 1)
})

test('away：readAway 对不存在的状态库也不抛', async () => {
  const root = path.join(tmpRoot(), 'nope')
  const r = await readAway(root)
  assert.equal(r.quiet, true)
})

test('cover：只认 BV 号，pic 补成 https', () => {
  assert.equal(isBvid(BV1), true)
  assert.equal(isBvid('av123'), false)
  assert.equal(isBvid('BV1'), false)
  assert.equal(normPic('//i0.hdslb.com/bfs/a.jpg'), 'https://i0.hdslb.com/bfs/a.jpg')
  assert.equal(normPic('https://x/a.jpg'), 'https://x/a.jpg')
  assert.equal(normPic(''), '')
  assert.equal(normPic('ftp://x/a.jpg'), '')
})

test('cover：coverLines 只给已经存在的图', () => {
  const root = tmpRoot()
  const picks = [{ bvid: BV1, title: '二舅[上]' }, { bvid: BV2, title: '读书' }]
  assert.deepEqual(coverLines(picks, root), [], '一张都没存时是空的')
  fs.mkdirSync(coverDir(root), { recursive: true })
  fs.writeFileSync(path.join(coverDir(root), `${BV1}.jpg`), Buffer.from([0xff, 0xd8, 0xff]))
  const lines = coverLines(picks, root)
  assert.equal(lines.length, 1)
  assert.match(lines[0], /^!\[二舅上\]\(.*BV1MN4y177PB\.jpg\)$/, '标题里的方括号要去掉')
  // 2026-10-26 用户实测：反斜杠路径在客户端显示「图片无法预览」，正斜杠正常
  assert.ok(!lines[0].includes('\\'), '图片路径不能带反斜杠')
  // 盘符那条断言只能在本机（Windows）成立：CI 的 ubuntu 跑的是 /tmp 临时目录，
  // 没有盘符可比。盘符格式由 test/posix.test.mjs 的 slashed 用例负责。
  if (process.platform === 'win32') {
    assert.match(lines[0], /\([A-Za-z]:\//, 'Windows 下是正斜杠的盘符路径')
  }
  assert.equal(coverPath(root, BV2), '')
})

test('cover：fetchCover 拿不到图时返回空串，不抛', async () => {
  const root = tmpRoot()
  const r = await fetchCover({ root, bvid: BV1, pic: '//x/y.jpg', fetchImpl: async () => { throw new Error('boom') } })
  assert.equal(r, '')
  const r2 = await fetchCover({ root, bvid: BV1, pic: '' })
  assert.equal(r2, '')
})

test('cover：fetchCover 存下来以后第二次直接命中缓存', async () => {
  const root = tmpRoot()
  let calls = 0
  const fake = async () => {
    calls++
    return {
      ok: true,
      headers: { get: (k) => (k === 'content-type' ? 'image/jpeg' : null) },
      arrayBuffer: async () => Buffer.from([1, 2, 3]).buffer,
    }
  }
  const a = await fetchCover({ root, bvid: BV1, pic: '//i0.hdslb.com/a.jpg', fetchImpl: fake })
  assert.ok(a.endsWith(`${BV1}.jpg`))
  const b = await fetchCover({ root, bvid: BV1, pic: '//i0.hdslb.com/a.jpg', fetchImpl: fake })
  assert.equal(a, b)
  assert.equal(calls, 1, '第二次不该再发请求')
})

test('browse：记账里带上封面地址，历史才能配图', async () => {
  const root = tmpRoot()
  await recordBrowse(root, '2026-10-21', [{ bvid: BV1, title: 'x', up: 'y', pic: '//i0/a.jpg' }], { day: 1, stage: 1 })
  const { readEvents } = await import('../lib/store.js')
  const { events } = await readEvents(root)
  const items = itemsFromEvents(events, '2026-10-21')
  assert.equal(items.length, 1)
  assert.equal(items[0].pic, '//i0/a.jpg')
})

test('observe：/away 与 /cover 两条路由都注册了', async () => {
  const { registerObserve } = await import('../lib/observe.js')
  const root = tmpRoot()
  const registered = []
  const webServer = {
    register: (r) => { registered.push(r.path); return () => {} },
  }
  const ctx = {
    get: (k) => (k === 'connection' ? { requestRejection: () => null } : k === 'webServer' ? webServer : null),
    webServer,
    slots: { inject: () => {} },
  }
  registerObserve(ctx, { root })
  assert.ok(registered.includes('/dsh-fish/away'), '/away 要注册')
  assert.ok(registered.includes('/dsh-fish/cover'), '/cover 要注册')
})

test('observe：/update 路由注册了，且把版本号带给了客户端', async () => {
  // 「检查更新」是 2026-10-25 用户要求的：插件从 GitHub 装回来后没人提醒有新版本。
  // 这里只钉住"路由存在 + 版本号能传到前端"，真正联网的行为靠人手点一次验证。
  const { registerObserve } = await import('../lib/observe.js')
  const root = tmpRoot()
  const registered = []
  const webServer = { register: (r) => { registered.push(r.path); return () => {} } }
  const ctx = {
    get: (k) => (k === 'connection' ? { requestRejection: () => null } : k === 'webServer' ? webServer : null),
    webServer,
    slots: { inject: () => {} },
  }
  registerObserve(ctx, { root, version: 'v0.3.0' })
  assert.ok(registered.includes('/dsh-fish/update'), '/update 要注册')
  // 版本号要在 /state 的 meta 里（前端「当前版本」那行读的就是它）
  const src = fs.readFileSync(new URL('../lib/observe.js', import.meta.url), 'utf8')
  assert.ok(/meta:\s*\{[^}]*version:/.test(src), '/state 的 meta 里要有 version')
})

test('封面目录跟着状态库走（重开也不删）', () => {
  const root = tmpRoot()
  assert.equal(coverDir(root), path.join(paths(root).outDir, 'covers'))
})
