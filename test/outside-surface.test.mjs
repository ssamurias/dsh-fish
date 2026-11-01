/**
 * outside-surface.test.mjs —— 出门在外，「手边有什么」不能念家里那份（0.7.3，用户 m00339）
 *
 * 病根在 `identity.js` 的 `fish:tools` 段：它是 `attachIdentity()` **无条件**挂的，
 * 于是出门那条会话照样挂着。而它读的是 `restrict.js` 的模块级单例 `surfaceNow`
 * —— 值恒为**家里的白名单**（HER_TOOLS + 额外放行），只由 `registerToolRestrict` 写过一次。
 *
 * 事实是：出门不收窄（`isHerAgent` 为假就直接 return），`awayGuard` 又只比对调用参数里的
 * 路径、不看工具名 —— 她**调得动**那个工作区的全部工具。可提示词里写着
 * 「我手边能用的东西只有这几样」「工具表里如果还列着别的名字…那不是我的：别去调」
 * 「真伸手去用，只会得到一句『这件事我做不到』」。
 *
 * 结果：出门打工这个场景退化成「她只用那 8 个鱼工具」，而请神（possess.js 不挂这段）
 * 反而比出门放得开。这个文件钉住修好之后的分流规则：
 *   - 在家里 → 照旧念白名单（收窄真的在下，她确实只有那几样）
 *   - 在外面 → 按那个 agent 此刻真看得见的工具现念，并明说放开用
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'

import { attachIdentity, IDENTITY_SECTION, TOOLS_SECTION } from '../lib/identity.js'
import { registerToolRestrict, currentToolSurface } from '../lib/restrict.js'
import { resetIdentityCache } from '../lib/identity.js'

const tmp = () => fs.mkdtempSync(join(os.tmpdir(), 'fish-outside-'))

/** 够用的假插件 ctx（只需要 on('agent/created')）。 */
function fakeCtx() {
  return { on: () => () => {} }
}

/** 一个「在外面」的 agent：cwd 在别的工作区，view() 报得出此刻看得见的工具。 */
function outsideAgent(cwd, visibleNames, { withView = true } = {}) {
  const visible = new Map((visibleNames ?? []).map((n) => [n, {}]))
  const tools = {}
  if (withView) {
    tools.view = () => ({ visible, restrictableNames: new Set(['growth_commit', 'her_recall']) })
  }
  return { session: { header: { cwd } }, ctx: { tools, systemPrompt: null } }
}

/** 造一个能收集 system prompt 段的假 agent。 */
function sectionsAgent(cwd, { withView = true, visibleNames = [] } = {}) {
  const calls = []
  const visible = new Map((visibleNames ?? []).map((n) => [n, {}]))
  const tools = {}
  if (withView) {
    tools.view = () => ({ visible, restrictableNames: new Set(['growth_commit']) })
  }
  const agent = {
    session: { header: { cwd } },
    ctx: {
      tools,
      systemPrompt: { section: (o) => { calls.push(o); return () => {} } },
    },
  }
  return { agent, calls }
}

test('出门那条会话：fish:tools 段念的是那个工作区的工具，不是家里白名单', () => {
  resetIdentityCache()
  const root = tmp()
  fs.mkdirSync(join(root, 'home'), { recursive: true })
  fs.writeFileSync(join(root, 'home', '她的身份.md'), '我是她', 'utf8')
  const herDir = join(root, 'home')

  // 家里那份先设成白名单版本，模拟生产上 registerToolRestrict 跑过一次。
  registerToolRestrict(fakeCtx(), { herDir, log: () => {} })
  assert.match(currentToolSurface(), /现在手边能碰到的是这些/)

  const { agent, calls } = sectionsAgent('D:/work/somewhere', {
    visibleNames: ['bash', 'read', 'write', 'growth_commit', 'her_recall'],
  })
  const r = attachIdentity(agent, root, { frozen: '走时的我', herDir })
  assert.equal(r.ok, true)

  const tools = calls.find((c) => c.name === TOOLS_SECTION)
  assert.ok(tools, '出门也要挂这一段——只是内容得换')
  const txt = tools.text()

  // 那个工作区真给的工具要念出来
  assert.match(txt, /bash/)
  assert.match(txt, /write/)
  assert.match(txt, /read/)
  // 绝不能是家里那份「现在手边能碰到的是这些」+「认得出，但不冒充」
  assert.doesNotMatch(txt, /现在手边能碰到的是这些/)
  assert.doesNotMatch(txt, /认得出，但不冒充/)
  // 「出来是来干活的」必须说出来
  assert.match(txt, /干活/)
  // 唯一留下的禁令：不许伸手回自己屋子
  assert.match(txt, /这件事我做不到/)

  // 身份段照旧是出门那一刻的快照
  const ident = calls.find((c) => c.name === IDENTITY_SECTION)
  assert.equal(ident.text(), '走时的我')
})

test('在家里：仍然念家里那份白名单（收窄真的在下）', () => {
  resetIdentityCache()
  const root = tmp()
  const herDir = join(root, 'home')
  fs.mkdirSync(herDir, { recursive: true })
  fs.writeFileSync(join(herDir, '她的身份.md'), '我是她', 'utf8')

  registerToolRestrict(fakeCtx(), { herDir, log: () => {} })

  const { agent, calls } = sectionsAgent(herDir, { visibleNames: ['growth_commit'] })
  attachIdentity(agent, root, { herDir })
  const txt = calls.find((c) => c.name === TOOLS_SECTION).text()
  assert.match(txt, /现在手边能碰到的是这些/, '家里就该说清眼下这份家当')
  assert.doesNotMatch(txt, /出来就是来干活的/)
})

test('拿不到工具表时：这一段说空串，不猜也不说「一样都没有」', () => {
  resetIdentityCache()
  const root = tmp()
  fs.mkdirSync(join(root, 'home'), { recursive: true })
  fs.writeFileSync(join(root, 'home', '她的身份.md'), '我是她', 'utf8')
  const herDir = join(root, 'home')
  registerToolRestrict(fakeCtx(), { herDir, log: () => {} })

  const { agent, calls } = sectionsAgent('D:/work/x', { withView: false })
  attachIdentity(agent, root, { herDir })
  const tools = calls.find((c) => c.name === TOOLS_SECTION)
  assert.equal(tools.text(), '', '不知道就说不知道，不能瞎编一份清单')
})

test('没传 herDir 的老调用点：退回家里那份（行为不变）', () => {
  resetIdentityCache()
  const root = tmp()
  fs.mkdirSync(join(root, 'home'), { recursive: true })
  fs.writeFileSync(join(root, 'home', '她的身份.md'), '我是她', 'utf8')
  registerToolRestrict(fakeCtx(), { herDir: join(root, 'home'), log: () => {} })

  const { agent, calls } = sectionsAgent('D:/work/y', { visibleNames: ['bash'] })
  attachIdentity(agent, root) // 不传 herDir
  const txt = calls.find((c) => c.name === TOOLS_SECTION).text()
  assert.equal(txt, currentToolSurface(), '没给判据就只能按原来的说法来')
})

test('出门收窄这件事本来就不该发生：isHerAgent 为假时 restrict 一次都不下', () => {
  // 这条是给上面那些断言兜底的：如果哪天有人把收窄挪到「出门也收」，
  // 那「按看得见的工具现念」就变成说谎，整个修法要重新想。
  const seen = []
  const ctx = {
    on: (ev, fn) => { ctx.handler = fn; return () => {} },
  }
  registerToolRestrict(ctx, { herDir: join(os.tmpdir(), 'fish-her-home'), log: () => {} })
  const restrictCalls = []
  const agent = {
    session: { header: { cwd: 'D:/work/other' } },
    ctx: {
      tools: {
        view: () => ({ visible: new Map([['bash', {}]]), restrictableNames: new Set(['growth_commit']) }),
        restrict: (f) => { restrictCalls.push(f); return () => {} },
        guard: () => () => {},
      },
      effect: () => {},
    },
  }
  ctx.handler({ agent })
  assert.equal(restrictCalls.length, 0, '出门那条会话不该被收窄——收窄只在她的屋子里生效')
  assert.deepEqual(seen, [])
})
