/**
 * bili-switch.test.mjs —— issue #62：她上 B 站只认一个开关（bili.enabled，默认开）
 *
 * 0.9.0 把刷站从唤醒上拿掉以后，几条路各认各的开关：
 *   · 翻视频（bili_look）认 bili.enabled；
 *   · 看画面（bili_watch）和身份文档「上网」一节认 browse.enabled——已停用的刷站开关，默认关；
 *   · 发评论 / 回复、定时查回复、叫醒时扫回复只认 comment.enabled。
 * 于是全新配置下看画面一律「现在打不开」，身份文档说「这会儿出不去」，
 * 而 bili.enabled=false 只关得掉翻视频，其余几条照常联网。
 *
 * 这里守住：
 *   1. 默认配置下看画面走得到取详情那一步，身份文档写的是能上网的那一版；
 *   2. bili.enabled=false 时，上面每一条路都不碰 B 站（假 client / 假 fetch 计数为 0）；
 *   3. 设置页「允许她上网」读写的是 bili.enabled，不再写 browse.enabled。
 *
 * 全部用临时目录、假 client、假 fetch，不联网。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { normalizeConfig, biliOn, dateKey, updateConfig } from '../lib/settings.js'
import { appendEvent, paths, writeConfig, readConfig } from '../lib/store.js'
import { registerLook } from '../lib/look.js'
import { registerWatch } from '../lib/watch.js'
import { registerSpeak, noteSpeakEnabled } from '../lib/speak.js'
import { postComment, postReply } from '../lib/comment.js'
import { writeSelfDoc } from '../lib/selfdoc.js'
import { startScheduler, wakeNow } from '../lib/scheduler.js'
import { registerObserve } from '../lib/observe.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(HERE, '..', 'lib', 'client.js')
const BV = 'BV1xx411c7mD'

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fish-bili-switch-'))
  const oldHomes = process.env.DSH_FISH_HOMES
  process.env.DSH_FISH_HOMES = join(root, 'homes.json')
  try {
    await mkdir(paths(root).root, { recursive: true })
    return await fn(root)
  } finally {
    if (oldHomes === undefined) delete process.env.DSH_FISH_HOMES
    else process.env.DSH_FISH_HOMES = oldHomes
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

/** 假 client：记下每一次调用；默认详情能取到、播放地址取不到（不开 ffmpeg） */
function fakeClient(over = {}) {
  const calls = []
  const base = {
    view: async (bvid) => ({ ok: true, data: { bvid, aid: 1001, cid: 555, title: '一个普通的视频', up: '某UP', mid: 7, duration: 600 } }),
    tags: async () => ({ ok: true, data: ['日常'] }),
    playurl: async () => ({ ok: false, message: '假的：不给播放地址' }),
    replies: async () => ({ ok: true, data: [] }),
    danmaku: async () => ({ ok: true, data: [] }),
    popular: async () => ({ ok: true, data: [] }),
    subReplies: async () => ({ ok: true, data: [] }),
    replyAdd: async () => ({ ok: true, data: { rpid: 90001 } }),
    replyReply: async () => ({ ok: true, data: { rpid: 90002 } }),
  }
  const c = { calls }
  for (const [k, fn] of Object.entries({ ...base, ...over })) {
    c[k] = async (...a) => { calls.push([k, ...a]); return fn(...a) }
  }
  return c
}

function toolsCtx() {
  const tools = []
  return { tools: { register: (t) => { tools.push(t); return { dispose() {} } } }, _tools: tools }
}

/** 换掉全局 fetch：B 站客户端没注入 fetch 时用的就是它。每次调用都记下来并抛错（不联网）。 */
async function withFetchSpy(fn) {
  const saved = globalThis.fetch
  const urls = []
  globalThis.fetch = async (url) => { urls.push(String(url)); throw new Error('测试里不联网') }
  try {
    return await fn(urls)
  } finally {
    globalThis.fetch = saved
  }
}

/** 她最近发过一条评论：扫回复时会去问这条下面有没有人回 */
async function seedComment(root, dk = dateKey()) {
  await appendEvent({ type: 'meta', text: `comment:${dk} ${BV} 111` }, { day: 0, stage: 1, source: 'system' }, root)
}

/** 今天看过这条（发评论的前提） */
async function seedLook(root, dk = dateKey()) {
  await appendEvent({ type: 'meta', text: `look:${dk} ${BV}` }, { day: 0, stage: 1, source: 'system' }, root)
}

// ------------------------------------------------------------- 判据本身

test('biliOn：默认开，只有明写 false 才算关', () => {
  assert.equal(biliOn(undefined), true)
  assert.equal(biliOn({}), true)
  assert.equal(biliOn({ bili: {} }), true)
  assert.equal(biliOn({ bili: { enabled: true } }), true)
  assert.equal(biliOn({ bili: { enabled: false } }), false)
  // browse.enabled 是已停用的刷站开关，不再参与
  assert.equal(biliOn({ browse: { enabled: false } }), true)
  assert.equal(biliOn({ bili: { enabled: false }, browse: { enabled: true } }), false)
})

test('normalizeConfig 把 bili.enabled 转成布尔，默认 true；browse.enabled 默认仍是 false、键还在', () => {
  assert.equal(normalizeConfig({}).bili.enabled, true)
  assert.equal(normalizeConfig({ bili: { enabled: false } }).bili.enabled, false)
  assert.equal(normalizeConfig({ bili: { enabled: null } }).bili.enabled, true)
  assert.equal(normalizeConfig({ bili: { minIntervalMs: 900 } }).bili.enabled, true, '老配置只有节奏两项时按开算')
  // 手改配置写了别的值：和 biliOn 同一个口径（不是 false 就算开），落盘的是布尔
  assert.equal(normalizeConfig({ bili: { enabled: 'off' } }).bili.enabled, true)
  assert.equal(typeof normalizeConfig({ bili: { enabled: 'off' } }).bili.enabled, 'boolean')
  const cfg = normalizeConfig({})
  assert.equal(cfg.browse.enabled, false)
  assert.ok('enabled' in cfg.browse, 'browse.enabled 不删：已停用的刷站还在读它')
})

// ------------------------------------------------------------- 默认配置：能上网

test('全新配置：看画面不再一律「现在打不开」，会去取这条视频的详情', async () => {
  await withRoot(async (root) => {
    const client = fakeClient()
    const ctx = toolsCtx()
    registerWatch(ctx, { root, client })
    const out = await ctx._tools[0].execute({ bvid: BV })
    assert.notEqual(out.note, '现在打不开。', '默认配置（browse.enabled=false、bili.enabled=true）下不该被挡在门口')
    assert.ok(client.calls.some((c) => c[0] === 'view'), '要走到取详情那一步')
    // 这里的假 client 不给播放地址，所以这次照样没看成——理由是上游给的那句
    assert.equal(out.ok, false)
    assert.equal(out.note, '假的：不给播放地址')
  })
})

test('全新配置：身份文档「上网」一节写怎么用 bili_look，不写「这会儿出不去」', async () => {
  await withRoot(async (root) => {
    const r = await writeSelfDoc(root)
    assert.equal(r.ok, true, r.why)
    const doc = await readFile(r.file, 'utf8')
    const net = doc.slice(doc.indexOf('## 上网'), doc.indexOf('## 在网上说话'))
    assert.match(net, /你还有一个工具 bili_look/)
    assert.doesNotMatch(net, /这会儿出不去/)
    // 评论默认关：这一节仍然是「这会儿还说不出去」
    assert.match(doc, /这会儿还说不出去/)
  })
})

// ------------------------------------------------------------- bili.enabled=false：每条路都断

test('上网关着：bili_look 和 bili_watch 都拒，browse / video 开着也一样，一个请求都不发', async () => {
  await withRoot(async (root) => {
    await updateConfig({ bili: { enabled: false }, browse: { enabled: true }, video: { enabled: true } }, root)
    const client = fakeClient()
    const ctx = toolsCtx()
    registerLook(ctx, { root, client })
    registerWatch(ctx, { root, client })
    const look = ctx._tools.find((t) => t.name === 'bili_look')
    const watch = ctx._tools.find((t) => t.name === 'bili_watch')
    const a = await look.execute({ what: 'home' })
    const b = await watch.execute({ bvid: BV })
    assert.equal(a.ok, false)
    assert.equal(a.note, '现在打不开。')
    assert.equal(b.ok, false)
    assert.equal(b.note, '现在打不开。')
    assert.deepEqual(client.calls, [])
  })
})

test('上网关着：评论开着也发不出评论和回复，说明也跟着写「这会儿还说不出去」', async () => {
  await withRoot(async (root) => {
    const dk = dateKey()
    await writeConfig(normalizeConfig({
      bili: { enabled: false },
      comment: { enabled: true, perDay: 1, replyPerDay: 2, window: ['00:00', '23:59'] },
    }), root)
    await seedLook(root, dk)
    await seedComment(root, dk)
    const client = fakeClient()

    const c = await postComment({ root, client, bvid: BV, text: '你好', dateKey: dk })
    const r = await postReply({ root, client, bvid: BV, parentRpid: 222, text: '嗯', dateKey: dk })
    assert.equal(c.ok, false)
    assert.match(c.why, /没开/)
    assert.equal(r.ok, false)
    assert.match(r.why, /没开/)

    const ctx = toolsCtx()
    registerSpeak(ctx, { root, client, speakEnabled: true })
    const speak = ctx._tools[0]
    const out = await speak.execute({ kind: 'comment', bvid: BV, text: '你好' }, { sessionId: 's' })
    assert.equal(out.ok, false)
    assert.equal(out.note, '这会儿不方便说。')
    // 执行时按真实配置同步：上网关着就算说不出去，下一轮的说明跟着变
    assert.doesNotMatch(speak.description, /留一条评论/)
    assert.match(speak.description, /这会儿还说不出去/)
    assert.deepEqual(client.calls, [], '一个 B 站接口都不该碰')

    // 身份文档两节都写「这会儿」
    const doc = await readFile((await writeSelfDoc(root)).file, 'utf8')
    assert.match(doc, /这会儿出不去/)
    assert.match(doc, /这会儿还说不出去/)
    assert.doesNotMatch(doc, /你还有一个工具 bili_speak/)
  })
  noteSpeakEnabled(false)
})

test('对照：上网开着、评论开着时，同一条评论发得出去', async () => {
  await withRoot(async (root) => {
    const dk = dateKey()
    await writeConfig(normalizeConfig({
      comment: { enabled: true, perDay: 1, replyPerDay: 2, window: ['00:00', '23:59'] },
    }), root)
    await seedLook(root, dk)
    const client = fakeClient()
    const c = await postComment({ root, client, bvid: BV, text: '你好', dateKey: dk })
    assert.equal(c.ok, true, c.why)
    assert.equal(client.calls.filter((x) => x[0] === 'replyAdd').length, 1)
    const doc = await readFile((await writeSelfDoc(root)).file, 'utf8')
    assert.match(doc, /你还有一个工具 bili_speak/)
  })
})

/** 窗口避开现在：tick 只做查回复这一件事，不去叫醒 */
function windowAwayFromNow() {
  const h = (new Date().getHours() + 3) % 24
  const p = (n) => String(n).padStart(2, '0')
  return [`${p(h)}:00`, `${p((h + 1) % 24)}:00`]
}

test('上网关着：定时查回复不去问 B 站，也不记「问过了」', async () => {
  await withRoot(async (root) => {
    await writeConfig(normalizeConfig({
      window: windowAwayFromNow(),
      bili: { enabled: false, minIntervalMs: 200, jitterMs: 0 },
      comment: { enabled: true, scanEveryMin: 5 },
    }), root)
    await seedComment(root)
    await withFetchSpy(async (urls) => {
      const s = startScheduler({ on: () => () => {} }, { root, sessionId: 's-main', log: () => {} })
      try {
        await s.tick()
      } finally { s.dispose() }
      assert.deepEqual(urls, [])
    })
    assert.equal((await readConfig(root)).comment.lastScanAt, '', '没问就不记，打开之后按「没问过」马上问一次')
  })
})

test('对照：上网开着时，同样的配置会去问、并记下问过', async () => {
  await withRoot(async (root) => {
    await writeConfig(normalizeConfig({
      window: windowAwayFromNow(),
      bili: { minIntervalMs: 200, jitterMs: 0 },
      comment: { enabled: true, scanEveryMin: 5 },
    }), root)
    await seedComment(root)
    await withFetchSpy(async (urls) => {
      const s = startScheduler({ on: () => () => {} }, { root, sessionId: 's-main', log: () => {} })
      try {
        await s.tick()
      } finally { s.dispose() }
      assert.ok(urls.length > 0, '开着时要真的去问')
    })
    assert.ok((await readConfig(root)).comment.lastScanAt)
  })
})

/** 叫醒用的假宿主：只要能拿到 agent、能 followup */
function wakeCtx() {
  const prompts = []
  const ctx = {
    tools: { register: () => () => {} },
    webServer: { register: () => () => {} },
    connection: { requestRejection: () => null },
    sessionController: {
      async create() {},
      async prompt(p) { prompts.push(p) },
      async resolveAgent(sessionId) { return { agent: { followup(m) { prompts.push({ sessionId, content: m?.content }) } } } },
    },
    logger: { info() {}, warn() {}, error() {} },
    on() { return () => {} },
    effect(fn) { fn() },
    get(k) { return ctx[k] },
  }
  return { ctx, prompts }
}

test('上网关着：叫醒时也不顺带扫回复', async () => {
  await withRoot(async (root) => {
    await writeConfig(normalizeConfig({
      bili: { enabled: false, minIntervalMs: 200, jitterMs: 0 },
      comment: { enabled: true, scanEveryMin: 0 },
      rules: { offers: false },
      memory: { sleepEveryDays: 0 },
    }), root)
    await seedComment(root)
    await withFetchSpy(async (urls) => {
      const { ctx, prompts } = wakeCtx()
      const r = await wakeNow(ctx, { root, force: true })
      assert.equal(r.ok, true, JSON.stringify(r))
      assert.equal(prompts.length, 1, '叫醒本身照常')
      assert.deepEqual(urls, [])
    })
  })
})

test('对照：上网开着时，叫醒会顺带去问有没有人回', async () => {
  await withRoot(async (root) => {
    await writeConfig(normalizeConfig({
      bili: { minIntervalMs: 200, jitterMs: 0 },
      comment: { enabled: true, scanEveryMin: 0 },
      rules: { offers: false },
      memory: { sleepEveryDays: 0 },
    }), root)
    await seedComment(root)
    await withFetchSpy(async (urls) => {
      const { ctx } = wakeCtx()
      const r = await wakeNow(ctx, { root, force: true })
      assert.equal(r.ok, true, JSON.stringify(r))
      assert.ok(urls.length > 0)
    })
  })
})

test('上网关着：设置页打开「发评论」那一格时，也不替她去问 B 站', async () => {
  await withRoot(async (root) => {
    await writeConfig(normalizeConfig({
      bili: { enabled: false, minIntervalMs: 200, jitterMs: 0 },
      comment: { enabled: true },
    }), root)
    await seedComment(root)
    const routes = []
    const webServer = { register: (def) => { routes.push(def); return () => {} } }
    registerObserve({
      get: (k) => (k === 'connection' ? { requestRejection: () => null } : k === 'webServer' ? webServer : undefined),
      webServer,
      tools: { register: () => {} },
      slots: { inject: () => {}, register: () => {} },
      effect: (fn) => fn(),
      on: () => {},
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    }, { root })
    const route = routes.find((r) => String(r.path || '').endsWith('/comment'))
    assert.ok(route, '必须有 /comment 路由')
    await withFetchSpy(async (urls) => {
      let status = 0
      let payload = null
      const res = { writeHead: (s) => { status = s }, end: (s) => { payload = JSON.parse(s || '{}') }, setHeader: () => {} }
      await route.handler({ method: 'GET', url: '/dsh-fish/comment', headers: {} }, res)
      assert.equal(status, 200)
      assert.equal(payload.waitingCount, 0)
      assert.deepEqual(urls, [])
    })
  })
})

// ------------------------------------------------------------- 设置页

test('设置页「允许她上网」读写 bili.enabled，不再写 browse.enabled', async () => {
  const src = await readFile(CLIENT, 'utf8')
  const toggle = src.slice(src.indexOf("Toggle({ label: '允许她上网'"))
  assert.match(toggle.slice(0, 200), /on: biliOn, onChange: setBiliOn/)
  assert.ok(src.includes('setBiliOn(cfg.bili?.enabled !== false)'), '读的是 bili.enabled')
  const m = src.match(/const buildConfig = \(\) => \(\{([\s\S]*?)\n {6}\}\)/)
  assert.ok(m, '必须能定位到 buildConfig 的字段表')
  const body = m[1]
  assert.match(body, /bili: \{ enabled: biliOn,/)
  const browseLine = body.split('\n').find((l) => /^\s*browse: \{/.test(l))
  assert.ok(browseLine, 'browse 那一行还在（topN / 热评 / 弹幕照常提交）')
  assert.doesNotMatch(browseLine, /enabled/, '不再从设置页写 browse.enabled')
})
