import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { readEvents } from '../lib/store.js'
import { wakeNow } from '../lib/scheduler.js'
import { inWake } from '../lib/wakewin.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fish-shutdown-'))
  const old = process.env.DSH_FISH_HOMES
  process.env.DSH_FISH_HOMES = join(root, 'homes.json')
  try { return await fn(root) } finally {
    if (old === undefined) delete process.env.DSH_FISH_HOMES; else process.env.DSH_FISH_HOMES = old
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}
function fakeCtx() {
  const tools = new Map(), routes = [], prompts = [], cleanups = []
  let toolOffs = 0
  const ctx = {
    tools: { register: (s) => { tools.set(s.name, s); return () => { toolOffs++; tools.delete(s.name) } } },
    webServer: { register: (r) => { routes.push(r); return () => {} } },
    connection: { requestRejection: () => null },
    sessionController: {
      async create() {}, async prompt(p) { prompts.push(p) },
      async resolveAgent(sessionId) { return { agent: { followup(m) { prompts.push({ sessionId, content: m?.content }) } } } },
    },
    logger: { info() {}, warn() {}, error() {} },
    on() { return () => {} },
    effect(fn) { cleanups.push(fn()) },
    get(k) { return ctx[k] },
  }
  return { ctx, routes, prompts, cleanups, tools, get toolOffs() { return toolOffs } }
}
function watchTimers() {
  const real = { si: globalThis.setInterval, ci: globalThis.clearInterval, st: globalThis.setTimeout, ct: globalThis.clearTimeout }
  const live = new Set()
  globalThis.setInterval = (...a) => { const t = real.si(...a); live.add(t); return t }
  globalThis.clearInterval = (t) => { live.delete(t); return real.ci(t) }
  globalThis.setTimeout = (fn, ms, ...a) => { const t = real.st((...x) => { live.delete(t); fn(...x) }, ms, ...a); if (ms >= 1000) live.add(t); return t }
  globalThis.clearTimeout = (t) => { live.delete(t); return real.ct(t) }
  return { live, restore() { globalThis.setInterval = real.si; globalThis.clearInterval = real.ci; globalThis.setTimeout = real.st; globalThis.clearTimeout = real.ct } }
}

test('收尾：启动第一步就收尾：不留定时器、不注册路由、不播种', async () => {
  await withRoot(async (root) => {
    const w = watchTimers()
    try {
      const f = fakeCtx()
      apply(f.ctx, { root })
      await f.cleanups[0]()
      await sleep(150)
      assert.equal(w.live.size, 0, '定时器')
      assert.equal(f.routes.length, 0, '路由')
      assert.equal((await readEvents(root)).events.filter((e) => e.type === 'seed').length, 0, 'seed')
    } finally { w.restore() }
  })
})

test('收尾：认领途中收尾：cleanup 的 Promise 落定时认领已放开，不留定时器', async () => {
  await withRoot(async (root) => {
    const w = watchTimers()
    const realRead = fsp.readFile
    let done = null
    const f = fakeCtx()
    fsp.readFile = (file, ...a) => {
      if (String(file).endsWith('instance.json')) { fsp.readFile = realRead; Promise.resolve().then(() => { done = f.cleanups[0]() }) }
      return realRead(file, ...a)
    }
    try {
      apply(f.ctx, { root })
      for (let i = 0; i < 200 && !done; i++) await sleep(2)
      assert.ok(done && typeof done.then === 'function', 'cleanup 要返回 Promise')
      await done
      const cur = JSON.parse(await readFile(join(root, 'instance.json'), 'utf8'))
      assert.equal(cur.instanceId, '', '认领要放开')
      await sleep(50)
      assert.equal(w.live.size, 0, '定时器')
    } finally { fsp.readFile = realRead; w.restore() }
  })
})

test('收尾：只收一次：工具的 disposer 不跑第二遍', async () => {
  await withRoot(async (root) => {
    const f = fakeCtx()
    apply(f.ctx, { root })
    for (let i = 0; i < 300 && f.routes.length === 0; i++) await sleep(10)
    const n = f.tools.size
    assert.ok(n > 0)
    await f.cleanups[0]()
    const once = f.toolOffs
    assert.ok(once > 0)
    await f.cleanups[0]()
    assert.equal(f.toolOffs, once)
  })
})

test('收尾：等她说完之后已停用：不再叫她', async () => {
  await withRoot(async (root) => {
    const f = fakeCtx()
    await wakeNow(f.ctx, { root, force: true, waitIdle: async () => {}, isDisposed: () => true })
    assert.equal(f.prompts.length, 0)
  })
})

test('收尾：ctx 已停用时 ctx.on 抛错：唤醒窗不卡死', async () => {
  await withRoot(async (root) => {
    const f = fakeCtx()
    const before = inWake()
    f.ctx.on = () => { throw new Error('INACTIVE_EFFECT') }
    await wakeNow(f.ctx, { root, force: true }).catch(() => {})
    assert.equal(inWake(), before)
  })
})
