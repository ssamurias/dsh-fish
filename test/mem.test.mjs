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
import { searchEvents, tokensOf, renderRecall, RECALL_LIMIT, RECALL_BRIEF_SNIPPET } from '../lib/recall.js'
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

// ---------------------------------------------------------------- 配置

test('新配置项有默认值且能被夹住', () => {
  assert.equal(DEFAULTS.chat.rotateAfter, 40)
  assert.equal(DEFAULTS.memory.docBudget, 1800, '2026-10-25：1200 → 1800（可选段变多，塞不下了）')
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
