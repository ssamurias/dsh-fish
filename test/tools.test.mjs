/**
 * tools.test.mjs —— 工具注册的形状守门
 *
 * 为什么单独一个文件（2026-10-25）：
 *   用全新 profile 从 tarball 装一遍才发现，npm 装进来的插件真实路径在
 *   `<profile>/node_modules/dsh-fish/`，往上能找到宿主的 `@deepseek-ai/dsh-tools`，
 *   于是 `defineTool` 真的被调用——它期待「简写 DSL 属性表」，我们传的是完整
 *   JSON Schema，编译时把根上的 `type:'object'` 当成一个叫 type 的参数，报
 *     unsupported JSON schema: parameters.type must be a value schema object
 *   → 6 个工具全部注册失败。本机是 link: 装的，往上找不到那个包，走兜底，所以
 *   这条 bug 只会在别人装了之后出现。
 *
 * 这里守三件事：
 *   1. lib/ 里不许再 import 宿主的 dsh-tools；
 *   2. `defineTool(spec)` 就是恒等（注册时直接交 JSON Schema）；
 *   3. 八个工具定义都长成宿主认的形状（parameters 是 object-rooted JSON Schema、
 *      output.schema 也是、render / execute 是函数）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

import { defineTool } from '../lib/tool.js'
import { registerCapture } from '../lib/capture.js'
import { registerLetter } from '../lib/letter.js'
import { registerLook } from '../lib/look.js'
import { registerRecall } from '../lib/recall.js'
import { registerHerDiary } from '../lib/herdiary.js'
import { registerSpeak } from '../lib/speak.js'
import { registerWatch } from '../lib/watch.js'
import { registerNote } from '../lib/note.js'
import { FISH_TOOLS, HER_TOOLS } from '../lib/restrict.js'
import { runChecks } from '../lib/selfcheck.js'

const LIB = fileURLToPath(new URL('../lib/', import.meta.url))
const ROOT = join(tmpdir(), 'dsh-fish-tools-test')

function fakeCtx() {
  const defs = []
  return {
    defs,
    tools: {
      register(d) {
        defs.push(d)
        return () => {}
      },
    },
  }
}

test('lib/ 里不再 import 宿主的 dsh-tools', () => {
  const hits = []
  for (const f of readdirSync(LIB)) {
    if (!f.endsWith('.js')) continue
    const s = readFileSync(join(LIB, f), 'utf8')
    // 注释里可以提这个名字（tool.js 就在解释为什么不用它），但代码里不许出现
    const code = s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    if (/@deepseek-ai\/dsh-tools/.test(code)) hits.push(f)
  }
  assert.deepEqual(hits, [], '这些文件又把宿主的 dsh-tools import 回来了')
})

test('defineTool 是恒等：不编译、不改写', () => {
  const spec = { name: 'x', parameters: { type: 'object', properties: {} } }
  assert.equal(defineTool(spec), spec)
})

test('八个工具定义都长成宿主认的形状', () => {
  const ctx = fakeCtx()
  const deps = { root: ROOT, log: () => {} }
  registerCapture(ctx, deps)
  registerLetter(ctx, deps)
  registerLook(ctx, deps)
  registerRecall(ctx, deps)
  registerHerDiary(ctx, deps)
  registerSpeak(ctx, deps)
  registerWatch(ctx, deps)
  registerNote(ctx, deps)

  assert.equal(ctx.defs.length, 8, '我们自己的工具是 8 个（第 9 个 read_image 是宿主的）')
  const names = ctx.defs.map((d) => d.name)
  for (const n of names) assert.ok(FISH_TOOLS.includes(n), `${n} 不在 FISH_TOOLS 里`)

  for (const d of ctx.defs) {
    assert.equal(typeof d.name, 'string')
    assert.ok(d.description.length > 10, `${d.name} 的说明太短`)
    // parameters：根级 object JSON Schema（不是简写 DSL）
    assert.equal(d.parameters?.type, 'object', `${d.name}.parameters 根级必须是 object`)
    assert.equal(typeof d.parameters.properties, 'object', `${d.name}.parameters.properties 缺失`)
    assert.ok(!('required' in d.parameters) || Array.isArray(d.parameters.required))
    // output：宿主 registry 会校验它
    assert.equal(d.output?.schema?.type, 'object', `${d.name}.output.schema 根级必须是 object`)
    assert.equal(typeof d.output.render, 'function', `${d.name}.output.render 必须是函数`)
    assert.equal(typeof d.execute, 'function', `${d.name}.execute 必须是函数`)
  }
})

test('自检按 registry 里真的在不在判断，而不是配置名单', async () => {
  const cfg = { growthDays: 30, window: { start: '20:00', end: '23:00' }, tools: {} }
  const allThere = { get: (n) => (HER_TOOLS.includes(n) ? { name: n } : undefined) }
  const R = { allow: [...HER_TOOLS], applied: 1, failed: '' }
  const ok = await runChecks({ root: ROOT, config: cfg, host: {}, tools: allThere, restrict: R, net: false })
  const okItem = ok.items.find((i) => i.id === 'tools')
  assert.equal(okItem.ok, true, okItem.detail)

  // 2026-10-28 深夜改写（用户 m05885 的真机反证）：
  // 原先这里断言「全局工具表里没有 read_image ⇒ 必须报红」。那个判据是**必然误报**——
  // 宿主把 read_image 注册在 agent 平面（由 attachments 服务挂着），全局表里根本查不到。
  // 用户同一条会话里 read_image 明明取到了 1096x622 的 PNG、她还照着画面把内容讲了，
  // 自检却说她「看不了图」。所以现在的判据是「有正面证据才算有，没证据就说判不准」。
  //
  // ① 真机那种情况：全局表查不到，但收窄真的挂上了、名单里有它 ⇒ 绿（宿主认过这个名字）。
  const noImage = { get: (n) => (n === 'read_image' ? undefined : { name: n }) }
  const img = await runChecks({ root: ROOT, config: cfg, host: {}, tools: noImage, restrict: R, net: false })
  const imgTools = img.items.find((i) => i.id === 'tools')
  assert.equal(imgTools.ok, true, imgTools.detail)
  const imgItem = img.items.find((i) => i.id === 'read-image')
  assert.ok(HER_TOOLS.includes('read_image'), '收窄名单里得有 read_image，这条用例才成立')
  assert.equal(imgItem.ok, true, `全局表查不到、但收窄认过，不能报红：${imgItem.detail}`)
  assert.match(imgItem.detail, /read_image/)
  // 整体可能因为别的项（cookie / 宿主接口 / 这台机器没装 ffmpeg）红，但「看画面」这一项不能再红。
  // 2026-10-28 修（GitHub 的 Windows runner 红）：早先这里断言 summary 不含 /看画面/，
  // 会把另一项的标题「看画面用的 ffmpeg」也连坐禁掉——那条红说的是 ffmpeg 缺失，跟 read_image 无关。
  const redIds = img.items.filter((i) => !i.ok).map((i) => i.id)
  assert.ok(!redIds.includes('read-image'), `「看画面」不能进要注意清单：${img.summary}`)

  // ② 全局表里直接看到 ⇒ 绿。
  const allTools = { get: (n) => ({ name: n }) }
  const withImg = await runChecks({ root: ROOT, config: cfg, host: {}, tools: allTools, restrict: R, net: false })
  const okImg = withImg.items.find((i) => i.id === 'read-image')
  assert.equal(okImg.ok, true, okImg.detail)

  // ③ 宿主明说了没挂附件服务 ⇒ 一定没有 read_image，报红并给修法。
  const noAttach = await runChecks({
    root: ROOT, config: cfg, host: {}, tools: noImage, restrict: { allow: [], applied: 0, failed: '' },
    attachments: false, net: false,
  })
  const noAttachItem = noAttach.items.find((i) => i.id === 'read-image')
  assert.equal(noAttachItem.ok, false, '没挂附件服务必须报出来')
  assert.match(noAttachItem.detail, /read_image/)
  assert.match(noAttachItem.fix, /附件|图片/)

  // ④ 什么旁证都没有 ⇒ 说「判不准」，不冤枉她看不了图。
  const unclear = await runChecks({
    root: ROOT, config: cfg, host: {}, tools: noImage, restrict: { allow: [], applied: 0, failed: '' }, net: false,
  })
  const unclearItem = unclear.items.find((i) => i.id === 'read-image')
  assert.equal(unclearItem.ok, true, unclearItem.detail)
  assert.match(unclearItem.detail, /查不准|判不准/)

  // ⑤ 没有 tools（预检/假环境）时不冒充结论：这一项干脆不出现。
  const noTools = await runChecks({ root: ROOT, config: cfg, host: {}, restrict: R, net: false })
  assert.equal(noTools.items.find((i) => i.id === 'read-image'), undefined)

  const missingOne = { get: (n) => (n === 'growth_commit' ? undefined : { name: n }) }
  const bad = await runChecks({ root: ROOT, config: cfg, host: {}, tools: missingOne, net: false })
  const badItem = bad.items.find((i) => i.id === 'tools')
  assert.equal(badItem.ok, false)
  assert.match(badItem.detail, /growth_commit/)
  assert.match(badItem.fix, /日志/)
})

// issue #61：宿主没有 read_image 时收窄不再整条延后，而是把它剔掉照常下。
// 「挂上了且 allow 里有」从此不能再当成宿主认过 read_image——它可能正是被剔掉的那个。
test('收窄挂上了但 read_image 是这次剔掉的：自检不能说宿主认了它', async () => {
  const cfg = { growthDays: 30, window: { start: '20:00', end: '23:00' }, tools: {} }
  const noImage = { get: (n) => (n === 'read_image' ? undefined : { name: n }) }
  const R = { allow: [...HER_TOOLS], applied: 1, failed: '', absent: ['read_image'] }

  // 宿主明说没挂附件服务：照样报红，不被「收窄挂上了」盖过去
  const noAttach = await runChecks({ root: ROOT, config: cfg, host: {}, tools: noImage, restrict: R, attachments: false, net: false })
  const noAttachItem = noAttach.items.find((i) => i.id === 'read-image')
  assert.equal(noAttachItem.ok, false, noAttachItem.detail)
  assert.match(noAttachItem.detail, /read_image/)
  // 「手上的工具」那一项也不能把剔掉的算进「看得见几个」
  const toolsItem = noAttach.items.find((i) => i.id === 'tools')
  assert.match(toolsItem.detail, new RegExp(`只看得见 ${HER_TOOLS.length - 1} 个工具`), toolsItem.detail)
  assert.match(toolsItem.detail, /read_image 这次宿主没有/)

  // 没有别的旁证：说判不准，不说「宿主认了」
  const unclear = await runChecks({ root: ROOT, config: cfg, host: {}, tools: noImage, restrict: R, net: false })
  const unclearItem = unclear.items.find((i) => i.id === 'read-image')
  assert.equal(unclearItem.ok, true, unclearItem.detail)
  assert.doesNotMatch(unclearItem.detail, /宿主认了/)
  assert.match(unclearItem.detail, /查不准|判不准/)
})

// 2026-10-30（0.8.1 发版前自查）：公开版装完自检必然报红的一条误报。
//
// `her_dream` 是「梦」那个本机实验功能的工具，只有 `.dev` 存在时 `lib/index.js`
// 才注册它。可 `FISH_TOOLS` 是白名单来源、一直含这 9 个名字，自检早先拿它当
// 「应该装上」的清单直接跟 registry 比 → 公开版没有 `.dev`、也就没注册 her_dream，
// 于是人人装完都看到一句红字「有 1 个工具没注册上：her_dream。她现在说不出话、
// 也记不下东西。」，把人吓得以为装坏了。
//
// 2026-10-28 的 read_image 也是同一类错误（拿名单当「真装上」）；这次是拿了
// 「本机清单」当「公开版清单」。判据必须与注册处同一份：`devModeSync`。
test('0.9.0 起 her_dream 也恒注册：缺了就要报红', async () => {
  const cfg = { growthDays: 30, window: { start: '20:00', end: '23:00' }, tools: {} }
  // 公开版真机：注册表里没有 her_dream，别的都在。
  const pub = { get: (n) => (n === 'her_dream' ? undefined : { name: n }) }

  // ① 没有 .dev 也照样查 her_dream：0.9.0 起它不再是开发副本专属。
  const pubRoot = join(tmpdir(), `dsh-fish-sc-pub-${process.pid}`)
  const pubRes = await runChecks({ root: pubRoot, config: cfg, host: {}, tools: pub, net: false })
  const pubItem = pubRes.items.find((i) => i.id === 'tools')
  assert.equal(pubItem.ok, false, `缺了 her_dream 必须报红：${pubItem.detail}`)
  assert.match(pubItem.detail, /her_dream/)

  // ② 开发副本（有 .dev）：这次 her_dream 真应该在，缺了就得报出来——
  //    别为了让公开版变绿，把开发副本的漏注册也一起瞒过去。
  const devRoot = join(tmpdir(), `dsh-fish-sc-dev-${process.pid}`)
  mkdirSync(devRoot, { recursive: true })
  writeFileSync(join(devRoot, '.dev'), 'dev')
  const devRes = await runChecks({ root: devRoot, config: cfg, host: {}, tools: pub, net: false })
  const devItem = devRes.items.find((i) => i.id === 'tools')
  assert.equal(devItem.ok, false, '开发副本里 her_dream 缺了必须报')
  assert.match(devItem.detail, /her_dream/)

  // ③ 公开版里别的工具真缺了，照样报红（不是把整项都放过）。
  const missing = { get: (n) => (n === 'her_dream' || n === 'bili_watch' ? undefined : { name: n }) }
  const missRes = await runChecks({ root: pubRoot, config: cfg, host: {}, tools: missing, net: false })
  const missItem = missRes.items.find((i) => i.id === 'tools')
  assert.equal(missItem.ok, false)
  assert.match(missItem.detail, /bili_watch/)
})
