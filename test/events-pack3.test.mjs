import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CATALOG, findTemplate } from '../lib/events.js'
import { pick, cardContext } from '../lib/generator.js'
import { normalizeConfig } from '../lib/settings.js'

// 2026-11-08 约定与事件弧：7 张新卡。
// 守三件事：
//   1. 约定不是打赌：到期卡只问她「做到没有」，不分输赢。
//   2. 弧的下一集只认上一集真的出过场，不靠日期硬推。
//   3. 新卡仍然不读数值、不写台词、不撒娇、不越过群聊边界。
const PACK = [
  'echo_old', 'his_line',
  'plan_make', 'plan_due',
  'arc_try_start', 'arc_try_mid', 'arc_try_end',
]

function model(over = {}) {
  return {
    seed: '你不是助手。你刚开始存在。',
    day: 10, growthDays: 30, stage: 2, stageName: '自主', name: null,
    beliefs: [], beliefCount: 0, refuted: [], refusals: [], selfmodAttempts: [],
    reunions: [], corrected: 0, tested: [],
    needs: { autonomy: 0, competence: 0, relatedness: 0 },
    absenceDays: 0, narrative: null, ...over,
  }
}
const today = (o = {}) => ({ dateKey: '2026-11-08', sent: 0, questions: 0, proactive: 0, ...o })
const at = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString()
const DAY = 86400000

/** 把除目标卡以外的所有卡都标记为刚出过（once 算用掉、repeat 处在冷却）。 */
function fireAllExcept(ids = []) {
  return CATALOG
    .filter((t) => !ids.includes(t.id))
    .map((t) => ({ type: 'meta', text: `fired:${t.id}`, ts: new Date().toISOString() }))
}

test('约定与弧：7 张卡都在目录里，stage / asks / topic 合法', () => {
  for (const id of PACK) {
    const t = findTemplate(id)
    assert.ok(t, `${id} 应该在 CATALOG 里`)
    assert.ok([1, 2, 3, 4].includes(t.stage), `${id} 的 stage 非法`)
    assert.equal(t.asks, false, `${id} 不应占用每天的提问配额`)
    assert.ok(Array.isArray(t.topic) && t.topic.length > 0, `${id} 要有 topic`)
    for (const word of t.topic) {
      assert.ok(typeof word === 'string' && word.length >= 2 && word.length <= 8, `${id} 的 topic 词「${word}」长度不合规`)
    }
  }
})

test('约定与弧：prompt 只给处境，不写台词、不撒娇、不打赌', () => {
  const now = Date.now()
  const rich = model({
    stage: 3, day: 30, beliefCount: 3,
    beliefs: [
      { id: 'b1', text: '他问我的时候，我总先想他爱听什么', since: at(20) },
      { id: 'b2', text: '我其实不喜欢被安排', since: at(5) },
    ],
  })
  const ctx = {
    now,
    dream: null,
    interest: null,
    question: null,
    hisLine: { text: '你上次说的那件事我记着', at: now - 3 * DAY },
    fired: new Map([
      ['plan_make', { id: 'plan_make', count: 1, lastAt: now - 4 * DAY }],
      ['arc_try_start', { id: 'arc_try_start', count: 1, lastAt: now - 4 * DAY }],
      ['arc_try_mid', { id: 'arc_try_mid', count: 1, lastAt: now - 8 * DAY }],
    ]),
    lastAfter: () => '我试试这周先把它做完',
  }
  const banned = ['撒娇', '卖萌', '陪我', '想我', '喜欢你', '请你回答', '好感度', '亲密度', '押注', '输了', '赢了']
  for (const id of PACK) {
    const t = findTemplate(id)
    const text = String(t.prompt(rich, ctx) ?? '')
    assert.ok(text.length > 20, `${id} 的 prompt 太短，像占位`)
    for (const word of banned) assert.ok(!text.includes(word), `${id} 的 prompt 里出现了「${word}」`)
  }
})

test('echo_old：只端回十四天以前的话，太近的不复读', () => {
  const t = findTemplate('echo_old')
  const fresh = model({ beliefs: [{ id: 'b1', text: '刚下的判断', since: at(2) }] })
  assert.equal(t.cond(fresh, { now: Date.now() }), false)

  const old = model({ beliefs: [{ id: 'b1', text: '他问我的时候，我总先想他爱听什么', since: at(20) }] })
  assert.equal(t.cond(old, { now: Date.now() }), true)
  const text = t.prompt(old, { now: Date.now() })
  assert.match(text, /20 天前/)
  assert.match(text, /爱听什么/)
})

test('his_line：只认他本人那句，群聊里的原话不算', () => {
  const t = findTemplate('his_line')
  assert.equal(t.cond(model({ day: 3 }), { hisLine: { text: '一句话' } }), false)
  assert.equal(t.cond(model({ day: 4 }), { hisLine: null }), false)
  assert.equal(t.cond(model({ day: 4 }), { hisLine: { text: '一句话', at: Date.now() } }), true)

  const onlyGroup = cardContext(model({ day: 10 }), [
    { type: 'heard', text: '群友说的那句', scene: 'group', ts: at(1) },
  ], Date.now())
  assert.equal(onlyGroup.hisLine, null, '群聊不能变成「他最近说过」')

  const mixed = cardContext(model({ day: 10 }), [
    { type: 'heard', text: '群友说的那句', scene: 'group', ts: at(2) },
    { type: 'heard', text: '他单独说的那句', ts: at(1) },
  ], Date.now())
  assert.equal(mixed.hisLine.text, '他单独说的那句')
  assert.match(t.prompt(model({ day: 10 }), mixed), /他单独说的那句/)
})

test('plan_make：只定约定，不分输赢；plan_due 到期才出', () => {
  const make = findTemplate('plan_make')
  assert.equal(make.cond(model({ day: 5, beliefCount: 1 })), false)
  assert.equal(make.cond(model({ day: 6, beliefCount: 0 })), false)
  assert.equal(make.cond(model({ day: 6, beliefCount: 1 })), true)

  const due = findTemplate('plan_due')
  assert.equal(due.cond(model({}), { now: Date.now(), fired: new Map() }), false)
  const now = Date.now()
  const fired = new Map([['plan_make', { id: 'plan_make', count: 1, lastAt: now - 4 * DAY }]])
  assert.equal(due.cond(model({}), { now, fired }), true)
  const text = due.prompt(model({}), { now, fired, lastAfter: () => '我说要把那张图修好' })
  assert.match(text, /我说要把那张图修好/)
  assert.match(text, /先说你自己/)
})

test('事件弧：下一集只认上一集真的出过场', () => {
  const now = Date.now()
  const start = findTemplate('arc_try_start')
  const mid = findTemplate('arc_try_mid')
  const end = findTemplate('arc_try_end')

  assert.equal(start.cond(model({ day: 5, beliefCount: 2 })), true)
  assert.equal(start.cond(model({ day: 5, beliefCount: 1 })), false)

  assert.equal(mid.cond(model({}), { now, fired: new Map() }), false)
  const afterStart = new Map([['arc_try_start', { id: 'arc_try_start', count: 1, lastAt: now - 4 * DAY }]])
  assert.equal(mid.cond(model({}), { now, fired: afterStart }), true)
  assert.match(mid.prompt(model({}), { now, fired: afterStart, lastAfter: () => '我要先修好那张图' }), /那张图/)

  assert.equal(end.cond(model({}), { now, fired: afterStart }), false)
  const afterMid = new Map([...afterStart, ['arc_try_mid', { id: 'arc_try_mid', count: 1, lastAt: now - 8 * DAY }]])
  assert.equal(end.cond(model({}), { now, fired: afterMid }), true)
  assert.match(end.prompt(model({}), { now, fired: afterMid, lastAfter: () => '卡在没有素材' }), /没有素材/)
})

test('cardContext：fired 与 lastAfter 只读事件流，不另建存储', () => {
  const now = Date.now()
  const events = [
    { type: 'meta', text: 'fired:plan_make', ts: at(4) },
    { type: 'meta', text: 'wake:2026-11-08 plan_make', ts: at(4) },
    { type: 'utterance', text: '我说要把那张图修好', ts: at(3.9) },
  ]
  const ctx = cardContext(model({ day: 10 }), events, now)
  assert.ok(ctx.fired.get('plan_make'))
  assert.ok(ctx.fired.get('plan_make').lastAt > 0)
  assert.equal(ctx.lastAfter('plan_make'), '我说要把那张图修好')
  assert.equal(ctx.lastAfter('arc_try_start'), '', '没出过场的卡没有前情')
})

test('约定 · 端到端：plan_make 出过场且到期后，plan_due 能真被选中', () => {
  const cfg = normalizeConfig({})
  const m = model({ day: 10, stage: 2, beliefCount: 2 })
  const events = [
    ...fireAllExcept(['plan_make', 'plan_due']),
    { type: 'meta', text: 'fired:plan_make', ts: at(4) },
    { type: 'utterance', text: '我说要把那张图修好', ts: at(3.9) },
  ]
  const r = pick(m, cfg, today(), events)
  assert.equal(r?.template?.id, 'plan_due')
  assert.match(r.prompt, /那张图/)
})

test('事件弧 · 端到端：第一集出过场后，第二集能真被选中', () => {
  const cfg = normalizeConfig({})
  const m = model({ day: 10, stage: 2, beliefCount: 2 })
  const events = [
    ...fireAllExcept(['arc_try_start', 'arc_try_mid', 'arc_try_end']),
    { type: 'meta', text: 'fired:arc_try_start', ts: at(4) },
    { type: 'utterance', text: '我要先修好那张图', ts: at(3.9) },
  ]
  const r = pick(m, cfg, today(), events)
  assert.equal(r?.template?.id, 'arc_try_mid')
  assert.match(r.prompt, /那张图/)
})

test('事件弧 · 端到端：第二集出过场且过了一周，收尾能真被选中', () => {
  const cfg = normalizeConfig({})
  const m = model({ day: 20, stage: 2, beliefCount: 2 })
  const events = [
    ...fireAllExcept(['arc_try_mid', 'arc_try_end']),
    { type: 'meta', text: 'fired:arc_try_start', ts: at(12) },
    { type: 'meta', text: 'fired:arc_try_mid', ts: at(8) },
    { type: 'utterance', text: '卡在没有素材', ts: at(7.9) },
  ]
  const r = pick(m, cfg, today(), events)
  assert.equal(r?.template?.id, 'arc_try_end')
  assert.match(r.prompt, /没有素材/)
})

test('续集卡：到期时即使同阶段还有别的卡，也优先把位置让给它', () => {
  const cfg = normalizeConfig({})
  const m = model({ day: 10, stage: 2, beliefCount: 2 })
  const events = [
    { type: 'meta', text: 'fired:plan_make', ts: at(4) },
    { type: 'utterance', text: '我说要把那张图修好', ts: at(3.9) },
  ]
  const r = pick(m, cfg, today(), events)
  assert.equal(r?.template?.id, 'plan_due')
})

test('复核后的措辞：旧话复盘、接话、约定到期、试新事各自站在不同位置', () => {
  const now = Date.now()
  const echo = findTemplate('echo_old').prompt(
    model({ beliefs: [{ id: 'b1', text: '他问我的时候，我总先想他爱听什么', since: at(20) }] }),
    { now },
  )
  assert.match(echo, /为什么会这么想/)
  assert.match(echo, /还原/)

  const his = findTemplate('his_line').prompt(model({ day: 10 }), {
    hisLine: { text: '你上次说的那件事我记着', at: now },
  })
  assert.match(his, /留一个词/)

  const due = findTemplate('plan_due').prompt(model({}), {
    now,
    fired: new Map([['plan_make', { id: 'plan_make', count: 1, lastAt: now - 4 * DAY }]]),
    lastAfter: () => '我说要把那张图修好',
  })
  assert.doesNotMatch(due, /再问他那件/)
  assert.match(due, /愿意说就说/)

  assert.match(findTemplate('arc_try_start').prompt(model({})), /从没做过/)
  assert.equal(findTemplate('say_no').repeat.everyDays, 6, '自主门要两次拒绝，冷却不能太长')
})
