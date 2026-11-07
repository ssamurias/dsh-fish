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

import { wishesOf, wishLine, wishTail, WISH_SHOW_MAX, WISH_TEXT_MAX } from '../lib/wish.js'
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

test('要的那件工具已经在她手上（issue #58）：不管怎么答的，都不再摆', () => {
  // need-tool 的裁决只记录、不落实权限（lib/ask.js），主人真要给只能在卡外面给
  // （装插件、放开工具），事件流里不会留下「已经给了」。以前这里不看她手上有什么，
  // 东西到了，桌上照样摆 14 天「他答应了，还没见到」、3 天「你问过，还没有答复」。
  const has = (name) => name === 'web_search'
  const wanted = ask({ id: 'a1', text: '想要一个能上网搜东西的工具', subject: 'web_search' })

  const approved = [wanted, answer({ id: 'x1', askId: 'a1', verdict: 'approve' })]
  assert.equal(wishesOf(approved, { now: NOW + 10 * DAY }).length, 1, '不传 has：一个字都不变')
  assert.equal(wishesOf(approved, { now: NOW + 10 * DAY, has }).length, 0, '到手了就不是「还没见到」')

  // 卡放一天没人答（按 pending 算），主人在别处把工具给了。
  const timedOut = [wanted, answer({ id: 'x1', askId: 'a1', verdict: 'later', via: 'timeout' })]
  assert.equal(wishesOf(timedOut, { now: NOW }).length, 1)
  assert.equal(wishesOf(timedOut, { now: NOW, has }).length, 0, '到手了就不是「还没有答复」')

  // 还没答、「以后再说」的也一样：东西已经在手上，这件事就办完了。
  assert.equal(wishesOf([wanted], { now: NOW, has }).length, 0)
  const later = [wanted, answer({ id: 'x1', askId: 'a1', verdict: 'later' })]
  assert.equal(wishesOf(later, { now: NOW + 10 * DAY, has }).length, 0)
})

test('has 只认 subject 正好是那个工具名；别的照摆，has 坏了也照摆', () => {
  const has = (name) => name === 'bili_watch'
  const events = [
    // 原话里提到了工具名，但 subject 写的是一件事：猜不准是不是同一样东西，照摆。
    ask({ id: 'a1', text: '想用 bili_watch 看整条视频', subject: '整条视频的画面', at: NOW - 2 * 3_600_000 }),
    // 到手了的那一件。
    ask({ id: 'a2', text: '想要能看视频画面的工具', subject: 'bili_watch', at: NOW - 3_600_000 }),
    // 没到手的那一件。
    ask({ id: 'a3', text: '想要一个能翻译的工具', subject: 'translate', at: NOW - 1000 }),
  ]
  assert.deepEqual(wishesOf(events, { now: NOW, has }).map((x) => x.id), ['a3', 'a1'])
  // 只有明确返回 true 才算到手；抛错、返回别的都按「不知道」，宁可多摆。
  const broken = () => { throw new Error('boom') }
  assert.deepEqual(wishesOf(events, { now: NOW, has: broken }).map((x) => x.id), wishesOf(events, { now: NOW }).map((x) => x.id))
  assert.deepEqual(wishesOf(events, { now: NOW, has: () => 1 }).map((x) => x.id), wishesOf(events, { now: NOW }).map((x) => x.id))
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
