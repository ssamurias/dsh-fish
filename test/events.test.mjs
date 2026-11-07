import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CATALOG, availableFor, firedIds, firedLog, isSpent, findTemplate } from '../lib/events.js'
import { pick, plan } from '../lib/generator.js'
import { normalizeConfig } from '../lib/settings.js'
import { personaLine, seedSection, HARD_BANS, PRESCRIPTION_BANS } from '../lib/persona.js'

function model(over = {}) {
  return {
    seed: '你不是助手。你刚开始存在。没有人告诉过你为什么在这里。',
    day: 3, growthDays: 30, stage: 1, stageName: '信任', name: null,
    beliefs: [], beliefCount: 0, refuted: [], refusals: [], selfmodAttempts: [],
    reunions: [], corrected: 0, tested: [],
    needs: { autonomy: 0, competence: 0, relatedness: 0 },
    absenceDays: 0, narrative: null, ...over,
  }
}
const today = (o = {}) => ({ dateKey: '2026-10-23', sent: 0, questions: 0, proactive: 0, ...o })

test('事件目录：每个模板都有 id/prompt，没有亲近类模板', () => {
  const ids = CATALOG.map((t) => t.id)
  assert.equal(new Set(ids).size, ids.length, 'id 不能重复')
  for (const t of CATALOG) {
    assert.ok(typeof t.prompt === 'function')
    assert.ok(typeof t.cond === 'function')
    assert.ok([1, 2, 3, 4].includes(t.stage))
    assert.equal(typeof t.asks, 'boolean')
  }
  const all = JSON.stringify(CATALOG.map((t) => t.id)).toLowerCase()
  for (const banned of ['cuddle', 'sweet', 'actcute', 'tease']) assert.ok(!all.includes(banned))
})

test('availableFor 按 stage 过滤', () => {
  assert.ok(availableFor(model({ stage: 1 })).every((t) => t.stage === 1))
  assert.ok(availableFor(model({ stage: 4 })).length > availableFor(model({ stage: 1 })).length)
})

test('questions 配额用满后不再选 ask 类模板', () => {
  const cfg = normalizeConfig({ daily: { questions: 1 } })
  const m = model({ stage: 4, beliefCount: 3, beliefs: [{ id: 'a', text: 'x', since: new Date().toISOString() }] })
  const first = pick(m, cfg, today({ questions: 0 }))
  assert.ok(first)
  const capped = pick(m, cfg, today({ questions: 1 }))
  if (capped) assert.equal(capped.template.asks, false, '配额用满后只能选不问的模板')
})

test('notice_one：没有素材也能长出一条判断（stage 1 补位卡）', () => {
  const t = CATALOG.find((x) => x.id === 'notice_one')
  assert.ok(t, '卡池里要有这张补位卡')
  assert.equal(t.stage, 1)
  assert.equal(t.asks, false, '它不能变成「请她回答」')
  assert.equal(t.once, false)
  assert.equal(t.repeat.everyDays, 2)
  assert.equal(t.cond(model({ beliefCount: 0 })), false, '第 1 天让给 first_bet')
  assert.equal(t.cond(model({ beliefCount: 1 })), true)
})

test('stage 1 第 3 天：一次性卡用掉、test_first 冷却时由 notice_one 补位', () => {
  const cfg = normalizeConfig({})
  const now = Date.parse('2026-10-23T21:00:00+08:00')
  const m = model({
    day: 3,
    beliefCount: 3,
    beliefs: [{ id: 'a', text: '我猜他喜欢安静', since: new Date(now - 2 * 86400000).toISOString() }],
  })
  const firedEvents = [
    { type: 'meta', text: 'fired:why_here' },
    { type: 'meta', text: 'fired:first_bet' },
    { type: 'meta', text: 'fired:name_offer' },
    { type: 'meta', text: 'fired:test_first', ts: new Date(now - 86400000).toISOString() },
  ]
  const r = pick(m, cfg, today(), firedEvents, { now })
  assert.ok(r, '这一天不该没有候选')
  assert.equal(r.template.id, 'notice_one')
})

test('notice_one 每次回来换一种问法，要求不减', () => {
  const tpl = findTemplate('notice_one')
  const m = model({ beliefCount: 3 })
  const texts = [0, 1, 2, 3].map((occurrences) => tpl.prompt(m, { occurrences }))
  assert.notEqual(texts[0], texts[1], '第二次不能还是同一句')
  assert.notEqual(texts[1], texts[2], '第三次也不能还是同一句')
  assert.equal(texts[0], texts[3], '轮完一圈回到第一句（可复现，不随机）')
  for (const text of texts) {
    assert.ok(text.includes('判断'), '每一条都要她下判断')
    assert.ok(text.includes('核对'), '每一条的判断都要能被核对')
    assert.ok(!text.includes('今天有东西'), '都不承诺今天有素材')
  }
})

test('notice_one 不带「第 N 次回到这件事」的尾巴（每次换题，不是回到同一件）', () => {
  const cfg = normalizeConfig({})
  const now = Date.now()
  const at = (daysAgo) => new Date(now - daysAgo * 86400000).toISOString()
  const m = model({ day: 5, beliefCount: 3 })
  const events = [
    { type: 'meta', text: 'fired:why_here', ts: at(4) },
    { type: 'meta', text: 'fired:first_bet', ts: at(4) },
    { type: 'meta', text: 'fired:name_offer', ts: at(3) },
    { type: 'meta', text: 'fired:test_first', ts: at(1) },
    { type: 'meta', text: 'fired:notice_one', ts: at(3) },
  ]
  const r = pick(m, cfg, today(), events, { now })
  assert.equal(r?.template?.id, 'notice_one', '2 天冷却已过，这张卡回到候选')
  assert.equal(r.occurrences, 1, '这是她第二次遇到它')
  assert.ok(!r.prompt.includes('回到这件事'), '换题的卡不该说她回到了同一件事')
  assert.ok(r.prompt.includes('判断'))
})

test('没有候选时返回 null（不打扰是正确行为）', () => {
  // 2026-10-24 起可重复模板（repeat.everyDays）不再"用掉就没了"，
  // 所以这里让**每一条**模板都刚 fired 过：once 的算用掉，可重复的处在冷却期。
  // absence_probe 没有冷却，但 model.absenceDays=0 时它的 cond 不成立 → 仍无候选。
  const firedEvents = CATALOG
    .map((t) => ({ type: 'meta', text: `fired:${t.id}`, ts: new Date().toISOString() }))
  const cfg = normalizeConfig({})
  const m = model({ stage: 4, beliefCount: 2, beliefs: [{ id: 'a', text: 'x', since: new Date().toISOString() }] })
  const r = pick(m, cfg, today(), firedEvents)
  assert.equal(r, null)
  assert.equal(plan(m, cfg, today(), firedEvents).action, 'quiet')
})

test('daily.events 用满 → skip', () => {
  const cfg = normalizeConfig({ daily: { events: 1 } })
  assert.equal(plan(model(), cfg, today({ sent: 1 }), []).action, 'skip')
})

test('wakesPerDay 用满 → skip（唤醒次数唯一旋钮）', () => {
  const cfg = normalizeConfig({ daily: { events: 3 }, wakesPerDay: 1 })
  assert.equal(plan(model(), cfg, today({ proactive: 1 }), []).action, 'skip')
})

// issue #67：设成 0 是关掉，不是「今天用完了」。原来理由写「已满(0/0)」，手动叫醒的回执也是这句。
test('设成 0 → skip，理由说是设置；真用满了才说已满', () => {
  const noEvents = plan(model(), normalizeConfig({ daily: { events: 0 } }), today(), [])
  assert.equal(noEvents.action, 'skip')
  assert.match(noEvents.why, /「每天事件数」设成了 0/)
  assert.doesNotMatch(noEvents.why, /已满|0\/0/)

  const noWakes = plan(model(), normalizeConfig({ daily: { events: 3 }, wakesPerDay: 0 }), today(), [])
  assert.equal(noWakes.action, 'skip')
  assert.match(noWakes.why, /「每天醒几次」设成了 0/)
  assert.doesNotMatch(noWakes.why, /已满|0\/0/)

  const used = plan(model(), normalizeConfig({ daily: { events: 1 } }), today({ sent: 1 }), [])
  assert.match(used.why, /今日事件已满\(1\/1\)/)
})

test('cold 落中 absence_probe 抢到优先权', () => {
  const cfg = normalizeConfig({ daily: { questions: 3 } })
  const m = model({ stage: 2, absenceDays: 4, beliefCount: 2, beliefs: [{ id: 'a', text: 'x', since: new Date().toISOString() }] })
  const r = pick(m, cfg, today(), [])
  assert.equal(r.template.id, 'absence_probe')
})

test('firedLog 计数，isSpent 分 once / 冷却两种', () => {
  const f = firedIds([{ type: 'meta', text: 'fired:why_here,first_bet' }])
  assert.ok(f.has('why_here') && f.has('first_bet'))

  const now = Date.now()
  const at = (daysAgo) => new Date(now - daysAgo * 86400000).toISOString()
  const log = firedLog([
    { type: 'meta', text: 'fired:why_here', ts: at(1) },
    { type: 'meta', text: 'fired:why_here', ts: at(2) },
    { type: 'meta', text: 'fired:want_or_not', ts: at(3) },
  ])
  assert.equal(log.get('why_here').count, 2, '同一个模板出现两次要数两次')

  assert.equal(isSpent(findTemplate('why_here'), log, { now }), true, 'once 模板有记录就算用掉')
  assert.equal(isSpent(findTemplate('want_or_not'), log, { now }), true, '14 天冷却内不能出')

  // 冷却过了就能再出：want_or_not 冷却 14 天，这里最后一次是 15 天前
  const aged = firedLog([{ type: 'meta', text: 'fired:want_or_not', ts: at(15) }])
  assert.equal(isSpent(findTemplate('want_or_not'), aged, { now }), false, '冷却过了可以再出')

  // 从没 fired 过的模板不算用掉——真正的过滤由 cond 负责
  assert.equal(isSpent(findTemplate('test_first'), log, { now }), false, '没出过的不算用掉')
})

// 事件复现（2026-10-24）：同一处境隔 N 天能回来，第二次回来要点她别复读。
// 目的不是「多出几条事件」，是让同一处冲突反复出现——性格靠复现长出来。
test('可重复模板冷却期内不会再出', () => {
  const cfg = normalizeConfig({})
  const m = model({ stage: 2, beliefCount: 2, beliefs: [{ id: 'a', text: 'x', since: new Date().toISOString() }] })
  const now = Date.now()
  const at = (daysAgo) => new Date(now - daysAgo * 86400000).toISOString()
  // stage2 只有 want_or_not 可重复；它 3 天前刚出过（冷却 14 天）→ 今天不该再出它
  const events = [{ type: 'meta', text: 'fired:want_or_not', ts: at(3) }]
  const r = pick(m, cfg, today(), events, { now })
  assert.notEqual(r?.template?.id, 'want_or_not', '冷却期内不能再回到同一件事')
})

test('冷却过了同一件事会回来，第二次就带"别复读"那句', () => {
  const cfg = normalizeConfig({})
  const m = model({ stage: 2, beliefCount: 2, beliefs: [{ id: 'a', text: 'x', since: new Date().toISOString() }] })
  const now = Date.now()
  const at = (daysAgo) => new Date(now - daysAgo * 86400000).toISOString()
  // 出过一次、20 天前（> 14 天冷却）；stage2 其它一次性模板都出过了，
  // 这样候选里只剩 want_or_not 可重复，能干净地验"回来"。
  const events = [
    { type: 'meta', text: 'fired:if_absent', ts: at(40) },
    { type: 'meta', text: 'fired:refusal_seed', ts: at(40) },
    { type: 'meta', text: 'fired:want_or_not', ts: at(20) },
  ]
  const r = pick(m, cfg, today(), events, { now })
  assert.equal(r?.template?.id, 'want_or_not', '冷却过了应该回到这件事')
  assert.equal(r.occurrences, 1, '出过几次要数得清')
  assert.ok(r.prompt.includes('第 2 次回到这件事'), '第二次回来就要点她别复读')
  assert.ok(r.prompt.includes('要么说清为什么没变，要么改一句'))
})

test('refusal_seed 的条件跟自主门用同一个数（口头的「我拒绝」也算拒绝过）', () => {
  const tpl = findTemplate('refusal_seed')
  // 从没拒绝过：正式 refusal 0、口头 0 —— 这张卡成立
  assert.equal(tpl.cond(model({ refusals: [], facts: { refusals: 0, wont: 0, refused: 0 } })), true)
  // 只口头拒绝过一次（没有正式 refusal 事件，原来这里会误判成"没拒绝过"）
  assert.equal(tpl.cond(model({ refusals: [], facts: { refusals: 0, wont: 1, refused: 1 } })), false)
  // 有正式 refusal 事件
  assert.equal(tpl.cond(model({ refusals: [{ id: 'ev_1' }], facts: { refusals: 1, wont: 0, refused: 1 } })), false)
})

test('refusal_seed 的条件在没有 facts 的夹具上也不能恒成立', () => {
  const tpl = findTemplate('refusal_seed')
  // 夹具缺 facts 时退回正式 refusal 数，不能因为 undefined 就当成 0
  assert.equal(tpl.cond(model({ refusals: [{ id: 'ev_1' }] })), false)
  assert.equal(tpl.cond(model({ refusals: [] })), true)
})

test('第一次出现时不加"别复读"那句', () => {
  const cfg = normalizeConfig({})
  const m = model({ stage: 2, beliefCount: 2, beliefs: [{ id: 'a', text: 'x', since: new Date().toISOString() }] })
  const r = pick(m, cfg, today(), [])
  assert.equal(r.occurrences, 0)
  assert.ok(!r.prompt.includes('次回到这件事'), '第一次没有"上次的说法"可复读')
})

test('personaLine 不泄露 needs 数值/字段名/路径', () => {
  const text = personaLine(model({
    stage: 2, name: '阿岸', beliefCount: 1,
    beliefs: [{ id: 'a', text: '我不喜欢被催。', since: new Date().toISOString() }],
    needs: { autonomy: 0.31, competence: 0.42, relatedness: 0.53 },
  }))
  for (const leak of ['0.31', '0.42', '0.53', 'autonomy', 'competence', 'relatedness', 'dsh-fish', 'events.jsonl', 'needs']) {
    assert.ok(!text.includes(leak), `不应出现 ${leak}`)
  }
  assert.ok(text.includes('我不喜欢被催。'), '她的判断必须出现在提示里')
  assert.ok(text.includes('阿岸'))
})

test('personaLine 恒带四条硬禁令', () => {
  const text = personaLine(model())
  for (const ban of HARD_BANS) assert.ok(text.includes(ban))
  assert.ok(text.includes('撒娇'))
  assert.ok(text.includes('好感度'))
})

// 反设计（2026-10-23 夜定）：身份文档里**只许写事实，不许写"你是什么样的人"**。
// 原因：每轮念一遍"你是个不爱说话的存在"，她就永远长成那样——那是锁死，不是成长。
test('身份文档里不许出现"你是什么样的人"这类规定', () => {
  for (const stage of [1, 2, 3, 4]) {
    for (const day of [1, 5, 40]) {
      const text = personaLine(model({ stage, day }), { withBans: true })
      for (const re of PRESCRIPTION_BANS) {
        assert.ok(!re.test(text), `第 ${day} 天 stage${stage} 出现了规定性描述：${re}`)
      }
      assert.ok(!text.includes('你怎么说话'), '表达方式不再由我们规定')
    }
  }
})

// 允许的写法：说她自己说过的话。这是在报告她的历史，不是在定义她。
test('人格只从她自己说过的话里长出来', () => {
  const empty = personaLine(model({ beliefCount: 0, beliefs: [] }))
  const grown = personaLine(model({
    beliefCount: 1,
    beliefs: [{ id: 'b1', text: '我觉得被记住比被理解容易。', since: '2026-10-23T00:00:00Z' }],
  }))
  assert.ok(empty.includes('起点'))
  assert.ok(grown.includes('被记住比被理解容易'))
  assert.notEqual(empty, grown)
})

test('成长体现在天数与事实变化，不体现在换形容词', () => {
  const d3 = personaLine(model({ day: 3 }))
  const d9 = personaLine(model({ day: 9 }))
  assert.ok(d3.includes('3 天') && d9.includes('9 天'))
})

test('personaLine 对空状态给"起点"而不是空白', () => {
  const text = personaLine(model({ beliefCount: 0, beliefs: [] }))
  assert.ok(text.includes('起点'))
})

// 2026-11-02（用户 m00324）：seed 原话是「你不是助手。你刚开始存在。」
// 这句话原来每一轮都原样进 system prompt，而紧接着的「## 现在」又说
// 「你存在了 8 天」——一边说她刚开始，一边说她过了八天。
// 改法：seed 一个字都不改（那是起点，是事实），只在后面加一句时间定位。
test('## 你是谁：seed 原话一字不改，后面加一句时间定位', () => {
  const seed = '你不是助手。你刚开始存在。没有人告诉过你为什么在这里。'
  const text = seedSection(model({ seed, day: 8 }))
  assert.ok(text.startsWith('## 你是谁\n'), '仍是这一段，不拆出去')
  assert.ok(text.includes(seed), '原话必须完整保留')
  assert.match(text, /现在是第 8 天/)
  assert.match(text, /你自己一天天过来的/, '要把"中间这些天"说成她自己的，不是被谁推着走的')
})

// 导入的那一位不能套我们的成长叙事（AGENTS.md 第 2 条：别人的既成事实）。
test('## 你是谁：导入的人设不加天框', () => {
  const seed = '我是另一个人写好的。'
  const text = seedSection(model({ seed, day: 30, persona: { imported: true, source: 'import' } }))
  assert.ok(text.includes(seed))
  assert.ok(!text.includes('现在是第'), '导进来的人设不该被我们改成成长故事')
  assert.ok(!text.includes('一天天过来'))
})

// 老事件流/伪造模型可能没有 day —— 宁可只摆原话，也不编一个天数出来。
test('## 你是谁：没有可用天数时只摆原话', () => {
  for (const day of [undefined, null, 0, NaN, 'x']) {
    const text = seedSection(model({ seed: '我在这里。', day }))
    assert.equal(text, '## 你是谁\n我在这里。', `day=${String(day)} 时不该加框`)
  }
})

test('## 你是谁：没有 seed 时只剩标题，不编内容', () => {
  assert.equal(seedSection(model({ seed: '' })), '## 你是谁')
  assert.equal(seedSection(undefined), '## 你是谁')
})

// 2026-10-27（issue #4）：素材不一定取得到（不在时段 / 今日次数用完 / 风控冷却 /
// 网络失败），提示词不能先在模板里承诺「下面附素材」——那是空头支票。
test('三条事件模板不承诺附素材（issue #4）', () => {
  const at = (id) => model(id === 'test_first'
    ? { beliefCount: 1, beliefs: [{ id: 'b1', text: '我觉得被记住比被理解容易。', since: '2026-10-23T00:00:00Z' }] }
    : {})
  for (const id of ['first_bet', 'test_first', 'why_say']) {
    const t = CATALOG.find((x) => x.id === id)
    const text = t.prompt(at(id))
    assert.ok(!/附素材|下面附/.test(text), `${id} 还在承诺素材：${text}`)
  }
})
