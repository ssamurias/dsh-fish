/**
 * home.js —— 她的屋子：自动建工作区 + 一个专属会话（P3 的核心改造）
 *
 * 为什么改成这样（2026-10-23 用户定案）：
 *   原方案是「观测台里加一个输入框」。用户否掉了，理由是——这是个要发布到 GitHub 的插件，
 *   别人装完不该看到一个黑窗口 + 一个 http://127.0.0.1:xxxx/?token=... 的地址，
 *   也不该被要求「自己建一个 profile」。
 *   正确的形态：插件加载时**自己**在侧栏建一个工作区和一个会话，她住在那里面，
 *   你跟她的所有对话就在那个会话里说。参考 @a9i5k4/dsh-auto-memory 的「记忆中枢」。
 *
 * 三个 API（全部来自宿主，已从 app.asar 核实签名）：
 *   ctx.workspaceRegistry.list() / .create(path, title) / .get(id)
 *     - create 语义：同一个规范路径重复调用返回**已存在**的那条，不新建、不改标题。
 *   ctx.sessionController.create({ workspaceId }) 或 ({ cwd })，二者只能给一个
 *     - 返回 { sessionId }；传 workspaceId 时才会把会话挂进工作区（侧栏才看得见）。
 *   ctx.sessionController.rename({ sessionId, title })
 *     - 需要宿主的 sessionTitle 服务；没有就跳过（不是致命错误）。
 *
 * 幂等（关键，否则每次重启都多一个会话）：
 *   把 {wsId, sessionId} 记在 `~/.dsh-fish/home.json`。
 *   下次加载先验：「这个 sessionId 还在这个工作区的 sessionIds 里吗」——
 *   用户可能把会话归档/删了，那就重建一个，而不是永远指向一个空壳。
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { rootDir, paths, readJson, writeAtomic } from './store.js'
import { withFileLock } from './tenant.js'
import { TALK_KEEP } from './talkmem.js'
import { armHandoff, buildHandoff } from './handoff.js'
import { freshWakeText } from './wakeconst.js'
import { dateKey, loadConfig } from './settings.js'

const TITLE_WORKSPACE = '大肥鱼的家'
const TITLE_SESSION = '跟大肥鱼说话'

// home.json 的读-改-写必须串行（issue #14 第二报排查所得，2026-10-31）。
// 轮换、结账、旁听记账、唤醒记账都会「读整份 → 改一项 → 写回去」，
// 两处并发时后写的那份带着自己读到的旧快照，会把对方刚写进去的字段抹掉——
// 表现就是字段莫名消失（turns 停住、wokeFor 不见），且完全是时序相关、偶发。
// 这里用一条模块级 promise 链把临界区排队：跨进程另有 withFileLock 管，这里是进程内。
let homeQueue = Promise.resolve()
function mutateHome(fn) {
  const run = homeQueue.then(fn, fn)
  homeQueue = run.then(() => {}, () => {})
  return run
}

function homeFile(root) {
  return join(paths(root).root, 'home.json')
}

/** 她的屋子目录：工作区指向这里（不是 ~/.dsh-fish 根，那里面有 events.jsonl）。 */
export async function ensureHomeDir(root = rootDir()) {
  const dir = join(paths(root).root, 'home')
  await fs.mkdir(dir, { recursive: true })
  return dir
}

function readRegistry(ctx) {
  try { return ctx.get?.('workspaceRegistry') ?? null } catch { return null }
}

function pathKey(p) {
  // Windows 大小写不敏感；其余平台保持原样。只用于比对，不用于文件访问。
  const s = String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? s.toLowerCase() : s
}

/**
 * 找到或创建工作区。**先查后建**：宿主 create 本身是幂等的，但明查一遍能拿到
 * 已存在的 title / id，避免依赖实现细节。
 */
export async function ensureWorkspace(ctx, { root = rootDir(), title = TITLE_WORKSPACE } = {}) {
  const dir = await ensureHomeDir(root)
  const reg = readRegistry(ctx)
  if (!reg?.create) return { ok: false, why: '宿主没有 workspaceRegistry 服务', dir }

  let ws = null
  try {
    const list = typeof reg.list === 'function' ? reg.list() : []
    ws = list.find((w) => w && w.path && pathKey(w.path) === pathKey(dir)) ?? null
  } catch { /* list 不可用就直接 create */ }

  const existed = Boolean(ws)

  // 老档改名：早期版本把工作区叫「鱼」，现在统一叫「大肥鱼的家」。
  // 宿主真正的改名入口在**实体**上：registry.list()/get() 返回的 Workspace 有 setTitle(title)；
  // registry 自己**没有** update/rename（2026-10-25 从 app.asar 核实）。
  // 早先那版调 reg.update/reg.rename，两个都不存在、又被 catch 吞掉，所以标题一直是「鱼」。
  // 改不动的仍然保持原名——她那间屋子还能住，只是侧栏名不对。
  let renamed = false
  if (ws && title && String(ws.title ?? '') !== title) {
    try {
      if (typeof ws.setTitle === 'function') {
        await ws.setTitle(title)
        renamed = true
      } else if (typeof reg.rename === 'function') {
        await reg.rename(ws.id ?? ws.workspaceId, title)
        renamed = true
      }
    } catch { renamed = false }
  }

  if (!ws) {
    try {
      ws = await reg.create(dir, title)
    } catch (err) {
      return { ok: false, why: `建工作区失败：${String(err?.message ?? err).slice(0, 120)}`, dir }
    }
  }

  const wsId = String(ws?.id ?? ws?.workspaceId ?? '')
  if (!wsId) return { ok: false, why: '宿主返回的工作区没有 id', dir }
  return { ok: true, wsId, dir, created: !existed, renamed }
}

/**
 * 刚建出来的会话，就算宿主还没把它列进 ws.sessionIds，也先当它还活着。
 *
 * 为什么（2026-10-28 房客日志，m01863）：宿主的 workspaceRegistry 是**异步索引**的，
 * 会话建好之后有一小段时间 `ws.sessionIds` 里查不到它。老判据只认那个数组，
 * 于是「刚建好 → 下次重启查不到 → 当成没了 → 再建一条」，几轮下来同一间屋堆出
 * 一串空壳会话（日志里 20:30 与 20:31 各一条就是这个形状）。
 */
export const HOME_GRACE_MS = 10 * 60_000

// 同一个 root 只允许有一条「建会话」在飞。
// 为什么必须（同一份日志）：启动链路的 bootstrapHome 与「她第一次说话」触发的
// talkSessionId 是两条独立路径，都可能发现会话没了、各自 sc.create 一次，
// 结果同一个家同时长出两条会话。进程内共享同一个 promise 就够了——
// 跨进程/跨家由 0.6.7 的 instance.json 占用权兜住。
const inflight = new Map()

/**
 * 跨进程那把锁的文件位置。
 *
 * 为什么单独一个文件而不是复用 instance.json：占用权是「谁是房主」的长效声明
 * （心跳续期），锁是「我正在写 home.json」的瞬时标记，生命周期和归属都不一样，
 * 混在一起会让心跳把锁续活、锁又把占用权读成过期。
 */
function sessionLockFile(root) {
  return join(paths(root).root, '.talk-session.lock')
}

/**
 * 找到或创建那个对话会话。
 *
 * 判定「还活着」的口径（0.6.8 改）：
 *   1. home.json 记着 `status:'archived'` → **不自动重建**，返回 archived:true。
 *      这是用户自己收起来的那一局，插件替他重开等于把「我收起来了」这句话当没听见。
 *      要重开只有一条路：带 `force:true`（观测台「重新搭一间」/ 重置流程）。
 *      例外（2026-10-30，用户 m02853）：同一间屋子里还有**别的没归档的会话**时，
 *      认那一条继续用——归档的是那一条，不是整个家。
 *   2. sessionId 在 `archivedSessionIds` 里 → 记成 archived，同上（同样先看同屋有没有别的活会话）。
 *   3. 在 ws.sessionIds 里，或者 `createdAt` 距今不到 HOME_GRACE_MS → 复用。
 *   4. 其余才重建。
 */
export async function ensureTalkSession(ctx, opts = {}) {
  const root = opts.root ?? rootDir()
  const key = String(root).toLowerCase()
  if (inflight.has(key)) return inflight.get(key)
  const p = (async () => {
    try {
      const res = await withFileLock(
        sessionLockFile(root),
        () => ensureTalkSessionOnce(ctx, { ...opts, root }),
        opts.lockOpts,
      )
      if (res && res.locked === false) {
        // 另一个进程正在建/写这个家：不硬建。它建完会把 sessionId 写进 home.json，
        // 这里读一眼就复用；读不到才算这次失败（下次启动再来）。
        const saved = await readJson(homeFile(root), null).catch(() => null)
        if (saved?.sessionId && String(saved.status ?? '') !== 'archived') {
          return { ok: true, sessionId: String(saved.sessionId), reused: true, waited: true }
        }
        return { ok: false, why: res.why }
      }
      return res
    } catch (err) {
      return { ok: false, why: `建会话的锁没拿到：${String(err?.message ?? err).slice(0, 120)}` }
    }
  })().finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}

/**
 * 同一间屋子里，除了 `avoid` 之外**还活着**的那条会话（没有就返回空串）。
 *
 * 为什么要这一条（2026-10-30，用户 m02853）：home.json 只记得一条会话。用户把那条
 * 归档之后，同一个工作区里可能还有另一条开着——以前插件只认 home.json 那一条，
 * 一看见它归档就宣布「这个家的会话被收起来了」，把明明还在的那条当成不存在。
 * 现在先把「归档的那条」和「这个工作区里另外的活会话」分开判断：只要还有一条
 * 没归档的，就认它，而不是让整个家停摆。
 *
 * 取最前面那条（宿主建会话时是 `sessionIds: [新id, ...旧的]`，往**前**插，
 * 所以头部才是最新那条），但不做别的假设：拿不到 registry、sessionIds 不是数组、
 * 全是归档的，都退回空串，由调用方按原样拒绝。
 *
 * issue #33：这里以前取 `live[live.length - 1]`，注释还写着「宿主按创建顺序往
 * sessionIds 里追加」——方向反了。结果是当前会话被归档、同一工作区还有别的活会话时，
 * 认回来的是**最旧**那条，她于是坐进一条早就没在用的对话。
 * 需要提醒的是：用户在侧栏拖动过顺序时 `live[0]` 是列表最上面那条，未必就是最新；
 * 真要按时间严格排序，得问 `sessionController.list()`（`sessionListed` 那条路）。
 * 这里只修「明显反了」的方向，不对侧栏顺序做额外假设。
 */
function pickLiveSession(reg, wsId, avoid = '') {
  try {
    const ws = reg?.get?.(wsId)
    const ids = Array.isArray(ws?.sessionIds) ? ws.sessionIds : []
    const archived = Array.isArray(reg?.archivedSessionIds) ? reg.archivedSessionIds : []
    const live = ids
      .map((id) => String(id ?? ''))
      .filter((id) => id && id !== avoid && !archived.includes(id))
    return live.length ? live[0] : ''
  } catch { return '' }
}

/**
 * 这条会话宿主自己认不认（0.8.7，2026-11-03 用户 m01775 反馈）。
 *
 * 为什么不能只看工作区索引：`workspaceRegistry.get(wsId).sessionIds` 是**异步索引**的。
 * 插件刚用 `sc.create({workspaceId})` 建出来的会话，有一段时间不在那个数组里；
 * 以前只认它，于是「新会话明明还在」被判成死了——要么再建一条（侧栏里一串空壳），
 * 要么被各处兜底拉回旧会话。表现正是用户报的：
 * **满 40 轮换过会话之后，自动醒一醒还发进旧对话**（手动点一次却会落到新对话，
 * 因为那条路走的是另一个函数、每次现问 `sessionController.list()`）。
 *
 * `sessionController.list()` 直接问宿主有哪些会话，比工作区索引新；拿不到就当不知道
 * （返回 false，维持原来的判定，不凭空认活）。
 */
async function sessionListed(sc, sessionId) {
  const row = await sessionRow(sc, sessionId)
  return row.found
}

/**
 * 在宿主会话列表里找这一条，把 `blank` 一起带出来。
 *
 * 为什么要看 `blank` 而不只是「在不在列表里」（2026-11-06 换房报告）：
 * 宿主的 `list()` 会把**每一条活着的会话都推出来**（`summaryFor` 无条件 push），
 * 空白会话也在里面，只是侧栏按 `blank && id !== current` 把它藏起来。
 * 所以「列表里有这一行」只说明会话被持久化了，**不说明它跑出过内容**——
 * 拿它当「叫醒落地了」的判据，会让复核永远当成功，那句「再叫一次」是死代码。
 * 真正跑过一轮的标志是 `blank === false`（宿主在 `turn/start` 时清掉它）。
 *
 * @returns {Promise<{found:boolean, blank:boolean|undefined}>} 查不到/查失败都是 `found:false`
 */
export async function sessionRow(sc, sessionId) {
  try {
    if (typeof sc?.list !== 'function') return { found: false, blank: undefined }
    const l = await sc.list({})
    const items = l?.items ?? l?.value?.items ?? []
    const row = items.find((x) => String(x?.sessionId ?? x?.id ?? '') === String(sessionId))
    if (row === undefined) return { found: false, blank: undefined }
    return { found: true, blank: typeof row.blank === 'boolean' ? row.blank : undefined }
  } catch { return { found: false, blank: undefined } }
}

/**
 * 把 home.json 从「已归档的那条」改指到同屋另一条活会话上。
 * 失败不抛：改不动就这次不认，下次启动再判一次。
 */
async function adoptLiveSession(root, saved, { wsId, sessionId, title }) {
  // 2026-11-15（用户 m01722）：认领一条新窗口也是一次换房间——这里的「家」从
  // 一条已经没了的会话搬到另一条上，他第一句开口时该看到同一页交接，否则
  // 「手动新开窗口」这条路永远没有交接（原来只有轮换那条路拼 carry）。
  const carry = await buildHandoff(root, { turns: await carryTurnsFor(root) }).catch(() => '')
  const next = {
    ...saved,
    wsId,
    sessionId,
    title: saved?.title || title,
    // 不复用旧会话的 createdAt：宽限期是「刚建出来的那条」用的，
    // 认来的这条按 sessionIds 判活就够了，不能因为借了别人的时间戳而享受宽限。
    createdAt: '',
    adoptedAt: new Date().toISOString(),
    ...(carry ? { carry } : {}),
  }
  delete next.status
  delete next.archivedAt
  try {
    await writeAtomic(homeFile(root), JSON.stringify(next, null, 2))
    return { ...next, ok: true }
  } catch { return null }
}

/**
 * 建一条会话。带 preset 就先按它建；宿主不认（老宿主 / 那条 preset 没装）
 * 就退回默认组合，并让人知道这次放宽了——不能静默降级。
 *
 * 为什么单拎出来：建会话有两条路——启动时补一条（ensureTalkSessionOnce），
 * 聊满轮数换一间（rotateTalkSessionOnce）。2026-11-19 外部用户反馈：换房那条路
 * 根本没传 preset，新房间就照宿主的默认走；那位用户的默认是「PTC 极简」，
 * 换完房她只剩几件工具。两条路必须同一个口径。
 */
async function createTalkSession(sc, { workspaceId, preset = '', log } = {}) {
  const want = String(preset ?? '').trim()
  if (want) {
    try {
      const created = await sc.create({ workspaceId, agentPreset: want })
      return { sessionId: String(created?.sessionId ?? created?.id ?? ''), preset: want }
    } catch (err) {
      const why = String(err?.message ?? err).slice(0, 160)
      log?.(`受限 preset「${want}」没被接受（${why}），这次用默认组合建会话`)
    }
  }
  const created = await sc.create({ workspaceId })
  return { sessionId: String(created?.sessionId ?? created?.id ?? ''), preset: '' }
}

async function ensureTalkSessionOnce(ctx, { root = rootDir(), wsId, title = TITLE_SESSION, preset = '', log, force = false } = {}) {
  const sc = ctx.sessionController
  if (!sc?.create) return { ok: false, why: '宿主没有 sessionController 服务' }
  if (!wsId) return { ok: false, why: '没有工作区 id' }

  const reg = readRegistry(ctx)
  const saved = await readJson(homeFile(root), null)

  // ---- 用户自己收起来的那一局：不重开，除非明说要 ----
  if (saved?.sessionId && String(saved.status ?? '') === 'archived' && force !== true) {
    // 2026-10-29（用户 m03508）：他把那条会话从「已归档」里放回来了，插件却还拿着
    // home.json 里的 archived 标记，一直当她「收起来了」。宿主那边已经把她放回正常
    // 列表（在 ws.sessionIds 里、且不在 archivedSessionIds 里）时当场认回来：
    // 清掉标记、走下面的正常复用，数据一条不动。
    // 反过来，只要宿主还说她在归档里，就继续等用户点「重新搭一间」——
    // 不然「我收起来了」这句话又会被插件自己推翻。
    let restored = false
    try {
      const ws = reg?.get?.(wsId)
      const archived = Array.isArray(reg?.archivedSessionIds) ? reg.archivedSessionIds : []
      restored = Array.isArray(ws?.sessionIds)
        && ws.sessionIds.includes(saved.sessionId)
        && !archived.includes(saved.sessionId)
    } catch { restored = false }

    if (restored) {
      try {
        const next = { ...saved }
        delete next.status
        delete next.archivedAt
        await writeAtomic(homeFile(root), JSON.stringify(next, null, 2))
        saved.status = ''
        saved.archivedAt = null
      } catch { /* 写不下来就只这一次认回来，下次再判一次 */ }
    } else {
      // 同屋还有别的活会话就认它（见 pickLiveSession 的注释）；一条都没有才算收起来。
      const other = pickLiveSession(reg, wsId, String(saved.sessionId))
      if (other) {
        const adopted = await adoptLiveSession(root, saved, { wsId, sessionId: other, title })
        if (adopted) {
          log?.(`同一间屋子里另有一条活会话（${other}），这次认它，不再报「被收起来了」`)
          return { ok: true, sessionId: other, reused: true, adopted: true }
        }
      }
      return {
        ok: false,
        archived: true,
        sessionId: String(saved.sessionId),
        why: '这个家的会话被收起来了（已归档）；要重新搭一间，用「重新搭一间」',
      }
    }
  }

  // ---- 先看上次那个会话还在不在 ----
  if (saved?.sessionId) {
    let alive = false
    let isArchived = false
    try {
      const ws = reg?.get?.(wsId)
      const archived = Array.isArray(reg?.archivedSessionIds) ? reg.archivedSessionIds : []
      isArchived = archived.includes(saved.sessionId)
      alive = Boolean(ws && Array.isArray(ws.sessionIds) && ws.sessionIds.includes(saved.sessionId))
        && !isArchived
    } catch { alive = false }
    // 工作区索引还没跟上这条会话时，再问一次宿主本身（见 sessionListed 的注释）。
    // 0.8.7：轮换之后新会话常常只在这一步能认出来——认不出来就会被拉回旧会话，
    // 醒一醒、结账、轮数全都跟着落回旧的那条。
    if (!alive && !isArchived && saved.sessionId) {
      alive = await sessionListed(sc, saved.sessionId)
      if (alive) log?.(`会话 ${saved.sessionId} 还活着（宿主会话列表里有，工作区索引还没跟上）`)
    }

    if (isArchived && force !== true) {
      // 宿主那边确认归档了：把这件事记进 home.json，重启之后也认。
      try {
        await writeAtomic(homeFile(root), JSON.stringify({
          ...saved, status: 'archived', archivedAt: new Date().toISOString(),
        }, null, 2))
      } catch { /* 记不下来就下次再判一次，不抛 */ }
      // 但「这条归档了」不等于「这个家没人了」：同屋还有活的就认它。
      const other = pickLiveSession(reg, wsId, String(saved.sessionId))
      if (other) {
        const adopted = await adoptLiveSession(root, saved, { wsId, sessionId: other, title })
        if (adopted) {
          log?.(`${saved.sessionId} 已归档，同屋另有一条活会话（${other}），这次认它`)
          return { ok: true, sessionId: other, reused: true, adopted: true }
        }
      }
      return {
        ok: false,
        archived: true,
        sessionId: String(saved.sessionId),
        why: '这个家的会话被收起来了（已归档）；要重新搭一间，用「重新搭一间」',
      }
    }

    // 宽限期：刚建出来的那条，宿主索引还没跟上也算活着。
    // 归档过的（含 force 重建时）不算——那种情况要的是新的一条。
    let recent = false
    if (!isArchived) {
      try {
        const t = Date.parse(String(saved.createdAt ?? ''))
        recent = Number.isFinite(t) && Date.now() - t < HOME_GRACE_MS
      } catch { recent = false }
    }

    if (alive || recent) {
      // 老档改名：早期版本叫「跟她说话」，现在统一叫「跟大肥鱼说话」。
      // 改名失败不影响使用（侧栏照旧显示旧标题），所以只试一次、不抛。
      if (title && saved.title !== title) {
        try {
          if (typeof sc.rename === 'function') await sc.rename({ sessionId: saved.sessionId, title })
          await writeAtomic(homeFile(root), JSON.stringify({ ...saved, title }, null, 2))
        } catch { /* 改不了就保持原名 */ }
      }
      const out = { ok: true, sessionId: saved.sessionId, reused: true }
      if (saved.status === 'archived') out.wasArchived = true
      return out
    }
  }

  // ---- 建一个新的 ----
  // 指定受限 preset：`fish-home` 只挂她的工具 + 看图 + 身份文件，
  // 没有 shell、没有 write/edit、没有联网、没有技能。见 profile 的
  // cordis.patch.yml 里 preset-fish-home 那一行。
  // preset 不被接受（老宿主 / 没装）时回落默认组合，但**必须让调用方知道**，
  // 否则她会在「全套工具」下悄悄长大 —— 这是自检里「她的工具面」要报的。
  try {
    const room = await createTalkSession(sc, { workspaceId: wsId, preset, log })
    const sessionId = room.sessionId
    const presetUsed = room.preset
    if (!sessionId) return { ok: false, why: '宿主建了会话但没给 id' }
    if (typeof sc.rename === 'function') {
      // 命名失败不影响功能：侧栏会显示默认标题，但会话本身是好的
      await sc.rename({ sessionId, title }).catch(() => {})
    }
    await writeAtomic(homeFile(root), JSON.stringify({ wsId, sessionId, title, preset: presetUsed, pressureRoomLinks: saved?.pressureRoomLinks, pressureRoomIds: [...new Set([...(saved?.pressureRoomIds ?? []), sessionId])], createdAt: new Date().toISOString() }, null, 2))
    return { ok: true, sessionId, reused: false, preset: presetUsed }
  } catch (err) {
    return { ok: false, why: `建会话失败：${String(err?.message ?? err).slice(0, 160)}` }
  }
}

/**
 * 一次做完全部：屋子目录 → 工作区 → 会话。
 * 任何一步失败都返回 ok:false + 人话原因，**不抛**——启动链路上抛异常会带走插件树。
 */
/**
 * 叫醒一间空白屋子。
 *
 * 为什么需要：宿主的侧栏可见性规则是
 *   `if (session.blank && session.id !== current) return false`
 * ——空白会话只在它是「当前主视图会话」时才显示。插件用 API 建出来的会话
 * 不会被设成当前会话，于是它一直藏在列表外面：用户点完重置看到的是「没有新会话」，
 * 重启也一样。让它跑一轮（blank 在开跑/成功后清掉）才是唯一能落地显示的办法。
 *
 * 代价：每一条会话只叫一次。这件事记在 `home.json` 的 `wokeFor` 里，不靠猜
 * （issue #1 报的第二个问题）：插件建的会话永远不是 current，宿主也不把它放进
 * 可见列表，所以「查不到这一行 → 按空白处理」这条分支会在它身上一直命中，
 * 每次重启都再叫一次。靠 `list()` 的 blank 判不准，就自己记账。
 *
 * 只记**成功送达**的那一次：宿主的 prompt 是「这一轮被收下了」就 resolve，
 * 收下就一定会跑出内容；抛错（比如漏传 signal）则不写，下次启动还会再试。
 */
export async function wakeIfBlank(ctx, { sessionId, root = '', log, freshOnly = false, rotated = false, force = false, verify = false } = {}) {
  if (!sessionId) return { woke: false, why: '没有会话 id' }
  const sc = ctx?.get?.('sessionController') ?? ctx?.sessionController
  if (!sc) return { woke: false, why: '宿主没有 sessionController 服务' }

  // ---- 已经叫过这一条了？----
  // 有标记就直接收手：同一条会话第二次被叫醒，只会在她的对话里多出一句
  // 没头没尾的「（醒一醒）」，还会白烧一轮。
  // root 为空就不记账（测试与只读调用不为难）：那等于回到「每次都问宿主」的老行为。
  // force：轮换之后的复核路径会用一次（见 rotateTalkSession 末尾）。宿主的 prompt
  // 是「收下了」就 resolve，不等于那一轮真的跑出了内容；新会话要是始终没进
  // list()，就说明这一声没落地，得再叫一次，否则它永远是一条看不见的空白会话。
  const saved = root ? await readJson(homeFile(root), null).catch(() => null) : null
  if (!force && String(saved?.wokeFor ?? '') === String(sessionId)) {
    return { woke: false, why: '这一局已经叫过了' }
  }

  let blank = false
  try {
    const l = typeof sc.list === 'function' ? await sc.list({}) : null
    const items = l?.items ?? l?.value?.items ?? []
    const row = items.find((x) => String(x?.sessionId ?? x?.id ?? '') === String(sessionId))
    if (row === undefined) {
      // 查不到这一行：新建的会话按空白处理，复用的按有内容处理——
      // 宁可漏唤醒，也不要每次启动都让她说话。
      blank = freshOnly === true
    } else if (typeof row.blank === 'boolean') {
      blank = row.blank
    } else {
      // 宿主没给 blank 字段：只有刚建出来的一定是空的，复用的不碰
      blank = freshOnly === true
    }
  } catch (err) {
    log?.(`查会话状态失败（${String(err?.message ?? err).slice(0, 100)}），这次不唤醒`)
    return { woke: false, why: '查不到会话状态' }
  }
  if (!blank) return { woke: false, why: '' }
  if (typeof sc.prompt !== 'function') return { woke: false, why: '宿主没有 sessionController.prompt' }

  // 不能 await：这一轮要等模型跑完，屋子建好不该被它拖住。
  // 第二个参数 signal 是宿主必填的：`prompt(request, signal)` 第一句就 signal.throwIfAborted()，
  // 漏传会抛 `Cannot read properties of undefined (reading 'throwIfAborted')`，这一声叫不醒（issue #1）。
  // 给一个永不 abort 的 signal——唤醒要等她跑完，不能加超时。
  void sc
    .prompt({
      requestId: `wake-fresh-${Date.now()}`,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: freshWakeText(new Date(), { rotated }) }],
    }, new AbortController().signal)
    .then(() => markWoke(root, sessionId))
    // 复核（2026-11-06 换房报告）：prompt 只等消息进收件箱，宿主收下了不等于
    // 那一轮真跑了（wakeDriver 可能因为上一轮还没结束直接丢掉）。隔 12 秒回头
    // 看 blank 翻没翻；没翻就再叫一次。默认关：测试里的替身不会真跑 turn，
    // 挂了复核会在 12 秒后冒出第二次 prompt，把断言搅乱。
    .then(() => {
      if (!verify) return
      void verifyWoke(ctx, { root, sessionId, log }).catch(() => {})
    })
    .catch((err) => log?.(`新屋子唤醒失败：${String(err?.message ?? err).slice(0, 140)}`))
  log?.('新屋子还是空的，叫了她一声（要等她这一轮动起来，侧栏才会显示）')
  return { woke: true, why: '' }
}

/**
 * 记下「这一条会话已经叫过了」。
 *
 * 为什么不写文件就活在内存里：进程一重启就忘了，那正是要防的事。
 * 为什么不用 home.json 里的 sessionId 比对：新建会话和「重置后重建」都会换 id，
 * 拿 id 比是最直接的语义——同一个 sessionId 只叫一次。
 * 失败只影响「下次可能多叫一次」，不影响这一次，所以永不抛。
 */
async function markWoke(root, sessionId) {
  if (!root) return
  try {
    await mutateHome(async () => {
      const saved = (await readJson(homeFile(root), null)) ?? {}
      await writeAtomic(homeFile(root), JSON.stringify({ ...saved, wokeFor: String(sessionId) }, null, 2))
    })
  } catch { /* 见上：只影响下次可能多叫一次 */ }
}

export async function bootstrapHome(ctx, { root = rootDir(), log, preset = '', force = false, tenant } = {}) {
  // 这个家已经被别的实例住着：**不建会话**，只把已知的那条报上去。
  // 为什么放在最前面（2026-10-29 m02162）：占用权只在工具写入口挡着（guardWrite），
  // 启动链路照样会走到这里建一条 —— 两个实例同时启动时，两边都判「没有会话」，
  // 于是各建一条，房客日志里 `home.json.*.tmp` 成对残留就是这么来的。
  // 房主那边已经建好的那条，home.json 里就记着；这边只读不建，重启/双开都不再多长。
  if (tenant && tenant.ok === false) {
    const saved = await readJson(homeFile(root), null).catch(() => null)
    const sid = String(saved?.sessionId ?? '')
    const archived = String(saved?.status ?? '') === 'archived'
    log?.('这个家在别处也开着（另一个实例占用中），这边不建会话')
    return {
      ok: false,
      blocked: true,
      why: '这个家在别处也开着（另一个实例占用中）；这边只读，不建新会话',
      wsId: String(saved?.wsId ?? ''),
      sessionId: archived ? '' : sid,
      archived,
    }
  }
  const ws = await ensureWorkspace(ctx, { root })
  if (!ws.ok) return { ok: false, why: ws.why, wsId: '', sessionId: '' }

  const ses = await ensureTalkSession(ctx, { root, wsId: ws.wsId, preset, log, force })
  if (!ses.ok) {
    return {
      ok: false,
      why: ses.why,
      wsId: ws.wsId,
      sessionId: '',
      archived: ses.archived === true,
    }
  }

  // 唤醒**不放在这里**：talkSessionId 在屋子缺失时也会调 bootstrapHome，
  // 那样每次「第一次说话」都会多叫一次，她一轮被点两次火。只在明确的两个入口叫：
  // index.js 的启动、observe.js 的 POST /reset。
  log?.(`屋子就绪 · 工作区 ${ws.wsId} · 会话 ${ses.sessionId}${ses.reused ? '（复用）' : '（新建）'}${ses.preset ? ` · preset ${ses.preset}` : ''}`)
  // 升级自愈（2026-11-13），放在就绪之后、唤醒之前：只补一个字段，失败不影响开工。
  await backfillRotatedTo(root, { log })
  return { ok: true, why: '', wsId: ws.wsId, sessionId: ses.sessionId, dir: ws.dir, reused: ses.reused, preset: ses.preset ?? '' }
}

/**
 * 升级自愈（2026-11-13）：0.9.9 及以前的 `home.json` 里没有 `rotatedTo`。
 *
 * 真机那次「换房后家停在旧会话」如果升级后他再也不回旧会话、旧会话也再没聊满
 * 40 轮，就永远轮不到下一次轮换去补这一对——自动醒会一直落在旧对话里。
 * 轮换的唤醒会写 `wokeFor` = 新会话；家被认回旧窗口之后它仍指着轮换建出来的那条。
 * 只补这一个字段、只补一次、补完记一行日志；不从事件流猜，也不动别的字段。
 * 已经有 `rotatedTo` 的安装（新装的、或者已经换过一轮的）什么都不做。
 */
async function backfillRotatedTo(root = rootDir(), { log } = {}) {
  if (!root) return false
  try {
    return await mutateHome(async () => {
      const saved = await readJson(homeFile(root), null)
      if (!saved) return false
      const home = String(saved.sessionId ?? '')
      const woke = String(saved.wokeFor ?? '')
      // 没有轮换、没叫醒过、或者家本来就还在轮换建出来的那条上：都没什么可补的。
      if (String(saved.rotatedTo ?? '') || !saved.rotatedAt || !home || !woke || woke === home) return false
      await writeAtomic(homeFile(root), JSON.stringify({ ...saved, rotatedTo: woke }, null, 2))
      log?.(`轮换记录补了一笔 rotatedTo = ${woke}（升级前换房留下的，家还在 ${home}）`)
      return true
    })
  } catch {
    return false
  }
}

/** 供观测台显示「她住在哪」 */
export async function homeStatus(root = rootDir()) {
  const saved = await readJson(homeFile(root), null)
  return {
    dir: join(paths(root).root, 'home'),
    wsId: saved?.wsId ?? '',
    sessionId: saved?.sessionId ?? '',
    createdAt: saved?.createdAt ?? null,
    turns: Number(saved?.turns ?? 0),
    rotatedAt: saved?.rotatedAt ?? null,
    // 换会话时被换下来的那条（issue #14 第二报）。给排查用：
    // 他要是还在旧会话里说话，日志与观测台得能说出「是换下来那条」。
    rotatedFrom: String(saved?.rotatedFrom ?? ''),
    // 轮换**建出来**的那条（2026-11-13，外部反馈：轮换后家停在旧会话，自动醒落回旧对话）。
    // 和 rotatedFrom 成一对：两个人谁先说话，屋子就跟着谁。判据只有这一对，
    // 不会认错别人的会话，也不会在换房很久之后被某条陌生会话搬走。
    rotatedTo: String(saved?.rotatedTo ?? ''),
    preset: String(saved?.preset ?? ''),
    status: String(saved?.status ?? ''),
    archivedAt: saved?.archivedAt ?? null,
  }
}

/**
 * 拿一个**挂在屋子里**的会话 id。拿不到就返回空串。
 *
 * 为什么不退而求其次用 `sc.create({ sessionId, cwd })` 现建一个：
 * 那种会话没有工作区归属，宿主侧栏会把它塞进「未分组」。2026-10-24 用户
 * 在 GUI 里看到一串 20 小时前的陌生对话，全是开发期用测试 home 跑出来的残留
 * ——她可以少醒一次，但不能在用户侧栏里堆别人的（她的）垃圾。
 *
 * 顺序：先按记下来的 wsId 复用；失效了就重建一次屋子再复用；还不行就交白卷，
 * 由调用方决定怎么说。**永不抛。**
 */
export async function talkSessionId(ctx, { root = rootDir(), log } = {}) {
  try {
    // 惰性 import，避免 home ↔ settings 的静态循环
    let preset = ''
    try {
      const { loadConfig } = await import('./settings.js')
      preset = String((await loadConfig(root))?.config?.tools?.preset ?? '')
    } catch { preset = '' }
    const { wsId } = await homeStatus(root)
    const first = await ensureTalkSession(ctx, { root, wsId, preset, log })
    if (first.ok) return first.sessionId

    const again = await bootstrapHome(ctx, { root, preset, log })
    if (again.ok) return again.sessionId
    log?.(`屋子没接上：${again.why}`)
    return ''
  } catch (err) {
    log?.(`屋子没接上：${String(err?.message ?? err).slice(0, 120)}`)
    return ''
  }
}

// ---------------------------------------------------------------------------
// 会话轮换（2026-10-23 加）
//
// 为什么必须换：一个侧栏会话聊到几百轮，上下文迟早撑爆——那时候不是"变慢"，
// 是每一轮都在为几十万字的历史付费，最后直接失败。换会话是唯一的解法。
//
// 换会话的两个代价，这个文件负责兜住：
//   1. 上一段的「我们说到哪」没了 → 用 talkmem 的原话搬运续上（不是摘要）。
//   2. 旧会话不能凭空消失 → 改名留档，它还在侧栏里，翻得回去。
// ---------------------------------------------------------------------------

/**
 * 上次旁听记在第几轮（0 = 还没记过）。旁听靠这个判断自己歇够了没有。
 *
 * 2026-10-31 修：以前 hear.js 用 `turns % every === 0` 判断到没到点，
 * 而 turns 是**从装插件那天起**的终身计数；旁听 0.8.0 才装上，装上时
 * turns 已经 4，下一次能整除要到第 6 轮——中间一直看着像「没生效」。
 * 改成「离上次记过去了几轮」：装上/升级后最多再等 every 轮就记第一句。
 */
export async function hearMark(root = rootDir(), { turns = null } = {}) {
  try {
    const saved = (await readJson(homeFile(root), null)) ?? {}
    const mark = Math.max(0, Number(saved.hearAt ?? 0))
    // issue #60 / PR #71 的自愈：`hearAt` 记的是 `turns` 数到几，正常只会比轮次小。
    // 比轮次还大只有两种来历：升级前已经卡住的安装（旧版换会话继承了 39），
    // 或者两条结账路径并发时旧轮次晚到、把 `hearAt` 写回去。这时按 0 算，
    // 否则 `turns - hearAt` 永远追不上 `every`，旁听从此再不响。
    // 只拿传进来的轮次比会误伤另一种并发：第 11 轮先记了、第 10 轮后到，
    // 所以轮次取 home.json 里的 `turns` 和传进来的那个里大的一个。
    if (turns !== null && Number.isFinite(Number(turns))) {
      const homeTurns = Math.max(0, Number(saved.turns ?? 0))
      const at = Math.max(homeTurns, Number(turns))
      if (mark > at) return 0
    }
    return mark
  } catch {
    return 0
  }
}

/** 记下旁听落在第几轮。失败不抛，最多让下一轮再记一次。 */
export async function setHearMark(root = rootDir(), turns = 0) {
  try {
    return await mutateHome(async () => {
      const saved = await readJson(homeFile(root), null)
      // 屋子还没建起来（home.json 不存在）就先不写：别为了记个轮次抢先建出一份空档子。
      if (!saved || typeof saved !== 'object') return false
      await writeAtomic(homeFile(root), JSON.stringify({ ...saved, hearAt: Math.max(0, Number(turns || 0)) }, null, 2))
      return true
    })
  } catch {
    return false
  }
}

/** 记一轮对话。任何失败都不影响对话本身，所以永不抛。 */
export async function bumpTurns(root = rootDir(), delta = 1, now = Date.now()) {
  try {
    return await mutateHome(async () => {
      const saved = (await readJson(homeFile(root), null)) ?? {}
      const turns = Math.max(0, Number(saved.turns ?? 0) + Number(delta || 0))
      // 记下这一轮的说话时间，以及**上一轮**的时间（2026-11-15，用户 m00648）。
      // 换房要等「说完再换」，判据就是这两轮之间的间隔：prevTurnAt 是上一次计数轮，
      // lastTurnAt 是这一轮。写在一处，turns 结账与 /say 投递两条路都自动有。
      const at = Math.max(0, Number(now) || 0)
      const last = Math.max(0, Number(saved.lastTurnAt ?? 0))
      const next = { ...saved, turns, lastTurnAt: at }
      if (last > 0) next.prevTurnAt = last
      await writeAtomic(homeFile(root), JSON.stringify(next, null, 2))
      return turns
    })
  } catch {
    return 0
  }
}

/** 轮数满了之后，还要等多久的停顿才算「说完」（2026-11-15，用户 m00648）。 */
export const ROTATE_PAUSE_MS = 20 * 60_000
/** 一直连着聊时最多再延几轮，到点强制换（同上）。 */
export const ROTATE_GRACE_TURNS = 10

/**
 * 轮数满了，现在该不该换房。
 *
 * 用户 m00648 的原话：「轮数满了之后先不换，等到出现一次停顿（比如 20 分钟没说话）
 * 的第一轮再换；如果一直连着聊，最多再延 10 轮，到点强制换。这样换房总落在对话的
 * 自然缝隙里」。所以判据是**上一轮到这一轮的间隔**，不是轮数本身：
 *
 *   还没满 / 宽限用完（turns >= after + 10）      → 返回 null，照旧换
 *   上一轮就是几秒前（间隔 < 20 分钟）            → 返回 { waitMs, gap, graceLeft }，先不换
 *   没有上一轮的时间（刚建好的屋子、第一条计数轮）→ 返回 null，没有「连着聊」可等
 *   间隔 >= 20 分钟                               → 返回 null，这就是自然缝隙
 *
 * 只读，不改 home.json。失败按「不拦」处理：宁可早换，也不要卡在一个永远不换的屋子里。
 */
export async function rotationHold(root = rootDir(), opts = {}) {
  const after = Math.max(0, Number(opts.rotateAfter ?? 0))
  const turns = Math.max(0, Number(opts.turns ?? 0))
  if (!(after > 0) || turns < after) return null
  if (turns >= after + ROTATE_GRACE_TURNS) return null
  let saved = null
  try {
    saved = await readJson(homeFile(root), null)
  } catch {
    saved = null
  }
  const prev = Math.max(0, Number(saved?.prevTurnAt ?? 0))
  const last = Math.max(0, Number(saved?.lastTurnAt ?? 0))
  if (!(prev > 0) || !(last > 0)) return null
  const now = Number(opts.now ?? 0) || last
  // 停顿 = 上一轮到这一轮之间空出来的时间。调用点就在 bumpTurns 之后，
  // 所以 last 已经是这一轮，不能拿 now - last 当间隔；两者取大，
  // 是为了让「检查时已经过了很久」的情况也能算成停顿。
  const gap = Math.max(0, last - prev, now - last)
  if (gap >= ROTATE_PAUSE_MS) return null
  return { gap, waitMs: ROTATE_PAUSE_MS - gap, graceLeft: after + ROTATE_GRACE_TURNS - turns }
}

// ---------------------------------------------------------------------------
// 对话热窗（2026-11-15，用户 m00829）
//
// 定时唤醒只看「她是不是正在一轮里」（turn/start → turn/end，几秒钟）。两次消息
// 之间那段空档它看不见，于是落点经常正好卡在他俩对话的中间：她聊得好好的，突然
// 蹦出来一串提示词。主动搭话也一样——它的「安静多久」只认 heard（每 N 轮记一句），
// 把「记你原话」设成 0 就永远不重置。
//
// 判据跟换房同一份数据：home.json 的 lastTurnAt（每轮 bumpTurns 写的「他上一次说话」）。
// 距离现在不到 quietMin 分钟 = 他还在说，先别叫；下一拍再看，安静下来再叫。
// ---------------------------------------------------------------------------

/** 距上一次说话过了多久（毫秒）。没记过时间时返回 null。 */
export function quietGapOf(saved = {}, now = Date.now()) {
  const last = Math.max(0, Number(saved?.lastTurnAt ?? 0))
  if (!(last > 0)) return null
  return Math.max(0, Number(now) - last)
}

/**
 * 现在是不是还在「对话热窗」里。
 *
 * @param {number|null} gap       quietGapOf 的结果
 * @param {number} quietMin       热窗长度（分钟）；0/空 = 不拦
 * @returns {{gap:number, waitMs:number}|null} 非空 = 先别叫醒
 */
export function talkHot(gap, quietMin) {
  const m = Number(quietMin)
  if (!Number.isFinite(m) || m <= 0) return null
  if (gap === null || gap === undefined) return null
  const hold = m * 60_000
  const g = Math.max(0, Number(gap) || 0)
  if (g >= hold) return null
  return { gap: g, waitMs: hold - g }
}

/** 读 home.json 算一次热窗判断。读失败按「不拦」处理。 */
export async function hotTalk(root = rootDir(), opts = {}) {
  let saved = null
  try {
    saved = await readJson(homeFile(root), null)
  } catch {
    saved = null
  }
  return talkHot(quietGapOf(saved, opts.now ?? Date.now()), opts.quietMin)
}

/**
 * 叫醒之后隔多久回头确认一声（0.8.7，用户 m01775）。
 *
 * 为什么要等：宿主的会话列表是它自己那一轮跑起来之后才更新的，
 * 刚 prompt 完立刻问，一定还查不到，白判一次「没落地」。
 * 为什么是 12 秒：一轮把她叫醒到她开始说话通常几秒内，
 * 这里只需要跨过「宿主把会话从 blank 翻成有内容」这个瞬间，不用等她说完整段。
 */
export const WAKE_VERIFY_MS = 12_000

/**
 * 正在复核的会话 id（2026-11-06 换房报告）。
 *
 * 换房、`/reset`、`/home/rebuild` 都会在叫醒后挂一次复核，12 秒后各自问一遍。
 * 同一批里挂两次，就会在这条新会话上连着叫两声——她那边看见的是两条「醒一醒」。
 * 复核自己也会再叫一次（force），所以「同一条正在复核」必须直接跳过。
 */
const verifying = new Set()

/**
 * 换会话失败之后多久再试（2026-11-06）。
 *
 * 结账那条路上每次人说话都会 bumpTurns，`turns` 到了线就试着换。换失败时
 * `turns` 不归零（这是对的：屋子确实还没换），于是下一轮又会试——宿主真
 * 建不出会话时就成了每回一句话都重试一次。这里记下失败的时刻，冷却期内
 * 直接跳过，不再打扰宿主，也不再往对话里发东西。
 */
export const ROTATE_RETRY_MS = 5 * 60_000

/**
 * 记一笔「这次没换成」。只写 home.json 的两个字段，任何失败都吞掉：
 * 记不下来顶多是下次不回退避，不能让记账本身把错误放大。
 */
async function noteRotateFail(root, why) {
  const at = new Date().toISOString()
  try {
    await mutateHome(async () => {
      const fresh = (await readJson(homeFile(root), null)) ?? {}
      await writeAtomic(
        homeFile(root),
        JSON.stringify({ ...fresh, rotateFailAt: at, rotateFailWhy: String(why ?? '').slice(0, 160) }, null, 2),
      )
    })
  } catch {
    /* 记不下来就算了 */
  }
}

// 同一个 root 只允许有一次「换房间」在飞（0.8.8 用户报的房间分裂）：
// `/say` 的结账与 turns 的结账是两条独立路径，都可能在满 rotateAfter 时触发。
// 没有互斥时各自 sc.create 一条新会话：侧栏多出一间同名空房，先建的那条
// 还可能已经跑了一轮，从此成了看不到的孤儿；两条入口也各记各的轮数。
// 进程内用这条 promise 链单飞；跨进程由 withFileLock + home.json 的 sessionId 比对兜住。
const rotateInflight = new Map()

/**
 * 换一个新会话：旧的改名留档，新的接管，原话搬过去。
 *
 * 0.8.8：并发调用合并成一次——后来者直接等前面那次的结果，不再各建一条。
 * `from` 是调用方这句话真正投递进去的那条会话 id；home.json 已经指向别的会话，
 * 说明另一条入口抢先换过了（或者人已经不在家记着的这条里说话），这次跳过不换。
 *
 * @returns {Promise<{ok:boolean, sessionId:string, old?:string, why?:string, skipped?:boolean}>}
 */
export async function rotateTalkSession(ctx, opts = {}) {
  const root = opts.root ?? rootDir()
  const key = String(root).toLowerCase()
  const flying = rotateInflight.get(key)
  if (flying) return flying
  const p = (async () => {
    try {
      const res = await withFileLock(
        sessionLockFile(root),
        () => rotateTalkSessionOnce(ctx, { ...opts, root }),
        opts.lockOpts,
      )
      if (res && res.locked === false) {
        // 另一个进程正在换：它换完会把 sessionId 写进 home.json，这里读一眼就跳过。
        const saved = await readJson(homeFile(root), null).catch(() => null)
        const sid = String(saved?.sessionId ?? '')
        const from = String(opts.from ?? '')
        if (sid && (!from || sid !== from)) {
          return { ok: true, sessionId: sid, old: String(saved?.rotatedFrom ?? ''), skipped: true, why: res.why }
        }
        return { ok: false, sessionId: '', why: res.why }
      }
      return res
    } catch (err) {
      return { ok: false, sessionId: '', why: `换会话的锁没拿到：${String(err?.message ?? err).slice(0, 120)}` }
    }
  })().finally(() => {
    if (rotateInflight.get(key) === p) rotateInflight.delete(key)
  })
  rotateInflight.set(key, p)
  return p
}

async function rotateTalkSessionOnce(ctx, { root = rootDir(), wsId, title = TITLE_SESSION, stamp, log, from = '' } = {}) {
  const sc = ctx.sessionController
  if (!sc?.create) return { ok: false, sessionId: '', why: '宿主没有会话服务' }

  const saved = (await readJson(homeFile(root), null)) ?? {}
  const wid = String(wsId ?? saved.wsId ?? '')
  if (!wid) return { ok: false, sessionId: '', why: '没有工作区 id' }

  const old = String(saved.sessionId ?? '')
  // 0.8.8：这条路径进来时屋子已经换过了（另一条入口抢先、或 concurrent 的
  // 第二次调用在单飞窗口之外到）——不要再建第二条。
  const fromId = String(from ?? '')
  if (fromId && old && fromId !== old) {
    log?.(`换会话跳过：这次要换的是 ${fromId}，屋子已经指向 ${old}`)
    return { ok: true, sessionId: old, old: String(saved.rotatedFrom ?? ''), skipped: true }
  }
  // 2026-11-06：建会话失败后冷却一段时间再试。
  // 不冷却的话，结账每轮都会走到这里：`turns` 没清零，下一轮结账又到点，
  // 于是每回一句话都重试一次（旧版还会每次都先问一遍「要不要留话」，见 2.5 步）。
  // 宿主建不出会话多半是这类问题要待一会儿才好，5 分钟够它缓过来，也不至于
  // 让屋子永远卡在旧会话里。
  const failAt = Date.parse(String(saved.rotateFailAt ?? ''))
  if (Number.isFinite(failAt) && Date.now() - failAt < ROTATE_RETRY_MS) {
    return {
      ok: false,
      sessionId: '',
      cooled: true,
      why: `上次没换成（${String(saved.rotateFailWhy ?? '原因不明').slice(0, 80)}），${Math.ceil((ROTATE_RETRY_MS - (Date.now() - failAt)) / 60_000)} 分钟后再试`,
    }
  }

  // 2026-11-03（issue #19）：原来 `new Date().toISOString().slice(0,10)` 取的是 **UTC 日期**，
  // 东八区晚上 8 点之后换会话，旧会话会被改名成「…·昨天的日期 之前」.
  // dateKey() 用的是 getFullYear/getMonth/getDate，本地钟。
  const when = stamp ?? dateKey()

  // 1) 旧会话改名留档。失败不影响后面（改不了名也还是那条会话）。
  if (old && typeof sc.rename === 'function') {
    await sc.rename({ sessionId: old, title: `${title}·${when} 之前` }).catch(() => {})
  }

  // 2) 建新的
  // 2026-11-19（外部用户反馈）：换房这条路以前只写 `{ workspaceId }`，新房间
  // 照宿主的**默认** preset 走。那位用户的默认是「PTC 极简」，换完房她只剩
  // 几件工具，连读文件都做不到——而启动/补建那条路（ensureTalkSessionOnce）
  // 一直按配置里的 preset 建。同一个插件不能两套口径：这里也按 `tools.preset`
  // 建，宿主不认就回落默认，并把「这次放宽了」写进日志。
  let preset = ''
  try {
    preset = String((await loadConfig(root))?.config?.tools?.preset ?? '')
  } catch { preset = '' }
  let sessionId = ''
  let presetUsed = ''
  try {
    const room = await createTalkSession(sc, { workspaceId: wid, preset, log })
    sessionId = room.sessionId
    presetUsed = room.preset
  } catch (err) {
    await noteRotateFail(root, `建会话失败：${String(err?.message ?? err).slice(0, 160)}`)
    return { ok: false, sessionId: '', why: `建会话失败：${String(err?.message ?? err).slice(0, 160)}` }
  }
  if (!sessionId) {
    await noteRotateFail(root, '宿主建了会话但没给 id')
    return { ok: false, sessionId: '', why: '宿主建了会话但没给 id' }
  }
  if (typeof sc.rename === 'function') await sc.rename({ sessionId, title }).catch(() => {})

  // 3) 原话搬运
  // 2026-10-31（issue #14 第二报）：这里以前是**整个覆盖写**，只留七个字段，
  // 于是 `preset` / `title` / `wokeFor` / `adoptedAt` 换一次会话全丢：
  //   - preset 丢了，下一次 ensureTalkSession 会以为她从没被限过权，用默认组合重建；
  //   - wokeFor 丢不丢都不影响（它是按 id 比的），保留即可。
  // 现在改成「先继承旧档，再盖掉该换的那几项」。status/archivedAt 必须删掉：
  // 新会话是活的，留着旧标记会让它被当成「他收起来了」。
  //
  // 2026-11-08（issue #60）：`hearAt` 恰恰**不能**继承。它记的是「上次旁听记在
  // 第几轮」，而新会话的 `turns` 从 0 重新数——照搬旧值 39，`turns - hearAt`
  // 永远是负数，旁听从此再也不响。轮数归零，这个标记就跟着归零。
  // 带几轮原话由设置页决定（chat.carry，2026-11-11 外部用户反馈；0 = 不带）。
  // 读配置失败就按默认 4——换会话本身不能因为一个设置读不出来而失败，
  // 而「少带几句」远比「这一轮换窗口直接报错」轻。
  const carryTurns = await carryTurnsFor(root)
  // 2026-11-15（用户 m01722）：不再拼「上次我们说到这」，改拼一页交接：
  // 最后两句原话 → 还挂着的事 → 再往前几轮。这页只在新房间他开口的第一轮出现，
  // 结账就撤（见 lib/handoff.js 与 turns.js 的 arm/disarm），不再常驻 8 轮。
  const carry = await buildHandoff(root, { turns: carryTurns })
  // 写之前**重读一次**：函数开头那份 saved 可能已经被结账 / 旁听记账改过了，
  // 拿旧快照整体覆盖会把它们刚写进去的字段抹掉（同样是上面那个读-改-写问题）。
  try {
    await mutateHome(async () => {
      const fresh = (await readJson(homeFile(root), null)) ?? saved
      const next = {
        ...fresh,
        wsId: wid,
        sessionId,
        title: fresh?.title || title,
        // 这一间实际是按哪套组合建的。继承旧值会把「上次用的 preset」当成
        // 「这次用上的」——宿主不认、回落默认时尤其要说实话。
        preset: presetUsed,
        createdAt: new Date().toISOString(),
        turns: 0,
        // issue #60：轮数从 0 起，旁听标记也必须从 0 起（继承旧值会永远追不上）
        hearAt: 0,
        pressureRoomIds: [...new Set([...(fresh?.pressureRoomIds ?? []), old, sessionId].filter(Boolean))],
        pressureRoomLinks: { ...fresh?.pressureRoomLinks, [sessionId]: old },
        rotatedFrom: old,
        // 对称记下这次建出来的那条（2026-11-13）。只记 rotatedFrom 时，
        // 「换房那一刻他还在旧窗口」这一支会把家认回旧会话，之后他搬进新房间，
        // 插件没有任何依据把家跟过去——自动醒就照着 home.json 叫回旧对话。
        rotatedTo: sessionId,
        rotatedAt: new Date().toISOString(),
        carry,
      }
      delete next.status
      delete next.archivedAt
      // 换成了，把上次失败的记账清掉（否则下一次到点时会被误判成还在冷却期）
      delete next.rotateFailAt
      delete next.rotateFailWhy
      // 2026-11-15（用户 m02909）：旧档案里可能还留着 0.8.7 起的 lastWords，
      // 那一版已经删掉了；留着它会让新房间读到一句不是这次说的「最后一句」。
      delete next.lastWords
      await writeAtomic(homeFile(root), JSON.stringify(next, null, 2))
    })
  } catch {
    /* 记不下来也只影响下次换会话时的续接，不影响这次对话 */
  }

  // 3.5) 先把身份文档换到这一间，再叫醒（2026-11-15）
  // 宿主的 system prompt 是每轮重新装配的，新会话第一个请求读的就是
  // `home/她的身份.md` 这份**派生文件**。以前这里直接往下叫醒——叫醒只发一句
  // prompt（见 wakeIfBlank），不碰文档，于是新房间的第一步读到的是上一间写的
  // 版本：「上一次换房间是昨天 19:32」，还带着上一间的东西。她照着这句把
  // 「刚才搬进来」记成了「昨天」，再写进事件流；而 system 消息一进历史就是永久的，
  // 后面文档换对了也改不回来（外部报告 dsh-fish-issue-rotate-selfdoc-stale）。
  // 刷新放在这里而不是两个调用方各补一句（turns.js / say.js 那两处都在
  // rotateTalkSession 返回**之后**才刷，对第一个请求来说已经晚了）。
  // 只刷一次、而且是在叫醒之前：刷完到这一轮结束之间 home.json 不再变，
  // 文档也就不会在她这一轮里中途换样（#110 那个形状）。
  // 动态 import：selfdoc.js 从本文件取 activeCarry，静态引会成环。
  // 写不出来只记一行：会话已经建好，下一次人说话照样能接上。
  try {
    const { refreshSelfDoc } = await import('./selfdoc.js')
    await refreshSelfDoc(root, { log })
  } catch (err) {
    log?.(`轮换后重写身份文档失败：${String(err?.message ?? err).slice(0, 140)}`)
  }

  // 4) 把新会话叫醒一下（issue #14 第二报，2026-10-31）
  // 宿主的侧栏规则是 `blank && id !== current → 不显示`，而插件用 API 建的会话
  // **永远不会被设成 current**。不叫这一声，新会话就是一条看不见的空白会话：
  // 人看不见它，就还在旧的那条里说话，turns 从此停在 0（rotation 之后不再结账）。
  // /reset 与「重新搭一间」早就这么做了（observe.js 里两处 wakeIfBlank），
  // 只有轮换这条路漏了，于是它俩好着、轮换坏着。
  // 放在 rotateTalkSession 里而不是两个调用方各写一遍：将来再多一条轮换入口也不会漏。
  // 唤醒失败只记一行：会话已经建好，下一次人说话照样能接上（见 adoptTalkSession）。
  try {
    // 2026-11-02（用户 m00324）：这条路是**换会话**，不是造新屋子。
    // 传 rotated:true 让触发语说「对话换了一条新的，屋子还是原来那间」，
    // 而不是「屋子刚建好」——后者会让她以为每 40 轮就变成新的一条鱼。
    const woke = await wakeIfBlank(ctx, { sessionId, root, log, freshOnly: true, rotated: true, verify: true })
    if (!woke.woke && woke.why) log?.(`轮换后没叫醒新会话：${woke.why}`)
    // 4.5) 叫了不等于叫醒（0.8.7，用户 m01775 那张截图里的第 4、5 条）
    // 宿主的 prompt 是「这一轮被收下了」就 resolve。可新会话是插件用 API 建的空白会话，
    // 它要真跑出一轮才会进宿主的会话列表；没跑成，它就一直是列表外的空白会话。
    // 而下一拍唤醒会走 ensureTalkSession()：工作区索引里没有这条，它就被判成"死的"，
    // 于是退回旧会话——人看到的正是「醒一醒还在旧对话里发」。
    // 更糟的是 wokeFor 已经写上，这一声再也不会重试。
    // 所以这里不能只发一次就走：过一会儿回头看一眼，没落地就 force 再叫一次。
    // 不能 await：她在写日记/翻旧账可能要几十秒，轮换不该陪等（调用方还在等着拿新 id）。
    void verifyWoke(ctx, { root, sessionId, log })
  } catch (err) {
    log?.(`轮换后唤醒失败：${String(err?.message ?? err).slice(0, 140)}`)
  }
  return { ok: true, sessionId, old, preset: presetUsed }
}

/**
 * 叫醒之后回头确认这一声真的落地了（0.8.7，用户 m01775）。
 *
 * 判据是宿主的会话列表：`sc.list()` 里有没有这一条。
 * 空白的新会话不在那个列表里（`wakeIfBlank` 的注释写过同一件事），
 * 一旦它真的跑出一轮，blank 被清掉，它就会出现在列表里。
 * 所以「列表里还是没有」= 这一声没落地，值得再叫一次。
 *
 * 为什么用 force：`wakeIfBlank` 靠 `wokeFor` 去重，而那里已经写上这条 id 了。
 * 不 force 的话第二声会被自己挡掉——这正是要修的那个死结。
 *
 * 只补一次，不递归：两次都失败就认了，下次开机 `bootstrapHome` 还会再走一遍。
 */
export async function verifyWoke(ctx, { root = '', sessionId = '', log, delayMs = WAKE_VERIFY_MS } = {}) {
  if (!sessionId) return { landed: false, rewoke: false }
  // 同一批只复核一次：换房与 /reset 两条路都会顺手挂复核，重复挂会在她那里
  // 变成两声「醒一醒」——那正是这段代码要防的事。
  if (verifying.has(String(sessionId))) return { landed: false, rewoke: false, skipped: true }
  verifying.add(String(sessionId))
  try {
    if (delayMs > 0) {
      await new Promise((ok) => {
        const t = setTimeout(ok, delayMs)
        t.unref?.()
      })
    }
    const sc = ctx?.get?.('sessionController') ?? ctx?.sessionController
    // 判据是 blank，不是「在不在列表里」：宿主的 list() 连空白会话一起推，
    // 在列表里只说明它被持久化了，说明不了它跑出过内容（详见 sessionRow 的注释）。
    // 老宿主不给 blank 字段时退回老判据——有这一行就当落地，宁可漏补一次。
    const row = await sessionRow(sc, sessionId)
    if (row.found && row.blank !== true) return { landed: true, rewoke: false }
    log?.(row.found
      ? `新会话 ${sessionId} 叫过一次还是空的（没跑出 turn），再叫一次`
      : `新会话 ${sessionId} 叫过一次还是不在宿主列表里，再叫一次`)
    const again = await wakeIfBlank(ctx, { sessionId, root, log, freshOnly: true, rotated: true, force: true })
    if (!again.woke && again.why) log?.(`再叫一次也没成：${again.why}`)
    return { landed: false, rewoke: again.woke === true }
  } catch (err) {
    log?.(`复核叫醒失败：${String(err?.message ?? err).slice(0, 140)}`)
    return { landed: false, rewoke: false }
  } finally {
    verifying.delete(String(sessionId))
  }
}

/**
 * 把屋子认回某条已有会话（issue #14 第二报，2026-10-31）。
 *
 * 用在「会话刚被换掉，人却还在换下来那条里说话」：
 * 那时候 home.json 已经指向新会话，于是 turns.js 的 sessionId 比对把所有
 * 真人消息都静默丢掉——不涨轮、不记原话、也不再轮换，面板永远停在 0 / N。
 *
 * 认回来是这里唯一说得通的做法：她住在哪条会话，应当以**人实际在哪条里说话**为准。
 * 反过来硬把新会话塞给他是做不到的（宿主不允许插件改 current）。
 *
 * 三件事要一起做：
 *   - 清掉 `rotatedFrom`：已经认回来了，它不再是「换下来那条」；
 *   - 清掉 `carry`：那段「上次说到这」本来就从这条会话里取的，再贴一遍等于重复；
 *   - 不碰 `turns`：轮数接着数，不因为他落回旧窗口就白送一段。
 * 失败只返回 false，下次说话再认一次。
 *
 * 2026-11-13（外部反馈：轮换后「家」停在旧会话，自动醒落回旧对话）：
 * 搬进的是**轮换建出来的那间**（`rotatedTo`）时上面三件事一条都不做——
 * 那段 carry 本来就是给它准备的；`rotatedFrom` / `rotatedTo` 也留着，
 * 他要是再回旧窗口，这一对还在，屋子能跟着人再搬一次。
 */
export async function adoptTalkSession(root = rootDir(), sessionId = '') {
  const sid = String(sessionId ?? '')
  if (!sid) return false
  try {
    return await mutateHome(async () => {
      const saved = (await readJson(homeFile(root), null)) ?? {}
      if (String(saved.sessionId ?? '') === sid) return true
      const next = { ...saved, sessionId: sid, adoptedAt: new Date().toISOString() }
      // 搬进的是轮换新开的那间：carry 是给它准备的，留着。
      // 其余情况（认回旧窗口）：它已经不是「换下来那条」，carry 也不该再粘一遍。
      if (String(saved.rotatedTo ?? '') !== sid) {
        delete next.rotatedFrom
        delete next.carry
      }
      delete next.status
      delete next.archivedAt
      await writeAtomic(homeFile(root), JSON.stringify(next, null, 2))
      return true
    })
  } catch {
    return false
  }
}

/**
 * 换会话后还要贴多久的「上次说到这」。
 * 太短：她还没来得及接上就没了；太长：那段话变成新的固定人设。
 * 三天或 8 轮，谁先到算谁。
 */
export const CARRY_DAYS = 3
export const CARRY_TURNS = 8

/**
 * 「换新会话带几轮原话」这一项读盘上的设置（2026-11-11）。
 *
 * 独立成函数是为了让失败有单一出口：读配置和 normalize 都可能抛，
 * 换会话是主流程，不能因为这个数读不出来就整趟失败。默认值取 TALK_KEEP，
 * 跟老版本写死的 4 一致——没设过的人升上来，行为一个字不变。
 */
async function carryTurnsFor(root) {
  try {
    const { config } = await loadConfig(root)
    const n = Number(config?.chat?.carry)
    return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : TALK_KEEP
  } catch {
    return TALK_KEEP
  }
}

export async function activeCarry(root = rootDir(), now = Date.now()) {
  const saved = (await readJson(homeFile(root), null)) ?? {}
  const text = String(saved.carry ?? '').trim()
  if (!text) return ''
  const at = Date.parse(saved.rotatedAt ?? '')
  if (!Number.isFinite(at)) return ''
  if (Number(saved.turns ?? 0) >= CARRY_TURNS) return ''
  if (now - at > CARRY_DAYS * 86_400_000) return ''
  return text
}

/**
 * 交接页的开关（2026-11-15，用户 m01722）。
 *
 * 用户的原话是「只能换房的时候出现一次，不能一直出现」。所以交接页不再是
 * 身份文档里的一段常驻文字（那是旧 carry 的做法），而是一页只在特定一步
 * 生效的东西：
 *   1. home.json 指的**就是**他正在说话的这条会话（不是别的房间）；
 *   2. 屏幕上还留着他换窗口前那一段（carry 非空；换完、他说完第一轮就清掉）；
 *   3. 这一轮是他开口的（叫醒那一轮不算——新房间还没见到人，先别自念）。
 *
 * 只要当前这一条会话对不上，就不打开：认回旧窗口、群里、别的 workspace
 * 都不该突然冒出一页「上次停在这」。
 */
export async function armHandoffFor(root = rootDir(), sessionId = '') {
  const sid = String(sessionId ?? '')
  if (!sid) return false
  try {
    const saved = (await readJson(homeFile(root), null)) ?? {}
    if (String(saved.sessionId ?? '') !== sid) return false
    if (!String(saved.carry ?? '').trim()) return false
    armHandoff(sid)
    return true
  } catch {
    return false
  }
}

/**
 * 他开口的那一轮结完，交接页就撤掉（用户：不能一直出现）。
 * 不清的话，下一次她再说话，身份文档里还会带上这一页。
 */
export async function clearHandoffCarry(root = rootDir()) {
  try {
    await mutateHome(async () => {
      const saved = (await readJson(homeFile(root), null)) ?? {}
      if (!('carry' in saved)) return
      const next = { ...saved }
      delete next.carry
      await writeAtomic(homeFile(root), JSON.stringify(next, null, 2))
    })
  } catch {
    /* 清不掉也不致命：下次换房会写新的 carry 覆盖它 */
  }
}
