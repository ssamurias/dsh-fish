/**
 * sleep-prompt.test.mjs —— 「每 N 天的想一想」会不会被空醒吃掉（issue #101，2026-11-09）
 *
 * 真机：`memory.sleepEveryDays = 7`，可十几天的成长日里只响过一次（那次还是 manual-idle）。
 * 原因是两段判断互相排斥，而其中一段几乎恒真：
 *   - `lib/freewake.js` 只要旧句子摆得出来就判 `table`（空醒），而摆料对每天醒一次的机器
 *     天然成立；
 *   - `lib/scheduler.js` 那句提示被 `!free` 挡着——空醒时整段不执行，也不记 `sleep:<dk>`，
 *     这一天就这么过去了，没有「延后补发」。
 *
 * 现在倒过来：这一天先不判空醒，摆料顺延到下一次醒来，仍按正常叫醒把这句递出去。
 * 判据因此要早于「判空醒」算好，并且要能单测——所以抽成了 `sleepPromptDue()`。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { sleepPromptDue } from '../lib/scheduler.js'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'lib', 'scheduler.js'), 'utf8')

const meta = (text) => ({ type: 'meta', text })

test('成长日取模对上的那一天，就该问一次（不是自然日）', () => {
  assert.equal(sleepPromptDue({ every: 7, day: 14, dk: '2026-11-10' }), true)
  assert.equal(sleepPromptDue({ every: 7, day: 7, dk: '2026-11-03' }), true)
  // 13 天不是 7 的整数倍：本来就不该有。
  assert.equal(sleepPromptDue({ every: 7, day: 13, dk: '2026-11-09' }), false)
})

test('还没立住的那一天不问：day 1 与 every=0', () => {
  assert.equal(sleepPromptDue({ every: 1, day: 1, dk: '2026-10-28' }), false)
  assert.equal(sleepPromptDue({ every: 0, day: 14, dk: '2026-11-10' }), false)
  assert.equal(sleepPromptDue({ every: 7, day: 14, dk: '2026-11-10' }), true)
})

test('同一天递过一次就不再问（meta sleep:<dk> 兜住）', () => {
  const events = [meta('sleep:2026-11-10')]
  assert.equal(sleepPromptDue({ every: 7, day: 14, dk: '2026-11-10', events }), false)
  // 昨天递过的那个 key 不算今天。
  assert.equal(sleepPromptDue({ every: 7, day: 14, dk: '2026-11-10', events: [meta('sleep:2026-11-09')] }), true)
})

test('摆料不许顶掉这一天：table 分支与 freeWakeFor 都让开', () => {
  // 空醒几乎每天都成立；这一天要是不让开，提示就永远轮不到（issue #101 的根因）。
  assert.match(src, /if \(staleOn && !sleepDue && !dreamOn\(evs, model\.day\)\.length\)/)
  assert.match(src, /free = sleepDue \? null : freeWakeFor\(/)
  // 旧的写法（空醒里才不叠、其余时候被 `!free` 挡着）不能再回来。
  assert.doesNotMatch(src, /!\s*free && every > 0/)
})

test('判据要早于判空醒算，且这一天照常把这句推进正文', () => {
  const at = src.indexOf('sleepDue = sleepPromptDue(')
  const table = src.indexOf('if (staleOn && !sleepDue')
  assert.ok(at >= 0 && table >= 0 && at < table, 'sleepDue 必须先算、table 才判')
  assert.match(src, /if \(sleepDue\) \{ parts\.push\('', SLEEP_TODAY\); askedSleep = true \}/)
})
