/**
 * pocket.js —— 出门口袋（2026-10-28 用户 m01145 拍板的「干活模式」；0.6.16 从 observe.js 搬出来）
 *
 * 为什么要有它：她的白板与交接账本按**工作区**注入。只要出门的目标是
 * 一个真正的工作区，那些实现细节就会跟着记忆一起进她的会话——
 * 真机 5fd70849 那趟就是这么漏的。口袋是一个**从没写过记忆的空目录**，
 * 注入只剩骨架；她的身份、工具、网络都照常。
 *
 * 代价（写进 UI，不藏着）：沙箱的写权限跟工作区走，她在口袋里写不进
 * 工作区里的项目目录——要交付就从口袋搬。这条取舍无法两全。
 *
 * 为什么要单独一个文件（0.6.16）：这段之前埋在 observe.js 里，
 * 路由一测就带着整个宿主上下文；搬出来之后「登记失败仍能出门」这种判据
 * 才能用假 registry 直接测（用户 m01613 第⑤条）。
 */
import fs from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// 界面统一叫「工作园区」（2026-10-30 用户 m00650 第三版文案）；已经登记过的旧工作区
// 仍会显示成旧名字「出门口袋」——登记时按路径认，不按名字认，不影响复用。
export const POCKET_TITLE = '工作园区'

/** 口袋路径：配置 `outingPocket` 优先；缺省放用户目录下（ASCII，避开中文路径那条老坑）。 */
export function pocketDirPath(config) {
  const raw = String(config?.outingPocket ?? '').trim()
  if (raw) return raw
  return join(homedir(), 'outing-pocket')
}

/** 比对路径用：Windows 大小写不敏感。只比对，不做文件访问。 */
function pathKey(p) {
  const s = String(p ?? '')
    .split(String.fromCharCode(92)).join('/')
    .replace(/\/+$/, '')
  return process.platform === 'win32' ? s.toLowerCase() : s
}

/**
 * 名字对不上就改掉（2026-10-30 用户 m02411）。
 *
 * 已经登记过的口袋是 0.7.6 之前建的，标题还叫「出门口袋」；界面统一成
 * 「工作园区」之后，侧栏里那个旧名字就成了一处对不上的地方。宿主的改名入口
 * 在实体上（`ws.setTitle`），registry 自己没有 rename——`lib/home.js:74` 踩过同一个坑。
 * 失败只当没改，不挡任何事。
 */
async function retitle(entity, title) {
  if (!entity || String(entity.title ?? '') === title) return false
  if (typeof entity.setTitle !== 'function') return false
  try {
    await entity.setTitle(title)
    return true
  } catch {
    return false
  }
}

/**
 * 建好口袋目录，并登记成工作区（登记失败也能出门：`sc.create({ cwd })` 是退路）。
 * `registered:false` 时 UI 会写明——那时记忆分区可能落到「未知工作区」。
 *
 * @param {object} ctx    宿主 ctx（只用 `get('workspaceRegistry')`）
 * @param {string} root   她的屋子（保留参数：日志与将来可能的记忆分区要用）
 * @param {object} config 读好的配置
 * @returns {Promise<{ok:boolean, wsId:string, dir:string, registered:boolean, why?:string}>}
 */
export async function ensurePocket(ctx, root, config) {
  const dir = pocketDirPath(config)
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (err) {
    return { ok: false, why: `建口袋目录失败：${String(err?.message ?? err).slice(0, 140)}`, dir, wsId: '', registered: false }
  }
  let reg = null
  try { reg = ctx?.get?.('workspaceRegistry') ?? null } catch { reg = null }
  let wsId = ''
  let foundWs = null
  try {
    const list = typeof reg?.list === 'function' ? reg.list() : []
    const found = list.find((w) => w && pathKey(w.path) === pathKey(dir))
    foundWs = found ?? null
    wsId = String(found?.id ?? found?.workspaceId ?? '')
  } catch { /* 列不出来就试着建 */ }
  let retitled = false
  if (wsId) retitled = await retitle(foundWs, POCKET_TITLE)
  if (!wsId && typeof reg?.create === 'function') {
    try {
      const ws = await reg.create(dir, POCKET_TITLE)
      wsId = String(ws?.id ?? ws?.workspaceId ?? '')
    } catch (err) {
      return { ok: true, wsId: '', dir, registered: false, why: `登记工作区失败：${String(err?.message ?? err).slice(0, 120)}` }
    }
  }
  return { ok: true, wsId, dir, registered: Boolean(wsId), retitled }
}

/**
 * 只看不动：口袋现在登记成哪个工作区了？没登记过就返回空 id。
 * （启动时排序要用它——不能为了排序先把口袋目录和登记造出来。）
 *
 * @param {object} ctx
 * @param {object} config
 * @returns {{dir:string, wsId:string, registered:boolean}}
 */
export function findPocketWorkspace(ctx, config) {
  const dir = pocketDirPath(config)
  let reg = null
  try { reg = ctx?.get?.('workspaceRegistry') ?? null } catch { reg = null }
  let wsId = ''
  try {
    const list = typeof reg?.list === 'function' ? reg.list() : []
    const found = list.find((w) => w && pathKey(w.path) === pathKey(dir))
    wsId = String(found?.id ?? found?.workspaceId ?? '')
  } catch { /* 列不出来当没登记 */ }
  return { dir, wsId, registered: Boolean(wsId) }
}

/**
 * 把口袋排到她的家**下面**（2026-10-30 用户 m01078）。
 *
 * 为什么要这个：口袋是第一次出门时才建的，比她的家晚，却排在它上面——
 * 侧栏第一眼看到的是「出门口袋」，不是「大肥鱼的家」。用户要的顺序是
 * ①大肥鱼的家 ②出门口袋 ③之后才是宿主本来建的那些。
 *
 * 用宿主的正规入口 `workspaceRegistry.insertBefore(id, beforeId)`（把 id 插到
 * beforeId 之前；不传 beforeId = 挪到末尾），**不手改 workspace.json**——
 * 那份文件是宿主的内存态，手写会被下一次写盘覆盖。
 *
 * 幂等：已经在紧挨着的下一格就什么都不做。注册表没有 insertBefore（老宿主）
 * 或 id 不在表里时返回 `{ok:false}`，调用方只记一行日志，不挡任何事。
 *
 * @param {object} ctx
 * @param {{pocketWsId?:string, homeWsId?:string}} ids
 * @returns {Promise<{ok:boolean, moved:boolean, why?:string}>}
 */
export async function ensurePocketOrder(ctx, { pocketWsId = '', homeWsId = '' } = {}) {
  const pocket = String(pocketWsId ?? '')
  const home = String(homeWsId ?? '')
  if (!pocket || !home) return { ok: false, moved: false, why: '缺工作区 id' }
  if (pocket === home) return { ok: false, moved: false, why: '两个 id 是同一个' }
  let reg = null
  try { reg = ctx?.get?.('workspaceRegistry') ?? null } catch { reg = null }
  if (typeof reg?.list !== 'function') return { ok: false, moved: false, why: '宿主没有 workspaceRegistry' }
  let entities = []
  try {
    entities = reg.list()
  } catch (err) {
    return { ok: false, moved: false, why: `列不出来：${String(err?.message ?? err).slice(0, 100)}` }
  }
  const idOf = (w) => String(w?.id ?? w?.workspaceId ?? '')
  // 顺手改名（m02411）：老用户的口袋标题还叫「出门口袋」，启动时改成「工作园区」。
  const retitled = await retitle(entities.find((w) => idOf(w) === pocket), POCKET_TITLE)
  if (typeof reg.insertBefore !== 'function') return { ok: false, moved: false, retitled, why: '宿主没有 insertBefore' }
  const ids = entities.map(idOf).filter(Boolean)
  const at = ids.indexOf(home)
  if (at < 0) return { ok: false, moved: false, retitled, why: '表里找不到她的家' }
  const atPocket = ids.indexOf(pocket)
  if (atPocket < 0) return { ok: false, moved: false, retitled, why: '表里找不到口袋' }
  if (atPocket === at + 1) return { ok: true, moved: false, retitled }
  // 目标：插到「她的家」后面那一格之前；家是最后一位就挪到末尾。
  const anchor = ids.slice(at + 1).find((id) => id !== pocket)
  try {
    await reg.insertBefore(pocket, anchor)
    return { ok: true, moved: true, retitled }
  } catch (err) {
    return { ok: false, moved: false, retitled, why: `排序失败：${String(err?.message ?? err).slice(0, 120)}` }
  }
}
