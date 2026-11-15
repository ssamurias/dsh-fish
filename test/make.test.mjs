/**
 * make.test.mjs —— her_make / her_work 两个工具的锁定测试（2026-11-16，1.0.4）
 *
 * 守六件事：
 *   1. 注册出来的是宿主认的形状：her_make 五个动作、her_work 读版本；
 *   2. 回执只说事实（「留下了《…》」「改了第 2 版」），不夸、不打分；
 *   3. 只留在家里：没有发出去的口子，执行完只动 works.json / works/；
 *   4. 改版要先读得回来（her_work），不然第二版接不上第一版；
 *   5. 收尾 / 放下；放下必须说为什么；
 *   6. 家里被另一个实例占着时（guardWrite 不 ok），两个工具都不写。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { registerMake } from '../lib/make.js'
import { readWorks, listWorks } from '../lib/works.js'

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-fish-make-'))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function withTools(root, deps = {}) {
  const defs = []
  const ctx = { tools: { register: (d) => (defs.push(d), d) } }
  registerMake(ctx, { root, ...deps })
  const byName = new Map(defs.map((d) => [d.name, d]))
  return { defs, byName, get: (n) => byName.get(n) }
}

const NOW = new Date(2026, 10, 16, 10, 0, 0).getTime()

test('注册两个工具，形状是宿主认的，说明里不带男字旁的「他」', async () => {
  await withRoot(async (root) => {
    const { defs, get } = withTools(root)
    assert.deepEqual(defs.map((d) => d.name).sort(), ['her_make', 'her_work'])
    for (const d of defs) {
      assert.equal(d.parameters?.type, 'object')
      assert.equal(typeof d.execute, 'function')
      assert.equal(typeof d.output?.render, 'function')
      assert.ok(!String(d.description).includes('他'), `${d.name} 的说明里出现了男字旁的他`)
      assert.ok(String(d.description).includes('{T}') || d.name === 'her_work', '给主人的地方要留 {T}')
    }
    const make = get('her_make')
    assert.deepEqual(make.parameters.properties.action.enum, ['save', 'revise', 'finish', 'drop', 'list'])
    assert.equal(make.parameters.properties.new_name.type, 'boolean')
    const work = get('her_work')
    assert.ok(work.parameters.properties.version)
  })
})

test('留一件：只动 works.json 与 works/，回执是方括号事实', async () => {
  await withRoot(async (root) => {
    const { get } = withTools(root)
    const tool = get('her_make')
    const out = await tool.execute({ title: '一段曲子', text: '前八小节只有一个音在重复。' })
    assert.equal(out.ok, true)
    const marked = tool.output.render({ action: 'save' }, out)
    assert.equal(marked.length, 1)
    assert.match(marked[0].text, /^\[留下了《一段曲子》\]$/, '回执不夸也不打分')
    assert.ok(!/[好棒优秀满分]/.test(marked[0].text))

    const rows = await readdir(root)
    assert.deepEqual(rows.sort(), ['works', 'works.json'], '她留下的东西不写事件流')
    assert.equal((await readWorks(root)).items.length, 1)
  })
})

test('改一版：先读回来，再接着写；回执是「改了第 2 版」', async () => {
  await withRoot(async (root) => {
    const { get } = withTools(root)
    const make = get('her_make')
    const read = get('her_work')
    const first = await make.execute({ title: '那条广告', text: '一稿：先说响。', refs: ['ev_a'] })
    assert.equal(first.ok, true)

    const back = await read.execute({ title: '那条广告' })
    assert.equal(back.ok, true)
    assert.equal(back.version, 1)
    assert.match(back.text, /一稿：先说响。/)
    assert.equal(read.output.render({}, back)[0].text.includes('一稿'), true, '读回来的正文要原样交给她')

    const second = await make.execute({ action: 'revise', title: '那条广告', text: '二稿：先说静。' })
    assert.equal(second.ok, true)
    assert.equal(second.version, 2)
    assert.match(make.output.render({ action: 'revise' }, second)[0].text, /^\[《那条广告》改了第 2 版\]$/)

    const v1 = await read.execute({ title: '那条广告', version: 1 })
    assert.match(v1.text, /一稿/)
    assert.equal((await readWorks(root)).items[0].versions.length, 2)
  })
})

test('看看留过哪些：只列名字、第几版、完没完', async () => {
  await withRoot(async (root) => {
    const { get } = withTools(root)
    const make = get('her_make')
    assert.equal(make.output.render({ action: 'list' }, await make.execute({ action: 'list' }))[0].text, '（还什么都没留下）')
    await make.execute({ title: '甲', text: '甲。' })
    await make.execute({ title: '甲', text: '甲二稿。' })
    const out = await make.execute({ action: 'list' })
    assert.equal(out.ok, true)
    assert.match(out.text, /《甲》第 2 版 · 还在弄/)
    assert.ok(!out.text.includes('甲二稿。'), '列表不列正文')
    assert.equal((await listWorks(root)).length, 1)
  })
})

test('收尾：弄完了就说收了尾', async () => {
  await withRoot(async (root) => {
    const { get } = withTools(root)
    const make = get('her_make')
    await make.execute({ title: '弄完的', text: '写完了。' })
    const done = await make.execute({ action: 'finish', title: '弄完的' })
    assert.equal(done.ok, true)
    assert.equal(make.output.render({ action: 'finish' }, done)[0].text, '[收了尾]')
  })
})

test('放下：没有 why 不放，说了 why 才收', async () => {
  await withRoot(async (root) => {
    const { get } = withTools(root)
    const make = get('her_make')
    await make.execute({ title: '不弄的', text: '算了。' })
    const noWhy = await make.execute({ action: 'drop', title: '不弄的' })
    assert.equal(noWhy.ok, false)
    assert.match(make.output.render({ action: 'drop' }, noWhy)[0].text, /^\[没留下：.*为什么/)

    const dropped = await make.execute({ action: 'drop', title: '不弄的', reason: '怎么改都假' })
    assert.equal(dropped.ok, true)
    assert.equal(make.output.render({ action: 'drop' }, dropped)[0].text, '[放下了]')
  })
})

test('留一件过不了写入口（家里被占着）：两个工具都不写，也不抛', async () => {
  await withRoot(async (root) => {
    const tenant = { root, tenant: { ok: false, why: '这个家被另一个实例占着' } }
    const { get } = withTools(root, { tenant })
    const out = await get('her_make').execute({ title: '留不下来', text: '正文。' })
    assert.equal(out.ok, false)
    assert.match(out.note, /占着/)
    const read = await get('her_work').execute({ title: '留不下来' })
    assert.equal(read.ok, false)
    const rows = (await readdir(root)).filter((r) => r !== 'logs')
    assert.deepEqual(rows, [], '被挡下来就一行都不写（logs 里那笔拒绝记录不算）')
  })
})

test('写入口挡：没名字、空正文、翻不到旧东西、翻不到版本', async () => {
  await withRoot(async (root) => {
    const { get } = withTools(root)
    const make = get('her_make')
    const read = get('her_work')
    assert.equal((await make.execute({ text: '没有名字。' })).ok, false)
    assert.equal((await make.execute({ title: '空的', text: '   ' })).ok, false)
    assert.equal((await make.execute({ action: 'revise', title: '没写过', text: '二稿。' })).ok, false)
    assert.equal((await make.execute({ action: 'finish', title: '没写过' })).ok, false)
    assert.equal((await read.execute({ title: '没写过' })).ok, false)
    await make.execute({ title: '有这件', text: '一稿。' })
    const v9 = await read.execute({ title: '有这件', version: 9 })
    assert.equal(v9.ok, false)
    assert.match(read.output.render({}, v9)[0].text, /^\[没翻到：/)
  })
})

test('一天只起一件新的：第二件挡回去，第一件不受影响', async () => {
  await withRoot(async (root) => {
    const { get } = withTools(root)
    const make = get('her_make')
    const exec = { agent: { session: { id: 'session-abc' } } }
    await make.execute({ title: '一件', text: '一稿。' }, exec)
    const second = await make.execute({ title: '另一件', text: '一稿。' }, exec)
    assert.equal(second.ok, false)
    assert.match(second.note, /今天已经起过一件了/)
    const rows = await readWorks(root)
    assert.equal(rows.items.length, 1)
    assert.equal(rows.items[0].title, '一件')
    assert.equal(rows.items[0].versions.length, 1)
    assert.ok(NOW > 0)
  })
})
