/**
 * cardanswer.test.mjs —— 卡片被别的插件接走（dsh-fish/card）、回答送回来（dsh-fish/answer）
 *
 * 人不在她那条会话前的部署：卡片他看不见，她这一轮还白等 5 分钟。守这几件事：
 *   1. 只有回了 { via } 才算接走；没人接、抛错、拒绝、超时都退回卡片，绝不抛；
 *   2. 接走了不弹卡、不等，回执写清楚送到哪儿了、还没答；
 *   3. 回答隔几个小时、中间重启过都能结算，走的是观测台和卡片同一条路，只结算一次；
 *      回的不是选项就不结算，卡还开着；
 *   4. 接卡的插件不认任何具体的 IM，也不用知道 dsh-fish 的包名。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { askInChat } from '../lib/askinchat.js'
import { registerAsk, restedToday, settleAsk, settleStaleAsks } from '../lib/ask.js'
import { answerCard } from '../lib/cardanswer.js'
import { registerBringBack, YES as KEEP_YES, NO as KEEP_NO } from '../lib/keep.js'
import { askKeepsake, pendingKeepsakes, readKeepsakes } from '../lib/keepsake.js'
import { dateKey, loadConfig } from '../lib/settings.js'
import { appendEvent, readEvents } from '../lib/store.js'

const ONE = [{ id: 'q', header: '想问', question: '行吗', options: [{ label: '可以' }, { label: '这次不行' }] }]

async function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'fish-card-'))
  try {
    writeFileSync(join(root, 'events.jsonl'), '', 'utf8')
    return await fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

/** 假上下文：活着的 agent、记下提问的宿主服务、可以换的 bail。 */
function fakeCtx(bail) {
  const agent = { id: 'session-abc' }
  const asked = []
  const ctx = {
    get: (name) => (name === 'agents'
      ? { get: (id) => (id === 'session-abc' ? agent : undefined), list: () => [agent], roots: () => [agent] }
      : undefined),
    userQuestions: { ask: async (req) => { asked.push(req); return { answers: [{ id: 'q', selected: ['可以'] }] } } },
    ...(bail ? { bail } : {}),
    tools: { register: (spec) => { ctx.spec = spec; return () => {} } },
  }
  return { ctx, asked }
}

test('dsh-fish/card：接走了不弹卡，插件拿到 id、会话、问题和「为什么」', async () => {
  const cards = []
  const { ctx, asked } = fakeCtx((name, card) => {
    assert.equal(name, 'dsh-fish/card')
    cards.push(card)
    return Promise.resolve({ via: 'QQ 私聊' })
  })
  const r = await askInChat(ctx, { sessionId: 'session-abc', questions: ONE, cardId: 'ask:ev_1', detail: '想核对' })
  assert.deepEqual(r, { ok: false, code: 'RELAYED', via: 'QQ 私聊' })
  assert.equal(asked.length, 0)
  assert.deepEqual(cards, [{ id: 'ask:ev_1', sessionId: 'session-abc', questions: ONE, detail: '想核对' }])
})

test('dsh-fish/card：同步监听回 { via } 也算接走', async () => {
  const { ctx, asked } = fakeCtx(() => ({ via: 'Telegram' }))
  const r = await askInChat(ctx, { sessionId: 'session-abc', questions: ONE, cardId: 'ask:ev_1' })
  assert.equal(r.via, 'Telegram')
  assert.equal(asked.length, 0)
})

test('dsh-fish/card：没给 cardId 就不问别的插件', async () => {
  let calls = 0
  const { ctx, asked } = fakeCtx(() => { calls += 1; return { via: 'QQ' } })
  const r = await askInChat(ctx, { sessionId: 'session-abc', questions: ONE })
  assert.equal(calls, 0)
  assert.equal(r.ok, true)
  assert.equal(asked.length, 1)
})

for (const [name, bail] of [
  ['没人接', () => undefined],
  ['回了 false', () => false],
  ['回了别的东西', () => ({ taken: true })],
  ['via 不是字符串', () => ({ via: 42 })],
  ['via 是空白', () => Promise.resolve({ via: '  ' })],
  ['Promise 里没接', () => Promise.resolve(undefined)],
  ['同步抛错', () => { throw new Error('发不出去') }],
  ['Promise 拒绝', () => Promise.reject(new Error('发不出去'))],
]) {
  test(`dsh-fish/card：${name}，卡片照常弹`, async () => {
    const { ctx, asked } = fakeCtx(bail)
    const r = await askInChat(ctx, { sessionId: 'session-abc', questions: ONE, cardId: 'ask:ev_1' })
    assert.equal(r.ok, true)
    assert.equal(asked.length, 1)
  })
}

test('dsh-fish/card：超时算没接，超时之后才拒绝也不会变成未处理的拒绝', async () => {
  const seen = []
  const onReject = (err) => seen.push(err)
  process.on('unhandledRejection', onReject)
  try {
    let reject
    const { ctx, asked } = fakeCtx(() => new Promise((_, no) => { reject = no }))
    const r = await askInChat(ctx, { sessionId: 'session-abc', questions: ONE, cardId: 'ask:ev_1', relayWaitMs: 5 })
    assert.equal(r.ok, true)
    assert.equal(asked.length, 1)
    reject(new Error('太晚了'))
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.deepEqual(seen, [])
  } finally {
    process.off('unhandledRejection', onReject)
  }
})

test('dsh-fish/card：这一轮已经被取消就不打扰人', async () => {
  let calls = 0
  const { ctx } = fakeCtx(() => { calls += 1; return { via: 'QQ' } })
  await askInChat(ctx, { sessionId: 'session-abc', questions: ONE, cardId: 'ask:ev_1', signal: AbortSignal.abort() })
  assert.equal(calls, 0)
})

/** 她调一次 ask_owner，卡被接走。 */
async function askRelayed(root, args = {}) {
  const { ctx, asked } = fakeCtx(() => Promise.resolve({ via: 'QQ 私聊' }))
  registerAsk(ctx, { root })
  const out = await ctx.spec.execute(
    { question: '能给我这个工具吗', kind: 'need-tool', subject: 'x', why: '想先核对', ...args },
    { session: { header: { id: 'session-abc' } }, agent: { session: { id: 'session-abc' } } },
  )
  return { out, asked, spec: ctx.spec }
}

test('ask_owner：接走了当场回执，写清楚送到哪儿、还没答，不白等也不算没结算', async () => {
  await withRoot(async (root) => {
    const { out, asked, spec } = await askRelayed(root)
    assert.equal(out.ok, true)
    assert.equal(out.said, 'relayed')
    assert.equal(out.via, 'QQ 私聊')
    assert.equal(asked.length, 0)
    assert.equal(spec.output.render({}, out)[0].text, '[已问，送到了QQ 私聊，还没答]')
    const { events } = await readEvents(root)
    assert.equal(events.filter((e) => e.type === 'ask').length, 1)
    assert.equal(events.filter((e) => e.type === 'answer').length, 0)
    assert.equal(existsSync(join(root, 'logs')) && readFileSync(join(root, 'logs', 'dsh-fish.log'), 'utf8').includes('没结算'), false)
  })
})

test('dsh-fish/answer：隔多久答都能结算，选项对上第几个就是第几种', async () => {
  await withRoot(async (root) => {
    const { out } = await askRelayed(root, { options: ['可以', '这次不行', '再想想'] })
    const r = await answerCard(root, { id: `ask:${out.askId}`, selected: ['这次不行'] })
    assert.deepEqual(r, { ok: true })
    const { events } = await readEvents(root)
    const a = events.find((e) => e.type === 'answer')
    assert.equal(a.ask.verdict, 'reject')
    assert.equal(a.ask.via, 'relay')
    assert.ok(events.some((e) => e.type === 'meta' && e.text === `ask-no:${out.askId}`))
  })
})

test('dsh-fish/answer：只结算一次，第二次说明原因', async () => {
  await withRoot(async (root) => {
    const { out } = await askRelayed(root)
    assert.equal((await answerCard(root, { id: `ask:${out.askId}`, selected: ['可以'] })).ok, true)
    const again = await answerCard(root, { id: `ask:${out.askId}`, selected: ['这次不行'] })
    assert.equal(again.ok, false)
    assert.match(again.why, /答过/)
  })
})

test('dsh-fish/answer：放了一天才答，说的是放了一天，不是答过了', async () => {
  await withRoot(async (root) => {
    const { out } = await askRelayed(root)
    assert.equal(await settleStaleAsks(root, { now: Date.now() + 25 * 3600 * 1000 }), 1)
    const late = await answerCard(root, { id: `ask:${out.askId}`, selected: ['可以'] })
    assert.equal(late.ok, false)
    assert.match(late.why, /放了一天没人答/)
    assert.doesNotMatch(late.why, /答过/)
  })
})

test('settleAsk：几条路同时答，只有第一条算', async () => {
  await withRoot(async (root) => {
    const { out } = await askRelayed(root)
    const rs = await Promise.all([
      answerCard(root, { id: `ask:${out.askId}`, selected: ['可以'] }),
      answerCard(root, { id: `ask:${out.askId}`, selected: ['这次不行'] }),
      settleAsk(root, { askId: out.askId, verdict: 'later', via: 'ui' }),
      settleStaleAsks(root, { now: Date.now() + 25 * 3600 * 1000 }),
    ])
    assert.equal(rs.slice(0, 3).filter((r) => r.ok).length, 1)
    assert.equal(rs[3], 0)
    const { events } = await readEvents(root)
    assert.equal(events.filter((e) => e.type === 'answer').length, 1)
    assert.equal(events.filter((e) => e.type === 'meta' && /^ask-/.test(e.text)).length, 1)
  })
})

test('dsh-fish/answer：没选、对不上选项都不结算，这张卡还能答', async () => {
  await withRoot(async (root) => {
    const { out } = await askRelayed(root)
    const id = `ask:${out.askId}`
    for (const bad of [{ id }, { id, selected: [] }, { id, selected: [], custom: '可以，不过这是私事' }, { id, selected: ['当然'] }]) {
      assert.equal((await answerCard(root, bad)).ok, false, JSON.stringify(bad))
    }
    const raw = readFileSync(join(root, 'events.jsonl'), 'utf8')
    assert.ok(!raw.includes('私事'))
    assert.equal((await readEvents(root)).events.filter((e) => e.type === 'answer').length, 0)
    assert.deepEqual(await answerCard(root, { id, selected: ['可以'] }), { ok: true })
  })
})

test('ask_owner：选项太长也能答回来，卡上的字和账上一样', async () => {
  await withRoot(async (root) => {
    const long = '可以，不过只改今天晚上这一次，明天起恢复原来的作息时间吧'
    const cards = []
    const { ctx } = fakeCtx((_, card) => { cards.push(card); return { via: 'QQ 私聊' } })
    registerAsk(ctx, { root })
    const out = await ctx.spec.execute(
      { question: '能换吗', kind: 'other', options: [long, '这次不行'] },
      { session: { header: { id: 'session-abc' } }, agent: { session: { id: 'session-abc' } } },
    )
    const label = cards[0].questions[0].options[0].label
    assert.equal(label, long.slice(0, 24))
    assert.deepEqual(await answerCard(root, { id: `ask:${out.askId}`, selected: [label] }), { ok: true })
    assert.equal((await readEvents(root)).events.find((e) => e.type === 'answer').ask.verdict, 'approve')
  })
})

test('kind=rest：隔天才答应，歇的是她问的那一天，不是答的这一天', async () => {
  await withRoot(async (root) => {
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000)
    writeFileSync(join(root, 'events.jsonl'), JSON.stringify({
      id: 'ev_rest1', v: 1, ts: yesterday.toISOString(), day: 3, stage: 1, type: 'ask', source: 'system', text: '今天能歇吗', refs: [], verdict: null, confidence: 0.5, flags: [],
      ask: { kind: 'rest', subject: '', options: ['可以', '这次不行'], reason: '' },
    }) + '\n', 'utf8')
    assert.deepEqual(await answerCard(root, { id: 'ask:ev_rest1', selected: ['可以'] }), { ok: true })
    const { events } = await readEvents(root)
    assert.equal(restedToday(events, dateKey(yesterday)), true)
    assert.equal(restedToday(events), false)
  })
})

test('kind=time：卡上写着答应了会改成什么，不止她那句话', async () => {
  await withRoot(async (root) => {
    const cards = []
    const { ctx } = fakeCtx((_, card) => { cards.push(card); return { via: 'QQ 私聊' } })
    registerAsk(ctx, { root })
    const out = await ctx.spec.execute(
      { question: '我想换个作息', kind: 'time', wakesPerDay: 2, window: ['09:00', '21:00'] },
      { session: { header: { id: 'session-abc' } }, agent: { session: { id: 'session-abc' } } },
    )
    assert.equal(cards[0].questions[0].question, '我想换个作息（答应了就改成：每天醒 2 次，09:00–21:00）')
    assert.deepEqual(await answerCard(root, { id: `ask:${out.askId}`, selected: ['可以'] }), { ok: true })
    const { config } = await loadConfig(root)
    assert.equal(config.wakesPerDay, 2)
    assert.deepEqual(config.window, ['09:00', '21:00'])
  })
})

test('dsh-fish/answer：乱七八糟的回答只报原因，绝不抛', async () => {
  await withRoot(async (root) => {
    for (const bad of [undefined, null, 3, {}, { id: '' }, { id: 'ask' }, { id: 'ask:' }, { id: 'nope:1', selected: ['可以'] }, { id: 'ask:ev_none', selected: ['可以'] }, { id: 'ask:ev_none' }]) {
      const r = await answerCard(root, bad)
      assert.equal(r.ok, false, JSON.stringify(bad))
      assert.equal(typeof r.why, 'string')
    }
  })
})

test('bring_back：卡被接走时账上还挂着，答了才动文件', async () => {
  await withRoot(async (root) => {
    const cwd = join(root, 'ws')
    mkdirSync(cwd, { recursive: true })
    writeFileSync(join(cwd, 'notes.txt'), 'a note\n', 'utf8')
    const outing = { sessionId: 'session-abc', workspaceId: 'w-1', workspaceName: '素材区', cwd, startedAt: 1_700_000_000_000, status: 'active' }
    const a = askKeepsake(root, { outing, sessionId: 'session-abc', rel: 'notes.txt', why: '想学' })
    assert.equal(a.ok, true)
    const id = `keepsake:${a.item.id}`
    // 没选、对不上：还挂着
    assert.equal((await answerCard(root, { id, selected: [] })).ok, false)
    assert.equal((await answerCard(root, { id, selected: ['当然'] })).ok, false)
    assert.equal(pendingKeepsakes(root).length, 1)
    assert.deepEqual(await answerCard(root, { id, selected: [KEEP_YES] }), { ok: true })
    assert.equal(pendingKeepsakes(root).length, 0)
    assert.notEqual(readKeepsakes(root).items.find((it) => it.id === a.item.id)?.status, 'asked')
    assert.equal((await answerCard(root, { id, selected: [KEEP_NO] })).ok, false)
  })
})

test('规矩申请：只认还在等的那一张', async () => {
  await withRoot(async (root) => {
    const ctxArg = { day: 1, stage: 1, source: 'system' }
    const offer = await appendEvent({ type: 'grant_offer', text: '想试试', grant: { rule: 'some-rule' } }, ctxArg, root)
    assert.equal((await answerCard(root, { id: 'grant:ev_other', selected: ['可以'] })).ok, false)
    assert.equal((await answerCard(root, { id: `grant:${offer.id}`, selected: [] })).ok, false)
    assert.deepEqual(await answerCard(root, { id: `grant:${offer.id}`, selected: ['这次不行'] }), { ok: true })
    const { events } = await readEvents(root)
    assert.equal(events.find((e) => e.type === 'grant')?.grant?.verdict, 'reject')
    assert.equal((await answerCard(root, { id: `grant:${offer.id}`, selected: ['可以'] })).ok, false)
  })
})

test('bring_back：卡被接走就当场回话，不等 5 分钟，账上挂着', async () => {
  await withRoot(async (root) => {
    const cwd = join(root, 'ws')
    mkdirSync(cwd, { recursive: true })
    writeFileSync(join(cwd, 'notes.txt'), 'a note\n', 'utf8')
    writeFileSync(join(root, 'outings.json'), JSON.stringify({ version: 1, outings: [{ sessionId: 'session-abc', workspaceId: 'w-1', workspaceName: '素材区', cwd, startedAt: Date.now(), status: 'active' }] }), 'utf8')
    const cards = []
    const { ctx, asked } = fakeCtx((_, card) => { cards.push(card); return { via: 'QQ 私聊' } })
    registerBringBack(ctx, { root, tenant: { root, herDir: join(root, 'her'), tenant: { ok: true } } })
    const out = await ctx.spec.execute({ path: 'notes.txt', why: '想学' }, { session: { header: { id: 'session-abc', cwd } }, cwd })
    assert.equal(out.ok, true, out.note)
    assert.equal(asked.length, 0)
    assert.equal(cards.length, 1)
    assert.match(cards[0].id, /^keepsake:/)
    assert.match(out.note, /等他点头/)
    assert.equal(pendingKeepsakes(root).length, 1)
  })
})

test('启动时挂上 dsh-fish/answer：别的插件不用知道包名就能送回答', async () => {
  await withRoot(async (root) => {
    const listeners = new Map()
    const { ctx } = fakeCtx()
    const seen = { ...ctx, on: (name, fn) => { listeners.set(name, fn); return () => {} }, logger: { info() {}, warn() {}, error() {} }, webServer: { register: () => () => {} }, connection: { requestRejection: () => null } }
    seen.tools = { register: () => () => {} }
    seen.get = (key) => seen[key]
    const prev = process.env.DSH_FISH_HOMES
    process.env.DSH_FISH_HOMES = join(root, 'homes.json')
    const { apply } = await import('../lib/index.js')
    const h = apply(seen, { root })
    try {
      await new Promise((resolve) => setTimeout(resolve, 120))
      const fn = listeners.get('dsh-fish/answer')
      assert.equal(typeof fn, 'function')
      const ev = await appendEvent({ type: 'ask', text: '问一句', ask: { kind: 'other', options: ['可以', '这次不行'] } }, { day: 1, stage: 1, source: 'system' }, root)
      assert.deepEqual(await fn({ id: `ask:${ev.id}`, selected: ['可以'] }), { ok: true })
    } finally {
      h.dispose?.()
      if (prev === undefined) delete process.env.DSH_FISH_HOMES
      else process.env.DSH_FISH_HOMES = prev
    }
  })
})
