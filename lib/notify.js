/**
 * notify.js —— 说话提醒（P3-3 重写，2026-10-23）
 *
 * 她想说话的时候，让他不用一直盯着页面也能知道。
 *
 * ## 为什么把原来的实现整个删掉
 *
 * 原先走 Windows 原生 Toast：`powershell.exe -NoProfile -WindowStyle Hidden
 * -EncodedCommand <base64>`。实测被火绒拦下，报「隐藏执行 PowerShell」。
 *
 * 拦得对。**隐藏窗口 + Base64 命令行执行**是木马释放器最典型的行为签名，
 * 任何一家杀软都会把这个组合当高危。更糟的是失败形态：如果对方设成静默
 * 拦截，卡片不弹、**也没有任何错误返回**——代码以为成功了，`lastShown`
 * 被写掉，当天就再也不会弹第二次。用户以为功能坏了，日志里却干干净净。
 *
 * 所以这条路不是"调一调就能过"的，是形态本身错。现在改成：
 *
 *   - **服务端只判断"该不该提醒"，不负责弹。** `readPending()` 纯读，
 *     返回 `{due, text, why}`。
 *   - **弹由页面来做**（浏览器 `Notification`），页面没开就不弹。
 *   - 页面弹过之后 `POST /notify {shown:true}` 回写，保证一天一次。
 *
 * 代价是明说的：**页面关着就不会有卡片**。他第二天打开观测台能看到她说
 * 过什么——这是他本人接受的取舍（m05389），不是实现偷懒。
 *
 * ## 三条约束不变
 *   1. **默认关闭**（`notify.enabled: false`）。装好就弹是不礼貌的。
 *   2. **一天最多一次**，且只在她**今天真的开口之后**。叫醒失败、她没说
 *      话、只写了日记——一律不提醒。宁可少弹，不可乱弹。
 *   3. **不产生任何子进程**。没有 spawn、没有 shell、没有临时脚本文件。
 */

import { loadConfig, updateConfig, dateKey } from './settings.js'
import { readEvents } from './store.js'

/** 一条提醒最多带多少字她的原话。系统通知会截断，先自己截。 */
const SNIPPET_MAX = 90

/** 把她的原话压成一行可放进通知的摘要。空行和多余空白都压掉。 */
export function snippet(text, max = SNIPPET_MAX) {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!one) return ''
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`
}

/** 今天她说的最后一句话。只认 `utterance`，不算日记、不算信念。 */
export function lastUtteranceToday(events = [], today = '') {
  if (!today) return null
  let found = null
  for (const e of events) {
    if (e?.type !== 'utterance') continue
    // 聊天回合里没认领的回复他刚读过，不占一天一次的额度，也别顶掉留话
    if (Array.isArray(e.flags) && e.flags.includes('uncommitted')) continue
    const text = String(e.text ?? '').trim()
    if (!text) continue
    if (dateKey(new Date(e.ts)) !== today) continue
    found = { ...e, text }
  }
  return found
}

/**
 * 该不该提醒。**纯函数**，不读写任何文件——这样"为什么这次没弹"可以
 * 单测覆盖，不用真弹一次。
 *
 * @returns {{due:boolean, text:string, why:string}}
 */
export function shouldNotify({ events = [], config = {}, today = '' } = {}) {
  if (config?.notify?.enabled !== true) return { due: false, text: '', why: '提醒是关着的' }
  if (!today) return { due: false, text: '', why: '没有日期' }
  if ((config?.notify?.lastShown ?? '') === today) return { due: false, text: '', why: '今天已经提醒过一次' }
  const line = lastUtteranceToday(events, today)
  if (!line) return { due: false, text: '', why: '她今天还没说话' }
  return { due: true, text: snippet(line.text), why: '' }
}

/**
 * 读一次待提醒状态。给 `GET /notify` 用。
 *
 * @returns {Promise<{enabled:boolean, due:boolean, text:string, why:string, lastShown:string, today:string}>}
 */
export async function readPending(root, { today } = {}) {
  const dk = today || dateKey()
  const { config } = await loadConfig(root).catch(() => ({ config: null }))
  if (!config) return { enabled: false, due: false, text: '', why: '读不到配置', lastShown: '', today: dk }
  const { events } = await readEvents(root).catch(() => ({ events: [] }))
  const r = shouldNotify({ events, config, today: dk })
  return {
    enabled: config.notify?.enabled === true,
    due: r.due,
    text: r.text,
    why: r.why,
    lastShown: config.notify?.lastShown ?? '',
    today: dk,
  }
}

/**
 * 记下"今天提醒过了"。只有页面真的弹出来之后才该调。
 *
 * 失败不抛：回写失败最多是明天少弹一次，不值得让接口报错。
 */
export async function markShown(root, today = dateKey()) {
  try {
    const next = await updateConfig({ notify: { lastShown: today } }, root)
    return { ok: true, lastShown: next.notify?.lastShown ?? today }
  } catch {
    return { ok: false, lastShown: '' }
  }
}
