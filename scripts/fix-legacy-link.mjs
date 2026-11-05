#!/usr/bin/env node
/**
 * 把老的 `link:` / `file:` 安装迁移到新包名（@ssamurias/dsh-fish）。
 *
 * 为什么需要它：0.8.10 起插件包名从 `dsh-fish` 改成 `@ssamurias/dsh-fish`，
 * 插件自带 cordis.patch.yml 里的条目名也跟着变成完整包名；而老 profile 的
 * node_modules 里只有裸名链接 `dsh-fish` → 条目 import 失败 → **宿主直接启动崩溃**。
 * 升级前跑一遍这个脚本就能避免；已经崩了也能跑（它只改 profile 文件，不需要应用启动）。
 *
 * 用法（先关掉 DeepSeek Harness）：
 *   node scripts/fix-legacy-link.mjs            # 预览
 *   node scripts/fix-legacy-link.mjs --write    # 真的改
 *   node scripts/fix-legacy-link.mjs --write --profile C:\Users\你\.dsh\profiles\desktop
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const NEW = '@ssamurias/dsh-fish'
const LEGACY = 'dsh-fish'
const args = process.argv.slice(2)
const WRITE = args.includes('--write')
const pIdx = args.indexOf('--profile')
const onlyProfile = pIdx >= 0 ? args[pIdx + 1] : ''

const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
const profilesRoot = path.join(os.homedir(), '.dsh', 'profiles')

function profileDirs() {
  if (onlyProfile) return [path.resolve(onlyProfile)]
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

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

function specOf(pkg) {
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const spec = pkg?.[field]?.[LEGACY]
    if (typeof spec === 'string' && /^(link:|file:)/.test(spec)) return { field, spec }
  }
  return null
}

function targetOf(profileDir, spec) {
  const raw = spec.replace(/^(link:|file:)/, '').trim()
  if (!raw) return ''
  if (/^[A-Za-z]:[\\/]/.test(raw) || path.isAbsolute(raw)) return path.resolve(raw)
  return path.resolve(profileDir, raw)
}

function linkName(profileDir, name) {
  return path.join(profileDir, 'node_modules', ...name.split('/'))
}

let touched = 0
for (const dir of profileDirs()) {
  const pkgPath = path.join(dir, 'package.json')
  const pkg = readJson(pkgPath)
  if (!pkg) continue
  const found = specOf(pkg)
  if (!found) {
    console.log(`- ${dir}: 没有老的 ${LEGACY} link/file 依赖，跳过`)
    continue
  }
  const target = targetOf(dir, found.spec)
  const srcPkg = readJson(path.join(target, 'package.json'))
  const srcName = String(srcPkg?.name ?? '')
  console.log(`\n== ${dir}`)
  console.log(`   依赖: ${found.field}["${LEGACY}"] = ${found.spec}`)
  console.log(`   源目录: ${target}`)
  console.log(`   源包名: ${srcName || '(读不到)'}`)
  if (!srcName || srcName === LEGACY) {
    console.log('   → 源目录还是老名字，这次迁移用不上（等你更新到 0.8.10 再跑）')
    continue
  }
  if (srcName !== NEW) console.log(`   ! 源包名是 ${srcName}，脚本按它迁移`)
  const newName = srcName === LEGACY ? NEW : srcName

  if (!WRITE) {
    console.log(`   [预览] 会：建立 node_modules/${newName} → 源目录；把依赖键改成 ${newName}；删掉 ${LEGACY} 键与链接`)
    continue
  }

  // 1) 备份
  const bak = `${pkgPath}.bak-fishrename-${stamp}`
  fs.copyFileSync(pkgPath, bak)
  console.log(`   备份: ${bak}`)

  // 2) 建新名链接（Junction 在 Windows 不需要管理员权限）
  const newLink = linkName(dir, newName)
  fs.mkdirSync(path.dirname(newLink), { recursive: true })
  if (!fs.existsSync(newLink)) {
    try {
      fs.symlinkSync(target, newLink, 'junction')
      console.log(`   建链: ${newLink} -> ${target}`)
    } catch (e) {
      console.log(`   ! 建链失败: ${e.message}（可手动 New-Item -ItemType Junction）`)
    }
  } else {
    console.log(`   链接已存在: ${newLink}`)
  }

  // 3) 改依赖键
  delete pkg[found.field][LEGACY]
  pkg.dependencies = pkg.dependencies || {}
  pkg.dependencies[newName] = found.spec
  // bundles 跟着改
  const bundles = pkg?.dsh?.profile?.bundles
  if (Array.isArray(bundles)) {
    pkg.dsh.profile.bundles = Array.from(new Set(bundles.map((b) => (b === LEGACY ? newName : b))))
  }
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
  console.log(`   依赖改为 ${found.field}["${newName}"]，bundles 已对齐`)

  // 4) 老链接改名停用（不删，留着能回滚）
  const oldLink = linkName(dir, LEGACY)
  if (fs.existsSync(oldLink)) {
    const off = `${oldLink}.disabled-${stamp}`
    try {
      fs.renameSync(oldLink, off)
      console.log(`   老链接停用: ${off}`)
    } catch (e) {
      console.log(`   ! 老链接改名失败: ${e.message}`)
    }
  }
  touched++
}

if (!WRITE) {
  console.log('\n这是预览。确认无误后加 --write 再跑一次（记得先关应用）。')
} else {
  console.log(`\n改完 ${touched} 个 profile。现在启动 DeepSeek Harness。`)
}
