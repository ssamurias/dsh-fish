/**
 * notify.test.mjs —— 说话提醒的三条约束（P3-3 重写后）
 *
 * 这个功能最危险的地方不是"弹不出来"，是"乱弹"，以及**静默失败**——原实现
 * 用隐藏 PowerShell 弹 WinRT Toast，被火绒拦下时代码拿不到任何错误，
 * `lastShown` 照写，当天就再也不会弹，而日志干干净净。
 *
 * 所以现在的测试重点全在**判据**上：她没说话、开关关着、今天已经提醒过、
 * 她的话不是今天的——一律不许 due。真弹一次仍然要靠人看屏幕，但"该不该弹"
 * 现在是纯函数，可以逐条钉死。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { snippet, shouldNotify, readPending, markShown, lastUtteranceToday } from '../lib/notify.js'
import { appendEvent, writeConfig } from '../lib/store.js'
import { loadConfig, updateConfig } from '../lib/settings.js'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'fish-notify-'))
  return { root, done: () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
}

/** 造一条她今天说过的话。ts 用本地时间，避免时区把它算到昨天。 */
function utt(root, text, at = new Date()) {
  return appendEvent(
    { type: 'utterance', text, source: 'her', day: 1, stage: 1 },
    { day: 1, stage: 1, now: at },
    root,
  )
}

test('snippet 把多行压成一行并按上限截断', () => {
  assert.equal(snippet('  第一行\n\n第二行   '), '第一行 第二行')
  assert.equal(snippet(''), '')
  const long = 'a'.repeat(200)
  const s = snippet(long, 20)
  assert.equal(s.length, 20)
  assert.ok(s.endsWith('…'))
})

test('开关默认关 → 不提醒', () => {
  const r = shouldNotify({
    events: [{ type: 'utterance', text: '我想说点什么', ts: new Date().toISOString() }],
    config: { notify: { enabled: false, lastShown: '' } },
    today: '2026-10-23',
  })
  assert.equal(r.due, false)
  assert.equal(r.why, '提醒是关着的')
})

test('她今天没说话 → 不提醒', () => {
  const r = shouldNotify({
    events: [{ type: 'seed', text: '你刚开始存在', ts: new Date().toISOString() }],
    config: { notify: { enabled: true, lastShown: '' } },
    today: '2026-10-23',
  })
  assert.equal(r.due, false)
  assert.equal(r.why, '她今天还没说话')
})

test('日记、信念、报告都不算"她开口"', () => {
  const now = new Date().toISOString()
  const r = shouldNotify({
    events: [
      { type: 'diary', text: '今天想了很多', ts: now },
      { type: 'revise', text: '我改主意了', ts: now },
      { type: 'narration', text: '叙述', ts: now },
    ],
    config: { notify: { enabled: true, lastShown: '' } },
    today: '2026-10-23',
  })
  assert.equal(r.due, false, '只有 type:utterance 才算开口')
})

test('她今天说了话 + 开关打开 → 该提醒，带最后一句', () => {
  const now = new Date()
  const dk = todayKey(now)
  const r = shouldNotify({
    events: [
      { type: 'utterance', text: '第一句', ts: new Date(now.getTime() - 60_000).toISOString() },
      { type: 'utterance', text: '最后这句才进通知', ts: now.toISOString() },
    ],
    config: { notify: { enabled: true, lastShown: '' } },
    today: dk,
  })
  assert.equal(r.due, true)
  assert.equal(r.text, '最后这句才进通知')
})

test('聊天行（uncommitted）不占一天一次的提醒，也不顶掉留话', () => {
  const now = new Date()
  const config = { notify: { enabled: true, lastShown: '' } }
  const today = todayKey(now)
  const chat = { type: 'utterance', text: '嗯，我在，你说。', ts: now.toISOString(), flags: ['uncommitted'] }
  const letter = { type: 'utterance', text: '这句是她留的话。', ts: now.toISOString() }

  const only = shouldNotify({ events: [chat], config, today })
  assert.equal(only.due, false, '刚在聊天里读过的回复不用再提醒')
  assert.equal(only.why, '她今天还没说话')

  const both = shouldNotify({ events: [letter, chat], config, today })
  assert.equal(both.due, true)
  assert.equal(both.text, '这句是她留的话。')
})

test('今天已经提醒过 → 同一天不再提醒第二次', () => {
  const now = new Date()
  const dk = todayKey(now)
  const r = shouldNotify({
    events: [{ type: 'utterance', text: '又想说', ts: now.toISOString() }],
    config: { notify: { enabled: true, lastShown: dk } },
    today: dk,
  })
  assert.equal(r.due, false)
  assert.equal(r.why, '今天已经提醒过一次')
})

test('她昨天说的话 → 今天不补弹（第二天看观测台就够了）', () => {
  const yesterday = new Date(Date.now() - 36 * 3600_000)
  const r = shouldNotify({
    events: [{ type: 'utterance', text: '昨晚说的', ts: yesterday.toISOString() }],
    config: { notify: { enabled: true, lastShown: '' } },
    today: todayKey(new Date()),
  })
  assert.equal(r.due, false)
  assert.equal(r.why, '她今天还没说话')
})

test('lastUtteranceToday 只认今天、只认 utterance、跳过空文本', () => {
  const now = new Date()
  const dk = todayKey(now)
  const got = lastUtteranceToday([
    { type: 'utterance', text: '   ', ts: now.toISOString() },
    { type: 'utterance', text: '有内容', ts: now.toISOString() },
    { type: 'utterance', text: '昨天', ts: new Date(now.getTime() - 36 * 3600_000).toISOString() },
  ], dk)
  assert.equal(got.text, '有内容')
})

test('readPending 读真状态库：默认关 → due:false', async () => {
  const { root, done } = await fixture()
  try {
    const p = await readPending(root)
    assert.equal(p.enabled, false)
    assert.equal(p.due, false)
    assert.equal(p.why, '提醒是关着的')
  } finally { await done() }
})

test('readPending 端到端：打开开关 + 她说了话 → due:true', async () => {
  const { root, done } = await fixture()
  try {
    await updateConfig({ notify: { enabled: true } }, root)
    await utt(root, '我今天看见一件事')
    const dk = todayKey(new Date())
    const p = await readPending(root, { today: dk })
    assert.equal(p.enabled, true)
    assert.equal(p.due, true, `应该有提醒，实际 why=${p.why}`)
    assert.equal(p.text, '我今天看见一件事')
  } finally { await done() }
})

test('markShown 记下今天，之后同一天不再 due', async () => {
  const { root, done } = await fixture()
  try {
    await updateConfig({ notify: { enabled: true } }, root)
    await utt(root, '说一句')
    const dk = todayKey(new Date())
    assert.equal((await readPending(root, { today: dk })).due, true)
    const m = await markShown(root, dk)
    assert.equal(m.ok, true)
    assert.equal((await readPending(root, { today: dk })).due, false)
    const { config } = await loadConfig(root)
    assert.equal(config.notify.lastShown, dk)
  } finally { await done() }
})

test('回写失败不抛：最多明天少提醒一次', async () => {
  // 造一个"一定写不进去"的 root：先建一个普通文件，再把它当目录用。
  // 以前写的是 'Z:/不存在的盘/…'，那只是 Windows 上的坏盘符；在 Linux/macOS
  // 上它是个相对路径，mkdir -p 会就地建出来，于是写入成功、断言反了。
  // 拿文件当父目录在两种平台上都会 ENOTDIR，才是真的"写不进去"。
  const dir = await mkdtemp(join(tmpdir(), 'fish-notify-bad-'))
  try {
    const blocker = join(dir, 'blocker')
    await writeFile(blocker, 'x')
    const r = await markShown(join(blocker, 'fish-notify'), '2026-10-23')
    assert.equal(r.ok, false)
    assert.equal(r.lastShown, '')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('不再有任何子进程路径：原 PowerShell 方案已删除', async () => {
  const fs = await import('node:fs/promises')
  const raw = await fs.readFile(new URL('../lib/notify.js', import.meta.url), 'utf8')
  // 注释里必须保留"为什么删掉"的说明，所以先剥注释再查代码。
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
  assert.ok(!/child_process/.test(code), '不能 import child_process')
  assert.ok(!/spawn\s*\(/.test(code), '不能 spawn 任何进程')
  assert.ok(!/EncodedCommand/.test(code), '不能再拼 PowerShell 命令')
  assert.ok(!/powershell/i.test(code), '代码里不该再出现 powershell')
  assert.ok(/^import/m.test(raw), '文件本身还是模块（防止测到空内容）')
})

/** 本地日期键。与 settings.dateKey 同口径，避免测试自己算错时区。 */
function todayKey(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
