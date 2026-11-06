/**
 * p1.test.mjs —— P1 收尾修复的回归测试
 *
 * 覆盖四件以前没有测试守住的事：
 *   1. rebuild() 真的能从事件流复原（以前只有一句注释声称"由 test 守住"）
 *   2. 日记走 diary/ 而不是事件流（否则 /events 会绕过 diary.visible 泄出去）
 *   3. seen 标记只在"窗口外"写（否则冷落检测永远测不出来）
 *   4. absence 的四种不落库情形 + 落库时带 days
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile, rm as rmf } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { registerCapture } from '../lib/capture.js'
import { readEvents, paths, writeConfig, rebuild, readState } from '../lib/store.js'
import { normalizeConfig, dateKey } from '../lib/settings.js'
import { deriveSelf } from '../lib/derive.js'
import { assess, detectAbsence, lastSeenAt, lastAbsenceEvent } from '../lib/absence.js'
import { withWake, enterWake, leaveWake, inWake } from '../lib/wakewin.js'

const DAY = 86_400_000

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fish-p1-'))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

function fakeCtx() {
  const regs = new Map()
  return {
    regs,
    tools: { register: (spec) => { regs.set(spec.name, spec); return () => regs.delete(spec.name) } },
  }
}

// ---------------------------------------------------------------- rebuild

test('rebuild：删掉 state.json 后能完全复原', async () => {
  await withRoot(async (root) => {
    const ctx = fakeCtx()
    registerCapture(ctx, { root })
    const tool = ctx.regs.get('growth_commit')
    // withWake 里写 = 不算"他来过"，免得顺手多出两条 seen meta 干扰计数
    await withWake(async () => {
      await tool.execute({ type: 'utterance', text: '我不太喜欢吵。' })
      await tool.execute({ type: 'refusal', text: '这个我不想说。' })
    })

    const first = await rebuild(root)
    assert.equal(first.events, 2, '两条事件，没有多余的 seen')
    assert.equal(first.beliefCount, 1)

    // 删掉快照，再复原
    await rmf(paths(root).state, { force: true })
    assert.equal(await readState(root), null)

    const second = await rebuild(root)
    for (const k of ['day', 'stage', 'stageName', 'name', 'beliefCount', 'absenceDays']) {
      assert.deepEqual(second[k], first[k], `${k} 复原后必须一致`)
    }
    assert.ok(second.builtAt, 'builtAt 要写')
    assert.deepEqual(second.needs, first.needs)
  })
})

test('state.json 是派生品：手改它不会改变她的判断', async () => {
  await withRoot(async (root) => {
    const ctx = fakeCtx()
    registerCapture(ctx, { root })
    await ctx.regs.get('growth_commit').execute({ type: 'utterance', text: '一句普通的话。' })
    await rebuild(root)

    // 伪造一个"好感度爆满"的快照
    await writeFile(paths(root).state, JSON.stringify({ beliefCount: 999, stage: 4 }), 'utf8')

    const { events } = await readEvents(root)
    const m = deriveSelf(events)
    assert.equal(m.beliefCount, 1, '真相源是事件流，快照被改不影响判断')
    assert.notEqual(m.stage, 4)
  })
})

// ---------------------------------------------------------------- 日记

test('日记写进 diary/，不进事件流（否则会绕过可见性设置）', async () => {
  await withRoot(async (root) => {
    await writeConfig(normalizeConfig({}), root)
    const ctx = fakeCtx()
    registerCapture(ctx, { root })
    const tool = ctx.regs.get('growth_commit')

    const out = await tool.execute({ type: 'diary', text: '今天没人来。屋子里很静。' })
    assert.equal(out.ok, true)

    // 文件真的存在
    const raw = await readFile(join(paths(root).diaryDir, `${dateKey()}.md`), 'utf8')
    assert.ok(raw.includes('今天没人来'))

    // 事件流里只有 meta 标记，没有日记正文
    const { events } = await readEvents(root)
    assert.equal(events.length, 1)
    assert.equal(events[0].type, 'meta')
    assert.ok(String(events[0].text).startsWith('diary:'))
    assert.ok(!JSON.stringify(events).includes('屋子里很静'), '日记正文绝不能出现在事件流里')
  })
})

test('日记返回值不暴露写给谁看 / 写在哪', async () => {
  await withRoot(async (root) => {
    await writeConfig(normalizeConfig({}), root)
    const ctx = fakeCtx()
    registerCapture(ctx, { root })
    const out = await ctx.regs.get('growth_commit').execute({ type: 'diary', text: '随便写一句。' })
    const dumped = JSON.stringify(out)
    for (const leak of ['visible', 'diary/', '.dsh-fish', 'root', '给你看']) {
      assert.ok(!dumped.includes(leak), `返回值不应含 ${leak}`)
    }
  })
})

test('日记关掉之后写不进去', async () => {
  await withRoot(async (root) => {
    await writeConfig(normalizeConfig({ diary: { enabled: false } }), root)
    const ctx = fakeCtx()
    registerCapture(ctx, { root })
    const out = await ctx.regs.get('growth_commit').execute({ type: 'diary', text: '想写但关了。' })
    assert.equal(out.ok, false)
    const { events } = await readEvents(root)
    assert.equal(events.length, 0)
  })
})

test('空的日记被拒，不落空文件', async () => {
  await withRoot(async (root) => {
    await writeConfig(normalizeConfig({}), root)
    const ctx = fakeCtx()
    registerCapture(ctx, { root })
    const out = await ctx.regs.get('growth_commit').execute({ type: 'diary', text: '   ' })
    assert.equal(out.ok, false)
  })
})

// ---------------------------------------------------------------- seen

test('窗口外写东西 → 记一条 seen；窗口内不记', async () => {
  await withRoot(async (root) => {
    await writeConfig(normalizeConfig({}), root)
    const ctx = fakeCtx()
    registerCapture(ctx, { root })
    const tool = ctx.regs.get('growth_commit')

    // 窗口内（模拟定时器叫醒她）
    await withWake(async () => {
      await tool.execute({ type: 'utterance', text: '我自己想到的。' })
    })
    let { events } = await readEvents(root)
    assert.equal(events.filter((e) => e.type === 'meta' && String(e.text).startsWith('seen:')).length, 0)
    assert.equal(inWake(), false, 'withWake 退出后窗口必须关掉')

    // 窗口外（他跟她说话）
    await tool.execute({ type: 'utterance', text: '他问我了。' })
    ;({ events } = await readEvents(root))
    assert.equal(events.filter((e) => e.type === 'meta' && String(e.text).startsWith('seen:')).length, 1)
  })
})

test('withWake 抛异常也把窗口关上', async () => {
  enterWake()
  enterWake()
  leaveWake()
  assert.equal(inWake(), true)
  leaveWake()
  assert.equal(inWake(), false)
  leaveWake()
  assert.equal(inWake(), false, '减到 0 以下要夹住')

  await assert.rejects(() => withWake(async () => { throw new Error('boom') }))
  assert.equal(inWake(), false)
})

// ---------------------------------------------------------------- absence

function seenEvent(ms) {
  return { id: 'ev_x', type: 'meta', text: `seen:${new Date(ms).toISOString()}`, ts: new Date(ms).toISOString() }
}

test('absence：从没联系过（刚装）不判冷落', () => {
  const a = assess([], Date.now(), { afterDays: 2 })
  assert.equal(a.absent, false)
  assert.equal(a.reason, 'no-contact-yet')
})

test('absence：没到阈值不判，到了就判', () => {
  const now = Date.now()
  const ev = [seenEvent(now - 1 * DAY)]
  assert.equal(assess(ev, now, { afterDays: 2 }).reason, 'within-threshold')
  assert.equal(assess(ev, now, { afterDays: 1 }).absent, true)
})

test('absence：他回来过一次，之后又消失够久，是新的一次冷落', () => {
  const now = Date.now()
  const at = (days) => new Date(now - days * 86400000).toISOString()
  const seenAt = (days) => ({ id: `ev_s${days}`, type: 'meta', text: `seen:${at(days)}`, ts: at(days) })
  const abs = { id: 'ev_a', type: 'absence', text: '他有 3 天没出现。', days: 3, ts: at(38) }
  // 回来才 1 天：这次冷落已经结束，不算新的
  assert.equal(assess([seenAt(41), abs, seenAt(1)], now).reason, 'returned')
  // 回来之后又 30 天没影：要能再记
  const again = assess([seenAt(41), abs, seenAt(30)], now)
  assert.equal(again.absent, true)
  assert.equal(again.days, 30)
})

test('absence：同一次冷落不重复写；他回来之后才算结束', () => {
  const now = Date.now()
  const seenAt = now - 5 * DAY
  const abs = { id: 'ev_a', type: 'absence', text: '他有 3 天没出现。', days: 3, ts: new Date(now - 2 * DAY).toISOString() }

  // seen 早于 absence → 还是同一次冷落
  assert.equal(assess([seenEvent(seenAt), abs], now, { afterDays: 2 }).reason, 'already-recorded')

  // seen 晚于 absence → 他回来了
  const laterSeen = now - 1 * DAY
  assert.equal(assess([seenEvent(laterSeen), abs], now, { afterDays: 2 }).reason, 'returned')
})

test('detectAbsence 落库时带上按毫秒算的 days', async () => {
  await withRoot(async (root) => {
    await writeConfig(normalizeConfig({ absenceAfterDays: 2 }), root)
    const now = Date.now()

    // 手工塞一条 4 天前的 seen（走 appendEvent 会被打上当前 ts，这里直接写文件）
    const line = JSON.stringify({ ...seenEvent(now - 4 * DAY), id: 'ev_01J0000000000000000000000A', day: 1, stage: 1, source: 'system', refs: [], verdict: null, confidence: 0.5, flags: [] })
    const { mkdir, appendFile } = await import('node:fs/promises')
    await mkdir(root, { recursive: true })
    await appendFile(paths(root).events, line + '\n', 'utf8')

    const r = await detectAbsence(root, { now })
    assert.equal(r.written, true)
    assert.ok(r.days >= 3, `应该算出 3–4 天，实际 ${r.days}`)

    const { events } = await readEvents(root)
    const abs = lastAbsenceEvent(events)
    assert.ok(abs, '必须落一条 absence')
    assert.equal(abs.type, 'absence')
    assert.equal(abs.source, 'system')
    assert.equal(abs.days, r.days, 'days 必须写进事件')

    // 第二次调用不重复写
    const r2 = await detectAbsence(root, { now: now + 1000 })
    assert.equal(r2.written, false)
    assert.equal((await readEvents(root)).events.filter((e) => e.type === 'absence').length, 1)
  })
})

test('deriveSelf 优先用 absence.days，不用 day 差', async () => {
  // 同一天里写两条 absence，day 差为 0 —— 只有 days 字段能救
  const now = Date.now()
  const seed = { id: 'ev_01J0000000000000000000000S', type: 'seed', text: '起点。', ts: new Date(now - 10 * DAY).toISOString(), day: 1, stage: 1 }
  const abs = {
    id: 'ev_01J0000000000000000000001A',
    type: 'absence',
    text: '他有 6 天没出现。',
    days: 6,
    day: 11,
    stage: 1,
    ts: new Date(now - 1 * DAY).toISOString(),
    refs: [], verdict: null, confidence: 0.5, flags: [], source: 'system',
  }
  const m = deriveSelf([seed, abs])
  assert.equal(m.absenceDays, 6, 'days 字段优先于 day 差（day 差会算成 0）')
})

test('lastSeenAt 取最大的 seen 时刻', () => {
  const now = Date.now()
  const evs = [seenEvent(now - 3 * DAY), seenEvent(now - 1 * DAY), seenEvent(now - 2 * DAY)]
  const at = lastSeenAt(evs)
  assert.equal(at, Date.parse(new Date(now - 1 * DAY).toISOString()))
})

// 2026-11-02（用户 m01280）：侧栏聊天那条路不写 seen:，冷落检测就看不见他来过。
// 两处补上：turns.js 结账时写 seen:（主证据），lastSeenAt 认 heard（兜底）。

test('lastSeenAt 也认 heard —— 她真说过话就是一种「他来过」', () => {
  const now = Date.now()
  const heard = { id: 'ev_h', type: 'heard', text: '他说过的某一句', ts: new Date(now - 1 * DAY).toISOString() }
  const evs = [seenEvent(now - 5 * DAY), heard]
  assert.equal(lastSeenAt(evs), Date.parse(heard.ts))
})

test('lastSeenAt 认 heard 但**不**认 utterance —— 唤醒里写的 utterance 不算他来过', () => {
  const now = Date.now()
  const evs = [
    seenEvent(now - 5 * DAY),
    { id: 'ev_u', type: 'utterance', text: '醒了，外面在下雨。', ts: new Date(now - 1000).toISOString() },
  ]
  assert.equal(lastSeenAt(evs), Date.parse(new Date(now - 5 * DAY).toISOString()), '只有 seen 那一条算数')
})

test('他真回来过时，同一份事件不再判冷落（heard 兜住旧档）', () => {
  const now = Date.now()
  const abs = { id: 'ev_a', type: 'absence', text: '他有 5 天没出现。', days: 5, ts: new Date(now - 4 * DAY).toISOString() }
  const evs = [seenEvent(now - 10 * DAY), abs, { id: 'ev_h', type: 'heard', text: '嗯。', ts: new Date(now - 1 * DAY).toISOString() }]
  assert.equal(assess(evs, now, { afterDays: 2 }).reason, 'returned')
})

test('absence-reject: 驳回掉的 absence 不再进派生（历史误记只靠追加排除）', () => {
  const now = Date.now()
  const seed = { id: 'ev_01J0000000000000000000000S', type: 'seed', text: '起点。', ts: new Date(now - 10 * DAY).toISOString(), day: 1, stage: 1 }
  const abs = {
    id: 'ev_01M6ECRVNAR2F6ACX2FRV07YJW',
    type: 'absence',
    text: '那个人有 2 天没出现，也没说去哪。',
    days: 2,
    day: 8,
    stage: 1,
    ts: new Date(now - 1 * DAY).toISOString(),
    refs: [], verdict: null, confidence: 0.5, flags: [], source: 'system',
  }
  const reject = { id: 'ev_r', type: 'meta', text: `absence-reject:${abs.id}`, ts: new Date(now - 1 * DAY).toISOString(), day: 8, stage: 1 }

  assert.equal(deriveSelf([seed, abs]).absenceDays, 2, '没驳回时要算进去')

  const m = deriveSelf([seed, abs, reject])
  assert.equal(m.absenceDays, 0, '驳回之后不该再是「冷落 2 天」')
  assert.equal(m.lastAbsence, null)
})

// 2026-11-04（issue #24）：冷落是否结束，derive 与 absence.js 口径必须一致。
//
// 以前 derive 只认 reunion 事件，而 absence.js 的 assess() 认 seen / heard。
// 结果是他明明回来了（甚至刚说过话），persona 还是每天念「他有 N 天没出现」，
// 而且除了她恰好写一条 reunion 之外没有任何自动恢复路径。
test('absence 之后他来过（seen）就不再算冷落（issue #24）', () => {
  const now = Date.now()
  const seed = { id: 'ev_s', type: 'seed', text: '起点。', ts: new Date(now - 10 * DAY).toISOString(), day: 1, stage: 1, source: 'system' }
  const abs = {
    id: 'ev_a24', type: 'absence', text: '那个人有 2 天没出现。', days: 2,
    ts: new Date(now - 5 * DAY).toISOString(), day: 2, stage: 1, source: 'system',
  }
  assert.equal(deriveSelf([seed, abs], { now }).absenceDays, 2, '他确实没回来时要算冷落')

  const seen = {
    id: 'ev_seen24', type: 'meta', text: `seen:${new Date(now - 1 * DAY).toISOString()}`,
    ts: new Date(now - 1 * DAY).toISOString(), day: 6, stage: 1, source: 'system',
  }
  assert.equal(deriveSelf([seed, abs, seen], { now }).absenceDays, 0, 'seen 在 absence 之后 → 冷落结束')
})

test('absence 之后他来过（heard 兜底）也不再算冷落（issue #24）', () => {
  const now = Date.now()
  const seed = { id: 'ev_s', type: 'seed', text: '起点。', ts: new Date(now - 10 * DAY).toISOString(), day: 1, stage: 1, source: 'system' }
  const abs = {
    id: 'ev_a24b', type: 'absence', text: '那个人有 3 天没出现。', days: 3,
    ts: new Date(now - 5 * DAY).toISOString(), day: 2, stage: 1, source: 'system',
  }
  const heard = { id: 'ev_h24', type: 'heard', text: '嗯。', ts: new Date(now - 1 * DAY).toISOString(), day: 6, stage: 1, source: 'system' }
  assert.equal(deriveSelf([seed, abs, heard], { now }).absenceDays, 0, '侧栏那段没写 seen 的档靠 heard 兜住')
})

test('absence 之前的 seen 不算「他回来过」（issue #24）', () => {
  const now = Date.now()
  const seed = { id: 'ev_s', type: 'seed', text: '起点。', ts: new Date(now - 10 * DAY).toISOString(), day: 1, stage: 1, source: 'system' }
  const older = {
    id: 'ev_seenold', type: 'meta', text: `seen:${new Date(now - 7 * DAY).toISOString()}`,
    ts: new Date(now - 7 * DAY).toISOString(), day: 1, stage: 1, source: 'system',
  }
  const abs = {
    id: 'ev_a24c', type: 'absence', text: '那个人有 2 天没出现。', days: 2,
    ts: new Date(now - 5 * DAY).toISOString(), day: 2, stage: 1, source: 'system',
  }
  assert.equal(deriveSelf([seed, older, abs], { now }).absenceDays, 2, '时间顺序不能反着用')
})

test('唤醒里写的 utterance 不算他来过，absenceDays 不归零（issue #24）', () => {
  const now = Date.now()
  const seed = { id: 'ev_s', type: 'seed', text: '起点。', ts: new Date(now - 10 * DAY).toISOString(), day: 1, stage: 1, source: 'system' }
  const abs = {
    id: 'ev_a24d', type: 'absence', text: '那个人有 2 天没出现。', days: 2,
    ts: new Date(now - 5 * DAY).toISOString(), day: 2, stage: 1, source: 'system',
  }
  const utt = { id: 'ev_u24', type: 'utterance', text: '醒了。', ts: new Date(now - 1 * DAY).toISOString(), day: 6, stage: 1, source: 'her' }
  assert.equal(deriveSelf([seed, abs, utt], { now }).absenceDays, 2, '定时器叫醒她自己想事不算他来过')
})

test('derive 与 absence.js 对「他回来了」给出同一个答案（issue #24）', () => {
  const now = Date.now()
  const seed = { id: 'ev_s', type: 'seed', text: '起点。', ts: new Date(now - 10 * DAY).toISOString(), day: 1, stage: 1, source: 'system' }
  const abs = {
    id: 'ev_a24e', type: 'absence', text: '那个人有 4 天没出现。', days: 4,
    ts: new Date(now - 5 * DAY).toISOString(), day: 2, stage: 1, source: 'system',
  }
  const seen = {
    id: 'ev_seen24e', type: 'meta', text: `seen:${new Date(now - 1 * DAY).toISOString()}`,
    ts: new Date(now - 1 * DAY).toISOString(), day: 6, stage: 1, source: 'system',
  }
  const evs = [seed, abs, seen]
  assert.equal(assess(evs, now, { afterDays: 2 }).reason, 'returned')
  assert.equal(deriveSelf(evs, { now }).absenceDays, 0, '两层不能各说各话')
})
