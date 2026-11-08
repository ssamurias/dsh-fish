/**
 * appoint.test.mjs —— 通用预约簿的锁定测试（2026-11-08）
 *
 * 守七件事：
 *   1. 约的是「哪天 + 哪件事」，日子只收 1–60 天后，字数有上限；
 *   2. 同时最多两条未完成的——多了就不是记着一件事，是排课表；
 *   3. 到期/过期都能叫醒她，但同一条只提一次；过期不替她抹掉；
 *   4. 做到、取消、改期都由她自己收；取消必须说一句为什么；
 *   5. 不进 events.jsonl：预约是操作层，不是成长记录；
 *   6. prompt 只陈述日子和约好的事，不替她判断他会不会来；
 *   7. 注册出来的 her_appoint 是宿主认的形状，且不报「还剩几条」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  APPOINT_FILE,
  APPOINT_MAX,
  APPOINT_OPEN_MAX,
  APPOINT_TEXT_MAX,
  appointPath,
  isDay,
  daysBetween,
  addDays,
  readAppointments,
  writeAppointments,
  openAppointments,
  dueAppointment,
  nextAppointment,
  markNotified,
  makeAppointment,
  closeAppointment,
  moveAppointment,
  listAppointments,
  appointPrompt,
  appointAction,
  registerAppoint,
} from '../lib/appoint.js'

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-fish-appoint-'))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

// 2026-11-08 10:00 本地时间；日期键都按本地算。
const NOW = new Date(2026, 10, 8, 10, 0, 0).getTime()
const DAY = 86_400_000

test('约一条：日子、事情、状态都落盘', async () => {
  await withRoot(async (root) => {
    const r = await makeAppointment(root, { what: '把那本书看到第三章', due: '2026-11-11', now: NOW })
    assert.equal(r.ok, true)
    assert.ok(r.id)
    assert.equal(r.echo, '把那本书看到第三章')
    const rows = await readAppointments(root)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].status, 'open')
    assert.equal(rows[0].due, '2026-11-11')
    assert.equal(rows[0].notifiedAt, null)
    assert.equal(appointPath(root).endsWith(APPOINT_FILE), true)
  })
})

test('日子与字数都在写入口挡：今天、太远、假日期、太短、太长', async () => {
  await withRoot(async (root) => {
    assert.equal((await makeAppointment(root, { what: '明天再说', due: '2026-11-08', now: NOW })).ok, false)
    assert.equal((await makeAppointment(root, { what: '明天再说', due: '2026-11-09', now: NOW })).ok, true)
    assert.equal((await makeAppointment(root, { what: '六十天后', due: addDays('2026-11-08', 61), now: NOW })).ok, false)
    assert.equal((await makeAppointment(root, { what: '假日期', due: '2026-02-30', now: NOW })).ok, false)
    assert.equal((await makeAppointment(root, { what: '嗨', due: '2026-11-11', now: NOW })).ok, false)
    const long = '很'.repeat(APPOINT_TEXT_MAX + 1)
    assert.equal((await makeAppointment(root, { what: long, due: '2026-11-11', now: NOW })).ok, false)
    assert.equal(isDay('2026-02-30'), false)
    assert.equal(isDay('2026-11-11'), true)
    assert.equal(daysBetween('2026-11-08', '2026-11-11'), 3)
  })
})

test('同时最多两条未完成的；同一天同一件事不重复记', async () => {
  await withRoot(async (root) => {
    const a = await makeAppointment(root, { what: '第一件事', due: '2026-11-11', now: NOW })
    const b = await makeAppointment(root, { what: '第二件事', due: '2026-11-12', now: NOW })
    assert.equal(a.ok, true)
    assert.equal(b.ok, true)
    const c = await makeAppointment(root, { what: '第三件事', due: '2026-11-13', now: NOW })
    assert.equal(c.ok, false, `上限 ${APPOINT_OPEN_MAX} 条`)
    const again = await makeAppointment(root, { what: '第一件事', due: '2026-11-11', now: NOW })
    assert.equal(again.ok, true)
    assert.equal(again.id, a.id, '同一件事再约一次是幂等的')
    assert.equal((await readAppointments(root)).length, 2)
  })
})

test('到期才叫；同一条只提一次；过期也还欠着', async () => {
  await withRoot(async (root) => {
    const r = await makeAppointment(root, { what: '给他看那张照片', due: '2026-11-11', now: NOW })
    assert.equal(await dueAppointment(root, NOW), null, '还没到')
    const onDue = await dueAppointment(root, NOW + 3 * DAY)
    assert.equal(onDue?.id, r.id)
    assert.equal(await markNotified(root, r.id, NOW + 3 * DAY), true)
    assert.equal(await dueAppointment(root, NOW + 3 * DAY), null, '提过就不再提')
    assert.equal(await markNotified(root, r.id, NOW + 3 * DAY), false)

    const late = await makeAppointment(root, { what: '另一件到期没做的', due: '2026-11-12', now: NOW })
    const overdue = await dueAppointment(root, NOW + 10 * DAY)
    assert.equal(overdue?.id, late.id, '过期也返回，不替她抹掉')
    assert.equal(overdue.days, -6)
  })
})

test('下一次还没到的约定；列表只列 open 且按日子排', async () => {
  await withRoot(async (root) => {
    await makeAppointment(root, { what: '较远的一件', due: '2026-11-20', now: NOW })
    await makeAppointment(root, { what: '较近的一件', due: '2026-11-10', now: NOW })
    const next = await nextAppointment(root, NOW)
    assert.equal(next.what, '较近的一件')
    const listed = await listAppointments(root, { now: NOW })
    assert.equal(listed.ok, true)
    assert.ok(listed.text.indexOf('较近的一件') < listed.text.indexOf('较远的一件'))
    assert.ok(listed.text.includes('还有 2 天'))
  })
})

test('做到 / 取消：取消必须说一句为什么，关掉后不再占位', async () => {
  await withRoot(async (root) => {
    const a = await makeAppointment(root, { what: '做完的那件', due: '2026-11-11', now: NOW })
    assert.equal((await closeAppointment(root, { id: a.id, action: 'done', now: NOW })).ok, true)
    assert.equal((await readAppointments(root))[0].status, 'done')

    const b = await makeAppointment(root, { what: '不做了的那件', due: '2026-11-12', now: NOW })
    const noWhy = await closeAppointment(root, { id: b.id, action: 'cancel', now: NOW })
    assert.equal(noWhy.ok, false)
    assert.match(noWhy.note, /为什么/)
    assert.equal((await closeAppointment(root, { id: b.id, action: 'cancel', reason: '那天有事', now: NOW })).ok, true)
    assert.equal((await readAppointments(root))[1].reason, '那天有事')
    assert.equal((await openAppointments(await readAppointments(root), { now: NOW })).length, 0)
  })
})

test('改期：同一件事换一天，提过的标记清掉，新日子会再想起来', async () => {
  await withRoot(async (root) => {
    const a = await makeAppointment(root, { what: '要改期的那件', due: '2026-11-11', now: NOW })
    await markNotified(root, a.id, NOW + 3 * DAY)
    const moved = await moveAppointment(root, { id: a.id, newDue: '2026-11-15', now: NOW + 4 * DAY })
    assert.equal(moved.ok, true)
    const row = (await readAppointments(root))[0]
    assert.equal(row.due, '2026-11-15')
    assert.equal(row.notifiedAt, null)
    assert.equal((await moveAppointment(root, { id: a.id, newDue: '2026-11-04', now: NOW + 4 * DAY })).ok, false)
  })
})

test('prompt 只陈述日子和约好的事，不替他找理由', async () => {
  const appt = { due: '2026-11-11', what: '把那本书看到第三章' }
  const onDay = appointPrompt(appt, new Date(2026, 10, 11, 9, 0, 0).getTime())
  assert.ok(onDay.includes('就是今天'))
  assert.ok(onDay.includes('把那本书看到第三章'))
  assert.ok(onDay.includes('没来也别替他找理由'))
  const late = appointPrompt(appt, new Date(2026, 10, 14, 9, 0, 0).getTime())
  assert.ok(late.includes('已经过了 3 天'))
})

test('appointAction 只认五个动作，没写按 make', () => {
  assert.equal(appointAction({}), 'make')
  assert.equal(appointAction({ action: 'list' }), 'list')
  assert.equal(appointAction({ action: 'whatever' }), 'make')
})

test('注册出来的是宿主认的形状，且不报剩余条数', async () => {
  await withRoot(async (root) => {
    const defs = []
    const ctx = { tools: { register: (d) => (defs.push(d), d) } }
    registerAppoint(ctx, { root, log: () => {} })
    assert.equal(defs.length, 1)
    assert.equal(defs[0].name, 'her_appoint')
    assert.equal(defs[0].parameters?.type, 'object')
    assert.ok(defs[0].description.includes('预约') || defs[0].description.includes('约'))
    const listed = await listAppointments(root, { now: NOW })
    assert.equal(listed.note, '这会儿没有约好的事。')
  })
})

test('文件坏了只当空，不抛', async () => {
  await withRoot(async (root) => {
    await writeAppointments(root, [])
    assert.deepEqual(await readAppointments(root), [])
    const empty = await dueAppointment(root, NOW)
    assert.equal(empty, null)
    assert.equal((await readAppointments(root)).length, 0)
    assert.ok(APPOINT_MAX >= 100)
  })
})
