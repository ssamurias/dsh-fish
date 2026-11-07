/**
 * outing-pending.test.mjs —— 出门 / 请神回家时「算不算数」和界面说法对齐（issue #68）。
 *
 * 钉六件事：
 *   1. 对不上（pending）的那趟真的先不算数：事件流里有带趟次的 `*-pending:` 标记，
 *      deriveSelf 跳过这趟的条目；复核通过写 `*-settled:` 解除。
 *   2. 对不上时人划掉的（rejectedIds / 整趟不算）存进台账，复核通过时照它写 `*-reject:`。
 *   3. 回家清单只收这趟那条会话写的：家里同时记的 heard、seen、她在家认下的话不进来，
 *      「整趟不算」也扫不到它们。
 *   4. 「第几天」= tripDays + 1，出门当天就显示。
 *   5. 回家提示先看清单空不空；园区按工作区 id / 园区标题全等认。
 *   6. 两张「还没算数」卡的 okNow 用同一个判据。
 *   审查补的两件：一趟上百条时标记拆成几行写（schema 对每条事件卡 2000 字）；
 *   标记写完当场重写身份文档（她每轮读的是落盘的那份）。
 *
 * 假 ctx + 假 req/res，数据都在临时目录里。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, appendFileSync, mkdirSync, statSync, truncateSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { registerObserve, idMarkLines } from '../lib/observe.js'
import {
  eventsSince, passesReview, readOutings, readPossessions, snapshotEvents, startOuting, startPossession, endOuting, endPossession,
} from '../lib/outing.js'
import { deriveSelf } from '../lib/derive.js'
import { readEvents } from '../lib/store.js'
import { loadConfig } from '../lib/settings.js'
import { POCKET_TITLE, pocketDirPath } from '../lib/pocket.js'
import { refreshSelfDoc, selfDocPath } from '../lib/selfdoc.js'

const T0 = Date.parse('2026-10-29T00:10:00.000Z')
const NOW = Date.parse('2026-10-30T00:00:00.000Z')

const line = (id, ts, type, text, extra = {}) =>
  JSON.stringify({ id, v: 1, ts, day: 1, stage: 1, type, source: 'her', ...extra, text, refs: [], verdict: null, confidence: 0.5, flags: [] }) + '\n'

// 出门前那一行：改一个同样占 3 字节的字就是「原地改写」，改回来就算还原（后面追加的都留着）。
const BEFORE = line('ev_before', '2026-10-29T00:00:00.000Z', 'utterance', '在家的一句')
const tamper = (file) => writeFileSync(file, readFileSync(file, 'utf8').replace('在家的一句', '在家的一字'))
const restore = (file) => writeFileSync(file, readFileSync(file, 'utf8').replace('在家的一字', '在家的一句'))

function harness(root, { agents = [], registry = [] } = {}) {
  const routes = new Map()
  const agentMap = new Map(agents.map((a) => [String(a.session?.header?.id ?? ''), a]))
  const ctx = {
    get(name) {
      if (name === 'connection') return { requestRejection: () => null }
      if (name === 'webServer') return { register(ex) { routes.set(ex.path, ex.handler); return () => {} } }
      if (name === 'agents') return { get: (id) => agentMap.get(String(id ?? '')) ?? null, list: () => [...agentMap.values()] }
      if (name === 'workspaceRegistry') return { list: () => registry }
      return undefined
    },
  }
  registerObserve(ctx, { root })
  async function call(path, method, body) {
    const handler = routes.get(path)
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
  return {
    outing: (method, body) => call('/dsh-fish/outing', method, body),
    possession: (method, body) => call('/dsh-fish/possession', method, body),
  }
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'fish-pending-'))
  mkdirSync(join(root, 'home'), { recursive: true })
  const file = join(root, 'events.jsonl')
  writeFileSync(file, BEFORE, 'utf8')
  return { root, file, done: () => rmSync(root, { recursive: true, force: true }) }
}

async function goOut(root, file, sessionId = 'session-out') {
  await startOuting(root, {
    sessionId, workspaceId: 'w1', workspaceName: '素材', cwd: join(root, 'ws'),
    baseline: snapshotEvents(file), identity: '', now: T0,
  })
}

/** 这趟她在外面那条会话里写了一句话、一句拒绝。 */
function writeTrip(file, sessionId = 'session-out') {
  appendFileSync(file, line('ev_t1', '2026-10-29T00:11:00.000Z', 'utterance', '这趟学到的一句', { sessionId }))
  appendFileSync(file, line('ev_t2', '2026-10-29T00:12:00.000Z', 'refusal', '这件我不做', { sessionId }))
}

async function derived(root) {
  const { events } = await readEvents(root)
  const m = deriveSelf(events, { now: NOW })
  return { beliefs: m.beliefs.map((b) => b.id), refusals: m.refusals.map((r) => r.id) }
}

const metas = (file, prefix) => readFileSync(file, 'utf8').split('\n').filter(Boolean)
  .map((l) => { try { return JSON.parse(l) } catch { return null } })
  .filter((e) => e?.type === 'meta' && String(e.text).startsWith(prefix))
  .map((e) => String(e.text))

test('#68 出门：对不上的那趟真的先不算数，核对通过才算', async () => {
  const { root, file, done } = setup()
  try {
    await goOut(root, file)
    writeTrip(file)
    tamper(file)
    const h = harness(root)

    const ended = await h.outing('POST', { action: 'end', kept: true })
    assert.equal(ended.status, 200, JSON.stringify(ended.json))
    assert.equal(ended.json.tampered, true)
    assert.equal(ended.json.outing.status, 'pending')

    // 修之前这里两条都算：台账写着 pending，deriveSelf 却不读台账。
    assert.deepEqual(metas(file, 'outing-pending:'), [`outing-pending:session-out@${T0} ev_t1 ev_t2`], '标记要带趟次和这趟的条目')
    const pending = await derived(root)
    assert.ok(!pending.refusals.includes('ev_t2'), 'pending 期间这趟的拒绝不该长在她身上')
    assert.ok(!pending.beliefs.includes('ev_t1'), 'pending 期间这趟的话不该算进判断')
    assert.ok(pending.beliefs.includes('ev_before'), '出门前的不受影响')

    restore(file)
    const g = await h.outing('GET')
    assert.equal(g.json.pendingReview.okNow, true, '前面那段改回来、后面追加的都留着，就该能核对')
    const reviewed = await h.outing('POST', { action: 'review' })
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.json))
    assert.equal(reviewed.json.outing.status, 'done')
    assert.equal(reviewed.json.outing.kept, true)
    assert.deepEqual(metas(file, 'outing-settled:'), [`outing-settled:session-out@${T0}`])
    assert.deepEqual(metas(file, 'outing-reject:'), [], '这次没划掉什么，不该写驳回')
    const after = await derived(root)
    assert.ok(after.refusals.includes('ev_t2') && after.beliefs.includes('ev_t1'), '核对通过之后这趟照常算')
  } finally { done() }
})

test('#68 出门：对不上时划掉的几条存进台账，核对通过时照它不算', async () => {
  const { root, file, done } = setup()
  try {
    await goOut(root, file)
    writeTrip(file)
    tamper(file)
    const h = harness(root)

    const ended = await h.outing('POST', { action: 'end', kept: true, rejectedIds: ['ev_t2'] })
    assert.equal(ended.json.tampered, true)
    assert.deepEqual(metas(file, 'outing-reject:'), [], '还没结算，不先写驳回')
    const saved = (await readOutings(root)).outings.at(-1)
    assert.deepEqual(saved.choice, { kept: true, rejectedIds: ['ev_t2'], auto: false }, '人的选择要存下来，不能丢')
    assert.equal(saved.kept, null, '台账仍是「还没结算」')

    restore(file)
    const g = await h.outing('GET')
    assert.equal(g.json.pendingReview.kept, true)
    assert.equal(g.json.pendingReview.rejected, 1, '界面要知道核对通过时会照办几条')

    const reviewed = await h.outing('POST', { action: 'review' })
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.json))
    assert.equal(reviewed.json.rejected, 1)
    assert.equal(reviewed.json.outing.status, 'done')
    assert.deepEqual(metas(file, 'outing-reject:'), ['outing-reject:ev_t2'])
    const after = await derived(root)
    assert.ok(!after.refusals.includes('ev_t2'), '划掉的那条照样不算')
    assert.ok(after.beliefs.includes('ev_t1'), '没划掉的那条算')
  } finally { done() }
})

test('#68 出门：对不上时点「整趟不算」，核对通过时整趟不算', async () => {
  const { root, file, done } = setup()
  try {
    await goOut(root, file)
    writeTrip(file)
    tamper(file)
    const h = harness(root)

    const ended = await h.outing('POST', { action: 'end', kept: false })
    assert.equal(ended.json.tampered, true)
    assert.equal(ended.json.outing.status, 'pending')
    restore(file)
    const g = await h.outing('GET')
    assert.equal(g.json.pendingReview.kept, false)

    const reviewed = await h.outing('POST', { action: 'review' })
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.json))
    assert.equal(reviewed.json.outing.status, 'rejected')
    assert.equal(reviewed.json.outing.kept, false)
    assert.equal(reviewed.json.autoRejected, true)
    assert.deepEqual(metas(file, 'outing-reject:'), ['outing-reject:ev_t1 ev_t2'])
    const after = await derived(root)
    assert.ok(!after.refusals.includes('ev_t2') && !after.beliefs.includes('ev_t1'), '整趟都不算')
  } finally { done() }
})

test('#68 出门：家里同时记的账不进回家清单，「整趟不算」也扫不到', async () => {
  const { root, file, done } = setup()
  try {
    await goOut(root, file)
    writeTrip(file)
    // 出门期间家里照常：/say、侧栏记的 heard 与 seen，她在家里那条会话认下的话。
    appendFileSync(file, line('ev_heard', '2026-10-29T00:13:00.000Z', 'heard', '家里人说的一句', { source: 'system' }))
    appendFileSync(file, line('ev_seen', '2026-10-29T00:13:01.000Z', 'meta', 'seen:2026-10-29T00:13:01.000Z', { source: 'system' }))
    appendFileSync(file, line('ev_home', '2026-10-29T00:14:00.000Z', 'utterance', '在家里认下的一句', { sessionId: 'session-home' }))
    const h = harness(root)

    const g = await h.outing('GET')
    assert.deepEqual(g.json.away.since.items.map((it) => it.id), ['ev_t1', 'ev_t2'], '清单里只有外面那条会话写的')
    assert.equal(g.json.away.since.total, 2)

    const ended = await h.outing('POST', { action: 'end', kept: false })
    assert.equal(ended.json.rejected, 2)
    assert.deepEqual(metas(file, 'outing-reject:'), ['outing-reject:ev_t1 ev_t2'])
    const after = await derived(root)
    assert.ok(after.beliefs.includes('ev_home'), '家里那句不该跟着这趟一起被扫掉')
  } finally { done() }
})

test('#68 请神：对不上的那趟先不算数，结束时点的「整趟不算」核对通过时照办', async () => {
  const { root, file, done } = setup()
  try {
    await startPossession(root, { sessionId: 'session-talk', title: '一个对话', cwd: 'D:/别人的工作区', baseline: snapshotEvents(file), identity: '', now: T0 })
    writeTrip(file, 'session-talk')
    appendFileSync(file, line('ev_home', '2026-10-29T00:14:00.000Z', 'utterance', '在家里认下的一句', { sessionId: 'session-home' }))
    const h = harness(root)

    const g0 = await h.possession('GET')
    assert.deepEqual(g0.json.since.items.map((it) => it.id), ['ev_t1', 'ev_t2'], '请神清单也只收被上身那条会话写的')

    tamper(file)
    const ended = await h.possession('POST', { action: 'end', sessionId: 'session-talk', kept: false })
    assert.equal(ended.status, 200, JSON.stringify(ended.json))
    assert.equal(ended.json.tampered, true)
    assert.equal(ended.json.possession.status, 'pending')
    assert.deepEqual(metas(file, 'possess-pending:'), [`possess-pending:session-talk@${T0} ev_t1 ev_t2`])
    assert.deepEqual(metas(file, 'possess-reject:'), [])
    const pending = await derived(root)
    assert.ok(!pending.refusals.includes('ev_t2') && !pending.beliefs.includes('ev_t1'), 'pending 期间这趟不算')
    assert.ok(pending.beliefs.includes('ev_home'))

    restore(file)
    const g = await h.possession('GET')
    assert.equal(g.json.pendingReview.okNow, true)
    assert.equal(g.json.pendingReview.kept, false)
    const reviewed = await h.possession('POST', { action: 'review' })
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.json))
    assert.equal(reviewed.json.possession.status, 'rejected')
    assert.deepEqual(metas(file, 'possess-reject:'), ['possess-reject:ev_t1 ev_t2'])
    assert.deepEqual(metas(file, 'possess-settled:'), [`possess-settled:session-talk@${T0}`])
    const after = await derived(root)
    assert.ok(!after.refusals.includes('ev_t2') && !after.beliefs.includes('ev_t1'), '照结束时选的，整趟不算')
    assert.ok(after.beliefs.includes('ev_home'), '家里那句仍然算')
    const { possessions } = await readPossessions(root)
    assert.equal(possessions.at(-1).kept, false)
  } finally { done() }
})

test('#68 事件流被截在半行上：先不算数的标记仍是完整的一行', async () => {
  const { root, file, done } = setup()
  try {
    await goOut(root, file)
    writeTrip(file)
    tamper(file)
    truncateSync(file, statSync(file).size - 7) // 再截掉最后一行的尾巴，文件不以换行结尾
    const h = harness(root)
    const ended = await h.outing('POST', { action: 'end', kept: true })
    assert.equal(ended.json.tampered, true)
    const { events } = await readEvents(root)
    assert.ok(events.some((e) => e.type === 'meta' && String(e.text).startsWith('outing-pending:session-out@')),
      '标记不能和那半行粘在一起读不出来')
  } finally { done() }
})

test('#68 deriveSelf：pending 按趟次配对，解除一趟不会放出另一趟', () => {
  const ev = (id, ts, type, text) => JSON.parse(line(id, ts, type, text))
  const base = [
    ev('ev_a', '2026-10-29T00:01:00.000Z', 'refusal', 'a'),
    ev('ev_b', '2026-10-29T00:02:00.000Z', 'refusal', 'b'),
    ev('ev_m1', '2026-10-29T00:03:00.000Z', 'meta', 'outing-pending:s1@1 ev_a'),
    ev('ev_m2', '2026-10-29T00:04:00.000Z', 'meta', 'possess-pending:s2@2 ev_b'),
  ]
  assert.deepEqual(deriveSelf(base, { now: NOW }).refusals.map((r) => r.id), [])
  const one = [...base, ev('ev_m3', '2026-10-29T00:05:00.000Z', 'meta', 'outing-settled:s1@1')]
  assert.deepEqual(deriveSelf(one, { now: NOW }).refusals.map((r) => r.id), ['ev_a'], '只放出解除的那一趟')
  // 前缀也要对得上：出门的解除放不出请神那趟。
  const wrong = [...base, ev('ev_m4', '2026-10-29T00:05:00.000Z', 'meta', 'outing-settled:s2@2')]
  assert.deepEqual(deriveSelf(wrong, { now: NOW }).refusals.map((r) => r.id), [])
})

test('#68 eventsSince：给了会话 id 只收那条会话写的，空串一条不收，不给是老口径', () => {
  const { file, done } = setup()
  try {
    writeTrip(file, 'session-out')
    appendFileSync(file, line('ev_x', '2026-10-29T00:13:00.000Z', 'heard', '没会话的一句', { source: 'system' }))
    assert.deepEqual(eventsSince(file, T0, { sessionId: 'session-out' }).items.map((it) => it.id), ['ev_t1', 'ev_t2'])
    assert.equal(eventsSince(file, T0, { sessionId: '' }).total, 0, '还没绑上会话的那趟，她什么都写不了')
    assert.equal(eventsSince(file, T0).total, 3, '不给会话 id 时仍只按时间')
  } finally { done() }
})

test('#68 两张「还没算数」卡用同一个判据：核对不了时都能点「核对一次」', async () => {
  const { root, done } = setup()
  try {
    // 没有基线的 pending（正常流程造不出来，坏档或手改台账会有）：两边的后端都会收下，界面不能只灰掉一边。
    await startOuting(root, { sessionId: 'session-o', workspaceId: 'w1', workspaceName: '素材', cwd: join(root, 'ws'), baseline: null, identity: '', now: T0 })
    await endOuting(root, { sessionId: 'session-o', status: 'pending', kept: null, now: T0 + 60_000 })
    await startPossession(root, { sessionId: 'session-p', title: '对话', cwd: 'D:/x', baseline: null, identity: '', now: T0 + 120_000 })
    await endPossession(root, { sessionId: 'session-p', status: 'pending', kept: null, now: T0 + 180_000 })
    const h = harness(root)
    const o = await h.outing('GET')
    const p = await h.possession('GET')
    assert.equal(o.json.pendingReview.okNow, true)
    assert.equal(p.json.pendingReview.okNow, true)
    assert.equal(o.json.pendingReview.kept, true, '#68 之前就 pending、没存选择的那趟，照旧当作收下')

    assert.equal(passesReview({ ok: true, checkable: true }), true)
    assert.equal(passesReview({ ok: null, checkable: false }), true)
    assert.equal(passesReview({ ok: false, checkable: true }), false)
  } finally { done() }
})

test('#68 回家提示认园区：按工作区 id 或园区标题全等，不拿名字猜', async () => {
  const { root, file, done } = setup()
  try {
    const { config } = await loadConfig(root)
    const registry = [{ id: 'ws-pocket', path: pocketDirPath(config), title: '改过名的园区' }]

    await startOuting(root, { sessionId: 'session-a', workspaceId: 'ws-pocket', workspaceName: '改过名的园区', cwd: pocketDirPath(config), baseline: snapshotEvents(file), identity: '', now: T0 })
    assert.equal((await harness(root, { registry }).outing('GET')).json.away.atPocket, true, '登记的园区 id 对得上')
    await endOuting(root, { status: 'done', kept: true })

    await startOuting(root, { sessionId: 'session-b', workspaceId: '', workspaceName: POCKET_TITLE, cwd: join(root, 'p'), baseline: snapshotEvents(file), identity: '', now: T0 + 1 })
    assert.equal((await harness(root).outing('GET')).json.away.atPocket, true, '园区没登记成工作区时认标题')
    await endOuting(root, { status: 'done', kept: true })

    await startOuting(root, { sessionId: 'session-c', workspaceId: 'w2', workspaceName: '我的园区笔记', cwd: join(root, 'w2'), baseline: snapshotEvents(file), identity: '', now: T0 + 2 })
    assert.equal((await harness(root, { registry }).outing('GET')).json.away.atPocket, false, '名字里带「园区」的普通工作区不是园区')
  } finally { done() }
})

test('#68 界面：pending 看 r.tampered、第几天 +1、先判清单空不空、两张卡共用一套说法', () => {
  const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.ok(!client.includes("r?.status === 'pending'"), 'end 的响应没有顶层 status，判它永远落空')
  assert.ok(client.includes("r?.tampered || r?.outing?.status === 'pending'"))
  assert.ok(!client.includes('awayNowUI.tripDays > 0'), '出门当天也要显示第几天')
  assert.ok(client.includes('这趟出门已经第 ${(Number(awayNowUI.tripDays) || 0) + 1} 天了。'))
  assert.ok(!client.includes('/(口袋|园区)/.test('), '园区不再拿名字猜')
  const hint = client.indexOf('(awayNowUI.since?.total ?? 0) === 0')
  const pocket = client.indexOf('awayNowUI.atPocket')
  assert.ok(hint > 0 && pocket > hint, '先判清单空不空，再分园区')
  assert.equal(client.split('pendingOkText(').length - 1, 3, '出门、请神两张卡都用同一句（加上定义一共三处）')
  assert.ok(!/他/.test(client.slice(client.indexOf('function pendingChoiceText'), client.indexOf('async function doEndOuting'))), '新文案不出现「他」')
})

// ---- 审查补的：一趟上百条（schema 对每条事件卡 2000 字） ----

// 真机上的会话 id 是 UUID 形状，条目 id 是 29 字的 ULID：原来一行塞到 65 条就被 TOO_LONG 整条拒掉。
const BIG_SID = 'session-0b9c6f0e-1d2a-4c3b-9e8f-123456789abc'
const bigId = (i) => 'ev_01JBTRIP00' + String(i).padStart(16, '0')

/** 这趟她在外面写了 n 条：一半是话，一半是拒绝。 */
function writeBigTrip(file, n, sessionId = BIG_SID) {
  const ids = []
  for (let i = 0; i < n; i += 1) {
    const id = bigId(i)
    const ts = new Date(T0 + 60_000 + i * 1000).toISOString()
    appendFileSync(file, i % 2
      ? line(id, ts, 'refusal', `第 ${i} 件我不做`, { sessionId })
      : line(id, ts, 'utterance', `这趟学到的第 ${i} 句`, { sessionId }))
    ids.push(id)
  }
  return ids
}

const allMarks = (file, prefix) => readFileSync(file, 'utf8').split('\n').filter(Boolean)
  .map((l) => { try { return JSON.parse(l) } catch { return null } })
  .filter((e) => e?.type === 'meta' && String(e.text).startsWith(prefix))

async function countedOf(root, ids) {
  const d = await derived(root)
  const got = new Set([...d.beliefs, ...d.refusals])
  return ids.filter((id) => got.has(id)).length
}

test('#68 审查：标记按行拆开，每行都塞得进 schema，拆开后一个 id 不丢', () => {
  const ids = Array.from({ length: 237 }, (_, i) => bigId(i))
  const head = `outing-pending:${BIG_SID}@${T0} `
  const lines = idMarkLines(head, ids)
  assert.ok(lines.length > 1, '两百多条一行写不下')
  for (const l of lines) {
    assert.ok(l.length <= 2000, `每行都要过 schema 的 2000 字：${l.length}`)
    assert.ok(l.startsWith(head), '每行都带同一个趟次')
  }
  assert.deepEqual(lines.flatMap((l) => l.slice(head.length).split(' ')), ids)
  assert.deepEqual(idMarkLines('outing-reject:', ['ev_a', 'ev_b']), ['outing-reject:ev_a ev_b'], '少的时候还是一行，样子不变')
  assert.deepEqual(idMarkLines('outing-reject:', []), [], '没有要驳回的就不写')
  assert.deepEqual(idMarkLines('outing-pending:s@1 ', [], { always: true }), ['outing-pending:s@1'], 'pending 没条目也留一行')
  assert.deepEqual(idMarkLines('outing-reject:', ['ev_a', 'ev b', 'ev,c', 'x'.repeat(3000), '', 'ev_d']), ['outing-reject:ev_a ev_d'],
    '拆不回原样的、自己就塞不满一行的不写')
})

test('#68 审查：一趟上百条对不上时 pending 全部先不算；整趟不算的，复核回 200、全都不算', async () => {
  const { root, file, done } = setup()
  try {
    await goOut(root, file, BIG_SID)
    const ids = writeBigTrip(file, 130)
    tamper(file)
    const h = harness(root)

    const ended = await h.outing('POST', { action: 'end', kept: false })
    assert.equal(ended.status, 200, JSON.stringify(ended.json))
    assert.equal(ended.json.tampered, true)
    const pend = allMarks(file, 'outing-pending:')
    assert.ok(pend.length > 1, '一行塞不下，要拆开写')
    assert.ok(pend.every((e) => String(e.text).startsWith(`outing-pending:${BIG_SID}@${T0} `)))
    // 修之前：65 条以上 pending 标记整条写不进去，这趟照样全算。
    assert.equal(await countedOf(root, ids), 0, 'pending 期间这趟一条都不算')

    restore(file)
    const reviewed = await h.outing('POST', { action: 'review' })
    // 修之前：outing-reject: 一行塞 130 个 id，次次 TOO_LONG，回 500，永远卡在 pending。
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.json))
    assert.equal(reviewed.json.outing.status, 'rejected')
    assert.equal(reviewed.json.rejected, 130)
    assert.ok(allMarks(file, 'outing-reject:').length > 1)
    assert.equal(await countedOf(root, ids), 0, '照回家时选的，整趟都不算')
    const saved = (await readOutings(root)).outings.at(-1)
    assert.equal(saved.choice, undefined, '结算之后台账上不再留着回家时的选择')
  } finally { done() }
})

test('#68 审查：一趟上百条对不上、这趟算数，复核之后全部算', async () => {
  const { root, file, done } = setup()
  try {
    await goOut(root, file, BIG_SID)
    const ids = writeBigTrip(file, 130)
    tamper(file)
    const h = harness(root)
    const ended = await h.outing('POST', { action: 'end', kept: true })
    assert.equal(ended.json.tampered, true)
    assert.equal(await countedOf(root, ids), 0, 'pending 期间这趟一条都不算')
    restore(file)
    const reviewed = await h.outing('POST', { action: 'review' })
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.json))
    assert.equal(reviewed.json.outing.status, 'done')
    assert.equal(await countedOf(root, ids), 130, '复核通过，这趟全都算')
  } finally { done() }
})

test('#68 审查：没对不上时点「整趟不算」，上百条也都标得上（出门、请神）', async () => {
  const { root, file, done } = setup()
  try {
    await goOut(root, file, BIG_SID)
    const outIds = writeBigTrip(file, 130)
    const h = harness(root)
    const ended = await h.outing('POST', { action: 'end', kept: false })
    assert.equal(ended.status, 200, JSON.stringify(ended.json))
    assert.equal(ended.json.tampered, false)
    assert.equal(ended.json.outing.status, 'rejected')
    // 修之前（基线代码就这样）：一行写不进去，只记一行 warn，台账却写着 rejected。
    assert.equal(await countedOf(root, outIds), 0, '说了不算就真的一条都不算')

    const talk = 'session-7d1e2f3a-4b5c-4d6e-8f70-0123456789ab'
    const PT = T0 + 3_600_000
    await startPossession(root, { sessionId: talk, title: '一个对话', cwd: 'D:/别人的工作区', baseline: snapshotEvents(file), identity: '', now: PT })
    const pIds = []
    for (let i = 0; i < 130; i += 1) {
      const id = 'ev_01JBTALK00' + String(i).padStart(16, '0')
      appendFileSync(file, line(id, new Date(PT + 60_000 + i * 1000).toISOString(), 'refusal', `请神时第 ${i} 件不做`, { sessionId: talk }))
      pIds.push(id)
    }
    const pe = await h.possession('POST', { action: 'end', sessionId: talk, kept: false })
    assert.equal(pe.status, 200, JSON.stringify(pe.json))
    assert.equal(pe.json.possession.status, 'rejected')
    assert.ok(allMarks(file, 'possess-reject:').length > 1)
    assert.equal(await countedOf(root, pIds), 0)
  } finally { done() }
})

test('#68 审查：请神上百条对不上、整趟不算，复核回 200、全都不算', async () => {
  const { root, file, done } = setup()
  try {
    await startPossession(root, { sessionId: BIG_SID, title: '一个对话', cwd: 'D:/别人的工作区', baseline: snapshotEvents(file), identity: '', now: T0 })
    const ids = writeBigTrip(file, 130)
    tamper(file)
    const h = harness(root)
    const ended = await h.possession('POST', { action: 'end', sessionId: BIG_SID, kept: false })
    assert.equal(ended.status, 200, JSON.stringify(ended.json))
    assert.equal(ended.json.tampered, true)
    assert.ok(allMarks(file, 'possess-pending:').length > 1)
    assert.equal(await countedOf(root, ids), 0, 'pending 期间这趟一条都不算')
    restore(file)
    const reviewed = await h.possession('POST', { action: 'review' })
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.json))
    assert.equal(reviewed.json.possession.status, 'rejected')
    assert.equal(await countedOf(root, ids), 0)
    const { possessions } = await readPossessions(root)
    assert.equal(possessions.at(-1).choice, undefined, '结算之后台账上不再留着结束时的选择')
  } finally { done() }
})

// ---- 审查补的：她读的是落盘的身份文档 ----

test('#68 审查：pending 那趟当场从身份文档里下去，复核通过当场回来（出门）', async () => {
  const { root, file, done } = setup()
  try {
    await goOut(root, file)
    appendFileSync(file, line('ev_z1', '2026-10-29T00:11:00.000Z', 'utterance', '外面学到的ZZQ这一句', { sessionId: 'session-out' }))
    // 她在外面 growth_commit 时会重写身份文档：回家那一刻文档里已经有这趟的话了。
    await refreshSelfDoc(root)
    const doc = () => readFileSync(selfDocPath(root), 'utf8')
    assert.ok(doc().includes('ZZQ'), '前提：出门时写的话已经进了身份文档')
    tamper(file)
    const h = harness(root)
    const ended = await h.outing('POST', { action: 'end', kept: true })
    assert.equal(ended.json.tampered, true)
    assert.ok(!doc().includes('ZZQ'), 'pending 期间她读到的身份里不该还有这趟的话')
    restore(file)
    const reviewed = await h.outing('POST', { action: 'review' })
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.json))
    assert.ok(doc().includes('ZZQ'), '复核通过就回到身份文档里，不等下一次别的东西触发')
  } finally { done() }
})

test('#68 审查：划掉的那条当场从身份文档里下去（请神、没对不上）', async () => {
  const { root, file, done } = setup()
  try {
    await startPossession(root, { sessionId: 'session-talk', title: '一个对话', cwd: 'D:/别人的工作区', baseline: snapshotEvents(file), identity: '', now: T0 })
    appendFileSync(file, line('ev_z1', '2026-10-29T00:11:00.000Z', 'utterance', '请神时学到的ZZQ这一句', { sessionId: 'session-talk' }))
    await refreshSelfDoc(root)
    const doc = () => readFileSync(selfDocPath(root), 'utf8')
    assert.ok(doc().includes('ZZQ'), '前提：请神时写的话已经进了身份文档')
    const h = harness(root)
    const ended = await h.possession('POST', { action: 'end', sessionId: 'session-talk', kept: true, rejectedIds: ['ev_z1'] })
    assert.equal(ended.status, 200, JSON.stringify(ended.json))
    assert.equal(ended.json.tampered, false)
    assert.ok(!doc().includes('ZZQ'), '划掉的那条不该还留在她读到的身份里')
  } finally { done() }
})
