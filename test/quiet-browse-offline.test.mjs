/**
 * quiet-browse-offline.test.mjs —— 关掉「允许她上网」之后，安静刷与醒来便条都要停（接 #62）
 *
 * `bili.enabled` 是「彻底断网」那一项（settings.js 的 biliOn）。0.9.5 新加的安静刷只认
 * `browse.enabled`，而它默认开着，于是只关「允许她上网」时：
 *   1. 定时 tick 和设置页的 POST /browse 照样去 B 站取热门、深读、记账；
 *   2. 醒来那一行便条照样说「今天你自己又翻到了 N 条……自己点开」，
 *      同一轮里身份文档说她出不去、bili_look 回打不开。
 *
 * 这里把 globalThis.fetch 换成只记地址、一律抛错的假货：断网时要求一次请求都没有，
 * 开着时要求照旧出门（行为不变）。全程不碰真网络。
 */

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { quietBrowse, startScheduler, wakeNow } from '../lib/scheduler.js'
import { recordBrowse } from '../lib/browse.js'
import { setPacing, resetRisk } from '../lib/bili.js'
import { registerObserve } from '../lib/observe.js'
import { clearWakeSection, getWakeSection } from '../lib/identity.js'
import { normalizeConfig, dateKey } from '../lib/settings.js'
import { readEvents, writeConfig } from '../lib/store.js'

// ---------------------------------------------------------------- 假网络

const realFetch = globalThis.fetch
let calls = []

beforeEach(() => {
  calls = []
  globalThis.fetch = async (url) => {
    calls.push(String(url?.url ?? url))
    throw new Error('offline (test)')
  }
  // 开着的对照组会真的排队发请求：把节奏压到下限，别让一趟走上好几秒（配置里也写了同样的值）。
  setPacing({ minIntervalMs: 200, jitterMs: 0 })
  resetRisk()
  clearWakeSection()
})

afterEach(() => {
  globalThis.fetch = realFetch
  setPacing({})
  resetRisk()
  clearWakeSection()
})

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fish-qb-off-'))
  // 叫醒会认屋子、记家谱：家谱指进临时目录，不碰真的那本。
  const oldHomes = process.env.DSH_FISH_HOMES
  process.env.DSH_FISH_HOMES = join(root, 'homes.json')
  try {
    return await fn(root)
  } finally {
    if (oldHomes === undefined) delete process.env.DSH_FISH_HOMES
    else process.env.DSH_FISH_HOMES = oldHomes
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

const ALL_DAY = ['00:00', '23:59']

/**
 * 让 tick 一路走到安静刷：醒的时段、上网时段都放成全天；评论关着，不去查回复。
 * 请求节奏也写进配置：loadConfig 会按它重设 setPacing，只在 beforeEach 里设会被盖掉。
 */
const cfgOf = ({ bili }) => normalizeConfig({
  bili: { enabled: bili, minIntervalMs: 200, jitterMs: 0 },
  comment: { enabled: false },
  window: ALL_DAY,
  browse: { window: ALL_DAY },
})

const browseLines = (events) => events.filter((e) => e?.type === 'meta' && /^(browse|browse-more|looked):/.test(String(e.text ?? '')))

function fakeClient() {
  let touched = 0
  const hit = (data) => async () => { touched++; return { ok: true, data } }
  const item = { bvid: 'BVoff01', title: '热门一', up: '某UP', duration: 300, view: 1 }
  return {
    get touched() { return touched },
    popular: hit([item]),
    ranking: hit([]),
    precious: hit([]),
    search: hit([]),
    related: hit([]),
    view: hit({ desc: '', pubdate: 1700000000, cid: 1, aid: 1, title: '热门一', up: '某UP' }),
    tags: hit([]),
    replies: hit([]),
    danmaku: hit([]),
  }
}

// ---------------------------------------------------------------- quietBrowse 本身

test('quietBrowse：只关「允许她上网」→ 一步不走；按钮（force）也绕不过', async () => {
  await withRoot(async (root) => {
    const cfg = cfgOf({ bili: false })
    assert.equal(cfg.browse.enabled, true, '前提：自动刷是默认开着的')
    for (const force of [false, true]) {
      const c = fakeClient()
      const r = await quietBrowse(root, { day: 2, stage: 2 }, cfg, dateKey(), { client: c, now: new Date(), force })
      assert.equal(r.ok, false, `force=${force} 时不该刷成`)
      assert.equal(r.picks.length, 0)
      assert.match(r.note, /上不了网/)
      assert.equal(c.touched, 0, `force=${force} 时连 client 都不该碰`)
    }
    assert.equal(calls.length, 0)
    const { events } = await readEvents(root)
    assert.equal(browseLines(events).length, 0, '断网时不该记 browse: / looked:')
  })
})

// ---------------------------------------------------------------- 定时 tick

async function tickOnce(root) {
  const s = startScheduler({ on: () => () => {} }, { root, log: () => {} })
  try { await s.tick() } finally { s.dispose() }
}

test('tick：只关「允许她上网」→ 安静刷不出门，0 次请求，不记账', async () => {
  await withRoot(async (root) => {
    await writeConfig(cfgOf({ bili: false }), root)
    await tickOnce(root)
    assert.deepEqual(calls, [], `断网时 tick 不该连 B 站，实际请求了：${calls.join(' , ')}`)
    const { events } = await readEvents(root)
    assert.equal(browseLines(events).length, 0)
  })
})

test('tick：开着时照旧出门（对照组，行为不变）', async () => {
  await withRoot(async (root) => {
    await writeConfig(cfgOf({ bili: true }), root)
    await tickOnce(root)
    assert.ok(calls.length > 0, '开着时安静刷应该照常去 B 站')
    assert.ok(calls.every((u) => /bilibili\.com/.test(u)), `只该去 B 站：${calls.join(' , ')}`)
  })
})

// ---------------------------------------------------------------- 设置页 POST /browse

function routeCtx() {
  const routes = []
  const connection = { requestRejection: () => null }
  const webServer = { register: (def) => { routes.push(def); return () => {} } }
  return {
    routes,
    get: (k) => (k === 'connection' ? connection : k === 'webServer' ? webServer : undefined),
    webServer,
    tools: { register: () => {} },
    slots: { inject: () => {}, register: () => {} },
    effect: (fn) => fn(),
    on: () => {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    log: () => {},
  }
}

function postBrowse(routes) {
  const full = '/dsh-fish/browse'
  const def = routes.find((d) => d.path === full)
  if (!def) throw new Error('没注册 /browse')
  const req = Readable.from([Buffer.from('{}', 'utf8')])
  req.method = 'POST'
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

test('POST /browse：只关「允许她上网」→ 回 409，0 次请求，不记账', async () => {
  await withRoot(async (root) => {
    await writeConfig(cfgOf({ bili: false }), root)
    const ctx = routeCtx()
    registerObserve(ctx, { root })
    const r = await postBrowse(ctx.routes)
    assert.deepEqual(calls, [], `断网时按钮不该连 B 站，实际请求了：${calls.join(' , ')}`)
    assert.equal(r.status, 409)
    assert.equal(r.body.ok, false)
    assert.equal(r.body.count, 0)
    assert.match(String(r.body.note), /上不了网/)
    const { events } = await readEvents(root)
    assert.equal(browseLines(events).length, 0)
  })
})

test('POST /browse：开着时照旧出门（对照组，行为不变）', async () => {
  await withRoot(async (root) => {
    await writeConfig(cfgOf({ bili: true }), root)
    const ctx = routeCtx()
    registerObserve(ctx, { root })
    await postBrowse(ctx.routes)
    assert.ok(calls.length > 0, '开着时按钮应该照常去 B 站')
  })
})

// ---------------------------------------------------------------- 醒来那一行便条

/** 假宿主：认屋子、开会话、投递叫醒都能走通（形状同 boot.test.mjs）。 */
function wakeCtx() {
  const sessions = new Set()
  const prompts = []
  const ctx = {
    tools: { register: () => () => {} },
    webServer: { register: () => () => {} },
    connection: { requestRejection: () => null },
    sessionController: {
      async create({ sessionId }) { if (sessions.has(sessionId)) throw new Error('exists'); sessions.add(sessionId) },
      async prompt(payload) { prompts.push(payload) },
      async resolveAgent(sessionId) {
        return { agent: { followup(message) { prompts.push({ sessionId, content: message?.content }) } } }
      },
    },
    logger: { info() {}, warn() {}, error() {} },
    on() {},
    get(key) { return ctx[key] },
  }
  return { ctx, prompts }
}

/** 断网前（或开着时）安静刷记下、还没念过的两条。 */
async function seedBrowsed(root) {
  await recordBrowse(root, dateKey(), [
    { bvid: 'BVoff01', title: '热门一' },
    { bvid: 'BVoff02', title: '热门二' },
  ], { day: 1, stage: 1 })
}

test('醒来便条：断网时不念「又翻到了 N 条」，叫醒也不出门', async () => {
  await withRoot(async (root) => {
    await writeConfig(cfgOf({ bili: false }), root)
    await seedBrowsed(root)
    const { ctx, prompts } = wakeCtx()
    const r = await wakeNow(ctx, { root, force: true })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(prompts.length, 1, '叫醒本身照常')
    const wake = getWakeSection(r.sessionId)
    assert.ok(wake.length > 0, '处境不能是空的')
    assert.doesNotMatch(wake, /翻到了/, `断网时不该叫她「自己点开」：${wake}`)
    assert.doesNotMatch(wake, /热门一|热门二/)
    assert.deepEqual(calls, [])
  })
})

test('醒来便条：开着时照旧念（对照组，行为不变）', async () => {
  await withRoot(async (root) => {
    await writeConfig(cfgOf({ bili: true }), root)
    await seedBrowsed(root)
    const { ctx } = wakeCtx()
    const r = await wakeNow(ctx, { root, force: true })
    assert.equal(r.ok, true, JSON.stringify(r))
    const wake = getWakeSection(r.sessionId)
    assert.match(wake, /今天你自己又翻到了 2 条：《热门一》、《热门二》/)
  })
})
