import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openLoops, LOOPS_MAX } from '../lib/loops.js'

const NOW = Date.parse('2026-11-21T02:00:00.000Z')

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fish-loops-'))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('把好奇、便条、约定、疤收成一张清单，按时间倒序', async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, 'notes.json'), JSON.stringify([
      { id: 'n1', text: '把旧耳机修一下。', status: 'open', created: '2026-11-20T10:00:00.000Z' },
      { id: 'n2', text: '已经做完的那张。', status: 'done', created: '2026-11-20T11:00:00.000Z' },
    ]))
    await writeFile(join(root, 'appointments.json'), JSON.stringify([
      { id: 'a1', what: '去看那家店', due: '2026-11-23', status: 'open' },
      { id: 'a2', what: '已经做完的约定', due: '2026-11-22', status: 'done' },
    ]))
    const events = [
      { id: 'ev1', type: 'utterance', ts: '2026-11-20T09:00:00.000Z', text: '为什么海水看起来是蓝色的？' },
    ]
    const model = {
      scars: [
        { id: 's1', quote: '我说过不熬夜的。', since: '2026-11-19T03:00:00.000Z', resolvedAt: null },
        { id: 's2', quote: '已经想通的那件事。', since: '2026-11-18T03:00:00.000Z', resolvedAt: '2026-11-20T03:00:00.000Z' },
      ],
    }
    const rows = await openLoops({ root, events, model, now: NOW })
    const kinds = rows.map((r) => r.kind)
    assert.ok(kinds.includes('curiosity'))
    assert.ok(kinds.includes('note'))
    assert.ok(kinds.includes('appoint'))
    assert.ok(kinds.includes('scar'))
    assert.ok(!rows.some((r) => r.text === '已经做完的那张。'))
    assert.ok(!rows.some((r) => r.text === '已想通的那件事。' || r.text === '已经想通的那件事。'))
    assert.ok(!rows.some((r) => r.text === '已经做完的约定'))
    for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].at >= rows[i].at)
    for (const r of rows) {
      assert.equal(typeof r.text, 'string')
      assert.ok([...r.text].length <= 81)
    }
  })
})

test('没有事件、没有文件：返回空表，不抛', async () => {
  await withRoot(async (root) => {
    assert.deepEqual(await openLoops({ root, events: [], model: null, now: NOW }), [])
  })
})

test('超过上限只留最近的 20 条', async () => {
  await withRoot(async (root) => {
    const notes = Array.from({ length: 25 }, (_, i) => ({
      id: `n${i}`,
      text: `第 ${i} 张便条。`,
      status: 'open',
      created: `2026-11-${String(1 + (i % 20)).padStart(2, '0')}T10:00:00.000Z`,
    }))
    await writeFile(join(root, 'notes.json'), JSON.stringify(notes))
    const rows = await openLoops({ root, events: [], model: null, now: NOW })
    assert.equal(rows.length, LOOPS_MAX)
  })
})
