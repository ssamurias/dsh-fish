/**
 * use.test.mjs —— 工具使用经验的锁定测试（2026-11-07，用户 m00882）
 *
 * 起因：真机事件流 978 行里一条工具使用记录都没有。她翻旧事时翻得到自己
 * 说过的话，翻不到「这件事我是怎么做成的」。
 *
 * 守六件事：
 *   1. 只记她当时听见的那句——不记参数、不记内部原因、不记返回值结构；
 *   2. 设置关掉 / 被门挡住的调用不入账（不记 enabled=false）；
 *   3. 记账永远不抛，写不进去就等于没记，绝不影响她这次动作；
 *   4. 走现有 meta 通道，不新增事件类型、不动 EVENT_SCHEMA_VERSION；
 *   5. 回忆层能把 use: 行翻出来，并且读出来是一句人话；
 *   6. 其余 meta 照旧跳过——放开的是 use: 这一种，不是整个 meta 层。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  USE_LINE_MAX,
  heardLine,
  shouldRecord,
  useText,
  recordUse,
  withUse,
  withUseDuringRegistration,
} from '../lib/use.js'
import { searchEvents, renderRecall, USE_PREFIX } from '../lib/recall.js'
import { readEvents } from '../lib/store.js'
import { defineTool } from '../lib/tool.js'

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fish-use-'))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

test('听到的那句：记下的原文 > 说出口的话 > 回执 > 正文', () => {
  const all = { ok: true, echo: '记下了：买灯泡', said: '说了一句', note: '回执', text: '正文' }
  assert.equal(heardLine(all), '记下了：买灯泡')
  assert.equal(heardLine({ ...all, echo: '' }), '说了一句')
  assert.equal(heardLine({ ...all, echo: '', said: '' }), '回执')
  assert.equal(heardLine({ ok: true, text: '短正文' }), '短正文')
})

test('长列表不进账：只记「翻到了没有」', () => {
  // her_recall / her_diary 的返回值是一整段列表，截 80 字只会得到半行目录。
  assert.equal(heardLine({ found: true, text: '你翻到的：\n- 2026-11-05 12:07｜…' }, 'her_recall'), '翻到了。')
  assert.equal(heardLine({ found: false, text: '' }, 'her_recall'), '没翻到。')
  assert.equal(heardLine({ found: true, text: '很久' }, 'her_diary'), '翻到日记了。')
  assert.equal(heardLine({ found: false }, 'her_diary'), '那天没有日记。')
})

test('一句话不超长、不换行、不切半个 emoji', () => {
  const long = heardLine({ ok: true, note: '很'.repeat(200) })
  assert.ok(long.length <= USE_LINE_MAX, `应为 ${USE_LINE_MAX} 字以内，实际 ${long.length}`)
  assert.ok(long.endsWith('…'))
  assert.equal(heardLine({ ok: true, note: '第一行\n第二行' }), '第一行 第二行')
  const emoji = heardLine({ ok: true, note: '😀'.repeat(60) })
  assert.doesNotMatch(emoji, /\uFFFD/)
})

test('什么都没有时给一句中性的，不编内容', () => {
  assert.equal(heardLine({ ok: true }), '做成了。')
  assert.equal(heardLine({ ok: false }), '没成。')
})

test('设置关掉、被门挡住的调用不入账', () => {
  // 这是用户 m00882 的原话：「不记 enabled=false」。
  for (const note of ['现在打不开。', '现在看不了画面。', '这会儿不方便说。', '没开这个权限']) {
    assert.equal(shouldRecord({ ok: false, note }), false, `「${note}」不该入账`)
  }
  // 真的试过、真失败了要记——那才是经验。
  assert.equal(shouldRecord({ ok: false, note: '这不是一个视频号。' }), true)
  assert.equal(shouldRecord({ ok: false, note: '这句里有不该说出去的东西。' }), true)
  assert.equal(shouldRecord({ ok: true }), true)
  assert.equal(shouldRecord(null), true)
})

test('账的写法：use:<工具> ok|fail <一句话>', () => {
  assert.equal(useText('her_note', { ok: true, echo: '记下了：买灯泡' }), 'use:her_note ok 记下了：买灯泡')
  assert.equal(useText('bili_watch', { ok: false, note: '这不是一个视频号。' }), 'use:bili_watch fail 这不是一个视频号。')
  // 没有 ok 字段的工具（her_recall / her_diary）不算失败。
  assert.equal(useText('her_recall', { found: false, text: '' }), 'use:her_recall ok 没翻到。')
})

test('记账：走 meta 通道，source 是 system，day 记 0', async () => {
  await withRoot(async (root) => {
    await recordUse(root, { tool: 'her_note', out: { ok: true, echo: '记下了：买灯泡' }, sessionId: 's1' })
    const { events } = await readEvents(root)
    assert.equal(events.length, 1)
    const ev = events[0]
    assert.equal(ev.type, 'meta')
    assert.equal(ev.source, 'system')
    assert.equal(ev.day, 0)
    assert.equal(ev.text, 'use:her_note ok 记下了：买灯泡')
    assert.equal(ev.sessionId, 's1')
  })
})

test('记账：被挡住的那次不写盘', async () => {
  await withRoot(async (root) => {
    await recordUse(root, { tool: 'bili_watch', out: { ok: false, note: '现在看不了画面。' } })
    const { events } = await readEvents(root)
    assert.equal(events.length, 0)
  })
})

test('记账永远不抛：root 不存在也只是没记上', async () => {
  // 记账失败绝不能让她这次动作失败，所以这里只要不抛就算过。
  await recordUse(join(tmpdir(), 'fish-use-does-not-exist', 'nope'), { tool: 'her_note', out: { ok: true, note: '记下了' } })
})

test('withUse：跑完照旧返回，顺手记一行', async () => {
  await withRoot(async (root) => {
    let ran = 0
    const def = {
      name: 'her_note',
      execute: async () => {
        ran += 1
        return { ok: true, echo: '记下了：买灯泡' }
      },
    }
    const wrapped = withUse(def, { root, tool: 'her_note' })
    // 只换 execute，工具定义其余部分原样（宿主要的是同一份 JSON Schema）
    assert.equal(wrapped.name, 'her_note')
    assert.equal(wrapped.execute === def.execute, false)
    const out = await wrapped.execute({}, { sessionId: 's2' })
    assert.equal(out.ok, true)
    assert.equal(ran, 1)
    const { events } = await readEvents(root)
    assert.equal(events.length, 1)
    assert.equal(events[0].text, 'use:her_note ok 记下了：买灯泡')
  })
})

test('withUse：没有 execute 的定义原样返回，不包一层空壳', () => {
  const def = { name: 'x', description: '读的' }
  assert.equal(withUse(def, { root: '/tmp/x', tool: 'x' }), def)
})

test('withUse：工具抛错也留一笔，错误照旧往上抛（用户 m00493 的 ④）', async () => {
  await withRoot(async (root) => {
    const def = { name: 'x', execute: async () => { throw new Error('炸了') } }
    const wrapped = withUse(def, { root, tool: 'x' })
    await assert.rejects(() => wrapped.execute({}, {}), /炸了/)
    const { events } = await readEvents(root)
    assert.equal(events.length, 1)
    assert.equal(events[0].type, 'meta')
    assert.equal(events[0].text, 'use:x fail 这次没成。')
  })
})

test('withUseDuringRegistration：注册期间临时换 register，用完换回来', () => {
  const defs = []
  const ctx = {
    tools: {
      register(d) {
        defs.push(d)
        return () => {}
      },
    },
  }
  const orig = ctx.tools.register
  const seen = []
  withUseDuringRegistration(ctx, '/tmp/root', () => {
    seen.push(ctx.tools.register === orig)
    ctx.tools.register({ name: 'her_note', execute: async () => ({ ok: true }) })
  })
  // 注册期间确实换成了包装版，注册完恢复原样
  assert.deepEqual(seen, [false])
  assert.equal(ctx.tools.register, orig)
  assert.equal(defs.length, 1)
  assert.equal(defs[0].name, 'her_note')
})

test('withUseDuringRegistration：没有 register 时照常跑，不炸', () => {
  let ran = 0
  const r = withUseDuringRegistration({}, '/tmp/root', () => {
    ran += 1
    return 'ok'
  })
  assert.equal(r, 'ok')
  assert.equal(ran, 1)
})

// 2026-11-10（外部真机 0.9.6）：宿主把 `ctx.tools` 包成只读 proxy，
// 给 `register` 赋值抛 "TypeError: 'set' on proxy: trap returned falsish"，
// 而它发生在注册循环之前 → boot 中断、/dsh-fish/* 全 404。
// 换不上就先别换：改在 defineTool 这一层包 execute，注册与记账都照旧。
test('宿主把 ctx.tools 包成只读 proxy：不抛，注册照走、记账照记', async () => {
  await withRoot(async (root) => {
    const defs = []
    const register = (d) => {
      defs.push(d)
      return () => {}
    }
    const tools = new Proxy(
      {},
      {
        get: (t, k) => (k === 'register' ? register : t[k]),
        set: () => false,
        defineProperty: () => false,
      },
    )
    // 先确认这确实是「写不进去」的那种对象
    assert.throws(() => {
      tools.register = register
    }, TypeError)

    const ctx = { tools }
    let ran = 0
    withUseDuringRegistration(ctx, root, () => {
      ran += 1
      ctx.tools.register(
        defineTool({
          name: 'her_probe',
          description: '随便一个工具',
          parameters: { type: 'object', properties: {} },
          execute: async () => ({ ok: true }),
        }),
      )
    })

    assert.equal(ran, 1, '注册那段照常跑完')
    assert.equal(defs.length, 1)
    assert.equal(defs[0].name, 'her_probe')

    await defs[0].execute({}, {})
    const { events } = await readEvents(root)
    assert.equal(events.length, 1, '只读宿主也照样记 use: 账')
    assert.ok(events[0].text.startsWith('use:her_probe'))

    // 出来之后 defineTool 回到恒等，不把注册期的钩子漏到外面
    const spec = { name: 'later' }
    assert.equal(defineTool(spec), spec)
  })
})

// 2026-11-10（外部真机 0.9.7）：注册窗口里宿主可能正在挂 agent preset——
// `subagent` / `persona` 这类就是那条路上来的。那些定义不是我们的：不包 execute、
// 不记 use 账，`this` 也原样交回去。把它们钉在我们的 ctx 上，等于把预设工具
// 注册到全局层；之后每个 agent 再挂一次，宿主就报 `tool "subagent" is already registered`。
test('注册窗口里别人注册的工具原样透传，不包、不记、不钉 this', async () => {
  await withRoot(async (root) => {
    const got = []
    const registry = {
      register(...args) {
        got.push({ args, self: this })
        return () => {}
      },
    }
    const foreign = { name: 'subagent', execute: async () => ({ ok: true }) }
    withUseDuringRegistration({ tools: registry }, root, () => {
      registry.register(foreign)
    })
    assert.equal(got.length, 1)
    assert.equal(got[0].args[0], foreign, '别人那份定义要原样交出去')
    assert.equal(got[0].self, registry, 'register 的 this 必须还是原来那个对象')
    const { events } = await readEvents(root)
    assert.equal(events.length, 0, '别人的工具不进她的 use 账')
  })
})

test('回忆：use: 行翻得到，读出来是一句人话', () => {
  const now = Date.now()
  const events = [
    {
      id: 'u1',
      type: 'meta',
      ts: new Date(now - 3600_000).toISOString(),
      text: 'use:her_note ok 记下了：买灯泡',
    },
  ]
  const { rows } = searchEvents(events, '灯泡', { now })
  assert.equal(rows.length, 1)
  // 行里存的是原文，来路标注在渲染时才加（与 heard / voice 同一套）
  assert.match(renderRecall(rows), /用过 her_note，记下了：买灯泡/)
  assert.doesNotMatch(renderRecall(rows), /use:her_note/)
})

test('回忆：失败的 use: 行说清是没成', () => {
  const now = Date.now()
  const events = [
    {
      id: 'u2',
      type: 'meta',
      ts: new Date(now - 3600_000).toISOString(),
      text: 'use:bili_watch fail 这不是一个视频号。',
    },
  ]
  const { rows } = searchEvents(events, '视频号', { now })
  assert.equal(rows.length, 1)
  assert.match(renderRecall(rows), /用过 bili_watch，没成：这不是一个视频号。/)
})

test('回忆：别的 meta 照旧跳过——放开的是 use:，不是整个 meta 层', () => {
  const now = Date.now()
  const events = [
    { id: 'm', type: 'meta', ts: new Date(now - DAY).toISOString(), text: `评论 ${USE_PREFIX}不是开头的` },
  ]
  assert.equal(searchEvents(events, '评论', { now, days: 30 }).rows.length, 0)
})

test('withUse：别的家的会话调用不写账，返回值照旧（2026-11-09 外部用户报告）', async () => {
  await withRoot(async (root) => {
    const def = { name: 'her_note', execute: async () => ({ ok: false, note: '这条调用来自另一个家（default-workspace），不是这里。' }) }
    const wrapped = withUse(def, { root, tool: 'her_note' })
    const out = await wrapped.execute({}, { sessionId: 'other', session: { id: 'other', cwd: join(tmpdir(), 'fish-someone-else') } })
    assert.equal(out.ok, false, '工具自己的返回不能改')
    const { events } = await readEvents(root)
    assert.equal(events.length, 0, '别人的误操作不该进她的成长账')
  })
})

test('withUse：她家的会话照记，没有 cwd 的会话也照记', async () => {
  await withRoot(async (root) => {
    const def = { name: 'her_note', execute: async (args) => ({ ok: true, echo: args.echo }) }
    const wrapped = withUse(def, { root, tool: 'her_note' })
    // 两条账的文不一样，避免撞上「十分钟内说同一件事只记一次」的节流
    await wrapped.execute({ echo: '记下了：买灯泡' }, { sessionId: 'own', session: { id: 'own', cwd: root } })
    await wrapped.execute({ echo: '翻到日记了。' }, { sessionId: 'nobody' })
    const { events } = await readEvents(root)
    assert.equal(events.length, 2, '家里的和来路不明的照旧各记一条')
  })
})

test('withUse：别的家的会话即使工具抛错也不写账，错误照旧往上抛', async () => {
  await withRoot(async (root) => {
    const def = { name: 'x', execute: async () => { throw new Error('炸了') } }
    const wrapped = withUse(def, { root, tool: 'x' })
    await assert.rejects(
      () => wrapped.execute({}, { sessionId: 'other', session: { id: 'other', cwd: join(tmpdir(), 'fish-someone-else') } }),
      /炸了/,
    )
    const { events } = await readEvents(root)
    assert.equal(events.length, 0)
  })
})

const DAY = 86_400_000
