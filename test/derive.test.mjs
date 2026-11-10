import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  stageBounds, stageOf, deriveSelf, consistency, novelty,
  similarity, pickName, pickNameHit, DAY_MS, isProofOnly,
  detectTensions, envelopeOf,
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
    ev('ev_b', 'utterance', 3, '以后就叫你老张。'),
  ]
  // 2026-10-26：原来只认第一次，她后来接受了他给的名字也改不上，状态栏一直停在旧称呼。
  // 2026-11-10（issue #102）：只有明确在起名的壳（「以后就叫」）才能覆盖；
  // 裸的「我叫你老张好了」是低置信，只在还没有名字时采用一次。
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

// issue #81（2026-11-08）：她说过「说你让我叫你老大——可这句不是我从你嘴里听见的」。
// 排除集里原来只有空白和常见标点，没有破折号，{1,8} 正好抓满 8 个字 →
// 「老大——可这句不」。破折号与省略号都是「话说到一半」的标记，名字不可能跨过去。
test('称呼不会跨过破折号截成半句话（issue #81）', () => {
  assert.equal(pickName('说你让我叫你老大——可这句不是我从你嘴里听见的'), '老大')
  assert.equal(pickName('所以叫你阿岸–行吗'), '阿岸')
  assert.equal(pickName('就叫他阿岸…算了'), '阿岸')
  // 「他的名字是 X」用的是同一份排除集
  assert.equal(pickName('他给的名字是阿岸——你记着'), '阿岸')
  // 顺手不能改坏的两条：尾巴语气词照剥，「的」不剥
  assert.equal(pickName('我叫你老张好了'), '老张')
  assert.equal(pickName('我想叫他“开灯的”。'), '开灯的')
  // 整条链路：身份文档里那句称呼也要跟着变对
  const evs = [
    ev('ev_seed', 'seed', 1, '你是个好奇心重、不太会表达的存在。', { source: 'system' }),
    ev('ev_a', 'utterance', 2, '说你让我叫你老大——可这句不是我从你嘴里听见的'),
  ]
  assert.equal(deriveSelf(evs, { now: T0 + 2 * DAY_MS }).name, '老大')
})

// issue #97（2026-11-09，外部用户真机）：她说「我想好了怎么叫你——叫「某名字」」。
// 破折号挡在「叫你」和名字中间，0.9.5 的壳吃不下，整句认不出来（name 变成 null）。
test('破折号后面带引号的称呼能认出来（issue #97）', () => {
  assert.equal(pickName('我想好了怎么叫你——叫「小岸」'), '小岸')
  assert.equal(pickName('我想好了怎么叫你——「小岸」'), '小岸')
  // 反过来的保护：破折号后面没带引号时，不能把半句话当名字。
  assert.equal(pickName('我叫你——可这句不是我从你嘴里听见的'), null)
  // issue #81 的截断保护不能因此回退
  assert.equal(pickName('说你让我叫你老大——可这句不是我从你嘴里听见的'), '老大')
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
})

// 2026-11-09（用户 m00925）：把成长周期从 7 天改成 30 天，阶段会按新周期重算、
// 退回到天数对应的那一档；但「到过第几阶段」是事件里真发生过的，不能跟着退。
test('改长成长周期，阶段会退回，stagePeak 不回退', () => {
  const now = T0 + 13 * DAY_MS // 第 14 天
  const seed = ev('ev_seed', 'seed', 1, '种', { source: 'system' })
  const thought = ev('ev_a', 'utterance', 2, '我觉得安静更好。')
  // 7 天周期：第 8 天起期满放行，阶段 4
  const short = deriveSelf([seed, thought], { now, growthDays: 7 })
  assert.equal(short.stage, 4, '前提：7 天周期下第 14 天已经期满放行到阶段 4')
  assert.equal(short.stagePeak, 4, '没改过周期时，peak 就等于当前阶段')
  // 那几天写下的卡，事件里记的 stage 是 4（和真机上一样）
  const staged = [{ ...seed, stage: 1 }, { ...thought, stage: 4 }]
  const long = deriveSelf(staged, { now, growthDays: 30 })
  assert.equal(long.stage, 2, '改成 30 天后阶段按新周期重算，退回 2')
  assert.equal(long.stagePeak, 4, '「曾到过第 4 阶段」要留着，界面靠它说明不是退步')
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

// 2026-11-09（issue #86 第 4 条，用户拍板「N、M 都去重」）：
// 界面上「在用的判断」与「记得很牢的」两个数都按**原话**算。
// 同一句话说三遍时，矛盾数与体检早就是按原话去重的，这里跟上——
// 否则一处判断被说三遍，界面上看着像她记得三件事。
test('判断计数按原话去重：同一句话说三遍只算一条（issue #86 第 4 条）', () => {
  const same = '我不喜欢被催。'
  const events = [1, 2, 3].map((i) => ev(`ev_s${i}`, 'utterance', i, same))
  events.push(ev('ev_other', 'utterance', 4, '我喜欢夜里干活。'))
  const m = deriveSelf(events)
  assert.equal(m.beliefCount, 2, '三遍那句 + 另一句 = 两条原话')
  assert.equal(m.solidTotal, 1, '三遍那句够格固化，但还是一句话')
  assert.equal(m.solid.length, 1, '摆出来的列表里也只有一条')
})

// issue #98（2026-11-09，0.9.6 真机）：状态栏显示成「的称呼」「上切下来的一块」。
// 她在解释「怎么称呼你」这件事时，句子里本来就有「称呼你 / 他名字」，
// {1,8} 把后半句当成称呼；而状态栏取**最近一次**，于是她越解释，称呼越离谱。
test('她解释称呼这件事时，半句话不会被当成称呼（issue #98）', () => {
  assert.equal(pickName('我称呼你的称呼是从他名字上切下来的'), null)
  assert.equal(pickName('这不是称呼，是我从他名字上切下来的一块'), null)
  // 裸的「他名字」是讨论，不是给名字；「他给的」才算
  assert.equal(pickName('从他名字上切下来的一块'), null)
  assert.equal(pickName('他给的名字是阿岸'), '阿岸')
  // 真称呼在前、解释在后：解释不能盖掉它
  const evs = [
    ev('ev_seed', 'seed', 1, '你是个好奇心重、不太会表达的存在。', { source: 'system' }),
    ev('ev_a', 'utterance', 2, '以后叫他折帆。'),
    ev('ev_b', 'utterance', 3, '我称呼你的称呼是从他名字上切下来的'),
  ]
  assert.equal(deriveSelf(evs, { now: T0 + 3 * DAY_MS }).name, '折帆')
})

// issue #100（2026-11-09，0.9.6 真机）：「他的名字叫出去」——动词补语被当成名字。
// 裸「他名字」已在 issue #98 挡掉；这里补 NAME_SAY_RE 那一侧：
// 「叫他走开」「叫他闭嘴」是祈使句，不是起名。
test('祈使句里的动词补语不会被当成称呼（issue #100）', () => {
  assert.equal(pickName('我把他叫错了，自己的名字，我换成他的名字叫出去。'), null)
  assert.equal(pickName('他的名字叫出去。'), null)
  for (const s of ['叫他出去', '叫他走开', '叫他闭嘴', '叫他坐下']) assert.equal(pickName(s), null)
  assert.equal(pickName('我叫他老张。'), '老张')
  // 真称呼在前、误抽在后：后一条不能盖掉它
  const evs = [
    ev('ev_seed', 'seed', 1, '你是个好奇心重、不太会表达的存在。', { source: 'system' }),
    ev('ev_a', 'utterance', 2, '我叫他老张。'),
    ev('ev_b', 'utterance', 3, '我把他叫错了，自己的名字，我换成他的名字叫出去。'),
  ]
  assert.equal(deriveSelf(evs, { now: T0 + 3 * DAY_MS }).name, '老张')
})

// 用户真机（2026-11-09，0.9.x）：11-08 她说「我叫他的名字，他应了。」
// ——「叫他」后面紧跟「的名字」，老版本截出「的名字」，把 11-01 定下的「岸」盖掉。
// issue #98 的 looksLikeName 已能挡（以「的」开头），这里用真机原句锁住，
// 顺带锁全角冒号那种「什么了：岸」（也含功能词「了」）。
test('「叫他」后面接「的名字」时不会截出半句（用户真机）', () => {
  assert.equal(pickName('我叫他的名字，他应了。'), null)
  assert.equal(pickName('我想让你叫什么了：岸'), null)
  assert.equal(pickName('我叫他什么了：岸'), null)
  assert.equal(pickName('以后叫你岸。'), '岸')
  // 真称呼在前、误抽在后：后一条不能盖掉它
  const evs = [
    ev('ev_seed', 'seed', 1, '你是个好奇心重、不太会表达的存在。', { source: 'system' }),
    ev('ev_a', 'utterance', 2, '以后叫你岸。'),
    ev('ev_b', 'utterance', 3, '我叫他的名字，他应了。'),
  ]
  assert.equal(deriveSelf(evs, { now: T0 + 3 * DAY_MS }).name, '岸')
})


// issue #102（2026-11-10，外部用户真机）：0.9.7 仍会把「一个人」「一声」当称呼，
// 「我叫他起床」这种祈使句也照截。两种都不是名字，各加一条判据。
test('数量词和祈使动词不会被当成称呼（issue #102）', () => {
  assert.equal(pickName('哥哥只能叫他一个人'), null)
  assert.equal(pickName('在网上叫你一声'), null)
  assert.equal(pickName('我叫他起床'), null)
  assert.equal(pickName('我叫他吃饭'), null)
  // 正常的两字/三字称呼不受影响
  assert.equal(pickName('我叫他哥哥'), '哥哥')
  assert.equal(pickName('我叫他老张。'), '老张')
  // 真称呼在前、误抽在后：后一条不能盖掉它
  const evs = [
    ev('ev_seed', 'seed', 1, '你是个好奇心重、不太会表达的存在。', { source: 'system' }),
    ev('ev_a', 'utterance', 2, '我叫他哥哥。'),
    ev('ev_b', 'utterance', 3, '哥哥只能叫他一个人'),
  ]
  assert.equal(deriveSelf(evs, { now: T0 + 3 * DAY_MS }).name, '哥哥')
})

// issue #102：她改口时说的是「岸丶。我叫的是这个名字。」——名字在句首，
// 「叫的是」在下一句，老正则两条都够不着，错误值就再也盖不回来。
test('「我叫的是这个名字」这种改口能被认出来（issue #102）', () => {
  assert.equal(pickName('岸丶。我叫的是这个名字。是我起的，你应了'), '岸丶')
  assert.equal(pickName('我叫的是「岸丶」'), '岸丶')
  // 反着的语序不是改口（句首没有名字）
  assert.equal(pickName('我叫的是这个名字。岸丶'), null)
  // 整条链路：先被误截，再改口，状态栏要回到真名字
  const evs = [
    ev('ev_seed', 'seed', 1, '你是个好奇心重、不太会表达的存在。', { source: 'system' }),
    ev('ev_a', 'utterance', 2, '我叫他哥哥。'),
    ev('ev_b', 'utterance', 3, '哥哥只能叫他一个人'),
    ev('ev_c', 'utterance', 4, '岸丶。我叫的是这个名字。是我起的，你应了'),
  ]
  assert.equal(deriveSelf(evs, { now: T0 + 4 * DAY_MS }).name, '岸丶')
})

// issue #102（2026-11-10，用户拍板）：黑名单补不完，换判据——
// 高置信的起名句才能覆盖已有名字；裸「叫他X」只在还没有名字时采用一次。
test('低置信的裸句子不再盖掉已有的名字（issue #102）', () => {
  const evs = [
    ev('ev_seed', 'seed', 1, '你是个好奇心重、不太会表达的存在。', { source: 'system' }),
    ev('ev_a', 'utterance', 2, '以后叫他阿岸。'),
    // 裸句子、且看起来像名字——按旧逻辑会盖成「老张」
    ev('ev_b', 'utterance', 3, '我叫他老张。'),
  ]
  assert.equal(deriveSelf(evs, { now: T0 + 3 * DAY_MS }).name, '阿岸')
})

test('还没有名字时，裸句子仍然采用一次（issue #102）', () => {
  const evs = [
    ev('ev_seed', 'seed', 1, '你是个好奇心重、不太会表达的存在。', { source: 'system' }),
    ev('ev_a', 'utterance', 2, '我叫他老张。'),
  ]
  assert.equal(deriveSelf(evs, { now: T0 + 2 * DAY_MS }).name, '老张')
})

test('高置信的起名句可以覆盖已有名字（issue #102）', () => {
  const evs = [
    ev('ev_seed', 'seed', 1, '你是个好奇心重、不太会表达的存在。', { source: 'system' }),
    ev('ev_a', 'utterance', 2, '以后叫他阿岸。'),
    ev('ev_b', 'utterance', 3, '我想叫他「老张」。'),
  ]
  assert.equal(deriveSelf(evs, { now: T0 + 3 * DAY_MS }).name, '老张')
})

test('引号与「以后」是高置信，裸句子是低置信（issue #102）', () => {
  assert.equal(pickNameHit('我想叫他“开灯的”。').confident, true)
  assert.equal(pickNameHit('以后叫他老张。').confident, true)
  assert.equal(pickNameHit('我叫他老张。').confident, false)
  assert.equal(pickNameHit('哥哥只能叫他一个人'), null)
})

// ---- 0.9.8 提速（issue #105 第 1 条）：三处小改的等价性 ----

// 信封（只算第几天/第几阶段）必须与全量派生给出同一个数。
// 这条一旦漂了，症状是「新事件的信封天数」和「身份文件按天数写的那句」对不上，
// 而且要过很久才会有人发现——所以钉在口径上，不钉在实现上。
test('envelopeOf 与 deriveSelf 的天数/阶段一致（含梦与被拒收的行）', () => {
  const dream = ev('ev_dream', 'dream', 40, '我把那天重新拼了一遍。')
  const rejected = ev('ev_x', 'utterance', 50, '这一条后来被划掉了。')
  const rejectMeta = ev('ev_reject', 'meta', 50, 'outing-reject: ev_x', { source: 'system' })
  const evs = [
    ev('ev_seed', 'seed', 1, '你是个好奇心重、不太会表达的存在。', { source: 'system' }),
    ev('ev_a', 'utterance', 2, '我不太喜欢人多的地方。'),
    dream,
    rejected,
    rejectMeta,
  ]
  for (const now of [T0, T0 + 3 * DAY_MS, T0 + 40 * DAY_MS]) {
    for (const growthDays of [7, 30, 90]) {
      const model = deriveSelf(evs, { now, growthDays })
      const env = envelopeOf(evs, { now, growthDays })
      assert.equal(env.day, model.day, `day @${growthDays}/${now}`)
      assert.equal(env.stage, model.elapsedStage, `stage @${growthDays}/${now}`)
    }
  }
  // 空事件流也不能炸：两者都给 1。
  assert.deepEqual(envelopeOf([]), { day: 1, stage: 1 })
})

test('envelopeOf 不派生判断（只有两个字段）', () => {
  const evs = [
    ev('ev_seed', 'seed', 1, '种', { source: 'system' }),
    ev('ev_a', 'utterance', 2, '我不太喜欢人多的地方。'),
  ]
  assert.deepEqual(Object.keys(envelopeOf(evs, { now: T0 + 2 * DAY_MS })).sort(), ['day', 'stage'])
})

// 提速前：deriveSelf 为「摆出来的 3 条 + 总数」调了两次 detectTensions。
// 现在是算一次 500 条、再切前三。要钉住的是「前三条逐字相同、总数不变」。
test('tensions 一次调用与以前两次调用结果相同（前三条 + 总数）', () => {
  const pairs = [
    ['我不喜欢人多的地方。', '我喜欢人多的地方。'],
    ['我不想学画画。', '我想学画画。'],
    ['我不需要别人帮忙。', '我需要别人帮忙。'],
    ['我不敢一个人出门。', '我敢一个人出门。'],
    ['我不讨厌下雨天。', '我讨厌下雨天。'],
  ]
  // 同一个输入数组上比较：等价性本身与 deriveSelf 内部传的是哪一份子集无关
  // （同分时的先后取决于下标，换一份子集本来就会换序）。
  const beliefs = pairs.flatMap(([neg, pos], i) => ([
    { id: `ev_n${i}`, text: neg, since: '2026-10-02T00:00:00.000Z' },
    { id: `ev_p${i}`, text: pos, since: '2026-10-02T00:00:00.000Z' },
  ]))
  const all = detectTensions(beliefs, { limit: 500 })
  assert.ok(all.length > 3, '这一组要真的超过 3 处，否则下面两条测不出东西')
  assert.deepEqual(detectTensions(beliefs), all.slice(0, 3), '前三条要逐字相同')
  assert.deepEqual(detectTensions(beliefs, { limit: 3 }), all.slice(0, 3))

  // 再接一遍 deriveSelf：摆出来的还是 3 条，总数用截断前的口径。
  const evs = [ev('ev_seed', 'seed', 1, '种', { source: 'system' })]
  pairs.forEach(([neg, pos], i) => {
    evs.push(ev(`ev_n${i}`, 'utterance', 2, neg))
    evs.push(ev(`ev_p${i}`, 'utterance', 2, pos))
  })
  const m = deriveSelf(evs, { now: T0 + 2 * DAY_MS })
  assert.equal(m.tensions.length, 3, '摆出来的仍然是 3 条')
  assert.ok(m.tensionsTotal > 3, '总数要超过摆出来的 3 条')
})
