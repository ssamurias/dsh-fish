/**
 * tools-card.test.mjs —— 「插件」页工具卡、梦开关上的几句话跟真的状态对得上（接 #61 #64 #69，0.9.5 核对出的余项）
 *
 * client.test.mjs 的假 React 只渲染一次、setter 是空的，测不了「点保存之后回执说什么」
 * 「/tools 拉不到时第一句说什么」。这里换一个能 setState、能跑 effect、能点按钮的极简假 React，
 * 配一个假 fetch，把 FishSection 真跑起来，看渲染出来的字。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const CLIENT = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/** 把 FishSection 挂起来。routes 的键是 `METHOD /path` 或 `/path`，值是 {status, body} 或函数。 */
function mount(routes) {
  const calls = []
  const errors = []
  let hooks = []
  let hi = 0
  let queue = []
  let dirty = false
  const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => Object.is(x, b[i]))
  const React = {
    createElement(type, props, ...children) {
      return { type, props: { ...(props || {}), children: children.flat(Infinity) } }
    },
    useState(init) {
      const i = hi++
      if (!(i in hooks)) hooks[i] = { v: typeof init === 'function' ? init() : init }
      const slot = hooks[i]
      return [slot.v, (nv) => {
        const val = typeof nv === 'function' ? nv(slot.v) : nv
        if (!Object.is(val, slot.v)) { slot.v = val; dirty = true }
      }]
    },
    useRef(init) {
      const i = hi++
      if (!(i in hooks)) hooks[i] = { current: init }
      return hooks[i]
    },
    useCallback(fn, deps) {
      const i = hi++
      const s = hooks[i]
      if (s && same(s.deps, deps)) return s.fn
      hooks[i] = { fn, deps }
      return fn
    },
    useEffect(fn, deps) {
      const i = hi++
      const s = hooks[i]
      if (s && deps && same(s.deps, deps)) return
      hooks[i] = { deps, cleanup: s?.cleanup }
      queue.push(() => {
        const slot = hooks[i]
        if (slot.cleanup) { try { slot.cleanup() } catch { /* ignore */ } }
        const c = fn()
        slot.cleanup = typeof c === 'function' ? c : null
      })
    },
  }
  async function fakeFetch(url, opts = {}) {
    const method = String(opts.method || 'GET').toUpperCase()
    const u = new URL(String(url), 'http://x')
    const path = u.pathname.replace(/^\/dsh-fish/, '')
    const body = opts.body ? JSON.parse(opts.body) : null
    calls.push({ method, path, body })
    const h = routes[`${method} ${path}`] ?? routes[path]
    let res = { status: 404, body: { error: 'no route' } }
    if (typeof h === 'function') res = await h({ method, path, body })
    else if (h) res = h
    const status = res.status ?? 200
    return { ok: status >= 200 && status < 300, status, json: async () => res.body ?? {} }
  }
  const sandbox = {
    window: {
      confirm: () => true,
      addEventListener() {},
      removeEventListener() {},
      location: { href: '' },
      Notification: { permission: 'default', requestPermission: async () => 'default' },
    },
    document: {
      head: { appendChild() {} },
      querySelector() { return null },
      createElement() { return { setAttribute() {}, click() {}, style: {} } },
      visibilityState: 'visible',
    },
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: fakeFetch,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    URL,
    console,
  }
  sandbox.globalThis = sandbox
  sandbox.window.__ModuleLoader__ = { load: (def) => { sandbox.__def = def } }
  vm.createContext(sandbox)
  vm.runInContext(CLIENT, sandbox, { filename: 'client.js' })
  const mod = sandbox.__def.factory((name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require: ${name}`)
  })
  let tree = null
  const render = () => {
    hi = 0
    try { tree = mod.FishSection() } catch (e) { errors.push(`render threw: ${e?.message ?? e}`); tree = null }
  }
  async function settle(rounds = 60) {
    for (let k = 0; k < rounds; k++) {
      dirty = false
      render()
      const q = queue
      queue = []
      for (const f of q) { try { f() } catch (e) { errors.push(`effect threw: ${e.message}`) } }
      await new Promise((r) => setTimeout(r, 5))
      if (!dirty && !queue.length) {
        await new Promise((r) => setTimeout(r, 20))
        if (!dirty) break
      }
    }
    return tree
  }
  const textsOf = (node, out = []) => {
    if (node == null || node === false || node === true) return out
    if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
    if (Array.isArray(node)) { for (const n of node) textsOf(n, out); return out }
    for (const c of node.props?.children || []) textsOf(c, out)
    return out
  }
  const textOf = (node) => textsOf(node, []).join('')
  const find = (pred, node = tree, out = []) => {
    if (!node || typeof node !== 'object') return out
    if (Array.isArray(node)) { for (const n of node) find(pred, n, out); return out }
    if (pred(node)) out.push(node)
    for (const c of node.props?.children || []) find(pred, c, out)
    return out
  }
  async function click(label, within) {
    const btn = find((n) => n.type === 'button' && textOf(n).includes(label), within ?? tree)[0]
    assert.ok(btn, `找不到按钮：${label}`)
    await btn.props.onClick?.({ preventDefault() {} })
    return settle()
  }
  return {
    settle,
    click,
    find,
    textOf,
    texts: () => textsOf(tree, []),
    calls,
    errors,
    get tree() { return tree },
  }
}

function stateWith(tools) {
  return {
    day: 3,
    growthDays: 30,
    stage: 1,
    stageName: '信任',
    counts: { total: 5, meta: 2, utterance: 1, chat: 0, revise: 0, refusal: 0, reunion: 0 },
    config: { tools, memory: {}, diary: {}, daily: {}, dream: { enabled: true } },
  }
}

const HER = ['growth_commit', 'her_recall', 'her_diary', 'her_leave', 'her_note', 'ask_owner', 'her_dream', 'her_say', 'read_image']

function routesFor({ restrict = true, allow = [], tools = null, toolsFail = false } = {}) {
  const st = stateWith({ restrict, allow })
  return {
    'GET /state': { body: st },
    'GET /config': { body: { config: st.config } },
    'GET /tools': toolsFail
      ? { status: 500, body: { error: 'boom' } }
      : { body: tools ?? { ok: true, known: [...HER, 'web_search'], ownLayer: [], blocked: [], herTools: HER, herSceneTools: [] } },
    'POST /config': ({ body }) => ({ body: { ok: true, config: { ...st.config, ...body } } }),
    // load() 用 Promise.all 等这三个：缺一个后面（含 /tools）就都不跑了。
    'GET /beliefs': { body: {} },
    'GET /diary': { body: {} },
    'GET /browse': { body: {} },
  }
}

/** 「她能用的工具」那张卡。 */
const toolsCard = (H) => H.find((n) => n.props?.className === 'card' && H.textOf(n).includes('她能用的工具'))[0]
/** 卡片说明里各句各占一个 div：取第一句。 */
const firstLine = (H) => {
  const card = toolsCard(H)
  const intro = H.find((n) => n.type === 'div' && n.props?.className === 'dim', card)[0]
  return H.textOf(intro.props.children[0])
}
const receipt = (H) => H.texts().find((t) => t.startsWith('存好了')) ?? ''
const noRenderErrors = (H) => assert.deepEqual(H.errors.filter((e) => e.startsWith('render threw')), [])

// ---------------------------------------------------------------------------
// 插件页「保存设置」的回执按收窄开没开说（0.9.5 只看名单空不空，两头都说反了）
// ---------------------------------------------------------------------------

test('收窄开着、白名单清空后保存：回执说她只剩自己那几件，不说「收窄关着」', async () => {
  const H = mount(routesFor({ restrict: true, allow: ['web_search'] }))
  await H.settle()
  await H.click('插件')
  const input = H.find((n) => n.type === 'input' && String(n.props.placeholder || '').startsWith('例如：web_search'))[0]
  input.props.onChange({ target: { value: '' } })
  await H.settle()
  await H.click('保存设置', toolsCard(H))
  const note = receipt(H)
  assert.ok(note, '要有回执')
  assert.ok(!note.includes('收窄关着'), `收窄开着，回执不能说它关着：${note}`)
  assert.ok(!note.includes('全部工具'), `收窄开着、名单空了，重启后她不会有全部工具：${note}`)
  assert.match(note, /只剩自己那几件/)
  noRenderErrors(H)
})

test('收窄关着时填一个名字保存：回执不说「多看见 1 个工具」——她本来就全看得见', async () => {
  const H = mount(routesFor({ restrict: false, allow: [] }))
  await H.settle()
  await H.click('插件')
  const input = H.find((n) => n.type === 'input' && String(n.props.placeholder || '').startsWith('例如：web_search'))[0]
  input.props.onChange({ target: { value: 'web_search' } })
  await H.settle()
  await H.click('保存设置', toolsCard(H))
  const note = receipt(H)
  const post = H.calls.filter((c) => c.method === 'POST' && c.path === '/config').at(-1)
  assert.deepEqual(post?.body?.tools, { restrict: false, allow: ['web_search'] }, '前提：存的是收窄关着 + 一个名字')
  assert.ok(!/多看见|少看见/.test(note), `收窄关着时白名单不限制她：${note}`)
  assert.match(note, /收窄关着/)
  noRenderErrors(H)
})

// ---------------------------------------------------------------------------
// 工具卡的几句说明（0.9.5：第一句看 herTools 拉没拉到；拉不到时把原因说成「没开过会话」）
// ---------------------------------------------------------------------------

test('/tools 拉不到时：第一句仍按开关说收窄开着，底下如实说名单没读到', async () => {
  const H = mount(routesFor({ restrict: true, toolsFail: true }))
  await H.settle()
  await H.click('插件')
  const first = firstLine(H)
  assert.ok(!first.includes('收窄现在是关着的'), `收窄开着，不能因为名单没拉到就说它关着：${first}`)
  assert.match(first, /收窄开着时/)
  const card = H.textOf(toolsCard(H))
  assert.ok(!card.includes('她还没在这台机器上开过会话'), '名单没读到不是因为她没开过会话')
  assert.match(card, /名单这次没读到/)
  noRenderErrors(H)
})

test('「工具面收窄」开关：提示写清关掉时别的插件的工具也放开、拨了就自动保存；底下那句不再说全都要按保存', async () => {
  const H = mount(routesFor({ restrict: true }))
  await H.settle()
  await H.click('插件')
  const fld = H.find((n) => n.props?.className === 'fld' && H.textOf(n).includes('工具面收窄'))[0]
  const hint = H.textOf(H.find((n) => n.props?.className === 'fhint', fld)[0])
  assert.match(hint, /别的插件/, `关掉时不挂守卫，别的插件的工具也放开：${hint}`)
  assert.match(hint, /自动保存/, hint)
  assert.match(hint, /重启/, hint)
  const card = H.textOf(toolsCard(H))
  assert.ok(!card.includes('改动都要先按「保存设置」写盘'), '开关不用按保存，别说「改动都要先按保存」')

  // 文案说的就是它真的会做的事：拨一下、不点保存，自己写一次盘。
  const before = H.calls.filter((c) => c.method === 'POST' && c.path === '/config').length
  const sw = H.find((n) => n.type === 'button' && n.props.role === 'switch', fld)[0]
  sw.props.onClick()
  await H.settle()
  await new Promise((r) => setTimeout(r, 900))
  await H.settle()
  const posts = H.calls.filter((c) => c.method === 'POST' && c.path === '/config').slice(before)
  assert.equal(posts.length, 1, '拨了开关就自动保存一次')
  assert.equal(posts[0].body.tools.restrict, false)
  noRenderErrors(H)
})

test('收窄关着时第一句也说清：不挂守卫，别的插件的工具她也全看得见', async () => {
  const H = mount(routesFor({ restrict: false }))
  await H.settle()
  await H.click('插件')
  const first = firstLine(H)
  assert.match(first, /收窄现在是关着的/)
  assert.match(first, /别的插件/, first)
})

// ---------------------------------------------------------------------------
// 「不用放行」那组按这一局真在她手上的名单摆（#69 第 9 条说的「同一份名单」）
// ---------------------------------------------------------------------------

test('关着梦启动、宿主没有 read_image：这两件不摆进「不用放行」，单列「这一局不在她手上」，也不在被挡那组重复', async () => {
  const allowNow = HER.filter((n) => n !== 'her_dream')
  const effective = allowNow.filter((n) => n !== 'read_image')
  const H = mount(routesFor({
    restrict: true,
    tools: {
      ok: true,
      known: [...effective, 'web_search'],
      ownLayer: [],
      blocked: [{ name: 'her_dream', count: 2 }, { name: 'web_search', count: 1 }],
      herTools: HER,
      herSceneTools: [],
      allowNow,
      effective,
      skipped: ['read_image'],
    },
  }))
  await H.settle()
  await H.click('插件')
  const card = toolsCard(H)
  const chips = (kind) => H.find((n) => n.type === 'button' && String(n.props.key || '').startsWith(`${kind}:`), card).map((n) => n.props.key.slice(kind.length + 1))
  const here = chips('her')
  assert.ok(!here.includes('her_dream'), `守卫拦着 her_dream，不能摆在「不用放行」：${here}`)
  assert.ok(!here.includes('read_image'), `宿主这次没有 read_image，不能摆在「不用放行」：${here}`)
  assert.ok(here.includes('growth_commit') && here.includes('her_say'), '真在手上的照旧在这组')
  assert.deepEqual(chips('away').sort(), ['her_dream', 'read_image'], '不在手上的单列一组')
  assert.match(H.textOf(card), /这一局不在她手上/)
  assert.deepEqual(chips('blk'), ['web_search'], 'her_dream 已经单列，不在被挡那组再摆一次')
  const away = H.find((n) => n.props?.key === 'away:her_dream', card)[0]
  assert.equal(away.props.disabled, true, '她自己的工具点不进白名单')
  noRenderErrors(H)
})

test('服务端不给 allowNow（收窄这一局没在管）时，她自己的照旧全摆在「不用放行」', async () => {
  const H = mount(routesFor({ restrict: true }))
  await H.settle()
  await H.click('插件')
  const card = toolsCard(H)
  const here = H.find((n) => n.type === 'button' && String(n.props.key || '').startsWith('her:'), card).map((n) => n.props.key.slice(4))
  assert.deepEqual(here.sort(), [...HER].sort())
  assert.ok(!H.textOf(card).includes('这一局不在她手上'))
})

test('白名单输入框旁写明存好之后要重启才对她生效（名单拉不到、上面那几组不出现时也看得见）', async () => {
  const H = mount(routesFor({ restrict: true, toolsFail: true }))
  await H.settle()
  await H.click('插件')
  const card = toolsCard(H)
  const input = H.find((n) => n.type === 'input' && String(n.props.placeholder || '').startsWith('例如：web_search'), card)[0]
  assert.ok(input, '前提：输入框在')
  assert.ok(!H.textOf(card).includes('点名字只是填进下面的框'), '前提：分组没摆出来')
  const near = H.find((n) => n.type === 'div' && n.props?.className === 'dim' && H.textOf(n).includes('白名单填工具名'), card)[0]
  assert.match(H.textOf(near), /重启 DSH 之后才对她生效/)
})

// ---------------------------------------------------------------------------
// 梦的开关：打开要重启才交到她手上（#64 的取舍带出来的时差，写在开关上）
// ---------------------------------------------------------------------------

test('「允许她记梦」的提示写明：关掉马上生效，打开要重启 DSH', async () => {
  const H = mount(routesFor({ restrict: true }))
  await H.settle()
  await H.click('成长')
  const fld = H.find((n) => n.props?.className === 'fld' && H.textOf(n).includes('允许她记梦'))[0]
  assert.ok(fld, '成长页要有梦的开关')
  const hint = H.textOf(H.find((n) => n.props?.className === 'fhint', fld)[0])
  assert.match(hint, /重启/, `打开梦要重启才对她生效，提示里得写：${hint}`)
  noRenderErrors(H)
})
