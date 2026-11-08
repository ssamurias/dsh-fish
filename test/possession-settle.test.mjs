/**
 * possession-settle.test.mjs —— 请神的「回家审查」全链路，端到端跑一遍。
 *
 * 缺口来由（2026-10-29，用户 m02241 第①②④⑤条）：
 * 设计 `docs/E-出门与请神-方案.md` §5 定死「两条路共用同一套事件标记与回家审查」。
 * 出门那条早就做完了；请神这条在 0.7.6 之前只有一句 `releasePossession`：
 * 谁也没比对事件流、没人看她这趟写了什么、也没有 `possess-reject:` 标记。
 * 于是「请神期间写的东西默认全算」，文件被人动过也一样算。
 *
 * 这里钉的是四条边界：
 *   1. 请神期间，被上身的那条会话**能**写回自己家；别的会话照样被拒；身份仍改不了。
 *   2. 结束时按 kept / rejectedIds 结算，标记写成 `meta possess-reject:`，台账状态落在 done / rejected。
 *   3. 整趟不算（kept:false 且没逐条挑）→ 非 meta 条目全标上。
 *   4. 文件被动过 → 这趟先不算数（pending），还原之后 review 才收下。
 *
 * 假 ctx + 假 req/res，不碰真实家目录。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { registerObserve } from '../lib/observe.js'
import { checkCaller } from '../lib/tenant.js'
import { deriveSelf } from '../lib/derive.js'
import { readEvents } from '../lib/store.js'
import { eventsSince, readPossessions, snapshotEvents, startPossession } from '../lib/outing.js'

// 2026-11-09：这一趟写下的条目都带会话 id（生产上就是她那条会话写的）。
// 没带会话标记的条目按「家里的」处理（宁可漏算不误伤，#68 第 7 条），所以请神期间的
// 条目必须显式带上，否则审查清单里根本看不见它们。
const line = (id, ts, type = 'utterance', text = '在家', sid = 'session-talk') =>
  JSON.stringify({ id, v: 1, ts, day: 1, stage: 1, type, source: 'her', text, refs: [], verdict: null, confidence: 0.5, flags: [], ...(sid ? { sessionId: sid } : {}) }) + '\n'

function fakeAgent(id, cwd) {
  const appended = []
  return {
    session: { header: { id, cwd }, append: (type, payload) => { appended.push({ type, payload }) } },
    ctx: { systemPrompt: { section: () => () => {} }, tools: { guard: () => () => {} }, effect: () => () => {} },
    appended,
  }
}

/** 与 outing-start.test.mjs 同一套：只要 routes / agents 够 registerObserve 起来。 */
function harness(root, { agents = [] } = {}) {
  const routes = new Map()
  const agentMap = new Map(agents.map((a) => [String(a.session?.header?.id ?? ''), a]))
  const ctx = {
    get(name) {
      if (name === 'connection') return { requestRejection: () => null }
      if (name === 'webServer') {
        return { register(ex) { routes.set(ex.path, ex.handler); return () => {} } }
      }
      if (name === 'agents') {
        return { get: (id) => agentMap.get(String(id ?? '')) ?? null, list: () => [...agentMap.values()] }
      }
      if (name === 'workspaceRegistry') return { list: () => [] }
      return undefined
    },
  }
  registerObserve(ctx, { root })

  async function call(method, body, path = '/dsh-fish/possession') {
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
  return { call }
}

const T0 = Date.parse('2026-10-29T00:10:00.000Z')

/** 一个只装了「她在家」的家：一条旧事件 + 一条活着的对话。 */
function setup(id = 'session-talk') {
  const root = mkdtempSync(join(tmpdir(), 'fish-possess-settle-'))
  mkdirSync(join(root, 'home'), { recursive: true })
  const events = join(root, 'events.jsonl')
  writeFileSync(events, line('ev_before', '2026-10-29T00:00:00.000Z'), 'utf8')
  const talk = fakeAgent(id, 'D:/别人的工作区')
  return { root, events, talk, h: harness(root, { agents: [talk] }) }
}

const possess = (root, { sessionId = 'session-talk', baseline = undefined, now = T0 } = {}) =>
  startPossession(root, {
    sessionId,
    title: '一个对话',
    cwd: 'D:/别人的工作区',
    identity: '',
    baseline,
    now,
  })

test('请神期间：被上身那条会话能写回自己家；别的会话照拒；身份仍改不了', async () => {
  const { root, h } = setup()
  try {
    await possess(root)
    const inOther = { session: { header: { id: 'session-talk', cwd: 'D:/别人的工作区' } } }
    const herDir = join(root, 'home')

    const ok = checkCaller(root, inOther, { herDir })
    assert.equal(ok.ok, true, '请神期间她的写入必须能落回自己的屋子')
    assert.equal(ok.possessed, true, '理由要说清是「请神」，不是「cwd 正好在家里」')

    const other = checkCaller(root, { session: { header: { id: 'session-other', cwd: 'D:/别人的工作区' } } }, { herDir })
    assert.equal(other.ok, false, '没被上身的那条会话不许往这个家里写')

    // 身份文件那条调用显式 outsideOk:false —— 与出门一致，请神期间也改不了自己。
    const identity = checkCaller(root, inOther, { herDir, outsideOk: false, tool: 'growth_commit' })
    assert.equal(identity.ok, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('结束请神：取消勾选的条目写成 possess-reject:，这趟状态是 done', async () => {
  const { root, events, talk, h } = setup()
  try {
    await possess(root)
    appendFileSync(events, line('ev_new', '2026-10-29T00:20:00.000Z', 'utterance', '在外面写了一句'), 'utf8')

    const r = await h.call('POST', { action: 'end', sessionId: 'session-talk', kept: true, rejectedIds: ['ev_new'] })
    assert.equal(r.status, 200, JSON.stringify(r.json))
    assert.equal(r.json.tampered, false)
    assert.equal(r.json.rejected, 1)
    assert.equal(r.json.possession.status, 'done')

    const raw = readFileSync(events, 'utf8')
    assert.match(raw, /"text":"possess-reject:ev_new"/, '标记要真的写进事件流（只能追加，不能删行）')
    // 结束仍然只补一条标准交接句。
    assert.equal(talk.appended.length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('整趟不算且没逐条挑：非 meta 的条目全部标上，状态 rejected', async () => {
  const { root, events, h } = setup()
  try {
    await possess(root)
    appendFileSync(events, line('ev_a', '2026-10-29T00:20:00.000Z', 'utterance', '第一句'), 'utf8')
    appendFileSync(events, line('ev_b', '2026-10-29T00:21:00.000Z', 'diary', '第二句'), 'utf8')

    const r = await h.call('POST', { action: 'end', sessionId: 'session-talk', kept: false })
    assert.equal(r.status, 200, JSON.stringify(r.json))
    assert.equal(r.json.autoRejected, true)
    assert.equal(r.json.rejected, 2)
    assert.equal(r.json.possession.status, 'rejected')

    const raw = readFileSync(events, 'utf8')
    assert.match(raw, /possess-reject:ev_[a-z]+ ev_[a-z]+/, '两个 id 都要在一条标记里')
    assert.doesNotMatch(raw, /possess-reject:[^"\n]*ev_before/, '基线之前的事件不在这趟的范围里')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('审查列表不摆 seen: 记账行——那串数字不是她写的', async () => {
  const { root, events } = setup()
  try {
    await possess(root)
    appendFileSync(events, line('ev_say', '2026-10-29T00:20:00.000Z', 'utterance', '我写了这一句'), 'utf8')
    // capture 每条成长后面都会补一行 `seen:<iso>`；真机里它被当成条目摆在审查卡上，
    // 用户看到的就是「一串数字和英文字符」（2026-10-30 反馈）。
    appendFileSync(events, line('ev_seen', '2026-10-29T00:20:01.000Z', 'meta', 'seen:2026-10-29T00:20:01.000Z'), 'utf8')
    appendFileSync(events, line('ev_note', '2026-10-29T00:21:00.000Z', 'meta', 'diary:2026-10-29'), 'utf8')

    const s = eventsSince(events, T0)
    assert.deepEqual(s.items.map((it) => it.id), ['ev_say', 'ev_note'], '她写的话和日记都留，记账行一条不摆')
    assert.equal(s.total, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('文件被动过：这趟先不算数（pending），还原之后 review 才收下', async () => {
  const { root, events, h } = setup()
  try {
    const baseline = snapshotEvents(events)
    await possess(root, { baseline })
    // 追加一条，同时把基线里那行改掉：只比尾部的旧版会判成「干净」。
    writeFileSync(
      events,
      line('ev_before', '2026-10-29T00:00:00.000Z', 'utterance', '这句话被人改过') +
        line('ev_new', '2026-10-29T00:20:00.000Z', 'utterance', '正常追加'),
      'utf8',
    )

    const ended = await h.call('POST', { action: 'end', sessionId: 'session-talk', kept: true })
    assert.equal(ended.status, 200, JSON.stringify(ended.json))
    assert.equal(ended.json.tampered, true)
    assert.equal(ended.json.possession.status, 'pending', '动过就转 pending，不替人收下')

    const g1 = await h.call('GET')
    assert.ok(g1.json.pendingReview, '界面要能看见「上一次请神没结算」')
    assert.equal(g1.json.pendingReview.okNow, false)
    assert.ok(g1.json.active === null, '她本人照样回来（挂载已撤）')

    // 还原成「基线 + 正常追加」：开头那段与基线一致，就该判干净。
    writeFileSync(
      events,
      line('ev_before', '2026-10-29T00:00:00.000Z') + line('ev_new', '2026-10-29T00:20:00.000Z', 'utterance', '正常追加'),
      'utf8',
    )
    const g2 = await h.call('GET')
    assert.equal(g2.json.pendingReview.okNow, true)

    const reviewed = await h.call('POST', { action: 'review' })
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.json))
    assert.equal(reviewed.json.ok, true)
    const { possessions } = await readPossessions(root)
    assert.equal(possessions.at(-1).status, 'done')
    assert.equal(possessions.at(-1).kept, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('deriveSelf 认 possess-reject: 与 outing-reject: 两个前缀', async () => {
  const events = [
    JSON.parse(line('ev_keep', '2026-10-29T00:00:00.000Z', 'utterance', '收下的话')),
    JSON.parse(line('ev_drop', '2026-10-29T00:01:00.000Z', 'utterance', '被驳回的话')),
  ]
  const meta = (i, text) => ({ id: i, v: 1, ts: '2026-10-29T00:02:00.000Z', day: 1, stage: 1, type: 'meta', source: 'system', text, refs: [], verdict: null, confidence: 0.5, flags: [] })
  const now = Date.parse('2026-10-29T12:00:00.000Z')
  const without = deriveSelf(events, { now })
  const keptOnly = deriveSelf([events[0]], { now })
  assert.notDeepEqual(without, keptOnly, '不驳回时，那条话确实会进她此刻的样子')

  for (const prefix of ['possess-reject:', 'outing-reject:']) {
    const d = deriveSelf([...events, meta('ev_m', prefix + 'ev_drop')], { now })
    assert.deepEqual(d, keptOnly, `${prefix} 之后，被驳回的那条要跟她没写过一样`)
  }
})

test('事件确实被写进事件流：结算是读文件算出来的，不是内存里的假设', async () => {
  const { root, events, h } = setup()
  try {
    await possess(root)
    appendFileSync(events, line('ev_new', '2026-10-29T00:20:00.000Z'), 'utf8')
    await h.call('POST', { action: 'end', sessionId: 'session-talk', kept: true, rejectedIds: ['ev_new'] })
    const { events: list } = await readEvents(root)
    assert.ok(list.some((e) => e.type === 'meta' && String(e.text).startsWith('possess-reject:')), '标记要在文件里，重启之后照样生效')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
