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
 *      搬的时候插件还在跑、她还在写：事件流是只追加的，复制之后多出来的尾巴补抄过去；
 *      别的文件中途变了就照旧算对不上，目标里的半成品改名挪开，可以原样再点一次。
 *   2b. **写指针之前先封住老位置**（locate.js 的 sealRoot）。从这一刻到重启，这个进程
 *      手里的还是老 root：再让它写，写的东西到不了新位置。封住之后事件流的写入口直接拒。
 *   3. **指针在数据目录之外**（`~/.dsh-fish-location.json`）。
 *      写进数据目录里，搬家时会被一起搬走，下次启动就找不回来了。
 *
 * 宿主侧的两件事（清旧工作区、归档旧会话）是 best-effort：宿主没这些接口时
 * 只记一行日志，不影响搬文件本身——文件搬对了，重启后 bootstrapHome 会按新路径
 * 建一个新的工作区。
 */

import { constants as fsConstants, promises as fs } from 'node:fs'
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path'
import { paths, rootDir, writeAtomic } from './store.js'
import { locationFile, invalidateLocation, defaultRoot, sealRoot, unsealRoot } from './locate.js'

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

  // issue #65：选中的文件夹里已经有一份档（有 events.jsonl）就直接拒绝。
  // 原来的分支把它当新根，copyFile 会把那边的事件流整个盖掉，而且不留备份。
  let asRoot = dir
  let existingArchive = false
  try {
    const s = await fs.stat(join(dir, 'events.jsonl'))
    existingArchive = s.isFile()
  } catch { /* 没有档 */ }
  if (!existingArchive) {
    const sub = join(dir, 'dsh-fish')
    // 原地不动：选的是她现在那个 dsh-fish 的上级，拼回来正好是她自己。
    // 要在「已有非空 dsh-fish」之前判，不然她自己会被说成「已经有一个 dsh-fish 且不是空的」。
    if (norm(sub) === norm(from)) { out.why = '她本来就在这个位置'; return out }
    try {
      const s = await fs.stat(sub)
      if (!s.isDirectory()) { out.why = '目标里有个同名的 dsh-fish，但不是文件夹'; return out }
      // 已有 dsh-fish 目录：空就用，非空就拒绝（绝不覆盖别人的东西）
      const kids = await fs.readdir(sub)
      if (kids.length) { out.why = '这个文件夹里已经有一个 dsh-fish 且不是空的，换一个吧'; return out }
      asRoot = sub
    } catch {
      asRoot = sub
    }
  }

  // 选的就是她现在住的文件夹（里面有她自己的 events.jsonl）：也是原地不动。
  if (norm(asRoot) === norm(from)) { out.why = '她本来就在这个位置'; return out }
  if (inside(asRoot, from)) { out.why = '不能搬到她现在住的地方里面'; return out }
  if (inside(from, asRoot)) { out.why = '不能搬到她现在住的地方的上级——那样会连她自己一起套进去'; return out }
  // issue #65：目标里已经有一份档就拒绝——原来的分支把它当新根，
  // copyFile 会把那边的事件流整个盖掉，而且不留备份。现在在这里拦下，两边都不动。
  if (existingArchive) {
    out.why = '这个文件夹里已经有一份她的档了（有 events.jsonl）。换一个空文件夹——那边的同名文件会被覆盖。'
    return out
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

const EVENTS_REL = 'events.jsonl'
/** 封住之后等这么久再量一次：让已经过了闸、正在落盘的那一条写完。 */
const SETTLE_MS = 30
const SETTLE_ROUNDS = 20

/**
 * 把源里比目标多出来的那一段尾巴抄到目标后面（只给只追加的事件流用）。
 * 返回补了多少字节；源比目标短（不该发生：只追加）返回 -1，调用方按对不上处理。
 */
async function copyTail(src, dst) {
  const a = (await fs.stat(src)).size
  const b = (await fs.stat(dst)).size
  if (a === b) return 0
  if (a < b) return -1
  const rd = await fs.open(src, 'r')
  try {
    const wr = await fs.open(dst, 'a')
    try {
      const buf = Buffer.allocUnsafe(Math.min(1 << 20, a - b))
      let pos = b
      while (pos < a) {
        const { bytesRead } = await rd.read(buf, 0, Math.min(buf.length, a - pos), pos)
        if (!bytesRead) break
        await wr.write(buf, 0, bytesRead)
        pos += bytesRead
      }
    } finally { await wr.close() }
  } finally { await rd.close() }
  return a - b
}

/**
 * 事件流补到和源一样长，并且隔 SETTLE_MS 再量一次没有再变长才算完。
 * 调用前老位置已经封住（不会有新的写入开始），这里等的只是封之前就过了闸的那几条。
 * 返回 { ok, added, size }。
 */
async function settleEvents(src, dst) {
  let added = 0
  for (let i = 0; i < SETTLE_ROUNDS; i++) {
    const n = await copyTail(src, dst)
    if (n < 0) return { ok: false, added, size: 0 }
    added += n
    await new Promise((r) => setTimeout(r, SETTLE_MS))
    const a = (await fs.stat(src)).size
    const b = (await fs.stat(dst)).size
    if (a === b) return { ok: true, added, size: b }
  }
  return { ok: false, added, size: 0 }
}

/** 目标里的半成品改名挪开；返回新名字，挪不动返回空串。 */
async function setAside(to) {
  const half = `${to}.partial-${Date.now()}`
  try { await fs.rename(to, half); return half } catch { return '' }
}

/**
 * 搬。顺序：校验 → 复制 → 验字节 → 封住老位置、补事件流的尾巴 → 写指针 → 清宿主旧工作区 → 旧目录改名封存。
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
      // 目标必须是空的：万一并发或判断有漏，也不覆盖任何同名文件。
      await fs.copyFile(src, dst, fsConstants.COPYFILE_EXCL)
    }
  } catch (err) {
    // 复制中途失败：把半成品目录改名挪开，绝不留一个「半个她」在目标位置。
    const half = await setAside(to)
    return {
      ok: false,
      why: `复制到一半失败：${String(err?.message ?? err).slice(0, 160)}。${half ? `目标里留下的是半成品，已改名为 ${half}` : `目标里留下的是半成品（${to}，没能改名挪开，重试前请先删掉它）`}，现在的数据一个字节没动。`,
      from,
      to: '',
    }
  }

  // ---- 2. 验字节 ----
  // 对不上时目标里是一整份拷贝：不挪开的话，再点同一个文件夹会被 planMove 以
  // 「已经有一个 dsh-fish 且不是空的」拒掉，而回执里没说要先删。和复制失败一样改名挪开。
  const mismatch = async (bad) => {
    const half = await setAside(to)
    return {
      ok: false,
      why: `${bad.length} 个文件复制后对不上（例如 ${bad[0]}）——多半是搬的时候它正好被改了。指针没有改，她现在还在老地方。`
        + (half ? `目标里那份没搬完的已改名为 ${half}，可以原样再点一次。` : `目标里那份没搬完的（${to}）没能改名挪开，重试前请先删掉它。`),
      from,
      to: '',
      partial: half,
    }
  }
  const events = files.find((f) => f.rel === EVENTS_REL)
  const bad = []
  for (const f of files) {
    // 事件流是只追加的：搬的时候她还在写，复制到它的那一刻可能已经比数文件时长。
    // 长出来的不算坏，留到下面封住老位置之后按源补齐；比数到的短才是真坏。
    try {
      const s = await fs.stat(join(to, f.rel))
      if (!s.isFile() || (f === events ? s.size < f.size : s.size !== f.size)) bad.push(f.rel)
    } catch { bad.push(f.rel) }
  }
  if (bad.length) return mismatch(bad)

  // ---- 2b. 封住老位置，把事件流的尾巴补齐 ----
  // 先封再补：封住之后 appendEvent / guardWrite 不再往老位置写，补完的那一刻两边就是一样的。
  // 下面任何一步没成都要撤掉（unsealRoot），不然她在老地方也写不了。
  sealRoot(from, to)
  let caughtUp = 0
  if (events) {
    let settled = { ok: false, added: 0, size: 0 }
    try { settled = await settleEvents(join(from, EVENTS_REL), join(to, EVENTS_REL)) } catch { /* 按对不上处理 */ }
    if (!settled.ok) {
      unsealRoot(from)
      return mismatch([EVENTS_REL])
    }
    caughtUp = settled.added
    events.size = settled.size
  }

  // ---- 3. 写指针（这一刻起才算迁了）----
  try {
    await fs.mkdir(dirname(locationFile()), { recursive: true })
    await writeAtomic(locationFile(), JSON.stringify({ root: to, movedAt: new Date().toISOString(), from }, null, 2))
  } catch (err) {
    unsealRoot(from)
    const half = await setAside(to)
    return {
      ok: false,
      why: `文件都复制好了，但记不下新位置：${String(err?.message ?? err).slice(0, 120)}。她现在还在老地方。`
        + (half ? `目标里那份已改名为 ${half}，可以原样再点一次。` : `把 ${to} 删了重试。`),
      from,
      to: '',
      partial: half,
    }
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
    // 搬的途中事件流又长了多少字节（已经补抄到新位置）。0 = 途中没人写。
    caughtUp,
    // 从现在到重启，这个进程不再往事件流里写（老位置已封，见 locate.js 的 sealRoot）。
    readOnly: true,
    note: '重启 DSH 之后她才会在新位置醒过来；重启之前她记不下新的事（写入会被拒），搬完请尽快重启。老目录没删，改名收在旁边的 dsh-fish-backups 里。',
  }
}

/**
 * 这个数据目录是不是已经被 moveRoot 搬走了（指针写好了，这个进程还没重启）。
 *
 * 给心跳用（index.js）。搬完以后老目录改名封存，占用声明（instance.json）跟着走，心跳读到的是
 * 「声明不在了」。重开一局、从备份恢复之后也是「声明不在了」，那两种要重新占；搬走的不能占：
 * 占上以后她的写工具照样回成功，写下的东西留在老位置，重启后走指针去新位置就看不到了。
 *
 * 只看指针文件（moveRoot 第 3 步写的 `{ root, movedAt, from }`）：
 *   - `from` 是这个 root、`root` 指到了别处，就是搬走了；
 *   - `movedAt` 早于 `since`（这个实例的启动时间）的不算：root 被配置或环境变量钉在老位置时，
 *     搬过之后重启还是在这里起来，那样的实例本来就住在这里。
 *
 * @returns {Promise<{state:'here'|'moved'|'unknown', to?:string, code?:string}>}
 *   here：没搬走（没有指针、指针说的不是这个 root；读坏了的指针当没有，和 locate.js 一样）；
 *   moved：搬走了，`to` 是新位置；
 *   unknown：指针这一次没读成（`code` 是错误码），什么都说明不了，调用方下一次再问。
 */
export async function rootMovedAway(root, { since = 0 } = {}) {
  let raw
  try {
    raw = await fs.readFile(locationFile(), 'utf8')
  } catch (err) {
    if (err?.code === 'ENOENT') return { state: 'here' }
    return { state: 'unknown', code: String(err?.code ?? 'READ') }
  }
  let ptr = null
  try { ptr = JSON.parse(raw) } catch { return { state: 'here' } }
  const from = String(ptr?.from ?? '').trim()
  const to = String(ptr?.root ?? '').trim()
  if (!from || !to) return { state: 'here' }
  if (norm(from) !== norm(root) || norm(to) === norm(root)) return { state: 'here' }
  const at = Date.parse(String(ptr?.movedAt ?? ''))
  if (Number(since) > 0 && Number.isFinite(at) && at < Number(since)) return { state: 'here' }
  return { state: 'moved', to }
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
