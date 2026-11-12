/**
 * keepsake.js —— 纪念品：这趟出门，她想带一件东西回来（0.6.17，用户 m02041 拍板）
 *
 * 用户拍板的规则：「她自己决定带，但是需要用户批准看同不同意」。
 * 所以这里分两步——
 *   1. 她在外面调 `bring_back` 说她看上了哪个文件 → 记一条 `asked`（只记路径，不动文件）；
 *   2. 那个人在出门页点「准了」→ 才真的复制进 `~/.dsh-fish/keepsakes/<日期>/`。
 *      点「算了」→ 标 `declined`，什么都不复制。
 *
 * 四条硬边界（都写死在代码里，不进配置）：
 *   - 只认**这一次出门那个工作区里**的文件（按归一化路径判前缀，`..` 跑不出去）；
 *   - 只认文件，不认目录、不认链接；
 *   - 单个 ≤ 20MB，一趟最多 3 件；
 *   - 没有进行中的出门 / 不是那条出门会话 → 不问，直接说清楚。
 *
 * 为什么不让她自己复制：
 *   复制动作会写进她家目录。让「带东西回来」这件事只有**那个人点头**之后才发生，
 *   她才不会因为一次误判把外面的东西塞进屋子里——这也是设计文档里
 *   「出门这一侧的四层防护」的延长线。
 */

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { basename, join, resolve } from 'node:path'

import { dateKey } from './settings.js'
import { fillOwner } from './pronoun.js'

export const KEEPSAKE_MAX_BYTES = 20 * 1024 * 1024
export const KEEPSAKES_PER_TRIP = 3
const KEEPSAKE_SCHEMA = 1

/** 台账文件（在数据目录里，和 outings.json 并排）。 */
export function keepsakesFile(root) {
  return join(root, 'keepsakes.json')
}

/** 复制回来的东西放这里：keepsakes/<日期>/<id>-<文件名>。 */
export function keepsakesDir(root, dk = '') {
  return dk ? join(root, 'keepsakes', dk) : join(root, 'keepsakes')
}

/** 一串路径抹平成 `a/b/c` 小写（用来判「在不在那个工作区里」）。 */
export function flatPath(p) {
  const bs = String.fromCharCode(92)
  return String(p ?? '')
    .split(bs)
    .join('/')
    .replace(/\/+$/, '')
    .toLowerCase()
}

/** target 在 base 里面（含相等）？ */
export function isInsidePath(base, target) {
  const b = flatPath(base)
  const t = flatPath(target)
  if (!b || !t) return false
  return t === b || t.startsWith(`${b}/`)
}

/** 这一趟的唯一标记：会话 id + 出发时刻。台账里没有单独的 id 字段。 */
export function tripKey(outing) {
  if (!outing) return ''
  return `${String(outing.sessionId ?? '')}@${Number(outing.startedAt) || 0}`
}

function readDb(root) {
  try {
    const raw = readFileSync(keepsakesFile(root), 'utf8')
    const db = JSON.parse(raw)
    if (db && Array.isArray(db.items)) return { version: Number(db.version) || KEEPSAKE_SCHEMA, items: db.items }
  } catch { /* 没有就是空的 */ }
  return { version: KEEPSAKE_SCHEMA, items: [] }
}

function writeDb(root, db) {
  writeFileSync(keepsakesFile(root), `${JSON.stringify({ version: KEEPSAKE_SCHEMA, items: db.items }, null, 2)}\n`, 'utf8')
}

/** 读全部纪念品记录（坏档不抛）。 */
export function readKeepsakes(root) {
  return readDb(root)
}

/** 这一趟的全部记录（asked / kept / declined）。 */
export function keepsakesOfTrip(root, trip) {
  const key = String(trip ?? '')
  if (!key) return []
  return readDb(root).items.filter((it) => it && it.trip === key)
}

/**
 * 她问「这件我能带回去吗」。
 * @returns {{ ok: boolean, item?: object, note: string }}
 */
export function askKeepsake(root, { outing = null, sessionId = '', rel = '', why = '', now = Date.now() } = {}) {
  if (!outing || outing.status !== 'active') return { ok: false, note: '现在没在外面。' }
  if (!outing.sessionId || String(outing.sessionId) !== String(sessionId ?? '')) {
    return { ok: false, note: '这句得从外面那条会话里说。' }
  }
  const raw = String(rel ?? '').trim()
  if (!raw) return { ok: false, note: '没说是什么。' }
  if (raw.length > 400) return { ok: false, note: '路径太长了。' }

  const db = readDb(root)
  const trip = tripKey(outing)
  const mine = db.items.filter((it) => it && it.trip === trip)
  const open = mine.filter((it) => it.status === 'asked')
  // 一趟最多问 3 次（含被回绝的）：不然她会一件件反复问，界面上变成待办清单。
  if (mine.length >= KEEPSAKES_PER_TRIP) {
    return { ok: false, note: '这一趟带得够多了。' }
  }
  if (open.length >= 1) {
    return { ok: false, note: open.some((it) => it.copyFailedAt) ? fillOwner('上一件{T}点了头，只是没复制成，还没带回来。') : '上一件还等着点头。' }
  }

  const cwd = String(outing.cwd ?? '')
  const target = resolve(cwd, raw)
  if (!isInsidePath(cwd, target)) return { ok: false, note: '只能带你这次出门那个工作区里的东西。' }
  let st = null
  try { st = lstatSync(target) } catch { return { ok: false, note: '没找到这个文件。' } }
  if (st.isSymbolicLink()) return { ok: false, note: '链接不行，要真文件。' }
  if (!st.isFile()) return { ok: false, note: '只能带文件，不能带文件夹。' }
  if (st.size > KEEPSAKE_MAX_BYTES) return { ok: false, note: '太大了，带不动。' }
  if (st.size <= 0) return { ok: false, note: '空文件，没什么好带的。' }

  const item = {
    id: `k-${now}-${Math.random().toString(36).slice(2, 6)}`,
    trip,
    outing: {
      sessionId: String(outing.sessionId),
      startedAt: Number(outing.startedAt) || 0,
      workspaceName: String(outing.workspaceName ?? ''),
      cwd,
    },
    // 只存相对路径：绝对路径里带着那位的工作区位置，界面上没必要露全。
    rel: String(target).slice(cwd.length).replace(/^[\\/]+/, ''),
    size: st.size,
    why: String(why ?? '').slice(0, 200),
    at: now,
    status: 'asked',
  }
  db.items.push(item)
  writeDb(root, db)
  return { ok: true, item, note: fillOwner('问了。等{T}点头。') }
}

/**
 * 那个人点头 / 摇头。
 * @returns {{ ok: boolean, item?: object, note: string }}
 */
export function decideKeepsake(root, { id = '', yes = false, now = Date.now() } = {}) {
  const db = readDb(root)
  const item = db.items.find((it) => it && it.id === String(id))
  if (!item) return { ok: false, note: '没找到这一件。' }
  if (item.status !== 'asked') return { ok: false, item, handled: true, note: '这一件已经处理过了。' }

  if (!yes) {
    item.status = 'declined'
    item.decidedAt = now
    writeDb(root, db)
    return { ok: true, item, note: '没带。' }
  }

  // 点头才动文件：再核一次「还在不在那个工作区里、还是不是文件、还没变大」。
  const cwd = String(item.outing?.cwd ?? '')
  const target = resolve(cwd, String(item.rel ?? ''))
  if (!isInsidePath(cwd, target) || !existsSync(target)) {
    item.status = 'declined'
    item.decidedAt = now
    item.why = '点头的时候文件不在了'
    writeDb(root, db)
    return { ok: false, item, note: '文件不在了，没带。' }
  }
  let st = null
  try { st = lstatSync(target) } catch { st = null }
  if (!st || !st.isFile() || st.size > KEEPSAKE_MAX_BYTES) {
    item.status = 'declined'
    item.decidedAt = now
    item.why = '点头的时候它变了'
    writeDb(root, db)
    return { ok: false, item, note: '这个文件现在不能带了。' }
  }

  const dk = dateKey(new Date(now))
  const dir = keepsakesDir(root, dk)
  const dest = join(dir, `${item.id}-${basename(target)}`)
  try {
    mkdirSync(dir, { recursive: true })
    copyFileSync(target, dest)
  } catch (err) {
    // 他说的是准了，只是这次没复制成（占用、权限）。还挂着，再答一次再试，不记成没带。
    item.copyFailedAt = now
    try { writeDb(root, db) } catch { /* 写不进去也还是 asked，只是下一件的说法不准 */ }
    return { ok: false, item, note: `没复制成（${String(err?.code ?? '出错了')}）。` }
  }
  item.status = 'kept'
  item.decidedAt = now
  item.keptAs = `${dk}/${basename(dest)}`
  item.size = st.size
  delete item.copyFailedAt
  try {
    writeDb(root, db)
  } catch (err) {
    // 盘上还是 asked：再答一次会覆盖同名文件，把账补上
    return { ok: false, item, note: `文件到家了，账没记上（${String(err?.code ?? '出错了')}），再答一次。` }
  }
  return { ok: true, item, note: '带回来了。' }
}

/** 还等着点头的那几件（界面用）。 */
export function pendingKeepsakes(root) {
  return readDb(root).items.filter((it) => it && it.status === 'asked')
}

/** 最近几趟带回来的（界面用，新的在前）。 */
export function recentKeepsakes(root, limit = 6) {
  const items = readDb(root).items
    .filter((it) => it && it.status === 'kept')
    .sort((a, b) => (Number(b.decidedAt) || 0) - (Number(a.decidedAt) || 0))
  return items.slice(0, Math.max(1, Math.min(20, limit)))
}
