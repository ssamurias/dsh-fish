/**
 * slowderive.test.mjs —— 慢派生留痕（0.9.8 提速，issue #105 第 1 条）
 *
 * 要钉住的不是「能写日志」，而是三件容易悄悄坏掉的事：
 *   1. **阈值**：没慢到就不写。日志里一堆「derive slow 12ms」会让这条信号彻底失效。
 *   2. **只记数**：只有 ms / events / beliefs 三个数，不带她的原话。
 *      这条一旦破了，日志就从「性能曲线」变成「她的内心备份」。
 *   3. **永不抛**：写不进去（root 是个文件、盘满）只返回 false，不能连带把身份文件的刷新打断。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SLOW_DERIVE_MS, slowDeriveNote } from '../lib/selfdoc.js'
import { logFile } from '../lib/log.js'

test('慢派生：没到阈值不写，到了写一行', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-slow-'))
  assert.equal(slowDeriveNote(root, { ms: SLOW_DERIVE_MS - 1, events: 10, beliefs: 3 }), false)
  await assert.rejects(readFile(logFile(root), 'utf8'))

  assert.equal(slowDeriveNote(root, { ms: 1234, events: 900, beliefs: 40 }), true)
  const text = await readFile(logFile(root), 'utf8')
  assert.match(text, /\[warn\] derive slow/)
  assert.match(text, /"ms":1234/)
  assert.match(text, /"events":900/)
  assert.match(text, /"beliefs":40/)
})

test('慢派生：恰好等于阈值也算慢（>= 而不是 >）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-slow-eq-'))
  assert.equal(slowDeriveNote(root, { ms: SLOW_DERIVE_MS }), true)
})

test('慢派生：只记数，不带任何文本字段', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-slow-notext-'))
  slowDeriveNote(root, { ms: 800, events: 5, beliefs: 2, text: '她说过的那句话' })
  const text = await readFile(logFile(root), 'utf8')
  assert.doesNotMatch(text, /她说过的那句话/)
})

test('慢派生：写不进去也不抛', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fish-slow-bad-'))
  const fakeRoot = join(dir, 'not-a-dir')
  await writeFile(fakeRoot, 'x', 'utf8')
  assert.equal(slowDeriveNote(fakeRoot, { ms: 9999, events: 1, beliefs: 0 }), false)
})
