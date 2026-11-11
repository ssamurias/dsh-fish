/**
 * client-copy.test.mjs —— 设置页的说明要跟 0.9.5 的代码对得上（接 #59）
 *
 * 这些用例不查源码里有没有某个字符串，而是真的把设置页渲染出来、按按钮、往数字框里打字，
 * 再看用户在页面上读到的是什么：说明、悬停提示、回执、保存失败框。
 *
 * 和 client.test.mjs 的假 React 不一样的地方：这里的 state 跨渲染保留，setter 真的改值，
 * 所以「点一下 → 再渲染一次」能看到回执；useEffect 只收集不执行，需要哪一个就手动跑哪一个
 * （自动保存那一个按依赖认出来），别的定时器、轮询一个都不起。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(HERE, '..', 'lib', 'client.js')
const SRC = await readFile(CLIENT, 'utf8')

// ---------------------------------------------------------------------------
// 渲染工具
// ---------------------------------------------------------------------------

/** FishSection 里每个 useState 的下标，按变量名取，免得用例里写死数字。 */
function stateIndex(src) {
  const start = src.indexOf('function FishSection()')
  const end = src.indexOf('function apply(ctx)', start)
  assert.ok(start > 0 && end > start, '要能定位 FishSection')
  const out = {}
  let i = 0
  for (const line of src.slice(start, end).split('\n')) {
    if (/^\s*\/\//.test(line) || !line.includes('useState(')) continue
    const m = line.match(/const \[(\w*),\s*set\w+\] = useState\(/)
    if (m && m[1]) out[m[1]] = i
    i += 1
  }
  return out
}
const IDX = stateIndex(SRC)

function liveReact(seed = {}) {
  const vals = new Map()
  for (const [name, v] of Object.entries(seed)) {
    assert.ok(name in IDX, `FishSection 里没有叫 ${name} 的 state`)
    vals.set(IDX[name], v)
  }
  const refs = []
  let si = 0
  let ri = 0
  let effects = []
  const h = (type, props, ...children) => ({
    type,
    props: props || {},
    children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false),
  })
  return {
    createElement: h,
    useState(init) {
      const i = si++
      if (!vals.has(i)) vals.set(i, typeof init === 'function' ? init() : init)
      return [vals.get(i), (v) => { vals.set(i, typeof v === 'function' ? v(vals.get(i)) : v) }]
    },
    useRef(init) {
      const i = ri++
      if (!(i in refs)) refs[i] = { current: init }
      return refs[i]
    },
    useEffect(fn, deps) { effects.push({ fn, deps }) },
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    begin() { si = 0; ri = 0; effects = [] },
    effects: () => effects,
  }
}

async function mount(seed = {}) {
  const react = liveReact(seed)
  const loaded = []
  const window = { __ModuleLoader__: { load(spec) { loaded.push(spec) } } }
  const document = {
    querySelector: () => null,
    createElement: () => ({ setAttribute() {}, textContent: '' }),
    head: { appendChild() {} },
  }
  const req = (id) => {
    if (id === 'react') return react
    throw new Error(`unexpected require: ${id}`)
  }
  new Function('window', 'require', 'document', SRC)(window, req, document)
  const ex = loaded[0].factory(req)
  const render = () => { react.begin(); return ex.FishSection() }
  // 自动保存那一个 effect：依赖以 [cfgSig, state] 开头（后面再多一个依赖也认得出）
  const runAutosave = () => {
    const e = react.effects().find((x) => Array.isArray(x.deps) && x.deps.length >= 2
      && typeof x.deps[0] === 'string' && x.deps[0].startsWith('{') && x.deps[1] === seed.state)
    assert.ok(e, '要能认出自动保存那个 effect')
    e.fn()
  }
  return { render, runAutosave }
}

/** 假的同源接口：没登记的路径一律 404。 */
function stubFetch(routes) {
  const prev = globalThis.fetch
  globalThis.fetch = async (url, opts = {}) => {
    const path = String(url).replace(/^\/dsh-fish/, '')
    const key = Object.keys(routes).find((k) => path === k || path.startsWith(`${k}?`))
    if (!key) return { ok: false, status: 404, json: async () => ({ error: 'not found' }) }
    const body = typeof routes[key] === 'function' ? routes[key](path, opts) : routes[key]
    return { ok: true, status: 200, json: async () => body }
  }
  return () => { globalThis.fetch = prev }
}

function textOf(node, out = []) {
  if (node == null || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const n of node) textOf(n, out); return out }
  if (node.children) for (const c of node.children) textOf(c, out)
  return out
}
const text = (node) => textOf(node).join('')

function findAll(node, pred, out = []) {
  if (node == null || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const n of node) findAll(n, pred, out); return out }
  if (pred(node)) out.push(node)
  for (const c of node.children || []) findAll(c, pred, out)
  return out
}
const hasClass = (n, c) => String(n?.props?.className || '').split(/\s+/).includes(c)

/** 一个设置项（Num / Sel / Toggle / Text / TimeRange）：按控件上的名字找。 */
function field(tree, label) {
  const hit = findAll(tree, (n) => hasClass(n, 'fld')
    && findAll(n, (x) => hasClass(x, 'flabel') && text(x) === label).length > 0)
  assert.equal(hit.length, 1, `页面上要正好有一个叫「${label}」的设置项`)
  return hit[0]
}
const hintOf = (tree, label) => text(findAll(field(tree, label), (x) => hasClass(x, 'fhint'))[0])

/** 一张卡（group / groupFull）：按标题找，返回 { note, all } */
function card(tree, title) {
  const hit = findAll(tree, (n) => hasClass(n, 'card')
    && n.children.some((c) => c && c.type === 'h3' && text(c) === title))
  assert.equal(hit.length, 1, `页面上要正好有一张叫「${title}」的卡`)
  const c = hit[0]
  const p = c.children.find((x) => x && x.type === 'p' && hasClass(x, 'hint'))
  return { note: p ? text(p) : '', all: text(c), node: c }
}

/** 状态卡里一行「名称 — 值 ⓘ」的值和悬停说明 */
function row(tree, name) {
  const hit = findAll(tree, (n) => n.type === 'div' && n.children.length >= 2
    && n.children[0]?.type === 'span' && text(n.children[0]) === name)
  assert.ok(hit.length >= 1, `状态卡里要有「${name}」这一行`)
  const r = hit[0]
  const tip = findAll(r, (x) => typeof x.props?.title === 'string' && x.props.title)[0]
  return { value: text(r.children[1]).replace(/ⓘ$/, ''), tip: tip ? tip.props.title : '' }
}

function button(tree, label) {
  const hit = findAll(tree, (n) => n.type === 'button' && text(n) === label)
  assert.ok(hit.length >= 1, `页面上要有「${label}」这颗按钮`)
  return hit[0]
}

/** 页签栏上方那条 note（<pre class="ok">） */
const noteOf = (tree) => findAll(tree, (n) => n.type === 'pre' && hasClass(n, 'ok')).map(text).join('\n')

function stateWith(extra = {}) {
  return {
    day: 12, growthDays: 30, stage: 2, stageName: '自主', stageForced: false,
    pendingGate: 'autonomy', name: null, beliefCount: 3, absenceDays: 0,
    counts: { utterance: 5, chat: 2, revise: 1, refusal: 1, reunion: 0, total: 9, meta: 4 },
    quality: {
      stability: { score: 0.4, sample: 10, k: 1, beliefs: 3, visible: 3 },
      consistency: { score: 0.6, pairs: 4 },
      novelty: { score: 0.5, recent: 2, older: 3 },
    },
    config: { window: ['20:00', '23:00'], daily: { events: 1, questions: 1 }, diary: {}, absenceAfterDays: 3 },
    ...extra,
  }
}

// ---------------------------------------------------------------------------
// 成长页 / 状态卡：阶段与瓶颈
// ---------------------------------------------------------------------------

test('阶段说明写明成长期满后没过的瓶颈会放行，不再只说「要自己突破」', async () => {
  const { render } = await mount({ state: stateWith() })
  const tip = row(render(), '当前阶段').tip
  assert.match(tip, /成长期满后没过的自动放行/, `当前阶段的悬停说明：${tip}`)
  assert.doesNotMatch(tip, /但每个瓶颈要自己突破/, '只说要自己突破，等于说永远卡着')
})

test('第四阶段没有瓶颈：阶段卡说清楚整合是按天数进的', async () => {
  const { render } = await mount({ state: stateWith(), tab: 'grow' })
  const c = card(render(), '四个阶段与三道瓶颈')
  assert.ok(c.all.includes('整合没有瓶颈'), `阶段卡：${c.all}`)
  // 用户定的四行一字不动
  assert.ok(c.all.includes('4 整合 · 回顾过去经历，有意识地发现自己的改变'))
})

// ---------------------------------------------------------------------------
// 成长页：主动搭话、主观能动性、兴趣、空醒、字数、时段
// ---------------------------------------------------------------------------

test('主观能动性：劲儿按时间攒，只在醒的时段里看，桌上没东西不开', async () => {
  const { render } = await mount({ state: stateWith(), tab: 'grow' })
  const note = card(render(), '主观能动性').note
  assert.doesNotMatch(note, /桌上越有可说的东西，攒得越快/, '桌上的东西是一次性加一点，不是越攒越快')
  assert.match(note, /每天几点醒/, '要说只在醒的时段里看')
  assert.match(note, /半小时/, '要说多久看一次')
  assert.match(note, /桌上也有东西，才自己开一轮/, '空桌不开要写出来')
})

test('主动搭话：开不开这一轮由闸门定，开了以后说不说才由她', async () => {
  const { render } = await mount({ state: stateWith(), tab: 'grow' })
  const note = card(render(), '主动搭话').note
  assert.doesNotMatch(note, /那是她的判断/, `开不开一轮不是她判断的：${note}`)
  assert.match(note, /开了之后说不说，由她/)
})

test('兴趣：桌上摆的东西写全，关掉以后主动搭话照样能开', async () => {
  const { render } = await mount({ state: stateWith(), tab: 'grow' })
  const note = card(render(), '兴趣').note
  assert.doesNotMatch(note, /你回没回/, '回音只看你后来来没来过，不看回没回')
  assert.doesNotMatch(note, /她只会按时被叫醒/, '主动搭话不读这个开关')
  assert.match(note, /手上没有的东西/, '够不着的、撞过墙的也会摆')
  assert.match(note, /主动搭话开不开一轮不看这个开关/)
})

test('空醒：写出真正的触发条件，摆旧句子的那种不归这个开关', async () => {
  const { render } = await mount({ state: stateWith(), tab: 'grow' })
  const hint = hintOf(render(), '醒着没事时，自己找点事做')
  assert.doesNotMatch(hint, /桌上也没有东西/, `触发条件不是「桌上没东西」：${hint}`)
  assert.match(hint, /过去 7 天她一件自己的事都没做/)
  assert.match(hint, /归「兴趣」管/)
})

test('字数上限只加在事件卡和 /say 递进来的话上', async () => {
  const { render } = await mount({ state: stateWith(), tab: 'grow' })
  const hint = hintOf(render(), '她一轮最多写多少字')
  assert.doesNotMatch(hint, /对随后的对话生效/, `会话里直接聊不带长度要求：${hint}`)
  assert.match(hint, /事件卡/)
  assert.match(hint, /主动搭话那一轮不带/)
})

test('醒的时段：起止填成同一时刻会被换回默认，界面要先说', async () => {
  const { render } = await mount({ state: stateWith(), tab: 'grow' })
  const hint = hintOf(render(), '每天几点醒')
  assert.match(hint, /起止不能是同一时刻/, `说明：${hint}`)
  assert.match(hint, /20:00–23:00/)
})

// ---------------------------------------------------------------------------
// 状态页
// ---------------------------------------------------------------------------

test('互动计数：改口里修正、确认也算', async () => {
  const { render } = await mount({ state: stateWith() })
  const tip = row(render(), '互动计数').tip
  assert.match(tip, /推翻或修正/, `互动计数的口径：${tip}`)
  assert.match(tip, /确认还成立也算一次/)
})

test('一致：说清只比字面，不判断矛盾', async () => {
  const { render } = await mount({ state: stateWith() })
  const tip = row(render(), '一致').tip
  assert.doesNotMatch(tip, /打不打架/, `它量的不是矛盾：${tip}`)
  assert.match(tip, /字面/)
})

test('新鲜：只数她自己写下的话，侧栏里聊过天也不算', async () => {
  const quiet = stateWith({ quality: { ...stateWith().quality, novelty: { score: 0, recent: 0, older: 3 } } })
  const { render } = await mount({ state: quiet })
  const r = row(render(), '新鲜')
  assert.equal(r.value, '最近一周没写下自己的话', '一周里只聊过天时，不能说成「没说过话」')
  assert.match(r.tip, /对话里回你的不算/)
})

test('规则约束：条件够了不等于一定会提，驳回到上限后不再写「等她开口」', async () => {
  const rules = {
    pending: null,
    offersOn: true,
    layers: [{ name: '成长层', mutable: true, note: '可以自己申请。', rules: [{ id: 'r1', title: '试一件新事', inPrompt: true }] }],
    status: [{ id: 'r1', active: false, ready: true }],
  }
  const { render } = await mount({ state: stateWith(), rules })
  const tree = render()
  const line = findAll(tree, (n) => n.type === 'div' && text(n).startsWith('· 试一件新事'))[0]
  assert.ok(line, '规则那一行要在')
  assert.doesNotMatch(text(line), /等她开口/, `${text(line)}`)
  assert.match(text(line), /条件够了/)
  const tip = String(line.props.title || '')
  assert.match(tip, /驳回到上限/, '悬停要说清什么时候不会再提')
  // 挂在一条规则上，说的就是这一条：不写成「条件够了的」那一类。
  // 到期日（证据日加 1–3 天）可能已经过了，那就是下一次醒来就提，不写「过几天」。
  assert.match(tip, /^条件够了，她之后醒来时会提一次申请/, `悬停：${tip}`)
  assert.doesNotMatch(tip, /过几天/, `到期日可能已经过了：${tip}`)

  // 悬停要按这条规则现在的处境说，不能一律写「过几天会提」
  const tipFor = async (over) => {
    const app = await mount({ state: stateWith(), rules: { ...rules, ...over } })
    const l = findAll(app.render(), (n) => n.type === 'div' && text(n).startsWith('· 试一件新事'))[0]
    return String(l?.props?.title || '')
  }
  // 申请已经挂在卡上
  const pendingTip = await tipFor({
    pending: { id: 'o3', rule: 'r1', why: '我想试试「试一件新事」这件事。' },
    status: [{ id: 'r1', active: false, ready: true, pending: 'o3' }],
  })
  assert.doesNotMatch(pendingTip, /醒来时会提/, `已经提了还说之后会提：${pendingTip}`)
  assert.match(pendingTip, /在上面等你答/)
  // 已经驳回两次（到上限）
  const capTip = await tipFor({
    history: [
      { id: 'o1', rule: 'r1', verdict: 'reject' },
      { id: 'o2', rule: 'r1', verdict: 'reject' },
    ],
  })
  assert.doesNotMatch(capTip, /醒来时会提/, `到上限了还说之后会提：${capTip}`)
  assert.match(capTip, /已经驳回到上限，她不会再自动提/)
  // 申请通道关着
  const offTip = await tipFor({ offersOn: false })
  assert.match(offTip, /申请通道现在关着，她不会自动提/, `通道关着：${offTip}`)
})

test('驳回上限：界面数到的次数和调度器用的冷却档数是同一个数', async () => {
  // 悬停和回执里的「驳回到上限（N 次）」是前端按历史数的；调度器拿 offerLimits(config) 的 retryDays，
  // 驳回次数到了档数就不再自动提（offerDueDay 回 null）。哪边改了档数，这里要红。
  const { offerLimits } = await import('../lib/unlock.js')
  const max = offerLimits({}).retryDays.length
  for (const cooldownDays of [1, 3, 30, 'x']) {
    assert.equal(offerLimits({ rules: { cooldownDays } }).retryDays.length, max,
      `cooldownDays=${cooldownDays} 只改天数，不改档数`)
  }
  const tipAfter = async (rejects) => {
    const rules = {
      pending: null,
      offersOn: true,
      layers: [{ name: '成长层', mutable: true, note: '可以自己申请。', rules: [{ id: 'r1', title: '试一件新事', inPrompt: true }] }],
      status: [{ id: 'r1', active: false, ready: true }],
      history: Array.from({ length: rejects }, (_, i) => ({ id: `o${i}`, rule: 'r1', verdict: 'reject' })),
    }
    const app = await mount({ state: stateWith(), rules })
    const l = findAll(app.render(), (n) => n.type === 'div' && text(n).startsWith('· 试一件新事'))[0]
    return String(l?.props?.title || '')
  }
  const below = await tipAfter(max - 1)
  assert.match(below, new RegExp(`驳回到上限（${max} 次）之后就不会再自动提`), `差一次到上限：${below}`)
  assert.doesNotMatch(below, /已经驳回到上限/, `差一次到上限：${below}`)
  const at = await tipAfter(max)
  assert.match(at, /已经驳回到上限，她不会再自动提/, `驳回了 ${max} 次：${at}`)
})

test('裁决她的申请之后有回执', async () => {
  const pending = { id: 'o1', rule: 'r1', why: '我想试试「试一件新事」这件事。不是现在就要，是想问问你。' }
  const rules = { pending, offersOn: true, layers: [], status: [] }
  // 第二次驳回就到上限了（unlock.js 的 offerLimits 只有两档冷却）
  const once = { ...rules, history: [{ id: 'o0', rule: 'r1', verdict: 'reject' }, { id: 'o1', rule: 'r1', verdict: 'pending' }] }
  for (const [label, rs, want, not] of [
    ['可以', rules, /答应了/],
    ['这次不行', rules, /记下了「这次不行」。条件还够的话，过几天她可能再提一次；再驳回 1 次就不再自动提/],
    ['这次不行', once, /这条已经驳回到上限，以后她不会再自动提了/, /过几天她可能再提一次/],
    ['这次不行', { ...rules, offersOn: false }, /申请通道现在关着，她不会再自动提/, /过几天她可能再提一次/],
  ]) {
    const s = stateWith()
    const restore = stubFetch({ '/decide': { ok: true }, '/state': s })
    try {
      const app = await mount({ state: s, rules: rs })
      await button(app.render(), label).props.onClick()
      const note = noteOf(app.render())
      assert.match(note, want, `点「${label}」之后的回执：${note || '（没有）'}`)
      if (not) assert.doesNotMatch(note, not, `这一次之后不会再提了：${note}`)
    } finally { restore() }
  }
})

test('B 站登录提示卡：只有发评论和回复必须登录', async () => {
  const { render } = await mount({ state: stateWith(), ow: { hasCookie: false } })
  const c = card(render(), '还没存 B 站登录')
  assert.doesNotMatch(c.all, /看视频画面、读评论、回评都要用到它/, `读热评、看画面不带 cookie 也会去做：${c.all}`)
  assert.match(c.all, /发评论和回复要用到它/)
  // 看画面没有 cookie 也会去取，可直链缺登录态可能拉不到：不能说看画面用不着它
  assert.match(c.all, /看画面没有它也会试着取，但不一定取得到/, `${c.all}`)
})

test('页头的数叫「记录」，悬停不再把日记算进去', async () => {
  const s = stateWith()
  const { render } = await mount({ state: s, tab: 'memory', mem: { events: s.counts.total, diaries: 2 } })
  const tree = render()
  const sub = findAll(tree, (n) => n.type === 'p' && hasClass(n, 'sub'))[0]
  assert.ok(sub, '页头那行要在')
  assert.ok(text(sub).includes(`记录 ${s.counts.total} 条`), `页头：${text(sub)}`)
  assert.ok(!text(sub).includes('她记下'), '对话里回的话、她读到的别人说法都在这个数里，不只是她记下的')
  assert.match(sub.props.title, /日记写在文件里/, `页头悬停：${sub.props.title}`)
  assert.doesNotMatch(sub.props.title, /她自己写的判断、留话、日记/, '日记不在这个数里')
  // 记忆页那一行说的是同一个数，叫法要对得上
  const memRow = findAll(tree, (n) => typeof n.props?.title === 'string' && text(n).startsWith('· 记录：'))[0]
  assert.ok(memRow, '记忆页「记录」那一行要在')
  assert.match(memRow.props.title, /页头的「记录」/)
})

// ---------------------------------------------------------------------------
// 上网页
// ---------------------------------------------------------------------------

test('每次翻几条：挑中的都整条取来，不是她挑着细读', async () => {
  const { render } = await mount({ state: stateWith(), tab: 'bili' })
  const hint = hintOf(render(), '每次翻几条')
  assert.doesNotMatch(hint, /想读的才会细读/, `说明：${hint}`)
  assert.match(hint, /整条取来/)
})

test('评论区那颗开关只管记不记那一句，热评照样给她读', async () => {
  const { render } = await mount({ state: stateWith(), tab: 'bili' })
  const tree = render()
  assert.equal(findAll(tree, (n) => hasClass(n, 'flabel') && text(n) === '把评论区的话也给她读').length, 0,
    '关掉也读得到热评，开关不能叫「给她读」')
  const hint = hintOf(tree, '记下评论区的一句话')
  assert.match(hint, /热评照样跟着视频给她读/)
  // 记下的那句不只摆进自我描述，还会让「你今天在评论区读到一个人写…」那张事件卡出得来（events.js 的 someone_said）
  assert.match(hint, /事件卡/, `关掉的后果要说全：${hint}`)
  assert.doesNotMatch(hint, /关掉只是不再记这一句/, '关掉连那张卡和自我描述里那一行也没了，不只是少记一句')
  assert.match(hint, /已经记下的那句最多再摆 7 天/, '已经记下的不会因为关掉就立刻消失')
  assert.match(hint, /每条读几条热评/, '真想不让她读，要指到管热评的那一项')
})

test('up 主黑名单是你填的，她没有拉黑的工具', async () => {
  const { render } = await mount({ state: stateWith(), tab: 'bili' })
  const hint = hintOf(render(), 'up主黑名单')
  assert.doesNotMatch(hint, /已被大肥鱼拉黑/, `说明：${hint}`)
  assert.match(hint, /她自己拉黑不了/)
})

test('领养人验证：@ 用昵称、uid 认回复；没存的会被重读换掉', async () => {
  const ow = { hasCookie: true, hasCsrf: true, account: { mid: 4242, name: '小号' } }
  const { render } = await mount({ state: stateWith(), tab: 'bili', ow, owMid: '4242', owName: '小号' })
  const tree = render()
  const c = card(tree, '领养人验证')
  assert.doesNotMatch(c.note, /存 cookie、点测试都不会改这两格/, `「保存 cookie」会顺带提交这两格：${c.note}`)
  assert.match(c.note, /uid 用来认出你在她评论下的回复/)
  assert.match(c.note, /换回已存的值/)
  assert.doesNotMatch(c.all, /改成你要 @ 的 uid/, '@ 只用昵称')
  const testHint = findAll(tree, (n) => n.type === 'span' && hasClass(n, 'hint') && text(n).startsWith('测试只查'))[0]
  assert.ok(testHint, '测试键旁边那句要在')
  assert.match(text(testHint), /没存的会换回已存的值/)
})

test('查多久的记录：数的是有记录的日子，选 1 不叫「今天」', async () => {
  const { render } = await mount({ state: stateWith(), tab: 'bili' })
  const f = field(render(), '查多久的记录')
  const options = findAll(f, (n) => n.type === 'option').map(text)
  assert.ok(!options.includes('今天'), `选 1 列的是最近一个有记录的日子，不一定是今天：${options.join(' / ')}`)
  assert.ok(options.includes('7 个有记录的日子'), `选项：${options.join(' / ')}`)
  assert.match(text(findAll(f, (x) => hasClass(x, 'fhint'))[0]), /不按日历/)
})

// ---------------------------------------------------------------------------
// 记忆页
// ---------------------------------------------------------------------------

test('换新会话带过去的是最近几轮原话，不是核心认知', async () => {
  const { render } = await mount({ state: stateWith(), tab: 'memory' })
  const hint = hintOf(render(), '聊满多少轮换新会话')
  assert.doesNotMatch(hint, /核心认知和初始信息/, `说明：${hint}`)
  assert.match(hint, /最近几轮原话/)
})

// 2026-11-11（外部用户反馈）：带几轮要能自己调，0 得说清楚是不带 —— 否则
// 填 0 的人会以为「省一点」，实际是换完窗口一句旧话都接不上。
test('换新会话带几轮原话：有自己的说明，写 0 等于不带', async () => {
  const { render } = await mount({ state: stateWith(), tab: 'memory' })
  const hint = hintOf(render(), '换新会话时带几轮原话')
  assert.match(hint, /原话/)
  assert.match(hint, /0 = 不带/)
})

test('记得很牢不是永远：90 天没碰会掉档，身份段只列 5 条', async () => {
  const { render } = await mount({ state: stateWith(), tab: 'memory', mem: { events: 3, diaries: 0 } })
  const c = card(render(), '记忆')
  assert.doesNotMatch(c.all, /固定只代表她忘不掉/, '固定会掉档，也可能被挤出身份段')
  assert.match(c.all, /90 天没再被提起或检验/)
  assert.match(c.all, /最多列 5 条/)
})

// ---------------------------------------------------------------------------
// 保存失败框：越界报错里的名字、标题那句话
// ---------------------------------------------------------------------------

/** 往一个数字框里打一个越界的数，跑一次自动保存，返回失败框里的字（带上 app，好接着点别的）。 */
async function typeOutOfRangeApp(tab, label) {
  const s = stateWith()
  const app = await mount({ state: s, tab })
  app.render()
  app.runAutosave() // 首屏只记基线
  const input = findAll(field(app.render(), label), (n) => n.type === 'input' && n.props.type === 'number')[0]
  assert.ok(input, `「${label}」要是一个数字框`)
  input.props.onChange({ target: { value: String(Number(input.props.max) + 1) } })
  app.render()
  app.runAutosave()
  const box = findAll(app.render(), (n) => n.type === 'div' && hasClass(n, 'err'))[0]
  assert.ok(box, `「${label}」越界之后要出保存失败框`)
  return { box: text(box), app }
}
const typeOutOfRange = async (tab, label) => (await typeOutOfRangeApp(tab, label)).box
const errBox = (tree) => text(findAll(tree, (n) => n.type === 'div' && hasClass(n, 'err'))[0] || '')

test('数字越界时，报错里的名字和控件上的一样', async () => {
  for (const [tab, label] of [
    ['grow', '成长周期'],
    ['grow', '冷落天数'],
    ['grow', '她一轮最多写多少字'],
    ['grow', '回头想间隔'],
    ['grow', '总共留几条自述'],
    ['bili', '最短时长'],
    ['bili', '两次请求最少隔多久'],
    ['bili', '随机多等'],
    ['bili', '每天回复几条'],
    ['memory', '聊满多少轮换新会话'],
    ['memory', '换新会话时带几轮原话'],
    ['memory', '身份段字数'],
  ]) {
    const box = await typeOutOfRange(tab, label)
    assert.ok(box.includes(`「${label}（`), `改的是「${label}」，报错要用同一个名字：${box}`)
  }
})

test('数字越界进了失败框，就别再说「不是你填错了」；之后别的保存失败，照这一次的原因说', async () => {
  const { box, app } = await typeOutOfRangeApp('grow', '冷落天数')
  assert.doesNotMatch(box, /不是你填错了/, `这次确实是数填错了：${box}`)
  assert.match(box, /超出了允许的范围/)

  // 越界的数还停在框里，这时点一个单独提交的开关、偏偏断网：
  // 失败框要按这一次失败的原因说，不能还说「数超出范围」。
  const prev = globalThis.fetch
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch') }
  try {
    const sw = findAll(field(app.render(), '让她自己攒这股劲'), (n) => n.type === 'button' && n.props.role === 'switch')[0]
    assert.ok(sw, '「让她自己攒这股劲」要是一个开关')
    sw.props.onClick()
    await new Promise((r) => setTimeout(r, 20))
  } finally { globalThis.fetch = prev }
  const after = errBox(app.render())
  assert.match(after, /Failed to fetch/, `失败框要换成这一次的失败：${after}`)
  assert.doesNotMatch(after, /超出了允许的范围/, `这一次是断网，不是数填错了：${after}`)
  assert.match(after, /这一项没存上/)
})

test('越界的数改回原来存的值，失败框自己收起来', async () => {
  // 最常见的路：多打一位、再删掉。改回的正好是盘上的值，自动保存不会再写一次，
  // 框要是还挂着「超出了允许的范围…改回就会自动再存」，说的就不对了。
  const s = stateWith()
  const app = await mount({ state: s, tab: 'grow' })
  app.render()
  app.runAutosave() // 首屏只记基线
  const inputOf = () => findAll(field(app.render(), '冷落天数'), (n) => n.type === 'input' && n.props.type === 'number')[0]
  const saved = String(inputOf().props.value)
  const posts = []
  const restore = stubFetch({ '/config': (path, opts) => { posts.push(opts.body); return { ok: true } } })
  try {
    inputOf().props.onChange({ target: { value: String(Number(inputOf().props.max) + 1) } })
    app.render()
    app.runAutosave()
    assert.match(errBox(app.render()), /超出了允许的范围/, '先得出越界的失败框')
    inputOf().props.onChange({ target: { value: saved } })
    app.render()
    app.runAutosave()
    assert.equal(errBox(app.render()), '', `数已经改回 ${saved}，失败框还在：${errBox(app.render())}`)
    assert.equal(posts.length, 0, '改回的就是盘上的值，不用再写一次')
  } finally { restore() }
})

test('越界的数还在框里时，别的开关存上了，失败框接着说那个数', async () => {
  // 开关是单独提交的，存上的只是开关；越界的那个数没写盘，自动保存那边也不会再查一次。
  const { app } = await typeOutOfRangeApp('grow', '冷落天数')
  const posts = []
  const restore = stubFetch({ '/config': (path, opts) => { posts.push(JSON.parse(opts.body)); return { ok: true } } })
  try {
    const sw = findAll(field(app.render(), '让她自己攒这股劲'), (n) => n.type === 'button' && n.props.role === 'switch')[0]
    assert.ok(sw, '「让她自己攒这股劲」要是一个开关')
    await sw.props.onClick()
    await new Promise((r) => setTimeout(r, 20))
  } finally { restore() }
  assert.equal(posts.length, 1, '只发出开关那一次')
  assert.ok(!('absenceAfterDays' in posts[0]), `开关那次不带冷落天数：${JSON.stringify(posts[0])}`)
  const box = errBox(app.render())
  assert.match(box, /超出了允许的范围/, `冷落天数还没存上，失败框不能跟着开关一起消失：${box || '（没有失败框）'}`)
  assert.ok(box.includes('「冷落天数（'), `说的还是那个数：${box}`)
})

// ---------------------------------------------------------------------------
// 住所页、数据页
// ---------------------------------------------------------------------------

test('她的请求：放一天没人答会自动记成以后再说，之后补答不了', async () => {
  const { render } = await mount({ state: stateWith(), tab: 'home' })
  const note = card(render(), '她的请求').note
  assert.match(note, /24 小时没人答的会自动记成「以后再说」/, `说明：${note}`)
  assert.match(note, /补答不了/)
})

test('重开、重新搭一间之后，指到「状态」页的「现在叫醒大肥鱼」', async () => {
  // 重置卡本身
  {
    const { render } = await mount({ state: stateWith(), tab: 'data' })
    const c = card(render(), '重置大肥鱼')
    assert.doesNotMatch(c.all, /再点一下「叫醒大肥鱼」/, '按钮叫「现在叫醒大肥鱼」，而且不在这一页')
    assert.match(c.all, /到「状态」页点一下「现在叫醒大肥鱼」/)
  }
  // 重开之后的回执
  {
    const s = stateWith()
    const restore = stubFetch({ '/reset': { ok: true, movedTo: 'dsh-fish-backups/old' }, '/state': s })
    try {
      const app = await mount({ state: s, tab: 'data', resetAsk: true })
      await button(app.render(), '确定，重开').props.onClick()
      const note = noteOf(app.render())
      assert.doesNotMatch(note, /上面的「叫醒大肥鱼」/, `回执：${note}`)
      assert.match(note, /到「状态」页点一下「现在叫醒大肥鱼」/)
    } finally { restore() }
  }
  // 本来就没有档时重开：服务端回 movedTo 为空，note 里是它自己那句（按钮名字是旧的）。
  // 回执不拿它当开头，免得一条回执里叫醒的说法出现两遍、两个名字。
  {
    const s = stateWith()
    const serverNote = '旧的一切已经封存，旧会话移进「已归档」。新的一局已经开好；点一下「叫醒大肥鱼」，侧栏里才会出现那条会话。'
    const restore = stubFetch({ '/reset': { ok: true, movedTo: '', note: serverNote }, '/state': s })
    try {
      const app = await mount({ state: s, tab: 'data', resetAsk: true })
      await button(app.render(), '确定，重开').props.onClick()
      const note = noteOf(app.render())
      assert.match(note, /^已重开。/, `回执：${note}`)
      assert.doesNotMatch(note, /点一下「叫醒大肥鱼」/, `回执里夹着旧按钮名：${note}`)
      assert.equal(note.split('现在叫醒大肥鱼').length - 1, 1, `叫醒那一步只说一遍：${note}`)
    } finally { restore() }
  }
  // 会话被收起来之后「重新搭一间」的回执
  {
    const s = stateWith({ home: { status: 'archived' } })
    const restore = stubFetch({ '/home/rebuild': { ok: true, woke: false }, '/state': s })
    try {
      const app = await mount({ state: s, tab: 'data' })
      await button(app.render(), '重新搭一间').props.onClick()
      const note = noteOf(app.render())
      assert.doesNotMatch(note, /点一下上面的/, `回执：${note}`)
      assert.match(note, /到「状态」页点一下「现在叫醒大肥鱼」/)
    } finally { restore() }
  }
})

test('升级卡：新包名的副本在 node_modules 下多一层 @ssamurias', async () => {
  const s = stateWith({ upgrade: { stale: true, why: '源目录里是 0.9.6，正在跑的却是 0.9.5', sourcePath: 'D:/src/dsh-fish' } })
  const { render } = await mount({ state: s, tab: 'data' })
  const c = card(render(), '升级没有真正装进去')
  assert.ok(c.all.includes('node_modules\\@ssamurias\\dsh-fish'), `profile 里的键是新包名时副本在这里：${c.all}`)
  assert.doesNotMatch(c.all, /删掉 node_modules\\dsh-fish/, '只删老目录名，用新包名装的人删不到')
})

test('导出报告时没有正文：别让人去点只管显示的「展开报告」', async () => {
  const reports = { dates: ['2026-11-08'], date: '2026-11-08', md: '' }
  const app = await mount({ state: stateWith(), tab: 'data', reports })
  button(app.render(), '导出报告').props.onClick()
  const note = noteOf(app.render())
  assert.ok(note, '没有正文时要说一句')
  assert.doesNotMatch(note, /展开报告/, `「展开报告」只切换显示，不取数据：${note}`)
})
