/**
 * bili-buvid.test.mjs —— 不签名的接口也要带匿名 buvid3（2026-10-29）。
 *
 * 真机现象：定时刷站的客户端不带 cookie（scheduler 里 `createClient({ log })`），
 * 而 buvid 只在签名接口（ensureMk）之前才去拿。于是 popular / view / tags / reply
 * 这些请求一个 cookie 都没有：列表还能拿到，`/x/web-interface/view` 多半回 -412，
 * 读熔断随即把这一轮剩下的标签、热评、弹幕全关掉，素材只剩标题和播放量。
 * 同一台机器先拿 /x/frontend/finger/spi 的 buvid3 再请求，view/tags/reply/弹幕都正常。
 *
 * 全部用假 fetch，不碰真网络。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createClient, resetRisk } from '../lib/bili.js'

const SPI = { code: 0, data: { b_3: 'BUVID3-TEST', b_4: 'BUVID4-TEST' } }
const VIEW = { code: 0, data: { bvid: 'BV1xx411c7mD', aid: 1, cid: 2, title: 't', owner: { name: 'up' } } }

/** 假 fetch：记下每次请求的 URL 和 cookie 头；spi 的回包可以换成失败 */
function mkFetch({ spi = SPI } = {}) {
  const calls = []
  const f = async (url, init = {}) => {
    const u = String(url)
    calls.push({ url: u, cookie: init.headers?.cookie ?? '' })
    const body = u.includes('/x/frontend/finger/spi') ? spi : VIEW
    if (body instanceof Error) throw body
    const text = JSON.stringify(body)
    return { status: 200, text: async () => text, json: async () => body }
  }
  f.calls = calls
  f.count = (needle) => calls.filter((c) => c.url.includes(needle)).length
  return f
}

const base = (fetchImpl, extra = {}) => ({ fetchImpl, minIntervalMs: 1, jitterMs: 0, ...extra })

test('匿名客户端：不签名的接口先拿 buvid3，再带着它请求', async () => {
  resetRisk()
  const f = mkFetch()
  const c = createClient(base(f))
  const r = await c.view('BV1xx411c7mD')
  assert.equal(r.ok, true)
  assert.equal(f.count('/x/frontend/finger/spi'), 1)
  const view = f.calls.find((x) => x.url.includes('/x/web-interface/view'))
  assert.match(view.cookie, /(?:^|;\s*)buvid3=BUVID3-TEST/)
  // 拿过一次就缓存，后面的请求不再打 spi
  await c.view('BV1xx411c7mD')
  assert.equal(f.count('/x/frontend/finger/spi'), 1)
})

test('cookie 里已经有 buvid3：不再另拿一份', async () => {
  resetRisk()
  const f = mkFetch()
  const c = createClient(base(f, { cookie: 'buvid3=MINE; SESSDATA=x' }))
  await c.view('BV1xx411c7mD')
  assert.equal(f.count('/x/frontend/finger/spi'), 0)
  const view = f.calls.find((x) => x.url.includes('/x/web-interface/view'))
  assert.doesNotMatch(view.cookie, /BUVID3-TEST/)
})

test('拿 buvid 失败：请求照发，10 分钟内不再重试 spi（不让请求数翻倍）', async () => {
  resetRisk()
  let t = 1_000_000
  const f = mkFetch({ spi: new Error('network down') })
  const c = createClient(base(f, { now: () => t }))
  assert.equal((await c.view('BV1xx411c7mD')).ok, true)
  assert.equal((await c.view('BV1xx411c7mD')).ok, true)
  assert.equal(f.count('/x/frontend/finger/spi'), 1)
  t += 10 * 60_000 + 1
  await c.view('BV1xx411c7mD')
  assert.equal(f.count('/x/frontend/finger/spi'), 2)
})

test('签名接口不会把同一个 buvid3 发两遍（重复的会被服务端当成匿名设备）', async () => {
  resetRisk()
  const calls = []
  const f = async (url, init = {}) => {
    const u = String(url)
    calls.push({ url: u, cookie: init.headers?.cookie ?? '' })
    const body = u.includes('/x/frontend/finger/spi')
      ? SPI
      : u.includes('/x/web-interface/nav')
        ? {
            code: 0,
            data: {
              wbi_img: {
                img_url: 'https://i0.hdslb.com/bfs/wbi/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png',
                sub_url: 'https://i0.hdslb.com/bfs/wbi/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png',
              },
            },
          }
        : { code: 0, data: { subtitle: { subtitles: [] } } }
    const text = JSON.stringify(body)
    return { status: 200, text: async () => text, json: async () => body }
  }
  const c = createClient(base(f, { cookie: 'buvid3=MINE; buvid4=MY4; SESSDATA=x' }))
  await c.subtitle('BV1xx411c7mD', 2)
  const player = calls.find((x) => x.url.includes('/x/player/wbi/v2'))
  assert.equal((String(player.cookie).match(/buvid3=/g) ?? []).length, 1)
  assert.match(player.cookie, /buvid3=MINE/)
  assert.doesNotMatch(player.cookie, /BUVID3-TEST/)
})
