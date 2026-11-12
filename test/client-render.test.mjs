/**
 * client-render.test.mjs —— 把设置页真的跑起来：hook 个数、effect、自动保存、请求先后（接 issue #69）
 *
 * test/client.test.mjs 的假 React 只渲染一次、不跑 effect，load() 从来不执行，
 * 所以「第二次渲染少了几个 hook」「打开页面就整表回写」「旧请求晚到盖掉新的」都测不到。
 * 这里换一个最小的 React：
 *   - hook 按调用顺序存进槽位，每次渲染核对 hook 个数，对不上就照 React 的报法抛错；
 *   - effect 在渲染之后按依赖跑，卸载时跑清理；
 *   - fetch、setTimeout / setInterval 都由测试注入：不联网，700ms 防抖靠手动拨钟；
 *   - 假 fetch 按路径回包，某个请求可以先挂住、之后再放开，照真浏览器的先后来排。
 * 用例之间不共享状态，每条自己 mount 一次。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { normalizeConfig } from '../lib/settings.js'
import { historyFromEvents } from '../lib/history.js'
import { shouldNotify } from '../lib/notify.js'

const SRC = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

// ---------------------------------------------------------------- 最小 React

function miniReact() {
  const slots = []
  let cursor = 0
  let lastCount = null
  let pending = []
  let dirty = false
  const cleanups = new Map()
  const changed = (a, b) => !a || !b || a.length !== b.length || a.some((x, i) => !Object.is(x, b[i]))
  const slot = (init) => {
    const i = cursor++
    if (!(i in slots)) slots[i] = init()
    return slots[i]
  }
  const react = {
    createElement: (type, props, ...children) => ({
      type,
      props: props || {},
      children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false),
    }),
    useState(init) {
      const cell = slot(() => ({ v: typeof init === 'function' ? init() : init }))
      if (!cell.set) {
        cell.set = (v) => {
          const next = typeof v === 'function' ? v(cell.v) : v
          if (!Object.is(next, cell.v)) { cell.v = next; dirty = true }
        }
      }
      return [cell.v, cell.set]
    },
    useRef: (init) => slot(() => ({ current: init })),
    useCallback(fn, deps) {
      const c = slot(() => ({ fn, deps }))
      if (changed(c.deps, deps)) { c.fn = fn; c.deps = deps }
      return c.fn
    },
    useEffect(fn, deps) {
      const c = slot(() => ({ first: true, deps: undefined, i: cursor - 1 }))
      if (c.first || !deps || changed(c.deps, deps)) {
        c.first = false
        c.deps = deps
        pending.push([c.i, fn])
      }
    },
  }
  return {
    react,
    render(Component) {
      cursor = 0
      pending = []
      dirty = false
      const tree = Component()
      if (lastCount !== null && cursor !== lastCount) {
        throw new Error(`Rendered ${cursor < lastCount ? 'fewer' : 'more'} hooks than expected (${cursor} / ${lastCount}).`)
      }
      lastCount = cursor
      for (const [i, fn] of pending) {
        cleanups.get(i)?.()
        const c = fn()
        cleanups.set(i, typeof c === 'function' ? c : undefined)
      }
      return tree
    },
    get dirty() { return dirty },
    unmount() {
      for (const c of cleanups.values()) c?.()
      cleanups.clear()
    },
  }
}

// ---------------------------------------------------------------- 假时钟

function fakeTimers() {
  let now = 0
  let seq = 0
  const timers = new Map()
  return {
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + (Number(ms) || 0), fn, every: 0 }); return id },
    clearTimeout: (id) => { timers.delete(id) },
    setInterval: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + (Number(ms) || 0), fn, every: Number(ms) || 1 }); return id },
    clearInterval: (id) => { timers.delete(id) },
    /** 一个一个跑到点的计时器；每跑一个就交给 onFire（用来让回调里的请求先回来、再渲染）。 */
    async advance(ms, onFire) {
      const end = now + ms
      for (;;) {
        let next = null
        for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t]
        if (!next) break
        const [id, t] = next
        now = t.at
        if (t.every) t.at += t.every
        else timers.delete(id)
        t.fn()
        if (onFire) await onFire()
      }
      now = end
    },
  }
}

// ---------------------------------------------------------------- 假后端

// 盘上的配置：和真的一样经 normalizeConfig 补全。默认配置里 avoid.keywords 有几个词，
// 而界面初值是空——/config 一回来，界面上就会有一项和 /state 那一帧不同。
const DISK = normalizeConfig({})

/** 照 observe.js 的 /state：config 只带这几项，其余要等 /config。 */
function stateOf(cfg) {
  return {
    day: 3, growthDays: 30, stage: 1, stageName: '信任', stageForced: false,
    pendingGate: 'trust', name: null, beliefCount: 1, absenceDays: 0,
    counts: { utterance: 1, revise: 0, refusal: 0, reunion: 0, total: 1 },
    quality: { stability: 0, consistency: 1, novelty: 0 },
    config: {
      window: cfg.window,
      daily: cfg.daily,
      diary: { enabled: cfg.diary?.enabled, visible: cfg.diary?.visible },
      absenceAfterDays: cfg.absenceAfterDays,
      proactive: cfg.proactive,
    },
  }
}

const daysOf = (path) => Number(new URL(path, 'http://x').searchParams.get('days'))

/** 默认的一份后端。没列出来的路由一律 404——界面上那些都 .catch 掉、当没有。 */
function backend(cfg) {
  return (method, path) => {
    if (method === 'POST') return { body: { ok: true } }
    if (path === '/state') return { body: stateOf(cfg) }
    if (path === '/config') return { body: { config: cfg } }
    if (path === '/owner') return { body: { mid: '', name: '', hasCookie: false, atOwner: cfg.comment?.atOwner !== false } }
    if (path === '/beliefs') return { body: { active: [], refuted: [], refusals: [], selfmod: [] } }
    if (path === '/diary') return { body: { enabled: true, visible: false, dates: [], items: [] } }
    if (path === '/browse') return { body: { watchedCount: 0, glancedCount: 0, handed: [] } }
    if (path === '/notify') return { body: { enabled: cfg.notify?.enabled === true, due: false, text: '', why: '' } }
    if (path.startsWith('/history')) return { body: { days: daysOf(path), total: 0, groups: [] } }
    return { status: 404, body: { error: 'not found' } }
  }
}

function fakeFetch(routes, fallback) {
  const calls = []
  const f = async (url, init = {}) => {
    const full = String(url)
    // 子路径部署（issue #132）下前缀不在站点根，剥到 /dsh-fish 为止再匹配后端路由。
    const path = full.replace(/^.*?\/dsh-fish(?=\/|$)/, '') || '/'
    const method = init.method || 'GET'
    const body = init.body ? JSON.parse(init.body) : undefined
    calls.push({ method, path, url: full, body })
    const r = (await routes(method, path, body)) ?? fallback(method, path, body)
    const status = r.status ?? 200
    return { ok: status >= 200 && status < 300, status, json: async () => r.body ?? {} }
  }
  f.calls = calls
  return f
}

/** 一个先挂住、之后手动放开的回包。 */
function gate() {
  let open
  const p = new Promise((r) => { open = r })
  return { wait: (v) => p.then(() => v), open: () => open() }
}

// ---------------------------------------------------------------- 挂载

async function mount({ routes = () => undefined, cfg = DISK, win = {}, baseURI } = {}) {
  // 「查多久的记录」存在 localStorage：有的 Node 有它，别让上一条用例选过的天数带进来
  try { globalThis.localStorage?.removeItem?.('fish.histDays') } catch { /* 没有就算了 */ }
  const mini = miniReact()
  const timers = fakeTimers()
  const fetch = fakeFetch(routes, backend(cfg))
  const loaded = []
  const window = { ...win, __ModuleLoader__: { load(spec) { loaded.push(spec) } } }
  const document = {
    visibilityState: 'visible',
    baseURI,
    querySelector: () => null,
    createElement: () => ({ setAttribute() {}, textContent: '' }),
    head: { appendChild() {} },
  }
  // 客户端是脚本不是模块：把 window、fetch、计时器当参数注进去，盖住全局的同名对象。
  const run = new Function('window', 'require', 'document', 'fetch',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', SRC)
  const req = (id) => { if (id === 'react') return mini.react; throw new Error(`unexpected require: ${id}`) }
  run(window, req, document, fetch, timers.setTimeout, timers.clearTimeout, timers.setInterval, timers.clearInterval)
  const { FishSection } = loaded[0].factory(req)

  const app = {
    tree: null,
    fetch,
    render() { this.tree = mini.render(FishSection); return this.tree },
    /** 让在飞的请求都回来；有 setState 就再渲染，直到连着几拍都没动静。 */
    async settle() {
      let quiet = 0
      for (let i = 0; i < 200 && quiet < 3; i++) {
        await new Promise((r) => setImmediate(r))
        if (mini.dirty) { quiet = 0; this.render() } else quiet++
      }
      return this.tree
    },
    async advance(ms) { await timers.advance(ms, () => this.settle()); return this.settle() },
    text() { return textOf(this.tree).join(' ') },
    async tab(name) {
      const btn = findAll(this.tree, (n) => n.type === 'button' && String(n.props.className || '').startsWith('tab')
        && textOf(n).join('') === name)[0]
      assert.ok(btn, `页签「${name}」要在`)
      btn.props.onClick()
      return this.settle()
    },
    field(label) {
      const f = findAll(this.tree, (n) => n.props?.className === 'fld'
        && findAll(n, (m) => m.props?.className === 'flabel' && textOf(m).join('') === label).length > 0)[0]
      assert.ok(f, `设置项「${label}」要在当前页上`)
      return f
    },
    card(title) {
      const c = findAll(this.tree, (n) => n.props?.className === 'card'
        && n.children.some((m) => m?.type === 'h3' && textOf(m).join('') === title))[0]
      assert.ok(c, `卡片「${title}」要在当前页上`)
      return c
    },
    posts(path = '/config') { return fetch.calls.filter((c) => c.method === 'POST' && c.path === path) },
    gets(prefix) { return fetch.calls.filter((c) => c.method === 'GET' && c.path.startsWith(prefix)) },
    unmount() { mini.unmount() },
  }
  app.render()
  await app.settle()
  return app
}

// ---------------------------------------------------------------- 0：挂在子路径下时请求跟着前缀走（issue #132）

test('挂子路径时 API 跟着 baseURI 走，不再打到站点根', async () => {
  const app = await mount({
    baseURI: 'https://host:5667/app/deepseek-harness/fngateway/',
    routes: (m, p) => (m === 'GET' && p === '/state' ? { body: stateOf(DISK) } : undefined),
  })
  try {
    assert.ok(app.fetch.calls.length > 0, '至少要发一次 /state')
    for (const c of app.fetch.calls) {
      assert.ok(c.url.startsWith('/app/deepseek-harness/fngateway/dsh-fish/'),
        `请求要带子路径前缀，实际：${c.url}`)
    }
  } finally { app.unmount() }
})

test('宿主注入 __DSH_BASE_PATH__ 时优先用它（issue #132）', async () => {
  const app = await mount({
    win: { __DSH_BASE_PATH__: '/gw/' },
    baseURI: 'https://host/app/deepseek-harness/fngateway/',
    routes: (m, p) => (m === 'GET' && p === '/state' ? { body: stateOf(DISK) } : undefined),
  })
  try {
    assert.ok(app.fetch.calls.length > 0)
    for (const c of app.fetch.calls) assert.ok(c.url.startsWith('/gw/dsh-fish/'), `实际：${c.url}`)
  } finally { app.unmount() }
})

function textOf(node, out = []) {
  if (node == null || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const n of node) textOf(n, out); return out }
  for (const c of node.children || []) textOf(c, out)
  return out
}

function findAll(node, pred, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const n of node) findAll(n, pred, out); return out }
  if (pred(node)) out.push(node)
  for (const c of node.children || []) findAll(c, pred, out)
  return out
}

const inputOf = (fld, type) => findAll(fld, (n) => n.type === type)[0]
const switchOf = (fld) => findAll(fld, (n) => n.props?.role === 'switch')[0]

/** 到「状态」页点「现在叫醒大肥鱼」：点完整页重读一次（load），再回到原来那一页。 */
async function reloadByWake(app, back) {
  await app.tab('状态')
  const wake = findAll(app.tree, (n) => n.type === 'button' && textOf(n).join('') === '现在叫醒大肥鱼')[0]
  assert.ok(wake, '「现在叫醒大肥鱼」要在（点完会整页重读）')
  wake.props.onClick()
  await app.settle()
  return app.tab(back)
}

// ---------------------------------------------------------------- 1：第一次读 /state 就失败

test('第一次读 /state 就失败：整节不崩，显示「读不到状态。」和原因', async () => {
  for (const status of [500, 401, 403]) {
    const app = await mount({ routes: (m, p) => (p === '/state' ? { status, body: { error: 'boom' } } : undefined) })
    try {
      const txt = app.text()
      assert.ok(txt.includes('读不到状态。'), `${status}：要有那句话，实际：${txt.slice(0, 200)}`)
      assert.ok(txt.includes(`HTTP ${status}`), `${status}：原因要印出来`)
      if (status !== 500) assert.ok(txt.includes('被信任栅栏拒绝'), `${status}：要说清是哪道栅栏`)
      // 之后再渲染几次（轮询、计时器）也不能因为 hook 个数变了而崩
      await app.advance(61_000)
      assert.ok(app.text().includes('读不到状态。'))
    } finally { app.unmount() }
  }
})

// ---------------------------------------------------------------- 2：只打开页面，不许改盘上的「@ 你」

/** 照真浏览器的先后：/state 先回来渲染一帧，/config 后到；/owner 按给的办法回。 */
async function openPage(cfg, ownerRoute) {
  const cfgGate = gate()
  const app = await mount({
    cfg,
    routes: (m, p) => {
      if (m === 'GET' && p === '/config') return cfgGate.wait({ body: { config: cfg } })
      if (p === '/owner') return ownerRoute()
      return undefined
    },
  })
  assert.ok(app.text().includes('信任'), '/state 那一帧要先渲染出来')
  assert.equal(app.gets('/owner').length, 0, '/owner 要等 /config 回来才发')
  await app.advance(100)
  cfgGate.open()
  await app.settle()
  return app
}

test('只打开页面、/owner 失败：不把盘上关着的「评论开头 @ 你」写回 true，也不整表回写', async () => {
  const cfg = normalizeConfig({ comment: { atOwner: false } })
  const app = await openPage(cfg, () => ({ status: 500, body: { error: 'EBUSY' } }))
  try {
    await app.advance(3000)
    const flips = app.posts().filter((c) => c.body?.comment?.atOwner === true)
    assert.deepEqual(flips, [], '什么都没动，「@ 你」不能被悄悄打开')
    assert.deepEqual(app.posts(), [], '什么都没动，打开页面不该写盘')
    await app.tab('上网')
    assert.equal(switchOf(app.field('评论开头 @ 你')).props['aria-checked'], 'false', '界面上要显示关着')
  } finally { app.unmount() }
})

test('只打开页面、/owner 慢于 700ms 才回：中间不先写一次 true', async () => {
  const cfg = normalizeConfig({ comment: { atOwner: false } })
  const ownerGate = gate()
  const app = await openPage(cfg, () => ownerGate.wait({ body: { mid: '', name: '', atOwner: false } }))
  try {
    await app.advance(2000)
    ownerGate.open()
    await app.settle()
    await app.advance(2000)
    assert.deepEqual(app.posts().map((c) => c.body?.comment?.atOwner), [], '打开页面不该写盘，更不能先写 true 再写 false')
    await app.tab('上网')
    assert.equal(switchOf(app.field('评论开头 @ 你')).props['aria-checked'], 'false')
  } finally { app.unmount() }
})

test('打开页面之后改一项，照样停手 700ms 存一次，带的「@ 你」是盘上的值', async () => {
  // 两份盘：一份和界面初值有出入（默认配置），一份读回来和界面初值一模一样（基线不变的那种）
  const minimal = { window: ['20:00', '23:00'], daily: { events: 1, questions: 1 }, absenceAfterDays: 2, wakesPerDay: 1 }
  for (const cfg of [normalizeConfig({ comment: { atOwner: false } }), minimal]) {
    const app = await openPage(cfg, () => undefined)
    try {
      await app.advance(1000)
      await app.tab('成长')
      const before = app.posts().length
      assert.equal(before, 0, '/owner 正常回来、什么都没动：打开页面不写盘')
      inputOf(app.field('每天醒几次'), 'select').props.onChange({ target: { value: '2' } })
      await app.settle()
      await app.advance(699)
      assert.equal(app.posts().length, before, '还没停手够 700ms')
      await app.advance(1)
      const posts = app.posts().slice(before)
      assert.equal(posts.length, 1, '停手 700ms 存一次，第一次改动不能被当成基线吞掉')
      assert.equal(posts[0].body.wakesPerDay, 2)
      assert.equal(posts[0].body.comment.atOwner, cfg.comment?.atOwner !== false)
    } finally { app.unmount() }
  }
})

test('/owner 晚回来：不把用户刚拨过的「评论开头 @ 你」翻回去，也不把旧值写回盘', async () => {
  const cfg = normalizeConfig({ comment: { atOwner: true } })
  const ownerGate = gate()
  // /owner 回的是发请求那一刻盘上的值（true）
  const app = await openPage(cfg, () => ownerGate.wait({ body: { mid: '', name: '', atOwner: true } }))
  try {
    await app.advance(1000)
    await app.tab('上网')
    const sw = () => switchOf(app.field('评论开头 @ 你'))
    assert.equal(sw().props['aria-checked'], 'true')
    sw().props.onClick()
    await app.settle()
    await app.advance(700)
    assert.deepEqual(app.posts().map((c) => c.body?.comment?.atOwner), [false], '拨成关，停手 700ms 存一次')
    ownerGate.open()
    await app.settle()
    await app.advance(2000)
    assert.equal(sw().props['aria-checked'], 'false', '/owner 晚回来不能把开关翻回去')
    assert.deepEqual(app.posts().map((c) => c.body?.comment?.atOwner), [false], '也不能再把 true 写回盘')
  } finally { app.unmount() }
})

// ---------------------------------------------------------------- 3：安静多久才搭话

test('「安静多久才搭话」停手 700ms 再存，清空和越界不写盘，离开输入框不重复写', async () => {
  const app = await mount()
  try {
    await app.advance(1000)
    await app.tab('成长')
    const input = () => inputOf(app.field('安静多久才搭话'), 'input')
    const idle = () => app.posts().filter((c) => c.body?.proactive && 'minIdleHours' in c.body.proactive)
      .map((c) => c.body.proactive.minIdleHours)

    // 从 6 改成 12：删掉、打 1、打 12、点别处
    input().props.onChange({ target: { value: '' } })
    await app.settle()
    input().props.onChange({ target: { value: '1' } })
    await app.settle()
    input().props.onChange({ target: { value: '12' } })
    await app.settle()
    input().props.onBlur({ target: { value: '12' } })
    await app.settle()
    assert.deepEqual(idle(), [], '打字途中一次都不写')
    await app.advance(699)
    assert.deepEqual(idle(), [], '还没停手够 700ms')
    await app.advance(1)
    assert.deepEqual(idle(), [12], '只存停手时的那个数')

    // 存过之后再点一下别处：数没变，不再写
    input().props.onBlur({ target: { value: '12' } })
    await app.settle()
    await app.advance(1000)
    assert.deepEqual(idle(), [12])

    // 停在半截：清空、0、25 都不写（服务端会把它们夹成 1 或 24，生效的就不是框里那个数）
    for (const v of ['', '0', '25']) {
      input().props.onChange({ target: { value: v } })
      await app.settle()
      await app.advance(1000)
    }
    assert.deepEqual(idle(), [12], '不在 1–24 里的一个都不写')

    // 小数：服务端写盘时取整，这里提交的和框里显示的都是取整后的数
    input().props.onChange({ target: { value: '2.4' } })
    await app.settle()
    await app.advance(700)
    assert.deepEqual(idle(), [12, 2])
    assert.equal(String(input().props.value), '2')
  } finally { app.unmount() }
})

test('「安静多久才搭话」清空或打 25 之后离开输入框：框里收成 1 或 24，照框里的数存一次', async () => {
  const app = await mount()
  try {
    await app.advance(1000)
    await app.tab('成长')
    const input = () => inputOf(app.field('安静多久才搭话'), 'input')
    const idle = () => app.posts().filter((c) => c.body?.proactive && 'minIdleHours' in c.body.proactive)
      .map((c) => c.body.proactive.minIdleHours)

    // 清空，再点别处：Num 离开输入框时按上下限收一次，空框落到下限 1
    input().props.onChange({ target: { value: '' } })
    await app.settle()
    input().props.onBlur({ target: { value: '' } })
    await app.settle()
    assert.equal(String(input().props.value), '1', '框里收成下限')
    await app.advance(699)
    assert.deepEqual(idle(), [], '清空那一下不写，离开输入框也是停手 700ms 再存')
    await app.advance(1)
    assert.deepEqual(idle(), [1], '存的是框里显示的那个数')

    // 打 25，再点别处：收成上限 24，存的也是 24
    input().props.onChange({ target: { value: '25' } })
    await app.settle()
    input().props.onBlur({ target: { value: '25' } })
    await app.settle()
    assert.equal(String(input().props.value), '24', '框里收成上限')
    await app.advance(700)
    assert.deepEqual(idle(), [1, 24], '25 不写，收成的 24 存一次')
  } finally { app.unmount() }
})

// ---------------------------------------------------------------- 4：查多久的记录

function histRoutes(held) {
  return (m, p) => {
    if (!p.startsWith('/history')) return undefined
    const days = daysOf(p)
    // 每份的视频标题带着天数：列表摆的是哪一份，看标题就知道。14 天那份多于一页，会有翻页条
    const items = Array.from({ length: Math.min(days, 20) }, (_, i) =>
      ({ bvid: `BV1xx411c7${String(i).padStart(2, '0')}`, title: `${days} 天那份`, up: '某UP', how: 'glance' }))
    const body = { days, total: days, groups: [{ date: '2026-11-01', items }] }
    return held[days] ? held[days].wait({ body }) : { body }
  }
}

test('「查多久的记录」：首屏那次晚回来，不盖掉刚选的天数', async () => {
  const held = { 14: gate() }
  const app = await mount({ routes: histRoutes(held) })
  try {
    assert.deepEqual(app.gets('/history').map((c) => c.path), ['/history?days=14'])
    await app.tab('上网')
    inputOf(app.field('查多久的记录'), 'select').props.onChange({ target: { value: '90' } })
    await app.settle()
    assert.ok(app.text().includes('共 1 天 · 90 条'))
    held[14].open()
    await app.settle()
    assert.ok(app.text().includes('共 1 天 · 90 条'), '14 天那次晚回来，不该把列表换回去')
    assert.equal(inputOf(app.field('查多久的记录'), 'select').props.value, '90')
  } finally { app.unmount() }
})

test('「查多久的记录」：先选 90 再选 7，90 那次晚到也不盖掉 7', async () => {
  const held = {}
  const app = await mount({ routes: histRoutes(held) })
  try {
    await app.tab('上网')
    held[90] = gate()
    inputOf(app.field('查多久的记录'), 'select').props.onChange({ target: { value: '90' } })
    await app.settle()
    inputOf(app.field('查多久的记录'), 'select').props.onChange({ target: { value: '7' } })
    await app.settle()
    assert.ok(app.text().includes('共 1 天 · 7 条'))
    held[90].open()
    await app.settle()
    assert.equal(inputOf(app.field('查多久的记录'), 'select').props.value, '7')
    assert.ok(app.text().includes('共 1 天 · 7 条'), '下拉框是 7，列表也要是 7 天的')
  } finally { app.unmount() }
})

test('「查多久的记录」：新选的天数没读到，就说没读到，不说「还没有记录」，也不摆别的天数的列表', async () => {
  const pick = (app, v) => inputOf(app.field('查多久的记录'), 'select').props.onChange({ target: { value: v } })
  const failing = new Set()
  const routesWith = (held) => (m, p) => (p.startsWith('/history') && failing.has(daysOf(p))
    ? { status: 500, body: { error: 'boom' } }
    : histRoutes(held)(m, p))

  // 一：首屏 14 天那次挂住，选 90，90 那次失败，再放开 14 天那次（被丢掉）
  {
    failing.clear(); failing.add(90)
    const held = { 14: gate() }
    const app = await mount({ routes: routesWith(held) })
    try {
      await app.tab('上网')
      pick(app, '90')
      await app.settle()
      held[14].open()
      await app.settle()
      const txt = app.text()
      assert.equal(inputOf(app.field('查多久的记录'), 'select').props.value, '90')
      assert.ok(txt.includes('没读到'), `要说没读到，实际：${txt.slice(txt.indexOf('查多久的记录'), txt.indexOf('查多久的记录') + 200)}`)
      assert.ok(!txt.includes('还没有记录'), '不能说成还没有记录')
      assert.ok(!txt.includes('共 0 天'), '也不能说共 0 天')
      assert.ok(!txt.includes('14 条') && !txt.includes('14 天那份'), '14 天那次晚到也不摆出来')
    } finally { app.unmount() }
  }

  // 二：14 天那次正常回来，选 90 失败：不把 14 天的列表摆在 90 下面；再选 7 读到了就照常列
  {
    failing.clear(); failing.add(90)
    const app = await mount({ routes: routesWith({}) })
    try {
      await app.tab('上网')
      assert.ok(app.text().includes('共 1 天 · 14 条'))
      assert.ok(app.text().includes('第 1 / 2 页'), '14 天那份有翻页条')
      pick(app, '90')
      await app.settle()
      assert.ok(app.text().includes('没读到'))
      assert.ok(!app.text().includes('14 条') && !app.text().includes('14 天那份'), '下拉框是 90，不能还摆着 14 天的')
      assert.ok(!app.text().includes('页 · 一页'), '14 天那份的翻页条也不摆')
      // 90 好了，整页重读一次：这回读到了，列表照常列，那句收起来
      failing.clear()
      await reloadByWake(app, '上网')
      assert.ok(app.text().includes('共 1 天 · 90 条') && app.text().includes('90 天那份'))
      assert.ok(!app.text().includes('没读到'), '读到了，那句收起来')
      // 换成 7 天也照常
      pick(app, '7')
      await app.settle()
      assert.ok(app.text().includes('共 1 天 · 7 条') && app.text().includes('7 天那份'))
      assert.ok(!app.text().includes('没读到'))
    } finally { app.unmount() }
  }

  // 三：列表已经是当前天数的，之后整页重读时这一项失败一次：列表留着，不收起来
  {
    failing.clear()
    const app = await mount({ routes: routesWith({}) })
    try {
      await app.tab('上网')
      assert.ok(app.text().includes('共 1 天 · 14 条'))
      failing.add(14)
      const before = app.gets('/history').length
      await reloadByWake(app, '上网')
      assert.equal(app.gets('/history').length, before + 1, '重读时要再取一次 /history')
      assert.ok(app.text().includes('共 1 天 · 14 条') && app.text().includes('14 天那份'), '已经摆着的这个天数的列表留着')
      assert.ok(!app.text().includes('没读到'))
    } finally { app.unmount() }
  }
})

// ---------------------------------------------------------------- 打开页面时设置没读全

test('打开页面时 /beliefs 失败、/config 没灌进来：改一项也不整表写盘，说清楚为什么没存；读全以后照常存', async () => {
  const cfg = normalizeConfig({ comment: { atOwner: false } })
  let beliefsOk = false
  const app = await mount({
    cfg,
    routes: (m, p) => (m === 'GET' && p === '/beliefs' && !beliefsOk ? { status: 500, body: { error: 'boom' } } : undefined),
  })
  try {
    await app.advance(1000)
    assert.deepEqual(app.posts(), [], '打开页面不写盘')
    await app.tab('成长')
    inputOf(app.field('每天醒几次'), 'select').props.onChange({ target: { value: '2' } })
    await app.settle()
    await app.advance(2000)
    assert.deepEqual(app.posts(), [], '界面上除了 /state 那几项都是初值，不能整表写下去')
    assert.ok(app.text().includes('设置还没从盘上读全'), '要说清这次为什么没存')

    // 之后整页重读成功：那句收起来，再改一项照常停手 700ms 存，带的是盘上的值
    beliefsOk = true
    await reloadByWake(app, '成长')
    assert.ok(!app.text().includes('设置还没从盘上读全'), '读全了，那句不再成立')
    await app.advance(1000)
    assert.deepEqual(app.posts(), [], '重读本身不写盘')
    inputOf(app.field('每天醒几次'), 'select').props.onChange({ target: { value: '2' } })
    await app.settle()
    await app.advance(700)
    const posts = app.posts()
    assert.equal(posts.length, 1)
    assert.equal(posts[0].body.wakesPerDay, 2)
    assert.equal(posts[0].body.comment.atOwner, false, '带的是盘上的 atOwner')
    assert.deepEqual(posts[0].body.avoid?.keywords, cfg.avoid?.keywords, '屏蔽词是盘上的，不是界面初值')
  } finally { app.unmount() }
})

// ---------------------------------------------------------------- 6：卡片说明和回执要跟行为一致

test('「桌面提醒」：说明不说只有主动搭话才弹；关掉后的回执不说气泡还在', async () => {
  const today = '2026-11-08'
  // 叫醒那一轮说的话（不是主动搭话）也会触发提醒——这是服务端的真判据
  const said = [{ type: 'utterance', ts: new Date(2026, 10, 8, 12).toISOString(), text: '叫醒那一轮说的话' }]
  assert.equal(shouldNotify({ config: { notify: { enabled: true } }, today, events: said }).due, true)

  let enabled = true
  const app = await mount({
    cfg: normalizeConfig({ notify: { enabled: true } }),
    win: { Notification: { permission: 'denied', async requestPermission() { return 'denied' } } },
    routes: (m, p, body) => {
      if (p !== '/notify') return undefined
      if (m === 'POST' && typeof body?.enabled === 'boolean') { enabled = body.enabled; return { body: { enabled } } }
      if (m === 'POST') return { body: { ok: true } }
      // GET：照 readPending 的判据回
      const r = shouldNotify({ config: { notify: { enabled } }, today, events: said })
      return { body: { enabled, ...r } }
    },
  })
  try {
    // 开着、没有系统通知权限：叫醒那一轮的话退成页面里的气泡
    assert.ok(app.text().includes('叫醒那一轮说的话'), '开着时气泡要出来')
    await app.tab('成长')
    const note = textOf(app.card('桌面提醒').children.find((c) => c?.props?.className === 'hint')).join('')
    assert.ok(!/主动找你说话会弹/.test(note), `说明不能只说主动搭话才弹，实际：${note}`)

    // 关掉：服务端从此 due:false，页面不会再出气泡
    findAll(app.tree, (n) => n.type === 'button' && textOf(n).join('') === '知道了')
      .forEach((b) => b.props.onClick())
    await app.settle()
    switchOf(app.field('她说话时在系统里提醒我')).props.onClick()
    await app.settle()
    assert.equal(enabled, false)
    await app.advance(61_000)
    assert.ok(!app.text().includes('叫醒那一轮说的话'), '关掉之后气泡也不出')
    assert.ok(!app.text().includes('气泡还在'), '回执不能说气泡还在')
    assert.ok(/提醒关掉了/.test(app.text()), '要有关掉的回执')
  } finally { app.unmount() }
})

test('「看过的视频」：说明不把她自己点开的说成旧版刷站翻到的', async () => {
  // 列表里会有她自己用 bili_look 点开的（look:），这类不是「旧版刷站」
  const events = [{ type: 'meta', text: 'look:2026-11-08 BV1dd411d7dd {"title":"她点开的","up":"某UP"}' }]
  const groups = historyFromEvents(events, { days: 14 })
  assert.equal(groups[0].items[0].how, 'glance')
  const app = await mount({
    routes: (m, p) => (p.startsWith('/history') ? { body: { days: daysOf(p), total: 1, groups } } : undefined),
  })
  try {
    await app.tab('上网')
    assert.ok(app.text().includes('她点开的'))
    const card = findAll(app.tree, (n) => n.props?.className?.startsWith?.('card')
      && n.children.some((m) => m?.type === 'h3' && textOf(m).join('') === '看过的视频'))[0]
    assert.ok(card, '「看过的视频」要在')
    const note = textOf(card.children.find((c) => c?.props?.className === 'hint')).join('')
    assert.ok(!note.includes('其余是旧版刷站翻到的'), `说明要算上她自己点开的，实际：${note}`)
    assert.ok(note.includes('自己点开'), `说明要算上她自己点开的，实际：${note}`)
  } finally { app.unmount() }
})
