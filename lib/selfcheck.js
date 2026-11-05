/**
 * 环境自检 —— 回答一个很具体的问题：**它现在到底能不能工作。**
 *
 * 为什么需要（2026-10-23 用户提）：
 * 插件零依赖（只用 Node 内置模块，`package.json` 里没有 dependencies），
 * 所以不存在"一键安装依赖"这件事；真正会失败的是别的：状态库写不进去、
 * cookie 过期、宿主没给 sessionController、B 站风控、网络不通。
 * 这些失败以前都只写进日志，用户在界面上看到的却是"她今天什么都没说"。
 *
 * 每条检查都给三样东西：成没成、看到了什么、不成时怎么办。
 * 只读：除了状态目录里一个临时文件，不改任何东西。
 */

import { promises as fs, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { readConfig, readEvents, readOwner } from './store.js'
import { inWindow, dateKey } from './settings.js'
import { detectFfmpeg } from './media.js'
import { FISH_TOOLS, HER_TOOLS, blockedTools } from './restrict.js'

const MIN_NODE_MAJOR = 18

/**
 * 同机还跑过别的 B 站 / 养成插件吗。
 *
 * 为什么用「家目录里的状态库」当判据，而不是读 DSH 的插件清单：
 * 插件清单在 profile 里，插件自己拿不到那个路径（`import.meta.url` 通过
 * link: 安装时指回源码目录）；而**每个插件都会在自己的状态库留脚印**，
 * 这是路径稳定、零副作用、不需要宿主 API 的信号。
 *
 * 只认被读，不做任何事。看到别的插件不等于要拦——但两套同时在跑，
 * 请求会叠加（同一个 IP，可能还是同一个账号），B 站更容易判风控。
 */
export function peersOnMachine(home = homedir()) {
  try {
    return readdirSync(home, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\.dsh-(bili|fish)/.test(d.name) && !/^\.dsh-fish($|-)/.test(d.name))
      .map((d) => d.name)
  } catch {
    return []
  }
}

async function checkStateDir(root) {
  const probe = join(root, `.selfcheck-${process.pid}`)
  try {
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(probe, 'ok', 'utf8')
    await fs.unlink(probe).catch(() => {})
    return { ok: true, detail: root }
  } catch (err) {
    return {
      ok: false,
      detail: String(err?.message ?? err),
      fix: '确认这个目录可写；如果被安全软件拦住，给它加白名单，或者换一个 DSH_FISH_HOME。',
    }
  }
}

/**
 * @param {{root:string, config?:object, host?:object, client?:object, net?:boolean, now?:Date}} o
 * @returns {Promise<{ok:boolean, checkedAt:string, items:Array}>}
 */
export async function runChecks(o = {}) {
  const root = String(o.root ?? '')
  const now = o.now ?? new Date()
  const items = []
  const push = (id, label, r) => items.push({ id, label, ok: r.ok === true, detail: String(r.detail ?? ''), fix: String(r.fix ?? '') })

  // 1. Node 版本
  const major = Number(String(process.versions?.node ?? '0').split('.')[0]) || 0
  push('node', '运行环境', major >= MIN_NODE_MAJOR
    ? { ok: true, detail: `Node ${process.versions.node}` }
    : { ok: false, detail: `Node ${process.versions.node} 太旧`, fix: `需要 Node ${MIN_NODE_MAJOR} 或更新；升级 DSH 一般会一起升。` })

  // 2. 状态目录可写
  push('state-dir', '状态库可写', await checkStateDir(root))

  // 2b. ffmpeg（只有"看画面"需要它）
  // 规矩：**只探测，不安装**。本机已有的直接用；没有就如实报红并给出装法，
  // 不往插件包里塞几十 MB 的二进制（要跟平台分发，还要处理杀软误报）。
  // 插件本体是零依赖的，ffmpeg 是唯一的外部工具。
  {
    const ff = detectFfmpeg()
    push('ffmpeg', '看画面用的 ffmpeg', ff.ok
      ? { ok: true, detail: `${ff.bin}${ff.version ? ` · ${ff.version}` : ''}` }
      : {
        ok: false,
        detail: ff.why,
        fix: '要让她看视频画面才需要它。装法二选一：① winget install Gyan.FFmpeg ② 下载 https://www.gyan.dev/ffmpeg/builds/ 解压后把 bin 目录加进 PATH。装完重启 DSH。不想装也行——把「看画面」关掉，她照样能读文字。',
      })
  }

  // 3. 配置能读
  let cfg = o.config
  try {
    if (!cfg) {
      const r = readConfig(root)
      cfg = r.config
      if (r.broken) {
        push('config', '配置文件', { ok: false, detail: '配置文件坏了，已备份并回到默认', fix: '去设置页点一次保存，会把当前显示的值重新写回去。' })
      } else {
        push('config', '配置文件', { ok: true, detail: `成长 ${cfg?.growthDays ?? '?'} 天 · 每天最多醒 ${cfg?.wakesPerDay ?? '?'} 次` })
      }
    } else {
      push('config', '配置文件', { ok: true, detail: '已在内存中' })
    }
  } catch (err) {
    push('config', '配置文件', { ok: false, detail: String(err?.message ?? err), fix: '删掉 config.json 会回到默认值（不会动她的经历）。' })
  }

  // 4. 事件流
  try {
    const { events, skipped } = await readEvents(root)
    const bad = Number(skipped) || 0
    push('events', '她的经历', bad
      ? { ok: false, detail: `${events.length} 条，有 ${bad} 条坏行被跳过`, fix: '坏行不影响她继续，但可以备份 events.jsonl 后手动删掉那几行。' }
      : { ok: true, detail: `${events.length} 条` })
  } catch (err) {
    push('events', '她的经历', { ok: false, detail: String(err?.message ?? err), fix: '确认状态库目录存在且可读。' })
  }

  // 5. 宿主能力
  const host = o.host ?? {}
  const need = ['sessionController', 'webServer', 'connection']
  const missing = need.filter((k) => !host[k])
  push('host', '宿主接口', missing.length
    ? { ok: false, detail: `缺 ${missing.join(' / ')}`, fix: '这通常意味着插件没被宿主正常装载，重启 DSH；仍然缺就贴日志给我。' }
    : { ok: true, detail: need.join(' / ') })

  // 6. 时段配置（她能不能按你说的点醒）
  try {
    const w = Array.isArray(cfg?.window) ? cfg.window : null
    if (w && w.length === 2) {
      const inside = inWindow({ window: w }, now)
      push('window', '醒来的时段', { ok: true, detail: `${w[0]}–${w[1]}（现在${inside ? '在里面' : '不在里面'}，今天 ${dateKey(now)}）` })
    } else {
      push('window', '醒来的时段', { ok: false, detail: '没有时段配置', fix: '去设置页把「每天几点醒」填上。' })
    }
  } catch (err) {
    push('window', '醒来的时段', { ok: false, detail: String(err?.message ?? err), fix: '把两个时间重新填一遍。' })
  }

  // 7. B 站登录（只看存没存，不在这里验登录）
  try {
    // 2026-10-25 修：readOwner 是 async，这一行原来漏了 await —— 拿到的是 Promise，
    // 于是「存过 cookie」永远判成「还没存」。用户确实保存成功、也登录上了，
    // 自检却一直报红。下面 net 那条也是同一类错误（见 8）。
    const ow = await readOwner(root)
    const has = Boolean(ow?.cookie)
    const csrf = /(?:^|;\s*)bili_jct=/.test(String(ow?.cookie ?? ''))
    push('cookie', 'B 站登录', has
      ? (csrf
        ? { ok: true, detail: `已存${ow?.account?.name ? `（登录账号：${ow.account.name}）` : ''}` }
        : { ok: false, detail: '有 SESSDATA，但缺 bili_jct', fix: '重新粘一次完整 cookie；发评论必须有 bili_jct。' })
      : { ok: false, detail: '还没存', fix: '到设置页「B 站登录」粘一次 cookie——不粘就只能看，不能说。' })
  } catch (err) {
    push('cookie', 'B 站登录', { ok: false, detail: String(err?.message ?? err), fix: '重新粘一次 cookie。' })
  }

  // 8. 能不能连上 B 站（要真发一次请求；o.net === false 时跳过）
  if (o.net !== false && o.client) {
    try {
      // 2026-10-25 修：popular() 返回的是 { ok, code, message, data:[…] }，
      // 不是数组。原来用 Array.isArray(r) 判，永远为 false，于是不管通不通
      // 都报「有响应但没有内容」。现在按形状判，并把失败码原样说出来。
      const r = await o.client.popular(1)
      const n = Array.isArray(r?.data) ? r.data.length : 0
      if (r?.ok === false) {
        const code = String(r?.code ?? '?')
        push('net', '连着 B 站', {
          ok: false,
          detail: `请求被拒（${code}）${r?.message ? `：${r.message}` : ''}`,
          fix: code === '-352' || code === '-412' || code === '-509'
            ? '刚撞上风控，正在冷却，过一阵会自己恢复。'
            : '检查网络；如果浏览器能开 B 站而这里不行，可能是代理没走同一个出口。',
        })
      } else {
        push('net', '连着 B 站', n
          ? { ok: true, detail: `通了，拿到 ${n} 条` }
          : { ok: false, detail: '有响应但没有内容', fix: '多半是风控，过一会再试；频繁失败就把「每天刷几次」调低。' })
      }
    } catch (err) {
      const code = String(err?.code ?? err?.message ?? err)
      push('net', '连着 B 站', {
        ok: false,
        detail: code,
        fix: code === 'COOLDOWN'
          ? '刚撞上风控，正在冷却，过一阵会自己恢复。'
          : '检查网络；如果浏览器能开 B 站而这里不行，可能是代理没走同一个出口。',
      })
    }
  } else {
    push('net', '连着 B 站', { ok: true, detail: '跳过（没要求联网检查）' })
  }

  // 9. 同机还有别的 B 站插件吗（2026-10-24 加）
  // 用户问：装了别的大肥鱼/刷站插件，我们的设置会不会对那个生效？
  // 答：不会（状态库和 config.json 各归各的，cookie 也各存各的）。
  // 但两套同时在跑会叠加请求——同一个出口 IP，可能还是同一个账号，
  // B 站更容易判风控。这条只提醒，不拦。
  const peers = o.peers ?? peersOnMachine()
  push('peers', '同机的其他插件', peers.length
    ? {
      ok: true,
      detail: `还看到 ${peers.join(' / ')} 的状态库。设置不会互相串（各自的 config.json 与 cookie 分开存），但两套同时在跑会叠加对 B 站的请求，更容易撞风控。建议只留一套在跑。`,
    }
    : { ok: true, detail: '没看到别的' })

  // 10. 她手上能用什么（2026-10-24 加，同日改为以 tools.restrict 为准）
  // 用户问：已装插件/技能的工具会不会进她上下文？会不会莫名调工具？
  // 答：会。实测她那条会话里有 37 个工具，只有 6 个是我们给的。
  // agent preset 那条路走过三次都失败（会话首行写对了，首轮宿主又改回 standard，
  // 见 docs/B-技术契约.md §24），改用 agent.ctx.tools.restrict() 在 agent/created
  // 里只关她一个。这里报的是**真的挂上没有**，不是“注册了没有”。
  // 2026-10-25：这一项以前看的是**配置里的名单**，于是「工具全都没注册上」也报绿——
  // 用全新 profile 装 tarball 时正是这样：日志里 6 个工具注册失败，自检还说没问题。
  // 现在只要有真宿主，就按 registry 里**真的在不在**判断。
  const T = o.tools ?? null
  // 2026-10-30（0.8.1 发版前自查）：这里必须按「公开版真的注册了哪些」来查。
  // `her_dream` 只在 `.dev` 存在时才由 `lib/index.js` 注册（梦是本机实验功能，
  // 对外公开版不带）。可 `FISH_TOOLS` 是**白名单来源**，9 个名字里一直含它，
  // 于是公开版装完自检必然报红：「有 1 个工具没注册上：her_dream」——
  // 和 2026-10-28 那次 read_image 误报同一类错误（拿「名单」当「真装上」的反面，
  // 这次是拿「本机清单」当「公开版清单」）。判据与注册处同一份：`devModeSync`。
  // 0.9.0 起 her_dream 也恒注册，清单就是清单本身。
  const expected = FISH_TOOLS
  const notRegistered = T && typeof T.get === 'function' ? expected.filter((n) => !T.get(n)) : []
  // read_image 是宿主的工具，别人的机器上可能没有。
  // 2026-10-28：以前它只是跟在「手上的工具」后面一句附注，而且那一项还是绿的。
  // 结果用户那边「ffmpeg 装了、额度也没用完，就是看不到画面」只能靠人肉翻日志——
  // 日志里那句「宿主没给 read_image，她看不了图——不影响说话」写在绿行末尾，没人会注意。
  // 它其实是「看画面」的前提：抽帧她能抽，打不开图就等于白抽。所以单列一项。
  //
  // 2026-10-28 深夜修正（用户 m05885）：上面那个判据 `!T.get('read_image')` 是**必然误报**。
  // 宿主把 read_image 注册在 agent 平面（由 attachments 服务挂着；preset 的工具是祖先层贡献），
  // 全局工具表 `tools.get()` 里根本查不到它 —— 所以任何真机都会报「宿主没给 read_image」。
  // 反证：用户本机同一条会话里 read_image 取到了 1096x622 的 PNG，她还照着画面把内容讲了出来
  // （「画面是黑的底，白符号是实心的。橙色小人被夹在两个 −1 中间……」）。
  // 现在改成「有旁证就算有」，绝不再凭全局表缺席就去说她瞎：
  //   · 全局表里直接看到 → 有；
  //   · restrict 真的挂上了（applied > 0）且 allow 里有这个名字 → 有。
  //     restrict 遇到不存在的名字会抛错，所以这等于宿主亲口认过这个名字。
  //   · 都查不到 → 判不准，如实说判不准，不说她看不了图。
  const globalHasImage = !!(T && typeof T.get === 'function' && T.get('read_image'))
  const R = o.restrict ?? null
  const allowNames = Array.isArray(R?.allow) ? R.allow : []
  const want = allowNames.length > 0 ? allowNames.length : expected.length
  if (notRegistered.length > 0) {
    push('tools', '手上的工具', {
      ok: false,
      detail: `有 ${notRegistered.length} 个工具没注册上：${notRegistered.join(' / ')}。她现在说不出话、也记不下东西。`,
      fix: '把「运行日志导出」发给插件作者；日志里会有 unsupported JSON schema 之类的注册报错。不想导出就直接看 ~/.dsh-fish/logs/dsh-fish.log。',
    })
  } else if (o.restrictEnabled === false) {
    push('tools', '手上的工具', {
      ok: true,
      detail: `收窄是关掉的：她能看到宿主给的全部标准工具，加上我们给的 ${expected.length} 个。`,
      fix: '想要她干净一点，把「工具面收窄」打开。',
    })
  } else if (R?.failed) {
    push('tools', '手上的工具', {
      ok: false,
      detail: `收窄没挂上：${R.failed}`,
      fix: '把这条报错发给插件作者；同时她此刻能看到全部标准工具。',
    })
  } else if (Number(R?.applied) > 0) {
    push('tools', '手上的工具', {
      ok: true,
      detail: `已收窄：她那条会话只看得见 ${want} 个工具（${allowNames.join(' / ')}）。`,
    })
  } else {
    push('tools', '手上的工具', {
      ok: true,
      detail: '已注册，等她的会话下一次启动就生效（现在这条是她之前开的）。',
    })
  }

  // 「看画面」单列一项（2026-10-28）。
  // 只在真有宿主工具表的时候才判——没有 tools 说明是假环境（测试/预检），不冒充结论。
  //
  // 判据的顺序（都是「有正面证据才下结论」）：
  //   1. 全局表里看到 read_image            → 有（green）
  //   2. restrict 真挂上了且 allow 含它      → 有（green，宿主认过这个名字，不存在会抛错）
  //   3. 宿主没有 attachments 服务           → 一定没有（red，这是宿主原文的前提：
  //      "read_image registers only while a durable ctx.attachments service is mounted"）
  //   4. 都没有                              → 判不准（green，写清楚「让她看一次就知道」）
  // 第 4 条刻意不报红：全局表里查不到**不能**证明她没有（用户 m05885 真机上
  // read_image 明明好用，却被旧判据冤枉成「看不了图」）。
  if (T && typeof T.get === 'function') {
    const restrictProved = Number(R?.applied) > 0 && allowNames.includes('read_image')
    if (globalHasImage || restrictProved) {
      push('read-image', '看画面', {
        ok: true,
        detail: globalHasImage
          ? '宿主给了 read_image，她能打开自己抽出来的帧（模型本身也得支持图像输入，否则还是会被拒）。'
          : '宿主认了 read_image：她能打开自己抽出来的帧（模型本身也得支持图像输入，否则还是会被拒）。',
      })
    } else if (o.attachments === false) {
      push('read-image', '看画面', {
        ok: false,
        detail: '宿主没挂附件服务，read_image 注册不上：她能抽到视频帧，但打不开那张图。装不装 ffmpeg 都一样。',
        fix: '① 给这个 profile 装上带图片能力的插件（官方附件/图片那类），让宿主把 attachments 与 read_image 注出来；② 或者换一个声明了图像输入的模型再用；③ 弄好后重启 DSH，这一项就不再是红的。',
      })
    } else {
      push('read-image', '看画面', {
        ok: true,
        detail: '查不准（宿主把 read_image 挂在会话那一层，这里看不见）。让她看一次画面就知道：能把画面内容讲出来，就是好的。',
      })
    }
  }

  // 「被挡住的调用」单列一项（2026-11-04，issue #20）。
  // 以前她被拦下时只写一行日志：用户看到的是她答「这件事我做不到」，然后没有任何线索——
  // issue 里那位翻了四小时日志才查出来是白名单少了一个名字。
  // 只在**确实拦过东西**时才出这一项：没拦过就不摆一条绿条占地方。
  const blockedNow = blockedTools()
  if (blockedNow.length) {
    const names = blockedNow.map((b) => b.name)
    const worst = blockedNow[0]
    push('tools-blocked', '被白名单挡住的调用', {
      ok: false,
      detail: `${names.length} 个工具被她伸手够过、但不在白名单里：${names.slice(0, 6).join(' / ')}${names.length > 6 ? ` 等 ${names.length} 个` : ''}。最常见的是 ${worst.name}（${worst.count} 次）。这几次她答的是「这件事我做不到」——不是坏了，是白名单没放行。`,
      fix: '设置 → 鱼 →「手上能用什么」里点一下这些名字加进白名单，按保存、重启 DSH 就放开。不想让她用就留着——她本来也不该碰到它们。',
    })
  }

  const bad = items.filter((x) => !x.ok)
  return {
    ok: bad.length === 0,
    checkedAt: now.toISOString(),
    items,
    summary: bad.length
      ? `${bad.length} 项要注意：${bad.map((x) => x.label).join('、')}`
      : '全部正常',
  }
}
