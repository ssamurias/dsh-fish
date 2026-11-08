/**
 * watch.test.mjs —— `bili_watch` 的计数与拒绝分支。
 *
 * 真的抽帧要联网 + 开 ffmpeg，这里不测；测的是她会踩到的那几条边界：
 * 开关关着、给的不是视频号、额度用完。
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

test('registerWatch：开关关着时拒，且不暴露"管理员不让看"', async () => {
  await withRoot(async (root) => {
    // 2026-11-07（用户反馈）：这道闸门改看 bili.enabled——browse.enabled 是「刷站」，
    // 0.9.0 起默认关；拿它当闸门会让 bili_look 能翻、bili_watch 永远打不开。
    await updateConfig({ bili: { enabled: false } }, root)
    const ctx = fakeCtx()
    registerWatch(ctx, { root })
    const out = await ctx._tools[0].execute({ bvid: 'BV1ED4y1Y7dc' })
    assert.equal(out.ok, false)
    assert.equal(out.note, '现在打不开。')
    assert.doesNotMatch(out.note, /管理员|权限|设置/)
    // 导出包里要能判案：这一条也得留一行。
    assert.match(readLog(root), /看画面：设置里关掉了 B 站/)
  })
})

test('registerWatch：给的不是视频号就直说，不去联网', async () => {
  await withRoot(async (root) => {
    await updateConfig({ bili: { enabled: true }, video: { enabled: true } }, root)
    const ctx = fakeCtx()
    registerWatch(ctx, { root })
    const out = await ctx._tools[0].execute({ bvid: '不是视频号' })
    assert.equal(out.ok, false)
    assert.equal(out.note, '这不是一个视频号。')
  })
})

test('registerWatch：画面功能关掉时拒，理由与"打不开"分开', async () => {
  await withRoot(async (root) => {
    await updateConfig({ bili: { enabled: true }, video: { enabled: false } }, root)
    const ctx = fakeCtx()
    registerWatch(ctx, { root })
    const out = await ctx._tools[0].execute({ bvid: 'BV1ED4y1Y7dc' })
    assert.equal(out.ok, false)
    assert.equal(out.note, '现在看不了画面。')
  })
})

test('registerWatch：额度已经用完时只说"不想看了"，不报数字', async () => {
  await withRoot(async (root) => {
    await updateConfig({ bili: { enabled: true }, video: { enabled: true, perDay: 1 } }, root)
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
    await updateConfig({ bili: { enabled: true }, video: { enabled: false } }, root)
    const ctx = fakeCtx()
    registerWatch(ctx, { root })
    await ctx._tools[0].execute({ bvid: 'BV1ED4y1Y7dc' })
    assert.match(readLog(root), /看画面：设置里关掉了看视频/)
  })
})

test('视频号不合法时，日志里留下「视频号不合法」和原样的入参', async () => {
  await withRoot(async (root) => {
    await updateConfig({ bili: { enabled: true }, video: { enabled: true } }, root)
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
    await updateConfig({ bili: { enabled: true }, video: { enabled: true, perDay: 1 } }, root)
    const { dateKey } = await import('../lib/settings.js')
    await appendEvent({ type: 'meta', text: `watched:${dateKey()} BV1xx411c7mD` }, { source: 'system' }, root)
    const ctx = fakeCtx()
    registerWatch(ctx, { root })
    await ctx._tools[0].execute({ bvid: 'BV1ED4y1Y7dc' })
    assert.match(readLog(root), /看画面：今日额度已满 1\/1 BV1ED4y1Y7dc/)
  })
})

test('抽帧失败时写 warn 一行，带上失败原因', async () => {
  await withRoot(async (root) => {
    // ffmpeg 不在 PATH 上 → grabFrames 失败；这条是导出包里最值钱的一行
    const saved = process.env.PATH
    process.env.PATH = ''
    try {
      await updateConfig({ bili: { enabled: true }, video: { enabled: true } }, root)
      const ctx = fakeCtx()
      registerWatch(ctx, { root })
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
