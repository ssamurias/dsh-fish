/**
 * pronoun.js —— 主人的代词（0.9.9，issue #127）
 *
 * 她一直把主人叫「他」。主人是女性、或者不想被分性别时，那一整份身份文档读起来
 * 都是错的。这个文件只做一件事：把**给她看的文本**里指主人的那个「他」换成她/
 * TA；想换回去也还是这三个值。
 *
 * 三条边界（对应 issue #127 里作者问的三件事）：
 *   1. 键名 `owner.pronoun`，取值只认 `他` / `她` / `TA`，缺省仍是 `他`
 *      ——默认行为一个字都不变，不配置就是现在这样。
 *   2. 传值走**显式参数**：每次渲染按 root 现读配置（带 mtime 缓存），没有
 *      进程级 setter。她可能同时住着好几条会话，共用一个可变变量会让 A 房间的
 *      代词串进 B 房间正在渲染的那一轮。
 *   3. 只换「他」这一个字，不碰 UI 文案（界面里本来就写「你」，见 AGENTS.md §4）。
 *
 * 不改的东西：`其他`/`其它`/`他人`/`他者` 这类词里的「他」不是指主人，换掉就
 * 变成错字或另一个词，先挡下来再换。引用别人原话里的「他」也一视同仁地换——
 * 这些文本里几乎不会出现第三个人，硬要分辨谁是谁反而更容易错。
 */

import { readFileSync, statSync } from 'node:fs'
import { paths } from './store.js'

/** 允许的三个值。别加「祂」「牠」这类——那是另一套指代，不在这个开关里。 */
export const PRONOUN_VALUES = Object.freeze(['他', '她', 'TA'])

/** 不配置时的值：和 0.9.8 及以前一模一样。 */
export const DEFAULT_PRONOUN = '他'

/**
 * 这些词里的「他」是词素，不是主人。
 * 先换成占位符再统一替换，最后换回来（占位符里不含「他」，不会被二次命中）。
 */
const KEEP_WORDS = Object.freeze([
  '其他', '其它', '他人', '他者', '他日', '他乡', '他处', '他方', '他杀',
])

/**
 * 把配置值收成三个允许值之一。认不出来就退回默认，不抛错——一个拼错的键
 * 不该让整份配置保存失败。
 * @param {unknown} value
 * @returns {'他'|'她'|'TA'}
 */
export function normalizePronoun(value) {
  const s = String(value ?? '').trim()
  if (!s) return DEFAULT_PRONOUN
  if (s.toUpperCase() === 'TA') return 'TA'
  if (s === '她' || s === '他') return s
  return DEFAULT_PRONOUN
}

/**
 * 从一份完整配置里取代词。
 * @param {object} [config]
 * @returns {'他'|'她'|'TA'}
 */
export function pronounOf(config) {
  return normalizePronoun(config?.owner?.pronoun)
}

/**
 * 换字。代词是「他」时原样返回（99% 的调用走这条快路，不做任何字符串操作）。
 * @param {string} text
 * @param {'他'|'她'|'TA'|string} [pronoun]
 * @returns {string}
 */
export function pronounize(text, pronoun = DEFAULT_PRONOUN) {
  const src = String(text ?? '')
  const p = normalizePronoun(pronoun)
  if (!src || p === DEFAULT_PRONOUN) return src
  // 占位符用控制字符，正文里不会有；WINDOWS 下也照旧是 UTF-8 字符串操作。
  const kept = []
  let out = src
  for (const word of KEEP_WORDS) {
    if (!out.includes(word)) continue
    const mark = `\u0001${kept.length}\u0002`
    out = out.split(word).join(mark)
    kept.push(word)
  }
  out = out.split('他').join(p)
  for (let i = 0; i < kept.length; i += 1) {
    out = out.split(`\u0001${i}\u0002`).join(kept[i])
  }
  return out
}

// 给「每轮渲染一次」用的同步读：只读 config.json，按 mtime 缓存。
// 不缓存整份配置，也不缓存开出来的对象——这里只关心一个字段。
const cache = { file: '', mtimeMs: -1, pronoun: DEFAULT_PRONOUN }

/**
 * 按 root 现读配置里的代词（同步）。读不到、读坏都用默认值，永不抛。
 *
 * 为什么同步：身份段是 `systemPrompt.section({ text })`，宿主每轮现求值，
 * 那条路只能是同步的。这里只 stat + 读一个小 JSON，且按 mtime 缓存。
 * @param {string} root
 * @returns {'他'|'她'|'TA'}
 */
export function pronounFor(root) {
  try {
    const file = paths(root).config
    const st = statSync(file)
    if (cache.file !== file || cache.mtimeMs !== st.mtimeMs) {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      cache.pronoun = pronounOf(raw)
      cache.file = file
      cache.mtimeMs = st.mtimeMs
    }
    return cache.pronoun
  } catch {
    return DEFAULT_PRONOUN
  }
}

/** 测试用：清掉同步读的缓存。 */
export function resetPronounCache() {
  cache.file = ''
  cache.mtimeMs = -1
  cache.pronoun = DEFAULT_PRONOUN
}
