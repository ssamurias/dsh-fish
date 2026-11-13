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
  BELIEFS_ORDER,
  BELIEFS_SECTION,
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
  clearWakeSectionFor,
  forgetTurnIdentity,
  getWakeSection,
  identityText,
  lastTrimReport,
  mountedCount,
  registerIdentity,
  reorderForHer,
  resetIdentityCache,
  resetTurnIdentity,
  setWakeSection,
  splitVolatileIdentity,
  toolNamesIn,
  trimToolDocs,
} from '../lib/identity.js'
import { legacySelfDocPath, selfDocPath } from '../lib/selfdoc.js'
import { paths } from '../lib/store.js'
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

test('attachIdentity：手边有什么这一段不能漏字面量 {T}（issue #137，2026-11-14）', () => {
  resetIdentityCache()
  const root = tmp()
  fs.mkdirSync(join(root, 'home'), { recursive: true })
  fs.writeFileSync(selfDocPath(root), '我是她', 'utf8')

  const calls = []
  const agent = { ctx: { systemPrompt: { section: (o) => calls.push(o) } } }
  assert.equal(attachIdentity(agent, root).ok, true)
  const tools = calls.find((c) => c.name === TOOLS_SECTION)
  const text = tools.text()
  assert.ok(!text.includes('{T}'), '这一段是独立挂载的，不经过 persona.assemble 的出口')
  assert.doesNotMatch(text, /\{[A-Z][A-Za-z0-9_]*\}/, '渲染出来的身份里不许留没填的占位符')
  assert.match(text, /他随时能再添几样进来/, '默认称呼仍是「他」')

  // 代词换了她就得跟着换，而且不用重建会话（text 是函数，每轮现算）
  const cfg = paths(root).config
  fs.writeFileSync(cfg, JSON.stringify({ owner: { pronoun: '她' } }), 'utf8')
  const later = new Date(Date.now() + 5000)
  fs.utimesSync(cfg, later, later)
  const again = tools.text()
  assert.match(again, /她随时能再添几样进来/)
  assert.ok(!again.includes('{T}'))

  // 代词是模块级「上次读到的值」，别把它留给后面的用例
  fs.writeFileSync(cfg, JSON.stringify({ owner: { pronoun: '他' } }), 'utf8')
  const back = new Date(Date.now() + 10000)
  fs.utimesSync(cfg, back, back)
})

test('attachIdentity：没有 systemPrompt 时返回 ok:false，不抛', () => {
  const r = attachIdentity({ ctx: {} }, tmp())
  assert.equal(r.ok, false)
  assert.match(r.why, /systemPrompt/)
  const r2 = attachIdentity(undefined, tmp())
  assert.equal(r2.ok, false)
})

// issue #110（2026-11-13 用户 m01547 的真机文档）：同一轮里工具回执之后，
// 身份文档被 refreshSelfDoc 重写了，宿主第 2 步重新组装出**不一样**的 system prompt
// 再下发一次——她把这个形状读成「又被叫醒了一次」，于是补一句话收尾。
// 修法：身份段一轮只读一次盘，中途写盘只影响下一轮。
test('issue #110：同一轮里重写身份文档，system prompt 那一段不变', () => {
  resetIdentityCache()
  resetTurnIdentity()
  clearWakeSection()
  const root = tmp()
  fs.mkdirSync(join(root, 'home'), { recursive: true })
  const file = selfDocPath(root)
  fs.writeFileSync(file, '第一版身份', 'utf8')

  const calls = []
  const agent = {
    session: { header: { id: 'session-issue110' } },
    ctx: { systemPrompt: { section: (o) => calls.push(o) } },
  }
  attachIdentity(agent, root)
  const sec = calls[0]
  assert.equal(sec.text(), '第一版身份')

  // 她这一步调了 growth_commit → 文件被重写（同一轮还没结束）
  fs.writeFileSync(file, '第二版身份', 'utf8')
  const later = new Date(Date.now() + 2000)
  fs.utimesSync(file, later, later)
  assert.equal(identityText(root), '第二版身份', '文件确实变了（前置条件）')
  assert.equal(sec.text(), '第一版身份', '同一轮里绝不能让 system prompt 变样')

  // 下一轮开始：丢掉快照，读新的一份
  forgetTurnIdentity('session-issue110')
  assert.equal(sec.text(), '第二版身份')
})

test('issue #110：轮边界才丢快照（user/message、turn/end），同轮内不动', () => {
  resetIdentityCache()
  resetTurnIdentity()
  const root = tmp()
  fs.mkdirSync(join(root, 'home'), { recursive: true })
  const file = selfDocPath(root)
  fs.writeFileSync(file, '第一版身份', 'utf8')

  const handlers = {}
  const ctx = {
    on: (evt, fn) => {
      handlers[evt] = fn
      return () => {}
    },
  }
  registerIdentity(ctx, { root, herDir: join(root, 'her'), log: () => {} })
  assert.equal(typeof handlers['session/event'], 'function', '必须监听轮边界')

  const calls = []
  const agent = {
    session: { header: { id: 'session-a', cwd: join(root, 'her') } },
    ctx: { systemPrompt: { section: (o) => calls.push(o) } },
  }
  handlers['agent/created']({ agent })
  const sec = calls[0]

  // 同轮第 2 步：只有工具回执
  handlers['session/event']({ header: { id: 'session-a' } }, { type: 'tool/result', data: {} })
  assert.equal(sec.text(), '第一版身份')

  // 文件被重写（同一轮里发生的写盘）
  fs.writeFileSync(file, '第二版身份', 'utf8')
  const later = new Date(Date.now() + 2000)
  fs.utimesSync(file, later, later)
  handlers['session/event']({ header: { id: 'session-a' } }, { type: 'step/start', data: {} })
  assert.equal(sec.text(), '第一版身份', '下一步还是同一轮，不能变')

  // turn/end → 下一轮重新读
  handlers['session/event']({ header: { id: 'session-a' } }, { type: 'turn/end', data: {} })
  assert.equal(sec.text(), '第二版身份')
})

test('registerIdentity：只给她那个 agent 挂（按 cwd 判），别人不受影响', () => {
  resetIdentityCache()
  const root = tmp()
  const herDir = join(root, 'home')
  fs.mkdirSync(herDir, { recursive: true })
  fs.writeFileSync(selfDocPath(root), '我是她', 'utf8')

  let handler = null
  const ctx = {
    on: (evt, fn) => {
      // 1.0.0（issue #110）之后这里多挂了一个 session/event 的轮边界监听；
      // 这个用例只关心 agent/created。
      if (evt === 'agent/created') handler = fn
      return () => {}
    },
  }
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

// ---------------------------------------------------------------------------
// trimToolDocs：按「她这一次真实拿到的工具表」摘掉讲别的工具的段
// ---------------------------------------------------------------------------

// 一段像 dsh-free-search 那样无条件挂上来的说明：讲了三个工具，长到值得判断。
const SEARCH_DOC = `## Web search (free-search)\n\n你可以用 web_search 搜关键词，用 web_fetch 读一整页，\n用 browser_open 打开需要脚本执行的中转页。这三样都在你手上，前提是宿主放行了它们。\n${'x'.repeat(600)}`

test('trimToolDocs：她手上一个搜索工具都没有 → 摘掉那段搜索说明，报省了多少字', () => {
  const out = trimToolDocs({
    sections: [
      { name: 'fish:identity', order: 8500, text: '我是她' },
      { name: 'free-search:engines', order: 500, text: SEARCH_DOC },
      { name: 'harness:identity', order: 0, text: '你是 coding agent' },
    ],
    tools: [{ name: 'her_recall' }, { name: 'bili_look' }],
  })
  assert.deepEqual(out.sections.map((s) => s.name), ['fish:identity', 'harness:identity'])
  const rep = lastTrimReport()
  // 2026-11-14 加固：harness:identity 的正文是「你是 coding agent」而不是那句原话，
  // 签名对不上就留着——名字像不等于内容就是那段（宁可多留，不能误摘）。
  assert.equal(rep.dropped.length, 1)
  assert.deepEqual(rep.dropped.map((d) => d.name), ['free-search:engines'])
  assert.equal(rep.saved, SEARCH_DOC.length)
})

test('trimToolDocs：她手上有其中一个工具 → 整段留着（讲的是她够得着的东西）', () => {
  const out = trimToolDocs({
    sections: [{ name: 'free-search:engines', order: 500, text: SEARCH_DOC }],
    tools: [{ name: 'web_search' }],
  })
  assert.equal(out.sections.length, 1)
  assert.equal(lastTrimReport().dropped.length, 0)
})

test('trimToolDocs：判据跟着工具表走，不跟着「装没装某个插件」走', () => {
  // 同一个段、同一份文字：换一个装了别家搜索插件的用户，她手上有 query_web。
  const section = { name: 'some-search:doc', order: 500, text: SEARCH_DOC }
  const withoutSearch = trimToolDocs({ sections: [{ ...section }], tools: [{ name: 'read_image' }] })
  assert.equal(withoutSearch.sections.length, 0, '没放行搜索 → 摘')
  const withSearch = trimToolDocs({ sections: [{ ...section }], tools: [{ name: 'query_web' }] })
  // query_web 不在那段文字里 → 仍然摘：判据是「这段讲的工具她有没有」，不是「她有没有搜索能力」。
  assert.equal(withSearch.sections.length, 0)
  const documented = trimToolDocs({
    sections: [{ ...section, text: SEARCH_DOC.replace('web_fetch', 'query_web') }],
    tools: [{ name: 'query_web' }],
  })
  assert.equal(documented.sections.length, 1, '别的搜索插件自己写对了段 → 留')
})

test('trimToolDocs：拿不到工具表（缺失/空）就一段都不动——宁可多留，不能误摘', () => {
  for (const tools of [undefined, null, [], 'nope']) {
    const out = trimToolDocs({
      sections: [{ name: 'free-search:engines', order: 500, text: SEARCH_DOC }],
      ...(tools === undefined ? {} : { tools }),
    })
    assert.equal(out.sections.length, 1, `tools=${JSON.stringify(tools)}`)
  }
  assert.equal(lastTrimReport().saved, 0)
})

test('trimToolDocs：宿主的组装结果里没有 tools 时，用调用方传进来的工具表（2026-11-14 实测 0.2.x）', () => {
  // 0.2.x 的 assemble() 把 tools 挂在瀑布返回之后，所以 assembly.tools 恒为 undefined；
  // 她的工具表改由 attachAssembleFix 从 visibleToolsOf(agent) 现取后传进来。
  const out = trimToolDocs(
    { sections: [{ name: 'free-search:engines', order: 500, text: SEARCH_DOC }] },
    { tools: ['her_recall', 'bili_look'] },
  )
  assert.equal(out.sections.length, 0, '工具表从参数来，判据不能空转')
  assert.equal(lastTrimReport().dropped[0].name, 'free-search:engines')
})

// ---------------------------------------------------------------------------
// 公开包加固（2026-11-14）：不同宿主版本、不同插件、不同白名单下都要摘得对
// 这里守的是「万一判错」的那几条线——判错就会删掉她需要的提示词。
// ---------------------------------------------------------------------------

test('trimToolDocs：段的正文是 getter 函数也要读得出来（真宿主就是这么挂的）', () => {
  const out = trimToolDocs(
    {
      sections: [
        { name: 'free-search:engines', order: 500, get text() { return SEARCH_DOC } },
        { name: 'fish:identity', order: 8500, text: '我是她' },
      ],
    },
    { tools: ['her_recall'] },
  )
  assert.deepEqual(out.sections.map((s) => s.name), ['fish:identity'], 'getter 读不出来就会永远留着，等于空转')
})

test('trimToolDocs：present 那段只在她真有 present 时留（needs 判据）', () => {
  const section = {
    name: 'ui:deliverable-file-references',
    order: 300,
    text: 'Use present to publish a deliverable file card, then link it. ' + 'x'.repeat(500),
  }
  const without = trimToolDocs({ sections: [{ ...section }] }, { tools: ['her_recall'] })
  assert.equal(without.sections.length, 0, '她没有 present → 摘')
  const withIt = trimToolDocs({ sections: [{ ...section }] }, { tools: ['her_recall', 'present'] })
  assert.equal(withIt.sections.length, 1, '她有 present → 留')
})

test('trimToolDocs：安全闸——摘完几乎不给她留东西时整段放行，并记一次', () => {
  const logs = []
  const big = '## 别的工具\n\nfoo_tool bar_tool baz_tool\n' + 'x'.repeat(3600)
  const out = trimToolDocs(
    {
      sections: [
        { name: 'some-other:doc', order: 100, text: big },
        { name: 'fish:identity', order: 8500, text: '我是她'.repeat(200) },
      ],
    },
    { tools: ['her_recall'], log: (m) => logs.push(m) },
  )
  assert.equal(out.sections.length, 2, '判据算出来要把大半都摘掉 → 说明判据坏了，原样放行')
  assert.equal(lastTrimReport().skipped, 'suspicious')
  assert.equal(logs.length, 1)
  assert.match(logs[0], /太可疑，按原样放行/)
})

test('trimToolDocs：安全闸——只摘到剩不到 2000 字也放行', () => {
  const big = 'foo_tool bar_tool baz_tool\n' + 'x'.repeat(4300)
  const out = trimToolDocs(
    {
      sections: [
        { name: 'some-other:doc', order: 100, text: big },
        { name: 'fish:identity', order: 8500, text: '我是她' },
      ],
    },
    { tools: ['her_recall'] },
  )
  assert.equal(out.sections.length, 2)
  assert.equal(lastTrimReport().skipped, 'suspicious')
})

test('trimToolDocs：DSH_FISH_PROMPT_TRIM=off 时只排序、一段不摘（公开包紧急开关）', () => {
  const before = process.env.DSH_FISH_PROMPT_TRIM
  process.env.DSH_FISH_PROMPT_TRIM = 'off'
  try {
    const out = trimToolDocs(
      { sections: [{ name: 'free-search:engines', order: 500, text: SEARCH_DOC }] },
      { tools: ['her_recall'] },
    )
    assert.equal(out.sections.length, 1)
    assert.equal(lastTrimReport().skipped, 'off')
    assert.equal(lastTrimReport().saved, 0)
  } finally {
    if (before === undefined) delete process.env.DSH_FISH_PROMPT_TRIM
    else process.env.DSH_FISH_PROMPT_TRIM = before
  }
})

test('trimToolDocs：名字认得出的「别的插件的说明」短也照摘（tool:beauticode 192 字，启发式抓不到）', () => {
  const out = trimToolDocs(
    {
      sections: [
        { name: 'tool:beauticode', order: 160, text: 'beautiCode 可以把本机图片设为 Harness 页面背景。' },
        { name: 'genui:fence', order: 300, text: '用 dsh-ui 围栏渲染界面，组件名见 genui skill。'.repeat(50) },
        { name: 'dsh:auto-memory-pre-rules', order: 320, text: '记忆系统固定纪律：每轮必须 memory_log。'.repeat(30) },
        { name: 'harness:identity', order: 0, text: 'You are an AI agent powered by DeepSeek Harness.' },
      ],
    },
    { tools: ['her_recall'] },
  )
  assert.deepEqual(out.sections, [], '宿主那一行身份声明也不再进她的提示词（2026-11-14 用户要求）')
  const names = lastTrimReport().dropped.map((d) => d.name).sort()
  assert.deepEqual(names, ['dsh:auto-memory-pre-rules', 'genui:fence', 'harness:identity', 'tool:beauticode'])
  assert.ok(lastTrimReport().saved > 2000)
})

test('trimToolDocs：名字表里的段，只要段里提到的工具她真握着就留（判据先看她够不够得着）', () => {
  const mine = trimToolDocs(
    { sections: [{ name: 'tool:jobs', order: 160, text: '用 job_output 看后台任务。' }] },
    { tools: ['job_output', 'her_recall'] },
  )
  assert.equal(mine.sections.length, 1, '她真有这个工具 → 这段讲的就是她能做的事')
  const theirs = trimToolDocs(
    { sections: [{ name: 'tool:jobs', order: 160, text: '用 job_output 看后台任务。' }] },
    { tools: ['her_recall'] },
  )
  assert.equal(theirs.sections.length, 0, '她没有 → 按名字摘掉')
})

test('trimToolDocs：她的段（fish: 开头）永不参与这条判据', () => {
  const out = trimToolDocs({
    sections: [{ name: 'fish:tools', order: 8600, text: SEARCH_DOC }],
    tools: [{ name: 'her_recall' }],
  })
  assert.equal(out.sections.length, 1)
})

test('trimToolDocs：短段、工具名太少的段跳过（B 站标题里的 snake 词不许误伤整段）', () => {
  const noisy = '今天翻到的视频标题：如何用 python_requests 抓 bilibili_video_info，还有 node_fetch 对比。'.repeat(12)
  const out = trimToolDocs({
    sections: [
      { name: 'short', order: 1, text: '看 web_fetch / web_search / browser_open' },
      { name: 'fish:history', order: 2, text: noisy },
      { name: 'one-tool', order: 3, text: `只提 web_search 一个。${'y'.repeat(600)}` },
    ],
    tools: [{ name: 'her_recall' }],
  })
  assert.equal(out.sections.length, 3)
  assert.equal(out.sections[0].name, 'short')
  assert.equal(out.sections[1].name, 'fish:history')
  assert.equal(out.sections[2].name, 'one-tool')
})

test('trimToolDocs：工具表用裸字符串也给认（有些宿主给的是名字数组）', () => {
  const out = trimToolDocs({
    sections: [{ name: 'free-search:engines', order: 500, text: SEARCH_DOC }],
    tools: ['web_fetch'],
  })
  assert.equal(out.sections.length, 1)
})

test('trimToolDocs：摘了段只记一次日志，逐轮不刷屏', () => {
  const lines = []
  const log = (m) => lines.push(m)
  const sec = { name: 'log-once:doc', order: 500, text: SEARCH_DOC }
  trimToolDocs({ sections: [{ ...sec }], tools: [{ name: 'her_recall' }] }, { log })
  trimToolDocs({ sections: [{ ...sec }], tools: [{ name: 'her_recall' }] }, { log })
  assert.equal(lines.length, 1, '同一种摘法只记一次')
  assert.match(lines[0], /摘掉了 1 段/)
  assert.match(lines[0], /log-once:doc/)
})

test('toolNamesIn：只认小写 + 下划线、至少两节的词', () => {
  assert.deepEqual(toolNamesIn('用 web_search，不要用 WebSearch 或 foo，bili_look 也算'),
    ['web_search', 'bili_look'])
})

test('reorderForHer 连带摘段：同一份 assembly，工具表不同结果不同', () => {
  const make = (tools, harness = 'You are an AI agent powered by DeepSeek Harness.') => ({
    sections: [
      { name: 'harness:identity', order: 0, text: harness },
      { name: 'deployment:persona-prefix', order: 10, text: '你是编程助手' },
      { name: 'free-search:engines', order: 500, text: SEARCH_DOC },
      { name: 'fish:identity', order: 8500, text: '我是她' },
    ],
    tools,
  })
  const noTools = reorderForHer(make([]))
  // 空工具表 = 判断不了 → 一段不摘，只做排序
  assert.deepEqual(noTools.sections.map((s) => s.name),
    ['harness:identity', 'fish:identity', 'free-search:engines'])
  const otherTools = reorderForHer(make([{ name: 'her_recall' }]))
  // 2026-11-14：harness:identity 那一行是宿主的产品介绍，不是她的自我陈述，按名字 + 原文签名摘掉
  assert.deepEqual(otherTools.sections.map((s) => s.name), ['fish:identity'])
  // 名字一样、正文不是那句原话（宿主换版本改了词）→ 签名对不上，留着，宁可多留
  const renamed = reorderForHer(make([{ name: 'her_recall' }], '你是 coding agent'))
  assert.deepEqual(renamed.sections.map((s) => s.name), ['harness:identity', 'fish:identity'])
  const withTools = reorderForHer(make([{ name: 'web_fetch' }]))
  assert.deepEqual(withTools.sections.map((s) => s.name),
    ['fish:identity', 'free-search:engines'])
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

test('attachIdentity 顺手挂上组装钩子与正文清洗钩子，且拆卸时一起拆', () => {
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
  // 组装钩子（0.8.5 摘 persona-prefix）与正文清洗钩子（0.9.8 llm/stream）各一条
  assert.deepEqual(hooks.map((h) => h.evt), ['system-prompt/assemble', 'llm/stream'])
  for (const h of hooks) assert.equal(h.o?.prepend, true, '两个钩子都要排最外层')
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

// ---- 四段最容易变的内容挪到最后（0.8.10，用户 m00315）----

const ID_DOC = [
  '## 你是谁',
  '你是她。',
  '## 你自己说过的话（这些是你的，不是别人塞给你的）',
  '- 我不喜欢被叫小助手。',
  '## 更早以前',
  '你说过：还行吧。',
  '## 你读到的一句话',
  '「手工的东西有温度。」',
  '## 我手上有什么',
  '- bili_look',
  '## 你被打脸过',
  '- 你原来以为「A」，后来改成了「B」。',
  '## 这个房间',
  '- 一台电脑。',
  '## 你对自己的说法',
  '我是个还没长完的人。',
].join('\n')

test('splitVolatileIdentity：四段剪出来，其余原样、顺序不变', () => {
  const { stable, volatile } = splitVolatileIdentity(ID_DOC)
  assert.match(volatile, /## 你自己说过的话/, '带括号补充的标题也要认出来')
  assert.match(volatile, /## 你读到的一句话/)
  assert.match(volatile, /## 你被打脸过/)
  assert.match(volatile, /## 你对自己的说法/)
  assert.ok(!stable.includes('你被打脸过'))
  assert.ok(!stable.includes('读到的一句话'))
  assert.ok(stable.includes('## 更早以前'), '没被点名的段不动')
  assert.ok(stable.includes('## 这个房间'))
  // 稳定部分里，被剪掉的位置不会留下空行或碎块
  assert.equal(stable.split('\n\n\n').length, 1)
  assert.ok(stable.indexOf('## 你是谁') < stable.indexOf('## 更早以前'))
  assert.ok(stable.indexOf('## 更早以前') < stable.indexOf('## 我手上有什么'))
})

test('splitVolatileIdentity：一段都没有时原样返回，不做任何改写', () => {
  const text = '## 你是谁\n你是她。\n## 这个房间\n一台电脑。'
  const r = splitVolatileIdentity(text)
  assert.equal(r.volatile, '')
  assert.equal(r.stable, text)
})

test('splitVolatileIdentity：只认标题行，正文里提到这几个词不算', () => {
  const text = '## 你是谁\n你被打脸过几次，也读到过一句话。\n## 这个房间\n一台电脑。'
  assert.equal(splitVolatileIdentity(text).volatile, '')
})

test('splitVolatileIdentity：给成函数也读得出来，炸了就当没剪', () => {
  assert.match(splitVolatileIdentity(() => ID_DOC).volatile, /你对自己的说法/)
  assert.deepEqual(splitVolatileIdentity(() => { throw new Error('x') }), { stable: '', volatile: '' })
})

test('reorderForHer：四段单列一段，挂在最后（wake 之后）', () => {
  const assembly = {
    sections: [
      { name: 'harness:identity', order: -1000, text: 'h' },
      { name: IDENTITY_SECTION, order: IDENTITY_ORDER, text: ID_DOC },
      { name: WAKE_SECTION, order: WAKE_ORDER, text: '现在四点。' },
    ],
  }
  const out = reorderForHer(assembly)
  const names = out.sections.map((s) => s.name)
  assert.equal(names.at(-1), BELIEFS_SECTION, '最后一段是它')
  assert.equal(names.indexOf(WAKE_SECTION), names.length - 2, '排在处境段之后')
  const beliefs = out.sections.at(-1)
  assert.equal(beliefs.order, BELIEFS_ORDER)
  assert.match(beliefs.text, /## 你对自己的说法/)
  const identity = out.sections.find((s) => s.name === IDENTITY_SECTION)
  assert.ok(!identity.text.includes('你对自己的说法'), '身份正文里不再有它')
  assert.ok(identity.text.includes('## 你是谁'))
  // 内容一个字不丢：原文每一行都还在某一段里
  for (const line of ID_DOC.split(String.fromCharCode(10)).filter(Boolean)) {
    assert.ok(identity.text.includes(line) || beliefs.text.includes(line), `丢了：${line}`)
  }
})

test('reorderForHer：没有这四段就不多出一段空段', () => {
  const assembly = {
    sections: [
      { name: 'harness:identity', order: -1000, text: 'h' },
      { name: IDENTITY_SECTION, order: IDENTITY_ORDER, text: '## 你是谁\n你是她。' },
    ],
  }
  const out = reorderForHer(assembly)
  assert.equal(out.sections.filter((s) => s.name === BELIEFS_SECTION).length, 0)
})

// 2026-11-06（用户报「叫醒之后连着好几轮只思考不说话」）：
// 处境段原来是一个进程级变量，一个进程里她可能同时住着好几条会话，
// A 房间的一次叫醒会被塞进 B 房间正在跑的那一轮。下面三条守新口径。

test('处境按会话分开存：A 房间的一次叫醒，不许进 B 房间那一轮', () => {
  clearWakeSection()
  setWakeSection('这一轮是你自己的，不用回应任何人。', 'session-a')
  assert.equal(getWakeSection('session-a'), '这一轮是你自己的，不用回应任何人。')
  assert.equal(getWakeSection('session-b'), '', 'B 房间不该看见 A 的处境')

  // 挂在 agent 上的那段闭包也得取自己那条会话的
  const seen = []
  const mk = (id) => ({
    session: { header: { id } },
    ctx: { systemPrompt: { section: (o) => seen.push({ id, o }) } },
  })
  const root = tmp()
  fs.mkdirSync(join(root, 'home'), { recursive: true })
  fs.writeFileSync(selfDocPath(root), '我是她', 'utf8')
  attachIdentity(mk('session-a'), root)
  attachIdentity(mk('session-b'), root)
  const wakeOf = (id) => seen.find((s) => s.id === id && s.o.name === WAKE_SECTION).o.text()
  assert.equal(wakeOf('session-a'), '这一轮是你自己的，不用回应任何人。')
  assert.equal(wakeOf('session-b'), '', '另一条会话的这一轮必须是干净的')
  clearWakeSection()
})

test('他一开口，那次叫醒就作废（哪怕 turn/end 没认到）', () => {
  clearWakeSection()
  setWakeSection('这一轮是你自己的，不用回应任何人。', 'session-a')
  // 认不出会话的那份残留也一起清
  setWakeSection('没人认领的处境', '')
  clearWakeSectionFor('session-a')
  assert.equal(getWakeSection('session-a'), '')
  assert.equal(getWakeSection(''), '', '无主残留一并清掉')
})

test('处境最多活十分钟：turn/end 一直不来也不会挂到进程退出', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  clearWakeSection()
  setWakeSection('这一轮是你自己的。', 'session-t')
  assert.equal(getWakeSection('session-t'), '这一轮是你自己的。')
  t.mock.timers.tick(10 * 60_000)
  assert.equal(getWakeSection('session-t'), '', '到点无条件清掉')
})
