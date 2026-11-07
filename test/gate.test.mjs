/**
 * gate.test.mjs —— P3（2026-11-07）：config 关掉的功能，入口不拆，只在门上写「这会儿」。
 *
 * 守三件事：
 *   1. 关着的时候「上网」「在网上说话」两节**仍然在**，不会被整段删掉。
 *   2. 关着时门上的话是「这会儿」，不是「不能」；不带任何"发得出去/出得去"的许诺。
 *   3. 两个开关的四种组合里，她看得见的正文都不出现系统词（权限/开关/禁止/被允许/配额）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { deriveSelf } from '../lib/derive.js'
import { renderSelfDoc } from '../lib/selfdoc.js'

const BANNED = /权限|开关|禁止|被允许|配额/

function doc(opts) {
  return renderSelfDoc(deriveSelf([], { growthDays: 30 }), { budget: 4000, ...opts })
}

test('上网关着：这一节还在，门上写「这会儿出不去」，不讲怎么用', () => {
  const d = doc({ browse: false })
  assert.match(d, /## 上网/)
  assert.match(d, /这会儿出不去/)
  assert.doesNotMatch(d, /what=home/, '关着时不该再教她怎么调 bili_look')
})

test('上网开着：这一节讲怎么用，不再写「这会儿出不去」', () => {
  const d = doc({ browse: true })
  assert.match(d, /## 上网/)
  assert.match(d, /what=home/)
  assert.doesNotMatch(d, /这会儿出不去/)
})

test('说话关着：这一节还在，门上写「这会儿还说不出去」，不许诺能发', () => {
  const d = doc({ speak: false })
  assert.match(d, /## 在网上说话/)
  assert.match(d, /这会儿还说不出去/)
  assert.doesNotMatch(d, /留一条评论|回一句别人|可以给你/)
})

test('说话开着：这一节讲能说话，不再写「这会儿还说不出去」', () => {
  const d = doc({ speak: true })
  assert.match(d, /## 在网上说话/)
  assert.match(d, /你还有一个工具 bili_speak/)
  assert.doesNotMatch(d, /这会儿还说不出去/)
})

test('四种开关组合：她看得见的正文都没有系统词', () => {
  for (const browse of [true, false]) {
    for (const speak of [true, false]) {
      const d = doc({ browse, speak })
      assert.doesNotMatch(d, BANNED, `browse=${browse} speak=${speak} 的正文出现了系统词`)
    }
  }
})
