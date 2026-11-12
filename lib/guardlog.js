/**
 * guardlog.js —— 拦截计数（0.9.9 S-A，issue #105 第 4 条落地）
 *
 * guard.js 现在**只拦不记**：一句想改写她的话被丢掉了，之后没人知道
 * 这个月到底拦了多少次。体检页要看到「本周挡掉几次」，就得有账。
 *
 * 三条边界，改这个文件时别破：
 *   1. **只记类别，不记原文**。写进事件流的是 `guard:rewrite` / `guard:secret`，
 *      被拦下的那句话一个字都不留——既是隐私，也是「不把脏东西写进她的档案」。
 *   2. 用 `meta`，不新增事件类型。旧版本读到未知类型本来就会跳过，但能少一次就少一次。
 *   3. **记账失败不许反过来影响拦截**。这条调用永远不抛，返回 false 就算了——
 *      拦人这件事比记账重要。
 */
import { appendEvent, rootDir } from './store.js'

/** 只有两类：想改写她、想带走钥匙。多一类就要先问一句「给她看这个数有什么用」。 */
export const GUARD_KINDS = Object.freeze(['rewrite', 'secret'])

/** `rewrite` → `guard:rewrite`。写与读共用这一处，别在两边各拼一遍字符串。 */
export function guardText(kind) {
  const k = String(kind ?? '')
  return GUARD_KINDS.includes(k) ? `guard:${k}` : ''
}

/** `guard:rewrite` → `rewrite`；不是这两类就 null（别的 meta 一律不掺进体检）。 */
export function parseGuardLine(text) {
  const t = String(text ?? '')
  if (!t.startsWith('guard:')) return null
  const k = t.slice('guard:'.length)
  return GUARD_KINDS.includes(k) ? k : null
}

/**
 * 记一笔拦截。调用方在**真的拦下之后**调，不要提前记。
 * 记账行跟 `use:` 一样是系统账：`day: 0`（不摆进时间线的某一天），只靠 ts 认时间。
 * @param {string} root 她的数据目录
 * @param {'rewrite'|'secret'} kind
 * @param {{day?:number, stage?:number}} [o]
 * @returns {Promise<boolean>} 记上了没有（失败也是 false，不抛）
 */
export async function recordGuard(root, kind, o = {}) {
  const k = String(kind ?? '')
  if (!GUARD_KINDS.includes(k)) return false
  try {
    await appendEvent(
      { type: 'meta', text: guardText(k) },
      {
        day: Math.max(0, Number(o.day) || 0),
        stage: Math.max(1, Number(o.stage) || 1),
        source: 'system',
      },
      root || rootDir(),
    )
    return true
  } catch {
    return false
  }
}
