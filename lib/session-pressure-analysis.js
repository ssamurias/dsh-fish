import { looksLikeSecret } from './guard.js'

const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null

function usageOf(usage) {
  const input = count(usage?.inputTokens)
  const output = count(usage?.outputTokens)
  const total = count(usage?.totalTokens) ?? (input != null && output != null ? input + output : null)
  const comparable = input != null && output != null && total === input + output
  return { input, output, total, comparable, cacheRead: count(usage?.cacheReadTokens), cacheWrite: count(usage?.cacheWriteTokens),
    reasoning: count(usage?.reasoningTokens) }
}

function observedSum(requests, key) {
  const values = requests.map(request => request[key]).filter(value => value != null)
  return { value: values.length ? values.reduce((sum, value) => sum + value, 0) : null, reported: values.length }
}

export function analyzePressureEvents(events) {
  const turns = new Map()
  const callNames = new Map()
  const seen = new Set()
  const surface = []
  const activeTools = new Map()
  const burden = new Map()
  let route
  let surfaceKnown = true
  for (const event of events) {
    if (seen.has(event.seq)) continue
    seen.add(event.seq)
    const data = event.data ?? {}
    if (event.type === 'request/context') route = data
    const turnId = count(data.turn)
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
      turn.requests.push(usageOf(data.usage))
      if (turn.attemptsByStep.has(data.step)) {
        turn.retries += turn.attemptsByStep.get(data.step)
        turn.attemptsByStep.delete(data.step)
      }
      turn.surfaceKnown &&= surfaceKnown
      if (surfaceKnown) for (const tool of activeTools.values()) {
        turn.toolLoad += tool.tokens
        if (tool.turn >= turnId || (tool.viewedTurn === turnId && tool.viewedStep === data.step)) continue
        tool.viewedTurn = turnId
        tool.viewedStep = data.step
        const row = burden.get(tool.name) ?? { name: tool.name, exposures: 0, tokensAcrossRequests: 0 }
        row.exposures++
        row.tokensAcrossRequests += tool.tokens
        burden.set(tool.name, row)
      }
    } else if (event.type === 'assistant/attempt' && turn) {
      turn.attempts++
      const chunks = Array.isArray(data.stream) ? data.stream : []
      const usage = chunks.findLast(record => record.type === 'chunk' && record.chunk?.type === 'usage')?.chunk.usage
      turn.attemptUsage.push(usageOf(usage).total)

      if (count(data.step) != null) turn.attemptsByStep.set(data.step, (turn.attemptsByStep.get(data.step) ?? 0) + 1)
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
      const start = surface.indexOf(op.startSeq)
      const end = surface.indexOf(op.endSeq)
      if (start < 0 || end < start) {
        surfaceKnown = false
        continue
      }
      for (const seq of surface.splice(start, end - start + 1, event.seq)) activeTools.delete(seq)
    } else if (op === 'append') {
      surface.push(event.seq)
    } else if (event.type === 'tool/result') {
      surfaceKnown = false
      continue
    }
    if (event.type === 'tool/result' && turn && op) {
      const callId = data.message?.toolCallId
      const name = callNames.get(callId)
      const content = data.message?.content
      if (name && Array.isArray(content)) {
        const tokens = Math.ceil(JSON.stringify(content).length / 4)
        activeTools.set(event.seq, { name, tokens, turn: turnId })
      }
    }
  }

  const rows = [...turns.values()].filter(turn => turn.ended).map(turn => {
    const requests = turn.requests
    const total = observedSum(requests, 'total')
    const cached = requests.filter(row => row.comparable && row.input != null && row.input > 0
      && row.cacheRead != null && row.cacheRead <= row.input)
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
  return { rows, latest: rows.at(-1) ?? null, retentionComplete: surfaceKnown,
    burden: [...burden.values()].sort((a, b) => b.tokensAcrossRequests - a.tokensAcrossRequests) }
}
