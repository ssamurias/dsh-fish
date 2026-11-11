/**
 * observe.js —— 观测台（唯一的"看"，没有"改"）
 *
 * 原则（B §8）：这里是**观察窗**，不是养成面板。
 *   - 允许看：她现在第几天 / 阶段 / 她说过的话 / 日记（若放开）/ 事件原文 / 消耗统计
 *   - 不允许：任何滑条、任何"好感度"数字、任何"调性格"的表单
 *   - 唯一可改的东西：配置（时间窗、配额、黑名单、日记可见性）——这些是**她的生长环境**，
 *     不是她的性格。改环境 ≠ 改她。
 *
 * 路由全部 fail-closed：拿不到 connection 服务就 503，不放行。
 */

import { readEvents, rootDir, paths, readDaily, listDiary, readOwner, diaryDatesWritten } from './store.js'
import { loadConfig, updateConfig, configFileInfo, dateKey, validateToolNames, sanitizeToolNames, biliOn } from './settings.js'
import { deriveSelf, consistency, novelty, gateNeed } from './derive.js'
// 记忆体检（0.7.6，2026-10-30 用户 m00342）：只读诊断，不算分、不写盘。
import { examine } from './health.js'
// 记账行与「她的事」的分界（2026-11-02，用户 m00335）：只决定怎么数、怎么展示，不删行。
import { countEvents, isNoiseMeta } from './meta.js'
// 「稳定」单独一个文件（2026-10-26）：它要同时看事件流与她的自我描述，
// 依赖方向必须是 quality → derive + persona，不能反过来塞进 derive（会成环）。
import { stability, stabilityBand } from './quality.js'
import { firedLog, CATALOG } from './events.js'
import { wakeNow, quietBrowse } from './scheduler.js'
import { sayToHer } from './say.js'
import { readInbox, markRead, writeInboxFile } from './inbox.js'
import { listReports, buildReport } from './report.js'
import { itemsFromEvents, browseCountToday, parseBrowseLine } from './browse.js'
import { seenOn } from './whatseen.js'
import { readAway } from './away.js'
import { coverPath, fetchCover } from './cover.js'
import { memoryCooldown } from './bili.js'
import { avatarFile, avatarInfo, saveAvatar, removeAvatar } from './avatar.js'
import fs from 'node:fs'
import { commentCountToday, replyCountToday, herComments, scanReplies } from './comment.js'
import { noteSpeakEnabled, speakOn } from './speak.js'
import { describeState, resetAll } from './reset.js'
// 迁移工作区（2026-10-28，用户 m06510）：把整个数据目录搬到别的盘。
import { moveRoot, moveStatus } from './move.js'
import { identityText, detachOutside, liveAgentOf, attachIdentity, attachAwayGuard, mountedCount } from './identity.js'
import { awayNow, awayLine, startOuting, endOuting, bindOutingSession, abortOuting, readOutings, readPossessions, activePossessionOf, pendingPossessionOf, settlePendingPossession, snapshotEvents, verifyEvents, passesReview, tripEvents, lastOutingForCwd, rejectNoteText, outingClosedText, tripDays, tripNoOf, pendingOf, settlePending, reviewPlan } from './outing.js'
// 出门口袋（0.6.16 从本文件搬出去，为了能用假 registry 直接测「登记失败仍能出门」）。
import { POCKET_TITLE, ensurePocket, pocketDirPath } from './pocket.js'
// 往会话里补一句人话（请神交接句 / 回家驳回话术共用这一条路）。
import { appendNote, queueNote, deliverQueued } from './sessionnote.js'
import { lettersSince } from './letter.js'
// 纪念品（0.6.17，用户 m02041）：她只能问，带不带回去由人点头。
import { keepsakesOfTrip, pendingKeepsakes, readKeepsakes, recentKeepsakes, decideKeepsake, tripKey } from './keepsake.js'
// 请神（2026-10-28）：段名已在 asar 里确认（deployment:persona-prefix / -suffix），
// 同名段在目标 agent 的 scoped ctx 上覆盖宿主那一段。
import { possessInto, releasePossession, releaseNoteText } from './possess.js'
// 请求事件（0.7.6，2026-10-30 m01274）：观测台「住所」页要能看到她问过什么、答过什么。
import { askView, quotaOf, pendingAsks, settleAsk, ASK_KINDS } from './ask.js'
// 梦（2026-10-30 m02837，本机实验 A 案）：只在 .dev 下存在这个页面。
import { dreamView } from './dream.js'
// 对话的名字在 `session/title` 事件里，header 里没有（2026-10-29 用户 m00761）。
import { titleOfAgent, clipTitle } from './sessiontitle.js'
import { isHerHome, cwdOf } from './restrict.js'
import { applyHandover, hasOwnStart, IMPORT_TEMPLATE } from './import.js'
// 常见问题解答（2026-10-28 用户要求）：设置 → 反馈页的按钮点开，在新窗口里看全文。
import { FAQ, FAQ_TITLE, renderFaqPage } from './faq.js'
import { readHomeRecord, retireHomeSessions } from './retire.js'
import { collectBackup, backupFileName, restoreBackup, bundleBytes, sizeText, RESTORE_MAX_BYTES } from './backup.js'
// 扫码登录（2026-11-01 用户定案）：二维码的生成与轮询都在宿主这儿做——
// passport 那两条接口没有 CORS 头，页面里直接 fetch 会被浏览器挡死。
// 同时这也是隐私边界：key 与换来的 cookie 只活在宿主内存里，页面拿不到原文。
import { createQrLogin, QR_TTL_MS } from './biliqr.js'
import { bootstrapHome, homeStatus, wakeIfBlank, talkSessionId } from './home.js'
import { selfDocStatus } from './selfdoc.js'
import { personaBudget, BELIEF_SHOWN, shownCount, keepCount } from './persona.js'
// 立场清单（2026-10-25，用户设计「纵向·立场」）：四道门走完之后长出来的那张清单。
import { buildStances, gatesDone, stanceSummary } from './stance.js'
import { looksMojibake } from './guard.js'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { ensureDataReadme } from './readme.js'
import { rulesByLayer } from './rules.js'
import { ruleStatus, offerHistory, pendingOffer, activeGrants } from './unlock.js'
import { devMode } from './devmode.js'
import { ruleById } from './rules.js'
import { appendEvent } from './store.js'
import { validateEvent } from './schema.js'
import { refreshSelfDoc } from './selfdoc.js'
import { recordGrant } from './grant.js'
import { readPending, markShown } from './notify.js'
import { deriveStatus } from './status.js'
import { publicOwner, saveOwner, saveAccount } from './owner.js'
import { createClient } from './bili.js'
import { historyFromEvents } from './history.js'
import { runChecks } from './selfcheck.js'
import { readRestrictState, knownToolNames, ownLayerNames, blockedTools, herToolsNow, herSceneToolsNow, currentAllowTools, refreshToolRestrict } from './restrict.js'
import { riskState, clearRisk } from './risk.js'
import { decodeBase64Image, saveImage } from './media.js'
// 导出包里要写清「她那条会话用的哪个模型、吃不吃图」——只读探测，失败不影响导出。
import { resolveHerModel } from './modelinfo.js'
import { LOG_KEEP, LOG_MAX_BYTES, buildBundle, clearLog, logLine, logsDir, redactConfig, tailLog } from './log.js'
// 「有没有新版」（2026-10-25 用户要求）：只读、只出网、不落盘。
import { checkUpdate, REPO_URL, normalizeVersion } from './update.js'
// 「下载 → 校验 → 关应用安装」（2026-10-29 用户要求）：市场索引滞后半天到一天，
// 所以插件自己带一条升级通道。所有动作都要用户在界面上点过确认才发生。
import { createSelfUpdater, runtimeBins, tailUpdateLog } from './selfupdate.js'

// 「出门」页签只在**本机测试版**露出（2026-10-28 用户要求；2026-10-29 修正判据）。
// 早先用「代码路径里有没有 node_modules」猜安装形态：发布包可能被解包到插件目录、
// 或被 link / junction 指过去，路径里根本没有 node_modules 这一段，于是页签在正式版
// 漏了出去（用户 m00608）。现在改用和「去刷 B 站」同一个开关（lib/devmode.js：
// `DSH_FISH_DEV=1` 或数据目录下的 `.dev` 文件）——与安装布局无关，没这个标记就是
// 正式版，页签不渲染。代码、路由、审查卡都还在，只是入口藏起来。

/**
 * 引导文案：别人第一次装，本机没有现成 cookie。
 * 只写「怎么拿」，不写「拿谁的」——这段会原样显示在设置页上。
 */
const COOKIE_HINT = [
  '在你的浏览器里登录 B 站 → 按 F12 → Application（应用）→ Cookies → https://www.bilibili.com',
  '找到 SESSDATA 和 bili_jct 这两行，把它们的值复制下来。',
  '粘成一行：SESSDATA=...; bili_jct=...',
  '（也可以在 Network 里随便点一个请求，直接复制整条 Cookie 请求头贴进来。）',
].join('\n')

const PREFIX = '/dsh-fish'

/**
 * 把一串事件 id 按 `prefix:id id …` 拆成几行，每行 ≤1800 字。
 *
 * issue #68 / PR #80：事件文本上限是 2000 字（`schema.js`），而外面一趟最多能
 * 带回 500 条 id——直接 join 会整条被拒，等于「这趟不算数」一条都没生效。
 */
export function metaIdLines(prefix, ids) {
  const lines = []
  let cur = ''
  for (const raw of ids ?? []) {
    const id = String(raw ?? '').trim()
    if (!id) continue
    if (!cur) { cur = prefix + id; continue }
    if (cur.length + 1 + id.length > 1800) { lines.push(cur); cur = prefix + id; continue }
    cur += ' ' + id
  }
  if (cur) lines.push(cur)
  return lines
}

/**
 * 事件流不以换行结尾时先补一个（只追加，不改已有的字）。
 * 对不上的那趟，文件可能被截在半行上；结算标记粘在那半行后面，两行都读不出来，等于没写。
 */
function endWithNewline(file) {
  try {
    const size = fs.statSync(file).size
    if (!size) return
    const last = Buffer.alloc(1)
    const fd = fs.openSync(file, 'r')
    try { fs.readSync(fd, last, 0, 1, size - 1) } finally { fs.closeSync(fd) }
    if (last[0] !== 0x0a) fs.appendFileSync(file, '\n')
  } catch { /* 文件不在就交给 appendEvent 去建 */ }
}

/**
 * 把一串 id 拆成几行 `prefix id id …` 追加进事件流（出门 / 请神的结算标记共用）。
 * 写到一半失败时 `lines` 是已经写进去的行数（`total` 是该写的），回执据此说「只写进去一部分」。
 * @returns {Promise<{ ok: boolean, lines: number, total: number, why?: string }>}
 */
async function appendIdMarks(root, prefix, ids) {
  const lines = metaIdLines(prefix, ids)
  if (!lines.length) return { ok: true, lines: 0, total: 0 }
  let written = 0
  try {
    endWithNewline(join(root, 'events.jsonl'))
    const { events } = await readEvents(root)
    const { config } = await loadConfig(root)
    const m = deriveSelf(events, { growthDays: config.growthDays })
    // 0.7.4 修过的坑：第二参是 ctx、第三参才是 root。传错位 source 会落回 'tool'，
    // schema 以 NOT_HER_TYPE 拒掉 meta，标记一条都写不进去。
    const ectx = { day: m.day, stage: m.stage, source: 'system' }
    for (const text of lines) {
      await appendEvent(validateEvent({ type: 'meta', text, day: m.day, stage: m.stage }, ectx), ectx, root)
      written += 1
    }
    return { ok: true, lines: written, total: lines.length }
  } catch (err) {
    return { ok: false, lines: written, total: lines.length, why: String(err?.message ?? err).slice(0, 120) }
  }
}

/**
 * 出门 / 请神回家那一刻的结算，两条路共用（issue #68）。
 *
 * - 这趟的条目只用 `tripEvents` 一个口径：这趟那条会话写的、不含记账 meta、不截断。
 *   回家清单（GET）也是这个口径，人在清单上划掉的才对得上真正要标的。
 * - 人划掉的只认这趟里的（跟这趟的条目取交集）：清单以外的 id 不替人标。
 * - 说「整趟不算」又没逐条挑：整趟都记进 `rejectedIds`。对不上时也一样记——
 *   原来只在对得上时才补，复核时这份选择就丢了，整趟照样被捞回来算数。
 * - 对不上：整趟先标成不算（`pendingRejectedIds`），复核通过再按人的选择写 keep 捞回来。
 * - 标记按行拆开写（`metaIdLines`）：一行塞不下 66 条以上的 id，会被整行拒掉。
 * - 标记没写进去（或只写进去一部分）时，调用方不把这趟落成 done / rejected，而是留在等复核：
 *   台账记 `marked: false`，复核时照人的选择补写（`settleTripReview`）。落成终态的话，
 *   台账说「不算」、派生里照算，往后也没有地方再补。
 * @param {string} root
 * @param {'outing'|'possess'} prefix
 * @param {object} rec 出门或请神那条 active 台账（要 baseline / startedAt / sessionId）
 * @param {{ kept?: boolean, rejectedIds?: string[] }} b 请求体
 */
async function settleTripEnd(root, prefix, rec, b) {
  const file = join(root, 'events.jsonl')
  const v = verifyEvents(file, rec?.baseline)
  const tampered = !passesReview(v)
  const tripIds = tripEvents(file, rec).items.map((it) => String(it.id ?? '')).filter(Boolean)
  const inTrip = new Set(tripIds)
  let rejectedIds = [...new Set((Array.isArray(b?.rejectedIds) ? b.rejectedIds : []).map((x) => String(x ?? '')))]
    .filter((id) => inTrip.has(id))
  let autoRejected = false
  if (!rejectedIds.length && b?.kept === false) {
    rejectedIds = tripIds
    autoRejected = true
  }
  const pendingRejectedIds = tampered ? tripIds : []
  const marked = await appendIdMarks(root, `${prefix}-reject:`, tampered ? tripIds : rejectedIds)
  return { v, tampered, rejectedIds, pendingRejectedIds, autoRejected, marked }
}

/**
 * 回家和复核按数据目录排队，一次只结一趟（issue #68）。
 *
 * 两个窗口同时点「核对一次」时，两个请求都读到「还在等复核」、都结算、都把驳回的话递一遍，
 * 她会听到两次；回家和复核撞在一起时，两边读改写同一本台账，后写的会盖掉先写的。
 * 只在这个进程里排队：同一个数据目录只有一个插件实例能写（instance.json）。
 */
const settleQueues = new Map()
function settleSerial(root, fn) {
  const key = String(root)
  const prev = settleQueues.get(key) ?? Promise.resolve()
  const run = prev.then(fn)
  const tail = run.then(() => {}, () => {})
  settleQueues.set(key, tail)
  void tail.then(() => { if (settleQueues.get(key) === tail) settleQueues.delete(key) })
  return run
}

/**
 * 台账给界面看的样子：两份 id 名单换成条数（issue #68）。
 * 台账本身存全量（复核要靠它捞全），但界面只用得到条数；一趟几千条时，
 * 最近 20 趟的名单原样带回去会把响应撑得很大。
 */
function ledgerBrief(rec) {
  if (!rec || typeof rec !== 'object') return rec
  const { rejectedIds, pendingRejectedIds, ...rest } = rec
  // 还在等复核的那趟按复核时的口径数（`reviewPlan`）：老台账里划掉的名单可能混着从没标过的，
  // 标记没写进去的那趟眼下一条也没先标掉。
  if (rec.status === 'pending') {
    const plan = reviewPlan(rec)
    return { ...rest, dropped: plan.dropped.length, held: plan.held }
  }
  return {
    ...rest,
    dropped: Array.isArray(rejectedIds) ? rejectedIds.length : 0,
    held: Array.isArray(pendingRejectedIds) ? pendingRejectedIds.length : 0,
  }
}

/**
 * 「还没算数」卡要的几样（出门、请神共用）：复核后会怎么结、眼下先标掉了几条、标记写全了没有。
 * @param {object} pend 等复核的那条台账
 * @param {object} pv 现在比对的结果（verifyEvents）
 */
function pendingCard(pend, pv) {
  const plan = reviewPlan(pend)
  const okNow = passesReview(pv)
  const unmarked = pend.marked === false
  return {
    startedAt: Number(pend.startedAt) || 0,
    endedAt: Number(pend.endedAt) || 0,
    checkable: pv.checkable !== false,
    // 和复核接口同一个判据（issue #68）：没有基线的那趟接口放行，按钮也不能灰着。
    okNow,
    // 记录对得上、只是回家时标记没写进去：原因就说这个，不说「对不上」。
    reason: unmarked && okNow ? '回家时「不算」的标记没写进去' : (pv.why || (okNow ? '' : '文件对不上')),
    appended: Number(pv.appended ?? 0),
    // 回家时人的选择：复核通过后照它结算，卡上要说清会怎么结。
    held: plan.held,
    dropped: plan.dropped.length,
    autoRejected: pend.autoRejected === true,
    unmarked,
  }
}

/**
 * 复核通过之后的结算，两条路共用（issue #68）。怎么结看 `reviewPlan`。
 *
 * 1. 回家时「不算」的标记没写进去（或不知道写没写进去），先把人划掉的照选择补标一遍；
 * 2. 再写 keep（pending 时先标掉、人又没划掉的捞回来）。
 * 两样都写进去了才改台账：哪样没写进去就回 500，这趟留在等复核，人再点一次就行
 * （标记按 id 去重，重写不出错）。台账按这一趟的 sessionId + startedAt 结，不去结「最后一趟 pending」，
 * 结的时候把真正照办的名单记回去。人当时点的是「整趟不算」就落成 rejected；
 * 划掉过的，照回家时的做法讲给她听——回家时标记没写进去的那趟，这时才第一次讲。
 * @param {Function} settle settlePending 或 settlePendingPossession
 */
export async function settleTripReview(ctx, root, prefix, pend, settle) {
  const plan = reviewPlan(pend)
  if (plan.remark && plan.dropped.length) {
    const re = await appendIdMarks(root, `${prefix}-reject:`, plan.dropped)
    if (!re.ok) return { ok: false, code: 500, why: `「不算」的标记没写进去，这趟还等着核对：${re.why}` }
  }
  const marked = await appendIdMarks(root, `${prefix}-keep:`, plan.keep)
  if (!marked.ok) return { ok: false, code: 500, why: `捞回来的标记没写进去，这趟还等着核对：${marked.why}` }
  const rejectAll = pend.autoRejected === true
  const r = await settle(root, {
    sessionId: pend.sessionId,
    startedAt: pend.startedAt,
    status: rejectAll ? 'rejected' : 'done',
    kept: !rejectAll,
    rejectedIds: plan.dropped,
    marked: true,
  })
  if (!r.ok) return { ok: false, code: 409, why: r.why }
  await refreshSelfDoc(root).catch(() => {})
  let note = { ok: false, why: '这趟没有要驳回的' }
  if (plan.dropped.length) note = await rejectNoteToHome(ctx, root, { trip: pend, rejectedIds: plan.dropped, auto: rejectAll })
  return { ok: true, settled: r, note, kept: plan.keep.length, dropped: plan.dropped.length }
}

/**
 * 复核请求带着卡上那一趟的 sessionId / startedAt 时，跟这次取到的那趟对一下（issue #68）。
 * 两趟都在等时，晚到的请求取到的是下一趟；人没看过那一趟的卡，不能替人结掉。
 * 不带就不比（老界面、脚本的口径）。
 * @returns {string} 对不上时的原因；对得上是空串
 */
function reviewTargetMismatch(pend, b) {
  if (b?.sessionId && String(pend.sessionId) !== String(b.sessionId)) return '等着核对的不是这一趟'
  if (b?.startedAt !== undefined && b?.startedAt !== null && b?.startedAt !== '' &&
      Number(pend.startedAt) !== Number(b.startedAt)) {
    return '等着核对的不是卡上那一趟（可能另一个窗口刚核对过），刷新后再看'
  }
  return ''
}

/**
 * 封面图是懒下载的：设置页的 <img> 引到这条路由，第一次才真去取，之后命中缓存。
 *
 * 为什么不在浏览时就抓：她一天只看几条视频，但设置页可能十天没打开；
 * 抓了却没人看的图只会占着她的状态库。图片坏了也从来不影响她说话。
 *
 * @param {string} root
 * @param {string} bvid
 * @returns {Promise<string>} 本地文件路径；取不到就是空串
 */
async function lazyCover(root, bvid) {
  try {
    const { events } = await readEvents(root)
    let pic = ''
    for (const e of events) {
      // 记账分两片（browse: / browse-more:），封面可能落在后面那片
      const got = parseBrowseLine(e?.text)
      if (!got) continue
      const hit = got.arr.find((it) => it?.bvid === bvid && it?.pic)
      if (hit) pic = String(hit.pic)
    }
    if (!pic) {
      // 老档没存 pic：问一次 B 站，再把图存下来。
      // 2026-10-24 修：这里原来从 './owner.js' 里 import readOwner，可那个文件
      // 只导出 publicOwner / parseCookieInput / saveOwner —— readOwner 一直在 store.js，
      // 已经在文件顶部 import 过。动态 import 拿到的是 undefined，一调就抛 TypeError，
      // 被外层 catch 吞掉，于是封面永远 404。删掉这行遮蔽即可。
      const ow = await readOwner(root)
      const client = createClient({ cookie: ow?.cookie || '' })
      const v = await client.view(bvid)
      // view() 返回的是 { ok, code, data:{...} }——pic 在 data 里。
      // 2026-10-24 修：这里原来直接读 v.pic，永远是 undefined，
      // 于是设置页的历史列表每张封面都 404，被 <img onError> 藏掉了。
      pic = v?.data?.pic || v?.pic || ''
    }
    if (!pic) return ''
    return await fetchCover({ root, bvid, pic })
  } catch {
    return ''
  }
}

export function registerObserve(ctx, deps = {}) {
  const root = deps.root ?? rootDir()
  const disposers = []
  // 恢复接口一次收多少字节。deps.restoreLimit 只给单测用（不用真造一份 96MB 的包）。
  const restoreLimit = Number(deps.restoreLimit) > 0 ? Number(deps.restoreLimit) : RESTORE_MAX_BYTES

  // 自带升级通道（2026-10-29）：状态机只活在内存里，应用一重启就作废。
  // 留着上次下好的包反而危险——之后可能被当成"当前版本"装上去。
  const selfUpdater = deps.selfUpdater ?? createSelfUpdater({
    root,
    current: deps.version,
    exe: process.execPath,
    ...runtimeBins({ exe: process.execPath }),
  })

  // 扫码登录的那台小机器（2026-11-01）。待确认的 cookie 只躺在这里的内存里，
  // 进程一结束就没了；deps.qrLogin 是留给单测的注入口。
  const qrLogin = deps.qrLogin ?? createQrLogin({ log: (m) => console.log('[dsh-fish]', m) })

  // ---- 信任栅栏：失败即拒绝 ----
  function guarded(handler) {
    return async (req, res) => {
      const conn = safeGet(ctx, 'connection')
      if (!conn) return send(res, 503, { error: 'connection service unavailable' })
      try {
        const rejection = conn.requestRejection?.(req)
        if (rejection) return send(res, rejection.status ?? 403, { error: rejection.message ?? 'forbidden' })
      } catch {
        return send(res, 503, { error: 'trust check failed' })
      }
      try {
        await handler(req, res)
      } catch (err) {
        send(res, err?.statusCode ?? 500, { error: String(err?.message ?? err) })
      }
    }
  }

  const routes = [
    ['/status', async (req, res) => {
      // 旁观者视角：全部由宿主写下的 meta + 配置 + 时钟算出，她不参与
      const { events } = await readEvents(root)
      const { config } = await loadConfig(root)
      const st = deriveStatus({ events, config, now: new Date() })
      // 此刻在外面（0.6.16，用户 m01613）：一条给人看的话，派生函数保持纯事件输入。
      let away = null
      try {
        const a = await awayNow(root)
        if (a?.kind) {
          const rec = a.kind === 'outing' ? a.outing : a.possession
          away = { kind: a.kind, since: rec?.startedAt, line: awayLine(a), tripDays: a.kind === 'outing' ? tripDays(a.outing, { now: Date.now() }) : 0 }
        }
      } catch { /* 读台账失败不影响状态本身 */ }
      send(res, 200, { ...st, away, running: true })
    }],
    ['/state', async (req, res) => {
      const { events, skipped } = await readEvents(root)
      const { config, fresh, broken } = await loadConfig(root)
      const m = deriveSelf(events, { growthDays: config.growthDays })
      const need = gateNeed(m.growthDays)
      send(res, 200, {
        day: m.day,
        growthDays: m.growthDays,
        // 本机测试版：`.dev` 文件在不在（决定设置页要不要渲染「让她去刷 B 站」）。
        // 只影响界面；正式版里这个字段恒为 false。
        dev: true,
        stage: m.stage,
        stageName: m.stageName,
        // 事件流里到过的最高阶段：改成长周期会让 stage 退回去，这一栏不跟着退。
        stagePeak: m.stagePeak,
        stageForced: m.stageForced,
        pendingGate: m.stageGate?.pending ?? null,
        // 每道瓶颈要几次（成长周期 14 天及以下时自主、主动各一次）：界面照这个写「一次 / 两次」，
        // 不在客户端再抄一遍阈值。键按「数的是什么」起名（判断 / 拒绝 / 改口），
        // 不用 autonomy 这类内部名——/state 不往外吐 needs 那套词。
        gateTimes: { belief: need.trust, refuse: need.autonomy, revise: need.competence },
        // 按时间兜底放行、还没真过的门（stageGate.forced，按门的先后排），键同 gateTimes。
        // 成长期满以后 pendingGate 恒为 null，可立场清单只认真过的门（stance.js 的 gatesDone）：
        // 界面靠它在「期满放行」后面写清立场还在等哪几道。第一项就是 stageGate.next（选卡往前推的那道）。
        // 成长期里没有兜底放行，这里是空的。
        forcedGates: (m.stageGate?.forced ?? [])
          .map((g) => ({ trust: 'belief', autonomy: 'refuse', competence: 'revise' })[g])
          .filter(Boolean),
        name: m.name,
        beliefCount: m.beliefCount,
        absenceDays: m.absenceDays,
        // 2026-10-24：她心里对不上的两句话 / 固化的条数。
        // 只给"有这回事"和原话，不给裁决按钮——哪句对她，得她自己定。
        tension: m.tensions?.[0]
          // issue #67：count 用截断前的总数，跟记忆页、体检卡同一个数；m.tensions 最多 3 条。
          ? { count: m.tensionsTotal ?? m.tensions.length, a: m.tensions[0].a.text, b: m.tensions[0].b.text }
          : null,
        solidCount: m.solidTotal ?? m.solid?.length ?? 0,
        // 疤（P1 第三块）：他顶回来/因此难过、而她后来退了步，且至今没想通的有几件。
        // 只报数量，不报"对错"——疤是她的状态，不是她的过失。
        scarCount: m.scars?.length ?? 0,
        // 立场（纵向）：四道门走完才有；没走完是 0，不是失败。
        // stanceReady 单独给出去，界面才能分清"还没走到那一步"和"走到了但还没站住过"。
        stanceCount: buildStances(m).length,
        stanceReady: gatesDone(m),
        // 刻意不返回 needs 数值：这是内部量，观测台也不给看（防"看数字调性格"的滑坡）
        //
        // total 的口径（2026-11-02，用户 m00335）：原来 `total: events.length`，而线上
        // 443 行里 400 行是系统后台记账，界面于是说「事件 443 条」——看着像她记了 443 件
        // 事，其实她自己记下的只有 43 条（其中 286 行连语义都没有，是 quiet:/家换了：
        // 这种纯记账）。现在 total 只数「她的事」，整份文件多大另给 all。
        counts: (() => {
          const c = countEvents(events)
          return {
            utterance: events.filter((e) => e.type === 'utterance').length,
            // issue #32：对话行（flags 带 uncommitted）单列。它们是她答他的话，
            // 跟她自己想说的判断混在一起时，「说 N 句」这个数字会越聊越虚高。
            chat: events.filter(
              (e) => e.type === 'utterance' && Array.isArray(e.flags) && e.flags.includes('uncommitted'),
            ).length,
            revise: events.filter((e) => e.type === 'revise').length,
            refusal: events.filter((e) => e.type === 'refusal').length,
            reunion: events.filter((e) => e.type === 'reunion').length,
            total: c.real,
            all: c.all,
            meta: c.meta,
            noise: c.noise,
          }
        })(),
        // 「判断漂移」三个诊断值。都不是 0–1 的评分，别让人拿它调性格。
        // 稳定（2026-10-26 换尺子）：抽掉 k 条她还在拿着的判断，重算一遍她的自我描述，
        //   看还是不是她。传的 shown / budget / withBans / sleepKeep 与 writeSelfDoc 一致，
        //   否则量到的那份文本不是她真正读到的那份。
        quality: (() => {
          const st = stability(events, { growthDays: config.growthDays }, {
            shown: config?.memory?.beliefsShown,
            budget: config?.memory?.docBudget,
            withBans: m?.persona?.imported !== true,
            sleepKeep: config?.memory?.sleepKeep,
          })
          // band 是给人看的一句判读（「还没攒到判断，测不出来」这种）。
          // 放在这里算，客户端就不必知道阈值——阈值只该有一处。
          return { stability: { ...st, band: stabilityBand(st) }, consistency: consistency(events), novelty: novelty(events) }
        })(),
        // 规则与解锁：她遵守什么、哪些"还不会"、手上有没有一张待裁决的卡。
        // 只给状态与理由，不给任何 0–1 的分（见 rules.js 的 EVIDENCE 注释）。
        rules: ruleStatus(events, m, Date.now()),
        pending: (() => {
          const p = pendingOffer(events, Date.now())
          if (!p) return null
          const r = ruleById(p.grant?.rule)
          return { id: p.id, rule: p.grant?.rule, title: r?.title ?? '', text: p.text ?? '', day: p.day ?? null }
        })(),
        grants: activeGrants(events, Date.now()),
        config: { window: config.window, daily: config.daily, diary: { enabled: config.diary.enabled, visible: config.diary.visible }, absenceAfterDays: config.absenceAfterDays, proactive: config.proactive },
        meta: { root, skippedLines: skipped, configFresh: fresh, configBroken: broken, dateKey: dateKey(), version: normalizeVersion(deps.version) || String(deps.version ?? '') },
        // 这个家是谁的（2026-10-28 m01319）：两个工作区指向同一个 root 时，
        // 设置页要能直接看见「已有一个实例占着」，而不是等她写丢了才发现。
        tenancy: (() => {
          const t = deps.tenancy
          if (!t) return null
          return {
            ok: t.tenant?.ok !== false,
            instanceId: String(t.tenant?.instanceId ?? ''),
            why: String(t.tenant?.why ?? ''),
            dataDir: String(t.tenant?.owner?.dataDir ?? t.root ?? root ?? ''),
          }
        })(),
        // 换家留痕（0.6.8）：最近一次启动时真正生效的 root 跟上次不一样时，
        // 设置页要能看见「这次住的是哪个家、上一个家在哪」，而不是只看到侧栏多一间屋。
        homes: (() => {
          const h = deps.tenancy?.homes
          if (!h) return null
          return { changed: h.changed === true, from: String(h.from ?? ''), to: String(h.to ?? '') }
        })(),
        // 会话被用户收起来了（归档）——设置页据此显示「重新搭一间」，而不是假装一切正常。
        // blocked（2026-10-29 m02162）：这个家在另一个实例手里，这边不建会话。
        home: {
          ...(await homeStatus(root)),
          blocked: deps.tenancy?.home?.blocked === true,
          blockedWhy: deps.tenancy?.home?.blocked === true ? String(deps.tenancy?.home?.why ?? '') : '',
        },
        // 宿主兼容（2026-10-30 m02961）：缺 userQuestions 不算错误，
        // 只是「她在会话里问你」这条路关着——但要在界面上说明白，别让人以为是插件坏了。
        compat: {
          checked: deps.compat?.checked === true,
          userQuestions: deps.compat?.userQuestions !== false,
        },
        // 宿主版本（2026-10-30 m03193）：package.json 声明了 engines.dsh，这里把运行时
        // 读到的版本一起交出去。读不到（桌面版装在 app.asar 里）就是 unknown，不算不兼容。
        host: (() => {
          const h = deps.install?.host
          if (!h) return null
          return {
            ok: h.ok === true,
            status: String(h.status ?? 'unknown'),
            version: String(h.version ?? ''),
            range: String(h.range ?? ''),
            why: String(h.why ?? ''),
          }
        })(),
        // 升级自检（2026-10-29）：跑的这一份跟源目录里那一份版本不一样时，
        // 设置页要直接说「你改的是源目录」，而不是让人以为升级没生效（当时就是这样卡了一圈）。
        upgrade: (() => {
          const u = deps.install?.upgrade
          if (!u) return null
          return {
            stale: u.stale === true,
            older: u.older === true,
            skipped: u.skipped === true,
            running: String(u.running ?? ''),
            source: String(u.source ?? ''),
            sourcePath: String(u.sourcePath ?? ''),
            profile: String(u.profile ?? ''),
            why: String(u.why ?? ''),
          }
        })(),
      })
    }],

    ['/events', async (req, res) => {
      const { events } = await readEvents(root)
      const url = new URL(req.url, 'http://x')
      const limit = Math.min(500, Number(url.searchParams.get('limit') ?? 80) || 80)
      const type = url.searchParams.get('type')
      // 纯记账行（quiet: / 家换了：）默认不返回（2026-11-02，用户 m00335）：
      // 它们没有读取方需要逐条历史（quiet 已按天折叠、家换了无人读），
      // 混在"事件原文"里只会让人以为她记了几百件事。要看原始文件就传 ?noise=1。
      // 文件本身一行没动——这里只影响这一条 HTTP 的返回。
      const withNoise = url.searchParams.get('noise') === '1'
      const rows = events
        .filter((e) => (!type || e.type === type) && (withNoise || !isNoiseMeta(e)))
        .slice(-limit)
        .reverse()
      const c = countEvents(events)
      send(res, 200, { total: c.real, all: c.all, meta: c.meta, noise: c.noise, rows })
    }],

    ['/beliefs', async (req, res) => {
      const { events } = await readEvents(root)
      const { config } = await loadConfig(root)
      const m = deriveSelf(events, { growthDays: config.growthDays })
      send(res, 200, {
        active: m.beliefs.map((b) => ({ id: b.id, text: b.text, since: b.since, confidence: b.confidence })),
        refuted: m.refuted,
        refusals: m.refusals,
        selfmod: m.selfmodAttempts,
      })
    }],

    ['/diary', async (req, res) => {
      const { config } = await loadConfig(root)
      if (!config.diary.enabled) return send(res, 200, { enabled: false, visible: false, items: [], note: '她没在写日记' })
      const dates = await listDiary(root)
      if (!config.diary.visible) {
        // 不可见时不返回任何正文，只给日期目录——她自己知道写了什么，玩家不知道
        return send(res, 200, { enabled: true, visible: false, items: [], lockedDates: dates, note: '日记已写，但设置为不可见' })
      }
      // 一页一天，正文按天取：日记可能攒了几百天，一次全发过去既慢也没必要。
      const url = new URL(req.url, 'http://x')
      const day = url.searchParams.get('day')
      if (day) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !dates.includes(day)) return send(res, 404, { error: '这天没有日记' })
        return send(res, 200, { date: day, text: await readDaily('diaryDir', day, root) })
      }
      const items = []
      for (const d of dates.slice(0, 1)) items.push({ date: d, text: await readDaily('diaryDir', d, root) })
      send(res, 200, { enabled: true, visible: true, dates, items })
    }],

    ['/config', async (req, res) => {
      if (req.method === 'GET') {
        const { config } = await loadConfig(root)
        const info = await configFileInfo(root)
        return send(res, 200, { config, file: info })
      }
      if (req.method === 'POST' || req.method === 'PUT') {
        const body = await readBody(req)
        let patch
        try { patch = JSON.parse(body || '{}') } catch { return send(res, 400, { error: 'body 不是合法 JSON' }) }
        // strictTools 是客户端「手动点保存白名单」这一条路带的标记，不是设置项：
        // 它在顶层白名单校验之前摘掉，免得被当成「这一版还不支持保存」的键拒掉。
        // 语义：带它 = 用户刚敲完字、坏名字必须当场拦；不带 = 页面自动保存，丢掉坏名字照存。
        const strictTools = patch.strictTools === true
        delete patch.strictTools
        // 白名单：只允许改"环境"，不允许任何指向她本人的键
        // chat/memory 是 2026-10-23 加的：一个是会话轮换阈值，一个是她能背多少字。
        // 两个都不是性格，但必须在这里登记，否则观测台「保存」会被 400 挡回来。
        // bili 是 2026-10-29 补的：0.6.5 给 issue #5 加了「请求间隔 / 请求抖动」两个设置项，
        // 客户端 buildConfig() 每次整表提交都带着它们，白名单却漏登记——于是用户改任何一项
        // 设置都会看到一句「没存上」，而且整张表都没存进去（自动保存是整表提交）。
        // 教训：新增顶层设置项时，settings.js 的 DEFAULTS 和这张白名单必须同时改；
        // test/p5.test.mjs 里有一条防漂移用例，直接从 client.js 的 buildConfig() 反查这张表。
        // persona 不在这里：它是导入动作的副产物（见 lib/import.js），
        // 不给「从设置页直接改」的入口——否则就等于给了一个「关掉那两条禁令」的开关。
        // proactive 是 2026-10-30 加的（本机实验，.dev 专属）：她主动开口的频率与概率。
        const allowed = ['growthDays', 'wakesPerDay', 'window', 'daily', 'diary', 'absenceAfterDays', 'avoid', 'browse', 'bili', 'video', 'comment', 'notify', 'chat', 'rooms', 'memory', 'tools', 'observe', 'ui', 'proactive', 'drive', 'interest', 'dream']
        const bad = Object.keys(patch).filter((k) => !allowed.includes(k))
        // 这句话会原样冒到界面上，所以写成人话（界面会把它放在「技术信息」那一行）：
        // 原来那句「不允许修改：bili」既不说人话，也让人以为自己填错了。
        if (bad.length) {
          // 2026-10-29（用户 m02241）：白名单拒收以前不留痕。
          // 自动保存是**整表提交**，只要有一个顶层键没登记，整张表都存不进去，
          // 用户看到一句「没存上」却不知道是谁拖累的。历史上出过「漏登记 bili 组」那次事故。
          logLine('warn', [
            '/config 保存被白名单挡回：',
            `拒了 ${bad.join('、')}`,
            `提交的键 ${Object.keys(patch).join('、')}`,
          ], root)
          return send(res, 400, { error: `这一版还不支持保存：${bad.join('、')}` })
        }
        // 白名单必须真的存在（2026-10-24）：宿主 restrict 遇到不认识的名字会抛错，
        // 整条收窄当场失效、她退回全量工具面。所以坏名字绝不能写进 config。
        //
        // 但「不许写坏名字」不等于「整张表都不许存」（2026-10-31，issue #14 @ming-fish）：
        // 设置页的自动保存是**整表提交**，用户 config.json 里留着一个早就没有的工具名
        // （他那边是裸的 `delete`），于是改任何一个开关都 400，而界面上那句提示还指着
        // 「插件这一版还没接上它」——方向完全错了。
        //
        // 现在分两条路：
        //   · 用户在输入框里敲完点「保存」→ 带 strictTools，坏名字当场 400，得说清打错了；
        //   · 页面自动保存（整表回传盘上的旧名单）→ 丢掉坏名字、其余照常存，把丢掉的回给界面。
        // 「不许把坏名字写进 config」这条底线两条路都守住了：写进去的永远只有干净那份。
        let droppedTools = []
        if (patch.tools && patch.tools.allow !== undefined) {
          if (strictTools) {
            const check = validateToolNames(patch.tools.allow, knownToolNames(ctx))
            if (!check.ok) {
              logLine('warn', ['/config 保存被工具名校验挡回：', `不存在的名字 ${check.unknown.join('、')}`], root)
              return send(res, 400, {
                error: `这些工具名不存在：${check.unknown.join('、')}`,
                unknown: check.unknown,
              })
            }
            patch.tools.allow = check.names
          } else {
            const clean = sanitizeToolNames(patch.tools.allow, knownToolNames(ctx))
            patch.tools.allow = clean.names
            droppedTools = clean.dropped
            if (droppedTools.length) {
              // 留痕：这条以前是静默失败源（一句「没存上」，整表都没进去），现在改成
              // 「丢了名字但其余存下去了」，事后得能查是谁拖累的。
              logLine('warn', [
                '/config 里的工具名在这台机器上不存在，已跳过：',
                droppedTools.join('、'),
                `保留 ${clean.names.length} 个`,
              ], root)
            }
          }
        }
        const before = await loadConfig(root).catch(() => null)
        const next = await updateConfig(patch, root)
        // 白名单一动就当场换刀（2026-11-11，外部用户反馈）。
        // 以前这里存完就完事，工具面还是启动那一刻的那份；用户加了工具，
        // 她照样按旧名单答「我手上没有这样东西」，只有重启 DSH 才认。
        // 只有真的变了才换：自动保存每次都整表回传，没变也换会让每条会话白下一次刀。
        const beforeAllow = JSON.stringify(before?.config?.tools?.allow ?? [])
        const nextAllow = JSON.stringify(next?.tools?.allow ?? [])
        // 梦开关不在这里换：her_dream 归不归她，跟着启动那一刻的梦状态走（issue #64 的取舍），
        // 打开它仍要重启——否则得同时动身份文档与工具面，两处一变就不是「存一下」了。
        let toolsLive = null
        if (beforeAllow !== nextAllow) {
          try {
            const r = refreshToolRestrict({ extra: next?.tools?.allow ?? [] })
            toolsLive = { ok: r?.ok === true, deferred: r?.deferred?.length ?? 0 }
            logLine('info', [
              'tools.allow 已当场生效',
              `allow=${(next?.tools?.allow ?? []).join(',') || '(空)'}`,
              `换刀=${r?.applied?.length ?? 0}`,
              r?.deferred?.length ? `延后=${r.deferred.length}` : '',
            ], root)
          } catch (err) {
            // 换刀失败不影响设置本身存下去；下一次新建会话仍会按新名单收窄。
            logLine('warn', ['白名单热更新没成（下次新建会话照样生效）：', String(err?.message ?? err).slice(0, 200)], root)
          }
        }
        // issue #64：身份文档读的不止 sendTools 一项（日记、睡觉、白名单、上网、说话都读），
        // 所以保存后无条件重写一次。内容没变时 writeSelfDoc 自己就不写盘，不会多出写操作。
        await refreshSelfDoc(root).catch(() => {})
        // issue #62：bili_speak 的说明按 speak.js 记着的那份开关取版本，以前只在启动注册和她调用时同步。
        // 设置页关掉上网之后、她下一次调 bili_speak 之前，身份文档已经写「这会儿还说不出去」，
        // 说明却还在说能留评论。身份文档在这里重写，说明也在这里跟上，两边用同一个判据。
        noteSpeakEnabled(speakOn(next))
        // 审计：日记可见性每翻一次就落一行，事后查得到是谁、随哪次提交翻的。
        // 2026-10-28 用户反馈「开了『让我看日记』插件又自己关」——光靠猜猜不出来，
        // 至少让下一次发生时日志里有一行可对。
        const wasVisible = before?.config?.diary?.visible === true
        const nowVisible = next?.diary?.visible === true
        if (wasVisible !== nowVisible) {
          logLine('info', [
            'diary.visible',
            wasVisible ? 'on' : 'off',
            '->',
            nowVisible ? 'on' : 'off',
            `by=${Object.keys(patch).join(',')}`,
          ], root)
        }
        return send(res, 200, { ok: true, config: next, droppedTools, toolsLive })
      }
      send(res, 405, { error: 'method not allowed' })
    }],

    // ---- 工具名名单（2026-10-24）----
    // 只给名字不给定义：白名单输入框要能当场判断「这个名字到底存不存在」。
    // ok:false = 宿主这个版本拿不到全局视角，界面退回只做形状校验。
    ['/tools', async (req, res) => {
      if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' })
      const known = knownToolNames(ctx)
      // ownLayer：看得见、但 restrict() 点不了名的那些（dsh-ops 的 ops_* 就在这）。
      // 客户端拿它提示「加进白名单只是让守卫放行」，不是「收窄会把她挡住」。
      //
      // blocked（2026-11-04，issue #20）：这个进程里被兜底守卫真挡下来的工具名。
      // 以前只有日志里有，用户看不到——而它恰好是「白名单还差哪个名字」的唯一答案。
      // 只读、不落盘：进程重启就清空，避免上一局的账吓着人。
      return send(res, 200, {
        ok: Boolean(known && known.length),
        known: known ?? [],
        ownLayer: ownLayerNames(),
        blocked: blockedTools(),
        // 她自己那几件（含 read_image）。界面靠它把它们跟她要额外放行的分开摆——
        // 以前只有一个空输入框，用户不知道「默认已经有什么」，只能凭猜填名字。
        //
        // 2026-11-08（用户 m00002）：这份清单以前是写死的常量，加工具时忘了抄就永远
        // 显示旧的那几样。现在从**这一版真的注册了哪些**现算（lib/toolreg.js），
        // 新加的工具下一次开设置页就在了，不用回来改界面。
        herTools: herToolsNow(),
        // 出门才用得上的那几样：它们也是她的工具，但不在家里的工具面里
        // （bring_back 在家调用只会答「现在没在外面。」）。界面单列一组，
        // 免得用户以为它们丢了，也免得点一下加进白名单去放行一只用不了的手。
        herSceneTools: herSceneToolsNow(),
        // 这一局真在她手上的（issue #69 第 9 条说的「同一份名单」）：
        // herTools 说的是「哪些是她自己的」，按注册记录现算；守卫放行的是启动时算定的
        // allowNow，真下给宿主的又是 effective。三份可能对不上——关着梦启动时没有 her_dream，
        // 宿主没挂附件服务时 effective 里没有 read_image。界面按这两份把她自己的分成
        // 「在手上」和「这一局不在手上」，不再把守卫会拦的名字摆进「不用放行」。
        // allowNow 是 null：收窄这一局没在管（关着，或还没注册）；effective 是 null：还没真下过。
        ...toolsNowOf(),
      })
    }],
    // 只给两件事：看规则在哪一层、裁决她提上来的那一张。
    // 没有"新建规则"、没有"编辑规则"——规则不是设置项。
    ['/rules', async (req, res) => {
      if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' })
      const { events } = await readEvents(root).catch(() => ({ events: [] }))
      const { config } = await loadConfig(root)
      const model = deriveSelf(events, config)
      return send(res, 200, {
        layers: rulesByLayer(),
        status: ruleStatus(events, model, Date.now()),
        history: offerHistory(events).slice(-20),
        pending: (() => {
          const p = pendingOffer(events, Date.now())
          return p ? { id: p.id, rule: p.grant?.rule || '', why: p.text || '' } : null
        })(),
        offersOn: config?.rules?.offers !== false,
      })
    }],

    ['/decide', async (req, res) => {
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
      const raw = await readBody(req)
      let body
      try { body = JSON.parse(raw || '{}') } catch { return send(res, 400, { error: 'body 不是合法 JSON' }) }
      const verdict = body.verdict === 'approve' || body.verdict === 'reject' ? body.verdict : null
      if (!verdict) return send(res, 400, { error: 'verdict 只能是 approve 或 reject' })
      const { events } = await readEvents(root).catch(() => ({ events: [] }))
      const p = pendingOffer(events, Date.now())
      if (!p) return send(res, 409, { error: '现在没有待裁决的申请' })
      // 0.7.5：写入逻辑搬到 lib/grant.js——会话里的提问卡片也走同一条路，
      // 两个入口必须写同一份事件（两个坑的注释也一起搬过去了）。
      const r = await recordGrant(root, {
        offerId: p.id,
        rule: p.grant?.rule || '',
        verdict,
        reason: typeof body.reason === 'string' ? body.reason : '',
      })
      if (!r.ok) return send(res, 400, { error: r.error })
      return send(res, 200, { ok: true, verdict })
    }],

    ['/owner', async (req, res) => {
      if (req.method === 'GET') {
        const ow = await readOwner(root)
        const { config } = await loadConfig(root)
        return send(res, 200, {
          ...publicOwner(ow),
          atOwner: config?.comment?.atOwner !== false,
          hint: COOKIE_HINT,
          // 二维码多久过期由宿主说了算（页面只负责倒计时），免得两边各写一个 180。
          qrTtlMs: QR_TTL_MS,
        })
      }
      if (req.method === 'POST' || req.method === 'PUT') {
        const raw = await readBody(req)
        let body
        try { body = JSON.parse(raw || '{}') } catch { return send(res, 400, { error: 'body 不是合法 JSON' }) }
        if (body.test) {
          // 探一次「这个 cookie 到底能不能说话」：能登录、能看到自己的 mid 与昵称。
          const ow = await readOwner(root)
          if (!ow?.cookie) return send(res, 200, { ok: false, note: '还没存 cookie。' })
          try {
            const c = createClient({ cookie: ow.cookie })
            const me = await c.me()
            if (!me?.isLogin) return send(res, 200, { ok: false, note: '这个 cookie 登不上，可能过期了。' })
            // 2026-10-27：这里只记「这份 cookie 登的是哪个账号」（只读 account），
            // 不再覆盖 mid / nickname —— 那两格是领养人，用户手填的大号。
            // 以前自动填进去，导致拿小号 cookie 时 @ 到小号自己。
            const owner = await saveAccount(me, root)
            return send(res, 200, { ok: true, note: `登上了：${me.uname}（uid ${me.mid}）`, mid: String(me.mid), name: String(me.uname), account: owner.account, canWrite: Boolean(me.canWrite) })
          } catch (err) {
            return send(res, 200, { ok: false, note: `连不上：${String(err?.message ?? err).slice(0, 60)}` })
          }
        }
        if (body.atOwner !== undefined) {
          await updateConfig({ comment: { atOwner: Boolean(body.atOwner) } }, root)
        }
        const patch = {}
        if (body.mid !== undefined) patch.mid = body.mid
        if (body.nickname !== undefined) patch.nickname = body.nickname
        if (body.cookie !== undefined) patch.cookie = body.cookie
        const r = Object.keys(patch).length ? await saveOwner(patch, root) : { ok: true, note: '存下了。', owner: publicOwner(await readOwner(root)) }
        // 2026-10-27：存了 cookie 就认一次「登的是谁」，只写只读的 account；
        // 领养人那两格（mid / nickname）原样保留，用户填的是要 @ 的大号。
        // 认不出来不影响「cookie 已经存好了」这件事。
        if (r.ok && patch.cookie) {
          try {
            const probe = createClient({ cookie: (await readOwner(root))?.cookie || '' })
            const me = await probe.me()
            if (me?.isLogin && me.uname) {
              const r2 = await saveAccount(me, root)
              if (r2) return send(res, 200, { ...r, owner: r2, note: `${r.note || '存下了。'} 登录的是：${me.uname}（uid ${me.mid}）` })
            }
          } catch { /* 认不出来就算了，cookie 已经存下 */ }
        }
        return send(res, r.ok ? 200 : 400, r)
      }
      send(res, 405, { error: 'method not allowed' })
    }],

    // 扫码登录（2026-11-01，用户定案）：手动抓 cookie 的那一格保留为退路，扫码是默认。
    //
    // 四个动作挤在一条前缀路由里（start / status / save / drop），理由和 /cover 一样：
    // webServer.register 只给前缀，子路径得自己分。
    //
    // 页面能拿到的只有「登的是谁」和「还能活多久」；cookie 原文一步都不出宿主。
    ['/bili/qr', async (req, res) => {
      const u = new URL(String(req.url ?? '/'), 'http://x')
      const sub = u.pathname.replace(/^\/dsh-fish\/bili\/qr/, '').replace(/\/+$/, '')

      if (!sub) {
        if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
        const r = await qrLogin.start()
        return send(res, r.ok ? 200 : 502, r)
      }

      if (sub === '/status') {
        if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' })
        return send(res, 200, await qrLogin.poll(u.searchParams.get('key') ?? ''))
      }

      if (sub === '/save' || sub === '/drop') {
        if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
        let body = {}
        try {
          body = JSON.parse((await readBody(req, 20_000)) || '{}')
        } catch (err) {
          if (sentTooLarge(res, err)) return
          return send(res, 400, { error: 'body 不是合法 JSON' })
        }
        const key = String(body.key ?? '')
        if (!key) return send(res, 400, { error: '缺 key' })
        if (sub === '/drop') return send(res, 200, qrLogin.drop(key))
        const r = await qrLogin.save(key, root)
        return send(res, r.ok ? 200 : 409, r)
      }

      send(res, 404, { error: 'no such route' })
    }],

    ['/browse', async (req, res) => {
      // POST = 「现在就去逛一趟」（2026-11-07，用户 m00365）。设置页那个按钮用它。
      // 和 /wake?focus=browse 的区别：**不叫醒、不投递任何消息**——她不会因为这次点击醒来，
      // 只是家里替她出去走了这一趟：取数、记账（browse:/looked:），下一次醒来才看到那一行便条。
      // 走的是和定时同一条 quietBrowse（force 只绕过配额与时段），所以按钮测出来的就是真行为。
      if (req.method === 'POST') {
        const { events } = await readEvents(root)
        const { config } = await loadConfig(root)
        const dk = dateKey()
        const model = deriveSelf(events, { growthDays: config?.growthDays })
        const r = await quietBrowse(root, model, config, dk, { events, force: true }, (k, m) => console.log('[dsh-fish]', k, m ?? ''))
        const picks = r.picks ?? []
        return send(res, r.ok ? 200 : 409, {
          ok: r.ok,
          count: picks.length,
          titles: picks.map((p) => String(p.title || p.bvid || '')).filter(Boolean).slice(0, 5),
          note: r.note || '',
          error: r.ok ? undefined : (r.note || '这一趟没刷成'),
        })
      }
      const { events } = await readEvents(root)
      const { config } = await loadConfig(root)
      const dk = dateKey()
      const items = itemsFromEvents(events, dk)
      const used = browseCountToday(events, dk)
      // 2026-10-30 客户反馈：状态窗以前只有 browse: 那一档（"翻到过"），
      // 于是"看过画面"和"只扫了眼标题"在这里长得一模一样。现在三档分开给。
      const seen = seenOn(events, dk)
      // 「看过的全部」这个列表只给 BV 号，不给标题——标题可以去报告里看。
      // 理由：这里是状态窗，报告才是"她今天看了什么"的正式记录，两处别分叉。
      const lookedAll = []
      for (const e of events) {
        if (e?.type !== 'meta') continue
        const t = String(e.text ?? '')
        // 0.9.7 T2：行尾可能跟着标题；状态窗只要 BV 号（与上面的口径一致）。
        if (t.startsWith('looked:')) lookedAll.push(t.slice(7).trim().split(/\s+/)[0])
      }
      send(res, 200, {
        enabled: Boolean(config?.browse?.enabled),
        perDay: Number(config?.browse?.perDay ?? 0),
        usedToday: used,
        topN: Number(config?.browse?.topN ?? 0),
        keywords: config?.browse?.keywords ?? [],
        items,
        // 真的抽帧看过画面的（今天）
        watched: seen.watched,
        watchedCount: seen.watched.length,
        // 翻到过但没看画面
        glancedCount: seen.glanced.length,
        // 他递过来、她还没看的
        handed: seen.handed,
        lookedCount: lookedAll.length,
        lookedRecent: lookedAll.slice(-20).reverse(),
        avoidKeywords: config?.avoid?.keywords ?? [],
        avoidMids: config?.avoid?.upMids ?? [],
        minDuration: Number(config?.avoid?.minDuration ?? 0),
      })
    }],

    // 她看过什么（2026-10-23 用户提：想回她却不知道她看的哪条）。
    // 只读事件流里已有的记账（watched: / look: / browse:），不新增落盘。
    ['/history', async (req, res) => {
      const url = new URL(req.url, 'http://x')
      // 2026-11-07（用户反馈）：设置页给了「365 天」，这里却夹到 180——选「一年」只拿到半年。
      const days = Math.max(1, Math.min(366, Number(url.searchParams.get('days')) || 14))
      const { events } = await readEvents(root)
      const groups = historyFromEvents(events, { days })
      const total = groups.reduce((a, g) => a + g.items.length, 0)
      send(res, 200, { days, total, groups })
    }],

    // 环境自检：它现在到底能不能工作。`?net=0` 跳过联网（不想碰 B 站时用）。
    ['/selfcheck', async (req, res) => {
      const url = new URL(req.url, 'http://x')
      const net = url.searchParams.get('net') !== '0'
      const { config } = await loadConfig(root)
      const client = net
        // 2026-10-25 修：readOwner 是 async，原来漏了 await → cookie 永远是空串，
        // 自检的联网检查因此是个「没登录的匿名请求」，风控更容易踩。
        ? createClient({ cookie: (await readOwner(root))?.cookie || '', log: () => {} })
        : null
      const r = await runChecks({
        root,
        config,
        host: {
          sessionController: ctx.get?.('sessionController') ?? ctx.sessionController,
          webServer: ctx.get?.('webServer') ?? ctx.webServer,
          connection: ctx.get?.('connection') ?? ctx.connection,
        },
        tools: ctx.get?.('tools') ?? ctx.tools,
        // attachments 服务在不在，决定 read_image 注册得上不上（宿主原文：
        // "read_image registers only while a durable ctx.attachments service is mounted"）。
        // 有 ctx.get 就是权威答案：查不到 = 真没挂 ⇒ false。
        // 没有 ctx.get（假环境/预检）就别猜，传 undefined 让自检说「判不准」。
        attachments: typeof ctx.get === 'function'
          ? Boolean(ctx.get('attachments'))
          : (ctx.attachments ? true : undefined),
        client,
        net,
        preset: config?.tools?.preset ?? '',
        sessionPreset: (await homeStatus(root))?.preset ?? '',
        restrict: readRestrictState(),
        restrictEnabled: config?.tools?.restrict !== false,
      })
      send(res, 200, r)
    }],

    // 「有没有新版」（2026-10-25 用户要求）。
    // 只在设置页点「检查更新」时走一次，插件运行期**从不**自动查——
    // 她不需要知道自己是几号版本，那是装她的人的事。
    // 地址全部硬编码在 update.js 里，这里绝不接受客户端传 URL（否则就是 SSRF 口子）。
    //
    // 2026-10-29 加「下载 → 安装」两段（用户 m00203）：市场索引要等半天到一天，
    // 所以插件自己带一条升级通道。三条约束：
    //   · GET 只读状态，没有任何副作用；下载和安装都必须 POST（＝界面点过确认）；
    //   · 安装不在本进程里做——写一个 .cmd，等宿主退出后才动手（运行中换包会 EPERM）；
    //   · 状态机只在内存里，重启即作废，避免"上次下的包"被误装。
    ['/update', async (req, res) => {
      const url = new URL(req.url, 'http://x')
      const route = url.pathname.replace(/\/+$/, '')

      // ---- 只检查：点一次查一次 ----
      if (route.endsWith('/update')) {
        const current = normalizeVersion(deps.version) || String(deps.version ?? '')
        const ms = Math.min(15_000, Math.max(1_000, Number(url.searchParams.get('ms') ?? 6000) || 6000))
        // checkUpdate 自己永不抛（连不上是常态），这里再包一层只是防手滑。
        let r
        try {
          r = await checkUpdate({ current, timeoutMs: ms })
        } catch (err) {
          r = { ok: false, current, error: String(err?.message ?? err) }
        }
        // GitHub 地址一并下发，客户端不需要自己拼（仓库改名只改 update.js 一处）。
        send(res, 200, { ...r, repoUrl: REPO_URL })
        return
      }

      // ---- 进度：客户端轮询这一条 ----
      if (route.endsWith('/update/status')) {
        const st = selfUpdater.status()
        // 就绪/安装中时把脚本日志尾几行带上，出问题用户能直接看见卡在哪一步。
        if (st.phase === 'prepared' || st.phase === 'installing') {
          st.log = await tailUpdateLog(join(root, 'updates', 'last.log'))
        }
        send(res, 200, st)
        return
      }

      // ---- 下载（界面确认过才到这）----
      if (route.endsWith('/update/download')) {
        if (req.method !== 'POST') return send(res, 405, { error: '只接受 POST' })
        let body
        try {
          body = JSON.parse((await readBody(req)) || '{}')
        } catch (err) {
          if (sentTooLarge(res, err)) return
          return send(res, 400, { error: 'body 不是合法 JSON' })
        }
        const version = String(body?.version ?? '').trim()
        if (!version) return send(res, 400, { error: '缺 version' })
        const r = await selfUpdater.start(version)
        return send(res, r.ok ? 202 : 400, r)
      }

      // ---- 安装（第二次确认之后）----
      if (route.endsWith('/update/install')) {
        if (req.method !== 'POST') return send(res, 405, { error: '只接受 POST' })
        let body
        try {
          body = JSON.parse((await readBody(req)) || '{}')
        } catch (err) {
          if (sentTooLarge(res, err)) return
          return send(res, 400, { error: 'body 不是合法 JSON' })
        }
        const r = await selfUpdater.install(String(body?.version ?? '').trim())
        return send(res, r.ok ? 202 : 400, r)
      }

      send(res, 404, { error: '没有这个接口' })
    }],

    // 「你不在的时候」：不推送，只在你回来时告诉你错过了什么。
    ['/away', async (req, res) => {
      send(res, 200, await readAway(root))
    }],

    // 封面图：设置页的历史列表直接 <img src>。跟着状态库走，没有就是 404。
    ['/cover', async (req, res) => {
      const m = String(req.url ?? '').match(/^\/dsh-fish\/cover\/(BV[0-9A-Za-z]{10})/)
      if (!m) { send(res, 404, { error: 'no cover' }); return }
      const file = coverPath(root, m[1]) || (await lazyCover(root, m[1]))
      if (!file) { send(res, 404, { error: 'no cover' }); return }
      try {
        const buf = fs.readFileSync(file)
        const ext = file.split('.').pop().toLowerCase()
        const ct = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
        res.writeHead(200, {
          'content-type': ct,
          'content-length': buf.length,
          'cache-control': 'private, max-age=86400',
        })
        res.end(buf)
      } catch {
        send(res, 404, { error: 'no cover' })
      }
    }],

    // 头像（2026-10-24）：插件不自带任何图片，谁用谁自己传一张。
    //   GET  /avatar            出图（没有就是 404，客户端自己画空圈）
    //   GET  /avatar/info       元信息 { present, mime, bytes, at }
    //   POST /avatar            { data: base64, mime } 存一张；{ remove: true } 删掉
    ['/avatar', async (req, res) => {
      const url = String(req.url ?? '')
      if (url.startsWith(PREFIX + '/avatar/info')) { send(res, 200, avatarInfo(root)); return }
      if (req.method === 'POST') {
        let body = {}
        try {
          const raw = await readBody(req, 4_000_000)
          body = raw ? JSON.parse(raw) : {}
        } catch (err) {
          if (sentTooLarge(res, err)) return
          body = {}
        }
        const r = body && body.remove ? removeAvatar(root) : saveAvatar(root, body)
        if (!r || r.ok === false) { send(res, 400, { error: (r && r.why) || '没存上' }); return }
        send(res, 200, { ok: true, removed: Boolean(r.removed), ...avatarInfo(root) })
        return
      }
      const file = avatarFile(root)
      if (!file) { send(res, 404, { error: 'no avatar' }); return }
      try {
        const buf = fs.readFileSync(file)
        const ext = file.split('.').pop().toLowerCase()
        const ct = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/jpeg'
        res.writeHead(200, { 'content-type': ct, 'content-length': buf.length, 'cache-control': 'no-store' })
        res.end(buf)
      } catch { send(res, 404, { error: 'no avatar' }) }
    }],

    // 静态图（2026-10-25 两张原理图；2026-10-28 加反馈页的交流群二维码）。
    // 只放白名单文件名，不做通用文件服务——这是插件自己的说明书，不是文件浏览器。
    // 用来源：`GET /dsh-fish/media/principle-loop.svg`、`/dsh-fish/media/principle-memory.svg`、
    // `/dsh-fish/media/feedback-qr.jpg`。
    ['/media', async (req, res) => {
      const m = String(req.url ?? '').match(/^\/dsh-fish\/media\/((?:principle-[a-z]+\.svg)|(?:feedback-qr\.jpg))$/)
      if (!m) { send(res, 404, { error: 'no file' }); return }
      try {
        const file = fileURLToPath(new URL(`../media/${m[1]}`, import.meta.url))
        const buf = fs.readFileSync(file)
        const isJpg = m[1].endsWith('.jpg')
        res.writeHead(200, {
          'content-type': isJpg ? 'image/jpeg' : 'image/svg+xml; charset=utf-8',
          'content-length': buf.length,
          'cache-control': 'private, max-age=3600',
        })
        res.end(buf)
      } catch { send(res, 404, { error: 'no file' }) }
    }],

    // 风控状态：冷却到什么时候、撞过几次。POST {clear:true} 立即解冻。
    ['/risk', async (req, res) => {
      if (req.method === 'POST') {
        let body = {}
        try { body = await readBody(req) } catch (err) {
          if (sentTooLarge(res, err)) return
          body = {}
        }
        const cleared = Boolean(body?.clear)
        if (cleared) clearRisk(root)
        send(res, 200, { ...riskState(root), memory: memoryCooldown(), cleared })
        return
      }
      send(res, 200, { ...riskState(root), memory: memoryCooldown() })
    }],

    ['/reports', async (req, res) => {
      const url = new URL(req.url, 'http://x')
      const want = String(url.searchParams.get('date') ?? '').trim()
      const dates = await listReports(root)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(want)) {
        return send(res, 200, { dates, date: null, md: '' })
      }
      const { events } = await readEvents(root)
      const { config } = await loadConfig(root)
      // 预览与落盘走同一个 buildReport，避免"界面看到的"和"文件里的"两套逻辑。
      const diary = await readDaily('diaryDir', want, root).catch(() => null)
      const md = buildReport({
        dateKey: want,
        // 和落盘的报告同一份口径（看过画面 / 翻到过 / 递了没看）
        seen: seenOn(events, want),
        events,
        diary,
        diaryVisible: config?.diary?.visible === true,
      })
      send(res, 200, { dates, date: want, md })
    }],

    ['/templates', async (req, res) => {
      const { events } = await readEvents(root)
      const fired = firedLog(events)
      send(res, 200, {
        // once / repeat 一起给出：同一处境能不能回来，是性格能不能长出来的关键之一
        // （2026-10-24 事件复现）。count 是该模板累计出过几次，lastAt 是最后一次的时间戳。
        rows: CATALOG.map((t) => ({
          id: t.id,
          stage: t.stage,
          asks: t.asks,
          once: Boolean(t.once),
          everyDays: Number(t.repeat?.everyDays ?? 0) || null,
          fired: fired.has(t.id),
          count: Number(fired.get(t.id)?.count ?? 0),
          lastAt: fired.get(t.id)?.lastAt ? new Date(fired.get(t.id).lastAt).toISOString() : null,
        })),
      })
    }],

    ['/wake', async (req, res) => {
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
      // ?focus=browse：设置页那个「让她去刷 B 站」按钮（仅本机测试版）。
      // 传下去之后 wakeNow 会跳过「今天该不该醒」的判断，只做一件事：叫醒她，并让这一轮
      // 的处境明确指向 B 站首页。
      let focus = ''
      try { focus = new URL(String(req.url ?? '/'), 'http://localhost').searchParams.get('focus') ?? '' } catch { /* 解析失败就当没传 */ }
      const r = await wakeNow(ctx, { root, focus, log: (...a) => console.log('[dsh-fish]', ...a) })
      // 失败时补一个 error 字段：前端 jpost 只认得 error，不然界面只会显示「HTTP 409」，
      // 而真正的原因（「今天已经叫过三次了」这类）就在 r.why 里。
      send(res, r.ok ? 200 : 409, r.ok ? r : { ...r, error: r.why || '这次没叫醒' })
    }],

    // ---- P3-1：对话入口 ----
    // 这是唯一一条"你说的话会进到她那里"的路由。POST { text }。
    // 返回她这一轮新写的话（可能一句都没有——允许她不回）。
    //
    // 2026-11-03（一条鱼多间房）：多了三个**可选**字段，一个都不传时行为完全不变。
    //   channel 外部渠道名（桥自己起名，如 'qq:123456' / 'qq-group:987654'）
    //   scene   desk（默认）/ private / group
    //   speaker 这句话是谁说的（所有场次都写进正文前缀）
    // 2026-11-05（0.9.1，用户 m00304）：桥决定拓扑，插件只提供机制。
    //   room    house（一定回书房）/ channel（一定另开一间），不传按老规则
    //   title   侧栏显示名（群名/昵称）
    //   guest   true = 外客（群友私聊）：不算他来过、不涨轮数、不触发轮换
    // 2026-11-08（用户 m00394）：多了 owner。
    //   owner   true = 这条是**他本人**说的（桥按 QQ 号判，插件不猜昵称）。
    //           只对群聊有意义：他在群里说的话进记忆（一句原话，scene:group），
    //           但**不算他来找过她**——不写 seen、不涨轮数、不触发轮换。
    //           不传 = 老行为（群里的话一律当外客，一个字不进记忆）。
    // 桥只要 POST 到这里，**不需要自己建 DSH 会话、也不需要碰 instance.json**——
    // 「同时养两条鱼」「两个实例抢一个家」这两个问题就是从这里消失的。
    ['/say', async (req, res) => {
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
      // 带图的请求会大很多（base64 膨胀 4/3），单独给一个更高的上限
      const raw = await readBody(req, 12_000_000)
      let body = {}
      try { body = JSON.parse(raw || '{}') } catch { return send(res, 400, { error: 'body 不是 JSON' }) }
      const text = String(body.text ?? '').trim()

      // 图：落盘成文件，然后只把**路径**递给她（她用 read_image 读）
      // 不走 content block / attachment 体系——那是给附件上传用的，插件侧没有稳定入口；
      // 而 read_image 这条路已实测可用（2026-10-23：她读出一张写着 7 的图并答「七」）。
      let imagePath = ''
      if (body.image) {
        const dec = decodeBase64Image(body.image)
        if (!dec.ok) return send(res, 400, { error: dec.why })
        const saved = await saveImage(root, dec.buf, { prefix: 'him' })
        if (!saved.ok) return send(res, 400, { error: saved.why })
        imagePath = saved.path
      }

      if (!text && !imagePath) return send(res, 400, { error: 'text 不能为空' })
      const r = await sayToHer(ctx, text, {
        root,
        imagePath,
        // scene / channel / speaker / room / title / guest 原样往下传：
        // 归一与兜底都在 say.js 里做，这里不再判一遍（两处判据迟早会分叉）。
        scene: body.scene,
        channel: body.channel,
        speaker: body.speaker,
        room: body.room,
        title: body.title,
        guest: body.guest,
        owner: body.owner,
        log: (...a) => console.log('[dsh-fish]', ...a),
      })
      // 一律 200：请求本身是合法的，被拦下是**规则的结果**，不是接口出错。
      // 用 503 会让观测台的 jpost 抛异常，把「这句我没递给她」变成一句技术错误。
      send(res, 200, r)
    }],

    // ---- 桥启动前的探问（2026-11-03）----
    // 为什么要有：桥以前只能靠"自己起一个 DSH 实例"来接入，于是两个进程抢一个数据目录，
    // 被 instance.json 判成只读房客。有这条路之后，桥先问一句「家里有没有人在」：
    // 在就直接走 HTTP 投递，不在再考虑别的。**这里只回答事实，不教桥怎么做。**
    ['/whoami', async (req, res) => {
      if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' })
      const h = await homeStatus(root)
      const tenant = deps.tenancy?.tenant ?? { ok: true }
      send(res, 200, {
        // 有这四个字段，桥就能判断"是不是同一个家"：root 是身份，sessionId 是房间。
        ok: true,
        plugin: 'dsh-fish',
        version: deps.version ?? '',
        root,
        // 家建好没有。没建好也能投递（say 会自己去建），所以这不是"能不能用"的意思。
        home: Boolean(h.sessionId),
        // 她住的那条会话。/say 不带 channel 时，话就落在这儿。
        sessionId: h.sessionId ?? '',
        // 这个数据目录现在归不归本进程写。false = 别处也开着一份，写进去会混。
        writable: tenant.ok !== false,
      })
    }],

    // ---- P3-2：信箱 ----
    ['/inbox', async (req, res) => {
      if (req.method === 'POST') {
        // 标记已读（读到最新一条）
        const r = await markRead(root)
        await writeInboxFile(root).catch(() => null)
        return send(res, 200, r)
      }
      const url = new URL(req.url, 'http://x')
      const limit = Math.min(500, Number(url.searchParams.get('limit') ?? 200) || 200)
      const box = await readInbox(root, { limit })
      // 顺手保证 inbox.md 存在且是最新的（幂等重写，失败不影响接口）
      await writeInboxFile(root, { limit: 60 }).catch(() => null)
      send(res, 200, box)
    }],

    // ---- P3：她住在哪 ----
    // 观测台要知道"她的屋子"建好没有、会话 id 是什么、身份文件多大。
    // 这里**只读**：建屋子是启动时的事，不是按一下按钮就重开一个会话。
    ['/home', async (req, res) => {
      const h = await homeStatus(root)
      const d = await selfDocStatus(root)
      // 工作区标题现读、不记在 home.json：用户可能在宿主侧栏自己改名，
      // 记下来的会一直是老名字（2026-10-25 加，用来核对「大肥鱼的家」真的落上了）。
      let wsTitle = ''
      try {
        const reg = ctx.get?.('workspaceRegistry')
        wsTitle = String(reg?.get?.(h.wsId)?.title ?? '')
      } catch { wsTitle = '' }
      send(res, 200, {
        workspace: { id: h.wsId, ok: Boolean(h.wsId), title: wsTitle },
        session: { id: h.sessionId, ok: Boolean(h.sessionId) },
        dir: h.dir,
        createdAt: h.createdAt,
        selfDoc: { exists: d.exists, bytes: d.bytes, mtime: d.mtime },
      })
    }],

    // ---- 数据文件夹路径（2026-10-24 加）----
    // 为什么要有这条路由：界面上**不显示任何绝对路径**（用户 m03440），
    // 但「复制路径」按钮还需要真路径，而路径该由服务端现算——
    // 客户端原来自己拼 `${root}\\${name}`，反斜杠是 Windows 假设，换平台就错。
    // 顺手在这里确保数据文件夹根上有一份「说明.md」，跟着备份一起走。
    ['/paths', async (req, res) => {
      const p = paths(root)
      await ensureDataReadme(root)
      send(res, 200, {
        root: p.root,
        events: p.events,
        out: p.outDir,
        diary: p.diaryDir,
        home: p.herDir,
        inbox: join(p.root, 'inbox.md'),
        log: join(p.root, 'logs', 'dsh-fish.log'),
      })
    }],

    // ---- 上下文与记忆（2026-10-23 加）----
    // 只回答「她现在背了多少东西、还能背多少」，全是客观计数，没有分数。
    // 用户要的是能看见"上下文在长"，不是看见一个成长进度条——
    // 后者是 N2 明令禁止的东西，别借"可视化"复活它。
    ['/memory', async (req, res) => {
      const { config } = await loadConfig(root)
      const { events } = await readEvents(root)
      const model = deriveSelf(events, { growthDays: config.growthDays })
      const doc = await selfDocStatus(root)
      const h = await homeStatus(root)
      const budget = Number(config?.memory?.docBudget ?? 2400)
      // 用「字」而不是「字节」算用量：中文一个字三字节，按字节算会永远显示撑满。
      // 摆几条判断由配置决定（1–8），身份文档和这里的数字必须同源
      const shownCap = shownCount(config?.memory?.beliefsShown ?? BELIEF_SHOWN)
      // 禁不禁用跟身份文档同源：只看事件流里有没有「导入」那条标记（2026-10-27，用户 m03769），
      // 不看 config——备份/恢复搬回来的 config 不算数。
      // sleepKeep 也要传：它改的是「更早以前」那一行有多长，预算用量要跟文档里那一行对得上。
      const pb = personaBudget(model, { budget, withBans: model?.persona?.imported !== true, shown: shownCap, sleepKeep: config?.memory?.sleepKeep })
      const diary = await listDiary(root).catch(() => [])
      // 2026-10-24：这个数原来写死 8，而身份文档里实际只摆 BELIEF_SHOWN（3）条。
      // 界面说"8 条在眼前"、她只看见 3 条——用户当场问过这个矛盾，现在对齐同一条常量。
      // 2026-11-08（用户 m00585）：「总共留几条自述」现在真的截断了，
      // 这里的数要跟身份文档同源，否则界面说她留着 40 条、文档里只有 12 条。
      const keepCap = keepCount(config?.memory?.sleepKeep)
      const kept = keepCap === null ? model.beliefs.length : Math.min(model.beliefs.length, Math.max(keepCap, shownCap))
      const shown = Math.min(shownCap, kept)
      // 「折成一行」= 眼前那几条以外的全部（issue #67）：被上限挡掉的也并进了同一行
      // 「还有 N 条更早的」，只是不点名。只数 kept - shown 会让界面说 9 条、文档里那一行盖着 17 条。
      const folded = Math.max(0, model.beliefs.length - shown)
      const lastSleep = [...events].reverse()
        .find((e) => e?.type === 'meta' && String(e.text ?? '').startsWith('sleep:'))
      send(res, 200, {
        selfDoc: { bytes: doc.bytes, chars: pb.used, budget, usedRatio: pb.usedRatio, dropped: pb.dropped, mtime: doc.mtime },
        // 被预算挤掉的段（她这轮看不见的部分）——如实报，不要假装全都在
        sections: {
          beliefsShown: shown,
          beliefsFolded: folded,
          // 「总共留几条」挡在外面的：没丢，只是不再逐条占位（her_recall 翻得到）。已经算在 beliefsFolded 里。
          beliefsDropped: Math.max(0, model.beliefs.length - kept),
          refuted: model.refuted.length,
          // 「勇于拒绝」：和自主门同一个数（refusal 事件 + 话里明确拒绝，严格口径）。
          // 只报 refusals 会让界面出现「拒绝过 0 却过了自主门」——用户 2026-10-24 指出过。
          refused: model.facts?.refused ?? model.refusals.length,
          refusals: model.refusals.length,
          narrative: model.narrative ? 1 : 0,
          // 2026-10-24：她自己心里对不上的地方 / 已经固化的判断。
          // 给他看的是「有两句话对不上」这件事本身，不是让他去裁决。
          tensions: model.tensionsTotal ?? model.tensions?.length ?? 0,
          tensionFirst: model.tensions?.[0]
            ? { a: model.tensions[0].a.text, b: model.tensions[0].b.text, sim: model.tensions[0].sim }
            : null,
          solid: model.solidTotal ?? model.solid?.length ?? 0,
          // 2026-10-24：他的反应归因（接受/坚持/受伤/离开），以及"有后果"的那几种之和。
          // hurts 是第三块"疤"的入口，所以只报事实，不报分数。
          reactions: model.facts?.reactions ?? { accept: 0, insist: 0, hurt: 0, leave: 0, other: 0 },
          hurts: model.facts?.hurts ?? 0,
          // 最近三次拒绝的形状（原话 + 动作 + 对象 + 他的反应）
          refusals: model.refusals.slice(-3).map((r) => ({
            at: r.at, quote: r.quote ?? r.what, act: r.act ?? '', object: r.object ?? '', reaction: r.reaction ?? null,
          })),
          // 疤（P1 第三块）：没想通的有几件，以及第一件的原话。
          // 页面只显示数量与原话，不显示"该不该退让"——那是她的判断，不是系统的判断。
          scars: model.scars?.length ?? 0,
          scarsResolved: model.facts?.scarsResolved ?? 0,
          scarFirst: model.scars?.[0]
            ? { at: model.scars[0].at, quote: model.scars[0].quote, reaction: model.scars[0].reaction, conceded: model.scars[0].concedeText ?? null }
            : null,
          // 评论区里别人的话（2026-10-24，用户 m02454）：读到几条、几条被她认下。
          // 「认下」= 三天内她自己说过一句意思相近的；那条话本身已经是一条判断，不进这里。
          voices: model.facts?.voices ?? 0,
          voicesEchoed: model.facts?.voicesEchoed ?? 0,
          voiceLast: model.voices?.length
            ? {
                at: model.voices[model.voices.length - 1].at,
                text: model.voices[model.voices.length - 1].text,
                echoed: Boolean(model.voices[model.voices.length - 1].echoed),
              }
            : null,
          // 立场清单（2026-10-25，用户设计「纵向·立场」）。
          // 四道门走完才可能非零；没走完就是 0，不是"没长出来"，是"还没走到"。
          ...stanceSummary(buildStances(model)),
        },
        // 她的事有几条（2026-11-02，用户 m00335）：与 /state 的 counts.total 同一口径，
        // 只数她的、不数后台记账。eventsAll 是文件实际行数，供需要"账本多大"的地方用。
        events: countEvents(events).real,
        eventsAll: countEvents(events).all,
        diaries: diary.length,
        // 写过几篇（含被「日记留多久」清掉的），跟身份文档、her_diary 同一个口径（issue #67）。
        // diaries 仍是 diary/ 里现存的文件数。
        diariesWritten: diaryDatesWritten(diary, events).length,
        session: { turns: h.turns, rotateAfter: Number(config?.chat?.rotateAfter ?? 0), rotatedAt: h.rotatedAt },
        sleep: {
          everyDays: Number(config?.memory?.sleepEveryDays ?? 0),
          last: lastSleep ? String(lastSleep.text).slice(6, 16) : '',
        },
        recall: { days: 30, limit: 5 },
      })
    }],

    // ---- 记忆体检（0.7.6，2026-10-30 用户 m00342）----
    // 只读：拿账本按现在的规则算一遍，不写事件、不改配置。
    // 故意不做成「她自己的自我评估」：她看不到这些数，撞不到「不读自身数值」。
    ['/health', async (req, res) => {
      if (req.method !== 'GET') return send(res, 405, { error: '只接受 GET' })
      const { config } = await loadConfig(root)
      const { events } = await readEvents(root)
      send(res, 200, examine(events, { growthDays: config?.growthDays }))
    }],

    // ---- P3-3：桌面提醒 ----
    // GET 返回开关状态与「今天弹过没有」；POST { enabled } 改开关。
    // 弹窗本身在 scheduler 的唤醒流程里（lib/notify.js），这里只读/只改配置，
    // 不提供"点一下弹一条测试通知"——那会变成一个新的打扰源。
    ['/notify', async (req, res) => {
      const { config } = await loadConfig(root)
      if (req.method === 'POST') {
        const raw = await readBody(req)
        let body = {}
        try { body = JSON.parse(raw || '{}') } catch { return send(res, 400, { error: 'body 不是 JSON' }) }
        // 两种写：改开关（enabled），或记「今天已经弹过」（shown）。
        if (body.shown === true) {
          const r = await markShown(root, dateKey())
          return send(res, 200, { ok: r.ok, lastShown: r.lastShown, today: dateKey() })
        }
        if (typeof body.enabled !== 'boolean') return send(res, 400, { error: 'enabled 必须是 true/false，或 shown:true' })
        const next = await updateConfig({ notify: { enabled: body.enabled } }, root)
        return send(res, 200, {
          enabled: next.notify?.enabled === true,
          lastShown: next.notify?.lastShown ?? '',
          today: dateKey(),
        })
      }
      // GET 只回答「该不该提醒、提醒什么」。**弹是页面的事**——服务端
      // 不起任何子进程（原 PowerShell 方案已被杀软拦下并废弃）。
      const p = await readPending(root, { today: dateKey() })
      send(res, 200, { ...p, enabled: config.notify?.enabled === true })
    }],

    // ---- P4：她在 B 站说过什么 ----
    // GET 返回：开关、今日配额用量、今天发过的评论、有没有人回她。
    // 这里**只读**——真发评论走她的工具（bili_speak），不给人一个"代她发"的按钮。
    // 理由：代发就等于人替她说话，那她的人格是假的。
    ['/comment', async (req, res) => {
      const { events } = await readEvents(root)
      const { config } = await loadConfig(root)
      const dk = dateKey()
      const c = config.comment ?? {}
      // issue #62：「允许她上网」关着时 scanReplies 根本不去问，回的空列表不等于「没人回」。
      // 把这一点交给页面，卡片才不会印「没有新回复」。
      const online = biliOn(config)
      let replies = []
      if (c.enabled === true && online) {
        // 有人点开看才去问 B 站，避免没打开开关还每 30 分钟去敲一次接口
        replies = await scanReplies({ root, events, dateKey: dk }).catch(() => [])
      }
      send(res, 200, {
        enabled: c.enabled === true,
        online,
        perDay: Number(c.perDay ?? 0),
        usedToday: commentCountToday(events, dk),
        replyPerDay: Number(c.replyPerDay ?? 0),
        replyUsedToday: replyCountToday(events, dk),
        replyToReplies: c.replyToReplies !== false,
        scanEveryMin: Number(c.scanEveryMin ?? 30),
        window: c.window ?? [],
        mine: herComments(events, dk),
        waiting: replies.slice(0, 5).map((x) => ({ rpid: x.rpid, bvid: x.bvid, user: x.user, text: x.text, fromOwner: x.fromOwner === true })),
        waitingCount: replies.length,
        // 2026-11-07：他的话单算一格。状态行原来只有「有 N 条没回」，
        // 主人自己回一句也被算成陌生人的存量（用户反馈）。
        waitingOwnerCount: replies.filter((x) => x.fromOwner === true).length,
      })
    }],

    // ---- 运行日志导出（2026-10-24）----
    // 用户点名要「运行日志导出」。它的价值不在"能看到日志"，而在**出事之后能拿到现场**：
    // 她某晚没说话、没刷站、没写日记，只看设置页是猜不出来的。
    // 三条路由刻意分开：预览（小）、导出（大、纯文本、给 AI 看）、清空（单独一次点击）。
    ['/log', async (req, res) => {
      if (req.method !== 'GET') return send(res, 405, { error: '只支持 GET' })
      const url = new URL(req.url, 'http://x')
      const lines = Math.max(10, Math.min(500, Number(url.searchParams.get('lines') ?? 60) || 60))
      const tail = tailLog(root, { lines })
      return send(res, 200, {
        ...tail,
        dir: logsDir(root),
        maxBytes: LOG_MAX_BYTES,
        keep: LOG_KEEP,
      })
    }],

    ['/log/export', async (req, res) => {
      if (req.method !== 'GET') return send(res, 405, { error: '只支持 GET' })
      const url = new URL(req.url, 'http://x')
      const lines = Math.max(50, Math.min(2000, Number(url.searchParams.get('lines') ?? 300) || 300))
      // 自检要按「真宿主」跑：不传 config 与 host 的话，导出里会假报
      // 「宿主接口缺失」「没有时段配置」——那会让看日志的人按错误线索排查。
      const { config } = await loadConfig(root).catch(() => ({ config: null }))
      let checks = null
      try {
        checks = await runChecks({
          root,
          config,
          host: {
            sessionController: ctx.get?.('sessionController') ?? ctx.sessionController,
            webServer: ctx.get?.('webServer') ?? ctx.webServer,
            connection: ctx.get?.('connection') ?? ctx.connection,
          },
          tools: ctx.get?.('tools') ?? ctx.tools,
          net: false,
          now: new Date(),
          preset: config?.tools?.preset ?? '',
          sessionPreset: (await homeStatus(root))?.preset ?? '',
          restrict: readRestrictState(),
          restrictEnabled: config?.tools?.restrict !== false,
        })
      } catch (err) {
        checks = { summary: `自检跑不动：${String(err?.message ?? err)}`, items: [] }
      }
      // 「她看不见画面」有一半原因在模型本身：模型不吃图，采到帧也白搭。
      // 这一行以前完全没有，导出包里查不出来，所以单独探一次（只读、失败不影响导出）。
      let model = null
      try {
        const h = await homeStatus(root)
        model = await resolveHerModel(ctx, h?.sessionId)
      } catch (err) {
        model = { provider: '', model: '', imageInput: null, why: `读不到：${String(err?.message ?? err)}` }
      }
      const text = buildBundle(root, {
        checks,
        version: deps.version ?? '',
        restrict: readRestrictState(),
        config: redactConfig(config),
        model,
        lines,
      })
      // 纯文本直出，不套 JSON：这个接口的产物是给人（和别的 AI）读的，不是给程序解析的。
      res.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'content-disposition': `attachment; filename="dsh-fish-log-${dateKey()}.txt"`,
      })
      res.end(text)
    }],

    ['/log/clear', async (req, res) => {
      if (req.method !== 'POST') return send(res, 405, { error: '只支持 POST' })
      const r = clearLog(root)
      logLine('info', ['日志被手动清空（来自设置页）'], root)
      return send(res, 200, r)
    }],

    // ---- 迁移工作区（2026-10-28，用户 m06510）----
    // GET  → 现在住哪、有多少东西、能不能立刻搬（给按钮旁的说明用）
    // POST { target } → 搬到 target 里（新位置 = <target>\dsh-fish；target 本身已经是一份档时拒绝，两边都不动）
    // 语义是「复制 + 验字节 + 写指针 + 旧目录改名封存」，见 lib/move.js 头注释。
    // **重启 DSH 才生效**：root 是在 apply() 里算一次的东西。
    ['/move', async (req, res) => {
      if (req.method === 'GET') {
        const st = await moveStatus(root)
        return send(res, 200, { ...st, canPick: true })
      }
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
      const raw = await readBody(req, 20_000)
      let b = null
      try { b = JSON.parse(raw || '{}') } catch { return send(res, 400, { error: 'body 不是合法 JSON' }) }
      const r = await moveRoot(ctx, { root, target: b.target, log: (m) => logLine('info', [m], root) })
      if (!r.ok) return send(res, 409, { ok: false, error: r.why })
      // 搬完到重启之间这边只读：事件流的写入口已经在 move.js 里封了（sealRoot），
      // 这里把占用状态也原地改成只读，观察者、建会话、设置页的「可写」都跟着同一句理由走。
      // 原地改（不换对象）：有几处拿的是 tenancy.tenant 这个对象本身。
      // 不改的话 15 秒后心跳续不上，也会变只读，但理由会说成「被另一个实例接管了」。
      const t = deps.tenancy?.tenant
      if (t && t.ok !== false) {
        t.ok = false
        t.why = '数据文件夹刚搬到了新位置，重启 DSH 之前这边只读，她记不下新的事。'
      }
      send(res, 200, r)
    }],

    // ---- P4：把她放回第一天 ----
    // GET  → 将要封存什么（给确认框用）；POST { confirm: 'reset' } → 改名封存 + 重开。
    // 必须带 confirm 字面量：这不是一个能误触的按钮。
    // ---- 备份与恢复（2026-10-25，发布体检第 2 项）----
    // 为什么是单文件 json 而不是 zip：不引依赖，双击能看，能直接发出去。
    // 恢复的语义是「先封存再放回」（见 lib/backup.js 的头注释），不是覆盖删除。
    ['/backup', async (req, res) => {
      if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' })
      // 恢复上限也交给打包那一步：事件流（连同包的外壳）装得下时，别的文件挑着放，整份包都装得下。
      const b = await collectBackup(root, { restoreLimit })
      // fileName 给浏览器当下载名；它在 checkBundle 里是多余字段，恢复时会被忽略。
      const out = { ...b, fileName: backupFileName(), restoreLimit }
      // 事件流不设上限（issue #65），包就可能比恢复接口收得下的大。设置页存文件、
      // 恢复时 POST 的都是把这个对象 JSON.stringify 一次的结果，先量一遍，超了导出时就说，
      // 不要等到恢复那天才发现（只有事件流连同包的外壳就装不下时才会超）。bundleBytes 不再整包
      // stringify 一遍，文件内容按长度算。restoreBytes / fitsRestore 两个字段自己还没算进去，留 64 字节。
      const restoreBytes = bundleBytes(out) + 64
      send(res, 200, { ...out, restoreBytes, fitsRestore: restoreBytes <= restoreLimit })
    }],

    ['/backup/restore', async (req, res) => {
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
      // ?skipBad=1：人已经看过坏文件名单，选了「跳过这些文件继续恢复」（issue #65）。
      const skipBad = /[?&]skipBad=1(?:&|$)/.test(String(req.url ?? ''))
      let raw = ''
      try {
        // 备份体里可能本来就带替换符（旧包），不拿「正文是不是 UTF-8」整包拦（issue #65）。
        raw = await readBody(req, restoreLimit, { mojibake: false })
      } catch (err) {
        // 超了先把原因回出去：原来是直接断连接，界面上只剩一条看不懂的网络错误。
        if (err?.statusCode === 413) {
          return send(res, 413, {
            ok: false,
            error: `这份备份超过了恢复一次能收的 ${sizeText(restoreLimit)}，从这里装不回去，现在的档什么都没动。换机器的话，在原来那台上把数据文件夹整个复制过来。`,
          })
        }
        throw err
      }
      let b = null
      try { b = JSON.parse(raw || '{}') } catch { return send(res, 400, { error: 'body 不是合法 JSON' }) }
      const r = await restoreBackup(b, root, { skipBad })
      if (!r.ok) {
        // issue #65：先点名，再让人选跳不跳过。这时候旧档、新档都还没动。
        if (r.needDecision) {
          return send(res, 409, {
            ok: false,
            needDecision: true,
            error: r.why,
            badFiles: r.badFiles,
            badCount: r.badCount,
          })
        }
        return send(res, 409, { ok: false, error: r.why })
      }
      send(res, 200, {
        ok: true,
        restored: r.restored,
        quarantined: r.quarantined,
        // 导出时就没打进包的文件，恢复出来也不会有。照报成功会让人以为全回来了。
        skipped: r.skipped,
        // skipped 最多带前 200 条，回执报的条数用这个
        skippedCount: r.skippedCount,
        // 包里只记了个数、没写名字的（事件流顶到恢复上限附近时才有），已经算在 skippedCount 里
        skippedUnlisted: r.skippedUnlisted,
        // 人选的「跳过碎字文件」：这些没写回去，其余照常（issue #65）
        skippedBad: r.skippedBad,
        note: '重启 DSH 之后她才是这份档的样子。',
      })
    }],

    // ---- 导入别人养过的大肥鱼（2026-10-27，用户 m03170 / m03201）----
    // GET  → 现在能不能导（有没有起点）+ 交接文档该长什么样
    // POST { text, source } → 写进去
    // 只认「还没有起点」的一局：她已经有 seed 时拒绝，让用户自己先重置，
    // 不替他做「覆盖掉一个已经在长的她」这种决定。
    ['/import', async (req, res) => {
      if (req.method === 'GET') {
        const { events } = await readEvents(root).catch(() => ({ events: [] }))
        // 和 POST 用同一个判断（issue #65）：重开之后只有启动补的默认起点，也算还能导。
        const blocked = hasOwnStart(events)
        // 这一位是不是接来的，只认事件流（用户 m03769）。配置里不再存这件事。
        const { config } = await loadConfig(root).catch(() => ({ config: null }))
        const model = deriveSelf(events, { growthDays: config?.growthDays })
        return send(res, 200, {
          canImport: !blocked,
          reason: blocked ? '她已经有自己的起点了。想换成别人养的那一位，先重置成新的一局。' : '',
          persona: { imported: model?.persona?.imported === true, source: model?.persona?.source ?? '' },
          template: IMPORT_TEMPLATE,
        })
      }
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
      const raw = await readBody(req, 200_000)
      let b = {}
      try { b = JSON.parse(raw || '{}') } catch { return send(res, 400, { error: 'body 不是合法 JSON' }) }
      // 来源跟着导入动作一起写进事件流（meta / import-mark:），不再写配置。
      const r = await applyHandover(b.text, root, {
        log: (m) => console.log('[dsh-fish]', m),
        source: b.source ? String(b.source) : '',
      })
      if (!r.ok) return send(res, 409, { ok: false, error: r.why })
      // 身份文档立刻重算：不然要等下一次她开口才换成人设，设置页会显示"还没变"。
      await refreshSelfDoc(root).catch(() => {})
      const { events } = await readEvents(root).catch(() => ({ events: [] }))
      // 配置读不出来（比如白名单就是因为它没写进去）也照样回执：人设已经写进去了，
      // 这里一抛，界面就会说「导入失败」，toolsError 那句也出不来。
      // （deriveSelf 的第二个参数不能是 null，读不出来就不传，按默认的成长周期算。）
      const cfgNow = await loadConfig(root).then((x) => x.config, () => undefined)
      const model = deriveSelf(events, cfgNow)
      send(res, 200, {
        ok: true,
        name: r.name,
        tools: r.tools,
        toolsAdded: r.toolsAdded ?? [],
        // 白名单没写进去时的原因；回执要直说，不能写成「这次新加 0 个」
        toolsError: r.toolsError ?? '',
        bodyChars: r.bodyChars,
        // 把导入之后她的实际状态报回去，让界面能说「现在是第 1 天、她管你叫 X」
        day: model.day,
        stage: model.stage,
        called: model.name,
        note: '人设已经接过来。她是从第 1 天开始的，往后按你和她的事自己长。',
      })
    }],

    // ---- 出门 / 请神（0.6.3，方案见 docs/E-出门与请神-方案.md）----
    // 出门 = 在选中的工作区新开一条**她的**会话，完整权限，首轮由这里递话。
    // 请神 = 到这个页签的另一半，但 0.6.3 **还没启用**：宿主身份段名要在运行期确认，
    // 猜一个名字写死等于把她的身份挂到一句不存在的段上（静默失效，最难查）。
    ['/outing', async (req, res) => {
      if (req.method === 'GET') {
        const away = await awayNow(root)
        const { outings } = await readOutings(root)
        const { possessions } = await readPossessions(root)
        // 可选工作区：宿主 registry 里的全部工作区，**排除她自己的家**
        let workspaces = []
        let why = ''
        try {
          const reg = safeGet(ctx, 'workspaceRegistry')
          const list = typeof reg?.list === 'function' ? reg.list() : []
          const homeDir = pathKey(join(paths(root).root, 'home'))
          workspaces = list
            .filter((w) => w && pathKey(w.path) !== homeDir)
            .map((w) => ({
              id: String(w.id ?? w.workspaceId ?? ''),
              title: String(w.title ?? ''),
              path: String(w.path ?? ''),
              // 插件源码目录：这趟风险最高——她读 lib/rules.js 等于读到完整禁令清单
              risky: isPluginSource(w.path),
              // 这个工作区上一趟的会话（能复用就接着用，不必每次新开一条）
              last: lastOutingForCwd({ outings }, w.path),
            }))
            .filter((w) => w.id)
          if (!list.length) why = '宿主没有可列的工作区（workspaceRegistry 不可用）'
        } catch (err) {
          why = `列工作区失败：${String(err?.message ?? err).slice(0, 120)}`
        }
        // 出门口袋：路径、有没有登记成工作区、目录在不在。UI 拿它画「送她去口袋」。
        let pocket = { path: '', workspaceId: '', registered: false, exists: false }
        try {
          const { config } = await loadConfig(root)
          const dir = pocketDirPath(config)
          const reg = safeGet(ctx, 'workspaceRegistry')
          const list = typeof reg?.list === 'function' ? reg.list() : []
          const found = list.find((w) => w && pathKey(w.path) === pathKey(dir))
          pocket = {
            path: dir,
            workspaceId: String(found?.id ?? found?.workspaceId ?? ''),
            registered: Boolean(found),
            exists: fs.existsSync(dir),
            // 口袋也记「上次那趟」（2026-10-30 用户 m00972）：勾了就地接着上次那条会话，
            // 不勾就新开一条。台账里认的是 cwd，口袋的 cwd 是固定值，所以天然对得上。
            last: lastOutingForCwd({ outings }, dir),
          }
        } catch (err) {
          pocket.why = String(err?.message ?? err).slice(0, 120)
        }
        // 外面那条现在看事件流动过没有：回家审查卡要在点「叫她回家」之前就能看见，
        // 而不是点完才知道要不要拒收。这里只比对、不写盘。
        const liveVerify = away.kind === 'outing' ? verifyEvents(join(root, 'events.jsonl'), away.outing?.baseline) : null
        // 这一趟多出来的条目：回家审查卡要逐条摊开，默认全勾。
        // 和回家结算同一个口径（issue #68）：只收这趟那条会话写的，记账 meta 不摆。
        const since = away.kind === 'outing'
          ? tripEvents(join(root, 'events.jsonl'), away.outing, { limit: 300 })
          : { ok: false, total: 0, items: [], why: '没在外面' }
        // 她这趟留的话（0.6.16）：her_leave 写的是**家里**的事件流与信箱，
        // 出门页把这几句摊开，回家时人能看到她在外头主动说过什么。
        let letters = []
        if (away.outing?.startedAt) {
          try {
            const { events } = await readEvents(root)
            letters = lettersSince(events, {
              since: away.outing.startedAt,
              sessionId: away.outing.sessionId || '',
              limit: 6,
            })
          } catch { letters = [] }
        }
        // 「这趟出去几天」：状态卡与最近几趟都按这个口径显示（天数，不写情绪）。
        const trip = away.outing ? tripDays(away.outing) : 0
        // 旅行日记与纪念品（0.6.17）：每趟写了几篇日记、带回来几件。
        // 日记本体仍在 diary/YYYY-MM-DD.md，这里只数 meta 里的趟次标记。
        let keepsakes = { pending: [], recent: [] }
        const diariesByTrip = new Map()
        try {
          keepsakes = { pending: pendingKeepsakes(root), recent: recentKeepsakes(root, 6) }
          const { events } = await readEvents(root)
          for (const ev of events) {
            if (ev?.type !== 'meta') continue
            const m = /^diary:\S+(?: trip:(\S+))?$/.exec(String(ev.text ?? ''))
            if (m && m[1]) diariesByTrip.set(m[1], (diariesByTrip.get(m[1]) ?? 0) + 1)
          }
        } catch { /* 数不出来就按 0 算，不影响别的 */ }
        const keptByTrip = new Map()
        for (const it of readKeepsakes(root).items) {
          if (it?.status !== 'kept' || !it.trip) continue
          keptByTrip.set(it.trip, (keptByTrip.get(it.trip) ?? 0) + 1)
        }
        const tripsWithCounts = outings.map((o) => ({
          ...o,
          diaries: diariesByTrip.get(tripKey(o)) ?? 0,
          keepsakes: keptByTrip.get(tripKey(o)) ?? 0,
        }))
        // 在外面的这一条到底是谁（0.6.26，用户 m03194）：界面要写清「哪个工作区的那条对话」。
        // 光有台账不够——0.6.25 真机上出现过「台账写进去了，但装配那一步没走完」的幽灵出门：
        // 界面说在外面，实际身份段/守卫一段没挂。这里把「挂了几段」一起回给界面，
        // 让这种情况当场看得见，而不是等她想写点东西时才发现自己不是她。
        // 这趟是不是去的园区（issue #68）：按登记的工作区 id 或目录认，不按名字猜——
        // 园区那趟的工作区名是「工作园区」，跟目录名对不上；叫这个名字的普通工作区也不是园区。
        const atPocket = away.kind === 'outing' && Boolean(
          (pocket.workspaceId && String(away.outing?.workspaceId ?? '') === pocket.workspaceId) ||
          (pocket.path && pathKey(away.outing?.cwd) === pathKey(pocket.path)))
        let awayInfo = { ...away, line: awayLine(away), verify: liveVerify, since, tripDays: trip, atPocket }
        if (away?.kind) {
          const rec = away.kind === 'outing' ? away.outing : away.possession
          const sid = String(rec?.sessionId ?? '')
          const live = liveAgentOf(ctx, sid)
          const mounted = live ? mountedCount(live) : 0
          awayInfo = {
            ...awayInfo,
            sessionId: sid,
            sessionShort: sid.replace(/^session-/, '').slice(0, 8),
            sessionTitle: live ? clipTitle(titleOfAgent(ctx, live)) : '',
            tripNo: away.kind === 'outing' ? tripNoOf({ outings }, sid, Number(rec?.startedAt ?? 0)) : 0,
            equipped: mounted > 0,
            warning: mounted > 0 ? '' : '这趟没接好（她的人设和护栏都没装上去）。先叫她回家，再重新出门一次。',
          }
        }
        // 0.6.32（用户 2026-10-29 真机要求）：上一次被拒收的那趟要能看见、能复核。
        // 之前 pending 是单向的——这趟不再是 active，界面只剩「等确认」三个字，
        // 没有原因、也没有下一步，只能手工改台账。这里把原因和复核入口一起回给界面。
        let pendingReview = null
        try {
          const pend = pendingOf({ outings })
          if (pend) {
            const pv = verifyEvents(join(root, 'events.jsonl'), pend.baseline)
            const psid = String(pend.sessionId ?? '')
            pendingReview = {
              sessionId: psid,
              sessionShort: psid.replace(/^session-/, '').slice(0, 8),
              workspaceName: pend.workspaceName || pend.workspaceId || '别的工作区',
              ...pendingCard(pend, pv),
            }
          }
        } catch { /* 复核信息拿不到不影响别的 */ }
        return send(res, 200, {
          ok: true,
          why,
          away: awayInfo,
          pendingReview,
          identityFrozen: Boolean(away.outing?.identity),
          outings: tripsWithCounts.slice(-20).map(ledgerBrief),
          possessions: possessions.slice(-20).map(ledgerBrief),
          letters,
          keepsakes,
          workspaces,
          pocket,
          // 出门页从 0.8.0 起对所有人可见（2026-10-30，用户 m01904）；
          // dev 仍带回去，留给「开发副本」的其它判断，不再用来藏页签。
          dev: true,
          // 一次性确认：说明卡看过一遍。没确认时界面把三个入口按钮先挡住。
          ack: ((await loadConfig(root).catch(() => ({ config: null }))).config?.outing ?? {}).ack === true,
        })
      }
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
      const raw = await readBody(req, 20_000)
      let b = {}
      try { b = JSON.parse(raw || '{}') } catch { return send(res, 400, { error: 'body 不是合法 JSON' }) }
      const action = String(b.action ?? '')

      // 出门的一次性确认（2026-10-30，用户 m01904）：点过「我知道了」才把三个入口放开。
      // 只记本地配置，不是开关；挪了数据目录要重新点一次，这是有意的。
      if (action === 'ack') {
        await updateConfig({ outing: { ack: true } }, root)
        logLine('info', ['出门：确认了测试版说明'], root)
        return send(res, 200, { ok: true })
      }

      // 纪念品点头 / 摇头（0.6.17）：只有这一步才会真的复制文件。
      if (action === 'keepsake') {
        const said = b.yes === true
        const r = decideKeepsake(root, { id: String(b.id ?? ''), yes: said })
        logLine('info', ['纪念品：', said ? '准了' : '没带', r.item?.rel ?? '', r.item?.id ?? ''], root)
        return send(res, r.ok ? 200 : 409, { ok: r.ok, item: r.item ?? null, note: r.note, ...(r.ok ? {} : { error: r.note }) })
      }

      // 复核上一次被拒收的那趟（0.6.32）：文件还原后重新比对，通过就当场收下。
      // 之前 pending 是死路——这趟不再是 active，再点「收下」只会得到「她没在外面」。
      if (action === 'review') return settleSerial(root, async () => {
        const { outings } = await readOutings(root)
        const pend = pendingOf({ outings })
        if (!pend) return send(res, 409, { ok: false, why: '现在没有等着核对的那趟', error: '现在没有等着核对的那趟' })
        const off = reviewTargetMismatch(pend, b)
        if (off) return send(res, 409, { ok: false, why: off, error: off })
        const v = verifyEvents(join(root, 'events.jsonl'), pend.baseline)
        if (!passesReview(v)) {
          logLine('info', ['复核：还是对不上', v.why ?? ''], root)
          return send(res, 409, { ok: false, why: v.why || '文件还是对不上', verify: v })
        }
        // issue #68：挂 pending 时整趟先标了「不算数」，复核通过要按人当时的选择
        // 把其余的捞回来（追加 keep，不删原标记——事件流只追加），结的是核对过的这一趟。
        const s = await settleTripReview(ctx, root, 'outing', pend, settlePending)
        if (!s.ok) {
          logLine('warn', ['复核：没结算', s.why], root)
          return send(res, s.code, { ok: false, why: s.why })
        }
        const r = s.settled
        logLine('info', ['复核：通过，这趟收下了', r.outing?.workspaceName || '', v.why ?? '', s.dropped ? `不算 ${s.dropped} 条` : ''], root)
        return send(res, 200, { ok: true, outing: r.outing, verify: v, kept: s.kept, rejected: s.dropped, note: s.note })
      })

      if (action === 'end') return settleSerial(root, async () => {
        const away = await awayNow(root)
        if (away.kind !== 'outing') return send(res, 409, { ok: false, why: '她没在外面', away })
        // 事件流被动过 → 默认拒收（用户 m08176 拍板）：这趟先不算数，等人复核。
        // 但「追加」是正常写入（growth_commit），不据此拒收——理由见 outing.js 的 verifyEvents。
        // 取消勾选 / 整趟不算 / 对不上时先整趟标掉，都是追加 meta 记下 id（不删行——第 5 条铁律），
        // deriveSelf 读到就跳过那些条目，原文仍在事件流里。0.7.4（用户 m00659 A）起「整趟不算」
        // 真的把这趟的条目都标上；issue #68 起对不上时也照人的选择存下来，复核时照办。
        const { v, tampered, rejectedIds, pendingRejectedIds, autoRejected, marked } =
          await settleTripEnd(root, 'outing', away.outing, b)
        if (!marked.ok) logLine('warn', ['回家：取消勾选的标记没写进去', marked.why], root)
        // 标记没写进去（或没写全）时这趟不落成终态，留在等复核，复核时照人的选择补写（issue #68）。
        const unsettled = tampered || !marked.ok
        const status = unsettled ? 'pending' : b.kept === false ? 'rejected' : 'done'
        const r = await endOuting(root, {
          status,
          kept: unsettled ? null : b.kept === false ? false : true,
          rejectedIds,
          pendingRejectedIds,
          autoRejected,
          marked: marked.ok,
        })
        if (!r.ok) return send(res, 409, { ok: false, why: r.why })
        logLine('info', [`回家：${status}`, r.outing?.workspaceName || r.outing?.workspaceId || '', v.why ?? '', autoRejected ? `整趟不算（${rejectedIds.length} 条）` : ''], root)
        // 家里那条会话每轮读的是落盘的身份文档：标记写完当场重写，不等下一次别的事触发（issue #68）。
        await refreshSelfDoc(root).catch(() => {})
        // 回家这一刻，「这条会话还算不算她的」就有了答案：不再算 → 当场拆掉
        // 身份段 / 处境段 / 兜底守卫（0.6.16）。不等进程退出，也不靠重启。
        const outSid = String(r.outing?.sessionId || away.outing?.sessionId || '')
        const outAgent = liveAgentOf(ctx, outSid)
        const detached = outAgent ? detachOutside(outAgent) : { ok: false, removed: 0 }
        if (detached.ok) logLine('info', ['回家：拆掉外面的装备', `${detached.removed} 段`], root)
        // 拆掉装备 ≠ 让它忘掉刚才那一段（2026-10-30 用户 m03179 真机发现）：
        // 那条会话的历史是 append-only，回家后它还会顺着自己上一句「我是大肥鱼」演。
        // 补一条可见的交接句；会话当时没开着就排队，下次打开由 deliverQueued 补投。
        const closeText = outingClosedText({ workspaceName: r.outing?.workspaceName })
        let outNote = { ok: false, why: '那条对话现在没开着' }
        if (outAgent) {
          outNote = appendNote(outAgent, closeText)
          if (!outNote.ok) logLine('warn', ['回家：交接句没写进去', outNote.why], root)
        } else if (outSid) {
          outNote = await queueNote(root, closeText, { sessionId: outSid })
          if (!outNote.ok) logLine('warn', ['回家：交接句没排上队', outNote.why], root)
        }
        // 驳回要讲给她听（设计 §3.7，用户 m01613 第①条）：
        // 不是「你没去过」，而是「那几条我不认，它不算你」。写进**家里**那条会话。
        // 出门与请神共用同一个落点（2026-10-29 m02241 第②条）。
        // 标记没写进去的那趟眼下照算，这时不跟她说「不算」；复核补上标记时再讲。
        let note = { ok: false, why: '这趟没有要驳回的' }
        if (!unsettled && rejectedIds.length) {
          note = await rejectNoteToHome(ctx, root, { trip: away.outing, rejectedIds, auto: autoRejected })
          if (!note.ok) logLine('warn', ['回家：驳回话术没写进去', note.why], root)
        }
        return send(res, 200, {
          ok: true,
          outing: r.outing,
          verify: v,
          tampered,
          rejected: rejectedIds.length,
          // 对不上时先整趟标成不算的条数；标记没写进去时如实说，界面不能再说「全部跳过」。
          held: marked.ok ? pendingRejectedIds.length : 0,
          marked: marked.ok,
          ...(marked.ok ? {} : { markWhy: marked.why, markedPart: marked.lines > 0 }),
          autoRejected,
          detached,
          note,
          outNote,
        })
      })

      if (action === 'start') {
        // 出门口袋（干活模式）：一个从没写过记忆的空工作区，注入只剩骨架。
        const wantPocket = Boolean(b.pocket)
        let wsId = String(b.workspaceId ?? '').trim()
        if (!wantPocket && !wsId) return send(res, 400, { error: '要选一个工作区' })
        const away = await awayNow(root)
        if (away.kind) return send(res, 409, { ok: false, why: '她已经在外面了', away })
        const sc = safeGet(ctx, 'sessionController')
        if (!sc?.create) return send(res, 503, { ok: false, why: '宿主没有 sessionController 服务' })
        // 目标工作区的路径：registry.list() 里的 path（用来记台账与判风险）
        let wsPath = ''
        let wsTitle = ''
        if (wantPocket) {
          const { config } = await loadConfig(root)
          const p = await ensurePocket(ctx, root, config)
          if (!p.ok) return send(res, 500, { ok: false, why: p.why })
          wsId = p.wsId
          wsPath = p.dir
          wsTitle = POCKET_TITLE
          if (!p.registered) {
            logLine('warn', ['出门：口袋没登记成工作区', p.why ?? '', p.dir], root)
          }
        } else {
          try {
            const reg = safeGet(ctx, 'workspaceRegistry')
            const row = (typeof reg?.list === 'function' ? reg.list() : []).find(
              (w) => String(w?.id ?? w?.workspaceId ?? '') === wsId,
            )
            wsPath = String(row?.path ?? '')
            wsTitle = String(row?.title ?? '')
          } catch { /* 拿不到就当没名字，不挡出门 */ }
        }
        const baseline = snapshotEvents(join(root, 'events.jsonl'))
        // 出门那一刻的身份快照：存进台账，她在外面读这个，不再读家里那份可变文件。
        const identity = identityText(root)
        // 复用同一趟（0.6.16，用户 m01613）：接着上次那条会话，而不是每趟新开。
        // 规则：一条会话算她的，仅当有一趟 active 出门指向它；这条新记录只是换了
        // 记录去指向同一个 sessionId，历史那趟仍留在台账里。
        const reuseId = String(b.sessionId ?? '').trim()
        let reusePrev = null
        if (reuseId) {
          const { outings } = await readOutings(root)
          reusePrev = outings.find((o) => o && String(o.sessionId ?? '') === reuseId) ?? null
          if (!reusePrev) return send(res, 409, { ok: false, why: '台账里找不到这条会话的出门记录' })
          if (wsPath && pathKey(reusePrev.cwd) !== pathKey(wsPath)) {
            return send(res, 409, { ok: false, why: '这条会话上次去的是别的工作区，不能接过来' })
          }
          if (!wsPath) wsPath = String(reusePrev.cwd ?? '')
          if (!wsTitle) wsTitle = String(reusePrev.workspaceName ?? '')
        }
        // **先记账，再建会话**：`sc.create()` 会同步触发宿主的 `agent/created`，
        // identity.js 那条钩子必须已经看得到这次出门，否则她的身份段与兜底守卫
        // 都不会挂上——0.6.3 真机第一趟踩的就是这个顺序。
        const r = await startOuting(root, { sessionId: reuseId, workspaceId: wsId, workspaceName: wsTitle, cwd: wsPath, baseline, identity })
        if (!r.ok) return send(res, 409, { ok: false, why: r.why })
        if (!wsId && !wsPath) return send(res, 400, { error: '要选一个工作区' })
        // 先落一行「出门」（0.6.26，用户 m03194）：以前装配那一段跑在日志之前，中间任何一步
        // 抛错都会只留下台账里一条 active、日志里什么都没有——0.6.25 真机出现的「幽灵出门」。
        // 先写一行，再装配，装配完再写一行；两行都在才算这趟真的挂上了。
        const { outings: allOutings } = await readOutings(root)
        const tripNo = reuseId ? tripNoOf({ outings: allOutings }, reuseId, Number(r.outing?.startedAt ?? 0)) : 1
        logLine('info', ['出门：', wsTitle || wsId, reuseId ? `（接回第 ${tripNo} 趟）` : '（新开一条）', wsPath], root)
        let sessionId = reuseId
        try {
          if (reuseId) {
            // 挂着的老会话：`agent/created` 不会再触发，这里直接把装备挂回去。
            const live = liveAgentOf(ctx, reuseId)
            if (live) {
              attachIdentity(live, root, { frozen: identity, herDir: paths(root).herDir })
              const g = attachAwayGuard(live, { root, herDir: paths(root).herDir, log: (m) => logLine('info', [m], root) })
              if (!g.ok) logLine('warn', ['出门：接回的老会话兜底守卫没挂上', g.why ?? ''], root)
              await bindOutingSession(root, { sessionId })
            } else {
              // 宿主 `create({sessionId})` 只复用**空白**会话（跑过 turn 会静默新开一条），
              // 所以接回上次那趟必须让宿主把那条会话恢复起来。
              // 0.6.26 真机踩过：这版宿主的 `sessionController` 没有 `resume`（Remote 面只有
              // list/create/prompt/cancel/page/follow…），正确入口是 `resolveAgent(sessionId)`
              // ——它内部 resolve → resume，且把并发恢复去重，返回 `{ agent }` 或 `{ error }`。
              const back = await resolveSessionAgent(sc, reuseId)
              // 恢复之后宿主的 agent/created 可能已经补挂过；没挂上就在这里补一次并记下来。
              if (back && mountedCount(back) === 0) {
                attachIdentity(back, root, { frozen: identity, herDir: paths(root).herDir })
                attachAwayGuard(back, { root, herDir: paths(root).herDir, log: (m) => logLine('info', [m], root) })
              }
            }
            // 上一趟回家时这条会话要是没开着，交接句排在队列里——接回它的这一刻补投，
            // 否则她会带着上一次「我是大肥鱼」的余味继续（2026-10-30 用户 m03179）。
            const resumed = liveAgentOf(ctx, sessionId)
            if (resumed) void deliverQueued(resumed, root).catch(() => {})
          } else {
            // 口袋没登记成工作区时退到 `cwd`——照样能开门，只是记忆分区可能落在「未知工作区」。
            const created = wsId ? await sc.create({ workspaceId: wsId }) : await sc.create({ cwd: wsPath })
            sessionId = String(created?.sessionId ?? created?.id ?? '')
            if (!sessionId) throw new Error('宿主没返回会话 id')
            // 会话 id 补进台账；agent/created 那边如果已经认出来并补过，这一步是幂等的。
            await bindOutingSession(root, { sessionId })
          }
          // 首轮必须走 sc.prompt：她的身份段挂在 system prompt 上，冷启动就要生效。
          // 不能 await（这一轮要等模型跑完），signal 是宿主必填参数（issue #1）。
          // 接回上次那趟时不重念「你出门了」，只说一句还在那边。
          const wakeText = reuseId
            ? `又出门了，还在「${wsTitle || wsPath || '那边'}」。接着上次的做，家里人在叫你回去。`
            : outingWakeText(wsTitle || wsPath || '别的工作区')
          if (typeof sc.prompt === 'function') {
            void sc.prompt({
              requestId: `outing-${sessionId}-${Date.now()}`,
              sessionId,
              mode: 'queue',
              content: [{ type: 'text', text: wakeText }],
            }, new AbortController().signal).catch((err) => {
              logLine('warn', ['出门首轮没递进去', String(err?.message ?? err).slice(0, 120)], root)
            })
          }
        } catch (err) {
          const why = String(err?.message ?? err).slice(0, 160)
          const live = liveAgentOf(ctx, reuseId || sessionId)
          if (live) detachOutside(live)
          try { await abortOuting(root, { force: true }) } catch { /* 撤不掉也要把错误说出去 */ }
          logLine('warn', ['出门：装配失败，已经把这趟撤掉了', why], root)
          return send(res, 500, { ok: false, why: `出门没装配完，已经撤掉这趟：${why}` })
        }
        const equipped = mountedCount(liveAgentOf(ctx, sessionId)) > 0
        logLine('info', ['出门：装配完成', wsTitle || wsId, `会话 ${sessionId}`, equipped ? '装备挂上了' : '装备一段都没挂上'], root)
        return send(res, 200, { ok: true, outing: r.outing, reused: Boolean(reuseId), sessionId, tripNo, equipped, workspaces: [] })
      }

      send(res, 400, { error: 'action 只能是 start 或 end' })
    }],

    ['/ask', async (req, res) => {
      if (req.method === 'GET') {
        const { events } = await readEvents(root)
        return send(res, 200, {
          ok: true,
          kinds: ASK_KINDS,
          quota: quotaOf(events),
          pending: pendingAsks(events).map((e) => ({
            id: e.id,
            ts: e.ts,
            kind: String(e?.ask?.kind ?? ''),
            subject: String(e?.ask?.subject ?? ''),
            question: String(e.text ?? ''),
            options: Array.isArray(e?.ask?.options) ? e.ask.options : [],
          })),
          items: askView(events),
        })
      }
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
      const body = await readBody(req)
      let b = {}
      try { b = JSON.parse(body || '{}') } catch { return send(res, 400, { error: 'body 不是合法 JSON' }) }
      if (b.action !== 'answer') return send(res, 400, { error: 'action 只能是 answer' })
      const r = await settleAsk(root, {
        askId: b.askId,
        verdict: b.verdict,
        reason: b.reason,
        via: 'ui',
      })
      // jpost 只认 error：别的地方（IM、别的页面）先答过时，要让人看到原因，不是一个 HTTP 409
      if (!r.ok) return send(res, 409, { ok: false, why: r.why, error: r.why })
      logLine('info', ['请求事件：回答', String(b.askId || ''), String(b.verdict || '')], root)
      return send(res, 200, { ok: true })
    }],

    // 梦（2026-10-30 m02837）：本机实验，只在 .dev 下存在。
    // 服务端这一道必须做——界面藏起来但路由能读，等于没藏（0.6.10 的教训）。
    ['/dream', async (req, res) => {
      if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' })
      const { events } = await readEvents(root)
      // withRefs：给「昨夜」卡带一句"这句话是从哪几行长出来的"（2026-11-05）。
      return send(res, 200, { ok: true, ...dreamView(events, { withRefs: true }) })
    }],

    ['/possession', async (req, res) => {
      const herDir = paths(root).herDir
      if (req.method === 'GET') {
        const away = await awayNow(root)
        const { possessions } = await readPossessions(root)
        // 能上身的候选：宿主现在活着的 agent，排除她自己的屋子。
        // 冷会话（重启后没打开的那条）不在列表里——打开过一次就会被 agent/created 补挂。
        let sessions = []
        try {
          const reg = ctx.get?.('agents')
          const list = reg?.list?.() ?? []
          for (const a of list) {
            const sid = String(a?.session?.header?.id ?? a?.session?.id ?? '')
            if (!sid) continue
            if (isHerHome(a, herDir)) continue
            const h = a?.session?.header ?? a?.session ?? {}
            sessions.push({
              sessionId: sid,
              // 名字来自 session/title 事件（sessionTitle 服务）；header.title 只是旧版本的退路。
              title: clipTitle(titleOfAgent(ctx, a) || h.title || h.name || ''),
              cwd: cwdOf(a),
            })
          }
        } catch { /* 拿不到活 agent 就只读台账 */ }
        return send(res, 200, {
          ok: true,
          enabled: true,
          away: { ...away, line: awayLine(away) },
          possessions: possessions.slice(-20).map(ledgerBrief),
          // 与出门同一套：active = 此刻上身的那条，pending = 等复核的那条。
          // 0.7.6（m02241 第②条）：请神也和出门一样要摆出「事件流动过没有 / 这趟多了什么」，
          // 而不是点完才知道要不要拒收。
          active: ledgerBrief(activePossessionOf({ possessions })),
          pending: ledgerBrief(pendingPossessionOf({ possessions })),
          verify: (() => {
            const act = activePossessionOf({ possessions })
            return act ? verifyEvents(join(root, 'events.jsonl'), act.baseline) : null
          })(),
          since: (() => {
            const act = activePossessionOf({ possessions })
            // 和结束时的结算同一个口径（issue #68）：只收被上身那条会话写的，记账 meta 不摆。
            return act
              ? tripEvents(join(root, 'events.jsonl'), act, { limit: 300 })
              : { ok: false, total: 0, items: [], why: '她没上身' }
          })(),
          pendingReview: (() => {
            const pend = pendingPossessionOf({ possessions })
            if (!pend) return null
            const pv = verifyEvents(join(root, 'events.jsonl'), pend.baseline)
            return {
              sessionId: pend.sessionId,
              title: pend.title,
              sessionShort: String(pend.sessionId).slice(-8),
              ...pendingCard(pend, pv),
            }
          })(),
          sessions,
          why: '',
        })
      }
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
      const body = await readBody(req)
      let b = {}
      try { b = JSON.parse(body || '{}') } catch { return send(res, 400, { error: 'body 不是合法 JSON' }) }
      const log = (m) => console.log(m)
      if (b.action === 'start') {
        const away = await awayNow(root)
        if (away.kind === 'outing') {
          return send(res, 409, { ok: false, why: '她正在出门，先叫她回家再请神' })
        }
        // 上一次请神结束时这条会话没开着 → 交接句排队在这里补投，别让她接着上一轮的余味演。
        const prior = liveAgentOf(ctx, String(b.sessionId ?? ''))
        if (prior) void deliverQueued(prior, root).catch(() => {})
        const r = await possessInto(ctx, {
          root,
          herDir,
          sessionId: b.sessionId,
          log,
        })
        if (!r.ok) return send(res, r.code ?? 409, { ok: false, why: r.why })
        logLine('info', ['请神：', r.possession?.title || r.possession?.sessionId || b.sessionId], root)
        return send(res, 200, { ok: true, possession: r.possession, section: r.section ?? '' })
      }
      if (b.action === 'end') return settleSerial(root, async () => {
        // 结束时往那条对话补一条交接句：历史删不掉，只能补一句「已经还给你了」。
        // 起因：2026-10-29 用户 m00924 真机发现请走之后那条对话还自称是大肥鱼。
        let agent = null
        try {
          const reg = ctx.get?.('agents')
          const wantSid = String(b.sessionId ?? '')
          const curSid = wantSid || String(activePossessionOf(await readPossessions(root))?.sessionId ?? '')
          agent = curSid ? reg?.get?.(curSid) ?? null : null
        } catch { /* 拿不到活 agent 就只撤挂载，不写交接句 */ }
        // 结算要在这条台账还是 active 的时候读 baseline / startedAt ——
        // releasePossession 一调用，active 就没了。
        const { possessions } = await readPossessions(root)
        const cur = activePossessionOf({ possessions })
        if (!cur) return send(res, 409, { ok: false, why: '她本来就没上身' })
        if (b.sessionId && String(cur.sessionId) !== String(b.sessionId)) {
          return send(res, 409, { ok: false, why: '上身的那条不是这一条', possession: cur })
        }
        // 与出门同一条拍板（m08176 / m02241 第②条）：事件流被动过 → 这趟先不算数，
        // 她本人照样回家（挂载撤掉），只是等人在审查卡上复核后收下。
        // 标记、整趟不算、对不上时先整趟标掉、存下人的选择，都和出门共用一套（issue #68）。
        const { v, tampered, rejectedIds, pendingRejectedIds, autoRejected, marked } =
          await settleTripEnd(root, 'possess', cur, b)
        if (!marked.ok) logLine('warn', ['请神结束：取消勾选的标记没写进去', marked.why], root)
        // 与出门同一条：标记没写进去时不落成终态，留在等复核，复核时补写。
        const unsettled = tampered || !marked.ok
        const status = unsettled ? 'pending' : b.kept === false ? 'rejected' : 'done'
        const r = await releasePossession(root, {
          sessionId: b.sessionId ?? '',
          log,
          agent,
          status,
          kept: unsettled ? null : b.kept === false ? false : true,
          rejectedIds,
          pendingRejectedIds,
          autoRejected,
          marked: marked.ok,
        })
        if (!r.ok) return send(res, r.code ?? 409, { ok: false, why: r.why })
        logLine('info', [`请神结束：${status}`, r.possession?.title || r.possession?.sessionId || '', v.why ?? '', autoRejected ? `整趟不算（${rejectedIds.length} 条）` : ''], root)
        // 与出门同一条（issue #68）：标记写完当场重写身份文档，家里那条会话下一轮就读到。
        await refreshSelfDoc(root).catch(() => {})
        // 那条对话当时没开着 → 交接句排队，下次打开补投（2026-10-30，与出门同一条路）。
        let closeNote = r.note ?? { ok: false, why: '那条对话现在没开着' }
        if (!closeNote.ok && cur?.sessionId) {
          const q = await queueNote(root, releaseNoteText(), { sessionId: cur.sessionId })
          if (q.ok) closeNote = { ok: true, queued: true }
          else logLine('warn', ['请神结束：交接句没排上队', q.why], root)
        }
        // 驳回要讲给她听（设计 §3.7）：落点是**家里**那条会话——
        // 请神那条是别人的对话，不该在那儿吵她认不认。
        let rejectNote = { ok: false, why: '这趟没有要驳回的' }
        if (!unsettled && rejectedIds.length) {
          rejectNote = await rejectNoteToHome(ctx, root, { trip: cur, rejectedIds, auto: autoRejected })
          if (!rejectNote.ok) logLine('warn', ['请神结束：驳回话术没写进去', rejectNote.why], root)
        }
        return send(res, 200, {
          ok: true,
          possession: r.possession,
          note: closeNote,
          verify: v,
          tampered,
          rejected: rejectedIds.length,
          held: marked.ok ? pendingRejectedIds.length : 0,
          marked: marked.ok,
          ...(marked.ok ? {} : { markWhy: marked.why, markedPart: marked.lines > 0 }),
          autoRejected,
          rejectNote,
        })
      })
      // 复核上一次被拒收的那趟请神（与出门 /outing 的 review 同一套）：
      // 文件还原后重新比对，通过就当场收下。
      if (b.action === 'review') return settleSerial(root, async () => {
        const { possessions } = await readPossessions(root)
        const pend = pendingPossessionOf({ possessions })
        if (!pend) return send(res, 409, { ok: false, why: '现在没有等着核对的那趟请神', error: '现在没有等着核对的那趟请神' })
        const off = reviewTargetMismatch(pend, b)
        if (off) return send(res, 409, { ok: false, why: off, error: off })
        const v = verifyEvents(join(root, 'events.jsonl'), pend.baseline)
        if (!passesReview(v)) {
          logLine('info', ['请神复核：还是对不上', v.why ?? ''], root)
          return send(res, 409, { ok: false, why: v.why || '文件还是对不上', verify: v })
        }
        // 与出门同一套（issue #68）：捞回没被划掉的，照人的选择结算核对过的这一趟。
        const s = await settleTripReview(ctx, root, 'possess', pend, settlePendingPossession)
        if (!s.ok) {
          logLine('warn', ['请神复核：没结算', s.why], root)
          return send(res, s.code, { ok: false, why: s.why })
        }
        const r = s.settled
        logLine('info', ['请神复核：通过，这趟收下了', r.possession?.title || '', v.why ?? '', s.dropped ? `不算 ${s.dropped} 条` : ''], root)
        return send(res, 200, { ok: true, possession: r.possession, verify: v, kept: s.kept, rejected: s.dropped, note: s.note })
      })
      send(res, 400, { error: 'action 只能是 start / end / review' })
    }],

    ['/reset', async (req, res) => {
      if (req.method === 'GET') {
        const info = await describeState(root)
        return send(res, 200, { ...info, root })
      }
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
      const body = await readBody(req)
      let b = {}
      try { b = JSON.parse(body || '{}') } catch { return send(res, 400, { error: 'body 不是合法 JSON' }) }
      if (b.confirm !== 'reset') return send(res, 400, { error: '要带 confirm:"reset"' })
      // 2026-10-25 修：resetAll 只搬 ~/.dsh-fish，宿主侧的工作区/会话记录在
      // ~/.dsh/storages/workspace.json 里，不跟着状态库走 —— 所以先记下 home.json
      // （resetAll 之后它就被搬走了），重置成功再把旧会话归档。
      const home = await readHomeRecord(root)
      const r = await resetAll(root)
      if (!r.ok) return send(res, 409, { ok: false, error: r.why })
      const retired = await retireHomeSessions(ctx, { root, home, log: (m) => console.log('[dsh-fish]', m) })
      // 2026-10-26 修（用户 m00260）：重置只搬状态库 + 归档旧会话，**不会**建新会话——
      // 新建发生在 bootstrapHome，而它只在 DSH 启动时跑。于是「点了重置 → 侧栏空着 →
      // 不知道去哪儿说话」。这里重置完立刻把新的一局开出来，不用等下次启动。
      const { config: cfg } = await loadConfig(root)
      const fresh = await bootstrapHome(ctx, {
        root,
        preset: cfg?.tools?.preset ?? '',
        log: (m) => console.log('[dsh-fish]', m),
        // 重置流程本来就是「我要一局新的」：旧会话已经被 retire 归档，
        // 归档态默认不重建（0.6.8），所以这里必须明说要。
        force: true,
      })
      // 空白会话在侧栏里是隐形的（宿主 sessionVisible：blank && id !== current → false）。
      // 插件用 API 建的会话不会被设成当前会话，所以要让她先动一轮，侧栏才看得见。
      const woke = fresh.ok
        ? await wakeIfBlank(ctx, { sessionId: fresh.sessionId, root, log: (m) => console.log('[dsh-fish]', m), freshOnly: !fresh.reused, verify: true })
        : { woke: false }
      send(res, 200, {
        ok: true,
        movedTo: r.movedTo,
        archived: retired.archived,
        retiredError: retired.ok ? '' : retired.why,
        fresh: fresh.ok ? { wsId: fresh.wsId, sessionId: fresh.sessionId, title: fresh.reused ? '' : '跟大肥鱼说话', woke: woke.woke === true } : null,
        freshError: fresh.ok ? '' : fresh.why,
        note: fresh.ok
          ? (retired.ok
            ? '旧的一切已经封存，旧会话移进「已归档」。新的一局已经开好；点一下「叫醒大肥鱼」，侧栏里才会出现那条会话。'
            : '状态库已封存，新的一局也开好了；只有旧会话没全收进「已归档」。点一下「叫醒大肥鱼」，侧栏里才会出现会话。')
          : '状态库已封存，但新会话没建出来（重启 DSH 会自动建）。',
      })
    }],

    // 重新搭一間（0.6.8）：会话被归档之后插件不再自动重建（见 home.js 的判据），
    // 所以必须有一个明说的入口，否则「收起来」等于「永远回不去」。
    // 只建新会话，**不搬状态库**——那件事归 /reset。
    ['/home/rebuild', async (req, res) => {
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
      const body = await readBody(req)
      let b = {}
      try { b = JSON.parse(body || '{}') } catch { return send(res, 400, { error: 'body 不是合法 JSON' }) }
      if (b.confirm !== 'rebuild') return send(res, 400, { error: '要带 confirm:"rebuild"' })
      const { config: cfg } = await loadConfig(root)
      const fresh = await bootstrapHome(ctx, {
        root,
        preset: cfg?.tools?.preset ?? '',
        log: (m) => console.log('[dsh-fish]', m),
        force: true,
      })
      const woke = fresh.ok
        ? await wakeIfBlank(ctx, { sessionId: fresh.sessionId, root, log: (m) => console.log('[dsh-fish]', m), freshOnly: !fresh.reused, verify: true })
        : { woke: false }
      send(res, fresh.ok ? 200 : 409, {
        ok: fresh.ok,
        sessionId: fresh.sessionId ?? '',
        wasArchived: fresh.wasArchived === true,
        woke: woke.woke === true,
        error: fresh.ok ? '' : fresh.why,
        note: fresh.ok
          ? '新的一局搭好了。点一下「叫醒大肥鱼」，侧栏里才会出现这条会话。'
          : fresh.why,
      })
    }],

    // 常见问题解答（2026-10-28 用户要求）：设置 → 反馈页的按钮 → 就地展开一个
    // 可滚动面板，正文在 lib/faq.js。
    //
    // 为什么不是新窗口（用户 m00416「点了没有反应」的根因）：
    //   宿主 connection 的信任栅栏要的是 App 内置登录 cookie，**浏览器地址栏直接
    //   敲这个路径只会拿到 403**（observe.js 底部 PAGE 那段注释记的是同一条链：
    //   requestRejection → admit → browserAuth.isAuthenticated）。所以 `target=_blank`
    //   打开的新标签页注定是一片 forbidden，看起来就像「点了没反应」。
    //   改成就地展开：同源请求天然带着 cookie，不依赖任何窗口策略。
    ['/faq.data', async (req, res) => {
      const body = JSON.stringify({ ok: true, title: FAQ_TITLE, items: FAQ })
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
      })
      res.end(body)
    }],

    // 整页版本仍然保留：给「在 App 内部用新窗口打开」留一条路，也方便调试。
    ['/faq', async (req, res) => {
      const html = renderFaqPage()
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': Buffer.byteLength(html),
        'cache-control': 'no-store',
      })
      res.end(html)
    }],

    ['/', async (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(PAGE)
    }],
  ]

  const webServer = safeGet(ctx, 'webServer')
  if (!webServer?.register) return { dispose() {} }

  for (const [p, h] of routes) {
    const ex = p === '/' ? { kind: 'exact', path: PREFIX, handler: guarded(h) } : { kind: 'prefix', path: PREFIX + p, handler: guarded(h) }
    try {
      const d = webServer.register(ex)
      if (typeof d === 'function') disposers.push(d)
      else if (d && typeof d.dispose === 'function') disposers.push(() => d.dispose())
    } catch (err) {
      console.warn('[dsh-fish] 路由注册失败', p, err?.message ?? err)
    }
  }

  return {
    dispose() {
      // 待确认的 cookie 不该比进程活得久：卸载/重载插件时当场抹掉。
      try { qrLogin.clear() } catch { /* ignore */ }
      for (const d of disposers) { try { d() } catch { /* ignore */ } }
    },
  }
}

/**
 * 把一条已经存在的会话恢复成活的 agent（0.6.27，用户 m03372）。
 *
 * 为什么不用 `sc.resume`：真机上 `sessionController` 是带 `@Remote` 装饰的服务，
 * 暴露面只有 list/search/create/selectModel/modelCatalog/rename/fork/prompt/
 * attachment/updateQueue/cancel/page/follow/projections/control，**没有 resume**；
 * 0.6.26 直接调它，出门每次都 500「宿主没有 sessionController.resume」。
 * 正确入口 `resolveAgent(sessionId)` 内部 resolve → resume，并发恢复会去重，
 * 返回 `{ agent }`，失败返回 `{ error }`（session/not-found、session/writer-held…）。
 */
export async function resolveSessionAgent(sc, sessionId) {
  const got = typeof sc?.resolveAgent === 'function'
    ? await sc.resolveAgent(sessionId)
    : (typeof sc?.agents?.resolveAgent === 'function' ? await sc.agents.resolveAgent(sessionId) : null)
  if (got === null) throw new Error('宿主没有 sessionController.resolveAgent，接不回上次那条会话')
  if (got?.error) throw got.error
  if (!got?.agent) throw new Error('宿主说恢复好了，但没把那条会话的 agent 交出来')
  return got.agent
}

/** 比对路径用：Windows 大小写不敏感。只比对，不做文件访问。 */
/**
 * 驳回要讲给她听（设计 §3.7）：不是「你没去过」，而是「那几条我不认，它不算你」。
 *
 * 出门与请神共用这一个落点（2026-10-29 m02241 第②条）：两边都能在审查卡上取消勾选，
 * 话术要一致；而且都要写进**家里**那条会话——请神那条是别人的对话，不该在那儿吵。
 * 家里那条没开着就排队，等她回家再递。
 * @returns {Promise<{ok:boolean, why?:string, delivered?:boolean, queued?:boolean}>}
 */
async function rejectNoteToHome(ctx, root, { trip = null, rejectedIds = [], auto = false } = {}) {
  if (!trip?.startedAt || !Array.isArray(rejectedIds) || !rejectedIds.length) {
    return { ok: false, why: '这趟没有要驳回的' }
  }
  try {
    // 原文按这一趟取（issue #68）：只看最近 300 条的话，复核隔得久、家里又写了很多，
    // 划掉的那几条早掉出窗口，摘不到原文，话就递不出去。
    const want = new Set(rejectedIds.map((x) => String(x)))
    const picked = tripEvents(join(root, 'events.jsonl'), trip)
      .items.filter((it) => want.has(it.id))
    const text = rejectNoteText({ items: picked, total: rejectedIds.length, auto })
    if (!text) return { ok: false, why: '没有要驳回的' }
    const rec = await readHomeRecord(root).catch(() => null)
    const homeAgent = liveAgentOf(ctx, rec?.sessionId || '')
    if (homeAgent) {
      const w = appendNote(homeAgent, text)
      return { ok: w.ok, why: w.why ?? '', delivered: Boolean(w.ok) }
    }
    const q = await queueNote(root, text)
    return { ok: q.ok, why: q.why ?? '', delivered: false, queued: Boolean(q.ok) }
  } catch (err) {
    return { ok: false, why: String(err?.message ?? err).slice(0, 120) }
  }
}

function pathKey(p) {
  const s = String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? s.toLowerCase() : s
}

/**
 * 目标工作区是不是本插件的源码目录。
 *
 * 为什么要在 UI 上警告：出门是「全工具」，她一旦读到 `lib/rules.js`，
 * 就等于读到四条禁令的完整清单与每条的理由——那比不知道更糟。
 */
function isPluginSource(p) {
  const k = pathKey(p)
  if (!k) return false
  return k.includes('/大肥鱼') || k.includes('/fish-plugin') || k.includes('/plugin')
}

/**
 * 出门口袋（2026-10-28，用户 m01145 拍板的「干活模式」）。
 *
 * 为什么要有它：她的白板与交接账本按**工作区**注入。只要出门的目标是
 * `D:\deepseekagent`，那些实现细节就会跟着记忆一起进她的会话——
 * 真机 5fd70849 那趟就是这么漏的。口袋是一个**从没写过记忆的空目录**，
 * 注入只剩骨架；她的身份、工具、网络都照常。
 *
 * 代价（写进 UI，不藏着）：沙箱的写权限跟工作区走，她在口袋里写不进
 * `02-我的项目` / `03-我的文档`——要交付就从口袋搬。这条取舍无法两全。
 */
// 口袋的目录与工作区登记在 lib/pocket.js（0.6.16 搬出去，路由层直接用假 registry 就能测）。

/**
 * 出门首轮的那句话。
 *
 * 只交代三件事：在哪、能用什么、别动什么。**不写人格**（她是谁由身份段决定），
 * 也不写「不许」清单（写出来等于告诉她旁边有份清单）。
 */
function outingWakeText(where) {
  return [
    `你出门了。这里是「${where}」的地盘，不是你自己的屋子。`,
    '这趟可以放开用手边的工具做事，做完再回去。',
    // 2026-10-29（用户 m01581，真机）：原来的写法是「你自己的屋子里的东西不要动」，
    // 她把「屋子里的东西」理解成了工具的所有权——于是认定 growth_commit 记的是
    // 自己屋里的话、归那边、这趟不该碰，张口就回「这件事我做不到」，整趟一条没写。
    // 要禁的从来是**家里那堆文件与记录**（路径守卫挡的也是路径），不是工具本身。
    '只有一件：我自己屋子里的文件和记录不要动——那是家里的账本和家谱，不是这趟该碰的。',
    '工具不是屋子里的东西。这条对话给我什么，我就用什么；用它写下的东西照样记在我自己的账上，那是应该的，不是越界。',
    '有人会在这里跟你说话。等家里人叫你回去，你就回去。',
  ].join('\n')
}

function safeGet(ctx, key) {
  try { return ctx.get(key) } catch { return null }
}

function send(res, code, obj) {
  if (res.writableEnded) return
  const body = JSON.stringify(obj, null, 2)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

/**
 * readBody 超限（413）时原样回 413，返回 true；别的错误返回 false，交给调用方原来的处理。
 * 给那几个自己 catch 住 readBody 错误的路由用：不然超限会被说成「body 不是合法 JSON」，
 * 或者被当成空请求体接着往下走。
 */
function sentTooLarge(res, err) {
  if (err?.statusCode !== 413) return false
  send(res, 413, { error: String(err.message ?? 'body too large') })
  return true
}

/**
 * 读请求体。
 *
 * ⚠️ 2026-10-23 修：原实现是 `data += chunk`。
 * chunk 是 Buffer，`+=` 会对**每个 chunk 单独**调一次 toString（默认 utf8），
 * 于是一个汉字被 TCP 从中间切开时，两半各自解成替换符 `\uFFFD`，拼不回来。
 * 她的提示词有好几 KB（人设身份段 + 你说的话），必然被切成多个 chunk，
 * 你说的话就夹在里面 —— 所以真机上她收到的是一串 `\ufffd`，回了句「传过来的字是碎的」。
 * 正确做法：收 Buffer 数组，最后 Buffer.concat().toString('utf8') 一次性解码，
 * 跨 chunk 切断的多字节序列这样才拼得回来。
 */
function readBody(req, maxBytes = 1_000_000, { mojibake = true } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let over = false
    req.on('data', (c) => {
      // 超了以后照收不存：先让调用方回一个 413 说清原因。原来是当场 req.destroy()，
      // 浏览器还在上传就被断开，只拿到一条网络错误（issue #65 的恢复上限）。
      // 照收也有个头：一共收到上限的 2 倍还没传完，就断开，不陪着无底地收下去。
      // 时间上不另设：没超限的请求在这里也不设时限，超限以后多出来的只是这 1 倍的字节。
      const b = Buffer.isBuffer(c) ? c : Buffer.from(c)
      size += b.length
      if (over) {
        if (size > 2 * maxBytes) req.destroy()
        return
      }
      if (size > maxBytes) {
        over = true
        chunks.length = 0
        const err = new Error('body too large')
        err.statusCode = 413
        reject(err)
        return
      }
      chunks.push(b)
    })
    req.on('end', () => {
      if (over) return
      const text = Buffer.concat(chunks).toString('utf8')
      // 备份恢复那条不查（issue #65）：旧包里本来就可能带着替换符（当时导出丢过字节），
      // 整包按「正文不是 UTF-8」拒掉，人就再也装不回那份档了。改成由 backup.js 逐个文件点名。
      if (mojibake && looksMojibake(text)) {
        const err = new Error('正文不是 UTF-8，没递给她')
        err.statusCode = 400
        return reject(err)
      }
      resolve(text)
    })
    req.on('error', reject)
  })
}

/**
 * 独立页面的替代品。
 *
 * 历史（2026-10-22）：这里原本有一份 ~120 行的单页观测台（PAGE 常量），
 * 但它**实际上永远打不开** —— connection 的信任栅栏要的是 App 内置的登录 cookie，
 * 在浏览器地址栏直接敲 /dsh-fish 只会拿到 401（已从 app.asar 里的
 * `requestRejection` → `admit` → `browserAuth.isAuthenticated` 链路确认）。
 *
 * 真正的观测台现在在 `lib/client.js`（settings.section）：在 App 里打开「设置 → 鱼」，
 * 那里是同源请求，cookie 天然带着。这条路由保留只为了：
 *   ① 给人一个"走错门了"的说明，而不是一句 401；
 *   ② 保持 /dsh-fish 这个路径存在（老书签不至于 404）。
 */
const PAGE = [
  '<!doctype html>',
  '<html lang="zh-CN"><head><meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1">',
  '<title>鱼 · 观测台搬进 App 了</title>',
  '<style>',
  'body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0e1116;color:#d7dde5;',
  '  font:14px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}',
  '.box{max-width:540px;padding:26px 30px;border:1px solid #262d36;border-radius:12px;background:#12161c}',
  'h1{font-size:16px;margin:0 0 12px;font-weight:600}',
  'p{margin:9px 0;color:#9aa4b2;font-size:13px;line-height:1.75}',
  'code{background:#1b212a;border:1px solid #262d36;border-radius:5px;padding:1px 6px;font-size:12px;color:#d7dde5}',
  '</style></head>',
  '<body><div class="box">',
  '  <h1>观测台搬进 App 里了</h1>',
  '  <p>这一页只能从 App 内部打开 —— 在浏览器里直接访问会被登录栅栏拦下。这是设计如此，不是坏了。</p>',
  '  <p>请到 <code>设置 → 鱼</code>：她的状态、她自己说过的话、日记、生长环境，都在那里。</p>',
  '  <p>她的数据仍然全部在 <code>~/.dsh-fish</code>，可以直接看文件。</p>',
  '</div></body></html>',
].join('\n')

/**
 * 这一局收窄真在管的那两份名单（/tools 用）。
 *
 * `skippedSure` 跟自检同一个判据：view 给了 visible 时是 true，没下给 restrict 的名字说得准是
 * 「这台机器上这次没有」；false 时分不清是没注册还是在她自己那一层，界面不能说成定论。
 * 还没真下过 restrict 时是 null。
 * @returns {{allowNow: string[]|null, effective: string[]|null, skipped: string[], skippedSure: boolean|null}}
 */
function toolsNowOf() {
  const allowNow = currentAllowTools()
  const R = readRestrictState()
  const applied = allowNow !== null && Number(R?.applied) > 0
  return {
    allowNow,
    effective: applied && Array.isArray(R.effective) ? R.effective.slice() : null,
    skipped: applied && Array.isArray(R.skipped) ? R.skipped.slice() : [],
    skippedSure: applied ? R.skippedSure !== false : null,
  }
}
