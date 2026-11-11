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
  assert.equal(line, '- 他让你叫老大，你没叫。他没收回，你也没改口。')
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
  assert.ok(text.includes('- 他让你吃辣，你没答应。这件事你一直没改口。'))
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
  assert.ok(text.includes('他让你叫老大，你没叫。'), '立场里写「那次」')
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
  assert.ok(fits.stand.includes('- 他让你叫老大，你没叫。这件事你一直没改口。'))
  assert.equal(fits.refused, '')
})
