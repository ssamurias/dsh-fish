/**
 * watch.test.mjs —— `bili_watch` 的计数与拒绝分支。
 *
 * 真的抽帧要联网 + 开 ffmpeg，这里不测；测的是她会踩到的那几条边界：
 * 开关关着、给的不是视频号、额度用完、屏蔽名单里的那一条。
 * 要走到取详情那一步的用例一律注入假 client，不联网。
 *
 * issue #62 以前，这里的用例都先写 browse: { enabled: true } 才进得了门——那是已停用的
 * 刷站开关，默认关。现在门是 bili.enabled（默认开），所以这些用例直接跑在默认配置上。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { watchedToday, registerWatch } from '../lib/watch.js'
import { logFile } from '../lib/log.js'
import { appendEvent } from '../lib/store.js'
import { updateConfig } from '../lib/settings.js'

test('watchedToday 只数当天的 watched: 记录，昨天的不算', () => {
  const dk = '2026-10-23'
  const events = [
    { type: 'meta', text: `watched:${dk} BV1` },
    { type: 'meta', text: `watched:${dk} BV2` },
    { type: 'meta', text: 'watched:2026-10-22 BV3' },
    { type: 'utterance', text: 'watched:2026-10-23 不在 meta 里，不算' },
    { type: 'meta', text: 'browse:2026-10-23 BV4' },
  ]
  assert.equal(watchedToday(events, dk), 2)
  assert.equal(watchedToday([], dk), 0)
  assert.equal(watchedToday(null, dk), 0)
})

function fakeCtx() {
  const tools = []
  return {
    tools: { register: (t) => { tools.push(t); return { dispose() {} } } },
    _tools: tools,
  }
}

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-fish-watch-'))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

test('registerWatch：注册一个叫 bili_watch 的工具，参数是合法 JSON Schema', () => {
  const ctx = fakeCtx()
  registerWatch(ctx, { root: join(tmpdir(), 'dsh-fish-watch-test') })
  assert.equal(ctx._tools.length, 1)
  const t = ctx._tools[0]
  assert.equal(t.name, 'bili_watch')
  assert.equal(t.parameters.type, 'object')
  assert.ok(t.parameters.properties.bvid)
  assert.deepEqual(t.parameters.required, ['bvid'])
  // 2026-11-01 用户 m02712：at 是可选的，不许挤进 required，否则老的调用全失败
  assert.equal(t.parameters.properties.at.type, 'array')
  assert.equal(t.parameters.properties.at.items.type, 'number')
  assert.match(t.description, /at/)
  assert.equal(t.output.render.length >= 0, true)
})

// issue #62：这条原来关的是 browse.enabled——那是已停用的刷站开关，默认就是 false，
// 于是全新配置下看画面一律「现在打不开」。现在和 bili_look 一样认 bili.enabled。
test('registerWatch：上网关着时拒，且不暴露"管理员不让看"', async () => {
  await withRoot(async (root) => {
    await updateConfig({ bili: { enabled: false } }, root)
    const ctx = fakeCtx()
    registerWatch(ctx, { root })
    const out = await ctx._tools[0].execute({ bvid: 'BV1ED4y1Y7dc' })
    assert.equal(out.ok, false)
    assert.equal(out.note, '现在打不开。')
    assert.doesNotMatch(out.note, /管理员|权限|设置/)
  })
})

test('registerWatch：给的不是视频号就直说，不去联网', async () => {
  await withRoot(async (root) => {
    await updateConfig({ video: { enabled: true } }, root)
    const ctx = fakeCtx()
    registerWatch(ctx, { root })
    const out = await ctx._tools[0].execute({ bvid: '不是视频号' })
    assert.equal(out.ok, false)
    assert.equal(out.note, '这不是一个视频号。')
  })
})

test('registerWatch：画面功能关掉时拒，理由与"打不开"分开', async () => {
  await withRoot(async (root) => {
    await updateConfig({ video: { enabled: false } }, root)
    const ctx = fakeCtx()
    registerWatch(ctx, { root })
    const out = await ctx._tools[0].execute({ bvid: 'BV1ED4y1Y7dc' })
    assert.equal(out.ok, false)
    assert.equal(out.note, '现在看不了画面。')
  })
})

test('registerWatch：额度已经用完时只说"不想看了"，不报数字', async () => {
  await withRoot(async (root) => {
    await updateConfig({ video: { enabled: true, perDay: 1 } }, root)
    const { dateKey } = await import('../lib/settings.js')
    const dk = dateKey()
    await appendEvent({ type: 'meta', text: `watched:${dk} BV1xx411c7mD` }, { source: 'system' }, root)
    const ctx = fakeCtx()
    registerWatch(ctx, { root })
    const out = await ctx._tools[0].execute({ bvid: 'BV1ED4y1Y7dc' })
    assert.equal(out.ok, false)
    assert.equal(out.note, '今天不想再看画面了。')
    assert.doesNotMatch(out.note, /\d/)
  })
})

// 下面四条盯的是「导出包能不能判案」：用户那边的机器上「看不到画面」，
// 导出包里必须能看出是被哪一条挡下的。日志里可以写数字（给人看的），
// 工具回复里仍然不能出现数字（那是给她看的）。
function readLog(root) {
  try {
    return readFileSync(logFile(root), 'utf8')
  } catch {
    return ''
  }
}

test('看画面被设置关掉时，日志里留下「关掉了看视频」', async () => {
  await withRoot(async (root) => {
    await updateConfig({ video: { enabled: false } }, root)
    const ctx = fakeCtx()
    registerWatch(ctx, { root })
    await ctx._tools[0].execute({ bvid: 'BV1ED4y1Y7dc' })
    assert.match(readLog(root), /看画面：设置里关掉了看视频/)
  })
})

test('视频号不合法时，日志里留下「视频号不合法」和原样的入参', async () => {
  await withRoot(async (root) => {
    await updateConfig({ video: { enabled: true } }, root)
    const ctx = fakeCtx()
    registerWatch(ctx, { root })
    await ctx._tools[0].execute({ bvid: '不是视频号' })
    const log = readLog(root)
    assert.match(log, /看画面：视频号不合法/)
    assert.match(log, /不是视频号/)
  })
})

test('额度用完时日志写数字（1/1），好追额度怎么用掉的', async () => {
  await withRoot(async (root) => {
    await updateConfig({ video: { enabled: true, perDay: 1 } }, root)
    const { dateKey } = await import('../lib/settings.js')
    await appendEvent({ type: 'meta', text: `watched:${dateKey()} BV1xx411c7mD` }, { source: 'system' }, root)
    const ctx = fakeCtx()
    registerWatch(ctx, { root })
    await ctx._tools[0].execute({ bvid: 'BV1ED4y1Y7dc' })
    assert.match(readLog(root), /看画面：今日额度已满 1\/1 BV1ED4y1Y7dc/)
  })
})

/** 假 client：默认详情干净、标签干净、给出一个本机打不开的播放地址 */
function fakeClient(over = {}) {
  const calls = []
  const base = {
    view: async (bvid) => ({ ok: true, data: { bvid, aid: 1001, cid: 555, title: '一个普通的视频', up: '某UP', mid: 7, duration: 600 } }),
    tags: async () => ({ ok: true, data: ['日常'] }),
    playurl: async () => ({ ok: true, data: { url: 'http://127.0.0.1:9/none.mp4', duration: 600 } }),
  }
  const c = { calls }
  for (const [k, fn] of Object.entries({ ...base, ...over })) {
    c[k] = async (...a) => { calls.push([k, ...a]); return fn(...a) }
  }
  return c
}

test('抽帧失败时写 warn 一行，带上失败原因', async () => {
  await withRoot(async (root) => {
    // ffmpeg 不在 PATH 上 → grabFrames 失败；这条是导出包里最值钱的一行
    // issue #62：原来不注入 client、真去请求 B 站（断网时靠请求失败才走到这一行，
    // 联网时要看那条真视频还在不在）。改用假 client 给出详情和播放地址，失败只落在 ffmpeg 这一步。
    const saved = process.env.PATH
    process.env.PATH = ''
    try {
      await updateConfig({ video: { enabled: true } }, root)
      const ctx = fakeCtx()
      registerWatch(ctx, { root, client: fakeClient() })
      await ctx._tools[0].execute({ bvid: 'BV1ED4y1Y7dc' })
      assert.match(readLog(root), /看画面：抽帧失败 BV1ED4y1Y7dc/)
    } finally {
      process.env.PATH = saved
    }
  })
})

// issue #16 第二半（2026-11-01，用户 m03454）：看画面写的 watched: 也要认调用者。
test('bili_watch：不在这个家里的会话调不动它', async () => {
  await withRoot(async (root) => {
    const ctx = fakeCtx()
    registerWatch(ctx, { root, tenant: { herDir: join(root, 'her'), tenant: { ok: true } } })
    const away = { agent: { session: { id: 'session-other', header: { id: 'session-other', cwd: tmpdir() } } } }
    const out = await ctx._tools[0].execute({ bvid: 'BV1ED4y1Y7dc' }, away)
    assert.equal(out.ok, false)
    assert.match(out.note, /另一个家|没有落盘/)
  })
})

// ---------------------------------------------------------------- issue #62：屏蔽名单
// 原来 bili_watch 不过屏蔽名单：标题含屏蔽词、UP 在屏蔽名单里的视频照看。
// 现在和 bili_look 点名打开一条时一样：查关键词（标题、UP 名、标签）和屏蔽的 UP，
// 在取播放地址之前；最短时长只管列表，点名的这一条不查。

const noPlay = { playurl: async () => ({ ok: false, message: '假的：不给播放地址' }) }

async function watchOnce(root, client, bvid = 'BV1ED4y1Y7dc') {
  const ctx = fakeCtx()
  registerWatch(ctx, { root, client })
  return ctx._tools[0].execute({ bvid })
}

async function watchedLines(root) {
  const { readEvents } = await import('../lib/store.js')
  const { events } = await readEvents(root)
  return events.filter((e) => String(e.text ?? '').startsWith('watched:'))
}

test('看画面：标题含屏蔽词的不看，不取播放地址、不占额度，回她的话和 bili_look 一样', async () => {
  await withRoot(async (root) => {
    await updateConfig({ avoid: { keywords: ['恐怖'] } }, root)
    const client = fakeClient({ ...noPlay, view: async (bvid) => ({ ok: true, data: { bvid, cid: 555, title: '一个恐怖故事', up: '某UP', mid: 7 } }) })
    const out = await watchOnce(root, client)
    assert.equal(out.ok, false)
    assert.equal(out.note, '这条我不想看。')
    assert.doesNotMatch(out.note, /屏蔽|黑名单|设置/)
    assert.equal(client.calls.filter((c) => c[0] === 'playurl').length, 0, '不看的那条，播放地址一次都不要')
    assert.equal((await watchedLines(root)).length, 0)
    assert.match(readLog(root), /看画面：屏蔽名单挡下 BV1ED4y1Y7dc 恐怖/)
  })
})

test('看画面：屏蔽的 UP（mid）不看', async () => {
  await withRoot(async (root) => {
    await updateConfig({ avoid: { keywords: [], upMids: ['42'] } }, root)
    const client = fakeClient({ ...noPlay, view: async (bvid) => ({ ok: true, data: { bvid, cid: 555, title: '正常', up: '某UP', mid: 42 } }) })
    const out = await watchOnce(root, client)
    assert.equal(out.note, '这条我不想看。')
    assert.equal(client.calls.filter((c) => c[0] === 'playurl').length, 0)
  })
})

test('看画面：标题干净但标签命中，也不看', async () => {
  await withRoot(async (root) => {
    await updateConfig({ avoid: { keywords: ['鬼畜'] } }, root)
    const client = fakeClient({ ...noPlay, tags: async () => ({ ok: true, data: ['鬼畜', '音乐'] }) })
    const out = await watchOnce(root, client)
    assert.equal(out.note, '这条我不想看。')
    assert.equal(client.calls.filter((c) => c[0] === 'tags').length, 1)
    assert.equal(client.calls.filter((c) => c[0] === 'playurl').length, 0)
  })
})

test('看画面：标签取不到时照样按标题和 UP 判断，不拦也不报错', async () => {
  await withRoot(async (root) => {
    await updateConfig({ avoid: { keywords: ['鬼畜'] } }, root)
    const client = fakeClient({ ...noPlay, tags: async () => { throw new Error('标签接口挂了') } })
    const out = await watchOnce(root, client)
    assert.equal(out.note, '假的：不给播放地址', '没命中就往下走，失败理由是后面那一步的')
    assert.equal(client.calls.filter((c) => c[0] === 'playurl').length, 1)
  })
})

test('看画面：最短时长不管点名的这一条；没有屏蔽词时不多取一次标签', async () => {
  await withRoot(async (root) => {
    await updateConfig({ avoid: { keywords: [], upMids: [], minDuration: 600 } }, root)
    const client = fakeClient({ ...noPlay, view: async (bvid) => ({ ok: true, data: { bvid, cid: 555, title: '很短', up: '某UP', mid: 7, duration: 30 } }) })
    const out = await watchOnce(root, client)
    assert.notEqual(out.note, '这条我不想看。')
    assert.equal(client.calls.filter((c) => c[0] === 'playurl').length, 1, '30 秒的这条照样去取播放地址')
    assert.equal(client.calls.filter((c) => c[0] === 'tags').length, 0)
  })
})
