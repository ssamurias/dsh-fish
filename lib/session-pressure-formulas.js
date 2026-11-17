const pressureVersions = { capacity: 'capacity_v0.1', request: 'request_v0.1', structure: 'structure_v0.1', composite: 'composite_v0.1' }
const compositeDefaults = { A: { wc: .5, wr: .3, wq: .2 }, B: { wc: .5, wr: .3, wq: .2 }, C: { wr: .6, wq: .4, mu: .35 } }

function scoreCapacity(c, g, gamma, horizon, lambda) {
  const bounded = value => Math.min(1, Math.max(0, value))
  const capacity = Number.isFinite(c) ? bounded(c / 100) : null
  const cScore = capacity == null ? null : 100 * capacity ** gamma
  const remainingUse = capacity == null || capacity >= 1 || !Number.isFinite(g)
    ? null : bounded(horizon * Math.max(g, 0) / (100 * (1 - capacity)))
  const score = capacity === 1 ? 100 : remainingUse == null ? null
    : 100 * (1 - (1 - capacity ** gamma) * (1 - lambda * remainingUse))
  const forecast = capacity != null && Number.isFinite(g) ? bounded(capacity + horizon * g / 100) : null
  return { capacity, cScore, remainingUse, score, forecast }
}

function sessionCapacityAdvice(occupancy, growth) {
  if (!Number.isFinite(occupancy) || occupancy < 0) return { level: 'unknown', five: null, ten: null }
  const { gamma, lambda } = pressureDefaults.capacity
  const forecast = horizon => {
    const value = scoreCapacity(occupancy, growth, gamma, horizon, lambda).forecast
    return Number.isFinite(value) ? 100 * value : null
  }
  const five = forecast(5)
  const ten = forecast(10)
  const reaches = (value, threshold) => Number.isFinite(value) && value >= threshold - 1e-10
  const level = reaches(occupancy, 95) ? 'switch'
    : reaches(occupancy, 85) || reaches(five, 95) ? 'prepare'
      : reaches(occupancy, 70) || reaches(ten, 85) ? 'watch' : 'continue'
  return { level, five, ten }
}

function scoreRequestBurden(data, rho, beta, tau, recentWeight) {
  function bounds(sample) {
    if (!(sample?.rounds > 0) || ![sample.knownMiss, sample.cached, sample.unknownInput, sample.output].every(Number.isFinite)) return null
    const known = sample.knownMiss + rho * sample.cached + beta * sample.output
    return [(known + rho * sample.unknownInput) / sample.rounds, (known + sample.unknownInput) / sample.rounds]
  }
  const all = bounds(data?.all)
  const recent = bounds(data?.recent)
  const ratios = data?.window > 0 && all && recent
    ? all.map((value, i) => recentWeight === 0 ? value / data.window : recentWeight === 1 ? recent[i] / data.window
      : ((1 - recentWeight) * value + recentWeight * recent[i]) / data.window) : null
  return { all, recent, ratios, scores: ratios?.map(value => -100 * Math.expm1(-value / tau)) }
}

function scoreStructure(current, repeated, retry, toolWeight, epsilon, eta) {
  const valid = value => Number.isFinite(value) && value >= 0 && value <= 100
  const tool = valid(current) && valid(repeated) ? toolWeight * (current / 100) + (1 - toolWeight) * (repeated / 100) : null
  const failure = Number.isFinite(retry) ? -Math.expm1(-retry / (100 * epsilon)) : null
  const score = tool != null && (failure != null || eta === 0)
    ? 100 * (1 - (1 - tool) * (1 - eta * (failure ?? 0))) : null
  return { tool, failure, score }
}

function capacityInputs(dictionary) {
  const occupancy = dictionary.find(metric => metric.id === 'C')?.rows.find(row => row.label === '窗口占用率')?.value
  const growth = dictionary.find(metric => metric.id === 'G')?.rows ?? []
  const windows = [[5, .5], [10, .3], [20, .2]].map(([rounds, weight]) => {
    const row = growth.find(item => item.label === '平均净增长' && item.scope === '最近 ' + rounds + ' 轮')
    return { rounds, weight, value: row?.value, pairs: row?.raw_value?.comparablePairs ?? 0,
      requestPairs: row?.raw_value?.requestPairs ?? 0, compacted: row?.raw_value?.compacted }
  })
  const available = windows.filter(window => Number.isFinite(window.value) && window.pairs > 0)
  return { occupancy: Number.isFinite(occupancy) ? 100 * occupancy : null, windows,
    growth: available.length ? 100 * available.reduce((sum, window) => sum + window.value * window.weight, 0)
      / available.reduce((sum, window) => sum + window.weight, 0) : null }
}

function scoreComposite(scores, parameters, invalidStructure = false) {
  if (invalidStructure) return {
    A: { score: null, contributions: null }, B: { score: null, factors: [null, null, null], product: null, disabled: false },
    C: { score: null, base: null, mix: null, correction: null },
  }
  const normalized = scores.map(value => Number.isFinite(value) && value >= 0 && value <= 100 ? value / 100 : null)
  const [c, r, q] = normalized
  const { A, B, C } = parameters
  const weightsA = [A.wc, A.wr, A.wq]
  const weightsB = [B.wc, B.wr, B.wq]
  const sumA = A.wc + A.wr + A.wq
  const valid = weights => normalized.every((value, i) => weights[i] === 0 || value != null)
  const contributions = sumA > 0 && valid(weightsA)
    ? weightsA.map((weight, i) => weight === 0 ? 0 : weight / sumA * normalized[i]) : null
  const factors = weightsB.map((weight, i) => weight === 0 ? 1 : normalized[i] == null ? null : (1 - normalized[i]) ** weight)
  const product = factors.every(Number.isFinite) ? factors.reduce((a, b) => a * b, 1) : null
  const sumC = C.wr + C.wq
  const mix = sumC === 0 ? 0 : valid([0, C.wr, C.wq]) ? ((r ?? 0) * C.wr + (q ?? 0) * C.wq) / sumC : null
  const correction = c == null ? null : c === 1 || C.mu === 0 ? 0 : mix == null ? null : C.mu * (1 - c) * mix
  const points = value => Math.min(100, Math.max(0, 100 * value))
  return {
    A: { score: contributions ? points(contributions.reduce((a, b) => a + b, 0)) : null, contributions },
    B: { score: factors.includes(0) ? 100 : product == null ? null : points(1 - product), factors, product,
      disabled: weightsB.every(weight => weight === 0) },
    C: { score: correction == null ? null : points(c + correction), base: c, mix, correction },
  }
}

function pressureStatistics(current, values) {
  const scores = values.filter(Number.isFinite).sort((a, b) => a - b)
  const count = scores.length
  const middle = Math.floor(count / 2)
  const median = count === 0 ? null : count % 2 ? scores[middle] : (scores[middle - 1] + scores[middle]) / 2
  const comparable = median != null && Number.isFinite(current)
  const percentile = comparable ? 100 * scores.reduce((rank, score) => rank + (score < current ? 1 : score === current ? .5 : 0), 0) / count : null
  return { count, median, percentile, difference: comparable ? current - median : null }
}

function scoreDiagnostic(inputs, parameters) {
  const { capacity, request, structure } = parameters
  const [current, repeated, retry] = inputs.structure.map(value => Number.isFinite(value) ? 100 * value : null)
  return [
    scoreCapacity(inputs.capacity.occupancy, inputs.capacity.growth, capacity.gamma, capacity.horizon, capacity.lambda).score,
    scoreRequestBurden(inputs.request, request.rho, request.beta, request.tau, request.recentWeight).scores?.[1] ?? null,
    inputs.invalidStructure ? null : scoreStructure(current, repeated, retry, structure.toolWeight, structure.epsilon, structure.eta).score,
  ]
}

const pressureDefaults = {
  capacity: { gamma: 2, horizon: 10, lambda: .35 },
  request: { rho: 1, beta: 1, tau: 1, recentWeight: .6 },
  structure: { toolWeight: .7, epsilon: .05, eta: .3 },
  composite: compositeDefaults,
}

function sameRoundDiagnostic(current, historical, strict = false) {
  return current?.rounds > 0 && current.id !== historical.id && current.rounds === historical.rounds
    && (!strict || (current.route != null && current.route === historical.route))
    && current.diagnosticsVersion === historical.diagnosticsVersion
    && JSON.stringify(current.versions) === JSON.stringify(historical.versions)
}

function trendSegments(points) {
  const segments = []
  let previous = null
  for (const point of points) {
    if (!Number.isFinite(point.score)) {
      previous = null
      continue
    }
    if (previous !== point.round - 1) segments.push([])
    segments.at(-1).push(point)
    previous = point.round
  }
  return segments
}

const backtestMethods = ['linear5', 'linear10', 'weighted']
const backtestHorizons = [5, 10, 20]

function forecastChildren(prefix, origin, horizon, method) {
  const windows = method === 'linear5' ? [[5, 1]] : method === 'linear10' ? [[10, 1]]
    : [[5, .5], [10, .3], [20, .2]]
  const last = prefix.get(origin)
  if (!last?.children?.every(Number.isFinite)) return null
  const slopes = [0, 0, 0]
  for (const [width, weight] of windows) {
    const middle = (width - 1) / 2
    const denominator = width * (width ** 2 - 1) / 12
    for (let i = 0; i < width; i++) {
      const point = prefix.get(origin - width + 1 + i)
      if (!point?.children?.every(Number.isFinite)) return null
      for (let dimension = 0; dimension < 3; dimension++) {
        slopes[dimension] += weight * (i - middle) * point.children[dimension] / denominator
      }
    }
  }
  return last.children.map((score, dimension) => Math.max(0, Math.min(100, score + horizon * slopes[dimension])))
}

function forecastPressure(prefix, origin, horizon, method, parameters) {
  const children = forecastChildren(prefix, origin, horizon, method)
  return children ? scoreComposite(children, parameters) : null
}

function pressureContributions(start, end, plan, parameters) {
  if (!start?.every(Number.isFinite) || !end?.every(Number.isFinite)) return null
  const score = values => scoreComposite(values, parameters)[plan]?.score
  if (!Number.isFinite(score(start)) || !Number.isFinite(score(end))) return null
  if (plan === 'A') {
    const { wc, wr, wq } = parameters.A
    const weights = [wc, wr, wq]
    const total = wc + wr + wq
    return weights.map((weight, i) => (end[i] - start[i]) * weight / total)
  }
  const contributions = [0, 0, 0]
  for (const order of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
    const values = [...start]
    let before = score(values)
    for (const index of order) {
      values[index] = end[index]
      const after = score(values)
      contributions[index] += (after - before) / 6
      before = after
    }
  }
  return contributions
}

function pressureBacktestRecords(sessions, parameters) {
  const records = []
  for (const [sessionId, points] of sessions) {
    const observed = new Map(points.map(point => [point.round, point]))
    const prefix = new Map()
    const lastRound = points.at(-1)?.round ?? 0
    const compactions = points.filter(point => point.markers?.some(marker =>
      ['压缩成功', '裁剪'].includes(marker.type))).map(point => point.round)
    let index = 0
    for (let origin = 20; origin + 5 <= lastRound; origin += 5) {
      while (index < points.length && points[index].round <= origin) {
        prefix.set(points[index].round, points[index])
        index++
      }
      for (const horizon of backtestHorizons) {
        const target = origin + horizon
        const actual = observed.get(target)?.scores
        if (!actual) continue
        const before = compactions.some(round => round > origin && round <= target)
        const after = compactions.some(round => round > origin - 5 && round <= origin)
        const groups = ['overall', ...(before ? ['before'] : []), ...(after ? ['after'] : []),
          ...(!before && !after ? ['neither'] : [])]
        for (const method of backtestMethods) {
          const predictedChildren = forecastChildren(prefix, origin, horizon, method)
          if (!predictedChildren) continue
          const predicted = scoreComposite(predictedChildren, parameters)
          for (const plan of ['A', 'B', 'C']) {
            const estimate = predicted[plan]?.score
            const observedScore = actual[plan]?.score
            if (Number.isFinite(estimate) && Number.isFinite(observedScore)) {
              records.push({ sessionId, origin, target, horizon, method, plan, estimate, actual: observedScore, predictedChildren, groups })
            }
          }
        }
      }
    }
  }
  return records
}

function commonPressureBacktestRecords(records, methods) {
  const key = row => JSON.stringify([row.sessionId, row.origin, row.horizon, row.plan])
  const availability = new Map()
  for (const row of records) {
    if (!methods.includes(row.method)) continue
    const id = key(row)
    if (!availability.has(id)) availability.set(id, new Set())
    availability.get(id).add(row.method)
  }
  return records.filter(row => methods.includes(row.method) && availability.get(key(row))?.size === methods.length)
}

function summarizePressureBacktest(records) {
  const groups = ['overall', 'before', 'after', 'neither']
  const rows = backtestMethods.flatMap(method => backtestHorizons.flatMap(horizon => ['A', 'B', 'C'].map(plan => ({
    method, horizon, plan, groups: Object.fromEntries(groups.map(group => [group,
      { count: 0, absolute: 0, signed: 0, sessions: new Set() }])),
  }))))
  const byKey = new Map(rows.map(row => [[row.method, row.horizon, row.plan].join(':'), row]))
  for (const record of records) {
    const row = byKey.get([record.method, record.horizon, record.plan].join(':'))
    const error = record.estimate - record.actual
    for (const stratum of record.groups) {
      const group = row.groups[stratum]
      group.count++
      group.absolute += Math.abs(error)
      group.signed += error
      group.sessions.add(record.sessionId)
    }
  }
  return rows.map(row => ({ ...row, groups: Object.fromEntries(Object.entries(row.groups).map(([key, group]) => [
    key, { count: group.count, sessions: group.sessions.size, mae: group.count ? group.absolute / group.count : null,
      bias: group.count ? group.signed / group.count : null },
  ])) }))
}

function runPressureBacktest(sessions, parameters) {
  return summarizePressureBacktest(pressureBacktestRecords(sessions, parameters))
}

export { pressureVersions, pressureDefaults, compositeDefaults, scoreCapacity, sessionCapacityAdvice, scoreRequestBurden,
  scoreStructure, capacityInputs, scoreComposite, pressureStatistics, scoreDiagnostic, sameRoundDiagnostic, trendSegments,
  forecastPressure, runPressureBacktest, pressureBacktestRecords, commonPressureBacktestRecords, summarizePressureBacktest, pressureContributions }
