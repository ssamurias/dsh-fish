/**
 * outing-route.test.mjs —— 出门页那两条 HTTP 接口，端到端跑一遍（0.6.32）。
 *
 * 之前只有库层测试：`pendingOf` / `settlePending` 都对，但「点完按钮什么都没发生」
 * 恰恰是**接口与界面**之间的问题。所以这里不测函数，测路由：
 *   1. 出门中 → GET 不带 pendingReview
 *   2. 把事件流截短 → POST end → 200 且台账变 pending（不是直接 done）
 *   3. GET → pendingReview 在，okNow=false，reason 说清了为什么
 *   4. 还没还原就 POST review → 409，而且台账**仍然**是 pending
 *   5. 还原 → POST review → 200 且变 done，endedAt 还是原来那一刻
 *   6. 再 POST review → 409「没有等复核的那趟」
 *
 * 用的是假 ctx + 假 req/res，不碰真实家目录。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, truncateSync } from 'node:fs'
import { tmpdir, EOL } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { registerObserve } from '../lib/observe.js'
import { snapshotEvents, startOuting, readOutings } from '../lib/outing.js'

function harness(root, { agents = {} } = {}) {
  const routes = new Map()
  const ctx = {
    get(name) {
      if (name === 'connection') return { requestRejection: () => null }
      if (name === 'agents') {
        return {
          get: (id) => agents[id] ?? null,
          list: () => Object.values(agents),
        }
      }
      if (name === 'webServer') {
        return {
          register(ex) {
            routes.set(ex.path, ex.handler)
            return () => {}
          },
        }
      }
      return undefined
    },
  }
  registerObserve(ctx, { root })
  const handler = routes.get('/dsh-fish/outing')
  assert.ok(handler, '出门路由要注册上')

  async function call(method, body) {
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

test('/outing 复核：接口层把 pending 从「死路」走通（0.6.32）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fish-outing-route-'))
  try {
    const eventsFile = join(root, 'events.jsonl')
    const original = '{"type":"utterance","seq":1,"ts":"2026-10-29T00:00:00.000Z","data":{"text":"在家"}}\n'
    writeFileSync(eventsFile, original)
    const baseline = snapshotEvents(eventsFile)
    const startedAt = Date.parse('2026-10-29T00:10:00.000Z')
    await startOuting(root, {
      sessionId: 'session-r1',
      workspaceId: 'w1',
      workspaceName: '素材',
      cwd: join(root, 'ws'),
      baseline,
      identity: '',
      now: startedAt,
    })
    const { call } = harness(root)

    // 1. 出门中：没有等复核的
    const before = await call('GET')
    assert.equal(before.status, 200)
    assert.equal(before.json.pendingReview, null, '还在外面时不该有 pendingReview')
    assert.equal(before.json.away?.sessionShort, 'r1', 'GET 要把会话短号带上')
    assert.equal(before.json.away?.tripNo, 1)

    // 2. 截短事件流，再点「这趟算数」
    truncateSync(eventsFile, Math.max(0, statSync(eventsFile).size - 20))
    const ended = await call('POST', { action: 'end', kept: true })
    assert.equal(ended.status, 200)
    assert.equal(ended.json.tampered, true, '变短必须判成对不上')
    assert.equal(ended.json.outing.status, 'pending', '不许直接 done')

    // 3. GET 现在要把原因与「还不能复核」告诉界面
    const mid = await call('GET')
    assert.ok(mid.json.pendingReview, 'pending 之后 GET 必须带回 pendingReview')
    assert.equal(mid.json.pendingReview.sessionId, 'session-r1')
    assert.equal(mid.json.pendingReview.okNow, false)
    assert.match(String(mid.json.pendingReview.reason), /短了/)
    assert.equal(mid.json.away?.kind, null, 'pending 之后不再是 active，界面要按 kind 判「在家」')

    // 4. 还没还原就点「复核一次」：拒绝，而且台账不能被动
    const refused = await call('POST', { action: 'review' })
    assert.equal(refused.status, 409)
    assert.match(String(refused.json.why), /短了/)
    const stillPending = (await readOutings(root)).outings.at(-1)
    assert.equal(stillPending.status, 'pending', '复核没过不能偷偷改台账')

    // 5. 还原 → 复核通过 → 收下，结束时间仍是真正回家的那一刻
    writeFileSync(eventsFile, original)
    const ok = await call('POST', { action: 'review' })
    assert.equal(ok.status, 200)
    assert.equal(ok.json.outing.status, 'done')
    assert.equal(ok.json.outing.kept, true)
    assert.equal(ok.json.outing.endedAt, ended.json.outing.endedAt, 'endedAt 不能被复核时间覆盖')

    // 6. 再点一次：没有等复核的了
    const again = await call('POST', { action: 'review' })
    assert.equal(again.status, 409)
    assert.match(String(again.json.why), /没有等着核对/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('/outing 复核：GET 的 warning 能指出「这趟没挂上装备」（0.6.26 幽灵出门的可见性）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fish-outing-route-'))
  try {
    const eventsFile = join(root, 'events.jsonl')
    writeFileSync(eventsFile, '')
    await startOuting(root, {
      sessionId: 'session-r2',
      workspaceId: 'w1',
      workspaceName: '素材',
      cwd: join(root, 'ws'),
      baseline: snapshotEvents(eventsFile),
      identity: '',
      now: Date.now(),
    })
    const { call } = harness(root)
    const got = await call('GET')
    assert.equal(got.status, 200)
    // 假 ctx 里没有活的 agent，所以「没挂装备」要说出来，别让人以为一切正常
    assert.equal(got.json.away?.equipped, false)
    assert.match(String(got.json.away?.warning), /没接好/)
    assert.equal(readFileSync(eventsFile, 'utf8'), '', 'GET 只读，不该写事件流')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// 0.7.4（用户 m00659 A）：「这趟不算数」必须真的不算数。
// 病根：0.6.12 起 kept=false 只把台账写成 rejected，而 deriveSelf 压根不读台账，
// 它只认 meta 里的 outing-reject: —— 于是「不算数」是一条都不跳过的空操作（真机三趟都是）。
test('/outing 回家：点「这趟不算数」会把这一趟写下的条目全部标上', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fish-outing-route-'))
  try {
    const eventsFile = join(root, 'events.jsonl')
    // 这趟写下的条目带会话 id（没带的按家里的处理，#68 第 7 条）。
    const line = (id, ts, type, text, sid) => JSON.stringify({ id, v: 1, ts, day: 1, stage: 1, type, source: 'her', text, refs: [], verdict: null, confidence: 0.5, flags: [], ...(sid ? { sessionId: sid } : {}) }) + '\n'
    // 出门前一条；这趟写三条，其中一条是 meta 记账（不该被一起抹掉）
    const before = line('ev_before', '2026-10-29T00:00:00.000Z', 'utterance', '出门前')
    writeFileSync(eventsFile, before)
    const baseline = snapshotEvents(eventsFile)
    const startedAt = Date.parse('2026-10-29T00:10:00.000Z')
    await startOuting(root, {
      sessionId: 'session-a1',
      workspaceId: 'w1',
      workspaceName: '素材',
      cwd: join(root, 'ws'),
      baseline,
      identity: '',
      now: startedAt,
    })
    writeFileSync(eventsFile, before + [
      line('ev_t1', '2026-10-29T00:11:00.000Z', 'utterance', '这趟第一句', 'session-a1'),
      line('ev_t2', '2026-10-29T00:12:00.000Z', 'refusal', '这句我不认', 'session-a1'),
      line('ev_t3', '2026-10-29T00:13:00.000Z', 'meta', 'diary:2026-10-29', 'session-a1'),
    ].join(''))
    const { call } = harness(root)

    const ended = await call('POST', { action: 'end', kept: false })
    assert.equal(ended.status, 200, JSON.stringify(ended.json))
    assert.equal(ended.json.outing.status, 'rejected')
    assert.equal(ended.json.outing.kept, false)
    assert.equal(ended.json.autoRejected, true, '没逐条挑 + 说了不算数 → 自动整趟不算')
    // 只有她写下的两条成长事件被标；记账 meta 不进（跳掉它会让冷落/日记趟次统计失真）
    assert.equal(ended.json.rejected, 2, '这趟她写下的两条成长事件要全部标上')

    const raw = readFileSync(eventsFile, 'utf8')
    const marks = raw.split('\n').filter((l) => l.includes('outing-reject'))
    assert.equal(marks.length, 1, '只追加一条标记，不删任何原文')
    const ids = String(JSON.parse(marks[0]).text).slice('outing-reject:'.length).split(' ')
    assert.deepEqual([...ids].sort(), ['ev_t1', 'ev_t2'])
    assert.ok(!ids.includes('ev_before'), '出门前的那条不能被算进这一趟')

    // 真正的验收：deriveSelf 里这趟一条都不算
    const { deriveSelf } = await import('../lib/derive.js')
    const { readEvents } = await import('../lib/store.js')
    const { events } = await readEvents(root)
    const m = deriveSelf(events)
    assert.equal(m.refusals.length, 0, '整趟不算之后，这趟的拒绝不该长在她身上')
    assert.ok(!m.refusals.some((r) => r.id === 'ev_t2'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// 反向：逐条取消勾选（没点「整趟不算数」）仍然只跳过被挑中的那几条。
test('/outing 回家：逐条取消勾选只跳被挑中的，不该变成整趟不算', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fish-outing-route-'))
  try {
    const eventsFile = join(root, 'events.jsonl')
    // 这趟写下的条目带会话 id（没带的按家里的处理，#68 第 7 条）。
    const line = (id, ts, type, text, sid) => JSON.stringify({ id, v: 1, ts, day: 1, stage: 1, type, source: 'her', text, refs: [], verdict: null, confidence: 0.5, flags: [], ...(sid ? { sessionId: sid } : {}) }) + '\n'
    writeFileSync(eventsFile, line('ev_before', '2026-10-29T00:00:00.000Z', 'utterance', '出门前'))
    await startOuting(root, {
      sessionId: 'session-a2',
      workspaceId: 'w1',
      workspaceName: '素材',
      cwd: join(root, 'ws'),
      baseline: snapshotEvents(eventsFile),
      identity: '',
      now: Date.parse('2026-10-29T00:10:00.000Z'),
    })
    writeFileSync(eventsFile, readFileSync(eventsFile, 'utf8') + line('ev_u1', '2026-10-29T00:11:00.000Z', 'utterance', '留下的那句', 'session-a2') + line('ev_u2', '2026-10-29T00:12:00.000Z', 'utterance', '不要的那句', 'session-a2'))
    const { call } = harness(root)

    const ended = await call('POST', { action: 'end', kept: true, rejectedIds: ['ev_u2'] })
    assert.equal(ended.status, 200, JSON.stringify(ended.json))
    assert.equal(ended.json.autoRejected, false, '逐条挑的时候不该自动扩成整趟')
    assert.equal(ended.json.rejected, 1)
    const raw = readFileSync(eventsFile, 'utf8')
    const mark = raw.split('\n').find((l) => l.includes('outing-reject'))
    assert.equal(String(JSON.parse(mark).text), 'outing-reject:ev_u2', '只标被挑中的那条')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// 新用户第一次点进门页（2026-10-30，用户 m01904）：说明卡没确认过时三个入口按钮先灰着。
// 这里只测服务端那一半：ack 默认 false、点一次落进配置、之后 GET 带回 true。
test('/outing 确认门：ack 默认 false，点一次才写进配置', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fish-outing-route-'))
  try {
    writeFileSync(join(root, 'events.jsonl'),
      '{"id":"ev_home","v":1,"ts":"2026-10-29T00:00:00.000Z","day":1,"stage":1,"type":"utterance","source":"her","text":"在家","refs":[],"verdict":null,"confidence":0.5,"flags":[]}\n')
    const { call } = harness(root)

    const before = await call('GET')
    assert.equal(before.status, 200)
    assert.equal(before.json.ack, false, '没确认过时必须 false，界面靠它灰按钮')

    const acked = await call('POST', { action: 'ack' })
    assert.equal(acked.status, 200)
    assert.equal(acked.json.ok, true)

    const after = await call('GET')
    assert.equal(after.json.ack, true, '点过之后 GET 要带回 true')

    const { loadConfig } = await import('../lib/settings.js')
    const { config } = await loadConfig(root)
    assert.equal(config.outing.ack, true, '确认要落盘，重启之后不再问')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// 2026-10-30（用户 m03179 真机）：回家后工作园区那条会话还以「大肥鱼」的身份说话。
// 根因：回家只拆挂载（detachOutside），没往那条会话补交接句——请神路径补过，出门漏了。
test('/outing 回家：把「这一段结束了」写回那条会话（2026-10-30 用户 m03179）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fish-outing-route-'))
  try {
    const eventsFile = join(root, 'events.jsonl')
    writeFileSync(eventsFile, JSON.stringify({ type: 'utterance', seq: 1, ts: '2026-10-29T00:00:00.000Z', data: { text: '在家' } }) + EOL)
    const baseline = snapshotEvents(eventsFile)
    const startedAt = Date.parse('2026-10-29T00:10:00.000Z')
    await startOuting(root, {
      sessionId: 'session-out',
      workspaceId: 'w9',
      workspaceName: '工作园区',
      cwd: join(root, 'ws'),
      baseline,
      identity: '',
      now: startedAt,
    })
    const appended = []
    const agent = {
      session: {
        header: { id: 'session-out' },
        append: (type, payload) => { appended.push({ type, payload }) },
      },
    }
    const h = harness(root, { agents: { 'session-out': agent } })
    const ended = await h.call('POST', { action: 'end', kept: true })
    assert.equal(ended.status, 200, JSON.stringify(ended.json))
    assert.equal(appended.length, 1, '只能补一条交接句，不能多插')
    assert.equal(appended[0].type, 'user/message', '这条要进模型看得见的上下文')
    assert.equal(appended[0].payload.role, 'user')
    const said = String(appended[0].payload.content[0].text)
    assert.match(said, /出门结束/, '先说明这一段结束了')
    assert.match(said, /工作园区/, '要指出是哪条会话交回给谁')
    assert.match(said, /临时顶班/, '要说清刚才那些话不是它自己说的')
    assert.equal(ended.json.outNote?.ok, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('/outing 回家：那条会话没开着时，交接句排队等下次打开（2026-10-30 用户 m03179）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fish-outing-route-'))
  try {
    const eventsFile = join(root, 'events.jsonl')
    writeFileSync(eventsFile, JSON.stringify({ type: 'utterance', seq: 1, ts: '2026-10-29T00:00:00.000Z', data: { text: '在家' } }) + EOL)
    const baseline = snapshotEvents(eventsFile)
    await startOuting(root, {
      sessionId: 'session-late',
      workspaceId: 'w9',
      workspaceName: '工作园区',
      cwd: join(root, 'ws'),
      baseline,
      identity: '',
      now: Date.parse('2026-10-29T00:10:00.000Z'),
    })
    const h = harness(root)
    const ended = await h.call('POST', { action: 'end', kept: true })
    assert.equal(ended.status, 200, JSON.stringify(ended.json))
    assert.equal(ended.json.outNote?.ok, true, '写不进对话也要排上队，不能静默丢')
    const saved = JSON.parse(readFileSync(join(root, 'session-notes.json'), 'utf8'))
    assert.equal(saved.notes.length, 1)
    assert.match(String(saved.notes[0].text), /交回给/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
