import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, name, inject, VERSION } from '../lib/index.js'
import { readEvents, paths, writeConfig, appendEvent } from '../lib/store.js'
import { normalizeConfig } from '../lib/settings.js'
import { deriveSelf } from '../lib/derive.js'
import { startScheduler, wakeNow, wakeTimeLine, shouldLogSkip } from '../lib/scheduler.js'
import { rememberKnownTools } from '../lib/restrict.js'
import { dateKey } from '../lib/settings.js'
import { writeSelfDoc } from '../lib/selfdoc.js'
import { clearWakeSection, getWakeSection } from '../lib/identity.js'
import { logFile, logLine } from '../lib/log.js'

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fish-boot-'))
  // 2026-10-29：不隔离的话 apply() 里的 noteRoot 会往**真实**的家谱
  // （~/.dsh-fish-homes.json）写临时家。那天全量测试灌进去 20 个
  // Temp\fish-boot-*，之后每次真启动都把最后一条临时家当成「上次的家」，
  // 于是每次启动都记一条假「家换了」，还往她的事件流里写假 meta。
  // 用例自己带一本账，finally 一定还回去（并发跑别的用例时也不串）。
  const oldHomes = process.env.DSH_FISH_HOMES
  process.env.DSH_FISH_HOMES = join(root, 'homes.json')
  try {
    return await fn(root)
  } finally {
    if (oldHomes === undefined) delete process.env.DSH_FISH_HOMES
    else process.env.DSH_FISH_HOMES = oldHomes
    // Windows 上插件里的定时器/写盘可能在用例结束的瞬间还没收尾，直接 rm 会
    // 撞 ENOTEMPTY（CI 的 windows-latest 就是这么红的）。maxRetries 让 Node 在
    // EBUSY / ENOTEMPTY / EPERM 上线性退避重试，断言本身一条没放松。
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

/** 假宿主：tools / webServer / connection / sessionController / logger 全套 */
function fakeCtx({ allow = true, promptImpl } = {}) {
  const tools = new Map()
  const routes = []
  const prompts = []
  const sessions = new Set()
  const creates = []
  const ctx = {
    tools: { register: (spec) => { tools.set(spec.name, spec); return () => tools.delete(spec.name) } },
    webServer: { register: (r) => { routes.push(r); return () => {} } },
    connection: { requestRejection: () => (allow ? null : { status: 403, message: 'blocked' }) },
    sessionController: {
      async create({ sessionId, cwd }) { creates.push({ sessionId, cwd }); if (sessions.has(sessionId)) throw new Error('exists'); sessions.add(sessionId) },
      async prompt(payload) { prompts.push(payload); if (promptImpl) await promptImpl(payload) },
      // 2026-11-04（用户 m00428）：叫醒不再走 prompt()——它内部写死 source.kind='user'，
      // 那条消息在前端永远是一句「他打的字」。现在走 resolveAgent() → agent.followup()。
      // 这里把 followup 收到的东西记成 { sessionId, content } 的形状，
      // 跟原来 prompt(payload) 的 payload 兼容，下面那些断言不用改写。
      async resolveAgent(sessionId) {
        return {
          agent: {
            followup(message) {
              const record = { sessionId, content: message?.content, source: message?.source, id: message?.id }
              prompts.push(record)
              if (promptImpl) return promptImpl(record)
            },
          },
        }
      },
    },
    logger: { info() {}, warn() {}, error() {} },
    on() {},
    get(key) { return ctx[key] },
  }
  return { ctx, tools, routes, prompts, sessions, creates }
}

/** 等注册生效：apply() 的工具/路由登记不是同步可见的，固定 sleep 在慢机上会偶发不够
 *  （CI 的 ubuntu Node 20 就是这样红的：`Cannot read properties of undefined (reading 'handler')`）。 */
async function waitFor(fn, ms = 5000) {
  const t0 = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - t0 > ms) return v
    await new Promise((r) => setTimeout(r, 10))
  }
}

test('插件元信息：名字与 inject', () => {
  assert.equal(name, 'dsh-fish')
  assert.ok(Array.isArray(inject), 'inject 必须是数组（写成对象会让 sessionController 静默丢失）')
  for (const k of ['sessionController', 'tools', 'webServer', 'connection']) assert.ok(inject.includes(k), `缺 ${k}`)
  // 2026-10-30（m02961）：可选服务不能写进 inject。cordis 的规则是「少一个就整个插件不启动」，
  // 而且不报错——一个只影响一条功能的服务，不该有让插件整个消失的权力。
  assert.ok(!inject.includes('userQuestions'), 'userQuestions 必须运行时探测，不能进 inject')
})

// 2026-11-07（PR #55 @BBleae）：0.9.1 那次发版只改了 package.json，VERSION 留在 0.9.1，
// 结果「已经装着最新的还是提示有更新」「源目录和装进去的都是 0.9.2 也判 stale」。
// 这条就是拦住下次只改一半。
test('VERSION 和 package.json 的 version 一致（不许分叉）', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(VERSION, pkg.version, '发版时 lib/index.js 的 VERSION 要跟着改')
})

test('插件停用时收得干净：宿主只认 ctx.effect，定时器要停，只收一次', async () => {
  await withRoot(async (root) => {
    const realSet = globalThis.setInterval
    const realClear = globalThis.clearInterval
    const realSetT = globalThis.setTimeout
    const realClearT = globalThis.clearTimeout
    const live = new Set()
    globalThis.setInterval = (...a) => { const t = realSet(...a); live.add(t); return t }
    globalThis.clearInterval = (t) => { live.delete(t); return realClear(t) }
    // 只记 1 秒以上的：调度器的 wakeTimer 是这种，下面轮询用的 20ms 不算
    globalThis.setTimeout = (fn, ms, ...a) => { const t = realSetT((...x) => { live.delete(t); fn(...x) }, ms, ...a); if (ms >= 1000) live.add(t); return t }
    globalThis.clearTimeout = (t) => { live.delete(t); return realClearT(t) }
    try {
      const { ctx } = fakeCtx()
      const cleanups = []
      ctx.effect = (fn) => { cleanups.push(fn()) }
      let disposeHandlers = 0
      ctx.on = (name) => { if (name === 'dispose') disposeHandlers += 1 }
      const h = apply(ctx, { root })
      for (let i = 0; i < 300 && live.size < 2; i++) await new Promise((r) => setTimeout(r, 20))
      assert.ok(live.size >= 1, '启动后应该有定时器在跑')
      assert.equal(cleanups.length, 1)
      assert.equal(disposeHandlers, 0)
      cleanups[0]()
      assert.equal(live.size, 0, '定时器都要停')
      assert.doesNotThrow(() => { cleanups[0](); h.dispose?.() })
    } finally {
      globalThis.setInterval = realSet
      globalThis.clearInterval = realClear
      globalThis.setTimeout = realSetT
      globalThis.clearTimeout = realClearT
    }
  })
})

test('首次启动会播种，且只播一次', async () => {
  await withRoot(async (root) => {
    const { ctx, routes } = fakeCtx()
    const h = apply(ctx, { root })
    assert.ok(await waitFor(() => routes.length > 0), '启动没走完')

    let { events } = await readEvents(root)
    const seeds = events.filter((e) => e.type === 'seed')
    assert.equal(seeds.length, 1)
    assert.ok(seeds[0].text.length > 20, '种子文本不能是空壳')
    assert.equal(seeds[0].source, 'system')

    // 再来一次（模拟重启）
    const h2 = apply(fakeCtx().ctx, { root })
    await new Promise((r) => setTimeout(r, 120))
    ;({ events } = await readEvents(root))
    assert.equal(events.filter((e) => e.type === 'seed').length, 1, '重启不能重复播种')

    h.dispose?.(); h2.dispose?.()
  })
})

test('注册了 growth_commit 与观测台路由', async () => {
  await withRoot(async (root) => {
    const { ctx, tools, routes } = fakeCtx()
    const h = apply(ctx, { root })
    await new Promise((r) => setTimeout(r, 120))

    assert.ok(await waitFor(() => tools.has('growth_commit')))
    const paths_ = routes.map((r) => r.path)
    assert.ok(paths_.includes('/dsh-fish'), '首页要注册')
    assert.ok(paths_.includes('/dsh-fish/state'))
    assert.ok(paths_.includes('/dsh-fish/config'))
    h.dispose?.()
  })
})

test('信任栅栏 fail-closed：connection 拒绝时 403', async () => {
  await withRoot(async (root) => {
    const { ctx, routes } = fakeCtx({ allow: false })
    const h = apply(ctx, { root })
    await new Promise((r) => setTimeout(r, 120))

    const route = await waitFor(() => routes.find((r) => r.path === '/dsh-fish/state'))
    const res = fakeRes()
    await route.handler({ url: '/dsh-fish/state', method: 'GET' }, res)
    assert.equal(res.code, 403)

    h.dispose?.()
  })
})

test('观测台 /state 不泄露 needs 数值', async () => {
  await withRoot(async (root) => {
    const { ctx, routes } = fakeCtx()
    const h = apply(ctx, { root })
    await new Promise((r) => setTimeout(r, 120))

    const route = await waitFor(() => routes.find((r) => r.path === '/dsh-fish/state'))
    const res = fakeRes()
    await route.handler({ url: '/dsh-fish/state', method: 'GET' }, res)
    assert.equal(res.code, 200)
    const dumped = res.body.toLowerCase()
    for (const leak of ['autonomy', 'competence', 'relatedness', 'needs', 'affinity']) {
      assert.ok(!dumped.includes(leak), `观测台不应返回 ${leak}`)
    }
    assert.ok(res.json.stageName)

    h.dispose?.()
  })
})

test('/state 与 /memory 把「对不上」和「记得很牢」报出来（2026-10-24 P0）', async () => {
  await withRoot(async (root) => {
    const { ctx, routes } = fakeCtx()
    const h = apply(ctx, { root })
    await new Promise((r) => setTimeout(r, 120))

    // 两句极性相反、剥掉否定后是同一件事 → 她心里对不上
    // 注意：正面那句不能带「别 / 没 / 无」——那些字本身就算否定词，两句会同极性而被跳过。
    await appendEvent({ type: 'utterance', source: 'tool', text: '它是在看我。' }, {}, root)
    await appendEvent({ type: 'utterance', source: 'tool', text: '它不是在看我。' }, {}, root)

    const stateRoute = await waitFor(() => routes.find((r) => r.path === '/dsh-fish/state'))
    const sres = fakeRes()
    await stateRoute.handler({ url: '/dsh-fish/state', method: 'GET' }, sres)
    assert.equal(sres.code, 200)
    assert.ok(sres.json.tension, '对不上要在 /state 里露出来')
    assert.equal(sres.json.tension.count, 1)
    assert.ok(sres.json.tension.a && sres.json.tension.b, '两句原话都要给，界面才能显示')
    assert.equal(typeof sres.json.solidCount, 'number')

    const memRoute = await waitFor(() => routes.find((r) => r.path === '/dsh-fish/memory'))
    const mres = fakeRes()
    await memRoute.handler({ url: '/dsh-fish/memory', method: 'GET' }, mres)
    assert.equal(mres.code, 200)
    assert.equal(mres.json.sections.tensions, 1)
    assert.ok(mres.json.sections.tensionFirst)
    assert.equal(typeof mres.json.sections.solid, 'number')
    // 界面说的「在眼前」必须和真正注入的条数一致（曾出现 8 vs 3 的虚报）
    assert.ok(mres.json.sections.beliefsShown <= 3)

    h.dispose?.()
  })
})

test('config POST 白名单挡住指向她本人的键', async () => {
  await withRoot(async (root) => {
    const { ctx, routes } = fakeCtx()
    const h = apply(ctx, { root })
    await new Promise((r) => setTimeout(r, 120))

    const route = await waitFor(() => routes.find((r) => r.path === '/dsh-fish/config'))
    const bad = fakeRes()
    await route.handler(reqWithBody('POST', JSON.stringify({ personality: { clingy: 0.9 } })), bad)
    assert.equal(bad.code, 400, '改人格的键必须被拒')

    const good = fakeRes()
    await route.handler(reqWithBody('POST', JSON.stringify({ daily: { questions: 3 } })), good)
    assert.equal(good.code, 200)
    assert.equal(good.json.config.daily.questions, 3)

    // 客户端（settings.section）会提交的两项环境配置，必须都能过
    const env = fakeRes()
    await route.handler(reqWithBody('POST', JSON.stringify({
      absenceAfterDays: 4,
      wakesPerDay: 2,
      diary: { visible: true, enabled: true },
      avoid: { keywords: ['恐怖', '血腥', '新的一个'] },
    })), env)
    assert.equal(env.code, 200, `环境配置必须能保存：${env.body}`)
    assert.equal(env.json.config.absenceAfterDays, 4)
    assert.equal(env.json.config.wakesPerDay, 2)
    assert.equal(env.json.config.diary.visible, true)
    assert.deepEqual(env.json.config.avoid.keywords, ['恐怖', '血腥', '新的一个'])

    h.dispose?.()
  })
})

test('请求体里的中文即使被 TCP 切断也要完整还原（跨 chunk 的多字节）', async () => {
  await withRoot(async (root) => {
    const { ctx, routes } = fakeCtx()
    const h = apply(ctx, { root })
    await new Promise((r) => setTimeout(r, 120))

    const route = await waitFor(() => routes.find((r) => r.path === '/dsh-fish/config'))

    // 真机病史（2026-10-23）：她回「传过来的字是碎的，我认不出」。
    // 根因是 readBody 用 `data += chunk`，Buffer 隐式 toString 按 latin1 逐字节拆中文
    // → 送进去的是 \ufffd 一串替换符。这条测试就是钉死它：切点故意落在汉字中间。
    const payload = JSON.stringify({ avoid: { keywords: ['恐怖片', '血腥'] } })
    const bytes = Buffer.from(payload, 'utf8')
    const parts = []
    for (let i = 0; i < bytes.length; i += 4) parts.push(bytes.subarray(i, i + 4))

    const res = fakeRes()
    await route.handler({
      method: 'POST',
      url: '/dsh-fish/config',
      on(ev, cb) {
        if (ev === 'data') for (const p of parts) cb(p)
        if (ev === 'end') cb()
        return this
      },
      destroy() {},
    }, res)

    assert.equal(res.code, 200, `中文配置必须能存：${res.body}`)
    assert.deepEqual(res.json.config.avoid.keywords, ['恐怖片', '血腥'])
    assert.ok(!res.body.includes('\uFFFD'), '响应里不该出现替换符（说明解码坏了）')

    h.dispose?.()
  })
})

test('/dsh-fish 不再吐单页观测台，而是给一句"搬走了"', async () => {
  await withRoot(async (root) => {
    const { ctx, routes } = fakeCtx()
    const h = apply(ctx, { root })
    await new Promise((r) => setTimeout(r, 120))

    const route = await waitFor(() => routes.find((r) => r.path === '/dsh-fish'))
    const res = fakeRes()
    await route.handler({ url: '/dsh-fish', method: 'GET' }, res)
    assert.equal(res.code, 200)
    assert.ok(res.body.includes('设置'), '要告诉人去设置里看')
    assert.ok(!res.body.includes('现在叫醒她'), '旧页面不该还在（它打不开，留着就是死代码）')

    h.dispose?.()
  })
})

test('日记默认不可见：只给日期，不给正文', async () => {
  await withRoot(async (root) => {
    await writeConfig(normalizeConfig({}), root)
    const { ctx, routes } = fakeCtx()
    const h = apply(ctx, { root })
    await new Promise((r) => setTimeout(r, 120))

    // 手工放一篇日记
    const { writeDaily } = await import('../lib/store.js')
    await writeDaily('diaryDir', '2026-10-20', '今天没人来。', root)

    const route = await waitFor(() => routes.find((r) => r.path === '/dsh-fish/diary'))
    const res = fakeRes()
    await route.handler({ url: '/dsh-fish/diary', method: 'GET' }, res)
    assert.equal(res.json.visible, false)
    assert.deepEqual(res.json.lockedDates, ['2026-10-20'])
    assert.ok(!JSON.stringify(res.json).includes('今天没人来'), '不可见时正文绝不能出现在响应里')

    h.dispose?.()
  })
})

test('日记可见时一天一页：默认只给最新一天，?day= 取指定那天', async () => {
  // 2026-10-26（用户 m01201）：日记攒到几十天之后，一次全发给前端既慢又没法看。
  // 现在 /diary 只给「日期目录 + 最新一天」，翻页按 day 单独取。
  await withRoot(async (root) => {
    await writeConfig(normalizeConfig({ diary: { enabled: true, visible: true } }), root)
    const { ctx, routes } = fakeCtx()
    const h = apply(ctx, { root })
    await new Promise((r) => setTimeout(r, 120))

    const { writeDaily } = await import('../lib/store.js')
    await writeDaily('diaryDir', '2026-10-19', '前一天写的。', root)
    await writeDaily('diaryDir', '2026-10-20', '今天没人来。', root)

    const route = await waitFor(() => routes.find((r) => r.path === '/dsh-fish/diary'))

    // 默认：日期全给（新在前），正文只给最新一天
    const r1 = fakeRes()
    await route.handler({ url: '/dsh-fish/diary', method: 'GET' }, r1)
    assert.deepEqual(r1.json.dates, ['2026-10-20', '2026-10-19'])
    assert.equal(r1.json.items.length, 1, '默认只带一天正文')
    assert.equal(r1.json.items[0].date, '2026-10-20')
    assert.ok(String(r1.json.items[0].text).includes('今天没人来'))

    // 指定更早一天：只回那一天，页里不能混进别的日子
    const r2 = fakeRes()
    await route.handler({ url: '/dsh-fish/diary?day=2026-10-19', method: 'GET' }, r2)
    assert.equal(r2.code, 200)
    assert.equal(r2.json.date, '2026-10-19')
    assert.ok(String(r2.json.text).includes('前一天写的'))
    assert.ok(!String(r2.json.text).includes('今天没人来'), '一页只放一天')

    // 那天没有（或日期不是 YYYY-MM-DD）：404 带说明
    const r3 = fakeRes()
    await route.handler({ url: '/dsh-fish/diary?day=2026-01-01', method: 'GET' }, r3)
    assert.equal(r3.code, 404)

    h.dispose?.()
  })
})

test('dispose 之后不再有后台活动（定时器真的停了）', async () => {
  await withRoot(async (root) => {
    const { ctx, routes } = fakeCtx()
    const h = apply(ctx, { root })
    // 等启动走完。固定等 120ms 在慢机上不够：还没写 seed 就收尾，seed 算成收尾之后的活动
    assert.ok(await waitFor(() => routes.length > 0), '启动没走完')
    h.dispose?.()

    const before = (await readEvents(root)).events.length
    await new Promise((r) => setTimeout(r, 200))
    const after = (await readEvents(root)).events.length
    assert.equal(after, before)
  })
})

test('scheduler.tick 在时间窗外不唤醒', async () => {
  await withRoot(async (root) => {
    // 窗口设成一个必然不含"现在"的区间（当前分钟往后推 3 小时开，1 分钟后关）
    const now = new Date()
    const h1 = (now.getHours() + 3) % 24
    await writeConfig(normalizeConfig({ window: [`${String(h1).padStart(2, '0')}:00`, `${String((h1 + 1) % 24).padStart(2, '0')}:00`] }), root)

    const { ctx, prompts } = fakeCtx()
    const s = startScheduler(ctx, { root, log: () => {} })
    await s.tick()
    assert.equal(prompts.length, 0, '时间窗外不该唤醒')
    s.dispose()
  })
})

// 回归（2026-10-23 用户报「她会话里有一大块隐藏提示词」→ 2026-10-25 晚再次报
// 「自动刷 B 站把她推醒了，对话框里又出现提示词」）：
// 唤醒会作为一条 user message 留在她的会话里，用户点开就看得见。
// 宿主没有「模型看得见、用户看不见」的通道（asar 已核实），所以正文不再进对话——
// 它走 system prompt 的 `fish:wake` 动态段；对话里只留一句极短的触发语。
test('唤醒消息只剩一句触发语，处境走 system prompt 段不进对话', async () => {
  await withRoot(async (root) => {
    // 关掉刷站，这两条测试才不会去打真接口（慢且不确定）。
    await writeConfig(normalizeConfig({ browse: { enabled: false } }), root)
    const { ctx, prompts } = fakeCtx()
    const r = await wakeNow(ctx, { root })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(prompts.length, 1)
    const text = prompts[0].content[0].text

    // 2026-11-05（用户 m02223 真机复核）：这条消息是开启这一轮的「回合触发条」，
    // 前端标题只看 source.kind；form/summary 对触发条无效，客户端也没有小胶囊那种画法。
    // 正文仍是空白信号 —— 写什么都会被她当成别人说的话。
    assert.equal(prompts[0].source.kind, 'fish-wake', '来源必须是 fish-wake，否则前端又画成用户气泡')
    assert.equal('form' in prompts[0].source, false, '触发条不读 form，别再加回来')
    assert.equal('summary' in prompts[0].source, false, '触发条不读 summary，别再加回来')
    assert.equal(text.trim(), '', `正文必须还是空白信号，现在是：${text.slice(0, 80)}`)
    // 2026-10-26（用户 m00507）：原来是「……」，她当成用户发来的一句话去猜，
    // 侧栏标题还被生成成「Error」。
    assert.ok(!text.includes('……'), '不能再拿省略号当触发语')
    assert.ok(!text.includes('醒一醒'), '触发语本身也不该出现——她读到的就是一句莫名其妙的话')
    assert.ok(!text.includes('## 你是谁'), '身份段不该出现在会话消息里')
    assert.ok(!text.includes('## 不能做的'), '禁令段不该出现在会话消息里')
    assert.ok(!text.includes('撒娇'), '禁令正文不该出现在会话消息里')
    assert.ok(!text.includes('autonomy'), '不能泄露字段名')
    assert.ok(!text.includes('第 1 天'), '处境正文不该再进对话')

    // 处境必须还在——只是换了通道（system prompt 段，见 attachIdentity）
    const wake = getWakeSection()
    assert.ok(wake.length > 0, '这次唤醒的处境不能为空')
    assert.ok(wake.includes('第 1 天') || wake.includes('醒'), '处境正文要在 wake 段里')
    assert.ok(wake.length < 1200, `处境段过长：${wake.length} 字`)
    // 2026-10-27 用户反馈：她第一次醒来时自己猜「大概不是我的时段」，还以为是权限问题。
    // 手动叫醒必须把「现在几点、是谁让醒的」说清楚，不让她猜。
    assert.match(wake, /现在是 \d{2}:\d{2}/, '唤醒段要给出当前时间')
    assert.match(wake, /有人刚按了叫醒/, '手动唤醒要说清是谁让醒的')

    // 身份必须还在落盘副本里（真通道是 systemPrompt 段，见 test/identity.test.mjs）
    await writeSelfDoc(root)
    const doc = await readFile(join(paths(root).root, 'home', '她的身份.md'), 'utf8')
    assert.ok(doc.includes('## 你是谁'))
    assert.ok(doc.includes('撒娇'), 'N1 禁令要在身份文档里')
    assert.ok(doc.includes('好感度'), 'N2 禁令要在身份文档里')
    assert.ok(doc.includes('growth_commit'), '工具说明要在身份文档里')
  })
})

// 回归：手动唤醒的 dateKey 必须是纯日期。
// 以前写成 `${dk}-manual`，这个后缀会一路跟着进 browse 记账、日记文件名、
// 报告文件名和会话 id；报告按 `2026-10-23` 去查，记账却写在
// `2026-10-23-manual` 里 → 报告"看了什么"永远显示"今天没看"。
// 区分手动只允许体现在 sessionId 上。
test('回归：手动唤醒的 dateKey 是纯日期，不污染 browse/日记/报告', async () => {
  await withRoot(async (root) => {
    await writeConfig(normalizeConfig({}), root)
    const { ctx, sessions } = fakeCtx()
    const r = await wakeNow(ctx, { root })
    assert.equal(r.ok, true, JSON.stringify(r))
    const dk = dateKey()

    // 会话 id 允许带 -manual（那正是"这是一次手动唤醒"的标记，也是避开
    // 「同一天复用 id → create 抛已存在 → cwd 不更新」的办法），但它必须以
    // 纯日期开头，不能把后缀混进日期本身。
    for (const id of sessions) {
      assert.ok(id.startsWith(`fish-wake-${dk}`), `会话 id 应以纯日期开头：${id}`)
    }

    // 真正的防线在落盘产物上：记账的日期键必须是纯日期。
    const { events } = await readEvents(root)
    const browse = events.filter((e) => e.type === 'meta' && String(e.text).startsWith('browse:'))
    for (const e of browse) {
      const key = String(e.text).slice('browse:'.length).split(' ')[0]
      assert.equal(key, dk, `browse 记账键必须等于纯日期，实际是 ${key}`)
    }
    const wakeMeta = events.filter((e) => e.type === 'meta' && String(e.text).startsWith('wake:'))
    for (const e of wakeMeta) {
      const key = String(e.text).slice('wake:'.length).split(' ')[0]
      assert.equal(key, dk, `wake 记账键必须等于纯日期，实际是 ${key}`)
    }
  })
})

// 2026-10-31（用户 m02943 / m03076）：手动点叫醒，卡池空了也得醒。
// 原来手动这条路只把当天 counts 清零，模板冷却和 cond 一样要过；stage 1 五张卡
// 一旦都出不来，点多少次都回「没有满足条件的事件模板（今天不打扰）」——
// 人按了铃，里面说「今天没什么事」。
test('手动唤醒：卡池空也照醒，给一句「今天没有待办」而不是拒绝', async () => {
  await withRoot(async (root) => {
    await writeConfig(normalizeConfig({ browse: { enabled: false } }), root)
    // 把 stage 1 五张卡全部按「出过 / 冷却中」处理，absence_probe 的 cond 在空历史下不成立，
    // 于是 pick() 的候选池确实为空（这就是线上遇到的「今天不打扰」）。
    await appendEvent(
      { type: 'meta', text: 'fired:why_here,first_bet,name_offer,test_first,absence_probe' },
      { day: 1, stage: 1, source: 'system' },
      root,
    )
    const { ctx, prompts } = fakeCtx()
    const r = await wakeNow(ctx, { root })
    assert.equal(r.ok, true, `卡池空时手动唤醒不该再被挡：${JSON.stringify(r)}`)
    assert.equal(r.template, 'manual-idle')
    assert.equal(prompts.length, 1, '照醒就得真的叫一次')
    // 不派活：她拿到的处境里要说清「今天没有待办」，不是一张要做事的卡
    const wake = getWakeSection()
    assert.match(wake, /现在没有待办/, '卡池空时要明说今天没有待办')
    assert.match(wake, /想做什么就做什么/, '要说清这一轮归她自己，不派活')

    // 记账：wake: 记的是 manual-idle，绝不能顶着某张真卡的 id 去占它的冷却
    const { events } = await readEvents(root)
    const dk = dateKey()
    const wakeMeta = events.filter((e) => e.type === 'meta' && String(e.text).startsWith('wake:'))
    assert.equal(wakeMeta.length, 1)
    assert.equal(String(wakeMeta[0].text), `wake:${dk} manual-idle`)
    const firedAfter = events
      .filter((e) => e.type === 'meta' && String(e.text).startsWith('fired:'))
      .flatMap((e) => String(e.text).slice(6).split(',').map((s) => s.trim()))
      .filter(Boolean)
    assert.ok(firedAfter.includes('manual-idle'))
    for (const id of ['why_here', 'first_bet', 'name_offer', 'test_first', 'absence_probe']) {
      assert.equal(firedAfter.filter((x) => x === id).length, 1, `${id} 只该有原来那一次，不能被手动唤醒再记一遍`)
    }
    assert.ok(!wakeMeta.some((e) => /^wake:\S+ (why_here|first_bet|name_offer|test_first|absence_probe)$/.test(String(e.text))), '不能冒充某张真卡')
  })
})

// 配额是「今天该不该自己醒」，手动不该突破——卡池空照醒，但当天次数用满仍然拦。
test('手动唤醒：当天次数已经用满，仍然拒绝（配额不因手动而放开）', async () => {
  await withRoot(async (root) => {
    await writeConfig(normalizeConfig({ browse: { enabled: false }, daily: { events: 0 } }), root)
    const { ctx, prompts } = fakeCtx()
    const r = await wakeNow(ctx, { root })
    assert.equal(r.ok, false, JSON.stringify(r))
    assert.match(String(r.why), /今日事件已满/, `拒绝理由要说配额，不是说没卡：${r.why}`)
    assert.equal(prompts.length, 0)
  })
})

// 2026-11-04（用户 m01466）：设置页那个按钮点多少次就投多少次。
//
// 真机事故：13:32:38 叫醒一次，11 秒后又被点一次（两次都是 test_first 模板）。
// 第一轮跑完 17 秒 → turn/end 把 fish:wake 处境清掉；第二次投出去时已经没处境了，
// 系统提示里一个字都没有，她只能回「这一轮没有新的事，我不再往下续」——
// 白烧一轮，而且在对话里留下一条她自己都觉得莫名其妙的回复。
//
// 根因：`WAKE_MIN_GAP_MS` 只写在 `nextWakeAt()` 里，而它只服务定时器那条路，
// 手动这条路一次间隔检查都没有（`wakeNow` 只把当天 counts 清零）。
test('手动唤醒：刚叫过就再点，第二次被最小间隔挡住', async () => {
  await withRoot(async (root) => {
    await writeConfig(normalizeConfig({ browse: { enabled: false } }), root)
    // 20 分钟前刚醒过一次（记录落在今天的 wake: 行上）。
    await appendEvent(
      { type: 'meta', text: `wake:${dateKey()} test_first`, ts: new Date(Date.now() - 20 * 60_000).toISOString() },
      { day: 1, stage: 1, source: 'timer' },
      root,
    )
    const { ctx, prompts } = fakeCtx()
    const r = await wakeNow(ctx, { root })
    assert.equal(r.ok, false, `20 分钟前刚叫过，不该再叫：${JSON.stringify(r)}`)
    assert.match(String(r.why), /刚叫过/, `要说清是间隔挡的，不是没卡：${r.why}`)
    assert.match(String(r.why), /20 分钟前/, '要带上隔了多久，不然用户以为按钮坏了')
    assert.match(String(r.why), /45 分钟/, '要说出等多久才够')
    assert.equal(prompts.length, 0, '一条消息都不许投出去')
    assert.ok(r.lastAt > 0, '要被挡住时把上一次的时间一起带回去，方便排查')

    // force 是给测试和「我就是要现在叫」留的口子，但它得真的能用。
    const forced = await wakeNow(ctx, { root, force: true })
    assert.equal(forced.ok, true, JSON.stringify(forced))
  })
})

test('手动唤醒：隔得够久就照常叫（间隔不是把按钮关掉）', async () => {
  await withRoot(async (root) => {
    await writeConfig(normalizeConfig({ browse: { enabled: false } }), root)
    // 昨天醒过：`lastWakeAt()` 只认今天那一行，昨天的既不清配额也不挡间隔。
    const yesterday = new Date(Date.now() - 26 * 3_600_000)
    await appendEvent(
      { type: 'meta', text: `wake:${dateKey(yesterday)} test_first` },
      { day: 1, stage: 1, source: 'timer' },
      root,
    )
    const { ctx, prompts } = fakeCtx()
    const r = await wakeNow(ctx, { root })
    assert.equal(r.ok, true, `昨天的唤醒不该挡今天的：${JSON.stringify(r)}`)
    assert.equal(prompts.length, 1)
  })
})

// 2026-11-05（用户 m03265）：这条原来断言 `creates.length === 1`，即每次叫醒都
// `sc.create({ sessionId, cwd: herDir })` 一次。那个 create 的语义是「我要用这一条」，
// 宿主对跑过 turn 的会话给不出来，于是静默另开一条空白会话 —— 每叫醒一次多一条空壳。
// 现在会话活着就**不建**，所以这里改成正向断言「一条都不建」；
// 那条「cwd 必须是 herDir」的约束挪到下面「探活失败才退回建」的用例里。
test('叫醒时不建会话：会话活着就只探活，不再堆空白会话', async () => {
  await withRoot(async (root) => {
    await writeConfig(normalizeConfig({}), root)
    const { ctx, creates, prompts } = fakeCtx()
    const r = await wakeNow(ctx, { root })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(prompts.length, 1, '叫醒该照常递出去')
    assert.equal(creates.length, 0, `会话还活着就不该再建，实际建了 ${JSON.stringify(creates)}`)
  })
})

test('探活失败才退回建会话，且 cwd 是她自己的空房间（不是状态库根）', async () => {
  await withRoot(async (root) => {
    await writeConfig(normalizeConfig({}), root)
    const { ctx, creates } = fakeCtx()
    // 模拟「宿主说这条会话已经没了」——只有这种情况才该退回 create
    ctx.sessionController.resolveAgent = async () => ({ error: new Error('session not found') })
    const r = await wakeNow(ctx, { root })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(creates.length, 1, '探活失败时必须退回建一条，否则叫不醒')
    const { cwd } = creates[0]
    assert.equal(cwd, paths(root).herDir, 'cwd 必须指向 herDir')
    assert.notEqual(cwd, root, 'cwd 不能就是状态库根——否则她 cat 一下就读到全部历史')
    // 真建出来了，不是个虚假路径
    const st = await stat(cwd)
    assert.ok(st.isDirectory())
    // 房间里没有事件流与配置
    const inRoom = await readdir(cwd)
    assert.ok(!inRoom.includes('events.jsonl'))
    assert.ok(!inRoom.includes('config.json'))
  })
})

// 回归（2026-10-26 用户 m00507「叫醒之后，对话到了未分组」）：
// 手动唤醒原来每次都伪造一个 `fish-wake-<日期>-manual-<ts>` 当会话 id，
// 宿主不认识它 → 按 cwd 新建一条 → 那条会话不在任何工作区的 sessionIds 里，
// 侧栏只能把它丢进「未分组」，用户在「大肥鱼的家」里根本看不见。
// 现在只要有屋子，就落在屋子那条会话里，会话自然还在工作区名下。
test('手动唤醒落在屋子会话里，不再另造一条（否则会掉进「未分组」）', async () => {
  await withRoot(async (root) => {
    // 关掉刷站：这条测的是会话归属，不该去打真接口
    await writeConfig(normalizeConfig({ browse: { enabled: false } }), root)
    const { ctx, prompts, creates } = fakeCtx()
    const WS = 'ws-home'
    const SID = 'session-home-1'
    const ws = { sessionIds: [SID] }
    ctx.workspaceRegistry = {
      get: (id) => (id === WS ? ws : undefined),
      list: () => [ws],
      archivedSessionIds: [],
    }
    await writeFile(
      join(paths(root).root, 'home.json'),
      JSON.stringify({ wsId: WS, sessionId: SID, title: '跟大肥鱼说话', preset: '' }),
      'utf8',
    )

    const r = await wakeNow(ctx, { root })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.sessionId, SID, '手动唤醒没有走屋子会话')
    assert.equal(prompts.length, 1)
    assert.equal(prompts[0].sessionId, SID, '唤醒消息发进了别的会话')
    // 不许再顺手造一条新会话（那条就是会掉进未分组的东西）
    for (const c of creates) {
      assert.notEqual(c.sessionId, undefined)
      assert.ok(!String(c.sessionId).startsWith('fish-wake-'), `不该再伪造 wake 会话：${c.sessionId}`)
    }
  })
})

// 反向：屋里那条会话被删/被归档了，就当没屋子，退回独立会话 —— 但要想办法
// 让人知道（log 里有话），不能默默再制造一条未分组垃圾。
test('屋子会话没了：退回独立会话，并且把原因说出来', async () => {
  await withRoot(async (root) => {
    await writeConfig(normalizeConfig({ browse: { enabled: false } }), root)
    const { ctx, prompts } = fakeCtx()
    const WS = 'ws-home'
    const logs = []
    ctx.workspaceRegistry = {
      get: (id) => (id === WS ? { sessionIds: ['session-gone'] } : undefined),
      list: () => [{ sessionIds: ['session-gone'] }],
      archivedSessionIds: [],
    }
    // home.json 指向一条早已不在工作区里的会话
    await writeFile(
      join(paths(root).root, 'home.json'),
      JSON.stringify({ wsId: WS, sessionId: 'session-old', title: '跟大肥鱼说话', preset: '' }),
      'utf8',
    )

    const r = await wakeNow(ctx, { root, log: (m) => logs.push(String(m)) })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.ok(String(r.sessionId).startsWith('fish-wake-'), '没有屋子时才该用独立会话 id')
    assert.equal(prompts.length, 1)
    assert.ok(logs.some((m) => m.includes('未分组')), `退回独立会话必须写明后果，实际日志：${JSON.stringify(logs)}`)
  })
})

test('整条链路：她说一句 → 判断数 +1 → 阶段门仍卡着（不跳级）', async () => {
  await withRoot(async (root) => {
    await writeConfig(normalizeConfig({ growthDays: 30 }), root)
    const { ctx, tools } = fakeCtx()
    const h = apply(ctx, { root })
    await new Promise((r) => setTimeout(r, 120))

    const tool = await waitFor(() => tools.get('growth_commit'))
    await tool.execute({ type: 'utterance', text: '我不太确定自己喜不喜欢安静。', confidence: 0.3 })

    const { events } = await readEvents(root)
    const m = deriveSelf(events, { growthDays: 30 })
    assert.equal(m.beliefCount, 1)
    assert.equal(m.stage, 1, '只过 trust 门、没过 autonomy 门，不该到 stage 2')
    assert.equal(m.stageGate.pending, 'autonomy')

    h.dispose?.()
  })
})

function fakeRes() {
  const res = {
    code: 200,
    body: '',
    headers: {},
    writableEnded: false,
    writeHead(code, headers) { res.code = code; Object.assign(res.headers, headers || {}); return res },
    end(chunk) { if (chunk) res.body += String(chunk); res.writableEnded = true; return res },
    get json() { try { return JSON.parse(res.body) } catch { return null } },
  }
  return res
}

function reqWithBody(method, body) {
  const chunks = [Buffer.from(body, 'utf8')]
  return {
    method,
    url: '/dsh-fish/config',
    on(ev, cb) {
      if (ev === 'data') for (const c of chunks) cb(c)
      if (ev === 'end') cb()
      return this
    },
    destroy() {},
  }
}

test('工具面白名单：拼错的名字不许保存，合法名字按全角逗号/空格存成数组', async () => {
  await withRoot(async (root) => {
    const { ctx, routes } = fakeCtx()
    // 真机上这份快照在 agent/created 时从她的全局视角取到；测试里直接塞
    rememberKnownTools(['web_search', 'read_image', 'skill'])
    const h = apply(ctx, { root })
    await new Promise((r) => setTimeout(r, 120))

    const route = await waitFor(() => routes.find((r) => r.path === '/dsh-fish/config'))

    // 拼错一个字母：形状合法、名单里没有 —— 存进去就会让整条收窄失效，必须 400。
    // 带 strictTools：这条路是「用户刚敲完字点的保存」，坏名字要当场拦。
    // 不带它的（页面自动保存整表回传旧名单）走另一条：丢掉坏名字照存，见 p5.test.mjs。
    const typo = fakeRes()
    await route.handler(reqWithBody('POST', JSON.stringify({ tools: { restrict: true, allow: ['web_serch'] }, strictTools: true })), typo)
    assert.equal(typo.code, 400, '拼错的名字必须被拒')
    assert.ok(typo.body.includes('web_serch'), '要说出是哪个名字不对')

    // 合法名字：全角逗号也认，落盘是干净的数组
    const okRes = fakeRes()
    await route.handler(reqWithBody('POST', JSON.stringify({ tools: { restrict: true, allow: ['skill，read_image'] } })), okRes)
    assert.equal(okRes.code, 200, okRes.body)
    assert.deepEqual(okRes.json.config.tools.allow, ['skill', 'read_image'])

    // /tools 把名字给界面（只给名字，不给定义）
    const toolsRoute = routes.find((r) => r.path === '/dsh-fish/tools')
    const listRes = fakeRes()
    await toolsRoute.handler({ url: '/dsh-fish/tools', method: 'GET' }, listRes)
    assert.equal(listRes.code, 200)
    assert.equal(listRes.json.ok, true)
    assert.deepEqual(listRes.json.known, ['read_image', 'skill', 'web_search'])

    h.dispose?.()
  })
})

// 2026-10-27 用户反馈（m00974）：她第一次醒来时自己猜「大概不是我的时段」，
// 用户还以为是自己没给权限。叫醒先把「几点、谁让醒」说清楚，别留给她猜。
test('叫醒的时间行：手动的说清谁按的，定时的说清是她自己醒的', () => {
  const at = (h, m) => new Date(2026, 9, 27, h, m)
  assert.equal(
    wakeTimeLine(at(16, 6), { manual: true, insideWindow: false }),
    '现在是 16:06。有人刚按了叫醒——这个点不在你平时的时段，是有人要你现在醒。',
  )
  assert.equal(
    wakeTimeLine(at(20, 43), { manual: true, insideWindow: true }),
    '现在是 20:43。有人刚按了叫醒，要你现在醒。',
  )
  assert.equal(
    wakeTimeLine(at(20, 43), { manual: false }),
    '现在是 20:43，这一次是你自己醒的。',
  )
})

// 回归（2026-10-28 用户发来的运行日志）：22:15→23:00 每分钟一条
// `skip 今日主动唤醒已满(1/1)`，几十行同样的字把日志刷满，
// 真正的报错（工具有没有注册上）反而被埋掉。配额当天固定，原因没变就别重述。
test('调度器 skip 日志：同一小时同一原因只记一条，换小时或换原因才再记', () => {
  const at = (h, m = 0) => new Date(2026, 9, 28, h, m).getTime()
  const why = '今日主动唤醒已满(1/1)'

  // 第一次：要记
  const first = shouldLogSkip('', '2026-10-28', at(22, 15), why)
  assert.match(first, /^2026-10-28T22\|/)
  assert.ok(first.includes(why))

  // 同一小时、同一原因：返回空字符串 = 不该写
  assert.equal(shouldLogSkip(first, '2026-10-28', at(22, 16), why), '')
  assert.equal(shouldLogSkip(first, '2026-10-28', at(22, 59), why), '')

  // 换成下一个小时：再记一条
  const nextHour = shouldLogSkip(first, '2026-10-28', at(23, 0), why)
  assert.match(nextHour, /^2026-10-28T23\|/)

  // 同一小时但原因变了（配额类型不同）：也要记
  const otherWhy = shouldLogSkip(first, '2026-10-28', at(22, 30), '今日事件已满(1/1)')
  assert.match(otherWhy, /今日事件已满/)

  // 跨到第二天同一钟点：日期变了，照样记
  const nextDay = shouldLogSkip('2026-10-28T22|' + why, '2026-10-29', at(22, 5), why)
  assert.match(nextDay, /^2026-10-29T22\|/)
})

// 0.7.4（用户 m00659 C）：手动叫醒也要认「她不在家」。
// tick() 早就有这道闸门，理由写在调度器里：两条会话并行会互相踩 events.jsonl，
// 还会在侧栏里凭空多出一条「家里醒了」的对话。手动 /wake 以前绕过去了。
test('手动唤醒：她在外面时不该把家里那条叫醒', async () => {
  await withRoot(async (root) => {
    await writeConfig(normalizeConfig({ browse: { enabled: false } }), root)
    // 造一条 active 出门：cwd 在别的工作区
    await writeFile(
      join(paths(root).root, 'outings.json'),
      JSON.stringify({
        outings: [{
          sessionId: 'session-out1',
          workspaceId: 'w1',
          workspaceName: '素材',
          cwd: join(root, 'ws'),
          startedAt: Date.now() - 60_000,
          endedAt: 0,
          status: 'active',
          baseline: null,
          kept: null,
          identity: '',
        }],
      }),
      'utf8',
    )
    const { ctx, prompts } = fakeCtx()
    const r = await wakeNow(ctx, { root })
    assert.equal(r.ok, false, '出门期间不许叫醒家里那条')
    assert.equal(r.away?.kind, 'outing')
    assert.match(String(r.why), /家里这条先不叫她/, `要说清为什么没叫：${r.why}`)
    assert.equal(prompts.length, 0, '一条 prompt 都不许发出去')

    // 0.7.7（用户 m02022）：被挡住时必须留一行日志。以前这里是静默 return，
    // 日志里什么都没有 → 事后分不清「用户没点」和「点了被挡回去」。
    const logged = await readFile(logFile(root), 'utf8')
    assert.match(logged, /叫醒被挡住了（outing）/, `被挡住要在 dsh-fish.log 里留痕：${logged.slice(-400)}`)
    assert.match(logged, /现在在外面：素材/, '日志得说清她在哪儿')

    // 显式 force 才穿透
    const forced = await wakeNow(ctx, { root, force: true })
    assert.equal(forced.ok, true, JSON.stringify(forced))
    assert.equal(prompts.length, 1)
  })
})

test('手动唤醒：请神期间同样不叫家里那条', async () => {
  await withRoot(async (root) => {
    await writeConfig(normalizeConfig({ browse: { enabled: false } }), root)
    await writeFile(
      join(paths(root).root, 'possessions.json'),
      JSON.stringify({
        possessions: [{
          sessionId: 'session-pos1',
          title: '在写方案的那条',
          cwd: join(root, 'ws2'),
          startedAt: Date.now() - 30_000,
          endedAt: 0,
          status: 'active',
          identity: '',
        }],
      }),
      'utf8',
    )
    const { ctx, prompts } = fakeCtx()
    const r = await wakeNow(ctx, { root })
    assert.equal(r.ok, false)
    assert.equal(r.away?.kind, 'possession')
    assert.equal(prompts.length, 0)
  })
})

// 0.7.4（真机 bug，2026-10-29）：`appendEvent(ev, root)` 把 root 传在了 ctx 的位置，
// ctx 于是成了一个字符串 → source 落回默认的 'tool' → schema 以 NOT_HER_TYPE 拒掉
// `grant_offer`（她不能写系统事件）。外面套着 try/catch，只留一行「grant offer failed」。
// 结果：申请从来没进过事件流，整个 R3 授予规则是死的——出卡、裁决、解禁一条链全断。
test('解禁申请真的会落盘（不再被 source 误判成她写的）', async () => {
  await withRoot(async (root) => {
    await writeConfig(normalizeConfig({ browse: { enabled: false } }), root)
    // seed 往前放 20 天，growthDay 才会越过「证据最后一天 + 1~3 天」的到期日
    const seedTs = new Date(Date.now() - 20 * 86400000).toISOString()
    await appendEvent({ type: 'seed', ts: seedTs, text: '开局' }, { day: 1, stage: 1, source: 'system' }, root)
    const ev = (body, day) => appendEvent(body, { day, stage: 1, source: 'tool' }, root)
    // revise 必须带 refs（0.5.8 起还会校验 id 真在事件流里），所以先拿原话的 id
    const said = await ev({ type: 'utterance', text: '我错了，那个说法不对' }, 3)
    await ev({ type: 'revise', text: '改成这样说', verdict: 'refined', refs: [said.id] }, 4)
    await ev({ type: 'revise', text: '再改一次', verdict: 'refined', refs: [said.id] }, 5)
    await ev({ type: 'refusal', text: '不要' }, 6)
    await ev({ type: 'refusal', text: '我不想' }, 7)
    await ev({ type: 'narration', text: '我没想清楚' }, 8)

    const { ctx } = fakeCtx()
    const r = await wakeNow(ctx, { root })
    assert.equal(r.ok, true, JSON.stringify(r))

    const { events } = await readEvents(root)
    const offers = events.filter((e) => e.type === 'grant_offer')
    assert.equal(offers.length, 1, '证据够了就必须真的写下一条申请，而不是只在日志里报错')
    const o = offers[0]
    assert.equal(o.source, 'system', '这条是系统替她出的卡，source 必须是 system')
    assert.equal(o.grant?.rule, 'learn-affection')
    assert.ok(String(o.text).includes('我想试试'), `申请正文不对：${o.text}`)
    // 落了盘才可能被 pendingOffer 看见——否则第二天又出一张，还会盖住用户没处理的卡
    assert.ok(await readFile(paths(root).events, 'utf8').then((s) => s.includes('grant_offer')))
  })
})

// 2026-10-29（用户 m02241）：出门期间 tick 每 60 秒跑一次，原来每次都写一条
// 「away 现在在外面：X · 已 N 分钟」。出门一整晚就是几百行同样的字，
// 真正的异常（装备没挂上、台账冲突）被淹在里面看不见。
// 现在只在这一趟第一次看到时记一行；台账冲突才是每次都要说的异常。
test('出门心跳只记第一行，不每 60 秒刷一遍', async () => {
  await withRoot(async (root) => {
    await writeConfig(normalizeConfig({ browse: { enabled: false }, window: ['00:00', '23:59'] }), root)
    const startedAt = Date.now() - 5 * 60_000
    await writeFile(
      join(paths(root).root, 'outings.json'),
      JSON.stringify({
        outings: [{
          sessionId: 'session-hb', workspaceId: 'w1', workspaceName: '素材', cwd: join(root, 'ws'),
          startedAt, endedAt: 0, status: 'active', baseline: null, kept: null, identity: '',
        }],
      }),
      'utf8',
    )
    const { ctx } = fakeCtx()
    // 生产里 deps.log 接到 makeLogger.info，最终写进同一个日志文件；
    // 这里用 logLine 直接把那句话落盘，等价于真实链路。
    const s = startScheduler(ctx, { root, log: (...a) => logLine('info', a, root) })
    const realNow = Date.now
    let offset = 0
    Date.now = () => realNow() + offset
    try {
      await s.tick()
      // 推进 3 分钟，连跑三次 tick：如果还按老写法，日志里会有 4 行
      for (let i = 0; i < 3; i += 1) {
        offset += 61_000
        await s.tick()
      }
    } finally {
      Date.now = realNow
      s.dispose()
    }
    const logged = await readFile(logFile(root), 'utf8')
    const lines = logged.split('\n').filter((l) => l.includes('现在在外面：素材'))
    assert.equal(lines.length, 1, `一趟只该记一行心跳，实际 ${lines.length} 行：\n${lines.join('\n')}`)
  })
})

test('出门与请神同时开着是异常：这条每次 tick 都要说', async () => {
  await withRoot(async (root) => {
    await writeConfig(normalizeConfig({ browse: { enabled: false }, window: ['00:00', '23:59'] }), root)
    const base = Date.now() - 5 * 60_000
    await writeFile(
      join(paths(root).root, 'outings.json'),
      JSON.stringify({
        outings: [{
          sessionId: 'session-c1', workspaceId: 'w1', workspaceName: '素材', cwd: join(root, 'ws'),
          startedAt: base, endedAt: 0, status: 'active', baseline: null, kept: null, identity: '',
        }],
      }),
      'utf8',
    )
    await writeFile(
      join(paths(root).root, 'possessions.json'),
      JSON.stringify({
        possessions: [{
          sessionId: 'session-c2', title: '一条对话', cwd: join(root, 'ws2'),
          startedAt: base + 1000, endedAt: 0, status: 'active', baseline: null, identity: '',
        }],
      }),
      'utf8',
    )
    const { ctx } = fakeCtx()
    const s = startScheduler(ctx, { root, log: (...a) => logLine('info', a, root) })
    const realNow = Date.now
    let offset = 0
    Date.now = () => realNow() + offset
    try {
      await s.tick()
      offset += 61_000
      await s.tick()
    } finally {
      Date.now = realNow
      s.dispose()
    }
    const logged = await readFile(logFile(root), 'utf8')
    const lines = logged.split('\n').filter((l) => l.includes('出门与请神同时开着'))
    assert.equal(lines.length, 2, `冲突态不能被去重，两次 tick 该有两行，实际 ${lines.length} 行`)
  })
})
