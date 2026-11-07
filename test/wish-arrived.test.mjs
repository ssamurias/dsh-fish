/**
 * wish-arrived.test.mjs —— 要的那件工具已经给了，桌上不再摆「还没见到」（issue #58）
 *
 * need-tool 的裁决只记录、不落实权限（lib/ask.js）。主人真要给，只能在卡外面给：
 * 装插件、在设置页放开工具。事件流里不会有「已经给了」这一行，所以以前桌上照样摆
 * 14 天「他答应了，还没见到」（卡超时没人答的摆 3 天「你问过，还没有答复」），
 * 还算进劲儿（driveDesk.wish），一件办完的事还会推她醒。
 *
 * 守什么：
 *   1. herToolNames() 只说她确实拿得到的：守卫放行的名单 ∩ 宿主真认得的名字；
 *      收窄关着、没登记过、一个名字都没见过时返回 null。
 *   2. 叫醒那张桌子：subject 正好是她手上已有工具名的那条不摆，别的照摆。
 *   3. 劲儿那一笔：同样不算；桌上只剩这一件时就是「桌上没有可说的东西」。
 *   4. 拿不到名单时一个字都不变。
 *
 * 这个文件会真叫醒一次、真跑调度器的 tick：家目录、家谱、用户目录全指到临时目录。
 * restrict.js 的收窄结论是进程内单例，所以单独一个文件，用例按顺序共享它。
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = await mkdtemp(join(tmpdir(), 'fish-wish58-'))
const ENV_KEYS = ['DSH_FISH_HOME', 'DSH_FISH_HOMES', 'USERPROFILE', 'HOME']
const envBefore = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
process.env.DSH_FISH_HOME = join(sandbox, 'fish-home')
process.env.DSH_FISH_HOMES = join(sandbox, 'homes.json')
process.env.USERPROFILE = join(sandbox, 'user')
process.env.HOME = join(sandbox, 'user')

const { registerToolRestrict, herToolNames, rememberKnownTools, HER_TOOLS } = await import('../lib/restrict.js')
const { wakeNow, startScheduler } = await import('../lib/scheduler.js')
const { appendEvent, writeConfig } = await import('../lib/store.js')
const { normalizeConfig } = await import('../lib/settings.js')
const { settleAsk } = await import('../lib/ask.js')
const { getWakeSection, clearWakeSection } = await import('../lib/identity.js')

after(async () => {
  // 进程内单例复位：用 --test-isolation=none 跑时别把这里的白名单带给别的文件。
  rememberKnownTools([])
  registerToolRestrict(fakeCtx(), { herDir: HER_DIR, log: () => {} })
  clearWakeSection()
  for (const k of ENV_KEYS) {
    if (envBefore[k] === undefined) delete process.env[k]
    else process.env[k] = envBefore[k]
  }
  await rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

const HER_DIR = join(sandbox, 'her-home')
let rootSeq = 0

async function freshRoot() {
  rootSeq += 1
  return mkdtemp(join(sandbox, `root-${rootSeq}-`))
}

/** 假插件 ctx：只要能挂 agent/created、能触发。 */
function fakeCtx() {
  const listeners = new Map()
  return {
    on(ev, fn) {
      if (!listeners.has(ev)) listeners.set(ev, [])
      listeners.get(ev).push(fn)
      return () => {}
    },
    emit(ev, payload) {
      for (const fn of listeners.get(ev) ?? []) fn(payload)
    },
  }
}

/** 一个 agent：cwd 决定是不是她；view 里是宿主此刻真登记着的工具。 */
function fakeAgent(cwd, names) {
  const agent = {
    session: { header: { cwd } },
    ctx: {
      effect: () => {},
      tools: {
        view: (scope) => scope === agent
          ? { restrictableNames: new Set(names), visible: new Map(names.map((n) => [n, {}])) }
          : { restrictableNames: new Set() },
        restrict: () => () => {},
        guard: () => () => {},
      },
    },
  }
  return agent
}

/** 叫醒用的假宿主：投递只记一笔，不碰任何真会话。 */
function wakeCtx() {
  const prompts = []
  const ctx = {
    sessionController: {
      async create() {},
      async prompt(payload) { prompts.push(payload) },
      async resolveAgent(sessionId) {
        return { agent: { followup(message) { prompts.push({ sessionId, content: message?.content }) } } }
      },
    },
    logger: { info() {}, warn() {}, error() {} },
    on() {},
    get(key) { return ctx[key] },
  }
  return { ctx, prompts }
}

/** 她开一张 need-tool 卡，主人在卡上答「可以」——和 ask_owner / 卡片结算走同一条路。 */
async function askedAndApproved(root, { question, subject }) {
  const ev = await appendEvent({
    type: 'ask',
    text: question,
    ask: { kind: 'need-tool', subject, options: ['可以', '这次不行', '以后再说'], reason: '' },
  }, { day: 1, stage: 1, source: 'system' }, root)
  const r = await settleAsk(root, { askId: ev.id, verdict: 'approve', via: 'ui' })
  assert.equal(r.ok, true, JSON.stringify(r))
  return ev
}

const SEARCH_Q = '想要一个能上网搜东西的工具'
const IMAGE_Q = '想要一个能画图的工具'

test('herToolNames：没登记过收窄、宿主一个名字都没见过时拿不到', () => {
  rememberKnownTools([])
  assert.equal(herToolNames(), null)
})

test('herToolNames：放行了、也真装上了的才算在她手上', () => {
  const ctx = fakeCtx()
  // 设置页放行了 web_search 和 image_gen；宿主只真登记了 web_search。
  registerToolRestrict(ctx, { herDir: HER_DIR, extra: ['web_search', 'image_gen'], log: () => {} })
  ctx.emit('agent/created', { agent: fakeAgent(HER_DIR, [...HER_TOOLS, 'web_search']) })
  // 别的工作区有 pwsh：宿主认得这个名字，但守卫不放它给她。
  ctx.emit('agent/created', { agent: fakeAgent(join(sandbox, 'elsewhere'), [...HER_TOOLS, 'web_search', 'pwsh']) })

  const names = herToolNames()
  assert.ok(Array.isArray(names))
  assert.ok(names.includes('web_search'), '放行了、装上了：在手上')
  assert.ok(names.includes('bili_look'), '她自己的工具当然也在')
  assert.ok(!names.includes('image_gen'), '只写进白名单、宿主没登记：东西没到')
  assert.ok(!names.includes('pwsh'), '宿主认得、守卫不放：不是她的')
})

test('叫醒那张桌子：要的工具已经到手的那条不摆，没到的照摆', async () => {
  const root = await freshRoot()
  await writeConfig(normalizeConfig({ browse: { enabled: false } }), root)
  // 先问画图（没到），再问搜索（到了）。桌上只摆一件，按近到远——以前摆的就是搜索那条。
  await askedAndApproved(root, { question: IMAGE_Q, subject: 'image_gen' })
  await askedAndApproved(root, { question: SEARCH_Q, subject: 'web_search' })

  clearWakeSection()
  const { ctx } = wakeCtx()
  const r = await wakeNow(ctx, { root, force: true })
  assert.equal(r.ok, true, JSON.stringify(r))
  const wake = getWakeSection()
  assert.doesNotMatch(wake, new RegExp(SEARCH_Q), '已经到手的不该再摆「他答应了，还没见到」')
  assert.match(wake, new RegExp(`${IMAGE_Q}」（他答应了，还没见到）`), '还没到的照摆')
})

/**
 * 主动性开着、全天都在窗里，跑一趟 tick，收日志。
 * 卡是刚开的、刚答的，不放宽「多久没说话」那一关的话，走不到算劲儿那一步。
 */
async function tickOnce(root) {
  await writeConfig(normalizeConfig({ window: ['00:00', '23:59'], proactive: { enabled: true, minIdleHours: 0 } }), root)
  const logs = []
  const s = startScheduler({}, { root, log: (...a) => logs.push(a.join(' ')) })
  try {
    await s.tick()
  } finally {
    s.dispose()
  }
  return logs
}

test('劲儿那一笔：到手的那件不算材料，桌上只剩它时就是空桌', async () => {
  const done = await freshRoot()
  await askedAndApproved(done, { question: SEARCH_Q, subject: 'web_search' })
  const logs = await tickOnce(done)
  assert.ok(logs.some((l) => l.startsWith('drive 桌上没有可说的东西')), logs.join(' | '))

  // 对照：没到手的那件仍是桌上的材料，劲儿照算。
  const waiting = await freshRoot()
  await askedAndApproved(waiting, { question: IMAGE_Q, subject: 'image_gen' })
  const logs2 = await tickOnce(waiting)
  assert.ok(logs2.some((l) => l.startsWith('drive ')), `得走到算劲儿那一步：${logs2.join(' | ')}`)
  assert.ok(!logs2.some((l) => l.startsWith('drive 桌上没有可说的东西')), logs2.join(' | '))
})

test('拿不到名单（收窄关着）时一个字都不变：照旧摆', async () => {
  registerToolRestrict(fakeCtx(), { herDir: HER_DIR, enabled: false, log: () => {} })
  assert.equal(herToolNames(), null, '收窄关着：说不清她这条会话有什么')

  const root = await freshRoot()
  await writeConfig(normalizeConfig({ browse: { enabled: false } }), root)
  await askedAndApproved(root, { question: SEARCH_Q, subject: 'web_search' })
  clearWakeSection()
  const { ctx } = wakeCtx()
  const r = await wakeNow(ctx, { root, force: true })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.match(getWakeSection(), new RegExp(`${SEARCH_Q}」（他答应了，还没见到）`))

  const logs = await tickOnce(root)
  assert.ok(logs.some((l) => l.startsWith('drive ')), `得走到算劲儿那一步：${logs.join(' | ')}`)
  assert.ok(!logs.some((l) => l.startsWith('drive 桌上没有可说的东西')), logs.join(' | '))
})
