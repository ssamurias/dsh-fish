/**
 * 睡前卡（0.9.9 S-B）——三个尺度各问一句，做法留在身份文档里
 *
 * 这一版之前：`sleepPrompt()` 全仓只有测试在调，生产路径只递一句
 * `（今天停下来，想一想。）`——她睡前其实没看到任何问题。
 * 现在叫醒消息里接的是这张卡；narration 与 refs 的做法留在 `SLEEP_BRIEF`。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { sleepPrompt, SLEEP_BRIEF } from '../lib/persona.js'

const NOW = Date.parse('2026-11-11T12:00:00Z')
const ago = (d) => new Date(NOW - d * 86400000).toISOString()

const m = (beliefs = []) => ({ beliefs })

test('三个尺度：这些天的一句话 / 两句话的两面 / 这一个月哪一点变了', () => {
  const p = sleepPrompt(m(), { now: NOW })
  assert.match(p, /哪一句话/)
  assert.match(p, /两面/)
  assert.match(p, /哪一点变了/)
  assert.match(p, /挑一个答/)
})

test('没有候选时就不摆那两行——不硬凑', () => {
  const p = sleepPrompt(m([{ id: 'a', text: '他说的话我一般会先想一想再回', since: ago(1) }]), { now: NOW })
  assert.doesNotMatch(p, /\n {2}- 「/)
})

test('有同极性、相似度在中段的一对时，把她自己的两句话摆出来', () => {
  const p = sleepPrompt(
    m([
      { id: 'a', text: '他说的话我一般会先想一想再回', since: ago(1) },
      { id: 'b', text: '别人说的话我通常先想一想再回应', since: ago(2) },
    ]),
    { now: NOW },
  )
  assert.match(p, /\n {2}- 「他说的话我一般会先想一想再回」/)
  assert.match(p, /\n {2}- 「别人说的话我通常先想一想再回应」/)
})

test('想不出来有出口，不逼她给一个答案', () => {
  const p = sleepPrompt(m(), { now: NOW })
  assert.match(p, /我没想清楚/)
  assert.match(p, /那句也算数/)
})

test('卡上不派活：narration 与 refs 的做法在身份文档里，不在卡上', () => {
  const p = sleepPrompt(m(), { now: NOW })
  assert.doesNotMatch(p, /narration/)
  assert.doesNotMatch(p, /refs/)
  assert.match(SLEEP_BRIEF, /narration/)
  assert.match(SLEEP_BRIEF, /refs/)
})

test('常驻做法也写了三个尺度，她一直知道有这三种问法', () => {
  assert.match(SLEEP_BRIEF, /哪一句话/)
  assert.match(SLEEP_BRIEF, /两面/)
  assert.match(SLEEP_BRIEF, /哪一点变了/)
  assert.match(SLEEP_BRIEF, /没想清楚/)
})

// ---- 1.0（S 线）：每月多问一段「给以后的自己留一段话」 ----

test('月度那一问默认不出现——开关关着时和 0.9.9 一字不差', () => {
  const p = sleepPrompt(m(), { now: NOW })
  assert.doesNotMatch(p, /一个月才说一次/)
  assert.doesNotMatch(p, /以后翻到今天/)
  assert.doesNotMatch(sleepPrompt(m(), { now: NOW, monthly: false }), /一个月才说一次/)
})

test('开着时多问一段，仍然允许什么都不写', () => {
  const p = sleepPrompt(m(), { now: NOW, monthly: true })
  assert.match(p, /一个月才说一次/)
  assert.match(p, /以后翻到今天的自己/)
  // 问法的出口必须在：写不出来也算数
  assert.match(p, /我没想清楚/)
  // 卡上仍不派活——narration / refs 的做法只在身份文档里
  assert.doesNotMatch(p, /narration/)
  assert.doesNotMatch(p, /refs/)
})

test('多出来的那一问不顶掉三个尺度', () => {
  const p = sleepPrompt(m(), { now: NOW, monthly: true })
  assert.match(p, /哪一句话/)
  assert.match(p, /两面/)
  assert.match(p, /哪一点变了/)
  // 而「挑一个答」那句只指前三个，别让她以为四件都要答
  assert.match(p, /挑一个答/)
})

