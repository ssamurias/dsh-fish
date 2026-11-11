/**
 * sessionnote.js —— 往会话里补一句人话（0.6.16），以及 2026-10-29 修的那个 bug：
 * `deliverQueued` 写好了却没有人调用，排队的话永远躺在那份文件里。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { appendNote, queueNote, takeNotes, deliverQueued } from '../lib/sessionnote.js'
import { registerIdentity } from '../lib/identity.js'

function tmp() {
  return mkdtempSync(join(tmpdir(), 'fish-note-'))
}

/** 一条活着的会话：append 记下来，别的不管。 */
function fakeAgent({ id = 'session-home', cwd = '' } = {}) {
  const written = []
  return {
    written,
    session: {
      header: { id, cwd },
      append: (type, data, opts) => {
        written.push({ type, data, opts })
        return { ok: true }
      },
      snapshotEvents: () => [],
    },
    ctx: {
      systemPrompt: { section: () => () => {} },
      effect: (fn) => fn,
      tools: { guard: () => () => {} },
    },
  }
}

test('appendNote：写的是 user/message，带 surfaceOp，id 有前缀', () => {
  const agent = fakeAgent()
  const r = appendNote(agent, '（大肥鱼回去了，这条对话还给你。）', { now: 1700000000000 })
  assert.equal(r.ok, true)
  assert.equal(agent.written.length, 1)
  const ev = agent.written[0]
  assert.equal(ev.type, 'user/message')
  assert.equal(ev.opts.surfaceOp, 'append')
  assert.equal(ev.data.role, 'user')
  assert.equal(ev.data.source.kind, 'user')
  assert.ok(String(ev.data.id).startsWith('fish-note-1700000000000-'))
  assert.ok(Array.isArray(ev.data.content))
  assert.match(ev.data.content[0].text, /这条对话还给你/)
})

test('appendNote：空白、没有会话都不抛，只回一句为什么', () => {
  assert.equal(appendNote(fakeAgent(), '   ').ok, false)
  const r = appendNote({ session: null }, '随便一句')
  assert.equal(r.ok, false)
  assert.match(r.why, /没开着/)
})

test('queueNote / takeNotes：排进去，取走就清空（不重复投递）', async () => {
  const root = tmp()
  try {
    const q = await queueNote(root, '这趟里我不认这几条：…')
    assert.equal(q.ok, true)
    assert.equal(q.queued, 1)
    assert.ok(existsSync(join(root, 'session-notes.json')))

    const first = await takeNotes(root)
    assert.equal(first.length, 1)
    assert.match(first[0].text, /不认这几条/)

    const second = await takeNotes(root)
    assert.equal(second.length, 0)
    const raw = JSON.parse(readFileSync(join(root, 'session-notes.json'), 'utf8'))
    assert.deepEqual(raw.notes, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('queueNote：最多留 50 句，旧的先被挤出去', async () => {
  const root = tmp()
  try {
    for (let i = 1; i <= 55; i += 1) await queueNote(root, `第 ${i} 句`)
    const raw = JSON.parse(readFileSync(join(root, 'session-notes.json'), 'utf8'))
    assert.equal(raw.notes.length, 50)
    assert.match(raw.notes[0].text, /第 6 句/)
    assert.match(raw.notes[49].text, /第 55 句/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('deliverQueued：把排队的话补进会话，补完清空', async () => {
  const root = tmp()
  try {
    await queueNote(root, '第一句')
    await queueNote(root, '第二句')
    const agent = fakeAgent()
    // 没有 sessionId 的老条目是给家里的（0.6.16 驳回话术），所以这里按「家里」投。
    const r = await deliverQueued(agent, root, { home: true })
    assert.equal(r.delivered, 2)
    assert.equal(agent.written.length, 2)
    assert.match(agent.written[0].data.content[0].text, /第一句/)
    assert.equal((await takeNotes(root)).length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('registerIdentity：她家那条会话一起来，就把排队的话补进去（2026-10-29 修的那个 bug）', async () => {
  const root = tmp()
  try {
    const herDir = join(root, 'home')
    await queueNote(root, '这趟里我不认这几条：「随手写的一句」 / 它们不算你，别的算。')

    let handler = null
    const ctx = {
      on: (name, fn) => {
        if (name === 'agent/created') handler = fn
        return () => {}
      },
      get: () => undefined,
      effect: (fn) => fn,
    }
    const un = registerIdentity(ctx, { root, herDir, log: () => {} })
    assert.equal(typeof handler, 'function')

    const agent = fakeAgent({ id: 'session-home', cwd: herDir })
    handler({ agent })
    // deliverQueued 是 void 的，等一拍让它跑完
    await new Promise((r) => setTimeout(r, 30))

    const texts = agent.written
      .filter((w) => w.type === 'user/message')
      .map((w) => w.data.content[0].text)
    assert.ok(texts.some((t) => /不认这几条/.test(t)), '排队的那句话要真的补进她的会话')
    assert.equal(existsSync(join(root, 'session-notes.json')) ? (await takeNotes(root)).length : 0, 0)
    if (typeof un === 'function') un()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('identity.js 里真的调了 deliverQueued（防止它再变回死代码）', () => {
  const src = readFileSync(new URL('../lib/identity.js', import.meta.url), 'utf8')
  assert.match(src, /import \{ deliverQueued \} from '\.\/sessionnote\.js'/)
  assert.match(src, /deliverQueued\(agent, root/)
})

// 2026-10-30（用户 m03179）：出门结束的交接句必须回到它自己那条会话，
// 不能被顺手投进家里那条——那会变成一句没头没尾的噪音。
test('deliverQueued：带 sessionId 的只投给它自己那条，投不到就留着', async () => {
  const root = tmp()
  try {
    await queueNote(root, '给外面那条的交接句', { sessionId: 'session-out' })
    const home = fakeAgent({ id: 'session-home' })
    const r1 = await deliverQueued(home, root, { home: true })
    assert.equal(r1.delivered, 0, '家里那条不该收到别人的交接句')

    const out = fakeAgent({ id: 'session-out' })
    const r2 = await deliverQueued(out, root)
    assert.equal(r2.delivered, 1)
    assert.match(String(out.written[0].data.content[0].text), /交接句/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// 2026-11-12：投进去了才从文件里删。以前先清空再投，投不进去的那句两头都没有；
// 两条会话同时起来各读各写，已经投出去的一句又被写回文件、下次再投一遍。
const queuedTexts = (root) => {
  const file = join(root, 'session-notes.json')
  if (!existsSync(file)) return []
  return JSON.parse(readFileSync(file, 'utf8')).notes.map((n) => n.text)
}

test('deliverQueued：append 抛错时这句还在文件里，下次照样投得出去', async () => {
  const root = tmp()
  try {
    await queueNote(root, '这趟里有几条没算数')
    const closing = fakeAgent()
    closing.session.append = () => { throw new Error('session is closing') }
    const r1 = await deliverQueued(closing, root, { home: true })
    assert.equal(r1.delivered, 0)
    assert.deepEqual(queuedTexts(root), ['这趟里有几条没算数'], '没投进去的不能从文件里消失')

    const agent = fakeAgent()
    const r2 = await deliverQueued(agent, root, { home: true })
    assert.equal(r2.delivered, 1)
    assert.match(agent.written[0].data.content[0].text, /没算数/)
    assert.deepEqual(queuedTexts(root), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('deliverQueued：那条会话没有 append（没开着）时一句都不丢', async () => {
  const root = tmp()
  try {
    await queueNote(root, '第一句')
    await queueNote(root, '第二句')
    const r = await deliverQueued({ session: { header: { id: 'session-home' } } }, root, { home: true })
    assert.equal(r.delivered, 0)
    assert.deepEqual(queuedTexts(root), ['第一句', '第二句'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('deliverQueued：投到一半抛错，只留下没投进去的那几句', async () => {
  const root = tmp()
  try {
    await queueNote(root, '第一句')
    await queueNote(root, '第二句')
    await queueNote(root, '第三句')
    const agent = fakeAgent()
    const append = agent.session.append
    agent.session.append = (type, data, opts) => {
      if (/第二句/.test(data.content[0].text)) throw new Error('boom')
      return append(type, data, opts)
    }
    const r = await deliverQueued(agent, root, { home: true })
    assert.equal(r.delivered, 2)
    assert.deepEqual(agent.written.map((w) => w.data.content[0].text), ['第一句', '第三句'])
    assert.deepEqual(queuedTexts(root), ['第二句'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('deliverQueued：两条会话同时起来，各自的句子各投一次，文件里不留已投的', async () => {
  const root = tmp()
  try {
    await queueNote(root, '家里的一句')
    await queueNote(root, '外面那条的交接', { sessionId: 'session-out' })
    const home = fakeAgent({ id: 'session-home' })
    const out = fakeAgent({ id: 'session-out' })
    const [a, b] = await Promise.all([
      deliverQueued(home, root, { home: true }),
      deliverQueued(out, root),
    ])
    assert.equal(a.delivered, 1)
    assert.equal(b.delivered, 1)
    assert.deepEqual(home.written.map((w) => w.data.content[0].text), ['家里的一句'])
    assert.deepEqual(out.written.map((w) => w.data.content[0].text), ['外面那条的交接'])
    assert.deepEqual(queuedTexts(root), [], '都投完了，文件里不该还留着哪一句')

    // 再起来一次，谁都不该再收到
    await Promise.all([deliverQueued(home, root, { home: true }), deliverQueued(out, root)])
    assert.equal(home.written.length, 1)
    assert.equal(out.written.length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('deliverQueued：同一条会话被两处同时补，一句只投一次', async () => {
  const root = tmp()
  try {
    await queueNote(root, '只该出现一次的一句')
    const agent = fakeAgent()
    const rs = await Promise.all([
      deliverQueued(agent, root, { home: true }),
      deliverQueued(agent, root, { home: true }),
    ])
    assert.equal(rs[0].delivered + rs[1].delivered, 1)
    assert.equal(agent.written.length, 1)
    assert.deepEqual(queuedTexts(root), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('queueNote：同时排几句、排的时候正好在投，一句都不丢', async () => {
  const root = tmp()
  try {
    const rs = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => queueNote(root, `同时排的第 ${i} 句`)))
    assert.ok(rs.every((r) => r.ok))
    assert.equal(queuedTexts(root).length, 6)

    const agent = fakeAgent()
    const [d] = await Promise.all([
      deliverQueued(agent, root, { home: true }),
      queueNote(root, '投的时候才排进来的一句'),
    ])
    assert.equal(d.delivered, 6)
    assert.deepEqual(queuedTexts(root), ['投的时候才排进来的一句'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
