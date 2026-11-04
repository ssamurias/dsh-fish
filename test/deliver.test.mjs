/**
 * deliver.test.mjs —— 她开口时那条消息怎么递进会话（2026-11-04，用户 m01112）。
 *
 * 三件事必须钉住，任何一件回退都会让「那句话又出现在对话框里」或「她根本没醒」：
 *
 *   1. **形状**：`role:'user'`、`source.kind` 是自己起的 `fish-wake`、自带唯一 id。
 *      来源名一变成 `user`，前端就画回用户气泡——这正是 0.8.5/0.8.6 两次没修好的地方。
 *   2. **正文是空的**：一个空格。正文一旦有字，她就会去解释「谁跟我说了这句话」。
 *   3. **投递后要 flush**：官方定时任务在 `followup()` 之后立刻 `ctx.sessions.flush()`，
 *      否则那张折叠条要等宿主下一拍自然落盘才出现，看着比旧气泡慢半拍。
 *      flush 失败本身不能把已经投递成功的那一轮判成失败。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  FISH_SOURCE_KIND,
  WAKE_PING,
  fishMessage,
  resolveLiveAgent,
  deliverWake,
} from '../lib/deliver.js'
import { classifyMessage } from '../lib/turns.js'

/** 假 sessionController：能给出 agent，也能不给。 */
function fakeSc({ agent, error } = {}) {
  return {
    resolveAgent: async () => (error ? { error } : { agent }),
  }
}

/** 假 agent：记下收到的东西，`session` 用来让 flush 有目标。 */
function fakeAgent(session = { id: 's' }) {
  const got = []
  return {
    got,
    session,
    followup(message) { got.push(message) },
  }
}

test('消息形状：user 角色 + 自有来源名 + 自带 id', () => {
  const a = fishMessage(' ', { rpcId: 'proactive-1' })
  assert.equal(a.role, 'user', '宿主只认 role=user 的消息才能开一轮')
  assert.equal(a.source.kind, FISH_SOURCE_KIND)
  assert.equal(a.source.kind, 'fish-wake')
  assert.notEqual(a.source.kind, 'user', '来源一旦是 user，前端就画成他打的字')
  assert.equal(a.source.rpcId, 'proactive-1')
  assert.ok(typeof a.id === 'string' && a.id.length > 10, '裸对象必须自带 id，否则两条会撞 already pending')
  assert.deepEqual(a.content, [{ type: 'text', text: ' ' }])

  const b = fishMessage()
  assert.notEqual(a.id, b.id, '两条消息的 id 不许重复')
  assert.equal(b.source.rpcId, undefined, '不传 rpcId 就不要凭空造一个')
})

test('正文是空的：她不该看见一句可被解读的话', () => {
  assert.equal(WAKE_PING.trim(), '', '投递信号不许带正文')
  assert.equal(fishMessage().content[0].text, WAKE_PING)
  // 显式传 null / undefined 也要落回空信号，不能变成字符串 "null"
  assert.equal(fishMessage(null).content[0].text, WAKE_PING)
  assert.equal(fishMessage(undefined).content[0].text, WAKE_PING)
})

test('来源名落在机器消息那一档：她自己醒来的话不算「他来过」', () => {
  assert.equal(classifyMessage({ source: { kind: FISH_SOURCE_KIND } }), 'context')
})

test('投递：走 followup，并立刻 flush 一次', async () => {
  const agent = fakeAgent({ id: 'session-1' })
  const flushed = []
  const ctx = { sessions: { flush: async (session) => { flushed.push(session); return true } } }

  const out = await deliverWake(ctx, fakeSc({ agent }), 'session-1', { rpcId: 'wake-1' })
  assert.deepEqual(out, { ok: true, via: 'followup' })
  assert.equal(agent.got.length, 1)
  assert.equal(agent.got[0].source.kind, FISH_SOURCE_KIND)
  assert.equal(agent.got[0].source.rpcId, 'wake-1')
  assert.equal(flushed.length, 1, 'followup 之后必须显式 flush，否则卡片要等宿主下一拍')
  assert.equal(flushed[0], agent.session, 'flush 的对象是 agent 上那条会话')
})

test('flush 抛错不影响投递结论：消息已经进了收件箱', async () => {
  const agent = fakeAgent()
  const why = []
  const ctx = { sessions: { flush: async () => { throw new Error('disk gone') } } }

  const out = await deliverWake(ctx, fakeSc({ agent }), 'session-1', { log: (a, b) => why.push([a, b]) })
  assert.equal(out.ok, true)
  assert.equal(agent.got.length, 1)
  assert.equal(why.length, 0, 'flush 自己抛错时静默处理，不要往日志里刷失败')
})

test('宿主没给 sessions / 没给 agent.session：跳过 flush，照样算投递成功', async () => {
  const agent = fakeAgent(undefined)
  const out1 = await deliverWake({}, fakeSc({ agent }), 'session-1')
  assert.equal(out1.ok, true)
  assert.equal(agent.got.length, 1)

  const agent2 = fakeAgent()
  const out2 = await deliverWake({ sessions: {} }, fakeSc({ agent: agent2 }), 'session-1')
  assert.equal(out2.ok, true)
})

test('flush 说「没有监听参与」时留一条日志，但不算失败', async () => {
  const agent = fakeAgent()
  const why = []
  const ctx = { sessions: { flush: async () => false } }
  const out = await deliverWake(ctx, fakeSc({ agent }), 'session-1', { log: (a, b) => why.push([a, b]) })
  assert.equal(out.ok, true)
  assert.equal(why.length, 1)
  assert.match(String(why[0][1]), /监听/)
})

test('拿不到 agent 就不投：抛给人话，不让上层猜', async () => {
  await assert.rejects(
    () => resolveLiveAgent(fakeSc({ error: new Error('host down') }), 's1'),
    /host down/,
  )
  await assert.rejects(
    () => resolveLiveAgent({}, 's1'),
    /resolveAgent/,
  )
  await assert.rejects(
    () => resolveLiveAgent({ resolveAgent: async () => ({}) }, 's1'),
    /没把 agent 交出来/,
  )
})

test('投递失败：返回 ok:false 带上原因，且绝不回退到 sc.prompt', async () => {
  let promptCalls = 0
  const sc = {
    resolveAgent: async () => { throw new Error('主机没响应') },
    prompt: () => { promptCalls += 1; throw new Error('不该走到这里') },
  }
  const out = await deliverWake({}, sc, 'session-1')
  assert.equal(out.ok, false)
  assert.match(String(out.why), /主机没响应/)
  assert.equal(promptCalls, 0, '回退 sc.prompt 等于把这次修复悄悄撤回')
})

test('没有会话 id 直接拒绝，不去碰宿主', async () => {
  const agent = fakeAgent()
  const out = await deliverWake({}, fakeSc({ agent }), '')
  assert.equal(out.ok, false)
  assert.equal(agent.got.length, 0)
})
