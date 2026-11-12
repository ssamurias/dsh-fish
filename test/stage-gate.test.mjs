import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  gatedStage, envelopeOf, rememberGateStage, gateStageOf, deriveSelf,
} from '../lib/derive.js'
import { registerCapture } from '../lib/capture.js'
import { readEvents, writeConfig } from '../lib/store.js'
import { normalizeConfig, updateConfig } from '../lib/settings.js'

const DAY_MS = 24 * 60 * 60 * 1000

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fish-gate-'))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

/** 假宿主：只实现 tools.register */
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

test('gatedStage：取时间阶段与门里更小的那个', () => {
  assert.equal(gatedStage(3, 2), 2)
  assert.equal(gatedStage(1, 3), 1)
  assert.equal(gatedStage(4, 4), 4)
  // 没有门（null / undefined / 0 / NaN）就按时间算
  assert.equal(gatedStage(3, null), 3)
  assert.equal(gatedStage(3, undefined), 3)
  assert.equal(gatedStage(3, 0), 3)
  assert.equal(gatedStage(3, NaN), 3)
  // 入参越界也夹回 1–4
  assert.equal(gatedStage(0, 2), 1)
  assert.equal(gatedStage(9, 4), 4)
  assert.equal(gatedStage(9, 9), 4)
})

test('rememberGateStage / gateStageOf：按 root 分开记', () => {
  assert.equal(gateStageOf('d:/a/root'), null, '没派生过是 null，不是 0')
  assert.equal(rememberGateStage('d:/a/root', 2), 2)
  assert.equal(gateStageOf('d:/a/root'), 2)
  assert.equal(gateStageOf('d:/b/root'), null, '另一个 root 不该串到这一份')
  assert.equal(rememberGateStage('d:/a/root', 'x'), 0, '非法值返回 0，不覆盖旧值')
  assert.equal(gateStageOf('d:/a/root'), 2, '旧值还在')
  assert.equal(rememberGateStage('d:/a/root', 9), 4, '门本身也夹到 4')
})

test('envelopeOf 带上 gateStage 后不再写出没到过的阶段', () => {
  const old = new Date(Date.now() - 40 * DAY_MS).toISOString()
  const events = [{ type: 'utterance', text: '嗯。', ts: old, day: 41 }]
  // growthDays 7，第 41 天按时间是第 4 阶段
  const plain = envelopeOf(events, { growthDays: 7 })
  assert.equal(plain.stage, 4)
  const gated = envelopeOf(events, { growthDays: 7, gateStage: 2 })
  assert.equal(gated.stage, 2)
  assert.equal(gated.day, plain.day, '天数不受门影响')
})

test('stagePeak 只认「改周期」留下的 meta，不扫普通事件的 stage（issue #128）', () => {
  const ev = (day, extra) => ({
    id: '',
    ts: new Date(Date.now() - (200 - day) * DAY_MS).toISOString(),
    ...extra,
  })
  const events = [
    // 0.9.8 的 growth_commit 写下的「没压门」的 stage，事件只能追加、改不回来
    ev(3, { type: 'utterance', text: '今天有点累。', stage: 3 }),
    ev(4, { type: 'meta', text: 'stage-was:2' }),
  ]
  const m = deriveSelf(events, { growthDays: 30 })
  assert.equal(m.stage, 1, '第 4 天还是第 1 阶段')
  assert.equal(m.stagePeak, 2, '只认 stage-was:2，不用那条 stage:3')
})

test('没有 stage-was 时，stagePeak 就等于当前阶段', () => {
  const events = [{ id: '', ts: new Date().toISOString(), type: 'utterance', text: '嗯。', stage: 4 }]
  const m = deriveSelf(events, { growthDays: 30 })
  assert.equal(m.stagePeak, m.stage)
})

test('growth_commit 的信封压到门上（端到端）', async () => {
  await withRoot(async (root) => {
    await writeConfig(normalizeConfig({ growthDays: 7 }), root)
    // 一条 40 天前的事件把 day 拉到 41；按时间是第 4 阶段
    const old = new Date(Date.now() - 40 * DAY_MS).toISOString()
    const { appendEvent } = await import('../lib/store.js')
    await appendEvent({ type: 'meta', text: 'old', ts: old }, { day: 41, stage: 1, source: 'system' }, root)

    // 上一次全量派生看到门是 2（卡在自主门上）
    rememberGateStage(root, 2)

    const ctx = fakeCtx()
    registerCapture(ctx, { root })
    const tool = ctx.regs.get('growth_commit')
    assert.ok(tool, '工具必须注册')
    const out = await tool.execute({ type: 'utterance', text: '晚上比白天安静。', confidence: 0.4 })
    assert.equal(out.ok, true)

    const { events } = await readEvents(root)
    const mine = events.filter((e) => e.type === 'utterance' && e.text === '晚上比白天安静。')
    assert.equal(mine.length, 1)
    const written = mine[0]
    assert.ok(written.day > 7, '天数确实是第 41 天左右')
    assert.ok(written.stage <= 2, `信封阶段要压在门上，实际写成 ${written.stage}`)
  })
})

test('改成长周期时，把「改之前的阶段」记成一条 meta（C 的出处）', async () => {
  await withRoot(async (root) => {
    await writeConfig(normalizeConfig({ growthDays: 30 }), root)
    await updateConfig({ growthDays: 15 }, root)
    const { events } = await readEvents(root)
    const marks = events.filter((e) => e.type === 'meta' && String(e.text).startsWith('stage-was:'))
    assert.equal(marks.length, 1, '改一次周期记一条')
    assert.match(marks[0].text, /^stage-was:[1-4]$/)

    // 周期没变就不该再记（设置页自动保存每次都整表回传）
    await updateConfig({ growthDays: 15 }, root)
    const again = (await readEvents(root)).events
      .filter((e) => e.type === 'meta' && String(e.text).startsWith('stage-was:'))
    assert.equal(again.length, 1, '周期没变不重复留痕')
  })
})