import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { diagnosticRoundBoundary } from '../lib/session-pressure.js'
import { compositeDefaults, pressureDefaults, pressureVersions, scoreDiagnostic,
  pressureStatistics, sameRoundDiagnostic, scoreComposite, trendSegments } from '../lib/session-pressure-formulas.js'

const cases = [[10, 10, 10], [95, 20, 20], [25, 75, 80], [20, 95, 30],
  [50, 50, 50], [0, 0, 0], [100, 100, 100]]

test('composite formulas are bounded, deterministic and monotonic', () => {
  for (const input of cases) {
    const first = scoreComposite(input, compositeDefaults)
    assert.deepEqual(scoreComposite(input, compositeDefaults), first)
    for (const id of ['A', 'B', 'C']) {
      const score = first[id].score
      assert.ok(Number.isFinite(score) && score >= 0 && score <= 100)
      for (const index of [0, 1, 2]) {
        const raised = input.map((value, i) => i === index ? Math.min(value + 5, 100) : value)
        assert.ok(scoreComposite(raised, compositeDefaults)[id].score >= score)
      }
    }
  }
  const sample = scoreComposite([22.8, 51.1, 60.1], compositeDefaults)
  assert.ok(Math.abs(sample.A.score - 38.75) < 1e-12)
  assert.deepEqual([sample.B, sample.C].map(result => result.score.toFixed(1)), ['41.0', '37.6'])
  assert.equal((sample.C.correction * 100).toFixed(1), '14.8')
})

test('zero parameters, full capacity, independent plans and missing values', () => {
  const input = [20, 95, 100]
  const base = scoreComposite(input, compositeDefaults)
  const changed = scoreComposite(input, { ...compositeDefaults, A: { wc: 0, wr: 0, wq: 0 } })
  assert.equal(changed.A.score, null)
  assert.deepEqual(changed.B, base.B)
  assert.deepEqual(changed.C, base.C)
  assert.equal(base.B.score, 100)
  const disabled = scoreComposite([null, null, null], { ...compositeDefaults, B: { wc: 0, wr: 0, wq: 0 } })
  assert.deepEqual(disabled.B, { score: 0, factors: [1, 1, 1], product: 1, disabled: true })
  assert.equal(disabled.C.score, null)
  assert.equal(scoreComposite([100, null, null], compositeDefaults).C.score, 100)
  assert.equal(scoreComposite(input, { ...compositeDefaults, C: { wr: 0, wq: 0, mu: 1 } }).C.score, 20)
  assert.deepEqual(Object.values(scoreDiagnostic({
    capacity: { occupancy: 20, growth: null }, request: null, structure: [null, null, null],
  }, pressureDefaults)), [null, null, null])
})

test('saturated formulas can resolve missing dimensions without treating them as zero', () => {
  const saturated = scoreComposite([100, null, null], compositeDefaults)
  assert.equal(saturated.A.score, null)
  assert.equal(saturated.B.score, 100)
  assert.equal(saturated.C.score, 100)
  const below = scoreComposite([99, null, null], compositeDefaults)
  assert.deepEqual(Object.values(below).map(result => result.score), [null, null, null])
  const invalid = scoreComposite([100, null, null], compositeDefaults, true)
  assert.deepEqual(Object.values(invalid).map(result => result.score), [null, null, null])
})

test('same-round comparisons accept mixed configurations unless strict filtering is enabled', () => {
  const end = (seq, turn, kind = 'completed') => ({ seq, type: 'turn/end', data: { turn, reason: { kind } } })
  const events = [end(2, 0), end(4, 1, 'error'), end(5, 0), end(10, 2), end(12, 3)]
  assert.equal(diagnosticRoundBoundary(events, 2).event.seq, 10)
  assert.equal(diagnosticRoundBoundary(events, 4), null)
  const current = { id: 'now', rounds: 2, route: 'same', versions: pressureVersions }
  const other = { ...current, id: 'previous' }
  assert.equal(sameRoundDiagnostic(current, other), true)
  assert.equal(sameRoundDiagnostic(current, { ...other, rounds: 1 }), false)
  assert.equal(sameRoundDiagnostic(current, { ...other, route: 'other' }), true)
  assert.equal(sameRoundDiagnostic(current, { ...other, route: 'other' }, true), false)
  assert.equal(sameRoundDiagnostic(current, { ...other, versions: {} }), false)
  assert.deepEqual(pressureStatistics(20, [null, 5, 20, 25, 30]), { count: 4, median: 22.5, percentile: 37.5, difference: -2.5 })
  assert.deepEqual(pressureStatistics(20, []), { count: 0, median: null, percentile: null, difference: null })
})

test('browser bundle uses the same formulas as saved snapshots', async () => {
  const read = async name => (await readFile(new URL('../lib/' + name, import.meta.url), 'utf8')).replace(/\r\n/g, '\n')
  const client = await read('client.js')
  const embedded = client.split('// BEGIN shared pressure formulas\n')[1].split('    // END shared pressure formulas')[0]
    .replace(/^    /gm, '').trim()
  assert.equal(embedded, (await read('session-pressure-formulas.js')).split('\nexport {')[0].trim())
})

test('trend segments preserve zero, missing values, skipped rounds and last real point', () => {
  const points = [{ round: 1, score: 0 }, { round: 2, score: null }, { round: 3, score: 20 },
    { round: 5, score: 40 }, { round: 6, score: 60 }]
  assert.deepEqual(trendSegments(points).map(line => line.map(point => point.round)), [[1], [3], [5, 6]])
})
