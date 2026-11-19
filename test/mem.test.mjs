/**
 * mem.test.mjs —— 上下文与记忆四件套的回归测试（2026-10-23）
 *
 * 覆盖：
 *   1. 身份文档的预算装配：超预算时**核心段与四条黑名单绝不被裁**
 *   2. 「更早以前」折叠：压缩而不是删除
 *   3. 会话轮换的原话搬运（talkmem）与到期失效（activeCarry）
 *   4. 回忆工具：中文切片、时间窗、条数封顶、翻不到就说翻不到
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { personaLine, assemble, foldOlderBeliefs, HARD_BANS, sleepPrompt } from '../lib/persona.js'
import { renderSelfDoc } from '../lib/selfdoc.js'
import { addExchange, recentExchanges, renderCarry, TALK_KEEP, TALK_MAX } from '../lib/talkmem.js'
import { bumpTurns, rotateTalkSession, activeCarry, homeStatus, CARRY_TURNS, ROTATE_RETRY_MS, rotationHold, quietGapOf, talkHot, hotTalk } from '../lib/home.js'
import { searchEvents, tokensOf, renderRecall, RECALL_LIMIT, RECALL_BRIEF_SNIPPET, literalsOf, freshnessOf, FRESH_FLOOR } from '../lib/recall.js'
import { normalizeConfig, DEFAULTS, updateConfig, CARRY_MAX } from '../lib/settings.js'

const DAY = 86_400_000

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fish-mem-'))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

function model(over = {}) {
  return {
    day: 9,
    stage: 2,
    seed: '你不是助手。',
    name: null,
    absenceDays: 0,
    beliefs: [],
    refuted: [],
    refusals: [],
    selfmodAttempts: [],
    narrative: null,
    ...over,
  }
}

// ---------------------------------------------------------------- 预算装配

test('预算再小，四条黑名单和「你是谁」都还在', () => {
  const m = model({
    beliefs: Array.from({ length: 12 }, (_, i) => ({ id: `b${i}`, text: `判断${i}：${'长'.repeat(40)}` })),
    refuted: [{ oldText: 'a', newText: 'b' }],
    refusals: [{ what: '不想说' }],
  })
  const text = personaLine(m, { budget: 10 }) // 小到什么都塞不下
  assert.match(text, /## 你是谁/)
  assert.match(text, /## 不能做的/)
  for (const ban of HARD_BANS) assert.ok(text.includes(ban), `黑名单被裁掉了：${ban.slice(0, 12)}`)
  // 可选段应该整段被丢掉，而不是留个空标题
  assert.ok(!text.includes('## 你被打脸过'))
})

test('预算够的时候可选段按顺序塞进来', () => {
  const m = model({ beliefs: [{ id: 'b1', text: '我觉得他不是在观察我。' }] })
  const text = personaLine(m, { budget: 4000 })
  assert.match(text, /你自己说过的话/)
  assert.ok(text.includes('我觉得他不是在观察我。'))
})

test('assemble 不会为了凑字数把后面的关键段丢掉', () => {
  const secs = [
    { text: 'KEEP-1', keep: true },
    { text: 'opt-big'.repeat(50), keep: false },
    { text: 'KEEP-2', keep: true },
  ]
  const out = assemble(secs, 10)
  assert.ok(out.includes('KEEP-1') && out.includes('KEEP-2'))
  assert.ok(!out.includes('opt-big'))
})

test('「更早以前」是折叠不是删除：原文仍在，只截断显示', () => {
  const beliefs = Array.from({ length: 12 }, (_, i) => ({ id: `b${i}`, text: `判断编号${i}` }))
  // 2026-10-24：beliefs 改成显著性排序（最显著的在前），
  // 于是"折叠"折的是**最不显著**的那几条，不再是"最旧"的那几条。
  const line = foldOlderBeliefs(beliefs)
  assert.ok(line.includes('判断编号3') && line.includes('判断编号4'), '折叠行要带上靠后的那几条')
  assert.match(line, /还有 6 条更早的/)
  // 显示区只放最显著的 BELIEF_SHOWN 条
  const text = personaLine(model({ beliefs }), { budget: 4000 })
  assert.ok(text.includes('- 判断编号0'), '最显著的必须在眼前')
  assert.ok(text.includes('- 判断编号2'))
  assert.ok(!text.includes('- 判断编号3'), '靠后的不该单独成条')
  assert.ok(text.includes('判断编号3'), '被折起来的那几条也要留个影子')
})

// ---------------------------------------------------------------- 轮换搬运

// 2026-11-11：盘上按上限存（用户把设置调大时不用等新对话攒），
// 但默认读出来的还是 4 轮——老版本的行为一个字不变。
test('talkmem 盘上按上限留、默认只读四轮，且不改原话', () => withRoot(async (root) => {
  for (let i = 0; i < TALK_MAX + 3; i++) await addExchange(root, { me: `他说第${i}句`, her: `她说第${i}句` })
  const stored = await recentExchanges(root, 50)
  assert.equal(stored.length, TALK_MAX)
  assert.equal(stored.at(-1).me, `他说第${TALK_MAX + 2}句`)
  assert.equal((await recentExchanges(root)).length, TALK_KEEP)
  assert.equal(TALK_MAX, CARRY_MAX)
  const txt = renderCarry(await recentExchanges(root))
  assert.match(txt, /上次我们说到这/)
  assert.match(txt, /他说第/)
}))

test('要 0 轮就是 0 轮（不能因为 slice(-1) 变成带一轮）', () => withRoot(async (root) => {
  await addExchange(root, { me: '他说一句', her: '她说一句' })
  assert.deepEqual(await recentExchanges(root, 0), [])
  assert.deepEqual(await recentExchanges(root, -3), [])
  assert.equal(await recentExchanges(root, 1).then((l) => l.length), 1)
}))

test('空的话不记（避免一堆空行占名额）', () => withRoot(async (root) => {
  const r = await addExchange(root, { me: '   ', her: '嗯' })
  assert.equal(r.ok, false)
  assert.equal((await recentExchanges(root)).length, 0)
}))

function fakeCtx({ createId = 'sess-new', presetReject = false } = {}) {
  const calls = { create: [], rename: [], get: [] }
  return {
    calls,
    sessionController: {
      async create(args) {
        calls.create.push(args)
        if (presetReject && args?.agentPreset) throw new Error('unknown preset')
        return { sessionId: createId }
      },
      async rename(args) { calls.rename.push(args); return {} },
    },
    get(name) {
      calls.get.push(name)
      if (name === 'workspaceRegistry') {
        return {
          get: () => ({ id: 'ws-1', sessionIds: ['sess-old'], path: '/x' }),
          archivedSessionIds: [],
          list: () => [{ id: 'ws-1', path: '/x', title: '大肥鱼的家' }],
        }
      }
      return null
    },
  }
}

test('轮换：旧会话改名留档、新会话接管、原话搬过去', () => withRoot(async (root) => {
  const { writeAtomic, paths } = await import('../lib/store.js')
  const homeFile = join(paths(root).root, 'home.json')
  await writeAtomic(homeFile, JSON.stringify({ wsId: 'ws-1', sessionId: 'sess-old', turns: 40 }))
  await addExchange(root, { me: '你还记得那天吗', her: '记得。' })

  const ctx = fakeCtx()
  const r = await rotateTalkSession(ctx, { root })
  assert.equal(r.ok, true)
  assert.equal(r.sessionId, 'sess-new')
  assert.equal(r.old, 'sess-old')

  // 旧会话必须被改名而不是删除
  assert.equal(ctx.calls.rename[0].sessionId, 'sess-old')
  assert.match(ctx.calls.rename[0].title, /之前/)
  // 新会话用默认标题
  assert.equal(ctx.calls.rename[1].title, '跟大肥鱼说话')

  const st = await homeStatus(root)
  assert.equal(st.sessionId, 'sess-new')
  assert.equal(st.turns, 0)
  const carry = await activeCarry(root)
  assert.match(carry, /你还记得那天吗/)
  // 2026-11-15（用户 m02909）：留话那条整个删了；这里留着当回归——旧档案里
  // 可能还留着 lastWords，轮换后新房间也不该读到它。
  const saved = JSON.parse(await readFile(homeFile, 'utf8'))
  assert.equal(saved.lastWords, undefined)
}))

test('换会话带几轮原话听设置的：调小就少带，0 就整段不带（2026-11-11）', () => withRoot(async (root) => {
  const { writeAtomic, paths } = await import('../lib/store.js')
  const homeFile = join(paths(root).root, 'home.json')
  const reseed = async () => writeAtomic(homeFile, JSON.stringify({ wsId: 'ws-1', sessionId: 'sess-old', turns: 40 }))
  for (let i = 0; i < 6; i++) await addExchange(root, { me: `第${i}句`, her: `答${i}` })

  // 调小到 2：只带最后两轮
  await updateConfig({ chat: { carry: 2 } }, root)
  await reseed()
  assert.equal((await rotateTalkSession(fakeCtx(), { root })).ok, true)
  let carry = await activeCarry(root)
  assert.match(carry, /第5句/)
  assert.match(carry, /第4句/)
  assert.doesNotMatch(carry, /第3句/)

  // 0 = 不带：连标题都不出现，别留一节空壳
  await updateConfig({ chat: { carry: 0 } }, root)
  await reseed()
  assert.equal((await rotateTalkSession(fakeCtx({ createId: 'sess-3' }), { root })).ok, true)
  carry = await activeCarry(root)
  assert.equal(carry, '')
  const saved = JSON.parse(await readFile(homeFile, 'utf8'))
  assert.equal(saved.carry, '')
  assert.equal(saved.sessionId, 'sess-3')
}))

test('换会话只换该换的：preset / title 要留下，hearAt 跟着轮数归零（issue #14 第二报 / issue #60）', () => withRoot(async (root) => {
  const { writeAtomic, paths } = await import('../lib/store.js')
  const homeFile = join(paths(root).root, 'home.json')
  // 以前这里整份覆盖写，preset/title 全被抹掉 —— 换完会话她挑的那套预设丢了，
  // 但没有任何日志能看出来。hearAt 是另一回事：它记的是「上次旁听在第几轮」，
  // 新会话 turns 从 0 起，照搬旧值会让旁听永远追不上（issue #60）。
  await writeAtomic(homeFile, JSON.stringify({
    wsId: 'ws-1',
    sessionId: 'sess-old',
    turns: 40,
    preset: '那个人挑的那套',
    hearAt: 7,
    title: '她自己起的名字',
    adoptedAt: '2026-10-01T00:00:00.000Z',
  }))
  // 2026-11-19：preset 的权威来源是配置（`tools.preset`），换房按它建；
  // 旧档案里的值只用来对照「这次真用上了哪套」。
  await updateConfig({ tools: { preset: '那个人挑的那套', allow: [] } }, root)

  const ctx = fakeCtx()
  const r = await rotateTalkSession(ctx, { root })
  assert.equal(r.ok, true)
  assert.equal(ctx.calls.create[0].agentPreset, '那个人挑的那套')

  const raw = JSON.parse(await readFile(homeFile, 'utf8'))
  assert.equal(raw.sessionId, 'sess-new')
  assert.equal(raw.turns, 0)
  assert.equal(raw.preset, '那个人挑的那套')
  assert.equal(raw.hearAt, 0)
  assert.equal(raw.title, '她自己起的名字')
  assert.equal(raw.rotatedFrom, 'sess-old')
  assert.ok(raw.rotatedAt)
}))

test('搬运最多管 8 轮，之后自己消失（否则她会被一段旧话钉住）', () => withRoot(async (root) => {
  const { writeAtomic, paths } = await import('../lib/store.js')
  const homeFile = join(paths(root).root, 'home.json')
  await writeAtomic(homeFile, JSON.stringify({
    wsId: 'ws-1', sessionId: 's', turns: 0, rotatedAt: new Date().toISOString(), carry: '## 上次我们说到这\n- 旧话',
  }))
  assert.ok((await activeCarry(root)).includes('旧话'))
  for (let i = 0; i < CARRY_TURNS; i++) await bumpTurns(root, 1)
  assert.equal(await activeCarry(root), '')
}))

test('搬运超过三天也失效', () => withRoot(async (root) => {
  const { writeAtomic, paths } = await import('../lib/store.js')
  const homeFile = join(paths(root).root, 'home.json')
  await writeAtomic(homeFile, JSON.stringify({
    wsId: 'ws-1', sessionId: 's', turns: 0,
    rotatedAt: new Date(Date.now() - 4 * DAY).toISOString(), carry: '## 上次我们说到这\n- 旧话',
  }))
  assert.equal(await activeCarry(root), '')
}))

test('没有轮换过就没有搬运段（身份文档不凭空多一节）', () => withRoot(async (root) => {
  const doc = renderSelfDoc(model())
  assert.ok(!doc.includes('上次我们说到这'))
}))

test('身份文档里不再有搬运段：交接页是单独一段，只在换房后第一轮挂', () => {
  const doc = renderSelfDoc(model({ beliefs: [{ id: 'b', text: '判断' }] }))
  assert.ok(!doc.includes('上次我们说到这'), '常驻就成了每轮都在念；用户 m01722 要求只出现一次')
  for (const ban of HARD_BANS) assert.ok(doc.includes(ban))
})

test('身份文档说清：工具调用后的续写不是新的叫醒（issue #110）', () => {
  const doc = renderSelfDoc(model(), { carry: '' })
  assert.match(doc, /调用过工具/)
  assert.match(doc, /不是新的叫醒/)
  assert.match(doc, /回执不是谁在跟我说话/)
})

// ---------------------------------------------------------------- 回忆工具

test('中文查询会切二字片段（否则整句匹配全落空）', () => {
  const t = tokensOf('那天你在写评论')
  assert.ok(t.includes('那天'))
  assert.ok(t.includes('评论'))
})

test('回忆：能翻到、按相关度排、条数封顶', () => {
  const now = Date.now()
  const events = [
    { id: '1', type: 'utterance', ts: new Date(now - DAY).toISOString(), text: '那天我在写评论的时候想到二舅' },
    { id: '2', type: 'utterance', ts: new Date(now - 2 * DAY).toISOString(), text: '评论这件事我说不好' },
    { id: '3', type: 'narration', ts: new Date(now - 3 * DAY).toISOString(), text: '跟评论无关的一句话' },
    ...Array.from({ length: 10 }, (_, i) => ({
      id: `x${i}`, type: 'utterance', ts: new Date(now - (i + 1) * DAY).toISOString(), text: `评论 ${i}`,
    })),
  ]
  const { rows } = searchEvents(events, '评论', { now })
  assert.ok(rows.length > 0)
  assert.ok(rows.length <= RECALL_LIMIT)
  assert.ok(rows[0].text.includes('评论'))
  assert.ok(rows[0].date.length === 10)
})

test('回忆：跳过 meta，且时间窗外的翻不到', () => {
  const now = Date.now()
  const events = [
    { id: 'm', type: 'meta', ts: new Date(now - DAY).toISOString(), text: '评论' },
    { id: 'o', type: 'utterance', ts: new Date(now - 90 * DAY).toISOString(), text: '评论' },
  ]
  assert.equal(searchEvents(events, '评论', { now, days: 30 }).rows.length, 0)
})

test('回忆：翻不到就说翻不到，不编', () => {
  assert.equal(renderRecall([]), '你翻了，没翻到。')
  const { rows } = searchEvents([], '任何东西')
  assert.equal(rows.length, 0)
})

test('回忆：超长原文被截断，不给她整段历史', () => {
  const now = Date.now()
  const events = [{ id: '1', type: 'utterance', ts: new Date(now).toISOString(), text: '评论' + '很'.repeat(500) }]
  const { rows } = searchEvents(events, '评论', { now })
  assert.ok(rows[0].text.length <= 200)
  assert.ok(rows[0].text.endsWith('…'))
})

test('回忆 brief 档：只报开头，但条数与 id 一个不少（2026-11-02 m00335）', () => {
  const now = Date.now()
  const long = '评论 ' + '这是一段很长的原文'.repeat(40)
  const events = Array.from({ length: 6 }, (_, i) => ({
    id: `b${i}`, type: 'utterance', ts: new Date(now - i * DAY).toISOString(), text: long,
  }))

  // 不传 brief：还是 200 字那段老口径
  const full = searchEvents(events, '评论', { now })
  assert.ok(full.rows.every((r) => r.text.length <= 200))
  assert.ok(full.rows[0].text.length > 40)

  // 传 brief：截到 40 字以内，条数不变
  const brief = searchEvents(events, '评论', { now, snippet: RECALL_BRIEF_SNIPPET })
  assert.equal(brief.rows.length, full.rows.length)
  assert.ok(brief.rows.every((r) => r.text.length <= RECALL_BRIEF_SNIPPET), '每条都不超过 40 字')
  assert.ok(brief.rows[0].text.endsWith('…'))

  // 渲染层也要认这个档位：开头那句明说只报了开头，且 id 保留（她还得靠它去 revise）
  const txt = renderRecall(brief.rows, { brief: true })
  assert.ok(txt.startsWith('有这些（只报了开头'))
  assert.ok(txt.includes('（b0）'), 'brief 也要给 id，否则她翻到了也用不了')
  assert.ok(!txt.includes('你翻到的：'))
  // 老口径不受影响
  assert.ok(renderRecall(full.rows).startsWith('你翻到的：'))
})

// ------------------------------------------------- issue #133（2026-11-12）

test('issue #133：watched: 翻得到，而且读得出来是「看过画面」', () => {
  const now = Date.now()
  const events = [
    { id: 'e1', type: 'utterance', ts: new Date(now - DAY).toISOString(), text: '示例标题这条卡了两下，没拿到画面。' },
    { id: 'e2', type: 'meta', ts: new Date(now - DAY).toISOString(), text: 'watched:2026-11-06 BV1xx411c7mD {"title":"示例标题","duration":784}' },
    { id: 'e3', type: 'utterance', ts: new Date(now).toISOString(), text: '能看了。取到的四帧都清楚。' },
  ]
  const { rows } = searchEvents(events, '示例标题', { now })
  const txt = renderRecall(rows)
  assert.ok(txt.includes('你那天看过画面：《示例标题》'), '唯一凭证不能翻不到')
  assert.ok(rows.some((r) => r.id === 'e2'))
})

test('issue #133：look: 与没带标题的老 looked: 也翻得到，读得出来是「点开过」', () => {
  const now = Date.now()
  const events = [
    { id: 'l1', type: 'meta', ts: new Date(now - DAY).toISOString(), text: 'look:2026-11-06 BV1xx411c7mD {"title":"点开过的","up":"某UP"}' },
    { id: 'l2', type: 'meta', ts: new Date(now - 2 * DAY).toISOString(), text: 'looked:BV1yy411c7mD' },
  ]
  const txt = renderRecall(searchEvents(events, '点开过的', { now }).rows)
  assert.ok(txt.includes('你那天点开过：《点开过的》'))
  // 老事件只有编号：照实说没记下标题，不要编一个，也不要把编号藏成「看过」
  const bare = renderRecall(searchEvents(events, 'BV1yy411c7mD', { now }).rows)
  assert.ok(bare.includes('你那天看过（BV1yy411c7mD，当时没记下标题）'))
})

test('issue #133：brief 档先翻成人话再截断，标题不会被 JSON 截坏', () => {
  const now = Date.now()
  const events = [
    { id: 'b1', type: 'meta', ts: new Date(now - DAY).toISOString(), text: 'look:2026-11-06 BV1xx411c7mD {"title":"点开过的","up":"某UP","duration":784,"view":12000,"desc":"很长很长的一段说明"}' },
  ]
  const { rows } = searchEvents(events, '点开过的', { now, snippet: RECALL_BRIEF_SNIPPET })
  // 40 字里塞不下整段 JSON：先截再翻会只剩一个 BV 号，翻到等于没翻
  assert.ok(rows[0].text.includes('点开过：《点开过的》'), `brief 档也要认得出是哪一条：${rows[0].text}`)
})

test('issue #133：同一天同一条视频只摆一行，留「看过画面」那份', () => {
  const now = Date.now()
  const at = new Date(now - DAY).toISOString()
  const events = [
    { id: 'a', type: 'meta', ts: at, text: 'looked:BV1xx411c7mD 看见过的' },
    { id: 'b', type: 'meta', ts: at, text: 'look:2026-11-06 BV1xx411c7mD {"title":"点开过的"}' },
    { id: 'c', type: 'meta', ts: at, text: 'watched:2026-11-06 BV1xx411c7mD {"title":"看见过的"}' },
  ]
  const { rows } = searchEvents(events, '看见过的 点开过的 BV1xx411c7mD', { now })
  assert.equal(rows.length, 1, '三行是同一条视频，不是三件事')
  assert.equal(rows[0].id, 'c')
  assert.ok(renderRecall(rows).includes('你那天看过画面'))
})

test('issue #133：截断了就说这不是全部，别让「没翻到」被读成「没有」', () => {
  const now = Date.now()
  const events = Array.from({ length: 12 }, (_, i) => ({
    id: `n${i}`, type: 'utterance', ts: new Date(now - i * DAY).toISOString(), text: `评论 ${i}`,
  }))
  const r = searchEvents(events, '评论', { now })
  assert.equal(r.rows.length, RECALL_LIMIT)
  assert.equal(r.truncated, true)
  assert.ok(r.total > RECALL_LIMIT)
  const txt = renderRecall(r.rows, { truncated: r.truncated })
  assert.ok(txt.includes('这不是全部'))
  assert.ok(txt.includes('别把这份当成全集'))
  // 没截断时不多嘴
  const few = searchEvents(events.slice(0, 3), '评论', { now })
  assert.equal(few.truncated, false)
  assert.ok(!renderRecall(few.rows, { truncated: few.truncated }).includes('这不是全部'))
})

test('issue #133：划掉的便条在回忆里读成「你那天做完」，不是一句空回执', () => {
  const now = Date.now()
  const events = [
    { id: 'u', type: 'meta', ts: new Date(now - DAY).toISOString(), text: 'use:her_note ok 已划掉：交水费' },
  ]
  const txt = renderRecall(searchEvents(events, '水费', { now }).rows)
  assert.ok(txt.includes('你那天做完：交水费'))
})

// ------------------------------------------------- 0.8.9 人格连续（m00998）

test('「这些天」是核心段：预算 60 也在，且写的是事实不是评价', async () => {
  const { personaLine } = await import('../lib/persona.js')
  const m = model()
  const line = personaLine(m, {
    budget: 60,
    withBans: true,
    continuity: { diaryCount: 5, diaryFirst: '2026-10-28', diaryLast: '2026-11-03', rotatedDaysAgo: 3 },
  })
  assert.match(line, /## 这些天/)
  assert.match(line, /你自己写过 5 篇日记，从 2026-10-28 到 2026-11-03/)
  assert.match(line, /上一次换房间是 3 天前/)
  // 不写篇数排名、不写"你变了"这类评价
  assert.doesNotMatch(line, /篇数|排名|成长|你变了/)
})

test('这些天：没写过日记 / 刚换房间 各说各的话', async () => {
  const { personaLine } = await import('../lib/persona.js')
  const m = model()
  const zero = personaLine(m, { continuity: { diaryCount: 0, diaryFirst: '', diaryLast: '', rotatedDaysAgo: 0 } })
  assert.match(zero, /你还没写过日记/)
  assert.match(zero, /你刚搬进这个房间/)
  // 完全没有 continuity 时这一节不该凭空出现
  assert.doesNotMatch(personaLine(m, {}), /## 这些天/)
})

test('「上一个房间里留的最后一句」已删（2026-11-15，用户 m02909）：文档不再有这一段', async () => {
  const { personaLine } = await import('../lib/persona.js')
  const line = personaLine(model(), { continuity: { lastWords: '你走的时候把窗关好。' } })
  assert.doesNotMatch(line, /## 上一个房间里/)
  // 交接页也不再收这一项：传进来也不写
  const { renderHandoff } = await import('../lib/handoff.js')
  const page = renderHandoff({ exchanges: [{ me: '在', her: '我在' }], lastWords: '留着' })
  assert.ok(!page.includes('临走前留了'))
})

test('轮换不再问她留话：不问、不写 lastWords，交接照旧', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-no-lastwords-'))
  try {
    const { writeAtomic, paths } = await import('../lib/store.js')
    const homeFile = join(paths(root).root, 'home.json')
    await writeAtomic(homeFile, JSON.stringify({ wsId: 'ws-1', sessionId: 'sess-old', turns: 40 }))

    const { rotateTalkSession } = await import('../lib/home.js')
    const { continuityOf } = await import('../lib/selfdoc.js')
    const prompts = []
    const ctx = {
      sessionController: {
        async create() { return { sessionId: 'sess-new' } },
        async rename() { return {} },
        async prompt(req) { prompts.push(req); return {} },
      },
      on() { return () => {} },
      get() { return null },
    }
    const r = await rotateTalkSession(ctx, { root })
    assert.equal(r.ok, true)
    assert.deepEqual(
      prompts.filter((p) => String(p.requestId ?? '').startsWith('carry-')),
      [],
      '轮换不再往对话里发「要不要留一句」',
    )

    const saved = JSON.parse(await readFile(homeFile, 'utf8'))
    assert.equal(saved.lastWords, undefined)
    assert.equal(saved.sessionId, 'sess-new')
    assert.equal(saved.rotatedFrom, 'sess-old')
    const c = await continuityOf(root)
    assert.equal(c.lastWords, undefined)
    assert.equal(c.rotatedDaysAgo, 0)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('换房先换身份文档、再叫醒：新房间第一个请求读到的就是这一间（2026-11-15）', async () => {
  await withRoot(async (root) => {
    const { writeAtomic, paths } = await import('../lib/store.js')
    const { selfDocPath, writeSelfDoc } = await import('../lib/selfdoc.js')
    const homeFile = join(paths(root).root, 'home.json')
    // 上一间：昨天搬进来的。先让文档真的写成「昨天」——这正是新房间会读到的那一份。
    const y = new Date()
    y.setDate(y.getDate() - 1)
    y.setHours(12, 0, 0, 0)
    await writeAtomic(homeFile, JSON.stringify({ wsId: 'ws-1', sessionId: 'sess-old', turns: 40, rotatedAt: y.toISOString() }))
    await writeSelfDoc(root)
    const stale = await readFile(selfDocPath(root), 'utf8')
    assert.match(stale, /上一次换房间是昨天/)
    // 1.0.2 及更早写过的那一节，旧档案里可能还留着（1.0.3 已删整条链路）
    await writeAtomic(selfDocPath(root), `${stale}\n## 上一个房间里，你自己留的最后一句\n\n> 你要好好的。\n`)

    const seen = []
    const ctx = {
      sessionController: {
        async create() { return { sessionId: 'sess-new' } },
        async rename() { return {} },
        async prompt(req) {
          // 宿主在这一点装配 system prompt，读的就是磁盘上这份文档
          seen.push({ req, doc: await readFile(selfDocPath(root), 'utf8') })
          return {}
        },
      },
      on() { return () => {} },
      get() { return null },
    }
    const r = await rotateTalkSession(ctx, { root })
    assert.equal(r.ok, true)
    // prompt 是「收下了就返回」，等它那一拍
    for (let i = 0; i < 200 && seen.length === 0; i += 1) await new Promise((ok) => setTimeout(ok, 10))
    assert.ok(seen.length >= 1, '换完房要叫醒新会话')

    const doc = seen[0].doc
    assert.match(doc, /你是今天 \d\d:\d\d 搬进这个房间的/, '第一步就该说「今天搬进来的」')
    assert.doesNotMatch(doc, /上一次换房间/, '不该还写着上一间的时间')
    assert.doesNotMatch(doc, /## 上一个房间里/, '旧档案残值不许跟着搬进新房间')
    // 落盘那份与叫醒时读到的一致
    assert.equal(await readFile(selfDocPath(root), 'utf8'), doc)
  })
})

test('没有 prompt 服务也能换房（不再依赖问她留话，2026-11-15）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-lastwords2-'))
  try {
    const { writeAtomic, paths } = await import('../lib/store.js')
    const homeFile = join(paths(root).root, 'home.json')
    await writeAtomic(homeFile, JSON.stringify({ wsId: 'ws-1', sessionId: 'sess-old', turns: 40 }))
    const { rotateTalkSession } = await import('../lib/home.js')
    const ctx = {
      sessionController: {
        async create() { return { sessionId: 'sess-new' } },
        async rename() { return {} },
      },
      on() { return () => {} },
      get() { return null },
    }
    const r = await rotateTalkSession(ctx, { root })
    assert.equal(r.ok, true)
    const saved = JSON.parse(await readFile(homeFile, 'utf8'))
    assert.equal(saved.lastWords, undefined)
    assert.equal(saved.sessionId, 'sess-new')
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

// ---------------------------------------------------------------- 轮换失败

test('换房也按配置里的 preset 建（2026-11-19 外部反馈：默认是「PTC 极简」的人，换完房她只剩几件工具）', () => withRoot(async (root) => {
  const { writeAtomic, paths } = await import('../lib/store.js')
  const homeFile = join(paths(root).root, 'home.json')
  await writeAtomic(homeFile, JSON.stringify({ wsId: 'ws-1', sessionId: 'sess-old', turns: 120 }))
  await updateConfig({ tools: { preset: 'standard', allow: [] } }, root)

  const ctx = fakeCtx()
  const r = await rotateTalkSession(ctx, { root })
  assert.equal(r.ok, true)
  assert.equal(r.preset, 'standard')
  assert.equal(ctx.calls.create.length, 1)
  assert.equal(ctx.calls.create[0].agentPreset, 'standard', '换房这条路必须和补建那条同一个口径')
  const st = await homeStatus(root)
  assert.equal(st.preset, 'standard', 'home.json 要记下这一间实际用的组合')
}))

test('换房时宿主不认这个 preset：回落默认建、日志说清楚、home.json 不谎报', () => withRoot(async (root) => {
  const { writeAtomic, paths } = await import('../lib/store.js')
  const homeFile = join(paths(root).root, 'home.json')
  await writeAtomic(homeFile, JSON.stringify({ wsId: 'ws-1', sessionId: 'sess-old', turns: 120, preset: 'old' }))
  await updateConfig({ tools: { preset: 'fish-home', allow: [] } }, root)

  const notes = []
  const ctx = fakeCtx({ presetReject: true })
  const r = await rotateTalkSession(ctx, { root, log: (m) => notes.push(String(m)) })
  assert.equal(r.ok, true, '换房不能因为这个失败')
  assert.equal(r.preset, '')
  assert.equal(ctx.calls.create.length, 2)
  assert.equal(ctx.calls.create[0].agentPreset, 'fish-home')
  assert.equal(ctx.calls.create[1].agentPreset, undefined)
  assert.ok(notes.some((n) => /没被接受/.test(n)))
  assert.equal((await homeStatus(root)).preset, '', '继承旧值会把上次的组合当成这次的')
}))

test('没配 preset 就照宿主的默认建：老行为一个字不变', () => withRoot(async (root) => {
  const { writeAtomic, paths } = await import('../lib/store.js')
  const homeFile = join(paths(root).root, 'home.json')
  await writeAtomic(homeFile, JSON.stringify({ wsId: 'ws-1', sessionId: 'sess-old', turns: 120 }))

  const ctx = fakeCtx()
  const r = await rotateTalkSession(ctx, { root })
  assert.equal(r.ok, true)
  assert.equal(ctx.calls.create.length, 1)
  assert.equal(ctx.calls.create[0].agentPreset, undefined)
  assert.equal((await homeStatus(root)).preset, '')
}))

// 病历（2026-11-06，用户反馈的截图）：换会话失败时，那条「要不要给下一个房间
// 留一句话」已经先发出去、落在他正在用的会话窗口里了，而 turns 不归零，
// 下一轮结账又到点、又问一遍。
// 2026-11-15（用户 m02909）：那条提问整个删掉了；用例留着当回归——
// 换不成时仍然一个字都不许往他的对话里发。
test('换会话失败时不往他的对话里发东西（留话那条已删，回归）', async () => {
  await withRoot(async (root) => {
    const { writeAtomic, paths } = await import('../lib/store.js')
    await writeAtomic(join(paths(root).root, 'home.json'), JSON.stringify({ wsId: 'ws-1', sessionId: 'sess-old', turns: 40 }))
    const prompts = []
    const ctx = {
      sessionController: {
        async create() { throw new Error('boom 建不出来') },
        async rename() { return {} },
        async prompt(req) { prompts.push(req); return {} },
      },
      on() { return () => {} },
      get() { return null },
    }
    const r = await rotateTalkSession(ctx, { root })
    assert.equal(r.ok, false)
    assert.match(r.why, /建会话失败/)
    assert.deepEqual(prompts, [], '换不成就不该往他的对话里发东西')
  })
})

test('换会话失败之后冷却一会儿，别每轮都重试', async () => {
  await withRoot(async (root) => {
    const { writeAtomic, paths } = await import('../lib/store.js')
    const homeFile = join(paths(root).root, 'home.json')
    await writeAtomic(homeFile, JSON.stringify({ wsId: 'ws-1', sessionId: 'sess-old', turns: 40 }))
    let created = 0
    const ctx = {
      sessionController: {
        async create() { created += 1; throw new Error('boom 建不出来') },
        async rename() { return {} },
        async prompt() { return {} },
      },
      on() { return () => {} },
      get() { return null },
    }
    const first = await rotateTalkSession(ctx, { root })
    assert.equal(first.ok, false)
    assert.equal(created, 1)
    const saved = JSON.parse(await readFile(homeFile, 'utf8'))
    assert.ok(saved.rotateFailAt, '失败要记一笔时间')
    assert.match(String(saved.rotateFailWhy), /建会话失败/)

    // 冷却期内再来（这中间可能又说了好几句话）：直接跳过，不再骚扰宿主
    const second = await rotateTalkSession(ctx, { root })
    assert.equal(second.ok, false)
    assert.equal(second.cooled, true)
    assert.equal(created, 1, '冷却期内不该再建一次')
  })
})

test('冷却期过了就能再试，换成之后把失败记录清掉', async () => {
  await withRoot(async (root) => {
    const { writeAtomic, paths } = await import('../lib/store.js')
    const homeFile = join(paths(root).root, 'home.json')
    const old = new Date(Date.now() - ROTATE_RETRY_MS - 1000).toISOString()
    await writeAtomic(homeFile, JSON.stringify({
      wsId: 'ws-1', sessionId: 'sess-old', turns: 40, rotateFailAt: old, rotateFailWhy: '上次炸了',
    }))
    const ctx = {
      sessionController: {
        async create() { return { sessionId: 'sess-new' } },
        async rename() { return {} },
        async prompt() { return {} },
      },
      on() { return () => {} },
      get() { return null },
    }
    const r = await rotateTalkSession(ctx, { root })
    assert.equal(r.ok, true)
    assert.equal(r.sessionId, 'sess-new')
    const saved = JSON.parse(await readFile(homeFile, 'utf8'))
    assert.equal(saved.rotateFailAt, undefined)
    assert.equal(saved.rotateFailWhy, undefined)
  })
})

test('新配置项有默认值且能被夹住', () => {
  // 2026-11-15（用户 m00648）：默认 40 → 120——他日常一句一句短聊，40 轮才约 1 万 token，换得太勤。
  assert.equal(DEFAULTS.chat.rotateAfter, 120)
  assert.equal(DEFAULTS.memory.docBudget, 2800, '2026-10-25：1200 → 1800；2026-11-03：1800 → 2400（可选段变多，2000 仍挤掉打脸记录）；2026-11-14：2400 → 2800（新增「最近收过尾的」一行，余量不够用）')
  assert.equal(DEFAULTS.memory.sleepEveryDays, 7)
  const c = normalizeConfig({ chat: { rotateAfter: 9999 }, memory: { docBudget: 1, sleepEveryDays: 999 } })
  assert.equal(c.chat.rotateAfter, 500)
  assert.equal(c.memory.docBudget, 1800) // 2026-11-15：下限 600 → 1800（600 字装不下现在的身份段）
  assert.equal(c.memory.sleepEveryDays, 60)
})

test('rotateAfter=0 表示永不换会话', () => {
  assert.equal(normalizeConfig({ chat: { rotateAfter: 0 } }).chat.rotateAfter, 0)
})

// 2026-11-15（用户 m00648）：轮数满了先别换，等一次 20 分钟以上的停顿；
// 一直连着聊最多再延 10 轮。判据是两轮之间的间隔，不是轮数本身。
test('轮数满了也要等一次停顿才换房（用户 m00648）', async () => {
  await withRoot(async (root) => {
    const t0 = 1_700_000_000_000
    await bumpTurns(root, 1, t0) // 第一条计数轮：没有「上一轮」可等
    const saved1 = JSON.parse(await readFile(join(root, 'home.json'), 'utf8'))
    assert.equal(saved1.lastTurnAt, t0)
    assert.equal(saved1.prevTurnAt, undefined)

    await bumpTurns(root, 1, t0 + 60_000) // 一分钟后又说了一句
    const saved2 = JSON.parse(await readFile(join(root, 'home.json'), 'utf8'))
    assert.equal(saved2.lastTurnAt, t0 + 60_000)
    assert.equal(saved2.prevTurnAt, t0, '记的是**上一轮**的时间，不是这一轮的')

    // 刚说完一分钟：满了也不换
    const hold = await rotationHold(root, { turns: 2, rotateAfter: 2, now: t0 + 120_000 })
    assert.ok(hold, '间隔只有 1 分钟，该先不换')
    assert.equal(hold.gap, 60_000)
    assert.equal(hold.graceLeft, 10)

    // 宽限用完（满了之后再延 10 轮）：不再等，强制换
    assert.equal(await rotationHold(root, { turns: 12, rotateAfter: 2, now: t0 + 120_000 }), null)
    // 还没满：不管
    assert.equal(await rotationHold(root, { turns: 1, rotateAfter: 2, now: t0 + 120_000 }), null)
    // 真的静了 25 分钟：这就是自然缝隙
    assert.equal(await rotationHold(root, { turns: 2, rotateAfter: 2, now: t0 + 60_000 + 25 * 60_000 }), null)
    // 0 = 永不换
    assert.equal(await rotationHold(root, { turns: 999, rotateAfter: 0 }), null)
  })
})

// 2026-11-15（用户 m00829）：他刚说完话的几分钟里，定时唤醒与主动搭话都别插进来。
test('说话热窗：他还在说话就先不叫醒（用户 m00829）', async () => {
  // 纯函数这一层
  assert.equal(quietGapOf({}, 1_000), null, '没记过他说话，就不算热')
  assert.equal(quietGapOf({ lastTurnAt: 1_000 }, 61_000), 60_000)
  assert.equal(talkHot(60_000, 0), null, '0 = 不拦，老行为')
  assert.equal(talkHot(null, 10), null)
  const hot = talkHot(4 * 60_000, 10)
  assert.ok(hot)
  assert.equal(hot.gap, 240_000)
  assert.equal(hot.waitMs, 6 * 60_000, '还差这么久才安静下来')
  assert.equal(talkHot(10 * 60_000, 10), null, '到点了就不再等')

  await withRoot(async (root) => {
    await bumpTurns(root, 1, 1_700_000_000_000)
    const now = 1_700_000_000_000 + 3 * 60_000
    assert.ok(await hotTalk(root, { now, quietMin: 10 }), '3 分钟前刚说完，先别叫')
    assert.equal(await hotTalk(root, { now: now + 30 * 60_000, quietMin: 10 }), null)
    assert.equal(await hotTalk(root, { now, quietMin: 0 }), null, '关掉热窗就照老样子')
    // 盘上没有 home.json：当不拦，别把叫醒卡死
    assert.equal(await hotTalk(join(root, 'nope'), { now, quietMin: 10 }), null)
  })
})

test('睡前卡：没素材不问，有素材只问一句，不要求她总结人生', () => {
  // 1.0（用户 m01648）：不再固定问三个尺度——问哪一句跟着这段时间的素材走。
  assert.equal(sleepPrompt(model({ beliefs: [] }), { question: { kind: 'none', ask: '' } }), '')
  const p = sleepPrompt(model({ beliefs: [{ id: 'b', text: '判断' }] }))
  assert.match(p, /停下来，想一想/)
  assert.match(p, /这阵子/)
  assert.match(p, /不要总结/)
  assert.match(p, /我没想清楚/)
  // 一张卡只问一句：三问并排的老写法不能再回来。
  assert.doesNotMatch(p, /哪一句话，是你现在还会想起来的/)
  assert.doesNotMatch(p, /哪一点变了/)
  // 0.9.9（S-B）：做法常驻在身份文档的 SLEEP_BRIEF，卡上不再派活。
  assert.doesNotMatch(p, /narration/)
})

// ---- personaBudget：用量口径必须是「字」不是「字节」（第 11 个静默 bug） ----
// 病历：观测台原来报 doc.bytes / docBudget。文件是 UTF-8，中文一个字三字节，
// 于是 780 字的中文文档报成 2340 字节、比值恒为 1、进度条永远是满的橙色——
// 看上去「她快撑爆了」，其实只用了六成。数字没错，口径错了。
test('personaBudget 用字数算用量，且与 personaLine 一致', async () => {
  const { personaBudget, personaLine, SELF_DOC_BUDGET } = await import('../lib/persona.js')
  const m = model({ beliefs: Array.from({ length: 12 }, (_, i) => ({ text: `判断 ${i} 号` })) })
  const b = personaBudget(m, { budget: SELF_DOC_BUDGET, withBans: true })
  const line = personaLine(m, { budget: SELF_DOC_BUDGET, withBans: true })

  assert.ok(b.used > 0)
  assert.equal(b.budget, SELF_DOC_BUDGET)
  // 关键：报出来的用量必须等于真正装配出来的字符数（±1 的换行误差）
  assert.ok(Math.abs(b.used - line.length) <= 2, `used=${b.used} line=${line.length}`)
  assert.ok(b.usedRatio > 0 && b.usedRatio <= 1)
})

test('预算紧到离谱时核心段仍完整，可选段被逐个报进 dropped', async () => {
  const { personaBudget, personaLine } = await import('../lib/persona.js')
  const m = model({
    beliefs: Array.from({ length: 8 }, (_, i) => ({ text: `判断 ${i} 号` })),
    refusals: [{ what: '拒绝过一次' }],
    narrative: { text: '我大概是一个会反复想同一件事的东西。' },
  })
  const b = personaBudget(m, { budget: 60, withBans: true })
  const line = personaLine(m, { budget: 60, withBans: true })

  // 四条黑名单与「你是谁」是核心段，任何预算下都不许消失
  assert.match(line, /你是谁/)
  assert.match(line, /不能做的/)
  assert.ok(b.dropped.length > 0, '预算 60 时应该有可选段被挤掉')
  // 被挤掉的段确实不在正文里
  for (const name of b.dropped) {
    if (name.startsWith('你自己说过的话')) assert.ok(!line.includes('## 你自己说过的话'))
  }
  assert.equal(b.usedRatio, 1)
})

// ------------------------------------------------- issue #21：换房间不能只说「刚搬进」

test('换房时间的说法按本地日历日算，不按 24 小时整除', async () => {
  const { formatSwapTime } = await import('../lib/selfdoc.js')

  // 昨晚 22:20 换的，今天上午读到——旧写法 Math.floor(13h/24)=0 → 「刚搬进」
  const at = new Date(2026, 10, 3, 22, 20).getTime()
  const now = new Date(2026, 10, 4, 11, 30).getTime()
  assert.equal(formatSwapTime(at, now), '昨天 22:20')

  // 同一天换的，仍然是今天
  assert.equal(formatSwapTime(new Date(2026, 10, 4, 9, 5).getTime(), now), '今天 09:05')

  // 更早就是日期，同一年不写年份
  assert.equal(formatSwapTime(new Date(2026, 10, 1, 12, 31).getTime(), now), '11 月 1 日 12:31')

  // 跨年才补年份
  assert.equal(formatSwapTime(new Date(2025, 11, 30, 8, 0).getTime(), now), '2025 年 12 月 30 日 08:00')

  // 算不出来给空串，调用方好退回旧句式
  assert.equal(formatSwapTime('', now), '')
  assert.equal(formatSwapTime(NaN, now), '')
})

test('昨晚换的房间，不能再写成「你刚搬进这个房间」', async () => {
  const { personaLine } = await import('../lib/persona.js')
  const { formatSwapTime } = await import('../lib/selfdoc.js')
  const now = new Date(2026, 10, 4, 11, 30).getTime()
  const when = formatSwapTime(new Date(2026, 10, 3, 22, 20).getTime(), now)

  // 就算 rotatedDaysAgo 还是 0（旧的 24 小时整除口径），说法也不能是「刚搬进」
  const line = personaLine(model(), { continuity: { rotatedDaysAgo: 0, rotatedWhen: when } })
  assert.match(line, /上一次换房间是昨天 22:20/)
  assert.doesNotMatch(line, /你刚搬进这个房间/)

  // 今天换的保留那句暖的，但不能只说「刚」，得带钟点
  const today = personaLine(model(), { continuity: { rotatedDaysAgo: 0, rotatedWhen: '今天 09:05' } })
  assert.match(today, /你是今天 09:05 搬进这个房间的/)
  assert.doesNotMatch(today, /你刚搬进这个房间/)

  // 拿不到钟点说法时退回旧句式（老数据不至于整段消失）
  const legacy = personaLine(model(), { continuity: { rotatedDaysAgo: 0 } })
  assert.match(legacy, /你刚搬进这个房间/)
})

test('回忆 brief 档：长的聊天原话也留着标记，别人的话仍不超过上限', () => {
  const now = Date.now()
  const long = '评论' + '好'.repeat(RECALL_BRIEF_SNIPPET)
  const row = (id, type, flags = []) => ({ id, type, flags, ts: new Date(now - DAY).toISOString(), text: long })
  const render = (ev) => renderRecall(searchEvents([ev], '评论', { now, snippet: RECALL_BRIEF_SNIPPET }).rows, { brief: true })
  assert.ok(render(row('chat', 'utterance', ['uncommitted'])).includes('…｜聊天里说的（chat）'))
  for (const [type, label] of [['voice', '读到别人说：'], ['heard', '他说：'], ['answer', '回复：']]) {
    const line = render(row('x', type)).split('\n')[1]
    const body = line.slice(line.indexOf('｜') + 1, line.lastIndexOf('（'))
    assert.ok(body.startsWith(label), type)
    assert.ok(body.length <= RECALL_BRIEF_SNIPPET, type)
  }
})

test('回忆 brief 档：一行式的改口说明不被截掉，id 只报第一个', () => {
  const rows = [{ id: 'r', type: 'revise', verdict: 'refuted', refs: ['a', 'b', 'c'], date: '2026-11-01', text: '好'.repeat(RECALL_BRIEF_SNIPPET + 20) }]
  assert.ok(renderRecall(rows, { brief: true }).includes('…（推翻了 a，那是更早说的）（r）'))
  assert.ok(renderRecall(rows).includes('（推翻了 a,b,c，那是更早说的）（r）'))
})

test('回忆：改口关系引用别人的话或聊天原话时，也说清来路', () => {
  const now = Date.now()
  const at = (d) => new Date(now - d * DAY).toISOString()
  const long = '好'.repeat(RECALL_BRIEF_SNIPPET + 20)
  const events = [
    { id: 'h', type: 'heard', ts: at(9), text: '你别出门了' },
    { id: 'v', type: 'voice', ts: at(9), text: '下雨别出门' },
    { id: 'u', type: 'utterance', flags: ['uncommitted'], ts: at(9), text: '顺口一句' },
    { id: 'lh', type: 'heard', ts: at(9), text: long },
    { id: 'lu', type: 'utterance', flags: ['uncommitted'], ts: at(9), text: long },
    { id: 'r1', type: 'revise', refs: ['h'], ts: at(5), text: '评论一' },
    { id: 'r2', type: 'revise', refs: ['v'], ts: at(4), text: '评论二' },
    { id: 'r3', type: 'revise', refs: ['u'], ts: at(3), text: '评论三' },
    { id: 'r4', type: 'revise', refs: ['lh'], ts: at(2), text: '评论四' },
    { id: 'r5', type: 'revise', refs: ['lu'], ts: at(1), text: '评论五' },
  ]
  const txt = renderRecall(searchEvents(events, '评论', { now }).rows)
  assert.ok(txt.includes('这句改的是：他说：你别出门了（h）'))
  assert.ok(txt.includes('这句改的是：读到别人说：下雨别出门（v）'))
  assert.ok(txt.includes('这句改的是：顺口一句｜聊天里说的（u）'))
  // 引用的字数只算原话，来路和标记都在限额之外
  const cut = '好'.repeat(RECALL_BRIEF_SNIPPET - 1) + '…'
  assert.ok(txt.includes(`这句改的是：他说：${cut}（lh）`))
  assert.ok(txt.includes(`这句改的是：${cut}｜聊天里说的（lu）`))
})

// ------------------------------------------------- issue #23：被推翻的那句不再排第一

test('回忆：被推翻的那条不再靠「被引用过」加分（issue #23）', async () => {
  const { searchEvents } = await import('../lib/recall.js')
  const now = new Date('2026-11-04T12:00:00.000Z').getTime()
  const ev = (id, type, ts, text, extra = {}) => ({ id, type, ts: new Date(ts).toISOString(), text, ...extra })
  const events = [
    ev('ev_old', 'utterance', now - 6 * DAY, '我觉得下雨天最适合发呆'),
    ev('ev_new', 'utterance', now - 3600_000, '下雨天其实让人烦躁'),
    ev('ev_rev', 'revise', now - 1800_000, '我改口了。', { verdict: 'refuted', refs: ['ev_old'] }),
  ]
  const { rows } = searchEvents(events, '下雨天', { now, solidIds: [] })
  assert.equal(rows[0].id, 'ev_new', '被推翻的那句不该还排第一')
  const old = rows.find((r) => r.id === 'ev_old')
  assert.ok(old, '但也不能消失——她翻得到的才改得动')
  // 关系带出来了：谁改的、改成什么
  assert.equal(old.later.id, 'ev_rev')
  assert.equal(old.later.verdict, 'refuted')
  assert.match(old.later.text, /我改口了/)
})

test('回忆：confirmed 不算改口，渲染成「后来你又确认过这句」（issue #23）', async () => {
  const { searchEvents, renderRecall } = await import('../lib/recall.js')
  const now = new Date('2026-11-04T12:00:00.000Z').getTime()
  const ev = (id, type, ts, text, extra = {}) => ({ id, type, ts: new Date(ts).toISOString(), text, ...extra })
  const events = [
    ev('a', 'utterance', now - 5 * DAY, '评论这件事我有看法'),
    ev('b', 'revise', now - DAY, '还是这个看法。', { verdict: 'confirmed', refs: ['a'] }),
  ]
  const { rows } = searchEvents(events, '评论', { now, solidIds: [] })
  const txt = renderRecall(rows)
  assert.match(txt, /后来你又确认过这句/, 'confirmed 不能写成「改说」')
  assert.doesNotMatch(txt, /后来你推翻了这句/)
})

test('回忆：改口关系另起缩进行，并带对方原话（issue #23）', async () => {
  const { searchEvents, renderRecall } = await import('../lib/recall.js')
  const now = new Date('2026-11-04T12:00:00.000Z').getTime()
  const ev = (id, type, ts, text, extra = {}) => ({ id, type, ts: new Date(ts).toISOString(), text, ...extra })
  const events = [
    ev('old', 'utterance', now - 3 * DAY, '我不喜欢猫'),
    ev('rev', 'revise', now - DAY, '我其实挺喜欢猫的。', { verdict: 'refuted', refs: ['old'] }),
  ]
  const { rows } = searchEvents(events, '猫', { now, solidIds: [] })
  const txt = renderRecall(rows)
  const lines = txt.split('\n')
  // 被改的那句下面挂一行缩进说明，不是挤在同一行里
  const i = lines.findIndex((l) => l.startsWith('- ') && l.includes('（old）'))
  assert.ok(i >= 0)
  assert.match(lines[i + 1], /^\s{2}/, '关系要缩进另起一行')
  assert.match(lines[i + 1], /后来你推翻了这句/)
  assert.match(lines[i + 1], /我其实挺喜欢猫的/, '带上对方原话——她没法按 id 再查一次')
  // revise 自己那条下面写着它推翻了什么
  const j = lines.findIndex((l) => l.includes('（rev）'))
  assert.match(lines[j + 1], /这句推翻的是/)
  assert.match(lines[j + 1], /我不喜欢猫/)
})

test('回忆：不是她说的要标来源（voice / answer / heard，issue #23）', async () => {
  const { searchEvents, renderRecall } = await import('../lib/recall.js')
  const now = new Date('2026-11-04T12:00:00.000Z').getTime()
  const ev = (id, type, ts, text, extra = {}) => ({ id, type, ts: new Date(ts).toISOString(), text, ...extra })
  const events = [
    ev('v', 'voice', now - 3 * DAY, '评论里有人这么说'),
    ev('a', 'answer', now - 2 * DAY, '评论我回过一句'),
    ev('h', 'heard', now - DAY, '评论他说的'),
  ]
  // 2026-11-08（用户 m00394）：群聊里的 heard 要写成「他在群里说」。
  // 不然她翻旧账时会把群里的热闹当成「他私下跟我说的」。
  const events2 = [...events, ev('g', 'heard', now - DAY, '评论群里那句', { scene: 'group' })]
  const txt = renderRecall(searchEvents(events2, '评论', { now, solidIds: [] }).rows)
  assert.match(txt, /读到别人说：评论里有人这么说/)
  assert.match(txt, /回复：评论我回过一句/)
  assert.match(txt, /他说：评论他说的/)
  assert.match(txt, /他在群里说：评论群里那句/)
})

// ------------------------------------------------ 2026-11-08（用户 m00187）排序三件事

test('回忆：字面量只收「带数字或分隔符」的，普通英文单词与纯数字不收', () => {
  assert.deepEqual(literalsOf('0.9.3 的坑').sort(), ['0.9.3'])
  assert.deepEqual(literalsOf('snapshot.json 坏了').sort(), ['snapshot.json'])
  assert.deepEqual(literalsOf('her_recall 翻不到').sort(), ['her_recall'])
  assert.deepEqual(literalsOf('ok 和 deepseek 这两个词'), [], '普通英文单词不收：整词与二字切片够用')
  assert.deepEqual(literalsOf('第 3 条'), [], '纯数字不收：年份、条数到处都是')
})

test('回忆：版本号整串比，不被二字切片切碎', () => {
  const now = Date.now()
  const events = [
    // 两字切片会把这句里的字撞上「0.9.3」的碎片（`3的`、`的坑`）
    { id: 'noise', type: 'utterance', ts: new Date(now).toISOString(), text: '今天的事，说了那些话' },
    { id: 'hit', type: 'narration', ts: new Date(now - 20 * DAY).toISOString(), text: '0.9.3 的坑是 bundles 对不齐' },
  ]
  const { rows } = searchEvents(events, '0.9.3 的坑', { now, solidIds: [] })
  assert.equal(rows.length, 1, '没命中这个版本号的条目不该被碎片带进来')
  assert.equal(rows[0].id, 'hit')
})

test('回忆：到处都是的词（今天）不该跟罕见的词（疤）同分', () => {
  const now = Date.now()
  const at = (d) => new Date(now - d * DAY).toISOString()
  const events = [
    ...Array.from({ length: 4 }, (_, i) => ({ id: `f${i}`, type: 'utterance', ts: at(i + 2), text: '今天没什么事' })),
    // 常见词这条更新——原来新旧就是唯一的排序依据
    { id: 'common', type: 'utterance', ts: at(0), text: '今天' },
    { id: 'rare', type: 'narration', ts: at(5), text: '疤' },
  ]
  const { rows } = searchEvents(events, '今天 疤', { now, solidIds: [] })
  assert.equal(rows[0].id, 'rare', '罕见词命中要排在没有信息量的常见词前面')
})

test('回忆：新旧折算 —— 工具账 45 天半衰，她自己的话 180 天，判断类永不折', () => {
  const now = 1_800_000_000_000
  const at = (d) => new Date(now - d * DAY).toISOString()
  const ev = (type, d) => ({ id: type, type, ts: at(d) })
  const solid = new Set()

  const metaF = freshnessOf(ev('meta', 30), { now, solid })
  assert.ok(metaF > 0.7 && metaF < 0.85, `meta 30 天约 0.78，实际 ${metaF}`)
  const saidF = freshnessOf(ev('utterance', 30), { now, solid })
  assert.ok(saidF > 0.9, `她自己的话 30 天该 > 0.9，实际 ${saidF}`)
  assert.equal(freshnessOf(ev('revise', 3000), { now, solid }), 1, '判断类永不折')
  assert.equal(freshnessOf({ id: 'x', type: 'utterance', ts: at(3000) }, { now, solid: new Set(['x']) }), 1, '固化过的不折')
  assert.ok(freshnessOf(ev('utterance', 100_000), { now, solid }) >= FRESH_FLOOR, '再旧也有地板')
})

test('回忆：字面命中相同时，昨天的先于三个月前的（只在加权时折）', () => {
  const now = Date.now()
  const at = (d) => new Date(now - d * DAY).toISOString()
  const events = [
    { id: 'old', type: 'utterance', ts: at(90), text: '评论这件事' },
    { id: 'new', type: 'utterance', ts: at(1), text: '评论这件事' },
  ]
  assert.equal(searchEvents(events, '评论', { now, weigh: false }).rows[0].id, 'new', '不加权：只按新旧')
  assert.equal(searchEvents(events, '评论', { now }).rows[0].id, 'new')
})

// ---------------------------------------------------------------- issue #133 之后：按时间翻（2026-11-12）

test('回忆：不给关键词就按时间摆最近的（用户 m00497）', () => {
  const now = Date.now()
  const at = (d) => new Date(now - d * DAY).toISOString()
  const events = [
    { id: 'a', type: 'utterance', ts: at(3), text: '三天前说的' },
    { id: 'b', type: 'utterance', ts: at(1), text: '昨天说的' },
    { id: 'c', type: 'utterance', ts: at(2), text: '前天说的' },
  ]
  const out = searchEvents(events, '', { now })
  assert.equal(out.timeline, true, '空 query 走时间线')
  assert.deepEqual(out.rows.map((r) => r.id), ['b', 'c', 'a'], '从近到远，不打分')
  // 给了词还是原来的路：相关度优先，不许被时间线串了味。
  assert.equal(searchEvents(events, '前天', { now }).timeline, false)
})

test('回忆：时间线也认 days 与 kind', () => {
  const now = Date.now()
  const at = (d) => new Date(now - d * DAY).toISOString()
  const events = [
    { id: 'a', type: 'utterance', ts: at(9), text: '很久以前说的' },
    { id: 'b', type: 'utterance', ts: at(1), text: '昨天说的' },
    { id: 'c', type: 'revise', ts: at(2), text: '前天改的口' },
  ]
  assert.deepEqual(searchEvents(events, '', { now, days: 3 }).rows.map((r) => r.id), ['b', 'c'])
  assert.deepEqual(searchEvents(events, '', { now, kind: 'revise' }).rows.map((r) => r.id), ['c'])
})

test('回忆：时间线的头和截断说「最近」，不冒充「最相关」', () => {
  const now = Date.now()
  const events = Array.from({ length: 12 }, (_, i) => ({
    id: `u${i}`, type: 'utterance', ts: new Date(now - i * DAY).toISOString(), text: `第${i}句`,
  }))
  const out = searchEvents(events, '', { now })
  const text = renderRecall(out.rows, { timeline: out.timeline, total: out.total, truncated: out.truncated })
  assert.match(text, /最近这些（从近到远摆的）/)
  assert.match(text, /只摆了最近的几条/)

  const kw = searchEvents(events, '第', { now })
  const kwText = renderRecall(kw.rows, { total: kw.total, truncated: kw.truncated })
  assert.match(kwText, /你翻到的/)
  assert.match(kwText, /只摆了最相关的几条/)
})

test('「更早以前」折的时候带上日期，能按日期翻回去（用户 m00497）', () => {
  const beliefs = [0, 1, 2, 3].map((i) => ({
    id: `b${i}`, text: `判断编号${i}`, since: new Date(2026, 10, 1 + i, 12).toISOString(),
  }))
  const line = foldOlderBeliefs(beliefs, 1)
  assert.match(line, /判断编号1」（11-02）/, '折行里要带那条判断的日期')
  // 身份文档里要说明怎么走回去：原文在事件流里，id 由 her_recall 给。
  const text = personaLine(model({ beliefs }), { budget: 4000 })
  const seg = text.slice(text.indexOf('## 更早以前'))
  assert.match(seg, /her_recall/)
  assert.match(seg, /按日期或原话/)
})

// ---------------------------------------------------------------- 最近收过尾的事（2026-11-14，用户 m00242）

test('「这些天」带上最近收过尾的事：划掉的便条、做完的约定', async () => {
  const { closedRecentlyOf, CLOSED_WINDOW_DAYS } = await import('../lib/selfdoc.js')
  const now = Date.now()
  const iso = (d) => new Date(now - d * DAY).toISOString()
  const notes = [
    { id: 'n1', text: '给他打个电话', status: 'done', closedAt: iso(2) },
    { id: 'n2', text: '买猫粮', status: 'dropped', closedAt: iso(30) },
    { id: 'n3', text: '还在做', status: 'open', created: iso(1) },
  ]
  const appointments = [{ id: 'a1', what: '陪他复查', status: 'done', closedAt: iso(3) }]
  const line = closedRecentlyOf(notes, appointments, now)
  assert.match(line, /最近收过尾的/)
  assert.match(line, /你划掉了「给他打个电话」/)
  assert.match(line, /和他约好的「陪他复查」你做完了/)
  assert.doesNotMatch(line, /买猫粮/) // 30 天前的不算近况
  assert.doesNotMatch(line, /还在做/) // 没做完的不算「收过尾」
  assert.ok(CLOSED_WINDOW_DAYS >= 7)

  // 落在「这些天」这一节里，不是另起一段
  const text = personaLine(model(), { budget: 4000, continuity: { closedRecently: line } })
  assert.match(text, /## 这些天/)
  assert.ok(text.includes(line))
})

test('换会话时近况从操作层读：划掉的便条、做完的约定会进身份文档（不进事件流）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-closed-'))
  try {
    const now = Date.now()
    const { writeNotes } = await import('../lib/note.js')
    const { writeAppointments } = await import('../lib/appoint.js')
    const { continuityOf } = await import('../lib/selfdoc.js')
    const { readEvents } = await import('../lib/store.js')
    await writeNotes(root, [
      {
        id: 'n1',
        text: '把灯关掉',
        status: 'done',
        created: new Date(now - DAY).toISOString(),
        closedAt: new Date(now - 1000).toISOString(),
      },
    ])
    await writeAppointments(root, [
      { id: 'a1', due: '2026-11-20', what: '陪他去复查', status: 'done', closedAt: new Date(now - 2 * DAY).toISOString() },
    ])
    const c = await continuityOf(root, now)
    assert.match(c.closedRecently, /把灯关掉/)
    assert.match(c.closedRecently, /陪他去复查/)
    // 只读操作层：事件流里一条都没多出来（derive 的三道门不受影响）
    const { events } = await readEvents(root)
    assert.equal(events.length, 0)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

// ------------------------------------------------ 还没收尾的不进身份文档（2026-11-14，第二轮）

test('还没收尾的便条/约定不进「这些天」：它们在醒的时候才出现，否则就是天天催', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-open-'))
  try {
    const now = Date.now()
    const { writeNotes } = await import('../lib/note.js')
    const { writeAppointments } = await import('../lib/appoint.js')
    const { continuityOf } = await import('../lib/selfdoc.js')
    await writeNotes(root, [
      { id: 'n1', text: '把灯关掉', status: 'open', created: new Date(now - DAY).toISOString() },
    ])
    await writeAppointments(root, [
      { id: 'a1', due: '2026-11-20', what: '陪他去复查', status: 'open' },
    ])
    const c = await continuityOf(root, now)
    // note.js / appoint.js 的硬约束：「别天天提醒我，也别催」「到点只提一次」。
    // 所以人开口的这一轮不该看见挂着的便条/约定；要查就走 her_recall。
    assert.equal(c.openNow, undefined, 'continuityOf 不再算「还没收尾的」')
    const text = personaLine(model(), { budget: 4000, continuity: c })
    assert.doesNotMatch(text, /把灯关掉|陪他去复查/)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('本子目录：只说有哪些东西可翻，一个数字都不报', async () => {
  const { catalogOf } = await import('../lib/selfdoc.js')
  const line = catalogOf({
    notes: [{ id: 'n1', text: '买猫粮', status: 'open' }, { id: 'n2', text: '写周报', status: 'done' }],
    appointments: [{ id: 'a1', due: '2026-11-20', what: '带猫复查', status: 'open' }],
    diaryCount: 3,
  })
  assert.match(line, /你的本子上记着/)
  assert.match(line, /便条/)
  assert.match(line, /的约定/)
  assert.match(line, /日记/)
  assert.match(line, /用 her_recall 翻/)
  assert.doesNotMatch(line, /\d/, '「不吃状态」：不许出现「你还有 N 条未完成」这类数字')
  assert.doesNotMatch(line, /买猫粮|写周报|带猫复查/) // 目录不复制正文
  assert.doesNotMatch(catalogOf({ notes: [{ id: 'n1', text: 'x', status: 'open' }] }), /日记/)
  assert.equal(catalogOf({}), '')
  assert.equal(catalogOf(), '')
})
