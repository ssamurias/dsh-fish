/**
 * appoint-clock.test.mjs —— 定到几点的约定（2026-11-18，issue #149）
 *
 * 守七件事：
 *   1. 时刻只收 08:00 这种 24 小时制，算的是本地时刻，不是 UTC；
 *   2. 带时刻的约定今天不约（约到今天三点，那条提醒已经过了）；
 *   3. 没到点不算到期，过了点才算；同一天两个时刻各自叫各自的；
 *   4. 叫过就记下，别在剩下的十几分钟里反复叫她；
 *   5. 到点那段只写事件里真有的：他答应了 / 以后再说 / 还没答 / 没问过；
 *   6. 宽限 5 分钟、忙、刚叫过，都只是等一等；超出宽限忙也照叫；
 *   7. 约定确认卡不占「替自己争一件事」的额度，一天最多两张。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  isTime,
  momentOf,
  lateMinutesOf,
  makeAppointment,
  readAppointments,
  openAppointments,
  dueAppointments,
  markNotified,
  listAppointments,
  appointPrompt,
} from '../lib/appoint.js'
import { quotaOf, appointAskQuotaOf, askForAppoint, APPOINT_ASK_PER_DAY } from '../lib/ask.js'
import { appointWakePlan, appointAnswerOf, lastWakeAtOf } from '../lib/scheduler.js'

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-fish-appoint-clock-'))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

// 本地时间。日子只写日期键，时刻写 HH:MM。
const at = (y, m, d, h, min = 0) => new Date(y, m - 1, d, h, min, 0, 0).getTime()
const NOW = at(2026, 11, 8, 10, 0)

test('时刻只收 08:00 这种写法', () => {
  assert.equal(isTime('08:00'), true)
  assert.equal(isTime('23:59'), true)
  assert.equal(isTime('00:00'), true)
  assert.equal(isTime('8:00'), false)
  assert.equal(isTime('24:00'), false)
  assert.equal(isTime('08:60'), false)
  assert.equal(isTime(''), false)
  assert.equal(isTime(null), false)
})

test('到点的瞬间按本地时间算，不按 UTC', () => {
  const ms = momentOf({ due: '2026-11-19', time: '08:00' })
  const d = new Date(ms)
  assert.equal(d.getFullYear(), 2026)
  assert.equal(d.getMonth(), 10)
  assert.equal(d.getDate(), 19)
  assert.equal(d.getHours(), 8)
  assert.equal(d.getMinutes(), 0)
})

test('晚了多少分钟：没到点是 null，过了向下取整', () => {
  const appt = { due: '2026-11-19', time: '08:00' }
  assert.equal(lateMinutesOf(appt, at(2026, 11, 19, 7, 59)), null)
  assert.equal(lateMinutesOf(appt, at(2026, 11, 19, 8, 0)), 0)
  assert.equal(lateMinutesOf(appt, at(2026, 11, 19, 8, 7)), 7)
  assert.equal(lateMinutesOf({ due: '2026-11-19' }, at(2026, 11, 20, 9, 0)), null)
})

test('带时刻的约定：今天不约、格式要写对、明天可以', async () => {
  await withRoot(async (root) => {
    const today = await makeAppointment(root, { what: '说一声早安', due: '2026-11-08', time: '08:00', now: NOW })
    assert.equal(today.ok, false)
    assert.match(today.note, /明天/)
    const bad = await makeAppointment(root, { what: '说一声早安', due: '2026-11-09', time: '8:00', now: NOW })
    assert.equal(bad.ok, false)
    assert.match(bad.note, /08:00/)
    const ok = await makeAppointment(root, { what: '说一声早安', due: '2026-11-09', time: '08:00', now: NOW })
    assert.equal(ok.ok, true)
    const [saved] = await readAppointments(root)
    assert.equal(saved.time, '08:00')
  })
})

test('同一天同一件事，时刻不同算两条', async () => {
  await withRoot(async (root) => {
    const a = await makeAppointment(root, { what: '说一声早安', due: '2026-11-09', time: '08:00', now: NOW })
    const b = await makeAppointment(root, { what: '说一声早安', due: '2026-11-09', time: '08:30', now: NOW })
    assert.equal(a.ok, true)
    assert.equal(b.ok, true)
    assert.notEqual(a.id, b.id)
  })
})

test('没到点不算到期，过了点才算；叫过就不再给', async () => {
  await withRoot(async (root) => {
    await makeAppointment(root, { what: '说一声早安', due: '2026-11-19', time: '08:00', now: NOW })
    const before = await dueAppointments(root, at(2026, 11, 19, 7, 59))
    assert.equal(before.length, 0)
    const due = await dueAppointments(root, at(2026, 11, 19, 8, 1))
    assert.equal(due.length, 1)
    assert.equal(due[0].time, '08:00')
    await markNotified(root, due[0].id, at(2026, 11, 19, 8, 1), { lateMinutes: 1 })
    const again = await dueAppointments(root, at(2026, 11, 19, 8, 30))
    assert.equal(again.length, 0)
    const noted = (await readAppointments(root))[0]
    assert.equal(noted.lateMinutes, 1)
  })
})

test('预约簿按日子、时刻排，行里带时刻和晚了几分钟', async () => {
  await withRoot(async (root) => {
    await makeAppointment(root, { what: '晚一点的那件事', due: '2026-11-10', time: '09:00', now: NOW })
    await makeAppointment(root, { what: '早一点的那件事', due: '2026-11-09', time: '08:00', now: NOW })
    const open = await openAppointments(await readAppointments(root), { now: NOW })
    assert.deepEqual(open.map((a) => a.what), ['早一点的那件事', '晚一点的那件事'])
    const due = await dueAppointments(root, at(2026, 11, 9, 8, 3))
    await markNotified(root, due[0].id, at(2026, 11, 9, 8, 3), { lateMinutes: 3 })
    const listed = await listAppointments(root, { now: at(2026, 11, 9, 8, 10) })
    assert.match(listed.text, /08:00/)
    assert.match(listed.text, /晚 3 分钟叫的/)
  })
})

test('到点那段：准点、宽限内、晚了十分钟、晚了一小时，写法不一样', () => {
  const appt = { due: '2026-11-19', time: '08:00', what: '说一声早安' }
  const sharp = appointPrompt(appt, at(2026, 11, 19, 8, 0))
  assert.match(sharp, /08:00/)
  assert.ok(!sharp.includes('晚了'))
  const grace = appointPrompt(appt, at(2026, 11, 19, 8, 4))
  assert.ok(!grace.includes('晚了'))
  const late = appointPrompt(appt, at(2026, 11, 19, 8, 20))
  assert.match(late, /08:20/)
  assert.match(late, /晚了 20 分钟/)
  const missed = appointPrompt(appt, at(2026, 11, 19, 9, 30))
  assert.match(missed, /没开着/)
  assert.match(missed, /09:30/)
})

test('到点那段只说真有的：答应了 / 以后再说 / 还没答 / 过时没答 / 没问过', () => {
  const appt = { due: '2026-11-19', time: '08:00', what: '说一声早安' }
  const now = at(2026, 11, 19, 8, 0)
  const yes = appointPrompt(appt, now, { answer: { verdict: 'approve' } })
  assert.match(yes, /答应了/)
  const later = appointPrompt(appt, now, { answer: { verdict: 'later' } })
  assert.match(later, /以后再说/)
  assert.ok(!later.includes('答应了这件事'))
  const pending = appointPrompt(appt, now, { answer: { verdict: 'pending' } })
  assert.match(pending, /还没答/)
  const expired = appointPrompt(appt, now, { answer: { verdict: 'unanswered' } })
  assert.match(expired, /没人答/)
  const never = appointPrompt({ ...appt, askId: null }, now, { answer: null })
  assert.match(never, /对过口/)
})

test('到点那段不许替他说「你不在」，也不替她答应', () => {
  const appt = { due: '2026-11-19', time: '08:00', what: '说一声早安' }
  const text = appointPrompt(appt, at(2026, 11, 19, 8, 0), { answer: { verdict: 'approve' } })
  assert.ok(!text.includes('你不在'))
  assert.ok(!text.includes('他不在'))
  assert.match(text, /做不做、怎么做，你自己定/)
})

test('要不要现在叫：没到等、宽限内忙就等、超出宽限忙也照叫', () => {
  const appt = { due: '2026-11-18', time: '08:00' }
  const now = at(2026, 11, 18, 8, 0)
  assert.equal(appointWakePlan({ now: now - 60_000, appt }).action, 'wait')
  assert.equal(appointWakePlan({ now, appt }).action, 'wake')
  assert.equal(appointWakePlan({ now: at(2026, 11, 18, 8, 3), appt, busy: true }).action, 'wait')
  assert.equal(appointWakePlan({ now: at(2026, 11, 18, 8, 3), appt, lastWakeAt: at(2026, 11, 18, 8, 2) }).action, 'wait')
  assert.equal(appointWakePlan({ now: at(2026, 11, 18, 8, 20), appt, busy: true }).action, 'wake')
  assert.equal(appointWakePlan({ now, appt, retryBlocked: true }).action, 'wait')
  assert.equal(appointWakePlan({ now, appt: { due: '2026-11-18' } }).action, 'skip')
})

test('他答过没有：没问过 / 还没答 / 答了 / 过时没答', () => {
  const appt = { due: '2026-11-19', time: '08:00', id: 'ap1' }
  const asked = {
    id: 'q1',
    type: 'ask',
    ts: '2026-11-18T12:00:00.000Z',
    ask: { kind: 'appoint', appointId: 'ap1', subject: 'ap1' },
  }
  const now = at(2026, 11, 18, 20, 5)
  assert.equal(appointAnswerOf([], appt, now), null)
  assert.equal(appointAnswerOf([asked], appt, now).verdict, 'pending')
  const answered = {
    id: 'a1',
    type: 'answer',
    ts: '2026-11-18T12:30:00.000Z',
    ask: { askId: 'q1', verdict: 'approve', reason: '', via: 'card' },
  }
  const got = appointAnswerOf([asked, answered], appt, now)
  assert.equal(got.verdict, 'approve')
  assert.equal(got.via, 'card')
  const old = { ...asked, ts: '2026-11-16T12:00:00.000Z' }
  const stale = appointAnswerOf([old], appt, now)
  assert.equal(stale.verdict, 'unanswered')
})

test('最近一次叫醒的时间从事件流里读，读不到就是 0', () => {
  const events = [
    { id: 'e1', type: 'meta', text: 'wake:2026-11-18 appoint', ts: '2026-11-18T00:00:00.000Z' },
    { id: 'e2', type: 'meta', text: 'wake:2026-11-17 20:30', ts: '2026-11-17T12:30:00.000Z' },
  ]
  assert.equal(lastWakeAtOf(events), Date.parse('2026-11-18T00:00:00.000Z'))
  assert.equal(lastWakeAtOf([]), 0)
})

test('约定确认卡不占那三次自决额度，一天最多两张', () => {
  // 按本地时刻造时间戳：日期键也按本地算，别在 UTC-5 落到前一天（2026-11-18 教训）。
  const local = (h) => new Date(2026, 10, 18, h, 0, 0).toISOString()
  const mk = (id, kind, ts) => ({ id, type: 'ask', ts, ask: { kind, subject: 'x', appointId: kind === 'appoint' ? `ap${id}` : null } })
  const events = [
    mk('p1', 'other', local(9)),
    mk('p2', 'appoint', local(10)),
    mk('p3', 'appoint', local(11)),
  ]
  const dk = '2026-11-18'
  const q = quotaOf(events, { now: at(2026, 11, 18, 12, 0), dk })
  assert.equal(q.day, 1)
  assert.equal(q.ok, false)
  assert.equal(appointAskQuotaOf(events, { now: at(2026, 11, 18, 12, 0), dk }).ok, false)
  const one = appointAskQuotaOf([events[1]], { now: at(2026, 11, 18, 12, 0), dk })
  assert.equal(one.ok, true)
  assert.equal(APPOINT_ASK_PER_DAY, 2)
  assert.equal(askForAppoint(events).size, 2)
})

test('存量事件没有 appointId 时，靠 subject 也认得出是哪条约定（2026-11-21，用户 m02695）', () => {
  // schema 曾经把 value.appointId 丢掉，磁盘上那些老 ask 只留下 subject。
  const legacy = (id, appointId) => ({ id, type: 'ask', ts: '2026-11-18T12:00:00.000Z', ask: { kind: 'appoint', subject: appointId } })
  const events = [legacy('q1', 'ap1'), legacy('q2', 'ap2'), legacy('q3', 'ap3')]
  const m = askForAppoint(events)
  assert.equal(m.size, 3)
  assert.equal(m.get('ap1').id, 'q1')
  assert.equal(m.get('ap3').id, 'q3')
})
