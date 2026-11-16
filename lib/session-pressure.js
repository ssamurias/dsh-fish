import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { buildSessionLoad, freezeSessionLoadReference, normalizeReferenceRounds, sessionReferenceEligibility } from './session-pressure-load.js'
import { analyzePressureEvents } from './session-pressure-analysis.js'
import { looksLikeSecret } from './guard.js'
import { mutateJson, writeAtomic } from './store.js'

export function pressureScore(tokens, threshold) {
  if (!Number.isFinite(tokens) || tokens < 0 || !Number.isFinite(threshold) || threshold <= 0) return null
  return Math.min(100, 100 * tokens / threshold)
}

export function summarizePressure(records, home, observedSince, rotations = {}) {
  const sessions = Object.entries(records).map(([id, turns]) => {
    const rows = Object.values(turns).sort((a, b) => a.seq - b.seq)
      .map(({ threshold, thresholdStatus, ...row }) => ({ ...row, score: pressureScore(row.tokens, row.contextWindow) }))
    const rotatedAt = id === home.rotatedFrom ? home.rotatedAt : rotations[id]
    const scores = rows.map(row => row.score).filter(Number.isFinite)
    return { id, rows, rotatedAt: rotatedAt ?? null, peak: scores.length ? Math.max(...scores) : null,
      endScore: null }
  })
  const current = sessions.find(session => session.id === home.sessionId)
  const rows = (current?.rows ?? []).map((row, i) => {
    const previous = current.rows[i - 1]
    const comparable = previous && row.turn === previous.turn + 1 && row.route === previous.route
      && row.contextWindow === previous.contextWindow
      && !row.compacted
    return { ...row, delta: comparable ? row.tokens - previous.tokens : null }
  })
  const tools = new Map()
  for (const row of rows) for (const item of row.tools ?? []) {
    const total = tools.get(item.name) ?? { name: item.name, tokens: 0, calls: 0 }
    total.tokens += item.tokens
    total.calls++
    tools.set(item.name, total)
  }
  const growth = rows.filter(row => row.delta > 0).sort((a, b) => b.delta - a.delta)
  return { observedSince, current: rows.at(-1) ?? null, rows, growth,
    tools: [...tools.values()].sort((a, b) => b.tokens - a.tokens),
    history: sessions.filter(session => session.id !== home.sessionId)
      .map(({ rows: historyRows, ...summary }) => ({ ...summary, count: historyRows.length })) }
}

function readService(ctx, name) {
  try { return ctx.get?.(name) } catch { return undefined }
}

export function lastRecordedRequest(events) {
  let route
  let latest = null
  for (const event of events) {
    if (event.type === 'request/context') route = event.data
    if (event.type !== 'assistant/message') continue
    const usage = event.data?.usage
    if (!Number.isFinite(usage?.inputTokens) || !Number.isFinite(usage?.outputTokens)) continue
    latest = { turn: event.data?.turn ?? null, input: usage.inputTokens, output: usage.outputTokens,
      total: Number.isFinite(usage.totalTokens) ? usage.totalTokens : usage.inputTokens + usage.outputTokens,
      contextWindow: route?.contextWindow ?? null, time: event.time }
  }
  return latest
}

export function registerSessionPressure(ctx, root) {
  const dir = join(root, 'logs', 'session-pressure')
  const file = join(dir, 'samples.json')
  const referenceFile = join(dir, 'load-reference-v6.json')

  async function sessionLoad(current, history, referenceRounds) {
    const view = buildSessionLoad(current, history, null, referenceRounds)
    if (!view.comparable) return view
    const referenceKey = String(referenceRounds)
    try {
      return await mutateJson(referenceFile, async () => {
        let references
        try {
          references = JSON.parse(await fs.readFile(referenceFile, 'utf8'))
        } catch (error) {
          if (error.code !== 'ENOENT') throw error
          references = {}
        }
        let fixed = references[referenceKey]
        if (!fixed) {
          fixed = freezeSessionLoadReference(view, new Date().toISOString())
          if (!fixed) return view
          await fs.mkdir(dir, { recursive: true })
          await writeAtomic(referenceFile, JSON.stringify({ ...references, [referenceKey]: fixed }))
        }
        return buildSessionLoad(current, history, fixed, referenceRounds)
      })
    } catch {
      return { ...view, factors: view.factors.map(factor => ({ ...factor, available: false })),
        referenceWriteFailed: true }
    }
  }

  const observedSince = Date.now()
  async function read() {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      return { observedSince, records: {} }
    }
  }

  async function readHome() {
    try {
      return JSON.parse(await fs.readFile(join(root, 'home.json'), 'utf8'))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      return {}
    }
  }

  const analyses = new Map()
  async function analyzeSession(id) {
    const query = readService(ctx, 'sessionQuery')
    if (typeof query?.observeSession !== 'function') return { status: 'unavailable' }
    let snapshot
    try {
      snapshot = await query.observeSession(id, { projectionMode: 'none' })
      if (snapshot.header?.origin === 'subagent' || snapshot.header?.delegationDepth > 0) return { status: 'excluded' }
      if (snapshot.cursor > 20_000) return { status: 'too-large' }
      const cached = analyses.get(id)
      if (cached?.cursor === snapshot.cursor) return cached.result
      const events = snapshot.events ?? []
      const result = { status: 'analyzed', ...analyzePressureEvents(events), lastRequest: lastRecordedRequest(events) }
      if (analyses.size >= 64) analyses.delete(analyses.keys().next().value)
      analyses.set(id, { cursor: snapshot.cursor, result })
      return result
    } catch {
      return { status: 'unavailable' }
    } finally {
      snapshot?.[Symbol.dispose]?.()
    }
  }

  async function record(session, event) {
    const id = String(session?.header?.id ?? '')
    const { seq, time } = event
    const turn = event.data?.turn
    if (!id || !Number.isSafeInteger(seq) || !Number.isSafeInteger(turn)) return
    const home = await readHome()
    if (id !== home.sessionId) return
    const route = session.requestContext?.()
    if (!route?.provider || !route?.model) return
    const measurement = readService(ctx, 'tokenMeter')?.measure?.(session)
    if (measurement?.logRevision !== seq + 1 || !Number.isFinite(measurement.totalTokens)) return
    const calls = new Map()
    let compacted = false
    for (let i = seq - 1; i >= 0; i--) {
      const entry = session.eventAt?.(i)
      if (!entry || entry.type === 'turn/start' || entry.type === 'turn/end') break
      if (entry.type === 'compaction/end') compacted = true
      if (entry.type !== 'assistant/message') continue
      for (const block of entry.data?.message?.content ?? []) {
        if (block.type === 'tool-call' && typeof block.name === 'string' && !looksLikeSecret(block.name).hit) calls.set(block.id, block.name)
      }
    }
    const tools = []
    for (const node of measurement.nodes ?? []) {
      const entry = session.eventAt?.(node.seq)
      if (entry?.type !== 'tool/result' || entry.data?.turn !== turn) continue
      const name = calls.get(entry.data?.message?.toolCallId)
      if (name && Number.isFinite(node.tokens)) tools.push({ name, tokens: node.tokens })
    }
    const tokens = measurement.totalTokens
    const row = { seq, time, turn, tokens, contextWindow: route.contextWindow ?? null,
      route: JSON.stringify([route.provider, route.model]), compacted, tools }
    await mutateJson(file, async () => {
      const state = await read()
      const existing = Object.hasOwn(state.records, id) ? state.records[id] : {}
      if (Object.hasOwn(existing, seq)) return
      state.records = { ...state.records, [id]: { ...existing, [seq]: row } }
      if (home.rotatedFrom && home.rotatedAt) {
        state.rotations = { ...state.rotations, [home.rotatedFrom]: home.rotatedAt }
      }
      await fs.mkdir(dir, { recursive: true })
      await writeAtomic(file, JSON.stringify(state))
    })
  }

  const off = ctx.on?.('session/event', (session, event) => {
    if (event?.type === 'turn/end') void record(session, event).catch(() => {})
  })
  return {
    dispose: () => off?.(),
    async view({ rounds } = {}) {
      const referenceRounds = normalizeReferenceRounds(rounds)
      const state = await read()
      const home = await readHome()
      const view = summarizePressure(state.records, home, state.observedSince, state.rotations)
      if (!home.sessionId) return { ...view, availability: 'no-session' }
      const live = readService(ctx, 'sessions')?.get?.(home.sessionId)
      const meter = readService(ctx, 'tokenMeter')
      if (live && typeof meter?.measure === 'function' && live.requestHeader?.()) {
        const contextWindow = live.requestContext?.()?.contextWindow ?? null
        const { totalTokens } = meter.measure(live)
        if (Number.isFinite(totalTokens)) view.live = { tokens: totalTokens,
          score: pressureScore(totalTokens, contextWindow), contextWindow }
      }

      const current = await analyzeSession(home.sessionId)
      const confirmedIds = new Set([home.rotatedFrom, ...Object.keys(state.rotations ?? {})].filter(Boolean))
      const registry = readService(ctx, 'workspaceRegistry')
      const archivedIds = registry?.archivedSessionIds
      const roomIds = home.wsId ? registry?.get?.(home.wsId)?.sessionIds : null
      const archived = new Set(archivedIds ?? [])
      const sourceIds = [...new Set([...confirmedIds, ...(roomIds ?? [])])]
        .filter(id => id !== home.sessionId)
      const history = []
      const baseline = []
      const loadHistory = []
      for (const id of sourceIds) {
        const data = await analyzeSession(id)
        if (data.status === 'excluded') continue
        const workspaceOnly = !confirmedIds.has(id)
        const eligibleHistory = referenceRounds !== 'end' || archived.has(id)
        if (eligibleHistory && data.status === 'analyzed') loadHistory.push(data)
        const rows = data.rows ?? []
        const complete = rows.filter(row => row.completeUsage)
        for (const row of complete) if (row.completed) baseline.push(row.total.value)
        history.push({ id, status: data.status, archived: Array.isArray(archivedIds) ? archivedIds.includes(id) : null,
          workspaceOnly, referenceEligibility: eligibleHistory
            ? sessionReferenceEligibility(data, referenceRounds) : 'active-end-unknown', turns: rows.length, usageTurns: complete.length })
      }
      const sorted = baseline.sort((a, b) => a - b)
      const reference = sorted.length >= 10
        ? { count: sorted.length, p90: sorted[Math.ceil(sorted.length * .9) - 1] }
        : { count: sorted.length, p90: null }
      return { ...view, availability: current.status, lastRequest: current.lastRequest, load: await sessionLoad(current, loadHistory, referenceRounds),
        usage: { latest: current.latest, burden: current.burden?.slice(0, 10),
          retentionComplete: current.retentionComplete, reference, history, discovered: sourceIds.length } }
    },
  }
}
