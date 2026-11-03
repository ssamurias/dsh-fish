/**
 * letter.test.mjs —— R4「留话」的锁定测试（2026-10-24）
 *
 * 守五件事：
 *   1. 留话落成「一条 utterance + 一条 meta 打标」，不新增事件类型；
 *   2. 打标能反查回来（观测台靠它标「留给你的」）；
 *   3. 上限真的生效（太长 / 每天太多），而且**不训她**；
 *   4. 不审批：留完立刻可见，不入待裁决队列；
 *   5. 注册出来的工具参数是合法 JSON Schema、render 返回 ContentBlock 数组。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  LETTER_MAX,
  LETTERS_PER_DAY,
  letterMark,
  letterIds,
  lettersToday,
  lettersSince,
  leaveLetter,
  registerLetter,
} from '../lib/letter.js'
import { buildInbox, readInbox, writeInboxFile } from '../lib/inbox.js'
import { readEvents, paths } from '../lib/store.js'
import { dateKey } from '../lib/settings.js'

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-fish-letter-'))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

function fakeCtx() {
  const tools = []
  return {
    tools: { register: (t) => { tools.push(t); return { dispose() {} } } },
    _tools: tools,
  }
}

// ---------------------------------------------------------------- 纯函数

test('letterMark 的形状是 letter:<日期>:<id>，日期用本地 dateKey', () => {
  const dk = dateKey()
  const mark = letterMark(dk, 'ev_01ABC')
  assert.equal(mark, `letter:${dk}:ev_01ABC`)
  assert.ok(mark.startsWith('letter:'))
})

test('letterIds 只认 meta 里的打标，普通文本里出现 letter: 不算', () => {
  const events = [
    { type: 'meta', text: 'letter:2026-10-24:ev_A' },
    { type: 'meta', text: 'letter:2026-10-23:ev_B' },
    { type: 'utterance', text: 'letter:2026-10-24:ev_C 这是她说的话，不是打标' },
    { type: 'meta', text: 'diary:2026-10-24' },
    { type: 'meta', text: 'letter:' },
  ]
  const s = letterIds(events)
  assert.deepEqual([...s].sort(), ['ev_A', 'ev_B'])
})

test('lettersToday 按日期分桶，昨天的不算', () => {
  const events = [
    { type: 'meta', text: 'letter:2026-10-24:ev_A' },
    { type: 'meta', text: 'letter:2026-10-24:ev_B' },
    { type: 'meta', text: 'letter:2026-10-23:ev_C' },
  ]
  assert.equal(lettersToday(events, '2026-10-24'), 2)
  assert.equal(lettersToday(events, '2026-10-23'), 1)
  assert.equal(lettersToday([], '2026-10-24'), 0)
  // 坏输入不许抛
  assert.equal(lettersToday(null, '2026-10-24'), 0)
})

// ---------------------------------------------------------------- 落库

test('留话 = 一条 utterance + 一条 meta 打标，类型表没变', async () => {
  await withRoot(async (root) => {
    const r = await leaveLetter(root, '今天没发生什么，但我记得你上次说的那句。')
    assert.equal(r.ok, true)
    assert.ok(r.id.startsWith('ev_'))

    const { events } = await readEvents(root)
    const utt = events.find((e) => e.id === r.id)
    assert.equal(utt.type, 'utterance')
    assert.equal(utt.source, 'tool')

    const mark = events.find((e) => e.type === 'meta' && String(e.text).startsWith('letter:'))
    assert.ok(mark, '必须落一条 letter: 打标')
    assert.equal(mark.source, 'system', 'meta 只能 system 写')
    assert.ok(String(mark.text).endsWith(r.id))
    // 没有新类型：事件流里只应出现 utterance + meta
    const types = new Set(events.map((e) => e.type))
    for (const t of types) assert.ok(['utterance', 'meta'].includes(t), `不该出现新类型 ${t}`)
  })
})

test('空白 / 纯空格留不住，且说的是"没留"，不是"你不许"', async () => {
  await withRoot(async (root) => {
    const r = await leaveLetter(root, '   \n  ')
    assert.equal(r.ok, false)
    assert.match(r.note, /空白/)
    assert.doesNotMatch(r.note, /不许|不可以|禁止/)
    const { events } = await readEvents(root)
    assert.equal(events.length, 0)
  })
})

test(`超过 ${LETTER_MAX} 字留不住，理由指向"他读不完"而不是"你违规"`, async () => {
  await withRoot(async (root) => {
    const r = await leaveLetter(root, '啊'.repeat(LETTER_MAX + 1))
    assert.equal(r.ok, false)
    assert.match(r.note, new RegExp(String(LETTER_MAX)))
    assert.doesNotMatch(r.note, /违规|不许|禁止/)
    const { events } = await readEvents(root)
    assert.equal(events.length, 0)
  })
})

test(`每天最多 ${LETTERS_PER_DAY} 条；超了只说明天再说，不训她`, async () => {
  await withRoot(async (root) => {
    for (let i = 0; i < LETTERS_PER_DAY; i += 1) {
      const ok = await leaveLetter(root, `第 ${i + 1} 句`)
      assert.equal(ok.ok, true, `第 ${i + 1} 条应该留得住`)
    }
    const over = await leaveLetter(root, '再来一条')
    assert.equal(over.ok, false)
    assert.match(over.note, /明天/)
    assert.doesNotMatch(over.note, /不许|违规|禁止|超限/)
    // 事件流里不该多出第 4 条 utterance
    const { events } = await readEvents(root)
    assert.equal(events.filter((e) => e.type === 'utterance').length, LETTERS_PER_DAY)
  })
})

// ---------------------------------------------------------------- 信箱侧

test('信箱把留话单独数出来，而且只数未读的', async () => {
  await withRoot(async (root) => {
    const a = await leaveLetter(root, '这句是留给你的。')
    assert.equal(a.ok, true)
    // 一条独白（不是留话）
    const { appendEvent } = await import('../lib/store.js')
    await appendEvent({ type: 'utterance', text: '这句只是自言自语。' }, { day: 1, stage: 1, source: 'tool' }, root)

    // 默认口径只放留话（2026-10-24 用户定）；先关掉它验证"留话能被单独数出来"。
    const box = await readInbox(root, { lettersOnly: false })
    assert.equal(box.total, 2)
    assert.equal(box.letters, 1, '未读的留话应当有 1 条')

    const letterRow = box.rows.find((r) => r.id === a.id)
    assert.equal(letterRow.letter, true)
    const plain = box.rows.find((r) => r.id !== a.id)
    assert.equal(plain.letter, false)

    // 默认那一份里，独白不出现
    const only = await readInbox(root)
    assert.equal(only.total, 1, '默认信箱只有留话')
    assert.equal(only.rows[0].id, a.id)
  })
})

test('读完之后留话不再计入 letters（角标会消失）', async () => {
  await withRoot(async (root) => {
    await leaveLetter(root, '留一句')
    const { markRead } = await import('../lib/inbox.js')
    await markRead(root)
    const box = await readInbox(root)
    assert.equal(box.unread, 0)
    assert.equal(box.letters, 0)
    // 但那句仍然在列表里，只是不再算未读
    assert.equal(box.rows.length, 1)
    assert.equal(box.rows[0].letter, true)
  })
})

test('inbox.md 只写留话，标成「她留给你的话」，独白不进这个文件', async () => {
  await withRoot(async (root) => {
    await leaveLetter(root, '我有话跟你说。')
    const { appendEvent } = await import('../lib/store.js')
    await appendEvent({ type: 'utterance', text: '随便一句。' }, { day: 1, stage: 1, source: 'tool' }, root)
    await writeInboxFile(root)
    const md = await readFile(join(paths(root).root, 'inbox.md'), 'utf8')
    assert.match(md, /# 大肥鱼留给你的话/)
    assert.match(md, /她留给你的话/)
    assert.match(md, /共 1 封，未读 1 封/)
    assert.match(md, /这里只有特意留给你的/)
    assert.doesNotMatch(md, /随便一句。/, '平常说的话在对话框里，不写进信箱文件')
  })
})

test('buildInbox 在没有留话时不冒出 letters 字段值（0，不是 undefined）', () => {
  const box = buildInbox([{ id: 'ev_1', type: 'utterance', ts: '2026-10-24T00:00:00Z', text: '嗯' }])
  assert.equal(box.letters, 0)
  assert.equal(box.rows[0].letter, false)
})

// 2026-11-03（github:ssamurias/dsh-fish#19）：事件流里的 ts 是 UTC，
// 原来直接 `String(ts).slice(0,16)`，东八区看小纸条永远早 8 小时，
// 而正文里她自己写的本地时间又是对的——用户看到的就是两边打架。
test('inbox.md 里的小标题时间用本地钟，不是 UTC', async () => {
  await withRoot(async (root) => {
    const { appendEvent } = await import('../lib/store.js')
    // 钉一个固定的 UTC 时刻：2026-11-03T14:16:00Z（东八区是 22:16）
    const ev = await appendEvent(
      { type: 'utterance', text: '我留一句话。', ts: '2026-11-03T14:16:00.000Z' },
      { day: 1, stage: 1, source: 'tool' },
      root,
    )
    // 信箱只收「留话」，靠 meta 打标认出来（见 lib/letter.js 的 letterMark）
    await appendEvent(
      { type: 'meta', text: letterMark(dateKey(), ev.id) },
      { day: 1, stage: 1, source: 'system' },
      root,
    )
    await writeInboxFile(root)
    const md = await readFile(join(paths(root).root, 'inbox.md'), 'utf8')

    // 期望值由本地钟算出来，不写死时区：CI 在哪台机器上跑都对
    const d = new Date('2026-11-03T14:16:00.000Z')
    const pad = (n) => String(n).padStart(2, '0')
    const want = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    assert.match(md, new RegExp(`## ${want} · `), '小标题要用本地时间印')
    // 把 UTC 串原样切出来的那个错法，在这一刻必须是错的
    if (want !== '2026-11-03 14:16') assert.doesNotMatch(md, /## 2026-11-03 14:16 · /)
  })
})

// ---------------------------------------------------------------- 工具面

test('registerLetter 注册 her_leave，参数是合法 object schema', () => {
  const ctx = fakeCtx()
  registerLetter(ctx, { root: join(tmpdir(), 'dsh-fish-letter-reg') })
  assert.equal(ctx._tools.length, 1)
  const spec = ctx._tools[0]
  assert.equal(spec.name, 'her_leave')
  assert.equal(spec.parameters.type, 'object')
  assert.ok(spec.parameters.properties.text)
  assert.deepEqual(spec.parameters.required, ['text'])
  assert.equal(spec.parameters.properties.text.type, 'string')
})

test('her_leave 的 render 返回 ContentBlock 数组（不是字符串）', () => {
  const ctx = fakeCtx()
  registerLetter(ctx, { root: join(tmpdir(), 'dsh-fish-letter-render') })
  const spec = ctx._tools[0]
  const okBlocks = spec.output.render({ text: 'x' }, { ok: true, note: '' })
  assert.ok(Array.isArray(okBlocks))
  assert.equal(okBlocks[0].type, 'text')
  // 回执要长得像机器标记，不是一句她能接着说的话（2026-10-24）
  assert.equal(okBlocks[0].text, '[已留]')
  const badBlocks = spec.output.render({ text: 'x' }, { ok: false, note: '今天已经留过了。' })
  assert.ok(Array.isArray(badBlocks))
  assert.match(badBlocks[0].text, /没留/)
})

test('回执不写成她能复述的句子——同一次唤醒里她不该「接着说」工具返回的话', () => {
  const ctx = fakeCtx()
  registerLetter(ctx, { root: join(tmpdir(), 'dsh-fish-letter-tone') })
  const spec = ctx._tools[0]
  const ok = spec.output.render({}, { ok: true, note: '' })[0].text
  const bad = spec.output.render({}, { ok: false, note: '太长了，他读不完。' })[0].text
  // 成功回执里不该有句号（句号 = 一句完整的话，会被当成她自己的语气）
  assert.doesNotMatch(ok, /。/)
  // 两条都包在方括号里：方括号是「这是机器说的」的信号
  assert.ok(ok.startsWith('[') && ok.endsWith(']'))
  assert.ok(bad.startsWith('[') && bad.endsWith(']'))
})

test('her_leave 的返回值不含任何状态数字（只 ok + note）', () => {
  const ctx = fakeCtx()
  registerLetter(ctx, { root: join(tmpdir(), 'dsh-fish-letter-out') })
  const spec = ctx._tools[0]
  assert.deepEqual(Object.keys(spec.output.schema.properties).sort(), ['note', 'ok'])
})

test('执行 her_leave 后落库，且不会因为返回值暴露额度', async () => {
  await withRoot(async (root) => {
    const ctx = fakeCtx()
    registerLetter(ctx, { root })
    const spec = ctx._tools[0]
    const out = await spec.execute({ text: '留一句试试。' })
    assert.equal(out.ok, true)
    assert.equal(out.note, '已留。')
    assert.doesNotMatch(JSON.stringify(out), /\d+\s*条|\/3|额度/)
    const { events } = await readEvents(root)
    assert.ok(events.some((e) => e.type === 'utterance'))
  })
})

// ------------------------------------------------------------------
// 0.6.16（用户 m01677「留话也做」）：出门页要把这趟留的话摊开
// ------------------------------------------------------------------

test('lettersSince：只取这段时间里、这条会话留下的那几句', () => {
  const events = [
    { type: 'utterance', id: 'e1', ts: 1000, text: '屋里那盏灯我留着', sessionId: 'session-out' },
    { type: 'meta', text: 'letter:2026-10-29:e1' },
    { type: 'utterance', id: 'e2', ts: 2000, text: '今天的风很轻', sessionId: 'session-home' },
    { type: 'meta', text: 'letter:2026-10-29:e2' },
    { type: 'utterance', id: 'e3', ts: 3000, text: '不是留话，是普通的一句话' },
    { type: 'utterance', id: 'e4', ts: 4000, text: '回来给你带块石头', sessionId: 'session-out' },
    { type: 'meta', text: 'letter:2026-10-29:e4' },
  ]
  // 按会话筛：只看她在外面那条写的
  const out = lettersSince(events, { since: 500, sessionId: 'session-out' })
  assert.deepEqual(out.map((x) => x.text), ['屋里那盏灯我留着', '回来给你带块石头'])
  // 按时间筛：since 之后的不含更早那条
  assert.deepEqual(lettersSince(events, { since: 2500, sessionId: 'session-out' }).map((x) => x.text), ['回来给你带块石头'])
  // 没打标的普通发言不算留话
  assert.ok(!lettersSince(events, {}).some((x) => /普通的一句话/.test(x.text)))
  // limit 生效且保留最近的
  assert.deepEqual(lettersSince(events, { limit: 1 }).map((x) => x.text), ['回来给你带块石头'])
})

// 2026-10-29 真机事故：真实事件流的 ts 是 ISO 字符串（schema.validateEvent 写的），
// 这里原先用 Number(e.ts) 比较，ISO 转数字是 NaN → 出门页「她留的话」永远是空的。
test('lettersSince：事件流里的 ISO 字符串 ts 也要算数（2026-10-29 真机：留话永远空）', () => {
  const events = [
    { type: 'utterance', id: 'e1', ts: '2026-10-29T20:00:00.000Z', text: '出门前留的', sessionId: 'session-out' },
    { type: 'meta', text: 'letter:2026-10-29:e1' },
    { type: 'utterance', id: 'e2', ts: '2026-10-29T21:30:00.000Z', text: '在外面留的', sessionId: 'session-out' },
    { type: 'meta', text: 'letter:2026-10-29:e2' },
  ]
  const since = Date.parse('2026-10-29T21:14:33.136Z')
  const out = lettersSince(events, { since, sessionId: 'session-out' })
  assert.deepEqual(out.map((x) => x.text), ['在外面留的'])
  assert.equal(out[0].ts, Date.parse('2026-10-29T21:30:00.000Z'), 'ts 统一回毫秒')
})
