/**
 * budget.test.mjs —— 单轮回复字数预算（2026-10-25）
 *
 * 这条设置是**环境参数**，不是人格设置：它只描述"这一轮最多写多少字"，
 * 0 = 提示词里完全不出现任何长度要求（默认）。
 * 守门要点：这段文字不能回到 say.js 的 user 消息里拼身份，
 * 所以它单独放在 lib/budget.js，say.js 只从那儿取。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { lengthBudget } from '../lib/budget.js'
import { normalizeConfig } from '../lib/settings.js'

const SRC = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')

test('lengthBudget：0 / 负数 / 非数字 → 空串（默认不提任何长度）', () => {
  assert.equal(lengthBudget(0), '')
  assert.equal(lengthBudget(undefined), '')
  assert.equal(lengthBudget(null), '')
  assert.equal(lengthBudget(-30), '')
  assert.equal(lengthBudget('abc'), '')
})

test('lengthBudget：正数 → 说清字数，并且要求别注水', () => {
  const s = lengthBudget(120)
  assert.ok(s.includes('120 字'), '要说清多少字')
  assert.ok(s.includes('说重点'), '要压注水')
  assert.equal(lengthBudget('300'), lengthBudget(300), '字符串数字也应认')
})

test('配置层：chat.replyChars 有夹值，ui.ownerHintDismissed 布尔化', () => {
  assert.equal(normalizeConfig({}).chat.replyChars, 0, '默认不限')
  assert.equal(normalizeConfig({ chat: { replyChars: -5 } }).chat.replyChars, 0)
  assert.equal(normalizeConfig({ chat: { replyChars: 9999 } }).chat.replyChars, 2000)
  assert.equal(normalizeConfig({ chat: { replyChars: 120 } }).chat.replyChars, 120)
  assert.equal(normalizeConfig({}).ui.ownerHintDismissed, false)
  assert.equal(normalizeConfig({ ui: { ownerHintDismissed: 'yes' } }).ui.ownerHintDismissed, true)
  assert.equal(normalizeConfig({ ui: { ownerHintDismissed: 0 } }).ui.ownerHintDismissed, false)
})

test('generator：唤醒消息按配置带上预算', () => {
  const src = SRC('../lib/generator.js')
  assert.ok(src.includes("import { lengthBudget } from './budget.js'"))
  assert.ok(src.includes('budget: cfg?.chat?.replyChars'), 'pick 要把预算传进 safePrompt')
  assert.ok(src.includes('lengthBudget(ctx.budget)'), 'safePrompt 要自己判断有没有预算')
})

test('say.js：递话时也带预算，但不许把身份拼回去', () => {
  const src = SRC('../lib/say.js')
  assert.ok(src.includes("import { lengthBudget } from './budget.js'"), '从 budget.js 取，不要从 persona.js')
  assert.ok(src.includes('lengthBudget(config?.chat?.replyChars)'))
  assert.ok(!src.includes("from './persona.js'"), 'say.js 不许 import persona（会把身份塞回 user 消息）')
  assert.ok(!src.includes('TOOL_BRIEF'))
})

test('客户端：有这一项设置、也有登录提示卡与「不用了」', () => {
  const src = SRC('../lib/client.js')
  assert.ok(src.includes("label: S('她一轮最多写多少字')"))
  assert.ok(src.includes('replyChars: Number(replyChars)'), '要进 buildConfig 才会存盘')
  assert.ok(src.includes("[S('她一轮最多写多少字'), replyChars, 0, 2000]"), '越界报错里的名字跟控件上的一样')
  assert.ok(src.includes('还没存 B 站登录'))
  assert.ok(src.includes('ownerHintDismissed: true'))
  assert.ok(src.includes('不用了'))
  assert.ok(!src.includes("label: '每轮最多写多少字'"), '界面文案用她的视角，别用系统视角')
})
