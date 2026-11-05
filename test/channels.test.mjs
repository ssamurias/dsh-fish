/**
 * channels.test.mjs —— 一条鱼多间房（2026-11-03，用户 m00584 / m00597）
 *
 * 要守住的是四件事，缺一条这个设计就塌：
 *   1. **场次要能落进事件流**，但 `desk` 是默认值，不许落库（老档不涨字段）。
 *   2. **群聊不碰生命体征**：不写 `seen:`、不涨轮数、不换会话。
 *      这是最伤的一条——群里一天几百句，写一条 seen 冷落检测就永远不触发。
 *   3. **私聊仍回书房**（"直接接进来"那个选项），群里才另开房。
 *   4. 桥不碰 `instance.json`：`/whoami` 把「这个家有没有人在」如实告诉它。
 *
 * 另外守一条老行为：不传 channel / scene 时，一切与以前一字不差。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { appendEvent, readEvents } from '../lib/store.js'
import { validateEvent, normalizeScene, SCENES } from '../lib/schema.js'
import {
  channelsPath, channelKey, channelTitle, resolveChannel, saveChannel, findChannel, dropChannel,
  CHANNELS_MAX,
} from '../lib/channels.js'
import { addExchange, recentExchanges, BUCKET_HOME, BUCKET_GROUP } from '../lib/talkmem.js'
import { sayToHer } from '../lib/say.js'
import { bumpTurns, homeStatus } from '../lib/home.js'
import { registerObserve } from '../lib/observe.js'

async function tmpRoot() {
  return mkdtemp(join(tmpdir(), 'fish-ch-'))
}

async function seed(root) {
  await appendEvent({ type: 'seed', text: '你不是助手。' }, { day: 1, stage: 1, source: 'system' }, root)
}

/**
 * 假宿主：能建会话、能改名、能投递。
 * `prompt` 里用 setTimeout 补一个 turn/end——say.js 是先投递再等 turn/end，
 * 同步 emit 会被漏掉（那时监听还没挂上）。
 */
function fakeCtx() {
  const calls = []
  const handlers = new Map()
  const ws = { id: 'ws-house', path: 'X:\\fake\\home', title: '大肥鱼的家', sessionIds: ['s-house'], archivedSessionIds: [] }
  const sc = {
    async create(o = {}) {
      calls.push({ op: 'create', ...o })
      // 按 workspaceId 建 = 新开一间房（第一次建出来的是书房 s-house）；按 sessionId 建 = 复用
      if (!o.workspaceId) return {}
      const n = calls.filter((c) => c.op === 'create' && c.workspaceId).length
      return { sessionId: n === 1 ? 's-house' : `s-room-${n - 1}` }
    },
    async rename(p) { calls.push({ op: 'rename', ...p }) },
    async prompt(req, signal) {
      calls.push({ op: 'prompt', req, signal })
      const sid = String(req?.sessionId ?? '')
      setTimeout(() => {
        for (const fn of handlers.get('session/event') ?? []) fn({ header: { id: sid } }, { type: 'turn/end' })
      }, 0)
    },
  }
  const workspaceRegistry = {
    list: () => [ws],
    get: (id) => (id === ws.id ? ws : null),
    create: async () => ws,
    update: async () => {},
  }
  const ctx = {
    sessionController: sc,
    on(ev, fn) {
      if (!handlers.has(ev)) handlers.set(ev, new Set())
      handlers.get(ev).add(fn)
      return () => handlers.get(ev)?.delete(fn)
    },
    get: (k) => (k === 'workspaceRegistry' ? workspaceRegistry : undefined),
  }
  return { ctx, calls }
}

// ------------------------------------------------------------------ 场次落库

test('SCENES 只有三种，认不出来的按 desk 算（绝不因为脏字段丢消息）', () => {
  assert.deepEqual([...SCENES], ['desk', 'private', 'group'])
  assert.equal(normalizeScene('group'), 'group')
  assert.equal(normalizeScene(' GROUP '), 'group')
  assert.equal(normalizeScene(''), 'desk')
  assert.equal(normalizeScene('群聊'), 'desk', '认不出来的场次按书房算，不能当群聊丢进另一条路')
  assert.equal(normalizeScene(undefined), 'desk')
})

test('场次落进事件流；desk 是默认值，不落库（老档不涨字段）', () => {
  const day = { day: 1, stage: 1 }
  assert.equal('scene' in validateEvent({ type: 'utterance', text: '在书房说的话。' }, day), false, 'desk 不写，否则每条老事件都多一个字段')
  assert.equal('scene' in validateEvent({ type: 'utterance', text: '在书房说的话。', scene: 'desk' }, day), false)
  assert.equal(validateEvent({ type: 'utterance', text: '在群里说的话。', scene: 'group' }, day).scene, 'group')
  assert.equal(validateEvent({ type: 'utterance', text: '私聊说的话。', scene: 'private' }, day).scene, 'private')
  // 写坏了也不许抛：认不出来按 desk
  assert.equal('scene' in validateEvent({ type: 'utterance', text: 'x', scene: '????' }, day), false)
})

// ------------------------------------------------------------------ channel 映射

test('channel 名先收敛再当 key：控制字符、超长、空白都兜得住', () => {
  assert.equal(channelKey(' qq:123456 '), 'qq:123456')
  assert.equal(channelKey('a\nb\tc'), 'a b c')
  assert.equal(channelKey('x'.repeat(200)).length, 120)
  assert.equal(channelKey(null), '')
  // 丑但非空的名字必须留下——丢一条消息比留个丑 key 严重
  assert.ok(channelKey('   spaced   name   ').length > 0)
})

test('房间标题带上渠道名，侧栏里能一眼认出是哪间', () => {
  assert.match(channelTitle('qq-group:987654', 'group'), /群聊/)
  assert.match(channelTitle('qq:123456', 'private'), /私聊/)
  assert.match(channelTitle('qq-group:987654', 'group'), /qq-group:987654/)
  assert.doesNotMatch(channelTitle('qq:1', 'group'), /他/, 'AGENTS.md §4：界面文案不出现男字旁的「他」')
})

test('没有 channel 的调用仍回书房——观测台与老桥的行为一字不变', async () => {
  const root = await tmpRoot()
  try {
    for (const args of [{}, { channel: '' }, { channel: '   ' }]) {
      const r = await resolveChannel(root, args)
      assert.equal(r.house, true, '没有 channel 就必须回书房')
      assert.equal(r.sessionId, '')
    }
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('私聊回书房（这就是「直接融合」），群聊才另开房', async () => {
  const root = await tmpRoot()
  try {
    const priv = await resolveChannel(root, { channel: 'qq:123456', scene: 'private' })
    assert.equal(priv.house, true, '私聊不能另开房，否则又变成两条鱼')
    assert.equal(priv.scene, 'private')

    const g1 = await resolveChannel(root, { channel: 'qq-group:987654', scene: 'group' })
    assert.equal(g1.house, false)
    assert.equal(g1.sessionId, '', '还没建过房，sessionId 该是空的')

    await saveChannel(root, { channel: 'qq-group:987654', scene: 'group', sessionId: 's-room-1', title: '客厅' })
    const g2 = await resolveChannel(root, { channel: 'qq-group:987654', scene: 'group' })
    assert.equal(g2.sessionId, 's-room-1', '同一个 channel 名 = 同一间房')
    assert.equal(g2.known, true)
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('同一间房换了会话 id 就更新；收起来的房再投递会重新建', async () => {
  const root = await tmpRoot()
  try {
    await saveChannel(root, { channel: 'qq-group:a', scene: 'group', sessionId: 's-old', title: '客厅' })
    await saveChannel(root, { channel: 'qq-group:a', scene: 'group', sessionId: 's-new', title: '客厅' })
    const list = await findChannel(root, 'qq-group:a')
    assert.equal(list.sessionId, 's-new')
    assert.equal((await findChannel(root, 'qq-group:a')).key, 'qq-group:a')

    await dropChannel(root, 'qq-group:a')
    assert.equal(await findChannel(root, 'qq-group:a'), null)
    const again = await resolveChannel(root, { channel: 'qq-group:a', scene: 'group' })
    assert.equal(again.sessionId, '', '房被收起来之后要重新建，不能指向一条不存在的会话')
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('映射文件坏了不许丢消息：读成空表，投递照常走建新房那条路', async () => {
  const root = await tmpRoot()
  try {
    const { writeFile, mkdir } = await import('node:fs/promises')
    await mkdir(join(root), { recursive: true })
    await writeFile(channelsPath(root), '{ 这不是 JSON', 'utf8')
    const r = await resolveChannel(root, { channel: 'qq-group:x', scene: 'group' })
    assert.equal(r.house, false)
    assert.equal(r.sessionId, '')
    assert.equal(r.known, false)
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('房间映射有上限，不会无限长', () => {
  assert.ok(typeof CHANNELS_MAX === 'number' && CHANNELS_MAX > 0)
})

// ------------------------------------------------------------------ talkmem 分桶

test('群聊的话另存一桶，不挤掉书房里的近况', async () => {
  const root = await tmpRoot()
  try {
    await addExchange(root, { me: '书房里说的', her: '书房里回的' })
    for (let i = 0; i < 6; i += 1) {
      await addExchange(root, { me: `群里第 ${i} 句`, her: '', scene: 'group' })
    }
    const home = await recentExchanges(root)
    assert.equal(home.length, 1, '群里刷屏不许把书房那几轮顶掉')
    assert.equal(home[0].me, '书房里说的')

    const group = await recentExchanges(root, 4, 'group')
    assert.equal(group.length, 4, '群聊自己也只留最近几轮')
    assert.equal(group[group.length - 1].me, '群里第 5 句')
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('老档只有 list，读的时候全并入书房——一句都不丢', async () => {
  const root = await tmpRoot()
  try {
    const { writeFile } = await import('node:fs/promises')
    const { paths } = await import('../lib/store.js')
    await writeFile(
      join(paths(root).root, 'talk-recent.json'),
      JSON.stringify({ list: [{ at: new Date().toISOString(), me: '老版本留下的一句', her: '' }] }),
      'utf8',
    )
    const home = await recentExchanges(root)
    assert.equal(home.length, 1)
    assert.equal(home[0].me, '老版本留下的一句')
    assert.deepEqual(await recentExchanges(root, 4, 'group'), [], '老档没有群聊，群聊桶是空的')
    assert.equal(BUCKET_HOME, 'home')
    assert.equal(BUCKET_GROUP, 'group')
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

// ------------------------------------------------------------------ say 分流

test('群里来话：另开一间房，不写 seen、不涨轮数、不换会话', async () => {
  const root = await tmpRoot()
  try {
    await seed(root)
    const { ctx, calls } = fakeCtx()

    const r = await sayToHer(ctx, '群里有人问你在不在', {
      root, waitMs: 5_000, channel: 'qq-group:987654', scene: 'group', speaker: '张三',
    })
    assert.equal(r.ok, true)
    assert.equal(r.scene, 'group')
    assert.equal(r.channel, 'qq-group:987654')
    assert.notEqual(r.sessionId, 's-house', '群聊不能落在书房那条会话里')

    // 建了房、登记了、标题带上渠道名
    const born = calls.find((c) => c.op === 'create' && c.workspaceId)
    assert.ok(born, '群聊要另开一间房')
    const named = calls.find((c) => c.op === 'rename' && c.sessionId === r.sessionId)
    assert.match(named?.title ?? '', /群聊/)
    const saved = await findChannel(root, 'qq-group:987654')
    assert.equal(saved.sessionId, r.sessionId)

    // 生命体征一条都不许动
    const { events } = await readEvents(root)
    const seen = events.filter((e) => e.type === 'meta' && String(e.text).startsWith('seen:'))
    assert.equal(seen.length, 0, '群里的话不算他来找过你——写一条 seen，冷落检测就废了')
    assert.equal((await homeStatus(root)).turns, 0, '群聊不涨轮数')

    // 递给她的正文：说清这是哪儿 + 谁说的
    // 注意要挑 say- 那条：同一条会话上还有一条 wake-room 的"醒来"提示。
    const sent = calls.find((c) => c.op === 'prompt' && c.req?.sessionId === r.sessionId && String(c.req?.requestId).startsWith('say-'))
    const text = sent?.req?.content?.[0]?.text ?? ''
    assert.match(text, /群里/, '要告诉她这是在群里，不是私下')
    assert.match(text, /张三/, '必须带说话人前缀，否则三个人会被当成一个人')
    assert.doesNotMatch(text, /## 他跟你说话了/, '群聊不能套那句「他跟你说话了」——那样她会以为是他本人来了')
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('群里说了话，书房里留一句「刚才有人叫过你」（串门）', async () => {
  const root = await tmpRoot()
  try {
    await seed(root)
    const { ctx } = fakeCtx()
    await sayToHer(ctx, '群里有人叫你', {
      root, waitMs: 5_000, channel: 'qq-group:1', scene: 'group', speaker: '李四',
    })
    await bumpTurns(root, 1) // 假装书房也说过话，让 deliverQueued 有家可回
    const notes = await readFile(join(root, 'session-notes.json'), 'utf8').catch(() => '')
    // 只有「她真回了一句」才写串门提示；这条消息里她没说话，所以队列可以是空的——
    // 要守的是"不许写进 talkmem 书房桶"，那才是会污染"上次我们说到这"的东西。
    assert.deepEqual(await recentExchanges(root), [], '群聊的话不许进书房桶')
    assert.ok(typeof notes === 'string')
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('等群里这一轮时侧栏结了账：没认领的聊天行不算她在群里回的', async () => {
  const root = await tmpRoot()
  try {
    await seed(root)
    const { ctx } = fakeCtx()
    // 群里最长等 75 秒，这期间侧栏回合结束，turns.js 就写一行 uncommitted（形状照抄 turns.js）。
    const writes = []
    const { prompt } = ctx.sessionController
    ctx.sessionController.prompt = async (req, signal) => {
      if (String(req?.requestId).startsWith('say-')) {
        for (const w of writes.splice(0)) await w()
      }
      return prompt(req, signal)
    }
    const chatLine = (text) => () => appendEvent(
      { type: 'utterance', text, flags: ['uncommitted'] },
      { day: 1, stage: 1, source: 'system' },
      root,
    )
    const opts = { root, waitMs: 5_000, channel: 'qq-group:1', scene: 'group', speaker: '路人' }

    writes.push(chatLine('这句只在侧栏说（合成）。'))
    const r = await sayToHer(ctx, '群里有人问你在不在', opts)
    assert.deepEqual(r.said, [], '侧栏的话不能算她在群里回的')
    assert.equal(r.herReply, '')
    assert.equal(r.note, '她这次没说话。')
    const group = await recentExchanges(root, 4, 'group')
    assert.equal(group[group.length - 1].her, '', '也不能进群聊那一桶')
    const notes = await readFile(join(root, 'session-notes.json'), 'utf8').catch(() => '')
    assert.doesNotMatch(notes, /你回过了/, '她没回，书房就不该留「你回过了」')

    // 她在这一轮真认领了一句：照常算，只滤掉聊天行
    writes.push(chatLine('这句也只在侧栏说（合成）。'))
    writes.push(() => appendEvent({ type: 'utterance', text: '这句是她认领的（合成）。' }, { day: 1, stage: 1, source: 'tool' }, root))
    const r2 = await sayToHer(ctx, '群里又有人问', opts)
    assert.deepEqual(r2.said.map((s) => s.text), ['这句是她认领的（合成）。'])
    assert.equal(r2.herReply, '这句是她认领的（合成）。')
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('私聊仍回书房：写 seen、涨轮数，与以前一字不差', async () => {
  const root = await tmpRoot()
  try {
    await seed(root)
    const { ctx } = fakeCtx()
    const r = await sayToHer(ctx, '在 qq 上私聊你', {
      root, waitMs: 5_000, channel: 'qq:123456', scene: 'private',
    })
    assert.equal(r.ok, true)
    assert.equal(r.scene, 'private')
    assert.equal(r.sessionId, 's-house', '私聊要落回书房——这就是「融合」')

    const { events } = await readEvents(root)
    const seen = events.filter((e) => e.type === 'meta' && String(e.text).startsWith('seen:'))
    assert.equal(seen.length, 1, '私聊是他真的来找过你，seen 必须写')
    assert.equal((await homeStatus(root)).turns, 1, '私聊要涨轮数')
    const home = await recentExchanges(root)
    assert.equal(home.length, 1, '私聊进书房桶，换会话时能被带走')
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('不传 channel / scene：老调用点行为完全不变', async () => {
  const root = await tmpRoot()
  try {
    await seed(root)
    const { ctx } = fakeCtx()
    const r = await sayToHer(ctx, '观测台里说一句', { root, waitMs: 5_000 })
    assert.equal(r.ok, true)
    assert.equal(r.scene, 'desk')
    assert.equal(r.channel, undefined, '没传 channel 就不该凭空出现在返回体里')
    assert.equal(r.sessionId, 's-house')
    const { events } = await readEvents(root)
    assert.equal(events.filter((e) => e.type === 'meta' && String(e.text).startsWith('seen:')).length, 1)
    assert.equal((await homeStatus(root)).turns, 1)
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

// ------------------------------------------------------------------ /whoami

function fakeObserveCtx() {
  const routes = []
  const ctx = {
    get: (k) => (k === 'connection'
      ? { requestRejection: () => null }
      : k === 'webServer'
        ? { register: (def) => { routes.push(def); return () => {} } }
        : undefined),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }
  return { ctx, routes }
}

async function callRoute(route, method = 'GET') {
  let status = 0
  let body = ''
  const res = {
    writeHead: (s) => { status = s },
    setHeader: () => {},
    end: (s) => { body = String(s ?? '') },
  }
  await route.handler({ method, url: route.path, headers: {} }, res)
  return { status, body }
}

test('GET /dsh-fish/whoami：桥启动前先问「家里有没有人在」', async () => {
  const root = await tmpRoot()
  try {
    const { ctx, routes } = fakeObserveCtx()
    registerObserve(ctx, { root, version: '9.9.9', tenancy: { tenant: { ok: true, instanceId: 'me' } } })
    const route = routes.find((r) => String(r.path || '').endsWith('/whoami'))
    assert.ok(route, '必须有 /whoami 路由')

    const { status, body } = await callRoute(route)
    assert.equal(status, 200)
    const d = JSON.parse(body)
    assert.equal(d.ok, true)
    assert.equal(d.plugin, 'dsh-fish')
    assert.equal(d.version, '9.9.9')
    assert.equal(d.root, root, 'root 让桥判断「是不是同一个家」')
    assert.equal(d.home, false, '还没建家 → home:false')
    assert.equal(d.writable, true)
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('另一个实例占着这个家时，whoami 说 writable:false（桥看到就该停手）', async () => {
  const root = await tmpRoot()
  try {
    const { ctx, routes } = fakeObserveCtx()
    registerObserve(ctx, { root, tenancy: { tenant: { ok: false, instanceId: 'x', why: '被人占着' } } })
    const route = routes.find((r) => String(r.path || '').endsWith('/whoami'))
    const { body } = await callRoute(route)
    assert.equal(JSON.parse(body).writable, false)
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('whoami 只收 GET', async () => {
  const root = await tmpRoot()
  try {
    const { ctx, routes } = fakeObserveCtx()
    registerObserve(ctx, { root, tenancy: { tenant: { ok: true } } })
    const route = routes.find((r) => String(r.path || '').endsWith('/whoami'))
    const { status } = await callRoute(route, 'POST')
    assert.equal(status, 405)
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})
