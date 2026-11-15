/**
 * scrub.test.mjs —— 正文里漏出的工具调用语法要被洗掉（2026-11-10）
 *
 * 案发：外部用户两个人都看到「正文」里明晃晃夹着
 *   <her_note action="list" filter="open"/>
 * 和成串的 `</｜｜DSML｜｜ invoke>`。她自己的账本是干净的（markup.js 早就挡了），
 * 脏的只是会话里那条 assistant 原文。这是最后一道：模型吐出 chunk 的时候洗掉。
 *
 * 两条底线钉在这里：
 *   1. 正常正文一个字符都不许动（`a < b`、`<div>`、中文标点）；
 *   2. 清洗自己炸了必须原样放行——少洗一次只是多一行脏字，
 *      把流打断了是她这一轮整个说不出来。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  EMPTY_AFTER_SCRUB,
  attachStreamScrub,
  hasLeakedToolSyntax,
  scrubbedToolNames,
  stripLeakedToolSyntax,
} from '../lib/scrub.js'
import { noteRegisteredTool } from '../lib/toolreg.js'

const DSML = '｜｜DSML｜｜'

// 工具名要靠活体注册记录才认得全；测试里没有那套注册流程，直接喂一遍。
noteRegisteredTool('her_note')
noteRegisteredTool('her_recall')

test('自闭合的工具标签整段拿掉，前后真话留着', () => {
  const raw = '那你有话就说，没话就歇着。\n<her_note action="list" filter="open"/>\n我这边不用你陪着我。'
  const out = stripLeakedToolSyntax(raw)
  assert.equal(out, '那你有话就说，没话就歇着。\n我这边不用你陪着我。')
})

test('带参数的成对标签连里面的参数一起拿掉（那不是话）', () => {
  const raw = '我想想。<her_recall query="上次说的那件事">{"limit":3}</her_recall>嗯，记起来了。'
  assert.equal(stripLeakedToolSyntax(raw), '我想想。嗯，记起来了。')
})

test('只剩收尾标签也认得', () => {
  assert.equal(stripLeakedToolSyntax('前半句</her_note>后半句'), '前半句后半句')
})

test('成串的 DSML 收尾标记洗掉，前面的真话不留残渣', () => {
  const raw = `不是说手气差。${DSML}` // 截在这里，后面没写完
  assert.equal(stripLeakedToolSyntax(raw), '不是说手气差。')
  const chain = `</${DSML} parameter> </${DSML} invoke> </${DSML} calls>`
  assert.equal(stripLeakedToolSyntax(chain), '')
})

test('只有标记的一步返回空串（意思是这一步她没有正文）', () => {
  assert.equal(stripLeakedToolSyntax(`</${DSML} invoke>`), '')
  assert.equal(stripLeakedToolSyntax('<her_note action="list"/>'), '')
  assert.equal(stripLeakedToolSyntax(''), '')
})

test('正常正文一个字符都不改', () => {
  const cases = [
    '他写了一句 a < b && c > d，还有 <div> 这种标签。',
    '1 < 2 是对的，2 > 1 也是对的。',
    '我看了那期视频，UP 主讲的是 <b>排版</b> 这件事。',
    '嗯。',
    '',
  ]
  for (const s of cases) assert.equal(stripLeakedToolSyntax(s), s, `不该动：${s}`)
})

test('别的工具的 XML 不碰（只认我们自己注册过的名字）', () => {
  const raw = '他发来 <qq_send_message to="123"/> 这么一句。'
  assert.equal(stripLeakedToolSyntax(raw), raw)
})

test('流式增量里各自 trim 会把词粘成一片，所以增量那一路要关掉 trim', () => {
  const a = stripLeakedToolSyntax('我 们', { trim: false })
  const b = stripLeakedToolSyntax(' 在 这', { trim: false })
  assert.equal((a + b).trim(), '我 们 在 这')
})

test('没闭合的残标从它开始切到行尾（后面跟着的是参数，不是话）', () => {
  assert.equal(stripLeakedToolSyntax('我先看看。<her_note action="li'), '我先看看。')
})

test('hasLeakedToolSyntax 认得出脏的、认不出干净的', () => {
  assert.equal(hasLeakedToolSyntax('<her_note action="list"/>'), true)
  assert.equal(hasLeakedToolSyntax(`</${DSML} invoke>`), true)
  assert.equal(hasLeakedToolSyntax('他写了一句 a < b，还有 <div>。'), false)
  // 连着调两次也要判对（带 g 的正则会记 lastIndex）
  assert.equal(hasLeakedToolSyntax('<her_note action="list"/>'), true)
  assert.equal(hasLeakedToolSyntax('<her_note action="list"/>'), true)
})

test('scrubbedToolNames 里至少有她自己那十二件', () => {
  const names = scrubbedToolNames()
  for (const n of ['her_note', 'her_recall', 'her_leave', 'bili_look', 'ask_owner']) {
    assert.ok(names.includes(n), `漏了 ${n}`)
  }
})

/** 造一条假的模型流。 */
async function* streamOf(chunks) {
  for (const c of chunks) yield c
}

async function collect(iter) {
  const out = []
  for await (const c of iter) out.push(c)
  return out
}

test('llm/stream：text-delta 洗干净，block-end 的正文也洗一遍', async () => {
  let handler = null
  const agent = { ctx: { on: (evt, fn) => { if (evt === 'llm/stream') handler = fn; return () => {} } }, session: { header: { id: 's1' } } }
  attachStreamScrub(agent)
  assert.equal(typeof handler, 'function')

  const chunks = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '那你有话就说。' },
    { type: 'text-delta', index: 0, text: '<her_note action="list" filter="open"/>' },
    { type: 'text-delta', index: 0, text: '我不用你陪着。' },
    {
      type: 'block-end',
      index: 0,
      block: { type: 'text', text: '那你有话就说。<her_note action="list" filter="open"/>我不用你陪着。' },
    },
    { type: 'finish', reason: 'end' },
  ]
  const out = await collect(handler({ sessionId: 's1' }, () => streamOf(chunks)))

  const deltas = out.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert.equal(deltas, '那你有话就说。我不用你陪着。')
  const block = out.find((c) => c.type === 'block-end').block
  assert.equal(block.text, '那你有话就说。我不用你陪着。')
  // 别的字段一个不动
  assert.equal(out.filter((c) => c.type === 'block-start').length, 1)
  assert.equal(out.at(-1).type, 'finish')
})

test('llm/stream：标记被切在两个 chunk 之间也能接上', async () => {
  let handler = null
  const agent = { ctx: { on: (evt, fn) => { if (evt === 'llm/stream') handler = fn; return () => {} } }, session: { header: { id: 's1' } } }
  attachStreamScrub(agent)

  const chunks = [
    { type: 'text-delta', index: 0, text: '前半句<her_' },
    { type: 'text-delta', index: 0, text: 'note action="list"/>后半句' },
    { type: 'finish', reason: 'end' },
  ]
  const out = await collect(handler({ sessionId: 's1' }, () => streamOf(chunks)))
  const text = out.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert.equal(text, '前半句后半句')
})

test('llm/stream：压着的半截在流结束时放出来，不许吞字', async () => {
  let handler = null
  const agent = { ctx: { on: (evt, fn) => { if (evt === 'llm/stream') handler = fn; return () => {} } }, session: { header: { id: 's1' } } }
  attachStreamScrub(agent)

  // '1 < 2' 里的 '<' 后面不像标记，当场就放行；'<div' 这种也不压
  const chunks = [
    { type: 'text-delta', index: 0, text: 'a < b' },
    { type: 'finish', reason: 'end' },
  ]
  const out = await collect(handler({ sessionId: 's1' }, () => streamOf(chunks)))
  assert.equal(out.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''), 'a < b')
})

test('llm/stream：别人的会话一个字节都不碰', async () => {
  let handler = null
  const agent = { ctx: { on: (evt, fn) => { if (evt === 'llm/stream') handler = fn; return () => {} } }, session: { header: { id: 's1' } } }
  attachStreamScrub(agent)

  const chunks = [
    { type: 'text-delta', index: 0, text: '<her_note action="list"/>' },
    { type: 'finish', reason: 'end' },
  ]
  const out = await collect(handler({ sessionId: 'other' }, () => streamOf(chunks)))
  assert.equal(out.filter((c) => c.type === 'text-delta')[0].text, '<her_note action="list"/>')
})

test('llm/stream：认不出这是哪一间会话时，宁可不动', async () => {
  let handler = null
  // agent 上既没有 session，也没传 sessionId：未知就应该放行原样
  const agent = { ctx: { on: (evt, fn) => { if (evt === 'llm/stream') handler = fn; return () => {} } } }
  attachStreamScrub(agent)

  const chunks = [
    { type: 'text-delta', index: 0, text: '<her_note action="list"/>' },
    { type: 'finish', reason: 'end' },
  ]
  const out = await collect(handler({ sessionId: 's1' }, () => streamOf(chunks)))
  assert.equal(out.filter((c) => c.type === 'text-delta')[0].text, '<her_note action="list"/>')
})

test('llm/stream：洗的时候炸了也原样放行，不许把她这一轮带塌', async () => {
  let handler = null
  const agent = { ctx: { on: (evt, fn) => { if (evt === 'llm/stream') handler = fn; return () => {} } }, session: { header: { id: 's1' } } }
  attachStreamScrub(agent)

  // text 是个会在取的时候炸的东西：走到清洗里就抛
  const evil = {
    type: 'text-delta',
    index: 0,
    get text() { throw new Error('boom') },
  }
  const chunks = [evil, { type: 'finish', reason: 'end' }]
  const out = await collect(handler({ sessionId: 's1' }, () => streamOf(chunks)))
  assert.equal(out.length, 2)
  assert.equal(out.at(-1).type, 'finish')
})

test('attachStreamScrub：老宿主没有 ctx.on 时返回 undefined，不抛', () => {
  assert.equal(attachStreamScrub({ ctx: {} }), undefined)
  assert.equal(attachStreamScrub({}), undefined)
  assert.equal(attachStreamScrub(undefined), undefined)
  assert.equal(attachStreamScrub({ ctx: { on: () => { throw new Error('unsupported') } } }), undefined)
})

test('llm/stream：她自己续写的 user/assistant 假对话不该进这一轮正文（W49）', async () => {
  let handler = null
  const agent = { ctx: { on: (evt, fn) => { if (evt === 'llm/stream') handler = fn; return () => {} } }, session: { header: { id: 's1' } } }
  attachStreamScrub(agent)

  const fake = '石柱、梯田、电线、蓝天，都在。\nuser 是的，我只是骑到这边拍的\nassistant 嗯'
  const chunks = [
    { type: 'text-delta', index: 0, text: '石柱、梯田、电线、蓝天，都在。\n' },
    { type: 'text-delta', index: 0, text: 'user 是的，我只是骑到这边拍的\n' },
    { type: 'text-delta', index: 0, text: 'assistant 嗯' },
    { type: 'block-end', index: 0, block: { type: 'text', text: fake } },
    { type: 'finish', reason: 'end' },
  ]
  const out = await collect(handler({ sessionId: 's1' }, () => streamOf(chunks)))
  const deltas = out.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert.equal(deltas.trimEnd(), '石柱、梯田、电线、蓝天，都在。')
  assert.equal(out.find((c) => c.type === 'block-end').block.text, '石柱、梯田、电线、蓝天，都在。')
})

test('llm/stream：user 被切成 us + er 两半也认得出（不能各放一半）', async () => {
  let handler = null
  const agent = { ctx: { on: (evt, fn) => { if (evt === 'llm/stream') handler = fn; return () => {} } }, session: { header: { id: 's1' } } }
  attachStreamScrub(agent)

  const chunks = [
    { type: 'text-delta', index: 0, text: '好的。\n' },
    { type: 'text-delta', index: 0, text: 'us' },
    { type: 'text-delta', index: 0, text: 'er 你好' },
    { type: 'finish', reason: 'end' },
  ]
  const out = await collect(handler({ sessionId: 's1' }, () => streamOf(chunks)))
  const deltas = out.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert.equal(deltas.trimEnd(), '好的。')
})

test('llm/stream：正常正文里 per-user 这种词一个字都不动', async () => {
  let handler = null
  const agent = { ctx: { on: (evt, fn) => { if (evt === 'llm/stream') handler = fn; return () => {} } }, session: { header: { id: 's1' } } }
  attachStreamScrub(agent)

  const chunks = [
    { type: 'text-delta', index: 0, text: '这是 user experience 与 assistant 的差别。' },
    { type: 'finish', reason: 'end' },
  ]
  const out = await collect(handler({ sessionId: 's1' }, () => streamOf(chunks)))
  assert.equal(
    out.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''),
    '这是 user experience 与 assistant 的差别。',
  )
})

/** 造一个能同时拿两个监听的 agent。 */
function scrubAgent(id = 's1') {
  const hooks = {}
  const agent = {
    ctx: {
      on: (evt, fn) => {
        hooks[evt] = fn
        return () => { delete hooks[evt] }
      },
    },
    session: { header: { id } },
  }
  attachStreamScrub(agent)
  return { agent, hooks }
}

test('llm/stream：整段都是工具标记、洗完一个字不剩时，finish 改写成 error（让宿主重来）', async () => {
  let handler = null
  const agent = { ctx: { on: (evt, fn) => { if (evt === 'llm/stream') handler = fn; return () => {} } }, session: { header: { id: 's1' } } }
  attachStreamScrub(agent)

  const chunks = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '<her_note action="list" filter="open"/>' },
    { type: 'block-end', index: 0, block: { type: 'text', text: '<her_note action="list" filter="open"/>' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const out = await collect(handler({ sessionId: 's1' }, () => streamOf(chunks)))
  const tail = out.at(-1)
  assert.equal(tail.type, 'finish')
  assert.equal(tail.reason.kind, 'error')
  assert.equal(tail.reason.failure.code, EMPTY_AFTER_SCRUB)
  assert.ok(tail.reason.failure.message.length > 0)
})

test('llm/stream：有工具调用块的那一轮不改写（工具调用本来就是正常收尾）', async () => {
  let handler = null
  const agent = { ctx: { on: (evt, fn) => { if (evt === 'llm/stream') handler = fn; return () => {} } }, session: { header: { id: 's1' } } }
  attachStreamScrub(agent)

  const chunks = [
    { type: 'text-delta', index: 0, text: '<her_note action="list" filter="open"/>' },
    { type: 'block-end', index: 0, block: { type: 'text', text: '<her_note action="list" filter="open"/>' } },
    { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'c1', name: 'her_note', arguments: '{}' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const out = await collect(handler({ sessionId: 's1' }, () => streamOf(chunks)))
  assert.equal(out.at(-1).reason.kind, 'stop')
})

test('llm/stream：正常说了话的一轮不改写 finish', async () => {
  let handler = null
  const agent = { ctx: { on: (evt, fn) => { if (evt === 'llm/stream') handler = fn; return () => {} } }, session: { header: { id: 's1' } } }
  attachStreamScrub(agent)

  const chunks = [
    { type: 'text-delta', index: 0, text: '嗯，我在。' },
    { type: 'block-end', index: 0, block: { type: 'text', text: '嗯，我在。' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const out = await collect(handler({ sessionId: 's1' }, () => streamOf(chunks)))
  assert.equal(out.at(-1).reason.kind, 'stop')
})

test('agent/request-error：EMPTY_AFTER_SCRUB 同一个 turn 只重试一次，第二次交给宿主', async () => {
  const { agent, hooks } = scrubAgent()
  const err = hooks['agent/request-error']
  assert.equal(typeof err, 'function')

  let nexts = 0
  const next = () => { nexts += 1; return Promise.resolve('host') }
  const payload = { agent, turn: 7, step: 2, failure: { code: EMPTY_AFTER_SCRUB } }

  assert.deepEqual(await err(payload, next), { kind: 'retry' })
  assert.equal(nexts, 0)
  assert.deepEqual(await err(payload, next), 'host')
  assert.equal(nexts, 1)

  // 换一个 turn：还能再来一次
  assert.deepEqual(await err({ ...payload, turn: 8 }, next), { kind: 'retry' })
})

test('agent/request-error：别的错误码、别的 agent 一律放行', async () => {
  const { agent, hooks } = scrubAgent()
  const err = hooks['agent/request-error']
  let nexts = 0
  const next = () => { nexts += 1; return Promise.resolve('host') }

  assert.equal(await err({ agent, turn: 1, step: 1, failure: { code: 'STREAM_BROKE' } }, next), 'host')
  assert.equal(await err({ agent: { other: true }, turn: 1, step: 1, failure: { code: EMPTY_AFTER_SCRUB } }, next), 'host')
  assert.equal(nexts, 2)
})

test('attachStreamScrub：返回的 disposer 把两个监听都摘掉', () => {
  const hooks = {}
  const offs = []
  const agent = {
    ctx: {
      on: (evt, fn) => {
        hooks[evt] = fn
        const off = () => { delete hooks[evt]; offs.push(evt) }
        return off
      },
    },
    session: { header: { id: 's1' } },
  }
  const dispose = attachStreamScrub(agent)
  assert.equal(typeof dispose, 'function')
  assert.deepEqual(Object.keys(hooks).sort(), ['agent/request-error', 'llm/stream'])
  dispose()
  assert.deepEqual(hooks, {})
  assert.deepEqual(offs.sort(), ['agent/request-error', 'llm/stream'])
})
