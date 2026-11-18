/**
 * home-rotate-route.test.mjs —— 手动换房那条接口（2026-11-18，用户 m02113 / m02215）。
 *
 * 为什么单测路由而不是只测 home.js：`rotateTalkSession` 早就有了，这次改的是
 * 「界面能不能点到它、点错了会不会真换」。所以这里只管三件事：
 *   1. GET 不给换（405），没带 confirm 也不给换（400）——误触停在问那句，不动屋子；
 *   2. 宿主没有会话服务时回 409 并把原因说出来，而不是假装换好了；
 *   3. 真换的时候，新会话 id、旧房间、是否叫醒都回给界面。
 *
 * 用的是假 ctx + 假 req/res，不碰真实家目录。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { registerObserve } from '../lib/observe.js'

function harness(root, { sessionController } = {}) {
  const routes = new Map()
  const ctx = {
    get(name) {
      if (name === 'connection') return { requestRejection: () => null }
      if (name === 'agents') return { get: () => null, list: () => [] }
      if (name === 'webServer') {
        return { register(ex) { routes.set(ex.path, ex.handler); return () => {} } }
      }
      return undefined
    },
    ...(sessionController ? { sessionController } : {}),
  }
  registerObserve(ctx, { root })

  async function call(method, path, body) {
    const base = path.split('?')[0]
    const handler = routes.get(`/dsh-fish${base}`)
    assert.ok(handler, `${base} 要注册上`)
    const req = method === 'POST'
      ? Object.assign(Readable.from([Buffer.from(JSON.stringify(body ?? {}), 'utf8')]), { method, headers: {}, url: `/dsh-fish${path}` })
      : Object.assign(Readable.from([]), { method, headers: {}, url: `/dsh-fish${path}` })
    let status = 0
    let buf = Buffer.alloc(0)
    const res = {
      writableEnded: false,
      writeHead(code) { status = code },
      end(chunk) {
        buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ''), 'utf8')
        res.writableEnded = true
      },
    }
    await handler(req, res)
    const text = buf.toString('utf8')
    let json = null
    try { json = JSON.parse(text) } catch { json = null }
    return { status, text, json }
  }
  return { call }
}

function withRoot() {
  const root = mkdtempSync(join(tmpdir(), 'fish-rotate-'))
  // home.json 就放在数据根下（home.js 的 homeFile 是 join(paths(root).root, 'home.json')）。
  writeFileSync(join(root, 'home.json'), JSON.stringify({
    wsId: 'ws-1', sessionId: 's1', createdAt: '2026-11-18T10:00:00.000Z', turns: 12,
  }, null, 2), 'utf8')
  return root
}

test('换房路由：GET 不受理，没带 confirm 也不动手', async () => {
  const root = withRoot()
  const { call } = harness(root)
  try {
    const get = await call('GET', '/home/rotate')
    assert.equal(get.status, 405)
    const noConfirm = await call('POST', '/home/rotate', {})
    assert.equal(noConfirm.status, 400)
    assert.match(noConfirm.json.error, /confirm/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('换房路由：宿主没有会话服务时回 409，并把原因说出来', async () => {
  const root = withRoot()
  const { call } = harness(root)
  try {
    const r = await call('POST', '/home/rotate', { confirm: 'rotate' })
    assert.equal(r.status, 409)
    assert.equal(r.json.ok, false)
    assert.match(r.json.error, /会话服务/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('换房路由：真换的时候回新会话、旧房间和叫醒结果', async () => {
  const root = withRoot()
  const renamed = []
  const sessionController = {
    create() { return { sessionId: 's2' } },
    // home.js 对 rename 直接 `.catch(...)`，所以要回一个 promise（真宿主也是异步的）。
    rename(o) { renamed.push(o); return Promise.resolve({ ok: true }) },
  }
  // wakeIfBlank 内部要问 agents / sessionController；这里让它走「没叫醒」那条路，
  // 免得测试去碰真实宿主。断言落在返回形状上，不落在叫醒上。
  const { call } = harness(root, { sessionController })
  try {
    const r = await call('POST', '/home/rotate', { confirm: 'rotate' })
    assert.equal(r.status, 200, r.json?.error)
    assert.equal(r.json.ok, true)
    assert.equal(r.json.sessionId, 's2')
    assert.equal(r.json.woke, false)
    assert.match(r.json.note, /新的一间开好了/)
    assert.ok(renamed.length >= 1, '旧房间要改名留档')
    assert.match(String(renamed[0].title || ''), /之前/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
