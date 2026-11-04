/**
 * test/hostver.test.mjs — 宿主版本自检（2026-10-30 m03193）
 *
 * 盯三件事：找得到宿主版本 / 判定不出错 / package.json 里那条声明跟代码里的常量不分叉。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SUPPORTED_RANGE, readHostVersion, readHostVersionFromAsar, parseRange, checkHost } from '../lib/hostver.js'

const here = dirname(fileURLToPath(import.meta.url))
const pkgFile = join(here, '..', 'package.json')

function tempTree(files) {
  const dir = mkdtempSync(join(tmpdir(), 'fish-hostver-'))
  for (const [rel, body] of Object.entries(files)) {
    const f = join(dir, rel)
    mkdirSync(dirname(f), { recursive: true })
    writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body))
  }
  return dir
}

test('readHostVersion：从插件位置往上找到宿主的 package.json', () => {
  const dir = tempTree({
    'node_modules/@deepseek-ai/dsh/package.json': { name: '@deepseek-ai/dsh', version: '0.2.1-rc.3' },
  })
  const start = join(dir, 'node_modules', 'dsh-fish', 'lib')
  const got = readHostVersion({ start })
  assert.ok(got)
  assert.equal(got.version, '0.2.1-rc.3')
  assert.equal(got.pkg, '@deepseek-ai/dsh')
})

test('readHostVersion：桌面版包名也认', () => {
  const dir = tempTree({
    'node_modules/@deepseek-ai/dsh-desktop-runtime/package.json': { version: '0.2.1-rc.5' },
  })
  const got = readHostVersion({ start: join(dir, 'node_modules', 'dsh-fish') })
  assert.equal(got?.version, '0.2.1-rc.5')
})

test('readHostVersion：找不到就 null，不抛', () => {
  const dir = tempTree({ 'nothing.txt': 'x' })
  assert.equal(readHostVersion({ start: join(dir, 'lib') }), null)
})

test('readHostVersion：坏 json 跳过、继续往上找', () => {
  const dir = tempTree({
    'node_modules/@deepseek-ai/dsh/package.json': '{ 这不是 json',
    'grand/node_modules/@deepseek-ai/dsh/package.json': { version: '0.2.0-rc.2' },
  })
  const got = readHostVersion({ start: join(dir, 'grand', 'deep', 'lib') })
  assert.equal(got?.version, '0.2.0-rc.2')
})

test('parseRange：>=X <Y 两头都认', () => {
  assert.deepEqual(parseRange('>=0.2.0-rc.1 <0.3.0-0'), { min: '0.2.0-rc.1', max: '0.3.0-0' })
  assert.deepEqual(parseRange('^0.2.0-rc.1'), { min: '0.2.0-rc.1', max: '' })
  assert.deepEqual(parseRange('乱写'), { min: '', max: '' })
})

test('checkHost：范围内的判 supported', () => {
  for (const v of ['0.2.0-rc.1', '0.2.1-rc.2', '0.2.1-rc.3', '0.2.1-rc.5', '0.2.2-alpha.2']) {
    const r = checkHost({ version: v })
    assert.equal(r.status, 'supported', v)
    assert.equal(r.ok, true, v)
  }
})

test('checkHost：比下线旧 / 超上线都判出来', () => {
  assert.equal(checkHost({ version: '0.1.7-rc.2' }).status, 'older')
  assert.equal(checkHost({ version: '0.2.1-alpha.5' }).status, 'supported')
  assert.equal(checkHost({ version: '0.3.0' }).status, 'newer')
  assert.equal(checkHost({ version: '1.0.0' }).status, 'newer')
})

test('checkHost：读不到或看不懂算 unknown，不算不兼容', () => {
  const a = checkHost({ version: '' })
  assert.equal(a.status, 'unknown')
  assert.equal(a.ok, false)
  assert.match(a.why, /没找到/)

  const b = checkHost({ version: 'latest' })
  assert.equal(b.status, 'unknown')
  assert.match(b.why, /看不懂/)

  const c = checkHost({ version: '0.2.1-rc.3', range: '乱写' })
  assert.equal(c.status, 'unknown')
})

test('package.json 的 engines.dsh 与代码常量一致（不许分叉）', () => {
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
  assert.equal(pkg.engines?.dsh, SUPPORTED_RANGE)
  assert.equal(pkg.dsh?.compatibility?.dsh, SUPPORTED_RANGE)
  assert.ok(Array.isArray(pkg.dsh?.compatibility?.profiles))
  assert.ok(pkg.dsh.compatibility.profiles.includes('desktop'))
})

// ---------------------------------------------------------------------------
// 桌面版把宿主装进 app.asar（2026-11-04，issue #20 第 ④ 条）
//
// 往上找 node_modules 这条路在桌面版永远扑空，于是自检一直说「读不到宿主版本号」。
// 真机核过：resources/app.asar/dsh/package.json 用普通 fs 读得到。
// 只在往上找失败后才退到这条路，而且只认 @deepseek-ai/dsh* 的包名——
// 位置被别的应用占了时，读出别人家的版本号比读不到更糟。
// ---------------------------------------------------------------------------

test('readHostVersion：往上找不到就退到 app.asar（桌面版）', () => {
  const dir = tempTree({
    'resources/app.asar/dsh/package.json': { name: '@deepseek-ai/dsh-desktop-runtime', version: '0.2.1-rc.5' },
  })
  const got = readHostVersion({ start: join(dir, 'no-such-place'), resourcesPath: join(dir, 'resources') })
  assert.equal(got?.version, '0.2.1-rc.5')
  assert.equal(got?.pkg, '@deepseek-ai/dsh-desktop-runtime')
})

test('readHostVersion：正常树里找得到时，不去碰 app.asar', () => {
  const dir = tempTree({
    'node_modules/@deepseek-ai/dsh/package.json': { name: '@deepseek-ai/dsh', version: '0.2.1-rc.3' },
    'resources/app.asar/dsh/package.json': { name: '@deepseek-ai/dsh-desktop-runtime', version: '0.2.1-rc.5' },
  })
  const got = readHostVersion({ start: join(dir, 'node_modules', 'dsh-fish'), resourcesPath: join(dir, 'resources') })
  assert.equal(got?.version, '0.2.1-rc.3', '就近的那份才算数')
})

test('readHostVersionFromAsar：不认识的名字不认（宁可 unknown，也不能张冠李戴）', () => {
  const dir = tempTree({
    'resources/app.asar/dsh/package.json': { name: 'some-other-app', version: '9.9.9' },
  })
  assert.equal(readHostVersionFromAsar({ resourcesPath: join(dir, 'resources') }), null)
  // 整条路一起看：读不到就是 null，交给 checkHost 报 unknown
  assert.equal(readHostVersion({ start: join(dir, 'x'), resourcesPath: join(dir, 'resources') }), null)
})

test('readHostVersionFromAsar：没 resourcesPath、坏 json、文件不存在，都不抛', () => {
  assert.equal(readHostVersionFromAsar({}), null)
  assert.equal(readHostVersionFromAsar({ resourcesPath: '' }), null)
  const dir = tempTree({ 'resources/app.asar/dsh/package.json': '{ 这不是 json' })
  assert.equal(readHostVersionFromAsar({ resourcesPath: join(dir, 'resources') }), null)
})

test('桌面版那条路读到的版本号能直接判成 supported（不是 unknown）', () => {
  const dir = tempTree({
    'resources/app.asar/dsh/package.json': { name: '@deepseek-ai/dsh-desktop-runtime', version: '0.2.1-rc.5' },
  })
  const got = readHostVersion({ start: join(dir, 'x'), resourcesPath: join(dir, 'resources') })
  const r = checkHost({ version: got?.version ?? '' })
  assert.equal(r.status, 'supported')
  assert.equal(r.ok, true)
})

test('dshReleases 里每个键都是合法版本号，值只允许三种', () => {
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
  const rel = pkg.dsh?.compatibility?.dshReleases ?? {}
  const keys = Object.keys(rel)
  assert.ok(keys.length > 0)
  for (const k of keys) {
    assert.match(k, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, k)
    assert.ok(['compatible', 'incompatible', 'unknown'].includes(rel[k]), `${k}: ${rel[k]}`)
  }
})
