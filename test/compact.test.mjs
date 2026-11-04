/**
 * compact.test.mjs —— 她「醒过来、看了一圈、没有开口」的那种轮次怎么收起来
 * （2026-11-05，用户 m00803，借鉴市场插件 dsh-proactive 0.3.2）。
 *
 * 必须钉住的东西（任何一条回退，都是宿主抛错、她的上下文被弄坏，或者他的话被藏起来）：
 *
 *   1. **认对轮次**：只认 `source.rpcId` 等于这次投递的那条 user/message。
 *      认错的话会把他的对话框进墓碑，比不折严重得多。
 *   2. **说没说话**：只有 `assistant/message` 里的非空 text 块算开口（reasoning 不算）。
 *      说了话就不该折——那一轮有内容，还要留在她的历史里。
 *   3. **能盖什么**：区间里每个 surface 节点都得列进 `sourceEventSeqs`（宿主逐条核对，
 *      原文：`surface replace: sourceEventSeqs must include every shadowed surface node`）。
 *   4. **不能盖什么**：宿主自己的 `system/message` 投影、`source.kind==='runtime-context'`
 *      的快照、任何不是这次投递的 user/message。碰到就整轮放弃。
 *   5. **超时不折**：没有 `turn/end` 就没有闭合区间，只记账、不动日志。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  SURFACE_TYPES,
  TOMBSTONE_MARKER,
  compactWake,
  followWake,
  isSurfaceEvent,
  planWakeCompaction,
  tombstoneText,
} from '../lib/compact.js'
import { FISH_SOURCE_KIND } from '../lib/deliver.js'

const RID = 'proactive-1700000000000'
const SESSION = { id: 'session-1' }

const ping = (seq, { rpcId = RID, kind = FISH_SOURCE_KIND } = {}) => ({
  type: 'user/message',
  seq,
  time: 1,
  surfaceOp: 'append',
  data: { id: 'fish-wake-1', role: 'user', content: [{ type: 'text', text: ' ' }], source: { kind, rpcId } },
})

const said = (seq, text = '嗯') => ({
  type: 'assistant/message',
  seq,
  time: 2,
  surfaceOp: 'append',
  data: { message: { id: `m${seq}`, role: 'assistant', content: [{ type: 'text', text }] } },
})

const thinking = (seq) => ({
  type: 'assistant/message',
  seq,
  time: 2,
  surfaceOp: 'append',
  data: { message: { id: `m${seq}`, role: 'assistant', content: [{ type: 'reasoning', text: '想一想' }] } },
})

const system = (seq) => ({
  type: 'system/message',
  seq,
  time: 2,
  surfaceOp: 'append',
  data: { message: { role: 'system', content: [{ type: 'text', text: '投影' }] } },
})

const logOnly = (type, seq) => ({ type, seq, time: 2, data: {} })

/** 假 ctx：只提供 `on('session/event')`，测试里手动 emit。 */
function fakeCtx() {
  const handlers = new Set()
  return {
    on(type, fn) {
      if (type !== 'session/event') return () => {}
      handlers.add(fn)
      return () => handlers.delete(fn)
    },
    emit(session, event) {
      for (const fn of [...handlers]) fn(session, event)
    },
    get size() {
      return handlers.size
    },
  }
}

test('墓碑一句话、带指纹、够短（折叠的意义就是省）', () => {
  const text = tombstoneText()
  assert.match(text, new RegExp(TOMBSTONE_MARKER.replace(/[[\]]/g, '\\$&')))
  assert.ok(text.length < 120, `墓碑不许比一轮本身还长：${text.length} 字`)
  // 两个意思缺一不可：这是她自己的一轮；不用回头补。
  assert.match(text, /她自己/)
  assert.match(text, /不必|不用/)
})

test('哪五种事件算 surface 节点', () => {
  assert.deepEqual([...SURFACE_TYPES].sort(), [
    'assistant/message',
    'developer/message',
    'system/message',
    'tool/result',
    'user/message',
  ])
  assert.equal(isSurfaceEvent({ type: 'user/message', surfaceOp: 'append' }), true)
  assert.equal(isSurfaceEvent({ type: 'turn/start' }), false)
  // 没有 surfaceOp 的 surface 类型在宿主那里本来就会被拒，这里也别当成节点。
  assert.equal(isSurfaceEvent({ type: 'user/message' }), false)
})

test('说话的一轮：认对 ping、spoke=true、拿得到闭合区间', async () => {
  const ctx = fakeCtx()
  const follow = followWake(ctx, { rpcId: RID })
  ctx.emit(SESSION, ping(10))
  ctx.emit(SESSION, logOnly('turn/start', 11))
  ctx.emit(SESSION, thinking(12))
  ctx.emit(SESSION, said(13, '我在'))
  ctx.emit(SESSION, logOnly('turn/end', 14))
  const out = await follow.done
  assert.equal(out.ok, true)
  assert.equal(out.spoke, true)
  assert.equal(out.startSeq, 10)
  assert.equal(out.endSeq, 13)
  assert.equal(out.session, SESSION)
  // 收的是这一轮除 turn/end 之外的全部事件（日志类也在里面，折叠时由 planWakeCompaction 过滤）。
  assert.deepEqual(out.events.map((e) => e.seq), [10, 11, 12, 13])
  assert.equal(ctx.size, 0, '收到 turn/end 就该把监听摘掉')
})

test('只想了没说：spoke=false（reasoning 不是她的话）', async () => {
  const ctx = fakeCtx()
  const follow = followWake(ctx, { rpcId: RID })
  ctx.emit(SESSION, ping(10))
  ctx.emit(SESSION, thinking(11))
  ctx.emit(SESSION, logOnly('turn/end', 12))
  const out = await follow.done
  assert.equal(out.spoke, false)
  assert.equal(out.endSeq, 11)
})

test('别的投递/别的话一律不认：rpcId 对不上就当没开始', async () => {
  const ctx = fakeCtx()
  const follow = followWake(ctx, { rpcId: RID })
  ctx.emit(SESSION, ping(10, { rpcId: 'proactive-别的' }))
  ctx.emit(SESSION, said(11, '他打的字不会长这样，但就算长这样也不该被认'))
  ctx.emit(SESSION, logOnly('turn/end', 12))
  follow.off()
  const out = await follow.done
  assert.equal(out.ok, false)
  assert.equal(out.startSeq, -1, '没认出 ping 就不该开始记区间')
  assert.equal(out.why, 'stopped')
  assert.equal(out.spoke, false)
})

test('超时：没有 turn/end 就给 ok:false，只记账不折', async () => {
  const ctx = fakeCtx()
  const follow = followWake(ctx, { rpcId: RID, timeoutMs: 20 })
  ctx.emit(SESSION, ping(5))
  ctx.emit(SESSION, thinking(6))
  const out = await follow.done
  assert.equal(out.ok, false)
  assert.equal(out.why, 'timeout')
  assert.equal(out.endSeq, -1)
  assert.equal(ctx.size, 0)
})

test('折叠区间：只列 surface 节点，日志类事件（turn/start、step/end）不进名单', () => {
  const events = [
    logOnly('turn/start', 9),
    ping(10),
    logOnly('step/start', 11),
    thinking(12),
    { type: 'tool/result', seq: 13, time: 2, surfaceOp: 'append', data: { message: { role: 'tool' } } },
    said(14, '嗯'),
    logOnly('step/end', 15),
  ]
  const plan = planWakeCompaction(events, { startSeq: 10, endSeq: 15, rpcId: RID })
  assert.ok(plan)
  assert.deepEqual(plan.sourceEventSeqs, [10, 12, 13, 14])
  assert.equal(plan.shadowed, 4)
  assert.equal(plan.startSeq, 10)
  assert.equal(plan.endSeq, 15)
})

test('宿主的 system/message 投影：一律放弃（盖了它会触发整份快照重发）', () => {
  const events = [ping(10), system(11), said(12, '嗯')]
  assert.equal(planWakeCompaction(events, { startSeq: 10, endSeq: 12, rpcId: RID }), null)
})

test('runtime-context 快照：一律放弃', () => {
  const events = [
    ping(10),
    { type: 'user/message', seq: 11, time: 2, surfaceOp: 'append', data: { id: 'ctx', role: 'user', content: [{ type: 'text', text: '上下文' }], source: { kind: 'runtime-context' } } },
    said(12, '嗯'),
  ]
  assert.equal(planWakeCompaction(events, { startSeq: 10, endSeq: 12, rpcId: RID }), null)
})

test('区间里有别人的话（他打的、别的插件注入的）：不折，一个字都不藏', () => {
  const human = { type: 'user/message', seq: 11, time: 2, surfaceOp: 'append', data: { id: 'u1', role: 'user', content: [{ type: 'text', text: '你在吗' }], source: { kind: 'user', rpcId: 'x' } } }
  assert.equal(planWakeCompaction([ping(10), human, said(12, '嗯')], { startSeq: 10, endSeq: 12, rpcId: RID }), null)
  // 同一种 kind 但 rpcId 不是这次投递 —— 也不折（宁可多留）。
  assert.equal(planWakeCompaction([ping(10), ping(11, { rpcId: 'proactive-别的' }), said(12, '嗯')], { startSeq: 10, endSeq: 12, rpcId: RID }), null)
})

test('非法区间 / 没节点：返回 null，不抛', () => {
  const events = [ping(10), said(11, '嗯')]
  assert.equal(planWakeCompaction(events, { startSeq: 11, endSeq: 10 }), null)
  assert.equal(planWakeCompaction(events, { startSeq: -1, endSeq: 5 }), null)
  assert.equal(planWakeCompaction(events, { startSeq: 1.5, endSeq: 2 }), null)
  assert.equal(planWakeCompaction([], { startSeq: 0, endSeq: 1 }), null)
  assert.equal(planWakeCompaction(events, { startSeq: 100, endSeq: 200 }), null)
  // 区间里只有日志类事件 → 没有可盖的节点。
  assert.equal(planWakeCompaction([logOnly('turn/start', 1), logOnly('step/end', 2)], { startSeq: 1, endSeq: 2 }), null)
})

test('compactWake：写的是 user/message + replace + 完整 sourceEventSeqs', async () => {
  const calls = []
  const session = { append(type, data, opts) { calls.push({ type, data, opts }); return { seq: 99 } } }
  const plan = { startSeq: 10, endSeq: 15, sourceEventSeqs: [10, 12, 14], shadowed: 3 }
  const ok = await compactWake(session, plan)
  assert.equal(ok, true)
  assert.equal(calls.length, 1)
  const [{ type, data, opts }] = calls
  assert.equal(type, 'user/message', '墓碑只能是 user/message：assistant/message 禁带 sourceEventSeqs')
  assert.equal(data.role, 'user')
  assert.equal(data.source.kind, FISH_SOURCE_KIND, '沿用同一个来源名，前端才画成折叠条、turns 才把它当机器消息')
  assert.match(data.content[0].text, new RegExp(TOMBSTONE_MARKER.replace(/[[\]]/g, '\\$&')))
  assert.deepEqual(opts.surfaceOp, { op: 'replace', startSeq: 10, endSeq: 15 })
  assert.deepEqual(opts.sourceEventSeqs, [10, 12, 14])
})

test('compactWake：没有会话 / 宿主拒绝，都只返回 false，不抛', async () => {
  assert.equal(await compactWake(null, { startSeq: 1, endSeq: 2, sourceEventSeqs: [1] }), false)
  assert.equal(await compactWake({}, { startSeq: 1, endSeq: 2, sourceEventSeqs: [1] }), false)
  assert.equal(await compactWake({ append() {} }, null), false)
  const logs = []
  const bad = { append() { throw new Error('surface replace: sourceEventSeqs must include every shadowed surface node; missing 7') } }
  const ok = await compactWake(bad, { startSeq: 1, endSeq: 2, sourceEventSeqs: [1] }, { log: (a, b) => logs.push(`${a}|${b}`) })
  assert.equal(ok, false)
  assert.match(logs.join('\n'), /折叠没成/)
  assert.match(logs.join('\n'), /missing 7/)
})
