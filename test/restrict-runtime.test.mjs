/**
 * restrict-runtime.test.mjs —— 「她此刻手上有什么」各处说的是同一份（0.9.5 核对出的余项，接 #61 #64 #69）
 *
 * 收窄的名单是 DSH 启动那一刻算定的：守卫按它放行，改了设置要重启才换。
 * 0.9.5 里另外几处各看各的：
 *   ① 身份文档存完设置就当场重写，白名单、梦、定时三段却按配置写——从存完到重启这段时间，
 *      文档说她有，她一伸手就是「这件事我做不到」；
 *   ② /tools 只给 herTools（按注册记录现算、不看梦的开关），不给守卫真用的名单，界面没法照实摆；
 *   ③ 自检拿配置的 allow 当「宿主认过」的证据，可 #61 之后宿主这次没有的名字会被剔出收窄名单；
 *   ④ view 不给 visible 的宿主上，外部名字照旧整份交给 restrict，一次都收不窄（#61 的老样子）。
 *
 * 这里都按真的调用链测：registerToolRestrict + agent/created，再走 writeSelfDoc / /config / /tools / runChecks。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HER_TOOLS, FISH_TOOLS, registerToolRestrict, readRestrictState, currentAllowTools, forgetBlockedTools, rememberKnownTools } from '../lib/restrict.js'
import { forgetRegisteredTools, noteRegisteredTool } from '../lib/toolreg.js'
import { writeSelfDoc, selfDocPath } from '../lib/selfdoc.js'
import { writeConfig } from '../lib/store.js'
import { normalizeConfig } from '../lib/settings.js'
import { DREAM_BRIEF, scheduleBrief } from '../lib/persona.js'
import { registerObserve } from '../lib/observe.js'
import { runChecks } from '../lib/selfcheck.js'

const DREAM_LINE = DREAM_BRIEF.split('\n')[0]
const SCHEDULE_LINE = scheduleBrief(['schedule_create']).split('\n')[0]
const EXTRA_HEAD = '还放行了这几样：'

/** 能 on / emit 的假插件 ctx（registerToolRestrict 只用这两样）。 */
function busCtx() {
  const listeners = new Map()
  return {
    on(ev, fn) {
      if (!listeners.has(ev)) listeners.set(ev, [])
      listeners.get(ev).push(fn)
      return () => {}
    },
    emit(ev, payload) {
      for (const fn of listeners.get(ev) ?? []) fn(payload)
    },
  }
}

/**
 * 一个像真宿主的 agent：restrict 遇到不认识的名字就抛错（宿主原文的报错形状），
 * view 给 restrictableNames，`visible: false` 时模仿老宿主不给 visible。
 * `own` 是她自己那一层的名字：view 的 visible 里有、restrictableNames 里没有，restrict 点不了名。
 */
function hostAgent(cwd, names, { visible = true, own = [] } = {}) {
  const sent = []
  const guards = []
  const agent = {
    session: { header: { cwd, id: 's1' } },
    ctx: {
      effect() {},
      tools: {
        view: () => (visible
          ? { restrictableNames: new Set(names()), visible: new Map([...names(), ...own].map((n) => [n, {}])) }
          : { restrictableNames: new Set(names()) }),
        guard: (fn) => { guards.push(fn); return () => {} },
        restrict: ({ allow }) => {
          const known = new Set(names())
          const u = allow.find((n) => !known.has(n))
          if (u) throw new Error(`tools.restrict() names unknown global tool "${u}"; known global tools: ${[...known].join(', ')}`)
          sent.push(allow.slice())
          return () => {}
        },
      },
    },
  }
  return { agent, sent, guards }
}

/** 观测台路由用的假 ctx（同 test/p5.test.mjs）。 */
function observeCtx(root) {
  const routes = []
  const webServer = { register: (def) => { routes.push(def); return () => {} } }
  return {
    routes,
    get: (k) => (k === 'connection' ? { requestRejection: () => null } : k === 'webServer' ? webServer : undefined),
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

async function hit(routes, path, method = 'GET', body) {
  const route = routes.find((r) => String(r.path || '').endsWith(path))
  assert.ok(route, `要有 ${path} 路由`)
  const raw = body === undefined ? '' : JSON.stringify(body)
  let status = 0
  let payload = null
  await route.handler({
    method,
    url: `/dsh-fish${path}`,
    headers: { 'content-type': 'application/json' },
    on: (ev, fn) => { if (ev === 'data' && raw) fn(Buffer.from(raw, 'utf8')); if (ev === 'end') fn() },
  }, {
    writeHead: (s) => { status = s },
    setHeader: () => {},
    end: (s) => { payload = s ? JSON.parse(s) : null },
  })
  return { status, payload }
}

/** restrict.js / toolreg.js 的进程内记账复位：同一进程连着跑别的测试文件时，别让上一条的注册、快照、被挡记录串进来。 */
function resetModuleState() {
  forgetRegisteredTools()
  rememberKnownTools([])
  forgetBlockedTools()
}

async function withRoot(fn) {
  resetModuleState()
  const root = await mkdtemp(join(tmpdir(), 'fish-restrict-runtime-'))
  const herDir = join(root, 'home')
  try {
    return await fn(root, herDir)
  } finally {
    resetModuleState()
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

const docOf = async (root) => readFile(selfDocPath(root), 'utf8')
const until = async (cond, ms = 2000) => {
  const end = Date.now() + ms
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 5))
}

// ---------------------------------------------------------------------------
// ① 身份文档：白名单、梦、定时三段，收窄开着时按运行中的名单写
// ---------------------------------------------------------------------------

test('存了新的白名单、还没重启：身份文档不提前说她有，跟守卫说的一样（#64 / 0.9.5）', async () => {
  await withRoot(async (root, herDir) => {
    forgetBlockedTools()
    await writeConfig(normalizeConfig({}), root)
    const bus = busCtx()
    registerToolRestrict(bus, { herDir, extra: [], dream: true, log: () => {} })
    const host = hostAgent(herDir, () => [...HER_TOOLS, 'her_say', 'bash', 'schedule_create'])
    bus.emit('agent/created', { agent: host.agent })
    assert.equal(host.sent.length, 1, '前提：这一局真收窄了')

    const ctx = observeCtx(root)
    const obs = registerObserve(ctx, { root })
    try {
      // 设置页存白名单就是这一下：存完当场重写身份文档。
      const r = await hit(ctx.routes, '/config', 'POST', { tools: { restrict: true, allow: ['bash', 'schedule_create'] } })
      assert.equal(r.status, 200, JSON.stringify(r.payload))
      assert.deepEqual(r.payload.config.tools.allow, ['bash', 'schedule_create'], '前提：配置真的存进去了')

      const doc = await docOf(root)
      // 守卫还按启动时的名单拦它们……
      assert.match(host.guards[0]({ name: 'bash' }), /^这件事我做不到。/)
      assert.match(host.guards[0]({ name: 'schedule_create' }), /^这件事我做不到。/)
      // ……身份文档就不能先说她有。
      assert.ok(!doc.includes(EXTRA_HEAD), `还没到她手上的名字不该念给她：\n${doc}`)
      assert.ok(!/\bbash\b/.test(doc), '身份文档里不该出现 bash')
      assert.ok(!doc.includes(SCHEDULE_LINE), '定时那一段也要等重启之后才挂')
    } finally {
      obs?.dispose?.()
    }
  })
})

test('启动时放行了、之后从配置里删掉：重启前她手上还有，身份文档照实说（#64 / 0.9.5）', async () => {
  await withRoot(async (root, herDir) => {
    await writeConfig(normalizeConfig({ tools: { restrict: true, allow: [] } }), root)
    const bus = busCtx()
    registerToolRestrict(bus, { herDir, extra: ['bash', 'schedule_create'], dream: true, log: () => {} })
    const host = hostAgent(herDir, () => [...HER_TOOLS, 'her_say', 'bash', 'schedule_create'])
    bus.emit('agent/created', { agent: host.agent })
    assert.equal(host.guards[0]({ name: 'bash' }), undefined, '前提：守卫这一局放行 bash')

    await writeSelfDoc(root)
    const doc = await docOf(root)
    assert.ok(doc.includes(`${EXTRA_HEAD}bash、schedule_create。`), `运行中的白名单要念给她：\n${doc}`)
    assert.ok(doc.includes(SCHEDULE_LINE), '守卫放行着 schedule_create，定时那一段就该在')
  })
})

test('白名单里填了 her_say：工具注册前后，「还放行了这几样」那句不改口', async () => {
  await withRoot(async (root, herDir) => {
    // index.js 的顺序：先注册收窄、写身份文档，之后才注册工具（toolreg 的记账这时才有）。
    await writeConfig(normalizeConfig({ tools: { restrict: true, allow: ['her_say', 'bash'] } }), root)
    registerToolRestrict(busCtx(), { herDir, extra: ['her_say', 'bash'], dream: true, log: () => {} })
    await writeSelfDoc(root)
    const before = (await docOf(root)).split('\n').find((l) => l.includes(EXTRA_HEAD)) ?? ''
    assert.ok(before.includes('bash'), `前提：启动时那句念了白名单：${before}`)

    for (const n of [...FISH_TOOLS, 'her_say', 'bring_back']) noteRegisteredTool(n)
    await writeSelfDoc(root)
    const after = (await docOf(root)).split('\n').find((l) => l.includes(EXTRA_HEAD)) ?? ''
    assert.equal(after, before, '同一个进程、同一份守卫名单，那句话不能注册前一个说法、注册后另一个说法')
  })
})

test('收窄关着时身份文档照旧按配置写（工具面没被收窄，也没有守卫）', async () => {
  await withRoot(async (root, herDir) => {
    await writeConfig(normalizeConfig({ tools: { restrict: false, allow: ['bash'] } }), root)
    registerToolRestrict(busCtx(), { herDir, enabled: false, log: () => {} })
    assert.equal(currentAllowTools(), null, '前提：收窄这一局没在管')
    await writeSelfDoc(root)
    const doc = await docOf(root)
    assert.ok(doc.includes(`${EXTRA_HEAD}bash。`), doc)
  })
})

test('关着梦启动、之后在设置页打开：重启前身份文档不写 her_dream，守卫也拦（#64 / 0.9.5）', async () => {
  await withRoot(async (root, herDir) => {
    forgetBlockedTools()
    await writeConfig(normalizeConfig({ dream: { enabled: false } }), root)
    const bus = busCtx()
    registerToolRestrict(bus, { herDir, dream: false, log: () => {} })
    const host = hostAgent(herDir, () => [...HER_TOOLS, 'her_say'])
    bus.emit('agent/created', { agent: host.agent })
    assert.ok(!host.sent[0].includes('her_dream'), '前提：关着梦启动，名单里没有 her_dream')

    const ctx = observeCtx(root)
    const obs = registerObserve(ctx, { root })
    try {
      const r = await hit(ctx.routes, '/config', 'POST', { dream: { enabled: true } })
      assert.equal(r.status, 200, JSON.stringify(r.payload))
      const doc = await docOf(root)
      assert.match(host.guards[0]({ name: 'her_dream' }), /^这件事我做不到。/, '守卫要到重启才放 her_dream')
      assert.ok(!doc.includes(DREAM_LINE), `守卫还拦着 her_dream，身份文档不能先说她有：\n${doc}`)
    } finally {
      obs?.dispose?.()
    }
  })
})

test('开着梦启动：开关开着就写 her_dream，关掉当场不写（#64 的取舍不变）', async () => {
  await withRoot(async (root, herDir) => {
    await writeConfig(normalizeConfig({}), root)
    registerToolRestrict(busCtx(), { herDir, dream: true, log: () => {} })
    await writeSelfDoc(root)
    assert.ok((await docOf(root)).includes(DREAM_LINE), '开着梦启动，her_dream 在她手上')

    await writeConfig(normalizeConfig({ dream: { enabled: false } }), root)
    await writeSelfDoc(root)
    assert.ok(!(await docOf(root)).includes(DREAM_LINE), '关掉梦当场生效（工具自己也会答梦关着）')
  })
})

// ---------------------------------------------------------------------------
// ② /tools 把守卫真用的名单和真下给宿主的那份交给界面
// ---------------------------------------------------------------------------

test('/tools 交出 allowNow 与 effective：关着梦时没有 her_dream，宿主没有的 read_image 不算下过（#69 / 0.9.5）', async () => {
  await withRoot(async (root, herDir) => {
    forgetBlockedTools()
    const bus = busCtx()
    registerToolRestrict(bus, { herDir, dream: false, log: () => {} })
    const names = HER_TOOLS.filter((n) => n !== 'read_image') // 没挂附件服务
    const host = hostAgent(herDir, () => names)
    bus.emit('agent/created', { agent: host.agent })
    assert.equal(host.sent.length, 1, '前提：照常收窄了')

    const ctx = observeCtx(root)
    const obs = registerObserve(ctx, { root })
    try {
      const { status, payload } = await hit(ctx.routes, '/tools')
      assert.equal(status, 200)
      assert.ok(Array.isArray(payload.allowNow), `/tools 要给守卫真用的那份：${JSON.stringify(payload)}`)
      assert.deepEqual(payload.allowNow, currentAllowTools())
      assert.ok(!payload.allowNow.includes('her_dream'), '关着梦启动，守卫名单里没有 her_dream')
      assert.ok(payload.herTools.includes('her_dream'), 'herTools 仍然说「哪些是她的」，语义不变')
      assert.ok(Array.isArray(payload.effective), '/tools 要给真下给宿主的那份')
      assert.deepEqual(payload.effective, host.sent[0])
      assert.ok(!payload.effective.includes('read_image'), '宿主没有的名字没下过')
      assert.deepEqual(payload.skipped, ['read_image'])
    } finally {
      obs?.dispose?.()
    }
  })
})

test('/tools：收窄关着时 allowNow 是 null（不知道 ≠ 一件都没有）', async () => {
  await withRoot(async (root, herDir) => {
    registerToolRestrict(busCtx(), { herDir, enabled: false, log: () => {} })
    const ctx = observeCtx(root)
    const obs = registerObserve(ctx, { root })
    try {
      const { payload } = await hit(ctx.routes, '/tools')
      assert.equal(payload.allowNow, null)
      assert.equal(payload.effective, null)
    } finally {
      obs?.dispose?.()
    }
  })
})

// ---------------------------------------------------------------------------
// ③ 自检看真下给宿主的那份
// ---------------------------------------------------------------------------

test('没挂附件服务、read_image 被剔出收窄名单：「看画面」报红，「手上的工具」按真下给宿主的数（#61 / 0.9.5）', async () => {
  await withRoot(async (root, herDir) => {
    forgetBlockedTools()
    const bus = busCtx()
    registerToolRestrict(bus, { herDir, dream: true, log: () => {} })
    const names = HER_TOOLS.filter((n) => n !== 'read_image')
    const host = hostAgent(herDir, () => names)
    bus.emit('agent/created', { agent: host.agent })
    const R = readRestrictState()
    assert.ok(R.applied > 0 && R.allow.includes('read_image') && !R.effective.includes('read_image'), '前提：allow 里有、真下的没有')

    const res = await runChecks({
      root,
      config: normalizeConfig({}),
      host: {},
      tools: { get: (n) => (names.includes(n) ? { name: n } : undefined) },
      restrict: R,
      attachments: false,
      net: false,
    })
    const img = res.items.find((i) => i.id === 'read-image')
    assert.equal(img.ok, false, `宿主没有 read_image，「看画面」不能报绿：${img.detail}`)
    const tools = res.items.find((i) => i.id === 'tools')
    assert.ok(tools.detail.includes(`${R.effective.length} 个工具`), tools.detail)
    assert.ok(!tools.detail.includes(`${R.allow.length} 个工具`), `不能按配置的 allow 数：${tools.detail}`)
    assert.ok(tools.detail.includes('read_image 这台机器上这次没有'), tools.detail)
  })
})

test('read_image 真下过：「看画面」照旧报绿（宿主认过这个名字）', async () => {
  await withRoot(async (root, herDir) => {
    const bus = busCtx()
    registerToolRestrict(bus, { herDir, dream: true, log: () => {} })
    const host = hostAgent(herDir, () => [...HER_TOOLS])
    bus.emit('agent/created', { agent: host.agent })
    const R = readRestrictState()
    const res = await runChecks({
      root,
      config: normalizeConfig({}),
      host: {},
      tools: { get: (n) => (n === 'read_image' ? undefined : { name: n }) },
      restrict: R,
      net: false,
    })
    const img = res.items.find((i) => i.id === 'read-image')
    assert.equal(img.ok, true, img.detail)
    assert.match(img.detail, /宿主认了 read_image/)
  })
})

test('read_image 在她自己那一层（看得见、restrict 点不了名）：「看画面」和「手上的工具」说的是同一件事', async () => {
  await withRoot(async (root, herDir) => {
    const bus = busCtx()
    registerToolRestrict(bus, { herDir, dream: true, log: () => {} })
    const names = HER_TOOLS.filter((n) => n !== 'read_image')
    const host = hostAgent(herDir, () => names, { own: ['read_image'] })
    bus.emit('agent/created', { agent: host.agent })
    const R = readRestrictState()
    assert.ok(R.applied > 0 && !R.effective.includes('read_image') && !R.skipped.includes('read_image'), '前提：它在 own 层，没下给 restrict，也不算宿主没有')

    const res = await runChecks({
      root,
      config: normalizeConfig({}),
      host: {},
      tools: { get: (n) => (names.includes(n) ? { name: n } : undefined) },
      restrict: R,
      attachments: true,
      net: false,
    })
    const tools = res.items.find((i) => i.id === 'tools')
    assert.match(tools.detail, /read_image 在她自己那一层/, tools.detail)
    const img = res.items.find((i) => i.id === 'read-image')
    assert.equal(img.ok, true, img.detail)
    assert.ok(!img.detail.includes('查不准'), `「手上的工具」说她照样看得见 read_image，这里不能说查不准：${img.detail}`)
    assert.match(img.detail, /她自己那一层/, img.detail)
  })
})

test('她自己的工具被挡过（关着梦启动时的 her_dream）：自检的修法指到设置页能点的那一组', async () => {
  await withRoot(async (root, herDir) => {
    const bus = busCtx()
    registerToolRestrict(bus, { herDir, dream: false, log: () => {} })
    const host = hostAgent(herDir, () => [...HER_TOOLS])
    bus.emit('agent/created', { agent: host.agent })
    assert.match(host.guards[0]({ name: 'her_dream' }), /^这件事我做不到。/, '前提：守卫拦了 her_dream')

    const res = await runChecks({
      root,
      config: normalizeConfig({ dream: { enabled: false } }),
      host: {},
      tools: { get: (n) => ({ name: n }) },
      restrict: readRestrictState(),
      net: false,
    })
    const blk = res.items.find((i) => i.id === 'tools-blocked')
    assert.ok(blk, '被挡过就要有这一项')
    assert.match(blk.fix, /her_dream 是她自己的工具/, blk.fix)
    assert.match(blk.fix, /她自己的，这一局不在她手上/, `设置页把它摆在那一组，修法要指过去：${blk.fix}`)
    assert.match(blk.fix, /允许她记梦/, blk.fix)
  })
})

// ---------------------------------------------------------------------------
// ④ view 不给 visible 的宿主：别人的名字按 restrictableNames 剔掉，照常收窄
// ---------------------------------------------------------------------------

test('老宿主（view 不给 visible）没有 read_image、白名单多一个没注册的名字：照常收窄，不再延后（#61 / 0.9.5）', async () => {
  await withRoot(async (root, herDir) => {
    const bus = busCtx()
    const seen = []
    const logs = []
    registerToolRestrict(bus, {
      herDir,
      extra: ['qq_send_message'],
      dream: true,
      retryMs: 5,
      retryMax: 15,
      log: (m) => logs.push(m),
      onResult: (r) => seen.push(r),
    })
    const names = HER_TOOLS.filter((n) => n !== 'read_image')
    const host = hostAgent(herDir, () => names, { visible: false })
    bus.emit('agent/created', { agent: host.agent })
    await until(() => seen.some((r) => r.why === 'deferred' || r.why.startsWith('applied')), 1500)

    assert.equal(host.sent.length, 1, `应该收窄一次，而不是每拍都抛错直到 deferred：${seen.map((r) => r.why).join(',')}`)
    assert.ok(!host.sent[0].includes('read_image') && !host.sent[0].includes('qq_send_message'), '不在 restrictableNames 里的别人的名字不交给 restrict')
    for (const n of names) assert.ok(host.sent[0].includes(n), `${n} 是她的，一个都不能少`)
    assert.equal(host.guards[0]({ name: 'qq_send_message' }), undefined, '守卫照旧按配置放行：真在 own 层的她照样用得上')
    assert.ok(logs.some((m) => m.includes('qq_send_message') && m.includes('没交给它')), '剔掉的名字留一行日志，且不说成「这台机器上没有」')
  })
})

test('老宿主上自己的工具晚到：照旧等它们登记齐，晚到的外部名字宽限过后剔掉（#61 / 0.9.5）', async () => {
  await withRoot(async (root, herDir) => {
    const bus = busCtx()
    const seen = []
    registerToolRestrict(bus, { herDir, dream: true, retryMs: 5, retryMax: 30, log: () => {}, onResult: (r) => seen.push(r) })
    const own = HER_TOOLS.filter((n) => n !== 'read_image')
    let names = ['web_search']
    const host = hostAgent(herDir, () => names, { visible: false })
    setTimeout(() => { names = [...own, 'web_search'] }, 20)
    bus.emit('agent/created', { agent: host.agent })
    await until(() => seen.some((r) => r.why === 'deferred' || r.why === 'applied-late'), 2000)

    assert.equal(seen.at(-1).why, 'applied-late', seen.map((r) => r.why).join(','))
    assert.equal(host.sent.length, 1)
    assert.ok(host.sent[0].includes('growth_commit'), '自己的工具到了才收，不能少')
    assert.ok(!host.sent[0].includes('read_image'), '一直没来的 read_image 剔掉')
  })
})
