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
import { recentExchanges, renderCarry } from './talkmem.js'
// 只为了「换房间前她那句话」：从事件流里挑她这一轮说出口的话。
// inbox.js 只依赖 store/schema，不反向引 home，不成环。
import { newHerEventsSince } from './inbox.js'
import { freshWakeText } from './wakeconst.js'
import { dateKey } from './settings.js'
import { stripToolMarkup } from './markup.js'

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
  const next = {
    ...saved,
    wsId,
    sessionId,
    title: saved?.title || title,
    // 不复用旧会话的 createdAt：宽限期是「刚建出来的那条」用的，
    // 认来的这条按 sessionIds 判活就够了，不能因为借了别人的时间戳而享受宽限。
    createdAt: '',
    adoptedAt: new Date().toISOString(),
  }
  delete next.status
  delete next.archivedAt
  try {
    await writeAtomic(homeFile(root), JSON.stringify(next, null, 2))
    return { ...next, ok: true }
  } catch { return null }
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
  let created
  let presetUsed = ''
  const wantPreset = String(preset ?? '').trim()
  if (wantPreset) {
    try {
      created = await sc.create({ workspaceId: wsId, agentPreset: wantPreset })
      presetUsed = wantPreset
    } catch (err) {
      const why = String(err?.message ?? err).slice(0, 160)
      log?.(`受限 preset「${wantPreset}」没被接受（${why}），这次用默认组合建会话`)
      created = null
    }
  }
  try {
    if (!created) created = await sc.create({ workspaceId: wsId })
    const sessionId = String(created?.sessionId ?? created?.id ?? '')
    if (!sessionId) return { ok: false, why: '宿主建了会话但没给 id' }
    if (typeof sc.rename === 'function') {
      // 命名失败不影响功能：侧栏会显示默认标题，但会话本身是好的
      await sc.rename({ sessionId, title }).catch(() => {})
    }
    await writeAtomic(homeFile(root), JSON.stringify({ wsId, sessionId, title, preset: presetUsed, createdAt: new Date().toISOString() }, null, 2))
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
  return { ok: true, why: '', wsId: ws.wsId, sessionId: ses.sessionId, dir: ws.dir, reused: ses.reused, preset: ses.preset ?? '' }
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
 * 和 `turns` 同一个口径：换会话时两个一起归零（issue #60，见 rotateTalkSessionOnce）。
 *
 * 2026-10-31 修：以前 hear.js 用 `turns % every === 0` 判断到没到点，
 * 而 turns 是**从装插件那天起**的终身计数；旁听 0.8.0 才装上，装上时
 * turns 已经 4，下一次能整除要到第 6 轮——中间一直看着像「没生效」。
 * 改成「离上次记过去了几轮」：装上/升级后最多再等 every 轮就记第一句。
 *
 * 传了 `turns`（这一轮结账数到第几轮）时顺手自愈：hearAt 比 turns 大，就当这一段还没记过，
 * 返回 0。turns 只增，只在换会话时和 hearAt 一起归零，所以正常走不到这一步，走到了只有两种来历：
 *   - 0.8.4 起换会话时 hearAt 被原样继承（issue #60），升级前已经卡住的安装，home.json 里是
 *     「hearAt≈39、turns 不到 40」，不自愈的话升级后这一段还是一句不记，要等下一次换会话；
 *   - 两条结账路径（lib/turns.js、lib/say.js）并发：一条换完会话写了 hearAt:0，
 *     另一条拿着换之前的轮次随后 setHearMark，又写回一个比 turns 大的数。
 * 比的是 home.json 里的 turns 和传进来的 turns 取大的那个：另一条路径刚在更后面一轮记过时
 * （hearAt 等于 home.json 的 turns，比这一轮的 turns 大一点），不能当成卡住，否则会连记两句。
 */
export async function hearMark(root = rootDir(), { turns } = {}) {
  try {
    const saved = (await readJson(homeFile(root), null)) ?? {}
    const at = Math.max(0, Number(saved.hearAt ?? 0))
    if (turns === undefined) return at
    const now = Math.max(Number(saved.turns ?? 0) || 0, Number(turns) || 0)
    return at > now ? 0 : at
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
export async function bumpTurns(root = rootDir(), delta = 1) {
  try {
    return await mutateHome(async () => {
      const saved = (await readJson(homeFile(root), null)) ?? {}
      const turns = Math.max(0, Number(saved.turns ?? 0) + Number(delta || 0))
      await writeAtomic(homeFile(root), JSON.stringify({ ...saved, turns }, null, 2))
      return turns
    })
  } catch {
    return 0
  }
}

/**
 * 换房间之前问她的那句话（0.8.7，用户 m00998）。
 *
 * 措辞的三条讲究：
 *   - 「下一个房间」不是「以后的你」——后者会让她以为自己要被替换掉；
 *   - 「留什么都可以」后面紧跟「不想留就说不用」，把拒绝写成**正常选项**，
 *     不是需要理由的例外；
 *   - 不提"记忆""人格"这些词。她自己会不会留一句话，不该由我们命名。
 */
export const LAST_WORDS_ASK = [
  '（你在这个房间里已经说了不少话。屋子要换一间新的了——还是同一间屋子，只是对话重新开始。）',
  '想给下一个房间留一句话吗？留什么都可以。不想留就说「不用」。',
].join('\n')

/** 等她回这句话最多等多久。回不来就没这一节，不影响轮换。 */
export const LAST_WORDS_WAIT_MS = 60_000

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

/** 她说「不用」的各种说法。命中就当没留。 */
const DECLINE_RE = /^(不用|不想留|不想|不留|不了|算了|没事|没有|无|no|nope)[。.!！…\s]*$/i

/**
 * 从她这一轮说的话里挑出「留给下一个房间」的那一句。
 *
 * 为什么不整段照抄：她可能先解释一句再留话，也可能把前后文一起说了。
 * 留一句的语义是**一句**——整段搬过去，新房间里就成了上一轮对话的残片。
 * 取第一行非空的，去掉引号与列表符号，超长截断。
 */
export function pickLastWords(reply) {
  const raw = String(reply ?? '').trim()
  if (!raw) return ''
  for (const line of raw.split(/\r?\n/)) {
    const t = line.replace(/^[-*>・\s]+/, '').replace(/^「|」$/g, '').trim()
    if (!t) continue
    if (DECLINE_RE.test(t)) return ''
    return t.replace(/^「|」$/g, '').slice(0, 200)
  }
  return ''
}

/**
 * 问旧会话里的她留一句话，返回那句话（没留就是空串）。
 *
 * 为什么不从事件流里捞：她只是在对话里回一句、没调 growth_commit 时，
 * events.jsonl 里**没有**这条记录（`newHerEventsSince` 只认 HER_TYPES）。
 * 那句话是对话里说的话，就得从会话事件流里收——`assistant/message` 的
 * content 里挑 text 块，和 turns.js 收她这一轮说的话同一条路。
 *
 * 为什么自己写一份等 turn/end：`say.js` 里那份同名逻辑不能 import——
 * say.js 依赖 home.js，反过来引就成环了。这段只等一条 turn/end，
 * 十来行，重复一次比引一个环划算。
 *
 * 永不抛：轮换比这句话重要得多。
 */
async function askForLastWords(ctx, { sessionId, root, log } = {}) {
  const sc = ctx?.get?.('sessionController') ?? ctx?.sessionController
  if (!sessionId || typeof sc?.prompt !== 'function') return ''

  const say = []
  let off = null
  const stop = () => { if (off) { try { off() } catch { /* 已注销 */ } off = null } }
  try {
    off = ctx.on?.('session/event', (session, event) => {
      const id = String(session?.header?.id ?? session?.id ?? '')
      if (id !== String(sessionId)) return
      if (event?.type !== 'assistant/message') return
      const blocks = event?.data?.message?.content
      if (!Array.isArray(blocks)) return
      for (const b of blocks) {
        if (b?.type !== 'text' || !b.text) continue
        // 2026-11-04（issue #25）：同一份 assistant 正文里可能只剩工具调用标记，
        // 那种东西不能当成她留在上一个房间里的最后一句话。
        const t = stripToolMarkup(b.text)
        if (t) say.push(t)
      }
    })
  } catch { off = null }

  const ac = new AbortController()
  const kill = setTimeout(() => ac.abort(), LAST_WORDS_WAIT_MS + 15_000)
  kill.unref?.()
  try {
    // rpcId 带 `carry-` 前缀：classifyMessage 会把它判成 plugin，
    // 既不算「他来过」，也不进轮次（见 turns.js 的 PLUGIN_RPC）。
    await sc.prompt({
      requestId: `carry-ask-${Date.now()}`,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: LAST_WORDS_ASK }],
    }, ac.signal)
  } catch (err) {
    log?.(`问那句话没递进去：${String(err?.message ?? err).slice(0, 140)}`)
    stop()
    return ''
  } finally {
    clearTimeout(kill)
  }

  // 等这一轮跑完。等不到（宿主不给事件总线 / 超时）就用已经收到的部分——
  // 她已经说了，就不该因为没等到 turn/end 把话丢掉。
  await new Promise((resolve) => {
    let off2 = null
    const t = setTimeout(done, LAST_WORDS_WAIT_MS)
    t.unref?.()
    function done() {
      clearTimeout(t)
      if (off2) { try { off2() } catch { /* 已注销 */ } off2 = null }
      resolve()
    }
    try {
      off2 = ctx.on?.('session/event', (session, event) => {
        const id = String(session?.header?.id ?? session?.id ?? '')
        if (id !== String(sessionId)) return
        if (event?.type === 'turn/end') done()
      })
    } catch { done() }
    if (!off2) done()
  })

  stop()
  return pickLastWords(say.join('\n'))
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
  let sessionId = ''
  try {
    const created = await sc.create({ workspaceId: wid })
    sessionId = String(created?.sessionId ?? created?.id ?? '')
  } catch (err) {
    await noteRotateFail(root, `建会话失败：${String(err?.message ?? err).slice(0, 160)}`)
    return { ok: false, sessionId: '', why: `建会话失败：${String(err?.message ?? err).slice(0, 160)}` }
  }
  if (!sessionId) {
    await noteRotateFail(root, '宿主建了会话但没给 id')
    return { ok: false, sessionId: '', why: '宿主建了会话但没给 id' }
  }
  if (typeof sc.rename === 'function') await sc.rename({ sessionId, title }).catch(() => {})

  /**
   * 2.5) 换房间之前，先请旧会话里的她自己留一句话（0.8.7，用户 m00998）。
   *
   * 为什么要这一句：轮换之后新会话拿到的身份文档里全是**结论**，没有一句是
   * 「上一个房间里的我留下的」。于是她读到旧日记会说「像另一个人写的」。
   * 一句原话解决的不是记忆问题（原文一直都在），是**归属**问题——
   * 「那是你说的」这句话只有她本人说出来才算数。
   *
   * **为什么放在建会话成功之后**（2026-11-06 修）：这句话是往她正在用的那条
   * 会话里发一条 prompt，会作为一条消息直接出现在他的对话窗口里。原来写在
   * 第 0 步（建会话之前），于是只要 `sc.create()` 抛错/不回 id，这一问就已经
   * 发出去了、轮换却失败了，`turns` 也不清零——下一轮结账又到点、又问一遍，
   * 他那边就变成「每次她回完都弹这一句」。挪到建会话成功之后，换不成就不问。
   *
   * **只把话发出去，不等她回**。轮换比这句话重要得多：
   * 上一版是 `await askForLastWords(...)`，宿主不派 `turn/end` 时会一直等到
   * 60 秒超时，把整个轮换（以及叫醒新会话）全卡住。所以这里只拿到一个
   * Promise，写 home 照常往下走；等这句话回来了再补写进 home.json 并刷一次
   * 身份文档（她那一下的人设段是新房间里第一次读到的）。
   *
   * 三个约束：
   *   - 失败绝不影响轮换：没有 prompt / 超时 / 她说「不用」都只是没有这一节；
   *   - 用 askForLastWords 里那条带 `carry-` 前缀的 rpcId 发出去，classifyMessage
   *     会把它判成 plugin，不算「他来过」，也不进轮次；
   *   - 只问一次，不追问。她不想留就是不想留。
   */
  let pendingWords = null
  try {
    pendingWords = askForLastWords(ctx, { sessionId: old, root, log })
    // 立刻吞掉可能的 rejection，免得变成 unhandledRejection
    if (pendingWords && typeof pendingWords.catch === 'function') pendingWords.catch(() => '')
  } catch (err) {
    log?.(`换房间前那句话没问成：${String(err?.message ?? err).slice(0, 140)}`)
    pendingWords = null
  }

  // 3) 原话搬运
  // 2026-10-31（issue #14 第二报）：这里以前是**整个覆盖写**，只留七个字段，
  // 于是 `preset` / `title` / `wokeFor` / `hearAt` / `adoptedAt` 换一次会话全丢：
  //   - preset 丢了，下一次 ensureTalkSession 会以为她从没被限过权，用默认组合重建；
  //   - wokeFor 丢不丢都不影响（它是按 id 比的），保留即可。
  // 现在改成「先继承旧档，再盖掉该换的那几项」。status/archivedAt 必须删掉：
  // 新会话是活的，留着旧标记会让它被当成「他收起来了」。
  //
  // hearAt 不在「要继承」那一边（issue #60 修正了上面这段原来的说法）：它记的是
  // 「上次旁听时 turns 数到几」，和 turns 同一个口径，turns 在这里归零，它就得跟着归零。
  // 以前以为留着它能防「换完连记好几句」，方向反了——hearTurn 一轮最多写一句，
  // 归零后新会话照样要数满 hearEvery 轮才记；留着它反而让 `turns - hearAt` 在新会话里
  // 多欠 hearAt 轮，默认 40 轮一换、hearAt 停在 39 时永远够不上，旁听从第一次换会话起就停了。
  // 升级前已经卡住的 home.json 不靠这里，靠 hearMark 读的时候自愈（hearAt 比 turns 大就按 0 算）。
  const carry = renderCarry(await recentExchanges(root))
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
        createdAt: new Date().toISOString(),
        turns: 0,
        hearAt: 0, // 跟 turns 同口径，一起归零（issue #60，见上面）
        rotatedFrom: old,
        rotatedAt: new Date().toISOString(),
        carry,
      }
      delete next.status
      delete next.archivedAt
      // 换成了，把上次失败的记账清掉（否则下一次到点时会被误判成还在冷却期）
      delete next.rotateFailAt
      delete next.rotateFailWhy
      // 0.8.7：这一轮先清掉旧的那句。她要是留了，后台回来之后再补写
      // （见下面 pendingWords.then）。留着上一轮那句会让新房间读到一句
      // 不是这次说的「最后一句」——比没有更糟。
      delete next.lastWords
      await writeAtomic(homeFile(root), JSON.stringify(next, null, 2))
    })
  } catch {
    /* 记不下来也只影响下次换会话时的续接，不影响这次对话 */
  }

  // 3.5) 她那句话回来了：写进 home.json 的 lastWords，并刷一次身份文档。
  // 不 await：轮换不等这句话。她回得慢就慢一点生效——新会话第一次读身份文档
  // 可能还没这句，第二次（下一轮说话前）一定有。
  if (pendingWords) {
    void pendingWords.then(async (words) => {
      const w = String(words ?? '').trim()
      if (!w) return
      try {
        await mutateHome(async () => {
          const fresh = (await readJson(homeFile(root), null)) ?? {}
          // 期间又轮换过一次：那句就不是「上一个房间」的了，丢掉。
          if (String(fresh?.rotatedFrom ?? '') !== old) return
          await writeAtomic(homeFile(root), JSON.stringify({ ...fresh, lastWords: w }, null, 2))
        })
        // 身份文档里那一段要在她下一次读之前就位
        const { refreshSelfDoc } = await import('./selfdoc.js')
        await refreshSelfDoc(root, { log }).catch(() => null)
      } catch (err) {
        log?.(`那句话没记上：${String(err?.message ?? err).slice(0, 140)}`)
      }
    }).catch(() => {})
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
  return { ok: true, sessionId, old }
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
 */
export async function adoptTalkSession(root = rootDir(), sessionId = '') {
  const sid = String(sessionId ?? '')
  if (!sid) return false
  try {
    return await mutateHome(async () => {
      const saved = (await readJson(homeFile(root), null)) ?? {}
      if (String(saved.sessionId ?? '') === sid) return true
      const next = { ...saved, sessionId: sid, adoptedAt: new Date().toISOString() }
      delete next.rotatedFrom
      delete next.carry
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
