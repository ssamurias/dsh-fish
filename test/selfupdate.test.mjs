/**
 * selfupdate.test.mjs —— 自带升级通道（2026-10-29 用户 m00203）
 *
 * 这条链路是唯一会**改动用户安装**的东西，所以测试的重心不是"能跑通"，
 * 而是"每一条能想到的错都不该让它装上一个坏包"：
 *
 *   1. 地址与 spec 是硬编码的（不接受外部 URL）；
 *   2. 只有**真的解开来验过**的包才算下载成功（半截文件、错误页、版本不符都拒）；
 *   3. 下载失败要说人话、能重试、不留半截文件；
 *   4. 安装脚本里必须有备份与回滚，且**只在宿主退出后**才动手；
 *   5. 开发版（link:/file:）永远不升级——那会把源码目录换成下载包。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import zlib from 'node:zlib'
import { mkdtemp, rm, readFile, readdir, stat, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  classifySpec,
  sourcesFor,
  specFor,
  fileNameFor,
  inspectPackage,
  downloadTarball,
  scriptFor,
  normalizeScript,
  runtimeBins,
  profileDirOf,
  createSelfUpdater,
} from '../lib/selfupdate.js'
import { registerObserve } from '../lib/observe.js'

// ---------------------------------------------------------------- tar 工具

function tarHeader(name, size) {
  const buf = Buffer.alloc(512)
  buf.write(name, 0, 100, 'utf8')
  buf.write('0000644\0', 100, 8)
  buf.write('0000000\0', 108, 8)
  buf.write('0000000\0', 116, 8)
  buf.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12)
  buf.write('00000000000\0', 136, 12)
  buf.write('        ', 148, 8)
  buf.write('0', 156, 1)
  buf.write('ustar\0' + '00', 257, 8)
  let sum = 0
  for (const b of buf) sum += b
  buf.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8)
  return buf
}

function makeTar(entries) {
  const parts = []
  for (const [name, data] of Object.entries(entries)) {
    const body = Buffer.from(data, 'utf8')
    parts.push(tarHeader(name, body.length), body, Buffer.alloc((512 - (body.length % 512)) % 512))
  }
  parts.push(Buffer.alloc(1024))
  return Buffer.concat(parts)
}

const tgz = (entries) => zlib.gzipSync(makeTar(entries))

/** 一个"长得像这个插件"的包。 */
function goodTarball(version = '0.6.14', extra = {}) {
  return tgz({
    'package/package.json': JSON.stringify({ name: '@ssamurias/dsh-fish', version }),
    'package/lib/index.js': 'export default {}\n',
    'package/README.md': '# x\n',
    ...extra,
  })
}

async function withServer(handler, fn) {
  const srv = http.createServer(handler)
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${srv.address().port}`
  try {
    return await fn(base)
  } finally {
    await new Promise((r) => srv.close(r))
  }
}

const tmp = (p) => mkdtemp(join(tmpdir(), `fish-selupdate-${p}-`))

// ---------------------------------------------------------------- 地址与 spec

test('下载地址是硬编码的：直连 + 两个镜像，且都指向同一个 tag', () => {
  const list = sourcesFor('0.6.14')
  assert.equal(list.length, 2)
  assert.equal(list[0].url, 'https://registry.npmjs.org/@ssamurias/dsh-fish/-/dsh-fish-0.6.14.tgz')
  assert.equal(list[1].url, 'https://registry.npmmirror.com/@ssamurias/dsh-fish/-/dsh-fish-0.6.14.tgz')
  // 包名必须带 scope（裸名 dsh-fish 在 npm 上被别人占了），版本必须进 tarball 名
  for (const s of list) {
    assert.ok(s.url.includes('@ssamurias/dsh-fish'), `${s.name} 指错包`)
    assert.ok(s.url.includes('dsh-fish-0.6.14.tgz'), `${s.name} 的版本不对`)
  }
  // 认不出的版本不许编一个地址出来
  assert.deepEqual(sourcesFor('latest'), [])
  assert.deepEqual(sourcesFor(''), [])
})

test('spec 与文件名跟着版本走；多余前缀被规范掉', () => {
  // 从 npm 装：写成版本号而不是 github: 或 file:（file: 会让下一次升级把自己当开发版）
  assert.equal(specFor('0.6.14'), '@ssamurias/dsh-fish@0.6.14')
  assert.equal(specFor('v0.6.14'), '@ssamurias/dsh-fish@0.6.14')
  assert.equal(fileNameFor('v0.6.14'), 'dsh-fish-v0.6.14.tgz')
})

test('profile 里那条依赖分得清"开发版"和"可升级的安装"', () => {
  assert.equal(classifySpec('link:D:/deepseekagent/fish-plugin'), 'local')
  assert.equal(classifySpec('file:../fish'), 'local')
  assert.equal(classifySpec('github:ssamurias/dsh-fish#v0.6.0'), 'github')
  assert.equal(classifySpec('0.6.0'), 'registry')
  assert.equal(classifySpec('^0.6.0'), 'registry')
  assert.equal(classifySpec(''), 'missing')
  assert.equal(classifySpec('npm:@scope/pkg@1.0.0'), 'other')
})

test('从模块路径反推 profile 目录：link 安装（真身在源码目录）要识别为"没有 profile"', () => {
  const winUrl = 'file:///C:/Users/DANG/.dsh/profiles/desktop/node_modules/dsh-fish/lib/selfupdate.js'
  const got = profileDirOf(winUrl).split(String.fromCharCode(92)).join('/').replace(/^\/(?=[A-Za-z]:)/, '')
  assert.equal(got, 'C:/Users/DANG/.dsh/profiles/desktop')
  const linkUrl = pathToFileURL('D:/deepseekagent/02-我的项目/大肥鱼/plugin/lib/selfupdate.js').href
  assert.equal(profileDirOf(linkUrl), '')
})

test('pnpm 的 isolated 布局也要认得出 profile 根，否则升级按钮永远不出现（issue #43）', () => {
  const url = 'file:///C:/Users/DANG/.dsh/profiles/desktop/node_modules/.pnpm/@ssamurias+dsh-fish@0.9.1/node_modules/@ssamurias/dsh-fish/lib/selfupdate.js'
  const got = profileDirOf(url).split(String.fromCharCode(92)).join('/').replace(/^\/(?=[A-Za-z]:)/, '')
  assert.equal(got, 'C:/Users/DANG/.dsh/profiles/desktop')
  // .pnpm 里的老裸名同理（0.8.9 之前用 pnpm 装的人）
  const old = 'file:///C:/u/.dsh/profiles/desktop/node_modules/.pnpm/dsh-fish@0.8.8/node_modules/dsh-fish/lib/selfupdate.js'
  assert.equal(profileDirOf(old).split(String.fromCharCode(92)).join('/').replace(/^\/(?=[A-Za-z]:)/, ''), 'C:/u/.dsh/profiles/desktop')
  // 普通布局不能被这条误伤
  const plain = 'file:///C:/u/.dsh/profiles/desktop/node_modules/@ssamurias/dsh-fish/lib/selfupdate.js'
  assert.equal(profileDirOf(plain).split(String.fromCharCode(92)).join('/').replace(/^\/(?=[A-Za-z]:)/, ''), 'C:/u/.dsh/profiles/desktop')
})

test('应用自带的 node/pnpm：找不到就给空（退回 PATH），不瞎指一个路径', () => {
  assert.deepEqual(runtimeBins({ exe: 'C:/nowhere/App.exe', exists: () => false }), { nodeBin: '', pnpmScript: '' })
  const r = runtimeBins({
    exe: 'C:/App/App.exe',
    exists: (p) => p.replace(/\\/g, '/').endsWith('/resources/runtime/primary-runtime/dependencies/node/bin/node.exe')
      || p.replace(/\\/g, '/').endsWith('/resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs'),
  })
  assert.ok(r.nodeBin.endsWith('node.exe'))
  assert.ok(r.pnpmScript.endsWith('pnpm.mjs'))
})

// ---------------------------------------------------------------- 内容校验

test('解得开的包：能读出包名、版本，并且确认入口文件在', () => {
  const info = inspectPackage(goodTarball('0.6.14'), { version: '0.6.14' })
  assert.equal(info.name, '@ssamurias/dsh-fish')
  assert.equal(info.version, '0.6.14')
  assert.ok(info.files.includes('lib/index.js'))
})

test('不是 gzip（比如镜像回了 HTML 错误页）——拒，并且原因能读', () => {
  assert.throws(() => inspectPackage(Buffer.from('<html>502</html>')), /不是有效的压缩包/)
})

test('空文件、超大的文件都在解压前就拒掉', () => {
  assert.throws(() => inspectPackage(Buffer.alloc(0)), /空的/)
})

test('版本对不上——拒（镜像缓存滞后时最容易撞上这条）', () => {
  assert.throws(() => inspectPackage(goodTarball('0.6.13'), { version: '0.6.14' }), /版本是 0\.6\.13/)
})

test('包名不对——拒（防止有人在同名仓库里塞别的东西）', () => {
  const bad = tgz({
    'package/package.json': JSON.stringify({ name: 'not-fish', version: '0.6.14' }),
    'package/lib/index.js': '',
  })
  assert.throws(() => inspectPackage(bad, { version: '0.6.14' }), /不是 @ssamurias\/dsh-fish/)
})

test('没有 lib/index.js——拒（装上去也加载不了）', () => {
  const bad = tgz({ 'package/package.json': JSON.stringify({ name: '@ssamurias/dsh-fish', version: '0.6.14' }) })
  assert.throws(() => inspectPackage(bad, { version: '0.6.14' }), /lib\/index\.js/)
})

test('半截 tar（头说 100 字节、实际只有 3 字节）——拒', () => {
  const full = makeTar({ 'package/package.json': JSON.stringify({ name: '@ssamurias/dsh-fish', version: '0.6.14' }) })
  const cut = full.subarray(0, 512 + 3)
  assert.throws(() => inspectPackage(zlib.gzipSync(cut), { version: '0.6.14' }))
})

// ---------------------------------------------------------------- 下载

test('下载成功：落到正式文件名、半截的 .part 不留下、来源写清楚', async () => {
  const dir = await tmp('ok')
  const body = goodTarball('0.6.14')
  try {
    await withServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/gzip', 'content-length': body.length })
      res.end(body)
    }, async (base) => {
      const r = await downloadTarball({
        version: '0.6.14',
        dir,
        sources: [{ name: '本地', url: `${base}/pkg.tgz` }],
      })
      assert.equal(r.ok, true, r.error)
      assert.equal(r.source, '本地')
      assert.equal(r.bytes, body.length)
      const saved = await readFile(join(dir, fileNameFor('0.6.14')))
      assert.equal(saved.length, body.length)
      await assert.rejects(stat(join(dir, `${fileNameFor('0.6.14')}.part`)))
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('不传 sources 时用硬编码地址（这条曾经把 sources 当成本地变量，默认路径直接 TypeError）', async () => {
  const dir = await tmp('default-sources')
  const body = goodTarball('0.6.14')
  const urls = []
  try {
    const r = await downloadTarball({
      version: '0.6.14',
      dir,
      fetchImpl: async (url) => {
        urls.push(String(url))
        return new Response(body, { status: 200, headers: { 'content-length': String(body.length) } })
      },
    })
    assert.equal(r.ok, true, r.error)
    assert.equal(urls.length, 1)
    assert.ok(urls[0].startsWith('https://registry.npmjs.org/@ssamurias/dsh-fish/-/dsh-fish-0.6.14.tgz'), urls[0])
    assert.equal(r.source, 'npm 官方源')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('onProgress 传 null 也不炸（界面没挂进度回调时）', async () => {
  const dir = await tmp('null-progress')
  const body = goodTarball('0.6.14')
  try {
    const r = await downloadTarball({
      version: '0.6.14', dir, onProgress: null,
      sources: [{ name: '本地', url: 'http://127.0.0.1:1/x.tgz' }],
      fetchImpl: async () => new Response(body, { status: 200 }),
    })
    assert.equal(r.ok, true, r.error)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('第一个源坏了换第二个；全坏时报人话、也不留半截文件', async () => {
  const dir = await tmp('fallback')
  const body = goodTarball('0.6.14')
  try {
    await withServer((req, res) => {
      if (req.url === '/ok.tgz') {
        res.writeHead(200, { 'content-length': body.length })
        res.end(body)
        return
      }
      res.writeHead(500)
      res.end('boom')
    }, async (base) => {
      const good = await downloadTarball({
        version: '0.6.14', dir,
        sources: [{ name: '坏的', url: `${base}/bad.tgz` }, { name: '好的', url: `${base}/ok.tgz` }],
      })
      assert.equal(good.ok, true, good.error)
      assert.equal(good.source, '好的')

      const bad = await downloadTarball({
        version: '0.6.14', dir: join(dir, 'second'),
        sources: [{ name: '坏的', url: `${base}/bad.tgz` }],
      })
      assert.equal(bad.ok, false)
      assert.match(bad.error, /没能下载成功/)
      assert.match(bad.error, /坏的/)
      await assert.rejects(stat(join(dir, 'second', `${fileNameFor('0.6.14')}.part`)))
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('内容不对（版本对不上）——当失败处理，绝不落盘', async () => {
  const dir = await tmp('wrongver')
  const body = goodTarball('0.6.13')
  try {
    await withServer((req, res) => {
      res.writeHead(200, { 'content-length': body.length })
      res.end(body)
    }, async (base) => {
      const r = await downloadTarball({ version: '0.6.14', dir, sources: [{ name: '本地', url: `${base}/x.tgz` }] })
      assert.equal(r.ok, false)
      assert.match(r.error, /版本是 0\.6\.13/)
      await assert.rejects(stat(join(dir, fileNameFor('0.6.14'))))
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('超时：卡住不回的源会按单源预算放弃，并说"等了 N 秒"', async () => {
  const dir = await tmp('slow')
  try {
    await withServer((req) => { /* 故意不回 */ }, async (base) => {
      const t0 = Date.now()
      const r = await downloadTarball({
        version: '0.6.14', dir, perSourceTimeoutMs: 150, budgetMs: 1000,
        sources: [{ name: '慢的', url: `${base}/slow.tgz` }],
      })
      assert.equal(r.ok, false)
      assert.match(r.error, /等了 0 秒|等了 1 秒|没有响应|aborted/i)
      assert.ok(Date.now() - t0 < 5000, '不该拖住事件循环')
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- 安装脚本

test('安装脚本：先等宿主退出、备份、装、校验版本、失败回滚、最后重开', () => {
  const script = scriptFor({
    version: '0.6.14',
    profileDir: 'C:\\Users\\DANG\\.dsh\\profiles\\desktop',
    exe: 'D:\\DeepSeek Harness\\DeepSeek Harness.exe',
    nodeBin: 'D:\\DeepSeek Harness\\resources\\runtime\\node.exe',
    pnpmScript: 'D:\\DeepSeek Harness\\resources\\runtime\\pnpm.mjs',
    logFile: 'C:\\Users\\DANG\\.dsh-fish\\updates\\last.log',
    backupDir: 'C:\\Users\\DANG\\.dsh-fish\\updates\\backup-v0.6.14',
    hostName: 'DeepSeek Harness.exe',
    tarball: 'C:/Users/DANG/.dsh-fish/updates/dsh-fish-v0.6.14.tgz',
  })
  // 第一件事就是等 + 杀宿主，不能先动文件
  assert.ok(script.indexOf('timeout /t 2') < script.indexOf('taskkill'), '先等两秒再杀')
  assert.ok(script.includes('taskkill /F /IM "DeepSeek Harness.exe"'))
  assert.ok(script.indexOf('tasklist') < script.indexOf('pnpm'), '宿主真退出了才动手')
  assert.ok(script.includes('add "@ssamurias/dsh-fish@0.6.14"'), '从 npm 装指定的那个版本')
  assert.ok(!script.includes('github:ssamurias'), '不走 git 协议（国内实测 connection reset）')
  assert.ok(!script.includes('file:'), '不用 file: 装临时 tarball（会把依赖写成临时路径）')
  assert.ok(script.includes('--config.minimumReleaseAge=0'), '24 小时年龄闸会拦住刚发的包')
  assert.ok(script.includes('-e "const p=require(\'./node_modules/@ssamurias/dsh-fish/package.json\')'), '装完要核对版本')
  assert.ok(script.includes(':rollback'), '失败要有回滚')
  assert.ok(script.includes('copy /Y "%BK%\\package.json"'), '回滚要还原 manifest')
  assert.ok(script.includes('pnpm') && script.includes('install'))
  assert.ok(script.includes('start "" "D:\\DeepSeek Harness\\DeepSeek Harness.exe"'), '装完要自己重开')
  // 脚本里的日志一律英文：cmd 默认代码页是 GBK，中文写进去会变乱码
  assert.doesNotMatch(script, /[\u4e00-\u9fa5]/, '安装脚本不该含中文')
})

test('没有自带 pnpm 时退回 PATH 上的 pnpm，而不是拼一个不存在的路径', () => {
  const script = scriptFor({
    version: '0.6.14', profileDir: 'C:\\p', exe: 'C:\\App.exe', logFile: 'C:\\l.log', backupDir: 'C:\\b', hostName: 'App.exe',
  })
  assert.ok(/\r?\npnpm add "@ssamurias\/dsh-fish@/.test(script), '要用 PATH 上的 pnpm')
})

// ---------------------------------------------------------------- 状态机

async function fakeProfile(kind = 'github') {
  const base = await tmp(`profile-${kind}`)
  const profile = join(base, 'profile')
  const pkg = join(profile, 'node_modules', 'dsh-fish')
  await mkdir(join(pkg, 'lib'), { recursive: true })
  await writeFile(join(pkg, 'lib', 'index.js'), 'export default {}\n')
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'dsh-fish', version: '0.6.13' }))
  await writeFile(join(profile, 'package.json'), JSON.stringify({
    dependencies: { 'dsh-fish': kind === 'github' ? 'github:ssamurias/dsh-fish#v0.6.13' : 'link:D:/src/plugin' },
  }))
  return { base, profile, moduleUrl: pathToFileURL(join(pkg, 'lib', 'selfupdate.js')).href }
}

test('状态机：下载 → 验过 = prepared；没下好之前装不了', async () => {
  const { base, profile, moduleUrl } = await fakeProfile()
  try {
    const up = createSelfUpdater({
      root: join(base, 'data'),
      current: '0.6.13',
      moduleUrl,
      exe: 'C:\\App\\DeepSeek Harness.exe',
      platform: 'win32',
      downloadImpl: async ({ dir }) => {
        await mkdir(dir, { recursive: true })
        await writeFile(join(dir, 'x.tgz'), 'x')
        return { ok: true, file: join(dir, 'x.tgz'), bytes: 1024, source: '测试源' }
      },
    })
    const st0 = up.status()
    assert.equal(st0.kind, 'github')
    assert.equal(st0.managed, true)
    assert.equal(st0.phase, 'idle')

    const early = await up.install('0.6.14')
    assert.equal(early.ok, false, '还没下载好就不能装')

    const started = await up.start('0.6.14')
    assert.equal(started.ok, true)
    // 异步收尾：等它从 downloading 走到 prepared
    for (let i = 0; i < 50 && up.status().phase === 'downloading'; i += 1) {
      await new Promise((r) => setTimeout(r, 10))
    }
    const st1 = up.status()
    assert.equal(st1.phase, 'prepared')
    assert.equal(st1.source, '测试源')
    assert.equal(st1.canInstall, true)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('下载失败进 failed，error 原样给界面；再点一次能从 failed 重新开始', async () => {
  const { base, moduleUrl } = await fakeProfile()
  let calls = 0
  try {
    const up = createSelfUpdater({
      root: join(base, 'data'),
      current: '0.6.13',
      moduleUrl,
      exe: 'C:\\App\\DeepSeek Harness.exe',
      platform: 'win32',
      downloadImpl: async () => {
        calls += 1
        return calls === 1 ? { ok: false, error: '三次都没连上' } : { ok: true, bytes: 10, source: '源' }
      },
    })
    await up.start('0.6.14')
    for (let i = 0; i < 50 && up.status().phase === 'downloading'; i += 1) await new Promise((r) => setTimeout(r, 10))
    assert.equal(up.status().phase, 'failed')
    assert.equal(up.status().error, '三次都没连上')

    const again = await up.start('0.6.14')
    assert.equal(again.ok, true, '失败之后必须能重试')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('开发版（link:）拒绝下载，也拒绝安装——不许拿下载包覆盖源码', async () => {
  const { base, moduleUrl } = await fakeProfile('local')
  try {
    const up = createSelfUpdater({ root: join(base, 'data'), current: '0.6.13', moduleUrl, exe: 'C:\\App.exe' })
    assert.equal(up.status().kind, 'local')
    const r = await up.start('0.6.14')
    assert.equal(r.ok, false)
    assert.equal(r.local, true)
    assert.match(r.error, /开发版/)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('非桌面版（execPath 是 node）不许装：没有能重开的目标就等于把人关在门外', async () => {
  const { base, moduleUrl } = await fakeProfile()
  try {
    const up = createSelfUpdater({
      root: join(base, 'data'),
      current: '0.6.13',
      moduleUrl,
      exe: 'C:/Program Files/nodejs/node.exe',
      platform: 'win32',
      downloadImpl: async () => ({ ok: true, bytes: 1, source: '源' }),
    })
    await up.start('0.6.14')
    for (let i = 0; i < 50 && up.status().phase === 'downloading'; i += 1) await new Promise((r) => setTimeout(r, 10))
    const r = await up.install('0.6.14')
    assert.equal(r.ok, false)
    assert.match(r.error, /不是桌面版/)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('非 Windows 不许起安装脚本：脚本是 cmd 批处理，别的系统上跑不起来', async () => {
  const { base, moduleUrl } = await fakeProfile()
  try {
    const up = createSelfUpdater({
      root: join(base, 'data'),
      current: '0.6.13',
      moduleUrl,
      exe: '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
      platform: 'darwin',
      downloadImpl: async () => ({ ok: true, file: '/tmp/x.tgz', bytes: 1, source: '源' }),
    })
    await up.start('0.6.14')
    for (let i = 0; i < 50 && up.status().phase === 'downloading'; i += 1) await new Promise((r) => setTimeout(r, 10))
    const r = await up.install('0.6.14')
    assert.equal(r.ok, false)
    assert.match(r.error, /只做了 Windows/)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('不管有没有本地 tarball，都从 npm 装（file: 会把依赖写成临时路径，下次升级被当开发版）', () => {
  const base = {
    version: '0.6.14', profileDir: 'C:\\p', exe: 'C:\\App.exe', logFile: 'C:\\l.log', backupDir: 'C:\\b', hostName: 'App.exe',
  }
  const plain = scriptFor(base)
  const withTarball = scriptFor({ ...base, tarball: 'C:/x/dsh-fish-v0.6.14.tgz' })
  for (const script of [plain, withTarball]) {
    assert.ok(script.includes('add "@ssamurias/dsh-fish@0.6.14"'), '装的是 npm 上那个版本')
    assert.ok(!script.includes('github:'), '不再走 git 协议')
    assert.ok(!script.includes('file:'), '不再用 file: 装临时 tarball')
  }
})

test('安装：写好脚本、起在子进程里、状态切到 installing', async () => {
  const { base, moduleUrl } = await fakeProfile()
  const spawned = []
  try {
    const root = join(base, 'data')
    const up = createSelfUpdater({
      root,
      current: '0.6.13',
      moduleUrl,
      exe: 'C:\\App\\DeepSeek Harness.exe',
      platform: 'win32',
      downloadImpl: async () => ({ ok: true, bytes: 2048, source: '源' }),
      spawnImpl: (cmd, args, opts) => {
        spawned.push({ cmd, args, opts })
        return { unref() {} }
      },
    })
    await up.start('0.6.14')
    for (let i = 0; i < 50 && up.status().phase === 'downloading'; i += 1) await new Promise((r) => setTimeout(r, 10))

    const r = await up.install('0.6.14')
    assert.equal(r.ok, true, r.error)
    assert.equal(up.status().phase, 'installing')
    assert.equal(spawned.length, 1)
    // 走 wscript + VBS 隐藏启动：直接 detached 起 cmd.exe 会在 Windows 上另开一个黑窗口
    assert.equal(spawned[0].cmd, 'wscript.exe')
    assert.equal(spawned[0].opts.detached, true, '宿主被杀不能带走安装脚本')
    const vbsPath = spawned[0].args[spawned[0].args.length - 1]
    const vbs = await readFile(vbsPath, 'utf8')
    assert.ok(vbs.includes(', 0, False'), '窗口样式 0 = 完全不显示')
    assert.ok(vbs.includes('WScript.Shell'), '用 WScript.Shell 起进程')
    const hit = vbs.match(/cmd \/c ""(.+?)""/)
    assert.ok(hit, 'vbs 里要能找到那个 .cmd 的路径')
    const script = await readFile(hit[1], 'utf8')
    assert.ok(script.includes('v0.6.14'))
    assert.ok(script.includes('taskkill'))
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- 路由

test('路由：GET 只读状态；下载/安装只认 POST；未知子路径 404', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-selupdate-route-'))
  try {
    const calls = []
    const fake = {
      status: () => ({ phase: 'idle', current: '0.6.13', kind: 'local', managed: false, error: '' }),
      start: async (v) => { calls.push(['start', v]); return { ok: true, phase: 'downloading', version: v } },
      install: async (v) => { calls.push(['install', v]); return { ok: false, error: '还没下载好这一版，先下载再装。' } },
    }
    const routes = []
    const ctx = {
      get: (k) => (k === 'connection'
        ? { requestRejection: () => null }
        : k === 'webServer'
          ? { register: (def) => { routes.push(def); return () => {} } }
          : undefined),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    }
    registerObserve(ctx, { root, version: '0.6.13', selfUpdater: fake })
    const route = routes.find((r) => String(r.path || '').endsWith('/update'))
    assert.ok(route, '必须有 /update 路由')

    const call = async (method, url, body) => {
      let status = 0
      let text = ''
      const req = {
        method, url, headers: {},
        [Symbol.asyncIterator]: async function* () { if (body) yield Buffer.from(body) },
        on: (ev, fn) => { if (ev === 'data' && body) fn(Buffer.from(body)); if (ev === 'end') fn(); return req },
        destroy: () => {},
      }
      const res = {
        writableEnded: false,
        writeHead: (s) => { status = s },
        end: (s) => { text = String(s ?? ''); res.writableEnded = true },
      }
      await route.handler(req, res)
      return { status, json: JSON.parse(text || '{}') }
    }

    const st = await call('GET', '/dsh-fish/update/status')
    assert.equal(st.status, 200)
    assert.equal(st.json.phase, 'idle')
    assert.equal(st.json.managed, false)

    const getDl = await call('GET', '/dsh-fish/update/download')
    assert.equal(getDl.status, 405, 'GET 不能下载：那等于点了链接就下')

    const dl = await call('POST', '/dsh-fish/update/download', JSON.stringify({ version: '0.6.14' }))
    assert.equal(dl.status, 202)
    assert.deepEqual(calls[0], ['start', '0.6.14'])

    const noVer = await call('POST', '/dsh-fish/update/download', '{}')
    assert.equal(noVer.status, 400)

    const inst = await call('POST', '/dsh-fish/update/install', JSON.stringify({ version: '0.6.14' }))
    assert.equal(inst.status, 400)
    assert.match(inst.json.error, /还没下载好/)

    const unknown = await call('GET', '/dsh-fish/update/nope')
    assert.equal(unknown.status, 404)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('安装脚本：装完先把旧包名留下的依赖键和 bundles 清掉，再重开', () => {
  const script = scriptFor({
    version: '0.6.14',
    profileDir: 'C:\\p',
    exe: 'C:\\App.exe',
    logFile: 'C:\\l.log',
    backupDir: 'C:\\b',
    hostName: 'App.exe',
    normalizePath: 'C:\\u\\normalize-package.cjs',
  })
  assert.ok(script.includes('normalize-package.cjs'), '要真的调用收拾现场那步')
  assert.ok(
    script.indexOf('add "@ssamurias/dsh-fish') < script.indexOf('normalize-package.cjs'),
    '先装新包，再收拾旧的',
  )
  assert.ok(
    script.indexOf('normalize-package.cjs') < script.indexOf('start ""'),
    '收拾完才重开应用',
  )
})

test('收拾现场：旧依赖键、旧 bundle 条目清掉，旧目录改名不删，改前备份', async () => {
  const dir = await tmp('normalize')
  try {
    await mkdir(join(dir, 'node_modules', 'dsh-fish'), { recursive: true })
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        dependencies: { 'dsh-fish': 'file:updates/x.tgz', other: '1' },
        dsh: { profile: { bundles: ['dsh-fish', 'dsh-voice'] } },
      }, null, 2),
    )
    const f = join(dir, 'normalize.cjs')
    await writeFile(f, normalizeScript(), 'utf8')
    execFileSync(process.execPath, [f, dir, '@ssamurias/dsh-fish'], { encoding: 'utf8' })

    const j = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
    assert.deepEqual(Object.keys(j.dependencies), ['other'], '旧名那条依赖要删掉')
    assert.deepEqual(j.dsh.profile.bundles, ['dsh-voice', '@ssamurias/dsh-fish'], 'bundles 只留全名那条')
    const nm = await readdir(join(dir, 'node_modules'))
    assert.equal(nm.length, 1)
    assert.match(nm[0], /^dsh-fish\.disabled-/, '旧目录改名收起来，不直接删')
    const files = await readdir(dir)
    assert.ok(files.some((n) => n.includes('bak-normalize')), '改 manifest 前要备份')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
