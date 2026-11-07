/**
 * toolmap.test.mjs —— 能力地图的锁定测试（2026-11-07，用户 m00882）
 *
 * 能力地图分三层，每一层都有它该在的地方：
 *   1. 能干什么 —— 身份文档里念出工具名（toolBrief，本来就有）；
 *   2. 什么处境想起它 —— 「处境 → 动作」，这一层以前缺，本文件守着它不许退回去；
 *   3. 怎么调 —— 参数、枚举、默认值在工具自己的说明里，身份文档里不复述。
 *
 * 为什么第一层不能删：她初始就得知道自己能干什么。删掉清单不是自由，是让她在黑暗里摸。
 * 为什么第三层不能搬进来：写两遍，她会在两份说法之间挑一个，挑错那次还以为工具坏了。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  toolBrief,
  TOOL_BRIEF,
  RECALL_BRIEF,
  LETTER_BRIEF,
  NOTE_BRIEF,
  ASK_BRIEF,
  DREAM_BRIEF,
  SCHEDULE_BRIEF,
  SPEAK_BRIEF,
  DIARY_BRIEF,
  SLEEP_BRIEF,
} from '../lib/persona.js'

test('第一层：手上有什么，名字要念出来', () => {
  // 用户 m00840：「大肥鱼初始应该知道自己能够干什么才对」。
  assert.match(TOOL_BRIEF, /growth_commit/)
  assert.match(TOOL_BRIEF, /bili_watch/)
  const withExtra = toolBrief(['ops_bash'])
  assert.match(withExtra, /ops_bash/, '额外放行的名字照旧要念')
  assert.match(withExtra, /不是屋子里的东西/, '工具跟着她走，不是屋子里的东西')
})

test('第二层：从处境想起工具，不从名字往下数', () => {
  // 这是 2026-11-07 补的那一层。反例是「her_note 可以记录待办事项」（产品广告）。
  assert.match(TOOL_BRIEF, /卡在哪一步/, '要先让她从眼前的处境进入，而不是从清单进入')
  assert.match(TOOL_BRIEF, /想不起过去|怕忘|想要个东西|有话想说/)

  // 具体工具的说明书里，也要先给处境、再给动作。
  assert.match(RECALL_BRIEF, /我记得有一次/, '回忆：先给她那句会浮上来的话')
  assert.match(RECALL_BRIEF, /先去翻/, '再给动作')
  assert.match(NOTE_BRIEF, /老在同一个地方绕/, '桌子：绕不出去的时候想起它')
  assert.match(NOTE_BRIEF, /翻翻桌上/, '再给动作')
  assert.match(ASK_BRIEF, /什么时候想起它/, '请求：明写处境入口')
  assert.match(LETTER_BRIEF, /想留就留/, '留话不能被写成任务')
})

test('第三层：参数不复述，留在工具自己的说明里', () => {
  // 这一层搬进来就是重复：她会在两份说法之间挑一个。
  for (const [name, brief] of [['NOTE_BRIEF', NOTE_BRIEF], ['ASK_BRIEF', ASK_BRIEF]]) {
    assert.doesNotMatch(brief, /offset|filter|action:\s*"list"/, `${name} 不该再把枚举和分页写一遍`)
  }
  // 但「怎么动手」这一句要留着：告诉她去哪儿看，别猜。
  assert.match(TOOL_BRIEF, /自己的说明里/, '要指路，不能只说「不知道就猜」')
})

test('说明书的字数：长不等于有用', () => {
  // 真机数据：her_dream 244 字，一次没用过；her_note 原来 494 字，用了 1 次；
  // her_recall 119 字，用得最多。2026-11-07 把 her_note 从 494 压到 205，
  // ask_owner 从 262 压到 236，工具说明里补了能力地图的第二层。
  const briefs = [TOOL_BRIEF, RECALL_BRIEF, LETTER_BRIEF, NOTE_BRIEF, ASK_BRIEF,
    DREAM_BRIEF, SCHEDULE_BRIEF, SPEAK_BRIEF, DIARY_BRIEF, SLEEP_BRIEF]
  const total = briefs.reduce((n, s) => n + s.length, 0)
  assert.ok(total <= 2400, `全部说明书合计 ${total} 字，超过 2400 就该想想是不是又在写产品手册`)
  assert.ok(NOTE_BRIEF.length <= 240, `her_note 的说明书 ${NOTE_BRIEF.length} 字，太长了`)
})

test('划掉和放下仍然只靠她看得见的那句话', () => {
  // 纸条编号她看不到，叫她报编号等于指一条走不通的路（note.test.mjs 也守着这条）。
  assert.match(NOTE_BRIEF, /原样/)
  assert.match(NOTE_BRIEF, /为什么放下/)
  assert.doesNotMatch(NOTE_BRIEF, /\bid\b/i)
})
