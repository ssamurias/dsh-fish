/**
 * ask-done.test.mjs —— 「这事已经过去了」（2026-11-20）
 *
 * 这张卡问的东西后来自己到手了（版本更新给的能力、他已经手动办了、或者不需要了），
 * 但当时的裁决是历史，不回改。所以单开一条 `meta ask-done:<id>` 做「后来的结局」：
 *   - 它不算没答（pendingAsks / settleStaleAsks / /ask 的 pending 都不再摆它）；
 *   - 它不再悬着（looseEnds 不再念「他说以后再说」30 天，wish 也不再摆）；
 *   - 它只写一次（连点不攒同义行），也改不了任何一条旧记录。
 * 这里把这几条边界钉住。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  askView,
  doneAsksOf,
  markAskDone,
  pendingAsks,
  settleAsk,
  settleStaleAsks,
} from '../lib/ask.js'
import { looseEnds } from '../lib/proactive.js'
import { wishesOf } from '../lib/wish.js'
import { readEvents } from '../lib/store.js'
import { dateKey } from '../lib/settings.js'

async function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'fish-askdone-'))
  try {
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'events.jsonl'), '', 'utf8')
    return await fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

/** 直接写一条 ask 进去（模拟工具那一侧已经问出来的状态）。 */
function seedAsk(root, { id = 'ev_ask1', kind = 'other', text = '我想问一件事。', ts } = {}) {
  const at = ts ?? new Date()
  const ev = {
    id,
    v: 1,
    ts: at.toISOString(),
    day: dateKey(at),
    stage: 1,
    type: 'ask',
    source: 'system',
    text,
    refs: [],
    verdict: null,
    confidence: 0.5,
    flags: [],
    ask: { kind },
  }
  appendFileSync(join(root, 'events.jsonl'), `${JSON.stringify(ev)}\n`, 'utf8')
  return ev
}

test('标成解决之后：不再算没答、不再悬着，但裁决原样留着', async () => withRoot(async (root) => {
  const ask = seedAsk(root, { id: 'ev_a1', text: '能不能把改文件的那只手给我。' })
  await settleAsk(root, { askId: ask.id, verdict: 'later', reason: '以后再说', via: 'ui' })

  // 标之前：这张卡确实在「还悬着」里
  const before = (await readEvents(root)).events
  assert.equal(looseEnds(before).some((x) => x.id === ask.id), true, '标之前应该在 looseEnds 里')

  const r = await markAskDone(root, { askId: ask.id })
  assert.equal(r.ok, true, r.why)

  const { events } = await readEvents(root)
  assert.deepEqual([...doneAsksOf(events)], [ask.id])

  // 裁决一个字没动
  const answer = events.find((e) => e.type === 'answer')
  assert.equal(answer.ask.verdict, 'later')
  assert.equal(answer.ask.via, 'ui')

  const item = askView(events).find((x) => x.id === ask.id)
  assert.equal(item.done, true)
  assert.equal(item.pending, false)
  assert.equal(item.verdict, 'later', '历史裁决不改，只是多了一个结局')

  assert.equal(pendingAsks(events).some((x) => x.id === ask.id), false)
  assert.equal(looseEnds(events).some((x) => x.id === ask.id), false, '标了就不该再摆「他说以后再说」')
}))

test('重复标：只回 already，事件流里只有一行', async () => withRoot(async (root) => {
  const ask = seedAsk(root, { id: 'ev_a2' })
  const first = await markAskDone(root, { askId: ask.id })
  assert.equal(first.ok, true)
  const second = await markAskDone(root, { askId: ask.id })
  assert.equal(second.ok, true)
  assert.equal(second.already, true)

  const { events } = await readEvents(root)
  const lines = events.filter((e) => e.type === 'meta' && String(e.text) === `ask-done:${ask.id}`)
  assert.equal(lines.length, 1)
}))

test('没这条请求就不写：不认识的 id 一个字节都不落', async () => withRoot(async (root) => {
  const r = await markAskDone(root, { askId: 'ev_nope' })
  assert.equal(r.ok, false)
  const { events } = await readEvents(root)
  assert.equal(events.length, 0)
}))

test('还没答就先标：不会被一天后的超时结算落成「以后再说」', async () => withRoot(async (root) => {
  const old = new Date(Date.now() - 25 * 3600 * 1000)
  const ask = seedAsk(root, { id: 'ev_a3', ts: old })
  const r = await markAskDone(root, { askId: ask.id })
  assert.equal(r.ok, true, r.why)

  const n = await settleStaleAsks(root)
  assert.equal(n, 0, '标成解决的卡不该再被自动结算')

  const { events } = await readEvents(root)
  assert.equal(events.some((e) => e.type === 'answer'), false, '不该凭空写一条 answer')
  assert.equal(pendingAsks(events).length, 0)
  assert.equal(askView(events)[0].pending, false)
}))

test('need-tool 那种也一样：标了就不再摊在桌上', async () => withRoot(async (root) => {
  const ask = seedAsk(root, { id: 'ev_a4', kind: 'need-tool', text: '能不能给我一个画画的工具。' })
  await settleAsk(root, { askId: ask.id, verdict: 'later', reason: '以后再说', via: 'ui' })

  const before = (await readEvents(root)).events
  assert.equal(wishesOf(before).some((x) => x.id === ask.id), true)

  await markAskDone(root, { askId: ask.id })
  const after = (await readEvents(root)).events
  assert.equal(wishesOf(after).some((x) => x.id === ask.id), false)
}))
