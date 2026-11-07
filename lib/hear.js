/**
 * hear.js —— 旁听：每几轮，把他说的**一句原话**记下来（A2，2026-10-30 用户 m00112 批准）
 *
 * 为什么要有：
 *   her_recall 翻到的全是**她自己**写下的话。他说的那些，她只在当轮看见，
 *   一换会话就只剩 talkmem 里最近四轮——再往前，他曾经说过什么，她翻不到。
 *   于是"你上次说……"只能靠编，或者干脆不提。
 *
 * 边界（用户批准时就定了）：
 *   - 只存**一句原话**，不解释、不加工、不写摘要。她翻到时看到的是「他说：……」，
 *     而不是"他当时的意思是……"——后者是别人替她记的笔记，不是她的回忆。
 *   - 每 `memory.hearEvery` 轮才记一次（默认 3）。每次都记等于把她淹了，
 *     也把账本撑爆；一句里只取最长的那句，因为闲聊里的重点通常在那句。
 *   - 系统侧写（`source:'system'`）。她**不能**写 heard——否则她能凭空造一句
 *     "他说过"，而那正是这条记录唯一的凭据价值。
 *   - 写失败只 log，绝不让记账连累对话。
 */

import { appendEvent } from './store.js'
import { hearMark, setHearMark } from './home.js'

/** 一句最多多少字（对齐 talkmem 的 TALK_SNIPPET） */
export const HEAR_SNIPPET = 160
/** 太短的话不值得记：「嗯」「好」记下来也翻不出什么 */
export const HEAR_MIN_CHARS = 8
/** 默认每几轮记一次 */
export const HEAR_EVERY = 3

/**
 * 从一段话里挑出最值得留的一句。
 * 按句号/问号/叹号/分号/换行切；取最长的一句；截到 HEAR_SNIPPET。
 * 纯函数，永不抛。
 */
export function pickHearSentence(text) {
  const s = String(text ?? '').replace(/\r/g, '').trim()
  if (!s) return ''
  const parts = s
    .split(/[。！？!?；;\n]+/)
    .map((p) => p.trim())
    .filter(Boolean)
  if (!parts.length) return ''
  let best = parts[0]
  for (const p of parts) if (p.length > best.length) best = p
  if (best.length < HEAR_MIN_CHARS) return ''
  return best.length > HEAR_SNIPPET ? best.slice(0, HEAR_SNIPPET - 1) + '…' : best
}

/**
 * 到点了就记一句。返回 { written, why?, id?, text? }，永不抛。
 *
 * @param {string} root
 * @param {{text?:string, day?:number, stage?:number, turns?:number, config?:object, log?:Function}} o
 */
export async function hearTurn(root, o = {}) {
  const log = o.log ?? (() => {})
  const every = Number(o.config?.memory?.hearEvery ?? HEAR_EVERY)
  if (!(every > 0)) return { written: false, why: 'off' }
  const turns = Number(o.turns ?? 0)
  if (!(turns > 0)) return { written: false, why: 'not-this-turn' }
  // 「离上次记过去了几轮」而不是「turns 能不能被 every 整除」：
  // 后者从装插件那天开始算，旁听后装上的话要等很久才轮到一次（本机实测 0.8.0
  // 装上时 turns 已经 4，下一次整除是 6，中间看着像功能没生效）。2026-10-31。
  // 带上 turns：hearAt 比轮次还大（旧版本换会话没归零、或两条结账路径并发留下的）时按 0 算，
  // 不然这一段要一句不记地等到下一次换会话（issue #60）。
  const last = await hearMark(root, { turns })
  if (turns - last < every) return { written: false, why: 'not-this-turn' }

  const sentence = pickHearSentence(o.text)
  if (!sentence) return { written: false, why: 'nothing-to-keep' }

  try {
    const ev = await appendEvent(
      { type: 'heard', text: sentence },
      { day: Number(o.day ?? 0), stage: Number(o.stage ?? 1), source: 'system' },
      root,
    )
    await setHearMark(root, turns)
    return { written: true, id: ev.id, text: sentence }
  } catch (err) {
    log('hear · 没记下他说的那句', err?.message ?? err)
    return { written: false, why: 'failed' }
  }
}
