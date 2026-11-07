/**
 * outing.test.mjs —— 出门台账与「回家前先验一遍」。
 *
 * 这里测的是**判据**，不是流程：出门最坏的结果不是她回不来，是
 * 「她回来时发现自己的记忆被动过，但没人发现」。所以 verifyEvents
 * 的三态（缩水 / 尾部被改写 / 只是正常追加）必须有测试钉住。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  awayNow, awayLine, endOuting, readOutings, snapshotEvents, startOuting, verifyEvents,
  activeOutingSync, startPossession, endPossession, bindOutingSession, abortOuting,
  lastOutingForCwd, outingsOfSession, rejectNoteText, sessionIsHers, tripDays, tripNoOf,
  pendingOf, settlePending,
} from '../lib/outing.js'
import { resolveSessionAgent } from '../lib/observe.js'

function tmp() {
  const root = mkdtempSync(join(tmpdir(), 'fish-outing-'))
  return { root, done: () => rmSync(root, { recursive: true, force: true }) }
}

const base = (root) => ({ sessionId: 's-1', workspaceId: 'w-1', workspaceName: '素材', cwd: join(root, 'ws'), now: 1_700_000_000_000 })

test('出门前是空的：awayNow 返回 kind=null', async () => {
  const { root, done } = tmp()
  try {
    const a = await awayNow(root)
    assert.equal(a.kind, null)
    assert.equal(a.why, '')
  } finally { done() }
})

test('startOuting 记账、activeOutingSync 同步读得到、时间线按开始升序', async () => {
  const { root, done } = tmp()
  try {
    const r = await startOuting(root, base(root))
    assert.equal(r.ok, true)
    const a = await awayNow(root)
    assert.equal(a.kind, 'outing')
    assert.equal(a.outing.workspaceName, '素材')
    assert.equal(a.outing.status, 'active')
    assert.equal(activeOutingSync(root)?.sessionId, 's-1')
    await endOuting(root, { sessionId: 's-1', status: 'done', kept: true, now: 1_700_000_100_000 })
    const { outings: list } = await readOutings(root)
    assert.equal(list.length, 1)
    assert.equal(list[0].status, 'done')
    assert.equal(list[0].kept, true)
  } finally { done() }
})

test('已经有一次出门时，第二次被拒（不想让她同时出现在两个工作区）', async () => {
  const { root, done } = tmp()
  try {
    await startOuting(root, base(root))
    const again = await startOuting(root, { ...base(root), sessionId: 's-2', workspaceId: 'w-2' })
    assert.equal(again.ok, false)
    assert.match(again.why, /已经出门|已经在外面/)
  } finally { done() }
})

test('出门期间不许请神（两条会互相踩身份）', async () => {
  const { root, done } = tmp()
  try {
    await startOuting(root, base(root))
    const p = await startPossession(root, { sessionId: 'x', now: 1 })
    assert.equal(p.ok, false)
    assert.match(p.why, /出门/)
  } finally { done() }
})

test('请神与出门互斥的另一半：请神没结束不能出门', async () => {
  const { root, done } = tmp()
  try {
    await startPossession(root, { sessionId: 'x', now: 1, title: '别人的对话' })
    const o = await startOuting(root, base(root))
    assert.equal(o.ok, false)
    assert.match(o.why, /请神/)
    const a = await awayNow(root)
    assert.equal(a.kind, 'possession')
    await endPossession(root, { sessionId: 'x', now: 2 })
    assert.equal((await awayNow(root)).kind, null)
  } finally { done() }
})

test('回家时事件流变小 → ok:false（被删过行），这是必须拒收的那一种', async () => {
  const { root, done } = tmp()
  try {
    const f = join(root, 'events.jsonl')
    writeFileSync(f, '{"a":1}\n{"a":2}\n{"a":3}\n', 'utf8')
    const snap = await snapshotEvents(f)
    writeFileSync(f, '{"a":1}\n{"a":3}\n', 'utf8')
    const v = verifyEvents(f, snap)
    assert.equal(v.checkable, true)
    assert.equal(v.ok, false)
    // 2026-10-30（用户 m00650 第三版文案）：why 改成「记录比出门时短了（被删过行）」，
    // 不再出现「事件流 / 变小」这些对内行话。
    assert.match(v.why, /短了/)
  } finally { done() }
})

test('回家时大小没变但内容被改写 → ok:false（原地篡改）', async () => {
  const { root, done } = tmp()
  try {
    const f = join(root, 'events.jsonl')
    writeFileSync(f, '{"a":"旧"}\n', 'utf8')
    const snap = await snapshotEvents(f)
    const same = '{"a":"新"}\n'   // 同样的字节数，内容不同
    assert.equal(Buffer.byteLength(same), Buffer.byteLength('{"a":"旧"}\n'))
    writeFileSync(f, same, 'utf8')
    const v = verifyEvents(f, snap)
    assert.equal(v.ok, false)
    // 2026-10-29 m02241 第③条：基线改成整文件哈希后判的是「开头那段变了」，
    // 不再只认尾部。2026-10-30 第三版文案把这句话改成「记录长度没变，但里面的字被改过。」
    assert.match(v.why, /长度没变/)
    assert.match(v.why, /被改过/)
  } finally { done() }
})

test('追加了但把前面的行改过 → 同样抓得住（第③条要补的盲区）', async () => {
  const { root, done } = tmp()
  try {
    const f = join(root, 'events.jsonl')
    writeFileSync(f, '{"a":"旧"}\n{"b":1}\n', 'utf8')
    const snap = await snapshotEvents(f)
    // 改掉第一行（字节数不变），再正常追加一条：只比尾部的旧版会判成「干净」。
    writeFileSync(f, '{"a":"新"}\n{"b":1}\n{"c":2}\n', 'utf8')
    const v = verifyEvents(f, snap)
    assert.equal(v.ok, false)
    // 2026-10-30 第三版文案：从「事件流开头 N 字节对不上」改成
    // 「出门前那段内容被改过（后面的新增是正常的，改前面就不行）。」
    assert.match(v.why, /出门前那段/)
  } finally { done() }
})

test('正常追加（她自己写日记）算干净，且报出追加条数', async () => {
  const { root, done } = tmp()
  try {
    const f = join(root, 'events.jsonl')
    writeFileSync(f, '{"a":1}\n', 'utf8')
    const snap = await snapshotEvents(f)
    appendFileSync(f, '{"a":2}\n{"a":3}\n', 'utf8')
    const v = verifyEvents(f, snap)
    assert.equal(v.ok, true)
    // appended 是**字节数**不是行数：只用来让人看见「这趟她写过东西」
    assert.equal(v.appended, Buffer.byteLength('{"a":2}\n{"a":3}\n'))
  } finally { done() }
})

test('没有基线时 checkable:false —— 不谎报「验过没问题」', async () => {
  const { root, done } = tmp()
  try {
    const v = verifyEvents(join(root, 'nope.jsonl'), null)
    assert.equal(v.checkable, false)
    assert.equal(v.ok, null)
  } finally { done() }
})

test('awayLine 说人话：外面报工作区，替人说话报标题', async () => {
  const line = awayLine({ kind: 'outing', outing: { workspaceName: '素材库', startedAt: Date.now() - 3600_000 } })
  assert.match(line, /现在在外面：素材库/)
  assert.match(line, /小时/)
  const p = awayLine({ kind: 'possession', possession: { title: '别人的对话', startedAt: Date.now() - 60_000 } })
  assert.match(p, /替人说话/)
  assert.equal(awayLine({ kind: null }), '')
})

test('台账文件坏了也不抛：当没出门处理，但下一次 start 会重写', async () => {
  const { root, done } = tmp()
  try {
    writeFileSync(join(root, 'outings.json'), '{坏掉的 json', 'utf8')
    const a = await awayNow(root)
    assert.equal(a.kind, null)
    const r = await startOuting(root, base(root))
    assert.equal(r.ok, true)
    assert.ok(existsSync(join(root, 'outings.json')))
    assert.match(readFileSync(join(root, 'outings.json'), 'utf8'), /"outings"/)
  } finally { done() }
})

test('先记账再建会话：id 可以先空着，建完再补', async () => {
  const { root, done } = tmp()
  try {
    const st = await startOuting(root, { sessionId: '', workspaceId: 'w-1', workspaceName: '素材', cwd: join(root, 'ws'), now: 1_700_000_000_000 })
    assert.equal(st.ok, true)
    const first = await readOutings(root)
    assert.equal(first.outings.length, 1, '空 id 的那条不能被当成坏档丢掉')
    assert.equal(activeOutingSync(root)?.workspaceName, '素材')

    const b = await bindOutingSession(root, { sessionId: 'session-abc' })
    assert.equal(b.ok, true)
    assert.equal(b.bound, true)
    assert.equal(activeOutingSync(root)?.sessionId, 'session-abc')

    const again = await bindOutingSession(root, { sessionId: 'session-abc' })
    assert.equal(again.ok, true)
    assert.equal(again.bound, false, '同一条 id 再补一次是幂等的')

    const other = await bindOutingSession(root, { sessionId: 'session-other' })
    assert.equal(other.ok, false, '已经记了别的 id 就不能覆盖')
  } finally {
    done()
  }
})

test('建会话失败时撤掉空壳，否则她会一直「挂在门外」', async () => {
  const { root, done } = tmp()
  try {
    await startOuting(root, { sessionId: '', cwd: join(root, 'ws'), now: 1_700_000_000_000 })
    const a = await abortOuting(root)
    assert.equal(a.ok, true)
    assert.equal(activeOutingSync(root), null)
    assert.equal((await readOutings(root)).outings.length, 0)
  } finally {
    done()
  }
})

test('出门页对所有人可见：服务端只多一个一次性确认，不再按 dev 藏', async () => {
  // 2026-10-29 用户 m00608：早先按「代码路径里有没有 node_modules」猜安装形态，
  // 发布包被解包到插件目录 / 经 junction 指过去时路径里没有这一段，页签就漏给了所有人。
  const src = readFileSync(new URL('../lib/observe.js', import.meta.url), 'utf8')
  assert.ok(!src.includes('IS_DEV_INSTALL'), '不能再按安装形态算一次就定死')
  assert.ok(!src.includes("includes('node_modules')"), '安装路径判定会把页签漏给正式版')
  // 2026-10-30 用户 m01904：可见性不再看 dev；GET 带回 ack，POST 能把它写下来。
  assert.ok(src.includes('ack: ((await loadConfig(root)'), '/outing 要带回一次性确认')
  assert.ok(src.includes("if (action === 'ack')"), '要能把确认写回配置')
  // dev 字段保留——本机还拿它做别的判断，只是不再用来藏页签。
  assert.ok(src.includes('dev: true'), '/outing 仍带回 dev')
  // 同一个判据也被「去刷 B 站」用：没有 .dev 时两处一起藏，不各算各的。
  assert.ok(src.includes("from './devmode.js'"), '要复用 devmode 那个文件开关')
})

test('已经绑了会话的那条不能被当空壳撤掉', async () => {
  const { root, done } = tmp()
  try {
    await startOuting(root, { sessionId: 'session-x', cwd: join(root, 'ws'), now: 1_700_000_000_000 })
    const a = await abortOuting(root)
    assert.equal(a.ok, false)
    assert.equal(activeOutingSync(root)?.sessionId, 'session-x')
  } finally {
    done()
  }
})

// ------------------------------------------------------------------
// 0.6.16（用户 m01613 / m01677）：复用同一趟、驳回话术、想念天数
// ------------------------------------------------------------------

test('想念天数只按整天算：5 分钟是 0 天，25 小时是 1 天', () => {
  const o = { startedAt: 1_700_000_000_000, endedAt: 1_700_000_000_000 + 5 * 60_000 }
  assert.equal(tripDays(o), 0)
  assert.equal(tripDays({ startedAt: 1_700_000_000_000, endedAt: 1_700_000_000_000 + 25 * 3600_000 }), 1)
  assert.equal(tripDays({}), 0)
  assert.equal(tripDays({ startedAt: Date.now() - 5 * 60_000 }), 0, '还在外面就从现在算，不四舍五入成 1 天')
})

test('复用同一趟：找的是同一个工作区、已经结束、带会话 id 的那条', () => {
  const cwd = 'D:/work/a'
  const outings = [
    { sessionId: 's-old', cwd, status: 'done', startedAt: 100, endedAt: 200 },
    { sessionId: 's-live', cwd, status: 'active', startedAt: 300 },
    { sessionId: 's-other', cwd: 'D:/work/b', status: 'done', startedAt: 400, endedAt: 500 },
    { sessionId: '', cwd, status: 'done', startedAt: 600, endedAt: 700 },
  ]
  const last = lastOutingForCwd({ outings }, cwd)
  assert.equal(last.sessionId, 's-old', '正在外面那趟不能拿来「接着上次」，没 id 的也不算')
  assert.equal(lastOutingForCwd({ outings }, 'D:/work/b').sessionId, 's-other')
  assert.equal(lastOutingForCwd({ outings }, 'D:/nope'), null)
  // 路径比对要抹平反斜杠与大小写（Windows）
  const bs = String.fromCharCode(92)
  assert.equal(lastOutingForCwd({ outings }, ["d:", "WORK", "a"].join(bs))?.sessionId, 's-old')
})

test('一条会话算不算她的：只看有没有 active 记录指着它', () => {
  const outings = [
    { sessionId: 's1', status: 'done' },
    { sessionId: 's1', status: 'active' },
    { sessionId: 's2', status: 'done' },
  ]
  assert.equal(sessionIsHers({ outings }, 's1'), true)
  assert.equal(sessionIsHers({ outings }, 's2'), false)
  assert.equal(sessionIsHers({ outings }, ''), false)
  assert.equal(outingsOfSession({ outings }, 's1').length, 2)
})

test('驳回话术：只否定那几条，不否定整趟，也不带惩罚口吻', () => {
  const text = rejectNoteText({ items: [{ text: '  我随便翻了一下\n桌上的笔记 ' }, { text: '我还写了个脚本' }], total: 5 })
  assert.match(text, /这趟里我不认这几条（一共 5 条，挑出这几条说）：/)
  assert.match(text, /「我随便翻了一下 桌上的笔记」「我还写了个脚本」/)
  assert.match(text, /它们不算你，别的算/)
  assert.ok(!/不应该|不许|惩罚|下不为例/.test(text), '不能写成训她')
  // 没有条目就不写，别留一句空话
  assert.equal(rejectNoteText({ items: [], total: 0 }), '')
  assert.equal(rejectNoteText({}), '')
})

// 0.7.4（用户 m00659 A）：「整趟不算数」的话术不能逐条念——那不是挑几条，是这一趟全不收。
test('驳回话术：整趟不算数说的是「一条都不收」，不是逐条念墙', () => {
  const text = rejectNoteText({ items: [{ text: '第一句' }, { text: '第二句' }], total: 7, auto: true })
  assert.match(text, /这趟里的 7 条，我一条都不收/)
  assert.match(text, /不是说你白去了/)
  assert.ok(!text.includes('「第一句」'), '整趟不算时不该逐条列出来')
  assert.ok(!/不应该|不许|惩罚|下不为例/.test(text))
  // 这一趟什么都没写：话还得说得出口，不能变成空串
  assert.match(rejectNoteText({ items: [], total: 0, auto: true }), /这趟我一条都不收/)
})

// ------------------------------------------------------------------
// 0.6.26（用户 m03194）：复用的那趟要能说清「第几趟」，装配失败不能留幽灵记录
// ------------------------------------------------------------------

test('第几趟：同一条会话复用两次，第二次就是第 2 趟', () => {
  const outings = [
    { sessionId: 's1', startedAt: 100, status: 'done', endedAt: 150 },
    { sessionId: 's1', startedAt: 300, status: 'active' },
    { sessionId: 's2', startedAt: 400, status: 'done', endedAt: 450 },
  ]
  assert.equal(tripNoOf({ outings }, 's1', 300), 2)
  assert.equal(tripNoOf({ outings }, 's1', 100), 1)
  assert.equal(tripNoOf({ outings }, 's2', 400), 1)
  assert.equal(tripNoOf({ outings }, 's9', 0), 0, '没出过门的会话没有趟次')
  assert.equal(tripNoOf({}, 's1', 0), 0)
})

test('装配失败可以把已经绑了会话的那趟强制撤掉（0.6.25 真机：幽灵出门）', async () => {
  const { root, done } = tmp()
  try {
    await startOuting(root, { sessionId: 'session-x', cwd: join(root, 'ws'), now: 1_700_000_000_000 })
    const a = await abortOuting(root, { force: true })
    assert.equal(a.ok, true)
    assert.equal(activeOutingSync(root), null, '撤掉之后不能还留着一条 active')
  } finally {
    done()
  }
})

test('出门 start：先写日志再装配，装配失败强制撤掉，不留幽灵记录', () => {
  const src = readFileSync(new URL('../lib/observe.js', import.meta.url), 'utf8')
  assert.ok(src.includes('（接回第 ${tripNo} 趟）'), '复用成功时日志要写清是第几趟')
  assert.ok(src.includes('abortOuting(root, { force: true })'), '装配失败要能把带 sessionId 的这条撤掉')
  assert.ok(src.includes('装备挂上了'), '装配完要再写一行，说明装备到底挂上没有')
  // 提前那行日志必须在「挂装备」之前，否则中途抛错又会只剩台账。
  const logAt = src.indexOf("（接回第 ${tripNo} 趟）")
  const attachAt = src.indexOf('attachIdentity(live, root, {')
  assert.ok(logAt > 0 && attachAt > 0 && logAt < attachAt, '日志要排在装配之前')
  // 0.7.3：装配这两个入口都必须把 herDir 传下去，否则「手边有什么」分不清
  // 家里与外面，出门那条会话会继续念家里的白名单（用户 m00339）。
  assert.ok(
    src.includes('attachIdentity(live, root, { frozen: identity, herDir: paths(root).herDir })'),
    '接回老会话那一路要传 herDir',
  )
  assert.ok(
    src.includes('attachIdentity(back, root, { frozen: identity, herDir: paths(root).herDir })'),
    'resolveAgent 恢复那一路也要传 herDir',
  )
})

test('接回上次那趟：这版宿主没有 sessionController.resume，要走 resolveAgent（0.6.27 真机 500）', async () => {
  const calls = []
  const agent = { id: 'a1' }
  // 正常：resolveAgent 返回 { agent }
  const got = await resolveSessionAgent({
    resolveAgent: async (sid) => { calls.push(sid); return { agent } },
  }, 'session-x')
  assert.equal(got, agent)
  assert.deepEqual(calls, ['session-x'])
  // 宿主给的是 { error }：原样抛出去，由上层收口撤掉这趟
  await assert.rejects(
    () => resolveSessionAgent({ resolveAgent: async () => ({ error: new Error('session/not-found') }) }, 's1'),
    /session\/not-found/,
  )
  // 只暴露在 agents 子对象上也要能接
  assert.equal(await resolveSessionAgent({ agents: { resolveAgent: async () => ({ agent }) } }, 's2'), agent)
  // 一个入口都没有：要说人话，不是 undefined is not a function
  await assert.rejects(() => resolveSessionAgent({}, 's3'), /resolveAgent/)
  // 源码里不允许再直接调不存在的 sc.resume
  const src = readFileSync(new URL('../lib/observe.js', import.meta.url), 'utf8')
  assert.ok(!src.includes('sc.resume('), '不要再调这版宿主没有的 sc.resume')
  assert.ok(src.includes('await resolveSessionAgent(sc, reuseId)'), '复用分支要走 resolveSessionAgent')
})

test('等复核的那趟：能找出来、复核通过就收下，结束时间不重写（0.6.32 真机：pending 成了死路）', async () => {
  const { root, done } = tmp()
  try {
    const now = 1_700_000_000_000
    assert.equal(pendingOf({}), null, '没有等复核的时候要返回 null，不是抛错')
    await startOuting(root, {
      ...base(root),
      sessionId: 's-a',
      baseline: snapshotEvents(join(root, 'events.jsonl')),
      identity: '',
      now,
    })
    await endOuting(root, { sessionId: 's-a', status: 'pending', kept: null, now: now + 60_000 })
    const pend = pendingOf(await readOutings(root))
    assert.ok(pend, '被拒收那趟要能找回来')
    assert.equal(pend.sessionId, 's-a')
    assert.equal(pend.kept, null)

    const wrong = await settlePending(root, { sessionId: 's-b' })
    assert.equal(wrong.ok, false, '不是这一趟就不能结算')
    assert.match(wrong.why, /不是这一趟/)
    // 两趟共用一条会话时只认 sessionId 会结错趟（#68 复核）：带了趟次就按趟次核对。
    const otherTrip = await settlePending(root, { sessionId: 's-a', startedAt: pend.startedAt + 1 })
    assert.equal(otherTrip.ok, false, '会话对得上、趟次对不上也不能结算')
    assert.equal(pendingOf(await readOutings(root))?.status, 'pending', '结错趟的请求不能动台账')

    const ok = await settlePending(root, { sessionId: 's-a', startedAt: pend.startedAt })
    assert.equal(ok.ok, true)
    const after = await readOutings(root)
    const last = after.outings[after.outings.length - 1]
    assert.equal(last.status, 'done')
    assert.equal(last.kept, true)
    assert.equal(last.endedAt, now + 60_000, '结束时间要保留她真正回家的那一刻，不能在复核时被改掉')

    const again = await settlePending(root, {})
    assert.equal(again.ok, false, '已经结算过就不能再结一次')
    assert.match(again.why, /没有等复核/)
  } finally { done() }
})

test('/outing 复核接口：GET 带回 pendingReview，POST action=review 通过后收下（0.6.32）', () => {
  const observe = readFileSync(new URL('../lib/observe.js', import.meta.url), 'utf8')
  assert.ok(observe.includes('pendingOf, settlePending'), '复核用的两个函数要 import 进来')
  assert.ok(observe.includes("action === 'review'"), 'POST 要有 review 分支')
  assert.ok(observe.includes('pendingReview'), 'GET 要把等复核的那趟带回界面')
  assert.ok(observe.includes('复核：通过，这趟收下了'), '通过要留一行日志，方便查')
  assert.ok(observe.includes('复核：还是对不上'), '没通过也要留一行')

  const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.ok(client.includes('doReviewPending'), '界面上要有复核这个动作')
  assert.ok(client.includes('核对一次'), '按钮要写人话')
  assert.ok(client.includes('上一趟还没算数'), '要有一张卡告诉人上一趟卡在哪')
  assert.ok(client.includes('等着核对'), '台账状态词用「等着核对」，不是「等确认」')
  assert.ok(!client.includes('她留在外面，等你确认过再说'), 'pending 之后她其实已经回家了，旧文案会骗人')
})
