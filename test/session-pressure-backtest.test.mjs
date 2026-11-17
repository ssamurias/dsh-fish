import test from 'node:test'
import assert from 'node:assert/strict'
import { commonPressureBacktestRecords, compositeDefaults, forecastPressure, pressureBacktestRecords,
  pressureContributions, runPressureBacktest, scoreComposite, summarizePressureBacktest } from '../lib/session-pressure-formulas.js'

function point(round, score, type) {
  const children = [score, score, score]
  return { round, children, scores: scoreComposite(children, compositeDefaults), markers: type ? [{ type }] : [] }
}

test('all three methods recover a linear series without consulting future values', () => {
  const points = Array.from({ length: 45 }, (_, i) => point(i + 1, i + 1))
  const rows = runPressureBacktest([['session', points]], compositeDefaults)
  assert.equal(rows.length, 27)
  for (const { horizon, groups } of rows) {
    assert.equal(groups.overall.count, 6 - horizon / 5)
    assert.equal(groups.overall.sessions, 1)
    assert.ok(groups.overall.mae < 1e-10)
    assert.ok(Math.abs(groups.overall.bias) < 1e-10)
  }
  const prefix = new Map(points.slice(0, 20).map(value => [value.round, value]))
  const extended = new Map([...prefix, [25, point(25, 95)]])
  for (const method of ['linear5', 'linear10', 'weighted']) {
    assert.deepEqual(forecastPressure(extended, 20, 5, method, compositeDefaults),
      forecastPressure(prefix, 20, 5, method, compositeDefaults))
  }
})

test('rolling evaluation preserves missing data and separates compression errors', () => {
  const points = Array.from({ length: 30 }, (_, i) =>
    point(i + 1, i < 24 ? 20 : 40, i === 24 ? '压缩成功' : undefined))
  const metric = rows => rows.find(row => row.method === 'linear5' && row.horizon === 5 && row.plan === 'A').groups
  const groups = metric(runPressureBacktest([['session', points]], compositeDefaults))
  assert.equal(groups.before.count, 1)
  assert.equal(groups.after.count, 1)
  assert.ok(Math.abs(groups.before.bias + 20) < 1e-10)
  assert.ok(groups.after.bias > 0)
  assert.ok(groups.overall.mae >= Math.abs(groups.overall.bias))
  const missing = points.filter(value => value.round !== 19 && value.round !== 30)
  assert.equal(metric(runPressureBacktest([['session', missing]], compositeDefaults)).overall.mae, null)
})

test('common samples match exact session, origin, horizon, formula and event subset', () => {
  const points = Array.from({ length: 45 }, (_, i) => point(i + 1, i + 1, i === 24 ? '裁剪' : undefined))
    .filter(row => row.round !== 8 && row.round !== 35)
  const records = pressureBacktestRecords([['session', points]], compositeDefaults)
  const subset = records.filter(row => row.plan === 'B' && row.horizon === 5 && row.groups.includes('before'))
  assert.deepEqual(subset.map(row => row.method), ['linear5', 'linear10'])
  assert.deepEqual(commonPressureBacktestRecords(subset, ['linear5', 'linear10', 'weighted']), [])
  assert.deepEqual(commonPressureBacktestRecords(subset, ['linear5', 'linear10']), subset)
  const common = commonPressureBacktestRecords(records, ['linear5', 'linear10', 'weighted'])
  assert.ok(common.length > 0 && common.length < records.length)
  assert.ok(common.every(row => row.target !== 35))
  const stats = summarizePressureBacktest(common).filter(row => row.plan === 'B' && row.horizon === 5)
  assert.equal(new Set(stats.map(row => row.groups.overall.count)).size, 1)
})

test('contributions reconcile interval change and forecast error for all three formulas', () => {
  const start = [14, 70, 20]
  const end = [31, 43, 100]
  for (const plan of ['A', 'B', 'C']) {
    const sum = parts => parts.reduce((total, value) => total + value, 0)
    const change = scoreComposite(end, compositeDefaults)[plan].score - scoreComposite(start, compositeDefaults)[plan].score
    const result = pressureContributions(start, end, plan, compositeDefaults)
    assert.ok(Math.abs(sum(result) - change) < 1e-12)
    assert.ok(Math.abs(sum(pressureContributions(end, start, plan, compositeDefaults)) + change) < 1e-12)
    assert.equal(pressureContributions([null, 4, 2], end, plan, compositeDefaults), null)
    const points = Array.from({ length: 40 }, (_, i) => point(i + 1, i > 22 ? 10 : 25))
    const row = pressureBacktestRecords([['session', points]], compositeDefaults)
      .find(item => item.plan === plan && item.origin === 20 && item.target === 25)
    assert.ok(Math.abs(sum(pressureContributions(points[24].children, row.predictedChildren, plan, compositeDefaults))
      - (row.estimate - row.actual)) < 1e-12)
  }
  assert.deepEqual(pressureContributions(start, end, 'A', compositeDefaults), [8.5, -8.1, 16])
  assert.equal(pressureContributions(start, end, 'A', { ...compositeDefaults, A: { wc: 0, wr: 0, wq: 0 } }), null)
})
