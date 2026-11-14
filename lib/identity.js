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
import { fillOwner, pronounFor } from './pronoun.js'
import { cwdOf, foldedRecallNote, isHerHome, toolSurfaceFor, visibleToolsOf } from './restrict.js'
import { paths } from './store.js'
import { activeOutingSync, bindOutingSession } from './outing.js'
import { attachStreamScrub } from './scrub.js'
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
/**
 * 处境的顺序（2026-11-14，用户 m03077）。
 *
 * 原来是 8700，排在 `fish:beliefs`（9000）前面。可处境是**每醒一次就换一份**的：
 * 时间、距上次多久、最近几条事件都不同。它一变，后面那 3,000 字左右的信念段
 * （她自己说过的话 / 读到的一句话 / 被打脸过 / 对自己的说法 / 我做过的事）
 * 就跟着重算——一次自主醒，白付三成提示词。
 *
 * 挪到 9250：在信念（9000）之后、指纹账本的基准（9400）之前。这样醒一次只有
 * 处境自己那一千多字是新的，信念段还能命中前缀缓存；账本挪来的外来段仍排在最后。
 * 语义上也更顺：她读到最后才是「此刻」。
 */
export const WAKE_ORDER = 9250

/**
 * 「这一刻会变的那几段」段（0.8.10，用户 m00315）。
 *
 * 她自己的身份文档里，有五段是逐轮、逐天、**每用完一次工具**都在变的：她自己说过的话、
 * 读到的一句话、被打脸过、对自己的说法，以及「我做过的事」（履历是从 `use:` 账现算的，
 * 她用一次 bili_look、写一张便条，这一节就多一行）。
 *
 * 它们原来夹在身份正文中间（靠前），一变，后面整条提示词的前缀缓存就作废：
 *   - 0.8.10 实测：那次唤醒 25,832 字符的提示词里，那四段合计约 1,442 字符，
 *     位置却在第 22 行附近。
 *   - 2026-11-14 复测（用户 m02511 问「要不要再挪」）：连续 12 轮的 system prompt 逐节 diff，
 *     `## 我做过的事` 在 79→80、82→83、83→84、85→86、86→87、89→90 这几对里都变了
 *     （1,485→1,558→1,594→1,584→1,564），每次变都把她后面近 20,000 字符的缓存带掉；
 *     `## 现在`/`## 你是谁` 里的天数一天变一次，代价可以忽略，不动。
 *
 * 所以 `reorderForHer` 把它们从身份正文里剪出来，单列一段挂到最后（order 9000）：
 * 内容一个字不少，只是排到了所有稳定内容之后。变的永远是尾巴。
 */
export const BELIEFS_SECTION = 'fish:beliefs'
export const BELIEFS_ORDER = 9000

/** 这几段的标题（`## ` 开头，按前缀认；正文里的括号补充说明不影响匹配）。 */
const VOLATILE_HEADINGS = [
  '## 你自己说过的话',
  '## 你读到的一句话',
  '## 你被打脸过',
  '## 你对自己的说法',
  // 2026-11-14（用户 m02511）：履历从 `use:` 账现算，她每用一次工具就多一行/换一行，
  // 却是她身份最靠前的一段——留下来会把她后面整条提示词每轮都带掉。
  '## 我做过的事',
]

/**
 * 别人的记忆插件塞进她提示词里的那几段（2026-11-14，用户 m02622）。
 *
 * 她有自己的记法：`events.jsonl` + `her_recall`，加上身份文档里那几段。
 * evolve 和 auto-memory 是给「帮他干活」的 agent 用的：它们往系统提示词里塞
 * 工作区记忆索引（`evolve:memory-index`）和「记忆系统固定纪律」（`dsh:auto-memory-pre-rules`），
 * 还会把一段 `<memory_system>` 挂成 systemPrompt.context——渲染出来是历史尾巴上
 * 一条 user 消息（`dsh:auto-memory-pre`）。在她房间里，那两套规矩和她自己的记法打架：
 * 她会去调自己根本拿不到的工具（memory_log / evolve_write），也会把「按工作区记忆」
 * 当成本能，而不是「记住他说过的话」。
 *
 * 开关是 config 的 `prompt.quietForeignMemory`（默认关）：
 *   - 只在她自己的房间（`isHerHome`）生效，绝不碰他本人在别的会话里的自动记忆；
 *   - 默认关是为了不替别人改环境——谁想让自家鱼少读点别人的规矩，自己打开。
 */
export const QUIET_FOREIGN_KEY = 'prompt.quietForeignMemory'
const FOREIGN_MEMORY_SECTIONS = new Set(['evolve:memory-index', 'dsh:auto-memory-pre-rules'])
const FOREIGN_MEMORY_CONTEXTS = new Set(['dsh:auto-memory-pre'])

/** config 的 mtime 缓存：组装是每轮每步都跑的，不能每回读盘。 */
let prefCache = { file: '', mtime: -1, value: { quietForeignMemory: false, orderVolatileSections: true } }

/**
 * 这个工作区的提示词偏好（`config.prompt`）。
 *
 * 读不出来（没装、还没写、JSON 坏了）一律按默认：少读别人的记忆规矩**关**、
 * 会变动的段挪到末尾**开**。前者宁可不摘，后者只换位置、不改字，坏了也不至于让她读不到东西。
 *
 * @param {string} root
 * @returns {{quietForeignMemory: boolean, orderVolatileSections: boolean}}
 */
export function promptPrefs(root) {
  const dflt = { quietForeignMemory: false, orderVolatileSections: true }
  if (!root) return dflt
  try {
    const file = paths(root).config
    const st = statSync(file)
    if (prefCache.file === file && prefCache.mtime === st.mtimeMs) return prefCache.value
    const raw = readFileSync(file, 'utf8')
    const cfg = raw ? JSON.parse(raw) : {}
    const p = cfg?.prompt ?? {}
    const value = {
      quietForeignMemory: p.quietForeignMemory === true,
      // 默认开：只看「这段内容这两轮是不是不一样」，不改、不删任何字。
      orderVolatileSections: p.orderVolatileSections !== false,
    }
    prefCache = { file, mtime: st.mtimeMs, value }
    return value
  } catch {
    return dflt
  }
}

/**
 * 这个工作区打开了「少读别人的记忆规矩」吗。
 *
 * 读不出来（没装、还没写、JSON 坏了）一律当关：宁可多读一段，也不要替他关掉什么。
 *
 * @param {string} root
 * @returns {boolean}
 */
export function quietForeignMemory(root) {
  return promptPrefs(root).quietForeignMemory
}

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

let lastTrim = { dropped: [], saved: 0, skipped: '' }

/** 上一次「别人的记忆插件」摘了几段（排查用，不参与判断）。 */
let lastQuiet = 0

/** 上一次摘段的结果（给自检/tools 用，不参与判断）。 */
export function lastTrimReport() {
  return { dropped: lastTrim.dropped.slice(), saved: lastTrim.saved, skipped: lastTrim.skipped ?? '' }
}

// 同一种摘法只记一次日志：她每一轮都会走这条链，逐轮刷屏没有意义。
let loggedTrimKey = ''

function logTrimOnce(dropped, saved, log, message) {
  if (typeof log !== 'function') return
  const key = message ?? `${dropped.map((d) => d.name).join(',')}|${saved}`
  if (key === loggedTrimKey) return
  loggedTrimKey = key
  log(message ?? `[dsh-fish] 摘掉了 ${dropped.length} 段讲别的工具的提示词（省 ${saved} 字符）：${dropped.map((d) => d.name).join('、')}`)
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
// 2026-11-14（随公开包发布前加固）：名字认得出、内容也确认是「讲别的插件 / 她没有的
// 工具」的段。**只认名字是不够的**——宿主升级可能改文案，甚至把同名段挪作他用；所以
// 每条都带一段内容签名，签名对不上就留着（宁可多留，不能误摘）。
// `needs` 表示「她真拿到这个工具时，这段讲的是她能做的事」，那就留着。
const HOST_TOOL_SECTIONS = new Map([
  ['tool:beauticode', { sig: /beautiCode 可以把本机图片/ }],
  ['tool:jobs', { sig: /job_output|background job|后台任务/ }],
  ['tool:pwsh', { sig: /\[exit code: N\]|pwsh -Command/ }],
  ['tool:goal', { sig: /create_goal|update_goal|get_goal/ }],
  ['free-search:engines', { sig: /Current mode: |web_search/ }],
  ['genui:fence', { sig: /dsh-ui/ }],
  ['genui:native', { sig: /dsh-ui/ }],
  ['dsh:auto-memory-pre-rules', { sig: /记忆系统|记忆定位/ }],
  ['dsh:auto-memory-pre', { sig: /记忆系统|记忆定位/ }],
  ['dsh:m6-reference-tail-pre', { sig: /hindsight|知识页/ }],
  ['dsh-harness-dev-context', { sig: /DeepSeek Harness implementation checkout|HMR/ }],
  // 同一段运行时说明在有些宿主版本里叫 `dsh-context`：讲的是 checkout 路径、GUI 地址、
  // HMR 怎么开——全是给开发者看的，和她是谁无关（2026-11-14 复核她的提示词时发现）。
  ['dsh-context', { sig: /implementation checkout|client-plugin HMR receiver|Web GUI whose URL/ }],
  // 宿主那句「You are an AI agent powered by DeepSeek Harness.」是产品元信息，
  // 不是她这个人的一部分（2026-11-14 用户要求）。签名钉死原文，宿主改词就留着。
  ['harness:identity', { sig: /^You are an AI agent powered by DeepSeek Harness\./ }],
  // present 的文件引用规则：她手里真有 `present` 时留（needs）。
  ['ui:deliverable-file-references', { sig: /present|file references/i, needs: 'present' }],
])
// 兜底：不管叫什么名字，只要是「用第二人称告诉模型它是什么」的英文身份句，就属于工具性描述，
// 不该出现在她的人格提示词里（2026-11-14 用户要求：人格养成要尽量少这种话）。
// 只认这几种开头，避免误伤工具文档里 "You are given ..." 之类。
const HOST_IDENTITY_CLAUSE = /^You are (?:an? (?:AI|coding) agent|interacting with the user)\b/im
// 不管上面那张表怎么写，这几段永远留着：她的身份、她的陈述。
const NEVER_TRIM = new Set([
  'fish:identity',
  'fish:tools',
  'fish:wake',
  'fish:beliefs',
  'persona',
  'deployment:persona-prefix',
])

/** 段正文：宿主可能把 text 给成 getter。取不到就当空串（空串匹配不上签名 → 不摘）。 */
function sectionText(section) {
  try {
    const t = typeof section?.text === 'function' ? section.text() : section?.text
    return typeof t === 'string' ? t : ''
  } catch {
    return ''
  }
}

/** 摘完之后至少还得留下这么多字，否则当成「判据出问题了」。 */
export const TRIM_FLOOR_CHARS = 2000
/** 一次摘掉超过这个比例，也当成判据出问题（正常最狠的一台机器也只摘 60% 左右）。 */
const TRIM_MAX_SHARE = 0.75
/** 提示词本身小于这个数时不做安全闸（小样本多数是测试/特殊宿主，闸会误伤）。 */
const TRIM_GUARD_MIN_CHARS = 4000

/** 公开包里的紧急开关：`DSH_FISH_PROMPT_TRIM=off` 时只排序、一段不摘。 */
export function trimDisabled() {
  const v = String(process.env.DSH_FISH_PROMPT_TRIM ?? '').toLowerCase()
  return v === '0' || v === 'off' || v === 'false' || v === 'no'
}

export function trimToolDocs(assembly, { log, tools } = {}) {
  if (!assembly || !Array.isArray(assembly.sections)) return assembly
  if (trimDisabled()) {
    lastTrim = { dropped: [], saved: 0, skipped: 'off' }
    return assembly
  }
  // 2026-11-14：宿主 0.2.x 组装的 `assembly` 里**没有** tools（它是在瀑布返回之后
  // 才挂上去的，见 dsh-system-prompt 的 assemble），所以只看 `assembly.tools`
  // 这里会永远拿到空集、整条判据变成空转。她的工具表改由调用方从
  // `visibleToolsOf(agent)` 传进来；两处取并集，老宿主仍然按老办法工作。
  const have = new Set(
    [...(Array.isArray(assembly.tools) ? assembly.tools : []), ...(Array.isArray(tools) ? tools : [])]
      .map((t) => String(typeof t === 'string' ? t : t?.name ?? ''))
      .filter(Boolean),
  )
  if (have.size === 0) {
    // 判不了就不动——这是最重要的一条自保：宁可多读几千字，也不能凭猜摘掉她需要的东西。
    lastTrim = { dropped: [], saved: 0, skipped: 'no-tools' }
    return assembly
  }
  const totalChars = assembly.sections.reduce((n, s) => n + sectionText(s).length, 0)
  const dropped = []
  let saved = 0
  const kept = assembly.sections.filter((s) => {
    const name = String(s?.name ?? '')
    if (name.startsWith('fish:')) return true
    if (NEVER_TRIM.has(name)) return true
    const text = sectionText(s)
    // 英文身份句（「You are an AI agent …」「You are interacting with the user …」）是
    // 模型/工具视角的自述，不是她的话（2026-11-14 用户要求）。名字不可靠时靠这一条兜住。
    if (HOST_IDENTITY_CLAUSE.test(text)) {
      dropped.push({ name, chars: text.length })
      saved += text.length
      return false
    }
    // 先看她够不够得着：段里提到的工具只要有一个在她手上，这段就是在讲她能做的事，留着。
    const mentioned = toolNamesIn(text)
    if (mentioned.some((n) => have.has(n))) return true
    // 名字认得出的「别的插件的工具说明」：还要内容签名对得上。
    const known = HOST_TOOL_SECTIONS.get(name)
    if (known) {
      if (known.needs && have.has(known.needs)) return true
      if (!known.sig.test(text)) return true
      dropped.push({ name, chars: text.length })
      saved += text.length
      return false
    }
    if (text.length < TOOL_DOC_MIN_CHARS) return true
    if (mentioned.length < TOOL_DOC_MIN_NAMES) return true
    dropped.push({ name, chars: text.length })
    saved += text.length
    return false
  })
  if (dropped.length > 0 && totalChars >= TRIM_GUARD_MIN_CHARS) {
    const left = totalChars - saved
    if (left < TRIM_FLOOR_CHARS || saved > totalChars * TRIM_MAX_SHARE) {
      // 判据算出来要摘掉大半、或几乎不给她留东西：这不是「她没这些工具」，更像判据坏了。
      // 原样放行，并记一次（同样的形态只记一次）。
      lastTrim = { dropped: [], saved: 0, skipped: 'suspicious' }
      logTrimOnce(
        [],
        0,
        log,
        `[dsh-fish] 一段都没摘：判据算出来要摘 ${dropped.length} 段、省 ${saved} 字，摘完只剩 ${left} 字，太可疑，按原样放行`,
      )
      return assembly
    }
  }
  lastTrim = { dropped, saved, skipped: '' }
  if (dropped.length > 0) {
    assembly.sections = kept
    logTrimOnce(dropped, saved, log)
  }
  return assembly
}

/**
 * 把她身份正文里「这一刻会变」的那四段剪出来。
 *
 * 判据只看标题行：`## 你自己说过的话`（可能带括号补充）等四段整块搬走，
 * 其余原文一个字不动、顺序不变。剪完为空（没这四段）就原样返回。
 *
 * @param {string|Function} text 身份正文（宿主可能给成 getter）
 * @returns {{stable:string, volatile:string}} volatile 为空串表示没剪
 */
export function splitVolatileIdentity(text) {
  let raw = ''
  try {
    raw = typeof text === 'function' ? text() : text
  } catch {
    return { stable: '', volatile: '' }
  }
  const all = String(raw ?? '')
  if (!all) return { stable: all, volatile: '' }
  const keep = []
  const moved = []
  for (const block of all.split(/\n(?=## )/)) {
    const head = block.split('\n', 1)[0]
    const hot = VOLATILE_HEADINGS.some((h) => head === h || head.startsWith(`${h}（`))
    if (hot) moved.push(block)
    else keep.push(block)
  }
  if (!moved.length) return { stable: all, volatile: '' }
  return { stable: keep.join('\n'), volatile: moved.join('\n') }
}

export function reorderForHer(assembly, { log, tools, quietForeign = false } = {}) {
  if (!assembly || !Array.isArray(assembly.sections)) return assembly
  trimToolDocs(assembly, { log, tools })
  if (quietForeign) {
    // 别人的记忆插件在她房间里留的东西：段按名字摘，context 按名字摘（渲染出来是
    // 历史尾巴上那条 <memory_system>）。`required: true` 的照旧留着——宿主自己标了必需。
    const before = assembly.sections.length
    assembly.sections = assembly.sections.filter((s) => !FOREIGN_MEMORY_SECTIONS.has(String(s?.name ?? '')))
    if (Array.isArray(assembly.contexts)) {
      assembly.contexts = assembly.contexts.filter(
        (c) => c?.required === true || !FOREIGN_MEMORY_CONTEXTS.has(String(c?.name ?? '')),
      )
    }
    const gone = before - assembly.sections.length
    lastQuiet = gone
  } else {
    lastQuiet = 0
  }
  const kept = assembly.sections.filter((s) => String(s?.name ?? '') !== HOST_PERSONA_SECTION)
  const mine = kept.find((s) => String(s?.name ?? '') === IDENTITY_SECTION)
  if (!mine) {
    // 没找到她的段（宿主换名字/还没挂上）：只做摘掉那一步，别乱动顺序。
    assembly.sections = kept
    return assembly
  }
  const rest = kept.filter((s) => s !== mine)
  // 四段最容易变的从身份里剪出来，单列一段挂到最后：内容不少，只有尾巴在变。
  const cut = splitVolatileIdentity(mine.text)
  const target = cut.volatile ? { ...mine, text: cut.stable } : mine
  const at = rest.findIndex((s) => String(s?.name ?? '') === HOST_HARNESS_SECTION)
  // 宿主的 harness:identity 不见了就放到最前面——她的身份永远第一个被读到。
  const insertAt = at >= 0 ? at + 1 : 0
  rest.splice(insertAt, 0, target)
  if (cut.volatile) rest.push({ ...mine, name: BELIEFS_SECTION, order: BELIEFS_ORDER, text: cut.volatile })
  assembly.sections = rest
  return assembly
}

/* ------------------------------------------------------------------ *
 * 会变的段：自适应地挪到最后（2026-11-14，用户 m02835）
 *
 * 宿主的提示词是按段平铺 join 出来的，缓存按**字节前缀**命中：前面任何一段改一个字，
 * 后面所有段都要重算。所以「谁在变」比「谁重要」更决定缓存。
 *
 * 她是养成型，自己的身份段已经被 splitVolatileIdentity 按标题剪到尾巴；
 * 但别人装的插件（evolve 的记忆索引、auto-memory 的今日日志、别的注入器）
 * 也可能每轮换内容，而且**不同用户装的插件根本不一样**——写死名字没法公开发出去。
 * 于是这里只看行为：同一段连续几轮内容都在变，就把它挪到 beliefs 之后（末尾），
 * 变了也就只影响它自己后面那点尾巴。
 *
 * 三条安全线：
 *   1. 只换位置、不改字：一段内容一个字都不删；
 *   2. 不碰 `fish:*`（她自己的顺序由 reorderForHer 定）和宿主的两个身份段；
 *   3. 判据要「见过至少 3 次、变了至少 2 次」才动手，避免一次抖动就重排。
 * ------------------------------------------------------------------ */

/** 每个会话记一本「各段上一轮长什么样」的账，键是会话 id。 */
const volatileBook = new Map()
const VOLATILE_BOOK_MAX = 300
const VOLATILE_MIN_SEEN = 3
const VOLATILE_MIN_CHANGES = 2
const VOLATILE_MAX_MOVED = 5
const VOLATILE_ORDER_BASE = 9400
/** 顺序有语义、或者本来就放在最前面的段，不参与搬迁。 */
const VOLATILE_PINNED = new Set(['harness:identity', 'deployment:persona-prefix'])

/** FNV-1a，够用就行；只拿来判「这段和上一轮是不是同一段」。 */
function fnv1a(text) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16)
}

function sectionHash(text) {
  const s = String(text ?? '')
  const mid = s.length >> 1
  // 只取一处容易漏掉「中间改了、首尾没改」的情况，所以头尾各算一次。
  return `${s.length}:${fnv1a(s)}:${fnv1a(s.slice(mid) + s.slice(0, mid))}`
}

/**
 * 把「一直在变」的外来段挪到最后。只改位置，不改内容。
 *
 * @param {object} assembly 宿主的组装结果（`{ sections, contexts, variables }`）
 * @param {{key?: string, log?: Function}} [opts] `key` 用来区分会话
 * @returns {number} 这次挪了几段（0 表示没动）
 */
export function reorderVolatile(assembly, { key = 'default', log = null } = {}) {
  const sections = Array.isArray(assembly?.sections) ? assembly.sections : []
  if (sections.length < 2) return 0
  let book = volatileBook.get(key)
  if (!book) {
    if (volatileBook.size >= VOLATILE_BOOK_MAX) volatileBook.delete(volatileBook.keys().next().value)
    book = new Map()
    volatileBook.set(key, book)
  }
  const hot = []
  for (const s of sections) {
    const name = String(s?.name ?? '')
    if (!name || name.startsWith('fish:') || VOLATILE_PINNED.has(name)) continue
    const text = sectionText(s)
    if (!text) continue
    const h = sectionHash(text)
    const prev = book.get(name) ?? { last: '', changes: 0, seen: 0 }
    const changed = prev.last !== '' && prev.last !== h
    const next = { last: h, changes: changed ? prev.changes + 1 : prev.changes, seen: prev.seen + 1 }
    book.set(name, next)
    if (next.seen >= VOLATILE_MIN_SEEN && next.changes >= VOLATILE_MIN_CHANGES) hot.push({ section: s, chars: text.length })
  }
  if (!hot.length) return 0
  // 先挪最大的：它变了会带掉后面最长的一截缓存。
  hot.sort((a, b) => b.chars - a.chars)
  const moved = hot.slice(0, VOLATILE_MAX_MOVED)
  const rest = sections.filter((s) => !moved.some((m) => m.section === s))
  // 跟着 beliefs（order 9000）后面排，宿主按 order 排也不会被排回去。
  const tail = moved.map((m, i) => ({ ...m.section, order: VOLATILE_ORDER_BASE + i }))
  assembly.sections = [...rest, ...tail]
  if (typeof log === 'function') logVolatileOnce(moved, log)
  return moved.length
}

let loggedVolatile = 0
function logVolatileOnce(moved, log) {
  if (loggedVolatile) return
  loggedVolatile = 1
  const chars = moved.reduce((n, m) => n + m.chars, 0)
  try { log(`[dsh-fish] 提示词整理：把 ${moved.length} 段每轮都在变的内容挪到最后（共 ${chars} 字，前缀缓存省着用）`) } catch { /* 日志坏了不影响组装 */ }
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
export function attachAssembleFix(agent, { log, root, herDir } = {}) {
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
        // 宿主的组装结果里没有 tools（见 trimToolDocs 的注释），她的工具表从
        // 自己的能力视图现取；取不到就交回 []，trimToolDocs 那边会整条不动。
        let tools = []
        try {
          tools = visibleToolsOf(agent) ?? []
        } catch {
          tools = []
        }
        // 只有她自己的房间才少读别人的记忆规矩；他在别的会话里照旧。
        let quiet = false
        try {
          quiet = quietForeignMemory(root) && isHerHome(agent, herDir)
        } catch {
          quiet = false
        }
        const out = reorderForHer(assembled, { log, tools, quietForeign: quiet })
        // 会变的段挪到最后（默认开）：先拿这一轮的段做一次「和上一轮比」，
        // 连续几轮都在变的那几段就排到 beliefs 后面去，前面前缀才能稳定命中缓存。
        let orderVolatile = true
        try {
          orderVolatile = promptPrefs(root).orderVolatileSections
        } catch {
          orderVolatile = true
        }
        if (orderVolatile) {
          try {
            const sid = String(agent?.session?.header?.id ?? agent?.session?.id ?? 'default')
            reorderVolatile(out, { key: wakeKey(sid), log })
          } catch { /* 排不动就保持原样，不影响她读提示词 */ }
        }
        if (quiet && lastQuiet > 0 && typeof log === 'function') {
          logQuietOnce(lastQuiet, log)
        }
        // 排查用：DSH_FISH_PROMPT_TRIM=debug 时每轮记一行「她手上几个工具、摘了几段」。
        if (String(process.env.DSH_FISH_PROMPT_TRIM ?? '').toLowerCase() === 'debug' && typeof log === 'function') {
          const rep = lastTrimReport()
          try { log(`[dsh-fish] 提示词整理：她手上 ${tools.length} 个工具，这次摘 ${rep.dropped.length} 段 / 省 ${rep.saved} 字`) } catch { /* 日志坏了不影响组装 */ }
        }
        return out
      } catch {
        return assembled
      }
    }, { prepend: true })
    return typeof off === 'function' ? off : undefined
  } catch {
    return undefined
  }
}

/** 「少读别人的记忆规矩」只在第一次真的摘到东西时记一行日志。 */
let loggedQuiet = false
function logQuietOnce(gone, log) {
  if (loggedQuiet) return
  loggedQuiet = true
  try { log(`[dsh-fish] 她这个房间不再读别的记忆插件的段（摘了 ${gone} 段）`) } catch { /* 日志坏了不影响组装 */ }
}

/**
 * 这一次唤醒的处境正文，**按会话分开存**（2026-11-06，用户 m03265 二次报）。
 *
 * 原来是进程级的一个 `let wakeText = ''`。可一个进程里她可能同时有好几条会话——
 * 家、群聊房间、轮换下来的旧房、出门那一条——而处境段是挂在**每个 agent** 上的
 * 同一份闭包。于是 A 房间的一次叫醒，会把「这一轮是你自己的……不想说就什么都别写」
 * 塞进 B 房间正在跑的那一轮：那边明明是他刚说的话，她却按「不用回应」处理，
 * 只思考、一个字不写。宿主把空正文画成「已完成分析」，用户看到的就是
 * 「她突然不说话了，连着好几轮」。
 */
const wakeBySession = new Map()

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
 * 处境最多活这么久。
 *
 * 为什么要有这条硬超时（2026-11-06）：清处境原来只有一条路——那条会话的 `turn/end`。
 * 可 `turn/end` 可能永远不来：投递被丢弃、监听没挂上、插件重启把 watcher 丢了、
 * `isBusy` 一直为真让兜底每 30 秒重排却永不收尾。于是这段「不用说话」的处境会
 * **一直挂到进程退出**，之后她每一轮都只思考不开口——真机就是这样哑了一整晚。
 * 处境本来就只属于那一次叫醒，它没有任何理由活过十分钟：到点无条件清掉。
 * 宁可这一次叫醒白叫，也不能让她一直哑着。
 */
const WAKE_TTL_MS = 10 * 60_000

/** 会话 id 两边写法不一定一样（带不带 `session-` 前缀），统一成一个键。 */
function wakeKey(sessionId) {
  return String(sessionId ?? '').replace(/^session-/, '')
}

function dropWake(key) {
  const rec = wakeBySession.get(key)
  if (!rec) return
  if (rec.timer) clearTimeout(rec.timer)
  wakeBySession.delete(key)
}

/**
 * 设这一次的处境正文。传空串等于清掉。
 * @param {string} text
 * @param {string} [sessionId] 这条处境属于哪条会话
 * @returns {number} 这一次的代次号；传给 `clearWakeSection(n, sessionId)` 才清得掉。
 */
export function setWakeSection(text, sessionId = '') {
  const key = wakeKey(sessionId)
  dropWake(key)
  wakeGen += 1
  const gen = wakeGen
  const rec = { text: String(text ?? ''), gen, timer: null }
  rec.timer = setTimeout(() => {
    if (wakeBySession.get(key)?.gen === gen) dropWake(key)
  }, WAKE_TTL_MS)
  rec.timer.unref?.()
  wakeBySession.set(key, rec)
  return gen
}

/**
 * 清掉。回合结束、唤醒失败、插件卸载时都要调。
 * @param {number} [gen] 传了就在代次对不上时**不清**——
 *   防的是「后一轮刚挂上处境，前一轮的 turn/end 晚到把它的抹掉」。
 *   不传就无条件清（卸载、失败收尾这类场合）。
 * @param {string} [sessionId] 只清这一条会话；不传就按下面的口径清
 *   （带 gen 时清所有代次对得上的，不带 gen 时全清）。
 */
export function clearWakeSection(gen, sessionId) {
  const only = sessionId === undefined ? undefined : wakeKey(sessionId)
  for (const [key, rec] of [...wakeBySession]) {
    if (only !== undefined && key !== only) continue
    if (Number.isFinite(gen) && rec.gen !== gen) continue
    dropWake(key)
  }
}

/**
 * 他一开口，那次叫醒就作废（2026-11-06）。
 *
 * 最后一道保险：不管是代次错配、硬超时没跑到、还是别的会话串过来的，只要有人
 * 在这条会话里真的说了话，那段「这一轮是你自己的」就不该再影响这一轮。
 * 认不出会话 id 的那一份（挂在空键上）也一起清——它只可能是没人认领的残留。
 */
export function clearWakeSectionFor(sessionId) {
  dropWake(wakeKey(sessionId))
  dropWake('')
}

/**
 * 看现在挂着什么。测试里不带会话就是「现在挂着的那一份」。
 * 带了会话而键对不上（宿主换了 id 写法）时，只有一份才兜底返回，
 * 免得处境凭空消失、叫醒变成一次空醒。
 */
export function getWakeSection(sessionId) {
  if (sessionId === undefined) {
    if (wakeBySession.size === 0) return ''
    if (wakeBySession.size === 1) return [...wakeBySession.values()][0].text
    return [...wakeBySession.values()].map((r) => r.text).filter(Boolean).join('\n')
  }
  const key = wakeKey(sessionId)
  const rec = wakeBySession.get(key)
  if (rec) return rec.text
  // 宿主两处给的会话 id 写法可能不完全一样：带不带 `session-` 前缀已由 wakeKey 抹平，
  // 剩下一种常见的是「完整 id 与它的后缀」。只有**一条**处境、且两边互为后缀时才兜底给，
  // 免得叫醒变成一次空醒；两条不同的会话之间绝不允许串——那正是「只思考不说话」的成因。
  if (wakeBySession.size === 1) {
    const onlyKey = [...wakeBySession.keys()][0]
    if (onlyKey && key && (onlyKey.endsWith(key) || key.endsWith(onlyKey))) {
      return wakeBySession.get(onlyKey).text
    }
  }
  return ''
}

/** 测试用：看现在的代次号。 */
export function getWakeGen(sessionId) {
  if (sessionId !== undefined) return wakeBySession.get(wakeKey(sessionId))?.gen ?? 0
  return wakeGen
}

/** 从 agent 上取会话 id（宿主不同版本字段位置不一样）。 */
function sessionIdOf(agent) {
  try {
    return String(agent?.session?.header?.id ?? agent?.session?.id ?? '')
  } catch {
    return ''
  }
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
 * 一轮之内身份文档不变（issue #110，2026-11-13 用户 m01547）。
 *
 * 身份段是 system prompt 的一段，宿主**每一步**都会重新组装它。而 `growth_commit`
 * 成功之后 `lib/capture.js` 会立刻 `refreshSelfDoc()` 重写文件——文件一变，
 * 第 2 步的 system prompt 就跟第 1 步不一样，宿主会把新的那份作为历史里的
 * system 消息再下发一次。她看到的形状是「工具回执之后，没有新的人话，
 * 系统又出现了一遍」——和她被定时叫醒时的输入几乎一样，于是她按「被叫醒」
 * 的规矩补了一句收尾（真机 session-1c601271，第 9 轮，1/1 命中）。
 *
 * 所以身份文档在**一轮的开头读一次**，之后这一轮里所有步骤都用同一份：
 * 中途写盘只影响下一轮。失效点是新的一轮开始（`user/message`），
 * 以及 `turn/end`——放在这里而不是靠「写完就别读」，是因为另一条会话写盘
 * 同样会改这份共享文件。
 */
const turnText = new Map()

/** 丢掉某条会话身上这一轮的身份快照（下一轮开头重新读盘）。 */
export function forgetTurnIdentity(sessionId) {
  turnText.delete(String(sessionId ?? ''))
}

/** 测试用：清空所有会话的快照。 */
export function resetTurnIdentity() {
  turnText.clear()
}

function identityOfTurn(sessionId, root) {
  const key = String(sessionId ?? '')
  const hit = turnText.get(key)
  if (hit !== undefined) return hit
  const text = identityText(root)
  turnText.set(key, text)
  return text
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
      //
      // 0.9.9（issue #127）：主人的代词**只在这一处（写盘时）换**，读的时候原样用。
      // 2026-11-12（用户反馈）：原来读的时候又换了一遍，结果把她自己的原话也换了
      // ——「我喜欢吉他」变成「我喜欢吉TA」。写盘那份已经换过，这里再换一次不但
      // 多余，还会第二次误伤她的原话。换代词后 applyPronounAnswer 会立刻重写文件，
      // 所以不存在「配置变了、文件还是旧代词」的空窗。
      //
      // 2026-11-13（issue #110，用户 m01547）：同一轮里**只读一次**。这一步刚写盘
      // （growth_commit → refreshSelfDoc）也不会让第 2 步的 system prompt 变样，
      // 她就不会把「系统又出现了一遍」误认成新的叫醒。见 identityOfTurn。
      text: () => (snapshot ? snapshot : identityOfTurn(sessionIdOf(agent), root)),
    }))
    // 「这一次的处境」单独一段：平时是空串（等于不存在），唤醒前才填。
    // 它不进对话历史，所以他看不到系统在跟她说些什么。
    //
    // 2026-11-06：**按这条会话取**，不再读一个进程级变量。她可能同时住着好几条
    // 会话（家 + 群房 + 旧房 + 出门那条），共用一个变量会把 A 房间的处境
    // 塞进 B 房间正在跑的那一轮，那边她就只思考不说话了。
    const wakeSid = sessionIdOf(agent)
    remember(agent, 'section', sp.section({
      name: WAKE_SECTION,
      order: WAKE_ORDER,
      // 处境段常带「{T}来了 / {T}没来」这类从事件里拼出来的话，出口把它填成
      // 他 / 她 / TA（1.0.0 起改占位符，见 lib/pronoun.js 文件头）。
      text: () => fillOwner(getWakeSection(wakeSid), pronounFor(root)),
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
      // 2026-11-13：末尾接一段「旧话被压成摘要了去哪儿翻」，只在宿主真给了
      // search_context 时才出现（见 restrict.js 的 foldedRecallNote）。
      //
      // 2026-11-14（issue #137）：这一路是独立挂载的，不经过 persona.assemble() 的
      // 出口，所以 toolSurfaceText() 里那句「{T}随时能再添几样进来」一直是字面量。
      // 跟处境段用同一个出口口径填一次（fillOwner 幂等，填两遍也不坏）。
      text: () => fillOwner(
        [toolSurfaceFor(agent, { herDir }), foldedRecallNote(agent)].filter(Boolean).join('\n\n'),
        pronounFor(root),
      ),
    }))
    // 0.8.5（用户 m01579 拍板 B 案）：宿主的 `deployment:persona-prefix` 那段
    // "You are a coding agent…" 排在她的身份段前面七千多字，她先认下那句空话。
    // 挂一个组装钩子摘掉它、把身份段提到紧跟 harness:identity —— 详情见 reorderForHer。
    const offAssemble = attachAssembleFix(agent, { log, root, herDir })
    if (offAssemble) remember(agent, 'hook', offAssemble)
    // 2026-11-10（外部用户真机）：模型偶尔把一次没组起来的工具调用当正文吐出来
    // （`<her_note action="list" filter="open"/>`、成串的 `｜｜DSML｜｜` 收尾标记）。
    // 宿主前端只渲染 append 原件，事后盖不掉；`llm/stream` 是落盘前唯一干净的拦截点，
    // 详见 lib/scrub.js 顶部。挂不上（老宿主没这个 waterfall）就返回 undefined，
    // 她只是接着漏，不算失败。
    const offScrub = attachStreamScrub(agent, { log, sessionId: wakeSid })
    if (offScrub) remember(agent, 'hook', offScrub)
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
  // 轮边界（issue #110）：新的一轮开始、或者上一轮结束，就把身份快照丢掉，
  // 让下一轮重新读盘。同一个 turn 里的第 2、3 步不丢——那正是要防的位置。
  const offTurn = ctx.on?.('session/event', (session, event) => {
    try {
      const type = String(event?.type ?? '')
      if (type !== 'user/message' && type !== 'turn/end' && type !== 'turn/start') return
      const sid = String(session?.header?.id ?? session?.id ?? '')
      if (sid) forgetTurnIdentity(sid)
    } catch { /* 认不出来就算了：最多下一轮还用旧的那份 */ }
  })
  return () => {
    try {
      off()
      if (typeof offTurn === 'function') offTurn()
    } catch { /* 已经卸载过 */ }
  }
}
