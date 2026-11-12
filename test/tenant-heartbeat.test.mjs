/**
 * tenant-heartbeat.test.mjs —— 心跳没续上，不等于「被接管了」
 *
 * 以前 beatRoot 只回 true / false，index.js 见到一次 false 就把这个实例永久置成只读
 * （「这个家已经被另一个实例接管了，之后不再写入」），要重启 DSH 才回得来。
 * 可是没有任何别的实例时，也有三条路会走到 false：
 *   1. 设置页「重开一局」：整个数据目录被搬走，instance.json 跟着走；
 *   2. 「从备份恢复」：包里带着导出那次运行的 instance.json，放回去 instanceId 对不上；
 *   3. 这一次读写碰巧没成（Windows 上别的进程正以不许写的共享方式开着那个文件）。
 * 这里逐条钉住：这三种都不该丢占用权；文件里真写着别的实例时照旧丢、照旧不抢。
 *
 * 还有一种「声明不在了」不能重新占：设置页的「迁移工作区」搬完以后，老目录改名封存，声明跟着走。
 * 这时重新占上，她的写工具会照样回成功、东西留在老位置，重启后走指针去新位置就看不到了。
 * 所以重新占之前先看位置指针（move.js 的 rootMovedAway），搬走了的照旧停写。
 *
 * 认领、心跳、让出三处读改写声明都在 `.instance.lock` 里做，声明是原子写的（临时文件 + 改名）。
 * 所以一拍心跳读到声明是自己的、还没写回的时候，别的实例来接管得排在它后面；设置页那两条要搬
 * 整个数据目录的路也排在在途的那一拍后面。这两样在倒数第二、第三条里钉住。
 *
 * 「迁移工作区」没有排在心跳后面：一拍心跳读到声明是自己的、还没写回的时候，老目录可以正好被封存走。
 * 写声明的那一下不替它建目录，所以这一拍写不成，不会把老目录建回来、把声明写在里面。最后一条钉住。
 *
 * 用假宿主的那几条真的 apply()，把 15 秒的心跳缩成几十毫秒。
 *
 * 心跳缩到 40ms 以后，测试自己做的手脚（读声明、改声明、搬数据目录）很容易正落在某一拍中间，
 * 真的 15 秒一拍时碰上的机会小得多。所以这几条不靠运气：
 *   - 读盘上的声明：这一下没读成、读到的不是完整的 JSON 就再读（claimOnDisk）；
 *   - 要动声明、要搬数据目录之前先让心跳停下，等在途的那一拍走完再动手，做完再放开（pause / resume）；
 *   - 等「过了几拍」是真的数到盘上的 beatAt 变了几次，不是睡一会儿（beats）；
 *   - 搬数据目录的那两条路回「搬不动」（Windows 上目录里有文件正开着）就再来一次（postMove）；
 *   - 要一拍心跳正好做到一半，就真的让它停在那一步（hold），不是算着时间去撞。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { AsyncLocalStorage } from 'node:async_hooks'
import { join, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'

import {
  claimRoot,
  beatRoot,
  beatRootState,
  releaseRoot,
  withFileLock,
  TENANT_FILE,
  CLAIM_LOCK_FILE,
  HEARTBEAT_MS,
} from '../lib/tenant.js'
import { collectBackup, restoreBackup } from '../lib/backup.js'
import { appendEvent } from '../lib/store.js'
import { rootMovedAway } from '../lib/move.js'
import { invalidateLocation } from '../lib/locate.js'
import { apply } from '../lib/index.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const BEAT = 40
/** 等一件事最多等多久。按时间等，不按次数等：机器被挤的时候，40ms 的一拍能拖到几百毫秒。 */
const WAIT_MS = 30_000
// 测试自己读写声明用没换过的这两个：boot() 会把 fs 上的函数都换成带闸的
const rawRead = fs.readFile
const rawWrite = fs.writeFile

/** 轮询到 probe 回真值，或者到时间；回最后一次的值，由调用方断言。 */
async function until(probe, { ms = WAIT_MS, every = 10 } = {}) {
  const end = Date.now() + ms
  for (;;) {
    const v = await probe()
    if (v || Date.now() >= end) return v
    await sleep(every)
  }
}

/** dir 下面（连子目录）哪些文件里有这段字；dir 不在回空表。 */
async function filesWith(dir, needle) {
  const hits = []
  const walk = async (d) => {
    let names = []
    try { names = await fs.readdir(d, { withFileTypes: true }) } catch { return }
    for (const e of names) {
      const p = join(d, e.name)
      if (e.isDirectory()) await walk(p)
      else if ((await rawRead.call(fs, p, 'utf8').catch(() => '')).includes(needle)) hits.push(p.slice(dir.length + 1))
    }
  }
  await walk(dir)
  return hits
}

/** base 是临时目录，root 是里面的 dsh-fish：重置、恢复会把旧档搬到 root 的旁边，一起收拾。 */
async function withBase(fn) {
  const base = await fs.mkdtemp(join(tmpdir(), 'fish-heartbeat-'))
  const root = join(base, 'dsh-fish')
  await fs.mkdir(root, { recursive: true })
  const old = { homes: process.env.DSH_FISH_HOMES, loc: process.env.DSH_FISH_LOCATION }
  process.env.DSH_FISH_HOMES = join(base, 'homes.json')
  process.env.DSH_FISH_LOCATION = join(base, 'location.json')
  // 位置指针读过以后在进程里缓存 2 秒：换了指针文件就清掉，免得上一条用例的位置漏到下一条
  invalidateLocation()
  try {
    return await fn(root, base)
  } finally {
    if (old.homes === undefined) delete process.env.DSH_FISH_HOMES; else process.env.DSH_FISH_HOMES = old.homes
    if (old.loc === undefined) delete process.env.DSH_FISH_LOCATION; else process.env.DSH_FISH_LOCATION = old.loc
    invalidateLocation()
    await fs.rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
}

function fakeCtx() {
  const tools = new Map(), routes = [], cleanups = [], logs = []
  const ctx = {
    tools: { register: (s) => { tools.set(s.name, s); return () => tools.delete(s.name) } },
    webServer: { register: (r) => { routes.push(r); return () => {} } },
    connection: { requestRejection: () => null },
    sessionController: {
      async create() { return { sessionId: `sess-${Date.now()}` } },
      async prompt() {},
      async resolveAgent() { return { agent: { followup() {} } } },
    },
    logger: { info: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) },
    on() { return () => {} },
    effect(fn) { cleanups.push(fn()) },
    get(k) { return ctx[k] },
  }
  return { ctx, tools, routes, cleanups, logs }
}

/**
 * 起一个实例，心跳缩成 BEAT 毫秒（别的定时器不动），并在心跳上装一道闸。
 *
 * 一拍心跳（lib/tenant.js）不只是读一次、写一次声明：看数据目录在不在 → 建 `.instance.lock` → 读声明 →
 * 写临时文件 → 改名盖上去 → 删锁；改名被拒要隔一会儿再试；声明不在了的那一拍还要读位置指针
 * （lib/move.js 的 rootMovedAway）、重新占（又一轮锁）、隔 200ms 再读一次确认。闸不去认这些步骤各是
 * 哪个文件：定时器起的每一拍都放进一个 AsyncLocalStorage 里跑，这一拍里发起的每一次 fs 调用、每一个
 * setTimeout 都认得出来，从发起到回来记在 hb.io 里。换掉的东西 stop() 时全部换回去。
 *   hb.io      这一拍里还没回来的 fs 调用和定时器个数（开着的文件句柄也算）。pause() 靠它知道
 *              在途的那一拍走完了没有
 *   hb.fail    read / write 不为空时，这个实例读声明 / 把写好的声明改名盖上去直接抛这个错误码
 *              （装「别的进程正开着它」）；pointer 不为空时，读位置指针抛这个错误码
 *   hb.failed  这样抛过几次。write 数的是「几次写」：一次写里改名被拒会重试几遍
 *              （lib/tenant.js 的 writeClaim），同一个临时文件只算一次
 *   hb.held    read / readDone / write 不为空时，心跳走到这一步先停住（见 hold）
 *   hb.ticks   心跳定时器响过几次（停着的时候不算）
 */
async function boot(root) {
  const f = fakeCtx()
  const file = join(root, TENANT_FILE)
  const pointer = String(process.env.DSH_FISH_LOCATION ?? '')
  const inBeat = new AsyncLocalStorage()
  const hb = {
    armed: false,
    paused: false,
    ticks: 0,
    io: 0,
    fail: { read: '', write: '', pointer: '' },
    failed: { read: 0, write: 0, pointer: 0 },
    held: { read: null, readDone: null, write: null },
  }
  const real = { fs: {}, setInterval: globalThis.setInterval, setTimeout: globalThis.setTimeout }
  const WHY = { EBUSY: 'resource busy or locked', EPERM: 'operation not permitted' }
  const denied = new Set()
  const holds = []
  /** 这次调用是不是「读声明」「把声明改名盖上去」「读位置指针」里的一样（只认这个实例的那两个文件）。 */
  const stepOf = (name, a) => {
    if (name === 'readFile' && String(a[0]) === file) return 'read'
    if (name === 'readFile' && pointer && String(a[0]) === pointer) return 'pointer'
    if (name === 'rename' && String(a[1]) === file) return 'write'
    return ''
  }
  const gated = (name, fn) => (...a) => {
    const step = stepOf(name, a)
    const beat = inBeat.getStore() === hb
    if (!step && !beat) return fn.apply(fs, a)
    const run = async () => {
      const code = step ? hb.fail[step] : ''
      if (code) {
        if (step === 'write') hb.failed.write = denied.add(String(a[0])).size
        else hb.failed[step]++
        throw Object.assign(new Error(`${code}: ${WHY[code] ?? 'failed'}`), { code })
      }
      const h = beat && step ? hb.held[step] : null
      if (h) {
        hb.held[step] = null
        h.there = true
        await h.gate
      }
      const out = await fn.apply(fs, a)
      const done = beat && step === 'read' ? hb.held.readDone : null
      if (done) {
        hb.held.readDone = null
        done.there = true
        await done.gate
      }
      if (beat && name === 'open') {
        // 往锁文件里写、把它关上走的是句柄自己的方法，不经过 fs.*：句柄关上之前都算在途
        hb.io++
        const close = out.close
        out.close = function () { return close.call(this).finally(() => { hb.io-- }) }
      }
      return out
    }
    if (!beat) return run()
    hb.io++
    return run().finally(() => { hb.io-- })
  }
  const stop = async () => {
    hb.fail.read = hb.fail.write = hb.fail.pointer = ''
    hb.held.read = hb.held.readDone = hb.held.write = null
    for (const h of holds) h.release()
    try {
      await Promise.all(f.cleanups.map((c) => (typeof c === 'function' ? c() : c)))
    } finally {
      Object.assign(fs, real.fs)
      globalThis.setTimeout = real.setTimeout
    }
  }
  for (const [name, fn] of Object.entries(fs)) {
    // watch / glob 回的不是 promise，心跳也用不到，不换
    if (typeof fn !== 'function' || name === 'watch' || name === 'glob') continue
    real.fs[name] = fn
    fs[name] = gated(name, fn)
  }
  globalThis.setTimeout = (fn, ms, ...a) => {
    if (inBeat.getStore() !== hb || typeof fn !== 'function') return real.setTimeout(fn, ms, ...a)
    hb.io++
    return real.setTimeout((...b) => { hb.io--; fn(...b) }, ms, ...a)
  }
  globalThis.setInterval = (fn, ms, ...a) => {
    if (ms !== HEARTBEAT_MS) return real.setInterval(fn, ms, ...a)
    hb.armed = true
    return real.setInterval(() => { if (!hb.paused) { hb.ticks++; inBeat.run(hb, fn) } }, BEAT)
  }
  try {
    try {
      apply(f.ctx, { root })
      await until(() => f.tools.has('her_note') && f.routes.some((r) => r.path === '/dsh-fish/reset'))
    } finally {
      globalThis.setInterval = real.setInterval
    }
    assert.ok(f.tools.has('her_note'), '启动要走完')
    assert.ok(hb.armed, '心跳的定时器要接到')
  } catch (err) {
    await stop().catch(() => {})
    throw err
  }

  /**
   * 让心跳停下：定时器不再起新的一拍，在途的那一拍等它走完。从这里回来到 resume() 之前，
   * 这个实例不会自己去动声明、锁和位置指针（/reset、/backup/restore 当场跑的那一拍除外，那是调用方等着的）。
   */
  const pause = async () => {
    hb.paused = true
    // 一拍里每一处要等的（fs 调用、重试和确认之前的定时器）都记在 hb.io 里，前一处回来到后一处发起
    // 之间只隔着微任务，从定时器回调这边看不到那一刻：看到 0 就是这一拍走完了。连看三次是留的余量。
    const end = Date.now() + WAIT_MS
    for (let quiet = 0; quiet < 3;) {
      assert.ok(Date.now() < end, '在途的那一拍心跳一直没走完')
      await sleep(1)
      quiet = hb.io === 0 ? quiet + 1 : 0
    }
  }
  const resume = () => { hb.paused = false }

  /**
   * 让定时器起的下一拍心跳停在某一步上，只停一次：'read' 是读声明之前（已经拿着 `.instance.lock`）；
   * 'readDone' 是声明刚读完（内容已经读到手，还没判断、没开始写回：临时文件还没写）；
   * 'write' 是把写好的声明改名盖上去之前（读到声明是自己的了，临时文件也写好了，还没写回）。
   * 回来的东西上 there 是「已经停在那儿了」，release() 放它走；停着的时候 hb.io 不是 0。
   */
  const hold = (step) => {
    const h = { there: false, release: null, gate: null }
    h.gate = new Promise((r) => { h.release = r })
    holds.push(h)
    hb.held[step] = h
    return h
  }

  /**
   * 盘上的声明；文件不在回 null。声明是原子写的，读不到半截；可 Windows 上正赶上改名盖上去的那一下
   * 可能读不开，测试自己直接写声明的那一下也可能读到空的：没读成、不是完整的 JSON 就再读，不当成结果。
   */
  const claimOnDisk = async () => {
    const end = Date.now() + WAIT_MS
    for (;;) {
      let why = null
      try {
        const cur = JSON.parse(await rawRead.call(fs, file, 'utf8'))
        if (cur && typeof cur === 'object') return cur
        why = new Error(`${TENANT_FILE} 里不是一个对象`)
      } catch (err) {
        if (err?.code === 'ENOENT') return null
        why = err
      }
      if (Date.now() >= end) throw why
      await sleep(5)
    }
  }

  /** 等心跳真的又续了 n 拍：盘上的 beatAt 换了 n 次。到时间还没等到回 false。 */
  const beats = async (n) => {
    const seen = new Set()
    return until(async () => {
      const cur = await claimOnDisk()
      if (cur) seen.add(cur.beatAt)
      return seen.size > n
    }, { every: BEAT / 2 })
  }

  const note = async (text) => {
    const r = await f.tools.get('her_note').execute({ text }, {})
    return typeof r === 'string' ? JSON.parse(r) : r
  }
  const post = async (path, body) => {
    const route = f.routes.find((r) => r.path === path)
    assert.ok(route, `${path} 要注册`)
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: 'POST', url: path, headers: {} })
    const out = { status: 0, text: '' }
    const res = {
      writableEnded: false,
      writeHead: (s) => { out.status = s },
      setHeader() {},
      end: (s) => { out.text = String(s ?? ''); res.writableEnded = true },
    }
    await route.handler(req, res)
    return { status: out.status, body: JSON.parse(out.text || '{}') }
  }
  /**
   * 搬整个数据目录的那两条路（/reset、/backup/restore）。Windows 上目录里只要有一个文件正被开着，
   * 整个目录就改不了名，接口回 409、什么都没改。心跳可以先停（pause），别的进程（杀毒、索引）
   * 开着里面的文件拦不住：回的是「搬不动」就等一下再来，别的结果原样交回。
   */
  const postMove = async (path, body) => {
    const end = Date.now() + WAIT_MS
    for (;;) {
      const r = await post(path, body)
      const stuck = r.status === 409 && /搬不动|正被占用/.test(String(r.body?.error ?? ''))
      if (!stuck || Date.now() >= end) return r
      await sleep(50)
    }
  }
  /**
   * 装成另一个实例来接管：和真的认领一样先拿 `.instance.lock`，再把声明里的 instanceId 写成 OTHER。
   * 心跳不用先停。
   */
  const takeOver = async () => {
    const done = await withFileLock(join(root, CLAIM_LOCK_FILE), async () => {
      const cur = await claimOnDisk()
      await rawWrite.call(fs, file, JSON.stringify({ ...cur, instanceId: 'OTHER', pid: process.pid, beatAt: Date.now() }), 'utf8')
      return true
    })
    assert.equal(done, true, '接管的人要拿得到锁')
  }
  const lostLogs = () => f.logs.filter((l) => l.includes('占用权丢了'))
  /** 等心跳的定时器又响了 n 次（声明不在盘上、数不了 beatAt 的时候用）。到时间还没等到回 false。 */
  const rings = async (n) => {
    const from = hb.ticks
    return until(() => hb.ticks >= from + n)
  }
  return { ...f, hb, file, note, post, postMove, claimOnDisk, pause, resume, hold, takeOver, beats, rings, stop, lostLogs }
}

test('beatRootState：分得清「是别人」「没有声明」「这次没读成」', async () => {
  await withBase(async (root) => {
    const now = 1_800_000_000_000
    const file = join(root, TENANT_FILE)

    assert.deepEqual(await beatRootState(root, 'A', { now }), { state: 'vacant' }, '文件不存在')

    await claimRoot(root, { instanceId: 'A', now })
    assert.deepEqual(await beatRootState(root, 'A', { now: now + 1000 }), { state: 'mine' })
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).beatAt, now + 1000, '续上了要写新的心跳时间')

    assert.deepEqual(await beatRootState(root, 'B', { now: now + 2000 }), { state: 'lost', owner: 'A' }, '文件里明写着别人')
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).instanceId, 'A', '不是房主不能动声明')

    await releaseRoot(root, 'A', { now: now + 3000 })
    assert.deepEqual(await beatRootState(root, 'A', { now: now + 4000 }), { state: 'vacant' }, '让出过的声明 instanceId 是空的')

    // 读到写了一半的内容
    await fs.writeFile(file, '{"instanceId": "A", "be', 'utf8')
    assert.equal((await beatRootState(root, 'A', { now })).state, 'unknown')
    await fs.writeFile(file, 'null', 'utf8')
    assert.equal((await beatRootState(root, 'A', { now })).state, 'unknown')

    // 读不成（各平台都能造出来的一种：那个名字是个目录）
    await fs.rm(file)
    await fs.mkdir(file)
    const blocked = await beatRootState(root, 'A', { now })
    assert.equal(blocked.state, 'unknown')
    assert.ok(blocked.code, '带上错误码，日志里查得到')
    assert.equal(await beatRoot(root, 'A', { now }), false, 'beatRoot 还是只回这一次续上了没有')
    await fs.rmdir(file)

    assert.deepEqual(await beatRootState(root, '', { now }), { state: 'unknown', code: 'NO_INSTANCE' })
  })
})

test('beatRootState：这一次读或写碰到 EBUSY / EPERM 是 unknown，下一拍照常续上', async () => {
  await withBase(async (root) => {
    const now = 1_800_000_000_000
    await claimRoot(root, { instanceId: 'A', now })
    const real = { readFile: fs.readFile, rename: fs.rename }
    const fail = (code) => Object.assign(new Error(`${code}: resource busy or locked`), { code })
    try {
      fs.readFile = async (file, ...a) => {
        if (String(file).endsWith(TENANT_FILE)) throw fail('EBUSY')
        return real.readFile(file, ...a)
      }
      assert.deepEqual(await beatRootState(root, 'A', { now: now + 1000 }), { state: 'unknown', code: 'EBUSY' })
      fs.readFile = real.readFile
      // 声明是原子写的（临时文件 + 改名）：写不成发生在改名盖上去那一步
      fs.rename = async (from, to, ...a) => {
        if (String(to).endsWith(TENANT_FILE)) throw fail('EPERM')
        return real.rename(from, to, ...a)
      }
      assert.deepEqual(await beatRootState(root, 'A', { now: now + 2000 }), { state: 'unknown', code: 'EPERM' })
      assert.deepEqual((await fs.readdir(root)).sort(), [TENANT_FILE], '没写成的那一次不留临时文件，锁也收掉了')
    } finally {
      fs.readFile = real.readFile
      fs.rename = real.rename
    }
    assert.deepEqual(await beatRootState(root, 'A', { now: now + 3000 }), { state: 'mine' })
  })
})

test('claimRoot：同一个实例在声明没了之后重新占，bootAt 用带回来的启动时间', async () => {
  await withBase(async (root) => {
    const now = 1_800_000_000_000
    await claimRoot(root, { instanceId: 'A', now })
    await fs.rm(join(root, TENANT_FILE))
    const again = await claimRoot(root, { instanceId: 'A', now: now + 60_000, bootAt: now })
    assert.equal(again.ok, true)
    const cur = JSON.parse(await fs.readFile(join(root, TENANT_FILE), 'utf8'))
    assert.equal(cur.bootAt, now)
    assert.equal(cur.beatAt, now + 60_000)
  })
})

test('rootMovedAway：只认「这次启动之后、从这个 root 搬走」的指针；这一次没读成是 unknown', async () => {
  await withBase(async (root, base) => {
    const loc = process.env.DSH_FISH_LOCATION
    const to = join(base, 'new-place', 'dsh-fish')
    const t = 1_800_000_000_000
    const movedAt = new Date(t).toISOString()
    const put = (v) => fs.writeFile(loc, typeof v === 'string' ? v : JSON.stringify(v, null, 2), 'utf8')

    assert.deepEqual(await rootMovedAway(root), { state: 'here' }, '没有指针：没搬过')

    // moveRoot 写下的就是这三个字段
    await put({ root: to, movedAt, from: root })
    assert.deepEqual(await rootMovedAway(root, { since: t - 1 }), { state: 'moved', to })
    assert.deepEqual(await rootMovedAway(root + sep, { since: t }), { state: 'moved', to }, '末尾多一个分隔符、同一毫秒，都算')
    assert.deepEqual(await rootMovedAway(root), { state: 'moved', to }, '不给启动时间就不看早晚')
    assert.deepEqual(
      await rootMovedAway(root, { since: t + 1 }),
      { state: 'here' },
      '指针是这次启动之前写的：root 被钉在老位置、搬过之后又在这里起来的实例，本来就住在这里',
    )
    assert.deepEqual(await rootMovedAway(to, { since: t - 1 }), { state: 'here' }, '问的是新位置自己')
    assert.deepEqual(await rootMovedAway(join(base, 'another'), { since: t - 1 }), { state: 'here' }, '指针说的不是这个 root')

    await put({ root, movedAt, from: root })
    assert.deepEqual(await rootMovedAway(root, { since: t - 1 }), { state: 'here' }, '指针指回了这里')
    await put({ root: to })
    assert.deepEqual(await rootMovedAway(root, { since: t - 1 }), { state: 'here' }, '手写的指针没有 from：不知道是从哪搬的，不算')
    await put({ root: to, from: root })
    assert.deepEqual(await rootMovedAway(root, { since: t - 1 }), { state: 'moved', to }, '没有 movedAt：说不出早晚，按搬走算')
    await put('{"root": "D:')
    assert.deepEqual(await rootMovedAway(root, { since: t - 1 }), { state: 'here' }, '读坏了的指针当没有，和 locate.js 一样')

    // 读不成（各平台都能造出来的一种：那个名字是个目录）
    await fs.rm(loc)
    await fs.mkdir(loc)
    const blocked = await rootMovedAway(root, { since: t - 1 })
    assert.equal(blocked.state, 'unknown')
    assert.ok(blocked.code, '带上错误码')
    await fs.rmdir(loc)
  })
})

test('备份：不带占用声明和会话锁；老包里有的，恢复时不放回', async () => {
  await withBase(async (root) => {
    await appendEvent({ type: 'seed', text: '起点' }, { day: 1, stage: 1, source: 'system' }, root)
    await claimRoot(root, { instanceId: 'EXPORT-RUN' })
    await fs.writeFile(join(root, '.talk-session.lock'), '{"pid":1,"at":0}', 'utf8')
    // 子目录里同名的文件是她的东西，照带
    await fs.mkdir(join(root, 'home'), { recursive: true })
    await fs.writeFile(join(root, 'home', 'instance.json'), '{"note":"她自己放的"}', 'utf8')

    const bundle = JSON.parse(JSON.stringify(await collectBackup(root)))
    const names = bundle.files.map((f) => f.path)
    assert.ok(names.includes('events.jsonl'))
    assert.ok(names.includes('home/instance.json'), '只认顶层那两个')
    assert.ok(!names.includes('instance.json'), '占用声明不进包')
    assert.ok(!names.includes('.talk-session.lock'), '会话锁不进包')
    assert.ok(!bundle.skipped.some((s) => s.includes('instance.json') || s.includes('.talk-session.lock')), '不算「没装进去」')

    // 0.9.8 及以前导出的包：两样都在里面
    const old = {
      ...bundle,
      files: [
        ...bundle.files,
        { path: 'instance.json', size: 2, enc: 'utf8', data: JSON.stringify({ instanceId: 'EXPORT-RUN', beatAt: Date.now(), pid: process.pid, host: 'elsewhere' }) },
        { path: '.talk-session.lock', size: 2, enc: 'utf8', data: '{"pid":1,"at":0}' },
      ],
    }
    await claimRoot(root, { instanceId: 'THIS-RUN', now: Date.now() + 120_000 })
    const r = await restoreBackup(old, root)
    assert.equal(r.ok, true)
    assert.equal(r.restored, bundle.files.length, '回执的个数不算那两个')
    await assert.rejects(fs.stat(join(root, TENANT_FILE)), { code: 'ENOENT' }, '导出那次运行的声明不放回')
    await assert.rejects(fs.stat(join(root, '.talk-session.lock')), { code: 'ENOENT' }, '会话锁不放回')
    assert.equal((await beatRootState(root, 'THIS-RUN')).state, 'vacant', '正在跑的实例看到的是「没有声明」，不是「被接管」')
  })
})

test('重开一局之后：声明当场重新写上，过了心跳她照样能写', async () => {
  await withBase(async (root) => {
    const inst = await boot(root)
    try {
      assert.equal((await inst.note('重置前记一笔')).ok, true)
      const before = await inst.claimOnDisk()
      assert.ok(before?.instanceId, '启动时占上了')

      // 心跳停着的时候重置：回执出来时盘上的声明只能是 /reset 当场写的，不是哪一拍心跳后补的
      await inst.pause()
      const r = await inst.postMove('/dsh-fish/reset', { confirm: 'reset' })
      assert.equal(r.status, 200, JSON.stringify(r.body))
      assert.equal(r.body.ok, true)
      const after = await inst.claimOnDisk()
      assert.equal(after?.instanceId, before.instanceId, '回执出来时声明已经在新的数据目录里，还是这个实例')
      assert.ok(Number(after.bootAt) > 0 && Number(after.bootAt) <= Date.now())
      inst.resume()

      assert.ok(await inst.beats(3), '重置之后心跳照常续期')
      const n = await inst.note('新的一局，过了几拍心跳再记一笔')
      assert.equal(n.ok, true, n.note)
      assert.deepEqual(inst.lostLogs(), [])
    } finally {
      await inst.stop()
    }
  })
})

test('重开一局走的不是设置页那条路（声明只是没了）：下一拍心跳自己补上', async () => {
  await withBase(async (root) => {
    const inst = await boot(root)
    try {
      const before = await inst.claimOnDisk()
      assert.ok(before?.instanceId, '启动时占上了')
      // 在两拍之间删。正落在某一拍「读完、还没写回」之间的话，那一拍会把文件原样写回来，
      // 算续上了，走不到「没有声明 → 重新占」那条路。
      await inst.pause()
      await fs.rm(inst.file, { maxRetries: 20, retryDelay: 50 })
      assert.equal(await inst.claimOnDisk(), null, '声明删掉了')
      inst.resume()

      const back = await until(() => inst.claimOnDisk())
      assert.equal(back?.instanceId, before.instanceId)
      assert.ok(
        await until(() => inst.logs.some((l) => l.includes('占用声明不在了，已经重新写上'))),
        '是同一个实例重新占上的，日志里留一行',
      )
      assert.equal((await inst.note('声明补上之后')).ok, true)
      assert.deepEqual(inst.lostLogs(), [])
    } finally {
      await inst.stop()
    }
  })
})

test('从备份恢复带旧 instanceId 的包之后：过了心跳她照样能写', async () => {
  await withBase(async (root, base) => {
    // 另一次运行导出的包（0.9.8 的导出会把 instance.json 带上）
    const src = join(base, 'export', 'dsh-fish')
    await fs.mkdir(src, { recursive: true })
    await appendEvent({ type: 'seed', text: '起点' }, { day: 1, stage: 1, source: 'system' }, src)
    const bundle = JSON.parse(JSON.stringify(await collectBackup(src)))
    bundle.files.push({
      path: 'instance.json',
      size: 2,
      enc: 'utf8',
      data: JSON.stringify({ instanceId: 'EXPORT-RUN', version: '0.9.8', pid: 1, bootAt: 1, beatAt: 1, host: 'elsewhere', dataDir: src }),
    })

    const inst = await boot(root)
    try {
      const before = await inst.claimOnDisk()
      assert.ok(before?.instanceId, '启动时占上了')

      // 心跳停着的时候恢复：回执出来时盘上的声明只能是 /backup/restore 当场写的
      await inst.pause()
      const r = await inst.postMove('/dsh-fish/backup/restore', bundle)
      assert.equal(r.status, 200, JSON.stringify(r.body))
      assert.equal(r.body.ok, true)
      assert.equal((await inst.claimOnDisk())?.instanceId, before.instanceId, '盘上的声明还是正在跑的这个实例')
      inst.resume()

      assert.ok(await inst.beats(3), '恢复之后心跳照常续期')
      const n = await inst.note('恢复之后，过了几拍心跳再记一笔')
      assert.equal(n.ok, true, n.note)
      assert.deepEqual(inst.lostLogs(), [])
    } finally {
      await inst.stop()
    }
  })
})

test('心跳碰到几次 EBUSY / EPERM：不置只读，之后照常续上；文件里真是别人时照旧丢、不抢回', async () => {
  await withBase(async (root) => {
    const inst = await boot(root)
    try {
      const mine = (await inst.claimOnDisk())?.instanceId
      assert.ok(mine, '启动时占上了')

      inst.hb.fail.read = 'EBUSY'
      assert.ok(await until(() => inst.hb.failed.read >= 3), '心跳要真的撞上过')
      inst.hb.fail.read = ''
      assert.equal((await inst.note('读不成的那几拍之后')).ok, true)

      // 写不成：把写好的声明改名盖上去的那一步被拒。数到第 4 次写被拒的时候，
      // 前 3 次已经把重试用完、整拍没写成了。
      inst.hb.fail.write = 'EPERM'
      assert.ok(await until(() => inst.hb.failed.write >= 4), '心跳要真的撞上过')
      inst.hb.fail.write = ''
      assert.equal((await inst.note('写不成的那几拍之后')).ok, true)
      assert.deepEqual(inst.lostLogs(), [])

      assert.ok(await inst.beats(2), '之后的心跳照常续期')

      // 真被接管：文件里明写着另一个实例。心跳不用停：接管的那一下和一拍心跳的「读到自己的 id →
      // 写回」在同一把锁里，排在它前面或后面，落不到中间（正落在中间的那种在后面单独有一条）。
      await inst.takeOver()
      let n = null
      await until(async () => (n = await inst.note('被接管之后')).ok === false, { every: BEAT })
      assert.equal(n.ok, false, '文件里是别人：停写')
      assert.match(n.note, /另一个实例接管/)
      assert.equal(inst.lostLogs().length, 1)

      // 定时器再响几次：不抢回来
      const ticks = inst.hb.ticks
      assert.ok(await until(() => inst.hb.ticks >= ticks + 3), '丢了以后定时器还在响')
      await inst.pause()
      assert.equal((await inst.claimOnDisk())?.instanceId, 'OTHER', '不抢回来')
      assert.notEqual(mine, 'OTHER')
      inst.resume()

      // 丢了以后，设置页那两条路的「当场重写」也不许把家抢回来
      const r = await inst.post('/dsh-fish/backup/restore', { format: 'x' })
      assert.equal(r.body.ok, false)
      assert.equal((await inst.claimOnDisk())?.instanceId, 'OTHER')
      assert.equal(inst.lostLogs().length, 1)
    } finally {
      await inst.stop()
    }
  })
})

test('迁移数据目录之后：声明不在了也不重新占；她的写工具被拒，老位置没有新的声明、也没有她搬完以后写的东西', async () => {
  await withBase(async (root, base) => {
    const inst = await boot(root)
    try {
      assert.equal((await inst.note('搬之前记一笔')).ok, true)
      assert.ok((await inst.claimOnDisk())?.instanceId, '启动时占上了')

      // 心跳停着的时候搬：老目录要整个改名封存，里面有文件正开着就改不了名
      await inst.pause()
      // 搬的那一下正好有文件在变（启动的收尾还在写）会回 409「对不上」「复制到一半失败」，指针没写、
      // 等于没搬：换一个空文件夹再来。别的结果原样交回。
      let r = null
      await until(async () => {
        r = await inst.post('/dsh-fish/move', { target: await fs.mkdtemp(join(base, 'new-place-')) })
        return !(r.status === 409 && /对不上|复制到一半失败/.test(String(r.body?.error ?? '')))
      }, { every: 50 })
      assert.equal(r.status, 200, JSON.stringify(r.body))
      assert.equal(r.body.ok, true)
      if (!r.body.oldDirMoved) {
        // 没能当场改名（Windows 上别的进程正开着里面的文件，心跳停了也拦不住）：迁移照样算成，
        // 老目录留在原处。这里要钉的是老目录封存之后「声明不在了」的那条路，替它挪开。
        const aside = join(base, 'old-left-behind')
        assert.ok(
          await until(() => fs.rename(root, aside).then(() => true, () => false), { every: 50 }),
          '老目录要挪得开',
        )
      }
      assert.equal(await inst.claimOnDisk(), null, '老位置的声明跟着老目录走了')

      // 刚写下的指针这一次读不成（别的进程正开着它）：不猜，这几拍不重新占。
      // 只看结果、不数读了几次：搬完当场就把实例置成只读的实现，一拍都不会去读指针。
      inst.hb.fail.pointer = 'EBUSY'
      inst.resume()
      assert.ok(await inst.rings(3), '定时器还在响')
      await inst.pause()
      assert.equal(await inst.claimOnDisk(), null, '指针没读成的那几拍没有在老位置重新占')
      inst.hb.fail.pointer = ''
      inst.resume()

      assert.ok(await inst.rings(3), '搬完以后过几拍心跳')
      await inst.pause()
      const n = await inst.note('搬完、过了几拍心跳再记的')
      assert.equal(n.ok, false, '搬走以后不能照样回成功')
      assert.match(n.note, /搬到了新位置/)
      assert.equal(await inst.claimOnDisk(), null, '老位置没有被重新占上')
      assert.ok(!inst.logs.some((l) => l.includes('占用声明不在了')), '没有走「重新写上」那条路')
      // 被拒的那一句哪边都没有落下。（老位置这时可能又有了 logs/ 和一行 `use:her_note fail …` 的
      // 记账，那是写日志、记工具用量时顺手建出来的，不归这里管；她要记的东西不在里面。）
      assert.deepEqual(await filesWith(root, '搬完、过了几拍心跳再记的'), [], '老位置里没有她搬完以后写的东西')
      assert.deepEqual(await filesWith(r.body.to, '搬完、过了几拍心跳再记的'), [])
      assert.ok((await filesWith(r.body.to, '搬之前记一笔')).includes('events.jsonl'), '搬之前记的在新位置的事件流里')
      inst.resume()
    } finally {
      await inst.stop()
    }
  })
})

test('指针是这次启动之前留下的（root 被配置钉在老位置）：声明没了照样重新占', async () => {
  await withBase(async (root, base) => {
    // 以前从这个 root 搬走过；配置里的 root 还钉着这里，重启以后这个实例照样在这里起来
    await fs.writeFile(
      process.env.DSH_FISH_LOCATION,
      JSON.stringify({ root: join(base, 'elsewhere', 'dsh-fish'), movedAt: new Date(Date.now() - 60_000).toISOString(), from: root }, null, 2),
      'utf8',
    )
    const inst = await boot(root)
    try {
      const before = await inst.claimOnDisk()
      assert.ok(before?.instanceId, '启动时占上了')
      await inst.pause()
      await fs.rm(inst.file, { maxRetries: 20, retryDelay: 50 })
      assert.equal(await inst.claimOnDisk(), null, '声明删掉了')
      inst.resume()

      const back = await until(() => inst.claimOnDisk())
      assert.equal(back?.instanceId, before.instanceId, '老指针不拦着它重新占')
      assert.equal((await inst.note('声明补上之后')).ok, true)
    } finally {
      await inst.stop()
    }
  })
})

test('心跳读到声明是自己的、还没写回的时候别的实例来接管：排在这一拍后面，写上的声明不被盖回去', async () => {
  // 没有锁的时候，这一拍接下来的写回会把接管的人刚写上的声明盖掉，两边都当自己是房主。
  await withBase(async (root) => {
    const inst = await boot(root)
    try {
      const mine = (await inst.claimOnDisk())?.instanceId
      assert.ok(mine, '启动时占上了')

      const held = inst.hold('write')
      assert.ok(await until(() => held.there), '等到一拍心跳读完声明、还没写回')
      let took = false
      const taking = inst.takeOver().then(() => { took = true })
      // 给接管的人足够的时间：拿得到锁的话早就写上了
      await until(() => took, { ms: 300 })
      assert.equal(took, false, '那一拍还拿着锁，接管的人等着')
      assert.equal((await inst.claimOnDisk())?.instanceId, mine)
      held.release()
      await taking

      let n = null
      await until(async () => (n = await inst.note('被接管之后')).ok === false, { every: BEAT })
      assert.equal(n.ok, false, '下一拍读到的是别人：停写')
      assert.match(n.note, /另一个实例接管/)
      assert.equal(inst.lostLogs().length, 1)
      assert.ok(await inst.rings(3), '丢了以后定时器还在响')
      await inst.pause()
      assert.equal((await inst.claimOnDisk())?.instanceId, 'OTHER', '接管的人写上的声明没有被那一拍盖回去')
      inst.resume()
    } finally {
      await inst.stop()
    }
  })
})

test('设置页要搬整个数据目录的那两条路排在心跳后面：一拍心跳做到一半时不搬', async () => {
  // Windows 上目录里有文件开着，整个目录就改不了名（恢复回「旧档搬不动（EPERM）」，重开一局回
  // 「有文件正被占用」）。一拍心跳要建锁、写临时文件、改名，开着文件的时间比以前长，所以搬的那一下要和它错开。
  const routes = [
    ['/dsh-fish/backup/restore', async (base) => {
      const src = join(base, 'export', 'dsh-fish')
      await fs.mkdir(src, { recursive: true })
      await appendEvent({ type: 'seed', text: '起点' }, { day: 1, stage: 1, source: 'system' }, src)
      return JSON.parse(JSON.stringify(await collectBackup(src)))
    }],
    ['/dsh-fish/reset', async () => ({ confirm: 'reset' })],
  ]
  for (const [path, makeBody] of routes) {
    await withBase(async (root, base) => {
      const body = await makeBody(base)
      const inst = await boot(root)
      try {
        const before = await inst.claimOnDisk()
        assert.ok(before?.instanceId, '启动时占上了')

        const held = inst.hold('write')
        assert.ok(await until(() => held.there), '等到一拍心跳做到一半（拿着锁，临时文件写好了，还没改名）')
        const going = inst.postMove(path, body)
        // 搬了的话声明就跟着旧档走了，要等这一拍走完才写得回来。给它足够的时间走到搬的那一步：不排队的话早就搬了
        await until(async () => (await inst.claimOnDisk()) === null, { ms: 300 })
        assert.equal((await inst.claimOnDisk())?.instanceId, before.instanceId, `${path}：这一拍没走完，它等着，没有搬`)
        held.release()
        const r = await going
        assert.equal(r.status, 200, JSON.stringify(r.body))
        assert.equal(r.body.ok, true)

        await inst.pause()
        assert.equal((await inst.claimOnDisk())?.instanceId, before.instanceId, `${path}：做完以后盘上的声明还是这个实例`)
        inst.resume()
        assert.equal((await inst.note('搬完之后再记一笔')).ok, true)
        assert.deepEqual(inst.lostLogs(), [])
      } finally {
        await inst.stop()
      }
    })
  }
})

test('心跳读到声明是自己的、还没写回的时候数据目录被迁走：这一拍不把老目录建回来，声明不写在老位置，她的写工具被拒', async () => {
  // 写声明的那一下要是先替它建目录（lib/store.js 的 writeAtomic 就是先 mkdir -p），这一拍会把刚封存走的
  // 老目录建回来、把声明写在里面：之后每一拍读到的都是自己的声明，不会再去看位置指针，她的写工具一直回
  // 成功，东西落在老位置，重启后走指针去新位置就看不到了。
  await withBase(async (root, base) => {
    const inst = await boot(root)
    try {
      assert.equal((await inst.note('搬之前记一笔')).ok, true)
      assert.ok((await inst.claimOnDisk())?.instanceId, '启动时占上了')

      const held = inst.hold('readDone')
      assert.ok(await until(() => held.there), '等到一拍心跳读完声明（读到的是自己的）、还没开始写回')
      // 这一拍停着的时候搬。它手里没有开着的文件（锁文件建好就关上了），拦不住老目录改名。
      // 搬的那一下正好有文件在变（启动的收尾还在写）会回 409，等于没搬：换一个空文件夹再来。
      let r = null
      await until(async () => {
        r = await inst.post('/dsh-fish/move', { target: await fs.mkdtemp(join(base, 'new-place-')) })
        return !(r.status === 409 && /对不上|复制到一半失败/.test(String(r.body?.error ?? '')))
      }, { every: 50 })
      assert.equal(r.status, 200, JSON.stringify(r.body))
      assert.equal(r.body.ok, true)
      if (!r.body.oldDirMoved) {
        // 没能当场改名（Windows 上别的进程正开着里面的文件）：迁移照样算成，老目录留在原处。替它挪开。
        const aside = join(base, 'old-left-behind')
        assert.ok(
          await until(() => fs.rename(root, aside).then(() => true, () => false), { every: 50 }),
          '老目录要挪得开',
        )
      }
      await assert.rejects(fs.stat(root), { code: 'ENOENT' }, '老目录封存走了，那一拍还停在读完声明的地方')

      // 放开，让这一拍接着去写回；定时器先不起新的一拍，等它走完就看
      held.release()
      await inst.pause()
      await assert.rejects(fs.stat(root), { code: 'ENOENT' }, '那一拍写回的时候没有把老目录建回来')
      inst.resume()

      assert.ok(await inst.rings(3), '搬完以后过几拍心跳')
      await inst.pause()
      const n = await inst.note('搬完、过了几拍心跳再记的')
      assert.equal(n.ok, false, '搬走以后不能照样回成功')
      assert.match(n.note, /搬到了新位置/)
      assert.equal(await inst.claimOnDisk(), null, '老位置没有声明')
      // 被拒的那一下会顺手把老位置建出来（写日志、记工具用量），那不归这里管；声明和它的临时文件不能在里面
      assert.deepEqual(
        (await fs.readdir(root).catch(() => [])).filter((name) => name.startsWith(TENANT_FILE)),
        [],
        '也没有声明的临时文件',
      )
      assert.ok(!inst.logs.some((l) => l.includes('占用声明不在了')), '没有走「重新写上」那条路')
      assert.deepEqual(await filesWith(root, '搬完、过了几拍心跳再记的'), [], '老位置里没有她搬完以后写的东西')
      assert.deepEqual(await filesWith(r.body.to, '搬完、过了几拍心跳再记的'), [])
      assert.ok((await filesWith(r.body.to, '搬之前记一笔')).includes('events.jsonl'), '搬之前记的在新位置的事件流里')
      inst.resume()
    } finally {
      await inst.stop()
    }
  })
})
