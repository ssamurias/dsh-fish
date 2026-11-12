/**
 * pronoun.js —— 主人的代词（0.9.9 起，issue #127）
 *
 * 她一直把主人叫「他」。主人是女性、或者不想被分性别时，那一整份身份文档读起来
 * 都是错的。这个文件管两件事：**认配置**，以及把模板里的占位符填成那个代词。
 *
 * ## 2026-11-12 改过做法（用户 m00497 / m00894 定的）
 *
 * 0.9.9 的做法是「把她看到的文本里所有『他』整字换掉」。它有两个毛病：
 *   1. 她的原话也在被换的那份文本里——「我喜欢吉他」变成「我喜欢吉她」，
 *      等于替她改了以前说过的话；
 *   2. 写盘换一遍、读的时候又换一遍，同一份文本被换两次。
 *
 * 现在改成：**模板句本身不写「他」**，写占位符 `{T}`，渲染时填成 他 / 她 / TA。
 * 好处是不再有「按字换」这一步：
 *   - 她的原话里就算有「吉他」「他们」，也一个字节都不会被碰；
 *   - 只有我们自己写的、明确要指主人的地方才会被填；
 *   - 填几次都一样（幂等），所以不存在「换两遍」。
 *
 * 三道边界没变：
 *   1. 键名 `owner.pronoun`，取值只认 `他` / `她` / `TA`，缺省仍是 `他`；
 *   2. 渲染时按 root 现读配置（带 mtime 缓存），不做进程级可写状态——
 *      她可能同时住着好几条会话，共用可变变量会让 A 房间的代词串进 B 房间；
 *   3. 不碰 UI 文案（界面里本来就写「你」，见 AGENTS.md §4）。
 */

import { readFileSync, statSync } from 'node:fs'
import { paths } from './store.js'

/** 允许的三个值。别加「祂」「牠」这类——那是另一套指代，不在这个开关里。 */
export const PRONOUN_VALUES = Object.freeze(['他', '她', 'TA'])

/** 不配置时的值：和 0.9.8 及以前一模一样。 */
export const DEFAULT_PRONOUN = '他'

/**
 * 模板里指主人的位置。用三个字符，肉眼可见、不会被中文正文撞上；
 * 万一漏填了，测试与真机都能一眼看出来（不是悄悄变成错字）。
 */
export const OWNER_SLOT = '{T}'

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

// 最近一次从配置里读到的值。只用作「没有 root 可读时」的兜底（工具说明、
// 消息正文这些构造时拿不到 root 的地方），真正的判据仍然是 pronounFor(root)。
let lastKnown = DEFAULT_PRONOUN

/** 当前代词。没读过配置就是默认值。 */
export function activePronoun() {
  return lastKnown
}

/**
 * 填空：把模板里的 `{T}` 换成代词。幂等——填过一遍再填一次不会变。
 * @param {string} text
 * @param {'他'|'她'|'TA'|string} [pronoun]
 * @returns {string}
 */
export function fillOwner(text, pronoun = lastKnown) {
  const src = String(text ?? '')
  if (!src.includes(OWNER_SLOT)) return src
  return src.split(OWNER_SLOT).join(normalizePronoun(pronoun))
}

/**
 * 递归填空：工具返回值、卡片这类结构体里任何一处字符串都填上。
 *
 * 只认 `{T}` 这一个记号，所以对象里她的原话、用户原话都安全——
 * 那些文本里不会有这个记号（万一有，也只是被换成代词，不是被改字）。
 *
 * @template T
 * @param {T} value
 * @param {'他'|'她'|'TA'|string} [pronoun]
 * @returns {T}
 */
export function fillOwnerDeep(value, pronoun = lastKnown) {
  const p = normalizePronoun(pronoun)
  const walk = (v) => {
    if (typeof v === 'string') return fillOwner(v, p)
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      // 只处理普通对象：Map / Date / 类实例原样返回，免得把宿主对象拆坏。
      const proto = Object.getPrototypeOf(v)
      if (proto !== Object.prototype && proto !== null) return v
      const out = {}
      for (const [k, item] of Object.entries(v)) out[k] = walk(item)
      return out
    }
    return v
  }
  return walk(value)
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
    lastKnown = cache.pronoun
    return cache.pronoun
  } catch {
    return lastKnown
  }
}

/**
 * 开房前把代词读进来。工具说明是注册期一次性交出去的（之后不再求值），
 * 所以要在这里先读一遍，免得别人的配置是「她」、说明里却填成「他」。
 * @param {string} root
 * @returns {'他'|'她'|'TA'}
 */
export function primePronoun(root) {
  return pronounFor(root)
}

/** 测试用：清掉同步读的缓存。 */
export function resetPronounCache() {
  cache.file = ''
  cache.mtimeMs = -1
  cache.pronoun = DEFAULT_PRONOUN
  lastKnown = DEFAULT_PRONOUN
}
