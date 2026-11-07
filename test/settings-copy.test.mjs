/**
 * settings-copy.test.mjs —— 设置项「一个名字 + 一句话」
 *
 * 设置页的每一项原来都挂着一大段说明：设计理由、历史、劝告、玩笑混在一起，
 * 有几段讲的逻辑和代码已经对不上。现在每项只留一个名字和一句描述，
 * 这条测试守住长度，免得说明再一点点长回去。
 *
 * 只扫 Toggle / Num / Sel / Text / TimeRange 这五种控件的 label 与 hint（字符串字面量）。
 * 更长的事实（比如「为什么默认只放这几个工具」）放在卡片里，不挂在单个设置项上。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(HERE, '..', 'lib', 'client.js')

const LABEL_MAX = 10
const HINT_MAX = 40

/** 从 `Toggle({` 之类的调用起点往后找到配对的 `)`，跳过字符串与模板字面量。 */
function callBody(src, start) {
  let depth = 0
  let i = src.indexOf('(', start)
  for (; i < src.length; i++) {
    const c = src[i]
    if (c === "'" || c === '"' || c === '`') {
      const q = c
      for (i++; i < src.length && src[i] !== q; i++) if (src[i] === '\\') i++
      continue
    }
    if (c === '(') depth++
    else if (c === ')' && --depth === 0) return src.slice(start, i + 1)
  }
  return ''
}

/** 取一个调用体里**顶层**的 `key: '…'`（不进嵌套的函数体，比如 fmt / onChange）。 */
function topString(body, key) {
  const re = new RegExp(`(?:\\{|,)\\s*${key}: '((?:[^'\\\\]|\\\\.)*)'`, 'g')
  for (const m of body.matchAll(re)) return m[1]
  return null
}

async function controls() {
  const src = await readFile(CLIENT, 'utf8')
  const out = []
  for (const m of src.matchAll(/\b(Toggle|Num|Sel|Text|TimeRange)\(\{/g)) {
    // 跳过组件定义本身（function Toggle(o) …）
    if (/function\s+$/.test(src.slice(Math.max(0, m.index - 12), m.index))) continue
    const body = callBody(src, m.index)
    const line = src.slice(0, m.index).split('\n').length
    out.push({ kind: m[1], line, label: topString(body, 'label'), hint: topString(body, 'hint') })
  }
  return out
}

const len = (s) => [...String(s ?? '')].length

test('每个设置项都有名字，名字不超过 10 个字', async () => {
  const all = await controls()
  assert.ok(all.length >= 40, `只扫到 ${all.length} 个控件，解析可能坏了`)
  const bad = all.filter((c) => !c.label || len(c.label) > LABEL_MAX)
  assert.deepEqual(bad.map((c) => `client.js:${c.line} ${c.label}`), [])
})

test('每个设置项的描述是一句话，不超过 40 个字', async () => {
  const all = await controls()
  const bad = all.filter((c) => c.hint != null && (len(c.hint) > HINT_MAX || /[。！？].+/.test(c.hint)))
  assert.deepEqual(bad.map((c) => `client.js:${c.line} ${c.label}：${c.hint}`), [])
})

test('名字里不带括号补充说明', async () => {
  const all = await controls()
  const bad = all.filter((c) => /[（(]/.test(c.label ?? ''))
  assert.deepEqual(bad.map((c) => `client.js:${c.line} ${c.label}`), [])
})
