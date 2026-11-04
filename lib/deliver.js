/**
 * deliver.js —— 把「叫醒她」这句话递进会话的正确方式（2026-11-04，用户 m00428）。
 *
 * ## 为什么不再用 `sessionController.prompt()`
 *
 * 宿主（0.2.1-rc.5）的 `sessionController.prompt()` 在内部**写死**了来源：
 *
 *     const source = { kind: 'user', rpcId: request.requestId, ... }
 *     this.commands.prompt(request, source)      → createUserMessage → agent.followup
 *
 * （`dsh-api-session-controller/lib/index.js:3225–3232`）
 *
 * 调用方传不进 source，所以凡走它的消息在宿主眼里都是「他打的字」，
 * 前端 `messageDefinition.start()` 判 `source.kind === 'user'` → 画成用户气泡。
 *
 * 我们以前的对策是「先发出去、再发一条 `surfaceOp.replace` 把它盖掉」
 * （原 `lib/proactive.js` 的 `hideTrigger` / `sweepTriggers`）。这条路**语义上是对的、
 * 对象是错的**：宿主源码注释明写
 *
 *     replacement copies stay model-only
 *     （`dsh-client-ui-chat/lib/client.js` 的 `isAppendSurfaceEvent` 一带）
 *
 * 也就是替换副本只改「模型看到的那份」，人类对话记录（append 原件）从头到尾没被碰过。
 * 前端 `messageDefinition.match` 也只接受 `isAppendSurfaceEvent` 的事件。
 * 所以 0.8.5 与 0.8.6 两次「已收走」都是假的，用户 m00404 截图里那句话一直在。
 *
 * ## 正解：换来源，不换投放
 *
 * 官方自己的定时任务就是这么投的（`dsh-schedule/lib/index.js:1580–1600`）：
 *
 *     createUserMessage({ content, source: { kind: 'schedule' } })
 *     resolved.agent.followup(message)
 *
 * 仍然是 `role:'user'`，但 `source.kind` 不是 `'user'`。前端一看到这个组合就不画气泡，
 * 改画成一行**默认收起的折叠条**（`turn-trigger`，标题走 `turnTriggerDetails`，
 * 认不出的 kind 统一叫「收到执行请求」，正文只在点开后出现）。
 *
 * 宿主对这个 kind 只有一条硬约束（`dsh-session/lib/types/index.js:250–262` 的
 * `source()` 校验）：**非空字符串、且不等于 `'plugin'`**。其余随便起名。
 *
 * ## 投递对象为什么是裸对象
 *
 * 插件 `package.json` 的依赖字段全是 `{}`，lib/*.js 里零 `@deepseek-ai/*` import ——
 * 拿不到宿主的 `createUserMessage`，只能自己拼。`ReactLoopInbox.mutate()` 的校验也只有两条：
 * `message.id` 不重复、`content` 非空。所以：
 *
 *   - **必须自带 `id`**：不传的话裸对象 id 是 `undefined`，两条会撞
 *     `message "undefined" is already pending`。
 *   - `createMessage` 的 deepFreeze / structuredClone 由宿主收件箱兜住，不用我们做。
 */

import { randomUUID } from 'node:crypto'

/**
 * 我们自己起的来源名。
 *
 * 用 `fish-wake` 而不是 `schedule`：折叠条的标题虽然是同一句「收到执行请求」，
 * 但把来源标成别人的名字，以后查日志、看事件流都会骗自己。
 *
 * **改这个名字必须同步 `lib/turns.js` 的 `MACHINE_KINDS`** ——
 * 那张表认不出的 kind 一律当「真人说话」，漏加会把她自己醒来说的话
 * 记成「他来过」，污染冷落天数与轮数。
 */
export const FISH_SOURCE_KIND = 'fish-wake'

/**
 * 折进对话里的那句话。
 *
 * 正文已经整段走 system prompt 的 `fish:wake` 段（`lib/identity.js`），
 * 这里只是一个「起来」的信号 —— 所以越短越好，而且它默认是收起的。
 * 以前那句「（现在没有人跟你说话。）」被她读成「有人发了这句话给我」，
 * 于是整个 reasoning 都在解释这句话是谁说的（见 scheduler.js 顶部那条注释）。
 * 一个空格最省事：不提供任何可被当成话去解读的东西。
 */
export const WAKE_PING = ' '

/**
 * 拼一条可以交给 `agent.followup()` 的消息。
 *
 * @param {string} text 正文（默认就给 `WAKE_PING`）
 * @param {{rpcId?:string, kind?:string}} [opts]
 *   `rpcId` 会原样落进 `source.rpcId`，日志与事件流里靠它认这一次投递。
 */
export function fishMessage(text = WAKE_PING, { rpcId = '', kind = FISH_SOURCE_KIND } = {}) {
  const source = { kind }
  if (rpcId) source.rpcId = rpcId
  return {
    id: `${kind}-${randomUUID()}`,
    role: 'user',
    content: [{ type: 'text', text: String(text ?? WAKE_PING) }],
    source,
  }
}

/**
 * 把一条会话恢复成活 agent。与 `lib/observe.js` 的 `resolveSessionAgent` 同一入口，
 * 但放在这里是为了避开循环依赖：observe.js 已经 import 了 scheduler.js。
 *
 * 为什么不用 `sc.resume`：真机上 sessionController 的暴露面里没有它
 * （0.6.26 直接调它，出门每次都 500）。
 *
 * @returns {Promise<object>} agent；拿不到就抛
 */
export async function resolveLiveAgent(sc, sessionId) {
  const got = typeof sc?.resolveAgent === 'function'
    ? await sc.resolveAgent(sessionId)
    : (typeof sc?.agents?.resolveAgent === 'function' ? await sc.agents.resolveAgent(sessionId) : null)
  if (got === null) throw new Error('宿主没有 sessionController.resolveAgent')
  if (got?.error) throw got.error
  if (!got?.agent) throw new Error('宿主说恢复好了，但没把 agent 交出来')
  return got.agent
}

/**
 * 探一下这条会话还在不在（2026-11-05，用户 m03265）。
 *
 * ## 为什么不能再拿 `sc.create({ sessionId, cwd })` 当「确认还在」
 *
 * 宿主 `sessionController.create()` 收到 `sessionId` 时的语义是「**我要用这一条**」，
 * 而它对跑过 turn 的会话给不出来，于是**静默另开一条空白会话**：返回值我们不接、
 * 也不报错。结果就是每递一次话、每叫醒一次，宿主侧多一条空壳。
 *
 * 本机实测（`~/.dsh-fish/home` 这个 cwd，2026-11-05）：52 条会话里 39 条只有一行
 * session 头（≤400 字节）；同一台机器上 `--D-deepseekagent--` 59 条只 4 条、
 * `--C-Users-DANG-.dsh-aik_auto_memory_use--` 102 条只 1 条 —— 空壳只长在这条路径上。
 *
 * `create({ workspaceId })`（换房走的那个、`lib/home.js` 的 `rotateTalkSession`）
 * 才是「真的再开一间」，那个不动。
 *
 * ## 返回值
 *
 * `{ live: true }` 或 `{ live: false, why }`。**永不抛** —— 探活失败不是投递失败，
 * 调用方自己决定要不要退回老路。宿主没有 `resolveAgent`（老版本）时返回
 * `{ live: false, why: '宿主没有 sessionController.resolveAgent' }`。
 *
 * @returns {Promise<{live:boolean, why?:string}>}
 */
export async function ensureSessionLive(sc, sessionId) {
  try {
    await resolveLiveAgent(sc, sessionId)
    return { live: true }
  } catch (err) {
    return { live: false, why: String(err?.message ?? err).slice(0, 160) }
  }
}

/**
 * 叫醒她：递一条 `source.kind = fish-wake` 的消息，让她开一轮。
 *
 * 失败时**不退回 `sc.prompt`** —— 那条路一用就又变成用户气泡，
 * 等于把这次修复悄悄撤回。宁可这一次没叫醒（下一拍还会再判断），
 * 也不要为了「至少叫醒了」把老毛病带回来。
 *
 * @param {object} ctx
 * @param {object} sc sessionController
 * @param {string} sessionId
 * @param {{text?:string, rpcId?:string, log?:(a:string,b?:string)=>void}} opts
 * @returns {Promise<{ok:boolean, via:'followup', why?:string}>}
 */
export async function deliverWake(ctx, sc, sessionId, { text = WAKE_PING, rpcId = '', log } = {}) {
  const sid = String(sessionId ?? '')
  if (!sid) return { ok: false, via: 'followup', why: '没有会话 id' }
  try {
    const agent = await resolveLiveAgent(sc, sid)
    if (typeof agent?.followup !== 'function') throw new Error('agent 上没有 followup')
    agent.followup(fishMessage(text, { rpcId }))
    // followup 只是同步把消息插进收件箱，落盘要等宿主自己的 durability 检查点。
    // 官方的定时任务在 followup 之后**立刻**显式 flush（`dsh-schedule` 原话：
    // "followup synchronously appends the inbox splice before flush observes the Session"），
    // 我们以前没做：那条折叠卡要等宿主下一拍自然落盘才出现在界面上，
    // 于是「她开始动了」这件事看着比旧气泡慢半拍（用户 m00902 的观感）。
    // flush 失败不影响这一轮本身（消息已经进了收件箱），所以只记日志、不判失败。
    const flushed = await flushSession(ctx, agent)
    if (flushed === false) log?.('deliver flush', '宿主没有登记会话持久化监听，这次没有落盘屏障')
    return { ok: true, via: 'followup' }
  } catch (err) {
    const why = String(err?.message ?? err).slice(0, 160)
    log?.('deliver failed', why)
    return { ok: false, via: 'followup', why }
  }
}

/**
 * 把收件箱这次改动推到落盘，让前端立刻看见。
 *
 * 三种情况都当作「没有屏障可用」，不算错：
 * 宿主没给 `ctx.sessions`、拿不到 `agent.session`、或 flush 自己抛了。
 * 宁可少一次即时刷新，也不要因为一次刷新把已经投递成功的那一轮标成失败。
 *
 * @returns {Promise<boolean|null>} true=宿主确认落盘；false=没有监听参与；null=根本没这一步
 */
async function flushSession(ctx, agent) {
  try {
    // 宿主把 SessionStore 注册成服务名 `sessions`（`SessionStore` 的 super(ctx, 'sessions')）。
    // 用 `ctx.get()` 而不是 `ctx.sessions` 属性：插件的机会只有 apply 里那一次，
    // 没在 `inject` 名单上声明过的服务用属性访问在某些内核版本上会抛，get() 只返回 undefined。
    const store = typeof ctx?.get === 'function' ? ctx.get('sessions') : ctx?.sessions
    const session = agent?.session
    if (!store || typeof store.flush !== 'function' || !session) return null
    return await store.flush(session)
  } catch {
    return null
  }
}
