/**
 * sessionnote.js —— 往一条会话里补一句「人话」（0.6.16）
 *
 * 为什么需要它：请神结束、出门回家被驳回之后，那条会话的历史里还留着
 * 她以自己身份说过的话。系统提示撤干净了（0.6.11 修过），但 append-only
 * 的事件流撤不回来——下一轮模型读到自己上一句「我是大肥鱼」，会顺着演。
 * 唯一能做的，是在历史末尾补一条**可见的**边界标记：让下一轮先看到
 * 「这件事已经结束了」。
 *
 * 为什么写 `user/message` 而不是 meta：meta 是内部记帐，模型看不到；
 * 而这条标记必须进上下文才有意义。宿主的 `user/message` 校验（dsh-session
 * 的 assertMessageEventShape）要求：非空 id、role='user'、source.kind 非空、
 * content 数组，并且该类事件必须带 surfaceOp 标记——所以调用时传
 * `{ surfaceOp: 'append' }`。
 *
 * 永不抛：这些句子是「锦上添花」，写不进去也只是少一句话，不能连累
 * 请神结束 / 回家结算这两条主流程。
 */
import { readJson, writeAtomic, mutateJson } from './store.js'
import { join } from 'node:path'

/** 排队文件放在她屋子根下（与 home.json 同级，重启不丢）。 */
const NOTES_FILE = 'session-notes.json'
/** 排队上限：够用就好，别把文件撑大。 */
const NOTES_MAX = 50
/** 宿主的「系统头」事件类型：会话的第一轮开始时，它必须是 surface 的**第一个**节点。 */
const HEAD_TYPE = 'system/message'

/**
 * 这条会话里写过系统头了吗（2026-11-13，外部事故：会话历史损坏）。
 *
 * 为什么必须问：宿主 0.2.x 的 v4 格式要求**第一个 surface 节点是 `system/message`**
 * （那条系统头在第一轮开始时才由宿主写）。会话刚建出来、第一轮还没跑就往里
 * append 一条 `user/message`，它就成了 surface 的第一个节点；等宿主把系统头写进来，
 * 读盘校验直接抛 `system/message requires a protected first surface head`——
 * 整条会话打不开（真机：dsh-fish 0.9.9，会话建出来 17 毫秒后便条就写了进去）。
 * **写入侧不拦这条**（宿主 `append()` 没有任何保护头检查，只有 v4 读取校验会拒），
 * 所以只能我们自己先问一句。
 *
 * 判据按顺序，取最先拿得到的：
 *   1. `session.log` 里有没有 `system/message`（最准：头写过没有）；
 *   2. `session.snapshotEvents()`（老宿主/测试里常见的读法）；
 *   3. `session.surface.nodes.length > 0`（有节点 ⇒ 头已经写过，它就是第一个节点）。
 *
 * @returns {boolean|null} true=可以写；false=还没第一轮，先别写；null=看不出来
 *
 * 看不出来时（返回 null）**放行**：v4 的这条要求是 0.2.x 才有的，读不到事件流的
 * 宿主基本是更早的版本，那时先写 user/message 本来就不算坏。
 */
export function headWritten(session) {
  try {
    if (!session) return null
    if (Array.isArray(session.log)) return session.log.some((e) => e?.type === HEAD_TYPE)
    if (typeof session.snapshotEvents === 'function') {
      const events = session.snapshotEvents()
      if (Array.isArray(events)) return events.some((e) => e?.type === HEAD_TYPE)
    }
    const nodes = session.surface?.nodes
    if (Array.isArray(nodes)) return nodes.length > 0
  } catch { /* 读不出来就当看不出来：放行，见上面最后一段 */ }
  return null
}

export function noteId(now = Date.now()) {
  return `fish-note-${now}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 往一个活着的 agent 的会话里追加一条 user/message。
 *
 * 会话还没跑过第一轮（没有系统头）时**不写**，回 `{ok:false}`：排队的句子原样留着，
 * 等这条会话真跑过一轮、或者下次打开时再补（`deliverQueued` 投进去了才删）。
 * 见 `headWritten()` 上面那段——写了会把整条会话的历史弄坏。
 * @param {object} agent  宿主的 agent（`agent.session.append`）
 * @param {string} text
 * @returns {{ok:boolean, why?:string}}
 */
export function appendNote(agent, text, { now = Date.now() } = {}) {
  const body = String(text ?? '').trim()
  if (!body) return { ok: false, why: '空白的，没写。' }
  const session = agent?.session
  if (!session || typeof session.append !== 'function') {
    return { ok: false, why: '那条对话现在没开着' }
  }
  if (headWritten(session) === false) {
    return { ok: false, why: '这条对话还没跑过第一轮，先不写（写了会让整条历史打不开）' }
  }
  try {
    session.append(
      'user/message',
      {
        id: noteId(now),
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: body.slice(0, 800) }],
      },
      { surfaceOp: 'append' },
    )
    return { ok: true }
  } catch (err) {
    return { ok: false, why: String(err?.message ?? err).slice(0, 160) }
  }
}

function notesPath(root) {
  return join(root, NOTES_FILE)
}

/**
 * 同一份排队文件的「读 → 改 → 写」一个一个来。
 *
 * 排队、取走、投递都是先读整份再写整份；两个同时跑，各读各的、各写各的，
 * 后写的把先写的盖掉：刚排进去的一句没了，或者已经投出去的一句又被写回来。
 * 这条队列在 store.js 的 mutateJson 里（按文件路径排队，和便条、约定、config 共用一套）；
 * 同一个进程里对同一份文件的改动排着队做。（进程之间不管——同一个屋子本来就只许一个进程住。）
 */
async function readNotes(file) {
  const saved = await readJson(file, null)
  return Array.isArray(saved?.notes) ? saved.notes : []
}

function writeNotes(file, notes) {
  return writeAtomic(file, JSON.stringify({ version: 1, notes }, null, 2))
}

const hasText = (n) => Boolean(n && String(n.text ?? '').trim())

/**
 * 那条会话不在线时先排队，等她/他下次打开这条会话再补。
 * @returns {{ok:boolean, queued:number, why?:string}}
 */
export async function queueNote(root, text, { sessionId = '' } = {}) {
  const body = String(text ?? '').trim()
  if (!body) return { ok: false, queued: 0, why: '空白的，没写。' }
  const file = notesPath(root)
  try {
    // 排队、取走、放回都按这个文件排成一队：并发的两次排队以前只留下后写的那一句。
    return await mutateJson(file, async () => {
      const list = await readNotes(file)
      // 带上目标会话（2026-10-30）：出门结束的交接句属于外面那条会话，
      // 不带 sessionId 的话会被投到家里那条会话里，成了莫名其妙的噪音。
      list.push({ at: new Date().toISOString(), text: body.slice(0, 800), ...(sessionId ? { sessionId: String(sessionId) } : {}) })
      const notes = list.slice(-NOTES_MAX)
      await writeNotes(file, notes)
      return { ok: true, queued: notes.length }
    })
  } catch (err) {
    return { ok: false, queued: 0, why: String(err?.message ?? err).slice(0, 160) }
  }
}

/** 取走全部排队句子（取走即清空）。投递不走这里：deliverQueued 投进去了才删。 */
export async function takeNotes(root) {
  const file = notesPath(root)
  return mutateJson(file, async () => {
    const list = (await readNotes(file)).filter(hasText)
    if (list.length) await writeNotes(file, []).catch(() => null)
    return list
  })
}

/**
 * 会话打开时把排队的句子补进去。
 *
 * 投进去了才从文件里删（2026-11-12）。以前是先把文件清空再逐句 append：
 * append 抛错、那条会话没有 append、进程停在两步中间，这一句就既不在文件里
 * 也没进会话。现在整段在 mutateJson 里做：读最新的文件 → 逐句 append（同步）→
 * 只把 append 成功的那几句去掉再写回。没投进去的原样留着，下次再试；
 * 两条会话同时起来时一个一个来，后一个读到的是前一个写回之后的文件。
 * 最坏的情况从「丢一句」变成「写回之前进程没了（或写回失败），下次重投一句」。
 * @returns {Promise<{ok:boolean, delivered:number}>}
 */
export async function deliverQueued(agent, root, { home = false } = {}) {
  const file = notesPath(root)
  return mutateJson(file, async () => {
    let all = []
    try { all = await readNotes(file) } catch { all = [] }
    if (!all.length) return { ok: true, delivered: 0 }
    const sid = String(agent?.session?.header?.id ?? agent?.session?.id ?? '').replace(/^session-/, '')
    const same = (a) => Boolean(sid) && String(a ?? '').replace(/^session-/, '') === sid
    const keep = []
    let delivered = 0
    for (const n of all) {
      // 空白的投不出去，留着只占位置（和以前取走时滤掉一样）。
      if (!hasText(n)) continue
      // 带 sessionId 的只投给它自己那条（出门交接待说明）；不带的老条目（0.6.16 的驳回话术）
      // 只投给家里的会话——它讲的是家里的事，投到外面那条会话里就成了错位的噪音。
      const hit = n?.sessionId ? same(n.sessionId) : home
      if (hit && appendNote(agent, n.text).ok) delivered += 1
      else keep.push(n)
    }
    if (keep.length !== all.length) await writeNotes(file, keep).catch(() => null)
    return { ok: true, delivered }
  })
}