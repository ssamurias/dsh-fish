/**
 * locate.js —— 「她住在哪个文件夹」这件事的唯一真相源（2026-10-28，用户 m06510）
 *
 * 为什么需要它：`rootDir()` 是一个**同步**函数，而且被 `paths(root = rootDir())`
 * 这种默认参数在用（几十处）。默认参数不可能 await，所以「读一个记录当前位置的文件」
 * 这件事必须能同步做。这就是这个模块存在的全部理由——它只做同步读，不写任何东西。
 *
 * 优先级（与 rootDir 一致）：
 *   1. 环境变量 `DSH_FISH_HOME`（测试与临时目录用）
 *   2. 指针文件 `~/.dsh-fish-location.json` 的 `root` 字段（迁移之后写在里面的新位置）
 *   3. 老默认值 `~/.dsh-fish`
 *
 * 指针文件**必须放在她的数据目录之外**（放里面就等于搬家时把门牌号一起搬走了），
 * 所以它是 `~/.dsh-fish-location.json`，不是 `<root>/location.json`。
 */

import { readFileSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'

/** 指针文件的绝对路径。注意它在**数据目录之外**。 */
export function locationFile() {
  return process.env.DSH_FISH_LOCATION || join(homedir(), '.dsh-fish-location.json')
}

/** 默认位置（没迁移过时用的那个）。 */
export function defaultRoot() {
  return join(homedir(), '.dsh-fish')
}

// 模块级缓存：rootDir() 会被高频调用（每个 paths() 默认参数一次），
// 每次都 stat 一次盘太浪费。迁移完调 invalidateLocation() 清掉。
let cached = null
let cachedAt = 0
const CACHE_MS = 2000

/**
 * 读指针文件里记的位置。读不到、读坏了、字段不是绝对路径，一律返回空串
 * ——**绝不抛**。它的调用者是 rootDir()，那里抛一次整个插件就起不来了。
 */
export function readLocationSync({ fresh = false } = {}) {
  const now = Date.now()
  if (!fresh && cached !== null && now - cachedAt < CACHE_MS) return cached
  let root = ''
  try {
    const obj = JSON.parse(readFileSync(locationFile(), 'utf8'))
    const v = String(obj?.root ?? '').trim()
    // 只认绝对路径：相对路径会被当成"相对于当前工作目录"，那是随机的。
    if (v && (/^[A-Za-z]:[\\/]/.test(v) || v.startsWith('/') || v.startsWith('\\\\'))) root = v
  } catch {
    root = ''
  }
  cached = root
  cachedAt = now
  return root
}

/** 迁移之后必须调用一次，否则同一个进程里还会用旧位置。 */
export function invalidateLocation() {
  cached = null
  cachedAt = 0
}

/**
 * 「这个位置已经搬走了」的进程内记号。
 *
 * 迁移写完指针之后，这个进程手里还是启动时算好的老 root（重启才换）。老目录这时
 * 已经改名封存，再往老 root 追加事件，会把老位置重新建出来、写出一份只有新事件的
 * events.jsonl——重启后走指针去新位置，这几条就不在她的事件流里了。
 * 所以搬完到重启之间这个老 root 只读：`appendEvent` 和 `guardWrite` 都先问这里。
 *
 * 只记在内存里：重启之后 rootDir() 走指针，老 root 没人再用，记号也就不需要了。
 */
const movedAway = new Map()

/** 搬完到重启之间写不了时说的那句（工具回执和 appendEvent 抛出的错误共用）。 */
export const MOVED_NOTE = '数据文件夹刚搬到了新位置，重启 DSH 之前写不了，这一条没有记下。'

function rootKey(p) {
  let s = resolve(String(p))
  while (s.length > 1 && (s.endsWith(sep) || s.endsWith('/'))) s = s.slice(0, -1)
  return s.toLowerCase()
}

/** 记下「from 已经搬到 to」。此后对 from 的事件写入一律拒绝，直到进程重启（或 unsealRoot）。 */
export function sealRoot(from, to) {
  if (!from || !to) return
  movedAway.set(rootKey(from), String(to))
}

/** 迁移在写指针这一步没成：把记号撤掉，老位置照常可写。 */
export function unsealRoot(from) {
  if (!from) return
  movedAway.delete(rootKey(from))
}

/** root 要是已经搬走了，返回新位置；没搬过返回空串。 */
export function movedTo(root) {
  if (!root || !movedAway.size) return ''
  return movedAway.get(rootKey(root)) ?? ''
}

/** 目标目录是不是一个能当数据目录的地方（不判空、不建目录，只做形状判断）。 */
export function looksLikeRoot(dir) {
  try {
    return statSync(dir).isDirectory()
  } catch {
    return false
  }
}
