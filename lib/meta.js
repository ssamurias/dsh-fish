/**
 * meta.js —— 记账行和「她的事」的分界。
 *
 * 背景（2026-11-02，用户 m00335）：线上账本 443 行里有 400 行是 meta（90%），
 * 界面却把它一律报成「事件 443 条」——看上去像她记了 443 件事，其实她记下的
 * 只有 33 条，其余全系统自己写的后台记账。
 *
 * 三条边界，改代码前先看：
 *   1. **不删行。** `events.jsonl` 只能追加（AGENTS.md 第 5 条）。这里只做"读的时候
 *      怎么算"，不做"写的时候删掉什么"。
 *   2. **meta 不等于噪音。** 绝大多数 meta 前缀是有业务语义的定点标记
 *      （`seen:` / `looked:` / `sched:` / `wake:` / `diary:` / `sleep:` / `fired:` /
 *      `browse:` / `look:` / `watched:` / `proactive-turn:` / `proactive-say:` /
 *      `ask-no:` / `outing-reject:` / `possess-reject:` / `absence-reject:` /
 *      `outing-pending:` / `possess-pending:` / `outing-settled:` / `possess-settled:`），有读取方按前缀解析。
 *      只有 NOISE_PREFIXES 里这两类**没有任何读取方需要逐条历史**，才归到"纯记账"。
 *   3. **记账是必要的。** 别为了数字好看去堵写入——上面那些前缀一旦不写，
 *      去重、额度、评论闸门、驳回记录全都会失效。
 *
 * 两类纯记账：
 *   - `quiet:`   「今天没有该问的事」的解释。写入侧 `lib/scheduler.js` 自 0.6.2 起
 *                一天只写一条，历史里 2026-10-27 堆了 142 条、10-28 堆了 126 条。
 *                读取侧 `lib/status.js` 已按本地 dateKey 折叠成每天第一条。
 *   - `家换了：` 2026-10-28 那次全量测试往真实账本里灌临时家造成的重复误报
 *                （`lib/homes.js` 的 `skipped: 'temp'` 已修），全库没有读取方。
 */

export const NOISE_PREFIXES = ['quiet:', '家换了：']

/** 这条事件是不是「纯记账」——只影响怎么数、怎么显示，永远不影响它还在文件里。 */
export function isNoiseMeta(ev) {
  if (String(ev?.type ?? '') !== 'meta') return false
  const text = String(ev?.text ?? '')
  return NOISE_PREFIXES.some((p) => text.startsWith(p))
}

/**
 * 数一份事件流。返回：
 *   all   —— 文件里一共几行（原来界面报的就是这个）
 *   meta  —— 其中 meta 几行（含纯记账和有语义的）
 *   noise —— 其中纯记账几行
 *   real  —— 她的事几行（非 meta：她自己说的、他说的、日记、种子……）
 *
 * 界面该报 `real`。`all` 留着是为了体检/重置那种"整份文件多大"的场合。
 */
export function countEvents(events = []) {
  const list = Array.isArray(events) ? events : []
  let meta = 0
  let noise = 0
  for (const ev of list) {
    if (String(ev?.type ?? '') !== 'meta') continue
    meta += 1
    if (isNoiseMeta(ev)) noise += 1
  }
  return { all: list.length, meta, noise, real: list.length - meta }
}
