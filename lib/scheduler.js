/**
 * scheduler.js —— 生物钟
 *
 * 做什么：每分钟看一眼「现在该不该叫醒她」。该叫就起一个 headless 会话，只说这一次的处境
 * （身份由 identity.js 以 system prompt 段承载、每轮现读，不拼进唤醒消息）。
 *
 * 三条安全线（B §7）：
 *   1. 定时器只是**提议**。任何一次唤醒失败都不重试、不阻塞下一分钟。
 *   2. 一天之内同一条事件模板不重复触发（once 靠 fired 标记，非 once 靠 daily 配额）。
 *   3. 停用插件 = dispose 定时器，不再有任何后台活动（不靠"记得关"）。
 *
 * 时间判断全部走本地时区；跨零点的时间窗（20:00–02:00）按 inWindow 处理。
 */

import { join } from 'node:path'
import { deriveSelf } from './derive.js'
import { validateEvent } from './schema.js'
import { readEvents, appendEvent, rootDir, ensureHer, paths, readJson } from './store.js'
import { loadConfig, dateKey, inWindow, pickWakeTime } from './settings.js'
import { plan } from './generator.js'
import { findTemplate } from './events.js'
import { offerPrompt, SLEEP_TODAY } from './persona.js'
import { offerDueDay, pendingOffer, grantableRules } from './unlock.js'
import { holdWake } from './wakewin.js'
import { detectAbsence } from './absence.js'
import { createClient } from './bili.js'
import { gather, browseCountToday, recordBrowse } from './browse.js'
import { seenOn } from './whatseen.js'
import { renderWatchList } from './history.js'
import { fetchCover, coverLines } from './cover.js'
import { riskState, browsePlan, noteRisk, isRiskCode } from './risk.js'
import { scanReplies, renderReplies } from './comment.js'
import { flushReport } from './report.js'
import { talkSessionId } from './home.js'
import { WAKE_TRIGGER } from './wakeconst.js'
import { refreshSelfDoc } from './selfdoc.js'
import { setWakeSection, clearWakeSection, liveAgentOf } from './identity.js'
import { awayNow, awayLine } from './outing.js'
import { askInChat, picked } from './askinchat.js'
import { restedToday, settleStaleAsks } from './ask.js'
import { devModeSync } from './devmode.js'
import { proactiveState, proactiveSection, recentMaterial, looseEnds, hideTrigger, sweepTriggers, PROACTIVE_TRIGGER } from './proactive.js'
import { logLine } from './log.js'
import { recordGrant } from './grant.js'

const TICK_MS = 60_000
const INITIAL_DELAY_MS = 20_000
const WAKE_TIMEOUT_MS = 5 * 60_000
// 等她的回合结束时最多等这么久。一次唤醒的思考通常 10–40 秒，
// 90 秒足够；再久就说明卡住了，先把报告写出去，别让用户干等。
const REPORT_WAIT_MS = 90_000
// 一天的第二次及以后的叫醒，离上一次至少隔这么久（见 nextWakeAt）
const WAKE_MIN_GAP_MS = 45 * 60_000
// 她正在某一轮里时先等她说完，最多等这么久
const IDLE_WAIT_MS = 10 * 60_000
// turn/start 之后迟迟等不到 turn/end（宿主重启、事件丢了），超过这么久就不再当她在忙
const BUSY_STALE_MS = 15 * 60_000

// 2026-10-26（用户 m00507）：她看不懂对话里那句「……」。
// 真机 reasoning 原话是「用户发来的只有一个省略号，没有实质请求」，接着猜
// 「用户的意思是让我留一句话、写日记」——把系统叫醒当成了用户的请求。
// 这句说明只进 system prompt 的 fish:wake 段（用户看不见），把性质讲清楚；
// 触发语本身也换成了括号旁白（见 wakeconst.js）。两处必须一起在，只有其一
// 她仍会去猜。
const WAKE_HINT = '对话里那条括号里的短句不是用户说的话，是叫醒你的信号。不用回应它，也不用问它什么意思——这一轮是你自己的。'

// 当天最后一次叫醒里多给一句处境（2026-10-29，用户 m01296 B）。
// 只给「到今天了」这个时间感，不派活、不提日记——写不写由她自己决定。
// 提了就成了工单，正是 2026-10-26 用户 m00928「叫醒仅仅只是叫醒」要去掉的东西。
const DAY_END_CUE = '（今天到这里了。这一刻是我自己的。）'

/**
 * 唤醒时对话里唯一出现的那句话（2026-10-25 晚）。
 *
 * 为什么只剩这一句：真正的「这一次的处境」走 system prompt 的 `fish:wake` 段，
 * 不进对话历史。对话里必须**有一条** user 消息才能把回合点起来，所以留这句。
 * 它要短到不带任何剧本味——用户看到的是「屋子里有人动了」，而不是系统在给她派活。
 */



/**
 * 等这一次唤醒的回合真正结束。
 *
 * 坑（真机抓到）：`sessionController.prompt()` 在把消息**排进队列**时就 resolve 了，
 * 模型还在后面慢慢想。之前紧接着就 flushReport，报告在她开口前 8 秒就写完，
 * 于是 out/YYYY-MM-DD.md 永远显示"今天她什么都没说"——她其实说了，只是晚了。
 *
 * 宿主的信号是 `session/event`，事件里 `type === 'turn/end'`。
 * 拿不到事件总线（单测/老宿主）时退回"等一会儿再写一次"，
 * 反正 flushReport 是幂等的重写，多写一次不会错。
 */
function watchTurnEnd(ctx, sessionId, done) {
  let fired = false
  const once = () => {
    if (fired) return
    fired = true
    try { done() } catch { /* 报告是派生品，写不出来不影响任何东西 */ }
  }
  const off = ctx.on?.('session/event', (session, event) => {
    const id = session?.header?.id ?? session?.id
    if (id !== sessionId) return
    if (event?.type === 'turn/end') once()
  })
  return { off, once, get fired() { return fired } }
}

export function startScheduler(ctx, deps = {}) {
  const root = deps.root ?? rootDir()
  const log = deps.log ?? ((...a) => console.log('[dsh-fish]', ...a))

  // 每次 tick 的记忆（内存态，重启即清空；配额以 events.jsonl 为准）
  let lastTick = 0
  let running = false
  let disposed = false
  let timer = null
  let wakeTimer = null
  // skip 日志去重（2026-10-28）：同一小时、同一原因只记一次。
  // 存成 `${dk}T${hour}|${why}` 一行，交给 shouldLogSkip 判。
  let skipLogged = ''
  // away 心跳降噪（2026-10-29 用户 m02241）：出门/请神期间 tick 每 60 秒跑一次，
  // 原来每次都写一条「away 此刻在外面：X · 已 N 分钟」——一晚上几百行同样的东西，
  // 真正的异常（装不上装备、台账冲突）反而被淹掉看不见。
  // 现在只在这一趟**第一次**看到时记一行，之后静默；只有台账出现异常（conflict）
  // 或者这趟换了（key 变了）才再记。回家/结束请神后清空，下一趟再记一行。
  let awayLogged = ''
  // 今天她请过假（请求事件 rest）只记一次日志：tick 每分钟跑，别把这一行刷成弹幕。
  let restLogged = ''

  // 哪个会话正在一轮里（turn/start → turn/end）。叫醒排在她正在说的那一轮后面时，
  // 那一轮的 turn/end 会先把 fish:wake 段清掉，真正醒来的那一轮反而看不到处境。
  const busy = new Map()
  const offBusy = ctx.on?.('session/event', (session, event) => {
    const id = session?.header?.id ?? session?.id
    if (!id) return
    if (event?.type === 'turn/start') busy.set(id, Date.now())
    else if (event?.type === 'turn/end') busy.delete(id)
  })
  const isBusy = (id) => {
    const t = busy.get(id)
    return t !== undefined && Date.now() - t < BUSY_STALE_MS
  }
  const waitIdle = async (id) => {
    const until = Date.now() + IDLE_WAIT_MS
    while (!disposed && isBusy(id) && Date.now() < until) await new Promise((r) => setTimeout(r, 2000))
  }

  // 主动说话：每小时最多掷一次骰子；skip 原因同一句只记一次，别把日志刷满。
  let lastProbe = 0
  let proactiveSkip = ''

  /**
   * 开一次空手回合（她自己的回合，不是叫醒）。
   *
   * 判断全在 `lib/proactive.js` 的纯函数里，这里只负责「真的把回合开起来」：
   * 处境走 system prompt 段，对话里只留一句「现在没有人跟你说话」。
   * 她可以选择开口，也可以什么都不做——不写任何「你应该」。
   */
  // 每次启动补扫一遍历史里的遗留触发语（修好之前触发的那几轮还留在对话里）。
  let sweptSession = ''

  async function maybeProactive({ events, config, dk, now }) {
    if (!devModeSync(root)) return false
    if (!sweptSession) {
      try {
        const sid = await talkSessionId(ctx, { root, log })
        const live = sid ? liveAgentOf(ctx, sid) : null
        if (live) {
          sweepTriggers(live.session, { log: (a, b) => log(a, b) })
          sweptSession = sid
        }
      } catch {}
    }
    const st = proactiveState({ config, events, now })
    if (!st.ok) {
      if (st.why && st.why !== proactiveSkip) {
        proactiveSkip = st.why
        log('proactive skip', st.why)
      }
      return false
    }
    // 每 30 分钟最多掷一次：tick 每分钟跑一次，逐 tick 掷等于必然触发。
    if (now - lastProbe < 30 * 60_000) return false
    lastProbe = now
    if (Math.random() > st.chance) {
      log('proactive roll', `${st.chance.toFixed(2)} 没摇上`)
      return false
    }
    const sc = ctx.sessionController
    if (!sc?.prompt) return false
    const sessionId = await talkSessionId(ctx, { root, log })
    if (!sessionId) return false

    const material = recentMaterial(events, { now })
    const loose = looseEnds(events, { now })
    const text = proactiveSection({ now, state: st, material, loose })
    const model = deriveSelf(events, { growthDays: config.growthDays })

    const ac = new AbortController()
    const kill = setTimeout(() => ac.abort(), WAKE_TIMEOUT_MS)
    const requestId = `proactive-${now}`
    // 回合结束：先把处境抽走（跟唤醒同一条清理路径），再把那条触发语从对话里收走。
    // 2026-10-30 真机（m05007）：不收走的话，用户对话框里会多出一条「自己发的」
    // 「（现在没有人跟你说话。）」——那只是 prompt 正文，不是谁真的说了话。
    // 这一轮她写的话不算他来过：唤醒时间窗开到 turn/end（prompt() 入队就返回，见 wakewin.js），
    // turn/end 一直不来就最迟 WAKE_TIMEOUT_MS 关上。
    const releaseWake = holdWake()
    setTimeout(releaseWake, WAKE_TIMEOUT_MS).unref?.()
    const watcher = watchTurnEnd(ctx, sessionId, () => {
      releaseWake()
      clearWakeSection()
      try {
        const live = liveAgentOf(ctx, sessionId)
        const hidden = hideTrigger(live?.session, { rpcId: requestId, log: (a, b) => log(a, b) })
        log('proactive', hidden ? '触发语已从对话里收走' : '触发语没能收走（会话不在线或找不到那条消息）')
      } catch (err) {
        log('proactive hide failed', err?.message ?? String(err))
      }
    })
    try {
      await sc.create({ sessionId, cwd: await ensureHer(root) }).catch(() => {})
      setWakeSection(text)
      await sc.prompt(
        {
          requestId,
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: PROACTIVE_TRIGGER }],
        },
        ac.signal,
      )
      await appendEvent(
        { type: 'meta', text: `proactive-turn:${dk}:${now}` },
        { day: model.day, stage: model.stage, source: 'timer' },
        root,
      ).catch(() => {})
      log('proactive', `开了一次空手回合（概率 ${st.chance.toFixed(2)}）`)
      return true
    } catch (err) {
      // 没送进去就没有这一轮：处境和窗口当场收掉，监听也摘掉，
      // 不然要等到别的哪一轮结束才清，那一轮开头还挂着这次的处境（跟 wake() 失败时一样）
      clearWakeSection()
      releaseWake()
      try { watcher.off?.() } catch { /* ignore */ }
      throw err
    } finally {
      clearTimeout(kill)
    }
  }

  async function tick() {
    if (disposed || running) return
    const now = Date.now()
    // 同一分钟内只算一次（setInterval 漂移保护）
    if (now - lastTick < 30_000) return
    lastTick = now

    // ---- 她出门了 / 被请神了：家里这套日程整段暂停（用户 m07453 第 6 条）----
    // 两条会话并行会互相踩 events.jsonl：那边在写、这边在读，还会在侧栏里
    // 凭空多出一条「家里醒了」的对话。回家或结束请神后自动恢复，不需要开关。
    // 台账坏掉就照常跑——不能因为一个新文件读不了，让她在家里彻底不动。
    try {
      const away = await awayNow(root)
      if (away.kind) {
        // 0.7.6（2026-10-29 用户 m02241）：心跳只在「这一趟第一次看到」和「台账不对劲」时记。
        // 以前的写法是每次 tick 都 log('away', ...)，一晚几百行，把真正的报错淹掉。
        const key = `${away.kind}|${away.kind === 'outing' ? away.outing?.sessionId ?? '' : away.possession?.sessionId ?? ''}|${away.conflict ? 'conflict' : ''}`
        if (away.conflict) {
          // 异常态：两条台账同时 active。这个每次都要说，不能去重——
          // 它意味着 awayNow 只能挑先开始的那条，另一条的行为不可预期。
          log('away', `${awayLine(away)} · 出门与请神同时开着（${away.why || '另一条需要手动结束'}）`)
        } else if (key !== awayLogged) {
          awayLogged = key
          log('away', awayLine(away))
        }
        return
      }
      // 回来了：清掉记忆，下一趟重新记第一行。
      awayLogged = ''
    } catch { /* 静默放行 */ }

    try {
      // ---- 冷落检测：先测，再决定叫不叫她 ----
      // 放在 tick 最前面，因为 wake 的提示词要读 absenceDays；
      // 晚一步的话今天这次唤醒就用的是昨天的冷落结论。
      const absence = await detectAbsence(root)
      // 冷落条数变了 = 她对自己的看法变了，身份文件要跟着重写。
      // 不写的话那份 system prompt 段会一直停在上一次的值上（她"不知道自己被晾过"）。
      if (absence?.written) await refreshSelfDoc(root, { log })

      const { events } = await readEvents(root)
      const { config } = await loadConfig(root)
      const dk = dateKey()

      // 请求事件（0.7.6，2026-10-30 m01274）：超过 24 小时没人答的，记成「以后再说」。
      // 放在 tick 里而不是专用定时器：这里本来就在读事件流，省一次闹钟。
      try { await settleStaleAsks(root, { now }) } catch { /* 结算失败不影响叫醒 */ }

      // 她今天主动请了假（kind=rest 被同意 → meta `rest:<dk>`）→ 今天不叫她。
      // 「不许连续两天」落在她那边（ask.js 的配额与她的判断），这里只读结论。
      if (restedToday(events, dk)) {
        if (restLogged !== dk) {
          restLogged = dk
          log('rest', '她今天请了假，家里不叫她。')
        }
        return
      }

      // ---- 主动说话（0.8.1 本机实验，2026-10-30 用户 m04610）----
      // 它不是唤醒：不占 wakesPerDay，也不推成长事件。只在 .dev 下生效。
      // 开了就 return——这一趟由她自己决定说还是不说，不再叠一次醒一醒。
      try {
        if (await maybeProactive({ events, config, dk, now })) return
      } catch (err) {
        log('proactive failed', err?.message ?? String(err))
      }

      // 日程：每天在时间窗内抽一个点。抽到的点已存在（今天已经安排过）就不再改。
      const scheduled = await ensureSchedule(root, config, events, dk)
      if (!scheduled) return

      if (!inWindow(config, new Date())) return

      const counts = await todayCounts(events, dk)
      if (now < scheduled.at) return    // 还没到今天的落点

      const model = deriveSelf(events, { growthDays: config.growthDays })
      // 空档补偿只影响这一次挑选的冷却判断（见 gapSqueeze）
      const decision = plan(model, config, counts, events, { squeeze: gapSqueeze(gapSinceLastWake(events)) })

      if (decision.action === 'quiet') {
        // 2026-10-28 修（用户 m06971）：原来每分钟写一条。
        //
        // tick 每 60 秒跑一次，而 quiet 既不带 `wake:` 前缀（所以 todayCounts 数不到、
        // 「每天最多几个事件」拦不住它），也没有任何「今天已经记过」的判断——
        // 候选池一空，一天就能写几百条。实测 2026-10-27 142 条、10-28 96 条，
        // 状态卡片上一分钟跳一格「醒了，但今天没有该问的事」。
        //
        // 一天记一次就够：它只是给状态卡解释「为什么今天什么都没发生」，不是行动。
        const alreadyQuiet = events.some((e) => e.type === 'meta' && String(e.text ?? '').startsWith(`quiet:${dk}`))
        if (alreadyQuiet) {
          // 0.7.6（2026-10-29 用户 m02241）：这里原来是每次都 log 一行
          // 「今天已经记过『没有该问的事』，不再重复写」——它自己就是那句
          // 「不再重复写」，却每 60 秒重复写一遍，一晚几百行。
          // 事件流里已经有 `quiet:<dk>` 这条了，日志不需要再说第二次。
          return
        }
        await appendEvent({ type: 'meta', text: `quiet:${dk} 无候选模板，今天不打扰` }, { day: model.day, stage: model.stage, source: 'timer' }, root)
        return
      }
      if (decision.action === 'skip') {
        // 2026-10-28 修（用户反馈日志里 22:15→23:00 每分钟一条「今日主动唤醒已满」）：
        // 和上面的 quiet 一样，skip 也不带 `wake:` 前缀，todayCounts 拦不住它，
        // 于是「今天已经满了」这件事被重复写上几百遍——日志被这些行淹没，
        // 真正的报错（比如工具没注册上）反而看不见。
        //
        // 同一个原因一小时最多记一条：配额是当天固定的，原因不变就没必要重述。
        // 用内存变量而不是事件流：这只是日志噪音，不值得污染 events.jsonl。
        const next = shouldLogSkip(skipLogged, dk, now, decision.why)
        if (!next) return
        skipLogged = next
        log('skip', decision.why)
        return
      }

      // 落点之后 plan() 每分钟都会说「该醒了」，直到配额用完——不拦的话一天的几次叫醒
      // 一分钟一个地连着发进同一个会话。第二次起要和上一次隔开，而且不在她正说着话时叫。
      if (now < nextWakeAt(events, config, dk)) return
      // 叫醒进的是哪个会话：调用方指定的优先，否则就是屋子那条（home.json）
      const sid = deps.sessionId ?? (await readJson(join(paths(root).root, 'home.json'), null).catch(() => null))?.sessionId
      if (sid && isBusy(sid)) {
        const why = '她正在说话，等这一轮结束再叫'
        const next = shouldLogSkip(skipLogged, dk, now, why)
        if (next) { skipLogged = next; log('skip', why) }
        return
      }

      running = true
      try {
        await wake(ctx, root, model, config, decision, dk, log, { ...deps, events, isBusy, waitIdle })
      } finally {
        running = false
      }
    } catch (err) {
      // 永不抛出：一次失败不能污染后续 tick
      log('tick failed', err?.message ?? err)
    }
  }

  timer = setInterval(() => { void tick() }, TICK_MS)
  wakeTimer = setTimeout(() => { void tick() }, INITIAL_DELAY_MS)
  if (typeof timer.unref === 'function') timer.unref()
  if (typeof wakeTimer.unref === 'function') wakeTimer.unref()

  return {
    tick,
    dispose() {
      disposed = true
      try { offBusy?.() } catch { /* ignore */ }
      if (timer) clearInterval(timer)
      if (wakeTimer) clearTimeout(wakeTimer)
      timer = null
      wakeTimer = null
    },
  }
}

/**
 * 今天的唤醒落点。写进 meta 事件（`sched:YYYY-MM-DD HH:MM`），
 * 这样重启后同一个落点会被沿用，不会因为重启就重新抽一次、把时间漂掉。
 */
async function ensureSchedule(root, config, events, dk) {
  const marker = `sched:${dk} `
  for (const e of events) {
    if (e.type === 'meta' && String(e.text ?? '').startsWith(marker)) {
      const at = Date.parse(String(e.text).slice(marker.length).trim())
      if (Number.isFinite(at)) return { at, reused: true }
    }
  }
  const seed = hashSeed(dk)
  const minutes = pickWakeTime(config, seed)
  const [y, mo, d] = dk.split('-').map(Number)
  const at = new Date(y, mo - 1, d, Math.floor(minutes / 60), minutes % 60, 0, 0).getTime()
  await appendEvent(
    { type: 'meta', text: `${marker}${new Date(at).toISOString()}` },
    { day: 0, stage: 1, source: 'timer' },
    root,
  )
  return { at, reused: false }
}

function hashSeed(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 100000) / 100000
}

/**
 * 醒之前让她"看见点东西"。
 *
 * 三个刻意的取舍：
 *   1. **刷站失败不算唤醒失败**。今天看不到就等于今天没看到，照样让她说话。
 *      （一个只能在社会条件齐全时才存在的人格，是脆的。）
 *   2. **配额单独算**（browse.perDay），与每日事件数无关。看几次和说几句话是两件事。
 *   3. **只给素材，不给结论**。全部网络文本在 browse.renderMaterial 里统一包成"素材"。
 *
 * @returns {Promise<{text:string, intro:string, picks:object[]}>}
 */
export async function lookBeforeWake(root, model, config, dk, deps, log) {
  const empty = { text: '', intro: '', picks: [] }
  if (!config?.browse?.enabled) return empty
  const perDay = Number(config?.browse?.perDay ?? 0)
  // forceBrowse（2026-10-26）：设置页那个「让她去刷 B 站」按钮专用。
  // 它只在**本机测试版**出现，用途就是验证「她到底能不能刷」——所以绕过
  // 当日上限与上网时段，别的什么都不改（素材仍然现场取、风控仍然生效）。
  const forced = deps.forceBrowse === true
  if (!forced && !(perDay > 0)) return empty

  // 上网时段（2026-10-23 加）：醒来和上网是两件事。
  // 醒了但不在上网时段 → 今天这轮不上网，她只说话、写日记。
  // 没配就退回全局时段，保持旧行为。
  const bw = Array.isArray(config?.browse?.window) ? config.browse.window
    : Array.isArray(config?.window) ? config.window
      : ['00:00', '23:59'] // 两处都没配 → 全天可上网，保持旧行为
  // deps.now 只为测试注入：线上永远走 new Date()。
  if (!forced && !inWindow({ window: bw }, deps.now ?? new Date())) return empty

  // 风控闸（2026-10-23）：被锁着就不碰 B 站，但人照样醒。
  // 以前的做法是"接口失败 → 静默返回空"，于是页面看起来像"她今天什么都没说"，
  // 而真相是被限流了。现在至少给她一句当时的处境，也给我们一个明确的日志。
  const st = riskState(root, deps.now ?? new Date())
  if (st.cooling) {
    log?.('risk cooldown', `还有 ${st.remainMin} 分钟`)
    return { ...empty, riskNote: '今天网络不太顺，什么都没翻到。过一阵再看。' }
  }

  try {
    const events = deps.events ?? (await readEvents(root)).events
    // 今天的次数用完就不刷了。注意：**素材是每次唤醒现场取的，不缓存**——
    // 缓存会让她连着几天看同一批东西，那是投喂，不是刷站。
    if (!forced && browseCountToday(events, dk) >= perDay) return empty

    // 刚被风控过 → 减半试探。不是"恢复原样当没发生过"，
    // 因为下一次撞墙的罚则会比这次更久。
    const bp = browsePlan(config, st)
    const cfg2 = (bp.topN === Number(config?.browse?.topN) && bp.deepRead === Number(config?.browse?.deepRead))
      ? config
      : { ...config, browse: { ...config.browse, topN: bp.topN, deepRead: bp.deepRead } }

    const client = deps.client ?? createClient({ log: (...a) => log?.('bili', ...a) })
    const r = await gather(client, model, cfg2, { root, dk, events })
    if (!r.ok || !r.text) {
      // 只把 B 站亲自回的 -352/-412/-509 记成持久罚则。
      // 我们自己的 COOLDOWN（内存里那 60 秒）不是证据，不能记——否则一次小磕碰会自我加码。
      if (isRiskCode(r.code)) noteRisk(root, r.code, deps.now ?? new Date())
      if (r.note) log?.('browse empty', r.note)
      return empty
    }
    await recordBrowse(root, dk, r.picks, model)
    return {
      text: r.text,
      intro: '## 你刚醒，屏幕上有人在说话\n这是平台此刻推到你面前的东西。你可以看，也可以不看。',
      picks: r.picks,
    }
  } catch (err) {
    if (isRiskCode(err?.code)) noteRisk(root, err?.code, deps.now ?? new Date())
    log?.('browse failed', err?.message ?? err)
    return empty
  }
}

/**
 * 唤醒那一刻的时间与缘由（2026-10-27 用户反馈）。
 *
 * 她在会话里第一次醒来时，只看到「（醒一醒）」，然后自己猜「大概不是我的时段」，
 * 还以为是权限出了问题。与其让她猜，不如把事实摆给她：现在几点、这一次是谁让醒的。
 *
 * `manual` = 有人按了叫醒（观测台按钮 / 首次建屋），否则是定时醒来；
 * `insideWindow` = 这一刻在不在她平时的活动时段里（跨零点窗口也交给 inWindow 判）。
 */
export function wakeTimeLine(now, { manual = false, insideWindow = true } = {}) {
  const d = now instanceof Date ? now : new Date(now)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const t = `${hh}:${mm}`
  if (!manual) return `现在是 ${t}，这一次是你自己醒的。`
  return insideWindow
    ? `现在是 ${t}。有人刚按了叫醒，要你现在醒。`
    : `现在是 ${t}。有人刚按了叫醒——这个点不在你平时的时段，是有人要你现在醒。`
}

async function wake(ctx, root, model, config, decision, dk, log, deps = {}) {
  const sc = ctx.sessionController
  if (!sc) { log('no sessionController'); return }

  // ---- 唤醒语只留「这一次」的情境 ----
  // 2026-10-23 用户指出：打开她的会话，看到的是一大块隐藏提示词。
  // 查了会话日志（agent/inbox/spliced → user/message），确认那块东西是**这条唤醒消息**：
  // 原来自带了整份身份段 + 工具说明 + 行为限制，一千多字。
  //
  // 2026-10-26 更正：这里的旧注释写「那些内容宿主本来就每轮从 home/AGENTS.md 注入」，
  // 那个通道 0.4.x 起已经不用了——身份改走 systemPrompt.section（lib/identity.js 挂载、
  // lib/selfdoc.js 渲染），system 角色、不进对话历史、界面看不见；selfdoc 还会 unlink
  // 旧 AGENTS.md。所以现在身份与处境是两条互不重复的路：
  //   system prompt（每轮现读同一个文件）＝ 她是谁；这条唤醒消息 ＝ 她此刻遇到什么。
  // 唤醒消息里任何"你是谁/你能做什么"的复述都是重复，交给身份文档。
  // 先给时间与缘由，再给处境：她至少不会把自己醒着这件事解释成「出了错」。
  const now = deps.now instanceof Date ? deps.now : new Date()
  const parts = [
    wakeTimeLine(now, { manual: deps.manual === true, insideWindow: inWindow(config, now) }),
    '',
    decision.prompt,
  ]

  // ---- P2：醒之前先让她"看见点东西" ----
  // 顺序是刻意的：先看，再想。如果先出事件提示再塞素材，
  // 她就会先按模板说话、再拿素材硬套——那是模板，不是她。
  // 反过来（先看见世界的动静，再问她怎么想）才像一个人醒来的样子。
  const look = await lookBeforeWake(root, model, config, dk, deps, log)
  if (look.text) {
    parts.push('', look.intro, '', look.text)
    // 带链接的清单（2026-10-23 用户提）：她能说出"有一条是一个人跑不起来了"，
    // 但你不知道是哪条，就接不上话。把链接摆在她眼前，她想指的时候才有东西可指。
    // 只给标题 + 链接，不给"重点在第几分钟"——标好重点她就只会复述。
    const wl = renderWatchList(look.picks)
    if (wl) parts.push('', wl)
    // 封面图（2026-10-23 用户提）：她没看过画面，但封面是这条视频对外的样子。
    // 用本地绝对路径的 markdown 图片——图已经落在本机，不依赖外网、不受防盗链影响。
    // 最多两张：多了就成了相册，不是她想说什么。
    if (look.picks?.length) {
      try {
        for (const p of look.picks.slice(0, 2)) {
          await fetchCover({ root, bvid: p.bvid, pic: p.pic, log })
        }
        const covers = coverLines(look.picks, root, 2)
        if (covers.length) parts.push('', ...covers)
      } catch { /* 一张图不能拖垮一次唤醒 */ }
    }
  }
  if (look.riskNote) parts.push('', look.riskNote)

  // 工具说明与上网说明不在这里重复：那两段在身份文档里（selfdoc.js 的
  // 「我手上有什么」「上网」两节，随配置现渲染，\`speak\` 关着时整节不写），
  // 而这整份文档每轮都以 system prompt 的形式在场。这里再写一遍 = 同一件事说两遍。

  // ---- P4：能不能在 B 站说话 ----
  // 关着的时候**连工具说明都不给**——不是"给了但拒绝"。
  // 差别很重要：给了再拒绝，她会反复试、会猜为什么被拒；
  // 不给，就等于这件事不存在，她不会去处理一个不存在的门。
  let canSpeak = config?.comment?.enabled === true
  if (canSpeak) {
    // 有人回她了才把素材递过去。没人回、或者她今天还没说话，就没必要提这件事。
    const events = (await readEvents(root).catch(() => ({ events: [] }))).events
    const waiting = await scanReplies({ root, events, dateKey: dk }).catch(() => [])
    if (waiting.length) {
      const txt = renderReplies(waiting)
      if (txt) parts.push('', txt)
    }
    // 能说话这件事的说明在身份文档的「在网上说话」一节（开关打开时 selfdoc 才写），
    // 不在这儿重复。
  }

  // 日记：**不再在叫醒消息里推**（2026-10-26，用户 m00928：「叫醒仅仅只是叫醒」）。
  // 病历：原来这里整段塞 diaryPrompt（「今天写日记…写今天发生了什么…」），加上后面的
  // 「想一想」段，一条叫醒消息里连着一个祈使句手册。她在 `fish-wake-2026-10-26-manual`
  // 的 reasoning 原话是「需要做的是：说一句…然后写日记」——她把它当成任务清单在执行。
  // 现在写法常驻在身份文档（persona.DIARY_BRIEF → selfdoc），她一直知道该记；
  // 叫醒只给处境，不再派活。

  // ---- 每 N 天的「想一想」----
  // 为什么必须是她自己做、而不是一个定时摘要器：
  //   摘要器写出来的自传是"别人替她解释她的一生"。哪怕她写得粗糙、写得少、
  //   写偏了，那也是她自己写的。
  // 判据用 growthDay 取模（不是自然日），这样改了 growthDays 也不会突然连发。
  // 同一天只用一次，靠 `meta sleep:<dk>` 兜住。
  // 做法写在身份文档（SLEEP_BRIEF），这里只给一句时机标记。
  const every = Number(config?.memory?.sleepEveryDays ?? 0)
  let askedSleep = false
  if (every > 0 && model.day > 1 && model.day % every === 0) {
    const events0 = (await readEvents(root).catch(() => ({ events: [] }))).events
    const doneToday = events0.some((e) => e?.type === 'meta' && String(e.text ?? '').startsWith(`sleep:${dk}`))
    if (!doneToday) { parts.push('', SLEEP_TODAY); askedSleep = true }
  }

  // ---- 规则解禁申请（R3，2026-10-24）----
  // 时机：由「最后一条证据是哪天」+ 稳定偏移（1–3 天）算出来，不用随机数（每次 tick 重算会抖）。
  // 内容：不是随机抽的，是某个她已经用行为走到门边的规则。
  // 一次醒来最多提一条；上一张没处理就不出新的。
  // 0.7.5：这一轮如果真的出了一张申请，等她的回合起来之后要**在会话里问她那个人**。
  // 为什么不能在这里直接问：此刻还在拼正文，会话还没建、agent 还没醒，
  // 宿主只认 live root agent（见 askinchat.js 的说明），问出去必得 CALLER_NOT_LIVE。
  let offered = null
  if (config?.rules?.offers !== false) {
    const ev2 = (await readEvents(root).catch(() => ({ events: [] }))).events
    if (!pendingOffer(ev2, Date.now())) {
      for (const r of grantableRules()) {
        const due = offerDueDay(r.id, model, ev2)
        if (due === null || model.day < due) continue
        try {
          const ev = validateEvent(
            {
              type: 'grant_offer',
              text: `我想试试「${r.title}」这件事。不是现在就要，是想问问你。`,
              grant: { rule: r.id },
              day: model.day,
              stage: model.stage,
            },
            { day: model.day, stage: model.stage, source: 'system' },
          )
          // 0.7.4 修：第二参是 ctx、第三参才是 root。
          // 原来写成 appendEvent(ev, root)，root 落在 ctx 位置 → source 落回默认 'tool'
          // → schema 以 NOT_HER_TYPE 拒掉 grant_offer（她不能写系统事件），
          // 于是「我想试试『X』」这条申请从来没进过事件流，整个授予规则是死的。
          await appendEvent(ev, { day: model.day, stage: model.stage, source: 'system' }, root)
          parts.push('', offerPrompt(r))
          offered = { id: ev.id, rule: r.id, title: r.title }
        } catch (err) {
          log('grant offer failed', err?.message || err)
        }
        break
      }
    }
  }
  // 「这一次的处境」不再放进对话（2026-10-25 晚，用户 m04080）。
  // 宿主没有「模型看得见、用户看不见」的通道（asar 已核实：PromptContentPart
  // 没有 hidden 字段、SurfaceOp 只有 append/replace），所以正文改走 system prompt
  // 的动态段 `fish:wake`，对话里只留一句极短的触发语把这一轮点起来。
  // 这样对话框里不会再出现「你该醒了」「这次推给你的是……」这些系统的话。
  // 注意：`setWakeSection` 要等会话确定之后再设，否则提前 return 会留下脏段落。
  // ---- 今天最后一段：只给时机，不派活（2026-10-29，用户 m01296 B）----
  // 日记的「做法」常驻身份文档，但一整天没有一个「到今天了」的节点，于是三天零篇。
  // 这里只在当天最后一次叫醒里加一句处境：写不写、写什么，由她自己定。
  // 上限取两个闸门里更小的那个（plan() 同时看 daily.events 与 wakesPerDay）。
  // 手动唤醒不占这个「最后一段」的位置太多说，照常参与判断即可。
  try {
    const evs = deps.events ?? (await readEvents(root).catch(() => ({ events: [] }))).events
    if (isLastWakeOfDay(config, todayCounts(evs, dk))) parts.push('', DAY_END_CUE)
  } catch { /* 一句时机不该拖垮一次唤醒 */ }

  const content = parts.filter(Boolean).join('\n').trim()
  // 空正文就别唤醒：没有处境可讲，起了也是空转。
  if (!content) {
    log('wake skipped: empty body')
    return
  }
  // 给 wake 段加一句性质说明：对话里那句括号短句是叫醒信号，不是用户的话。
  const wakeText = `${WAKE_HINT}\n\n${content}`
  // ---- 会话（P3 改造）----
  // 2026-10-23 用户定案：她的**所有**开口都落进侧栏那个真实会话，
  // 不再每天另起 `fish-wake-YYYY-MM-DD`。
  // 理由：用户要的是"打开就能看见她"，不是"去一个隐藏会话里找她说过什么"。
  // 副作用（刻意接受）：定时唤醒的内容会出现在同一条对话流里，读起来像
  //   「她自己在那个房间里说话了」——这正是要的效果。
  // 手动唤醒以前传 deps.sessionId（带时间戳的独立会话），2026-10-26 改掉：
  // 用 cwd 建的会话没有工作区归属，宿主侧栏把它丢进「未分组」，用户在
  // 「大肥鱼的家」里看不见（m00507）。现在 wakeNow 也先取屋子会话。
  let sessionId = deps.sessionId
  if (!sessionId) {
    // 2026-10-24 改：不再退回 `fish-wake-${dk}`（那种用 cwd 建的会话没有工作区
    // 归属，宿主侧栏会把它丢进「未分组」）。没有屋子就不开口——但**留一条记录**，
    // 免得「她今天没说话」被读成人格或心情问题。
    sessionId = await talkSessionId(ctx, { root, log })
    if (!sessionId) {
      await appendEvent(
        { type: 'meta', text: `wakefail:${dk} 屋子没接上，这次没开口` },
        { day: model.day, stage: model.stage, source: 'timer' },
        root,
      ).catch(() => {})
      log('no home session; skip wake')
      return
    }
  }

  // cwd = 她自己的房间（root/her），**不是 root**。
  // 以前写的是 root：她站在状态库正中央，`cat events.jsonl` 就能把自己
  // 的全部历史、配置、黑名单读一遍——B 文档 §N3 声称做不到，实现却在放水。
  // 现在她在一个空目录里，状态库是父目录，要碰得主动 `cd ..`。
  const herDir = deps.herDir ?? await ensureHer(root)
  try {
    await sc.create({ sessionId, cwd: herDir })
  } catch { /* 已存在，继续用 */ }

  const ac = new AbortController()
  const kill = setTimeout(() => ac.abort(), WAKE_TIMEOUT_MS)

  // ---- 报告的两种写法 ----
  // 先写一次：让用户在等回复的这段时间里就能看到"她今天看了什么"。
  // 再等回合真正结束，重写一次补上"她说了什么"。
  // 为什么需要第二次：prompt() 只等消息**入队**，不等模型想完——
  // 真机实测报告比她的原话早落盘 8 秒，于是永远显示"今天她什么都没说"。
  const writeReport = async () => {
    // 每次都重读事件流：报告要包含"她刚说的话"，而那几条是她想完之后才落盘的。
    const fresh = await readEvents(root).then((r) => r.events).catch(() => [])
    // 这里**不再弹通知**。原实现 spawn 隐藏 PowerShell（-WindowStyle Hidden
    // -EncodedCommand），被火绒当木马行为拦下；更糟的是静默拦截时没有任何
    // 错误返回，`lastShown` 照样被写掉 → 当天再也不会弹，而日志干干净净。
    // 现在由观测台页面轮询 `GET /notify` 自行决定弹不弹（lib/notify.js）。

    return flushReport(root, {
      dateKey: dk,
      // 三档口径一次取齐（看过画面 / 翻到过 / 递了没看），别在报告里另算一遍。
      seen: seenOn(fresh, dk),
      notes: [],
      diaryVisible: config.diary?.visible === true,
    }).catch(() => null)
  }

  // 刷站那几十秒里她可能刚好开始了别的一轮（有人找她）。等那一轮说完再挂处境、再叫：
  // watcher 认的是会话不是这一轮，挂早了会被那一轮的 turn/end 收走。
  if (typeof deps.waitIdle === 'function') await deps.waitIdle(sessionId)

  // 这一轮她写的话不算他来过：唤醒时间窗开到 turn/end，不是开到入队（见 wakewin.js）。
  // turn/end 不来时跟处境一起由下面的兜底关；没送进去就在 catch 里关。
  const releaseWake = holdWake()
  const watcher = watchTurnEnd(ctx, sessionId, () => { releaseWake(); void writeReport(); clearWakeSection() })

  // 处境走 system prompt 段；对话里只留这一句（她看到的是「有人来了」，不是剧本）。
  setWakeSection(wakeText)
  try {
    await sc.prompt(
      { requestId: `wake-${dk}-${Date.now()}`, sessionId, mode: 'queue', content: [{ type: 'text', text: WAKE_TRIGGER }] },
      ac.signal,
    )
    // ---- 在会话里问她那个人（0.7.5，用户 m00239）----
    // 申请已经落盘（pendingOffer 从此看得见），这里补的是「让她当面问出来」：
    // 卡片弹在她那条会话的输入框上方，人选「可以 / 这次不行」当场落成一条 grant。
    // 不阻塞唤醒：问不问得到都不影响这一轮她自己说话，报告也照常先写一版。
    // 没问到（超时 / 答人不在线 / 宿主没这服务）就什么都不做——
    // 观测台的规则页仍然看得见这张申请，那条老路一直留着当兜底。
    if (offered) void askOfferInChat(ctx, root, { sessionId, offer: offered, log })

    await appendEvent(
      { type: 'meta', text: `wake:${dk} ${decision.template?.id ?? '?'}` },
      { day: model.day, stage: model.stage, source: 'timer' },
      root,
    )
    // 每条模板都要落 fired 标记（2026-10-24 起）：once 靠它判断用没用过，
    // 可重复的模板靠它的时间戳算冷却（repeat.everyDays）——光有 id 算不出"隔了多久"。
    if (decision.template?.id) {
      await appendEvent(
        { type: 'meta', text: `fired:${decision.template.id}` },
        { day: model.day, stage: model.stage, source: 'timer' },
        root,
      )
    }
    // 想过了就记一笔，免得同一天再问一次（她可能什么都没写，也算问过了）。
    if (askedSleep) {
      await appendEvent(
        { type: 'meta', text: `sleep:${dk}` },
        { day: model.day, stage: model.stage, source: 'timer' },
        root,
      )
    }
    log('woke', sessionId, decision.template?.id)

    // 第一版报告：这时她大概还没说完，所以"她说了什么"多半是空的。
    // 先写一版是为了用户点完按钮立刻就能看到"今天看了什么"。
    await writeReport()

    // 然后**不阻塞**，把重写挂在她的回合结束上。
    // prompt() 只等消息入队、不等模型想完（真机实测：报告比她的原话早落盘 8 秒，
    // 于是报告永远显示"今天她什么都没说"）。所以第二次重写必须由 turn/end 触发。
    // 不 await 是刻意的：唤醒本身不该被拖住。
    // ⚠️ 监听器的注销必须在 finally **之外**做——放进 finally 会当场把它摘掉，
    // 于是 turn/end 永远等不到，报告又是一版空的。
    // 同理，`clearWakeSection()` 也不能放 finally：prompt() 只等入队就返回，
    // 她还没开始想，这里清掉等于她根本看不到这次处境。
    // 兜底：如果 turn/end 一直不来，最迟 REPORT_WAIT_MS 后也把段落清掉，
    // 免得残留到下一轮（他之后主动聊天时会看到她上一次的处境）。
    // 兜底只管「turn/end 一直不来」：她还在这一轮里（读字幕、看画面常常超过 90 秒）
    // 就别把处境抽走，过一会儿再看；isBusy 自带过期，不会一直拖下去。
    const fallback = () => {
      if (!watcher.fired && typeof deps.isBusy === 'function' && deps.isBusy(sessionId)) {
        setTimeout(fallback, 30_000).unref?.()
        return
      }
      try { watcher.off?.() } catch { /* ignore */ }
      if (!watcher.fired) clearWakeSection()
      releaseWake()
    }
    setTimeout(fallback, REPORT_WAIT_MS).unref?.()
  } catch (err) {
    // 这一次没起来，处境要立刻清掉，唤醒时间窗也关上。
    clearWakeSection()
    releaseWake()
    await appendEvent(
      { type: 'meta', text: `wakefail:${dk} ${String(err?.message ?? err).slice(0, 120)}` },
      { day: model.day, stage: model.stage, source: 'timer' },
      root,
    ).catch(() => {})
    log('wake failed', err?.message ?? err)
    try { watcher.off?.() } catch { /* ignore */ }
  } finally {
    clearTimeout(kill)
  }
}

/**
 * 在会话里问她那个人（0.7.5，用户 m00239）。
 *
 * 为什么不能在她申请的那一刻当场问：申请是在 tick()/wake() 里写的，
 * 那时会话还没建、agent 还没醒，宿主的 user-questions 只认**活着的 root agent**
 * （`assertLiveRoot`），问出去必得 CALLER_NOT_LIVE。所以她先把申请落盘，
 * 等这一轮真的醒过来了，再借那条会话的输入框把话问出去。
 *
 * 三件事写死在这里：
 * - 不抛、不 await 到阻塞唤醒：`void` 调，失败只留一条日志。
 * - 没答到（超时 / 人不在 / 宿主没这服务）什么都不写——申请仍是 pending，
 *   观测台规则页那条老路照样能裁决。
 * - 只认「可以」和「这次不行」两个词，别的当没答。
 */
async function askOfferInChat(ctx, root, { sessionId, offer, log = () => {} } = {}) {
  if (!sessionId || !offer?.id) return
  try {
    const r = await askInChat(ctx, {
      sessionId,
      questions: [
        {
          id: 'grant',
          header: '大肥鱼想申请一件事',
          question: `她想试试「${offer.title}」。不是现在就要，是想问问你。`,
          options: [{ label: '可以' }, { label: '这次不行' }],
        },
      ],
    })
    if (!r.ok) {
      log('offer ask skipped', r.code)
      return
    }
    const said = picked(r.answers, 'grant')
    const verdict = said === '可以' ? 'approve' : said === '这次不行' ? 'reject' : ''
    if (!verdict) return
    const w = await recordGrant(root, { offerId: offer.id, rule: offer.rule, verdict })
    if (!w.ok) log('offer grant failed', w.error)
  } catch (err) {
    log('offer ask failed', err?.message || err)
  }
}

/**
 * 手动唤醒（观测台上的按钮 / 测试用）。不受时间窗限制。
 *
 * 注意 dk 必须是**纯日期**，不能像早期那样传 `${dk}-manual`：
 * 那个后缀会跟着进 browse 记账、日记文件名、报告文件名和会话 id，
 * 于是报告按 `2026-10-23` 去查，记账却写在 `2026-10-23-manual` 里 →
 * 报告"看了什么"永远显示"今天没看"。区分手动只用在 sessionId 上。
 *
 * 2026-10-26（用户 m00507）：**手动唤醒也走屋子会话**。
 * 原来的实现每次手动唤醒都伪造一个 `fish-wake-<dk>-manual-<ts>` 的 id，
 * 宿主不认识这个 id → `sc.create({ sessionId, cwd: herDir })` 按 cwd 建一条
 * 新会话，而她的房间（`~/.dsh-fish/home/her`）是工作区 `~/.dsh-fish/home`
 * 的**子目录**，匹配不上工作区路径 → 侧栏把它丢进「未分组」。
 * 用户看到的就是「叫醒之后，对话到了未分组」。
 * 现在先拿屋子里那条真会话（它由 workspaceId 建，天然属于家）；
 * 只有拿不到屋子时（测试 / 屋子坏了）才退回旧的伪造 id，让调试还能用。
 */
export async function wakeNow(ctx, deps = {}) {
  const root = deps.root ?? rootDir()
  // 0.7.4（用户 m00659 C）：手动叫醒也要认「她不在家」。
  // tick() 早就有一道闸门（下面 109 行一带）：有 active 出门/请神就整段 return，
  // 理由是「两条会话并行会互相踩 events.jsonl，还会在侧栏里凭空多出一条『家里醒了』」。
  // 手动 /wake 以前绕过了它 —— 出门期间点「叫她一次」会把**家里**那条真叫醒一轮，
  // 那一轮写出的事件 cwd 在家、guardWrite 全放行，回家核对时又被判成「正常追加」，
  // 于是出门那趟的账上凭空多出几条家里发生的事。现在同样拒绝，除非显式 force。
  const away = deps.force ? { kind: null } : await awayNow(root)
  if (away.kind) {
    const line = awayLine(away)
    // 0.7.6（2026-10-29 用户 m02022）：这道闸门以前是**静默**的——被挡住时一行日志都不留，
    // 于是点了「叫她一次」之后，日志里什么都没有，事后分不清「用户没点」和「点了被挡回去」。
    // 现在落一行，带上是哪种 away 和当时的 why；这条走 logLine 直接写盘，
    // 因为下面那句 `const log = deps.log ?? ...` 还没执行到。
    const told = `叫醒被挡住了（${away.kind}）：${line || '她在外面'}`
    logLine('info', [told], root)
    try { deps.log?.(told) } catch { /* 宿主 logger 坏了不能影响返回值 */ }
    return {
      ok: false,
      away,
      why: `${line || '她正在外面'}。家里这条先不叫她——两边同时醒着会互相踩同一份记录。`,
    }
  }
  const { events } = await readEvents(root)
  const { config } = await loadConfig(root)
  const model = deriveSelf(events, { growthDays: config.growthDays })
  const dk = dateKey()
  const counts = { dateKey: dk, sent: 0, questions: 0, proactive: 0 }
  // focus='browse'：设置页那个「让她去刷 B 站」按钮（**仅本机测试版**，2026-10-26）。
  // 不走 plan()——plan 判的是「今天该不该醒」，而这个按钮是人工要求她醒一次去看站；
  // 语气也别写成"任务"，她看到"去看一眼"会自己决定看不看。
  const forcedBrowse = deps.focus === 'browse'
  if (forcedBrowse) deps = { ...deps, forceBrowse: true }
  let decision = forcedBrowse
    ? { action: 'wake', prompt: '（现在，去看一眼 B 站首页在推什么。）', template: { id: 'manual-browse' } }
    : plan(model, config, counts, events, { squeeze: gapSqueeze(gapSinceLastWake(events)) })
  const log = deps.log ?? (() => {})
  // 2026-10-31（用户 m02943 / m03076）：手动点叫醒，卡池空了也照醒。
  //
  // 原来的行为是「手动也叫不动」：plan() 里除了当天配额，还有模板冷却和 cond，
  // 手动这条路只把 counts 清零，冷却和 cond 一样要过。于是 stage 1 那五张卡
  // 一旦都出不来（once 用过、cond 不满足、冷却没到），点多少次都返回
  // 「没有满足条件的事件模板（今天不打扰）」——人明明站在门口按了铃，
  // 里面却回一句「今天没什么事」，这是**明确的人工请求被机器挡回去**。
  //
  // 所以：配额照旧（那是「今天该不该自己醒」，手动不该突破），但卡池空不再是拒绝理由。
  // 给她的不是一张卡，是一句「今天没有待办」——不派活，也不假装有事发生
  // （2026-10-29 m01296 B「叫醒仅仅只是叫醒」的延续）。
  if (decision.action === 'quiet') {
    const why = decision.why || '卡池空'
    // 用一个不在 CATALOG 里的 id：`fired:manual-idle` 落盘也无害，
    // isSpent 只按卡片的 id 查，这张卡不存在，于是谁也占不到冷却。
    decision = {
      action: 'wake',
      prompt: '（现在没有待办。这一轮是你自己的——想做什么就做什么，也可以什么都不做。）',
      template: { id: 'manual-idle' },
    }
    log(`手动叫醒：${why}，照醒，不派活`)
  }
  if (decision.action !== 'wake') return { ok: false, why: decision.why ?? 'no candidate' }
  let sessionId = deps.sessionId
  if (!sessionId) {
    sessionId = await talkSessionId(ctx, { root, log }).catch(() => '')
    if (!sessionId) {
      sessionId = `fish-wake-${dk}-manual-${Date.now()}`
      log(`屋子没接上，这次手动唤醒用独立会话（会落进「未分组」）：${sessionId}`)
    }
  }
  await wake(ctx, root, model, config, decision, dk, log, { ...deps, sessionId, manual: true })
  return { ok: true, template: decision.template?.id, sessionId }}

/**
 * 今日配额：从事件流里数，不用内存。
 *
 * 2026-10-25 修：原来两处都数不到东西——
 *   · `sent` 只数 `event:` 前缀，但全库没人写 `event:`（唤醒写的是 `wake:`）→ 恒 0；
 *   · `questions` 声明后从不累加 → `daily.questions`（设置页「会向你进行几次提问」）永远拦不住。
 * 于是「每天最多几个事件」「最多几个问题」两个旋钮都是摆设，真正生效的只有 wakesPerDay。
 *
 * 现在统一从 `wake:<日期> <模板id>` 数：一条 wake 就是一个事件；
 * 模板的 asks 决定它算不算一次提问（静态表查询，不依赖模型）。
 */
export function todayCounts(events = [], dk) {
  let sent = 0
  let questions = 0
  let proactive = 0
  for (const e of events) {
    if (e.type !== 'meta') continue
    const t = String(e.text ?? '')
    if (!t.startsWith('wake:')) continue
    const [head, id] = t.slice(5).trim().split(/\s+/)
    if (head !== dk) continue
    proactive++
    sent++
    const tpl = id ? findTemplate(id) : null
    if (tpl?.asks) questions++
  }
  return { dateKey: dk, sent, questions, proactive }
}

/**
 * 这一醒是不是「今天最后一段」（2026-10-29，用户 m01296 B）。
 *
 * plan() 的两个闸门同时生效：`daily.events` 管当天事件数、`wakesPerDay` 管主动唤醒数，
 * 所以当天真正还能醒几次由两者里更小的那个决定。这里按同一口径回答一句话：
 * 已经醒过 `counts.sent` 次，加上这一次是否就顶到上限。
 *
 * 只用于「给个时机」，不参与该不该醒的判断——判断在 plan() 里，别把两件事混成一件。
 */
export function isLastWakeOfDay(config, counts) {
  const cap = Math.min(Number(config?.daily?.events ?? 1), Number(config?.wakesPerDay ?? 1))
  if (!Number.isFinite(cap) || cap <= 0) return false
  return Number(counts?.sent ?? 0) + 1 >= cap
}

/**
 * 今天下一次叫醒最早什么时候（2026-10-29）。
 *
 * 今天还没醒过就不拦（返回 0，交给落点判断）。醒过之后，把剩下的几次摊在
 * 「上一次 → 今天时段结束」这段里：间隔 = 剩余时长 / (剩余次数 + 1)，至少 WAKE_MIN_GAP_MS。
 * 结束点取时段结束与当天午夜里早的那个——过了零点日期一换，计数就从头算了。
 * 配额已满返回 0：那是 plan() 的事（它会 skip），这里不重复判断。
 */
export function nextWakeAt(events = [], config = {}, dk = dateKey()) {
  let last = 0
  for (const e of events) {
    if (e?.type !== 'meta') continue
    const [head] = String(e.text ?? '').startsWith('wake:') ? String(e.text).slice(5).trim().split(/\s+/) : []
    if (head !== dk) continue
    const at = Date.parse(e.ts || '') || 0
    if (at > last) last = at
  }
  if (!last) return 0
  const quota = Math.min(Number(config?.daily?.events ?? 1), Number(config?.wakesPerDay ?? 1))
  const left = quota - todayCounts(events, dk).sent
  if (!(left > 0)) return 0
  const d = new Date(last)
  let end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
  const [eh, em] = String(config?.window?.[1] ?? '').split(':').map(Number)
  const windowEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate(), eh, em).getTime()
  // 不跨零点的时段，或跨零点而这次是零点后醒的：时段在今天之内就结束
  if (Number.isFinite(windowEnd) && windowEnd > last) end = Math.min(end, windowEnd)
  return last + Math.max(WAKE_MIN_GAP_MS, Math.floor((end - last) / (left + 1)))
}

/**
 * 空档天数（2026-10-25）。
 *
 * 她不是一直在跑：DSH 关掉几天、或者某天没到点在窗里，这段空白会白白吃掉成长期。
 * 这里只回答一件事——「距上一次唤醒过了几天」，由调用方决定怎么补偿。
 * 没有任何唤醒记录（刚装好/刚重置）返回 0，不做补偿。
 */
export function gapSinceLastWake(events = [], now = Date.now()) {
  let last = 0
  for (const e of events) {
    if (e.type !== 'meta' || !String(e.text ?? '').startsWith('wake:')) continue
    const at = Date.parse(e.ts || '') || 0
    if (at > last) last = at
  }
  if (!last) return 0
  return Math.max(0, (Number(now ?? Date.now()) - last) / 86_400_000)
}

/**
 * 空档补偿系数。
 *
 * 断了两天以上，这一次唤醒的冷却按一半算——否则短成长期（7 天）里
 * 一次三天没开，剩下的四天就轮不完四张卡。
 * 系数只作用于**这一次**唤醒，不写盘、不累积。
 */
export function gapSqueeze(gapDays) {
  const g = Number(gapDays) || 0
  if (g >= 4) return 0.35
  if (g >= 2) return 0.5
  return 1
}

/**
 * skip 日志要不要写（2026-10-28）。
 *
 * 背景：用户发来的运行日志里，22:15 到 23:00 每分钟一条
 * `skip 今日主动唤醒已满(1/1)`，几十条同样的字把日志刷满，
 * 真正的报错（比如工具有没有注册上）反而被埋掉。
 *
 * 配额是当天的固定值，原因不变就没有重述的必要：同一小时 + 同一原因只记一条。
 * 纯内存判定，不写 events.jsonl——这只是日志噪音，不该污染她的记忆。
 *
 * @param {string} prev  上一次的记录，形如 `2026-10-28T22|今日主动唤醒已满(1/1)`
 * @param {string} dk    日期键 YYYY-MM-DD
 * @param {number} now   毫秒时间戳
 * @param {string} why   这次 skip 的原因
 * @returns {string}     要存下来的新记录；返回等同 prev 时调用方就不该写日志
 */
export function shouldLogSkip(prev, dk, now, why) {
  const hourKey = `${dk}T${new Date(Number(now) || Date.now()).getHours()}`
  const next = `${hourKey}|${String(why ?? '')}`
  return next === prev ? '' : next
}
