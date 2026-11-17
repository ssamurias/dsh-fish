import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildSessionLoad, freezeSessionLoadReference } from '../lib/session-pressure-load.js'
import { pressureDataDictionary } from '../lib/session-pressure-data.js'
import { analyzePressureEvents } from '../lib/session-pressure-analysis.js'
import { pressureScore, registerSessionPressure, summarizePressure } from '../lib/session-pressure.js'
import { pressureDefaults, scoreDiagnostic, sameRoundDiagnostic } from '../lib/session-pressure-formulas.js'

test('composite history replays the exact completed round and saves versioned diagnostics', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fish-pressure-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'home.json'), JSON.stringify({
    sessionId: 'active', wsId: 'fish', pressureRoomIds: ['active', 'longer', 'short', 'no-meter'],
  }))
  const turns = inputs => inputs.flatMap((inputTokens, index) => {
    const seq = index * 4
    const turn = index + 1
    return [
      { seq, type: 'request/context', data: { provider: 'demo', model: 'small', contextWindow: 1000 } },
      { seq: seq + 1, type: 'user/message', surfaceOp: 'append', data: { content: [{ type: 'text', text: 'input' }] } },
      { seq: seq + 2, type: 'assistant/message', data: { turn, usage: { inputTokens, outputTokens: 25 } } },
      { seq: seq + 3, type: 'turn/end', time: 100 + index * 3, data: { turn, reason: { kind: 'completed' } } },
    ]
  })
  const events = { active: turns([100, 150]), longer: turns([200, 400, 900]), short: turns([900]), 'no-meter': turns([200, 400]) }
  const meterRows = tokens => tokens.map((value, index) => ({
    seq: 3 + index * 4, turn: index + 1, time: 100 + index * 3, tokens: value, contextWindow: 1000, route: 'demo-small',
  }))
  const dir = join(root, 'logs', 'session-pressure')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'samples.json'), JSON.stringify({
    observedSince: 0, records: { active: meterRows([100, 150]), longer: meterRows([200, 400, 900]) },
  }))
  const services = {
    sessionQuery: {
      listSessions: async () => Object.keys(events).map(id => ({ header: { id, cwd: join(root, 'home') } })),
      observeSession: async id => ({ header: {}, cursor: events[id].length, events: events[id] }),
    },
  }
  const observer = registerSessionPressure({ get: name => services[name] }, root)
  t.after(observer.dispose)
  await observer.view(true)
  await observer.waitForIdle()
  const { current, history, rounds, saveFailed } = (await observer.view(true)).usage.comparison
  assert.equal(rounds, 2)
  assert.equal(saveFailed, false)
  assert.deepEqual(current.completeness, [true, true, true])
  assert.equal(current.sampledAt, 103)
  const byId = Object.fromEntries(history.map(row => [row.id, row.snapshot]))
  assert.equal(byId.longer.rounds, 2)
  assert.equal(byId.longer.sampledAt, 103)
  assert.equal(byId.longer.inputs.capacity.occupancy, 40)
  assert.equal(byId.longer.inputs.request.all.rounds, 2)
  assert.equal(byId.short, null)
  assert.ok(Number.isFinite(byId['no-meter'].subScores[0]))
  assert.equal(byId['no-meter'].inputs.capacity.windows[0].requestPairs, 1)
  assert.deepEqual(JSON.parse(await readFile(join(root, 'session-pressure-cache', 'pressure-v0.3', 'active', '2.json'), 'utf8')), current)
})

test('round trends retain independent boundaries, missing points, switches and cached inputs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fish-trends-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const lengths = { current: 63, longer: 107, equal: 59, shorter: 5, mixedWindow: 50, long: 500 }
  const ids = Object.keys(lengths)
  await writeFile(join(root, 'home.json'), JSON.stringify({ sessionId: 'current', pressureRoomIds: ids }))
  const events = {}
  const records = {}
  for (const [id, length] of Object.entries(lengths)) {
    const log = events[id] = []
    const samples = records[id] = []
    const push = (type, data, surfaceOp) => log.push({ seq: log.length, type, data, surfaceOp, time: 1000 + log.length })
    for (let turn = 1; turn <= length; turn++) {
      const model = id === 'longer' && turn >= 20 ? 'large' : 'small'
      const contextWindow = id === 'current' && turn === 22 ? null : id === 'mixedWindow' && turn >= 25 ? 500 : 1000
      push('request/context', { provider: 'demo', model, contextWindow })
      if (turn === 10) {
        push('compaction/start', { compactionId: 'x' })
        push('compaction/end', { compactionId: 'x' })
        push('compaction/prune', {})
      }
      push('user/message', { content: [{ type: 'text', text: 'input' }] }, 'append')
      push('assistant/message', { turn, message: { content: [{ type: 'text', text: 'reply' }] },
        usage: { inputTokens: 100 + turn, outputTokens: 25 } }, { op: 'append' })
      push('turn/end', { turn, reason: { kind: 'completed' } })
      if (id === 'current') samples.push({ seq: log.at(-1).seq, turn, tokens: 100 + turn, contextWindow, route: 'demo-small' })
    }
  }
  const dir = join(root, 'logs', 'session-pressure')
  await mkdir(dir, { recursive: true })
  const end = events.current.find(event => event.type === 'compaction/end')
  await writeFile(join(dir, 'samples.json'), JSON.stringify({
    records, compactionPairs: { current: { [end.seq]: { before: 160, after: 120 } } },
  }))
  const opens = new Map()
  const query = {
    listSessions: async () => ids.map(id => ({ header: { id, cwd: join(root, 'home') } })),
    observeSession: async id => {
      opens.set(id, (opens.get(id) ?? 0) + 1)
      return { header: {}, cursor: events[id].length, events: events[id] }
    },
  }
  const observer = registerSessionPressure({ get: name => name === 'sessionQuery' ? query : undefined }, root)
  t.after(observer.dispose)
  const [current, longer, equal, shorter, mixedWindow, long] = await Promise.all(ids.map(id => observer.trend(id)))
  const sequence = [current, longer, equal, shorter, mixedWindow, long]
  assert.deepEqual(sequence.map(series => series.points.length), [63, 107, 59, 5, 50, 500])
  assert.deepEqual(sequence.map(series => series.points.findLast(point => point.snapshot?.completeness.every(Boolean)).round),
    [63, 107, 59, 5, 50, 500])
  assert.equal(longer.points[19].markers[0].type, '模型切换')
  assert.equal(mixedWindow.points[24].markers[0].type, '窗口切换')
  assert.equal(mixedWindow.points[24].snapshot.inputs.request.all.rounds, 25)
  assert.equal(mixedWindow.points[24].snapshot.inputs.request.window, 500)
  assert.ok(Math.abs(mixedWindow.points[24].snapshot.inputs.capacity.windows[0].value - .026) < .001)
  assert.equal(current.points[21].snapshot.completeness[0], false)
  assert.equal(current.points[22].snapshot.rounds, 23)
  assert.equal(current.points[0].snapshot.inputs.capacity.growth, null)
  assert.deepEqual(current.points[9].markers.map(marker => marker.type), ['压缩开始', '压缩成功', '裁剪'])
  assert.equal(current.points[9].markers[1].tokenChange, -40)
  assert.match(longer.points[60].snapshot.sourceFingerprint, /^[\da-f]{64}$/)
  const cohort = round => [longer, equal, shorter, mixedWindow].filter(series => {
    const candidate = series.points[round - 1]?.snapshot
    return candidate && sameRoundDiagnostic(current.points[round - 1].snapshot, candidate)
  })
  assert.equal(cohort(63).length, 1)
  assert.equal(cohort(40).length, 3)
  await observer.view(true)
  await observer.waitForIdle()
  const sameRound = (await observer.view(true)).usage.comparison.history.find(row => row.id === 'longer').snapshot
  assert.deepEqual(longer.points[62].snapshot.inputs, sameRound.inputs)
  const changed = { ...pressureDefaults, request: { ...pressureDefaults.request, tau: .5 } }
  assert.ok(scoreDiagnostic(longer.points[62].snapshot.inputs, changed)[1] > sameRound.subScores[1])
  assert.deepEqual(await observer.trend('current'), current)
  const count = opens.get('current')
  await observer.trend('current')
  assert.equal(opens.get('current'), count)
  assert.equal(await observer.trend('unselected'), null)
  const detailed = await observer.trend('current', true)
  assert.deepEqual(detailed.points[9].diagnostics.map(metric => metric.id), ['C', 'G', 'U', 'A', 'T', 'K', 'E'])
  assert.equal(current.points[9].diagnostics, null)
  assert.ok(detailed.points[9].diagnostics.flatMap(metric => metric.rows).every(row => !('raw_value' in row)))
})

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
    ev(2, 'assistant/message', { turn: 1, step: 1, message: { content: [] }, usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 30 } }, 'append'),
    ev(3, 'tool/call', { turn: 1, step: 1, name: 'read', callId: 'a' }),
    ev(4, 'tool/result', { turn: 1, step: 1, message: { toolCallId: 'a', isError: true, content: [{ type: 'text', text: 'large result' }] } }, 'append'),
    ev(5, 'assistant/message', { turn: 1, step: 2, message: { content: [] }, usage: { inputTokens: 125, outputTokens: 15 } }, 'append'),
    ev(6, 'turn/end', { turn: 1 }),
    ev(7, 'assistant/attempt', { turn: 2, step: 1 }),
    ev(8, 'assistant/message', { turn: 2, step: 1, message: { content: [] }, usage: { inputTokens: 150, outputTokens: 20 } }, 'append'),
    ev(9, 'turn/end', { turn: 2 }),
    ev(10, 'user/message', { content: [{ type: 'text', text: 'summary' }] }, { op: 'replace', startSeq: 2, endSeq: 4 }),
    ev(11, 'assistant/message', { turn: 3, step: 1, message: { content: [] } }, 'append'),
  ]
  const view = analyzePressureEvents(records.concat(records[9]))
  const first = analyzePressureEvents(records.slice(0, 5), null, true)
  const resumed = analyzePressureEvents(records.slice(5), JSON.parse(JSON.stringify(first.checkpoint)))
  assert.deepEqual(resumed, view)
  assert.equal(view.rows.length, 2)
  assert.equal(view.rows[0].amplification, 280 / 130)
  assert.deepEqual(view.rows[0].cache, { ratio: 30 / 130, reported: 1 })
  assert.equal(view.rows[0].toolErrors, 1)
  assert.equal(view.rows[1].attempts, 1)
  assert.equal(view.rows[1].retries, 1)
  assert.equal(view.rows[1].amplification, null)
  assert.equal(view.burden[0].exposures, 1)
  assert.equal(view.retentionComplete, true)
  const highHit = analyzePressureEvents([
    ev(0, 'assistant/message', { turn: 1, usage: {
      inputTokens: 10, outputTokens: 5, cacheReadTokens: 85, cacheWriteTokens: 5, totalTokens: 105,
    } }),
    ev(1, 'turn/end', { turn: 1 }),
  ]).latest
  assert.equal(highHit.metrics.cacheInput, 100)
  assert.equal(highHit.cache.ratio, .85)
  assert.equal(highHit.load.K, 15)
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
        get: id => id === 'fish' ? { path: join(root, 'home'), sessionIds: ['active', 'older'] } : undefined },
      sessionQuery: { listSessions: async () => [
        { header: { id: 'archived-only', cwd: join(root, 'home') } },
        { header: { id: 'unrelated', cwd: join(root, 'other') } },
      ], readTitleSnapshots: async ids => ids.map(sessionId => ({
        sessionId, status: 'fulfilled', value: { title: { title: sessionId === 'archived-only' ? 'password=synthetic' : 'Title ' + sessionId } },
      })), observeSession: async id => ({ header: { origin: id === 'child' ? 'subagent' : undefined },
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
  await observer.waitForIdle()
  const view = await observer.view()
  assert.equal(view.rows.length, 1)
  assert.equal(view.current.tokens, 120)
  assert.deepEqual(view.usage.history.map(row => [row.id, row.archived, row.selected]),
    [['active', false, true], ['older', true, false], ['archived-only', false, false], ['previous', true, true]])
  assert.equal(view.usage.history.find(row => row.id === 'older').title, 'Title older')
  assert.equal(view.usage.history.find(row => row.id === 'archived-only').title, null)
  assert.equal(await observer.select('unrelated', true), false)
  assert.equal(await observer.select('older', true), true)
  await observer.waitForIdle()
  assert.equal((await observer.view()).usage.history.find(row => row.id === 'older').selected, true)


  assert.equal(view.current.score, 24)
  assert.deepEqual(view.tools, [{ name: 'fetch', tokens: 7, calls: 1 }])
  assert.equal((await registerSessionPressure({}, root).view()).current.seq, 3)
  assert.equal(await readFile(join(root, 'home.json'), 'utf8'), home)
  const disk = await readFile(join(root, 'logs', 'session-pressure', 'samples.json'), 'utf8')
  assert(!disk.includes('private tool text'))
  observer.dispose()
  assert.equal(listener, null)
})

test('pressure deduplicates concurrent discovery and reuses archived checkpoints', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fish-pressure-queue-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const ids = ['live', 'old1', 'old2', 'old3', 'old4', 'old5']
  await writeFile(join(root, 'home.json'), JSON.stringify({
    wsId: 'fish', sessionId: 'live', pressureRoomIds: ids,
  }))
  const reads = []
  const events = [
    { seq: 0, type: 'assistant/message', data: { turn: 1, usage: { inputTokens: 80, outputTokens: 10 } } },
    { seq: 1, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const ctx = { get: name => ({
    workspaceRegistry: { archivedSessionIds: ids.slice(1),
      get: () => ({ path: join(root, 'home'), sessionIds: ids }) },
    sessionQuery: { listSessions: async () => [], observeSession: async id => {
      reads.push(id)
      return { header: {}, cursor: events.length, events }
    } },
  })[name] }
  const observer = registerSessionPressure(ctx, root)
  t.after(observer.dispose)
  const [first, concurrent] = await Promise.all([observer.view(), observer.view()])
  assert.equal(first.usage.partial, true)
  assert.equal(first.load.referenceCount, 0)
  assert.equal(concurrent.usage.selectedCount, 5)
  await observer.waitForIdle()
  const complete = await observer.view()
  assert.equal(complete.usage.partial, false)
  assert.equal(complete.load.referenceCount, 5)
  assert.deepEqual(reads.slice().sort(), ids.slice().sort())
  observer.dispose()

  const restarted = registerSessionPressure(ctx, root)
  t.after(restarted.dispose)
  const resumed = await restarted.view()
  assert.equal(resumed.usage.analyzedCount, 5)
  await restarted.waitForIdle()
  assert.equal(reads.length, ids.length + 1)
  assert.equal(reads.at(-1), 'live')
})

test('T checkpoint upgrade rebuilds v9, reuses v10 and preserves the original log', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fish-t-cache-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const ids = ['current', 'archived']
  const dir = join(root, 'session-pressure-cache')
  const log = join(root, 'original.json')
  await mkdir(dir)
  await writeFile(join(root, 'home.json'), JSON.stringify({ sessionId: ids[0], wsId: 'fish', pressureRoomIds: ids }))
  const records = [
    { type: 'request/context', data: { provider: 'test', model: 'small', contextWindow: 200 } },
    { type: 'user/message', surfaceOp: 'append', data: { content: [{ type: 'text', text: 'user input' }] } },
    { type: 'tool/result', surfaceOp: 'append', data: { turn: 1,
      message: { toolCallId: 'first', content: [{ type: 'text', text: 'tool response' }] } } },
    { type: 'assistant/message', data: { turn: 1, usage: { inputTokens: 20, outputTokens: 5 } } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ].map((event, seq) => ({ ...event, seq, time: seq }))
  const original = JSON.stringify(records)
  await writeFile(log, original)
  const oldPath = join(dir, 'archived.json')
  await writeFile(oldPath, JSON.stringify({ version: 9, cursor: records.length, length: records.length,
    footer: JSON.stringify([4, 4, 'turn/end']), result: { status: 'analyzed', legacyT: true } }))
  const reads = []
  const services = {
    workspaceRegistry: { archivedSessionIds: ['archived'], get: () => ({ path: join(root, 'home'), sessionIds: ids }) },
    sessionQuery: { listSessions: async () => [], observeSession: async id => {
      reads.push(id)
      const events = JSON.parse(await readFile(log, 'utf8'))
      return { cursor: events.length, header: {}, events }
    } },
  }
  const ctx = { get: name => services[name] }
  const observer = registerSessionPressure(ctx, root)
  t.after(observer.dispose)
  await observer.view()
  await observer.waitForIdle()
  const cache = JSON.parse(await readFile(oldPath, 'utf8'))
  assert.equal(cache.version, 10)
  assert.equal(cache.result.legacyT, undefined)
  assert.ok(reads.includes('archived'))
  const comparison = (await observer.view(true)).usage.comparison
  assert.equal(comparison.current.diagnosticsVersion, 'diagnostics-v3')
  assert.equal(comparison.current.sourceFingerprint, comparison.history[0].snapshot.sourceFingerprint)
  assert.deepEqual(comparison.current.inputs, comparison.history[0].snapshot.inputs)
  assert.deepEqual(comparison.current.scores, comparison.history[0].snapshot.scores)
  const point = (await observer.trend('archived')).points[0]
  assert.deepEqual(point.snapshot.inputs, comparison.current.inputs)
  assert.deepEqual(await observer.trend('archived'), await observer.trend('archived'))
  observer.dispose()
  const readCount = reads.filter(id => id === 'archived').length
  const restarted = registerSessionPressure(ctx, root)
  t.after(restarted.dispose)
  assert.equal((await restarted.view()).usage.analyzedCount, 1)
  await restarted.waitForIdle()
  assert.equal(reads.filter(id => id === 'archived').length, readCount)
  assert.equal(await readFile(log, 'utf8'), original)
})

test('diagnostics distinguish missing headers, zero cache coverage, and compaction outcomes', () => {
  const events = [
    { seq: 0, type: 'request/header', data: { header: { tools: [{ name: 'read' }] } } },
    { seq: 1, type: 'assistant/attempt', data: { turn: 1, step: 1, stream: [{ type: 'chunk',
      chunk: { type: 'usage', usage: { inputTokens: 20, outputTokens: 5 } } }] } },
    { seq: 2, type: 'assistant/message', data: { turn: 1, step: 1, usage: { inputTokens: 40, outputTokens: 5 } } },
    { seq: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    { seq: 4, type: 'compaction/start', data: {} },
    { seq: 5, type: 'compaction/end', data: { error: 'failed' } },
    { seq: 6, type: 'compaction/prune', data: {} },
  ]
  const analysis = analyzePressureEvents(events)
  const dictionary = pressureDataDictionary(analysis.rows, [], null, analysis)
  const read = (id, prefix) => dictionary.find(item => item.id === id).rows.find(row => row.label.startsWith(prefix)).value
  assert.equal(analysis.requestEnvelope.systemTokens, 0)
  assert.equal(analyzePressureEvents(events.slice(1)).requestEnvelope, null)
  assert.equal(read('K', '缓存统计覆盖率'), 0)
  assert.equal(read('K', '未命中比例'), null)
  assert.equal(read('E', '匹配到后续成功的失败尝试用量'), 25)
  assert.deepEqual(analysis.compactionEvents, { started: 1, succeeded: 0, failed: 1, summaries: 0, prunes: 1 })
})
