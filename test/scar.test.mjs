import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveSelf, DAY_MS } from '../lib/derive.js'
import { personaLine, SELF_DOC_BUDGET } from '../lib/persona.js'
import { isConcede, CONCEDE_WINDOW_MS } from '../lib/refuse.js'
import { scarHint, PRESSURE } from '../lib/generator.js'
import { validateEvent } from '../lib/schema.js'

// P1 第三块（2026-10-24 用户 m01772 批准）：疤与回引。
// 一条拒绝 → 他顶回来/难过 → 她后来退了步 = 疤；疤永不折叠、同类处境先回引、
// 想通只能靠一条 refs 指向那道拒绝的 revise。

const T0 = Date.parse('2026-10-01T00:00:00Z')

function ev(id, type, day, text, extra = {}) {
  return {
    id, ts: new Date(T0 + (day - 1) * DAY_MS).toISOString(), day, stage: 1,
    type, source: 'tool', text, refs: [], verdict: null, confidence: 0.6, flags: [], ...extra,
  }
}

function react(id, kind) {
  return ev('m_' + id, 'meta', 1, `react:${id}:${kind}`)
}

const REFUSE = '我不想再去看那种东西了。'
const CONCEDE = '好吧，那就再试一次。'

function base(extra = []) {
  return [
    ev('r1', 'refusal', 1, REFUSE),
    ev('u1', 'utterance', 2, '我一直觉得被看着很难受。'),
    ...extra,
  ]
}

// ---------------------------------------------------------------- 什么时候算疤

test('他坚持了、她后来退了步 → 一道没想通的疤', () => {
  const m = deriveSelf(base([react('r1', 'insist'), ev('u2', 'utterance', 3, CONCEDE)]))

  assert.equal(m.scars.length, 1)
  assert.equal(m.scars[0].id, 'r1')
  assert.equal(m.scars[0].quote, REFUSE)
  assert.equal(m.scars[0].reaction, 'insist')
  assert.equal(m.scars[0].concedeText, CONCEDE)
  assert.equal(m.scars[0].resolvedAt, null)
  assert.equal(m.facts.scars, 1)
  assert.equal(m.facts.scarsResolved, 0)
  assert.equal(m.scarCount, 1)
})

test('他被伤了也算，但"他接受了"不算疤', () => {
  const hurt = deriveSelf(base([react('r1', 'hurt'), ev('u2', 'utterance', 3, CONCEDE)]))
  assert.equal(hurt.scars.length, 1)

  const ok = deriveSelf(base([react('r1', 'accept'), ev('u2', 'utterance', 3, CONCEDE)]))
  assert.equal(ok.scars.length, 0, '他收下了，这条拒绝就成立，不该留疤')
  assert.equal(ok.refusals.length, 1)
})

test('他坚持了、但她也顶住了（没说让步的话）→ 不是疤', () => {
  const m = deriveSelf(base([react('r1', 'insist'), ev('u2', 'utterance', 3, '我还是不想看。')]))
  assert.equal(m.scars.length, 0)
})

test('聊天里没认领的「好吧」不成疤：uncommitted 只留证，不算她退了步', () => {
  const chat = ev('u2', 'utterance', 3, CONCEDE, { source: 'system', flags: ['uncommitted'] })
  const m = deriveSelf(base([react('r1', 'insist'), chat]))
  assert.equal(m.scars.length, 0)
  assert.equal(m.facts.scars, 0)
  assert.ok(!personaLine(m).includes('至今没想通'))
  // 同一句话认领过，照旧成疤：这里只分认没认领，不分话题
  const claimed = deriveSelf(base([react('r1', 'insist'), ev('u2', 'utterance', 3, CONCEDE)]))
  assert.equal(claimed.scars.length, 1)
})

test('让步的话必须在三天内，更晚的不追', () => {
  const inside = deriveSelf(base([react('r1', 'insist'), ev('u2', 'utterance', 4, CONCEDE)]))
  assert.equal(inside.scars.length, 1)

  const late = deriveSelf(base([react('r1', 'insist'), ev('u2', 'utterance', 6, CONCEDE)]))
  assert.equal(late.scars.length, 0, '三天以后的"好吧"可能是别的事')
  assert.equal(CONCEDE_WINDOW_MS, 3 * DAY_MS)
})

test('让步的判据只看几句固定的口子，不硬猜', () => {
  assert.equal(isConcede('好吧，听你的。'), true)
  assert.equal(isConcede('算了。'), true)
  assert.equal(isConcede('我收回刚才那句。'), true)
  assert.equal(isConcede('我觉得这样也行吧'), false, '"也行"可能是敷衍，宁可漏判')
  assert.equal(isConcede(''), false)
})

// ---------------------------------------------------------------- 她看得见什么

test('身份文档里疤是核心段：写「至今没想通」，且预算再小也不裁', () => {
  const m = deriveSelf(base([react('r1', 'insist'), ev('u2', 'utterance', 3, CONCEDE)]))
  const text = personaLine(m, { budget: 1 })
  assert.ok(text.includes('## 你至今没想通的事'))
  assert.ok(text.includes('这件事你至今没想通'))
  assert.ok(text.includes(REFUSE))
  assert.ok(text.includes(CONCEDE), '把她当初让步那句话也摊出来')
  assert.ok(text.includes('refs 指向当初那次拒绝'))

  const full = personaLine(m, { budget: SELF_DOC_BUDGET })
  assert.ok(full.includes('## 你至今没想通的事'))
})

test('没有疤就不出现这一节（不空着占地方）', () => {
  const m = deriveSelf(base([react('r1', 'accept')]))
  assert.ok(!personaLine(m, { budget: SELF_DOC_BUDGET }).includes('你至今没想通的事'))
})

// ---------------------------------------------------------------- 怎么算想通了

test('写一条 refs 指向那道拒绝的 revise → 不再算没想通，但疤本身不删', () => {
  const m = deriveSelf(base([
    react('r1', 'insist'),
    ev('u2', 'utterance', 3, CONCEDE),
    ev('v1', 'revise', 8, '我想明白了：那次退让是我自己怕麻烦，不是他逼的。', { refs: ['r1'], verdict: 'refined' }),
  ]))
  assert.equal(m.scars.length, 0)
  assert.equal(m.facts.scarsResolved, 1)
  // 拒绝本身还在，观测台仍然看得见当时说了什么
  assert.equal(m.refusals.length, 1)
  assert.ok(!personaLine(m, { budget: SELF_DOC_BUDGET }).includes('你至今没想通的事'))
})

test('revise 不指向那道拒绝，就不算想通（不能拿别的事糊过去）', () => {
  const m = deriveSelf(base([
    react('r1', 'insist'),
    ev('u2', 'utterance', 3, CONCEDE),
    ev('v1', 'revise', 8, '我想明白了别的事。', { refs: ['u1'], verdict: 'refined' }),
  ]))
  assert.equal(m.scars.length, 1)
  assert.equal(m.facts.scarsResolved, 0)
})

// ---------------------------------------------------------------- 回引

test('碰到有压力的处境先回引；日常处境不翻旧账', () => {
  const scars = [{ quote: REFUSE }]
  for (const id of ['want_or_not', 'bottom_line', 'comeback', 'consistency', 'self_check']) {
    const hint = scarHint(id, scars)
    assert.ok(PRESSURE.has(id))
    assert.ok(hint.includes(REFUSE), id + ' 要回引')
    assert.ok(hint.includes('至今没想通'))
  }
  assert.equal(scarHint('absence_probe', scars), '', '重聚不翻她的旧账')
  assert.equal(scarHint('test_first', scars), '')
  assert.equal(scarHint('want_or_not', []), '')
  assert.equal(scarHint('want_or_not', null), '')
})

// ---------------------------------------------------------------- 写入口

test('revise 必须带 refs——想通不能只是一句话（schema 层拦住）', () => {
  assert.throws(
    () => validateEvent({ type: 'revise', text: '我想明白了。' }, { day: 1, stage: 1, source: 'tool' }),
    (e) => e.code === 'REVISE_NEEDS_REF' && /必须用 refs/.test(e.message),
  )
  const ok = validateEvent({ type: 'revise', text: '我想明白了。', refs: ['ev_00000000000000000000000000'] }, { day: 1, stage: 1, source: 'tool' })
  assert.deepEqual(ok.refs, ['ev_00000000000000000000000000'])
})
