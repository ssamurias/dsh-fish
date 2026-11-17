/**
 * backup.js —— 把她整个装进一个文件，再整个放回去
 *
 * 用户要的不是「导出数据」这种半成品，而是**换台机器还能接着养**：
 * 事件流、配置、日记、她的房间、头像，全都要走。
 *
 * 三条设计约束：
 *   ① 单文件。一个 `.json`，双击能看、能发微信、能塞进网盘。不做 zip——
 *      不引依赖，也省掉「你解压到哪了」这类问题。
 *      凭据默认**不进包**（2026-11-16，用户 m00605）：`owner.json` 的 B 站 cookie、
 *      `config.json` 里云端目标的令牌 / 密码 / 请求头会被擦成空值。开关 `backup.withSecrets`
 *      只管自动备份与云端（用户 m00712）；手动「备份成一份文件」是当场按下的一次性动作，仍然是全量。
 *      设置页的备份卡要照实说。
 *   ② 恢复不是「覆盖」而是「先封存再放回」。现在的档一律改名搬到
 *      `dsh-fish-backups/pre-restore-<时间戳>/`（一个字节都不删），
 *      再把备份写进原位置。这样恢复错了还能再换回来。
 *   ③ 版本对不上要说人话。备份里带 `format` 与 `schema`：
 *      format 不是本版本认识的 → 直接拒；schema 比程序新 → 拒（旧程序读新事件会静默丢字段）；
 *      schema 比程序旧 → 放行，读的时候按旧版兼容（见 `store.readEvents`）。
 *
 * 不搬的东西：`logs/`（会话压力观测文件除外）、
 * `backups/`（备份里再套备份，体积会炸）。这两类列在 `excluded` 里，不静默丢；
 * 目录名在任何一层都认（她房间里叫 backups、node_modules 的文件夹也不带），
 * 所以设置页的导出回执要把顶层以外的那几个单独说出来。
 * 自动备份另外还会跳过 `out/covers/`（见 collectBackup 的 alsoSkip）：B 站封面缓存，
 * 实测占包体六成，丢了下次打开那条视频会重新下。手动备份仍按全量走，口径不变。
 * `skipped` 只放真没装进去的文件（超限、读不到），设置页要把它们一个个说出来。
 * 0.9.5 及以前的包把这两类也写进了 `skipped`（「…（不搬：logs）」），恢复时认得出来、不当成丢了。
 *
 * 包有多大（issue #65）：事件流不设上限、第一个进包；别的文件守两条线——原始字节合计
 * 不过 64MB，整份包按「从备份恢复」POST 回来的样子（JSON，二进制按 base64）不过恢复上限。
 * 后一条只看事件流（连同包的外壳，外壳按最长的写法算）装不装得下：装得下，整份包就装得下，
 * 被挑出去的是放不下的文件，不是整份包作废；装不下，只守 64MB，包至少还是一份完整的存档。
 * 挑的顺序看丢了能不能找回来（packRank）：顶层的 owner.json、config.json、头像、台账先，
 * 再是 diary/、home/、keepsakes/，再是别的子目录，state.json（能由事件流重算）和 .log 最后；
 * 同一档里小的先，不看 readdir 的顺序。没装进去的每个都在 skipped 里写一行；
 * 事件流顶到上限附近、连这些说明行都写不下时，写不下的只记个数（skippedUnlisted）。
 */

import { promises as fs } from 'node:fs'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { rootDir, writeAtomic } from './store.js'
import { EVENT_SCHEMA_VERSION } from './schema.js'

/** 备份文件里写的格式标记。改字段结构就换它。 */
export const BACKUP_FORMAT = 'dsh-fish-backup/1'
export const PRESSURE_OBSERVATIONS = 'logs/session-pressure/samples.json'

/** 不搬的目录（相对状态库根）。 */
const SKIP_DIRS = new Set(['logs', 'backups', 'dsh-fish-backups', 'node_modules'])

/**
 * 不搬的文件（只认状态库顶层）：说的是「哪个实例、哪个进程此刻正用着这个文件夹」，不是她的东西。
 *   instance.json       占用声明（tenant.js）。带进包再放回去，盘上就是导出那次运行的 instanceId，
 *                       正在跑的实例心跳对不上，会把自己当成被接管、从此只读。
 *   .talk-session.lock  建会话的那把锁（home.js）。导出时正好有人拿着的话，放回去就是一把没人会放的锁。
 *   .instance.lock      认领占用声明的那把锁（tenant.js 的 claimRoot），同上。
 *   cloud-key.txt       云端备份的加密口令（cloudcrypto.js）。**这一条尤其不能漏**：
 *                       口令若跟着备份走，拿到任何一份本地备份的人都能解开云端那几十份，
 *                       加密这件事当场归零。代价是换机器恢复要先重新填一次口令。
 * 老包里有它们：恢复时同样不放回（restoreBackup）。
 */
const SKIP_FILES = new Set(['instance.json', '.talk-session.lock', '.instance.lock', 'cloud-key.txt'])

/**
 * 备份里默认擦掉的凭据（2026-11-16，用户 m00605）。
 *
 * 备份是一个「双击能看、能发微信、能塞网盘」的单文件；它要能换机器接着养，
 * 但不该顺手把账号也交出去。擦的是两处（都在数据文件夹顶层）：
 *   owner.json   —— B 站整串 cookie（SESSDATA / bili_jct / buvid3 / DedeUserID / sid）。
 *                   这些键能直接发评论、看私信，而抽帧、看视频根本不需要它们。
 *   config.json  —— 云端备份目标里的密码类字段：git 令牌、WebDAV 应用密码、邮箱授权码，
 *                   以及自定义 HTTP 的请求头（那一格常常就是 `Authorization: Bearer …`）。
 * 昵称、领养人、房间、日记、事件流照旧带——那些才是「她还是她」的部分。
 *
 * 开关是 `backup.withSecrets`，默认 **false**（不带）。打开之后原样装进包。
 * 擦掉之后恢复也能用：owner.json 里 cookie 为空就是「还没登录」，设置页重新贴一次即可；
 * 云端目标少了密码，界面会显示没填，重新填一轮就好。
 */
const SCRUB_FILES = new Set(['owner.json', 'config.json'])
/** 云端目标里算凭据的字段。`headers` 不在 KINDS 的 pass 类型里，但实际常放令牌，一样擦。 */
export const SECRET_TARGET_FIELDS = ['token', 'pass', 'headers']

/**
 * 擦一份文本文件里的凭据。只认 owner.json / config.json。
 * @returns {null | { text?: string, broken?: true }} null = 不用动；{ text } = 擦过的新内容；
 *   { broken } = 结构读不出来——调用方不给它进包（宁可缺这个文件，也不赌它里面没有凭据）。
 */
function scrubSecrets(rel, text) {
  if (!SCRUB_FILES.has(rel)) return null
  let obj
  try {
    obj = JSON.parse(text)
  } catch {
    return { broken: true }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { broken: true }
  let changed = false
  if (rel === 'owner.json' && String(obj.cookie ?? '')) {
    obj.cookie = ''
    changed = true
  }
  if (rel === 'config.json' && Array.isArray(obj?.cloud?.targets)) {
    for (const t of obj.cloud.targets) {
      if (!t || typeof t !== 'object' || Array.isArray(t)) continue
      for (const k of SECRET_TARGET_FIELDS) {
        if (String(t[k] ?? '')) {
          t[k] = ''
          changed = true
        }
      }
    }
  }
  // 和 store.js 写配置同一个排版：双击打开是人读的，不是给机器看的。
  return changed ? { text: JSON.stringify(obj, null, 2) } : null
}

/** 单个文件上限：8MB（头像 2MB 够用，日记再长也不该破这个数）。 */
const MAX_FILE_BYTES = 8 * 1024 * 1024
/** issue #65：事件流是只追加的单个大文件，绝不能因为超过上限被整个跳过。 */
const ALWAYS_INCLUDE = new Set(['events.jsonl'])
/** 备份总量上限：64MB。超了就别往一个 json 里塞了。事件流不算在里面（见 collectBackup）。 */
const MAX_TOTAL_BYTES = 64 * 1024 * 1024

/**
 * 自动备份默认不带的「附件」（2026-11-15，用户 m01641）。
 *
 * 接了微信 / QQ 桥之后，桥把收到的图片、电子书原样存在数据文件夹里，几份备份就是
 * 90MB——邮箱目标一次只收得下十几兆，等于这条备份链在最需要它的时候断掉。这些文件
 * 的共同点是**拿得回来**：图片是别人发来的，电子书本来就在别处；它们不是她长出来的
 * 东西。手动「备份成一份文件」仍然是全量：那是用户主动要带走的一整份，宁可大也不能缺。
 *
 * 判定分三层：目录（桥的收件箱、媒体、更新包）、扩展名（图片 / 电子书 / 压缩包 /
 * 音视频 / 办公文档），外加 4MB 以上的单文件兜底（有些桥自己起名，不看扩展名）。
 * `collectBackup` 默认不带这些，只有自动备份传 `skipAttachments: true` 才生效。
 */
const ATTACHMENT_DIRS = ['media', 'updates', 'home/.dsh-im']
const ATTACHMENT_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.heic', '.tiff',
  '.epub', '.mobi', '.azw3', '.pdf',
  '.zip', '.7z', '.rar', '.tar', '.gz', '.iso', '.dmg', '.exe',
  '.mp4', '.mkv', '.mov', '.avi', '.webm', '.mp3', '.m4a', '.wav', '.flac',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
])
/** 单个文件超过这个大小，自动备份就不带了（不看扩展名）。 */
const ATTACHMENT_MAX_FILE_BYTES = 4 * 1024 * 1024
/** 头像永远带：它是最容易被误判成「一张图片」的那一个。 */
const KEEP_ALWAYS = /^avatar\.(png|jpe?g|webp|gif)$/i

/**
 * 恢复接口一次收多少字节（observe.js 的 `/backup/restore`）。
 * 事件流不设上限，包就可能比这个大；导出时拿它比一下，超了当场说（issue #65）。
 */
export const RESTORE_MAX_BYTES = 96_000_000

/**
 * 一个字符串写成 JSON（带两边的引号）有多少字节（UTF-8）。
 * 和 `Buffer.byteLength(JSON.stringify(s))` 一样多，但不真造出那个字符串：事件流能有近百 MB，
 * 多造一份就多占一份内存。转义规则照 JSON.stringify：引号和反斜杠前面加一个反斜杠，
 * \b \f \n \r \t 写成两个字符，别的控制字符写成 \u00XX，落单的代理项写成 \uXXXX。
 */
function jsonStringBytes(s) {
  const str = String(s)
  let n = 2
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i)
    if (c < 0x80) {
      if (c === 0x22 || c === 0x5c) n += 2
      else if (c >= 0x20) n += 1
      else n += c === 8 || c === 9 || c === 10 || c === 12 || c === 13 ? 2 : 6
    } else if (c < 0x800) {
      n += 2
    } else if (c >= 0xd800 && c <= 0xdbff) {
      const d = i + 1 < str.length ? str.charCodeAt(i + 1) : 0
      if (d >= 0xdc00 && d <= 0xdfff) { n += 4; i++ } else n += 6
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      n += 6
    } else {
      n += 3
    }
  }
  return n
}

/**
 * 这份包走「从备份恢复」时请求体有多大：设置页把包原样 JSON.stringify 再 POST 回来。
 * 文件内容按 jsonStringBytes 算，其余字段真 stringify 一次（很小），合起来和整包 stringify 一样多。
 */
export function bundleBytes(bundle) {
  const files = Array.isArray(bundle?.files) ? bundle.files : null
  if (!files || !files.every((f) => f && typeof f === 'object' && typeof f.data === 'string')) {
    return Buffer.byteLength(JSON.stringify(bundle), 'utf8')
  }
  const shell = JSON.stringify({ ...bundle, files: files.map((f) => ({ ...f, data: '' })) })
  return files.reduce((n, f) => n + jsonStringBytes(f.data) - 2, Buffer.byteLength(shell, 'utf8'))
}

/** 包里一条文件记录写成 JSON 有多少字节，连数组里的逗号。 */
function entryBytes(entry) {
  return Buffer.byteLength(JSON.stringify({ ...entry, data: '' }), 'utf8') - 2 + jsonStringBytes(entry.data) + 1
}

/** 再放就超过恢复上限时，skipped 里写的原因。 */
const WHY_RESTORE = '放进来就超过「从备份恢复」一次能收的大小'
/** 预留篇幅时按最长的那个原因算：还没定的文件万一没装进去，每个都要在 skipped 里写一行。 */
const SKIP_WHY_MAX = Math.max(...[WHY_RESTORE, '总量已到 64MB 上限', '读失败'].map((x) => Buffer.byteLength(x, 'utf8')))
/**
 * observe.js 在包外面再添的字段：fileName（备份文件名，几十字节）、restoreLimit，
 * 以及 restoreBytes、fitsRestore（它给这两个留了 64 字节）。合起来一百多字节，按 256 留。
 */
const OBSERVE_EXTRA = 256

/**
 * 包里文件以外的部分（外壳）最多有多大：数字按最长的写法算，只多不少。
 * files、skipped、excluded 先按空数组算，条目（连逗号）另算。
 */
function shellBytes(createdAt) {
  const shell = {
    format: BACKUP_FORMAT,
    schema: EVENT_SCHEMA_VERSION,
    createdAt,
    files: [],
    skipped: [],
    skippedUnlisted: Number.MAX_SAFE_INTEGER,
    excluded: [],
    nonUtf8: [],
    bytes: Number.MAX_SAFE_INTEGER,
  }
  return Buffer.byteLength(JSON.stringify(shell), 'utf8') + OBSERVE_EXTRA
}

/** skipped 里一行（「路径（原因）」）写成 JSON 有多少字节，连逗号。 */
function skipLineBytes(rel, why) {
  return jsonStringBytes(`${rel}（${why}）`) + 1
}

/** 还没定的文件按最长的原因给它留一行。 */
function reserveOf(rel) {
  return jsonStringBytes(rel) + Buffer.byteLength('（）', 'utf8') + SKIP_WHY_MAX + 1
}

/** 她自己写的、带回来的东西所在的子目录。 */
const HER_DIRS = new Set(['diary', 'home', 'keepsakes', 'works'])

/**
 * 额度紧的时候谁先进包，数小的先。看的是丢了能不能找回来，不是在第几层：
 *   0 顶层找不回来的文件：owner.json（主人身份和登录）、config.json、头像、各种台账
 *   1 她自己写的、带回来的：diary/、home/、keepsakes/、works/（1.0.5 起）
 *   2 别的子目录：out/（每日报告）、media/（只留几天的画面和图）……
 *   3 丢了也找得回来的：state.json（由事件流重算的派生快照，见 store.js）、各处的 .log（现场记录）
 * skipped 里的说明行也按这个排，要紧的在前。
 * works/ 里的图/声音/影像跟着自动备份的附件口径走：自动备份不带、手动备份带；
 * 正文 .md 两份都带——自动备份不会被她画的图撑爆。
 */
function packRank(rel) {
  if (rel === PRESSURE_OBSERVATIONS) return 0
  if (rel === 'state.json' || rel.toLowerCase().endsWith('.log')) return 3
  const i = rel.indexOf('/')
  if (i < 0) return 0
  return HER_DIRS.has(rel.slice(0, i)) ? 1 : 2
}

function byPath(a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * 给人看的大小：1MB 以上写 MB（十进制，和上限的写法一致），以下写 KB。
 * 留一位小数、往上取：刚过上限的包不会显示成和上限一样大。设置页的 mbText 是同一个写法。
 */
export function sizeText(bytes) {
  const n = Math.max(0, Number(bytes) || 0)
  if (n >= 1_000_000) return `${Math.ceil(n / 100_000) / 10}MB`
  return `${Math.max(1, Math.ceil(n / 1000))}KB`
}

/** 0.9.5 及以前的包把故意不带的目录也记在 skipped 里，形如「logs/（不搬：logs）」。 */
const OLD_EXCLUDED = /\/（不搬：[^）]*）$/

const TEXT_EXT = ['.json', '.jsonl', '.md', '.txt', '.srt', '.yml', '.yaml', '.csv']

function isText(name) {
  const lower = name.toLowerCase()
  return TEXT_EXT.some((e) => lower.endsWith(e))
}

/** 时间戳目录名用的 `YYYYMMDD-HHMMSS`（与 reset.js 同风格，便于人看）。 */
function stamp(now) {
  const p = (n) => String(n).padStart(2, '0')
  return (
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  )
}

/**
 * 把状态库装进内存对象。
 * @param {string} root
 * @param {{ now?: Date, restoreLimit?: number, alsoSkip?: string[], include?: string[], withSecrets?: boolean }} [opts]
 *   include：只收这些相对路径及其子路径；省略则保持原范围。
 *   skipAttachments：不带桥接附件与媒体（图片 / 电子书 / 音视频 / 更新包等）。
 *     **只有自动备份传它**；手动备份保持全量。传了也不影响 include 里明确勾选的路径。
 *   restoreLimit：恢复接口一次收多少字节（单测会调小）。
 *   alsoSkip：这一次另外不带的目录（相对根，如 `out/covers`）。**只有自动备份用**——
 *     它每半小时可能就写一份，`out/` 下的封面缓存占了包体六成，纯属可重建的东西，
 *     不值得反复搬。手动「备份成一份文件」不传它，口径一个字不动。
 *   withSecrets：包里带不带凭据，默认 **false**（不带，见 scrubSecrets）。开关在
 *     `backup.withSecrets`，**只管自动备份与云端**（云端推的就是自动备份写出的那一份文件）；
 *     手动「备份成一份文件」是用户当场按下的一次性动作，不受它管，由调用方显式传 true
 *     （用户 m00712：一个开关管两条无人值守的渠道，手动另外算）。
 * @returns {Promise<object>} `{ format, schema, createdAt, files, skipped, skippedUnlisted, excluded, bytes }`
 *   skipped 是真没装进去的文件（带原因）；skippedUnlisted 是也没装进去、但包里写不下名字的个数
 *   （只在事件流顶到恢复上限附近时才会有）；excluded 是照规矩不带的目录（logs/、backups/ 这些，
 *   以及 alsoSkip 那几个），落在里面的会跟着包走，读的人看得出这份包少拿了什么。
 */
export async function collectBackup(
  root = rootDir(),
  { now = new Date(), restoreLimit = RESTORE_MAX_BYTES, alsoSkip = [], include, skipAttachments = false, withSecrets = false } = {},
) {
  const extra = new Set(
    (Array.isArray(alsoSkip) ? alsoSkip : [])
      .map((x) => String(x ?? '').replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/+$/, ''))
      .filter(Boolean),
  )
  const found = []
  // 没装进去的文件：{ rel, why }。说明行最后统一写进 skipped（见「说明行」）。
  const out = []
  const excluded = []
  // issue #65：不是合法 UTF-8 的文本文件。它们按原字节装成 base64（见 read），
  // 名字单独列在包里，回执与恢复都能照实说。
  const nonUtf8 = []

  // 先只看不读：要装哪些、各多大。读和挑放在后面，挑的顺序不跟 readdir 走。
  const walk = async (dir, pressureOnly = false) => {
    let names
    try {
      names = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of names) {
      const full = join(dir, e.name)
      const rel = relative(root, full).split(sep).join('/')
      if (pressureOnly && rel !== PRESSURE_OBSERVATIONS
        && !(e.isDirectory() && PRESSURE_OBSERVATIONS.startsWith(rel + '/'))) {
        excluded.push(e.isDirectory() ? rel + '/' : rel)
        continue
      }
      if (extra.has(rel) || (include && !include.some((prefix) =>
        rel === prefix || rel.startsWith(prefix + '/') || (e.isDirectory() && prefix.startsWith(rel + '/'))
      ))) {
        // 可选范围跳过的路径也记进 excluded。
        excluded.push(e.isDirectory() ? `${rel}/` : rel)
        continue
      }
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) {
          const sampleDir = join(full, 'session-pressure')
          const hasSamples = rel === 'logs' && (await fs.lstat(sampleDir).catch(() => null))?.isDirectory()
            && (await fs.lstat(join(sampleDir, 'samples.json')).catch(() => null))?.isFile()
          if (hasSamples) await walk(full, true)
          else excluded.push(`${rel}/`)
          continue
        }
        // 自动备份默认不带附件目录（桥的收件箱、媒体、更新包）；手动备份不传这个开关。
        if (skipAttachments && !include && ATTACHMENT_DIRS.some((d) => rel === d || rel.startsWith(`${d}/`))) {
          excluded.push(`${rel}/`)
          continue
        }
        await walk(full, pressureOnly)
        continue
      }
      if (SKIP_FILES.has(rel)) continue
      if (!e.isFile()) {
        out.push({ rel, why: '不是普通文件' })
        continue
      }
      let st
      try {
        st = await fs.stat(full)
      } catch {
        out.push({ rel, why: '读不到' })
        continue
      }
      if (!ALWAYS_INCLUDE.has(rel) && st.size > MAX_FILE_BYTES) {
        out.push({ rel, why: `${Math.round(st.size / 1024 / 1024)}MB，超过单文件上限` })
        continue
      }
      // 自动备份默认不带附件文件：图片 / 电子书 / 压缩包 / 音视频 / 办公文档，
      // 以及 4MB 以上的单文件（有些桥自己起名）。手动备份不传这个开关，口径不变。
      if (skipAttachments && !include && !ALWAYS_INCLUDE.has(rel) && rel !== PRESSURE_OBSERVATIONS && !KEEP_ALWAYS.test(rel)) {
        if (ATTACHMENT_EXT.has(extname(e.name).toLowerCase())) {
          excluded.push(rel)
          continue
        }
        if (st.size > ATTACHMENT_MAX_FILE_BYTES) {
          out.push({ rel, why: `${Math.round(st.size / 1024 / 1024)}MB，自动备份不带附件` })
          continue
        }
      }
      found.push({ rel, full, name: e.name, size: st.size })
    }
  }

  await walk(root)

  const createdAt = now.toISOString()
  const read = async (f) => {
    const buf = await fs.readFile(f.full)
    if (!isText(f.name)) return { path: f.rel, size: buf.length, enc: 'base64', data: buf.toString('base64') }
    // issue #65：文本文件不能一律按 utf8 硬读——不是 UTF-8 的文件那样读会把原字节换成
    // 一长串 U+FFFD，恢复回来只剩问号。读出来再编回去与自己逐字节相同，才认它是 UTF-8；
    // 否则按原字节装成 base64，并带上 `text: true` 这个标记（说它本来是文本）。
    const text = buf.toString('utf8')
    if (Buffer.from(text, 'utf8').equals(buf)) {
      // 凭据默认不进包（2026-11-16，用户 m00605）：擦完的字节数才是它在包里的体积，
      // 后面的 64MB / 恢复上限都按这个数算，不能拿原始文件大小顶替。
      let data = text
      if (!withSecrets) {
        const scrubbed = scrubSecrets(f.rel, text)
        // 结构读不出来就不装这个文件：宁可包里缺 owner.json（恢复后重新登录一次），
        // 也不赌一份解析不了的文本里没有凭据。skipped 里会照实写一行。
        if (scrubbed?.broken) {
          out.push({ rel: f.rel, why: '结构读不出来，凭据擦不干净，没装进包' })
          return null
        }
        if (scrubbed?.text != null) data = scrubbed.text
      }
      return { path: f.rel, size: Buffer.byteLength(data, 'utf8'), enc: 'utf8', data }
    }
    nonUtf8.push(f.rel)
    return { path: f.rel, size: buf.length, enc: 'base64', data: buf.toString('base64'), text: true }
  }

  // wire：这份包按「从备份恢复」POST 回来的样子（JSON）有多大。只多不少。
  let wire = shellBytes(createdAt)
  for (const x of excluded) wire += jsonStringBytes(x) + 1

  // 事件流第一个进包，不受任何上限（issue #65）。
  const first = []
  let total = 0
  for (const f of found.filter((x) => ALWAYS_INCLUDE.has(x.rel))) {
    let entry
    try {
      entry = await read(f)
    } catch {
      out.push({ rel: f.rel, why: '读失败' })
      continue
    }
    if (!entry) continue
    first.push(entry)
    total += entry.size
    wire += entryBytes(entry)
  }

  // 守不守恢复上限，只看事件流（连同外壳）装不装得下。装得下：别的文件挑着放，整份包都装得下。
  // 装不下：这份包怎么都装不回去，导出回执会照实说；这时不为恢复上限挤掉别的文件，
  // 只守 64MB，包至少还是一份完整的存档。
  const guard = wire <= restoreLimit

  // 其余的按 packRank 排：丢了找不回来的先，同一档里小的先。
  const rest = found
    .filter((x) => !ALWAYS_INCLUDE.has(x.rel))
    .sort((a, b) => packRank(a.rel) - packRank(b.rel) || a.size - b.size || byPath(a.rel, b.rel))

  // owed：给没装进去的文件在 skipped 里各留一行说明的篇幅（还没定的按最长的原因留）。
  // 留得下就一直留着（listAll），最后每个没装进去的都有名字；留不下（事件流已经顶到上限附近），
  // 就不留，先把文件装进去，说明行能写几行写几行，写不下的只记个数。两种情况包都装得下。
  let owed = out.reduce((n, s) => n + skipLineBytes(s.rel, s.why), 0) + rest.reduce((n, f) => n + reserveOf(f.rel), 0)
  const listAll = guard && wire + owed <= restoreLimit
  if (!listAll) owed = 0

  // capped：算进 64MB 总量的原始字节。事件流不算——算进去的话它一大，别的文件全会被挤掉。
  let capped = 0
  const picked = []
  for (const f of rest) {
    // 这个文件装进去的话，它那一行就不用留了；没装进去，留的篇幅照旧（它要写一行）。
    const after = listAll ? owed - reserveOf(f.rel) : 0
    if (capped + f.size > MAX_TOTAL_BYTES) {
      out.push({ rel: f.rel, why: '总量已到 64MB 上限' })
      continue
    }
    // 不读就知道放不下的先跳过：二进制按 base64 正好是 4/3，文本转义以后只会更长。
    const least = (isText(f.name) ? f.size : 4 * Math.ceil(f.size / 3)) + 2
    if (guard && wire + least + after > restoreLimit) {
      out.push({ rel: f.rel, why: WHY_RESTORE })
      continue
    }
    let entry
    try {
      entry = await read(f)
    } catch {
      out.push({ rel: f.rel, why: '读失败' })
      continue
    }
    if (!entry) continue
    const cost = entryBytes(entry)
    if (guard && wire + cost + after > restoreLimit) {
      out.push({ rel: f.rel, why: WHY_RESTORE })
      continue
    }
    picked.push(entry)
    capped += entry.size
    total += entry.size
    wire += cost
    owed = after
  }

  // 说明行：和挑的顺序一样，要紧的在前，同一档按路径排。守恢复上限时写到写不下为止，
  // 后面的只记个数（skippedUnlisted），恢复回执照样报真实条数。listAll 时一行都不会落下。
  out.sort((a, b) => packRank(a.rel) - packRank(b.rel) || byPath(a.rel, b.rel))
  const skipped = []
  let unlisted = 0
  for (const s of out) {
    const line = skipLineBytes(s.rel, s.why)
    if (unlisted || (guard && wire + line > restoreLimit)) {
      unlisted++
      continue
    }
    skipped.push(`${s.rel}（${s.why}）`)
    wire += line
  }

  // 包里的顺序：事件流在最前，其余按路径排。
  picked.sort((a, b) => byPath(a.path, b.path))
  const top = (rel) => (rel.includes('/') ? 1 : 0)
  excluded.sort((a, b) => top(a.slice(0, -1)) - top(b.slice(0, -1)) || byPath(a, b))

  return {
    format: BACKUP_FORMAT,
    schema: EVENT_SCHEMA_VERSION,
    createdAt,
    files: [...first, ...picked],
    skipped,
    skippedUnlisted: unlisted,
    excluded,
    // 不是 UTF-8、按原字节装进包里的文本文件（issue #65）。空数组也写，读的人不用猜有没有这个字段。
    nonUtf8: [...nonUtf8].sort(byPath),
    bytes: total,
  }
}

/** 备份的默认文件名：`大肥鱼-20261025-0030.json`。 */
export function backupFileName(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `大肥鱼-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.json`
}

/**
 * 恢复前的那道门：校验、并把「旧档搬走」这件事做完。
 * 只检查、不写盘，方便测试。
 */
export function checkBundle(bundle) {
  if (!bundle || typeof bundle !== 'object') return { ok: false, why: '这不是一个备份文件' }
  if (bundle.format !== BACKUP_FORMAT) {
    return {
      ok: false,
      why: `备份格式是「${String(bundle.format ?? '（空）')}」，这个版本只认「${BACKUP_FORMAT}」`,
    }
  }
  if (!Array.isArray(bundle.files) || bundle.files.length === 0) {
    return { ok: false, why: '备份里一个文件都没有' }
  }
  for (const f of bundle.files) {
    if (!f || typeof f.path !== 'string' || !f.path || typeof f.data !== 'string') {
      return { ok: false, why: '备份里有文件记录缺 path / data' }
    }
    if (f.enc !== 'utf8' && f.enc !== 'base64') {
      return { ok: false, why: `文件 ${f.path} 的编码不认识：${String(f.enc)}` }
    }
    // 目录穿越守门：备份可能被人改过，也见过有人在路径里塞反斜杠。
    // 注意不能先用 resolve() 判——它会把 `..` 规范化掉，等于把证据擦了。
    const segs = f.path.split('/')
    if (f.path.includes(String.fromCharCode(92)) || segs.some((x) => x === '..' || x === '.' || x === '')) {
      return { ok: false, why: `文件路径可疑：${f.path}` }
    }
  }
  // issue #65：没有事件流的备份装回去就是空档，不能默默恢复成功。
  if (!bundle.files.some((f) => f && f.path === 'events.jsonl')) {
    return { ok: false, why: '这份备份里没有事件流（events.jsonl），装回去她会失忆' }
  }
  const schema = Number(bundle.schema ?? 0)
  if (schema > EVENT_SCHEMA_VERSION) {
    return {
      ok: false,
      why: `这份备份来自更新的版本（事件格式 v${schema}，本程序认 v${EVENT_SCHEMA_VERSION}），装回去会丢字段`,
    }
  }
  return { ok: true, why: '', files: bundle.files.length, schemaFrom: schema, schemaTo: EVENT_SCHEMA_VERSION }
}

/** 恢复时旧档搬去哪。与 reset 同目录，但前缀是 `pre-restore-`。 */
export async function quarantineDirFor(root = rootDir(), now = new Date()) {
  const base = join(dirname(resolve(root)), 'dsh-fish-backups')
  let target = join(base, `pre-restore-${stamp(now)}`)
  for (let i = 2; i <= 99; i++) {
    try {
      await fs.stat(target)
      target = join(base, `pre-restore-${stamp(now)}-${i}`)
    } catch {
      return target
    }
  }
  return join(base, `pre-restore-${stamp(now)}-${Date.now()}`)
}

/**
 * 这份包里读出来是「碎字」的文本文件（issue #65）。
 *
 * 0.9.6 之前的导出把文本一律按 utf8 硬读：非 UTF-8 的文件（GBK 写的日记、从别处拖进来的
 * .md）当时就换成了 U+FFFD，原字节已经丢了。这类文件能恢复，但恢复出来的是一串问号，
 * 与其假装成功，不如把名字摊给人看、由他决定跳过还是照装。
 * base64 装的文本不算坏——那是 0.9.6 之后按原字节存的，字节是完整的。
 */
export function badTextFiles(bundle) {
  const files = Array.isArray(bundle?.files) ? bundle.files : []
  const bad = []
  for (const f of files) {
    if (!f || typeof f.path !== 'string' || typeof f.data !== 'string') continue
    if (f.enc === 'base64') continue
    if (!isText(f.path)) continue
    if (f.data.includes('\uFFFD')) bad.push(f.path)
  }
  return bad.sort(byPath)
}

async function preservePressureObservations(quarantined, root) {
  const read = async path => fs.readFile(path, 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error
    return null
  })
  const before = await read(join(quarantined, PRESSURE_OBSERVATIONS))
  if (before == null) return
  const dest = join(root, PRESSURE_OBSERVATIONS)
  const restored = await read(dest)
  if (restored === before) return
  if (restored == null) {
    await writeAtomic(dest, before)
    return
  }
  const local = JSON.parse(before)
  const incoming = JSON.parse(restored)
  const mergeBySession = (left = {}, right = {}, canonicalize = rows => rows) =>
    Object.fromEntries([...new Set([...Object.keys(left), ...Object.keys(right)])]
      .map(id => [id, { ...canonicalize(left[id]), ...canonicalize(right[id]) }]))
  const bySeq = rows => Object.fromEntries(Object.entries(rows ?? {}).map(([key, row]) =>
    [Number.isSafeInteger(row?.seq) ? row.seq : key, row]))
  const dates = [local.observedSince, incoming.observedSince].filter(Number.isFinite)
  await writeAtomic(dest, JSON.stringify({
    ...incoming, ...local,
    ...(dates.length ? { observedSince: Math.min(...dates) } : {}),
    records: mergeBySession(incoming.records, local.records, bySeq),
    compactionPairs: mergeBySession(incoming.compactionPairs, local.compactionPairs),
    compactions: { ...incoming.compactions, ...local.compactions },
    rotations: { ...incoming.rotations, ...local.rotations },
  }))
}

/**
 * 恢复。顺序：校验 → 旧档改名 → 建新库 → 写文件。
 * @param {{ skipBad?: boolean }} [opts] skipBad：包里那些「读出来是碎字」的文本已经给人看过、
 *   他选了跳过；不传时遇到坏文件一律不动、把名单回给调用方去问（`needDecision`）。
 * @returns {Promise<{ok:boolean, why?:string, restored?:number, quarantined?:string, schemaFrom?:number, skipped?:string[], skippedCount?:number, skippedUnlisted?:number, skippedBad?:string[], needDecision?:boolean, badFiles?:string[], badCount?:number}>}
 *   skipped 是导出时就没装进包的文件，最多带前 200 条；skippedUnlisted 是包里只记了个数、没写名字的；
 *   skippedCount 是真实条数（两样加起来）。skippedBad 是这次因为坏字被跳过的文件。
 */
export async function restoreBackup(bundle, root = rootDir(), { now = new Date(), skipBad = false } = {}) {
  const chk = checkBundle(bundle)
  if (!chk.ok) return { ok: false, why: chk.why }

  // issue #65：先把坏文件点出来，别等写完了才让人发现日记里全是「�」。
  // 这一步在搬旧档之前，所以人拒绝的时候现在的档一个字节都没动。
  const bad = badTextFiles(bundle)
  if (bad.length && !skipBad) {
    return {
      ok: false,
      needDecision: true,
      badFiles: bad.slice(0, 50),
      badCount: bad.length,
      why: `这份备份里有 ${bad.length} 个文本文件读出来是碎字（早先导出时丢过字节）：`
        + `${bad.slice(0, 5).join('、')}${bad.length > 5 ? ' 等' : ''}。`
        + '现在的档什么都没动。可以跳过这些文件继续恢复，其余照常。',
    }
  }
  const badSet = new Set(bad)
  // 0.9.8 及以前的包带着导出那次运行的占用声明和会话锁：不放回（见 SKIP_FILES）。
  const stale = bundle.files.filter((f) => SKIP_FILES.has(f.path)).length

  const quarantined = await quarantineDirFor(root, now)
  let hadOld = false
  try {
    await fs.stat(root)
    hadOld = true
  } catch {}

  if (hadOld) {
    await fs.mkdir(dirname(quarantined), { recursive: true })
    try {
      await fs.rename(root, quarantined)
    } catch (err) {
      // 跨盘 / 被占用：不部分搬走，直接如实报错
      return {
        ok: false,
        why: `旧档搬不动（${String(err?.code ?? err)}），这次恢复什么都没改`,
      }
    }
  }

  try {
    await fs.mkdir(root, { recursive: true })
    for (const f of bundle.files) {
      if (badSet.has(f.path) || SKIP_FILES.has(f.path)) continue
      const dest = join(root, ...f.path.split('/'))
      await fs.mkdir(dirname(dest), { recursive: true })
      await fs.writeFile(dest, f.enc === 'base64' ? Buffer.from(f.data, 'base64') : f.data, {
        encoding: f.enc === 'base64' ? undefined : 'utf8',
      })
    }
    if (hadOld) await preservePressureObservations(quarantined, root)
  } catch (err) {
    return {
      ok: false,
      why: `写到一半失败：${String(err?.message ?? err)}。旧档完好，在 ${quarantined}（如果它不是空的）`,
      quarantined,
    }
  }

  const missing = skippedInBundle(bundle)
  const unlisted = unlistedInBundle(bundle)
  return {
    ok: true,
    restored: bundle.files.length - badSet.size - stale,
    quarantined: hadOld ? quarantined : '',
    schemaFrom: Number(bundle.schema ?? 0),
    skipped: missing.slice(0, 200),
    skippedCount: missing.length + unlisted,
    skippedUnlisted: unlisted,
    // issue #65：这次因为「读出来是碎字」被跳过的文件（人选的）。为空表示一个都没跳。
    skippedBad: [...badSet].sort(byPath),
  }
}

/**
 * 导出那一刻就没装进包的文件。恢复出来也不会有它们，恢复的回执要照实说。
 * 包可能被人改过，这里只收字符串、每条限长；旧包里「不搬」的那几条不算。条数不截，回执要报真实的数。
 */
export function skippedInBundle(bundle) {
  const list = Array.isArray(bundle?.skipped) ? bundle.skipped : []
  return list
    .filter((x) => typeof x === 'string' && x && !OLD_EXCLUDED.test(x))
    .map((x) => x.slice(0, 200))
}

/** 包里只记了个数、没写名字的那几个（skippedUnlisted）。旧包没有这个字段，算 0；被人改坏了也算 0。 */
function unlistedInBundle(bundle) {
  const n = Number(bundle?.skippedUnlisted)
  return Number.isSafeInteger(n) && n > 0 ? n : 0
}
