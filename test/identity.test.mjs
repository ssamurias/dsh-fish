/**
 * identity.test.mjs —— 身份走 system prompt，不走对话（2026-10-25 改）
 *
 * 背景（用户 m04984）：他在面板里看见她每轮都带着「规则约束 / 人格设定」，要求
 * 除开发环境外，用户绝对看不到提示词。
 *
 * 根因（内核 0.2.1-rc.3 已核实）：`home/AGENTS.md` 走的是宿主的「工作区指令」，
 * 注入的是**普通 user 消息**、带 `<system-reminder>` 外壳、留在对话历史里。
 * 现在改成 `agent.ctx.systemPrompt.section(...)`：system 角色消息、不进历史。
 *
 * 这个文件守三件事：
 *   1. 落盘副本换了名字（不叫 AGENTS.md，否则又会被注入）；
 *   2. 旧的 AGENTS.md 会被删掉（迁移），不然它继续注入，等于没改；
 *   3. 身份段只在**她那个 agent** 上注册，且拿不到 systemPrompt 时降级不崩。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import {
  HOST_PERSONA_SECTION,
  IDENTITY_ORDER,
  IDENTITY_SECTION,
  TOOLS_ORDER,
  TOOLS_SECTION,
  WAKE_ORDER,
  WAKE_SECTION,
  attachAssembleFix,
  attachIdentity,
  clearWakeSection,
  identityText,
  mountedCount,
  registerIdentity,
  reorderForHer,
  resetIdentityCache,
  setWakeSection,
} from '../lib/identity.js'
import { legacySelfDocPath, selfDocPath } from '../lib/selfdoc.js'
import { DEFAULTS } from '../lib/settings.js'
import { BELIEF_SHOWN, SELF_DOC_BUDGET } from '../lib/persona.js'

const INDEX = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
const CLIENT = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const SAY = fs.readFileSync(new URL('../lib/say.js', import.meta.url), 'utf8')

const tmp = () => fs.mkdtempSync(join(os.tmpdir(), 'fish-identity-'))

test('落盘副本叫「她的身份.md」，不再叫 AGENTS.md', () => {
  const root = tmp()
  assert.ok(selfDocPath(root).endsWith('她的身份.md'))
  assert.ok(!selfDocPath(root).endsWith('AGENTS.md'), 'AGENTS.md 会被宿主当指令注入，不能用这个名')
  assert.ok(legacySelfDocPath(root).endsWith('AGENTS.md'))
})

test('identityText：文件不存在返回空串，不抛', () => {
  resetIdentityCache()
  const root = tmp()
  assert.equal(identityText(root), '')
})

test('identityText：读到文件内容，改文件后（mtime 变）能拿到新内容', async () => {
  resetIdentityCache()
  const root = tmp()
  const file = selfDocPath(root)
  fs.mkdirSync(join(root, 'home'), { recursive: true })
  fs.writeFileSync(file, '第一版身份', 'utf8')
  assert.equal(identityText(root), '第一版身份')

  // 改内容并把 mtime 推开（同毫秒写入在部分文件系统上 mtime 不变）
  fs.writeFileSync(file, '第二版身份', 'utf8')
  const later = new Date(Date.now() + 5000)
  fs.utimesSync(file, later, later)
  assert.equal(identityText(root), '第二版身份')
})

test('attachIdentity：挂三段——身份 + 这一次的处境（平时空）+ 手边有什么', () => {
  resetIdentityCache()
  clearWakeSection()
  const root = tmp()
  fs.mkdirSync(join(root, 'home'), { recursive: true })
  fs.writeFileSync(selfDocPath(root), '我是她', 'utf8')

  const calls = []
  const agent = { ctx: { systemPrompt: { section: (o) => calls.push(o) } } }
  const r = attachIdentity(agent, root)
  assert.equal(r.ok, true)
  assert.equal(calls.length, 3, '身份一段 + 处境一段 + 手边一段')
  const sec = calls[0]
  assert.equal(sec.name, IDENTITY_SECTION)
  assert.equal(sec.order, IDENTITY_ORDER)
  assert.equal(typeof sec.text, 'function', 'text 必须是函数：每轮组装时现读，文件变了立即生效')
  assert.equal(sec.text(), '我是她')

  // 第二段：这一次的处境。平时空串（等于不存在），唤醒前才填。
  const wake = calls[1]
  assert.equal(wake.name, WAKE_SECTION)
  assert.equal(wake.order, WAKE_ORDER)
  assert.equal(typeof wake.text, 'function')
  assert.equal(wake.text(), '', '没唤醒时这段必须是空，否则他聊天时她还带着上一次的处境')
  setWakeSection('第 1 天，你醒了。')
  assert.equal(wake.text(), '第 1 天，你醒了。')
  clearWakeSection()
  assert.equal(wake.text(), '')

  // 第三段：手边有什么（2026-10-29，用户 m01276）。收不窄的工具靠这段说清。
  const tools = calls[2]
  assert.equal(tools.name, TOOLS_SECTION)
  assert.equal(tools.order, TOOLS_ORDER)
  assert.equal(typeof tools.text, 'function', '白名单变了下一轮就要生效')
  const txt = tools.text()
  assert.match(txt, /growth_commit/, '要把真放行的工具念出来')
  assert.match(txt, /ops_/, '要点名那些挡不掉、会混进工具表的')
  assert.match(txt, /这件事我做不到/, '和兜底守卫同一句话术')
})

test('attachIdentity：没有 systemPrompt 时返回 ok:false，不抛', () => {
  const r = attachIdentity({ ctx: {} }, tmp())
  assert.equal(r.ok, false)
  assert.match(r.why, /systemPrompt/)
  const r2 = attachIdentity(undefined, tmp())
  assert.equal(r2.ok, false)
})

test('registerIdentity：只给她那个 agent 挂（按 cwd 判），别人不受影响', () => {
  resetIdentityCache()
  const root = tmp()
  const herDir = join(root, 'home')
  fs.mkdirSync(herDir, { recursive: true })
  fs.writeFileSync(selfDocPath(root), '我是她', 'utf8')

  let handler = null
  const ctx = { on: (evt, fn) => { assert.equal(evt, 'agent/created'); handler = fn; return () => {} } }
  const off = registerIdentity(ctx, { root, herDir, log: () => {} })
  assert.equal(typeof off, 'function')
  assert.equal(typeof handler, 'function')

  const mine = []
  handler({ agent: { session: { header: { cwd: herDir } }, ctx: { systemPrompt: { section: (o) => mine.push(o) } } } })
  const others = []
  handler({ agent: { session: { header: { cwd: join(root, 'other') } }, ctx: { systemPrompt: { section: (o) => others.push(o) } } } })
  handler({ agent: { session: { header: { cwd: '' } }, ctx: { systemPrompt: { section: (o) => others.push(o) } } } })

  assert.equal(mine.length, 3, '她那条会话必须挂上（身份 + 处境 + 手边三段）')
  assert.equal(others.length, 0, '用户自己的会话不许挂')
})

test('registerIdentity：ctx.on 不可用时返回空函数，不抛', () => {
  const off = registerIdentity({}, { root: tmp(), herDir: tmp(), log: () => {} })
  assert.equal(typeof off, 'function')
  off()
})

test('index.js：先写身份文本、再注册身份段、最后才建屋子', () => {
  const iPre = INDEX.indexOf('await writeSelfDoc(root')
  const iReg = INDEX.indexOf('registerIdentity(ctx')
  const iHome = INDEX.indexOf('await bootstrapHome(')
  assert.ok(iPre > 0 && iReg > 0 && iHome > 0)
  assert.ok(iPre < iReg, '文本要先生成，否则她第一轮拿到空串')
  assert.ok(iReg < iHome, '必须早于 bootstrapHome：她那条会话就是在里面创建的')
  assert.ok(!/身份文件：宿主每轮会重读它/.test(INDEX), '旧注释里「宿主每轮重读」已经不成立')
})

test('默认预算 1200 → 1800 → 2400，且三处（配置、常量、界面）一致', () => {
  // 2026-11-03（用户 m00998）：1800 / 2000 都挤掉「你被打脸过」，2200 反而挤掉
  // 「你对自己的说法」（更糟），2400 才一段不丢。三个数必须一起动，否则界面里
  // 显示的和真正用的不是一个数。
  assert.equal(DEFAULTS.memory.docBudget, 2400)
  assert.equal(SELF_DOC_BUDGET, 2400)
  assert.ok(CLIENT.includes('useState(2400)'), '界面初始值要跟着改')
  assert.ok(CLIENT.includes("cfg.memory?.docBudget ?? 2400"))
  assert.ok(!CLIENT.includes('useState(1200)'), '旧的 1200 不许残留')
  assert.ok(!CLIENT.includes('useState(1800)'), '旧的 1800 不许残留')
  // 判断区仍固定 3 条：这一条是「像工作记忆」，与预算无关
  assert.equal(BELIEF_SHOWN, 3)
})

test('say.js 不再把身份/工具说明塞进 user 消息（否则用户能在对话里看见）', () => {
  const say = SAY
  assert.ok(!/from '\.\/persona\.js'/.test(say), 'say.js 不该再 import persona')
  assert.ok(!say.includes('TOOL_BRIEF'), '工具说明由 system prompt 提供')
  assert.ok(!say.includes('personaLine'), '身份由 system prompt 提供')
  assert.ok(say.includes("const content = ['## 这次', '', ...parts]"))
})

// ---------------------------------------------------------------------------
// 0.8.5（用户 m01579 拍板 B 案）：宿主的 "You are a coding agent…" 排在
// 她的身份段前面七千多字，她先认下那句空话。改部署配置会影响所有 agent，
// 所以只在她那条会话的组装链上整改：摘掉那一段、把身份段提到最前。
// ---------------------------------------------------------------------------

test('reorderForHer：摘掉宿主的 coding agent 段，身份段提到 harness:identity 之后', () => {
  const assembly = {
    sections: [
      { name: 'harness:identity', order: -1000, text: 'You are an AI agent powered by DeepSeek Harness.' },
      { name: HOST_PERSONA_SECTION, order: 0, text: 'You are a coding agent powered by the model.' },
      { name: 'tool-bash', order: 1000, text: 'ops_bash 说明' },
      { name: 'fish:tools', order: TOOLS_ORDER, text: '手边有什么' },
      { name: IDENTITY_SECTION, order: IDENTITY_ORDER, text: '## 你是谁' },
      { name: 'deliverable-file-references', order: 9000, text: '文件引用' },
    ],
  }
  const out = reorderForHer(assembly)
  const names = out.sections.map((s) => s.name)
  assert.deepEqual(names, [
    'harness:identity',
    IDENTITY_SECTION,
    'tool-bash',
    'fish:tools',
    'deliverable-file-references',
  ])
  // 那句 coding agent 必须消失
  assert.ok(!out.sections.some((s) => s.name === HOST_PERSONA_SECTION))
  assert.ok(!JSON.stringify(out.sections).includes('You are a coding agent'))
  // 别的段一个不少，顺序也照旧（只是身份段被抽走了）
  assert.equal(out.sections.length, 5)
})

test('reorderForHer：宿主的 harness:identity 不见了，身份段就排最前', () => {
  const out = reorderForHer({
    sections: [
      { name: HOST_PERSONA_SECTION, order: 0, text: 'coding agent' },
      { name: 'tool-read', order: 1100, text: 'read' },
      { name: IDENTITY_SECTION, order: IDENTITY_ORDER, text: '## 你是谁' },
    ],
  })
  assert.deepEqual(out.sections.map((s) => s.name), [IDENTITY_SECTION, 'tool-read'])
})

test('reorderForHer：没有她的身份段时只摘不走样（不抛、不乱排）', () => {
  const out = reorderForHer({
    sections: [
      { name: 'harness:identity', order: -1000, text: 'h' },
      { name: HOST_PERSONA_SECTION, order: 0, text: 'coding agent' },
      { name: 'tool-bash', order: 1000, text: 'b' },
    ],
  })
  assert.deepEqual(out.sections.map((s) => s.name), ['harness:identity', 'tool-bash'])
})

test('reorderForHer：拿到空/坏数据原样返回，不抛', () => {
  assert.equal(reorderForHer(null), null)
  assert.equal(reorderForHer(undefined), undefined)
  const noSections = { variables: {} }
  assert.equal(reorderForHer(noSections), noSections)
  assert.equal(reorderForHer({ sections: 'x' }).sections, 'x')
})

test('attachAssembleFix：挂在 agent.ctx 上（不是全局），拿到 next() 的结果再整改', async () => {
  let handler = null
  let opts = null
  const agent = {
    ctx: {
      on: (evt, fn, o) => {
        assert.equal(evt, 'system-prompt/assemble')
        handler = fn
        opts = o
        return () => {}
      },
    },
  }
  const off = attachAssembleFix(agent)
  assert.equal(typeof off, 'function', '必须返回卸载函数，回家那一刻要能拆')
  assert.equal(opts?.prepend, true, '排最外层先跑：别的插件加的段也一起整理')

  // 模拟宿主：先跑我们的 handler，它内部 next() 拿到下层组装结果
  const host = {
    sections: [
      { name: 'harness:identity', order: -1000, text: 'h' },
      { name: HOST_PERSONA_SECTION, order: 0, text: 'You are a coding agent' },
      { name: IDENTITY_SECTION, order: IDENTITY_ORDER, text: '## 你是谁' },
    ],
  }
  const out = await handler({}, {}, async () => host)
  assert.deepEqual(out.sections.map((s) => s.name), ['harness:identity', IDENTITY_SECTION])
})

test('attachAssembleFix：老宿主没有 ctx.on 时返回 undefined，不抛', () => {
  assert.equal(attachAssembleFix({ ctx: {} }), undefined)
  assert.equal(attachAssembleFix({}), undefined)
  assert.equal(attachAssembleFix(undefined), undefined)
  // ctx.on 自己抛也不能把挂身份这件事带塌
  assert.equal(attachAssembleFix({ ctx: { on: () => { throw new Error('unsupported') } } }), undefined)
})

test('attachIdentity 顺手挂上组装钩子，且拆卸时一起拆', () => {
  resetIdentityCache()
  clearWakeSection()
  const root = tmp()
  fs.mkdirSync(join(root, 'home'), { recursive: true })
  fs.writeFileSync(selfDocPath(root), '我是她', 'utf8')

  const calls = []
  const hooks = []
  const agent = {
    ctx: {
      systemPrompt: { section: (o) => { calls.push(o); return () => {} } },
      on: (evt, fn, o) => { hooks.push({ evt, fn, o }); return () => {} },
    },
  }
  const r = attachIdentity(agent, root)
  assert.equal(r.ok, true)
  assert.equal(calls.length, 3, 'assemble 钩子不是 system prompt 的段，不许占段位')
  assert.equal(hooks.length, 1)
  assert.equal(hooks[0].evt, 'system-prompt/assemble')
  assert.equal(hooks[0].o?.prepend, true)
  // mountedCount 只数段与守卫；钩子单独记，但回家时必须一起拆
  assert.equal(mountedCount(agent), 3)
})

test('attachAssembleFix：整改过程炸了也必须原样放行（不能让她一整轮没有系统提示词）', async () => {
  let handler = null
  const agent = { ctx: { on: (evt, fn) => { handler = fn; return () => {} } } }
  attachAssembleFix(agent)
  const frozen = Object.freeze({
    sections: Object.freeze([
      { name: 'harness:identity', order: -1000, text: 'h' },
      { name: IDENTITY_SECTION, order: IDENTITY_ORDER, text: '## 你是谁' },
    ]),
  })
  // sections 是冻结的，reorderForHer 里赋值会抛（严格模式）——钩子必须吞掉并原样返回
  const out = await handler({}, {}, async () => frozen)
  assert.equal(out, frozen, '抛了就把宿主原来那份原样交回去')
})
