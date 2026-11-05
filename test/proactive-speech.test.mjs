/**
 * proactive-speech.test.mjs —— 对话靠工具发出去的部署里，主动回合怎么算（AGENTS.md §7.3）。
 *
 * 真 startScheduler + 假宿主，从 tick 一路走到记账。必须钉住的：
 *   1. 默认配置下行为不变：只调工具没写正文，还是记没开口，还是折。
 *   2. 配了 sendTools：调成功算开口；调失败不算；调了别的工具不算。
 *   3. foldSilent 关掉：没开口也不动历史。
 *   4. 她正忙（这个调度器看到的，或别的插件说的）不投递。
 *   5. idleCountsSeen：「他来过」打断安静，也解掉「上次没人接」的折扣。
 *   6. 处境和身份段照配置说实话。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmp = mkdtempSync(join(tmpdir(), 'fish-speech-'))
process.env.HOME = tmp
process.env.USERPROFILE = tmp
process.env.DSH_FISH_HOMES = join(tmp, 'homes.json')
process.env.DSH_FISH_LOCATION = join(tmp, '.dsh-fish-location.json')

const { startScheduler } = await import('../lib/scheduler.js')
const { getWakeSection, clearWakeSection } = await import('../lib/identity.js')
const { appendEvent, readEvents, writeConfig } = await import('../lib/store.js')
const { normalizeConfig, updateConfig, loadConfig } = await import('../lib/settings.js')
const { driveOf } = await import('../lib/drive.js')
const { idleHoursOf, proactiveSection, proactiveConfig } = await import('../lib/proactive.js')
const { proactiveBrief, PROACTIVE_BRIEF } = await import('../lib/persona.js')

const HOUR = 3_600_000
const realNow = Date.now
let offset = 0
before(() => { Date.now = () => realNow() + offset })
after(() => { Date.now = realNow; rmSync(tmp, { recursive: true, force: true }) })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function host({ bail } = {}) {
  const listeners = []
  const followups = []
  const appended = []
  const session = { id: 's-main', header: { id: 's-main' }, append: (type, m, o) => { appended.push({ type, text: m?.content?.[0]?.text, op: o?.surfaceOp }); return { seq: 999 } } }
  const ws = { sessionIds: ['s-main'] }
  const registry = { get: (id) => (id === 'w' ? ws : undefined), list: () => [ws], archivedSessionIds: [], create: async () => ws, rename: async () => {}, addSession: async () => {}, removeSession: async () => {} }
  const ctx = {
    get: (n) => (n === 'workspaceRegistry' ? registry : undefined),
    on: (ev, fn) => { if (ev !== 'session/event') return () => {}; listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1) } },
    ...(bail ? { bail } : {}),
    sessionController: {
      create: async () => { throw new Error('exists') },
      resolveAgent: async () => ({ agent: { followup: (message) => followups.push({ message, section: getWakeSection() }) } }),
    },
  }
  const emit = (event) => { for (const fn of [...listeners]) fn(session, event) }
  return { ctx, followups, appended, emit }
}

let n = 0
async function setup(proactive = {}, { history = true } = {}) {
  offset = 0
  const root = join(tmp, `r${++n}`)
  mkdirSync(join(root, 'home'), { recursive: true })
  await writeConfig(normalizeConfig({ window: ['00:00', '23:59'], browse: { enabled: false }, comment: { enabled: false }, proactive: { enabled: true, ...proactive } }), root)
  writeFileSync(join(root, 'home.json'), JSON.stringify({ sessionId: 's-main', wsId: 'w', title: 't', preset: '' }))
  if (history) await appendEvent({ type: 'utterance', text: '那个讲海的视频到底是谁拍的？我一直没弄明白为什么它会火？' }, { day: 1, stage: 1, source: 'tool' }, root)
  offset = 30 * HOUR
  return root
}
const metas = async (root) => (await readEvents(root)).events.filter((e) => e.type === 'meta').map((e) => String(e.text).split(':')[0])

const REASON = '想跟他说一句。'.repeat(40)
/** 一轮：ping、调一次工具、工具结果、turn/end。text 非空就再写一句正文。 */
function playTurn(h, { tool = 'send_chat', isError = false, text = '' } = {}) {
  const ping = h.followups.at(-1).message
  h.emit({ type: 'turn/start', seq: 9 })
  h.emit({ type: 'user/message', seq: 10, surfaceOp: 'append', data: ping })
  const content = [{ type: 'reasoning', text: REASON }]
  if (tool) content.push({ type: 'tool-call', id: 'c1', name: tool, arguments: { text: '你好' } })
  if (text) content.push({ type: 'text', text })
  h.emit({ type: 'assistant/message', seq: 11, surfaceOp: 'append', data: { message: { id: 'a', role: 'assistant', content } } })
  if (tool) h.emit({ type: 'tool/result', seq: 12, surfaceOp: 'append', data: { message: { role: 'tool', toolCallId: 'c1', isError, content: [{ type: 'text', text: 'x' }] } } })
  h.emit({ type: 'turn/end', seq: 14 })
}
async function run(proactive, turn) {
  const root = await setup(proactive)
  const h = host()
  const s = startScheduler(h.ctx, { root, sessionId: 's-main', log: () => {} })
  await s.tick()
  assert.equal(h.followups.length, 1, '这一拍应该投递一次')
  playTurn(h, turn)
  await sleep(60)
  const out = { meta: await metas(root), folded: h.appended.length, section: h.followups[0].section }
  s.dispose()
  clearWakeSection()
  return out
}

test('默认配置行为不变：只调工具没写正文，记没开口，还折', async () => {
  const r = await run({}, { tool: 'send_chat' })
  assert.ok(r.meta.includes('proactive-silent'))
  assert.ok(!r.meta.includes('proactive-turn'))
  assert.ok(r.folded > 0)
  assert.match(r.section, /他看得见/)
})

test('配了 sendTools：发送工具成功就算开口，不折', async () => {
  const r = await run({ sendTools: ['send_chat'] }, { tool: 'send_chat' })
  assert.ok(r.meta.includes('proactive-turn'))
  assert.ok(!r.meta.includes('proactive-silent'))
  assert.equal(r.folded, 0)
})

test('发送失败不算开口', async () => {
  const r = await run({ sendTools: ['send_chat'] }, { tool: 'send_chat', isError: true })
  assert.ok(r.meta.includes('proactive-silent'))
  assert.ok(!r.meta.includes('proactive-turn'))
})

test('配了 sendTools：只写正文不算开口，正文到不了人', async () => {
  const r = await run({ sendTools: ['send_chat'] }, { tool: null, text: '我想了想，还是算了，先不打扰他。' })
  assert.ok(r.meta.includes('proactive-silent'))
  assert.ok(!r.meta.includes('proactive-turn'))
})

test('配了 sendTools：发送失败再写一句正文，也不算开口', async () => {
  const r = await run({ sendTools: ['send_chat'] }, { tool: 'send_chat', isError: true, text: '发不出去，算了，等会儿再说吧。' })
  assert.ok(r.meta.includes('proactive-silent'))
  assert.ok(!r.meta.includes('proactive-turn'))
})

test('没配 sendTools：正文还是算开口', async () => {
  const r = await run({}, { tool: null, text: '我想了想，还是跟你说一声。' })
  assert.ok(r.meta.includes('proactive-turn'))
  assert.equal(r.folded, 0)
})

test('代码模式里的发送：嵌套派发按真正的工具名认', async () => {
  const root = await setup({ sendTools: ['send_chat'] })
  const h = host()
  const s = startScheduler(h.ctx, { root, sessionId: 's-main', log: () => {} })
  await s.tick()
  const ping = h.followups.at(-1).message
  h.emit({ type: 'turn/start', seq: 9 })
  h.emit({ type: 'user/message', seq: 10, surfaceOp: 'append', data: ping })
  h.emit({ type: 'assistant/message', seq: 11, surfaceOp: 'append', data: { message: { id: 'a', role: 'assistant', content: [{ type: 'reasoning', text: REASON }, { type: 'tool-call', id: 'c1', name: 'run_code', arguments: {} }] } } })
  h.emit({ type: 'tool/ptc-dispatch', seq: 12, data: { rootCallId: 'c1', subCallId: 'c2', name: 'send_chat', isError: false, content: [] } })
  h.emit({ type: 'tool/result', seq: 13, surfaceOp: 'append', data: { message: { role: 'tool', toolCallId: 'c1', isError: false, content: [{ type: 'text', text: 'x' }] } } })
  h.emit({ type: 'turn/end', seq: 14 })
  await sleep(60)
  assert.ok((await metas(root)).includes('proactive-turn'))
  assert.equal(h.appended.length, 0)
  s.dispose()
  clearWakeSection()
})

test('调了别的工具不算开口', async () => {
  const r = await run({ sendTools: ['send_chat'] }, { tool: 'read' })
  assert.ok(r.meta.includes('proactive-silent'))
})

test('发了消息再写一句「没什么要说的」，也算开口：发出去的不会因为正文收回', async () => {
  const r = await run({ sendTools: ['send_chat'] }, { tool: 'send_chat', text: '今天没什么想说的。' })
  assert.ok(r.meta.includes('proactive-turn'))
})

test('foldSilent 关掉：没开口只记账，不动历史', async () => {
  const r = await run({ foldSilent: false }, { tool: null })
  assert.ok(r.meta.includes('proactive-silent'))
  assert.equal(r.folded, 0)
})

test('foldSilent 不写就是开着', async () => {
  const r = await run({}, { tool: null })
  assert.ok(r.folded > 0)
})

test('这一轮还在跑时不投递，过一会儿再看', async () => {
  const root = await setup({})
  const h = host()
  const logs = []
  const s = startScheduler(h.ctx, { root, sessionId: 's-main', log: (...a) => logs.push(a.join(' ')) })
  h.emit({ type: 'turn/start', seq: 1 })
  await s.tick()
  assert.equal(h.followups.length, 0)
  assert.ok(logs.some((l) => l.includes('她正忙')))
  assert.ok(!logs.some((l) => l.includes('dsh-fish/busy')), '不是别的插件说的，日志别写成别的插件')
  assert.equal(getWakeSection(), '', '没投递就不该挂处境')
  assert.ok(!(await metas(root)).includes('drive-spend'), '没投递不扣劲儿')
  h.emit({ type: 'turn/end', seq: 2 })
  offset += 6 * 60_000
  await s.tick()
  assert.equal(h.followups.length, 1, '空下来 5 分钟后就投递')
  s.dispose()
  clearWakeSection()
})

test('别的插件说她在忙：不投递；抛错按不忙算', async () => {
  const root = await setup({})
  let answer = true
  const seen = []
  const h = host({ bail: (name, id) => { seen.push([name, id]); if (answer === 'throw') throw new Error('x'); return answer ? true : undefined } })
  const s = startScheduler(h.ctx, { root, sessionId: 's-main', log: () => {} })
  await s.tick()
  assert.equal(h.followups.length, 0)
  assert.deepEqual(seen[0], ['dsh-fish/busy', 's-main'])
  answer = 'throw'
  offset += 6 * 60_000
  await s.tick()
  assert.equal(h.followups.length, 1)
  s.dispose()
  clearWakeSection()
})

test('监听返回的 Promise：按不忙算，拒绝被接住，不会变成未处理的拒绝', async () => {
  const root = await setup({})
  const seen = []
  const onUnhandled = (e) => seen.push(e)
  process.on('unhandledRejection', onUnhandled)
  const h = host({ bail: () => Promise.reject(new Error('查询失败')) })
  const logs = []
  const s = startScheduler(h.ctx, { root, sessionId: 's-main', log: (...a) => logs.push(a.join(' ')) })
  await s.tick()
  await sleep(30)
  process.off('unhandledRejection', onUnhandled)
  assert.equal(seen.length, 0)
  assert.equal(h.followups.length, 1)
  assert.ok(logs.some((l) => l.includes('dsh-fish/busy')))
  s.dispose()
  clearWakeSection()
})

test('别的插件说忙：日志写清是谁说的', async () => {
  const root = await setup({})
  const h = host({ bail: () => true })
  const logs = []
  const s = startScheduler(h.ctx, { root, sessionId: 's-main', log: (...a) => logs.push(a.join(' ')) })
  await s.tick()
  assert.ok(logs.some((l) => l.includes('dsh-fish/busy')))
  s.dispose()
  clearWakeSection()
})

test('idleCountsSeen：「他来过」打断安静；默认不算', () => {
  const now = Date.now()
  const events = [
    { type: 'utterance', text: 'x', ts: new Date(now - 30 * HOUR).toISOString() },
    { type: 'meta', text: `seen:${new Date(now - 1 * HOUR).toISOString()}`, ts: new Date(now - 1 * HOUR).toISOString() },
  ]
  assert.ok(Math.abs(idleHoursOf(events, now) - 30) < 0.01)
  assert.ok(Math.abs(idleHoursOf(events, now, { countSeen: true }) - 1) < 0.01)
})

test('idleCountsSeen：他来过之后，「上次没人接」的折扣解掉', () => {
  const now = Date.now()
  const events = [
    { type: 'meta', text: `proactive-turn:d:${now - 8 * HOUR}`, ts: new Date(now - 8 * HOUR).toISOString() },
    { type: 'meta', text: `seen:${new Date(now - 1 * HOUR).toISOString()}`, ts: new Date(now - 1 * HOUR).toISOString() },
  ]
  const desk = { gaps: 1 }
  assert.equal(driveOf({ events, now, desk }).damp, 0.7)
  assert.equal(driveOf({ events, now, desk, seenCountsAsHeard: true }).damp, 1)
})

test('处境和身份段按配置说实话', () => {
  const plain = proactiveSection({ now: Date.now(), state: { idleHours: 7 } })
  assert.match(plain, /他看得见/)
  assert.match(plain, /距离上一次留下记录/)
  const routed = proactiveSection({ now: Date.now(), state: { idleHours: 7 }, sendTools: ['send_chat', 'send_mail'], countSeen: true })
  assert.doesNotMatch(routed, /他看得见/)
  assert.match(routed, /send_chat、send_mail/)
  assert.match(routed, /只留在这条会话里/)
  assert.match(routed, /他来或你留下记录/)
  assert.equal(proactiveBrief([]), PROACTIVE_BRIEF)
  const brief = proactiveBrief(['send_chat'])
  assert.doesNotMatch(brief, /他看得见/)
  assert.match(brief, /send_chat/)
  assert.match(brief, /没人找你/, '身份段每一轮都在，要限定在自己想开口的时候')
})

test('her_say 回执：配了 sendTools 照实说没发给任何人', async () => {
  const { registerProactive } = await import('../lib/proactive.js')
  const render = (root) => {
    const tools = []
    registerProactive({ tools: { register: (t) => { tools.push(t); return () => {} } } }, { root })
    return tools.find((t) => t.name === 'her_say')
  }
  const root = await setup({ sendTools: ['send_chat'] })
  const tool = render(root)
  assert.deepEqual(tool.output.render({}, { ok: true, note: 'x', recordOnly: true }), [{ type: 'text', text: '[记下了，没有发给任何人]' }])
  assert.deepEqual(tool.output.render({}, { ok: true, note: 'x' }), [{ type: 'text', text: '[说出去了]' }])
})

test('配置：夹紧、默认值，设置页只改一项时别的不丢', async () => {
  assert.deepEqual(proactiveConfig({}).sendTools, [])
  assert.equal(proactiveConfig({}).foldSilent, true)
  assert.equal(proactiveConfig({}).idleCountsSeen, false)
  assert.deepEqual(proactiveConfig({ proactive: { sendTools: [' a ', '', null, 'b'] } }).sendTools, ['a', 'b'])
  assert.deepEqual(proactiveConfig({ proactive: { sendTools: 'a' } }).sendTools, [])
  const root = await setup({ sendTools: ['send_chat'], foldSilent: false, idleCountsSeen: true })
  await updateConfig({ proactive: { maxPerDay: 1 } }, root)
  const { config } = await loadConfig(root)
  assert.deepEqual(config.proactive.sendTools, ['send_chat'])
  assert.equal(config.proactive.foldSilent, false)
  assert.equal(config.proactive.idleCountsSeen, true)
  assert.equal(config.proactive.maxPerDay, 1)
})
