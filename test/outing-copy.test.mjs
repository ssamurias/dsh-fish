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

/** 假 React：h() 产出普通对象，并记下每一个造出来的节点（各页签的树都会被造出来）。 */
function fakeReact() {
  const made = []
  const h = (type, props, ...children) => {
    const node = { type, props: props || {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) }
    made.push(node)
    return node
  }
  return {
    made,
    createElement: h,
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
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
]

/** 按给定状态渲染一次，返回页面上出现过的每一段字。 */
async function renderTexts(state) {
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
  return out
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
