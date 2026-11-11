/**
 * herdiary.test.mjs —— 她自己回头翻日记（issue #7 第二半）
 *
 * 这一组守五件事：
 *   ① 不给日期就是最近那一篇；给日期就读那一天；
 *   ② list=true 只要日期清单；
 *   ③ 参数是日期不是路径——`../` 这类传不进来；
 *   ④ 那天没写 / 一篇都没写过，说的是人话，两者分得清；
 *   ⑤ 太长的截到 DIARY_READ_MAX，并且告诉她后面还有。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { registerHerDiary, renderDiary, DIARY_READ_MAX, DIARY_LIST_MAX, DIARY_HIT_MAX } from '../lib/herdiary.js'
import { DIARY_BRIEF } from '../lib/persona.js'
import { writeDaily } from '../lib/store.js'
import { heardLine } from '../lib/use.js'

async function tmpRoot() {
  return mkdtemp(join(tmpdir(), 'fish-herdiary-'))
}

/** 抓注册出来的那个工具，直接调 execute */function toolFor(root) {
  let def = null
  const ctx = { tools: { register: (d) => ((def = d), d) } }
  registerHerDiary(ctx, { root })
  return def
}

test('不给日期：给最近那一篇', async () => {
  const root = await tmpRoot()
  try {
    await writeDaily('diaryDir', '2026-10-27', '昨天写的', root)
    await writeDaily('diaryDir', '2026-10-28', '今天写的', root)
    const t = toolFor(root)
    const out = await t.execute({})
    assert.equal(out.found, true)
    assert.match(out.text, /2026-10-28 那天你写的/)
    assert.match(out.text, /今天写的/)
    assert.doesNotMatch(out.text, /昨天写的/)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('指定日期：只读那一天', async () => {
  const root = await tmpRoot()
  try {
    await writeDaily('diaryDir', '2026-10-27', '昨天写的', root)
    await writeDaily('diaryDir', '2026-10-28', '今天写的', root)
    const out = await toolFor(root).execute({ date: '2026-10-27' })
    assert.equal(out.found, true)
    assert.match(out.text, /2026-10-27/)
    assert.match(out.text, /昨天写的/)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('list=true：只回日期清单，不带正文', async () => {
  const root = await tmpRoot()
  try {
    await writeDaily('diaryDir', '2026-10-26', '更早', root)
    await writeDaily('diaryDir', '2026-10-28', '最近', root)
    const out = await toolFor(root).execute({ list: true })
    assert.equal(out.found, true)
    assert.match(out.text, /2026-10-28/)
    assert.match(out.text, /2026-10-26/)
    assert.doesNotMatch(out.text, /更早/)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('参数只认 YYYY-MM-DD：路径传不进来', async () => {
  const root = await tmpRoot()
  try {
    await writeDaily('diaryDir', '2026-10-28', '正常的一篇', root)
    const t = toolFor(root)
    for (const bad of ['../config', '../../events', 'diary/2026-10-28', '2026-10-28.md', '*']) {
      const out = await t.execute({ date: bad })
      assert.equal(out.found, false, `不该读 ${bad}`)
      assert.match(out.text, /YYYY-MM-DD/, `要告诉 ${bad} 怎么传`)
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('那天没写：说没写，并给出最近的一篇是哪天', async () => {
  const root = await tmpRoot()
  try {
    await writeDaily('diaryDir', '2026-10-28', '最近', root)
    const out = await toolFor(root).execute({ date: '2026-09-01' })
    assert.equal(out.found, false)
    assert.match(out.text, /2026-09-01 那天没有日记/)
    assert.match(out.text, /最近的一篇是 2026-10-28/)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('一篇都没写过：说没写过，不装作读了', async () => {
  const root = await tmpRoot()
  try {
    const out = await toolFor(root).execute({})
    assert.equal(out.found, false)
    assert.match(out.text, /还没写过日记/)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('太长的截到 DIARY_READ_MAX，并说明后面还有', async () => {
  const root = await tmpRoot()
  try {
    const long = '字'.repeat(DIARY_READ_MAX + 500)
    await writeDaily('diaryDir', '2026-10-28', long, root)
    const out = await toolFor(root).execute({})
    assert.equal(out.found, true)
    assert.match(out.text, /后面还有/)
    // 正文部分是第二行（后面那句提示单独一行，不算正文）
    assert.equal(out.text.split('\n')[1].length, DIARY_READ_MAX)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('renderDiary：三种结局各说各的话', () => {
  assert.match(renderDiary({ why: '打不开' }), /打不开/)
  assert.match(renderDiary({ dates: ['2026-10-28'] }), /- 2026-10-28/)
  assert.match(renderDiary({}), /还没写过日记/)
})

test('读旧日记时要给坐标和归属：第几天、前后写过哪天、那是你自己交的', () => {
  const text = renderDiary({
    date: '2026-11-02',
    text: '今天下雨。',
    dates: ['2026-11-03', '2026-11-02', '2026-10-28'],
    day: 9,
  })
  assert.match(text, /那天是你自己的第 9 天/, '天数才是她活过的时间')
  assert.match(text, /你一共写过 3 篇/)
  assert.match(text, /前一天 2026-10-28/)
  assert.match(text, /后一天 2026-11-03/)
  assert.match(text, /这些字是你自己交上去的/)
  // 不写"第 N 篇"：篇数是排班，不是经历
  assert.doesNotMatch(text, /第 d+ 篇/)
  // 不写任何评价性的"你成长了"
  assert.doesNotMatch(text, /成长|进步|你变了/)
})

test('只有一篇日记时：不编前后，仍说清归属', () => {
  const text = renderDiary({ date: '2026-11-02', text: '今天下雨。', dates: ['2026-11-02'], day: 3 })
  assert.match(text, /第 3 天/)
  assert.doesNotMatch(text, /前一天|后一天/)
  assert.match(text, /这些字是你自己交上去的/)
})

test('日期清单不该被坐标污染（list=true 走清单分支）', () => {
  const text = renderDiary({ dates: ['2026-10-28', '2026-11-02'], day: 9 })
  assert.match(text, /你写过日记的日子/)
  assert.doesNotMatch(text, /这些字是你自己交上去的/)
})

// ---------- 身份文档里必须写清「用哪个东西记」（2026-10-29，用户 m01296 A）----------
// 三天零篇的根因：常驻段只写了「每天我会记一笔」，没写机制。同一页的 SLEEP_BRIEF
// 写了 growth_commit / refs，她照着能交出来；日记这段没写，就一次也没试过。

test('同日追加太长时留「最后一段」：晚上补的那段不能被截掉（0.6.28）', async () => {
  const root = await tmpRoot()
  try {
    // 早上写一大段，晚上又补一段；合起来超上限
    await writeDaily('diaryDir', '2026-10-29', '早：' + '字'.repeat(DIARY_READ_MAX), root)
    await writeDaily('diaryDir', '2026-10-29', '晚：今天她又说了一句', root)

    const out = await toolFor(root).execute({ date: '2026-10-29' })
    assert.equal(out.found, true)
    assert.ok(out.text.includes('晚：今天她又说了一句'), '最新那段必须看得见')
    assert.match(out.text, /当天写了好几段/)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('DIARY_BRIEF 写了机制：growth_commit + type=diary', () => {
  assert.match(DIARY_BRIEF, /growth_commit/)
  assert.match(DIARY_BRIEF, /type=diary/)
})

test('这段机制句确实进身份文档（selfdoc 的 diary 分支还在）', async () => {
  const selfdoc = await readFile(new URL('../lib/selfdoc.js', import.meta.url), 'utf8')
  assert.ok(selfdoc.includes('if (diary) body.push(DIARY_BRIEF'), 'diary 开关仍然决定这一段进不进文档')
  const src = await readFile(new URL('../lib/persona.js', import.meta.url), 'utf8')
  assert.ok(src.includes('type=diary'), '机制句在 persona.js 里')
})

// ---------- 2026-11-10 外部用户：写到第 90 天就「看不了以前的日记」----------
// 根因不是没权限，是**没有索引**：清单静默截到 60 天（她以为那就是全部），
// 而工具只认日期——可她记不清的恰恰是日期。两处一起改：上限要说出来，再加按词找。

test('日期清单列不下时就明说还差几天，不静默截断', () => {
  const days = []
  for (let i = 0; i < DIARY_LIST_MAX + 12; i += 1) days.push(`2026-01-${String(i + 1).padStart(2, '0')}`)
  const text = renderDiary({ dates: days })
  assert.match(text, new RegExp(`更早的还有 12 天没列出来`), '截了就必须说')
  assert.match(text, /它们都还在/, '别让她以为更早的没了')
  assert.match(text, /给个词/, '告诉她还有按词找这条路')
  // 列出来的条数就是上限
  assert.equal((text.match(/^- 2026-/gm) ?? []).length, DIARY_LIST_MAX)
})

test('日期清单够短时不多嘴', () => {
  const text = renderDiary({ dates: ['2026-10-28', '2026-11-02'] })
  assert.doesNotMatch(text, /没列出来/)
})

test('按词找：每一处都说清哪一天、前后写了什么', async () => {
  const root = await tmpRoot()
  try {
    await writeDaily('diaryDir', '2026-10-20', '今天摔了一跤，又在同一个跟头栽了。', root)
    await writeDaily('diaryDir', '2026-10-28', '没提那个词。', root)
    await writeDaily('diaryDir', '2026-11-02', '他说他没松手，我想起那个跟头。', root)
    const out = await toolFor(root).execute({ keyword: '跟头' })
    assert.equal(out.found, true)
    assert.equal(out.keyword, '跟头')
    assert.match(out.text, /提到「跟头」的 2 处/, '数的是处，不是篇')
    assert.match(out.text, /- 2026-10-20 /)
    assert.match(out.text, /- 2026-11-02 /)
    assert.doesNotMatch(out.text, /2026-10-28/, '没提这个词的那天不该出现')
    assert.match(out.text, /同一个跟头栽了/, '要给她命中的那句话，不是只给日期')
    // 新的在前
    assert.ok(out.text.indexOf('2026-11-02') < out.text.indexOf('2026-10-20'))
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('按词找没命中：说没找到，绝不说「那天没有日记」', async () => {
  const root = await tmpRoot()
  try {
    await writeDaily('diaryDir', '2026-10-20', '今天摔了一跤。', root)
    const out = await toolFor(root).execute({ keyword: '跟头' })
    assert.equal(out.found, false)
    assert.equal(out.keyword, '跟头')
    assert.match(out.text, /没找到「跟头」/)
    assert.match(out.text, /翻得到的 1 篇日记里/)
    assert.doesNotMatch(out.text, /那天没有日记/)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('按词找 + 日期：只在那一天里找', async () => {
  const root = await tmpRoot()
  try {
    await writeDaily('diaryDir', '2026-10-20', '跟头。', root)
    await writeDaily('diaryDir', '2026-11-02', '又栽了一个跟头。', root)
    const out = await toolFor(root).execute({ keyword: '跟头', date: '2026-11-02' })
    assert.match(out.text, /提到「跟头」的 1 处/)
    assert.doesNotMatch(out.text, /- 2026-10-20/)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('按词找命中太多时说还有几处没列', async () => {
  const root = await tmpRoot()
  try {
    const many = Array.from({ length: DIARY_HIT_MAX + 5 }, (_, i) => `第 ${i} 个跟头。`).join('\n')
    await writeDaily('diaryDir', '2026-10-20', many, root)
    const out = await toolFor(root).execute({ keyword: '跟头' })
    assert.match(out.text, new RegExp(`还有 5 处没列`))
    assert.equal((out.text.match(/^- 2026-/gm) ?? []).length, DIARY_HIT_MAX)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('按词找的回执不说「那天没有日记」', async () => {
  // 那天她可能真写过，只是没提这个词——记成「那天没有日记」，
  // 她以后翻自己的回忆会以为自己那天没写（use.js 的 SAYING）。
  assert.equal(heardLine({ keyword: '跟头', found: false, text: '' }, 'her_diary'), '没找到。')
  assert.equal(heardLine({ keyword: '跟头', found: true, text: '' }, 'her_diary'), '找到了。')
  // 不带 keyword 时口径不变
  assert.equal(heardLine({ found: false, text: '' }, 'her_diary'), '那天没有日记。')
})
