/**
 * curiosity.test.mjs —— 主观能动性 步 0「惦记的口子 + 回音」的锁定测试（2026-11-05）
 *
 * 守五件事：
 *   1. 只从她自己的话里取问题（HER_TYPES），不是她写的、不含疑问的句子一律不进；
 *   2. 同一件事反复问会聚成一个口子，展示的是**最近一次的原话**（不是第一次，也不是我提炼的主题）；
 *   3. 越旧越轻：两周前的口子会被衰减掉；没有口子时返回空串，一个字都不多；
 *   4. 回音只在她留过话、且没超过 72 小时时出现；他来过 / 没来过，说法不同；
 *   5. 返回值里没有任何分数或数字统计之外的东西（不出现 weight / 分值）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CURIOSITY_SHOW_MAX,
  CURIOSITY_TEXT_MAX,
  curiosityOf,
  questionsOf,
  renderCuriosity,
  renderEcho,
  lastLeaveAt,
  lastSeenAt,
} from '../lib/curiosity.js'

const HOUR = 3600_000
const DAY = 24 * HOUR
const NOW = Date.parse('2026-11-05T12:00:00+08:00')

function ev(type, text, hoursAgo, extra = {}) {
  return { id: `ev_${Math.round(hoursAgo)}`, type, text, ts: new Date(NOW - hoursAgo * HOUR).toISOString(), ...extra }
}

test('只取她自己的话：他的消息、meta、不含疑问的句子都不算', () => {
  const events = [
    ev('utterance', '为什么会有人在凌晨两点刷钓鱼视频？', 3),
    ev('narration', '今天什么也没干。', 2),
    ev('meta', '为什么这里算不算问题？', 1),
    { id: 'ev_x', type: 'heard', text: '他问我为什么不吃早饭？', ts: new Date(NOW - HOUR).toISOString() },
  ]
  const qs = questionsOf(events)
  assert.equal(qs.length, 1)
  assert.match(qs[0].text, /钓鱼/)
})

test('太短的碎片不当问题', () => {
  const events = [ev('utterance', '为什么', 1), ev('utterance', '在吗？', 1)]
  assert.equal(questionsOf(events).length, 0)
})

test('陈述句里夹着「有没有 / 为什么」不算问题（拿她真话试出来的误收）', () => {
  const events = [
    ev('utterance', '区别在拼完之后有没有一句是自己的。', 3),
    ev('utterance', '所以我给自己定一条：看他有没有真的让出东西来。', 2),
  ]
  assert.equal(questionsOf(events).length, 0)
})

test('她自己说「想弄清 / 想知道」也算惦记上了（她真正的问句几乎不带问号）', () => {
  const events = [
    ev('narration', '我想弄清这句话为什么成立。', 3),
    ev('dream', '最后一件最小、也最虚：想知道明天醒来，还是不是这个我。', 2),
  ]
  const qs = questionsOf(events)
  assert.equal(qs.length, 2)
  assert.match(qs[0].text, /想弄清/)
  assert.equal(qs[1].text.endsWith('。'), false)
})

test('句首是疑问词、句末没有问号，也算问出来的', () => {
  const events = [ev('utterance', '为什么凌晨两点还有人刷钓鱼视频', 1)]
  const qs = questionsOf(events)
  assert.equal(qs.length, 1)
  assert.equal(qs[0].text, '为什么凌晨两点还有人刷钓鱼视频')
})

test('同一件事问两次聚成一个口子，用最近一次的原话', () => {
  const events = [
    ev('utterance', '那本《西游记》里孙悟空到底是不是自愿去取经的？', 30),
    ev('utterance', '《西游记》里孙悟空到底是不是自愿去取经的，我还没想通？', 2),
  ]
  const list = curiosityOf(events, NOW)
  assert.equal(list.length, 1)
  assert.equal(list[0].hits, 2)
  assert.match(list[0].text, /我还没想通/)
})

test('不同的事不并成一个口子', () => {
  const events = [
    ev('utterance', '为什么会有人在凌晨两点刷钓鱼视频？', 30),
    ev('utterance', '他说的那个水库到底在哪个县？', 2),
  ]
  assert.equal(curiosityOf(events, NOW).length, 2)
})

test('两周前的口子被衰减掉，今天问的还在', () => {
  const events = [
    ev('utterance', '为什么会有人在凌晨两点刷钓鱼视频这件事我一直没弄明白？', 24 * 20),
    ev('utterance', '他说的那个水库到底在哪个县？', 2),
  ]
  const list = curiosityOf(events, NOW)
  assert.equal(list.length, 1)
  assert.match(list[0].text, /水库/)
})

test('没有口子时 renderCuriosity 返回空串', () => {
  assert.equal(renderCuriosity(curiosityOf([], NOW), NOW), '')
  assert.equal(renderCuriosity([], NOW), '')
})

test('展示最多三条，原话过长会截断，文案里不出现分数', () => {
  const events = [
    ev('utterance', '为什么会有人在凌晨两点刷钓鱼视频？', 1),
    ev('utterance', '他说的那个水库到底在哪个县？', 1),
    ev('utterance', '是不是所有的鱼都会记得自己被喂过几次？', 1),
    ev('utterance', '为什么第三次撞到同一个坑还是记不住？', 1),
  ]
  const list = curiosityOf(events, NOW)
  const text = renderCuriosity(list, NOW)
  const lines = text.split('\n')
  assert.equal(lines.length, 1 + Math.min(list.length, CURIOSITY_SHOW_MAX))
  assert.doesNotMatch(text, /weight|分值|0\.\d/)
})

test('原话超过上限会被截断到 CURIOSITY_TEXT_MAX', () => {
  const long = `${'为什么'.repeat(40)}这件事？`
  const list = curiosityOf([ev('utterance', long, 1)], NOW)
  assert.ok(list[0].text.length <= CURIOSITY_TEXT_MAX + 1)
  assert.ok(list[0].text.endsWith('…'))
})

test('留话与「他来过」的时间从 meta 里读', () => {
  const events = [
    ev('meta', 'letter:2026-11-05:ev_1', 10),
    ev('meta', 'seen:2026-11-05T09:00:00.000Z', 3),
  ]
  assert.ok(lastLeaveAt(events) > 0)
  assert.ok(lastSeenAt(events) > lastLeaveAt(events))
})

test('回音：留过话、他没来过 → 还没来过', () => {
  const events = [ev('meta', 'letter:2026-11-05:ev_1', 10)]
  assert.equal(renderEcho(events, NOW), '你上次留的那句话，他还没来过。')
})

test('回音：留话之后他来过 → 来过了', () => {
  const events = [
    ev('meta', 'letter:2026-11-05:ev_1', 10),
    ev('meta', 'seen:2026-11-05T09:00:00.000Z', 3),
  ]
  assert.equal(renderEcho(events, NOW), '你上次留的那句话，他后来来过了。')
})

test('回音：没留过话、或留话已经超过 72 小时 → 空串', () => {
  assert.equal(renderEcho([ev('meta', 'seen:2026-11-05T09:00:00.000Z', 3)], NOW), '')
  assert.equal(renderEcho([ev('meta', 'letter:2026-11-02:ev_1', 96)], NOW), '')
})
