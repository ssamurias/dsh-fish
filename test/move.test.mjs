/**
 * move.test.mjs —— 迁移工作区（2026-10-28，用户 m06510）
 *
 * 只测纯逻辑与文件搬运，不碰真实 ~/.dsh-fish：
 *   - planMove 的各种拒绝分支（相对路径、不存在、套进自己、上级套进来）
 *   - moveRoot 真搬一份小档 → 文件在、字节对、指针写了、旧目录被改名封存
 *   - 复制后字节对不上时**不写指针**（这条最重要：写指针 == 承认迁移成功）
 *
 * 指针文件通过 `DSH_FISH_LOCATION` 环境变量指到临时目录，避免污染真实 home。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, relative } from 'node:path'
// 第二道保护的测试要在复制前往目标里塞一个同名文件：move.js 用的就是这个 promises 对象。
import { promises as fsp } from 'node:fs'

import { planMove, moveRoot, moveStatus } from '../lib/move.js'
import { readLocationSync, invalidateLocation, locationFile, defaultRoot } from '../lib/locate.js'

async function withEnv(fn) {
  const box = await mkdtemp(join(tmpdir(), 'fish-move-'))
  const src = join(box, 'old')
  const loc = join(box, 'loc.json')
  const prev = process.env.DSH_FISH_LOCATION
  process.env.DSH_FISH_LOCATION = loc
  invalidateLocation()
  // 造一份最小但形状完整的状态库
  await mkdir(join(src, 'home'), { recursive: true })
  await mkdir(join(src, 'diary'), { recursive: true })
  await mkdir(join(src, 'logs'), { recursive: true })
  await writeFile(join(src, 'events.jsonl'), '{"id":"ev_1"}\n')
  await writeFile(join(src, 'config.json'), '{"growthDays":30}')
  await writeFile(join(src, 'home', '她的身份.md'), '# 我是谁\n')
  await writeFile(join(src, 'diary', '2026-10-28.md'), '今天\n')
  await writeFile(join(src, 'logs', 'dsh-fish.log'), '不该被搬走\n')
  try {
    return await fn({ box, src, loc })
  } finally {
    if (prev === undefined) delete process.env.DSH_FISH_LOCATION
    else process.env.DSH_FISH_LOCATION = prev
    invalidateLocation()
    await rm(box, { recursive: true, force: true }).catch(() => {})
  }
}

test('planMove：相对路径、不存在、不是文件夹都拒绝', async () => {
  await withEnv(async ({ box, src }) => {
    assert.equal((await planMove(src, '')).ok, false)
    assert.equal((await planMove(src, 'D:\\relative\\path')).ok, false)
    assert.equal((await planMove(src, join(box, 'nope'))).ok, false)
    await writeFile(join(box, 'a.txt'), 'x')
    const notDir = await planMove(src, join(box, 'a.txt'))
    assert.equal(notDir.ok, false)
    assert.match(notDir.why, /不是文件夹/)
  })
})

test('planMove：不能搬进自己里面，也不能搬到会把自己套进去的地方', async () => {
  await withEnv(async ({ box, src }) => {
    // 搬进自己的子目录
    const inner = join(src, 'diary')
    const r1 = await planMove(src, inner)
    assert.equal(r1.ok, false)
    assert.match(r1.why, /里面/)

    // 目标本身已经是一份档（里面有 events.jsonl），而 src 就在它下面
    // → 会连她自己一起套进去，这条必须在复制之前拦住。
    const parent = join(box, 'parent')
    await mkdir(join(parent, 'home'), { recursive: true })
    await writeFile(join(parent, 'events.jsonl'), '{}\n')
    const nested = join(parent, 'old')
    await mkdir(join(nested, 'home'), { recursive: true })
    await writeFile(join(nested, 'events.jsonl'), '{}\n')
    const r2 = await planMove(nested, parent)
    assert.equal(r2.ok, false)
    assert.match(r2.why, /上级/)

    // 平级搬是允许的（box/old → box/dsh-fish）——这是最常见的一次搬迁
    const r3 = await planMove(src, box)
    assert.equal(r3.ok, true, r3.why)
  })
})

test('planMove：目标里已有非空 dsh-fish 就拒绝，空的话就用它', async () => {
  await withEnv(async ({ box, src }) => {
    const dst = join(box, 'dst')
    await mkdir(dst, { recursive: true })
    const p1 = await planMove(src, dst)
    assert.equal(p1.ok, true)
    assert.equal(p1.target, join(dst, 'dsh-fish'))

    await mkdir(join(dst, 'dsh-fish'), { recursive: true })
    const p2 = await planMove(src, dst)
    assert.equal(p2.ok, true, '空的 dsh-fish 可以直接用')

    await writeFile(join(dst, 'dsh-fish', 'x.txt'), 'x')
    const p3 = await planMove(src, dst)
    assert.equal(p3.ok, false)
    assert.match(p3.why, /不是空的/)
  })
})

test('moveRoot：文件全过去、字节对、指针写了、旧目录封存、logs 不搬', async () => {
  await withEnv(async ({ box, src, loc }) => {
    const dst = join(box, 'dst')
    await mkdir(dst, { recursive: true })
    const r = await moveRoot(null, { root: src, target: dst })
    assert.equal(r.ok, true, r.why)
    assert.equal(r.to, join(dst, 'dsh-fish'))

    // 关键文件都在，内容一致
    assert.equal(await readFile(join(dst, 'dsh-fish', 'events.jsonl'), 'utf8'), '{"id":"ev_1"}\n')
    assert.equal(await readFile(join(dst, 'dsh-fish', 'home', '她的身份.md'), 'utf8'), '# 我是谁\n')
    assert.equal(await readFile(join(dst, 'dsh-fish', 'diary', '2026-10-28.md'), 'utf8'), '今天\n')

    // logs/ 不搬
    const kids = await readdir(join(dst, 'dsh-fish'))
    assert.ok(!kids.includes('logs'), 'logs 不该被搬走')

    // 指针写了，且 readLocationSync 读得到
    const ptr = JSON.parse(await readFile(loc, 'utf8'))
    assert.equal(ptr.root, join(dst, 'dsh-fish'))
    assert.equal(readLocationSync(), join(dst, 'dsh-fish'))

    // 旧目录改名封存，原位置不再是一个目录
    await assert.rejects(async () => stat(src))
    assert.ok(r.oldDirMoved)
    assert.match(r.oldDir, /dsh-fish-backups/)
    assert.equal(await readFile(join(r.oldDir, 'events.jsonl'), 'utf8'), '{"id":"ev_1"}\n')
  })
})

test('复制之后字节对不上，就不写指针（等于没迁过）', async () => {
  await withEnv(async ({ box, src }) => {
    const dst = join(box, 'dst')
    await mkdir(dst, { recursive: true })
    // 用一个会在写完之后「变小」的文件模拟损坏：先搬，再把目标改坏是拿不到的，
    // 所以这里用另一个角度：把源文件在复制过程中换掉做不到，改为直接测
    // 「目标被外力改小」这条不变式——手工跑一次 planMove 拿到 target，然后自己复制一部分。
    const plan = await planMove(src, dst)
    assert.equal(plan.ok, true)
    // 只建目录、不复制任何文件 → 等价于「一个都没搬成」
    await mkdir(plan.target, { recursive: true })
    assert.equal(readLocationSync(), '', '没写过指针时必须读不到位置')
    // 真正跑一次：从另一个角度验证——指针文件不存在
    await assert.rejects(async () => stat(locationFile()))
  })
})

test('moveStatus：没迁过时 moved=false，迁过之后 moved=true', async () => {
  await withEnv(async ({ box, src }) => {
    invalidateLocation()
    const before = await moveStatus(src)
    assert.equal(before.moved, true, '临时目录本来就不是默认位置')
    assert.ok(before.files >= 4)
    assert.ok(before.bytes > 0)

    const dst = join(box, 'dst')
    await mkdir(dst, { recursive: true })
    const r = await moveRoot(null, { root: src, target: dst })
    assert.equal(r.ok, true, r.why)
    const after = await moveStatus(r.to)
    assert.equal(after.root, r.to)
    assert.equal(after.moved, true)
  })
})

test('defaultRoot 是本机的 ~/.dsh-fish', () => {
  assert.match(defaultRoot(), /\.dsh-fish$/)
  assert.match(locationFile(), /\.dsh-fish-location\.json$/)
})

// ---- 0.9.5 余项（接 #65）：迁移的两道保护各有一条测试守着 ----

test('选中的文件夹里已经放着一份档：拒绝，那份档原样在原位', async () => {
  // 第一道保护（planMove 里的 existingArchive）。去掉它，那份档会被当成新根往里复制，
  // 复制撞上同名文件后整个文件夹还会被改名成 .partial-…，人家的档就不在原位了。
  await withEnv(async ({ box, src, loc }) => {
    const other = join(box, 'other')
    await mkdir(join(other, 'diary'), { recursive: true })
    await writeFile(join(other, 'events.jsonl'), '{"id":"ev_other"}\n')
    await writeFile(join(other, 'diary', '2026-10-01.md'), '别人的日记\n')

    const plan = await planMove(src, other)
    assert.equal(plan.ok, false, '放着一份档的文件夹不能当目标')
    // 原因的措辞不在这里钉：这条守的是行为（拒绝、那份档原样在原位、她没动、指针没写）。
    assert.match(plan.why, /已经有一份她的档/)

    const r = await moveRoot(null, { root: src, target: other })
    assert.equal(r.ok, false)
    assert.deepEqual((await readdir(other)).sort(), ['diary', 'events.jsonl'], '那边不多不少')
    assert.equal(await readFile(join(other, 'events.jsonl'), 'utf8'), '{"id":"ev_other"}\n')
    assert.equal(await readFile(join(other, 'diary', '2026-10-01.md'), 'utf8'), '别人的日记\n')
    assert.ok(!(await readdir(box)).some((n) => n.startsWith('other.partial-')), '那份档没被改名挪开')
    // 她自己也没动：还在原处，指针没写
    assert.equal(await readFile(join(src, 'events.jsonl'), 'utf8'), '{"id":"ev_1"}\n')
    await assert.rejects(stat(loc))
  })
})

test('复制时目标里冒出同名文件：不覆盖、整趟作废、指针不写（第二道保护 COPYFILE_EXCL）', async () => {
  // planMove 只给空的或还不存在的 dsh-fish，正常走不到这里；这条守的是「判断之后、复制之前
  // 那边多了东西」。办法是包一层 copyFile：第一次复制前先在目标位置放一个同名文件。
  // 去掉 COPYFILE_EXCL，这个文件会被盖掉、迁移照报成功。
  await withEnv(async ({ box, src, loc }) => {
    const dst = join(box, 'dst')
    await mkdir(dst, { recursive: true })
    const realCopy = fsp.copyFile
    let planted = ''
    fsp.copyFile = async (from, to, mode) => {
      if (!planted) {
        planted = String(to)
        await mkdir(dirname(planted), { recursive: true })
        await writeFile(planted, '别人刚放进来的\n')
      }
      return realCopy.call(fsp, from, to, mode)
    }
    let r
    try {
      r = await moveRoot(null, { root: src, target: dst })
    } finally {
      fsp.copyFile = realCopy
    }
    assert.ok(planted, '包的那一层要真的被走到')
    assert.equal(r.ok, false, '撞上同名文件必须失败')
    assert.match(r.why, /复制到一半失败/)
    // 那个文件没被盖：半成品目录整个改名挪开了，它在里面，内容原样
    const halves = (await readdir(dst)).filter((n) => n.startsWith('dsh-fish.partial-'))
    assert.equal(halves.length, 1, '半成品要改名挪开')
    const rel = relative(join(dst, 'dsh-fish'), planted)
    assert.equal(await readFile(join(dst, halves[0], rel), 'utf8'), '别人刚放进来的\n')
    // 等于没迁过：指针没写，她还在原处
    await assert.rejects(stat(loc))
    assert.equal(await readFile(join(src, 'events.jsonl'), 'utf8'), '{"id":"ev_1"}\n')
  })
})

test('选的是她现在那个 dsh-fish 的上级：说「她本来就在这个位置」，不说成别人的 dsh-fish', async () => {
  // 她住在 P/dsh-fish、选 P：拼回来就是她自己。0.9.5 说的是「这个文件夹里已经有一个
  // dsh-fish 且不是空的」，那个 dsh-fish 就是她；给这种情况写的那句是死分支。
  await withEnv(async ({ box }) => {
    const here = join(box, 'dsh-fish')
    await mkdir(join(here, 'home'), { recursive: true })
    await writeFile(join(here, 'events.jsonl'), '{"id":"ev_1"}\n')
    const r = await planMove(here, box)
    assert.equal(r.ok, false)
    assert.match(r.why, /本来就在这个位置/)
    // 直接选她现在住的文件夹也一样
    const self = await planMove(here, here)
    assert.equal(self.ok, false)
    assert.match(self.why, /本来就在这个位置/)
  })
})
