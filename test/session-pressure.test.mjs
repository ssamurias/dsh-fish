import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildSessionLoad, freezeSessionLoadReference } from '../lib/session-pressure-load.js'
import { analyzePressureEvents } from '../lib/session-pressure-analysis.js'
import { pressureScore, registerSessionPressure, summarizePressure } from '../lib/session-pressure.js'

test('capacity pressure needs a window and is capped at 100', () => {
  assert.equal(pressureScore(80_000, 70_000), 100)
  assert.equal(pressureScore(35_000, 70_000), 50)
  assert.equal(pressureScore(35_000, null), null)
})

test('analytics preserve actual usage, cache coverage, retries, and cross-turn tool visibility', () => {
  const ev = (seq, type, data, surfaceOp) => ({ seq, type, data, surfaceOp })
  const records = [
    ev(0, 'request/context', { provider: 'p', model: 'm', contextWindow: 1000 }),
    ev(1, 'step/start', { turn: 1, step: 1 }),
    ev(2, 'assistant/message', { turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 30 } }, 'append'),
    ev(3, 'tool/call', { turn: 1, step: 1, name: 'read', callId: 'a' }),
    ev(4, 'tool/result', { turn: 1, step: 1, message: { toolCallId: 'a', isError: true, content: [{ type: 'text', text: 'large result' }] } }, 'append'),
    ev(5, 'assistant/message', { turn: 1, step: 2, usage: { inputTokens: 125, outputTokens: 15 } }, 'append'),
    ev(6, 'turn/end', { turn: 1 }),
    ev(7, 'assistant/attempt', { turn: 2, step: 1 }),
    ev(8, 'assistant/message', { turn: 2, step: 1, usage: { inputTokens: 150, outputTokens: 20 } }, 'append'),
    ev(9, 'turn/end', { turn: 2 }),
    ev(10, 'user/message', {}, { op: 'replace', startSeq: 2, endSeq: 4 }),
    ev(11, 'assistant/message', { turn: 3, step: 1 }, 'append'),
  ]
  const view = analyzePressureEvents(records.concat(records[9]))
  assert.equal(view.rows.length, 2)
  assert.equal(view.rows[0].amplification, 2.5)
  assert.deepEqual(view.rows[0].cache, { ratio: .3, reported: 1 })
  assert.equal(view.rows[0].toolErrors, 1)
  assert.equal(view.rows[1].attempts, 1)
  assert.equal(view.rows[1].retries, 1)
  assert.equal(view.rows[1].amplification, null)
  assert.equal(view.burden[0].exposures, 1)
  assert.equal(view.retentionComplete, true)
  const mismatch = analyzePressureEvents([
    ev(1, 'assistant/message', { turn: 1, step: 1,
      usage: { inputTokens: 830, outputTokens: 579, totalTokens: 92161 } }, 'append'),
    ev(2, 'turn/end', { turn: 1 }),
  ]).latest
  assert.equal(mismatch.total.value, 92161)
  assert.equal(mismatch.usageBreakdownMismatch, true)
  assert.equal(mismatch.amplification, null)
  const reportedRetry = analyzePressureEvents([
    ev(1, 'assistant/attempt', { turn: 1, step: 1, stream: [{ type: 'chunk',
      chunk: { type: 'usage', usage: { inputTokens: 20, outputTokens: 5 } } }] }),
    ev(2, 'assistant/message', { turn: 1, step: 1, usage: { inputTokens: 30, outputTokens: 10 } }, 'append'),
    ev(3, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]).latest
  assert.equal(reportedRetry.load.U, 65)
  assert.equal(reportedRetry.load.E, 25)
  assert.equal(reportedRetry.load.A, null)
})

test('load uses all Fish references, including other routes, and preserves unavailable factors', () => {
  const sample = (turns, token, route = 'same') => {
    const rows = Array.from({ length: turns }, (_, i) => ({
      turn: i + 1, route, completed: true, completeUsage: true, total: { value: token },
      load: { U: token, A: 0, T: 5, K: null, E: 0 },
    }))
    return { rows, latest: rows.at(-1) }
  }
  const view = buildSessionLoad(sample(30, 200), [sample(40, 90), sample(42, 100), sample(45, 110),
    sample(25, 75), sample(40, 900, 'different')])
  const factors = Object.fromEntries(view.factors.map(factor => [factor.id, factor]))
  assert.equal(view.referenceCount, 4)
  assert.equal(factors.U.baseline, 4200)
  assert.equal(factors.U.current, 6000)
  assert.equal(factors.T.current, 150)
  for (const id of ['C', 'G', 'A', 'K', 'E']) assert.equal(factors[id].available, false)
  assert.equal(view.distributions[2].below, 1)
  assert.equal(view.points.at(-1).turn, 30)
  const shorter = buildSessionLoad(sample(29, 200), [sample(40, 90), sample(25, 100), sample(45, 110)], null, 20)
  assert.equal(shorter.referenceCount, 3)
  assert.equal(shorter.factors.find(factor => factor.id === 'U').baseline, 2000)
  const endings = buildSessionLoad(sample(29, 200), [sample(5, 90), sample(25, 100), sample(45, 110)], null, 'end')
  assert.equal(endings.referenceCount, 3)
  assert.equal(endings.factors.find(factor => factor.id === 'U').baseline, 2500)

  const frozen = freezeSessionLoadReference(view, '2026-11-15T00:00:00Z')
  const after = buildSessionLoad(sample(31, 200), [sample(40, 900), sample(40, 1000), sample(40, 1100)], frozen)
  assert.equal(after.factors.find(factor => factor.id === 'U').baseline, 4200)
  assert.deepEqual(after.distributions, view.distributions)
  assert.deepEqual(after.trend, view.trend)
  assert.equal(view.trend.find(row => row.turn === 40).samples.length, 4)
  assert.equal(after.referenceCreatedAt, '2026-11-15T00:00:00Z')
  const mixed = sample(40, 95)
  mixed.rows[3].route = 'other-window'
  const partial = sample(40, 100)
  partial.rows[10].load.U = null
  const realCoverage = buildSessionLoad(sample(29, 100), [sample(40, 90), mixed, partial])
  assert.equal(realCoverage.referenceCount, 3)
  assert.equal(realCoverage.trend.find(row => row.turn === 5).samples.length, 3)
  assert.equal(realCoverage.factors.find(factor => factor.id === 'U').samples, 3)
  assert.equal(realCoverage.factors.find(factor => factor.id === 'U').provisional, false)
  const changed = sample(4, 100)
  changed.latest.route = 'changed'
  assert.equal(buildSessionLoad(changed, [sample(45, 100)]).comparable, true)
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
  const home = JSON.stringify({ sessionId: 'active', wsId: 'fish', rotatedFrom: 'previous' })
  await writeFile(join(root, 'home.json'), home)
  let listener
  const meter = { measure: () => ({ logRevision: 4, totalTokens: 120, nodes: [{ seq: 2, tokens: 7 }] }) }
  const ctx = {
    on: (_type, fn) => { listener = fn; return () => { listener = null } },
    get: name => ({
      tokenMeter: meter,
      workspaceRegistry: { archivedSessionIds: ['previous', 'older', 'unrelated', 'child'],
        get: id => id === 'fish' ? { sessionIds: ['active', 'older', 'child'] } : undefined },
      sessionQuery: { observeSession: async id => ({ header: { origin: id === 'child' ? 'subagent' : undefined },
        cursor: 0, events: [] }) },
    })[name],
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
  assert.deepEqual(view.usage.history.map(row => [row.id, row.archived, row.workspaceOnly]),
    [['previous', true, false], ['older', true, true]])
  assert.equal(view.usage.history.find(row => row.id === 'older').referenceEligibility, 'no-reference-round')

  assert.equal(view.current.score, 24)
  assert.deepEqual(view.tools, [{ name: 'fetch', tokens: 7, calls: 1 }])
  assert.equal((await registerSessionPressure({}, root).view()).current.seq, 3)
  assert.equal(await readFile(join(root, 'home.json'), 'utf8'), home)
  const disk = await readFile(join(root, 'logs', 'session-pressure', 'samples.json'), 'utf8')
  assert(!disk.includes('private tool text'))
  observer.dispose()
  assert.equal(listener, null)
})
