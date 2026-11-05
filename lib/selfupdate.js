/**
 * selfupdate.js —— 从「有新版」走到「装上了新版」（2026-10-29 用户要求）
 *
 * 为什么加这一步（用户 m00203）：插件发在 GitHub 上，而应用市场的索引要等半天到一天
 * 才更新。也就是说「作者已经发了新版」和「用户能看到新版」之间隔着十几个小时。
 * 检查更新已经能告诉他「有新版」，但接下来还得让他自己去浏览器下载、手动替换目录——
 * 那不是普通用户能做完的事。所以这里补上：确认 → 下载 → 校验 → 安装。
 *
 * 六条约束（全部来自踩过的坑，见避坑指南 §0 铁律 3 / §3.1–3.3）：
 *
 *   1. **绝不在应用运行时替换自己。** 插件代码就在宿主进程里跑着，运行中换包会
 *      `ERR_PNPM_EPERM`，包目录还能被留成"已删除"，下次启动直接缺包。
 *      所以安装动作只能交给一个**应用退出之后**才动手的外部脚本，插件自己只写脚本、
 *      起脚本、然后等着被杀。
 *   2. **每一步都要用户点头。** 检查更新只显示「有新版」；下载是第二次点击（并 confirm）；
 *      安装是第三次点击（再 confirm 一次，明确写着会关掉应用）。没有任何一步是自动发生的。
 *   3. **下载失败/超时必须是能读的中文、能重试、不动既有安装。** 超时按「单源 25 秒、
 *      整批 60 秒」两级预算；一个源失败换下一个（GitHub 直连在国内时通时不通）；
 *      全失败就如实报出来，`.part` 半截文件清掉，磁盘上不会留下一个看起来像安装包的东西。
 *   4. **装之前先验内容。** 不看 HTTP 状态码，看**真的解开来**：gzip → tar 头扫描，
 *      取 `package/package.json` 的 name/version，还要求 `lib/index.js` 在场。
 *      版本对不上、包名不对、解不开，一律不装。这样即便镜像回了半截文件也能拦住。
 *   5. **只升级"被管理的"安装。** 依赖写成 `link:` / `file:` 的是开发版（作者本机就是这样），
 *      升级它等于把作者的源码目录换成下载包——绝对不能干。那种情况如实说「这是开发版，不走自动升级」。
 *   6. **地址全部硬编码、不落盘多余东西。** 源只有 codeload 和两个镜像前缀，绝不接受
 *      客户端传 URL（否则就是 SSRF 口子）。下载文件只落在数据目录 `updates/` 里。
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { REPO, normalizeVersion } from './update.js'

/**
 * 包名：既用于 tar 里的校验，也用于 profile 里找依赖条目。
 *
 * 2026-11-05 起走 npm 的 scoped 全名（`dsh-fish` 这个裸名被别的账号占了，
 * 见 `market/` 那次排查）。老用户 profile 里还留着 `dsh-fish` 那条，所以
 * 读依赖时两个名字都认（见 `readDependency`）。
 */
export const PKG = '@ssamurias/dsh-fish'
/** npm 上的老名字（别人占的那条），只为兼容老安装去读它，**绝不往里装**。 */
export const LEGACY_PKG = 'dsh-fish'
/** tarball 文件名里不带 scope：`dsh-fish-0.8.10.tgz`。 */
const TARBALL_BASE = 'dsh-fish'

/**
 * 单源超时 / 整批预算（毫秒）。
 * 25 秒是给"能连但很慢"的镜像留的余量；60 秒是用户能忍的上限——
 * 再久他会以为页面卡死了，不如早点说失败并让他重试。
 */
export const PER_SOURCE_TIMEOUT_MS = 25_000
export const BUDGET_MS = 60_000

/** 包大小上限：正常 tarball 已经压到几 MB，64MB 是防止被喂一个无底洞。 */
export const MAX_TARBALL_BYTES = 64 * 1024 * 1024
/** 解开后的上限：防 gzip 炸弹（一个几 KB 的包解出几百 MB）。 */
export const MAX_UNPACKED_BYTES = 96 * 1024 * 1024

/** `v0.6.14` / `0.6.14` → `0.6.14`；认不出返回空串。 */
export function cleanVersion(v) {
  return normalizeVersion(v)
}

/**
 * 下载地址：npm registry 的 tarball，加一个国内镜像。
 * 顺序＝官方 registry 优先，失败再走 npmmirror（镜像同步有几十秒到几分钟的滞后，
 * 所以只在官方不行时用）。
 *
 * 为什么不再用 GitHub 的 tag tarball（2026-11-05 改）：装了哪个版本，取决于
 * **npm 上发了哪个版本**——GitHub 的 tag 可能忘了打，codeload 在国内又时通时不通。
 * npm 的 tarball 就是 `pnpm add` 会拉的那一份，下载下来验过等于"这次装的一定是对的"。
 */
export function sourcesFor(version) {
  const v = cleanVersion(version)
  if (!v) return []
  const file = `${TARBALL_BASE}-${v}.tgz`
  return [
    { name: 'npm 官方源', url: `https://registry.npmjs.org/${PKG}/-/${file}` },
    { name: 'npmmirror 镜像', url: `https://registry.npmmirror.com/${PKG}/-/${file}` },
  ]
}

/**
 * 安装用的 spec。
 * 用版本号而不是 `file:` —— `pnpm add file:…tgz` 会把 profile 里的依赖写成
 * `file:updates/xxx.tgz`，下次升级时 `classifySpec` 会把它当开发版而拒绝升级，
 * 而且那个路径本身是临时目录。写成 `@ssamurias/dsh-fish@x.y.z` 才是一条能一直往上走的记录。
 */
export function specFor(version) {
  return `${PKG}@${cleanVersion(version)}`
}

/** 下载到本地用的文件名。带上版本，同一份数据目录里留着几版也不会混。 */
export function fileNameFor(version) {
  // 文件名里不能带 scope 的 `/`，用不带 scope 的基名。
  return `${TARBALL_BASE}-v${cleanVersion(version)}.tgz`
}

/**
 * profile 里那条依赖属于哪种情况？
 *   local    —— `link:` / `file:`（开发版，作者本机）；升级它会把源码换成下载包，禁止
 *   github   —— `github:...#tag`：正常用户从 GitHub 装的那种，可以升级
 *   registry —— 版本号/`^1.2.3`：从 npm registry 装的，也能升级（但改用同一套 spec 会变成 github 源）
 *   missing  —— profile 里没有这条依赖（比如插件是被手动放进 node_modules 的）
 *
 * 认不出的一律当"不归我管"，不猜。
 */
export function classifySpec(spec) {
  const s = String(spec ?? '').trim()
  if (!s) return 'missing'
  if (/^(link|file):/i.test(s)) return 'local'
  if (/^github:/i.test(s)) return 'github'
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return 'other'
  return 'registry'
}

/**
 * 从模块自己的路径反推 profile 目录。
 *
 * 安装成 `github:` / registry 时，文件真身就在 `<profile>/node_modules/dsh-fish/lib/...`；
 * 装成 `link:` 时 realpath 会落在源码目录（不含 node_modules）——那种情况返回空串，
 * 上层据此判定为开发版、拒绝自动升级。
 */
export function profileDirOf(moduleUrl) {
  let file = ''
  try {
    file = fileURLToPath(moduleUrl).replace(/\\/g, '/')
  } catch {
    return ''
  }
  // 新装法（npm scoped）落在 `node_modules/@ssamurias/dsh-fish/`，老装法在 `node_modules/dsh-fish/`。
  // 两种都要认得，否则从 0.8.9 之前装上来的用户会被当成"没有 profile → 开发版"而永远升不了级。
  for (const marker of [`/node_modules/${PKG}/`, `/node_modules/${LEGACY_PKG}/`]) {
    const i = file.lastIndexOf(marker)
    if (i >= 0) return file.slice(0, i)
  }
  return ''
}

/**
 * 读 profile/package.json，返回那条依赖的 spec（读不到给空串）。
 * 先认新包名，再退回老包名——老用户 profile 里只有 `dsh-fish` 那一条。
 */
export function readDependency(profileDir) {
  try {
    const json = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
    const deps = { ...(json?.dependencies ?? {}), ...(json?.devDependencies ?? {}) }
    for (const name of [PKG, LEGACY_PKG]) {
      const spec = deps[name]
      if (spec) return String(spec)
    }
    return ''
  } catch {
    return ''
  }
}

/** 解码 + 扫描 tar 头，取出包名、版本、是否带 lib/index.js。认不出就抛。 */
export function inspectPackage(bytes, { name = PKG, version = '' } = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw err('EMPTY', '下载到的文件是空的')
  if (bytes.length > MAX_TARBALL_BYTES) throw err('TOO_BIG', `下载到的文件太大（${bytes.length} 字节）`)

  let raw
  try {
    raw = zlib.gunzipSync(bytes, { maxOutputLength: MAX_UNPACKED_BYTES })
  } catch (e) {
    // 半截文件、HTML 错误页、被代理改过的内容都会在这里失败。
    throw err('NOT_GZIP', `不是有效的压缩包（${e?.message ?? e}）`)
  }

  let name0 = ''
  let version0 = ''
  let hasIndex = false
  let seen = 0
  const files = []
  for (let off = 0; off + 512 <= raw.length;) {
    const head = raw.subarray(off, off + 512)
    // 全 0 块＝归档结束（tar 惯例两块，有一块就够判断）
    if (head.every((b) => b === 0)) break
    const fname = cstr(head.subarray(0, 100))
    const prefix = cstr(head.subarray(345, 500))
    const size = octal(head.subarray(124, 136))
    const type = String.fromCharCode(head[156] || 48)
    const full = prefix ? `${prefix}/${fname}` : fname
    const body = off + 512
    if (body + size > raw.length) throw err('TRUNCATED', '压缩包是半截的（内容长度不够）')
    seen += 1
    if (seen > 20_000) throw err('TOO_MANY', '压缩包里文件太多，不像这个插件')
    // 只关心「根目录/package.json」和「根目录/lib/index.js」，多套一层前缀也认。
    const m = full.match(/^([^/]+)\/(package\.json|lib\/index\.js)$/)
    if (m && type !== '5') {
      files.push(m[2])
      if (m[2] === 'package.json') {
        try {
          const j = JSON.parse(raw.subarray(body, body + size).toString('utf8'))
          if (j && typeof j === 'object') {
            name0 = String(j.name ?? '')
            version0 = String(j.version ?? '')
          }
        } catch {
          throw err('BAD_JSON', '包里的 package.json 读不出来')
        }
      } else if (m[2] === 'lib/index.js') {
        hasIndex = true
      }
    }
    off = body + Math.ceil(size / 512) * 512
  }

  if (!name0) throw err('NO_PACKAGE_JSON', '压缩包里没有 package/package.json')
  if (name0 !== name) throw err('WRONG_PACKAGE', `这个包不是 ${name}（是 ${name0}）`)
  if (!hasIndex) throw err('NO_ENTRY', '压缩包里没有 lib/index.js，不像是能用的插件')
  const want = cleanVersion(version)
  if (want && cleanVersion(version0) !== want) {
    throw err('WRONG_VERSION', `包里的版本是 ${version0 || '空'}，不是要的 ${want}`)
  }
  return { name: name0, version: version0, files }
}

function err(code, message) {
  const e = new Error(message)
  e.code = code
  return e
}

function cstr(buf) {
  const i = buf.indexOf(0)
  return Buffer.from(i < 0 ? buf : buf.subarray(0, i)).toString('utf8').replace(/\/+$/, '')
}

function octal(buf) {
  const s = Buffer.from(buf).toString('ascii').replace(/[\0 ]+$/, '').trim()
  const n = parseInt(s, 8)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

/**
 * 下载一个版本的 tarball 到 `dir/文件名.part`，校验通过才改名成正式文件。
 * 任何失败都清掉半截文件，不留"看起来像安装包"的东西。
 *
 * @returns {Promise<{ok:true, file:string, bytes:number, source:string} | {ok:false, error:string, tried:string[]}>}
 */
export async function downloadTarball({
  version,
  dir,
  fetchImpl = globalThis.fetch,
  perSourceTimeoutMs = PER_SOURCE_TIMEOUT_MS,
  budgetMs = BUDGET_MS,
  onProgress = () => {},
  sources = null,
} = {}) {
  const v = cleanVersion(version)
  if (!v) return { ok: false, error: '版本号认不出来', tried: [] }
  // 地址默认由版本号重算（硬编码），测试里可以显式传一组本地地址。
  const list = Array.isArray(sources) && sources.length ? sources : sourcesFor(v)
  if (!list.length) return { ok: false, error: '没有可用的下载地址', tried: [] }
  if (typeof fetchImpl !== 'function') return { ok: false, error: '这个环境里没有 fetch，下载不了', tried: [] }
  const progress = typeof onProgress === 'function' ? onProgress : () => {}

  const dest = path.join(dir, fileNameFor(v))
  const part = `${dest}.part`
  await fsp.mkdir(dir, { recursive: true })

  const tried = []
  const deadline = Date.now() + Math.max(5_000, Number(budgetMs) || BUDGET_MS)

  for (const src of list) {
    const left = deadline - Date.now()
    if (left <= 0) {
      tried.push('（整批超时）')
      break
    }
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), Math.min(left, perSourceTimeoutMs))
    try {
      const res = await fetchImpl(src.url, {
        signal: ctrl.signal,
        redirect: 'follow',
        headers: { accept: 'application/gzip, application/octet-stream', 'user-agent': `dsh-fish-selfupdate/${v}` },
      })
      if (!res || !res.ok) throw new Error(`返回 ${res ? res.status : '没有响应'}`)
      const len = Number(res.headers?.get?.('content-length') ?? 0) || 0
      if (len > MAX_TARBALL_BYTES) throw new Error(`文件太大（${len} 字节）`)

      const chunks = []
      let got = 0
      if (res.body && typeof res.body[Symbol.asyncIterator] === 'function') {
        for await (const chunk of res.body) {
          const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          got += b.length
          if (got > MAX_TARBALL_BYTES) throw new Error('文件太大')
          chunks.push(b)
          progress({ bytes: got, total: len })
        }
      } else {
        const b = Buffer.from(await res.arrayBuffer())
        got = b.length
        chunks.push(b)
        progress({ bytes: got, total: len })
      }
      const buf = Buffer.concat(chunks)
      // 先验内容，再落盘：验不过的东西不该在磁盘上留下任何痕迹。
      inspectPackage(buf, { version: v })
      await fsp.writeFile(part, buf)
      await fsp.rename(part, dest)
      return { ok: true, file: dest, bytes: buf.length, source: src.name }
    } catch (e) {
      tried.push(`${src.name}：${describeFetchError(e, perSourceTimeoutMs)}`)
      try { await fsp.rm(part, { force: true }) } catch { /* ignore */ }
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    ok: false,
    error: `这个版本没能下载成功。${tried.join('；')}。过一会儿再试一次，或者开一下网络工具。`,
    tried,
  }
}

function describeFetchError(e, ms) {
  const name = e?.name ?? ''
  if (name === 'AbortError' || /aborted/i.test(String(e?.message ?? ''))) return `等了 ${Math.round(ms / 1000)} 秒没下完`
  return String(e?.message ?? e)
}

/**
 * 生成安装脚本（Windows .cmd）。
 *
 * 脚本里的每一步都写成"失败就回滚"，因为它是**唯一**能改 profile 的环节，
 * 而那时应用已经关了——出错没人能救场，只能靠脚本自己退回去。
 * 日志一律英文：cmd 默认代码页是 GBK，中文写进去在日志里会是乱码。
 */
export function scriptFor({
  version,
  profileDir,
  exe,
  nodeBin,
  pnpmScript,
  logFile,
  backupDir,
  hostName,
  tarball = '',
  normalizePath = '',
} = {}) {
  const v = cleanVersion(version)
  if (!v) throw new Error('版本号认不出来')
  if (!profileDir) throw new Error('找不到 profile 目录')
  if (!exe) throw new Error('找不到应用路径')
  // 有应用自带的 node + pnpm.mjs 就直连（不依赖 PATH 里装没装 pnpm）；
  // 没有就退回 PATH 上的 pnpm —— 用户机器上装过 pnpm 也能跑。
  const pnpmCmd = nodeBin && pnpmScript ? `"${nodeBin}" "${pnpmScript}"` : 'pnpm'
  const q = (s) => String(s ?? '')
  // 从 npm 装（2026-11-05 改）。`tarball` 这一版只当"已经验过这个版本确实存在"的凭据，
  // **不再用 `file:` 装**——`pnpm add file:…tgz` 会把依赖写成 `file:updates/xxx.tgz`，
  // 下次升级时 classifySpec 会把它当开发版直接拒绝，而且那条路径本身是临时目录。
  // 写成 `@ssamurias/dsh-fish@x.y.z` 才是一条能一直往上走的记录。
  const specArg = specFor(v)
  const modDir = PKG.replace('/', '\\\\')

  return [
    '@echo off',
    'chcp 65001 >nul',
    'setlocal enableextensions',
    `set "LOG=${q(logFile)}"`,
    `set "BK=${q(backupDir)}"`,
    `set "PROFILE=${q(profileDir)}"`,
    `echo. >> "%LOG%"`,
    `echo ==== dsh-fish self-update to v${v} ==== >> "%LOG%"`,
    'echo [1/6] wait for host to exit >> "%LOG%"',
    'rem wait 2s so the HTTP reply reaches the UI before the host dies',
    'timeout /t 2 /nobreak >nul',
    `taskkill /F /IM "${q(hostName)}" >> "%LOG%" 2>&1`,
    'set /a N=0',
    ':waitloop',
    'set /a N+=1',
    `tasklist /FI "IMAGENAME eq ${q(hostName)}" 2>nul | find /I "${q(hostName)}" >nul`,
    'if errorlevel 1 goto exited',
    'if %N% GEQ 60 goto exittimeout',
    'timeout /t 1 /nobreak >nul',
    'goto waitloop',
    ':exittimeout',
    'echo [1/6] host still running after 60s - abort, nothing changed >> "%LOG%"',
    'goto relaunch',
    ':exited',
    'echo [2/6] host exited >> "%LOG%"',
    'mkdir "%BK%" 2>nul',
    'copy /Y "%PROFILE%\\package.json" "%BK%\\package.json" >nul 2>&1',
    'copy /Y "%PROFILE%\\pnpm-lock.yaml" "%BK%\\pnpm-lock.yaml" >nul 2>&1',
    `if exist "%PROFILE%\\\\node_modules\\\\${modDir}" (`,
    '  if not exist "%BK%\\\\pkg" mkdir "%BK%\\\\pkg"',
    `  xcopy /E /I /H /Y "%PROFILE%\\\\node_modules\\\\${modDir}" "%BK%\\\\pkg" >> "%LOG%" 2>&1`,
    ')',
    'cd /d "%PROFILE%"',
    `echo [3/6] install ${specArg} >> "%LOG%"`,
    `${pnpmCmd} add "${specArg}" --config.minimumReleaseAge=0 >> "%LOG%" 2>&1`,
    'if errorlevel 1 goto rollback',
    'echo [4/6] verify installed version >> "%LOG%"',
    `"${q(nodeBin) || 'node'}" -e "const p=require('./node_modules/${PKG}/package.json');if(p.version!=='${v}'){console.error('got '+p.version);process.exit(3)}" >> "%LOG%" 2>&1`,
    'if errorlevel 1 goto rollback',
    ...(normalizePath
      ? [
        'echo [5/6] normalize profile (legacy dep/bundle) >> "%LOG%"',
        `"${q(nodeBin) || 'node'}" "${q(normalizePath)}" "%PROFILE%" "${PKG}" >> "%LOG%" 2>&1`,
        'echo [5/6] normalize exit %errorlevel% >> "%LOG%"',
      ]
      : []),
    'echo [6/6] installed OK >> "%LOG%"',
    'goto relaunch',
    ':rollback',
    'echo [4/6] FAILED - rolling back to the previous copy >> "%LOG%"',
    'copy /Y "%BK%\\package.json" "%PROFILE%\\package.json" >nul 2>&1',
    'copy /Y "%BK%\\pnpm-lock.yaml" "%PROFILE%\\pnpm-lock.yaml" >nul 2>&1',
    'if exist "%BK%\\\\pkg" (',
    `  rmdir /S /Q "%PROFILE%\\\\node_modules\\\\${modDir}" >> "%LOG%" 2>&1`,
    `  xcopy /E /I /H /Y "%BK%\\\\pkg" "%PROFILE%\\\\node_modules\\\\${modDir}" >> "%LOG%" 2>&1`,
    ')',
    `cd /d "%PROFILE%"`,
    `${pnpmCmd} install --config.minimumReleaseAge=0 >> "%LOG%" 2>&1`,
    'echo [4/6] rollback done >> "%LOG%"',
    ':relaunch',
    'echo [6/6] restart host >> "%LOG%"',
    `start "" "${q(exe)}"`,
    'exit /b 0',
    '',
  ].join('\r\n')
}

/**
 * 升级后"收拾现场"的一次性脚本（Node CJS，由安装脚本调用）。
 *
 * 为什么必须有这一步（2026-11-05）：0.8.9 之前包名是裸的 `dsh-fish`，
 * profile 的 dependencies 与 bundles 里记的也是裸名。改名后只 `pnpm add`
 * 新包，旧键会原地留着——node_modules 里于是同时有两条 fish，bundles 里
 * 还是旧的那条，两条 insert 撞同一个 id，web boot 抛
 * `duplicate factory registration` 直接崩。所以装完先把旧键、旧 bundle 条目清掉，
 * 再把旧的 node_modules 目录改名收起来（不删，留着能回退）。
 */
export function normalizeScript() {
  return [
    "'use strict'",
    "const fs = require('node:fs')",
    "const path = require('node:path')",
    "const profileDir = process.argv[2] || ''",
    "const pkg = process.argv[3] || ''",
    "const LEGACY = 'dsh-fish'",
    'if (!profileDir || !pkg) {',
    "  console.error('normalize: missing args')",
    '  process.exit(2)',
    '}',
    "const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)",
    "const file = path.join(profileDir, 'package.json')",
    "const json = JSON.parse(fs.readFileSync(file, 'utf8'))",
    'const done = []',
    "for (const field of ['dependencies', 'devDependencies']) {",
    '  const deps = json[field]',
    "  if (deps && typeof deps === 'object' && Object.prototype.hasOwnProperty.call(deps, LEGACY)) {",
    '    delete deps[LEGACY]',
    "    done.push('drop ' + field + '.' + LEGACY)",
    '  }',
    '}',
    'const prof = json.dsh && (json.dsh.profile || json.dsh)',
    'const bundles = prof && Array.isArray(prof.bundles) ? prof.bundles : null',
    'if (bundles) {',
    '  let n = 0',
    '  for (let i = bundles.length - 1; i >= 0; i -= 1) {',
    '    if (bundles[i] === LEGACY) { bundles.splice(i, 1); n += 1 }',
    '  }',
    "  if (n) done.push('drop bundles.' + LEGACY + ' x' + n)",
    "  if (!bundles.includes(pkg)) { bundles.push(pkg); done.push('add bundles.' + pkg) }",
    '}',
    'if (done.length) {',
    "  fs.copyFileSync(file, file + '.bak-normalize-' + stamp)",
    "  fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\\n', 'utf8')",
    "  done.push('wrote package.json')",
    '}',
    "const legacyDir = path.join(profileDir, 'node_modules', LEGACY)",
    'try {',
    '  if (fs.existsSync(legacyDir)) {',
    "    const target = legacyDir + '.disabled-' + stamp",
    '    fs.renameSync(legacyDir, target)',
    "    done.push('moved node_modules/' + LEGACY)",
    '  }',
    '} catch (e) {',
    "  done.push('move failed: ' + (e && e.code ? e.code : e))",
    '}',
    "console.log(done.length ? done.join('; ') : 'nothing to normalize')",
    '',
  ].join('\n')
}

/**
 * 找应用自带的 node 与 pnpm（`<应用目录>/resources/runtime/primary-runtime/dependencies/`）。
 *
 * 为什么不用 PATH 上的 pnpm：用户机器上很可能没装 pnpm —— 桌面版自带一份，
 * 用自带的就等于"用户不需要为升级做任何准备"。找不到才退回 PATH。
 */
export function runtimeBins({ exe = process.execPath, exists = fs.existsSync } = {}) {
  const appDir = path.dirname(String(exe ?? ''))
  const bases = [appDir, path.join(appDir, '..')]
  for (const base of bases) {
    const dep = path.join(base, 'resources', 'runtime', 'primary-runtime', 'dependencies')
    const nodeBin = path.join(dep, 'node', 'bin', 'node.exe')
    const pnpmScript = path.join(dep, 'pnpm', 'bin', 'pnpm.mjs')
    try {
      if (exists(nodeBin) && exists(pnpmScript)) return { nodeBin, pnpmScript }
    } catch { /* ignore */ }
  }
  return { nodeBin: '', pnpmScript: '' }
}

/**
 * 隐藏启动器（Windows .vbs）。
 *
 * 为什么还需要这一层（2026-11-05 用户 m00633）：之前直接 `spawn('cmd.exe', …, {detached:true})`，
 * Node 在 Windows 上给 detached 子进程另开一个控制台——用户会看到一个黑窗口，
 * 以为卡住了，而且那个窗口关不掉。实测 `windowsHide` 管不住它。
 * 改成 wscript 跑一句 `WScript.Shell.Run "cmd /c ""…""", 0, False`：
 * 窗口样式 0 = 完全不显示，脚本照样在跑、照样能杀掉宿主并重启。
 */
export function vbsFor(cmdPath) {
  // VBS 字符串里 `""` 表示一个引号。
  const inner = String(cmdPath ?? '').replace(/"/g, '""')
  return [
    "' dsh-fish self-update launcher",
    'Set sh = CreateObject("WScript.Shell")',
    `sh.Run "cmd /c ""${inner}""", 0, False`,
    'Set sh = Nothing',
    '',
  ].join('\r\n')
}

/**
 * 写脚本 + 起进程（detached，宿主被杀也不会带走它）。
 * 返回脚本路径，调用方负责把状态切到 installing。
 */
export async function armInstall({
  root,
  version,
  profileDir,
  exe,
  nodeBin,
  pnpmScript,
  spawnImpl = spawn,
  hostName,
  backupSuffix = '',
  tarball = '',
  platform = process.platform,
} = {}) {
  const v = cleanVersion(version)
  const dir = path.join(root, 'updates')
  await fsp.mkdir(dir, { recursive: true })
  const scriptPath = path.join(dir, `install-v${v}${backupSuffix}.cmd`)
  const logFile = path.join(dir, 'last.log')
  const backupDir = path.join(dir, `backup-v${v}${backupSuffix}`)
  const normalizePath = path.join(dir, 'normalize-package.cjs')
  await fsp.writeFile(normalizePath, normalizeScript(), 'utf8')
  const script = scriptFor({ version: v, profileDir, exe, nodeBin, pnpmScript, logFile, backupDir, hostName, tarball, normalizePath })
  // 无 BOM UTF-8：cmd 不认 BOM，带上反而会把第一行认成 `ï»¿@echo`。
  await fsp.writeFile(scriptPath, script, 'utf8')
  let child
  if (platform === 'win32') {
    const vbsPath = path.join(dir, `install-v${v}${backupSuffix}.vbs`)
    await fsp.writeFile(vbsPath, vbsFor(scriptPath), 'utf8')
    child = spawnImpl('wscript.exe', ['//B', '//Nologo', vbsPath], {
      cwd: root,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
  } else {
    child = spawnImpl('cmd.exe', ['/c', scriptPath], {
      cwd: root,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
  }
  if (child && typeof child.unref === 'function') child.unref()
  return { scriptPath, logFile, backupDir }
}

/** 读上次安装日志的末尾（只给界面看，不参与判断）。 */
export async function tailUpdateLog(file, maxLines = 12) {
  try {
    const text = await fsp.readFile(file, 'utf8')
    const lines = text.split(/\r?\n/).filter((l) => l.trim())
    return lines.slice(-maxLines).join('\n')
  } catch {
    return ''
  }
}

/**
 * 状态机 + 对外入口。
 *
 * 四个阶段：idle（还没下）→ downloading（在下的过程中）→ prepared（下完且验过）→ installing（脚本已起）。
 * 任何一步失败都进 failed，并带上**能读的中文原因**；failed 之后可以重新下载（回 downloading）。
 *
 * 这个对象是"每个插件实例一个"，不做持久化：应用一重启，之前下好的包就作废——
 * 留着的风险（磁盘上有个跟当前版本无关的包，之后被误装）比省一次下载大。
 */
export function createSelfUpdater({
  root,
  current = '',
  fetchImpl = globalThis.fetch,
  moduleUrl = import.meta.url,
  exe = process.execPath,
  nodeBin = '',
  pnpmScript = '',
  spawnImpl = spawn,
  downloadImpl = downloadTarball,
  now = () => Date.now(),
  platform = process.platform,
} = {}) {
  const dir = path.join(root, 'updates')
  let st = { phase: 'idle', version: '', error: '', bytes: 0, total: 0, source: '', note: '', file: '', startedAt: 0 }
  let running = false

  const snapshot = () => {
    const profileDir = profileDirOf(moduleUrl)
    const spec = profileDir ? readDependency(profileDir) : ''
    const kind = profileDir ? classifySpec(spec) : 'local'
    return {
      ...st,
      current: normalizeVersion(current) || String(current ?? ''),
      profileDir,
      kind,
      managed: kind === 'github' || kind === 'registry',
      canInstall: st.phase === 'prepared',
    }
  }

  async function start(version) {
    if (running) return { ok: false, error: '已经在下载了，等一下。' }
    const v = cleanVersion(version)
    if (!v) return { ok: false, error: '版本号认不出来' }
    const profileDir = profileDirOf(moduleUrl)
    const kind = profileDir ? classifySpec(readDependency(profileDir)) : 'local'
    if (!profileDir || kind === 'local') {
      return { ok: false, local: true, error: '这台机器上装的是开发版（依赖指向源码目录），不走自动下载。' }
    }
    running = true
    st = { ...st, phase: 'downloading', version: v, error: '', bytes: 0, total: 0, source: '', startedAt: now() }
    // 不 await：下载几十秒，界面靠 /update/status 轮询。
    ;(async () => {
      try {
        const r = await downloadImpl({
          version: v,
          dir,
          fetchImpl,
          onProgress: ({ bytes, total }) => {
            st = { ...st, bytes: Math.max(st.bytes, Number(bytes) || 0), total: Number(total) || st.total }
          },
        })
        if (!r.ok) {
          st = { ...st, phase: 'failed', error: r.error, note: '' }
          return
        }
        st = {
          ...st,
          phase: 'prepared',
          bytes: r.bytes,
          total: r.bytes,
          source: r.source,
          file: r.file ?? '',
          note: '已下载并校验通过，可以安装。',
        }
      } catch (e) {
        st = { ...st, phase: 'failed', error: `下载时出错了：${e?.message ?? e}` }
      } finally {
        running = false
      }
    })()
    return { ok: true, phase: 'downloading', version: v }
  }

  async function install(version) {
    const v = cleanVersion(version || st.version)
    if (!v) return { ok: false, error: '版本号认不出来' }
    if (st.phase !== 'prepared' || cleanVersion(st.version) !== v) {
      return { ok: false, error: '还没有下载好这一版，先下载再装。' }
    }
    const profileDir = profileDirOf(moduleUrl)
    if (!profileDir) return { ok: false, local: true, error: '开发版不走自动升级。' }
    // 安装脚本是 cmd 批处理（taskkill/tasklist/xcopy），只有 Windows 有。
    // 别的系统上先别给按钮：给了也只会生成一个跑不起来的脚本。
    if (platform !== 'win32') {
      return { ok: false, error: '自动安装目前只做了 Windows；这台机器请手动更新。' }
    }
    if (!exe || !/\.exe$/i.test(exe) || /^node(\.exe)?$/i.test(path.basename(exe))) {
      return { ok: false, error: '当前不是桌面版（没有可重开的 exe），请手动更新。' }
    }
    try {
      const armed = await armInstall({
        root,
        version: v,
        profileDir,
        exe,
        nodeBin,
        pnpmScript,
        spawnImpl,
        platform,
        hostName: path.basename(exe),
        // 装的是刚才下载并验过的那个包；文件留在 updates/ 里，之后 pnpm install 还要用。
        tarball: st.file,
      })
      st = { ...st, phase: 'installing', note: '正在关闭应用并在后台安装，装完会自动重开。' }
      return { ok: true, phase: 'installing', script: armed.scriptPath }
    } catch (e) {
      return { ok: false, error: `起安装脚本失败：${e?.message ?? e}` }
    }
  }

  return { status: snapshot, start, install, dir }
}
