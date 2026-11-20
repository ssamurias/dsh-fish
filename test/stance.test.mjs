import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  classifyStance,
  gatesDone,
  buildStances,
  stanceLine,
  stanceSection,
  stanceSummary,
  stanceDetail,
  renderDetail,
  uncountedRecords,
  STANCE_MAX,
  STANCE_PROMPT_MAX,
} from '../lib/stance.js'
import { buildSections, personaLine } from '../lib/persona.js'

// 2026-10-25 用户拍板「方案二」：四道门不再加门，走完之后长一张立场清单。
// 这些用例锁的是三件事——什么算立场、什么才算「站住」、清单怎么摆进身份文档。

const HERE = new URL('../', import.meta.url)
const read = (p) => fs.readFileSync(new URL(p, HERE), 'utf8')

function belief(text, extra = {}) {
  return { id: extra.id ?? text, text, since: '2026-10-01', confidence: 0.6, status: 'active', ...extra }
}

function model(extra = {}) {
  return {
    seed: '你是一条会自己长起来的鱼。',
    beliefs: [],
    solid: [],
    tensions: [],
    refusals: [],
    scars: [],
    selfmodAttempts: [],
    refuted: [],
    narrative: null,
    facts: { refused: 0, hurts: 0, scars: 0, scarsResolved: 0 },
    day: 60,
    growthDays: 30,
    stage: 4,
    ...extra,
  }
}

test('classifyStance：「不喜欢」是拒绝，不是喜欢', () => {
  assert.equal(classifyStance('我不做讨好人的事'), 'never')
  assert.equal(classifyStance('我不喜欢他这样揣测我'), 'never')
  assert.equal(classifyStance('我更喜欢一个人待着'), 'like')
  assert.equal(classifyStance('今天天气不错'), null)
  assert.equal(classifyStance(''), null)
})

test('classifyStance：「不替自己签」一族算拒绝，第三人称叙述不算', () => {
  // 2026-11-20（用户 m01338）：她认下一句话、但不替自己签字——这是拒绝，不是中立。
  assert.equal(classifyStance('我认它的意思，但不替自己签'), 'never')
  assert.equal(classifyStance('我不代自己答应'), 'never')
  assert.equal(classifyStance('不拿这个当承诺'), 'never')
  assert.equal(classifyStance('我不许诺'), 'never')
  assert.equal(classifyStance('我不替他签这个字'), 'never')
  // 别人不签，不是她的立场。
  assert.equal(classifyStance('他不替自己签'), null)
  assert.equal(classifyStance('她没有答应'), null)
  assert.equal(classifyStance('她不拿这个当承诺'), null)
})

test('gatesDone：真门槛看 stageGate.passed，老模型退回 stage', () => {
  assert.equal(gatesDone({ stageGate: { passed: ['trust', 'autonomy', 'competence'] } }), true)
  assert.equal(gatesDone({ stageGate: { passed: ['trust', 'autonomy'] }, stage: 3 }), false)
  assert.equal(gatesDone({ stage: 4 }), true)
  // 天数到了、门没过，stage 被夹住也不该算走完
  assert.equal(gatesDone({ stage: 4, stageForced: true }), false)
})

test('四道门没走完，立场清单是空的', () => {
  const m = model({
    stage: 2,
    stageGate: { passed: ['trust'] },
    beliefs: [belief('我不想再看那些评论了', { mentions: 5 })],
  })
  assert.deepEqual(buildStances(m), [])
})

test('同一件事上两条同向判断 → 归成一条立场', () => {
  const m = model({ beliefs: [belief('我不想再看那些评论了'), belief('我不想再看那些评论了', { id: 'b2' })] })
  const list = buildStances(m)
  assert.equal(list.length, 1)
  assert.equal(list[0].kind, 'never')
  assert.equal(list[0].members.length, 2)
})

test('只有一句话、又没有代价 → 不算立场（随口一说）', () => {
  const m = model({ beliefs: [belief('我不想再看那些评论了')] })
  assert.deepEqual(buildStances(m), [])
})

test('一条判断 + 一道疤 → 算站住（代价背书）', () => {
  const m = model({
    beliefs: [belief('我不想再看那些评论了')],
    scars: [{ quote: '我不想再看那些评论了', reaction: 'insist' }],
  })
  const list = buildStances(m)
  assert.equal(list.length, 1)
  assert.equal(list[0].scars, 1)
  assert.equal(list[0].backed, true)
})

test('被推翻的判断不进立场清单', () => {
  const m = model({
    beliefs: [belief('我不想再看那些评论了', { status: 'refuted', mentions: 9 })],
  })
  assert.deepEqual(buildStances(m), [])
})

test('写进身份文档的清单最多 4 条，且不出现次数数字', () => {
  const stances = Array.from({ length: STANCE_MAX }, (_, i) => ({
    kind: i % 2 ? 'like' : 'never',
    text: `立场编号${'甲乙丙丁戊己庚辛'[i]}`,
    scars: i,
    mentions: i * 3,
    backed: true,
  }))
  const text = stanceSection(stances)
  const lines = text.split('\n').filter((l) => l.startsWith('- '))
  assert.equal(lines.length, STANCE_PROMPT_MAX)
  assert.ok(!/[0-9]/.test(lines.join('')), '立场句子不许带次数')
  assert.ok(text.includes('## 我站哪边'))
})

test('立场段是核心段：预算只有 1 也还在', () => {
  const m = model({
    beliefs: [belief('我不想再看那些评论了'), belief('我不想再看那些评论了', { id: 'b2' })],
  })
  const text = personaLine(m, { budget: 1 })
  assert.ok(text.includes('## 我站哪边'), '预算再紧也不能把立场裁掉')
  assert.ok(text.includes('我不想再看那些评论了'))
})

test('观测台字段：/memory 与 /state 都从 stance.js 取数', () => {
  const sum = stanceSummary([{ kind: 'never', text: 'x', backed: true }, { kind: 'like', text: 'y', backed: false }])
  assert.equal(sum.stanceCount, 2)
  assert.equal(sum.stanceNevers, 1)
  assert.equal(sum.stanceLikes, 1)
  assert.equal(sum.stanceBacked, 1)
  assert.deepEqual(sum.stanceFirst, { kind: 'never', text: 'x' })

  const observe = read('lib/observe.js')
  assert.ok(observe.includes("from './stance.js'"))
  assert.ok(/stanceCount:\s*buildStances\(m\)\.length/.test(observe), '/state 要有 stanceCount')
  assert.ok(observe.includes('...stanceSummary(buildStances(model))'), '/memory 要把摘要并进 sections')
})

// ---- 2026-10-25：撤回「回应采纳」，立场改成三种写法 ----

test('立场三种写法：还没开始 / 走完 0 条 / 已有条数', () => {
  const c = read('lib/client.js')
  assert.ok(
    c.includes('要等四个阶段（信任 / 自主 / 主动 / 整合）都走完，立场才开始产生'),
    '没走完门的时候要写明「走完才开始产生」',
  )
  assert.ok(c.includes("rowTip('立场', '0 条', '完成整合，但暂未形成自己的立场。')"), '走完门但还没站住过，是另一种写法')
  assert.ok(c.includes('立场是在四个阶段都走完之后才开始产生的'), '有立场时也要写清口径')
  assert.ok(!c.includes('回应采纳'), '「回应采纳」这一行已经删掉')
})

test('/state 给出 stanceReady，且不再有 capabilityOf', () => {
  const o = read('lib/observe.js')
  assert.ok(/stanceReady:\s*gatesDone\(m\)/.test(o), '/state 要给 stanceReady')
  assert.ok(!o.includes('capabilityOf'))
  assert.equal(fs.existsSync(new URL('../lib/capability.js', import.meta.url)), false)
})

test('say.js 不再落 task meta', () => {
  const s = read('lib/say.js')
  assert.ok(!s.includes('taskMeta'))
  assert.ok(!s.includes('looksLikeRework'))
})

test('原理页与原理图不再提「能力」这条线', () => {
  assert.ok(!read('lib/client.js').includes('横向那条叫能力'))
  const svg = read('media/principle-loop.svg')
  assert.ok(!svg.includes('横向长「能力」'))
  // 2026-10-25 重做：立场不再是底部一行小字，而是图里独立的一块
  assert.ok(svg.includes('立场清单'), '立场那一块保留')
  assert.ok(!svg.includes('纵向长「立场清单」'), '旧的一行字写法已删')
})

test('原理页给「立场」单独一张卡，且不再有「从计次到能力」', () => {
  const c = read('lib/client.js')
  assert.ok(c.includes("theoryCard('立场：走完门才开始攒'"), '立场够格单独一张卡')
  assert.ok(c.includes('一、什么时候开始：四个阶段都走完开始进行，没有尽头，也没有「通关终点」。'))
  assert.ok(c.includes('二、什么算立场：同一种类型的事，两次表达过一样的观点；或者在这件事上出现过伤疤。'))
  assert.ok(c.includes('三、不会被折叠：写进上下文提示词。如果遗漏，那立场也将消失。'))
  assert.ok(c.includes("theoryCard('从计次到复现'"), '能力已删，卡片改名')
  assert.ok(!c.includes("'从计次到能力'"))
})

test('立场之间会打架：后来的算数，判不出先后就两条都不要', () => {
  const basis = (text, since) => ({ id: `b_${Math.random().toString(36).slice(2)}`, text, since, status: 'active', mentions: 3, verified: 0 })
  const model = (bs) => ({ stage: 4, stageForced: false, beliefs: bs, scars: [] })
  // 同话题：早期「我绝不吃辣」+ 后来「我喜欢吃辣」→ 只留新的，并标 changedFrom
  const r = buildStances(model([basis('我绝不吃辣。', '2026-10-01T00:00:00Z'), basis('我喜欢吃辣。', '2026-10-20T00:00:00Z')]))
  assert.equal(r.length, 1)
  assert.equal(r[0].kind, 'like')
  assert.equal(r[0].changedFrom, '我绝不吃辣。')
  assert.ok(stanceLine(r[0]).includes('这件事我改过口'))
  // 时间相同：判不出先后 → 两条都不在
  const same = buildStances(model([basis('我绝不吃辣。', '2026-10-01T00:00:00Z'), basis('我喜欢吃辣。', '2026-10-01T00:00:00Z')]))
  assert.equal(same.length, 0)
  // 时间缺失：同样不替她选
  const noTime = buildStances(model([basis('我绝不吃辣。'), basis('我喜欢吃辣。', '2026-10-20T00:00:00Z')]))
  assert.equal(noTime.length, 0)
})

test('上限：内部 12 条、写进提示词 8 条', () => {
  assert.equal(STANCE_MAX, 12)
  assert.equal(STANCE_PROMPT_MAX, 8)
  const many = []
  for (let i = 0; i < 10; i++) many.push({ kind: 'never', text: `我不做第${i}种事。`, scars: 9 - i, mentions: 0, verified: 0 })
  const bullets = stanceSection(many).split(String.fromCharCode(10)).filter((x) => x.startsWith('- '))
  assert.equal(bullets.length, 8)
})

// ---- 0.9.7 U2/U3：拒绝升格成立场（用户 m01175 担心"拒绝无限叠加"）----
// 口径：单次不进；同一件事两次、其中一次他有过反应才进；
// 或者三次都没松口、且跨了不止一天。写出来只写「那次」，不写次数。
function refusal(o = {}) {
  return {
    id: o.id ?? `r_${Math.random().toString(36).slice(2)}`,
    at: o.at ?? '2026-10-20T10:00:00Z',
    what: o.what ?? '不叫。',
    act: o.act ?? '叫',
    object: o.object ?? '老大',
    quote: o.quote ?? o.what ?? '不叫。',
    reaction: o.reaction ?? null,
    // 2026-11-18：来源与改口是 derive.js 算出来挂在元素上的，测试直接给。
    refs: o.refs ?? [],
    fromOwner: o.fromOwner ?? null,
    revisedVerdict: o.revisedVerdict ?? null,
  }
}

test('单次拒绝不成立场：说过一次不叫，不等于「绝不叫任何人老大」', () => {
  const one = buildStances(model({ refusals: [refusal({ reaction: 'insist' })] }))
  assert.equal(one.length, 0)
  assert.equal(stanceSection(one), '')
})

test('同一件事拒绝两次、其中一次他有过反应，才立得住', () => {
  const noReact = model({
    refusals: [refusal({ at: '2026-10-01T10:00:00Z' }), refusal({ at: '2026-10-08T10:00:00Z' })],
  })
  assert.equal(buildStances(noReact).length, 0, '他每次都收下了，不算立场')

  const withReact = model({
    refusals: [
      refusal({ at: '2026-10-01T10:00:00Z', reaction: 'insist' }),
      refusal({ at: '2026-10-08T10:00:00Z' }),
    ],
  })
  const r = buildStances(withReact)
  assert.equal(r.length, 1)
  assert.equal(r[0].kind, 'refused')
  assert.equal(r[0].object, '老大')
})

test('三次都没松口但挤在同一天，不算（那是他在追问）', () => {
  const sameDay = model({
    refusals: [
      refusal({ at: '2026-10-01T10:00:00Z' }),
      refusal({ at: '2026-10-01T11:00:00Z' }),
      refusal({ at: '2026-10-01T12:00:00Z' }),
    ],
  })
  assert.equal(buildStances(sameDay).length, 0)

  const spread = model({
    refusals: [
      refusal({ at: '2026-10-01T10:00:00Z' }),
      refusal({ at: '2026-10-02T10:00:00Z' }),
      refusal({ at: '2026-10-09T10:00:00Z' }),
    ],
  })
  assert.equal(buildStances(spread).length, 1)
})

test('渲染只写「那次」，不带次数、不带数字', () => {
  const r = buildStances(model({
    refusals: [
      refusal({ at: '2026-10-01T10:00:00Z', reaction: 'hurt' }),
      refusal({ at: '2026-10-08T10:00:00Z' }),
    ],
  }))
  const line = stanceLine(r[0])
  // 2026-11-18（用户 m01161）：不再写「他没收回」——那是替{T}安的动作。
  // 只写事件流里真有的：他因此不好受/走开过（hurt/leave）。
  assert.equal(line, '- 你说过「不叫」，这件事你没答应。那天之后你没改口。')
  assert.ok(!/[0-9]/.test(line))
  assert.ok(!line.includes('次'))
})

// ---- 「我绝不…」和升格的拒绝是同一个方向，不算打架 ----
// resolveConflicts 原先只看 kind 不同 + 同一件事。0.9.7 多了 kind:'refused' 之后，
// 「我绝不吃辣」（never）和「他让你吃辣，你没答应」（refused）被当成改口：
// 谁晚谁留下，另一条从清单里拿掉，留下的那条还挂上 changedFrom。
function spicy({ said = [], refused = [] }) {
  return model({
    beliefs: said.map((since, i) => belief('我绝不吃辣', { id: `b${i}`, since })),
    refusals: refused.map((at, i) => refusal({ id: `r${i}`, at, what: '我不想吃辣', act: '', object: '吃辣' })),
  })
}

test('「我绝不…」在前、同一件事的拒绝在后：两条都在，她那句原话不被模板句顶掉', () => {
  const r = buildStances(spicy({
    said: ['2026-10-01T10:00:00Z', '2026-10-03T10:00:00Z'],
    refused: ['2026-10-10T10:00:00Z', '2026-10-12T10:00:00Z', '2026-10-14T10:00:00Z'],
  }))
  assert.deepEqual(r.map((s) => s.kind).sort(), ['never', 'refused'])
  assert.ok(r.every((s) => !s.changedFrom), '同向的两条谁也不是谁的「以前」')
  const text = stanceSection(r)
  assert.ok(text.includes('- 我绝不吃辣'), '她自己说的那句还在')
  assert.ok(text.includes('- 你说过「我不想吃辣」，这件事你没答应。这件事你一直没改口。'))
  assert.ok(!text.includes('改过口'))
})

test('拒绝在前、「我绝不…」在后：不挂「这件事我改过口」', () => {
  const r = buildStances(spicy({
    refused: ['2026-10-01T10:00:00Z', '2026-10-03T10:00:00Z', '2026-10-05T10:00:00Z'],
    said: ['2026-10-10T10:00:00Z', '2026-10-12T10:00:00Z'],
  }))
  assert.deepEqual(r.map((s) => s.kind).sort(), ['never', 'refused'])
  const never = r.find((s) => s.kind === 'never')
  assert.equal(never.changedFrom, undefined)
  assert.equal(stanceLine(never), '- 我绝不吃辣')
  assert.ok(!stanceSection(r).includes('改过口'), '她没改过口：先是没答应，后来说了绝不')
})

test('「我绝不…」和拒绝比不出先后：同向，不用比，两条都留', () => {
  const refused = ['2026-10-01T10:00:00Z', '2026-10-03T10:00:00Z', '2026-10-05T10:00:00Z']
  // 同一毫秒
  const same = buildStances(spicy({ said: ['2026-10-02T10:00:00Z', '2026-10-05T10:00:00Z'], refused }))
  assert.deepEqual(same.map((s) => s.kind).sort(), ['never', 'refused'])
  // 判断没带时间
  const noTime = buildStances(spicy({ said: [undefined, undefined], refused }))
  assert.deepEqual(noTime.map((s) => s.kind).sort(), ['never', 'refused'])
})

test('「我喜欢…」和同一件事的拒绝才是反向：照旧后来的算数', () => {
  const likes = (since) => since.map((s, i) => belief('我喜欢吃辣', { id: `l${i}`, since: s }))
  const refusals = (at) => at.map((a, i) => refusal({ id: `r${i}`, at: a, what: '我不想吃辣', act: '', object: '吃辣' }))
  // 先说喜欢，后来三次没答应 → 留拒绝
  const later = buildStances(model({
    beliefs: likes(['2026-10-01T10:00:00Z', '2026-10-03T10:00:00Z']),
    refusals: refusals(['2026-10-10T10:00:00Z', '2026-10-12T10:00:00Z', '2026-10-14T10:00:00Z']),
  }))
  assert.deepEqual(later.map((s) => s.kind), ['refused'])
  assert.equal(later[0].changedFrom, '我喜欢吃辣')
  // 先三次没答应，后来说喜欢 → 留喜欢，这回是真的改过口
  const earlier = buildStances(model({
    beliefs: likes(['2026-10-10T10:00:00Z', '2026-10-12T10:00:00Z']),
    refusals: refusals(['2026-10-01T10:00:00Z', '2026-10-03T10:00:00Z', '2026-10-05T10:00:00Z']),
  }))
  assert.deepEqual(earlier.map((s) => s.kind), ['like'])
  assert.ok(stanceLine(earlier[0]).includes('这件事我改过口'))
  // 比不出先后 → 两条都不进，不替她选
  const tie = buildStances(model({
    beliefs: likes(['2026-10-02T10:00:00Z', '2026-10-05T10:00:00Z']),
    refusals: refusals(['2026-10-01T10:00:00Z', '2026-10-03T10:00:00Z', '2026-10-05T10:00:00Z']),
  }))
  assert.equal(tie.length, 0)
})

test('升格之后「你拒绝过」不再重复摆同一件事', () => {
  const refusals = [
    refusal({ at: '2026-10-01T10:00:00Z', reaction: 'insist' }),
    refusal({ at: '2026-10-08T10:00:00Z' }),
  ]
  const sections = buildSections({
    seed: '你是一条会自己长起来的鱼。',
    day: 60,
    stage: 4,
    stageGate: { passed: ['trust', 'autonomy', 'competence'] },
    beliefs: [],
    refusals,
    scars: [],
    tensions: [],
    solid: [],
    faded: [],
    refuted: [],
    selfmodAttempts: [],
    facts: { hurts: 0 },
    narrative: null,
    name: null,
    absenceDays: 0,
  })
  const text = sections.map((s) => s.text).join(String.fromCharCode(10))
  assert.ok(text.includes('你说过「不叫」，这件事你没答应。'), '立场里写「那次」')
  assert.ok(!text.includes('## 你拒绝过'), '同一件事不重复写两遍')
})

test('清单排到第 9 条以后的拒绝没摆进「我站哪边」，就得留在「你拒绝过」里', () => {
  // 清单内部留 STANCE_MAX 条，身份文档只摆前 STANCE_PROMPT_MAX 条。
  // 去重要是按整张清单算，排在后面的那件事两头都没有，整份文档里就找不到它了。
  const topics = ['替别人写作业', '在群里唱歌', '半夜叫醒他', '假装自己是人', '背着他改设置', '把私聊贴到群里', '替他回别人的消息', '说自己没看过的番好看']
  const nevers = (n) => topics.slice(0, n).flatMap((t, i) => [
    belief(`我绝不${t}`, { id: `b${i}a`, mentions: 3 }),
    belief(`我绝不${t}`, { id: `b${i}b`, mentions: 3 }),
  ])
  const refusals = [
    refusal({ at: '2026-10-01T10:00:00Z' }),
    refusal({ at: '2026-10-02T10:00:00Z' }),
    refusal({ at: '2026-10-09T10:00:00Z' }),
  ]
  const doc = (beliefs) => {
    const m = model({ stageGate: { passed: ['trust', 'autonomy', 'competence'] }, faded: [], name: null, absenceDays: 0, beliefs, refusals })
    const text = buildSections(m).map((s) => s.text).join('\n\n')
    const part = (head) => text.split('\n\n').find((s) => s.startsWith(head)) ?? ''
    return { list: buildStances(m), stand: part('## 我站哪边'), refused: part('## 你拒绝过') }
  }

  // 8 组判断排在前面，升格的拒绝是清单第 9 条：没摆出来
  const over = doc(nevers(STANCE_PROMPT_MAX))
  assert.equal(over.list.length, STANCE_PROMPT_MAX + 1)
  assert.equal(over.list[STANCE_PROMPT_MAX].kind, 'refused')
  assert.equal(over.stand.split('\n').filter((l) => l.startsWith('- ')).length, STANCE_PROMPT_MAX)
  assert.ok(!over.stand.includes('老大'))
  assert.ok(over.refused.includes('老大'), '没摆进「我站哪边」的拒绝，还在「你拒绝过」里')

  // 少一组判断，它是第 8 条：摆进「我站哪边」，「你拒绝过」照旧不重复
  const fits = doc(nevers(STANCE_PROMPT_MAX - 1))
  assert.ok(fits.stand.includes('- 你说过「不叫」，这件事你没答应。这件事你一直没改口。'))
  assert.equal(fits.refused, '')
})

// ---- 谁先提的：写在事件里，不是措辞里二选一（2026-11-18，加拿大反馈带出来的） ----
// 旧句式把「他要求→她拒绝」当成所有拒绝的来路。她也会自己起念（刷到一条视频就不想去、
// 学到一个东西就说不用），写成「他让你…」就是替她记了一件没发生的事。
test('拒绝记了来源才写「他那天说过…」，没记就只写她自己的话', () => {
  const withSource = stanceLine({
    kind: 'refused',
    object: '吃辣',
    quote: '我不想吃辣',
    fromOwner: { id: 'ev_h1', text: '今晚去吃火锅吧' },
    heHeld: false,
    hadReaction: false,
  })
  assert.equal(
    withSource,
    '- 他那天说过「今晚去吃火锅吧」，你说过「我不想吃辣」，这件事你没答应。这件事你一直没改口。',
  )

  // 没挂 refs：不替她补一个请求，只说她自己说过什么。
  const own = stanceLine({ kind: 'refused', object: '去参加', quote: '我不去', heHeld: false, hadReaction: false })
  assert.equal(own, '- 你说过「我不去」，这件事你没答应。这件事你一直没改口。')
  assert.ok(!own.includes('他让你'), '没来源就不写「他让你」')
})

test('关系句只写事件里真有的：坚持、那天之后、过去了——不替他安「没收回」', () => {
  const insist = stanceLine({
    kind: 'refused',
    object: '叫老大',
    quote: '不叫',
    fromOwner: { id: 'ev_h1', text: '叫一声老大' },
    pushed: 'insist',
    heHeld: true,
    hadReaction: true,
  })
  assert.ok(insist.includes('又提过，你没改口。'), '2026-11-18（用户 m01161）：不写「没收回」')
  assert.ok(!insist.includes('没收回'), '「{T}没收回」是我们替他安的动作，事件流里没有')
  assert.ok(!/\d/.test(insist) && !insist.includes('次'), '只写「那次」不写次数')

  const hurt = stanceLine({
    kind: 'refused',
    object: '叫老大',
    quote: '不叫',
    pushed: 'hurt',
    heHeld: true,
    hadReaction: true,
  })
  assert.ok(hurt.includes('那天之后你没改口。'))

  // 他回过话，但不是坚持（leave / other）——一次松口不算一直站住。
  const gone = stanceLine({
    kind: 'refused',
    object: '叫老大',
    quote: '不叫',
    fromOwner: { id: 'ev_h1', text: '叫一声老大' },
    heHeld: false,
    hadReaction: true,
  })
  assert.ok(gone.includes('后来那件事过去了。'))
  assert.ok(!gone.includes('没收回'))
})

test('她本人推翻过的拒绝不再写进立场（省得文档里又有「我改过口」又有「一直没改口」）', () => {
  const m = model({
    refusals: [
      refusal({ at: '2026-10-01T10:00:00Z', reaction: 'insist' }),
      refusal({ at: '2026-10-08T10:00:00Z' }),
      refusal({ at: '2026-10-09T10:00:00Z', revisedVerdict: 'refuted' }),
    ],
  })
  const list = buildStances(m)
  assert.equal(list.length, 1)
  assert.equal(list[0].members.length, 2, '被推翻的那条不进成员')
})

test('来源只认 heard（他本人），群里那句不算「对她说的」', () => {
  // derive.js 那边已经把 group 场景的 heard 滤掉了，这里锁的是 stance 只吃 fromOwner。
  const plain = stanceLine({
    kind: 'refused',
    object: '吃辣',
    quote: '我不想吃辣',
    fromOwner: null,
    heHeld: false,
    hadReaction: false,
  })
  assert.ok(plain.startsWith('- 你说过「我不想吃辣」'))
})

test('引用里的话剪到 60 字以内，剪断处留「…」', () => {
  // 2026-11-18（用户 m01161 第二条）：40 字会剪掉限定条件（「只在…的时候」），
  // 读起来比原话更绝对；放到 60 字，剪断处补「…」让人看得出这是半句。
  const long = stanceLine({
    kind: 'refused',
    object: '那件事',
    quote: `我不想去${'那种地方'.repeat(30)}`,
    fromOwner: { id: 'ev_h1', text: `你今晚能不能${'别这样'.repeat(20)}` },
    heHeld: false,
    hadReaction: false,
  })
  assert.ok(!long.includes('那种地方'.repeat(30)))
  assert.ok(long.includes('那种地方'.repeat(10)), `40 字版本会把她前十个字的限定条件剪掉：${long}`)
  assert.ok(long.includes('…'), '剪断了要留标记，否则像她只说了半句')
  assert.ok(long.length < 260, `太长：${long.length}`)
})

test('同一天记两次不算「反复过」：要跨天、而且他真有过反应才升格', () => {
  // 2026-11-18（用户 m01161 第五条）：两次都发生在同一天，多半是同一场对话里说了两遍，
  // 不是「一直这样」；升格成立场要有跨天证据。
  const sameDay = model({
    refusals: [
      refusal({ id: 's1', at: '2026-10-01T10:00:00Z', act: '', object: '吃辣', what: '我不想吃辣', quote: '我不想吃辣', reaction: 'insist' }),
      refusal({ id: 's2', at: '2026-10-01T14:00:00Z', act: '', object: '吃辣', what: '我不想吃辣', quote: '我不想吃辣' }),
    ],
  })
  assert.deepEqual(buildStances(sameDay), [], '同一天两次，还不到「我站住过」')

  const crossDay = model({
    refusals: [
      refusal({ id: 'c1', at: '2026-10-01T10:00:00Z', act: '', object: '吃辣', what: '我不想吃辣', quote: '我不想吃辣', reaction: 'insist' }),
      refusal({ id: 'c2', at: '2026-10-03T14:00:00Z', act: '', object: '吃辣', what: '我不想吃辣', quote: '我不想吃辣' }),
    ],
  })
  assert.equal(buildStances(crossDay).length, 1, '跨天两次、且他坚持过，才升格')
})

// ---- 2026-11-18（用户 m01161）九条改动：并组、去重、可核对 ----

test('并组要同一个动作：对象像但动作不同，是两件事（0.6 + act 一致）', () => {
  // 「不叫老大」和「不喊老大」字面很像（similarity 0.6+），但一个是不叫、一个是不喊；
  // 合成一条会写成「你说过「老大」」这种谁也对不上的话。
  const m = model({
    refusals: [
      refusal({ id: 'a1', at: '2026-10-01T10:00:00Z', act: '叫', object: '老大', reaction: 'insist' }),
      refusal({ id: 'a2', at: '2026-10-03T10:00:00Z', act: '叫', object: '老大' }),
      refusal({ id: 'b1', at: '2026-10-01T10:00:00Z', act: '喊', object: '老大', reaction: 'insist' }),
      refusal({ id: 'b2', at: '2026-10-04T10:00:00Z', act: '喊', object: '老大' }),
    ],
  })
  const list = buildStances(m)
  assert.equal(list.length, 2, '两个动作各成一条，不合并')
  assert.deepEqual(list.map((s) => s.act).sort(), ['叫', '喊'])
})

test('同一句话被记成判断又记成拒绝：只留判断那条（近似逐字重复才去）', () => {
  const m = model({
    beliefs: [belief('我绝不吃辣', { id: 'b1' }), belief('我绝不吃辣', { id: 'b2', since: '2026-10-02' })],
    refusals: [
      refusal({ id: 'r1', at: '2026-10-05T10:00:00Z', what: '我绝不吃辣', quote: '我绝不吃辣', act: '', object: '吃辣', reaction: 'insist' }),
      refusal({ id: 'r2', at: '2026-10-06T10:00:00Z', what: '我绝不吃辣', quote: '我绝不吃辣', act: '', object: '吃辣' }),
      refusal({ id: 'r3', at: '2026-10-07T10:00:00Z', what: '我绝不吃辣', quote: '我绝不吃辣', act: '', object: '吃辣' }),
    ],
  })
  const list = buildStances(m)
  assert.deepEqual(list.map((s) => s.kind), ['never'], '同一条证据不写两遍')
})

test('措辞不同的同一件事：两条都留（一条是她说的，一条是她没做的）', () => {
  const m = model({
    beliefs: [belief('我绝不吃辣', { id: 'b1' }), belief('我绝不吃辣', { id: 'b2', since: '2026-10-02' })],
    refusals: [
      refusal({ id: 'r1', at: '2026-10-05T10:00:00Z', what: '我不想吃辣', quote: '我不想吃辣', act: '', object: '吃辣', reaction: 'insist' }),
      refusal({ id: 'r2', at: '2026-10-06T10:00:00Z', what: '我不想吃辣', quote: '我不想吃辣', act: '', object: '吃辣' }),
    ],
  })
  assert.deepEqual(buildStances(m).map((s) => s.kind).sort(), ['never', 'refused'])
})

test('her_stance 的明细：每条列出哪几次、哪几天来的，超出 8 条的标出来', () => {
  const words = ['吃辣', '熬夜', '叫老大', '点外卖', '看恐怖片', '坐飞机', '喝酒', '早起', '开会']
  const refusals = []
  words.forEach((object, i) => {
    refusals.push(refusal({ id: `r${i}a`, at: `2026-10-0${i + 1}T10:00:00Z`, act: '', object, what: `我不想${object}`, quote: `我不想${object}`, reaction: 'insist' }))
    refusals.push(refusal({ id: `r${i}b`, at: `2026-10-1${i % 8}T10:00:00Z`, act: '', object, what: `我不想${object}`, quote: `我不想${object}` }))
  })
  const rows = stanceDetail(model({ refusals }))
  assert.equal(rows.length, 9, '清单上的全给她看，包括排在 8 条后面的')
  assert.equal(rows.filter((r) => r.shown).length, STANCE_PROMPT_MAX, '文档里只写前 8 条')
  assert.equal(rows.at(-1).shown, false, '第 9 条排在后面，要标出来')
  const first = rows[0]
  assert.ok(first.members.length >= 2, '每一条都要列出它是由哪几次长出来的')
  assert.match(first.members[0].id, /^r\d+a$/)
  assert.match(first.members[0].at, /^\d{2}-\d{2}$/, '日期写成月日，按本地日历')
  assert.ok(first.members[0].text.length > 0, '要带原话')
})

// 2026-11-20（用户反馈）：清单空着时不能说一句「还没有站住过的地方」就完——
// 她记过的话原样摆出来。阈值、次数、四道门一个字都不进去（她不能读自己的设定）。
test('her_stance 空着时：把她记过的话原样摆出来，不写阈值与阶段', () => {
  const m = model({
    beliefs: [
      belief('以后十点半就睡', { id: 'ev_sleep', since: '2026-11-02T12:00:00.000Z' }),
      belief('绝不再半夜刷手机', { id: 'ev_phone', since: '2026-10-26T12:00:00.000Z' }),
    ],
  })
  const near = uncountedRecords(m)
  assert.deepEqual(near.map((x) => x.id), ['ev_sleep', 'ev_phone'], '新的在前')
  const text = renderDetail(stanceDetail(m), near)
  assert.match(text, /还没有一条站住过的地方/)
  assert.match(text, /你记过这几句/)
  assert.match(text, /11-02　以后十点半就睡（ev_sleep）/)
  assert.match(text, /10-26　绝不再半夜刷手机（ev_phone）/)
  assert.ok(!/门|阶段|两次|三次|阈值|相似/.test(text), '不把内部判据写进回答')
})

test('her_stance 空着且一条都没记过：直说没记过', () => {
  const m = model()
  const text = renderDetail(stanceDetail(m), uncountedRecords(m))
  assert.match(text, /还没把哪件事记下来过/)
  assert.ok(!/门|阶段|两次/.test(text))
})

test('空清单只摆还站着的记录，最多五条', () => {
  const beliefs = []
  for (let i = 0; i < 7; i += 1) {
    beliefs.push(belief(`第${i}句`, { id: `b${i}`, since: `2026-10-0${i + 1}T12:00:00.000Z` }))
  }
  beliefs.push(belief('这句撤了', { id: 'gone', status: 'refuted' }))
  const near = uncountedRecords(model({ beliefs }))
  assert.equal(near.length, 5)
  assert.equal(near[0].id, 'b6', '按时间倒序取最近五条')
  assert.ok(!near.some((x) => x.id === 'gone'), '被推翻的不再摆出来')
})

// ---- issue #158（2026-11-20，用户 m01094）：同一件事，她每次说法都不一样 ----
// 报告人的 87 条判断没有一条能并进同一组：全是单条视频长出来的 100–200 字复盘，
// 两两字面相似度上不去 0.45，mentions 恒 1，立场清单因此永远是空的。
// 修法是加两条「同一件事」的判据：她自己打的 topic、以及拒绝那一句的「头一句」。
const topiced = (since, topic, id) => belief('我不想再为一条没核实过的评论开口', { id, since, topic })

test('同一件事说法差很远，但她打了同一个 topic、跨了天：并成一条（issue #158）', () => {
  const r = buildStances(model({
    beliefs: [
      topiced('2026-10-01T10:00:00Z', '核实', 'b1'),
      belief('我不会去替没查过的事撑腰', { id: 'b2', since: '2026-10-06T10:00:00Z', topic: '核实' }),
    ],
  }))
  assert.equal(r.length, 1, '字面不像，但她说的是同一件事')
  assert.equal(r[0].kind, 'never')
  assert.deepEqual([...r[0].members].sort(), ['b1', 'b2'])
})

test('同一个 topic 但挤在同一天，不并（那是同一条判断的上下半句）', () => {
  // 日期键按本地日历算：选 10Z / 14Z 这两个点，东八区与多伦多都落在 10-06 当天。
  const r = buildStances(model({
    beliefs: [
      topiced('2026-10-06T10:00:00Z', '核实', 'b1'),
      belief('我不会去替没查过的事撑腰', { id: 'b2', since: '2026-10-06T14:00:00Z', topic: '核实' }),
    ],
  }))
  assert.equal(r.length, 0)
})

test('没有 topic 就还是只看字面：不因为「都是拒绝」就并成一条', () => {
  const r = buildStances(model({
    beliefs: [
      belief('我不想再为一条没核实过的评论开口', { id: 'b1', since: '2026-10-01T10:00:00Z' }),
      belief('我不会去替没查过的事撑腰', { id: 'b2', since: '2026-10-06T10:00:00Z' }),
    ],
  }))
  assert.equal(r.length, 0)
})

test('同一件事拒绝了两次、第二次把话说长了：头一句认得出是同一件（issue #158）', () => {
  const r = buildStances(model({
    refusals: [
      refusal({
        at: '2026-10-01T10:00:00Z',
        act: '',
        object: '看你推给我的那些视频，一看就到半夜，眼睛疼',
        what: '我不想看你推的那些视频。',
        reaction: 'insist',
      }),
      refusal({
        at: '2026-10-08T10:00:00Z',
        act: '',
        object: '看你推给我的那些视频看到凌晨三点',
        what: '我不想看你推的视频。',
      }),
    ],
  }))
  assert.equal(r.length, 1, '整句只有 0.51，头一句 0.82')
  assert.equal(r[0].kind, 'refused')
  assert.equal(r[0].object, '看你推给我的那些视频，一看就到半夜，眼睛疼', '代表句取组里第一条的那件事')
})
