/**
 * p3.test.mjs —— 信箱与对话入口（P3-1 / P3-2）
 *
 * 这一组测试守的是"两个方向真的通了"，而不是"代码看起来对"：
 *   ① 信箱只挑她的话（不把 meta / browse 记账算成人话），且默认只放留话；
 *   ② 未读按事件流里的位置算，不靠时间戳（时间戳会被时区骗）；
 *   ③ 她说一句话 → 未读 +1 → 标记已读 → 未读归零；
 *   ④ inbox.md 落盘且内容与事件流一致；
 *   ⑤ 对话入口在唤醒窗外说话 → 落 `seen:` 标记（冷落检测的唯一依据），
 *      在唤醒窗内说话 → **不落** seen（她自言自语不算"他来过"）；
 *   ⑥ 她这一轮写了话 → 接口把原话回给调用方；她一言不发 → 返回 note 而不是报错。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { appendEvent, readEvents, readDaily, paths } from '../lib/store.js'
import { buildInbox, readInbox, markRead, writeInboxFile, newHerEventsSince } from '../lib/inbox.js'
import { sayToHer } from '../lib/say.js'
import { leaveLetter } from '../lib/letter.js'
import { enterWake, leaveWake } from '../lib/wakewin.js'

async function tmpRoot() {
  return mkdtemp(join(tmpdir(), 'fish-p3-'))
}

/** 造一条她的话 */
async function her(root, type, text, extra = {}) {
  return appendEvent({ type, text, ...extra }, { day: 1, stage: 1, source: 'tool' }, root)
}

/** 造一条系统记账（不该进信箱） */
async function meta(root, text) {
  return appendEvent({ type: 'meta', text }, { day: 1, stage: 1, source: 'system' }, root)
}

/**
 * 假宿主。`house:false` 用来模拟「拿不到屋子」的宿主（没有 workspaceRegistry）。
 *
 * 2026-10-24 改：以前这里没有 workspaceRegistry，say 会退回按天新建的
 * `fish-talk-YYYY-MM-DD`。那条退路已删（它会在用户侧栏堆出「未分组」），
 * 所以默认给一个能建、能复用的屋子，测试才走正常链路。
 */
function fakeCtx({ house = true } = {}) {
  const calls = []
  const sc = {
    async create(o = {}) {
      calls.push({ op: 'create', ...o })
      // 只有「按工作区建」才回 id；按 sessionId 建是复用已有会话，宿主会抛
      return o.workspaceId ? { sessionId: 's-house' } : {}
    },
    async prompt(req, signal) { calls.push({ op: 'prompt', req, signal }) },
    async rename(p) { calls.push({ op: 'rename', ...p }) },
  }
  if (!house) return { calls, sessionController: sc }
  const ws = {
    id: 'ws-house',
    path: 'X:\\fake\\home',
    title: '大肥鱼的家',
    sessionIds: ['s-house'],
    archivedSessionIds: [],
  }
  const workspaceRegistry = {
    list: () => [ws],
    get: (id) => (id === ws.id ? ws : null),
    create: async () => ws,
    update: async () => {},
  }
  // 宿主是用 ctx.get('workspaceRegistry') 取服务（见 home.js 的 readRegistry），
  // 只挂属性不给 get 的话插件会以为「宿主没有这个服务」。
  const get = (k) => (k === 'workspaceRegistry' ? workspaceRegistry : undefined)
  return { calls, sessionController: sc, workspaceRegistry, get }
}

test('信箱只挑她的话，不把记账与系统事件算进去', async () => {
  const root = await tmpRoot()
  try {
    await appendEvent({ type: 'seed', text: '你不是助手。' }, { day: 1, stage: 1, source: 'system' }, root)
    await her(root, 'utterance', '我不太确定。')
    await meta(root, 'browse:2026-10-23 [{"bvid":"BV1"}]')
    await meta(root, 'seen:2026-10-23T00:00:00.000Z')
    await her(root, 'refusal', '我不想说这个。')

    // lettersOnly:false 是"关掉只留留话"的总开关——这一条守的是类型过滤，
    // 所以显式要全量，才看得见 meta / seed 有没有漏进来。
    const box = await readInbox(root, { lettersOnly: false })
    assert.equal(box.total, 2, '只应有两句她的话')
    assert.deepEqual(box.rows.map((r) => r.type), ['refusal', 'utterance'], '时间倒序，最新在前')
    assert.equal(box.rows.some((r) => String(r.text).includes('browse:')), false)

    // 默认口径（2026-10-24 用户定）：信箱只放特意留给人的信，平常的话不进列表。
    const lettersOnly = await readInbox(root)
    assert.equal(lettersOnly.total, 0, '默认只放留话')
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('未读按位置算：第一次全未读，标记后归零', async () => {
  const root = await tmpRoot()
  try {
    await her(root, 'utterance', '第一句。')
    // 未读是"读到哪个位置"的算术，与"信箱放不放平常的话"无关，所以关掉 lettersOnly。
    let box = await readInbox(root, { lettersOnly: false })
    assert.equal(box.unread, 1, '从没读过 → 全部未读')

    await markRead(root)
    box = await readInbox(root, { lettersOnly: false })
    assert.equal(box.unread, 0, '标记后应归零')

    await her(root, 'utterance', '第二句。')
    box = await readInbox(root, { lettersOnly: false })
    assert.equal(box.unread, 1, '新的一句算未读')
    assert.equal(box.rows[0].text, '第二句。', '最新的在最前')
    assert.equal(box.rows[0].unread, true)
    assert.equal(box.rows[1].unread, false, '旧的仍是已读')
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('未读不靠时间戳：把 ts 改成乱序也不会错判', async () => {
  // 这条守的是"有人在旧事件里写了个坏 ts"的场景。
  // 位置判据只看 id 在事件流里的下标，天然免疫。
  const root = await tmpRoot()
  try {
    const a = await her(root, 'utterance', '早的。')
    const b = await her(root, 'utterance', '晚的。')
    const { events } = await readEvents(root)
    const box = buildInbox(
      events.map((e) => (e.id === a.id ? { ...e, ts: '2030-01-01T00:00:00.000Z' } : e)),
      { lastReadId: b.id },
    )
    assert.equal(box.unread, 0, '两条都在"读到过的最后一条"之前')
    assert.equal(box.rows[0].id, b.id, '顺序按事件流位置，不按 ts')
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('inbox.md 落盘：有内容时是纯文本引用块，没内容时给一句起点说明', async () => {
  const root = await tmpRoot()
  try {
    const empty = await writeInboxFile(root)
    const t1 = await readFile(empty, 'utf8')
    assert.match(t1, /还没有。这是起点，不是故障。/)

    // 2026-10-24 起这个文件只写留话，所以这里必须用真留话（her_leave 那条链路）。
    const left = await leaveLetter(root, '我看不懂他为什么还在。')
    assert.equal(left.ok, true)
    const f = await writeInboxFile(root)
    assert.equal(f, join(paths(root).root, 'inbox.md'))
    const t2 = await readFile(f, 'utf8')
    assert.match(t2, /# 大肥鱼留给你的话/)
    assert.match(t2, /> 我看不懂他为什么还在。/)
    assert.match(t2, /未读 1 封/)
    assert.match(t2, /这里只有特意留给你的/)
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('newHerEventsSince 只认她写的那几类', async () => {
  const root = await tmpRoot()
  try {
    await appendEvent({ type: 'seed', text: '起点。' }, { day: 1, stage: 1, source: 'system' }, root)
    const { events } = await readEvents(root)
    const mark = events[events.length - 1].id
    await her(root, 'utterance', '新的。')
    await meta(root, 'seen:x')
    const after = await readEvents(root)
    const fresh = newHerEventsSince(after.events, mark)
    assert.equal(fresh.length, 1)
    assert.equal(fresh[0].text, '新的。')
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

/**
 * 假宿主：prompt 不真的跑模型。
 *
 * ⚠️ sessionController 必须是**固定对象**，不能用 getter 返回新对象——
 * 否则 `ctx.sessionController.prompt = fake` 只改了临时对象，被测代码拿到的
 * 还是原来那个，于是测试假绿/假红（第一版就踩了这个）。
 * 正式版本见文件上方 `fakeCtx({house})`，这里保留一个最瘦的壳给
 * 「宿主什么都没有」的场景用。
 */
function fakeCtxLegacy() {
  const calls = []
  const sc = {
    async create({ sessionId, cwd }) { calls.push({ op: 'create', sessionId, cwd }) },
    async prompt(req, signal) { calls.push({ op: 'prompt', req, signal }) },
  }
  return { calls, sessionController: sc }
}

test('说一句话：落 seen 标记（唤醒窗外才算他来过），并带回她的原话', async () => {
  const root = await tmpRoot()
  try {
    await appendEvent({ type: 'seed', text: '起点。' }, { day: 1, stage: 1, source: 'system' }, root)

    const ctx = fakeCtx()
    // 用 waitMs 极小 + 没有事件总线 → waitTurnEnd 走 8 秒兜底，太长；
    // 所以这里让 prompt 直接替她把话写好，然后把 waitMs 压到 5 秒下限之外的方式：
    // waitMs 下限是 5000，测试里接受这 5 秒——换来的是"真的走了完整链路"。
    ctx.sessionController.prompt = async (req, signal) => {
      ctx.calls.push({ op: 'prompt', req, signal })
      await her(root, 'utterance', '你说的我听见了。')
    }

    const r = await sayToHer(ctx, '在吗', { root, waitMs: 5_000 })
    assert.equal(r.ok, true)
    assert.equal(r.said.length, 1, '应带回她这一轮写的那句')
    assert.equal(r.herReply, '你说的我听见了。')

    const { events } = await readEvents(root)
    const seen = events.filter((e) => e.type === 'meta' && String(e.text).startsWith('seen:'))
    assert.equal(seen.length, 1, '唤醒窗外说话 → 必须落一条 seen（冷落检测的唯一依据）')
    assert.equal(seen[0].source, 'system', 'seen 必须是 system，tool 会被 schema 拒掉')

    // 她的会话 cwd 是她自己的空房间，不是状态库根目录
    const placed = ctx.calls.filter((c) => c.op === 'create' && c.cwd)
    assert.ok(placed.length >= 1, '应当把会话落在她的房间里')
    assert.equal(placed[0].cwd, paths(root).herDir)
    assert.notEqual(placed[0].cwd, root)
    // 用的是屋子里那个会话，不是按天新建的游离会话（2026-10-24 改）
    assert.equal(placed[0].sessionId, 's-house')
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('issue #51：她在会话里回了、但没写事件流，said 与 herReply 都要带回原话', async () => {
  const root = await tmpRoot()
  try {
    await appendEvent({ type: 'seed', text: '起点。' }, { day: 1, stage: 1, source: 'system' }, root)
    const ctx = fakeCtx()
    const handlers = new Map()
    // 假宿主的事件总线：只记 handler，测试里自己 emit（真宿主由 plugin 的 ctx.on 提供）。
    ctx.on = (name, fn) => {
      handlers.set(name, fn)
      return () => handlers.delete(name)
    }
    const emit = (event) => handlers.get('session/event')?.({ header: { id: 's-house' } }, event)
    ctx.sessionController.prompt = async () => {
      // 同一条消息被重放两次（interrupted / 续写），只能算一份。
      const message = { id: 'm-51', content: [{ type: 'text', text: '听得见，两条都收到了。' }] }
      emit({ type: 'assistant/message', data: { message } })
      emit({ type: 'assistant/message', data: { message } })
      emit({ type: 'turn/end' })
    }

    const r = await sayToHer(ctx, '在吗', { root, waitMs: 5_000 })
    assert.equal(r.ok, true)
    // 她没调 growth_commit，事件流里没落盘；但这次回话要带回来，标 uncommitted。
    assert.equal(r.said.length, 1, '同一条消息重放两次也只算一句')
    assert.equal(r.said[0].text, '听得见，两条都收到了。')
    assert.equal(r.said[0].type, 'utterance')
    assert.equal(r.said[0].uncommitted, true, '没认领的话只活在这条返回值里，不落盘')
    assert.equal(r.herReply, '听得见，两条都收到了。')
    assert.match(r.note, /没写进事件流|growth_commit/)
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('她正在醒着时你说话，仍然算你来了（say 不看唤醒窗）', async () => {
  // 与 capture.js 的分工：
  //   capture 里 `if (!inWake())` 是因为「她在窗口内写字」可能只是她自己想事情；
  //   而 sayToHer 只可能由人的动作触发 —— 他真的说了话，这件事不该被
  //   "她恰好也在醒着"抹掉，否则冷落检测会把"你来了"记成"她自言自语"。
  const root = await tmpRoot()
  try {
    await appendEvent({ type: 'seed', text: '起点。' }, { day: 1, stage: 1, source: 'system' }, root)
    const ctx = fakeCtx()
    ctx.sessionController.prompt = async () => {}

    enterWake()
    try {
      await sayToHer(ctx, '喂', { root, waitMs: 500 })
    } finally { leaveWake() }

    const { events } = await readEvents(root)
    const seen = events.filter((e) => e.type === 'meta' && String(e.text).startsWith('seen:'))
    assert.equal(seen.length, 1, '人说的话一定算他来过，与唤醒窗无关')
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('她一言不发也不算失败：ok 但带一句说明', async () => {
  const root = await tmpRoot()
  try {
    await appendEvent({ type: 'seed', text: '起点。' }, { day: 1, stage: 1, source: 'system' }, root)
    const ctx = fakeCtx()
    ctx.sessionController.prompt = async () => {}

    const r = await sayToHer(ctx, '在吗', { root, waitMs: 5_000 })
    assert.equal(r.ok, true)
    assert.deepEqual(r.said, [])
    assert.match(r.note, /没说话/)

    // 她没开口，但他说了话——seen 仍然要有（他来过这件事不以她回不回为前提）
    const { events } = await readEvents(root)
    assert.equal(events.filter((e) => String(e.text).startsWith('seen:')).length, 1)
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('空话与超长话都被挡在门外，不会投进会话', async () => {
  const root = await tmpRoot()
  try {
    const ctx = fakeCtx()
    const a = await sayToHer(ctx, '   ', { root })
    assert.equal(a.ok, false)
    const b = await sayToHer(ctx, 'x'.repeat(4001), { root })
    assert.equal(b.ok, false)
    assert.equal(ctx.calls.length, 0, '不该建会话也不该 prompt')
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('没有 sessionController 时明确说"说不了"，不是静默失败', async () => {
  const root = await tmpRoot()
  try {
    const r = await sayToHer({}, '在吗', { root })
    assert.equal(r.ok, false)
    assert.match(r.note, /说不了/)
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('拿不到屋子时不建游离会话——宁可这句递不出去，也不在侧栏堆「未分组」', async () => {
  // 2026-10-24 用户在 GUI 里看到一串 20 小时前的陌生对话，全是这类游离会话
  // （开发期用测试 home 跑出来的）。它们的共同点是 `sc.create({cwd})` 建的、
  // 没有工作区归属。这条测试锁死：那条退路不存在了。
  const root = await tmpRoot()
  try {
    await appendEvent({ type: 'seed', text: '起点。' }, { day: 1, stage: 1, source: 'system' }, root)
    const ctx = fakeCtx({ house: false }) // 宿主没有 workspaceRegistry
    const r = await sayToHer(ctx, '在吗', { root, waitMs: 5_000 })

    assert.equal(r.ok, false)
    assert.match(r.note, /屋子/)
    assert.equal(
      ctx.calls.filter((c) => c.op === 'create').length,
      0,
      '不该建任何会话（尤其是没有 workspaceId 的那种）',
    )
    assert.equal(ctx.calls.filter((c) => c.op === 'prompt').length, 0, '也不该往会话里塞话')
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('对话不改写日记、不生成报告文件（说话就是说话）', async () => {
  const root = await tmpRoot()
  try {
    await appendEvent({ type: 'seed', text: '起点。' }, { day: 1, stage: 1, source: 'system' }, root)
    const ctx = fakeCtx()
    ctx.sessionController.prompt = async () => { await her(root, 'utterance', '嗯。') }
    await sayToHer(ctx, '在吗', { root, waitMs: 5_000 })
    const dk = new Date().toISOString().slice(0, 10)
    assert.equal(await readDaily('diaryDir', dk, root), null, '对话不该顺手写日记')
    const { events } = await readEvents(root)
    assert.equal(events.some((e) => String(e.text).startsWith('wake:')), false, '对话不是唤醒，不记 wake 配额')
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('发图时提示的那一行是成品 markdown，并且写着别加斜杠（issue #99）', async () => {
  const src = await readFile(new URL('../lib/say.js', import.meta.url), 'utf8')
  assert.match(src, /前面别加斜杠/, '提示里要写明别在前面加斜杠')
  assert.match(src, /!\[图\]\(\$\{imagePath\}\)/, '提示直接给成品，别让她自己拼')
})
