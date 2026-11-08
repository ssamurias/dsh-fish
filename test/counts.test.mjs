/**
 * counts.test.mjs —— 0.9.5 核对出来的计数与口径（接 issue #64 #66 #67）
 *
 * 每一条都从外面看行为：身份文档写了什么、路由回了什么、页面印了什么。
 *   1. 「总共留几条自述」真的进身份文档；记忆页「折成一行」和文档那一行同一个数
 *   2. 「记你原话的间隔」设成 0 时，群里主人本人的话也不记
 *   3. 白名单里没有 schedule_create 时，定时说明不教她新建，首行只说真放了的动作
 *   5. 每天醒 0 次 / 每天事件 0 条时，手动叫醒被拒的理由说的是「手动也叫不醒」
 *   6. 状态页的「认知矛盾」用总数；体检卡写清「共 N 处，列出前 3 处」
 *   7. 体检卡「冷掉」按最后一次提起或检验说
 *   8. 「日记留多久」删了旧文件，身份文档里写过几篇、从哪天起不跟着变
 *   9. 成长周期 14 天及以下时，界面写「一次」
 *  10. 弹幕说明不再说「前 8 条」
 *  12. 成长期过后，「下一个成长瓶颈」不指着已经过了或已兜底放行的那道；
 *      选卡仍然给第一道还没真过的门加权（立场清单只认真过的门）
 *   另：/state 的「稳定」按她真读到的那份身份文档量（同样带上「总共留几条自述」）；
 *      日记删过旧文件时，身份文档说清翻得到的是哪几篇；her_diary 和记忆页的篇数跟身份文档同一个口径；
 *      成长期满以后，状态页写清立场还在等哪道真过的门
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { paths, readEvents, writeConfig, pruneDiary } from '../lib/store.js'
import { normalizeConfig } from '../lib/settings.js'
import { deriveSelf } from '../lib/derive.js'
import { personaBudget } from '../lib/persona.js'
import { selfDocPath, writeSelfDoc } from '../lib/selfdoc.js'
import { rememberGroupWord } from '../lib/hear.js'
import { pick } from '../lib/generator.js'
import { CATALOG } from '../lib/events.js'
import { wakeNow } from '../lib/scheduler.js'
import { registerObserve } from '../lib/observe.js'
import { registerHerDiary } from '../lib/herdiary.js'
import { heardLine } from '../lib/use.js'

const DAY = 86_400_000
const iso = (ms) => new Date(ms).toISOString()

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fish-counts-'))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

let seq = 0
function line(type, text, ts, extra = {}) {
  seq += 1
  return { id: `ev_c${seq}`, type, text, ts: iso(ts), day: 1, stage: 1, source: type === 'seed' || type === 'meta' ? 'system' : 'tool', ...extra }
}

async function writeEvents(root, lines) {
  await mkdir(paths(root).root, { recursive: true })
  await writeFile(paths(root).events, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
}

const doc = (root) => readFile(selfDocPath(root), 'utf8')
const earlier = (text) => {
  const i = text.indexOf('## 更早以前')
  if (i < 0) return ''
  const j = text.indexOf('\n## ', i + 1)
  return j < 0 ? text.slice(i) : text.slice(i, j)
}

// ---------------------------------------------------------------- 假的观测台

function fakeObserveCtx() {
  const routes = []
  const ctx = {
    get: (k) => (k === 'connection'
      ? { requestRejection: () => null }
      : k === 'webServer'
        ? { register: (def) => { routes.push(def); return () => {} } }
        : undefined),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }
  return { ctx, routes }
}

async function call(root, path, method = 'GET') {
  const { ctx, routes } = fakeObserveCtx()
  registerObserve(ctx, { root, version: '0.0.0-test', tenancy: { tenant: { ok: true, instanceId: 'me' } } })
  const route = routes.find((r) => String(r.path || '').endsWith(path))
  assert.ok(route, `必须有 ${path} 路由`)
  let status = 0
  let body = ''
  const res = { writeHead: (s) => { status = s }, setHeader: () => {}, end: (s) => { body = String(s ?? '') } }
  await route.handler({ method, url: route.path, headers: {} }, res)
  return { status, json: body ? JSON.parse(body) : null }
}

// 20 句互不相像的话：彼此不算提起，也不构成矛盾
const TWENTY = [
  '下雨天的窗户上有很多条水路',
  '早上那杯咖啡总是放到凉了才想起来喝',
  '旧书店里的灰尘闻起来像纸做的时间',
  '地铁末班车上的人都很安静',
  '猫在纸箱里待着就不想出来',
  '冬天晒被子能闻到太阳的味道',
  '手写的字比打出来的更难假装',
  '夜市的灯一亮整条街都变了脾气',
  '海边的风把所有声音都吹远了',
  '做饭最难的是掌握火候',
  '老歌听到第三遍才听出副歌',
  '公园长椅上总有人在等谁',
  '写日记的时候会对自己更诚实一点',
  '山顶看日出要比想象中冷得多',
  '超市打折区能看出一个城市的口味',
  '下棋输了以后反而更想再来一盘',
  '图书馆闭馆前的十分钟最好找座位',
  '骑车下坡的时候不想刹车',
  '电影散场时灯亮得太快了',
  '春天的第一场雷来得没有预兆',
]

async function twentyBeliefs(root, memory) {
  const t0 = Date.now() - 3 * DAY
  await writeEvents(root, [
    line('seed', '你不是助手。', t0),
    ...TWENTY.map((text, i) => line('utterance', text, t0 + (i + 1) * 60_000)),
  ])
  await writeConfig(normalizeConfig({ memory }), root)
}

// ---------------------------------------------------------------- 1

test('第 1 条：「总共留几条自述」真的改身份文档，「更早以前」跟设置走', async () => {
  await withRoot(async (root) => {
    await twentyBeliefs(root, { beliefsShown: 3, sleepKeep: 0 })
    assert.equal((await writeSelfDoc(root)).ok, true)
    assert.match(earlier(await doc(root)), /还有 14 条更早的/, '不限制时 17 条更早的：点名 3 条、14 条只报数')

    // 留 5 条、眼前 3 条：更早的只点名 2 条，另外 15 条只报数
    await writeConfig(normalizeConfig({ memory: { beliefsShown: 3, sleepKeep: 5 } }), root)
    const w5 = await writeSelfDoc(root)
    assert.equal(w5.changed, true, '改了「总共留几条」，身份文档要跟着变')
    assert.match(earlier(await doc(root)), /还有 15 条更早的/, earlier(await doc(root)))

    // 设得比眼前条数还小：一条都不点名，17 条都只报数
    await writeConfig(normalizeConfig({ memory: { beliefsShown: 3, sleepKeep: 2 } }), root)
    assert.equal((await writeSelfDoc(root)).changed, true)
    const e2 = earlier(await doc(root))
    assert.match(e2, /还有 17 条更早的/, e2)
    for (const t of TWENTY) assert.ok(!e2.includes(t), `上限 2 时「更早以前」不该再点名：${t}`)
  })
})

test('第 1 条：记忆页「折成一行」的条数和预算用量跟身份文档同一个口径', async () => {
  await withRoot(async (root) => {
    await twentyBeliefs(root, { beliefsShown: 3, sleepKeep: 12 })
    const { status, json } = await call(root, '/memory')
    assert.equal(status, 200)
    assert.equal(json.sections.beliefsShown, 3)
    // 文档那一行盖着眼前 3 条以外的全部 17 条（点名的和只报数的都在同一行）
    assert.equal(json.sections.beliefsFolded, 17, `折成一行的应是 17 条，实际 ${json.sections.beliefsFolded}`)
    assert.equal(json.sections.beliefsDropped, 8)

    // 预算用量要按设了上限之后的那一行算
    await writeConfig(normalizeConfig({ memory: { beliefsShown: 3, sleepKeep: 2 } }), root)
    const r2 = await call(root, '/memory')
    const { events } = await readEvents(root)
    const model = deriveSelf(events, { growthDays: 30 })
    const want = personaBudget(model, { budget: r2.json.selfDoc.budget, withBans: true, shown: 3, sleepKeep: 2 }).used
    const loose = personaBudget(model, { budget: r2.json.selfDoc.budget, withBans: true, shown: 3 }).used
    assert.notEqual(want, loose, '前提：上限 2 时那一行确实变短了')
    assert.equal(r2.json.selfDoc.chars, want, '记忆页的字数要和身份文档里那一段一样长')
    assert.equal(r2.json.sections.beliefsFolded, 17)
  })
})

test('第 1 条：状态页的「稳定」量的是她真读到的那份身份文档，「总共留几条自述」也算进去', async () => {
  await withRoot(async (root) => {
    const twelve = TWENTY.slice(0, 12)
    const t0 = Date.now() - 3 * DAY
    await writeEvents(root, [
      line('seed', '你不是助手。', t0),
      ...twelve.map((text, i) => line('utterance', text, t0 + (i + 1) * 60_000)),
    ])
    await writeConfig(normalizeConfig({ memory: { beliefsShown: 3, sleepKeep: 2 } }), root)
    await writeSelfDoc(root)
    const text = await doc(root)
    const inDoc = twelve.filter((t) => text.includes(t)).length
    assert.equal(inDoc, 3, `前提：上限 2、眼前 3 条时，身份文档里只看得到眼前那 3 条，实际 ${inDoc}`)
    const st = await call(root, '/state')
    assert.equal(st.status, 200)
    // 抽样池就是「这会儿真写进自我描述的几条」：要和她真读到的那份对得上
    assert.equal(st.json.quality.stability.visible, inDoc, `稳定的抽样池按 ${st.json.quality.stability.visible} 条算，她读到的只有 ${inDoc} 条`)
  })
})

test('第 1 条：事件流没变、只改了「总共留几条自述」，状态页的「稳定」不拿改之前的缓存', async () => {
  await withRoot(async (root) => {
    const twelve = TWENTY.slice(0, 12)
    const t0 = Date.now() - 3 * DAY
    await writeEvents(root, [
      line('seed', '你不是助手。', t0),
      ...twelve.map((text, i) => line('utterance', text, t0 + (i + 1) * 60_000)),
    ])
    const seen = []
    for (const sleepKeep of [2, 0]) {
      await writeConfig(normalizeConfig({ memory: { beliefsShown: 3, sleepKeep } }), root)
      await writeSelfDoc(root)
      const text = await doc(root)
      const inDoc = twelve.filter((t) => text.includes(t)).length
      const st = await call(root, '/state')
      seen.push(inDoc)
      assert.equal(st.json.quality.stability.visible, inDoc, `sleepKeep=${sleepKeep}：抽样池按 ${st.json.quality.stability.visible} 条算，她读到的是 ${inDoc} 条`)
    }
    assert.notEqual(seen[0], seen[1], `前提：两种设置下她读到的条数不一样（${seen.join(' / ')}）`)
  })
})

// ---------------------------------------------------------------- 2

test('第 2 条：「记你原话的间隔」为 0 时，群里主人本人的话也不记', async () => {
  await withRoot(async (root) => {
    await writeConfig(normalizeConfig({ memory: { hearEvery: 0 } }), root)
    // 收消息那条路（turns.js）不带 config，要自己读
    const a = await rememberGroupWord(root, { text: '今天下午我去河边走了一圈，风很大', sessionId: 'g1' })
    assert.equal(a.written, false, JSON.stringify(a))
    assert.equal(a.why, 'off')
    // /say 那条路带着 config
    const b = await rememberGroupWord(root, { text: '今天下午我去河边走了一圈，风很大', sessionId: 'g1', config: { memory: { hearEvery: 0 } } })
    assert.equal(b.written, false)
    const { events } = await readEvents(root)
    assert.equal(events.filter((e) => e.type === 'heard').length, 0, '设置写着「0 为不记」，群里也不能记')

    // 对照：不是 0 时照记（群聊不涨轮数，不按间隔跳）
    await writeConfig(normalizeConfig({ memory: { hearEvery: 5 } }), root)
    const c = await rememberGroupWord(root, { text: '今天下午我去河边走了一圈，风很大', sessionId: 'g1' })
    assert.equal(c.written, true)
  })
})

// ---------------------------------------------------------------- 3

test('第 3 条：白名单里没有 schedule_create 时，定时说明不教她新建，首行只说真放了的动作', async () => {
  await withRoot(async (root) => {
    await writeEvents(root, [line('seed', '你不是助手。', Date.now() - DAY)])
    const cases = [
      [['schedule_delete'], '可以删已经定好的提醒'],
      [['schedule_list'], '可以看已经定好的提醒'],
      [['schedule_list', 'schedule_update'], '可以看、改已经定好的提醒'],
      [['schedule_list', 'schedule_update', 'schedule_delete'], '可以看、改、删已经定好的提醒'],
    ]
    for (const [allow, head] of cases) {
      await writeConfig(normalizeConfig({ tools: { allow } }), root)
      await writeSelfDoc(root)
      const text = await doc(root)
      assert.ok(text.includes(head), `放 ${allow.join(',')} 时首行应说「${head}」`)
      assert.ok(!text.includes('明天中午提醒我'), `没有 schedule_create（${allow.join(',')}）就不该教她听到这类话去新建`)
      assert.ok(!text.includes('一件具体的事定一条就够'), `没有 schedule_create（${allow.join(',')}）就不该教她怎么定`)
      assert.ok(text.includes('定时消息'), '到点来的是什么，照样要说')
    }
    // 有 create 时新建的用法照旧在
    await writeConfig(normalizeConfig({ tools: { allow: ['schedule_create'] } }), root)
    await writeSelfDoc(root)
    const withCreate = await doc(root)
    assert.ok(withCreate.includes('明天中午提醒我'))
    assert.ok(withCreate.includes('可以自己给自己定定时提醒'))
  })
})

// ---------------------------------------------------------------- 5

test('第 5 条：设成 0 时手动叫醒被拒，理由说的是手动也叫不醒', async () => {
  for (const [cfg, wrong] of [
    [{ wakesPerDay: 0 }, /只有你叫她/],
    [{ daily: { events: 0 } }, /今天不派活/],
  ]) {
    await withRoot(async (root) => {
      await writeEvents(root, [line('seed', '你不是助手。', Date.now() - DAY)])
      await writeConfig(normalizeConfig({ browse: { enabled: false }, ...cfg }), root)
      const r = await wakeNow({}, { root })
      assert.equal(r.ok, false, JSON.stringify(r))
      assert.doesNotMatch(String(r.why), wrong, `人正在叫，理由不能这么说：${r.why}`)
      assert.match(String(r.why), /手动/, `要说清手动也叫不醒：${r.why}`)

      // 界面拿到的 error 就是这句
      const w = await call(root, '/wake', 'POST')
      assert.equal(w.status, 409)
      assert.doesNotMatch(String(w.json.error), wrong)
      assert.match(String(w.json.error), /手动/)
    })
  }
})

// ---------------------------------------------------------------- 6

const PAIRS = [
  ['我喜欢下雨天出去走走', '我不喜欢下雨天出去走走'],
  ['我喜欢早上起来先喝一杯咖啡', '我不喜欢早上起来先喝一杯咖啡'],
  ['我喜欢一个人去电影院看电影', '我不喜欢一个人去电影院看电影'],
  ['我喜欢听节奏很快的吵闹音乐', '我不喜欢听节奏很快的吵闹音乐'],
  ['我喜欢半夜坐在窗边写东西', '我不喜欢半夜坐在窗边写东西'],
]

test('第 6 条：状态页的「认知矛盾」和记忆页同一个数，不被截成 3', async () => {
  await withRoot(async (root) => {
    const t0 = Date.now() - 3 * DAY
    await writeEvents(root, [
      line('seed', '你不是助手。', t0),
      ...PAIRS.flatMap(([a, b], i) => [line('utterance', a, t0 + (2 * i + 1) * 60_000), line('utterance', b, t0 + (2 * i + 2) * 60_000)]),
    ])
    const mem = await call(root, '/memory')
    assert.equal(mem.json.sections.tensions, 5, '前提：一共 5 处对不上')
    const st = await call(root, '/state')
    assert.equal(st.json.tension.count, 5, `状态页要印总数，实际 ${st.json.tension.count}`)
  })
})

// ---------------------------------------------------------------- 12

test('第 12 条：成长期过后，下一个成长瓶颈不指着已经过了的那道', () => {
  const now = Date.now()
  const evs = [
    line('seed', '你不是助手。', now - 40 * DAY),
    line('utterance', '下雨天的窗户上有很多条水路', now - 30 * DAY),
    line('utterance', '旧书店里的灰尘闻起来像纸做的时间', now - 20 * DAY),
  ]
  evs.push(line('revise', '下雨天的窗户上其实只有一条水路', now - 10 * DAY, { verdict: 'refined', refs: [evs[1].id] }))
  evs.push(line('revise', '旧书店的灰尘闻起来像旧报纸', now - 5 * DAY, { verdict: 'refined', refs: [evs[2].id] }))
  const m = deriveSelf(evs, { growthDays: 30, now })
  assert.deepEqual(m.stageGate.passed, ['trust', 'competence'], '前提：信任和主动过了')
  assert.deepEqual(m.stageGate.forced, ['autonomy'], '前提：自主是时间兜底放行的')
  assert.notEqual(m.stageGate.pending, 'competence', '「主动」已经过了，不能还是下一个瓶颈')
  assert.equal(m.stageGate.pending, null, '没过的都放行了，就没有下一个')
})

test('第 12 条：成长期过后，选卡仍然给第一道还没真过的门加权', () => {
  const now = Date.now()
  const cfg = normalizeConfig({})
  const today = { dateKey: iso(now).slice(0, 10), sent: 0, questions: 0, proactive: 0 }
  // 只留三张卡：不推门的 why_here（信任门早过了）、推自主的 say_no、推主动的 test_first。
  // 不加权时 why_here 分最高（一次性的卡在阶段末尾先用掉）；推门的卡加了权才排到它前面。
  const keep = ['why_here', 'say_no', 'test_first']
  const fired = CATALOG.filter((t) => !keep.includes(t.id)).map((t) => line('meta', `fired:${t.id}`, now - 60_000))
  const top = (evs) => {
    const m = deriveSelf(evs, { growthDays: 30, now })
    return { gate: m.stageGate, id: pick(m, cfg, today, [...evs, ...fired], { now })?.template?.id }
  }

  // 信任、自主真过了，主动是时间兜底放行的：立场清单还在等主动，推主动的卡要往前摆
  const a = top([
    line('seed', '你不是助手。', now - 40 * DAY),
    line('utterance', '下雨天的窗户上有很多条水路', now - 30 * DAY),
    line('refusal', '我不替你写那份周报，这件事我不做。', now - 20 * DAY),
    line('refusal', '我不帮你删那些聊天记录，这件事我不做。', now - 15 * DAY),
  ])
  assert.deepEqual(a.gate.passed, ['trust', 'autonomy'], '前提：信任、自主过了')
  assert.deepEqual(a.gate.forced, ['competence'], '前提：主动是兜底放行的')
  assert.equal(a.gate.pending, null, '给人看的「下一个成长瓶颈」仍然没有')
  assert.equal(a.id, 'test_first', `期满以后推主动的卡仍要加权，实际选了 ${a.id}`)

  // 信任、主动真过了，自主是兜底放行的：加权给自主，不给已经过了的主动
  const evs = [
    line('seed', '你不是助手。', now - 40 * DAY),
    line('utterance', '下雨天的窗户上有很多条水路', now - 30 * DAY),
    line('utterance', '旧书店里的灰尘闻起来像纸做的时间', now - 20 * DAY),
  ]
  evs.push(line('revise', '下雨天的窗户上其实只有一条水路', now - 10 * DAY, { verdict: 'refined', refs: [evs[1].id] }))
  evs.push(line('revise', '旧书店的灰尘闻起来像旧报纸', now - 5 * DAY, { verdict: 'refined', refs: [evs[2].id] }))
  const b = top(evs)
  assert.deepEqual(b.gate.passed, ['trust', 'competence'], '前提：信任、主动过了')
  assert.deepEqual(b.gate.forced, ['autonomy'], '前提：自主是兜底放行的')
  assert.equal(b.id, 'say_no', `该推的是还没真过的自主，不是已经过了的主动，实际选了 ${b.id}`)
})

// ---------------------------------------------------------------- 8

test('第 8 条：「日记留多久」删了旧文件，身份文档里写过几篇、从哪天起不跟着变', async () => {
  await withRoot(async (root) => {
    const today = '2026-11-09'
    const base = Date.parse(`${today}T12:00:00Z`)
    const dates = Array.from({ length: 120 }, (_, i) => iso(base - (119 - i) * DAY).slice(0, 10))
    await mkdir(paths(root).diaryDir, { recursive: true })
    for (const d of dates) await writeFile(join(paths(root).diaryDir, `${d}.md`), `${d} 的日记`)
    await writeEvents(root, [
      line('seed', '你不是助手。', base - 130 * DAY),
      ...dates.map((d, i) => line('meta', `diary:${d}`, base - (119 - i) * DAY)),
    ])
    await writeConfig(normalizeConfig({ diary: { keepDays: 30 } }), root)
    await pruneDiary(30, today, root)
    const left = (await readdir(paths(root).diaryDir)).length
    assert.ok(left < 40, `前提：旧文件被删掉了，还剩 ${left} 个`)

    await writeSelfDoc(root)
    const text = await doc(root)
    assert.ok(text.includes(`你自己写过 120 篇日记，从 ${dates[0]} 到 ${today}`), text.match(/你自己写过[^\n]*/)?.[0])
    // 起始那几天的文件已经删了：要说清翻得到的是哪几篇，不然她按最早那天去翻会落空
    const keptFirst = (await readdir(paths(root).diaryDir)).map((n) => n.slice(0, 10)).sort()[0]
    assert.ok(text.includes(`现在翻得到的是从 ${keptFirst} 起的 ${left} 篇，更早的翻不到了。`), text.match(/## 这些天[\s\S]*?\n\n/)?.[0])
  })
})

// ---------------------------------------------------------------- 9（服务端那半）

test('第 9 条：状态里给出每道瓶颈要几次，界面不用自己抄阈值', async () => {
  await withRoot(async (root) => {
    await writeEvents(root, [line('seed', '你不是助手。', Date.now() - DAY)])
    await writeConfig(normalizeConfig({ growthDays: 7 }), root)
    const short = await call(root, '/state')
    assert.deepEqual(short.json.gateTimes, { belief: 1, refuse: 1, revise: 1 })
    await writeConfig(normalizeConfig({ growthDays: 30 }), root)
    const long = await call(root, '/state')
    assert.deepEqual(long.json.gateTimes, { belief: 1, refuse: 2, revise: 2 })
  })
})

// ---------------------------------------------------------------- 界面（真的渲染一次）

const CLIENT = new URL('../lib/client.js', import.meta.url)

function fakeReact(initialState = {}) {
  let cursor = 0
  const h = (type, props, ...children) => ({
    type,
    props: props || {},
    children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false),
  })
  return {
    createElement: h,
    useState: (init) => {
      const idx = cursor++
      return [idx in initialState ? initialState[idx] : (typeof init === 'function' ? init() : init), () => {}]
    },
    useCallback: (fn) => fn,
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: (init) => ({ current: init }),
    resetCursor() { cursor = 0 },
  }
}

/** 页面上看得见的字，连同悬停提示（title） */
function textOf(node, out = []) {
  if (node == null || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const n of node) textOf(n, out); return out }
  if (typeof node.props?.title === 'string') out.push(node.props.title)
  if (node.children) for (const c of node.children) textOf(c, out)
  return out
}

/**
 * 按名字给组件塞状态：FishSection 里 useState 的先后顺序就是下标。
 * 名字从源码里按顺序读出来，只用来找下标；断言看的是渲染出来的字。
 */
async function render(named) {
  const src = await readFile(CLIENT, 'utf8')
  const body = src.slice(src.indexOf('function FishSection()'))
  const names = [...body.matchAll(/const \[(\w*), *\w+\] = useState\(/g)].map((m) => m[1])
  assert.equal(names.length, (body.match(/useState\(/g) || []).length, '每个 useState 都要能对上名字')
  const init = {}
  for (const [k, v] of Object.entries(named)) {
    const i = names.indexOf(k)
    assert.ok(i >= 0, `组件里没有叫 ${k} 的状态`)
    init[i] = v
  }
  const react = fakeReact(init)
  const loaded = []
  const window = { __ModuleLoader__: { load(spec) { loaded.push(spec) } } }
  const document = { querySelector: () => null, createElement: () => ({ setAttribute() {}, textContent: '' }), head: { appendChild() {} } }
  const req = (id) => { if (id === 'react') return react; throw new Error(`unexpected require: ${id}`) }
  new Function('window', 'require', 'document', src)(window, req, document)
  const exports = loaded[0].factory(req)
  react.resetCursor()
  return textOf(exports.FishSection()).join('\n')
}

function stateWith(extra = {}) {
  return {
    day: 3, growthDays: 30, stage: 1, stageName: '信任', stageForced: false,
    pendingGate: null, name: null, beliefCount: 1, absenceDays: 0,
    counts: { utterance: 1, revise: 0, refusal: 0, reunion: 0, total: 1 },
    quality: { stability: 0, consistency: 1, novelty: 0 },
    config: { window: ['20:00', '23:00'], daily: { events: 1, questions: 1 }, diary: {}, absenceAfterDays: 3 },
    ...extra,
  }
}

test('第 6、7 条：体检卡写清只列了前几处；「冷掉」按没再提起或检验的天数说', async () => {
  const health = {
    ok: true, empty: false, events: 40, days: 200, beliefs: 12, solid: 0,
    tensionsTotal: 5,
    tensions: [
      { a: '我喜欢下雨天出去走走', b: '我不喜欢下雨天出去走走', sim: 0.9 },
      { a: '我喜欢早上起来先喝一杯咖啡', b: '我不喜欢早上起来先喝一杯咖啡', sim: 0.9 },
      { a: '我喜欢半夜坐在窗边写东西', b: '我不喜欢半夜坐在窗边写东西', sim: 0.9 },
    ],
    stale: [{ text: '旧书店里的灰尘闻起来像纸做的时间', since: iso(Date.now() - 200 * DAY), days: 100, faded: true }],
    nearSolid: [], byType: [], staleDays: 21,
  }
  const txt = await render({ state: stateWith(), tab: 'memory', health })
  assert.ok(txt.includes('共 5 处，列出前 3 处'), '总数比列出来的多时，两个数都要写')
  assert.ok(!txt.includes('列出 5 处'), '底下只有 3 行，不能说列出 5 处')
  assert.ok(txt.includes('100 天没再提起或检验'), '天数是从最后一次提起或检验算的')
  assert.ok(!txt.includes('天前说的'), '那句是 200 天前说的，不能印成 100 天前说的')
  assert.ok(!/说出来 \d+ 天以上/.test(txt))

  // 列得下的时候只说列出几处
  const few = await render({ state: stateWith(), tab: 'memory', health: { ...health, tensionsTotal: 3 } })
  assert.ok(few.includes('列出 3 处') && !few.includes('列出前'))
})

test('第 9 条：成长周期 14 天及以下时，界面写「一次」；30 天仍写「两次」', async () => {
  const short = stateWith({ growthDays: 7, pendingGate: 'autonomy', gateTimes: { belief: 1, refuse: 1, revise: 1 } })
  const now7 = await render({ state: short, tab: 'now' })
  assert.ok(now7.includes('2 自主 · 说过至少一次「不要」'), '阶段说明要跟着门槛变')
  assert.ok(now7.includes('自主：得真的拒绝过一次'), '瓶颈说明要跟着门槛变')
  assert.ok(!now7.includes('至少两次') && !now7.includes('拒绝过两次'))
  const grow7 = await render({ state: short, tab: 'grow' })
  assert.ok(grow7.includes('3 主动 · 推翻过一次自己之前的判断'))
  assert.ok(!grow7.includes('两次推翻'))
  assert.ok(grow7.includes('14 天及以下时，自主、主动两道瓶颈各只要一次'), '成长周期的说明要提到这一点')

  const long = stateWith({ pendingGate: 'competence', gateTimes: { belief: 1, refuse: 2, revise: 2 } })
  const now30 = await render({ state: long, tab: 'now' })
  assert.ok(now30.includes('2 自主 · 说过至少两次「不要」'))
  assert.ok(now30.includes('主动：得两次推翻'))

  const principle = await render({ state: short, tab: 'principle' })
  assert.ok(principle.includes('14 天及以下时，自主和主动各一次就够'), '原理页也要说')
})

test('第 12 条：成长期满、有瓶颈是时间兜底放行的，不说「三道瓶颈都过了」', async () => {
  const txt = await render({ state: stateWith({ day: 41, stage: 4, stageName: '整合', stageForced: true, pendingGate: null }), tab: 'now' })
  assert.ok(txt.includes('期满放行'), '值那一格也要看得出是按时间放行的')
  assert.ok(!txt.includes('已走完'), '不看悬停提示的人会把「已走完」读成她都走完了')
  assert.ok(!txt.includes('三道瓶颈都过了'), '自主是兜底放行的，不是她过了')
  assert.ok(txt.includes('没过的瓶颈按时间放行了'))
})

test('第 10 条：弹幕说明不再说「前 8 条」', async () => {
  const txt = await render({ state: stateWith(), tab: 'bili' })
  assert.ok(txt.includes('每条读几条弹幕'), '前提：渲染到了上网页')
  assert.ok(!txt.includes('前 8 条'), '现在是等距挑 8 条，不是前 8 条')
  assert.ok(txt.includes('等距挑'))
})

test('第 2 条：设置说明写清 0 时群聊里也不记，群聊不按间隔', async () => {
  const txt = await render({ state: stateWith(), tab: 'memory' })
  assert.ok(txt.includes('记你原话的间隔'), '前提：渲染到了记忆页')
  assert.ok(txt.includes('0 为不记，群聊里也一样'))
  assert.ok(txt.includes('群聊不按间隔'), '不为 0 时群里每条都记，不能让人以为群聊也按间隔')
})

// ---------------------------------------------------------------- 8（her_diary 和记忆页那半）

/** 抓注册出来的 her_diary，直接调 execute */
function herDiary(root) {
  let def = null
  registerHerDiary({ tools: { register: (d) => ((def = d), d) } }, { root })
  return def
}

/** 120 天每天一篇、事件流各一条 diary: 记录，再按 30 天清一遍 */
async function prunedDiaries(root) {
  const today = '2026-11-09'
  const base = Date.parse(`${today}T12:00:00Z`)
  const dates = Array.from({ length: 120 }, (_, i) => iso(base - (119 - i) * DAY).slice(0, 10))
  await mkdir(paths(root).diaryDir, { recursive: true })
  for (const d of dates) await writeFile(join(paths(root).diaryDir, `${d}.md`), `${d} 的日记`)
  await writeEvents(root, [
    line('seed', '你不是助手。', base - 130 * DAY),
    ...dates.map((d, i) => line('meta', `diary:${d}`, base - (119 - i) * DAY)),
  ])
  await writeConfig(normalizeConfig({ diary: { keepDays: 30 } }), root)
  await pruneDiary(30, today, root)
  const kept = (await readdir(paths(root).diaryDir)).map((n) => n.slice(0, 10)).sort()
  assert.ok(kept.length < 40, `前提：旧文件被删掉了，还剩 ${kept.length} 个`)
  return { dates, kept }
}

test('第 8 条：her_diary 说的「一共写过几篇」跟身份文档同一个数，翻到清掉的那天说清是写过的', async () => {
  await withRoot(async (root) => {
    const { dates, kept } = await prunedDiaries(root)
    const t = herDiary(root)

    // 不给日期：读最近那篇，坐标里的篇数按写过的算，并说清翻得到几篇
    const latest = await t.execute({})
    assert.equal(latest.found, true)
    assert.ok(!latest.text.includes(`你一共写过 ${kept.length} 篇`), `只数了还留着的文件：${latest.text}`)
    assert.ok(latest.text.includes(`你一共写过 120 篇，现在翻得到的有 ${kept.length} 篇`), latest.text)
    // 和身份文档同一个数：她两边都看得见
    await writeSelfDoc(root)
    assert.ok((await doc(root)).includes('你自己写过 120 篇日记'), '身份文档说的也是 120 篇')

    // 翻一个已经清掉的日子：是写过的，不是「那天没有日记」
    const gone = await t.execute({ date: dates[0] })
    assert.equal(gone.found, false)
    assert.ok(!gone.text.includes('那天没有日记'), gone.text)
    assert.ok(gone.text.includes(`${dates[0]} 那天你写过日记，那一篇已经清掉了`), gone.text)
    assert.ok(gone.text.includes(`现在翻得到的是从 ${kept[0]} 起的 ${kept.length} 篇`), gone.text)
    // 记进她的工具账的那一句也不能说「那天没有日记」
    assert.notEqual(heardLine(gone, 'her_diary'), '那天没有日记。')

    // 真没写过的日子照旧
    const never = await t.execute({ date: '2026-01-01' })
    assert.match(never.text, /2026-01-01 那天没有日记/)

    // 日期清单：标题说清写过几篇、列的是翻得到的
    const list = await t.execute({ list: true })
    const head = list.text.split('\n')[0]
    assert.ok(head.includes('你一共写过 120 篇日记') && head.includes(`现在翻得到的有 ${kept.length} 篇`), head)
    assert.ok(!list.text.includes(`- ${dates[0]}`), '清掉的日子不列：列了她也翻不开')

    // 一篇都没留下：不能说「还没写过日记」
    for (const d of kept) await rm(join(paths(root).diaryDir, `${d}.md`))
    const none = await t.execute({})
    assert.equal(none.found, false)
    assert.ok(!none.text.includes('还没写过日记'), none.text)
    assert.ok(none.text.includes('一共写过 120 篇日记，现在一篇也翻不到了'), none.text)
  })
})

test('第 8 条：记忆页的日记篇数也写出写过几篇', async () => {
  await withRoot(async (root) => {
    const { kept } = await prunedDiaries(root)
    const { status, json } = await call(root, '/memory')
    assert.equal(status, 200)
    assert.equal(json.diaries, kept.length, '现存的文件数照旧')
    assert.equal(json.diariesWritten, 120, '写过几篇跟身份文档同一个数')

    const txt = await render({ state: stateWith(), tab: 'memory', mem: json })
    assert.ok(txt.includes(`日记 ${kept.length} 篇（一共写过 120 篇`), txt.match(/· 记录：[^\n]*/)?.[0])
  })
})

// ---------------------------------------------------------------- 12（状态页那半）

test('第 12 条：成长期满以后，状态页写清立场还在等哪道真过的门', async () => {
  await withRoot(async (root) => {
    const now = Date.now()
    // 信任、自主真过了，主动是按时间放行的
    await writeEvents(root, [
      line('seed', '你不是助手。', now - 40 * DAY),
      line('utterance', '下雨天的窗户上有很多条水路', now - 30 * DAY),
      line('refusal', '我不替你写那份周报，这件事我不做。', now - 20 * DAY),
      line('refusal', '我不帮你删那些聊天记录，这件事我不做。', now - 15 * DAY),
    ])
    await writeConfig(normalizeConfig({ growthDays: 30 }), root)
    const st = await call(root, '/state')
    assert.equal(st.status, 200)
    assert.equal(st.json.stageForced, true, '前提：有瓶颈是按时间放行的')
    assert.deepEqual(st.json.forcedGates, ['revise'], '主动是放行的，立场还在等它')
    assert.equal(st.json.pendingGate, null)

    // 拿这份真的状态渲染一次
    const txt = await render({ state: st.json, tab: 'now' })
    assert.ok(txt.includes('期满放行（立场还等她真过「主动」）'), txt.match(/期满放行[^\n]*/)?.[0])
    assert.ok(txt.includes('立场清单只认她真过的瓶颈，还在等「主动」'), '悬停提示也要说')
    assert.ok(txt.includes('按时间放行的瓶颈不算走完，还差「主动」'), '「立场 · 还没开始」的提示要说缺哪一道')
    assert.ok(!txt.includes('还差「自主」'), '自主是真过了的')
  })
})
