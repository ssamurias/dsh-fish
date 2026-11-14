/**
 * data-page.test.mjs —— 设置页「数据」那一页的说明和回执（接 issue #65，0.9.5 上的余项）
 *
 * 这里只看界面那一半：用假的 React 把设置页真渲染一遍、真点按钮，看它对人说了什么。
 * 接口那一半在 backup / import / move 各自的测试里。
 *
 * 假 React 的状态是按 useState 的调用顺序认的（和 client.test.mjs 一样）。这里不写死下标，
 * 而是从源码里 FishSection 的 `const [名字, set名字] = useState(` 一行行数出来，
 * 再断言渲染时真调到的次数和数出来的一样多，免得状态对错了位还以为测过了。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const CLIENT = new URL('../lib/client.js', import.meta.url)

async function stateNames() {
  const src = await readFile(CLIENT, 'utf8')
  const body = src.slice(src.indexOf('function FishSection()'))
  const names = []
  for (const line of body.split('\n')) {
    const m = line.match(/^\s*const \[(\w*),\s*set\w+\] = useState\(/)
    if (m) names.push(m[1])
  }
  return { src, names }
}

/**
 * 渲染一次设置页。over = { 状态名: 值 }。
 * 返回渲染树、所有 setter 的调用记录（[状态名, 值]）、页面造出来的 DOM 元素。
 */
async function render(over = {}) {
  const { src, names } = await stateNames()
  const sets = []
  let cursor = 0
  const h = (type, props, ...children) => ({
    type,
    props: props || {},
    children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false),
  })
  const react = {
    createElement: h,
    useState: (init) => {
      const name = names[cursor++]
      const v = name && Object.hasOwn(over, name) ? over[name] : typeof init === 'function' ? init() : init
      return [v, (nv) => sets.push([name, typeof nv === 'function' ? nv(v) : nv])]
    },
    useCallback: (fn) => fn,
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: (init) => ({ current: init }),
  }
  const made = []
  const document = {
    querySelector: () => null,
    createElement: (tag) => {
      const el = { tag, textContent: '', setAttribute() {}, click() { el.clicked = true } }
      made.push(el)
      return el
    },
    head: { appendChild() {} },
  }
  const loaded = []
  const window = { __ModuleLoader__: { load(spec) { loaded.push(spec) } } }
  const req = (id) => { if (id === 'react') return react; throw new Error(`unexpected require: ${id}`) }
  new Function('window', 'require', 'document', src)(window, req, document)
  const { FishSection } = loaded[0].factory(req)
  const tree = FishSection()
  assert.equal(cursor, names.length, '渲染时调到的 useState 个数要和源码里数出来的一样，不然状态对错了位')
  return { tree, sets, made }
}

function textOf(node, out = []) {
  if (node == null || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const n of node) textOf(n, out); return out }
  if (node.children) for (const c of node.children) textOf(c, out)
  return out
}

function findAll(node, pred, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const n of node) findAll(n, pred, out); return out }
  if (pred(node)) out.push(node)
  for (const c of node.children ?? []) findAll(c, pred, out)
  return out
}

function button(tree, label) {
  const hit = findAll(tree, (n) => n.type === 'button' && textOf(n).join('') === label)
  assert.equal(hit.length, 1, `页面上要正好有一个「${label}」按钮`)
  return hit[0]
}

/** 这张卡（标题是 title 的那一块）里的全部文字。 */
function cardText(tree, title) {
  const hit = findAll(tree, (n) => n.type === 'div' && (n.children ?? []).some((c) => c?.type === 'h3' && textOf(c).join('') === title))
  assert.equal(hit.length, 1, `页面上要有「${title}」这张卡`)
  return textOf(hit[0]).join('')
}

/** 找开关：Toggle 渲染成 button[role=switch]，里面只有一个 knob、没有文字，按旁边的标签认。 */
function sw(tree, label) {
  const hit = findAll(tree, (n) => n.type === 'button' && n.props?.role === 'switch'
    && (n.children ?? []).every((c) => c?.type === 'span' && c?.props?.className === 'knob'))
  const owned = hit.filter((b) => {
    const fld = findAll(tree, (n) => n.type === 'div' && n.props?.className === 'fld' && (n.children ?? []).includes(b))[0]
    return fld && textOf(fld).join('').startsWith(label)
  })
  assert.equal(owned.length, 1, `页面上要正好有一个「${label}」开关`)
  return owned[0]
}

/** 假 fetch：按路径回固定的 JSON；没写的路径回 {}。 */
async function withFetch(table, fn) {
  const prev = globalThis.fetch
  const prevTimeout = globalThis.setTimeout
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^\/dsh-fish/, '').split('?')[0]
    calls.push({ path, method: init.method ?? 'GET', body: init.body })
    const hit = table[`${init.method ?? 'GET'} ${path}`]
    const body = typeof hit === 'function' ? hit(init) : hit ?? {}
    const status = body?.__status ?? 200
    return { ok: status < 400, status, json: async () => body }
  }
  // 下载完会挂一个 4 秒后收回 blob 地址的定时器，别让它拖住测试进程
  globalThis.setTimeout = (f, ms, ...a) => { const t = prevTimeout(f, ms, ...a); t?.unref?.(); return t }
  try {
    return await fn(calls)
  } finally {
    globalThis.fetch = prev
    globalThis.setTimeout = prevTimeout
  }
}

const last = (sets, name) => sets.filter(([n]) => n === name).map(([, v]) => v).at(-1)

const BUNDLE = {
  format: 'dsh-fish-backup/1',
  schema: 2,
  files: [{ path: 'events.jsonl', enc: 'utf8', data: '' }],
  bytes: 2048,
  fileName: '大肥鱼-20261109-1200.json',
  excluded: ['logs/'],
  restoreLimit: 96_000_000,
  restoreBytes: 4096,
  fitsRestore: true,
}

test('备份回执：没打进包的文件列出名字、各带原因，不说成「太大」，照规矩不带的 logs/ 不算', async () => {
  // 0.9.5：只列前 3 条再写「等」，owner.json、state.json 落进了「等」里；
  // 每份档都有的 logs/ 被说成「另有 1 个文件太大没打进包」。
  const skipped = [
    'home/她的身份.md（总量已到 64MB 上限）',
    'out/2026-10-28.md（总量已到 64MB 上限）',
    'owner.json（总量已到 64MB 上限）',
    'state.json（读不到）',
  ]
  const { tree, sets } = await render({ tab: 'data' })
  await withFetch({ 'GET /backup': { ...BUNDLE, skipped } }, async () => {
    await button(tree, '备份成一份文件').props.onClick()
  })
  const msg = last(sets, 'backupMsg')
  assert.match(msg, /^已导出「大肥鱼-20261109-1200\.json」/)
  for (const s of skipped) assert.ok(msg.includes(s), `回执里要有 ${s}：${msg}`)
  assert.match(msg, /4 个文件没打进包/)
  assert.doesNotMatch(msg, /等。/)
  assert.doesNotMatch(msg, /太大/, '读不到、总量满了都不是「太大」')
  assert.doesNotMatch(msg, /logs/)

  // 什么都没跳过时，回执里不出现「没打进包」
  const again = await render({ tab: 'data' })
  await withFetch({ 'GET /backup': { ...BUNDLE, skipped: [] } }, async () => {
    await button(again.tree, '备份成一份文件').props.onClick()
  })
  const ok = last(again.sets, 'backupMsg')
  assert.doesNotMatch(ok, /没打进包|logs/)
  assert.doesNotMatch(ok, /装不回去/)
})

test('备份回执：包超过「从备份恢复」能收的大小时，导出当场就说装不回去', async () => {
  const { tree, sets } = await render({ tab: 'data' })
  await withFetch({ 'GET /backup': { ...BUNDLE, skipped: [], restoreBytes: 97_637_235, fitsRestore: false } }, async () => {
    await button(tree, '备份成一份文件').props.onClick()
  })
  const msg = last(sets, 'backupMsg')
  assert.match(msg, /^已导出/, '文件照样存下来：里面东西是全的')
  assert.match(msg, /97\.7MB/)
  assert.match(msg, /96MB/)
  assert.match(msg, /装不回去/)
})

test('恢复回执：导出时就没打进包的文件要说出来，不能只报「已恢复」', async () => {
  const { tree, sets, made } = await render({ tab: 'data' })
  await withFetch({
    'POST /backup/restore': { ok: true, restored: 3, quarantined: '', skipped: ['owner.json（总量已到 64MB 上限）'] },
  }, async () => {
    button(tree, '从备份恢复').props.onClick()
    const input = made.find((el) => el.tag === 'input')
    assert.ok(input?.clicked, '要弹出选文件的框')
    input.files = [{ text: async () => JSON.stringify({ ...BUNDLE, skipped: ['owner.json（总量已到 64MB 上限）'] }) }]
    await input.onchange()
  })
  const msg = last(sets, 'backupMsg')
  assert.match(msg, /^已恢复 3 个文件/)
  assert.ok(msg.includes('owner.json（总量已到 64MB 上限）'), msg)
  assert.match(msg, /没有恢复出来/)
})

test('导入回执：分开说这次新放行几个、白名单现在一共几个', async () => {
  // 原来放行 3 个，交接单写 2 个、其中 1 个重复。0.9.5 写「工具白名单 4 个」。
  const { tree, sets } = await render({
    tab: 'data',
    importInfo: { canImport: true, reason: '', persona: { imported: false, source: '' }, template: '' },
    importAsk: true,
    importText: '你是一条鱼。',
  })
  await withFetch({
    'POST /import': { ok: true, name: '', tools: ['her_recall', 'web_search', 'read_file', 'skill'], toolsAdded: ['skill'], bodyChars: 6, day: 1 },
  }, async () => {
    await button(tree, '接过来').props.onClick()
  })
  const note = last(sets, 'note')
  assert.match(note, /这次新加 1 个/)
  assert.match(note, /一共 4 个/)
  assert.doesNotMatch(note, /工具白名单 4 个/)
})

test('迁移卡：没有原生文件夹选择器时，点「选择文件夹…」要说改成手填路径', async () => {
  assert.equal(globalThis.__DSH_DIRECTORY_PICKER__, undefined)
  const { tree, sets } = await render({ tab: 'data', moveAsk: true })
  await button(tree, '选择文件夹…').props.onClick()
  const msg = last(sets, 'moveMsg')
  assert.ok(msg, '0.9.5 点了没有任何反应')
  assert.match(msg, /路径/)
})

test('数据页的说明照代码说：迁移到放着一份档的文件夹会被拒绝；备份里有登录凭据', async () => {
  const { tree } = await render({ tab: 'data', moveAsk: true })
  const where = cardText(tree, '数据在哪')
  assert.doesNotMatch(where, /会被覆盖/, '迁移不会覆盖任何东西（目标里有档就拒绝，复制也带 COPYFILE_EXCL）')
  assert.match(where, /放着一份档的文件夹[^。]*不行[^。]*拒绝/)
  const backup = cardText(tree, '备份与恢复')
  assert.match(backup, /登录凭据/, 'owner.json 原样在包里，备份卡要说')
  assert.match(backup, /别随手发给别人/)
})

// ---- 审查后补的（接 #65）----

test('备份回执：顶层以外照规矩没带的文件夹要单独说出来，卡片上说过的 logs/、backups/ 不重复', async () => {
  // 目录名在哪一层都认：她房间里叫 backups、node_modules 的文件夹也不带。
  // 它们只记在 excluded 里，回执要是不提，就是不声不响地丢了。
  const { tree, sets } = await render({ tab: 'data' })
  const excluded = ['backups/', 'logs/', 'home/backups/', 'home/proj/node_modules/']
  await withFetch({ 'GET /backup': { ...BUNDLE, skipped: [], excluded } }, async () => {
    await button(tree, '备份成一份文件').props.onClick()
  })
  const msg = last(sets, 'backupMsg')
  const m = msg.match(/这次没带：([^。]*)。/)
  assert.ok(m, `回执要说哪些文件夹照规矩没带：${msg}`)
  assert.equal(m[1], 'home/backups/、home/proj/node_modules/')
  assert.doesNotMatch(msg, /没打进包/, '它们不是「没装进去」')
})

test('备份回执：没打进包的文件很多时只列前 10 个，报出真实个数，说完整名单在哪', async () => {
  const skipped = Array.from({ length: 30 }, (_, i) => `media/p${String(i).padStart(2, '0')}.jpg（总量已到 64MB 上限）`)
  const { tree, sets } = await render({ tab: 'data' })
  await withFetch({ 'GET /backup': { ...BUNDLE, skipped } }, async () => {
    await button(tree, '备份成一份文件').props.onClick()
  })
  const msg = last(sets, 'backupMsg')
  assert.match(msg, /有 30 个文件没打进包/)
  for (const s of skipped.slice(0, 10)) assert.ok(msg.includes(s), `前 10 个要列出来：${s}`)
  assert.ok(!msg.includes(skipped[10]), '第 11 个起不再一个个列')
  assert.match(msg, /还有 20 个/)
  assert.match(msg, /skipped/)
})

test('恢复回执：个数按真实条数说，接口只带回前 200 条也不能说成 200 个', async () => {
  const names = Array.from({ length: 200 }, (_, i) => `media/p${String(i).padStart(3, '0')}.jpg（总量已到 64MB 上限）`)
  const { tree, sets, made } = await render({ tab: 'data' })
  await withFetch({
    'POST /backup/restore': { ok: true, restored: 3, quarantined: '', skipped: names, skippedCount: 250 },
  }, async () => {
    button(tree, '从备份恢复').props.onClick()
    const input = made.find((el) => el.tag === 'input')
    input.files = [{ text: async () => JSON.stringify(BUNDLE) }]
    await input.onchange()
  })
  const msg = last(sets, 'backupMsg')
  assert.match(msg, /有 250 个文件没打进去/)
  assert.ok(msg.includes(names[0]) && msg.includes(names[9]))
  assert.ok(!msg.includes(names[10]))
  assert.match(msg, /还有 240 个/)
})

test('导入回执：白名单没写进去时直说，不写成「这次新加 0 个」', async () => {
  const { tree, sets } = await render({
    tab: 'data',
    importInfo: { canImport: true, reason: '', persona: { imported: false, source: '' }, template: '' },
    importAsk: true,
    importText: '你是一条鱼。',
  })
  await withFetch({
    'POST /import': { ok: true, name: '', tools: ['skill', 'web_search'], toolsAdded: [], toolsError: 'EPERM', bodyChars: 6, day: 1 },
  }, async () => {
    await button(tree, '接过来').props.onClick()
  })
  const note = last(sets, 'note')
  assert.match(note, /白名单没写进去/)
  assert.match(note, /EPERM/)
  assert.match(note, /2 个工具这次都没放行/)
  assert.doesNotMatch(note, /新加 0 个|一共 2 个/)
})

// ---- 第二轮审查后补的（接 #65）：包里写不下名字、只记了个数的那几个 ----

test('备份回执：包里连说明行都写不下、只记了个数的，算进真实个数，单独说一句', async () => {
  const skipped = ['home/n00.md（放进来就超过「从备份恢复」一次能收的大小）', 'home/n01.md（放进来就超过「从备份恢复」一次能收的大小）']
  const { tree, sets } = await render({ tab: 'data' })
  await withFetch({ 'GET /backup': { ...BUNDLE, skipped, skippedUnlisted: 5 } }, async () => {
    await button(tree, '备份成一份文件').props.onClick()
  })
  const msg = last(sets, 'backupMsg')
  assert.match(msg, /有 7 个文件没打进包/)
  for (const s of skipped) assert.ok(msg.includes(s), `有名字的照列：${s}`)
  assert.match(msg, /另有 5 个连名字都写不进包里/)
  assert.doesNotMatch(msg, /还有 \d+ 个没列出来/, '有名字的都列了，不能再说「完整名单在 skipped 里」')

  // 一个名字都没写下时
  const again = await render({ tab: 'data' })
  await withFetch({ 'GET /backup': { ...BUNDLE, skipped: [], skippedUnlisted: 3 } }, async () => {
    await button(again.tree, '备份成一份文件').props.onClick()
  })
  const only = last(again.sets, 'backupMsg')
  assert.match(only, /有 3 个文件没打进包，恢复出来也不会有：包里连它们的名字都写不下/)
})

test('恢复回执：只记了个数的那几个算进真实条数，「没列出来」只算有名字的', async () => {
  const names = ['owner.json（读失败）']
  const { tree, sets, made } = await render({ tab: 'data' })
  await withFetch({
    'POST /backup/restore': { ok: true, restored: 2, quarantined: '', skipped: names, skippedCount: 6, skippedUnlisted: 5 },
  }, async () => {
    button(tree, '从备份恢复').props.onClick()
    const input = made.find((el) => el.tag === 'input')
    input.files = [{ text: async () => JSON.stringify(BUNDLE) }]
    await input.onchange()
  })
  const msg = last(sets, 'backupMsg')
  assert.match(msg, /有 6 个文件没打进去/)
  assert.ok(msg.includes(names[0]), msg)
  assert.match(msg, /另有 5 个连名字都写不进包里/)
  assert.doesNotMatch(msg, /还有 \d+ 个没列出来/)
})

// ---- 2026-11-14 用户 m02555：点「往云端送」点不开，得说是缺什么 ----

test('云端开关：一个地方都没有时不开，并且说清楚先去哪儿加', async () => {
  const { tree, sets } = await render({ tab: 'data', cloudOpen: true, cloudState: { targets: [], kinds: [] } })
  let posted = 0
  await withFetch({}, async (calls) => {
    await sw(tree, '往云端送').props.onClick()
    posted = calls.filter((c) => c.path === '/config').length
  })
  assert.equal(posted, 0, '缺东西时不该把开关状态提交上去')
  assert.equal(last(sets, 'cloudOn'), undefined, '开关不该动')
  // 2026-11-14 用户 m03127：这句必须贴在开关旁边，不能写到卡片最底下——云端那层很长，
  // 写了等于没写。所以断言它落在 cloudGate 里，而不是 cloudMsg。
  const msg = last(sets, 'cloudGate')
  assert.ok(msg, '点了必须有回话，不能只回弹')
  assert.match(msg, /还没有云端存储方式/)
  assert.match(msg, /加一个/)
  assert.equal(last(sets, 'cloudMsg'), undefined, '不许再塞到底部那句里去')
})

test('云端开关：地方都列出来了但一个都没填完时，指到「改」而不是让人瞎找', async () => {
  const { tree, sets } = await render({
    tab: 'data',
    cloudOpen: true,
    cloudState: { targets: [{ id: 't1', kind: 'folder', name: '网盘', label: '文件夹', enabled: true, ready: false, problem: '还差：目录' }], kinds: [] },
  })
  let posted = 0
  await withFetch({}, async (calls) => {
    await sw(tree, '往云端送').props.onClick()
    posted = calls.filter((c) => c.path === '/config').length
  })
  assert.equal(posted, 0)
  const msg = last(sets, 'cloudGate')
  assert.match(msg, /还没填完/)
  assert.match(msg, /改/)
})

test('云端开关：地方都在、但全被「先别用它」关着时，说清要先开一个', async () => {
  // 2026-11-14 用户 m03127 报「关了之后点不开」：真正会踩到的是这一种——
  // 目标还在、也填完了，只是每一条都被单独关了。原来这里只判 ready，会直接放行然后
  // 后端因为「没有能用目标」把开关顶回来，看着就像点不开。
  const { tree, sets } = await render({
    tab: 'data',
    cloudOpen: true,
    cloudState: { targets: [{ id: 't1', kind: 'folder', name: '网盘', label: '文件夹', enabled: false, ready: true, problem: '' }], kinds: [] },
  })
  let posted = 0
  await withFetch({}, async (calls) => {
    await sw(tree, '往云端送').props.onClick()
    posted = calls.filter((c) => c.path === '/config').length
  })
  assert.equal(posted, 0, '一个都没启用时不该提交')
  assert.equal(last(sets, 'cloudOn'), undefined)
  const msg = last(sets, 'cloudGate')
  assert.match(msg, /先别用它/)
  assert.match(msg, /用它/)
})

test('云端开关：有一个能用的地方时正常打开，并清掉上一句提示', async () => {
  const { tree, sets } = await render({
    tab: 'data',
    cloudOpen: true,
    cloudState: { targets: [{ id: 't1', kind: 'folder', name: '网盘', label: '文件夹', enabled: true, ready: true, problem: '' }], kinds: [] },
  })
  await withFetch({ 'POST /config': { ok: true } }, async (calls) => {
    await sw(tree, '往云端送').props.onClick()
    const hit = calls.find((c) => c.path === '/config')
    assert.ok(hit, '要真的提交')
    assert.match(String(hit.body), /"enabled":true/)
  })
  assert.equal(last(sets, 'cloudOn'), true)
  assert.equal(last(sets, 'cloudGate'), '', '打开之后那句拦人的话要消失')
})

// ---- 2026-11-14 用户 m03127：「加一个」一进来就是灰的 ----

test('「加一个」一进页面就能点：下拉画着第一项，按钮就不能是灰的', async () => {
  // 原因：select 的 value 是空串时浏览器会把第一项**画**出来，看着像选中了、值还是空的，
  // 于是「加一个」被禁用，得先切走再切回来才活。现在按「用户选过就用他选的，没选过用第一项」。
  const kinds = [
    { kind: 'folder', label: '一个文件夹', fields: [{ key: 'dir', label: '目录', type: 'text', required: true }] },
    { kind: 'git', label: '代码仓库', fields: [] },
  ]
  const { tree } = await render({ tab: 'data', cloudOpen: true, cloudState: { targets: [], kinds } })
  const btn = button(tree, '点击配置')
  assert.ok(!btn.props.disabled, '一进来就该能点，不该逼人先去下拉里绕一圈')
  const sel = findAll(tree, (n) => n.type === 'select')[0]
  assert.equal(sel.props.value, 'folder', '下拉的值要落在第一项上，跟眼睛看到的一致')
})

test('刷新状态：点了必须留下「刷过了 + 看到了什么 + 几点」，不能一声不吭', async () => {
  // 用户 m03127：「刷新状态的按钮，点了之后好像也没有变化」——原来只重拉一次、写同样的字。
  const st = { enabled: false, targets: [], due: false, dueWhy: '关着', lastName: '', localDir: '', newest: null, queue: {} }
  const { tree, sets } = await render({ tab: 'data', cloudOpen: true, cloudState: st })
  const btn = button(tree, '刷新状态')
  await withFetch({ 'GET /cloud': st }, async () => { await btn.props.onClick() })
  const msg = last(sets, 'cloudMsg')
  assert.ok(msg, '点了要有回话')
  assert.match(msg, /刷过了/, '要说清这一下真的刷过')
  assert.match(msg, /关着的/, '要把当下看到的状态说出来')
  assert.match(msg, /[0-9]{1,2}:[0-9]{2}/, '带上时间，两次点之间也能看出差别')
})

test('刷新状态：接口不通时也要说人话，不能静默', async () => {
  const { tree, sets } = await render({ tab: 'data', cloudOpen: true, cloudState: { enabled: false, targets: [] } })
  const btn = button(tree, '刷新状态')
  await withFetch({ 'GET /cloud': () => { throw new Error('连不上') } }, async () => {
    await btn.props.onClick()
  })
  const msg = last(sets, 'cloudMsg')
  assert.match(String(msg), /没刷成/)
  assert.match(String(msg), /连不上/)
})

// ---- 2026-11-14 用户 m03127：「只删它自己传上去的那些，别的东西不碰」看不懂 ----

test('「每个地方留几份」的说明要讲明白删的是哪些文件，别用「它自己」这种指代', async () => {
  // 2026-11-14 用户 m03310：云端那层默认折叠，要展开才看得到这段说明。
  const { tree } = await render({ tab: 'data', cloudOpen: true })
  const all = cardText(tree, '备份与恢复')
  assert.match(all, /每个地方留几份/)
  assert.doesNotMatch(all, /只删它自己传上去的那些/, '这句用户看不懂，已经换掉了')
  assert.match(all, /大肥鱼-自动-/, '要举出文件名长什么样')
  assert.match(all, /不碰/, '要说清别人的文件不受影响')
})

test('备份与恢复是一张卡：手动、自动、云端三层都在里面', async () => {
  const { tree } = await render({ tab: 'data' })
  const all = cardText(tree, '备份与恢复')
  assert.match(all, /手动备份/)
  assert.match(all, /自动备份/)
  assert.match(all, /云端备份/)
  const card = findAll(tree, (n) => n.type === 'div' && (n.children ?? []).some((c) => c?.type === 'h3' && textOf(c).join('') === '备份与恢复'))[0]
  assert.equal(card.props.className, 'card full', '三层塞一窄列会挤成竖缝，这张要整行宽')
})

// ---- 2026-11-14 用户 m02795：自动备份那层只留「存在哪儿」，两个重复入口撤掉 ----

test('自动备份那层不再有「从这份恢复」和「现在存一份」——要存/要恢复都走上面手动那两颗', async () => {
  const autoState = {
    enabled: true, count: 1, sizeText: '1 份，一共 8KB', due: false, dueWhy: '24 小时后',
    dir: 'C:\\Users\\me\\.dsh-fish\\backups', latest: { name: '大肥鱼-自动-最新.json' },
    items: [{ name: '大肥鱼-自动-20261114-070255.json', bytes: 8192 }],
  }
  const { tree } = await render({ tab: 'data', autoState })
  const labels = findAll(tree, (n) => n.type === 'button').map((b) => textOf(b).join(''))
  assert.ok(!labels.includes('从这份恢复'), '列表里不该再挂恢复按钮')
  assert.ok(!labels.includes('现在存一份到数据文件夹'), '手动存一份已被上面「备份成一份文件」覆盖')
  assert.ok(labels.includes('备份成一份文件'), '上面那颗手动备份要还在')
  assert.ok(labels.includes('从备份恢复'), '恢复入口只剩上面那颗')
})

test('自动备份那层明写「存在哪儿」，并给一颗复制路径的按钮', async () => {
  const dir = 'C:\\Users\\me\\.dsh-fish\\backups'
  const autoState = { enabled: true, count: 0, sizeText: '', due: true, dueWhy: '还没备份过', dir, latest: null, items: [] }
  const { tree, sets } = await render({ tab: 'data', autoState })
  const all = cardText(tree, '备份与恢复')
  assert.ok(all.includes(dir), '路径要写在明面上，别让人自己去猜')
  assert.match(all, /资源管理器/)
  const copy = button(tree, '复制备份文件夹路径')
  await withFetch({}, async () => { await copy.props.onClick() })
  const note = last(sets, 'note')
  assert.ok(note, '点了要有回话')
  assert.match(note, /剪贴板|复制/, '复制不了也要说清楚，不能静默')
})

test('自动备份那层：路径还没读到时按钮禁用，并说「刷新一下再看」而不是给颗死按钮', async () => {
  const { tree } = await render({ tab: 'data', autoState: { enabled: true, count: 0, dir: '', items: [] } })
  const b = button(tree, '备份路径还没读到')
  assert.equal(b.props.disabled, true)
  assert.match(cardText(tree, '备份与恢复'), /刷新/)
})

// ---- 2026-11-14 用户 m03310：云端默认折叠 / 选目录走文件选择器 / 两个数字框并排 ----

test('云端那层默认折叠：一进来只有标题和一颗「展开」，设置项都不在页面上', async () => {
  const { tree } = await render({ tab: 'data', cloudState: { enabled: false, targets: [] } })
  const labels = findAll(tree, (n) => n.type === 'button').map((b) => textOf(b).join(''))
  assert.ok(labels.includes('展开'), '要有一颗展开的入口')
  assert.ok(!labels.includes('收起'), '默认是收着的')
  assert.ok(!labels.includes('往云端送'), '折叠时不该把开关摊在外面')
  assert.ok(!labels.includes('现在就送一份'), '折叠时底部那排也不该在')
})

test('云端那层：点「展开」就摊开设置，再点「收起」收回去', async () => {
  const { tree, sets } = await render({ tab: 'data', cloudState: { enabled: false, targets: [] } })
  await button(tree, '展开').props.onClick()
  assert.equal(last(sets, 'cloudOpen'), true, '点一下要真的打开')

  // 打开之后重新渲染一次，才看得见摊开的内容。
  const opened = await render({ tab: 'data', cloudOpen: true, cloudState: { enabled: false, targets: [] } })
  assert.ok(findAll(opened.tree, (n) => n.type === 'button').map((b) => textOf(b).join('')).includes('收起'))
  // 开关的标签在 .fl 里，不在按钮文字里，所以按整棵树的文字找。
  assert.match(textOf(opened.tree).join(''), /往云端送/)
})

test('云端「一个文件夹」的目录：给一颗「选择文件夹…」，没有选择器时说清改成手填', async () => {
  const kinds = [
    { kind: 'folder', label: '一个文件夹', steps: '选一个目录', fields: [{ key: 'dir', label: '目录', type: 'text', required: true }] },
  ]
  const { tree, sets } = await render({
    tab: 'data',
    cloudOpen: true,
    cloudDraft: { kind: 'folder', id: '', name: '', dir: '' },
    cloudState: { enabled: false, targets: [], kinds },
  })
  const pick = button(tree, '选择文件夹…')
  // 测试环境没有 window.__DSH_DIRECTORY_PICKER__，点了应当给出人话退路，而不是静默什么都不发生。
  await pick.props.onClick()
  const msg = last(sets, 'cloudMsg')
  assert.ok(msg, '点了要有回话')
  assert.match(msg, /贴进|手填|路径/)
})

test('云端「一个文件夹」的目录：有文件选择器时，选完直接把路径写进草稿', async () => {
  const kinds = [
    { kind: 'folder', label: '一个文件夹', steps: '选一个目录', fields: [{ key: 'dir', label: '目录', type: 'text', required: true }] },
  ]
  globalThis.__DSH_DIRECTORY_PICKER__ = { pick: async () => 'D:\\我的网盘\\大肥鱼备份' }
  try {
    const { tree, sets } = await render({
      tab: 'data',
      cloudOpen: true,
      cloudDraft: { kind: 'folder', id: '', name: '', dir: '' },
      cloudState: { enabled: false, targets: [], kinds },
    })
    await button(tree, '选择文件夹…').props.onClick()
    const draft = last(sets, 'cloudDraft')
    assert.ok(draft, '选完要写回草稿')
    assert.equal(draft.dir, 'D:\\我的网盘\\大肥鱼备份', '路径要原样落进去，不用人再敲一遍')
  } finally {
    delete globalThis.__DSH_DIRECTORY_PICKER__
  }
})

test('自动备份的两个数字框并排一格，不各占一行', async () => {
  const { tree } = await render({ tab: 'data' })
  const sameRow = findAll(tree, (n) => {
    if (n.type !== 'div' || n.props?.className !== 'row') return false
    const t = textOf(n).join('')
    return t.includes('多久存一份') && t.includes('留几份')
  })
  assert.equal(sameRow.length, 1, '两个框要在同一个 row 里并排')
})

// ---- 2026-11-14 用户 m03579：.enc 看不懂、「从这份恢复」这条路径说不通、口令那句说两遍 ----

test('云上那几份：既给「取到本机」，也留着「直接恢复」——原来说的路径根本不存在', async () => {
  // 用户原话：「从云端下载下来的不能是 json 格式吗……我不下载下来怎么去导入数据恢复」
  // 云上放的是 .json.enc，本地「从备份恢复」只认 .json，所以界面上必须有一条「先取下来」的路。
  const target = { id: 't1', kind: 'folder', name: '网盘', label: '一个文件夹', ready: true, enabled: true, problem: '' }
  const { tree } = await render({
    tab: 'data',
    cloudOpen: true,
    cloudRemote: { target, items: [{ name: '大肥鱼-自动-20261114-070255.json.enc', bytes: 8192 }] },
    cloudState: { enabled: true, targets: [target], kinds: [] },
  })
  const labels = findAll(tree, (n) => n.type === 'button').map((b) => textOf(b).join(''))
  assert.ok(labels.includes('取到本机'), '要把云上那份取成本机的 json')
  assert.ok(labels.includes('直接恢复'), '就地恢复那条路也留着，两条路各有各的用处')
  assert.ok(!labels.includes('从这份恢复'), '旧措辞要撤掉：它说的不是下载')
})

test('云上那几份：先讲清云上是加密的 .enc、两条路各是干什么的', async () => {
  const target = { id: 't1', kind: 'folder', name: '网盘', label: '一个文件夹', ready: true, enabled: true, problem: '' }
  const { tree } = await render({
    tab: 'data',
    cloudOpen: true,
    cloudRemote: { target, items: [{ name: '大肥鱼-自动-20261114-070255.json.enc', bytes: 8192 }] },
    cloudState: { enabled: true, targets: [target], kinds: [] },
  })
  const all = cardText(tree, '备份与恢复')
  assert.match(all, /\.enc/, '得让人知道云上那个后缀是什么')
  assert.match(all, /从备份恢复/, '要说清取下来之后怎么用')
})

test('取到本机：成功后要说清放进哪儿了，不写『已完成』了事', async () => {
  const target = { id: 't1', kind: 'folder', name: '网盘', label: '一个文件夹', ready: true, enabled: true, problem: '' }
  const { tree, sets } = await render({
    tab: 'data',
    cloudOpen: true,
    cloudRemote: { target, items: [{ name: '大肥鱼-自动-20261114-070255.json.enc', bytes: 8192 }] },
    cloudState: { enabled: true, targets: [target], kinds: [] },
  })
  const btn = button(tree, '取到本机')
  await withFetch({
    'POST /cloud/download': { ok: true, name: '大肥鱼-自动-20261114-070255.json', path: 'C:\\x\\backups\\大肥鱼-自动-20261114-070255.json', bytes: 8192, encrypted: true },
  }, async () => { await btn.props.onClick() })
  const msg = String(last(sets, 'cloudMsg'))
  assert.match(msg, /取下来了/)
  assert.match(msg, /大肥鱼-自动-20261114-070255\.json/, '要把文件名说出来')
  assert.match(msg, /备份文件夹/, '要告诉人它落到哪儿去了')
})

test('取到本机：口令不对时原样端上来，不能变成一句「失败」', async () => {
  const target = { id: 't1', kind: 'folder', name: '网盘', label: '一个文件夹', ready: true, enabled: true, problem: '' }
  const { tree, sets } = await render({
    tab: 'data',
    cloudOpen: true,
    cloudRemote: { target, items: [{ name: '大肥鱼-自动-20261114-070255.json.enc', bytes: 8192 }] },
    cloudState: { enabled: true, targets: [target], kinds: [] },
  })
  const btn = button(tree, '取到本机')
  await withFetch({
    'POST /cloud/download': () => { throw new Error('解不开：口令不对，或者这份文件在路上被改过。') },
  }, async () => { await btn.props.onClick() })
  const msg = String(last(sets, 'cloudMsg'))
  assert.match(msg, /取不下来/)
  assert.match(msg, /口令不对/, '原话要留着，人才知道该去改口令')
})

test('没设口令时「没有口令就没法加密」只说一遍', async () => {
  // 用户 m03579：那句话原来出现两次（手写文案一遍、passProblem 一遍）。
  const { tree } = await render({
    tab: 'data',
    cloudOpen: true,
    cloudState: {
      enabled: false, targets: [], hasPass: false,
      passProblem: '还没设口令。没有口令就没法加密，云端那一份等于明着放。',
    },
  })
  const all = cardText(tree, '备份与恢复')
  const hits = all.split('没有口令就没法加密').length - 1
  assert.equal(hits, 1, `同一句提示只说一次，现在说了 ${hits} 次`)
})

test('设过口令之后那句换成了「存在哪、丢了会怎样」', async () => {
  const { tree } = await render({
    tab: 'data',
    cloudOpen: true,
    cloudState: {
      enabled: true, targets: [], hasPass: true, passHint: '我的生日',
      passFingerprint: 'a1b2c3d4', passProblem: '',
    },
  })
  const all = cardText(tree, '备份与恢复')
  assert.match(all, /我的生日/)
  assert.match(all, /丢了就真解不开/)
  assert.ok(!all.includes('没有口令就没法加密'), '设过了就不该再说这句')
})

// ---- 2026-11-14 用户 m03675 / m03709：从备份恢复要能直接吃下 .enc ----

/** 冒充一个 File：够 restoreFromFile 用的那几个方法（slice/arrayBuffer/text）。 */
function fakeFile(bytes, { name = '大肥鱼-自动-20261114-100429.json.enc' } = {}) {
  const buf = Buffer.from(bytes)
  return {
    name,
    size: buf.length,
    slice: (a, b) => ({ arrayBuffer: async () => buf.subarray(a, b) }),
    arrayBuffer: async () => buf,
    text: async () => buf.toString('utf8'),
  }
}

const ENC_HEAD = Buffer.from('DSHFISH1', 'ascii')

test('选文件的对话框不再只列 json——不然 .json.enc 根本看不见', async () => {
  // 用户 m03709：「点击之后是默认选择json文件，你得改成选择所有文件，这样才能显示enc文件」
  const { tree, made } = await render({ tab: 'data' })
  button(tree, '从备份恢复').props.onClick()
  const input = made.find((el) => el.tag === 'input')
  assert.equal(input.accept, '', '空字符串＝不筛，什么文件都能选')
})

test('选到加密包（开头 DSHFISH1）时走解密那条路，不在前端硬吃', async () => {
  const { tree, sets, made } = await render({ tab: 'data', cloudPass: 'my-pass-123' })
  await withFetch({
    'POST /backup/restore/enc': { ok: true, restored: 4, quarantined: '', skipped: [] },
  }, async () => {
    button(tree, '从备份恢复').props.onClick()
    const input = made.find((el) => el.tag === 'input')
    input.files = [fakeFile(Buffer.concat([ENC_HEAD, Buffer.alloc(64, 7)]))]
    await input.onchange()
  })
  const msg = last(sets, 'backupMsg')
  assert.match(msg, /^已恢复 4 个文件/, `要按恢复回执说：${msg}`)
})

test('加密包不看扩展名：名字改成 .txt 也照样按内容认出来', async () => {
  const { tree, made } = await render({ tab: 'data' })
  let hit = ''
  await withFetch({
    'POST /backup/restore/enc': () => { hit = 'enc'; return { ok: true, restored: 1 } },
    'POST /backup/restore': () => { hit = 'plain'; return { ok: true, restored: 1 } },
  }, async () => {
    button(tree, '从备份恢复').props.onClick()
    const input = made.find((el) => el.tag === 'input')
    input.files = [fakeFile(Buffer.concat([ENC_HEAD, Buffer.alloc(32, 1)]), { name: '随便改的名字.txt' })]
    await input.onchange()
  })
  assert.equal(hit, 'enc', '网盘改名、下载器加后缀都不该影响判断')
})

test('普通 json 仍走原来那条路，不因为放开文件类型就改道', async () => {
  const { tree, made } = await render({ tab: 'data' })
  const seen = []
  await withFetch({
    'POST /backup/restore/enc': () => { seen.push('enc'); return { ok: true, restored: 1 } },
    'POST /backup/restore': () => { seen.push('plain'); return { ok: true, restored: 2 } },
  }, async () => {
    button(tree, '从备份恢复').props.onClick()
    const input = made.find((el) => el.tag === 'input')
    input.files = [fakeFile(JSON.stringify(BUNDLE), { name: '大肥鱼-20261114-1004.json' })]
    await input.onchange()
  })
  assert.deepEqual(seen, ['plain'])
})

test('口令不对时给一条能照着做的话，并说清口令存在哪儿、找不回来', async () => {
  const { tree, sets, made } = await render({ tab: 'data' })
  await withFetch({
    'POST /backup/restore/enc': () => ({
      __status: 400,
      ok: false,
      error: '解不开：口令不对，或者这份文件在路上被改过。',
    }),
  }, async () => {
    button(tree, '从备份恢复').props.onClick()
    const input = made.find((el) => el.tag === 'input')
    input.files = [fakeFile(Buffer.concat([ENC_HEAD, Buffer.alloc(32, 3)]))]
    await input.onchange()
  })
  const msg = last(sets, 'backupMsg')
  assert.match(msg, /没有对得上的口令/)
  assert.match(msg, /加密口令/, '要指到那个输入框去')
  assert.match(msg, /cloud-key\.txt/, '要告诉人当时那份口令存在哪儿')
})

test('既不是 json、开头也不是 DSHFISH1：说清两种都不是，别只说「不是 json」', async () => {
  const { tree, sets, made } = await render({ tab: 'data' })
  button(tree, '从备份恢复').props.onClick()
  const input = made.find((el) => el.tag === 'input')
  input.files = [fakeFile('这是一张图片，不是备份')]
  await input.onchange()
  const msg = last(sets, 'backupMsg')
  assert.match(msg, /不是 json/)
  assert.match(msg, /DSHFISH1/, '要带上认出来的依据，才知道该换哪个文件')
})



