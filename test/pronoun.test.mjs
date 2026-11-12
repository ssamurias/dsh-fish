import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  PRONOUN_VALUES, DEFAULT_PRONOUN, OWNER_SLOT, normalizePronoun, pronounOf,
  fillOwner, fillOwnerDeep, pronounFor, resetPronounCache,
} from '../lib/pronoun.js'
import { normalizeConfig, DEFAULTS } from '../lib/settings.js'
import { writeConfig } from '../lib/store.js'
import { writeSelfDoc, selfDocPath } from '../lib/selfdoc.js'

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fish-pron-'))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    resetPronounCache()
  }
}

test('只认 他 / 她 / TA，别的值退回「他」', () => {
  assert.deepEqual([...PRONOUN_VALUES], ['他', '她', 'TA'])
  assert.equal(DEFAULT_PRONOUN, '他')
  assert.equal(normalizePronoun('她'), '她')
  assert.equal(normalizePronoun('他'), '他')
  assert.equal(normalizePronoun('TA'), 'TA')
  assert.equal(normalizePronoun('ta'), 'TA', '大小写不该让人存不进去')
  assert.equal(normalizePronoun(' 她 '), '她')
  assert.equal(normalizePronoun(''), '他')
  assert.equal(normalizePronoun(undefined), '他')
  assert.equal(normalizePronoun('祂'), '他', '不认识的值退回默认，不抛错')
  assert.equal(normalizePronoun(123), '他')
})

test('pronounOf 从配置里取，缺省是「他」', () => {
  assert.equal(pronounOf({ owner: { pronoun: '她' } }), '她')
  assert.equal(pronounOf({ owner: { pronoun: 'TA' } }), 'TA')
  assert.equal(pronounOf({}), '他')
  assert.equal(pronounOf(null), '他')
  assert.equal(pronounOf({ owner: '她' }), '他', 'owner 不是对象就退回默认，不炸')
})

test('fillOwner 只填模板里的占位符，不按字替换', () => {
  assert.equal(OWNER_SLOT, '{T}')
  assert.equal(fillOwner('{T}说{T}今天很累。', '她'), '她说她今天很累。')
  assert.equal(fillOwner('{T}没来。', 'TA'), 'TA没来。')
  // 没有占位符的文本一个字节都不动——她的原话走的就是这条路
  assert.equal(fillOwner('我喜欢吉他，他说改天教我。', '她'), '我喜欢吉他，他说改天教我。', 'issue #127：她的原话不许被改')
  assert.equal(fillOwner('他们都说他今天不在。', '她'), '他们都说他今天不在。', '复数与别人的他都不该动')
  assert.equal(fillOwner('维他命买了吗？', 'TA'), '维他命买了吗？')
  assert.equal(fillOwner('', '她'), '')
  assert.equal(fillOwner(undefined, '她'), '')
})

test('填多少次都一样（幂等）', () => {
  const once = fillOwner('{T}说他明天来。', '她')
  assert.equal(once, '她说他明天来。', '只填占位符，句子里剩下的「他」是别人的，不动')
  assert.equal(fillOwner(once, '她'), once)
  assert.equal(fillOwner(once, 'TA'), once, '已经填过的文本不再变')
})

test('fillOwnerDeep 递归填结构体，别的类型原样返回', () => {
  assert.deepEqual(
    fillOwnerDeep({ text: '{T}说的事', list: ['{T}来了'], n: 1, nested: { a: '{T}' } }, '她'),
    { text: '她说的事', list: ['她来了'], n: 1, nested: { a: '她' } },
  )
  const map = new Map([['k', '{T}']])
  assert.equal(fillOwnerDeep(map, '她'), map, 'Map / Date 这类不该被拆开')
})

test('normalizeConfig 收编 owner.pronoun', () => {
  assert.equal(normalizeConfig({}).owner.pronoun, '他')
  assert.equal(normalizeConfig({ owner: { pronoun: '她' } }).owner.pronoun, '她')
  assert.equal(normalizeConfig({ owner: { pronoun: 'ta' } }).owner.pronoun, 'TA')
  assert.equal(normalizeConfig({ owner: { pronoun: '随便' } }).owner.pronoun, '他')
  // 别的自定义键不能被吃掉（配置可扩展是底线）
  assert.equal(normalizeConfig({ owner: { pronoun: '她', note: 'x' } }).owner.note, 'x')
  assert.equal(DEFAULTS.owner.pronoun, '他')
})

test('pronounFor 按 root 读配置，改完不用重启', async () => {
  await withRoot(async (root) => {
    resetPronounCache()
    // 还没写配置：默认「他」
    assert.equal(pronounFor(root), '他')

    await writeConfig(normalizeConfig({ owner: { pronoun: '她' } }), root)
    // mtime 可能落在同一毫秒里，等一下再读（真实使用里两次保存间隔远大于 1ms）
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(pronounFor(root), '她')

    await writeConfig(normalizeConfig({ owner: { pronoun: 'TA' } }), root)
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(pronounFor(root), 'TA')

    // 换回默认
    await writeConfig(normalizeConfig({}), root)
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(pronounFor(root), '他')
  })
})

test('读坏的配置不抛，退回「他」', async () => {
  await withRoot(async (root) => {
    resetPronounCache()
    const { writeFile } = await import('node:fs/promises')
    const { paths } = await import('../lib/store.js')
    await writeFile(paths(root).config, '{ 这不是 JSON', 'utf8')
    assert.equal(pronounFor(root), '他')
  })
})

test('身份文档按代词写：默认「他」，换成「她」后不再说他', async () => {
  await withRoot(async (root) => {
    // 默认：一个字都不该被改
    await writeConfig(normalizeConfig({}), root)
    const r0 = await writeSelfDoc(root)
    assert.equal(r0.ok, true)
    const plain = await readFile(selfDocPath(root), 'utf8')
    assert.ok(plain.includes('他'), '默认还是「他」，和 0.9.8 一致')

    await writeConfig(normalizeConfig({ owner: { pronoun: '她' } }), root)
    const r1 = await writeSelfDoc(root)
    assert.equal(r1.ok, true)
    const hers = await readFile(selfDocPath(root), 'utf8')
    assert.ok(hers.includes('她'))
    // 词素（其他/他人/他者…）之外，不该再有指主人的「他」
    const rest = hers.replace(/其他|其它|他人|他者|他日|他乡|他处|他方|他杀/g, '')
    assert.ok(!rest.includes('他'), '换上「她」之后还残留了「他」')
    assert.ok(hers.length > 500, '文档不是空的')
  })
})