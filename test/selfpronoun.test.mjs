import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  SELF_PRONOUN_VALUES, DEFAULT_SELF_PRONOUN, SELF_SLOT, normalizeSelfPronoun,
  selfPronounOf, fillSelf, selfPronounFor, resetSelfPronounCache,
} from '../lib/selfpronoun.js'
import { normalizeConfig, DEFAULTS } from '../lib/settings.js'
import { writeConfig } from '../lib/store.js'

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fish-selfpron-'))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    resetSelfPronounCache()
  }
}

test('她的第三人称只认 他 / 她 / 祂，别的值退回「她」', () => {
  assert.deepEqual([...SELF_PRONOUN_VALUES], ['他', '她', '祂'])
  assert.equal(DEFAULT_SELF_PRONOUN, '她')
  assert.equal(SELF_SLOT, '{S}')
  assert.equal(normalizeSelfPronoun('他'), '他')
  assert.equal(normalizeSelfPronoun('她'), '她')
  assert.equal(normalizeSelfPronoun('祂'), '祂')
  assert.equal(normalizeSelfPronoun(' 祂 '), '祂', '首尾空白不该让人存不进去')
  assert.equal(normalizeSelfPronoun('它'), '她', '「它」不在这个开关里，退回默认')
  assert.equal(normalizeSelfPronoun('牠'), '她')
  assert.equal(normalizeSelfPronoun(''), '她')
  assert.equal(normalizeSelfPronoun(undefined), '她')
  assert.equal(normalizeSelfPronoun(123), '她')
})

test('selfPronounOf 从配置里取，缺省是「她」', () => {
  assert.equal(selfPronounOf({ self: { pronoun: '他' } }), '他')
  assert.equal(selfPronounOf({ self: { pronoun: '祂' } }), '祂')
  assert.equal(selfPronounOf({ self: { pronoun: '她' } }), '她')
  assert.equal(selfPronounOf({}), '她')
  assert.equal(selfPronounOf(null), '她')
  assert.equal(selfPronounOf({ self: '祂' }), '她', 'self 不是对象就退回默认，不炸')
})

test('normalizeConfig 收编 self.pronoun，默认与 1.0.0 一致', () => {
  assert.equal(DEFAULTS.self.pronoun, '她')
  assert.equal(normalizeConfig({}).self.pronoun, '她')
  assert.equal(normalizeConfig({ self: { pronoun: '祂' } }).self.pronoun, '祂')
  assert.equal(normalizeConfig({ self: { pronoun: '他' } }).self.pronoun, '他')
  assert.equal(normalizeConfig({ self: { pronoun: '它' } }).self.pronoun, '她')
  assert.equal(normalizeConfig({ self: { pronoun: '他', note: 'x' } }).self.note, 'x', '别的键不该被抹掉')
  // 与 owner.pronoun 互不影响：她自己的称谓不该动到称呼主人的那个字。
  const both = normalizeConfig({ owner: { pronoun: '她' }, self: { pronoun: '他' } })
  assert.equal(both.owner.pronoun, '她')
  assert.equal(both.self.pronoun, '他')
})

test('fillSelf 只填 {S}，不按字替换；幂等', () => {
  assert.equal(fillSelf('{S}醒着的时间段', '祂'), '祂醒着的时间段')
  assert.equal(fillSelf('{S}醒着的时间段', '他'), '他醒着的时间段')
  assert.equal(fillSelf('递到{S}手上了，{S}还没看。', '祂'), '递到祂手上了，祂还没看。')
  // 没有占位符的文本一个字都不动——她的原话、日记靠这条保住。
  assert.equal(fillSelf('她说今天不想说话。', '祂'), '她说今天不想说话。')
  assert.equal(fillSelf('', '祂'), '')
  assert.equal(fillSelf(null, '祂'), '')
  // 幂等：填过一遍再填还是同一个结果。
  const once = fillSelf('{S}的日记', '祂')
  assert.equal(fillSelf(once, '祂'), once)
  // 认不出来的值退回默认「她」。
  assert.equal(fillSelf('{S}的日记', '它'), '她的日记')
  assert.equal(fillSelf('{S}的日记'), '她的日记', '没传值就用最近一次读到的值')
})

test('selfPronounFor 按 root 现读配置，改完不用重启', async () => {
  await withRoot(async (root) => {
    assert.equal(selfPronounFor(root), '她', '没有配置文件就是默认值')
    await writeConfig(normalizeConfig({ self: { pronoun: '祂' } }), root)
    assert.equal(selfPronounFor(root), '祂')
    await writeConfig(normalizeConfig({ self: { pronoun: '他' } }), root)
    assert.equal(selfPronounFor(root), '他')
    await writeConfig(normalizeConfig({ self: { pronoun: '它' } }), root)
    assert.equal(selfPronounFor(root), '她', '读了坏值也退回默认，不抛')
  })
})
