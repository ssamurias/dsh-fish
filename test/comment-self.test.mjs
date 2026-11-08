/**
 * comment-self.test.mjs —— 回评论时「她是谁」「他是谁」「回在哪一楼」（接 issue #63）
 *
 * 0.9.5 上留下的几处：
 *   1. 「登录号不知道就看楼主」的兜底在真客户端上走不到：subReplies 把回包里的
 *      data.root 丢了；readMyReplies 和 postReply 也没接这个兜底。
 *   2. 老数据（owner.mid 存的是她自己的登录号，没有 account，cookie 只有两个键）下，
 *      她自己补的话被当成「他」说的，回它不占额度，可以一直自己回自己。
 *   3. rootRpid 填错时悄悄退回她最近那条评论，不再按被回复那条找楼。
 *   4. 同一个视频每个候选楼都 view 一次；额度满、又没有可能是他的号时，探测完才拒。
 *
 * 全部用真的 createClient，fetch 换成按 B 站真接口形状回包的假站，不联网。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  scanReplies, readMyReplies, postReply, renderReplies, renderMyReplies,
  markRepliesSeen, replyCountToday, MAX_SCAN_ROOTS,
} from '../lib/comment.js'
import { createClient } from '../lib/bili.js'
import { normalizeConfig, dateKey } from '../lib/settings.js'
import { readEvents, appendEvent, paths, writeConfig, writeOwner } from '../lib/store.js'

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fish-cself-'))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

async function enableComment(root, patch = {}) {
  await mkdir(paths(root).root, { recursive: true })
  await writeConfig(normalizeConfig({
    comment: { enabled: true, perDay: 1, replyPerDay: 5, window: ['00:00', '23:59'], ...patch },
  }), root)
}

async function seedComment(root, dk, bvid, rpid) {
  await appendEvent({ type: 'meta', text: `comment:${dk} ${bvid} ${rpid}` }, { day: 1, stage: 1, source: 'system' }, root)
}

async function creplies(root) {
  const { events } = await readEvents(root)
  return events.filter((e) => e.type === 'meta').map((e) => String(e.text ?? '')).filter((t) => t.startsWith('creply:'))
}

/**
 * 假 B 站：照真接口的回包形状答（`/x/v2/reply/reply` 带 data.root、data.replies、data.page），
 * 记下 view / subReplies / replyReply 三种请求。
 *
 * threads：{ 主楼 rpid: { mid: 楼主, replies: [{ rpid, mid, message, ctime }] } }
 * selfMid：她发出去的回复挂回楼里时用哪个 mid（和真站一样，下一轮扫描能扫到）。
 */
function fakeBili({ threads = {}, selfMid = 0 } = {}) {
  const calls = []
  let next = 90001
  const json = (o) => ({ status: 200, ok: true, text: async () => JSON.stringify(o), json: async () => o })
  const reply = (root, x) => ({
    rpid: x.rpid, rpid_str: String(x.rpid), oid: 1001, type: 1, mid: x.mid,
    root, parent: x.parent ?? root, ctime: x.ctime ?? 1, like: 0, rcount: 0,
    member: { mid: String(x.mid), uname: x.uname ?? `用户${x.mid}` },
    content: { message: x.message ?? '嗯' },
  })
  async function fetchImpl(url, init = {}) {
    const u = new URL(String(url))
    const p = u.pathname
    if (p === '/x/frontend/finger/spi') return json({ code: 0, data: { b_3: 'b3', b_4: 'b4' } })
    if (p === '/x/web-interface/view') {
      calls.push(['view', u.searchParams.get('bvid')])
      return json({
        code: 0, message: '0',
        data: { bvid: u.searchParams.get('bvid'), aid: 1001, title: '某视频', owner: { mid: 1, name: 'UP' }, stat: { view: 1, reply: 3 }, pages: [{ cid: 5 }] },
      })
    }
    if (p === '/x/v2/reply/reply') {
      const root = Number(u.searchParams.get('root'))
      calls.push(['subReplies', root])
      const t = threads[root]
      if (!t) return json({ code: 12022, message: '已经被删除了', data: null })
      return json({
        code: 0, message: '0',
        data: {
          page: { num: 1, size: 20, count: t.replies.length },
          root: { ...reply(0, { rpid: root, mid: t.mid, message: '她那条评论' }), parent: 0 },
          replies: t.replies.map((x) => reply(root, x)),
          upper: { mid: 1 },
        },
      })
    }
    if (p === '/x/v2/reply/add') {
      const f = new URLSearchParams(String(init.body ?? ''))
      const root = Number(f.get('root'))
      const parent = Number(f.get('parent'))
      calls.push(['replyReply', root, parent])
      const rpid = next++
      if (selfMid && threads[root]) threads[root].replies.push({ rpid, mid: selfMid, parent, message: f.get('message'), ctime: rpid })
      return json({ code: 0, message: '0', data: { rpid, rpid_str: String(rpid) } })
    }
    calls.push(['other', p])
    return json({ code: -404, message: '啥都木有' })
  }
  const count = (name) => calls.filter((c) => c[0] === name).length
  const posts = () => calls.filter((c) => c[0] === 'replyReply').map((c) => c.slice(1))
  return { calls, fetchImpl, count, posts }
}

const realClient = (fake, cookie = 'SESSDATA=x; bili_jct=y') =>
  createClient({ cookie, fetchImpl: fake.fetchImpl, minIntervalMs: 1, jitterMs: 0, random: () => 0 })

// ---------------------------------------------------------------- 1. 楼主兜底在真客户端上要走得到

test('subReplies：把回包里的楼主（data.root）带出来，回包不对时是 null', async () => {
  const fake = fakeBili({ threads: { 111: { mid: 9, replies: [{ rpid: 222, mid: 777 }] } } })
  const client = realClient(fake)
  const r = await client.subReplies(1001, 111)
  assert.equal(r.ok, true)
  assert.deepEqual(r.data.map((x) => x.rpid), [222], '回复数组照旧在 data 里')
  assert.deepEqual(r.root, { rpid: 111, mid: 9 }, '楼主不能丢——认她自己全靠它')

  const gone = await client.subReplies(1001, 555)
  assert.equal(gone.ok, false)
  assert.equal(gone.root, null)
})

test('真客户端：登录号不知道时看楼主认她自己——扫回复、她自己翻、回复三处都认', async () => {
  await withRoot(async (root) => {
    const dk = dateKey()
    await enableComment(root, { replyPerDay: 0 })
    await seedComment(root, dk, 'BV1', 111)
    // 领养人 555 是另一个号；没有 account，cookie 里也没有 DedeUserID —— loginMid 是 0
    await writeOwner({ mid: 555, nickname: '他' }, root)
    const fake = fakeBili({
      threads: {
        111: {
          mid: 9, // 楼主是她发评论用的号
          replies: [
            { rpid: 222, mid: 9, message: '我再补一句', ctime: 1 },
            { rpid: 333, mid: 555, message: '我在呢', ctime: 2 },
            { rpid: 444, mid: 777, message: '路过', ctime: 3 },
          ],
        },
      },
    })
    const client = realClient(fake, 'SESSDATA=x; bili_jct=y; buvid3=z')

    const scanned = await scanReplies({ root, client, dateKey: dk })
    assert.deepEqual(scanned.map((x) => x.rpid), [333, 444], '她自己补的那句不算别人回她')
    assert.equal(scanned.find((x) => x.rpid === 333).fromOwner, true)
    assert.equal(scanned.find((x) => x.rpid === 444).fromOwner, false)

    const mine = await readMyReplies({ root, client })
    assert.deepEqual(mine.map((x) => x.rpid), [333, 444], 'bili_look 看到的也不能有她自己那句')

    const self = await postReply({ root, client, bvid: 'BV1', parentRpid: 222, text: '嗯', dateKey: dk })
    assert.equal(self.ok, false)
    assert.match(self.why, /你自己的评论/)
    assert.equal(fake.count('replyReply'), 0, '回自己那句一条都不该发出去')

    // 他的回复照样能回，额度为 0 也拦不住，记成 owner
    const his = await postReply({ root, client, bvid: 'BV1', parentRpid: 333, text: '我在。', dateKey: dk })
    assert.equal(his.ok, true)
    assert.deepEqual(fake.posts(), [[111, 333]])
    assert.match((await creplies(root)).pop(), / owner$/)
  })
})

// ---------------------------------------------------------------- 2. 老数据：owner.mid 就是她

test('老数据（owner.mid 是她、没有 account、cookie 两个键）：她补的话不当成他说的', async () => {
  await withRoot(async (root) => {
    const dk = dateKey()
    await enableComment(root, { replyPerDay: 0 })
    await seedComment(root, dk, 'BV1', 111)
    await writeOwner({ mid: '9', nickname: 'x', cookie: 'SESSDATA=x; bili_jct=y' }, root)
    const fake = fakeBili({
      threads: {
        111: {
          mid: 9,
          replies: [
            { rpid: 222, mid: 9, message: '我再补一句', ctime: 1 },
            { rpid: 444, mid: 777, message: '路人', ctime: 2 },
          ],
        },
      },
    })
    const client = realClient(fake)

    const scanned = await scanReplies({ root, client, dateKey: dk })
    assert.deepEqual(scanned.map((x) => x.rpid), [444])
    assert.equal(scanned[0].fromOwner, false)
    const txt = renderReplies(scanned)
    assert.doesNotMatch(txt, /他在你下面说话了/, '没有他的话，就不该有这一段')
    assert.doesNotMatch(txt, /我再补一句/)

    const mine = await readMyReplies({ root, client })
    assert.deepEqual(mine.map((x) => x.rpid), [444])
    assert.doesNotMatch(renderMyReplies(mine, { bvid: 'BV1' }), /他在你那条评论下面回了一句/)

    const r = await postReply({ root, client, bvid: 'BV1', parentRpid: 222, text: '嗯', dateKey: dk })
    assert.equal(r.ok, false, '那条是她自己补的')
    assert.match(r.why, /你自己的评论/)
    assert.equal(fake.count('replyReply'), 0)
    assert.deepEqual(await creplies(root), [])
  })
})

test('老数据：额度为 0 时连跑三轮「扫回复、回扫到的」，一条都发不出去', async () => {
  await withRoot(async (root) => {
    const dk = dateKey()
    await enableComment(root, { replyPerDay: 0 })
    await seedComment(root, dk, 'BV1', 111)
    await writeOwner({ mid: '9', nickname: 'x', cookie: 'SESSDATA=x; bili_jct=y' }, root)
    const fake = fakeBili({
      selfMid: 9, // 她发出去的回复会挂回楼里，下一轮能扫到
      threads: {
        111: {
          mid: 9,
          replies: [
            { rpid: 222, mid: 9, message: '我再补一句', ctime: 1 },
            { rpid: 444, mid: 777, message: '路人', ctime: 2 },
          ],
        },
      },
    })
    const client = realClient(fake)

    const fromOwner = []
    for (let round = 0; round < 3; round++) {
      const list = await scanReplies({ root, client, dateKey: dk })
      fromOwner.push(...list.filter((x) => x.fromOwner).map((x) => x.rpid))
      await markRepliesSeen(root, list, { dateKey: dk })
      for (const x of list) await postReply({ root, client, bvid: 'BV1', parentRpid: x.rpid, text: '嗯', dateKey: dk })
    }
    assert.deepEqual(fake.posts(), [], '额度是 0，又没有他的话，不能自己回自己')
    assert.deepEqual(fromOwner, [], '没有一条是他说的')
    const { events } = await readEvents(root)
    assert.equal(replyCountToday(events, dk), 0)
    assert.deepEqual(await creplies(root), [])
  })
})

// ---------------------------------------------------------------- 3. rootRpid 对不上就照不填那样找楼

test('postReply：rootRpid 对不上她的评论时，照不填那样按被回复那条找楼', async () => {
  await withRoot(async (root) => {
    const dk = dateKey()
    const yk = dateKey(new Date(Date.now() - 86_400_000))
    await enableComment(root)
    await seedComment(root, yk, 'BV1', 111)
    await seedComment(root, dk, 'BV1', 222)
    await writeOwner({ mid: 555, account: { mid: 999 } }, root)

    for (const rootRpid of [undefined, '111', '444', '888']) {
      const fake = fakeBili({
        threads: {
          111: { mid: 999, replies: [{ rpid: 444, mid: 777, message: '路人' }] },
          222: { mid: 999, replies: [] },
        },
      })
      const r = await postReply({ root, client: realClient(fake), bvid: 'BV1', rootRpid, parentRpid: 444, text: '嗯', dateKey: dk })
      assert.equal(r.ok, true, `rootRpid=${rootRpid}`)
      assert.deepEqual(fake.posts(), [[111, 444]], `rootRpid=${rootRpid}：444 在 111 那楼，不能挂到最近那条 222 下面`)
    }
  })
})

test('postReply：rootRpid 填错也拦得住回自己补的那句，不记成回他', async () => {
  await withRoot(async (root) => {
    const dk = dateKey()
    await enableComment(root, { replyPerDay: 1 })
    await seedComment(root, dk, 'BV1', 111)
    await writeOwner({ mid: 555, account: { mid: 999 } }, root)
    const fake = fakeBili({
      threads: { 111: { mid: 999, replies: [{ rpid: 666, mid: 999, message: '我再补一句' }] } },
    })
    const client = realClient(fake)

    for (const rootRpid of [undefined, '888']) {
      const r = await postReply({ root, client, bvid: 'BV1', rootRpid, parentRpid: 666, text: '嗯', dateKey: dk })
      assert.equal(r.ok, false, `rootRpid=${rootRpid}`)
      assert.match(r.why, /你自己的评论/)
    }
    assert.deepEqual(fake.posts(), [])
    assert.deepEqual(await creplies(root), [])
  })
})

// ---------------------------------------------------------------- 4. 发之前的读请求

test('postReply：同一个视频只 view 一次，找不到被回复那条也不多查', async () => {
  await withRoot(async (root) => {
    const dk = dateKey()
    await enableComment(root)
    const threads = {}
    for (let i = 1; i <= MAX_SCAN_ROOTS; i++) {
      await seedComment(root, dk, 'BV1', 100 + i)
      threads[100 + i] = { mid: 999, replies: [{ rpid: 1000 + i, mid: 777 }] }
    }
    await writeOwner({ mid: 555, account: { mid: 999 } }, root)
    const fake = fakeBili({ threads })

    const r = await postReply({ root, client: realClient(fake), bvid: 'BV1', parentRpid: 7777, text: '嗯', dateKey: dk })
    assert.equal(r.ok, true, '哪楼都找不到时退回最近那条，照发')
    assert.deepEqual(fake.posts(), [[100 + MAX_SCAN_ROOTS, 7777]])
    assert.equal(fake.count('view'), 1, '候选都是同一个 bvid，aid 问一次就够')
    assert.equal(fake.count('subReplies'), MAX_SCAN_ROOTS, '每楼查一次；发完不再把刚查过的那楼重查一遍')
  })
})

test('postReply：额度满了、又没有可能是他的号时，探测之前就拒', async () => {
  for (const owner of [
    { cookie: 'SESSDATA=x; bili_jct=y' },                       // 只有 cookie
    { account: { mid: 999 }, cookie: 'SESSDATA=x; bili_jct=y' }, // 只有她自己的登录号
    { cookie: 'SESSDATA=x; DedeUserID=999; bili_jct=y' },       // 登录号在 cookie 里
  ]) {
    await withRoot(async (root) => {
      const dk = dateKey()
      await enableComment(root, { replyPerDay: 0 })
      const threads = {}
      for (let i = 1; i <= MAX_SCAN_ROOTS; i++) {
        await seedComment(root, dk, 'BV1', 100 + i)
        threads[100 + i] = { mid: 999, replies: [{ rpid: 1000 + i, mid: 777 }] }
      }
      await writeOwner(owner, root)
      const fake = fakeBili({ threads })
      const r = await postReply({ root, client: realClient(fake), bvid: 'BV1', parentRpid: 1001, text: '嗯', dateKey: dk })
      assert.equal(r.ok, false)
      assert.match(r.why, /今天回够了/)
      assert.deepEqual(fake.calls, [], `${JSON.stringify(owner)}：探测完也不可能放行，一个请求都不该打`)
    })
  }

  // 有他的号时照旧要探测，是他就放行
  await withRoot(async (root) => {
    const dk = dateKey()
    await enableComment(root, { replyPerDay: 0 })
    await seedComment(root, dk, 'BV1', 111)
    await writeOwner({ mid: 555, account: { mid: 999 } }, root)
    const fake = fakeBili({ threads: { 111: { mid: 999, replies: [{ rpid: 333, mid: 555, message: '我在呢' }] } } })
    const r = await postReply({ root, client: realClient(fake), bvid: 'BV1', parentRpid: 333, text: '我在。', dateKey: dk })
    assert.equal(r.ok, true)
    assert.deepEqual(fake.posts(), [[111, 333]])
    assert.match((await creplies(root)).pop(), / owner$/)
  })
})
