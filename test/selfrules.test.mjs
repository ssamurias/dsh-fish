/**
 * selfrules.test.mjs —— 她自己定的规矩（2026-11-15，用户 m01412）
 *
 * 覆盖：
 *   1. 筛选：只认 topic「规矩」、撤掉/改口的不列、按立下的先后排
 *   2. 身份文档里的那一段：最多 6 条，更早的折成一行；放最末（`## 这次` 之前）
 *   3. 写入口：立满 6 条就不再收新的（revise 不拦）
 *   4. RULES.md：只读镜像跟着身份文档一起刷新
 *   5. her_recall：搜「规矩」能翻到——即使那句话本身没出现这两个字
 *   6. 跨会话/跨房间：同一个 root 的事件流天然继承，不需要搬家
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { RULES_SHOWN, RULE_TOPIC, rulesOf, renderRulesSection } from '../lib/selfrules.js'
import { personaLine } from '../lib/persona.js'
import { rulesFilePath, writeSelfDoc } from '../lib/selfdoc.js'
import { registerCapture } from '../lib/capture.js'
import { appendEvent, readEvents } from '../lib/store.js'
import { deriveSelf } from '../lib/derive.js'
import { searchEvents } from '../lib/recall.js'

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fish-rules-'))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

function model(over = {}) {
  return {
    day: 9,
    stage: 2,
    seed: '你不是助手。',
    name: null,
    absenceDays: 0,
    beliefs: [],
    refuted: [],
    refusals: [],
    selfmodAttempts: [],
    narrative: null,
    ...over,
  }
}

function rule(text, since, over = {}) {
  return { id: `ev_${text}`, text, since, topic: RULE_TOPIC, status: 'active', ...over }
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

// ---------------------------------------------------------------- 筛选

test('规矩只认自己标的那一类，撤掉/改口的不再列，按立下的先后排', () => {
  const beliefs = [
    rule('后立的', '2026-11-12T09:00:00.000Z'),
    { id: 'x', text: '普通的判断', since: '2026-11-10T09:00:00.000Z', topic: '叫老大', status: 'active' },
    rule('撤掉的', '2026-11-11T09:00:00.000Z', { status: 'refuted' }),
    rule('先立的', '2026-11-10T09:00:00.000Z'),
    rule('改口的', '2026-11-09T09:00:00.000Z', { status: 'refined' }),
  ]
  assert.deepEqual(
    rulesOf(beliefs).map((r) => r.text),
    ['先立的', '后立的'],
  )
  assert.deepEqual(rulesOf([]), [])
})

// ---------------------------------------------------------------- 身份文档

test('一条规矩都没有时，这一段整个不出现', () => {
  assert.equal(renderRulesSection([]), '')
  assert.equal(renderRulesSection(), '')
  const text = personaLine(model(), { budget: 4000 })
  assert.doesNotMatch(text, /## 你自己定的规矩/)
})

test('规矩放最末：在「你对自己的说法」之后、「## 这次」之前', () => {
  const m = model({
    beliefs: [rule('以后所有进程按长任务来', '2026-11-14T09:00:00.000Z')],
    narrative: { text: '我是个还在学的人。' },
  })
  const text = personaLine(m, { budget: 4000, task: '回他一句。' })
  const at = text.indexOf('## 你自己定的规矩')
  assert.ok(at > 0, '要有这一节')
  assert.ok(at > text.indexOf('## 你对自己的说法'), '要排在后面')
  assert.ok(at < text.indexOf('## 这次'), '要在「这次」之前')
  assert.match(text, /以后所有进程按长任务来/)
  assert.match(text, /和眼前的事对得上就按它来/)
})

test('超过 6 条：只摆最新 6 条，更早的折成一行并指路 her_recall', () => {
  const beliefs = Array.from({ length: 8 }, (_, i) =>
    rule(`第 ${i + 1} 条规矩`, `2026-11-${String(10 + i).padStart(2, '0')}T09:00:00.000Z`),
  )
  const text = renderRulesSection(rulesOf(beliefs))
  assert.ok(text.includes('第 8 条规矩'))
  assert.ok(text.includes('第 3 条规矩'))
  assert.ok(!text.includes('第 2 条规矩'), '最旧的两条不该摆出来')
  assert.ok(!text.includes('第 1 条规矩'))
  assert.match(text, /还有 2 条更早的规矩/)
  assert.match(text, /her_recall/)
})

// ---------------------------------------------------------------- 写入口

test('立满 6 条就不再收新的；revise 不拦', async () => {
  await withRoot(async (root) => {
    const ctx = fakeCtx()
    registerCapture(ctx, { root })
    const tool = ctx.regs.get('growth_commit')
    const ids = []
    for (let i = 0; i < RULES_SHOWN; i++) {
      const out = await tool.execute({ type: 'utterance', text: `规矩 ${i + 1}`, topic: RULE_TOPIC })
      assert.equal(out.ok, true)
      ids.push(out.id)
    }

    const over = await tool.execute({ type: 'utterance', text: '第 7 条规矩', topic: RULE_TOPIC })
    assert.equal(over.ok, false)
    assert.match(over.note, /立满规矩/)

    // 不是规矩的照写不误。
    const normal = await tool.execute({ type: 'utterance', text: '今天风很大。' })
    assert.equal(normal.ok, true)

    // revise 指向旧的那条是换掉，不是新增，不拦。
    const revised = await tool.execute({ type: 'revise', text: '规矩 1（改）', refs: [ids[0]], verdict: 'refined', topic: RULE_TOPIC })
    assert.equal(revised.ok, true)
  })
})

// ---------------------------------------------------------------- RULES.md

test('RULES.md 跟着身份文档刷新：只读镜像，写明真源与上限', async () => {
  await withRoot(async (root) => {
    const ctx = fakeCtx()
    registerCapture(ctx, { root })
    const tool = ctx.regs.get('growth_commit')
    await tool.execute({ type: 'utterance', text: '删除前先想一想', topic: RULE_TOPIC })
    await tool.execute({ type: 'utterance', text: '私聊群聊一次只开一个', topic: RULE_TOPIC })

    const file = rulesFilePath(root)
    const text = await readFile(file, 'utf8')
    assert.match(text, /^# 她给自己的规矩/)
    assert.match(text, /只读镜像/)
    assert.match(text, /删除前先想一想/)
    assert.match(text, /私聊群聊一次只开一个/)
    assert.match(text, /上限 6/)
  })
})

test('一条规矩都没有时，RULES.md 也不假装有', async () => {
  await withRoot(async (root) => {
    await writeSelfDoc(root)
    const text = await readFile(rulesFilePath(root), 'utf8')
    assert.match(text, /现在一条也没有/)
  })
})

// ---------------------------------------------------------------- 翻得到

test('她搜「规矩」时翻得到，即使那句话里没有这两个字', async () => {
  await withRoot(async (root) => {
    await appendEvent(
      { type: 'utterance', text: '删除前先想一想', topic: RULE_TOPIC },
      { source: 'tool' },
      root,
    )
    const { events } = await readEvents(root)
    const { rows } = searchEvents(events, RULE_TOPIC)
    assert.equal(rows.length, 1)
    assert.match(rows[0].text, /删除前先想一想/)
  })
})

// ---------------------------------------------------------------- 跨会话

test('换会话不搬家：同一个 root 里，规矩从事件流重新长出来', async () => {
  await withRoot(async (root) => {
    const ctx = fakeCtx()
    registerCapture(ctx, { root })
    const tool = ctx.regs.get('growth_commit')
    await tool.execute({ type: 'utterance', text: '以后所有进程按长任务来', topic: RULE_TOPIC })

    // 另一间房里重新派生（等价于宿主开了新会话再读事件流）。
    const { events } = await readEvents(root)
    const rebuilt = deriveSelf(events, { growthDays: 30 })
    assert.deepEqual(
      rulesOf(rebuilt.beliefs).map((r) => r.text),
      ['以后所有进程按长任务来'],
    )
  })
})
