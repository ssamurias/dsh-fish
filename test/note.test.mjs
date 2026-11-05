/**
 * note.test.mjs —— issue #22 乙档「醒来看的那张便条」的锁定测试（2026-11-04）
 *
 * 守七件事：
 *   1. renderNotes 是纯函数，没有到期的一张时返回空串（唤醒正文一个字都不多）；
 *   2. 只列 open + 有日子 + 已经到期的；没日子的、将来的、做完了的都不进第一眼；
 *   3. 过期不删——renderNotes 不改输入，closeNote 只改 status，条目一条都不少；
 *   4. 一次最多 5 条，剩下的只报数；文案里不出现「逾期」「请尽快」这类催人的词；
 *   5. 上限写死在代码里（字数 / 张数），拒绝时不训她；
 *   6. 注册出来的工具是宿主认的形状，且 notes.json 与 session-notes.json 不混名；
 *   7. 划掉只靠她看得见的东西：她手里没有 id，只有自己写过的那句话。
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
import { NOTE_BRIEF } from '../lib/persona.js'
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

// ---- 只靠她看得见的东西划掉（issue #22）----
// 宿主只把 render 的结果交给她，execute 的返回值（里面有 id）不进她的上下文。
// 所以下面这几条走的路和她一样：从回执和醒来那段拿字，除了专门测 id 的那条，一律不碰 value.id。

function herTool(root) {
  const ctx = fakeCtx()
  registerNote(ctx, { root, log: () => {} })
  const def = ctx._tools[0]
  const call = async (args) => def.output.render(args, await def.execute(args, { session: {} }))[0].text
  return { def, call }
}
const wakeOf = async (root, now) => renderNotes(await readNotes(root), now)
// 醒来那行是「11-01 那件事，晚了四天。」：掐头去尾，剩下的就是她手里的原话
const wordsOn = (line) => line.replace(/^\d\d-\d\d /, '').replace(/，(就是今天|晚了.+天)。$/, '')

test('走一遍：记一张，醒来读到字，照着划掉，下次醒来就空了', async () => {
  await withRoot(async (root) => {
    const { call } = herTool(root)
    const now = new Date(2026, 10, 5)

    assert.equal(await call({ text: '把借的伞还回去', due: '2026-11-01' }), '[记下了]')

    const wake = await wakeOf(root, now)
    assert.doesNotMatch(wake, /note-/, '醒来那段不带 id，所以她只能靠字')
    const line = wake.split('\n')[1]
    assert.equal(line, '11-01 把借的伞还回去，晚了四天。')

    const closed = await call({ text: wordsOn(line), status: 'done' })
    assert.equal(closed, '[划掉了]')
    assert.doesNotMatch(closed, /\d/, '回执里不带数字（不吃状态）')
    assert.equal(await wakeOf(root, now), '', '划掉之后不再摆出来')

    const back = await readNotes(root)
    assert.equal(back.length, 1, '划掉不等于删掉，也不许顺手多记一张')
    assert.equal(back[0].status, 'done')
    assert.ok(back[0].closedAt)
  })
})

test('没日子的纸条从不进醒来那段，也能靠自己写过的那句话划掉', async () => {
  await withRoot(async (root) => {
    const { call } = herTool(root)
    const now = new Date(2026, 10, 5)

    assert.equal(await call({ text: '下次路过\n  那家店\t看一眼' }), '[记下了]')
    assert.equal(await wakeOf(root, now), '', '没日子不上桌：这张她读不到第二遍')

    // 空白和记的时候不一样也算同一句：addNote 落盘前就是这么规整的
    assert.equal(await call({ text: ' 下次路过 那家店  看一眼\n', status: 'done' }), '[划掉了]')

    const back = await readNotes(root)
    assert.equal(back.length, 1)
    assert.equal(back[0].status, 'done')
  })
})

test('重名时先划最早记下的那张，一次只划一张', async () => {
  await withRoot(async (root) => {
    const { call } = herTool(root)
    const now = new Date(2026, 10, 5)
    await call({ text: '交水费', due: '2026-11-01' })
    await call({ text: '交水费', due: '2026-11-02' })
    assert.match(await wakeOf(root, now), /桌上压着两张/)

    assert.equal(await call({ text: '交水费', status: 'done' }), '[划掉了]')
    assert.equal(await wakeOf(root, now), '（桌上压着一张）\n11-02 交水费，晚了三天。')

    assert.equal(await call({ text: '交水费', status: 'done' }), '[划掉了]')
    assert.equal(await wakeOf(root, now), '')

    // 都划过了再划一次：和按 id 重复划掉一样，不算错，也不动已有的
    const before = JSON.stringify(await readNotes(root))
    assert.equal(await call({ text: '交水费', status: 'done' }), '[划掉了]')
    assert.equal(JSON.stringify(await readNotes(root)), before)
  })
})

test('「最早」看记下的时间，不看文件里的前后（文件允许人手改）', async () => {
  await withRoot(async (root) => {
    await writeNotes(root, [
      note({ id: 'later', text: '交水费', created: '2026-11-03T00:00:00.000Z' }),
      note({ id: 'earlier', text: '交水费', created: '2026-11-01T00:00:00.000Z' }),
    ])
    const { call } = herTool(root)
    assert.equal(await call({ text: '交水费', status: 'done' }), '[划掉了]')
    const back = await readNotes(root)
    assert.equal(back.find((n) => n.id === 'earlier').status, 'done')
    assert.equal(back.find((n) => n.id === 'later').status, 'open')
  })
})

test('桌上满了也划得掉：记不进去的时候，照醒来那行字划', async () => {
  await withRoot(async (root) => {
    const many = Array.from({ length: NOTES_MAX }, (_, i) => note({ id: `n${i}`, text: `第${i}件` }))
    many[7] = note({ id: 'n7', text: '把借的伞还回去', due: '2026-11-01' })
    await writeNotes(root, many)
    const { call } = herTool(root)
    const now = new Date(2026, 10, 5)

    assert.match(await call({ text: '再来一张' }), /^\[没记下：.*堆满/)

    const line = (await wakeOf(root, now)).split('\n')[1]
    assert.equal(await call({ text: wordsOn(line), status: 'done' }), '[划掉了]')
    assert.equal(await wakeOf(root, now), '')
    assert.equal((await readNotes(root)).length, NOTES_MAX, '划掉不等于删掉')
  })
})

test('划不掉时回一句人话，回执写「没划掉」，不再要 id，也不多记一张', async () => {
  await withRoot(async (root) => {
    const { call } = herTool(root)
    const now = new Date(2026, 10, 5)
    await call({ text: '把借的伞还回去', due: '2026-11-01' })

    const answers = [
      await call({ text: '把伞还了', status: 'done' }), // 记错了原话
      await call({ text: '11-01 把借的伞还回去，晚了四天。', status: 'done' }), // 整行抄过来：日子和晚几天不是原话
      await call({ status: 'done' }), // 什么都没给
    ]
    for (const said of answers) {
      assert.match(said, /^\[没划掉：.+\]$/)
      assert.doesNotMatch(said, /id/i, '她看不到 id，不能再叫她报')
      assert.doesNotMatch(said, /\d/, '回执里不带数字（不吃状态）')
      assert.doesNotMatch(said, /记下了|错误|非法|无效/)
    }
    assert.match(answers[1], /一字不差/, '要告诉她差在哪，不然她只能瞎试')

    const back = await readNotes(root)
    assert.equal(back.length, 1)
    assert.equal(back[0].status, 'open')
    assert.match(await wakeOf(root, now), /把借的伞还回去/)
  })
})

test('id 这条路还在：回执同样写划掉，没对上 id 但给了原话也算', async () => {
  await withRoot(async (root) => {
    const { def, call } = herTool(root)
    const a = await def.execute({ text: '第一件' }, { session: {} })
    await def.execute({ text: '第二件' }, { session: {} })

    assert.equal(await call({ id: a.id, status: 'done' }), '[划掉了]')
    assert.equal(await call({ id: a.id }), '[划掉了]', '只给 id 也算划掉，判据没变')
    assert.match(await call({ id: 'note-nope', status: 'done' }), /^\[没划掉：桌上没有这一张/)

    // 她可能猜一个 id 再带上原话：id 对不上不该把原话也废掉
    assert.equal(await call({ id: 'note-nope', text: '第二件', status: 'done' }), '[划掉了]')
    assert.deepEqual((await readNotes(root)).map((n) => n.status), ['done', 'done'])

    // id 和原话指向两张时听 id；带 id 带 text 不带 status 还是记一张，判据没变
    const c = await def.execute({ text: '第三件' }, { session: {} })
    await def.execute({ text: '第四件' }, { session: {} })
    assert.equal(await call({ id: c.id, text: '第四件', status: 'done' }), '[划掉了]')
    assert.deepEqual((await readNotes(root)).map((n) => n.status), ['done', 'done', 'done', 'open'])
    assert.equal(await call({ id: c.id, text: '第五件' }), '[记下了]')
    assert.equal((await readNotes(root)).length, 5)
  })
})

test('说明书和工具描述都告诉她怎么划掉，不再叫她报看不到的 id', async () => {
  await withRoot(async (root) => {
    const { def } = herTool(root)
    for (const said of [NOTE_BRIEF, def.description]) {
      assert.match(said, /text/)
      assert.match(said, /status: ?"done"/)
      assert.match(said, /原样/)
      assert.doesNotMatch(said, /id/i)
    }
    assert.match(def.parameters.properties.text.description, /当时记的那句话/, '参数说明不能再说划掉时不用给')
  })
})
