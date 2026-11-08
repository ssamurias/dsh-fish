/**
 * 定时提醒（0.8.1，用户 m04335）。
 *
 * 背景：宿主本来就有定时任务（`@deepseek-ai/dsh-tool-schedule`），到期把一段
 * 固定框的提醒以 user 消息投回**创建它的那条会话**。插件这边做三件事：
 *   1. 默认**不**把 `schedule_*` 放进她的工具面（用户 m04504：默认工具数不变，
 *      谁想用谁自己加白名单）——但用户加进 `config.tools.allow` 之后必须真的生效；
 *   2. 只有放行时才告诉她怎么定、到点怎么做（「出门/请神/歇着时先记下别做」）；
 *   3. 别把定时消息算成主人说话（turns 的轮数）。
 *
 * 宿主侧行为（投递、框、时区）不在这里测——那是宿主的事，真验证要靠真机建一条任务。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { HER_TOOLS, SCHEDULE_TOOLS, toolSurfaceText } from '../lib/restrict.js'
import { SCHEDULE_BRIEF, scheduleBrief } from '../lib/persona.js'
import { classifyMessage } from '../lib/turns.js'

const here = dirname(fileURLToPath(import.meta.url))
const libDir = join(here, '..', 'lib')

test('默认不放：四个定时工具不在 HER_TOOLS 里（默认工具数保持不变）', () => {
  for (const n of ['schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete']) {
    assert.ok(SCHEDULE_TOOLS.includes(n), `清单里得留着 ${n}`)
    assert.ok(!HER_TOOLS.includes(n), `${n} 不该默认出现：谁想用，自己加白名单（m04504）`)
  }
})

test('用户放行之后，「我手边有什么」那一段会把它念出来', () => {
  const txt = toolSurfaceText([...HER_TOOLS, 'schedule_create'])
  assert.ok(txt.includes('schedule_create'), '放行之后提示词必须点名，否则她不知道自己能定')
  assert.ok(!toolSurfaceText(HER_TOOLS).includes('schedule_create'), '没放行时不许提')
})

test('说明书讲清三件事：怎么定、到点怎么做、出门时先别做', () => {
  assert.ok(SCHEDULE_BRIEF.includes('schedule_create'))
  assert.ok(/每天|daily|at/.test(SCHEDULE_BRIEF), '得写清时间怎么写')
  assert.ok(SCHEDULE_BRIEF.includes('定时消息'), '到点来的是什么，要先说清')
  assert.ok(SCHEDULE_BRIEF.includes('出门'), '宿主投递不经过插件的闸门，这条只能靠她记住')
  assert.ok(SCHEDULE_BRIEF.includes('不替你记成长'), '别让她以为提醒做完就自动算成长')
})

test('身份文档只在放行时挂这段说明书，而且只写真的放行的那几个', () => {
  const src = readFileSync(join(libDir, 'selfdoc.js'), 'utf8')
  assert.ok(/import .*scheduleBrief/.test(src), 'selfdoc 得 import 它')
  assert.ok(/scheduleNames\.length \? \[scheduleBrief\(scheduleNames\)/.test(src), '得按实际放行的名字现拼，不能写死四个')
  assert.ok(src.includes('SCHEDULE_NAMES.includes(n)'), '判据要读白名单里的 schedule_*')
  // 只放 schedule_create 时，说明书里不能出现另外三个
  const one = scheduleBrief(['schedule_create'])
  assert.ok(one.includes('schedule_create'))
  assert.ok(!one.includes('schedule_list'), '没放行的工具不能念给她听')
})

test('设置页只在放行时改口说「她能自己定提醒」', () => {
  const src = readFileSync(join(libDir, 'client.js'), 'utf8')
  assert.ok(src.includes('scheduleOn'), '卡片文案要按白名单分叉')
  assert.ok(src.includes('默认不放，工具数不变'), '没放行时要说清怎么开')
})

test('定时消息不算主人说话：轮数不乱涨', () => {
  assert.equal(classifyMessage({ source: { kind: 'schedule' } }), 'context')
  // 对照：真人打的字仍要算
  assert.equal(classifyMessage({ source: { kind: 'user', rpcId: 'uuid-9', clientTimeZone: 'Asia/Shanghai' } }), 'human')
})
