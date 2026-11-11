/**
 * scrub.js —— 把漏进正文的工具调用语法洗掉（2026-11-10，外部用户真机）
 *
 * 症状（两个外部用户各报了一次）：
 *   1. 她那段「正文」里明晃晃夹着一行
 *        <her_note action="list" filter="open"/>
 *      真话在前、标记在后，界面上整行都在。用户让她「正文别带这个英文」，
 *      说了也没用——那不是她想说的，是模型把一次没组起来的调用当正文吐了出来。
 *   2. `</｜｜DSML｜｜ parameter> </｜｜DSML｜｜ invoke> </｜｜DSML｜｜ calls>`
 *      这类收尾标记成串出现。`markup.js`（issue #25）只拿它防「别把标记记成她的话」，
 *      界面照旧显示——用户问到插件头上时，插件那边答「这段是空白」，
 *      因为账本里确实已经清干净了，脏的只是会话里那条 assistant 原文。
 *
 * 为什么修在这一层（`llm/stream`）而不是界面：
 *   - 宿主前端只渲染 `surfaceOp === 'append'` 的原件（`dsh-session` 的 surface 注释
 *     原话是「replacement copies stay model-only」），事后盖不掉已经落盘的那段；
 *   - 客户端插件也没有 assistant 正文的 text-transform 槽，硬接管 `conversation.chat.node`
 *     等于重写整个消息渲染器；
 *   - `llm/stream` 是宿主公开的 waterfall，模型吐一个 chunk 我们就能改一个，
 *     改完才组装成 `assistant/message` 落盘。官方 `dsh-session-title` 也这么用。
 *
 * 两条纪律，越界就不该合进来：
 *   - **只认自己认得的东西**：DSML 那一套（交给 `markup.js`），加上**本插件真注册过的
 *     工具名**的 XML 外壳。不猜别的工具语法，不动正文里的 `<` `>`——`a < b`、
 *     `<div>` 这种一个字都不改（`test/scrub.test.mjs` 钉着）。
 *   - **fail-open**：清洗自己炸了也必须原样放行。少洗一次只是多一行脏字，
 *     把流打断了是她这一轮整个说不出来。
 */

import { FISH_TOOLS, SCHEDULE_TOOLS } from './restrict.js'
import { liveFishTools, registeredToolNames } from './toolreg.js'
import { stripToolMarkup } from './markup.js'
import {
  hasTranscriptTail,
  partialMarkTail,
  stripTranscriptTail,
  transcriptStart,
} from './transcript.js'

/** `markup.js` 的核心标记（全角竖线 U+FF5C），这里只为判断「半个标记」用。 */
const DSML_LOWER = '｜｜dsml｜｜'

/** 半个标记最多能有多长；超过就当成正常正文，不再压着不发。 */
const HOLD_LIMIT = 80

/**
 * 此刻该防哪几个工具名。
 *
 * 用活体注册记录而不是手抄表：工具改名/新增时这里跟着变，不会漏
 * （`FISH_TOOLS` 只是「还没注册过」时的基线）。`read_image` 与宿主定时任务那几样
 * 是她真能调的，一并算进来——漏出去的也可能正是它们。
 *
 * @returns {string[]}
 */
export function scrubbedToolNames() {
  // 取**并集**而不是「有活体记录就只听活体记录」：这里只是要知道「哪些名字可能是标记」，
  // 多认几个没有副作用（没人会在正文里正经写 `<her_note>`），少认一个就漏一次。
  return [
    ...new Set(
      [...FISH_TOOLS, ...liveFishTools([]), ...registeredToolNames(), ...SCHEDULE_TOOLS, 'read_image']
        .map((n) => String(n ?? '').trim())
        .filter(Boolean),
    ),
  ]
}

/** 正则里要逃的字符。工具名只会有字母数字下划线，照写一遍不亏。 */
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 名字表没变就复用正则，免得每来一个 chunk 现编一遍。 */
const patternCache = new Map()

function patternsFor(names) {
  const key = names.join('\u0000')
  const hit = patternCache.get(key)
  if (hit) return hit
  const alt = names.map(escapeRe).join('|')
  // 「独占一行」的那一组先跑：标签自己一行时连那个换行一起收走，
  // 否则删完会留下一个空行（用户看到的就是两段之间莫名多一条空白）。
  const anyTag = `(?:<\\s*(?:${alt})\\b[^>]*>[\\s\\S]*?<\\s*\\/\\s*(?:${alt})\\s*>|<\\s*(?:${alt})\\b[^>]*\\/?>|<\\s*\\/\\s*(?:${alt})\\s*>)`
  const made = {
    ownLine: new RegExp(`(^|\\n)[ \\t]*${anyTag}[ \\t]*(\\n|$)`, 'g'),
    // 成对写的：<her_recall>{"query":"…"}</her_recall>。整块拿掉，里面是调用参数不是话。
    paired: new RegExp(`<\\s*(?:${alt})\\b[^>]*>[\\s\\S]*?<\\s*\\/\\s*(?:${alt})\\s*>`, 'gi'),
    // 自闭合或只有开标签的：<her_note action="list" filter="open"/>
    open: new RegExp(`<\\s*(?:${alt})\\b[^>]*\\/?>`, 'gi'),
    // 只剩收尾的：</her_note>
    close: new RegExp(`<\\s*\\/\\s*(?:${alt})\\s*>`, 'gi'),
    names,
  }
  patternCache.set(key, made)
  return made
}

/**
 * 这段正文里有没有认得出的工具标记（给「要不要打一行日志」用）。
 * @param {string} text
 */
export function hasLeakedToolSyntax(text) {
  const raw = String(text ?? '')
  if (!raw) return false
  if (raw.includes('｜｜')) return true
  const { paired, open, close } = patternsFor(scrubbedToolNames())
  // 带 g 的正则会记 lastIndex，连着 test 两次就判错——每次都从头比。
  for (const re of [paired, open, close]) {
    re.lastIndex = 0
    if (re.test(raw)) return true
  }
  return false
}

/**
 * 去掉漏进正文的工具标记；去完什么都不剩就返回**空串**——意思是「这一步她没有正文」。
 *
 * @param {string} text
 * @param {{trim?: boolean}} [options] 流式增量里要关掉 trim：一段一段各自 trim 会把
 *   词与词之间的空格吃掉，拼起来就粘成一片。
 */
export function stripLeakedToolSyntax(text, { trim = true } = {}) {
  let t = String(text ?? '')
  if (!t) return t

  const before = t
  if (t.includes('｜｜')) t = stripToolMarkup(t)
  const { ownLine, paired, open, close, names } = patternsFor(scrubbedToolNames())
  t = t.replace(ownLine, '$1').replace(paired, '').replace(open, '').replace(close, '')

  // 没闭合的残标（流被截断、或者模型写到一半停住）：从它开始切到行尾。
  // 和 markup.js 处理残 DSML 是同一个道理——后面跟着的是参数，不是她的话。
  for (const name of names) {
    const at = t.indexOf(`<${name}`)
    if (at < 0) continue
    if (t.slice(at).includes('>')) continue
    t = t.slice(0, at)
  }

  if (t !== before) {
    // 只清理「删出来的空」：删掉一整行后留下的空行、行尾空格。
    t = t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
  }
  if (!trim) return t
  return t.trim()
}

/**
 * 这个尾巴是不是「一个字都没说完的标记」。
 *
 * 只认两种开头：DSML 那串，和本插件真注册过的工具名。所以 `a < b`、
 * `x <div>` 这类正常正文不会被压住不发（它们后面一到 `>` 就放行，
 * 或者根本不像标记，当场放行）。
 */
function looksPartialMarker(tail) {
  if (!tail.startsWith('<')) return false
  if (tail.length > HOLD_LIMIT) return false
  if (tail.includes('>')) return false // 已经闭合，不是半个了
  const body = (tail.startsWith('</') ? tail.slice(2) : tail.slice(1)).toLowerCase()
  if (!body) return true // 只有一个 '<'，先压着看下一块
  if (DSML_LOWER.startsWith(body)) return true
  if (body.startsWith(DSML_LOWER)) return true
  for (const name of scrubbedToolNames()) {
    const n = name.toLowerCase()
    if (n.startsWith(body) || body.startsWith(n)) return true
  }
  return false
}

/** 最后一个可能是「半个标记」的起点；没有就 -1。 */
function riskyStart(text) {
  const at = text.lastIndexOf('<')
  if (at < 0) return -1
  return looksPartialMarker(text.slice(at)) ? at : -1
}

/**
 * 增量清洗。
 *
 * 两种「被 chunk 切开」都要接住：
 *   - 工具标记：`</｜｜DS` + `ML｜｜ invoke>` —— 压住像半个 `<…>` 的尾巴；
 *   - 对话记录标记：`us` + `er 你好` —— 压住当前行还没写完的尾巴，
 *     否则 `user` 被拆成两半各放出去，两条 delta 拼起来照样是那句假台词。
 *
 * 第三种是「认出来之后」：一旦撞上标记，后面整段都不要了（`stopped`），
 * 直到这一条流结束——中断流走的就是这条路径。
 */
function createWasher() {
  let held = ''       // 像半个 `<…>` 的尾巴
  let queue = ''      // 当前这一行还没敢放出去的字（可能正写成一个标记词）
  let queueAtStart = true // 那截压着的字，本身是不是从行首开始的
  let stopped = false // 已经撞上对话记录：后面整段都不要
  let atLineStart = true // 下一段要喂进来的字，起点在不在行首

  /** 在这段文字里找对话记录标记；不在行首时补个哨兵，免得把 chunk 开头误当成行首。 */
  function scan(out, atStart) {
    if (!out) return -1
    const probe = atStart ? out : `\u0000${out}`
    const at = transcriptStart(probe)
    return at < 0 ? -1 : at - (atStart ? 0 : 1)
  }

  /**
   * 把一段干净文本切掉「可能还没写完的标记词」，剩下的放出去。
   * @returns {string} 可以放出去的部分
   */
  function release(clean, atStart) {
    const nl = clean.lastIndexOf('\n')
    const line = clean.slice(nl + 1)
    const hold = partialMarkTail(line)
    if (!hold) {
      // 没有要压的：下一段接着这一行写，除非这一行刚结束。
      atLineStart = clean ? clean.endsWith('\n') : atStart
      return clean
    }
    queue = line.slice(line.length - hold)
    queueAtStart = nl >= 0 ? true : atStart
    // 下一段先接上这截压着的字，再从它所在的位置往后算行首。
    atLineStart = queueAtStart
    return clean.slice(0, clean.length - hold)
  }

  return {
    /** 喂一段 text-delta，返回这一刻可以放出去的干净文本（可能是空串）。 */
    delta(text) {
      if (stopped) return ''
      const buf0 = held + queue + String(text ?? '')
      const atStart = queue ? queueAtStart : atLineStart
      held = ''
      queue = ''
      const cut = riskyStart(buf0)
      // cut === 0 是「整段都像没写完的标记」：全部压着，一个字都不放。
      const out = cut < 0 ? buf0 : buf0.slice(0, cut)
      if (cut >= 0) held = buf0.slice(cut)
      if (!out) return ''

      const clean = stripLeakedToolSyntax(out, { trim: false })
      const at = scan(clean, atStart)
      if (at >= 0) {
        stopped = true
        return clean.slice(0, at).replace(/[ \t]+$/, '')
      }
      return release(clean, atStart)
    },
    /** 收尾：把压着的那点字洗一遍放出去。 */
    flush() {
      const t = held + queue
      const atStart = queue ? queueAtStart : atLineStart
      held = ''
      queue = ''
      if (stopped || !t) return ''
      const clean = stripLeakedToolSyntax(t, { trim: false })
      const at = scan(clean, atStart)
      if (at >= 0) {
        stopped = true
        return clean.slice(0, at).replace(/[ \t]+$/, '')
      }
      return clean
    },
  }
}

/** 洗一个已经组装好的 text block（`block-end` 带的那个是最终正文）。 */
function washBlock(block, { log } = {}) {
  if (!block || typeof block !== 'object') return block
  if (block.type !== 'text' || typeof block.text !== 'string') return block
  // 两道：先工具标记（2026-11-10），再她自己续写的对话记录（W49，2026-11-11）。
  // 只挂在 block-end 上做后一道——增量里标记可能被切在 chunk 之间，
  // 逐块切会把「user」拆成「us」+「er」两半各放出去；block-end 拿的是整段。
  let clean = stripLeakedToolSyntax(block.text)
  if (hasTranscriptTail(clean)) clean = stripTranscriptTail(clean)
  if (clean === block.text) return block
  const lost = block.text.length - clean.length
  try {
    log?.(`[dsh-fish] 正文里漏出的工具标记已清掉 ${lost} 字`)
  } catch { /* 日志失败不影响放行 */ }
  return { ...block, text: clean }
}

/**
 * 把一条模型流逐 chunk 洗一遍。
 *
 * 两处都要洗，理由在宿主 `dsh-llm/lib/types/assembler.js`：
 *   - `block-end` 里 `partial.block = chunk.block`，`assemble()` 优先返回它
 *     → **最终落盘的那份正文取自 block-end**；
 *   - 流被打断时 `interruptedBlocks()` 用**累加起来的 delta** 组装
 *     → 只洗 block-end 会在中断那一轮漏掉。
 */
async function* washStream(source, { log } = {}) {
  if (!source || typeof source?.[Symbol.asyncIterator] !== 'function') return
  const washer = createWasher()
  let lastIndex = 0
  let done = false

  for await (const chunk of source) {
    try {
      if (!chunk || typeof chunk !== 'object') {
        yield chunk
        continue
      }
      if (chunk.type === 'text-delta') {
        if (Number.isInteger(chunk.index)) lastIndex = chunk.index
        const text = washer.delta(chunk.text)
        yield text === chunk.text ? chunk : { ...chunk, text }
        continue
      }
      // 块收尾/整轮收尾之前，把压着的那点字放出去，别把它吞掉。
      if (chunk.type === 'block-end' || chunk.type === 'finish' || chunk.type === 'error') {
        const held = washer.flush()
        if (held) yield { type: 'text-delta', index: lastIndex, text: held }
        if (chunk.type === 'block-end') {
          const block = washBlock(chunk.block, { log })
          yield block === chunk.block ? chunk : { ...chunk, block }
        } else {
          done = true
          yield chunk
        }
        continue
      }
      yield chunk
    } catch {
      // fail-open：这一段洗不动就原样放行，绝不把整条流带塌。
      yield chunk
    }
  }

  // 流就这么断了（没等来 finish）：压着的那点字也得放出去。
  if (!done) {
    const held = washer.flush()
    if (held) yield { type: 'text-delta', index: lastIndex, text: held }
  }
}

/**
 * 把清洗挂到这条 agent 的 `llm/stream` 上。
 *
 * 挂不上不算失败（老宿主没有这个 waterfall）：返回 undefined，她只是接着漏。
 *
 * **为什么要认 sessionId**：宿主的 `llm/stream` 是把 `this`（LlmRuntime 实例）当
 * thisArg 派发的，而 LlmRuntime 上并没有 `[Context.filter]`——cordis 那句
 * `hook.global || !filter || filter.call(...)` 于是恒真，**挂在哪个 ctx 上都对全进程
 * 所有会话生效**（`dsh-session-title` 那条还显式写了 `{ global: true }`）。
 * 所以这里不能靠作用域，只能自己认：只洗 `options.sessionId` 一模一样的流
 * （`dsh-agent-loop` 组请求时写死 `sessionId: this.session.id`）。
 * 认不准就不洗——宁可她自己漏一行，不可去改别人的会话。
 *
 * @param {object} agent
 * @param {{ log?: Function, sessionId?: string }} [options]
 * @returns {(() => void)|undefined}
 */
export function attachStreamScrub(agent, { log, sessionId } = {}) {
  const ctx = agent?.ctx
  if (!ctx || typeof ctx.on !== 'function') return undefined
  const want = String(sessionId ?? agent?.session?.header?.id ?? agent?.session?.id ?? '')
  try {
    // prepend: true —— 排在最外层先拿到流，别让别的插件先看到脏字。
    const off = ctx.on('llm/stream', (options, next) => {
      const got = String(options?.sessionId ?? '')
      // 认不出来、或不是她这一间：一个字节都不碰。
      if (!want || got !== want) return next()
      return washStream(next(), { log })
    }, { prepend: true })
    return typeof off === 'function' ? off : undefined
  } catch {
    return undefined
  }
}
