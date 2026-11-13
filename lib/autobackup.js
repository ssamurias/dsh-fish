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
 *   4. 不带 `out/covers/`（封面缓存，见 AUTO_SKIP）。自动备份一天可能写好几遍，
 *      那三十来兆纯属可重建的东西，不值得反复搬；手动备份那一份仍然是全量。
 *
 * 什么时候存（2026-11-14 用户 m00597 补充）：
 *   用户点破了一个我们没法回避的事实——**没人知道自己哪一次启动是最后一次**。
 *   所以「每 N 天一份」这种纯时钟的规则靠不住：用户可能今天开三次、每次半小时，
 *   最后一次之后再也不开；也可能整月不关。纯按天算，中间那段新长出来的东西就没人管。
 *
 *   于是分成**两条腿**，各管一件事：
 *
 *   ① 兜底档 `大肥鱼-自动-最新.json`——永远只有一份，滚动覆盖。
 *      启动后第一次 tick、运行中每隔 CATCHUP_GAP_MS 且「库里有新的东西」、退出时
 *      （尽力而为），都把它刷成当下这份。它不占 keep 的名额，所以刷新多少次都不会
 *      把攒了好几天的历史挤掉。这条腿保证：**只要 DSH 跑过，最新的样子就有一份躺在盘上**，
 *      哪怕那一次只开了两分钟、哪怕之后再也不开。
 *   ② 历史档 `大肥鱼-自动-YYYYMMDD-HHMMSS.json`——按 everyDays 攒，留 keep 份。
 *      给的是「上周/上个月她是什么样」，回退得更远。
 *
 * 「库里有新的东西」不解析任何 json，只比时间戳：events.jsonl 比兜底档还新 = 有。
 * 事件流是只追加的主干，她每一轮说话、写日记、翻站都会往里落一条，比它便宜又比它准的信号没有。
 * 注意**不能把 config.json 算进来**：存完备份之后要回写 config.backup.lastAt，
 * 一算进去就永远「脏」，会一刻不停地白存。
 *
 * 为什么兜底档不做成「多留几份」：用户来回重启时，多份几乎一样的快照只会把历史档挤掉。
 * 一份滚动的 + 一份按天攒的，比十份差半小时的更有用。
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { collectBackup, bundleBytes, sizeText, BACKUP_FORMAT } from './backup.js'
import { rootDir, writeAtomic } from './store.js'
import { loadConfig, updateConfig } from './settings.js'

/** 自动备份文件名前缀。清理与列表都按它认人，别改。 */
export const AUTO_PREFIX = '大肥鱼-自动-'

const DAY_MS = 86_400_000

/**
 * 「捡漏」两次之间至少隔这么久（2026-11-14 用户补充）。
 *
 * 开机和退出都会看一眼「有没有新东西、上次那份够不够旧」，够旧才补一份。
 * 半小时是刻意拧得比较长的：用户可能一个下午重启五六次，每次都在启动时存一份的话，
 * 那半天就把配额（默认 7 份）挤光了，真正值钱的「上周那份」反而被清掉。
 * 半小时内重启＝这一段时间的数据还没变到值得多留一份。
 */
export const CATCHUP_GAP_MS = 30 * 60_000

/** 攒自动备份的目录：`<数据文件夹>/backups`（不存在就建）。 */
export function autoBackupDir(root = rootDir()) {
  return join(root, 'backups')
}

/**
 * 自动备份不带的东西（相对数据文件夹）。
 *
 * `out/covers/` 是 B 站封面缓存（lib/cover.js 落的 `<BV>.jpg`）：实测在这台机器上
 * 82 张占了 30MB，是全包 48MB 的六成。它纯粹可重建——丢了下次打开那条视频会重新下，
 * 而她自己的东西（事件流、日记、房间）一点没少。
 *
 * 只作用于自动备份。手动「备份成一份文件」仍然全量：那是用户主动要带走的一整份，
 * 宁可大也不能缺。代价是自动备份恢复回来以后，封面要重新下一遍。
 */
export const AUTO_SKIP = ['out/covers']

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

/**
 * 兜底档的文件名。**永远只有这一份，每次覆盖**——没有时间戳，所以不用清理、也不会
 * 因为用户多开几次就攒出一堆。它不参与 keep 的计数（见 pruneAutoBackups）。
 */
export const LATEST_NAME = `${AUTO_PREFIX}最新.json`

/** 认不认得这个文件名是「我们自己攒的那批历史档」。目录里别的东西一概不理。 */
export function isAutoBackupName(name) {
  return typeof name === 'string' && /^大肥鱼-自动-\d{8}-\d{6}\.json$/.test(name)
}

/** 能读回来 / 能恢复的那批：历史档 + 兜底档。 */
export function isAutoBackupFile(name) {
  return name === LATEST_NAME || isAutoBackupName(name)
}

/** 兜底那份现在是什么样（没有就是 null）。设置页和判断都用它。 */
export async function latestBackupInfo(root = rootDir()) {
  const file = join(autoBackupDir(root), LATEST_NAME)
  try {
    const st = await fs.stat(file)
    if (!st.isFile()) return null
    return { name: LATEST_NAME, bytes: st.size, at: st.mtimeMs }
  } catch {
    return null
  }
}

/**
 * 数据最后一次变动的时刻：events.jsonl 的 mtime。
 * 读不到就是 0（＝「什么都比它新」，会立刻存一份，这是对的：库都读不到的时候更需要一份）。
 */
export async function newestDataAt(root = rootDir()) {
  try {
    const st = await fs.stat(join(root, 'events.jsonl'))
    return st.mtimeMs || 0
  } catch {
    return 0
  }
}

/**
 * 兜底那份现在要不要刷。纯函数，只吃时间戳，不碰盘——单测直接钉。
 *
 * 为什么「有新东西」只看 events.jsonl：它是只追加的主干，她说话、写日记、翻站都会落一条。
 * 拿它跟兜底那份比 mtime，比解析任何 json 都便宜，也比拿整个目录比准（config.json 每次
 * 存完备份都要回写 lastAt，算进去就永远「脏」）。
 *
 * @param {object} config
 * @param {Date} now
 * @param {{ latestAt?: number, dataAt?: number, force?: boolean }} opts
 *   latestAt 兜底那份的 mtime；dataAt 事件流的 mtime；force 启动/退出时忽略节流
 * @returns {{ due: boolean, why: string }}
 */
export function catchupDue(config, now = new Date(), { latestAt = 0, dataAt = 0, force = false } = {}) {
  if (config?.backup?.enabled === false) return { due: false, why: '关着' }
  if (!latestAt) return { due: true, why: '还没有兜底那一份' }
  if (dataAt <= latestAt) return { due: false, why: '没有新东西' }
  if (!force) {
    const gap = now.getTime() - latestAt
    if (gap < CATCHUP_GAP_MS) {
      return { due: false, why: `${Math.ceil((CATCHUP_GAP_MS - gap) / 60_000)} 分钟后再看` }
    }
  }
  return { due: true, why: '有新东西' }
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
 * 打个包，写成指定的文件名。两条腿共用这一截：只有名字和对 side-effect 的处理不同。
 * @returns {Promise<{ ok: boolean, bytes?: number, files?: number, why?: string }>}
 */
async function packAndWrite(root, name, now) {
  let bundle
  try {
    bundle = await collectBackup(root, { now, alsoSkip: AUTO_SKIP })
  } catch (e) {
    return { ok: false, why: `打包失败：${e?.message || e}` }
  }
  // 走 store 的原子写：先写 tmp 再 rename，断电不会留半份读不回来的 json。
  // 兜底那份更依赖这条：它每次都是覆盖同一个文件名，写一半断电就会把上一份也毁掉。
  try {
    await writeAtomic(join(autoBackupDir(root), name), JSON.stringify({ ...bundle, fileName: name }))
  } catch (e) {
    return { ok: false, why: `写不进 ${name}：${e?.message || e}` }
  }
  return { ok: true, bytes: bundleBytes({ ...bundle, fileName: name }), files: bundle.files?.length ?? 0 }
}

async function ensureDir(root) {
  const dir = autoBackupDir(root)
  try {
    await fs.mkdir(dir, { recursive: true })
    return { ok: true }
  } catch (e) {
    return { ok: false, why: `建不了 ${dir}：${e?.message || e}` }
  }
}

/**
 * 存一份**历史档**（带时间戳，按 keep 攒）。
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
  const made = await ensureDir(root)
  if (!made.ok) return made

  const name = autoBackupName(now)
  const w = await packAndWrite(root, name, now)
  if (!w.ok) return w

  // 成功后立刻清理：先写新的再删旧的，删到一半出错也还剩新的这份。
  const { removed } = await pruneAutoBackups(root, keep)

  try {
    await updateConfig({ backup: { lastAt: now.toISOString() } }, root)
  } catch (e) {
    // 记不上时间只影响下一次的判断（会早一点再备一份），不该让这一次算失败。
    log?.('autobackup', `记不上 lastAt：${e?.message || e}`)
  }

  log?.('autobackup', `存了一份 ${name}（${sizeText(w.bytes)}，留 ${keep} 份${removed.length ? `，清掉 ${removed.length} 份旧的` : ''}）`)
  return { ok: true, name, bytes: w.bytes, files: w.files, removed }
}

/**
 * 刷**兜底档**（`大肥鱼-自动-最新.json`，永远一份）。
 *
 * 刻意不写 lastAt、也不清理：它跟「每 N 天一份」是两条独立的腿——
 * 刷它一次不该把历史档的计时重置（否则天天开机就永远攒不出一份历史档），
 * 它自己也不占 keep 的名额（否则重启几次就把攒了半个月的那几份挤掉）。
 *
 * @returns {Promise<{ ok: boolean, name?: string, bytes?: number, files?: number, why?: string }>}
 */
export async function runLatestBackup(root = rootDir(), { now = new Date(), config = null, log = null } = {}) {
  const cfg = config ?? (await loadConfig(root)).config
  if (cfg?.backup?.enabled === false) return { ok: false, why: '关着' }
  const made = await ensureDir(root)
  if (!made.ok) return made
  const w = await packAndWrite(root, LATEST_NAME, now)
  if (!w.ok) return w
  log?.('autobackup', `兜底那份刷成新的（${sizeText(w.bytes)}，${w.files} 个文件）`)
  return { ok: true, name: LATEST_NAME, bytes: w.bytes, files: w.files }
}

/**
 * scheduler 每拍调用它：该刷就刷，不该刷什么也不做。
 * force=true 用在启动第一拍和退出前——那两下要的是「这次一定有一份」，
 * 不该被「半小时节流」劝退（启动那份尤其重要：用户可能开了两分钟就关掉）。
 *
 * @returns {Promise<{ ok: boolean, skipped?: string, name?: string, bytes?: number, files?: number, why?: string }>}
 */
export async function catchupBackup(root = rootDir(), { now = new Date(), config = null, log = null, force = false } = {}) {
  const cfg = config ?? (await loadConfig(root)).config
  const latest = await latestBackupInfo(root)
  const dataAt = await newestDataAt(root)
  const due = catchupDue(cfg, now, { latestAt: latest?.at ?? 0, dataAt, force })
  if (!due.due) return { ok: false, skipped: due.why }
  const r = await runLatestBackup(root, { now, config: cfg, log })
  return { ...r, why: r.ok ? due.why : r.why }
}

/**
 * 把一份自动备份读回来（恢复要用）。名字先过白名单：只认自己那批，
 * 不认 `../`、绝对路径这类东西——这条路由是能 GET 的，不能让它变成任意文件读取。
 * @returns {Promise<{ ok: boolean, text?: string, bundle?: object, name?: string, why?: string }>}
 */
export async function readAutoBackup(name, root = rootDir()) {
  if (!isAutoBackupFile(name)) return { ok: false, why: '不是一个自动备份的文件名' }
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
  const latest = await latestBackupInfo(root)
  const due = autoBackupDue(cfg, now)
  // 兜底那份算进「一共多大」，但不进 count（count 说的是「攒了几份历史档」）。
  const total = list.reduce((s, x) => s + x.bytes, 0) + (latest?.bytes ?? 0)
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
    latest: latest ? { name: latest.name, bytes: latest.bytes, at: latest.at } : null,
    items: list,
  }
}

/** 给回执用的：`3 份，一共 1.2MB`。有兜底那份就一起说，别让人以为「还没有」= 手上没东西。 */
export function autoBackupSizeText(status) {
  const n = Number(status?.count) || 0
  const total = sizeText(Number(status?.bytes) || 0)
  if (!n) return status?.latest ? `只有兜底那一份，${total}` : '还没有'
  return `${n} 份，一共 ${total}`
}
