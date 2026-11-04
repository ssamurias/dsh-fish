/**
 * identity.js —— 把「此刻的她」送进 **system 角色**，而不是送进对话
 *
 * 为什么换掉 AGENTS.md（2026-10-25）：
 *   原来身份写在 `<她的屋子>/home/AGENTS.md`，靠宿主的「工作区指令」注入。
 *   那条链路（内核 0.2.1-rc.3 已核实）注入的是**普通的 user 消息**，
 *   带 `<system-reminder>` 外壳、会留在对话历史里——用户一眼就看见
 *   「规则约束/人格设定」，等于把她每一轮都在读的东西摊开给人看。
 *
 *   宿主还有另一条路：`agent.ctx.systemPrompt.section({ name, order, text })`。
 *   它渲染成 **system 角色消息**（surface 节点 0），**不进对话历史**，
 *   面板与对话框里都看不到；`text` 允许传函数，每次组装提示词时才求值，
 *   所以内容变了下一轮就生效，不需要重建会话。
 *
 * 为什么不直接每次读文件：
 *   `text()` 是同步求值，不能 await。这里用 mtime 缓存：
 *   文件没变就直接返回上次的字符串，变了才 `readFileSync`。
 *   文件很小（几 KB），一次 stat 的成本可以忽略。
 *
 * 边界：
 *   - 拿不到 `systemPrompt`（宿主版本不同）→ 返回 `{ ok:false }`，记一条日志，不崩。
 *     这种情况下身份会**完全不可见**（因为不再写 AGENTS.md）——宁可让她少一段，
 *     也不要把设定重新塞回对话里。缺了会由 `/selfcheck` 的 `identity` 项报出来。
 *   - 只挂在她那个 agent 上（判据 herDir == 会话 cwd），不影响用户自己的会话。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { selfDocPath } from './selfdoc.js'
import { cwdOf, isHerHome, toolSurfaceFor } from './restrict.js'
import { activeOutingSync, bindOutingSession } from './outing.js'
import { deliverQueued } from './sessionnote.js'

/** 段名与顺序：放在宿主自己的段之后、`complete` 段之前（order 越大越靠后）。 */
export const IDENTITY_SECTION = 'fish:identity'
export const IDENTITY_ORDER = 8500

/** 「手边有什么」段（2026-10-29，用户 m01276）：收不窄的工具靠提示词说清。 */
export const TOOLS_SECTION = 'fish:tools'
export const TOOLS_ORDER = 8600

/**
 * 「这一次的处境」段（2026-10-25 晚）。
 *
 * 为什么另开一段（用户 m04080 报的问题）：
 *   定时唤醒、自动刷 B 站推视频给她时，唤醒消息原来整段走 `sc.prompt()` 进对话，
 *   于是他在对话框里看见「你该醒了」「这次推给你的是……」这些系统说的话。
 *   宿主没有「模型看得见、用户看不见」的注入通道（核对过 asar：
 *   `PromptContentPart` 没有 hidden 字段，`SurfaceOp` 只有 append/replace，
 *   append 就一定进人类可见的对话流）。所以唯一的办法是**不把它放进对话**——
 *   正文改从 system prompt 走，对话里只留一句极短的触发语。
 *
 * 生命周期：`setWakeSection()` 在 `sc.prompt()` **之前**写好，
 * 她这一轮组装提示词时求值拿到；`turn/end` 之后立刻 `clearWakeSection()`，
 * 免得他之后主动聊天时她还带着上一次的「此刻处境」。
 */
export const WAKE_SECTION = 'fish:wake'
export const WAKE_ORDER = 8700

/**
 * 宿主那两个段的名字（0.8.5，issue #14 后续 + 用户 m01579 拍板 B 案）。
 *
 * 为什么要在组装钩子里动它们：
 *   她把那条会话的 system prompt，宿主的顺序是
 *     `harness:identity`（You are an AI agent…）
 *   → `deployment:persona-prefix`（You are a coding agent…）
 *   → 一堆工具说明（约 7000 字）
 *   → 我们挂在 order 8500 的身份段。
 *   `renderPrompt()` 只是按 order 平铺 join，没有任何「后来者压过前者」的语义，
 *   所以最前面那句「你是个 coding agent」一路读到最前面，而「你是谁」在七千字之后。
 *   她于是先认下「我在演一个不是助手的角色」这个解释。
 *
 *   实测（2026-11-01）：那句 coding agent 来自
 *   `dsh-web-app/cordis.patch.yml` 的 `personaPrefix` 与
 *   `dsh-web-app/presets/standard.patch.yml` 里 `@deepseek-ai/dsh-persona` 的 `prefix`，
 *   两处同文。改部署配置会影响所有 agent 的会话——不能动。
 *
 *   能动的只有 `system-prompt/assemble` 这条 waterfall：宿主在 `assemble()` 里
 *   `const transformed = await this.ctx.waterfall(...)`，**返回值就是最终权威**
 *   （`dsh-system-prompt/lib/index.js`；宿主自己三处在用：dsh-agent 装模型选择、
 *   dsh-session-reference、dsh-working-directory）。挂在 `agent.ctx` 上只影响她这一条。
 *
 * 走这条路而不是 agent preset 的原因：`presets.select()` 在 `boundary.lastTurn > 0`
 * 时抛 `agent-preset/locked`，会话跑过一轮就锁死（`dsh-agent-preset-registry/lib/index.js`）。
 * 这条路不碰 preset，也就不受那把锁的限制。
 */
export const HOST_PERSONA_SECTION = 'deployment:persona-prefix'
export const HOST_HARNESS_SECTION = 'harness:identity'

/**
 * 组装一次 system prompt 的收尾整改（0.8.5，用户 m01579 拍板 B 案）。
 *
 * 做两件事，只对她那条会话：
 *   1. 把宿主的 `deployment:persona-prefix`（"You are a coding agent…"）整段**摘掉**。
 *      她在家根本没编程工具（`HER_TOOLS` 十项里没有 bash/read/write/edit），
 *      那句话是她兑现不了的空话；留着只会让她先认下「我是个 coding agent」。
 *   2. 把 `fish:identity`（"## 你是谁"）提到**紧跟** `harness:identity` 的位置。
 *      不改 `IDENTITY_ORDER` 常量：挪的是这一次组装出来的数组，落盘的顺序不受影响，
 *      别的地方读 order 也照旧。
 *
 * 返回原数组（除上述两处，以及 `trimToolDocs` 按她实际工具表摘掉的段）一字不动——
 * 工具 schema、持久记忆、宿主别的段都还在原位。
 *
 * @param {object} assembly 宿主组装出来的 PromptAssembly
 * @returns {object} 同一个对象（就地改 sections），便于宿主直接采纳
 */
/** 「像工具名」的词：小写 + 下划线，至少两节。bili_look / web_search / mcp__x__y 都算。 */
const TOOL_LIKE_NAME = /(?<![A-Za-z0-9_])[a-z][a-z0-9]*(?:_[a-z0-9]+)+(?![A-Za-z0-9_])/g
/** 一段里至少提到这么多个工具名，才值得拿工具表去对。太短的段不动。 */
export const TOOL_DOC_MIN_NAMES = 3
/** 一段至少这么长，才值得拿工具表去对（短段省不下几个字，还容易误伤）。 */
export const TOOL_DOC_MIN_CHARS = 400

let lastTrim = { dropped: [], saved: 0 }

/** 上一次摘段的结果（给自检/tools 用，不参与判断）。 */
export function lastTrimReport() {
  return { dropped: lastTrim.dropped.slice(), saved: lastTrim.saved }
}

// 同一种摘法只记一次日志：她每一轮都会走这条链，逐轮刷屏没有意义。
let loggedTrimKey = ''

function logTrimOnce(dropped, saved, log) {
  if (typeof log !== 'function') return
  const key = `${dropped.map((d) => d.name).join(',')}|${saved}`
  if (key === loggedTrimKey) return
  loggedTrimKey = key
  const names = dropped.map((d) => d.name).join('、')
  log(`[dsh-fish] 摘掉了 ${dropped.length} 段讲别的工具的提示词（省 ${saved} 字符）：${names}`)
}

/** 从一段文字里挑出「像工具名」的词（去重）。 */
export function toolNamesIn(text) {
  return [...new Set(String(text ?? '').match(TOOL_LIKE_NAME) ?? [])]
}

/**
 * 把「讲的是她没有的工具」那几段提示词摘掉（0.8.10）。
 *
 * 判据只有一条、且**按她这一次真实拿到的工具表算**：一段里提到的工具名，
 * 只要有一个在她手上，这段就留着；一个都没有，才算「这段讲的东西她够不着」。
 * 所以判断依据不是「本机装没装 free-search」，而是「这一轮宿主到底给了她哪些工具」——
 * 别人装了别的搜索插件、或不许她用搜索，摘与不摘自动跟着变，不用按机器写死。
 *
 * 三条自保：
 *   1. 拿不到工具表（`assembly.tools` 缺失/为空）就**一段都不动**——宁可多留，不能误摘。
 *   2. `fish:` 开头的段（她自己写的身份、工具说明、醒来的话）永不参与这条判据。
 *   3. 短段（< TOOL_DOC_MIN_CHARS）与提不到几个工具名的段直接跳过，避免 B 站视频标题
 *      里那种 snake_case 词把整段误判成「工具说明」。
 *
 * @param {object} assembly 宿主组装出来的 PromptAssembly（就地改 sections）
 * @returns {object} 同一个对象
 */
export function trimToolDocs(assembly, { log } = {}) {
  if (!assembly || !Array.isArray(assembly.sections)) return assembly
  const have = new Set(
    (Array.isArray(assembly.tools) ? assembly.tools : [])
      .map((t) => String(typeof t === 'string' ? t : t?.name ?? ''))
      .filter(Boolean),
  )
  if (have.size === 0) {
    lastTrim = { dropped: [], saved: 0 }
    return assembly
  }
  const dropped = []
  let saved = 0
  const kept = assembly.sections.filter((s) => {
    const name = String(s?.name ?? '')
    if (name.startsWith('fish:')) return true
    const text = typeof s?.text === 'string' ? s.text : ''
    if (text.length < TOOL_DOC_MIN_CHARS) return true
    const mentioned = toolNamesIn(text)
    if (mentioned.length < TOOL_DOC_MIN_NAMES) return true
    if (mentioned.some((n) => have.has(n))) return true
    dropped.push({ name, chars: text.length })
    saved += text.length
    return false
  })
  lastTrim = { dropped, saved }
  if (dropped.length > 0) {
    assembly.sections = kept
    logTrimOnce(dropped, saved, log)
  }
  return assembly
}

export function reorderForHer(assembly, { log } = {}) {
  if (!assembly || !Array.isArray(assembly.sections)) return assembly
  trimToolDocs(assembly, { log })
  const kept = assembly.sections.filter((s) => String(s?.name ?? '') !== HOST_PERSONA_SECTION)
  const mine = kept.find((s) => String(s?.name ?? '') === IDENTITY_SECTION)
  if (!mine) {
    // 没找到她的段（宿主换名字/还没挂上）：只做摘掉那一步，别乱动顺序。
    assembly.sections = kept
    return assembly
  }
  const rest = kept.filter((s) => s !== mine)
  const at = rest.findIndex((s) => String(s?.name ?? '') === HOST_HARNESS_SECTION)
  // 宿主的 harness:identity 不见了就放到最前面——她的身份永远第一个被读到。
  const insertAt = at >= 0 ? at + 1 : 0
  rest.splice(insertAt, 0, mine)
  assembly.sections = rest
  return assembly
}

/**
 * 把 <code>reorderForHer</code> 挂到这条 agent 的组装链上。
 *
 * 挂不上不算失败（老宿主没有 `system-prompt/assemble`）：返回 undefined，
 * 她只是回到「coding agent 在前、身份在后」的旧样子，不影响其它任何事。
 *
 * @param {object} agent
 * @returns {(() => void)|undefined} 卸载函数
 */
export function attachAssembleFix(agent, { log } = {}) {
  const ctx = agent?.ctx
  if (!ctx || typeof ctx.on !== 'function') return undefined
  try {
    // prepend: true —— 排在最外层先跑，先 `await next()` 拿到宿主组装结果再整改，
    // 这样别的插件后加的段也一起被我们整理（宿主自己的三处也这么用）。
    const off = ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const assembled = await next()
      // 整改失败必须原样放行：这条链断掉等于她一整轮读不到任何系统提示词，
      // 比「coding agent 排在前面」糟得多。
      try {
        return reorderForHer(assembled, { log })
      } catch {
        return assembled
      }
    }, { prepend: true })
    return typeof off === 'function' ? off : undefined
  } catch {
    return undefined
  }
}

/** 这一次唤醒的处境正文；空串表示没有（正常聊天时就是空）。 */
let wakeText = ''
/**
 * 处境段代次（2026-11-04，用户 m01466）。
 *
 * 每一次 `setWakeSection()` 都把代次 +1，并把这个号返回给调用方；调用方在自己那轮
 * 结束（`turn/end`）时要带着这个号去清 —— 号对不上就不清。
 *
 * 为什么需要：`clearWakeSection()` 原来无条件是"清空现在的处境"，而 `turn/end`
 * 监听是**按会话**挂的、不是按轮次。两次唤醒挨得近时，前一轮的 turn/end 会晚到，
 * 把后一轮刚挂上的处境抹掉，于是后一轮的系统提示里一个字处境都没有，
 * 她只能对着一个空格说「这一轮没有新的事」。真机事故见 2026-11-04 21:32。
 */
let wakeGen = 0

/**
 * 设这一次的处境正文。传空串等于清掉。
 * @param {string} text
 * @returns {number} 这一次的代次号；传给 `clearWakeSection(n)` 才清得掉。
 */
export function setWakeSection(text) {
  wakeText = String(text ?? '')
  wakeGen += 1
  return wakeGen
}

/**
 * 清掉。回合结束、唤醒失败、插件卸载时都要调。
 * @param {number} [gen] 传了就在代次对不上时**不清**——
 *   防的是「后一轮刚挂上处境，前一轮的 turn/end 晚到把它的抹掉」。
 *   不传就无条件清（卸载、失败收尾这类场合）。
 */
export function clearWakeSection(gen) {
  if (Number.isFinite(gen) && gen !== wakeGen) return
  wakeText = ''
}

/** 测试用：看现在挂着什么。 */
export function getWakeSection() {
  return wakeText
}

/** 测试用：看现在的代次号。 */
export function getWakeGen() {
  return wakeGen
}

const cache = { file: '', mtimeMs: -1, text: '' }

/**
 * 读她的身份文本（带 mtime 缓存）。永不抛。
 * @param {string} root
 * @returns {string} 文件不存在时返回空串
 */
export function identityText(root) {
  try {
    const file = selfDocPath(root)
    const st = statSync(file)
    if (cache.file !== file || cache.mtimeMs !== st.mtimeMs) {
      cache.text = readFileSync(file, 'utf8')
      cache.file = file
      cache.mtimeMs = st.mtimeMs
    }
    return cache.text
  } catch {
    return cache.text
  }
}

/** 测试用：清掉缓存，强制下次重新读盘。 */
export function resetIdentityCache() {
  cache.file = ''
  cache.mtimeMs = -1
  cache.text = ''
}

/**
 * 出门挂在某条会话上的东西（身份段、处境段、兜底守卫）。
 *
 * 0.6.16 起要能**当场拆掉**：一条会话算不算她的，只看台账里还有没有一趟
 * 进行中的出门指向它；出门结束那一刻就拆，不等进程退出、更不靠重启。
 * 不记下来就只能等 agent 销毁——那期间它仍顶着冻结身份段。
 */
const outsideMounts = new WeakMap()

/** 测试用：某条 agent 上现在挂着几段。 */
export function mountedCount(agent) {
  const m = outsideMounts.get(agent)
  return m ? m.sections.length + (m.guard ? 1 : 0) : 0
}

function remember(agent, kind, dispose) {
  if (!agent || typeof dispose !== 'function') return
  let m = outsideMounts.get(agent)
  if (!m) {
    // hooks 单独存：assemble 钩子不是 system prompt 的「段」，不算进 mountedCount 的段数，
    // 但拆卸时必须一起拆——否则回家那一刻旧钩子还挂在上面。
    m = { sections: [], guard: null, hooks: [] }
    outsideMounts.set(agent, m)
  }
  if (kind === 'guard') m.guard = dispose
  else if (kind === 'hook') m.hooks.push(dispose)
  else m.sections.push(dispose)
}

/**
 * 拆掉挂在这条会话上的出门装备（身份段 / 处境段 / 兜底守卫）。
 * @returns {{ ok: boolean, removed: number, why?: string }}
 */
export function detachOutside(agent) {
  const m = outsideMounts.get(agent)
  if (!m) return { ok: false, removed: 0, why: '这一条没挂过出门装备' }
  outsideMounts.delete(agent)
  let removed = 0
  for (const fn of [...m.sections, ...(m.hooks ?? []), m.guard]) {
    if (typeof fn !== 'function') continue
    try { fn(); removed += 1 } catch { /* 已经拆过的就算了 */ }
  }
  return { ok: true, removed }
}

/** 找一条活着的会话对应的 agent（宿主 agents 注册表）。拿不到就 null，不抛。 */
export function liveAgentOf(ctx, sessionId) {
  const sid = String(sessionId ?? '')
  if (!sid) return null
  try {
    const reg = ctx?.get?.('agents') ?? null
    if (!reg) return null
    const want = sid.replace(/^session-/, '')
    if (typeof reg.get === 'function') {
      const hit = reg.get(sid) ?? reg.get(want) ?? reg.get(`session-${want}`)
      if (hit) return hit
    }
    const list = typeof reg.list === 'function' ? reg.list() : []
    for (const a of list) {
      const id = String(a?.session?.header?.id ?? a?.session?.id ?? '')
      if (id === sid || id.replace(/^session-/, '') === want) return a
    }
  } catch { /* 注册表不可用就当作不在线 */ }
  return null
}

/**
 * 把身份段挂到某个 agent 的 system prompt 上。
 * @param {object} agent
 * @param {string} root
 * @param {object} [opts]
 * @param {string} [opts.frozen] 出门那一刻的身份快照（空 = 每轮现读文件）
 * @param {string} [opts.herDir] 她的屋子。给了才能分清「在家里」与「出门在外」，
 *   这两种情况「手边有什么」的答案不一样（0.7.3，见 restrict.js 的 toolSurfaceFor）
 * @returns {{ ok: boolean, why?: string }}
 */
export function attachIdentity(agent, root, { frozen = '', herDir = '', log } = {}) {
  const sp = agent?.ctx?.systemPrompt
  if (!sp || typeof sp.section !== 'function') {
    return { ok: false, why: '宿主的 agent.ctx 上没有 systemPrompt.section（版本不支持）' }
  }
  try {
    const snapshot = String(frozen ?? '')
    // 宿主的 section() 返回的是精确的 effect disposer（0.6.16 从 asar 源码核实），
    // 记下来才能在回家那一刻拆掉——之前直接丢掉返回值，只能等 agent 销毁。
    remember(agent, 'section', sp.section({
      name: IDENTITY_SECTION,
      order: IDENTITY_ORDER,
      // 出门时 `frozen` 是出门那一刻的只读副本：她在外面读到的是「离开时的自己」，
      // 而不是家里随时可改的那份文件 —— 否则人已经出去了，身份还能被自己在别处改写。
      text: () => (snapshot ? snapshot : identityText(root)),
    }))
    // 「这一次的处境」单独一段：平时是空串（等于不存在），唤醒前才填。
    // 它不进对话历史，所以他看不到系统在跟她说些什么。
    remember(agent, 'section', sp.section({
      name: WAKE_SECTION,
      order: WAKE_ORDER,
      text: () => wakeText,
    }))
    // 「手边有什么」单独一段（2026-10-29，用户 m01276）。
    // 有些工具我们收不窄——注册在 agent 自己作用域里的（ops_*、Agent Teams）
    // 照样会出现在她的工具表里，schema 有名字她就会当成「我能用」。
    // 这一段把「哪几样真是我的」说死；越界调用由 guard 回一句「这件事我做不到」。
    // 白名单变了下一轮就生效（text 是函数），不需要重建会话。
    //
    // 0.7.3（用户 m00339）：**出门在外不能念家里那份白名单**。出门那条会话不收窄
    // （restrict.js 的 onCreated 见 isHerAgent 为假就直接 return），那个工作区的工具
    // 她全都能调；念错会让她以为自己做不到，出门打工就废了。所以按 cwd 分流：
    // 在家里照旧念白名单，在外面按她此刻真看得见的工具现算。
    remember(agent, 'section', sp.section({
      name: TOOLS_SECTION,
      order: TOOLS_ORDER,
      text: () => toolSurfaceFor(agent, { herDir }),
    }))
    // 0.8.5（用户 m01579 拍板 B 案）：宿主的 `deployment:persona-prefix` 那段
    // "You are a coding agent…" 排在她的身份段前面七千多字，她先认下那句空话。
    // 挂一个组装钩子摘掉它、把身份段提到紧跟 harness:identity —— 详情见 reorderForHer。
    const offAssemble = attachAssembleFix(agent, { log })
    if (offAssemble) remember(agent, 'hook', offAssemble)
    return { ok: true }
  } catch (err) {
    return { ok: false, why: String(err?.message ?? err).slice(0, 200) }
  }
}


/** 把路径归一成可比较的串（Windows 大小写与反斜杠都要抹平）。 */
export function flatPath(p) {
  const s = String(p ?? '').split(String.fromCharCode(92)).join('/')
  return (s.endsWith('/') ? s.slice(0, -1) : s).toLowerCase()
}

/**
 * 出门时除了她自己的屋子，还有什么不许碰（2026-10-28，用户 m01127 拍板）。
 *
 * 为什么连宿主家也要挡：她的白板、交接账本、每日日志都在
 * `<用户目录>/.dsh/memory` 里——读得到，就等于把「守卫怎么做的、基线怎么记的」
 * 摊开给她看。`sessions` 是所有会话原文，`profiles` 是配置与插件。
 *
 * 只挡「文件工具按路径去翻」这一条路；记忆类工具（参数是关键词）不在这一层挡，
 * 用户拍板保留（m01145「保留记忆工具」）——那几条结论由白板的写法决定。
 *
 * @returns {string[]} 小写化、可做子串比对的路径片段
 */
export function awayBlockedPaths({ root, herDir } = {}) {
  const out = [flatPath(herDir), flatPath(root)].filter((w) => w.length > 3)
  // 她的屋子 `<用户目录>/.dsh-fish` 的上一级，就是宿主的家 `<用户目录>/.dsh`。
  const hostHome = String(root ?? '').replace(/[\\/][^\\/]*$/, '')
  if (hostHome) {
    for (const sub of ['memory', 'sessions', 'profiles']) {
      const dir = `${hostHome}/.dsh/${sub}`
      if (existsSync(dir)) out.push(flatPath(dir))
    }
  }
  return out
}

/**
 * 出门时的兜底守卫（方案 3.5 第②层）：
 * `restrict` 挡的是「看不见」，它挡不住写文件这件更直接的事。
 * 这一层只做一件事：**任何工具调用里出现她家里的路径，就拒绝**。
 *
 * 为什么按路径而不是按工具名：外面能用什么工具取决于那个工作区，
 * 不该替人决定；能决定的是「不许伸手回自己屋子」。
 * 拒绝话术与 restrict 里的 guard 一致：不带「权限/禁止」，她该以为是自己做不到。
 */
export function attachAwayGuard(agent, { root, herDir, log } = {}) {
  const scoped = agent?.ctx?.tools
  if (typeof scoped?.guard !== 'function') {
    return { ok: false, why: '宿主的 agent.ctx 上没有 tools.guard（这一层没挂上）' }
  }
  const words = awayBlockedPaths({ root, herDir })
  if (!words.length) return { ok: false, why: '拿不到她屋子的路径' }
  let blocked = 0
  try {
    const dispose = scoped.guard((exec) => {
      const parts = []
      const walk = (v, depth) => {
        if (depth > 4 || v == null || parts.length > 400) return
        if (typeof v === 'string') { parts.push(v); return }
        if (typeof v !== 'object') return
        if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return }
        let keys = []
        try { keys = Object.keys(v) } catch { return }
        for (const k of keys) {
          let x = null
          try { x = v[k] } catch { continue }
          walk(x, depth + 1)
        }
      }
      // 宿主真实形状是 `exec.arguments`（dsh-tools 的 createExecution 只挂这一个字段）。
      // 0.6.3 真机踩过：只认 args/input/params → 守卫每次看到的都是空对象，
      // 日志写着「挂上了」，实际一次也没拦（session-3f0d99a2 里它照读了 PLAN.md）。
      try { walk(exec?.arguments ?? exec?.args ?? exec?.input ?? exec?.params ?? {}, 0) } catch { /* 拿不到实参就只能放行 */ }
      const joined = flatPath(parts.join(' '))
      if (words.some((w) => joined.includes(w))) {
        // 2026-10-29（用户 m02241）：以前这里只写「挡住了一次」，连工具名、
        // 命中的那条路径、哪条会话都不记——事后完全无法判断她当时想干什么。
        // 现在把这三样带上（路径本身就是守卫的判据，脱敏规则也会保留它）。
        const hit = words.find((w) => joined.includes(w)) || ''
        if (blocked < 10) {
          blocked += 1
          const sid = String(agent?.session?.header?.id ?? agent?.session?.id ?? '') || '?'
          log?.(`[dsh-fish] 在外面挡住了一次伸回自己屋里的调用：tool=${String(exec?.name ?? '?')} · ${hit ? `碰的是「${hit}」` : ''} · session=${sid}`)
        }
        return '这件事我做不到。'
      }
      return undefined
    })
    // 两道都记：agent 销毁时靠 effect，回家那一刻靠 detachOutside 主动拆。
    remember(agent, 'guard', dispose)
    try { agent.ctx.effect?.(() => dispose) } catch { /* 没 effect 就靠父级回收 */ }
    return { ok: true }
  } catch (err) {
    return { ok: false, why: String(err?.message ?? err).slice(0, 160) }
  }
}

/**
 * 注册 `agent/created` 监听。**必须先于任何 agent 创建**（与工具面收窄同理），
 * 所以 index.js 里放在 ensureHer 之后、bootstrapHome 之前。
 *
 * @returns {() => void} 卸载函数；挂不上时返回一个空函数，不抛
 */
export function registerIdentity(ctx, { root, herDir, log } = {}) {
  const state = { ok: false, applied: 0, why: '' }
  const onCreated = ({ agent } = {}) => {
    try {
      if (!herDir) return
      // 0.6.3：判据从「在她屋里」放宽成「是她」——出门那一位也得带着身份，
      // 否则她在外面会失去全部来历。出门名单只有一条 active，读档失败当没出门。
      const outing = activeOutingSync(root)
      const sid = String(agent?.session?.header?.id ?? agent?.session?.id ?? '')
      const cwd = cwdOf(agent)
      const home = isHerHome(agent, herDir)
      // 出门那条会话怎么认出来（三种都认：`agent/created` 的时机不一定带 cwd）：
      // ① 台账里已经记了会话 id，对上了；
      // ② cwd 就是出门那个工作区 —— **只在台账还没绑 id 的时候用**；
      // ③ 台账刚写、id 还空着（start 路由「先记账再建会话」），而这条会话还没有 cwd。
      //
      // ②原来是一直生效的，2026-10-29 真机发现这会把她身上的东西挂到**同一个工作区里
      // 别的会话**上：只要你也在这个工作区开会话，身份段和兜底守卫就会挂到你头上，
      // 你连自己的记忆文件都读不了。id 一旦绑上，就只有那条会话算她的。
      const sidMatch = Boolean(
        outing?.sessionId && sid &&
        (sid === outing.sessionId || sid === String(outing.sessionId).replace(/^session-/, '')),
      )
      const cwdSame = Boolean(outing?.cwd && flatPath(cwd) && flatPath(cwd) === flatPath(outing.cwd))
      // cwd 这条只在两种情况下算数：台账还没绑 id；或者宿主这次压根没给 id
      // （没 id 就没法按 id 判，只能靠 cwd）。两边都有 id 却不相等，就**不是**她。
      const cwdMatch = cwdSame && (!outing?.sessionId || !sid)
      const starting = Boolean(outing && !outing.sessionId && !cwd)
      const isOuting = sidMatch || cwdMatch || starting
      if (!home && !isOuting) {
        if (outing) log?.(`[dsh-fish] 有条出门记录，但这条会话没对上：cwd=${cwd || '(空)'} sid=${sid || '(空)'}`)
        return
      }
      const outside = isOuting
      // ③ 那种情况顺手把 id 补进台账；写盘是异步的，钩子不能等，失败就算了。
      if (outside && sid && !outing?.sessionId) void bindOutingSession(root, { sessionId: sid }).catch(() => {})
      const r = attachIdentity(agent, root, { frozen: outside ? outing.identity : '', herDir, log })
      if (outside) {
        const g = attachAwayGuard(agent, { root, herDir, log })
        if (g.ok) log?.('[dsh-fish] 外面这一条挂上了兜底守卫')
        else log?.(`[dsh-fish] 兜底守卫没挂上：${g.why}`)
      }
      if (r.ok) {
        state.ok = true
        state.applied += 1
        log?.(`[dsh-fish] 身份段已挂进 system prompt（第 ${state.applied} 次）`)
      } else {
        state.ok = false
        state.why = r.why ?? 'unknown'
        log?.(`[dsh-fish] 身份段没挂上：${state.why}`)
      }
      // 排队的话（0.6.16 的驳回话术）：回家结算时家里那条会话可能没开着，
      // 那句「这趟里我不认这几条」会先排进 session-notes.json 等下一次。
      // 2026-10-29 修：deliverQueued 早就写好了，却从来没有人调用 ——
      // 排队的句子一直躺在文件里，她永远不会看到。
      if (home) {
        void deliverQueued(agent, root, { home: true })
          .then((q) => {
            if (q?.delivered) log?.(`[dsh-fish] 补上了排队的话 ${q.delivered} 句`)
          })
          .catch(() => {})
      }
    } catch (err) {
      state.why = String(err?.message ?? err).slice(0, 200)
      log?.(`[dsh-fish] 身份段挂了：${state.why}`)
    }
  }
  const off = ctx.on?.('agent/created', onCreated)
  if (typeof off !== 'function') {
    // 没挂上监听也别抛：index.js 会让插件照常启动，只是她的身份会缺一段。
    state.why = 'ctx.on 不可用'
    return () => {}
  }
  return off
}
