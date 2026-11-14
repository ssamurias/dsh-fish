// 云端备份的调度与兜底（2026-11-14，用户 m01090）
//
// 分工：clouddrive.js 管「怎么把字节放到某处」，这一层管「什么时候放、放哪几份、
// 失败了怎么办、界面该看到什么」。cloudcrypto.js 管加密，cloudtargets.js 管字段形状。
//
// 用户拍板的几条（m01090），写在这里免得以后被改回去：
//   1. 只用他已有的东西：一个文件夹 / 一个仓库 / 一个 WebDAV / 一个邮箱，加两个万能出口。
//      不要求他开服务器，也不要求他注册我们这边的任何账号。
//   2. **云端只跟历史档**（大肥鱼-自动-YYYYMMDD-HHMMSS.json）。兜底那份三十分钟一刷，
//      要是也推上去，坚果云免费版 1GB/月一天就烧光。所以 latestUp 单独一个开关，默认关。
//   3. **加密默认开**。备份包里有 owner.json（她的 B 站 cookie），传出去的东西不能是明文。
//      口令放 cloud-key.txt，不进备份——这条在 cloudcrypto.js 里解释了为什么。
//   4. 失败不当场死：进队列，指数退避（1 分钟 → 5 → 30 → 2 小时 → 6 小时）。
//      用户在设置页能看见「哪个目标、为什么、下次什么时候再试」，不用翻日志。
//
// 还有一个刻意的取舍：**本地永远先存**。云端这一步失败了，本地那份已经躺在 backups/ 里了，
// 所以「云端挂了」不等于「没备份」——界面上也是这么说的。

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { rootDir } from './store.js'
import { loadConfig, updateConfig } from './settings.js'
import { listAutoBackups, autoBackupDir, LATEST_NAME } from './autobackup.js'
import { readPass, hasPass, encryptBuffer, encName, passFingerprint, passProblem } from './cloudcrypto.js'
import { driver } from './clouddrive.js'
import { targetProblem, kindLabel, kindsDoc, publicTarget } from './cloudtargets.js'

const DAY_MS = 86_400_000
/** 失败后的重试间隔：依次取，用完就一直是最后一个。 */
export const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000]
export const QUEUE_FILE = 'cloud-queue.json'

export function queuePath(root = rootDir()) {
  return join(root, QUEUE_FILE)
}

/** 我们自己推上去的文件名：历史档（可能带 .enc）与兜底档。 */
export function isOurs(name) {
  const n = String(name ?? '').replace(/\.enc$/, '')
  if (n === LATEST_NAME) return true
  return /^大肥鱼-自动-\d{8}-\d{6}\.json$/.test(n)
}

function readQueue(root) {
  try {
    const raw = JSON.parse(readFileSync(queuePath(root), 'utf8'))
    const items = raw && typeof raw === 'object' && raw.items && typeof raw.items === 'object' ? raw.items : {}
    return { items }
  } catch {
    return { items: {} }
  }
}

function writeQueue(root, q) {
  try {
    writeFileSync(queuePath(root), JSON.stringify({ items: q.items ?? {} }, null, 1), 'utf8')
  } catch {}
}

/** 现在有哪些目标真的能用（开着 + 必填项齐了）。 */
export function readyTargets(config) {
  const list = Array.isArray(config?.cloud?.targets) ? config.cloud.targets : []
  return list.filter((t) => t && t.enabled !== false && !targetProblem(t))
}

/**
 * 该不该往云端推一份新的。
 * 只跟「历史档」的节奏走（cloud.everyDays），不跟兜底档。
 *
 * root 要传：口令文件是**按数据目录**的，不传就去看默认目录——
 * 测在临时目录里、界面在真目录里，两边看到的「有没有口令」会不是同一件事。
 */
export function cloudDue(config, now = new Date(), root = rootDir()) {
  const c = config?.cloud ?? {}
  if (c.enabled !== true) return { due: false, why: '关着' }
  const ready = readyTargets(config)
  if (!ready.length) return { due: false, why: '还没有能用的目标' }
  if (c.encrypt !== false && !hasPass(root)) return { due: false, why: '还没设加密口令' }
  const last = Date.parse(String(c.lastAt ?? ''))
  if (!Number.isFinite(last)) return { due: true, why: '还没推过' }
  const every = Math.max(1, Math.round(Number(c.everyDays) || 1))
  const left = last + every * DAY_MS - (now instanceof Date ? now.getTime() : Number(now))
  if (left > 0) return { due: false, why: `${Math.ceil(left / 3_600_000)} 小时后` }
  return { due: true, why: `距上次超过 ${every} 天` }
}

/**
 * 本地最近一份历史档的绝对路径；没有就 null。
 *
 * 注意这是异步的：listAutoBackups 要 stat 每个文件。早先写成同步的，
 * 拿到的是一个 Promise 而不是数组，`list.length` 恒为 undefined，
 * 于是「本地有没有那份」永远答「没有」——云端备份会一直停在
 * 「本地还没有历史备份」。谁调它都得 await。
 */
export async function newestLocal(root) {
  const list = await listAutoBackups(root)
  if (!list.length) return null
  return { name: list[0].name, bytes: list[0].bytes, file: join(autoBackupDir(root), list[0].name) }
}

function readLocal(root, name) {
  const file = join(autoBackupDir(root), String(name ?? '').replace(/[\\/]/g, ''))
  if (!existsSync(file)) return null
  return readFileSync(file)
}

/** 该推的那份字节（按需加密）。返回 {name, buf} 或 {why}。 */
function payloadFor(root, name, config) {
  const buf = readLocal(root, name)
  if (!buf) return { why: `本地那份「${name}」已经不在了（可能被清理掉了）。` }
  if (config?.cloud?.encrypt === false) return { name, buf }
  const pass = readPass(root)
  const bad = passProblem(pass)
  if (bad) return { why: bad }
  return { name: encName(name), buf: encryptBuffer(buf, pass) }
}

function backoffFor(tries) {
  return BACKOFF_MS[Math.min(Math.max(0, tries - 1), BACKOFF_MS.length - 1)]
}

/**
 * 往一个目标推一份。成功会顺手清掉超出 keep 的旧份。
 * 返回 {ok, name, bytes, removed, note} 或 {ok:false, why}
 */
export async function pushTo(root, target, name, config, { log = () => {} } = {}) {
  const d = driver(target.kind)
  if (!d) return { ok: false, why: `不认识「${target.kind}」这种目标。` }
  const p = payloadFor(root, name, config)
  if (!p.name) return { ok: false, why: p.why }
  try {
    const r = await d.put(target, p.name, p.buf)
    let removed = 0
    const keep = Math.max(1, Math.round(Number(config?.cloud?.keep) || 3))
    if (typeof d.list === 'function' && typeof d.remove === 'function') {
      try {
        const remote = (await d.list(target)).filter((x) => isOurs(x?.name))
        const sorted = remote.map((x) => String(x.name)).sort().reverse()
        for (const old of sorted.slice(keep)) {
          try {
            const rr = await d.remove(target, old)
            if (rr && rr.ok) removed++
          } catch {}
        }
      } catch {}
    }
    return { ok: true, name: p.name, bytes: p.buf.length, removed, note: r?.note ?? '' }
  } catch (e) {
    const why = String(e?.message ?? e ?? '不知道什么原因')
    log('cloud', `${kindLabel(target.kind)}（${target.name}）没传上去：${why}`)
    return { ok: false, why }
  }
}

/**
 * 主入口：推一次。
 * force=true 时不管 everyDays 与「跟上次同一个文件」都推（用户点了「立刻传一份」）。
 */
export async function runCloudBackup(root = rootDir(), opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date(opts.now ?? Date.now())
  const log = opts.log ?? (() => {})
  const config = opts.config ?? (await loadConfig(root)).config
  const force = opts.force === true
  const c = config?.cloud ?? {}

  if (c.enabled !== true && !force) return { ok: false, why: '云端备份关着' }
  const targets = readyTargets(config)
  if (!targets.length) {
    const any = Array.isArray(c.targets) ? c.targets.length : 0
    return { ok: false, why: any ? '目标都还没填完，或者都关着' : '还没有目标' }
  }

  const newest = await newestLocal(root)
  if (!newest) return { ok: false, why: '本地还没有历史备份——等它攒出一份，或者先把自动备份打开' }

  // 同一份不重复推（除非 force）：用户改了 everyDays 也不会把同一份传两遍。
  if (!force && c.lastName && c.lastName === newest.name) {
    const drained = await drainQueue(root, { config, now, log })
    return { ok: true, skipped: '跟上次推的是同一份', results: [], drained }
  }

  const results = []
  for (const t of targets) {
    const r = await pushTo(root, t, newest.name, config, { log })
    results.push({ id: t.id, kind: t.kind, name: t.name, ...r })
  }

  // 兜底那份要不要一起上云（默认关，理由见文件头）。
  if (c.latestUp === true) {
    for (const t of targets) {
      const p = payloadFor(root, LATEST_NAME, config)
      if (!p.name) continue
      try {
        await driver(t.kind).put(t, p.name, p.buf)
      } catch (e) {
        log('cloud', `兜底那份往 ${t.name} 传失败了：${e?.message ?? e}`)
      }
    }
  }

  const anyOk = results.some((r) => r.ok)
  const patch = anyOk ? { lastAt: now.toISOString(), lastName: newest.name } : {}
  if (Object.keys(patch).length) {
    try { await updateConfig({ cloud: patch }, root) } catch (e) { log('cloud', `记不住这次的时间：${e?.message ?? e}`) }
  }
  await noteFailures(root, results, now)
  const drained = await drainQueue(root, { config, now, log })
  return { ok: anyOk, name: newest.name, results, drained }
}

/** 把这一轮的失败记进队列（成功的就把旧记录清掉）。 */
async function noteFailures(root, results, now) {
  const q = readQueue(root)
  for (const r of results) {
    if (r.ok) delete q.items[r.id]
    else {
      const prev = q.items[r.id] ?? { tries: 0 }
      const tries = Number(prev.tries || 0) + 1
      q.items[r.id] = { tries, why: r.why ?? '', at: now.toISOString(), nextAt: new Date(now.getTime() + backoffFor(tries)).toISOString(), name: r.name ?? '' }
    }
  }
  writeQueue(root, q)
}

/**
 * 把到期的失败重试一遍。这不看 everyDays——那是「推新的」的节奏，
 * 重试是「刚才这一份没送上去」，耽误了就等于这段时间没有异地副本。
 */
export async function drainQueue(root = rootDir(), opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date(opts.now ?? Date.now())
  const log = opts.log ?? (() => {})
  const config = opts.config ?? (await loadConfig(root)).config
  const q = readQueue(root)
  const ids = Object.keys(q.items)
  if (!ids.length) return { tried: 0, ok: 0 }
  const byId = new Map((config?.cloud?.targets ?? []).map((t) => [t.id, t]))
  let tried = 0
  let ok = 0
  for (const id of ids) {
    const item = q.items[id]
    // 先看该不该重试，再看这条目标还在不在。
    // 反过来的话，一条「还没到点」的记录会因为目标暂时关了就被清掉——
    // 用户把某个目标关两天再打开，欠着的那几份就永远不会补送了。
    if (Date.parse(String(item.nextAt ?? '')) > now.getTime()) continue
    const t = byId.get(id)
    if (!t || t.enabled === false || targetProblem(t)) { delete q.items[id]; continue }
    const name = item.name || (await newestLocal(root))?.name
    if (!name) { delete q.items[id]; continue }
    tried++
    const r = await pushTo(root, t, name, config, { log })
    if (r.ok) { delete q.items[id]; ok++ }
    else {
      const tries = Number(item.tries || 0) + 1
      q.items[id] = { tries, why: r.why ?? '', at: now.toISOString(), nextAt: new Date(now.getTime() + backoffFor(tries)).toISOString(), name }
    }
  }
  writeQueue(root, q)
  return { tried, ok }
}

/**
 * 「测一下」：验证这个目标到底能走到哪一步。
 *
 * 2026-11-14 用户 m03310：「这个测试云端备份能不能通的按钮真能测试出来结果吗…
 * 通了之后，你要详细显示能测出来的是什么」。
 * 所以这里不再只回一句「通了」——每个驱动的 probe 自己会说清
 * 「我测到了什么、我测不到什么」，这里只负责把结果原样带上去。
 */
export async function testTarget(target, { root = rootDir(), config = null } = {}) {
  const d = driver(target?.kind)
  if (!d) return { ok: false, why: '不认识这种目标。' }
  const miss = targetProblem(target)
  if (miss) return { ok: false, why: miss }
  if (typeof d.probe !== 'function') return { ok: false, why: '这个目标不支持探测。' }
  try {
    const r = await d.probe(target)
    // 驱动可能自己判 ok:false（比如仓库是公开的、目录写不进去）——
    // 以前这里无条件覆写成 ok:true，会把「仓库是公开的」这种警告也变成一颗绿勾。
    return { ...r, ok: r?.ok !== false }
  } catch (e) {
    return { ok: false, why: String(e?.message ?? e ?? '不知道什么原因') }
  }
}

/**
 * 设置页要显示的一切。
 *
 * 异步的：读配置与数本地那几份都要 await（loadConfig / listAutoBackups 都是 async）。
 * 有一版这里写成了同步的，`loadConfig(root).config` 拿到的是 Promise 的属性 → undefined，
 * 加上 newestLocal 没 await，界面会一直显示「本地还没有历史备份」。
 */
export async function cloudStatus(root = rootDir(), opts = {}) {
  const config = opts.config ?? (await loadConfig(root)).config
  const now = opts.now instanceof Date ? opts.now : new Date(opts.now ?? Date.now())
  const c = config?.cloud ?? {}
  const pass = readPass(root)
  const due = cloudDue(config, now, root)
  const q = readQueue(root)
  const list = Array.isArray(c.targets) ? c.targets : []
  const newest = await newestLocal(root)
  const dir = autoBackupDir(root)
  return {
    enabled: c.enabled === true,
    everyDays: Math.max(1, Math.round(Number(c.everyDays) || 1)),
    keep: Math.max(1, Math.round(Number(c.keep) || 3)),
    encrypt: c.encrypt !== false,
    latestUp: c.latestUp === true,
    hasPass: hasPass(root),
    passHint: String(c.passHint ?? ''),
    passFingerprint: passFingerprint(pass),
    passProblem: passProblem(pass),
    lastAt: String(c.lastAt ?? ''),
    lastName: String(c.lastName ?? ''),
    due: due.due,
    dueWhy: due.why,
    localDir: dir,
    newest: newest ? { name: newest.name, bytes: newest.bytes } : null,
    targets: list.map((t) => ({
      ...publicTarget(t),
      label: kindLabel(t.kind),
      pending: q.items[t.id] ?? null,
    })),
    queue: Object.entries(q.items).map(([id, v]) => ({ id, ...v })),
    // 表单的字段表也一起带过去：客户端只能 require('react')，拿不到 lib/cloudtargets.js。
    // 这样「加一个字段只改一处」这个约束对界面也成立。
    kinds: kindsDoc(),
  }
}

/** 界面上一句话：云端现在什么状况。 */
export function cloudSizeText(status) {
  if (!status) return ''
  if (!status.enabled) return '关着'
  const ready = (status.targets ?? []).filter((t) => t.enabled && t.ready).length
  if (!ready) return '还没有能用的目标'
  if (!status.lastAt) return '还没推过'
  return `推到过 ${ready} 个地方`
}

/** 状态页的一句总结：把「本地是好的、云端怎样」说清楚。 */
export function cloudLine(status) {
  if (!status) return ''
  if (!status.enabled) return '云端备份关着。本地那份照常存，只是不会往外送。'
  const ready = (status.targets ?? []).filter((t) => t.enabled && t.ready).length
  if (!ready) return '还没有能用的目标——本地那份照常存，云端这一步先空着。'
  if (!status.lastAt) return `还没推过。到点会推到 ${ready} 个地方。`
  if (status.due) return status.dueWhy
  return `${ready} 个地方都有过；${status.dueWhy}`
}

export { passFingerprint }
