/**
 * meta-noise.test.mjs —— 记账行和「她的事」怎么分（2026-11-02，用户 m00335）
 *
 * 为什么有这组测试：线上账本 443 行里 400 行是 meta（90%），界面却一律报成
 * 「事件 443 条」。拆开数之后有三条边界必须钉住，否则下次谁都能顺手改回去：
 *   1. 只在**读的时候**分——文件一行不改（AGENTS.md 第 5 条）。
 *   2. 只有 quiet: / 家换了： 算纯记账；其它 meta 前缀都有读取方，
 *      一旦被归成"噪音"就会在界面上消失，而那些前缀是去重、额度、闸门的依据。
 *   3. 不是 meta 的一律算她的事（听见的、日记、种子、拒绝都在这一侧）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { countEvents, isNoiseMeta, NOISE_PREFIXES } from '../lib/meta.js'

function meta(text) {
  return { id: `m_${text}`, type: 'meta', source: 'system', text }
}

test('纯记账只认 quiet: 与 家换了：（其余 meta 有读取方，不许归噪音）', () => {
  assert.deepEqual(NOISE_PREFIXES, ['quiet:', '家换了：'])

  assert.equal(isNoiseMeta(meta('quiet:2026-10-27')), true)
  assert.equal(isNoiseMeta(meta('家换了：C:\\a → C:\\b')), true)

  // 这些前缀都有读取方：seen 去重、looked 的 7 天闸门、sched 的落点、
  // fired 的模板消耗、reject 的驳回记录……归成噪音就会让对应用户无感地失效。
  for (const text of [
    'seen:2026-11-02',
    'looked:BV1xx411c7mD',
    'look:BV1xx411c7mD',
    'watched:BV1xx411c7mD',
    'sched:2026-11-03',
    'wake:2026-11-03',
    'fired:t1',
    'diary:2026-11-02',
    'sleep:2026-11-02',
    'browse:2026-11-02',
    'proactive-turn:2026-11-02',
    'proactive-say:ev_1',
    'ask-no:ev_1',
    'outing-reject:ev_1',
    'possess-reject:ev_1',
  ]) {
    assert.equal(isNoiseMeta(meta(text)), false, `${text} 不是纯记账`)
  }
})

test('不是 meta 的东西不算噪音——哪怕文本开头长得像', () => {
  assert.equal(isNoiseMeta({ type: 'utterance', text: 'quiet:2026-10-27' }), false)
  assert.equal(isNoiseMeta({ type: 'voice', text: '家换了：某处' }), false)
  assert.equal(isNoiseMeta(null), false)
  assert.equal(isNoiseMeta({}), false)
})

test('countEvents 拆成四份，加起来对得上', () => {
  const events = [
    { id: 'e1', type: 'utterance', text: '我不想被催。' },
    { id: 'e2', type: 'voice', text: '别人说的一句。' },
    meta('quiet:2026-10-27'),
    meta('quiet:2026-10-27'),
    meta('家换了：C:\\a → C:\\b'),
    meta('seen:2026-11-02'),
    meta('looked:BV1'),
  ]
  const c = countEvents(events)
  assert.equal(c.all, 7)
  assert.equal(c.meta, 5, '五条 meta')
  assert.equal(c.noise, 3, '两条 quiet + 一条 家换了')
  assert.equal(c.real, 2, '她自己记下的只有两句')
  assert.equal(c.meta + c.real, c.all)
})

test('空账本与坏输入都不炸', () => {
  assert.deepEqual(countEvents(), { all: 0, meta: 0, noise: 0, real: 0 })
  assert.deepEqual(countEvents([]), { all: 0, meta: 0, noise: 0, real: 0 })
  assert.deepEqual(countEvents(null), { all: 0, meta: 0, noise: 0, real: 0 })
  // 坏行（readEvents 已经跳过它们）不该让计数变成 NaN
  const c = countEvents([null, undefined, { type: 'meta' }, { type: 'meta', text: '' }])
  assert.equal(c.all, 4)
  assert.equal(c.meta, 2)
  assert.equal(c.noise, 0)
})
