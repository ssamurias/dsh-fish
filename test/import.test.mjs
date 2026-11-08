/**
 * import.test.mjs —— 接一只别人养过的大肥鱼（2026-10-27，用户 m03170 / m03201）
 *
 * 这一层守的是「什么叫接过来、什么叫没接过来」：
 *   1. 交接单读得出来：人设正文、称呼、工具三样分开；读不出就整篇当正文。
 *   2. 她已经有起点（seed）时**拒绝**，不替用户决定要不要覆盖一个已经在长的她。
 *   3. 天数必然是第 1 天——这是设计，不是巧合（growthDay 只认 seed 的 ts）。
 *   4. 带过来的称呼必须能生效，并且**顶掉**我们第一天的起名事件。
 *   5. 工具是并集：不能把她自己那 6 个工具挤掉。
 *   6. 「这一位是接来的」这个豁免**只认事件流**（用户 m03769）：原生鱼不管恢复
 *      多少次别人的 config，都不该拿到那两条禁令的豁免。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseHandover, applyHandover, IMPORT_TEMPLATE } from '../lib/import.js'
import { readEvents } from '../lib/store.js'
import { loadConfig, updateConfig } from '../lib/settings.js'
import { deriveSelf, IMPORT_MARK_PREFIX } from '../lib/derive.js'
import { CATALOG } from '../lib/events.js'
import { resetAll } from '../lib/reset.js'

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fish-import-'))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

const DOC = `# 交接单

## 你是谁
你是一条住在屏幕里的鱼。你话少，喜欢看窗外。

## 称呼
你管他叫「开灯的」。

## 工具
skill, web_search
`

test('交接单三个小节都读得出来', () => {
  const p = parseHandover(DOC)
  assert.equal(p.ok, true)
  assert.equal(p.name, '开灯的')
  assert.deepEqual(p.tools, ['skill', 'web_search'])
  assert.ok(p.body.includes('你是一条住在屏幕里的鱼'))
  // 结构化小节的标题不能混进人设正文
  assert.ok(!p.body.includes('## 称呼'))
  assert.ok(!p.body.includes('## 工具'))
})

test('没有结构化小节时整篇都当人设正文', () => {
  const p = parseHandover('你是一条鱼。你很懒。')
  assert.equal(p.ok, true)
  assert.equal(p.body, '你是一条鱼。你很懒。')
  assert.equal(p.name, '')
  assert.deepEqual(p.tools, [])
})

test('交接单的外壳标题不会混进她的身份文档', () => {
  // 「# 交接单」「## 你是谁」是这份文档的结构，不是她的一部分：
  // 混进去会让身份文档里出现「## 你是谁 / # 交接单 / ## 你是谁」这种三层标题。
  const p = parseHandover(DOC)
  assert.ok(!p.body.includes('# 交接单'))
  assert.ok(!p.body.includes('## 你是谁'))
  assert.ok(p.body.startsWith('你是一条住在屏幕里的鱼'))
})

test('别人写的交接单用「你自己」当小节名，照样认得出来', () => {
  // 2026-10-27（用户 m05009）：模板原先一处写「你自己」、一处写「你是谁」，
  // 两处对不上——照模板填完贴回来，那行标题会被当成人设正文收进去。
  // 现在模板统一用「你是谁」，解析器也把「你自己」一起认了，
  // 因为别人手里的交接单不一定按我们的模板写。
  const doc = `# 交接单
### 你自己
你是一条住在屏幕里的鱼。
### 称呼
梦尘
`
  const p = parseHandover(doc)
  assert.equal(p.ok, true)
  assert.equal(p.name, '梦尘')
  assert.equal(p.body, '你是一条住在屏幕里的鱼。')
  assert.ok(!p.body.includes('你自己'), '小节标题不该变成她人设里的一行')
})

test('空的和超长的都不收', () => {
  assert.equal(parseHandover('   ').ok, false)
  assert.equal(parseHandover('啊'.repeat(6001)).ok, false)
})

test('下载用的交接单模板：整份贴回来时，说明书一个字都不进她的人设', () => {
  // 模板上半是写给对面 AI 看的说明书，下半才是三节空表。
  // 有人会整份贴回来（省得挑），说明书绝不能变成她的性格。
  const p = parseHandover(IMPORT_TEMPLATE)
  assert.equal(p.ok, false, '还没填的空模板不该被当成一份人设收下')
  assert.ok(!p.body.includes('写给'), '说明书的字不能漏进人设正文')
  assert.ok(!p.body.includes('不要写什么'))
  assert.ok(!p.body.includes('好感度'))
})

test('模板填好之后：称呼、工具、人设三样都读得对', () => {
  const filled = IMPORT_TEMPLATE
    .replace('（在这里写她的性格：第二人称「你」，写她已经稳定成型的样子。）',
      '你是一条住在屏幕里的鱼。你说话很慢，句子短，从不用感叹号。')
    .replace('（她管那个人叫什么。只写称呼本身。）', '梦尘')
    .replace('（她原本能用、而默认工具面里没有的工具名，逗号分隔。没有就留空。）', 'skill, web_search')
  const p = parseHandover(filled)
  assert.equal(p.ok, true)
  assert.equal(p.name, '梦尘')
  assert.deepEqual(p.tools, ['skill', 'web_search'])
  assert.ok(p.body.startsWith('你是一条住在屏幕里的鱼'))
  // 说明书那一段依然不许漏进来
  assert.ok(!p.body.includes('给写这份交接单的 AI'))
  assert.ok(!p.body.includes('不要写什么'))
})

test('模板里写明了字数区间，对面 AI 才可能照着写', () => {
  // 2026-10-27（用户 m04868）：人设超长的后果是静默的——超 2000 字直接被拒，
  // 1200 字以上会把成长段挤成 0。这两条必须写在交给对面 AI 的那份文件里，
  // 否则写的人根本不知道有这回事。
  assert.ok(IMPORT_TEMPLATE.includes('1200'), '模板要写明建议的下限')
  assert.ok(IMPORT_TEMPLATE.includes('1500'), '模板要写明建议的上限')
  assert.ok(IMPORT_TEMPLATE.includes('2000'), '模板要写明拒收的那条线')
})

test('空模板里的占位括号不会被当成名字或工具名', () => {
  // 实测踩过：不挡住整行括号的话，name 会变成「（她管那个人叫什么。只写称呼本身。）」，
  // tools 会变成三个句子片段。
  const p = parseHandover(IMPORT_TEMPLATE)
  assert.equal(p.name, '')
  assert.deepEqual(p.tools, [])
})

test('接过来之后：她是第 1 天、称呼生效、人设成了她的起点', async () => {
  await withRoot(async (root) => {
    const r = await applyHandover(DOC, root)
    assert.equal(r.ok, true)
    assert.equal(r.name, '开灯的')

    const { events } = await readEvents(root)
    const model = deriveSelf(events)
    assert.equal(model.day, 1)
    assert.equal(model.name, '开灯的')
    assert.ok(model.seed.includes('你是一条住在屏幕里的鱼'))
  })
})

test('已经有起点的一局不收——不替用户决定要不要覆盖', async () => {
  await withRoot(async (root) => {
    const first = await applyHandover(DOC, root)
    assert.equal(first.ok, true)
    const second = await applyHandover('另一个人设', root)
    assert.equal(second.ok, false)
    assert.equal(second.alreadyHad, true)
    assert.match(second.why, /已经有自己的起点/)
    // 拒绝之后事件流不能多出一条
    const { events } = await readEvents(root)
    assert.equal(events.filter((e) => e.type === 'seed').length, 1)
  })
})

test('带过来的称呼顶掉第一天的起名事件', async () => {
  await withRoot(async (root) => {
    await applyHandover(DOC, root)
    const { events } = await readEvents(root)
    const model = deriveSelf(events)
    const offer = CATALOG.find((e) => e.id === 'name_offer')
    // 条件本身是 !m.name，带过来称呼之后它自己就不该再触发了
    assert.equal(offer.cond(model), false)
  })
})

test('工具是并集：不会把她自己那几个挤掉', async () => {
  await withRoot(async (root) => {
    await updateConfig({ tools: { allow: ['her_recall'] } }, root)
    const r = await applyHandover(DOC, root)
    assert.equal(r.ok, true)
    const { config } = await loadConfig(root)
    assert.ok(config.tools.allow.includes('her_recall'))
    assert.ok(config.tools.allow.includes('skill'))
    assert.ok(config.tools.allow.includes('web_search'))
  })
})

test('接过来的人不受我方那两条提示词禁令约束——凭据写在事件流里', async () => {
  await withRoot(async (root) => {
    await applyHandover(DOC, root, { source: '朋友的那一只' })
    const { events } = await readEvents(root)
    const mark = events.find((e) => e.type === 'meta' && String(e.text ?? '').startsWith(IMPORT_MARK_PREFIX))
    assert.ok(mark, '必须留下一条 import-mark 事件')
    assert.equal(mark.text, `${IMPORT_MARK_PREFIX}朋友的那一只`)

    const model = deriveSelf(events)
    assert.equal(model.persona.imported, true)
    assert.equal(model.persona.source, '朋友的那一只')
  })
})

test('原生那一局：事件流里没有标记，就没有豁免', async () => {
  await withRoot(async (root) => {
    // 一条原生鱼：只有 seed，从没走过导入
    const { appendEvent } = await import('../lib/store.js')
    await appendEvent({ type: 'seed', text: '你不是助手。你刚开始存在。' }, { day: 1, stage: 1, source: 'system' }, root)
    const { events } = await readEvents(root)
    assert.equal(deriveSelf(events).persona.imported, false)
  })
})

test('配置里写着豁免也没用：备份/恢复搬回来的 config 不算导入', async () => {
  await withRoot(async (root) => {
    // 模拟「恢复了一份别人状态库里的 config.json」——旧实现就是靠这个字段给豁免的。
    await updateConfig({ persona: { imported: true, bansMuted: true, source: '恢复来的' } }, root)
    const { appendEvent } = await import('../lib/store.js')
    await appendEvent({ type: 'seed', text: '你不是助手。你刚开始存在。' }, { day: 1, stage: 1, source: 'system' }, root)

    const { events } = await readEvents(root)
    const model = deriveSelf(events)
    // 事件流里那条 seed 是从我们自己的起点来的，没有 import-mark → 不给豁免
    assert.equal(model.persona.imported, false)

    // 身份文档里那两节仍然在（这一步是这条用例真正守的东西）
    const { renderSelfDoc } = await import('../lib/selfdoc.js')
    const doc = renderSelfDoc({ ...model, beliefs: [], scars: [] }, {
      budget: 4000,
      browse: false,
      speak: false,
      grants: [],
      shown: 3,
      diary: false,
      sleepEveryDays: 0,
      bansMuted: model.persona.imported === true,
    })
    assert.ok(doc.includes('不能做的'), '原生鱼必须仍然带着那两条禁令')
  })
})

test('导入的那一位：身份文档里没有「不能做的」「你还不会的」', async () => {
  await withRoot(async (root) => {
    await applyHandover(DOC, root)
    const { events } = await readEvents(root)
    const model = deriveSelf(events)
    const { renderSelfDoc } = await import('../lib/selfdoc.js')
    const doc = renderSelfDoc({ ...model, beliefs: [], scars: [] }, {
      budget: 4000,
      browse: false,
      speak: false,
      grants: [],
      shown: 3,
      diary: false,
      sleepEveryDays: 0,
      bansMuted: model.persona.imported === true,
    })
    assert.ok(!doc.includes('不能做的'), '导入的那一位不该看见我方的不能做的')
    assert.ok(!doc.includes('你还不会的'), '也不该看见我方那条「你还不会」')
  })
})

test('重置之后新的一局没有豁免（事件流被搬走，config 抄回来也不算）', async () => {
  await withRoot(async (root) => {
    await applyHandover(DOC, root, { source: '朋友的那一只' })
    await updateConfig({ growthDays: 45 }, root) // 「这台机器怎么待她」的配置，重置要留着

    const r = await resetAll(root)
    assert.equal(r.ok, true)

    // 「怎么待她」留下了
    const { config } = await loadConfig(root)
    assert.equal(config.growthDays, 45)

    // 「她是谁」没留下：新状态库里没有事件，所以也没有豁免
    const { events } = await readEvents(root)
    assert.equal(events.length, 0)
    assert.equal(deriveSelf(events).persona.imported, false)
  })
})

test('重开一局、只有启动补的默认 seed 时，允许导入（issue #65）', async () => {
  await withRoot(async (root) => {
    // 模拟 index.js 启动播种：一条没有 source:'import' 的默认起点
    const { appendEvent } = await import('../lib/store.js')
    await appendEvent({ type: 'seed', text: '你不是助手。你刚开始存在。' }, { day: 1, stage: 1, source: 'system' }, root)
    const r = await applyHandover(DOC, root)
    assert.equal(r.ok, true, r.why)
    const { events } = await readEvents(root)
    const seeds = events.filter((e) => e.type === 'seed')
    assert.equal(seeds.length, 2, '旧的默认起点留着（事件流只追加）')
    assert.equal(seeds.at(-1).source, 'import')
    assert.equal(deriveSelf(events).seed, parseHandover(DOC).body, '读的时候要用真正导入的那一条')
  })
})
