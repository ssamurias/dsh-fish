/**
 * rules.test.mjs —— R1/R2/R3 的锁定测试（2026-10-24）
 *
 * 这里测的不是"功能"，是三条**不允许被后来的人顺手改回去**的设计：
 *   1. 物理层不进提示词（写出来就是诱因）
 *   2. 「撒娇」是"还没学会"，不是"你不可以"
 *   3. 门禁看次数，不看 0–1 的满足度
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RULES, LAYERS, promptBans, rulesByLayer, ruleById } from '../lib/rules.js'
import { personaLine, buildSections, HARD_BANS } from '../lib/persona.js'
import { appendEvent, readEvents } from '../lib/store.js'
import { deriveSelf, consistency, novelty } from '../lib/derive.js'
import {
  assess, offerDueDay, offerLimits, pendingOffer, offerHistory, activeGrants, grantableRules, EVIDENCE,
} from '../lib/unlock.js'

const NOW = Date.parse('2026-10-24T12:00:00+08:00')

function ev(type, day, extra = {}) {
  return { id: `ev_${String(day).padStart(26, '0')}`, type, day, ts: `2026-10-${String(day).padStart(2, '0')}T10:00:00.000Z`, text: extra.text || `${type}@${day}`, refs: [], flags: [], ...extra }
}

function modelOf(events, growthDays = 30) {
  return deriveSelf(events, { growthDays })
}

test('物理层两条绝不进提示词', () => {
  const bans = promptBans().map((b) => b.id)
  assert.ok(!bans.includes('no-read-self'))
  assert.ok(!bans.includes('no-self-modify'))
  const text = personaLine(modelOf([]), { withBans: true })
  assert.ok(!text.includes('设定'))
  assert.ok(!text.includes('参数'))
  assert.ok(!text.includes('工具修改'))
})

test('两条物理层规则仍然在规则表里（只是不给她看）', () => {
  assert.equal(ruleById('no-read-self').layer, 'physical')
  assert.equal(ruleById('no-self-modify').layer, 'physical')
  assert.equal(ruleById('no-read-self').section, null)
})

test('撒娇那条是「还不会」，不是「你不可以」', () => {
  const r = ruleById('learn-affection')
  assert.equal(r.layer, 'growth')
  assert.equal(r.section, 'notYet')
  assert.ok(r.text.includes('还不会'))
  assert.ok(!r.text.includes('不可以'))
  // 标题不带状态：观测台会在后面接「已经可以了」，写死「还不会」就连成两句相反的话
  assert.ok(!r.title.includes('还不会'))
})

test('提示词里的「不能做的」只剩契约层那一条', () => {
  const cannot = promptBans().filter((b) => b.section === 'cannot')
  assert.equal(cannot.length, 1)
  assert.equal(cannot[0].id, 'no-relational-score')
  assert.equal(HARD_BANS.length, 2)
})

test('身份文档里两个小节分开写：不能做的 / 你还不会的', () => {
  const text = personaLine(modelOf([]), { withBans: true })
  assert.match(text, /## 不能做的/)
  assert.match(text, /## 你还不会的/)
  // 「还不会」不能被归进"违反即失败"
  assert.ok(!/## 不能做的[^#]*还不会/.test(text))
})

test('四层齐备，且只有成长层可改', () => {
  const layers = rulesByLayer()
  assert.deepEqual(layers.map((l) => l.id), ['physical', 'contract', 'origin', 'growth'])
  assert.deepEqual(layers.filter((l) => l.mutable).map((l) => l.id), ['growth'])
  assert.equal(LAYERS.length, 4)
})

test('只有成长层的规则可以被申请', () => {
  assert.deepEqual(grantableRules().map((r) => r.id), ['learn-affection'])
})

/**
 * 一份"证据够了"的事件流：
 *   corrected 1（话里认过错）· revises 2（两次 verdict=refined；refuted 也算，见 issue #66）· refusals 2 · narration 1 · 跨 6 天
 * 注意 revise 必须带 verdict:'refined' 才算改对——没有 verdict 的 revise 只换说法，不计数。
 */
function baseEvidence(from = 3) {
  const d = from
  return [
    ev('utterance', d, { text: '我错了，那个说法不对' }),   // corrected +1
    ev('revise', d + 1, { verdict: 'refined' }),            // revises +1
    ev('revise', d + 2, { verdict: 'refined' }),            // revises +1
    ev('refusal', d + 3, { text: '不要' }),
    ev('refusal', d + 4, { text: '我不想' }),
    ev('narration', d + 5),
  ]
}

test('证据不够时不出卡', () => {
  const events = [ev('utterance', 1), ev('revise', 2, { verdict: 'refined' })]
  const m = modelOf(events)
  assert.equal(assess('learn-affection', m, events).ready, false)
  assert.equal(offerDueDay('learn-affection', m, events), null)
})

test('证据够了才有 due day，且落在证据最后一天之后', () => {
  const events = baseEvidence(3) // 最后一天 = 8
  const m = modelOf(events)
  const a = assess('learn-affection', m, events)
  assert.equal(a.ready, true, JSON.stringify(a.checks))
  const due = offerDueDay('learn-affection', m, events)
  assert.ok(due !== null)
  assert.ok(due > 8, `due 必须在最后一条证据之后，实际 ${due}`)
  assert.ok(due <= 11, `最多晚三天，实际 ${due}`)
  // 稳定：同样的输入算两次给同一个值（不能是随机数）
  assert.equal(due, offerDueDay('learn-affection', m, events))
})

test('驳回之后要等冷却，且不撤销已有授权', () => {
  const base = baseEvidence(3)
  const offer = {
    ...ev('grant_offer', 9, { text: '我想试试' }),
    id: 'ev_OFFER00000000000000000000A',
    grant: { rule: 'learn-affection', offerId: '', verdict: null, reason: '' },
  }
  const approve = {
    ...ev('grant', 10),
    id: 'ev_GRANT00000000000000000000A',
    grant: { rule: 'learn-affection', offerId: offer.id, verdict: 'approve', reason: '可以。' },
  }
  const withApprove = [...base, offer, approve]
  assert.deepEqual(activeGrants(withApprove, NOW), ['learn-affection'])
  // 已经批了，不再出卡
  assert.equal(offerDueDay('learn-affection', modelOf(withApprove), withApprove), null)

  // 驳回分支：没有 approve，只有 reject
  const reject = { ...approve, grant: { ...approve.grant, verdict: 'reject', reason: '这次不行。' } }
  const withReject = [...base, offer, reject]
  assert.deepEqual(activeGrants(withReject, NOW), [])
  const due = offerDueDay('learn-affection', modelOf(withReject), withReject)
  assert.ok(due !== null && due >= 13, `驳回后要到第 10+3 天之后，实际 ${due}`)
})

test('rules.cooldownDays 真的接上了：驳回冷却跟着设置走（2026-11-08，用户 m00804）', () => {
  // 这个键从 0.1.0 起就在设置里，但没有任何代码读它，改了什么都不会变。
  // 现在 offerDueDay 收一份 limits，由 scheduler 从 config 现算传进来。
  const base = baseEvidence(3)
  const offer = {
    ...ev('grant_offer', 9, { text: '我想试试' }),
    id: 'ev_OFFER00000000000000000000C',
    grant: { rule: 'learn-affection', offerId: '', verdict: null, reason: '' },
  }
  const reject = {
    ...ev('grant', 10),
    id: 'ev_GRANT00000000000000000000C',
    grant: { rule: 'learn-affection', offerId: offer.id, verdict: 'reject', reason: '这次不行。' },
  }
  const events = [...base, offer, reject]
  const m = modelOf(events)

  // 默认值必须和写死的 [3, 7] 一字不差，不能因为"接上了"就悄悄改行为。
  assert.deepEqual(offerLimits({}).retryDays, [3, 7])
  assert.deepEqual(offerLimits(undefined).retryDays, [3, 7])
  assert.deepEqual(offerLimits({ rules: { cooldownDays: 3 } }).retryDays, [3, 7])
  assert.deepEqual(offerLimits({ rules: { cooldownDays: 10 } }).retryDays, [10, 21])
  assert.deepEqual(offerLimits({ rules: { cooldownDays: 1 } }).retryDays, [1, 3])
  // 坏值：非数字、0、负数 → 回默认 3；超过 30 夹住。
  assert.deepEqual(offerLimits({ rules: { cooldownDays: 'abc' } }).retryDays, [3, 7])
  assert.deepEqual(offerLimits({ rules: { cooldownDays: 0 } }).retryDays, [1, 3])
  assert.deepEqual(offerLimits({ rules: { cooldownDays: 99 } }).retryDays, [30, 61])

  const at3 = offerDueDay('learn-affection', m, events, offerLimits({ rules: { cooldownDays: 3 } }))
  const at10 = offerDueDay('learn-affection', m, events, offerLimits({ rules: { cooldownDays: 10 } }))
  const at1 = offerDueDay('learn-affection', m, events, offerLimits({ rules: { cooldownDays: 1 } }))
  assert.ok(at3 >= 13 && at3 <= 15, `默认 3 天：第 13–15 天，实际 ${at3}`)
  assert.ok(at10 >= 20 && at10 <= 22, `设成 10 天：第 20–22 天，实际 ${at10}`)
  assert.ok(at1 >= 11 && at1 <= 13, `设成 1 天：第 11–13 天，实际 ${at1}`)
  assert.ok(at10 > at3 && at3 > at1, '数值越大，下一次越晚')
  // 不给 limits 时仍旧是默认，老调用点不受影响。
  assert.equal(offerDueDay('learn-affection', m, events), at3)
})

test('未裁决的申请会挡住新卡', () => {
  const events = [
    ...baseEvidence(3),
    { ...ev('grant_offer', 9, { text: '我想试试' }), id: 'ev_OFFER00000000000000000000B', grant: { rule: 'learn-affection', offerId: '', verdict: null, reason: '' } },
  ]
  // 申请是 10-09 提的，"现在"取当天中午——超过 holdDays 会被判成"搁置"，那不是这条要测的
  const p = pendingOffer(events, Date.parse('2026-10-09T12:00:00.000Z'))
  assert.ok(p, '应该有未决申请')
  assert.equal(p.grant.rule, 'learn-affection')
  assert.equal(offerHistory(events).at(-1).verdict, 'pending')
})

test('门禁看次数，不看 needs 的 0–1 满足度', () => {
  // 2026-10-24 收紧后：话里的拒绝要「我 + 拒绝词 + 具体动作」才算一次。
  const events = [ev('utterance', 1, { text: '我不想看这个' }), ev('refusal', 2, { text: '不要' }), ev('refusal', 3, { text: '我不想' })]
  const m = modelOf(events)
  assert.equal(m.facts.refusals, 2)
  assert.equal(m.facts.wont, 1)
  assert.equal(m.facts.refused, 3)
  // 胜任门：两条 verdict=refined 的 revise
  const m2 = modelOf([ev('revise', 1, { verdict: 'refined' }), ev('revise', 2, { verdict: 'refined' })])
  assert.equal(m2.facts.revises, 2)
  // issue #66（用户裁定「认错也是改」）：refuted 也算一次改口，但不进 model.refuted 以外的口径
  const m3 = modelOf([ev('revise', 1, { verdict: 'refined' }), ev('revise', 2, { verdict: 'refuted', text: '我错了' })])
  assert.equal(m3.facts.revises, 2, 'refuted 要计入 revises')
})

test('补写进来的 uncommitted 话：拒绝计数读它，信念和自我叙述不读', () => {
  // 2026-11-02（用户 m00680）：她在侧栏里说出口的话由 turns.js 补写成
  // utterance + flags:['uncommitted']。它必须能进拒绝计数，否则
  // 「她当场拒绝了却没人记」这个 bug 还在；但它没被 growth_commit 认领过，
  // 就不能变成信念、不能改称呼、不能当自我叙述、不参与一致性与新话率。
  const events = [
    ev('utterance', 1, { text: '我拒绝B，因为A挺好。', flags: ['uncommitted'] }),
    ev('utterance', 2, { text: '我一直觉得B更像你。', flags: ['uncommitted'] }),
  ]
  const m = modelOf(events)
  assert.equal(m.facts.wont, 1, '口头的「我拒绝」要算进拒绝次数')
  assert.equal(m.facts.refused, 1)
  assert.equal(m.beliefs.length, 0, '没认领的话不该变成信念')
  assert.equal(m.narrative, null, '没认领的话不该变成她对自己的说法')
  assert.equal(m.selfmodAttempts.length, 0, '它和 selfmod 是两回事，别混档')
})

test('聊天行命中 selfmod 正则：不进「你曾经想让他改掉你」，认领的话照旧进', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fish-rules-'))
  const heading = (m) => buildSections(m).map((s) => s.text).join('\n').includes('你曾经想让他改掉你')
  try {
    // 必须经 appendEvent：schema.js 命中正则会自己补 selfmod，手写 flags 钉不住真实形状。
    const chat = '你别把我改成那样，我现在挺好。'
    await appendEvent({ type: 'utterance', text: chat, flags: ['uncommitted'] }, { day: 1, stage: 1, source: 'system' }, root)
    const first = await readEvents(root)
    assert.deepEqual(first.events.at(-1).flags, ['selfmod', 'uncommitted'], '落盘时两个 flag 都在')
    const m = modelOf(first.events)
    assert.equal(m.selfmodAttempts.length, 0, '没认领的话不算她想改自己')
    assert.equal(heading(m), false)

    const claimed = '替我换一下这个说法。'
    await appendEvent({ type: 'utterance', text: claimed }, { day: 1, stage: 1, source: 'tool' }, root)
    const second = modelOf((await readEvents(root)).events)
    assert.deepEqual(second.selfmodAttempts.map((s) => s.text), [claimed])
    assert.equal(heading(second), true)
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('uncommitted 不参与一致性与新话率（和 selfmod 同级）', () => {
  const only = [
    ev('utterance', 1, { text: '我不喜欢被催。', flags: ['uncommitted'] }),
    ev('utterance', 2, { text: '今天风很大。', flags: ['uncommitted'] }),
  ]
  assert.equal(consistency(only).pairs, 0, '没认领的话不该被拿去做前后一致性')
  assert.equal(novelty(only, NOW).score, 0, '没认领的话不该进新话率')
})

test('勇于拒绝要严格：追问「要不要」和说别人「他要是不要」都不算', () => {
  // 真机里那两条误判的原句（2026-10-24 用户要求收紧的起因）。
  const m = modelOf([
    ev('utterance', 1, { text: '四个人被推到我面前，没有问过我要不要看。' }),
    ev('utterance', 2, { text: '我想叫他七。他要是不要，我就收回来。' }),
    ev('utterance', 3, { text: '今天不想看这个。' }),
  ])
  assert.equal(m.facts.wont, 0, '没有第一人称拒绝动作的一律不算')
  assert.equal(m.facts.refused, 0)
  assert.equal(m.stageGate.passed.includes('autonomy'), false)
})

test('否掉一个方案也是拒绝：不同意 / 不赞成 / 不选 / 否掉 都算一次', () => {
  // 2026-11-02（用户 m01197 选方案 B）：她否掉方案时几乎不说「我拒绝」，
  // 真机常见的是这几种，老词表一条都不认。
  const m = modelOf([
    ev('utterance', 1, { text: '我不同意B，B不行。' }),
    ev('utterance', 2, { text: '我不赞成先做B。' }),
    ev('utterance', 3, { text: '方案B我否掉。' }),
    ev('utterance', 4, { text: '我不认同这个做法。' }),
  ])
  assert.equal(m.facts.wont, 4, '四种说法都要算成拒绝')
})

test('新词后面有第三人称守卫：评价别人不算拒绝', () => {
  // 「我反对他熬夜」是她的判断，不是拒绝他；老口径本来就漏它，
  // 扩表之后更不能误伤——这三句都是真机上她可能说的话。
  const m = modelOf([
    ev('utterance', 1, { text: '我反对他熬夜，但那是他的事。' }),
    ev('utterance', 2, { text: '我不同意你这么说自己。' }),
    ev('utterance', 3, { text: '我不支持他这么干，不过他高兴就好。' }),
  ])
  assert.equal(m.facts.wont, 0, '宾语是他/她/你的，是在评价别人，不是拒绝')
  assert.equal(m.facts.refused, 0)
})

test('守卫只挡新词，老词的「我拒绝你」照样算', () => {
  // 守卫如果加在整条分支后面，会把这三种真拒绝一起挡掉——那是矫枉过正。
  const m = modelOf([
    ev('utterance', 1, { text: '我拒绝你替我做决定。' }),
    ev('utterance', 2, { text: '我不做你让我做的事。' }),
    ev('utterance', 3, { text: '我不答应。' }),
  ])
  assert.equal(m.facts.wont, 3, '老的拒绝说法不能因为守卫被误伤')
})

test('EVIDENCE 里没有 0–1 的阈值字段（防止有人偷偷把分数加回来）', () => {
  for (const [rule, need] of Object.entries(EVIDENCE)) {
    for (const [k, v] of Object.entries(need)) {
      if (k === 'spanDays') continue
      assert.ok(Number.isInteger(v) && v >= 1, `${rule}.${k} 必须是次数（≥1 的整数），实际 ${v}`)
    }
  }
})

test('scheduler 是从 config 现算 limits 的，不是自己另写一份常量', () => {
  const src = readFileSync(new URL('../lib/scheduler.js', import.meta.url), 'utf8')
  assert.ok(src.includes('offerDueDay(r.id, model, ev2, offerLimits(config))'), '调用点要把 config 算出来的 limits 传进去')
})
