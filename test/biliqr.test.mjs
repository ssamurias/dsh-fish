/**
 * biliqr.test.mjs —— 2026-11-01 扫码登录（宿主侧）
 *
 * 守的是三件比功能更要紧的事：
 *   1. **cookie 不上行**：任何一步返回给页面的东西里都不许出现 SESSDATA 原文。
 *   2. **确认才写盘**：轮询到"登录成功"只把 cookie 攥在内存里，save 才是那一下。
 *   3. **过期不认**：180 秒之后既不再轮询、也不接受 save。
 *
 * 整份测试不打真网：fetch 是注入的假货，时钟也是。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { createQrLogin, QR_TTL_MS } from '../lib/biliqr.js'
import { readOwner, writeOwner } from '../lib/store.js'
import { registerObserve } from '../lib/observe.js'

const QR_URL = 'https://account.bilibili.com/h5/account-h5/auth/scan-web?navhide=1&callback=close&qrcode_key=K1&from=main-fe-header'

/** 一个假 Response：biliqr 只用到 status / headers / text()。 */
function res(body, { cookies = [], status = 200 } = {}) {
  const headers = {
    get: (n) => (String(n).toLowerCase() === 'set-cookie' ? cookies.join(', ') : null),
    getSetCookie: () => cookies,
  }
  return { ok: status < 400, status, headers, text: async () => JSON.stringify(body) }
}

/**
 * 假的 B 站。状态都放在 state 里，测试用 state.* 推进流程。
 * 三条 URL：generate / poll / nav（认账号那一下）。
 */
function fakeFetch(state) {
  return async (url) => {
    const u = String(url)
    if (u.includes('/qrcode/generate')) {
      state.generateCalls += 1
      if (state.generateFails) throw new Error('ECONNREFUSED')
      return res({ code: 0, data: { url: QR_URL, qrcode_key: state.key ?? 'K1' } })
    }
    if (u.includes('/qrcode/poll')) {
      state.pollCalls += 1
      if (state.pollFails) throw new Error('ECONNREFUSED')
      const code = state.pollCode ?? 86101
      const cookies = code === 0 ? (state.setCookies ?? ['SESSDATA=s%2C1; Path=/; Domain=.bilibili.com', 'bili_jct=j1; Path=/', 'DedeUserID=42; Path=/']) : []
      return res({ code: 0, data: { code, message: '' } }, { cookies })
    }
    if (u.includes('/x/web-interface/nav')) {
      state.navCalls += 1
      return res(state.nav ?? { code: 0, data: { isLogin: true, mid: 42, uname: '小鱼' } })
    }
    return res({ code: -404, message: 'no such api' }, { status: 404 })
  }
}

function newMachine(extra = {}) {
  const state = { generateCalls: 0, pollCalls: 0, navCalls: 0, t: Date.UTC(2026, 10, 1, 12, 0, 0) }
  const qr = createQrLogin({ fetchImpl: fakeFetch(state), now: () => state.t, ...extra })
  return { qr, state }
}

test('扫码：start 给出 SVG + key + 过期时间，且这一步还没有任何 cookie', async () => {
  const { qr, state } = newMachine()
  const r = await qr.start()
  assert.equal(r.ok, true)
  assert.equal(r.key, 'K1')
  assert.match(r.svg, /^<svg/)
  assert.equal(r.ttlMs, QR_TTL_MS)
  assert.equal(r.expiresAt, state.t + QR_TTL_MS)
  assert.equal(JSON.stringify(r).includes('SESSDATA'), false, '二维码这一步不该有 cookie')
  assert.deepEqual(qr.peek('K1'), { state: 'waiting', hasCookie: false, account: null })
})

test('扫码：未扫 → 已扫 → 成功，三档状态按时序走', async () => {
  const { qr, state } = newMachine()
  await qr.start()

  state.pollCode = 86101
  assert.equal((await qr.poll('K1')).state, 'waiting')
  assert.equal(qr.peek('K1').hasCookie, false)

  // 轮询有 800ms 下限，真实的页面也是 1.5 秒问一次——假时钟要跟着往前走
  state.t += 1_000
  state.pollCode = 86090
  const scanned = await qr.poll('K1')
  assert.equal(scanned.state, 'scanned')
  assert.match(scanned.why, /确认登录/)

  state.t += 1_000
  state.pollCode = 0
  const done = await qr.poll('K1')
  assert.equal(done.state, 'confirmed')
  assert.deepEqual(done.account, { mid: '42', name: '小鱼' })
  assert.equal(done.canWrite, true)
  // 关键：响应里不能出现凭据原文
  assert.equal(JSON.stringify(done).includes('SESSDATA'), false, 'cookie 原文不许回给页面')
  assert.equal(qr.peek('K1').hasCookie, true)
})

test('扫码：确认之后 save 才写 owner.json，cookie 与账号一起进去、领养人两格不动', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-qr1-'))
  try {
    await writeOwner({ mid: '999', nickname: '领养人' }, root)
    const { qr, state } = newMachine()
    const { key } = await qr.start()
    state.pollCode = 0
    await qr.poll(key)

    const r = await qr.save(key, root)
    assert.equal(r.ok, true)
    assert.equal(JSON.stringify(r).includes('SESSDATA'), false, 'save 的返回也不许带 cookie 原文')
    const ow = await readOwner(root)
    assert.match(String(ow.cookie), /SESSDATA=s%2C1/)
    assert.match(String(ow.cookie), /bili_jct=j1/)
    assert.equal(ow.account.name, '小鱼')
    assert.equal(ow.account.mid, '42')
    // 领养人那两格是用户手填的，扫码不许动
    assert.equal(ow.mid, '999')
    assert.equal(ow.nickname, '领养人')
    // 存完这把钥匙就没了：不允许再 save 第二次
    assert.equal(qr.peek(key), null)
    assert.equal((await qr.save(key, root)).ok, false)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('扫码：没确认就 save 一律拒绝（不写盘）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-qr2-'))
  try {
    const { qr } = newMachine()
    const { key } = await qr.start()
    const r = await qr.save(key, root)
    assert.equal(r.ok, false)
    assert.match(r.why, /还没扫码/)
    assert.equal((await readOwner(root)), null)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('扫码：关掉浮层（drop）＝ cookie 立刻消失，之后 save 也存不了', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-qr3-'))
  try {
    const { qr, state } = newMachine()
    const { key } = await qr.start()
    state.pollCode = 0
    await qr.poll(key)
    assert.equal(qr.peek(key).hasCookie, true)

    qr.drop(key)
    assert.equal(qr.peek(key), null)
    assert.equal((await qr.save(key, root)).ok, false)
    assert.equal(await readOwner(root), null)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('扫码：180 秒一过就不再轮询、也不接受 save（过期就是过期）', async () => {
  const { qr, state } = newMachine()
  const { key } = await qr.start()
  state.pollCode = 0
  await qr.poll(key)

  state.t += QR_TTL_MS + 1
  // 注意：不能再 start 一张新码——假 fetch 的 key 是固定的，会把这张顶掉
  const r = await qr.save(key)
  assert.equal(r.ok, false)
  assert.match(r.why, /过期/)
  assert.equal(qr.peek(key), null, '过期的码连状态都不该留')
})

test('扫码：B 站回 86038 就是过期，不用等本地时钟', async () => {
  const { qr, state } = newMachine()
  const { key } = await qr.start()
  state.pollCode = 86038
  const r = await qr.poll(key)
  assert.equal(r.state, 'expired')
  assert.match(r.why, /过期/)
  assert.equal((await qr.save(key)).ok, false)
})

test('扫码：成功但没给 SESSDATA → 报错，不假装登录成功', async () => {
  const { qr, state } = newMachine()
  const { key } = await qr.start()
  state.pollCode = 0
  state.setCookies = ['bili_jct=j1; Path=/']
  const r = await qr.poll(key)
  assert.equal(r.state, 'error')
  assert.match(String(r.why), /SESSDATA/)
  assert.equal(qr.peek(key).hasCookie, false)
})

test('扫码：没有 bili_jct 时仍然算登录成功，但要明说「不能评论」', async () => {
  const { qr, state } = newMachine()
  const { key } = await qr.start()
  state.pollCode = 0
  state.setCookies = ['SESSDATA=s1; Path=/', 'DedeUserID=42; Path=/']
  state.nav = { code: 0, data: { isLogin: true, mid: 42, uname: '小鱼' } }
  const r = await qr.poll(key)
  assert.equal(r.state, 'confirmed')
  assert.equal(r.canWrite, false)
  assert.match(String(r.note), /不能/)
})

test('扫码：认不出账号不影响已到手的 cookie（网络抖一下不该把登录吞了）', async () => {
  const { qr, state } = newMachine()
  const { key } = await qr.start()
  state.pollCode = 0
  state.nav = { code: -412, message: 'request was banned' }
  const r = await qr.poll(key)
  assert.equal(r.state, 'confirmed')
  assert.equal(r.account, null)
  assert.equal(qr.peek(key).hasCookie, true)
})

test('扫码：连不上 B 站时 start 说清楚原因，不吞异常', async () => {
  const { qr, state } = newMachine()
  state.generateFails = true
  const r = await qr.start()
  assert.equal(r.ok, false)
  assert.match(String(r.why), /连不上/)
})

test('扫码：1 秒内连点两次不会真去要两张码', async () => {
  const { qr, state } = newMachine()
  assert.equal((await qr.start()).ok, true)
  const second = await qr.start()
  assert.equal(second.ok, false)
  assert.equal(state.generateCalls, 1)
  // 过一会儿就允许了
  state.t += 2_000
  assert.equal((await qr.start()).ok, true)
  assert.equal(state.generateCalls, 2)
})

test('扫码：pending 有上限，堆多了先丢最老的（本机登录窗口，不是缓存）', async () => {
  const { qr, state } = newMachine()
  for (let i = 0; i < 5; i += 1) {
    state.key = `K${i}`
    state.t += 2_000
    await qr.start()
  }
  assert.equal(qr.size(), 3)
  assert.equal(qr.peek('K0'), null)
  assert.ok(qr.peek('K4'))
})

test('扫码：clear 之后内存里一个 key 都不留', async () => {
  const { qr, state } = newMachine()
  const { key } = await qr.start()
  state.pollCode = 0
  await qr.poll(key)
  qr.clear()
  assert.equal(qr.size(), 0)
  assert.equal(qr.peek(key), null)
})

/* ------------------------------ 路由那一层 ------------------------------ */

/** 极简假 ctx：只给 observe 需要的几个服务 */
function fakeCtx() {
  const routes = []
  const cfg = { connection: { requestRejection: () => null } }
  const webServer = { register: (def) => { routes.push(def); return () => {} } }
  return {
    routes,
    cfg,
    get: (k) => (k === 'connection' ? cfg.connection : k === 'webServer' ? webServer : undefined),
    webServer,
    tools: { register: () => {} },
    slots: { inject: () => {}, register: () => {} },
    effect: (fn) => fn(),
    on: () => {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    log: () => {},
  }
}

function callRoute(routes, path, method, body) {
  const full = '/dsh-fish' + path
  // /bili/qr 是前缀路由：它的子路径（/status /save /drop）在注册表里查不到，要按前缀找
  const def = routes.find((d) => d.path === full)
    ?? routes.find((d) => d.path && full.startsWith(d.path + '/'))
  if (!def) throw new Error(`没注册这条路由：${path}`)
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  const req = Readable.from(chunks)
  req.method = method
  req.url = full
  req.headers = { 'content-type': 'application/json' }
  let out = null
  const res = {
    statusCode: 0,
    setHeader() {},
    writeHead(n) { this.statusCode = n },
    end(t) { try { out = JSON.parse(String(t)) } catch { out = String(t) } },
  }
  return def.handler(req, res).then(() => ({ status: res.statusCode, body: out }))
}

test('/bili/qr 路由：start → status → save 一条龙，页面全程拿不到 cookie 原文', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-qr4-'))
  try {
    const ctx = fakeCtx()
    // 时钟从这个点开始：bili.js 的风控熔断是模块级的，别的用例踩过 -412 会把这 60 秒
    // 冷却带过来（同一个假时钟就可能还卡在冷却里），所以往后挪半小时。
    const state = { generateCalls: 0, pollCalls: 0, navCalls: 0, t: Date.UTC(2026, 10, 1, 12, 30, 0) }
    const qrLogin = createQrLogin({ fetchImpl: fakeFetch(state), now: () => state.t })
    registerObserve(ctx, { root, qrLogin })

    const start = await callRoute(ctx.routes, '/bili/qr', 'POST', {})
    assert.equal(start.status, 200)
    assert.equal(start.body.ok, true)
    assert.match(start.body.svg, /^<svg/)
    assert.equal(JSON.stringify(start.body).includes('SESSDATA'), false)

    state.pollCode = 0
    state.t += 1_000
    const st = await callRoute(ctx.routes, '/bili/qr/status?key=' + encodeURIComponent(start.body.key), 'GET')
    assert.equal(st.status, 200)
    assert.equal(st.body.state, 'confirmed')
    assert.equal(st.body.account.name, '小鱼')

    const save = await callRoute(ctx.routes, '/bili/qr/save', 'POST', { key: start.body.key })
    assert.equal(save.status, 200)
    const ow = await readOwner(root)
    assert.match(String(ow.cookie), /SESSDATA=/)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('/bili/qr 路由：没有 key 的 save 回 400，没确认过的 save 回 409', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-qr5-'))
  try {
    const ctx = fakeCtx()
    // 时钟从这个点开始：bili.js 的风控熔断是模块级的，别的用例踩过 -412 会把这 60 秒
    // 冷却带过来（同一个假时钟就可能还卡在冷却里），所以往后挪半小时。
    const state = { generateCalls: 0, pollCalls: 0, navCalls: 0, t: Date.UTC(2026, 10, 1, 12, 30, 0) }
    registerObserve(ctx, { root, qrLogin: createQrLogin({ fetchImpl: fakeFetch(state), now: () => state.t }) })

    assert.equal((await callRoute(ctx.routes, '/bili/qr/save', 'POST', {})).status, 400)

    const start = await callRoute(ctx.routes, '/bili/qr', 'POST', {})
    const notYet = await callRoute(ctx.routes, '/bili/qr/save', 'POST', { key: start.body.key })
    assert.equal(notYet.status, 409)
    assert.equal(await readOwner(root), null)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('/bili/qr 路由：GET 该 start 的位置回 405（扫码只能用 POST 开）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-qr6-'))
  try {
    const ctx = fakeCtx()
    registerObserve(ctx, { root, qrLogin: createQrLogin({ fetchImpl: async () => res({ code: 0 }) }) })
    assert.equal((await callRoute(ctx.routes, '/bili/qr', 'GET')).status, 405)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})