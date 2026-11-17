const finite = Number.isFinite
const total = values => values.length && values.every(finite) ? values.reduce((a, b) => a + b, 0) : null
const ratio = (a, b) => finite(a) && finite(b) && b > 0 ? a / b : null

export function pressureDataDictionary(rounds, samples, request, details = {}, compactionPair, historical = false) {
  const last = rounds.at(-1)
  const m = last?.metrics
  const row = (label, source, raw_value, value, unit, scope, formula, confidence = '精确统计') => ({
    label, source, raw_value, value, unit, scope, formula,
    availability: value == null ? '暂不可获取' : formula === '原值' ? '直接获取' : '可推导',
    confidence: value == null ? '未知' : confidence,
  })
  const missing = (label, source, unit, scope, formula) => row(label, source, null, null, unit, scope, formula)
  const meta = rounds.map(r => r.metrics)
  const requests = total(rounds.map(r => r.requests))
  const attempts = total(rounds.map(r => r.attempts))
  const input = total(rounds.map(r => r.input.reported === r.requests ? r.input.value : null))
  const output = total(rounds.map(r => r.output.reported === r.requests ? r.output.value : null))
  const inOut = total([input, output])
  const completedTotal = rounds.every(r => r.completeUsage) ? total(rounds.map(r => r.total.value)) : null
  const lastInput = request?.input ?? null
  const window = request?.contextWindow ?? null
  const usageScope = '已完成轮 · 成功请求'
  const requestSamples = historical ? new Map(rounds.filter(row => row.completed && finite(row.metrics?.lastInput)
    && row.metrics.window > 0).map(row => [row.turn, { tokens: row.metrics.lastInput, contextWindow: row.metrics.window }])) : null
  const growth = n => {
    const end = last?.turn
    const byTurn = new Map(samples.map(sample => [sample.turn, sample]))
    const changes = []
    let requestPairs = 0
    if (Number.isSafeInteger(end)) for (let turn = Math.max(2, end - n + 1); turn <= end; turn++) {
      let a = byTurn.get(turn - 1), b = byTurn.get(turn)
      if (historical && (!(a?.contextWindow > 0) || !(b?.contextWindow > 0))) {
        a = requestSamples.get(turn - 1)
        b = requestSamples.get(turn)
        if (a && b) requestPairs++
      }
      if (!a || !b || !(a.contextWindow > 0) || !(b.contextWindow > 0)) continue
      if (!historical && (a.route !== b.route || a.contextWindow !== b.contextWindow)) continue
      changes.push(a.contextWindow === b.contextWindow ? (b.tokens - a.tokens) / b.contextWindow
        : b.tokens / b.contextWindow - a.tokens / a.contextWindow)
    }
    return { changes: changes.length, requestPairs,
      compacted: Number.isSafeInteger(end) && samples.some(sample =>
        sample.compacted && sample.turn > end - n && sample.turn <= end),
      net: changes.length ? changes.reduce((a, b) => a + b, 0) / changes.length : null,
      positive: changes.length ? changes.reduce((a, b) => a + Math.max(0, b), 0) : null }
  }
  const lastSample = samples.findLast(sample => sample.turn === last?.turn)
  const previousSample = samples.findLast(sample => sample.turn === last?.turn - 1)
  const lastDelta = lastSample && previousSample && lastSample.route === previousSample.route
    && lastSample.contextWindow === previousSample.contextWindow && lastSample.contextWindow > 0
    ? (lastSample.tokens - previousSample.tokens) / lastSample.contextWindow : null
  const growthWindows = [5, 10, 20].map(n => [n, growth(n)])
  const cache = (items, scope) => {
    const metadata = items.map(item => item.metrics)
    const eligible = total(items.map(item => item.requests))
    const reported = items.length ? metadata.reduce((sum, item) => sum + (item?.cacheReports ?? 0), 0) : null
    const covered = metadata.filter(item => item?.cacheReports > 0)
    const i = total(covered.map(item => item.cacheInput))
    const hit = total(covered.map(item => item.cachedInput))
    const missed = finite(i) && finite(hit) ? i - hit : null
    return [row('缓存统计覆盖率', '完成轮成功请求与有效缓存报告', { reported, eligible },
      ratio(reported, eligible), '%', scope, '有有效缓存报告的请求数 ÷ 成功请求数'),
      row('未命中比例', 'DSH 请求 usage.cacheReadTokens', { input: i, hit, reports: total(covered.map(item => item.cacheReports)) },
      ratio(missed, i), '%', scope, '1 − 缓存命中 Token ÷ 有缓存报告的输入 Token')]
  }
  const retained = Number.isSafeInteger(request?.seq) && request.seq === details.toolSnapshot?.seq ? details.toolSnapshot : null
  const retainedTokens = retained?.tokens ?? null
  const retainedShare = requestToolShare(retained)
  const failed = total(rounds.map(r => r.attempts))
  const toolErrors = total(rounds.map(r => r.toolErrors))
  const toolCalls = total(rounds.map(r => r.tools))
  const retry = rounds.length && rounds.every(r => r.attempts === 0 || finite(r.load.E))
    ? total(rounds.map(r => r.attempts === 0 ? 0 : r.load.E)) : null
  const matchedRetry = total(meta.map(item => item?.retryTokens))
  return [
    { id: 'C', title: '上下文容量', rows: [
      row('请求输入', 'DSH 最新有用量的模型请求', lastInput, lastInput, 'Token', '最新有用量的请求', '原值'),
      row('有效窗口', 'DSH request/context.contextWindow', window, window, 'Token', '同一次请求', '原值'),
      row('窗口占用率', '同一请求的输入用量与模型窗口', { input: lastInput, window }, ratio(lastInput, window), '%', '最新有用量的请求', '请求输入 Token ÷ 窗口 Token', '估算'),
      row('剩余容量', '同一请求的输入用量与模型窗口', { input: lastInput, window }, finite(lastInput) && window > 0 ? window - lastInput : null, 'Token', '同一次请求', '窗口 − 输入 Token', '估算'),
      ...[['系统消息占用', 'systemChars', 'systemTokens'], ['工具定义占用', 'toolChars', 'toolTokens']].map(([label, chars, tokens]) =>
        row(label, 'DSH request/header（宿主 token-meter 估算法）', { chars: details.requestEnvelope?.[chars], headerRecorded: details.requestEnvelope != null },
          details.requestEnvelope?.[tokens], 'Token', '最新有用量的请求', '已记录请求头中该字段为空或缺省时为 0；未采到请求头为未知；非空按字符数 ÷ 4 向上取整 + 4', '估算')),
      ...[['压缩前占用', 'before'], ['压缩后占用', 'after']].map(([label, key]) =>
        row(label, 'DSH tokenMeter · 同一压缩 ID 的开始 / 结束事件', compactionPair?.[key],
          compactionPair?.[key], 'Token', '最近一次有效配对', '原值', '估算')),
      row('压缩占用减少量', 'DSH tokenMeter 压缩边界采样', compactionPair,
        compactionPair ? compactionPair.before - compactionPair.after : null, 'Token',
        '最近一次有效配对', '压缩前占用 − 压缩后占用', '估算'),
    ] },
    { id: 'G', title: '增长负担', rows: [
      row('逐轮净变化', '相邻轮末 tokenMeter 采样', { previous: previousSample?.tokens, current: lastSample?.tokens,
        window: lastSample?.contextWindow, compacted: lastSample?.compacted }, lastDelta, '百分点',
        '最新完成轮', '本轮结束占用率 − 上一轮结束占用率'),
      row('当前轮请求数', 'assistant/message 与 assistant/attempt', { requests: last?.requests, attempts: last?.attempts },
        total([last?.requests, last?.attempts]), '次', '最新完成轮', '成功请求数 + 失败尝试数'),
      ...growthWindows.flatMap(([n, g]) => [
        row('平均净增长', historical && g.requestPairs
          ? (g.requestPairs === g.changes ? '相邻轮请求实报输入与当轮窗口' : '轮末 tokenMeter 与相邻轮请求实报占用率')
          : 'Fish turn/end 的 tokenMeter 采样', { comparablePairs: g.changes, compacted: g.compacted,
          ...(historical ? { requestPairs: g.requestPairs } : {}) }, g.net, '百分点', '最近 ' + n + ' 轮', '相邻可比轮占用率差之和 ÷ 可比差值数 × 100'),
        row('正向增长', 'Fish turn/end 的 tokenMeter 采样', { comparablePairs: g.changes }, g.positive, '百分点', '最近 ' + n + ' 轮', 'Σ max(0, 本轮占用率 − 上轮占用率) × 100'),
      ]),
      row('短期减中期平均增长', '相同轮末采样', growthWindows.map(([, g]) => g.net),
        growthWindows[0][1].changes >= 5 && growthWindows[1][1].changes >= 10
          ? growthWindows[0][1].net - growthWindows[1][1].net : null, '百分点', '最近 5 / 10 轮', '5 轮平均净增长 − 10 轮平均净增长'),
      ...[['压缩开始', 'started'], ['压缩成功结束', 'succeeded'], ['压缩错误结束', 'failed'],
        ['压缩摘要', 'summaries'], ['工具结果裁剪', 'prunes']].map(([label, key]) =>
        row(label, 'DSH compaction/start, end, summary, prune', details.compactionEvents?.[key],
          details.compactionEvents?.[key], '次', '已扫描会话事件', '计数：对应事件')),
      row('记录到的压缩轮', 'Fish 轮末采样 compaction/end', samples.length ? samples.filter(s => s.compacted).length : null,
        samples.length ? samples.filter(s => s.compacted).length : null, '轮', '已采样轮', '有压缩标记的轮数'),
    ] },
    { id: 'U', title: 'Token 总消耗', rows: [
      row('累计请求输入（含缓存）', 'DSH 模型请求 usage.inputTokens', input, input, 'Token', usageScope, 'Σ 输入 Token'),
      row('累计请求输出', 'DSH 模型请求 usage.outputTokens', output, output, 'Token', usageScope, 'Σ 输出 Token'),
      row('成功请求总用量', 'DSH 模型请求 usage', { input, output }, inOut, 'Token', usageScope, '累计输入 + 累计输出'),
      row('常规模型请求总用量（含失败尝试）', 'assistant/message 与 assistant/attempt 的 usage', completedTotal,
        completedTotal, 'Token', '已完成轮 · 不含独立压缩调用', 'Σ 每轮成功请求及失败尝试 Token；要求用量齐全'),
      row('平均每轮消耗', 'DSH 模型请求 usage', { total: inOut, turns: rounds.length }, ratio(inOut, rounds.length), 'Token / 轮', usageScope, '累计输入与输出 ÷ 轮数'),
      row('累计请求数（含尝试）', 'assistant/message 与 assistant/attempt', { requests, attempts }, total([requests, attempts]), '次', '已完成轮', '成功请求数 + 失败尝试数'),
      row('压缩请求消耗', 'DSH compaction/summary.usage',
        { reported: details.compaction?.reported, summaries: details.compaction?.summaries },
        details.compaction?.reported ? details.compaction.tokens : null, 'Token', '会话 · 已报告的压缩调用', 'Σ 已报告的压缩输入与输出 Token'),
      row('最近一次压缩替换的原文规模', 'DSH compaction/summary.shadowedTokenCount', details.compaction?.shadowed,
        details.compaction?.shadowed, 'Token', '最近一次压缩摘要', '原值', '估算'),
    ] },
    { id: 'A', title: '请求放大', rows: [
      row('模型请求数（含尝试）', 'assistant/message 与 assistant/attempt', { requests: last?.requests, attempts: last?.attempts }, total([last?.requests, last?.attempts]), '次', '最新完成轮', '成功请求数 + 失败尝试数'),
      row('首个成功请求输入', 'DSH 模型请求 usage.inputTokens', m?.firstInput, m?.firstInput, 'Token', '最新完成轮', '原值'),
      row('追加请求输入', 'DSH 模型请求 usage.inputTokens', last?.load.A, last?.load.A, 'Token', '最新完成轮', 'Σ 第 2 次起的请求输入 Token'),
      row('输入放大率', '本轮首个请求及后续请求输入', { first: m?.firstInput, extra: last?.load.A }, ratio(last?.load.A, m?.firstInput), '%', '最新完成轮', '追加请求输入 ÷ 首次输入'),
      missing('工具后继续推理次数', '未建立请求与工具结果的可靠因果关联', '次', '最新完成轮', '按明确关联的请求计数'),
    ] },
    { id: 'T', title: '工具结果残留', rows: [
      row('工具结果残留', 'DSH 请求边界的可见上下文', retained?.dispatchSeq, retainedTokens, 'Token', '最新有用量的请求', '同一套估算器统计去重后的可见工具结果', '估算'),
      row('残留占比', '同一请求上下文、同一估算口径', { retainedTokens, estimatedInput: retained?.inputTokens,
        status: retained?.status ?? 'unavailable', reason: retained?.reason ?? null },
        retainedShare, '%', '同一次请求', '估算工具结果 Token ÷ 估算请求输入 Token', '估算'),
      row('累计携带', '请求时的工具 surface', rounds.filter(r => finite(r.load.T)).length,
        total(rounds.map(r => r.load.T)), 'Token·次', '已完成轮', 'Σ 每次成功请求中全部可见工具结果 Token，含本轮生成的结果；缺覆盖的轮次保留未知', '估算'),
      row('跨轮重复携带', '请求时的工具 surface 与结果产生轮', meta.map(item => item?.carry ?? null).filter(finite).length,
        total(meta.map(item => item?.carry)), 'Token·次', '已完成轮', 'Σ 每次成功请求中仅早于请求轮生成的可见工具结果 Token；属于累计携带的子集', '估算'),
      row('当前最早残留年龄', '工具结果产生轮、请求轮', null, retained?.ages?.at(-1)?.[0] ?? null, '轮', '同一次请求', '当前轮 − 最早残留结果所在轮', '估算'),
      ...(details.toolResults ?? []).slice(-30).reverse().flatMap(tool => [
        row(tool.name + ' · 结果大小', 'DSH tool/result 与 surfaceOp', { seq: tool.seq, retained: tool.retained },
          tool.tokens, 'Token', '第 ' + tool.turn + ' 轮', 'DSH 消息及内容块估算', '估算'),
        row(tool.name + ' · 后续轮携带', 'DSH 请求与工具结果的 surface 历史', { seq: tool.seq, retained: tool.retained },
          tool.carried, '次', '第 ' + tool.turn + ' 轮的结果', '计数：该结果在后续轮成功请求中出现'),
      ]),
    ] },
    { id: 'K', title: '缓存复用负担', rows: [
      row('未缓存输入', 'DSH 请求 usage', meta.filter(item => item?.cacheReports > 0).length,
        total(meta.filter(item => item?.cacheReports > 0).map(item => item.cacheInput - item.cachedInput)),
        'Token', '已完成轮 · 有缓存报告的请求', 'Σ（输入 − 缓存命中）'),
      ...cache(rounds, '已完成轮'), ...cache(rounds.slice(-5), '最近 5 个完成轮'), ...cache(rounds.slice(-10), '最近 10 个完成轮'),
      ...[['有缓存记录的输入', 'cacheInput'], ['缓存命中输入', 'cachedInput']].map(([label, key]) => {
        const value = total(meta.filter(item => item?.cacheReports > 0).map(item => item[key]))
        return row(label, 'DSH 模型请求 usage', value, value, 'Token', '已完成轮 · 有缓存报告的请求', 'Σ 对应输入')
      }),
    ] },
    { id: 'E', title: '失败与恢复', rows: [
      row('模型失败尝试', 'DSH assistant/attempt', failed, failed, '次', '已完成轮', 'Σ 失败尝试事件'),
      row('模型失败率', 'DSH assistant/attempt 与 assistant/message', { failed, requests }, ratio(failed, total([failed, requests])), '%', '已完成轮', '失败尝试数 ÷ 总请求数'),
      row('显式工具失败', 'DSH tool/result 错误标记', toolErrors, toolErrors, '次', '已完成轮', 'Σ 标记失败的工具结果'),
      row('工具失败率', 'DSH tool/call 与 tool/result', { toolErrors, toolCalls }, ratio(toolErrors, toolCalls), '%', '已完成轮', '工具失败数 ÷ 工具调用数'),
      row('已归因尝试耗用', 'assistant/attempt 的用量和重试关联', retry, retry, 'Token', '已完成轮', 'Σ 明确归因的失败尝试 Token'),
      row('重试负担占比', '失败尝试与请求用量', { retry: matchedRetry, total: completedTotal }, ratio(matchedRetry, completedTotal), '%', '已完成轮', '有同轮同步骤后续成功的失败尝试 Token ÷ 常规模型请求总用量'),
      row('有同轮同步骤后续成功的失败尝试', '同轮同 step 的 assistant/attempt → assistant/message',
        total(rounds.map(r => r.retries)), total(rounds.map(r => r.retries)), '次', '已完成轮', '计数：失败尝试之后有同一步成功请求'),
      row('匹配到后续成功的失败尝试用量', 'assistant/attempt.usage + 同轮同 step 关联',
        null, total(meta.map(item => item?.retryTokens)), 'Token', '已完成轮', 'Σ 匹配到后续成功的失败尝试自身 Token'),
      missing('恢复请求、错误分类与语义失败', '缺少可靠的恢复归因和标准分类', 'Token / 次', '会话', '按明确错误类型及恢复关联统计'),
    ] },
  ]
}

export function requestBurdenInputs(rounds, window) {
  const completed = rounds.filter(round => round.completed === true)
  function summarize(items) {
    const input = total(items.map(round => round.requests === 0 ? 0
      : round.input.reported === round.requests ? round.input.value : null))
    const output = total(items.map(round => round.requests === 0 ? 0
      : round.output.reported === round.requests ? round.output.value : null))
    const coveredInput = items.reduce((sum, round) => sum + (round.metrics?.cacheInput ?? 0), 0)
    const cached = items.reduce((sum, round) => sum + (round.metrics?.cachedInput ?? 0), 0)
    return { rounds: items.length, input, output, cached, knownMiss: coveredInput - cached,
      unknownInput: input != null && input >= coveredInput ? input - coveredInput : null,
      requests: items.reduce((sum, round) => sum + round.requests, 0),
      cacheReports: items.reduce((sum, round) => sum + (round.metrics?.cacheReports ?? 0), 0) }
  }
  return { window, all: summarize(completed), recent: summarize(completed.slice(-10)) }
}

function requestToolShare(snapshot) {
  if (snapshot?.status !== 'estimated' || snapshot.tokens > snapshot.inputTokens) return null
  return ratio(snapshot.tokens, snapshot.inputTokens)
}

export function structurePressureInputs(details) {
  const rounds = details.rows ?? []
  const request = details.lastRequest
  const snapshot = details.toolSnapshot?.seq === request?.seq ? details.toolSnapshot : null
  const pairedInput = rounds.reduce((sum, row) => sum + (row.metrics?.pairedToolInput ?? 0), 0)
  const pairedCarry = rounds.reduce((sum, row) => sum + (row.metrics?.pairedCarry ?? 0), 0)
  const pairedRequests = rounds.reduce((sum, row) => sum + (row.metrics?.pairedToolRequests ?? 0), 0)
  const requestCount = rounds.reduce((sum, row) => sum + row.requests, 0)
  const invalidRequests = rounds.reduce((sum, row) => sum + (row.metrics?.invalidToolRequests ?? 0), 0)
  const invalid = snapshot?.status === 'invalid' || (finite(snapshot?.tokens) && finite(snapshot?.inputTokens)
    && snapshot.tokens > snapshot.inputTokens) || pairedCarry > pairedInput || invalidRequests > 0
  const currentShare = requestToolShare(snapshot)
  const retryTokens = total(rounds.map(row => row.metrics?.retryTokens))
  const regularTokens = rounds.every(row => row.completeUsage) ? total(rounds.map(row => row.total.value)) : null
  let cumulative = 0
  const median = snapshot?.tokens > 0 ? snapshot.ages.find(([, tokens]) => {
    cumulative += tokens
    return cumulative >= snapshot.tokens / 2
  })?.[0] ?? null : null
  return {
    currentShare: invalid ? null : currentShare,
    repeatedShare: invalid ? null : ratio(pairedCarry, pairedInput),
    retryShare: ratio(retryTokens, regularTokens),
    retainedTokens: snapshot?.tokens ?? null, currentInput: snapshot?.inputTokens ?? null, reportedInput: request?.input ?? null,
    measurementStatus: invalid ? 'invalid' : snapshot?.status ?? 'unavailable', dispatchSeq: snapshot?.dispatchSeq ?? null,
    measurementReason: snapshot?.reason ?? null,
    matchedDispatch: snapshot?.matchedDispatch ?? false, invalidRequests,
    pairedInput, pairedCarry, pairedRequests, requestCount, retryTokens, regularTokens,
    modelFailureRate: ratio(total(rounds.map(row => row.attempts)), total(rounds.map(row => row.attempts + row.requests))),
    toolFailureRate: ratio(total(rounds.map(row => row.toolErrors)), total(rounds.map(row => row.tools))),
    ages: {
      mean: snapshot?.tokens > 0 ? snapshot.ages.reduce((sum, [age, tokens]) => sum + age * tokens, 0) / snapshot.tokens : null,
      median,
      older: [10, 20, 40].map(rounds => ({ rounds, share: snapshot?.tokens > 0
        ? snapshot.ages.reduce((sum, [age, tokens]) => sum + (age > rounds ? tokens : 0), 0) / snapshot.tokens : null })),
    },
  }
}
