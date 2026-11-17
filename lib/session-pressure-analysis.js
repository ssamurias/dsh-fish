import { looksLikeSecret } from './guard.js'

const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null

export function usageOf(usage) {
  const uncached = count(usage?.inputTokens)
  const cacheRead = count(usage?.cacheReadTokens)
  const cacheWrite = count(usage?.cacheWriteTokens)
  const input = uncached == null ? null : uncached + (cacheRead ?? 0) + (cacheWrite ?? 0)
  const output = count(usage?.outputTokens)
  const total = count(usage?.totalTokens) ?? (input != null && output != null ? input + output : null)
  const comparable = input != null && output != null && total === input + output
  return { input, output, total, comparable, cacheRead, cacheWrite, reasoning: count(usage?.reasoningTokens) }
}

function observedSum(requests, key) {
  const values = requests.map(request => request[key]).filter(value => value != null)
  return { value: values.length ? values.reduce((sum, value) => sum + value, 0) : null, reported: values.length }
}

// Use the same block and role pricing as the DSH message meter.
function estimateContent(blocks) {
  let tokens = 0
  for (const block of blocks) {
    if (block.type === 'text' || block.type === 'reasoning') tokens += Math.ceil((block.text?.length ?? 0) / 4) + 4
    else if (block.type === 'tool-call') tokens += Math.ceil((block.name?.length ?? 0) / 4) + Math.ceil((block.arguments?.length ?? 0) / 4) + 4
    else if (block.type === 'tool-result' && Array.isArray(block.content)) tokens += estimateContent(block.content) + 4
    else tokens += Math.ceil(JSON.stringify(block).length / 4) + 4
  }
  return tokens
}

export function analyzePressureEvents(events, checkpoint = null, saveCheckpoint = false) {
  const turns = new Map((checkpoint?.turns ?? []).map(turn => [turn.turn, {
    ...turn, steps: new Set(turn.steps), routes: new Set(turn.routes),
    attemptsByStep: new Map(turn.attemptsByStep),
  }]))
  const callNames = new Map(checkpoint?.callNames)
  const seen = new Set()
  const surface = checkpoint?.surface ?? []
  const activeTools = new Map(checkpoint?.activeTools)
  const surfacePrices = new Map(checkpoint?.surfacePrices)
  let surfaceTokens = checkpoint?.surfaceTokens ?? 0
  let dispatch = checkpoint?.dispatch ?? null
  const burden = new Map(checkpoint?.burden)
  let route = checkpoint?.route
  let envelope = checkpoint?.envelope ?? null
  let toolSnapshot = checkpoint?.toolSnapshot ?? null
  let requestEnvelope = checkpoint?.requestEnvelope ?? null
  const compaction = checkpoint?.compaction ?? { summaries: 0, reported: 0, tokens: 0, shadowed: null }
  const compactionEvents = checkpoint?.compactionEvents ?? { started: 0, succeeded: 0, failed: 0, summaries: 0, prunes: 0 }
  const toolResults = new Map(checkpoint?.toolResults)
  let surfaceKnown = checkpoint?.surfaceKnown ?? true
  function measureRequest(turn, step, seq) {
    if (!surfaceKnown || surfaceTokens <= 0) return { turn, step, seq, status: 'unavailable',
      reason: surfaceKnown ? 'empty-request-surface' : 'incomplete-request-surface' }
    const unique = new Map()
    let duplicateTokens = 0
    for (const [seq, tool] of activeTools) {
      const key = tool.callKey ?? seq
      duplicateTokens += unique.get(key)?.tokens ?? 0
      unique.set(key, { ...tool, seq })
    }
    const tools = [...unique.values()]
    const tokens = tools.reduce((sum, tool) => sum + tool.tokens, 0)
    const inputTokens = surfaceTokens - duplicateTokens + (envelope?.systemTokens ?? 0) + (envelope?.toolTokens ?? 0)
    return { turn, step, seq, status: tokens > inputTokens ? 'invalid' : 'estimated', inputTokens, tokens, tools }
  }
  for (const event of events) {
    if (seen.has(event.seq)) continue
    seen.add(event.seq)
    const data = event.data ?? {}
    if (event.type === 'request/context') {
      const { provider, model, contextWindow } = data
      route = { provider, model, contextWindow }
    }
    if (event.type === 'request/header' && data.header && typeof data.header === 'object') {
      const { system, tools } = data.header
      const systemChars = typeof system === 'string' ? system.length : system === undefined ? 0 : null
      const toolChars = Array.isArray(tools) && tools.length ? JSON.stringify(tools).length
        : tools === undefined || Array.isArray(tools) ? 0 : null
      envelope = { systemChars, toolChars,
        systemTokens: systemChars == null ? null : systemChars === 0 ? 0 : Math.ceil(systemChars / 4) + 4,
        toolTokens: toolChars == null ? null : toolChars ? Math.ceil(toolChars / 4) + 4 : 0 }
    }
    if (event.type === 'assistant/message' && usageOf(data.usage).comparable) requestEnvelope = envelope
    if (event.type === 'compaction/start') compactionEvents.started++
    if (event.type === 'compaction/end') compactionEvents[data.error ? 'failed' : 'succeeded']++
    if (event.type === 'compaction/prune') compactionEvents.prunes++
    if (event.type === 'compaction/summary') {
      compactionEvents.summaries++
      const usage = usageOf(data.usage)
      compaction.summaries++
      if (usage.total != null) { compaction.reported++; compaction.tokens += usage.total }
      compaction.shadowed = count(data.shadowedTokenCount)
    }
    const turnId = count(data.turn)
    if (event.type === 'assistant/chunk' && turnId != null && (dispatch?.turn !== turnId || dispatch?.step !== data.step)) {
      dispatch = measureRequest(turnId, data.step, event.seq)
    }
    let turn
    if (turnId != null && /^(turn\/(?:start|end)|step\/start|assistant\/(?:message|attempt)|tool\/(?:call|result))$/.test(event.type)) {
      turn = turns.get(turnId) ?? { turn: turnId, steps: new Set(), attempts: 0, attemptsByStep: new Map(), attemptUsage: [], retries: 0, requests: [],
        tools: 0, toolErrors: 0, ended: false, failed: false, routes: new Set(), toolLoad: 0, surfaceKnown: true }
      turns.set(turnId, turn)
    }

    if (event.type === 'assistant/message' && turn) {
      const key = route?.provider && route?.model && count(route.contextWindow) > 0
        ? JSON.stringify([route.provider, route.model, route.contextWindow]) : null
      turn.routes.add(key)
      const usage = usageOf(data.usage)
      turn.requests.push(usage)
      turn.requestWindow = count(route?.contextWindow)
      turn.requestSeq = event.seq
      turn.requestTools = null
      const matchedDispatch = dispatch?.turn === turnId && dispatch?.step === data.step
      const requestSurface = matchedDispatch ? dispatch : measureRequest(turnId, data.step, event.seq)
      dispatch = null
      if (requestSurface.status === 'estimated') {
        const { tokens, tools } = requestSurface
        let carried = 0
        let oldestTurn = null
        const ages = new Map()
        for (const tool of tools) {
          const age = turnId - tool.turn
          ages.set(age, (ages.get(age) ?? 0) + tool.tokens)
          if (tool.turn < turnId) carried += tool.tokens
          oldestTurn = oldestTurn == null ? tool.turn : Math.min(oldestTurn, tool.turn)
          const result = toolResults.get(tool.seq)
          if (result && tool.turn < turnId) result.carried++
          if (tool.turn < turnId) {
            const row = burden.get(tool.name) ?? { name: tool.name, exposures: 0, tokensAcrossRequests: 0 }
            row.exposures++
            row.tokensAcrossRequests += tool.tokens
            burden.set(tool.name, row)
          }
        }
        if (Number.isFinite(usage.input) && Number.isFinite(usage.output)) {
          toolSnapshot = { seq: event.seq, dispatchSeq: requestSurface.seq, matchedDispatch, tokens,
            inputTokens: requestSurface.inputTokens, status: 'estimated', ages: [...ages].sort(([a], [b]) => a - b) }
        }
        if (requestSurface.inputTokens > 0) {
          turn.pairedToolInput = (turn.pairedToolInput ?? 0) + requestSurface.inputTokens
          turn.pairedCarry = (turn.pairedCarry ?? 0) + carried
          turn.pairedToolRequests = (turn.pairedToolRequests ?? 0) + 1
        }
        turn.requestTools = { count: tools.length, tokens, oldestTurn }
        turn.toolLoad += tokens
        turn.carriedTokens = (turn.carriedTokens ?? 0) + carried
      } else {
        if (requestSurface.status === 'invalid') turn.invalidToolRequests = (turn.invalidToolRequests ?? 0) + 1
        if (Number.isFinite(usage.input) && Number.isFinite(usage.output)) {
          toolSnapshot = { seq: event.seq, dispatchSeq: requestSurface.seq, matchedDispatch,
            status: requestSurface.status, reason: requestSurface.reason, tokens: requestSurface.tokens,
            inputTokens: requestSurface.inputTokens, ages: [] }
        }
      }
      if (turn.attemptsByStep.has(data.step)) {
        const recovered = turn.attemptsByStep.get(data.step)
        turn.retries += recovered.length
        turn.recoveredAttempts = [...(turn.recoveredAttempts ?? []), ...recovered]
        turn.attemptsByStep.delete(data.step)
      }
      turn.surfaceKnown &&= requestSurface.status === 'estimated'
    } else if (event.type === 'assistant/attempt' && turn) {
      dispatch = null
      turn.attempts++
      const chunks = Array.isArray(data.stream) ? data.stream : []
      const usage = chunks.findLast(record => record.type === 'chunk' && record.chunk?.type === 'usage')?.chunk.usage
      turn.attemptUsage.push(usageOf(usage).total)

      if (count(data.step) != null) turn.attemptsByStep.set(data.step, [...(turn.attemptsByStep.get(data.step) ?? []), usageOf(usage).total])
    } else if (event.type === 'step/start' && turn && count(data.step) != null) {
      turn.steps.add(data.step)
    } else if (event.type === 'turn/end' && turn) {
      turn.ended = true
      turn.surfaceKnown &&= surfaceKnown
      turn.failed = data.reason?.kind === 'error'
      turn.completed = data.reason?.kind === 'completed'
    } else if (event.type === 'tool/call' && turn) {
      turn.tools++
      if (typeof data.callId === 'string' && typeof data.name === 'string' && !looksLikeSecret(data.name).hit) {
        callNames.set(data.callId, data.name)
      }
    } else if (event.type === 'tool/result' && turn && (data.message?.isError || data.error)) {
      turn.toolErrors++
    }

    if (!surfaceKnown) continue
    const op = event.surfaceOp
    if (op?.op === 'replace') {
      const start = surface.indexOf(op.startSeq ?? op.start)
      const end = surface.indexOf(op.endSeq ?? op.end)
      if (start < 0 || end < start) {
        surfaceKnown = false
        continue
      }
      for (const seq of surface.splice(start, end - start + 1, event.seq)) {
        activeTools.delete(seq)
        surfaceTokens -= surfacePrices.get(seq) ?? 0
        surfacePrices.delete(seq)
      }
    } else if (op === 'append' || op?.op === 'append') {
      surface.push(event.seq)
    } else {
      if (op != null) surfaceKnown = false
      continue
    }
    const message = event.type === 'user/message' ? (data.message ?? data)
      : ['assistant/message', 'tool/result'].includes(event.type) ? data.message : null
    if ((event.type === 'tool/result' && !turn) || (['user/message', 'assistant/message', 'tool/result'].includes(event.type)
      && !Array.isArray(message?.content))) {
      surfaceKnown = false
      continue
    }
    const tokens = Array.isArray(message?.content) && (message.content.length || event.type !== 'assistant/message')
      ? estimateContent(message.content) + 4 : 0
    surfacePrices.set(event.seq, tokens)
    surfaceTokens += tokens
    if (event.type === 'tool/result' && turn) {
      const callId = data.message?.toolCallId
      const name = callNames.get(callId) ?? '未知工具'
      const callKey = typeof callId === 'string' ? JSON.stringify([turnId, callId]) : null
      activeTools.set(event.seq, { name, tokens, turn: turnId, callKey })
      toolResults.set(event.seq, { seq: event.seq, name, tokens, turn: turnId, carried: 0 })
      if (toolResults.size > 200) toolResults.delete(toolResults.keys().next().value)
    }
  }

  const rows = [...turns.values()].filter(turn => turn.ended).map(turn => {
    const requests = turn.requests
    const total = observedSum(requests, 'total')
    const cached = requests.filter(row => row.input != null && row.input > 0 && row.cacheRead != null)
    const cacheInput = cached.reduce((sum, row) => sum + row.input, 0)
    const cacheRead = cached.reduce((sum, row) => sum + row.cacheRead, 0)
    const openingInput = requests[0]?.input
    const usageBreakdownMismatch = requests.some(row => row.input != null && row.output != null && !row.comparable)
    const reportedAttempts = turn.attemptUsage.filter(Number.isFinite)
    const attemptTokens = reportedAttempts.reduce((sum, n) => sum + n, 0)
    if (reportedAttempts.length) {
      total.value = (total.value ?? 0) + attemptTokens
      total.reported += reportedAttempts.length
    }
    const completeUsage = total.reported === requests.length + turn.attempts && total.reported > 0
    const subsequent = requests.slice(1)
    const knownSubsequent = subsequent.filter(row => row.comparable)
    const repeatedInput = knownSubsequent.reduce((sum, row) => sum + row.input, 0)
    const uncachedInput = cacheInput - cacheRead
    const allAttemptsAttributed = turn.attempts === turn.retries || turn.failed
    return {
      metrics: {
        firstInput: openingInput ?? null, lastInput: requests.at(-1)?.input ?? null,
        window: turn.requestWindow ?? null, requestSeq: turn.requestSeq, cacheInput, cachedInput: cacheRead, cacheReports: cached.length,
        tools: turn.requestTools ?? null, carry: turn.surfaceKnown && turn.attempts === 0 && requests.length ? turn.carriedTokens : null,
        pairedToolInput: turn.pairedToolInput ?? 0, pairedCarry: turn.pairedCarry ?? 0,
        pairedToolRequests: turn.pairedToolRequests ?? 0, invalidToolRequests: turn.invalidToolRequests ?? 0,
        attemptReports: reportedAttempts.length,
        retryTokens: (turn.recoveredAttempts ?? []).every(Number.isFinite)
          ? (turn.recoveredAttempts ?? []).reduce((sum, number) => sum + number, 0) : null,
      },
      turn: turn.turn, steps: turn.steps.size, requests: requests.length, attempts: turn.attempts, retries: turn.retries,
      tools: turn.tools, toolErrors: turn.toolErrors, failed: turn.failed, completed: turn.completed,
      route: turn.routes.size === 1 ? [...turn.routes][0] : null,
      load: {
        U: completeUsage ? total.value : null,
        A: turn.attempts === 0 && requests.length > 0 && knownSubsequent.length === subsequent.length ? repeatedInput : null,
        T: turn.surfaceKnown && turn.attempts === 0 && requests.length ? turn.toolLoad : null,
        K: turn.attempts === 0 && requests.length > 0 && cached.length === requests.length ? uncachedInput : null,
        E: turn.attempts > 0
          ? (allAttemptsAttributed && reportedAttempts.length === turn.attempts ? attemptTokens : null)
          : (!turn.failed && !turn.toolErrors && turn.completed ? 0 : null),
      },
      observedLoad: {
        U: total.value,
        A: knownSubsequent.length ? repeatedInput : null,
        K: cached.length ? uncachedInput : null,
        E: allAttemptsAttributed && reportedAttempts.length ? attemptTokens : null,
      },
      total, completeUsage, usageBreakdownMismatch, input: observedSum(requests, 'input'), output: observedSum(requests, 'output'),
      cacheWrite: observedSum(requests, 'cacheWrite'), reasoning: observedSum(requests, 'reasoning'),
      cache: cacheInput ? { ratio: cacheRead / cacheInput, reported: cached.length } : null,
      amplification: completeUsage && turn.attempts === 0 && requests.every(row => row.comparable) && openingInput > 0 ? total.value / openingInput : null,
    }
  }).sort((a, b) => a.turn - b.turn)
  return { rows, requestEnvelope, toolSnapshot, compaction, compactionEvents, toolResults: [...toolResults.values()].map(tool => ({
      ...tool, retained: surfaceKnown ? activeTools.has(tool.seq) : null, carried: surfaceKnown ? tool.carried : null,
    })), latest: rows.at(-1) ?? null, retentionComplete: surfaceKnown,
    burden: [...burden.values()].sort((a, b) => b.tokensAcrossRequests - a.tokensAcrossRequests),
    ...(saveCheckpoint ? { checkpoint: {
      turns: [...turns.values()].map(turn => ({ ...turn, steps: [...turn.steps], routes: [...turn.routes],
        attemptsByStep: [...turn.attemptsByStep] })),
      callNames: [...callNames], surface, activeTools: [...activeTools], surfacePrices: [...surfacePrices], surfaceTokens, dispatch,
      burden: [...burden], route, surfaceKnown, envelope, requestEnvelope, toolSnapshot, compaction, compactionEvents, toolResults: [...toolResults],
    } } : {}) }
}
