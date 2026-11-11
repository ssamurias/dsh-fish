/**
 * mutate-json.test.mjs —— 「读整份 → 改一项 → 写回」按文件排队
 *
 * writeAtomic 只保证盘上不是半截文件；两次读-改-写并发时两边读到同一份旧快照，
 * 后落盘的把先落盘的盖掉，两边都回 ok。home.json / channels.json 早有各自的队，
 * 这里守其余几份：便条、约定、最近几轮对话、排队的交接句、config.json、当天的日记。
 *
 * 守的事：
 *   1. mutateJson：同一个文件一个接一个，抛错不堵后面的，不同文件互不等待；
 *   2. 每份台账并发写几次，回执说成了几次，盘上就有几项；
 *   3. 上限在并发下照样算数（约定最多两件没做完的）；
 *   4. 交接句「取走 → 把别的会话的放回去」中间排进来的那一句不丢。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { mutateJson, readJson, writeAtomic, writeDaily, readDaily } from '../lib/store.js'
import { addNote, closeNote, readNotes } from '../lib/note.js'
import { makeAppointment, markNotified, moveAppointment, readAppointments, APPOINT_OPEN_MAX } from '../lib/appoint.js'
import { addExchange, recentExchanges } from '../lib/talkmem.js'
import { queueNote, takeNotes, deliverQueued } from '../lib/sessionnote.js'
import { updateConfig, loadConfig } from '../lib/settings.js'

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-fish-mutate-'))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('mutateJson：同一个文件的读-改-写一个接一个，谁也不盖谁', async () => {
  await withRoot(async (root) => {
    const file = join(root, 'counter.json')
    const bump = () => mutateJson(file, async () => {
      const cur = await readJson(file, { n: 0 })
      await sleep(2)
      await writeAtomic(file, JSON.stringify({ n: cur.n + 1 }))
      return cur.n + 1
    })
    const got = await Promise.all(Array.from({ length: 12 }, bump))
    assert.deepEqual(got, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    assert.equal((await readJson(file)).n, 12)
  })
})

test('mutateJson：一次抛错只让那一次失败，后面排着的照常跑', async () => {
  await withRoot(async (root) => {
    const file = join(root, 'x.json')
    const bad = mutateJson(file, async () => { throw new Error('boom') })
    const good = mutateJson(file, async () => 'ok')
    await assert.rejects(bad, /boom/)
    assert.equal(await good, 'ok')
  })
})

test('mutateJson：不同文件互不等待；同一个文件的不同写法算同一个', async () => {
  await withRoot(async (root) => {
    const order = []
    let release
    const gate = new Promise((r) => { release = r })
    const slow = mutateJson(join(root, 'a.json'), async () => { await gate; order.push('a') })
    await mutateJson(join(root, 'b.json'), async () => { order.push('b') })
    assert.deepEqual(order, ['b'])
    // 同一个文件换一种写法（多绕一层目录）也排在同一队里
    const same = mutateJson(join(root, 'sub', '..', 'a.json'), async () => { order.push('a2') })
    await sleep(10)
    assert.deepEqual(order, ['b'])
    release()
    await Promise.all([slow, same])
    assert.deepEqual(order, ['b', 'a', 'a2'])
  })
})

test('便条：并发记五张，回执五个「已记」，盘上五张', async () => {
  await withRoot(async (root) => {
    const res = await Promise.all([1, 2, 3, 4, 5].map((i) => addNote(root, { text: `第${i}张便条` })))
    assert.equal(res.filter((r) => r.ok).length, 5)
    const left = await readNotes(root)
    assert.deepEqual(left.map((n) => n.text).sort(), [1, 2, 3, 4, 5].map((i) => `第${i}张便条`))
  })
})

test('便条：一边划掉旧的一边记新的，两件事都在', async () => {
  await withRoot(async (root) => {
    await addNote(root, { text: '旧的那张' })
    const [a, b] = await Promise.all([
      closeNote(root, { text: '旧的那张' }),
      addNote(root, { text: '新的那张' }),
    ])
    assert.equal(a.ok, true)
    assert.equal(b.ok, true)
    const left = await readNotes(root)
    assert.equal(left.find((n) => n.text === '旧的那张')?.status, 'done')
    assert.equal(left.find((n) => n.text === '新的那张')?.status, 'open')
  })
})

test('约定：并发约两件，两件都在；并发约三件，上限照样算数', async () => {
  await withRoot(async (root) => {
    const now = Date.parse('2026-11-12T04:00:00Z')
    const res = await Promise.all([1, 2, 3].map((i) =>
      makeAppointment(root, { what: `一起做第${i}件事`, due: `2026-11-2${i}`, now })))
    assert.equal(res.filter((r) => r.ok).length, APPOINT_OPEN_MAX)
    const left = await readAppointments(root)
    assert.equal(left.length, APPOINT_OPEN_MAX)
    assert.deepEqual(left.map((a) => a.id).sort(), res.filter((r) => r.ok).map((r) => r.id).sort())
  })
})

test('约定：定时器记「提过了」和另一条改期撞上，两边都落盘', async () => {
  await withRoot(async (root) => {
    const now = Date.parse('2026-11-12T04:00:00Z')
    const a = await makeAppointment(root, { what: '一起看那部电影', due: '2026-11-13', now })
    const b = await makeAppointment(root, { what: '一起去逛书店', due: '2026-11-14', now })
    assert.ok(a.ok && b.ok)
    const [marked, moved] = await Promise.all([
      markNotified(root, a.id, now),
      moveAppointment(root, { id: b.id, newDue: '2026-11-20', now }),
    ])
    assert.equal(marked, true)
    assert.equal(moved.ok, true)
    const left = await readAppointments(root)
    assert.ok(left.find((x) => x.id === a.id)?.notifiedAt)
    assert.equal(left.find((x) => x.id === b.id)?.due, '2026-11-20')
  })
})

test('最近几轮对话：并发记五轮（书房和群聊都有），一轮不少', async () => {
  await withRoot(async (root) => {
    const res = await Promise.all([1, 2, 3, 4, 5].map((i) =>
      addExchange(root, { me: `问${i}`, her: `答${i}`, scene: i === 5 ? 'group' : 'desk' })))
    assert.equal(res.filter((r) => r.ok).length, 5)
    const home = await recentExchanges(root, 20)
    const group = await recentExchanges(root, 20, 'group')
    assert.deepEqual(home.map((r) => r.me).sort(), ['问1', '问2', '问3', '问4'])
    assert.deepEqual(group.map((r) => r.me), ['问5'])
  })
})

test('交接句：并发排五句，取出来五句', async () => {
  await withRoot(async (root) => {
    const res = await Promise.all([1, 2, 3, 4, 5].map((i) => queueNote(root, `交接${i}`, { sessionId: `s${i}` })))
    assert.equal(res.filter((r) => r.ok).length, 5)
    const left = await takeNotes(root)
    assert.deepEqual(left.map((n) => n.text).sort(), ['交接1', '交接2', '交接3', '交接4', '交接5'])
  })
})

test('交接句：一条会话取自己那句的同时又排进来一句，别的会话的和新排的都还在', async () => {
  await withRoot(async (root) => {
    await queueNote(root, '给甲的', { sessionId: 'a' })
    await queueNote(root, '给乙的', { sessionId: 'b' })
    const said = []
    const agent = { session: { header: { id: 'a' }, append: (_type, msg) => { said.push(msg.content[0].text) } } }
    const [d, q] = await Promise.all([
      deliverQueued(agent, root),
      queueNote(root, '给丙的', { sessionId: 'c' }),
    ])
    assert.equal(d.delivered, 1)
    assert.deepEqual(said, ['给甲的'])
    assert.equal(q.ok, true)
    const left = await takeNotes(root)
    assert.deepEqual(left.map((n) => n.text).sort(), ['给丙的', '给乙的'].sort())
  })
})

test('配置：并发改两个不相干的键，两个都生效', async () => {
  await withRoot(async (root) => {
    const before = (await updateConfig({}, root))
    const flipped = !before.browse.enabled
    await Promise.all([
      updateConfig({ browse: { enabled: flipped } }, root),
      updateConfig({ diary: { keepDays: 123 } }, root),
    ])
    const after = (await loadConfig(root)).config
    assert.equal(after.browse.enabled, flipped)
    assert.equal(after.diary.keepDays, 123)
  })
})

test('日记：同一天并发追加两段，三段都在文件里', async () => {
  await withRoot(async (root) => {
    await writeDaily('diaryDir', '2026-11-12', '第一段', root)
    await Promise.all([
      writeDaily('diaryDir', '2026-11-12', '第二段', root),
      writeDaily('diaryDir', '2026-11-12', '第三段', root),
    ])
    const text = await readDaily('diaryDir', '2026-11-12', root)
    for (const s of ['第一段', '第二段', '第三段']) assert.ok(text.includes(s), `少了「${s}」`)
  })
})

test('日记：同一天的头两篇并发写，两篇都在（不是谁后写谁整篇盖掉）', async () => {
  await withRoot(async (root) => {
    await Promise.all([
      writeDaily('diaryDir', '2026-11-12', '早上那篇', root),
      writeDaily('diaryDir', '2026-11-12', '晚上那篇', root),
    ])
    const text = await readDaily('diaryDir', '2026-11-12', root)
    assert.ok(text.includes('早上那篇') && text.includes('晚上那篇'))
  })
})
