/**
 * trip-settle.test.mjs —— 出门与请神回家、复核时「这趟算不算」到底兑现了没有（issue #68，0.9.5 之后）。
 *
 * 0.9.5 把出门那半修好了大半，请神那半（possess.js、/possession 的 end / review）还是老写法，
 * 两边也各有几处口径对不上。这里不测函数拼得对不对，测的是结果：
 * 回家 / 复核之后，`deriveSelf` 里这趟的条目算不算、台账落成什么、身份文档跟没跟上。
 *
 * 场景都在临时目录里跑真的 `registerObserve`；假 ctx 只桩路由注册、活 agent、工作区列表。
 * 「对不上」用同长度改掉出门前那一行的几个字来造（大小不变、开头那段的哈希变了），
 * 「还原」就是改回来。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, appendFileSync, truncateSync, statSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { registerObserve } from '../lib/observe.js'
// 复核的结算单独拿出来测（还没有这个函数的版本上，这几条要红而不是整个文件装不上）。
import * as observeLib from '../lib/observe.js'
import { takeNotes } from '../lib/sessionnote.js'
import { deriveSelf } from '../lib/derive.js'
import { readEvents } from '../lib/store.js'
import { writeSelfDoc, selfDocPath } from '../lib/selfdoc.js'
import { loadConfig } from '../lib/settings.js'
import { pocketDirPath } from '../lib/pocket.js'
import {
  snapshotEvents, startOuting, startPossession, readOutings, readPossessions,
  settlePending, eventsSince, OUTING_SCHEMA,
} from '../lib/outing.js'

const T0 = Date.parse('2026-11-09T01:00:00.000Z')
const iso = (ms) => new Date(ms).toISOString()

const line = (id, ts, type, text, extra = {}) =>
  JSON.stringify({ id, v: 1, ts, day: 1, stage: 1, type, source: 'her', text, refs: [], verdict: null, confidence: 0.5, flags: [], ...extra }) + '\n'

/** 像真的事件 id 那么长（ev_ + 26 位）：标记一行塞多少条，取决于 id 的长度。 */
const longId = (tag, i) => 'ev_' + (tag + String(i)).padStart(26, '0')

function harness(root, { workspaces = [] } = {}) {
  const routes = new Map()
  const ctx = {
    get(name) {
      if (name === 'connection') return { requestRejection: () => null }
      if (name === 'webServer') return { register(ex) { routes.set(ex.path, ex.handler); return () => {} } }
      if (name === 'agents') return { get: () => null, list: () => [] }
      if (name === 'workspaceRegistry') return { list: () => workspaces }
      return undefined
    },
  }
  registerObserve(ctx, { root })
  async function call(path, method, body) {
    const handler = routes.get('/dsh-fish/' + path)
    assert.ok(handler, `路由 ${path} 要注册上`)
    const req = method === 'POST'
      ? Object.assign(Readable.from([Buffer.from(JSON.stringify(body ?? {}), 'utf8')]), { method, headers: {} })
      : Object.assign(Readable.from([]), { method, headers: {} })
    let status = 0
    let text = ''
    const res = {
      writableEnded: false,
      writeHead(code) { status = code },
      end(chunk) { text = String(chunk ?? ''); res.writableEnded = true },
    }
    await handler(req, res)
    return { status, json: text ? JSON.parse(text) : null }
  }
  return { call }
}

/** 一个家：出门前一条拒绝（带 AAAA，篡改 / 还原都改它），外加 home 目录。 */
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'fish-trip-settle-'))
  mkdirSync(join(root, 'home'), { recursive: true })
  const file = join(root, 'events.jsonl')
  writeFileSync(file, line('ev_base', iso(T0 - 3600_000), 'refusal', '我不想今天出门 AAAA'), 'utf8')
  return { root, file, done: () => rmSync(root, { recursive: true, force: true }) }
}

const tamper = (file) => writeFileSync(file, readFileSync(file, 'utf8').replace('AAAA', 'BBBB'), 'utf8')
const restore = (file) => writeFileSync(file, readFileSync(file, 'utf8').replace('BBBB', 'AAAA'), 'utf8')

/** 这趟外面那条会话写的拒绝，外加家里那条会话同一时段写的一条。 */
function writeTrip(file, { n = 2, tag = 'out', homeToo = true } = {}) {
  const ids = []
  for (let i = 0; i < n; i += 1) {
    const id = n > 9 ? longId(tag, i) : `ev_${tag}${i + 1}`
    ids.push(id)
    appendFileSync(file, line(id, iso(T0 + 60_000 + i * 1000), 'refusal', `外面说的第 ${i + 1} 句：我不干这个`, { sessionId: 's-out' }), 'utf8')
  }
  if (homeToo) {
    appendFileSync(file, line('ev_home', iso(T0 + 30_000), 'refusal', '家里说的一句：我不想洗碗', { sessionId: 's-home' }), 'utf8')
  }
  return ids
}

async function counted(root) {
  const { events } = await readEvents(root)
  return new Set(deriveSelf(events).refusals.map((r) => r.id))
}

const goOut = (root, file) => startOuting(root, {
  sessionId: 's-out', workspaceId: 'w1', workspaceName: '素材', cwd: join(root, 'ws'),
  baseline: snapshotEvents(file), identity: '', now: T0,
})

const possess = (root, file) => startPossession(root, {
  sessionId: 's-out', title: '一个对话', cwd: join(root, 'ws'),
  baseline: snapshotEvents(file), identity: '', now: T0,
})

// ---------------------------------------------------------------------------
// 请神
// ---------------------------------------------------------------------------

test('请神对不上：复核之前这趟真的不算，复核通过后才捞回来（issue #68）', async () => {
  const { root, file, done } = setup()
  try {
    const h = harness(root)
    await possess(root, file)
    const ids = writeTrip(file, { homeToo: false })
    tamper(file)

    const ended = await h.call('possession', 'POST', { action: 'end', kept: true })
    assert.equal(ended.status, 200, JSON.stringify(ended.json))
    assert.equal(ended.json.tampered, true)
    assert.equal(ended.json.possession.status, 'pending')
    const before = await counted(root)
    for (const id of ids) assert.ok(!before.has(id), `${id}：界面说「这趟先不算数」，派生里就不能算`)
    assert.ok(before.has('ev_base'), '出门前的那条不受影响')

    restore(file)
    const reviewed = await h.call('possession', 'POST', { action: 'review' })
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.json))
    assert.equal(reviewed.json.possession.status, 'done')
    const after = await counted(root)
    for (const id of ids) assert.ok(after.has(id), `${id}：复核通过、人又没划掉，就该算回来`)
  } finally { done() }
})

test('请神对不上时点「整趟不算」：复核通过后照办，整趟不算、台账落成 rejected（issue #68）', async () => {
  const { root, file, done } = setup()
  try {
    const h = harness(root)
    await possess(root, file)
    const ids = writeTrip(file, { homeToo: false })
    tamper(file)
    const ended = await h.call('possession', 'POST', { action: 'end', kept: false, rejectedIds: [] })
    assert.equal(ended.status, 200, JSON.stringify(ended.json))
    restore(file)
    const reviewed = await h.call('possession', 'POST', { action: 'review' })
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.json))
    assert.equal(reviewed.json.possession.status, 'rejected', '人选的是整趟不算，复核后不能落成「已算数」')
    assert.equal(reviewed.json.possession.kept, false)
    const after = await counted(root)
    for (const id of ids) assert.ok(!after.has(id), `${id}：整趟不算，复核通过后也不算`)
  } finally { done() }
})

test('请神对不上时逐条划掉：复核通过后只有划掉的那条不算（issue #68）', async () => {
  const { root, file, done } = setup()
  try {
    const h = harness(root)
    await possess(root, file)
    writeTrip(file, { homeToo: false })
    tamper(file)
    await h.call('possession', 'POST', { action: 'end', kept: true, rejectedIds: ['ev_out2'] })
    restore(file)
    const reviewed = await h.call('possession', 'POST', { action: 'review' })
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.json))
    const after = await counted(root)
    assert.ok(after.has('ev_out1'), '没划掉的捞回来')
    assert.ok(!after.has('ev_out2'), '划掉的那条复核后也不算')
  } finally { done() }
})

test('请神的清单和「整趟不算」只认被上身那条会话写的（issue #68）', async () => {
  const { root, file, done } = setup()
  try {
    const h = harness(root)
    await possess(root, file)
    writeTrip(file)
    const got = await h.call('possession', 'GET')
    assert.deepEqual(got.json.since.items.map((it) => it.id).sort(), ['ev_out1', 'ev_out2'], '家里那条会话写的不进清单')
    assert.equal(got.json.since.total, 2)

    const ended = await h.call('possession', 'POST', { action: 'end', kept: false })
    assert.equal(ended.status, 200, JSON.stringify(ended.json))
    assert.equal(ended.json.rejected, 2)
    const after = await counted(root)
    assert.ok(after.has('ev_home'), '家里那句不该跟着这趟一起不算')
    assert.ok(!after.has('ev_out1') && !after.has('ev_out2'))
  } finally { done() }
})

test('请神整趟不算 67 条：标记拆行写进去，67 条一条都不算（issue #68）', async () => {
  const { root, file, done } = setup()
  try {
    const h = harness(root)
    await possess(root, file)
    const ids = writeTrip(file, { n: 67, homeToo: false })
    assert.equal(ids[0].length, 29, '和真的事件 id 一样长')
    const ended = await h.call('possession', 'POST', { action: 'end', kept: false })
    assert.equal(ended.status, 200, JSON.stringify(ended.json))
    assert.equal(ended.json.rejected, 67)
    const marks = readFileSync(file, 'utf8').split('\n').filter((l) => l.includes('possess-reject:'))
    assert.ok(marks.length >= 2, '一行放不下就拆成几行')
    for (const m of marks) assert.ok(JSON.parse(m).text.length <= 2000)
    const after = await counted(root)
    for (const id of ids) assert.ok(!after.has(id), `${id} 不该再算`)
  } finally { done() }
})

// ---------------------------------------------------------------------------
// 出门
// ---------------------------------------------------------------------------

test('出门对不上时点「整趟不算」：复核通过后整趟不算，台账落成 rejected（issue #68）', async () => {
  const { root, file, done } = setup()
  try {
    const h = harness(root)
    await goOut(root, file)
    const ids = writeTrip(file, { homeToo: false })
    tamper(file)
    const ended = await h.call('outing', 'POST', { action: 'end', kept: false, rejectedIds: [] })
    assert.equal(ended.status, 200, JSON.stringify(ended.json))
    assert.equal(ended.json.outing.status, 'pending')
    restore(file)
    const reviewed = await h.call('outing', 'POST', { action: 'review' })
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.json))
    assert.equal(reviewed.json.outing.status, 'rejected', '最近几趟里不能显示「已算数」')
    assert.equal(reviewed.json.outing.kept, false)
    const after = await counted(root)
    for (const id of ids) assert.ok(!after.has(id), `${id}：人点的是整趟不算`)
  } finally { done() }
})

test('出门回家清单和回家结算同一个口径：家里会话的话不进清单、划了也不标；记账行不摆（issue #68）', async () => {
  const { root, file, done } = setup()
  try {
    const h = harness(root)
    await goOut(root, file)
    writeTrip(file)
    appendFileSync(file, line('ev_diary', iso(T0 + 90_000), 'meta', 'diary:2026-11-09 trip:x', { sessionId: 's-out' }), 'utf8')

    const got = await h.call('outing', 'GET')
    assert.deepEqual(got.json.away.since.items.map((it) => it.id).sort(), ['ev_out1', 'ev_out2'],
      '清单只摆这趟那条会话写的，家里会话那句和日记书签都不摆')
    assert.equal(got.json.away.since.total, 2, '「这趟她写了 N 条」和清单对得上')

    // 就算请求里带着清单以外的 id（旧页面、手搓请求），也不替人标家里那句。
    const ended = await h.call('outing', 'POST', { action: 'end', kept: true, rejectedIds: ['ev_home', 'ev_out2'] })
    assert.equal(ended.status, 200, JSON.stringify(ended.json))
    assert.equal(ended.json.rejected, 1)
    const after = await counted(root)
    assert.ok(after.has('ev_home'), '家里那句照算')
    assert.ok(!after.has('ev_out2'))
    assert.ok(after.has('ev_out1'))
  } finally { done() }
})

test('出门一趟 520 条：整趟不算、对不上先不算，都是 520 条全标上（issue #68）', async () => {
  for (const tampered of [false, true]) {
    const { root, file, done } = setup()
    try {
      const h = harness(root)
      await goOut(root, file)
      const ids = writeTrip(file, { n: 520, homeToo: false })
      if (tampered) tamper(file)
      const ended = await h.call('outing', 'POST', tampered ? { action: 'end', kept: true } : { action: 'end', kept: false })
      assert.equal(ended.status, 200, JSON.stringify(ended.json))
      const after = await counted(root)
      const stillCounted = ids.filter((id) => after.has(id))
      assert.deepEqual(stillCounted, [], `${tampered ? '对不上' : '整趟不算'}：最早那些条也要标上`)
      if (tampered) {
        restore(file)
        const reviewed = await h.call('outing', 'POST', { action: 'review' })
        assert.equal(reviewed.status, 200, JSON.stringify(reviewed.json))
        const back = await counted(root)
        assert.deepEqual(ids.filter((id) => !back.has(id)), [], '复核通过后 520 条都要捞回来')
      }
    } finally { done() }
  }
})

test('出门对不上、事件流被截在半行上：标记不能粘在半行后面丢掉（issue #68）', async () => {
  const { root, file, done } = setup()
  try {
    const h = harness(root)
    await goOut(root, file)
    const ids = writeTrip(file, { n: 3, homeToo: false })
    tamper(file)
    truncateSync(file, statSync(file).size - 5) // 最后一条被截成半行
    const ended = await h.call('outing', 'POST', { action: 'end', kept: true })
    assert.equal(ended.status, 200, JSON.stringify(ended.json))
    assert.equal(ended.json.tampered, true)
    const after = await counted(root)
    for (const id of ids.slice(0, 2)) assert.ok(!after.has(id), `${id}：这趟先不算数`)
  } finally { done() }
})

test('回家、复核之后当场重写身份文档（issue #68）', async () => {
  const { root, file, done } = setup()
  try {
    const h = harness(root)
    await goOut(root, file)
    writeTrip(file, { homeToo: false })
    await writeSelfDoc(root)
    const doc = () => readFileSync(selfDocPath(root), 'utf8')
    assert.match(doc(), /外面说的第 2 句/, '她在外面写的已经进了身份文档（capture 写完就重写）')

    tamper(file)
    await h.call('outing', 'POST', { action: 'end', kept: true })
    assert.doesNotMatch(doc(), /外面说的第 2 句/, '这趟先不算了，家里那条会话下一轮读到的文档里就不能还有')

    restore(file)
    await h.call('outing', 'POST', { action: 'review' })
    assert.match(doc(), /外面说的第 2 句/, '复核捞回来了，文档也要跟上')
  } finally { done() }
})

test('请神结束点「整趟不算」后身份文档当场去掉这趟的话（issue #68）', async () => {
  const { root, file, done } = setup()
  try {
    const h = harness(root)
    await possess(root, file)
    writeTrip(file, { homeToo: false })
    await writeSelfDoc(root)
    const doc = () => readFileSync(selfDocPath(root), 'utf8')
    assert.match(doc(), /外面说的第 2 句/)
    await h.call('possession', 'POST', { action: 'end', kept: false })
    assert.doesNotMatch(doc(), /外面说的第 2 句/)
  } finally { done() }
})

test('同一条会话两趟都在等复核：按趟次结算，不会把另一趟结掉（issue #68）', async () => {
  const { root, done } = setup()
  try {
    const rec = (startedAt) => ({
      sessionId: 's-same', workspaceId: 'w1', workspaceName: '素材', cwd: join(root, 'ws'),
      startedAt, endedAt: startedAt + 60_000, status: 'pending', baseline: null, kept: null, identity: '',
      rejectedIds: [], pendingRejectedIds: [],
    })
    // 「接着上次那条」：A、B 两趟指向同一条会话。
    writeFileSync(join(root, 'outings.json'), JSON.stringify({ version: OUTING_SCHEMA, outings: [rec(T0), rec(T0 + 3600_000)] }), 'utf8')

    // 两个复核请求都核对的是 B（最后一趟）：第一个结了 B，第二个晚到，不能顺手把 A 结掉。
    const first = await settlePending(root, { sessionId: 's-same', startedAt: T0 + 3600_000 })
    assert.equal(first.ok, true)
    const second = await settlePending(root, { sessionId: 's-same', startedAt: T0 + 3600_000 })
    assert.equal(second.ok, false, '核对过的那趟已经结了，就不结别的')
    const { outings } = await readOutings(root)
    assert.equal(outings[0].status, 'pending', 'A 还在等复核，复核卡不能没了')
    assert.equal(outings[1].status, 'done')
  } finally { done() }
})

test('keep 和 reject 的先后与事件顺序无关（issue #68）', () => {
  const ev = (id, ts, type, text) => JSON.parse(line(id, ts, type, text))
  const events = [
    ev('ev_trip', '2026-11-09T01:01:00.000Z', 'refusal', '外面说的一句'),
    // 回家和复核之间重启过、系统时钟往回调过：keep 那行排到了 reject 前面。
    ev('ev_keep', '2026-11-09T01:01:55.000Z', 'meta', 'outing-keep:ev_trip'),
    ev('ev_mark', '2026-11-09T01:01:59.000Z', 'meta', 'outing-reject:ev_trip'),
  ]
  const m = deriveSelf(events, { now: Date.parse('2026-11-09T02:00:00.000Z') })
  assert.deepEqual(m.refusals.map((r) => r.id), ['ev_trip'], '复核通过捞回来的，不能因为时钟往回调就再也回不来')

  // keep 只解自己那条路的 reject：请神的 keep 不放出出门驳回的条目。
  const cross = deriveSelf([
    ev('ev_trip', '2026-11-09T01:01:00.000Z', 'refusal', '外面说的一句'),
    ev('ev_mark', '2026-11-09T01:01:59.000Z', 'meta', 'outing-reject:ev_trip'),
    ev('ev_keep', '2026-11-09T01:02:00.000Z', 'meta', 'possess-keep:ev_trip'),
  ], { now: Date.parse('2026-11-09T02:00:00.000Z') })
  assert.equal(cross.refusals.length, 0)
})

test('没有基线的 pending：出门卡和请神卡的「核对一次」都能点，接口也放行（issue #68）', async () => {
  const { root, done } = setup()
  try {
    const h = harness(root)
    const base = { startedAt: T0, endedAt: T0 + 60_000, status: 'pending', baseline: null, kept: null, identity: '', rejectedIds: [], pendingRejectedIds: [] }
    writeFileSync(join(root, 'outings.json'), JSON.stringify({ version: OUTING_SCHEMA, outings: [{ ...base, sessionId: 's-o', workspaceId: 'w1', workspaceName: '素材', cwd: join(root, 'ws') }] }), 'utf8')
    writeFileSync(join(root, 'possessions.json'), JSON.stringify({ version: OUTING_SCHEMA, possessions: [{ ...base, sessionId: 's-p', title: '一个对话', cwd: join(root, 'ws') }] }), 'utf8')

    const o = await h.call('outing', 'GET')
    const p = await h.call('possession', 'GET')
    assert.equal(o.json.pendingReview.okNow, true, '出门卡：接口会放行，按钮就不能灰着')
    assert.equal(p.json.pendingReview.okNow, true)
    // 卡上要据此说「没法核对」，不能说「已经对得上了」：两张卡都要带上这一项。
    assert.equal(o.json.pendingReview.checkable, false)
    assert.equal(p.json.pendingReview.checkable, false)
    assert.equal((await h.call('outing', 'POST', { action: 'review' })).status, 200)
    assert.equal((await h.call('possession', 'POST', { action: 'review' })).status, 200)
    assert.equal((await readPossessions(root)).possessions[0].status, 'done')
  } finally { done() }
})

test('园区按工作区 id 或目录认，不按名字猜（issue #68）', async () => {
  const { root, file, done } = setup()
  try {
    const { config } = await loadConfig(root)
    const pocketDir = pocketDirPath(config)
    const fakeDir = join(root, 'elsewhere', 'outing-pocket')
    const workspaces = [
      { id: 'w-pocket', title: '工作园区', path: pocketDir },
      { id: 'w-fake', title: 'outing-pocket', path: fakeDir },
    ]
    const h = harness(root, { workspaces })

    // 真的园区：默认目录，工作区名是「工作园区」，跟目录名对不上。
    await startOuting(root, { sessionId: 's-p', workspaceId: 'w-pocket', workspaceName: '工作园区', cwd: pocketDir, baseline: snapshotEvents(file), identity: '', now: T0 })
    const inPocket = await h.call('outing', 'GET')
    assert.equal(inPocket.json.away.atPocket, true, '去的就是园区')
    await h.call('outing', 'POST', { action: 'end', kept: true })

    // 园区没登记成工作区时（出门那趟没有工作区 id），按目录也认得出来。
    await startOuting(root, { sessionId: 's-q', workspaceId: '', workspaceName: '工作园区', cwd: pocketDir, baseline: snapshotEvents(file), identity: '', now: T0 + 1 })
    const h2 = harness(root, { workspaces: [] })
    assert.equal((await h2.call('outing', 'GET')).json.away.atPocket, true)
    await h2.call('outing', 'POST', { action: 'end', kept: true })

    // 名字恰好叫 outing-pocket 的普通工作区不是园区。
    await startOuting(root, { sessionId: 's-f', workspaceId: 'w-fake', workspaceName: 'outing-pocket', cwd: fakeDir, baseline: snapshotEvents(file), identity: '', now: T0 + 2 })
    assert.equal((await h.call('outing', 'GET')).json.away.atPocket, false)
  } finally { done() }
})

// ---------------------------------------------------------------------------
// 审查第二轮（issue #68）：驳回的话、并发复核、按趟次结算的接线、给界面的台账
// ---------------------------------------------------------------------------

/** 家里那边这段时间又写了很多记账行（醒来、读材料这类，不带会话 id）。 */
function fillHome(file, n, from = T0 + 120_000) {
  let text = ''
  for (let i = 0; i < n; i += 1) text += line(`ev_wake${i}`, iso(from + i * 1000), 'meta', `wake:2026-11-09 ${i}`)
  appendFileSync(file, text, 'utf8')
}

/** 排队等着递回家里的话里，讲「不认这几条」的那些。 */
async function rejectNotes(root) {
  return (await takeNotes(root)).map((n) => String(n.text ?? '')).filter((t) => t.includes('不认这几条'))
}

test('划掉的那几条，隔了很久、家里又写了很多也照样讲给她听（issue #68）', async () => {
  // 对不上回家、只划掉一条；复核之前家里写了 400 条，复核通过时要摘得到那一条的原话。
  {
    const { root, file, done } = setup()
    try {
      const h = harness(root)
      await goOut(root, file)
      writeTrip(file, { homeToo: false })
      tamper(file)
      const ended = await h.call('outing', 'POST', { action: 'end', kept: true, rejectedIds: ['ev_out1'] })
      assert.equal(ended.status, 200, JSON.stringify(ended.json))
      fillHome(file, 400)
      restore(file)
      await takeNotes(root) // 回家时排的交接句先取走
      const reviewed = await h.call('outing', 'POST', { action: 'review' })
      assert.equal(reviewed.status, 200, JSON.stringify(reviewed.json))
      assert.equal(reviewed.json.note?.ok, true, `驳回的话要递出去：${JSON.stringify(reviewed.json.note)}`)
      const said = (await rejectNotes(root)).join('\n')
      assert.match(said, /外面说的第 1 句/, '划掉的那条要念到')
      assert.doesNotMatch(said, /外面说的第 2 句/, '没划掉的不念')
    } finally { done() }
  }
  // 没对不上：这趟之后家里写了 400 条再叫她回家，划掉的那条也要念到。
  {
    const { root, file, done } = setup()
    try {
      const h = harness(root)
      await goOut(root, file)
      writeTrip(file, { homeToo: false })
      fillHome(file, 400)
      const ended = await h.call('outing', 'POST', { action: 'end', kept: true, rejectedIds: ['ev_out1'] })
      assert.equal(ended.status, 200, JSON.stringify(ended.json))
      assert.equal(ended.json.note?.ok, true, `驳回的话要递出去：${JSON.stringify(ended.json.note)}`)
      assert.match((await rejectNotes(root)).join('\n'), /外面说的第 1 句/)
    } finally { done() }
  }
})

test('两个窗口同时点「核对一次」：这趟只结一次，驳回的话只递一遍（issue #68）', async () => {
  for (const path of ['outing', 'possession']) {
    const { root, file, done } = setup()
    try {
      const h = harness(root)
      if (path === 'outing') await goOut(root, file)
      else await possess(root, file)
      writeTrip(file, { homeToo: false })
      tamper(file)
      const ended = await h.call(path, 'POST', { action: 'end', kept: true, rejectedIds: ['ev_out1'] })
      assert.equal(ended.status, 200, JSON.stringify(ended.json))
      restore(file)
      await takeNotes(root)
      const both = await Promise.all([
        h.call(path, 'POST', { action: 'review' }),
        h.call(path, 'POST', { action: 'review' }),
      ])
      assert.deepEqual(both.map((r) => r.status).sort(), [200, 409], `${path}：晚到的那个找不到还在等的那趟：${JSON.stringify(both.map((r) => r.json))}`)
      assert.equal((await rejectNotes(root)).length, 1, `${path}：她只该听到一遍`)
      const after = await counted(root)
      assert.ok(after.has('ev_out2') && !after.has('ev_out1'), `${path}：照人的选择结算`)
    } finally { done() }
  }
})

test('复核结的是核对过的那一趟：两趟都在等时，不会结成另一趟（issue #68）', async () => {
  const { root, done } = setup()
  try {
    assert.equal(typeof observeLib.settleTripReview, 'function', '复核的结算要能单独拿来测')
    const rec = (startedAt) => ({
      sessionId: 's-same', workspaceId: 'w1', workspaceName: '素材', cwd: join(root, 'ws'),
      startedAt, endedAt: startedAt + 60_000, status: 'pending', baseline: null, kept: null, identity: '',
      rejectedIds: [], pendingRejectedIds: [],
    })
    // 「接着上次那条」：A、B 两趟指向同一条会话，核对的是 A（不是最后那趟）。
    writeFileSync(join(root, 'outings.json'), JSON.stringify({ version: OUTING_SCHEMA, outings: [rec(T0), rec(T0 + 3600_000)] }), 'utf8')
    const a = (await readOutings(root)).outings[0]
    const s = await observeLib.settleTripReview({ get: () => undefined }, root, 'outing', a, settlePending)
    assert.equal(s.ok, true, JSON.stringify(s))
    const { outings } = await readOutings(root)
    assert.equal(outings[0].status, 'done', '核对过的 A 结掉')
    assert.equal(outings[1].status, 'pending', 'B 还在等，复核卡不能没了')
  } finally { done() }
})

test('请神复核之后当场重写身份文档（issue #68）', async () => {
  const { root, file, done } = setup()
  try {
    const h = harness(root)
    await possess(root, file)
    writeTrip(file, { homeToo: false })
    await writeSelfDoc(root)
    const doc = () => readFileSync(selfDocPath(root), 'utf8')
    assert.match(doc(), /外面说的第 2 句/)

    tamper(file)
    await h.call('possession', 'POST', { action: 'end', kept: true })
    assert.doesNotMatch(doc(), /外面说的第 2 句/, '这趟先不算了，文档里就不能还有')

    restore(file)
    const reviewed = await h.call('possession', 'POST', { action: 'review' })
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.json))
    assert.match(doc(), /外面说的第 2 句/, '复核捞回来了，文档也要跟上')
  } finally { done() }
})

test('GET 带回去的台账只有条数，没有整份 id 名单（issue #68）', async () => {
  {
    const { root, file, done } = setup()
    try {
      const h = harness(root)
      await goOut(root, file)
      writeTrip(file, { n: 3, homeToo: false })
      await h.call('outing', 'POST', { action: 'end', kept: false })
      assert.deepEqual((await readOutings(root)).outings[0].rejectedIds.length, 3, '台账本身还是存全量')
      const got = await h.call('outing', 'GET')
      const row = got.json.outings.at(-1)
      assert.ok(!('rejectedIds' in row) && !('pendingRejectedIds' in row), '最近几趟里不带名单')
      assert.equal(row.dropped, 3)
      assert.equal(row.held, 0)
    } finally { done() }
  }
  {
    const { root, file, done } = setup()
    try {
      const h = harness(root)
      await possess(root, file)
      writeTrip(file, { n: 2, homeToo: false })
      tamper(file)
      await h.call('possession', 'POST', { action: 'end', kept: true })
      const got = await h.call('possession', 'GET')
      for (const rec of [got.json.possessions.at(-1), got.json.pending]) {
        assert.ok(rec && !('rejectedIds' in rec) && !('pendingRejectedIds' in rec), '请神那边也不带名单')
        assert.equal(rec.held, 2)
      }
      assert.equal(got.json.pendingReview.checkable, true, '有基线的那趟核对得了')
    } finally { done() }
  }
})

// ---------------------------------------------------------------------------
// 第二轮：标记没写进去、0.9.5 留下的台账、复核认准卡上那一趟
// ---------------------------------------------------------------------------

/**
 * 让事件流写不进去：设成只读，再空追加一次试试。
 * 以 root 身份跑时只读拦不住，返回 false，那条测试跳过（不是假装过了）。
 */
function lockEvents(file) {
  chmodSync(file, 0o444)
  try { appendFileSync(file, '') } catch { return true }
  chmodSync(file, 0o644)
  return false
}
const unlockEvents = (file) => chmodSync(file, 0o644)

const tripsOf = async (root, path) =>
  path === 'outing' ? (await readOutings(root)).outings : (await readPossessions(root)).possessions

test('对不上、回家时「不算」的标记没写进去：复核时照人的选择补标，划掉的真的不算（issue #68）', async (t) => {
  for (const path of ['outing', 'possession']) {
    for (const pick of ['整趟不算', '划掉一条']) {
      const { root, file, done } = setup()
      try {
        const h = harness(root)
        if (path === 'outing') await goOut(root, file)
        else await possess(root, file)
        writeTrip(file, { homeToo: false })
        tamper(file)
        if (!lockEvents(file)) { t.skip('只读拦不住写入（以 root 身份跑？）'); return }
        const body = pick === '整趟不算' ? { kept: false, rejectedIds: [] } : { kept: true, rejectedIds: ['ev_out2'] }
        let ended
        try { ended = await h.call(path, 'POST', { action: 'end', ...body }) } finally { unlockEvents(file) }
        assert.equal(ended.status, 200, JSON.stringify(ended.json))
        assert.equal(ended.json.marked, false, `${path} ${pick}：标记确实没写进去`)
        assert.equal(ended.json.held, 0, `${path} ${pick}：一条也没先标掉，回执不能说「先全部跳过」`)
        const mid = await counted(root)
        assert.ok(mid.has('ev_out1') && mid.has('ev_out2'), `${path} ${pick}：标记没写进去，眼下就是照算（回执也这么说）`)
        const card = (await h.call(path, 'GET')).json.pendingReview
        assert.equal(card.unmarked, true, `${path} ${pick}：卡上要知道标记没写进去`)
        assert.equal(card.held, 0, `${path} ${pick}：卡上也不能说先标掉了几条`)

        restore(file)
        await takeNotes(root)
        const reviewed = await h.call(path, 'POST', { action: 'review' })
        assert.equal(reviewed.status, 200, JSON.stringify(reviewed.json))
        const after = await counted(root)
        const rec = (await tripsOf(root, path)).at(-1)
        if (pick === '整趟不算') {
          assert.equal(rec.status, 'rejected')
          assert.ok(!after.has('ev_out1') && !after.has('ev_out2'), `${path}：台账说整趟不算，派生里就得一条不算`)
        } else {
          assert.equal(rec.status, 'done')
          assert.equal(reviewed.json.rejected, 1)
          assert.ok(after.has('ev_out1'), `${path}：没划掉的照算`)
          assert.ok(!after.has('ev_out2'), `${path}：划掉的那条复核后真的不算`)
          assert.equal((await rejectNotes(root)).length, 1, `${path}：补上标记时把驳回的话讲给她听`)
        }
        assert.equal(rec.marked, true, `${path}：结完以后标记写全了`)
      } finally { unlockEvents(file); done() }
    }
  }
})

test('没对不上、回家时标记没写进去：这趟不落成算 / 不算，留在等复核，补写之后才结（issue #68）', async (t) => {
  for (const path of ['outing', 'possession']) {
    const { root, file, done } = setup()
    try {
      const h = harness(root)
      if (path === 'outing') await goOut(root, file)
      else await possess(root, file)
      writeTrip(file, { homeToo: false })
      await takeNotes(root)
      if (!lockEvents(file)) { t.skip('只读拦不住写入（以 root 身份跑？）'); return }
      let ended
      try { ended = await h.call(path, 'POST', { action: 'end', kept: false }) } finally { unlockEvents(file) }
      assert.equal(ended.status, 200, JSON.stringify(ended.json))
      assert.equal(ended.json.tampered, false)
      assert.equal(ended.json.marked, false)
      const rec = (await tripsOf(root, path)).at(-1)
      assert.equal(rec.status, 'pending', `${path}：标记没写进去，不能落成「这趟不算」——派生里照算，往后也没地方补`)
      assert.equal(rec.kept, null)
      assert.equal(rec.marked, false)
      assert.equal((await rejectNotes(root)).length, 0, `${path}：眼下还算着，不能跟她说「不算」`)

      // 卡上说清：记录对得上，只是标记没写进去；核对一次就补写。
      const got = await h.call(path, 'GET')
      const card = got.json.pendingReview
      assert.ok(card, `${path}：要有一张卡`)
      assert.equal(card.okNow, true)
      assert.equal(card.unmarked, true)
      assert.equal(card.held, 0)
      assert.equal(card.dropped, 2)
      assert.equal(card.autoRejected, true)
      assert.match(card.reason, /标记没写进去/)

      const reviewed = await h.call(path, 'POST', { action: 'review', sessionId: card.sessionId, startedAt: card.startedAt })
      assert.equal(reviewed.status, 200, JSON.stringify(reviewed.json))
      const done2 = (await tripsOf(root, path)).at(-1)
      assert.equal(done2.status, 'rejected')
      assert.equal(done2.kept, false)
      const after = await counted(root)
      assert.ok(!after.has('ev_out1') && !after.has('ev_out2'), `${path}：补写之后整趟不算`)
      const said = (await takeNotes(root)).map((n) => String(n.text ?? '')).filter((x) => x.includes('一条都不收'))
      assert.equal(said.length, 1, `${path}：补上标记时才跟她说这趟不收，只说一遍`)
    } finally { unlockEvents(file); done() }
  }
})

test('0.9.5 留下的出门 pending：划掉的名单先跟当年先标掉的取交集，从没标过的不算进条数（issue #68）', async () => {
  const { root, file, done } = setup()
  try {
    const h = harness(root)
    const snap = snapshotEvents(file)
    appendFileSync(file, line('ev_o1', iso(T0 + 60_000), 'refusal', '外面说的第 1 句：我不干这个', { sessionId: 's-out' }), 'utf8')
    appendFileSync(file, line('ev_o2', iso(T0 + 61_000), 'refusal', '外面说的第 2 句：我不干这个', { sessionId: 's-out' }), 'utf8')
    appendFileSync(file, line('ev_home', iso(T0 + 62_000), 'refusal', '家里说的一句：我不想洗碗', { sessionId: 's-home' }), 'utf8')
    appendFileSync(file, line('ev_m', iso(T0 + 70_000), 'meta', 'outing-reject:ev_o1 ev_o2', { source: 'system' }), 'utf8')
    // 0.9.5 的台账：没有 autoRejected、没有 marked；划掉的是在按时间取的清单上挑的，混着家里那条。
    writeFileSync(join(root, 'outings.json'), JSON.stringify({ version: OUTING_SCHEMA, outings: [{
      sessionId: 's-out', workspaceId: 'w1', workspaceName: '素材', cwd: join(root, 'ws'),
      startedAt: T0, endedAt: T0 + 80_000, status: 'pending', baseline: snap, kept: null, identity: '',
      rejectedIds: ['ev_o2', 'ev_home'], pendingRejectedIds: ['ev_o1', 'ev_o2'],
    }] }), 'utf8')

    const got = await h.call('outing', 'GET')
    assert.equal(got.json.pendingReview.held, 2)
    assert.equal(got.json.pendingReview.dropped, 1, '家里那条从没被标过，不能算进「你划掉的 N 条」')
    assert.equal(got.json.outings.at(-1).dropped, 1, '最近几趟里也按同一个口径数')

    await takeNotes(root)
    const reviewed = await h.call('outing', 'POST', { action: 'review' })
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.json))
    assert.equal(reviewed.json.rejected, 1)
    const said = (await rejectNotes(root)).join('\n')
    assert.match(said, /外面说的第 2 句/)
    assert.doesNotMatch(said, /一共/, '只划掉了一条，不能说「一共 2 条，挑出这几条说」')
    const after = await counted(root)
    assert.ok(after.has('ev_o1'), '没划掉的捞回来')
    assert.ok(!after.has('ev_o2'), '划掉的不算')
    assert.ok(after.has('ev_home'), '家里那条不是这趟的，这时也不替人标上')
    assert.deepEqual((await readOutings(root)).outings[0].rejectedIds, ['ev_o2'], '台账记下真正照办的那份')
  } finally { done() }
})

test('0.9.5 留下的请神 pending：一条标记都没写过，卡上照实说先标掉 0 条，核对后照常结（issue #68）', async () => {
  const { root, file, done } = setup()
  try {
    const h = harness(root)
    const snap = snapshotEvents(file)
    appendFileSync(file, line('ev_p1', iso(T0 + 60_000), 'refusal', '请神时说的一句', { sessionId: 's-p' }), 'utf8')
    writeFileSync(join(root, 'possessions.json'), JSON.stringify({ version: OUTING_SCHEMA, possessions: [{
      sessionId: 's-p', title: '一个对话', cwd: join(root, 'ws'),
      startedAt: T0, endedAt: T0 + 80_000, status: 'pending', baseline: snap, kept: null, identity: '',
    }] }), 'utf8')
    const got = await h.call('possession', 'GET')
    assert.equal(got.json.pendingReview.held, 0, '这趟一条也没先标掉')
    assert.equal(got.json.pendingReview.dropped, 0)
    assert.equal(got.json.pendingReview.unmarked, false, '老台账不知道写没写，不说成「没写进去」')
    assert.ok((await counted(root)).has('ev_p1'), '这趟写的一直算着')
    const reviewed = await h.call('possession', 'POST', { action: 'review' })
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.json))
    assert.equal(reviewed.json.possession.status, 'done')
    assert.ok((await counted(root)).has('ev_p1'))
  } finally { done() }
})

test('复核认准卡上那一趟：两趟都在等、两个复核带着同一张卡同时到，晚到的回 409，不把另一趟结掉（issue #68）', async () => {
  for (const path of ['outing', 'possession']) {
    const { root, done } = setup()
    try {
      const h = harness(root)
      // 「接着上次那条」：A、B 两趟指向同一条会话，都核对得过（没有基线）。卡上显示的是 B。
      const rec = (startedAt) => ({
        sessionId: 's-same', workspaceId: 'w1', workspaceName: '素材', title: '一个对话', cwd: join(root, 'ws'),
        startedAt, endedAt: startedAt + 60_000, status: 'pending', baseline: null, kept: null, identity: '',
        rejectedIds: [], pendingRejectedIds: [],
      })
      const key = path === 'outing' ? 'outings' : 'possessions'
      writeFileSync(join(root, `${key}.json`), JSON.stringify({ version: OUTING_SCHEMA, [key]: [rec(T0), rec(T0 + 3600_000)] }), 'utf8')
      const card = (await h.call(path, 'GET')).json.pendingReview
      assert.equal(card.startedAt, T0 + 3600_000, `${path}：卡上是最后那趟`)
      const body = { action: 'review', sessionId: card.sessionId, startedAt: card.startedAt }
      const both = await Promise.all([h.call(path, 'POST', body), h.call(path, 'POST', body)])
      assert.deepEqual(both.map((r) => r.status).sort(), [200, 409], `${path}：${JSON.stringify(both.map((r) => r.json))}`)
      const trips = await tripsOf(root, path)
      assert.equal(trips[0].status, 'pending', `${path}：A 的卡人还没看过，不能被晚到的那个结掉`)
      assert.equal(trips[1].status, 'done')
    } finally { done() }
  }
})

test('没有会话标记的老条目当家里的：宁可漏算，也不误伤家里那句（issue #68 第 7 条）', () => {
  const root = mkdtempSync(join(tmpdir(), 'fish-trip-nsid-'))
  try {
    const file = join(root, 'events.jsonl')
    appendFileSync(file, line('ev_home_old', iso(T0 + 30_000), 'refusal', '家里说的一句：我不想洗碗'), 'utf8')
    appendFileSync(file, line('ev_out', iso(T0 + 31_000), 'refusal', '外面说的一句：我不干这个', { sessionId: 's-out' }), 'utf8')
    const r = eventsSince(file, T0, { sessionId: 's-out', meta: false })
    assert.equal(r.ok, true)
    assert.deepEqual(r.items.map((x) => x.id), ['ev_out'], '只认这一趟那条会话写下的')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
