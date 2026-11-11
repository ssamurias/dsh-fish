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

export function noteId(now = Date.now()) {
  return `fish-note-${now}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 往一个活着的 agent 的会话里追加一条 user/message。
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
 * 那条会话不在线时先排队，等她/他下次打开这条会话再补。
 * @returns {{ok:boolean, queued:number, why?:string}}
 */
export async function queueNote(root, text, { sessionId = '' } = {}) {
  const body = String(text ?? '').trim()
  if (!body) return { ok: false, queued: 0, why: '空白的，没写。' }
  try {
    // 排队、取走、放回都按这个文件排成一队：并发的两次排队以前只留下后写的那一句。
    return await mutateJson(notesPath(root), async () => {
      const saved = await readJson(notesPath(root), null)
      const list = Array.isArray(saved?.notes) ? saved.notes : []
      // 带上目标会话（2026-10-30）：出门结束的交接句属于外面那条会话，
      // 不带 sessionId 的话会被投到家里那条会话里，成了莫名其妙的噪音。
      list.push({ at: new Date().toISOString(), text: body.slice(0, 800), ...(sessionId ? { sessionId: String(sessionId) } : {}) })
      const notes = list.slice(-NOTES_MAX)
      await writeAtomic(notesPath(root), JSON.stringify({ version: 1, notes }, null, 2))
      return { ok: true, queued: notes.length }
    })
  } catch (err) {
    return { ok: false, queued: 0, why: String(err?.message ?? err).slice(0, 160) }
  }
}

/** 取走全部排队句子（取走即清空，避免重复投递）。 */
export async function takeNotes(root) {
  return mutateJson(notesPath(root), async () => {
    const list = await readQueued(root)
    if (list.length) await writeAtomic(notesPath(root), JSON.stringify({ version: 1, notes: [] }, null, 2)).catch(() => null)
    return list
  })
}

async function readQueued(root) {
  let saved = null
  try { saved = await readJson(notesPath(root), null) } catch { saved = null }
  return Array.isArray(saved?.notes) ? saved.notes.filter((n) => n && String(n.text ?? '').trim()) : []
}

/**
 * 会话打开时把排队的句子补进去。
 * @returns {Promise<{ok:boolean, delivered:number}>}
 */
export async function deliverQueued(agent, root, { home = false } = {}) {
  const sid = String(agent?.session?.header?.id ?? agent?.session?.id ?? '').replace(/^session-/, '')
  const same = (a) => Boolean(sid) && String(a ?? '').replace(/^session-/, '') === sid
  // 「取走全部 → 把不是这条会话的放回去」是一步：以前分成两次写，中间排进来的
  // 那一句会被放回去的那份盖掉。
  const mine = await mutateJson(notesPath(root), async () => {
    const list = await readQueued(root)
    const mine = []
    const rest = []
    for (const n of list) {
      // 带 sessionId 的只投给它自己那条（出门交接待说明）；不带的老条目（0.6.16 的驳回话术）
      // 只投给家里的会话——它讲的是家里的事，投到外面那条会话里就成了错位的噪音。
      const hit = n?.sessionId ? same(n.sessionId) : home
      ;(hit ? mine : rest).push(n)
    }
    if (mine.length) {
      await writeAtomic(notesPath(root), JSON.stringify({ version: 1, notes: rest }, null, 2)).catch(() => null)
    }
    return mine
  })
  if (!mine.length) return { ok: true, delivered: 0 }
  let delivered = 0
  for (const n of mine) {
    const r = appendNote(agent, n.text)
    if (r.ok) delivered += 1
  }
  return { ok: true, delivered }
}
