// 运行日志的四条车道（2026-11-20，用户 m02056 A+B 日志体检）。
//
// 起因：真机上 3872 行日志里 95% 是 info，其中 207 行内容是「failed / 失败 /
// 没能 / 被拒」——级别这个词彻底失去意义，`grep warn` 一条真实失败都抓不到。
// 这一份钉住三件新东西：
//   1. levelLog(logger)：裸 log 函数末尾多写一个级别字，要真的换车道；
//   2. debugEnabled()：debug 默认不落盘，环境变量能打开；
//   3. shouldLogQuotaSkip() / isQuotaSkip()：额度满按天记一次，不是每个整点一条。
import test from 'node:test'
import assert from 'node:assert/strict'

import { debugEnabled, levelLog, logLine } from '../lib/log.js'
import { isQuotaSkip, shouldLogQuotaSkip } from '../lib/scheduler.js'

// ---- levelLog ----

function spyLogger() {
  const seen = []
  const at = (level) => (...a) => { seen.push([level, a.join(' ')]) }
  return { seen, logger: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') } }
}

test('levelLog：末尾写 debug，就落 debug 车道，那句字不进正文', () => {
  const { seen, logger } = spyLogger()
  const log = levelLog(logger)
  log('屋子就绪 · 工作区 abc', 'debug')
  assert.deepEqual(seen, [['debug', '屋子就绪 · 工作区 abc']])
})

test('levelLog：什么都不写时用默认级别（info）', () => {
  const { seen, logger } = spyLogger()
  levelLog(logger)('普通一行')
  assert.deepEqual(seen, [['info', '普通一行']])
})

test('levelLog：正文最后一个词恰好是 info 这种级别字，也要认', () => {
  // 这是有意为之：级别字只能是末尾那一个参数，正文里出现「debug」不受影响。
  const { seen, logger } = spyLogger()
  levelLog(logger)('她说了句 debug', 'debug')
  assert.deepEqual(seen, [['debug', '她说了句 debug']])
})

test('levelLog：warn 车道存在时优先用它', () => {
  const { seen, logger } = spyLogger()
  levelLog(logger, 'warn')('默认就是 warn')
  assert.deepEqual(seen, [['warn', '默认就是 warn']])
})

test('levelLog：logger 缺某个车道时回落到默认车道，不抛', () => {
  const seen = []
  const logger = { info: (...a) => seen.push(a.join(' ')) }
  const log = levelLog(logger)
  log('只有 info 车道', 'warn')
  assert.deepEqual(seen, ['只有 info 车道'])
})

// ---- debugEnabled ----

test('debugEnabled：默认关，认得 1/true/yes/on', () => {
  const old = process.env.DSH_FISH_LOG_DEBUG
  try {
    delete process.env.DSH_FISH_LOG_DEBUG
    assert.equal(debugEnabled(), false)
    for (const v of ['1', 'true', 'YES', 'On', ' true ']) {
      process.env.DSH_FISH_LOG_DEBUG = v
      assert.equal(debugEnabled(), true, v)
    }
    for (const v of ['0', 'no', 'off', '']) {
      process.env.DSH_FISH_LOG_DEBUG = v
      assert.equal(debugEnabled(), false, v)
    }
  } finally {
    if (old === undefined) delete process.env.DSH_FISH_LOG_DEBUG
    else process.env.DSH_FISH_LOG_DEBUG = old
  }
})

// ---- 额度类 skip 按天 ----

test('isQuotaSkip：只认「今日…已满」这一类，别的 skip 不算', () => {
  assert.equal(isQuotaSkip('今日事件已满(2/2)'), true)
  assert.equal(isQuotaSkip('今天已经说够了'), false)
  assert.equal(isQuotaSkip('还在冷却里'), false)
  assert.equal(isQuotaSkip(''), false)
})

test('shouldLogQuotaSkip：同一天同一句只记一次，换了日子才再记', () => {
  const first = shouldLogQuotaSkip('', '2026-11-20', '今日事件已满(2/2)')
  assert.match(first, /^2026-11-20\|今日事件已满/)
  assert.equal(shouldLogQuotaSkip(first, '2026-11-20', '今日事件已满(2/2)'), '')
  // 额度数字变了要再记一条：她那天的上限被改了，值得留痕。
  assert.match(shouldLogQuotaSkip(first, '2026-11-20', '今日事件已满(1/1)'), /1\/1/)
  // 第二天照常记。
  assert.match(shouldLogQuotaSkip(first, '2026-11-21', '今日事件已满(2/2)'), /^2026-11-21\|/)
})

// ---- say.js 的三个失败出口要留痕（2026-11-20，用户 m02976）----
//
// 这三个出口以前只写进返回值里那句提示：桥或客户端看到的是「她没反应」，
// 日志文件里一个字都没有，只能靠人复述。现在各记一行 warn。

test('say：空的一句、太长的一句、没有会话服务，都要在日志里留一行 warn', async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { sayToHer } = await import('../lib/say.js')
  const root = mkdtempSync(join(tmpdir(), 'dsh-fish-saylog-'))
  const file = join(root, 'logs', 'dsh-fish.log')
  try {
    const empty = await sayToHer({}, '   ', { root })
    assert.equal(empty.ok, false)

    const long = await sayToHer({}, 'x'.repeat(4001), { root })
    assert.equal(long.ok, false)

    const noSc = await sayToHer({}, '在吗', { root })
    assert.equal(noSc.ok, false)

    const text = readFileSync(file, 'utf8')
    assert.match(text, /\[warn\] say: 空的一句，没递出去/)
    assert.match(text, /\[warn\] say: 这句太长，没递出去/)
    assert.match(text, /4001\/4000 字/)
    assert.match(text, /\[warn\] say: 宿主没有会话服务，没递出去/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('say：群聊里的空文本是常态，不按失败记账', async () => {
  const { mkdtempSync, existsSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { sayToHer } = await import('../lib/say.js')
  const root = mkdtempSync(join(tmpdir(), 'dsh-fish-saylog2-'))
  const file = join(root, 'logs', 'dsh-fish.log')
  try {
    const r = await sayToHer({}, '   ', { root, scene: 'group', guest: true })
    assert.equal(r.ok, false)
    assert.equal(existsSync(file), false, '群聊空文本不该写日志：那是撤回提示那一类的常态')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})


// ---- 便条写不进去要留痕（2026-11-20，用户 m03134）----
//
// 便条是她最常用的功能之一。以前整份 notes.json 坏掉/写不动时，回给调用方的
// 只有一句「这张没记下来」，err 被吞掉——用户报「她记的便条没了」时日志里
// 查不到任何线索。现在四个入口各记一行 warn。

test('便条：写不进去时日志里留一行 warn，别只回一句「这张没记下来」', async () => {
  const { mkdtempSync, mkdirSync, readFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { addNote, dropNote } = await import('../lib/note.js')
  const root = mkdtempSync(join(tmpdir(), 'dsh-fish-notelog-'))
  // 把 notes.json 占成一个目录：readFile 会抛 EISDIR，正好是「整份读不动」那种故障。
  mkdirSync(join(root, 'notes.json'))
  try {
    const added = await addNote(root, { text: '明天问他那件事' })
    assert.equal(added.ok, false)
    assert.equal(added.note, '这张没记下来。')

    const dropped = await dropNote(root, { text: '明天问他那件事', reason: '不做了' })
    assert.equal(dropped.ok, false)

    const text = readFileSync(join(root, 'logs', 'dsh-fish.log'), 'utf8')
    assert.match(text, /\[warn\] 便条：记一张没成/)
    assert.match(text, /\[warn\] 便条：放下没成/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})


test('deliverQueued：该投却没投进去的句子，回 stuck>0（不然调用方分不清「队列空」和「没投进去」）', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { queueNote, deliverQueued } = await import('../lib/sessionnote.js')
  const root = mkdtempSync(join(tmpdir(), 'dsh-fish-stuck-'))
  const empty = mkdtempSync(join(tmpdir(), 'dsh-fish-stuck-empty-'))
  try {
    assert.equal((await queueNote(root, '有人回了你那句话')).ok, true)
    // 会话没开着：appendNote 回 ok:false，这一句算「该投却没投进去」
    const out = await deliverQueued({ id: 'not-open' }, root, { home: true })
    assert.equal(out.ok, true)
    assert.equal(out.delivered, 0)
    assert.equal(out.stuck, 1)

    // 队列本来就空：不算失败
    assert.deepEqual(await deliverQueued({ id: 'not-open' }, empty, { home: true }), {
      ok: true,
      delivered: 0,
      stuck: 0,
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(empty, { recursive: true, force: true })
  }
})

test('@ 正文没递进对话时，日志留一行 warn（不再只记「已经叫醒」）', async () => {
  const { deliverMentions } = await import('../lib/scheduler.js')
  const seen = []
  const log = (...a) => seen.push(['info', a.join(' ')])
  log.warn = (...a) => seen.push(['warn', a.join(' ')])
  await deliverMentions({
    root: '/tmp/dsh-fish-mentions-none',
    ctx: {},
    picked: [{ fromOwner: false, id: 1 }],
    agent: { id: 'a' },
    h: { sessionId: 's-her' },
    dk: '2026-11-20',
    config: {},
    busy: true,
    log,
    deps: { deliver: async () => { throw new Error('append 挂了') } },
  })
  assert.deepEqual(seen.map((x) => x[0]), ['warn'])
  assert.match(seen[0][1], /@ 正文没递进对话：append 挂了/)
})

test('logLine：debug 默认不写盘，打开开关才写', async () => {
  const { mkdtempSync, readFileSync, existsSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = mkdtempSync(join(tmpdir(), 'dsh-fish-log-'))
  const file = join(root, 'logs', 'dsh-fish.log')
  const old = process.env.DSH_FISH_LOG_DEBUG
  try {
    delete process.env.DSH_FISH_LOG_DEBUG
    logLine('debug', ['这句不该落盘'], root)
    assert.equal(existsSync(file), false, 'debug 关着时不该建日志文件')
    process.env.DSH_FISH_LOG_DEBUG = '1'
    logLine('debug', ['这句该落盘'], root)
    assert.match(readFileSync(file, 'utf8'), /这句该落盘/)
  } finally {
    if (old === undefined) delete process.env.DSH_FISH_LOG_DEBUG
    else process.env.DSH_FISH_LOG_DEBUG = old
    rmSync(root, { recursive: true, force: true })
  }
})
