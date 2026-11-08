/**
 * outing-copy.test.mjs —— 出门页上的说法要和代码对得上（issue #68，0.9.5 之后）。
 *
 * 不扫源码字符串：把 client.js 真的跑一遍、渲染一次组件，收集**页面上会出现的字**来断言。
 * 出门页要有数据才渲染那几张卡，所以在装载前把三处初始状态（outing / outingEndAsk / possess）
 * 换成从 globalThis 读——只改初始值，渲染逻辑一行不动。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const CLIENT = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js')

/**
 * 假 React：h() 产出普通对象，并记下每一个造出来的节点（各页签的树都会被造出来）。
 * 每个 setState 收到的值也记下来：点按钮之后界面说了什么，就看 setOutingMsg 收到的字。
 */
function fakeReact() {
  const made = []
  const sets = []
  const h = (type, props, ...children) => {
    const node = { type, props: props || {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) }
    made.push(node)
    return node
  }
  return {
    made,
    sets,
    createElement: h,
    useState: (init) => [typeof init === 'function' ? init() : init, (v) => { sets.push(v) }],
    useCallback: (fn) => fn,
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: (init) => ({ current: init }),
  }
}

const SEEDS = [
  ['const [outing, setOuting] = useState(null)', 'const [outing, setOuting] = useState(globalThis.__fishCopyTest?.outing ?? null)'],
  ['const [outingEndAsk, setOutingEndAsk] = useState(false)', 'const [outingEndAsk, setOutingEndAsk] = useState(globalThis.__fishCopyTest?.outingEndAsk ?? false)'],
  ['const [possess, setPossess] = useState(null)', 'const [possess, setPossess] = useState(globalThis.__fishCopyTest?.possess ?? null)'],
  ['const [possessEndAsk, setPossessEndAsk] = useState(false)', 'const [possessEndAsk, setPossessEndAsk] = useState(globalThis.__fishCopyTest?.possessEndAsk ?? false)'],
]

/** 按给定状态渲染一次，返回页面上出现过的每一段字。 */
async function renderTexts(state) {
  return (await mount(state)).texts
}

/** 按给定状态渲染一次，返回页面上的字、造出来的节点、setState 收到过的值。 */
async function mount(state) {
  let src = await readFile(CLIENT, 'utf8')
  for (const [from, to] of SEEDS) {
    assert.equal(src.split(from).length - 1, 1, `装载钩子要正好对上一处：${from}`)
    src = src.replace(from, to)
  }
  const react = fakeReact()
  const loaded = []
  const window = { __ModuleLoader__: { load(spec) { loaded.push(spec) } } }
  const document = { querySelector: () => null, createElement: () => ({ setAttribute() {}, textContent: '' }), head: { appendChild() {} } }
  const req = (id) => { if (id === 'react') return react; throw new Error(`unexpected require: ${id}`) }
  new Function('window', 'require', 'document', src)(window, req, document)
  const exports = loaded[0].factory(req)
  globalThis.__fishCopyTest = state
  try {
    exports.FishSection()
  } finally {
    delete globalThis.__fishCopyTest
  }
  const out = []
  for (const n of react.made) for (const c of n.children) if (typeof c === 'string') out.push(c)
  return { texts: out, made: react.made, sets: react.sets }
}

const pocketPath = '/home/someone/outing-pocket'
const outingState = ({ atPocket, workspaceName }) => ({
  ok: true,
  ack: true,
  away: {
    kind: 'outing',
    outing: { sessionId: 's-out', workspaceId: atPocket ? 'w-pocket' : 'w-other', workspaceName, cwd: atPocket ? pocketPath : '/work/outing-pocket' },
    line: '现在在外面',
    since: { ok: true, total: 0, items: [] },
    verify: { ok: true, checkable: true },
    tripDays: 1,
    atPocket,
  },
  pocket: { path: pocketPath, workspaceId: 'w-pocket', registered: true, exists: true },
  workspaces: [{ id: 'w1', title: '素材', path: '/work/素材' }],
  outings: [],
  possessions: [],
  letters: [],
  keepsakes: { pending: [], recent: [] },
})

test('园区那趟清单空着时，提示认得出是园区；名字叫 outing-pocket 的普通工作区不是园区（issue #68）', async () => {
  const real = await renderTexts({ outing: outingState({ atPocket: true, workspaceName: '工作园区' }), outingEndAsk: true })
  assert.ok(real.some((t) => t.includes('这趟她去的是园区')), '真的园区：工作区名是「工作园区」，跟目录名对不上也要认得出')

  const fake = await renderTexts({ outing: outingState({ atPocket: false, workspaceName: 'outing-pocket' }), outingEndAsk: true })
  assert.ok(!fake.some((t) => t.includes('这趟她去的是园区')), '只是名字像，不是园区')
})

test('出门页的说明和代码一致：写下的当场就算、园区是固定目录、整趟不算不删原话（issue #68）', async () => {
  const texts = await renderTexts({ outing: outingState({ atPocket: false, workspaceName: '素材' }) })
  const all = texts.join('\n')
  // 没对不上时，她这趟写的一落盘就进派生；回家时只能事后标掉。
  assert.ok(!all.includes('这趟不会自动算数'))
  assert.ok(!all.includes('才决定这趟算不算数'))
  assert.ok(texts.some((t) => t.includes('先算上')), '要说清写下的先算上')
  // 园区是固定目录，只建不清，还能接着上次那条。
  assert.ok(!all.includes('全新的沙箱'))
  assert.ok(texts.some((t) => t.includes('目录不会自动清空')))
  // 整趟不算只是追加一条标记，原文还在，她翻记录翻得到。
  assert.ok(!all.includes('整趟记忆都忘掉'))
  assert.ok(texts.some((t) => t.includes('原话还留在记录里')))
})

test('请神的护栏按路径拦，读也拦：说「碰不到」，不说「改不了」（issue #68）', async () => {
  const possessActive = {
    possess: {
      active: { sessionId: 's-talk', title: '一个对话', cwd: '/work/素材' },
      sessions: [],
      since: { ok: true, total: 0, items: [] },
      verify: { ok: true, checkable: true },
    },
    outing: { ...outingState({ atPocket: false, workspaceName: '素材' }), away: { kind: 'possession', possession: { sessionId: 's-talk', title: '一个对话' }, line: '现在在这条对话里替人说话' } },
  }
  const idle = { possess: { active: null, sessions: [{ sessionId: 's-talk', title: '一个对话', cwd: '/work/素材' }] } }
  const texts = [...await renderTexts(possessActive), ...await renderTexts(idle)]
  const guard = texts.filter((t) => t.includes('屋子、记忆、对话、配置'))
  assert.equal(guard.length, 3, '出门中那张卡 + 请神已上身 + 请神未上身，三处都要渲染出来')
  for (const t of guard) {
    assert.doesNotMatch(t, /改不了她家里|无法修改她家里/, '读也会被拦，不只是改不了')
    assert.match(t, /读和写/, `要说清读写都拦：${t.slice(0, 40)}`)
  }
})

test('清单空着时不拿日记、评论举例：它们只留一行记账，不进这张清单（issue #68）', async () => {
  const texts = await renderTexts({ outing: outingState({ atPocket: false, workspaceName: '素材' }), outingEndAsk: true })
  const hint = texts.filter((t) => t.includes('没有可以划掉的'))
  assert.equal(hint.length, 1, '空清单的提示要渲染出来')
  assert.doesNotMatch(hint[0], /写篇日记|评个视频/, '写日记、评视频不会出现在清单里，不能说「都行」')
  assert.match(hint[0], /不在这张清单里/, '要说清日记和评论不在这里')
})

test('园区「不带项目记录」只在第一次去时成立，不能说成一直是空的（issue #68）', async () => {
  const texts = await renderTexts({ outing: outingState({ atPocket: false, workspaceName: '素材' }) })
  const said = texts.filter((t) => t.includes('不带项目记录'))
  assert.ok(said.length >= 2, '说明卡和园区卡都说到了')
  for (const t of said) assert.match(t, /第一次/, `用过以后这个工作区自己的记录会留着：${t.slice(0, 40)}`)
})

test('没有基线的那趟：「核对一次」能点，但卡上不说「已经对得上了」（issue #68）', async () => {
  const review = { workspaceName: '素材', title: '一个对话', reason: '出门时没记下她自己的记录（文件还不存在？）', okNow: true, checkable: false, held: 0, dropped: 0, autoRejected: false }
  const uncheckable = await renderTexts({
    outing: { ...outingState({ atPocket: false, workspaceName: '素材' }), pendingReview: review },
    possess: { active: null, sessions: [], pendingReview: review },
  })
  assert.ok(!uncheckable.some((t) => t.includes('已经对得上了')), '核对不了，就不能说对得上')
  assert.equal(uncheckable.filter((t) => t.includes('没法核对')).length, 2, '出门卡和请神卡都说清是核对不了')

  // 真的对得上的那趟照旧说。
  const checked = await renderTexts({
    outing: { ...outingState({ atPocket: false, workspaceName: '素材' }), pendingReview: { ...review, reason: '', checkable: true } },
    possess: { active: null, sessions: [], pendingReview: { ...review, reason: '', checkable: true } },
  })
  assert.equal(checked.filter((t) => t.includes('已经对得上了')).length, 2)
})

// ---------------------------------------------------------------------------
// 第二轮：点按钮之后界面说什么、发什么
// ---------------------------------------------------------------------------

/** 页面上文字正好是 label 的按钮（可能不止一个）。 */
const buttons = (made, label) =>
  made.filter((n) => n.type === 'button' && n.children.some((c) => typeof c === 'string' && c === label))

/**
 * 换掉全局 fetch 跑一段：记下每个请求，回 reply(path, body) 给的 JSON。
 * client.js 的 jget / jpost 用的就是全局 fetch。
 */
async function withFetch(reply, fn) {
  const calls = []
  const real = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null
    calls.push({ url: String(url), method: init.method || 'GET', body })
    const json = reply(String(url), body)
    return { ok: true, status: 200, json: async () => json }
  }
  try { await fn() } finally { globalThis.fetch = real }
  return calls
}

const said = (sets) => sets.filter((v) => typeof v === 'string')

test('送她去园区之后的回执跟说明卡同一个说法：第一次去时才没有项目记录（issue #68）', async () => {
  const state = outingState({ atPocket: false, workspaceName: '素材' })
  const home = { ...state, away: { kind: null, line: '在家' } }
  const { made, sets } = await mount({ outing: home })
  const [go] = buttons(made, '让她去园区')
  assert.ok(go, '园区卡上要有「让她去园区」')
  await withFetch(() => ({ ok: true, ...home }), () => go.props.onClick())
  const msg = said(sets).filter((t) => t.includes('她去园区了'))
  assert.equal(msg.length, 1, '点完要有一句回执')
  assert.doesNotMatch(msg[0], /那边没有项目笔记、交接记录这些/, '用过以后这个工作区自己的记录会留着，不能一律说没有')
  assert.match(msg[0], /第一次去时/)
})

test('「核对一次」带上卡上那一趟的 sessionId 和 startedAt（issue #68）', async () => {
  const card = { okNow: true, checkable: true, held: 2, dropped: 0, autoRejected: false, reason: '' }
  const state = {
    outing: { ...outingState({ atPocket: false, workspaceName: '素材' }), pendingReview: { ...card, sessionId: 's-out', startedAt: 111, workspaceName: '素材' } },
    possess: { active: null, sessions: [], pendingReview: { ...card, sessionId: 's-talk', startedAt: 222, title: '一个对话' } },
  }
  const { made } = await mount(state)
  const btns = buttons(made, '核对一次')
  assert.equal(btns.length, 2, '出门卡和请神卡各一个')
  const calls = await withFetch(() => ({ ok: true }), async () => { for (const b of btns) await b.props.onClick() })
  const posts = calls.filter((c) => c.method === 'POST')
  const out = posts.find((c) => c.url.endsWith('/outing'))
  const pos = posts.find((c) => c.url.endsWith('/possession'))
  assert.deepEqual([out?.body?.action, out?.body?.sessionId, out?.body?.startedAt], ['review', 's-out', 111], '出门卡：两趟都在等时，服务端要能认出是卡上这一趟')
  assert.deepEqual([pos?.body?.action, pos?.body?.sessionId, pos?.body?.startedAt], ['review', 's-talk', 222], '请神卡同一套')
})

test('回家时「不算」的标记没写进去：回执不说「暂时」，说清怎么补（issue #68）', async () => {
  const base = outingState({ atPocket: false, workspaceName: '素材' })
  const possessActive = {
    active: { sessionId: 's-talk', title: '一个对话', cwd: '/work/素材' },
    sessions: [],
    since: { ok: true, total: 2, items: [] },
    verify: { ok: true, checkable: true },
  }
  for (const [tampered, part] of [[false, false], [true, true]]) {
    const reply = (url, body) => body?.action === 'end'
      ? { ok: true, tampered, marked: false, markWhy: 'EPERM', markedPart: part, rejected: 2, held: 0, autoRejected: true, outing: { status: 'pending' }, possession: { status: 'pending' } }
      : { ok: true }
    const { made, sets } = await mount({ outing: base, outingEndAsk: true, possess: possessActive, possessEndAsk: true })
    const ends = buttons(made, '整趟不算')
    assert.equal(ends.length, 2, '出门、请神的结束卡各一个「整趟不算」')
    await withFetch(reply, async () => { for (const b of ends) await b.props.onClick() })
    const msgs = said(sets).filter((t) => t.includes('标记'))
    assert.equal(msgs.length, 2, `出门、请神各一句回执：${JSON.stringify(said(sets))}`)
    for (const m of msgs) {
      assert.doesNotMatch(m, /暂时/, '没有地方会自己补上，不能说「暂时」')
      assert.match(m, /眼下还算着/)
      assert.match(m, /核对一次/, '要说清在哪里补')
      if (part) assert.match(m, /只写进去一部分/, '写到一半失败的，不能说成一条也没写')
      if (tampered) assert.match(m, /恢复成/, '记录也对不上的，要先恢复')
    }
  }
})

test('「还没算数」卡：标记没写进去、升级前留下的请神，都不说「先不算」「还没算数」（issue #68）', async () => {
  // 没对不上、只是回家时标记没写进去：记录对得上，核对一次就补写。
  const unmarked = { okNow: true, checkable: true, held: 0, dropped: 2, autoRejected: true, unmarked: true, reason: '回家时「不算」的标记没写进去' }
  const t1 = await renderTexts({
    outing: { ...outingState({ atPocket: false, workspaceName: '素材' }), pendingReview: { ...unmarked, sessionId: 's-out', startedAt: 1, workspaceName: '素材' } },
    possess: { active: null, sessions: [], pendingReview: { ...unmarked, sessionId: 's-talk', startedAt: 2, title: '一个对话' } },
  })
  assert.ok(!t1.some((t) => t.includes('记录被篡改过')), '记录没被改过，标题不能说篡改')
  assert.equal(t1.filter((t) => t.includes('还没结完')).length, 2)
  assert.equal(t1.filter((t) => t.includes('补上标记')).length, 2, '要说清核对时会补写')

  // 0.9.5 留下的请神 pending：一条标记都没写过，记录还对不上。
  const legacy = { okNow: false, checkable: true, held: 0, dropped: 0, autoRejected: false, unmarked: false, reason: '记录长度没变，但里面的字被改过。' }
  const t2 = await renderTexts({ possess: { active: null, sessions: [], pendingReview: { ...legacy, sessionId: 's-talk', startedAt: 2, title: '一个对话' } } })
  assert.ok(!t2.some((t) => t.includes('只是这趟还没算数')), '这趟写的一直算着')
  assert.ok(!t2.some((t) => t.includes('上一次请神还没算数')))
  assert.ok(t2.some((t) => t.includes('一直算着')))
})
