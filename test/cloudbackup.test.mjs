/**
 * cloudbackup.test.mjs —— 云端备份的调度与兜底（2026-11-14，用户 m01090）
 *
 * 这里钉的是四件事，每件都对应一条用户拍板的取舍：
 *   ① 什么时候推：只跟历史档的节奏（cloud.everyDays），不跟兜底档；
 *   ② 推上去的是什么：默认加密，文件名变 .json.enc，正文里没有明文；
 *   ③ 送不上去怎么办：进队列、指数退避、到点重试，用户能在设置页看见；
 *   ④ 云端挂了不等于没备份：本地那份照样在 backups/ 里。
 *
 * 端到端只用 folder 驱动——它会真的写文件，不需要网络，也能验证「留几份」的清理。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  BACKOFF_MS,
  QUEUE_FILE,
  cloudDue,
  cloudLine,
  cloudSizeText,
  cloudStatus,
  drainQueue,
  isOurs,
  newestLocal,
  pushTo,
  queuePath,
  readyTargets,
  runCloudBackup,
} from '../lib/cloudbackup.js'
import { runAutoBackup, autoBackupDir, LATEST_NAME, runLatestBackup } from '../lib/autobackup.js'
import { writePass, readPass, isEncrypted, decryptBuffer, KEY_FILE } from '../lib/cloudcrypto.js'
import { collectBackup } from '../lib/backup.js'
import { normTarget } from '../lib/cloudtargets.js'
import { readConfig } from '../lib/store.js'

/** 造一个最小可用的状态库（和 backup.test.mjs 的 makeRoot 同形）。 */
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-fish-cloud-'))
  writeFileSync(
    join(root, 'events.jsonl'),
    JSON.stringify({ v: 1, t: '2026-11-14T00:00:00.000Z', kind: 'meta', note: 'test' }) + '\n',
    'utf8',
  )
  writeFileSync(join(root, 'config.json'), '{}\n', 'utf8')
  writeFileSync(join(root, 'owner.json'), JSON.stringify({ name: '主人' }), 'utf8')
  mkdirSync(join(root, 'diary'), { recursive: true })
  writeFileSync(join(root, 'diary', '2026-11-14.md'), '今天。\n', 'utf8')
  return root
}

/** 写一份配置（走 settings 的规整，得到的就是用户配置该有的样子）。 */
function setCloud(root, cloud, extra = {}) {
  const cur = existsSync(join(root, 'config.json')) ? JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')) : {}
  const next = { ...cur, ...extra, cloud: { ...(cur.cloud ?? {}), ...cloud } }
  writeFileSync(join(root, 'config.json'), JSON.stringify(next, null, 1), 'utf8')
  return next
}

function targetOf(kind, fields) {
  const t = normTarget({ kind, ...fields }, 0)
  assert.ok(t, `造不出 ${kind} 目标`)
  return t
}

const FOLDER = (dir) => targetOf('folder', { dir, name: '我的文件夹' })

/* ───────────────────────── 什么时候推 ───────────────────────── */

test('cloudDue：关着就说关着，不看别的', () => {
  const config = { cloud: { enabled: false, targets: [FOLDER('D:\\x')] } }
  assert.deepEqual(cloudDue(config, new Date()), { due: false, why: '关着' })
})

test('cloudDue：开着但一个能用的目标都没有，不推', () => {
  const none = { cloud: { enabled: true, targets: [] } }
  assert.deepEqual(cloudDue(none, new Date()), { due: false, why: '还没有能用的目标' })
  const unfinished = { cloud: { enabled: true, targets: [normTarget({ kind: 'git' }, 0)] } }
  assert.equal(cloudDue(unfinished, new Date()).due, false)
})

test('cloudDue：开着、有目标、但加密开着又没口令 —— 不推（不能明文上路）', () => {
  const root = makeRoot()
  try {
    setCloud(root, { enabled: true, encrypt: true, targets: [FOLDER(join(root, 'remote'))] })
    const config = { cloud: { enabled: true, encrypt: true, targets: [FOLDER(join(root, 'remote'))] } }
    assert.deepEqual(cloudDue(config, new Date(), root), { due: false, why: '还没设加密口令' })
    // 关掉加密就该推了
    const plain = { cloud: { ...config.cloud, encrypt: false } }
    assert.equal(cloudDue(plain, new Date(), root).due, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('cloudDue：没推过就该推；刚推过要等到期；到期了说「距上次超过 N 天」', () => {
  const root = makeRoot()
  try {
    writePass(root, 'a-good-passphrase')
    const targets = [FOLDER(join(root, 'remote'))]
    const fresh = { cloud: { enabled: true, encrypt: true, targets } }
    assert.deepEqual(cloudDue(fresh, new Date('2026-11-14T10:00:00Z'), root), { due: true, why: '还没推过' })

    const justNow = { cloud: { ...fresh.cloud, everyDays: 1, lastAt: '2026-11-14T09:00:00.000Z' } }
    const r = cloudDue(justNow, new Date('2026-11-14T10:00:00Z'), root)
    assert.equal(r.due, false)
    assert.match(r.why, /小时后/)

    const old = { cloud: { ...fresh.cloud, everyDays: 1, lastAt: '2026-11-12T09:00:00.000Z' } }
    assert.deepEqual(cloudDue(old, new Date('2026-11-14T10:00:00Z'), root), { due: true, why: '距上次超过 1 天' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('cloudDue：自定义间隔（3 天）照着走', () => {
  const root = makeRoot()
  try {
    writePass(root, 'a-good-passphrase')
    const config = {
      cloud: { enabled: true, encrypt: true, everyDays: 3, lastAt: '2026-11-13T00:00:00.000Z', targets: [FOLDER(join(root, 'r'))] },
    }
    assert.equal(cloudDue(config, new Date('2026-11-14T00:00:00Z'), root).due, false)
    assert.equal(cloudDue(config, new Date('2026-11-16T01:00:00Z'), root).due, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* ───────────────────── 认哪些是「我们的」 ───────────────────── */

test('isOurs：只认自动备份那两种名字，手动的与别的都不认', () => {
  assert.equal(isOurs('大肥鱼-自动-20261114-070255.json'), true)
  assert.equal(isOurs('大肥鱼-自动-20261114-070255.json.enc'), true)
  assert.equal(isOurs(LATEST_NAME), true)
  assert.equal(isOurs('大肥鱼-自动-最新.json.enc'), true)
  assert.equal(isOurs('大肥鱼-20261114-0702.json'), false)
  assert.equal(isOurs('随便一个笔记.json'), false)
  assert.equal(isOurs(''), false)
  assert.equal(isOurs(null), false)
})

test('readyTargets：关掉的与填不全的都不算', () => {
  const config = {
    cloud: {
      targets: [
        { kind: 'folder', id: 'a', enabled: true, dir: 'D:\\a' },
        { kind: 'folder', id: 'b', enabled: false, dir: 'D:\\b' },
        { kind: 'git', id: 'c', enabled: true, repo: '', token: '' },
      ],
    },
  }
  const ready = readyTargets(config)
  assert.equal(ready.length, 1)
  assert.equal(ready[0].id, 'a')
  assert.deepEqual(readyTargets({}), [])
})

/* ───────────────────── folder 驱动端到端 ───────────────────── */

test('端到端：推一份到文件夹，默认加密，文件名带 .enc，正文里没有明文', async () => {
  const root = makeRoot()
  const remote = mkdtempSync(join(tmpdir(), 'dsh-fish-remote-'))
  try {
    writePass(root, 'a-good-passphrase')
    await runAutoBackup(root, { now: new Date('2026-11-14T07:00:00Z') })
    setCloud(root, { enabled: true, encrypt: true, keep: 3, targets: [FOLDER(remote)] })

    const r = await runCloudBackup(root, { force: true })
    assert.equal(r.ok, true)
    assert.equal(r.results.length, 1)
    assert.equal(r.results[0].ok, true)
    assert.match(r.results[0].name, /\.json\.enc$/)

    const files = readdirSync(remote)
    assert.equal(files.length, 1)
    assert.match(files[0], /^大肥鱼-自动-\d{8}-\d{6}\.json\.enc$/)

    const buf = readFileSync(join(remote, files[0]))
    assert.equal(isEncrypted(buf), true, '推上去的必须是加密包')
    assert.equal(buf.includes('主人'), false, '加密包里出现了明文')
    const plain = decryptBuffer(buf, 'a-good-passphrase')
    const bundle = JSON.parse(plain.toString('utf8'))
    assert.equal(bundle.format, 'dsh-fish-backup/1')

    // lastAt / lastName 被记下来了（否则每次 tick 都会重推）
    // 注意 readConfig 是异步的（store.js:370），漏掉 await 会拿到 Promise。
    const cfg = await readConfig(root)
    assert.equal(cfg.cloud.lastAt, r.lastAt ?? cfg.cloud.lastAt)
    assert.ok(cfg.cloud.lastAt)
    assert.equal(cfg.cloud.lastName, r.name)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(remote, { recursive: true, force: true })
  }
})

test('端到端：关掉加密就是原样 json（用户自己选的，不拦）', async () => {
  const root = makeRoot()
  const remote = mkdtempSync(join(tmpdir(), 'dsh-fish-remote-'))
  try {
    await runAutoBackup(root, { now: new Date('2026-11-14T07:00:00Z') })
    setCloud(root, { enabled: true, encrypt: false, keep: 3, targets: [FOLDER(remote)] })
    const r = await runCloudBackup(root, { force: true })
    assert.equal(r.ok, true)
    const files = readdirSync(remote)
    assert.equal(files.length, 1)
    assert.match(files[0], /\.json$/, '不加密就不该有 .enc')
    const bundle = JSON.parse(readFileSync(join(remote, files[0]), 'utf8'))
    assert.equal(bundle.format, 'dsh-fish-backup/1')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(remote, { recursive: true, force: true })
  }
})

test('留几份：推第四份时把最老的那份删掉（只删我们的）', async () => {
  const root = makeRoot()
  const remote = mkdtempSync(join(tmpdir(), 'dsh-fish-remote-'))
  try {
    writeFileSync(join(remote, '别人的文件.txt'), '别删我', 'utf8')
    await runAutoBackup(root, { now: new Date('2026-11-14T07:00:00Z') })
    setCloud(root, { enabled: true, encrypt: false, keep: 2, targets: [FOLDER(remote)] })
    for (const h of ['2026-11-14T07:00:00Z', '2026-11-14T08:00:00Z', '2026-11-14T09:00:00Z']) {
      await runAutoBackup(root, { now: new Date(h) })
      await runCloudBackup(root, { force: true })
    }
    const ours = readdirSync(remote).filter((n) => isOurs(n)).sort()
    assert.equal(ours.length, 2, `留下的份数不对：${ours.join(', ')}`)
    assert.ok(readdirSync(remote).includes('别人的文件.txt'), '把不是自己的文件删了')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(remote, { recursive: true, force: true })
  }
})

test('同一份不重复推：上次推的就是这份，非 force 时跳过', async () => {
  const root = makeRoot()
  const remote = mkdtempSync(join(tmpdir(), 'dsh-fish-remote-'))
  try {
    await runAutoBackup(root, { now: new Date('2026-11-14T07:00:00Z') })
    setCloud(root, { enabled: true, encrypt: false, targets: [FOLDER(remote)] })
    const first = await runCloudBackup(root, { force: true })
    assert.equal(first.ok, true)

    const second = await runCloudBackup(root, {})
    assert.equal(second.ok, true)
    assert.equal(second.skipped, '跟上次推的是同一份')
    assert.deepEqual(second.results, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(remote, { recursive: true, force: true })
  }
})

test('本地还没有历史档：说人话，不硬推', async () => {
  const root = makeRoot()
  const remote = mkdtempSync(join(tmpdir(), 'dsh-fish-remote-'))
  try {
    setCloud(root, { enabled: true, encrypt: false, targets: [FOLDER(remote)] })
    const r = await runCloudBackup(root, { force: true })
    assert.equal(r.ok, false)
    assert.match(r.why, /本地还没有历史备份/)
    assert.equal(readdirSync(remote).length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(remote, { recursive: true, force: true })
  }
})

test('关着的时候 force 也照推（用户点了「现在就送一份」）', async () => {
  const root = makeRoot()
  const remote = mkdtempSync(join(tmpdir(), 'dsh-fish-remote-'))
  try {
    await runAutoBackup(root, { now: new Date('2026-11-14T07:00:00Z') })
    setCloud(root, { enabled: false, encrypt: false, targets: [FOLDER(remote)] })
    assert.equal((await runCloudBackup(root, {})).ok, false)
    assert.equal((await runCloudBackup(root, { force: true })).ok, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(remote, { recursive: true, force: true })
  }
})

test('推失败了：进队列、记下原因与下次时间；本地那份照样在（云端挂了不等于没备份）', async () => {
  const root = makeRoot()
  try {
    // 用一个不可能写进去的目标：把它指到一个「文件」下面，mkdir 必然失败
    const blocker = join(root, 'not-a-dir')
    writeFileSync(blocker, 'x', 'utf8')
    await runAutoBackup(root, { now: new Date('2026-11-14T07:00:00Z') })
    setCloud(root, { enabled: true, encrypt: false, targets: [FOLDER(join(blocker, 'sub'))] })

    const now = new Date('2026-11-14T08:00:00Z')
    const r = await runCloudBackup(root, { force: true, now })
    assert.equal(r.ok, false)
    assert.equal(r.results[0].ok, false)
    assert.ok(r.results[0].why.length > 0)

    const q = JSON.parse(readFileSync(queuePath(root), 'utf8'))
    const item = q.items[r.results[0].id]
    assert.ok(item, '失败没进队列')
    assert.equal(item.tries, 1)
    assert.ok(item.why)
    assert.equal(Date.parse(item.nextAt), now.getTime() + BACKOFF_MS[0])

    // 本地那份还好好躺着
    assert.equal((await newestLocal(root)) !== null, true)
    assert.equal(existsSync(join(autoBackupDir(root), (await newestLocal(root)).name)), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('本地那份被清掉了：说清楚，别报一个看不懂的错', async () => {
  const root = makeRoot()
  const remote = mkdtempSync(join(tmpdir(), 'dsh-fish-remote-'))
  try {
    await runAutoBackup(root, { now: new Date('2026-11-14T07:00:00Z') })
    const name = (await newestLocal(root)).name
    rmSync(join(autoBackupDir(root), name))
    const r = await pushTo(root, FOLDER(remote), name, { cloud: { encrypt: false, keep: 3 } })
    assert.equal(r.ok, false)
    assert.match(r.why, /已经不在了/)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(remote, { recursive: true, force: true })
  }
})

/* ───────────────────── 失败队列与退避 ───────────────────── */

test('BACKOFF_MS 递增，最后一级不再涨', () => {
  assert.equal(BACKOFF_MS.length, 5)
  for (let i = 1; i < BACKOFF_MS.length; i++) assert.ok(BACKOFF_MS[i] > BACKOFF_MS[i - 1])
  assert.equal(BACKOFF_MS[0], 60_000)
})

test('队列：没到期不重试，到期了才试；成功后条目消失', async () => {
  const root = makeRoot()
  const remote = mkdtempSync(join(tmpdir(), 'dsh-fish-remote-'))
  try {
    await runAutoBackup(root, { now: new Date('2026-11-14T07:00:00Z') })
    setCloud(root, { enabled: true, encrypt: false, targets: [FOLDER(remote)] })
    const id = 'temp'
    const t0 = new Date('2026-11-14T08:00:00Z').getTime()
    writeFileSync(
      queuePath(root),
      JSON.stringify({ items: { [id]: { tries: 1, why: '刚才没通', at: new Date(t0).toISOString(), nextAt: new Date(t0 + 60_000).toISOString(), name: (await newestLocal(root)).name } } }),
      'utf8',
    )

    const early = await drainQueue(root, { now: new Date(t0 + 1000) })
    assert.deepEqual(early, { tried: 0, ok: 0 })
    assert.ok(JSON.parse(readFileSync(queuePath(root), 'utf8')).items[id], '没到期就被删了')

    // 目标 id 对不上：条目该被清掉（那个目标已经不存在了）
    const gone = await drainQueue(root, { now: new Date(t0 + 120_000) })
    assert.deepEqual(gone, { tried: 0, ok: 0 })
    assert.equal(JSON.parse(readFileSync(queuePath(root), 'utf8')).items[id], undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(remote, { recursive: true, force: true })
  }
})

test('队列：目标真在、也到期了 —— 重试成功就清条目', async () => {
  const root = makeRoot()
  const remote = mkdtempSync(join(tmpdir(), 'dsh-fish-remote-'))
  try {
    await runAutoBackup(root, { now: new Date('2026-11-14T07:00:00Z') })
    const cfg = setCloud(root, { enabled: true, encrypt: false, targets: [FOLDER(remote)] })
    const t = cfg.cloud.targets[0]
    const t0 = new Date('2026-11-14T08:00:00Z').getTime()
    writeFileSync(
      queuePath(root),
      JSON.stringify({ items: { [t.id]: { tries: 1, why: '刚才没通', at: new Date(t0).toISOString(), nextAt: new Date(t0 + 60_000).toISOString(), name: (await newestLocal(root)).name } } }),
      'utf8',
    )
    const r = await drainQueue(root, { now: new Date(t0 + 120_000) })
    assert.deepEqual(r, { tried: 1, ok: 1 })
    assert.equal(JSON.parse(readFileSync(queuePath(root), 'utf8')).items[t.id], undefined)
    assert.equal(readdirSync(remote).length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(remote, { recursive: true, force: true })
  }
})

test('队列文件坏了也不炸：当空队列，还能继续干活', async () => {
  const root = makeRoot()
  try {
    writeFileSync(queuePath(root), '这不是 json', 'utf8')
    const r = await drainQueue(root, { now: new Date() })
    assert.deepEqual(r, { tried: 0, ok: 0 })
    assert.equal(queuePath(root), join(root, QUEUE_FILE))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* ───────────────────── 设置页要看到的东西 ───────────────────── */

test('cloudStatus：默认状态如实——关着、三个地方、口令还没设', async () => {
  const root = makeRoot()
  try {
    const st = await cloudStatus(root)
    assert.equal(st.enabled, false)
    assert.equal(st.everyDays, 1)
    assert.equal(st.keep, 3)
    assert.equal(st.encrypt, true)
    assert.equal(st.latestUp, false)
    assert.equal(st.hasPass, false)
    assert.equal(st.due, false)
    assert.equal(st.dueWhy, '关着')
    assert.deepEqual(st.targets, [])
    assert.equal(st.kinds.length, 6, '字段表要跟着状态一起下发')
    assert.equal(st.newest, null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('cloudStatus：目标只回「填过没有」，密码不回显', async () => {
  const root = makeRoot()
  try {
    setCloud(root, {
      enabled: true,
      targets: [{ kind: 'git', id: 'g1', repo: 'me/backup', token: 'ghp_secret', enabled: true }],
    })
    const st = await cloudStatus(root)
    assert.equal(st.targets.length, 1)
    const t = st.targets[0]
    assert.equal(t.token, '')
    assert.equal(t.filled.token, true)
    assert.equal(t.label, '仓库')
    assert.equal(t.ready, true)
    assert.equal(JSON.stringify(st).includes('ghp_secret'), false, '密码从状态里漏出来了')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('cloudStatus：有一份历史档时 newest 指到它；兜底那份不算', async () => {
  const root = makeRoot()
  try {
    await runLatestBackup(root, { now: new Date('2026-11-14T06:00:00Z') })
    assert.equal(await newestLocal(root), null, '兜底那份不该被当成「最新历史档」')
    await runAutoBackup(root, { now: new Date('2026-11-14T07:00:00Z') })
    const st = await cloudStatus(root)
    assert.ok(st.newest)
    assert.match(st.newest.name, /^大肥鱼-自动-\d{8}-\d{6}\.json$/)
    assert.ok(st.newest.bytes > 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('cloudStatus：口令指纹能用来核对「是不是同一个口令」，但看不出口令本身', async () => {
  const root = makeRoot()
  try {
    writePass(root, 'a-good-passphrase')
    const st = await cloudStatus(root)
    assert.equal(st.hasPass, true)
    assert.equal(st.passProblem, '')
    assert.match(st.passFingerprint, /^[0-9a-f]{16}$/)
    assert.equal(JSON.stringify(st).includes('a-good-passphrase'), false)
    assert.equal(readPass(root), 'a-good-passphrase')
    assert.equal(existsSync(join(root, KEY_FILE)), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('口令文件不进备份（否则加密当场归零）', async () => {
  const root = makeRoot()
  try {
    writePass(root, 'a-good-passphrase')
    const bundle = await collectBackup(root, { now: new Date('2026-11-14T07:00:00Z') })
    const paths = bundle.files.map((f) => f.path)
    assert.equal(paths.includes(KEY_FILE), false, '口令文件被打进包里了')
    assert.equal(JSON.stringify(bundle).includes('a-good-passphrase'), false, '口令原文出现在包里了')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('cloudSizeText / cloudLine：三种状态说人话', () => {
  assert.equal(cloudSizeText(null), '')
  assert.equal(cloudSizeText({ enabled: false }), '关着')
  assert.equal(cloudSizeText({ enabled: true, targets: [] }), '还没有能用的目标')
  assert.equal(cloudSizeText({ enabled: true, targets: [{ enabled: true, ready: true }] }), '还没推过')
  assert.equal(cloudSizeText({ enabled: true, targets: [{ enabled: true, ready: true }], lastAt: 'x' }), '推到过 1 个地方')

  assert.equal(cloudLine(null), '')
  assert.match(cloudLine({ enabled: false }), /本地那份照常存/)
  assert.match(cloudLine({ enabled: true, targets: [] }), /还没有能用的目标/)
  assert.match(cloudLine({ enabled: true, targets: [{ enabled: true, ready: true }], due: true, dueWhy: '还没推过' }), /还没推过/)
  assert.match(
    cloudLine({ enabled: true, targets: [{ enabled: true, ready: true }], lastAt: 'x', due: false, dueWhy: '24 小时后' }),
    /1 个地方都有过/,
  )
})
