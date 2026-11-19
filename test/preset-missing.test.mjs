/**
 * preset-missing.test.mjs —— 她这条会话的 agent 不是按 preset 组合出来的（1.0.6，QQ 桥接用户真机）
 *
 * 真机（2026-11-19 17:45，dsh-fish 1.0.5）：QQ 桥用 `ctx.agents.resume()` 恢复她的会话时
 * **没挂 preset**（桥的设置里 `agentPreset` 是空串，那条路径也没有 `setup: mountPreset`）。
 * 宿主建出来的 agent 就没有 `standard` 预设里那几件 ——
 * `read / write / edit / glob / grep / update_goal / read_image`。
 *
 * 而她的白名单（`config.tools.allow`）里写着这 7 个名字。旧实现把提示词直接按白名单念，
 * 于是她读到「现在手边能碰到的是这些：…read_image、edit、glob、grep、read、update_goal、write…」，
 * 照着去调 `glob`，拿回 `unknown tool`。
 *
 * 这个文件钉住两件事：
 *   1. 提示词那一段按**她此刻真看得见的工具**现算，白名单里有、这条会话没有的名字不念；
 *   2. 从 `skipped` 里认出「preset 才会有的那几件」时，日志要说清是 preset 没挂上，
 *      不能说成「这台机器上没有」——那会把责任推给机器，掩盖真原因。
 *
 * 只改「说给她的那句」：守卫放行的仍是白名单全量（她真调得动的照样放行），
 * 收窄名单也只认宿主点得出名的那些。三件事各管一件事，别混。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'

import { attachIdentity, TOOLS_SECTION, resetIdentityCache } from '../lib/identity.js'
import { registerToolRestrict, PRESET_TOOLS, HER_TOOLS } from '../lib/restrict.js'

const tmp = () => fs.mkdtempSync(join(os.tmpdir(), 'fish-preset-'))

/** 够用的假 ctx（只需要 on('agent/created')）。 */
function fakeCtx() {
  const handlers = {}
  return { on: (ev, fn) => { handlers[ev] = fn; return () => {} }, emit: (ev, arg) => handlers[ev]?.(arg) }
}

/** 造一个能收集 system prompt 段的假 agent：家里那条（cwd = herDir），只看得见 given 这几件。 */
function sectionsAgent(cwd, visibleNames) {
  const calls = []
  const visible = new Map((visibleNames ?? []).map((n) => [n, {}]))
  const agent = {
    session: { header: { cwd } },
    ctx: {
      effect: () => {},
      tools: {
        view: () => ({ visible, restrictableNames: new Set(visibleNames ?? []) }),
        restrict: () => () => {},
        guard: () => () => {},
      },
      systemPrompt: { section: (o) => { calls.push(o); return () => {} } },
    },
  }
  return { agent, calls }
}

/** 读 `fish:tools` 段第一行「现在手边能碰到的是这些：…。」里的名字。 */
function surfaceNames(text) {
  const line = String(text ?? '').split('\n')[0] ?? ''
  const m = line.match(/^现在手边能碰到的是这些：(.*)。$/)
  return m ? m[1].split('、').map((s) => s.trim()).filter(Boolean) : []
}

test('preset 那几件这条会话没有时：提示词不念它们（白名单里写着也不念）', () => {
  resetIdentityCache()
  const root = tmp()
  const herDir = join(root, 'home')
  fs.mkdirSync(herDir, { recursive: true })
  fs.writeFileSync(join(herDir, '她的身份.md'), '我是她', 'utf8')

  const ctx = fakeCtx()
  registerToolRestrict(ctx, { herDir, log: () => {}, onResult: () => {}, retryMs: 5, retryMax: 1 })

  // 桥 resume 出来的 agent：宿主只给了鱼自己那几件，preset 的 7 件一件都没有。
  const onlyFish = HER_TOOLS.filter((n) => !PRESET_TOOLS.includes(n))
  const { agent, calls } = sectionsAgent(herDir, onlyFish)
  ctx.emit('agent/created', { agent })

  attachIdentity(agent, root, { herDir })
  const txt = calls.find((c) => c.name === TOOLS_SECTION).text()
  const names = surfaceNames(txt)

  assert.ok(names.length > 0, `这一段该有内容：${JSON.stringify(txt)}`)
  for (const n of ['read', 'write', 'edit', 'glob', 'grep', 'update_goal', 'read_image']) {
    assert.ok(!names.includes(n), `${n} 这条会话拿不到，就不该念给她：${names.join('、')}`)
  }
  assert.ok(names.includes('growth_commit'), `她自己的工具要在里面：${names.join('、')}`)
})

test('preset 那几件都在时：提示词照常念（白名单 ∩ 看得见）', () => {
  resetIdentityCache()
  const root = tmp()
  const herDir = join(root, 'home')
  fs.mkdirSync(herDir, { recursive: true })
  fs.writeFileSync(join(herDir, '她的身份.md'), '我是她', 'utf8')

  const ctx = fakeCtx()
  // 白名单里写着 preset 那几件（真机上就是用户手动加进 config.tools.allow 的）。
  registerToolRestrict(ctx, { herDir, extra: [...PRESET_TOOLS], log: () => {}, onResult: () => {}, retryMs: 5, retryMax: 1 })

  const { agent, calls } = sectionsAgent(herDir, [...HER_TOOLS, ...PRESET_TOOLS])
  ctx.emit('agent/created', { agent })

  attachIdentity(agent, root, { herDir })
  const names = surfaceNames(calls.find((c) => c.name === TOOLS_SECTION).text())
  for (const n of ['read', 'glob', 'read_image', 'growth_commit']) {
    assert.ok(names.includes(n), `${n} 她看得见，就该念：${names.join('、')}`)
  }
})

test('看得见的比白名单多（别的插件塞进来的）时：只念白名单里的那部分', () => {
  resetIdentityCache()
  const root = tmp()
  const herDir = join(root, 'home')
  fs.mkdirSync(herDir, { recursive: true })
  fs.writeFileSync(join(herDir, '她的身份.md'), '我是她', 'utf8')

  const ctx = fakeCtx()
  registerToolRestrict(ctx, { herDir, log: () => {}, onResult: () => {}, retryMs: 5, retryMax: 1 })

  const { agent, calls } = sectionsAgent(herDir, [...HER_TOOLS, 'ops_bash', 'subagent'])
  ctx.emit('agent/created', { agent })

  attachIdentity(agent, root, { herDir })
  const names = surfaceNames(calls.find((c) => c.name === TOOLS_SECTION).text())
  assert.ok(!names.includes('ops_bash'), `白名单外的名字不念：${names.join('、')}`)
  assert.ok(!names.includes('subagent'))
  assert.ok(names.includes('growth_commit'))
})

test('一件都对不上时：退回白名单那份，不擅自说成「一样都没有」', () => {
  resetIdentityCache()
  const root = tmp()
  const herDir = join(root, 'home')
  fs.mkdirSync(herDir, { recursive: true })
  fs.writeFileSync(join(herDir, '她的身份.md'), '我是她', 'utf8')

  const ctx = fakeCtx()
  registerToolRestrict(ctx, { herDir, log: () => {}, onResult: () => {}, retryMs: 5, retryMax: 1 })

  // view 报的全是白名单外的名字：交集为空。这时分不清是「这条会话真没有」
  // 还是「这个 view 不是她的工具表」，宁可照旧念白名单，也不能说「我什么都没有」。
  const { agent, calls } = sectionsAgent(herDir, ['ops_bash', 'team_x'])
  ctx.emit('agent/created', { agent })

  attachIdentity(agent, root, { herDir })
  const names = surfaceNames(calls.find((c) => c.name === TOOLS_SECTION).text())
  assert.ok(names.includes('growth_commit'), `退回白名单那份：${names.join('、')}`)
})

test('skipped 里认出 preset 那几件时：日志说「preset 没挂上」，不说「这台机器上没有」', async () => {
  const ctx = fakeCtx()
  const logs = []
  const herDir = join(os.tmpdir(), 'fish-preset-home')

  registerToolRestrict(ctx, {
    herDir,
    extra: [...PRESET_TOOLS], // 真机上这 7 个名字就在 config.tools.allow 里（用户手动加的）
    log: (m) => logs.push(m),
    onResult: () => {},
    retryMs: 5,
    retryMax: 3,
  })

  // 桥 resume 出来的 agent：白名单里有 preset 那 7 件，view 一件都不报。
  const onlyFish = HER_TOOLS.filter((n) => !PRESET_TOOLS.includes(n))
  const visible = new Map(onlyFish.map((n) => [n, {}]))
  const agent = {
    session: { header: { cwd: herDir } },
    ctx: {
      effect: () => {},
      tools: {
        view: () => ({ visible, restrictableNames: new Set(onlyFish) }),
        restrict: () => () => {},
        guard: () => () => {},
      },
    },
  }
  ctx.emit('agent/created', { agent })
  await new Promise((r) => setTimeout(r, 200))

  const presetLine = logs.find((m) => m.includes('preset'))
  assert.ok(presetLine, `日志要认出这是 preset 没挂上：${JSON.stringify(logs)}`)
  assert.match(presetLine, /resume|预设/, '要指出原因在 resume 没挂 preset')
  const wrong = logs.find((m) => m.includes('这台机器上没有') && m.includes('read'))
  assert.equal(wrong, undefined, `不能把 preset 缺的说成这台机器上没有：${wrong ?? ''}`)
})
