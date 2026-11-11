import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeConfig, DEFAULTS, inWindow, dateKey, pickWakeTime, updateConfig, loadConfig, biliOn, CARRY_MAX } from '../lib/settings.js'
import { mkdtemp, rm, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('空配置得到完整默认值（含用户新加的 three 配额项）', () => {
  const c = normalizeConfig({})
  assert.equal(c.growthDays, 30)
  assert.equal(c.daily.events, 2, '2026-10-25 默认 1→2（配额修好之后）')
  assert.equal(c.daily.questions, 1)
  // daily.proactive 已并入 wakesPerDay（两个旋钮管同一件事，必有一个是死键）
  assert.equal(c.daily.proactive, undefined, 'proactive 不应再存在')
  assert.equal(c.wakesPerDay, 1, '唤醒次数唯一旋钮')
  assert.equal(c.diary.enabled, true)
  assert.equal(c.diary.visible, false, '日记默认不给看')
  assert.ok(Array.isArray(c.avoid.keywords) && c.avoid.keywords.includes('恐怖'))
})

test('部分配置自动补全其余键（可扩展性的核心）', () => {
  const c = normalizeConfig({ growthDays: 60, diary: { visible: true } })
  assert.equal(c.growthDays, 60)
  assert.equal(c.diary.visible, true)
  assert.equal(c.diary.enabled, true, '没传的键必须从默认值补回')
  assert.deepEqual(c.window, DEFAULTS.window)
})

test('未知键不会被丢弃（向前兼容：以后加的配置项老版本也不炸）', () => {
  const c = normalizeConfig({ somethingNew: { a: 1 } })
  assert.deepEqual(c.somethingNew, { a: 1 })
})

test('越界值被夹到合法区间', () => {
  const c = normalizeConfig({ growthDays: 9999, wakesPerDay: -5, daily: { events: 99 } })
  assert.equal(c.growthDays, 180)
  assert.equal(c.wakesPerDay, 0)
  assert.equal(c.daily.events, 6)
})

// 2026-11-11（外部用户反馈）：换会话带几轮原话要能调，上限跟 talkmem 的落盘上限是同一个数。
test('换会话带几轮原话：默认 4，夹在 0..CARRY_MAX', () => {
  assert.equal(normalizeConfig({}).chat.carry, 4)
  assert.equal(normalizeConfig({ chat: { carry: 99 } }).chat.carry, CARRY_MAX)
  assert.equal(normalizeConfig({ chat: { carry: -1 } }).chat.carry, 0)
  assert.equal(normalizeConfig({ chat: { carry: 7 } }).chat.carry, 7)
  // 写坏了不崩，回默认
  assert.equal(normalizeConfig({ chat: { carry: 'abc' } }).chat.carry, 4)
})

test('非法时间窗回落到默认，不抛错', () => {
  assert.deepEqual(normalizeConfig({ window: ['25:00', 'abc'] }).window, DEFAULTS.window)
  assert.deepEqual(normalizeConfig({ window: ['09:00', '09:00'] }).window, DEFAULTS.window)
  assert.deepEqual(normalizeConfig({ window: ['09:00', '12:30'] }).window, ['09:00', '12:30'])
})

test('黑名单可追加、去重、去空', () => {
  const c = normalizeConfig({ avoid: { keywords: ['恐怖', '恐怖', ' ', '新的禁忌'] } })
  assert.deepEqual(c.avoid.keywords, ['恐怖', '新的禁忌'])
})

test('inWindow 普通与跨零点都正确', () => {
  const at = (h, m) => new Date(2026, 9, 22, h, m)
  const day = normalizeConfig({ window: ['20:00', '23:00'] })
  assert.equal(inWindow(day, at(19, 59)), false)
  assert.equal(inWindow(day, at(20, 0)), true)
  assert.equal(inWindow(day, at(23, 0)), true)
  assert.equal(inWindow(day, at(23, 1)), false)

  const night = normalizeConfig({ window: ['22:00', '02:00'] })
  assert.equal(inWindow(night, at(23, 30)), true)
  assert.equal(inWindow(night, at(1, 30)), true)
  assert.equal(inWindow(night, at(12, 0)), false)
})

test('pickWakeTime 落在窗内', () => {
  const cfg = normalizeConfig({ window: ['20:00', '23:00'] })
  for (const s of [0, 0.25, 0.5, 0.999]) {
    const t = pickWakeTime(cfg, s)
    assert.ok(t >= 20 * 60 && t <= 23 * 60, `${t}`)
  }
})

test('dateKey 用本地时区', () => {
  assert.equal(dateKey(new Date(2026, 0, 5, 23, 59)), '2026-01-05')
})

test('updateConfig 是合并而不是覆盖，且落盘后能被 loadConfig 读回', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-cfg-'))
  try {
    await updateConfig({ growthDays: 45 }, root)
    await updateConfig({ diary: { visible: true } }, root)
    const { config } = await loadConfig(root)
    assert.equal(config.growthDays, 45, '第二次更新不该把第一次的改动冲掉')
    assert.equal(config.diary.visible, true)
    assert.equal(config.daily.events, 2, '默认值仍然在（2 条）')
    const onDisk = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'))
    assert.equal(onDisk.growthDays, 45)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('配置文件不存在时返回默认值，且不主动写盘', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-cfg2-'))
  try {
    const r = await loadConfig(root)
    assert.equal(r.fresh, true)
    await assert.rejects(readFile(join(root, 'config.json'), 'utf8'))
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('白名单解析：半角/全角逗号、空格、换行都算分隔，去重保序', async () => {
  const { parseToolNames } = await import('../lib/settings.js')
  assert.deepEqual(parseToolNames('skill, web_search，read_image\nskill'), ['skill', 'web_search', 'read_image'])
  assert.deepEqual(parseToolNames(''), [])
  assert.deepEqual(parseToolNames(null), [])
  assert.deepEqual(parseToolNames(['web_search', ' web_search ']), ['web_search'])
})

test('白名单校验：拼错的名字与不存在的工具都不许过，拿不到名单时不做存在性判断', async () => {
  const { validateToolNames } = await import('../lib/settings.js')
  const known = ['web_search', 'read_image', 'skill']

  const ok = validateToolNames('skill, read_image', known)
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.names, ['skill', 'read_image'])
  assert.equal(ok.checked, true)

  // 拼错一个字母：形状合法但名单里没有 —— 这正是会让她退回全量工具面的那种
  const typo = validateToolNames('web_serch', known)
  assert.equal(typo.ok, false)
  assert.deepEqual(typo.unknown, ['web_serch'])

  // 大写/空格/中文：连形状都不对
  const shape = validateToolNames('Web_Search', null)
  assert.equal(shape.ok, false)
  assert.deepEqual(shape.unknown, ['Web_Search'])

  // known 为 null：只做形状校验，checked:false（不把「不知道」当「不存在」）
  const blind = validateToolNames('some_future_tool', null)
  assert.equal(blind.ok, true)
  assert.equal(blind.checked, false)

  // 空输入永远合法（留空 = 不额外给）
  assert.equal(validateToolNames('', known).ok, true)
})

// ---- issue #38：带 BOM 的 JSON 不能被当成坏文件 ----
// PowerShell 5.1 的 `Set-Content -Encoding UTF8` 与记事本都会在开头写一个 U+FEFF。
// 以前 `readJson` 直接 JSON.parse → SyntaxError → 文件被改名成 `.corrupt.<时间>`，
// 配置回默认值（看起来像「设置全丢了」）、owner.json 变 null、home.json 变成新会话。
test('配置文件带 UTF-8 BOM 也要读得出来，不能当成坏文件改名', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-bom-'))
  try {
    const body = JSON.stringify({ growthDays: 66, diary: { visible: true } }, null, 2)
    await writeFile(join(root, 'config.json'), '\uFEFF' + body, 'utf8')

    const r = await loadConfig(root)
    assert.equal(r.fresh, false, '读到了文件，不是「没有配置文件」')
    assert.equal(r.broken, false, '也不是「文件坏了退回默认」')
    assert.equal(r.config.growthDays, 66, '值要读出来（修之前这里会退回默认 30）')
    assert.equal(r.config.diary.visible, true)

    // 关键：不能被改名成 .corrupt.*——那等于把她好好的设置封存掉
    const files = await readdir(root)
    assert.deepEqual(files.filter((f) => f.includes('.corrupt.')), [], `不该产生坏文件副本：${files.join(', ')}`)
    assert.ok(files.includes('config.json'), '原文件名要还在')
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

// ---- issue #62：上网开关只留一处判据 ----
// 以前四条路各认各的：看列表认 bili.enabled、看画面认 browse.enabled、身份文档认 browse.enabled、
// 说话认 comment.enabled。同一份配置能同时说「出不去」和「能出去」。
// 现在统一过 biliOn()：只有 bili.enabled === false 才算断网；没写这一节一律当开着。
test('biliOn：只有 bili.enabled 明确为 false 才算断网（issue #62）', () => {
  assert.equal(biliOn(undefined), true, '没有配置 = 没关过')
  assert.equal(biliOn({}), true)
  assert.equal(biliOn({ bili: {} }), true)
  assert.equal(biliOn({ bili: { enabled: true } }), true)
  assert.equal(biliOn({ bili: { enabled: false } }), false)
  // 别的开关不参与这个判断：它们各管一摊，在 biliOn 之后
  assert.equal(biliOn({ browse: { enabled: false } }), true)
  assert.equal(biliOn({ comment: { enabled: false } }), true)
})
