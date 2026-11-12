/**
 * sub.test.mjs —— 工具 bili_sub：这条视频里到底说了哪几句（1.0，用户 m04014）
 *
 * 守四件事：
 *   1. 按句给，不按篇给：一次最多三句，带时间点；
 *   2. 没有字幕就说没有，不猜内容；
 *   3. 只落一行 `subs:` 索引，正文不进口忆；
 *   4. 说明里要让她知道"怎么用、什么时候想起它"，也要允许"拼不出来"。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  stamp, mergeLines, pickSnippets, renderSnippets, subOnce, registerSub,
  parseFrom, pickPage, renderPage, SUB_MAX, SUB_PAGE,
} from '../lib/sub.js'
import { readEvents } from '../lib/store.js'

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fish-sub-'))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

const BVID = 'BV1xx411c7mD'

function fakeClient(over = {}) {
  const calls = []
  const base = {
    view: async (bvid) => ({
      ok: true,
      data: { cid: 555, title: `标题 ${bvid}`, up: '某UP' },
    }),
    subtitle: async () => ({
      ok: true,
      data: [
        { t: 3, text: '我们先说说' },
        { t: 5, text: '这件事为什么重要。' },
        { t: 61, text: '第二点' },
        { t: 63, text: '是成本太高。' },
        { t: 125, text: '所以我最后没有做。' },
      ],
    }),
  }
  const c = { calls }
  for (const [k, fn] of Object.entries({ ...base, ...over })) {
    c[k] = async (...a) => { calls.push([k, ...a]); return fn(...a) }
  }
  return c
}

test('时间点：分秒补零，超过一小时才带小时', () => {
  assert.equal(stamp(5), '[00:05]')
  assert.equal(stamp(65), '[01:05]')
  assert.equal(stamp(3725), '[1:02:05]')
  assert.equal(stamp(-1), '[00:00]')
})

test('字幕碎句按标点拼成整句，没有标点的按上限切', () => {
  const lines = mergeLines([
    { t: 3, text: '我们先说说' },
    { t: 5, text: '这件事为什么重要。' },
    { t: 9, text: '第二句' },
  ])
  assert.equal(lines[0].text, '我们先说说这件事为什么重要。')
  assert.equal(lines[0].t, 3)
  assert.equal(lines[1].text, '第二句')

  const long = mergeLines([{ t: 1, text: '一'.repeat(200) }], { max: 40 })
  assert.equal(long[0].text.length, 40)
})

test('挑句：不带词就从头、中、尾各挑一处，最多三句', () => {
  const sentences = Array.from({ length: 9 }, (_, i) => ({ t: i * 10, text: `第${i}句。` }))
  const picked = pickSnippets(sentences, '')
  assert.equal(picked.length, SUB_MAX)
  assert.deepEqual(picked.map((p) => p.t), [0, 40, 80])

  assert.deepEqual(pickSnippets([], '随便'), [])
})

test('挑句：带词就挑对得上的，一句都对不上就退回开头中段', () => {
  const sentences = [
    { t: 0, text: '我们先说定价。' },
    { t: 30, text: '再说渠道。' },
    { t: 60, text: '最后是售后。' },
  ]
  const hit = pickSnippets(sentences, '定价')
  assert.equal(hit.length, 1)
  assert.equal(hit[0].t, 0)

  const miss = pickSnippets(sentences, '天气')
  assert.ok(miss.length > 0, '一句都对不上也不该空手回去')
})

test('渲染：有标题、有时间点，不出现等级/可信度这类字眼', () => {
  const text = renderSnippets([{ t: 65, text: '这是第二句。' }], { title: '一条视频' })
  assert.match(text, /《一条视频》/)
  assert.match(text, /\[01:05\]/)
  assert.match(text, /不是整篇/)
  assert.doesNotMatch(text, /等级|可信度|分数|1 级|2 级/)
})

test('查字幕：给三句、带时间点，并只落一行 subs: 索引', async () => {
  await withRoot(async (root) => {
    const client = fakeClient()
    const r = await subOnce({ bvid: BVID, client, root, cfg: { bili: { enabled: true } } })
    assert.equal(r.ok, true)
    assert.equal(r.snippets.length, 3)
    assert.match(r.text, /《标题 BV1xx411c7mD》/)

    const seen = await readEvents(root)
    const subs = seen.events.filter((e) => String(e.text ?? '').startsWith('subs:'))
    assert.equal(subs.length, 1)
    assert.match(subs[0].text, new RegExp(`^subs:${BVID}`))
  })
})

test('没有字幕就说没有，不猜内容，也不记索引', async () => {
  await withRoot(async (root) => {
    const client = fakeClient({
      subtitle: async () => ({ ok: false, code: 'NO_SUB', data: [] }),
    })
    const r = await subOnce({ bvid: BVID, client, root, cfg: {} })
    assert.equal(r.ok, false)
    assert.match(r.note, /没有字幕/)
    const seen = await readEvents(root)
    assert.equal(seen.events.filter((e) => String(e.text ?? '').startsWith('subs:')).length, 0)
  })
})

test('B 站关着 / 视频号不合法：直说打不开、说不是视频号', async () => {
  await withRoot(async (root) => {
    const off = await subOnce({ bvid: BVID, client: fakeClient(), root, cfg: { bili: { enabled: false } } })
    assert.equal(off.ok, false)
    assert.match(off.note, /现在打不开/)

    const bad = await subOnce({ bvid: 'not-a-bvid', client: fakeClient(), root, cfg: {} })
    assert.equal(bad.ok, false)
    assert.match(bad.note, /不是一个视频号/)
  })
})

test('工具说明：说清怎么用、一次最多三句、也允许拼不出来', () => {
  const seen = []
  registerSub({ tools: { register: (d) => { seen.push(d); return () => {} } } }, { root: '.', tenant: { ok: true } })
  const d = seen[0]
  assert.equal(d.name, 'bili_sub')
  assert.match(d.description, /最多三句/)
  assert.match(d.description, /片段，不是整篇/)
  assert.match(d.description, /没有字幕/)
  assert.match(d.description, /别硬凑一个总结/)
  assert.match(d.description, /一页页读/, '要让她知道可以接着读，不是只能看三句')
  assert.ok(d.parameters?.properties?.bvid, 'bvid 要在 schema 里')
  assert.ok(d.parameters?.properties?.from, 'from 要在 schema 里，她才知道怎么接着读')
})

test('接着读：from 认 "mm:ss" / "h:mm:ss" / 秒数，认不出来当没填', () => {
  assert.equal(parseFrom('01:30'), 90)
  assert.equal(parseFrom('1:02:03'), 3723)
  assert.equal(parseFrom(125), 125)
  assert.equal(parseFrom('[02:00]'), 120)
  assert.equal(parseFrom(''), null)
  assert.equal(parseFrom('abc'), null)
  assert.equal(parseFrom(undefined), null)
})

test('接着读：一页十来句，页尾给下一页的起点，读到头说读完了', () => {
  const sentences = Array.from({ length: 20 }, (_, i) => ({ t: i * 10, text: `第${i}句。` }))
  const first = pickPage(sentences, 0)
  assert.equal(first.page.length, SUB_PAGE)
  assert.equal(first.page[0].t, 0)
  assert.equal(first.done, false)
  assert.equal(first.next, 120)

  const second = pickPage(sentences, first.next)
  assert.equal(second.page.length, 20 - SUB_PAGE)
  assert.equal(second.done, true)
  assert.equal(second.next, null)

  const over = pickPage(sentences, 9999)
  assert.equal(over.page.length, 0)
  assert.equal(over.done, true)
})

test('接着读：页尾告诉她怎么接下一次，最后一句时说读完了', () => {
  const more = renderPage({ page: [{ t: 65, text: '这是第二句。' }], next: 120, done: false }, { title: '一条视频' })
  assert.match(more, /《一条视频》/)
  assert.match(more, /\[01:05\]/)
  assert.match(more, /想接着读/)
  assert.match(more, /from 填 \[02:00\]/)

  const end = renderPage({ page: [{ t: 5, text: '最后一句。' }], next: null, done: true }, {})
  assert.match(end, /最后一句了/)
})

test('查字幕：带 from 就按顺序给一页，不再挑三句', async () => {
  await withRoot(async (root) => {
    const many = Array.from({ length: 30 }, (_, i) => ({ t: i * 5, text: `第${i}句。` }))
    const client = fakeClient({ subtitle: async () => ({ ok: true, data: many }) })
    const r = await subOnce({ bvid: BVID, from: '00:10', client, root, cfg: { bili: { enabled: true } } })
    assert.equal(r.ok, true)
    assert.ok(r.snippets.length > 3, '接着读时不该只给三句')
    assert.equal(r.snippets[0].t, 10)
    assert.match(r.text, /这一页/)
    assert.match(r.text, /想接着读/)
    assert.ok(r.page && r.page.next !== null)

    const seen = await readEvents(root)
    assert.equal(seen.events.filter((e) => String(e.text ?? '').startsWith('subs:')).length, 1)
  })
})

test('读字幕开关关着：直说关着，不取字幕也不记索引', async () => {
  await withRoot(async (root) => {
    const client = fakeClient()
    const r = await subOnce({ bvid: BVID, client, root, cfg: { bili: { enabled: true, sub: false } } })
    assert.equal(r.ok, false)
    assert.match(r.note, /字幕现在关着/)
    assert.equal(client.calls.length, 0, '关着就不该发请求')
    const seen = await readEvents(root)
    assert.equal(seen.events.filter((e) => String(e.text ?? '').startsWith('subs:')).length, 0)
  })
})

test('翻页索引记下读到第几页、读没读完', async () => {
  await withRoot(async (root) => {
    const many = Array.from({ length: 30 }, (_, i) => ({ t: i * 5, text: `第${i}句。` }))
    const client = fakeClient({ subtitle: async () => ({ ok: true, data: many }) })

    let from = 0
    const pages = []
    for (let k = 0; k < 10; k += 1) {
      const r = await subOnce({ bvid: BVID, from, client, root, cfg: { bili: { enabled: true } } })
      assert.equal(r.ok, true)
      pages.push(r.page)
      if (r.page.done) break
      from = r.page.next
    }
    assert.equal(pages.length, 3, '三十句、一页十二句：要三页才读完')
    assert.equal(pages[0].page, 1)
    assert.equal(pages[0].done, false)
    assert.equal(pages[2].done, true)

    const seen = await readEvents(root)
    const subs = seen.events.filter((e) => String(e.text ?? '').startsWith('subs:')).map((e) => e.text)
    assert.equal(subs.length, 3)
    assert.match(subs[0], /page=1 done=0/)
    assert.match(subs[2], /page=3 done=1/)
  })
})

test('带 from + 词：只在后半段里找对得上的句子，不看前半段', async () => {
  await withRoot(async (root) => {
    const client = fakeClient({
      subtitle: async () => ({
        ok: true,
        data: [
          { t: 10, text: '先说定价。' },
          { t: 200, text: '定价太高是主要问题。' },
          { t: 400, text: '最后说渠道。' },
        ],
      }),
    })
    const r = await subOnce({ bvid: BVID, from: '02:00', query: '定价', client, root, cfg: { bili: { enabled: true } } })
    assert.equal(r.ok, true)
    assert.equal(r.snippets.length, 1)
    assert.equal(r.snippets[0].t, 200)
    assert.match(r.text, /\[02:00\] 往后挑的几句/)
    assert.doesNotMatch(r.text, /\[00:10\] 先说定价/)

    const miss = await subOnce({ bvid: BVID, from: '05:00', query: '定价', client, root, cfg: { bili: { enabled: true } } })
    assert.equal(miss.ok, true, '没找到也要给一页，不空手')
    assert.match(miss.note, /没有对得上「定价」的句子/)
  })
})

test('没有登录 cookie：直接说清楚，不去猜"这条没字幕"', async () => {
  await withRoot(async (root) => {
    // 不传 client：走真实路径，root 里没有 owner.json，也就没有 cookie。
    const r = await subOnce({ bvid: BVID, root, cfg: { bili: { enabled: true } } })
    assert.equal(r.ok, false)
    assert.match(r.note, /登录/)
    assert.match(r.note, /cookie/)
    assert.doesNotMatch(r.note, /这条没有字幕/)

    // 也不该留下任何 subs: 索引——没读到就不能假装读过。
    const seen = await readEvents(root)
    assert.equal(seen.events.filter((e) => String(e.text ?? '').startsWith('subs:')).length, 0)
  })
})

test('登录过期的提示要把字幕也算进去（网页文案）', async () => {
  const { readFile } = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')
  const src = await readFile(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')
  assert.match(src, /查不了字幕/)
  assert.match(src, /AI 字幕要登录/)
})
