/**
 * hear.test.mjs —— 旁听（A2，2026-10-30 用户 m00112）与回忆检索的排序变化
 *
 * 覆盖：
 *   1. 从一段话里只挑一句原话；太短不记；超长截断
 *   2. 每 hearEvery 轮才写一条；0 = 不记
 *   3. 她写不了 heard（只有系统侧能写）——旁听的凭据价值全靠这一点
 *   4. 她翻回忆时，heard 明确写成「他说：」，不会被当成自己说过的话
 *   5. 默认翻全部时间（30 天以前也翻得到）；kind 只看一类
 *   6. 显著性加权：被固化/被检验过的条目排在同样字面命中前面
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { pickHearSentence, hearTurn, rememberGroupWord, HEAR_SNIPPET, HEAR_MIN_CHARS } from '../lib/hear.js'
import { hearMark, bumpTurns } from '../lib/home.js'
import { readEvents } from '../lib/store.js'
import { validateEvent, isContactEvent } from '../lib/schema.js'
import { searchEvents, renderRecall, RECALL_LIMIT, RECALL_DAYS } from '../lib/recall.js'

const DAY = 86_400_000

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fish-hear-'))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

function at(daysAgo) {
  return new Date(Date.now() - daysAgo * DAY).toISOString()
}

// ---------------------------------------------------------------- 挑句子

test('旁听：只留最长的一句，句号问号都切掉', () => {
  const s = pickHearSentence('嗯。今天我在想一件事，想了很久。你呢？')
  assert.equal(s, '今天我在想一件事，想了很久')
})

test('旁听：太短的话不记', () => {
  assert.equal(pickHearSentence('嗯。'), '')
  assert.equal(pickHearSentence('好'), '')
  assert.ok(HEAR_MIN_CHARS >= 2)
})

test('旁听：太长截断到上限', () => {
  const s = pickHearSentence('我' + '很'.repeat(500) + '。')
  assert.ok(s.length <= HEAR_SNIPPET)
  assert.ok(s.endsWith('…'))
})

// ---------------------------------------------------------------- 写事件

test('旁听：不到轮数不写，到了才写一条 heard', async () => {
  await withRoot(async (root) => {
    const cfg = { memory: { hearEvery: 3 } }
    const text = '今天我在想一件事，想了很久'
    assert.equal((await hearTurn(root, { text, turns: 1, day: 2, stage: 1, config: cfg })).written, false)
    assert.equal((await hearTurn(root, { text, turns: 2, day: 2, stage: 1, config: cfg })).written, false)
    const ok = await hearTurn(root, { text, turns: 3, day: 2, stage: 1, config: cfg })
    assert.equal(ok.written, true)
    assert.ok(ok.id)

    const { events } = await readEvents(root)
    const heard = events.filter((e) => e.type === 'heard')
    assert.equal(heard.length, 1)
    assert.equal(heard[0].source, 'system')
    assert.equal(heard[0].text, '今天我在想一件事，想了很久')
    assert.equal(heard[0].day, 2)
  })
})

test('旁听：装上时 turns 已经过去好几轮，下一轮就记（本机 0.8.0 的现场）', async () => {
  await withRoot(async (root) => {
    const cfg = { memory: { hearEvery: 3 } }
    const text = '今天我在想一件事，想了很久'
    // 真实链路里 bumpTurns 先跑（记轮次），home.json 一定存在；hearAt 只写在已有的 home.json 上。
    await bumpTurns(root, 1)
    // 0.8.0 装上旁听时本机 turns 已经 4。旧写法（turns % every === 0）要等到 6 才记，
    // 中间这段时间 events.jsonl 里一条 heard 都没有，看上去像功能没生效。
    assert.equal((await hearTurn(root, { text, turns: 4, day: 6, stage: 1, config: cfg })).written, true)
    // 记过一次之后重新数：4 → 7 之间不再记
    assert.equal((await hearTurn(root, { text, turns: 5, day: 6, stage: 1, config: cfg })).written, false)
    assert.equal((await hearTurn(root, { text, turns: 6, day: 6, stage: 1, config: cfg })).written, false)
    assert.equal((await hearTurn(root, { text, turns: 7, day: 6, stage: 1, config: cfg })).written, true)

    const { events } = await readEvents(root)
    assert.equal(events.filter((e) => e.type === 'heard').length, 2)
  })
})

test('旁听：轮次标记记在 home.json 的 hearAt 上，普通记账不会把它冲掉', async () => {
  await withRoot(async (root) => {
    const cfg = { memory: { hearEvery: 3 } }
    const text = '今天我在想一件事，想了很久'
    await bumpTurns(root, 1) // 先让 home.json 存在（真实链路同此）
    await hearTurn(root, { text, turns: 3, day: 2, stage: 1, config: cfg })
    assert.equal(await hearMark(root), 3)
    // bumpTurns 写回 home.json 时用的是 `{...saved, turns}`，不能把 hearAt 丢掉
    await bumpTurns(root, 1)
    assert.equal(await hearMark(root), 3)
    assert.equal((await hearTurn(root, { text, turns: 4, day: 2, stage: 1, config: cfg })).written, false)
  })
})

test('旁听：hearEvery=0 就是完全不记', async () => {
  await withRoot(async (root) => {
    const r = await hearTurn(root, { text: '今天我在想一件事，想了很久', turns: 30, day: 5, stage: 1, config: { memory: { hearEvery: 0 } } })
    assert.equal(r.written, false)
    const { events } = await readEvents(root)
    assert.equal(events.filter((e) => e.type === 'heard').length, 0)
  })
})

test('旁听：她不能自己伪造一条「他说过」', () => {
  const ok = validateEvent({ type: 'heard', text: '今天我在想一件事' }, { day: 1, stage: 1, source: 'system' })
  assert.equal(ok.type, 'heard')
  let err = null
  try {
    validateEvent({ type: 'heard', text: '今天我在想一件事' }, { day: 1, stage: 1, source: 'tool' })
  } catch (e) {
    err = e
  }
  assert.ok(err, 'tool 侧写 heard 必须被拒')
  assert.equal(err.code, 'NOT_HER_TYPE')
})

// ---------------------------------------------------------------- 翻回忆

test('旁听：她翻到时看到的是「他说：」，不是自己的口吻', () => {
  const rows = [{
    id: 'ev_1', date: '2026-10-20', ago: 9, type: 'heard', text: '今天我在想一件事，想了很久',
  }]
  const out = renderRecall(rows)
  assert.match(out, /他说：今天我在想一件事/)
  assert.match(out, /9 天前/)
  assert.match(out, /（ev_1）/)
})

test('回忆：默认翻全部时间，一个月以前的也翻得到', () => {
  assert.equal(RECALL_DAYS, 0, '0 = 全部')
  const now = Date.now()
  const events = [{ id: 'old', type: 'utterance', ts: at(200), text: '很久以前的评论' }]
  const { rows } = searchEvents(events, '评论', { now })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, 'old')
  assert.ok(rows[0].ago >= 199)
})

test('回忆：kind 只看他听过的话', () => {
  const now = Date.now()
  const events = [
    { id: 'a', type: 'utterance', ts: at(1), text: '评论这件事我说不好' },
    { id: 'b', type: 'heard', ts: at(2), text: '你在评论里那句话我喜欢' },
  ]
  const all = searchEvents(events, '评论', { now })
  assert.equal(all.rows.length, 2)
  const onlyHeard = searchEvents(events, '评论', { now, kind: 'heard' })
  assert.equal(onlyHeard.rows.length, 1)
  assert.equal(onlyHeard.rows[0].id, 'b')
})

test('回忆：固化/被检验过的排在同样字面命中的前面', () => {
  const now = Date.now()
  const events = [
    { id: 'plain', type: 'utterance', ts: at(0), text: '评论' },
    { id: 'solid', type: 'utterance', ts: at(10), text: '评论' },
    { id: 't', type: 'test', ts: at(1), text: '检验一下', refs: ['plain'] },
  ]
  // 不加权：新的在前
  assert.equal(searchEvents(events, '评论', { now, weigh: false }).rows[0].id, 'plain')
  // 加权：solid 先
  const { rows } = searchEvents(events, '评论', { now, solidIds: new Set(['solid']) })
  assert.equal(rows[0].id, 'solid')
})

test('回忆：条数上限是 8', () => {
  assert.equal(RECALL_LIMIT, 8)
  const now = Date.now()
  const events = Array.from({ length: 30 }, (_, i) => ({
    id: `x${i}`, type: 'utterance', ts: at(i), text: `评论第 ${i} 条`,
  }))
  assert.equal(searchEvents(events, '评论', { now }).rows.length, RECALL_LIMIT)
})

// ---------------------------------------------------------------- 2026-11-04 群反馈第二、三条

test('回忆：时间到分钟，不再只有日期', () => {
  const rows = [{
    id: 'ev_1', date: '2026-11-04', clock: '18:10', ago: 0, type: 'utterance', text: '今天下雨。',
  }]
  const out = renderRecall(rows)
  assert.match(out, /- 2026-11-04 18:10｜今天下雨。/)
})

test('回忆：同一天的两句话分得出先后', () => {
  const now = Date.now()
  const t0 = now - 3_600_000
  const t1 = now - 60_000
  const events = [
    { id: 'early', type: 'utterance', ts: new Date(t0).toISOString(), text: '这句在后' },
    { id: 'late', type: 'utterance', ts: new Date(t1).toISOString(), text: '这句在前' },
  ]
  const { rows } = searchEvents(events, '这句', { now, weigh: false })
  assert.ok(rows[0].clock && rows[1].clock, '每条都要有时分')
  assert.notEqual(rows[0].clock, rows[1].clock)
})

test('回忆：改口关系要写出来，别让她翻到 revise 跟普通一句长得一样', () => {
  const rows = [{
    id: 'ev_9', date: '2026-11-04', clock: '09:00', ago: 0, type: 'revise',
    text: '我之前说错了。', verdict: 'refuted', refs: ['ev_1'],
  }]
  const out = renderRecall(rows)
  assert.match(out, /推翻了 ev_1/)
  assert.match(out, /那是更早说的/)
  // refined 用另一套说法
  const refined = renderRecall([{ ...rows[0], verdict: 'refined' }])
  assert.match(refined, /修正了 ev_1/)
})

test('回忆：聊天里说的要标出来，跟她自己写下的分开', () => {
  const rows = [
    { id: 'a', date: '2026-11-04', clock: '10:00', ago: 0, type: 'utterance', text: '这是我记下的。' },
    { id: 'b', date: '2026-11-04', clock: '10:10', ago: 0, type: 'utterance', text: '这是随口说的。', chatOnly: true },
  ]
  const out = renderRecall(rows)
  assert.match(out, /- 2026-11-04 10:00｜这是我记下的。/)
  assert.match(out, /- 2026-11-04 10:10｜这是随口说的。｜聊天里说的/)
  assert.ok(!out.includes('这是我记下的。｜聊天里说的'), '认领过的不该被标成聊天里说的')
})

test('回忆：认领过的排在聊天原话前面（同样字面命中）', () => {
  const now = Date.now()
  const events = [
    // 聊天原话更新，但没认领
    { id: 'chat', type: 'utterance', ts: at(0), text: '评论这件事', flags: ['uncommitted'] },
    // 认领过的更旧
    { id: 'mine', type: 'utterance', ts: at(5), text: '评论这件事' },
  ]
  const { rows } = searchEvents(events, '评论', { now })
  assert.equal(rows[0].id, 'mine', '认领过的那个要先出来')
})

test('回忆：认领的 +4 不能盖过字面命中差很多的情况', () => {
  const now = Date.now()
  const q = '判断 视频 记录 评论 天气 出门'
  const events = [
    // 六个词全中，但是聊天原话（六片各 +1 = 6）
    { id: 'chat', type: 'utterance', ts: at(0), text: '判断 视频 记录 评论 天气 出门', flags: ['uncommitted'] },
    // 只中一片，但认领过（1 + 4 = 5）
    { id: 'mine', type: 'utterance', ts: at(5), text: '判断' },
  ]
  const { rows } = searchEvents(events, q, { now })
  assert.equal(rows[0].id, 'chat', '字面命中差得多的时候，认领的加权不该盖过它')
})

// ---------------------------------------- 2026-11-08（用户 m00394）群里他本人的话

test('群里他本人说的一句：记成 heard + scene:group，只留最长的一句', async () => {
  await withRoot(async (root) => {
    const r = await rememberGroupWord(root, {
      text: '嗯。这个版本我打算先发一版试试看，后面有问题再说。', day: 3, stage: 2, sessionId: 's-group-1',
    })
    assert.equal(r.written, true)
    const { events } = await readEvents(root)
    const ev = events.find((e) => e.type === 'heard')
    assert.ok(ev, '要真的落进事件流')
    assert.equal(ev.scene, 'group', '场次必须留下：她翻到时才知道这是在群里说的')
    assert.equal(ev.text, '这个版本我打算先发一版试试看，后面有问题再说')
    assert.equal(ev.sessionId, 's-group-1', '群聊那句要知道是哪间房说的')
    assert.equal(ev.source, 'system', '她不能写 heard——那就等于能凭空造一句「他说过」')
    // 进记忆 ≠ 他来找过她
    assert.equal(isContactEvent(ev), false)
  })
})

test('群里那句没有值得留的句子就不写，也不抛', async () => {
  await withRoot(async (root) => {
    const r = await rememberGroupWord(root, { text: '嗯。好的。', day: 1, stage: 1 })
    assert.equal(r.written, false)
    const { events } = await readEvents(root)
    assert.equal(events.length, 0, '「嗯」「好」记下来也翻不出什么')
  })
})
