/**
 * echo.js —— 同一轮里她重抄上一轮自己的话（2026-11-11）
 *
 * 症状：工具调用那一轮被宿主拆成两步，step 1 只调工具、正文为空（len=0）；
 * step 2 的模型不知道「这一步已经说过话」，从上下文里找到最近一段她自己的话，
 * 当成草稿又抄了一遍。她并不觉得自己在重复，所以身份文档里写「别重复」没用。
 *
 * 这里只在**落盘前**裁：同一 turn 的多段 assistant 文本，若与上一轮她最后
 * 说的那段（或本 turn 已保留的前一段）有足够长的连续重合，就只留新增部分。
 * 不碰模型输出，不碰会话上下文，裁完只影响 talk-recent.json 与 utterance。
 *
 * 判据保守：
 *   - 连续重合至少 ECHO_MIN 个字才算「抄」，短引用不动；
 *   - 重合块必须从这段开头起（start <= ECHO_HEAD），否则不动——
 *     中间挖洞会把前后句粘成病句；
 *   - 重合覆盖到 ECHO_WHOLE 以上，整段算复述，返回空；
 *   - 全为空白的段直接返回空。
 */

const ECHO_MIN = 24
// 只认「从头起的重合」；前面还夹着别的字（哪怕是「嗯。」）就不挖洞。
const ECHO_HEAD = 0
const ECHO_WHOLE = 0.85

/** 找 s 与 p 的最长连续公共段；没有 ≥ECHO_MIN 的命中返回 null。 */
function longestShared(s, p) {
  if (s.length < ECHO_MIN || p.length < ECHO_MIN) return null
  const index = new Map()
  for (let j = 0; j + ECHO_MIN <= p.length; j++) {
    const key = p.slice(j, j + ECHO_MIN)
    if (!index.has(key)) index.set(key, j)
  }
  let best = null
  for (let i = 0; i + ECHO_MIN <= s.length; i++) {
    const key = s.slice(i, i + ECHO_MIN)
    const j = index.get(key)
    if (j === undefined) continue
    let a = i
    let x = j
    let b = i + ECHO_MIN
    let y = j + ECHO_MIN
    while (a > 0 && x > 0 && s[a - 1] === p[x - 1]) {
      a--
      x--
    }
    while (b < s.length && y < p.length && s[b] === p[y]) {
      b++
      y++
    }
    if (!best || b - a > best.end - best.start) best = { start: a, end: b }
  }
  return best
}

/** 从一段话里裁掉与 previous 各段开头重合的那截；裁完只剩空白就返回空。 */
export function stripEchoedStep(text, previous = []) {
  let s = String(text ?? '').trim()
  if (!s) return ''
  const prevs = (Array.isArray(previous) ? previous : [previous])
    .map((x) => String(x ?? '').trim())
    .filter((x) => x.length >= ECHO_MIN)
  for (const p of prevs) {
    const hit = longestShared(s, p)
    if (!hit) continue
    const len = hit.end - hit.start
    if (hit.start > ECHO_HEAD) {
      if (len / s.length >= ECHO_WHOLE) return ''
      continue
    }
    const rest = (s.slice(0, hit.start) + s.slice(hit.end)).replace(/^[\s，。！？、；：…—]+/, '').trim()
    if (!rest) return ''
    s = rest
  }
  return s.trim()
}
