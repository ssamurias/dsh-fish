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
import { loadConfig } from './settings.js'

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
/**
 * 群聊里**他本人**说的那一句（2026-11-08，用户 m00394）。
 *
 * 为什么要单独一条：群聊不涨轮数，`hearTurn` 的「每几轮记一次」在这里永远轮不到；
 * 而群里他说的话与私聊那句是同一类东西——「关于他的事实」，不该因为换了场合就消失。
 *
 * 边界（用户 m00394 定死）：
 *   - 只记他说的，**群友的话一条都不进**。调用方必须先拿到桥给的 `owner:true`，
 *     不靠昵称猜主人——猜错一次，就是把她对他的记忆写歪。
 *   - 进记忆、**不进生命体征**：事件带 `scene:'group'`，`isContactEvent` 会把它
 *     排除在「他来过」之外。群里聊两句不算他来找过她，否则冷落检测永远不触发。
 *   - 仍然只留一句原话（`pickHearSentence`），不解释、不写摘要。
 *   - 「记你原话的间隔」设成 0 时群里也不记（0.9.5 新加的群聊旁听原来不读这个设置）。
 *     设置页写的是「0 为不记」，私聊停了、群里照记就和那句话对不上。群聊不涨轮数，
 *     所以只认 0 这一档，不按间隔跳（设置说明里也写了群聊不按间隔）。
 *     调用方没带 config 时自己读一份。
 *
 * 永不抛：记账失败只 log，不能连累对话。
 */
export async function rememberGroupWord(root, o = {}) {
  const log = o.log ?? (() => {})
  let config = o.config
  if (config === undefined) config = await loadConfig(root).then((r) => r?.config).catch(() => null)
  const every = Number(config?.memory?.hearEvery ?? HEAR_EVERY)
  if (!(every > 0)) return { written: false, why: 'off' }
  const sentence = pickHearSentence(o.text)
  if (!sentence) return { written: false, why: 'nothing-to-keep' }
  try {
    const ev = await appendEvent(
      {
        type: 'heard',
        text: sentence,
        scene: 'group',
        ...(o.sessionId ? { sessionId: String(o.sessionId) } : {}),
      },
      { day: Number(o.day ?? 0), stage: Number(o.stage ?? 1), source: 'system' },
      root,
    )
    return { written: true, id: ev.id, text: sentence }
  } catch (err) {
    log('hear · 群里那句没记下', err?.message ?? err)
    return { written: false, why: 'failed' }
  }
}

export async function hearTurn(root, o = {}) {
  const log = o.log ?? (() => {})
  const every = Number(o.config?.memory?.hearEvery ?? HEAR_EVERY)
  if (!(every > 0)) return { written: false, why: 'off' }
  const turns = Number(o.turns ?? 0)
  if (!(turns > 0)) return { written: false, why: 'not-this-turn' }
  // 「离上次记过去了几轮」而不是「turns 能不能被 every 整除」：
  // 后者从装插件那天开始算，旁听后装上的话要等很久才轮到一次（本机实测 0.8.0
  // 装上时 turns 已经 4，下一次整除是 6，中间看着像功能没生效）。2026-10-31。
  const last = await hearMark(root, { turns })
  if (turns - last < every) return { written: false, why: 'not-this-turn' }

  const sentence = pickHearSentence(o.text)
  if (!sentence) return { written: false, why: 'nothing-to-keep' }

  try {
    // 带上这条会话的 id（2026-11-08，用户 m01199）：出门/请神结束时算「这一趟多了什么」，
    // 是按「开始时间 + 这一趟的会话 id」取的；没有 id 的条目一律当时间窗内的，
    // 于是家里记下的这句原话会混进那趟的清单，被人一划就当成那趟的东西标掉。
    // 家里这条也是「他说过什么」，不该跟着别人的一趟一起不算。
    const ev = await appendEvent(
      { type: 'heard', text: sentence, ...(o.sessionId ? { sessionId: String(o.sessionId) } : {}) },
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
