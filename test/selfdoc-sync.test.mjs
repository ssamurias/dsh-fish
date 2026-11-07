/**
 * selfdoc-sync.test.mjs —— 身份文档跟着设置走（issue #64）。
 *
 * 守三件事：
 *   1. 设置页存完（POST /config），身份文档当场重写，不用等她下一次开口或重启；
 *      内容没变的那次保存不重写文件。
 *   2. 「允许她记梦」关着，身份文档不念 her_dream——和 writeDream 用同一个判据。
 *   3. 定时说明书只念白名单里真放行的 schedule_*：只放 schedule_create 就只说它，
 *      不能说「你还有四个工具」，另外三个她一伸手就是「这件事我做不到」。
 *      收窄在这个进程里真关着时守卫不挂，四个都在手边，照旧念四个。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { writeConfig } from '../lib/store.js'
import { normalizeConfig } from '../lib/settings.js'
import { selfDocPath, writeSelfDoc } from '../lib/selfdoc.js'
import { registerObserve } from '../lib/observe.js'
import { DREAM_BRIEF, DIARY_BRIEF, SLEEP_BRIEF, SPEAK_BRIEF, SPEAK_OFF_BRIEF, SCHEDULE_BRIEF, scheduleBrief } from '../lib/persona.js'
import { LOOK_BRIEF, LOOK_OFF_BRIEF } from '../lib/browse.js'
import { SCHEDULE_TOOLS, registerToolRestrict, currentToolSurface, toolSurfaceText } from '../lib/restrict.js'

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fish-selfdoc-sync-'))
  const prevHomes = process.env.DSH_FISH_HOMES
  process.env.DSH_FISH_HOMES = join(root, 'homes.json')
  try {
    return await fn(root)
  } finally {
    if (prevHomes === undefined) delete process.env.DSH_FISH_HOMES
    else process.env.DSH_FISH_HOMES = prevHomes
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

/** 和 test/p5.test.mjs 同形的极简假 ctx：只给 observe 要的两个服务。 */
function fakeCtx() {
  const routes = []
  const cfg = { connection: { requestRejection: () => null } }
  const webServer = { register: (def) => { routes.push(def); return () => {} } }
  return {
    routes,
    get: (k) => (k === 'connection' ? cfg.connection : k === 'webServer' ? webServer : undefined),
    webServer,
    tools: { register: () => {} },
    slots: { inject: () => {}, register: () => {} },
    effect: (fn) => fn(),
    on: () => {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    log: () => {},
  }
}

async function postConfig(ctx, patch) {
  const route = ctx.routes.find((r) => String(r.path || '').endsWith('/config'))
  assert.ok(route, '必须有 /config 路由')
  const body = JSON.stringify(patch)
  const req = {
    method: 'POST',
    url: '/dsh-fish/config',
    headers: { 'content-type': 'application/json' },
    on: (ev, fn) => { if (ev === 'data') fn(Buffer.from(body, 'utf8')); if (ev === 'end') fn() },
  }
  let status = 0
  let payload = null
  const res = { writeHead: (s) => { status = s }, end: (s) => { payload = JSON.parse(s || '{}') }, setHeader: () => {} }
  await route.handler(req, res)
  return { status, payload }
}

const doc = (root) => readFile(selfDocPath(root), 'utf8')

test('设置页存完，身份文档当场跟上；没变的那次保存不重写文件', () => withRoot(async (root) => {
  await writeConfig(normalizeConfig({
    diary: { enabled: true },
    memory: { sleepEveryDays: 0 },
    browse: { enabled: true },
    comment: { enabled: false },
    dream: { enabled: true },
  }), root)
  await writeSelfDoc(root)
  const before = await doc(root)
  assert.ok(before.includes(DIARY_BRIEF), '起点：日记开着，日记那段在')
  assert.ok(!before.includes(SLEEP_BRIEF), '起点：不主动想，那段不在')
  assert.ok(before.includes(LOOK_BRIEF), '起点：上网开着')
  assert.ok(before.includes(SPEAK_OFF_BRIEF), '起点：说话关着')
  assert.ok(before.includes(DREAM_BRIEF), '起点：梦开着')

  const ctx = fakeCtx()
  registerObserve(ctx, { root })
  const patch = {
    diary: { enabled: false },
    memory: { sleepEveryDays: 3 },
    browse: { enabled: false },
    comment: { enabled: true },
    dream: { enabled: false },
  }
  const r = await postConfig(ctx, patch)
  assert.equal(r.status, 200, `保存不该被挡回来：${JSON.stringify(r.payload)}`)

  // 不再手动调 writeSelfDoc：存完那一下就该已经重写了。
  const after = await doc(root)
  assert.ok(!after.includes(DIARY_BRIEF), '日记关了，「每天我会记一笔」那段要当场撤掉')
  assert.ok(after.includes(SLEEP_BRIEF), '开了「想一想」，那段要当场挂上')
  assert.ok(!after.includes(LOOK_BRIEF) && after.includes(LOOK_OFF_BRIEF), '上网关了，门上换成「这会儿」')
  assert.ok(after.includes(SPEAK_BRIEF) && !after.includes(SPEAK_OFF_BRIEF), '说话开了，要当场告诉她能说')
  assert.ok(!after.includes(DREAM_BRIEF), '梦关了，不能再念 her_dream')

  // 同样的设置再存一遍：内容没变，writeSelfDoc 不落盘，文件不该被碰。
  const mtime = (await stat(selfDocPath(root))).mtimeMs
  await new Promise((r) => setTimeout(r, 30))
  const again = await postConfig(ctx, patch)
  assert.equal(again.status, 200)
  assert.equal((await stat(selfDocPath(root))).mtimeMs, mtime, '内容没变的保存不该重写身份文档')
  assert.equal(await doc(root), after)
}))

test('「允许她记梦」关着时，身份文档不念 her_dream（和 writeDream 同一个判据）', () => withRoot(async (root) => {
  await writeConfig(normalizeConfig({ dream: { enabled: false } }), root)
  await writeSelfDoc(root)
  const off = await doc(root)
  assert.ok(!off.includes(DREAM_BRIEF), '关着还念说明书，她伸手只会拿到「梦这一项关着」')
  assert.ok(!off.includes('her_dream'), '别的地方也不该再点这个名')

  await writeConfig(normalizeConfig({ dream: { enabled: true } }), root)
  await writeSelfDoc(root)
  assert.ok((await doc(root)).includes(DREAM_BRIEF), '开着就要念')

  await writeConfig(normalizeConfig({}), root)
  await writeSelfDoc(root)
  assert.ok((await doc(root)).includes(DREAM_BRIEF), '默认是开着的（没写这一项不算关）')
}))

test('定时说明书只念白名单里真放行的 schedule_*', () => withRoot(async (root) => {
  const scheduleNames = (text) => SCHEDULE_TOOLS.filter((n) => text.includes(n))
  const sectionOf = (text) => {
    const at = text.indexOf('可以自己给自己定定时提醒')
    if (at < 0) return ''
    const start = text.lastIndexOf('\n', at) + 1
    return text.slice(start, text.indexOf('\n', at))
  }

  // 设置页说最少只填 schedule_create：只放它，就只说它。
  await writeConfig(normalizeConfig({ tools: { allow: ['schedule_create'] } }), root)
  await writeSelfDoc(root)
  const one = await doc(root)
  assert.equal(sectionOf(one), '你还有一个工具 schedule_create：可以自己给自己定定时提醒。')
  assert.ok(!one.includes('你还有四个工具'), '只放了一个，不能说四个')
  assert.deepEqual(scheduleNames(one), ['schedule_create'], '另外三个没放行，全文都不该出现')

  // 放了两个：按放行的念，顺序跟 SCHEDULE_TOOLS 走。
  await writeConfig(normalizeConfig({ tools: { allow: ['schedule_delete', 'schedule_create'] } }), root)
  await writeSelfDoc(root)
  const two = await doc(root)
  assert.equal(sectionOf(two), '你还有两个工具 schedule_create / schedule_delete：可以自己给自己定定时提醒。')

  // 四个都放：原文一字不变。
  await writeConfig(normalizeConfig({ tools: { allow: [...SCHEDULE_TOOLS] } }), root)
  await writeSelfDoc(root)
  assert.ok((await doc(root)).includes(SCHEDULE_BRIEF))

  // 没放 schedule_create：说明书讲的是「定提醒」，整段不挂（和设置页 scheduleOn 同一个判据）。
  await writeConfig(normalizeConfig({ tools: { allow: ['schedule_list'] } }), root)
  await writeSelfDoc(root)
  assert.equal(sectionOf(await doc(root)), '')
}))

test('收窄关着时守卫不挂，宿主的四个她都拿得到：定时说明书照旧念四个', () => withRoot(async (root) => {
  const line = async () => {
    const text = await doc(root)
    const at = text.indexOf('可以自己给自己定定时提醒')
    return at < 0 ? '' : text.slice(text.lastIndexOf('\n', at) + 1, text.indexOf('\n', at))
  }
  // 和 test/restrict.test.mjs 同形的假 ctx：registerToolRestrict 只要 on。
  const restrictCtx = () => ({ on: () => () => {} })
  try {
    // 这个进程里收窄真关着（启动时就关了）：只放 schedule_create 也念四个。
    registerToolRestrict(restrictCtx(), { herDir: 'C:\\\\h', enabled: false, log: () => {} })
    await writeConfig(normalizeConfig({ tools: { restrict: false, allow: ['schedule_create'] } }), root)
    await writeSelfDoc(root)
    assert.equal(await line(), SCHEDULE_BRIEF.split('\n')[0], '守卫不挂，另外三个也在手边，少说就是把真有的东西藏起来')
    assert.ok((await doc(root)).includes(SCHEDULE_BRIEF))

    // 收窄还开着、只是设置里刚关掉（要重启才生效）：守卫还挡着另外三个，照白名单只念放行的。
    registerToolRestrict(restrictCtx(), { herDir: 'C:\\\\h', enabled: true, dream: true, log: () => {} })
    await writeSelfDoc(root)
    assert.equal(await line(), '你还有一个工具 schedule_create：可以自己给自己定定时提醒。', '看的是这个进程里真生效的那一份，不是 config')
  } finally {
    // 复位成模块默认那份（HER_TOOLS 全量），别把「关着」漏给同进程里后面的用例
    registerToolRestrict(restrictCtx(), { herDir: 'C:\\\\h', enabled: true, dream: true, log: () => {} })
  }
  assert.equal(currentToolSurface(), toolSurfaceText(), '复位后和模块默认那份一样')
}))

test('scheduleBrief：四个都在时就是原来那段，空名单是空串', () => {
  assert.equal(scheduleBrief([...SCHEDULE_TOOLS]), SCHEDULE_BRIEF)
  assert.ok(SCHEDULE_BRIEF.startsWith('你还有四个工具 schedule_create / schedule_list / schedule_update / schedule_delete：'))
  assert.equal(scheduleBrief([]), '')
  assert.equal(scheduleBrief(), '')
  // 除了第一行，其余几行一字不变
  assert.equal(
    scheduleBrief(['schedule_create']).split('\n').slice(1).join('\n'),
    SCHEDULE_BRIEF.split('\n').slice(1).join('\n'),
  )
})
