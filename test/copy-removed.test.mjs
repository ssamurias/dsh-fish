/**
 * copy-removed.test.mjs —— 文案修改页在发布版里已经不存在（2026-10-25 用户要求）
 *
 * 用户要的不是「藏起来」，而是「不管从哪条路都调不到」：
 *   · 界面没有那个页签，也没有覆盖层（不再按原文字替换页面文本）；
 *   · 服务端没有 `/copy` 与 `/copy/source` 路由，`lib/copy.js` 不在包里；
 *   · 所以别人即使手里有 copy.json，也没有任何代码去读它。
 *
 * 源码副本留在包外（维护者本地），要恢复看那边的 README。
 * 这条测试的作用是**防止哪天顺手把它加回来**——加回来必须同时改这里。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const CLIENT = join(ROOT, 'lib', 'client.js')
const OBSERVE = join(ROOT, 'lib', 'observe.js')

test('客户端里没有文案页与覆盖层', async () => {
  const cl = await readFile(CLIENT, 'utf8')
  for (const gone of [
    "showTab('copy')",
    'copyPage',
    'copyMap',
    'saveCopy(',
    "jget('/copy')",
    "jget('/copy/source')",
    "['copy', '文案']",
  ]) {
    assert.ok(!cl.includes(gone), `客户端里不该再有「${gone}」`)
  }
  // 复制路径到剪贴板那件事跟文案无关，留着。
  assert.ok(cl.includes('copyPath'), '复制路径到剪贴板的按钮要留着')
})

test('服务端没有 /copy 路由，也不再引 copy.js', async () => {
  const ob = await readFile(OBSERVE, 'utf8')
  assert.ok(!ob.includes("'/copy'"), '不该再有 /copy 路由')
  assert.ok(!ob.includes("'/copy/source'"), '不该再有 /copy/source 路由')
  assert.ok(!ob.includes("from './copy.js'"), '不该再 import copy.js')
  assert.ok(!ob.includes('readCopy'), '不该再读 copy.json')
})

test('lib/copy.js 已经不在包里', async () => {
  await assert.rejects(() => access(join(ROOT, 'lib', 'copy.js')), 'lib/copy.js 应该已经删掉')
})
