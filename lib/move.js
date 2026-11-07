/**
 * move.js —— 把整个状态库搬到另一个盘（2026-10-28，用户 m06510）
 *
 * 用户的诉求原话：「有些人不想让插件的工作区在C盘，他们可能想要挪到D盘，E盘什么的」，
 * 并且要在数据页有个按钮、能选文件夹，「确定后就会迁移过去」。
 *
 * 三条铁律（都来自这个项目一贯的规矩）：
 *   1. **不删**。搬完之后旧目录改名到同级的 `dsh-fish-backups/moved-<时间>/`，
 *      和 reset 一样只封存。用户发现搬错了还能自己翻回去。
 *   2. **复制要验**。逐文件比对相对路径集合与字节数，任何一处对不上就中止，
 *      并且**不写指针**——指针没写就等于没迁过，下次启动还在老地方，数据完好。
 *   3. **指针在数据目录之外**（`~/.dsh-fish-location.json`）。
 *      写进数据目录里，搬家时会被一起搬走，下次启动就找不回来了。
 *
 * 宿主侧的两件事（清旧工作区、归档旧会话）是 best-effort：宿主没这些接口时
 * 只记一行日志，不影响搬文件本身——文件搬对了，重启后 bootstrapHome 会按新路径
 * 建一个新的工作区。
 */

import { promises as fs, constants as fsConstants } from 'node:fs'
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path'
import { paths, rootDir, writeAtomic } from './store.js'
import { locationFile, invalidateLocation, defaultRoot } from './locate.js'

/** 这些子目录不搬：日志只对这台机器有用；备份里不该再套备份（与 backup.js 同一套规矩）。 */
const SKIP_DIRS = new Set(['logs', 'backups', 'dsh-fish-backups', 'node_modules'])

/** 统一成小写、去掉尾分隔符的绝对路径，用于包含关系判断。 */
function norm(p) {
  let s = resolve(String(p ?? ''))
  while (s.length > 1 && (s.endsWith(sep) || s.endsWith('/'))) s = s.slice(0, -1)
  return s.toLowerCase()
}

/** a 是不是 b 的子路径（含相等）。 */
function inside(a, b) {
  const x = norm(a)
  const y = norm(b)
  if (x === y) return true
  return x.startsWith(y.endsWith(sep) ? y : y + sep)
}

/**
 * 检查目标能不能当新的数据目录。**不建目录、不动文件**，纯判断。
 * 返回 `{ok, why, target}`；target 是规范化后的绝对路径（可选时子目录已拼好）。
 */
export async function planMove(root = rootDir(), target = '') {
  const from = resolve(String(root ?? ''))
  const raw = String(target ?? '').trim()
  const out = { ok: false, why: '', from, target: '' }

  if (!raw) { out.why = '没有选目标文件夹'; return out }
  if (!isAbsolute(raw)) { out.why = '目标必须是绝对路径（形如 D:\\大肥鱼）'; return out }

  // 用户点选的是「一个文件夹」，我们在里面建 `dsh-fish` 子目录——
  // 不让整个数据目录直接铺在他选的文件夹里，免得和他自己的东西混在一起。
  let dir = resolve(raw)
  let st = null
  try { st = await fs.stat(dir) } catch { out.why = '这个文件夹不存在'; return out }
  if (!st.isDirectory()) { out.why = '这个路径不是文件夹'; return out }

  // 选中的文件夹本身已经是一份档（里面有 events.jsonl）：不搬（issue #65）。
  // 原来这里把它当新根、直接往里复制：copyFile 会盖掉那边的 events.jsonl / config.json /
  // owner.json，那边的 state.json、日记却留着，两份档混成一份，那边原来的事件流也没有任何备份。
  let hasArchive = false
  try {
    const s = await fs.stat(join(dir, 'events.jsonl'))
    hasArchive = s.isFile()
  } catch { hasArchive = false }

  let asRoot = join(dir, 'dsh-fish')
  try {
    const s = await fs.stat(asRoot)
    if (!s.isDirectory()) { out.why = '目标里有个同名的 dsh-fish，但不是文件夹'; return out }
    // 已有 dsh-fish 目录：空就用，非空就拒绝（绝不覆盖别人的东西）
    const kids = await fs.readdir(asRoot)
    if (kids.length) { out.why = '这个文件夹里已经有一个 dsh-fish 且不是空的，换一个吧'; return out }
  } catch { /* 还没有 dsh-fish：搬的时候再建 */ }

  if (inside(asRoot, from)) { out.why = '不能搬到她现在住的地方里面'; return out }
  if (inside(from, asRoot)) { out.why = '不能搬到她现在住的地方的上级——那样会连她自己一起套进去'; return out }
  if (hasArchive) {
    out.why = '这个文件夹里已经放着一份档（有 events.jsonl），搬过去会把那份盖掉。换一个没有档的文件夹吧'
    return out
  }
  if (norm(asRoot) === norm(defaultRoot()) && norm(from) === norm(defaultRoot())) {
    out.why = '她本来就在这个位置'; return out
  }

  // 源必须是真目录
  try {
    const s = await fs.stat(from)
    if (!s.isDirectory()) { out.why = '现在的数据目录不是一个文件夹'; return out }
  } catch { out.why = '找不到现在的数据目录'; return out }

  out.ok = true
  out.target = asRoot
  return out
}

/** 递归收集要搬的文件（相对路径 + 字节数），跳过 SKIP_DIRS。 */
async function collect(base) {
  const out = []
  async function walk(dir, rel) {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      const abs = join(dir, e.name)
      const r = rel ? join(rel, e.name) : e.name
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        await walk(abs, r)
        continue
      }
      if (!e.isFile()) continue
      const s = await fs.stat(abs)
      out.push({ rel: r, size: s.size })
    }
  }
  await walk(base, '')
  return out
}

/**
 * 搬。顺序：校验 → 复制 → 验字节 → 写指针 → 清宿主旧工作区 → 旧目录改名封存。
 * 任何一步在「写指针」之前失败，都等于没迁过（原来的数据一个字节没动）。
 */
export async function moveRoot(ctx, { root = rootDir(), target = '', log } = {}) {
  const plan = await planMove(root, target)
  if (!plan.ok) return { ok: false, why: plan.why, from: plan.from, to: '' }

  const from = plan.from
  const to = plan.target
  if (norm(from) === norm(to)) return { ok: false, why: '她本来就在这个位置', from, to: '' }

  let files = []
  try {
    files = await collect(from)
  } catch (err) {
    return { ok: false, why: `读不到现在的数据目录：${String(err?.message ?? err).slice(0, 120)}`, from, to: '' }
  }
  if (!files.length) return { ok: false, why: '现在的数据目录里没有东西可搬', from, to: '' }

  // ---- 1. 复制 ----
  try {
    await fs.mkdir(to, { recursive: true })
    for (const f of files) {
      const src = join(from, f.rel)
      const dst = join(to, f.rel)
      await fs.mkdir(dirname(dst), { recursive: true })
      // COPYFILE_EXCL：目标里已经有同名文件就失败，不覆盖。planMove 已经只给空的 dsh-fish，
      // 这里再守一道，免得哪天判断漏了又把别人的档盖掉（issue #65）。
      await fs.copyFile(src, dst, fsConstants.COPYFILE_EXCL)
    }
  } catch (err) {
    // 复制中途失败：把半成品目录改名挪开，绝不留一个「半个她」在目标位置。
    const half = `${to}.partial-${Date.now()}`
    await fs.rename(to, half).catch(() => {})
    return {
      ok: false,
      why: `复制到一半失败：${String(err?.message ?? err).slice(0, 160)}。目标里留下的是半成品，已改名为 ${half}，现在的数据一个字节没动。`,
      from,
      to: '',
    }
  }

  // ---- 2. 验字节 ----
  const bad = []
  for (const f of files) {
    try {
      const s = await fs.stat(join(to, f.rel))
      if (!s.isFile() || s.size !== f.size) bad.push(f.rel)
    } catch { bad.push(f.rel) }
  }
  if (bad.length) {
    return {
      ok: false,
      why: `${bad.length} 个文件复制后对不上（例如 ${bad[0]}）。指针没有改，她现在还在老地方。`,
      from,
      to: '',
    }
  }

  // ---- 3. 写指针（这一刻起才算迁了）----
  try {
    await fs.mkdir(dirname(locationFile()), { recursive: true })
    await writeAtomic(locationFile(), JSON.stringify({ root: to, movedAt: new Date().toISOString(), from }, null, 2))
  } catch (err) {
    return { ok: false, why: `文件都复制好了，但记不下新位置：${String(err?.message ?? err).slice(0, 120)}。把 ${to} 删了重试。`, from, to: '' }
  }
  invalidateLocation()

  // ---- 4. 宿主侧：旧工作区注册与旧会话（best-effort）----
  let stranded = ''
  try {
    // 旧的工作区注册指向老路径，留着会在侧栏里变成一个空壳。
    const reg = ctx?.get?.('workspaceRegistry') ?? ctx?.workspaceRegistry
    if (typeof reg?.list === 'function') {
      const list = reg.list()
      const oldHome = join(from, 'home')
      const hit = list.find((w) => w?.path && norm(w.path) === norm(oldHome))
      const ctrl = ctx?.get?.('workspaceController') ?? ctx?.workspaceController
      if (hit && typeof ctrl?.delete === 'function') {
        const id = String(hit.id ?? hit.workspaceId ?? '')
        if (id) await ctrl.delete({ workspaceId: id })
      }
    }
  } catch (err) {
    log?.(`旧工作区没收掉：${String(err?.message ?? err).slice(0, 120)}`)
  }
  try {
    const { retireHomeSessions } = await import('./retire.js')
    const r = await retireHomeSessions(ctx, { root: from, log })
    if (!r.ok) stranded = r.why
  } catch (err) {
    stranded = String(err?.message ?? err).slice(0, 120)
  }

  // ---- 5. 旧目录改名封存（不删）----
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const old = join(dirname(from), 'dsh-fish-backups', `moved-${stamp}`)
  let movedTo = ''
  try {
    await fs.mkdir(dirname(old), { recursive: true })
    await fs.rename(from, old)
    movedTo = old
  } catch (err) {
    // 改名失败不算迁移失败：新位置已生效，老目录留着只是多占一份空间。
    log?.(`旧目录没能改名封存（位置 ${from}）：${String(err?.message ?? err).slice(0, 120)}`)
  }

  return {
    ok: true,
    why: '',
    from,
    to,
    files: files.length,
    bytes: files.reduce((n, f) => n + f.size, 0),
    oldDir: movedTo || from,
    oldDirMoved: Boolean(movedTo),
    stranded,
    note: '重启 DSH 之后她才会在新位置醒过来。老目录没删，改名收在旁边的 dsh-fish-backups 里。',
  }
}

/** 现在住在哪、能不能立刻搬（给 GET /move 用）。 */
export async function moveStatus(root = rootDir()) {
  const p = paths(root)
  let files = 0
  let bytes = 0
  try {
    const list = await collect(p.root)
    files = list.length
    bytes = list.reduce((n, f) => n + f.size, 0)
  } catch { /* 目录还不存在就等于 0 */ }
  return {
    root: p.root,
    locationFile: locationFile(),
    defaultRoot: defaultRoot(),
    moved: norm(p.root) !== norm(defaultRoot()),
    files,
    bytes,
    relative: relative(homedirOrEmpty(), p.root) || '',
  }
}

function homedirOrEmpty() {
  try {
    // 只用于展示，取不到就空串（不能用顶层 import 拖死整个模块）
    return process.env.USERPROFILE || process.env.HOME || ''
  } catch { return '' }
}
