/**
 * wish.test.mjs —— 「够不着的那件事」（2026-11-07，用户 m01602 拍板 B + D）
 *
 * 守什么：
 *   1. 只认她自己开的 `need-tool` 卡——不猜、不抽标签、不编主题。
 *   2. 三种结局三种活法：没答摆 3 天、「以后再说」摆 30 天、他答应了摆 14 天、
 *      「这次不行」不摆（再提就成了追问）。
 *   3. 同一件事反复问只摆最近那一张，最多摆两条。
 *   4. 它并进桌子（desk.js），也回灌到劲儿里（drive.js）。
 *   5. 撤掉每轮常量的 TOOL_ASK_NOTE 之后，撞墙那句只在 blockedTalk() 出现。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { wishesOf, wishLine, wishTail, toolArrived, WISH_SHOW_MAX, WISH_TEXT_MAX } from '../lib/wish.js'
import { deskFor } from '../lib/desk.js'
import { driveOf, deskHasMaterial, DRIVE } from '../lib/drive.js'
import { blockedTalk } from '../lib/restrict.js'

const DAY = 86_400_000
const NOW = Date.parse('2026-11-07T12:00:00+08:00')
const iso = (ms) => new Date(ms).toISOString()

function ask({ id, text, subject = '', kind = 'need-tool', at = NOW - 3_600_000 }) {
  return { id, type: 'ask', ts: iso(at), text, ask: { kind, subject, options: [], reason: '', askId: '', verdict: null, via: '' } }
}
function answer({ id, askId, verdict, at = NOW - 1_800_000, via = 'ui' }) {
  return { id, type: 'answer', ts: iso(at), text: '', ask: { askId, verdict, via } }
}

test('只认 need-tool：别的卡不上桌', () => {
  const events = [
    ask({ id: 'a1', text: '想要一个能看全片的工具' }),
    ask({ id: 'a2', text: '想改作息', kind: 'time' }),
    ask({ id: 'a3', text: '想要一个文件', kind: 'need-file' }),
  ]
  const w = wishesOf(events, { now: NOW })
  assert.deepEqual(w.map((x) => x.id), ['a1'])
})

test('原话照抄，不改写；太长就截断加省略号', () => {
  const long = '想'.repeat(WISH_TEXT_MAX + 20)
  const w = wishesOf([ask({ id: 'a1', text: `  ${long}  ` })], { now: NOW })
  assert.equal(w.length, 1)
  assert.equal(w[0].text.length, WISH_TEXT_MAX)
  assert.ok(w[0].text.endsWith('…'))
})

test('三种结局三种活法：没答 3 天、以后再说 30 天、答应了 14 天', () => {
  const base = [ask({ id: 'a1', text: '想要一个能看全片的工具' })]

  // 没答：3 天内摆，第 4 天就不摆了。
  assert.equal(wishesOf(base, { now: NOW }).length, 1)
  assert.equal(wishesOf(base, { now: NOW + 4 * DAY }).length, 0)

  // 「以后再说」：十天前说的还摆着（30 天窗口）。
  const later = [...base, answer({ id: 'x1', askId: 'a1', verdict: 'later' })]
  assert.equal(wishesOf(later, { now: NOW + 10 * DAY }).length, 1)
  assert.equal(wishesOf(later, { now: NOW + 31 * DAY }).length, 0)

  // 他答应了：14 天窗口。
  const ok = [...base, answer({ id: 'x1', askId: 'a1', verdict: 'approve' })]
  assert.equal(wishesOf(ok, { now: NOW + 10 * DAY }).length, 1)
  assert.equal(wishesOf(ok, { now: NOW + 15 * DAY }).length, 0)
})

test('放一天没人答的卡不被说成「他说以后再说」：仍是还没有答复，3 天窗口', () => {
  // 真机数据就这么记：verdict:'later' + via:'timeout' + text:'一直没人答'。
  // later 是为了不再反复追问同一张卡，不是谁答应了什么；按 later 念出来是编的。
  const events = [
    ask({ id: 'a1', text: '想要一个能看全片的工具' }),
    answer({ id: 'x1', askId: 'a1', verdict: 'later', via: 'timeout' }),
  ]
  const w = wishesOf(events, { now: NOW })
  assert.equal(w.length, 1)
  assert.equal(w[0].verdict, 'pending')
  assert.equal(w[0].tail, '你问过，还没有答复')
  assert.equal(wishesOf(events, { now: NOW + 4 * DAY }).length, 0, '还是 3 天窗口，不是 30 天')
})

// issue #58：卡上答「可以」不发权限，他只能在卡外给（装插件 / 加白名单），
// 事件流里一个字都不记。所以「还在不在手上」要看白名单，不能只看 ask/answer。
test('工具已经到手就不再摆「他答应了，还没见到」（issue #58）', () => {
  const events = [
    ask({ id: 'a1', text: '想要个能查 npm 版本的东西', subject: 'npm_view' }),
    answer({ id: 'x1', askId: 'a1', verdict: 'approve' }),
  ]
  // 不传 has：老调用点行为不变，照摆 14 天
  assert.equal(wishesOf(events, { now: NOW + 10 * DAY }).length, 1)
  // 传 has：已经在手上，一句都不该再摆
  assert.equal(wishesOf(events, { now: NOW + 10 * DAY, has: new Set(['npm_view']) }).length, 0)
  // 手上别的东西不关这条的事
  assert.equal(wishesOf(events, { now: NOW + 10 * DAY, has: ['bili_look'] }).length, 1)
  // 函数写法也认（scheduler 想现查也行）
  assert.equal(wishesOf(events, { now: NOW + 10 * DAY, has: (n) => n === 'npm_view' }).length, 0)
})

// issue #83：真实数据里 subject 常写成「某工具：做什么」，精确比对永远对不上。
test('subject 里带着工具名也算到手——「her_note 的读取：…」（issue #83）', () => {
  const events = [
    ask({ id: 'a1', text: '想让她能列出还没划掉的那些', subject: 'her_note 的读取：列出还没划掉的那些' }),
    answer({ id: 'x1', askId: 'a1', verdict: 'approve' }),
  ]
  const has = ['bring_back', 'her_note', 'her_say', 'bili_look', 'bili_watch', 'ops_bash', 'read_image', 'ask_owner']
  assert.equal(wishesOf(events, { now: NOW + 10 * DAY, has }).length, 0, '句子里带着工具名，也算到手')
  // 名字前后紧贴着字母/数字/下划线时不算：her_note 不该被 her_notes 命中
  assert.equal(wishesOf(events, { now: NOW + 10 * DAY, has: ['her_notes'] }).length, 1)
  // 4 个字以下的名字不参与这种比对（`her` 在中文句子里太容易撞）
  const short = [{ ...events[0], ask: { ...events[0].ask, subject: '想要 her 那种东西' } }, events[1]]
  assert.equal(wishesOf(short, { now: NOW + 10 * DAY, has: ['her'] }).length, 1)
  // 函数写法列不出名单，只认整句——猜不了就不猜
  assert.equal(wishesOf(events, { now: NOW + 10 * DAY, has: (n) => n === 'her_note' }).length, 1)
  // 他答了、东西也到了，桌子与劲儿都该空
  assert.equal(deskHasMaterial({ wish: wishesOf(events, { now: NOW + 10 * DAY, has }).length }), false)
})

// 收窄关着时 has 是她这一局看得见的全部工具，里面有宿主的 read / edit / bash 这类 4 个字的短名。
// 她要一样还没有的东西时，常拿手上已经有的作比较；点到的是比较对象，不是她要的那件。
test('subject 中间拿手上的工具作比较，不算到手——只认开头的工具名（issue #83 的后续）', () => {
  const has = new Set(['read', 'edit', 'write', 'grep', 'glob', 'bash', 'im_send', 'her_note', 'bili_look', 'ask_owner'])
  const subjects = [
    '能看 PDF 里图片的工具（read 只给我文字）',
    '像 bash 那样能跑 python 的东西',
    '能 edit 图片的工具',
    '能看整条视频的（bili_look 只给几张截图）',
  ]
  for (const subject of subjects) {
    const events = [ask({ id: 'a1', text: `想要：${subject}`, subject })]
    assert.equal(wishesOf(events, { now: NOW, has }).length, 1, `「${subject}」要的东西还没有，卡得摆着`)
    assert.equal(toolArrived(events[0], has), false, `「${subject}」：悬着的事（looseEnds）也不能撤`)
  }
  // 劲儿那一处同样只看这张卡在不在：撤掉了就不会因为它推她醒。
  const one = [ask({ id: 'a1', text: '想要能看图的', subject: '能看 PDF 里图片的工具（read 只给我文字）' })]
  assert.equal(deskHasMaterial({ wish: wishesOf(one, { now: NOW, has }).length }), true)
})

test('开头写着工具名照旧算到手：空白、引号、括号先跳过；4 个字以下的名字在开头也不认', () => {
  const has = ['her_note', 'bili_look', 'bili_look_at', 'read']
  const arrived = [
    'her_note：列出还没划掉的那些',
    'her_note的读取',
    '  `her_note` 的读取',
    '「her_note」能列出来',
    '（bili_look_at）看某一秒',
    'read',
    'read 的翻页',
  ]
  for (const subject of arrived) {
    const e = ask({ id: 'a1', text: '想要', subject })
    assert.equal(toolArrived(e, has), true, `「${subject}」开头就是她手上的工具`)
    assert.equal(wishesOf([e], { now: NOW, has }).length, 0, `「${subject}」到手了就不摆`)
  }
  // 开头的名字后面紧贴着字母/数字/下划线：是另一个名字，不算
  assert.equal(toolArrived(ask({ id: 'a1', text: '想要', subject: 'her_notes 的整理' }), has), false)
  assert.equal(toolArrived(ask({ id: 'a1', text: '想要', subject: 'reader 那种' }), has), false)
  // 短名哪怕在开头也不参与这种比对
  assert.equal(toolArrived(ask({ id: 'a1', text: '想要', subject: 'her 那种东西' }), ['her']), false)
})

test('超时那种也一样：后来在别处给了，就别再摆「你问过，还没有答复」（issue #58）', () => {
  const events = [
    ask({ id: 'a1', text: '想要能看整条视频的工具', subject: 'bili_watch' }),
    answer({ id: 'x1', askId: 'a1', verdict: 'later', via: 'timeout' }),
  ]
  assert.equal(wishesOf(events, { now: NOW + 2 * DAY }).length, 1)
  assert.equal(wishesOf(events, { now: NOW + 2 * DAY, has: ['bili_watch'] }).length, 0)
  // 桌上是空的，劲儿也不该靠它推她醒
  assert.equal(deskHasMaterial({ wish: wishesOf(events, { now: NOW + 2 * DAY, has: ['bili_watch'] }).length }), false)
  assert.equal(deskHasMaterial({ wish: wishesOf(events, { now: NOW + 2 * DAY }).length }), true)
})

test('没填工具名的那张不拿空串去比对（issue #58）', () => {  // subject 为空 = 她只写了一句话，没点名要什么；空串不能当成一个「已经有的工具」
  const events = [ask({ id: 'a1', text: '想要个什么都行' })]
  assert.equal(wishesOf(events, { now: NOW, has: (n) => n === '' }).length, 1)
  assert.equal(wishesOf(events, { now: NOW, has: [''] }).length, 1)
})

test('判断坏掉时宁可多摆一条，不能把她的心事静默吞掉（issue #58）', () => {
  const events = [
    ask({ id: 'a1', text: '想要个能查 npm 版本的东西', subject: 'npm_view' }),
    answer({ id: 'x1', askId: 'a1', verdict: 'approve' }),
  ]
  const boom = () => { throw new Error('白名单还没读出来') }
  assert.equal(wishesOf(events, { now: NOW, has: boom }).length, 1)
})

test('调度器摆桌子、算劲儿、散尾三处都拿白名单剔一遍（issue #58 / PR #70）', () => {
  // 只看三处的写法：每一处的 has 都得来自 toolInHandNow，劲儿那一处允许拿白名单顶，
  // 另外两处按探活拿到的那条会话算。三处真跑起来剔得对不对，见 test/wish-inhand.test.mjs。
  // 注释先去掉：注释里提一句 toolInHandNow( 不该算一处调用。
  const src = readFileSync(new URL('../lib/scheduler.js', import.meta.url), 'utf8')
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/[ \t]\/\/ .*$/gm, '')
  const calls = code.match(/(?<!function )\btoolInHandNow\(/g) ?? []
  assert.equal(calls.length, 3, '漏一处，桌上还会摆已经到手的东西')
  assert.match(code, /const hasForDrive = toolInHandNow\(homeSid, \{ unverified: true \}\)/, '劲儿：家里那条，核实不了先拿白名单顶')
  assert.match(code, /wish: wishesOf\(events, \{ now, has: hasForDrive \}\)/, '劲儿：算出来的要真传给 wishesOf')
  assert.match(code, /looseEnds\(events, \{ now, has: toolInHandNow\(sessionId, \{ agent: live\.agent \}\) \}\)/, '主动回合：悬着的事按接上的那条会话剔')
  assert.match(code, /wishes: wishesOf\(evc, \{ now: now\.getTime\(\), has: toolInHandNow\(sessionId, \{ agent: live\.agent \}\) \}\)/, '叫醒：桌子按接上的那条会话剔')
})

test('「这次不行」不摆：不同意就是不问了，再提一次就成了追问', () => {
  const events = [ask({ id: 'a1', text: '想要一个能看全片的工具' }), answer({ id: 'x1', askId: 'a1', verdict: 'reject' })]
  assert.equal(wishesOf(events, { now: NOW }).length, 0)
})
test('收尾只陈述结局，不给建议', () => {
  assert.equal(wishTail('approve'), '他答应了，还没见到')
  assert.equal(wishTail('later'), '他说以后再说')
  assert.equal(wishTail('reject'), '那次不行')
  assert.equal(wishTail(''), '你问过，还没有答复')
  assert.doesNotMatch(Object.values(['approve', 'later', 'reject', ''].reduce((o, k) => ({ ...o, [k]: wishTail(k) }), {})).join(), /你可以|应该|值得/)
})

test('同一件事反复问只摆最近那一张，最多摆两条', () => {
  // 同一件事问过两次：只留最近那一张，不摆两遍。
  const same = [
    ask({ id: 'a1', text: '想要一个能看全片的工具', subject: '整条视频的画面', at: NOW - 10 * DAY }),
    ask({ id: 'a2', text: '想要看全片的工具', subject: '整条视频的画面', at: NOW - 2 * DAY }),
  ]
  const s = wishesOf(same, { now: NOW })
  assert.equal(s.length, 1)
  assert.equal(s[0].id, 'a2', '同一件事留最近的')

  // 四件不同的事：最多摆两条，且摆最近那两条。
  const many = [
    ask({ id: 'b1', text: '想要一个能看全片的工具', subject: '看全片', at: NOW - 10 * DAY }),
    ask({ id: 'b2', text: '想要记住东西的地方', subject: '记事', at: NOW - 3 * DAY }),
    ask({ id: 'b3', text: '想要一个能翻译的工具', subject: '翻译', at: NOW - 1 * DAY }),
    ask({ id: 'b4', text: '想要一个能搜图的工具', subject: '搜图', at: NOW - 1000 }),
  ]
  const m = wishesOf(many, { now: NOW })
  assert.equal(m.length, WISH_SHOW_MAX)
  assert.deepEqual(m.map((x) => x.id), ['b4', 'b3'])
})

test('墙上那一行：原话 + 结局，括号包着', () => {
  const line = wishLine({ text: '有没有办法让我看整条视频的画面', tail: '他说以后再说' })
  assert.equal(line, '- 「有没有办法让我看整条视频的画面」（他说以后再说）')
  assert.equal(wishLine({ text: '', tail: 'x' }), '')
})

test('并进桌子：它和好奇事、旧句子并排，不另起一段', () => {
  const desk = deskFor({
    gaps: [{ text: '我到底想做什么', hits: 2, lastAt: NOW - 2 * DAY }],
    wishes: [{ text: '有没有办法让我看整条视频的画面', tail: '他说以后再说' }],
    at: NOW,
  })
  assert.match(desk, /桌上摊着这几样东西/)
  assert.match(desk, /我到底想做什么/)
  assert.match(desk, /有没有办法让我看整条视频的画面/)
  assert.match(desk, /他说以后再说/)
  // 只摆一条：再多就成了许愿清单。
  const many = deskFor({
    wishes: [
      { text: '第一件够不着的事', tail: 'a' },
      { text: '第二件完全不同的事', tail: 'b' },
    ],
    at: NOW,
  })
  assert.match(many, /第一件够不着的事/)
  assert.doesNotMatch(many, /第二件完全不同的事/)
})

test('不传 wishes 时桌子行为一个字都不变', () => {
  const desk = deskFor({ gaps: [{ text: '我到底想做什么', hits: 1, lastAt: NOW - DAY }], at: NOW })
  assert.equal(desk, '桌上还有一件你反复问起的事：\n- 「我到底想做什么」（昨天）')
})

test('回灌到劲儿里：桌上有这件够不着的事，就算有材料，也多攒一点', () => {
  const events = [
    // 出生 + 刚动过：把底噪压到最低，只看冲动那一笔。
    { id: 'e0', type: 'meta', ts: iso(NOW - 10 * DAY), text: 'drive-spend:' },
    { id: 'e1', type: 'meta', ts: iso(NOW - 3 * 3600_000), text: 'drive-spend:' },
  ]
  const without = driveOf({ events, now: NOW, desk: { gaps: 0, stale: 0, echo: false, favorite: false } })
  const withWish = driveOf({ events, now: NOW, desk: { gaps: 0, stale: 0, echo: false, favorite: false, wish: 1 } })
  assert.equal(without.boosts, 0)
  assert.equal(withWish.boosts, DRIVE.boostWish)
  assert.equal(deskHasMaterial({ wish: 1 }), true)
  assert.equal(deskHasMaterial({ wish: 0 }), false)
})

test('撞墙那句只在被拦住时说（B），并且前缀不变', () => {
  const said = blockedTalk(['bili_look'])
  // 前缀是别的守卫、界面、日志认它用的，不许动。
  assert.match(said, /^这件事我做不到。/)
  assert.match(said, /能用的只有：bili_look/)
  assert.match(said, /要是你确实想要，说出来就行/)
  // 空名单也得给这条路，否则她被挡住时连一句可做的都没有。
  assert.match(blockedTalk([]), /要是你确实想要，说出来就行/)
})

test('每轮常量的「缺工具就开口要」已经撤掉：不再有那个导出', () => {
  const proactive = readFileSync(new URL('../lib/proactive.js', import.meta.url), 'utf8')
  assert.doesNotMatch(proactive, /export const TOOL_ASK_NOTE/)
  const scheduler = readFileSync(new URL('../lib/scheduler.js', import.meta.url), 'utf8')
  // 注释里可以提它为什么消失；但代码里不许再 import 它、也不许再把它摆进正文。
  assert.doesNotMatch(scheduler, /import[^\n]*TOOL_ASK_NOTE/)
  assert.doesNotMatch(scheduler, /parts\.push\([^\n]*TOOL_ASK_NOTE/)
  assert.match(scheduler, /wishes: wishesOf\(/)
})
