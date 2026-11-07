import test from 'node:test'
import assert from 'node:assert/strict'

import { redactOwner, redactOutgoing } from '../lib/redact.js'

test('redactOwner：两字及以上，出现即替换', () => {
  assert.equal(redactOwner('时梦尘跟我说的', '时梦尘'), '对方跟我说的')
  assert.equal(redactOwner('时梦尘的名字我不能告诉你', '时梦尘'), '对方的名字我不能告诉你')
  assert.equal(redactOwner('他叫时梦尘', '时梦尘'), '他叫对方')
})

test('redactOwner：单字名只替换明显在指人的句式', () => {
  assert.equal(redactOwner('猫的名字我不能告诉你', '猫'), '对方的名字我不能告诉你')
  assert.equal(redactOwner('猫跟我说', '猫'), '对方跟我说')
  assert.equal(redactOwner('叫猫', '猫'), '叫对方')
  assert.equal(redactOwner('问过猫', '猫'), '问过对方')
  // 正常的猫不误伤
  assert.equal(redactOwner('我喜欢猫', '猫'), '我喜欢猫')
  assert.equal(redactOwner('猫在睡觉', '猫'), '猫在睡觉')
  assert.equal(redactOwner('一只猫跑过去了', '猫'), '一只猫跑过去了')
})

test('redactOwner：空名字 / 空文本原样返回', () => {
  assert.equal(redactOwner('随便说点什么', ''), '随便说点什么')
  assert.equal(redactOwner('', '时梦尘'), '')
  assert.equal(redactOwner(null, '时梦尘'), '')
  assert.equal(redactOwner('时梦尘', null), '时梦尘')
})

test('redactOwner：名字里的正则字符按字面处理', () => {
  assert.equal(redactOwner('a.b 说的', 'a.b'), '对方 说的')
  assert.equal(redactOwner('a+b 说的', 'a+b'), '对方 说的')
})

test('redactOutgoing：@ 前缀原样保留', () => {
  assert.equal(redactOutgoing('时梦尘说你好', '时梦尘', '@时梦染 '), '@时梦染 对方说你好')
  assert.equal(redactOutgoing('猫说你好', '猫', '@猫 '), '@猫 对方说你好')
})
