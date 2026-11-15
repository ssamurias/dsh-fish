import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { basicPressureThreshold, pressureScore, registerSessionPressure, summarizePressure } from '../lib/session-pressure.js'

test('pressure uses the effective threshold and preserves unknowns', () => {
  const policy = { thresholdRatio: .8, headroomTokens: 2_000, retainRatio: .3,
    modelPolicies: [{ provider: 'demo', model: 'small', thresholdRatio: .7 }] }
  const route = { provider: 'demo', model: 'small' }
  assert.equal(basicPressureThreshold(policy, route, 100_000, 10_000), 70_000)
  assert.equal(basicPressureThreshold(policy, route, 100_000, 40_000), 58_000)
  assert.equal(basicPressureThreshold(policy, route, 100_000, undefined), null)
  assert.equal(pressureScore(80_000, 70_000), 100)
  assert.equal(pressureScore(35_000, 70_000), 50)
  assert.equal(pressureScore(35_000, null), null)
})

test('growth requires consecutive comparable observations', () => {
  const a = { route: 'a', contextWindow: 1000, threshold: 800 }
  const rows = [
    { ...a, seq: 4, turn: 1, tokens: 200 },
    { ...a, seq: 8, turn: 2, tokens: 300 },
    { ...a, seq: 10, turn: 3, tokens: 240, compacted: true },
    { ...a, seq: 17, turn: 5, tokens: 450 },
    { ...a, seq: 21, turn: 6, tokens: 460, route: 'b' },
  ]
  const view = summarizePressure({ active: rows }, { sessionId: 'active' }, 0)
  assert.deepEqual(view.rows.map(r => r.delta), [null, 100, null, null, null])
  assert.deepEqual(view.growth.map(r => r.turn), [2])
})

test('observer stores one numeric sample per session event and leaves the home file untouched', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fish-pressure-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const home = JSON.stringify({ sessionId: 'active' })
  await writeFile(join(root, 'home.json'), home)
  let listener
  const meter = { measure: () => ({ logRevision: 4, totalTokens: 120, nodes: [{ seq: 2, tokens: 7 }] }) }
  const ctx = {
    on: (_type, fn) => { listener = fn; return () => { listener = null } },
    get: name => name === 'tokenMeter' ? meter : undefined,
  }
  const events = [
    { type: 'turn/start' },
    { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: 'call', name: 'fetch' }] } } },
    { type: 'tool/result', data: { turn: 1, message: { toolCallId: 'call', content: 'private tool text' } } },
  ]
  const session = {
    header: { id: 'active' },
    requestContext: () => ({ provider: 'demo', model: 'small', contextWindow: 500 }),
    eventAt: seq => events[seq],
  }
  const observer = registerSessionPressure(ctx, root)
  const event = { type: 'turn/end', seq: 3, time: Date.now(), data: { turn: 1 } }
  listener(session, event)
  listener(session, event)
  for (let i = 0; i < 100 && !(await observer.view()).current; i++) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  const view = await observer.view()
  assert.equal(view.rows.length, 1)
  assert.equal(view.current.tokens, 120)
  assert.equal(view.current.score, null)
  assert.deepEqual(view.tools, [{ name: 'fetch', tokens: 7, calls: 1 }])
  assert.equal((await registerSessionPressure({}, root).view()).current.seq, 3)
  assert.equal(await readFile(join(root, 'home.json'), 'utf8'), home)
  const disk = await readFile(join(root, 'logs', 'session-pressure', 'samples.json'), 'utf8')
  assert(!disk.includes('private tool text'))
  observer.dispose()
  assert.equal(listener, null)
})
