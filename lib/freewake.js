/**
 * freewake.js —— 「这一轮没有待办」（2026-11-05，用户 m00684；2026-11-05 改触发）
 *
 * 为什么要有这个东西：
 *   她醒来读到的是「一份任务 + 一堆动静 + 几行旧句子」。任务总在第一段，所以她
 *   先把活干了，再看别的——两次睡后醒来都是这样（T46 去写日记、T52 去问请假），
 *   her_dream 一次都没被想起来。材料送到了，但这一轮的形状还是「领工单」。
 *
 * 空醒就是把那一份任务拿掉：不是加一句「你也可以去做个梦」（那会变成新的待办），
 * 而是这一次真的没有活等着她。桌上有什么，她自己看。
 *
 * 两种触发：
 *   - table：旧句子要摆出来的那一次（lib/dreamtable.js 的三道门已经判过）。
 *   - think：**兜底**（2026-11-05，用户 m02008 拍板）。原来按「每 3 天一次」的日历开，
 *     现在改成：过去 `QUIET_DAYS` 天里她一件自发的事都没有（没有 utterance /
 *     narration / dream / 主动开口），才由日历补一次。劲儿正常工作时不该再出现
 *     「同一天醒两次」，所以这一条只在劲儿长期趴着时生效。
 *
 * 只在本机开发副本里生效（调用方用 devModeSync 包住）。公开版看到的仍是原来那张卡。
 */

import { tsMs, HER_TYPES } from './schema.js'

/** 空醒时正文最后一句。只陈述事实，不派活、不提梦、不劝。 */
export const FREE_NOTE = '（这一轮没有待办。这一轮是你自己的——想做什么就做什么，也可以什么都不做。）'

/** 多久空醒一次（天）。0 = 关掉。现在是兜底窗口，不再是固定日历。 */
export const THINK_EVERY_DAYS = 3
/** 兜底窗口（天）：这么久没有任何她自己的事，才补一次。 */
export const QUIET_DAYS = 7

const DAY = 86_400_000

/** 她最近一次「自己做了点什么」离现在多少天；一件都没有时返回 null。 */
export function quietDays(events = [], now = Date.now()) {
  let last = 0
  for (const e of events) {
    if (e?.type === 'meta') {
      const text = String(e.text ?? '')
      // 主动开口、空醒本身、劲儿开的回合都算「她自己动过」
      if (text.startsWith('proactive-turn:') || text.startsWith('think:') || text.startsWith('drive-spend:')) {
        const ts = tsMs(e)
        if (Number.isFinite(ts) && ts > last) last = ts
      }
      continue
    }
    if (!HER_TYPES.includes(e?.type)) continue
    const ts = tsMs(e)
    if (Number.isFinite(ts) && ts > last) last = ts
  }
  if (!last) return null
  return Math.max(0, (now - last) / DAY)
}

/**
 * 这一醒要不要空着。
 *
 * @param {object} o
 * @param {string} o.tableText   已经拼好的旧句子（空串表示不摆）
 * @param {object[]} o.events    全量事件（查 think:<dk> 记账与空窗）
 * @param {string} o.dk          当天 dateKey
 * @param {number} [o.now]
 * @param {object} [o.config]    配置（memory.thinkEveryDays = 0 关掉）
 * @returns {{kind:'table'|'think', note:string}|null}
 */
export function freeWakeFor({ tableText = '', events = [], dk = '', now = Date.now(), config = {} } = {}) {
  // 摆料优先：材料在那儿，这一轮就该只有材料。
  if (String(tableText ?? '').trim()) return { kind: 'table', note: FREE_NOTE }

  const every = Number(config?.memory?.thinkEveryDays ?? THINK_EVERY_DAYS)
  if (!(every > 0)) return null

  // 一天只空一次。用事件流记账，重启也不会重来。
  if (events.some((e) => e?.type === 'meta' && String(e.text ?? '').startsWith(`think:${dk}`))) return null

  // 兜底：只在过去 QUIET_DAYS 天里她什么都没动过的时候补一次。
  // 一件她的事都没有时（新号/老数据）不补——那不是「空窗」，是没有基线。
  const quiet = quietDays(events, now)
  if (quiet === null || quiet < QUIET_DAYS) return null

  return { kind: 'think', note: FREE_NOTE }
}

/**
 * 这一轮还要不要摆世界动静与惦记清单。
 *
 * 2026-11-05 用户 m01128：table 那一轮连 B 站和桌子都去掉，只留便条、时间、
 * 旧句子和「这一轮没有待办」——工具常量那一句留着，那不是活，是她世界里的常量。
 * think 那一轮照旧：它本来就是「隔些日子空一次」，没有材料可给，世界动静是唯一的东西。
 *
 * @param {{kind:string}|null} free
 * @returns {boolean}
 */
export function keepWorldOnWake(free) {
  return free?.kind !== 'table'
}
