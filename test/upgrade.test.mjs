// 升级自检：`file:` 装法里「改了源目录但跑的还是 node_modules 旧副本」这件事，要能被看出来。
// 这些用例只碰临时目录，不读真实 profile。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { checkUpgrade, compareVersion, fileDepDir, profileDirs, runningPkgFile } from '../lib/upgrade.js'

async function sandbox() {
  const dir = await mkdtemp(join(tmpdir(), 'fish-upg-'))
  return { dir, done: () => rm(dir, { recursive: true, force: true }) }
}

async function writeJson(file, value) {
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, JSON.stringify(value, null, 2), 'utf8')
}

test('compareVersion：数字位与预发布号', () => {
  assert.equal(compareVersion('0.7.6', '0.7.6'), 0)
  assert.equal(compareVersion('0.8.0', '0.7.6'), 1)
  assert.equal(compareVersion('0.7.5', '0.7.6'), -1)
  assert.equal(compareVersion('1.0.0-rc.1', '1.0.0'), -1, '预发布比正式版旧')
  assert.equal(compareVersion('1.0.0-rc.2', '1.0.0-rc.1'), 1)
  assert.equal(compareVersion('乱七八糟', '0.7.6'), 0, '比不出来就不下结论')
})

test('fileDepDir：三种 file: 写法都认，link: 不认', () => {
  const profile = join('C:', 'Users', 'x', '.dsh', 'profiles', 'desktop')
  const winAbs = { dependencies: { 'dsh-fish': 'file:D:/DSH/plugins-src/dsh-fish' } }
  assert.match(fileDepDir(profile, winAbs).replace(/\\/g, '/'), /^D:\/DSH\/plugins-src\/dsh-fish$/i)

  const rel = { dependencies: { 'dsh-fish': 'file:../../../plugins-src/dsh-fish' } }
  assert.ok(fileDepDir(profile, rel).replace(/\\/g, '/').endsWith('plugins-src/dsh-fish'))

  const dev = { devDependencies: { 'dsh-fish': 'file:../src' } }
  assert.ok(fileDepDir(profile, dev).endsWith('src'))

  assert.equal(fileDepDir(profile, { dependencies: { 'dsh-fish': 'link:D:/x' } }), '', 'link: 不是副本，不用提醒')
  // 2026-11-05 改名后的老 profile：键可能还是裸名 dsh-fish，也得认出来
  assert.equal(
    fileDepDir(profile, { dependencies: { 'dsh-fish': 'file:D:/old-src' } }),
    fileDepDir(profile, { dependencies: { '@ssamurias/dsh-fish': 'file:D:/old-src' } }),
    '裸名键与 scoped 键要给出同一个目录',
  )
  // 两个键同时存在时，认真正是 file: 的那条，不被 link: 挡掉
  assert.equal(
    fileDepDir(profile, {
      dependencies: { '@ssamurias/dsh-fish': 'link:D:/a', 'dsh-fish': 'file:D:/b' },
    }),
    fileDepDir(profile, { dependencies: { '@ssamurias/dsh-fish': 'file:D:/b' } }),
  )
  assert.equal(fileDepDir(profile, {}), '')
})

test('checkUpgrade：源目录比正在跑的新 → stale，并给出两个版本', async () => {
  const s = await sandbox()
  try {
    const profile = join(s.dir, 'profiles', 'desktop')
    const src = join(s.dir, 'src')
    await writeJson(join(profile, 'package.json'), { dependencies: { 'dsh-fish': 'file:' + src } })
    await writeJson(join(src, 'package.json'), { name: 'dsh-fish', version: '0.8.0' })

    const r = await checkUpgrade({ version: '0.7.6', profilesDir: profile })
    assert.equal(r.ok, true)
    assert.equal(r.stale, true)
    assert.equal(r.running, '0.7.6')
    assert.equal(r.source, '0.8.0')
    assert.match(r.why, /0\.8\.0/)
    assert.match(r.why, /0\.7\.6/)
    assert.equal(r.sourcePath, src)
    assert.equal(r.profile, profile)
  } finally {
    await s.done()
  }
})

test('checkUpgrade：版本一致 → 不提醒', async () => {
  const s = await sandbox()
  try {
    const profile = join(s.dir, 'profiles', 'desktop')
    const src = join(s.dir, 'src')
    await writeJson(join(profile, 'package.json'), { dependencies: { 'dsh-fish': 'file:' + src } })
    await writeJson(join(src, 'package.json'), { name: 'dsh-fish', version: '0.7.6' })

    const r = await checkUpgrade({ version: '0.7.6', profilesDir: profile })
    assert.equal(r.ok, true)
    assert.equal(r.stale, false)
    assert.equal(r.source, '0.7.6')
  } finally {
    await s.done()
  }
})

test('checkUpgrade：源目录比正在跑的旧 → stale + older', async () => {
  const s = await sandbox()
  try {
    const profile = join(s.dir, 'profiles', 'desktop')
    const src = join(s.dir, 'src')
    await writeJson(join(profile, 'package.json'), { dependencies: { 'dsh-fish': 'file:' + src } })
    await writeJson(join(src, 'package.json'), { name: 'dsh-fish', version: '0.6.0' })

    const r = await checkUpgrade({ version: '0.7.6', profilesDir: profile })
    assert.equal(r.stale, true)
    assert.equal(r.older, true)
    assert.match(r.why, /0\.6\.0/)
  } finally {
    await s.done()
  }
})

test('checkUpgrade：没有 file: 依赖 / 源目录没版本 / 坏 json → 静默跳过，不抛', async () => {
  const s = await sandbox()
  try {
    const linkProfile = join(s.dir, 'p1')
    await writeJson(join(linkProfile, 'package.json'), { dependencies: { 'dsh-fish': 'link:D:/x' } })
    const r1 = await checkUpgrade({ version: '0.7.6', profilesDir: linkProfile })
    assert.equal(r1.stale, false)
    assert.equal(r1.skipped, true)
    assert.match(r1.why, /file:/)

    const noVer = join(s.dir, 'p2')
    const srcNoVer = join(s.dir, 'src-nover')
    await writeJson(join(noVer, 'package.json'), { dependencies: { 'dsh-fish': 'file:' + srcNoVer } })
    await mkdir(srcNoVer, { recursive: true })
    const r2 = await checkUpgrade({ version: '0.7.6', profilesDir: noVer })
    assert.equal(r2.skipped, true)
    assert.equal(r2.sourcePath, srcNoVer)

    const broken = join(s.dir, 'p3')
    await mkdir(broken, { recursive: true })
    await writeFile(join(broken, 'package.json'), '{ 这不是 json', 'utf8')
    const r3 = await checkUpgrade({ version: '0.7.6', profilesDir: broken })
    assert.equal(r3.skipped, true)
    assert.equal(r3.stale, false)

    const r4 = await checkUpgrade({ version: '0.7.6', profilesDir: join(s.dir, '不存在') })
    assert.equal(r4.skipped, true)
  } finally {
    await s.done()
  }
})

test('profileDirs：读不到目录返回空数组，不抛', () => {
  assert.deepEqual(profileDirs({ home: join('C:', '不存在的人') }), [])
})

test('runningPkgFile：从模块 URL 往上两级', () => {
  const url = pathToFileURL(join('C:', 'x', 'node_modules', 'dsh-fish', 'lib', 'index.js')).href
  assert.ok(runningPkgFile(url).replace(/\\/g, '/').endsWith('node_modules/dsh-fish/package.json'))
  assert.equal(runningPkgFile('not a url'), '')
})

test('checkUpgrade：两个 profile 钉着不同源目录时，认「装进去的那份==正在跑」的那个', async () => {
  const s = await sandbox()
  try {
    const base = join(s.dir, 'profiles')
    const desktop = join(base, 'desktop')
    const web = join(base, 'web')
    const srcNew = join(s.dir, 'src-new')
    const srcOld = join(s.dir, 'src-old')

    await writeJson(join(desktop, 'package.json'), { dependencies: { 'dsh-fish': 'file:' + srcNew } })
    await writeJson(join(srcNew, 'package.json'), { name: 'dsh-fish', version: '0.8.0' })

    await writeJson(join(web, 'package.json'), { dependencies: { 'dsh-fish': 'file:' + srcOld } })
    await writeJson(join(srcOld, 'package.json'), { name: 'dsh-fish', version: '0.7.6' })
    // web 这个 profile 装进去的那份正好是正在跑的 0.7.6 → 它才是当前这条命
    await writeJson(join(web, 'node_modules', 'dsh-fish', 'package.json'), { name: 'dsh-fish', version: '0.7.6' })

    const r = await checkUpgrade({ version: '0.7.6', home: s.dir, env: { DSH_FISH_PROFILES: base } })
    assert.equal(r.stale, false, '不能拿另一个 profile 的源目录报警')
    assert.equal(r.profile, web)
    assert.equal(r.source, '0.7.6')
  } finally {
    await s.done()
  }
})
