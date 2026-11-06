/**
 * askinchat.js —— 让她在会话里直接问那个人（0.7.5，2026-10-29）
 *
 * 以前两件事都只能去观测台点按钮：撒娇式表达的解锁申请、出门想带东西回家。
 * 那两处本质上都是「需要那个人点头」，而点头这件事本来就该在对话里发生——
 * 卡片长在**她那条会话的输入框上方**，人在看她的地方顺手就答了。
 *
 * 这里只做三件事，不碰业务判断：
 *   1. 找到发起这次提问的 live root agent（宿主只认它）
 *   2. 用宿主 `userQuestions.ask()` 把问题丢出去，自己管一个超时
 *   3. 把回答整形成 `{ ok, answers }`，失败一律降级返回，**绝不抛**
 *
 * 为什么不用 `askTimed`：那个通道要求有 `callId` 让客户端登记「前台等待」，
 * 而插件是从工具执行之外（定时器里）发问，没有 callId；一旦客户端没接手，
 * `askTimed` 会走到 noAnswerer 直接 NO_PROVIDER。`ask()` 不带 callId 一样能
 * 渲染卡片（只是没有前台 claim），回答经 waterfall 返回给我们，正是要的路径。
 *
 * 宿主侧限制（asar 已核实，别改成猜的）：
 *   - 带 agent 时必须 `agents.get(agent.id) === agent` 且 `agents.roots()` 含它，
 *     否则 CALLER_NOT_LIVE / DELEGATED_CALLER
 *   - 没人在线时 noAnswerer 抛 NO_PROVIDER
 *   - 卡片挂在 `ctx.sessions.scopeOf(agent)` 那条会话上
 *
 * 人不在这条会话前的部署（都从 IM 上说话）：卡片他看不见，她这一轮还要白等 5 分钟，
 * 一天后记成「一直没人答」。所以弹卡之前先问一声有没有插件能把话送到人在的地方
 * （`dsh-fish/card`，AGENTS.md §7.3）。接走了就不弹卡、不等，回答走 `dsh-fish/answer`
 * 回来（lib/cardanswer.js），人隔几个小时才答、中间重启过都能结算。
 */

import { looksLikeRewriting, looksLikeSecret } from './guard.js'
import { liveAgentOf } from './identity.js'

/** 一次提问默认等多久：5 分钟。超时不当失败，当「这次没问到」。 */
export const ASK_TIMEOUT_MS = 5 * 60_000

/**
 * 等别的插件接卡最多等多久。它发不出去，这张卡还来得及弹在会话上。
 * 等得比一次发送的超时久（IM 插件常见 30 秒）：先放弃的话桌面弹一张、那边又送到一张，两边都能答。
 */
export const RELAY_WAIT_MS = 35_000

/** 卡上有没有看着像凭据的字：她的问题、理由、选项都算（§3：秘密外发一律拦下）。 */
function cardHasSecret(card) {
  const texts = [card.detail]
  for (const q of card.questions) texts.push(q?.header, q?.question, ...(Array.isArray(q?.options) ? q.options.map((o) => o?.label) : []))
  return texts.some((text) => looksLikeSecret(text).hit)
}

/**
 * 回执里要念给她听的去处。这是别的插件写的字（§3：新输入口都过 guard.js）。
 * 空的算没接走；看着像改写指令的，卡还是接走了，只是不把这几个字念给她。
 */
function viaOf(taken) {
  const raw = typeof taken?.via === 'string' ? taken.via : ''
  const via = raw.replace(/\s+/g, ' ').trim().slice(0, 40)
  if (!via) return ''
  // 按行看：改写指令的判断认行首，压成一行之后「QQ\nsystem: …」就认不出来了
  const risky = raw.split(/[\r\n\u2028\u2029]+/).some((line) => looksLikeRewriting(line).hit) || looksLikeRewriting(via).hit || looksLikeSecret(raw).hit
  return risky ? '别的地方' : via
}

/**
 * 问问有没有插件接这张卡。只有回了 `{ via: '说给她听的去处' }` 才算接走；
 * 没人接、抛错、拒绝、超时、这一轮被取消都按没接，**绝不抛**。Promise 的拒绝由 race 接住：
 * 宿主把未处理的拒绝当致命错误，超时之后才拒绝的也一样要接住。
 * `bail` 停在第一个非空返回值上，所以 async 监听只有排第一的那个算数。
 * 看着带凭据的卡不问：它只留在本机的卡片上，不发给任何插件。
 */
async function relayCard(ctx, card, waitMs, signal) {
  if (cardHasSecret(card)) return ''
  let timer
  let onAbort
  try {
    const r = ctx?.bail?.('dsh-fish/card', card)
    const taken = typeof r?.then === 'function'
      ? await Promise.race([r, new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), waitMs)
        onAbort = () => resolve(null)
        signal?.addEventListener?.('abort', onAbort, { once: true })
      })])
      : r
    return viaOf(taken)
  } catch {
    return ''
  } finally {
    clearTimeout(timer)
    if (onAbort) signal?.removeEventListener?.('abort', onAbort)
  }
}

/**
 * 把她想问的话丢进会话里，等那个人选一个。
 *
 * @param {object} ctx 插件上下文（需要注入 userQuestions）
 * @param {object} opts
 * @param {string} opts.sessionId 会话 id（卡片就挂在这条会话上）
 * @param {Array}  opts.questions 宿主格式的问题数组
 * @param {number} [opts.timeoutMs]
 * @param {object} [opts.signal] 外部取消信号（例如这一轮已经结束了）
 * @param {string} [opts.cardId] 这张卡的 id（`ask:…` 等，见 lib/cardanswer.js）。不给就不会被别的插件接走
 * @param {string} [opts.detail] 只给接卡的插件看的补充说明（卡片本身放不下的那句「为什么」）
 * @returns {Promise<{ok: boolean, answers?: Array, code?: string, via?: string}>}
 *   被接走时 `{ok:false, code:'RELAYED', via}`：调用方照「问了，还没答」处理
 */
export async function askInChat(ctx, opts = {}) {
  const {
    sessionId = '',
    questions = [],
    timeoutMs = ASK_TIMEOUT_MS,
    signal = undefined,
    waitAgentMs = 10_000,
    cardId = '',
    detail = '',
    relayWaitMs = RELAY_WAIT_MS,
  } = opts
  if (!Array.isArray(questions) || questions.length === 0) return { ok: false, code: 'NO_QUESTIONS' }

  if (cardId && !signal?.aborted) {
    const via = await relayCard(ctx, { id: cardId, sessionId, questions, detail }, relayWaitMs, signal)
    if (via) return { ok: false, code: 'RELAYED', via }
    if (signal?.aborted) return { ok: false, code: 'AbortError' }
  }

  // 宿主只接受 live root agent。她那轮刚被 wake 顶起来时，agent 可能还没就位，
  // 所以这里给一小段等待窗口（默认 10 秒）而不是一次查不到就放弃。
  const agent = await waitAgent(ctx, sessionId, { totalMs: waitAgentMs, signal })
  if (!agent) return { ok: false, code: 'NO_AGENT' }

  // 2026-10-30（m02961）：`userQuestions` 不再进 inject（那是 0.2.1-rc.3 才有的服务，
  // 写进 inject 会让 rc.2 上的插件整个装不进来）。这里运行时取；没有就走 NO_SERVICE，
  // 调用方按「这次没问到」处理，不影响别的功能。
  const service = ctx?.get?.('userQuestions') ?? ctx?.userQuestions
  if (!service || typeof service.ask !== 'function') return { ok: false, code: 'NO_SERVICE' }

  // 自己管超时：宿主的 ask() 没有超时参数，signal 一断它就 reject。
  const ac = new AbortController()
  const kill = setTimeout(() => ac.abort(), Math.max(1, Number(timeoutMs) || ASK_TIMEOUT_MS))
  const onOuter = () => ac.abort()
  if (signal && typeof signal.addEventListener === 'function') {
    if (signal.aborted) ac.abort()
    else signal.addEventListener('abort', onOuter, { once: true })
  }

  try {
    const result = await service.ask({ questions, agent, signal: ac.signal })
    const answers = Array.isArray(result?.answers) ? result.answers : []
    if (!answers.length) return { ok: false, code: 'NO_ANSWER' }
    return { ok: true, answers }
  } catch (err) {
    // 超时、没人接、agent 已经不在了——都是「这次没问到」，不是错误。
    const code = String(err?.code ?? err?.name ?? 'ASK_FAILED')
    return { ok: false, code }
  } finally {
    clearTimeout(kill)
    if (signal && typeof signal.removeEventListener === 'function') {
      try { signal.removeEventListener('abort', onOuter) } catch { /* ignore */ }
    }
  }
}

/**
 * 等那条会话的 live root agent 就位（最多 totalMs）。
 * 她那轮刚被 wake 起来时，agent 可能还在注册路上；查不到就隔一会儿再查。
 * 没有 agent（单测环境、会话已关）时快速返回 null，不做无谓等待。
 */
async function waitAgent(ctx, sessionId, { totalMs = 0, signal = undefined } = {}) {
  const first = liveAgentOf(ctx, sessionId)
  if (first) return first
  // 单测 / 老宿主里没有 agents 注册表：再怎么等也不会有，立刻返回。
  if (!ctx?.get?.('agents')) return null
  const deadline = Date.now() + Math.max(0, Number(totalMs) || 0)
  while (Date.now() < deadline) {
    if (signal?.aborted) return null
    await new Promise((r) => setTimeout(r, 250))
    const hit = liveAgentOf(ctx, sessionId)
    if (hit) return hit
  }
  return null
}

/**
 * 从回答里取出某个问题的选项（没选中返回 ''）。
 *
 * 宿主回传的 `selected[0]` 不一定就是字符串：也可能是 `{label}` / `{value}` / `{text}`。
 * 2026-10-30 真机（用户 m01756）：大肥鱼问了一次，卡片消失却没人记账——
 * 旧实现直接 `String(sel[0])`，拿到对象就变成 `[object Object]`，永远对不上选项。
 * 这里统一拆成文本；`ask.js` 的 `askChoiceIndex` 还会再兜一层下标。
 */
export function picked(answers, id) {
  const hit = (Array.isArray(answers) ? answers : []).find((a) => a?.id === id)
  const sel = hit?.selected
  if (Array.isArray(sel) && sel.length) {
    const one = sel[0]
    const text = one && typeof one === 'object' ? one.label ?? one.value ?? one.text ?? '' : one
    return String(text ?? '').trim()
  }
  if (typeof hit?.custom === 'string' && hit.custom.trim()) return hit.custom.trim()
  return ''
}
