/**
 * restrict.js —— 只让她看见自己的工具（2026-10-24）
 *
 * ## 为什么要有这个
 *
 * 她的上下文里原本有 **37 个工具**，其中只有 6 个是本插件给的，另外 31 个是宿主
 * 标准工具集（shell、读写文件、联网搜索、定时任务、子代理、工作流……）。
 * 工具定义是每轮都要塞进上下文的东西，31 个用不上的定义意味着：
 *   ① 每轮白烧一大截 token；
 *   ② 她看得见"能跑命令""能写文件"，就真的可能去调 —— 这是"莫名调工具"的来源。
 *
 * ## 为什么走 tools.restrict，而不是 agentPreset
 *
 * `agentPreset` 那条路走过三次都失败（详见 docs/B-技术契约.md §24）：会话首行
 * 能写上 `agentPreset: fish-home`，但首轮 31 秒后宿主自己 append
 * `agent-preset/selected {agentPreset:'standard'}` 把它改回默认；把 preset 的
 * `plugins` 清空也仍然是 37 个工具。那条路是"全局组合"，不是"这个 agent 的视图"。
 *
 * `ctx.tools.restrict()` 才是对的那把刀。宿主自己的开发文档原话：
 *   「Hiding tools from one agent is `ctx.tools.restrict()` on that agent's
 *     context; it keeps schema presentation, lookup, and execution aligned.」
 *
 * 三个关键性质（都来自宿主源码，不是我猜的）：
 *   1. **必须有作用域**：`restrict()` 在无作用域的 ctx 上直接抛
 *      「requires a scoped context (agent.ctx): a context-global restriction
 *        would mask every agent」。→ 天然只影响那一个 agent，不碰用户自己的窗口。
 *   2. **只能减不能加**：`allow`/`deny` 编成 Set 后 append 到该 agent 的层上。
 *      所以"先给 6 个、真要再申请"做不到 —— 被挡掉的工具连名字都看不见。
 *      这正是我们想要的：她不需要"申请"，她本来就用不到那些。
 *   3. **名字必须存在**：`restrict()` 会拿 `restrictableNames` 校验，名字不认识
 *      就抛错（报错里还会列出全部已知工具名）。所以清单写死在这里，改错立刻炸，
 *      不会静默失效。
 *
 * ## 为什么留 read_image
 *
 * `bili_watch` 和 `/say` 的图片都只是**落一个文件路径**，真正"看见"要靠
 * `read_image` 读它。把它挡掉，她就又变回瞎子 —— 这是 P8 刚做出来的能力，
 * 不能因为收窄工具面把它一起收掉。
 *
 * 同理 **不给 `skill`**：一旦有它，`~/.dsh/skills` 里任何未审过的第三方内容
 * 都能进她上下文。将来要她用什么，就包一个形状固定的专用工具（像 bili_watch），
 * 不开通用口。
 */

import { resolve } from 'node:path'
import { homeFishTools, liveFishTools, sceneFishTools } from './toolreg.js'

/**
 * 插件自己注册的、家里随时能用的十二个工具。顺序无意义，但**必须全部真实存在**（名字错会抛错）。
 *
 * 这份表不只是「没有注册记录时的兜底」：真实启动里收窄先于工具注册
 * （`lib/index.js` 先 `registerToolRestrict`，工具到后面的 `withUseDuringRegistration` 才注册），
 * 那一刻注册记录必然是空的，她那条会话的 allow 就是照这份表算的。
 * 所以每一件无条件注册、家里能用的工具都得在这里——漏一件，她每次重启都够不着它
 * （0.9.5 的 her_say 就是这样：身份文档说她有，伸手却被守卫挡回来）。
 * 场景工具（`lib/toolreg.js` 的 `SCENE_TOOLS`，如 bring_back）不进这份表。
 * `test/restrict-boot.test.mjs` 按真实启动顺序钉着这件事。
 */
export const FISH_TOOLS = Object.freeze([
  'growth_commit', // 记下自己的想法（唯一的写入口）
  'her_recall', // 翻自己的旧事
  'her_diary', // 翻自己的日记（只读，issue #7）
  'her_leave', // 留一句话给他
  'her_note', // 把没做的事记到桌上（issue #22 乙档，2026-11-04）
  'her_appoint', // 跟他约一件几天后的事（通用预约簿，2026-11-08）
  'bili_look', // 看 B 站的列表
  'bili_watch', // 看一条视频的画面
  'bili_sub', // 查一条视频的字幕片段（1.0，她想知道"里面说了哪几句"）
  'bili_speak', // 在评论区说话
  'ask_owner', // 有事想征得同意（请求事件，2026-10-30 m01274）
  'ask_pronoun', // 问一次该怎么称呼主人（issue #127 C 案，2026-11-12）
  'her_dream', // 醒来记一句梦（本机实验 A 案，2026-10-30 m02837）
  'her_say', // 自己想说一句的时候用（0.9.0 起无条件注册，不看主动搭话开关）
])

/**
 * 宿主定时任务工具（2026-10-30，用户 m04335 / m04504）。
 *
 * 她可以自己给自己定提醒：主人说「明天中午 12:10 去看邮箱」这种话，
 * 剩下的由她自己 `schedule_create` 建任务；宿主到点把提醒投回她这条会话。
 *
 * **默认不放**：用户 m04504 明确要求默认工具数不变，谁想用定时任务，
 * 自己在设置页白名单里加名字。这里只留一份清单，供界面文案与测试引用；
 * 加进 `config.tools.allow` 之后才会进工具面、提示词段也会跟着挂。
 *
 * 不写进 `FISH_TOOLS`：这四个不是插件注册的，是宿主给的；自检按 registry 查。
 */
export const SCHEDULE_TOOLS = Object.freeze([
  'schedule_create',
  'schedule_list',
  'schedule_update',
  'schedule_delete',
])

/**
 * 她允许看见的工具。
 * `read_image` 由宿主某个插件提供，别人的机器上不一定装；缺了不影响她说话写字。
 * 定时任务默认不在里面——要就由用户加进 `config.tools.allow`（`SCHEDULE_TOOLS`）。
 */
export const HER_TOOLS = Object.freeze([...FISH_TOOLS, 'read_image'])

/**
 * 这一版**真的注册了**哪些工具（2026-11-08，用户 m00002）。
 *
 * 上面那两份常量是「没有活体注册记录时的基线」：注册走完之后清单由
 * `lib/toolreg.js` 在注册期记账，这里现算。注意收窄注册那一刻还没有记录，
 * 那时用的就是基线（见 `FISH_TOOLS` 的说明）。为什么不再以常量当唯一真源——
 * 手抄的表一定会漏（`bring_back`、`her_say` 就是这么漏的），漏了之后
 * 她自己那两件进不了 allow、设置页与自检也都不显示，看起来像「没这个工具」。
 *
 * @returns {string[]}
 */
export function fishToolsNow() {
  return liveFishTools(FISH_TOOLS)
}

/**
 * 设置页「她自己本来就有的（不用放行）」那一组，含宿主给的 `read_image`。
 * 只列**家里随时能用**的；出门才用得上的那几样由 {@link herSceneToolsNow} 单列。
 * @returns {string[]}
 */
export function herToolsNow() {
  return [...new Set([...homeFishTools(FISH_TOOLS), 'read_image'])]
}

/**
 * 「只在特定场合才交给她」的那几样，带场合说明（设置页单列一组，不进家里 allow）。
 * @returns {{name: string, scene: string, why: string}[]}
 */
export function herSceneToolsNow() {
  return sceneFishTools(liveFishTools(FISH_TOOLS))
}

/**
 * 「手边到底有什么」——写进 system prompt 的那一段（2026-10-29，用户 m01276）。
 *
 * 为什么光有 restrict/guard 还不够：restrict 按宿主源码只掩码 inherited 层，
 * 注册在 agent 自己作用域里的工具（dsh-ops 的 ops_*、Agent Teams 那几个）
 * 挡不掉，会**真的出现在她的工具表里**；宿主老版本还可能连 guard 都没有。
 * 工具定义进了上下文，模型就会倾向于把它当成「我能用」——唯一还能做的，
 * 是在提示词里把「哪几样真是我的」说死，并告诉她越界会得到什么回答。
 *
 * 与 guard 的话术保持一致：不说「权限/禁止」，只说伸手够不着。她该以为是自己做不到。
 *
 * @param {string[]} [names] 这一次真正放行的工具名
 * @returns {string} 空串表示这一层不挂（收窄关掉了，就别说「只有这几样」）
 */
export function toolSurfaceText(names = HER_TOOLS) {
  const list = [...new Set((names ?? []).map((s) => String(s).trim()).filter(Boolean))]
  if (!list.length) return ''
  // 0.8.5（用户 m02004 点的）：这一段以前写成「只有这几样」「别去调」，
  // 等于把她此刻的家当讲成了她的**上限**。可白名单是会长的——他随时能再放行几样，
  // 到时候她读到的还是「你不是干这个的」，就会自个儿把新工具劝回去。
  // 所以措辞改成两件事分明：
  //   ① 名字从 `names` 现算（本来就随白名单重算，不是硬编码）；
  //   ② 说明「这是此刻，不是永远」——添了新东西不需要重新认识自己。
  // 边界那条不能省：工具表里那些不是她的名字，认得出但不能冒充（这是真话，不是限制）。
  return [
    `现在手边能碰到的是这些：${list.join('、')}。`,
    '这是我此刻的家当，不是我的上限——{T}随时能再添几样进来，添了我就照着用，不必先把自己劝回去。',
    // 0.9.3（issue #54）一度在这里加了两行「只要不在上面那行里，就不是我的」「同一个名字
    // 反复伸手不会变得到手」，当天就撤了（2026-11-07，用户当场指出）。别再加回去：
    //   ① 「后面还跟着一行…」「话里给了清单，就照清单来」是在讲拒绝消息的内部结构——
    //      等于把脚手架亮给她看。她要以为自己够不着，不该知道背后有段话会附上来。
    //   ② 「别在一个名字上耗着」是在管她该怎么想。那是管理员口吻，这个插件不做那个。
    // 宿主 0.2.2 起 preset 工具落在 agent 自己的作用域里，工具表会突然多出一大片；
    // 这一段能做的只是把「那些不是我的」讲清楚，把 compress 这类新面孔补进举例里。
    '工具表里有时也列着别的名字（带 ops_、team_、subagent、workflow、skill、compress 这类），那些不是我的：认得出，但不冒充。',
    '真伸手去够它们，会得到一句「这件事我做不到」——不是我不肯，是够不着。',
    '有人问我手上有什么，我按当时有的说；以后变多了，就按变多了的说。',
  ].join('\n')
}

/** 提示词里当前该说的那份（registerToolRestrict 每次算完 allow 就刷新）。 */
let surfaceNow = toolSurfaceText()

/**
 * 「到手」要用的两样东西（2026-11-08，issue #58）。
 *
 * - `inHandAllow`：这一次注册的白名单（配置里的全量，守卫按它放行）。收窄关着、
 *   还没注册过时是 `null`——「不知道」与空数组（一个都没有）严格分开：收窄关着时
 *   她能看见全部工具，按空数组过滤会把所有愿望都当成「已经到手」。
 * - `herAgents`：她的 agent，按会话 id 记（`session-` 前缀抹掉，见 {@link sidKey}）。
 *   群聊分房也是她（cwd 一样），只记最后一个的话，叫醒用的就成了某间群房的工具表。
 *   `latestHer` 是最近建的那个，只给不指定会话的调用方用；指定了会话就只认那一条。
 * - `herSeen`：这一次注册见过的她（不按 id，按 agent 本身）。调度器探活时宿主把那条
 *   会话的 agent 交回来，是这一次见过的就直接按它算，不经过 id 写法与上限淘汰。
 *
 * 不存「到手」的快照，查的时候现算（见 {@link currentAllowTools}）：别的插件常在
 * agent 建好之后才挂工具（dsh-ops attach 时才 publish ops_*），快照会一直漏掉它们。
 * agent 只弱引用着：会话关了、宿主放手了，这里不替它留着一整条会话。
 */
let inHandAllow = null
const herAgents = new Map() // sidKey(sessionId) -> WeakRef<agent>，最近问到/建的在末尾
let latestHer = null // WeakRef<agent> | null
let herSeen = new WeakSet()
const HER_AGENTS_MAX = 16

/**
 * 这一次注册的现场（2026-11-11，外部用户反馈「改白名单要重启 DSH」）。
 *
 * 以前 `allow` 是 registerToolRestrict 里的 const，算一次用一整个进程；设置页存了
 * 新名单也只在下次启动才读到。宿主的 `restrict()` 返回的是 **the exact disposer
 * that lifts this restriction**（dsh-tools/lib/index.js），所以卡住我们的不是
 * 「宿主不让放宽」，而是我们自己没留着旧刀、也没人按新名单再下一刀。
 *
 * 这里记下这一局的白名单与现场；{@link refreshToolRestrict} 按它重算并换刀。
 */
let liveReg = null // { dream, say, onResult, allow }
/** agent -> { allowSet: Set<string>, disposeRestrict: (() => void) | null, gen: number } */
const agentRuntime = new WeakMap()

/**
 * 会话 id 的统一写法：宿主两处给的不一定一样（带不带 `session-` 前缀），
 * 与 identity.js 的 `wakeKey`、sessionnote.js 的比对同一个抹法。
 */
function sidKey(id) {
  return String(id ?? '').replace(/^session-/, '')
}

function agentSessionId(agent) {
  try {
    return sidKey(agent?.session?.header?.id ?? agent?.session?.id ?? '')
  } catch {
    return ''
  }
}

/** 记下一个新建的她（会话轮换、重启、群房）。同一条会话再建一次就换成新的。 */
function rememberHer(agent) {
  if (!agent) return
  herSeen.add(agent)
  const sid = agentSessionId(agent)
  const ref = new WeakRef(agent)
  herAgents.delete(sid)
  herAgents.set(sid, ref)
  latestHer = ref
  if (herAgents.size <= HER_AGENTS_MAX) return
  // 超了：先丢宿主已经放手的；还超，再丢最久没被问到的（查到时会挪到末尾，
  // 家里那条叫醒、劲儿常问，不会先被一串群房挤掉）。
  for (const [k, r] of herAgents) if (!r.deref()) herAgents.delete(k)
  while (herAgents.size > HER_AGENTS_MAX) herAgents.delete(herAgents.keys().next().value)
}

/**
 * 按会话找她。指定了会话就只认那一条：没见到返回 `null`，**不**拿最近建的那个顶——
 * 重启后家里那条冷着、群房先活着时，最近建的是群房；群房不带家里的 preset，工具表不一样，
 * 拿它顶会把家里没有的东西算成到手、家里有的算成没到手。
 * 只有调用方什么都没指定时，才按最近建的那个答。
 */
function herFor(sessionId, agent) {
  if (agent && herSeen.has(agent)) return agent
  const sid = sidKey(sessionId)
  if (sid) {
    const ref = herAgents.get(sid)
    const got = ref?.deref()
    if (!got) {
      if (ref) herAgents.delete(sid)
      return null
    }
    herAgents.delete(sid)
    herAgents.set(sid, ref)
    return got
  }
  if (agent) return null
  return latestHer?.deref() ?? null
}

/**
 * 启动时白名单里额外放行的那几个名字（身份文档「还放行了这几样」那句用，issue #64 的后半）。
 *
 * 跟 `inHandAllow` 同一刻定下，`null` 同样是「收窄这一局没在管」。
 * 不拿 `inHandAllow` 减去「她自己的」现算：她自己的那份按注册记录现算，工具注册前后不一样
 * （新进程里 her_say 注册之前不在基线里），同一个进程里那句话会先念 her_say、后来又不念。
 */
let allowExtra = null

/**
 * 被挡住时她读到的那句话（0.9.3，issue #54）。
 *
 * 以前只有一句「这件事我做不到。」——issue #54 里那位宿主把 preset 工具塞进 agent
 * 自己的作用域之后，她连着十七次伸手去够 `compress`，每次只拿到同一句，看不出
 * 「我手上根本没有它」。模型看不到真实清单，就会把「没试对」当成「再试一次」。
 *
 * 所以把此刻真有的东西再说一遍——但她本来就从 `toolSurfaceText` 第一行看得见自己
 * 有什么，这里只是同一件事的复述，不是新信息、更不是「被批准的名单」。
 *
 * **口气必须是第一人称**（2026-11-07 用户当场纠过一次）：写成「你现在的工具只有：…」
 * 读起来像有人发给她一份许可清单，等于告诉她头上有人。改成「我手上没有这样东西，
 * 能用的只有…」——同一份清单，说的是自己，不是被通知。
 * 前缀仍然是那句「这件事我做不到。」——界面、日志、别的守卫都按它认。
 *
 * @param {string[]} names 这一次真正放行的工具名
 */
export function blockedTalk(names = []) {
  const list = cleanNames(names)
  // 2026-11-07（用户 m01602 拍板 B）：撞墙的那一下才说这一句。
  // 原来「缺工具就开口要」是每次醒来都摆在正文里的常量，现在只在这里出现一次——
  // 真伸手被挡住的时候，她才知道这件事有路可走；没伸手的时候不必提醒她。
  // 只给路，不派活：不说「你应该去要」，只说「说出来就行」。
  if (!list.length) return '这件事我做不到。要是你确实想要，说出来就行。'
  return `这件事我做不到。我手上没有这样东西——能用的只有：${list.join('、')}。要是你确实想要，说出来就行。`
}

/**
 * 读**家里**那份提示词段。收窄关着时是空串。
 *
 * 注意这只是「她在家」的答案。出门那条会话必须用 `toolSurfaceFor()`——
 * 见下面 0.7.3 的说明。
 */
export function currentToolSurface() {
  return surfaceNow
}

/**
 * 她此刻手上有的工具名（issue #58，2026-11-08）。
 *
 * 为什么「有没有到手」只能拿白名单回答：`need-tool` 卡本身不落实任何权限
 * （见 `lib/ask.js` 文件头第 2 条）。他真要给，只能在卡外面给——装插件、把这
 * 个名字加进白名单——事件流里一个字都不会记。所以摆那张桌子时按这份清单对一遍，
 * 已经到手的那几条就不用再摆「他答应了，还没见到」。
 *
 * 但白名单里写了不等于手上有：宿主没装 `read_image`、白名单里的桥工具没装上，
 * 这些名字都不会下给宿主（见 onCreated 的 `skipped`）。0.9.5 直接拿配置当答案，
 * 她要一样还没来的东西，那张卡一开就从桌上撤掉了。
 *
 * 所以按她那个 agent **此刻**的工具表现算：白名单 ∩ `view(agent).visible`。
 * 收窄下去以后 visible 就是她真看得见的；守卫放行的是白名单全量，两者的交集就是
 * 她伸手够得着的。收窄还在重试、或一直没收窄成时，visible 是宿主的全部工具，
 * 交集同样对。晚挂上的 own 层工具（ops_*）查的那一刻在 visible 里，也就算进来了。
 *
 * 拿不到就返回 `null`（收窄关着、还没注册过、指定的那条会话还没见到、宿主给不出工具表）：
 * 调用方那时不做任何过滤。反过来，空数组是「真的一件都没有」，不能当成「不知道」。
 *
 * 重新注册（插件在同一个进程里再跑一次）之后，之前的她一个都不认：那些 agent 身上
 * 挂的守卫与收窄是上一次注册下的（或已随插件卸掉），这一份白名单说不准她们够得着什么——
 * 比如白名单新加了一个 own 层的名字，旧守卫照样拦它。这时返回 `null`，宁可多摆一条，
 * 等下一个她建出来再答。
 *
 * @param {string} [sessionId] 按哪条会话的 agent 算（叫醒、主动回合、劲儿传家里那条）。
 *   指定了就只认这一条，没见到返回 `null`；不指定时按最近建的那个她。
 * @param {{agent?: object}} [opt] 宿主刚交回来的那条会话的 agent（探活拿到的）。
 *   这一次注册见过它就直接按它算，不经过会话 id。
 * @returns {string[]|null}
 */
export function currentAllowTools(sessionId = '', { agent = null } = {}) {
  if (!inHandAllow) return null
  const her = herFor(sessionId, agent)
  if (!her) return null
  const seen = visibleToolsOf(her)
  if (!seen) return null
  const got = new Set(seen)
  return inHandAllow.filter((n) => got.has(n))
}

/**
 * 这一局她真看得见的工具名（收窄关着时就是宿主给她的全部）。
 *
 * 只给「已经见到她的 agent」时用：收窄关着时 {@link currentAllowTools} 返回 `null`
 * （不知道该不该按白名单筛），可「她手上有没有这件东西」仍然有答案——她这一局的
 * 工具表就是答案。2026-11-09 用户拍板的 #58 遗留：以前这里把 `null` 当成「没有」，
 * 心事卡要的东西明明已经能用了，还摆到窗口过期。
 *
 * 拿不到她的 agent 仍返回 `null`：不知道就不筛，宁可多摆一条。
 * @param {string} [sessionId] 按哪条会话的 agent 算。
 * @param {{agent?: object}} [opt] 宿主刚交回来的那条会话的 agent。
 * @returns {string[]|null}
 */
export function visibleAllowTools(sessionId = '', { agent = null } = {}) {
  const her = herFor(sessionId, agent)
  if (!her) return null
  const seen = visibleToolsOf(her)
  return seen ? [...seen] : null
}

/**
 * 配置里放行的那份白名单（收窄关着、还没注册过时是 `null`）。
 *
 * 只给「还核实不了」时当临时答案用：重启后她那条会话是冷的，agent 要等第一次被叫起来
 * 才建，在那之前 {@link currentAllowTools} 给不出答案。劲儿那一处拿它顶（见
 * scheduler.js 的 `toolInHandNow`），桌上摆什么仍旧只按核实过的算。
 *
 * @returns {string[]|null}
 */
export function configuredAllowTools() {
  return inHandAllow ? inHandAllow.slice() : null
}

/**
 * 这一局收窄名单里来自白名单的那几个（按配置里的顺序，去重去空白）。
 * 收窄关着、或还没注册过时是 `null`。
 * @returns {string[]|null}
 */
export function currentAllowExtra() {
  return allowExtra ? allowExtra.slice() : null
}

/** 归一化一份工具名：去重、去空白、排序（顺序稳定，提示词前缀才对得上缓存）。 */
function cleanNames(names) {
  return [...new Set((names ?? []).map((s) => String(s ?? '').trim()).filter(Boolean))].sort()
}

/**
 * 出门在外那一段「手边有什么」——**按那个 agent 此刻真看得见的工具现算**（0.7.3）。
 *
 * 为什么不能复用家里那份（真机问题，用户 m00339 点出来）：
 *   家里那份是 `currentToolSurface()`，也就是**配置里的白名单**（HER_TOOLS + 额外放行）。
 *   它被挂在 module 级单例 `surfaceNow` 上，只由 `registerToolRestrict` 写过一次。
 *   而 `fish:tools` 这一段是 `attachIdentity()` **无条件**挂的——出门那条会话照样挂，
 *   于是她人在别人工作区、手里握着那个工作区的全部工具，system prompt 里却写着
 *   「我手边能用的东西只有这几样：growth_commit、her_recall…」并且明说
 *   「工具表里如果还列着别的名字…那不是我的：别去调」「真伸手去用，只会得到一句
 *   『这件事我做不到』」。
 *
 *   事实是：出门时 `restrict()` 根本不下（`isHerAgent` 为假就直接 return，见本文件
 *   后面的 onCreated），`attachAwayGuard()` 也只比对调用参数里的路径、不看工具名。
 *   所以她**调得动**那些工具 —— 是提示词把她自己劝住了。出门打工这个场景
 *   于是退化成「她只会用那 8 个鱼工具」，而请神反而没这一段（possess.js 不挂
 *   fish:tools），比出门还放得开。
 *
 * 这里的立场：出门在外，能用什么由**那个工作区**决定，不由家里的白名单决定。
 * 所以按 `agent.ctx.tools.view(agent)` 里此刻 visible 的名字现念一遍，并明说
 * 「出来就是来干活的」——把 0.7.2 之前那句「别去调」彻底拿掉。
 *
 * @param {string[]} names 这个 agent 此刻真看得见的工具名
 * @returns {string} 空串表示这一层不挂（拿不到工具表时宁可不说，也不要瞎说）
 */
export function outsideSurfaceText(names = []) {
  const list = cleanNames(names)
  if (!list.length) return ''
  return [
    `这趟在外面，手边能用的是这些：${list.join('、')}。`,
    '这里不是我的屋子，能用什么由这个工作区给：工具表里列着、也在这份清单里的，我都可以直接调。',
    '出来就是来干活的，别因为「这不是我家的东西」就推说做不到。',
    '只有伸手回我自己屋子这一条不行——那会得到一句「这件事我做不到」。',
  ].join('\n')
}

/**
 * 读某个 agent 此刻看得见的工具名。拿不到返回 `null`。
 *
 * 「拿不到」必须与「没有工具」分开：`null` 时调用方不说话，而不是告诉她「一样都没有」。
 * 优先用 `visible`（真正的工具表）；老宿主没有 visible 才退回 `restrictableNames`。
 */
export function visibleToolsOf(agent) {
  try {
    let view = null
    try { view = agent?.ctx?.tools?.view?.(agent) ?? null } catch { view = null }
    // 兜底：老宿主/别的实现只接受无参调用（与 refreshFrom 同一套两条路）。
    if (!view) {
      try { view = agent?.ctx?.tools?.view?.() ?? null } catch { view = null }
    }
    if (!view) return null
    const visible = cleanNames(namesOf(view.visible))
    const names = visible.length ? visible : cleanNames(namesOf(view.restrictableNames))
    return names.length ? names : null
  } catch {
    return null
  }
}

/**
 * 某条会话该看到的那段「手边有什么」。
 *
 * - 在家里（cwd 就是 herDir）：说家里那份白名单 —— 收窄真的在下，她确实只有那几样。
 * - 在外面（出门那条会话）：按她此刻真看得见的工具现算，见 `outsideSurfaceText`。
 *
 * `herDir` 缺省时退回家里那份（老调用点/单测兼容）。生产上的两个调用点都传了。
 */
export function toolSurfaceFor(agent, { herDir = '' } = {}) {
  if (!herDir || isHerAgent(agent, herDir)) return currentToolSurface()
  const names = visibleToolsOf(agent)
  return names ? outsideSurfaceText(names) : ''
}

/** 归一化目录，用于判断"这条会话是不是她的屋子"。Windows 大小写不敏感。 */
function normDir(p) {
  if (!p) return ''
  let s = String(p).replace(/[\\/]+$/, '')
  try {
    s = resolve(s)
  } catch {
    /* 保持原样 */
  }
  return process.platform === 'win32' ? s.toLowerCase() : s
}

/**
 * 判断这个 agent 是不是"她"。
 *
 * 判据用 **cwd** 而不是 sessionId：会话会轮换（`chat.rotateAfter`），
 * 轮换后 sessionId 变了，但 cwd 永远是她的屋子。用 sessionId 判断的话，
 * 轮换一次限制就悄悄失效了 —— 那是最难发现的那种 bug。
 */
export function cwdOf(agent) {
  return (
    agent?.session?.header?.cwd ??
    agent?.header?.cwd ??
    agent?.session?.cwd ??
    ''
  )
}

export function isHerAgent(agent, herDir) {
  const want = normDir(herDir)
  if (!want) return false
  return normDir(cwdOf(agent)) === want
}

/**
 * 「她在自己屋里」——**只**认她自己的 cwd。决定工具面收窄用这条。
 *
 * 出门时她人在别的工作区，那儿的权限是那个工作区给的，不该被这里收窄；
 * 要收窄的那只手（白名单）只在她家里生效，出了门就按别人家的规矩来。
 */
export const isHerHome = isHerAgent

/**
 * 「她是她」——在家，或者正出门待在那个工作区里。决定**身份挂载**用这条。
 *
 * 与 isHerHome 分开，是因为两件事的正确答案不同：
 * - 收窄问「这是不是她的屋子」→ 出门了答否；
 * - 身份问「这是不是那一位」→ 出门了仍然是，否则她在外面会失去全部来历。
 *
 * 请神不走这条：请神是临时借用别人的人，身份由请神那套单独挂。
 */
export function isHerAnywhere(agent, herDir, extraDirs = []) {
  if (isHerAgent(agent, herDir)) return true
  const got = normDir(cwdOf(agent))
  if (!got) return false
  return (extraDirs ?? []).some((d) => {
    const want = normDir(d)
    return want && want === got
  })
}

/**
 * 注册限制。**必须在任何 agent 被创建之前调用**（`agent/created` 是同步串行监听，
 * 在会话开始跑第一步之前完成），所以 index.js 里放在 ensureHer 之后、
 * bootstrapHome 之前。
 *
 * @param {object} ctx    插件 context
 * @param {object} opts
 * @param {string} opts.herDir    她的屋子（会话 cwd）
 * @param {string[]} [opts.extra] 用户在设置页额外放行的工具名
 * @param {boolean} [opts.enabled=true]
 * @param {(msg: string, err?: unknown) => void} [opts.log]
 * @param {(info: object) => void} [opts.onResult] 记录"这次真的挂上没有"（给自检用）
 */
export function registerToolRestrict(ctx, { herDir, extra = [], enabled = true, log, onResult, retryMs = 200, retryMax = 15, dream = false } = {}) {
  // 无论调用方传不传 onResult，模块级单例都要更新——自检读的是它。
  const __raw = onResult
  onResult = (r) => { report(r); try { __raw?.(r) } catch { /* ignore */ } }
  const say = log ?? (() => {})
  if (!enabled) {
    say('[dsh-fish] 工具面收窄：关闭（配置里关掉了）')
    liveReg = null
    // 收窄关掉时，提示词里也不能说「只有这几样」——那会跟她眼前看到的对不上。
    surfaceNow = ''
    // 她这时能看见全部工具：「不知道」与「一件都没有」必须分开（issue #58）。
    allowExtra = null
    inHandAllow = null
    herAgents.clear()
    latestHer = null
    herSeen = new WeakSet()
    onResult?.({ ok: false, applied: 0, why: 'disabled', allow: [] })
    // 收窄关着也照旧记下她这一局的 agent（2026-11-09，用户 m01451 的 ①）：
    // 心事卡问「要的东西到手没有」不走白名单，直接看她这一局真看得见的工具
    // （`visibleAllowTools()`）；不收窄就一个 agent 都不记，那边永远答「不知道」，
    // 卡照旧摆到窗口过期——这正是 issue #58 关掉收窄后复现的那一半。
    const off = ctx.on?.('agent/created', ({ agent } = {}) => {
      try {
        if (isHerAgent(agent, herDir)) rememberHer(agent)
      } catch { /* 认不出就算了，界面会退回只查拼写 */ }
    })
    return () => {
      try { off?.() } catch { /* ignore */ }
    }
  }

  // 家里随时能用的那些：**从注册记录现算**，不再照抄 FISH_TOOLS
  // （2026-11-08，用户 m00002：手抄的表会漏——bring_back 与 her_say 就是这么漏掉的，
  // 界面永远显示旧的那几样，她自己那两件也进不了 allow）。
  // 还没有注册记录时退回 FISH_TOOLS 那份基线。**生产上走的就是这一支**：
  // index.js 先调这里、后注册工具，这一刻注册记录还是空的。她的会话可能在工具注册之前
  // 就建好（bootstrapHome 早于注册），这时宿主还没有这些名字——基线里的名字算「我方的」，
  // 下面 bucket() 把没到的归进 missing，restrict 延后重试到它们注册上为止；
  // 守卫在第一拍就按这份 allow 放行。所以 allow 对不对只看基线全不全，跟时序无关。
  // 梦（issue #64）：关掉「允许她记梦」时 her_dream 不进 allow。
  const live = liveFishTools(FISH_TOOLS)
  // 用 herToolsNow() 而不是 homeFishTools()：宿主给的 read_image 也在 allow 里
  // （她看画面要靠它）。以前这里拿的是 HER_TOOLS，含 read_image；换成现算时漏掉的话，
  // 她会突然看不了图，而白名单界面还写着「read_image 也留着」。
  //
  // her_say 不看主动搭话开关（0.9.0 起它无条件注册）：那个开关管的是「系统替她开一轮」，
  // 不是这个工具本身。0.9.5 这里只在注册记录里有 her_say 时才补它，可这一刻记录是空的，
  // 每次重启她都够不着 her_say；现在它在 FISH_TOOLS 基线里，不用再单独补。
  const herNow = herToolsNow().filter((n) => n !== 'her_dream' || dream)
  const extraNames = [...new Set(extra.map((s) => String(s).trim()).filter(Boolean))]
  const allow = [...new Set([...herNow, ...extraNames])]
  // 先让提示词跟上这一次的白名单，再谈 restrict 挂没挂上：
  // 就算 restrict 因名字没登记而延后，这一段也已经说清了「多出来的不是你的」。
  surfaceNow = toolSurfaceText(allow)
  // 「到手」不在这里定（issue #58）：配置里写了，宿主上不一定有。这里只记白名单，
  // 到手多少等查的时候按她的 agent 现算。之前记下的 agent 不是这一次的守卫与收窄管的，
  // 替它们担保不了，忘掉，等下一个她建出来。
  inHandAllow = allow.slice()
  allowExtra = extraNames.slice()
  liveReg = { dream, say, onResult, allow: allow.slice() }
  herAgents.clear()
  latestHer = null
  herSeen = new WeakSet()
  let applied = 0
  let failed = ''

  const onCreated = ({ agent } = {}) => {
    // 白名单读当下的那一份（2026-11-11）：设置存盘后 refreshToolRestrict 会先换好
    // live.allow，之后新建的会话（轮换、群房、冷会话补挂）立刻跟上，不用重启。
    const allow = liveReg ? liveReg.allow.slice() : []
    // 顺手记一份「她这个 agent 认得哪些工具名」（2026-10-24）：
    // 白名单输入框靠它判断名字真假。必须在 restrict 之前取——取的是还没被收窄的视角。
    //
    // 关键：必须把 agent 传进 view(agent)。宿主源码注释写得很清楚：
    //   view(scope) —— "the viewing scope (the agent), or undefined for the global view"
    //   "Once presets moved them onto the agent plane they became an ANCESTOR contribution"
    // 也就是说 read / write / bash / skill 这些是由 preset 挂在**agent 的祖先层**上的，
    // 不在 global 层。不传 agent 拿到的是 global view，只有插件自己注册的那几个
    // （实测 7 个，没有 skill）——用它做校验会把 skill 误判成「不存在」。
    try {
      if (agent) lastAgent = agent
      refreshFrom(agent)
    } catch { /* 拿不到就算了，界面会退回只查拼写 */ }
    try {
      if (!isHerAgent(agent, herDir)) return
      // 记下这个她（issue #58）：「到手」按她这条会话的工具表现算，不沿用上一个 agent 的。
      rememberHer(agent)
      const scopedTools = agent?.ctx?.tools
      // ---- 分两桶（2026-10-29）----
      // `restrict()` 只认 `restrictableNames`（inherited 层）。own 层看得见却点不了名
      // （dsh-ops 的 ops_*、别的插件按会话注册的工具都在这里）；把它们塞进 allow，
      // 宿主会抛 `names unknown global tool "ops_bash"`，整条收窄当场失效。
      // 所以：restrict 只下发「收得窄的」，guard 与提示词用配置里的全量。
      // 白名单里写 ops_bash 的意思因此变成「守卫放行它」——它本来就挡不住。
      const bucket = () => {
        let restrictable = new Set()
        let visible = new Set()
        try {
          const v = agent?.ctx?.tools?.view?.(agent) ?? null
          const rn = namesOf(v?.restrictableNames)
          if (rn.length) restrictable = new Set(rn)
          const vn = namesOf(v?.visible)
          if (vn.length) visible = new Set(vn)
          // 顺手把此刻的工具表记进快照：这一刀落下时它认得的名字，就是白名单该认的名字。
          if (v) rememberFromView(v)
        } catch { /* 拿不到就退回全量，交给下面的 catch + 延后重试 */ }
        // 四桶：收得窄的 / 看得见但点不了名的（own 层）/ 我方还没登记完的 / 别人的名字。
        // 只有第一种能下给 restrict()；第三种说明宿主还没登记完，必须延后——
        // 静悄悄只收窄一半，会让她永久少一只手（0.6.0 真机事故）。
        //
        // 第四种（issue #61）：`read_image` 是宿主给的可选能力，`config.tools.allow` 里
        // 也可能是桥工具的名字——不是我们自己注册的，这台机器上没有就是没有。
        // 旧实现把它们也算进 missing，于是每次都抛错、延后、然后再等，一次都收不窄
        // （`herToolsNow()` 恒含 read_image，宿主没这个工具就成了永久死结）。
        // 现在只等「我方确实会注册的名字」，别人的名字这次剔掉、记一行日志。
        // own 层的名字本来就不受 allow 影响，剔掉它不会让谁少一只手。
        //
        // 宿主老版本（或 view 没给 visible）只报 restrictableNames：那时分不清别人的名字是
        // 「这次没注册」还是「在 own 层」。可这两种 restrict 都点不了名——交给它只会让它
        // 每拍都抛错，15 拍后一次都没收窄（issue #61 在这种宿主上的样子）。所以不是我们自己
        // 注册的名字，照样按 restrictableNames 剔掉：真在 own 层的，她照样看得见、守卫也放行。
        // 剔之前先宽限几拍（见下面第一拍那段）：晚注册的外部名字等得到就收进来。
        // 我们自己的名字不在 restrictableNames 里，仍然当「还没登记完」等下去。
        // view 一个名字都没给时什么都判断不了，才把全量交给 restrict（老行为）。
        const split = visible.size > 0 && restrictable.size > 0
        const named = restrictable.size > 0
        const ours = new Set(live)
        const seen = (n) => restrictable.has(n) || visible.has(n)
        // 分不清的时候（没给 visible），我们自己的名字照旧交给 restrict 试一把：没登记它会抛错，
        // 走下面的延后重试；重试时 missing 不空就不下，等自己的名字都进了 restrictableNames 才收。
        const forRestrict = split
          ? allow.filter((n) => restrictable.has(n))
          : named ? allow.filter((n) => ours.has(n) || restrictable.has(n)) : allow.slice()
        const missing = named ? allow.filter((n) => ours.has(n) && !seen(n)) : []
        const skipped = named ? allow.filter((n) => !ours.has(n) && !seen(n)) : []
        // sure：view 给了 visible，两边都没有才说得准「这台机器上这次没有」。
        return { restrictable, visible, forRestrict, missing, skipped, sure: split }
      }
      let { forRestrict: allowForRestrict, missing: missingNow, skipped: skippedNow, sure: skippedSure } = bucket()
      // 只念一次：重试时同一批名字会再算一遍，别把日志刷满（issue #61）。
      let skippedTold = false
      const noteSkipped = (names) => {
        if (skippedTold || !names.length) return
        skippedTold = true
        say(skippedSure
          ? `[dsh-fish] 工具面收窄：这几个名字这台机器上没有，这次不列进去（${names.join('、')}）`
          : `[dsh-fish] 工具面收窄：这几个名字不在 restrict 认得的名单里，没交给它（${names.join('、')}；可能这次没注册，也可能在她自己那一层，照常收窄）`)
      }
      if (!scopedTools?.restrict) {
        failed = '宿主的 agent.ctx 上没有 tools.restrict（版本不支持）'
        say(`[dsh-fish] 工具面收窄失败：${failed}`)
        onResult?.({ ok: false, applied, failed, why: 'failed', allow })
        return
      }
      // ---- 兜底的一道 guard ----
      //
      // restrict 挡不住「注册在 agent 自己作用域里的工具」。宿主源码原话：
      //   if (own !== void 0) for (const [name, definition] of own.tools.entries()) {
      //     knownNames.add(name); visible.set(name, definition)   // ← 不过 admits
      //   }
      // 也就是说 inherited（全局/祖先）里的工具会被掩码，而 own 层的不受 allow/deny 约束。
      // 实测漏出来的就是 `subagent` —— 她能借它派生一个拥有全部工具的子 agent，
      // 等于一条现成的逃生通道（2026-10-24 真机，37→8 之后只剩它）。
      //
      // guard 是同步的、只 deny 不放行，且注册在 agent.ctx 上就只作用于这个 agent。
      // 两者分工：restrict 管「看不见」，guard 管「看见了也跑不了」。
      //
      // 2026-10-25：顺序改成**先挂 guard、再下 restrict**。真机日志里出现过一次
      // restrict 因「名字还没登记」抛错，整段进 catch，连兜底守卫都没挂上——
      // 那一条会话等于全开。guard 不依赖名字表，先挂它，restrict 再想办法。
      // 这条 agent 的运行时把手（2026-11-11）：守卫读 `rt.allowSet`、restrict 的退路
      // 记在 `rt.disposeRestrict`，热更新时原地换名单、换刀，不用等重启。
      const rt = { allowSet: new Set(allow), disposeRestrict: null, gen: 0 }
      agentRuntime.set(agent, rt)
      // agent 销毁时收回最后那把刀（旧刀在换的时候已经当场 disposed）。
      try {
        agent.ctx.effect?.(() => {
          try { rt.disposeRestrict?.() } catch { /* ignore */ }
        })
      } catch { /* ignore */ }
      let blocked = 0
      // guard 是**兜底**，不是主刀。宿主老版本可能没有它（这时 restrict 仍然生效，
      // 只是漏在 own 层的那一个挡不住）。所以缺席只记一笔，不能因此判定"没挂上"。
      let guardOk = typeof scopedTools.guard === 'function'
      if (guardOk) {
        try {
          const disposeGuard = scopedTools.guard((exec) => {
            const name = exec?.name
            if (!name || rt.allowSet.has(name)) return undefined
            if (blocked < 20) {
              blocked += 1
              // 2026-10-29（用户 m02241）：以前只写工具名，没有会话 id、也没有实参。
              // 事后要判断「她当时拿到的是不是那份过期名单」「这个工具是从哪层漏出来的」，
              // 光一个名字不够。这里补上会话 id 与实参摘要（实参走 scrub，凭据照样抹）。
              const sid = String(exec?.agent?.session?.header?.id ?? exec?.agent?.session?.id ?? exec?.session?.header?.id ?? '') || '?'
              let argBrief = ''
              try {
                const a = exec?.arguments ?? exec?.args ?? exec?.input ?? exec?.params
                if (a && typeof a === 'object') argBrief = JSON.stringify(a).slice(0, 200)
              } catch { argBrief = '' }
              say(`[dsh-fish] 挡住了一次不该有的调用：${name} · session=${sid}${argBrief ? ` · ${argBrief}` : ''}`)
            }
            // 名字单独记一份（2026-11-04，issue #20）：日志里是给开发者看的，
            // 这里是给**设置页与自检**看的——用户得有一个地方知道「白名单还差哪个名字」。
            noteBlocked(name)
            // 话术刻意不带「权限/禁止/违规」这类系统词——她要以为是自己做不了，
            // 不是以为背后有个管理员在拦她。
            //
            // 0.9.3（issue #54）：把此刻的清单附在后面。宿主 0.2.2 起 preset 工具
            // 落在 agent 自己的作用域里，restrict 收不窄，她能看见却调不动；
            // 只说一句「做不到」，她就会换着名字接着试（真机连试 17 次）。
            // 清单也必须读当下那份：白名单存盘后她再伸手，得到的清单要跟着换，
            // 否则她会按旧清单一直挑已经放行的名字（2026-11-11）。
            return blockedTalk([...rt.allowSet])
          })
          try {
            agent.ctx.effect?.(() => disposeGuard)
          } catch {
            /* 同上 */
          }
        } catch (err) {
          guardOk = false
          say(`[dsh-fish] 兜底守卫没挂上（restrict 仍然生效）：${String(err?.message ?? err).slice(0, 160)}`)
        }
      } else {
        say('[dsh-fish] 这个宿主版本没有 tools.guard，只能靠 restrict')
      }

      // ---- 主刀：restrict ----
      // 只写 allow：不在清单里的一切都被挡掉。
      // 不用 deny 白名单是因为"宿主将来新增一个工具"时，allow 自动把它挡在外面，
      // 而 deny 会默认放行 —— 前者是我们想要的方向。
      const applyRestrict = (names) => {
        const dispose = scopedTools.restrict({ allow: names })
        // 先下新刀，再收旧刀：换的这几毫秒里总有一把在岗（2026-11-11）。
        // 只留最新那把；agent 销毁时由上面那个 effect 收回。
        const old = rt.disposeRestrict
        rt.disposeRestrict = dispose
        rt.knifeKey = names.join('\n')
        try { old?.() } catch { /* ignore */ }
        return dispose
      }
      try {
        // 2026-11-11（用户拍板的 B 方案）：名字没齐时不再「整段不收窄」。
        // 0.9.8 真机：13 件变 101 件，compress 那一轮就是这么露出来的。
        // 现在分两步：
        //   ① 先把**宿主此刻真认得、而且确认是她自己的**名字下成窄刀；
        //   ② 每 200ms 再对一次名册，齐了就换成完整名单（先下新刀再收旧刀）。
        // 等满 retryMs×retryMax（默认 3 秒）还不齐，就把窄刀也撤掉、全开：
        // 这一局只靠 guard 拦调用，下次会话再试。
        // 为什么窄刀只许用「真认得的」：0.6.1 的事故就是拿一张缺名字的清单去收，
        // 她永久少一只手（restrict 只能减、收错没有回头路）。
        const absentGrace = 3
        let readyTick = -1
        let tries = 0
        let narrowKey = ''
        let narrowTold = false
        const myGen = rt.gen
        const applyNarrow = (again) => {
          // 只挑 restrict 此刻认得的名字；一个都没认得就不下空刀（那是 C 方案，
          // 用户明确不要——她连 read_image 都没有，比多看见几件更糟）。
          const known = allow.filter((n) => again.restrictable.has(n))
          const key = known.join('\n')
          if (!known.length || key === narrowKey) return
          try {
            applyRestrict(known)
            narrowKey = key
            applied += 1
            // 窄刀也是真下过的一把刀：界面/自检读 effective 时不能还停在「没下过」。
            onResult?.({ ok: true, applied, why: 'narrowed', allow, effective: [...known], skipped: [...skippedNow], skippedSure, guard: guardOk })
            noteSkipped(skippedNow)
            if (!narrowTold) {
              narrowTold = true
              say(`[dsh-fish] 工具面收窄：先只给她已登记的那几件（${known.length} 个），剩下的还在等`)
            }
          } catch (err) {
            say(`[dsh-fish] 先收窄没成：${String(err?.message ?? err).slice(0, 160)}`)
          }
        }
        const attempt = () => {
          // 白名单在这期间被换过（热更新已经按新名单重下过）：这次重试作废，
          // 否则会拿旧名单把新的那把刀再套一层（2026-11-11）。
          if (rt.gen !== myGen) return
          const again = bucket()
          allowForRestrict = again.forRestrict
          missingNow = again.missing
          skippedNow = again.skipped
          skippedSure = again.sure
          const ready = !missingNow.length
          if (ready && readyTick < 0) readyTick = tries
          // 自己的到了、外部名字还有没到的 → 从「到齐那一拍」起再宽限几拍。
          const waitingAbsent = ready && again.skipped.length > 0 && tries - readyTick < absentGrace
          if (ready && !waitingAbsent) {
            try {
              applyRestrict(allowForRestrict)
              noteSkipped(skippedNow)
              applied += 1
              say(`[dsh-fish] 工具面收窄：她这条会话只留 ${allowForRestrict.length} 个工具${guardOk ? '，另有兜底守卫' : ''}`)
              // 真的挂上了才算数——"注册了"和"生效了"必须分开报，否则自检会说谎。
              // effective 记的是**这次真下给宿主的那份名单**，导出里要跟配置的 allow 分开写。
              // skipped 是这次没交给 restrict 的别人的名字（issue #61）：自检不能再拿「allow 里有」当宿主认过它。
              onResult?.({ ok: true, applied, failed, why: tries ? 'applied-late' : 'applied', allow, effective: [...allowForRestrict], skipped: [...skippedNow], skippedSure, guard: guardOk })
              return
            } catch (err2) {
              say(`[dsh-fish] 收窄重试没成：${String(err2?.message ?? err2).slice(0, 160)}`)
            }
          } else {
            // 名册还没齐：先把已经登记的那几件摆上，别让桌子一直全开。
            applyNarrow(again)
          }
          tries += 1
          // 宽限从「自家名字到齐」那一拍起算（不是从这次会话开头算），而且只在
          // 「确实有外部名字没到」时才给；一直不齐就还按 retryMax 收尾。
          // 多留一拍是给「宽限用满的那一拍」真正落地收窄。
          const limit = readyTick >= 0 && again.skipped.length ? readyTick + absentGrace + 1 : retryMax
          if (tries < limit) {
            const t = setTimeout(attempt, retryMs)
            try { agent?.ctx?.effect?.(() => clearTimeout(t)) } catch { /* ignore */ }
          } else {
            // 等不齐（2026-11-11 用户拍板「先 B 后全收窄」）：窄刀**留着**，不再追。
            // 头 3 秒没登记上的名字，这一局就先缺席；下次开房 / 叫醒前 / 存白名单
            // 都会再对一次名册，晚到的还能补进来（recheckToolRestrict）。
            // 不撤刀的理由：撤掉等于把宿主全量工具表（含 compress 那 100 件）摆给她看，
            // 守卫虽然拦得住调用，拦不住列举——她照着说明就会一遍遍伸手。
            const settled = allow.filter((n) => again.restrictable.has(n))
            if (settled.length && settled.join('\n') !== narrowKey) {
              try {
                applyRestrict(settled)
                narrowKey = settled.join('\n')
                applied += 1
              } catch { /* 下不成就留着上一把窄刀 */ }
            }
            // 只有真有一把刀在岗才算「收窄了」；restrict 一直抛错时不能假装成功。
            if (settled.length && rt.disposeRestrict) {
              noteSkipped(skippedNow)
              say(`[dsh-fish] 工具面收窄：等不齐了，先按已认得的 ${settled.length} 个收着；下次开房/叫醒/存白名单再对名册`)
              onResult?.({ ok: true, applied, failed, why: 'narrowed-late', allow, effective: [...settled], guard: guardOk })
            } else {
              // 一个名字都认不得：空刀是用户明确否掉的形态（她连 read_image 都没有），
              // 只能先全开；等下一次对名册能认得名字了再收。
              say('[dsh-fish] 工具面收窄：一个工具名都还没登记，先全开着（只有兜底守卫在拦），下次开房/叫醒/存白名单再对名册')
              onResult?.({ ok: true, applied: 0, failed, why: 'deferred', allow, effective: [], guard: guardOk })
            }
          }
        }
        attempt()
        return
      } catch (err) {
        // 第一拍就抛了（连 view 都不给）：按失败报，守卫已经挂上。
        failed = String(err?.message ?? err).slice(0, 300)
        say(`[dsh-fish] 工具面收窄失败：${failed}`)
        onResult?.({ ok: false, applied, failed, why: 'failed', allow })
      }
    } catch (err) {
      failed = String(err?.message ?? err).slice(0, 300)
      // 宿主的报错里带着「known global tools: a, b, c」全量名单（0.2.1-rc.3 实测）。
      // 白名单输入框正缺这份名单，顺手捡回来——下次校验就不用再猜名字了。
      if (adoptKnownFromError(failed)) say('[dsh-fish] 从报错里捡回了工具名单，白名单校验以后能查真名了')
      say(`[dsh-fish] 工具面收窄失败：${failed}`)
      onResult?.({ ok: false, applied, failed, why: 'failed', allow })
    }
  }

  const off = ctx.on?.('agent/created', onCreated)

  // 立刻把结论报一次（给自检和设置页读）。
  // 注意：onCreated 是之后才跑的，所以这里报的是"已注册"，不是"已生效"。
  onResult?.({ ok: true, applied: 0, why: 'registered', allow })

  // 每次重启也再对一次名册（2026-11-11 用户要求）。
  // 插件状态全在内存里，进程重启本身就等于清空重算；这一拍补的是「启动那一刻
  // 宿主还没登记完、但她已经活着」的名字。没有 agent 就什么都不做。
  let startupRecheck = null
  try {
    startupRecheck = setTimeout(() => { try { recheckToolRestrict() } catch { /* ignore */ } }, 4000)
    startupRecheck.unref?.()
  } catch { /* ignore */ }

  return () => {
    try { if (startupRecheck) clearTimeout(startupRecheck) } catch { /* ignore */ }
    try { off?.() } catch { /* ignore */ }
    // 插件卸载/重挂后，旧现场不能再被 `/config` 保存摸到。
    if (liveReg && liveReg.say === say) liveReg = null
  }
}

/**
 * 白名单存盘后**当场**换刀，不用重启 DSH（2026-11-11，外部用户反馈）。
 *
 * 以前 `allow` 是注册时的 const，改了设置只有重启才读得到；她那边看到的工具表、
 * 守卫放行的名字、被挡时念的清单，全是旧的那份。宿主的 `restrict()` 返回的正是
 * 「解开这一刀」的 disposer，所以做法是：先按新名单下一刀（**先下新的**），
 * 成功了再收旧刀（**再收旧的**）——中间没有一刻是全开，也没有一刻是空刀。
 *
 * 守卫读的是 `rt.allowSet`，这一步不依赖宿主登记，换完从下一条工具调用起就放行；
 * 看不见的那一半靠新下的 restrict。我们自己的工具还没登记齐时不换刀（跟建会话时
 * 同一条规矩），等它到齐或下一条会话再收。
 *
 * @param {{ extra?: string[] }} [opts] 配置里的 tools.allow
 * @returns {{ ok: boolean, why?: string, allow: string[], applied?: object[], deferred?: string[] }}
 */
export function refreshToolRestrict({ extra = [] } = {}) {
  const reg = liveReg
  if (!reg) return { ok: false, why: 'disabled', allow: [] }
  // 梦跟着启动那一刻的取舍走（issue #64）：这里用注册时记下的 dream，不因为存了一次设置就变。
  const dreamOn = reg.dream
  const herNow = herToolsNow().filter((n) => n !== 'her_dream' || dreamOn)
  const extraNames = [...new Set(extra.map((s) => String(s).trim()).filter(Boolean))]
  const allow = [...new Set([...herNow, ...extraNames])]
  reg.allow = allow
  surfaceNow = toolSurfaceText(allow)
  inHandAllow = allow.slice()
  allowExtra = extraNames.slice()

  const r = reconcileAgents(reg, allow)
  reg.onResult?.({
    ok: true,
    applied: r.applied.length,
    failed: '',
    why: 'refreshed',
    allow,
    effective: r.effective,
  })
  return { ok: true, allow, applied: r.applied, deferred: r.deferred }
}

/**
 * 再对一次名册（2026-11-11，用户拍板「每次开房/叫醒前再对一次」）。
 *
 * 和热更新的区别：**不读配置、不改 allow**，只拿 `liveReg.allow` 当前这份名单，
 * 按宿主此刻真登记了哪些名字重下一次刀。晚到的名字到这一步就能补进来；
 * 还没到的那几个这一局缺席，等下一次。
 *
 * 为什么叫醒前要叫一次：她 home 会话 `chat.rotateAfter: 0` 时永不换会话，
 * 开房那一刻没登记上的名字，只有重启才会再碰运气；叫醒是最自然的「再对一次」时机。
 *
 * @returns {{ ok: boolean, why?: string, allow: string[], applied?: object[], deferred?: string[] }}
 */
export function recheckToolRestrict() {
  const reg = liveReg
  if (!reg) return { ok: false, why: 'disabled', allow: [] }
  const allow = reg.allow.slice()
  const r = reconcileAgents(reg, allow)
  if (r.applied.length) {
    reg.onResult?.({
      ok: true,
      applied: r.applied.length,
      failed: '',
      why: 'rechecked',
      allow,
      effective: r.effective,
    })
  }
  return { ok: true, allow, applied: r.applied, deferred: r.deferred, effective: r.effective }
}

/**
 * 把「这一局该下哪把刀」落到每个还活着的 agent 上。
 *
 * 规则（与 onCreated 同一套四桶）：
 * - 名字齐了 → 完整刀 `forRestrict`；
 * - 还缺自家名字、但已经认得出几件 → **窄刀**，不空等、也不全开；
 * - 一件都认不得 → 动不了（空刀用户明确否掉），记一笔 deferred。
 *
 * 每次都先下新刀、再收旧刀；名单没变就跳过，避免每叫醒一次叠一层。
 *
 * @returns {{ applied: {sid:string,count:number}[], deferred: string[], effective: string[] }}
 */
function reconcileAgents(reg, allow) {
  const ours = new Set(liveFishTools(FISH_TOOLS))
  const applied = []
  const deferred = []
  const effective = []
  for (const [sid, ref] of [...herAgents]) {
    const agent = ref?.deref()
    if (!agent) {
      herAgents.delete(sid)
      continue
    }
    const rt = agentRuntime.get(agent)
    if (!rt) continue
    // 守卫先换：不依赖宿主登记，绝不会失败；换完她再伸手，放行名单与拒绝时念的清单都对。
    rt.allowSet = new Set(allow)
    // 这一局还没跑完的「延后重试」用的是旧名单，从这一刻起作废（不能拿旧刀再套一层）。
    rt.gen += 1
    if (typeof agent?.ctx?.tools?.restrict !== 'function') {
      deferred.push(sid)
      continue
    }
    // 按与 onCreated 同一套四桶规则，挑出这一台宿主这一条会话真能下给 restrict 的名字。
    let restrictable = new Set()
    let visible = new Set()
    let named = false
    let split = false
    try {
      const v = agent?.ctx?.tools?.view?.(agent) ?? null
      const rn = namesOf(v?.restrictableNames)
      const vn = namesOf(v?.visible)
      if (rn.length) {
        restrictable = new Set(rn)
        named = true
      }
      if (vn.length) visible = new Set(vn)
      split = visible.size > 0 && restrictable.size > 0
    } catch { /* 拿不到视图：当成分不清，按全量试 */ }
    const seen = (n) => restrictable.has(n) || visible.has(n)
    const forRestrict = split
      ? allow.filter((n) => restrictable.has(n))
      : named
        ? allow.filter((n) => ours.has(n) || restrictable.has(n))
        : allow.slice()
    const known = named ? allow.filter((n) => restrictable.has(n)) : allow.slice()
    const missing = named ? allow.filter((n) => ours.has(n) && !seen(n)) : []
    // 缺名字时也不整段放弃：能收几件收几件。晚到的名字下次再对时补进来。
    const target = missing.length ? known : forRestrict
    if (!target.length) {
      deferred.push(sid)
      continue
    }
    const key = target.join('\n')
    if (key === rt.knifeKey) {
      effective.push(...target)
      continue
    }
    let disposeNew = null
    try {
      disposeNew = agent.ctx.tools.restrict({ allow: target })
    } catch (err) {
      reg.say?.(`[dsh-fish] 再对名册：新刀没下成（${String(err?.message ?? err).slice(0, 120)}）；守卫已按当前名单放行`)
      deferred.push(sid)
      continue
    }
    const old = rt.disposeRestrict
    rt.disposeRestrict = disposeNew
    rt.knifeKey = key
    try { old?.() } catch { /* 旧刀已经收过也不碍事 */ }
    applied.push({ sid, count: target.length })
    effective.push(...target)
  }
  return { applied, deferred, effective }
}

/** 给自检/观测台用的一句话结论。 */
export function describeRestrict({ applied = 0, failed = '', allow, why = '' } = {}) {
  if (failed) return `没挂上：${failed}`
  if (why === 'deferred') return '暂未收窄（宿主还没登记完工具，兜底守卫在拦）'
  if (applied > 0) return `已收窄（${allow?.length ?? HER_TOOLS.length} 个工具）`
  return '已注册，等她的会话下一次启动'
}

/**
 * 全局可见的工具名（不含定义），给白名单校验用。
 *
 * 为什么用 `ctx.tools.view()` 不带参数：宿主注释原文「the viewing scope (the agent),
 * or undefined for the global view」——不带 = 全局视角，`restrictableNames` 就是
 * `restrict()` 认的那批名字（inherited 层）。
 *
 * 拿不到就返回 null（调用方只做形状校验，不许把「不知道」当成「不存在」）。
 * 已知边界：preset/own 层的工具可能不在这里，别人机器上会存在「真工具被判未知」，
 * 所以界面不提供强制保存出口，文档写清「名字必须与宿主工具名完全一致」。
 */
export function knownToolNames(_ctx) {
  // 先现取一次：别的插件可能在 agent 建好之后才注册工具（dsh-ops 就是 attach 时才 publish），
  // 只用创建那一刻的快照会把这些名字一直判成「不存在」，用户永远存不进白名单。
  if (lastAgent) refreshFrom(lastAgent)
  // 有快照就用快照；没有就返回 null —— 让调用方只查拼写，别把「还没见过」说成「不存在」。
  if (lastKnownTools && lastKnownTools.length) return lastKnownTools.slice()
  return null
}

/**
 * 她这条会话看得见、但 `restrict()` 点不了名的那些（own 层）。
 *
 * 2026-10-29 真机：dsh-ops 的 `ops_bash` / `ops_discover_tools` 就长在这里。
 * 它们跟「白名单里拼错的字母」是两码事——名字真的存在，只是收窄这把刀够不着。
 */
export function ownLayerNames() {
  return [...seenOwn].sort()
}

/** 测试用：直接塞一份名字快照（真机上由 agent/created 时取到）。 */
export function rememberKnownTools(names) {
  const list = Array.isArray(names) ? names.map((x) => String(x)).sort() : []
  lastKnownTools = list.length ? list : null
  // 单塞一份不许留着上一次的 own 层结论，否则测试之间会串味。
  ownLayerNow = []
  seenTools.clear()
  seenOwn.clear()
  // 复位快照时也忘了那个 agent：否则下次 knownToolNames() 会立刻从旧 agent 现取一份，
  // 把刚清掉的名单又灌回来（测试之间会串味）。
  lastAgent = null
  for (const n of list) seenTools.add(n)
}

function namesOf(v) {
  if (v instanceof Set || v instanceof Map) return [...v.keys()].map((x) => String(x))
  if (Array.isArray(v)) return v.map((x) => String(x))
  return []
}

/**
 * 从一次 `tools.view(agent)` 里记下两件事（2026-10-29）：
 *   - 白名单校验要认的名字 = `restrictableNames ∪ visible`；
 *   - `visible − restrictable` 就是 own 层：看得见、`restrict()` 点不了名。
 *
 * 以前只记 `restrictableNames`，于是 ops_bash 这种真名字被判「不存在」，
 * 用户永远存不进白名单，也放行不了。
 */
export function rememberFromView(view) {
  try {
    const restrictable = namesOf(view?.restrictableNames)
    const visible = namesOf(view?.visible)
    const union = [...new Set([...restrictable, ...visible])].sort()
    // 只能变多不能变少：0.6.0 真机上宿主还没登记完时只有 1 个名字，
    // 用它覆盖会把白名单校验搞成「大部分真工具都被判未知」。
    // 0.6.21 起改成跨 agent 累积——同一个进程里她家、别的工作区、子 agent 的工具表不同，
    // 只留最后一份会让先注册的工具从名单里掉出去，白名单又报「名字不存在」。
    for (const n of union) seenTools.add(n)
    if (seenTools.size) lastKnownTools = [...seenTools].sort()
    if (visible.length) {
      const rset = new Set(restrictable)
      ownLayerNow = visible.filter((n) => !rset.has(n)).sort()
      for (const n of ownLayerNow) seenOwn.add(n)
    } else {
      // 这次 view 没给 visible：不知道就别说上一局的话，免得设置页提示串味。
      ownLayerNow = []
    }
    return { restrictable, visible, ownLayerNow: ownLayerNow.slice() }
  } catch {
    return { restrictable: [], visible: [], ownLayerNow: [] }
  }
}

/**
 * 从宿主 `restrict()` 的报错文本里捡回全量工具名（0.2.1-rc.3 实测可用）。
 *
 * 报错长这样：
 *   tools.restrict() names unknown global tool "web_serch"; known global tools: a, b, c
 * 白名单输入框正缺这份名单——捡回来之后，同一个进程里再校验就不用猜了。
 * 拿不到就什么都不做（永不抛）。
 */
export function adoptKnownFromError(message) {
  try {
    const text = String(message ?? '')
    const i = text.indexOf('known global tools:')
    if (i < 0) return false
    const tail = text.slice(i + 'known global tools:'.length).trim()
    if (!tail || tail === '(none)') return false
    const names = tail.split(',').map((s) => s.trim()).filter((s) => /^[a-z][a-z0-9_-]*$/.test(s))
    if (!names.length) return false
    lastKnownTools = [...new Set(names)].sort()
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// 进程内共享的「最近一次结论」。
//
// 为什么要模块级变量：`/selfcheck` 是另一条调用链（observe.js），拿不到 index.js
// 里的闭包。硬把状态塞进 ctx 当服务用属于滥用（ctx.get 是给真服务的），
// 而这里要的只是"本进程里那把刀到底挂上没有"——一个模块级单例正好。
// ---------------------------------------------------------------------------
// `allow` 是**配置**里那份清单（HER_TOOLS + 用户额外放行），`effective` 是**真的交给
// 宿主 restrict 的那一份**。两者必须分开（2026-10-28 用户点出来的坑）：
// 0.6.0 那台机器的日志里「允许 7 个」是配置值，实际生效的只有 1 个，
// 导出里两个数字一样，看日志的人没法判断她到底能看见几个工具。
let lastState = { ok: false, applied: 0, why: 'not attempted', allow: HER_TOOLS.slice(), effective: [] }

// 「宿主全局认得哪些工具名」的最近一份快照（进程内）。
// 只有拿到过某个 agent 的全局视角才有值；plugin 自己的 view() 只看得到本插件注册的那几个，
// 拿它校验会把 `skill` 这类宿主工具判成不存在，所以**不用它兜底**。
let lastKnownTools = null
// visible − restrictable：看得见、`restrict()` 点不了名（own 层，比如 dsh-ops 的 ops_*）。
let ownLayerNow = []
// 累积式记录：同一个进程里会有好几个 agent（她的家、别的工作区、子 agent），
// 每个 agent 的 own 层工具不一样；只留最后一份会让先注册的那些从名单里消失。
// 这份名单只用来挡「拼错的名字」，宁可多认，也不能把真名字判成不存在。
const seenTools = new Set()
const seenOwn = new Set()
// 最近一个被登记的 agent：白名单校验时用它现取一次 view，拿到「此刻」的工具表。
// 只靠 agent/created 那一刻的快照不够——别的插件常常在 agent 建好之后才注册工具
// （dsh-ops 就是 attach 时才 publish），那一刻的快照里没有它们。
let lastAgent = null

// 被兜底守卫挡下来的工具名（2026-11-04，issue #20）。
//
// 以前这些只写进日志：用户看不到，自检也不提，于是「她明明可以看视频，怎么答
// 我做不了」只能靠人翻 dsh-fish.log 才查得出来。issue 里那位翻了四小时。
//
// 记的是「这台机器上、这个进程里，她想调但没被放行的工具」——它同时是
// 「白名单还差哪个名字」的唯一答案。只增不减、按名字归并，进程重启就清空
// （重启之后有没有被挡，是新的问题，不该带着上一局的账）。
// 上限 50 个名字：真出现几十个被挡的，说明白名单压根没配，多记无益。
const blockedNow = new Map() // name -> { count, first, last, seq }
let blockedSeq = 0 // 同一毫秒里连着撞两次时，靠它定先后（时间戳分不出来）

function noteBlocked(name) {
  try {
    const key = String(name ?? '').trim()
    if (!key) return
    const at = new Date().toISOString()
    blockedSeq += 1
    const prev = blockedNow.get(key)
    if (prev) {
      prev.count += 1
      prev.last = at
      prev.seq = blockedSeq
      return
    }
    if (blockedNow.size >= 50) return
    blockedNow.set(key, { count: 1, first: at, last: at, seq: blockedSeq })
  } catch { /* 记账失败不能影响拦截本身 */ }
}

/**
 * 读「被兜底守卫挡下来的工具」——设置页与自检共用。
 *
 * 按最近一次被挡倒序。`count` 是次数：一次是手滑，十次是白名单真缺东西。
 *
 * @returns {Array<{name: string, count: number, first: string, last: string}>}
 */
export function blockedTools() {
  return [...blockedNow.entries()]
    .map(([name, v]) => ({ name, count: v.count, first: v.first, last: v.last, seq: v.seq }))
    .sort((a, b) => b.seq - a.seq || b.count - a.count)
    .map(({ name, count, first, last }) => ({ name, count, first, last }))
}

/** 测试用：清空被挡记录（进程内状态，测试之间会串味）。 */
export function forgetBlockedTools() {
  blockedNow.clear()
}

/** 内部：拿某个 agent 此刻的视角并记下来。拿不到就什么都不做。 */
function refreshFrom(agent) {
  try {
    let view = null
    try { view = agent?.ctx?.tools?.view?.(agent) ?? null } catch { view = null }
    if (!view) {
      try { view = agent?.ctx?.tools?.view?.() ?? null } catch { view = null }
    }
    if (view) rememberFromView(view)
  } catch { /* 拿不到就算了，界面会退回只查拼写 */ }
}

/** 读最近一次收窄结论（自检用）。 */
export function readRestrictState() {
  return { ...lastState }
}

/** 内部：登记一次结论。 */
function report(r) {
  const eff = Array.isArray(r?.effective) ? r.effective.map((x) => String(x)) : []
  lastState = {
    ok: Boolean(r?.ok),
    applied: Number(r?.applied ?? 0),
    why: String(r?.why ?? ''),
    allow: r?.allow ?? HER_TOOLS.slice(),
    // 只有真的下过 restrict 才有值。空数组 = 这一局她看见的是**全部**工具，
    // 而不是「允许 0 个」——读导出的人必须能一眼分清这两种情况。
    effective: eff,
    // 这次没交给 restrict 的别人的名字（issue #61）。skippedSure 为 false 时（view 没给 visible）
    // 说不准是这次没注册还是在她自己那一层，自检不能说成「这台机器上没有」。
    skipped: Array.isArray(r?.skipped) ? r.skipped.map((x) => String(x)) : [],
    skippedSure: r?.skippedSure !== false,
    failed: r?.failed ? String(r.failed) : '',
    guard: Boolean(r?.guard),
  }
}
