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
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, appendFileSync, truncateSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { registerObserve } from '../lib/observe.js'
import { deriveSelf } from '../lib/derive.js'
import { readEvents } from '../lib/store.js'
import { writeSelfDoc, selfDocPath } from '../lib/selfdoc.js'
import { loadConfig } from '../lib/settings.js'
import { pocketDirPath } from '../lib/pocket.js'
import {
  snapshotEvents, startOuting, startPossession, readOutings, readPossessions,
  settlePending, OUTING_SCHEMA,
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
