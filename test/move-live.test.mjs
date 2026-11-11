/**
 * move-live.test.mjs —— 迁移的时候插件还在跑、她还在写
 *
 * move.test.mjs 测的是一份不动的档。真用的时候是在设置页里点的，插件开着：
 *   1. 搬完到重启之间，这个进程手里还是启动时算好的老 root。老目录已经改名封存，
 *      再 appendEvent 会把老位置重新建出来、写出一份只有新事件的 events.jsonl；
 *      重启后走指针去新位置，这几条不在里面。
 *   2. 搬的途中事件流又被追加：验字节比的是复制前数到的大小。追加在复制之后，
 *      对得上、报成功，新位置里没有那几条；追加在复制之前，对不上、报失败。
 *   3. 验字节失败时目标里留着整份拷贝，再点同一个文件夹被「已经有一个 dsh-fish
 *      且不是空的」拒掉，回执没说要先删。
 *
 * 不靠计时：包一层 fs.promises.copyFile，在指定的那一步往源里写。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, rm, appendFile } from 'node:fs/promises'
import { existsSync, promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'

import { planMove, moveRoot } from '../lib/move.js'
import { appendEvent, readEvents, rootDir } from '../lib/store.js'
import { guardWrite } from '../lib/tenant.js'
import { logLine } from '../lib/log.js'
import { invalidateLocation, movedTo, unsealRoot, MOVED_NOTE } from '../lib/locate.js'

const CTX = { day: 1, stage: 1, source: 'system' }

async function withEnv(fn) {
  const box = await mkdtemp(join(tmpdir(), 'fish-move-live-'))
  const src = join(box, 'old', '.dsh-fish')
  const dst = join(box, 'D')
  const loc = join(box, 'loc.json')
  const prev = { loc: process.env.DSH_FISH_LOCATION, home: process.env.DSH_FISH_HOME }
  process.env.DSH_FISH_LOCATION = loc
  delete process.env.DSH_FISH_HOME
  invalidateLocation()
  await mkdir(join(src, 'home'), { recursive: true })
  await mkdir(dst, { recursive: true })
  await writeFile(join(src, 'config.json'), '{"growthDays":30}')
  await writeFile(join(src, 'home', 'a.md'), 'a\n')
  await appendEvent({ type: 'seed', text: '起点' }, CTX, src)
  await appendEvent({ type: 'meta', text: '搬家前的一条' }, CTX, src)
  try {
    return await fn({ box, src, dst, loc })
  } finally {
    unsealRoot(src)
    if (prev.loc === undefined) delete process.env.DSH_FISH_LOCATION
    else process.env.DSH_FISH_LOCATION = prev.loc
    if (prev.home !== undefined) process.env.DSH_FISH_HOME = prev.home
    invalidateLocation()
    await rm(box, { recursive: true, force: true }).catch(() => {})
  }
}

/** 包一层 copyFile：before / after 在复制某个文件的前后跑一次。 */
async function withCopyHook({ before, after }, fn) {
  const real = fsp.copyFile
  fsp.copyFile = async (from, to, mode) => {
    if (before) await before(String(from), String(to))
    const r = await real.call(fsp, from, to, mode)
    if (after) await after(String(from), String(to))
    return r
  }
  try { return await fn() } finally { fsp.copyFile = real }
}

const texts = async (root) => (await readEvents(root)).events.map((e) => e.text)

test('搬完到重启之间：事件流写入被拒，老位置不会被重新建出来，新位置的事件流完好', async () => {
  await withEnv(async ({ src, dst }) => {
    const r = await moveRoot(null, { root: src, target: dst })
    assert.equal(r.ok, true, r.why)
    assert.equal(r.oldDirMoved, true)
    assert.equal(r.readOnly, true, '回执要带上「重启前只读」')
    assert.match(r.note, /重启之前她记不下新的事/)
    assert.equal(movedTo(src), r.to)

    // 插件还在跑：root 是启动时算的那个老位置
    await assert.rejects(
      appendEvent({ type: 'meta', text: '搬家后、重启前的一条' }, CTX, src),
      (err) => err.code === 'EFISHMOVED' && err.message === MOVED_NOTE,
    )
    // 工具那一侧说的是同一句，不是「被另一个实例占着」
    const g = guardWrite({ root: src, tenant: { ok: true } }, {}, 'her_note')
    assert.deepEqual(g, { ok: false, note: MOVED_NOTE })
    // 被拒的那两下各记了一行日志；日志跟到新位置去，不把老位置建出来
    assert.equal(logLine('info', ['搬完之后的一行'], src), true)
    assert.equal(existsSync(src), false, '老位置不能被重新建出来')
    const log = await readFile(join(r.to, 'logs', 'dsh-fish.log'), 'utf8')
    assert.match(log, /事件没写（数据目录已经迁走，等重启）： type=meta/)
    assert.match(log, /写入被拒（数据目录已经迁走，等重启）： tool=her_note/)

    // 重启：rootDir() 走指针。两份事件流（新位置、封存的老目录）都只有搬之前的
    assert.equal(rootDir(), r.to)
    assert.deepEqual(await texts(rootDir()), ['起点', '搬家前的一条'])
    assert.deepEqual(await texts(r.oldDir), ['起点', '搬家前的一条'])
    // 新位置自己是能写的
    await appendEvent({ type: 'meta', text: '重启后的一条' }, CTX, r.to)
    assert.deepEqual(await texts(r.to), ['起点', '搬家前的一条', '重启后的一条'])
  })
})

test('搬的途中事件流又被追加（复制它之前、之后各一条）：都跟到新位置，回执的字节数按补齐后的算', async () => {
  await withEnv(async ({ src, dst }) => {
    let hits = 0
    const r = await withCopyHook({
      // 数完文件之后、复制到它之前：以前验字节对不上，整趟报失败
      before: async (from) => {
        if (basename(from) !== 'events.jsonl') return
        hits++
        await appendEvent({ type: 'meta', text: '搬家途中：复制之前' }, CTX, src)
      },
      // 复制完它之后：以前验字节对得上、报成功，这一条不在新位置
      after: async (from) => {
        if (basename(from) !== 'events.jsonl') return
        hits++
        await appendEvent({ type: 'meta', text: '搬家途中：复制之后' }, CTX, src)
      },
    }, () => moveRoot(null, { root: src, target: dst }))
    assert.equal(hits, 2, '两处钩子都要真的走到')
    assert.equal(r.ok, true, r.why)
    const want = ['起点', '搬家前的一条', '搬家途中：复制之前', '搬家途中：复制之后']
    assert.deepEqual(await texts(r.to), want)
    // 两边逐字节一样
    const a = await readFile(join(r.to, 'events.jsonl'))
    const b = await readFile(join(r.oldDir, 'events.jsonl'))
    assert.ok(a.equals(b), '新位置的事件流要和封存的老目录里那份一模一样')
    // 补上的是「复制之后」那一条的长度
    const lines = a.toString('utf8').trimEnd().split('\n')
    assert.equal(r.caughtUp, Buffer.byteLength(lines[3] + '\n'))
    const sizes = await Promise.all(['events.jsonl', 'config.json', join('home', 'a.md')].map(async (f) => (await stat(join(r.to, f))).size))
    assert.equal(r.bytes, sizes.reduce((n, x) => n + x, 0))
  })
})

test('搬的途中别的文件变了：报失败，目标里那份改名挪开，她在老地方照常能写，原样再点一次能成', async () => {
  await withEnv(async ({ src, dst, loc }) => {
    let changed = false
    const r = await withCopyHook({
      before: async (from) => {
        if (changed || basename(from) !== 'config.json') return
        changed = true
        await appendFile(from, '\n')
      },
    }, () => moveRoot(null, { root: src, target: dst }))
    assert.equal(changed, true)
    assert.equal(r.ok, false)
    assert.match(r.why, /1 个文件复制后对不上（例如 config\.json）/)
    assert.match(r.why, /已改名为 .*dsh-fish\.partial-\d+，可以原样再点一次/)
    // 目标里没有 dsh-fish 了，整份在 .partial-* 里
    const kids = await readdir(dst)
    assert.equal(kids.length, 1)
    assert.match(kids[0], /^dsh-fish\.partial-\d+$/)
    assert.equal(r.partial, join(dst, kids[0]))
    assert.ok(existsSync(join(r.partial, 'events.jsonl')))
    // 等于没迁过：指针没写，老位置没被封，照常能写
    await assert.rejects(stat(loc))
    assert.equal(movedTo(src), '')
    await appendEvent({ type: 'meta', text: '失败之后的一条' }, CTX, src)
    // 再点同一个文件夹：以前是「已经有一个 dsh-fish 且不是空的」
    assert.equal((await planMove(src, dst)).ok, true)
    const again = await moveRoot(null, { root: src, target: dst })
    assert.equal(again.ok, true, again.why)
    assert.deepEqual(await texts(again.to), ['起点', '搬家前的一条', '失败之后的一条'])
  })
})

test('指针写不下去：老位置解封，目标里那份改名挪开', async () => {
  await withEnv(async ({ box, src, dst }) => {
    // 指针文件的上级是个普通文件，mkdir 必败
    await writeFile(join(box, 'blocker'), 'x')
    process.env.DSH_FISH_LOCATION = join(box, 'blocker', 'loc.json')
    invalidateLocation()
    const r = await moveRoot(null, { root: src, target: dst })
    assert.equal(r.ok, false)
    assert.match(r.why, /记不下新位置/)
    assert.match(r.why, /已改名为 .*dsh-fish\.partial-\d+/)
    assert.equal(movedTo(src), '', '没迁成就不能把老位置封着')
    assert.deepEqual(await readdir(dst), [basename(r.partial)])
    await appendEvent({ type: 'meta', text: '还在老地方' }, CTX, src)
    assert.deepEqual(await texts(src), ['起点', '搬家前的一条', '还在老地方'])
  })
})

test('POST /move 成功后占用状态原地变只读，理由说的是搬家', async () => {
  await withEnv(async ({ src, dst }) => {
    const { registerObserve } = await import('../lib/observe.js')
    const { Readable } = await import('node:stream')
    const routes = []
    const ctx = {
      get: (k) => (k === 'connection'
        ? { requestRejection: () => null }
        : k === 'webServer'
          ? { register: (def) => { routes.push(def); return () => {} } }
          : undefined),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    }
    const tenant = { ok: true, instanceId: 'i-1', why: '' }
    const tenancy = { root: src, herDir: join(src, 'home'), tenant }
    const handle = registerObserve(ctx, { root: src, tenancy })
    try {
      const route = routes.find((r) => r.path === '/dsh-fish/move')
      assert.ok(route, '必须有 /move 路由')
      const req = Readable.from([Buffer.from(JSON.stringify({ target: dst }))])
      Object.assign(req, { method: 'POST', url: '/dsh-fish/move', headers: { 'content-type': 'application/json' } })
      let status = 0
      let text = ''
      const res = {
        writableEnded: false,
        writeHead: (s) => { status = s },
        setHeader: () => {},
        end: (s) => { text = String(s ?? ''); res.writableEnded = true },
      }
      await route.handler(req, res)
      assert.equal(status, 200, text)
      assert.equal(JSON.parse(text).readOnly, true)
      // 同一个对象（启动时交给观察者、建会话那几处的就是它），不是换了一个新的
      assert.equal(tenancy.tenant, tenant)
      assert.equal(tenant.ok, false)
      assert.equal(tenant.instanceId, 'i-1')
      assert.match(tenant.why, /刚搬到了新位置，重启 DSH 之前这边只读/)
    } finally {
      handle.dispose()
    }
  })
})
