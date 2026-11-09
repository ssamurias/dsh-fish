/**
 * clip.js —— 截断文本时不许把一个字符从中间切开（2026-11-10，外部真机）。
 *
 * 那台机器上一条 bili_look 的工具结果按 200 个 UTF-16 单元硬截，把一个 emoji
 * （U+1F923，高位 \ud83d + 低位 \ude23）从中间切开，留下半个高位代理项。这条消息
 * 进了会话上下文以后，之后每个请求都带着这个非法字符发给服务端，连续 400。
 *
 * 两件事，别混：
 *   clipText()  —— 切点退到字符边界，切完仍然是一个合法字符串；
 *   cleanText() —— 已经混进来的孤立代理项（旧数据、外部接口、宿主传来的半截文本）
 *                  换成 U+FFFD，不再往下游传。
 *
 * 只处理代理对（星形平面以上的字符），不做字素簇切分：合字、肤色修饰符被切开
 * 只是显示上难看，不会让请求变非法，不值得为此按住整段文本。
 */

/** 结尾是一个高位代理项 —— 说明下一个单元本该是低位，被切掉了。 */
const TRAILING_HIGH = /[\uD800-\uDBFF]$/

/** 没有配对的代理项：高位后面不是低位，或低位前面不是高位。 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

/** 有没有孤立代理项（测试与自检用，不改文本）。 */
export function hasLoneSurrogate(value) {
  const s = typeof value === 'string' ? value : value == null ? '' : String(value)
  return LONE_SURROGATE.test(s)
}

/**
 * 把孤立的代理项换成 U+FFFD。成对的代理项原样保留。
 * @param {unknown} value
 * @returns {string}
 */
export function cleanText(value) {
  const s = typeof value === 'string' ? value : value == null ? '' : String(value)
  LONE_SURROGATE.lastIndex = 0
  return LONE_SURROGATE.test(s) ? s.replace(LONE_SURROGATE, '\uFFFD') : s
}

/**
 * 截到 max 个 UTF-16 单元，但不切开代理对。
 * @param {unknown} value 原文
 * @param {number} max 上限（含结尾的 tail）
 * @param {string} [tail] 截断标记，默认「…」；传 '' 就是纯截断
 * @returns {string}
 */
export function clipText(value, max, tail = '…') {
  const s = cleanText(value)
  const n = Number(max)
  if (!Number.isFinite(n) || n <= 0 || s.length <= n) return s
  const mark = String(tail ?? '')
  const keep = Math.max(0, n - mark.length)
  let cut = s.slice(0, keep)
  if (TRAILING_HIGH.test(cut)) cut = cut.slice(0, -1) // 退一格，别留下半个字符
  cut = cut.replace(/\s+$/, '')
  return cut + mark
}
