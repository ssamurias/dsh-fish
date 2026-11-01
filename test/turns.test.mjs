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

test('来源判据：真人 / 插件 / 上下文 分得清', () => {
  assert.equal(classifyMessage({ source: { kind: 'user', rpcId: 'uuid-1', clientTimeZone: 'Asia/Shanghai' } }), 'human')
  assert.equal(classifyMessage({ source: { kind: 'user', rpcId: 'wake-abc' } }), 'plugin')
  assert.equal(classifyMessage({ source: { kind: 'user', rpcId: 'say-abc' } }), 'plugin')
  assert.equal(classifyMessage({ source: { kind: 'runtime-context' } }), 'context')
  assert.equal(classifyMessage({ source: { kind: 'skill-catalog' } }), 'context')
  assert.equal(classifyMessage({ source: { kind: 'plugin:hindsight' } }), 'context')
  assert.equal(classifyMessage({}), 'context')
  // 老客户端 / 别的插件灌的：没有时区，分不清就不算——宁可少算一轮
  assert.equal(classifyMessage({ source: { kind: 'user', rpcId: 'uuid-2' } }), 'unknown')
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
      assert.equal(prompted.length, 1, '只该叫一声')
      assert.equal(prompted[0].sessionId, 's-new-1')
      assert.equal(prompted[0].mode, 'queue')
      // 叫醒文本要能让她知道"屋子刚建好"，别是一句空白
      assert.match(String(prompted[0].content?.[0]?.text ?? ''), /醒一醒/)
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
