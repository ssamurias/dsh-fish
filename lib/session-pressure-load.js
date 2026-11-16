export const LOAD_VERSION = 6
export const LOAD_FACTORS = [
  { id: 'C', label: '上下文容量', weight: 15, unit: '', threshold: true },
  { id: 'G', label: '增长负担', weight: 15, unit: '', threshold: true },
  { id: 'U', label: 'Token 总消耗', weight: 15, unit: 'Token' },
  { id: 'A', label: '请求放大', weight: 15, unit: 'Token' },
  { id: 'T', label: '工具结果残留', weight: 15, unit: 'Token·请求' },
  { id: 'K', label: '缓存复用负担', weight: 10, unit: 'Token' },
  { id: 'E', label: '失败与恢复', weight: 15, unit: 'Token' },
]

export const DEFAULT_REFERENCE_ROUNDS = 40

export function normalizeReferenceRounds(value) {
  if (value === 'end') return value
  const rounds = Number(value)
  return Number.isInteger(rounds) && rounds >= 1 && rounds <= 500 ? rounds : DEFAULT_REFERENCE_ROUNDS
}
const MIN_SESSIONS = 3
const MIN_PROVISIONAL_SESSIONS = 1

function quantile(values, p) {
  if (!values.length) return null
  const sorted = values.slice().sort((a, b) => a - b)
  const i = (sorted.length - 1) * p
  const lower = Math.floor(i)
  return sorted[lower] + (sorted[Math.ceil(i)] - sorted[lower]) * (i - lower)
}

function cumulative(analysis) {
  const running = Object.fromEntries(LOAD_FACTORS.map(({ id }) => [id, null]))
  return (analysis?.rows ?? []).map(row => {
    for (const { id } of LOAD_FACTORS) {
      const observed = row.load?.[id] ?? row.observedLoad?.[id]
      if (Number.isFinite(observed)) running[id] = (running[id] ?? 0) + observed
    }
    return { turn: row.turn, values: { ...running } }
  })
}

export function sessionReferenceEligibility(analysis, referenceRounds = DEFAULT_REFERENCE_ROUNDS) {
  if (analysis?.status !== 'analyzed') return analysis?.status ?? 'unavailable'
  const points = cumulative(analysis)
  const target = referenceRounds === 'end' ? points.at(-1) : points.find(row => row.turn === referenceRounds)
  return target ? 'eligible' : 'no-reference-round'
}

export function buildSessionLoad(current, history, fixed = null, referenceRounds = DEFAULT_REFERENCE_ROUNDS) {
  const points = cumulative(current)
  const latest = points.at(-1)
  const comparable = Boolean(latest)
  const sessions = history.map(cumulative).filter(rows => rows.length)
  const references = sessions.map(rows => referenceRounds === 'end' ? rows.at(-1)
    : rows.find(row => row.turn === referenceRounds)).filter(Boolean)
  const saved = fixed?.version === LOAD_VERSION && fixed.referenceRounds === referenceRounds ? fixed : null
  const freshFactors = LOAD_FACTORS.map(factor => {
    const values = references.map(row => row.values[factor.id]).filter(Number.isFinite)
    const baseline = values.length ? quantile(values, .5) : null
    const currentValue = comparable ? latest.values[factor.id] : null
    return { ...factor, current: currentValue, samples: values.length, baseline, provisional: values.length < MIN_SESSIONS,
      available: Number.isFinite(currentValue) && baseline > 0 }
  })
  const currentRows = current?.rows ?? []
  for (const factor of freshFactors) {
    const exact = currentRows.map(row => row.load?.[factor.id]).filter(Number.isFinite)
    const partial = currentRows.filter(row => !Number.isFinite(row.load?.[factor.id]))
      .map(row => row.observedLoad?.[factor.id]).filter(Number.isFinite)
    const observed = [...exact, ...partial]
    factor.coverage = { complete: exact.length, partial: partial.length, rounds: currentRows.length,
      observed: observed.length ? observed.reduce((sum, value) => sum + value, 0) : null }
  }
  const factors = saved ? freshFactors.map(factor => {
    const baseline = saved.factors[factor.id]?.baseline ?? null
    const samples = saved.factors[factor.id]?.samples ?? 0
    return { ...factor, baseline, samples, provisional: samples < MIN_SESSIONS, available: Number.isFinite(factor.current) && baseline > 0 }
  }) : freshFactors
  const distributions = saved?.distributions ?? [...new Set([20, 30, 40, 45, 50, referenceRounds].filter(Number.isInteger))].sort((a, b) => a - b).map(turn => ({
    turn,
    samples: sessions.map(rows => rows.find(row => row.turn === turn))
      .filter(Boolean).map(row => row.values),
    below: sessions.filter(rows => rows.at(-1).turn < turn).length,
  }))
  const trend = saved?.trend ?? (() => {
    const byTurn = new Map()
    for (const rows of sessions) {
      for (const row of rows) {
        if (row.turn > 500) continue
        const values = byTurn.get(row.turn) ?? []
        values.push(row.values)
        byTurn.set(row.turn, values)
      }
    }
    return [...byTurn].sort(([a], [b]) => a - b).map(([turn, samples]) => ({ turn, samples }))
  })()
  const rows = current?.rows ?? []
  const observedUsage = rows.map(row => row.total.value).filter(Number.isFinite)
  return { version: LOAD_VERSION, comparisons: saved?.comparisons ?? references.map(row => row.values), referenceCreatedAt: saved?.createdAt ?? null, referenceRounds, minSessions: MIN_SESSIONS, provisionalMin: MIN_PROVISIONAL_SESSIONS,
    candidateCount: saved?.candidateCount ?? sessions.length, referenceCount: saved?.referenceCount ?? references.length, comparable, factors,
    points: comparable ? points.map(({ turn, values }) => ({ turn, values })) : [], distributions, trend,
    usage: { total: observedUsage.length ? observedUsage.reduce((sum, n) => sum + n, 0) : null,
      complete: rows.filter(row => row.completeUsage).length, turns: rows.length },
  }
}

export function freezeSessionLoadReference(view, createdAt) {
  if (!view.factors.some(factor => factor.baseline > 0 && !factor.provisional)) return null
  return { version: LOAD_VERSION, comparisons: view.comparisons, referenceRounds: view.referenceRounds, createdAt, referenceCount: view.referenceCount,
    candidateCount: view.candidateCount, distributions: view.distributions, trend: view.trend,
    factors: Object.fromEntries(view.factors.map(({ id, samples, baseline }) => [id, { samples, baseline }])) }
}
