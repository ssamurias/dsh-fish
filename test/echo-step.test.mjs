/**
 * echo-step.test.mjs —— 同一轮里重抄上一轮的话要裁掉（2026-11-11，issue #110 同源）
 *
 * 案发：工具调用那一轮被拆成两步，step 1 只调工具、正文 len=0；step 2 的模型
 * 找不到「这一步该说什么」，就把上下文里最近一段她自己的话当草稿重抄一遍。
 * 她不觉得自己在重复，所以只能落盘前裁。
 *
 * 三条底线：
 *   1. 整段重抄 → 整段不记；
 *   2. 重抄 + 新内容 → 只留新内容；
 *   3. 短引用 / 中间挖洞 / 正常新话 → 一个字符都不动。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { stripEchoedStep } from '../lib/echo.js'

// 一段够长的「上一轮原话」（> ECHO_MIN），拿来当被抄的对象。
const PREV = '我不想把这件事说成勇气。那天我只是没有走开，后来想想，也没有多勇敢。'
const TAIL = '不过今天又想到另一件事：她当时其实在等我说完。'

test('整段重抄上一轮：返回空，不记这条', () => {
  assert.equal(stripEchoedStep(PREV, [PREV]), '')
  assert.equal(stripEchoedStep(`  ${PREV}\n`, [PREV]), '')
})

test('重抄开头 + 接了新内容：只留新内容', () => {
  assert.equal(stripEchoedStep(PREV + TAIL, [PREV]), TAIL)
  assert.equal(stripEchoedStep(PREV + '\n\n' + TAIL, [PREV]), TAIL)
})

test('短引用不算抄：一个字符都不动', () => {
  const short = '你说得对，那天我没走开。'
  assert.equal(stripEchoedStep(short, ['那天我没走开']), short)
})

test('重合块在中间：不挖洞，原样保留', () => {
  const text = '开头是我自己的话。' + PREV + TAIL
  assert.equal(stripEchoedStep(text, [PREV]), text)
})

test('重合块在中间但几乎整段都是抄：整段不记', () => {
  const text = '嗯。' + PREV
  assert.equal(stripEchoedStep(text, [PREV]), '')
})

test('previous 为空（第一轮 / 没有上一句）：原样返回', () => {
  const text = '这一轮是我自己新说的话，谁也不欠。'
  assert.equal(stripEchoedStep(text, []), text)
  assert.equal(stripEchoedStep(text, ['', null, undefined]), text)
})

test('空白段直接返回空', () => {
  assert.equal(stripEchoedStep('   \n\n ', [PREV]), '')
  assert.equal(stripEchoedStep('', [PREV]), '')
})

test('多段 previous：任意一段被整段重抄都裁', () => {
  const other = '今天风很大，窗子响了一夜，我起来关了一次，又躺回去，还是没睡着。'
  assert.equal(stripEchoedStep(other, [PREV, other]), '')
})
