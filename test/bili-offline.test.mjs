/**
 * bili-offline.test.mjs —— 「允许她上网」关着时，各处说的话要对得上（issue #62 的后续）
 *
 * 0.9.5 把能不能上 B 站收进了 biliOn()，可还有几处只看自己那颗开关：
 *   - bili_speak 的工具说明只看 comment.enabled：断网时说明写「可以留评论」，
 *     身份文档却写「这会儿还说不出去」；说明还在注册时被展开成死值，开关翻了也不变。
 *   - 设置页发评论那张卡：断网时服务端根本没去查回复，卡上却印「没有新回复」。
 *   - 设置页「上网」那几张卡的说明，有几句和代码对不上。
 *
 * 全部用假宿主 / 假 React，fetch 换成一调就抛错的假的，不联网。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { registerSpeak } from '../lib/speak.js'
import { registerObserve } from '../lib/observe.js'
import { apply } from '../lib/index.js'
import { normalizeConfig, updateConfig } from '../lib/settings.js'
import { paths, writeConfig } from '../lib/store.js'
import { selfDocPath } from '../lib/selfdoc.js'

const CLIENT = fileURLToPath(new URL('../lib/client.js', import.meta.url))

/** 能发出去的那一版说明里才有的话 */
const SPEAK_ON = /可以给你今天看过的某个视频留一条评论/
/** 关着的那一版 */
const SPEAK_OFF = /这会儿还说不出去/

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fish-bili-offline-'))
  // apply() 会往家谱里记一笔；不隔离就写进真实的那本（同 boot.test.mjs）。
  const oldHomes = process.env.DSH_FISH_HOMES
  process.env.DSH_FISH_HOMES = join(root, 'homes.json')
  const realFetch = globalThis.fetch
  const asked = []
  globalThis.fetch = async (url) => { asked.push(String(url)); throw new Error('这个测试不联网') }
  try {
    await mkdir(paths(root).root, { recursive: true })
    return await fn(root, asked)
  } finally {
    globalThis.fetch = realFetch
    if (oldHomes === undefined) delete process.env.DSH_FISH_HOMES
    else process.env.DSH_FISH_HOMES = oldHomes
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

async function waitFor(fn, ms = 5000) {
  const t0 = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - t0 > ms) return v
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** 假宿主：够 apply() 走完启动、把工具和路由登记下来 */
function fakeHost() {
  const tools = new Map()
  const routes = []
  const ctx = {
    tools: { register: (spec) => { tools.set(spec.name, spec); return () => tools.delete(spec.name) } },
    webServer: { register: (r) => { routes.push(r); return () => {} } },
    connection: { requestRejection: () => null },
    sessionController: {
      async create() {},
      async prompt() {},
      async resolveAgent() { return { agent: { followup() {} } } },
    },
    logger: { info() {}, warn() {}, error() {} },
    on() {},
    get(key) { return ctx[key] },
  }
  return { ctx, tools, routes }
}

// ---------------------------------------------------------------- bili_speak 的说明

test('bili_speak：断网、评论开着，调一次之后说明换成关着的那一版', async () => {
  await withRoot(async (root) => {
    await writeConfig(normalizeConfig({ bili: { enabled: false }, comment: { enabled: true } }), root)
    const defs = []
    // 启动时还是开着的（比如启动之后才去设置页关掉上网）
    registerSpeak({ tools: { register: (d) => { defs.push(d); return () => {} } } }, { root, speakEnabled: true })
    const def = defs.find((d) => d.name === 'bili_speak')
    assert.match(def.description, SPEAK_ON, '前提：启动时是开着的那一版')

    const out = await def.execute({ kind: 'comment', bvid: 'BV1xx411c7mD', text: '你好' })
    assert.equal(out.ok, false)
    // 说明要跟身份文档同一个判据：上不了网就是说不出去
    assert.doesNotMatch(def.description, SPEAK_ON, `断网了说明还在许诺能留评论：${def.description}`)
    assert.match(def.description, SPEAK_OFF)
  })
})

test('bili_speak：对照——上网和评论都开着，调一次之后说明是开着的那一版', async () => {
  await withRoot(async (root, asked) => {
    await writeConfig(normalizeConfig({ bili: { enabled: true }, comment: { enabled: true } }), root)
    const defs = []
    // 假 client：这一条没看过，postComment 停在「没看」上，不会真发
    const client = { view: async () => ({ ok: false, message: '假的' }), replyAdd: async () => ({ ok: false, message: '假的' }) }
    registerSpeak({ tools: { register: (d) => { defs.push(d); return () => {} } } }, { root, speakEnabled: false, client })
    const def = defs.find((d) => d.name === 'bili_speak')
    assert.match(def.description, SPEAK_OFF)
    await def.execute({ kind: 'comment', bvid: 'BV1xx411c7mD', text: '你好' })
    assert.match(def.description, SPEAK_ON)
    assert.deepEqual(asked, [], '不该联网')
  })
})

test('启动时就断网、评论开着：bili_speak 一注册就是关着的那一版', async () => {
  await withRoot(async (root) => {
    await writeConfig(normalizeConfig({ bili: { enabled: false }, comment: { enabled: true } }), root)
    const { ctx, tools } = fakeHost()
    const h = apply(ctx, { root })
    try {
      const def = await waitFor(() => tools.get('bili_speak'))
      assert.ok(def, '启动没走完：bili_speak 没注册上')
      assert.doesNotMatch(def.description, SPEAK_ON, `断网启动，说明却许诺能留评论：${def.description}`)
      assert.match(def.description, SPEAK_OFF)
    } finally {
      h.dispose?.()
    }
  })
})

test('启动之后才关掉上网：真启动注册出来的 bili_speak，她调一次之后说明也跟着变', async () => {
  await withRoot(async (root) => {
    await writeConfig(normalizeConfig({ bili: { enabled: true }, comment: { enabled: true } }), root)
    const { ctx, tools } = fakeHost()
    const h = apply(ctx, { root })
    try {
      const def = await waitFor(() => tools.get('bili_speak'))
      assert.ok(def, '启动没走完：bili_speak 没注册上')
      assert.match(def.description, SPEAK_ON, '前提：启动时两颗都开着')

      await updateConfig({ bili: { enabled: false } }, root)
      const out = await def.execute({ kind: 'comment', bvid: 'BV1xx411c7mD', text: '你好' })
      assert.equal(out.ok, false)
      // 宿主拿到的是注册时那一份定义；说明得是活的，不能在注册那一刻定格
      assert.doesNotMatch(def.description, SPEAK_ON, `关掉上网之后说明还是旧的：${def.description}`)
      assert.match(def.description, SPEAK_OFF)
    } finally {
      h.dispose?.()
    }
  })
})

/** 照设置页的样子往 /config 存一份改动（自动保存走的就是这条路） */
async function postConfig(routes, patch) {
  const route = routes.find((r) => r.path === '/dsh-fish/config')
  assert.ok(route, '必须有 /config 路由')
  const body = JSON.stringify(patch)
  const req = {
    method: 'POST',
    url: '/dsh-fish/config',
    headers: { 'content-type': 'application/json' },
    on: (ev, fn) => { if (ev === 'data') fn(Buffer.from(body, 'utf8')); if (ev === 'end') fn() },
  }
  let status = 0
  let out = null
  await route.handler(req, { writeHead: (s) => { status = s }, end: (s) => { out = JSON.parse(s || '{}') }, setHeader: () => {} })
  assert.equal(status, 200, `保存没成功：${JSON.stringify(out)}`)
  return out
}

test('在设置页关掉上网、她还没调过 bili_speak：说明当场换成关着的那一版，和身份文档一起', async () => {
  await withRoot(async (root, asked) => {
    await writeConfig(normalizeConfig({ bili: { enabled: true }, comment: { enabled: true } }), root)
    const { ctx, tools, routes } = fakeHost()
    const h = apply(ctx, { root })
    try {
      const def = await waitFor(() => tools.get('bili_speak'))
      assert.ok(def, '启动没走完：bili_speak 没注册上')
      assert.ok(await waitFor(() => routes.find((r) => r.path === '/dsh-fish/config')), '启动没走完：/config 没登记')
      assert.match(def.description, SPEAK_ON, '前提：启动时两颗都开着')

      // 不调 execute：保存完、她下一轮开口之前，宿主序列化工具表读到的就该是新的那一版
      await postConfig(routes, { bili: { enabled: false } })
      assert.doesNotMatch(def.description, SPEAK_ON, `设置页关掉上网之后，说明还在许诺能留评论：${def.description}`)
      assert.match(def.description, SPEAK_OFF)
      // 身份文档那边同一刻已经是「说不出去」，两边要对得上
      const doc = await readFile(selfDocPath(root), 'utf8')
      assert.match(doc, SPEAK_OFF, '前提：身份文档保存后已经重写成说不出去')

      // 再打开，也当场换回来
      await postConfig(routes, { bili: { enabled: true } })
      assert.match(def.description, SPEAK_ON)
      assert.deepEqual(asked, [], '不该联网')
    } finally {
      h.dispose?.()
    }
  })
})

// ---------------------------------------------------------------- 设置页 /comment

async function getJson(routes, suffix) {
  const route = routes.find((r) => String(r.path || '').endsWith(suffix))
  assert.ok(route, `必须有 ${suffix} 路由`)
  let status = 0
  let body = ''
  const res = { writeHead: (s) => { status = s }, end: (s) => { body = String(s ?? '') }, setHeader: () => {} }
  await route.handler({ method: 'GET', url: `/dsh-fish${suffix}`, headers: {} }, res)
  assert.equal(status, 200)
  return JSON.parse(body)
}

function observeRoutes(root) {
  const routes = []
  const ctx = {
    get: (k) => (k === 'connection'
      ? { requestRejection: () => null }
      : k === 'webServer'
        ? { register: (def) => { routes.push(def); return () => {} } }
        : undefined),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }
  registerObserve(ctx, { root })
  return routes
}

test('GET /comment：断网时告诉页面「没去查」，不让 0 条冒充「没人回」', async () => {
  await withRoot(async (root, asked) => {
    await writeConfig(normalizeConfig({ bili: { enabled: false }, comment: { enabled: true } }), root)
    const body = await getJson(observeRoutes(root), '/comment')
    assert.equal(body.enabled, true)
    assert.equal(body.waitingCount, 0)
    assert.equal(body.online, false, '页面得知道这次没去查')
    assert.deepEqual(asked, [], '断网时不该去问 B 站')
  })
})

test('GET /comment 与 /browse：对照——上网开着时 online 为真', async () => {
  await withRoot(async (root) => {
    await writeConfig(normalizeConfig({ bili: { enabled: true }, comment: { enabled: true } }), root)
    const routes = observeRoutes(root)
    assert.equal((await getJson(routes, '/comment')).online, true)
    assert.equal((await getJson(routes, '/browse')).online, true)
  })
})

test('GET /browse：自动逛与能不能出门分开报', async () => {
  await withRoot(async (root) => {
    await writeConfig(normalizeConfig({ bili: { enabled: false }, browse: { enabled: true } }), root)
    const body = await getJson(observeRoutes(root), '/browse')
    assert.equal(body.enabled, true, 'enabled 仍是「自动逛」那颗')
    assert.equal(body.online, false)
  })
})

// ---------------------------------------------------------------- 设置页「上网」那一页（真渲染）

/** 假 React：h() 产出普通对象；useState 按调用顺序取预置值（同 client.test.mjs） */
function fakeReact(initialState = {}) {
  let cursor = 0
  const h = (type, props, ...children) => ({
    type,
    props: props || {},
    children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false),
  })
  return {
    createElement: h,
    useState: (init) => {
      const idx = cursor++
      return [idx in initialState ? initialState[idx] : typeof init === 'function' ? init() : init, () => {}]
    },
    useCallback: (fn) => fn,
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: (init) => ({ current: init }),
    resetCursor() { cursor = 0 },
  }
}

/** FishSection 里第几个 useState 是这个名字（从源码顺序数，加了新 state 不用改这里） */
function stateIndex(src, name) {
  const body = src.slice(src.indexOf('function FishSection()'))
  const names = [...body.matchAll(/const \[(\w+), set\w+\] = useState\(/g)].map((m) => m[1])
  const i = names.indexOf(name)
  assert.ok(i >= 0, `FishSection 里找不到 useState：${name}`)
  return i
}

/** 把「上网」那一页真的渲染一遍，state 按名字给 */
async function renderBiliPage(states = {}) {
  const src = await readFile(CLIENT, 'utf8')
  const init = { [stateIndex(src, 'tab')]: 'bili' }
  for (const [k, v] of Object.entries(states)) init[stateIndex(src, k)] = v
  const react = fakeReact(init)
  const loaded = []
  const window = { __ModuleLoader__: { load(spec) { loaded.push(spec) } } }
  const document = { querySelector: () => null, createElement: () => ({ setAttribute() {}, textContent: '' }), head: { appendChild() {} } }
  const req = (id) => { if (id === 'react') return react; throw new Error(`unexpected require: ${id}`) }
  new Function('window', 'require', 'document', src)(window, req, document)
  const exports = loaded[0].factory(req)
  react.resetCursor()
  const tree = exports.FishSection()
  const text = textOf(tree).join(' ')
  assert.ok(text.includes('允许她上网（B 站）'), '「上网」那一页没渲染出来（tab 的 state 对不上了）')
  return { tree, text }
}

function textOf(node, out = []) {
  if (node == null || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const n of node) textOf(n, out); return out }
  if (node.children) for (const c of node.children) textOf(c, out)
  return out
}

/** 找出含这段文字的元素，连同它的祖先链 */
function ancestorsOf(node, needle, chain = []) {
  if (node == null || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const n of node) { const r = ancestorsOf(n, needle, chain); if (r) return r }
    return null
  }
  const here = [...chain, node]
  for (const c of node.children ?? []) {
    if (typeof c === 'string' && c.includes(needle)) return here
    const r = ancestorsOf(c, needle, here)
    if (r) return r
  }
  return null
}

const CM = { usedToday: 0, perDay: 1, replyUsedToday: 0, replyPerDay: 2, waitingCount: 0, waitingOwnerCount: 0 }

test('发评论那张卡：断网时说没去查，不印「没有新回复」', async () => {
  const { text } = await renderBiliPage({ commentOn: true, cm: { ...CM, enabled: true, online: false } })
  assert.ok(text.includes('今天：发了 0/1 条'), '状态行要在')
  assert.ok(!text.includes('没有新回复'), '断网时根本没去查，不能说没有新回复')
  assert.ok(text.includes('没去查新回复'))
})

test('发评论那张卡：对照——上网开着、真没人回时照旧说「没有新回复」', async () => {
  const { text } = await renderBiliPage({ commentOn: true, cm: { ...CM, enabled: true, online: true } })
  assert.ok(text.includes('没有新回复'))
  assert.ok(!text.includes('没去查新回复'))
})

test('「上网」那张卡：两个控件不再被包进说明那一行（<p class="hint">）', async () => {
  const { tree } = await renderBiliPage()
  for (const label of ['允许她上网（B 站）', '上网时间段（未成年人模式）']) {
    const chain = ancestorsOf(tree, label)
    assert.ok(chain, `找不到「${label}」`)
    assert.ok(!chain.some((n) => n.type === 'p'), `「${label}」被包在 <p> 里：${chain.map((n) => n.type).join(' > ')}`)
  }
})

test('「上网」那一页的说明跟代码对得上', async () => {
  const { text } = await renderBiliPage()
  // 关掉「允许她上网」之后 bili_look 也被拒，不是「翻视频照常」
  assert.ok(!text.includes('翻视频照常'))
  assert.ok(text.includes('关掉后她自己翻视频、看画面、发评论都用不了'))
  // 自动逛不叫醒的是她
  assert.ok(!text.includes('不叫醒你'))
  // 「每天最多刷几次」只有自动逛读，选 0 她照样能自己出门
  assert.ok(!text.includes('从不上网'))
  assert.ok(text.includes('0 次 · 不自动逛'))
  assert.ok(text.includes('只管自动逛'))
  // 屏蔽名单现在也管点名看画面（最短时长除外）
  assert.ok(!text.includes('不管看画面'))
  assert.ok(text.includes('翻视频和点名看画面都管'))
})

test('看过的视频那张卡：断网时不说「她自己临时去看不受影响」', async () => {
  const browse = { enabled: false, online: false, perDay: 1, usedToday: 0, topN: 4, items: [], watched: [], handed: [] }
  const off = await renderBiliPage({ browse })
  assert.ok(!off.text.includes('不受影响'), '「允许她上网」关着时她自己也出不去')
  assert.ok(off.text.includes('她自己也打不开视频'))

  const on = await renderBiliPage({ browse: { ...browse, online: true } })
  assert.ok(on.text.includes('今天没开自动逛（她自己临时去看不受影响）。'), '对照：能出门时照旧')
})
