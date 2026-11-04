/**
 * 宿主版本自检（2026-10-30 m03193）
 *
 * 市场惯例（扫本机 ~/.dsh/profiles/*\/node_modules 得出）：插件在 package.json 里写
 *   "engines": { "dsh": ">=0.2.0-rc.1 <0.3.0-0" }
 * 宿主安装/检查时读这个键，把不满足的项按 `engines.dsh` 报出来。这里的常量必须和
 * package.json 里那条**一字不差**，test/hostver.test.mjs 会盯着它们不分叉。
 *
 * 运行时再对一次账：宿主版本不在范围内时只留话、不拒绝启动——旧版本里大部分功能
 * 仍然能用，硬拒会把人挡在门外，而这条信息本来就该由人自己判断。
 *
 * 零依赖：只用 node:fs / node:path / node:url，加上同目录的版本比较。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareVersion } from './upgrade.js'

/** 支持范围。改这里必须同步改 package.json 的 engines.dsh。 */
export const SUPPORTED_RANGE = '>=0.2.0-rc.1 <0.3.0-0'

/** 宿主包名：桌面版是 dsh-desktop-runtime，Web/headless 是 dsh。 */
const HOST_PKGS = ['@deepseek-ai/dsh', '@deepseek-ai/dsh-desktop-runtime']

/**
 * 从插件自己的位置往上找宿主的 package.json。
 * 插件装在 profile 的 node_modules 下，宿主也在同一棵树里；桌面版则挂在 app.asar 内，
 * 往上找必然扑空——这时退一步去读安装目录里的那份（见 readHostVersionFromAsar）。
 *
 * @param {{start?: string, exists?: Function, read?: Function, pkgNames?: string[], resourcesPath?: string}} [opts]
 * @returns {{version: string, pkg: string, file: string} | null}
 */
export function readHostVersion({ start, exists = existsSync, read = readFileSync, pkgNames = HOST_PKGS, resourcesPath } = {}) {
  let dir
  try {
    dir = resolve(start ?? dirname(fileURLToPath(import.meta.url)))
  } catch {
    return null
  }
  for (let i = 0; i < 8; i += 1) {
    for (const pkg of pkgNames) {
      const file = join(dir, 'node_modules', pkg, 'package.json')
      if (!exists(file)) continue
      try {
        const j = JSON.parse(read(file, 'utf8'))
        if (typeof j?.version === 'string' && j.version.trim()) {
          return { version: j.version.trim(), pkg, file }
        }
      } catch {
        // 坏 json：继续往上找，不因为一个坏文件判死
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return readHostVersionFromAsar({ exists, read, resourcesPath })
}

/**
 * 桌面版的宿主装进 app.asar，插件那一侧往上找永远找不着（issue #20 第 ④ 条）。
 *
 * Electron 里 `process.resourcesPath` 指向安装目录的 resources/，宿主就在
 * `resources/app.asar/dsh/package.json`——2026-11-04 真机核过：
 * `@deepseek-ai/dsh-desktop-runtime` / `0.2.1-rc.5`，普通 fs 读得到（asar 由 Electron 打补丁）。
 *
 * 只在往上找失败后才走这里，并且**只认 dsh 系的包名**：那个位置万一被别的应用占了，
 * 读出来的版本号会张冠李戴，比读不到更糟（读不到只是 unknown，读错会误判 older/newer）。
 *
 * @param {{exists?: Function, read?: Function, resourcesPath?: string}} [opts]
 * @returns {{version: string, pkg: string, file: string} | null}
 */
export function readHostVersionFromAsar({ exists = existsSync, read = readFileSync, resourcesPath } = {}) {
  const base = String(resourcesPath ?? (typeof process !== 'undefined' ? process.resourcesPath : '') ?? '')
  if (!base) return null
  const candidates = [
    join(base, 'app.asar', 'dsh', 'package.json'),
    join(base, 'app.asar.unpacked', 'dsh', 'package.json'),
  ]
  for (const file of candidates) {
    try {
      if (!exists(file)) continue
      const j = JSON.parse(read(file, 'utf8'))
      const name = String(j?.name ?? '')
      const version = typeof j?.version === 'string' ? j.version.trim() : ''
      if (!version || !/^@deepseek-ai\/dsh(?:$|-)/.test(name)) continue
      return { version, pkg: name, file }
    } catch {
      // 读不动就当这条路不通，继续试下一条；两条都不通按 unknown 处理
    }
  }
  return null
}

/**
 * 只认 `>=X <Y` 这种两头写法（我们自己发射的范围就是这个形状），
 * 解析不出来就给空串，交给 checkHost 当 unknown。
 *
 * @param {string} range
 * @returns {{min: string, max: string}}
 */
export function parseRange(range) {
  const s = String(range ?? '')
  const VER = 'v?(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)'
  const minM = new RegExp(`>=\\s*${VER}`).exec(s) ?? new RegExp(`\\^\\s*${VER}`).exec(s)
  const maxM = new RegExp(`<\\s*${VER}`).exec(s)
  return { min: minM ? minM[1] : '', max: maxM ? maxM[1] : '' }
}

/**
 * 判定宿主版本是否在我们声明过的范围里。
 *
 * status：supported / older / newer / unknown。ok 只在 supported 时为真。
 *
 * @param {{version?: string, range?: string}} [opts]
 * @returns {{ok: boolean, status: string, version: string, range: string, why: string}}
 */
export function checkHost({ version, range = SUPPORTED_RANGE } = {}) {
  const v = String(version ?? '').trim()
  if (!v) {
    return { ok: false, status: 'unknown', version: '', range, why: '没找到宿主版本号（桌面版把宿主装进 app.asar，读不到）' }
  }
  if (!/^\d+\.\d+\.\d+/.test(v)) {
    return { ok: false, status: 'unknown', version: v, range, why: `宿主版本号看不懂：${v}` }
  }
  const { min, max } = parseRange(range)
  if (min && compareVersion(v, min) < 0) {
    return { ok: false, status: 'older', version: v, range, why: `这个宿主（${v}）比支持的下限 ${min} 还旧` }
  }
  if (max && compareVersion(v, max) >= 0) {
    return { ok: false, status: 'newer', version: v, range, why: `这个宿主（${v}）超出了支持的上限 ${max}` }
  }
  if (!min && !max) {
    return { ok: false, status: 'unknown', version: v, range, why: `支持范围看不懂：${range}` }
  }
  return { ok: true, status: 'supported', version: v, range, why: '' }
}
