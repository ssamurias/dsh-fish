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
