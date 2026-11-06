import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { wakeIfBlank, verifyWoke } from '../lib/home.js'
import { freshWakeText } from '../lib/wakeconst.js'

const tick = () => new Promise((r) => setTimeout(r, 0))

/** 等一个条件成立（记账是 prompt 成功之后的异步落盘，不能只等一个 tick）。 */
async function waitFor(fn, ms = 800) {
  const t0 = Date.now()
  for (;;) {
    if (await fn()) return true
    if (Date.now() - t0 > ms) return false
    await new Promise((r) => setTimeout(r, 5))
  }
}

async function readHome(root) {
  try {
    return JSON.parse(await readFile(join(root, 'home.json'), 'utf8'))
  } catch {
    return {}
  }
}

/** 只造 wakeIfBlank 用到的那一层 ctx。 */
function ctxWith(sc) {
  return { get: (name) => (name === 'sessionController' ? sc : undefined) }
}

test('空白会话：叫一声，形状和 scheduler 的唤醒一致', async () => {
  const calls = []
  const sc = {
    list: async () => ({ items: [{ sessionId: 's1', blank: true }] }),
    prompt: async (req) => { calls.push(req) },
  }
  const r = await wakeIfBlank(ctxWith(sc), { sessionId: 's1' })
  assert.equal(r.woke, true)
  await tick()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].sessionId, 's1')
  assert.equal(calls[0].mode, 'queue')
  assert.equal(calls[0].content[0].type, 'text')
  assert.ok(calls[0].requestId.startsWith('wake-fresh-'))
})

// 2026-10-27 用户反馈：屋子刚建好那天 16:06 她被叫醒，第一句是「大概不是我的时段」，
// 用户以为是自己没给权限。这条路径没有 fish:wake 段，时间与缘由只能写进触发语本身。
test('空白会话第一次醒：触发语带上时间与缘由，不让她猜', async () => {
  const calls = []
  const sc = {
    list: async () => ({ items: [{ sessionId: 's1', blank: true }] }),
    prompt: async (req) => { calls.push(req) },
  }
  await wakeIfBlank(ctxWith(sc), { sessionId: 's1' })
  await tick()
  const text = calls[0].content[0].text
  assert.match(text, /现在是 \d{2}:\d{2}/, '要给出当前时间')
  assert.match(text, /屋子刚建好/, '要说清这是一次叫醒，不是她自己的时段')
  assert.match(text, /^（.*）$/, '仍然是括号旁白，不是一句需要她接的话')
})

test('已经有内容的会话：一个字都不说', async () => {
  let called = 0
  const sc = {
    list: async () => ({ items: [{ sessionId: 's1', blank: false }] }),
    prompt: async () => { called += 1 },
  }
  const r = await wakeIfBlank(ctxWith(sc), { sessionId: 's1' })
  assert.equal(r.woke, false)
  await tick()
  assert.equal(called, 0)
})

test('列表里找不到这条会话：按有内容处理，不叫', async () => {
  let called = 0
  const sc = {
    list: async () => ({ items: [{ sessionId: 'other', blank: true }] }),
    prompt: async () => { called += 1 },
  }
  const r = await wakeIfBlank(ctxWith(sc), { sessionId: 's1' })
  assert.equal(r.woke, false)
  await tick()
  assert.equal(called, 0)
})

test('list 抛错：不唤醒、也不把错误抛给调用方', async () => {
  let called = 0
  const logs = []
  const sc = {
    list: async () => { throw new Error('宿主抽风') },
    prompt: async () => { called += 1 },
  }
  const r = await wakeIfBlank(ctxWith(sc), { sessionId: 's1', log: (m) => logs.push(m) })
  assert.equal(r.woke, false)
  await tick()
  assert.equal(called, 0)
  assert.equal(logs.length, 1)
})

test('宿主没有 sessionController / 没有 prompt：明确说不行，不抛', async () => {
  assert.equal((await wakeIfBlank({}, { sessionId: 's1' })).woke, false)
  assert.equal((await wakeIfBlank(ctxWith({ list: async () => ({ items: [{ sessionId: 's1', blank: true }] }) }), { sessionId: 's1' })).woke, false)
})

test('prompt 自己失败：只是记一笔，不产生未处理拒绝', async () => {
  const logs = []
  const sc = {
    list: async () => ({ items: [{ sessionId: 's1', blank: true }] }),
    prompt: async () => { throw new Error('模型不在') },
  }
  const r = await wakeIfBlank(ctxWith(sc), { sessionId: 's1', log: (m) => logs.push(m) })
  assert.equal(r.woke, true)
  await tick()
  assert.ok(logs.some((m) => m.includes('唤醒失败')))
})

test('新建的会话查不到行：按空白处理，叫一声', async () => {
  const calls = []
  const sc = {
    list: async () => ({ items: [] }),
    prompt: async (req) => { calls.push(req) },
  }
  const r = await wakeIfBlank(ctxWith(sc), { sessionId: 's1', freshOnly: true })
  assert.equal(r.woke, true)
  await tick()
  assert.equal(calls.length, 1)
})

test('叫醒必须给宿主传 signal：宿主 prompt 第一句就 signal.throwIfAborted()', async () => {
  // 漏传会抛 `Cannot read properties of undefined (reading 'throwIfAborted')`，
  // 这一声叫不醒，侧栏也看不到她（issue #1）。这里照宿主的真实写法验一遍。
  let signal
  const sc = {
    list: async () => ({ items: [] }),
    prompt: async (_req, received) => {
      signal = received
      received.throwIfAborted()
    },
  }
  const logs = []
  const r = await wakeIfBlank(ctxWith(sc), { sessionId: 's1', freshOnly: true, log: (m) => logs.push(m) })
  assert.equal(r.woke, true)
  await tick()
  assert.equal(typeof signal?.throwIfAborted, 'function')
  assert.equal(signal.aborted, false)
  assert.equal(logs.some((m) => m.includes('唤醒失败')), false)
})

test('复用的会话查不到行：不碰，免得每次启动都让她说话', async () => {
  let called = 0
  const sc = {
    list: async () => ({ items: [] }),
    prompt: async () => { called += 1 },
  }
  const r = await wakeIfBlank(ctxWith(sc), { sessionId: 's1', freshOnly: false })
  assert.equal(r.woke, false)
  await tick()
  assert.equal(called, 0)
})

test('宿主不给 blank 字段：新建才叫，复用不叫', async () => {
  let called = 0
  const sc = {
    list: async () => ({ items: [{ sessionId: 's1' }] }),
    prompt: async () => { called += 1 },
  }
  assert.equal((await wakeIfBlank(ctxWith(sc), { sessionId: 's1', freshOnly: true })).woke, true)
  await tick()
  assert.equal(called, 1)
  assert.equal((await wakeIfBlank(ctxWith(sc), { sessionId: 's1', freshOnly: false })).woke, false)
  await tick()
  assert.equal(called, 1)
})

// --- 同一条会话只叫一次（issue #1 报的第二个问题）------------------------------
//
// 插件建的会话永远不是「当前会话」，宿主也就不把它放进可见列表，于是
// `list()` 里查不到它 → `freshOnly` 那条分支每次都命中 → 每次重启都再叫一次。
// 靠 list() 判不准，所以改成自己记账：叫成功一次就把 sessionId 写进 home.json。

test('同一条会话不会被叫第二次：重启再跑一遍也收手（issue #1 后半）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-wake-'))
  const calls = []
  const sc = {
    // 插件建的会话就是这个形状：宿主列表里根本没有它
    list: async () => ({ items: [] }),
    prompt: async (req) => { calls.push(req) },
  }
  const first = await wakeIfBlank(ctxWith(sc), { sessionId: 's1', root, freshOnly: true })
  assert.equal(first.woke, true)
  await tick()
  assert.equal(calls.length, 1)
  // 记账是 prompt resolve 之后才落盘的，等它真的写下去
  assert.ok(await waitFor(async () => (await readHome(root)).wokeFor === 's1'), '应该把叫过的那条记下来')

  // 模拟「重启之后又走到这里」：同一个 root、同一条 sessionId
  const second = await wakeIfBlank(ctxWith(sc), { sessionId: 's1', root, freshOnly: true })
  assert.equal(second.woke, false)
  assert.match(second.why, /已经叫过/)
  await tick()
  assert.equal(calls.length, 1, '不该再叫第二声')

  assert.equal((await readHome(root)).wokeFor, 's1')
})

test('换了会话就重新算一次：新 id 该叫还是叫', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-wake-'))
  const calls = []
  const sc = {
    list: async () => ({ items: [] }),
    prompt: async (req) => { calls.push(req) },
  }
  await wakeIfBlank(ctxWith(sc), { sessionId: 's1', root, freshOnly: true })
  await tick()
  assert.ok(await waitFor(async () => (await readHome(root)).wokeFor === 's1'))
  const r = await wakeIfBlank(ctxWith(sc), { sessionId: 's2', root, freshOnly: true })
  assert.equal(r.woke, true)
  await tick()
  assert.deepEqual(calls.map((c) => c.sessionId), ['s1', 's2'])
})

test('没给 root 就不记账：不写文件、也不挡第二次（老行为）', async () => {
  let called = 0
  const sc = {
    list: async () => ({ items: [] }),
    prompt: async () => { called += 1 },
  }
  assert.equal((await wakeIfBlank(ctxWith(sc), { sessionId: 's1', freshOnly: true })).woke, true)
  await tick()
  assert.equal((await wakeIfBlank(ctxWith(sc), { sessionId: 's1', freshOnly: true })).woke, true)
  await tick()
  assert.equal(called, 2)
})

test('prompt 失败就不记账：下次启动还会再试一次', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-wake-'))
  const logs = []
  let attempt = 0
  const sc = {
    list: async () => ({ items: [] }),
    prompt: async () => {
      attempt += 1
      if (attempt === 1) throw new Error('模型不在')
    },
  }
  const first = await wakeIfBlank(ctxWith(sc), { sessionId: 's1', root, freshOnly: true, log: (m) => logs.push(m) })
  assert.equal(first.woke, true)
  await tick()
  assert.ok(logs.some((m) => m.includes('唤醒失败')))

  // 第一声没送到 —— 不该留下「叫过了」的痕迹
  assert.equal((await readHome(root)).wokeFor, undefined)

  const second = await wakeIfBlank(ctxWith(sc), { sessionId: 's1', root, freshOnly: true })
  assert.equal(second.woke, true, '上次没叫成，这次要重试')
  await tick()
  assert.equal(attempt, 2)
})

// 2026-11-02（用户 m00324 原话：「换对话还是同一个大肥鱼、同一间屋子，
// 不要让她以为自己是新的一条鱼」）。满 40 轮换掉的只是这一条对话记录，
// 屋子（事件流、天数、她说过的每句话）一个字都没动。原来轮换共用
// 「屋子刚建好」，等于每换一次对话就告诉她「你是新的、这里是新的地方」。
test('轮换那一醒：明说换了对话、没换屋子，不说"屋子刚建好"', () => {
  const now = new Date('2026-11-02T21:30:00')
  const rotated = freshWakeText(now, { rotated: true })
  assert.match(rotated, /^（.*）$/, '仍然是括号旁白')
  assert.match(rotated, /现在是 21:30/)
  assert.match(rotated, /对话换了一条新的/)
  assert.match(rotated, /屋子还是原来那间/)
  assert.ok(!rotated.includes('屋子刚建好'), '轮换不是新屋子，不能说刚建好')
  assert.ok(!rotated.includes('新的一条鱼'), '不能让她以为自己是新的一条')

  // 默认那条必须一个字不动：启动 / 重置 / 重建三条路真的是新屋子。
  const fresh = freshWakeText(now)
  assert.match(fresh, /屋子刚建好/)
  assert.ok(!fresh.includes('对话换了一条新的'))
  assert.notEqual(fresh, rotated)
})

test('wakeIfBlank 把 rotated 传到触发语，默认仍走"屋子刚建好"', async () => {
  const run = async (opts) => {
    const calls = []
    const sc = {
      list: async () => ({ items: [{ sessionId: 's1', blank: true }] }),
      prompt: async (req) => { calls.push(req) },
    }
    await wakeIfBlank(ctxWith(sc), { sessionId: 's1', ...opts })
    await tick()
    return calls[0].content[0].text
  }

  const rotated = await run({ rotated: true })
  assert.match(rotated, /屋子还是原来那间/)
  assert.ok(!rotated.includes('屋子刚建好'))

  const plain = await run({ freshOnly: true })
  assert.match(plain, /屋子刚建好/)
  assert.ok(!plain.includes('屋子还是原来那间'))
})

// 0.8.7（用户 m01775 的截图第 4、5 条）：叫醒"收下了"不等于"落地了"。
// 新会话是插件用 API 建的空白会话，要真跑出一轮才会进宿主的会话列表；
// 没跑成，下一次唤醒就会判它"死的"、退回旧会话，而 wokeFor 已经写上，这声再也不会重试。
test('force：已经记过「叫过了」，只有 force 才肯再叫一次', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-wake-'))
  const calls = []
  const sc = {
    list: async () => ({ items: [{ sessionId: 's1', blank: true }] }),
    prompt: async (req) => { calls.push(req) },
  }
  assert.equal((await wakeIfBlank(ctxWith(sc), { sessionId: 's1', root })).woke, true)
  await waitFor(async () => (await readHome(root)).wokeFor === 's1')
  assert.equal((await readHome(root)).wokeFor, 's1')

  const again = await wakeIfBlank(ctxWith(sc), { sessionId: 's1', root })
  assert.equal(again.woke, false)
  assert.match(again.why, /叫过了/)
  await tick()
  assert.equal(calls.length, 1, '重复唤醒会白烧一轮，还会多一句没头没尾的话')

  const forced = await wakeIfBlank(ctxWith(sc), { sessionId: 's1', root, force: true })
  assert.equal(forced.woke, true, 'force 就是给"这声可能没落地"的复核用的')
  await tick()
  assert.equal(calls.length, 2)
})

test('verifyWoke：人家已经在宿主列表里了，就不打扰', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-wake-'))
  const calls = []
  const sc = {
    list: async () => ({ items: [{ sessionId: 's1', blank: false }] }),
    prompt: async (req) => { calls.push(req) },
  }
  const r = await verifyWoke(ctxWith(sc), { root, sessionId: 's1', delayMs: 0 })
  assert.equal(r.landed, true)
  assert.equal(r.rewoke, false)
  await tick()
  assert.equal(calls.length, 0, '落地了就别再叫')
})

test('verifyWoke：还是不在列表里 → 强行再叫一次，并在日志里说清楚', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-wake-'))
  const calls = []
  const logs = []
  let listed = false
  const sc = {
    // 第一次问：还藏着；再叫之后：出现了
    list: async () => ({ items: listed ? [{ sessionId: 's1', blank: false }] : [] }),
    prompt: async (req) => { calls.push(req); listed = true },
  }
  // 先假装上一轮已经叫过（wokeFor 写上），制造那个死结
  await writeFile(join(root, 'home.json'), JSON.stringify({ sessionId: 's1', wokeFor: 's1' }, null, 2))

  const blocked = await wakeIfBlank(ctxWith(sc), { sessionId: 's1', root })
  assert.equal(blocked.woke, false, '不 force 的话会被自己挡住——这正是要修的东西')

  const r = await verifyWoke(ctxWith(sc), { root, sessionId: 's1', delayMs: 0, log: (m) => logs.push(m) })
  assert.equal(r.landed, false)
  assert.equal(r.rewoke, true)
  await tick()
  assert.equal(calls.length, 1)
  assert.ok(logs.some((m) => m.includes('不在宿主列表里')))
})

test('verifyWoke：没有会话 id 时安静退出，不抛', async () => {
  const r = await verifyWoke(ctxWith(null), { sessionId: '', delayMs: 0 })
  assert.equal(r.landed, false)
  assert.equal(r.rewoke, false)
})

test('verifyWoke：会话在列表里但还空着 → 这一声没落地，再叫一次', async () => {
  // 换房报告里最容易骗过旧判据的一条：宿主的 list() 连空白会话一起推，
  // 旧代码只要「在列表里」就当成功，于是那句「再叫一次」从来没执行过。
  const root = await mkdtemp(join(tmpdir(), 'fish-wake-'))
  const calls = []
  const logs = []
  let blank = true
  await writeFile(join(root, 'home.json'), JSON.stringify({ sessionId: 's1', wokeFor: 's1' }, null, 2))
  const sc = {
    list: async () => ({ items: [{ sessionId: 's1', blank }] }),
    prompt: async (req) => { calls.push(req); blank = false },
  }
  const r = await verifyWoke(ctxWith(sc), { root, sessionId: 's1', delayMs: 0, log: (m) => logs.push(m) })
  assert.equal(r.landed, false)
  assert.equal(r.rewoke, true)
  assert.equal(calls.length, 1)
  assert.ok(logs.some((m) => m.includes('还是空的')))
})

test('verifyWoke：同一条正在复核时再来一次，直接跳过（别叫两声）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-wake-'))
  let release
  const gate = new Promise((ok) => { release = ok })
  let calls = 0
  const sc = {
    // 第一次 list 卡住，让两次复核重叠
    list: () => gate.then(() => ({ items: [{ sessionId: 's1', blank: false }] })),
    prompt: async () => { calls += 1 },
  }
  const first = verifyWoke(ctxWith(sc), { root, sessionId: 's1', delayMs: 0 })
  await tick()
  const second = await verifyWoke(ctxWith(sc), { root, sessionId: 's1', delayMs: 0 })
  assert.equal(second.skipped, true, '换房与 /reset 各挂一次时，不该在她那里变成两声')
  release()
  const r = await first
  assert.equal(r.landed, true)
  assert.equal(calls, 0)
})

test('wakeIfBlank 默认不复核：测试里的替身不会真跑 turn，12 秒后的复查会污染断言', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-wake-'))
  const calls = []
  const sc = {
    list: async () => ({ items: [{ sessionId: 's1', blank: true }] }),
    prompt: async (req) => { calls.push(req) },
  }
  const r = await wakeIfBlank(ctxWith(sc), { sessionId: 's1', root, freshOnly: true })
  assert.equal(r.woke, true)
  await new Promise((ok) => setTimeout(ok, 30))
  assert.equal(calls.length, 1, '不传 verify 时不该自己再挂一次复核')
})
