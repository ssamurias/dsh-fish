/**
 * capability.test.mjs —— 2026-11-07（用户 m00493）的 ⑤ / ② / 履历式。
 *
 * 三件事的共同点：都不是新面板，只是「她曾经说过的那句话」被接回了工具账上。
 * 所以测试也守着同一条底线——找不到来路就什么都不写，不编。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { anchorOf, ANCHOR_WINDOW_MS } from '../lib/anchor.js'
import { gapwallsOf, gapwallLine } from '../lib/gapwall.js'
import { resumeLines } from '../lib/use.js'
import { renderSelfDoc } from '../lib/selfdoc.js'
import { deriveSelf } from '../lib/derive.js'

const T0 = Date.parse('2026-11-07T01:00:00.000Z')
const iso = (ms) => new Date(ms).toISOString()

test('⑤ 锚：同一会话、调用前十分钟内她那句话，取最近的一条', () => {
  const events = [
    { type: 'utterance', sessionId: 's1', ts: iso(T0), text: '想记一下买灯泡的事' },
    { type: 'utterance', sessionId: 's1', ts: iso(T0 + 60_000), text: '还有，明天提醒我交电费' },
    { type: 'utterance', sessionId: 's2', ts: iso(T0 + 90_000), text: '这句话不是这个会话的' },
  ]
  assert.equal(anchorOf(events, 's1', T0 + 120_000), '还有，明天提醒我交电费')
})

test('⑤ 锚：太早、没 sessionId、别的会话都不挂', () => {
  const events = [{ type: 'utterance', sessionId: 's1', ts: iso(T0), text: '很久以前的一句' }]
  assert.equal(anchorOf(events, 's1', T0 + ANCHOR_WINDOW_MS + 1), '')
  assert.equal(anchorOf(events, '', T0 + 1000), '')
  assert.equal(anchorOf(events, 's2', T0 + 1000), '')
})

test('⑤ 锚：只认她自己说的话，不认 meta / voice', () => {
  const events = [
    { type: 'meta', sessionId: 's1', ts: iso(T0), text: 'use:her_note ok 记下了' },
    { type: 'voice', sessionId: 's1', ts: iso(T0 + 1), text: '别人留在评论区的话' },
  ]
  assert.equal(anchorOf(events, 's1', T0 + 1000), '')
})

test('② 撞墙：把当时那句话摆回桌上，带天数', () => {
  const events = [
    { type: 'utterance', sessionId: 's1', ts: iso(T0), text: '能不能让我看整条视频的画面' },
    {
      type: 'meta',
      sessionId: 's1',
      ts: iso(T0 + 60_000),
      text: 'use:her_read fail 这件事我做不到。要是你确实想要，说出来就行。',
    },
  ]
  const walls = gapwallsOf(events, { now: T0 + 2 * 86_400_000 })
  assert.equal(walls.length, 1)
  assert.equal(walls[0].text, '能不能让我看整条视频的画面')
  assert.equal(walls[0].days, 1)
  assert.equal(gapwallLine(walls[0]), '- 「能不能让我看整条视频的画面」（这件事你试过，手上没有能用的·1 天前）')
})

test('② 撞墙：成了的不算，超过七天的不算，没有来路的不算', () => {
  const base = [
    { type: 'utterance', sessionId: 's1', ts: iso(T0), text: '想看看整条视频' },
    { type: 'meta', sessionId: 's1', ts: iso(T0 + 60_000), text: 'use:her_read ok 看了' },
    { type: 'meta', sessionId: 's1', ts: iso(T0 + 60_000), text: 'use:her_read fail 这次没成。' },
  ]
  assert.deepEqual(gapwallsOf(base, { now: T0 + 3600_000 }), [])
  // 有撞墙、但那一句没 sessionId（挂不上来路）→ 不摆
  const orphan = [
    { type: 'meta', sessionId: '', ts: iso(T0 + 60_000), text: 'use:her_read fail 这件事我做不到。' },
  ]
  assert.deepEqual(gapwallsOf(orphan, { now: T0 + 3600_000 }), [])
  // 八天前的撞墙 → 已经过期
  const old = [
    { type: 'utterance', sessionId: 's1', ts: iso(T0), text: '想看看整条视频' },
    { type: 'meta', sessionId: 's1', ts: iso(T0 + 60_000), text: 'use:her_read fail 这件事我做不到。' },
  ]
  assert.deepEqual(gapwallsOf(old, { now: T0 + 8 * 86_400_000 }), [])
})

test('履历：最近做过的摆前面，同一类只留一条，撞墙的不进履历', () => {
  const events = [
    { type: 'meta', ts: iso(T0), text: 'use:her_note ok 记下了：买灯泡' },
    { type: 'meta', ts: iso(T0 + 1), text: 'use:bili_watch ok 看了三帧' },
    { type: 'meta', ts: iso(T0 + 2), text: 'use:bili_watch ok 看了三帧' },
    { type: 'meta', ts: iso(T0 + 3), text: 'use:her_read fail 这件事我做不到。要是你确实想要，说出来就行。' },
    { type: 'meta', ts: iso(T0 + 4), text: 'use:her_diary ok 写了一段。' },
  ]
  const text = resumeLines(events)
  assert.match(text, /^## 我做过的事/)
  assert.match(text, /- 我用过 her_diary，写了一段。/)
  assert.match(text, /- 我用过 bili_watch，看了三帧/)
  assert.match(text, /- 我用过 her_note，记下了：买灯泡/)
  assert.doesNotMatch(text, /her_read/)
  assert.equal(text.match(/bili_watch/g).length, 1)
  // 顺序：最近的在最前
  assert.ok(text.indexOf('her_diary') < text.indexOf('bili_watch'))
})

test('履历：没记过就整节不写，不写一句「你还没做过什么」', () => {
  assert.equal(resumeLines([]), '')
  assert.equal(resumeLines([{ type: 'utterance', text: '只是说过一句话' }]), '')
})

test('身份文档：有履历才出现「我做过的事」这一节', () => {
  const model = deriveSelf([])
  const withResume = renderSelfDoc(model, { resume: '## 我做过的事\n- 我用过 her_note，记下了：买灯泡' })
  assert.match(withResume, /## 我做过的事/)
  assert.match(withResume, /我用过 her_note/)
  const without = renderSelfDoc(model, {})
  assert.doesNotMatch(without, /## 我做过的事/)
})
