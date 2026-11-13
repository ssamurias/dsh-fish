/**
 * bili-subtitle.test.mjs —— 字幕取不到时，三种「没有」必须分得开（2026-11-13）。
 *
 * 外部反馈 BUG-bili-sub-NO_SUB：1.0.0 上六条视频全报「没取到字幕」，
 * 追查时只看到一句「这条可能本来没有字幕，也可能登录过期了」，看不出接口到底回了什么。
 * 顺着这份报告找到两个实打实的坑：
 *   1. `/x/player/wbi/v2` 的 `subtitle_url` 可能是协议相对的
 *      （`//aisubtitle.hdslb.com/...`，public-clis/bilibili-cli#33 的原样返回）；
 *      旧代码要求 `http` 开头，这种地址被静默跳过 → 轨道明明有，正文一条没拉到。
 *   2. 接口在「未登录/风控没放行」时回 `need_login_subtitle: true` 且 `subtitles: []`，
 *      旧代码把它和「这条本来就没有字幕轨」写成同一句。
 *
 * 全部用假 fetch，不碰真网络。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createClient, resetRisk } from '../lib/bili.js'

const SPI = { code: 0, data: { b_3: 'BUVID3-TEST', b_4: 'BUVID4-TEST' } }
const NAV = {
  code: 0,
  data: {
    isLogin: true,
    wbi_img: {
      img_url: 'https://i0.hdslb.com/bfs/wbi/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png',
      sub_url: 'https://i0.hdslb.com/bfs/wbi/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png',
    },
  },
}
const BODY = { body: [{ from: 1.2, to: 3, content: '这句话' }] }

/**
 * 假 fetch：按 URL 子串路由。`player` 是 /x/player/wbi/v2 的回包，
 * `subFails` 为真时字幕正文拉取直接抛错。
 */
function mkFetch({ player, subFails = false } = {}) {
  const calls = []
  const nextPlayer = () => {
    if (!Array.isArray(player)) return player
    // 给一张队列：第 n 次问字幕接口用第 n 个回包，最后一个用完就一直用它。
    return player.length > 1 ? player.shift() : player[0]
  }
  const f = async (url, init = {}) => {
    const u = String(url)
    calls.push({ url: u, headers: init.headers ?? {} })
    if (u.includes('/x/frontend/finger/spi')) return reply(SPI)
    if (u.includes('/x/web-interface/nav')) return reply(NAV)
    if (u.includes('/x/player/wbi/v2')) return reply(nextPlayer())
    if (u.includes('aisubtitle.hdslb.com') || u.includes('subtitle.bilibili.com')) {
      if (subFails) throw new Error('boom')
      return reply(BODY)
    }
    return reply({ code: 0, data: {} })
  }
  f.calls = calls
  f.find = (needle) => calls.find((c) => c.url.includes(needle))
  f.count = (needle) => calls.filter((c) => c.url.includes(needle)).length
  return f
}

function reply(body) {
  const text = JSON.stringify(body)
  return { status: 200, text: async () => text, json: async () => body }
}

const base = (fetchImpl, extra = {}) => ({ fetchImpl, minIntervalMs: 1, jitterMs: 0, ...extra })

const playerWith = (subtitles, extra = {}) => ({
  code: 0,
  data: { need_login_subtitle: false, subtitle: { subtitles }, ...extra },
})

test('协议相对的字幕地址补成 https 再取，不再当成"没有地址"跳过', async () => {
  resetRisk()
  const f = mkFetch({
    player: playerWith([{ lan: 'ai-zh', subtitle_url: '//aisubtitle.hdslb.com/bfs/subtitle/a.json' }]),
  })
  const c = createClient(base(f))
  const r = await c.subtitle('BV1xx411c7mD', 43549657310)
  assert.equal(r.ok, true)
  assert.deepEqual(r.data, [{ t: 1.2, text: '这句话' }])
  const sub = f.find('aisubtitle.hdslb.com')
  assert.equal(sub.url, 'https://aisubtitle.hdslb.com/bfs/subtitle/a.json')
})

test('字幕与字幕正文都带视频页作 referer（浏览器播放器就是这么发的）', async () => {
  resetRisk()
  const f = mkFetch({
    player: playerWith([{ lan: 'ai-zh', subtitle_url: '//aisubtitle.hdslb.com/bfs/subtitle/a.json' }]),
  })
  const c = createClient(base(f))
  await c.subtitle('BV1xx411c7mD', 43549657310)
  const page = 'https://www.bilibili.com/video/BV1xx411c7mD'
  assert.equal(f.find('/x/player/wbi/v2').headers.referer, page)
  assert.equal(f.find('aisubtitle.hdslb.com').headers.referer, page)
})

test('多条字幕轨时先取中文：接口把 en 排在前面也先读 ai-zh', async () => {
  resetRisk()
  const f = mkFetch({
    player: playerWith([
      { lan: 'en', subtitle_url: '//aisubtitle.hdslb.com/bfs/subtitle/en.json' },
      { lan: 'ai-zh', subtitle_url: '//aisubtitle.hdslb.com/bfs/subtitle/zh.json' },
    ]),
  })
  const c = createClient(base(f))
  const r = await c.subtitle('BV1xx411c7mD', 43549657310)
  assert.equal(r.ok, true)
  assert.match(f.find('aisubtitle.hdslb.com').url, /zh\.json$/)
})

test('轨道为空且接口说要登录：code 是 NEED_LOGIN，不是 NO_SUB', async () => {
  resetRisk()
  const f = mkFetch({ player: playerWith([], { need_login_subtitle: true }) })
  const c = createClient(base(f))
  const r = await c.subtitle('BV1xx411c7mD', 43549657310)
  assert.equal(r.ok, false)
  assert.equal(r.code, 'NEED_LOGIN')
})

test('轨道为空且接口没说要登录：code 是 NO_SUB', async () => {
  resetRisk()
  const f = mkFetch({ player: playerWith([]) })
  const c = createClient(base(f))
  const r = await c.subtitle('BV1xx411c7mD', 43549657310)
  assert.equal(r.ok, false)
  assert.equal(r.code, 'NO_SUB')
  assert.match(r.message, /没有字幕轨/)
})

test('轨道有、正文没拉下来：code 是 SUB_FETCH，并说明有几条轨', async () => {
  resetRisk()
  const f = mkFetch({
    player: playerWith([{ lan: 'ai-zh', subtitle_url: '//aisubtitle.hdslb.com/bfs/subtitle/a.json' }]),
    subFails: true,
  })
  const c = createClient(base(f))
  const r = await c.subtitle('BV1xx411c7mD', 43549657310)
  assert.equal(r.ok, false)
  assert.equal(r.code, 'SUB_FETCH')
  assert.match(r.message, /1 条/)
})

test('带登录凭据却被说"要登录"：换一把 wbi 钥匙重问一次，第二次有轨就照常读', async () => {
  resetRisk()
  const f = mkFetch({
    player: [
      playerWith([], { need_login_subtitle: true }),
      playerWith([{ lan: 'ai-zh', subtitle_url: '//aisubtitle.hdslb.com/bfs/subtitle/a.json' }]),
    ],
  })
  const c = createClient(base(f, { cookie: 'SESSDATA=x; buvid3=U3; buvid4=U4' }))
  const r = await c.subtitle('BV1xx411c7mD', 43549657310)
  assert.equal(r.ok, true)
  assert.equal(f.count('/x/player/wbi/v2'), 2, '只重问一次')
  assert.equal(f.count('/x/web-interface/nav'), 2, '第二次问之前换过钥匙')
})

test('没有登录凭据时不重问（重问也不会突然给）', async () => {
  resetRisk()
  const f = mkFetch({ player: playerWith([], { need_login_subtitle: true }) })
  const c = createClient(base(f))
  const r = await c.subtitle('BV1xx411c7mD', 43549657310)
  assert.equal(r.code, 'NEED_LOGIN')
  assert.equal(f.count('/x/player/wbi/v2'), 1)
})

// ---------------------------------------------------------------------------
// issue #138（2026-11-14）：空列表重问、subtitle_url_v2 兜底、人工轨优先
// ---------------------------------------------------------------------------

test('带凭据、第一次轨道空（偶发）：换钥匙重问一次，第二次有轨就照常读（issue #138）', async () => {
  resetRisk()
  const f = mkFetch({
    player: [
      playerWith([]), // need_login_subtitle 不存在 = 不是登录问题，就是偶发空
      playerWith([{ lan: 'zh-CN', subtitle_url: '//aisubtitle.hdslb.com/bfs/subtitle/cc.json' }]),
    ],
  })
  const c = createClient(base(f, { cookie: 'SESSDATA=x; buvid3=U3; buvid4=U4' }))
  const r = await c.subtitle('BV1xx411c7mD', 43549657310)
  assert.equal(r.ok, true, '偶发空不该被当成「这条没有字幕」')
  assert.equal(f.count('/x/player/wbi/v2'), 2, '只重问一次')
})

test('subtitle_url 取不到时退 subtitle_url_v2（issue #138）', async () => {
  resetRisk()
  const f = mkFetch({
    player: playerWith([{ lan: 'ai-zh', subtitle_url_v2: '//subtitle.bilibili.com/bfs/ai_subtitle/v2.json' }]),
  })
  const c = createClient(base(f))
  const r = await c.subtitle('BV1xx411c7mD', 43549657310)
  assert.equal(r.ok, true)
  assert.ok(f.find('subtitle.bilibili.com'), 'fallback 地址真的去取了')
})

test('人工字幕排在 AI 前面：机器识别的错字不进她引用的原文（issue #138）', async () => {
  resetRisk()
  const f = mkFetch({
    player: playerWith([
      { lan: 'ai-zh', subtitle_url: '//aisubtitle.hdslb.com/bfs/subtitle/ai.json' },
      { lan: 'zh-CN', subtitle_url: '//aisubtitle.hdslb.com/bfs/subtitle/cc.json' },
    ]),
  })
  const c = createClient(base(f))
  const r = await c.subtitle('BV1xx411c7mD', 43549657310)
  assert.equal(r.ok, true)
  assert.match(f.find('aisubtitle.hdslb.com').url, /cc\.json$/, '人工轨优先，AI 轨不再默认先读')
})

