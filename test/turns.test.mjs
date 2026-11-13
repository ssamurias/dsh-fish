/**
 * turns.test.mjs —— 侧栏里直接跟她说话，也算一轮（issue #6）
 *
 * 这一组守五件事：
 *   ① 来源判据：真人打的（带 clientTimeZone）/ 桥接的（带 rpcId，可能没时区）/
 *      插件 prompt 的（wake-/say- 前缀、无时区）/ 宿主拼的上下文（kind 不是 user）
 *      分得清；
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

import {
  classifyMessage,
  messageText,
  assistantText,
  stripChannelNote,
  registerTurns,
  declareSource,
  clearDeclaredSources,
  TURN_TEXT_MAX,
} from '../lib/turns.js'
import { homeStatus } from '../lib/home.js'
import { appendEvent, readEvents, writeAtomic, paths } from '../lib/store.js'
import { recentExchanges } from '../lib/talkmem.js'
import { saveChannel } from '../lib/channels.js'
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
  // 2026-11-08（用户转来的微信桥反馈）：桥走宿主 `sessionController.prompt()`
  // 时传不进 source，宿主把 kind 写死成 'user'；rpcId 是它唯一留下的记号。
  // 带 rpcId 的 user 消息就是「有人代他递话」——微信桥、别的桥都算。
  assert.equal(classifyMessage({ source: { kind: 'user', rpcId: 'uuid-2' } }), 'human')
  assert.equal(classifyMessage({ source: { kind: 'user', rpcId: 'wechat-1234' } }), 'human')
  // 真正认不出来源的只剩没 rpcId 的 append（fish 自己的交接句/便条）
  assert.equal(classifyMessage({ source: { kind: 'user' } }), 'unknown')
  // observe.js 的出门首轮也走 prompt，漏在名单外会掉进 unknown
  assert.equal(classifyMessage({ source: { kind: 'user', rpcId: 'outing-s-her-1700000000000' } }), 'plugin')

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

  // 2026-11-08（用户 m00394）：群里他本人说的那句。
  // 桥按 QQ 号判、给 owner:true；插件一个字都不猜（nickname 自由字符串，猜错比不写更糟）。
  // 它仍是 group 场次：进记忆，但不涨轮数、不写 seen——边界在 m00394 里点过名。
  assert.equal(classifyMessage({ source: { kind: 'qq', scene: 'group', owner: true } }), 'group-owner')
  // 标了 guest 的按外客走，owner 再多也不认——两句话打架时按更保守的那个
  assert.equal(classifyMessage({ source: { kind: 'qq', scene: 'group', owner: true, guest: true } }), 'group')
  // 只认布尔 true：字符串 'true' / 1 都不算，别让桥的宽松写法把她对主人的记忆写歪
  assert.equal(classifyMessage({ source: { kind: 'qq', scene: 'group', owner: 'true' } }), 'group')
  assert.equal(classifyMessage({ source: { kind: 'qq', scene: 'group', owner: 1 } }), 'group')
  // owner 只对 group 有意义：私聊本来就是人
  assert.equal(classifyMessage({ source: { kind: 'qq', scene: 'private', owner: true } }), 'human')
})

test('来源判据：桥先登记过的那一轮，按登记走（issue #96）', () => {
  // 2026-11-09（issue #96）：0.9.5 让「kind:user + rpcId」一律算人，可桥走
  // sessionController.prompt() 时 source 是宿主拼的，桥只能定 requestId。
  // 结果群里几百句、桥自己的定时提醒，全被算成他本人：涨轮数、换会话、
  // 记「他来过」、撤掉这一轮的叫醒。所以桥可以先把这一轮是什么登记进来。
  clearDeclaredSources()
  try {
    declareSource({ rpcId: 'bridge-g1', scene: 'group' })
    assert.equal(classifyMessage({ source: { kind: 'user', rpcId: 'bridge-g1' } }), 'group')
    declareSource({ rpcId: 'bridge-g2', scene: 'group', owner: true })
    assert.equal(classifyMessage({ source: { kind: 'user', rpcId: 'bridge-g2' } }), 'group-owner')
    declareSource({ rpcId: 'bridge-p1', scene: 'private' })
    assert.equal(classifyMessage({ source: { kind: 'user', rpcId: 'bridge-p1' } }), 'human')
    // 桥自己发起的轮次（定时提醒、转发）：不是人说的话
    declareSource({ rpcId: 'bridge-t1', machine: true })
    assert.equal(classifyMessage({ source: { kind: 'user', rpcId: 'bridge-t1' } }), 'plugin')
    // 没登记的桥保持 0.9.5 的判法：带 rpcId 就是有人代他递话
    assert.equal(classifyMessage({ source: { kind: 'user', rpcId: 'bridge-unknown' } }), 'human')
    // 外客不必写在群聊里：私聊里的群友也不能算他
    assert.equal(classifyMessage({ source: { kind: 'user', rpcId: 'b-guest', guest: true } }), 'group')
    assert.equal(
      classifyMessage({ source: { kind: 'user', rpcId: 'b-pg', scene: 'private', guest: true } }),
      'group',
    )
  } finally {
    clearDeclaredSources()
  }
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
      // 真机里认不出来源的 user（没有 rpcId），再加一条时间快照。
      // 她那条会话和别的会话里都会出现，两边都不能算他来过。
      for (let i = 0; i < 6; i += 1) {
        ctx.emit('session/event', session(), {
          type: 'user/message',
          data: { id: `im-${i}`, role: 'user', content: [{ type: 'text', text: `桥接 ${i}` }], source: { kind: 'user' } },
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

test('桥接消息带 rpcId 就算他来过，渠道提示不进记忆（2026-11-08）', async () => {
  const root = await tmpRoot()
  try {
    await writeCfg(root, { memory: { hearEvery: 1 } })
    const { ctx } = fakeCtx()
    const off = registerTurns(ctx, { root, log: () => {} })
    try {
      const note = '[渠道：微信] 你在和微信上的用户对话，对方在手机上，看不到这台电脑的屏幕和文件系统。'
      ctx.emit('session/event', session(), {
        type: 'user/message',
        data: {
          id: 'm-wechat-1',
          role: 'user',
          content: [{ type: 'text', text: `今晚想吃点什么，面条还是米饭\n\n${note}` }],
          // 宿主 prompt 写死 kind:'user'，桥只能留下 rpcId；这条以前会掉进 unknown
          source: { kind: 'user', rpcId: 'wechat-1234' },
        },
      })
      await settled()
      ctx.emit('session/event', session(), herMsg([{ type: 'text', text: '面条吧。' }]))
      ctx.emit('session/event', session(), TURN_END)
      await waitFor(async () => (await homeStatus(root)).turns === 1)
      await settled()

      const { events } = await readEvents(root)
      assert.equal(events.filter((e) => e.type === 'meta' && String(e.text).startsWith('seen:')).length, 1, '他来过一次')
      const heard = events.filter((e) => e.type === 'heard')
      assert.equal(heard.length, 1, '这一轮记一句原话')
      assert.equal(heard[0].text, '今晚想吃点什么，面条还是米饭')
      const exchanges = await recentExchanges(root)
      assert.equal(exchanges.length, 1)
      assert.equal(exchanges[0].me, '今晚想吃点什么，面条还是米饭', '渠道提示不进 talkmem')

      // 首条消息桥还会单独发一条只有提示的：裁完是空，不算他来过
      ctx.emit('session/event', session(), {
        type: 'user/message',
        data: { id: 'm-wechat-note', role: 'user', content: [{ type: 'text', text: note }], source: { kind: 'user', rpcId: 'wechat-note' } },
      })
      await settled()
      const after = await readEvents(root)
      assert.equal(after.events.filter((e) => e.type === 'meta' && String(e.text).startsWith('seen:')).length, 1, 'note-only 不再多记一条')
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
      ctx.emit('session/event', session(), { type: 'user/message', data: { id: 'im-1', role: 'user', content: [{ type: 'text', text: '桥接来的话' }], source: { kind: 'user' } } })
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

test('渠道提示只从记账正文里裁掉，不碰真正的话（2026-11-08）', () => {
  const note = '[渠道：微信] 你在和微信上的用户对话，对方在手机上，看不到这台电脑的屏幕和文件系统。'
  assert.equal(stripChannelNote(`今晚吃什么\n\n${note}`), '今晚吃什么')
  assert.equal(stripChannelNote(`今晚吃什么\n\n${note}\n\n${note}`), '今晚吃什么')
  // 首条消息桥会单独再发一条只有提示的：不能当成「他来过」
  assert.equal(stripChannelNote(note), '')
  assert.equal(stripChannelNote('[Channel: WeChat] They are on a phone.'), '')
  // 不是独立段落、或不在末尾，就不动
  assert.equal(stripChannelNote('他说 [渠道：微信] 是桥的名字'), '他说 [渠道：微信] 是桥的名字')
  assert.equal(stripChannelNote(`${note}\n\n今晚吃什么`), `${note}\n\n今晚吃什么`)
  assert.equal(stripChannelNote(''), '')
  assert.equal(stripChannelNote(null), '')
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

test('桥登记成群聊之后，那几轮不涨轮数、不记「他来过」（issue #96）', async () => {
  const root = await tmpRoot({ chat: { rotateAfter: 3 }, memory: { hearEvery: 1 } })
  try {
    const { ctx } = fakeCtx()
    const off = registerTurns(ctx, { root, log: () => {} })
    try {
      clearDeclaredSources()
      // 桥这一轮要发什么，先说一声；然后照常走宿主的 prompt
      ctx.emit('dsh-fish/source', { rpcId: 'bridge-g1', scene: 'group' })
      ctx.emit('session/event', session(), {
        type: 'user/message',
        data: {
          id: 'm-bridge-1',
          role: 'user',
          content: [{ type: 'text', text: '（群聊 · 示例群 · im:group:10001）\n他说这句话挺有意思的' }],
          source: { kind: 'user', rpcId: 'bridge-g1' },
        },
      })
      ctx.emit('session/event', session(), TURN_END)
      await settled()
      assert.equal((await homeStatus(root)).turns, 0, '群聊不算他来找过她')
      const { events } = await readEvents(root)
      const seen = events.filter((e) => e.type === 'meta' && String(e.text).startsWith('seen:'))
      assert.equal(seen.length, 0, '不写「他来过」，冷落检测才不会被群消息冲掉')
    } finally {
      off()
      clearDeclaredSources()
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('本机别的 DSH 会话里他说话，不算他来找过她（2026-11-11）', async () => {
  const root = await tmpRoot()
  try {
    const { ctx } = fakeCtx()
    const off = registerTurns(ctx, { root, log: () => {} })
    try {
      ctx.emit('session/event', session('s-other'), humanMsg('我在别的会话里说话'))
      ctx.emit('session/event', session('s-other'), TURN_END)
      await settled()
      assert.equal((await homeStatus(root)).turns, 0)
      // 2026-11-11（用户报「好几天没回她，为什么不算冷落」）：原先这里写 seen，
      // 于是他在本机跟别的 agent 说话也会把冷落钟清零。别的会话不是他的私聊房，
      // 不该算「他来找过她」——她没等到人，就得真记成没等到人。
      const { events } = await readEvents(root)
      const seen = events.filter((e) => e.type === 'meta' && String(e.text).startsWith('seen:'))
      assert.equal(seen.length, 0, '别的会话里说话，不替她记「他来过」')
    } finally {
      off()
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

// 2026-11-11：收窄之后还要保证桥开的私聊房不被误伤——channels.json 里登记过
// 的会话，就是她和他的一间房，里面的动静照旧算「他来过了」。
test('桥登记过的房间（channels.json）里他说话，仍然算他来过', async () => {
  const root = await tmpRoot()
  try {
    await saveChannel(root, { channel: 'qq:dm:10001', scene: 'private', sessionId: 's-qq-room' })
    const { ctx } = fakeCtx()
    const off = registerTurns(ctx, { root, log: () => {} })
    try {
      ctx.emit('session/event', session('s-qq-room'), humanMsg('在私聊房里说句话'))
      ctx.emit('session/event', session('s-qq-room'), TURN_END)
      await settled()
      assert.equal((await homeStatus(root)).turns, 0, '房间不是她的家，轮数照旧不涨')
      const { events } = await readEvents(root)
      const seen = events.filter((e) => e.type === 'meta' && String(e.text).startsWith('seen:'))
      assert.equal(seen.length, 1, '登记过的私聊房算他来找过她')
    } finally {
      off()
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

// 宿主 0.2.2-rc.2：客户端里他亲手点出来、但 kind 不是 'user' 的两种消息。
// 形状照宿主源码手写（dsh-api-session-controller 的 prompt()：content 为空时
// kind 写成 'retry'；dsh-user-questions 的 answer()：kind 'user-question-reply'）。
/** 一轮失败后点「继续」：正文是空的 */
function retryMsg(extra = {}) {
  return {
    type: 'user/message',
    data: {
      id: `m-${Math.random().toString(36).slice(2)}`,
      role: 'user',
      content: [],
      source: { kind: 'retry', rpcId: 'rpc-retry-1', clientTimeZone: 'Asia/Shanghai', ...extra },
    },
  }
}

/** 答了一张问题卡：没有 rpcId，也没有时区 */
function questionReplyMsg() {
  return {
    type: 'user/message',
    data: {
      id: `m-${Math.random().toString(36).slice(2)}`,
      role: 'user',
      content: [{
        type: 'text',
        text: JSON.stringify({ kind: 'answer_to_pending_question', tool: 'ask_user_question', callId: 'call-1' }),
      }],
      source: { kind: 'user-question-reply', callId: 'call-1', outcome: 'answered' },
    },
  }
}

const seenCount = async (root) => {
  const { events } = await readEvents(root)
  return events.filter((e) => e.type === 'meta' && String(e.text).startsWith('seen:')).length
}

// 别的会话里桌面打字从 2026-11-11 起不算「他来找过她」，但那个判断只认 kind 'user'。
// 「继续」和问题卡的回答被当成桥注入的消息，在取正文之前就写了 seen：
// 他在任何别的会话里点一下「继续」，她的冷落钟就清零。
test('本机别的 DSH 会话里点「继续」（kind retry，空正文），不算他来找过她', async () => {
  for (const [name, msg] of [
    ['带时区', retryMsg()],
    ['不带时区', retryMsg({ clientTimeZone: undefined })],
  ]) {
    const root = await tmpRoot()
    try {
      const { ctx } = fakeCtx()
      const logs = []
      const off = registerTurns(ctx, { root, log: (...a) => logs.push(a.join(' ')) })
      try {
        assert.equal(classifyMessage(msg.data), 'human', '判法没变：在她自己的房间里它仍是他动的手')
        ctx.emit('session/event', session('s-other'), msg)
        ctx.emit('session/event', session('s-other'), TURN_END)
        await settled()
        assert.equal(await seenCount(root), 0, `${name}：别的会话里点「继续」，不替她记「他来过」`)
        assert.equal((await homeStatus(root)).turns, 0)
        assert.deepEqual(logs, [], `${name}：也不打「只记他来过」那行日志`)
      } finally {
        off()
      }
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
    }
  }
})

test('本机别的 DSH 会话里答一张问题卡（kind user-question-reply），不算他来找过她', async () => {
  const root = await tmpRoot()
  try {
    const { ctx } = fakeCtx()
    const off = registerTurns(ctx, { root, log: () => {} })
    try {
      ctx.emit('session/event', session('s-other'), questionReplyMsg())
      ctx.emit('session/event', session('s-other'), TURN_END)
      await settled()
      assert.equal(await seenCount(root), 0, '别的会话里答卡，不替她记「他来过」')
      assert.equal((await homeStatus(root)).turns, 0)
    } finally {
      off()
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('桥登记过的房间里点「继续」、答问题卡，仍然算他来过', async () => {
  for (const make of [retryMsg, questionReplyMsg]) {
    const root = await tmpRoot()
    try {
      await saveChannel(root, { channel: 'qq:dm:10001', scene: 'private', sessionId: 's-qq-room' })
      const { ctx } = fakeCtx()
      const off = registerTurns(ctx, { root, log: () => {} })
      try {
        ctx.emit('session/event', session('s-qq-room'), make())
        ctx.emit('session/event', session('s-qq-room'), TURN_END)
        await settled()
        assert.equal(await seenCount(root), 1, '登记过的私聊房是她的房间，照旧')
        assert.equal((await homeStatus(root)).turns, 0, '房间不是她的家，轮数照旧不涨')
      } finally {
        off()
      }
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
    }
  }
})

test('她的家里：答问题卡照旧算一轮；点「继续」正文是空的，照旧不记', async () => {
  const root = await tmpRoot()
  try {
    const { ctx } = fakeCtx()
    const off = registerTurns(ctx, { root, log: () => {} })
    try {
      ctx.emit('session/event', session(), retryMsg())
      ctx.emit('session/event', session(), TURN_END)
      await settled()
      assert.equal(await seenCount(root), 0, '空正文的「继续」在她家里本来就不写 seen')
      assert.equal((await homeStatus(root)).turns, 0)

      ctx.emit('session/event', session(), questionReplyMsg())
      ctx.emit('session/event', session(), TURN_END)
      await waitFor(async () => (await homeStatus(root)).turns === 1)
      assert.equal(await seenCount(root), 1, '她家里答卡：他来过')
      assert.equal((await homeStatus(root)).turns, 1, '也照旧涨一轮')
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
          // kind='user' 但既没有时区也没有 rpcId：只剩 fish 自己 append 的交接句/便条
          source: { kind: 'user' },
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
          source: { kind: 'user' },
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
          rotatedTo: 's-new-1',
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

// 2026-11-10（用户反馈：满 40 轮换会话，有时候又落回旧的老会话，像「旧会话没被用满」）。
// `rotatedFrom` 会一直留到下一次轮换；不设窗口的话，他几天后翻回侧栏那条「…之前」
// 说一句，屋子就搬回去，而 `turns` 还是新会话的 0——那条满 40 轮的会话又拿一整段预算。
test('换房过去一阵、新会话也聊过了，他回旧窗口说话不再搬屋子', async () => {
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
          turns: 3,
          rotatedFrom: HER_SESSION,
          rotatedAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
        },
        null,
        2,
      ),
    )
    const { ctx } = fakeCtx()
    const logs = []
    const off = registerTurns(ctx, { root, log: (m) => logs.push(String(m)) })
    try {
      ctx.emit('session/event', session(HER_SESSION), humanMsg('过了几个钟头，我又翻回这条说一句'))
      ctx.emit('session/event', session(HER_SESSION), TURN_END)
      await settled()

      const h = await homeStatus(root)
      assert.equal(h.sessionId, 's-new-1', '屋子不该被搬回旧会话')
      assert.equal(h.turns, 3, '不属于这间屋子的话不结算，轮数不该动')
      const raw = JSON.parse(await readFile(join(paths(root).root, 'home.json'), 'utf8'))
      assert.equal(raw.rotatedFrom, HER_SESSION, 'rotatedFrom 留着，等下一次轮换自然替换')
      assert.ok(
        logs.some((l) => /屋子已经搬走了/.test(l)),
        `要有能查的日志：${logs.join(' | ').slice(0, 200)}`,
      )
    } finally {
      off()
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

// 叫醒没落地时，新会话一轮都没跑过（turns 还是 0）。那种情况他只能还在旧窗口里说话，
// 隔多久都得认回——不然这一整段话全丢。
test('新会话一轮都没跑过时，隔了几个钟头回旧窗口说话仍然认回', async () => {
  const root = await tmpRoot({ rotatedFrom: HER_SESSION })
  try {
    await writeCfg(root, { chat: { rotateAfter: 40 } })
    await writeAtomic(
      join(paths(root).root, 'home.json'),
      JSON.stringify(
        {
          wsId: 'ws-1',
          sessionId: 's-new-1',
          createdAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
          turns: 0,
          rotatedFrom: HER_SESSION,
          rotatedAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
        },
        null,
        2,
      ),
    )
    const { ctx } = fakeCtx()
    const off = registerTurns(ctx, { root, log: () => {} })
    try {
      ctx.emit('session/event', session(HER_SESSION), humanMsg('新窗口一直没醒，我还在旧窗口'))
      ctx.emit('session/event', session(HER_SESSION), TURN_END)

      const h = await waitFor(async () => {
        const st = await homeStatus(root)
        return st.turns > 0 ? st : null
      })
      assert.equal(h.sessionId, HER_SESSION, '叫醒没落地，屋子该认回他实际在说话的那条')
      assert.equal(h.turns, 1)
    } finally {
      off()
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

// 换房那一刻人正卡在旧窗口里接着打：10 分钟内即使新会话已经跑过一轮，也认回。
test('换房 10 分钟以内，新会话用过轮也照样认回', async () => {
  const root = await tmpRoot({ rotatedFrom: HER_SESSION })
  try {
    await writeCfg(root, { chat: { rotateAfter: 40 } })
    await writeAtomic(
      join(paths(root).root, 'home.json'),
      JSON.stringify(
        {
          wsId: 'ws-1',
          sessionId: 's-new-1',
          createdAt: new Date(Date.now() - 60_000).toISOString(),
          turns: 5,
          rotatedFrom: HER_SESSION,
          rotatedAt: new Date(Date.now() - 60_000).toISOString(),
        },
        null,
        2,
      ),
    )
    const { ctx } = fakeCtx()
    const off = registerTurns(ctx, { root, log: () => {} })
    try {
      ctx.emit('session/event', session(HER_SESSION), humanMsg('刚换完，我手还在旧窗口上'))
      ctx.emit('session/event', session(HER_SESSION), TURN_END)

      const h = await waitFor(async () => {
        const st = await homeStatus(root)
        return st.sessionId === HER_SESSION && st.turns > 5 ? st : null
      })
      assert.equal(h.turns, 6, '轮数接着数（5 之后再 +1），不白送一段、也不清零重来')
    } finally {
      off()
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

// 2026-11-13（外部反馈：轮换后「家」停在旧会话，自动醒落回旧对话）。
// 真机时间线：22:49:23 满 40 轮换房 → 22:49:35 他还在旧窗口说了一句，
// 屋子按「换下来那条」认回旧会话 → 之后他在新房间里聊了一整夜，却没有任何
// 逻辑把家跟过去；08:03 的自动醒照着 home.json 叫回那条 383K tok 的旧对话。
// 修法：轮换时对称记下 rotatedTo，他在那条里说话家就跟过去。
test('轮换后他先回旧窗口、随后搬进新会话 → 屋子跟到新会话（外部反馈 2026-11-13）', async () => {
  const root = await tmpRoot()
  try {
    await writeCfg(root, { chat: { rotateAfter: 40 } })
    await writeAtomic(
      join(paths(root).root, 'home.json'),
      JSON.stringify(
        {
          wsId: 'ws-1',
          sessionId: 's-new-1',
          createdAt: new Date(Date.now() - 60_000).toISOString(),
          turns: 0,
          rotatedFrom: HER_SESSION,
          rotatedTo: 's-new-1',
          rotatedAt: new Date(Date.now() - 60_000).toISOString(),
          carry: '## 上次我们说到这\n- 旧话',
        },
        null,
        2,
      ),
    )
    const { ctx } = fakeCtx()
    const off = registerTurns(ctx, { root, log: () => {} })
    try {
      // 第一步：换房 12 秒后他还在旧窗口里说了一句（这一步是设计如此：认回旧会话）
      ctx.emit('session/event', session(HER_SESSION), humanMsg('下一个试试'))
      ctx.emit('session/event', session(HER_SESSION), TURN_END)
      const back = await waitFor(async () => {
        const st = await homeStatus(root)
        return st.sessionId === HER_SESSION && st.turns > 0 ? st : null
      })
      assert.equal(back.turns, 1)
      let raw = JSON.parse(await readFile(join(paths(root).root, 'home.json'), 'utf8'))
      assert.equal(raw.rotatedFrom, undefined, '认回旧窗口后不再记着它')
      assert.equal(raw.rotatedTo, 's-new-1', 'rotatedTo 要留着——他可能还会搬过去')
      assert.equal(raw.carry, undefined)

      // 第二步：他换到轮换建出来的新房间里说话（真机上这段聊了一整夜）
      ctx.emit('session/event', session('s-new-1'), humanMsg('我换到新房间了'))
      ctx.emit('session/event', session('s-new-1'), TURN_END)
      const moved = await waitFor(async () => {
        const st = await homeStatus(root)
        return st.sessionId === 's-new-1' && st.turns > 1 ? st : null
      })
      assert.equal(moved.turns, 2, '轮数接着数，不清零、也不白送')
      raw = JSON.parse(await readFile(join(paths(root).root, 'home.json'), 'utf8'))
      assert.equal(raw.sessionId, 's-new-1')
      assert.ok(raw.adoptedAt, '搬过屋子要留 adoptedAt，观测台能看出是认回的')
    } finally {
      off()
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

// rotatedTo 和 rotatedFrom 不一样：这条会话本来就是轮换替他开的房，
// 他在里头说话，家就该在哪儿——不存在「太晚了不认」的窗口。
test('rotatedTo 那条隔多久说话都认，carry 也留着', async () => {
  const root = await tmpRoot()
  try {
    await writeCfg(root, { chat: { rotateAfter: 40 } })
    await writeAtomic(
      join(paths(root).root, 'home.json'),
      JSON.stringify(
        {
          wsId: 'ws-1',
          sessionId: HER_SESSION,
          createdAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
          turns: 5,
          rotatedTo: 's-new-1',
          rotatedAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
          carry: '## 上次我们说到这\n- 还没说完的话',
        },
        null,
        2,
      ),
    )
    const { ctx } = fakeCtx()
    const off = registerTurns(ctx, { root, log: () => {} })
    try {
      ctx.emit('session/event', session('s-new-1'), humanMsg('三个钟头后我才搬过来'))
      ctx.emit('session/event', session('s-new-1'), TURN_END)
      const h = await waitFor(async () => {
        const st = await homeStatus(root)
        return st.turns > 5 ? st : null
      })
      assert.equal(h.sessionId, 's-new-1')
      assert.equal(h.turns, 6)
      const raw = JSON.parse(await readFile(join(paths(root).root, 'home.json'), 'utf8'))
      assert.match(String(raw.carry ?? ''), /还没说完的话/, 'carry 是给这间新房间准备的，不能丢')
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

test('占用权丢的时候整个对象被换掉：tenant 传的是函数，换掉之后立刻停写', async () => {
  const root = await tmpRoot()
  try {
    const { ctx } = fakeCtx()
    // index.js 的写法：tenancy.tenant 丢的时候是换成一个新对象，不是原地改
    const tenancy = { tenant: { ok: true, instanceId: 'inst-a', why: '' } }
    const off = registerTurns(ctx, { root, tenant: () => tenancy.tenant, log: () => {} })
    try {
      tenancy.tenant = { ok: false, instanceId: 'inst-a', why: '这个家已经被另一个实例接管了，之后不再写入。' }

      ctx.emit('session/event', session('s-qq'), humanMsg('丢了之后还说话'))
      await settled()

      const { events } = await readEvents(root)
      assert.equal(
        events.filter((e) => e.type === 'meta' && String(e.text).startsWith('seen:')).length,
        0,
        '注册时拿到的那个对象还是 ok:true，不能认它',
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
      // 用桥那条路（kind:'qq'）：2026-11-11 起本机其他 DSH 会话不再记 seen，
      // 这条用例要测的是「重复注册只写一遍」，所以走仍然会记账的外渠道。
      ctx.emit('session/event', session('s-qq'), {
        type: 'user/message',
        data: {
          id: 'qq-dup-1',
          role: 'user',
          content: [{ type: 'text', text: '同一句话' }],
          source: { kind: 'qq' },
        },
      })
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

test('群聊里他本人说的一句（owner:true）：进记忆，但不算他来过（2026-11-08，用户 m00394）', async () => {
  const root = await tmpRoot()
  try {
    const { ctx } = fakeCtx()
    const off = registerTurns(ctx, { root, log: () => {} })
    try {
      const ownerMsg = {
        type: 'user/message',
        data: {
          id: 'g-owner-1',
          role: 'user',
          content: [{ type: 'text', text: '嗯。这个版本我打算先发一版试试看，有问题再说。' }],
          // 桥按 QQ 号判出来「这是主人」，写在 source 上（AGENTS.md §7.1）
          source: { kind: 'qq', scene: 'group', owner: true },
        },
      }
      ctx.emit('session/event', session('s-group'), ownerMsg)
      ctx.emit('session/event', session('s-group'), TURN_END)
      await settled()

      const { events } = await readEvents(root)
      const heard = events.filter((e) => e.type === 'heard')
      assert.equal(heard.length, 1, '群里他本人说的那句要进记忆')
      assert.equal(heard[0].scene, 'group', '场次要留下，她翻到时才知道这是在群里说的')
      assert.equal(heard[0].source, 'system', 'heard 只能系统侧写——她能伪造就等于能编一句「他说过」')
      assert.match(heard[0].text, /先发一版/)

      // 边界：进记忆 ≠ 他来找过她
      assert.equal((await homeStatus(root)).turns, 0, '群里说话不涨轮数')
      const seen = events.filter((e) => e.type === 'meta' && String(e.text).startsWith('seen:'))
      assert.equal(seen.length, 0, '群里说十句也不该让冷落检测以为他一直在')

      // 群友的话一条都不进：同一轮里再灌一条不带 owner 的
      ctx.emit('session/event', session('s-group'), {
        type: 'user/message',
        data: {
          id: 'g-other-1',
          role: 'user',
          content: [{ type: 'text', text: '群里另一个人插了句嘴，说的也挺长的一段话。' }],
          source: { kind: 'qq', scene: 'group' },
        },
      })
      ctx.emit('session/event', session('s-group'), TURN_END)
      await settled()
      const after = (await readEvents(root)).events.filter((e) => e.type === 'heard')
      assert.equal(after.length, 1, '群友的话不进记忆——这是产品边界，不是遗漏')
      assert.ok(!after.some((e) => String(e.text).includes('插了句嘴')))
    } finally {
      off()
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('一条带小标题和列表的回答只落一条事件，不按空行拆（issue #98）', async () => {
  const root = await tmpRoot()
  try {
    await writeCfg(root, { chat: { rotateAfter: 40 } })
    const { ctx } = fakeCtx()
    const off = registerTurns(ctx, { root, log: () => {} })
    try {
      const said = [
        '**运行状态**',
        '- 启动行：`===== 启动 0.9.3`',
        '- 两组新东西还没开始动',
        '---',
        '**接下来做什么**',
        '先把这一轮结完，再看别的。',
      ].join('\n\n')
      ctx.emit('session/event', session(), humanMsg('你现在什么状态'))
      await settled()
      ctx.emit('session/event', session(), herMsg([{ type: 'text', text: said }]))
      ctx.emit('session/event', session(), TURN_END)
      await waitFor(async () => (await homeStatus(root)).turns === 1)

      const { events } = await readEvents(root)
      const rows = events.filter((e) => e.type === 'utterance')
      assert.equal(rows.length, 1, '一条回答就是一条事件，不按段落拆')
      assert.equal(rows[0].text, said, '整段原样留着，小标题和列表都在这条里')
      assert.deepEqual(rows[0].flags, ['uncommitted'])
    } finally {
      off()
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('真的超过一条事件的上限时才切开，每段都不超（issue #98）', async () => {
  const root = await tmpRoot()
  try {
    await writeCfg(root, { chat: { rotateAfter: 40 } })
    const { ctx } = fakeCtx()
    const off = registerTurns(ctx, { root, log: () => {} })
    try {
      const para = (n) => `${n}、`.repeat(300) // 每段 600 字
      const first = [para(1), para(2)].join('\n\n')
      const second = [para(3), para(4)].join('\n\n')
      const said = [first, second].join('\n\n')
      assert.ok(said.length > TURN_TEXT_MAX)
      ctx.emit('session/event', session(), humanMsg('说长一点'))
      await settled()
      // 两条消息各自不超过上限，合起来超过：这才是「一条事件装不下」的真实场景
      // （单条消息在收集时已经被 cut() 截到 TURN_TEXT_MAX）。
      ctx.emit('session/event', session(), herMsg([{ type: 'text', text: first }]))
      ctx.emit('session/event', session(), herMsg([{ type: 'text', text: second }]))
      ctx.emit('session/event', session(), TURN_END)
      await waitFor(async () => (await homeStatus(root)).turns === 1)

      const { events } = await readEvents(root)
      const rows = events.filter((e) => e.type === 'utterance')
      assert.ok(rows.length > 1, '一条事件装不下，才切成几条')
      for (const r of rows) assert.ok(String(r.text).length <= TURN_TEXT_MAX, '每条都不超过上限')
      assert.equal(rows.map((r) => r.text).join('\n\n'), said, '切开之后拼回去还是原来那段')
    } finally {
      off()
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

// 宿主 0.2.2-rc.2 的「继续」，在她家里：一轮因为限流、断流失败（turn/end 的
// reason 是 error）时这边照常结账——turns +1、talk-recent 记一轮、her 是空的。
// 他点「继续」，宿主发来 kind 'retry'、正文为空的 user/message，她在新的一轮里
// 才把话答上。原来空正文不建 pending，她这一轮说的话没人收：utterance 不写，
// talk-recent 那一轮的 her 一直是空的，换会话时带过去的只有他那半句。
const TURN_END_FAILED = {
  type: 'turn/end',
  data: { reason: { kind: 'error', error: { code: 'RATE_LIMIT' } } },
}

/**
 * 等 onHuman 把一条消息收完。「继续」的正文是空的，收下它不写盘，没有东西可以
 * waitFor；固定睡 80ms 在机器忙的时候不够（onHuman 里要读 home.json、读事件流）。
 * 这里把同样的读盘多走几遍再睡一下：机器越忙，等得越久。
 */
async function landed(root) {
  for (let i = 0; i < 25; i++) {
    await homeStatus(root)
    await readEvents(root)
  }
  await settled()
}

/**
 * 等盘上的样子对上（结账是异步的）。两次读之间隔开一点：Windows 上读得太密，
 * 那边改名落盘会被顶掉，而 bumpTurns / talkmem 写不上是不出声的。
 */
const waitSlow = (fn) =>
  waitFor(async () => {
    if (await fn()) return true
    await new Promise((r) => setTimeout(r, 60))
    return false
  })
const waitTurns = (root, n) => waitSlow(async () => (await homeStatus(root)).turns === n)
const waitExchanges = (root, want) =>
  waitSlow(async () => {
    const got = (await recentExchanges(root)).map((r) => [r.me, r.her])
    return JSON.stringify(got) === JSON.stringify(want)
  })

const utterances = async (root) => {
  const { events } = await readEvents(root)
  return events.filter((e) => e.type === 'utterance')
}

test('她家里一轮失败后点「继续」：她答的那句补进那一轮，轮数不再涨', async () => {
  const root = await tmpRoot()
  try {
    await writeCfg(root, { chat: { rotateAfter: 40 } })
    const { ctx } = fakeCtx()
    const off = registerTurns(ctx, { root, log: () => {} })
    try {
      ctx.emit('session/event', session(), humanMsg('今天过得怎么样'))
      await settled()
      ctx.emit('session/event', session(), TURN_END_FAILED)
      await waitTurns(root, 1)
      assert.deepEqual(
        (await recentExchanges(root)).map((r) => [r.me, r.her]),
        [['今天过得怎么样', '']],
        '失败的那一轮照旧结账，她那半边是空的',
      )
      const eventsBefore = (await readEvents(root)).events.length

      ctx.emit('session/event', session(), retryMsg())
      await landed(root)
      ctx.emit('session/event', session(), herMsg([{ type: 'text', text: '挺好的，下午晒了会儿太阳。' }]))
      ctx.emit('session/event', session(), TURN_END)
      await waitFor(async () => (await utterances(root)).length === 1)
      await waitExchanges(root, [['今天过得怎么样', '挺好的，下午晒了会儿太阳。']])
      await settled()

      const rows = await utterances(root)
      assert.equal(rows[0].text, '挺好的，下午晒了会儿太阳。')
      assert.deepEqual(rows[0].flags, ['uncommitted'], '和平常一轮一样，只留证')
      assert.deepEqual(
        (await recentExchanges(root)).map((r) => [r.me, r.her]),
        [['今天过得怎么样', '挺好的，下午晒了会儿太阳。']],
        '补进失败的那一轮，不新开一轮',
      )
      assert.equal((await homeStatus(root)).turns, 1, '他没有再说话，轮数不涨')
      assert.equal(await seenCount(root), 1, '一轮一条 seen，「继续」不再写一条')
      assert.equal(
        (await readEvents(root)).events.length,
        eventsBefore + 1,
        '「继续」那一轮只多她那一条 utterance（不旁听、不写别的）',
      )
    } finally {
      off()
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('失败前她已经说出口半句：「继续」之后的话接在后面', async () => {
  const root = await tmpRoot()
  try {
    await writeCfg(root, { chat: { rotateAfter: 40 } })
    const { ctx } = fakeCtx()
    const off = registerTurns(ctx, { root, log: () => {} })
    try {
      ctx.emit('session/event', session(), humanMsg('讲讲那本书'))
      await waitFor(async () => (await seenCount(root)) === 1)
      await settled()
      ctx.emit('session/event', session(), herMsg([{ type: 'text', text: '它前半本写得慢，' }]))
      ctx.emit('session/event', session(), TURN_END_FAILED)
      await waitTurns(root, 1)

      ctx.emit('session/event', session(), retryMsg())
      await landed(root)
      ctx.emit('session/event', session(), herMsg([{ type: 'text', text: '后半本才好看。' }]))
      ctx.emit('session/event', session(), TURN_END)
      await waitFor(async () => (await utterances(root)).length === 2)
      await waitExchanges(root, [['讲讲那本书', '它前半本写得慢， 后半本才好看。']])

      assert.deepEqual(
        (await recentExchanges(root)).map((r) => [r.me, r.her]),
        [['讲讲那本书', '它前半本写得慢， 后半本才好看。']],
      )
      assert.deepEqual((await utterances(root)).map((e) => e.text), ['它前半本写得慢，', '后半本才好看。'])
      assert.equal((await homeStatus(root)).turns, 1)
    } finally {
      off()
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('「继续」又失败、再点一次才答上：仍然补进同一轮', async () => {
  const root = await tmpRoot()
  try {
    await writeCfg(root, { chat: { rotateAfter: 40 } })
    const { ctx } = fakeCtx()
    const off = registerTurns(ctx, { root, log: () => {} })
    try {
      ctx.emit('session/event', session(), humanMsg('在吗'))
      await settled()
      ctx.emit('session/event', session(), TURN_END_FAILED)
      await waitTurns(root, 1)

      ctx.emit('session/event', session(), retryMsg())
      await landed(root)
      ctx.emit('session/event', session(), TURN_END_FAILED)
      await landed(root)
      assert.deepEqual((await recentExchanges(root)).map((r) => [r.me, r.her]), [['在吗', '']])

      ctx.emit('session/event', session(), retryMsg())
      await landed(root)
      ctx.emit('session/event', session(), herMsg([{ type: 'text', text: '在。' }]))
      ctx.emit('session/event', session(), TURN_END)
      await waitFor(async () => (await utterances(root)).length === 1)
      await waitExchanges(root, [['在吗', '在。']])

      assert.deepEqual((await recentExchanges(root)).map((r) => [r.me, r.her]), [['在吗', '在。']])
      assert.equal((await homeStatus(root)).turns, 1)
      assert.equal(await seenCount(root), 1)
    } finally {
      off()
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('中间隔了别的一轮（叫醒）再来的「继续」：不认，不把她的话安到上一轮人话下面', async () => {
  const root = await tmpRoot()
  try {
    await writeCfg(root, { chat: { rotateAfter: 40 } })
    const { ctx } = fakeCtx()
    const off = registerTurns(ctx, { root, log: () => {} })
    try {
      ctx.emit('session/event', session(), humanMsg('今天过得怎么样'))
      await settled()
      ctx.emit('session/event', session(), TURN_END_FAILED)
      await waitTurns(root, 1)

      // 她自己醒的一轮，也失败了
      ctx.emit('session/event', session(), pluginMsg(' '))
      ctx.emit('session/event', session(), TURN_END_FAILED)
      await landed(root)

      ctx.emit('session/event', session(), retryMsg())
      await landed(root)
      ctx.emit('session/event', session(), herMsg([{ type: 'text', text: '醒了，看了看窗外。' }]))
      ctx.emit('session/event', session(), TURN_END)
      await landed(root)

      assert.deepEqual(
        (await recentExchanges(root)).map((r) => [r.me, r.her]),
        [['今天过得怎么样', '']],
        '续的是叫醒那一轮，和他那句没关系',
      )
      assert.equal((await utterances(root)).length, 0, '和叫醒轮一样不记')
      assert.equal((await homeStatus(root)).turns, 1)
    } finally {
      off()
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('「继续」那一轮里他又开口：算新的一轮，照常结账', async () => {
  const root = await tmpRoot()
  try {
    await writeCfg(root, { chat: { rotateAfter: 40 } })
    const { ctx } = fakeCtx()
    const off = registerTurns(ctx, { root, log: () => {} })
    try {
      ctx.emit('session/event', session(), humanMsg('今天过得怎么样'))
      await settled()
      ctx.emit('session/event', session(), TURN_END_FAILED)
      await waitTurns(root, 1)

      ctx.emit('session/event', session(), retryMsg())
      await landed(root)
      ctx.emit('session/event', session(), humanMsg('算了，先说说晚饭'))
      await waitFor(async () => (await seenCount(root)) === 2)
      await settled()
      ctx.emit('session/event', session(), herMsg([{ type: 'text', text: '晚饭想吃面。' }]))
      ctx.emit('session/event', session(), TURN_END)
      await waitTurns(root, 2)

      assert.deepEqual(
        (await recentExchanges(root)).map((r) => [r.me, r.her]),
        [['今天过得怎么样', ''], ['算了，先说说晚饭', '晚饭想吃面。']],
      )
      assert.equal(await seenCount(root), 2, '他又开了一次口')
      assert.equal((await utterances(root)).length, 1)
    } finally {
      off()
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})
