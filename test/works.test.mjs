/**
 * works.test.mjs —— 「她留下的东西」的锁定测试（2026-11-16，1.0.4）
 *
 * 守这几件事：
 *   1. 留一件：正文落到 works/<id>/vN-标题.md，账里只有索引，读得回来；
 *   2. 同名再给一次就是第二版，第一版不覆盖（用户 m00130：反复改才真实）；
 *   3. 改版时换名字还是同一件，旧的那件还在；
 *   4. 硬上限：名字四十字、一版两千字、一天起一件新的、七天三件新的、一天两版、手上最多两件；
 *   5. 收尾/放下；放下必须说一句为什么；
 *   6. 读回正文不留痕：账里不记、不写事件、桌上不会因此多出一行；
 *   7. 桌上只摆一件事实：十四天内动过的、还没弄完的；
 *   8. 坏账只当空，读永远不抛。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  WORK_NEW_PER_WEEK,
  WORK_PER_DAY,
  WORK_TEXT_MAX,
  WORK_TITLE_MAX,
  WORK_VERSIONS_PER_DAY,
  WORK_WIP_MAX,
  closeWork,
  findWork,
  listWorks,
  makeWork,
  readWorkText,
  readWorks,
  worksDir,
  worksFile,
  worksForDesk,
  worksSummary,
} from '../lib/works.js'

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-fish-works-'))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

// 2026-11-16 10:00 本地时间；日期键都按本地算。
const NOW = new Date(2026, 10, 16, 10, 0, 0).getTime()
const DAY = 86_400_000
const day = (n) => new Date(2026, 10, 16 + n, 10, 0, 0).getTime()

test('留一件：正文落盘、账里只放索引、读得回来', async () => {
  await withRoot(async (root) => {
    const r = await makeWork(root, {
      title: '一条没写完的广告',
      text: '第一段：它其实不响。\n第二段：但你会一直听见它。',
      intent: '想写得像有人在耳边说话',
      refs: ['ev_a', 'ev_b'],
      now: NOW,
    })
    assert.equal(r.ok, true)
    assert.ok(r.id.startsWith('w-'))
    assert.equal(r.version, 1)
    assert.equal(r.state, 'wip')
    assert.match(r.note, /留下了《一条没写完的广告》/)

    const files = await readdir(join(worksDir(root), r.id))
    assert.equal(files.length, 1)
    assert.match(files[0], /^v1-/)
    const body = await readFile(join(worksDir(root), r.id, files[0]), 'utf8')
    assert.match(body, /^# 一条没写完的广告/)
    assert.match(body, /第 1 版/)
    assert.match(body, /想做成：想写得像有人在耳边说话/)
    assert.match(body, /第二段：但你会一直听见它。/)

    const db = await readWorks(root)
    assert.equal(db.items.length, 1)
    assert.equal(db.items[0].title, '一条没写完的广告')
    assert.equal(db.items[0].day, '2026-11-16')
    assert.equal(db.items[0].versions.length, 1)
    assert.equal(db.items[0].refs.length, 2)
    assert.ok(db.items[0].line.length <= 120)

    const back = await readWorkText(root, { title: '一条没写完的广告' })
    assert.equal(back.ok, true)
    assert.equal(back.version, 1)
    assert.deepEqual(back.versions, [1])
    assert.match(back.text, /第二段/)
  })
})

test('同名再给一次就是第二版，第一版不覆盖', async () => {
  await withRoot(async (root) => {
    const a = await makeWork(root, { title: '那条广告', text: '第一版：先说响。', now: NOW })
    const b = await makeWork(root, { title: '那条广告', text: '第二版：先说静。', now: NOW + 60_000 })
    assert.equal(b.ok, true)
    assert.equal(b.id, a.id)
    assert.equal(b.version, 2)
    assert.match(b.note, /改了第 2 版/)

    const files = (await readdir(join(worksDir(root), a.id))).sort()
    assert.equal(files.length, 2)
    const first = await readFile(join(worksDir(root), a.id, files.find((f) => f.startsWith('v1-'))), 'utf8')
    const second = await readFile(join(worksDir(root), a.id, files.find((f) => f.startsWith('v2-'))), 'utf8')
    assert.match(first, /第一版：先说响。/)
    assert.match(second, /第二版：先说静。/)

    const one = await readWorkText(root, { title: '那条广告', version: 1 })
    assert.match(one.text, /第一版/)
    const two = await readWorkText(root, { title: '那条广告' })
    assert.equal(two.version, 2)
    assert.deepEqual(two.versions, [1, 2])
    assert.match(two.text, /第二版/)

    const db = await readWorks(root)
    assert.equal(db.items.length, 1)
  })
})

test('改版换名字：还是同一件，只是名字变了（另一件不会凭空多出来）', async () => {
  await withRoot(async (root) => {
    const a = await makeWork(root, { title: '旧名字', text: '一稿。', now: NOW })
    const b = await makeWork(root, { title: '新名字', text: '二稿。', basedOn: a.id, newName: true, now: NOW + 1000 })
    assert.equal(b.ok, true)
    assert.equal(b.id, a.id)
    assert.equal(b.version, 2)
    const db = await readWorks(root)
    assert.equal(db.items.length, 1, '换名字不另起一件：不然「改了很多遍」会被拆成很多陌生人')
    assert.equal(db.items[0].title, '新名字')
    assert.equal(db.items[0].versions.length, 2)

    const files = (await readdir(join(worksDir(root), a.id))).sort()
    assert.equal(files.length, 2)
    assert.match(files[0], /^v1-旧名字\.md$/, '第一版文件名留着当时的名字，不跟着改')
    assert.match(files[1], /^v2-新名字\.md$/)
    const one = await readWorkText(root, { id: a.id, version: 1 })
    assert.match(one.text, /^# 旧名字/)
    const two = await readWorkText(root, { id: a.id })
    assert.match(two.text, /^# 新名字/)
  })
})

test('写入口挡：没名字、空正文、名字太长、正文太多', async () => {
  await withRoot(async (root) => {
    assert.equal((await makeWork(root, { title: '', text: '正文', now: NOW })).ok, false)
    assert.equal((await makeWork(root, { title: '   ', text: '正文', now: NOW })).ok, false)
    assert.equal((await makeWork(root, { title: '有名字', text: '   ', now: NOW })).ok, false)
    const longTitle = '名'.repeat(WORK_TITLE_MAX + 1)
    assert.equal((await makeWork(root, { title: longTitle, text: '正文', now: NOW })).ok, false)
    const longText = '字'.repeat(WORK_TEXT_MAX + 1)
    assert.equal((await makeWork(root, { title: '有名字', text: longText, now: NOW })).ok, false)
    assert.equal((await readWorks(root)).items.length, 0, '挡下来的不能留半截')
  })
})

test('手上最多两件没弄完，第三件挡回去；收一件就能再留', async () => {
  await withRoot(async (root) => {
    await makeWork(root, { title: '甲', text: '甲的正文。', now: day(0) })
    await makeWork(root, { title: '乙', text: '乙的正文。', now: day(1) })
    const third = await makeWork(root, { title: '丙', text: '丙的正文。', now: day(2) })
    assert.equal(third.ok, false)
    assert.match(third.note, /《甲》/)
    assert.match(third.note, /《乙》/)
    assert.equal(WORK_WIP_MAX, 2)

    assert.equal((await closeWork(root, { title: '甲', state: 'done', now: day(2) })).ok, true)
    const again = await makeWork(root, { title: '丙', text: '丙的正文。', now: day(2) })
    assert.equal(again.ok, true)
  })
})

test('一天两版：接着改两次就停，明天还能接着改', async () => {
  await withRoot(async (root) => {
    const a = await makeWork(root, { title: '一天里的东西', text: '一。', now: NOW })
    assert.equal((await makeWork(root, { title: '一天里的东西', text: '二。', now: NOW + 1000 })).ok, true)
    const third = await makeWork(root, { title: '一天里的东西', text: '三。', now: NOW + 2000 })
    assert.equal(third.ok, false)
    assert.match(third.note, /今天已经改过 2 版了/)
    assert.equal(WORK_VERSIONS_PER_DAY, 2)
    assert.equal((await readWorks(root)).items[0].versions.length, 2)

    const tomorrow = await makeWork(root, { title: '一天里的东西', text: '三。', now: day(1) })
    assert.equal(tomorrow.ok, true)
    assert.equal(tomorrow.version, 3)
    assert.equal(a.id, tomorrow.id)
  })
})

test('一天只起一件新的；七天三件到顶就停', async () => {
  await withRoot(async (root) => {
    await makeWork(root, { title: '甲', text: '甲的正文。', now: day(0) })
    const sameDay = await makeWork(root, { title: '乙', text: '乙的正文。', now: day(0) + 1000 })
    assert.equal(sameDay.ok, false)
    assert.match(sameDay.note, /今天已经起过一件了/)
    assert.equal(WORK_PER_DAY, 1)
    assert.equal((await makeWork(root, { title: '乙', text: '乙的正文。', now: day(1) })).ok, true)
    await closeWork(root, { title: '甲', state: 'done', now: day(1) })
    await closeWork(root, { title: '乙', state: 'done', now: day(1) })
    assert.equal((await makeWork(root, { title: '丙', text: '丙的正文。', now: day(2) })).ok, true)
    await closeWork(root, { title: '丙', state: 'done', now: day(2) })

    const fourth = await makeWork(root, { title: '丁', text: '丁的正文。', now: day(3) })
    assert.equal(fourth.ok, false)
    assert.match(fourth.note, /这七天里起的东西够多了/)
    assert.equal(WORK_NEW_PER_WEEK, 3)

    // 最早那件滑出七天之后，就能再起一件新的。
    assert.equal((await makeWork(root, { title: '丁', text: '丁的正文。', now: day(8) })).ok, true)
  })
})

test('收尾与放下：放下必须说一句为什么，放下之后不算「留着」', async () => {
  await withRoot(async (root) => {
    await makeWork(root, { title: '要收尾的', text: '写完了。', now: NOW })
    const done = await closeWork(root, { title: '要收尾的', state: 'done', now: NOW + 1000 })
    assert.equal(done.ok, true)
    assert.match(done.note, /收了尾/)

    await makeWork(root, { title: '要放下的', text: '算了。', now: day(1) })
    const noWhy = await closeWork(root, { title: '要放下的', state: 'dropped', now: day(1) + 1000 })
    assert.equal(noWhy.ok, false)
    assert.match(noWhy.note, /为什么/)
    const dropped = await closeWork(root, { title: '要放下的', state: 'dropped', reason: '越写越假，不做了', now: day(1) + 2000 })
    assert.equal(dropped.ok, true)
    const row = (await readWorks(root)).items.find((it) => it.title === '要放下的')
    assert.equal(row.state, 'dropped')
    assert.equal(row.droppedReason, '越写越假，不做了')

    const summary = await worksSummary(root)
    assert.equal(summary.count, 1, '放下的不算留着')
    assert.equal(summary.wip, 0)
    assert.equal((await closeWork(root, { title: '没这件', now: NOW })).ok, false)
  })
})

test('读回正文不留痕：账里不记，不写事件，桌上不会因此多出一行', async () => {
  await withRoot(async (root) => {
    const a = await makeWork(root, { title: '点开过的', text: '一稿。', now: NOW })
    const back = await readWorkText(root, { id: a.id })
    assert.equal(back.ok, true)
    assert.match(back.text, /一稿/)

    const db = await readWorks(root)
    assert.equal('lookedAt' in db.items[0], false, '读就是读，账里不留任何痕迹')
    const files = await readdir(root)
    assert.ok(!files.includes('events.jsonl'), '看过的记录不进事件流')
    assert.deepEqual(await worksForDesk(root, { now: NOW + DAY }), {
      wip: { id: a.id, title: '点开过的', stale: false, kind: 'text' },
    }, '桌上不会因此多摆一行「他看过了」')
  })
})

test('桌上总摆那一件：超过十四天就改说「有些天没动了」', async () => {
  await withRoot(async (root) => {
    const a = await makeWork(root, { title: '摊着的那件', text: '一稿。', now: NOW })
    const fresh = await worksForDesk(root, { now: NOW + 13 * DAY })
    assert.equal(fresh.wip.id, a.id)
    assert.equal(fresh.wip.stale, false, '十四天内还是「弄了一半」')
    // 1.0.5：过了十四天不是不摆，是改一句说法——不摆会变成看不见的堵死。
    const old = await worksForDesk(root, { now: NOW + 15 * DAY })
    assert.equal(old.wip.id, a.id, '过了十四天也还摆着')
    assert.equal(old.wip.stale, true, '只是改说「有些天没动了」')

    // 收起来了就不再摆。
    await closeWork(root, { title: '摊着的那件', state: 'done', now: NOW })
    assert.equal((await worksForDesk(root, { now: NOW })).wip, null)
  })
})

test('列表与摘要：最近的在前，摘要只给第一件和最近一件', async () => {
  await withRoot(async (root) => {
    await makeWork(root, { title: '早的', text: '先做的。', now: NOW })
    await makeWork(root, { title: '晚的', text: '后做的。', now: day(1) })
    const items = await listWorks(root, { limit: 10 })
    assert.deepEqual(items.map((it) => it.title), ['晚的', '早的'])
    assert.deepEqual(items.map((it) => it.versions), [[1], [1]])
    const summary = await worksSummary(root)
    assert.equal(summary.count, 2)
    assert.equal(summary.wip, 2)
    assert.equal(summary.latest.title, '晚的')
    assert.equal(summary.first.title, '早的')
  })
})

test('按名字找：只看名字本身，不拿「包含」去猜', async () => {
  await withRoot(async (root) => {
    const a = await makeWork(root, { title: '那条广告', text: '一稿。', now: NOW })
    const db = await readWorks(root)
    assert.equal(findWork(db.items, '《那条广告》').id, a.id, '书名号不算名字的一部分')
    assert.equal(findWork(db.items, a.id).id, a.id)
    assert.equal(findWork(db.items, '广告'), null, '只写半截名字不猜：猜错了就会把新东西写进旧账')
    assert.equal(findWork(db.items, '没写过的东西'), null)
    assert.equal(findWork(db.items, ''), null)
  })
})

test('坏账只当空：读永远不抛', async () => {
  await withRoot(async (root) => {
    await assert.rejects(readFile(worksFile(root), 'utf8'), { code: 'ENOENT' })
    assert.deepEqual((await readWorks(root)).items, [])
    const { writeFile } = await import('node:fs/promises')
    await writeFile(worksFile(root), '{坏了', 'utf8')
    assert.deepEqual((await readWorks(root)).items, [])
    assert.equal((await listWorks(root)).length, 0)
    assert.equal((await readWorkText(root, { title: '什么都没有' })).ok, false)
  })
})

// ---------------------------- 1.0.5：做出来的是一份文件 ----------------------------
// 她能画图 / 导出声音 / 剪一段影像（放行了对应工具就有），作品容器不能只收文字。

test('做出来的是一张图：文件复制进家里，账里记 kind 与那句说明', async () => {
  await withRoot(async (root) => {
    const { writeFile, mkdir } = await import('node:fs/promises')
    await mkdir(join(root, 'home'), { recursive: true })
    const src = join(root, 'home', 'lamp.png')
    await writeFile(src, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]))
    const r = await makeWork(root, {
      title: '一盏纸灯',
      text: '灯罩这里还太硬，压不下去。',
      file: src,
      now: NOW,
    })
    assert.equal(r.ok, true)
    const items = await listWorks(root, { limit: 5 })
    assert.equal(items[0].kind, 'image', '按扩展名认它是张图')
    const got = await readWorkText(root, { title: '一盏纸灯' })
    assert.equal(got.kind, 'image')
    assert.equal(got.file, `works/${r.id}/v1-一盏纸灯.png`)
    assert.equal(got.text, '灯罩这里还太硬，压不下去。', '读回来的是她写的那句说明，不是二进制')
    const bytes = await readFile(join(root, got.file))
    assert.equal(bytes.length, 8, '文件真的复制进家里了')
  })
})

test('文件产物：找不到就说找不到；相对路径从她的屋子算', async () => {
  await withRoot(async (root) => {
    const { writeFile, mkdir } = await import('node:fs/promises')
    const miss = await makeWork(root, { title: '空的', text: '想画点什么。', file: 'nope.png', now: NOW })
    assert.equal(miss.ok, false)
    assert.match(miss.note, /翻不到/)

    await mkdir(join(root, 'home'), { recursive: true })
    await writeFile(join(root, 'home', 'hum.mp3'), Buffer.from([1, 2, 3]))
    const rel = await makeWork(root, {
      title: '一段曲子',
      text: '主旋律总是往下掉。',
      file: 'hum.mp3',
      now: NOW,
    })
    assert.equal(rel.ok, true, '相对路径按 home/ 解析')
    const back = await readWorkText(root, { title: '一段曲子' })
    assert.equal(back.kind, 'audio')
    assert.match(back.file, /\.mp3$/)
  })
})

test('文件产物：工具给的是从根算的路径（home/drawings/…）也认', async () => {
  await withRoot(async (root) => {
    const { writeFile, mkdir } = await import('node:fs/promises')
    await mkdir(join(root, 'home', 'drawings'), { recursive: true })
    await writeFile(join(root, 'home', 'drawings', 'lamp.png'), Buffer.from([9, 9, 9, 9]))
    // 预演里她照着画图工具返回的路径抄过来，那串是从根算的（home/drawings/…）。
    // 只认「从自己屋子算」的话，这一版会白丢一次。
    const r = await makeWork(root, {
      title: '画下来的灯',
      text: '翘起来的那一圈照着画了，没有画平。',
      file: 'home/drawings/lamp.png',
      now: NOW,
    })
    assert.equal(r.ok, true, '从根算的相对路径也要认')
    const got = await readWorkText(root, { title: '画下来的灯' })
    assert.equal(got.kind, 'image')
    assert.equal(got.file, `works/${r.id}/v1-画下来的灯.png`)
  })
})

test('文件产物：只有文件没有说明也算留下了', async () => {
  await withRoot(async (root) => {
    const { writeFile } = await import('node:fs/promises')
    const src = join(root, 'shot.webp')
    await writeFile(src, Buffer.from([1, 2, 3, 4, 5]))
    const r = await makeWork(root, { title: '一张没说明的图', file: src, now: NOW })
    assert.equal(r.ok, true)
    const items = await listWorks(root, { limit: 5 })
    assert.equal(items[0].line, '（图）', '没写说明时，桌上/列表里只说它是图')
  })
})
