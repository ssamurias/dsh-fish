/**
 * body-limit.test.mjs —— 请求体超过上限时怎么回（接 issue #65）
 *
 * 超限以后不再当场断开：标记超限、回 413、剩下的照收不存；照收也有个头，
 * 一共收到上限的 2 倍还没传完就断开。自己 catch 住 readBody 错误的那几个路由
 * （头像、扫码登录的 save/drop、自升级的 download/install、风控解冻），超限也要原样回 413，
 * 不能说成「body 不是合法 JSON」、也不能当成空请求体接着往下走。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

/** 把 observe.js 的路由收下来；call 按前缀找路由（和宿主一样，最长的那条），req 用 PassThrough 造。 */
async function withRoutes(deps, fn) {
  const { registerObserve } = await import('../lib/observe.js')
  const box = await mkdtemp(join(tmpdir(), 'fish-body-limit-'))
  const root = join(box, 'dsh-fish')
  const routes = []
  const ctx = {
    get: (k) => (k === 'connection'
      ? { requestRejection: () => null }
      : k === 'webServer'
        ? { register: (def) => { routes.push(def); return () => {} } }
        : undefined),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }
  const handle = registerObserve(ctx, { root, ...deps })
  const open = (method, url) => {
    const route = routes
      .filter((r) => url === r.path || url.startsWith(`${r.path}/`) || url.startsWith(`${r.path}?`))
      .sort((a, b) => b.path.length - a.path.length)[0]
    assert.ok(route, `没有接 ${url} 的路由`)
    const req = new PassThrough()
    Object.assign(req, { method, url, headers: { 'content-type': 'application/json' } })
    const res = { status: 0, text: '', writableEnded: false }
    Object.assign(res, {
      writeHead: (s) => { res.status = s },
      setHeader: () => {},
      end: (s) => { res.text = String(s ?? ''); res.writableEnded = true },
    })
    const done = route.handler(req, res)
    return { req, res, done }
  }
  try {
    return await fn({ root, open })
  } finally {
    handle.dispose()
    await rm(box, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

const tick = () => new Promise((ok) => setImmediate(ok))

/** 分块写 bytes 个字节，每块之后让出去一下，让读的那边跟上；断开了就停。返回实际写了多少。 */
async function feed(req, bytes, chunk = 4_096) {
  let sent = 0
  while (sent < bytes && !req.destroyed) {
    const n = Math.min(chunk, bytes - sent)
    req.write(Buffer.alloc(n, 0x20))
    sent += n
    await tick()
  }
  return sent
}

test('超限的请求先回 413，剩下的照收不存；一共收到上限的 2 倍还没传完就断开', async () => {
  const limit = 50_000
  await withRoutes({ restoreLimit: limit }, async ({ root, open }) => {
    const { req, res, done } = open('POST', '/dsh-fish/backup/restore')
    // 刚过上限：已经回了 413 和原因，连接还开着，客户端能把剩下的传完、读到这句话。
    // 路由要是还在等请求体传完才回话，这里别一直挂着：等 5 秒算失败。
    await feed(req, limit + 10_000)
    let timer
    const waited = await Promise.race([done.then(() => 'done'), new Promise((ok) => { timer = setTimeout(ok, 5_000, 'timeout') })])
    clearTimeout(timer)
    if (waited !== 'done') req.destroy()
    assert.equal(waited, 'done', '超限了还在等请求体传完')
    assert.equal(res.status, 413, res.text)
    assert.match(JSON.parse(res.text).error, /装不回去/)
    assert.equal(req.destroyed, false, '没到 2 倍不断开')
    // 接着传，到上限的 2 倍附近还没完：断开，不陪着无底地收下去
    await feed(req, limit - 10_000 - 4_096)
    assert.equal(req.destroyed, false, `还没到 2 倍（${2 * limit}）`)
    const more = await feed(req, 10 * limit)
    assert.equal(req.destroyed, true, '过了 2 倍要断开')
    assert.ok(more < 3 * 4_096, `断开以后不再收：又写进去 ${more} 字节`)
    // 现在的档没动
    await assert.rejects(stat(join(root, '..', 'dsh-fish-backups')))
  })
})

test('自己接住 readBody 错误的路由，超限时也原样回 413', async () => {
  // 0.9.5 之前超限是当场断开；第一轮改成照收不存以后，这几个路由把 413 吞了：
  // 头像说「只支持 png / jpg / webp / gif」，扫码登录和自升级说「body 不是合法 JSON」，风控解冻回 200。
  const cases = [
    ['/dsh-fish/avatar', 4_000_000],
    ['/dsh-fish/bili/qr/save', 20_000],
    ['/dsh-fish/bili/qr/drop', 20_000],
    ['/dsh-fish/update/download', 1_000_000],
    ['/dsh-fish/update/install', 1_000_000],
    ['/dsh-fish/risk', 1_000_000],
  ]
  await withRoutes({}, async ({ open }) => {
    for (const [url, max] of cases) {
      const { req, res, done } = open('POST', url)
      req.end(Buffer.alloc(max + 1, 0x20))
      await done
      assert.equal(res.status, 413, `${url}：${res.status} ${res.text}`)
      assert.match(JSON.parse(res.text).error, /too large/, url)
    }
  })
})

test('没超限的请求照常读完：413 只给超了的', async () => {
  await withRoutes({}, async ({ open }) => {
    const { req, res, done } = open('POST', '/dsh-fish/bili/qr/drop')
    req.end(JSON.stringify({ key: 'k' }))
    await done
    assert.notEqual(res.status, 413, res.text)
  })
})
