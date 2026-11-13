/**
 * wish-inhand.test.mjs —— 「已经到手」只认她手上真有的（issue #58，0.9.5 复核）
 *
 * 0.9.5 拿配置里的白名单回答「到手没有」。可白名单里写了不等于宿主上有：
 * `read_image` 是宿主给的可选能力（默认就在 allow 里），白名单里的桥工具也可能没装上——
 * 这些名字收窄时会被剔掉、不下给宿主，她手上根本没有。照旧算「到手」的话，她要它们的
 * 那张 need-tool 卡一开出来，叫醒的桌子、劲儿、悬着的事三处就都看不到了；卡还在住所页
 * 等人答，她自己却再也想不起来。
 *
 * 这里照 `lib/index.js` 的调用注册收窄，假宿主只给它真有的工具，再真跑叫醒与主动回合。
 * 后半是重启后的冷会话：她的 agent 要到第一次被叫起来才建，在那之前「到手」核实不了。
 * 最后是她同时住着好几条会话（群聊分房的 cwd 也是她的屋子）：「到手」只按家里那条算，
 * 家里那条没见到时不拿群房的工具表顶；会话 id 两边写法不一样也认得出。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HER_TOOLS, currentAllowTools, registerToolRestrict } from '../lib/restrict.js'
import { wishesOf } from '../lib/wish.js'
import { looseEnds } from '../lib/proactive.js'
import { startScheduler, wakeNow } from '../lib/scheduler.js'
import { appendEvent, readEvents, writeConfig } from '../lib/store.js'
import { normalizeConfig } from '../lib/settings.js'
import { clearWakeSection, getWakeSection } from '../lib/identity.js'
import { settleAsk } from '../lib/ask.js'

const HOUR = 3_600_000
const READ_IMAGE_WISH = '想要一个能看图的工具'
const IMAGE_GEN_WISH = '想要一个能画图的工具'
const SEARCH_WISH = '想要一个能上网搜东西的工具'

/**
 * 冷会话的 tick 不该被「定时醒来」抢戏：这个文件关心的是「劲儿」和「桌子」。
 * 把当天落点钉在 23:58（测试钟 21:00），ensureSchedule 就会沿用，不会当场醒。
 */
const pinFutureSchedule = (root) => appendEvent(
  { type: 'meta', text: `sched:2026-11-07 ${new Date('2026-11-07T23:58:00+08:00').toISOString()}` },
  { day: 0, stage: 1, source: 'timer' },
  root,
)

/** 插件 ctx：只要 agent/created 能挂、能发。 */
function pluginCtx() {
  const ls = []
  return {
    on: (ev, fn) => { if (ev === 'agent/created') ls.push(fn); return () => {} },
    created: (agent) => { for (const fn of ls) fn({ agent }) },
  }
}

/**
 * 宿主建好的她：`view(agent)` 报的是宿主此刻真有的工具。
 * `sid` 是会话头里的 id（缺省 `s1`，和 home.json 里那条一样；传空串就是头里没写 id）；
 * `own` 是 own 层的（看得见、收不窄，别的插件按会话挂的那种）。
 */
function herAgent(cwd, names, { sid = 's1', own = [] } = {}) {
  const sent = []
  const agent = {
    session: { header: { cwd, ...(sid ? { id: sid } : {}) } },
    ctx: {
      effect() {},
      tools: {
        view: (scope) => scope === agent
          ? { restrictableNames: new Set(names), visible: new Map([...names, ...own].map((n) => [n, {}])) }
          : { restrictableNames: new Set() },
        restrict: ({ allow }) => { sent.push(allow); return () => {} },
        guard: () => () => {},
      },
    },
  }
  return { agent, sent }
}

/**
 * 叫醒与主动回合用的宿主：投进去的那一刻把处境段一起记下来。
 * `onResolve`：冷会话用——宿主第一次被要这条会话的 agent 时才建它（发 agent/created）。
 * `agentOf`：宿主交回来的就是 agent/created 发过的那个她（真宿主就是这样）；
 * 不给时交回一个只会 followup 的替身，插件只能按会话 id 去找她。
 */
function fakeHost({ onResolve, agentOf } = {}) {
  const prompts = []
  const registry = { get: () => ({ sessionIds: ['s1'] }), archivedSessionIds: [] }
  const ctx = {
    on: () => () => {},
    get: (name) => (name === 'workspaceRegistry' ? registry : undefined),
    sessionController: {
      create: async () => {},
      prompt: async () => {},
      resolveAgent: async (sessionId) => {
        onResolve?.(sessionId)
        const agent = agentOf?.(sessionId) ?? {}
        agent.followup = (message) => { prompts.push({ sessionId, section: getWakeSection() }) }
        return { agent }
      },
    },
    logger: { info() {}, warn() {}, error() {} },
  }
  return { ctx, prompts }
}

/** 她自己开的一张 need-tool 卡（走 appendEvent，和 ask_owner 写的同形）。 */
async function wish(root, { text, subject, ts }) {
  const ev = await appendEvent({
    type: 'ask',
    text,
    ...(ts ? { ts } : {}),
    ask: { kind: 'need-tool', subject, options: ['可以', '以后再说'], reason: '' },
  }, { day: 1, stage: 1, source: 'system' }, root)
  return ev.id
}

/**
 * 一间临时的家：按配置注册收窄，宿主只给 `host` 里的工具。
 * 叫醒的兜底定时器（2s / 30s / 90s）压成几毫秒，别让测试进程挂着等。
 * `cold`：重启后的冷会话——她的 agent 先不建，等 `warm()`（交给 fakeHost 的 onResolve）。
 * `sid` / `own`：家里那个 agent 的会话头 id 与 own 层，见 herAgent。
 * 交给 fn 的 `created` 能再发别的 agent（群房），`agent` 是家里那个。
 */
async function withHer({ allow = [], host, cold = false, sid = 's1', own = [] }, fn) {
  const root = await mkdtemp(join(tmpdir(), 'fish-inhand-'))
  const oldHomes = process.env.DSH_FISH_HOMES
  process.env.DSH_FISH_HOMES = join(root, 'homes.json')
  const realST = globalThis.setTimeout
  globalThis.setTimeout = (f, ms, ...a) => realST(f, [2000, 30_000, 90_000].includes(ms) ? 5 : ms, ...a)
  // 2026-11-09：把时钟钉住。`tick()` 里按「今天醒过几次」「是不是刚请过假」这类判据
  // 都跟本机时间走，凌晨跑与晚上跑结果不一样（同一份代码 TZ=UTC 全绿、本地 05:3x 挂 3 条）。
  // 这里只覆盖 `Date.now()`（tick 用的就是它），固定到一条本地傍晚的时刻。
  //
  // 2026-11-10：`wakeNow()`/`wake()` 读的是 `new Date()`，不是 `Date.now()`，
  // 所以「钉住的那条钟」和「叫醒看到的钟」会各走各的。卡的时间戳按钉住的钟写、
  // 叫醒按真实钟读到 3 天以后，「还没答的摆 3 天」那条窗口就被走完了——测试会随
  // 真实日期过期（这条 10 小时前的卡在 11-10 傍晚开始挂）。凡是调 `wakeNow` 的地方
  // 都显式传 `now: new Date(Date.now())`，让叫醒也看钉住的那条钟。
  const realNow = Date.now
  const FIXED_NOW = new Date('2026-11-07T21:00:00+08:00').getTime()
  Date.now = () => FIXED_NOW
  try {
    const config = normalizeConfig({
      window: ['00:00', '23:59'],
      daily: { events: 2 },
      wakesPerDay: 4,
      tools: { restrict: true, allow },
      proactive: { enabled: true, minIdleHours: 1 },
      browse: { enabled: false },
      comment: { enabled: false },
      rules: { offers: false },
      memory: { sleepEveryDays: 0 },
    })
    await writeConfig(config, root)
    await writeFile(join(root, 'home.json'), JSON.stringify({ wsId: 'ws1', sessionId: 's1' }), 'utf8')
    const herDir = join(root, 'her')
    const pctx = pluginCtx()
    const logs = []
    registerToolRestrict(pctx, {
      herDir,
      extra: config.tools.allow,
      enabled: config.tools.restrict !== false,
      log: (m) => logs.push(m),
      retryMs: 1,
      retryMax: 1,
    })
    const her = herAgent(herDir, host, { sid, own })
    let made = false
    const warm = () => { if (!made) { made = true; pctx.created(her.agent) } }
    if (!cold) warm()
    return await fn(root, { sent: her.sent, logs, warm, created: pctx.created, herDir, agent: her.agent })
  } finally {
    Date.now = realNow
    globalThis.setTimeout = realST
    clearWakeSection()
    if (oldHomes === undefined) delete process.env.DSH_FISH_HOMES
    else process.env.DSH_FISH_HOMES = oldHomes
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

const hasNow = () => {
  const a = currentAllowTools()
  return a ? new Set(a) : null
}

// 默认配置（allow 为空），宿主上只有插件自己的工具，没有 read_image。
const OWN_ONLY = HER_TOOLS.filter((n) => n !== 'read_image')

test('宿主上没有 read_image：她要它的那张卡不算到手，桌上、悬着的事里都还在（issue #58）', async () => {
  await withHer({ host: OWN_ONLY }, async (root, { sent, logs }) => {
    // 前提：read_image 确实没下给宿主（收窄时剔掉了）
    assert.ok(sent.length >= 1)
    const last = sent.at(-1)
    assert.ok(!last.includes('read_image'))
    assert.ok(logs.some((m) => m.includes('read_image') && m.includes('没有')))

    await wish(root, { text: READ_IMAGE_WISH, subject: 'read_image' })
    const { events } = await readEvents(root)
    const now = Date.now()
    assert.equal(wishesOf(events, { now, has: hasNow() }).length, 1, '手上没有的东西不能当成已经到手')
    assert.equal(looseEnds(events, { now, has: hasNow() }).length, 1, '悬着的事里也得有它')

    const h = fakeHost()
    const r = await wakeNow(h.ctx, { root, sessionId: 's1', force: true, now: new Date(Date.now()) })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(h.prompts.length, 1)
    assert.match(h.prompts[0].section, new RegExp(READ_IMAGE_WISH), '叫醒的桌子上要摆着这张卡')
    assert.match(h.prompts[0].section, /你问过，还没有答复/)
  })
})

test('白名单里写了、宿主上没装：答应过的卡照摆「还没见到」；真到手的那张照旧撤掉（issue #58）', async () => {
  await withHer({ allow: ['image_gen', 'web_search'], host: [...HER_TOOLS, 'web_search'] }, async (root, { sent }) => {
    assert.ok(!sent.at(-1).includes('image_gen'), '前提：image_gen 这台机器上没有，没下给宿主')
    assert.ok(sent.at(-1).includes('web_search'))

    const genId = await wish(root, { text: IMAGE_GEN_WISH, subject: 'image_gen', ts: new Date(Date.now() - 2 * HOUR).toISOString() })
    assert.equal((await settleAsk(root, { askId: genId, verdict: 'approve' })).ok, true)
    // 更近的这张要的是真到手的工具：过滤还得管用，不然它会占住桌上唯一那一格
    const searchId = await wish(root, { text: SEARCH_WISH, subject: 'web_search' })
    assert.equal((await settleAsk(root, { askId: searchId, verdict: 'approve' })).ok, true)

    const { events } = await readEvents(root)
    const w = wishesOf(events, { now: Date.now(), has: hasNow() })
    assert.deepEqual(w.map((x) => x.text), [IMAGE_GEN_WISH])

    const h = fakeHost()
    await wakeNow(h.ctx, { root, sessionId: 's1', force: true, now: new Date(Date.now()) })
    assert.equal(h.prompts.length, 1)
    assert.match(h.prompts[0].section, new RegExp(IMAGE_GEN_WISH))
    assert.match(h.prompts[0].section, /他答应了，还没见到/)
    assert.doesNotMatch(h.prompts[0].section, new RegExp(SEARCH_WISH), '已经到手的不再摆')
  })
})

test('只有这一张还没到手的卡：劲儿照算，主动回合照开，处境里念得到它（issue #58）', async () => {
  await withHer({ host: OWN_ONLY }, async (root) => {
    // 十个小时前开的卡，之后一直安静
    await wish(root, { text: READ_IMAGE_WISH, subject: 'read_image', ts: new Date(Date.now() - 10 * HOUR).toISOString() })
    await pinFutureSchedule(root)
    const h = fakeHost()
    const logs = []
    const s = startScheduler(h.ctx, { root, log: (...a) => logs.push(a.join(' ')) })
    try {
      await s.tick()
    } finally {
      s.dispose()
    }
    assert.ok(!logs.some((l) => l.includes('桌上没有可说的东西')), logs.join(' | '))
    assert.equal(h.prompts.length, 1, logs.join(' | '))
    assert.match(h.prompts[0].section, new RegExp(READ_IMAGE_WISH))
  })
})

// ---- 冷会话（重启以后）----
// 宿主重启后复用她那条会话，不新建；agent 要等第一次被叫起来（探活、投递）才建，
// agent/created 也到那时才发。主动回合的劲儿在那之前就要算，叫醒的桌子也曾在那之前摆。

test('冷会话：已经到手的那张卡不单独推她开主动回合（issue #58）', async () => {
  await withHer({ allow: ['web_search'], host: [...HER_TOOLS, 'web_search'], cold: true }, async (root, { warm, sent }) => {
    await wish(root, { text: SEARCH_WISH, subject: 'web_search', ts: new Date(Date.now() - 10 * HOUR).toISOString() })
    assert.equal(sent.length, 0, '前提：她的 agent 还没建，收窄还没下')
    await pinFutureSchedule(root)
    const h = fakeHost({ onResolve: warm })
    const logs = []
    const s = startScheduler(h.ctx, { root, log: (...a) => logs.push(a.join(' ')) })
    try {
      await s.tick()
    } finally {
      s.dispose()
    }
    assert.equal(h.prompts.length, 0, (h.prompts[0]?.section ?? '').slice(0, 300))
    assert.ok(logs.some((l) => l.includes('桌上没有可说的东西')), logs.join(' | '))
  })
})

test('冷会话：叫醒时先接上会话再摆桌子，已经到手的卡不摆（issue #58）', async () => {
  await withHer({ allow: ['web_search'], host: [...HER_TOOLS, 'web_search'], cold: true }, async (root, { warm, sent }) => {
    const id = await wish(root, { text: SEARCH_WISH, subject: 'web_search' })
    assert.equal((await settleAsk(root, { askId: id, verdict: 'approve' })).ok, true)
    assert.equal(sent.length, 0, '前提：她的 agent 还没建，收窄还没下')
    const h = fakeHost({ onResolve: warm })
    await wakeNow(h.ctx, { root, sessionId: 's1', force: true, now: new Date(Date.now()) })
    assert.equal(h.prompts.length, 1)
    assert.doesNotMatch(h.prompts[0].section, new RegExp(SEARCH_WISH))
  })
})

test('冷会话、宿主上没有 read_image：叫醒的桌上照摆；核实之前它不单独推她醒（issue #58 的取舍）', async () => {
  await withHer({ host: OWN_ONLY, cold: true }, async (root, { warm, sent }) => {
    await wish(root, { text: READ_IMAGE_WISH, subject: 'read_image', ts: new Date(Date.now() - 10 * HOUR).toISOString() })
    assert.equal(sent.length, 0, '前提：她的 agent 还没建，收窄还没下')
    await pinFutureSchedule(root)

    // 劲儿算在会话接上之前：这时只有配置里的白名单可看，read_image 在里面，先当到手。
    // 这样已经到手的卡（上一条）不会把她推起来；代价是这张也要等她醒着时才算数。
    const quiet = fakeHost({ onResolve: warm })
    const logs = []
    const s = startScheduler(quiet.ctx, { root, log: (...a) => logs.push(a.join(' ')) })
    try {
      await s.tick()
    } finally {
      s.dispose()
    }
    assert.equal(quiet.prompts.length, 0)
    assert.ok(logs.some((l) => l.includes('桌上没有可说的东西')), logs.join(' | '))

    // 叫醒：会话先接上，按她这条会话真有的工具摆——read_image 没有，卡照摆
    const h = fakeHost({ onResolve: warm })
    await wakeNow(h.ctx, { root, sessionId: 's1', force: true, now: new Date(Date.now()) })
    assert.equal(h.prompts.length, 1)
    assert.match(h.prompts[0].section, new RegExp(READ_IMAGE_WISH))
    assert.match(h.prompts[0].section, /你问过，还没有答复/)
  })
})

// ---- 主动回合的处境：会话接上之后再拼 ----

test('冷会话：主动回合的处境等会话接上再拼，已经到手的那张不念（issue #58）', async () => {
  await withHer({ allow: ['web_search'], host: [...HER_TOOLS, 'web_search'], cold: true }, async (root, { warm, sent }) => {
    // 白名单里没有 image_gen：劲儿那一步核实不了也知道它没到手，是这张把她推起来
    await wish(root, { text: IMAGE_GEN_WISH, subject: 'image_gen', ts: new Date(Date.now() - 10 * HOUR).toISOString() })
    // 这张要的东西家里已经有了，可要等会话接上才核实得了
    await wish(root, { text: SEARCH_WISH, subject: 'web_search', ts: new Date(Date.now() - 9 * HOUR).toISOString() })
    assert.equal(sent.length, 0, '前提：她的 agent 还没建，收窄还没下')
    await pinFutureSchedule(root)
    const h = fakeHost({ onResolve: warm })
    const logs = []
    const s = startScheduler(h.ctx, { root, log: (...a) => logs.push(a.join(' ')) })
    try {
      await s.tick()
    } finally {
      s.dispose()
    }
    assert.equal(h.prompts.length, 1, logs.join(' | '))
    assert.match(h.prompts[0].section, new RegExp(IMAGE_GEN_WISH))
    assert.doesNotMatch(h.prompts[0].section, new RegExp(SEARCH_WISH), '会话接上了才拼处境：已经到手的不念')
  })
})

// ---- 她同时住着好几条会话 ----
// 群聊分房的 cwd 也是她的屋子，agent/created 照样认成她；可群房不带家里的 preset，
// 工具表跟家里不一样。「到手」只按家里那条算。

test('冷会话、群房先活着：劲儿不拿群房的工具表算，家里已经到手的卡不单独推她醒（issue #58）', async () => {
  await withHer({ allow: ['web_search'], host: [...HER_TOOLS, 'web_search'], cold: true }, async (root, { warm, sent, created, herDir }) => {
    // 群里有人说话，群房先建好了；它手上没有 web_search
    const room = herAgent(herDir, HER_TOOLS, { sid: 'g1' })
    created(room.agent)
    assert.equal(room.sent.length, 1, '前提：群房也是她，照样收窄')
    assert.equal(sent.length, 0, '前提：家里那条还冷着')
    await wish(root, { text: SEARCH_WISH, subject: 'web_search', ts: new Date(Date.now() - 10 * HOUR).toISOString() })
    await pinFutureSchedule(root)
    const h = fakeHost({ onResolve: warm })
    const logs = []
    const s = startScheduler(h.ctx, { root, log: (...a) => logs.push(a.join(' ')) })
    try {
      await s.tick()
    } finally {
      s.dispose()
    }
    assert.equal(h.prompts.length, 0, (h.prompts[0]?.section ?? '').slice(0, 300))
    assert.ok(logs.some((l) => l.includes('桌上没有可说的东西')), logs.join(' | '))
  })
})

test('会话 id 两边写法不一样、还有一间群房：叫醒的桌子按家里那条算（issue #58）', async () => {
  // 家里 agent 头里写的是 `session-s1`，home.json 里是 `s1`；后建的群房 own 层多一件 image_gen
  await withHer({ allow: ['image_gen'], host: HER_TOOLS, sid: 'session-s1' }, async (root, { created, herDir }) => {
    created(herAgent(herDir, HER_TOOLS, { sid: 'session-g1', own: ['image_gen'] }).agent)
    const id = await wish(root, { text: IMAGE_GEN_WISH, subject: 'image_gen' })
    assert.equal((await settleAsk(root, { askId: id, verdict: 'approve' })).ok, true)
    const h = fakeHost()
    await wakeNow(h.ctx, { root, sessionId: 's1', force: true, now: new Date(Date.now()) })
    assert.equal(h.prompts.length, 1)
    assert.match(h.prompts[0].section, new RegExp(IMAGE_GEN_WISH), '家里没有 image_gen：不能按群房的算成到手')
    assert.match(h.prompts[0].section, /他答应了，还没见到/)
  })
})

test('宿主交回来的就是家里那个 agent：头里没写会话 id 也按它算，不拿群房顶（issue #58）', async () => {
  await withHer({ allow: ['image_gen'], host: HER_TOOLS, sid: '' }, async (root, { created, herDir, agent }) => {
    created(herAgent(herDir, HER_TOOLS, { sid: 'g1', own: ['image_gen'] }).agent)
    const id = await wish(root, { text: IMAGE_GEN_WISH, subject: 'image_gen' })
    assert.equal((await settleAsk(root, { askId: id, verdict: 'approve' })).ok, true)
    const h = fakeHost({ agentOf: (sid) => (sid === 's1' ? agent : null) })
    await wakeNow(h.ctx, { root, sessionId: 's1', force: true, now: new Date(Date.now()) })
    assert.equal(h.prompts.length, 1)
    assert.match(h.prompts[0].section, new RegExp(IMAGE_GEN_WISH))
    assert.match(h.prompts[0].section, /他答应了，还没见到/)
  })
})
