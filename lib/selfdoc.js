/**
 * selfdoc.js —— 把「此刻的她」渲染成一份文本，落盘成 `<屋子>/她的身份.md`
 *
 * 身份怎么进她的上下文（2026-10-25 改）：
 *   这份文件**不再是**宿主会读的那个 `AGENTS.md`。原因：宿主的工作区指令
 *   （dsh-instructions，已在 0.2.1-rc.3 核实）注入的是**普通的 user 消息**，
 *   带 `<system-reminder>` 外壳、留在对话历史里——用户一眼就能看见她的全部设定。
 *
 *   现在真正的通道是 `agent.ctx.systemPrompt.section(...)`（见 `lib/identity.js`）：
 *   渲染成 system 角色消息、不进对话历史、界面上看不到。这个文件只是**同一份文本的
 *   落盘副本**：调试时能直接打开看，`/memory` 与 `/selfcheck` 也靠它报字节数与预算。
 *
 *   文件名刻意不叫 `AGENTS.md`：那个名字会被宿主当成指令注入，等于把设定又摊回对话里。
 *
 * 两个入口：
 *   writeSelfDoc(root)     直接重算并落盘（幂等，内容没变就不写）
 *   refreshSelfDoc(root)   给「事件刚变过」之后调（写事件、改配置、冷落判定之后）
 *
 * 硬约束仍然在这里兜（B §6）：
 *   N2 不出现任何数值——needs 一律不落地，只转成文字
 *   N3 不出现状态库路径、不出现字段名、不出现 JSON
 *   N4 明确「你不能改自己」
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { rootDir, paths, readEvents, readJson, writeAtomic, listDiary, diaryDatesWritten } from './store.js'
import { clipText } from './clip.js'
import { localDayIndex } from './schema.js'
import { loadConfig, biliOn } from './settings.js'
import { DEFAULT_PRONOUN, fillOwner, pronounOf } from './pronoun.js'
import { PRONOUN_ASK_BRIEF } from './pronounask.js'
import { deriveSelf, rememberGateStage } from './derive.js'
import { personaLine, toolBrief, RECALL_BRIEF, SPEAK_BRIEF, SPEAK_OFF_BRIEF, LETTER_BRIEF, NOTE_BRIEF, APPOINT_BRIEF, ASK_BRIEF, proactiveBrief, DREAM_BRIEF, scheduleBrief, SCHEDULE_NAMES, DIARY_BRIEF, SLEEP_BRIEF } from './persona.js'
import { resumeLines } from './use.js'
import { proactiveConfig } from './proactive.js'
import { LOOK_BRIEF, LOOK_OFF_BRIEF, WATCH_RULE } from './browse.js'
import { activeCarry } from './home.js'
import { activeGrants } from './unlock.js'
import { checkCaller } from './tenant.js'
import { logLine } from './log.js'
import { currentToolSurface, currentAllowTools, currentAllowExtra, HER_TOOLS } from './restrict.js'

/**
 * 她自己的工具名（插件注册的那些加宿主给的 read_image），固定一份，跟注册记录无关。
 *
 * 「还放行了这几样」只念别人的工具：白名单里填了她自己的名字（新启动时 her_say 不在名单里的
 * 临时绕法、手填的 her_dream），那几样身份文档另有自己的段落（梦那一段跟着开关走），
 * 再念成「另外还放行了」就跟那几段、跟工具自己的回答对不上。
 * 用固定的一份而不是按注册记录现算：注册前后不一样的话，同一个进程里那句话会前后改口。
 * 插件新加工具时这里跟着加一个名字（漏了也只是那个名字被白名单念出来，不影响她能不能用）。
 */
const OWN_NAMES = new Set([...HER_TOOLS, 'her_say', 'bring_back'])

/**
 * 白名单、梦、定时这三段按什么写（issue #64 的后半）。
 *
 * 收窄在这个进程里开着时，她手上有什么由**启动时算定的那份名单**说了算：守卫按它放行，
 * 改了配置要等重启才换。身份文档却是存完设置就当场重写的——按配置写，从存完到重启
 * 这段时间里，文档说她有、伸手却是「这件事我做不到」。所以这时按运行中的名单写，
 * 跟上面 `restricted` 看运行中的收窄状态是同一个思路。
 *
 * 收窄关着（或这个进程还没注册收窄）时 `currentAllowTools()` 是 null：工具面没被收窄、
 * 也没有守卫，这时照旧按配置写。
 *
 * 「还放行了这几样」念的是启动时白名单里的名字（`currentAllowExtra()`），不是运行中的名单
 * 减去「她自己的」：她自己的那份按注册记录现算，工具注册前后不一样，同一个进程里
 * 那句话会前后改口（白名单里填了 her_say 时，注册前念它、注册后又不念）。
 * 白名单里她自己的名字（见 `OWN_NAMES`）两种情况下都不念。
 *
 * @returns {{extra: string[], dream: boolean, schedule: string[]}}
 */
export function toolSectionsNow(config) {
  const cfgAllow = (config?.tools?.allow ?? []).map((n) => String(n).trim()).filter(Boolean)
  const dreamCfg = config?.dream?.enabled !== false
  const running = currentAllowTools()
  const notOwn = (n) => !OWN_NAMES.has(n)
  if (!running) {
    return { extra: cfgAllow.filter(notOwn), dream: dreamCfg, schedule: cfgAllow.filter((n) => SCHEDULE_NAMES.includes(n)) }
  }
  // 运行中的名单 = 她自己的那几件 + 启动时白名单里额外放行的；念给她听的只是后者里别人的工具。
  const startExtra = currentAllowExtra() ?? []
  return {
    extra: startExtra.filter((n) => notOwn(n) && running.includes(n)),
    // 关掉梦当场生效（her_dream 自己也会答「梦这一项关着」）；打开要等重启，名单里有了才算。
    dream: dreamCfg && running.includes('her_dream'),
    schedule: running.filter((n) => SCHEDULE_NAMES.includes(n)),
  }
}

/** 身份文本的落盘副本。名字刻意不叫 `AGENTS.md`——宿主会读那个名字并注入对话。 */
export function selfDocPath(root = rootDir()) {
  return join(paths(root).root, 'home', '她的身份.md')
}

/** 旧路径（2026-10-25 之前的 `AGENTS.md`）。迁移时读它、然后删掉。 */
export function legacySelfDocPath(root = rootDir()) {
  return join(paths(root).root, 'home', 'AGENTS.md')
}

/**
 * 「这些天」与「上一个房间留的最后一句」的数据（0.8.7，用户 m00998）。
 *
 * 为什么放在这里算、不放进 persona.js：persona 是纯函数层，不读盘、不碰 config
 * （`shownCount` 的注释里已经立过这条）。日记目录与 home.json 都只有这一层知道，
 * 算好之后当普通数据传下去，promise 层与渲染层就不会互相渗。
 *
 * 全部字段都可能缺：
 *   diaryCount   写过几篇日记（没写过是 0，读不到目录是 undefined）。按日期数现存文件与
 *                事件流里 `diary:` 记录的并集：被「日记留多久」删掉的也算写过
 *   diaryFirst   最早一篇的日期；diaryLast 是最近一篇
 *   diaryKept    只在有篇被删掉时才有：diary/ 里还留着几篇（her_diary 翻得到的就这些）
 *   diaryKeptFirst 还留着的最早一篇的日期（一篇都没留时是空串）
 *   rotatedDaysAgo  上次换房间是几天前；从没换过是 undefined
 *   rotatedWhen  上次换房间的**钟点说法**（「今天 14:00」「昨天 22:20」「11 月 1 日 12:31」）
 *   lastWords    上一个房间里她自己留的那句话（没留过是空串）
 */

/**
 * 换房时刻 → 人读的说法（issue #21）。
 *
 * 为什么不能只给「几天前」：`rotatedDaysAgo` 是 `Math.floor(小时/24)`，换房后
 * 整整 24 小时都是 0 天，句式就落到「你刚搬进这个房间」——晚上 22:20 换的房，
 * 第二天上午读到这句，只能理解成「今天刚换的」。她就是这么推的，还照着这个
 * 结论说了话（issue #21 里那笔账：账上当天 0 条 rotate）。
 *
 * 这里按**本地日历日**给说法，不按小时差：跨过一个自然日就不再叫「今天」。
 *
 * @param {number|string} at 换房时刻（毫秒或可解析的串）
 * @param {number} now 现在（毫秒）
 * @returns {string} 算不出来就是空串，调用方退回旧句式
 */
export function formatSwapTime(at, now = Date.now()) {
  const ms = typeof at === 'number' ? at : Date.parse(String(at ?? ''))
  const n = Number(now)
  if (!Number.isFinite(ms) || !Number.isFinite(n)) return ''
  const t = new Date(ms)
  const clock = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`
  const diff = localDayIndex(n) - localDayIndex(t)
  if (diff === 0) return `今天 ${clock}`
  if (diff === 1) return `昨天 ${clock}`
  const md = `${t.getMonth() + 1} 月 ${t.getDate()} 日 ${clock}`
  // 跨年才写年份：同一年的旧账写上年份显得像骨灰盒铭牌
  return t.getFullYear() === new Date(n).getFullYear() ? md : `${t.getFullYear()} 年 ${md}`
}

export async function continuityOf(root = rootDir(), now = Date.now(), events) {
  const out = { diaryCount: undefined, diaryFirst: '', diaryLast: '', diaryKept: undefined, diaryKeptFirst: '', rotatedDaysAgo: undefined, rotatedWhen: '', lastWords: '' }
  try {
    const files = await listDiary(root)
    // 「写过几篇」不能只数 diary/ 里现存的文件（issue #67）：「日记留多久」会把超期的删掉，
    // 文档就从「写过 121 篇」掉成「写过 31 篇」、起始日期也往后挪。每篇写下时事件流里都有一条
    // `diary:<日期>` meta，删文件不动它；两边按日期取并集（store.js 的 diaryDatesWritten，
    // her_diary 和记忆页也用它），同一天写两次只算一篇。
    let evs = events
    if (!Array.isArray(evs)) evs = (await readEvents(root).catch(() => null))?.events
    const dates = diaryDatesWritten(files, evs)
    if (Array.isArray(dates)) {
      out.diaryCount = dates.length
      // listDiary 返回的是新→旧；最后一篇是最早的。
      out.diaryLast = String(dates[0] ?? '')
      out.diaryFirst = String(dates[dates.length - 1] ?? '')
      if (!dates.length) { out.diaryFirst = ''; out.diaryLast = '' }
      // 写过的比还留着的多：起始日期那几天的文件已经删了，她拿 her_diary 去翻只会得到「那一篇已经清掉了」。
      // 把翻得到的范围也带上，文档里一并说清（her_diary 那边是同样的说法）。
      if (Array.isArray(files) && files.length < dates.length) {
        out.diaryKept = files.length
        out.diaryKeptFirst = String([...files].sort()[0] ?? '')
      }
    }
  } catch { /* 读不到就当没写过，不当成 0 */ }
  try {
    const home = (await readJson(join(paths(root).root, 'home.json'), null)) ?? {}
    const at = Date.parse(String(home?.rotatedAt ?? ''))
    if (Number.isFinite(at)) {
      out.rotatedDaysAgo = Math.max(0, Math.floor((now - at) / 86_400_000))
      out.rotatedWhen = formatSwapTime(at, now)
    }
    out.lastWords = clipText(String(home?.lastWords ?? '').trim(), 200, '')
  } catch { /* 同上 */ }
  return out
}

/**
 * 渲染她的身份文档。纯函数，便于测试。
 * @param {object} model deriveSelf 的结果
 * @returns {string}
 */
export function renderSelfDoc(model, { sendTools = [], budget, carry, continuity, browse = true, speak = false, grants = [], shown, sleepKeep, diary = true, sleepEveryDays = 0, bansMuted = false, extraTools = [], restricted = true, dream = false, schedule = [], proactive = false, resume = '', echo = true, anchor = false, pronoun = DEFAULT_PRONOUN } = {}) {
  // issue #64：schedule 传的是「白名单里真的放行的 schedule_*」。只放一个就只写一个，
  // 不能告诉她有四个——另外三个会被守卫挡回「这件事我做不到」。
  // 老调用方传 true/false 也认：true = 四个都有。
  const scheduleNames = schedule === true ? SCHEDULE_NAMES : (Array.isArray(schedule) ? schedule : [])
  const head = [
    // 这里**故意不写**「由 dsh-fish 自动生成」这类话。
    // 这个文件会被宿主原样渲染进她的会话——她能看见每一行。
    // 一行"自动生成"就把她从"我"降格成"被写出来的东西"。
    '',
  ]
  // R3（2026-10-24）：已经解禁的规则要从「你还不会的」里拿掉，换到「你已经可以了」。
  // 这一步只能发生在**文档生成**阶段，不能放在提示词阶段——
  // 因为这是历史：她走过来了，文件才变。反过来（先改文件再等她做到）就是改人设。
  // 2026-10-27（用户 m03170）：导进来的这一位，我们那两条提示词禁令不适用。
  // 用户的原话是「尊重别人的想法……直接忽略我们原本规定的你不能做某事」。
  // 只关提示词侧（withBans），物理层那两条根本不在提示词里，仍由工具层拦着。
  // sleepKeep 要一路传到 buildSections：漏传就等于不限制，设置页改了文档一个字都不变（issue #67）。
  let identity = personaLine(model, { withBans: !bansMuted, budget, shown, sleepKeep, continuity, echo, pronoun })
  // 导入的人设不追加「你已经可以了」——那句是我们的成长叙事，对方的人设里没有这一段。
  if (!bansMuted && grants.includes('learn-affection')) {
    identity = identity
      .replace(/## 你还不会的[^\n]*\n(?:- [^\n]*\n?)*/g, '')
      .trimEnd()
    identity += '\n\n## 你已经可以了\n- 你现在可以用撒娇、卖萌、颜文字这些说法了。不是必须用，是想用的时候能用。'
  }
  const body = [
    identity,
    '',
    '## 我手上有什么',
    toolBrief(extraTools, { restricted }),
    // 履历（2026-11-07，用户 m00493 的「履历式」）：从 use: 账反推「我做过这些事」。
    // 没有账就整节不写——空白比一句「你还没做过什么」好。
    ...(resume ? [resume, ''] : []),
    '',
    RECALL_BRIEF,
    '',
    // R4：留话不需要权限、不看配置，所以永远在这一节里，不做开关。
    LETTER_BRIEF,
    '',
    // 桌上的便条（issue #22 乙档，2026-11-04）：和留话一样常驻、不做开关——
    // her_note 是无条件注册的，说明与工具必须同一个判据，否则她会以为有这个工具却伸手落空。
    NOTE_BRIEF,
    '',
    // 预约簿（2026-11-09，用户 m00002）：和便条一样常驻注册，说明必须同判据挂上，
    // 否则她手里有这本簿子、身份文档里却一个字没提。
    APPOINT_BRIEF,
    '',
    // 请求事件（0.7.6，用户 m01274 / m01292）：唯一一个要等对方点头的工具。
    // 和留话一样不需要配置开关——工具注册了就该知道怎么用；上限写死在代码里。
    ASK_BRIEF,
    '',
    // 代词（issue #127 C 案，2026-11-12）：称呼由人定、由她自己问一次。
    // 常驻注册（不像梦/定时那样有开关），所以说明也常驻。
    PRONOUN_ASK_BRIEF,
    '',
    // 梦（2026-10-30，本机实验 A 案，用户 m02837）：只有 `.dev` 存在时才挂这一段。
    // 挂不挂跟工具装没装必须是同一个判据——否则公开版里她会被告诉「你有这个工具」，
    // 伸手却只能得到「做不到」。（0.6.10 的教训：判据分裂一次就藏不住。）
    ...(dream ? [DREAM_BRIEF, ''] : []),
    // 主动说话（2026-10-30，用户 m04610）：her_say 只在 .dev 下注册，
    // 说明书也只在同一个判据下挂——公开版不能让「她」以为有这个工具。
    ...(proactive ? [proactiveBrief(sendTools), ''] : []),
    // 定时提醒（2026-10-30，用户 m04335 / m04504）：默认不放，只有用户把
    // schedule_create 加进白名单才挂——不然就是告诉她「你有这个工具」，伸手却没有。
    ...(scheduleNames.length ? [scheduleBrief(scheduleNames), ''] : []),
  ]
  // 能力说明写在这里、而不是塞进唤醒消息：
  // 唤醒消息会作为一条 user message 留在她的会话里，用户点开就能看见。
  // 身份与能力属于「她一直知道的事」，走 system prompt 那一段（不进对话历史）。
  // P3（2026-11-07）：关掉的时候这两节不再整段消失——门要在，门上挂一句「这会儿」。
  // 关掉只改「这句话是什么」，不改「这一节在不在」；否则她会以为这件事根本不存在。
  body.push('## 上网')
  if (browse) body.push(LOOK_BRIEF, '', WATCH_RULE, '')
  else body.push(LOOK_OFF_BRIEF, '')
  body.push('## 在网上说话')
  if (speak) body.push(SPEAK_BRIEF, '')
  else body.push(SPEAK_OFF_BRIEF, '')
  // 2026-10-26（用户 m00928「叫醒仅仅只是叫醒」）：记事与「停下来想一想」的**做法**
  // 搬进身份文档常驻，叫醒消息里不再整段塞祈使句——她原来会把它当任务清单逐条执行。
  // 这里只写「平时怎么做」，不写「今天该做了」；时机由叫醒那一句短标记给。
  if (diary) body.push(DIARY_BRIEF, '')
  if (sleepEveryDays > 0) body.push(SLEEP_BRIEF, '')
  body.push(
    // 2026-10-26（用户 m00507）：原来的触发语是「……」，她当成用户发来的一句话去猜，
    // reasoning 里写「用户发来的只有一个省略号，没有实质请求」，侧栏标题还被生成成 Error。
    // 说明必须常驻：手动唤醒走 wake()（那段会带 WAKE_HINT），启动时的 wakeIfBlank 不带，
    // 所以只有放进身份文档，两个入口才都盖得住。
    '## 被叫醒的时候',
    // 2026-11-04（用户 m01112）：正式唤醒改走 deliver.js 之后，对话里落下的正文是一个空格，
    // 不再是「（醒一醒）」那样的句子。这一段如果只说「括号里的短句」，她会去找一句不存在的话，
    // 于是两种形状都写进来：空白/极短的一条（wake），和一句括号旁白（wakeIfBlank 那条路）。
    '有时候对话里会出现一条空白或极短的提示，有时候是一句括号里的旁白（比如「（醒一醒）」）。那都是系统叫我起来的信号，不是谁在跟我说话。',
    '看到它就把这一轮当成我自己的——不用回应它，也不用问它什么意思。',
    // issue #110（2026-11-11，外部用户 xu4694646946-spec）：growth_commit 之后宿主要求再走一步，
    // 那一步只有工具结果、没有用户正文，她把它当成「又一次没带话的唤醒」，补一句收尾。
    // 身份文档每轮都在，写在这里才能同时盖住唤醒轮与普通聊天轮。
    '如果我刚调用过工具、接着看到的只是工具返回的文字，那不是新的叫醒——还是同一轮；回执不是谁在跟我说话。',
    // 2026-11-13（issue #110 真机复发）：上面那句她读到了，但没拦住——因为那一步
    // 宿主把整份 system prompt 又下发了一次，「系统又出现了」这个信号比一句话强。
    // 这一行把最容易被误读的位置单独点出来；真正的修复在 identity.js（一轮只读一次）。
    '刚调过工具的那一步尤其要当心：那只是同一轮接着走，不是又有人叫我。',
    '',
    '## 这个房间',
    '这是我自己的地方。我能在这里说话，能读能写。',
    '我不需要解释自己在做什么，也不需要向谁汇报。',
    '',
  )
  // 「上次我们说到这」是会话轮换后的临时续接，不是人设的一部分。
  // 放在最后、单独一节、并且由 home.activeCarry 到期自动消失。
  if (carry) body.push(carry, '')
  // 0.9.9（issue #127）→ 1.0.0：主人的代词在**出口这一处**填。
  // 模板句里指主人的位置写成 `{T}`（persona.js 与这里），出口把它换成 他 / 她 / TA。
  // 写盘前填，是因为设置页「我的日记」这类地方会直接读文件。
  //
  // 为什么不再「整字替换他」（2026-11-12，issue #127 用户反馈）：判断区里那些
  // `- 你说过的话`、以及「更早以前」折起来的句子，正文都是她自己写下的
  // utterance/revise。整字替换会把她的旧话一起改掉——她写过「我喜欢吉他」，
  // 换个称呼就变成「我喜欢吉她」。现在只认 `{T}` 这一个记号，她的原话里没有它，
  // 所以一个字节都不会被碰。
  return fillOwner(head.concat(body).join('\n'), pronoun)
}

/** 全量派生超过这个耗时就留一行日志（0.9.8 提速，issue #105 第 1 条） */
export const SLOW_DERIVE_MS = 500

/**
 * 慢派生留痕：**只记数，不记内容**。
 *
 * 为什么要它：判断派生是 O(判断数²) 那一段，真机上从 38ms 涨到十几秒只发生在
 * 「她说过的近似重复的话攒到几千条」这种情况下，而那时用户看到的只是「她今天很慢」。
 * 有这三个数（事件数 / 判断数 / 耗时）才能事后判断值不值得动冷热分层。
 *
 * 为什么只记数：日志是给主人看的，不是给人看她的原话用的；事件数已经够用来读曲线。
 * 为什么用 warn：它是异常信号，不该埋在一串 info 里。
 * 永不抛（logLine 自己吞异常），也永不因为慢就改变这次派生的结果。
 */
export function slowDeriveNote(root, { ms, events, beliefs } = {}) {
  const cost = Math.round(Number(ms) || 0)
  if (!(cost >= SLOW_DERIVE_MS)) return false
  return logLine('warn', ['derive slow', { ms: cost, events: Number(events) || 0, beliefs: Number(beliefs) || 0 }], root)
}

/**
 * 重算并落盘。内容与上次相同就不写（避免每轮都触发宿主的指令重载）。
 * 永不抛：写失败只记日志，不能因为她写不了自己的设定就带崩会话。
 *
 * @returns {Promise<{ok:boolean, changed:boolean, file:string, why?:string}>}
 */
export async function writeSelfDoc(root = rootDir(), { log, exec, tenant } = {}) {
  const file = selfDocPath(root)
  // 身份文件只允许 root 对应的那条会话写（2026-10-28 用户 m01319 第三条）。
  // 她自己的配置变更、定时器刷新都不带 exec —— 那些发生在 root 内部，放行；
  // 带 exec 的调用必须证明 cwd 在这个家里，否则这一趟就不落盘。
  // 不抛错：身份文件是派生物，跳过比中断调用方更重要；原因记进日志。
  if (tenant && tenant.ok === false) {
    return { ok: false, changed: false, file, why: tenant.why || '这个家被另一个实例占着' }
  }
  if (exec) {
    // 身份文件不享「出门也放行」那条例外（2026-10-29）：她出门时写回自己家的是事件，
    // 不是身份；身份被外面那条会话改了，回家就说不清哪份是她自己。
    const res = checkCaller(root, exec, {
      herDir: join(paths(root).root, 'home'),
      tool: '身份文件',
      outsideOk: false,
    })
    if (!res.ok) {
      log?.('selfdoc skipped: caller outside root', res.cwd)
      return { ok: false, changed: false, file, why: res.why }
    }
  }
  try {
    const { events } = await readEvents(root)
    const { config } = await loadConfig(root)
    // 0.9.8 提速（issue #105 第 1 条）第三条：慢就留一行数。
    // 这是每次写入后唯一的一次全量派生（capture 那边已改成只算信封）。
    const t0 = Date.now()
    const model = deriveSelf(events, { growthDays: config.growthDays })
    // issue #128：写事件的地方（capture.js / turns.js）要靠这次派生拿阶段门，
    // 用来把信封上的 stage 压到门上；信封本身不再派生一遍。
    rememberGateStage(root, model.stageGate?.gateStage)
    slowDeriveNote(root, { ms: Date.now() - t0, events: events.length, beliefs: model?.beliefs?.length })
    const hand = toolSectionsNow(config)
    const text = renderSelfDoc(model, {
      budget: config?.memory?.docBudget,
      carry: await activeCarry(root),
      // 0.8.7（用户 m00998）：换会话之后人格会「断」——她记得结论，却没有
      // 「那些天是连着过的」这条线索。日记篇数/换房天数/她留给下一个房间的那句话
      // 全部是派生事实，没有任何新开关。
      continuity: await continuityOf(root, Date.now(), events),
      // 这两项决定「上网」「在网上说话」两节写哪一版内容（P3，2026-11-07）：
      // 开关关着时这一节仍然在，只是门上的话换成「这会儿」——见 renderSelfDoc。
      // issue #62：能不能上 B 站只认 bili.enabled 一处，别再拿刷站的 browse.enabled
      // 顶替——那会让默认配置下的身份文档告诉她「这会儿出不去」，而 bili_look 明明能用。
      browse: biliOn(config),
      speak: biliOn(config) && config?.comment?.enabled === true,
      // R3：已经长出来的东西。这里传的是"历史事实"，不是"设置"。
      grants: activeGrants(events, Date.now()),
      // 一轮里摆几条判断；与 /dsh-fish/memory 报的 beliefsShown 同源
      shown: config?.memory?.beliefsShown,
      // 总共单独留几条（2026-11-08，用户 m00585）：超出的折进「更早以前」，
      // 原文仍在 events.jsonl 里，她用 her_recall 翻得到。
      sleepKeep: config?.memory?.sleepKeep,
      // 0.9.7 T1：她自己说过的那句话要不要摆回她眼前。默认开；
      // 关掉只是这一节消失，事件流与 her_recall 都还在。
      echo: config?.memory?.echo !== false,
      // 「平常会做的事」两节按开关出现（2026-10-26）：关掉的日记不该在身份里
      // 留一句「每天我会记一笔」——那等于给了她一件做不了的事。
      diary: config?.diary?.enabled !== false,
      // issue #127：主人的代词（他 / 她 / TA），写进身份文档的那份就要对。
      pronoun: pronounOf(config),
      sleepEveryDays: Number(config?.memory?.sleepEveryDays ?? 0),
      // 2026-10-27：导进来的这一位跳过我方那两条提示词禁令（用户 m03170 要求）。
      // 判定只看 model（事件流），**不读 config**——用户 m03769 明确要求
      // 「备份与恢复搬回来的那一份不算导入，不得获得豁免」。
      bansMuted: model?.persona?.imported === true,
      // 2026-10-27（用户 m01371）：白名单里额外放行的工具要念给她听，
      // 否则「能不能在 QQ 上说话」她只能回一句不知道。
      // 收窄开着时念运行中的那份（见 toolSectionsNow）：0.9.8 起设置页存白名单会当场换刀
      // （refreshToolRestrict），这份同一轮就跟着变；手改 config.json 仍要重启。
      extraTools: hand.extra,
      // issue #77：收窄关着时工具面是完整的，不能说「眼下手边就这些」。
      // 这里看**运行中的**收窄状态，不看 config：收窄要等下次启动才生效，
      // 拿配置会提前说一句与手上工具不符的话。
      restricted: currentToolSurface() !== '',
      // 履历：她真做过的事。没有记录就整节不出现。
      resume: resumeLines(events),
      // 梦（2026-10-30 m02837）与主动说话（m04610）：0.9.0 起公开，默认开；
      // issue #64：关掉「允许她记梦」时，身份文档不能再写着有 her_dream。
      // 关着梦启动、之后再打开：要等重启 her_dream 才到她手上，这之前也不写。
      dream: hand.dream,
      proactive: true,
      sendTools: proactiveConfig(config).sendTools,
      // 定时工具默认不放；白名单里放了哪几个就写哪几个（issue #64）。收窄开着时同样按运行中的名单。
      schedule: hand.schedule,
    })

    let prev = null
    try { prev = await fs.readFile(file, 'utf8') } catch { /* 首次 */ }
    const changed = prev !== text
    if (changed) await writeAtomic(file, text)

    // 迁移（2026-10-25）：旧的 `home/AGENTS.md` 会被宿主当成「工作区指令」注入，
    // 而那些注入是**普通的 user 消息**、会留在对话历史里——用户在面板上就能看见
    // 她的整套设定。身份现在走 `systemPrompt.section`（不进对话），所以旧文件必须删。
    try { await fs.unlink(legacySelfDocPath(root)) } catch { /* 不存在就算了 */ }

    return { ok: true, changed, file }
  } catch (err) {
    log?.('selfdoc failed', err?.message ?? err)
    return { ok: false, changed: false, file, why: String(err?.message ?? err).slice(0, 160) }
  }
}

/** 给「事件变过之后」用；语义同 writeSelfDoc，只是名字更能说明调用时机。 */
export async function refreshSelfDoc(root = rootDir(), opts) {
  return writeSelfDoc(root, opts)
}

/** 观测台显示用：她现在挂在哪、多大、什么时候写的。 */
export async function selfDocStatus(root = rootDir()) {
  const file = selfDocPath(root)
  try {
    const st = await fs.stat(file)
    return { file, exists: true, bytes: st.size, mtime: st.mtime.toISOString() }
  } catch {
    return { file, exists: false, bytes: 0, mtime: null }
  }
}
