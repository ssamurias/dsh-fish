/**
 * ask.test.mjs —— 请求事件：她有事想征得同意时的一张卡（0.7.6，用户 m01274 / m01292）
 *
 * 为什么单独测这一层：`ask` 与 `grant_offer` 长得像，但边界不同——
 *   - 频率写死在代码里（一天 1 次、一周 3 次），不进配置，否则就成了「让她多问几次」的旋钮；
 *   - 只有 `time` / `rest` 真能改东西，其余 kind 只记录「问过、答过」；
 *   - 一条只能答一次；被驳回只记 `ask-no:`，不重提。
 * 这里把这几条边界钉住，顺带钉观测台 `/ask` 的读写。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import {
  ASK_KINDS,
  askChoiceIndex,
  askView,
  pendingAsks,
  quotaOf,
  restedToday,
  settleAsk,
  settleStaleAsks,
} from '../lib/ask.js'
import { picked } from '../lib/askinchat.js'
import { dateKey, loadConfig } from '../lib/settings.js'
import { readConfig, readEvents } from '../lib/store.js'
import { validateEvent } from '../lib/schema.js'
import { registerObserve } from '../lib/observe.js'
import { HER_TOOLS, currentToolSurface } from '../lib/restrict.js'
import { ASK_BRIEF } from '../lib/persona.js'

async function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'fish-ask-'))
  try {
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'events.jsonl'), '', 'utf8')
    return await fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

/** 直接写一条 ask 进去（模拟工具那一侧已经问出来的状态）。 */
function seedAsk(root, { id = 'ev_ask1', kind = 'other', text = '我想问一件事。', value, ts, day } = {}) {
  const at = ts ?? new Date()
  const ev = {
    id,
    v: 1,
    ts: at.toISOString(),
    day: day ?? dateKey(at),
    stage: 1,
    type: 'ask',
    source: 'system',
    text,
    refs: [],
    verdict: null,
    confidence: 0.5,
    flags: [],
    ask: { kind, ...(value ? { value } : {}) },
  }
  appendFileSync(join(root, 'events.jsonl'), `${JSON.stringify(ev)}\n`, 'utf8')
  return ev
}

test('配额：一天问一次、一周三次，写死在代码里', async () => withRoot(async (root) => {
  const now = Date.now()
  seedAsk(root, { id: 'a1', ts: new Date(now), day: dateKey(new Date(now)) })
  const q = quotaOf((await readEvents(root)).events, { now })
  assert.equal(q.ok, false)
  assert.match(q.why, /今天/)

  // 昨天到今天之前问过三次：今天没问，但这一周已经用满
  const root2 = mkdtempSync(join(tmpdir(), 'fish-ask2-'))
  try {
    mkdirSync(root2, { recursive: true })
    writeFileSync(join(root2, 'events.jsonl'), '', 'utf8')
    for (let i = 1; i <= 3; i++) {
      const at = new Date(now - i * 24 * 3600 * 1000)
      seedAsk(root2, { id: `b${i}`, ts: at, day: dateKey(at) })
    }
    const q2 = quotaOf((await readEvents(root2)).events, { now })
    assert.equal(q2.ok, false)
    assert.match(q2.why, /这周/)
  } finally {
    rmSync(root2, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}))

test('同意时间请求：真的改配置，并留一条 ask-time 记账', async () => withRoot(async (root) => {
  const ask = seedAsk(root, {
    kind: 'time',
    text: '我想把醒着的时间挪到晚上九点以后。',
    value: { wakesPerDay: 2, window: ['21:00', '22:30'] },
  })
  const r = await settleAsk(root, { askId: ask.id, verdict: 'approve' })
  assert.equal(r.ok, true, r.why)

  const cfg = await readConfig(root)
  assert.equal(cfg.wakesPerDay, 2)
  assert.deepEqual(cfg.window, ['21:00', '22:30'])

  const { events } = await readEvents(root)
  const answer = events.find((e) => e.type === 'answer')
  assert.ok(answer, '必须有 answer')
  assert.equal(answer.source, 'system')
  assert.equal(answer.ask.verdict, 'approve')
  assert.equal(answer.ask.askId, ask.id)
  assert.ok(events.some((e) => e.type === 'meta' && String(e.text).startsWith('ask-time:')), '要留 ask-time')
}))

test('同意休息请求：今天家里不叫她', async () => withRoot(async (root) => {
  const ask = seedAsk(root, { kind: 'rest', text: '我今天不太想醒，可以吗。' })
  const r = await settleAsk(root, { askId: ask.id, verdict: 'approve' })
  assert.equal(r.ok, true, r.why)
  const { events } = await readEvents(root)
  assert.ok(restedToday(events, dateKey()), 'restedToday 要认 rest:<dk>')
}))

test('驳回：只记 ask-no，什么都别改', async () => withRoot(async (root) => {
  const ask = seedAsk(root, {
    kind: 'time',
    text: '我想改一下作息。',
    value: { wakesPerDay: 3, window: ['01:00', '02:00'] },
  })
  const before = (await loadConfig(root)).config
  const r = await settleAsk(root, { askId: ask.id, verdict: 'reject', reason: '这个点不合适。' })
  assert.equal(r.ok, true, r.why)
  const after = (await loadConfig(root)).config
  assert.equal(after.wakesPerDay, before.wakesPerDay)
  assert.deepEqual(after.window, before.window)

  const { events } = await readEvents(root)
  assert.ok(events.some((e) => e.type === 'meta' && e.text === `ask-no:${ask.id}`))
  assert.ok(!events.some((e) => e.type === 'meta' && String(e.text).startsWith('rest:')), '驳回不能当放假')
}))

test('「以后再说」要记成 ask-later，别跟驳回混在一起', async () => withRoot(async (root) => {
  const ask = seedAsk(root, { kind: 'other', text: '想问你一件事。' })
  const r = await settleAsk(root, { askId: ask.id, verdict: 'later', via: 'ui' })
  assert.equal(r.ok, true, r.why)
  const { events } = await readEvents(root)
  assert.ok(events.some((e) => e.type === 'meta' && e.text === `ask-later:${ask.id}`), '要留 ask-later')
  assert.ok(!events.some((e) => e.type === 'meta' && e.text === `ask-no:${ask.id}`), 'later 不是驳回')
  const view = askView(events, Date.now())
  assert.equal(view.find((x) => x.id === ask.id).verdict, 'later')
}))

test('一条只能答一次', async () => withRoot(async (root) => {
  const ask = seedAsk(root, { kind: 'other', text: '能问一句吗。' })
  assert.equal((await settleAsk(root, { askId: ask.id, verdict: 'approve' })).ok, true)
  const twice = await settleAsk(root, { askId: ask.id, verdict: 'reject' })
  assert.equal(twice.ok, false)
  assert.match(twice.why, /答过/)
}))

test('超过 24 小时没答：落成 later，不再挂在待答里', async () => withRoot(async (root) => {
  const old = seedAsk(root, { id: 'ev_old', kind: 'need-file', ts: new Date(Date.now() - 25 * 3600 * 1000) })
  const n = await settleStaleAsks(root, { now: Date.now() })
  assert.equal(n, 1)
  const { events } = await readEvents(root)
  const answer = events.find((e) => e.type === 'answer' && e.ask.askId === old.id)
  assert.ok(answer, '超时要落一条 later')
  assert.equal(answer.ask.verdict, 'later')
  assert.equal(answer.ask.via, 'timeout')
  assert.equal(pendingAsks(events).length, 0)
}))

test('她自己写不了 ask 事件：只有宿主能写', () => {
  assert.throws(
    () => validateEvent({ type: 'ask', text: '我想自己批准一件事。', ask: { kind: 'other' } }, { source: 'tool', day: 1, stage: 1 }),
    /NOT_HER_TYPE|不可以写/,
  )
})

test('观测台 /ask：GET 带列表与配额，POST 能补答', async () => withRoot(async (root) => {
  const ask = seedAsk(root, { kind: 'rest', text: '我想歇一天。' })
  const routes = new Map()
  const ctx = {
    get(name) {
      if (name === 'connection') return { requestRejection: () => null }
      if (name === 'webServer') return { register(ex) { routes.set(ex.path, ex.handler); return () => {} } }
      if (name === 'agents') return { get: () => null, list: () => [] }
      if (name === 'workspaceRegistry') return { list: () => [] }
      return undefined
    },
  }
  registerObserve(ctx, { root })

  async function call(method, body = {}) {
    const handler = routes.get('/dsh-fish/ask')
    assert.ok(handler, '/ask 路由要注册上')
    const req = method === 'POST'
      ? Object.assign(Readable.from([Buffer.from(JSON.stringify(body), 'utf8')]), { method, headers: {} })
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

  const g1 = await call('GET')
  assert.equal(g1.status, 200)
  assert.equal(g1.json.kinds.length, ASK_KINDS.length)
  assert.equal(g1.json.pending.length, 1)
  assert.equal(g1.json.pending[0].id, ask.id)
  assert.equal(g1.json.items.length, 1)
  assert.equal(askView((await readEvents(root)).events).length, 1)

  const p = await call('POST', { action: 'answer', askId: ask.id, verdict: 'reject' })
  assert.equal(p.status, 200, JSON.stringify(p.json))

  const g2 = await call('GET')
  assert.equal(g2.json.pending.length, 0)
  assert.equal(g2.json.items[0].verdict, 'reject')

  // 别的地方先答过时，页面要读得到原因：jpost 只认 error，不认 why
  const again = await call('POST', { action: 'answer', askId: ask.id, verdict: 'approve' })
  assert.equal(again.status, 409)
  assert.match(again.json.error, /答过/)
}))

test('她得知道自己有 ask_owner：白名单、手边清单、身份文档三处都写上', () => {
  // 用户 m01559：工具注册了、但收窄白名单/提示词没跟上，她等于没有这个工具。
  assert.ok(HER_TOOLS.includes('ask_owner'), '收窄名单里得有它，否则她根本看不见')
  assert.match(currentToolSurface(), /ask_owner/, '「手边有什么」那段要念到它')
  assert.match(ASK_BRIEF, /ask_owner/)
  assert.match(ASK_BRIEF, /一天最多一次/, '上限要告诉她，不然被挡下时她会以为工具坏了')
  // 说明书得真的挂进身份文档（selfdoc 落盘的那份），否则她读到的是别的工具。
  const selfdoc = readFileSync(new URL('../lib/selfdoc.js', import.meta.url), 'utf8')
  assert.match(selfdoc, /ASK_BRIEF/, '身份文档里没挂说明书，等于还是不知道')
})

test('卡片回来的是对象还是字符串都要认出来，认不出也别装作答过', () => {
  // 2026-10-30 真机（用户 m01756）：她问了一次，卡片消失了，事件流里却没有 answer 行。
  // 原因是宿主回传的 selected[0] 是 {label}，旧代码 String(obj) 得到 "[object Object]"，
  // 于是永远对不上选项，被当成「没答」。这里把几种形状都钉住。
  const opts = ['可以，给我一个能看全片的工具', '这次不行，继续抽帧']
  assert.equal(askChoiceIndex(opts, opts[1]), 1, '字符串要认')
  assert.equal(askChoiceIndex(opts, ` ${opts[0]} `), 0, '首尾空白要吃')
  assert.equal(askChoiceIndex(opts, { label: opts[0] }), 0, '对象要拆 label')
  assert.equal(askChoiceIndex(opts, { value: opts[1] }), 1, '对象要拆 value')
  assert.equal(askChoiceIndex(opts, '1'), 1, '纯数字当下标')
  assert.equal(askChoiceIndex(opts, '好呀'), -1, '认不出就说认不出，不要猜')
  assert.equal(askChoiceIndex(opts, ''), -1)

  assert.equal(picked([{ id: 'q', selected: [{ label: '可以' }] }], 'q'), '可以')
  assert.equal(picked([{ id: 'q', selected: ['这次不行'] }], 'q'), '这次不行')
  assert.equal(picked([{ id: 'q', custom: ' 我自己写 ' }], 'q'), '我自己写')
  assert.equal(picked([], 'q'), '')
})

// ---- issue #35：他直接在卡片里打字回答，不能当成「没答」 ----
// 宿主（dsh-user-questions 0.2.2-rc.1）约定：custom 覆盖选项时 `selected` 传空数组。
// 旧代码 `Array.isArray(one?.selected) ? one.selected[0] : one?.custom` 拿到 `[]` 就取
// `undefined`，永远走不到 custom —— 于是手打的答案一律记成 NO_MATCH，事件流里没有 answer 行。
// 另一半：`raw` 以前把整段回执 JSON 写进日志，他手打的私事就那样落进 dsh-fish.log。

/** 假宿主：够了 ask.js 需要的三样——工具注册、live agent、提问服务。 */
function askCtx(answer) {
  const regs = new Map()
  const agent = { id: 'session-abc' }
  return {
    regs,
    tools: { register: (spec) => { regs.set(spec.name, spec); return () => regs.delete(spec.name) } },
    get: (name) => (name === 'agents'
      ? { get: () => agent, list: () => [agent], roots: () => [agent] }
      : undefined),
    userQuestions: { ask: async ({ questions }) => answer(questions) },
  }
}

test('卡片里手打的答案能认出来，并落一条 answer（issue #35）', async () => withRoot(async (root) => {
  const { registerAsk } = await import('../lib/ask.js')
  // 选项都不选、直接打字：宿主回的是 selected: [] + custom
  const ctx = askCtx(([q]) => ({ answers: [{ id: q.id, selected: [], custom: '可以' }] }))
  registerAsk(ctx, { root })
  const tool = ctx.regs.get('ask_owner')
  assert.ok(tool, '工具必须注册')

  const out = await tool.execute(
    { question: '今天能不能歇一天。', kind: 'rest' },
    { agent: { session: { id: 'session-abc' } } },
  )
  assert.equal(out.ok, true)
  assert.equal(out.said, 'approved', '手打的「可以」= 选了第一个选项（修之前这里是空串）')

  const { events } = await readEvents(root)
  const answer = events.find((e) => e.type === 'answer')
  assert.ok(answer, '事件流里要有 answer 行（修之前这里没有）')
  assert.equal(answer.ask.verdict, 'approve')
}))

test('认不出的回答不落地原文：日志只留回执形状（issue #35）', async () => withRoot(async (root) => {
  const { registerAsk } = await import('../lib/ask.js')
  const secret = '我今天心情很不好，因为家里那件事，不想细说'
  const ctx = askCtx(([q]) => ({ answers: [{ id: q.id, selected: [], custom: secret }] }))
  registerAsk(ctx, { root })
  const tool = ctx.regs.get('ask_owner')

  const out = await tool.execute(
    { question: '能不能换个作息。', kind: 'time', wakesPerDay: 2, options: ['可以', '这次不行'] },
    { agent: { session: { id: 'session-abc' } } },
  )
  assert.equal(out.ok, true, '认不出也是一次有效的提问')
  assert.equal(out.said, '', '认不出就说认不出，不冒充答过')

  const log = readFileSync(join(root, 'logs', 'dsh-fish.log'), 'utf8')
  assert.ok(log.includes('回执形状'), '日志里要有排障用的形状摘要')
  assert.ok(!log.includes(secret), '他手打的原文不许进日志')
  assert.ok(log.includes(`"custom":${secret.length}`), '但要留下长度，够定位是哪种形状')
}))
