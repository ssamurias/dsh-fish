/**
 * 素材契约（1.0）的测试
 *
 * 钉住三件事：
 *   ① 第三方只能声明「类别」，不能自己封证据（分级由插件定）；
 *   ② 不合规就回退成普通文本/null，不抛错、不吞一半；
 *   ③ 原文一个字都不改。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CONTRACT_VERSION,
  LIMITS,
  coerceMaterial,
  fromPlainText,
  materialFromToolText,
  renderMaterialText,
} from '../lib/contract.js'
import {
  BUILTIN_SOURCES,
  allSources,
  findSource,
  normalizeSources,
  sourceMaterial,
} from '../lib/sources.js'

function good(over = {}) {
  return {
    dshFishMaterial: CONTRACT_VERSION,
    source: 'zhihu',
    key: 'https://example.com/a/1',
    at: '2026-11-12',
    title: '为什么大家都不愿意写注释',
    kind: 'opinion',
    facts: [{ label: '回答数', value: '42' }],
    quotes: [{ text: '因为注释是写给未来的自己看的。', kind: 'answer', by: '答主：某人' }],
    ...over,
  }
}

test('契约：合法的形状能过，事实与原话分开', () => {
  const r = coerceMaterial(good())
  assert.equal(r.ok, true)
  assert.equal(r.material.source, 'zhihu')
  assert.equal(r.material.key, 'https://example.com/a/1')
  assert.equal(r.material.facts.length, 1)
  assert.equal(r.material.facts[0].grade, 1)
  assert.equal(r.material.quotes.length, 1)
  assert.equal(r.material.quotes[0].grade, 2)
  assert.equal(r.material.canVerify, true)
})

test('契约：缺 source / key 就拒，并带上原因', () => {
  const r = coerceMaterial(good({ source: '', key: '' }))
  assert.equal(r.ok, false)
  assert.deepEqual(r.problems.sort(), ['missing-key', 'missing-source'])
})

test('契约：既没有事实也没有原话，算空素材', () => {
  const r = coerceMaterial(good({ facts: [], quotes: [] }))
  assert.equal(r.ok, false)
  assert.ok(r.problems.includes('empty'))
})

test('契约：观点不能自称证据（1 级被压回 2 级）', () => {
  const r = coerceMaterial(
    good({ quotes: [{ text: '我认为不该有注释。', kind: 'answer', grade: 1 }] }),
  )
  assert.equal(r.ok, true)
  assert.equal(r.material.quotes[0].grade, 2)
  assert.ok(r.problems.includes('grade-clamped'))
})

test('契约：声明事实但没有任何锚，降回观点；带 url 才留 1 级', () => {
  const noAnchor = coerceMaterial(
    good({
      kind: 'fact',
      facts: [],
      quotes: [{ text: '这个项目有 3000 颗星。', kind: 'claim' }],
    }),
  )
  assert.equal(noAnchor.material.quotes[0].grade, 2)
  assert.ok(noAnchor.problems.includes('fact-without-anchor'))

  const anchored = coerceMaterial(
    good({
      kind: 'fact',
      facts: [],
      quotes: [{ text: '这个项目有 3000 颗星。', kind: 'claim', url: 'https://example.com/repo' }],
    }),
  )
  assert.equal(anchored.material.quotes[0].grade, 1)
})

test('契约：虚构一律 3 级，声明 1 级也没用', () => {
  const r = coerceMaterial(
    good({ kind: 'fiction', facts: [], quotes: [{ text: '那年冬天，海面结冰了。', grade: 1 }] }),
  )
  assert.equal(r.material.quotes[0].grade, 3)
})

test('契约：条数与长度有硬上限，超了就截断并记一笔', () => {
  const many = Array.from({ length: 45 }, (_, i) => ({ text: `第 ${i} 句原话` }))
  const r = coerceMaterial(good({ quotes: many }))
  assert.equal(r.ok, true)
  assert.equal(r.material.quotes.length, LIMITS.quotes)
  assert.ok(r.problems.includes('too-many-quotes'))

  const long = coerceMaterial(good({ quotes: [{ text: '字'.repeat(900) }] }))
  assert.equal(long.material.quotes[0].text.length, LIMITS.text)
})

test('契约：重复原话去重，原文一个字都不改', () => {
  const text = '  他说：「别 急着 下结论。」  '
  const r = coerceMaterial(
    good({ quotes: [{ text }, { text }, { text: '另一句。' }] }),
  )
  assert.equal(r.material.quotes.length, 2)
  assert.equal(r.material.quotes[0].text, '他说：「别 急着 下结论。」')
})

test('契约：工具返回值只有整段是 JSON 才认，散文不猜', () => {
  assert.equal(materialFromToolText(JSON.stringify(good()))?.source, 'zhihu')
  assert.equal(materialFromToolText('今天看了个视频，挺有意思的。'), null)
  assert.equal(materialFromToolText('[1,2,3]'), null)
  assert.equal(materialFromToolText('{ 坏掉的 json'), null)
})

test('契约：普通文本包成观点素材，进得了系统但不算证据', () => {
  const m = fromPlainText({ source: 'zhihu', kind: 'opinion', text: '这段话没有契约，但值得留下。' })
  assert.equal(m.source, 'zhihu')
  assert.equal(m.canVerify, false)
  assert.equal(m.body, '这段话没有契约，但值得留下。')
  assert.ok(m.quotes.every((q) => q.grade >= 2))
})

test('契约：来源结果转素材——对象不合规就返回 null，不硬造', () => {
  const m = sourceMaterial(good(), { name: 'zhihu', kind: 'opinion' })
  assert.equal(m.source, 'zhihu')
  assert.equal(sourceMaterial({}, { name: 'zhihu' }), null)
  const plain = sourceMaterial('一段普通文本。', { name: 'zhihu' })
  assert.equal(plain.canVerify, false)
})

test('来源登记：坏条目跳过、重名先到先得、类别默认观点', () => {
  const list = normalizeSources([
    { name: 'zhihu', kind: 'opinion', tool: 'zhihu_search' },
    { name: 'ZHIHU', kind: 'fact' },
    { name: '', kind: 'opinion' },
    { name: 'novel', kind: 'fiction' },
    { name: 'weird', kind: 'nonsense' },
  ])
  assert.deepEqual(
    list.map((s) => [s.name, s.kind]),
    [
      ['zhihu', 'opinion'],
      ['novel', 'fiction'],
      ['weird', 'opinion'],
    ],
  )
  assert.equal(findSource(list, 'zhihu')?.tool, 'zhihu_search')
  assert.equal(findSource(list, 'nope'), null)
})

test('来源登记：内置 B 站不能被设置覆盖分级', () => {
  const list = allSources({ tools: { sources: [{ name: 'bili', kind: 'fiction' }] } })
  assert.equal(list.filter((s) => s.name === 'bili').length, 1)
  assert.equal(findSource(list, 'bili').kind, 'fact')
  assert.ok(BUILTIN_SOURCES.some((s) => s.name === 'bili'))
})

test('契约：渲染只标「谁写的」，不出现等级与可信度', () => {
  const text = renderMaterialText(coerceMaterial(good()).material)
  assert.ok(text.includes('来源：zhihu'))
  assert.ok(text.includes('答主：某人：「因为注释是写给未来的自己看的。」'))
  assert.ok(!/级|可信度|分数|打分/.test(text))
})
