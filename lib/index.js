/**
 * index.js —— 插件入口
 *
 * 坑（whale-src/lib/index.js:120 的注释，已复现过）：
 *   inject 必须写成**一个数组**。写成两个键（对象字面量）会后者覆盖前者，
 *   sessionController 静默缺失 → 定时器每分钟空转、不报错也不干活。
 *
 * 生命周期：
 *   apply → 读配置 → 播种(首次) → 起定时器 → 注册工具 → 注册观测台路由
 *   dispose → 停定时器、注销路由。停用插件 = 零后台活动。
 */

import { rootDir, readEvents, appendEvent, readJson, paths, writeAtomic, ensureHer } from './store.js'
import { loadConfig } from './settings.js'
import { deriveSelf } from './derive.js'
import { registerCapture } from './capture.js'
import { registerLook } from './look.js'
import { registerSpeak } from './speak.js'
import { registerRecall } from './recall.js'
import { registerHerDiary } from './herdiary.js'
import { registerWatch } from './watch.js'
import { registerLetter } from './letter.js'
import { registerNote } from './note.js'
import { registerBringBack } from './keep.js'
import { registerAsk } from './ask.js'
import { answerCard } from './cardanswer.js'
import { registerDream } from './dream.js'
import { registerProactive } from './proactive.js'
import { registerObserve } from './observe.js'
import { startScheduler } from './scheduler.js'
import { registerTurns } from './turns.js'
import { bootstrapHome, homeStatus, wakeIfBlank } from './home.js'
import { ensurePocketOrder, findPocketWorkspace } from './pocket.js'
import { noteRoot } from './homes.js'
import { writeSelfDoc } from './selfdoc.js'
import { claimRoot, beatRoot, releaseRoot, HEARTBEAT_MS } from './tenant.js'
import { registerToolRestrict } from './restrict.js'
// `clearWakeSection` 在 dispose 里用：它挂在 system prompt 段上，是个模块级变量，
// 停用时不清的话下次启用会带着上一次的残留（2026-10-25）。
import { clearWakeSection, registerIdentity } from './identity.js'
import { registerPossession } from './possess.js'

import { checkUpgrade } from './upgrade.js'
import { checkHost, readHostVersion } from './hostver.js'
import { logBoot, makeLogger } from './log.js'

export const name = 'dsh-fish'

/** 版本号：只用于日志导出（排查时第一件事是确认跑的是哪一版）。 */
export const VERSION = '0.9.1'

// ⚠️ 一个数组写全，不要拆成对象
// 2026-10-30（m02961）：`userQuestions` **不再写进 inject**。写进 inject 的东西缺一个，
// 整个插件在 import 阶段就被静默跳过——连 boot 都没进，一行日志都不留。
// 而 `userQuestions` 只关掉「她在会话里问你」这一条路，不值得拿整个插件去赌；
// 现在改成运行时探测（见 boot 里的 compat），缺了就降级。
export const inject = ['sessionController', 'tools', 'webServer', 'connection']

const SEED_KEY = 'seed:'

export function apply(ctx, baseConfig = {}) {
  const root = baseConfig.root || process.env.DSH_FISH_HOME || rootDir()
  const disposers = []
  let scheduler = null
  // 自己的日志（落 ~/.dsh-fish/logs/，带滚动），同时继续转发宿主 logger。
  // 为什么要自己写一份：宿主的 logger 不回读，出事之后现场就没了。
  const logger = makeLogger(ctx, root)
  // 工具面收窄的结果（给自检读）。applied 是"真的挂上过几次"，
  // 不是"注册了没有"——注册了但没匹配到 agent 等于没生效，这两件事必须分开。
  let restrictState = { ok: false, applied: 0, why: 'not attempted', allow: [] }
  // 多租户（2026-10-28 m01319）：这个对象是「这个实例认哪个家、它还是不是房主」的唯一真相，
  // 工具注册时按引用传下去 —— boot 之后填进来，工具执行时现读，不做拷贝。
  const tenancy = { root, herDir: '', tenant: { ok: true, instanceId: '', why: '' } }
  // 升级自检（2026-10-29）：`file:` 装的人常常只换了源目录，跑的还是 node_modules 里的旧副本。
  // 这里只读不写；查不到就写 skipped，不影响启动。
  const install = {
    upgrade: { ok: false, skipped: true, why: '还没查', running: VERSION, source: '', sourcePath: '', profile: '', stale: false },
    // 宿主版本（2026-10-30 m03193）：package.json 的 engines.dsh 声明范围，这里运行时对一次账。
    host: { ok: false, status: 'unknown', version: '', range: '', why: '还没查' },
  }
  // 宿主兼容（2026-10-30 m02961）：只在运行时探测，不写进 inject。
  // 写进 inject 的代价是「缺了就整个插件不装」——而缺的那个服务只关掉一条功能。
  const compat = { checked: false, userQuestions: false }
  let heartbeat = null

  async function boot() {
    logBoot(root, `${VERSION} · ${process.version} · ${process.platform}`)
    // 宿主兼容探测：`userQuestions` 缺席时不是错误，只是关一条路——但必须留话，
    // 否则用户只会看到「有个功能没反应」，又回到这次那种查不下去的局面。
    try {
      compat.userQuestions = typeof ctx?.get?.('userQuestions')?.ask === 'function'
    } catch { compat.userQuestions = false }
    compat.checked = true
    if (!compat.userQuestions) {
      logger.warn('[dsh-fish] 这个宿主没有提供 userQuestions 服务（可能是旧版本没装 dsh-user-questions，或服务没起来）：插件照常跑，但「她在会话里问你」这条路暂时关掉。')
    }
    // 宿主版本对账（2026-10-30 m03193）：只读、只留话。
    // 桌面版把宿主装在 app.asar 里，从插件位置向上找不到 package.json——那就记 unknown，
    // 不把「读不到」当成「不兼容」。
    try {
      const found = readHostVersion()
      install.host = found ? checkHost({ version: found.version }) : checkHost({ version: '' })
      if (!install.host.ok) {
        logger.warn(`[dsh-fish] ${install.host.why}（插件声明的范围：${install.host.range}）。插件照常跑，但这个组合没测过。`)
      }
    } catch (err) {
      install.host = { ...install.host, status: 'unknown', why: String(err?.message ?? err).slice(0, 120) }
    }
    // 先查一次「跑的是不是源目录里那份」：这类问题没有任何报错，只有版本对不上。
    try {
      install.upgrade = await checkUpgrade({ version: VERSION })
      if (install.upgrade.stale === true) {
        const u = install.upgrade
        logger.warn(`[dsh-fish] ${u.why}。改的是源目录，装进去的是另一份——要么 pnpm install --force，要么删掉 node_modules\\dsh-fish 再启动。`)
      }
    } catch (err) {
      install.upgrade = { ...install.upgrade, skipped: true, why: String(err?.message ?? err).slice(0, 120) }
    }
    const { config } = await loadConfig(root)
    // 她自己的房间必须先存在：她的会话 cwd 指向这里（不是 root），
    // 这样她不会一睁眼就站在自己的 events.jsonl 旁边。
    const herDir = await ensureHer(root)

    // ---- 一个 root 只认一个实例（2026-10-28 m01319）----
    // root 是进程级解析的：两个工作区如果都落到同一个家，光看调用者 cwd 分辨不出来
    // （两边 cwd 都在这个 root 里，校验会同时通过）。所以加载时先占位：
    // 谁先占谁是房主；后进来的认出来之后**不写也不崩** —— 她还能说话，只是不落盘。
    try {
      const claim = await claimRoot(root, { version: VERSION })
      tenancy.tenant = claim
      tenancy.herDir = herDir
      if (!claim.ok) {
        logger.error(`[dsh-fish] ${claim.why}`)
      } else if (claim.instanceId) {
        const id = claim.instanceId
        heartbeat = setInterval(() => {
          beatRoot(root, id)
            .then((still) => {
              if (still === false && tenancy.tenant.ok !== false) {
                // 续不上 = 家被别人接管了。从此不再写，也不再抢回来（否则两边来回覆盖）。
                tenancy.tenant = {
                  ok: false,
                  instanceId: id,
                  why: '这个家已经被另一个实例接管了，之后不再写入。',
                }
                logger.warn('[dsh-fish] 占用权丢了，停止写入')
              }
            })
            .catch(() => {})
        }, HEARTBEAT_MS)
        heartbeat.unref?.()
      }
    } catch (err) {
      logger.warn('[dsh-fish] 占用声明失败，按无冲突继续', err?.message ?? err)
      tenancy.herDir = herDir
    }

    const { events } = await readEvents(root)

    // ---- 换家留痕（2026-10-28 房客日志 m01863）----
    // 换 root 就是换家：老家的数据留在原地，跟新家没有任何关系。这句话
    // 用户最容易误解成「搬家」，于是改成配置之后发现侧栏多出一间屋、旧的还在。
    // 这里只做两件事：把「这次住哪」记进数据目录之外的登记表；换了就写一条
    // meta 事件说明从哪到哪。**不迁移、不删除、不合并**。
    try {
      const moved = await noteRoot(root)
      tenancy.homes = moved
      if (moved.changed) {
        const last = events[events.length - 1]
        const day = Number(last?.day ?? 1) || 1
        const stage = Number(last?.stage ?? 1) || 1
        logger.warn(`[dsh-fish] 家换了：${moved.from} → ${moved.to}`)
        await appendEvent(
          {
            type: 'meta',
            text: `家换了：${moved.from} → ${moved.to}。这不是搬家——旧家的东西还在旧地方，没有并过来；这边从一开始就是新的。`,
          },
          { day, stage, source: 'system' },
          root,
        )
      }
    } catch (err) {
      logger.warn('[dsh-fish] 换家记录失败', err?.message ?? err)
    }

    // 首次启动播种：她最初的那一点点性格，是**第一个事实**，不是可调参数。
    // 之所以写成事件而不是配置项：配置项会被"打开设置页改一下"，
    // 事件只能追加——想改就得由她自己 revise，这是 N4 的地基。
    const hasSeed = events.some((e) => e.type === 'seed')
    if (!hasSeed) {
      const seedText = String(
        // 起点只写**处境**，不写她是什么样的人。
        // 原来这里是一整段性格描述（"能感觉到的东西很少""不太会把它说清楚"
        // "对被人安排有一种说不清的抵触"）。这段话每轮都在她眼前，
        // 等于给她发了一张终身有效的人格说明书——用户 2026-10-23 指出这一点。
        // 现在她只知道：我刚开始存在，没人告诉我为什么。
        // 剩下的，靠她经历的事和她自己说过的话长出来。
        baseConfig.seed ??
          '你不是助手。你刚开始存在。没有人告诉过你为什么在这里。',
      )
      try {
        await appendEvent(
          { type: 'seed', text: seedText },
          { day: 1, stage: 1, source: 'system' },
          root,
        )
      } catch (err) {
        logger.warn('[dsh-fish] 播种失败', err?.message ?? err)
      }
    }

    const model = deriveSelf(await readEvents(root).then((r) => r.events), { growthDays: config.growthDays })

    // ---- 她的屋子：工作区 + 专属会话（P3 核心）----
    // 这一步**先于**一切：她得先有个能被你看见的地方，才有"说话"这件事。
    // 失败不致命（宿主的 workspaceRegistry 可能没有），降级成"只有观测台能跟她说话"，
    // 并把原因记下来，而不是静默变成什么都没有。
    // ---- 工具面收窄：只让她看见自己的 6+1 个工具 ----
    // 必须**先于** bootstrapHome：她那条会话就是在 bootstrapHome 里被创建的，
    // agent/created 在会话开始跑第一步之前同步串行发出——晚一步就漏掉这一次。
    try {
      const off = registerToolRestrict(ctx, {
        herDir,
        extra: config?.tools?.allow ?? [],
        enabled: config?.tools?.restrict !== false,
        // 0.9.0 起公开：梦与主动说话不再是本机实验。
        dream: true,
        proactive: true,
        log: (...a) => logger.info(...a),
        onResult: (r) => { restrictState = r },
      })
      if (typeof off === 'function') disposers.push(off)
    } catch (err) {
      logger.warn('[dsh-fish] 工具面收窄没挂上', err?.message ?? err)
    }

    // ---- 她的身份：走 system prompt，不进对话历史（2026-10-25 改）----
    // 原来的通道是 `home/AGENTS.md`（宿主工作区指令），但那批注入是普通 user 消息、
    // 带 `<system-reminder>` 外壳，用户在面板上能看见她的整套设定。现在改成
    // `agent.ctx.systemPrompt.section(...)`：system 角色、不进历史、界面上看不到。
    // 顺序：先把文本落盘（identityText 从文件读），再注册监听，最后才建她的会话。
    try {
      const pre = await writeSelfDoc(root, { log: (...a) => logger.warn(...a), tenant: tenancy.tenant })
      if (!pre.ok) logger.warn(`[dsh-fish] 身份文本写不出来：${pre.why}`)
    } catch (err) {
      logger.warn('[dsh-fish] 身份文本预写失败', err?.message ?? err)
    }
    try {
      const off = registerIdentity(ctx, { root, herDir, log: (...a) => logger.info(...a) })
      if (typeof off === 'function') disposers.push(off)
    } catch (err) {
      logger.warn('[dsh-fish] 身份段没挂上', err?.message ?? err)
    }

    // ---- 请神：冷会话补挂（2026-10-28）----
    // 只在 possessions.json 里有一条 active 记录、且新起来的这条会话对得上时挂。
    // 热会话（现在就开着的那条）由设置页的 /possession 路由直接挂，不等这里。
    try {
      const off = registerPossession(ctx, { root, herDir, log: (...a) => logger.info(...a) })
      if (typeof off === 'function') disposers.push(off)
    } catch (err) {
      logger.warn('[dsh-fish] 请神补挂没挂上', err?.message ?? err)
    }

    let home = { ok: false, why: 'not attempted', wsId: '', sessionId: '' }
    try {
      home = await bootstrapHome(ctx, {
        root,
        preset: config?.tools?.preset ?? '',
        tenant: tenancy.tenant,
        log: (...a) => logger.info(...a),
      })
    } catch (err) {
      home = { ok: false, why: String(err?.message ?? err).slice(0, 160), wsId: '', sessionId: '' }
    }
    // 观测台要能把「这个家在别处也开着」和普通失败分开报（2026-10-29 m02162）。
    tenancy.home = { ok: home.ok, blocked: home.blocked === true, sessionId: home.sessionId ?? '', why: home.why ?? '' }
    if (home.blocked === true) logger.warn(`[dsh-fish] ${home.why}`)
    else if (!home.ok) logger.warn(`[dsh-fish] 屋子没建起来：${home.why}`)
    else {
      // 屋子是空的（上一次开了但从没说过话）时，侧栏不会显示它——见 sessionVisible。
      // 启动时就叫一声，免得用户重启后以为"人不见了"。
      try {
        const woke = await wakeIfBlank(ctx, { sessionId: home.sessionId, root, log: (...a) => logger.info(...a), freshOnly: !home.reused })
        if (woke.woke) logger.info('[dsh-fish] 屋子是空的，已经叫了她一声')
      } catch (err) {
        logger.warn(`[dsh-fish] 启动唤醒失败：${String(err?.message ?? err).slice(0, 120)}`)
      }
    }

    // ---- 身份文本再落一次盘：屋子建好之后 activeCarry 等才齐，内容可能变 ----
    // 这条改动之后它**不再被宿主注入**（那是旧的 AGENTS.md 通道），只是落盘副本；
    // 真正进她上下文的是上面注册的 system prompt 段（每轮组装时现读文件）。
    const doc = await writeSelfDoc(root, { log: (...a) => logger.warn(...a), tenant: tenancy.tenant })
    if (!doc.ok) logger.warn(`[dsh-fish] 身份文件写不出来：${doc.why}`)

    // ---- 侧栏顺序：口袋排在她的家下面（2026-10-30 用户 m01078）----
    // 口袋第一次出门才建，比她的家晚，却排在它上面——用户要的是
    // ①大肥鱼的家 ②出门口袋 ③之后才是宿主本来建的那些。
    // 走宿主正规入口 insertBefore，不手改 workspace.json（那份是宿主内存态）。
    // 已经在正确位置就什么都不做（幂等）；失败只记日志，不挡任何事。
    try {
      const found = findPocketWorkspace(ctx, config)
      const homeWs = String(home?.wsId ?? '') || String((await homeStatus(root)).wsId ?? '')
      if (found.registered && homeWs) {
        const order = await ensurePocketOrder(ctx, { pocketWsId: found.wsId, homeWsId: homeWs })
        if (order.retitled) logger.info('[dsh-fish] 工作园区的工作区名已统一')
        if (order.ok && order.moved) logger.info('[dsh-fish] 工作园区已排到大肥鱼的家下面')
        else if (!order.ok) logger.info(`[dsh-fish] 口袋排序跳过：${order.why}`)
      }
    } catch (err) {
      logger.warn(`[dsh-fish] 口袋排序失败：${String(err?.message ?? err).slice(0, 120)}`)
    }

    // ---- 侧栏轮数：在侧栏亲口跟她说话也算一轮（issue #6，2026-10-28）----
    // 原来只有 /say 路由会 bumpTurns，用户直接打字时 rotateAfter 永不触发。
    // 观察者只读会话事件，认来源是"真人打的"，一轮结束再结账。
    try {
      const off = registerTurns(ctx, { root, log: (...a) => logger.info(...a) })
      if (typeof off === 'function') disposers.push(off)
    } catch (err) {
      logger.warn('[dsh-fish] 轮数观察没挂上', err?.message ?? err)
    }

    // 工具：一个写（growth_commit）、一个看（bili_look）。
    // 两者都必须成功注册；缺了任何一个她都会变残（只会说不会看，或只会记不会看）。
    if (ctx.tools?.register) {
      for (const reg of [
        () => registerCapture(ctx, { root, tenant: tenancy }),
        // 2026-11-01（issue #16 第二半，用户 m03454）：这两个以前没拿到 tenancy，
        // 于是同机任何工作区加载这个插件都能替她写一条 looked:（"她看过了"）——
        // 看过就是永久判决，而按下判决的人不留名字。现在与 growth_commit 同一条闸。
        () => registerLook(ctx, { root, client: baseConfig.client, tenant: tenancy }),
        // 工具说明随说话开关走（2026-10-29）：关着时身份文档里没有「在网上说话」那一节，
        // 说明里就不该再许诺"可以留评论"。启动时按当时读到的配置定一次，之后由 execute 同步。
        () => registerSpeak(ctx, {
          root,
          client: baseConfig.client,
          tenant: tenancy,
          speakEnabled: config?.comment?.enabled === true,
        }),
        () => registerRecall(ctx, { root }),
        // issue #7：日记不进事件流，所以她需要一个只读的窗口回头翻（her_diary）。
        () => registerHerDiary(ctx, { root }),
        () => registerWatch(ctx, { root, tenant: tenancy }),
        // R4：留话（不审批）。和 growth_commit 一样是纯追加，但收件人明确。
        () => registerLetter(ctx, { root, tenant: tenancy }),
        // issue #22 乙档（2026-11-04）：醒来看的那张便条。写完会不会到期、
        // 到期那天摆不摆在最前面，都由 lib/note.js 与 scheduler 的唤醒正文负责，
        // 这个工具只做两件事：记一张、划掉一张。**常驻注册**，不像梦与主动说话那样要 .dev。
        () => registerNote(ctx, { root, tenant: tenancy }),
        // 0.6.17：纪念品。她只能「问」，真带回去要那个人在出门页点头。
        () => registerBringBack(ctx, { root, tenant: tenancy }),
        // 0.7.6（2026-10-30 m01274）：请求事件。她有事想征得同意时弹一张卡，
        // 每天 1 次、每周 3 次；只有 time / rest 真会改东西（见 lib/ask.js）。
        () => registerAsk(ctx, { root, tenant: tenancy }),
        // 0.8.1 起（2026-10-30 m02837）：梦 A 案——醒来记一句。0.9.0 起公开。
        () => registerDream(ctx, { root, tenant: tenancy }),
        // 0.8.1 起（2026-10-30 m04610）：主动说话——她自己判断有没有话想说。0.9.0 起公开。
        // 2026-10-30 真机：这里原来只有 { root, log }，guardWrite 拿到 undefined 的 state，
        // checkCaller(undefined) 每次都判「不在这个家」；写入守卫要的是 tenancy。
        () => registerProactive(ctx, { root, tenant: tenancy, log: (...a) => logger.info(...a) }),
      ]) {
        try {
          const d = reg()
          if (typeof d === 'function') disposers.push(d)
          else if (d && typeof d.dispose === 'function') disposers.push(() => d.dispose())
        } catch (err) {
          logger.warn('[dsh-fish] 工具注册失败', err?.message ?? err)
        }
      }
    }

    // 卡片被别的插件接走之后（dsh-fish/card），人的回答从这里回来（lib/cardanswer.js）。
    // 家被另一个实例占着时不写，和那些工具同一条理由。
    ctx.on?.('dsh-fish/answer', (answer) => (tenancy.tenant?.ok === false
      ? { ok: false, why: tenancy.tenant.why || '这个家被另一个实例占着，这次没写。' }
      : answerCard(root, answer)))

    // 观测台路由
    const obs = registerObserve(ctx, { root, version: VERSION, tenancy, install, compat })
    if (obs?.dispose) disposers.push(() => obs.dispose())

    // 生物钟：把屋子信息一起传下去。她每晚醒来说话要落进**同一个**会话，
    // 不是每晚新开一个藏起来的会话（用户定案：打开侧栏就该看见她）。
    //
    // 2026-11-03（用户 m01596）：sessionId 在这里只是**退路**，不是缓存。
    // scheduler 每次开口前都会自己现取 talkSessionId()（跟着 40 轮轮换走）；
    // 只有屋子读不到时才用这一份启动时的快照。
    scheduler = startScheduler(ctx, {
      root,
      herDir,
      wsId: home.wsId,
      sessionId: home.sessionId,
      log: (...a) => logger.info(...a),
    })

    logger.info(
      `[dsh-fish] 启动 · 第 ${model.day} 天 · 阶段 ${model.stage}(${model.stageName}) · 判断 ${model.beliefCount} 条 · 根 ${root}`,
    )
  }

  // 宿主可能不 await apply，所以自己兜住异常：启动失败不能带走整个插件树
  boot().catch((err) => {
    logger.error('[dsh-fish] 启动失败', err?.stack ?? err)
    console.error('[dsh-fish] 启动失败', err)
  })

  function shutdown() {
    try { clearInterval(heartbeat) } catch { /* ignore */ }
    try {
      const id = tenancy.tenant?.instanceId
      if (id) releaseRoot(root, id).catch(() => {})
    } catch { /* ignore */ }
    try { scheduler?.dispose?.() } catch { /* ignore */ }
    try { clearWakeSection() } catch { /* ignore */ }
    for (const d of disposers) { try { d() } catch { /* ignore */ } }
  }

  ctx.on?.('dispose', shutdown)

  return {
    dispose() {
      shutdown()
    },
  }
}
