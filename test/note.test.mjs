/**
 * note.test.mjs —— issue #22 乙档「醒来看的那张便条」的锁定测试（2026-11-04）
 *
 * 守六件事：
 *   1. renderNotes 是纯函数，没有到期的一张时返回空串（唤醒正文一个字都不多）；
 *   2. 只列 open + 有日子 + 已经到期的；没日子的、将来的、做完了的都不进第一眼；
 *   3. 过期不删——renderNotes 不改输入，closeNote 只改 status，条目一条都不少；
 *   4. 一次最多 5 条，剩下的只报数；文案里不出现「逾期」「请尽快」这类催人的词；
 *   5. 上限写死在代码里（字数 / 张数），拒绝时不训她；
 *   6. 注册出来的工具是宿主认的形状，且 notes.json 与 session-notes.json 不混名。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  NOTES_FILE,
  NOTES_MAX,
  NOTE_TEXT_MAX,
  NOTE_SHOW_MAX,
  notesPath,
  readNotes,
  writeNotes,
  normalizeNote,
  isDue,
  daysBetween,
  renderNotes,
  addNote,
  closeNote,
  registerNote,
} from '../lib/note.js'
import { paths } from '../lib/store.js'

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-fish-note-'))
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

const note = (over = {}) => normalizeNote({ text: '一件事', created: '2026-11-01T00:00:00.000Z', ...over })

test('文件名不与 session-notes.json 撞名', () => {
  assert.equal(NOTES_FILE, 'notes.json')
  assert.notEqual(join('x', NOTES_FILE), join('x', 'session-notes.json'))
})

test('isDue 只认真实存在的日子', () => {
  assert.equal(isDue('2026-11-05'), true)
  assert.equal(isDue('2024-02-29'), true)
  assert.equal(isDue('2026-02-30'), false, '二月没有 30 号')
  assert.equal(isDue('2026-13-01'), false)
  assert.equal(isDue('2026-1-5'), false, '必须补零')
  assert.equal(isDue(''), false)
  assert.equal(isDue(null), false)
})

test('daysBetween 按本地日历日算，跨月也对', () => {
  assert.equal(daysBetween('2026-11-01', '2026-11-04'), 3)
  assert.equal(daysBetween('2026-10-31', '2026-11-01'), 1)
  assert.equal(daysBetween('2026-11-04', '2026-11-04'), 0)
  assert.equal(daysBetween('2026-11-05', '2026-11-04'), -1, '将来是负数')
})

test('没有到期的一张时，醒来那一段是空串', () => {
  assert.equal(renderNotes([], new Date(2026, 10, 4)), '')
  assert.equal(renderNotes(null, new Date(2026, 10, 4)), '')
  // 只有没日子的、只有将来的、只有做完的 —— 都不该冒出一段
  const quiet = [
    note({ id: 'a', due: '' }),
    note({ id: 'b', due: '2026-11-09' }),
    note({ id: 'c', due: '2026-11-01', status: 'done' }),
  ]
  assert.equal(renderNotes(quiet, new Date(2026, 10, 4)), '')
})

test('到期的摆出来：按日子排，写「晚了几天」，不催人', () => {
  const list = [
    note({ id: 'b', text: '答应给他的那张图', due: '2026-11-03' }),
    note({ id: 'a', text: '说要看的那篇', due: '2026-11-01' }),
  ]
  const text = renderNotes(list, new Date(2026, 10, 4))
  const lines = text.split('\n')
  assert.equal(lines[0], '（桌上压着两张）')
  assert.equal(lines[1], '11-01 说要看的那篇，晚了三天。')
  assert.equal(lines[2], '11-03 答应给他的那张图，晚了一天。')
  assert.doesNotMatch(text, /逾期|请尽快|紧急/)
})

test('当天到期的就是今天，不算晚', () => {
  const text = renderNotes([note({ due: '2026-11-04' })], new Date(2026, 10, 4))
  assert.match(text, /11-04 一件事，就是今天。/)
})

test('一次最多五张，剩下的只报数', () => {
  const many = Array.from({ length: NOTE_SHOW_MAX + 3 }, (_, i) =>
    note({ id: `n${i}`, text: `第${i}件`, due: `2026-11-0${i + 1}` }),
  )
  const text = renderNotes(many, new Date(2026, 10, 20))
  const lines = text.split('\n')
  assert.equal(lines[0], '（桌上压着八张）')
  // 标题 + 5 张 + 一句「还有…」
  assert.equal(lines.length, 1 + NOTE_SHOW_MAX + 1)
  assert.match(lines[lines.length - 1], /还有三条没列出来/)
  assert.equal((text.match(/^11-/gm) ?? []).length, NOTE_SHOW_MAX)
})

test('过期不删：renderNotes 不改输入，条目一条不动', () => {
  const old = note({ id: 'old', text: '三个月前的事', due: '2026-08-01' })
  const list = [old]
  const snap = JSON.stringify(list)
  const text = renderNotes(list, new Date(2026, 10, 4))
  assert.match(text, /晚了九十五天/)
  assert.equal(JSON.stringify(list), snap, 'renderNotes 必须是纯函数')
})

test('写进 notes.json，读回来形状一致', async () => {
  await withRoot(async (root) => {
    const r = await addNote(root, { text: '去看那篇论文', due: '2026-11-06' })
    assert.equal(r.ok, true)
    assert.ok(r.id)
    const raw = JSON.parse(await readFile(notesPath(root), 'utf8'))
    assert.equal(raw.length, 1)
    assert.equal(raw[0].text, '去看那篇论文')
    assert.equal(raw[0].due, '2026-11-06')
    assert.equal(raw[0].status, 'open')
    const back = await readNotes(root)
    assert.equal(back[0].id, r.id)
    assert.equal(back[0].closedAt, null)
  })
})

test('没有日子也能记；空文本、坏日子、太长都拒绝，而且不训她', async () => {
  await withRoot(async (root) => {
    const noDue = await addNote(root, { text: '下次你说发' })
    assert.equal(noDue.ok, true)

    const empty = await addNote(root, { text: '   ' })
    assert.equal(empty.ok, false)
    assert.match(empty.note, /空白的/)

    const bad = await addNote(root, { text: '一件事', due: '2026-02-30' })
    assert.equal(bad.ok, false)
    assert.match(bad.note, /2026-11-05/)
    assert.doesNotMatch(bad.note, /错误|非法|无效/)

    const long = await addNote(root, { text: 'x'.repeat(NOTE_TEXT_MAX + 1) })
    assert.equal(long.ok, false)
    assert.match(long.note, new RegExp(String(NOTE_TEXT_MAX)))
    assert.doesNotMatch(long.note, /错误|非法/)

    // 拒绝的那几张不该落盘
    const back = await readNotes(root)
    assert.equal(back.length, 1)
  })
})

test('桌上满了就拒绝，不自动清理旧纸条', async () => {
  await withRoot(async (root) => {
    const many = Array.from({ length: NOTES_MAX }, (_, i) => note({ id: `n${i}`, text: `第${i}件` }))
    await writeNotes(root, many)
    const r = await addNote(root, { text: '再来一张' })
    assert.equal(r.ok, false)
    assert.match(r.note, /堆满/)
    const back = await readNotes(root)
    assert.equal(back.length, NOTES_MAX, '不许为了腾地方删旧的')
  })
})

test('划掉只是改状态：条目还在，别的条目不受影响', async () => {
  await withRoot(async (root) => {
    const a = await addNote(root, { text: '第一件', due: '2026-11-01' })
    const b = await addNote(root, { text: '第二件', due: '2026-11-02' })
    const done = await closeNote(root, { id: a.id })
    assert.equal(done.ok, true)
    assert.match(done.note, /已划掉/)

    const back = await readNotes(root)
    assert.equal(back.length, 2, '划掉不等于删掉')
    const hit = back.find((n) => n.id === a.id)
    assert.equal(hit.status, 'done')
    assert.ok(hit.closedAt, '关掉的日期要记下来')
    assert.equal(back.find((n) => n.id === b.id).status, 'open')

    // 划掉的就不再出现在醒来第一眼
    const text = renderNotes(back, new Date(2026, 10, 20))
    assert.match(text, /第二件/)
    assert.doesNotMatch(text, /第一件/)
  })
})

test('划掉不存在的一张 / 重复划掉，都不抛', async () => {
  await withRoot(async (root) => {
    const miss = await closeNote(root, { id: 'note-nope' })
    assert.equal(miss.ok, false)
    assert.match(miss.note, /没有这一张/)

    const noId = await closeNote(root, {})
    assert.equal(noId.ok, false)
    assert.match(noId.note, /哪一张/)

    const a = await addNote(root, { text: '一件事' })
    await closeNote(root, { id: a.id })
    const again = await closeNote(root, { id: a.id })
    assert.equal(again.ok, true)
    assert.match(again.note, /已经划掉过/)
  })
})

test('文件坏了当空处理，不拖垮一次唤醒', async () => {
  await withRoot(async (root) => {
    await writeFile(notesPath(root), '{ 这不是 json', 'utf8')
    const list = await readNotes(root)
    assert.deepEqual(list, [])
    assert.equal(renderNotes(list, new Date(2026, 10, 4)), '')
  })
})

test('notes.json 就在家目录根上，跟 store.paths 的其它文件并列', async () => {
  await withRoot(async (root) => {
    assert.equal(notesPath(root), join(paths(root).root, 'notes.json'))
  })
})

test('注册出来的 her_note 是宿主认的形状，render 只回方括号标记', async () => {
  await withRoot(async (root) => {
    const ctx = fakeCtx()
    registerNote(ctx, { root, log: () => {} })
    const def = ctx._tools[0]
    assert.equal(def.name, 'her_note')
    assert.ok(def.description.length > 10)
    assert.equal(def.parameters.type, 'object')
    assert.ok(def.parameters.properties.text)
    assert.ok(Array.isArray(def.parameters.required) === false || Array.isArray(def.parameters.required))
    assert.equal(def.output.schema.type, 'object')
    assert.equal(typeof def.output.render, 'function')
    assert.equal(typeof def.execute, 'function')

    const out = await def.execute({ text: '一件要做的事', due: '2026-11-06' }, { session: {} })
    assert.equal(out.ok, true)
    const blocks = def.output.render({}, out)
    assert.deepEqual(blocks, [{ type: 'text', text: '[记下了]' }])
    assert.doesNotMatch(blocks[0].text, /\d/, '回执里不带数字（不吃状态）')

    const closed = await def.execute({ id: out.id, status: 'done' }, { session: {} })
    assert.equal(closed.ok, true)
    assert.equal((await readNotes(root))[0].status, 'done')
  })
})
