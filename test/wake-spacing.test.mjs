/**
 * wake-spacing.test.mjs —— 一天的几次叫醒不该一分钟一个地连着发（2026-10-29）。
 *
 * 真机：daily.events=2、wakesPerDay=4 时，落点一到，tick 每分钟都问 plan()，
 * plan() 每次都说「还没满，醒」，于是第二次叫醒在第一次之后一分钟进同一个会话。
 * 连带两处「处境被收走」：
 *   - 叫醒排在她正在说的那一轮后面时，watcher 认会话不认这一轮，
 *     那一轮的 turn/end 先把 fish:wake 清掉，真正醒来的那一轮什么都看不到；
 *   - 90 秒兜底不管这一轮结束没有，到点就清（读字幕、看画面常常超过 90 秒）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startScheduler, nextWakeAt, wakeRetryBlocked } from '../lib/scheduler.js'
import { appendEvent, readEvents, writeConfig } from '../lib/store.js'
import { normalizeConfig, dateKey } from '../lib/settings.js'
import { getWakeSection, clearWakeSection } from '../lib/identity.js'
import { registerCapture } from '../lib/capture.js'
import { inWake } from '../lib/wakewin.js'

const at = (h, m, day = 29) => new Date(2026, 9, day, h, m).getTime()
const wakeEv = (t, dk = '2026-10-29') => ({ type: 'meta', text: `wake:${dk} x`, ts: new Date(t).toISOString() })
const cfgA = { window: ['10:00', '03:00'], daily: { events: 2 }, wakesPerDay: 4 }

test('nextWakeAt：今天还没醒过不拦；醒过之后把剩下的摊到时段结束前', () => {
  assert.equal(nextWakeAt([], cfgA, '2026-10-29'), 0)
  // 跨零点的时段在 21:39 醒过：摊到当天午夜前（过了零点日期一换，计数从头算）
  assert.equal(nextWakeAt([wakeEv(at(21, 39))], cfgA, '2026-10-29'), at(21, 39) + (at(24, 0) - at(21, 39)) / 2)
  // 不跨零点：摊到时段结束前
  assert.equal(nextWakeAt([wakeEv(at(14, 0))], { ...cfgA, window: ['08:00', '23:00'] }, '2026-10-29'), at(18, 30))
  // 跨零点而这次是零点后醒的：时段在今天之内结束
  assert.equal(nextWakeAt([wakeEv(at(1, 0))], cfgA, '2026-10-29'), at(2, 0))
  // 太晚了也至少隔 45 分钟
  assert.equal(nextWakeAt([wakeEv(at(23, 40))], cfgA, '2026-10-29'), at(23, 40) + 45 * 60_000)
  // 配额满了交给 plan()；昨天的叫醒不算
  assert.equal(nextWakeAt([wakeEv(at(12, 0)), wakeEv(at(18, 0))], cfgA, '2026-10-29'), 0)
  assert.equal(nextWakeAt([wakeEv(at(12, 0), '2026-10-28')], cfgA, '2026-10-29'), 0)
})

// ---- 真的跑 tick：假宿主 + 临时状态库，时间用 Date.now 偏移推进 ----

/**
 * 假宿主。
 *
 * 2026-11-04（用户 m00428）起，叫醒不再走 `sessionController.prompt()` ——
 * 宿主的 `prompt()` 内部写死 `source.kind = 'user'`，那条消息在前端永远是一句
 * 「他打的字」，我们怎么盖都盖不掉（详见 `lib/deliver.js` 顶部注释）。
 * 现在走 `resolveAgent()` → `agent.followup(message)`，所以这个假宿主必须
 * 同时提供这两步，否则每次叫醒都会在 deliver.js 里抛「宿主没有 resolveAgent」。
 *
 * `prompts` 记的仍然是「这一次递进去的东西」：`req.sessionId` 是拿 agent 用的那个 id，
 * `text` 是正文，`section` 是递进来的那一刻的处境段（正是 wake() 刚挂上去的那份）。
 */
function fakeHost(onCreate) {
  const listeners = []
  const prompts = []
  const ctx = {
    on: (ev, fn) => {
      if (ev !== 'session/event') return () => {}
      listeners.push(fn)
      return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1) }
    },
    sessionController: {
      create: async () => { await onCreate?.(); throw new Error('exists') },
      resolveAgent: async (sessionId) => {
        // 2026-11-05（用户 m03265）：叫醒不再靠 `create({ sessionId })` 探会话在不在，
        // 改成 resolveAgent 探活。所以「准备叫醒的这几秒里她刚好开始了别的一轮」
        // 这个时机要挂在探活上 —— 挂 create 上的话那条用例就永远不触发了。
        await onCreate?.()
        return {
          agent: {
            followup: (message) => {
              prompts.push({ req: { sessionId, message }, text: message?.content?.[0]?.text, section: getWakeSection() })
            },
          },
        }
      },
    },
  }
  const emit = (type) => { for (const fn of [...listeners]) fn({ id: 's-main' }, { type }) }
  return { ctx, prompts, emit, listeners }
}

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fish-wake-'))
  const oldHomes = process.env.DSH_FISH_HOMES
  process.env.DSH_FISH_HOMES = join(root, 'homes.json')
  const realNow = Date.now
  const realST = globalThis.setTimeout
  let offset = 0
  Date.now = () => realNow() + offset
  // 等她说完的轮询（2s）、兜底重试（30s）、兜底（90s）压成几毫秒，其余定时器不动
  globalThis.setTimeout = (f, ms, ...a) => realST(f, [2000, 30_000, 90_000].includes(ms) ? 5 : ms, ...a)
  try {
    await writeConfig(normalizeConfig({
      window: ['00:00', '23:59'],
      daily: { events: 2 },
      wakesPerDay: 4,
      browse: { enabled: false },
      comment: { enabled: false },
      rules: { offers: false },
      memory: { sleepEveryDays: 0 },
    }), root)
    // 今天的落点挪到 10 分钟前
    await appendEvent({ type: 'meta', text: `sched:${dateKey()} ${new Date(realNow() - 10 * 60_000).toISOString()}` }, { day: 0, stage: 1, source: 'timer' }, root)
    return await fn(root, { advance: (ms) => { offset += ms }, sleep: (ms) => new Promise((r) => realST(r, ms)) })
  } finally {
    Date.now = realNow
    globalThis.setTimeout = realST
    clearWakeSection()
    if (oldHomes === undefined) delete process.env.DSH_FISH_HOMES
    else process.env.DSH_FISH_HOMES = oldHomes
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

test('wakeRetryBlocked：刚失败过要隔开，一天最多试三次，别的日子不算', () => {
  const dk = '2026-10-29'
  const fail = (t, day = dk) => ({ type: 'meta', text: `wakefail:${day} 屋子没接上`, ts: new Date(t).toISOString() })
  const now = at(12, 0)
  assert.equal(wakeRetryBlocked([], dk, now), false)
  assert.equal(wakeRetryBlocked([fail(now - 60_000)], dk, now), true, '一分钟前刚失败')
  assert.equal(wakeRetryBlocked([fail(now - 46 * 60_000)], dk, now), false, '隔够了可以再试')
  assert.equal(wakeRetryBlocked([fail(at(8, 0)), fail(at(9, 0)), fail(at(10, 0))], dk, now), true, '第三次之后今天不再试')
  assert.equal(wakeRetryBlocked([fail(at(8, 0), '2026-10-28'), fail(at(9, 0), '2026-10-28'), fail(at(10, 0), '2026-10-28')], dk, now), false, '昨天的不算')
  assert.equal(wakeRetryBlocked([{ type: 'meta', text: `wake:${dk} x`, ts: new Date(now - 1000).toISOString() }], dk, now), false, '成功的叫醒不算')
})

test('叫醒一直失败：不再每分钟试一次、写一行', async () => {
  await withRoot(async (root, { advance }) => {
    const h = fakeHost()
    h.ctx.sessionController.resolveAgent = async () => { throw new Error('会话没了') }
    const s = startScheduler(h.ctx, { root, sessionId: 's-main', log: () => {} })
    try {
      for (let i = 0; i < 5; i++) {
        await s.tick()
        advance(61_000)
      }
      const { events } = await readEvents(root)
      assert.equal(events.filter((e) => e.type === 'meta' && String(e.text).startsWith('wakefail:')).length, 1, '45 分钟内只试一次')
      assert.equal(h.prompts.length, 0)
    } finally {
      s.dispose()
    }
  })
})

test('落点之后不再一分钟一个地连着叫；第二次等时间到、也等她说完', async () => {
  await withRoot(async (root, { advance, sleep }) => {
    const h = fakeHost()
    const s = startScheduler(h.ctx, { root, sessionId: 's-main', log: () => {} })
    try {
      await s.tick()
      assert.equal(h.prompts.length, 1, '落点到了醒第一次')
      assert.match(h.prompts[0].section, /叫醒你的信号/)
      h.emit('turn/start'); h.emit('turn/end')
      assert.equal(getWakeSection(), '', '这一轮结束处境撤掉')

      advance(61_000); await s.tick()
      assert.equal(h.prompts.length, 1, '一分钟后不该再叫（修之前这里会醒第二次）')

      const { events } = await readEvents(root)
      const due = nextWakeAt(events, { window: ['00:00', '23:59'], daily: { events: 2 }, wakesPerDay: 4 }, dateKey())
      assert.ok(due >= Date.now() + 40 * 60_000, '第二次至少隔开几十分钟')

      advance(due - Date.now() + 1000)
      h.emit('turn/start') // 到点时她正在跟人说话
      await s.tick()
      assert.equal(h.prompts.length, 1, '她正在说话：先不叫')
      h.emit('turn/end')
      advance(61_000); await s.tick()
      assert.equal(h.prompts.length, 2, '她说完了再叫第二次')

      h.emit('turn/start') // 第二次醒来的这一轮迟迟没结束
      await sleep(40)
      assert.notEqual(getWakeSection(), '', '90 秒兜底到点但这一轮还在：处境不抽走')
      h.emit('turn/end')
      assert.equal(getWakeSection(), '', '这一轮结束才撤')

      advance(6 * 3600_000); await s.tick()
      assert.equal(h.prompts.length, 2, '配额满了不再叫')
      await sleep(30)
      assert.equal(h.listeners.length, 1, '叫醒用的监听用完就摘，只剩忙闲监听')
    } finally {
      s.dispose()
    }
    assert.equal(h.listeners.length, 0, 'dispose 摘掉忙闲监听')
  })
})

test('叫醒准备的几秒里她刚好开始了别的一轮：等那一轮说完再挂处境', async () => {
  await withRoot(async (root, { sleep }) => {
    let h
    // 一次叫醒调两次 resolveAgent（探活、投递），这个时机只该在探活那一拍发生。
    // 发两遍的话，第二个 turn/end 要等本条结束后才来，这次叫醒的窗口就漏进后面的用例。
    let fired = false
    h = fakeHost(async () => {
      if (fired) return
      fired = true
      h.emit('turn/start')
      setTimeout(() => h.emit('turn/end'), 60)
    })
    const s = startScheduler(h.ctx, { root, sessionId: 's-main', log: () => {} })
    try {
      await s.tick()
      assert.equal(h.prompts.length, 1)
      assert.match(h.prompts[0].section, /叫醒你的信号/, '叫的时候处境还在，没被那一轮的 turn/end 收走')
      // 那一轮的 turn/end 是 60ms 后才来的：等它落地再收摊。
      // 以前这里一断言完就 dispose，监听被摘掉、busy 表里这条会话永远算「在忙」，
      // 兜底定时器就一直重排，进程级的叫醒窗口跟着泄漏到下一个用例。
      await sleep(90)
    } finally {
      s.dispose()
    }
  })
})

test('调度器收摊之后兜底不再重排：叫醒窗口当场关上', async () => {
  await withRoot(async (root, { sleep }) => {
    const h = fakeHost()
    const s = startScheduler(h.ctx, { root, sessionId: 's-main', log: () => {} })
    await s.tick()
    assert.equal(h.prompts.length, 1)
    assert.equal(inWake(), true)
    s.dispose()
    await sleep(30)
    assert.equal(inWake(), false, '收摊之后窗口不许一直开着')
  })
})

// ---- 叫醒必须跟着「屋子现在那条会话」走，不能跟着启动那一刻的快照 ----
// 2026-11-03（用户 m01596 与随后一条补充反馈）：满 40 轮自动换会话之后，
// 自动醒一醒还发进旧对话，手动点一次却会落到新对话。
// 差别就在落点怎么定：wakeNow 一直是现取 talkSessionId()，wake() 却先看
// deps.sessionId——那是 index.js 启动时抄下来的 home.json 快照，轮换之后过期了。
test('换过会话之后，自动醒一醒也要落到新会话（不是启动时那份快照）', async () => {
  await withRoot(async (root) => {
    // home.json 已经指向新房间（轮换后的样子），而调度器手里还是旧 id
    await writeFile(join(root, 'home.json'), JSON.stringify({
      wsId: 'ws-1',
      sessionId: 's-new-room',
      title: '跟大肥鱼说话',
      createdAt: new Date().toISOString(),
      turns: 0,
      rotatedFrom: 's-main',
      rotatedAt: new Date().toISOString(),
    }, null, 2))

    const h = fakeHost()
    const s = startScheduler(h.ctx, { root, sessionId: 's-main', log: () => {} })
    try {
      await s.tick()
      assert.equal(h.prompts.length, 1, '该醒一次')
      assert.equal(h.prompts[0].req.sessionId, 's-new-room', '落在屋子现在那条，不是启动时的 s-main')
    } finally {
      s.dispose()
    }
  })
})

// ---- 唤醒时间窗（wakewin）：叫醒那一轮里她写的话不算「他来过」 ----
// prompt() 入队就返回。原来用 withWake 包住 prompt()，窗口在她开口之前就关了，
// 于是她醒来写的每一句都落一条 seen:，冷落检测量成了「她写没写话」。

const seenCount = async (root) => (await readEvents(root)).events.filter((e) => e.type === 'meta' && String(e.text).startsWith('seen:')).length
function growthCommit(root) {
  const regs = new Map()
  registerCapture({ tools: { register: (spec) => { regs.set(spec.name, spec); return () => {} } } }, { root })
  return regs.get('growth_commit')
}

test('叫醒那一轮里她写的话不记 seen:；这一轮结束后窗口关上', async () => {
  await withRoot(async (root) => {
    const h = fakeHost()
    const s = startScheduler(h.ctx, { root, sessionId: 's-main', log: () => {} })
    const commit = growthCommit(root)
    try {
      await s.tick()
      assert.equal(h.prompts.length, 1)
      h.emit('turn/start')
      assert.equal(inWake(), true, 'prompt() 已经返回，她这一轮才开始：窗口还开着')
      assert.equal((await commit.execute({ type: 'utterance', text: '醒了，外面在下雨。' })).ok, true)
      assert.equal(await seenCount(root), 0, '叫醒那一轮里写的话不算他来过（修之前这里是 1）')
      h.emit('turn/end')
      assert.equal(inWake(), false, '这一轮结束，窗口关上')
      await commit.execute({ type: 'utterance', text: '刚才那件事我想明白了。' })
      assert.equal(await seenCount(root), 1, '窗口外写的照旧记 seen:')
    } finally {
      s.dispose()
    }
  })
})

test('turn/end 一直不来、她也不在忙：兜底把窗口和处境一起关上', async () => {
  await withRoot(async (root, { sleep }) => {
    const h = fakeHost()
    const s = startScheduler(h.ctx, { root, sessionId: 's-main', log: () => {} })
    try {
      await s.tick()
      assert.equal(h.prompts.length, 1)
      assert.equal(inWake(), true)
      await sleep(40)
      assert.equal(getWakeSection(), '', '兜底到点：处境撤掉')
      assert.equal(inWake(), false, '兜底到点：窗口也关上，不会一直开着')
    } finally {
      s.dispose()
    }
  })
})

// ---- issue #36：排队叫醒的处境不能被**别的回合**的 turn/end 收走 ----
// 手动「叫她一次」时她正忙：投递走 agent.followup，宿主把它排进 next-turn，
// 当前这一轮先 turn/end，再开真正醒来那一轮。以前的 watcher 认会话不认回合，
// 于是那个 turn/end 一到就把 fish:wake 处境清掉——她真正醒来时处境是空的。
// 修法：监听挂上之后必须先见到本条会话的 turn/start，之后的 turn/end 才算数。
test('排队叫醒：前一轮的 turn/end 不许把处境收走，要等我们自己这一轮（issue #36）', async () => {
  await withRoot(async (root) => {
    const h = fakeHost()
    const s = startScheduler(h.ctx, { root, sessionId: 's-main', log: () => {} })
    try {
      await s.tick()
      assert.equal(h.prompts.length, 1, '落点到了醒第一次')
      const before = getWakeSection()
      assert.match(before, /叫醒你的信号/, '投递时处境在')

      // 上一轮（不是我们叫醒的这一轮）结束：没有 turn/start，不该算数
      h.emit('turn/end')
      assert.equal(getWakeSection(), before, '前一轮的 turn/end 把处境收走了（issue #36 的 bug）')
      assert.equal(inWake(), true, '窗口也得还开着')

      // 真正醒来那一轮
      h.emit('turn/start')
      assert.equal(inWake(), true, '我们这一轮开始了，窗口撑到它结束')
      h.emit('turn/end')
      assert.equal(getWakeSection(), '', '这一轮结束才撤处境')
      assert.equal(inWake(), false, '窗口跟着关上')
    } finally {
      s.dispose()
    }
  })
})

test('消息没送进去：窗口当场关上', async () => {
  await withRoot(async (root) => {
    const h = fakeHost()
    // 使唤不动宿主：拿不到 agent（比「投递时抛错」更早失败，正是真机上最常见的一种）
    h.ctx.sessionController.resolveAgent = async () => ({ error: new Error('host down') })
    const s = startScheduler(h.ctx, { root, sessionId: 's-main', log: () => {} })
    try {
      await s.tick()
      assert.equal(inWake(), false)
    } finally {
      s.dispose()
    }
  })
})
