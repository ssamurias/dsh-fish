import assert from 'node:assert/strict'
import test from 'node:test'
import { analyzePressureEvents } from '../lib/session-pressure-analysis.js'
import { structurePressureInputs } from '../lib/session-pressure-data.js'
import { pressureDefaults, scoreComposite, scoreDiagnostic, scoreStructure } from '../lib/session-pressure-formulas.js'
import { lastRecordedRequest } from '../lib/session-pressure.js'

const text = value => [{ type: 'text', text: value }]

test('provider input distinguishes a missing or partial request surface from a real tool-free zero', () => {
  const reply = { type: 'assistant/message', seq: 2, data: { turn: 1, usage: { inputTokens: 100, outputTokens: 10 } } }
  const end = { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } }
  const user = { type: 'user/message', seq: 0, surfaceOp: 'append', data: { content: text('question') } }
  const missing = { type: 'user/message', seq: 1, surfaceOp: 'append', data: {} }
  const inspect = prefix => {
    const events = [...prefix, reply, end]
    return structurePressureInputs({ ...analyzePressureEvents(events), lastRequest: lastRecordedRequest(events) })
  }
  for (const [prefix, reason] of [[[], 'empty-request-surface'], [[user, missing], 'incomplete-request-surface']]) {
    const result = inspect(prefix)
    assert.equal(result.reportedInput, 100)
    assert.equal(result.measurementStatus, 'unavailable')
    assert.equal(result.measurementReason, reason)
    assert.equal(result.currentShare, null)
    assert.equal(result.repeatedShare, null)
    const children = scoreDiagnostic({ capacity: { occupancy: 30, growth: 1 }, request: null,
      structure: [result.currentShare, result.repeatedShare, 0] }, pressureDefaults)
    assert.equal(children[2], null)
  }
  const known = inspect([user])
  assert.equal(known.measurementStatus, 'estimated')
  assert.equal(known.currentShare, 0)
  assert.equal(known.repeatedShare, 0)
})

test('request boundaries pair tool results with the same estimates across duplicate, prune and compaction events', () => {
  const events = []
  const append = (type, data, surfaceOp) => {
    const seq = events.length
    events.push({ seq, type, data, surfaceOp })
    return seq
  }
  const user = append('user/message', { content: text('question') }, 'append')
  append('request/header', { header: { system: 'policy', tools: [] } })
  const result = (id, payload, op) => append('tool/result', { turn: 1, message: { toolCallId: id, content: text(payload) } }, op)
  const first = result('id-one', 'x'.repeat(400), 'append')
  const duplicate = result('id-one', 'x'.repeat(400), 'append')
  result('excluded', 'w'.repeat(4000))
  const send = (turn, step) => append('assistant/chunk', { turn, step })
  const reply = (turn, step) => append('assistant/message', { turn, step, message: { content: text('') },
    usage: { inputTokens: 50, outputTokens: 10 } })
  const before = send(2, 1)
  append('compaction/prune', {}, { op: 'replace', start: first, end: duplicate })
  reply(2, 1)
  append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  const inspect = prefix => structurePressureInputs({ ...analyzePressureEvents(prefix), lastRequest: lastRecordedRequest(prefix) })
  const original = inspect(events)
  assert.equal(original.dispatchSeq, before)
  assert.equal(original.matchedDispatch, true)
  assert.equal(original.retainedTokens, 108)
  assert.equal(original.currentInput, 124)
  assert.equal(original.reportedInput, 50)
  assert.equal(original.currentShare, 108 / 124)
  assert.equal(original.repeatedShare, 108 / 124)

  send(3, 1)
  reply(3, 1)
  append('turn/end', { turn: 3, reason: { kind: 'completed' } })
  assert.equal(inspect(events).currentShare, 0)

  const newest = result('id-two', 'payload', { op: 'append' })
  append('user/message', { content: text('summary') }, { op: 'replace', startSeq: user, endSeq: newest })
  reply(4, 1)
  append('turn/end', { turn: 4, reason: { kind: 'completed' } })
  const compacted = inspect(events)
  assert.equal(compacted.retainedTokens, 0)
  assert.ok(compacted.currentInput > 0)
  assert.equal(compacted.currentShare, 0)
  assert.ok(compacted.repeatedShare > 0 && compacted.repeatedShare <= 1)
  assert.equal(analyzePressureEvents(events).rows[0].total.value, 60)
})

test('unresolvable replacements and mismatched requests remain unavailable', () => {
  const events = [
    { seq: 0, type: 'user/message', surfaceOp: { op: 'replace', start: 90, end: 91 }, data: { content: text('summary') } },
    { seq: 1, type: 'assistant/message', data: { turn: 1, usage: { inputTokens: 100, outputTokens: 10 } } },
  ]
  const request = lastRecordedRequest(events)
  const data = analyzePressureEvents(events)
  assert.equal(structurePressureInputs({ ...data, lastRequest: request }).measurementStatus, 'unavailable')
  assert.equal(structurePressureInputs({ ...data, lastRequest: { ...request, seq: 99 } }).currentShare, null)
})

test('over-100% measurements invalidate all dependent scores without suppressing E', () => {
  const anomaly = structurePressureInputs({
    lastRequest: { seq: 1, input: 100 },
    toolSnapshot: { seq: 1, status: 'estimated', tokens: 110, inputTokens: 100, ages: [[2, 110]] },
  })
  assert.equal(anomaly.measurementStatus, 'invalid')
  assert.equal(anomaly.retainedTokens, 110)
  assert.equal(anomaly.currentShare, null)
  assert.equal(anomaly.repeatedShare, null)
  const structure = scoreStructure(101.75, 59.04, .1, .7, .05, .3)
  assert.equal(structure.score, null)
  assert.ok(Number.isFinite(structure.failure))
  const inputs = { capacity: { occupancy: 100 }, request: null, structure: [1, .5, 0], invalidStructure: true }
  const children = scoreDiagnostic(inputs, pressureDefaults)
  assert.deepEqual(children, [100, null, null])
  assert.ok(Object.values(scoreComposite(children, pressureDefaults.composite, inputs.invalidStructure)).every(row => row.score === null))
})
