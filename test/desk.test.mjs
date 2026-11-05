import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DESK_GAP_FREE,
  DESK_GAP_NORMAL,
  DESK_LINE_CLIP,
  DESK_STALE_FREE,
  deskFor,
} from '../lib/desk.js'
import { curiosityOf } from '../lib/curiosity.js'
import { staleLines } from '../lib/dreamtable.js'
import { deskHasMaterial } from '../lib/drive.js'
import { interestOf, topicLabel } from '../lib/interest.js'

const NOW = Date.parse('2026-11-05T06:30:00+08:00')
const gap = (text, over = {}) => ({ text, hits: 1, lastAt: NOW - 3600_000, ...over })
const stale = (text, over = {}) => ({
  id: `ev_${text.slice(0, 4)}`,
  ts: new Date(NOW - 10 * 86_400_000).toISOString(),
  type: 'utterance',
  text,
  days: 10,
  ...over,
})

test('桌上什么都没有就是空串', () => {
  assert.equal(deskFor({ at: NOW }), '')
  assert.equal(deskFor({ gaps: [], stale: [], free: true, at: NOW }), '')
})

test('普通叫醒：只摆一条没合上的事', () => {
  const out = deskFor({ gaps: [gap('我想弄清这句话为什么成立'), gap('到底要不要把那段剪掉')], at: NOW })
  assert.match(out, /^桌上还有一件没合上的事：/)
  assert.match(out, /我想弄清这句话为什么成立/)
  assert.equal(out.split('\n').length, 2)
})

test('空醒：口子两条 + 旧句子三条，同在一段里', () => {
  const out = deskFor({
    gaps: [gap('我想弄清这句话为什么成立'), gap('为什么总在凌晨才想起来')],
    stale: [
      stale('那天他说水库的事我一直没接上'),
      stale('凌晨的风声比白天清楚很多'),
      stale('我想学吉他这件事拖了三年了'),
      stale('这条不该出现因为配额只有三条'),
    ],
    free: true,
    at: NOW,
  })
  assert.match(out, /^桌上摊着这几样东西：/)
  assert.equal(out.split('\n').length, 1 + DESK_GAP_FREE + DESK_STALE_FREE)
  assert.doesNotMatch(out, /这条不该出现因为配额只有三条/)
  // 只有一个标题：不再出现第二摞清单的抬头
  assert.equal(out.match(/：$/gm).length, 1)
})

test('空醒：旧句子跟口子说的是同一件事，只留口子那条', () => {
  const out = deskFor({
    gaps: [gap('我想弄清这句话为什么成立')],
    stale: [stale('我想弄清这句话为什么成立'), stale('完全不相关的一段话在这里')],
    free: true,
    at: NOW,
  })
  assert.equal(out.match(/我想弄清这句话为什么成立/g).length, 1)
  assert.match(out, /完全不相关的一段话在这里/)
})

test('普通叫醒不摆旧句子', () => {
  const out = deskFor({
    gaps: [gap('我想弄清这句话为什么成立')],
    stale: [stale('那天他说水库的事我一直没接上')],
    at: NOW,
  })
  assert.doesNotMatch(out, /水库/)
})

test('只有旧句子、没有口子时，也还是同一张桌子', () => {
  const out = deskFor({
    stale: [stale('那天他说水库的事我一直没接上'), stale('凌晨的风声比白天清楚很多')],
    free: true,
    at: NOW,
  })
  assert.match(out, /^桌上摊着这几样东西：/)
  assert.match(out, /水库/)
})

test('一行太长就截断，尾巴留省略号', () => {
  const long = '这件事'.repeat(60)
  const out = deskFor({ gaps: [gap(long)], at: NOW })
  const line = out.split('\n')[1]
  assert.ok(line.includes('…'))
  assert.ok(line.length <= DESK_LINE_CLIP + 40)
})

test('口子的「问过几次」与「几天前」都在，且没有分数', () => {
  const out = deskFor({
    gaps: [gap('为什么总在凌晨才想起来', { hits: 3, lastAt: NOW - 2 * 86_400_000 })],
    at: NOW,
  })
  assert.match(out, /问过 3 次，最近一次是2 天前/)
  assert.doesNotMatch(out, /\d\.\d{2}/)
})

test('措辞：不出现「你应该」「你可以」「值得」', () => {
  const out = deskFor({
    gaps: [gap('我想弄清这句话为什么成立')],
    stale: [stale('那天他说水库的事我一直没接上')],
    free: true,
    at: NOW,
  })
  assert.doesNotMatch(out, /你应该|你可以|值得/)
})

test('at 传 Date 也一样', () => {
  const a = deskFor({ gaps: [gap('我想弄清这句话为什么成立')], at: new Date(NOW) })
  const b = deskFor({ gaps: [gap('我想弄清这句话为什么成立')], at: NOW })
  assert.equal(a, b)
})

test('普通叫醒也只给一条，哪怕口子有十条', () => {
  const gaps = Array.from({ length: 10 }, (_, i) => gap(`第 ${i} 个完全不同的疑问为什么会出现`))
  const out = deskFor({ gaps, at: NOW })
  assert.equal(out.split('\n').length, 1 + DESK_GAP_NORMAL)
})

test('整条链（与 scheduler 同样的拼法）：只有聊天行和想改自己的话时，桌上什么都没有，劲儿也没材料', () => {
  const line = (text, daysAgo, flags) => ({
    id: `ev_${daysAgo}`,
    type: 'utterance',
    text,
    flags,
    ts: new Date(NOW - daysAgo * 86_400_000).toISOString(),
  })
  const events = [
    line('你今天几点下班呀？', 0.5, ['uncommitted']),
    line('你今天几点下班呢？', 1.5, ['uncommitted']),
    line('好的，我这就帮你看一下。', 0.2, ['uncommitted']),
    line('好的，我这就帮你看一下。', 1.2, ['uncommitted']),
    line('能不能有人把我改得更外向一点？', 0.3, ['selfmod']),
    line('嗯，这个我知道，你接着说。', 9, ['uncommitted']),
    line('我想让他把我改得更外向一点。', 10, ['selfmod']),
  ]
  const gaps = curiosityOf(events, NOW)
  const fav = interestOf(events, NOW)[0]
  const out = deskFor({
    gaps,
    stale: staleLines(events, { now: NOW }),
    free: true,
    favorite: fav ? topicLabel(fav.text) : '',
    at: NOW,
  })
  assert.equal(out, '')
  assert.equal(deskHasMaterial({ gaps: gaps.length, stale: 0, echo: false, favorite: !!fav }), false)
})
