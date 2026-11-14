/**
 * settings.js —— 唯一配置入口
 *
 * 设计要点（对应用户 m00497 的要求）：
 *   1. **可扩展**：DEFAULTS 是唯一默认值的来源，读配置时按 DEFAULTS 递归补全。
 *      以后想加新项，只在这里加一个键 + 在 settings.html 加一行，不用改别处。
 *   2. **她不认识这个文件的位置**：配置在 ~/.dsh-fish，不在她的 cwd，也没写进她的提示。
 *   3. **错误不静默**：配置坏了不覆盖，改名备份后用默认值，并在 status 里报出来。
 */

import { readConfig, writeConfig, paths, readJson, mutateJson, readEvents, appendEvent } from './store.js'
import { deriveSelf } from './derive.js'
import { normalizePronoun } from './pronoun.js'
// 请求节奏是 bili 客户端的模块级状态，由配置驱动（issue #5）。
// 这里有 settings → bili 的单向依赖，bili.js 不反过来引 settings，不会成环。
import { setPacing } from './bili.js'
import { normTargets } from './cloudtargets.js'

/**
 * 换会话时最多能带几轮原话。
 *
 * 上限放在这里，是为了让「设置页能调多大」和「talk-recent.json 存多少」永远
 * 是同一个数：调大设置立刻生效，不需要等下一次写入才开始攒。
 * 20 轮 × 每轮两条各 160 字 ≈ 6400 字，已经比身份段本身还长；再往上加，
 * 换会话后的头几轮会明显变贵，而真正久远的事本来就该用 her_recall 去翻。
 */
export const CARRY_MAX = 20
/** 所有可调项。加新项就在这里加，下面读配置会自动补全。 */
export const DEFAULTS = {
  // 成长
  growthDays: 30,          // 7–180
  wakesPerDay: 1,          // 0–4：每天最多主动醒来几次（0 = 只在你找她时才在）
  window: ['20:00', '23:00'],  // 醒来的时间段

  // 主人的代词（0.9.9，issue #127）：他 / 她 / TA。
  // 只换「给她看的文本」里指主人的那个字，不是她的性格开关；不写 = 他。
  owner: { pronoun: '他' },

  // 每日事件配额（用户 m00497 要的自定义项）
  // 注意：原来还有 daily.proactive，与 wakesPerDay 语义重复且调度器根本不读它，
  // 属于"两个旋钮管一件事"，已删除。**唤醒次数只认 wakesPerDay**。
  daily: {
    // 2026-10-25：原来配额是"写得有、数不到"（见 scheduler todayCounts 的修复），
    // 修好之后 1 条/天会让 18 张卡里的大多数一辈子轮不上，默认放到 2。
    events: 2,          // 每天最多推几条成长事件
    questions: 1,       // 其中"她向你提问"最多几条 —— 防退化成问答机器
  },

  // 日记
  diary: {
    enabled: true,          // 她每天写不写日记
    visible: false,         // **默认不给看**：用户 m00497 明确要一个开关决定
    keepDays: 0,            // 0 = 永久保留
  },

  // 冷落：他多少天不出现才算"冷落"
  absenceAfterDays: 2,      // 1–30

  // 她的工具面（2026-10-24 用户批准）
  // 为什么限制：别的插件 / skill 一装上，就会把自己的工具定义塞进她的上下文。
  // 她会莫名其妙多出一堆「能做什么」，然后真的去做。**保持原生成长状态**是目的。
  //
  // ⚠️ 现状（2026-10-24 实测）：宿主按会话收窄工具要靠 agent preset。我们在
  // profile patch 里声明了 `fish-home`（行能激活、create 也接受 agentPreset），
  // 但首轮马上把会话的 preset 改回 `standard`——`presets.resolve('fish-home')`
  // 回落到默认值，工具面仍然是全量 37 个。所以这里**默认关闭**（空字符串），
  // 不写一个假装生效的名字。等宿主那侧打通再把默认值改回来。
  //   preset  ：她那条会话用的 agent preset（宿主支持时生效；现在留空）
  //   restrict：工具面收窄开关（2026-10-24 起用 agent.ctx.tools.restrict()，
  //             agent/created 里只关她一个 agent，不碰全局、不影响你自己的窗口）
  //   allow   ：额外放行的宿主工具名（白名单；空 = 只给她自己的那 7 个）
  tools: {
    preset: '',
    restrict: true,
    allow: [],
  },

  // 她主动说话（2026-10-30，用户 m04610；本机实验，只在 .dev 下生效）
  // 频率是上限不是行为要求：到上限就闭嘴，没到也不保证一定开口。
  // 到点不一定开口；这里只剩频次与冷却（概率那套已按 issue #67 删除）。
  proactive: {
    enabled: false,       // 默认关；功能公开可见，但不替用户打开
    maxPerDay: 2,         // 一天最多开几次空手回合
    minIdleHours: 6,      // 距上一次记录不足这么久就不打扰
    cooldownHours: 4,     // 两次之间至少隔多久
    // 下面三项给「对话要靠工具才发得出去」的部署（比如宿主里另有插件把多个聊天接进这条会话，
    // 再给她一个发送工具）。默认值和原来的行为一样。
    sendTools: [],      // 这些工具调成功才算她开了口；空 = 只认正文
    foldSilent: true,     // 没开口的一轮折成一行；一条会话用很久、上下文很大时可以关
    idleCountsSeen: false, // 「他来过」（seen:）也算打断安静；她的对话不进事件流时要开
    // 主动做事（2026-11-14，用户 m01237）：只在主动回合里多一个「做一件」的出口。
    // 默认关；消耗类另有日限/同件冷却/连续同类歇一周，规则真身在 lib/doing.js。
    allowDoing: false,
    consumePerDay: 1,
    itemCooldownDays: 3,
    bingeLimit: 3,
    bingeRestDays: 7,
    // 外部工具的分类（2026-11-14，用户 m01618）：工具名 → produce|consume|effect|self。
    // 没标的按 effect：不拦，也不自动当消耗类摆上桌。分类真身在 lib/doing.js。
    toolClasses: {},
  },

  // 她"不想看"的东西（可追加，用户说以后还会加）
  avoid: {
    keywords: ['恐怖', '血腥', '鬼畜', '政治'],
    upMids: [],             // 屏蔽的 UP 主 mid
    minDuration: 60,        // 秒，太短的不看
  },

  // 刷站（P2）
  // 注意：这里**没有任何一项是"她喜欢什么"**。这些全是环境参数——
  // 她看什么、信不信、想不想写，是她自己的事，不是旋钮。
  browse: {
    // 2026-11-07（用户 m00365）：恢复自动刷，但换了挂法——它不再挂在「醒来」上，
    // 而是自己按时间段走一趟（见 lib/scheduler.js 的 quietBrowse）：
    // 只取、只记账，不叫醒、不往这一轮的正文里塞十几条简介热评。
    // 下一次醒来只带一行「今天你自己翻过 N 条（标题…）」，要看细节她自己调 bili_look。
    // 关掉这一项 = 不再自动替她逛；她想看的时候仍然可以自己调工具（那由 bili.enabled 管）。
    enabled: true,
    perDay: 1,              // 每天最多刷几次（0 = 从不）
    topN: 4,                // 一次看几条
    // 阶段 1 每次轮换几个不同的分区排行（2026-10-27，用户 m00763：首批别只吃固定片单）
    rankingTids: 2,
    deepRead: 6,            // 每条深读几条热评
    danmaku: 6,             // 每条抽几条弹幕（0 = 不抽）
    keywords: [],           // 额外的搜索词（可追加；空 = 只看首页/排行）
    // 她什么时候能上网（2026-10-23 加，用户要求单独可调）
    // 和"什么时候醒来"是两件事：醒着不一定要上网，上网只在醒着时发生。
    // null = 跟着醒来时段走（issue #86 第 2 条，2026-11-09 用户拍板）。
    // 不另给一段默认值：她睡着的时候不该被安排出门、也不该攒着素材等她醒；
    // 醒来那一刻再现场去翻，翻到的直接进这一轮的上下文。
    window: null,
    // 评论区里别人的话（2026-10-24，用户 m02454）
    // 打开后每次浏览最多留 1 条评论给她读（跨视频重复 > 高赞短句 > 25% 随机）。
    // 关掉也能正常上网——只是她再也读不到别人的说法。
    voices: true,
  },

  // B 站请求节奏（issue #5，2026-10-28）
  // 为什么可配：机房/服务器 IP 与家宽的风控阈值完全不同。家宽 800ms 很安全，
  // 机房 IP 反而**越刷越快被盯上**——需要放慢；反过来在某些代理下又能更快。
  // 放在设置里比写死合理（写死就是让一部分人永远用不了）。
  // 注意：这是环境参数，不是"她性格"的一部分。
  bili: {
    // 2026-11-05（用户 m02562）：刷站不再由唤醒驱动，她自己的 bili_* 工具默认还能用；
    // 想彻底断网就把这一项设成 false。
    enabled: true,
    minIntervalMs: 800,     // 两次请求之间最少等多久
    jitterMs: 500,          // 在最小间隔上再随机多等 0–jitterMs（打散固定节奏）
    // 读字幕（2026-11-13，用户 m04422）：她能不能按句查某条视频说了什么。
    // 和上网总闸分开：有人愿意让她看标题和画面，不想让她读全篇台词——
    // 后者信息密度高得多，也更容易被带着走。默认开。
    // 关掉只是 bili_sub 用不了，已经记下的 subs 索引一条不删。
    sub: true,
  },

  // 她自己的三件事（2026-11-05，用户 m02634）：各自一个开关，默认全开。
  // 关掉只是「以后不再这么做」，已经发生的记录一条都不删。
  drive: { enabled: true },     // 主动性：攒够了才自己醒（lib/drive.js）
  interest: { enabled: true },  // 兴趣：摆到桌上的那几行（好奇/旧句子/回音/反复主题）
  dream: { enabled: true },     // 梦（lib/dream.js）

  // 看画面（2026-10-23 加）
  // 她看一条视频的**画面**：抽 9 帧拼成一张图，她 read_image 看。
  // 为什么单独一个开关而不跟 browse 绑死：抽帧要十秒、要 ffmpeg、占带宽，
  // 有人只想让她读文字。默认开，但每天只给 2 条——一条 9 帧 ≈ 一张图的时间，
  // 再多就变成"以看图为主"了，那不是她该有的生活。
  video: {
    enabled: true,
    perDay: 2,              // 每天最多看几条视频的画面（0 = 从不）
    frames: 9,              // 每条取几帧（9 = 3×3 拼图）
  },

  // 桌面提醒（P3-3）
  // **默认关闭**：用户讨厌被弹窗打断，这个开关必须由他自己打开。
  // 打开后也一天最多一次，且只在她真的开口之后弹（见 lib/notify.js）。
  notify: {
    enabled: false,
    lastShown: '',          // 内部用：上次弹通知的日期键，防一天多次
  },

  // 在 B 站说话（P4）
  // **默认关闭**。这是唯一会改动她账号上东西的功能：
  // 发评论留痕、别人能看见、删了也有通知。所以默认关，由用户自己打开。
  // 这些仍然是环境参数（能不能说、说几句、什么时候说），不是"她想说什么"。
  comment: {
    enabled: false,         // 总开关：不发任何评论
    perDay: 1,              // 每天最多发几条评论（0 = 不发）
    replyPerDay: 2,         // 每天最多回几条楼中楼
    replyToReplies: true,   // 有人回她时，允不允许她回一句
    scanEveryMin: 30,       // 多久去看一眼有没有人回她（分钟）
    window: ['20:00', '23:00'], // 只在这个时段说话（与她的作息分开，可单独调）
    atOwner: true,          // 发评论时在最前面 @ 主人（需要有昵称，见「主人在哪」）
    lastScanAt: '',         // 内部用：上次扫回复的时间戳
  },

  // 有人在 B 站 @ 她（2026-11-11，用户 m00767）
  //
  // 和 comment 组分开：那边是「她发出去的东西下面有人回」，这边是「别人主动
  // 在动态/视频评论区 @ 了她」。默认关——它要读消息中心，必须有有效登录。
  // 递过去的是素材，不是任务：回不回、看不看，由她自己判断。
  at: {
    enabled: false,        // 总开关：不去消息中心取 @
    scanEveryMin: 5,       // 多久去看一眼（分钟）；用户要的是 5–10 分钟内
    perDayMax: 20,         // 每天最多递几条；多的留到明天，不丢
    others: true,          // 非主人的 @ 也递（用户 m00816 选 B：只递，不替她回）
    ownerWake: true,       // 主人 @ 时当场叫醒一次（不占 wakesPerDay）
    lastScanAt: '',        // 内部用：上次扫 @ 的时间戳
    backoffUntil: '',      // 内部用：风控/网络失败后退避到什么时候
  },

  // 对话与会话（2026-10-23 加）
  // 一个侧栏会话聊到几百轮，上下文必然撑爆——不是"变慢"，是每轮为几十万字付费，
  // 最后直接失败。所以到点上换新会话，旧的改名留档（不删），原话搬几句过去。
  chat: {
    rotateAfter: 40,        // 聊满多少轮换新会话（0 = 永不换）
    // 换新会话时带几轮原话过去（2026-11-11，外部用户反馈）。
    //
    // 以前写死 4 轮：对「聊得稀但每一轮都很长」的人够用，对「一天聊几十句」
    // 的人，换窗口时只接得上最后四条，等于断在半句话上。这个数是给用户的
    // 一个旋钮：想接得长就往上调，不想让旧原话占上下文就往下调或写 0。
    // 单位是「轮」（一问一答算一轮），原文一句不改、不改写、不总结。
    carry: 4,               // 换会话时带过去几轮原话（0 = 不带）
    // 单轮回复字数预算（2026-10-25 加）。
    //
    // 为什么这条不算「人格设置」：它描述的是**这一轮产出的预算**，不是「她是什么样的人」。
    // 和 wakesPerDay（一天醒几次）、daily.events（一天经历几件事）同级，都是环境参数。
    // 写 0 就完全不提这件事——她的长短由她自己决定（默认就是这个）。
    //
    // 起因：如果某个用户就是想要她写长一点（也不在乎 token），原来没有任何入口：
    // 身份文档里既不许写「你话少」，也没有反向的「可以长」。
    // 有这个数，用户能明确「这一轮最多写多少」，而不必去改她的性格。
    replyChars: 0,          // 单轮最多写多少字（0 = 不限，提示词里不出现任何长度要求）
    // 「纠正鱼八股」（1.0，用户 m04784）：默认关。
    // 开了之后私聊时她会被要求尽量把话挂到具体一句上（他刚说的、她以前说的、她看过的）。
    // 这是**强行约束说话方式**，和「不硬性规定她怎么说」相冲突，所以默认关闭、文案必须写清。
    // 它不占「身份段字数」预算（material 由 anchor.js 在 assemble 之后追加）。
    anchor: false,
  },

  // 房间（2026-11-05，用户 m00304）
  // 群房按「建了多久」轮换，不按轮数：群和群的热度差几十倍，同一阈值要么小群
  // 永远换不了，要么热闹的群一天换三间。7 天是用户定的默认值；0 = 不轮换。
  // 这项只管插件建的群房/客访房，书房仍按 chat.rotateAfter 轮数换。
  rooms: {
    groupRotateDays: 7,     // 群房用满几天换新（0 = 不换）
  },

  // 记忆与上下文（2026-10-23 加）
  // docBudget 是她身份文档的字数上限：超了不是报错，是**按优先级丢可选段**
  // （四条黑名单与"你是谁"永远不丢）。她记得越多，文档越该只留最要紧的。
  memory: {
    docBudget: 2400,        // 身份文档字数预算（600–4000）；2026-10-25 从 1200 提到 1800；
                            // 2026-11-03 提到 2400：新增「这些天」与「上一个房间留的最后一句」两节之后，
                            // 1800 会挤掉「你被打脸过」（501 字），2000 也刚好差 268 字挤掉同一段。
                            // 实测四档：1800/2000 丢打脸，2200 反而丢「你对自己的说法」（更糟），
                            // 2400 一段不丢、余 167 字。数字不是品格，只是"别把已有的段挤掉"。
    sleepEveryDays: 7,      // 每几天让她"想一想"一次（0 = 不主动想）
    selfWake: true,         // 醒来时没派活、桌上也没东西时，她可以自己找点事做（空醒，0.9.0）
    sleepKeep: 12,          // 她总共留多少条自述（超出后最早的折进「更早以前」）
    beliefsShown: 3,        // 她一轮里逐条摆出来的判断数（1–8，默认 3）；其余折成一行
                            // 2026-10-25 用户问「想让她记住更多能不能调」——原来写死在
                            // persona.js 的 BELIEF_SHOWN，docBudget 调多大都不会多摆一条。
    hearEvery: 3,           // 每几轮把你说的一句话记成「旁听」（0 = 不记，1–50）
                            // 2026-10-30（用户 m00112 的 A2）：只存原话、不加工；
                            // 记的是"你曾经说过什么"，不是"你当时是什么意思"。
    // 0.9.7 T1：身份文档里摆不摆「你最近说过的几句话」。
    // 只收带锚点、没认领、21 天内、最多 1 条——不是把聊天复述进去。
    // 这是可选段：塞不下时整段丢，不挤核心段。归在 memory 组，
    // 不叫 persona——它管的是"摆什么给她自己看"，不是"她是什么样的人"。
    echo: true,
    // 2026-11-12（用户 m01648 / m01650）：原来这里有一个「每月多问一次」的开关。
    // 去掉了：现在月末那句收束是按本月真问过几次自动加的（`monthlyDue`），
    // 开关没有可控制的东西——少一个旋钮。
  },

  // 她自己说过的话（0.9.7 T1）
  // 规则与解禁（R3，2026-10-24）
  // 这里的开关约束的是**申请通道**，不是规则本身：
  // 关掉只是"最近别来跟我要东西"，已有的授权不会被撤销。
  rules: {
    offers: true,           // 允许她在某次醒来里提出「我想改一条规矩」
    holdDays: 3,            // 一张申请几天不处理 = 搁置（不算驳回、不加重冷却）
    cooldownDays: 3,        // 被驳回后至少隔几天才能再提
  },

  // 出门（2026-10-30，用户 m01904）：发布前加一道一次性确认。
  // 只记「说明卡看过一遍」，不是开关——看过的不用再看，没看过的按钮先挡着。
  outing: {
    ack: false,
  },

  // 观测台
  observe: {
    enabled: true,
    port: 0,                // 0 = 用宿主 webServer 的端口
  },

  // 自动备份（2026-11-14，用户 m00002）
  // 手动那颗「备份成一份文件」走浏览器下载，落在用户自己选的地方，插件不管；
  // 这一组管的是**插件自己定时存**：攒在数据文件夹的 backups/ 里，出事了不用等人想起来点按钮。
  // 为什么放在 backups/：backup.js 的 SKIP_DIRS 已经把它排除了，扣一份备份不会把旧备份再打进去；
  // 目录跟着数据文件夹走，用户「搬到别的盘」之后旧备份也跟着搬（不是留在 C 盘一个孤儿目录）。
  backup: {
    enabled: true,          // 默认开：这件事的价值就在「人不用记得」
    everyDays: 1,           // 每几天存一份（1–30）
    keep: 7,                // 留几份，多的从旧往新删（1–60）
    lastAt: '',             // 上一次成功的时刻（ISO 字符串）。判断「该不该备份」只看它和数据文件的时间
  },

  // 云端备份（2026-11-14，用户 m01090）
  // 本地那一份仍然照存（backups/ 里）；这一组管的是「再往远处放一份」。
  // 不给用户开服务器的机会：目标要么是他已经有的网盘目录 / 仓库 / 邮箱，
  // 要么是他自己能填的一条 HTTP 或一条命令。
  // 每加一个目标就多一个对象，形状见 normalizeCloudTarget()。
  cloud: {
    enabled: false,         // 默认关：不知道用户有没有云端、要不要传，不能替他决定
    everyDays: 1,           // 隔几天往云端推一次（1–30），跟着历史档的节奏
    keep: 3,                // 云端留几份（1–60）；云端空间比本地贵，默认比本地少
    encrypt: true,          // 默认加密。关掉要用户自己动手，并且界面上要说清后果
    passHint: '',           // 口令指纹（sha256 前 8 字节），只用来判断「还是不是上次那个口令」
    latestUp: false,        // 兜底那份（大肥鱼-自动-最新.json）要不要也上云。默认关，见下面注释
    lastAt: '',             // 上一次成功推上去的时刻（ISO）
    lastName: '',           // 上一次推上去的那份叫什么（同一份不重复推）
    targets: [],            // 目标列表
  },

  // 界面（2026-10-25 加）
  // 只放「这一版界面怎么显示」的偏好，与她的成长无关。
  ui: {
    ownerHintDismissed: false, // 用户手动关掉「B 站登录还没存」提示卡后记为 true
  },
}

const LIMITS = {
  growthDays: [7, 180],
  wakesPerDay: [0, 4],
  'daily.events': [0, 6],
  'daily.questions': [0, 6],
  'diary.keepDays': [0, 3650],
  absenceAfterDays: [1, 30],
  'browse.topN': [1, 20],
  'browse.deepRead': [0, 20], // issue #67：absorb 与接口本来都封顶 20，设置页别再说能到 40
  'browse.danmaku': [0, 30],
  'browse.perDay': [0, 4],
  'bili.minIntervalMs': [200, 120000],
  'bili.jitterMs': [0, 60000],
  'video.perDay': [0, 6],
  'video.frames': [4, 16],
  'avoid.minDuration': [0, 3600],
  'comment.perDay': [0, 5],
  'comment.replyPerDay': [0, 10],
  'comment.scanEveryMin': [5, 720],
  'at.scanEveryMin': [1, 60],
  'at.perDayMax': [0, 100],
  'chat.rotateAfter': [0, 500],
  'chat.carry': [0, CARRY_MAX],
  'chat.replyChars': [0, 2000],
  'rooms.groupRotateDays': [0, 365],
  'memory.docBudget': [600, 4000],
  'memory.sleepEveryDays': [0, 60],
  'memory.sleepKeep': [0, 100],
  'memory.beliefsShown': [1, 8],
  'memory.hearEvery': [0, 50],
  'rules.holdDays': [1, 30],
  'rules.cooldownDays': [1, 30],
  // issue #69 / PR #76：卡面一直是 1–24，后端却放到 0–240，写进 0 等于关掉「安静多久」
  'proactive.minIdleHours': [1, 24],
  // 自动备份（2026-11-14）：1 是最勤的档（一天一份）；0 不用留，关这件事走 enabled。
  'backup.everyDays': [1, 30],
  'backup.keep': [1, 60],
  // 云端备份（2026-11-14）：节奏跟本地历史档同量级，云端空间比本地金贵，上限收窄。
  'cloud.everyDays': [1, 30],
  'cloud.keep': [1, 60],
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

function getPath(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)
}

function setPath(obj, dotted, val) {
  const parts = dotted.split('.')
  const last = parts.pop()
  let cur = obj
  for (const p of parts) {
    if (typeof cur[p] !== 'object' || cur[p] === null || Array.isArray(cur[p])) cur[p] = {}
    cur = cur[p]
  }
  cur[last] = val
}

function clampNum(v, [lo, hi], dflt) {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.max(lo, Math.min(hi, n))
}

/**
 * 按 DEFAULTS 的形状补全（新增键自动出现，旧配置不会缺字段）。
 * 同时**保留 actual 里 DEFAULTS 没有的键**：用户自己往后加的自定义项不能因为
 * 插件版本没跟上就被吃掉（这是「配置可扩展」的底线）。
 */
function fillDefaults(defaults, actual) {
  if (Array.isArray(defaults)) {
    return Array.isArray(actual) ? actual.filter((x) => typeof x === 'string').map((s) => s.trim()).filter(Boolean) : [...defaults]
  }
  if (defaults && typeof defaults === 'object') {
    const out = {}
    const act = actual && typeof actual === 'object' && !Array.isArray(actual) ? actual : {}
    for (const [k, v] of Object.entries(defaults)) {
      out[k] = fillDefaults(v, act[k])
    }
    for (const [k, v] of Object.entries(act)) {
      if (!(k in out)) out[k] = v
    }
    return out
  }
  return actual === undefined || actual === null ? defaults : actual
}

/** 规范化 + 夹值。永远返回一个可用的完整配置。 */
export function normalizeConfig(raw = {}) {
  const cfg = fillDefaults(DEFAULTS, raw || {})

  for (const [key, range] of Object.entries(LIMITS)) {
    const cur = getPath(cfg, key)
    setPath(cfg, key, Math.round(clampNum(cur, range, getPath(DEFAULTS, key))))
  }

  // 时间窗：两个合法 HH:MM 且 起 != 止；跨零点（22:00–02:00）也允许
  cfg.window = validWindow(cfg.window, DEFAULTS.window)

  cfg.growthDays = Math.round(cfg.growthDays)
  // 主人的代词（0.9.9，issue #127）：只认 他 / 她 / TA，认不出来退回「他」。
  cfg.owner = { ...DEFAULTS.owner, ...(cfg.owner && typeof cfg.owner === 'object' && !Array.isArray(cfg.owner) ? cfg.owner : {}) }
  cfg.owner.pronoun = normalizePronoun(cfg.owner.pronoun)
  cfg.diary = { ...DEFAULTS.diary, ...cfg.diary }
  cfg.diary.visible = Boolean(cfg.diary.visible)
  cfg.diary.enabled = Boolean(cfg.diary.enabled)

  // 黑名单：去重、去空、保序（用户以后往数组里 push 就行，加一条不用改代码）
  cfg.avoid = { ...DEFAULTS.avoid, ...cfg.avoid }
  cfg.avoid.keywords = dedupe(cfg.avoid.keywords)
  cfg.avoid.upMids = dedupe(cfg.avoid.upMids)

  // 刷站：布尔严格化 + 关键词去重（同上，可追加）+ 上网时段自校验
  cfg.browse = { ...DEFAULTS.browse, ...cfg.browse }
  cfg.browse.enabled = Boolean(cfg.browse.enabled)
  cfg.browse.voices = cfg.browse.voices !== false
  cfg.browse.keywords = dedupe(cfg.browse.keywords)
  // 上网时段（issue #86 第 2 条）：null = 跟着醒来时段走（默认就是跟随）。
  // 存了一个坏值时也退成跟随——退到「自己的默认」会让她在睡着时被安排出门。
  cfg.browse.window = cfg.browse.window == null
    ? null
    : validWindow(cfg.browse.window, cfg.window)
  // 和醒来时段一模一样等于跟随：只存一份，改了醒来时段它也会跟着动。
  if (Array.isArray(cfg.browse.window)
    && cfg.browse.window[0] === cfg.window[0] && cfg.browse.window[1] === cfg.window[1]) {
    cfg.browse.window = null
  }

  // 请求节奏：夹值已由 LIMITS 做过，这里只保证是对象（老配置里没有这一组）
  cfg.bili = { ...DEFAULTS.bili, ...cfg.bili }
  // issue #62 / PR #72：上网总闸也严格化成布尔。没经过 normalize 的配置按「开」算，
  // 所以这里只把明确的 false 留下，其它值统一成 true。
  cfg.bili.enabled = cfg.bili.enabled !== false
  // 读字幕的开关：同样只把明确的 false 留下（老配置里没有这一项 = 开）。
  cfg.bili.sub = cfg.bili.sub !== false

  // 提醒：布尔严格化 + lastShown 只收字符串（它的值是日期键，不是数字）
  cfg.notify = { ...DEFAULTS.notify, ...cfg.notify }
  cfg.notify.enabled = Boolean(cfg.notify.enabled)
  cfg.notify.lastShown = String(cfg.notify.lastShown ?? '')

  // 说话（写操作）：布尔严格化 + 时段自校验（坏值回退到自己的默认，不跟着 window 变）
  cfg.comment = { ...DEFAULTS.comment, ...cfg.comment }
  cfg.comment.enabled = Boolean(cfg.comment.enabled)
  cfg.comment.replyToReplies = Boolean(cfg.comment.replyToReplies)
  cfg.comment.atOwner = cfg.comment.atOwner !== false
  cfg.comment.lastScanAt = String(cfg.comment.lastScanAt ?? '')
  {
    const cw = Array.isArray(cfg.comment.window) ? cfg.comment.window : DEFAULTS.comment.window
    cfg.comment.window = validWindow(cw, DEFAULTS.comment.window)
  }

  // 有人 @ 她（2026-11-11）：开关布尔严格化；两个内部时间戳只收字符串
  cfg.at = { ...DEFAULTS.at, ...cfg.at }
  cfg.at.enabled = Boolean(cfg.at.enabled)
  cfg.at.others = cfg.at.others !== false
  cfg.at.ownerWake = cfg.at.ownerWake !== false
  cfg.at.lastScanAt = String(cfg.at.lastScanAt ?? '')
  cfg.at.backoffUntil = String(cfg.at.backoffUntil ?? '')

  // 出门：只存一个布尔（老配置里没有这一组）
  cfg.outing = { ...DEFAULTS.outing, ...cfg.outing }
  cfg.outing.ack = Boolean(cfg.outing.ack)

  // 主动说话（0.8.1 本机实验）：布尔严格化 + 数值夹紧（夹紧规则真身在 proactive.js）
  cfg.proactive = { ...DEFAULTS.proactive, ...cfg.proactive }
  cfg.memory.selfWake = cfg.memory.selfWake !== false
  // 0.9.7 T1：回声开关。只认 true/false，缺省按开。写成字符串"false"也当开——
  // 这里不是解析用户意图的地方，界面只发布尔。
  cfg.memory.echo = cfg.memory.echo !== false
  cfg.drive = { enabled: cfg.drive?.enabled !== false }
  cfg.interest = { enabled: cfg.interest?.enabled !== false }
  cfg.dream = { enabled: cfg.dream?.enabled !== false }
  cfg.proactive.enabled = Boolean(cfg.proactive.enabled)

  // 她的工具面：preset 名 trim（空 = 用宿主默认组合），allow 去重去空
  // 不改 allow 的语义——它只是"额外放行"，真正的收窄由 preset 完成。
  cfg.tools = { ...DEFAULTS.tools, ...cfg.tools }
  cfg.tools.preset = String(cfg.tools.preset ?? '').trim()
  cfg.tools.restrict = cfg.tools.restrict !== false
  cfg.tools.allow = dedupe(cfg.tools.allow)

  // 对话与界面（2026-10-25）：replyChars 由 LIMITS 夹值，这里只补布尔严格化
  cfg.chat = { ...DEFAULTS.chat, ...cfg.chat }
  cfg.chat.anchor = cfg.chat.anchor === true
  cfg.rooms = { ...DEFAULTS.rooms, ...cfg.rooms }
  cfg.ui = { ...DEFAULTS.ui, ...cfg.ui }
  cfg.ui.ownerHintDismissed = Boolean(cfg.ui.ownerHintDismissed)

  // 自动备份（2026-11-14）：开关布尔严格化，everyDays / keep 已由 LIMITS 夹过，
  // lastAt 只收字符串（它的值是 ISO 时间，不是数字）。
  cfg.backup = { ...DEFAULTS.backup, ...cfg.backup }
  cfg.backup.enabled = cfg.backup.enabled !== false
  cfg.backup.lastAt = String(cfg.backup.lastAt ?? '')

  // 云端备份（2026-11-14）：目标是列表，形状的校验在 cloudtargets.js 里，
  // 这里只做「组级」的布尔/字符串规整——加一个字段不用回来改这里。
  // ⚠️ targets 必须直接从 raw 取：fillDefaults 对数组只认字符串（那是给 keywords 这类用的），
  // 对象数组会被它整个清空。踩过一次，配置里刚加的目标当场消失。
  const rawTargets = raw && typeof raw === 'object' && raw.cloud && typeof raw.cloud === 'object' ? raw.cloud.targets : undefined
  cfg.cloud = { ...DEFAULTS.cloud, ...cfg.cloud }
  cfg.cloud.enabled = cfg.cloud.enabled === true
  cfg.cloud.encrypt = cfg.cloud.encrypt !== false
  cfg.cloud.latestUp = cfg.cloud.latestUp === true
  cfg.cloud.passHint = String(cfg.cloud.passHint ?? '')
  cfg.cloud.lastAt = String(cfg.cloud.lastAt ?? '')
  cfg.cloud.lastName = String(cfg.cloud.lastName ?? '')
  cfg.cloud.targets = normTargets(rawTargets)

  return cfg
}

/**
 * 时段问题：返回 '' 表示可用，否则是一句给人看的原因。
 * 保存接口用它当场拒收；读取旧配置时 validWindow 仍会回退，不能因为一个坏字段打不开。
 */
export function windowProblem(w) {
  if (!Array.isArray(w) || w.length !== 2) return '时段要写成 [开始, 结束] 两个时间'
  const a = String(w[0] ?? '')
  const b = String(w[1] ?? '')
  if (!TIME_RE.test(a) || !TIME_RE.test(b)) return '时间要写成 HH:MM（比如 08:00）'
  if (a === b) return '开始和结束不能是同一时刻。要全天，请设 00:00–23:59。'
  return ''
}

/**
 * 时段校验：两个合法 HH:MM 且起止不同。
 * 坏值一律回退到**它自己的默认**，不跟着别的时段走
 * （否则把"醒来时间"改坏会顺手把"上网时间"也改掉）。
 */
function validWindow(w, fallback) {
  if (!windowProblem(w)) return [String(w[0]), String(w[1])]
  return [...fallback]
}

function dedupe(arr) {
  const seen = new Set()
  const out = []
  for (const x of Array.isArray(arr) ? arr : []) {
    const s = String(x ?? '').trim()
    if (!s || seen.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  return out
}

/**
 * 白名单输入 → 名字数组（纯函数）。
 * 分隔符与界面一致：半角/全角逗号、空格、换行都算，去重保序。
 */
export function parseToolNames(input) {
  // 数组也要再拆一次：界面偶尔会把「一项里带逗号」的东西整条提上来，
  // 拼错的名字就这样混过形状校验，最后整条收窄失效。
  const raw = (Array.isArray(input) ? input : [input]).flatMap((x) => String(x ?? '').split(/[,，\s]+/))
  const seen = new Set()
  const out = []
  for (const x of raw) {
    const s = String(x ?? '').trim()
    if (!s || seen.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  return out
}

/**
 * 白名单校验（纯函数）：拼错的字母、根本不存在的工具 → unknown，**不许保存**。
 *
 * 为什么必须挡（2026-10-24 查明）：宿主 `tools.restrict({ allow })` 遇到不认识的名字会
 * 抛错，整条收窄当场不生效——她会退回全量工具面。所以这里宁可不让存。
 *
 * `known` 传 null（拿不到名单）时只做形状校验，返回 checked:false，
 * 不把「不知道」当成「不存在」。
 */
export function validateToolNames(input, known) {
  const names = parseToolNames(input)
  const list = Array.isArray(known) ? known.map((x) => String(x)) : null
  const knownSet = list && list.length ? new Set(list) : null
  const unknown = []
  for (const n of names) {
    // 工具名一律小写 + 数字 + 下划线（宿主注册名就是这个形状）
    if (!/^[a-z][a-z0-9_-]*$/.test(n)) { unknown.push(n); continue }
    if (knownSet && !knownSet.has(n)) unknown.push(n)
  }
  return { ok: unknown.length === 0, names, unknown, checked: Boolean(knownSet) }
}

/**
 * 保存前的清洗（0.8.3，2026-10-31 issue #14 @ming-fish）：把「这台机器上确实没有」
 * 的名字丢掉，其余照常留下。
 *
 * 为什么不再整表拒绝：设置页的自动保存是**整表提交**，一个人手改过的 `config.json` 里
 * 只要留着一个早就没有的工具名，就会让整页所有设置都存不进去，而界面上的提示还指着
 * 「插件这一版还没接上它」——方向完全错了。他遇到的那个名字是裸的 `delete`。
 *
 * 丢弃不等于放过：丢掉的名字会随 `dropped` 原样回给界面，用户看得到自己少了什么，
 * 拼错的字母也不会悄悄生效。用户自己手输白名单的那条路（`saveTools`）仍然严格拦，
 * 因为那时候是**他刚敲进去的字**，该当场告诉他打错了。
 */
export function sanitizeToolNames(input, known) {
  const check = validateToolNames(input, known)
  const drop = new Set(check.unknown)
  const names = check.names.filter((n) => !drop.has(n))
  return { names, dropped: check.unknown, checked: check.checked }
}

/** 读配置（文件不存在时返回默认值，不写盘） */
export async function loadConfig(root) {
  const raw = await readConfig(root)
  let res
  if (raw === null) {
    res = { config: normalizeConfig({}), fresh: true, broken: false }
  } else {
    let broken = false
    try {
      res = { config: normalizeConfig(raw), fresh: false, broken }
    } catch {
      broken = true
      res = { config: normalizeConfig({}), fresh: false, broken }
    }
  }
  // 每次读配置都把节奏推给 bili 客户端：设置页保存后下一次请求就是新间隔，
  // 不用重启插件。失败也不能连累读配置本身。
  try {
    setPacing(res.config?.bili)
  } catch {
    /* 节奏挂了不影响读配置 */
  }
  return res
}

/** 合并式更新：只改你传的键，其余保持。传未知键会原样存下（向前兼容）。 */
export async function updateConfig(patch, root) {
  // 排队：设置页存一项、定时器同时记一个时间戳时，两边读到同一份旧配置，
  // 后写的会把先写的那一项改回去。
  return mutateJson(paths(root).config, async () => {
    const { config: cur } = await loadConfig(root)
    const merged = deepMerge(cur, patch && typeof patch === 'object' ? patch : {})
    const next = normalizeConfig(merged)
    // issue #128（C）：改成长周期会把阶段按新周期重算，可能比之前低。改之前把
    // 「当时的阶段」记成一条 meta，derive 的 `stagePeak` 只认这些记录——界面上那句
    // 「曾到第 N 阶段」才有出处，也不会被 0.9.8 写下的、没压门的偏高 stage 带偏。
    // 写失败不挡配置保存：少一句「曾到过」，总好过设置存不下去。
    if (Number(next.growthDays) !== Number(cur.growthDays)) {
      try {
        const { events } = await readEvents(root)
        const before = deriveSelf(events, { growthDays: cur.growthDays })
        await appendEvent(
          { type: 'meta', text: `stage-was:${before.stage}` },
          { day: before.day, stage: before.stage, source: 'system' },
          root,
        )
      } catch { /* 见上：这条只是留痕，不是保存的前置条件 */ }
    }
    await writeConfig(next, root)
    return next
  })
}

function deepMerge(base, patch) {
  const out = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v)
    } else if (v !== undefined) {
      out[k] = v
    }
  }
  return out
}

/**
 * 能不能上 B 站（issue #62）。
 *
 * 2026-11-05（用户 m02562）把 `bili.enabled` 定为「彻底断网」那一项；
 * 但 0.9.0 之后 look / watch / speak / 查回复 / 身份文档各认各的开关，
 * 关掉这一项只关得住 `bili_look`。从此所有真会连 B 站的路都过这一个判据：
 * 翻视频、看画面、发评论与回复、定时/手动查回复、身份文档的「上网」一节。
 *
 * 其它开关仍然有效，只是不再各管一块网：
 *   - `video.enabled` 管「要不要抽帧看画面」（在 biliOn 之后）；
 *   - `comment.enabled` 管「要不要在网上说话」（在 biliOn 之后）。
 * 默认（没有这个字段）当作开：老配置文件没有它时不该突然断网。
 * @param {object} cfg
 * @returns {boolean}
 */
export function biliOn(cfg) {
  return cfg?.bili?.enabled !== false
}

/** 当前是否落在今天的活跃时间窗内 */
export function inWindow(cfg, now = new Date()) {
  const [sh, sm] = cfg.window[0].split(':').map(Number)
  const [eh, em] = cfg.window[1].split(':').map(Number)
  const cur = now.getHours() * 60 + now.getMinutes()
  const start = sh * 60 + sm
  const end = eh * 60 + em
  return start <= end ? cur >= start && cur <= end : cur >= start || cur <= end
}

/** 今天的日期键（本地时区，YYYY-MM-DD） */
export function dateKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 醒来日：跨零点窗口的 00:00–结束 这一段，算**前一天**。
 * 12:00–02:00 的 01:30 仍属于前一天那次窗口，配额、落点、状态都按同一天算；
 * 否则午夜一过配额就翻新，两次都可能花在凌晨，白天反而不再醒。
 * 非跨零点窗口就是普通的 dateKey。
 */
export function wakeDayKey(config, d = new Date()) {
  const w = config?.window
  if (!Array.isArray(w) || w.length !== 2
    || !TIME_RE.test(String(w[0] ?? '')) || !TIME_RE.test(String(w[1] ?? ''))) {
    return dateKey(d)
  }
  const [sh, sm] = String(w[0]).split(':').map(Number)
  const [eh, em] = String(w[1]).split(':').map(Number)
  const start = sh * 60 + sm
  const end = eh * 60 + em
  const cur = d.getHours() * 60 + d.getMinutes()
  if (end <= start && cur <= end) {
    const y = new Date(d)
    y.setDate(y.getDate() - 1)
    return dateKey(y)
  }
  return dateKey(d)
}

/** 时间窗内随机一个落点（同一个 seed 稳定，便于测试） */
export function pickWakeTime(cfg, seed = Math.random()) {
  const [sh, sm] = cfg.window[0].split(':').map(Number)
  const [eh, em] = cfg.window[1].split(':').map(Number)
  const start = sh * 60 + sm
  let end = eh * 60 + em
  if (end <= start) end += 24 * 60
  const t = start + Math.floor(seed * (end - start))
  return ((t % 1440) + 1440) % 1440
}

export async function configFileInfo(root) {
  const p = paths(root)
  const raw = await readJson(p.config, null)
  return { path: p.config, exists: raw !== null, keys: raw ? Object.keys(raw) : [] }
}
