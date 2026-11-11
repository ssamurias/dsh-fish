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

function stateWith(tools, { dream = true } = {}) {
  return {
    day: 3,
    growthDays: 30,
    stage: 1,
    stageName: '信任',
    counts: { total: 5, meta: 2, utterance: 1, chat: 0, revise: 0, refusal: 0, reunion: 0 },
    config: { tools, memory: {}, diary: {}, daily: {}, dream: { enabled: dream } },
  }
}

const HER = ['growth_commit', 'her_recall', 'her_diary', 'her_leave', 'her_note', 'ask_owner', 'her_dream', 'her_say', 'read_image']

function routesFor({ restrict = true, allow = [], tools = null, toolsFail = false, beliefsFail = false, dream = true } = {}) {
  const st = stateWith({ restrict, allow }, { dream })
  return {
    'GET /state': { body: st },
    'GET /config': { body: { config: st.config } },
    'GET /tools': toolsFail
      ? { status: 500, body: { error: 'boom' } }
      : { body: tools ?? { ok: true, known: [...HER, 'web_search'], ownLayer: [], blocked: [], herTools: HER, herSceneTools: [] } },
    'POST /config': ({ body }) => ({ body: { ok: true, config: { ...st.config, ...body } } }),
    // load() 用 Promise.all 等这三个：缺一个后面（含 /tools）就都不跑了。
    'GET /beliefs': beliefsFail ? { status: 500, body: { error: 'boom' } } : { body: {} },
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

test('收窄开着、加了个名字保存：服务端说当场换了刀，回执就说现在就生效，不说重启（2026-11-11）', async () => {
  const routes = routesFor({ restrict: true, allow: ['web_search'] })
  // 0.9.8 起 /config 存完会回 toolsLive：有它就是当场换过刀了。
  routes['POST /config'] = ({ body }) => ({ body: { ok: true, toolsLive: { ok: true, deferred: 0 }, config: { ...body } } })
  const H = mount(routes)
  await H.settle()
  await H.click('插件')
  const input = H.find((n) => n.type === 'input' && String(n.props.placeholder || '').startsWith('例如：web_search'))[0]
  input.props.onChange({ target: { value: 'web_search, her_say' } })
  await H.settle()
  await H.click('保存设置', toolsCard(H))
  const note = receipt(H)
  assert.match(note, /现在就生效/, `存完当场换刀，回执得说现在就生效：${note}`)
  assert.match(note, /多看见 1 个/, note)
  assert.ok(!note.includes('重启'), `别再说重启：${note}`)
  noRenderErrors(H)
})

test('服务端没回 toolsLive（老版本/名单没动）：回执仍按老说法说重启之后，不能说「现在就生效」', async () => {
  const H = mount(routesFor({ restrict: true, allow: ['web_search'] }))
  await H.settle()
  await H.click('插件')
  const input = H.find((n) => n.type === 'input' && String(n.props.placeholder || '').startsWith('例如：web_search'))[0]
  input.props.onChange({ target: { value: 'web_search, her_say' } })
  await H.settle()
  await H.click('保存设置', toolsCard(H))
  const note = receipt(H)
  assert.match(note, /重启 DSH 之后/, note)
  assert.ok(!note.includes('现在就生效'), `没换刀就不能说现在就生效：${note}`)
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

/** 新版服务端的 /tools：allowNow 总在（收窄这一局没在管时是 null）。 */
const toolsBody = (extra = {}) => ({ ok: true, known: [...HER, 'web_search'], ownLayer: [], blocked: [], herTools: HER, herSceneTools: [], allowNow: null, effective: null, skipped: [], skippedSure: null, ...extra })
/** 卡片底部那句（分组下面、白名单输入框上面）。 */
const bottomLine = (H) => {
  const card = toolsCard(H)
  return H.find((n) => n.type === 'div' && n.props?.className === 'dim' && /加不加都不影响她|存好当场就对她生效/.test(H.textOf(n)), card).map((n) => H.textOf(n)).at(-1) ?? ''
}

test('收窄关着时第一句也说清：不挂守卫，别的插件的工具她也全看得见', async () => {
  // 这一局收窄也没在管（allowNow 是 null）：按这一局说。
  const H = mount(routesFor({ restrict: false, tools: toolsBody() }))
  await H.settle()
  await H.click('插件')
  const first = firstLine(H)
  assert.match(first, /收窄这一局是关着的/)
  assert.match(first, /别的插件/, first)
  // 名单没读到：只能按开关说，把「拨过开关要重启」说出来，不说成「现在」。
  const F = mount(routesFor({ restrict: false, toolsFail: true }))
  await F.settle()
  await F.click('插件')
  const f2 = firstLine(F)
  assert.match(f2, /别的插件/, f2)
  assert.ok(!f2.includes('现在'), `不知道这一局收窄在不在管，不能说「现在」：${f2}`)
  assert.match(f2, /重启 DSH 之后才按新的来/, f2)
})

test('拨了「工具面收窄」、还没重启：第一句和底部那句按这一局说，写明重启之后才变', async () => {
  // 开着收窄启动，在页面上关掉（开关自动存盘）：这一局守卫还在拦。
  const allowNow = HER.slice()
  const off = mount(routesFor({ restrict: false, tools: toolsBody({ allowNow, effective: allowNow, skippedSure: true }) }))
  await off.settle()
  await off.click('插件')
  const f1 = firstLine(off)
  assert.ok(!/收窄现在是关着的|收窄这一局是关着的|她全看得见/.test(f1), `这一局还在收窄，不能说已经不收窄了：${f1}`)
  assert.match(f1, /已经关掉/, f1)
  assert.match(f1, /这一局还在收窄/, f1)
  assert.match(f1, /重启 DSH 之后才/, f1)
  const b1 = bottomLine(off)
  assert.match(b1, /这一局守卫还按启动时的名单拦/, b1)
  assert.ok(!b1.includes('收窄现在是关着的'), b1)
  noRenderErrors(off)

  // 关着收窄启动，在页面上打开：这一局没在收窄。
  const on = mount(routesFor({ restrict: true, tools: toolsBody() }))
  await on.settle()
  await on.click('插件')
  const f2 = firstLine(on)
  assert.match(f2, /已经打开/, f2)
  assert.match(f2, /这一局没在收窄/, f2)
  assert.match(f2, /重启 DSH 之后/, f2)
  noRenderErrors(on)
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
  // read_image 守卫放行、只是宿主没给：白名单帮不上，只读。
  const img = H.find((n) => n.props?.key === 'away:read_image', card)[0]
  assert.equal(img.props.disabled, true, '宿主没给的，点进白名单也没用')
  noRenderErrors(H)
})

test('关着梦启动的 her_dream：只读，不走白名单（#64：收窄里的梦跟着开关走），提示按梦开关现在开没开说', async () => {
  const allowNow = HER.filter((n) => n !== 'her_dream')
  const tools = toolsBody({ known: [...HER, 'web_search'], blocked: [{ name: 'her_dream', count: 2 }], allowNow, effective: allowNow, skippedSure: true })
  // 关着梦启动、之后在设置页打开了：重启就回到她手上，不用填白名单。
  const H = mount(routesFor({ restrict: true, tools, dream: true }))
  await H.settle()
  await H.click('插件')
  const card = toolsCard(H)
  const dream = H.find((n) => n.props?.key === 'away:her_dream', card)[0]
  assert.ok(dream, '守卫拦着 her_dream，摆在「这一局不在她手上」')
  assert.equal(dream.props.disabled, true, '点进白名单会让守卫一直放行 her_dream，关掉梦也挡不住')
  assert.equal(dream.props.onClick, undefined)
  const t1 = String(dream.props.title)
  assert.match(t1, /允许她记梦/, t1)
  assert.match(t1, /重启 DSH 就回到她手上/, t1)
  assert.match(t1, /不用填白名单/, t1)
  assert.ok(!t1.includes('点一下填进白名单'), t1)
  assert.match(t1, /伸手被挡过 2 次/, t1)
  const hint = H.textOf(card)
  assert.match(hint, /her_dream 跟着「允许她记梦」走，不走白名单/, '组上那句也说清')
  const input = H.find((n) => n.type === 'input' && String(n.props.placeholder || '').startsWith('例如：web_search'), card)[0]
  assert.ok(!/\bher_dream\b/.test(String(input.props.value)), '白名单输入框里不会出现 her_dream')
  noRenderErrors(H)

  // 梦现在也关着：它本来就不在，想要就打开开关再重启。
  const O = mount(routesFor({ restrict: true, tools, dream: false }))
  await O.settle()
  await O.click('插件')
  const d2 = O.find((n) => n.props?.key === 'away:her_dream', toolsCard(O))[0]
  assert.equal(d2.props.disabled, true)
  const t2 = String(d2.props.title)
  assert.match(t2, /「允许她记梦」关着/, t2)
  assert.match(t2, /打开那颗开关再重启 DSH/, t2)
  assert.ok(!t2.includes('点一下填进白名单'), t2)
  noRenderErrors(O)
})

test('宿主没给 visible（skippedSure 为 false）：没下给 restrict 的 read_image 不说成定论，跟自检同一个口径', async () => {
  const allowNow = HER.slice()
  const effective = HER.filter((n) => n !== 'read_image')
  const H = mount(routesFor({ restrict: true, tools: toolsBody({ known: [...effective, 'web_search'], allowNow, effective, skipped: ['read_image'], skippedSure: false }) }))
  await H.settle()
  await H.click('插件')
  const card = toolsCard(H)
  assert.equal(H.find((n) => n.props?.key === 'away:read_image', card).length, 0, '分不清时不能摆进「这一局不在她手上」')
  assert.equal(H.find((n) => n.props?.key === 'her:read_image', card).length, 0, '也不能摆进「不用放行」')
  const chip = H.find((n) => n.props?.key === 'unsure:read_image', card)[0]
  assert.ok(chip, '单列「说不准」那组')
  assert.equal(chip.props.disabled, true, '白名单帮不上')
  const title = String(chip.props.title)
  assert.ok(!title.includes('宿主这一局没交给她'), `不能说定论：${title}`)
  assert.match(title, /可能这次没注册，也可能在她自己那一层/, title)
  assert.match(H.textOf(card), /说不准这一局在不在她手上/)

  // 给了 visible（skippedSure 为 true）时照旧说得准：宿主这次没给。
  const S = mount(routesFor({ restrict: true, tools: toolsBody({ known: [...effective, 'web_search'], allowNow, effective, skipped: ['read_image'], skippedSure: true }) }))
  await S.settle()
  await S.click('插件')
  const sure = S.find((n) => n.props?.key === 'away:read_image', toolsCard(S))[0]
  assert.ok(sure, '说得准时照旧摆在「这一局不在她手上」')
  assert.match(String(sure.props.title), /宿主这一局没交给她/)
  noRenderErrors(H)
  noRenderErrors(S)
})

test('her_say 不在这一局的名单里（新启动时的 her_say 那条）：摆在「这一局不在她手上」，能点进白名单', async () => {
  const allowNow = HER.filter((n) => n !== 'her_say')
  const H = mount(routesFor({
    restrict: true,
    tools: {
      ok: true,
      known: [...HER, 'web_search'],
      ownLayer: [],
      blocked: [{ name: 'her_say', count: 3 }],
      herTools: HER,
      herSceneTools: [],
      allowNow,
      effective: allowNow,
      skipped: [],
    },
  }))
  await H.settle()
  await H.click('插件')
  const card = toolsCard(H)
  const chip = H.find((n) => n.props?.key === 'away:her_say', card)[0]
  assert.ok(chip, '守卫拦着 her_say，它不在「不用放行」那组')
  assert.ok(!chip.props.disabled, '白名单里填 her_say 守卫就放行，这条路不能堵上')
  assert.match(String(chip.props.title), /伸手被挡过 3 次/, chip.props.title)
  assert.match(String(chip.props.title), /点一下填进白名单/, chip.props.title)
  noRenderErrors(H)
})

test('前面的请求失败时，工具卡不停在「读取中」：/tools 自己单独发', async () => {
  const H = mount(routesFor({ restrict: true, beliefsFail: true }))
  await H.settle()
  await H.click('插件')
  assert.ok(H.calls.some((c) => c.method === 'GET' && c.path === '/tools'), '/beliefs 失败了 /tools 也要发')
  const card = H.textOf(toolsCard(H))
  assert.ok(!card.includes('读取中'), `不能一直挂着「读取中」：${card}`)
  assert.match(card, /她自己本来就有的/, '名单读到了就照常摆出来')
})

test('服务端不给 allowNow（老版本）时，她自己的照旧全摆在「不用放行」', async () => {
  const H = mount(routesFor({ restrict: true }))
  await H.settle()
  await H.click('插件')
  const card = toolsCard(H)
  const here = H.find((n) => n.type === 'button' && String(n.props.key || '').startsWith('her:'), card).map((n) => n.props.key.slice(4))
  assert.deepEqual(here.sort(), [...HER].sort())
  assert.ok(!H.textOf(card).includes('这一局不在她手上'))
})

test('白名单输入框旁写明存好当场生效（名单拉不到、上面那几组不出现时也看得见）', async () => {
  const H = mount(routesFor({ restrict: true, toolsFail: true }))
  await H.settle()
  await H.click('插件')
  const card = toolsCard(H)
  const input = H.find((n) => n.type === 'input' && String(n.props.placeholder || '').startsWith('例如：web_search'), card)[0]
  assert.ok(input, '前提：输入框在')
  assert.ok(!H.textOf(card).includes('点名字只是填进下面的框'), '前提：分组没摆出来')
  const near = H.find((n) => n.type === 'div' && n.props?.className === 'dim' && H.textOf(n).includes('白名单填工具名'), card)[0]
  assert.match(H.textOf(near), /当场就对她生效/)
  assert.ok(!/要重启 DSH/.test(H.textOf(near)), '存完当场换刀了，别再说要重启')
})

// ---------------------------------------------------------------------------
// 梦的开关：打开要重启才交到她手上（#64 的取舍带出来的时差，写在开关上）
// ---------------------------------------------------------------------------

const dreamHint = async (H) => {
  await H.settle()
  await H.click('成长')
  const fld = H.find((n) => n.props?.className === 'fld' && H.textOf(n).includes('允许她记梦'))[0]
  assert.ok(fld, '成长页要有梦的开关')
  return H.textOf(H.find((n) => n.props?.className === 'fhint', fld)[0])
}

test('关着梦启动的这一局：「允许她记梦」的提示写明关掉马上生效、打开要重启 DSH', async () => {
  const allowNow = HER.filter((n) => n !== 'her_dream')
  const H = mount(routesFor({
    restrict: true,
    tools: { ok: true, known: HER, ownLayer: [], blocked: [], herTools: HER, herSceneTools: [], allowNow, effective: allowNow, skipped: [] },
  }))
  const hint = await dreamHint(H)
  assert.match(hint, /打开之后要重启 DSH/, `打开梦要重启才对她生效，提示里得写：${hint}`)
  noRenderErrors(H)
})

test('开着梦启动、或收窄这一局没在管：「允许她记梦」不说要重启（her_dream 本来就在她手上）', async () => {
  const on = mount(routesFor({
    restrict: true,
    tools: { ok: true, known: HER, ownLayer: [], blocked: [], herTools: HER, herSceneTools: [], allowNow: HER, effective: HER, skipped: [] },
  }))
  const h1 = await dreamHint(on)
  assert.ok(!h1.includes('重启'), `开着梦启动，开关当场生效：${h1}`)
  const off = mount(routesFor({ restrict: false }))
  const h2 = await dreamHint(off)
  assert.ok(!h2.includes('重启'), `收窄关着时没有守卫，开关当场生效：${h2}`)
})
