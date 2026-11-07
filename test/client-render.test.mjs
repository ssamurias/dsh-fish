/**
 * client-render.test.mjs —— 把设置页真的跑起来：hook、effect、自动保存、假 fetch（issue #69）
 *
 * test/client.test.mjs 的假 React 只渲染一次、不跑 effect，load() 从来不执行，
 * 所以「第二次渲染少了几个 hook」「load 闭包里的旧值」「自动保存带了什么」都测不到。
 * 这里换一个最小的 React：
 *   - hook 按调用顺序存进槽位，每次渲染核对 hook 个数，少了就照 React 的报法抛错；
 *   - effect 在渲染之后按依赖跑，卸载时跑清理；
 *   - fetch、setTimeout / setInterval 都由测试注入（不联网，700ms 防抖靠手动拨钟）。
 * 用例之间不共享状态，每条自己 mount 一次。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { LIMITS } from '../lib/settings.js'
import { proactiveConfig } from '../lib/proactive.js'
import { historyFromEvents } from '../lib/history.js'

const SRC = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

// ---------------------------------------------------------------- 最小 React

function miniReact() {
  let slots = []
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
    useMemo(fn, deps) {
      const c = slot(() => ({ v: fn(), deps }))
      if (changed(c.deps, deps)) { c.v = fn(); c.deps = deps }
      return c.v
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
    advance(ms) {
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
      }
      now = end
    },
  }
}

// ---------------------------------------------------------------- 假后端

const STATE = {
  day: 3, growthDays: 30, stage: 1, stageName: '信任', stageForced: false,
  pendingGate: 'trust', name: null, beliefCount: 1, absenceDays: 0,
  counts: { utterance: 1, revise: 0, refusal: 0, reunion: 0, total: 1 },
  quality: { stability: 0, consistency: 1, novelty: 0 },
  config: { window: ['20:00', '23:00'], daily: { events: 1, questions: 1 }, diary: {}, absenceAfterDays: 2 },
}
const CONFIG = { window: ['20:00', '23:00'], daily: { events: 1, questions: 1 }, absenceAfterDays: 2, wakesPerDay: 1 }

/** 默认的一份后端。没列出来的路由一律 404——界面上那些都 .catch 掉、当没有。 */
function defaultRoutes(method, path) {
  if (method === 'POST') return { body: { ok: true } }
  if (path === '/state') return { body: STATE }
  if (path === '/config') return { body: { config: CONFIG } }
  if (path === '/beliefs') return { body: { active: [], refuted: [], refusals: [], selfmod: [] } }
  if (path === '/diary') return { body: { enabled: true, visible: false, dates: [], items: [] } }
  if (path === '/browse') return { body: { watchedCount: 0, glancedCount: 0, handed: [] } }
  if (path.startsWith('/history')) {
    const days = Number(new URL(path, 'http://x').searchParams.get('days'))
    return { body: { days, total: 0, groups: [] } }
  }
  return { status: 404, body: { error: 'not found' } }
}

function fakeFetch(routes) {
  const calls = []
  const f = async (url, init = {}) => {
    const path = String(url).replace(/^\/dsh-fish/, '')
    const method = init.method || 'GET'
    const body = init.body ? JSON.parse(init.body) : undefined
    calls.push({ method, path, body })
    const r = (await routes(method, path, body)) ?? defaultRoutes(method, path, body)
    const status = r.status ?? 200
    return { ok: status >= 200 && status < 300, status, json: async () => r.body ?? {} }
  }
  f.calls = calls
  return f
}

// ---------------------------------------------------------------- 挂载

async function mount({ routes = () => undefined, win = {} } = {}) {
  const mini = miniReact()
  const timers = fakeTimers()
  const fetch = fakeFetch(routes)
  const loaded = []
  const window = { ...win, __ModuleLoader__: { load(spec) { loaded.push(spec) } } }
  const document = {
    visibilityState: 'visible',
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
      for (let i = 0; i < 100 && quiet < 3; i++) {
        await new Promise((r) => setImmediate(r))
        if (mini.dirty) { quiet = 0; this.render() } else quiet++
      }
      return this.tree
    },
    async advance(ms) { timers.advance(ms); return this.settle() },
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
    posts(path = '/config') { return fetch.calls.filter((c) => c.method === 'POST' && c.path === path) },
    unmount() { mini.unmount() },
  }
  app.render()
  await app.settle()
  // 首屏：/state 回来那一帧记基线，/config 回来后若和 /state 里的不同会先存一次。拨过去，别算进用例里。
  await app.advance(1000)
  return app
}

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

// ---------------------------------------------------------------- 1、6：数字框的上下限

/** 把源码里的一段字面量求值：所有变量名都换成「@@变量名」，Number/Boolean/String 原样放过。 */
function evalNames(expr) {
  const scope = new Proxy({}, {
    has: (_, k) => typeof k === 'string',
    get: (_, k) => {
      if (typeof k !== 'string') return undefined
      if (k === 'Number' || k === 'Boolean' || k === 'String') return (x) => x
      return `@@${k}`
    },
  })
  // eslint-disable-next-line no-new-func
  return new Function('scope', `with (scope) { return (${expr}) }`)(scope)
}

test('NUM_BOUNDS 和 settings.js 的 LIMITS 一致：随整表提交的数字项一项不漏（issue #69）', () => {
  const nb = SRC.match(/const NUM_BOUNDS = (\[[\s\S]*?\n {6}\])/)
  const bc = SRC.match(/const buildConfig = \(\) => \((\{[\s\S]*?\n {6}\})\)/)
  assert.ok(nb && bc, '要能在 client.js 里找到 NUM_BOUNDS 和 buildConfig')

  // buildConfig 里每个变量提交到哪个键（daily.events ← eventsPerDay 这种）
  const keyOf = {}
  const walk = (o, at) => {
    for (const [k, v] of Object.entries(o)) {
      const p = at ? `${at}.${k}` : k
      if (typeof v === 'string' && v.startsWith('@@')) keyOf[v.slice(2)] = p
      else if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, p)
    }
  }
  walk(evalNames(bc[1]), '')
  assert.equal(keyOf.eventsPerDay, 'daily.events', '变量到键的对应要能解析出来')

  const rows = evalNames(nb[1])
  const seen = new Set()
  for (const [label, v, lo, hi] of rows) {
    const key = keyOf[String(v).slice(2)]
    assert.ok(key, `NUM_BOUNDS 的「${label}」在 buildConfig 里找不到`)
    assert.ok(LIMITS[key], `「${label}」（${key}）在 LIMITS 里没有`)
    assert.deepEqual([lo, hi], LIMITS[key], `「${label}」（${key}）的范围要和 LIMITS 一样`)
    seen.add(key)
  }
  // 反查：服务端会夹值、又随整表提交的，界面必须先拦——否则越界值被悄悄改掉
  const missing = Object.values(keyOf).filter((k) => k in LIMITS && !seen.has(k))
  assert.deepEqual(missing, [], 'LIMITS 里有、随整表提交、NUM_BOUNDS 却没有的项')
})

test('每天事件数 / 问题卡数选 6 能存上，不再把整页自动保存拦下（issue #69）', async () => {
  const app = await mount()
  try {
    await app.tab('成长')
    const before = app.posts().length
    inputOf(app.field('每天事件数'), 'select').props.onChange({ target: { value: '6' } })
    inputOf(app.field('每天问题卡数'), 'select').props.onChange({ target: { value: '6' } })
    await app.settle()
    await app.advance(700)
    const posts = app.posts().slice(before)
    assert.equal(posts.length, 1, '停手 700ms 存一次')
    assert.deepEqual(posts[0].body.daily, { events: 6, questions: 6 })
    assert.ok(!app.text().includes('这个数不在允许范围里'), '不该再说 6 越界')
  } finally { app.unmount() }
})

// ---------------------------------------------------------------- 2：首个 /state 失败

test('第一次读 /state 就失败：整节不崩，显示「读不到状态。」和原因（issue #69）', async () => {
  const app = await mount({ routes: () => ({ status: 500, body: { error: 'boom' } }) })
  try {
    const txt = app.text()
    assert.ok(txt.includes('读不到状态。'), `要有那句话，实际：${txt.slice(0, 200)}`)
    assert.ok(txt.includes('HTTP 500 boom'), '原因要印出来')
  } finally { app.unmount() }

  // 401/403 是信任栅栏：这句提示原来跟着整节一起崩掉
  const app2 = await mount({ routes: (m, p) => (p === '/state' ? { status: 403 } : { status: 500 }) })
  try {
    assert.ok(app2.text().includes('被信任栅栏拒绝'), '403 时要说清是哪道栅栏')
  } finally { app2.unmount() }
})

// ---------------------------------------------------------------- 3：看过的视频按天数取

test('「查多久的记录」真的按选的天数取，慢回来的旧请求不盖新的；上限和服务端都是 180（issue #69）', async () => {
  let hold = null
  const routes = (m, p) => {
    if (!p.startsWith('/history')) return undefined
    const days = Number(new URL(p, 'http://x').searchParams.get('days'))
    const body = { days, total: days, groups: [{ date: '2026-11-01', items: [] }] }
    if (hold && days === 14) return hold.then(() => ({ body }))
    return { body }
  }
  const app = await mount({ routes })
  try {
    const hist = () => app.fetch.calls.filter((c) => c.path.startsWith('/history')).map((c) => c.path)
    assert.deepEqual(hist(), ['/history?days=14'], '首屏按默认 14 天取一次')
    await app.tab('上网')
    assert.ok(app.text().includes('共 1 天 · 14 条'))

    // 先让一次 load（叫醒之后会重读）带着 14 天出去，卡在半路
    let release
    hold = new Promise((r) => { release = r })
    await app.tab('状态')
    const wakeBtn = findAll(app.tree, (n) => n.type === 'button' && textOf(n).join('') === '现在叫醒大肥鱼')[0]
    assert.ok(wakeBtn, '叫醒键要在')
    wakeBtn.props.onClick()
    await app.settle()
    assert.equal(hist().at(-1), '/history?days=14')

    // 这时换成 90 天：要立刻按 90 取
    await app.tab('上网')
    const sel = inputOf(app.field('查多久的记录'), 'select')
    sel.props.onChange({ target: { value: '90' } })
    await app.settle()
    assert.equal(hist().at(-1), '/history?days=90', '换了天数要重取')
    assert.ok(app.text().includes('共 1 天 · 90 条'))

    // 旧的 14 天这时才回来：不许盖掉刚选的
    release()
    await app.settle()
    assert.ok(app.text().includes('共 1 天 · 90 条'), '慢回来的旧请求不该盖住新选的')

    // 之后每次重读都用新天数（原来 load 闭包里永远是 14）
    hold = null
    await app.tab('状态')
    findAll(app.tree, (n) => n.type === 'button' && textOf(n).join('') === '现在叫醒大肥鱼')[0].props.onClick()
    await app.settle()
    assert.equal(hist().at(-1), '/history?days=90', '重读时也按选的天数')

    // 下拉的上限 = 服务端夹的上限
    await app.tab('上网')
    const opts = findAll(app.field('查多久的记录'), (n) => n.type === 'option').map((n) => Number(n.props.value))
    assert.equal(Math.max(...opts), 180, '下拉最多 180 天')
    const days = Array.from({ length: 200 }, (_, i) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10))
    const events = days.map((d) => ({ type: 'meta', text: `watched:${d} BV1xx411c7mD` }))
    assert.equal(historyFromEvents(events, { days: 365 }).length, 180, '服务端就夹在 180')
    assert.equal(historyFromEvents(events, { days: Math.max(...opts) }).length, 180)
  } finally { app.unmount() }
})

// ---------------------------------------------------------------- 5：桌面提醒的开关

test('「她说话时提醒我」写 notify.enabled；开着时显示通知权限，没给过就给一颗键去要（issue #69）', async () => {
  let asked = 0
  const Notification = {
    permission: 'default',
    async requestPermission() { asked++; Notification.permission = 'granted'; return 'granted' },
  }
  const app = await mount({ win: { Notification } })
  try {
    await app.tab('成长')
    const sw = () => findAll(app.field('她说话时提醒我'), (n) => n.props?.role === 'switch')[0]
    assert.equal(sw().props['aria-checked'], 'false', '默认关')
    assert.ok(!app.text().includes('允许系统通知'), '关着时不出权限那一行')

    const before = app.posts().length
    sw().props.onClick()
    await app.settle()
    await app.advance(700)
    const posts = app.posts().slice(before)
    assert.equal(posts.length, 1)
    assert.deepEqual(posts[0].body.notify, { enabled: true }, '开关要真的写进 notify.enabled')

    assert.ok(app.text().includes('还没允许系统通知'), '要说清现在的权限')
    const btn = findAll(app.tree, (n) => n.type === 'button' && textOf(n).join('') === '允许系统通知')[0]
    assert.ok(btn, '要有一颗键去要权限')
    btn.props.onClick()
    await app.settle()
    assert.equal(asked, 1, '点了才去要权限（allowNotify）')
    assert.ok(app.text().includes('系统通知已允许。'))
    assert.equal(findAll(app.tree, (n) => n.type === 'button' && textOf(n).join('') === '允许系统通知').length, 0,
      '给过了就不再出那颗键')
  } finally { app.unmount() }
})

// ---------------------------------------------------------------- 7：安静多久才搭话

test('「安静多久才搭话」停手 700ms 再存，空串和越界不提交；范围三处一致（issue #69）', async () => {
  const app = await mount()
  try {
    await app.tab('成长')
    const input = () => inputOf(app.field('安静多久才搭话'), 'input')
    const idlePosts = () => app.posts().filter((c) => c.body?.proactive && 'minIdleHours' in c.body.proactive)

    const [lo, hi] = LIMITS['proactive.minIdleHours']
    assert.deepEqual([input().props.min, input().props.max], [lo, hi], '框的上下限 = LIMITS')
    assert.equal(proactiveConfig({ proactive: { minIdleHours: lo - 1 } }).minIdleHours, lo, 'proactive.js 读时也夹在这个范围')
    assert.equal(proactiveConfig({ proactive: { minIdleHours: hi + 1 } }).minIdleHours, hi)

    for (const v of ['', '0', '100', 'abc']) {
      input().props.onChange({ target: { value: v } })
      await app.settle()
    }
    await app.advance(1000)
    assert.deepEqual(idlePosts(), [], '清空、0、100 这种半截值一个都不该写盘')

    // 连着打「1」「12」：只存最后那个，而且要等停手
    input().props.onChange({ target: { value: '1' } })
    await app.advance(300)
    input().props.onChange({ target: { value: '12' } })
    await app.advance(699)
    assert.deepEqual(idlePosts(), [], '还没停手够 700ms')
    await app.advance(1)
    assert.deepEqual(idlePosts().map((c) => c.body), [{ proactive: { minIdleHours: 12 } }])

    // 打小数：LIMITS 写盘时取整，提交的和框里显示的都要是取整后的那个数，不能框里还是 1.5、盘上是 2
    input().props.onChange({ target: { value: '1.5' } })
    await app.advance(700)
    assert.deepEqual(idlePosts().map((c) => c.body.proactive.minIdleHours), [12, 2], '提交取整后的数')
    assert.equal(String(input().props.value), '2', '框里也换成取整后的数')
    input().props.onChange({ target: { value: '12' } })
    await app.advance(700)

    // 清空后离开输入框：按下限收敛，存的就是显示的那个数
    input().props.onChange({ target: { value: '' } })
    await app.settle()
    input().props.onBlur({ target: { value: '' } })
    await app.advance(700)
    assert.deepEqual(idlePosts().map((c) => c.body.proactive.minIdleHours), [12, 2, 12, lo])
  } finally { app.unmount() }
})

// ---------------------------------------------------------------- 8：评论开头 @ 你

test('「评论开头 @ 你」从 /config 取：/owner 失败时自动保存不会把它写回 true（issue #69）', async () => {
  const app = await mount({
    routes: (m, p) => {
      if (m === 'GET' && p === '/config') return { body: { config: { ...CONFIG, comment: { atOwner: false } } } }
      if (p === '/owner') return { status: 500, body: { error: 'EBUSY' } }
      return undefined
    },
  })
  try {
    await app.tab('上网')
    const sw = findAll(app.field('评论开头 @ 你'), (n) => n.props?.role === 'switch')[0]
    assert.equal(sw.props['aria-checked'], 'false', '界面上要显示关着')

    // 用户改了同一页上别的整表项，自动保存带上的 atOwner 必须还是 false
    await app.tab('成长')
    const before = app.posts().length
    inputOf(app.field('每天醒几次'), 'select').props.onChange({ target: { value: '2' } })
    await app.settle()
    await app.advance(700)
    const posts = app.posts().slice(before)
    assert.equal(posts.length, 1)
    assert.equal(posts[0].body.wakesPerDay, 2)
    assert.equal(posts[0].body.comment.atOwner, false, '关掉的「@ 你」不能被悄悄打开')
  } finally { app.unmount() }
})
