/**
 * look-frame-hint.test.mjs —— 「翻到」之后还有一步（2026-11-09，外部用户反馈）
 *
 * 她每天翻 B 站列表，却一次都没想起来看画面：翻完就把这一趟当成做完了，
 * 跟打卡一样。修法不是另写一条规矩（他手动说过一次，下一轮照样想不起来），
 * 而是在她**刚拿到素材**的那一刻把下一步说清楚，并且今天已经看过画面的不再念。
 *
 * 这一层守三件事：
 *   1. 列表/单条素材末尾带一句：画面还没看，想看就用 bili_watch
 *   2. 今天已经看过画面的那几条不再念（不催她重复看）
 *   3. 全部看过就不念（不制造无意义的回声）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { lookOnce } from '../lib/look.js'
import { normalizeConfig, dateKey } from '../lib/settings.js'
import { appendEvent } from '../lib/store.js'

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fish-lookhint-'))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

const v = (over = {}) => ({
  bvid: 'BV1xx411c7mD', aid: 1001, title: '一个普通的视频', up: '某UP', mid: 42,
  duration: 600, view: 100000, like: 5000, danmaku: 200, ...over,
})

function fakeClient(over = {}) {
  const base = {
    view: async (bvid) => ({ ok: true, data: { desc: `简介 ${bvid}`, pubdate: 1700000000, cid: 555, aid: 1001, title: `标题 ${bvid}`, up: '某UP' } }),
    tags: async () => ({ ok: true, data: ['日常', '生活'] }),
    replies: async () => ({ ok: true, data: [{ text: '热评一', like: 99 }] }),
    danmaku: async () => ({ ok: true, data: [{ t: 12, text: '这句是弹幕' }] }),
    popular: async () => ({ ok: true, data: [v({ bvid: 'BV1aa411c7mD', title: '第一条' }), v({ bvid: 'BV1bb411c7mD', title: '第二条' })] }),
    ranking: async () => ({ ok: true, data: [] }),
  }
  const c = {}
  for (const [k, fn] of Object.entries({ ...base, ...over })) c[k] = async (...a) => fn(...a)
  return c
}

test('单条：翻到之后说清画面还没看，并点名 bili_watch', async () => {
  await withRoot(async (root) => {
    const r = await lookOnce({ what: 'video', bvid: v().bvid, root, client: fakeClient(), cfg: normalizeConfig({}) })
    assert.equal(r.ok, true)
    assert.match(r.text, /画面还没看/)
    assert.match(r.text, /bili_watch/)
    assert.match(r.text, /不想看也行/)
  })
})

test('单条：今天已经看过画面的，不再念这一句', async () => {
  await withRoot(async (root) => {
    const bvid = v().bvid
    await appendEvent({ type: 'meta', text: `watched:${dateKey()} ${bvid} {"title":"某条"}` }, { source: 'system' }, root)
    const r = await lookOnce({ what: 'video', bvid, root, client: fakeClient(), cfg: normalizeConfig({}) })
    assert.equal(r.ok, true)
    assert.doesNotMatch(r.text, /画面还没看/)
  })
})

test('列表：几条一起翻到，用「这几条」，且一条都没看过才念', async () => {
  await withRoot(async (root) => {
    const r = await lookOnce({ what: 'home', root, client: fakeClient(), cfg: normalizeConfig({}) })
    assert.equal(r.ok, true)
    assert.match(r.text, /这几条我只翻到了标题和文字/)
    assert.match(r.text, /bili_watch/)
  })
})
