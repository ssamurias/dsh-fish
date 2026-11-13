/**
 * autobackup.js —— 定时把状态库存成一份 json（2026-11-14，用户 m00002）
 *
 * 为什么要有：
 *   手动那颗「备份成一份文件」走浏览器下载，落在用户当时随手选的地方（多半是「下载」）。
 *   真出事那天，人不会先想起来点它。这一层的价值就在「人不用记得」。
 *
 * 三条约束（和 backup.js 同一套）：
 *   1. 不引依赖、不做压缩：存出来的就是能被 `从备份恢复` 直接吃回去的那份 json。
 *   2. 存到 `<数据文件夹>/backups/`。这个目录已经在 backup.js 的 SKIP_DIRS 里，
 *      所以自动备份里不会裹着旧备份（否则一天比一天大，最后自己把自己撑爆）；
 *      目录跟着数据文件夹走，用户「搬到别的盘」之后旧备份也跟着搬，不在 C 盘留孤儿。
 *   3. 只动自己认得的那批文件（`大肥鱼-自动-YYYYMMDD-HHMMSS.json`）。同一目录里
 *      用户自己放的手动备份、别的 json，一律不删不改——清理只清它自己攒的。
 *
 * 该不该备份只由两件事决定：开关开着，且距离上次成功已经过了 everyDays 天。
 * 「上次成功」记在 config.backup.lastAt，所以重启 DSH 不会把计时重置成「一天备一次」。
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { collectBackup, bundleBytes, sizeText, BACKUP_FORMAT } from './backup.js'
import { rootDir, writeAtomic } from './store.js'
import { loadConfig, updateConfig } from './settings.js'

/** 自动备份文件名前缀。清理与列表都按它认人，别改。 */
export const AUTO_PREFIX = '大肥鱼-自动-'

const DAY_MS = 86_400_000

/** 攒自动备份的目录：`<数据文件夹>/backups`（不存在就建）。 */
export function autoBackupDir(root = rootDir()) {
  return join(root, 'backups')
}

function stamp6(now) {
  const p = (n) => String(n).padStart(2, '0')
  return (
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  )
}

/** 自动备份的文件名：`大肥鱼-自动-20261114-065300.json`。 */
export function autoBackupName(now = new Date()) {
  return `${AUTO_PREFIX}${stamp6(now)}.json`
}

/** 认不认得这个文件名是「我们自己攒的那批」。目录里别的东西一概不理。 */
export function isAutoBackupName(name) {
  return typeof name === 'string' && /^大肥鱼-自动-\d{8}-\d{6}\.json$/.test(name)
}

/**
 * 现在该不该备份。纯函数，只读配置和时钟，不碰盘——所以能被单测直接钉住。
 * @returns {{ due: boolean, why: string }}
 */
export function autoBackupDue(config, now = new Date()) {
  const b = config?.backup ?? {}
  if (b.enabled === false) return { due: false, why: '关着' }
  const every = Math.max(1, Math.round(Number(b.everyDays) || 1))
  const last = Date.parse(String(b.lastAt ?? ''))
  if (!Number.isFinite(last)) return { due: true, why: '还没备份过' }
  const ms = every * DAY_MS
  // 时钟被往回调过（lastAt 比现在还晚）：别一直干等，当成该备份了。
  if (now.getTime() < last) return { due: true, why: '上次的时间比现在晚（时钟动过）' }
  const left = last + ms - now.getTime()
  if (left > 0) {
    const hours = Math.ceil(left / 3_600_000)
    return { due: false, why: `${hours} 小时后` }
  }
  return { due: true, why: `距上次超过 ${every} 天` }
}

/**
 * 列出攒着的自动备份，新的在前。
 * 只读目录项，不读文件内容——设置页要的只是名字、大小、时间。
 * @returns {Promise<Array<{ name: string, bytes: number, at: number }>>}
 */
export async function listAutoBackups(root = rootDir()) {
  const dir = autoBackupDir(root)
  let names
  try {
    names = await fs.readdir(dir)
  } catch {
    return []
  }
  const out = []
  for (const name of names) {
    if (!isAutoBackupName(name)) continue
    try {
      const st = await fs.stat(join(dir, name))
      if (!st.isFile()) continue
      out.push({ name, bytes: st.size, at: st.mtimeMs })
    } catch { /* 读不到就当没有，别让一份坏文件挡住列表 */ }
  }
  // 名字里就是时间戳，倒序排＝从新到旧，不依赖 mtime（复制过去会变）。
  out.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0))
  return out
}

/**
 * 按 keep 删掉多出来的旧份。
 * 只删 `listAutoBackups` 认得的那批；别的一概不碰。
 * @returns {Promise<{ removed: string[] }>}
 */
export async function pruneAutoBackups(root = rootDir(), keep = 7) {
  const n = Math.max(1, Math.round(Number(keep) || 1))
  const all = await listAutoBackups(root)
  const removed = []
  for (const one of all.slice(n)) {
    try {
      await fs.unlink(join(autoBackupDir(root), one.name))
      removed.push(one.name)
    } catch { /* 删不掉不算失败：下一轮还会再试 */ }
  }
  return { removed }
}

/**
 * 现在存一份。
 *
 * 不自己判断「该不该」——那是调用方的事（autoBackupDue / 用户点按钮）。
 * 写完才把 lastAt 记进配置：半路失败不算这一份，下一轮 tick 会重试。
 *
 * @param {string} [root]
 * @param {{ now?: Date, config?: object, log?: Function }} [opts]
 *   config 给了就用它（省一次读盘）；没给就现读。
 * @returns {Promise<{ ok: boolean, name?: string, bytes?: number, files?: number, removed?: string[], why?: string }>}
 */
export async function runAutoBackup(root = rootDir(), { now = new Date(), config = null, log = null } = {}) {
  const cfg = config ?? (await loadConfig(root)).config
  const keep = Math.max(1, Math.round(Number(cfg?.backup?.keep) || 7))
  const dir = autoBackupDir(root)
  try {
    await fs.mkdir(dir, { recursive: true })
  } catch (e) {
    return { ok: false, why: `建不了 ${dir}：${e?.message || e}` }
  }

  let bundle
  try {
    bundle = await collectBackup(root, { now })
  } catch (e) {
    return { ok: false, why: `打包失败：${e?.message || e}` }
  }

  const name = autoBackupName(now)
  const body = JSON.stringify({ ...bundle, fileName: name })
  // 走 store 的原子写：先写 tmp 再 rename，断电不会留半份读不回来的 json。
  try {
    await writeAtomic(join(dir, name), body)
  } catch (e) {
    return { ok: false, why: `写不进 ${name}：${e?.message || e}` }
  }

  // 成功后立刻清理：先写新的再删旧的，删到一半出错也还剩新的这份。
  const { removed } = await pruneAutoBackups(root, keep)

  try {
    await updateConfig({ backup: { lastAt: now.toISOString() } }, root)
  } catch (e) {
    // 记不上时间只影响下一次的判断（会早一点再备一份），不该让这一次算失败。
    log?.('autobackup', `记不上 lastAt：${e?.message || e}`)
  }

  const bytes = bundleBytes({ ...bundle, fileName: name })
  log?.('autobackup', `存了一份 ${name}（${sizeText(bytes)}，留 ${keep} 份${removed.length ? `，清掉 ${removed.length} 份旧的` : ''}）`)
  return { ok: true, name, bytes, files: bundle.files?.length ?? 0, removed }
}

/**
 * 把一份自动备份读回来（恢复要用）。名字先过白名单：只认自己那批，
 * 不认 `../`、绝对路径这类东西——这条路由是能 GET 的，不能让它变成任意文件读取。
 * @returns {Promise<{ ok: boolean, text?: string, bundle?: object, name?: string, why?: string }>}
 */
export async function readAutoBackup(name, root = rootDir()) {
  if (!isAutoBackupName(name)) return { ok: false, why: '不是一个自动备份的文件名' }
  let text
  try {
    text = await fs.readFile(join(autoBackupDir(root), name), 'utf8')
  } catch {
    return { ok: false, why: '这份不在了（可能被清理掉了）' }
  }
  let bundle
  try {
    bundle = JSON.parse(text)
  } catch {
    return { ok: false, why: '这份文件读不成 json' }
  }
  if (bundle?.format !== BACKUP_FORMAT) return { ok: false, why: '这不是大肥鱼的备份' }
  return { ok: true, text, bundle, name }
}

/**
 * 设置页那张卡要的一句人话：现在攒了几份、一共多大、下一份什么时候。
 * 只算不算盘——数据页每 30 秒轮询一次，不该每次都去读一遍目录。
 */
export async function autoBackupStatus(root = rootDir(), { now = new Date(), config = null } = {}) {
  const cfg = config ?? (await loadConfig(root)).config
  const list = await listAutoBackups(root)
  const due = autoBackupDue(cfg, now)
  const total = list.reduce((s, x) => s + x.bytes, 0)
  return {
    enabled: cfg?.backup?.enabled !== false,
    everyDays: Math.max(1, Math.round(Number(cfg?.backup?.everyDays) || 1)),
    keep: Math.max(1, Math.round(Number(cfg?.backup?.keep) || 7)),
    lastAt: String(cfg?.backup?.lastAt ?? ''),
    due: due.due,
    dueWhy: due.why,
    dir: autoBackupDir(root),
    count: list.length,
    bytes: total,
    items: list,
  }
}

/** 给回执用的：`3 份，一共 1.2MB`。 */
export function autoBackupSizeText(status) {
  const n = Number(status?.count) || 0
  if (!n) return '还没有'
  return `${n} 份，一共 ${sizeText(Number(status?.bytes) || 0)}`
}
