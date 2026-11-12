/**
 * 睡前卡（1.0，用户 m01648 / m01650）——一张卡只问一句，问哪句看素材。
 *
 * 这一版之前：三个尺度一起摆（0.9.9），她每次都答最容易的那一问。
 * 现在：改过口 → 两句反着 → 两句像 → 只有经历；什么都没有就不递卡。
 * 做法（交 utterance、refs 指回去）留在 `SLEEP_BRIEF`，卡上不派活。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { sleepPrompt, sleepQuestion, SLEEP_BRIEF } from '../lib/persona.js'

const NOW = Date.parse('2026-11-11T12:00:00Z')
const ago = (d) => new Date(NOW - d * 86400000).toISOString()

const m = (beliefs = [], tensions = []) => ({ beliefs, tensions })

test('什么都没发生就不递卡：宁可这一次不问，也不让她凭空交一句话', () => {
  const q = sleepQuestion(m(), { now: NOW, anyActivity: false })
  assert.equal(q.kind, 'none')
  assert.equal(sleepPrompt(m(), { now: NOW, question: q }), '')
})

test('只有经历时，问这阵子哪件事她还会想——只有一个问题', () => {
  const q = sleepQuestion(m(), { now: NOW, anyActivity: true })
  assert.equal(q.kind, 'experience')
  const p = sleepPrompt(m(), { now: NOW, question: q })
  assert.match(p, /哪件事你到现在还会想/)
  // 一张卡只问一句：旧的三个尺度不再同时出现
  assert.doesNotMatch(p, /挑一个答/)
  assert.doesNotMatch(p, /两面/)
})

test('改过口最优先：把旧的那句和新说的那句一起摆出来，问她旧的在什么情况下还行', () => {
  const q = sleepQuestion(m(), {
    now: NOW,
    anyActivity: true,
    revisions: [{ before: '我讨厌下雨天', after: '下雨天也挺好的' }],
  })
  assert.equal(q.kind, 'revise')
  assert.match(q.ask, /我讨厌下雨天/)
  assert.match(q.ask, /下雨天也挺好的/)
  assert.match(q.ask, /哪样的情况下/)
})

test('只有新话、翻不到旧话时也能问，不编旧句子', () => {
  const q = sleepQuestion(m(), { now: NOW, anyActivity: true, revisions: [{ before: '', after: '我不太想解释' }] })
  assert.equal(q.kind, 'revise')
  assert.match(q.ask, /我不太想解释/)
  assert.doesNotMatch(q.ask, /上一句说「」/)
})

test('两句反着：问她现在更站哪一句，不替她裁决', () => {
  const q = sleepQuestion(
    m([], [{ a: { text: '这事应该直接说' }, b: { text: '这事还是别说为好' } }]),
    { now: NOW, anyActivity: true },
  )
  assert.equal(q.kind, 'opposite')
  assert.match(q.ask, /更站哪一句/)
})

test('两句同向、说法不同：问它们是不是一件事的两个情况', () => {
  const q = sleepQuestion(
    m([
      { id: 'a', text: '他说的话我一般会先想一想再回', since: ago(1) },
      { id: 'b', text: '别人说的话我通常先想一想再回应', since: ago(2) },
    ]),
    { now: NOW, anyActivity: true },
  )
  assert.equal(q.kind, 'same')
  assert.match(q.ask, /一件事的两个情况/)
})

test('想不出来有出口，不逼她给一个答案', () => {
  const p = sleepPrompt(m(), { now: NOW, anyActivity: true })
  assert.match(p, /我没想清楚/)
  assert.match(p, /那句也算数/)
})

test('卡上不派活：做法（交一条 utterance、带 refs）在身份文档里', () => {
  const p = sleepPrompt(m(), { now: NOW, anyActivity: true })
  assert.doesNotMatch(p, /utterance/)
  assert.doesNotMatch(p, /refs/)
  assert.match(SLEEP_BRIEF, /utterance/)
  assert.match(SLEEP_BRIEF, /refs/)
  assert.match(SLEEP_BRIEF, /没想清楚/)
})

test('月末收束句只在 monthDue 时加，且不换掉那条问题', () => {
  const plain = sleepPrompt(m(), { now: NOW, anyActivity: true })
  const month = sleepPrompt(m(), { now: NOW, anyActivity: true, monthly: true })
  assert.doesNotMatch(plain, /这个月你变的那一点/)
  assert.match(month, /这个月你变的那一点/)
  // 原来那一问还在
  assert.match(month, /哪件事你到现在还会想/)
})
