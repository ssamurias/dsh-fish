/**
 * autobackup.test.mjs —— 自动备份（2026-11-14，用户 m00002）
 *
 * 为什么要有：
 *   ① 「人不用记得」这件事本身没法靠按钮测，能测的是它的判断：「现在该不该存」
 *     只能由开关和 lastAt 决定，重启、时区、时钟回拨都不能让它变成别的结论。
 *   ② 它会把文件写进用户的数据文件夹，还会删文件。所以两条边界必须钉住：
 *      只删自己那批（`大肥鱼-自动-…`），用户自己放的手动备份一个都不碰；
 *      读回来的时候只认白名单里的名字，`../` 这种不能变成任意文件读取。
 *   ③ 存出来的东西要能直接被「从备份恢复」吃回去——存一份、checkBundle 一遍。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AUTO_PREFIX,
  CATCHUP_GAP_MS,
  LATEST_NAME,
  autoBackupDir,
  autoBackupName,
  isAutoBackupName,
  isAutoBackupFile,
  autoBackupDue,
  catchupDue,
  listAutoBackups,
  pruneAutoBackups,
  runAutoBackup,
  runLatestBackup,
  catchupBackup,
  readAutoBackup,
  autoBackupStatus,
  autoBackupSizeText,
} from '../lib/autobackup.js'
import { checkBundle, BACKUP_FORMAT } from '../lib/backup.js'
import { readConfig } from '../lib/store.js'

const DAY = 86_400_000

async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), 'fish-autobackup-'))
  await writeFile(join(root, 'events.jsonl'), '{"id":"ev_01J0000000000000000000000A","v":1,"type":"utterance","text":"我看见了。","ts":"2026-10-25T00:00:00.000Z","day":1,"stage":1}\n')
  await writeFile(join(root, 'config.json'), '{}')
  await writeFile(join(root, 'owner.json'), '{"mid":"123","hasCookie":true}')
  await mkdir(join(root, 'diary'), { recursive: true })
  await writeFile(join(root, 'diary', '2026-10-25.md'), '# 日记\n今天看到了海。\n')
  return root
}

const cfgOf = (backup) => ({ backup: { enabled: true, everyDays: 1, keep: 7, lastAt: '', ...backup } })

// ---- 名字 ----

test('自动备份的名字带前缀与到秒的时间戳，本地时区拼，不用 UTC', () => {
  const d = new Date(2026, 10, 14, 6, 53, 9) // 2026-11-14 06:53:09 本地
  assert.equal(autoBackupName(d), '大肥鱼-自动-20261114-065309.json')
  assert.equal(AUTO_PREFIX, '大肥鱼-自动-')
})

test('只认自己那批名字：手动备份、别的 json、穿越写法都不是', () => {
  assert.equal(isAutoBackupName('大肥鱼-自动-20261114-065309.json'), true)
  // 手动那颗（backupFileName）名字里没有「自动」
  assert.equal(isAutoBackupName('大肥鱼-20261114-0653.json'), false)
  assert.equal(isAutoBackupName('../大肥鱼-自动-20261114-065309.json'), false)
  assert.equal(isAutoBackupName('大肥鱼-自动-2026111-065309.json'), false)
  assert.equal(isAutoBackupName('大肥鱼-自动-20261114-065309.json.bak'), false)
  assert.equal(isAutoBackupName(''), false)
  assert.equal(isAutoBackupName(null), false)
})

// ---- 该不该备份（纯函数矩阵）----

test('关着就不备份，不管过了多久', () => {
  const now = new Date('2026-11-14T06:00:00.000Z')
  const r = autoBackupDue(cfgOf({ enabled: false, lastAt: '2020-01-01T00:00:00.000Z' }), now)
  assert.equal(r.due, false)
  assert.equal(r.why, '关着')
})

test('从来没备份过：立刻该备份', () => {
  const r = autoBackupDue(cfgOf({}), new Date('2026-11-14T06:00:00.000Z'))
  assert.deepEqual([r.due, r.why], [true, '还没备份过'])
})

test('默认配置（每天一份）只隔了半小时 → 等，并说还剩几小时', () => {
  const now = new Date('2026-11-14T06:00:00.000Z')
  const last = new Date(now.getTime() - 30 * 60_000).toISOString()
  const r = autoBackupDue(cfgOf({ lastAt: last }), now)
  assert.equal(r.due, false)
  assert.equal(r.why, '24 小时后')
})

test('刚好到一个周期就该备份（不是「过了」才算）', () => {
  const now = new Date('2026-11-14T06:00:00.000Z')
  const last = new Date(now.getTime() - DAY).toISOString()
  const r = autoBackupDue(cfgOf({ lastAt: last }), now)
  assert.equal(r.due, true)
  assert.equal(r.why, '距上次超过 1 天')
})

test('自定义间隔：3 天一份，第 2 天不该、第 3 天该', () => {
  const now = new Date('2026-11-14T06:00:00.000Z')
  const two = new Date(now.getTime() - 2 * DAY).toISOString()
  assert.equal(autoBackupDue(cfgOf({ everyDays: 3, lastAt: two }), now).due, false)
  const three = new Date(now.getTime() - 3 * DAY).toISOString()
  assert.equal(autoBackupDue(cfgOf({ everyDays: 3, lastAt: three }), now).due, true)
})

test('lastAt 是坏字符串 → 当成没备份过（不能永远不备份）', () => {
  const r = autoBackupDue(cfgOf({ lastAt: '不是时间' }), new Date('2026-11-14T06:00:00.000Z'))
  assert.equal(r.due, true)
})

test('时钟被往回调过（lastAt 在未来）→ 当成该备份，不干等', () => {
  const now = new Date('2026-11-14T06:00:00.000Z')
  const last = new Date(now.getTime() + 3 * DAY).toISOString()
  const r = autoBackupDue(cfgOf({ lastAt: last }), now)
  assert.equal(r.due, true)
  assert.match(r.why, /时钟/)
})

test('everyDays 被写成 0 / 负数 / 小数也不崩，最少按 1 天算', () => {
  const now = new Date('2026-11-14T06:00:00.000Z')
  const half = new Date(now.getTime() - DAY / 2).toISOString()
  assert.equal(autoBackupDue(cfgOf({ everyDays: 0, lastAt: half }), now).due, false)
})

// ---- 存一份 ----

test('存一份：落在 <数据文件夹>/backups/，内容是能被恢复吃回去的包', async () => {
  const root = await makeRoot()
  try {
    const now = new Date(2026, 10, 14, 6, 53, 9)
    const r = await runAutoBackup(root, { now, config: cfgOf({}) })
    assert.equal(r.ok, true, r.why)
    assert.equal(r.name, '大肥鱼-自动-20261114-065309.json')
    assert.ok(r.bytes > 0)
    assert.ok(r.files >= 2, '至少要有 events.jsonl 和 config.json')

    const text = await readFile(join(autoBackupDir(root), r.name), 'utf8')
    const bundle = JSON.parse(text)
    assert.equal(bundle.format, BACKUP_FORMAT)
    assert.equal(bundle.fileName, r.name)
    // 最关键的一条：存出来的东西必须能被「从备份恢复」直接吃
    assert.equal(checkBundle(bundle).ok, true, checkBundle(bundle).why)
    const paths = bundle.files.map((f) => f.path)
    assert.ok(paths.includes('events.jsonl'))
    assert.ok(paths.includes('diary/2026-10-25.md'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('存完把 lastAt 记进配置——重启 DSH 不会把计时重置成「又来一份」', async () => {
  const root = await makeRoot()
  try {
    const now = new Date('2026-11-14T06:00:00.000Z')
    await runAutoBackup(root, { now, config: cfgOf({}) })
    const cfg = await readConfig(root)
    assert.equal(cfg?.backup?.lastAt, now.toISOString())
    // 记住之后立刻再判：不该再来一份
    assert.equal(autoBackupDue(cfg, new Date(now.getTime() + 60_000)).due, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('攒的份数超过 keep 就删旧的，只删自己那批', async () => {
  const root = await makeRoot()
  try {
    const dir = autoBackupDir(root)
    await mkdir(dir, { recursive: true })
    // 用户自己放的手动备份：不能被清理波及
    await writeFile(join(dir, '大肥鱼-20261101-0900.json'), '{"mine":true}')
    await writeFile(join(dir, '随便一个笔记.json'), '{}')
    for (let i = 1; i <= 5; i++) {
      const n = String(i).padStart(2, '0')
      await writeFile(join(dir, `大肥鱼-自动-2026110${i}-060000.json`), '{}')
    }
    const { removed } = await pruneAutoBackups(root, 2)
    assert.equal(removed.length, 3)
    const left = await readdir(dir)
    assert.equal(left.filter(isAutoBackupName).length, 2)
    // 留下的应该是最新的两份
    assert.ok(left.includes('大肥鱼-自动-20261105-060000.json'))
    assert.ok(left.includes('大肥鱼-自动-20261104-060000.json'))
    // 别人的东西原样都在
    assert.ok(left.includes('大肥鱼-20261101-0900.json'))
    assert.ok(left.includes('随便一个笔记.json'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('目录不存在时列表是空的，不抛错（第一次打开设置页就是这个状态）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-autobackup-empty-'))
  try {
    assert.deepEqual(await listAutoBackups(root), [])
    const st = await autoBackupStatus(root, { config: cfgOf({}) })
    assert.equal(st.count, 0)
    assert.equal(st.bytes, 0)
    assert.equal(st.sizeText, undefined, 'sizeText 由 status 之外的 autoBackupSizeText 出，别混')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('列表按名字（也就是时间）从新到旧，不靠 mtime', async () => {
  const root = await makeRoot()
  try {
    const dir = autoBackupDir(root)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, '大肥鱼-自动-20261101-060000.json'), '{}')
    await writeFile(join(dir, '大肥鱼-自动-20261103-060000.json'), '{}')
    await writeFile(join(dir, '大肥鱼-自动-20261102-060000.json'), '{}')
    const list = await listAutoBackups(root)
    assert.deepEqual(list.map((x) => x.name), [
      '大肥鱼-自动-20261103-060000.json',
      '大肥鱼-自动-20261102-060000.json',
      '大肥鱼-自动-20261101-060000.json',
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ---- 读回来 ----

test('读回来：穿越名、别的文件名一律拒，问的是「不是一个自动备份的文件名」', async () => {
  const root = await makeRoot()
  try {
    for (const bad of ['../config.json', '大肥鱼-20261114-0653.json', '/etc/passwd', '']) {
      const r = await readAutoBackup(bad, root)
      assert.equal(r.ok, false, `应该拒绝：${bad}`)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('读回来：名字合法但文件不在 → 说人话，不抛错', async () => {
  const root = await makeRoot()
  try {
    const r = await readAutoBackup('大肥鱼-自动-20260101-000000.json', root)
    assert.equal(r.ok, false)
    assert.match(r.why, /不在了/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('读回来：文件名对但内容不是大肥鱼的包 → 拒', async () => {
  const root = await makeRoot()
  try {
    const dir = autoBackupDir(root)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, '大肥鱼-自动-20261114-065309.json'), '{"format":"别的什么/1","files":[]}')
    const r = await readAutoBackup('大肥鱼-自动-20261114-065309.json', root)
    assert.equal(r.ok, false)
    assert.match(r.why, /不是大肥鱼的备份/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('存一份再读回来：文本和包都在，能直接交给恢复', async () => {
  const root = await makeRoot()
  try {
    const now = new Date(2026, 10, 14, 6, 53, 9)
    const w = await runAutoBackup(root, { now, config: cfgOf({}) })
    const r = await readAutoBackup(w.name, root)
    assert.equal(r.ok, true, r.why)
    assert.equal(r.name, w.name)
    assert.equal(r.bundle.format, BACKUP_FORMAT)
    assert.ok(r.text.length > 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ---- 设置页那张卡 ----

test('状态：关着也如实说关着，并给出目录与份数', async () => {
  const root = await makeRoot()
  try {
    const st = await autoBackupStatus(root, { now: new Date('2026-11-14T06:00:00.000Z'), config: cfgOf({ enabled: false }) })
    assert.equal(st.enabled, false)
    assert.equal(st.due, false)
    assert.equal(st.dueWhy, '关着')
    assert.equal(st.dir, autoBackupDir(root))
    assert.equal(st.everyDays, 1)
    assert.equal(st.keep, 7)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('没攒过的时候给人的那句是「还没有」', () => {
  assert.equal(autoBackupSizeText({ count: 0, bytes: 0 }), '还没有')
  // 大小的写法跟手动备份那颗同一个（sizeText），别在这里另立一套单位。
  assert.match(autoBackupSizeText({ count: 3, bytes: 2_000_000 }), /^3 份，一共 \d+(\.\d)?MB$/)
  assert.match(autoBackupSizeText({ count: 1, bytes: 40_000 }), /^1 份，一共 \d+KB$/)
})

// ---- 兜底那份（用户 m00597：谁也不知道哪次启动是最后一次）----

test('兜底那份的名字固定，不随时间变，也不会被当成历史档去清理', () => {
  assert.equal(LATEST_NAME, '大肥鱼-自动-最新.json')
  // 它必须能读回来（恢复要它），但不能进「攒了几份」那批。
  assert.equal(isAutoBackupFile(LATEST_NAME), true)
  assert.equal(isAutoBackupName(LATEST_NAME), false)
  assert.equal(isAutoBackupFile('大肥鱼-自动-20261114-065309.json'), true)
  assert.equal(isAutoBackupFile('../config.json'), false)
})

test('该不该刷兜底那份：只看「有没有新东西」和半小时节流', () => {
  const now = new Date('2026-11-14T08:00:00.000Z')
  const at = now.getTime()
  const cfg = cfgOf({})
  // 关着就什么都不做
  assert.deepEqual(catchupDue(cfgOf({ enabled: false }), now, { latestAt: 0, dataAt: 1 }), { due: false, why: '关着' })
  // 还一份都没有：立刻刷（这条保证「每次启动至少落一份」）
  const first = catchupDue(cfg, now, { latestAt: 0, dataAt: 0 })
  assert.equal(first.due, true)
  assert.match(first.why, /还没有/)
  // 事件流没比那份更新：什么都不用做（哪怕过了很久）
  assert.deepEqual(catchupDue(cfg, now, { latestAt: at, dataAt: at }), { due: false, why: '没有新东西' })
  // 有新东西但刚刷过：等节流
  const soon = catchupDue(cfg, new Date(at + 60_000), { latestAt: at, dataAt: at + 1 })
  assert.equal(soon.due, false)
  assert.match(soon.why, /分钟后再看/)
  // 有新东西、也过了半小时：刷
  assert.equal(catchupDue(cfg, new Date(at + CATCHUP_GAP_MS), { latestAt: at, dataAt: at + 1 }).due, true)
  // 启动第一拍 / 退出前要的是「这次一定有一份」，不受节流挡
  assert.equal(catchupDue(cfg, new Date(at + 60_000), { latestAt: at, dataAt: at + 1, force: true }).due, true)
})

test('刷兜底那份：落在 backups/、能被恢复吃回去，且不写 lastAt、不占 keep', async () => {
  const root = await makeRoot()
  try {
    const now = new Date(2026, 10, 14, 7, 3, 0)
    const r = await runLatestBackup(root, { now, config: cfgOf({}) })
    assert.equal(r.ok, true, r.why)
    assert.equal(r.name, LATEST_NAME)

    const bundle = JSON.parse(await readFile(join(autoBackupDir(root), LATEST_NAME), 'utf8'))
    assert.equal(bundle.format, BACKUP_FORMAT)
    assert.equal(bundle.fileName, LATEST_NAME)
    assert.equal(checkBundle(bundle).ok, true, checkBundle(bundle).why)

    // 两条腿互相不干扰：刷兜底不该把「每 N 天一份」的计时重置，
    // 否则天天开机就永远攒不出一份带日子的历史档。
    // （readConfig 读的是盘上的原样字节，不是补过默认值的那份——所以这里就是 undefined。）
    const cfg = await readConfig(root)
    assert.equal(cfg?.backup?.lastAt, undefined)

    // 它不算进「攒了几份」，也不会被 prune 删掉
    for (let i = 1; i <= 3; i++) await writeFile(join(autoBackupDir(root), `大肥鱼-自动-2026110${i}-060000.json`), '{}')
    const { removed } = await pruneAutoBackups(root, 1)
    assert.equal(removed.length, 2)
    const left = await readdir(autoBackupDir(root))
    assert.ok(left.includes(LATEST_NAME), '兜底那份不能被清理波及')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('catchupBackup：该刷就刷，不该刷就什么都不写', async () => {
  const root = await makeRoot()
  try {
    const now = new Date()
    const first = await catchupBackup(root, { now, config: cfgOf({}) })
    assert.equal(first.ok, true, first.skipped || first.why)
    assert.equal(first.name, LATEST_NAME)

    // 刚刷完、库里也没新东西：不动
    const again = await catchupBackup(root, { now: new Date(now.getTime() + 60_000), config: cfgOf({}) })
    assert.equal(again.ok, false)
    assert.equal(again.skipped, '没有新东西')

    // 关掉之后连 force 都不刷
    const off = await catchupBackup(root, { now, config: cfgOf({ enabled: false }), force: true })
    assert.equal(off.ok, false)
    assert.equal(off.skipped, '关着')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('兜底那份也能读回来（设置页那张列表里点「从这份恢复」走得通）', async () => {
  const root = await makeRoot()
  try {
    await runLatestBackup(root, { now: new Date(), config: cfgOf({}) })
    const r = await readAutoBackup(LATEST_NAME, root)
    assert.equal(r.ok, true, r.why)
    assert.equal(r.bundle.format, BACKUP_FORMAT)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('状态里能看出「只有最新那一份」——这时候不该说「还没有」', async () => {
  const root = await makeRoot()
  try {
    await runLatestBackup(root, { now: new Date(), config: cfgOf({}) })
    const st = await autoBackupStatus(root, { config: cfgOf({}) })
    assert.equal(st.count, 0, 'count 说的是历史档的份数')
    assert.ok(st.latest, '兜底那份要在状态里露出来')
    assert.ok(st.bytes > 0)
    assert.match(autoBackupSizeText(st), /^只有兜底那一份，/)
    // 攒出历史档之后回到原来的说法
    await runAutoBackup(root, { now: new Date(), config: cfgOf({}) })
    const st2 = await autoBackupStatus(root, { config: cfgOf({}) })
    assert.match(autoBackupSizeText(st2), /^1 份，一共 /)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
