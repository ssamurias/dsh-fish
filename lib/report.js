/**
 * report.js —— 每天一份 `out/YYYY-MM-DD.md`
 *
 * 关键取舍：**这份报告不是"她的总结"，是"她的记录"。**
 * 代码只做转写：她今天看了什么（事实）、她今天说了什么（原文引用）。
 * 任何"今天她了解了…""可以看出她…"这类概括都不允许出现在这里——
 * 一旦代码替她总结，她的表达权就被剥夺了，剩下的只是内容管道。
 *
 * 为什么仍然要落一份文件：
 *   1. 事件流是给程序读的，人是读不下去的（一行一条 JSON）。
 *   2. 用户要看"她今天干了什么"时，不该要求他打开 events.jsonl 自己拼。
 *   3. 报告可以随时删除重建，不是真相源（真相源永远只有 events.jsonl 与 diary/）。
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { paths, writeAtomic, readEvents, readDaily, readConfig } from './store.js'
import { dateKey } from './settings.js'
// 她自己的第三人称（1.0.1，issue #139）：只填固定标题里的 {S}，不碰引用的原话。
import { normalizeSelfPronoun, fillSelf } from './selfpronoun.js'

/** 她的话（可引用进报告的）：只取 HER_TYPES，meta 一律不进正文 */
const QUOTABLE = new Set(['utterance', 'revise', 'reunion', 'narration', 'refusal', 'answer'])

/**
 * 事件的时刻字段叫 `ts`（schema.js:133 写入 `ts`）。
 * 这里曾经写成 `e.at`，于是 quotesOf 永远返回空数组 →
 * 报告永远印「今天她什么都没说」，哪怕事件流里明明有她的原话。
 *
 * 第二个坑：`ts` 存的是 **UTC**（`new Date().toISOString()`），而 `dateKey()`
 * 给的是**本地**日期。东八区凌晨发生的事件，UTC 日期还是前一天，
 * 直接 `slice(0,10)` 比对就会把今天的话算到昨天 → 照样"什么都没说"。
 * 所以必须先把 ts 转成本地时间再取日期。
 */
const tsOf = (e) => String(e?.ts ?? e?.at ?? '')

/** 事件时刻 → 本地日期键（与 dateKey() 同口径） */
function localDay(ts) {
  const ms = Date.parse(ts)
  return Number.isFinite(ms) ? dateKey(new Date(ms)) : ''
}

/** 事件时刻 → 本地 HH:MM */
function localClock(ts) {
  const ms = Date.parse(ts)
  if (!Number.isFinite(ms)) return ''
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * 只留在对话里说过、没被她自己认领下来的话。
 *
 * 2026-11-04（群反馈）：`turns.js` 的 `settle()` 会把这一轮她说过的话补写成
 * `utterance` 并打上 `flags:['uncommitted']`——注释写得很清楚：**只留证，不当信念**。
 * 但日报的 `quotesOf()` 只按「类型 + 当天」过滤，完全不看 flags，于是聊天原话
 * 和她在 `growth_commit` 里认领下来的话一视同仁，全被当成「她说了什么」印成一长串，
 * 一天聊几十句的那天，日报就只剩流水账，回看分不清主次。
 *
 * `uncommitted` 在仓库里唯一的逻辑读者是 `derive.js` 的 `wontCount`（数她拒绝过几次），
 * 所以不进日报不影响任何判定，纯粹是展示口径。
 */
const isChatOnly = (e) => Array.isArray(e?.flags) && e.flags.includes('uncommitted')

/** 某一天她自己**认领下来**的话（按时间顺序）。聊天原话不算。 */
export function quotesOf(events, dk) {
  const out = []
  for (const e of events ?? []) {
    if (!QUOTABLE.has(e?.type)) continue
    if (localDay(tsOf(e)) !== dk) continue
    if (isChatOnly(e)) continue
    out.push(e)
  }
  return out.sort((a, b) => tsOf(a).localeCompare(tsOf(b)))
}

/** 「聊天时说过的」最多列几段（最近的）、每段多少字。 */
export const REPORT_CHAT_LINES = 20
export const REPORT_CHAT_CHARS = 120

/** 某一天只在对话里说过、没认领下来的那些话（按时间顺序）。 */
export function chatLinesOf(events, dk) {
  const out = []
  for (const e of events ?? []) {
    if (!QUOTABLE.has(e?.type)) continue
    if (localDay(tsOf(e)) !== dk) continue
    if (!isChatOnly(e)) continue
    out.push(e)
  }
  return out.sort((a, b) => tsOf(a).localeCompare(tsOf(b)))
}

/** 某一天只在对话里说过、没认领下来的句子条数。用来把「什么都没说」和「只在聊天里说过」分开。 */
export function chatOnlyCount(events, dk) {
  return chatLinesOf(events, dk).length
}

export function fmtDur(sec) {
  const n = Math.max(0, Math.round(Number(sec) || 0))
  const m = Math.floor(n / 60)
  const s = n % 60
  return m ? `${m}分${String(s).padStart(2, '0')}秒` : `${s}秒`
}

/** 单条视频的一行记录（没有评价，只有事实） */
function lineOf(item, i) {
  const bits = [`${i + 1}. **[${item.bvid}](https://www.bilibili.com/video/${item.bvid})** ${item.title || '(无标题)'}`]
  const meta = [
    item.up ? `UP ${item.up}` : '',
    item.duration ? fmtDur(item.duration) : '',
    item.view ? `${Number(item.view).toLocaleString('zh-CN')} 播放` : '',
    item.handed ? '你递过来的' : '',
  ].filter(Boolean)
  if (meta.length) bits.push(`   - ${meta.join(' · ')}`)
  if (item.reason) bits.push(`   - 停在这条的理由：${item.reason}`)
  return bits.join('\n')
}

/**
 * 生成一天的报告。
 *
 * 2026-10-30 改（客户反馈）：原来只有一节 `## 看了什么`，内容来自 `browse:` 记账——
 * 那是「她翻列表时读过的标题与评论」，跟「有没有真的看见画面」没关系。
 * 于是她只扫了眼标题，日志也写「看了」，本人当场否认。现在拆成三节：
 *   看过画面（`watched:`，唯一凭证） / 翻到过什么（`browse:`、`look:`） / 你递过来的（`hand:`）。
 * 三节口径都由 `whatseen.js` 一个模块给，不在报告里另算一遍。
 *
 * 兼容：老调用方只传 `items`（旧口径，等于"翻到过什么"）时仍按翻到过处理。
 *
 * @param {{dateKey:string, items?:object[], seen?:{watched:object[],glanced:object[],handed:object[]}, notes?:string[], events?:object[], diary?:string|null, diaryVisible?:boolean}} o
 */
export function buildReport(o = {}) {
  const dk = o.dateKey ?? dateKey()
  // 旁观者视角的固定标题用 {S}；引用的原话（quotes/chat）一条都不经过它。
  const SHE = normalizeSelfPronoun(o.selfPronoun)
  const seen = o.seen ?? { watched: [], glanced: Array.isArray(o.items) ? o.items : [], handed: [] }
  const watched = Array.isArray(seen.watched) ? seen.watched : []
  const glanced = Array.isArray(seen.glanced) ? seen.glanced : []
  const handed = Array.isArray(seen.handed) ? seen.handed : []
  const quotes = quotesOf(o.events ?? [], dk)
  const chat = chatLinesOf(o.events ?? [], dk)
  const L = []

  L.push(`# ${dk}`)
  L.push('')

  L.push('## 看了什么')
  L.push('')
  if (watched.length) {
    L.push('真取了画面看过的：')
    L.push('')
    watched.forEach((it, i) => { L.push(lineOf(it, i)); L.push('') })
  } else {
    L.push('今天没看画面。')
    L.push('')
  }

  if (glanced.length) {
    L.push('## 翻到过什么')
    L.push('')
    L.push('_只有标题、简介、评论和弹幕——没有画面。翻到过不等于看过。_')
    L.push('')
    glanced.forEach((it, i) => { L.push(lineOf(it, i)); L.push('') })
  }

  if (handed.length) {
    L.push('## 你递过来的')
    L.push('')
    L.push(fillSelf('_递到{S}手上了，{S}还没看。_', SHE))
    L.push('')
    for (const it of handed) {
      L.push(`- **[${it.bvid}](https://www.bilibili.com/video/${it.bvid})**`)
    }
    L.push('')
  }

  L.push(fillSelf('## {S}说了什么', SHE))
  L.push('')
  if (quotes.length) {
    for (const q of quotes) {
      const t = localClock(tsOf(q))
      const tag = q.type === 'revise' ? `（改写自 ${(q.refs ?? []).join(',') || '?'}）` : ''
      L.push(`> ${String(q.text ?? '').replace(/\n+/g, ' ')}${tag}`)
      L.push(`> — ${t}${q.verdict ? ` · ${q.verdict}` : ''}`)
      L.push('')
    }
  } else {
    // 不能一律写「今天她什么都没说」——她可能只是在对话里说过，没认领下来，
    // 那样印出来的是一句假话。两种情形要分开说。
    L.push(chat.length ? '这一节今天是空的，聊天时说的在下面。' : fillSelf('今天{S}什么都没说。', SHE))
    L.push('')
  }

  // 聊天时说过的：单列一节，不全列。
  // 前提是「她这一轮真的说了话」——turns.js 的 settle() 会把这些话补写成
  // utterance 并打 flags:['uncommitted']，只留证不当信念；但一天聊几十轮的话
  // 全塞进「她说了什么」就只剩流水账，回看分不清哪几句是她自己记下的。
  // 所以另起一节、按时刻一行一段、只留最近的 20 段、每段 120 字。
  if (chat.length) {
    L.push('## 聊天时说过的')
    L.push('')
    L.push(fillSelf('_{S}在对话里说出口的话。_', SHE))
    L.push('')
    for (const q of chat.slice(-REPORT_CHAT_LINES)) {
      // 换行会把「一行一段」压坏；按 UTF-16 截时别把 emoji 切成半个。
      const text = String(q.text ?? '').replace(/\s+/g, ' ').trim()
      const cut = text.length > REPORT_CHAT_CHARS
        ? text.slice(0, REPORT_CHAT_CHARS - 1).replace(/[\uD800-\uDBFF]$/, '') + '…'
        : text
      L.push(`- ${localClock(tsOf(q))} ${cut}`)
    }
    L.push('')
    if (chat.length > REPORT_CHAT_LINES) {
      L.push(`_只列了最近 ${REPORT_CHAT_LINES} 段，今天一共 ${chat.length} 段。_`)
      L.push('')
    }
  }

  // 日记：默认不出现。只有配置里 visible=true 才贴进来。
  // 注意这里读的是 diary/ 目录，不是事件流——日记压根不进事件流（见 capture.js）。
  if (o.diaryVisible && o.diary) {
    L.push(fillSelf('## {S}的日记', SHE))
    L.push('')
    L.push(o.diary.trim())
    L.push('')
  }

  if (Array.isArray(o.notes) && o.notes.length) {
    L.push('---')
    L.push('')
    L.push(fillSelf('### 抓取备注（不是{S}的话）', SHE))
    for (const n of o.notes) L.push(`- ${n}`)
    L.push('')
  }

  L.push('---')
  L.push('')
  L.push('_这份文件由代码从事件流转写，只记录事实与原话，不含任何评价或总结。可以随时删除，下次会重新生成。_')
  L.push('')
  return L.join('\n')
}

/** 写文件，返回路径。永不抛出。 */
export async function writeReport(md, root, dk = dateKey()) {
  try {
    const file = join(paths(root).outDir, `${dk}.md`)
    await writeAtomic(file, md)
    return file
  } catch {
    return null
  }
}

/**
 * 一次完整落盘：读事件 + 读日记 + 拼 + 写。
 * @returns {Promise<string|null>} 文件路径
 */
export async function flushReport(root, o = {}) {
  const dk = o.dateKey ?? dateKey()
  try {
    const { events } = await readEvents(root)
    // 固定标题里的 {S}：读不到配置就按默认「她」，不影响落盘。
    const cfg = await readConfig(root).catch(() => null)
    const diary = o.diary !== undefined ? o.diary : await readDaily('diaryDir', dk, root).catch(() => null)
    const md = buildReport({
      dateKey: dk,
      selfPronoun: cfg?.self?.pronoun,
      items: o.items ?? [],
      // 不传 seen 时按旧口径（items = 翻到过）走，老调用方不炸。
      seen: o.seen ?? { watched: [], glanced: o.items ?? [], handed: [] },
      notes: o.notes ?? [],
      events,
      diary,
      diaryVisible: Boolean(o.diaryVisible),
    })
    return await writeReport(md, root, dk)
  } catch {
    return null
  }
}

/** 列出已有报告的日期（新→旧） */
export async function listReports(root) {
  try {
    const names = await fs.readdir(paths(root).outDir)
    return names.filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n)).map((n) => n.slice(0, 10)).sort().reverse()
  } catch {
    return []
  }
}
