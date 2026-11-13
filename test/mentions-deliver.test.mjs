/**
 * mentions-deliver.test.mjs —— 有人 @ 她：先递正文，再叫醒（2026-11-13，issue #136 A）
 *
 * 现场：主人在 B 站 @ 了她，调度那一拍把正文排进了 session-notes.json，
 * 紧接着叫醒成功；醒来说的第一句是「那句话已经放在便条里」，可便条是 her_note
 * 那叠纸条，正文根本不在那儿，她翻错地方，最后说「没找到那句话」。
 *
 * 根因是顺序：`woke.ok` 为真就跳过投递。这里把「投递 / 叫醒」两个动作换成
 * 假的，只验证顺序与各类分支，不碰真实会话。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { deliverMentions } from '../lib/scheduler.js'

const ownerMention = [{ fromOwner: true, id: 1 }]

function harness() {
  const seq = []
  const deps = {
    deliver: async (agent) => { seq.push(['deliver', agent]) },
    wake: async () => { seq.push(['wake']); return { ok: true } },
  }
  return { seq, deps }
}

test('先投递、再叫醒；叫醒成功也不会跳过投递', async () => {
  const { seq, deps } = harness()
  const agent = { id: 'agent-1' }
  const out = await deliverMentions({
    root: '/tmp/fish-mentions',
    ctx: {},
    picked: ownerMention,
    agent,
    h: { sessionId: 's-her' },
    dk: '2026-11-13',
    config: { at: { ownerWake: true } },
    busy: false,
    deps,
  })
  assert.deepEqual(seq.map((x) => x[0]), ['deliver', 'wake'])
  assert.equal(seq[0][1], agent, '递的时候用的是她那条会话的 agent')
  assert.equal(out.woke.ok, true)
})

test('她正忙（busy）时不叫醒，但正文照样递进去', async () => {
  const { seq, deps } = harness()
  const out = await deliverMentions({
    root: '/tmp/fish-mentions', ctx: {}, picked: ownerMention,
    agent: { id: 'a' }, h: { sessionId: 's-her' }, dk: '2026-11-13',
    config: { at: { ownerWake: true } }, busy: true, deps,
  })
  assert.deepEqual(seq.map((x) => x[0]), ['deliver'])
  assert.equal(out.woke, null)
})

test('叫醒被关掉 / 没有主人 @：只递不叫', async () => {
  const a = harness()
  await deliverMentions({
    root: '/tmp/fish-mentions', ctx: {}, picked: ownerMention, agent: { id: 'a' },
    h: { sessionId: 's-her' }, dk: '2026-11-13', config: { at: { ownerWake: false } }, deps: a.deps,
  })
  assert.deepEqual(a.seq.map((x) => x[0]), ['deliver'])

  const b = harness()
  await deliverMentions({
    root: '/tmp/fish-mentions', ctx: {}, picked: [{ fromOwner: false, id: 2 }], agent: { id: 'a' },
    h: { sessionId: 's-her' }, dk: '2026-11-13', config: { at: { ownerWake: true } }, deps: b.deps,
  })
  assert.deepEqual(b.seq.map((x) => x[0]), ['deliver'])
})

test('没开着会话（agent 为空）：一句都不递，也不叫', async () => {
  const { seq, deps } = harness()
  await deliverMentions({
    root: '/tmp/fish-mentions', ctx: {}, picked: ownerMention, agent: null,
    h: { sessionId: 's-her' }, dk: '2026-11-13', config: { at: { ownerWake: true } }, deps,
  })
  assert.deepEqual(seq, [])
})

test('投递抛错也不挡叫醒（正文还在队列里，下次补）', async () => {
  const seq = []
  await deliverMentions({
    root: '/tmp/fish-mentions', ctx: {}, picked: ownerMention, agent: { id: 'a' },
    h: { sessionId: 's-her' }, dk: '2026-11-13', config: { at: { ownerWake: true } },
    deps: {
      deliver: async () => { seq.push('deliver'); throw new Error('append 挂了') },
      wake: async () => { seq.push('wake'); return { ok: true } },
    },
  })
  assert.deepEqual(seq, ['deliver', 'wake'])
})
