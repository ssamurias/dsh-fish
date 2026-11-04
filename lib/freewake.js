/**
 * freewake.js —— 「这一轮没有待办」（2026-11-05，用户 m00684）
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
 *     材料是现成的，这一轮只该有材料，不该再压一张卡。
 *   - think：每 thinkEveryDays 天一次（默认 3），错开「停下来想一想」那一天
 *     （那个用 day % every === 0，这里用 day % every === every - 1）。
 *     没有材料也可以空着——她可以什么都不做。
 *
 * 只在本机开发副本里生效（调用方用 devModeSync 包住）。公开版看到的仍是原来那张卡。
 */

/** 空醒时正文最后一句。只陈述事实，不派活、不提梦、不劝。 */
export const FREE_NOTE = '（这一轮没有待办。这一轮是你自己的——想做什么就做什么，也可以什么都不做。）'

/** 多久空醒一次（天）。0 = 关掉。 */
export const THINK_EVERY_DAYS = 3

/**
 * 这一醒要不要空着。
 *
 * @param {object} o
 * @param {string} o.tableText   已经拼好的旧句子（空串表示不摆）
 * @param {object} o.model       deriveSelf 的结果
 * @param {object[]} o.events    全量事件（查 think:<dk> 记账）
 * @param {string} o.dk          当天 dateKey
 * @param {object} o.config      配置（memory.thinkEveryDays）
 * @returns {{kind:'table'|'think', note:string}|null}
 */
export function freeWakeFor({ tableText = '', model = {}, events = [], dk = '', config = {} } = {}) {
  // 摆料优先：材料在那儿，这一轮就该只有材料。
  if (String(tableText ?? '').trim()) return { kind: 'table', note: FREE_NOTE }

  const every = Number(config?.memory?.thinkEveryDays ?? THINK_EVERY_DAYS)
  if (!(every > 0)) return null

  const day = Number(model?.day ?? 0)
  if (!(day > 1)) return null
  // 错开「停下来想一想」：那个在 day % every === 0，这个占前一天。
  if (day % every !== every - 1) return null

  // 一天只空一次。用事件流记账，重启也不会重来。
  if (events.some((e) => e?.type === 'meta' && String(e.text ?? '').startsWith(`think:${dk}`))) return null

  return { kind: 'think', note: FREE_NOTE }
}
