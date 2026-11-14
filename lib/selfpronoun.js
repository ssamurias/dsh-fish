/**
 * selfpronoun.js —— 她自己的第三人称（1.0.1 起，issue #139）
 *
 * 界面里提到她时一直写「她」（设置页、状态卡、日报标题、FAQ 这些旁观者视角的
 * 固定文案）。有人想换成「祂」。这个文件只管一件事：**认配置**，以及把
 * 我们写的模板里的 `{S}` 填成那个字。
 *
 * ## 为什么不做成「按字换」
 *
 * 不碰她说过的话、日记、事件原文、日志内部原因——那些是她的原话，不是界面文案。
 * 所以出口只认 `{S}` 这一个记号：谁要换，谁在模板里写 `{S}`；没写的（她的原话、
 * 别的模块的注释与日志）一个字节都不动。
 *
 * ## 三道边界
 *
 *   1. 键名 `self.pronoun`，取值认 `他` / `她` / `祂`，缺省仍是 `她`；
 *      不加「它」「牠」——那是另一种指代，不在这个开关里；
 *   2. 只影响**旁观者视角的固定文案**（界面、日报标题、自检标签），
 *      不进口吻、不进身份文档、不改 `大肥鱼` 这个产品名；
 *   3. 渲染时按 root 现读配置（带 mtime 缓存），不做进程级可写状态——
 *      她可能同时住着好几条会话，A 房间的代词不能串进 B 房间。
 */

import { readFileSync, statSync } from 'node:fs'
import { paths } from './store.js'

/** 允许的三个值。别加「它」「牠」这类——那是另一套指代，不在这个开关里。 */
export const SELF_PRONOUN_VALUES = Object.freeze(['他', '她', '祂'])

/** 不配置时的值：和 1.0.0 及以前一模一样。 */
export const DEFAULT_SELF_PRONOUN = '她'

/** 模板里指她的位置。写成 `{S}`，不要写死「她」——写死的会被守卫测试拦下。 */
export const SELF_SLOT = '{S}'

/**
 * 把配置值收成三个允许值之一。认不出来就退回默认，不抛错。
 * @param {unknown} value
 * @returns {'他'|'她'|'祂'}
 */
export function normalizeSelfPronoun(value) {
  const s = String(value ?? '').trim()
  if (s === '他' || s === '祂') return s
  return DEFAULT_SELF_PRONOUN
}

/**
 * 从一份完整配置里取她自己的代词。
 * @param {object} [config]
 * @returns {'他'|'她'|'祂'}
 */
export function selfPronounOf(config) {
  return normalizeSelfPronoun(config?.self?.pronoun)
}

// 最近一次从配置里读到的值。只用作「没有 root 可读时」的兜底。
let lastKnown = DEFAULT_SELF_PRONOUN

/** 当前代词。没读过配置就是默认值。 */
export function activeSelfPronoun() {
  return lastKnown
}

/**
 * 填空：把模板里的 `{S}` 换成代词。幂等。
 * @param {string} text
 * @param {'他'|'她'|'祂'|string} [pronoun]
 * @returns {string}
 */
export function fillSelf(text, pronoun = lastKnown) {
  const src = String(text ?? '')
  if (!src.includes(SELF_SLOT)) return src
  return src.split(SELF_SLOT).join(normalizeSelfPronoun(pronoun))
}

// 给服务端「每轮渲染一次」用的同步读：只读 config.json，按 mtime 缓存。
const cache = { file: '', mtimeMs: -1, pronoun: DEFAULT_SELF_PRONOUN }

/**
 * 按 root 现读配置里的代词（同步）。读不到、读坏都用默认值，永不抛。
 * @param {string} root
 * @returns {'他'|'她'|'祂'}
 */
export function selfPronounFor(root) {
  try {
    const file = paths(root).config
    const st = statSync(file)
    if (cache.file !== file || cache.mtimeMs !== st.mtimeMs) {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      cache.pronoun = selfPronounOf(raw)
      cache.file = file
      cache.mtimeMs = st.mtimeMs
    }
    lastKnown = cache.pronoun
    return cache.pronoun
  } catch {
    return lastKnown
  }
}

/** 开房前读一遍，免得启动期的固定文案用错值。 */
export function primeSelfPronoun(root) {
  return selfPronounFor(root)
}

/** 测试用：清掉同步读的缓存。 */
export function resetSelfPronounCache() {
  cache.file = ''
  cache.mtimeMs = -1
  cache.pronoun = DEFAULT_SELF_PRONOUN
  lastKnown = DEFAULT_SELF_PRONOUN
}
