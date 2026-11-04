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
import { addExchange, recentExchanges, renderCarry, TALK_KEEP } from '../lib/talkmem.js'
import { bumpTurns, rotateTalkSession, activeCarry, homeStatus, CARRY_TURNS } from '../lib/home.js'
import { searchEvents, tokensOf, renderRecall, registerRecall, RECALL_LIMIT, RECALL_BRIEF_SNIPPET } from '../lib/recall.js'
import { deriveSelf } from '../lib/derive.js'
import { appendEvent } from '../lib/store.js'
import { normalizeConfig, DEFAULTS } from '../lib/settings.js'

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

test('talkmem 只留最近几轮，且不改原话', () => withRoot(async (root) => {
  for (let i = 0; i < TALK_KEEP + 3; i++) await addExchange(root, { me: `他说第${i}句`, her: `她说第${i}句` })
  const list = await recentExchanges(root, 50)
  assert.equal(list.length, TALK_KEEP)
  assert.equal(list.at(-1).me, `他说第${TALK_KEEP + 2}句`)
  const txt = renderCarry(list)
  assert.match(txt, /上次我们说到这/)
  assert.match(txt, /他说第/)
}))

test('空的话不记（避免一堆空行占名额）', () => withRoot(async (root) => {
  const r = await addExchange(root, { me: '   ', her: '嗯' })
  assert.equal(r.ok, false)
  assert.equal((await recentExchanges(root)).length, 0)
}))

function fakeCtx({ createId = 'sess-new' } = {}) {
  const calls = { create: [], rename: [], get: [] }
  return {
    calls,
    sessionController: {
      async create(args) { calls.create.push(args); return { sessionId: createId } },
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
  // 没留话的时候不许留上一个房间的残句（否则新房间会读到一句不是这次说的）
  const saved = JSON.parse(await readFile(homeFile, 'utf8'))
  assert.equal(saved.lastWords, undefined)
}))

test('换会话只换该换的：preset / hearAt / title 这些还不能丢（issue #14 第二报）', () => withRoot(async (root) => {
  const { writeAtomic, paths } = await import('../lib/store.js')
  const homeFile = join(paths(root).root, 'home.json')
  // 以前这里整份覆盖写，preset/hearAt/title 全被抹掉 —— 换完会话旁听节奏归零、
  // 她挑的那套预设也丢了，但没有任何日志能看出来。
  await writeAtomic(homeFile, JSON.stringify({
    wsId: 'ws-1',
    sessionId: 'sess-old',
    turns: 40,
    preset: '那个人挑的那套',
    hearAt: 7,
    title: '她自己起的名字',
    adoptedAt: '2026-10-01T00:00:00.000Z',
  }))

  const r = await rotateTalkSession(fakeCtx(), { root })
  assert.equal(r.ok, true)

  const raw = JSON.parse(await readFile(homeFile, 'utf8'))
  assert.equal(raw.sessionId, 'sess-new')
  assert.equal(raw.turns, 0)
  assert.equal(raw.preset, '那个人挑的那套')
  assert.equal(raw.hearAt, 7)
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
  const doc = renderSelfDoc(model(), { carry: '' })
  assert.ok(!doc.includes('上次我们说到这'))
}))

test('搬运段在身份文档末尾，且不挤掉黑名单', () => {
  const doc = renderSelfDoc(model({ beliefs: [{ id: 'b', text: '判断' }] }), { carry: '## 上次我们说到这\n- 他说：在吗' })
  assert.ok(doc.includes('上次我们说到这'))
  for (const ban of HARD_BANS) assert.ok(doc.includes(ban))
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

test('回忆：行上带本地时刻，同一天的两句分得清先后（2026-11-04）', () => {
  const now = Date.now()
  const a = new Date(now - DAY)
  a.setHours(9, 5, 0, 0)
  const b = new Date(a)
  b.setHours(21, 40, 0, 0)
  const events = [
    { id: 'am', type: 'utterance', ts: a.toISOString(), text: '评论 早上' },
    { id: 'pm', type: 'utterance', ts: b.toISOString(), text: '评论 晚上' },
  ]
  const { rows } = searchEvents(events, '评论', { now })
  assert.deepEqual(rows.map((r) => r.clock).sort(), ['09:05', '21:40'])
  const txt = renderRecall(rows)
  assert.ok(txt.includes(`${rows[0].date} ${rows[0].clock}`))
  // 手写的老 fixture 没有 clock：不凭空印一个
  assert.equal(renderRecall([{ date: '2026-10-22', text: '评论' }]).split('\n')[1], '- 2026-10-22｜评论')
})

const revisedStream = (now) => [
  { id: 'old', type: 'utterance', ts: new Date(now - 90 * DAY).toISOString(), text: '我觉得下雨天最适合发呆' },
  { id: 'new', type: 'revise', verdict: 'refuted', refs: ['old'], ts: new Date(now - 2 * DAY).toISOString(), text: '下雨天我其实更想出门走走' },
  { id: 'calm', type: 'utterance', ts: new Date(now - 3 * DAY).toISOString(), text: '下雨天窗户上的水痕很好看' },
]

test('回忆：翻到推翻过的话，看得见后来推翻了，也看得见改成了什么（2026-11-04）', () => {
  const now = Date.now()
  const { rows } = searchEvents(revisedStream(now), '下雨天', { now })
  const old = rows.find((r) => r.id === 'old')
  assert.deepEqual(old.later, { id: 'new', verdict: 'refuted', text: '下雨天我其实更想出门走走' })
  const neu = rows.find((r) => r.id === 'new')
  assert.deepEqual(neu.earlier, { id: 'old', verdict: 'refuted', text: '我觉得下雨天最适合发呆' })
  assert.equal(rows.find((r) => r.id === 'calm').later, undefined)

  const lines = renderRecall(rows).split('\n')
  const at = lines.findIndex((l) => l.endsWith('我觉得下雨天最适合发呆（old）') && l.startsWith('- '))
  assert.equal(lines[at + 1], '  后来你推翻了这句，改说：下雨天我其实更想出门走走（new）')
  const at2 = lines.findIndex((l) => l.endsWith('下雨天我其实更想出门走走（new）') && l.startsWith('- '))
  assert.equal(lines[at2 + 1], '  这句推翻的是：我觉得下雨天最适合发呆（old）')
})

test('回忆：每条第一行的最后一个括号都是它自己的 id（身份文档这么教她抄的，2026-11-04）', () => {
  const now = Date.now()
  const { rows } = searchEvents(revisedStream(now), '下雨天', { now })
  const firsts = renderRecall(rows).split('\n').filter((l) => l.startsWith('- '))
  assert.equal(firsts.length, rows.length)
  for (const r of rows) assert.ok(firsts.some((l) => l.endsWith(`（${r.id}）`)), r.id)
})

test('回忆：工具的话里没有「否掉」，她顺着说不会被记成一次拒绝（2026-11-04）', () => {
  const now = Date.now()
  const { rows } = searchEvents(revisedStream(now), '下雨天', { now })
  assert.ok(!renderRecall(rows).includes('否掉'))
  assert.ok(!renderRecall(rows, { brief: true }).includes('否掉'))
  // derive.js 的 REFUSE_RE 认「我否掉」，不认「我推翻」。词表要是改了，这条的前提就不成立了。
  const facts = (text) => deriveSelf([{ id: 'x', type: 'utterance', flags: ['uncommitted'], ts: new Date(now).toISOString(), text }]).facts.wont
  assert.equal(facts('对，我否掉了那句'), 1)
  assert.equal(facts('对，我推翻了那句'), 0)
})

test('回忆：被改的那句在时间窗外也照样引出来，三种 verdict 各说各的（2026-11-04）', () => {
  const now = Date.now()
  const events = [
    { id: 'b', type: 'utterance', ts: new Date(now - 50 * DAY).toISOString(), text: '老话' },
    { id: 'a', type: 'revise', verdict: 'refined', refs: ['b'], ts: new Date(now - 2 * DAY).toISOString(), text: '评论另一种说法' },
    { id: 'd', type: 'utterance', ts: new Date(now - 4 * DAY).toISOString(), text: '评论那件事' },
    { id: 'c', type: 'revise', verdict: 'confirmed', refs: ['d'], ts: new Date(now - 3 * DAY).toISOString(), text: '没变' },
    { id: 'f', type: 'utterance', ts: new Date(now - 6 * DAY).toISOString(), text: '评论第三件事' },
    { id: 'e', type: 'revise', refs: ['f'], ts: new Date(now - 5 * DAY).toISOString(), text: '没写结论的改口' },
  ]
  const txt = renderRecall(searchEvents(events, '评论', { now, days: 10 }).rows)
  assert.ok(txt.includes('  这句改的是：老话（b）'))
  assert.ok(txt.includes('  后来你又确认过这句：没变（c）'))
  assert.ok(txt.includes('  后来你改过这句，改说：没写结论的改口（e）'))
  const confirm = renderRecall(searchEvents(events, '没变', { now }).rows)
  assert.ok(confirm.includes('  这句确认的是：评论那件事（d）'))
})

test('回忆：连续改口时先写它改了谁，再写它后来被谁改，只翻到最早那句也看得见最后的说法（2026-11-04）', () => {
  const now = Date.now()
  const events = [
    { id: 'a', type: 'utterance', ts: new Date(now - 9 * DAY).toISOString(), text: '评论第一版' },
    { id: 'b', type: 'revise', verdict: 'refuted', refs: ['a'], ts: new Date(now - 8 * DAY).toISOString(), text: '第二版' },
    { id: 'c', type: 'revise', verdict: 'refuted', refs: ['b'], ts: new Date(now - 7 * DAY).toISOString(), text: '第三版' },
  ]
  const onlyA = searchEvents(events, '评论', { now }).rows
  assert.deepEqual(onlyA.map((r) => r.id), ['a'])
  assert.deepEqual(onlyA[0].later, { id: 'c', verdict: null, text: '第三版' }, '隔了几次时不套第一次的 verdict')
  assert.deepEqual(renderRecall(onlyA).split('\n').slice(2), ['  后来你改过这句，改说：第三版（c）'])

  const middle = renderRecall(searchEvents(events, '第二版', { now }).rows).split('\n').slice(2)
  assert.deepEqual(middle, ['  这句推翻的是：评论第一版（a）', '  后来你推翻了这句，改说：第三版（c）'])

  // 环和自指不会卡死，也不引自己（只有手改事件流才写得出来）
  const loop = [
    { id: 'x', type: 'revise', refs: ['y'], ts: new Date(now - 2 * DAY).toISOString(), text: '评论 x' },
    { id: 'y', type: 'revise', refs: ['x'], ts: new Date(now - DAY).toISOString(), text: '评论 y' },
    { id: 's', type: 'revise', verdict: 'refuted', refs: ['s'], ts: new Date(now - DAY).toISOString(), text: '评论 自己' },
  ]
  const rows = searchEvents(loop, '评论', { now }).rows
  assert.equal(rows.length, 3)
  assert.equal(rows.find((r) => r.id === 'x').later.id, 'y')
  assert.equal(rows.find((r) => r.id === 's').later, undefined)
  assert.equal(rows.find((r) => r.id === 's').earlier, undefined)
})

test('回忆：走到「确认」就停，确认过的话不会被说成改了（2026-11-04）', () => {
  const now = Date.now()
  const rev = (id, verdict, refs, d, text) => ({ id, type: 'revise', verdict, refs, ts: new Date(now - d * DAY).toISOString(), text })
  const a = { id: 'a', type: 'utterance', ts: new Date(now - 9 * DAY).toISOString(), text: '评论第一版' }
  const later = (...more) => {
    const [row] = searchEvents([a, ...more], '评论', { now }).rows
    return renderRecall([row]).split('\n').slice(2)
  }
  // 推翻之后确认的是那句推翻：a 还是被推翻了，不能读成 a 还成立
  assert.deepEqual(later(rev('r1', 'refuted', ['a'], 8, '我其实不这么想'), rev('r2', 'confirmed', ['r1'], 7, '还成立，没变')),
    ['  后来你推翻了这句，改说：我其实不这么想（r1）'])
  // 确认之后再确认：她一直没改
  assert.deepEqual(later(rev('r1', 'confirmed', ['a'], 8, '还成立'), rev('r2', 'confirmed', ['r1'], 7, '依然成立')),
    ['  后来你又确认过这句：还成立（r1）'])
  // 确认之后才推翻的，是真改了
  assert.deepEqual(later(rev('r1', 'confirmed', ['a'], 8, '还成立'), rev('r2', 'refuted', ['r1'], 7, '现在不成立了')),
    ['  后来你改过这句，改说：现在不成立了（r2）'])
})

test('回忆：正文带换行也是一条一行，第一行仍以自己的 id 结尾（2026-11-04）', () => {
  const now = Date.now()
  const events = [
    { id: 'o', type: 'utterance', ts: new Date(now - 3 * DAY).toISOString(), text: '评论 第一行\n第二行' },
    { id: 'n', type: 'revise', verdict: 'refined', refs: ['o'], ts: new Date(now - 2 * DAY).toISOString(), text: '换个\n说法' },
  ]
  for (const brief of [false, true]) {
    const lines = renderRecall(searchEvents(events, '评论', { now }).rows, { brief }).split('\n')
    assert.ok(lines[1].includes('评论 第一行 第二行（o）'), lines[1])
    assert.equal(lines[2], brief ? '  后来你改过这句（n）' : '  后来你改过这句，改说：换个 说法（n）')
    assert.equal(lines.length, 3)
  }
})

test('回忆：改了几句时只报第一句，不报「还有几句」；引用不超过 40 字（2026-11-04）', () => {
  const now = Date.now()
  const long = '评论' + '很长'.repeat(60)
  const events = [
    { id: 'p', type: 'utterance', ts: new Date(now - 9 * DAY).toISOString(), text: long },
    { id: 'q', type: 'utterance', ts: new Date(now - 8 * DAY).toISOString(), text: '评论二' },
    { id: 'r', type: 'revise', verdict: 'refined', refs: ['missing', 'p', 'q'], ts: new Date(now - 5 * DAY).toISOString(), text: '改过一次' },
  ]
  const [row] = searchEvents(events, '改过', { now }).rows
  assert.equal(row.earlier.id, 'p', '指向不存在的 id 就跳过')
  assert.ok(row.earlier.text.length <= RECALL_BRIEF_SNIPPET)
  assert.ok(row.earlier.text.endsWith('…'))
  assert.ok(!/等 ?\d/.test(renderRecall([row])), '报数就是在勾她再翻一次')
})

test('回忆：引用的那句要带来路，不把他说的话写成她说的，也不引 meta（2026-11-04）', () => {
  const now = Date.now()
  const events = [
    { id: 'h', type: 'heard', ts: new Date(now - 9 * DAY).toISOString(), text: '你别出门了' },
    { id: 'u', type: 'utterance', flags: ['uncommitted'], ts: new Date(now - 8 * DAY).toISOString(), text: '顺口一句' },
    { id: 'm', type: 'meta', ts: new Date(now - 7 * DAY).toISOString(), text: 'rotate:40:session-abc' },
    { id: 'r1', type: 'revise', refs: ['h'], ts: new Date(now - 5 * DAY).toISOString(), text: '评论一' },
    { id: 'r2', type: 'revise', refs: ['u'], ts: new Date(now - 4 * DAY).toISOString(), text: '评论二' },
    { id: 'r3', type: 'revise', refs: ['m'], ts: new Date(now - 3 * DAY).toISOString(), text: '评论三' },
  ]
  const txt = renderRecall(searchEvents(events, '评论', { now }).rows)
  assert.ok(txt.includes('这句改的是：他说：你别出门了（h）'))
  assert.ok(txt.includes('这句改的是：聊天时说的：顺口一句（u）'))
  assert.ok(!txt.includes('rotate:'))
})

test('回忆：读到的陌生人的话和别人的回复，翻到时也说清来路（2026-11-04）', () => {
  const now = Date.now()
  const events = [
    { id: 'v', type: 'voice', ts: new Date(now - 3 * DAY).toISOString(), text: '评论别看了' },
    { id: 'an', type: 'answer', ts: new Date(now - 2 * DAY).toISOString(), text: '评论的事可以' },
    { id: 'r', type: 'revise', refs: ['v'], ts: new Date(now - DAY).toISOString(), text: '我不这么看' },
  ]
  const txt = renderRecall(searchEvents(events, '评论', { now }).rows)
  assert.ok(txt.includes('｜读到别人说：评论别看了（v）'))
  assert.ok(txt.includes('｜回复：评论的事可以（an）'))
  assert.ok(renderRecall(searchEvents(events, '不这么看', { now }).rows).includes('这句改的是：读到别人说：评论别看了（v）'))
})

test('回忆 brief 档：改口关系还在，只是不引对方的话，聊天原话也标着（2026-11-04）', () => {
  const now = Date.now()
  const events = [...revisedStream(now), { id: 'chat', type: 'utterance', flags: ['uncommitted'], ts: new Date(now - DAY).toISOString(), text: '下雨天顺口一句' }]
  const { rows } = searchEvents(events, '下雨天', { now, snippet: RECALL_BRIEF_SNIPPET })
  const lines = renderRecall(rows, { brief: true }).split('\n')
  assert.ok(lines.includes('  后来你推翻了这句（new）'))
  assert.ok(lines.includes('  这句推翻的是（old）'))
  assert.ok(lines.some((l) => l.includes('聊天时说的：下雨天顺口一句（chat）')))
  assert.ok(!lines.join('\n').includes('：下雨天我其实更想出门走走'))
})

test('回忆：推翻过的那条不再因为被引用加分，先改过再推翻也一样（2026-11-04）', () => {
  const now = Date.now()
  const ids = (events) => searchEvents(events, '下雨天', { now }).rows.map((r) => r.id)
  assert.deepEqual(ids(revisedStream(now)), ['new', 'calm', 'old'], '同样命中时按新旧排')
  const refinedFirst = [
    ...revisedStream(now),
    { id: 'r0', type: 'revise', verdict: 'refined', refs: ['old'], ts: new Date(now - 80 * DAY).toISOString(), text: '别的说法' },
    { id: 't0', type: 'test', refs: ['old'], ts: new Date(now - 70 * DAY).toISOString(), text: '别的检验' },
  ]
  assert.deepEqual(ids(refinedFirst), ['new', 'calm', 'old'])
  // 没被推翻的，被引用过仍然加分
  const refined = revisedStream(now).map((e) => (e.id === 'new' ? { ...e, verdict: 'refined' } : e))
  assert.equal(ids(refined)[0], 'old')
})

test('回忆：没认领的聊天原话排在同样命中的认领之后，并标明是聊天时说的（2026-11-04）', () => {
  const now = Date.now()
  const events = [
    { id: 'said', type: 'utterance', flags: [], ts: new Date(now - 9 * DAY).toISOString(), text: '评论这件事' },
    { id: 'chat', type: 'utterance', flags: ['uncommitted'], ts: new Date(now - DAY).toISOString(), text: '评论这件事' },
  ]
  const { rows } = searchEvents(events, '评论', { now })
  assert.deepEqual(rows.map((r) => r.id), ['said', 'chat'])
  assert.equal(rows[0].unclaimed, undefined)
  assert.equal(rows[1].unclaimed, true)
  const txt = renderRecall(rows)
  assert.ok(txt.includes('｜评论这件事（said）'))
  assert.ok(txt.includes('｜聊天时说的：评论这件事（chat）'))
  // 排查用的 weigh:false 还是纯字面 + 新旧
  assert.deepEqual(searchEvents(events, '评论', { now, weigh: false }).rows.map((r) => r.id), ['chat', 'said'])
  // 她问的那件事正好在聊天这句里：多中两个词就排在前面
  const closer = [
    { id: 'said', type: 'utterance', flags: [], ts: new Date(now - DAY).toISOString(), text: '今天下雨了' },
    { id: 'chat', type: 'utterance', flags: ['uncommitted'], ts: new Date(now - 2 * DAY).toISOString(), text: '下雨 发呆 窗户 我全想起来了' },
  ]
  assert.equal(searchEvents(closer, '下雨 发呆 窗户', { now }).rows[0].id, 'chat')
  // 聊天原话被引用过也不加分：一次确认不能抵掉那 1 分
  const referenced = [
    { id: 'said', type: 'utterance', flags: [], ts: new Date(now - 9 * DAY).toISOString(), text: '评论这件事' },
    { id: 'chat', type: 'utterance', flags: ['uncommitted'], ts: new Date(now - DAY).toISOString(), text: '评论这件事' },
    { id: 'r', type: 'revise', verdict: 'confirmed', refs: ['chat'], ts: new Date(now).toISOString(), text: '还成立' },
  ]
  assert.deepEqual(searchEvents(referenced, '评论', { now }).rows.map((r) => r.id), ['said', 'chat'])
})

test('回忆：一堆更新的聊天原话不会把她记下的那句挤出去（2026-11-04）', () => {
  const now = Date.now()
  const events = [
    { id: 'said', type: 'utterance', flags: [], ts: new Date(now - 30 * DAY).toISOString(), text: '评论这件事' },
    ...Array.from({ length: 20 }, (_, i) => ({
      id: `c${i}`, type: 'utterance', flags: ['uncommitted'], ts: new Date(now - i * 3600_000).toISOString(), text: '评论这件事',
    })),
  ]
  assert.equal(searchEvents(events, '评论', { now }).rows[0].id, 'said')
})

test('回忆：截断不把 emoji 切成半个（2026-11-04）', () => {
  const now = Date.now()
  const text = '评论' + '好'.repeat(RECALL_BRIEF_SNIPPET - 4) + '😀'.repeat(10)
  const events = [
    { id: 'o', type: 'utterance', ts: new Date(now - 2 * DAY).toISOString(), text },
    { id: 'n', type: 'revise', refs: ['o'], ts: new Date(now - DAY).toISOString(), text: '新说法' },
  ]
  const [row] = searchEvents(events, '新说法', { now }).rows
  assert.ok(row.earlier.text.isWellFormed())
  assert.ok(row.earlier.text.endsWith('…'))
  const body = searchEvents(events, '评论', { now, snippet: RECALL_BRIEF_SNIPPET }).rows[0]
  assert.ok(renderRecall([{ ...body, text }], { brief: true }).isWellFormed())
})

test('her_recall 走一遍工具：只给 found 和 text，改口关系也在（2026-11-04）', () => withRoot(async (root) => {
  const old = await appendEvent({ type: 'utterance', text: '我觉得下雨天最适合发呆' }, { day: 1, stage: 1, source: 'tool' }, root)
  const neu = await appendEvent({ type: 'revise', text: '下雨天我其实更想出门走走', refs: [old.id], verdict: 'refuted' }, { day: 1, stage: 1, source: 'tool' }, root)
  await appendEvent({ type: 'utterance', text: '下雨天顺口一句', flags: ['uncommitted'] }, { day: 1, stage: 1, source: 'system' }, root)
  let tool
  registerRecall({ tools: { register: (t) => { tool = t } } }, { root })
  const out = await tool.execute({ query: '下雨天' })
  assert.deepEqual(Object.keys(out).sort(), ['found', 'text'])
  assert.equal(out.found, true)
  assert.ok(out.text.includes(`  后来你推翻了这句，改说：下雨天我其实更想出门走走（${neu.id}）`))
  assert.ok(out.text.includes(`  这句推翻的是：我觉得下雨天最适合发呆（${old.id}）`))
  assert.ok(out.text.includes('聊天时说的：下雨天顺口一句'))
}))

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

test('上一个房间留的话：原话照引，并说清那是她自己说的', async () => {
  const { personaLine } = await import('../lib/persona.js')
  const line = personaLine(model(), { continuity: { lastWords: '你走的时候把窗关好。' } })
  assert.match(line, /## 上一个房间里，你自己留的最后一句/)
  assert.match(line, /「你走的时候把窗关好。」/)
  assert.match(line, /你只是接着往下过/)
})

test('pickLastWords：取第一行、去列表符号与引号、「不用」算没留', async () => {
  const { pickLastWords } = await import('../lib/home.js')
  assert.equal(pickLastWords('好。\n你下次早点回来。'), '好。')
  assert.equal(pickLastWords('- 「窗关好了。」'), '窗关好了。')
  assert.equal(pickLastWords('不用'), '')
  assert.equal(pickLastWords('算了。'), '')
  assert.equal(pickLastWords('   '), '')
  assert.equal(pickLastWords('不想留'), '')
  // 不是拒绝的长句要照收（别把"不用"当子串误杀）
  assert.equal(pickLastWords('不用等我吃饭，我先睡了。'), '不用等我吃饭，我先睡了。')
})

test('轮换时会问她，回的那句写进 home.json，新房间读得到', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-lastwords-'))
  try {
    const { writeAtomic, paths } = await import('../lib/store.js')
    const homeFile = join(paths(root).root, 'home.json')
    await writeAtomic(homeFile, JSON.stringify({ wsId: 'ws-1', sessionId: 'sess-old', turns: 40 }))

    const { rotateTalkSession } = await import('../lib/home.js')
    const { continuityOf } = await import('../lib/selfdoc.js')
    const handlers = []
    const ctx = {
      sessionController: {
        async create() { return { sessionId: 'sess-new' } },
        async rename() { return {} },
        // 她收到这句之后回一句：靠 pc 拿到 prompt 里那句话
        async prompt(arg) {
          queueMicrotask(() => {
            for (const h of handlers) {
              h({ header: { id: 'sess-old' } }, {
                type: 'assistant/message',
                data: { message: { id: 'a1', content: [{ type: 'text', text: '下次也要把灯关掉。' }] } },
              })
              h({ header: { id: 'sess-old' } }, { type: 'turn/end' })
            }
          })
          return {}
        },
      },
      on(name, fn) { if (name === 'session/event') handlers.push(fn); return () => {} },
      get() { return null },
    }
    const r = await rotateTalkSession(ctx, { root })
    assert.equal(r.ok, true)

    // 0.8.9 起这句话是**后台**回来再写的（轮换不等它，否则没有 turn/end 就被拖死），
    // 所以要等它落盘，不能转完身立刻断言。
    const saved = await (async () => {
      for (let i = 0; i < 200; i += 1) {
        const raw = JSON.parse(await readFile(homeFile, 'utf8'))
        if (raw.lastWords) return raw
        await new Promise((ok) => setTimeout(ok, 20))
      }
      return JSON.parse(await readFile(homeFile, 'utf8'))
    })()
    assert.equal(saved.lastWords, '下次也要把灯关掉。')
    // 轮换本身没有被这句话拖住：新会话已经接上了
    assert.equal(saved.sessionId, 'sess-new')
    assert.equal(saved.rotatedFrom, 'sess-old')
    const c = await continuityOf(root)
    assert.equal(c.lastWords, '下次也要把灯关掉。')
    assert.equal(c.rotatedDaysAgo, 0)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('没有 prompt 服务（或它抛错）时，轮换照样成功、lastWords 不留', async () => {
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
        async prompt() { throw new Error('宿主拒了') },
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

// ---------------------------------------------------------------- 配置

test('新配置项有默认值且能被夹住', () => {
  assert.equal(DEFAULTS.chat.rotateAfter, 40)
  assert.equal(DEFAULTS.memory.docBudget, 2400, '2026-10-25：1200 → 1800；2026-11-03：1800 → 2400（可选段变多，2000 仍挤掉打脸记录）')
  assert.equal(DEFAULTS.memory.sleepEveryDays, 7)
  const c = normalizeConfig({ chat: { rotateAfter: 9999 }, memory: { docBudget: 1, sleepEveryDays: 999 } })
  assert.equal(c.chat.rotateAfter, 500)
  assert.equal(c.memory.docBudget, 600)
  assert.equal(c.memory.sleepEveryDays, 60)
})

test('rotateAfter=0 表示永不换会话', () => {
  assert.equal(normalizeConfig({ chat: { rotateAfter: 0 } }).chat.rotateAfter, 0)
})

test('「想一想」的提示词不要求她总结人生', () => {
  const p = sleepPrompt(model({ beliefs: [{ id: 'b', text: '判断' }] }))
  assert.match(p, /这一周/)
  assert.match(p, /不要总结/)
  assert.match(p, /narration/)
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
