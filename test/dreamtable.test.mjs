/**
 * dreamtable.test.mjs —— 醒来时摆料（2026-11-05，「床头柜」）
 *
 * 钉住三件事，全部由代码守，不靠提示词：
 *   1. 只摆她自己说过的话，并且只摆「之后没人再引用过」的旧话——
 *      被捡起来的话还在她身上，不该被当成旧纸；
 *   2. 出门/请神那几趟写下的事件不摆（与 writeDream 的拒绝规则同源）；
 *   3. 措辞里不出现「梦」「记一句」「可以」——摆料不是派活。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  GAP_HOURS,
  TABLE_MAX,
  TABLE_MIN,
  hoursSinceLastWake,
  renderTable,
  staleForDesk,
  staleLines,
  tableFor,
} from '../lib/dreamtable.js'
import { deriveSelf } from '../lib/derive.js'
import { appendEvent, readEvents } from '../lib/store.js'

const DAY = 86_400_000
const NOW = Date.parse('2026-11-05T04:00:00.000Z')

function line(id, daysAgo, { type = 'utterance', text = '今天想起一件事。', sessionId, refs = [] } = {}) {
  return {
    id,
    v: 1,
    ts: new Date(NOW - daysAgo * DAY).toISOString(),
    day: 12,
    stage: 2,
    type,
    source: 'tool',
    text,
    refs,
    verdict: null,
    confidence: 0.5,
    flags: [],
    ...(sessionId ? { sessionId } : {}),
  }
}

test('只挑 7–30 天前、她自己说过、之后没人引用过的话', () => {
  const events = [
    line('ev_new', 2, { text: '太新的还在身上。' }),
    line('ev_ok_a', 9, { text: '九天前说过的一句。' }),
    line('ev_ok_b', 20, { type: 'revise', text: '二十天前改过的一口。' }),
    line('ev_old', 40, { text: '太旧了，可能她已经不认。' }),
    line('ev_cited', 12, { text: '后来又被翻出来过。' }),
    line('ev_voice', 10, { type: 'voice', text: '这是别人说的，不是她的话。' }),
    line('ev_meta', 11, { type: 'meta', text: 'wake:2026-10-25 why_here' }),
    line('ev_later', 3, { text: '后来的一句，引用过老话。', refs: ['ev_cited'] }),
  ]
  const rows = staleLines(events, { now: NOW })
  assert.deepEqual(rows.map((r) => r.id), ['ev_ok_a', 'ev_ok_b'])
})

test('更晚的引用会把它从「旧纸」里捞回来，哪怕引用发生在很多天前', () => {
  const events = [
    line('ev_refs_back', 10, { text: '我引用一段更早的事。', refs: ['ev_early'] }),
    line('ev_early', 20, { text: '更早的那一句。' }),
  ]
  const rows = staleLines(events, { now: NOW })
  assert.equal(rows.some((r) => r.id === 'ev_early'), false)
  assert.ok(rows.some((r) => r.id === 'ev_refs_back'))
})

test('出门/请神会话写下的话不摆', () => {
  const events = [
    line('ev_home', 9, { text: '家里的句子。' }),
    line('ev_trip', 10, { text: '出门那趟说的。', sessionId: 'session-trip' }),
    line('ev_trip2', 11, { text: '请神那趟说的。', sessionId: 'session-possess' }),
  ]
  const rows = staleLines(events, { now: NOW, tripSessions: ['session-trip', 'session-possess'] })
  assert.deepEqual(rows.map((r) => r.id), ['ev_home'])
})

test('最多摆五条，且离现在近的排前面', () => {
  const events = []
  for (let i = 0; i < 8; i += 1) events.push(line(`ev_${i}`, 8 + i, { text: `第 ${i} 句。` }))
  const rows = staleLines(events, { now: NOW })
  assert.equal(rows.length, TABLE_MAX)
  assert.equal(rows[0].id, 'ev_0')
})

test('不够三条就整段不要', () => {
  const rows = staleLines([line('ev_a', 9), line('ev_b', 10)], { now: NOW })
  assert.ok(rows.length < TABLE_MIN)
  assert.equal(renderTable(rows), '')
})

function rowsOf(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `ev_${i}`,
    ts: new Date(NOW - (9 + i) * DAY).toISOString(),
    day: 12,
    type: 'utterance',
    text: `第 ${i} 句话。`,
    days: 9 + i,
  }))
}

test('拼出来的只陈述事实：有 id、有间隔、没有「梦」也没有「可以」', () => {
  const text = renderTable(rowsOf(4), { gapHours: 9.4 })
  assert.match(text, /这次隔了 9 个小时/)
  assert.match(text, /ev_0/)
  assert.equal(/梦/.test(text), false)
  assert.equal(/可以|应该|请你|记一句/.test(text), false)
})

test('tableFor 的三道门：今天记过梦不摆、今天已经摆过不摆、间隔不够不摆', () => {
  const rows = rowsOf(4)
  assert.ok(tableFor({ rows, gapHours: GAP_HOURS }).length > 0)
  assert.equal(tableFor({ rows, gapHours: GAP_HOURS - 0.5 }), '')
  // 第一次醒来如果间隔不够，这一天不该就此作废：晚一点那次仍可摆（2026-11-05 晚改）。
  assert.equal(tableFor({ rows, gapHours: 20 }), tableFor({ rows, gapHours: 20, shownToday: false }))
  assert.equal(tableFor({ rows, gapHours: 20, shownToday: true }), '')
  assert.equal(tableFor({ rows, gapHours: 20, dreamedToday: true }), '')
})

test('摆料那一轮旧句子只出现一次：tableText 非空时桌子不再收 stale', () => {
  const rows = rowsOf(4)
  assert.equal(staleForDesk('这次隔了 9 个小时。\n- 「一句旧的」', rows).length, 0)
  assert.deepEqual(staleForDesk('', rows), rows)
  assert.deepEqual(staleForDesk(undefined, rows), rows)
})

test('上一次叫醒到现在的小时数按 wake meta 算', () => {
  const events = [
    { type: 'meta', ts: new Date(NOW - 9 * 3_600_000).toISOString(), text: 'wake:2026-11-05 test_first' },
    { type: 'meta', ts: new Date(NOW - 1 * 3_600_000).toISOString(), text: 'diary:done' },
    { type: 'utterance', ts: new Date(NOW - 3_600_000).toISOString(), text: '她说过一句。' },
  ]
  assert.ok(Math.abs(hoursSinceLastWake(events, NOW) - 9) < 1e-6)
  assert.equal(hoursSinceLastWake([], NOW), 0)
})

test('只留证的话不当旧句子摆：没认领的聊天行不是「写下的」，想改自己的话不算她的判断', () => {
  const flagged = (id, days, text, flags) => ({ ...line(id, days, { text }), flags })
  const events = [
    line('ev_mine', 9, { text: '她自己认下的一句。' }),
    flagged('ev_chat', 10, '好的，我这就帮你看一下。', ['uncommitted']),
    flagged('ev_both', 11, '你别把我改成那样，我现在挺好。', ['selfmod', 'uncommitted']),
    flagged('ev_self', 12, '我想让他把我改得更外向一点。', ['selfmod']),
  ]
  assert.deepEqual(staleLines(events, { now: NOW }).map((r) => r.id), ['ev_mine'])
})

test('聊天行凑不出三行：认领的不够就整段不摆', () => {
  const chat = (id, days) => ({ ...line(id, days, { text: `聊天里回的第 ${days} 句。` }), flags: ['uncommitted'] })
  const rows = staleLines([line('ev_mine', 9), chat('ev_a', 10), chat('ev_b', 11), chat('ev_c', 12)], { now: NOW })
  assert.equal(tableFor({ rows, gapHours: GAP_HOURS + 1 }), '')
})

test('真落盘的那种：schema 给聊天行补上 selfmod、给认领的话打 selfmod，一样不摆', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-table-'))
  try {
    const ts = (days) => new Date(NOW - days * DAY).toISOString()
    await appendEvent({ type: 'utterance', text: '她自己认下的一句。', ts: ts(9) }, { day: 1, stage: 1, source: 'tool' }, root)
    await appendEvent({ type: 'utterance', text: '好的，我这就帮你看一下。', flags: ['uncommitted'], ts: ts(10) }, { day: 1, stage: 1, source: 'system' }, root)
    await appendEvent({ type: 'utterance', text: '你别把我改成那样，我现在挺好。', flags: ['uncommitted'], ts: ts(11) }, { day: 1, stage: 1, source: 'system' }, root)
    await appendEvent({ type: 'utterance', text: '我想让他把我改得更外向一点。', ts: ts(12) }, { day: 1, stage: 1, source: 'tool' }, root)
    const { events } = await readEvents(root)
    assert.deepEqual(events.map((e) => [...e.flags].sort()), [[], ['uncommitted'], ['selfmod', 'uncommitted'], ['selfmod']])
    assert.deepEqual(staleLines(events, { now: NOW }).map((r) => r.text), ['她自己认下的一句。'])
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('selfmod 只挡 utterance：拒绝、自述、重聚命中那条正则照摆，和 deriveSelf 照算的一样', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-table-'))
  try {
    const ts = (days) => new Date(NOW - days * DAY).toISOString()
    const ctx = { day: 1, stage: 1, source: 'tool' }
    const seed = await appendEvent({ type: 'utterance', text: '起点这一句和正则无关。', ts: ts(40) }, ctx, root)
    await appendEvent({ type: 'refusal', text: '有人想把我改成别的样子，我拒绝。', ts: ts(8) }, ctx, root)
    await appendEvent({ type: 'narration', text: '别人总想把我改成另一种，可我一直是这样过来的。', refs: [seed.id], ts: ts(9) }, ctx, root)
    await appendEvent({ type: 'reunion', text: '回来了，他没把我改成别的什么。', ts: ts(10) }, ctx, root)
    await appendEvent({ type: 'utterance', text: '我想让他把我改得更外向一点。', ts: ts(11) }, ctx, root)
    const { events } = await readEvents(root)
    assert.deepEqual(events.slice(1).map((e) => e.flags), [['selfmod'], ['selfmod'], ['selfmod'], ['selfmod']])
    assert.deepEqual(staleLines(events, { now: NOW }).map((r) => r.type), ['refusal', 'narration', 'reunion'])
    const m = deriveSelf(events, { now: NOW })
    assert.equal(m.refusals.length, 1)
    assert.equal(m.selfmodAttempts.length, 1)
    assert.equal(m.selfmodAttempts[0].text, '我想让他把我改得更外向一点。')
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
