/**
 * p5.test.mjs —— 2026-10-23 这一轮的回归测试
 *
 * 守四件事：
 *   1. **三个时段各自独立**：把"醒来时间"改坏，不能顺手把"上网时间"也改掉。
 *   2. **上网时段真的生效**：不在时段里就不许碰 B 站接口（不是先请求再丢弃）。
 *   3. **保存不会被 400 挡回来**：观测台提交的 chat / memory / window / browse.window /
 *      bili 必须在 /config 的白名单里。曾漏登记过两次，界面点"保存"直接报错。
 *      现在有一条用例直接从 client.js 的 buildConfig() 反查这张白名单，不再靠手写清单。
 *   4. **设置界面文案不带性别代词**：她/他 在面向用户的字符串里必须为零。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import { normalizeConfig, inWindow, DEFAULTS } from '../lib/settings.js'
import { lookBeforeWake } from '../lib/scheduler.js'
import { registerObserve } from '../lib/observe.js'
import { HER_TOOLS, rememberFromView, registerToolRestrict, forgetBlockedTools, herToolNames, readRestrictState } from '../lib/restrict.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(HERE, '..', 'lib', 'client.js')
const OBSERVE = join(HERE, '..', 'lib', 'observe.js')

test('默认配置里上网时段是独立的一项', () => {
  const cfg = normalizeConfig({})
  assert.deepEqual(cfg.browse.window, ['08:00', '23:00'])
  assert.deepEqual(cfg.window, ['20:00', '23:00'])
  assert.deepEqual(cfg.comment.window, ['20:00', '23:00'])
})

test('坏时段只回退自己那一项，不牵连别的时段', () => {
  const cfg = normalizeConfig({
    window: ['乱写', '23:00'],
    browse: { window: ['09:00', '18:00'] },
    comment: { window: ['09:00', '09:00'] }, // 起止相同 = 无效
  })
  // 醒来时段坏了 → 回默认
  assert.deepEqual(cfg.window, DEFAULTS.window)
  // 上网时段是好的 → 必须原样保留，不能被上一条连坐
  assert.deepEqual(cfg.browse.window, ['09:00', '18:00'])
  // 说话时段起止相同 → 回它自己的默认，不跟 window 走
  assert.deepEqual(cfg.comment.window, DEFAULTS.comment.window)
})

test('上网时段支持跨零点', () => {
  const cfg = normalizeConfig({ browse: { window: ['22:00', '02:00'] } })
  const at = (h) => new Date(2026, 9, 23, h, 30, 0)
  assert.equal(inWindow({ window: cfg.browse.window }, at(23)), true)
  assert.equal(inWindow({ window: cfg.browse.window }, at(1)), true)
  assert.equal(inWindow({ window: cfg.browse.window }, at(12)), false)
})

test('不在上网时段时，一次 B 站接口都不发', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-p5-'))
  try {
    const calls = []
    const client = new Proxy({}, {
      get: (_t, k) => (...a) => { calls.push(String(k)); return { ok: false } },
    })
    const cfg = normalizeConfig({ browse: { window: ['09:00', '10:00'] } })
    const out = await lookBeforeWake(root, { name: '测试' }, cfg, '2026-10-23', {
      client,
      now: new Date(2026, 9, 23, 15, 0, 0), // 15:00，在时段外
      events: [],
    }, () => {})
    assert.deepEqual(out, { text: '', intro: '', picks: [] })
    assert.deepEqual(calls, [], '时段外不该碰任何接口')
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('在上网时段内会真的去取素材（证明闸门不是永远关着）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-p5b-'))
  try {
    const calls = []
    const client = new Proxy({}, {
      get: (_t, k) => (...a) => { calls.push(String(k)); return { ok: false, note: 'stub' } },
    })
    const cfg = normalizeConfig({ browse: { enabled: true, window: ['09:00', '18:00'] } })
    await lookBeforeWake(root, { name: '测试' }, cfg, '2026-10-23', {
      client,
      now: new Date(2026, 9, 23, 10, 0, 0),
      events: [],
    }, () => {})
    assert.ok(calls.length > 0, '时段内应该走进去')
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

/** 极简假 ctx：只提供 observe 需要的两个服务 */
function fakeCtx(root) {
  const routes = []
  const cfg = { connection: null }
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
    root,
  }
}

test('/config 白名单收下观测台提交的全部环境键（含 chat 与 memory）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-p5c-'))
  try {
    const ctx = fakeCtx(root)
    ctx.cfg.connection = { requestRejection: () => null }
    registerObserve(ctx, { root })
    const route = ctx.routes.find((r) => String(r.path || '').endsWith('/config'))
    assert.ok(route, '必须有 /config 路由')

    // 这是观测台 save() 实际提交的形状
    const patch = {
      absenceAfterDays: 3,
      wakesPerDay: 1,
      daily: { events: 1, questions: 1 },
      diary: { visible: true, enabled: true },
      avoid: { keywords: ['恐怖'] },
      window: ['19:00', '22:00'],
      browse: { enabled: true, perDay: 2, topN: 5, danmaku: 3, window: ['08:30', '22:30'] },
      // bili 是 2026-10-29 用户真机踩到的：0.6.5 加了这两个设置项，
      // 客户端整表提交一直带着它们，白名单漏登记 → 改任何一项都报 400。
      bili: { minIntervalMs: 900, jitterMs: 300 },
      notify: { enabled: false },
      chat: { rotateAfter: 30 },
      memory: { docBudget: 1500 },
      comment: { enabled: false, perDay: 1, replyPerDay: 2, replyToReplies: true, scanEveryMin: 30, window: ['20:00', '23:00'] },
    }
    const body = JSON.stringify(patch)
    const req = {
      method: 'POST',
      url: '/dsh-fish/config',
      headers: { 'content-type': 'application/json' },
      on: (ev, fn) => { if (ev === 'data') fn(Buffer.from(body, 'utf8')); if (ev === 'end') fn() },
    }
    let status = 0
    let payload = null
    const res = {
      writeHead: (s) => { status = s },
      end: (s) => { payload = JSON.parse(s || '{}') },
      setHeader: () => {},
    }
    await route.handler(req, res)
    assert.equal(status, 200, `保存不该被挡回来：${JSON.stringify(payload)}`)
    assert.equal(payload.ok, true)
    assert.deepEqual(payload.config.browse.window, ['08:30', '22:30'])
    assert.deepEqual(payload.config.window, ['19:00', '22:00'])
    assert.equal(payload.config.chat.rotateAfter, 30)
    assert.equal(payload.config.memory.docBudget, 1500)
    assert.equal(payload.config.bili.minIntervalMs, 900, '请求间隔必须真的存进去')
    assert.equal(payload.config.bili.jitterMs, 300, '请求抖动必须真的存进去')
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('观测台提交的每个顶层键都在 /config 白名单里（防漂移）', async () => {
  // 2026-10-29 用户真机报「没保存：不允许修改：bili」：0.6.5 加了 bili 两个设置项，
  // 客户端整表提交带着它，服务端白名单没登记 → **每一项设置都存不进去**。
  // 上一版回归测试手写了一份 patch 形状，自己也会漏，所以这里改成互相反查：
  //   客户端 buildConfig() 的顶层键 ←→ 服务端 allowed 数组，缺一个就红。
  const client = await readFile(CLIENT, 'utf8')
  const start = client.indexOf('const buildConfig = () => ({')
  assert.ok(start > 0, '找不到 buildConfig()')
  const end = client.indexOf('\n      })', start)
  assert.ok(end > start, '找不到 buildConfig() 的结尾')
  // 顶层键缩进 8 空格；子键缩进更深，正好靠缩进区分开。
  const keys = [...client.slice(start, end).matchAll(/^ {8}([a-zA-Z]+):/gm)].map((m) => m[1])
  assert.ok(keys.length >= 10, `buildConfig() 只解析出 ${keys.length} 个顶层键，缩进可能变了`)

  const server = await readFile(OBSERVE, 'utf8')
  const m = server.match(/const allowed = \[([^\]]+)\]/)
  assert.ok(m, '找不到 /config 的白名单')
  const allowed = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])

  const missing = keys.filter((k) => !allowed.includes(k))
  assert.deepEqual(missing, [], `这些键客户端会提交、服务端会 400 挡回来：${missing.join(', ')}`)
})

test('白名单仍然挡得住"指向她本人"的键', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-p5d-'))
  try {
    const ctx = fakeCtx(root)
    ctx.cfg.connection = { requestRejection: () => null }
    registerObserve(ctx, { root })
    const route = ctx.routes.find((r) => String(r.path || '').endsWith('/config'))
    const body = JSON.stringify({ persona: { name: '小美' }, traits: { shy: 1 } })
    const req = {
      method: 'POST',
      url: '/dsh-fish/config',
      headers: { 'content-type': 'application/json' },
      on: (ev, fn) => { if (ev === 'data') fn(Buffer.from(body, 'utf8')); if (ev === 'end') fn() },
    }
    let status = 0
    let payload = null
    const res = { writeHead: (s) => { status = s }, end: (s) => { payload = JSON.parse(s || '{}') }, setHeader: () => {} }
    await route.handler(req, res)
    assert.equal(status, 400)
    // 报错会原样显示在界面上：得是人话，不能是「不允许修改：persona」那种开发者口吻。
    assert.match(payload.error, /这一版还不支持保存/, `报错要能看懂：${payload.error}`)
    assert.doesNotMatch(payload.error, /不允许修改/, '别再用「不允许修改」这种说法')
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('设置界面面向用户的文案里不出现男字旁的「他」', async () => {
  const src = await readFile(CLIENT, 'utf8')
  // 只扫字符串字面量，注释不算（注释里保留原话便于追溯）。
  //
  // 口径在 2026-10-24 改过：早期要求「她/他」都为零，是想让界面完全不用
  // 人称代词；后来用户在文案面板里亲手把 15 处「它」改成了「她」，等于
  // 选定了「她」这个写法。规则跟着用户的决定走 —— 现在只禁男字旁的「他」，
  // 「她」是选定写法，「它」留给真正指物的句子（AGENTS.md、事件流、插件）。
  const bad = []
  const re = /(['"`])((?:[^'"`\\\n]|\\.)*)\1/g
  let m
  while ((m = re.exec(src))) {
    // 例外：`其他/其它` 里的「他」是词素（意思是「别的」），不是人称代词。
    const shorn = m[2].replace(/其[他它]/g, '')
    if (/他/.test(shorn)) bad.push(m[2].slice(0, 40))
  }
  assert.deepEqual(bad, [], '面向用户的字符串里不许出现「他」')
})

test('own 层的 ops_* 能存进白名单，且 /tools 会说明「收窄挡不住它」（2026-10-29）', async () => {
  // 用户真机：想把 dsh-ops 的 ops_bash 写进白名单，输入框一直报「名字不存在」。
  // 原因是 knownToolNames 只收 restrictableNames，而 ops_* 注册在 agent 自身作用域。
  // 现在收 restrictable ∪ visible；但下给 restrict() 的仍然只有收得窄的那批。
  const root = await mkdtemp(join(tmpdir(), 'fish-p5e-'))
  try {
    rememberFromView({
      restrictableNames: new Set([...HER_TOOLS]),
      visible: new Map([...HER_TOOLS.map((n) => [n, {}]), ['ops_bash', {}]]),
    })
    const ctx = fakeCtx(root)
    ctx.cfg.connection = { requestRejection: () => null }
    registerObserve(ctx, { root })

    const tools = ctx.routes.find((r) => String(r.path || '').endsWith('/tools'))
    let payload = null
    const res = {
      writeHead: () => {},
      end: (s) => { payload = JSON.parse(s || '{}') },
      setHeader: () => {},
    }
    await tools.handler({ method: 'GET', url: '/dsh-fish/tools', headers: {} }, res)
    assert.ok(payload.known.includes('ops_bash'), '白名单校验必须认得这个名字')
    assert.deepEqual(payload.ownLayer, ['ops_bash'], 'own 层名单用来解释「加进来只是让守卫放行」')

    const config = ctx.routes.find((r) => String(r.path || '').endsWith('/config'))
    const body = JSON.stringify({ tools: { restrict: true, allow: ['ops_bash', 'read_image'] } })
    const req = {
      method: 'POST',
      url: '/dsh-fish/config',
      headers: { 'content-type': 'application/json' },
      on: (ev, fn) => { if (ev === 'data') fn(Buffer.from(body, 'utf8')); if (ev === 'end') fn() },
    }
    let status = 0
    let saved = null
    await config.handler(req, {
      writeHead: (s) => { status = s },
      end: (s) => { saved = JSON.parse(s || '{}') },
      setHeader: () => {},
    })
    assert.equal(status, 200, `ops_bash 该存得进去：${JSON.stringify(saved)}`)
    assert.deepEqual(saved.config.tools.allow, ['ops_bash', 'read_image'])
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('config 里留着一个早就不存在的工具名，不该让整页设置都存不进去（2026-10-31 issue #14）', async () => {
  // 用户那台机器：config.json 的 tools.allow 里有个裸的 `delete`（0.8.1）。
  // 设置页的自动保存是**整表提交**，于是改任何一个开关都会 400，横幅还说是
  // 「插件这一版还没接上它」——方向完全错了，而且他得手动翻进白名单框删名字才能解锁。
  const root = await mkdtemp(join(tmpdir(), 'fish-p5f-'))
  try {
    rememberFromView({
      restrictableNames: new Set([...HER_TOOLS]),
      visible: new Map([...HER_TOOLS.map((n) => [n, {}])]),
    })
    const ctx = fakeCtx(root)
    ctx.cfg.connection = { requestRejection: () => null }
    registerObserve(ctx, { root })
    const config = ctx.routes.find((r) => String(r.path || '').endsWith('/config'))

    const post = async (payload) => {
      const body = JSON.stringify(payload)
      const req = {
        method: 'POST',
        url: '/dsh-fish/config',
        headers: { 'content-type': 'application/json' },
        on: (ev, fn) => { if (ev === 'data') fn(Buffer.from(body, 'utf8')); if (ev === 'end') fn() },
      }
      let status = 0
      let out = null
      await config.handler(req, {
        writeHead: (s) => { status = s },
        end: (s) => { out = JSON.parse(s || '{}') },
        setHeader: () => {},
      })
      return { status, out }
    }

    // 整表提交（buildConfig 的形状），白名单里混一个这台机器上没有的名字 + 改一个无关设置
    const { status, out } = await post({
      tools: { restrict: true, allow: ['delete', 'read_image'] },
      wakesPerDay: 3,
    })
    assert.equal(status, 200, `不该整表拒掉：${JSON.stringify(out)}`)
    assert.deepEqual(out.config.tools.allow, ['read_image'], '坏名字丢掉，好的留下')
    assert.deepEqual(out.droppedTools, ['delete'], '丢掉了哪些要原样告诉界面')
    assert.equal(out.config.wakesPerDay, 3, '同一张表里别的设置必须照常存进去')
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('整张表全是坏名字时也只是白名单清空，不报错', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-p5g-'))
  try {
    rememberFromView({
      restrictableNames: new Set([...HER_TOOLS]),
      visible: new Map([...HER_TOOLS.map((n) => [n, {}])]),
    })
    const ctx = fakeCtx(root)
    ctx.cfg.connection = { requestRejection: () => null }
    registerObserve(ctx, { root })
    const config = ctx.routes.find((r) => String(r.path || '').endsWith('/config'))
    const body = JSON.stringify({ tools: { restrict: true, allow: ['delete', 'remove'] } })
    const req = {
      method: 'POST',
      url: '/dsh-fish/config',
      headers: { 'content-type': 'application/json' },
      on: (ev, fn) => { if (ev === 'data') fn(Buffer.from(body, 'utf8')); if (ev === 'end') fn() },
    }
    let status = 0
    let out = null
    await config.handler(req, {
      writeHead: (s) => { status = s },
      end: (s) => { out = JSON.parse(s || '{}') },
      setHeader: () => {},
    })
    assert.equal(status, 200)
    assert.deepEqual(out.config.tools.allow, [])
    assert.deepEqual(out.droppedTools, ['delete', 'remove'])
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

// ---------------------------------------------------------------------------
// /tools 要把「被挡过什么」「她自己本来就有什么」也一起交出来（2026-11-04，issue #20）
//
// 以前设置页只知道「这台机器上有哪些工具名字」：能核对拼写，说不清
// 「这两只她本来就有，加白名单只是让守卫放行」，更看不见「她伸手够过、被挡了」。
// ---------------------------------------------------------------------------

test('/tools 多给三样：herTools 只读清单、blocked 被挡记录、ownLayer 照旧', async () => {
  forgetBlockedTools()
  const root = await mkdtemp(join(tmpdir(), 'fish-p5f-'))
  try {
    rememberFromView({
      restrictableNames: new Set([...HER_TOOLS, 'vision_describe']),
      visible: new Map([...HER_TOOLS.map((n) => [n, {}]), ['ops_bash', {}]]),
    })
    const ctx = fakeCtx(root)
    ctx.cfg.connection = { requestRejection: () => null }
    registerObserve(ctx, { root })

    // 制造一条真的「被挡」：挂守卫、撞它
    const listeners = new Map()
    const guards = []
    const gctx = {
      on: (ev, fn) => { if (!listeners.has(ev)) listeners.set(ev, []); listeners.get(ev).push(fn); return () => {} },
      emit: (ev, p) => { for (const fn of listeners.get(ev) ?? []) fn(p) },
    }
    // 和 index.js 一样装上 her_dream / her_say（0.9.0 起公开）。
    registerToolRestrict(gctx, { herDir: 'C:\\h', log: () => {}, dream: true, proactive: true })
    gctx.emit('agent/created', {
      agent: {
        session: { header: { cwd: 'C:\\h' } },
        ctx: { tools: { restrict: () => () => {}, guard: (fn) => { guards.push(fn); return () => {} } }, effect: () => {} },
      },
    })
    guards[0]({ name: 'vision_describe' })

    const tools = ctx.routes.find((r) => String(r.path || '').endsWith('/tools'))
    let payload = null
    await tools.handler({ method: 'GET', url: '/dsh-fish/tools', headers: {} }, {
      writeHead: () => {},
      end: (s) => { payload = JSON.parse(s || '{}') },
      setHeader: () => {},
    })

    // issue #69：这里原来钉的是 herTools === HER_TOOLS。可 her_say 是启动时才加进
    // 收窄名单的，不在 HER_TOOLS 里，设置页于是把它摆进了「这台机器上还有这些」。
    // 现在 herTools 和收窄放行的底子是同一份。
    assert.deepEqual(payload.herTools, [...HER_TOOLS, 'her_say'], '她自己那几件要能原样交代给界面')
    assert.deepEqual(payload.herTools, readRestrictState().allow, '和收窄放行的是同一份（这里没有额外放行）')
    assert.ok(payload.herTools.includes('growth_commit'))
    assert.deepEqual(payload.ownLayer, ['ops_bash'], 'ownLayer 的语义不能变（老界面靠它解释白名单）')
    assert.equal(payload.blocked.length, 1)
    assert.equal(payload.blocked[0].name, 'vision_describe')
    assert.equal(payload.blocked[0].count, 1)
    // 第三方工具在 known 里看得见：名字本身不重要，能被放行才是重点
    assert.ok(payload.known.includes('vision_describe'))
  } finally {
    forgetBlockedTools()
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})


// issue #69：her_say 是她自己的（index.js 无条件注册、收窄无条件放行），
// 设置页却把它列进「这台机器上还有这些（装了但没放行）」。
test('/tools 的 herTools 含 her_say，和收窄用同一份名单；收窄关着时也一样', async () => {
  forgetBlockedTools()
  const root = await mkdtemp(join(tmpdir(), 'fish-p5h-'))
  try {
    rememberFromView({
      restrictableNames: new Set([...HER_TOOLS, 'her_say', 'web_search']),
      visible: new Map([...HER_TOOLS, 'her_say', 'web_search'].map((n) => [n, {}])),
    })
    const ctx = fakeCtx(root)
    ctx.cfg.connection = { requestRejection: () => null }
    registerObserve(ctx, { root })
    const tools = ctx.routes.find((r) => String(r.path || '').endsWith('/tools'))
    const get = async () => {
      let payload = null
      await tools.handler({ method: 'GET', url: '/dsh-fish/tools', headers: {} }, {
        writeHead: () => {},
        end: (s) => { payload = JSON.parse(s || '{}') },
        setHeader: () => {},
      })
      return payload
    }
    // 设置页（lib/client.js）的分桶：不在 herTools / ownLayer / blocked 里的才算「装了但没放行」。
    const others = (p) => p.known.filter((n) => !p.herTools.includes(n) && !p.ownLayer.includes(n)
      && !p.blocked.some((b) => b.name === n))

    const noop = { on: () => () => {} }
    for (const enabled of [true, false]) {
      registerToolRestrict(noop, { herDir: 'C:\\h', log: () => {}, enabled, dream: true, proactive: true })
      const p = await get()
      assert.ok(p.herTools.includes('her_say'), `收窄${enabled ? '开' : '关'}着时 herTools 都要有 her_say`)
      assert.deepEqual(p.herTools, herToolNames({ dream: true, proactive: true }), '和收窄用的是同一个函数算的')
      // 认得的名字在进程里只增不减（别的用例记下的也在），所以只看这两个。
      assert.ok(!others(p).includes('her_say'), 'her_say 不该再出现在「这台机器上还有这些」')
      assert.ok(others(p).includes('web_search'), '真没放行的照旧在那一组')
    }
    // 白名单里额外放行的不算她自己的。
    registerToolRestrict(noop, { herDir: 'C:\\h', log: () => {}, extra: ['web_search'], dream: true, proactive: true })
    const p = await get()
    assert.deepEqual(p.herTools, [...HER_TOOLS, 'her_say'])
  } finally {
    forgetBlockedTools()
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
