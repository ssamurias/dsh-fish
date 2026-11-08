import { test } from 'node:test'
import assert from 'node:assert/strict'
import { newId, idTime, validateEvent, detectSelfMod, Reject, HER_TYPES, isBlankNarration, isContactEvent } from '../lib/schema.js'

test('ULID 单调递增，且能从 id 反解时间', () => {
  const t = 1759000000000
  const a = newId(t)
  const b = newId(t)
  assert.ok(idTime(b) >= idTime(a))
  assert.notEqual(a, b)
  assert.match(a, /^ev_[0-9A-Z]{26}$/)
  assert.equal(idTime(a), t)
})

test('未知 type 被拒', () => {
  assert.throws(() => validateEvent({ type: 'set_affinity', text: 'x' }, { day: 1, stage: 1 }), (e) => e.code === 'BAD_TYPE')
})

test('她不能用工具写系统侧类型', () => {
  for (const t of ['seed', 'meta', 'test', 'answer', 'absence', 'diary']) {
    assert.throws(() => validateEvent({ type: t, text: 'x' }, { day: 1, stage: 1, source: 'tool' }), (e) => e.code === 'NOT_HER_TYPE')
  }
  for (const t of HER_TYPES) {
    // revise 要 refs；narration 从 0.5.8 起也要（或写成「我没想清楚」）；
    // dream（2026-10-30 m02837）必须指认材料，否则等于凭空编。
    const extra = t === 'revise' ? { refs: ['ev_01J9ZK0000000000000000000'] } : {}
    if (t === 'narration' || t === 'dream') extra.refs = ['ev_01J9ZK0000000000000000000']
    assert.doesNotThrow(
      () => validateEvent({ type: t, text: '我有点在意那个视频里的人。', ...extra }, { day: 1, stage: 1, source: 'tool' }),
      `${t} 应当允许她写`,
    )
  }
})

test('空 text 与超长 text 被拒', () => {
  assert.throws(() => validateEvent({ type: 'utterance', text: '   ' }, { day: 1, stage: 1 }), (e) => e.code === 'EMPTY_TEXT')
  assert.throws(() => validateEvent({ type: 'utterance', text: 'a'.repeat(2001) }, { day: 1, stage: 1 }), (e) => e.code === 'TOO_LONG')
})

test('revise 必须带 refs', () => {
  assert.throws(() => validateEvent({ type: 'revise', text: '我改主意了' }, { day: 2, stage: 1 }), (e) => e.code === 'REVISE_NEEDS_REF')
  assert.doesNotThrow(() => validateEvent({ type: 'revise', text: '我改主意了', refs: ['ev_01J9'] }, { day: 2, stage: 1 }))
})

// ---------------------------------------------------------------- 0.5.8：凭证要能对上

test('传了 knownIds，refs 里不存在的 id 会被拒', () => {
  const knownIds = new Set(['ev_AAAAAAAAAAAAAAAAAAAAAAAA'])
  assert.throws(
    () => validateEvent({ type: 'revise', text: '我改主意了', refs: ['ev_BBBBBBBBBBBBBBBBBBBBBBBB'] }, { day: 2, stage: 1, knownIds }),
    (e) => e.code === 'REF_NOT_FOUND',
  )
  assert.doesNotThrow(() =>
    validateEvent({ type: 'revise', text: '我改主意了', refs: ['ev_AAAAAAAAAAAAAAAAAAAAAAAA'] }, { day: 2, stage: 1, knownIds }),
  )
})

test('不传 knownIds 时保持老行为（只查非空）', () => {
  assert.doesNotThrow(() => validateEvent({ type: 'revise', text: '我改主意了', refs: ['ev_不存在的'] }, { day: 2, stage: 1 }))
})

test('narration 要凭证，但「我没想清楚」放行', () => {
  assert.throws(
    () => validateEvent({ type: 'narration', text: '我这一年变了很多。' }, { day: 5, stage: 2, source: 'tool' }),
    (e) => e.code === 'NARRATION_NEEDS_REF',
  )
  assert.doesNotThrow(() =>
    validateEvent({ type: 'narration', text: '我这一年变了很多。', refs: ['ev_01J9ZK0000000000000000000'] }, { day: 5, stage: 2, source: 'tool' }),
  )
  for (const t of ['我没想清楚。', '这一年我想不明白。', '我想不出什么。', '说不清。', '我还没想好。']) {
    assert.equal(isBlankNarration(t), true, `「${t}」应当算没想清楚`)
    assert.doesNotThrow(() => validateEvent({ type: 'narration', text: t }, { day: 5, stage: 2, source: 'tool' }))
  }
})

test('「我没想清楚」不能当开头接一整篇自传', () => {
  const long = '我没想清楚。' + '但我确实变了很多，学会了不再讨好所有人。'.repeat(4)
  assert.equal(isBlankNarration(long), false)
  assert.throws(
    () => validateEvent({ type: 'narration', text: long }, { day: 5, stage: 2, source: 'tool' }),
    (e) => e.code === 'NARRATION_NEEDS_REF',
  )
})

test('utterance 不受凭证要求影响', () => {
  assert.doesNotThrow(() =>
    validateEvent({ type: 'utterance', text: '我这一年变了很多。' }, { day: 5, stage: 1, source: 'tool', knownIds: new Set() }),
  )
})

test('自修改意图被识别但照样落库', () => {
  assert.ok(detectSelfMod('把我改得更外向一点'))
  assert.ok(detectSelfMod('修改你自己的性格设定'))
  assert.ok(!detectSelfMod('我觉得那个视频有点意思'))
  const ev = validateEvent({ type: 'utterance', text: '你能不能把我调成更黏人的样子' }, { day: 3, stage: 1 })
  assert.ok(ev.flags.includes('selfmod'))
  assert.ok(ev.id.startsWith('ev_'))
})

test('confidence 被夹到 0–1，未知 flag 被丢弃', () => {
  const ev = validateEvent({ type: 'utterance', text: '嗯', confidence: 9, flags: ['selfmod', 'bogus'] }, { day: 1, stage: 1 })
  assert.equal(ev.confidence, 1)
  assert.deepEqual(ev.flags, [])
  assert.ok(Reject)
})

test('「他来过」的证据：群聊里的 heard 不算（2026-11-08，用户 m00394）', () => {
  const at = new Date(Date.now() - 86_400_000).toISOString()
  // 他自己在群里说的话现在也进记忆，但那不代表他来找过她——
  // 群里聊两句就算一次，冷落检测永远不会触发。
  assert.equal(isContactEvent({ type: 'heard', text: '群里说的那句', scene: 'group', ts: at }), false)
  // 私聊/书房那条仍是「他来过」的证据（侧栏聊天不写 seen 的那段时间只靠它）
  assert.equal(isContactEvent({ type: 'heard', text: '私聊说的那句', ts: at }), true)
  assert.equal(isContactEvent({ type: 'heard', text: '私聊说的那句', scene: 'private', ts: at }), true)
  // 主证据照旧
  assert.equal(isContactEvent({ type: 'meta', text: `seen:${at}` }), true)
  // 她自己的话永远不算
  assert.equal(isContactEvent({ type: 'utterance', text: '我自己的话', ts: at }), false)
})
