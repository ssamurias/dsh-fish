/**
 * writeAtomic 的临时文件名：同一进程、同一毫秒的两次写不能共用一个临时文件。
 * 共用时两次写会交错，改名后的文件可能是坏 JSON；readJson 把坏文件收走后，
 * 下一次 updateConfig 就拿默认值写回去，设置全没了。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeAtomic } from '../lib/store.js'

test('同时写同一个文件：结果总是其中一次的完整内容，不留临时文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fish-atomic-'))
  const realNow = Date.now
  // 钉住时间，让两次写必然落在同一毫秒：不钉的话这个错是概率性的
  Date.now = () => 1_800_000_000_000
  try {
    const file = join(dir, 'config.json')
    const a = JSON.stringify({ who: 'a', pad: 'x'.repeat(200_000) })
    const b = JSON.stringify({ who: 'b', pad: 'y'.repeat(50) })
    for (let i = 0; i < 20; i++) {
      await Promise.allSettled([writeAtomic(file, a), writeAtomic(file, b)])
      const text = readFileSync(file, 'utf8')
      assert.ok(text === a || text === b, `第 ${i} 轮写出了半截内容（长 ${text.length}）`)
    }
    assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith('.tmp')), [], '不留临时文件')
  } finally {
    Date.now = realNow
    rmSync(dir, { recursive: true, force: true })
  }
})
