import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { looksLikeSecret } from './guard.js'
import { mutateJson, writeAtomic } from './store.js'

export function pressureScore(tokens, threshold) {
  if (!Number.isFinite(tokens) || tokens < 0 || !Number.isFinite(threshold) || threshold <= 0) return null
  return Math.min(100, 100 * tokens / threshold)
}

export function basicPressureThreshold(policy, route, contextWindow, reservedTokens) {
  if (!Array.isArray(policy?.modelPolicies) || !route?.provider || !route?.model
    || !Number.isSafeInteger(contextWindow) || contextWindow <= 0
    || !Number.isSafeInteger(reservedTokens) || reservedTokens < 0) return null
  const override = policy.modelPolicies.find(p => p.provider === route.provider && p.model === route.model)
  const ratio = override?.thresholdRatio ?? policy.thresholdRatio
  const headroom = override?.headroomTokens ?? policy.headroomTokens
  if (!(ratio > 0 && ratio <= 1) || !Number.isSafeInteger(headroom) || headroom < 0) return null
  const budget = contextWindow - reservedTokens
  const threshold = Math.floor(Math.min(contextWindow * ratio, budget - headroom))
  const retained = override?.retainTokens ?? (override?.retainRatio == null ? policy.retainTokens : undefined)
    ?? Math.floor(budget * (override?.retainRatio ?? policy.retainRatio))
  return Number.isFinite(retained) && threshold > 0 && retained < threshold ? threshold : null
}

export function summarizePressure(records, home, observedSince, rotations = {}) {
  const sessions = Object.entries(records).map(([id, turns]) => {
    const rows = Object.values(turns).sort((a, b) => a.seq - b.seq)
    const rotatedAt = id === home.rotatedFrom ? home.rotatedAt : rotations[id]
    const scores = rows.map(row => row.score).filter(Number.isFinite)
    return { id, rows, rotatedAt: rotatedAt ?? null, peak: scores.length ? Math.max(...scores) : null,
      endScore: null }
  })
  const current = sessions.find(session => session.id === home.sessionId)
  const rows = (current?.rows ?? []).map((row, i) => {
    const previous = current.rows[i - 1]
    const comparable = previous && row.turn === previous.turn + 1 && row.route === previous.route
      && row.contextWindow === previous.contextWindow && row.threshold === previous.threshold
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

export function registerSessionPressure(ctx, root) {
  const dir = join(root, 'logs', 'session-pressure')
  const file = join(dir, 'samples.json')
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

  async function record(session, event) {
    const id = String(session?.header?.id ?? '')
    const { seq, time } = event
    const turn = event.data?.turn
    if (!id || !Number.isSafeInteger(seq) || !Number.isSafeInteger(turn)) return
    const home = await readHome()
    if (id !== home.sessionId) return
    const route = session.requestContext?.()
    if (!route?.provider || !route?.model) return
    const header = session.requestHeader?.()
    const measurement = ctx.get?.('tokenMeter')?.measure(session)
    if (measurement?.logRevision !== seq + 1 || !Number.isFinite(measurement.totalTokens)) return
    const engine = ctx.get?.('compaction')
    const threshold = engine?.constructor?.name === 'BasicCompactionEngine'
      && route.provider === header?.config?.provider && route.model === header?.config?.model
      ? basicPressureThreshold(engine.config, route, route.contextWindow, header.config.maxTokens)
      : null
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
      route: JSON.stringify([route.provider, route.model]), compacted, tools, threshold, score: pressureScore(tokens, threshold) }
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
    async view() {
      const state = await read()
      return summarizePressure(state.records, await readHome(), state.observedSince, state.rotations)
    },
  }
}
