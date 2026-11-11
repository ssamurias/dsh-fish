/**
 * log.test.mjs —— 运行日志（2026-10-24 加）
 *
 * 这里测的不是"能写"。能写是显然的。要钉住的是三条容易悄悄坏掉的性质：
 *   1. **永不抛**：盘满、目录没了、root 是怪值，都不能连带让插件挂掉。
 *   2. **脱敏**：cookie 一类的值进不了日志文件。这条一旦失效，用户把日志导出发给
 *      别的 AI 排查的同时就把账号送出去了。
 *   3. **导出包不含不该外带的东西**：配置里的 cookie 字段、owner 里的凭据。
 *
 * 另外一个反直觉的规矩也要钉：**日志没有开关**。没有 `log.enabled` 这种配置键——
 * 出事那一刻才发现日志关着，是最常见的一种后悔。测试直接断言 DEFAULTS 里没这组。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  LOG_MAX_BYTES,
  LINE_MAX,
  buildBundle,
  clearLog,
  logBoot,
  logLine,
  logFile,
  makeLogger,
  redactConfig,
  scrub,
  tailEvents,
  tailLog,
} from '../lib/log.js'
import { DEFAULTS } from '../lib/settings.js'
import { validateEvent } from '../lib/schema.js'
import { readEvents } from '../lib/store.js'
import { withUse } from '../lib/use.js'
import { addNote } from '../lib/note.js'
import { makeAppointment } from '../lib/appoint.js'

async function tempRoot() {
  return await mkdtemp(join(tmpdir(), 'fish-log-'))
}

test('写一行就能读回来，带级别与时间戳', async () => {
  const root = await tempRoot()
  assert.equal(logLine('info', ['你好'], root), true)
  const tail = tailLog(root)
  assert.equal(tail.exists, true)
  assert.equal(tail.lines.length, 1)
  assert.match(tail.lines[0], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[info\] 你好$/)
})

test('tailLog 只给最后 N 行，并且丢掉被截断的半截首行', async () => {
  const root = await tempRoot()
  for (let i = 0; i < 12; i += 1) logLine('info', [`第 ${i} 行`], root)
  const tail = tailLog(root, { lines: 3 })
  assert.equal(tail.lines.length, 3)
  assert.match(tail.lines[2], /第 11 行/)
  // maxBytes 小到切在行中间时，第一行必须是完整的行（不能以半句开头）
  const cut = tailLog(root, { lines: 5, maxBytes: 40 })
  for (const line of cut.lines) assert.match(line, /^\d{4}-\d{2}-\d{2} /)
})

test('没有日志文件时不抛，如实说没有', async () => {
  const root = await tempRoot()
  const tail = tailLog(root)
  assert.equal(tail.exists, false)
  assert.deepEqual(tail.lines, [])
  assert.equal(tail.bytes, 0)
})

test('root 是怪值也永不抛（日志坏了不能连带插件挂掉）', () => {
  // 用一段既不像路径、Windows 上又确实建不出来的串
  const bad = 'D:\\u0000nul\\\u0000bad'
  assert.doesNotThrow(() => logLine('error', ['写不进去也没关系'], bad))
  assert.equal(logLine('info', ['x'], bad), false)
  assert.doesNotThrow(() => tailLog(bad))
  assert.doesNotThrow(() => clearLog(bad))
})

test('Error 对象只留 message 与栈的前两帧，不整段倒进来', async () => {
  const root = await tempRoot()
  const err = new Error('屋子没接上')
  logLine('warn', [err], root)
  const line = tailLog(root).lines[0]
  assert.match(line, /屋子没接上/)
  assert.ok(line.length < LINE_MAX, '一行不能超长')
})

test('超长参数被截断到 LINE_MAX 以内', async () => {
  const root = await tempRoot()
  logLine('info', ['x'.repeat(50_000)], root)
  const line = tailLog(root).lines[0]
  assert.ok(line.length <= LINE_MAX + 40, `实际 ${line.length}`)
})

test('cookie 值在写盘前被抹掉', async () => {
  const root = await tempRoot()
  logLine('info', ['Cookie: SESSDATA=abcdef123456; bili_jct=deadbeef99'], root)
  const line = tailLog(root).lines[0]
  assert.doesNotMatch(line, /abcdef123456/)
  assert.doesNotMatch(line, /deadbeef99/)
  assert.match(line, /SESSDATA=\*\*\*/)
})

test('裸长串也抹：40 位以上且字母数字混杂的当凭据处理', () => {
  assert.equal(scrub('t=AbCdEf0123456789AbCdEf0123456789AbCdEf01'), 't=***')
  // 纯字母的长串更可能是路径或标识符，不清洗（清洗过头会毁掉排查信息）
  assert.match(scrub('a'.repeat(45)), /^a+$/)
})

test('自家的会话 id 与事件 id 不能被当成凭据抹掉（2026-10-29 用户 m02241）', () => {
  // 病根：规则②「40 位以上字母数字混杂」把 `session-<uuid>` 整条抹成 ***，
  // 于是日志里到处是「会话 ***」「woke ***」，要查「是哪条会话出的问题」时
  // 日志一个字都给不出，只能翻 outings.json 反推。
  const sid = 'session-058a9c4d-0999-4772-8264-c289f799fd09'
  assert.equal(scrub(`出门：装配完成 会话 ${sid}`), `出门：装配完成 会话 ${sid}`)
  assert.equal(scrub('woke session-abc123 test_first'), 'woke session-abc123 test_first')
  const evId = 'ev_01M62M5R78EJRR5P3393B80R22'
  assert.equal(scrub(`标记 ${evId}`), `标记 ${evId}`)
  // 但真凭据还是要抹：会话 id 放行不等于放行 cookie
  // 注意用 `session=` 而不是 `sid=`——`sid=` 是 cookie 参数名，规则①会连值一起抹掉
  // （那是 0.1.x 起的凭据规则，行为正确，不改）。
  const mixed = scrub(`SESSDATA=abcdef123456&bili_jct=deadbeef99&session=${sid}`)
  assert.doesNotMatch(mixed, /abcdef123456/)
  assert.doesNotMatch(mixed, /deadbeef99/)
  assert.match(mixed, /SESSDATA=\*\*\*/)
  assert.match(mixed, /session-058a9c4d/, '同一行里的会话 id 仍要留着')
})

test('export 里不留配置与 owner 的凭据', () => {
  const cfg = { comment: { enabled: true }, cookie: 'SESSDATA=xxx', owner: { mid: '1', cookie: 'SESSDATA=yyy' } }
  const out = redactConfig(cfg)
  assert.equal(out.cookie, '***')
  assert.equal(out.owner.cookie, '***')
  assert.equal(out.owner.mid, '1', 'mid 不是凭据，要留着')
  assert.equal(cfg.cookie, 'SESSDATA=xxx', '不能改原对象')
})

test('buildBundle 的段落顺序按"排查时最先想看什么"排', async () => {
  const root = await tempRoot()
  logBoot(root, '0.1.0 · test')
  const text = buildBundle(root, {
    version: '0.1.0',
    checks: { summary: '10 项里 9 项正常', items: [{ id: 'cookie', ok: false, label: '登录', detail: '还没存', fix: '贴上 cookie' }] },
    restrict: { applied: 1, allow: ['growth_commit'], guard: true, why: '' },
    lines: 20,
  })
  const iSelf = text.indexOf('--- 自检 ---')
  const iLog = text.indexOf('--- 日志')
  assert.ok(iSelf > 0 && iLog > iSelf, '自检要在日志前面')
  assert.match(text, /BAD 登录: 还没存 \| 修法: 贴上 cookie/)
  assert.match(text, /工具面: 已收窄/)
  assert.match(text, /插件版本: 0\.1\.0/)
})

test('清空是真的清空，之后再写还能写', async () => {
  const root = await tempRoot()
  logLine('info', ['一'], root)
  assert.deepEqual(clearLog(root), { ok: true, cleared: true })
  assert.equal(tailLog(root).lines.length, 0)
  logLine('info', ['二'], root)
  assert.equal(tailLog(root).lines.length, 1)
  // 文件不存在时清空也算成功（幂等）
  assert.deepEqual(clearLog(root).ok, true)
})

test('超过上限会轮转，旧内容进 .1 而不是被丢掉', async () => {
  const root = await tempRoot()
  const file = logFile(root)
  // 目录由第一条日志创建，所以这里要自己先建（顺手钉住"目录不存在时 logLine 自己会建"）
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, 'x'.repeat(LOG_MAX_BYTES + 10), 'utf8')
  logLine('info', ['轮转之后'], root)
  const rotated = await readFile(`${file}.1`, 'utf8')
  assert.ok(rotated.length >= LOG_MAX_BYTES, '.1 里应是那份超限的旧日志')
  assert.match(tailLog(root).lines.join('\n'), /轮转之后/)
})

test('makeLogger 同时写文件与转发宿主；宿主 logger 抛错也不影响写盘', async () => {
  const root = await tempRoot()
  const seen = []
  const ctx = { logger: { info: (...a) => seen.push(a.join(' ')), warn: () => { throw new Error('宿主坏了') } } }
  const log = makeLogger(ctx, root)
  log.info('第一次')
  assert.doesNotThrow(() => log.warn('第二次'))
  const lines = tailLog(root).lines
  assert.equal(lines.length, 2, '两次都要落盘')
  assert.deepEqual(seen, ['第一次'])
})

test('ctx 里没有 logger 也能用（测试环境与极老宿主）', async () => {
  const root = await tempRoot()
  const log = makeLogger(undefined, root)
  assert.doesNotThrow(() => log.info('照写'))
  assert.equal(tailLog(root).lines.length, 1)
})

test('日志没有开关：DEFAULTS 里不存在 log 这组配置', () => {
  assert.equal('log' in DEFAULTS, false, '有开关就等于允许"出事那一刻才发现日志关着"')
})

test('tailEvents：给事件流尾部，且丢掉被截断的半截首行', async () => {
  const root = await tempRoot()
  const file = join(root, 'events.jsonl')
  const rows = []
  for (let i = 0; i < 8; i += 1) rows.push(JSON.stringify({ type: 'meta', text: `watched:2026-10-28 BV1xx411c7m${i}` }))
  writeFileSync(file, rows.join('\n') + '\n', 'utf8')
  const ev = tailEvents(root, { lines: 3 })
  assert.equal(ev.exists, true)
  assert.equal(ev.lines.length, 3)
  assert.match(ev.lines[2], /BV1xx411c7m7/)
  // 没有这个文件也要如实说没有，不抛
  const none = tailEvents(join(root, 'nope'))
  assert.equal(none.exists, false)
  assert.deepEqual(none.lines, [])
})

test('导出里把「配置允许」与「实际生效」分开写（另一台机器的排查就栽在只有前者）', async () => {
  const root = await tempRoot()
  const text = buildBundle(root, {
    version: '0.6.2',
    restrict: { applied: 1, allow: ['growth_commit', 'her_recall', 'read_image'], effective: ['growth_commit'], guard: true, why: 'applied' },
  })
  assert.match(text, /配置允许 3 个/)
  assert.match(text, /实际生效: 1 个（growth_commit）/)
  assert.match(text, /名单里没生效的: her_recall \/ read_image/)
})

test('没收窄时导出明说「她看得见全部工具」，不是「允许 0 个」', async () => {
  const root = await tempRoot()
  const text = buildBundle(root, {
    version: '0.6.2',
    restrict: { applied: 0, allow: ['growth_commit', 'read_image'], effective: [], guard: true, why: 'deferred' },
  })
  assert.match(text, /未收窄/)
  assert.match(text, /实际生效: 没收窄 —— 这一局她看得见全部工具/)
})

test('导出里带模型与图像输入（看不见画面有一半原因是模型不吃图）', async () => {
  const root = await tempRoot()
  const yes = buildBundle(root, { model: { provider: 'deepseek', model: 'v4-flash', imageInput: true } })
  assert.match(yes, /模型: deepseek \/ v4-flash · 图像输入: 支持/)
  const no = buildBundle(root, { model: { provider: 'x', model: 'y', imageInput: false } })
  assert.match(no, /图像输入: 不支持/)
  // 说不准就写说不准，不能替人家宣布「不支持」
  const maybe = buildBundle(root, { model: { provider: '', model: '', imageInput: null, why: '读不到' } })
  assert.match(maybe, /图像输入: 说不准/)
})

test('导出里带事件流尾部：watched: 这种计数只在事件流里，日志文件里一个字都没有', async () => {
  const root = await tempRoot()
  logBoot(root, '0.6.2 · test')
  writeFileSync(join(root, 'events.jsonl'), JSON.stringify({ type: 'meta', text: 'watched:2026-10-28 BV1xx411c7mD' }) + '\n', 'utf8')
  const text = buildBundle(root, { version: '0.6.2', lines: 5, eventLines: 5 })
  const iEv = text.indexOf('--- 事件流')
  const iLog = text.indexOf('--- 日志')
  assert.ok(iEv > 0, '要有事件流段')
  assert.ok(iLog > iEv, '事件流在日志前面')
  assert.match(text, /watched:2026-10-28 BV1xx411c7mD/)
})

test('导出的事件流不带正文：设置页答应了「不含正文」「没有她说过的话」', async () => {
  const root = await tempRoot()
  const opts = { day: 1, stage: 1, source: 'system' }
  // 走真的 validateEvent：refuse.quote、ask.subject 这些带原话的字段，形状才和落盘一样。
  // 只删 text 挡不住它们，所以这里要钉的是「白名单之外一个字都不出去」。
  const rows = [
    validateEvent({ type: 'utterance', text: '合成甲句她说的话', flags: ['uncommitted'] }, opts),
    validateEvent({ type: 'heard', text: '合成乙句他说的话' }, opts),
    validateEvent({ type: 'refusal', text: '我不想看合成丙号视频' }, opts),
    validateEvent({
      type: 'ask',
      text: '合成丁句请求的话',
      ask: { kind: 'rule', subject: '合成戊号请求标题', reason: '合成己号请求理由', options: ['合成庚号选项'] },
    }, opts),
  ]
  const meta = JSON.stringify({ type: 'meta', text: 'watched:2026-10-28 BV1xx411c7mD' })
  const broken = '{"type":"utterance","text":"合成辛句写了半截'
  const bareJson = JSON.stringify('合成壬句裸字符串')
  const bareArray = JSON.stringify(['合成癸句数组里'])
  const noType = JSON.stringify({ text: '合成子句缺字段' })
  const noFlags = JSON.stringify({ id: 'ev-no-flags', ts: '2026-11-05T00:00:00.000Z', type: 'utterance', text: '合成丑句没有标记' })
  const lines = [...rows.map((r) => JSON.stringify(r)), meta, broken, bareJson, bareArray, noType, noFlags]
  writeFileSync(join(root, 'events.jsonl'), lines.join('\n') + '\n', 'utf8')

  const text = buildBundle(root, { lines: 5, eventLines: 60 })

  for (const word of ['甲句', '乙句', '丙号', '丁句', '戊号', '己号', '庚号', '辛句', '壬句', '癸句', '子句', '丑句']) {
    assert.equal(text.includes(word), false, `导出里不该出现「${word}」`)
  }
  // 纯记账的 meta 原样留着：watched: 这种计数只在事件流里，日志文件里没有
  assert.ok(text.includes(meta), '记账的 meta 行要原样留着')
  // 排查还要看得出「哪一条、什么时候、什么类型、多长」，否则这段尾巴就白带了
  const out = text.split('\n')
  const row = JSON.parse(out.find((l) => l.includes(rows[0].id)))
  assert.deepEqual(Object.keys(row).sort(), ['flags', 'id', 'textLen', 'ts', 'type'])
  assert.equal(row.type, 'utterance')
  assert.equal(row.ts, rows[0].ts)
  assert.deepEqual(row.flags, ['uncommitted'])
  assert.equal(row.textLen, rows[0].text.length)
  // 坏行不原样抄，只说它有多长
  assert.ok(out.includes(`(坏行，长 ${broken.length} 字符，内容不导出)`), '解析不了的行只留长度')
  assert.ok(out.includes(`(坏行，长 ${bareJson.length} 字符，内容不导出)`), '不是对象的行也算坏行')
  assert.ok(out.includes(`(坏行，长 ${bareArray.length} 字符，内容不导出)`), '数组也算坏行，不要出一行空壳')
  assert.ok(out.includes(`(坏行，长 ${noType.length} 字符，内容不导出)`), '没有 type 的对象也算坏行，不要出 {} 这种空壳')
  // 缺 flags 的行形状也要稳：有 type 就留，flags 补成空数组
  const short = JSON.parse(out.find((l) => l.includes('ev-no-flags')))
  assert.deepEqual(short.flags, [])
  assert.equal(short.textLen, '合成丑句没有标记'.length)
})

// ---- meta 行的白名单（use: 这类记账是「meta 行原样留」之后才加的） ----

function eventSection(text) {
  const out = text.split('\n')
  const from = out.findIndex((l) => l.startsWith('--- 事件流（'))
  const to = out.findIndex((l, i) => i > from && l.startsWith('--- '))
  return out.slice(from + 1, to < 0 ? undefined : to).filter((l) => l !== '')
}

test('导出不带她记下的原文：her_note / her_appoint 的 use: 行只留「工具 + 成没成」', async () => {
  const root = await tempRoot()
  // 走真的 addNote / makeAppointment 和真的 withUse：回执的 echo 就是她写的原文，
  // use.js 的 heardLine 优先拿它拼进 `use:<工具> ok <那句>`。
  const note = withUse({ name: 'her_note', execute: (a) => addNote(root, a) }, { root, tool: 'her_note' })
  const appoint = withUse({ name: 'her_appoint', execute: (a) => makeAppointment(root, a) }, { root, tool: 'her_appoint' })
  const due = new Date(Date.now() + 3 * 86_400_000)
  const dk = `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, '0')}-${String(due.getDate()).padStart(2, '0')}`
  assert.equal((await note.execute({ text: '合成寅句只想自己记着的话' }, undefined)).ok, true)
  assert.equal((await appoint.execute({ what: '合成卯句约好要做的事', due: dk }, undefined)).ok, true)

  // 先确认前提：原文真的在事件流的 use: 行里（否则下面的「不出现」是空过）
  const { events } = await readEvents(root)
  const uses = events.filter((e) => e.type === 'meta' && String(e.text).startsWith('use:'))
  assert.equal(uses.length, 2)
  assert.ok(uses[0].text.includes('寅句') && uses[1].text.includes('卯句'), '事件流里的 use: 行带着原文')

  const text = buildBundle(root, { lines: 5, eventLines: 60 })
  assert.equal(text.includes('寅句'), false, '导出里不该出现便条原文')
  assert.equal(text.includes('卯句'), false, '导出里不该出现约定原文')
  // 排查要的那一半还在：哪个工具、成没成、什么时候、后半句多长
  const rows = eventSection(text).map((l) => JSON.parse(l))
  assert.equal(rows.length, 2)
  assert.deepEqual(Object.keys(rows[0]).sort(), ['flags', 'id', 'text', 'textLen', 'ts', 'type'])
  assert.equal(rows[0].id, uses[0].id)
  assert.equal(rows[0].ts, uses[0].ts)
  assert.equal(rows[0].textLen, uses[0].text.length)
  assert.equal(rows[0].text, `use:her_note ok（后面 ${uses[0].text.length - 'use:her_note ok'.length} 字不导出）`)
  assert.match(rows[1].text, /^use:her_appoint ok（后面 \d+ 字不导出）$/)
})

test('导出的 meta 行：夹着人写的字的只留头和长度，不认识的前缀也一样', async () => {
  const root = await tempRoot()
  const opts = { day: 1, stage: 1, source: 'system' }
  const mk = (text) => validateEvent({ type: 'meta', text }, opts)
  const rows = [
    mk('use:her_say fail 合成辰句没说出去的话'),
    mk('use:her_note\tok 合成巳句形状不对的账'),
    mk('proactive-say:2026-11-05:合成午句为什么现在想说'),
    mk('selfrule:合成未句她请求的规矩'),
    mk('import-name:合成申号名字'),
    mk('import-mark:合成酉号来源'),
    mk('someday-new:合成戌句以后才加的记账'),
    mk('合成亥句没有前缀的一行'),
  ]
  writeFileSync(join(root, 'events.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')

  const text = buildBundle(root, { lines: 5, eventLines: 60 })
  for (const word of ['辰句', '巳句', '午句', '未句', '申号', '酉号', '戌句', '亥句']) {
    assert.equal(text.includes(word), false, `导出里不该出现「${word}」`)
  }
  const got = eventSection(text).map((l) => JSON.parse(l))
  assert.deepEqual(got.map((r) => r.text.replace(/（后面 \d+ 字不导出）$/, '')), [
    'use:her_say fail',
    'use:',
    'proactive-say:2026-11-05:',
    'selfrule:',
    'import-name:',
    'import-mark:',
    'someday-new:',
    '',
  ])
  got.forEach((r, i) => {
    assert.equal(r.id, rows[i].id)
    assert.equal(r.textLen, rows[i].text.length)
    assert.match(r.text, /（后面 \d+ 字不导出）$/)
  })
})

test('导出的 meta 行：纯记账的原样留着，没有后半句的也不动', async () => {
  const root = await tempRoot()
  const opts = { day: 1, stage: 1, source: 'system' }
  const plain = [
    'sched:2026-11-05 2026-11-05T02:30:00.000Z',
    'wake:2026-11-05 table',
    'wakefail:2026-11-05 屋子没接上，这次没开口',
    'fired:first_look',
    'quiet:2026-11-05 无候选模板，今天不打扰',
    'sleep:2026-11-05',
    'think:2026-11-05',
    'table:2026-11-05',
    'rest:2026-11-05',
    'drive-spend:2026-11-05:1762300000000',
    'proactive-turn:2026-11-05:1762300000000',
    'proactive-silent:2026-11-05:1762300000000',
    'digest:2026-11-05 BV1xx411c7mD BV1xx411c7mE',
    'rotate:40:sess-1',
    'hand:2026-11-05 BV1xx411c7mD',
    'browse:2026-11-05 [{"bvid":"BV1xx411c7mD","title":"合成标题"}]',
    'browse-more:2026-11-05 [{"bvid":"BV1xx411c7mE","title":"合成标题"}]',
    'browsed:BV1xx411c7mD',
    'looked:BV1xx411c7mD 合成标题',
    'look:2026-11-05 BV1xx411c7mD {"title":"合成标题","up":"合成作者","duration":60,"view":1}',
    'watched:2026-11-05 BV1xx411c7mD {"title":"合成标题","up":"合成作者","duration":60,"view":1}',
    'hook:1',
    'comment:2026-11-05 BV1xx411c7mD 123',
    'creply:2026-11-05 BV1xx411c7mD 123 456 owner',
    'cseen:2026-11-05 456',
    'seen:2026-11-05T02:30:00.000Z',
    'diary:2026-11-05 trip:t1',
    'letter:2026-11-05:ev_1',
    'react:ev_1:like',
    'ask-ok:ev_1',
    'ask-no:ev_1',
    'ask-later:ev_1',
    'ask-time:ev_1 {"wakesPerDay":2}',
    'outing-reject:ev_1 ev_2',
    'outing-keep:ev_1',
    'possess-reject:ev_1',
    'possess-keep:ev_1',
    'absence-reject:ev_1',
    '家换了：甲 → 乙。这不是搬家——旧家的东西还在旧地方，没有并过来；这边从一开始就是新的。',
    // 整行就是头的：没有可藏的，照原样
    'use:bili_search ok',
    'proactive-say:2026-11-05:free',
    'import-mark:',
  ]
  const lines = plain.map((t) => JSON.stringify(validateEvent({ type: 'meta', text: t }, opts)))
  writeFileSync(join(root, 'events.jsonl'), lines.join('\n') + '\n', 'utf8')

  const got = eventSection(buildBundle(root, { lines: 5, eventLines: 100 }))
  assert.deepEqual(got, lines)
})
