/**
 * turns.js —— 侧栏里直接跟她说话，也算一轮（issue #6，2026-10-28）
 *
 * 症状（github:ssamurias/dsh-fish#6）：
 *   在侧栏她的会话里直接打字聊天，【turns】永远不动，`chat.rotateAfter`
 *   因此永不触发——上下文一路涨到撑爆，而"聊满 N 轮换会话"这个约定形同虚设。
 *
 * 根因：`bumpTurns()` 只有一个调用点，在 `/say` 路由里（lib/say.js）。
 *       那条路是"观测台/IM 替主人递话"；用户在侧栏亲自打的字根本不经过它。
 *
 * 做法：不新开通道，只补一个**观察者**——监听宿主 `session/event`，认准
 *       "她住的那个会话"，收到一条真人打的 user 消息就记下来，等这一轮
 *       `turn/end` 再结账：
 *         1. turns + 1（home.json，观测台读的就是它）
 *         2. talkmem 记一轮原话（换会话时搬过去的那几句）
 *         3. 到 rotateAfter 就换会话，和 /say 走同一套 rotateTalkSession
 *
 * 为什么必须先认来源（真机会话事件里几种都出现过）：
 *   - 人打的       source = { kind:'user', rpcId:<uuid>, clientTimeZone:'Asia/Shanghai' }
 *   - 我们 prompt 的 source.kind 也是 'user'，rpcId 带 wake-/say- 前缀、**没有** clientTimeZone
 *   - 桥注入的     source = { kind:'user', rpcId:'wechat-<uuid>' }，也可能没有 clientTimeZone
 *   - 宿主拼的上下文 kind = 'runtime-context' / 'skill-catalog' / 'plugin:xxx'
 * 认错任何一种都会让轮数失真：把唤醒当人说话 → 每晚白涨一轮；
 * 把上下文当人说话 → 一轮涨好几次，rotateAfter 提前触发，她频繁失忆。
 *
 * 2026-11-08（用户转来的微信桥反馈）：宿主 `sessionController.prompt()` **写死**
 * `source.kind = 'user'`，调用方只能给 requestId（落成 rpcId）和可选的
 * clientTimeZone，传不进 source（`dsh-api-session-controller/lib/index.js` 的 prompt）。
 * 微信桥/dsh-im-connect 都没传时区，于是桥来的话全掉进 unknown：不涨轮、不写
 * heard、不算他来过。现在把「带 rpcId」也认作人；我们自己的 prompt 都带
 * PLUGIN_RPC 前缀，先被挡掉，没有 rpcId 的 append（交接句/便条）仍留在 unknown。
 *
 * 2026-11-03（github:ssamurias/dsh-fish#18）第四种来源：**外渠道注入**。
 * QQ 桥（dsh-qq-link）之类注入的消息 source = { kind:'qq' }，原来被第一个
 * `src.kind !== 'user'` 直接判成 context，连总线那一关都过不去——于是 turns 恒为 1、
 * `heard` 只有一条、「他来过」永远不写、冷落检测到点就误记一条「他有 N 天没出现」。
 *
 * 判据改成**机器侧黑名单**（MACHINE_KINDS）而不是人工白名单穷举：
 * 宿主的 v4 校验只要求 source.kind 是「非空、且不等于 'plugin'」的 producer-owned
 * 字符串（见 proactive.js 里 assertV4MessageSources 那段注释），所以外渠道的 kind
 * 是开放集合，任何桥都可以自己起名（qq / telegram / 别的）。认识的那几种挡掉，
 * 宿主拼的上下文按 source.form 挡掉（MACHINE_FORMS），其余一律当人——
 * 宁可多算一轮也不静默丢消息。
 *
 * 铁律：这里**基本只读**会话事件、只写 home.json / talk-recent.json / 一条 meta，
 * 不动对话本身。任何失败都吞掉——记账出错不能连累她说话。
 *
 * 2026-11-02（用户 m00680）唯一的例外：她这一轮在侧栏里说出口的原话，会以
 * `utterance` + `flags:['uncommitted']` 补写进事件流。理由见 settle() 里那段注释——
 * 拒绝判定读的是事件流里的 utterance，而侧栏聊天原本一条都不落盘。
 * 打了 uncommitted 的句子只留证，不算信念（derive.js 里与 selfmod 同一处理）。
 */

import { rootDir, readEvents, readState, appendEvent } from './store.js'
import { loadConfig, dateKey } from './settings.js'
import { parseWatchIntent } from './intent.js'
import { homeStatus, bumpTurns, rotateTalkSession, adoptTalkSession } from './home.js'
import { addExchange, amendLastExchange } from './talkmem.js'
import { newHerEventsSince } from './inbox.js'
import { HER_TYPES, normalizeScene } from './schema.js'
import { refreshSelfDoc } from './selfdoc.js'
import { growthDay, stageOf } from './derive.js'
import { hearTurn, rememberGroupWord } from './hear.js'
import { stripToolMarkup, hasToolMarkup } from './markup.js'
import { stripTranscriptTail } from './transcript.js'
import { clearWakeSectionFor } from './identity.js'
import { isChannelSession } from './channels.js'

/**
 * 我们自己 prompt 进去的消息，rpcId 会带这些前缀。
 *
 * 这些消息走宿主的 `sessionController.prompt()`，宿主把 kind 写死成 'user'；
 * rpcId 是它们唯一的记号（见 classifyMessage）。名单漏一个，那条消息就会：
 * 在日志里多一行「认不出来源」；如果它来自别的会话，还会被当成「他来过」。
 *
 * `carry` 是换会话前请她留话那条（home.js 的 `carry-ask-`，2026-11-06）。
 * `outing` 是出门首轮（observe.js 的 `outing-<sessionId>-`，2026-11-08）。
 */
const PLUGIN_RPC = /^(wake|say|boot|report|letter|sleep|nudge|probe|turn|sys|carry|outing)[-_]/i

/**
 * 桥登记来源（2026-11-09，issue #96）。
 *
 * 走宿主 `prompt()` 的桥没法把 `scene` 写进 `source`——`prompt()` 的 source 由
 * 宿主填，桥只能定 requestId。于是群聊、群友私聊、桥自己发起的定时提醒全都
 * 长成 `{ kind:'user', rpcId }`，被当成「他本人在说话」。
 *
 * 约定：桥在调 `prompt()` **之前**先发一条 `dsh-fish/source`：
 *   { rpcId, scene:'group'|'private'|'desk', owner:true, guest:true, machine:true }
 *
 * 这里按 rpcId 存一份短命表（5 分钟、最多 200 条），`classifyMessage` 先查它。
 * 不发的桥保持老行为（带 rpcId 的当人），不倒退。
 */
const SOURCE_TTL_MS = 5 * 60_000
const SOURCE_MAX = 200
const declaredSources = new Map()

/** 记下一条 rpcId 的来历。同步、永不抛；返回是否记住了。 */
export function declareSource(o = {}) {
  try {
    const rpcId = String(o?.rpcId ?? '').trim()
    if (!rpcId || rpcId.length > 200) return false
    const now = Date.now()
    for (const [k, v] of declaredSources) if (now - v.at > SOURCE_TTL_MS) declaredSources.delete(k)
    const scene = normalizeScene(o?.scene)
    declaredSources.set(rpcId, {
      scene: scene === 'group' || scene === 'private' ? scene : '',
      owner: o?.owner === true,
      guest: o?.guest === true,
      machine: o?.machine === true,
      at: now,
    })
    if (declaredSources.size > SOURCE_MAX) {
      declaredSources.delete(declaredSources.keys().next().value)
    }
    return true
  } catch {
    return false
  }
}

function declaredFor(rpcId) {
  const hit = declaredSources.get(rpcId)
  if (!hit) return null
  if (Date.now() - hit.at > SOURCE_TTL_MS) {
    declaredSources.delete(rpcId)
    return null
  }
  return hit
}

/** 只给测试用：清空登记表。 */
export function clearDeclaredSources() {
  declaredSources.clear()
}

/**
 * 宿主/我们这边自己拼的、**确定不是人打的** source.kind。
 *
 * 这张表是黑名单，不是白名单：宿主的 v4 校验不限制 kind 取值（只要非空、
 * 不等于 'plugin'），外渠道的 kind 因此是开放集合，穷举不了。表里没有的
 * 一律当人（见 classifyMessage 末尾）——issue #18 就是被"只认 user"卡死的。
 *
 * 加新条目前先想清楚：这一个 kind 会不会在**人真的说话**时出现？
 * 会，就别加——加了等于把人话静默丢掉，这正是 #18 的病灶。
 */
const MACHINE_KINDS = new Set([
  'runtime-context', // 宿主每轮拼进去的运行上下文
  'skill-catalog', // 技能清单
  'schedule', // 定时消息（schedule.test.mjs 钉着）
  'system', // 系统提示/系统插入
  'system-prompt',
  'tool', // 工具结果回灌
  'plugin', // 插件自己发的（v4 校验禁用它当消息来源，这里再兜一层）
  'assistant', // 她自己说的话，不该反过来算他来过
  // 2026-11-04（用户 m00428）：我们自己叫醒她用的来源（lib/deliver.js）。
  // 宿主的 sc.prompt() 会把这个 kind 写死成 'user'，那条只能落成用户气泡；
  // 改走 agent.followup() 之后来源由自己填，前端画成收起的折叠条。
  // 漏了这一行，她自己醒来说的话就会被记成「他来过」——冷落天数、seen、
  // turns 全被污染，她越主动，面板越显示「他刚来过」。
  'fish-wake',
  // 2026-11-05：宿主自己写进会话、又不带 source.form 的几种（带 form 的见 MACHINE_FORMS）。
  // 都是 role:'user' 的系统消息，人说话时不会用这些 kind。
  // 名单对照的是宿主 0.2.2-rc.1 的 MessageSourceMap（dsh-api-session-controller）。
  'working-directory', // 工作目录变了
  'cordis-host-runner', // 插件运行器的转告
  'ptc-mode', // 工具执行模式提示
  'user-approval', // 审批策略变了
  'compact-checkpoint', // 压缩检查点
  'goal', // /goal 的目标
  'team-message', // 队友之间的话
  'agent-message', // 子代理、队友之间转的话（form 是 relay，见下）
  // dsh-bili-humanism 给模型排的提示词（手账存完后的提问、人格审阅）。
  // 它们不是 plugin: 前缀，所以要单列，否则写一篇手账就多一条「他来过」。
  'bili-humanism-post-viewing-question',
  'bili-humanism-personality-review',
  'bili-humanism-shadow-review',
])

/**
 * 宿主拼上下文时写在 source.form 上的形态（宿主前端的 KNOWN_FORMS）。
 *
 * 宿主给模型看的上下文（time-context、model-selection、tool-jobs、plan-mode、
 * action-cards、agent-instructions、session-reference、tmux 快照……）kind 各不相同，
 * 以后还会有新的，靠列 kind 总会漏；它们的共同点是都带这个字段。
 * 漏一个的后果很重：time-context 最多十分钟一条，每条都是一次「他来过」、
 * 一次 turns +1、一条写在他名下的 heard，满 rotateAfter 换房。
 *
 * relay 故意不在表里：外渠道转述人说的话，也可能自称 relay，那种要算人。
 * 所以桥不要用这个表里的 form，用了就会被当上下文（AGENTS.md §7.2）。
 */
const MACHINE_FORMS = new Set(['snapshot', 'notice', 'catalog', 'instructions', 'recall'])

/**
 * 宿主客户端里他亲手点出来、但 kind 不是 'user' 的两种消息（0.2.2-rc.2）：
 *   - 'retry'：一轮失败后点「继续」。sessionController.prompt() 收到空 content 时
 *     把来源写成 retry（正文是空的，rpcId 照带，clientTimeZone 可有可无）。
 *   - 'user-question-reply'：答了一张 ask_user_question 的问题卡。来源只有
 *     kind / callId / outcome，没有 rpcId，也没有时区。
 *
 * 两种在 classifyMessage 里都落到末尾的 'human'——在她自己的房间里这没错，
 * 是他真的动了手。但它们和桌面打字一样，哪条会话里都会出现；别的会话里的
 * 不该替她记「他来过」（见 onHuman 的 fromDeskClient）。
 */
const HOST_CLIENT_KINDS = new Set(['retry', 'user-question-reply'])

/** 一条 user 消息最多记这么多字（talkmem 会再截到 160，这里只是别让整段注入进内存） */
export const TURN_TEXT_MAX = 2000
/** 一轮里连着打好几句时，最多合并这么多条 */
const TURN_MSGS_MAX = 5

/**
 * 轮换之后「屋子认回旧会话」的时间窗（2026-11-10，用户反馈：满 40 轮换会话，
 * 有时候又落回旧的老会话，像是「旧会话没被用满」）。
 *
 * 原来只要 `home.json` 的 `rotatedFrom` 还是这条会话就无条件认回，而它会一直
 * 留到下一次轮换。于是几天后他翻回侧栏那条「…之前」说一句，屋子就搬回去了，
 * 而 `turns` 还是新会话的 0——那条已经满 40 轮的会话又拿到一整段预算，
 * 上下文继续往上涨。
 *
 * 现在只认两种「真的卡在换房那一刻」：
 *   - 新会话一轮都没跑过（叫醒没落地，他只能还在旧窗口里说话）；
 *   - 换房还没超过 10 分钟（人正卡在那一刻，还在旧窗口里接着打）。
 * 其余情况只记「他来过」，不搬屋子。
 */
const ADOPT_WINDOW_MS = 10 * 60_000

/**
 * 这条 user 消息是谁写的？
 *
 * 2026-11-03（issue #18）改成「机器黑名单」：认得的机器 kind 挡掉，其余当人。
 * 原来第一句是 `if (src.kind !== 'user') return 'context'`，外渠道（qq 之类）
 * 一律被静默降级成 context，一整条链路（turns / talkmem / heard / seen）全断。
 *
 * 为什么 kind='user' 不再一律要求 clientTimeZone（2026-11-08）：
 * 宿主 `sessionController.prompt()` 给每条请求都写 rpcId，并把来源硬写成
 * kind:'user'；桥接插件只能走这个入口，传不进 source。要求时区等于要求每个桥
 * 都记得一个「可选」字段，忘了就静默不算他来过。
 * 现在「有 rpcId」也认作人：我们自己的 prompt 都带 PLUGIN_RPC 前缀，先被上面
 * 那条挡掉；possess.js 的交接句和 sessionnote.js 的便条直接 append，没有 rpcId，
 * 仍留在 unknown。
 *
 * 2026-11-03（一条鱼多间房）多一档 'group'：外渠道可以在 source.scene 里
 * 声明这是群聊。群聊里的话不是他来找过她，总线那一层直接丢掉，不写 seen、
 * 不涨轮数——否则群一热闹，冷落检测就永远不触发。
 *
 * 2026-11-08（用户 m00394）再分一档 'group-owner'：桥可以在 source 里标
 * `owner:true`，说明**这条是主人本人说的**（桥按 QQ 号判，插件不猜昵称）。
 * 群里他的话要进记忆，但边界不挪——仍然不算他来找过她。所以单独一档，
 * 只写一条 heard，不碰 seen / 轮数 / 交接。
 *
 * @returns {'human'|'group'|'group-owner'|'plugin'|'context'|'unknown'}
 */
/**
 * 群聊里他自己说的那句：只写一条 `heard`（scene:group），永不抛。
 *
 * day/stage 从 state.json 取：群聊不进轮数、不结账，没有现成的 model 可借；
 * state 是派生品，读它不会造成真相源分叉（读不到就用 0/1，和系统侧写别的
 * 事件时的兜底一致）。
 */
async function rememberOwnerGroupLine(root, sessionId, text) {
  const body = String(text ?? '').trim()
  if (!body) return { written: false, why: 'empty' }
  try {
    const st = await readState(root).catch(() => null)
    return await rememberGroupWord(root, {
      text: body,
      sessionId,
      day: Number(st?.day ?? 0),
      stage: Number(st?.stage ?? 1),
    })
  } catch {
    return { written: false, why: 'failed' }
  }
}

export function classifyMessage(data) {
  const src = data?.source
  if (!src || typeof src !== 'object') return 'context'
  const kind = String(src.kind ?? '')
  if (!kind) return 'context'
  // 2026-11-03（一条鱼多间房）：外渠道可以自己声明这条是群聊。
  // 群聊里的话**不是他来找过她**——群里一天几百句，要是每条都算，
  // 冷落检测就永远不会触发。所以先于 kind 判定，直接归到 'group'。
  // 桥注入时把 scene 写进 source 即可（AGENTS.md §7）；不写就等于私聊。
  if (normalizeScene(src.scene) === 'group') {
    return src.owner === true && src.guest !== true ? 'group-owner' : 'group'
  }
  // 外客不必非得写在群聊里：桥能写 source 时，{ scene:'private', guest:true }
  // 也是群友私聊（2026-11-09，issue #96）。/say 一直认这个字段，这里对齐。
  if (src.guest === true) return 'group'
  // 宿主拼的上下文 / 定时消息 / 工具回灌 / 她自己说的话：都不是他
  if (MACHINE_KINDS.has(kind) || kind.startsWith('plugin:')) return 'context'
  if (MACHINE_FORMS.has(src.form)) return 'context'
  const rid = String(src.rpcId ?? '')
  if (rid && PLUGIN_RPC.test(rid)) return 'plugin'
  // 桥登记过这条 requestId 的来历，就按它说的算（2026-11-09，issue #96）。
  // 这一条必须排在「带 rpcId 就当人」前面：prompt() 送来的群聊和定时提醒
  // 也只有 rpcId 能认，不查登记就全被算成他本人。
  const decl = rid ? declaredFor(rid) : null
  if (decl) {
    if (decl.machine) return 'plugin'
    if (decl.guest) return 'group'
    if (decl.scene === 'group') return decl.owner ? 'group-owner' : 'group'
    return 'human'
  }
  if (kind === 'user') {
    // 客户端（桌面/网页侧栏）打的字一定带时区——宿主从浏览器那边取的。
    // 桥走宿主 prompt 时不带时区，但每条都有 rpcId（宿主把 kind 写死成
    // 'user'）；fish 自己的 possess/sessionnote 直接 append，没有 rpcId ——
    // 只有它们继续落到 unknown。
    if (src.clientTimeZone || rid) return 'human'
    return 'unknown'
  }
  // 两张表都没挡住的 kind = 外渠道（qq / telegram / 别的桥自己起的名字）。
  // 宿主对 kind 只要求「非空且不是 'plugin'」，穷举不了，所以默认当人。
  return 'human'
}

/**
 * 从会话事件的 data 里取正文。
 *
 * 真机形态（2026-10-28 查宿主 session 库确认）：
 *   data = { id, role:'user', content:[{type:'text',text:'…'}], source:{…} }
 * 老宿主 / 别的通道可能只给 data.text，两种都兜住。
 */
export function messageText(data) {
  if (!data || typeof data !== 'object') return ''
  if (typeof data.text === 'string' && data.text.trim()) return data.text
  const c = data.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    const parts = []
    for (const p of c) {
      if (!p) continue
      if (typeof p === 'string') parts.push(p)
      else if (typeof p.text === 'string' && (!p.type || p.type === 'text')) parts.push(p.text)
    }
    if (parts.length) return parts.join('\n')
  }
  if (typeof data.message?.content === 'string') return data.message.content
  return ''
}

/**
 * 去掉桥塞在正文末尾的「渠道提示」段落（2026-11-08）。
 *
 * dsh-wechat-plugin 每条消息都拼一段 `[渠道：微信] 你在和微信上的用户对话…`
 * 说明，首条消息还会单独再发一条只有提示的。那是给她看的运行提示，不是他
 * 说的话；整段写进 talk-recent / heard，下次换会话搬过去的「上次我们说到这」
 * 就会带着一段微信配置说明。
 *
 * 只认**独立段落**（空行隔开、整段以 `[渠道：…]` / `[Channel: …]` 开头），
 * 正文中间引用这类文字不动；整条只剩提示时返回空，让它当没听见。
 */
export function stripChannelNote(text) {
  const s = String(text ?? '').trim()
  if (!s) return ''
  const paras = s.split(/\n{2,}/)
  while (paras.length && /^\[(?:渠道|channel)\s*[:：]/i.test(paras[paras.length - 1].trim())) {
    paras.pop()
  }
  return paras.join('\n\n').trim()
}

/**
 * 从宿主的 `assistant/message` 事件里取**她这一轮说出口的话**。
 *
 * 真机形态（2026-11-01 查宿主 `dsh-agent-loop/lib/index.js:1098`、`:1156`）：
 *   data = {
 *     turn, step,
 *     message: { id, role:'assistant', content:[{type:'text',text:'…'},{type:'reasoning',…}] },
 *     interrupted, usage, stream,
 *   }
 * 只收 `type === 'text'` 的块——reasoning 是她脑子里的嘀咕，不是她跟他说的话，
 * 搬进「上次我们说到这」等于把她没开口的心事当原话贴过去。
 */
export function assistantText(data) {
  if (!data || typeof data !== 'object') return ''
  const blocks = data.message?.content ?? data.content
  if (typeof blocks === 'string') return cleanSay(blocks)
  if (!Array.isArray(blocks)) {
    return typeof data.text === 'string' ? cleanSay(data.text) : ''
  }
  const parts = []
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue
    if (b.type !== 'text') continue
    if (typeof b.text === 'string') {
      const t = cleanSay(b.text)
      if (t) parts.push(t)
    }
  }
  return parts.join('\n').trim()
}

/**
 * 一份正文过两道清洗，顺序不能倒。
 *
 * 先 `stripToolMarkup`（issue #25）：工具标记可能夹在中间，先把它拿掉，
 * 后面的判据才不会把一行 `｜｜DSML｜｜` 当成真话。
 * 再 `stripTranscriptTail`（W49，2026-11-11）：从第一条行首 `user`/`assistant`
 * 标记起切到结尾。**要整份拼好之后再切**，不是逐块切——她那串自续写
 * 可能一整块都在，也可能和真话挤在同一块里。
 */
function cleanSay(text) {
  return stripTranscriptTail(stripToolMarkup(text))
}

/**
 * 模型侧工具调用标记的清洗在 `lib/markup.js`（issue #25）。
 *
 * 这里没有内联实现，是因为读同一份 assistant 正文的地方不止一处：
 * 本文件把它写进 `utterance`，`lib/home.js` 的 `askForLastWords` 拿它当
 * 「上一个房间里她留的最后一句」。清洗只做一次、收在一个纯函数里，
 * 两边都从那儿取，才不会一边干净一边脏。
 */
function cut(s) {
  const t = String(s ?? '').trim()
  return t.length > TURN_TEXT_MAX ? t.slice(0, TURN_TEXT_MAX) + '…' : t
}

/**
 * 一轮要说的话怎么落成事件（issue #98）。
 *
 * 装得进一条就一条：整段原样留着。装不下才切——先按空行切段，再把小段拼到
 * 接近 TURN_TEXT_MAX，单段本身超长的按长度硬切。切只发生在「一条事件放不下」
 * 的时候，不再把一次回答的每个段落都变成一条事件。
 */
function chunkText(s) {
  const t = String(s ?? '').trim()
  if (!t) return []
  if (t.length <= TURN_TEXT_MAX) return [t]
  const out = []
  let buf = ''
  const flush = () => {
    if (buf) out.push(buf)
    buf = ''
  }
  for (const part of t.split('\n\n').map((x) => x.trim()).filter(Boolean)) {
    if (part.length > TURN_TEXT_MAX) {
      flush()
      for (let i = 0; i < part.length; i += TURN_TEXT_MAX) out.push(part.slice(i, i + TURN_TEXT_MAX))
      continue
    }
    if (buf && buf.length + 2 + part.length > TURN_TEXT_MAX) flush()
    buf = buf ? `${buf}\n\n${part}` : part
  }
  flush()
  return out
}

/** 已经挂过观察者的宿主上下文（同一进程只挂一次，见 registerTurns） */
const TURNS_BOUND = new WeakSet()

/**
 * 注册"侧栏轮数"观察者。
 *
 * @param {object} ctx 宿主 ctx（需要有 on 事件总线）
 * @param {object} deps { root, log }
 * @returns {() => void} 注销函数（停用插件时调用）
 */
export function registerTurns(ctx, deps = {}) {
  const root = deps.root ?? rootDir()
  const log = deps.log ?? (() => {})
  if (typeof ctx?.on !== 'function') return () => {}

  /**
   * 2026-11-06（外部日志：被占用的实例照样往共享事件流里写 `seen:`）。
   *
   * 观测者以前是**无条件**写盘的：它看到「他来过」就 appendEvent，从不过问这个
   * 家是不是自己的。于是同一个数据目录被两个实例开着时，只读那一侧也在写——
   * 日志里那三条同一毫秒的 `seen:` 就是两个写者各写一遍。
   *
   * 这里和工具侧用同一道闸（tenant.js 的 guardWrite）：房主身份 ok===false 时
   * 一句都不写。必须在每次写之前现查，不能在注册时查一次就完。
   * deps.tenant 可以是对象（原地改写成 ok:false 的那种），也可以是返回当前对象的函数：
   * index.js 丢占用权时是把 tenancy.tenant 整个换掉，所以它传的是函数。
   */
  const tenantNow = typeof deps.tenant === 'function' ? deps.tenant : () => deps.tenant ?? null
  const writable = () => {
    let tenant = null
    try { tenant = tenantNow() } catch { tenant = null }
    return !(tenant && tenant.ok === false)
  }

  /**
   * 同一份宿主上下文只挂一次。
   *
   * 2026-11-06：插件被同一个进程加载两遍时（两个入口 / bundles 里重复），
   * 两个观察者各有各的节流记忆，同一条人话会写出两条同一毫秒的 `seen:`——
   * 记账行一重复，事件流就再也不能当证据用。第二次注册直接交白卷。
   */
  if (TURNS_BOUND.has(ctx)) return () => {}
  TURNS_BOUND.add(ctx)

  /** 正在等 turn/end 的那一轮：{ sessionId, msgs:[], sinceId, at } */
  let pending = null
  /**
   * 她家里刚结完账的那一轮人话：{ sessionId, me }。只给「继续」用（见 onHuman）。
   *
   * 宿主 0.2.2-rc.2：一轮因为限流、断流失败（turn/end 的 reason 是 error），
   * 他可以点「继续」——宿主发来一条 kind 'retry'、正文为空的 user/message，
   * 她在**新的一轮**里把话答完。失败的那一轮这边已经结过账了（turns +1、
   * talk-recent 记了一轮、her 是空的），所以「继续」那一轮只补她说的话。
   *
   * 只认「这条会话里上一个 turn/end 就是我们结的那一轮人话」：中间隔了别的轮
   * （叫醒、桥送来的群聊）就清掉，免得把她的话安到不相干的那一轮下面。
   * 只在内存里：重启之后点「继续」，这边认不出来，照旧不记。
   */
  let lastSettled = null
  /** 正在异步认来源的那条人话（见 takeTurnEnd：事件跟得太紧时要等它） */
  let inflight = null
  /** 注销之后不再结账（在途的那一轮可能还没等到 turn/end） */
  let stopped = false
  /** 结账是异步的；上一轮还没结完就来了下一轮时，宁可不记也不并发写 home.json */
  let busy = false
  /**
   * 最近一次替「他来过」写的 seen 时间戳（毫秒）。
   * 只给外渠道那条路用：别的会话里他每说一句都写一条，事件流会被记账行淹掉。
   */
  let lastSeenAt = 0
  /**
   * 「认不出来源」这条日志上次打的时刻，按 kind 分开记。
   * 2026-11-04（用户 m02556）：同一个 kind 十分钟最多一行，见下面总线段。
   */
  const unknownLoggedAt = new Map()

  /**
   * 「这一轮的正文里只剩工具标记」这条日志上次打的时刻。
   * 2026-11-04（issue #25）：偶发（约 500 轮 2 次），但以后要是变多，
   * 日志里要看得出来——否则又变成「事件流里少了一句，日志里一个字都没有」。
   */
  let markupDroppedAt = 0
  /**
   * 记一条「他来过」——冷落检测（absence.js）读的就是这个。
   *
   * 2026-11-03（issue #18）从 settle() 挪到这里：原来只有「这一轮聊完并且结账成功」
   * 才写，而结账依赖 pending，pending 又依赖 classifyMessage 认得出人。外渠道判成
   * context 时一个字节都不写，于是冷落检测完全瞎掉。
   *
   * 现在口径是「他开口那一刻」：他确实说话了，这件事不以她回不回、也不以
   * 结没结账为前提（与 say.js 一致）。source 必须是 'system'——tool 侧写不了
   * 非 HER_TYPES 的类型，写成 tool 会被 schema 悄悄拒掉。
   */
  async function markSeen() {
    // 2026-11-06：写盘之前先过所有权闸门（被占用的实例一条都不许写）。
    if (!writable()) return
    lastSeenAt = Date.now()
    await appendEvent(
      { type: 'meta', text: `seen:${new Date(lastSeenAt).toISOString()}` },
      // day/stage 对 seen 没有语义（derive.js 只读 text 里的时刻），
      // 与 hand: / rotate: 那两条记账行同一个写法。
      { day: 0, stage: 1, source: 'system' },
      root,
    ).catch((err) => log('turns · 他来过这件事没记上', err?.message ?? err))
  }

  /** 收到真人消息：只认"她住的那个会话"，并把这一轮开始前的事件 id 记下来 */
  async function onHuman(sessionId, data) {
    if (!writable()) return
    // 2026-11-06（用户报「叫醒之后她就不说话了」）：他一开口，上一次叫醒留下的
    // 「处境」当场作废。
    //
    // 处境原本只该出现在**她自己醒的那一轮**里，靠 turn/end 撤。但 turn/end 不是
    // 一定能认到（监听按会话挂、重启会丢、两个渠道挨得近时也会错号），那一段
    // 「这一轮是你自己的，不用回应任何人；不想说就什么都别写」就留在 system prompt
    // 里，接下来他说的每一句都带着它——她就只思考、不开口，而且连续多轮都这样。
    // 人真的说话了，这段就不该还在；清得比 turn/end 早一步也不会出错。
    try { clearWakeSectionFor(sessionId) } catch { /* ignore */ }
    const home = await homeStatus(root)
    if (!home.sessionId) return
    if (home.sessionId !== sessionId) {
      // 2026-10-31（issue #14 第二报）：轮换之后人还在换下来那条里说话。
      //
      // 原来这里无条件 return，于是换会话那一刻起，他说的每一句都被静默丢掉：
      // 不涨轮、不记原话、也不再轮换，面板永远停在 0 / N，而日志里**一个字都没有**
      // （真机表现就是「只有那一行『换了个新会话』，之后什么都没有」）。
      //
      // 成因不复杂：插件用 API 建的会话永远是空白会话，宿主侧栏不显示它；
      // 人看不见新的，自然还在旧的里说话。0.8.4 起轮换会先叫醒新会话
      // （home.js 的 rotateTalkSession 第 4 步），但**换会话那一刻已经在说话的人**
      // 不会因为新会话出现了就自动搬过去，所以这里必须认回来。
      //
      // 判据宁窄勿宽：只认「home.json 记着的、刚被换下来的那条」（rotatedFrom）。
      // 不认任意会话——认宽了等于谁在别处跟她说一句都能把她的家搬走。
      if (!home.rotatedFrom || home.rotatedFrom !== sessionId) {
        // 2026-11-03（issue #18）：这不再是「什么都不做」。
        //
        // 外渠道（QQ 桥 / 别的桥）按我们的桥接约定**自己建 DSH 会话**（AGENTS.md §7），
        // 消息根本不落进 her 会话里。原来在这里直接 return，那些话连「他来过」
        // 都不算——面板到点落一条「他有 N 天没出现」，而人其实天天在 QQ 上聊。
        //
        // 所以：屋子不搬、轮数不涨、talkmem 不动（那些都是她的家事），
        // 只把「他来过」记下来。同一分钟里连说几句只写一条，别把事件流灌成记账。
        //
        // 2026-11-04（用户 m02566 报的刷屏）：日志原来写在这个 if **外面**，
        // 于是节流只拦住了「写事件」，没拦住打日志——他连着发三句就是三行一样的
        // 「认识的会话之外的动静」。日志重复到看不出哪条是真的，等于这条日志白写。
        // 现在挪进 if 里：每 60 秒最多一行，且只在真的落了 seen 的那一次打。
        //
        // 2026-11-11（用户报「好几天没回她，为什么不算冷落」）：原来这里
        // **任何**别的会话都算他来过——他在本机跟别的 agent 说一句话，她那边的
        // 冷落钟就清零，`absenceAfterDays: 2` 永远到不了。现在分两种：
        //   · 客户端亲手打的字（kind:'user' 且带 clientTimeZone）只认她自己的房间：
        //     她的家、桥按 room:'channel' 开的私聊房（channels.json 里登记过的）。
        //     本机其他 DSH 会话不再算「他来找过她」。
        //   · 桥注入的消息（kind 不是 user，或没有 clientTimeZone）照旧算——
        //     QQ 私聊那条路不能断（issue #18），群聊与群友私聊在 classifyMessage
        //     那一步就已经挡掉了，走不到这里。
        //
        // 「客户端亲手发的」还有两种 kind 不是 'user'（HOST_CLIENT_KINDS）：失败后
        // 点「继续」的 retry、问题卡的回答。原来它们被当成桥注入的，他在别的会话里
        // 点一下「继续」或答一张卡，就在这里写了 seen（这一段在取正文之前，
        // retry 的正文是空的也照写）。现在和桌面打字同一个口径。
        const src = data?.source ?? {}
        const srcKind = String(src.kind ?? '')
        const fromDeskClient = (srcKind === 'user' && Boolean(src.clientTimeZone))
          || HOST_CLIENT_KINDS.has(srcKind)
        if (fromDeskClient) {
          const herRoom = await isChannelSession(root, sessionId).catch(() => false)
          if (!herRoom) return
        }
        if (Date.now() - lastSeenAt > 60_000) {
          await markSeen()
          log(`turns · 认识的会话之外的动静，只记他来过（${sessionId}）`)
        }
        return
      }
      // 认回也要看时候（2026-11-10，用户反馈「换会话又落回旧的老会话」）：
      // `rotatedFrom` 会一直留到下一次轮换，不设窗口的话，他几天后翻回那条
      // 「…之前」随口说一句，屋子就搬回去，`turns` 还是新会话的 0——
      // 那条已经满 40 轮的会话等于又重新拿到一整段预算。
      const rotatedAt = Date.parse(String(home.rotatedAt ?? ''))
      const stillThere = Number(home.turns ?? 0) === 0
        || (Number.isFinite(rotatedAt) && Date.now() - rotatedAt < ADOPT_WINDOW_MS)
      if (!stillThere) {
        if (Date.now() - lastSeenAt > 60_000) {
          await markSeen()
          log(`turns · 他回到换下来那条会话里说话，但屋子已经搬走了（${sessionId}）`)
        }
        return
      }
      const ok = await adoptTalkSession(root, sessionId)
      log(
        ok
          ? `turns · 他还在换下来那条会话里说话，屋子认回它（${sessionId}）`
          : `turns · 他还在换下来那条会话里说话，但认不回来（${sessionId}）`,
      )
      if (!ok) return
    }
    const text = cut(stripChannelNote(messageText(data)))
    if (!text) {
      // 「继续」（kind 'retry'，正文是空的）：接着刚结账的那一轮，只收她这次说的话。
      // 不写 seen——他那一句开头时已经写过，一轮一条；也不建新的一轮。
      if (String(data?.source?.kind ?? '') !== 'retry') return
      if (!lastSettled || lastSettled.sessionId !== sessionId) return
      if (pending && pending.sessionId === sessionId) return
      const { events } = await readEvents(root).catch(() => ({ events: [] }))
      pending = {
        sessionId,
        msgs: [],
        continuation: true,
        me: lastSettled.me,
        sinceId: events.length ? (events[events.length - 1].id ?? null) : null,
        says: [],
        sayIds: new Set(),
        at: Date.now(),
      }
      return
    }
    // 他递来一条视频（2026-10-28）：记一条事实 `hand:<日期> <bvid>`。
    // **不等于她看过**——评论闸门不认这一行，认的是 look:/watched:。
    // 只记 BV 号；短链在这一层不解析（要发网络请求，不该卡在她说话的路径上）。
    const want = parseWatchIntent(text)
    if (want.hasVideo && want.bvid) {
      appendEvent(
        { type: 'meta', text: `hand:${dateKey()} ${want.bvid}` },
        { day: 0, stage: 1, source: 'system' },
        root,
      ).catch(() => {})
    }
    if (pending && pending.sessionId === sessionId && pending.continuation) {
      // 「继续」那一轮里他又开口了：这就是新的一轮人话，照常开头、照常结账。
      // 她已经说出口的留在 says 里，一起算这一轮的。
      await markSeen()
      pending.continuation = false
    }
    if (!pending || pending.sessionId !== sessionId) {
      const { events } = await readEvents(root).catch(() => ({ events: [] }))
      // 这一轮的第一句人话 = 「他开头那一刻」。一轮只写一条 seen
      // （单条论：turns.test.mjs 与 p3.test.mjs 都钉着「一轮一条」）。
      await markSeen()
      pending = {
        sessionId,
        msgs: [],
        // 这一轮开始前最后一条事件：用来在 turn/end 时捞她调 growth_commit 写下的那些
        sinceId: events.length ? (events[events.length - 1].id ?? null) : null,
        // 她这一轮在侧栏里**说出口的原话**，从宿主的 assistant/message 收（见 assistantText）。
        // 2026-11-01：原来只从 events.jsonl 里 HER_TYPES 那六种取，而那只在她调
        // growth_commit 时才写 —— 她在侧栏正常聊天写的话根本不进事件流，
        // 于是 talk-recent.json 的 her 永远是空字符串，换会话时搬过去的
        // 「上次我们说到这」只有他那一半。这条通道一接，那半句才补上。
        says: [],
        // 同一条 assistant/message 可能分几步重放（interrupted / 续写会改同一个 message id）。
        // 按 message.id 去重，别把她说的一句话记成三句。
        sayIds: new Set(),
        at: Date.now(),
      }
    }
    if (pending.msgs.length < TURN_MSGS_MAX) pending.msgs.push(text)
  }

  /** turn/end：结账 */
  async function settle(p) {
    if (stopped || !writable()) return
    if (busy) {
      log('turns · 上一轮还没结完，这次不记')
      return
    }
    busy = true
    try {
      const after = await readEvents(root).catch(() => ({ events: [] }))
      // sinceId 为空 = 这一轮开始前一条事件都没有 ⇒ 全算她这轮说的。
      // （不能直接把这个空值交给 newHerEventsSince：它把 null 当"全部已读"，会返回空。）
      const picked = p.sinceId
        ? newHerEventsSince(after.events, p.sinceId)
        : after.events.filter((e) => HER_TYPES.includes(e.type))
      // 两条来源合起来才是「她这一轮说了什么」：
      //   ① events.jsonl 里 HER_TYPES —— 只有她主动调 growth_commit 才有，是「她认下来的话」；
      //   ② 这一轮 assistant/message 的 text 块 —— 她在侧栏里**实际说出口的**那些。
      // 少了 ②，talk-recent.json 的 her 永远是空串，换会话时她听不到自己上一段说过什么。
      const spoken = (Array.isArray(p.says) ? p.says : []).join('\n\n').trim()
      const committed = picked.map((e) => String(e.text ?? '').trim()).filter(Boolean).join('\n\n')
      const her = [spoken, committed].filter(Boolean).join('\n\n')
      const { config } = await loadConfig(root).catch(() => ({ config: null }))
      // A2（2026-10-30，用户 m00112）：每 hearEvery 轮，把他说的**一句原话**记下来。
      // 放在换会话判断之前：这一轮已经结完账，换不换会话都该记。
      // 用 after.events 算成长日——这时还没写 heard，差一天也不会差在这一条上。
      const day = growthDay(after.events)
      // 「他来过」不在这儿写（2026-11-03 移走，见 markSeen）。
      //
      // 原来写在这里的理由是「这一轮确实聊完了才算他来过」。issue #18 证明这个口径
      // 会整条链路失灵：外渠道的消息判不成 human 就没有 pending，没有 pending 就
      // 永远走不到这一行，于是聊得再多冷落检测也看不见。现在改成他一开口
      // （onHuman 里第一句人话）就记，与 say.js「他确实说话了，不以她回不回为前提」
      // 同一口径；一轮仍然只有一条。
      // 2026-11-02（用户 m00680）：把她在侧栏里**说出口的原话**补写进事件流。
      //
      // 为什么必须补：`derive.js` 的 wontCount 只数 events.jsonl 里的 utterance，
      // 而这个观察者以前一个字节都不写事件（见文件头铁律）。于是她在侧栏里说的
      // 「我拒绝B」只进了 talk-recent.json，拒绝计数永远是 0，refusal_seed 之类
      // 靠「她有没有拒绝过」判断的事件卡永远不成立。
      //
      // 为什么打 uncommitted：她没调 growth_commit 认领这句话，就不能让它改称呼、
      // 覆盖自我叙述、参与固化（derive.js 里与 selfmod 同一处理）。它只留证。
      //
      // 只补这一轮**新**说出口的：committed 里的已经在事件流里了，重复写会重复计数。
      // 2026-11-09（issue #98）：一轮只写一条。
      // 原来按空行切段、逐段落库，一条带小标题和列表的回答会变成七八条事件：
      // 他机器上一天 1326 行里有 694 行是这么来的（`**运行状态**`、`---`、一个
      // 列表项各算一条，时间戳只差几毫秒）。切段本来是想让 REFUSE_RE 命中单独
      // 成句的「我拒绝…」，但那条正则是拿整段文本去 test 的，切不切都不多命中。
      // 只有整段超过 TURN_TEXT_MAX、一条事件装不下时才切。
      const said = spoken ? String(spoken).trim() : ''
      const committedTexts = picked.map((e) => String(e.text ?? '').trim()).filter(Boolean)
      const fresh = said && !committedTexts.some((t) => t === said) ? chunkText(said) : []
      for (const text of fresh) {
        await appendEvent(
          { type: 'utterance', text: cut(text), flags: ['uncommitted'] },
          { day, stage: stageOf(day, Number(config?.growthDays ?? 30)), source: 'system' },
          root,
        ).catch((err) => log('turns · 她的话没记上', err?.message ?? err))
      }
      if (p.continuation) {
        // 「继续」那一轮：他没有再说话，不涨轮数、不旁听、不换会话。
        // 只把她这次说的补进失败那一轮（上面的 utterance 已经照常写了）。
        if (her) await amendLastExchange(root, { me: p.me, her }).catch(() => {})
        return
      }
      const me = p.msgs.join('\n')
      await addExchange(root, { me, her }).catch(() => {})
      const turns = await bumpTurns(root, 1)
      lastSettled = { sessionId: p.sessionId, me }
      await hearTurn(root, {
        text: me,
        turns,
        // 记下的那句要带这条会话的 id（2026-11-08，用户 m01199）：出门/请神算「这一趟多了什么」
        // 时按会话过滤，没有 id 的条目会被当成这趟的东西。
        sessionId: p.sessionId,
        day,
        stage: stageOf(day, Number(config?.growthDays ?? 30)),
        config,
        log,
      })
      const rotateAfter = Number(config?.chat?.rotateAfter ?? 0)
      if (!(rotateAfter > 0) || turns < rotateAfter) return

      // 该换会话了。换失败不算错：她还在旧会话里，下次再换。
      // from：这一轮是从哪条会话里结出来的。`/say` 那边可能刚刚换过，
      // Home 比对 home.json 之后会返回 skipped，这里就别再建第二条（0.8.8）。
      const st = await homeStatus(root)
      const rot = await rotateTalkSession(ctx, { root, wsId: st.wsId, log, from: p.sessionId })
      if (!rot.ok) {
        log(`turns · 聊满 ${turns} 轮，该换会话但没换成：${rot.why}`)
        return
      }
      if (rot.skipped) {
        log(`turns · 聊满 ${turns} 轮，但屋子已经先换过了（${rot.sessionId}），这条不再换`)
        return
      }
      // 留一条 meta：换会话这件事要能在事件流里查到（观测台/排查用）。
      // source 必须是 system——'tool' 会被 schema 拒掉。
      await appendEvent(
        { type: 'meta', text: `rotate:${turns}:${rot.sessionId}` },
        { day: 0, stage: 1, source: 'system' },
        root,
      ).catch(() => {})
      // 新会话要读到新的身份文档（「上次说到这」在里面）
      await refreshSelfDoc(root, { log }).catch(() => {})
      log(`turns · 聊满 ${turns} 轮，换了个新会话（旧 ${rot.old || '?'} → 新 ${rot.sessionId}）`)
    } catch (err) {
      log('turns · 结账失败', err?.message ?? err)
    } finally {
      busy = false
    }
  }

  /**
   * turn/end 到了：确认这一轮是她屋里的、人打的，再结账。
   *
   * 为什么要等 `inflight`：真机上这两条事件是分开来的（人话在前，turn/end
   * 在几秒后），但测试里、以及事件批量回放时可能同一拍到达——那时 onHuman
   * 还在 `await homeStatus()`，pending 还没挂上，直接看就会把这一轮漏掉。
   * 等它落定再看，只多花几毫秒，不会把别人的轮次算进来。
   */
  async function takeTurnEnd(sessionId) {
    if (!pending || pending.sessionId !== sessionId) {
      if (inflight) await inflight.catch(() => {})
      if (!pending || pending.sessionId !== sessionId) {
        // 这条会话里结束的是别的一轮（叫醒、桥送来的群聊…）：之后的「继续」
        // 续的是那一轮，不是我们结过账的那一轮人话。
        if (lastSettled?.sessionId === sessionId) lastSettled = null
        return
      }
    }
    const p = pending
    pending = null
    await settle(p)
  }

  const off = ctx.on('session/event', (session, event) => {
    try {
      const sessionId = String(session?.header?.id ?? session?.id ?? '')
      if (!sessionId) return
      const type = String(event?.type ?? '')
      if (type === 'user/message') {
        const cls = classifyMessage(event?.data)
        if (cls === 'group') {
          // 2026-11-03（一条鱼多间房）：群聊里的话不进轮数、不写 seen。
          // 一条日志都不打——群聊一天几百条，每条打一行会把日志冲掉。
          // 群友的话也**一条都不进记忆**（2026-11-08，用户 m00394 的边界）。
          return
        }
        if (cls === 'group-owner') {
          // 2026-11-08（用户 m00394）：群里他自己说的那句进记忆——只留一句原话，
          // 带 scene:group；不写 seen、不涨轮数、不进书房桶、不触发轮换。
          // 走 setImmediate 之外不额外排队：只是多读一次 state.json，失败全吞。
          void rememberOwnerGroupLine(root, sessionId, messageText(event?.data))
          return
        }
        if (cls !== 'human') {
          // 2026-11-03（issue #18）：unknown 以前是**悄无声息**地丢掉的。
          // 现场表现就是「明明在说话，事件流零增长，日志里一个字都没有」——
          // 报工单的人只能自己去读源码才知道哪一步断的。至少留一行。
          //
          // 2026-11-04（用户 m02556 报的刷屏）：同一个 kind 十分钟之内只打一行。
          // 留一行是为了让人知道「有东西被丢了」，留一百行只会把日志淹掉——
          // 那种情况下这条日志反而失去了它唯一的作用。
          if (cls === 'unknown') {
            const kind = String(event?.data?.source?.kind ?? '')
            const now = Date.now()
            if (now - (unknownLoggedAt.get(kind) ?? 0) > 10 * 60_000) {
              unknownLoggedAt.set(kind, now)
              log(`turns · 这条消息认不出来源，没算进轮数（kind=${kind || '空'}）`)
            }
          }
          return
        }
        inflight = onHuman(sessionId, event.data)
          .catch((err) => log('turns · 记轮失败', err?.message ?? err))
          .finally(() => {
            inflight = null
          })
        return
      }
      // 她这一轮说出口的话（2026-11-01）。原来只从 events.jsonl 取，
      // 而那里只有她调 growth_commit 才写 —— 侧栏里正常聊的话一句都拿不到。
      // 只认还在等结账的那一轮：没有 pending（唤醒轮、/say 轮）就不记，
      // 否则定时唤醒里她自己写的句子会被当成「他来过」的对话搬进下一段。
      if (type === 'assistant/message') {
        if (!pending || pending.sessionId !== sessionId) return
        if (pending.says.length >= TURN_MSGS_MAX) return
        const mid = String(event?.data?.message?.id ?? '')
        if (mid) {
          if (pending.sayIds.has(mid)) return
          pending.sayIds.add(mid)
        }
        const said = cut(assistantText(event?.data))
        if (said) pending.says.push(said)
        else if (Date.now() - markupDroppedAt > 60_000) {
          // 2026-11-04（issue #25）：这一步的正文只剩工具调用标记
          // （`</｜｜DSML｜｜ invoke>`），清洗后没有正文。她本来要说的那句话
          // 在这一步就丢了，插件补不回来——能做的只有**别把标记当她的话记进去**，
          // 并且在日志里留一行，免得以后这类事件变多了都没人发现。
          const blocks = event?.data?.message?.content
          const raw = Array.isArray(blocks) ? blocks.map((b) => String(b?.text ?? '')).join('\n') : ''
          if (hasToolMarkup(raw)) {
            markupDroppedAt = Date.now()
            log('turns · 这一步的正文只剩工具调用标记，没当成她的话')
          }
        }
        return
      }
      if (type === 'turn/end') {
        void takeTurnEnd(sessionId).catch((err) => log('turns · 结账失败', err?.message ?? err))
      }
    } catch (err) {
      log('turns · 事件处理失败', err?.message ?? err)
    }
  })

  // 桥在调 prompt() 之前先报一句「这条是谁说的」（2026-11-09，issue #96）。
  // 同步收下、不等不挡；不报的桥保持老行为。
  const offSource = ctx.on?.('dsh-fish/source', (o) => {
    declareSource(o)
  })

  return () => {
    stopped = true
    pending = null
    TURNS_BOUND.delete(ctx)
    try {
      if (typeof off === 'function') off()
      if (typeof offSource === 'function') offSource()
    } catch {
      /* ignore */
    }
  }
}
