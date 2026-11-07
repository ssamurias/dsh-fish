/**
 * bili-risk.test.mjs —— issue #5 的回归：风控熔断不该把整台机器关掉。
 *
 * issue #5（服务器/机房 IP）报的是一条链：
 *   一次 -412 → 全局 30 分钟冷却 → 热门、看视频、看画面、写评论全被挡 →
 *   scheduler 又把「COOLDOWN」当成撞墙证据记进持久罚则 → 半天不干活。
 *
 * 这个文件盯住修完之后的四条性质：
 *   1. 读被风控只关读，**写操作不被连坐**；
 *   2. 写被风控只关写，读照常；
 *   3. 冷却很短（60 秒起）且**成功后立刻解除**，不是 30 分钟一刀切；
 *   4. 签名接口的 -412 先当「密钥过期」刷新重试一次，重试成功就不算风控。
 *
 * 全部用假 fetch，不碰真网络（插件零依赖，测试也不该依赖外网）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  createClient,
  resetRisk,
  inCooldown,
  cooldownLeft,
  memoryCooldown,
  setPacing,
  getPacing,
} from '../lib/bili.js'

const WBI = {
  code: 0,
  data: {
    wbi_img: {
      img_url: 'https://i0.hdslb.com/bfs/wbi/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png',
      sub_url: 'https://i0.hdslb.com/bfs/wbi/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png',
    },
  },
}
const SPI = { code: 0, data: { b_3: 'BUVID3-TEST', b_4: 'BUVID4-TEST' } }
const OK_LIST = { code: 0, data: { list: [] } }
const BANNED = { code: -412, message: 'request was banned' }

/**
 * 假 fetch：按 URL 子串路由，命中后按次数顺序取响应（越界一直用最后一条）。
 * 这样「第一次 -412、第二次成功」这种重试场景不用写状态机。
 */
function mkFetch(map) {
  const hits = []
  const counts = new Map()
  const f = async (url) => {
    const u = String(url)
    hits.push(u)
    for (const [needle, spec] of Object.entries(map)) {
      if (!u.includes(needle)) continue
      const n = counts.get(needle) ?? 0
      counts.set(needle, n + 1)
      const seq = Array.isArray(spec) ? spec : [spec]
      const body = seq[Math.min(n, seq.length - 1)]
      const text = JSON.stringify(body)
      return { status: 200, text: async () => text, json: async () => body }
    }
    throw new Error(`unrouted: ${u}`)
  }
  f.hits = hits
  f.count = (needle) => hits.filter((u) => u.includes(needle)).length
  return f
}

const base = (fetchImpl) => ({
  fetchImpl,
  minIntervalMs: 0,
  jitterMs: 0,
  cookie: 'SESSDATA=x; bili_jct=token123',
})

test('读被风控只关读：写操作照常发得出去（issue #5 主诉）', async () => {
  resetRisk()
  const f = mkFetch({
    '/x/web-interface/popular': BANNED,
    '/x/v2/reply/add': { code: 0, data: { rpid: 999 } },
  })
  const c = createClient(base(f))

  const first = await c.popular()
  assert.equal(first.ok, false)
  assert.equal(first.code, -412)
  assert.equal(inCooldown('read'), true, '读被 -412 打过，读该进冷却')

  // 读冷却期间再读：直接拒，不浪费一次请求
  const second = await c.popular()
  assert.equal(second.code, 'COOLDOWN')
  assert.equal(f.count('popular'), 1)

  // 但写操作不该被连坐
  const wrote = await c.replyAdd(123, '看完了，说一句')
  assert.equal(wrote.ok, true, '读冷却不该挡写操作')
  assert.equal(wrote.data.rpid, 999)
  assert.equal(inCooldown('write'), false)

  resetRisk()
})

test('写被风控只关写：读照常', async () => {
  resetRisk()
  const f = mkFetch({
    '/x/v2/reply/add': BANNED,
    '/x/web-interface/popular': OK_LIST,
  })
  const c = createClient(base(f))

  const w = await c.replyAdd(1, '试试')
  assert.equal(w.ok, false)
  assert.equal(inCooldown('write'), true)
  assert.equal(inCooldown('read'), false, '写被拒不该让读也停摆')

  const r = await c.popular()
  assert.equal(r.ok, true, '读操作照常')

  resetRisk()
})

test('读冷却 60 秒起、成功后立刻解除（不是 30 分钟一刀切）', async () => {
  resetRisk()
  let t = 1_700_000_000_000
  const now = () => t
  const f = mkFetch({
    '/x/web-interface/popular': [BANNED, OK_LIST],
  })
  const c = createClient({ ...base(f), now })

  await c.popular()
  const left = cooldownLeft('read', now())
  assert.ok(left > 0 && left <= 60_000, `首次冷却应 ≈60 秒，实际 ${left}ms`)
  assert.equal(inCooldown('read', now()), true)

  // 冷却期内
  t += 59_000
  assert.equal(inCooldown('read', now()), true)

  // 过了冷却：恢复请求；这次成功 → 立刻清零，不需要额外一次「善后请求」
  t += 2_000
  assert.equal(inCooldown('read', now()), false)
  const ok = await c.popular()
  assert.equal(ok.ok, true)
  assert.equal(inCooldown('read', now()), false)
  assert.equal(cooldownLeft('read', now()), 0)

  resetRisk()
})

test('连续复发才翻倍：第二次 -412 冷却比第一次长，但有上限', async () => {
  resetRisk()
  let t = 1_700_000_000_000
  const now = () => t
  const f = mkFetch({ '/x/web-interface/popular': BANNED })
  const c = createClient({ ...base(f), now })

  await c.popular()
  const first = cooldownLeft('read', now())
  t += first + 1 // 等它冷却完
  await c.popular()
  const second = cooldownLeft('read', now())
  assert.ok(second > first, `第二次应更长：${first} → ${second}`)
  assert.ok(second <= 10 * 60_000, '读冷却上限 10 分钟')
  assert.ok(first <= 60_000, '第一次 60 秒')

  resetRisk()
})

test('签名接口 -412 先按「密钥过期」刷新重试一次，成功就不进冷却', async () => {
  resetRisk()
  const f = mkFetch({
    '/x/web-interface/nav': WBI,
    '/x/frontend/finger/spi': SPI,
    '/x/web-interface/search/type': [BANNED, { code: 0, data: { result: [] } }],
  })
  const c = createClient(base(f))

  const r = await c.search('海边日落')
  assert.equal(r.ok, true, '刷新 wbi 后重试应当成功')
  assert.equal(inCooldown('read'), false, '被重试救回来的 -412 不算撞墙')
  assert.equal(f.count('search/type'), 2, '应当重试一次后才放弃')
  assert.ok(f.count('nav') >= 2, '重试前要强制刷新一次 wbi 密钥')

  resetRisk()
})

test('签名接口重试仍 -412 才认作风控', async () => {
  resetRisk()
  const f = mkFetch({
    '/x/web-interface/nav': WBI,
    '/x/frontend/finger/spi': SPI,
    '/x/web-interface/search/type': BANNED,
  })
  const c = createClient(base(f))

  const r = await c.search('海边日落')
  assert.equal(r.ok, false)
  assert.equal(r.code, -412)
  assert.equal(inCooldown('read'), true)

  resetRisk()
})

test('请求间隔可配：setPacing 夹值并在运行时被客户端读到', () => {
  const before = getPacing()
  try {
    setPacing({ minIntervalMs: 2500, jitterMs: 300 })
    assert.deepEqual(getPacing(), { minIntervalMs: 2500, jitterMs: 300 })

    // 低于下限 / 高于上限都夹到边界（和 settings.js 的 LIMITS 一致）
    setPacing({ minIntervalMs: 10, jitterMs: -5 })
    assert.deepEqual(getPacing(), { minIntervalMs: 200, jitterMs: 0 })

    setPacing({ minIntervalMs: 10_000_000, jitterMs: 10_000_000 })
    assert.deepEqual(getPacing(), { minIntervalMs: 120_000, jitterMs: 60_000 })

    // 坏值回默认，不是变成 0（0 = 不限速，最危险的错值）
    setPacing({ minIntervalMs: 'abc', jitterMs: null })
    assert.deepEqual(getPacing(), { minIntervalMs: 800, jitterMs: 500 })
  } finally {
    setPacing(before)
  }
})

test('memoryCooldown：进程内熔断的状态能读出来，给观测台分两层讲（反馈 4）', async () => {
  resetRisk()
  try {
    assert.deepEqual(memoryCooldown(), { readMs: 0, writeMs: 0, readStreak: 0, writeStreak: 0 })
  } finally {
    resetRisk()
  }
})

// issue #67：lastReq / chain 原来是每个客户端自己的。翻视频、查回复、看画面、观测台各 new 一个，
// 彼此不排队：两个客户端能在同一毫秒把请求打出去，新客户端的第一条也不等间隔。
test('请求节奏是整个进程共用的：两个客户端也排同一条队', async () => {
  resetRisk()
  const stamps = []
  const f = async () => {
    stamps.push(Date.now())
    const text = JSON.stringify(OK_LIST)
    return { status: 200, text: async () => text, json: async () => OK_LIST }
  }
  const opts = { fetchImpl: f, minIntervalMs: 150, jitterMs: 0, random: () => 0, cookie: 'buvid3=x' }
  const a = createClient(opts)
  const b = createClient(opts)
  await Promise.all([a.popular(), b.popular(), a.popular(), b.popular()])
  assert.equal(stamps.length, 4)
  for (let i = 1; i < stamps.length; i++) {
    const gap = stamps[i] - stamps[i - 1]
    // setTimeout 偶尔早到一两毫秒，留一点余量；改之前 a、b 的两条是同一毫秒发出的
    assert.ok(gap >= 130, `第 ${i} 和第 ${i + 1} 条请求只隔了 ${gap}ms：${stamps.map((s) => s - stamps[0]).join(', ')}`)
  }
  resetRisk()
})

// 共用之后，上一条可能是另一个时钟的客户端发的（测试注入 now、biliqr 传了 now、系统时间回拨）。
// 算出来的间隔是负的时只等一个间隔，不能照着差值等上一天。
test('请求节奏共用后：上一条来自别的时钟，最多等一个间隔', async () => {
  resetRisk()
  const f = async () => {
    const text = JSON.stringify(OK_LIST)
    return { status: 200, text: async () => text, json: async () => OK_LIST }
  }
  const ahead = createClient({ fetchImpl: f, minIntervalMs: 1, jitterMs: 0, cookie: 'buvid3=x', now: () => Date.now() + 86_400_000 })
  await ahead.popular()
  const normal = createClient({ fetchImpl: f, minIntervalMs: 50, jitterMs: 0, cookie: 'buvid3=x' })
  const t0 = Date.now()
  const r = await Promise.race([
    normal.popular(),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 3000).unref()),
  ])
  assert.notEqual(r, 'timeout', '时钟对不上时不该照着差值等')
  assert.equal(r.ok, true)
  assert.ok(Date.now() - t0 < 2000)
  resetRisk()
})
