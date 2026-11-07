/**
 * backup.test.mjs —— 备份/恢复与事件格式版本
 *
 * 为什么要有（2026-10-25，发布体检第 2、4 项）：
 *   ①「换台机器还能接着养」是用户明确的诉求。备份如果只是复制几个 json，
 *     日记、她的房间、头像都会丢——那些才是她这几年长出来的东西。
 *   ② 恢复是危险动作。所以它必须是「先封存再放回」：现在的档整体改名搬到
 *     `dsh-fish-backups/pre-restore-<时间>/`，一个字节都不删，恢复错了还能换回来。
 *   ③ 事件格式加版本号，是为了让「读到了哪个年代的档」变成可判断的事；
 *     没有 `v` 的老事件必须按 v1 读，并计数（legacy），不能崩、也不能装作一样。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

import {
  BACKUP_FORMAT,
  collectBackup,
  checkBundle,
  restoreBackup,
  backupFileName,
  quarantineDirFor,
} from '../lib/backup.js'
import { readEvents, appendEvent } from '../lib/store.js'
import { validateEvent, EVENT_SCHEMA_VERSION } from '../lib/schema.js'

async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), 'fish-backup-'))
  await writeFile(join(root, 'events.jsonl'), '{"id":"ev_01J0000000000000000000000A","v":1,"type":"utterance","text":"我看见了。","ts":"2026-10-25T00:00:00.000Z","day":1,"stage":1}\n')
  await writeFile(join(root, 'config.json'), '{"chat":{"rotateAfter":40}}')
  await writeFile(join(root, 'owner.json'), '{"mid":"123","hasCookie":true}')
  await mkdir(join(root, 'diary'), { recursive: true })
  await writeFile(join(root, 'diary', '2026-10-25.md'), '# 日记\n今天看到了海。\n')
  await mkdir(join(root, 'home'), { recursive: true })
  await writeFile(join(root, 'home', '她的身份.md'), '# 你是谁\n你是大肥鱼。\n')
  // 二进制：头像
  await writeFile(join(root, 'avatar.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  // 不该进备份的两类
  await mkdir(join(root, 'logs'), { recursive: true })
  await writeFile(join(root, 'logs', 'dsh-fish.log'), '现场日志\n')
  await mkdir(join(root, 'backups'), { recursive: true })
  await writeFile(join(root, 'backups', 'old.json'), '{}')
  return root
}

test('备份：该拿的都拿到，日志与旧备份不进包', async () => {
  const root = await makeRoot()
  try {
    const b = await collectBackup(root)
    assert.equal(b.format, BACKUP_FORMAT)
    assert.equal(b.schema, EVENT_SCHEMA_VERSION)
    const paths = b.files.map((f) => f.path).sort()
    assert.deepEqual(paths, [
      'avatar.png',
      'config.json',
      'diary/2026-10-25.md',
      'events.jsonl',
      'home/她的身份.md',
      'owner.json',
    ])
    const avatar = b.files.find((f) => f.path === 'avatar.png')
    assert.equal(avatar.enc, 'base64')
    assert.equal(Buffer.from(avatar.data, 'base64').length, 8)
    assert.equal(b.files.find((f) => f.path === 'config.json').enc, 'utf8')
    assert.ok(b.skipped.some((s) => s.startsWith('logs/')), b.skipped.join('|'))
    assert.ok(b.skipped.some((s) => s.startsWith('backups/')), b.skipped.join('|'))
    assert.match(backupFileName(new Date('2026-10-25T00:31:00Z')), /^大肥鱼-20261025-\d{4}\.json$/)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('校验：格式不对、空包、路径穿越、比程序新，全都要拦', () => {
  const ok = { format: BACKUP_FORMAT, schema: 1, files: [{ path: 'a.json', enc: 'utf8', data: '{}' }] }
  assert.equal(checkBundle(ok).ok, true)

  assert.equal(checkBundle(null).ok, false)
  assert.equal(checkBundle({ ...ok, format: 'dsh-fish-backup/99' }).ok, false)
  assert.match(checkBundle({ ...ok, format: 'x' }).why, /只认/)
  assert.equal(checkBundle({ ...ok, files: [] }).ok, false)
  assert.equal(checkBundle({ ...ok, files: [{ path: '', enc: 'utf8', data: '' }] }).ok, false)
  assert.equal(checkBundle({ ...ok, files: [{ path: 'a.json', enc: 'hex', data: '' }] }).ok, false)

  const trav = { ...ok, files: [{ path: '../../evil.json', enc: 'utf8', data: 'x' }] }
  assert.equal(checkBundle(trav).ok, false)
  assert.match(checkBundle(trav).why, /可疑/)

  const newer = { ...ok, schema: EVENT_SCHEMA_VERSION + 1 }
  assert.equal(checkBundle(newer).ok, false)
  assert.match(checkBundle(newer).why, /更新的版本/)
})

test('恢复：先封存旧档，再放回备份；旧档一个字节都不删', async () => {
  const root = await makeRoot()
  const oldRoot = root
  try {
    const bundle = await collectBackup(oldRoot)
    // 备份之后她又写了两句：恢复应该回到备份那一刻
    await appendEvent({ type: 'utterance', text: '备份之后说的话。' }, { day: 2, stage: 1 }, oldRoot)
    const before = await readEvents(oldRoot)
    assert.equal(before.events.length, 2)

    const r = await restoreBackup(bundle, oldRoot)
    assert.equal(r.ok, true, r.why)
    assert.equal(r.restored, bundle.files.length)
    assert.ok(r.quarantined, '应该返回封存目录')

    const after = await readEvents(oldRoot)
    assert.equal(after.events.length, 1, '恢复后回到备份那一刻')
    // 旧档在封存目录里，且真的包含那句多出来的话
    const kept = await readEvents(r.quarantined)
    assert.equal(kept.events.length, 2)
    const cfg = JSON.parse(await readFile(join(oldRoot, 'config.json'), 'utf8'))
    assert.equal(cfg.chat.rotateAfter, 40)
  } finally {
    await rm(oldRoot, { recursive: true, force: true })
    // 封存目录在 root 的同级：按文件名前缀清掉，避免污染 tmp
    const parent = dirname(oldRoot)
    const { readdir } = await import('node:fs/promises')
    for (const n of await readdir(parent)) {
      if (n.startsWith('dsh-fish-backups')) await rm(join(parent, n), { recursive: true, force: true })
    }
  }
})

test('恢复：格式不对时什么都不动', async () => {
  const root = await makeRoot()
  try {
    const r = await restoreBackup({ format: 'nope', files: [] }, root)
    assert.equal(r.ok, false)
    const ev = await readEvents(root)
    assert.equal(ev.events.length, 1)
    await assert.doesNotReject(stat(join(root, 'events.jsonl')))
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('封存目录名带 pre-restore 前缀，同一秒两次不撞名', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-q-'))
  try {
    const now = new Date('2026-10-25T00:00:00Z')
    const a = await quarantineDirFor(root, now)
    assert.match(a, /pre-restore-\d{8}-\d{6}$/)
    await mkdir(a, { recursive: true })
    const b = await quarantineDirFor(root, now)
    assert.notEqual(a, b)
    assert.match(b, /-2$/)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    const parent = dirname(root)
    const { readdir } = await import('node:fs/promises')
    for (const n of await readdir(parent)) {
      if (n.startsWith('dsh-fish-backups')) await rm(join(parent, n), { recursive: true, force: true })
    }
  }
})

test('事件格式版本：新事件带 v，老事件按 v1 读并计数', async () => {
  assert.equal(EVENT_SCHEMA_VERSION, 1)
  const ev = validateEvent({ type: 'utterance', text: '我看见了。' }, { day: 1, stage: 1 })
  assert.equal(ev.v, 1)

  const root = await mkdtemp(join(tmpdir(), 'fish-ver-'))
  try {
    // 模拟「加版本号之前写的事件」：没有 v 字段
    await writeFile(
      join(root, 'events.jsonl'),
      '{"id":"ev_01J0000000000000000000000B","type":"utterance","text":"老的一句。","ts":"2026-10-20T00:00:00.000Z","day":1,"stage":1}\n' +
        '这一行不是 json\n',
    )
    const r = await readEvents(root)
    assert.equal(r.events.length, 1)
    assert.equal(r.legacy, 1)
    assert.equal(r.skipped, 1)
    assert.equal(r.events[0].v, 1, '缺 v 的老事件在内存里补成 v1')

    await appendEvent({ type: 'utterance', text: '新的一句。' }, { day: 1, stage: 1 }, root)
    const r2 = await readEvents(root)
    assert.equal(r2.legacy, 1, '只有那条老的算 legacy')
    assert.equal(r2.events[1].v, 1)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('备份进包后能原样读回（含二进制）', async () => {
  const root = await makeRoot()
  const dest = await mkdtemp(join(tmpdir(), 'fish-restore-'))
  try {
    const b = await collectBackup(root)
    const r = await restoreBackup(b, dest)
    assert.equal(r.ok, true, r.why)
    const png = await readFile(join(dest, 'avatar.png'))
    assert.deepEqual([...png], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const txt = await readFile(join(dest, 'diary', '2026-10-25.md'), 'utf8')
    assert.match(txt, /今天看到了海/)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    await rm(dest, { recursive: true, force: true })
    const parent = dirname(dest)
    const { readdir } = await import('node:fs/promises')
    for (const n of await readdir(parent)) {
      if (n.startsWith('dsh-fish-backups')) await rm(join(parent, n), { recursive: true, force: true })
    }
  }
})

test('界面与路由都接上了（别只写了个模块）', async () => {
  const c = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(c, /备份成一份文件/)
  assert.match(c, /从备份恢复/)
  assert.match(c, /pre-restore-/)
  const o = await readFile(new URL('../lib/observe.js', import.meta.url), 'utf8')
  assert.match(o, /\['\/backup\/restore'/)
  assert.match(o, /collectBackup\(root\)/)
  // 恢复必须走「先封存」那条路，不许直接覆盖
  assert.match(o, /restoreBackup\(b, root\)/)
})

// ---------------------------------------------------------------------------
// issue #65：事件流超过单文件上限时，备份原来会把它整个跳过（放进 skipped），
// 界面只报「N 个文件」；拿这份备份恢复会成功，恢复出来的事件流却是空的。
// ---------------------------------------------------------------------------

/** 造一个大于 8MB、每行都是合法事件的 events.jsonl。返回行数。 */
async function writeBigEvents(root) {
  const pad = '鱼'.repeat(120)
  const lines = []
  let bytes = 0
  for (let i = 0; bytes <= 9 * 1024 * 1024; i++) {
    const line = JSON.stringify({ id: `ev_big_${i}`, v: 1, type: 'utterance', text: `第 ${i} 句。${pad}`, ts: '2026-10-25T00:00:00.000Z', day: 1, stage: 1 }) + '\n'
    lines.push(line)
    bytes += Buffer.byteLength(line)
  }
  await writeFile(join(root, 'events.jsonl'), lines.join(''))
  return lines.length
}

async function cleanBackups(dir) {
  const parent = dirname(dir)
  const { readdir } = await import('node:fs/promises')
  for (const n of await readdir(parent)) {
    if (n.startsWith('dsh-fish-backups')) await rm(join(parent, n), { recursive: true, force: true })
  }
}

test('事件流超过 8MB 照样进备份，恢复出来一条不少（issue #65）', async () => {
  const root = await makeRoot()
  const dest = await mkdtemp(join(tmpdir(), 'fish-restore-big-'))
  try {
    const n = await writeBigEvents(root)
    assert.ok((await stat(join(root, 'events.jsonl'))).size > 8 * 1024 * 1024, '造出来的事件流要真的超过 8MB')

    const b = await collectBackup(root)
    const ev = b.files.find((f) => f.path === 'events.jsonl')
    assert.ok(ev, `事件流必须在备份里，skipped：${b.skipped.join('|')}`)
    assert.ok(!b.skipped.some((s) => s.startsWith('events.jsonl')), '事件流不能出现在 skipped 里')
    assert.equal(b.files[0].path, 'events.jsonl', '事件流排最前，总量上限先算它')

    const r = await restoreBackup(b, dest)
    assert.equal(r.ok, true, r.why)
    const back = await readEvents(dest)
    assert.equal(back.events.length, n, '恢复出来的事件条数要和原来一样')
    assert.equal(back.skipped, 0)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    await rm(dest, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    await cleanBackups(dest)
  }
})

test('事件流大到超过总量上限：整份备份失败并说明，不悄悄跳过（issue #65）', async () => {
  const root = await makeRoot()
  try {
    // 只设长度、不写内容：64MB 以上的判断只看 stat，不会真的读它
    const { truncate } = await import('node:fs/promises')
    await truncate(join(root, 'events.jsonl'), 65 * 1024 * 1024)
    await assert.rejects(collectBackup(root), (err) => {
      assert.equal(err.code, 'EVENTS_NOT_BACKED_UP')
      assert.match(err.message, /events\.jsonl/)
      assert.match(err.message, /64MB/)
      assert.match(err.message, /没有备份/)
      return true
    })
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('别的文件超过单文件上限仍然跳过，但和「故意不搬」分得开（界面靠这个列出来）', async () => {
  const root = await makeRoot()
  try {
    await writeFile(join(root, 'big.png'), Buffer.alloc(9 * 1024 * 1024))
    const b = await collectBackup(root)
    assert.ok(!b.files.some((f) => f.path === 'big.png'))
    const big = b.skipped.find((s) => s.startsWith('big.png'))
    assert.ok(big, b.skipped.join('|'))
    assert.match(big, /超过单文件上限/)
    // 设置页把不带「（不搬：」的条目列给人看（client.js 的 backupNow），logs/ 和 backups/ 带着它
    assert.ok(!big.includes('（不搬：'))
    for (const dir of ['logs/', 'backups/']) {
      const s = b.skipped.find((x) => x.startsWith(dir))
      assert.ok(s && s.includes('（不搬：'), `${dir} 是故意不搬的：${s}`)
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('设置页：备份失败照实说，没装进去的列出来（issue #65）', async () => {
  const c = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  const start = c.indexOf('async function backupNow()')
  const end = c.indexOf('function restoreFromFile()')
  assert.ok(start > 0 && end > start, '必须能定位到 backupNow')
  const body = c.slice(start, end)
  assert.match(body, /b\.skipped/, '要读 skipped')
  assert.ok(body.includes("'（不搬：'"), '故意不搬的（logs/、backups/）不列')
  assert.match(body, /没装进去/, '其余的要说出来')
  const o = await readFile(new URL('../lib/observe.js', import.meta.url), 'utf8')
  const route = o.slice(o.indexOf("['/backup', async"), o.indexOf("['/backup/restore'"))
  assert.match(route, /catch \(err\)[\s\S]*send\(res, 409/, '事件流装不进来时回 409 和原因，不当 500')
})
