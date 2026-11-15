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
 *   - 例外（2026-11-14，用户 m00242）：整段就是一句不到 8 个字的「结果话」
 *     （「好了」「不胀了」「到家了」）时，照样记，并且不占上面那个间隔——
 *     这类话是「那件事收尾了」的唯一凭据，错过它，她就只记得事情没做完。
 *   - 系统侧写（`source:'system'`）。她**不能**写 heard——否则她能凭空造一句
 *     "他说过"，而那正是这条记录唯一的凭据价值。
 *   - 写失败只 log，绝不让记账连累对话。
 */

import { appendEvent, readEvents } from './store.js'
import { hearMark, setHearMark } from './home.js'
import { loadConfig } from './settings.js'

/** 一句最多多少字（对齐 talkmem 的 TALK_SNIPPET） */
export const HEAR_SNIPPET = 160
/** 太短的话不值得记：「嗯」「好」记下来也翻不出什么 */
export const HEAR_MIN_CHARS = 8
/** 默认每几轮记一次 */
export const HEAR_EVERY = 3
/**
 * 「有结果了」的词（2026-11-14，用户 m00242 第二个反馈：肚子胀→好了，换会话后她还问）。
 *
 * 这类话往往只有两个字（「好了」「不胀了」），过不了 `HEAR_MIN_CHARS`，
 * 于是事件流里只留下当初那句「他说过肚子胀」，没有「后来好了」。
 * 只认这几个表示「那件事收尾了」的说法，不把「嗯」「在」这类接话也放进来——
 * 放进来就等于每轮都记，账本会被撑爆，她的记忆也没有重点。
 */
export const HEAR_STATUS_WORDS = [
  '好了', '好多了', '好点了', '好些了', '不痛了', '不疼了', '不胀了', '不难受了',
  '没事了', '没事儿了', '退烧了', '消肿了', '康复了', '停药了',
  '做完了', '弄完了', '弄好了', '办完了', '办好了', '搞定了', '忙完了', '交完了',
  '结束了', '吃过了', '吃饱了', '睡了', '醒了', '到了', '到家了', '回来了', '下班了',
]

/**
 * 短状态句：整段就是一句很短的话，且含「有结果了」的词。
 * 纯函数，永不抛；不是这种句子就返回空串（长句交给 pickHearSentence）。
 */
export function pickHearStatus(text) {
  const s = stripLeadingHeader(text)
  if (!s) return ''
  const parts = s
    .split(/[。！？!?；;\n]+/)
    .map((p) => p.trim())
    .filter(Boolean)
  // 一段话里有好几句：交给 pickHearSentence 取最长那句，不从长段里抠两个字的碎片。
  if (parts.length !== 1) return ''
  const best = parts[0]
  if (best.length < 2 || best.length >= HEAR_MIN_CHARS) return ''
  if (!HEAR_STATUS_WORDS.some((w) => best.includes(w))) return ''
  return best.length > HEAR_SNIPPET ? best.slice(0, HEAR_SNIPPET - 1) + '…' : best
}

/**
 * 补丁能接多远：超过这个天数的旧话，接上去就不是「补充」而是翻旧账了。
 */
export const HEAR_LINK_DAYS = 7

/**
 * 短状态句接的是哪一条（2026-11-14，用户 m00533 的 ②）。
 *
 * 为什么不是关键词匹配：「肚子胀」与「好了」一个字都不重合——真按词找，永远接不上，
 * 而那正是要修的那个场景（先说难受，隔天说好了，她只记得难受）。
 * 所以按**时间上的邻居**接：最近一条「有内容」的 heard，7 天内。它是不是同一件事，
 * 由读的人自己判断；她读到的是「他说过肚子胀（13 日）；后来接着说：好了（14 日）」，
 * 时间顺序本身已经把「哪句在后」说清了，不需要系统替她断言「好了的是肚子」。
 *
 * 边界：
 *   - 群聊那句不接：群里话题轮转太快，接上去多半是错配。
 *   - 目标本身是短状态句时不接（「好了」不该给「到家了」当靶子），免得串成一串碎片。
 *   - 只找得到就返回 id，找不到返回空串；永不抛。
 *
 * @param {object[]} events readEvents() 的结果（新→旧或旧→新都行，这里自己比 ts）
 * @param {{now?:number, days?:number}} o
 * @returns {string}
 */
export function latestHeardId(events = [], { now = Date.now(), days = HEAR_LINK_DAYS } = {}) {
  const since = Number(now) - Number(days) * 86_400_000
  let best = ''
  let bestTs = -Infinity
  for (const ev of events ?? []) {
    if (!ev || String(ev.type ?? '') !== 'heard' || ev.scene === 'group') continue
    const text = String(ev.text ?? '').trim()
    // 两三个字的「嗯」「在吗」本来就不会被写成 heard；真写进来了也别当锚点——
    // 「好了」接在「嗯」后面等于没接。
    if (text.length < 2 || pickHearStatus(text)) continue
    const ts = Date.parse(String(ev.ts ?? ''))
    if (!Number.isFinite(ts) || ts < since) continue
    if (ts > bestTs) {
      bestTs = ts
      best = String(ev.id ?? '')
    }
  }
  return best
}

/**
 * 去掉桥塞在正文**开头**的来源抬头（2026-11-09，issue #96）。
 *
 * 桥把群聊原样转进来时，常在正文前加一行「（群聊 · 示例群 · im:group:10001）」。
 * 这一行往往比人说的话还长，`pickHearSentence` 取最长的一句，记成「他说」的
 * 就变成抬头。`stripChannelNote` 只管正文末尾的 `[渠道：…]` 段落，够不着开头。
 *
 * 只认**整行被括号包住、且带群/渠道/频道/im: 字样**的那种抬头，宁可少裁：
 * 一句普通的话被误裁掉，就等于把他的话从记忆里抹了。
 */
export function stripLeadingHeader(text) {
  const lines = String(text ?? '').replace(/\r/g, '').split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i].trim()
    if (!line) {
      i += 1
      continue
    }
    const wrapped = /^[（(【\[].*[）)】\]]$/.test(line)
    if (wrapped && /(群|渠道|频道|im:|chat)/i.test(line)) {
      i += 1
      continue
    }
    break
  }
  return lines.slice(i).join('\n').trim()
}

/**
 * 从一段话里挑出最值得留的一句。
 * 按句号/问号/叹号/分号/换行切；取最长的一句；截到 HEAR_SNIPPET。
 * 纯函数，永不抛。
 */
export function pickHearSentence(text) {
  const s = stripLeadingHeader(text)
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
  const sentence = pickHearSentence(o.text)
  // 短状态句（「好了」「不胀了」）不够 HEAR_MIN_CHARS，但那是「那件事有结果了」的关键一句：
  // 跳过「每几轮记一次」的间隔——状态变化不常发生，等间隔等于把它等没了。
  const short = sentence ? '' : pickHearStatus(o.text)
  if (!sentence && !short) return { written: false, why: 'nothing-to-keep' }
  // 「离上次记过去了几轮」而不是「turns 能不能被 every 整除」：
  // 后者从装插件那天开始算，旁听后装上的话要等很久才轮到一次（本机实测 0.8.0
  // 装上时 turns 已经 4，下一次整除是 6，中间看着像功能没生效）。2026-10-31。
  if (!short) {
    const last = await hearMark(root, { turns })
    if (turns - last < every) return { written: false, why: 'not-this-turn' }
  }

  const kept = short || sentence

  // 短状态句挂在那句旧话后面（见 latestHeardId）：单独一条「好了」她读了也没用。
  // 读盘失败就当没接上——补丁是加分的，不能为了它把这句本身弄丢。
  let re = ''
  if (short) {
    try {
      const { events } = await readEvents(root)
      re = latestHeardId(events)
    } catch { /* 读不到就不接 */ }
  }

  try {
    // 带上这条会话的 id（2026-11-08，用户 m01199）：出门/请神结束时算「这一趟多了什么」，
    // 是按「开始时间 + 这一趟的会话 id」取的；没有 id 的条目一律当时间窗内的，
    // 于是家里记下的这句原话会混进那趟的清单，被人一划就当成那趟的东西标掉。
    // 家里这条也是「他说过什么」，不该跟着别人的一趟一起不算。
    const ev = await appendEvent(
      { type: 'heard', text: kept, ...(re ? { re } : {}), ...(o.sessionId ? { sessionId: String(o.sessionId) } : {}) },
      { day: Number(o.day ?? 0), stage: Number(o.stage ?? 1), source: 'system' },
      root,
    )
    await setHearMark(root, turns)
    return { written: true, id: ev.id, text: kept }
  } catch (err) {
    log('hear · 没记下他说的那句', err?.message ?? err)
    return { written: false, why: 'failed' }
  }
}
