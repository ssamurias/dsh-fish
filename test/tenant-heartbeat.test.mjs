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
 * 后四条用假宿主真的 apply()，把 15 秒的心跳缩成几十毫秒。
 *
 * 心跳缩到 40ms 以后，测试自己做的手脚（读声明、改声明、搬数据目录）很容易正落在某一拍中间，
 * 真的 15 秒一拍时碰上的机会小得多。所以这四条不靠运气：
 *   - 读盘上的声明：声明不是原子写的，读到空的 / 半截的就再读（claimOnDisk）；
 *   - 要动声明、要搬数据目录之前先让心跳停下，等在途的那一拍走完再动手，做完再放开（pause / resume）；
 *   - 等「过了几拍」是真的数到盘上的 beatAt 变了几次，不是睡一会儿（beats）；
 *   - 搬数据目录的那两条路回「搬不动」（Windows 上目录里有文件正开着）就再来一次（postMove）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'

import { claimRoot, beatRoot, beatRootState, releaseRoot, TENANT_FILE, HEARTBEAT_MS } from '../lib/tenant.js'
import { collectBackup, restoreBackup } from '../lib/backup.js'
import { appendEvent } from '../lib/store.js'
import { apply } from '../lib/index.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const BEAT = 40
/** 等一件事最多等多久。按时间等，不按次数等：机器被挤的时候，40ms 的一拍能拖到几百毫秒。 */
const WAIT_MS = 30_000
// 测试自己读写声明用没换过的这两个：boot() 会把 fs.readFile / fs.writeFile 换成带闸的
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

/** base 是临时目录，root 是里面的 dsh-fish：重置、恢复会把旧档搬到 root 的旁边，一起收拾。 */
async function withBase(fn) {
  const base = await fs.mkdtemp(join(tmpdir(), 'fish-heartbeat-'))
  const root = join(base, 'dsh-fish')
  await fs.mkdir(root, { recursive: true })
  const old = { homes: process.env.DSH_FISH_HOMES, loc: process.env.DSH_FISH_LOCATION }
  process.env.DSH_FISH_HOMES = join(base, 'homes.json')
  process.env.DSH_FISH_LOCATION = join(base, 'location.json')
  try {
    return await fn(root, base)
  } finally {
    if (old.homes === undefined) delete process.env.DSH_FISH_HOMES; else process.env.DSH_FISH_HOMES = old.homes
    if (old.loc === undefined) delete process.env.DSH_FISH_LOCATION; else process.env.DSH_FISH_LOCATION = old.loc
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
 * lib/tenant.js 读写声明走的是 fs.readFile / fs.writeFile。这里把这两个换成带记数的
 * （只管这个实例的那一个声明文件，别的路径原样放过），stop() 时换回去：
 *   hb.io      在途的读写个数。pause() 靠它知道在途的那一拍走完了没有
 *   hb.fail    read / write 不为空时，这个实例读 / 写声明直接抛这个错误码（装「别的进程正开着它」）
 *   hb.failed  这样抛过几次
 *   hb.ticks   心跳定时器响过几次（停着的时候不算）
 */
async function boot(root) {
  const f = fakeCtx()
  const file = join(root, TENANT_FILE)
  const hb = { armed: false, paused: false, ticks: 0, io: 0, fail: { read: '', write: '' }, failed: { read: 0, write: 0 } }
  const real = { readFile: fs.readFile, writeFile: fs.writeFile, setInterval: globalThis.setInterval }
  const WHY = { EBUSY: 'resource busy or locked', EPERM: 'operation not permitted' }
  const gated = (kind, fn) => (p, ...a) => {
    if (String(p) !== file) return fn.call(fs, p, ...a)
    return (async () => {
      const code = hb.fail[kind]
      if (code) {
        hb.failed[kind]++
        throw Object.assign(new Error(`${code}: ${WHY[code] ?? 'failed'}`), { code })
      }
      hb.io++
      try { return await fn.call(fs, p, ...a) } finally { hb.io-- }
    })()
  }
  const stop = async () => {
    hb.fail.read = hb.fail.write = ''
    try {
      await Promise.all(f.cleanups.map((c) => (typeof c === 'function' ? c() : c)))
    } finally {
      fs.readFile = real.readFile
      fs.writeFile = real.writeFile
    }
  }
  fs.readFile = gated('read', real.readFile)
  fs.writeFile = gated('write', real.writeFile)
  globalThis.setInterval = (fn, ms, ...a) => {
    if (ms !== HEARTBEAT_MS) return real.setInterval(fn, ms, ...a)
    hb.armed = true
    return real.setInterval(() => { if (!hb.paused) { hb.ticks++; fn() } }, BEAT)
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
   * 这个实例不会自己去读写声明（/reset、/backup/restore 当场跑的那一拍除外，那是调用方等着的）。
   */
  const pause = async () => {
    hb.paused = true
    // 一拍里的读和写是在同一串微任务里接上的（读回来 → 判断 → 当场写），从定时器回调这边
    // 看不到「读完了、还没开始写」的那一刻：连着几次看到没有在途的读写，这一拍就是走完了。
    const end = Date.now() + WAIT_MS
    for (let quiet = 0; quiet < 3;) {
      assert.ok(Date.now() < end, '在途的那一拍心跳一直没走完')
      await sleep(1)
      quiet = hb.io === 0 ? quiet + 1 : 0
    }
  }
  const resume = () => { hb.paused = false }

  /**
   * 盘上的声明；文件不在回 null。声明不是原子写的（writeFile 先截断再写），心跳正写着的那一刻
   * 读到的是空的或半截的 JSON：读到这种就再读，不当成结果。
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
  const lostLogs = () => f.logs.filter((l) => l.includes('占用权丢了'))
  return { ...f, hb, file, note, post, postMove, claimOnDisk, pause, resume, beats, stop, lostLogs }
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
    const real = { readFile: fs.readFile, writeFile: fs.writeFile }
    const fail = (code) => Object.assign(new Error(`${code}: resource busy or locked`), { code })
    try {
      fs.readFile = async (file, ...a) => {
        if (String(file).endsWith(TENANT_FILE)) throw fail('EBUSY')
        return real.readFile(file, ...a)
      }
      assert.deepEqual(await beatRootState(root, 'A', { now: now + 1000 }), { state: 'unknown', code: 'EBUSY' })
      fs.readFile = real.readFile
      fs.writeFile = async (file, ...a) => {
        if (String(file).endsWith(TENANT_FILE)) throw fail('EPERM')
        return real.writeFile(file, ...a)
      }
      assert.deepEqual(await beatRootState(root, 'A', { now: now + 2000 }), { state: 'unknown', code: 'EPERM' })
    } finally {
      fs.readFile = real.readFile
      fs.writeFile = real.writeFile
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

      inst.hb.fail.write = 'EPERM'
      assert.ok(await until(() => inst.hb.failed.write >= 3), '心跳要真的撞上过')
      inst.hb.fail.write = ''
      assert.equal((await inst.note('写不成的那几拍之后')).ok, true)
      assert.deepEqual(inst.lostLogs(), [])

      assert.ok(await inst.beats(2), '之后的心跳照常续期')

      // 真被接管：文件里明写着另一个实例。在两拍之间写——正落在某一拍「读到自己的 id、还没写回」
      // 之间的话，那一拍会把它盖回去（这个读改写的空子不是这里要钉的事）。
      const takeOver = async () => {
        await inst.pause()
        const cur = await inst.claimOnDisk()
        await rawWrite.call(fs, inst.file, JSON.stringify({ ...cur, instanceId: 'OTHER', pid: process.pid, beatAt: Date.now() }), 'utf8')
        inst.resume()
      }
      await takeOver()
      let n = null
      await until(async () => {
        n = await inst.note('被接管之后')
        if (n.ok === false) return true
        // 还没丢、盘上却不是 OTHER 了：那一下没生效，再写一次。丢了以后这里不再碰声明。
        if ((await inst.claimOnDisk())?.instanceId !== 'OTHER') await takeOver()
        return false
      }, { every: BEAT })
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
