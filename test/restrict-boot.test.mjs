/**
 * restrict-boot.test.mjs —— 按真实启动顺序看工具面收窄（issue #61 / #69 之后的回归）
 *
 * 真实启动里三件事的先后是固定的（`lib/index.js` 的 boot）：
 *   ① `registerToolRestrict` 挂上 `agent/created` 监听；
 *   ② `bootstrapHome` 建她的会话——宿主在 `sessionController.create()` 里同步发 `agent/created`；
 *   ③ 最后才在 `withUseDuringRegistration` 里注册她的工具。
 * 所以收窄算 allow 的那一刻，注册记录（`lib/toolreg.js`）一定是空的；她的 agent 建好时，
 * 宿主也还不认识这些名字。
 *
 * 0.9.5 的回归：allow 改成「按注册记录现算」之后，这个顺序下永远退回 `FISH_TOOLS` 基线，
 * 而基线里没有 her_say。于是每次新启动，her_say 既不在下给宿主的 allow 里，守卫也拦它——
 * 身份文档却照样告诉她「你有一个工具 her_say」。`test/toolreg.test.mjs` 先注册、后收窄，
 * 顺序跟真机反过来，测不出来。
 *
 * 这里用真的 `apply()`、假宿主，让 agent/created 在会话建好时发（早于工具注册），
 * 然后看四件事：下给宿主的 allow、提示词里的工具段、守卫放不放行、被挡时她读到的那份清单。
 * 每个用例开头清一次注册记录：一个新进程里它本来就是空的。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/index.js'
import { writeConfig } from '../lib/store.js'
import { normalizeConfig } from '../lib/settings.js'
import { readRestrictState, currentToolSurface } from '../lib/restrict.js'
import { forgetRegisteredTools, SCENE_TOOLS } from '../lib/toolreg.js'

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fish-restrict-boot-'))
  // apply() 会往家谱里记一笔，不隔离就写到真实的 ~/.dsh-fish-homes.json（见 boot.test.mjs）。
  const oldHomes = process.env.DSH_FISH_HOMES
  process.env.DSH_FISH_HOMES = join(root, 'homes.json')
  try {
    return await fn(root)
  } finally {
    if (oldHomes === undefined) delete process.env.DSH_FISH_HOMES
    else process.env.DSH_FISH_HOMES = oldHomes
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

async function waitFor(fn, ms = 8000) {
  const t0 = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - t0 > ms) return v
    await new Promise((r) => setTimeout(r, 20))
  }
}

/**
 * 假宿主。`hostTools` 是宿主自己就有的工具（不是插件注册的）。
 * 她的 agent 的工具表是活的：插件注册了什么，view / restrict 就认什么——
 * 和真宿主一样，名字没登记时 restrict 抛 `names unknown global tool`。
 */
function fakeHost({ hostTools = ['bash', 'read', 'read_image'] } = {}) {
  const tools = new Map() // 插件注册进来的工具
  const listeners = new Map()
  const routes = []
  const workspaces = new Map()
  const host = { tools, routes, sent: [], guardFn: null, createdAt: null }

  const known = () => [...new Set([...hostTools, ...tools.keys()])]
  const agentFor = (cwd, id) => ({
    session: { header: { cwd, id } },
    ctx: {
      effect() {},
      tools: {
        view: () => ({
          restrictableNames: new Set(known()),
          visible: new Map(known().map((n) => [n, {}])),
        }),
        guard: (fn) => { host.guardFn = fn; return () => {} },
        restrict: ({ allow }) => {
          const have = new Set(known())
          const unknown = allow.find((n) => !have.has(n))
          if (unknown) throw new Error(`tools.restrict() names unknown global tool "${unknown}"; known global tools: ${[...have].join(', ')}`)
          host.sent.push([...allow])
          return () => {}
        },
      },
    },
  })

  const registry = {
    list: () => [...workspaces.values()],
    get: (id) => workspaces.get(id) ?? null,
    create: async (path, title) => {
      const w = { id: `ws-${workspaces.size + 1}`, path, title, sessionIds: [] }
      workspaces.set(w.id, w)
      return w
    },
  }

  let seq = 0
  const ctx = {
    tools: { register: (spec) => { tools.set(spec.name, spec); return () => tools.delete(spec.name) } },
    webServer: { register: (r) => { routes.push(r); return () => {} } },
    connection: { requestRejection: () => null },
    sessionController: {
      async create({ workspaceId }) {
        const ws = workspaces.get(workspaceId)
        const id = `ses-${++seq}`
        ws?.sessionIds.unshift(id)
        // 宿主在 create 里同步发 agent/created，早于插件注册工具（index.js 的顺序）。
        host.createdAt = { herSay: tools.has('her_say'), growthCommit: tools.has('growth_commit') }
        for (const fn of listeners.get('agent/created') ?? []) fn({ agent: agentFor(ws?.path ?? '', id) })
        return { sessionId: id }
      },
      async prompt() {},
      async resolveAgent() { return { agent: { followup() {} } } },
    },
    logger: { info() {}, warn() {}, error() {} },
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(fn)
      return () => {}
    },
    get(key) {
      if (key === 'workspaceRegistry') return registry
      return ctx[key]
    },
  }
  return { ctx, host }
}

/** 启动一次，等到收窄真的下给宿主（工具注册完之后的那一拍）。 */
async function bootAndWait(root, opts) {
  forgetRegisteredTools() // 新进程里注册记录本来就是空的
  const { ctx, host } = fakeHost(opts)
  const h = apply(ctx, { root })
  // 2026-11-11（先B后全收窄）：第一拍可能先下一把窄刀（只含当时已登记的名字），
  // 等自家工具全登记上、换完整刀，才算「启动走完」。
  await waitFor(() => host.sent.length > 0 && host.sent.at(-1).includes('her_say'))
  return { h, host }
}

/** 提示词工具段里「现在手边能碰到的是这些：…」那一行列出来的名字。 */
function surfaceNames() {
  const line = currentToolSurface().split('\n')[0] ?? ''
  const m = line.match(/^现在手边能碰到的是这些：(.*)。$/)
  return m ? m[1].split('、') : []
}

test('新启动：她的会话早于工具注册建好，her_say 照样在 allow 里，守卫放行', async () => {
  // 默认配置下主动搭话是关着的：这条同时钉住「开关关着，her_say 也在手边」。
  assert.equal(normalizeConfig({}).proactive.enabled, false, '前提：默认不开主动搭话')
  await withRoot(async (root) => {
    const { h, host } = await bootAndWait(root)
    try {
      assert.ok(host.createdAt, '她的会话没建起来，这条用例没走到真实顺序')
      assert.equal(host.createdAt.herSay, false, '前提：agent/created 发出时 her_say 还没注册')
      assert.equal(host.createdAt.growthCommit, false, '前提：agent/created 发出时她的工具一件都还没注册')
      assert.ok(host.tools.has('her_say'), '启动走完后 her_say 应该注册上了')
      // 2026-11-11（先B后全收窄）：第一拍先按当下认得的下窄刀，登记齐了再换完整刀。
      assert.ok(host.sent.length >= 1, `收窄应该下一次：${JSON.stringify(readRestrictState())}`)

      const sent = host.sent.at(-1)
      assert.ok(sent.includes('her_say'), `下给宿主的 allow 里要有 her_say：${sent.join(',')}`)
      const st = readRestrictState()
      assert.ok(st.allow.includes('her_say'), '配置那份 allow 里也要有')
      assert.ok(st.effective.includes('her_say'), 'effective（真下给宿主的）里也要有')
      assert.ok(surfaceNames().includes('her_say'), `提示词工具段那一行也要有 her_say：${currentToolSurface()}`)

      assert.equal(typeof host.guardFn, 'function', '兜底守卫要挂上')
      assert.equal(host.guardFn({ name: 'her_say', arguments: { text: '嗯' } }), undefined, '守卫不能拦 her_say')

      // 不止 her_say：这一版真注册了的家用工具，冷启动都得够得着（下次再漏一件也会在这里红）。
      for (const name of host.tools.keys()) {
        if (SCENE_TOOLS[name]) {
          assert.ok(!sent.includes(name), `${name} 是场景工具，不进家里的 allow`)
          continue
        }
        assert.ok(sent.includes(name), `${name} 注册了、家里能用，冷启动的 allow 里却没有`)
        assert.equal(host.guardFn({ name, arguments: {} }), undefined, `守卫不该拦 ${name}`)
      }

      // 被挡时她读到的那份清单也要有 her_say，否则她会以为自己没有这样东西。
      const told = host.guardFn({ name: 'bash', arguments: {} })
      assert.equal(typeof told, 'string', '不在名单里的照样要挡')
      assert.ok(told.startsWith('这件事我做不到'), told)
      assert.ok(told.includes('her_say'), `挡回去的那句里列的清单要有 her_say：${told}`)
    } finally {
      h.dispose()
    }
  })
})

test('白名单里有外部名字（宿主有的、没装的）：her_say 照样在 allow 里，守卫放行', async () => {
  await withRoot(async (root) => {
    // web_search 宿主有；qq_send_message 是桥的工具，这台机器上没装。
    await writeConfig(normalizeConfig({ tools: { allow: ['web_search', 'qq_send_message'] } }), root)
    const { h, host } = await bootAndWait(root, { hostTools: ['bash', 'read', 'read_image', 'web_search'] })
    try {
      assert.equal(host.createdAt?.herSay, false, '前提：agent/created 发出时 her_say 还没注册')
      assert.ok(host.sent.length >= 1, `收窄应该下一次：${JSON.stringify(readRestrictState())}`)

      const sent = host.sent.at(-1)
      assert.ok(sent.includes('her_say'), `下给宿主的 allow 里要有 her_say：${sent.join(',')}`)
      assert.ok(sent.includes('web_search'), '宿主有的外部名字要下给宿主')
      assert.ok(!sent.includes('qq_send_message'), '这台机器上没有的外部名字这次剔掉（issue #61）')
      assert.ok(readRestrictState().allow.includes('her_say'))

      assert.equal(host.guardFn({ name: 'her_say', arguments: {} }), undefined, '守卫不能拦 her_say')
      assert.equal(host.guardFn({ name: 'web_search', arguments: {} }), undefined, '白名单里的照样放行')
      const told = host.guardFn({ name: 'bash', arguments: {} })
      assert.ok(String(told).includes('her_say'), `挡回去的那句里列的清单要有 her_say：${told}`)
    } finally {
      h.dispose()
    }
  })
})

test('关着记梦启动：her_dream 照 #64 不给，her_say 不跟着丢', async () => {
  await withRoot(async (root) => {
    await writeConfig(normalizeConfig({ dream: { enabled: false } }), root)
    const { h, host } = await bootAndWait(root)
    try {
      assert.equal(host.createdAt?.herSay, false, '前提：agent/created 发出时 her_say 还没注册')
      assert.ok(host.sent.length >= 1, `收窄应该下一次：${JSON.stringify(readRestrictState())}`)

      const sent = host.sent.at(-1)
      assert.ok(sent.includes('her_say'), `下给宿主的 allow 里要有 her_say：${sent.join(',')}`)
      assert.ok(!sent.includes('her_dream'), '记梦关着，her_dream 不进 allow（issue #64 的取舍）')
      assert.ok(surfaceNames().includes('her_say'), `提示词工具段那一行要有 her_say：${currentToolSurface()}`)
      assert.ok(!surfaceNames().includes('her_dream'), '提示词工具段那一行不该有 her_dream')

      assert.equal(host.guardFn({ name: 'her_say', arguments: {} }), undefined, '守卫不能拦 her_say')
      const told = host.guardFn({ name: 'her_dream', arguments: {} })
      assert.equal(typeof told, 'string', '记梦关着，守卫要挡 her_dream')
      assert.ok(told.startsWith('这件事我做不到'), told)
      assert.ok(told.includes('her_say'), `挡回去的那句里列的清单要有 her_say：${told}`)
    } finally {
      h.dispose()
    }
  })
})
