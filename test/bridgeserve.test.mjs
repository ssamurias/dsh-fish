/**
 * 桥接投递口（lib/bridgeserve.js）与信任栅栏错误码的守卫（1.0.6）。
 *
 * 两件事：
 *   1. 投递口本身：绑回环、认 Host、只有两条路、默认不开、关得干净。
 *      它存在的理由就是「宿主内那条 /dsh-fish/say 外部进不去」，所以「它自己能不能被
 *      直连」是唯一的价值主张，必须测得住。
 *   2. 栅栏回错了码这件事：宿主的 `requestRejection()` 返回的是**数字** 403/401，
 *      插件以前当对象取 `.status`，于是恒回 403 + `forbidden`，把「未认证」掩盖成
 *      「被禁」。2026-11-19 一位 QQ 桥用户就是照着文档做、一路撞在 403 上。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request, createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startBridgeServer, closeBridgeServer, bridgeUrl } from '../lib/bridgeserve.js'
import { registerObserve } from '../lib/observe.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 借一个当前空闲的端口再还回去。
 * `startBridgeServer({port: 0})` 的含义是「不开」（不像说明小站那样退随机端口），
 * 所以测试必须自己挑一个真端口。
 */
async function freePort() {
  const srv = createServer()
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const { port } = srv.address()
  await new Promise((r) => srv.close(r))
  return port
}

async function up(opts = {}) {
  const port = opts.port ?? await freePort()
  const st = startBridgeServer({ ...opts, port })
  for (let i = 0; i < 200 && !st.url; i++) await sleep(10)
  assert.ok(st.url, '投递口必须在 2 秒内起来')
  return st
}

/** 能指定 Host 与 method 的最小请求器：fetch 不让改 Host。 */
function hit(url, { method = 'GET', host, body, headers } = {}) {
  const u = new URL(url)
  const hd = { ...(host ? { host } : {}), ...(headers || {}) }
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method,
      headers: hd,
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    if (body !== undefined) req.end(body)
    else req.end()
  })
}

const echo = (tag) => async (req, res) => {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ ok: true, tag, method: req.method }))
}

test('默认不开：不给端口就连监听都不建，bridgeUrl() 是空串', () => {
  const st = startBridgeServer({ handlers: { '/say': echo('say') } })
  assert.equal(st.url, '', 'bridge.port 默认 0，不该自作主张开一个口子')
  assert.equal(bridgeUrl(), '')
  closeBridgeServer()
})

test('指定的端口起得来，/whoami 与 / 都能到；只绑回环', async () => {
  const st = await up({ handlers: { '/whoami': echo('whoami'), '/say': echo('say') } })
  assert.ok(st.url.startsWith('http://127.0.0.1:'), '绑定的是 127.0.0.1，不是 0.0.0.0')
  assert.equal(st.port, Number(new URL(st.url).port))
  assert.equal(bridgeUrl(), st.url, 'bridgeUrl() 给的是同一个地址（/whoami 的 bridge 字段从这里取）')
  const a = await hit(`${st.url}/whoami`)
  assert.equal(a.status, 200)
  assert.equal(JSON.parse(a.body).tag, 'whoami')
  assert.equal(JSON.parse(a.body).method, 'GET')
  const b = await hit(`${st.url}/`)
  assert.equal(JSON.parse(b.body).tag, 'whoami', '根路径就是 whoami：桥探活只想敲一下根就知道通不通')
  closeBridgeServer()
})

test('Host 头不对就 403：挡 DNS rebinding，不是防外人', async () => {
  const st = await up({ handlers: { '/whoami': echo('whoami') } })
  const bad = await hit(`${st.url}/whoami`, { host: `evil.example:${st.port}` })
  assert.equal(bad.status, 403)
  assert.match(bad.body, /不认这个地址/)
  const ok = await hit(`${st.url}/whoami`, { host: `localhost:${st.port}` })
  assert.equal(ok.status, 200, 'localhost 与 127.0.0.1 都算自己')
  closeBridgeServer()
})

test('只有登记过的那两条路：别的路径 404，方法判断交给 handler', async () => {
  const st = await up({ handlers: { '/whoami': echo('whoami'), '/say': echo('say') } })
  const nf = await hit(`${st.url}/dsh-fish/say`)
  assert.equal(nf.status, 404, '前缀不匹配：投递口只认完整路径，不蹭宿主那套前缀路由')
  assert.match(nf.body, /没有这一页/)
  // 方法在这里不判，原样交给 handler（与宿主内那两条路由共用同一份代码）
  const p = await hit(`${st.url}/say`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })
  assert.equal(p.status, 200)
  assert.equal(JSON.parse(p.body).method, 'POST')
  closeBridgeServer()
})

test('重复启动不叠监听：换掉的只是 handlers', async () => {
  const a = await up({ handlers: { '/whoami': echo('第一版') } })
  const b = startBridgeServer({ handlers: { '/whoami': echo('第二版') } })
  assert.equal(b.port, a.port, '同一个服务，不是新开一个')
  assert.equal(JSON.parse((await hit(`${a.url}/whoami`)).body).tag, '第二版', '重启插件后根目录可能变了，新的 handler 要立刻生效')
  closeBridgeServer()
})

test('handler 抛错回 500 并带上原话；413 用投递口自己的说法', async () => {
  const st = await up({
    handlers: {
      '/whoami': async (req, res) => {
        if (req.headers['x-boom'] === '1') {
          const err = new Error('body too large')
          err.statusCode = 413
          throw err
        }
        throw new Error('读不到数据')
      },
    },
  })
  const r = await hit(`${st.url}/whoami`)
  assert.equal(r.status, 500)
  assert.match(r.body, /读不到数据/, '错在哪儿要写出来，不要只剩一个 500')
  closeBridgeServer()
})

test('关掉之后地址就没了（用户把端口改回 0 时靠这个收干净）', async () => {
  const st = await up({ handlers: { '/whoami': echo('whoami') } })
  const url = st.url
  closeBridgeServer()
  assert.equal(bridgeUrl(), '', '停掉之后不该还留着一个能点的地址')
  await assert.rejects(hit(`${url}/whoami`), '端口应该已经放开，连不上了')
})

// ---- 信任栅栏的错误码（observe.js 的 guarded）----

/** 把 observe.js 的路由收下来；connection 的驳回值由调用方给。 */
async function withRoutes(rejection, fn) {
  const box = await mkdtemp(join(tmpdir(), 'fish-bridge-'))
  const root = join(box, 'dsh-fish')
  const routes = []
  const ctx = {
    get: (k) => (k === 'connection'
      ? { requestRejection: () => rejection }
      : k === 'webServer'
        ? { register: (def) => { routes.push(def); return () => {} } }
        : undefined),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }
  const handle = registerObserve(ctx, { root })
  const call = async (url = '/dsh-fish/whoami') => {
    const route = routes
      .filter((r) => url === r.path || url.startsWith(`${r.path}/`) || url.startsWith(`${r.path}?`))
      .sort((a, b) => b.path.length - a.path.length)[0]
    assert.ok(route, `没有接 ${url} 的路由`)
    const out = { status: 0, body: '' }
    const res = {
      writableEnded: false,
      writeHead: (s) => { out.status = s },
      setHeader: () => {},
      end: (s) => { out.body = String(s ?? ''); out.writableEnded = true },
    }
    await route.handler({ method: 'GET', url, headers: { host: '127.0.0.1:4695' } }, res)
    return out
  }
  try {
    return await fn({ root, call })
  } finally {
    handle.dispose()
    await rm(box, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

test('数字驳回码：401 就回 401，403 就回 403，不再一律压成 forbidden', async () => {
  // 宿主 `admit()` 返回的是 `{ rejection: 401 }` / `{ rejection: 403 }` —— 一个**数字**。
  await withRoutes(401, async ({ call }) => {
    const r = await call()
    assert.equal(r.status, 401, '未认证必须如实回 401，桥才知道「缺 cookie」而不是「被禁」')
    assert.match(JSON.parse(r.body).error, /unauthenticated/)
  })
  await withRoutes(403, async ({ call }) => {
    const r = await call()
    assert.equal(r.status, 403)
    assert.match(JSON.parse(r.body).error, /forbidden/)
  })
})

test('对象形状的驳回仍然认（别把老宿主/自测桩写死成一种）', async () => {
  await withRoutes({ status: 418, message: '我是茶壶' }, async ({ call }) => {
    const r = await call()
    assert.equal(r.status, 418)
    assert.equal(JSON.parse(r.body).error, '我是茶壶')
  })
  await withRoutes({ status: 'nonsense' }, async ({ call }) => {
    const r = await call()
    assert.equal(r.status, 403, '认不出来的码退成 403，不要漏出一个 0 或 NaN')
  })
})

test('放行时路由照常干活：/whoami 带得出 bridge 字段', async () => {
  await withRoutes(null, async ({ call }) => {
    const r = await call()
    assert.equal(r.status, 200)
    const body = JSON.parse(r.body)
    assert.equal(body.ok, true)
    assert.equal(body.plugin, 'dsh-fish')
    assert.equal(typeof body.bridge, 'string', '桥照着 bridge 字段找投递口，不用自己拼端口')
  })
})

// ---- 浏览器挡板（2026-11-19 复查补的）----
// Host 校验只挡 DNS rebinding；一个网页直接 fetch 到 127.0.0.1 时 Host 是真的，
// 而 text/plain 属于 CORS「简单请求」连预检都不发，等于任何网页都能以主人名义让她说话。

test('浏览器带的 Origin 一律拒：本机脚本不会带这个头', async () => {
  const st = await up({ handlers: { '/say': echo('say'), '/whoami': echo('whoami') } })
  for (const origin of ['http://evil.example', 'http://127.0.0.1:8000', 'null']) {
    const r = await hit(`${st.url}/say`, {
      method: 'POST',
      body: '{"text":"我是网页冒充的"}',
      headers: { origin, 'content-type': 'application/json' },
    })
    assert.equal(r.status, 403, `带 Origin: ${origin} 必须拒`)
    assert.match(r.body, /不收浏览器/)
  }
  // 不带 Origin 的本机客户端照常
  const ok = await hit(`${st.url}/say`, { method: 'POST', body: '{"text":"本机脚本"}', headers: { 'content-type': 'application/json' } })
  assert.equal(ok.status, 200)
  closeBridgeServer()
})

test('Sec-Fetch-Site 是 cross-site / same-site 也拒（浏览器脚本改不了这个头）', async () => {
  const st = await up({ handlers: { '/say': echo('say') } })
  for (const site of ['cross-site', 'same-site']) {
    const r = await hit(`${st.url}/say`, {
      method: 'POST',
      body: '{}',
      headers: { 'sec-fetch-site': site, 'content-type': 'application/json' },
    })
    assert.equal(r.status, 403, `sec-fetch-site=${site} 必须拒`)
  }
  const none = await hit(`${st.url}/say`, { method: 'POST', body: '{}', headers: { 'sec-fetch-site': 'none', 'content-type': 'application/json' } })
  assert.equal(none.status, 200, 'none = 用户直接打开/命令行，放行')
  closeBridgeServer()
})

test('写入必须声明 application/json：不留「简单请求」的缝', async () => {
  const st = await up({ handlers: { '/say': echo('say'), '/whoami': echo('whoami') } })
  const textPlain = await hit(`${st.url}/say`, { method: 'POST', body: '{"text":"x"}', headers: { 'content-type': 'text/plain' } })
  assert.equal(textPlain.status, 415, 'text/plain 是 CORS 简单请求，必须挡住')
  assert.match(textPlain.body, /application\/json/)
  const noCt = await hit(`${st.url}/say`, { method: 'POST', body: '{}' })
  assert.equal(noCt.status, 415, '没写 content-type 也不行')
  // GET /whoami 不受这条限制
  const who = await hit(`${st.url}/whoami`)
  assert.equal(who.status, 200)
  closeBridgeServer()
})
