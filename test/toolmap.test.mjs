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

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  toolBrief,
  TOOL_BRIEF,
  RECALL_BRIEF,
  LETTER_BRIEF,
  NOTE_BRIEF,
  APPOINT_BRIEF,
  ASK_BRIEF,
  DREAM_BRIEF,
  PROACTIVE_BRIEF,
  SCHEDULE_BRIEF,
  SPEAK_BRIEF,
  DIARY_BRIEF,
  SLEEP_BRIEF,
} from '../lib/persona.js'
import { LOOK_BRIEF } from '../lib/browse.js'
import { PRONOUN_ASK_BRIEF } from '../lib/pronounask.js'
import { SCENE_TOOLS } from '../lib/toolreg.js'
import { renderSelfDoc } from '../lib/selfdoc.js'
import { deriveSelf } from '../lib/derive.js'

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
  assert.match(NOTE_BRIEF, /老在同一个地方绕/, '便条：绕不出去的时候想起它')
  assert.match(NOTE_BRIEF, /翻翻便条/, '再给动作')
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

// ---------------------------------------------------------------- 每个原生工具都要有一张地图
//
// 2026-11-09（用户 m00002）：他问「原生带的工具是不是每一件都有能力地图」。
// 查下来 her_appoint 一个字都没有，growth_commit / bili_watch / bili_look / her_diary
// 只有一句用途、没有「什么时候想起它」。所以下面这张表不是记录现状，是**新工具的必填项**：
// 源码里多出一个 defineTool、这里没登记，本文件就红。
//
// 「我做过的事」不在这张表里：它不是手写段，由 lib/use.js 的 use: 账反推，
// 没记过就整节不写。那条链路由 capability.test.mjs 守着，不要在这里复制一份。

const LIB = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib')

/** 源码里真正注册的工具名：以 lib/*.js 的 defineTool 为准，不信任何手抄清单。 */
function definedTools() {
  const names = new Set()
  for (const file of readdirSync(LIB).filter((n) => n.endsWith('.js'))) {
    const src = readFileSync(join(LIB, file), 'utf8')
    for (const m of src.matchAll(/defineTool\(\{\s*name:\s*'([a-z_]+)'/g)) names.add(m[1])
  }
  return [...names].sort()
}

/**
 * 一件家里能用的工具一行：[工具名, 说明书所在的那一段, 处境句的正则]。
 *
 * 顺序就是能力地图的顺序：先处境、再动作；参数不在这里（第三层测试守着）。
 * 新工具必须在这里加一行——不是「建议」，`definedTools()` 会对账。
 */
const MAP = [
  ['growth_commit', TOOL_BRIEF, /有一句话想留下/],
  ['bili_watch', TOOL_BRIEF, /画面里到底是什么/],
  ['bili_sub', TOOL_BRIEF, /到底说了哪几句/],
  ['her_recall', RECALL_BRIEF, /我记得有一次/],
  ['her_leave', LETTER_BRIEF, /什么时候想起它/],
  ['her_note', NOTE_BRIEF, /老在同一个地方绕/],
  ['her_appoint', APPOINT_BRIEF, /什么时候想起它/],
  ['ask_owner', ASK_BRIEF, /什么时候想起它/],
  ['ask_pronoun', PRONOUN_ASK_BRIEF, /什么时候想起它/],
  ['her_dream', DREAM_BRIEF, /什么时候想起它/],
  ['her_say', PROACTIVE_BRIEF, /什么时候想起它/],
  ['bili_speak', SPEAK_BRIEF, /什么时候想起它/],
  ['her_diary', DIARY_BRIEF, /什么时候想起它/],
  ['bili_look', LOOK_BRIEF, /什么时候想起它/],
]

test('能力地图的登记表：原生工具一个不漏，场景工具单独登记', () => {
  const names = definedTools()
  const home = new Set(MAP.map(([name]) => name))
  const scene = new Set(Object.keys(SCENE_TOOLS))
  for (const name of names) {
    assert.ok(
      home.has(name) || scene.has(name),
      `工具 ${name} 没有能力地图：在 MAP 或 SCENE_TOOLS 里给它一行，别让它悄悄长出来`,
    )
  }
  assert.equal(
    new Set([...home, ...scene]).size,
    names.length,
    '登记表里的名字必须和源码里的 defineTool 一模一样（改名了也要跟着改）',
  )
  assert.ok(scene.has('bring_back'), 'bring_back 只在出门时给，不能混进家里的身份文档')
})

test('能力地图：每件工具都先讲处境，再讲怎么用', () => {
  for (const [tool, brief, cue] of MAP) {
    assert.match(brief, cue, `${tool} 的说明里找不到「什么处境想起它」这一句`)
    assert.ok(brief.includes(tool), `${tool} 的说明书里连名字都没提`)
  }
})

test('身份文档：家里能用的一个不少，场景工具一个不提', () => {
  // 开关全开，取「她能拿到的最大那一份」。少一个名字，她就有一只自己不知道的手。
  const doc = renderSelfDoc(deriveSelf([]), {
    budget: 8000,
    browse: true,
    speak: true,
    diary: true,
    dream: true,
    proactive: true,
    schedule: true,
    restricted: false,
  })
  for (const [tool] of MAP) {
    assert.ok(doc.includes(tool), `身份文档里少了 ${tool}：她手里有、文档却不说，伸手就会以为工具坏了`)
  }
  for (const tool of Object.keys(SCENE_TOOLS)) {
    assert.ok(!doc.includes(tool), `${tool} 只在出门时给；家里写进文档等于告诉她有、伸手却没有`)
  }
})
