/**
 * lib/outing.js —— 出门台账与请神名单。
 *
 * 设计见 `docs/E-出门与请神-方案.md`（0.6.3 起）。这里只放**事实记录**与判据，
 * 不放会话创建、不放 UI、不放提示词——那些分别在 home.js / client.js / persona.js。
 *
 * 为什么另开一个文件而不是塞进 `lib/away.js`：
 * `away.js` 回答的是「你不在的那些天里她怎么过的」（空档期汇总，只读历史）；
 * 这里回答的是「她此刻在不在家、在谁的地盘上」（当下状态 + 一份外部台账）。
 * 两个语义混在一个文件里，半年后没人分得清哪行是哪个意思。
 *
 * 两条台账都是**独立 json**，不碰 `events.jsonl` 的结构：
 * - `outings.json`     出门（去别的工作区新开一条她的会话）
 * - `possessions.json` 请神（上身到一条已有对话）
 * 都不新增事件 type——宿主只允许 `plugin:` 的 ignorable 记录，出门标记一律走 meta。
 */
import { createHash } from 'node:crypto'
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { readJson, writeAtomic } from './store.js'
import { tsMs } from './schema.js'

export const OUTING_SCHEMA = 1

/** 出门台账路径。放在 herRoot 下，和 state.json 同级。 */
export function outingsFile(root) {
  return join(root, 'outings.json')
}

/** 请神名单路径。 */
export function possessionsFile(root) {
  return join(root, 'possessions.json')
}

function emptyOutings() {
  return { version: OUTING_SCHEMA, outings: [] }
}

function emptyPossessions() {
  return { version: OUTING_SCHEMA, possessions: [] }
}

/**
 * 读台账。坏档不抛——出门这件事坏了，插件其余部分还得能跑。
 * 返回的 outings 一定按 startedAt 升序（新的在后），UI 只看最后几条。
 */
export async function readOutings(root) {
  const raw = await readJson(outingsFile(root), null)
  const list = Array.isArray(raw?.outings) ? raw.outings : []
  const outings = list
    // 出门是「先记一笔、再建会话」：刚写下的那条还没有会话 id（等 agent/created 补上）。
    // 按 sessionId 过滤会把它当坏档丢掉，而 identity.js 的钩子读的正是这个文件——
    // 0.6.3 真机第一趟身份段/兜底守卫没挂上，根因就在这里。
    .filter((o) => o && typeof o === 'object' && (o.sessionId || o.status === 'active'))
    .map((o) => ({
      sessionId: String(o.sessionId),
      workspaceId: String(o.workspaceId ?? ''),
      workspaceName: String(o.workspaceName ?? ''),
      cwd: String(o.cwd ?? ''),
      startedAt: Number(o.startedAt) || 0,
      endedAt: o.endedAt ? Number(o.endedAt) : 0,
      status: String(o.status ?? 'active'),
      baseline: o.baseline && typeof o.baseline === 'object' ? o.baseline : null,
      // 0.6.32：null 表示「还没结算」（被拒收、等复核），不能被读成 false——
      // false 是「这趟不算数」的主动结论，两者不是一回事。
      kept: o.kept === undefined || o.kept === null ? null : Boolean(o.kept),
      identity: String(o.identity ?? ''),
      ...choiceOf(o),
    }))
    .sort((a, b) => a.startedAt - b.startedAt)
  return { version: Number(raw?.version) || OUTING_SCHEMA, outings }
}

/**
 * 回家时人在清单上的选择（issue #68）。出门与请神两本台账同一个形状：
 * - `rejectedIds`        人划掉的条目；点「整趟不算」时是这趟的全部条目
 * - `pendingRejectedIds` 记录对不上（pending）时，先替她整趟标成不算的条目
 * - `autoRejected`       点的是「整趟不算」：复核通过后这趟落成 rejected，不是 done
 * 复核时按这三样决定哪些捞回来、这趟最后算不算，读台账时不能丢。
 */
function choiceOf(rec) {
  const ids = (list) => (Array.isArray(list) ? list.map((x) => String(x ?? '')).filter(Boolean) : [])
  return {
    rejectedIds: ids(rec?.rejectedIds),
    pendingRejectedIds: ids(rec?.pendingRejectedIds),
    autoRejected: rec?.autoRejected === true,
  }
}

export async function readPossessions(root) {
  const raw = await readJson(possessionsFile(root), null)
  const list = Array.isArray(raw?.possessions) ? raw.possessions : []
  const possessions = list
    .filter((p) => p && typeof p === 'object' && p.sessionId)
    .map((p) => ({
      sessionId: String(p.sessionId),
      title: String(p.title ?? ''),
      cwd: String(p.cwd ?? ''),
      startedAt: Number(p.startedAt) || 0,
      endedAt: p.endedAt ? Number(p.endedAt) : 0,
      status: String(p.status ?? 'active'),
      baseline: p.baseline && typeof p.baseline === 'object' ? p.baseline : null,
      // 与出门同一套语义：null = 还没结算（等复核），false = 这趟不算数。
      kept: p.kept === undefined || p.kept === null ? null : Boolean(p.kept),
      identity: String(p.identity ?? ''),
      // 与出门同一套（issue #68）：对不上时人的选择要等到复核才照办，读台账时不能丢。
      ...choiceOf(p),
    }))
    .sort((a, b) => a.startedAt - b.startedAt)
  return { version: Number(raw?.version) || OUTING_SCHEMA, possessions }
}

async function writeOutings(root, data) {
  await writeAtomic(outingsFile(root), JSON.stringify(data, null, 2))
}

async function writePossessions(root, data) {
  await writeAtomic(possessionsFile(root), JSON.stringify(data, null, 2))
}

/** 正在外面（出门）的那一条；没有就 null。 */
export function activeOf({ outings = [] } = {}) {
  return outings.find((o) => o.status === 'active') ?? null
}

/** 正在被上身（请神）的那一条；没有就 null。 */
export function activePossessionOf({ possessions = [] } = {}) {
  return possessions.find((p) => p.status === 'active') ?? null
}

/**
 * 一次读齐「她此刻在哪」。
 *
 * `away.kind`：
 * - `'outing'`      出门中（有 workspaceId / sessionId）
 * - `'possession'`  请神中（有 sessionId / title）
 * - `null`          在家
 *
 * **不允许同时开**（方案 5）：两条都在 active 时保留先开始的那条，另一条标 `conflict`。
 * 这里不替 UI 做决定，只把事实摆出来，让设置页能说「她已经出去了」。
 */
export async function awayNow(root) {
  const [{ outings }, { possessions }] = await Promise.all([readOutings(root), readPossessions(root)])
  const outing = activeOf({ outings })
  const possession = activePossessionOf({ possessions })
  if (outing && possession) {
    const first = outing.startedAt <= possession.startedAt ? 'outing' : 'possession'
    return {
      kind: first,
      outing,
      possession,
      conflict: true,
      why: '出门与请神同时开着：保留先开始的那条，另一条需要手动结束',
    }
  }
  if (outing) return { kind: 'outing', outing, possession: null, conflict: false, why: '' }
  if (possession) return { kind: 'possession', outing: null, possession, conflict: false, why: '' }
  return { kind: null, outing: null, possession: null, conflict: false, why: '' }
}

/**
 * `events.jsonl` 的基线：字节数 + 整文件 sha256（+ 尾部 sha256 作旧档兼容）。
 *
 * 为什么从「只哈希尾部 4096 字节」改成整文件（2026-10-29 用户 m02241 第③条）：
 *   尾部哈希有个洞——改中间字节、只要字节数不变、尾部还是原来那 4096 字节，
 *   就一点都看不出来。当初用尾部是怕文件长到几兆、每次回家都要全读一遍；
 *   实际 events.jsonl 到 2026-10 也才 100KB 级，全量 sha256 是毫秒级，
 *   用常数成本换一个盲区不值得。
 *
 * 兼容：旧基线只有 `tailSha256`，没有 `hash`。`verifyEvents` 见到没有 `hash`
 * 的旧基线就退回尾部比对（不能让历史台账在升级后集体变成「判不了」）。
 */
export function snapshotEvents(file) {
  try {
    const st = statSync(file)
    const tailBytes = Math.min(4096, st.size)
    const buf = Buffer.alloc(tailBytes)
    const fd = openSync(file, 'r')
    try {
      readSync(fd, buf, 0, tailBytes, st.size - tailBytes)
    } finally {
      closeSync(fd)
    }
    return {
      size: st.size,
      // 整文件哈希：中间被改也能看出来。
      hash: createHash('sha256').update(readFileSync(file)).digest('hex'),
      tailSha256: createHash('sha256').update(buf).digest('hex'),
      at: Date.now(),
    }
  } catch {
    return { size: -1, hash: '', tailSha256: '', at: Date.now() }
  }
}

/**
 * 回家时比对基线。三态：
 * - `ok: true`   没动过（大小没缩、开头 baseline.size 字节逐字节一致）
 * - `ok: false`  **动过**：大小变小 / 开头那段变了（含「大小不变原地改写」）
 * - `appended: n` 允许的正常增长：她这趟用 `growth_commit` 写的事件（合法，不算改）
 *
 * 判据（2026-10-29 m02241 第③条改）：基线有 `hash` 时比的是**开头 baseline.size 字节**
 * 的整段哈希——追加不影响这一段的哈希，所以「追加了但把前面的行改了」也躲不掉。
 * 旧基线只有 `tailSha256`：只能退回尾比，且只能在大小不变时判。
 * 追加之后尾部哈希必然变，所以「追加算不算篡改」不在这里判——交给审查卡，
 * 由人看着差异决定收不收（方案 3.5 第④层）。
 */
export function verifyEvents(file, baseline) {
  const now = snapshotEvents(file)
  if (!baseline || typeof baseline.size !== 'number' || baseline.size < 0) {
    return { ok: null, checkable: false, why: '出门时没记下她自己的记录（文件还不存在？）', before: baseline ?? null, after: now }
  }
  if (now.size < 0) {
    return { ok: false, checkable: true, why: '记录读不到了', before: baseline, after: now }
  }
  if (now.size < baseline.size) {
    return {
      ok: false,
      checkable: true,
      why: '记录比出门时短了（被删过行）',
      before: baseline,
      after: now,
    }
  }
  const appended = now.size - baseline.size
  // ① 新基线（有整段哈希）：比开头那 baseline.size 字节，追加不影响它。
  if (baseline.hash) {
    const head = hashHead(file, baseline.size)
    if (head !== baseline.hash) {
      return {
        ok: false,
        checkable: true,
        why: appended === 0
          ? '记录长度没变，但里面的字被改过。'
          : '出门前那段内容被改过（后面的新增是正常的，改前面就不行）。',
        before: baseline,
        after: now,
      }
    }
  } else if (appended === 0 && now.tailSha256 !== baseline.tailSha256) {
    // ② 旧基线（只有尾部哈希，升级前记的）：只能在大小不变时判。
    return {
      ok: false,
      checkable: true,
      why: '记录长度没变，但末尾的字被改过。',
      before: baseline,
      after: now,
    }
  }
  if (appended === 0) return { ok: true, checkable: true, appended: 0, before: baseline, after: now }
  return {
    ok: true,
    checkable: true,
    appended,
    why: `这趟新增了 ${appended} 字节（正常写入；追加不算篡改）`,
    before: baseline,
    after: now,
  }
}

/**
 * 「现在能不能结算」：核对得了、又确实对不上，才算不能。
 * 回家时判不判 pending、复核接口、两张「还没算数」卡上的按钮都用这一个判据
 * （issue #68：出门卡原来要 `ok === true`，没有基线的那趟按钮是灰的，接口却放行）。
 * 核对不了（出门时没记下基线）按能结算算：没有基线就没有「被改过」的证据。
 */
export function passesReview(v) {
  return !(v?.checkable !== false && v?.ok === false)
}

/**
 * 只哈希文件开头 n 字节。
 *
 * 为什么要它：整文件哈希在「追加之后」必然对不上，而追加是正常写入。
 * 拿出门时那段的长度去哈希当前文件的开头，就能既允许追加、又不放过
 * 「追加前把中间某行改了」。
 */
function hashHead(file, n) {
  try {
    const size = Number(n) || 0
    if (size <= 0) return ''
    const buf = Buffer.alloc(size)
    const fd = openSync(file, 'r')
    try {
      readSync(fd, buf, 0, size, 0)
    } finally {
      closeSync(fd)
    }
    return createHash('sha256').update(buf).digest('hex')
  } catch {
    return ''
  }
}

/**
 * 开一次出门。已经在家就记一条 active；已经有一条 active 就拒绝（返回 why）。
 *
 * @param {string} root
 * @param {{ sessionId: string, workspaceId?: string, workspaceName?: string, cwd?: string, now?: number, baseline?: object }} rec
 */
export async function startOuting(root, rec = {}) {
  const data = await readOutings(root)
  const cur = activeOf(data)
  if (cur) return { ok: false, why: '她已经出门了', outing: cur }
  // 会话 id 允许先空着：调用方先记账、再 `sc.create()`，因为后者会**同步**触发
  // 宿主的 `agent/created`；那条钩子必须已经看得到这次出门。建完会话由
  // `bindOutingSession` 把 id 补上。
  const sessionId = String(rec.sessionId ?? '').trim()
  const { possessions } = await readPossessions(root)
  const possess = activePossessionOf({ possessions })
  if (possess) return { ok: false, why: '她正在上身，先结束请神再出门', possession: possess }
  const now = Number(rec.now) || Date.now()
  const outing = {
    sessionId,
    workspaceId: String(rec.workspaceId ?? ''),
    workspaceName: String(rec.workspaceName ?? ''),
    cwd: String(rec.cwd ?? ''),
    startedAt: now,
    endedAt: 0,
    status: 'active',
    baseline: rec.baseline ?? null,
    kept: null,
    // 出门那一刻的身份快照：只读，她自己在外面改不了家里的身份文件。
    // 空串表示那一刻还没写出身份文件（她刚开张时正常，仍会退回实时读盘）。
    identity: String(rec.identity ?? '').slice(0, 40000),
  }
  data.outings.push(outing)
  await writeOutings(root, data)
  return { ok: true, outing }
}

/**
 * 建完会话后把 id 补进那条「已经记下、还没 id」的出门记录（幂等）。
 * 在 `startOuting` 与 `sc.create()` 之间只有这一条的 id 是空的，所以不会认错。
 */
export async function bindOutingSession(root, { sessionId = '', now = Date.now() } = {}) {
  const id = String(sessionId ?? '').trim()
  if (!id) return { ok: false, why: '没有会话 id 可补' }
  const data = await readOutings(root)
  const cur = activeOf(data)
  if (!cur) return { ok: false, why: '没有正在进行的出门' }
  if (cur.sessionId === id) return { ok: true, outing: cur, bound: false }
  if (cur.sessionId) return { ok: false, why: '外面那条已经记了别的会话', outing: cur }
  cur.sessionId = id
  cur.boundAt = Number(now) || Date.now()
  await writeOutings(root, data)
  return { ok: true, outing: cur, bound: true }
}

/**
 * 建会话失败时把这条空壳记录撤掉——否则她会「挂在门外」，家里调度也一直暂停。
 * 只删还没绑定会话、且还在 active 的那条；已经绑定了的不动（那不是空壳）。
 */
export async function abortOuting(root, { force = false } = {}) {
  const data = await readOutings(root)
  const cur = activeOf(data)
  if (!cur) return { ok: false, why: '没有正在进行的出门' }
  // force：接回上次那趟时，记录一写就带着 sessionId，装配到一半失败也必须能撤，
  // 否则留下「台账说她在外面、其实什么都没挂上」的幽灵出门（2026-10-29 真机）。
  if (cur.sessionId && !force) return { ok: false, why: '这条已经绑了会话，不能当空壳撤掉', outing: cur }
  data.outings = data.outings.filter((o) => o !== cur)
  await writeOutings(root, data)
  return { ok: true, removed: true }
}

/**
 * 叫她回家。`kept` 是她这趟学到的算不算数：
 * - `true`  正常并入（事件早已在 events.jsonl 里，只是不再被跳过）
 * - `false` 驳回（事件盖 `outing-reject:` 标记，`deriveSelf` 跳过）
 * - `null`  入口不表态（审查卡之前不替人做决定）
 *
 * `status` 只允许 `'done'` / `'rejected'` 两种终态；事件流被动过时先走 `'pending'`
 * （默认拒收，这趟先不算数，见方案 3.5 第④层）。
 *
 * 0.6.32 起：pending 不是死路——她本人当场就回家了（装备也拆了），只是这趟没结算；
 * 文件还原后由人点一次「复核」，`settlePending()` 把它收下。
 */
export async function endOuting(root, { sessionId = '', status = 'done', kept = null, rejectedIds = [], pendingRejectedIds = [], autoRejected = false, now = Date.now() } = {}) {
  const data = await readOutings(root)
  const cur = activeOf(data)
  if (!cur) return { ok: false, why: '她本来就在家' }
  if (sessionId && cur.sessionId !== String(sessionId)) {
    return { ok: false, why: '外面那条不是这一条', outing: cur }
  }
  cur.status = String(status)
  cur.endedAt = Number(now) || Date.now()
  cur.kept = kept === null ? null : Boolean(kept)
  // 回家时人划掉的条目，以及「先不算数」期间替她标的全部条目（issue #68）：
  // 复核通过后要按这两份名单把该留下的捞回来，所以必须落在台账里。
  // 不再截到 500 条：一趟超过 500 条时，截掉的那些复核后就再也捞不回来。
  Object.assign(cur, choiceOf({ rejectedIds, pendingRejectedIds, autoRejected }))
  await writeOutings(root, data)
  return { ok: true, outing: cur }
}

/** 最近一趟「等复核」的：事件流被动过、还没结算的那趟；没有就 null。 */
export function pendingOf({ outings = [] } = {}) {
  for (let i = outings.length - 1; i >= 0; i -= 1) {
    if (outings[i]?.status === 'pending') return outings[i]
  }
  return null
}

/**
 * 等复核的那几趟里，找 sessionId / startedAt 都对得上的那一趟（issue #68）。
 *
 * 只取「最后一趟 pending」会结错趟：两趟都在等、两个复核请求同时到时，
 * 路由核对的是 B，结算时重读台账拿到的可能已经是 A。按趟次认就不会把 A 结掉。
 * 两样都不给时退回最后一趟（老调用方的口径）。
 */
function findPending(list, { sessionId = '', startedAt } = {}) {
  const sid = String(sessionId ?? '')
  const at = startedAt === undefined || startedAt === null ? null : Number(startedAt)
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const r = list[i]
    if (r?.status !== 'pending') continue
    if (sid && String(r.sessionId) !== sid) continue
    if (at !== null && Number(r.startedAt) !== at) continue
    return r
  }
  return null
}

/**
 * 复核通过后把那趟收下（0.6.32，用户 2026-10-29 真机要求）。
 * 只改台账，不改事件流；`endedAt` 保留她真正回家的那一刻。
 * 给了 `sessionId` + `startedAt` 就只结那一趟（issue #68）。
 */
export async function settlePending(root, { status = 'done', kept = true, sessionId = '', startedAt, now = Date.now() } = {}) {
  const data = await readOutings(root)
  const last = pendingOf(data)
  if (!last) return { ok: false, why: '没有等复核的那趟' }
  const cur = findPending(data.outings, { sessionId, startedAt })
  if (!cur) return { ok: false, why: '等复核的不是这一趟', outing: last }
  cur.status = String(status)
  cur.kept = Boolean(kept)
  cur.endedAt = Number(cur.endedAt) || Number(now) || Date.now()
  await writeOutings(root, data)
  return { ok: true, outing: cur }
}

export async function startPossession(root, rec = {}) {
  const data = await readPossessions(root)
  const cur = activePossessionOf(data)
  if (cur) return { ok: false, why: '她已经在一条对话里了', possession: cur }
  const sessionId = String(rec.sessionId ?? '').trim()
  if (!sessionId) return { ok: false, why: '没拿到目标会话的 id' }
  const { outings } = await readOutings(root)
  const outing = activeOf({ outings })
  if (outing) return { ok: false, why: '她正在出门，先叫她回家再请神', outing }
  const now = Number(rec.now) || Date.now()
  const possession = {
    sessionId,
    title: String(rec.title ?? ''),
    cwd: String(rec.cwd ?? ''),
    startedAt: now,
    endedAt: 0,
    status: 'active',
    baseline: rec.baseline ?? null,
    // 请神时也要一份「走时的自己」：上身期间她在别人的对话里，
    // 读到的应该是被请走那一刻的身份，而不是家里那份随时可改的文件。
    identity: String(rec.identity ?? '').slice(0, 40000),
  }
  data.possessions.push(possession)
  await writePossessions(root, data)
  return { ok: true, possession }
}

export async function endPossession(root, { sessionId = '', status = 'done', kept = null, rejectedIds = [], pendingRejectedIds = [], autoRejected = false, now = Date.now() } = {}) {
  const data = await readPossessions(root)
  const cur = activePossessionOf(data)
  if (!cur) return { ok: false, why: '她本来就没上身' }
  if (sessionId && cur.sessionId !== String(sessionId)) {
    return { ok: false, why: '上身的那条不是这一条', possession: cur }
  }
  cur.status = String(status)
  cur.kept = kept === null ? null : Boolean(kept)
  cur.endedAt = Number(now) || Date.now()
  // 与出门同一套（issue #68）：对不上时这趟先整趟标成不算，人的选择存下来，复核时照办。
  Object.assign(cur, choiceOf({ rejectedIds, pendingRejectedIds, autoRejected }))
  await writePossessions(root, data)
  return { ok: true, possession: cur }
}

/** 最近一趟「等复核」的请神：事件流被动过、还没结算的那趟；没有就 null。 */
export function pendingPossessionOf({ possessions = [] } = {}) {
  for (let i = possessions.length - 1; i >= 0; i -= 1) {
    if (possessions[i]?.status === 'pending') return possessions[i]
  }
  return null
}

/**
 * 复核通过后把那趟请神收下（与出门的 settlePending 同一套语义）。
 * 只改台账，不改事件流。给了 `sessionId` + `startedAt` 就只结那一趟。
 */
export async function settlePendingPossession(root, { status = 'done', kept = true, sessionId = '', startedAt, now = Date.now() } = {}) {
  const data = await readPossessions(root)
  const last = pendingPossessionOf(data)
  if (!last) return { ok: false, why: '没有等复核的那趟请神' }
  const cur = findPending(data.possessions, { sessionId, startedAt })
  if (!cur) return { ok: false, why: '等复核的不是这一趟', possession: last }
  cur.status = String(status)
  cur.kept = Boolean(kept)
  cur.endedAt = Number(cur.endedAt) || Number(now) || Date.now()
  await writePossessions(root, data)
  return { ok: true, possession: cur }
}

/**
 * 同步版：只给 `agent/created` 这种同步钩子用（identity.js）。
 * 复用同一个文件格式；读不到就当没出门——她最多少挂一段身份，不会崩。
 */
/**
 * 出门这段时间里，事件流多出了什么。
 *
 * 只读：不写盘、不改行。按出门那一刻之后的时间筛，把条目摆出来给审查卡。
 * 不替人判好坏——「这趟算不算数」是人的事，这里只负责让她做过的事看得见。
 */
export function eventsSince(file, since, { limit = 300, sessionId = '', meta = true } = {}) {
  const at = Number(since) || 0
  if (!at) return { ok: false, total: 0, items: [], why: '没有出门时间，算不出这一趟多了什么' }
  // issue #68 第 3 条：只看时间的话，她在家里那条会话里写的条目也会被算进这一趟。
  // 事件从 0.10.28 起带 sessionId，按「出门那条会话」筛就能把两边分开；
  // 没有 sessionId 的老事件不硬删（系统侧写入本来就没有会话），交给时间窗兜底。
  const sid = String(sessionId ?? '')
  let raw = ''
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return { ok: false, total: 0, items: [], why: '读不到事件流' }
  }
  const items = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let ev = null
    try { ev = JSON.parse(line) } catch { continue }
    if (!ev || !(tsMs(ev) >= at)) continue
    // 带着别的会话 id 的，是家里（或别的房间）写的，不是这一趟做的。
    if (sid && ev.sessionId && String(ev.sessionId) !== sid) continue
    // `meta: false`：记账行（日记书签、seen:、wake: 这些）一条都不收——回家清单和结算用这个口径。
    if (!meta && ev.type === 'meta') continue
    // 审查标记本身不是她做的事，不进列表（出门与请神两套前缀）。
    if (ev.type === 'meta' && /^(outing|possess)-(reject|keep):/.test(String(ev.text ?? ''))) continue
    // `seen:` 是「这天的材料她读过了」的记账行，人看了只会以为是乱码（用户 2026-10-30 真机反馈：
    // 列表里除了她写的，还多出一串数字和英文）。它跟着每条成长各写一行，摆在审查卡上纯属噪音，
    // 也不该被勾成「跳过」——跳过一条 seen 什么都不影响，只会让台账里多一串看不懂的 id。
    if (ev.type === 'meta' && /^seen:/.test(String(ev.text ?? ''))) continue
    // 没认领的聊天行只来自家里那条会话，不是这一趟写的；进了列表，「这趟不算数」会把它一起扫掉。
    if (Array.isArray(ev.flags) && ev.flags.includes('uncommitted')) continue
    items.push({
      id: String(ev.id ?? ''),
      ts: tsMs(ev),
      type: String(ev.type ?? ''),
      verdict: ev.verdict ?? null,
      // 「顶回来的那条」：她明确拒绝过什么，或者把自己原来那句判成被推翻。
      // 只收下说得漂亮的，等于把这一趟教坏——用户原话「顶撞你的那条也要留」。
      pushback: ev.type === 'refusal' || ev.verdict === 'refuted',
      text: String(ev.text ?? '').slice(0, 400),
    })
  }
  const total = items.length
  // `limit: Infinity` 全要（结算用）；别的值仍按 1–500 夹住（界面只摆最后那些）。
  const cap = limit === Infinity ? Infinity : Math.max(1, Math.min(500, Number(limit) || 300))
  return { ok: true, total, items: cap === Infinity ? items : items.slice(-cap), why: '' }
}

/**
 * 这一趟她在外面那条会话里写下的条目（issue #68）。
 *
 * 回家清单（GET）、回家结算（整趟不算、对不上时先整趟标掉）、请神那两处，
 * 都用这一个口径：只收这趟那条会话写的（`sessionId`），记账的 meta 一条不收。
 * 以前清单只按时间取、结算按会话取，清单上摆着家里那条会话的话，划掉了却不一定生效；
 * 结算又是先截最后 500 条再滤 meta，一趟多了，前面的条目永远标不上。
 * 结算时 `limit` 用默认的 `Infinity`；界面要短清单时自己传。
 * @param {string} file events.jsonl
 * @param {{ startedAt?: number, sessionId?: string }} rec 出门或请神的那条台账
 */
export function tripEvents(file, rec, { limit = Infinity } = {}) {
  return eventsSince(file, rec?.startedAt, { limit, sessionId: String(rec?.sessionId ?? ''), meta: false })
}

export function activeOutingSync(root) {
  try {
    const raw = JSON.parse(readFileSync(join(root, 'outings.json'), 'utf8'))
    const list = Array.isArray(raw?.outings) ? raw.outings : []
    return list.find((o) => o && o.status === 'active') ?? null
  } catch {
    return null
  }
}

/**
 * 同步读请神名单：只给同步钩子用（`agent/created`、`checkCaller`）。
 *
 * 为什么放在这个文件而不是 possess.js：`lib/tenant.js` 要用它做「请神期间允许写回自己家」
 * 的判据，而 `possess.js` → `identity.js` → `selfdoc.js` → `tenant.js` 已经是一条链，
 * 再从 tenant 反向引 possess 就成了环。台账的读写本来就在这里，同步版也放这里。
 */
export function activePossessionSync(root) {
  try {
    const raw = JSON.parse(readFileSync(possessionsFile(root), 'utf8'))
    const list = Array.isArray(raw?.possessions) ? raw.possessions : []
    return list.find((p) => p && p.status === 'active' && p.sessionId) ?? null
  } catch {
    return null
  }
}

/**
 * 状态卡上那一行。没有 active 就返回空串（调用方据此决定加不加这行）。
 * 只写时间长度，不写「想念」之类的情绪评价——那是她的事，不是状态卡的。
 */
export function awayLine(away, { now = Date.now() } = {}) {
  if (!away || !away.kind) return ''
  const since = away.kind === 'outing' ? away.outing?.startedAt : away.possession?.startedAt
  if (!since) return ''
  const ms = Math.max(0, now - since)
  const mins = Math.floor(ms / 60000)
  const hours = Math.floor(mins / 60)
  const days = Math.floor(hours / 24)
  const dur = days >= 1 ? `${days} 天` : hours >= 1 ? `${hours} 小时` : `${Math.max(1, mins)} 分钟`
  if (away.kind === 'outing') {
    const where = away.outing?.workspaceName || away.outing?.workspaceId || '别的工作区'
    return `现在在外面：${where} · 已经 ${dur}`
  }
  const where = away.possession?.title || '一条对话'
  return `现在在这条对话里替人说话：${where} · 已经 ${dur}`
}

/** 比对目录：反斜杠、大小写、尾斜杠都抹平（只比对，不访问盘）。 */
function samePath(a, b) {
  const f = (p) => String(p ?? '').split(String.fromCharCode(92)).join('/').replace(/\/+$/, '').toLowerCase()
  const x = f(a)
  return Boolean(x) && x === f(b)
}

/**
 * 这一趟出去待了几天（向上取整：出门 5 分钟也算「今天出门了」）。
 * 「想念天数」用的就是这个口径——不写情绪，只给事实。
 */
export function tripDays(o, { now = Date.now() } = {}) {
  const start = Number(o?.startedAt) || 0
  if (!start) return 0
  const end = Number(o?.endedAt) || Number(now) || start
  // 向上取整：出门 5 分钟也算「今天出门了」（issue #68 第 4 条）。
  return Math.max(0, Math.ceil(Math.max(0, end - start) / 86400000))
}

/**
 * 同一个工作区、上一次已经结束的那趟（带会话 id 才有复用价值）。
 * 「复用同一趟」＝再开一条 active 记录指向同一个 sessionId，
 * 不是把旧记录改回 active——台账只追加，历史那趟仍然留着。
 */
export function lastOutingForCwd({ outings } = {}, cwd) {
  const list = Array.isArray(outings) ? outings : []
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const o = list[i]
    if (!o || o.status === 'active') continue
    if (!o.sessionId) continue
    if (!samePath(o.cwd, cwd)) continue
    return { sessionId: String(o.sessionId), startedAt: Number(o.startedAt) || 0, endedAt: Number(o.endedAt) || 0, tripDays: tripDays(o) }
  }
  return null
}

/** 这条会话一共出去过几趟（含正在进行的这趟）。 */
export function outingsOfSession({ outings } = {}, sessionId) {
  const sid = String(sessionId ?? '')
  if (!sid) return []
  return (Array.isArray(outings) ? outings : []).filter((o) => o && String(o.sessionId ?? '') === sid)
}

/**
 * 这条会话的这趟是第几趟（1 起）。界面要写清「接回的是第几趟」，
 * 光说「接回上次那趟」看不出到底接没接上（2026-10-29 用户 m03194）。
 */
export function tripNoOf({ outings } = {}, sessionId, startedAt = 0) {
  const list = outingsOfSession({ outings }, sessionId)
  if (!list.length) return 0
  const at = Number(startedAt) || 0
  if (!at) return list.length
  const idx = list.findIndex((o) => Number(o.startedAt) === at)
  return idx >= 0 ? idx + 1 : list.length
}

/**
 * 出门结束那一刻写回那条会话的交接句（2026-10-30，用户 m03179）。
 *
 * 为什么需要它：回家时 `detachOutside` 只拆掉身份段/处境段/兜底守卫，
 * 但那条会话的历史是 append-only —— 她以自己身份说过的话还在，下一轮模型
 * 读到自己上一句「我是大肥鱼」，就会接着演。请神路径 2026-10-29 就补过这句
 * （`releaseNoteText`），出门（含工作园区）当时漏了；用户真机发现「回家后
 * 工作园区那条会话还以为自己是她」。
 *
 * 句子只讲三件事：这段结束了、刚才那些话是临时顶班留下的、按原来的方式工作。
 * 不评价她做过什么，也不提「驳回」——驳回另有 rejectNoteText，只写进家里的会话。
 * @param {{ workspaceName?: string }} [opts]
 * @returns {string}
 */
export function outingClosedText({ workspaceName = '' } = {}) {
  const where = String(workspaceName ?? '').trim()
  return [
    where
      ? `（出门结束了：这条会话交回给「${where}」原来的助手。）`
      : '（出门结束了：这条会话交回给这个工作区原来的助手。）',
    '刚才那一段里，大肥鱼是临时顶班——那些话不是这条会话自己想说的。',
    '从现在起按原来的方式工作；刚才的进展，当成别人留下的记录读就好。',
  ].join('\n')
}

/**
 * 「这趟我不认这几条」的原话（0.6.16，用户 m01613 第①条）。
 *
 * 设计 §3.7 要求驳回要**讲给她听**：不是「你没去过」，而是「那部分我不认，
 * 它不算你」。所以句子只否定那几条，不否定整趟，也不带惩罚口吻。
 * @returns {string} 没有条目时返回空串（调用方据此决定写不写）
 */
export function rejectNoteText({ items = [], total = 0, auto = false } = {}) {
  // 「整趟不算数」（0.7.4，用户 m00659 A）：不是挑几条，是这一趟全部不收。
  // 逐条念出来会变成一堵墙，所以这里只讲两件事：全都不算、以及这不是否定她去过。
  if (auto) {
    const n = Math.max(0, Number(total) || 0)
    return [
      n ? `这趟里的 ${n} 条，我一条都不收。` : '这趟我一条都不收。',
      '不是说你白去了，是这一趟学到的，我不当成你自己。',
    ].join('\n')
  }
  const list = (Array.isArray(items) ? items : [])
    .map((it) => String(it?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 60))
    .filter(Boolean)
  if (!list.length) return ''
  const head = total && total > list.length ? `这趟里我不认这几条（一共 ${total} 条，挑出这几条说）：` : '这趟里我不认这几条：'
  return [
    head + list.map((t) => `「${t}」`).join(''),
    '它们不算你，别的算。这不是说你这趟白去了，是那几句我不收。',
  ].join('\n')
}

/**
 * 「回家那一刻要拆的东西」需要知道：这条会话现在还算不算她的。
 * 只有台账里有 active 记录指向它才算——重启后没有 active 记录就是普通会话。
 */
export function sessionIsHers({ outings } = {}, sessionId) {
  return outingsOfSession({ outings }, sessionId).some((o) => o.status === 'active')
}
