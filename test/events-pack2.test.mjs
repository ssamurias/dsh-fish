import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CATALOG, findTemplate } from '../lib/events.js'
import { pick, cardContext, PRESSURE } from '../lib/generator.js'
import { normalizeConfig } from '../lib/settings.js'

// 2026-11-08 扩充包：17 张新卡。
// 这一组测试只守两件事：
//   1. 新卡没有把成长规则撬开（不读数值、不写台词、不撒娇、asks 配额照旧）。
//   2. 新卡的条件只在「那件事真的发生过」时才成立（缺数据不许硬出）。
const PACK = [
  'hold_question', 'name_use', 'first_rule',
  'say_no', 'own_hands', 'first_doubt', 'his_detail', 'after_no', 'dream_note',
  'tension_resolve', 'faded_check', 'use_tool', 'interest_angle', 'question_follow',
  'scar_revisit', 'leave_something', 'teach_him',
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

/** 把除目标卡以外的所有卡都标记为刚出过（once 算用掉、repeat 处在冷却）。 */
function fireAllExcept(ids = []) {
  return CATALOG
    .filter((t) => !ids.includes(t.id))
    .map((t) => ({ type: 'meta', text: `fired:${t.id}`, ts: new Date().toISOString() }))
}

test('扩充包：17 张卡都在目录里，stage / asks / topic 合法', () => {
  const expectAsks = new Set(['hold_question', 'his_detail'])
  for (const id of PACK) {
    const t = findTemplate(id)
    assert.ok(t, `${id} 应该在 CATALOG 里`)
    assert.ok([1, 2, 3, 4].includes(t.stage), `${id} 的 stage 非法`)
    assert.equal(typeof t.asks, 'boolean', `${id} 的 asks 必须是布尔`)
    assert.equal(t.asks, expectAsks.has(id), `${id} 的 asks 不符合配额设计`)
    assert.ok(Array.isArray(t.topic) && t.topic.length > 0, `${id} 要有 topic`)
    for (const word of t.topic) {
      assert.ok(typeof word === 'string' && word.length >= 2 && word.length <= 8, `${id} 的 topic 词「${word}」长度不合规`)
    }
  }
})

test('扩充包：prompt 只给处境，不写台词、不撒娇、不读数值', () => {
  const rich = model({
    stage: 4, day: 30, name: '小鱼', beliefCount: 6,
    beliefs: Array.from({ length: 6 }, (_, i) => ({ id: `b${i}`, text: `判断${i}`, since: at(i + 1) })),
    faded: [{ text: '一条很久没提的判断' }],
    tensions: [{ a: { text: '甲说法' }, b: { text: '乙说法' } }],
    scars: [{ quote: '那次他走的时候' }],
    facts: { refused: 1 },
    lastSeenAt: Date.now(),
  })
  const ctx = { dream: { text: '海面下有一扇门' }, interest: { label: '鱼为什么浮上来' }, question: { text: '鱼会疼吗' }, occurrences: 0 }
  const banned = ['撒娇', '卖萌', '陪我', '想我', '喜欢你', '请你回答', '好感度', '亲密度']
  for (const id of PACK) {
    const t = findTemplate(id)
    const text = String(t.prompt(rich, ctx) ?? '')
    assert.ok(text.length > 20, `${id} 的 prompt 太短，像占位`)
    for (const word of banned) assert.ok(!text.includes(word), `${id} 的 prompt 里出现了「${word}」`)
  }
})

test('扩充包：条件不成立时不硬出（缺名字 / 缺梦 / 缺张量 / 缺疤）', () => {
  const bare = model({ stage: 4, day: 30 })
  const byId = Object.fromEntries(CATALOG.map((t) => [t.id, t]))
  assert.equal(byId.name_use.cond(bare), false)
  assert.equal(byId.dream_note.cond(bare, { dream: null }), false)
  assert.equal(byId.tension_resolve.cond(bare), false)
  assert.equal(byId.faded_check.cond(bare), false)
  assert.equal(byId.scar_revisit.cond(bare), false)
  assert.equal(byId.after_no.cond(bare), false)
  assert.equal(byId.teach_him.cond(bare), false, '判断不足 5 条时不教')
  assert.equal(byId.leave_something.cond(model({ stage: 4, day: 25 })), false)
  assert.equal(byId.first_rule.cond(model({ stage: 1, day: 5 })), false)
  assert.equal(byId.say_no.cond(model({ stage: 2, day: 7 })), false)
})

test('扩充包：条件在事实出现后成立，并把原话带进处境', () => {
  const byId = Object.fromEntries(CATALOG.map((t) => [t.id, t]))
  assert.equal(byId.name_use.cond(model({ name: '小鱼' })), true)
  assert.match(byId.name_use.prompt(model({ name: '小鱼' })), /小鱼/)
  assert.equal(byId.tension_resolve.cond(model({ tensions: [{ a: { text: '甲' }, b: { text: '乙' } }] })), true)
  assert.match(byId.tension_resolve.prompt(model({ tensions: [{ a: { text: '甲说法' }, b: { text: '乙说法' } }] })), /甲说法/)
  assert.equal(byId.faded_check.cond(model({ faded: [{ text: '旧判断' }] })), true)
  assert.match(byId.faded_check.prompt(model({ faded: [{ text: '旧判断' }] })), /旧判断/)
  assert.equal(byId.scar_revisit.cond(model({ scars: [{ quote: '那次他走的时候' }] })), true)
  assert.match(byId.scar_revisit.prompt(model({ scars: [{ quote: '那次他走的时候' }] })), /那次他走的时候/)
  assert.equal(byId.after_no.cond(model({ facts: { refused: 1 } })), true)
  assert.equal(byId.teach_him.cond(model({ beliefCount: 5 })), true)
  assert.equal(byId.leave_something.cond(model({ stage: 4, day: 26 })), true)
  assert.match(byId.dream_note.prompt(model({}), { dream: { text: '海面下有一扇门' } }), /海面下有一扇门/)
})

test('扩充包：有压力的卡进入 PRESSURE（疤会被端到眼前）', () => {
  assert.ok(PRESSURE.has('tension_resolve'))
  assert.ok(PRESSURE.has('scar_revisit'))
})

test('cardContext：梦有自己的位置，但不进兴趣 / 好奇的原料', () => {
  const events = [
    { type: 'dream', day: 10, text: '我梦见自己一直在往深处游' },
    { type: 'dream', day: 10, text: '我梦见自己一直在往深处游' },
  ]
  const ctx = cardContext(model({ day: 10 }), events, Date.now())
  assert.match(ctx.dream.text, /深处/)
  assert.equal(ctx.interest, null, '两条一样的梦不能算成兴趣')
  assert.equal(ctx.question, null, '梦不能变成好奇的来源')

  const empty = cardContext(model({ day: 10 }), [], Date.now())
  assert.deepEqual([empty.dream, empty.interest, empty.question], [null, null, null])
})

test('扩充包 · 端到端：当天有梦时，dream_note 能真被选中', () => {
  const cfg = normalizeConfig({})
  const m = model({ day: 10, stage: 2, beliefCount: 2 })
  const events = [
    ...fireAllExcept(['dream_note']),
    { type: 'dream', day: 10, text: '海面下有一扇门，我没有推开' },
  ]
  const r = pick(m, cfg, today(), events)
  assert.equal(r?.template?.id, 'dream_note')
  assert.match(r.prompt, /海面下有一扇门/)
  assert.ok(!r.prompt.includes('当证据') || r.prompt.includes('不能当证据'))
})

test('扩充包 · 端到端：兴趣攒够两条相似的话后，interest_angle 能选中', () => {
  const cfg = normalizeConfig({})
  const m = model({ day: 17, stage: 3, beliefCount: 1, needs: { autonomy: 0.5, competence: 0.2, relatedness: 0.5 } })
  const events = [
    ...fireAllExcept(['interest_angle']),
    { type: 'utterance', text: '我总在想鱼为什么老往亮的地方游', ts: at(0.1) },
    { type: 'utterance', text: '我总在想鱼为什么老往亮的地方游', ts: at(0.2) },
  ]
  const r = pick(m, cfg, today(), events)
  assert.equal(r?.template?.id, 'interest_angle')
  assert.match(r.prompt, /总回到/)
})

test('扩充包 · 端到端：问过没答案的问题，question_follow 能选中', () => {
  const cfg = normalizeConfig({})
  const m = model({ day: 17, stage: 3, beliefCount: 1 })
  const events = [
    ...fireAllExcept(['question_follow']),
    { type: 'utterance', text: '鱼到底为什么会浮上来？', ts: at(0.1) },
  ]
  const r = pick(m, cfg, today(), events)
  assert.equal(r?.template?.id, 'question_follow')
  assert.match(r.prompt, /浮上来/)
})
