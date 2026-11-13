/**
 * wake-schedule.test.mjs —— 落点怎么抽、什么时候沿用、什么时候重抽。
 *
 * 2026-11-13（用户 m00242）三条：
 *   - 改完时段当天要重抽：旧落点在新窗口外还沿用，今天可能一次都不醒；
 *   - 跨零点尾段（00:00–结束）要落到次日，不能落在当天凌晨（那已经过去了）；
 *   - 旧版把尾段放在当天凌晨的标记，重启后要认出来并重抽。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ensureSchedule } from '../lib/scheduler.js'
import { appendEvent, readEvents } from '../lib/store.js'
import { inWindow } from '../lib/settings.js'

const tmpRoot = () => mkdtemp(join(tmpdir(), 'fish-sched-'))
const localIso = (...args) => new Date(...args).toISOString()
const cleanup = (root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })

test('跨零点的尾段落次日，不会抽到已经过去的当天凌晨', async () => {
  const config = { window: ['22:00', '02:00'] }
  for (let day = 20; day <= 30; day++) {
    const root = await tmpRoot()
    try {
      const dk = `2026-10-${day}`
      const { at, reused } = await ensureSchedule(root, config, [], dk)
      assert.equal(reused, false)
      assert.ok(inWindow(config, new Date(at)), `${dk} 的落点要在窗口里：${new Date(at)}`)
      const dkStart = new Date(2026, 9, day).getTime()
      assert.ok(
        at >= dkStart + 22 * 3_600_000,
        `${dk} 的落点不能落在当天 22:00 之前（那一段属于前一天）：${new Date(at)}`,
      )
    } finally {
      await cleanup(root)
    }
  }
})

test('同一天重开：沿用最后一条落点，不再重抽', async () => {
  const root = await tmpRoot()
  try {
    const dk = '2026-10-29'
    const config = { window: ['22:00', '02:00'] }
    const first = await ensureSchedule(root, config, [], dk)
    const { events } = await readEvents(root)
    const second = await ensureSchedule(root, config, events, dk)
    assert.equal(second.reused, true)
    assert.equal(second.at, first.at, '重启不该换一个落点')
  } finally {
    await cleanup(root)
  }
})

test('旧版把跨零点尾段放在当天凌晨：认出来，重抽到次日', async () => {
  const root = await tmpRoot()
  try {
    const dk = '2026-10-29'
    const config = { window: ['22:00', '02:00'] }
    // 旧版 bug：00:30 写成 10-29 当天，实际属于 10-28 那一段
    await appendEvent(
      { type: 'meta', text: `sched:${dk} ${localIso(2026, 9, 29, 0, 30)}` },
      { day: 0, stage: 1, source: 'timer' },
      root,
    )
    const { events } = await readEvents(root)
    const { at, reused } = await ensureSchedule(root, config, events, dk)
    assert.equal(reused, false, '当天凌晨的旧落点不属于这个醒来日，必须重抽')
    assert.ok(at >= new Date(2026, 9, 29, 22, 0).getTime(), `重抽后应在 22:00 之后或次日：${new Date(at)}`)
    assert.ok(inWindow(config, new Date(at)))
  } finally {
    await cleanup(root)
  }
})

test('改完时段：旧落点在新窗口外，当天就重抽', async () => {
  const root = await tmpRoot()
  try {
    const dk = '2026-10-29'
    const newCfg = { window: ['22:00', '02:00'] }
    // 旧窗口里 21:00 是合法落点，但新窗口 22:00 才开始
    await appendEvent(
      { type: 'meta', text: `sched:${dk} ${localIso(2026, 9, 29, 21, 0)}` },
      { day: 0, stage: 1, source: 'timer' },
      root,
    )
    const { events } = await readEvents(root)
    const { at, reused } = await ensureSchedule(root, newCfg, events, dk)
    assert.equal(reused, false, '旧落点不在新时段里，不能沿用')
    assert.ok(at >= new Date(2026, 9, 29, 22, 0).getTime())
    assert.ok(inWindow(newCfg, new Date(at)))
  } finally {
    await cleanup(root)
  }
})

test('重抽的落点不早于现在：不会一开应用就补醒', async () => {
  const root = await tmpRoot()
  try {
    const dk = '2026-10-29'
    const config = { window: ['08:00', '22:00'] }
    // 21:59:30 在窗口内；窗口内的随机落点最多到 21:59，必定已经过去。
    const now = new Date(2026, 9, 29, 21, 59, 30)
    const { at } = await ensureSchedule(root, config, [], dk, now)
    assert.ok(at >= now.getTime(), `重抽落点不能在过去：${new Date(at)}`)
    assert.ok(inWindow(config, new Date(at)))
  } finally {
    await cleanup(root)
  }
})
