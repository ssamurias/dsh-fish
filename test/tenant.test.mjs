/**
 * tenant.test.mjs —— 「谁在写、写给哪个家」（2026-10-28 m01319 三条规矩）
 *
 * 房客把插件文件夹搬过一次，结果两个工作区、两份大肥鱼、共用一条事件流。
 * 根因有三层，这里逐层钉住：
 *   1. root 是进程级解析的 → 两个实例会解析到同一个家（claim/heartbeat 负责认出）
 *   2. 写入不看调用者 → 别人的会话也能写进这个家（checkCaller 负责拒）
 *   3. 事件流没有「谁」→ 事后分不清（schema 的 sessionId 负责记）
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  callerOf,
  checkCaller,
  guardWrite,
  claimRoot,
  beatRoot,
  releaseRoot,
  isInside,
  normPath,
  withFileLock,
  TENANT_FILE,
  CLAIM_LOCK_FILE,
  CLAIM_TTL_MS,
} from '../lib/tenant.js'
import { validateEvent } from '../lib/schema.js'
import { writeSelfDoc } from '../lib/selfdoc.js'
import { collectBackup, restoreBackup } from '../lib/backup.js'

const made = []
async function tmpRoot() {
  const dir = join(tmpdir(), `fish-tenant-${process.pid}-${Math.random().toString(16).slice(2, 8)}`)
  await fs.mkdir(dir, { recursive: true })
  made.push(dir)
  return dir
}
after(async () => {
  for (const d of made.reverse()) await fs.rm(d, { recursive: true, force: true }).catch(() => {})
})

test('isInside / normPath：大小写、末尾斜杠、越界都不认错', () => {
  assert.equal(isInside('D:\\a\\home', 'D:\\a'), true)
  assert.equal(isInside('D:\\a', 'D:\\a\\home'), false)
  assert.equal(isInside('D:\\a-other', 'D:\\a'), false, '前缀相同但不同目录不算在里面')
  assert.equal(normPath('D:\\a\\'), normPath('D:\\a'))
  if (process.platform === 'win32') assert.equal(normPath('D:/A/B'), normPath('d:\\a\\b'))
})

test('callerOf：从 exec 里读 sessionId 与 header.cwd；读不到就给空串', () => {
  const exec = { agent: { session: { id: 'sess_1', header: { cwd: 'D:\\a\\home' } } } }
  const who = callerOf(exec)
  assert.equal(who.sessionId, 'sess_1')
  assert.equal(who.cwd, 'D:\\a\\home')
  assert.equal(callerOf({}).sessionId, '')
  assert.equal(callerOf({}).cwd, '')
  assert.equal(callerOf(undefined).cwd, '')
  // header 缺 cwd（宿主允许）：有会话但没 cwd
  assert.equal(callerOf({ agent: { session: { id: 'x', header: {} } } }).cwd, '')
})

test('checkCaller：cwd 在 root 里放行；在外面拒绝并说清楚', () => {
  const root = 'D:\\houses\\a'
  const inside = checkCaller(root, { agent: { session: { id: 's1', header: { cwd: 'D:\\houses\\a\\home' } } } })
  assert.equal(inside.ok, true)
  assert.equal(inside.sessionId, 's1')

  const outside = checkCaller(root, { agent: { session: { id: 's2', header: { cwd: 'D:\\houses\\b' } } } })
  assert.equal(outside.ok, false)
  assert.match(outside.why, /另一个家|不属于/)
  assert.equal(outside.sessionId, 's2', '拒绝时也要留下是谁')

  // 她自己的房间（herDir）允许
  const her = checkCaller(root, { agent: { session: { id: 's3', header: { cwd: 'E:\\her-room' } } } }, { herDir: 'E:\\her-room' })
  assert.equal(her.ok, true)

  // 没有 exec（定时器 / 单测 / 系统路径）：放行但不冒充会话
  const sys = checkCaller(root, undefined)
  assert.equal(sys.ok, true)
  assert.equal(sys.sessionId, '')
})

test('checkCaller：出门那条会话 cwd 在别人家，写事件仍放行；身份文件不放行', async () => {
  const root = await tmpRoot()
  // 关键：工作区在**她家外面**（真机出门就是这样），不是 root 的子目录
  const ws = await fs.mkdtemp(join(tmpdir(), `fish-outside-${process.pid}-`))
  made.push(ws)
  await fs.writeFile(
    join(root, 'outings.json'),
    JSON.stringify({
      version: 1,
      outings: [
        { sessionId: 'session-out', workspaceId: 'w1', workspaceName: '素材', cwd: ws, startedAt: Date.now(), status: 'active' },
      ],
    }),
    'utf8',
  )
  const exec = { session: { header: { id: 'session-out', cwd: ws } } }

  // 出门这一条：写回自己家的事件照收（2026-10-29 bring_back 真机 bug 的同一条根因）
  const out = checkCaller(root, exec)
  assert.equal(out.ok, true)
  assert.equal(out.outside, true)
  assert.equal(out.sessionId, 'session-out')

  // 身份文件显式关掉这个例外：出门会话改不了自己的身份
  const idres = checkCaller(root, exec, { herDir: join(root, 'home'), tool: '身份文件', outsideOk: false })
  assert.equal(idres.ok, false)

  // 不是当前那趟出门的会话（别人的窗口）仍然拒
  const other = checkCaller(root, { session: { header: { id: 'session-other', cwd: ws } } })
  assert.equal(other.ok, false)
  assert.match(other.why, /另一个家/)
})

test('claimRoot：先来的占住，后来的认出「这个家已经有人住」且不抢', async () => {
  const root = await tmpRoot()
  const first = await claimRoot(root, { version: '0.6.6', instanceId: 'A' })
  assert.equal(first.ok, true)

  const second = await claimRoot(root, { version: '0.6.6', instanceId: 'B' })
  assert.equal(second.ok, false)
  assert.equal(second.owner.instanceId, 'A')
  assert.match(second.why, /另一个插件实例|已经被/)

  // 认输的那一个不能把文件改写掉
  const raw = JSON.parse(await fs.readFile(join(root, TENANT_FILE), 'utf8'))
  assert.equal(raw.instanceId, 'A')
})

test('claimRoot：同机重启时旧 pid 已死 → 心跳再新也能立刻接管（否则重启后 45 秒写不了）', async () => {
  const root = await tmpRoot()
  const now = 1_800_000_000_000
  await claimRoot(root, { instanceId: 'A', now, pid: 0, host: 'testhost' })
  const restarted = await claimRoot(root, { instanceId: 'B', now: now + 1000, pid: process.pid, host: 'testhost' })
  assert.equal(restarted.ok, true, '上个进程没了就不该等 TTL')
  const raw = JSON.parse(await fs.readFile(join(root, TENANT_FILE), 'utf8'))
  assert.equal(raw.instanceId, 'B')
  assert.equal(raw.host, 'testhost')
})

test('claimRoot：同机 pid 还活着 → 心跳新鲜时仍然拒绝（两份大肥鱼同时开着）', async () => {
  const root = await tmpRoot()
  const now = 1_800_000_000_000
  await claimRoot(root, { instanceId: 'A', now, pid: process.pid, host: 'testhost' })
  const other = await claimRoot(root, { instanceId: 'B', now: now + 1000, pid: process.pid, host: 'testhost' })
  assert.equal(other.ok, false)
})

test('claimRoot：旧声明过期（心跳断了）可以被接管；release 之后也能立刻接管', async () => {
  const root = await tmpRoot()
  const now = 1_800_000_000_000
  await claimRoot(root, { instanceId: 'A', now })
  // 过期：beatAt 比 now 早了超过 TTL
  const fresh = await claimRoot(root, { instanceId: 'B', now: now + CLAIM_TTL_MS + 1 })
  assert.equal(fresh.ok, true)
  assert.equal(fresh.instanceId, 'B')

  assert.equal(await releaseRoot(root, 'B', { now: now + CLAIM_TTL_MS + 2 }), true)
  const again = await claimRoot(root, { instanceId: 'C', now: now + CLAIM_TTL_MS + 3 })
  assert.equal(again.ok, true, '释放之后下一个实例要能立刻接管，不用等 TTL')
})

test('beatRoot：房主续期成功，被接管的一方法续不上（也不抢回）', async () => {
  const root = await tmpRoot()
  const now = 1_800_000_000_000
  await claimRoot(root, { instanceId: 'A', now })
  assert.equal(await beatRoot(root, 'A', { now: now + 1000 }), true)
  assert.equal(await beatRoot(root, 'Ghost', { now: now + 2000 }), false)

  const raw = JSON.parse(await fs.readFile(join(root, TENANT_FILE), 'utf8'))
  assert.equal(raw.instanceId, 'A', '续期失败不能改 ownership')
})

test('guardWrite：家被别人占着时，任何写入都拒绝；否则交给 checkCaller', () => {
  const root = 'D:\\houses\\a'
  const blocked = guardWrite(
    { root, tenant: { ok: false, why: '这个家被另一个实例占着' } },
    { agent: { session: { id: 's1', header: { cwd: 'D:\\houses\\a\\home' } } } },
    'growth_commit',
  )
  assert.equal(blocked.ok, false)
  assert.match(blocked.note, /占着|占用|这个家/)

  const ok = guardWrite(
    { root, herDir: '', tenant: { ok: true } },
    { agent: { session: { id: 's2', header: { cwd: 'D:\\houses\\a\\home' } } } },
    'growth_commit',
  )
  assert.deepEqual(ok, { ok: true, sessionId: 's2' })
})

test('schema：sessionId 落进事件（裁剪控制字符、上限 120），没有就不写这个字段', () => {
  const base = { type: 'utterance', text: '今天的风是往南吹的。' }
  const withId = validateEvent({ ...base, sessionId: '  sess_abc\n' }, { day: 3, stage: 2 })
  assert.equal(withId.sessionId, 'sess_abc')

  const long = validateEvent({ ...base, sessionId: 'x'.repeat(500) }, { day: 3, stage: 2 })
  assert.equal(long.sessionId.length, 120)

  const none = validateEvent(base, { day: 3, stage: 2 })
  assert.equal('sessionId' in none, false)
})

test('身份文件：家被别人占着 / 调用者不在这个家 → 不落盘，但也不抛错', async () => {
  const root = await tmpRoot()
  const blocked = await writeSelfDoc(root, { tenant: { ok: false, why: '这个家被另一个实例占着' } })
  assert.equal(blocked.ok, false)
  assert.match(blocked.why, /占着|占用|这个家/)

  const outside = await writeSelfDoc(root, {
    exec: { agent: { session: { id: 's9', header: { cwd: 'D:\\somewhere\\else' } } } },
  })
  assert.equal(outside.ok, false)
  assert.match(outside.why, /另一个家|不属于/)
})

// ---------------------------------------------------------------------------
// 跨进程锁（2026-10-29 m02162）
//
// 占用权只回答「谁是房主」，回答不了「两个实例同时启动、各自读到空 home.json」。
// 房客日志里成对的 `home.json.*.tmp` 就是那个窗口留下的。锁要保证：
//   1. 同一时刻只有一个持有者；后来的等着，不交叉。
//   2. 上一任死在临界区里（锁文件还在、mtime 很老）→ 能接管，不永久卡死。
//   3. 等太久就拿不到（locked:false），由调用方决定只读复用还是失败——
//      绝不硬闯去建第二条会话。
// ---------------------------------------------------------------------------

test('withFileLock：两次并发进来是串行的，后来的等前一个出来', async () => {
  const root = await tmpRoot()
  const lock = join(root, '.lock')
  const order = []
  const first = withFileLock(lock, async () => {
    order.push('a-in')
    await new Promise((r) => setTimeout(r, 120))
    order.push('a-out')
    return 'A'
  })
  // 给第一个足够时间抢到锁（文件锁不是排队公平的，但这两个调用间隔很短）
  await new Promise((r) => setTimeout(r, 30))
  const second = withFileLock(lock, async () => {
    order.push('b-in')
    order.push('b-out')
    return 'B'
  })
  const [a, b] = await Promise.all([first, second])
  assert.equal(a, 'A')
  assert.equal(b, 'B')
  assert.deepEqual(order, ['a-in', 'a-out', 'b-in', 'b-out'])
  await assert.rejects(fs.stat(lock), /ENOENT/, '出来后锁文件要收掉')
})

test('withFileLock：上一任死在临界区（陈旧锁）能被接管', async () => {
  const root = await tmpRoot()
  const lock = join(root, '.lock')
  await fs.writeFile(lock, JSON.stringify({ pid: 999999, at: 0 }))
  const old = (Date.now() - 10 * 60_000) / 1000
  await fs.utimes(lock, old, old)
  const got = await withFileLock(lock, async () => 'took-over', { ttl: 30_000, timeout: 1_000 })
  assert.equal(got, 'took-over')
})

test('withFileLock：等不到就返回 locked:false，不硬闯、也不删别人的锁', async () => {
  const root = await tmpRoot()
  const lock = join(root, '.lock')
  let release
  const holder = withFileLock(lock, () => new Promise((r) => { release = r }))
  await new Promise((r) => setTimeout(r, 20))
  const res = await withFileLock(lock, async () => 'should-not-run', { timeout: 120, wait: 20 })
  assert.equal(res.ok, false)
  assert.equal(res.locked, false)
  assert.match(res.why, /另一个实例|交还/)
  // 别人的锁不能被超时那方删掉（否则两个进程会同时进临界区）——先查，再放行
  assert.equal((await fs.stat(lock)).isFile(), true)
  release('held')
  assert.equal(await holder, 'held')
  await assert.rejects(fs.stat(lock), /ENOENT/, '持有者出来后锁要收掉')
})

test('withFileLock：fn 抛错也要把锁收掉', async () => {
  const root = await tmpRoot()
  const lock = join(root, '.lock')
  await assert.rejects(withFileLock(lock, async () => { throw new Error('boom') }), /boom/)
  await assert.rejects(fs.stat(lock), /ENOENT/)
})

// ---- issue #37：Windows 上 open(...,'wx') 会在文件正被删除时抛 EPERM ----
// 真机表现：换会话时 `ensureTalkSession` 偶尔直接返回「建会话的锁没拿到：EPERM…」，
// 这次轮换就此失败；tenant.test.mjs 那条并发用例也是时好时坏（25 次里红 2 次）。
// 修法是 EPERM 走一条**独立的、受 timeout 约束**的重试分支（不能并进 EEXIST：
// 那里 stat 失败判 stale 后 continue 不看 timeout，真权限错误会死循环）。
test('withFileLock：Windows 的 EPERM 是暂时性的，要重试而不是直接抛', async () => {
  const root = await tmpRoot()
  const lock = join(root, '.lock')
  const realOpen = fs.open
  let hits = 0
  // 不管在哪个平台都把前两次 open 打成 EPERM：win32 上应当重试成功，
  // POSIX 上应当原样抛出去（那里 EPERM 是真没权限）。
  fs.open = async (...args) => {
    if (hits < 2) {
      hits += 1
      const e = new Error('EPERM: operation not permitted, open')
      e.code = 'EPERM'
      throw e
    }
    return realOpen.apply(fs, args)
  }
  let ran = 0
  try {
    if (process.platform === 'win32') {
      const out = await withFileLock(lock, async () => { ran += 1; return 'ok' }, { timeout: 2_000, wait: 5 })
      assert.equal(out, 'ok', '两次 EPERM 之后要能拿到锁（修之前这里直接抛出去）')
      assert.equal(hits, 2, '确实碰到了那两次 EPERM')
      assert.equal(ran, 1, '临界区只进一次')
      await assert.rejects(fs.stat(lock), /ENOENT/, '拿到之后锁也要收掉')
    } else {
      await assert.rejects(
        withFileLock(lock, async () => { ran += 1; return 'ok' }, { timeout: 2_000, wait: 5 }),
        /EPERM/,
        'POSIX 上 EPERM 是真没权限：原样抛，不许偷偷重试 8 秒',
      )
      assert.equal(ran, 0, '非 win32 不该进临界区')
    }
  } finally {
    fs.open = realOpen
  }
})

test('withFileLock：EPERM 一直不停时受 timeout 约束，不死循环', async () => {
  if (process.platform !== 'win32') return
  const root = await tmpRoot()
  const lock = join(root, '.lock')
  const realOpen = fs.open
  fs.open = async () => {
    const e = new Error('EPERM: operation not permitted, open')
    e.code = 'EPERM'
    throw e
  }
  const t0 = Date.now()
  try {
    await assert.rejects(withFileLock(lock, async () => 'never', { timeout: 120, wait: 10 }), /EPERM/)
    assert.ok(Date.now() - t0 < 5_000, '到点就抛，不能一直重试')
  } finally {
    fs.open = realOpen
  }
})

// ---------------------------------------------------------------------------
// 认领本身的互斥
//
// 认领是「读声明 → 判断 → 写声明」三步，以前中间没有锁：两个实例同时启动，
// 都读到没人占、都写、都返回 ok，盘上留后写的那个；先写的要到自己第一次心跳
// （15 秒后）才发现。另外三处写声明都是截断式 writeFile，截断和写入之间
// 别人读到的是空文件，被当成「没有声明」。
// ---------------------------------------------------------------------------

test('claimRoot：两个实例同时认领，只有一个拿到 ok', async () => {
  for (let i = 0; i < 5; i++) {
    const root = await tmpRoot()
    const [a, b] = await Promise.all([
      claimRoot(root, { instanceId: 'A', confirmMs: 20 }),
      claimRoot(root, { instanceId: 'B', confirmMs: 20 }),
    ])
    assert.equal([a, b].filter((r) => r.ok).length, 1, `第 ${i + 1} 轮：A.ok=${a.ok} B.ok=${b.ok}`)
    const winner = a.ok ? 'A' : 'B'
    const loser = a.ok ? b : a
    const raw = JSON.parse(await fs.readFile(join(root, TENANT_FILE), 'utf8'))
    assert.equal(raw.instanceId, winner, '盘上是拿到 ok 的那个')
    assert.equal(loser.owner.instanceId, winner, '输的那个知道是谁占着')
    assert.equal(await beatRoot(root, winner), true)
    assert.equal(await beatRoot(root, loser.instanceId), false)
    await assert.rejects(fs.stat(join(root, CLAIM_LOCK_FILE)), /ENOENT/, '认领完锁要收掉')
  }
})

test('claimRoot：几个进程同时启动，也只有一个拿到 ok', async () => {
  const root = await tmpRoot()
  const lib = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'tenant.js')).href
  // 每个子进程：等到同一个时刻认领，报结果，然后一直活着等父进程关 stdin
  // （认领完就退出的话 pid 没了，后面的进程接管是对的，测不出东西）。
  const code = `
    const { claimRoot } = await import(${JSON.stringify(lib)})
    const [root, id, at] = process.argv.slice(1)
    await new Promise((r) => setTimeout(r, Math.max(0, Number(at) - Date.now())))
    const res = await claimRoot(root, { instanceId: id })
    process.stdout.write(JSON.stringify({ id, ok: res.ok }) + '\\n')
    process.stdin.resume()
    process.stdin.on('end', () => process.exit(0))
  `
  const at = Date.now() + 1500
  const kids = ['P1', 'P2', 'P3', 'P4'].map((id) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, root, id, String(at)], {
      stdio: ['pipe', 'pipe', 'inherit'],
    })
    const said = new Promise((res, rej) => {
      let buf = ''
      child.stdout.on('data', (d) => {
        buf += d
        if (buf.includes('\n')) res(JSON.parse(buf.slice(0, buf.indexOf('\n'))))
      })
      child.on('error', rej)
      child.on('exit', (c) => rej(new Error(`${id} 没报结果就退出了（${c}）`)))
    })
    return { child, said }
  })
  try {
    const results = await Promise.all(kids.map((k) => k.said))
    const won = results.filter((r) => r.ok)
    assert.equal(won.length, 1, JSON.stringify(results))
    const raw = JSON.parse(await fs.readFile(join(root, TENANT_FILE), 'utf8'))
    assert.equal(raw.instanceId, won[0].id)
  } finally {
    await Promise.all(kids.map(({ child }) => new Promise((r) => {
      if (child.exitCode !== null) return r()
      child.once('exit', r)
      child.stdin.end()
    })))
  }
})

test('claimRoot：写完之后被别的实例盖掉 → 确认那一下认输，不再当自己是房主', async () => {
  const root = await tmpRoot()
  const file = join(root, TENANT_FILE)
  const mine = claimRoot(root, { instanceId: 'A', confirmMs: 300 })
  // A 写完、还没确认的这段时间里，另一个实例（没走锁的老版本、或共享盘上锁没生效）写了自己的声明
  const deadline = Date.now() + 5000
  for (;;) {
    try { if (JSON.parse(await fs.readFile(file, 'utf8')).instanceId === 'A') break } catch { /* 还没写出来 */ }
    assert.ok(Date.now() < deadline, 'A 的声明一直没写出来')
    await new Promise((r) => setTimeout(r, 5))
  }
  await fs.writeFile(file, JSON.stringify({ instanceId: 'B', version: '9.9.9', pid: process.pid, beatAt: Date.now(), bootAt: Date.now() }))
  const res = await mine
  assert.equal(res.ok, false)
  assert.equal(res.owner.instanceId, 'B')
  assert.equal(res.owner.version, '9.9.9')
  assert.match(res.why, /另一个插件实例|已经被/)
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).instanceId, 'B', '认输的不再改文件')
})

test('claimRoot：确认那一下读不出来不算被占；confirmMs:0 不确认', async () => {
  const root = await tmpRoot()
  const file = join(root, TENANT_FILE)
  const mine = claimRoot(root, { instanceId: 'A', confirmMs: 300 })
  const deadline = Date.now() + 5000
  for (;;) {
    try { await fs.stat(file); break } catch { /* 还没写出来 */ }
    assert.ok(Date.now() < deadline, 'A 的声明一直没写出来')
    await new Promise((r) => setTimeout(r, 5))
  }
  await fs.rm(file, { force: true })
  assert.equal((await mine).ok, true, '文件读不到（被删、被占着）不能把自己锁在门外')

  const root2 = await tmpRoot()
  // 不看钟（机器忙的时候一次改名就能拖上百毫秒）：数声明被读了几次。确认就是多读的那一次。
  const realRead = fs.readFile
  let reads = 0
  fs.readFile = async (f, ...a) => {
    if (String(f).endsWith(TENANT_FILE)) reads += 1
    return realRead(f, ...a)
  }
  try {
    assert.equal((await claimRoot(root2, { instanceId: 'A', confirmMs: 0 })).ok, true)
    assert.equal(reads, 1, 'confirmMs:0 只有认领时读的那一次')
    reads = 0
    assert.equal((await claimRoot(await tmpRoot(), { instanceId: 'A', confirmMs: 5 })).ok, true)
    assert.equal(reads, 2, '带确认的多读一次')
  } finally {
    fs.readFile = realRead
  }
})

test('claimRoot：锁一直拿不到时照老办法认领，不把自己锁在门外；别人的锁不删', async () => {
  const root = await tmpRoot()
  const lock = join(root, CLAIM_LOCK_FILE)
  let release
  const holder = withFileLock(lock, () => new Promise((r) => { release = r }))
  await new Promise((r) => setTimeout(r, 20))
  try {
    const res = await claimRoot(root, { instanceId: 'A', confirmMs: 0, lockTimeout: 120 })
    assert.equal(res.ok, true)
    assert.equal(JSON.parse(await fs.readFile(join(root, TENANT_FILE), 'utf8')).instanceId, 'A')
    assert.equal((await fs.stat(lock)).isFile(), true, '超时的那一方不能删别人的锁')
    // 没锁也还是认得出已经有人住
    const other = await claimRoot(root, { instanceId: 'B', confirmMs: 0, lockTimeout: 120 })
    assert.equal(other.ok, false)
    assert.equal(other.owner.instanceId, 'A')
  } finally {
    release('held')
    await holder
  }
})

test('claimRoot：上一个进程死在认领的临界区里（陈旧锁）→ 下一次启动能接手', async () => {
  const root = await tmpRoot()
  const lock = join(root, CLAIM_LOCK_FILE)
  await fs.writeFile(lock, JSON.stringify({ pid: 999999, at: 0 }))
  const old = (Date.now() - 60_000) / 1000
  await fs.utimes(lock, old, old)
  const res = await claimRoot(root, { instanceId: 'A', confirmMs: 0, lockTimeout: 1_000 })
  assert.equal(res.ok, true)
  assert.equal(res.why, undefined, '走的是带锁的那条路，声明写成了')
  await assert.rejects(fs.stat(lock), /ENOENT/)
})

test('claimRoot：家里写不进去（锁和声明都建不出来）照旧不拦，说明原因', async () => {
  const dir = await tmpRoot()
  // 拿一个普通文件当 root：在它下面什么都建不出来
  const root = join(dir, 'not-a-dir')
  await fs.writeFile(root, 'x')
  const res = await claimRoot(root, { instanceId: 'A', lockTimeout: 200 })
  assert.equal(res.ok, true, '写不进去不等于有别人占着')
  assert.equal(res.instanceId, 'A')
  assert.match(res.why, /占用声明没写成/)
})

test('家目录不在了：认领、心跳、让出都不把它重新建出来', async () => {
  const dir = await tmpRoot()
  const root = join(dir, 'gone')
  const res = await claimRoot(root, { instanceId: 'A', lockTimeout: 200 })
  assert.equal(res.ok, true, '写不进去不等于有别人占着')
  assert.match(res.why, /占用声明没写成：ENOENT/)
  assert.equal(await beatRoot(root, 'A'), false)
  assert.equal(await releaseRoot(root, 'A'), false)
  await assert.rejects(fs.stat(root), /ENOENT/, '被删掉或搬走的家不该因为一拍心跳又冒出来')
})

test('备份不带认领的锁：导出时正好有实例在认领，包里也没有 .instance.lock，老包里有的不放回', async () => {
  const root = await tmpRoot()
  await fs.writeFile(join(root, 'events.jsonl'), '', 'utf8')
  await fs.writeFile(join(root, CLAIM_LOCK_FILE), '{"pid":1,"at":0}', 'utf8')
  const bundle = JSON.parse(JSON.stringify(await collectBackup(root)))
  assert.ok(!bundle.files.some((f) => f.path === CLAIM_LOCK_FILE))
  assert.ok(!bundle.skipped.some((s) => s.includes(CLAIM_LOCK_FILE)), '不算「没装进去」')

  const dest = await tmpRoot()
  const res = await restoreBackup(
    { ...bundle, files: [...bundle.files, { path: CLAIM_LOCK_FILE, size: 16, enc: 'utf8', data: '{"pid":1,"at":0}' }] },
    dest,
  )
  assert.equal(res.ok, true, JSON.stringify(res).slice(0, 300))
  await assert.rejects(fs.stat(join(dest, CLAIM_LOCK_FILE)), /ENOENT/)
})

test('占用声明是原子写：心跳、让出的同时去读，读不到空文件或半截 JSON', async () => {
  const root = await tmpRoot()
  const file = join(root, TENANT_FILE)
  await claimRoot(root, { instanceId: 'A', confirmMs: 0 })
  let stop = false
  let reads = 0
  const broken = []
  const reader = (async () => {
    while (!stop) {
      let text = null
      try { text = await fs.readFile(file, 'utf8') } catch { /* Windows 上 rename 的瞬间可能读不开，不是这条要查的 */ }
      if (text !== null) {
        reads += 1
        try { JSON.parse(text) } catch { broken.push(text.slice(0, 40)) }
      }
      await new Promise((r) => setTimeout(r, 3))
    }
  })()
  try {
    for (let i = 0; i < 24; i++) {
      await beatRoot(root, 'A', { now: Date.now() + i })
      if (i % 8 === 7) {
        await releaseRoot(root, 'A')
        await claimRoot(root, { instanceId: 'A', confirmMs: 0 })
      }
    }
  } finally {
    stop = true
    await reader
  }
  assert.ok(reads > 0, '读的那一头至少读到过')
  assert.deepEqual(broken, [], `${reads} 次读里有 ${broken.length} 次是空的或半截的`)
  const left = (await fs.readdir(root)).filter((n) => n.endsWith('.tmp'))
  assert.deepEqual(left, [], '临时文件不留在家里')
})
