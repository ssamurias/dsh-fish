/**
 * append-newline.test.mjs —— 事件流末尾缺换行时，appendEvent 先补换行再写
 *
 * 守住的事：
 *   1. 最后一行停在半行上（写到一半进程没了、盘满、被截断）：之后写的每一条都读得回来
 *   2. 最后一行完整、只是没有末尾换行（手改过）：那一行和新写的一行都读得回来
 *   3. 文件里只有起点一行且没换行：起点还在（否则下次启动会再播种一次）
 *   4. 正常的文件一个字节都不多写；文件不在时照常新建
 *   5. 半行后面同时来好几条：一条不丢
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { appendEvent, readEvents, paths } from '../lib/store.js'

const CTX = { day: 1, stage: 1, source: 'system' }

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fish-append-nl-'))
  try {
    return await fn(root, paths(root).events)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const texts = async (root) => (await readEvents(root)).events.map((e) => e.text)

test('最后一行停在半行上：之后写的事件都读得回来，只丢那半行', async () => {
  await withRoot(async (root, file) => {
    await appendEvent({ type: 'seed', text: '起点' }, CTX, root)
    await appendEvent({ type: 'meta', text: '会被截断的一条' }, CTX, root)
    const raw = await readFile(file, 'utf8')
    await writeFile(file, raw.slice(0, raw.length - 40)) // 最后一行截在半行上

    const a = await appendEvent({ type: 'meta', text: '截断之后的第一条' }, CTX, root)
    const b = await appendEvent({ type: 'meta', text: '截断之后的第二条' }, CTX, root)
    assert.ok(a.id && b.id)

    const r = await readEvents(root)
    assert.deepEqual(r.events.map((e) => e.text), ['起点', '截断之后的第一条', '截断之后的第二条'])
    assert.deepEqual(r.events.slice(1).map((e) => e.id), [a.id, b.id])
    assert.equal(r.skipped, 1, '读不出来的只有原来那半行')
  })
})

test('最后一行完整、只缺末尾换行：两条都读得回来', async () => {
  await withRoot(async (root, file) => {
    await appendEvent({ type: 'seed', text: '起点' }, CTX, root)
    await appendEvent({ type: 'meta', text: '完整但没换行的一条' }, CTX, root)
    const raw = await readFile(file, 'utf8')
    await writeFile(file, raw.replace(/\n$/, ''))

    await appendEvent({ type: 'meta', text: '后来写的' }, CTX, root)

    const r = await readEvents(root)
    assert.deepEqual(r.events.map((e) => e.text), ['起点', '完整但没换行的一条', '后来写的'])
    assert.equal(r.skipped, 0)
  })
})

test('只有起点一行且没换行：起点还在，不会被当成没播种过', async () => {
  await withRoot(async (root, file) => {
    await appendEvent({ type: 'seed', text: '起点' }, CTX, root)
    const raw = await readFile(file, 'utf8')
    await writeFile(file, raw.replace(/\n$/, ''))

    await appendEvent({ type: 'meta', text: '后来写的' }, CTX, root)

    const r = await readEvents(root)
    assert.ok(r.events.some((e) => e.type === 'seed'), '起点读得出来')
    assert.equal(r.events.length, 2)
    assert.equal(r.skipped, 0)
  })
})

test('正常的文件不多写字节：补的换行只在缺的时候出现', async () => {
  await withRoot(async (root, file) => {
    // 文件还不在：照常新建
    await appendEvent({ type: 'seed', text: '起点' }, CTX, root)
    await appendEvent({ type: 'meta', text: '第二条' }, CTX, root)
    await appendEvent({ type: 'meta', text: '第三条' }, CTX, root)
    const raw = await readFile(file, 'utf8')
    assert.ok(raw.endsWith('\n'))
    const lines = raw.split('\n')
    assert.equal(lines.length, 4, '三行加末尾的空串')
    assert.ok(lines.slice(0, 3).every((l) => l.startsWith('{') && l.endsWith('}')), '没有空行')

    // 缺换行时补的那个换行紧跟在原来的字后面，原来的字一个不动
    const cut = raw.slice(0, raw.length - 1)
    await writeFile(file, cut)
    await appendEvent({ type: 'meta', text: '第四条' }, CTX, root)
    const after = await readFile(file, 'utf8')
    assert.ok(after.startsWith(cut + '\n{'), '只追加，不改已有的字')
    assert.equal(after.split('\n').length, 5)
  })
})

test('半行后面同时来好几条：一条不丢', async () => {
  await withRoot(async (root, file) => {
    await appendEvent({ type: 'seed', text: '起点' }, CTX, root)
    await writeFile(file, (await readFile(file, 'utf8')) + '{"id":"e_half","type":"meta","te')

    const want = Array.from({ length: 12 }, (_, i) => `同时写的第 ${i + 1} 条`)
    await Promise.all(want.map((text) => appendEvent({ type: 'meta', text }, CTX, root)))

    const got = await texts(root)
    assert.equal(got[0], '起点')
    assert.deepEqual(got.slice(1).sort(), [...want].sort())
    assert.equal((await readEvents(root)).skipped, 1)
  })
})
