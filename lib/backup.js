/**
 * backup.js —— 把她整个装进一个文件，再整个放回去
 *
 * 用户要的不是「导出数据」这种半成品，而是**换台机器还能接着养**：
 * 事件流、配置、日记、她的房间、头像，全都要走。
 *
 * 三条设计约束：
 *   ① 单文件。一个 `.json`，双击能看、能发微信、能塞进网盘。不做 zip——
 *      不引依赖，也省掉「你解压到哪了」这类问题。
 *   ② 恢复不是「覆盖」而是「先封存再放回」。现在的档一律改名搬到
 *      `dsh-fish-backups/pre-restore-<时间戳>/`（一个字节都不删），
 *      再把备份写进原位置。这样恢复错了还能再换回来。
 *   ③ 版本对不上要说人话。备份里带 `format` 与 `schema`：
 *      format 不是本版本认识的 → 直接拒；schema 比程序新 → 拒（旧程序读新事件会静默丢字段）；
 *      schema 比程序旧 → 放行，读的时候按旧版兼容（见 `store.readEvents`）。
 *
 * 不搬的东西：`logs/`（现场日志，和他这台机器绑定，装回去只会误导排障）、
 * `backups/`（备份里再套备份，体积会炸）。这两类在结果里列出来，不静默丢。
 */

import { promises as fs } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { rootDir } from './store.js'
import { EVENT_SCHEMA_VERSION } from './schema.js'

/** 备份文件里写的格式标记。改字段结构就换它。 */
export const BACKUP_FORMAT = 'dsh-fish-backup/1'

/** 不搬的目录（相对状态库根）。 */
const SKIP_DIRS = new Set(['logs', 'backups', 'dsh-fish-backups', 'node_modules'])

/** 单个文件上限：8MB（头像 2MB 够用，日记再长也不该破这个数）。 */
const MAX_FILE_BYTES = 8 * 1024 * 1024
/** issue #65：事件流是只追加的单个大文件，绝不能因为超过上限被整个跳过。 */
const ALWAYS_INCLUDE = new Set(['events.jsonl'])
/** 备份总量上限：64MB。超了就别往一个 json 里塞了。 */
const MAX_TOTAL_BYTES = 64 * 1024 * 1024

const TEXT_EXT = ['.json', '.jsonl', '.md', '.txt', '.srt', '.yml', '.yaml', '.csv']

function isText(name) {
  const lower = name.toLowerCase()
  return TEXT_EXT.some((e) => lower.endsWith(e))
}

/** 时间戳目录名用的 `YYYYMMDD-HHMMSS`（与 reset.js 同风格，便于人看）。 */
function stamp(now) {
  const p = (n) => String(n).padStart(2, '0')
  return (
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  )
}

/**
 * 把状态库装进内存对象。
 * @returns {Promise<object>} `{ format, schema, createdAt, files, skipped, bytes }`
 */
export async function collectBackup(root = rootDir(), { now = new Date() } = {}) {
  const files = []
  const skipped = []
  let total = 0

  const walk = async (dir) => {
    let names
    try {
      names = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of names) {
      const full = join(dir, e.name)
      const rel = relative(root, full).split(sep).join('/')
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) {
          skipped.push(`${rel}/（不搬：${e.name}）`)
          continue
        }
        await walk(full)
        continue
      }
      if (!e.isFile()) {
        skipped.push(`${rel}（不是普通文件）`)
        continue
      }
      let st
      try {
        st = await fs.stat(full)
      } catch {
        skipped.push(`${rel}（读不到）`)
        continue
      }
      const must = ALWAYS_INCLUDE.has(rel)
      if (!must && st.size > MAX_FILE_BYTES) {
        skipped.push(`${rel}（${Math.round(st.size / 1024 / 1024)}MB，超过单文件上限）`)
        continue
      }
      if (!must && total + st.size > MAX_TOTAL_BYTES) {
        skipped.push(`${rel}（总量已到 64MB 上限）`)
        continue
      }
      let data
      try {
        if (isText(e.name)) {
          const buf = await fs.readFile(full)
          data = { enc: 'utf8', data: buf.toString('utf8') }
        } else {
          const buf = await fs.readFile(full)
          data = { enc: 'base64', data: buf.toString('base64') }
        }
      } catch {
        skipped.push(`${rel}（读失败）`)
        continue
      }
      total += st.size
      files.push({ path: rel, size: st.size, ...data })
    }
  }

  await walk(root)

  return {
    format: BACKUP_FORMAT,
    schema: EVENT_SCHEMA_VERSION,
    createdAt: now.toISOString(),
    files,
    skipped,
    bytes: total,
  }
}

/** 备份的默认文件名：`大肥鱼-20261025-0030.json`。 */
export function backupFileName(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `大肥鱼-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.json`
}

/**
 * 恢复前的那道门：校验、并把「旧档搬走」这件事做完。
 * 只检查、不写盘，方便测试。
 */
export function checkBundle(bundle) {
  if (!bundle || typeof bundle !== 'object') return { ok: false, why: '这不是一个备份文件' }
  if (bundle.format !== BACKUP_FORMAT) {
    return {
      ok: false,
      why: `备份格式是「${String(bundle.format ?? '（空）')}」，这个版本只认「${BACKUP_FORMAT}」`,
    }
  }
  if (!Array.isArray(bundle.files) || bundle.files.length === 0) {
    return { ok: false, why: '备份里一个文件都没有' }
  }
  for (const f of bundle.files) {
    if (!f || typeof f.path !== 'string' || !f.path || typeof f.data !== 'string') {
      return { ok: false, why: '备份里有文件记录缺 path / data' }
    }
    if (f.enc !== 'utf8' && f.enc !== 'base64') {
      return { ok: false, why: `文件 ${f.path} 的编码不认识：${String(f.enc)}` }
    }
    // 目录穿越守门：备份可能被人改过，也见过有人在路径里塞反斜杠。
    // 注意不能先用 resolve() 判——它会把 `..` 规范化掉，等于把证据擦了。
    const segs = f.path.split('/')
    if (f.path.includes(String.fromCharCode(92)) || segs.some((x) => x === '..' || x === '.' || x === '')) {
      return { ok: false, why: `文件路径可疑：${f.path}` }
    }
  }
  // issue #65：没有事件流的备份装回去就是空档，不能默默恢复成功。
  if (!bundle.files.some((f) => f && f.path === 'events.jsonl')) {
    return { ok: false, why: '这份备份里没有事件流（events.jsonl），装回去她会失忆' }
  }
  const schema = Number(bundle.schema ?? 0)
  if (schema > EVENT_SCHEMA_VERSION) {
    return {
      ok: false,
      why: `这份备份来自更新的版本（事件格式 v${schema}，本程序认 v${EVENT_SCHEMA_VERSION}），装回去会丢字段`,
    }
  }
  return { ok: true, why: '', files: bundle.files.length, schemaFrom: schema, schemaTo: EVENT_SCHEMA_VERSION }
}

/** 恢复时旧档搬去哪。与 reset 同目录，但前缀是 `pre-restore-`。 */
export async function quarantineDirFor(root = rootDir(), now = new Date()) {
  const base = join(dirname(resolve(root)), 'dsh-fish-backups')
  let target = join(base, `pre-restore-${stamp(now)}`)
  for (let i = 2; i <= 99; i++) {
    try {
      await fs.stat(target)
      target = join(base, `pre-restore-${stamp(now)}-${i}`)
    } catch {
      return target
    }
  }
  return join(base, `pre-restore-${stamp(now)}-${Date.now()}`)
}

/**
 * 恢复。顺序：校验 → 旧档改名 → 建新库 → 写文件。
 * @returns {Promise<{ok:boolean, why?:string, restored?:number, quarantined?:string, schemaFrom?:number}>}
 */
export async function restoreBackup(bundle, root = rootDir(), { now = new Date() } = {}) {
  const chk = checkBundle(bundle)
  if (!chk.ok) return { ok: false, why: chk.why }

  const quarantined = await quarantineDirFor(root, now)
  let hadOld = false
  try {
    await fs.stat(root)
    hadOld = true
  } catch {}

  if (hadOld) {
    await fs.mkdir(dirname(quarantined), { recursive: true })
    try {
      await fs.rename(root, quarantined)
    } catch (err) {
      // 跨盘 / 被占用：不部分搬走，直接如实报错
      return {
        ok: false,
        why: `旧档搬不动（${String(err?.code ?? err)}），这次恢复什么都没改`,
      }
    }
  }

  try {
    await fs.mkdir(root, { recursive: true })
    for (const f of bundle.files) {
      const dest = join(root, ...f.path.split('/'))
      await fs.mkdir(dirname(dest), { recursive: true })
      await fs.writeFile(dest, f.enc === 'base64' ? Buffer.from(f.data, 'base64') : f.data, {
        encoding: f.enc === 'base64' ? undefined : 'utf8',
      })
    }
  } catch (err) {
    return {
      ok: false,
      why: `写到一半失败：${String(err?.message ?? err)}。旧档完好，在 ${quarantined}（如果它不是空的）`,
      quarantined,
    }
  }

  return {
    ok: true,
    restored: bundle.files.length,
    quarantined: hadOld ? quarantined : '',
    schemaFrom: Number(bundle.schema ?? 0),
  }
}
