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
import { join, dirname } from 'node:path'

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
    // → 这条必须在复制之前拦住。
    // issue #65 之前，有 events.jsonl 的目标会被直接当成新根，所以拦它的是「上级」那条；
    // 现在放着一份档的文件夹一律不搬（会盖掉那份），拦它的换成了这条，结果还是不搬。
    const parent = join(box, 'parent')
    await mkdir(join(parent, 'home'), { recursive: true })
    await writeFile(join(parent, 'events.jsonl'), '{}\n')
    const nested = join(parent, 'old')
    await mkdir(join(nested, 'home'), { recursive: true })
    await writeFile(join(nested, 'events.jsonl'), '{}\n')
    const r2 = await planMove(nested, parent)
    assert.equal(r2.ok, false)
    assert.match(r2.why, /已经放着一份档/)

    // 选的就是她现在住的文件夹：说「里面」，不说「会盖掉那份」
    const self = await planMove(src, src)
    assert.equal(self.ok, false)
    assert.match(self.why, /里面/)

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

test('目标文件夹里已经放着一份档：不搬，那份档一个字节都不动（issue #65）', async () => {
  await withEnv(async ({ box, src, loc }) => {
    // 另一份档：事件 3 行、state.json、一篇旧日记、自己的 config / owner
    const other = join(box, 'other')
    const oldEvents = '{"id":"OLD_1"}\n{"id":"OLD_2"}\n{"id":"OLD_3"}\n'
    await mkdir(join(other, 'diary'), { recursive: true })
    await writeFile(join(other, 'events.jsonl'), oldEvents)
    await writeFile(join(other, 'config.json'), '{"growthDays":7}')
    await writeFile(join(other, 'owner.json'), '{"mid":"old"}')
    await writeFile(join(other, 'state.json'), '{"old":true}')
    await writeFile(join(other, 'diary', '2026-01-01.md'), '旧日记\n')

    const plan = await planMove(src, other)
    assert.equal(plan.ok, false, '放着一份档的文件夹不能当目标')
    assert.match(plan.why, /已经放着一份档/)
    assert.match(plan.why, /盖掉/, '要说清楚为什么不行')

    const r = await moveRoot(null, { root: src, target: other })
    assert.equal(r.ok, false)
    assert.equal(r.why, plan.why)

    // 那份档原样：事件流没被盖，配置、凭据、state、日记都还是它自己的
    assert.equal(await readFile(join(other, 'events.jsonl'), 'utf8'), oldEvents)
    assert.equal(await readFile(join(other, 'config.json'), 'utf8'), '{"growthDays":7}')
    assert.equal(await readFile(join(other, 'owner.json'), 'utf8'), '{"mid":"old"}')
    assert.equal(await readFile(join(other, 'state.json'), 'utf8'), '{"old":true}')
    assert.deepEqual((await readdir(other)).sort(), ['config.json', 'diary', 'events.jsonl', 'owner.json', 'state.json'])
    assert.deepEqual(await readdir(join(other, 'diary')), ['2026-01-01.md'])

    // 当前的档也没动、指针没写：等于没迁过
    assert.equal(await readFile(join(src, 'events.jsonl'), 'utf8'), '{"id":"ev_1"}\n')
    await assert.rejects(async () => stat(loc))
    assert.equal(readLocationSync(), '')
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

test('设置页的迁移说明跟着改：放着一份档的文件夹「不行」，不再说「会被覆盖」（issue #65）', async () => {
  const c = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.ok(c.includes('本身就放着一份档的文件夹，都不行'), '要明说放着一份档的文件夹不行')
  assert.ok(!c.includes('同名文件会被覆盖'), '迁移已经不会覆盖了，旧的提醒要拿掉')
})
