/**
 * log.js —— 插件自己的运行日志（2026-10-24 加）
 *
 * 为什么要有这个：插件的所有日志以前走 `ctx.logger`，而宿主不把它落盘。
 * 真机上 `launch.log` 只有两行（token + 一条 llm 提示），`launch.err.log` 是 0 字节。
 * 结果就是：她某晚没说话、没刷站、没写日记，事后只能靠自检页猜。
 * 以「天」为单位的行为出问题，几乎都是「昨天还好今天不动了」，而那时的现场
 * 全在内存里，重启就没了。
 *
 * 三条硬规矩：
 * 1. **永不抛**。日志写不进去（盘满、权限被改、目录被删）绝不能连带让插件挂掉。
 * 2. **不做成配置项**。没有 `log.enabled` 这种开关——理由有两个：
 *    ① 关掉日志只会在出事那一刻让人后悔；② `/config` 的白名单曾经因为漏登记
 *    一个组把保存挡成 400（静默 bug ⑪），少一个可配键就少一个坑。
 * 3. **脱敏**。cookie 一类的值在写盘前替换掉，日志是给人看的，不是给泄露用的。
 *
 * 文件：`~/.dsh-fish/logs/dsh-fish.log`，超过 LOG_MAX_BYTES 轮转，
 * 依次 `dsh-fish.log.1`、`.2`，更老的丢掉。总量上界约 3 × 2MB。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { platform, arch } from 'node:os'

export const LOG_MAX_BYTES = 2 * 1024 * 1024
export const LOG_KEEP = 2
export const LINE_MAX = 2000

/** 日志目录（状态库下的 logs/，与 events.jsonl 同级，方便一起打包） */
export function logsDir(root) {
  const base = root || process.env.DSH_FISH_HOME || join(homedir(), '.dsh-fish')
  return join(base, 'logs')
}

export function logFile(root) {
  return join(logsDir(root), 'dsh-fish.log')
}

/** 抹掉可疑的凭据。宁可把一条日志毁掉，也不要让 cookie 进日志文件。 */
// 2026-10-29（用户 m02241）：以前这条正则会把**会话 id 一起抹掉**。
// `session-058a9c4d-0999-4772-8264-c289f799fd09` 有 42 字符、字母数字混合，
// 正好命中下面的规则②，于是日志里到处是「会话 ***」「woke *** test_first」——
// 排查「是哪条会话出的问题」时日志一个字都给不出来，只能去 outings.json 台账反推。
//
// 这些是**我们自己的标识符**，不是凭据：会话 id 只在宿主内部有用，
// 事件 id 本来就是本机事件流的主键，抹掉它们只会让日志失去价值。
// 所以先摘出来、跑完脱敏再放回去。
const KEEP_PATTERNS = [
  /\bsession-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
  /\bsession-[0-9a-zA-Z]{6,}\b/g,
  /\bev_[0-9A-HJKMNP-TV-Z]{20,}\b/g,
]

export function scrub(text) {
  let s = String(text ?? '')
  // 先把要保留的标识符换成占位符（用不含字母数字混排的记号，跑完换回来）
  const kept = []
  for (const re of KEEP_PATTERNS) {
    s = s.replace(re, (m) => {
      kept.push(m)
      return `\u0000KEEP${kept.length - 1}\u0000`
    })
  }
  // SESSDATA=xxx&bili_jct=yyy 这种整段 cookie
  s = s.replace(/(SESSDATA|bili_jct|buvid3|DedeUserID__ckMd5|DedeUserID|sid)=[^&\s"',;}]{4,}/gi, '$1=***')
  // 裸的 32+ 位十六进制/base64 长串（cookie 值常见形状）
  s = s.replace(/\b[A-Za-z0-9_\-]{40,}\b/g, (m) => (/\d/.test(m) && /[A-Za-z]/.test(m) ? '***' : m))
  // 把标识符放回去
  s = s.replace(/\u0000KEEP(\d+)\u0000/g, (_m, i) => kept[Number(i)] ?? '***')
  return s
}

function stamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  // 本地时间，不写时区偏移：看日志的人只关心"几点发生的"
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function fmtArg(a) {
  if (a instanceof Error) return a.stack ? `${a.message} :: ${a.stack.split('\n').slice(1, 3).join(' ').trim()}` : a.message
  if (typeof a === 'string') return a
  try {
    return JSON.stringify(a)
  } catch {
    return String(a)
  }
}

/** 轮转：把 .log 顶成 .log.1，.1 顶成 .2，.2 丢掉 */
export function rotateIfNeeded(root) {
  try {
    const file = logFile(root)
    if (!existsSync(file)) return false
    if (statSync(file).size < LOG_MAX_BYTES) return false
    for (let i = LOG_KEEP; i >= 1; i -= 1) {
      const from = i === 1 ? file : `${file}.${i - 1}`
      const to = `${file}.${i}`
      if (!existsSync(from)) continue
      try {
        if (i === LOG_KEEP && existsSync(to)) unlinkSync(to)
        renameSync(from, to)
      } catch { /* 单个文件挪不动不影响别的 */ }
    }
    return true
  } catch {
    return false
  }
}

/**
 * 写一行。level ∈ debug|info|warn|error。
 * 返回 true/false（写没写成功），但调用方**不需要看**返回值——永不抛。
 */
export function logLine(level, parts, root) {
  try {
    const line = `${stamp()} [${level}] ${scrub(parts.map(fmtArg).join(' ')).slice(0, LINE_MAX)}\n`
    const dir = logsDir(root)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    rotateIfNeeded(root)
    appendFileSync(logFile(root), line, 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * 造一个 logger：既能进日志文件，也继续转发宿主 logger（有人在控制台看时仍然有）。
 * `ctx.logger` 可能不存在（测试环境），所以每一层都 optional。
 */
export function makeLogger(ctx, root) {
  const push = (level) => (...args) => {
    logLine(level, args, root)
    try {
      ctx?.logger?.[level]?.(...args)
    } catch { /* 宿主 logger 自己坏了也不能影响我们 */ }
  }
  return { debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') }
}

/** 启动时打一行分隔，方便在导出里定位"这一次启动" */
export function logBoot(root, extra = '') {
  logLine('info', [`===== 启动 ${extra}`.trim()], root)
}

/** 读末尾若干行（给设置页预览与导出用） */
export function tailLog(root, { lines = 50, maxBytes = 256 * 1024 } = {}) {
  try {
    const file = logFile(root)
    if (!existsSync(file)) return { file, exists: false, bytes: 0, lines: [] }
    const st = statSync(file)
    const size = st.size
    const readBytes = Math.min(size, maxBytes)
    const buf = readFileSync(file)
    const slice = buf.subarray(buf.length - readBytes)
    const text = slice.toString('utf8')
    // 从尾部读的时候第一行可能是半截，丢掉
    const all = text.split('\n')
    if (readBytes < size) all.shift()
    const kept = all.filter((l) => l.length > 0)
    return { file, exists: true, bytes: size, lines: kept.slice(-lines), total: kept.length }
  } catch (err) {
    return { file: logFile(root), exists: false, bytes: 0, lines: [], why: String(err?.message ?? err) }
  }
}

/**
 * 事件流尾巴（2026-10-28 加）。
 *
 * 为什么日志文件不够：`watched:` 这种计数是**写进 events.jsonl 的 meta 事件**，
 * 日志文件里一个字都没有；`bili_watch` 当年也压根没写日志。于是用户那边
 * 「看不到画面」时，导出包里没有任何东西能回答「今天到底看没看过画面」。
 *
 * 不 import store.js：那边已经 import 了本文件，反向引用会成环。路径规则很简单，
 * 就是 `<root>/events.jsonl`，跟 store.paths().events 一致。
 */
export function tailEvents(root, { lines = 60, maxBytes = 256 * 1024 } = {}) {
  const base = root || process.env.DSH_FISH_HOME || join(homedir(), '.dsh-fish')
  const file = join(base, 'events.jsonl')
  try {
    if (!existsSync(file)) return { file, exists: false, bytes: 0, lines: [] }
    const size = statSync(file).size
    const readBytes = Math.min(size, maxBytes)
    const buf = readFileSync(file)
    const slice = buf.subarray(buf.length - readBytes)
    const all = slice.toString('utf8').split('\n')
    // 从尾部读时第一行可能是半截 JSON，丢掉
    if (readBytes < size) all.shift()
    const kept = all.filter((l) => l.trim().length > 0)
    return { file, exists: true, bytes: size, lines: kept.slice(-lines), total: kept.length }
  } catch (err) {
    return { file, exists: false, bytes: 0, lines: [], why: String(err?.message ?? err) }
  }
}

export function clearLog(root) {
  try {
    const file = logFile(root)
    if (!existsSync(file)) return { ok: true, cleared: false }
    writeFileSync(file, '', 'utf8')
    return { ok: true, cleared: true }
  } catch (err) {
    return { ok: false, why: String(err?.message ?? err) }
  }
}

/** 把配置里不该外带的东西去掉。config 结构里没有 cookie，但别指望将来也没有。 */
export function redactConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return cfg
  const clone = JSON.parse(JSON.stringify(cfg))
  for (const k of ['cookie', 'cookies', 'token', 'password', 'secret']) {
    if (k in clone) clone[k] = '***'
  }
  if (clone.owner && typeof clone.owner === 'object') {
    for (const k of Object.keys(clone.owner)) if (/cookie|sessdata|jct/i.test(k)) clone.owner[k] = '***'
  }
  return clone
}

/**
 * meta 行里整行都是系统自己记的账的前缀：日期、BV 号、事件 id、计数、失败原因、视频标题。
 * 这些原样进导出包。
 *
 * 加新的 meta 前缀时：冒号后面只有系统自己拼的东西，才加进这里；带着她写的字、他写的字
 * （工具回执、请求标题、导入的人设）就不要加，落到下面「只留头和长度」那一路。
 * 忘了加也只是导出里少看到几个字，不会多带出去。
 */
const META_EXPORT_PLAIN = [
  // 调度
  'sched:', 'wake:', 'wakefail:', 'fired:', 'quiet:', 'sleep:', 'think:', 'table:', 'rest:',
  'drive-spend:', 'proactive-turn:', 'proactive-silent:', 'digest:', 'rotate:', 'hand:',
  // 上网
  'browse:', 'browse-more:', 'browsed:', 'looked:', 'look:', 'watched:', 'hook:',
  'comment:', 'creply:', 'cseen:',
  // 他来过、日记、信、反应
  'seen:', 'diary:', 'letter:', 'react:',
  // 请求的裁决（只带事件 id；ask-time 后面是时段和次数）
  'ask-ok:', 'ask-no:', 'ask-later:', 'ask-time:',
  // 出门 / 请神 / 冷落的结算（一串事件 id）
  'outing-reject:', 'outing-keep:', 'possess-reject:', 'possess-keep:', 'absence-reject:',
  // 没有读取方的系统说明
  '家换了：',
]

/** `use:<工具> ok|fail <她听见的那句>`：那句优先取回执的 echo，her_note / her_appoint 的 echo 就是她写的原文。 */
const META_USE_HEAD = /^use:[A-Za-z0-9_.-]{1,64} (?:ok|fail)(?= |$)/
/** `proactive-say:<日期>:<why>`：why 是她调 her_say 时自己填的「为什么现在想说」。没填时是 free。 */
const META_SAY_HEAD = /^proactive-say:\d{4}-\d{2}-\d{2}:(?:free$)?/
/** 不认识的行只认得出这种形状的前缀；连这个都不是就一个字不留。 */
const META_ANY_HEAD = /^[a-z][a-z0-9-]{0,31}:/

/**
 * meta 行进导出包之前过一遍。
 *
 * meta 都是系统写的，但有几种把人写的字夹在里面：`use:` 的后半句（工具回执，her_note、
 * her_appoint、her_say 的回执就是她写的原文）、`proactive-say:` 的 why、`selfrule:`
 * （她请求的标题）、`import-name:` / `import-mark:`（导入的人设里的名字、导入时填的来源）。
 * 这几种和以后新加的、这里不认识的前缀，都只留记账的头和后面有多长。
 */
function exportMetaLine(ev, line) {
  const text = typeof ev.text === 'string' ? ev.text : ''
  if (META_EXPORT_PLAIN.some((p) => text.startsWith(p))) return line
  const head = (META_USE_HEAD.exec(text) ?? META_SAY_HEAD.exec(text) ?? META_ANY_HEAD.exec(text) ?? [''])[0]
  if (head && head.length === text.length) return line
  const { id, ts, type } = ev
  const flags = Array.isArray(ev.flags) ? ev.flags : []
  const rest = text.length - head.length
  return JSON.stringify({ id, ts, type, flags, text: `${head}（后面 ${rest} 字不导出）`, textLen: text.length })
}

/**
 * 事件流尾巴的一行，进导出包之前过一遍。
 *
 * 设置页答应了「不含正文」「没有她说过的话」，导出又是让人转手交给别的 AI 的。
 * 用白名单而不是删 text：refuse.quote、ask.subject 也带原话，以后加的字段也可能带。
 * meta 另有一份前缀白名单（见 exportMetaLine）：`watched:` 这类计数和失败记录，正是这段
 * 尾巴存在的理由，原样留；带着她或他写的字的那几种只留记账的头。都还要过 scrub。
 */
function exportEventLine(line) {
  let ev = null
  try {
    ev = JSON.parse(line)
  } catch { /* 下面按坏行算 */ }
  // 解析不了、不是对象（裸字符串之类），或没有 type 这个基本字段：不知道里面是什么，只报长度
  if (!ev || typeof ev !== 'object' || Array.isArray(ev) || typeof ev.type !== 'string') return `(坏行，长 ${line.length} 字符，内容不导出)`
  if (ev.type === 'meta') return exportMetaLine(ev, line)
  const { id, ts, type } = ev
  const flags = Array.isArray(ev.flags) ? ev.flags : []
  return JSON.stringify({ id, ts, type, flags, textLen: typeof ev.text === 'string' ? ev.text.length : 0 })
}

/**
 * 导出包：一次给 AI 看够。
 * 顺序按"排查时最先想看什么"排：环境 → 模型 → 自检 → 工具面 → 事件流 → 日志 → 宿主报错。
 *
 * 2026-10-28 加了三样（用户 m06256 点名要的，起因是另一台机器「看不到画面」查不出所以然）：
 *   ① `restrict.effective` —— 真下给宿主的名单，与配置里的 allow 分开写；
 *   ② `model` —— 她那条会话用的哪个模型、支不支持图像输入；
 *   ③ events.jsonl 尾部 —— `watched:` 计数与失败记录都在事件流里，日志文件里没有。
 */
export function buildBundle(root, {
  checks = null,
  version = '',
  restrict = null,
  config = null,
  model = null,
  eventLines = 60,
  lines = 200,
} = {}) {
  const out = []
  const now = new Date()
  out.push('=== 大肥鱼 dsh-fish 运行日志导出 ===')
  out.push(`导出时间: ${stamp(now)}`)
  if (version) out.push(`插件版本: ${version}`)
  out.push(`Node: ${process.version} / 平台: ${platform()} ${arch()}`)
  out.push(`状态库: ${root}`)

  if (model && typeof model === 'object') {
    // 「她看不见画面」有一半的原因是模型本身不吃图，跟 ffmpeg、跟额度都无关。
    const who = model.provider || model.model ? `${model.provider ?? '?'} / ${model.model ?? '?'}` : '(读不到)'
    const img = model.imageInput === true ? '支持' : model.imageInput === false ? '不支持' : '说不准'
    out.push(`模型: ${who} · 图像输入: ${img}${model.why ? ` · 原因: ${model.why}` : ''}`)
  }

  if (restrict) {
    const cfgN = (restrict.allow || []).length
    const eff = Array.isArray(restrict.effective) ? restrict.effective : []
    out.push(
      `工具面: ${restrict.applied ? '已收窄' : '未收窄'} · 配置允许 ${cfgN} 个` +
        `${restrict.guard ? ' · 有兜底守卫' : ' · 没有兜底守卫'}` +
        `${restrict.why ? ` · 原因: ${restrict.why}` : ''}`,
    )
    // 两个数字分开报。0.6.0 那台机器的导出里只有一个「允许 7 个」，
    // 而实际生效的是 1 个 —— 那一行把排查的人直接带偏了。
    out.push(
      eff.length
        ? `实际生效: ${eff.length} 个（${eff.join(' / ')}）`
        : `实际生效: 没收窄 —— 这一局她看得见全部工具`,
    )
    const missing = (restrict.allow || []).filter((n) => !eff.includes(n))
    if (eff.length && missing.length) {
      out.push(`名单里没生效的: ${missing.join(' / ')}`)
    }
  }

  if (checks && Array.isArray(checks.items)) {
    out.push('', '--- 自检 ---')
    out.push(`结论: ${checks.summary || '(无)'}`)
    for (const it of checks.items) {
      const mark = it.ok ? 'OK ' : 'BAD'
      out.push(`${mark} ${it.label || it.id}: ${it.detail || ''}${it.fix ? ` | 修法: ${it.fix}` : ''}`)
    }
  }

  // 事件流尾部：`watched:` 是「今天看没看过画面」的唯一凭证，
  // 失败记录也只在事件流里（日志文件里当年一条都没写，见 watch.js）。
  if (eventLines > 0) {
    const ev = tailEvents(root, { lines: eventLines })
    out.push('', `--- 事件流（最近 ${ev.lines.length} 条，文件共 ${ev.bytes} 字节）---`)
    out.push(ev.exists ? (ev.lines.length ? ev.lines.map((l) => scrub(exportEventLine(l))).join('\n') : '(空)') : '(还没有 events.jsonl)')
  }

  const log = tailLog(root, { lines })
  out.push('', `--- 日志（最近 ${log.lines.length} 行，文件共 ${log.bytes} 字节）---`)
  out.push(log.exists ? log.lines.map((l) => scrub(l)).join('\n') : '(还没有日志文件)')

  try {
    const errFile = join(root, 'launch.err.log')
    if (existsSync(errFile)) {
      const t = readFileSync(errFile, 'utf8').split('\n').filter(Boolean).slice(-40)
      out.push('', '--- 启动 stderr（launch.err.log 末 40 行）---')
      out.push(t.length ? scrub(t.join('\n')) : '(空)')
    }
  } catch { /* ignore */ }

  out.push('', '=== 结束 ===')
  return out.join('\n')
}
