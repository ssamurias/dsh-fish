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

// ---- 0.9.5 余项（接 #65）----

/** 把 observe.js 的路由收下来，直接调 handler。req 用 Readable 造，res 只记状态码和正文。 */
async function routeCall(root, path, method, body) {
  const { registerObserve } = await import('../lib/observe.js')
  const { Readable } = await import('node:stream')
  const routes = []
  const ctx = {
    get: (k) => (k === 'connection'
      ? { requestRejection: () => null }
      : k === 'webServer'
        ? { register: (def) => { routes.push(def); return () => {} } }
        : undefined),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }
  const handle = registerObserve(ctx, { root })
  try {
    const route = routes.find((r) => r.path === `/dsh-fish${path}`)
    assert.ok(route, `必须有 ${path} 路由`)
    const req = Readable.from(body == null ? [] : [Buffer.from(JSON.stringify(body))])
    Object.assign(req, { method, url: `/dsh-fish${path}`, headers: { 'content-type': 'application/json' } })
    let status = 0
    let text = ''
    const res = {
      writableEnded: false,
      writeHead: (s) => { status = s },
      setHeader: () => {},
      end: (s) => { text = String(s ?? ''); res.writableEnded = true },
    }
    await route.handler(req, res)
    return { status, body: text ? JSON.parse(text) : null }
  } finally {
    handle.dispose()
  }
}

test('重开一局后重启（启动补了默认 seed 和一条 meta）：GET /import 说能导，POST 也真能导', async () => {
  // 0.9.5：POST 已经放行「只有默认起点」的一局，GET 还是「有 seed 就不行」。
  // 设置页只看 GET 的 canImport，于是重开 → 重启之后界面不给粘贴的地方，直接 POST 却能成。
  const box = await mkdtemp(join(tmpdir(), 'fish-import-route-'))
  const root = join(box, 'dsh-fish')
  try {
    const { appendEvent } = await import('../lib/store.js')
    // 一局养过的：起点 + 说过的话
    await appendEvent({ type: 'seed', text: '你不是助手。你刚开始存在。' }, { day: 1, stage: 1, source: 'system' }, root)
    await appendEvent({ type: 'utterance', text: '今天下雨。' }, { day: 3, stage: 1, source: 'self' }, root)
    const before = await routeCall(root, '/import', 'GET')
    assert.equal(before.status, 200)
    assert.equal(before.body.canImport, false, '养过的一局不能导')
    assert.equal((await routeCall(root, '/import', 'POST', { text: DOC })).status, 409, '两边说的要一样')

    // 重开一局，再照启动的样子补一条默认起点和一条系统记录
    assert.equal((await resetAll(root)).ok, true)
    await appendEvent({ type: 'seed', text: '你不是助手。你刚开始存在。' }, { day: 1, stage: 1, source: 'system' }, root)
    await appendEvent({ type: 'meta', text: 'home:ready' }, { day: 1, stage: 1, source: 'system' }, root)

    const get = await routeCall(root, '/import', 'GET')
    assert.equal(get.status, 200)
    assert.equal(get.body.canImport, true, `界面要给粘贴的地方，实际 reason=${get.body.reason}`)
    assert.equal(get.body.reason, '')

    const post = await routeCall(root, '/import', 'POST', { text: DOC })
    assert.equal(post.status, 200, JSON.stringify(post.body))
    assert.equal(post.body.day, 1)

    // 导进来之后就有了自己的起点：两边一起说不能再导
    const after = await routeCall(root, '/import', 'GET')
    assert.equal(after.body.canImport, false)
    const again = await routeCall(root, '/import', 'POST', { text: DOC })
    assert.equal(again.status, 409)
  } finally {
    await rm(box, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('导入回执分开报「这次新放行几个」和「名单现在共几个」', async () => {
  // 原来放行 3 个，交接单写 2 个、其中 1 个重复：这次只新加 1 个，名单共 4 个。
  // 0.9.5 只报合并后的总数，界面写成「工具白名单 4 个」，像是带进来 4 个。
  await withRoot(async (root) => {
    await updateConfig({ tools: { allow: ['her_recall', 'web_search', 'read_file'] } }, root)
    const post = await routeCall(root, '/import', 'POST', { text: DOC })
    assert.equal(post.status, 200, JSON.stringify(post.body))
    assert.deepEqual(post.body.toolsAdded, ['skill'], '交接单里的 web_search 本来就在，不算这次带进来的')
    assert.equal(post.body.tools.length, 4)
    const { config } = await loadConfig(root)
    assert.equal(config.tools.allow.length, 4)
  })
})

test('白名单写不进去（配置读不出来）：走 /import 路由，导入照样成功，回执带上原因，不说这次新加了几个', async () => {
  // 第二轮审查：原来这条只直接调 applyHandover。走真路由时，导入之后还要再读一次配置
  // （算「现在是第几天」），那一句没兜底，直接 500：人设已经写进去了，界面却说「导入失败」。
  await withRoot(async (root) => {
    // config.json 是个文件夹：读写都失败
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(root, 'config.json'), { recursive: true })
    const post = await routeCall(root, '/import', 'POST', { text: DOC })
    assert.equal(post.status, 200, JSON.stringify(post.body))
    assert.equal(post.body.ok, true)
    assert.equal(typeof post.body.toolsError, 'string')
    assert.ok(post.body.toolsError.length > 0, '要说为什么没写进去')
    // 只回错误码：错误信息里可能带本机路径，设置页上不出现路径
    assert.match(post.body.toolsError, /^(?:[A-Z][A-Z0-9_]*|写配置失败)$/)
    const { basename } = await import('node:path')
    assert.ok(!JSON.stringify(post.body).includes(basename(root)), '回执里不带本机路径')
    assert.deepEqual(post.body.toolsAdded, [])
    assert.equal(post.body.day, 1)
    const { events } = await readEvents(root)
    assert.ok(events.some((e) => e.type === 'seed'), '人设照样写进去了')
  })
})

test('白名单写不进去（配置只读）：走 /import 路由，回执说没写进去，配置原样', { skip: process.platform !== 'win32' && '只读属性挡不住 rename 覆盖，只在 Windows 上能这样造' }, async () => {
  const { chmodSync } = await import('node:fs')
  await withRoot(async (root) => {
    await updateConfig({ tools: { allow: ['her_recall'] } }, root)
    const file = join(root, 'config.json')
    const before = await readFile(file, 'utf8')
    chmodSync(file, 0o444)
    try {
      const post = await routeCall(root, '/import', 'POST', { text: DOC })
      assert.equal(post.status, 200, JSON.stringify(post.body))
      assert.equal(post.body.toolsError, 'EPERM')
      assert.deepEqual(post.body.toolsAdded, [])
      assert.equal(await readFile(file, 'utf8'), before, '配置一个字都没改')
      const { events } = await readEvents(root)
      assert.ok(events.some((e) => e.type === 'seed'), '人设照样写进去了')
    } finally {
      chmodSync(file, 0o644)
    }
  })
})
