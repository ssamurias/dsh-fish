/**
 * video.js —— 让她真的「看过」一条视频，而不是只读了它的简介
 *
 * 之前她判断一条视频好不好，全靠标题/简介/标签/弹幕——那些是别人替她写的字。
 * 这个模块只做一件事：从视频里取 9 帧，拼成一张 3×3 的图，存成文件。
 * 之后 she 用 read_image 读它，等于一次看完整条视频的关键画面。
 *
 * 为什么不用 yt-dlp / 不下载整段：
 *   - B 站给了 dash 播放地址，ffmpeg 能直接从 http 拉流并 seek；
 *   - 抽 9 帧只要几次短 seek，合计几秒、几 MB，而不是把 40MB 全下下来；
 *   - 少一个依赖（yt-dlp）就少一处要用户装的东西。
 *
 * 为什么抽 9 帧、为什么不按镜头切换：
 *   跨整条视频找镜头切换要读完整个流（网络代价 = 全量下载）。
 *   9 帧是**覆盖优先**的折中：看得见"这条视频大致是什么样"，
 *   而不是"某一分钟里切了几个镜头"。
 *
 * 2026-11-01：从「等距九帧」改成「分段抖动」，并给 bili_watch 补了 at（用户 m02712）。
 *   等距的问题是：同一条视频每次取到的都是那同九张图，反复看等于看同一张拼图。
 *   抖动之后每段仍必有帧（覆盖不丢），但每次取到的时刻不同。
 *   她要细看某一刻，就用 at 点名要那一秒，不必再靠猜。
 *
 * 2026-10-30 改（GitHub issue #13「看画面在 workspace-write 下必然失败」）
 *   1. 帧与拼图**一律走 stdout 管道**，由插件自己 fs.writeFile。
 *      为什么：DSH 的文件策略会限制 ffmpeg 这类子进程往 ~/.dsh-fish 写文件
 *      （`[image2] Could not open file … Permission denied`，exit -13），
 *      而插件进程本身写得进去。以前把输出路径直接交给 ffmpeg，于是现象是
 *      「playurl 明明正常、就是一帧都取不到」，还被归因成「被风控」。
 *      改成管道后子进程只往 stdout 吐字节，一个写权限都不需要，
 *      连中间帧的临时目录也整个省掉了（拼图时把各帧 PNG 顺序拼起来喂 stdin）。
 *   2. 失败原因改成**真实的**：带 ffmpeg 退出码 + stderr 前两行，
 *      并 appends 到 media/ffmpeg.log（已脱敏），不再用「可能被风控」这种猜。
 *   3. `-headers` / `-ca_file` 只在 http(s) 输入时才加：它们是网络协议私有选项，
 *      对本地文件输入会直接 `Option headers not found.` 退出 1（2026-10-30 实测）。
 *      `caFile` 是**显式开启证书校验**时才需要的：ffmpeg 默认 `tls_verify=0` 根本不
 *      校验证书，光给 `-ca_file` 是空转（实测传个不存在的 CA 也照样出图）。所以
 *      给了 caFile 就成对加 `-tls_verify 1`，让 CA 真的起作用。
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { detectFfmpeg, mediaDir } from './media.js'
import { createClient } from './bili.js'
import { slashed } from './posix.js'
import { rootDir, readOwner } from './store.js'
import { scrub } from './log.js'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

// 一帧用掉多少秒的网络等待上限
const FRAME_TIMEOUT_MS = 25_000

// stdout 上限：帧是缩到 360px 宽的 PNG，正常一帧几十 KB；这个上限只防意外
const STDOUT_MAX_BYTES = 32 * 1024 * 1024
const STDERR_MAX = 4000

// PNG 魔数：管道输出**必须**校验，否则 ffmpeg 把报错写进 stdout 时会被当成图落盘
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function isHttp(url) {
  return /^https?:\/\//i.test(String(url ?? ''))
}

/**
 * 跑一次 ffmpeg，同时收 stdout 与 stderr。不抛。
 *
 * @param {string} bin
 * @param {string[]} args
 * @param {{timeoutMs?:number, stdin?:Buffer|null}} [o]
 * @returns {Promise<{code:number, stderr:string, stdout:Buffer}>}
 */
function runFfmpeg(bin, args, o = {}) {
  const timeoutMs = o.timeoutMs ?? FRAME_TIMEOUT_MS
  const stdin = o.stdin ?? null
  return new Promise((resolve) => {
    let err = ''
    let outLen = 0
    let overflow = false
    const chunks = []
    let done = false
    let timer = null

    const finish = (code) => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      // 输出超上限时退出码可能还是 0，但字节已经被扔了；用 -4 标出来，
      // 免得 describe() 说成「退出码 0」让人以为成功。
      resolve({ code: overflow ? -4 : code, stderr: err, stdout: Buffer.concat(chunks) })
    }

    let p
    try {
      // stdio[0]：喂管道时接 stdin，否则一律 ignore——ffmpeg 会读 stdin 等交互指令，
      // 在无终端环境下留着它可能把进程挂住。
      p = spawn(bin, args, {
        windowsHide: true,
        stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      })
    } catch (e) {
      resolve({ code: -2, stderr: String(e?.message ?? e), stdout: Buffer.alloc(0) })
      return
    }

    timer = setTimeout(() => {
      if (done) return
      try { p.kill('SIGKILL') } catch { /* ignore */ }
      err += '\n(timeout)'
      finish(-1)
    }, timeoutMs)

    p.stdout.on('data', (c) => {
      if (overflow) return
      outLen += c.length
      // 超上限时**整份丢掉**，不要留半截：截断的 PNG 可能魔数还对、看起来像张图，
      // 那比直接失败更难查。宁可报「输出太大」。
      if (outLen > STDOUT_MAX_BYTES) {
        overflow = true
        chunks.length = 0
        err += `\n(stdout 超过 ${STDOUT_MAX_BYTES} 字节，已丢弃)`
        return
      }
      chunks.push(c)
    })
    p.stderr.on('data', (c) => { if (err.length < STDERR_MAX) err += String(c) })
    p.on('error', (e) => { err += String(e?.message ?? e); finish(-2) })
    p.on('close', (code) => finish(code ?? -3))

    if (stdin) {
      // EPIPE：ffmpeg 提前退出时写 stdin 会报，不能让它变成未捕获异常
      p.stdin.on('error', () => { /* ignore */ })
      p.stdin.end(stdin)
    }
  })
}

/** stderr 前 n 行（去掉空行），用于把失败说清楚 */
function firstLines(s, n = 2) {
  return String(s ?? '')
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, n)
    .join(' / ')
}

/** 把一次 ffmpeg 运行说成人能看懂的一句（带退出码，这是以前最缺的东西） */
function describe(r, noImage = false) {
  // 过一遍 scrub：stderr 里可能带签名播放地址（有时还带 Cookie 参数），
  // 这句话既会进日志、也会被 watch.js 当作 note 直接交给模型，两处都不该有凭据。
  const why = scrub(firstLines(r?.stderr) || '没有 stderr 输出')
  if (r?.code === -1) return `超时（${why}）`
  if (r?.code === -2) return `启动失败：${why}`
  if (r?.code === -4) return `输出太大，已丢弃（${why}）`
  // 退出码 0 却没拿到图：ffmpeg 正常退出了，但吐的不是 PNG（或短得离谱）。
  // 这时说「退出码 0」会让人以为没问题，得单独说清楚。
  if (r?.code === 0 && noImage) return `ffmpeg 正常退出，但没吐出可用的图（${why}）`
  return `ffmpeg 退出码 ${r?.code}：${why}`
}

/** 从一次运行的 stdout 里取 PNG；不是 PNG 就返回 null（不拿报错当图） */
function pngOf(r) {
  if (!r || r.code !== 0) return null
  const buf = r.stdout
  if (!Buffer.isBuffer(buf) || buf.length <= 512) return null
  if (!buf.subarray(0, 8).equals(PNG_MAGIC)) return null
  return buf
}

/**
 * 把 ffmpeg 的失败细节落到 media/ffmpeg.log。
 * 为什么要单独一份：用户导出日志时常常只带 logs/，而这里放的是子进程原始输出；
 * 过 scrub 是因为 stderr 里可能出现带 token 的播放地址。
 */
async function appendFfmpegLog(root, text) {
  try {
    const dir = await mediaDir(root)
    await fs.appendFile(join(dir, 'ffmpeg.log'), `${new Date().toISOString()} ${scrub(text)}\n`, 'utf8')
  } catch { /* 日志写不进去不能连累主流程 */ }
}

/** B 站直链要 Referer + UA + cookie 才给拉；缺一样就是 403 */
function headersFor(bvid, cookie) {
  const lines = [
    `Referer: https://www.bilibili.com/video/${bvid}`,
    `User-Agent: ${UA}`,
    'Accept: */*',
  ]
  if (cookie) lines.push(`Cookie: ${cookie}`)
  return lines.join('\r\n') + '\r\n'
}

/**
 * 帧时刻：把可用区间切成 n 段，每段在中间 60% 里随机取一点。
 *
 * 中间 60% 是留边：不许贴段边界，否则相邻两帧可能挤到同一秒；
 * 也避免第一帧落回片头黑场、最后一帧落回片尾下滑栏。
 * 时刻严格递增，所以 seek 仍然只往前跑。
 *
 * @param {number} duration 秒；<=0 表示不知道时长
 * @param {number} n 要几帧
 * @param {() => number} [rand] 注入的随机源（单测用，默认 Math.random）
 */
export function sampleTimes(duration, n, rand = Math.random) {
  const count = Math.max(1, Math.min(16, Number(n ?? 9)))
  const times = []
  if (!(duration > 0)) {
    // 不知道时长就按固定间隔退回去：这时抖动没有分母可算
    for (let i = 0; i < count; i++) times.push(i * 5)
    return times
  }
  const lo = duration * 0.04
  const hi = duration * 0.96
  const span = Math.max(0, hi - lo)
  const seg = span / count
  for (let i = 0; i < count; i++) {
    const a = lo + seg * i + seg * 0.2
    const b = lo + seg * (i + 1) - seg * 0.2
    const v = Number(rand())
    const r = Number.isFinite(v) ? Math.max(0, Math.min(0.999, v)) : 0.5
    times.push(a + (b - a) * r)
  }
  return times
}

/**
 * 她点名的时刻：接受一个数或一个数组（秒），越界的夹回片内，乱写的丢掉。
 * 一条都不合法就返回空数组——调用方据此退回自动抖动，或者干脆告诉她看不懂。
 */
export function normalizeAt(at, duration = 0) {
  const raw = Array.isArray(at) ? at : at === undefined || at === null || at === '' ? [] : [at]
  const cap = duration > 0 ? Math.max(0, duration - 0.5) : Infinity
  const out = []
  for (const v of raw) {
    // null / '' / 布尔会被 Number() 悄悄变成 0——那不是她点名的时刻，是没写
    if (v === null || v === undefined || v === '' || typeof v === 'boolean') continue
    const t = Number(v)
    if (!Number.isFinite(t) || t < 0) continue
    out.push(Math.min(t, cap))
    if (out.length >= 16) break
  }
  // 递增，ffmpeg 就不用来回 seek
  return out.sort((x, y) => x - y)
}

/**
 * 抽帧 + 拼图。
 *
 * @param {object} o
 * @param {string} o.bvid
 * @param {object} [o.client] 注入的 bili 客户端（单测用假的）
 * @param {string} [o.root]
 * @param {number} [o.frames] 取几帧（默认 9 = 3×3）；只在没给 o.at 时用
 * @param {number|number[]} [o.at] 她点名的时刻（秒）；给了就只取这几个时刻
 * @param {{ok:boolean,bin:string}} [o.ffmpeg] 注入的 ffmpeg 探测结果（单测用假的）
 * @param {string} [o.caFile] 显式 CA 包路径；给了就同时开证书校验（-tls_verify 1），只在 http(s) 时生效
 * @returns {Promise<{ok:boolean, path:string, why:string, title:string, up:string, view:number, duration:number, shots:number}>}
 */
export async function grabFrames(o = {}) {
  const root = o.root ?? rootDir()
  const bvid = String(o.bvid ?? '').trim()
  const fail = (why, extra = {}) => ({ ok: false, path: '', why, title: '', up: '', view: 0, duration: 0, shots: 0, times: [], ...extra })

  if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) return fail('不是 BV 号')

  // 能找到二进制、但跑起来就失败，是另一类问题；这两种以前混在一起，只能靠猜。
  const caFile = String(o.caFile ?? process.env.DSH_FISH_CA_FILE ?? '').trim()

  // cookie 要在建客户端**之前**读：看画面是登录态才稳的（issue #5 里那台机器匿名 → 更容易被风控）。
  // 顺手把 2026-10-25 那个「readOwner 是 async 却在同步 IIFE 里调」的坑一并收干净：只读一次，两处共用。
  let cookie = ''
  try { cookie = (await readOwner(root))?.cookie ?? '' } catch { cookie = '' }

  const client = o.client ?? createClient({ cookie })
  let info
  try {
    info = await client.view(bvid)
  } catch (e) {
    return fail(String(e?.message ?? e))
  }
  if (!info?.ok) return fail(info?.message ?? '取不到这条视频的信息')

  const cid = info.data?.cid
  if (!cid) return fail('取不到分P信息（cid）')

  let pu
  try {
    pu = await client.playurl(bvid, cid)
  } catch (e) {
    return fail(String(e?.message ?? e))
  }
  if (!pu?.ok || !pu.data?.url) return fail(pu?.message ?? '拿不到播放地址（可能要登录或这条视频有地区限制）')

  // ffmpeg 探测放在网络检查**之后**：以前它在最前面，机器上没装 ffmpeg 时
  // 任何上游错误（412、要登录、视频没了）都会被「本机没有可用的 ffmpeg」盖掉，
  // 用户拿到的理由是错的（2026-10-30 CI 上 4 个 job 同时红，就是这么发现的：
  // runner 没有 ffmpeg，两条「上游怎么说就怎么说」的用例看到的是 ffmpeg 文案）。
  const ff = o.ffmpeg ?? detectFfmpeg()
  if (!ff.ok) return fail(`本机没有可用的 ffmpeg（${ff.why}）。装好后重试，或先只看文字。`)

  const url = pu.data.url
  const duration = Number(info.data?.duration ?? pu.data?.duration ?? 0) || 0
  const net = isHttp(url)

  // 网络私有选项只对网络输入有效。本地文件（单测喂 mp4）带上它们会直接报
  // 「Option headers not found.」退出 1 —— 2026-10-30 实测。
  const netArgs = []
  if (net) {
    netArgs.push('-headers', headersFor(bvid, cookie))
    // 给了 CA 才算「我要校验」：ffmpeg 默认 tls_verify=0，只传 -ca_file 而不开
    // 校验的话 CA 根本用不上（2026-10-30 实测：传一个不存在的 CA 文件也照样出图，
    // stderr 只有一句 Error while reading file.）。所以两者必须成对出现。
    if (caFile) netArgs.push('-tls_verify', '1', '-ca_file', caFile)
  }

  const dir = await mediaDir(root)
  const stamp = `${Date.now()}-${randomUUID().slice(0, 6)}`

  // 她点名要的时刻优先；没点名就分段抖动现抽（见 sampleTimes）。
  const atRaw = o.at === undefined || o.at === null || o.at === '' ? [] : (Array.isArray(o.at) ? o.at : [o.at])
  const asked = normalizeAt(o.at, duration)
  // 点了名却一条都看不懂：别悄悄退回随机，那样她以为看的是自己点的那一秒
  if (atRaw.length && !asked.length) return fail('给的时间点看不懂——要秒数，比如 90 或 [30, 90]。')
  const times = asked.length ? asked : sampleTimes(duration, o.frames)
  const n = times.length

  // 帧只在内存里过一手：不建临时目录、不落中间文件。
  // 这既是 issue #13 要的（子进程不写盘），也比它建议的更彻底（连插件自己都不用写临时帧）。
  const shots = []
  let firstFail = ''
  for (let i = 0; i < times.length; i++) {
    const grab = async (t) => runFfmpeg(ff.bin, [
      '-hide_banner', '-loglevel', 'error',
      '-nostdin',
      ...netArgs,
      '-ss', t.toFixed(2),
      '-i', url,
      '-frames:v', '1',
      '-vf', 'scale=360:-2',
      '-f', 'image2pipe', '-vcodec', 'png', '-',
    ])
    let r = await grab(times[i])
    let buf = pngOf(r)
    // 一次失败多半是那一下网络抖了或正好 seek 到关键帧边界；换一个时刻重试一次。
    // 不重试的话视频尾部几帧经常整片空着（实测 9 帧只成 7 帧）。
    // 往后挪 1.5 秒；但如果会越过片尾，就往前挪——否则夹到片尾同一个点上，
    // 等于把同一条命令再跑一遍，白等一次超时。
    if (!buf) {
      const last = duration > 0 ? Math.max(0, duration - 1) : Infinity
      let back = times[i] + 1.5
      if (back > last) back = Math.max(0, times[i] - 1.5)
      r = await grab(back)
      buf = pngOf(r)
    }
    if (buf) shots.push(buf)
    else if (!firstFail) firstFail = describe(r, true)
  }

  if (shots.length === 0) {
    const why = firstFail || 'ffmpeg 没有输出任何帧'
    await appendFfmpegLog(root, `grab ${bvid} failed: ${why}`)
    return fail(`一帧都没取到：${why}`)
  }

  // 3×3 拼成一张；不足 9 帧时 tile 会自动留空，可接受
  const cols = n <= 4 ? 2 : 3
  const rows = Math.ceil(n / cols)
  const sheet = join(dir, `sheet-${bvid}-${stamp}.png`)
  // 各帧 PNG 顺序拼起来喂 stdin，让 ffmpeg 从管道读——同样不需要写权限
  const tile = await runFfmpeg(ff.bin, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'image2pipe', '-i', '-',
    '-vf', `scale=360:-2,tile=${cols}x${rows}:padding=4:margin=4:color=white`,
    '-frames:v', '1',
    '-f', 'image2pipe', '-vcodec', 'png', '-',
  ], { timeoutMs: 60_000, stdin: Buffer.concat(shots) })

  const sheetBuf = pngOf(tile)
  if (!sheetBuf || sheetBuf.length < 1024) {
    const why = describe(tile, true)
    await appendFfmpegLog(root, `tile ${bvid} failed: ${why}`)
    return fail(`拼图失败：${why}`)
  }
  // 最后一步落盘由插件自己做（插件进程写得进 media/，子进程不一定）
  try {
    await fs.writeFile(sheet, sheetBuf)
  } catch (e) {
    const why = String(e?.message ?? e)
    await appendFfmpegLog(root, `write ${bvid} failed: ${why}`)
    return fail(`拼好的图存不下来：${why}`)
  }
  const st = await fs.stat(sheet).catch(() => null)
  if (!st || st.size < 1024) {
    return fail('拼好的图存下来是空的（磁盘写入后被截断？）')
  }

  return {
    ok: true,
    // 交给模型的路径用正斜杠（反斜杠写进 markdown 图片会显示成「无法预览」，2026-10-26 实测）
    path: slashed(sheet),
    why: '',
    title: String(info.data?.title ?? ''),
    up: String(info.data?.up ?? ''),
    view: Number(info.data?.view) || 0,
    duration,
    shots: shots.length,
    // 实际取到的是哪几秒：她要核对「我看的是不是我想看的那一段」
    times: times.map((t) => Math.round(t * 10) / 10),
  }
}
