import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import { setImmediate as yieldToHost } from 'node:timers/promises'
import { join, resolve } from 'node:path'
import { buildSessionLoad, sessionReferenceEligibility } from './session-pressure-load.js'
import { pressureDataDictionary, requestBurdenInputs, structurePressureInputs } from './session-pressure-data.js'
import { analyzePressureEvents, usageOf } from './session-pressure-analysis.js'
import { looksLikeSecret } from './guard.js'
import { mutateJson, writeAtomic } from './store.js'
import { capacityInputs, pressureDefaults, pressureVersions, scoreComposite, scoreDiagnostic } from './session-pressure-formulas.js'

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

export function lastRecordedRequest(events, route, latest = null) {
  for (const event of events) {
    if (event.type === 'request/context') route = event.data
    if (event.type !== 'assistant/message') continue
    const usage = usageOf(event.data?.usage)
    if (usage.input == null || usage.output == null) continue
    latest = { seq: event.seq, turn: event.data?.turn ?? null, input: usage.input, output: usage.output,
      total: usage.total,
      contextWindow: route?.contextWindow ?? null, provider: route?.provider ?? null, model: route?.model ?? null, time: event.time }
  }
  return latest
}

export function* diagnosticRoundBoundaries(events) {
  const completed = new Set()
  for (const [index, event] of events.entries()) {
    if (event.type !== 'turn/end' || event.data?.reason?.kind !== 'completed' || !Number.isSafeInteger(event.data.turn)) continue
    if (completed.has(event.data.turn)) continue
    completed.add(event.data.turn)
    yield { index, event, round: completed.size }
  }
}

export function diagnosticRoundBoundary(events, rounds) {
  if (!Number.isSafeInteger(rounds) || rounds < 1) return null
  for (const boundary of diagnosticRoundBoundaries(events)) {
    if (boundary.round === rounds) return boundary
  }
  return null
}

export function registerSessionPressure(ctx, root) {
  const dir = join(root, 'logs', 'session-pressure')
  const file = join(dir, 'samples.json')
  const selectionFile = join(root, 'session-pressure-selection.json')

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

  async function readSelection() {
    try { return JSON.parse(await fs.readFile(selectionFile, 'utf8')) }
    catch (error) { if (error.code !== 'ENOENT') throw error; return {} }
  }

  function pathKey(value) {
    if (!value) return ''
    const path = resolve(value)
    return process.platform === 'win32' ? path.toLowerCase() : path
  }

  async function discover(home, state) {
    const expected = pathKey(join(root, 'home'))
    const registry = readService(ctx, 'workspaceRegistry')
    const registered = registry?.get?.(home.wsId)
    const workspace = (registry?.list?.() ?? []).find(item => pathKey(item.path) === expected)
      ?? (registered && pathKey(registered.path) === expected ? registered : null)
    const known = new Set(workspace?.sessionIds ?? [])
    const query = readService(ctx, 'sessionQuery')
    let discoveryPartial = typeof query?.listSessions !== 'function'
    try {
      for (const { header } of await query?.listSessions?.() ?? []) {
        if (pathKey(header.cwd) === expected && header.origin !== 'subagent' && !(header.delegationDepth > 0)) known.add(header.id)
      }
    } catch { discoveryPartial = true }
    const selections = await readSelection()
    const fish = new Set(home.pressureRoomIds ?? [])
    const matchingHome = known.has(home.sessionId) || Boolean(registered && pathKey(registered.path) === expected)
    if (matchingHome) {
      for (const id of [home.sessionId, home.rotatedFrom, home.rotatedTo]) {
        if (id) { fish.add(id); known.add(id) }
      }
    }
    for (const id of Object.keys(state.rotations ?? {})) if (known.has(id)) fish.add(id)
    for (const id of home.pressureRoomIds ?? []) known.add(id)
    const archived = new Set(registry?.archivedSessionIds ?? [])
    const rows = [...known].map(id => ({
      id, current: id === home.sessionId, fish: fish.has(id), archived: archived.has(id),
      selected: Object.hasOwn(selections, id) ? selections[id] : fish.has(id),
    }))
    return { rows, discoveryPartial }
  }

  const cacheDir = join(root, 'session-pressure-cache')
  const snapshotDir = join(cacheDir, 'pressure-v0.3')
  const roundCache = new Map()
  const trendCache = new Map()
  const batchSize = 4
  const pending = new Map()
  const dirty = new Map()
  const failures = new Map()
  const titles = new Map()
  const checked = new Map()
  let worker = null
  let disposed = false
  const idleWaiters = new Set()

  function notifyIdle() {
    if (!disposed && (worker || pending.size)) return
    for (const notify of idleWaiters) notify()
  }

  function waitForIdle() {
    if (disposed || (!worker && !pending.size)) return
    return new Promise(resolve => {
      const done = () => {
        clearTimeout(timeout)
        idleWaiters.delete(done)
        resolve()
      }
      const timeout = setTimeout(done, 10_000)
      idleWaiters.add(done)
    })
  }

  async function cachedAnalysis(id) {
    try {
      const value = JSON.parse(await fs.readFile(join(cacheDir, encodeURIComponent(id) + '.json'), 'utf8'))
      return value.version === 10 ? value : null
    } catch { return null }
  }

  async function analyzeSession(id, cached) {
    const query = readService(ctx, 'sessionQuery')
    if (typeof query?.observeSession !== 'function') return { status: 'unavailable' }
    let snapshot
    try {
      snapshot = await query.observeSession(id, { projectionMode: 'none' })
      if (snapshot.header?.origin === 'subagent' || snapshot.header?.delegationDepth > 0) return { status: 'excluded' }
      if (snapshot.cursor > 20_000) return { status: 'too-large' }
      const events = snapshot.events ?? []
      const footer = event => event ? JSON.stringify([event.seq, event.time, event.type]) : null
      const position = cached?.length ?? 0
      const appendOnly = cached && position <= events.length && cached.cursor <= snapshot.cursor
        && cached.footer === footer(events[position - 1])
      if (appendOnly && cached.cursor === snapshot.cursor && position === events.length) return cached.result
      const added = appendOnly ? events.slice(position) : events
      const prior = appendOnly ? cached : null
      const { checkpoint, ...analysis } = analyzePressureEvents(added, prior?.checkpoint, true)
      const title = added.findLast(event => event.type === 'session/title')?.data?.title ?? prior?.result.title
      const result = { status: 'analyzed', title, ...analysis,
        completedAt: added.findLast(event => event.type === 'turn/end' && event.data?.reason?.kind === 'completed')?.time
          ?? prior?.result.completedAt ?? null,
        lastRequest: lastRecordedRequest(added, prior?.checkpoint.route, prior?.result.lastRequest) }
      await fs.mkdir(cacheDir, { recursive: true })
      await writeAtomic(join(cacheDir, encodeURIComponent(id) + '.json'), JSON.stringify({
        version: 10, cursor: snapshot.cursor, length: events.length, footer: footer(events.at(-1)), checkpoint, result,
      }))
      return result
    } catch {
      return { status: 'unavailable' }
    } finally {
      snapshot?.[Symbol.dispose]?.()
    }
  }

  async function historicalRound(id, rounds, samples) {
    const key = JSON.stringify([id, rounds])
    const sampleKey = JSON.stringify(samples)
    const cached = roundCache.get(key)
    if (cached && cached.sampleKey === sampleKey && cached.revision === dirty.get(id)) return cached.result
    const query = readService(ctx, 'sessionQuery')
    let snapshot
    try {
      snapshot = await query?.observeSession?.(id, { projectionMode: 'none' })
      if (!snapshot || snapshot.cursor > 20_000 || snapshot.header?.origin === 'subagent' || snapshot.header?.delegationDepth > 0) return null
      const events = snapshot.events ?? []
      const boundary = diagnosticRoundBoundary(events, rounds)
      if (!boundary) return null
      const prefix = events.slice(0, boundary.index + 1)
      const data = { ...analyzePressureEvents(prefix), lastRequest: lastRecordedRequest(prefix), completedAt: boundary.event.time }
      const result = diagnostic(id, data, samples.filter(sample => sample.seq <= boundary.event.seq))
      if (result) result.sourceFingerprint = createHash('sha256')
        .update(JSON.stringify([prefix.map(({ seq, type, time }) => [seq, type, time]), result.inputs])).digest('hex')
      if (roundCache.size >= 256) roundCache.delete(roundCache.keys().next().value)
      roundCache.set(key, { sampleKey, revision: dirty.get(id), result })
      return result
    } catch {
      return null
    } finally {
      snapshot?.[Symbol.dispose]?.()
    }
  }

  function diagnostic(id, data, samples, dictionary) {
    const rows = data.rows ?? []
    const latest = rows.at(-1)
    const rounds = rows.filter(row => row.completed).length
    if (!rounds || !latest.completed || latest.turn !== data.lastRequest?.turn) return null
    const capacity = capacityInputs(dictionary ?? pressureDataDictionary(rows, samples, data.lastRequest, data, null, true))
    const structure = structurePressureInputs(data)
    const inputs = { capacity: { occupancy: capacity.occupancy, growth: capacity.growth, windows: capacity.windows },
      request: requestBurdenInputs(rows, data.lastRequest.contextWindow),
      structure: [structure.currentShare, structure.repeatedShare, structure.retryShare],
      invalidStructure: structure.measurementStatus === 'invalid', structureMeasurementReason: structure.measurementReason }
    const { provider, model, contextWindow } = data.lastRequest
    const route = provider && model && contextWindow > 0 ? JSON.stringify([provider, model, contextWindow]) : null
    const subScores = scoreDiagnostic(inputs, pressureDefaults)
    const scores = scoreComposite(subScores, pressureDefaults.composite, inputs.invalidStructure)
    const configurationChanged = rows.some(row => row.route && row.route !== route)
    return { id, rounds, sampledAt: data.completedAt ?? null, route, configurationChanged,
      versions: pressureVersions, diagnosticsVersion: 'diagnostics-v3', inputs, subScores,
      scores: Object.fromEntries(Object.entries(scores).map(([key, value]) => [key, value.score])),
      parameters: pressureDefaults, completeness: subScores.map(Number.isFinite) }
  }

  async function trend(id, includeDiagnostics = false) {
    const state = await read()
    const home = await readHome()
    const { rows } = await discover(home, state)
    if (!rows.some(row => row.id === id && (row.current || row.selected))) return null
    const samples = Object.values(state.records[id] ?? {}).sort((a, b) => a.seq - b.seq)
    const revision = dirty.get(id)
    const sampleKey = JSON.stringify([samples, state.compactionPairs?.[id]])
    const cacheKey = JSON.stringify([id, includeDiagnostics])
    const cached = trendCache.get(cacheKey)
    if (cached?.revision === revision && cached?.sampleKey === sampleKey) return cached.result
    const query = readService(ctx, 'sessionQuery')
    let snapshot
    try {
      snapshot = await query?.observeSession?.(id, { projectionMode: 'none' })
      if (!snapshot || snapshot.header?.origin === 'subagent' || snapshot.header?.delegationDepth > 0) return null
      if (snapshot.cursor > 20_000) return { id, status: 'too-large', points: [] }
      const events = snapshot.events ?? []
      const points = []
      let start = 0
      let checkpoint = null
      let lastRequest = null
      let sampleEnd = 0
      let previousRoute = null
      let switched = false
      const fingerprint = createHash('sha256')
      for (const { index, event, round } of diagnosticRoundBoundaries(events)) {
        const chunk = events.slice(start, index + 1)
        lastRequest = lastRecordedRequest(chunk, checkpoint?.route, lastRequest)
        const analysis = analyzePressureEvents(chunk, checkpoint, true)
        checkpoint = analysis.checkpoint
        start = index + 1
        while (sampleEnd < samples.length && samples[sampleEnd].seq <= event.seq) sampleEnd++
        fingerprint.update(JSON.stringify(chunk.map(({ seq, type, time }) => [seq, type, time])))
        const markers = chunk.flatMap(item => {
          if (!['compaction/start', 'compaction/end', 'compaction/prune'].includes(item.type)) return []
          const type = item.type === 'compaction/end'
            ? (item.data?.error ? '压缩失败' : '压缩成功')
            : item.type === 'compaction/start' ? '压缩开始' : '裁剪'
          const pair = state.compactionPairs?.[id]?.[item.seq]
          return [{ type, time: item.time ?? null, seq: item.seq, ...(pair ? { tokenChange: pair.after - pair.before } : {}) }]
        })
        const data = { ...analysis, lastRequest, completedAt: event.time }
        const roundSamples = samples.slice(0, sampleEnd)
        const dictionary = pressureDataDictionary(analysis.rows, roundSamples, lastRequest, analysis, null, true)
        const point = diagnostic(id, data, roundSamples, dictionary)
        for (const item of chunk) {
          if (item.type === 'assistant/attempt') markers.push({ type: '模型失败尝试', time: item.time, seq: item.seq })
          if (item.type === 'tool/result' && (item.data?.message?.isError || item.data?.error)) {
            markers.push({ type: '工具失败', time: item.time, seq: item.seq })
          }
        }
        const completed = analysis.rows.find(row => row.turn === event.data?.turn)
        if (completed?.retries > 0) markers.push({ type: '已匹配重试', time: event.time, count: completed.retries,
          tokens: completed.metrics?.retryTokens })
        for (const { type, data: config, time, seq } of chunk) {
          if (type !== 'request/context' || !config?.provider || !config?.model || !(config.contextWindow > 0)) continue
          const route = [config.provider, config.model, config.contextWindow]
          if (previousRoute && (previousRoute[0] !== route[0] || previousRoute[1] !== route[1])) {
            markers.push({ type: '模型切换', time, seq, from: previousRoute.slice(0, 2), to: route.slice(0, 2) })
            switched = true
          }
          if (previousRoute && previousRoute[2] !== route[2]) {
            markers.push({ type: '窗口切换', time, seq, from: [previousRoute[2]], to: [route[2]] })
            switched = true
          }
          previousRoute = route
        }
        points.push({ round, timestamp: event.time ?? null, markers, switched,
          diagnostics: point && includeDiagnostics ? dictionary.map(metric => ({ id: metric.id, title: metric.title,
            rows: metric.rows.filter(row => !(metric.id === 'T' && row.raw_value?.seq != null))
              .map(({ label, value, unit, source, scope }) => ({ label, value, unit, source, scope })) })) : null, snapshot: point ? {
          id, rounds: round, route: point.route, configurationChanged: point.configurationChanged,
          versions: point.versions, diagnosticsVersion: point.diagnosticsVersion,
          inputs: point.inputs, completeness: point.completeness,
          sourceFingerprint: fingerprint.copy().update(JSON.stringify([point.inputs, markers])).digest('hex'),
        } : null })
        if (round % 8 === 0) await yieldToHost()
      }
      const result = { id, status: 'analyzed', points }
      if (trendCache.size >= 16) trendCache.delete(trendCache.keys().next().value)
      trendCache.set(cacheKey, { revision, sampleKey, result })
      return result
    } catch {
      return { id, status: 'unavailable', points: [] }
    } finally {
      snapshot?.[Symbol.dispose]?.()
    }
  }

  async function saveDiagnostic(snapshot) {
    if (!snapshot) return
    const folder = join(snapshotDir, encodeURIComponent(snapshot.id))
    const path = join(folder, snapshot.rounds + '.json')
    await mutateJson(path, async () => {
      const body = JSON.stringify(snapshot)
      const previous = await fs.readFile(path, 'utf8').catch(error => {
        if (error.code !== 'ENOENT') throw error
        return null
      })
      if (previous === body) return
      await fs.mkdir(folder, { recursive: true })
      await writeAtomic(path, body)
    })
  }

  function work() {
    if (worker || disposed || !pending.size) return
    worker = setTimeout(async () => {
      try {
        for (const [id, job] of [...pending].slice(0, batchSize)) {
          if (disposed || pending.get(id) !== job) continue
          job.started = true
          const revision = dirty.get(id) ?? 0
          if (job.titleOnly) {
            const query = readService(ctx, 'sessionQuery')
            try {
              const [item] = await query.readTitleSnapshots([id])
              titles.set(id, { revision, title: item?.value?.title?.title ?? null })
            } catch { titles.set(id, { revision, title: null }) }
            if (pending.get(id) === job) pending.delete(id)
            continue
          }
          const result = await analyzeSession(id, job.cached)
          if (result.status !== 'analyzed') failures.set(id, result)
          checked.set(id, revision)
          if (pending.get(id) === job) pending.delete(id)
        }
      } finally {
        worker = null
        work()
        notifyIdle()
      }
    }, 0)
    worker.unref?.()
  }

  async function resultFor(candidate) {
    const { id } = candidate
    if (!candidate.current && !candidate.selected) {
      const cached = await cachedAnalysis(id)
      const revision = dirty.get(id) ?? 0
      const title = titles.get(id)
      if (title?.revision === revision) return { status: 'unchecked', title: title.title }
      if (cached?.result.title && !revision) return { status: 'unchecked', title: cached.result.title }
      if (typeof readService(ctx, 'sessionQuery')?.readTitleSnapshots === 'function' && !pending.has(id)) {
        pending.set(id, { titleOnly: true })
        work()
      }
      return { status: 'unchecked', title: cached?.result.title }
    }
    if (pending.has(id) && !pending.get(id).titleOnly) return { status: 'pending' }
    const cached = await cachedAnalysis(id)
    if (pending.has(id) && !pending.get(id).titleOnly) return { status: 'pending', title: cached?.result.title }
    const revision = dirty.get(id) ?? 0
    if (revision === checked.get(id)) return failures.get(id) ?? cached?.result ?? { status: 'unavailable' }
    if (cached && candidate.archived && !revision) return cached.result
    failures.delete(id)
    pending.set(id, { cached })
    work()
    return { status: 'pending', title: cached?.result.title }
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
      if (!entry || entry.type === 'turn/end') break
      if (['compaction/summary', 'compaction/prune'].includes(entry.type)
        || (entry.type === 'compaction/end' && !entry.data?.error)) compacted = true
    }
    for (let i = seq - 1; i >= 0; i--) {
      const entry = session.eventAt?.(i)
      if (!entry || entry.type === 'turn/start' || entry.type === 'turn/end') break
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

  const compactionStarts = new Map()
  function sampleCompaction(session, event) {
    const id = session?.header?.id
    const compactionId = event.data?.compactionId
    if (!id || typeof compactionId !== 'string') return
    const key = JSON.stringify([id, compactionId])
    const opening = event.type === 'compaction/start'
    const before = compactionStarts.get(key)
    if (!opening) compactionStarts.delete(key)
    if ((!opening && (!before || event.data.error)) || typeof session.requestContext !== 'function') return
    const route = session.requestContext()
    const meter = readService(ctx, 'tokenMeter')
    const measurement = meter?.measure?.(session)
    if (!route?.provider || !route?.model || !Number.isFinite(measurement?.totalTokens)
      || measurement.logRevision !== event.seq + 1) return
    const point = { tokens: measurement.totalTokens, route: JSON.stringify([route.provider, route.model, route.contextWindow]) }
    if (opening) {
      compactionStarts.set(key, point)
      if (compactionStarts.size > 64) compactionStarts.delete(compactionStarts.keys().next().value)
      return
    }
    if (before.route !== point.route) return
    return mutateJson(file, async () => {
      if ((await readHome()).sessionId !== id) return
      const state = await read()
      state.compactions = { ...state.compactions, [id]: { before: before.tokens, after: point.tokens } }
      state.compactionPairs ??= {}
      state.compactionPairs[id] = { ...state.compactionPairs[id], [event.seq]: state.compactions[id] }
      await fs.mkdir(dir, { recursive: true })
      await writeAtomic(file, JSON.stringify(state))
    })
  }

  const off = ctx.on?.('session/event', (session, event) => {
    const id = session?.header?.id
    if (['compaction/start', 'compaction/end'].includes(event?.type)) {
      try { void sampleCompaction(session, event)?.catch(() => {}) } catch { /* Meter unavailable. */ }
    }
    if (id && ['turn/end', 'session/title', 'compaction/end', 'compaction/prune'].includes(event?.type)) dirty.set(id, (dirty.get(id) ?? 0) + 1)
    if (event?.type === 'turn/end') void record(session, event).catch(() => {})
  })
  return {
    trend,
    dispose: () => { disposed = true; clearTimeout(worker); pending.clear(); notifyIdle(); off?.() },
    waitForIdle,
    async select(id, selected) {
      if (typeof id !== 'string' || typeof selected !== 'boolean') return false
      const { rows } = await discover(await readHome(), await read())
      const candidate = rows.find(row => row.id === id && !row.current)
      if (!candidate) return false
      await mutateJson(selectionFile, async () => {
        const choices = await readSelection()
        await writeAtomic(selectionFile, JSON.stringify({ ...choices, [id]: selected }))
      })
      if (selected) await resultFor({ ...candidate, selected: true })
      else if (!pending.get(id)?.started) pending.delete(id)
      return true
    },
    async view(includeComposite = false) {
      const referenceRounds = 'end'
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

      const { rows: candidates, discoveryPartial } = await discover(home, state)
      const current = candidates.some(row => row.current) ? await resultFor({ current: true, id: home.sessionId }) : { status: 'unavailable' }
      const dictionary = pressureDataDictionary(current.rows ?? [], view.rows, current.lastRequest, current, state.compactions?.[home.sessionId])
      const completedRounds = (current.rows ?? []).filter(row => row.completed).length
      const currentDiagnostic = includeComposite && completedRounds
        ? await historicalRound(home.sessionId, completedRounds, view.rows) : null
      const comparison = includeComposite ? { current: currentDiagnostic,
        rounds: completedRounds, history: [], saveFailed: false } : null
      const history = []
      const amplificationHistory = []
      const baseline = []
      const loadHistory = []
      for (const candidate of candidates) {
        const { id } = candidate
        const data = candidate.current ? current : await resultFor(candidate)
        const rows = data.rows ?? []
        const complete = rows.filter(row => row.completeUsage)
        if (comparison && completedRounds && !candidate.current && candidate.selected) {
          const samples = Object.values(state.records[id] ?? {}).sort((a, b) => a.seq - b.seq)
          const hasRound = rows.filter(row => row.completed).length >= completedRounds
          const snapshot = data.status === 'analyzed' && hasRound
            ? await historicalRound(id, completedRounds, samples) : null
          comparison.history.push({ id, title: data.title ?? null, snapshot, reason: snapshot ? null
            : data.status === 'pending' ? 'pending' : data.status !== 'analyzed' ? 'unavailable'
              : !hasRound ? 'short' : 'missing' })
        }
        if (!candidate.current && data.status === 'analyzed' && rows.length) {
          loadHistory.push(data)
          amplificationHistory.push({ id, title: data.title, rows: rows.map(row => ({
            turn: row.turn, requests: row.requests, attempts: row.attempts, first: row.metrics?.firstInput,
            extra: row.load?.A ?? null,
          })) })
          for (const row of complete) if (row.completed) baseline.push(row.total.value)
        }
        history.push({ ...candidate, title: typeof data.title === 'string' ? data.title : null, status: data.status, turns: rows.length, usageTurns: complete.length,
          referenceEligibility: sessionReferenceEligibility(data, referenceRounds) })
      }
      const selectedHistory = history.filter(row => row.selected && !row.current)
      const pendingCount = history.filter(row => row.status === 'pending' || pending.get(row.id)?.titleOnly).length
      const analyzedCount = selectedHistory.filter(row => row.status === 'analyzed').length
      const partial = discoveryPartial || analyzedCount < selectedHistory.length
      const sorted = baseline.sort((a, b) => a - b)
      const reference = sorted.length >= 10
        ? { count: sorted.length, p90: sorted[Math.ceil(sorted.length * .9) - 1] }
        : { count: sorted.length, p90: null }
      if (comparison) {
        try { await saveDiagnostic(currentDiagnostic) } catch { comparison.saveFailed = true }
      }
      return { ...view, updatedAt: Date.now(), availability: current.status, lastRequest: current.lastRequest, load: buildSessionLoad(current, partial ? [] : loadHistory, null, referenceRounds),
        usage: { structurePressure: structurePressureInputs(current), requestBurden: requestBurdenInputs(current.rows ?? [], current.lastRequest?.contextWindow ?? null),
          amplificationHistory, dictionary, comparison, latest: current.latest, burden: current.burden?.slice(0, 10),
          retentionComplete: current.retentionComplete, toolResults: current.toolResults ?? [],
          roundDiagnostics: (current.rows ?? []).slice(-200).map(row => ({ turn: row.turn, input: row.input.value,
            output: row.output.value, requests: row.requests, retained: row.metrics?.tools?.tokens,
            cache: row.cache, attempts: row.attempts, toolErrors: row.toolErrors })),
          reference: partial ? null : reference, history, discovered: candidates.length,
          discoveryPartial, partial, pendingCount, analyzedCount, selectedCount: selectedHistory.length } }
    },
  }
}
