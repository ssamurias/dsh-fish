/**
 * watch-avoid.test.mjs —— 点名看画面也要过屏蔽名单（issue #62 的后续）
 *
 * 0.9.5 的 grabFrames 按 B 站原始回包去读 `owner.name` / `owner.mid` / `tags`，
 * 可 `client.view()` 回来的 data 已经被 toVideo 摊平成 `up` / `mid`，也没有标签。
 * 结果只有「标题里的屏蔽词」拦得住：屏蔽的 UP、UP 名带屏蔽词、标签带屏蔽词的视频
 * 照样去要播放地址；被拦下的那次日志还写成「抽帧失败」，看不出命中了哪一项。
 *
 * 这里不拿扁平对象直接喂 watchBlocked：走 bili_watch → grabFrames → 它自己建的
 * 真 createClient，只把 globalThis.fetch 换成假的，回包是真接口的形状。
 * 不联网，也走不到 ffmpeg：被拦的停在 view / tags，放行的停在 playurl（假回包拒绝）。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { registerWatch } from '../lib/watch.js'
import { updateConfig } from '../lib/settings.js'
import { logFile } from '../lib/log.js'
import { readEvents } from '../lib/store.js'
import { resetRisk, setPacing, getPacing } from '../lib/bili.js'

const BVID = 'BV1xx411c7mD'

// 共用的请求队列默认每条隔 0.8–1.3 秒；这里只有假 fetch，压到下限省时间，跑完还原。
const PACE = getPacing()
setPacing({ minIntervalMs: 200, jitterMs: 0 })
after(() => setPacing(PACE))

/** /x/web-interface/view 的真格式（字段名照真接口，值是编的） */
function viewBody({ title = '一条普通的视频', mid = 7, name = '普通UP' } = {}) {
  return {
    code: 0,
    message: '0',
    ttl: 1,
    data: {
      bvid: BVID,
      aid: 170001,
      videos: 1,
      tid: 21,
      tname: '日常',
      pic: 'https://i0.hdslb.com/bfs/archive/x.jpg',
      title,
      pubdate: 1700000000,
      ctime: 1700000000,
      desc: '简介',
      duration: 600,
      owner: { mid, name, face: 'https://i0.hdslb.com/bfs/face/x.jpg' },
      stat: { aid: 170001, view: 12345, danmaku: 67, reply: 89, favorite: 10, coin: 5, share: 2, like: 300 },
      cid: 279786,
      pages: [{ cid: 279786, page: 1, from: 'vupload', part: 'P1', duration: 600 }],
    },
  }
}

/** /x/tag/archive/tags 的真格式 */
function tagsBody(names) {
  return {
    code: 0,
    message: '0',
    ttl: 1,
    data: names.map((n, i) => ({ tag_id: 1000 + i, tag_name: n, cover: '', likes: 0, hates: 0, attribute: 0, type: 3, content: '' })),
  }
}

/** 假 fetch：按路径回真格式的包，记下每个请求的地址 */
function fakeFetch({ view = viewBody(), tags = [] } = {}) {
  const urls = []
  const f = async (url) => {
    const u = String(url)
    urls.push(u)
    let body
    if (u.includes('/x/frontend/finger/spi')) body = { code: 0, data: { b_3: 'BUVID3-TEST', b_4: 'BUVID4-TEST' } }
    else if (u.includes('/x/web-interface/view')) body = view
    else if (u.includes('/x/tag/archive/tags')) body = tagsBody(tags)
    // 放行的那条停在这里：拿不到播放地址，走不到 ffmpeg
    else if (u.includes('/x/player/playurl')) body = { code: -404, message: '啥都木有' }
    else body = { code: -404, message: '假 fetch 没有这个接口' }
    const text = JSON.stringify(body)
    return { status: 200, ok: true, text: async () => text, json: async () => body }
  }
  f.urls = urls
  f.asked = (path) => urls.some((x) => x.includes(path))
  return f
}

function readLog(root) {
  try {
    return readFileSync(logFile(root), 'utf8')
  } catch {
    return ''
  }
}

/** 照她的用法调一次 bili_watch；返回工具回执、假 fetch、日志、事件流 */
async function watchOnce(avoid, net) {
  const root = await mkdtemp(join(tmpdir(), 'fish-watch-avoid-'))
  const realFetch = globalThis.fetch
  try {
    await updateConfig({ bili: { enabled: true }, video: { enabled: true, perDay: 5 }, avoid }, root)
    resetRisk()
    const f = fakeFetch(net)
    globalThis.fetch = f
    const tools = []
    registerWatch({ tools: { register: (t) => { tools.push(t); return () => {} } } }, { root })
    const out = await tools[0].execute({ bvid: BVID })
    const { events } = await readEvents(root)
    return { out, f, log: readLog(root), events }
  } finally {
    globalThis.fetch = realFetch
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

function assertBlocked(r, label) {
  assert.equal(r.out.ok, false, label)
  assert.equal(r.out.note, '这条我不想看。', `${label}：她听到的理由`)
  assert.ok(r.f.asked('/x/web-interface/view'), `${label}：先取详情`)
  assert.ok(!r.f.asked('/x/player/playurl'), `${label}：被拦下就不该去要播放地址，实际请求了 ${r.f.urls.join(' ')}`)
  assert.ok(!r.events.some((e) => String(e.text ?? '').startsWith('watched:')), `${label}：没看成不记 watched:`)
  // 日志给人看：写清是命中屏蔽、命中了哪一项，不能记成抽帧失败
  assert.match(r.log, /看画面：命中屏蔽/, `${label}：日志要写命中屏蔽`)
  assert.doesNotMatch(r.log, /抽帧失败/, `${label}：命中屏蔽不是抽帧失败`)
}

test('屏蔽名单里的 UP：view 回包里 owner.mid 命中就不取画面（issue #62）', async () => {
  const r = await watchOnce({ upMids: ['42'] }, { view: viewBody({ mid: 42, name: '某UP' }) })
  assertBlocked(r, '屏蔽的 UP')
  assert.match(r.log, /UP 42/, '日志里要看得出是哪个 UP')
})

test('UP 名里带屏蔽词也拦，标题干净也一样（issue #62）', async () => {
  const r = await watchOnce({ keywords: ['鬼畜'] }, { view: viewBody({ name: '某某鬼畜区' }) })
  assertBlocked(r, 'UP 名带屏蔽词')
  assert.match(r.log, /UP 名含屏蔽词「鬼畜」/)
  assert.ok(!r.f.asked('/x/tag/archive/tags'), '标题 / UP 名已经命中，不用再为标签多发一次请求')
})

test('标签带屏蔽词：去取一次标签，命中就不取画面（issue #62）', async () => {
  const r = await watchOnce({ keywords: ['鬼畜'] }, { tags: ['音乐', '鬼畜'] })
  assertBlocked(r, '标签带屏蔽词')
  assert.ok(r.f.asked('/x/tag/archive/tags'), '标签不在详情里，得另外取')
  assert.match(r.log, /标签含屏蔽词「鬼畜」/)
})

test('标题带屏蔽词：照旧拦下，日志改记命中项（issue #62）', async () => {
  const r = await watchOnce({ keywords: ['鬼畜'] }, { view: viewBody({ title: '【鬼畜】全明星' }) })
  assertBlocked(r, '标题带屏蔽词')
  assert.match(r.log, /标题含屏蔽词「鬼畜」/)
})

test('对照：什么都没命中就照常去要播放地址，失败照旧记抽帧失败', async () => {
  const r = await watchOnce({ keywords: ['鬼畜'], upMids: ['42'] }, { tags: ['日常', '生活'] })
  assert.equal(r.out.ok, false, '假 playurl 拒了，这次看不成')
  assert.notEqual(r.out.note, '这条我不想看。')
  assert.ok(r.f.asked('/x/player/playurl'), '没命中屏蔽就该往下走到播放地址')
  assert.match(r.log, /看画面：抽帧失败/)
  assert.doesNotMatch(r.log, /命中屏蔽/)
})

test('没设屏蔽词时不为标签多发请求', async () => {
  // 默认配置自带几个屏蔽词，这里显式清空
  const r = await watchOnce({ keywords: [], upMids: ['42'] }, { tags: ['鬼畜'] })
  assert.ok(!r.f.asked('/x/tag/archive/tags'), '只设了 UP 名单，标签用不上')
  assert.ok(r.f.asked('/x/player/playurl'))
})
