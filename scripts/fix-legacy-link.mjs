#!/usr/bin/env node
/**
 * 把老的 `dsh-fish` 安装收拾到新包名（@ssamurias/dsh-fish）。
 *
 * 为什么需要它：0.8.10 起插件包名从 `dsh-fish` 改成 `@ssamurias/dsh-fish`，
 * 插件自带 cordis.patch.yml 里的条目名也跟着变成完整包名；而老 profile 的
 * node_modules 里只有裸名链接 `dsh-fish` → 条目 import 失败 → **宿主直接启动崩溃**。
 * 升级前跑一遍这个脚本就能避免；已经崩了也能跑（它只改 profile 文件，不需要应用启动）。
 *
 * 0.9.1 修（issue #43）：原来只认 `link:` / `file:` 两种依赖写法。可是按更新说明用
 * `dsh plugin add "@ssamurias/dsh-fish@0.9.0"` 升级的人，profile 里留下的是**版本号**，
 * 脚本一句「没有老依赖，跳过」就退出 0 —— 旧键 `dsh-fish` 与旧 bundles 条目原封不动，
 * 下次 pnpm 清理时两条 fish 打架。现在三种写法都收拾：源码目录、tgz、版本号/远端。
 *
 * 用法（先关掉 DeepSeek Harness）：
 *   node scripts/fix-legacy-link.mjs            # 预览
 *   node scripts/fix-legacy-link.mjs --write    # 真的改
 *   node scripts/fix-legacy-link.mjs --write --profile C:\Users\你\.dsh\profiles\desktop
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

export const NEW = '@ssamurias/dsh-fish'
export const LEGACY = 'dsh-fish'

const SPEC_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies']

export function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

/** profile 里那条老依赖：字段名 + 原样的 spec。没有就 null。 */
export function specOf(pkg) {
  for (const field of SPEC_FIELDS) {
    const spec = pkg?.[field]?.[LEGACY]
    if (typeof spec === 'string' && spec.trim()) return { field, spec: spec.trim() }
  }
  return null
}

/**
 * 这条 spec 指向什么？
 *   dir     —— `link:` / `file:` 指向目录（源码目录安装），要建 junction
 *   tarball —— `file:` 指向 .tgz（0.8.x 的临时包装法），只清账、不建链接
 *   spec    —— 版本号 / `^1.2.3` / `github:...`，只清账
 */
export function specKind(spec) {
  const s = String(spec ?? '').trim()
  if (!/^(link:|file:)/i.test(s)) return 'spec'
  return /\.(tgz|tar\.gz)$/i.test(s) ? 'tarball' : 'dir'
}

export function targetOf(profileDir, spec) {
  const raw = String(spec).replace(/^(link:|file:)/i, '').trim()
  if (!raw) return ''
  if (/^[A-Za-z]:[\\/]/.test(raw) || path.isAbsolute(raw)) return path.resolve(raw)
  return path.resolve(profileDir, raw)
}

export function linkName(profileDir, name) {
  return path.join(profileDir, 'node_modules', ...name.split('/'))
}

export function bundlesOf(pkg) {
  const prof = pkg?.dsh?.profile ?? (pkg?.dsh && Array.isArray(pkg.dsh.bundles) ? pkg.dsh : null)
  return prof && Array.isArray(prof.bundles) ? prof.bundles : null
}

/** 把老依赖从依赖表里清掉；新包名已经在装的话顺手对齐 bundles。 */
export function cleanDepKey(pkg, found, newName) {
  const done = []
  delete pkg[found.field][LEGACY]
  done.push(`删掉 ${found.field}["${LEGACY}"]`)
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
  if (deps[newName]) {
    const bundles = bundlesOf(pkg)
    if (bundles && !bundles.includes(newName)) {
      bundles.push(newName)
      done.push(`bundles 补上 ${newName}`)
    }
  }
  return done
}

export function dropLegacyBundle(pkg, newName) {
  const bundles = bundlesOf(pkg)
  if (!bundles) return []
  let n = 0
  for (let i = bundles.length - 1; i >= 0; i -= 1) {
    if (bundles[i] === LEGACY) {
      bundles.splice(i, 1)
      n += 1
    }
  }
  const done = n ? [`bundles 删掉 ${LEGACY} ×${n}`] : []
  if (newName && !bundles.includes(newName)) {
    bundles.push(newName)
    done.push(`bundles 补上 ${newName}`)
  }
  return done
}

export function retireOldLink(profileDir, tag, done = []) {
  const oldLink = linkName(profileDir, LEGACY)
  if (!fs.existsSync(oldLink)) return done
  const off = `${oldLink}.disabled-${tag}`
  try {
    fs.renameSync(oldLink, off)
    done.push(`node_modules/${LEGACY} 改名停用`)
  } catch (e) {
    done.push(`node_modules/${LEGACY} 改名失败：${e?.code ?? e?.message ?? e}`)
  }
  return done
}

/**
 * 收拾一个 profile。返回 { changed, done, notes }。
 * `write=false` 时只算要做什么，不落盘。
 */
export function migrateOne(profileDir, { write = false, log = (s) => console.log(s), tag = '' } = {}) {
  const pkgPath = path.join(profileDir, 'package.json')
  const pkg = readJson(pkgPath)
  const notes = []
  const done = []
  if (!pkg) {
    log(`- ${profileDir}: 没有 package.json，跳过`)
    return { changed: false, done, notes }
  }
  const found = specOf(pkg)
  if (!found) {
    log(`- ${profileDir}: 没有老的 ${LEGACY} 依赖，跳过`)
    return { changed: false, done, notes }
  }
  const kind = specKind(found.spec)
  const how = kind === 'dir' ? '源码目录' : kind === 'tarball' ? 'tgz 包' : '版本号/远端'
  log(`\n== ${profileDir}`)
  log(`   老依赖: ${found.field}["${LEGACY}"] = ${found.spec}（${how}）`)

  let newName = NEW
  let target = ''
  if (kind === 'dir') {
    target = targetOf(profileDir, found.spec)
    const srcPkg = readJson(path.join(target, 'package.json'))
    const srcName = String(srcPkg?.name ?? '')
    log(`   源目录: ${target}`)
    log(`   源包名: ${srcName || '(读不到)'}`)
    if (!srcName) notes.push('源目录读不到 package.json，这条按"只清账"处理')
    else if (srcName !== LEGACY && srcName !== NEW) log(`   ! 源包名是 ${srcName}，脚本按它迁移`)
    if (srcName && srcName !== LEGACY) newName = srcName
  }

  if (!write) {
    if (kind === 'dir' && target) {
      log(`   [预览] 会：建 node_modules/${newName} → 源目录；把依赖键改成 ${newName}；删掉 ${LEGACY} 键与链接`)
    } else {
      log(`   [预览] 会：删掉 ${found.field}["${LEGACY}"]；bundles 里去掉 ${LEGACY}；旧 node_modules/${LEGACY} 改名停用`)
    }
    return { changed: true, done, notes }
  }

  const bak = `${pkgPath}.bak-fishrename-${tag || 'now'}`
  fs.copyFileSync(pkgPath, bak)
  log(`   备份: ${bak}`)

  if (kind === 'dir' && target) {
    const newLink = linkName(profileDir, newName)
    fs.mkdirSync(path.dirname(newLink), { recursive: true })
    if (!fs.existsSync(newLink)) {
      try {
        fs.symlinkSync(target, newLink, 'junction')
        done.push(`建链 node_modules/${newName} → ${target}`)
      } catch (e) {
        done.push(`建链失败：${e?.message ?? e}（可手动 New-Item -ItemType Junction）`)
      }
    } else {
      done.push(`链接已存在：${newName}`)
    }
  }

  delete pkg[found.field][LEGACY]
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
  if (deps[newName]) {
    // 新包名已经在依赖里（plugin add 装好了）：只把 bundles 对齐，不动依赖表。
    done.push(`删掉 ${found.field}["${LEGACY}"]`)
    done.push(...dropLegacyBundle(pkg, newName))
  } else if (kind === 'dir') {
    // 源码目录：把依赖键改名指向同一条 spec。
    pkg.dependencies = pkg.dependencies ?? {}
    pkg.dependencies[newName] = found.spec
    done.push(`依赖改为 ${found.field}["${newName}"]`)
    const bundles = bundlesOf(pkg)
    if (bundles) {
      for (let i = 0; i < bundles.length; i += 1) if (bundles[i] === LEGACY) bundles[i] = newName
      if (!bundles.includes(newName)) bundles.push(newName)
      done.push(`bundles 对齐 ${newName}`)
    }
  } else {
    done.push(`删掉 ${found.field}["${LEGACY}"]`)
    done.push(...dropLegacyBundle(pkg, ''))
    notes.push('新包名不在依赖里：只清账，装不装得上取决于这次 add 是否成功')
  }
  retireOldLink(profileDir, tag || 'now', done)

  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
  done.push('写入 package.json')
  return { changed: true, done, notes }
}

export function profileDirs(onlyProfile = '') {
  if (onlyProfile) return [path.resolve(onlyProfile)]
  const profilesRoot = path.join(os.homedir(), '.dsh', 'profiles')
  try {
    return fs
      .readdirSync(profilesRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(profilesRoot, d.name))
      .filter((p) => fs.existsSync(path.join(p, 'package.json')))
  } catch {
    return []
  }
}

function main() {
  const args = process.argv.slice(2)
  const write = args.includes('--write')
  const pIdx = args.indexOf('--profile')
  const onlyProfile = pIdx >= 0 ? args[pIdx + 1] : ''
  const tag = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  let touched = 0
  for (const dir of profileDirs(onlyProfile)) {
    const r = migrateOne(dir, { write, tag })
    for (const n of r.notes) console.log(`   注: ${n}`)
    for (const d of r.done) console.log(`   · ${d}`)
    if (write && r.changed) touched += 1
  }
  if (!write) console.log('\n这是预览。确认无误后加 --write 再跑一次（记得先关应用）。')
  else console.log(`\n改完 ${touched} 个 profile。现在启动 DeepSeek Harness。`)
}

const invokedDirectly = (() => {
  try {
    return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
})()

if (invokedDirectly) main()
