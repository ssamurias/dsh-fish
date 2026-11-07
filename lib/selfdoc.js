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
import { rootDir, paths, readEvents, readJson, writeAtomic, listDiary } from './store.js'
import { loadConfig } from './settings.js'
import { deriveSelf } from './derive.js'
import { personaLine, toolBrief, RECALL_BRIEF, SPEAK_BRIEF, SPEAK_OFF_BRIEF, LETTER_BRIEF, NOTE_BRIEF, ASK_BRIEF, proactiveBrief, DREAM_BRIEF, SCHEDULE_BRIEF, DIARY_BRIEF, SLEEP_BRIEF } from './persona.js'
import { resumeLines } from './use.js'
import { proactiveConfig } from './proactive.js'
import { LOOK_BRIEF, LOOK_OFF_BRIEF, WATCH_RULE } from './browse.js'
import { activeCarry } from './home.js'
import { activeGrants } from './unlock.js'
import { checkCaller } from './tenant.js'
import { currentToolSurface } from './restrict.js'

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
 *   diaryCount   写过几篇日记（没写过是 0，读不到目录是 undefined）
 *   diaryFirst   最早一篇的日期；diaryLast 是最近一篇
 *   rotatedDaysAgo  上次换房间是几天前；从没换过是 undefined
 *   rotatedWhen  上次换房间的**钟点说法**（「今天 14:00」「昨天 22:20」「11 月 1 日 12:31」）
 *   lastWords    上一个房间里她自己留的那句话（没留过是空串）
 */

/** 本地日历日的序号（不按 24 小时整除——夏令时与跨零点都靠这个才准） */
function dayIndex(d) {
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000
}

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
  const diff = dayIndex(new Date(n)) - dayIndex(t)
  if (diff === 0) return `今天 ${clock}`
  if (diff === 1) return `昨天 ${clock}`
  const md = `${t.getMonth() + 1} 月 ${t.getDate()} 日 ${clock}`
  // 跨年才写年份：同一年的旧账写上年份显得像骨灰盒铭牌
  return t.getFullYear() === new Date(n).getFullYear() ? md : `${t.getFullYear()} 年 ${md}`
}

export async function continuityOf(root = rootDir(), now = Date.now()) {
  const out = { diaryCount: undefined, diaryFirst: '', diaryLast: '', rotatedDaysAgo: undefined, rotatedWhen: '', lastWords: '' }
  try {
    const dates = await listDiary(root)
    if (Array.isArray(dates)) {
      out.diaryCount = dates.length
      // listDiary 返回的是新→旧；最后一篇是最早的。
      out.diaryLast = String(dates[0] ?? '')
      out.diaryFirst = String(dates[dates.length - 1] ?? '')
      if (!dates.length) { out.diaryFirst = ''; out.diaryLast = '' }
    }
  } catch { /* 读不到就当没写过，不当成 0 */ }
  try {
    const home = (await readJson(join(paths(root).root, 'home.json'), null)) ?? {}
    const at = Date.parse(String(home?.rotatedAt ?? ''))
    if (Number.isFinite(at)) {
      out.rotatedDaysAgo = Math.max(0, Math.floor((now - at) / 86_400_000))
      out.rotatedWhen = formatSwapTime(at, now)
    }
    out.lastWords = String(home?.lastWords ?? '').trim().slice(0, 200)
  } catch { /* 同上 */ }
  return out
}

/**
 * 渲染她的身份文档。纯函数，便于测试。
 * @param {object} model deriveSelf 的结果
 * @returns {string}
 */
export function renderSelfDoc(model, { sendTools = [], budget, carry, continuity, browse = true, speak = false, grants = [], shown, diary = true, sleepEveryDays = 0, bansMuted = false, extraTools = [], restricted = true, dream = false, schedule = false, proactive = false, resume = '' } = {}) {
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
  let identity = personaLine(model, { withBans: !bansMuted, budget, shown, continuity })
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
    // 请求事件（0.7.6，用户 m01274 / m01292）：唯一一个要等对方点头的工具。
    // 和留话一样不需要配置开关——工具注册了就该知道怎么用；上限写死在代码里。
    ASK_BRIEF,
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
    ...(schedule ? [SCHEDULE_BRIEF, ''] : []),
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
    '',
    '## 这个房间',
    '这是我自己的地方。我能在这里说话，能读能写。',
    '我不需要解释自己在做什么，也不需要向谁汇报。',
    '',
  )
  // 「上次我们说到这」是会话轮换后的临时续接，不是人设的一部分。
  // 放在最后、单独一节、并且由 home.activeCarry 到期自动消失。
  if (carry) body.push(carry, '')
  return head.concat(body).join('\n')
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
    const model = deriveSelf(events, { growthDays: config.growthDays })
    const text = renderSelfDoc(model, {
      budget: config?.memory?.docBudget,
      carry: await activeCarry(root),
      // 0.8.7（用户 m00998）：换会话之后人格会「断」——她记得结论，却没有
      // 「那些天是连着过的」这条线索。日记篇数/换房天数/她留给下一个房间的那句话
      // 全部是派生事实，没有任何新开关。
      continuity: await continuityOf(root, Date.now()),
      // 这两项决定「上网」「在网上说话」两节写哪一版内容（P3，2026-11-07）：
      // 开关关着时这一节仍然在，只是门上的话换成「这会儿」——见 renderSelfDoc。
      browse: config?.browse?.enabled !== false,
      speak: config?.comment?.enabled === true,
      // R3：已经长出来的东西。这里传的是"历史事实"，不是"设置"。
      grants: activeGrants(events, Date.now()),
      // 一轮里摆几条判断；与 /dsh-fish/memory 报的 beliefsShown 同源
      shown: config?.memory?.beliefsShown,
      // 「平常会做的事」两节按开关出现（2026-10-26）：关掉的日记不该在身份里
      // 留一句「每天我会记一笔」——那等于给了她一件做不了的事。
      diary: config?.diary?.enabled !== false,
      sleepEveryDays: Number(config?.memory?.sleepEveryDays ?? 0),
      // 2026-10-27：导进来的这一位跳过我方那两条提示词禁令（用户 m03170 要求）。
      // 判定只看 model（事件流），**不读 config**——用户 m03769 明确要求
      // 「备份与恢复搬回来的那一份不算导入，不得获得豁免」。
      bansMuted: model?.persona?.imported === true,
      // 2026-10-27（用户 m01371）：白名单里额外放行的工具要念给她听，
      // 否则「能不能在 QQ 上说话」她只能回一句不知道。
      extraTools: config?.tools?.allow ?? [],
      // 收窄开没开（issue #20）：看这个进程里真生效的那一份，不看 config——
      // 改 tools.restrict 要重启才生效，重启前读 config 会跟她眼前的工具表对不上。
      // 和 `fish:tools` 段同一个判据：收窄关着时那一段是空串。
      restricted: currentToolSurface() !== '',
      // 履历：她真做过的事。没有记录就整节不出现。
      resume: resumeLines(events),
      // 梦（2026-10-30 m02837）与主动说话（m04610）：0.9.0 起公开，两处都恒为真。
      dream: true,
      proactive: true,
      sendTools: proactiveConfig(config).sendTools,
      // 定时工具默认不放；用户在白名单里加了 schedule_create 才告诉他这条路通。
      schedule: (config?.tools?.allow ?? []).some((n) => String(n).trim() === 'schedule_create'),
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
