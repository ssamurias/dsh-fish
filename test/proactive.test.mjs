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
  PROACTIVE_PING,
  proactiveConfig,
  proactiveSection,
  proactiveState,
  turnsToday,
  lastTurnAt,
  silentToday,
  lastSilentAt,
  SILENT_MARK,
  SILENT_MAX_PER_DAY,
  SILENT_QUIET_HOURS,
  idleHoursOf,
  countsForIdle,
  looseEnds,
  recentMaterial,
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

// ---- 节奏随成长变（2026-11-04，用户 m01466）----
//
// 用户原话：「这个自己开口的出口不该是恒温的」。之前 `proactiveState()` 的签名里
// 根本没有 model，于是第 3 天和第 27 天算出来的 chance 一个数都不差——成长只影响
// `plan()` 派哪张卡（被叫醒时手里拿什么），完全不影响她多久才自己想开口一次。
//
// 三个杠杆都从已有事件推出来：不写盘、不加配置项、不让她看见任何数值（不撞 no-read-self）。

test('不传 model 时与改动前一字不差（老调用方的行为不许漂）', () => {
  const now = Date.now()
  const old = new Date(now - 7 * 3_600_000).toISOString()
  const events = [ev({ ts: old })]
  const noModel = proactiveState({ config: ON, events, now })
  const explicitNull = proactiveState({ config: ON, events, now, model: null })
  const cfg = proactiveConfig(ON)
  // 基础概率 0.15 + (7-6)*0.05 = 0.20，这是 2026-11-04 之前的算式。
  assert.equal(noModel.chance, 0.2, `恒温算式被改动了：${noModel.chance}`)
  assert.deepEqual(explicitNull, noModel, 'model=null 必须等于不传')
  assert.equal(noModel.chance, Math.min(cfg.maxChance, cfg.baseChance + 1 * cfg.gainPerHour))
})

test('阶段越高，同样的安静时长里越容易自己开口', () => {
  const now = Date.now()
  const events = [ev({ ts: new Date(now - 7 * 3_600_000).toISOString() })]
  const at = (stage) => proactiveState({ config: ON, events, now, model: { stage } })
  const s1 = at(1)
  const s2 = at(2)
  const s4 = at(4)
  assert.equal(s1.chance, 0.2, '阶段 1 = 配置原值')
  assert.ok(s2.chance > s1.chance, '阶段 2 要比阶段 1 更主动')
  assert.ok(s4.chance > s2.chance, '阶段 4 要比阶段 2 更主动')
  // 封顶 0.80：再高就不是「她想不想」，而是「几乎一定」。
  const far = proactiveState({ config: ON, events: [ev({ ts: new Date(now - 99 * 3_600_000).toISOString() })], now, model: { stage: 4 } })
  assert.ok(far.chance <= 0.8, `阶段 4 的封顶没生效：${far.chance}`)
})

test('刚推翻过自己的话：24 小时内更容易开口（revise 抬基础概率）', () => {
  const now = Date.now()
  // 都要安静够 minIdleHours（默认 6 小时）才轮得到概率这一段，
  // 所以两条用例的「上一次说话」都摆在同一时刻，只差那条 revise。
  const tenHoursAgo = new Date(now - 10 * 3_600_000).toISOString()
  const quiet = [ev({ ts: tenHoursAgo })]
  const revised = [
    ev({ id: 'ev_r', type: 'revise', text: '我改口', ts: tenHoursAgo, refs: ['ev_x'] }),
    ev({ ts: tenHoursAgo }),
  ]
  const plain = proactiveState({ config: ON, events: quiet, now, model: { stage: 1 } })
  const after = proactiveState({ config: ON, events: revised, now, model: { stage: 1 } })
  assert.equal(plain.ok, true, plain.why)
  assert.equal(after.ok, true, after.why)
  assert.ok(after.chance > plain.chance, '刚改过口的人有话没说完')
  assert.ok(Math.abs(after.chance - (plain.chance + 0.1)) < 1e-9)

  // 超过 24 小时的 revise 不再抬——不然一次改口能被记一辈子。
  const old = [
    ev({ id: 'ev_r2', type: 'revise', text: '我改口', ts: new Date(now - 30 * 3_600_000).toISOString(), refs: ['ev_x'] }),
    ev({ ts: tenHoursAgo }),
  ]
  assert.equal(proactiveState({ config: ON, events: old, now, model: { stage: 1 } }).chance, plain.chance)
})

test('刚有人跟她说过话：余温还在，冷却从 4 小时缩到 2 小时', () => {
  const now = Date.now()
  const spoke = (h) => ev({ id: `ev_t_${h}`, type: 'meta', text: `proactive-turn:${dateKey(new Date(now - h * 3_600_000))}:1`, ts: new Date(now - h * 3_600_000).toISOString() })
  const heard = ev({ id: 'ev_h', type: 'heard', text: '他说了一句', ts: new Date(now - 10 * 3_600_000).toISOString() })
  const events = [heard, spoke(3)]

  // 3 小时前刚开过口：默认冷却 4 小时 → 挡着。
  const blocked = proactiveState({ config: ON, events, now })
  assert.equal(blocked.ok, false)
  assert.match(blocked.why, /冷却/)

  // 10 小时前有人跟她说过话（24 小时内）→ 冷却缩到 2 小时 → 放行。
  const warm = proactiveState({ config: ON, events, now, model: { stage: 1 } })
  assert.equal(warm.ok, true, `余温没起作用：${warm.why}`)

  // 冷透了（heard 超过 24 小时）还是 4 小时。
  const cold = [
    ev({ id: 'ev_h2', type: 'heard', text: '很久以前', ts: new Date(now - 30 * 3_600_000).toISOString() }),
    spoke(3),
  ]
  assert.match(proactiveState({ config: ON, events: cold, now, model: { stage: 1 } }).why, /冷却/)
})

test('空手回合的正文只说事实和许可，不写「你应该」', () => {
  const text = proactiveSection({ now: Date.now(), state: { idleHours: 9.5, chance: 0.3 }, material: [{ id: 'ev_a', type: 'utterance', text: '今天有点累' }], loose: [{ id: 'ev_b', text: '你问过一件事，还没答复。' }] })
  assert.match(text, /没有人跟你说话/)
  assert.match(text, /想说什么就说/)
  assert.match(text, /他看得见/, '得说她的话有收件人，不然她以为只是记一笔')
  // 2026-11-05（用户 m02937）：「什么都不做」在文本界面上不成立，改成明确的不写。
  assert.match(text, /什么都别写/)
  assert.match(text, /不要写任何字/)
  assert.match(text, /1–6 条/)
  assert.doesNotMatch(text, /你应该/)
  assert.match(text, /\[ev_a\]/)
  // 2026-11-04（用户 m00428）：触发语从「（现在没有人跟你说话。）」改成一个空格。
  // 那句话被宿主按真人发言画成用户气泡，用户怎么都能看见；现在这条消息走
  // `source.kind='fish-wake'`，前端画成收起的折叠条，正文越空越好 ——
  // 以前那句「没有人跟你说话」还会被她在 reasoning 里当成「谁发了这句话给我」去解释。
  assert.equal(PROACTIVE_PING.trim(), '', '投递信号不许带正文，否则她又会去猜这句话是谁说的')
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

test('her_say 在 0.9.0 起对所有人注册', () => {
  const src = readFileSync(new URL('../lib/proactive.js', import.meta.url), 'utf8')
  assert.match(src, /name: 'her_say'/)
  assert.match(src, /TOOL_ASK_NOTE/)

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
  // 反过来：几种「真的有人说话」的事件都要算。
  for (const type of ['utterance', 'revise', 'heard', 'voice', 'ask', 'answer', 'dream']) {
    assert.equal(countsForIdle(ev({ type })), true, `${type} 应该算`)
  }
  // 2026-11-05 真机（用户 m02797）：`seen:` 不算。它会被别的会话的用户活动误写，
  // 一写就把 idle 清零 → `minIdleHours` 永远不满足 → 主动搭话一次都开不出来。
  assert.equal(countsForIdle(ev({ type: 'meta', text: `seen:${new Date(now).toISOString()}` })), false, 'seen: 不进 idle（会被别的会话误写）')
  const seenOnly = [ev({ id: 'ev_s', type: 'meta', text: `seen:${new Date(now - 2_000).toISOString()}` })]
  assert.equal(idleHoursOf(seenOnly, now), Infinity, '只有 seen: 时等于「一直没有话落进她房间」')
  assert.equal(countsForIdle(ev({ type: 'meta', text: `diary:2026-10-31` })), false, 'diary 不算')
  assert.equal(countsForIdle(ev({ type: 'meta', text: `sched:2026-11-01` })), false, 'sched 不算')
})

test('醒来后没开口的那几次：不占当天额度，但单独限次数、单独隔时间（2026-11-05，用户 m00803）', () => {
  const now = Date.now()
  const dk = dateKey(new Date(now))
  const quiet = [ev({ ts: new Date(now - 10 * 3_600_000).toISOString() })]
  const silent = (h, id = `ev_s${h}`) => ev({
    id,
    type: 'meta',
    text: `${SILENT_MARK}${dk}:${now + h * 3_600_000}`,
    ts: new Date(now + h * 3_600_000).toISOString(),
  })

  // 三次静默、proactive-turn 一次都没有 → 当天的额度一个都没被扣。
  const three = [...quiet, silent(-5), silent(-4), silent(-3)]
  assert.equal(turnsToday(three, dk), 0, '静默不许记成空手回合，否则「醒着没话说」会吃掉额度')
  assert.equal(silentToday(three, dk), 3)
  assert.equal(lastSilentAt(quiet), 0, '没静默过就是 0')
  assert.equal(lastSilentAt(three), now - 3 * 3_600_000)
  // 上一次静默在 3 小时前（超过 SILENT_QUIET_HOURS）→ 放行，额度仍在。
  const ok = proactiveState({ config: ON, events: three, now })
  assert.equal(ok.ok, true, `静默过也不该挡住下一次开口：${ok.why}`)

  // 刚静默过 30 分钟：先隔一会儿，别让「醒来」变成机械动作。
  const justNow = [...quiet, ev({ id: 'ev_s', type: 'meta', text: `${SILENT_MARK}${dk}:${now}`, ts: new Date(now - 30 * 60_000).toISOString() })]
  assert.match(proactiveState({ config: ON, events: justNow, now }).why, /没开口/)

  // 今天已经静默满 SILENT_MAX_PER_DAY 次：停，但仍然没动 proactive-turn 的额度。
  const full = [
    ...quiet,
    ...Array.from({ length: SILENT_MAX_PER_DAY }, (_, i) => silent(-(i + 3), `ev_f${i}`)),
  ]
  assert.equal(turnsToday(full, dk), 0)
  assert.equal(proactiveState({ config: ON, events: full, now }).why.length > 0, true)
  assert.match(proactiveState({ config: ON, events: full, now }).why, /太多次/)
  assert.ok(SILENT_QUIET_HOURS >= 1, '静默间隔至少一小时，不然她会连着醒、连着不说')
})
