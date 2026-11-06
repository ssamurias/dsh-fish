/**
 * turns.test.mjs —— 侧栏里直接跟她说话，也算一轮（issue #6）
 *
 * 这一组守五件事：
 *   ① 来源判据：真人打的（带 clientTimeZone）/ 插件 prompt 的（wake-/say- 前缀、
 *      无时区）/ 宿主拼的上下文（kind 不是 user）分得清；
 *   ② 真机会话事件的形态能取到正文（content 数组里的 text 块）；
 *   ③ 她屋里那一轮的 turn/end 结账：turns +1、原话进 talkmem；
 *   ④ 不是她屋里、或者不是人打的，一律不涨轮数；
 *   ⑤ 满 rotateAfter 就换会话，事件流里留一条 meta。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { classifyMessage, messageText, assistantText, registerTurns } from '../lib/turns.js'
import { homeStatus } from '../lib/home.js'
import { appendEvent, readEvents, writeAtomic, paths } from '../lib/store.js'
import { recentExchanges } from '../lib/talkmem.js'
import { deriveSelf } from '../lib/derive.js'

const HER_SESSION = 's-her'

async function tmpRoot(home = {}) {
  const root = await mkdtemp(join(tmpdir(), 'fish-turns-'))
  const seed = {
    wsId: 'ws-1',
    sessionId: HER_SESSION,
    createdAt: '2026-10-28T00:00:00.000Z',
    turns: 0,
    ...home,
  }
  await writeAtomic(join(paths(root).root, 'home.json'), JSON.stringify(seed, null, 2))
  return root
}

async function writeCfg(root, patch) {
  await writeAtomic(paths(root).config, JSON.stringify(patch, null, 2))
}

/** 假宿主：只要一条事件总线 + 会话服务 */
function fakeCtx() {
  const handlers = new Map()
  const created = []
  const renamed = []
  const prompted = []
  const ctx = {
    on(ev, fn) {
      const set = handlers.get(ev) ?? new Set()
      set.add(fn)
      handlers.set(ev, set)
      return () => set.delete(fn)
    },
    emit(ev, ...args) {
      for (const fn of handlers.get(ev) ?? []) fn(...args)
    },
    sessionController: {
      async create() {
        const id = `s-new-${created.length + 1}`
        created.push(id)
        return { sessionId: id }
      },
      async rename(arg) {
        renamed.push(arg)
      },
      // 2026-10-31（issue #14 第二报）：轮换后要叫醒新会话。
      // 宿主这边要 list 判空、prompt 出声；两个都给出来，才走得到 markWoke。
      async list() {
        return { items: [{ sessionId: 's-new-1', blank: true }] }
      },
      async prompt(arg, signal) {
        if (!signal || typeof signal.throwIfAborted !== 'function') {
          // 真宿主这里会抛（issue #1），测试里也照着抛，免得漏传 signal 又悄悄通过
          throw new Error('Cannot read properties of undefined (reading \'throwIfAborted\')')
        }
        prompted.push(arg)
        return { ok: true }
      },
    },
    get: () => null,
  }
  return { ctx, created, renamed, prompted }
}

const session = (id = HER_SESSION) => ({ header: { id }, id })

/** 真机形态：source 带 clientTimeZone —— 只有客户端亲手打的字才有 */
function humanMsg(text, extra = {}) {
  return {
    type: 'user/message',
    data: {
      id: `m-${Math.random().toString(36).slice(2)}`,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user', rpcId: 'rpc-aa1', clientTimeZone: 'Asia/Shanghai', ...extra },
    },
  }
}

/** 我们 prompt 进去的：kind 也是 user，但 rpcId 带前缀、没有时区 */
function pluginMsg(text) {
  return {
    type: 'user/message',
    data: {
      id: 'm-wake',
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user', rpcId: 'wake-1234' },
    },
  }
}

const TURN_END = { type: 'turn/end' }

/**
 * 宿主里她自己说出口的话（2026-11-01）。
 * 真机形态见 dsh-agent-loop/lib/index.js:1098：
 *   { turn, step, message:{id,role:'assistant',content:[{type:'text'|'reasoning',text}]}, interrupted }
 */
function herMsg(blocks, extra = {}) {
  return {
    type: 'assistant/message',
    data: {
      turn: 1,
      step: 1,
      message: {
        id: extra.id ?? `a-${Math.random().toString(36).slice(2)}`,
        role: 'assistant',
        content: blocks,
      },
      ...extra,
    },
  }
}

// 全量跑时这个文件会和别的测试文件并行，CPU 一挤，3 秒就不够了
// （2026-10-28 全量回归里偶发超时，单跑必过）。放宽到 15 秒，只在真卡住时才失败。
async function waitFor(fn, timeout = 15000) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > timeout) throw new Error('等超时了：条件一直没成立')
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** 给异步结账留一点时间，再断言"确实没记" */
async function settled() {
  await new Promise((r) => setTimeout(r, 80))
}

test('来源判据：真人 / 插件 / 上下文 / 外渠道 分得清', () => {
  assert.equal(classifyMessage({ source: { kind: 'user', rpcId: 'uuid-1', clientTimeZone: 'Asia/Shanghai' } }), 'human')
  assert.equal(classifyMessage({ source: { kind: 'user', rpcId: 'wake-abc' } }), 'plugin')
  assert.equal(classifyMessage({ source: { kind: 'user', rpcId: 'say-abc' } }), 'plugin')
  // 2026-11-06：换会话前问她留不留话那条也要认出来。原来 PLUGIN_RPC 漏了
  // carry，它掉进 unknown 分支——不进轮数（对），但每换一次会话就多一行
  // 「这条消息认不出来源」的日志。
  assert.equal(classifyMessage({ source: { kind: 'user', rpcId: 'carry-ask-1700000000000' } }), 'plugin')
  assert.equal(classifyMessage({ source: { kind: 'runtime-context' } }), 'context')
  assert.equal(classifyMessage({ source: { kind: 'skill-catalog' } }), 'context')
  assert.equal(classifyMessage({ source: { kind: 'plugin:hindsight' } }), 'context')
  assert.equal(classifyMessage({}), 'context')
  // 老客户端 / 别的插件灌的：没有时区，分不清就不算——宁可少算一轮
  assert.equal(classifyMessage({ source: { kind: 'user', rpcId: 'uuid-2' } }), 'unknown')

  // 2026-11-03（issue #18）：外渠道注入的消息是他打的字，不能当上下文吞掉。
  // 宿主的 v4 校验不限制 kind 取值（非空、≠'plugin' 即可），所以只能做机器侧黑名单：
  // 表里没有的 kind 一律当人，否则每接一个桥就漏一个。
  assert.equal(classifyMessage({ source: { kind: 'qq' } }), 'human')
  assert.equal(classifyMessage({ source: { kind: 'telegram' } }), 'human')
  assert.equal(classifyMessage({ source: { kind: 'some-future-bridge' } }), 'human')
  // 认得的机器侧 kind 仍要挡掉（schedule 另有 schedule.test.mjs 钉着）
  assert.equal(classifyMessage({ source: { kind: 'schedule' } }), 'context')
  assert.equal(classifyMessage({ source: { kind: 'system-prompt' } }), 'context')
  assert.equal(classifyMessage({ source: { kind: 'tool' } }), 'context')
  assert.equal(classifyMessage({ source: { kind: 'plugin:whatever' } }), 'context')

  // 2026-11-03（多间房）：群聊里的字不是"他来找过你"。
  // 桥注入时把场次写在 source.scene 上，判据在 kind 之后立刻认它——
  // 先于 human，否则群里几百句会把轮数与冷落检测一起冲掉。
  assert.equal(classifyMessage({ source: { kind: 'qq', scene: 'group' } }), 'group')
  assert.equal(classifyMessage({ source: { kind: 'user', scene: 'group' } }), 'group')
  // 私聊与书房仍算人：私聊就是"融合"那个选项，不能因为带 scene 就不算
  assert.equal(classifyMessage({ source: { kind: 'qq', scene: 'private' } }), 'human')
  assert.equal(classifyMessage({ source: { kind: 'user', rpcId: 'uuid-5', clientTimeZone: 'Asia/Shanghai', scene: 'desk' } }), 'human')
})

test('来源判据：宿主拼的上下文和通知都不算人（2026-11-05）', () => {
  // 形状抄自宿主 0.2.2-rc.1 写 source 的地方
  for (const source of [
    { kind: 'time-context', form: 'snapshot', sections: [] },
    { kind: 'tmux-context', form: 'snapshot', sections: [] },
    { kind: 'model-selection', form: 'notice', summary: 'a → b' },
    { kind: 'tool-jobs', form: 'notice', summary: 'done' },
    { kind: 'plan-mode', form: 'notice', summary: 'on' },
    { kind: 'action-cards', form: 'notice', through: 1 },
    { kind: 'agent-instructions', form: 'instructions', changes: [] },
    { kind: 'session-reference', form: 'recall', version: 1, references: [] },
    { kind: 'skill-catalog', form: 'catalog', entries: [] },
    { kind: 'working-directory' },
    { kind: 'cordis-host-runner' },
    { kind: 'ptc-mode' },
    { kind: 'user-approval' },
    { kind: 'agent-message', form: 'relay', senderSessionId: 's-1' },
    { kind: 'compact-checkpoint' },
    { kind: 'goal' },
    { kind: 'team-message' },
    { kind: 'bili-humanism-post-viewing-question' },
    { kind: 'bili-humanism-personality-review' },
    { kind: 'bili-humanism-shadow-review' },
    // 这几种没有单列，只靠 form 挡住，钉一下
    { kind: 'subagent-settled', form: 'notice' },
    { kind: 'skill-invocation', form: 'instructions' },
    { kind: 'repeat-tool-reminder', form: 'notice' },
    { kind: 'tool-goal', form: 'notice' },
    { kind: 'webhook', form: 'notice' },
    // 宿主以后加的新上下文：kind 没见过，但 form 认得
    { kind: 'future-a', form: 'snapshot' },
    { kind: 'future-b', form: 'notice' },
    { kind: 'future-c', form: 'catalog' },
    { kind: 'future-d', form: 'instructions' },
    { kind: 'future-e', form: 'recall' },
  ]) {
    assert.equal(classifyMessage({ source }), 'context', source.kind)
  }
  // 反过来：外渠道和人答的问题不能被这一条误伤（#18）
  assert.equal(classifyMessage({ source: { kind: 'qq' } }), 'human')
  assert.equal(classifyMessage({ source: { kind: 'qq', form: 'relay' } }), 'human')
  assert.equal(classifyMessage({ source: { kind: 'user-question-reply', callId: 'c-1', outcome: 'answered' } }), 'human')
})

test('宿主每轮的时间快照不涨轮数、不记他来过、不换房（2026-11-05）', async () => {
  const root = await tmpRoot()
  try {
    await writeCfg(root, { chat: { rotateAfter: 3 }, memory: { hearEvery: 1 } })
    const { ctx, created } = fakeCtx()
    const off = registerTurns(ctx, { root, log: () => {} })
    try {
      const timeContext = (text) => ({
        type: 'user/message',
        data: {
          id: `m-${Math.random().toString(36).slice(2)}`,
          role: 'user',
          content: [{ type: 'text', text }],
          source: { kind: 'time-context', form: 'snapshot', sections: [{ name: 'time-context', text }] },
        },
      })
      // 真机一轮桥接消息的形状：不带时区的 user，再加一条时间快照。
      // 她那条会话和别的会话里都会出现，两边都不能算他来过。
      for (let i = 0; i < 6; i += 1) {
        ctx.emit('session/event', session(), {
          type: 'user/message',
          data: { id: `im-${i}`, role: 'user', content: [{ type: 'text', text: `桥接 ${i}` }], source: { kind: 'user', rpcId: `im-qq-${i}` } },
        })
        ctx.emit('session/event', session(), timeContext(`当前时间 12:0${i}`))
        ctx.emit('session/event', session('s-other'), timeContext(`当前时间 12:0${i}`))
        ctx.emit('session/event', session(), TURN_END)
        await settled()
      }

      assert.equal((await homeStatus(root)).turns, 0, '时间快照不是一轮人话')
      assert.equal((await homeStatus(root)).sessionId, HER_SESSION, '不能因为时间快照换房')
      assert.equal(created.length, 0, '不该建新会话')
      const { events } = await readEvents(root)
      assert.equal(events.filter((e) => e.type === 'meta' && String(e.text).startsWith('seen:')).length, 0, '不算他来过')
      assert.equal(events.filter((e) => e.type === 'heard').length, 0, '「当前时间」不是他说的话')
    } finally {
      off()
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('人话后面跟时间快照：只算一轮，记的是人话（2026-11-05）', async () => {
  const root = await tmpRoot()
  try {
    await writeCfg(root, { memory: { hearEvery: 1 } })
    const { ctx } = fakeCtx()
    const off = registerTurns(ctx, { root, log: () => {} })
    try {
      ctx.emit('session/event', session(), humanMsg('今天想和你说说那部电影的结尾'))
      ctx.emit('session/event', session(), {
        type: 'user/message',
        data: { id: 'm-time', role: 'user', content: [{ type: 'text', text: '当前时间 12:00' }], source: { kind: 'time-context', form: 'snapshot', sections: [] } },
      })
      await settled()
      ctx.emit('session/event', session(), herMsg([{ type: 'text', text: '好，我听着。' }]))
      ctx.emit('session/event', session(), TURN_END)
      await waitFor(async () => (await homeStatus(root)).turns === 1)
      await settled()

      const { events } = await readEvents(root)
      assert.equal(events.filter((e) => e.type === 'meta' && String(e.text).startsWith('seen:')).length, 1, '他来过一次')
      const heard = events.filter((e) => e.type === 'heard')
      assert.ok(heard.length <= 1)
      for (const h of heard) assert.ok(!String(h.text).includes('当前时间'), '时间快照不进他说的话')
      const exchanges = await recentExchanges(root)
      assert.equal(exchanges.length, 1)
      assert.ok(!String(exchanges[0].me).includes('当前时间'), 'talkmem 里只有他的话')
    } finally {
      off()
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('不带时区的 user 轮和叫醒轮不结账：她说的话不写成聊天行（2026-11-05）', async () => {
  const root = await tmpRoot()
  try {
    const { ctx } = fakeCtx()
    const off = registerTurns(ctx, { root, log: () => {} })
    try {
      const context = (id, source) => ({ type: 'user/message', data: { id, role: 'user', content: [{ type: 'text', text: '上下文' }], source } })
      ctx.emit('session/event', session(), { type: 'user/message', data: { id: 'im-1', role: 'user', content: [{ type: 'text', text: '桥接来的话' }], source: { kind: 'user', rpcId: 'im-qq-1' } } })
      ctx.emit('session/event', session(), context('t-1', { kind: 'time-context', form: 'snapshot', sections: [] }))
      await settled()
      ctx.emit('session/event', session(), herMsg([{ type: 'text', text: '这句没有人在等。' }]))
      ctx.emit('session/event', session(), TURN_END)
      await settled()

      ctx.emit('session/event', session(), context('w-1', { kind: 'fish-wake' }))
      ctx.emit('session/event', session(), context('c-1', { kind: 'compact-checkpoint' }))
      await settled()
      ctx.emit('session/event', session(), herMsg([{ type: 'text', text: '醒来自己说的。' }]))
      ctx.emit('session/event', session(), TURN_END)
      await settled()

      assert.equal((await homeStatus(root)).turns, 0)
      assert.deepEqual(await recentExchanges(root), [])
      const { events } = await readEvents(root)
      assert.equal(events.filter((e) => e.type === 'utterance').length, 0, '这两种轮都不写聊天行')
      assert.equal(events.filter((e) => e.type === 'meta' && String(e.text).startsWith('seen:')).length, 0)
    } finally {
      off()
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('正文提取：真机 content 数组、老宿主 data.text 都兜得住', () => {
  assert.equal(messageText({ content: [{ type: 'text', text: '今天想说什么' }] }), '今天想说什么')
  assert.equal(messageText({ content: [{ type: 'text', text: '一' }, { type: 'text', text: '二' }] }), '一\n二')
  assert.equal(messageText({ text: ' 就这么一句 ' }), ' 就这么一句 ')
  assert.equal(messageText({ content: '字符串正文' }), '字符串正文')
  assert.equal(messageText({ message: { content: '包了一层' } }), '包了一层')
  assert.equal(messageText({}), '')
  assert.equal(messageText(null), '')
})

test('她说出口的话：只收 text 块，reasoning 不算她说的话', () => {
  assert.equal(
    assistantText({ message: { content: [{ type: 'text', text: '我把窗开着吧。' }] } }),
    '我把窗开着吧。',
  )
  // 她脑子里的嘀咕不能进「上次我们说到这」——那不是她开口说的
  assert.equal(
    assistantText({
      message: {
        content: [
          { type: 'reasoning', text: '他心里大概是想让我问一句。' },
          { type: 'text', text: '外面下雨了吗？' },
        ],
      },
    }),
    '外面下雨了吗？',
  )
  assert.equal(
    assistantText({ message: { content: [{ type: 'text', text: '第一句' }, { type: 'text', text: '第二句' }] } }),
    '第一句\n第二句',
  )
  // 只有 reasoning 的一轮：她没说出口，取到空
  assert.equal(assistantText({ message: { content: [{ type: 'reasoning', text: '想想' }] } }), '')
  assert.equal(assistantText({ message: { content: '字符串兜底' } }), '字符串兜底')
  assert.equal(assistantText({}), '')
  assert.equal(assistantText(null), '')
})

test('她屋里真人说一句 → turn/end 结账：turns +1、原话进 talkmem', async () => {
  const root = await tmpRoot()
  try {
    await writeCfg(root, { chat: { rotateAfter: 40 } })
    const { ctx } = fakeCtx()
    const off = registerTurns(ctx, { root, log: () => {} })
    try {
      ctx.emit('session/event', session(), humanMsg('今天外面下雨了'))
      // 等她那条人话把 pending 认下来（sinceId 记的是"这一轮开始前"的位置）
      await settled()
      await appendEvent({ type: 'utterance', text: '那我把窗开着' }, { day: 0, stage: 1, source: 'system' }, root)

      ctx.emit('session/event', session(), TURN_END)
      await waitFor(async () => (await homeStatus(root)).turns === 1)

      const list = await recentExchanges(root)
      assert.equal(list.length, 1, '换会话时要搬的那几句里得有这一轮')
      assert.match(list[0].me, /今天外面下雨了/)
      assert.match(list[0].her, /那我把窗开着/, '她那一轮说的话要一起记下来')
    } finally {
      off()
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('她在侧栏里说出口的话，也要进 talkmem（原来 her 永远是空的）', async () => {
  const root = await tmpRoot()
  try {
    await writeCfg(root, { chat: { rotateAfter: 40 } })
    const { ctx } = fakeCtx()
    const off = registerTurns(ctx, { root, log: () => {} })
    try {
      ctx.emit('session/event', session(), humanMsg('外面下雨了吗'))
      // 等这一轮真的被认下来（seen 已写进事件流、pending 已建好）再发她的话。
      // 原来只给 80ms：Windows CI 上 onHuman 的读盘还没回来，assistant/message
      // 会按「没有 pending」被丢掉，her 就成了空串（2026-11-06 run 42235339312）。
      await waitFor(async () => {
        const { events } = await readEvents(root)
        return events.some((e) => e.type === 'meta' && String(e.text ?? '').startsWith('seen:'))
      })
      await settled()
      // 宿主把她说的话作为 assistant/message 追加进来（不是 events.jsonl）
      ctx.emit('session/event', session(), herMsg([{ type: 'text', text: '下了，我把窗关上了。' }]))
      ctx.emit('session/event', session(), TURN_END)
      await waitFor(async () => (await homeStatus(root)).turns === 1)

      const list = await recentExchanges(root)
      assert.equal(list.length, 1)
      assert.match(list[0].me, /外面下雨了吗/)
      assert.match(list[0].her, /下了，我把窗关上了/, '她说的原话要跟着这一轮一起存下来')
    } finally {
      off()
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('她在侧栏里说出口的拒绝，要补写成 uncommitted 事件（原来一个字节都不写）', async () => {
  const root = await tmpRoot()
  try {
    await writeCfg(root, { chat: { rotateAfter: 40 } })
    const { ctx } = fakeCtx()
    const off = registerTurns(ctx, { root, log: () => {} })
    try {
      ctx.emit('session/event', session(), humanMsg('方案A和B，你觉得呢'))
      await settled()
      ctx.emit('session/event', session(), herMsg([{ type: 'text', text: '我拒绝B，因为A挺好。' }]))
      ctx.emit('session/event', session(), TURN_END)
      await waitFor(async () => (await homeStatus(root)).turns === 1)

      const { events } = await readEvents(root)
      const said = events.filter((e) => e.type === 'utterance')
      assert.equal(said.length, 1, '这一轮她说的话要落进事件流')
      assert.match(said[0].text, /我拒绝B/)
      assert.deepEqual(said[0].flags, ['uncommitted'], '她没认领过，只留证')
      assert.equal(said[0].source, 'system', '这是插件补写的，不是她调工具写的')
    } finally {
      off()
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('补写的 uncommitted 话只留证：不进信念、不覆盖自我叙述、不改称呼', async () => {
  const root = await tmpRoot()
  try {
    await writeCfg(root, { chat: { rotateAfter: 40 } })
    const { ctx } = fakeCtx()
    const off = registerTurns(ctx, { root, log: () => {} })
    try {
      ctx.emit('session/event', session(), humanMsg('在吗'))
      await settled()
      ctx.emit('session/event', session(), herMsg([{ type: 'text', text: '我一直觉得你叫我小七就行。我拒绝这样。' }]))
      ctx.emit('session/event', session(), TURN_END)
      await waitFor(async () => (await homeStatus(root)).turns === 1)

      const { events } = await readEvents(root)
      const m = deriveSelf(events)
      assert.equal(m.beliefs.length, 0, '没认领的话不该变成信念')
      assert.equal(m.name, null, '没认领的话不该改她怎么叫他')
      assert.equal(m.narrative, null, '没认领的话不该变成她对自己的说法')
      // 但拒绝计数要读到——这正是补写的理由
      assert.equal(m.facts.wont, 1, '「我拒绝」要能被拒绝判定看见')
    } finally {
      off()
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

// 2026-11-02（用户 m01280）：侧栏聊天也是「他来过」，结账时要写一条 meta seen:。
// 以前只有 capture.js / say.js 写，于是纯聊天聊得再多，冷落检测也看不见。
test('在侧栏聊完一轮，要留下「他来过」的 seen 标记（冷落检测只认这个）', async () => {
  const root = await tmpRoot()
  try {
    await writeCfg(root, { chat: { rotateAfter: 40 } })
    const { ctx } = fakeCtx()
    const off = registerTurns(ctx, { root, log: () => {} })
    try {
      ctx.emit('session/event', session(), humanMsg('你在吗'))
      await settled()
      ctx.emit('session/event', session(), herMsg([{ type: 'text', text: '在。' }]))
      ctx.emit('session/event', session(), TURN_END)
      await waitFor(async () => (await homeStatus(root)).turns === 1)

      const { events } = await readEvents(root)
      const seen = events.filter((e) => e.type === 'meta' && String(e.text).startsWith('seen:'))
      assert.equal(seen.length, 1, '一轮只写一条，别每句话都写')
      assert.equal(seen[0].source, 'system', "source 必须是 system，写成 tool 会被 schema 拒掉")
      const at = Date.parse(String(seen[0].text).slice(5))
      assert.ok(Math.abs(Date.now() - at) < 60_000, 'seen 的时间要贴近现在')
    } finally {
      off()
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('这一轮她已经调 growth_commit 认下的那句，不会因为补写又写一遍', async () => {  const root = await tmpRoot()
  try {
    await writeCfg(root, { chat: { rotateAfter: 40 } })
    const { ctx } = fakeCtx()
    const off = registerTurns(ctx, { root, log: () => {} })
    try {
      ctx.emit('session/event', session(), humanMsg('说说你的看法'))
      await settled()
      // 真机顺序：她先在同一个回合里调 growth_commit，事件先落盘；
      // 宿主随后把 assistant/message 推过来。
      await appendEvent(
        { type: 'utterance', text: '我拒绝B。' },
        { day: 1, stage: 1, source: 'tool' },
        root,
      )
      ctx.emit('session/event', session(), herMsg([{ type: 'text', text: '我拒绝B。' }]))
      ctx.emit('session/event', session(), TURN_END)
      await waitFor(async () => (await homeStatus(root)).turns === 1)

      const { events } = await readEvents(root)
      const same = events.filter((e) => e.type === 'utterance' && String(e.text).includes('我拒绝B'))
      assert.equal(same.length, 1, '同一句话不该留两条——会重复计数')
      assert.deepEqual(same[0].flags, [], '留下的应该是她自己认领的那条')
    } finally {
      off()
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('同一条 assistant/message 重放两次，只记一次', async () => {
  const root = await tmpRoot()
  try {
    await writeCfg(root, { chat: { rotateAfter: 40 } })
    const { ctx } = fakeCtx()
    const off = registerTurns(ctx, { root, log: () => {} })
    try {
      ctx.emit('session/event', session(), humanMsg('你在想什么'))
      await settled()
      const one = herMsg([{ type: 'text', text: '想一件很久以前的事。' }], { id: 'a-dup' })
      ctx.emit('session/event', session(), one)
      ctx.emit('session/event', session(), one)
      ctx.emit('session/event', session(), TURN_END)
      await waitFor(async () => (await homeStatus(root)).turns === 1)

      const list = await recentExchanges(root)
      const hits = String(list[0].her).match(/很久以前/g) ?? []
      assert.equal(hits.length, 1, '同一个 message id 的重放不该记成两句')
    } finally {
      off()
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('没有等结账的那一轮（唤醒轮）里她说的话，不算进「他来过」的那几轮', async () => {
  const root = await tmpRoot()
  try {
    await writeCfg(root, { chat: { rotateAfter: 40 } })
    const { ctx } = fakeCtx()
    const off = registerTurns(ctx, { root, log: () => {} })
    try {
      // 定时唤醒：只有她的话 + turn/end，没有人打的字
      ctx.emit('session/event', session(), herMsg([{ type: 'text', text: '醒了，外面在下雨。' }]))
      ctx.emit('session/event', session(), TURN_END)
      await settled()
      assert.equal((await homeStatus(root)).turns, 0)
      assert.deepEqual(await recentExchanges(root), [], '唤醒轮不该留下对话记录')
    } finally {
      off()
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('插件自己 prompt 进去的消息不涨轮数（没有 clientTimeZone）', async () => {
  const root = await tmpRoot()
  try {
    const { ctx } = fakeCtx()
    const off = registerTurns(ctx, { root, log: () => {} })
    try {
      ctx.emit('session/event', session(), pluginMsg('深夜的唤醒'))
      ctx.emit('session/event', session(), TURN_END)
      await settled()
      assert.equal((await homeStatus(root)).turns, 0)
      assert.deepEqual(await recentExchanges(root), [])
    } finally {
      off()
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('不是她屋里那个会话，不记', async () => {
  const root = await tmpRoot()
  try {
    const { ctx } = fakeCtx()
    const off = registerTurns(ctx, { root, log: () => {} })
    try {
      ctx.emit('session/event', session('s-other'), humanMsg('我在别的会话里说话'))
      ctx.emit('session/event', session('s-other'), TURN_END)
      await settled()
      assert.equal((await homeStatus(root)).turns, 0)
      // 2026-11-03（issue #18）：屋子不搬，但「他来过」必须记下来——
      // 否则外渠道（QQ 桥自己建会话）聊一个月，冷落检测还是落一条「他有 N 天没出现」。
      const { events } = await readEvents(root)
      const seen = events.filter((e) => e.type === 'meta' && String(e.text).startsWith('seen:'))
      assert.equal(seen.length, 1, '别的会话里说话，只留一条「他来过」，不进这一轮的记忆')
      assert.equal(seen[0].source, 'system')
    } finally {
      off()
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

// 2026-11-03（github:ssamurias/dsh-fish#18）：QQ 桥之类外渠道注进来的消息，
// source.kind 不是 'user'，原来第一道判据就当 context 吞掉——turns 恒为 1、
// heard 只有一条、冷落检测到点就误记。判据改成机器黑名单后，这条路要真的通。
test('外渠道（qq）注入的消息：算他来过，但不冒充她屋里那一轮', async () => {
  const root = await tmpRoot()
  try {
    const { ctx } = fakeCtx()
    const off = registerTurns(ctx, { root, log: () => {} })
    try {
      // 桥自己建的会话，不是 home.json 那条
      const qqMsg = {
        type: 'user/message',
        data: {
          id: 'qq-1',
          role: 'user',
          content: [{ type: 'text', text: '在 qq 上跟你说句话' }],
          source: { kind: 'qq' },
        },
      }
      ctx.emit('session/event', session('s-qq'), qqMsg)
      ctx.emit('session/event', session('s-qq'), TURN_END)
      await settled()

      // 屋子不动、轮数不涨：那是她的家事，外渠道不该改
      assert.equal((await homeStatus(root)).turns, 0, '外渠道不涨轮数——轮数是「她屋里聊了几轮」')
      assert.equal((await homeStatus(root)).sessionId, HER_SESSION, '别把她的家搬到 qq 那条会话里')
      assert.deepEqual(await recentExchanges(root), [], '外渠道的话不进 talkmem')

      // 但「他来过」必须记上，否则冷落检测是瞎的
      const { events } = await readEvents(root)
      const seen = events.filter((e) => e.type === 'meta' && String(e.text).startsWith('seen:'))
      assert.equal(seen.length, 1, '外渠道说话也要留一条 seen:，这是冷落检测唯一的证据')
      assert.equal(seen[0].source, 'system')
      const at = Date.parse(String(seen[0].text).slice(5))
      assert.ok(Math.abs(Date.now() - at) < 60_000, 'seen 的时间要贴近现在')
    } finally {
      off()
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('群聊里的话：既不算他来过，也不进这一轮', async () => {
  const root = await tmpRoot()
  try {
    const { ctx } = fakeCtx()
    const off = registerTurns(ctx, { root, log: () => {} })
    try {
      const groupMsg = {
        type: 'user/message',
        data: {
          id: 'g-1',
          role: 'user',
          content: [{ type: 'text', text: '群里有人说了句话' }],
          // 桥注入时把场次写在 source 上（AGENTS.md §7.2 第 1 条）
          source: { kind: 'qq', scene: 'group' },
        },
      }
      ctx.emit('session/event', session('s-group'), groupMsg)
      ctx.emit('session/event', session('s-group'), TURN_END)
      await settled()

      assert.equal((await homeStatus(root)).turns, 0, '群聊不涨轮数')
      const { events } = await readEvents(root)
      const seen = events.filter((e) => e.type === 'meta' && String(e.text).startsWith('seen:'))
      // 这条是这轮改动里最容易被改坏的一条：群里一天几百句，
      // 只要有一句写了 seen，他一周不露面面板还显示「今天聊过」，冷落检测就废了。
      assert.equal(seen.length, 0, '群里的话不算他来找过你——一条 seen 都不能写')
    } finally {
      off()
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('认识不出来的来源，日志里要留一行（别静默丢消息）', async () => {
  const root = await tmpRoot()
  const lines = []
  try {
    const { ctx } = fakeCtx()
    const off = registerTurns(ctx, { root, log: (...a) => lines.push(a.join(' ')) })
    try {
      const mystery = {
        type: 'user/message',
        data: {
          id: 'm-1',
          role: 'user',
          content: [{ type: 'text', text: '不知道谁发的' }],
          // kind='user' 但没有时区：老客户端 / 别的插件灌的，判不出来
          source: { kind: 'user', rpcId: 'uuid-9' },
        },
      }
      ctx.emit('session/event', session(), mystery)
      await settled()
      assert.equal((await homeStatus(root)).turns, 0)
      assert.ok(
        lines.some((l) => l.includes('认不出来源')),
        '认不出来源时必须留一行日志，否则用户只能去读源码才知道哪一步断了（issue #18 现场就是这样）',
      )
    } finally {
      off()
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('外渠道连着说三句：seen 只写一条，日志也只打一行（别刷屏）', async () => {
  const root = await tmpRoot()
  const lines = []
  try {
    const { ctx } = fakeCtx()
    const off = registerTurns(ctx, { root, log: (...a) => lines.push(a.join(' ')) })
    try {
      const say = (n) => ({
        type: 'user/message',
        data: {
          id: `qq-${n}`,
          role: 'user',
          content: [{ type: 'text', text: `第 ${n} 句` }],
          source: { kind: 'qq' },
        },
      })
      for (const n of [1, 2, 3]) {
        ctx.emit('session/event', session('s-qq'), say(n))
        ctx.emit('session/event', session('s-qq'), TURN_END)
      }
      await settled()

      const { events } = await readEvents(root)
      const seen = events.filter((e) => e.type === 'meta' && String(e.text).startsWith('seen:'))
      assert.equal(seen.length, 1, '同一分钟里连说几句只写一条 seen')

      // 2026-11-04（用户 m02556）：日志以前写在这个 if 外面，于是三句就是三行。
      // 日志重复到看不出哪条是真的，等于这条日志白写。
      const about = lines.filter((l) => l.includes('认识的会话之外的动静'))
      assert.equal(about.length, 1, '同一分钟里连说几句只该打一行日志，不能刷屏')
    } finally {
      off()
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('认不出来源：同一个 kind 连着丢十条，日志也只留一行', async () => {
  const root = await tmpRoot()
  const lines = []
  try {
    const { ctx } = fakeCtx()
    const off = registerTurns(ctx, { root, log: (...a) => lines.push(a.join(' ')) })
    try {
      const mystery = (n) => ({
        type: 'user/message',
        data: {
          id: `m-${n}`,
          role: 'user',
          content: [{ type: 'text', text: `不知道谁发的 ${n}` }],
          source: { kind: 'user', rpcId: `uuid-${n}` },
        },
      })
      for (let n = 0; n < 10; n += 1) ctx.emit('session/event', session(), mystery(n))
      await settled()

      const about = lines.filter((l) => l.includes('认不出来源'))
      assert.equal(about.length, 1, '同一个 kind 十分钟之内只打一行，免得把日志淹掉')
    } finally {
      off()
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('满 rotateAfter 就换会话，事件流里留一条 meta', async () => {
  const root = await tmpRoot()
  try {
    await writeCfg(root, { chat: { rotateAfter: 1 } })
    const { ctx, created, renamed } = fakeCtx()
    const off = registerTurns(ctx, { root, log: () => {} })
    try {
      ctx.emit('session/event', session(), humanMsg('聊满一轮了'))
      ctx.emit('session/event', session(), TURN_END)

      const h = await waitFor(async () => {
        const st = await homeStatus(root)
        return st.sessionId && st.sessionId !== HER_SESSION ? st : null
      })
      assert.equal(created.length, 1, '只该建一个新会话')
      assert.equal(h.sessionId, 's-new-1')
      assert.equal(h.turns, 0, '换会话后轮数归零')
      // 旧会话改名留档，标题里带「之前」
      assert.equal(renamed[0]?.sessionId, HER_SESSION)
      assert.match(String(renamed[0]?.title ?? ''), /之前$/)

      // home.json 与 events.jsonl 是两条异步写盘线：等事件落盘，别假设它比 home 先落
      const meta = await waitFor(async () => {
        const { events } = await readEvents(root)
        const hits = events.filter(
          (e) => e.type === 'meta' && String(e.text ?? '').startsWith('rotate:'),
        )
        return hits.length === 1 ? hits : null
      })
      assert.equal(meta[0].text, 'rotate:1:s-new-1')
      assert.equal(meta[0].source, 'system')
    } finally {
      off()
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('换会话之后要叫醒新会话，不然人看不见它（issue #14 第二报）', async () => {
  const root = await tmpRoot()
  try {
    await writeCfg(root, { chat: { rotateAfter: 1 } })
    const { ctx, prompted } = fakeCtx()
    const off = registerTurns(ctx, { root })
    try {
      ctx.emit('session/event', session(), humanMsg('聊满一轮了'))
      ctx.emit('session/event', session(), TURN_END)

      // 轮换本身先落地
      await waitFor(async () => {
        const st = await homeStatus(root)
        return st.sessionId && st.sessionId !== HER_SESSION ? st : null
      })
      // 然后是叫醒：宿主的 prompt 得真发出去，且记进 wokeFor（一条会话只叫一次）
      const saved = await waitFor(async () => {
        const raw = JSON.parse(await readFile(join(paths(root).root, 'home.json'), 'utf8'))
        return raw.wokeFor === 's-new-1' ? raw : null
      })
      assert.equal(saved.wokeFor, 's-new-1')
      // 0.8.9 起轮换时还会发一条 `carry-ask-`（问她留不留一句话给下一个房间），
      // 那条不是叫醒。叫醒只认别的。
      const wakes = prompted.filter((p) => !String(p.requestId ?? '').startsWith('carry-'))
      assert.equal(wakes.length, 1, '只该叫一声')
      assert.equal(wakes[0].sessionId, 's-new-1')
      assert.equal(wakes[0].mode, 'queue')
      // 叫醒文本要能让她知道"屋子刚建好"，别是一句空白
      assert.match(String(wakes[0].content?.[0]?.text ?? ''), /醒一醒/)
    } finally {
      off()
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('换会话之后人还在旧的那条里说话 → 屋子认回它，轮数接着涨（issue #14 第二报）', async () => {
  const root = await tmpRoot()
  try {
    // 已经在"刚换过会话"的状态：home 指向新会话，rotatedFrom 记着换下来那条
    await writeCfg(root, { chat: { rotateAfter: 40 } })
    await writeAtomic(
      join(paths(root).root, 'home.json'),
      JSON.stringify(
        {
          wsId: 'ws-1',
          sessionId: 's-new-1',
          createdAt: '2026-10-31T00:50:27.000Z',
          turns: 0,
          rotatedFrom: HER_SESSION,
          rotatedAt: '2026-10-31T00:50:27.000Z',
          carry: [{ me: '上次说到这', her: '嗯' }],
        },
        null,
        2,
      ),
    )

    const { ctx } = fakeCtx()
    const off = registerTurns(ctx, { root, log: () => {} })
    try {
      // 人在旧会话里说话——原来这里会被静默丢掉
      ctx.emit('session/event', session(HER_SESSION), humanMsg('我还在旧窗口里说话'))
      ctx.emit('session/event', session(HER_SESSION), TURN_END)

      const h = await waitFor(async () => {
        const st = await homeStatus(root)
        return st.turns > 0 ? st : null
      })
      assert.equal(h.sessionId, HER_SESSION, '屋子该认回他实际在说话的那条')
      assert.equal(h.turns, 1, '轮数接着数，不该停')
      // 认回来之后这条会话不再是"换下来的"，carry 也不该再粘一遍
      const raw = JSON.parse(await readFile(join(paths(root).root, 'home.json'), 'utf8'))
      assert.equal(raw.rotatedFrom, undefined)
      assert.equal(raw.carry, undefined)
    } finally {
      off()
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('认回只认换下来那条，别的会话照样不记', async () => {
  const root = await tmpRoot({ rotatedFrom: HER_SESSION })
  try {
    await writeCfg(root, { chat: { rotateAfter: 40 } })
    await writeAtomic(
      join(paths(root).root, 'home.json'),
      JSON.stringify(
        {
          wsId: 'ws-1',
          sessionId: 's-new-1',
          createdAt: '2026-10-31T00:50:27.000Z',
          turns: 0,
          rotatedFrom: HER_SESSION,
        },
        null,
        2,
      ),
    )
    const { ctx } = fakeCtx()
    const off = registerTurns(ctx, { root, log: () => {} })
    try {
      ctx.emit('session/event', session('s-somewhere-else'), humanMsg('随便哪条会话都认就不对了'))
      ctx.emit('session/event', session('s-somewhere-else'), TURN_END)
      await settled()
      const h = await homeStatus(root)
      assert.equal(h.turns, 0)
      assert.equal(h.sessionId, 's-new-1', '屋子不该被搬走')
    } finally {
      off()
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('注销之后就不再记了', async () => {
  const root = await tmpRoot()
  try {
    const { ctx } = fakeCtx()
    const off = registerTurns(ctx, { root, log: () => {} })
    off()
    ctx.emit('session/event', session(), humanMsg('注销之后说的话'))
    ctx.emit('session/event', session(), TURN_END)
    await settled()
    assert.equal((await homeStatus(root)).turns, 0)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

// 2026-11-06（外部日志：只读实例照样往共享事件流里写 seen:）。
// 观测者以前无条件写盘：看到「他来过」就 appendEvent，从不过问这个家是不是自己的。
// 于是一个数据目录被两个实例开着时，日志里出现同一毫秒的重复 seen:。
test('被占用的实例（tenant.ok=false）：一句都不许写进共享事件流', async () => {
  const root = await tmpRoot()
  try {
    const { ctx } = fakeCtx()
    const tenant = { ok: false, instanceId: 'inst-a', why: '这个数据目录已经被另一个插件实例占着' }
    const off = registerTurns(ctx, { root, tenant, log: () => {} })
    try {
      ctx.emit('session/event', session(), humanMsg('在她屋里说一句'))
      ctx.emit('session/event', session('s-qq'), humanMsg('在别的会话说一句'))
      ctx.emit('session/event', session(), TURN_END)
      await settled()

      const { events } = await readEvents(root)
      assert.equal(
        events.filter((e) => e.type === 'meta' && String(e.text).startsWith('seen:')).length,
        0,
        '房主不是自己，连记账行都不该落盘',
      )
      assert.equal((await homeStatus(root)).turns, 0, '轮数也不该涨')
    } finally {
      off()
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('占用权是中途丢的：拿到的是活引用，丢了之后立刻停写', async () => {
  const root = await tmpRoot()
  try {
    const { ctx } = fakeCtx()
    const tenant = { ok: true, instanceId: 'inst-a', why: '' }
    const off = registerTurns(ctx, { root, tenant, log: () => {} })
    try {
      // 心跳续不上（真机日志里的「占用权丢了」）——同一个对象被原地改写
      tenant.ok = false
      tenant.why = '这个家已经被另一个实例接管了，之后不再写入。'

      ctx.emit('session/event', session('s-qq'), humanMsg('丢了之后还说话'))
      await settled()

      const { events } = await readEvents(root)
      assert.equal(
        events.filter((e) => e.type === 'meta' && String(e.text).startsWith('seen:')).length,
        0,
        '注册时是房主不算数，写的那一刻才算',
      )
    } finally {
      off()
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('同一进程里重复注册：只挂一个观察者，seen: 不会写两遍', async () => {
  const root = await tmpRoot()
  try {
    const { ctx } = fakeCtx()
    const off1 = registerTurns(ctx, { root, log: () => {} })
    const off2 = registerTurns(ctx, { root, log: () => {} })
    try {
      ctx.emit('session/event', session('s-qq'), humanMsg('同一句话'))
      await settled()

      const { events } = await readEvents(root)
      assert.equal(
        events.filter((e) => e.type === 'meta' && String(e.text).startsWith('seen:')).length,
        1,
        '两个写者各写一遍 = 同一毫秒的两条 seen:，事件流就不能当证据了',
      )
    } finally {
      off1()
      off2()
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})
