/**
 * look-video.test.mjs —— 「他递来的那一条，她能不能自己打开」（0.6.6）
 *
 * 用户反馈（2026-10-28）：不是平台推的视频她评不了——
 * 以前 bili_look 只有 home/search/related，related 是「接着这条往下看别人的推荐」，
 * 所以平台没推、她也没自己搜到的那条，她永远打不开，也就永远说不了话。
 *
 * 这一层守三件事：
 *   1. what=video 能按 BV 号 / 短链看到**指定那一条**，详情只取一次
 *   2. 黑名单里的那一条不看（看了也不算「看过」）
 *   3. 认不出是哪条就直说，不瞎猜一条塞给她
 *
 * 全部用假 client / 假 fetch，不联网。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { lookOnce, registerLook } from '../lib/look.js'
import { absorb } from '../lib/browse.js'
import { createClient } from '../lib/bili.js'
import { normalizeConfig, dateKey } from '../lib/settings.js'
import { readEvents } from '../lib/store.js'

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fish-lookvideo-'))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

const v = (over = {}) => ({
  bvid: 'BV1xx411c7mD', aid: 1001, title: '一个普通的视频', up: '某UP', mid: 42,
  duration: 600, view: 100000, like: 5000, danmaku: 200, ...over,
})

function fakeClient(over = {}) {
  const calls = []
  const base = {
    view: async (bvid) => ({ ok: true, data: { desc: `简介 ${bvid}`, pubdate: 1700000000, cid: 555, aid: 1001, title: `标题 ${bvid}`, up: '某UP' } }),
    tags: async () => ({ ok: true, data: ['日常', '生活'] }),
    replies: async () => ({ ok: true, data: [{ text: '热评一', like: 99 }] }),
    danmaku: async () => ({ ok: true, data: [{ t: 12, text: '这句是弹幕' }] }),
  }
  const c = { calls }
  for (const [k, fn] of Object.entries({ ...base, ...over })) {
    c[k] = async (...a) => { calls.push([k, ...a]); return fn(...a) }
  }
  return c
}

// ---------------------------------------------------------------- what=video

test('what=video：按 BV 号看指定的那一条，详情只取一次', async () => {
  await withRoot(async (root) => {
    const c = fakeClient()
    const r = await lookOnce({ what: 'video', bvid: v().bvid, root, client: c, cfg: normalizeConfig({}) })

    assert.equal(r.ok, true)
    assert.equal(r.picks.length, 1)
    assert.equal(r.picks[0].bvid, v().bvid)
    assert.match(r.text, /是你自己点名要看的那条/)
    // 详情一次就够：拿到后交给 absorb 复用，不再取第二次
    assert.equal(c.calls.filter((x) => x[0] === 'view').length, 1)

    // 看过要落两笔账：looked（去重）+ look（带日期，评论闸门认这个）
    const { events } = await readEvents(root)
    const texts = events.filter((e) => e.type === 'meta').map((e) => String(e.text ?? ''))
    // 0.9.7 T2：行尾会带上标题（`looked:BV… 标题`），用前缀认。
    assert.ok(texts.some((t) => t.startsWith(`looked:${v().bvid}`)))
    // 2026-11-04（用户 m02464）：look: 现在要把展示信息一起落下来，
    // 否则日报「翻到过什么」里由 look: 来的条目全是「(无标题)」。
    const look = texts.find((t) => t.startsWith(`look:${dateKey()} ${v().bvid}`))
    assert.ok(look, 'look: 这一行必须落下来')
    assert.match(look, /\{"title":/)
    const info = JSON.parse(look.slice(look.indexOf('{')))
    // what=video 这条路上标题来自详情接口（`标题 BV…`），不是列表里那份——
    // 断言成「跟 picks 里给她看的那份一致」比钉死某个字面更稳。
    // 详情接口不带时长/播放量，所以那两个字段允许缺省成 0（展示层会跳过）。
    assert.equal(info.title, r.picks[0].title)
    assert.equal(info.up, r.picks[0].up)
    assert.equal(typeof info.duration, 'number')
    assert.equal(typeof info.view, 'number')
  })
})

test('what=video：黑名单里的那一条不看，也不记账', async () => {
  await withRoot(async (root) => {
    const cfg = normalizeConfig({ avoid: { keywords: ['鬼畜'] } })
    const c = fakeClient({ tags: async () => ({ ok: true, data: ['鬼畜', '音乐'] }) })
    const r = await lookOnce({ what: 'video', bvid: v().bvid, root, client: c, cfg })

    assert.equal(r.ok, false)
    assert.match(r.note, /不想看/)

    const { events } = await readEvents(root)
    const looks = events.filter((e) => String(e.text ?? '').startsWith('look:'))
    assert.equal(looks.length, 0, '被拦住的不算看过，不能拿去评')
  })
})

test('what=video：认不出是哪一条就直说，不瞎猜', async () => {
  await withRoot(async (root) => {
    const c = fakeClient()
    const r = await lookOnce({ what: 'video', bvid: '随便说一句', root, client: c, cfg: normalizeConfig({}) })

    assert.equal(r.ok, false)
    assert.match(r.note, /BV 号/)
    assert.equal(c.calls.length, 0)
  })
})

test('what=video：b23.tv 短链由 client 解开，她不用自己拼', async () => {
  await withRoot(async (root) => {
    const c = fakeClient({
      resolveUrl: async (u) => ({ ok: true, data: { bvid: v().bvid, url: u } }),
    })
    const r = await lookOnce({ what: 'video', bvid: 'https://b23.tv/abc123', root, client: c, cfg: normalizeConfig({}) })

    assert.equal(r.ok, true)
    assert.equal(r.picks[0].bvid, v().bvid)
    assert.deepEqual(c.calls.find((x) => x[0] === 'resolveUrl').slice(1), ['https://b23.tv/abc123'])
  })
})

// ---------------------------------------------------------------- absorb 复用
test('absorb：调用方已经取回详情时不再请求一次', async () => {
  const c = fakeClient()
  const view = {
    ok: true,
    data: { desc: '现成的简介', pubdate: 1700000000, cid: 555, aid: 1001, title: '现成标题', up: '某UP' },
  }
  const p = await absorb(c, { bvid: 'BV0' }, normalizeConfig({ browse: { deepRead: 0, danmaku: 0 } }), { view })

  assert.equal(c.calls.filter((x) => x[0] === 'view').length, 0)
  assert.match(p.desc, /现成的简介/)
  assert.equal(p.video.title, '现成标题')
})

// ---------------------------------------------------------------- resolveUrl
test('resolveUrl：带 BV 的链接不联网；b23 短链跟随跳转取落地地址', async () => {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(String(url))
    return { url: 'https://www.bilibili.com/video/BV1xx411c7mD?p=1', status: 200, text: async () => '' }
  }
  const c = createClient({ fetchImpl, minIntervalMs: 1, jitterMs: 0, random: () => 0 })

  const direct = await c.resolveUrl('https://www.bilibili.com/video/BV1xx411c7mD')
  assert.equal(direct.ok, true)
  assert.equal(direct.data.bvid, 'BV1xx411c7mD')
  assert.equal(calls.length, 0, '链接里已经有 BV 了，不该再发请求')

  const short = await c.resolveUrl('https://b23.tv/abc123')
  assert.equal(short.ok, true)
  assert.equal(short.data.bvid, 'BV1xx411c7mD')
  assert.deepEqual(calls, ['https://b23.tv/abc123'])
})

test('resolveUrl：跟随关了就从正文里抠，抠不到就说不是视频', async () => {
  const c = createClient({
    fetchImpl: async () => ({
      url: 'https://b23.tv/xyz',
      status: 200,
      text: async () => '<html><script>window.__INITIAL_STATE__={"bvid":"BV1xx411c7mD"}</script></html>',
    }),
    minIntervalMs: 1,
    jitterMs: 0,
    random: () => 0,
  })
  const r = await c.resolveUrl('https://b23.tv/xyz')
  assert.equal(r.ok, true)
  assert.equal(r.data.bvid, 'BV1xx411c7mD')

  const c2 = createClient({
    fetchImpl: async () => ({ url: 'https://b23.tv/xyz', status: 200, text: async () => '<html>没有东西</html>' }),
    minIntervalMs: 1,
    jitterMs: 0,
    random: () => 0,
  })
  const bad = await c2.resolveUrl('https://b23.tv/xyz')
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 'NOT_VIDEO')
})

// ---------------------------------------------------------------- issue #16 第二半
// 2026-11-01（用户 m03454）：「看一眼」也不能谁都能替她写。
// 以前 bili_look 不查调用者，同机任何工作区加载这个插件都能写一条 looked:——
// 而看过就是永久判决，按下判决的人不留名字。

function fakeCtx() {
  const tools = []
  return { tools: { register: (t) => { tools.push(t); return { dispose() {} } } }, _tools: tools }
}

const callFrom = (cwd, id = 'session-x') => ({ agent: { session: { id, header: { id, cwd } } } })

test('lookOnce：写下的 looked:/look: 带上是哪条会话让她看的', async () => {
  await withRoot(async (root) => {
    const cfg = normalizeConfig({ browse: { topN: 1, deepRead: 0 } })
    const r = await lookOnce({
      what: 'video',
      bvid: 'BV1xx411c7mD',
      cfg,
      root,
      client: fakeClient(),
      events: [],
      sessionId: 'session-abc',
    })
    assert.equal(r.ok, true, r.note)
    const { events } = await readEvents(root)
    const looked = events.filter((e) => String(e.text ?? '').startsWith('looked:'))
    assert.ok(looked.length >= 1, '看过就要记一条')
    assert.ok(looked.every((e) => e.sessionId === 'session-abc'), '每条都要记是谁看的')
    const look = events.filter((e) => String(e.text ?? '').startsWith('look:'))
    assert.ok(look.length >= 1 && look.every((e) => e.sessionId === 'session-abc'))
  })
})

test('bili_look：不在这个家里的会话调不动它（不写事件、明说原因）', async () => {
  await withRoot(async (root) => {
    const ctx = fakeCtx()
    registerLook(ctx, { root, client: fakeClient(), tenant: { herDir: join(root, 'her'), tenant: { ok: true } } })
    const out = await ctx._tools[0].execute({ what: 'video', bvid: 'BV1xx411c7mD' }, callFrom(tmpdir()))
    assert.equal(out.ok, false)
    assert.match(out.note, /另一个家|没有落盘/, '要给她一句人话，不能静默')
    const { events } = await readEvents(root)
    assert.equal(events.filter((e) => String(e.text ?? '').startsWith('looked:')).length, 0)
  })
})

test('bili_look：她自己那条会话（cwd 在这个家里）能正常看', async () => {
  await withRoot(async (root) => {
    const ctx = fakeCtx()
    registerLook(ctx, { root, client: fakeClient(), tenant: { herDir: join(root, 'her'), tenant: { ok: true } } })
    const out = await ctx._tools[0].execute({ what: 'video', bvid: 'BV1xx411c7mD' }, callFrom(join(root, 'her'), 'session-her'))
    assert.equal(out.ok, true, out.note)
    const { events } = await readEvents(root)
    assert.ok(events.some((e) => String(e.text ?? '').startsWith('looked:') && e.sessionId === 'session-her'))
  })
})

// ------------------- 2026-11-06 用户 m01641：bili_look 也要能看「有人回我吗」 -------------------

test('what=replies：读她自己评论下面的回复，并给出回楼中楼要用的编号', async () => {
  await withRoot(async (root) => {
    const dk = dateKey()
    const { appendEvent, paths } = await import('../lib/store.js')
    await appendEvent({ type: 'meta', text: `comment:${dk} BV1xx411c7mD 111` }, { day: 1, stage: 1, source: 'system' }, root)
    await (await import('node:fs/promises')).writeFile(paths(root).owner, JSON.stringify({ mid: 9 }), 'utf8')

    const c = fakeClient({
      subReplies: async () => ({
        ok: true,
        data: [{ rpid: 222, mid: 7, user: '路人甲', text: '这句话我不同意', ctime: 5 }],
      }),
    })
    const r = await lookOnce({ what: 'replies', root, client: c, cfg: normalizeConfig({}) })
    assert.equal(r.ok, true, r.note)
    assert.match(r.text, /路人甲/)
    assert.match(r.text, /这句话我不同意/)
    assert.match(r.text, /reply=222/)
    assert.match(r.text, /parent=111/)
    assert.deepEqual(r.picks, [{ bvid: 'BV1xx411c7mD', rpid: 222, rootRpid: 111 }])
    // 只是看，不能因此把视频记成「看过了」（那会影响她能不能评论）
    const { events } = await readEvents(root)
    assert.equal(events.filter((e) => String(e.text ?? '').startsWith('looked:')).length, 0)
  })
})

test('what=replies：没发过评论时说「没发过评论」，不编一个 -412', async () => {
  await withRoot(async (root) => {
    const r = await lookOnce({ what: 'replies', root, client: fakeClient(), cfg: normalizeConfig({}), events: [] })
    assert.equal(r.ok, false)
    // 2026-11-13（issue #136 B）：原来这里不分青红皂白缀一句 -412，日志里一次都没有。
    assert.match(r.note, /没在 B 站发过评论/)
    assert.doesNotMatch(r.note, /-412/)
    assert.deepEqual(r.picks, [])
  })
})

test('what=replies：发过评论但下面没人说话，就直说没人回', async () => {
  await withRoot(async (root) => {
    const dk = dateKey()
    const { appendEvent } = await import('../lib/store.js')
    await appendEvent({ type: 'meta', text: `comment:${dk} BV1xx411c7mD 111` }, { day: 1, stage: 1, source: 'system' }, root)
    const c = fakeClient({ subReplies: async () => ({ ok: true, data: [] }) })
    const r = await lookOnce({ what: 'replies', root, client: c, cfg: normalizeConfig({}) })
    assert.equal(r.ok, false)
    assert.match(r.note, /还没有人说话/)
    assert.doesNotMatch(r.note, /-412/)
  })
})

test('what=replies：分不清时不硬说「没人回」，直说这次没查成', async () => {
  await withRoot(async (root) => {
    const dk = dateKey()
    const { appendEvent } = await import('../lib/store.js')
    await appendEvent({ type: 'meta', text: `comment:${dk} BV1xx411c7mD 111` }, { day: 1, stage: 1, source: 'system' }, root)
    // 详情拿不到 aid → 这条根本没查成
    const c = fakeClient({ view: async () => ({ ok: false, code: -404, data: null }) })
    const r = await lookOnce({ what: 'replies', root, client: c, cfg: normalizeConfig({}) })
    assert.equal(r.ok, false)
    assert.match(r.note, /分不清/)
    assert.doesNotMatch(r.note, /还没有人说话/)
  })
})

test('what=replies：真被风控回 -412 时才提 -412', async () => {
  await withRoot(async (root) => {
    const dk = dateKey()
    const { appendEvent } = await import('../lib/store.js')
    await appendEvent({ type: 'meta', text: `comment:${dk} BV1xx411c7mD 111` }, { day: 1, stage: 1, source: 'system' }, root)
    const c = fakeClient({ subReplies: async () => ({ ok: false, code: -412, message: '风控校验失败' }) })
    const r = await lookOnce({ what: 'replies', root, client: c, cfg: normalizeConfig({}) })
    assert.equal(r.ok, false)
    assert.match(r.note, /-412/)
  })
})
