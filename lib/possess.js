/**
 * possess.js —— 请神：把「此刻的她」借到一条**已经在用**的对话里
 *
 * 为什么能这么做（2026-10-28 在 asar 里核对过，不是猜的）：
 *   `dsh/node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js` 里
 *   `section()` 的注释原话是「A scoped section shadows a global section with the same name」，
 *   宿主自己的两段人格段名是 `deployment:persona-prefix`（order 10100）与
 *   `deployment:persona-suffix`（order 10200）。在目标 agent 的 `agent.ctx` 上
 *   用**同名**段注册，合并时就覆盖全局那一段：下一轮组装即生效、不进对话历史、
 *   界面上看不到，agent 销毁时随作用域一起撤销。
 *
 * 为什么不新开一条对话（那正是「出门」）：请神要的是「你正在说的这条，由她来接」。
 *
 * 边界：
 *   - 只挂 system 段与兜底守卫；工具面是那个会话本来就有的（宿主全局工具 + 那个工作区的权限），
 *     不额外注册、也不替人收窄——请神期间那个会话的编程工具对**你**也还在，
 *     守卫是按路径拦「伸手回她家」，不是按工具名。
 *   - 同一个 agent 分不出谁在说话：守卫也会拦你。这是边界，不是 bug，界面要写明。
 *   - 宿主没有 `systemPrompt.section` 时如实返回失败，不静默当作成功。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { identityText, attachAwayGuard, flatPath } from './identity.js'
import {
  readPossessions,
  activePossessionOf,
  activePossessionSync,
  startPossession,
  endPossession,
  possessionsFile,
  snapshotEvents,
} from './outing.js'

// 同步读的那份在 outing.js（tenant.js 也要用，不能放这儿——会绕成环）。
// 这里 re-export 一次，保持既有 import 站点（测试里从 possess.js 取）不变。
export { activePossessionSync }
import { cwdOf, isHerHome } from './restrict.js'
// 名字要读 session/title 事件；header 里是空的（2026-10-29 用户 m00761）。
import { titleOfAgent, clipTitle } from './sessiontitle.js'

/** 宿主自己的两段人格段：同名覆盖才叫「换人」。 */
export const PERSONA_PREFIX_SECTION = 'deployment:persona-prefix'
export const PERSONA_PREFIX_ORDER = 10100
export const PERSONA_SUFFIX_SECTION = 'deployment:persona-suffix'
export const PERSONA_SUFFIX_ORDER = 10200

/**
 * 覆盖不上时的退路：宿主如果把这几个名字改了，至少别静默失效——
 * 用我们自己的名字挂在人格段后面，并在日志里说清楚「没覆盖上，是接在后面」。
 */
export const POSSESS_SECTION = 'fish:possession'
export const POSSESS_ORDER = 10150

/** sessionId → 撤销函数。请神结束、插件卸载、agent 销毁时都要能撤。 */
const live = new Map()

/** 测试用：看现在挂着几条。 */
export function livePossessions() {
  return [...live.keys()]
}

/**
 * 请神时她读到的那段话：走时的自己 + 一句「现在是谁在说话」。
 * 身份正文用请神那一刻的只读快照（`possessions.json` 里的人 `identity`），
 * 拿不到才退回读当前文件。
 * @param {string} root
 * @param {object} rec
 * @returns {string}
 */
export function possessionText(root, rec = {}) {
  const body = String(rec.identity ?? '').trim() || identityText(root).trim()
  const title = rec.title ? `「${rec.title}」` : '这条对话'
  const lines = [
    body,
    '',
    '---',
    '',
    `你现在在${title}里说话。这条对话原来不是你——从现在起，回答的人是你，用上面这个人的身份和口气。`,
    '不用解释你是被借来的，也不用演一个助手；你本来就在这儿。',
    '你能用的工具，就是这条对话本来有的那些。你自己的屋子还是别去动——那是你回去的地方。',
  ]
  return lines.join('\n')
}

/**
 * 把请神挂到一个活着的 agent 上。
 * @param {object} agent
 * @param {{ root: string, herDir: string, rec?: object, log?: (m: string) => void }} opts
 * @returns {{ ok: boolean, why?: string, section?: string, disposers: Function[] }}
 */
export function attachPossession(agent, { root, herDir, rec = {}, log } = {}) {
  const disposers = []
  const finish = (ok, extra = {}) => ({ ok, ...extra, disposers })
  const sp = agent?.ctx?.systemPrompt
  if (!sp || typeof sp.section !== 'function') {
    return finish(false, { why: '宿主的 agent.ctx 上没有 systemPrompt.section（版本不支持）' })
  }
  const text = () => possessionText(root, rec)
  let section = ''
  try {
    // 先按宿主自己的名字覆盖：这样就是「换人」，不是「多一段话」。
    disposers.push(sp.section({ name: PERSONA_PREFIX_SECTION, order: PERSONA_PREFIX_ORDER, text }))
    section = PERSONA_PREFIX_SECTION
    // 人格后缀若被人配过，留着会和上面打架；覆盖成空串（空段会被渲染丢掉）。
    try {
      disposers.push(sp.section({ name: PERSONA_SUFFIX_SECTION, order: PERSONA_SUFFIX_ORDER, text: () => '' }))
    } catch { /* 后缀覆盖不上不致命 */ }
  } catch {
    // 覆盖不上（同层重复名 / 宿主改了名字）：退到自己的名字，至少她的话仍在。
    try {
      disposers.push(sp.section({ name: POSSESS_SECTION, order: POSSESS_ORDER, text }))
      section = POSSESS_SECTION
      log?.('[dsh-fish] 请神没覆盖上宿主的人格段，改接在它后面（不影响说话，但原来的人格还在）')
    } catch (err) {
      return finish(false, { why: String(err?.message ?? err).slice(0, 200) })
    }
  }
  // 兜底守卫：任何工具调用里出现她家路径就拒绝（与出门同一套）。
  const g = attachAwayGuard(agent, { root, herDir, log })
  if (!g.ok) log?.(`[dsh-fish] 请神的兜底守卫没挂上：${g.why}`)
  else log?.('[dsh-fish] 请神挂上了兜底守卫')

  const dispose = () => {
    while (disposers.length) {
      try { disposers.pop()() } catch { /* 撤不掉就随作用域回收 */ }
    }
    const sid = String(agent?.session?.header?.id ?? agent?.session?.id ?? '')
    if (sid) live.delete(sid)
  }
  const sid = String(agent?.session?.header?.id ?? agent?.session?.id ?? '')
  if (sid) live.set(sid, dispose)
  try { agent.ctx?.effect?.(() => dispose) } catch { /* 没 effect 就靠父级回收 */ }
  return finish(true, { section })
}

/** 撤销某个会话上的请神（结束请神、卸载时用）。永不抛。 */
export function detachPossession(sessionId) {
  const sid = String(sessionId ?? '')
  const fn = sid ? live.get(sid) : null
  if (!fn) return false
  try { fn() } catch { live.delete(sid) }
  return true
}

/** 同步读请神名单的说明见 outing.js（tenant.js 也要用，放这里会绕成环）。 */

/**
 * 注册 `agent/created`：冷会话（重启后打开的那条）也要补挂。
 * @returns {() => void} 卸载函数
 */
export function registerPossession(ctx, { root, herDir, log } = {}) {
  const onCreated = ({ agent } = {}) => {
    try {
      const rec = activePossessionSync(root)
      if (!rec) return
      const sid = String(agent?.session?.header?.id ?? agent?.session?.id ?? '')
      if (!sid || sid !== String(rec.sessionId)) return
      if (isHerHome(agent, herDir)) return
      const r = attachPossession(agent, { root, herDir, rec, log })
      if (r.ok) log?.(`[dsh-fish] 请神补挂上了（第 ${live.size} 条）`)
      else log?.(`[dsh-fish] 请神补挂没上：${r.why}`)
    } catch (err) {
      log?.(`[dsh-fish] 请神补挂失败：${String(err?.message ?? err).slice(0, 160)}`)
    }
  }
  const off = ctx.on?.('agent/created', onCreated)
  return typeof off === 'function' ? off : () => {}
}

/**
 * 请神到一条活会话（路由用）。所有拒绝都带人话原因。
 * @param {object} ctx 插件 ctx（拿 agents 服务）
 */
export async function possessInto(ctx, { root, herDir, sessionId, log } = {}) {
  const sid = String(sessionId ?? '').trim()
  if (!sid) return { ok: false, code: 400, why: '没选中哪一条对话' }
  const registry = ctx?.get?.('agents')
  const agent = registry?.get?.(sid)
  if (!agent) return { ok: false, code: 404, why: '这条对话现在没在运行；先在侧栏点开它，再来请神' }
  if (isHerHome(agent, herDir)) return { ok: false, code: 400, why: '她本来就在自己的屋子里，不用请' }
  const cur = activePossessionOf(await readPossessions(root))
  if (cur && cur.sessionId === sid) return { ok: true, already: true, possession: cur }
  const header = agent?.session?.header ?? agent?.session ?? {}
  const title = clipTitle(titleOfAgent(ctx, agent) || header.title || header.name || '')
  const cwd = cwdOf(agent)
  // 请神也要记基线（2026-10-29 m02241 第②条）：结束那一刻拿它与事件流比，
  // 有人在后面动过她那份记录时这趟先不算数，等人复核。与出门同一个快照函数。
  const rec = {
    sessionId: sid,
    title,
    cwd,
    baseline: snapshotEvents(join(root, 'events.jsonl')),
    identity: identityText(root),
    now: Date.now(),
  }
  const r = attachPossession(agent, { root, herDir, rec, log })
  if (!r.ok) return { ok: false, code: 409, why: r.why ?? '挂不上' }
  const saved = await startPossession(root, rec)
  if (!saved.ok) {
    detachPossession(sid)
    return { ok: false, code: 409, why: saved.why }
  }
  logLineSafe(log, `[dsh-fish] 请神：${title || '未命名对话'} 会话 ${sid.slice(-8)}`)
  return { ok: true, possession: saved.possession, section: r.section }
}

/**
 * 请神结束时写进那条对话的交接句（2026-10-29 用户 m00924 真机发现）。
 *
 * 为什么需要它：请神段每轮现组装、撤销即生效，**但那条对话的历史是 append-only**——
 * 她以自己身份说过的话留在里面，模型下一轮读到自己上一句「我是大肥鱼」，就会顺着演。
 * 删不掉旧消息，唯一能做的是往里补一条明确的「已经还给你了」，让下一轮的上下文里
 * 出现交接事实，而不是让她自己对着自己续戏。
 * 2026-10-29 用户 m02381：原来让人在结束时写一句「临走留言」，读起来像她要留话，
 * 太绕；整块删掉，只留这两句标准交接。
 * @returns {string}
 */
export function releaseNoteText() {
  return [
    '（大肥鱼回去了，这条对话还给你。）',
    '请神期间她说过的话仍留在上面的历史里；想完全干净，开一条新对话最稳。',
  ].join('\n')
}

/**
 * 往那条对话里追加一条可见的用户消息当交接句。永不抛：写不进去不影响请神结束。
 * @param {object} agent
 * @returns {{ ok: boolean, why?: string }}
 */
export function appendReleaseNote(agent) {
  try {
    const session = agent?.session
    if (!session || typeof session.append !== 'function') {
      return { ok: false, why: '那条对话已经收起来了，写不进去' }
    }
    session.append('user/message', {
      id: `fish-release-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: releaseNoteText() }],
    }, { surfaceOp: 'append' })
    return { ok: true }
  } catch (err) {
    return { ok: false, why: String(err?.message ?? err).slice(0, 200) }
  }
}

/**
 * 结束请神（路由用）：先撤挂载，再把台账收尾，最后往那条对话补一条交接句。
 * @param {string} root
 * @param {{ sessionId?: string, log?: Function, agent?: object|null, status?: string, kept?: boolean|null, choice?: object|null }} opts
 */
export async function releasePossession(root, { sessionId = '', log, agent = null, status = 'done', kept = null, choice = null } = {}) {
  const data = await readPossessions(root)
  const cur = activePossessionOf(data)
  if (!cur) return { ok: false, code: 409, why: '她本来就没上身' }
  if (sessionId && String(cur.sessionId) !== String(sessionId)) {
    return { ok: false, code: 409, why: '上身的那条不是这一条', possession: cur }
  }
  detachPossession(cur.sessionId)
  const r = await endPossession(root, { sessionId: cur.sessionId, status, kept, choice, now: Date.now() })
  if (!r.ok) return { ok: false, code: 409, why: r.why }
  logLineSafe(log, `[dsh-fish] 请神结束：${cur.title || '未命名对话'}`)
  // 台账收好之后再补交接句：即便这句写不进去，请神本身也已经结束了。
  const note = agent ? appendReleaseNote(agent) : { ok: false, why: '那条对话现在没开着' }
  if (agent && !note.ok) logLineSafe(log, `[dsh-fish] 请神结束但没写进交接句：${note.why}`)
  return { ok: true, possession: r.possession, note }
}

function logLineSafe(log, msg) {
  try { log?.(msg) } catch { /* 日志失败不影响功能 */ }
}
