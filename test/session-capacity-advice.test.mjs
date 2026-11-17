import test from 'node:test'
import assert from 'node:assert/strict'
import { capacityInputs, sessionCapacityAdvice } from '../lib/session-pressure-formulas.js'

test('capacity advice follows descending priority and never switches on a forecast alone', () => {
  for (const [occupancy, growth, level] of [
    [40, .2, 'continue'], [40, 4.5, 'watch'], [40, 11, 'prepare'],
    [70, -.1, 'watch'], [85, -.1, 'prepare'], [85, 5, 'prepare'],
    [95, -2, 'switch'], [100, 0, 'switch'], [115, 0, 'switch'],
    [69, -20, 'continue'], [69, 1.6, 'watch'],
  ]) {
    const result = sessionCapacityAdvice(occupancy, growth)
    assert.equal(result.level, level, String([occupancy, growth]))
    assert.ok([result.five, result.ten].every(value => Number.isFinite(value) && value >= 0 && value <= 100))
  }
})

test('missing growth leaves forecasts unknown and missing window leaves all advice unknown', () => {
  assert.deepEqual(sessionCapacityAdvice(50, null), { level: 'continue', five: null, ten: null })
  assert.deepEqual(sessionCapacityAdvice(90, NaN), { level: 'prepare', five: null, ten: null })
  const { occupancy } = capacityInputs([{ id: 'C', rows: [{ label: '窗口占用率', value: null }] }])
  assert.deepEqual(sessionCapacityAdvice(occupancy, 10), { level: 'unknown', five: null, ten: null })
  assert.deepEqual(sessionCapacityAdvice(Infinity, 1), { level: 'unknown', five: null, ten: null })
})
