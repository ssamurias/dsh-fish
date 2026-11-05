// 「升级自检」：判断正在跑的这一份，跟你在源目录里放的那一份，是不是同一个版本。
//
// 为什么需要它（2026-10-29 房客 0.7.2 升级失败）：
//   profile 里写 `"dsh-fish": "file:D:/DSH/plugins-src/dsh-fish"` 时，pnpm 会往
//   node_modules\dsh-fish 落一份**独立副本**。很多人升级的做法是 robocopy 覆盖源目录，
//   然后重启——跑起来的还是 node_modules 里那份旧的。现象是「升了但没变」，
//   没有报错、没有日志，因为插件压根没重新加载，新代码根本没执行到。
//
// 这个模块只做一件事：找到 profile 里那条 `file:` 依赖指向的目录，读它的 package.json 版本，
// 和正在跑的 VERSION 比一比。读不到就安静跳过——不许因为查这个把启动搞砸。
//
// 零依赖；纯读文件，不写、不联网。

import { readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** npm 包名（= 插件 `export const name`）。 */
export const PKG_NAME = 'dsh-fish'

/**
 * 能认的包名，新名在前（2026-11-05 改名 @ssamurias/dsh-fish 之后）。
 *
 * 老 profile 里那条依赖的键可能还叫 `dsh-fish`：`link:` 装的用户不会因为换名字
 * 自动改键，所以两边的键都要认，否则升级自检会安静地跳过（= 用户以为升了其实没升）。
 */
export const PKG_NAMES = ['@ssamurias/dsh-fish', PKG_NAME]

const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies']

/**
 * 自己这一份的 package.json 路径。
 * 从模块 URL 往上两级：`<pkg>/lib/index.js` → `<pkg>/package.json`。
 */
export function runningPkgFile(moduleUrl = import.meta.url) {
  try {
    return join(dirname(dirname(fileURLToPath(moduleUrl))), 'package.json')
  } catch {
    return ''
  }
}

/** 版本比较：只认 `x.y.z[-pre]`；其它形状一律当「比不出来」返回 0。 */
export function compareVersion(a, b) {
  const parse = (v) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v ?? '').trim())
    if (!m) return null
    return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? '' }
  }
  const x = parse(a)
  const y = parse(b)
  if (!x || !y) return 0
  for (let i = 0; i < 3; i += 1) {
    if (x.nums[i] !== y.nums[i]) return x.nums[i] > y.nums[i] ? 1 : -1
  }
  // 有预发布号的比没有的旧（1.0.0-rc.1 < 1.0.0）
  if (x.pre === y.pre) return 0
  if (!x.pre) return 1
  if (!y.pre) return -1
  return x.pre > y.pre ? 1 : -1
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return null
  }
}

/** `<home>/.dsh/profiles` 下的 profile 目录（可用 DSH_FISH_PROFILES 覆盖，主要给测试用）。 */
export function profileDirs({ home = homedir(), env = process.env } = {}) {
  const base = env.DSH_FISH_PROFILES || join(home, '.dsh', 'profiles')
  try {
    return readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(base, d.name))
  } catch {
    return []
  }
}

/** 从 profile 的 package.json 里取 `file:` 依赖指向的目录（绝对化）。 */
export function fileDepDir(profileDir, pkg) {
  for (const field of DEP_FIELDS) {
    // 两个键都看：只有 `file:` 的才算（`link:` 是源码直连，不走这套自检）
    const spec = PKG_NAMES.map((n) => pkg?.[field]?.[n]).find(
      (s) => typeof s === 'string' && s.startsWith('file:'),
    )
    if (typeof spec !== 'string') continue
    const raw = spec.slice('file:'.length).trim()
    if (!raw) return ''
    // `file:D:/x`、`file:/x`、`file:../../x` 三种都要认。
    // `D:/x` 在 POSIX 上不算绝对路径（CI 跑 Linux 会把它拼到 profile 后面），所以盘符单独判：
    // 这个值是用户写在 profile 里的，跨平台读出来也得认。
    if (/^[A-Za-z]:[\\/]/.test(raw)) return process.platform === 'win32' ? resolve(raw) : raw.replace(/\\/g, '/')
    return isAbsolute(raw) ? resolve(raw) : resolve(profileDir, raw)
  }
  return ''
}

/**
 * @param {object} opts
 * @param {string} opts.version   正在跑的版本（插件里的 VERSION）
 * @param {string} [opts.pkgFile] 自己这一份 package.json（默认从 import.meta.url 推）
 * @param {string} [opts.profilesDir] profile 根目录（默认 ~/.dsh/profiles）
 * @param {string} [opts.home]
 * @param {object} [opts.env]
 * @returns {Promise<{ok:boolean,stale:boolean,skipped?:boolean,running:string,source:string,sourcePath:string,profile:string,why:string}>}
 */
export async function checkUpgrade({ version = '', pkgFile = '', profilesDir = '', home, env } = {}) {
  const running = String(version ?? '') || String((await readJson(pkgFile || runningPkgFile()))?.version ?? '')
  const base = { ok: false, stale: false, running, source: '', sourcePath: '', profile: '', why: '' }

  const dirs = profilesDir ? [profilesDir] : profileDirs({ home, env })
  if (!dirs.length) return { ...base, skipped: true, why: '没找到 profile 目录，跳过' }

  const seen = []
  const hits = []
  for (const dir of dirs) {
    const pkg = await readJson(join(dir, 'package.json'))
    const srcDir = fileDepDir(dir, pkg)
    if (!srcDir) continue
    seen.push(srcDir)
    const srcPkg = await readJson(join(srcDir, 'package.json'))
    const srcVersion = String(srcPkg?.version ?? '')
    if (!srcVersion) continue
    // 这个 profile 装进去的那份是哪个版本？跟正在跑的相等，说明这条依赖就是「当前这条命」。
    // 一台机器可能有 web / desktop 两个 profile，各自钉着不同的源目录，不能随手抓第一个。
    // 名字不同，node_modules 里的目录也就不同（scoped 装法多一层 @ssamurias/）
    let installed = ''
    for (const n of PKG_NAMES) {
      installed = String((await readJson(join(dir, 'node_modules', n, 'package.json')))?.version ?? '')
      if (installed) break
    }
    hits.push({ dir, srcDir, srcVersion, installed })
  }

  if (!hits.length) {
    if (seen.length) {
      return { ...base, skipped: true, sourcePath: seen[0], why: '源目录里读不到 package.json 版本' }
    }
    return { ...base, skipped: true, why: '没有找到 file: 安装的源目录（可能是从 npm 或软链装的）' }
  }

  // 优先取「装进去的那份 == 正在跑的版本」那条：它才是此刻真正加载的来源。
  const pick = hits.find((h) => h.installed && h.installed === running) ?? hits[0]

  // 源目录跟正在跑的同一份（软链/直接跑源目录）——没什么可提醒的。
  if (pick.srcVersion === running) {
    return { ...base, ok: true, source: pick.srcVersion, sourcePath: pick.srcDir, profile: pick.dir }
  }
  if (compareVersion(pick.srcVersion, running) > 0) {
    return {
      ...base,
      ok: true,
      stale: true,
      source: pick.srcVersion,
      sourcePath: pick.srcDir,
      profile: pick.dir,
      why: `源目录里是 ${pick.srcVersion}，正在跑的却是 ${running}`,
    }
  }
  // 源目录比正在跑的旧：可能是「已经装好了，源目录还是旧的」，但同样值得知道。
  return {
    ...base,
    ok: true,
    stale: true,
    older: true,
    source: pick.srcVersion,
    sourcePath: pick.srcDir,
    profile: pick.dir,
    why: `正在跑的是 ${running}，源目录里还是旧的 ${pick.srcVersion}`,
  }
}
