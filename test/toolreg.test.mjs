/**
 * toolreg.test.mjs —— 「她手边有哪些工具」要现算，不许手抄（2026-11-08，用户 m00002）
 *
 * 为什么值得单独立测：这份清单以前是写死在 `restrict.js` 的 `FISH_TOOLS` 里的。
 * 手抄的表一定会漏，而且漏得很安静——工具在 `index.js` 里注册了，表里没有，
 * 于是她自己那件进不了 allow、设置页那一组不显示、自检也不查它。
 * `bring_back` 与 `her_say` 就是这么漏的：用户看到的是「更新了但界面还是旧那几样」。
 *
 * 所以这里钉四件事：
 *   ① 加工具只改一个地方：注册了就出现，没注册就不出现；
 *   ② 没有注册记录时（测试、或宿主早于注册）退回基线，不能变成空清单；
 *   ③ 场景工具（bring_back）照样列出来、但**不进家里的 allow**——
 *      给她一只在家里永远答「现在没在外面」的手，等于每轮提醒她有件事做不了；
 *   ④ 注册抛错的那次不记账：界面不许显示一只根本不存在的手。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  noteRegisteredTool,
  registeredToolNames,
  forgetRegisteredTools,
  liveFishTools,
  homeFishTools,
  sceneFishTools,
  SCENE_TOOLS,
} from '../lib/toolreg.js'
import { FISH_TOOLS, HER_TOOLS, fishToolsNow, herToolsNow, herSceneToolsNow, registerToolRestrict } from '../lib/restrict.js'
import { withUseDuringRegistration } from '../lib/use.js'
import { defineTool } from '../lib/tool.js'

/** 0.9.x 实际注册的那 13 个（`grep "name: '" lib/*.js` 对着数的）。 */
const ALL_TOOLS = [
  'growth_commit', 'her_recall', 'her_diary', 'her_leave', 'her_note', 'her_appoint',
  'bili_look', 'bili_watch', 'bili_speak', 'ask_owner', 'ask_pronoun', 'her_dream',
  'bring_back', 'her_say',
]

function registerAll() {
  for (const n of ALL_TOOLS) noteRegisteredTool(n)
}

/** 一个够用的假插件 ctx：能 on('agent/created')，也能被我们主动触发。 */
function fakeCtx() {
  const listeners = new Map()
  return {
    on(ev, fn) {
      if (!listeners.has(ev)) listeners.set(ev, [])
      listeners.get(ev).push(fn)
      return () => {}
    },
    emit(ev, payload) {
      for (const fn of listeners.get(ev) ?? []) fn(payload)
    },
  }
}

/** 一个够用的假 agent：cwd 决定它是不是她。 */
function fakeAgent(cwd) {
  const calls = []
  return {
    calls,
    agent: {
      session: { header: { cwd } },
      ctx: {
        tools: {
          restrict: (filter) => { calls.push(filter); return () => {} },
          // 守卫那层这里不用管：本文件只问 allow 里有什么
          guard: () => () => {},
        },
        effect: () => {},
      },
    },
  }
}

test('没注册过就退回基线——清单不能变成空的', () => {
  forgetRegisteredTools()
  assert.deepEqual(registeredToolNames(), [])
  assert.deepEqual(liveFishTools(FISH_TOOLS), [...FISH_TOOLS], '没有注册记录时退回基线')
  assert.deepEqual(fishToolsNow(), [...FISH_TOOLS])
  // 空兜底也不能炸
  assert.deepEqual(liveFishTools(), [])
  assert.deepEqual(homeFishTools(), [])
})

test('注册了什么就出现什么——加工具不用再去改一张表', () => {
  forgetRegisteredTools()
  registerAll()
  const live = fishToolsNow()
  for (const n of ALL_TOOLS) assert.ok(live.includes(n), `注册了 ${n}，清单里就该有`)
  assert.equal(live.length, ALL_TOOLS.length, '不多不少，正好是注册过的那几个')
  // 基线 FISH_TOOLS 里的仍然都在（新清单是超集，不是替换）
  for (const n of FISH_TOOLS) assert.ok(live.includes(n), `老工具 ${n} 不能因为改成现算就丢了`)
})

test('bring_back 是场景工具：列出来，但不进家里的工具面', () => {
  forgetRegisteredTools()
  registerAll()
  assert.ok(SCENE_TOOLS.bring_back, 'bring_back 必须在 SCENE_TOOLS 里登记，否则会被当成家里随时可用的')
  assert.ok(String(SCENE_TOOLS.bring_back.why).length > 0, '场景工具要带一句场合说明，界面上要念给用户听')

  const home = homeFishTools(FISH_TOOLS)
  assert.ok(!home.includes('bring_back'), '家里不该有它：在家调用只会答「现在没在外面。」')

  const scene = herSceneToolsNow()
  assert.deepEqual(scene.map((t) => t.name), ['bring_back'])
  assert.equal(scene[0].scene, 'outing')
  assert.ok(scene[0].why.includes('出门'), '场合说明要写清是什么场合')

  // 白名单那组（家里随时能用的 + read_image）不该混进场景工具
  const hers = herToolsNow()
  assert.ok(hers.includes('read_image'), '宿主给的 read_image 要留着')
  assert.ok(hers.includes('her_say'), 'her_say 家里能用，要在「她自己本来就有的」那组里')
  assert.ok(!hers.includes('bring_back'), '场景工具单列一组，别混进「不用放行」那组')
})

test('her_say 不再看主动搭话的开关——只要注册了就在手边', () => {
  forgetRegisteredTools()
  registerAll()
  const ctx = fakeCtx()
  // registerToolRestrict 不收主动搭话的开关（原来那个 proactive 参数没人读，已经删了），
  // allow 里照样要有 her_say：那个开关管的是「系统替她开一轮」，不是这个工具本身。
  registerToolRestrict(ctx, { herDir: 'C:\\her-home', log: () => {} })
  const hers = fakeAgent('C:\\her-home')
  ctx.emit('agent/created', { agent: hers.agent })

  assert.equal(hers.calls.length, 1, '她这条应该被收窄一次')
  const allow = hers.calls[0].allow
  assert.ok(allow.includes('her_say'), '不管主动搭话开没开，她都得能开口（设置页文案就是这么写的）')
  assert.ok(!allow.includes('bring_back'), '出门工具不许进家里的 allow')
  for (const n of FISH_TOOLS.filter((x) => x !== 'her_dream')) {
    assert.ok(allow.includes(n), `${n} 是家里随时能用的，得在 allow 里`)
  }
})

// 没有注册记录不是边角情况，是生产上的常态：index.js 先收窄、后注册工具，
// 收窄算 allow 的那一刻记录一定是空的（真实启动顺序见 test/restrict-boot.test.mjs）。
// 0.9.5 这里断言的是「不含 her_say 的 HER_TOOLS」——把每次重启都够不着 her_say 当成了正确答案。
test('没有注册记录时（收窄先于工具注册）allow 照基线算，her_say 也在里面', () => {
  forgetRegisteredTools()
  const ctx = fakeCtx()
  registerToolRestrict(ctx, { herDir: 'C:\\h', log: () => {} })
  const hers = fakeAgent('C:\\h')
  ctx.emit('agent/created', { agent: hers.agent })
  const allow = hers.calls[0].allow
  assert.ok(allow.includes('her_say'), `重启后第一拍她就得够得着 her_say：${allow.join(',')}`)
  assert.ok(!allow.includes('bring_back'), '出门工具不许进家里的 allow')
  assert.deepEqual(allow, HER_TOOLS.filter((n) => n !== 'her_dream'))
})

test('注册期记账由 withUseDuringRegistration 顺手做掉，注册失败的不记', () => {
  forgetRegisteredTools()
  const registered = []
  const ctx = {
    tools: {
      register: (def) => {
        if (def?.name === 'boom_tool') throw new Error('registry 拒了')
        registered.push(def?.name)
        return { ok: true }
      },
    },
  }
  withUseDuringRegistration(ctx, 'D:\\root', () => {
    ctx.tools.register(defineTool({ name: 'her_say', execute: async () => 'ok' }))
    ctx.tools.register(defineTool({ name: 'growth_commit', execute: async () => 'ok' }))
    assert.throws(
      () => ctx.tools.register(defineTool({ name: 'boom_tool', execute: async () => 'ok' })),
      /registry 拒了/,
    )
  })
  // 兜底路径只能按「定义时」记账（2026-11-10 起不再替换 ctx.tools.register）：
  // 注册紧跟着同步发生，真被 registry 拒掉的那一条也会记上——清单是给自己看的自检，
  // 宁可多一个名字，也不能为了「成功后记」再去动共享的 tools 服务。
  assert.deepEqual(registeredToolNames().sort(), ['boom_tool', 'growth_commit', 'her_say'])
  assert.deepEqual(registered, ['her_say', 'growth_commit'], '真正下发过的仍是这两条')
  // 包一层不许改变原行为：返回值照旧透传、原 register 要换回去
  assert.equal(typeof ctx.tools.register, 'function')
})

test('设置页跟着现算：场景工具单列一组，文案里不再手抄工具名', async () => {
  const { readFile } = await import('node:fs/promises')
  const src = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

  // ① /tools 的新字段要真的落地到 state，否则服务端算得再对，界面还是旧的。
  assert.match(src, /setToolsHerScene\(Array\.isArray\(r\.herSceneTools\)/, '/tools 的 herSceneTools 要填进 state')
  // ② 场景工具要有自己那一组，且是只读的（不用放行）。
  assert.ok(src.includes('只在特定场合才给她的（不用放行）'), '场景工具要单独一组摆出来')
  assert.ok(src.includes("toolChip(t.name, 'scene')"), '场景工具走 scene 那种 chip')
  // ③ 那段讲「她手边有什么」的文案不许再手抄名字——抄一次就会漏一次。
  assert.ok(
    !src.includes('记录想法、翻自己的旧事、翻自己的日记'),
    '工具名清单要由 herList 现算，不许再手抄一份',
  )
  // PR #59 G2：这段文案改成讲收窄的作用，不再逐个抄工具名——原来的手抄清单和
  // 「此刻 N 个：a、b、c」都随之下线，所以改为钉「不再手抄」这个事实。
  assert.ok(!src.includes('此刻 ${herList.length} 个'), '不再把此刻的工具名一个个抄进文案')
  assert.ok(src.includes('收窄开着时，她在家里的会话只能用自己的工具和白名单里的'), '文案改成讲收窄的作用')
})
