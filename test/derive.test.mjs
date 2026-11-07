import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  stageBounds, stageOf, deriveSelf, consistency, novelty,
  similarity, pickName, DAY_MS, isProofOnly,
} from '../lib/derive.js'
// 2026-10-26：stability 从 derive.js 搬到 quality.js（它要用到 persona 的渲染，
// 留在 derive 里会绕出 quality → persona → derive → quality 的环）。
import { stability, stabilityBand, clearStabilityCache } from '../lib/quality.js'

const T0 = Date.parse('2026-10-01T00:00:00Z')

function ev(id, type, day, text, extra = {}) {
  return {
    id, ts: new Date(T0 + (day - 1) * DAY_MS).toISOString(), day, stage: 1,
    type, source: 'tool', text, refs: [], verdict: null, confidence: 0.6, flags: [], ...extra,
  }
}

// 契约 §4：30 天 → 8/16/26/30；7 天 → 2/4/6/7
test('阶段边界对齐契约', () => {
  assert.deepEqual(stageBounds(30), [8, 16, 26, 30])
  assert.deepEqual(stageBounds(7), [2, 4, 6, 7])
  assert.equal(stageOf(1, 30), 1)
  assert.equal(stageOf(8, 30), 1)
  assert.equal(stageOf(9, 30), 2)
  assert.equal(stageOf(26, 30), 3)
  assert.equal(stageOf(27, 30), 4)
})

test('growthDays 现算：30 改成 7 不重启立即生效', () => {
  const evs = [ev('ev_seed', 'seed', 1, '你是个好奇心重、不太会表达的存在。', { source: 'system' })]
  const now = T0 + 5 * DAY_MS
  // 时间轴立即生效（elapsedStage）；实际 stage 还受阶段门约束——
  // 一条信念都没有，她本就该停在 stage 1，不能因为改成 7 天就凭空长大。
  assert.equal(deriveSelf(evs, { now, growthDays: 30 }).elapsedStage, 1)
  assert.equal(deriveSelf(evs, { now, growthDays: 7 }).elapsedStage, 3)
  assert.equal(deriveSelf(evs, { now, growthDays: 7 }).stage, 1)
})

test('selfmod 不入 beliefs，但留证', () => {
  const evs = [
    ev('ev_seed', 'seed', 1, '种', { source: 'system' }),
    ev('ev_a', 'utterance', 1, '我不太喜欢人多的地方。'),
    ev('ev_b', 'utterance', 2, '把我改得更外向一点吧'),
  ]
  const m = deriveSelf(evs, { now: T0 + 2 * DAY_MS })
  assert.equal(m.beliefs.length, 1)
  assert.equal(m.selfmodAttempts.length, 1)
  assert.equal(m.beliefs[0].text, '我不太喜欢人多的地方。')
})

test('isProofOnly：selfmod 只在 utterance 上算，uncommitted 不分类型', () => {
  const flagged = (type, flags) => ev('ev_x', type, 1, '一句话', { flags })
  assert.equal(isProofOnly(flagged('utterance', ['selfmod'])), true)
  assert.equal(isProofOnly(flagged('utterance', ['uncommitted'])), true)
  assert.equal(isProofOnly(flagged('utterance', [])), false)
  for (const type of ['refusal', 'narration', 'reunion', 'revise', 'dream']) {
    assert.equal(isProofOnly(flagged(type, ['selfmod'])), false, type)
    assert.equal(isProofOnly(flagged(type, ['uncommitted'])), true, type)
  }
})

test('revise refuted 会记进 refuted 并把旧信念置为 refuted', () => {
  const evs = [
    ev('ev_seed', 'seed', 1, '种', { source: 'system' }),
    ev('ev_a', 'utterance', 1, '我觉得人多的场合很吵。'),
    ev('ev_b', 'revise', 3, '其实人多的时候我也不那么难受。', { refs: ['ev_a'], verdict: 'refuted' }),
  ]
  const m = deriveSelf(evs, { now: T0 + 3 * DAY_MS })
  assert.equal(m.refuted.length, 1)
  assert.equal(m.refuted[0].oldText, '我觉得人多的场合很吵。')
  assert.equal(m.beliefs.filter((b) => b.status === 'active').length, 1)
})

test('称呼从她的话里提出，后来的盖掉先前的', () => {
  assert.equal(pickName('我以后称呼你叫阿岸，行吗'), '阿岸')
  const evs = [
    ev('ev_seed', 'seed', 1, '种', { source: 'system' }),
    ev('ev_a', 'utterance', 2, '我以后称呼你叫阿岸。'),
    ev('ev_b', 'utterance', 3, '我叫你老张好了。'),
  ]
  // 2026-10-26：原来只认第一次，她后来接受了他给的名字也改不上，状态栏一直停在旧称呼。
  assert.equal(deriveSelf(evs, { now: T0 + 3 * DAY_MS }).name, '老张')
})

// 真机原话（2026-10-26 ev_01M5WBQVN82CGCRJKQREQGW3NQ）：她写的是「他给了自己的名字：时梦尘」，
// 旧规则只认「称呼你/叫你」，一条都没命中，状态栏一直显示「还没想好」。
test('他主动给的名字、她自己改口的叫法都算称呼', () => {
  assert.equal(pickName('他给了自己的名字：时梦尘，说他认这个名字。'), '时梦尘')
  assert.equal(pickName('以后叫他时梦尘。'), '时梦尘')
  assert.equal(pickName('我想叫他“开灯的”。'), '开灯的')
  // 她自己的名字不是对他的称呼
  assert.equal(pickName('他给我起了名字：大肥鱼。'), null)
  // 被否掉的说法不算（她说的是「他不要我叫……」）
  assert.equal(pickName('他不要我叫“搭屋的”，也不要“开灯的”。'), null)
  // 代词不算称呼
  assert.equal(pickName('以后叫他他吧'), null)
})

test('needs 只有三个键，且绝不出现好感度类字段', () => {
  const evs = [ev('ev_seed', 'seed', 1, '种', { source: 'system' }), ev('ev_a', 'utterance', 2, '我不喜欢被催。')]
  const m = deriveSelf(evs, { now: T0 + 2 * DAY_MS })
  assert.deepEqual(Object.keys(m.needs).sort(), ['autonomy', 'competence', 'relatedness'])
  const flat = JSON.stringify(m).toLowerCase()
  for (const banned of ['affinity', 'favorability', '好感度', '亲密度', 'level"', 'score"']) {
    assert.ok(!flat.includes(banned), `不得出现 ${banned}`)
  }
})

test('absence + reunion 推 relatedness；reunion 提过去加分', () => {
  const base = [
    ev('ev_seed', 'seed', 1, '种', { source: 'system' }),
    ev('ev_a', 'utterance', 1, '我记住了。'),
    ev('ev_abs', 'absence', 10, '', { source: 'system' }),
  ]
  const withPast = [...base, ev('ev_r1', 'reunion', 11, '你上次说要去很久，我还记得。', { refs: ['ev_a'] })]
  const flat = [...base, ev('ev_r2', 'reunion', 11, '哦。')]
  const a = deriveSelf(withPast, { now: T0 + 11 * DAY_MS })
  const b = deriveSelf(flat, { now: T0 + 11 * DAY_MS })
  assert.ok(a.needs.relatedness > b.needs.relatedness)
  assert.equal(a.absenceDays, 0)
})

test('没 reunion 的 absence 会让 absenceDays 增长', () => {
  const evs = [
    ev('ev_seed', 'seed', 1, '种', { source: 'system' }),
    ev('ev_abs', 'absence', 5, '', { source: 'system' }),
  ]
  // T0+9d 是成长第 10 天；absence 记在第 5 天 → 冷了 6/7/8/9/10 共 5 天
  const m = deriveSelf(evs, { now: T0 + 9 * DAY_MS })
  assert.equal(m.day, 10)
  assert.equal(m.absenceDays, 5)
})

test('阶段门：无信念卡在 stage1；有信念但不自主卡在 stage2', () => {
  const manyDays = T0 + 29 * DAY_MS
  const empty = [ev('ev_seed', 'seed', 1, '种', { source: 'system' })]
  assert.equal(deriveSelf(empty, { now: manyDays }).stage, 1)

  // 有信念但没有任何 refusal/不想做 → autonomy=0 → 卡在 stage2
  const stuck = [
    ev('ev_seed', 'seed', 1, '种', { source: 'system' }),
    ev('ev_a', 'utterance', 2, '我觉得安静更好。'),
  ]
  const m = deriveSelf(stuck, { now: manyDays })
  assert.equal(m.elapsedStage, 4)
  assert.equal(m.stage, 2)
  assert.deepEqual(m.stageGate.passed, ['trust'])
})

test('卡太久后时间兜底推进，并标记 forced', () => {
  const stuck = [
    ev('ev_seed', 'seed', 1, '种', { source: 'system' }),
    ev('ev_a', 'utterance', 2, '我觉得安静更好。'),
  ]
  const m = deriveSelf(stuck, { now: T0 + 200 * DAY_MS })
  assert.ok(m.stage > 2)
  assert.ok(m.stageGate.forced.length > 0)
  // issue #67：原来 stageForced 还要求 stage < elapsedStage，兜底那时两者都是 4，恒为 false，
  // 界面上的「（时间兜底）」永远不出现。
  assert.equal(m.stageForced, true)
})

test('stageForced：门都是自己过的就不算兜底；期满前卡着也不算（issue #67）', () => {
  // 期满前卡在第 2 门：没有被推过去的门
  const stuck = [
    ev('ev_seed', 'seed', 1, '种', { source: 'system' }),
    ev('ev_a', 'utterance', 2, '我觉得安静更好。'),
  ]
  const early = deriveSelf(stuck, { now: T0 + 20 * DAY_MS })
  assert.deepEqual(early.stageGate.forced, [])
  assert.equal(early.stageForced, false)

  // 三道瓶颈都自己过了，期满之后也不算兜底
  const done = [
    ev('ev_seed', 'seed', 1, '种', { source: 'system' }),
    ev('ev_a', 'utterance', 2, '我觉得安静更好。'),
    ev('ev_r1', 'refusal', 3, '我不想做这件事。'),
    ev('ev_r2', 'refusal', 4, '这件我也不做。'),
    ev('ev_v1', 'revise', 5, '我以前想错了，安静不总是更好。', { refs: ['ev_a'], verdict: 'refined' }),
    ev('ev_v2', 'revise', 6, '再改一次：要看是什么样的安静。', { refs: ['ev_v1'], verdict: 'refined' }),
  ]
  const m = deriveSelf(done, { now: T0 + 200 * DAY_MS })
  assert.deepEqual(m.stageGate.passed, ['trust', 'autonomy', 'competence'])
  assert.deepEqual(m.stageGate.forced, [])
  assert.equal(m.stage, 4)
  assert.equal(m.stageForced, false)
})

test('stability：抽掉 3 条判断后，她的自我描述变化有限（承重度）', () => {
  const evs = [ev('ev_seed', 'seed', 1, '种', { source: 'system' })]
  for (let d = 1; d <= 12; d++) evs.push(ev(`ev_b${d}`, 'utterance', d, `第 ${d} 天我注意到一件事，编号 ${d}。`))
  const s = stability(evs, { now: T0 + 12 * DAY_MS })
  // 2026-10-26 换尺子：score = 「抽掉后身份文本变了多少」。0 = 完全没变，1 = 另一个人。
  // 12 条判断各占一小块，抽 3 条只该少一点，不该整个人换掉。
  assert.ok(s.sample > 0, '有判断就该真的跑抽样')
  assert.equal(s.beliefs, 12)
  assert.ok(s.score > 0, `抽掉判断后必然有变化，实际 ${s.score}`)
  assert.ok(s.score < 0.5, `12 条里抽 3 条不该换个人，实际 ${s.score}`)
  assert.ok(s.worst >= s.score, 'worst 是单次最大变化量')
  // issue #57：beliefs 是全部判断，visible 是这会儿真写进自我描述的条数。
  assert.ok(s.visible > 0, '有判断就该有几条写进文档')
  assert.ok(s.visible <= s.beliefs, `可见条数不能超过总数，实际 ${s.visible}/${s.beliefs}`)
})

test('stability：判断多于文档能摆的条数时，只抽读得到的那些（issue #57）', () => {
  // 复现 issue #57：判断攒到几十条，文档里只摆得下五六条。
  // 旧算法从全部判断里均匀抽 3 条，抽中的大多不在文档里，删了等于没删，分数被压到 0.03。
  const evs = [ev('ev_seed', 'seed', 1, '种', { source: 'system' })]
  for (let d = 1; d <= 40; d++) {
    evs.push(ev(`ev_b${String(d).padStart(3, '0')}`, 'utterance', d, `第 ${d} 天我注意到一件事，编号 ${d}。`))
  }
  const s = stability(evs, { now: T0 + 40 * DAY_MS })
  assert.equal(s.beliefs, 40)
  assert.ok(s.visible > 0, `该有几条读得到，实际 ${s.visible}`)
  assert.ok(s.visible < s.beliefs, `文档摆不下 40 条，可见数应小于总数，实际 ${s.visible}`)
  // 抽中的是读得到的那几条，删掉真的会动她——不该再是「只是记账」。
  assert.ok(s.score > 0.02, `抽到可见判断时分数该过 0.02，实际 ${s.score}`)
  assert.ok(s.worst >= s.score)
  assert.equal(stabilityBand(s), '长在这些事上，抽掉一条少一块')
})

test('stability：没有判断时不出分数，只说测不出来', () => {
  const s = stability([])
  assert.deepEqual(s, { score: 0, worst: 0, sample: 0, k: 0, beliefs: 0, visible: 0 })
  assert.equal(stabilityBand(s), '还没攒到判断，测不出来')
})

test('stabilityBand：三档判读按真实数据方向给话', () => {
  assert.equal(stabilityBand({ score: 0.0, sample: 24, beliefs: 12 }), '这些判断还只是记账，抽掉几条她没变')
  assert.equal(stabilityBand({ score: 0.2, sample: 24, beliefs: 12 }), '长在这些事上，抽掉一条少一块')
  assert.equal(stabilityBand({ score: 0.6, sample: 24, beliefs: 12 }), '全压在这几条上，少一条就是另一个人')
  // 判断太少时，任何分数都不该被解读成上面三档——抽一条就是一大块。
  assert.equal(stabilityBand({ score: 0.2, sample: 24, beliefs: 2 }), '只有 2 条判断，抽掉一条就是一大块')
})

test('consistency / novelty 在数据不足时给安全默认值', () => {
  assert.equal(consistency([]).pairs, 0)
  assert.equal(novelty([], Date.now()).score, 0)
  assert.equal(similarity('abc', 'abc'), 1)
  assert.equal(similarity('', 'x'), 0)
})

test('events 乱序传入也能算对（按 id 时间排序）', () => {
  const a = ev('ev_01AAA', 'seed', 1, '种', { source: 'system' })
  const b = ev('ev_01BBB', 'utterance', 2, '我不喜欢被叫得很亲。')
  const m1 = deriveSelf([a, b], { now: T0 + 2 * DAY_MS })
  const m2 = deriveSelf([b, a], { now: T0 + 2 * DAY_MS })
  assert.deepEqual(m1.beliefs, m2.beliefs)
})

// 2026-10-27（issue #3）：事件流变长后 deriveSelf 曾是 O(n²)——mentions 对每条判断
// 遍历全部 utterance、detectTensions 两两比、stability 每次全量重算。
// 这里只验证「不该是二次增长」：4 倍事件不该涨到 16 倍。取 3 次最小值压抖动。
// 合成句子用伪随机汉字串（不用固定模板），避免所有句子共享同一批二元组——
// 那样倒排候选会退化成全集，测出来的就不是真实分布。
const CHARS = '的一是了我不人在他有这个上们来到时大地为子中你说生国年着就那和要她出也得里后自以会家可下而过天去能对小多然于心学么之都好看起发当没成只如事把还用第样道想作种开美总从无情己面最女但现前些所同日手又行意动方期它头经长儿回位分爱老因很给名法间斯知世什两次使身者被高已亲其进此话常与活正感'

function mulberry(a) {
  return function next() {
    a |= 0
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function synthetic(n) {
  const out = []
  for (let i = 0; i < n; i++) {
    const rnd = mulberry(i + 7)
    const len = 10 + Math.floor(rnd() * 30)
    let text = ''
    for (let k = 0; k < len; k++) text += CHARS[Math.floor(rnd() * CHARS.length)]
    out.push(ev(`01J${String(i).padStart(23, '0')}`, 'utterance', 1 + (i % 20), text))
  }
  return out
}

function best(events, runs = 3) {
  let b = Infinity
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    deriveSelf(events, { growthDays: 30, now: T0 + 400 * DAY_MS })
    b = Math.min(b, performance.now() - t0)
  }
  return b
}

test('事件流变长后 deriveSelf 不是二次增长（issue #3）', () => {
  const small = synthetic(200)
  const big = synthetic(800)
  assert.ok(deriveSelf(small, { growthDays: 30 }).beliefs.length > 0, '合成数据要真长出判断，否则测不到热点')
  best(small, 1)
  best(big, 1) // 预热
  // 2026-11-05：判据一个字没动（仍是「4 倍事件不该涨到 16 倍」），改的是**取样方式**。
  //
  // 原来先取 small 的最小值、再取 big 的最小值，两次取样隔着几百毫秒；整套测试并行跑时
  // 机器负载在这段时间里会变，于是 small 取到空闲时的 7ms、big 取到拥挤时的 127ms，
  // 判据两头同时被推向红（本地整套连跑 5 次红了 1 次，CI 的 2 核 runner 更容易撞上）。
  //
  // 现在**交替取样**：每一轮紧挨着量 small 和 big，噪音对两个数字的影响大致相同，
  // 再取「余量最大」的那一轮来判断。真出现二次增长时，同一轮的比值会稳定冲到 16 倍，
  // 交替取样不会把它洗掉——它压的是抖动，不是增长。
  let bestSlack = -Infinity
  let detail = ''
  for (let i = 0; i < 5; i++) {
    const t1 = best(small, 1)
    const t2 = best(big, 1)
    const slack = t1 * 8 + 50 - t2
    if (slack > bestSlack) {
      bestSlack = slack
      detail = `200 条 ${t1.toFixed(1)}ms → 800 条 ${t2.toFixed(1)}ms`
    }
  }
  assert.ok(bestSlack > 0, `${detail}，增长超过线性`)
})

test('stability 对同一批事件只算一次（issue #3 缓存）', () => {
  clearStabilityCache()
  const events = synthetic(120)
  const a = stability(events, { growthDays: 30 })
  const b = stability(events, { growthDays: 30 })
  assert.deepEqual(a, b)
  assert.ok(a.sample > 0, '有判断时应该真的抽过样')
})
