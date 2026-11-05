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
import { bumpTurns, rotateTalkSession, activeCarry, homeStatus, CARRY_TURNS, ROTATE_RETRY_MS } from '../lib/home.js'
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

// ---------------------------------------------------------------- 轮换失败

// 病历（2026-11-06，用户反馈的截图）：换会话失败时，那条「要不要给下一个房间
// 留一句话」已经先发出去、落在他正在用的会话窗口里了，而 turns 不归零，
// 下一轮结账又到点、又问一遍——他那边看到的就是「每回一句都弹这句」。
test('换会话失败时不许把「留一句话」问出去', async () => {
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
  const ev = (id, type, ts, text) => ({ id, type, ts: new Date(ts).toISOString(), text })
  const events = [
    ev('v', 'voice', now - 3 * DAY, '评论里有人这么说'),
    ev('a', 'answer', now - 2 * DAY, '评论我回过一句'),
    ev('h', 'heard', now - DAY, '评论他说的'),
  ]
  const txt = renderRecall(searchEvents(events, '评论', { now, solidIds: [] }).rows)
  assert.match(txt, /读到别人说：评论里有人这么说/)
  assert.match(txt, /回复：评论我回过一句/)
  assert.match(txt, /他说：评论他说的/)
})
