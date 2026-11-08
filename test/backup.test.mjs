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
  badTextFiles,
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
    // 不带的两类照样列出来，但列在 excluded 里：它们是照规矩不带，不是「没装进去」。
    assert.ok(b.excluded.some((s) => s.startsWith('logs/')), b.excluded.join('|'))
    assert.ok(b.excluded.some((s) => s.startsWith('backups/')), b.excluded.join('|'))
    assert.deepEqual(b.skipped, [], '这份档每个该带的文件都带上了，skipped 应该是空的')
    assert.match(backupFileName(new Date('2026-10-25T00:31:00Z')), /^大肥鱼-20261025-\d{4}\.json$/)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('校验：格式不对、空包、路径穿越、比程序新，全都要拦', () => {
  const ok = { format: BACKUP_FORMAT, schema: 1, files: [{ path: 'events.jsonl', enc: 'utf8', data: '' }] }
  assert.equal(checkBundle(ok).ok, true)

  assert.equal(checkBundle({ ...ok, files: [{ path: 'a.json', enc: 'utf8', data: '{}' }] }).ok, false, '没有事件流的包不能恢复')
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
  // 打包时把恢复上限也带进去（collectBackup(root, { restoreLimit })），还是这一个 root
  assert.match(o, /collectBackup\(root[,)]/)
  // 恢复必须走「先封存」那条路，不许直接覆盖；skipBad 是 issue #65 的「人看过名单才跳过」
  assert.match(o, /restoreBackup\(b, root[,)]/)
  assert.match(o, /skipBad/)
  // 备份恢复这条不拿「正文是不是 UTF-8」整包拦——旧包里本来就可能带替换符
  assert.match(o, /readBody\(req, restoreLimit, \{ mojibake: false \}\)/)
})

test('备份：事件流再大也要进包，别的超限文件才 skipped（issue #65）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-backup-big-'))
  try {
    // 9MB 的 events.jsonl：单文件上限 8MB，但它不能因此被丢掉——
    // 丢了它，备份看起来成功、装回去她会失忆。
    const line = JSON.stringify({ id: 'ev_01J0000000000000000000000B', v: 1, type: 'utterance', text: 'x'.repeat(900), ts: '2026-10-25T00:00:00.000Z', day: 1, stage: 1 })
    await writeFile(join(root, 'events.jsonl'), (line + '\n').repeat(Math.ceil(9 * 1024 * 1024 / (line.length + 1))))
    await writeFile(join(root, 'huge.bin'), Buffer.alloc(9 * 1024 * 1024))
    const b = await collectBackup(root)
    assert.ok(b.files.some((f) => f.path === 'events.jsonl'), '事件流必须进包')
    assert.ok(!b.files.some((f) => f.path === 'huge.bin'))
    assert.ok(b.skipped.some((x) => x.startsWith('huge.bin')), `skipped 应提到 huge.bin，实际 ${JSON.stringify(b.skipped)}`)
    assert.ok(!b.skipped.some((x) => x.startsWith('events.jsonl')))
    const r = checkBundle(b)
    assert.equal(r.ok, true, r.why)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ---- 0.9.5 余项（接 #65）----

test('事件流过了 64MB：排在它后面的文件不被挤出包（事件流不算进总量上限）', async () => {
  // 0.9.5：事件流跳过了总量检查，但大小照样累加进总量，之后按 readdir 顺序走到的
  // home/、owner.json、state.json 都被记成「总量已到 64MB 上限」，恢复却照报成功。
  const box = await mkdtemp(join(tmpdir(), 'fish-backup-squeeze-'))
  const root = join(box, 'dsh-fish')
  try {
    await mkdir(join(root, 'home'), { recursive: true })
    await mkdir(join(root, 'out'), { recursive: true })
    await mkdir(join(root, 'diary'), { recursive: true })
    await mkdir(join(root, 'logs'), { recursive: true })
    const line = JSON.stringify({ id: 'ev_01J0000000000000000000000C', v: 1, type: 'utterance', text: '下雨了，"真的"\n'.repeat(60), ts: '2026-10-25T00:00:00.000Z', day: 1, stage: 1 }) + '\n'
    const big = Buffer.from(line.repeat(Math.ceil((65 * 1024 * 1024) / Buffer.byteLength(line))))
    assert.ok(big.length > 64 * 1024 * 1024)
    await writeFile(join(root, 'events.jsonl'), big)
    await writeFile(join(root, 'avatar.png'), Buffer.alloc(3 * 1024 * 1024, 1))
    await writeFile(join(root, 'config.json'), '{}')
    await writeFile(join(root, 'diary', '2026-10-28.md'), '今天\n')
    await writeFile(join(root, 'home', '她的身份.md'), '# 你是谁\n')
    await writeFile(join(root, 'out', '2026-10-28.md'), '报告\n')
    await writeFile(join(root, 'owner.json'), '{"mid":"1"}')
    await writeFile(join(root, 'state.json'), '{"day":3}')
    await writeFile(join(root, 'logs', 'dsh-fish.log'), '现场\n')

    const b = await collectBackup(root)
    const paths = b.files.map((f) => f.path).sort()
    assert.deepEqual(paths, [
      'avatar.png',
      'config.json',
      'diary/2026-10-28.md',
      'events.jsonl',
      'home/她的身份.md',
      'out/2026-10-28.md',
      'owner.json',
      'state.json',
    ], `skipped=${JSON.stringify(b.skipped)}`)
    assert.deepEqual(b.skipped, [])
    assert.deepEqual(b.excluded, ['logs/'])
    assert.equal(b.bytes, b.files.reduce((n, f) => n + f.size, 0), 'bytes 还是包里所有文件的总字节数')
  } finally {
    await rm(box, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('恢复的回执带上导出时就没装进包的文件；旧包里「不搬」的那几条不算', async () => {
  const box = await mkdtemp(join(tmpdir(), 'fish-backup-skip-'))
  const root = join(box, 'dsh-fish')
  try {
    const bundle = {
      format: BACKUP_FORMAT,
      schema: EVENT_SCHEMA_VERSION,
      files: [{ path: 'events.jsonl', enc: 'utf8', data: '' }],
      // 0.9.5 打的包：不搬的目录也写在 skipped 里
      skipped: ['logs/（不搬：logs）', 'home/node_modules/（不搬：node_modules）', 'home/大.bin（9MB，超过单文件上限）', 'owner.json（总量已到 64MB 上限）'],
    }
    const r = await restoreBackup(bundle, root)
    assert.equal(r.ok, true, r.why)
    assert.deepEqual(r.skipped, ['home/大.bin（9MB，超过单文件上限）', 'owner.json（总量已到 64MB 上限）'])
  } finally {
    await rm(box, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

/** 起一个真的 http 服务挂上 /backup 与 /backup/restore，restoreLimit 调小，不用真造 96MB 的包。 */
async function backupServer(root, restoreLimit) {
  const http = await import('node:http')
  const { registerObserve } = await import('../lib/observe.js')
  const routes = []
  const ctx = {
    get: (k) => (k === 'connection'
      ? { requestRejection: () => null }
      : k === 'webServer'
        ? { register: (def) => { routes.push(def); return () => {} } }
        : undefined),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }
  const handle = registerObserve(ctx, { root, restoreLimit })
  const exact = (p) => routes.find((r) => r.path === `/dsh-fish${p}`)
  const server = http.createServer((req, res) => {
    const route = req.url === '/dsh-fish/backup/restore' ? exact('/backup/restore') : exact('/backup')
    route.handler(req, res)
  })
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
  const port = server.address().port
  const request = (method, path, body) => new Promise((ok, bad) => {
    const headers = body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => ok({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }))
      res.on('error', bad)
    })
    req.on('error', bad)
    if (body) {
      // 分块写，像浏览器上传那样：服务端在中途就知道超了
      const buf = Buffer.from(body)
      for (let i = 0; i < buf.length; i += 16 * 1024) req.write(buf.subarray(i, i + 16 * 1024))
    }
    req.end()
  })
  return {
    request,
    async close() {
      handle.dispose()
      server.closeAllConnections?.()
      await new Promise((ok) => server.close(ok))
    },
  }
}

test('导出时就说这份包能不能用「从备份恢复」装回去；超了的包恢复时先回 413 说原因，现在的档不动', async () => {
  // 0.9.5：事件流不设上限，包比恢复接口的 96MB 大时导出照常说「已导出」，
  // 恢复时服务端当场断开连接，界面上只剩一条网络错误。
  const box = await mkdtemp(join(tmpdir(), 'fish-backup-limit-'))
  const root = join(box, 'dsh-fish')
  const limit = 200_000
  const srv = await backupServer(root, limit)
  try {
    await mkdir(root, { recursive: true })
    // 事件行里的引号和换行在包里要再转义一次，包比事件流大
    const line = JSON.stringify({ id: 'ev_01J0000000000000000000000D', v: 1, type: 'utterance', text: '"引号"\n'.repeat(40), ts: '2026-10-25T00:00:00.000Z', day: 1, stage: 1 }) + '\n'
    const events = line.repeat(Math.ceil(180_000 / Buffer.byteLength(line)))
    assert.ok(Buffer.byteLength(events) < limit, '事件流本身没超，超的是打成包之后')
    await writeFile(join(root, 'events.jsonl'), events)

    const got = await srv.request('GET', '/dsh-fish/backup')
    assert.equal(got.status, 200)
    const b = JSON.parse(got.text)
    assert.equal(b.restoreLimit, limit)
    assert.equal(b.fitsRestore, false, `restoreBytes=${b.restoreBytes}`)
    // 设置页存文件、恢复时都是 JSON.stringify 一次：导出时量出来的数不能比真发出去的小
    const body = JSON.stringify(JSON.parse(JSON.stringify(b)))
    assert.ok(Buffer.byteLength(body) > limit)
    assert.ok(b.restoreBytes >= Buffer.byteLength(body), `${b.restoreBytes} < ${Buffer.byteLength(body)}`)

    const put = await srv.request('POST', '/dsh-fish/backup/restore', body)
    assert.equal(put.status, 413, put.text)
    const err = JSON.parse(put.text)
    assert.match(err.error, /装不回去/)
    assert.match(err.error, /什么都没动/)
    // 现在的档原样在原位，没有被封存走
    assert.equal(await readFile(join(root, 'events.jsonl'), 'utf8'), events)
    await assert.rejects(stat(join(box, 'dsh-fish-backups')))
  } finally {
    await srv.close()
    await rm(box, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('导出时说能装回去的包，恢复真能装回去', async () => {
  const box = await mkdtemp(join(tmpdir(), 'fish-backup-limit-'))
  const root = join(box, 'dsh-fish')
  const srv = await backupServer(root, 200_000)
  try {
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'events.jsonl'), '{"id":"ev_01J0000000000000000000000E","v":1,"type":"utterance","text":"我在。","ts":"2026-10-25T00:00:00.000Z","day":1,"stage":1}\n')
    await writeFile(join(root, 'owner.json'), '{"mid":"1"}')
    const got = await srv.request('GET', '/dsh-fish/backup')
    const b = JSON.parse(got.text)
    assert.equal(b.fitsRestore, true)
    const put = await srv.request('POST', '/dsh-fish/backup/restore', JSON.stringify(b))
    assert.equal(put.status, 200, put.text)
    const r = JSON.parse(put.text)
    assert.equal(r.ok, true)
    assert.deepEqual(r.skipped, [])
    assert.equal(await readFile(join(root, 'owner.json'), 'utf8'), '{"mid":"1"}')
  } finally {
    await srv.close()
    await rm(box, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

// ---- 审查后补的（接 #65）：事件流装得下，整份包就要装得下 ----

test('事件流装得下时整份包就装得下：大文件被挑出去，owner.json、state.json 留在包里，恢复真能装回去', async () => {
  // 事件流不算进 64MB 以后，包能长到「事件流 + 64MB 原始字节」，二进制按 base64 还要再大 4/3：
  // 0.9.5 上装得回去的档，导出后反倒被说成装不回去。这里把恢复上限调小，按比例造一份这样的档。
  // 目录名 home、media 按字母排在 owner.json、state.json 前面：挑的顺序不能跟着 readdir 走。
  // media 里除了 6 张大图，还有 20 张小图：按路径挑的话，小图会把额度填到只剩几 KB，
  // 20KB 的 state.json 就进不来了。
  const box = await mkdtemp(join(tmpdir(), 'fish-backup-fit-'))
  const root = join(box, 'dsh-fish')
  // 事件流 13 万字节左右（打进包以后），20 张小图 8 万，state.json 2 万：大图能放进去一两张，放不下全部
  const limit = 400_000
  const srv = await backupServer(root, limit)
  try {
    await mkdir(join(root, 'home'), { recursive: true })
    await mkdir(join(root, 'media'), { recursive: true })
    const line = JSON.stringify({ id: 'ev_01J0000000000000000000000F', v: 1, type: 'utterance', text: '下雨了，"真的"\n'.repeat(20), ts: '2026-10-25T00:00:00.000Z', day: 1, stage: 1 }) + '\n'
    const events = line.repeat(Math.ceil(110_000 / Buffer.byteLength(line)))
    await writeFile(join(root, 'events.jsonl'), events)
    for (let i = 0; i < 6; i++) await writeFile(join(root, 'media', `p${i}.jpg`), Buffer.alloc(50_000, i + 1))
    for (let i = 0; i < 20; i++) await writeFile(join(root, 'media', `q${String(i).padStart(2, '0')}.jpg`), Buffer.alloc(3_000, i + 1))
    await writeFile(join(root, 'home', '她的身份.md'), '# 你是谁\n')
    await writeFile(join(root, 'config.json'), '{}')
    await writeFile(join(root, 'owner.json'), '{"mid":"1","cookie":"x"}')
    const state = JSON.stringify({ day: 3, pad: '鱼'.repeat(7_000) })
    await writeFile(join(root, 'state.json'), state)

    const got = await srv.request('GET', '/dsh-fish/backup')
    assert.equal(got.status, 200)
    const b = JSON.parse(got.text)
    const body = JSON.stringify(JSON.parse(got.text))
    assert.equal(b.fitsRestore, true, `restoreBytes=${b.restoreBytes}，skipped=${JSON.stringify(b.skipped)}`)
    assert.ok(Buffer.byteLength(body) <= limit, `真发出去的 ${Buffer.byteLength(body)} 超过了 ${limit}`)
    assert.ok(b.restoreBytes >= Buffer.byteLength(body), `${b.restoreBytes} < ${Buffer.byteLength(body)}`)
    const paths = b.files.map((f) => f.path)
    assert.equal(paths[0], 'events.jsonl', '事件流在包的最前面')
    for (const p of ['owner.json', 'state.json', 'config.json', 'home/她的身份.md']) assert.ok(paths.includes(p), `${p} 要在包里：${paths.join('|')}`)
    // 被挑出去的只有大图，每张都说了原因；小图都在
    const out = b.skipped.map((s) => s.replace(/（.*$/, ''))
    assert.ok(out.length > 0 && out.length < 6, `应当挤掉一部分大图：${JSON.stringify(b.skipped)}`)
    const big = [0, 1, 2, 3, 4, 5].map((i) => `media/p${i}.jpg`)
    assert.ok(out.every((p) => big.includes(p)), JSON.stringify(b.skipped))
    assert.deepEqual([...paths.filter((p) => big.includes(p)), ...out].sort(), big)
    assert.equal(paths.filter((p) => p.startsWith('media/q')).length, 20)

    const put = await srv.request('POST', '/dsh-fish/backup/restore', body)
    assert.equal(put.status, 200, put.text)
    const r = JSON.parse(put.text)
    assert.equal(r.ok, true)
    assert.equal(r.skippedCount, out.length)
    assert.equal(await readFile(join(root, 'owner.json'), 'utf8'), '{"mid":"1","cookie":"x"}')
    assert.equal(await readFile(join(root, 'state.json'), 'utf8'), state)
    assert.equal(await readFile(join(root, 'events.jsonl'), 'utf8'), events)
  } finally {
    await srv.close()
    await rm(box, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('量包大小不用整包 stringify，量出来的数和真 stringify 一样多', async () => {
  const { bundleBytes } = await import('../lib/backup.js')
  const ch = (...c) => String.fromCharCode(...c)
  const tricky = [
    `引号 " 反斜杠 ${ch(92)} 换行\n回车\r制表\t退格\b换页\f`,
    '其它控制字符 \u0001\u001f 和 \u007f',
    `落单的代理项 ${ch(0xd800)} 尾巴 ${ch(0xdfff)} 末尾${ch(0xd83d)}`,
    `一对代理项（鱼的表情）${ch(0xd83d, 0xdc1f)} 中文 é ß`,
    '',
    // 和 base64 一样的纯 ASCII
    Buffer.alloc(300, 7).toString('base64'),
  ]
  const bundle = {
    format: BACKUP_FORMAT,
    schema: EVENT_SCHEMA_VERSION,
    createdAt: '2026-11-09T00:00:00.000Z',
    files: tricky.map((data, i) => ({ path: `home/文件"${i}".txt`, size: i, enc: 'utf8', data })),
    skipped: ['媒体/大图.jpg（放进来就超过「从备份恢复」一次能收的大小）'],
    excluded: ['logs/'],
    bytes: 5,
    fileName: '大肥鱼-20261109-0000.json',
  }
  assert.equal(bundleBytes(bundle), Buffer.byteLength(JSON.stringify(bundle), 'utf8'))
})

test('恢复回执报的是真实条数：包里 250 个没装进去，回执说 250，名单只带前 200 条', async () => {
  const box = await mkdtemp(join(tmpdir(), 'fish-backup-count-'))
  const root = join(box, 'dsh-fish')
  try {
    const skipped = Array.from({ length: 250 }, (_, i) => `media/p${String(i).padStart(3, '0')}.jpg（总量已到 64MB 上限）`)
    const r = await restoreBackup({
      format: BACKUP_FORMAT,
      schema: EVENT_SCHEMA_VERSION,
      files: [{ path: 'events.jsonl', enc: 'utf8', data: '' }],
      skipped: ['logs/（不搬：logs）', ...skipped],
    }, root)
    assert.equal(r.ok, true, r.why)
    assert.equal(r.skippedCount, 250)
    assert.equal(r.skipped.length, 200)
    assert.deepEqual(r.skipped, skipped.slice(0, 200))
  } finally {
    await rm(box, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

// ---- 第二轮审查后补的（接 #65）：挑文件的几条规矩各有一条测试守着 ----

/** 不起 http，直接调 /backup 的 handler（恢复上限调小）。回的是设置页拿到的那个对象。 */
async function backupGet(root, restoreLimit) {
  const { registerObserve } = await import('../lib/observe.js')
  const routes = []
  const ctx = {
    get: (k) => (k === 'connection'
      ? { requestRejection: () => null }
      : k === 'webServer'
        ? { register: (def) => { routes.push(def); return () => {} } }
        : undefined),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }
  const handle = registerObserve(ctx, { root, restoreLimit })
  try {
    const route = routes.find((r) => r.path === '/dsh-fish/backup')
    let status = 0
    let text = ''
    const res = {
      writableEnded: false,
      writeHead: (s) => { status = s },
      setHeader: () => {},
      end: (s) => { text = String(s ?? ''); res.writableEnded = true },
    }
    await route.handler({ method: 'GET', url: '/dsh-fish/backup', headers: {} }, res)
    assert.equal(status, 200, text)
    return JSON.parse(text)
  } finally {
    handle.dispose()
  }
}

/** 设置页存文件、恢复时 POST 的都是这个：把拿到的对象原样 JSON.stringify 一次。 */
const wireOf = (b) => Buffer.byteLength(JSON.stringify(b))

/** 带引号、换行的事件行，凑够 bytes 字节：打进包要再转义一次。 */
function eventLines(bytes) {
  const line = JSON.stringify({ id: 'ev_01J0000000000000000000000G', v: 1, type: 'utterance', text: '下雨了，"真的"\n'.repeat(20), ts: '2026-10-25T00:00:00.000Z', day: 1, stage: 1 }) + '\n'
  return line.repeat(Math.max(1, Math.ceil(bytes / Buffer.byteLength(line))))
}

test('事件流打成包之后自己就超过恢复上限：只守 64MB，owner.json、state.json、home/ 一个都不挤掉', async () => {
  // 这时怎么挑都装不回去，导出回执照实说；为恢复上限把别的文件挤掉，只会让这份存档也不全。
  const box = await mkdtemp(join(tmpdir(), 'fish-backup-over-'))
  const root = join(box, 'dsh-fish')
  try {
    await mkdir(join(root, 'home'), { recursive: true })
    await mkdir(join(root, 'diary'), { recursive: true })
    const events = eventLines(120_000)
    await writeFile(join(root, 'events.jsonl'), events)
    await writeFile(join(root, 'owner.json'), '{"mid":"1","cookie":"x"}')
    await writeFile(join(root, 'state.json'), '{"day":3}')
    await writeFile(join(root, 'config.json'), '{}')
    await writeFile(join(root, 'home', '她的身份.md'), '# 你是谁\n')
    await writeFile(join(root, 'diary', '2026-10-28.md'), '今天\n')
    const limit = 100_000
    assert.ok(Buffer.byteLength(events) > limit, '事件流自己就超')

    const b = await backupGet(root, limit)
    assert.equal(b.fitsRestore, false, `restoreBytes=${b.restoreBytes}`)
    assert.ok(b.restoreBytes >= wireOf(b), `${b.restoreBytes} < ${wireOf(b)}`)
    assert.deepEqual(b.files.map((f) => f.path), [
      'events.jsonl',
      'config.json',
      'diary/2026-10-28.md',
      'home/她的身份.md',
      'owner.json',
      'state.json',
    ])
    assert.deepEqual(b.skipped, [])
    assert.equal(b.skippedUnlisted, 0)
  } finally {
    await rm(box, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('额度紧的时候先装丢了找不回来的：owner.json 比日记大也先进，state.json、.log 比日记小也排最后；skipped 按同样的先后', async () => {
  // 先后看丢了能不能找回来，不看在第几层、也不只看大小：
  // 顶层的 owner.json、config.json → 她的 diary/ → 别的子目录 media/ → 能由事件流重算的 state.json 和现场记录 .log。
  const box = await mkdtemp(join(tmpdir(), 'fish-backup-rank-'))
  const root = join(box, 'dsh-fish')
  try {
    await mkdir(join(root, 'diary'), { recursive: true })
    await mkdir(join(root, 'media'), { recursive: true })
    await writeFile(join(root, 'events.jsonl'), eventLines(300))
    await writeFile(join(root, 'owner.json'), JSON.stringify({ mid: '1', cookie: 'c'.repeat(2_960) }))
    await writeFile(join(root, 'config.json'), JSON.stringify({ pad: 'x'.repeat(480) }))
    // 日记 60 篇，日期越早越大：同一档里「小的先」挑，名单却要按路径排
    const diary = Array.from({ length: 60 }, (_, i) => ({
      path: `diary/2026-${String(9 + Math.floor(i / 30)).padStart(2, '0')}-${String(1 + (i % 30)).padStart(2, '0')}.md`,
      size: 1_500 + (59 - i),
    }))
    for (const d of diary) await writeFile(join(root, d.path), 'x'.repeat(d.size))
    // 100 张小图，比日记小得多：日记装不下以后，剩下的那点地方由它们填
    for (let i = 0; i < 100; i++) await writeFile(join(root, 'media', `p${String(i).padStart(3, '0')}.jpg`), Buffer.alloc(100 + i, i))
    await writeFile(join(root, 'state.json'), JSON.stringify({ day: 3, pad: 's'.repeat(980) }))
    await writeFile(join(root, 'launch.err.log'), 'e'.repeat(300))

    const limit = 50_000
    const b = await backupGet(root, limit)
    assert.equal(b.fitsRestore, true, `restoreBytes=${b.restoreBytes}`)
    assert.ok(wireOf(b) <= limit, `真发出去的 ${wireOf(b)} 超过了 ${limit}`)
    const paths = b.files.map((f) => f.path)
    assert.equal(paths[0], 'events.jsonl')
    assert.ok(paths.includes('owner.json'), 'owner.json 比每篇日记都大，也要先进')
    assert.ok(paths.includes('config.json'))
    const out = b.skipped.map((s) => s.replace(/（[^（]*）$/, ''))
    assert.ok(out.includes('state.json'), 'state.json 比日记小，但能由事件流重算，排在最后')
    assert.ok(out.includes('launch.err.log'), '.log 是现场记录，排在最后')
    const inDiary = diary.filter((d) => paths.includes(d.path))
    const outDiary = diary.filter((d) => out.includes(d.path))
    assert.ok(inDiary.length > 0 && outDiary.length > 0, `日记要装进去一部分、挑出去一部分：${inDiary.length}/${outDiary.length}`)
    assert.equal(inDiary.length + outDiary.length, diary.length)
    assert.ok(Math.max(...inDiary.map((d) => d.size)) <= Math.min(...outDiary.map((d) => d.size)), '同一档里小的先')
    assert.ok(out.some((p) => p.startsWith('media/')), '小图不是全都装得下')
    // 每个文件不是在包里，就是在 skipped 里，一个不落
    assert.equal(b.skippedUnlisted, 0)
    assert.equal(paths.length + out.length, 1 + 2 + 60 + 100 + 2)
    // skipped 的先后和挑的先后一样：diary/ → media/ → launch.err.log、state.json；同一档按路径
    const rankOf = (p) => (p === 'state.json' || p.endsWith('.log') ? 3 : p.startsWith('diary/') ? 1 : p.startsWith('media/') ? 2 : 0)
    const want = [...out].sort((x, y) => rankOf(x) - rankOf(y) || (x < y ? -1 : x > y ? 1 : 0))
    assert.deepEqual(out, want)
    assert.deepEqual(out.slice(-2), ['launch.err.log', 'state.json'])
  } finally {
    await rm(box, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('有很多文件会被挑出去时，先给它们每个留一行说明：包装得下，名单一个不落', async () => {
  // 只顾往包里装、不给说明行留地方的话，装到最后，「没装进去」的那些连名字都写不下。
  const box = await mkdtemp(join(tmpdir(), 'fish-backup-reserve-'))
  const root = join(box, 'dsh-fish')
  try {
    await mkdir(join(root, 'home', '笔记'), { recursive: true })
    await writeFile(join(root, 'events.jsonl'), eventLines(20_000))
    await writeFile(join(root, 'owner.json'), '{"mid":"1"}')
    // 300 份笔记，路径长：每份写一行说明要 140 字节上下，比装进去省，但地方只够装一部分
    const notes = Array.from({ length: 300 }, (_, i) => `home/笔记/${String(i).padStart(3, '0')}-${'一段很长的笔记标题'.repeat(2)}.md`)
    for (const [i, p] of notes.entries()) await writeFile(join(root, p), 'n'.repeat(380 + (i % 40)))
    const limit = 90_000
    const b = await backupGet(root, limit)
    assert.equal(b.fitsRestore, true, `restoreBytes=${b.restoreBytes}`)
    assert.ok(wireOf(b) <= limit, `真发出去的 ${wireOf(b)} 超过了 ${limit}`)
    assert.ok(b.restoreBytes >= wireOf(b))
    const out = b.skipped.map((s) => s.replace(/（[^（]*）$/, ''))
    assert.ok(out.length > 50, `要有一批笔记装不进去：${out.length}`)
    assert.equal(b.skippedUnlisted, 0, '地方够留，就每个都写名字')
    assert.equal(b.files.length + out.length, 2 + notes.length)
    // 留的是还没装进去的那几行，装进去一个就少留一行：地方不会白空着（剩下的不够再放一份笔记）
    assert.ok(limit - b.restoreBytes < 1_000, `还剩 ${limit - b.restoreBytes} 字节没用上`)
    assert.ok(b.files.some((f) => f.path === 'owner.json'))
  } finally {
    await rm(box, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('事件流装得下，整份包就装得下：恢复上限从刚够装下事件流往上挪，每一档都装得下、个数对得上', async () => {
  // 第二轮审查：原来拿「事件流 + 4KB 余量 + 给每个文件留的说明行」去比上限，
  // 事件流装得下、加上这些就装不下时，干脆不守上限，整份包按 64MB 塞，结果装不回去。
  const box = await mkdtemp(join(tmpdir(), 'fish-backup-sweep-'))
  const root = join(box, 'dsh-fish')
  try {
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'events.jsonl'), eventLines(30_000))
    // 先量只有事件流的包
    const only = (await backupGet(root, 10_000_000)).restoreBytes
    await mkdir(join(root, 'home'), { recursive: true })
    await writeFile(join(root, 'owner.json'), '{"mid":"1","cookie":"x"}')
    for (let i = 0; i < 40; i++) await writeFile(join(root, 'home', `n${String(i).padStart(2, '0')}.md`), '记'.repeat(300 + i))
    let folded = 0
    // 外壳按最长的写法算，多估一两百字节：从多出 400 字节起往上挪
    for (let d = 400; d < 400 + 37 * 60; d += 37) {
      const limit = only + d
      const b = await backupGet(root, limit)
      assert.equal(b.fitsRestore, true, `limit=${limit} restoreBytes=${b.restoreBytes}`)
      assert.ok(wireOf(b) <= limit, `limit=${limit}：真发出去的 ${wireOf(b)}`)
      assert.ok(b.restoreBytes >= wireOf(b), `limit=${limit}：${b.restoreBytes} < ${wireOf(b)}`)
      assert.equal(b.files[0].path, 'events.jsonl')
      assert.equal(b.files.length + b.skipped.length + b.skippedUnlisted, 1 + 1 + 40, `limit=${limit}`)
      if (b.skippedUnlisted) folded++
      // 地方够装 owner.json 时，它总是第一个进包
      if (b.files.length > 1) assert.ok(b.files.some((f) => f.path === 'owner.json'), `limit=${limit}`)
    }
    assert.ok(folded > 0, '这组上限里要有连说明行都写不下、只记个数的')
  } finally {
    await rm(box, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('连说明行都写不下时只记个数：导出说装得下，恢复真能装回去，恢复回执按真实条数说', async () => {
  const box = await mkdtemp(join(tmpdir(), 'fish-backup-fold-'))
  const root = join(box, 'dsh-fish')
  const events = eventLines(30_000)
  try {
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'events.jsonl'), events)
    const only = (await backupGet(root, 10_000_000)).restoreBytes
    await mkdir(join(root, 'home'), { recursive: true })
    await writeFile(join(root, 'owner.json'), '{"mid":"1","cookie":"x"}')
    for (let i = 0; i < 40; i++) await writeFile(join(root, 'home', `n${String(i).padStart(2, '0')}.md`), '记'.repeat(1_700))
    // 事件流装得下，再加 owner.json 和几行说明就满了
    const limit = only + 600
    const srv = await backupServer(root, limit)
    try {
      const got = await srv.request('GET', '/dsh-fish/backup')
      const b = JSON.parse(got.text)
      const body = JSON.stringify(b)
      assert.equal(b.fitsRestore, true, `restoreBytes=${b.restoreBytes}`)
      assert.ok(Buffer.byteLength(body) <= limit)
      assert.deepEqual(b.files.map((f) => f.path), ['events.jsonl', 'owner.json'])
      assert.ok(b.skippedUnlisted > 0, JSON.stringify(b.skipped))
      assert.equal(b.skipped.length + b.skippedUnlisted, 40)

      const put = await srv.request('POST', '/dsh-fish/backup/restore', body)
      assert.equal(put.status, 200, put.text)
      const r = JSON.parse(put.text)
      assert.equal(r.skippedCount, 40)
      assert.equal(r.skippedUnlisted, b.skippedUnlisted)
      assert.deepEqual(r.skipped, b.skipped)
      assert.equal(await readFile(join(root, 'events.jsonl'), 'utf8'), events)
      assert.equal(await readFile(join(root, 'owner.json'), 'utf8'), '{"mid":"1","cookie":"x"}')
    } finally {
      await srv.close()
    }
  } finally {
    await rm(box, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('旧包没有 skippedUnlisted、或者被改成乱七八糟的值：恢复回执只按名单算', async () => {
  const box = await mkdtemp(join(tmpdir(), 'fish-backup-unlisted-'))
  try {
    for (const [i, v] of [undefined, -3, 1.5, 'x', null].entries()) {
      const r = await restoreBackup({
        format: BACKUP_FORMAT,
        schema: EVENT_SCHEMA_VERSION,
        files: [{ path: 'events.jsonl', enc: 'utf8', data: '' }],
        skipped: ['home/a.md（读失败）'],
        ...(v === undefined ? {} : { skippedUnlisted: v }),
      }, join(box, `r${i}`, 'dsh-fish'))
      assert.equal(r.ok, true, r.why)
      assert.equal(r.skippedCount, 1, String(v))
      assert.equal(r.skippedUnlisted, 0)
    }
  } finally {
    await rm(box, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('别的文件原始字节合计守 64MB（事件流不算在里面）：超了的挑出去、写明原因', async () => {
  const box = await mkdtemp(join(tmpdir(), 'fish-backup-64-'))
  const root = join(box, 'dsh-fish')
  try {
    await mkdir(join(root, 'home'), { recursive: true })
    // 事件流 10MB：不占这 64MB（算进去的话，下面 9 份里要挑出去两份）
    await writeFile(join(root, 'events.jsonl'), eventLines(10_000_000))
    await writeFile(join(root, 'owner.json'), '{"mid":"1"}')
    // 9 份 7.6MB 的文本（都在 8MB 单文件上限以内），合计 68.4MB：装 8 份就到 64MB 了
    const sizes = Array.from({ length: 9 }, (_, i) => 7_600_000 + i)
    for (const [i, n] of sizes.entries()) await writeFile(join(root, 'home', `大${i}.md`), 'x'.repeat(n))
    const b = await collectBackup(root, { restoreLimit: 1e12 })
    const paths = b.files.map((f) => f.path)
    assert.ok(paths.includes('owner.json'))
    assert.deepEqual(b.skipped, ['home/大8.md（总量已到 64MB 上限）'], '同一档里小的先，最大的那份挑出去')
    assert.equal(paths.filter((p) => p.startsWith('home/')).length, 8)
    const capped = b.files.filter((f) => f.path !== 'events.jsonl').reduce((n, f) => n + f.size, 0)
    assert.ok(capped <= 64 * 1024 * 1024, `别的文件合计 ${capped}`)
    assert.equal(b.bytes, b.files.reduce((n, f) => n + f.size, 0))
  } finally {
    await rm(box, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

// ---- issue #65：一份包里混着坏文件时，先点名，再让人选跳不跳 ----
function bundleWithBadText(extra = {}) {
  return {
    format: BACKUP_FORMAT,
    schema: EVENT_SCHEMA_VERSION,
    createdAt: '2026-11-09T00:00:00.000Z',
    ...extra,
    files: [
      { path: 'events.jsonl', enc: 'utf8', size: 11, data: '{"id":"x"}\n' },
      { path: 'config.json', enc: 'utf8', size: 7, data: '{"a":1}' },
      // 早先导出时丢过字节，留下的是替换符
      { path: 'home/她的身份.md', enc: 'utf8', size: 18, data: '# 她\n今天看\ufffd了海。\n' },
    ],
  }
}

test('恢复撞上碎字文件：先把坏文件点出来，一个文件都不动，等人拿主意（issue #65）', async () => {
  const dest = await mkdtemp(join(tmpdir(), 'fish-restore-'))
  try {
    await writeFile(join(dest, 'config.json'), '{"old":true}')
    const bundle = bundleWithBadText()
    assert.deepEqual(badTextFiles(bundle), ['home/她的身份.md'])
    const r = await restoreBackup(bundle, dest)
    assert.equal(r.ok, false)
    assert.equal(r.needDecision, true)
    assert.deepEqual(r.badFiles, ['home/她的身份.md'])
    assert.equal(r.badCount, 1)
    assert.match(r.why, /碎字/)
    // 现在的档一个字节都没动：没有封存、没有写、也没有跳到一半
    assert.equal(await readFile(join(dest, 'config.json'), 'utf8'), '{"old":true}')
    await assert.rejects(readFile(join(dest, 'events.jsonl'), 'utf8'))
  } finally {
    await rm(dest, { recursive: true, force: true })
  }
})

test('人选了跳过：坏文件不写回去，其余照常恢复，回执点名跳过了谁（issue #65）', async () => {
  const dest = await mkdtemp(join(tmpdir(), 'fish-restore-'))
  try {
    const r = await restoreBackup(bundleWithBadText(), dest, { skipBad: true })
    assert.equal(r.ok, true, r.why)
    assert.deepEqual(r.skippedBad, ['home/她的身份.md'])
    assert.equal(r.restored, 2, '写明恢复了几个，不把跳过的算进去')
    assert.equal(await readFile(join(dest, 'config.json'), 'utf8'), '{"a":1}')
    assert.equal(await readFile(join(dest, 'events.jsonl'), 'utf8'), '{"id":"x"}\n')
    await assert.rejects(readFile(join(dest, 'home', '她的身份.md'), 'utf8'))
  } finally {
    await rm(dest, { recursive: true, force: true })
  }
})

test('不是 UTF-8 的文本文件按原字节装进包、在 nonUtf8 里点名，装回来字节一模一样（issue #65）', async () => {
  const root = await makeRoot()
  const dest = await mkdtemp(join(tmpdir(), 'fish-restore-'))
  try {
    // GBK 的「你好」：按 utf8 硬读会变成两个替换符，原字节就回不来了
    const gbk = Buffer.from([0xc4, 0xe3, 0xba, 0xc3])
    await mkdir(join(root, 'home'), { recursive: true })
    await writeFile(join(root, 'home', '旧笔记.md'), gbk)
    const b = await collectBackup(root)
    const f = b.files.find((x) => x.path === 'home/旧笔记.md')
    assert.equal(f.enc, 'base64', '不是 UTF-8 的文本只能按原字节装')
    assert.equal(f.text, true, '带一个「本来是文本」的标记')
    assert.deepEqual([...Buffer.from(f.data, 'base64')], [...gbk])
    assert.deepEqual(b.nonUtf8, ['home/旧笔记.md'])
    // 正常的 UTF-8 文本照旧明文装，不混进名单
    const ok = b.files.find((x) => x.path === 'home/她的身份.md')
    assert.equal(ok.enc, 'utf8')
    assert.equal(ok.text, undefined)
    assert.ok(!b.nonUtf8.includes('home/她的身份.md'))

    const r = await restoreBackup(b, dest)
    assert.equal(r.ok, true, r.why)
    assert.deepEqual([...(await readFile(join(dest, 'home', '旧笔记.md')))], [...gbk])
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    await rm(dest, { recursive: true, force: true })
  }
})
