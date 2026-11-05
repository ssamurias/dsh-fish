// 换会话的两条入口会并发（0.8.8 用户房间分裂）：
// 设置页/桌面聊天走 lib/turns.js 的结账，QQ 桥走 lib/say.js 的结账，
// 两边都在满 rotateAfter 时调 rotateTalkSession，中间没有互斥时会各
// sc.create 一条新会话——侧栏多一间同名空房，先建的那条还可能跑过一轮。
// 这里盯三件事：同一刻两个调用只建一条、换完之后迟到的那次跳过、
// 不是当前屋子里的调用不换。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { rotateTalkSession, homeStatus } from '../lib/home.js'

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fish-rotate-race-'))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

async function seedHome(root, over = {}) {
  const { writeAtomic, paths } = await import('../lib/store.js')
  const homeFile = join(paths(root).root, 'home.json')
  await writeAtomic(homeFile, JSON.stringify({
    wsId: 'ws-1',
    sessionId: 'sess-old',
    turns: 40,
    ...over,
  }))
  return homeFile
}

function fakeCtx() {
  const calls = { create: [], rename: [] }
  return {
    calls,
    sessionController: {
      async create(args) {
        calls.create.push(args)
        return { sessionId: `sess-new-${calls.create.length}` }
      },
      async rename(args) {
        calls.rename.push(args)
        return {}
      },
    },
    get(name) {
      if (name === 'workspaceRegistry') {
        return {
          get: () => ({ id: 'ws-1', sessionIds: ['sess-old'], path: '/x' }),
          archivedSessionIds: [],
          list: () => [{ id: 'ws-1', path: '/x', title: '大肥鱼的家' }],
        }
      }
      return null
    },
  }
}

test('同一刻两条入口都要换：只建一条新会话（0.8.8 房间分裂）', () => withRoot(async (root) => {
  const homeFile = await seedHome(root)
  const ctx = fakeCtx()

  // /say 的结账与 turns 的结账是两条独立路径，几乎同时到。
  const [a, b] = await Promise.all([
    rotateTalkSession(ctx, { root, from: 'sess-old' }),
    rotateTalkSession(ctx, { root, from: 'sess-old' }),
  ])

  assert.equal(ctx.calls.create.length, 1, '两条入口各建一条就是用户报的那个 bug')
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.equal(a.sessionId, b.sessionId, '两边必须拿到同一间新屋子')

  // 旧会话只留一份，且被改名成「…之前」——不是被删，也不是被改两次
  const oldRenames = ctx.calls.rename.filter((x) => x.sessionId === 'sess-old')
  assert.equal(oldRenames.length, 1)
  assert.match(oldRenames[0].title, /之前/)

  const st = await homeStatus(root)
  assert.equal(st.sessionId, a.sessionId)
  assert.equal(st.turns, 0)
  const raw = JSON.parse(await readFile(homeFile, 'utf8'))
  assert.equal(raw.rotatedFrom, 'sess-old')
}))

test('另一条入口先换完了：后到的那次直接跳过，不再建会话', () => withRoot(async (root) => {
  await seedHome(root)
  const ctx = fakeCtx()

  const first = await rotateTalkSession(ctx, { root, from: 'sess-old' })
  assert.equal(first.ok, true)

  // 这就是真机上的 115ms：turns 那边已经换完，say 这边才走到结账。
  const second = await rotateTalkSession(ctx, { root, from: 'sess-old' })
  assert.equal(second.ok, true)
  assert.equal(second.skipped, true)
  assert.equal(second.sessionId, first.sessionId)
  assert.equal(ctx.calls.create.length, 1, '跳过就不能再 sc.create')
  assert.equal(ctx.calls.rename.filter((x) => x.sessionId === 'sess-old').length, 1)
}))

test('不是这个屋子里的调用不换（from 与 home.json 对不上）', () => withRoot(async (root) => {
  await seedHome(root)
  const ctx = fakeCtx()

  // 人在别处说话、home.json 早指向另一条时进来：这声结账不该替别人换房。
  const r = await rotateTalkSession(ctx, { root, from: 'sess-elsewhere' })
  assert.equal(r.ok, true)
  assert.equal(r.skipped, true)
  assert.equal(r.sessionId, 'sess-old')
  assert.equal(ctx.calls.create.length, 0)

  const st = await homeStatus(root)
  assert.equal(st.sessionId, 'sess-old', '屋子还是原来那间')
  assert.equal(st.turns, 40, '轮数不被这次跳过清掉')
}))
