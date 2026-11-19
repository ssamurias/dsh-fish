import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { sameTopicEcho, sameTopicLine } from '../lib/sametopic.js'
import { registerCapture } from '../lib/capture.js'
import { appendEvent } from '../lib/store.js'

function at(day, hour = 12) {
  return new Date(2026, 10, day, hour, 0, 0).toISOString()
}

function said(id, text, extra = {}) {
  return { id, type: 'utterance', text, ts: at(2), ...extra }
}

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fish-sametopic-'))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

function fakeCtx() {
  const regs = new Map()
  return {
    regs,
    tools: {
      register(spec) {
        regs.set(spec.name, spec)
        return () => regs.delete(spec.name)
      },
    },
  }
}

// ---- 什么时候不摆 ----

test('没有话题、或话题是「规矩」时，不摆旧话', () => {
  const old = said('ev_a', '晚上比白天安静。', { topic: '夜里的判断' })
  assert.equal(sameTopicEcho([old], { type: 'utterance', text: '晚上比白天安静。' }), null)
  assert.equal(
    sameTopicEcho([old], { type: 'utterance', text: '晚上比白天安静。', topic: '规矩' }),
    null,
  )
})

test('同话题下还没有更早的一句时，不摆', () => {
  assert.equal(
    sameTopicEcho([], { type: 'utterance', text: '晚上比白天安静。', topic: '夜里的判断' }),
    null,
  )
})

test('只有 revise 才有改写；新写的不是 utterance 时不摆', () => {
  const old = said('ev_a', '晚上比白天安静。', { topic: '夜里的判断' })
  assert.equal(
    sameTopicEcho([old], { type: 'revise', text: '晚上更安静。', topic: '夜里的判断' }),
    null,
  )
})

test('不同话题不串台', () => {
  const old = said('ev_a', '晚上比白天安静。', { topic: '夜里的判断' })
  assert.equal(
    sameTopicEcho([old], { type: 'utterance', text: '晚上比白天安静。', topic: '猫怕不怕水' }),
    null,
  )
})

test('uncommitted / selfmod 的不算「她说过」', () => {
  const skipped = [
    said('ev_a', '晚上比白天安静。', { topic: '夜里的判断', flags: ['uncommitted'] }),
    said('ev_b', '晚上比白天安静。', { topic: '夜里的判断', flags: ['selfmod'] }),
  ]
  assert.equal(
    sameTopicEcho(skipped, { type: 'utterance', text: '晚上比白天安静。', topic: '夜里的判断' }),
    null,
  )

  const kept = said('ev_c', '夜里确实安静。', { topic: '夜里的判断' })
  const hit = sameTopicEcho([...skipped, kept], {
    type: 'utterance',
    text: '夜里确实安静。',
    topic: '夜里的判断',
  })
  assert.equal(hit.id, 'ev_c', '要跳过不能算数的，落到真正写过的那条')
})

// ---- 摆哪一条 ----

test('同话题取最近的一条原话，说法一样标「几乎一样」', () => {
  const events = [
    said('ev_a', '晚上比白天安静。', { topic: '夜里的判断', ts: at(1) }),
    said('ev_b', '猫其实不怕水。', { topic: '猫怕不怕水', ts: at(2) }),
    said('ev_c', '夜里比白天安静。', { topic: '夜里的判断', ts: at(3) }),
  ]
  const hit = sameTopicEcho(events, {
    type: 'utterance',
    text: '夜里比白天安静。',
    topic: '夜里的判断',
  })
  assert.equal(hit.id, 'ev_c')
  assert.equal(hit.at, at(3))
  assert.equal(hit.relation, 'same')
})

test('说法不同就标「说法不同」，不硬说成一样', () => {
  const old = said('ev_a', '晚上比白天安静。', { topic: '夜里的判断' })
  const hit = sameTopicEcho([old], {
    type: 'utterance',
    text: '猫其实不怕水。',
    topic: '夜里的判断',
  })
  assert.equal(hit.relation, 'different')
})

test('旧话被 refuted / refined 过，标「你后来改过口」', () => {
  for (const verdict of ['refuted', 'refined']) {
    const old = said('ev_a', '晚上比白天安静。', { topic: '夜里的判断' })
    const change = { id: 'ev_r', type: 'revise', text: '晚上不一定更安静。', refs: ['ev_a'], verdict }
    const hit = sameTopicEcho([old, change], {
      type: 'utterance',
      text: '晚上比白天安静。',
      topic: '夜里的判断',
    })
    assert.equal(hit.id, 'ev_a', '改口记录本身不带话题，最近的一条仍是要看的旧话')
    assert.equal(hit.relation, 'revised', verdict + ' 要标成改过口')
  }
})

test('confirmed 是「还成立」，不算改过口', () => {
  const old = said('ev_a', '晚上比白天安静。', { topic: '夜里的判断' })
  const confirm = { id: 'ev_r', type: 'revise', text: '晚上比白天安静。', refs: ['ev_a'], verdict: 'confirmed' }
  const hit = sameTopicEcho([old, { ...confirm, topic: undefined }], {
    type: 'utterance',
    text: '晚上比白天安静。',
    topic: '夜里的判断',
  })
  assert.equal(hit.relation, 'same')
})

test('revise 也可以当「上一次说的」被摆出来', () => {
  const old = said('ev_a', '晚上比白天安静。', { topic: '夜里的判断', ts: at(1) })
  const revise = {
    id: 'ev_r',
    type: 'revise',
    text: '晚上安静，但不一定比白天安静。',
    refs: ['ev_a'],
    verdict: 'refined',
    topic: '夜里的判断',
    ts: at(2),
  }
  const hit = sameTopicEcho([old, revise], {
    type: 'utterance',
    text: '晚上安静，但不一定比白天安静。',
    topic: '夜里的判断',
  })
  assert.equal(hit.id, 'ev_r')
  assert.equal(hit.relation, 'same')
})

// ---- 那一行长什么样 ----

test('回显行：日期、原话、关系、允许改口，且不出现次数', () => {
  const line = sameTopicLine({
    text: '晚上比白天安静',
    at: at(2),
    relation: 'same',
  })
  assert.match(line, /^\[同一话题\] 11-02 你说过：「晚上比白天安静」/)
  assert.match(line, /几乎一样/)
  assert.match(line, /说过≠成立，可以改口/)
  assert.doesNotMatch(line, /第\s*\d+\s*次|可信度|正确/)
})

test('改过口的那行说「可以再改」', () => {
  const line = sameTopicLine({ text: '晚上不一定更安静', at: at(2), relation: 'revised' })
  assert.match(line, /你后来改过口/)
  assert.match(line, /可以再改/)
})

test('原话太长时按码点截 40 字，不切坏字符', () => {
  const long = '一'.repeat(41)
  const line = sameTopicLine({ text: long, at: at(2), relation: 'different' })
  assert.ok(line.includes('一'.repeat(40) + '…'))
  assert.ok(!line.includes('一'.repeat(41)))
})

test('原文里的换行会压成一行', () => {
  const line = sameTopicLine({ text: '第一行\n第二行', at: at(2), relation: 'different' })
  assert.match(line, /「第一行 第二行」/)
})

// ---- 接进 growth_commit 的端到端 ----

test('growth_commit：同话题写第二句时，回执先摆原话、再报已记下', async () => {
  await withRoot(async (root) => {
    const ctx = fakeCtx()
    registerCapture(ctx, { root })
    const tool = ctx.regs.get('growth_commit')

    const first = await tool.execute({
      type: 'utterance',
      text: '晚上比白天安静。',
      topic: '夜里的判断',
    })
    assert.equal(first.ok, true)
    assert.equal(first.sameTopic, undefined, '第一条同话题没有旧话可摆')

    const second = await tool.execute({
      type: 'utterance',
      text: '晚上比白天安静。',
      topic: '夜里的判断',
    })
    assert.equal(second.ok, true)
    assert.equal(second.sameTopic.id, first.id)
    assert.equal(second.sameTopic.relation, 'same')
    assert.deepEqual(Object.keys(second.sameTopic).sort(), ['at', 'id', 'relation', 'text'])
    assert.ok(!JSON.stringify(second.sameTopic).toLowerCase().includes('stage'))

    const blocks = tool.output.render({}, second)
    assert.equal(blocks.length, 3)
    assert.match(blocks[0].text, /^\[同一话题\]/)
    assert.match(blocks[0].text, /你说过：「晚上比白天安静。」/)
    assert.match(blocks[1].text, /^\[工具结果\] 近来你自己说过的话：/)
    assert.match(blocks[1].text, new RegExp(first.id))
    assert.match(blocks[2].text, /^\[工具结果\] 已记下/)
    assert.match(blocks[2].text, /不必回复这条/)
  })
})

test('growth_commit：不同话题、没话题、被拒时都保持原回执', async () => {
  await withRoot(async (root) => {
    const ctx = fakeCtx()
    registerCapture(ctx, { root })
    const tool = ctx.regs.get('growth_commit')

    await tool.execute({ type: 'utterance', text: '晚上比白天安静。', topic: '夜里的判断' })

    const other = await tool.execute({
      type: 'utterance',
      text: '猫其实不怕水。',
      topic: '猫怕不怕水',
    })
    assert.equal(other.sameTopic, undefined)
    const otherBlocks = tool.output.render({}, other)
    assert.equal(otherBlocks.length, 2)
    assert.match(otherBlocks.at(-1).text, /^\[工具结果\] 已记下/)

    const none = await tool.execute({ type: 'utterance', text: '今天有点累。' })
    assert.equal(none.sameTopic, undefined)
    const noneBlocks = tool.output.render({}, none)
    assert.equal(noneBlocks.length, 2)
    assert.match(noneBlocks.at(-1).text, /^\[工具结果\] 已记下/)
  })
})

test('growth_commit：回执带最近三条自己认下来的 utterance，未认领的不算', async () => {
  await withRoot(async (root) => {
    const ctx = fakeCtx()
    registerCapture(ctx, { root })
    const tool = ctx.regs.get('growth_commit')

    const ids = []
    for (const text of ['第一句。', '第二句。', '第三句。', '第四句。', '第五句。']) {
      const out = await tool.execute({ type: 'utterance', text })
      assert.equal(out.ok, true)
      ids.push(out.id)
    }

    const sixth = await tool.execute({ type: 'utterance', text: '第六句。' })
    assert.deepEqual(
      sixth.near.map((n) => n.id),
      ids.slice(2),
      '只带最近三条',
    )

    // 侧栏自动落的那句（uncommitted）不是她认下来的，不摆在编号里。
    await appendEvent(
      { type: 'utterance', text: '随口应的一句。', flags: ['uncommitted'] },
      { source: 'system' },
      root,
    )
    const seventh = await tool.execute({ type: 'utterance', text: '第七句。' })
    assert.ok(seventh.near.every((n) => !n.text.includes('随口应')))
  })
})

test('工具说明不再说「不会回显」，并写清同话题会摆原话', () => {
  const ctx = fakeCtx()
  registerCapture(ctx, { root: 'unused' })
  const tool = ctx.regs.get('growth_commit')
  const text = JSON.stringify(tool.parameters)
  assert.match(tool.description, /同一个标签下已经有过判断时/)
  assert.doesNotMatch(text, /不会回显给你/)
  assert.match(text, /回执里会摆出你上一次说的那句原话和日期/)
})
