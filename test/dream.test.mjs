/**
 * dream.test.mjs —— 梦（A 案，2026-10-30，本机实验，用户 m02837）
 *
 * 为什么单独测这一层：梦是唯一一种「只重新组织、不产生新信息」的记录。
 * 四条硬约束必须由代码守，而不是由提示词里的请求守：
 *   1. refs 必须指向真实存在的事件（编不出来就写不了）；
 *   2. 只能是「她自己说过的话」当材料；
 *   3. 出门/请神那几趟写下的事件不能当材料（否则绕过回家审查）；
 *   4. 不进任何派生（deriveSelf 结果与没有梦时完全一致）。
 * 另外钉住可见性：`/dream` 在没有 `.dev` 时必须 404——界面藏起来但路由能读，
 * 就是 0.6.10 那次没藏住的老路。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { DREAM_MAX, DREAM_REFS_MAX, dreamOn, dreamView, writeDream } from '../lib/dream.js'
import { deriveSelf } from '../lib/derive.js'
import { dateKey } from '../lib/settings.js'
import { readEvents } from '../lib/store.js'
import { validateEvent } from '../lib/schema.js'
import { registerObserve } from '../lib/observe.js'
import { HER_TOOLS } from '../lib/restrict.js'
import { DREAM_BRIEF } from '../lib/persona.js'

async function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'fish-dream-'))
  try {
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'events.jsonl'), '', 'utf8')
    return await fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

function line(id, ts, { type = 'utterance', text = '今天想起一件事。', sessionId } = {}) {
  return {
    id,
    v: 1,
    ts: ts.toISOString(),
    day: dateKey(ts),
    stage: 1,
    type,
    source: 'tool',
    text,
    refs: [],
    verdict: null,
    confidence: 0.5,
    flags: [],
    ...(sessionId ? { sessionId } : {}),
  }
}

function seed(root, ev) {
  appendFileSync(join(root, 'events.jsonl'), `${JSON.stringify(ev)}\n`, 'utf8')
  return ev
}

const T0 = new Date('2026-10-30T01:00:00.000Z')

test('schema：梦必须指认材料（无 refs / 未知 id / 超过六条都拒）', () => {
  assert.throws(
    () => validateEvent({ type: 'dream', text: '我梦见一间屋子。' }, { source: 'tool', day: 1, stage: 1 }),
    /DREAM_NEEDS_REF|梦不能凭空/,
  )
  assert.throws(
    () => validateEvent(
      { type: 'dream', text: '我梦见一间屋子。', refs: ['ev_a', 'ev_b', 'ev_c', 'ev_d', 'ev_e', 'ev_f', 'ev_g'] },
      { source: 'tool', day: 1, stage: 1, knownIds: new Set(['ev_a', 'ev_b', 'ev_c', 'ev_d', 'ev_e', 'ev_f', 'ev_g']) },
    ),
    /DREAM_TOO_MANY_REFS|最多引用/,
  )
  assert.throws(
    () => validateEvent(
      { type: 'dream', text: '我梦见一间屋子。', refs: ['ev_missing'] },
      { source: 'tool', day: 1, stage: 1, knownIds: new Set(['ev_a']) },
    ),
    /REF_NOT_FOUND|不存在/,
  )
})

test('写一条梦：refs 落到她的话上就成功，一天只能一条', async () => withRoot(async (root) => {
  seed(root, line('ev_a', T0))
  seed(root, line('ev_b', new Date(T0.getTime() + 60_000)))
  const first = await writeDream(root, { text: '梦里那间屋子有一扇没关的窗。', refs: ['ev_a', 'ev_b'] })
  assert.equal(first.ok, true, first.note)
  const { events } = await readEvents(root)
  const dream = events.find((e) => e.type === 'dream')
  assert.ok(dream, '梦要真的写进事件流')
  assert.deepEqual(dream.refs, ['ev_a', 'ev_b'])
  assert.equal(dreamOn(events, dream.day).length, 1)
  assert.equal(dreamView(events).total, 1)

  const second = await writeDream(root, { text: '又梦见一次。', refs: ['ev_a'] })
  assert.equal(second.ok, false)
  assert.match(second.note, /今天已经记过/)
}))

test('「昨夜」卡只给最近一条梦的原文来源，其余条目照旧只给 id', async () => withRoot(async (root) => {
  seed(root, line('ev_a', T0, { text: '先有一句真话。' }))
  seed(root, line('ev_b', new Date(T0.getTime() + 60_000), { text: '然后又有一句。' }))
  await writeDream(root, { text: '梦里那两句话并成了一句。', refs: ['ev_a', 'ev_b'] })
  const { events } = await readEvents(root)

  // 默认（列表用）：不给正文，避免把梦当成证据链来审她。
  assert.equal(dreamView(events).items[0].sources, undefined)

  const withRefs = dreamView(events, { withRefs: true })
  const sources = withRefs.items[0].sources
  assert.equal(sources.length, 2)
  assert.equal(sources[0].text, '先有一句真话。')
  assert.equal(sources[1].type, 'utterance')

  // 来源被删（理论上不会发生）也不炸：只留 id，界面显示「翻不到了」。
  const orphanDream = {
    ...events[0],
    id: 'ev_orphan_dream',
    type: 'dream',
    ts: new Date(Date.now() + 60_000).toISOString(),
    text: '引用了一条已经不在的事。',
    refs: ['ev_gone'],
  }
  const orphan = dreamView([...events, orphanDream], { withRefs: true })
  assert.equal(orphan.items.at(-1).sources[0].text, '')
}))

test('材料只能是她自己说过的话', async () => withRoot(async (root) => {
  seed(root, line('ev_a', T0))
  seed(root, line('ev_meta', T0, { type: 'meta', text: 'diary:2026-10-30' }))
  const r = await writeDream(root, { text: '梦里有人在说话。', refs: ['ev_meta'] })
  assert.equal(r.ok, false)
  assert.match(r.note, /你自己说过的话/)
}))

test('出门/请神那几趟写下的事不进梦', async () => withRoot(async (root) => {
  seed(root, line('ev_a', T0))
  seed(root, line('ev_trip', T0, { text: '在那边看到一段代码。', sessionId: 'session-trip' }))
  writeFileSync(join(root, 'outings.json'), JSON.stringify({
    version: 1,
    outings: [{ sessionId: 'session-trip', status: 'done', startedAt: T0.getTime() }],
  }), 'utf8')
  const r = await writeDream(root, { text: '梦里有另一间屋子。', refs: ['ev_trip'] })
  assert.equal(r.ok, false)
  assert.match(r.note, /出门|请神/)
}))

test('梦不进任何派生：deriveSelf 与没有梦时完全一致', async () => withRoot(async (root) => {
  const say = line('ev_a', T0, { text: '我觉得安静比热闹好。' })
  const before = deriveSelf([say], { growthDays: 30, now: Date.now() })
  const dream = validateEvent(
    { type: 'dream', text: '梦里没有声音。', refs: ['ev_a'] },
    { source: 'tool', day: before.day, stage: before.stage, knownIds: new Set(['ev_a']) },
  )
  const after = deriveSelf([say, dream], { growthDays: 30, now: Date.now() })
  assert.deepEqual(after, before, '梦一旦被算进成长，就不再是梦')
}))

test('长梦与空梦都写不进去', async () => withRoot(async (root) => {
  seed(root, line('ev_a', T0))
  assert.match((await writeDream(root, { text: '', refs: ['ev_a'] })).note, /写出来/)
  const long = '梦'.repeat(DREAM_MAX + 1)
  assert.match((await writeDream(root, { text: long, refs: ['ev_a'] })).note, /太长/)
  assert.equal(DREAM_REFS_MAX, 6)
}))

test('/dream 路由：0.9.0 起公开，没有 .dev 也读得到', async () => withRoot(async (root) => {
  seed(root, line('ev_a', T0))
  await writeDream(root, { text: '梦里那扇窗还开着。', refs: ['ev_a'] })

  const routes = new Map()
  const ctx = {
    get(name) {
      if (name === 'connection') return { requestRejection: () => null }
      if (name === 'webServer') return { register(ex) { routes.set(ex.path, ex.handler); return () => {} } }
      if (name === 'agents') return { get: () => null, list: () => [] }
      if (name === 'workspaceRegistry') return { list: () => [] }
      return undefined
    },
  }
  registerObserve(ctx, { root })

  async function call() {
    const handler = routes.get('/dsh-fish/dream')
    assert.ok(handler, '/dream 路由要注册上')
    const req = Object.assign(Readable.from([]), { method: 'GET', headers: {} })
    let status = 0
    let text = ''
    const res = {
      writableEnded: false,
      writeHead(code) { status = code },
      end(chunk) { text = String(chunk ?? ''); res.writableEnded = true },
    }
    await handler(req, res)
    return { status, json: text ? JSON.parse(text) : null }
  }

  // 0.9.0 起梦是公开能力：没有 .dev 也读得到。
  const open = await call()
  assert.equal(open.status, 200, JSON.stringify(open.json))
  assert.equal(open.json.total, 1)
  assert.equal(open.json.items[0].text, '梦里那扇窗还开着。')
  // 「昨夜」卡要能直接摆出这句话是从哪一行长出来的（2026-11-05）。
  assert.equal(open.json.items[0].sources[0].id, 'ev_a')
  assert.equal(open.json.items[0].sources[0].text, '今天想起一件事。')
}))

test('她得知道自己有 her_dream（0.9.0 起对所有人）', () => {
  assert.ok(HER_TOOLS.includes('her_dream'), '本机白名单里要有它')
  assert.match(DREAM_BRIEF, /her_dream/)
  const selfdoc = readFileSync(new URL('../lib/selfdoc.js', import.meta.url), 'utf8')
  assert.match(selfdoc, /DREAM_BRIEF/)
  assert.match(selfdoc, /DREAM_BRIEF/, '身份文档要念到它')
  const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(client, /group\('梦'/, '设置页有梦那张卡')
})
