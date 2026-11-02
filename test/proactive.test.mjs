/**
 * proactive.test.mjs —— 她主动开口（0.8.1 本机实验，用户 m04610，只在 .dev 下启用）
 *
 * 为什么单独测：这一层最容易长成「系统命令她说话」。
 * 这里钉住四条边界：
 *   - 触发只是开门，不是任务（prompt 里可以什么都不做，不含「你应该」）；
 *   - 她说的话必须指回真实事件（refs 1–6 条，且得是她自己的话/听见的话）；
 *   - 频率是上限（一天最多几次、冷却几小时），不是每天必须说；
 *   - 工具默认不在白名单里，只有 .dev + 开关打开才会出现。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  PROACTIVE_MAX,
  PROACTIVE_TRIGGER,
  proactiveConfig,
  proactiveSection,
  proactiveState,
  turnsToday,
  lastTurnAt,
  idleHoursOf,
  countsForIdle,
  looseEnds,
  recentMaterial,
  findTriggerSeq,
  hideTrigger,
  sweepTriggers,
  openTurnOf,
  flushPendingHides,
  pendingHidesOf,
  resetPendingHides,
  registerProactive,
  writeSay,
} from '../lib/proactive.js'
import { dateKey } from '../lib/settings.js'
import { readEvents } from '../lib/store.js'
import { HER_TOOLS } from '../lib/restrict.js'

async function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'fish-proactive-'))
  try {
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'events.jsonl'), '', 'utf8')
    return await fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

function line(root, ev) {
  appendFileSync(join(root, 'events.jsonl'), `${JSON.stringify({ v: 1, stage: 1, refs: [], verdict: null, confidence: 0.5, flags: [], ...ev })}\n`, 'utf8')
}

/** 事件数组直接造出来，避免每个用例都落一次盘。 */
function ev(over = {}) {
  const now = Date.now()
  return {
    id: 'ev_x',
    v: 1,
    ts: new Date(now).toISOString(),
    day: dateKey(new Date(now)),
    stage: 1,
    type: 'utterance',
    source: 'tool',
    text: '一句话',
    refs: [],
    verdict: null,
    confidence: 0.5,
    flags: [],
    ...over,
  }
}

const ON = { proactive: { enabled: true } }

test('六种不该开口的情况各有各的理由，别混成一句「不到时候」', () => {
  const now = Date.now()
  const old = new Date(now - 10 * 3_600_000).toISOString()
  const quiet = [ev({ ts: old })]

  assert.match(proactiveState({ config: {}, events: quiet, now }).why, /关着/)
  assert.match(proactiveState({ config: ON, events: quiet, now, away: { kind: 'outing' } }).why, /不在家/)
  assert.match(proactiveState({ config: ON, events: quiet, now, rested: true }).why, /请了假/)

  const used = [ev({ ts: old }), ev({ id: 'ev_t1', type: 'meta', text: `proactive-turn:${dateKey(new Date(now))}:1`, ts: new Date(now - 3 * 3_600_000).toISOString() }), ev({ id: 'ev_t2', type: 'meta', text: `proactive-turn:${dateKey(new Date(now))}:2`, ts: new Date(now - 2 * 3_600_000).toISOString() })]
  assert.match(proactiveState({ config: ON, events: used, now }).why, /上限/)

  const cooling = [ev({ ts: old }), ev({ id: 'ev_t', type: 'meta', text: `proactive-turn:${dateKey(new Date(now))}:x`, ts: new Date(now - 30 * 60_000).toISOString() })]
  assert.match(proactiveState({ config: ON, events: cooling, now }).why, /冷却/)

  const fresh = [ev({ ts: new Date(now - 60_000).toISOString() })]
  assert.match(proactiveState({ config: ON, events: fresh, now }).why, /还不到时候/)

  // 时间窗：她醒着的时段之外不开口。凌晨三点的一句「我想你了」不是自主，是作息被打乱。
  const away = (new Date(now).getHours() + 2) % 24
  const win = [`${String(away).padStart(2, '0')}:00`, `${String((away + 1) % 24).padStart(2, '0')}:00`]
  assert.match(proactiveState({ config: { ...ON, window: win }, events: quiet, now }).why, /时段/)
})

test('概率随「多久没说话」上升，但有上限；配置读进来会夹紧', () => {
  const now = Date.now()
  const hours = (h) => ev({ ts: new Date(now - h * 3_600_000).toISOString() })
  const a = proactiveState({ config: ON, events: [hours(7)], now })
  const b = proactiveState({ config: ON, events: [hours(20)], now })
  assert.equal(a.ok, true)
  assert.ok(b.chance > a.chance, '越久没说话，越可能开口')
  assert.ok(b.chance <= proactiveConfig(ON).maxChance)

  const far = proactiveState({ config: { proactive: { enabled: true, maxChance: 0.3 } }, events: [hours(99)], now })
  assert.ok(far.chance <= 0.3, '封顶必须生效，不然久了就必触发')

  const clamped = proactiveConfig({ proactive: { maxPerDay: 99, minIdleHours: -5, baseChance: 7 } })
  assert.equal(clamped.maxPerDay, 12)
  assert.equal(clamped.minIdleHours, 0)
  assert.equal(clamped.baseChance, 1)
})

test('空手回合的正文只说事实和许可，不写「你应该」', () => {
  const text = proactiveSection({ now: Date.now(), state: { idleHours: 9.5, chance: 0.3 }, material: [{ id: 'ev_a', type: 'utterance', text: '今天有点累' }], loose: [{ id: 'ev_b', text: '你问过一件事，还没答复。' }] })
  assert.match(text, /没有人跟你说话/)
  assert.match(text, /想说什么就说/)
  assert.match(text, /他看得见/, '得说她的话有收件人，不然她以为只是记一笔')
  assert.match(text, /什么都不做|什么都别做/)
  assert.match(text, /1–6 条/)
  assert.doesNotMatch(text, /你应该/)
  assert.match(text, /\[ev_a\]/)
  assert.equal(PROACTIVE_TRIGGER.includes('应该'), false, '触发句不布置任务')
  assert.match(PROACTIVE_TRIGGER, /没有人跟你说话/)
})

test('材料只取她自己的话与听见的东西，悬着的事只列未答的 ask', () => {
  const now = Date.now()
  const events = [
    ev({ id: 'ev_u', ts: new Date(now - 3_600_000).toISOString(), text: '我说过一句' }),
    ev({ id: 'ev_m', type: 'meta', ts: new Date(now - 3_600_000).toISOString(), text: 'diary:2026-10-30' }),
    ev({ id: 'ev_h', type: 'heard', ts: new Date(now - 3_600_000).toISOString(), text: '听见一句' }),
    ev({ id: 'ev_ask', type: 'ask', ts: new Date(now - 3_600_000).toISOString(), text: '我想问你一件事' }),
  ]
  const m = recentMaterial(events, { now })
  assert.deepEqual(m.map((x) => x.id).sort(), ['ev_h', 'ev_u'])
  const loose = looseEnds(events, { now })
  assert.equal(loose.length, 1)
  assert.match(loose[0].text, /还没有得到答复/)

  const answered = [...events, ev({ id: 'ev_ans', type: 'answer', ts: new Date(now - 1000).toISOString(), ask: { askId: 'ev_ask', verdict: 'reject' } })]
  assert.equal(looseEnds(answered, { now }).length, 0, '答过了就不再算悬着')
})

test('her_say 必须指回真实事件：没 refs、超量、不存在、不是材料都写不进去', () => withRoot(async (root) => {
  line(root, ev({ id: 'ev_say', type: 'utterance', text: '我先前的记录', ts: new Date().toISOString() }))
  line(root, ev({ id: 'ev_meta', type: 'meta', text: 'diary:2026-10-30', ts: new Date().toISOString() }))

  assert.match((await writeSay(root, { text: '想说的话' })).note, /refs/)
  assert.match((await writeSay(root, { text: '想说的话', refs: ['ev_say', 'ev_say', 'ev_say', 'ev_say', 'ev_say', 'ev_say', 'ev_say'] })).note, /最多/)
  assert.match((await writeSay(root, { text: '想说的话', refs: ['ev_nope'] })).note, /不存在/)
  assert.match((await writeSay(root, { text: '想说的话', refs: ['ev_meta'] })).note, /不能当材料/)
  assert.match((await writeSay(root, { text: '想'.repeat(PROACTIVE_MAX + 1), refs: ['ev_say'] })).note, /最多/)
  assert.match((await writeSay(root, { text: '   ', refs: ['ev_say'] })).note, /写出来/)
}))

test('写下的一句会落成 utterance（带「她主动说」前缀）并留一条 proactive-say 记账', () => withRoot(async (root) => {
  const now = Date.now()
  line(root, ev({ id: 'ev_say', type: 'utterance', text: '我今天有点累', ts: new Date(now - 3_600_000).toISOString() }))

  const r = await writeSay(root, { text: '我想问你，晚饭吃了没有。', refs: ['ev_say'], why: 'care', now })
  assert.equal(r.ok, true, r.note)

  const { events } = await readEvents(root)
  const said = events.find((e) => e.id === r.id)
  assert.equal(said.type, 'utterance')
  assert.match(said.text, /^（她主动说）我想问你/)
  assert.deepEqual(said.refs, ['ev_say'])

  const meta = events.find((e) => e.type === 'meta' && String(e.text ?? '').startsWith(`proactive-say:${dateKey(new Date(now))}`))
  assert.ok(meta, '得留一条记账，事后查得到她那天为什么开口')
  assert.match(meta.text, /care/)
}))

test('默认白名单里没有 her_say；只有 .dev 下注册了才看得见', () => {
  assert.equal(HER_TOOLS.includes('her_say'), false, '公开版不能有这个工具')
  const src = readFileSync(new URL('../lib/proactive.js', import.meta.url), 'utf8')
  assert.match(src, /name: 'her_say'/)
  assert.match(src, /devModeSync/, '注册要跟提示词、界面共用同一个 .dev 判据')

  const registered = []
  const ctx = { tools: { register: (t) => registered.push(t) } }
  registerProactive(ctx, { root: tmpdir(), log: () => {} })
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, 'her_say')
  assert.deepEqual(registered[0].parameters.required, ['text', 'refs'])
})

test('her_say 的显示结果是 ContentBlock 数组，不是字符串（0.8.2 真机栽在这）', () => {
  const registered = []
  const ctx = { tools: { register: (t) => registered.push(t) } }
  registerProactive(ctx, { root: tmpdir(), log: () => {} })
  const spec = registered[0]

  // 2026-10-30 真机：她连着两次拿到「Error: content.some is not a function」，
  // 第三轮她写「Don't retry a third time」，然后一个字都没说。
  for (const out of [{ ok: true, note: '' }, { ok: false, note: '这条没记下。' }]) {
    const blocks = spec.output.render({}, out)
    assert.ok(Array.isArray(blocks), 'render 必须返回数组，宿主会对它调 content.some')
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0].type, 'text')
    assert.equal(typeof blocks[0].text, 'string')
    assert.ok(blocks[0].text.length > 0)
  }
  assert.match(spec.output.render({}, { ok: true }).at(0).text, /说出去了/)
  assert.match(spec.output.render({}, { ok: false, note: '这条没记下。' }).at(0).text, /没记下/)
})

test('turnsToday / lastTurnAt 只认当日与最近一次，不把别人的 meta 算进来', () => {
  const now = Date.now()
  const dk = dateKey(new Date(now))
  const events = [
    ev({ id: 'ev_t', type: 'meta', text: `proactive-turn:${dk}:${now - 3_600_000}`, ts: new Date(now - 3_600_000).toISOString() }),
    ev({ id: 'ev_d', type: 'meta', text: `proactive-turn:2020-01-01:1`, ts: new Date(now - 5 * 86_400_000).toISOString() }),
    ev({ id: 'ev_other', type: 'meta', text: 'diary:2026-10-30', ts: new Date(now - 1000).toISOString() }),
  ]
  assert.equal(turnsToday(events, dk), 1)
  assert.equal(lastTurnAt(events), now - 3_600_000)
  // 那条 diary 是一秒前写的，但它是系统记账、不是谁说的话：idle 时钟停在 1 小时前那个空手回合上。
  // 改之前这里会算成「一秒前刚说过话」——2026-11-01 用户 m02507 修的就是这个。
  assert.ok(idleHoursOf(events, now) > 0.9, '系统记账不许把 idle 时钟往回拨')
  const withSpeak = [...events, ev({ id: 'ev_u', type: 'utterance', ts: new Date(now - 300).toISOString() })]
  assert.ok(idleHoursOf(withSpeak, now) < 0.1, '她真的说了话，才算「刚才说过」')
  assert.equal(idleHoursOf([], now), Infinity, '一条记录都没有时算「很久」')
})

test('meta:quiet 不刷新 idle：今天没找到模板，不等于她刚说过话（用户 m02507）', () => {
  const now = Date.now()
  const quiet = ev({ id: 'ev_q', type: 'meta', text: 'quiet:2026-10-31 无候选模板，今天不打扰', ts: new Date(now - 60_000).toISOString() })
  const spoke = ev({ id: 'ev_u', type: 'utterance', ts: new Date(now - 6 * 3_600_000).toISOString() })
  assert.equal(countsForIdle(quiet), false, 'quiet 是记账行，不算有人说话')
  assert.ok(idleHoursOf([quiet, spoke], now) > 5.9, '时钟还是停在 6 小时前那句真话上')
  assert.equal(idleHoursOf([quiet], now), Infinity, '只有记账行时，等于「一直没人说话」')
})

test('meta:watched 也不刷新 idle：她看了条视频，不等于她说过话（真机 2026-10-30 22:03 那次假阴性）', () => {
  const now = Date.now()
  // 那次现场：她实际安静了 17.55 小时，插件读到 0.01h，来源是一条 meta:watched。
  const watched = ev({ id: 'ev_w', type: 'meta', text: 'watched:BV1xx411c7mD', ts: new Date(now - 36_000).toISOString() })
  const answer = ev({ id: 'ev_a', type: 'answer', text: '可以', ts: new Date(now - 17.55 * 3_600_000).toISOString() })
  assert.equal(countsForIdle(watched), false)
  const idle = idleHoursOf([watched, answer], now)
  assert.ok(idle > 17.5, '应该是 17.5 小时，不是 0.01 小时')
  // 反过来：几种「真的有人说话」的事件都要算，尤其 seen:（他来过）。
  for (const type of ['utterance', 'revise', 'heard', 'voice', 'ask', 'answer', 'dream']) {
    assert.equal(countsForIdle(ev({ type })), true, `${type} 应该算`)
  }
  assert.equal(countsForIdle(ev({ type: 'meta', text: `seen:${new Date(now).toISOString()}` })), true, 'seen: 算他来过')
  assert.equal(countsForIdle(ev({ type: 'meta', text: `diary:2026-10-31` })), false, 'diary 不算')
  assert.equal(countsForIdle(ev({ type: 'meta', text: `sched:2026-11-01` })), false, 'sched 不算')
})

test('触发语收尾：回合结束后能把那条 user/message 换成空节点（用户 m05007）', () => {
  const events = [
    { seq: 1, type: 'turn/start', data: { turn: 7 } },
    { seq: 2, type: 'step/start', data: { step: 2 } },
    {
      seq: 3,
      type: 'user/message',
      data: { role: 'user', content: [{ type: 'text', text: '（现在没有人跟你说话。）' }], source: { kind: 'user', rpcId: 'proactive-1793372588185' } },
    },
  ]
  assert.equal(findTriggerSeq(events, 'proactive-1793372588185'), 3)
  assert.equal(findTriggerSeq(events, 'proactive-别的'), 0)

  const session = {
    appended: null,
    snapshotEvents: () => events,
    append(type, data, opts) {
      this.appended = { type, data, opts }
    },
  }
  assert.equal(hideTrigger(session, { rpcId: 'proactive-1793372588185' }), true)
  assert.equal(session.appended.type, 'system/message')
  // 空 content 才不投影任何消息；id 必须是非空字符串——宿主 v4 的
  // assertV4SystemMessageFields 会查它，缺了整批写盘会抛、并把会话置成 drainPaused。
  assert.equal(session.appended.data.message.role, 'system')
  assert.deepEqual(session.appended.data.message.content, [])
  assert.equal(typeof session.appended.data.message.id, 'string', '替换节点必须带 id（2026-11-01 真机：缺 id 会让整条会话写不下去）')
  assert.ok(session.appended.data.message.id.length > 0)
  // source.kind 必须是宿主认的 producer-owned 类型（2026-11-02 用户 m01140 真机：
  // 缺 source 的那条会话加载期直接 SessionFormatError，整条对话打不开）。
  assert.equal(session.appended.data.message.source?.kind, 'system-prompt', '替换节点必须带 source.kind，否则会话加载期整条打不开')
  assert.deepEqual(session.appended.opts.surfaceOp, { op: 'replace', startSeq: 3, endSeq: 3 })
  assert.deepEqual(session.appended.opts.sourceEventSeqs, [3], '要带 sourceEventSeqs，宿主才知道替的是哪条')
  assert.equal(session.appended.data.turn, 7, 'turn 取触发语所在回合，不伪造')
  assert.equal(session.appended.data.step, 2)

  // 回合已经结束（或根本还没开）时**不许写**：宿主要求 system/message 的
  // turn/step 正好等于此刻开着的那个，写进去就是坏节点，加载期整条对话打不开
  // （2026-11-02 用户 m01418 真机：`system/message does not match an open turn and step`）。
  // 这时只记账，等下一轮 step/start 由 flushPendingHides 补收。
  resetPendingHides()
  const closed = {
    appended: null,
    snapshotEvents: () => [
      { seq: 1, type: 'turn/start', data: { turn: 5 } },
      { seq: 2, type: 'step/start', data: { step: 1 } },
      { seq: 3, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '（现在没有人跟你说话。）' }], source: { kind: 'user', rpcId: 'proactive-closed' } } },
      { seq: 4, type: 'turn/end', data: { turn: 5 } },
    ],
    append(type, data, opts) {
      this.appended = { type, data, opts }
    },
  }
  assert.equal(hideTrigger(closed, { rpcId: 'proactive-closed' }), false, '回合外必须返回 false')
  assert.equal(closed.appended, null, '回合外一条都不许写进会话')
  assert.deepEqual(pendingHidesOf().rpcIds, ['proactive-closed'], '要记下来等下一轮')

  // 下一轮开起来之后补收：turn/step 用**当下**开着的那个（3/1），不是目标消息所在的 5/1。
  const reopened = {
    appended: null,
    snapshotEvents: () => [
      { seq: 1, type: 'turn/start', data: { turn: 5 } },
      { seq: 2, type: 'step/start', data: { step: 1 } },
      { seq: 3, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '（现在没有人跟你说话。）' }], source: { kind: 'user', rpcId: 'proactive-closed' } } },
      { seq: 4, type: 'turn/end', data: { turn: 5 } },
      { seq: 5, type: 'turn/start', data: { turn: 6 } },
      { seq: 6, type: 'step/start', data: { step: 1 } },
    ],
    append(type, data, opts) {
      this.appended = { type, data, opts }
    },
  }
  assert.equal(flushPendingHides(reopened), 1)
  assert.equal(reopened.appended.data.turn, 6, 'turn 用当下开着的这一轮')
  assert.equal(reopened.appended.data.step, 1)
  assert.deepEqual(reopened.appended.opts.surfaceOp, { op: 'replace', startSeq: 3, endSeq: 3 })
  assert.deepEqual(pendingHidesOf().rpcIds, [], '收掉之后要从队列里去掉')

  // 找不到、没会话、没 rpcId 都不该抛，也不该乱写。
  assert.equal(hideTrigger(session, { rpcId: 'proactive-别的' }), false)
  assert.equal(hideTrigger(null, { rpcId: 'proactive-1793372588185' }), false)
  assert.equal(hideTrigger(session, {}), false)
})

test('openTurnOf：只有 turn 和 step 都开着才算「能写」（宿主 requireStep 的判据）', () => {
  assert.deepEqual(openTurnOf([]), { open: false, turn: 0, step: 0 })
  assert.deepEqual(openTurnOf(null), { open: false, turn: 0, step: 0 })
  // 只有 turn/start，没有 step/start → 还是不能写
  assert.deepEqual(openTurnOf([{ type: 'turn/start', data: { turn: 2 } }]), { open: false, turn: 2, step: 0 })
  // 都开着
  assert.deepEqual(
    openTurnOf([{ type: 'turn/start', data: { turn: 2 } }, { type: 'step/start', data: { step: 3 } }]),
    { open: true, turn: 2, step: 3 },
  )
  // step/end 之后不能写
  assert.equal(
    openTurnOf([
      { type: 'turn/start', data: { turn: 2 } },
      { type: 'step/start', data: { step: 3 } },
      { type: 'step/end', data: { step: 3 } },
    ]).open,
    false,
  )
  // turn/end 之后不能写，且下一轮重置 step
  assert.deepEqual(
    openTurnOf([
      { type: 'turn/start', data: { turn: 2 } },
      { type: 'step/start', data: { step: 3 } },
      { type: 'turn/end', data: { turn: 2 } },
      { type: 'turn/start', data: { turn: 3 } },
    ]),
    { open: false, turn: 3, step: 0 },
  )
})

test('守卫拒绝时必须当场返回，不能「日志说拒了、事件流照样多一条」（用户 m05007 真机）', () => withRoot(async (root) => {
  line(root, ev({ id: 'ev_mat', text: '一件真实发生过的事' }))
  const registered = []
  const ctx = { tools: { register: (t) => registered.push(t) } }
  registerProactive(ctx, {
    root,
    tenant: { root, herDir: '', tenant: { ok: true, instanceId: '', why: '' } },
    log: () => {},
  })
  const tool = registered[0]
  const before = (await readEvents(root)).events.length

  // 从别的工作区调用：不在这个家 → 守卫拒 → 不许落盘
  const out = await tool.execute(
    { text: '这句不该写进去', refs: ['ev_mat'] },
    { session: { header: { id: 'session-elsewhere', cwd: 'D:/somewhere-else' } } },
  )
  assert.equal(out.ok, false)
  assert.match(out.note, /没有落盘|另一个家/)
  assert.equal((await readEvents(root)).events.length, before, '拒绝时事件数不能变')

  // 同一份 tenant，换回她自己的会话 → 放行
  const okOut = await tool.execute(
    { text: '这句可以写', refs: ['ev_mat'] },
    { session: { header: { id: 'session-26cbdc5e', cwd: join(root, 'home') } } },
  )
  assert.equal(okOut.ok, true)
  assert.equal((await readEvents(root)).events.length, before + 2, '写一条 utterance + 一条 meta')
}))

test('补扫：历史里遗留的触发语也要收走，但别误伤她复述这句话（用户 m05031）', () => {
  resetPendingHides()
  const events = [
    { seq: 1, type: 'turn/start', data: { turn: 3 } },
    { seq: 2, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '（现在没有人跟你说话。）' }] } },
    { seq: 3, type: 'assistant/message', data: {} },
    { seq: 4, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '（现在没有人跟你说话。）这句不是我写的' }] } },
    { seq: 5, type: 'turn/start', data: { turn: 4 } },
    { seq: 6, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '（现在没有人跟你说话。）' }] } },
    // 补扫时得有个回合开着才写得进去（宿主 requireStep），这里补上 step/start。
    { seq: 7, type: 'step/start', data: { step: 1 } },
  ]
  const appended = []
  const session = {
    snapshotEvents: () => events,
    append(type, data, opts) {
      appended.push({ type, data, opts })
    },
  }
  assert.equal(sweepTriggers(session), 2, '两条完全相等的收走；她复述的那条留着')
  assert.deepEqual(appended.map((a) => a.opts.surfaceOp.startSeq), [2, 6])
  assert.deepEqual(appended.map((a) => a.opts.sourceEventSeqs), [[2], [6]])
  // turn/step 用**当下开着**的那个（4/1），不是各自目标消息所在的回合：
  // 往已关闭的回合里写会被宿主 `requireStep` 拒，而那条错在加载期炸，整条对话打不开。
  assert.deepEqual(appended.map((a) => a.data.turn), [4, 4])
  assert.deepEqual(appended.map((a) => a.data.step), [1, 1])

  // 每条替换节点都得有自己的 id，不能复用
  const ids = appended.map((a) => String(a.data.message.id ?? ''))
  assert.equal(ids.filter((id) => id.length > 0).length, 2, '两条都要带 id')
  assert.notEqual(ids[0], ids[1], '两条替换节点不能共用一个 id')
  // 补扫写出来的节点同样要带 source（2026-11-02 用户 m01140 真机事故：缺 source 会让整条会话打不开）
  assert.deepEqual(appended.map((a) => a.data.message.source?.kind), ['system-prompt', 'system-prompt'])

  // 已收过的再扫不会再叠：把 replace 节点也放进事件流里
  events.push({ seq: 8, type: 'system/message', data: { surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 }, message: { id: 'sys-2', role: 'system', content: [] } } })
  events.push({ seq: 9, type: 'system/message', data: { surfaceOp: { op: 'replace', startSeq: 6, endSeq: 6 }, message: { id: 'sys-6', role: 'system', content: [] } } })
  appended.length = 0
  assert.equal(sweepTriggers(session), 0)
})

test('补扫：回合没开着就一条都不写，攒到下一轮再说（2026-11-02 用户 m01418 真机事故）', () => {
  resetPendingHides()
  const events = [
    { seq: 1, type: 'turn/start', data: { turn: 3 } },
    { seq: 2, type: 'step/start', data: { step: 1 } },
    { seq: 3, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '（现在没有人跟你说话。）' }] } },
    { seq: 4, type: 'turn/end', data: { turn: 3 } },
  ]
  const appended = []
  const session = {
    snapshotEvents: () => events,
    append(type, data, opts) {
      appended.push({ type, data, opts })
    },
  }
  assert.equal(sweepTriggers(session), 0, '回合外不许写')
  assert.equal(appended.length, 0, '一条都不能落盘——那正是让整条会话打不开的东西')
  assert.deepEqual(pendingHidesOf().seqs, [3], '要记住这条，等下一轮再收')

  // 下一轮开起来之后 flush 把它收掉（走 sweepTriggers 那条路，turn/step 用当下的）。
  const live = {
    snapshotEvents: () => [
      ...events,
      { seq: 5, type: 'turn/start', data: { turn: 4 } },
      { seq: 6, type: 'step/start', data: { step: 1 } },
    ],
    append(type, data, opts) {
      appended.push({ type, data, opts })
    },
  }
  assert.equal(flushPendingHides(live), 1)
  assert.equal(appended.length, 1, '攒着的那条这时才写')
  assert.deepEqual(appended[0].opts.surfaceOp, { op: 'replace', startSeq: 3, endSeq: 3 })
  assert.equal(appended[0].data.turn, 4, '用当下开着的这一轮')
  assert.deepEqual(pendingHidesOf().seqs, [], '收掉之后队列要清空')
})
