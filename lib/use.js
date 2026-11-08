/**
 * 工具使用经验（2026-11-07，用户 m00882）。
 *
 * 要解决的问题不是「她用没用过工具」，而是「她记不记得自己曾经用过什么、
 * 那次成了没有」。真机事件流 978 行里一条工具使用记录都没有——她翻旧事时
 * 只能翻到自己说过的话，翻不到「这件事我是怎么做成的」。
 *
 * 三条口径（用户定）：
 *   1. **只记她当时听见的那句**。不记参数、不记内部原因、不记返回值结构。
 *   2. **不记 enabled=false**。设置里关掉的东西不是「她试过并且失败」，
 *      写进账里等于把一扇关着的门天天摆在她眼前。
 *   3. 走现有 meta 通道（`use:<工具> <一句话>`），不新增事件类型，
 *      不动 EVENT_SCHEMA_VERSION。
 *
 * 记账永远不抛：写不进去就当没记，绝不影响她这次动作（与 look/browse 同一惯例）。
 */

import { appendEvent, readEvents } from './store.js'
import { similarity } from './derive.js'
import { noteRegisteredTool } from './toolreg.js'

/** 一句话的上限：她在回忆里看到的是一条，不是一段。 */
export const USE_LINE_MAX = 80

/**
 * 同一件事十分钟内只记一次（2026-11-07，用户 m00485 的 ④）。
 *
 * 她一轮里连翻三次回忆就是三条一样的行；这些行会占掉回忆的名额，
 * 把真正的旧事挤下去。节流只影响「记不记」，不影响工具本身返回什么。
 */
export const USE_THROTTLE_MS = 10 * 60 * 1000
export const USE_THROTTLE_SIMILARITY = 0.42

const USE_LINE = /^use:(\S+)\s+(ok|fail)\s*(.*)$/

/** 最近有没有一条同工具、同结果、话也差不多的账。 */
function tooClose(events, { tool, text, sessionId, now }) {
  const m0 = USE_LINE.exec(text)
  if (!m0) return false
  const said = m0[3]
  const head = m0[2]
  const list = Array.isArray(events) ? events : []
  for (let i = list.length - 1, n = 0; i >= 0 && n < 200; i--, n++) {
    const ev = list[i]
    if (ev?.type !== 'meta') continue
    const m = USE_LINE.exec(String(ev.text ?? ''))
    if (!m) continue
    if (m[1] !== tool || m[2] !== head) continue
    if (sessionId && ev.sessionId === sessionId && m[3] === said) return true
    const at = Date.parse(String(ev.ts ?? ''))
    if (Number.isFinite(at) && now - at <= USE_THROTTLE_MS && similarity(m[3], said) >= USE_THROTTLE_SIMILARITY) return true
  }
  return false
}

/** 这些说法意味着「这次根本没试成，是被设置挡在门外」，不进经验账。 */
const GATE_WORDS = ['打不开', '看不了', '不方便', '没开']

/** 一行太长会把回忆挤成一坨，换行会把行尾的 id 挤到下一行。 */
function oneLine(text, n = USE_LINE_MAX) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (s.length <= n) return s
  return `${s.slice(0, n - 1).replace(/[\uD800-\uDBFF]$/, '')}…`
}

/**
 * 有几个工具的回执不是一句话，而是一整段（她翻到的东西本身）。
 * 那种返回值不能直接进账：截 80 字只会得到半行「- 2026-11-05 12:07｜…」，
 * 记住它没有用。这几个只记「翻到了没有」。
 */
const SAYING = {
  her_recall: (out) => (out?.found ? '翻到了。' : '没翻到。'),
  // gone：那天写过、文件被「日记留多久」清掉了（herdiary.js）。记成「那天没有日记」，
  // 她以后翻回忆会以为自己那天没写。
  her_diary: (out) => (out?.found ? '翻到日记了。' : out?.gone ? '写过的日记已经清掉了，没翻到。' : '那天没有日记。'),
}

/**
 * 从工具返回里挑出「她听见的那句」。
 *
 * 优先级按她实际读到的顺序：记下的原文 > 说出口的话 > 回执 > 正文。
 * 正文只在够短时才用（长列表不是一句话）。一个都没有时给一句中性的，不编。
 */
export function heardLine(out, tool = '') {
  const say = SAYING[String(tool)]
  if (say) return say(out)
  for (const c of [out?.echo, out?.said, out?.note]) {
    const s = oneLine(c)
    if (s) return s
  }
  const body = oneLine(out?.text)
  if (body && body.length <= USE_LINE_MAX) return body
  return out?.ok === false ? '没成。' : '做成了。'
}

/**
 * 这次要不要入账。
 *
 * 关掉的功能、被设置挡住的调用都不算「她的经验」——那是屋子的事，不是她的事。
 */
export function shouldRecord(out) {
  if (!out || typeof out !== 'object') return true
  if (out.ok === false) {
    const note = String(out.note ?? '')
    if (GATE_WORDS.some((w) => note.includes(w))) return false
  }
  return true
}

/** `use:<工具> ok|fail <一句话>`；回忆层只显示后半句。 */
export function useText(tool, out) {
  const head = out?.ok === false ? 'fail' : 'ok'
  return `use:${String(tool)} ${head} ${heardLine(out, tool)}`
}

/**
 * 把一次工具调用的结果记进账里。
 *
 * day 记 0：这条账属于「哪一天都成立的经验」，不属于某一天的第几阶段。
 * 与她自己的成长阶段无关，也不该进 derive 的三道门计数（meta 本来就不进）。
 */
export async function recordUse(root, { tool, out, sessionId, now = Date.now() }) {
  try {
    if (!shouldRecord(out)) return
    const text = useText(tool, out)
    // sessionId 要放在 raw 里：validateEvent 只认 raw.sessionId，ctx 里的会被忽略
    // （与 lib/look.js 的 `{ text, ...stamp }` 同一个写法）。
    const sid = typeof sessionId === 'string' ? sessionId.trim() : ''
    const { events } = await readEvents(root)
    if (tooClose(events, { tool, text, sessionId: sid, now })) return
    await appendEvent(
      { type: 'meta', text, ...(sid ? { sessionId: sid } : {}) },
      { day: 0, stage: 1, source: 'system' },
      root,
    )
  } catch {
    // 记账失败不影响她这次动作
  }
}

/**
 * 包一层 execute：跑完照旧返回，只是顺手记一行。
 *
 * 为什么不去改 defineTool：它是恒等的，注册时直接把 JSON Schema 交给宿主
 * （见 lib/tool.js 与 test/tools.test.mjs），在那一层做手脚会同时改掉
 * 「工具定义原样交出去」这个约定。
 */
export function withUse(def, { root, tool }) {
  const run = def?.execute
  if (typeof run !== 'function') return def
  // 按属性描述符复制，不用 `{ ...def }`：展开会把 getter 当场求值成死值。
  // bili_speak 的说明是 getter（随「能不能说话」现取），展开之后就定格在启动那一刻，
  // 之后开关怎么翻，她读到的说明都不变（issue #62 后续）。
  const props = Object.getOwnPropertyDescriptors(def)
  delete props.execute
  const wrapped = Object.create(Object.getPrototypeOf(def), props)
  async function execute(args, exec) {
    try {
      const out = await run(args, exec)
      await recordUse(root, { tool, out, sessionId: exec?.sessionId })
      return out
    } catch (err) {
      // 做到一半炸了也要留一笔：这是「尝试没完成」里最该被记住的一类。
      // 不记异常原文——英文、内部词、堆栈都不该进她的账。
      await recordUse(root, { tool, out: { ok: false, note: '这次没成。' }, sessionId: exec?.sessionId })
      throw err
    }
  }
  Object.defineProperty(wrapped, 'execute', { value: execute, configurable: true, enumerable: true, writable: true })
  return wrapped
}

/**
 * 在注册期间临时把 `ctx.tools.register` 换成包装版。
 *
 * 为什么不在 index.js 里造一个 ctx 视图传下去：register 里还有 `askInChat(ctx, …)`
 * 这类把整个 ctx 往深处传的用法，假 ctx 会让 `this` 指到错的对象上。
 * 注册本身是同步的，换一下再换回来最稳，别人看不到中间态。
 */
export function withUseDuringRegistration(ctx, root, fn) {
  const tools = ctx?.tools
  const orig = tools?.register
  if (typeof orig !== 'function') return fn()
  tools.register = (def) => {
    // 顺手记一笔「这一版真的注册了哪些工具」（2026-11-08，用户 m00002）：
    // 清单从此现算，加工具不用再去 restrict.js 抄一遍表。
    // 记在真正下发之后——注册抛错的那次不算，免得界面显示一只根本不存在的手。
    const out = orig.call(tools, withUse(def, { root, tool: def?.name }))
    noteRegisteredTool(def?.name)
    return out
  }
  try {
    return fn()
  } finally {
    tools.register = orig
  }
}

/**
 * 履历：把她用过的东西反推成「我做过这些事」。
 *
 * 只给最近几条、同一类只留一条——履历是「我会什么」，不是流水账。
 * 撞墙那类（这件事我做不到）不进履历：桌上已经有一条在讲这件事，
 * 再在履历里写一遍，等于每次醒来先提醒她「这个我不会」。
 */
export function resumeLines(events, { max = 4 } = {}) {
  const limit = Math.max(1, Number(max) || 4)
  const list = Array.isArray(events) ? events : []
  const picked = []
  for (let i = list.length - 1; i >= 0 && picked.length < limit; i--) {
    const ev = list[i]
    if (ev?.type !== 'meta') continue
    const m = USE_LINE.exec(String(ev.text ?? ''))
    if (!m) continue
    const [, tool, head, said] = m
    if (head === 'fail' && said.startsWith('这件事我做不到')) continue
    if (picked.some((p) => p.tool === tool && similarity(p.said, said) >= USE_THROTTLE_SIMILARITY)) continue
    picked.push({ tool, head, said })
  }
  if (!picked.length) return ''
  const lines = picked.map(({ tool, head, said }) => {
    if (head !== 'fail') return `- 我用过 ${tool}，${said}`
    if (!said || said === '这次没成。' || said === '没成。') return `- 我用过 ${tool}，没成。`
    return `- 我用过 ${tool}，没成：${said}`
  })
  return ['## 我做过的事', ...lines].join('\n')
}
