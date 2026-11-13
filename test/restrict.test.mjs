/**
 * restrict.test.mjs —— 工具面收窄（2026-10-24）
 *
 * 为什么值得单独立测：这件事的全部价值在于「她真的看不见那 31 个工具」。
 * 一旦哪天宿主的 `restrict()` 改了签名、或者我们的名字写错一个字母，
 * 它会**静默失效**——她照样能看到 shell 和写文件，而我们以为收窄了。
 * 所以这里钉三件事：
 *   ① 清单里每个名字都必须是真实存在的工具（名字错＝当场抛错，不是悄悄地过）；
 *   ② 只对「她的屋子」那一个 agent 下手，别人的会话一个都不碰；
 *   ③ 结论必须分开报「注册了」与「真挂上了」，不许合并成一句“成功”。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { HER_TOOLS, currentToolSurface, currentAllowTools, isHerAgent, knownToolNames, ownLayerNames, registerToolRestrict, rememberFromView, rememberKnownTools, readRestrictState, describeRestrict, toolSurfaceText, toolSurfaceFor, outsideSurfaceText, visibleToolsOf, foldedRecallNote, blockedTools, forgetBlockedTools, recheckToolRestrict } from '../lib/restrict.js'
import * as restrictMod from '../lib/restrict.js'
import { wishesOf } from '../lib/wish.js'

/** 一个够用的假插件 ctx：能 on('agent/created')，也能被我们主动触发。 */
function fakeCtx() {
  const listeners = new Map()
  return {
    on(ev, fn) {
      if (!listeners.has(ev)) listeners.set(ev, [])
      listeners.get(ev).push(fn)
      return () => {
        const arr = listeners.get(ev) ?? []
        const i = arr.indexOf(fn)
        if (i >= 0) arr.splice(i, 1)
      }
    },
    emit(ev, payload) {
      for (const fn of listeners.get(ev) ?? []) fn(payload)
    },
    count(ev) {
      return (listeners.get(ev) ?? []).length
    },
  }
}

/** 一个够用的假 agent：cwd 决定它是不是她。 */
function fakeAgent(cwd, { withRestrict = true, withGuard = true } = {}) {
  const calls = []
  const tools = {}
  if (withRestrict) {
    tools.restrict = (filter) => {
      calls.push(filter)
      return () => {}
    }
  }
  if (withGuard) {
    // guard 接一个同步函数，返回 undefined = 放行、返回字符串 = 拒绝（这是宿主的契约）
    tools.guard = (fn) => {
      guards.push(fn)
      return () => {}
    }
  }
  const guards = []
  return {
    calls,
    guards,
    agent: {
      session: { header: { cwd } },
      ctx: { tools, effect: () => {} },
    },
  }
}

test('清单里她该有的工具都在，且不含危险口子', () => {
  // 十个是她自己的（0.7.6 加了 ask_owner，0.8.9 补 her_note，0.9.7 补 her_appoint），外加 read_image。
  // 定时工具默认不放（m04504），要放由用户自己加白名单——这里不许出现。
  for (const name of ['growth_commit', 'her_recall', 'her_diary', 'her_leave', 'her_note', 'her_appoint', 'bili_look', 'bili_watch', 'bili_speak', 'ask_owner', 'read_image']) {
    assert.ok(HER_TOOLS.includes(name), `清单里少了 ${name}`)
  }
  // 这几个一旦放进去，收窄就白做了
  for (const name of ['pwsh', 'bash', 'write', 'edit', 'web_search', 'web_fetch', 'skill', 'subagent', 'workflow']) {
    assert.ok(!HER_TOOLS.includes(name), `清单里不该有 ${name}`)
    assert.ok(!HER_TOOLS.includes(name), `清单里不该有 ${name}`)
  }
  for (const name of ['schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete']) {
    assert.ok(!HER_TOOLS.includes(name), `${name} 默认不放：谁想用，自己加白名单`)
  }
})

test('isHerAgent 只认她的屋子，不认别的目录', () => {
  const her = 'C:\\Users\\someone\\.dsh-fish\\home'
  assert.equal(isHerAgent({ session: { header: { cwd: her } } }, her), true)
  // 末尾斜杠不该影响判断（任何平台）
  assert.equal(isHerAgent({ session: { header: { cwd: `${her}\\` } } }, her), true)
  // 大小写不敏感是 Windows 文件系统的性质，macOS/Linux 区分大小写，别在那边硬要求
  if (process.platform === 'win32') {
    assert.equal(isHerAgent({ session: { header: { cwd: 'c:/users/someone/.dsh-fish/home/' } } }, her), true)
  }
  assert.equal(isHerAgent({ session: { header: { cwd: 'D:\\work\\my-project' } } }, her), false)
  // 拿不到 cwd 时一律不放行（宁可漏收窄，也不误伤别人的会话）
  assert.equal(isHerAgent({}, her), false)
  assert.equal(isHerAgent({ session: {} }, her), false)
})

test('只有她的 agent 被收窄，别人的会话一个都不碰', () => {
  const ctx = fakeCtx()
  registerToolRestrict(ctx, { herDir: 'C:\\her-home', log: () => {} })

  const hers = fakeAgent('C:\\her-home')
  const mine = fakeAgent('D:\\work\\my-project')

  ctx.emit('agent/created', { agent: mine.agent })
  assert.equal(mine.calls.length, 0, '别人的会话不该被限制')

  ctx.emit('agent/created', { agent: hers.agent })
  assert.equal(hers.calls.length, 1, '她这条应该被限制一次')
  assert.deepEqual(hers.calls[0].allow, HER_TOOLS.filter((n) => n !== 'her_dream'), '只写 allow，不在清单里的一律挡掉；her_dream 是 .dev 下才加的工具')
  assert.equal(hers.calls[0].deny, undefined, '不用 deny：宿主将来新增工具时 allow 会自动挡住它')
})

test('额外放行会并进 allow，且去重', () => {
  const ctx = fakeCtx()
  registerToolRestrict(ctx, { herDir: 'C:\\h', extra: ['web_search', 'web_search', ' read_image '], log: () => {} })
  const hers = fakeAgent('C:\\h')
  ctx.emit('agent/created', { agent: hers.agent })
  const allow = hers.calls[0].allow
  assert.ok(allow.includes('web_search'), '用户填的额外放行要生效')
  assert.equal(allow.filter((x) => x === 'web_search').length, 1, '同一名字不许重复')
  assert.equal(allow.filter((x) => x === 'read_image').length, 1, '原本就在清单里的不该被重复追加')
})

test('挂上了才算数：结论里 applied 必须 > 0', () => {
  const ctx = fakeCtx()
  let seen = null
  registerToolRestrict(ctx, { herDir: 'C:\\h', onResult: (r) => { seen = r }, log: () => {} })
  // 注册阶段：还没轮到任何 agent，不能说"已收窄"
  assert.equal(seen.applied, 0)
  assert.equal(seen.why, 'registered')

  ctx.emit('agent/created', { agent: fakeAgent('C:\\h').agent })
  assert.equal(seen.applied, 1, '真挂上之后 applied 要变成 1')
  assert.equal(seen.why, 'applied')
  assert.equal(seen.failed, '')
})

test('宿主不认 restrict 时必须报红，不许静默降级成“全部工具”', () => {
  const ctx = fakeCtx()
  let seen = null
  registerToolRestrict(ctx, { herDir: 'C:\\h', onResult: (r) => { seen = r }, log: () => {} })

  // 没有 restrict 方法的老版本宿主
  ctx.emit('agent/created', { agent: fakeAgent('C:\\h', { withRestrict: false }).agent })
  assert.equal(seen.ok, false)
  assert.match(seen.failed, /restrict/)
})

test('restrict 抛错（名字不存在/作用域不对）不会硬清空工具面：先延后、最终如实报 deferred', async () => {
  const ctx = fakeCtx()
  let seen = null
  registerToolRestrict(ctx, { herDir: 'C:\\h', onResult: (r) => { seen = r }, log: () => {}, retryMs: 5, retryMax: 2 })

  const bad = fakeAgent('C:\\h')
  bad.agent.ctx.tools.restrict = () => { throw new Error('unknown tool: growth_commit') }
  ctx.emit('agent/created', { agent: bad.agent })

  // 0.6.1 起：restrict 抛错不再进「失败」也不按交集硬收，而是先挂着 guard、延后重试。
  assert.equal(seen.why, 'registered', '注册阶段的回执')
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(seen.why, 'deferred', '一直收不上就如实报 deferred，不能假装成功')
  assert.equal(seen.applied, 0)
  assert.equal(bad.guards.length, 1, '兜底守卫必须已经挂上')
})

test('关掉开关就不收窄：一件工具都不动，只认下她这一局的 agent（2026-11-09 起）', () => {
  const ctx = fakeCtx()
  const off = registerToolRestrict(ctx, { herDir: 'C:\\h', enabled: false, log: () => {} })
  assert.equal(typeof off, 'function')
  assert.equal(readRestrictState().why, 'disabled')

  // 收窄关着也要认得她：心事卡问「到手没有」不走白名单，直接看她这一局真看得见的工具
  // （`visibleAllowTools()`，#58 的遗留）。除此之外什么都不做——不调 restrict、不挂兜底守卫。
  const a = fakeAgent('C:\\h')
  ctx.emit('agent/created', { agent: a.agent })
  assert.equal(a.calls.length, 0, '关掉时不收窄')
  assert.equal(a.guards.length, 0, '关掉时不挂兜底守卫')
  off()
  assert.equal(ctx.count('agent/created'), 0, '退订以后不再留监听')
})

/**
 * 带工具表的假 agent（issue #58）。`restrictable` 是宿主收得窄的那层，`own` 是 own 层
 * （看得见、点不了名）。两个都是活的 Set：测试里往里加名字，就是宿主那边晚注册了一个工具。
 * `view` 每次现读；下过 restrict 以后，收得窄的那层只剩名单里的（宿主就是这么掩码的），
 * own 层不受影响。
 */
function hostAgent(cwd, { sid = '', restrictable = [], own = [], restrict } = {}) {
  const r = new Set(restrictable)
  const o = new Set(own)
  const sent = []
  let mask = null
  const agent = {
    session: { header: { cwd, ...(sid ? { id: sid } : {}) } },
    ctx: {
      effect: () => {},
      tools: {
        view: (scope) => scope === agent
          ? { restrictableNames: new Set(r), visible: new Map([...[...r].filter((n) => !mask || mask.has(n)), ...o].map((n) => [n, {}])) }
          : { restrictableNames: new Set() },
        restrict: restrict ?? (({ allow }) => { sent.push(allow); mask = new Set(allow); return () => { mask = null } }),
        guard: () => () => {},
      },
    },
  }
  return { agent, restrictable: r, own: o, sent }
}

async function until(cond, what) {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5))
  assert.ok(cond(), what)
}

test('currentAllowTools：关着是「不知道」；开着也要等见到她的 agent 才答得上（issue #58）', () => {
  const ctx = fakeCtx()
  registerToolRestrict(ctx, { herDir: 'C:\\h', enabled: false, log: () => {} })
  assert.equal(currentAllowTools(), null, '关着时她能看见全部工具，不能拿空清单去过滤')
  assert.equal(restrictMod.configuredAllowTools(), null)
  registerToolRestrict(ctx, { herDir: 'C:\\h', extra: ['web_search'], log: () => {} })
  assert.equal(currentAllowTools(), null, '她的 agent 还没见到：白名单里写了不等于手上有')
  assert.ok(restrictMod.configuredAllowTools().includes('web_search'), '配置里的那份照样给得出（只当临时答案用）')
  ctx.emit('agent/created', { agent: hostAgent('C:\\h', { restrictable: [...HER_TOOLS, 'web_search'] }).agent })
  const allow = currentAllowTools()
  assert.ok(Array.isArray(allow), '见到她的 agent 了就要给得出这份清单')
  assert.ok(allow.includes('bili_look'))
  assert.ok(allow.includes('web_search'))

  // 宿主给不出工具表：还是「不知道」，不能当成「一件都没有」
  ctx.emit('agent/created', { agent: fakeAgent('C:\\h').agent })
  assert.equal(currentAllowTools(), null)

  // 重新注册（插件重载）：之前记下的 agent 不是这一次的守卫管的，不替它们担保
  ctx.emit('agent/created', { agent: hostAgent('C:\\h', { restrictable: [...HER_TOOLS, 'web_search'] }).agent })
  assert.ok(currentAllowTools())
  registerToolRestrict(fakeCtx(), { herDir: 'C:\\h', extra: ['web_search'], log: () => {} })
  assert.equal(currentAllowTools(), null)
})

test('「已经到手」只算这台机器上真有的：白名单里写了、宿主上没有的不算（issue #58）', () => {
  // 0.9.5：注册时就把配置里的 allow 当成「到手」。宿主上没有的 read_image、白名单里写了
  // 却没装上的 image_gen 都算了进去——她要它们的那张卡一开就从桌上撤掉了。
  const ctx = fakeCtx()
  const host = HER_TOOLS.filter((n) => n !== 'read_image')
  registerToolRestrict(ctx, { herDir: 'C:\\h', extra: ['image_gen', 'ops_bash', 'web_search'], log: () => {} })
  assert.equal(currentAllowTools(), null, '她的 agent 还没建好：不知道')

  const first = hostAgent('C:\\h', { restrictable: [...host, 'web_search'], own: ['ops_bash'] })
  ctx.emit('agent/created', { agent: first.agent })
  assert.ok(!first.sent[0].includes('read_image'), '前提：read_image 没下给宿主')
  const has = currentAllowTools()
  assert.ok(has.includes('bili_look'))
  assert.ok(has.includes('web_search'), '白名单里有、宿主上也有：到手了')
  assert.ok(has.includes('ops_bash'), 'own 层看得见、守卫放行：也算到手')
  assert.ok(!has.includes('read_image'), '宿主上没有 read_image：不算到手')
  assert.ok(!has.includes('image_gen'), '白名单里写了、没装上：不算到手')

  // 别人的会话不动她的账
  ctx.emit('agent/created', { agent: hostAgent('C:\\other', { restrictable: [...HER_TOOLS, 'image_gen'] }).agent })
  assert.deepEqual(currentAllowTools(), has)

  // 换了一条会话，这回宿主有 read_image 和 image_gen 了：按新的这个现算，不沿用上一份
  ctx.emit('agent/created', { agent: hostAgent('C:\\h', { restrictable: [...HER_TOOLS, 'image_gen', 'web_search'] }).agent })
  assert.ok(currentAllowTools().includes('read_image'))
  assert.ok(currentAllowTools().includes('image_gen'))
  assert.ok(!currentAllowTools().includes('ops_bash'), '这条会话上没有 ops_bash 了')
})

test('own 层工具在她的 agent 建好以后才挂上：查的那一刻看得见就算到手（issue #58）', () => {
  // dsh-ops 是 attach 时才 publish ops_*：agent/created 那一刻的工具表里还没有它。
  // 白名单放行、她看得见、守卫也放——这时还摆「他答应了，还没见到」就又是 #58。
  const ctx = fakeCtx()
  registerToolRestrict(ctx, { herDir: 'C:\\h', extra: ['ops_bash'], log: () => {} })
  const her = hostAgent('C:\\h', { restrictable: HER_TOOLS })
  ctx.emit('agent/created', { agent: her.agent })
  assert.ok(!currentAllowTools().includes('ops_bash'), '还没挂上：不算')
  her.own.add('ops_bash')
  assert.ok(currentAllowTools().includes('ops_bash'), '挂上了：算到手')

  const now = Date.now()
  const events = [
    { id: 'a1', type: 'ask', ts: new Date(now - 3_600_000).toISOString(), text: '想要一个能跑命令的工具', ask: { kind: 'need-tool', subject: 'ops_bash', options: ['可以', '以后再说'] } },
    { id: 'a2', type: 'answer', ts: new Date(now - 1_800_000).toISOString(), text: '可以', answer: { askId: 'a1', verdict: 'approve' } },
  ]
  assert.equal(wishesOf(events, { now }).length, 1, '前提：不传 has 时这张卡在桌上')
  assert.equal(wishesOf(events, { now, has: new Set(currentAllowTools()) }).length, 0, '答应过、已经到手：不再摆')
})

test('收窄下去以后才注册的宿主工具：被掩掉了，她够不着，不算到手（issue #58）', () => {
  // issue #61 的那种时序：read_image 晚到，收窄已经按没有它的名单下去了——
  // 这一局她调它是 unknown tool。宿主表里有它，可她手上没有。
  const ctx = fakeCtx()
  registerToolRestrict(ctx, { herDir: 'C:\\h', log: () => {} })
  const her = hostAgent('C:\\h', { restrictable: HER_TOOLS.filter((n) => n !== 'read_image') })
  ctx.emit('agent/created', { agent: her.agent })
  her.restrictable.add('read_image')
  assert.ok(!currentAllowTools().includes('read_image'))
  assert.ok(currentAllowTools().includes('bili_look'))
})

test('自家工具晚到、重试后才收窄（applied-late）：前后都按她此刻的工具表算，没装上的不算（issue #58）', async () => {
  const ctx = fakeCtx()
  const seen = []
  registerToolRestrict(ctx, { herDir: 'C:\\h', extra: ['image_gen', 'web_search'], log: () => {}, onResult: (r) => seen.push(r), retryMs: 1, retryMax: 400 })
  // her_recall 还没登记（自家的名字没到齐 ⇒ 先不收窄、过一会儿再试）；read_image、image_gen 这台机器上没有
  const host = HER_TOOLS.filter((n) => n !== 'read_image' && n !== 'her_recall')
  const her = hostAgent('C:\\h', { restrictable: [...host, 'web_search'] })
  ctx.emit('agent/created', { agent: her.agent })
  assert.equal(her.sent.length, 1, '名字没齐：先下一把窄刀（0.9.8 的 B 方案）')
  assert.ok(!her.sent[0].includes('her_recall'), '还没登记的名字先不塞进窄刀')
  assert.ok(her.sent[0].includes('web_search'), '已经有的先给她，别让桌子一直全开')
  let has = currentAllowTools()
  assert.ok(has.includes('web_search'), '重试期间宿主有的她都看得见，守卫放白名单：到手')
  assert.ok(!has.includes('her_recall'), '还没登记的不算')

  her.restrictable.add('her_recall')
  await until(() => seen.at(-1)?.why === 'applied-late', '登记齐了要收窄下去')
  assert.ok(!her.sent.at(-1).includes('read_image'))
  has = currentAllowTools()
  assert.ok(has.includes('her_recall'))
  assert.ok(has.includes('web_search'))
  assert.ok(!has.includes('read_image'), '这台机器上没有：不算')
  assert.ok(!has.includes('image_gen'), '白名单里写了、没装上：不算')
})

test('换了一个她（还在重试）：按新的这个算，不沿用上一个收窄好了的（issue #58）', () => {
  const ctx = fakeCtx()
  registerToolRestrict(ctx, { herDir: 'C:\\h', extra: ['web_search'], log: () => {}, retryMs: 1, retryMax: 1 })
  ctx.emit('agent/created', { agent: hostAgent('C:\\h', { restrictable: [...HER_TOOLS, 'web_search'] }).agent })
  assert.ok(currentAllowTools().includes('web_search'))
  // 新会话：自家名字还没到齐（进重试），web_search 这回也没有
  const b = hostAgent('C:\\h', { restrictable: HER_TOOLS.filter((n) => n !== 'her_recall') })
  ctx.emit('agent/created', { agent: b.agent })
  assert.equal(b.sent.length, 1, 'B 还在等名字齐：先下窄刀')
  assert.ok(!b.sent[0].includes('her_recall'), '还没登记的先不塞进窄刀')
  assert.ok(!currentAllowTools().includes('web_search'), 'B 手上没有 web_search')
  assert.ok(!currentAllowTools().includes('her_recall'))
})

test('她同时住着好几条会话：按指定那条的工具表算，群房后建也不顶掉家里那条（issue #58）', () => {
  const ctx = fakeCtx()
  registerToolRestrict(ctx, { herDir: 'C:\\h', extra: ['web_search', 'ops_bash'], log: () => {} })
  ctx.emit('agent/created', { agent: hostAgent('C:\\h', { sid: 's-home', restrictable: [...HER_TOOLS, 'web_search'], own: ['ops_bash'] }).agent })
  // 群房：cwd 一样也是她，但不带家里的 preset，工具表不一样
  ctx.emit('agent/created', { agent: hostAgent('C:\\h', { sid: 's-room', restrictable: HER_TOOLS }).agent })
  assert.ok(currentAllowTools('s-home').includes('web_search'))
  assert.ok(currentAllowTools('s-home').includes('ops_bash'))
  assert.ok(!currentAllowTools('s-room').includes('web_search'))
  assert.ok(!currentAllowTools().includes('ops_bash'), '不指定就按最近建的那个')
  // 家里那条冷着、群房活着时，退回「最近建的那个」拿到的是群房的工具表
  assert.equal(currentAllowTools('s-cold'), null, '指定的那条还没见到：不知道，不拿别的房顶')
})

test('会话 id 带不带 session- 前缀，认的是同一条（issue #58）', () => {
  // 宿主两处给的 id 写法不一定一样（identity.js 的 wakeKey 同一个理由）。对不上的话每次都查不到家里那条。
  const ctx = fakeCtx()
  registerToolRestrict(ctx, { herDir: 'C:\\h', extra: ['image_gen'], log: () => {} })
  ctx.emit('agent/created', { agent: hostAgent('C:\\h', { sid: 'session-s1', restrictable: HER_TOOLS }).agent })
  ctx.emit('agent/created', { agent: hostAgent('C:\\h', { sid: 'session-g1', restrictable: HER_TOOLS, own: ['image_gen'] }).agent })
  for (const sid of ['s1', 'session-s1']) {
    const has = currentAllowTools(sid)
    assert.ok(Array.isArray(has), `${sid} 要认得出`)
    assert.ok(has.includes('bili_look'))
    assert.ok(!has.includes('image_gen'), `${sid}：家里没有 image_gen，不能按群房算`)
  }
  assert.ok(currentAllowTools('g1').includes('image_gen'))
  // 反过来：头里不带前缀，问的时候带
  ctx.emit('agent/created', { agent: hostAgent('C:\\h', { sid: 's2', restrictable: HER_TOOLS, own: ['image_gen'] }).agent })
  assert.ok(currentAllowTools('session-s2').includes('image_gen'))
})

test('群房一多：常问的那条不先被挤掉；真挤掉了是不知道；探活交回来的 agent 照样认（issue #58）', () => {
  const ctx = fakeCtx()
  registerToolRestrict(ctx, { herDir: 'C:\\h', extra: ['web_search', 'image_gen'], log: () => {} })
  const home = hostAgent('C:\\h', { sid: 's-home', restrictable: [...HER_TOOLS, 'web_search'] })
  ctx.emit('agent/created', { agent: home.agent })
  const rooms = [] // 留着引用：群房都还活着，淘汰只能按先后
  const room = (i) => {
    const r = hostAgent('C:\\h', { sid: `s-room${i}`, restrictable: HER_TOOLS, own: ['image_gen'] })
    rooms.push(r)
    ctx.emit('agent/created', { agent: r.agent })
  }
  for (let i = 0; i < 15; i++) room(i)
  assert.ok(currentAllowTools('s-home').includes('web_search'))
  for (let i = 15; i < 20; i++) room(i)
  assert.ok(currentAllowTools('s-home')?.includes('web_search'), '家里那条刚问过，排在后面，不先被挤掉')
  for (let i = 20; i < 40; i++) room(i)
  assert.equal(rooms.length, 40)
  assert.equal(currentAllowTools('s-home'), null, '真被挤掉了：不知道，不拿群房顶')
  // 叫醒、主动回合探活时宿主把那条会话的 agent 交回来：是这一次见过的她，直接按它算
  const has = currentAllowTools('s-home', { agent: home.agent })
  assert.ok(has.includes('web_search'))
  assert.ok(!has.includes('image_gen'))
  // 不是这一次见过的（别人的会话）：不替它担保
  const stranger = hostAgent('C:\\other', { sid: 's-x', restrictable: [...HER_TOOLS, 'image_gen'] })
  ctx.emit('agent/created', { agent: stranger.agent })
  assert.equal(currentAllowTools('s-x', { agent: stranger.agent }), null)
  assert.equal(currentAllowTools('', { agent: stranger.agent }), null, '给了 agent 又不认得：不退回最近建的那个')
})

test('重新注册以后：之前的她探活交回来也不替她担保，等下一个她建出来（issue #58）', () => {
  // 那个 agent 身上挂的是上一次注册下的守卫与收窄；这一份白名单新加的 own 层名字，旧守卫照样拦。
  const ctx = fakeCtx()
  registerToolRestrict(ctx, { herDir: 'C:\\h', extra: ['web_search'], log: () => {} })
  const old = hostAgent('C:\\h', { sid: 's1', restrictable: [...HER_TOOLS, 'web_search'], own: ['ops_bash'] })
  ctx.emit('agent/created', { agent: old.agent })
  assert.ok(currentAllowTools('s1', { agent: old.agent }).includes('web_search'))
  assert.ok(!currentAllowTools('s1', { agent: old.agent }).includes('ops_bash'), '前提：上一份白名单没放 ops_bash')
  const ctx2 = fakeCtx()
  registerToolRestrict(ctx2, { herDir: 'C:\\h', extra: ['web_search', 'ops_bash'], log: () => {} })
  assert.equal(currentAllowTools('s1', { agent: old.agent }), null, '旧守卫还拦着 ops_bash：说不准，宁可多摆')
  assert.equal(currentAllowTools('s1'), null)
  const fresh = hostAgent('C:\\h', { sid: 's1', restrictable: [...HER_TOOLS, 'web_search'], own: ['ops_bash'] })
  ctx2.emit('agent/created', { agent: fresh.agent })
  assert.ok(currentAllowTools('s1').includes('ops_bash'), '新的她归这一次的守卫管：答得上')
})

test('收窄一直没挂上（deferred）：到手的是宿主有、守卫放行的那部分（issue #58）', async () => {
  const ctx = fakeCtx()
  const seen = []
  const host = HER_TOOLS.filter((n) => n !== 'read_image')
  registerToolRestrict(ctx, { herDir: 'C:\\h', extra: ['image_gen', 'web_search'], log: () => {}, onResult: (r) => seen.push(r), retryMs: 1, retryMax: 2 })
  const restrict = () => { throw new Error('tools.restrict() names unknown global tool "growth_commit"') }
  ctx.emit('agent/created', { agent: hostAgent('C:\\h', { restrictable: [...host, 'web_search'], restrict }).agent })
  // 还在重试：收窄没下去，宿主有的她都看得见，守卫放白名单——此刻就答得上，不用等
  const during = currentAllowTools()
  assert.ok(during.includes('web_search'))
  assert.ok(!during.includes('read_image'))
  for (let i = 0; i < 100 && seen.at(-1)?.why !== 'deferred'; i++) await new Promise((r) => setTimeout(r, 5))
  assert.equal(seen.at(-1)?.why, 'deferred')
  const has = currentAllowTools()
  assert.ok(has.includes('web_search'), '没收窄，宿主有、白名单也放行：到手了')
  assert.ok(has.includes('bili_look'))
  assert.ok(!has.includes('read_image'), '宿主上没有：不算')
  assert.ok(!has.includes('image_gen'), '宿主上没有：不算')
})

test('describeRestrict 的三种说法不能混', () => {
  assert.match(describeRestrict({ applied: 1 }), /已收窄/)
  assert.match(describeRestrict({ applied: 0 }), /等她的会话下一次启动/)
  assert.match(describeRestrict({ applied: 0, failed: 'requires a scoped context' }), /没挂上/)
  assert.doesNotMatch(describeRestrict({ applied: 0, failed: 'requires a scoped context' }), /已收窄/)
})

// ---------------------------------------------------------------------------
// 兜底守卫（guard）
//
// 为什么单独测：restrict 挡不住「注册在 agent 自己作用域里」的工具——宿主源码里
// own 层不经过 admits()。实测漏出来的就是 `subagent`，她可以借它派生一个拥有
// 全部工具的子 agent，等于一条现成的逃生通道。所以必须有一道 guard 在**执行时**拦。
// ---------------------------------------------------------------------------

test('guard 会拦住名单外的工具，放行名单内的', () => {
  const ctx = fakeCtx()
  registerToolRestrict(ctx, { herDir: 'C:\\h', log: () => {} })
  const a = fakeAgent('C:\\h')
  ctx.emit('agent/created', { agent: a.agent })

  assert.equal(a.guards.length, 1, '应该挂了一道 guard')
  const guard = a.guards[0]

  // 名单内：返回 undefined = 放行
  assert.equal(guard({ name: 'growth_commit' }), undefined)
  assert.equal(guard({ name: 'read_image' }), undefined)

  // 名单外：返回一句拒绝（不能是 undefined，也不能是 true）
  const denied = guard({ name: 'subagent' })
  assert.equal(typeof denied, 'string')
  assert.ok(denied.length > 0)

  // 拒绝话术里不许出现系统词汇——她要以为是自己做不了，不是以为被管理员拦了
  assert.doesNotMatch(denied, /权限|禁止|违规|不允许|没有授权/)
})

test('她自己 scope 里的工具挡不住这件事必须被记下（guard 缺席也不能算失败）', () => {
  const ctx = fakeCtx()
  let seen = null
  registerToolRestrict(ctx, { herDir: 'C:\\h', onResult: (r) => { seen = r }, log: () => {} })

  // 老宿主：有 restrict、没有 guard
  ctx.emit('agent/created', { agent: fakeAgent('C:\\h', { withGuard: false }).agent })

  assert.equal(seen.why, 'applied', 'restrict 挂上就是挂上了，不能因为缺 guard 就说没生效')
  assert.equal(seen.applied, 1)
  assert.equal(seen.guard, false, '但要如实记下没有兜底守卫')
})

test('guard 自己抛错也不许把 restrict 判成失败', () => {
  const ctx = fakeCtx()
  let seen = null
  registerToolRestrict(ctx, { herDir: 'C:\\h', onResult: (r) => { seen = r }, log: () => {} })

  const a = fakeAgent('C:\\h')
  a.agent.ctx.tools.guard = () => { throw new Error('guard not supported in this scope') }
  ctx.emit('agent/created', { agent: a.agent })

  assert.equal(seen.why, 'applied')
  assert.equal(seen.applied, 1)
  assert.equal(seen.guard, false)
})

test('restrict 因「名字还没登记」抛错时：先不收窄，等登记齐了再收（0.6.1）', async () => {
  // 2026-10-27 另一台真机（0.6.0）：宿主还没登记她的 6 个工具，旧实现拿报错里的
  // 已知名单取交集、只收窄了 1 个 —— 那条会话从此调 bili_look 报 unknown tool，
  // 她回答「我没法浏览 B 站」。restrict 只能减不能加，所以名字没齐时必须先不收。
  const ctx = fakeCtx()
  const say = []
  registerToolRestrict(ctx, { herDir: 'C:\\h', log: (m) => say.push(m), retryMs: 5, retryMax: 5 })

  const calls = []
  let first = true
  const guards = []
  let names = new Set(['read_image']) // 宿主此刻只认得 1 个
  const agent = {
    session: { header: { cwd: 'C:\\h' } },
    ctx: {
      effect: () => {},
      tools: {
        view: () => ({ restrictableNames: names }),
        restrict: (filter) => {
          calls.push(filter)
          if (first) {
            first = false
            if (filter.allow.some((n) => !names.has(n))) {
              throw new Error('tools.restrict() names unknown global tool "growth_commit"; known global tools: read_image')
            }
          }
          return () => {}
        },
        guard: (fn) => { guards.push(fn); return () => {} },
      },
    },
  }
  ctx.emit('agent/created', { agent })
  assert.deepEqual(calls[0].allow, ['read_image'], '第一刀只下宿主此刻真认得的名字（0.9.8 的 B 方案）')
  assert.equal(guards.length, 1, '兜底守卫要先挂上（不依赖名字表）')
  assert.ok(say.some((m) => m.includes('先只给她已登记')), '要如实说这次先下了窄刀')

  // 宿主随后把她的工具登记齐了
  names = new Set([...HER_TOOLS])
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(calls.length, 2, '登记齐之后应该再收一次')
  assert.deepEqual(calls[1].allow, HER_TOOLS.filter((n) => n !== 'her_dream'), '收窄用的是完整清单（减去 .dev 专属的 her_dream），不是交集')
})

test('工具名一直登记不齐：不收窄，但兜底守卫仍然在（挡住 subagent）', async () => {
  const ctx = fakeCtx()
  const seen = []
  registerToolRestrict(ctx, { herDir: 'C:\\h', log: () => {}, onResult: (r) => seen.push(r), retryMs: 5, retryMax: 2 })
  const guards = []
  const agent = {
    session: { header: { cwd: 'C:\\h' } },
    ctx: {
      effect: () => {},
      tools: {
        view: () => ({ restrictableNames: new Set(['read_image']) }),
        restrict: () => { throw new Error('boom') },
        guard: (fn) => { guards.push(fn); return () => {} },
      },
    },
  }
  ctx.emit('agent/created', { agent })
  assert.equal(guards.length, 1, 'restrict 挂了，guard 也必须在')
  // 0.9.3（issue #54）：拒的时候要念一遍清单，否则她会换着名字接着试
  const denied = guards[0]({ name: 'subagent' })
  assert.match(denied, /^这件事我做不到。/, '挡不住名字就靠执行时拦')
  assert.match(denied, /我手上没有这样东西——能用的只有：/, '要说清此刻手上到底有什么')
  assert.match(denied, /her_recall/, '清单里得有真放行的名字')
  assert.equal(guards[0]({ name: 'her_recall' }), undefined)
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(seen.at(-1).why, 'deferred', '如实报「这次没挂上」，不能假装成功')
  assert.equal(seen.at(-1).applied, 0)
})

// ---------------------------------------------------------------------------
// 提示词这一层（2026-10-29，用户 m01276）：收不窄的工具靠说清「哪几样真是我的」。
// ---------------------------------------------------------------------------

test('toolSurfaceText：把放行的工具逐一点名，并说清多出来的不算', () => {
  const txt = toolSurfaceText(['growth_commit', 'her_recall', 'read_image'])
  // 0.8.5（用户 m02004）：不许把「此刻的家当」说成她的上限。
  assert.match(txt, /现在手边能碰到的是这些/)
  assert.match(txt, /不是我的上限/)
  assert.doesNotMatch(txt, /只有这几样/)
  assert.doesNotMatch(txt, /别去调/)
  assert.match(txt, /growth_commit/)
  assert.match(txt, /her_recall/)
  assert.match(txt, /read_image/)
  // 挡不掉的那几类要提前点名，不然她只看到 schema 里的名字
  assert.match(txt, /ops_/)
  assert.match(txt, /subagent/)
  // 越界会得到什么，必须和 guard 的原话一致
  assert.match(txt, /这件事我做不到/)
  // 不用「权限/禁止/违规」这类系统词——她该以为是自己做不到
  assert.doesNotMatch(txt, /权限|禁止|违规/)
  // 空名单 = 这一层不挂
  assert.equal(toolSurfaceText([]), '')
})

test('currentToolSurface：默认就是放行清单；收窄关掉时为空', () => {
  const ctx = fakeCtx()
  const off = registerToolRestrict(ctx, { herDir: 'C:\\\\h', enabled: true, log: () => {} })
  assert.match(currentToolSurface(), /growth_commit/)
  assert.match(currentToolSurface(), /read_image/)
  off()

  registerToolRestrict(fakeCtx(), { herDir: 'C:\\\\h', enabled: false, log: () => {} })
  assert.equal(currentToolSurface(), '', '收窄关着就不能替她列家当')
})

test('currentToolSurface：白名单里额外放行的会跟着进提示词', () => {
  registerToolRestrict(fakeCtx(), { herDir: 'C:\\\\h', extra: ['web_search'], log: () => {} })
  assert.match(currentToolSurface(), /web_search/)
  // 复位，别把额外放行漏给后面的用例
  registerToolRestrict(fakeCtx(), { herDir: 'C:\\\\h', log: () => {} })
  assert.doesNotMatch(currentToolSurface(), /web_search/)
})


test('own 层（dsh-ops 的 ops_*）能进白名单，但不会被塞给 restrict（2026-10-29）', () => {
  // 2026-10-29 真机：ops_bash / ops_discover_tools 在她 9 个工具里，却不在
  // restrictableNames 里。旧实现把它判成「名字不存在」，白名单永远存不进去；
  // 硬塞进 allow 又会抛 `names unknown global tool`，整条收窄当场失效。
  const ctx = fakeCtx()
  const calls = []
  const guards = []
  const agent = {
    session: { header: { cwd: 'C:\\h' } },
    ctx: {
      effect: () => {},
      tools: {
        view: (scope) => {
          // 只有传 agent 才是她的视角；不带参数是全局视角（老代码就踩过这个坑）
          if (scope !== agent) return { restrictableNames: new Set() }
          return {
            restrictableNames: new Set([...HER_TOOLS]),
            visible: new Map([...HER_TOOLS.map((n) => [n, {}]), ['ops_bash', {}], ['ops_glob', {}]]),
          }
        },
        restrict: (filter) => { calls.push(filter); return () => {} },
        guard: (fn) => { guards.push(fn); return () => {} },
      },
    },
  }
  registerToolRestrict(ctx, { herDir: 'C:\\h', extra: ['ops_bash'], log: () => {} })
  ctx.emit('agent/created', { agent })

  // 白名单校验：ops_bash 是真名字，得能存
  assert.ok(knownToolNames(ctx).includes('ops_bash'))
  // 但下给 restrict 的那份不许带它
  assert.equal(calls.length, 1)
  assert.ok(!calls[0].allow.includes('ops_bash'))
  assert.ok(!calls[0].allow.includes('ops_glob'))
  assert.ok(calls[0].allow.includes('growth_commit'))
  // own 层名单给设置页用来解释「加进来只是让守卫放行」
  assert.ok(ownLayerNames().includes('ops_bash'))

  // 守卫放行名单是配置里的全量：写进白名单 = 守卫不再拦
  assert.equal(guards[0]({ name: 'ops_bash' }), undefined)
  assert.match(guards[0]({ name: 'web_search' }), /^这件事我做不到。/)
})

test('宿主没有 read_image：外部名字这次剔掉，照常收窄，不再永远延后（issue #61）', async () => {
  // issue #61 真机：herToolsNow() 恒含 read_image；宿主没这个工具时，旧实现把它算成
  // 「还没登记完」，于是 restrict 每次都抛错、延后、再等——一次都没收窄过。
  // 名字不是我们自己注册的，等下去也不会出现；剔掉它，剩下的人照收。
  const ctx = fakeCtx()
  const calls = []
  const logs = []
  const guards = []
  const seen = []
  const names = HER_TOOLS.filter((n) => n !== 'read_image')
  const agent = {
    session: { header: { cwd: 'C:\\\\h' } },
    ctx: {
      effect: () => {},
      tools: {
        view: (scope) => scope === agent
          ? { restrictableNames: new Set(names), visible: new Map(names.map((n) => [n, {}])) }
          : { restrictableNames: new Set() },
        restrict: (filter) => { calls.push(filter); return () => {} },
        guard: (fn) => { guards.push(fn); return () => {} },
      },
    },
  }
  registerToolRestrict(ctx, {
    herDir: 'C:\\\\h',
    extra: ['qq_send_message'],
    log: (m) => logs.push(m),
    onResult: (r) => seen.push(r),
  })
  ctx.emit('agent/created', { agent })

  assert.equal(calls.length, 1, '先下窄刀，而不是整段延后')
  assert.ok(!calls[0].allow.includes('read_image'), '机器上没有的名字不该下给 restrict')
  assert.ok(!calls[0].allow.includes('qq_send_message'), '白名单里的外部名字也一样')
  assert.ok(calls[0].allow.includes('bili_look'), '真有的工具一个都不能少')
  await until(() => ['applied', 'applied-late'].includes(seen.at(-1)?.why), '宽限过了要真收窄，不能停在 registered')
  const last = calls.at(-1)
  assert.ok(!last.allow.includes('read_image'))
  assert.ok(!last.allow.includes('qq_send_message'))
  assert.ok(last.allow.includes('bili_look'), '真有的工具一个都不能少')
  assert.ok(logs.some((m) => m.includes('read_image') && m.includes('没有')), '剔掉的名字要留一行日志')
  // 守卫仍按配置的全量放行：名字以后真出现了，不会被自己人挡住
  assert.equal(guards[0]({ name: 'qq_send_message' }), undefined)
})

// 2026-11-08（issue #61，@BBleae 追问的时序）：启动时她的会话先建好，插件自己的
// 工具随后才注册，别的插件的工具、附件服务挂上的 read_image 还可能再晚一点。
// 自己的名字一齐就收窄，晚到的那一个这一局就再也进不来（restrict 只能减不能加）。
test('自己的工具晚到、read_image 紧跟着到：宽限里等一等，晚到的手不留在门外（issue #61）', async () => {
  const ctx = fakeCtx()
  const calls = []
  // retryMax 故意给大：宽限只从「自家的到齐」那一拍起算 3 拍，不该等到 retryMax 用完才收窄。
  registerToolRestrict(ctx, { herDir: 'C:\\h', retryMs: 5, retryMax: 20, log: () => {} })
  const own = HER_TOOLS.filter((n) => n !== 'read_image' && n !== 'her_dream')
  // 一开始宿主只认得一个外部工具：这时算得出「我们自己的名字还没登记」。
  let names = new Set(['web_search'])
  const agent = {
    session: { header: { cwd: 'C:\\h' } },
    ctx: {
      effect: () => {},
      tools: {
        view: () => ({ restrictableNames: new Set(names), visible: new Map([...names].map((n) => [n, {}])) }),
        restrict: (filter) => { calls.push(filter); return () => {} },
        guard: () => () => {},
      },
    },
  }
  setTimeout(() => { names = new Set(own) }, 7) // 自己的到齐
  setTimeout(() => { names = new Set([...own, 'read_image']) }, 17) // read_image 晚两拍
  ctx.emit('agent/created', { agent })
  await new Promise((r) => setTimeout(r, 80))

  assert.ok(calls.length >= 1, '最终要落下完整刀')
  assert.ok(calls.at(-1).allow.includes('read_image'), '宽限期内到的名字要收进去，不能当场剔掉')
  assert.ok(calls.at(-1).allow.includes('growth_commit'), '自己的工具一个都不能少')
})

test('外部名字一直没来：宽限用完剔掉照收，不报 deferred（issue #61）', async () => {
  const ctx = fakeCtx()
  const calls = []
  const seen = []
  const logs = []
  registerToolRestrict(ctx, {
    herDir: 'C:\\h',
    retryMs: 5,
    retryMax: 3,
    log: (m) => logs.push(m),
    onResult: (r) => seen.push(r),
  })
  const own = HER_TOOLS.filter((n) => n !== 'read_image' && n !== 'her_dream')
  let names = new Set(['web_search'])
  const agent = {
    session: { header: { cwd: 'C:\\h' } },
    ctx: {
      effect: () => {},
      tools: {
        view: () => ({ restrictableNames: new Set(names), visible: new Map([...names].map((n) => [n, {}])) }),
        restrict: (filter) => { calls.push(filter); return () => {} },
        guard: () => () => {},
      },
    },
  }
  setTimeout(() => { names = new Set(own) }, 7) // 自己的到齐；read_image 始终没来
  ctx.emit('agent/created', { agent })
  await new Promise((r) => setTimeout(r, 80))

  assert.equal(calls.length, 2, '窄刀 + 宽限过后的完整刀')
  assert.ok(!calls.at(-1).allow.includes('read_image'), '这台机器真没有的名字要剔掉')
  assert.equal(seen.at(-1).why, 'applied-late')
  // 2026-11-11：窄刀也算「真下过的一把刀」，所以这里计到 2（窄刀 + 宽限过后的完整刀）。
  assert.equal(seen.at(-1).applied, 2)
  assert.ok(logs.some((m) => m.includes('read_image') && m.includes('没有')), '剔掉的名字要留一行日志')
})

test('rememberFromView：restrictable ∪ visible 才算「认得的名字」', () => {
  rememberKnownTools([]) // 前面的用例留过快照；这里要一个干净的起点
  rememberFromView({ restrictableNames: new Set(['a_tool']), visible: new Map([['a_tool', {}], ['ops_x', {}]]) })
  assert.deepEqual(knownToolNames(null), ['a_tool', 'ops_x'])
  assert.deepEqual(ownLayerNames(), ['ops_x'])
  // 这次 view 没给 visible：名单不能缩，学到的 own 层也不回头否认
  // （同一个进程里它确实存在；这份名单只用于界面解释，不是权限判断）
  rememberFromView({ restrictableNames: new Set(['a_tool']) })
  assert.deepEqual(knownToolNames(null), ['a_tool', 'ops_x'], '快照只能变多不能变少')
  assert.deepEqual(ownLayerNames(), ['ops_x'])
  // 复位
  rememberFromView({ restrictableNames: new Set([...HER_TOOLS]), visible: new Map(HER_TOOLS.map((n) => [n, {}])) })
})

test('白名单只写 own 层名字时：不延后、不收窄失败（以前会整条失效）', () => {
  const ctx = fakeCtx()
  const seen = []
  registerToolRestrict(ctx, { herDir: 'C:\\h', extra: ['ops_bash'], log: () => {}, onResult: (r) => seen.push(r) })
  const calls = []
  const agent = {
    session: { header: { cwd: 'C:\\h' } },
    ctx: {
      effect: () => {},
      tools: {
        view: (scope) => scope === agent
          ? { restrictableNames: new Set([...HER_TOOLS]), visible: new Map([...HER_TOOLS.map((n) => [n, {}]), ['ops_bash', {}]]) }
          : { restrictableNames: new Set() },
        restrict: (filter) => { calls.push(filter); return () => {} },
        guard: () => () => {},
      },
    },
  }
  ctx.emit('agent/created', { agent })
  assert.equal(calls.length, 1, '不该因为 ops_bash 抛错重试')
  assert.ok(!calls[0].allow.includes('ops_bash'))
  const last = seen[seen.length - 1]
  assert.equal(last.why, 'applied')
  assert.equal(last.applied, 1)
  assert.ok(last.allow.includes('ops_bash'), '配置里记着它（提示词与守卫都要用）')
  assert.ok(!last.effective.includes('ops_bash'))
})

/** 造一个「她」的 agent：visible 可以事后继续变（模拟别的插件 attach 时才注册工具）。 */
function agentWithDynamicOwnLayer() {
  const calls = []
  const guards = []
  const visible = new Map(HER_TOOLS.map((n) => [n, {}]))
  const agent = {
    session: { header: { cwd: 'C:\h' } },
    ctx: {
      effect: () => {},
      tools: {
        view: (scope) => {
          if (scope !== agent) return { restrictableNames: new Set() }
          return { restrictableNames: new Set([...HER_TOOLS]), visible: new Map(visible) }
        },
        restrict: (filter) => { calls.push(filter); return () => {} },
        guard: (fn) => { guards.push(fn); return () => {} },
      },
    },
  }
  return { agent, calls, guards, visible }
}

test('别的插件注册在 own 层的工具（不是 ops_）一样能存、能被守卫放行（2026-10-29）', () => {
  // 用户 m01685：这类情况不该只对 dsh-ops 生效——凡是「插件注册进她自己那一层」的工具，
  // 用户想授权就该存得进去。这里用 agent-teams 的 team_task_list 和一个假想插件工具。
  rememberKnownTools([]) // 干净起点（前一个用例留下的快照不能混进来）
  const ctx = fakeCtx()
  const { agent, calls, guards, visible } = agentWithDynamicOwnLayer()
  visible.set('team_task_list', {})
  visible.set('helper_paint', {})

  registerToolRestrict(ctx, { herDir: 'C:\h', extra: ['team_task_list', 'helper_paint'], log: () => {} })
  ctx.emit('agent/created', { agent })

  const known = knownToolNames(ctx)
  assert.ok(known.includes('team_task_list'), 'agent-teams 的工具名也得能存进白名单')
  assert.ok(known.includes('helper_paint'), '不是 ops_ 前缀的 own 层工具同样要认')
  assert.ok(known.includes('growth_commit'), '原来的名字一个都不能少')

  assert.equal(calls.length, 1)
  assert.ok(!calls[0].allow.includes('team_task_list'), 'own 层名字不能下给 restrict，否则整段抛错')
  assert.ok(!calls[0].allow.includes('helper_paint'))
  assert.ok(calls[0].allow.includes('growth_commit'))
  assert.deepEqual(ownLayerNames().filter((n) => n === 'team_task_list' || n === 'helper_paint'), ['helper_paint', 'team_task_list'])

  assert.equal(guards[0]({ name: 'team_task_list' }), undefined, '白名单放行 = 守卫不拦')
  assert.equal(guards[0]({ name: 'helper_paint' }), undefined)
  assert.match(guards[0]({ name: 'web_search' }), /^这件事我做不到。/, '没授权的照旧拦')
})

test('插件在 agent 建好之后才注册的工具，不重启也能认出来（2026-10-29）', () => {
  rememberKnownTools([])
  const ctx = fakeCtx()
  const { agent, calls, visible } = agentWithDynamicOwnLayer()

  registerToolRestrict(ctx, { herDir: 'C:\h', extra: [], log: () => {} })
  ctx.emit('agent/created', { agent })
  assert.ok(!knownToolNames(ctx).includes('late_tool'), '还没注册的时候当然不认得')

  // dsh-ops 是 attach 时才 publish；别的插件也可能在 agent 建好之后补工具。
  visible.set('late_tool', {})
  const known = knownToolNames(ctx)
  assert.ok(known.includes('late_tool'), '每次问名单都现取一次 view，才认得到后注册的工具')
  assert.ok(ownLayerNames().includes('late_tool'), '晚来的 own 层工具也要能解释「收窄挡不住」')
  assert.equal(calls.length, 1, '这次刷新不该再下一次 restrict')
})

// ---------------------------------------------------------------------------
// 出门在外的「手边有什么」（0.7.3，用户 m00339）
//
// 病根：`surfaceNow` 是进程级单例、只由 registerToolRestrict 写过一次，值是**家里的白名单**；
// 而 attachIdentity 无条件挂 fish:tools 段 —— 出门那条会话照样念家里那份，
// 于是她人在别人工作区、手里握着那个工作区的全部工具，提示词却说「那不是我的：别去调」。
// 出门不收窄（isHerAgent 为假就 return），awayGuard 又只比对参数里的路径、不看工具名，
// 所以她**调得动**，只是被自己吓住了。出门打工这个场景就废在这一段话上。
// ---------------------------------------------------------------------------

/** 一条「在外面」的假 agent：cwd 在别的工作区，view() 报得出此刻看得见的工具。 */
function outsideAgent(cwd, visibleNames) {
  const visible = new Map((visibleNames ?? []).map((n) => [n, {}]))
  const restrictable = new Set(['growth_commit', 'her_recall'])
  return {
    session: { header: { cwd } },
    ctx: {
      tools: {
        view: () => ({ visible, restrictableNames: restrictable }),
      },
      effect: () => {},
    },
  }
}

test('outsideSurfaceText：念的是那个工作区真给的工具，并且明说放开用', () => {
  const txt = outsideSurfaceText(['bash', 'read', 'write', 'growth_commit'])
  assert.match(txt, /bash/)
  assert.match(txt, /read/)
  assert.match(txt, /write/)
  assert.match(txt, /growth_commit/)
  // 出门就是来干活的：不许再出现「别去调」「那不是我的」这类自我劝阻
  assert.doesNotMatch(txt, /别去调/)
  assert.doesNotMatch(txt, /那不是我的/)
  assert.doesNotMatch(txt, /只有这几样/)
  // 唯一留着的一条：不许伸手回自己屋子，话术与 awayGuard 一致
  assert.match(txt, /这件事我做不到/)
  // 空名单 = 这一层不挂（拿不到工具表时宁可不说，也别瞎说「一样都没有」）
  assert.equal(outsideSurfaceText([]), '')
  assert.equal(outsideSurfaceText(null), '')
})

test('toolSurfaceFor：在家念白名单，在外面念那个工作区的工具', () => {
  const herDir = 'C:/her-home'
  registerToolRestrict(fakeCtx(), { herDir, log: () => {} })

  // 在家里：照旧那份白名单（收窄真的在下，她确实只有那几样）
  const atHome = { session: { header: { cwd: herDir } } }
  assert.equal(toolSurfaceFor(atHome, { herDir }), currentToolSurface())
  assert.match(toolSurfaceFor(atHome, { herDir }), /现在手边能碰到的是这些/)

  // 在外面：按此刻看得见的现算，绝不能是家里那份
  const away = outsideAgent('D:/work/somewhere', ['bash', 'read', 'write', 'growth_commit'])
  const txt = toolSurfaceFor(away, { herDir })
  assert.match(txt, /bash/)
  assert.match(txt, /write/)
  assert.doesNotMatch(txt, /现在手边能碰到的是这些/, '出门还念家里白名单就是把她说成残废')

  // 拿不到工具表：说空串，不猜
  const blind = { session: { header: { cwd: 'D:/work/x' } }, ctx: {} }
  assert.equal(toolSurfaceFor(blind, { herDir }), '')

  // 没传 herDir：退回家里那份（老调用点/单测兼容，生产上两个调用点都传了）
  assert.equal(toolSurfaceFor(away, {}), currentToolSurface())
})

test('visibleToolsOf：优先 visible；老宿主没有 visible 才退回 restrictableNames', () => {
  const a = outsideAgent('D:/w', ['bash', 'read'])
  assert.deepEqual(visibleToolsOf(a).sort(), ['bash', 'read'])

  const legacy = {
    ctx: { tools: { view: () => ({ restrictableNames: new Set(['growth_commit', 'her_recall']) }) } },
  }
  assert.deepEqual(visibleToolsOf(legacy).sort(), ['growth_commit', 'her_recall'])

  // 两条路都拿不到 = null（「不知道」不能当成「一样都没有」）
  assert.equal(visibleToolsOf({ ctx: {} }), null)
  assert.equal(visibleToolsOf(undefined), null)
})

// ---------------------------------------------------------------------------
// 被挡下来的调用要记账（2026-11-04，issue #20）
//
// 以前 guard 拦下只写一行日志、返回「这件事我做不到」——用户看到她在拒绝，
// 却没有任何线索说「白名单少了个名字」。issue 里那位翻了四小时日志才查出来。
// 现在每次拦截都按名字归并进 blockedTools()，设置页与自检直接拿它说话。
// ---------------------------------------------------------------------------

test('guard 拦下谁就记下谁：按名字归并、次数累加', () => {
  forgetBlockedTools()
  const ctx = fakeCtx()
  registerToolRestrict(ctx, { herDir: 'C:\\h', log: () => {} })
  const a = fakeAgent('C:\\h')
  ctx.emit('agent/created', { agent: a.agent })
  const guard = a.guards[0]

  guard({ name: 'vision_describe', args: { path: 'a.png' } })
  guard({ name: 'vision_describe', args: { path: 'b.png' } })
  guard({ name: 'ops_bash' })

  const got = blockedTools()
  assert.deepEqual(got.map((b) => b.name).sort(), ['ops_bash', 'vision_describe'])
  const v = got.find((b) => b.name === 'vision_describe')
  assert.equal(v.count, 2, '同一只手够两次要记两次')
  assert.ok(v.first && v.last, '第一次与最近一次都留着')
  assert.ok(typeof v.first === 'string' && v.first.endsWith('Z'))
})

test('放行的调用不进账本（别把正常用工具也记成"被挡"）', () => {
  forgetBlockedTools()
  const ctx = fakeCtx()
  registerToolRestrict(ctx, { herDir: 'C:\\h', log: () => {} })
  const a = fakeAgent('C:\\h')
  ctx.emit('agent/created', { agent: a.agent })
  const guard = a.guards[0]

  assert.equal(guard({ name: 'growth_commit' }), undefined)
  assert.equal(guard({ name: 'read_image' }), undefined)
  assert.deepEqual(blockedTools(), [])
})

test('账本按"最近被挡"倒序：刚撞的那只排最前', () => {
  forgetBlockedTools()
  const ctx = fakeCtx()
  registerToolRestrict(ctx, { herDir: 'C:\\h', log: () => {} })
  const a = fakeAgent('C:\\h')
  ctx.emit('agent/created', { agent: a.agent })
  const guard = a.guards[0]

  guard({ name: 'team_task_list' })
  guard({ name: 'workflow' })
  assert.equal(blockedTools()[0].name, 'workflow', '后撞的那只要排最前')
})

test('往账本里灌 200 个不同名字不会失控（上限 50）', () => {
  forgetBlockedTools()
  const ctx = fakeCtx()
  registerToolRestrict(ctx, { herDir: 'C:\\h', log: () => {} })
  const a = fakeAgent('C:\\h')
  ctx.emit('agent/created', { agent: a.agent })
  const guard = a.guards[0]

  for (let i = 0; i < 200; i += 1) guard({ name: `spam_tool_${i}` })
  // 上限是给界面看的，不许因为一个失控的循环把内存吃满
  assert.ok(blockedTools().length <= 50, `实际 ${blockedTools().length} 个`)
  assert.ok(blockedTools().length > 0)
  forgetBlockedTools()
})

test('forgetBlockedTools 清空：重启后有没有被挡是新问题，不该带上一局的账', () => {
  const ctx = fakeCtx()
  registerToolRestrict(ctx, { herDir: 'C:\\h', log: () => {} })
  const a = fakeAgent('C:\\h')
  ctx.emit('agent/created', { agent: a.agent })
  a.guards[0]({ name: 'run_code' })
  assert.equal(blockedTools().length, 1)
  forgetBlockedTools()
  assert.deepEqual(blockedTools(), [])
})

/** 带「刀口记录」的假 agent：restrict 的 disposer 记下来，好断言旧刀真被收掉。 */
function agentWithDisposers(cwd) {
  const calls = []
  const disposed = []
  const guards = []
  const agent = {
    session: { header: { cwd } },
    ctx: {
      tools: {
        restrict: (filter) => {
          calls.push(filter)
          const dispose = () => disposed.push(filter)
          return dispose
        },
        guard: (fn) => {
          guards.push(fn)
          return () => {}
        },
      },
      effect: () => {},
    },
  }
  return { agent, calls, disposed, guards }
}

test('白名单存盘后当场换刀：不用重启，她下一句就拿得到新加的工具（2026-11-11）', () => {
  const ctx = fakeCtx()
  registerToolRestrict(ctx, { herDir: 'C:\\her-home', extra: ['web_search'], log: () => {} })
  const h = agentWithDisposers('C:\\her-home')
  ctx.emit('agent/created', { agent: h.agent })
  assert.equal(h.calls.length, 1)
  assert.ok(h.calls[0].allow.includes('web_search'))
  assert.ok(!h.calls[0].allow.includes('qq_space_list'))
  // 旧名单下她够不着它——这也是用户看到的那一幕
  assert.equal(typeof h.guards[0]({ name: 'qq_space_list' }), 'string')

  const r = restrictMod.refreshToolRestrict({ extra: ['web_search', 'qq_space_list'] })
  assert.equal(r.ok, true)
  assert.equal(h.calls.length, 2, '存完就该再下一刀')
  assert.ok(h.calls[1].allow.includes('qq_space_list'), '新名字要真的下给 restrict，不是只改守卫')
  assert.equal(h.disposed.length, 1, '旧刀必须先收掉，否则两刀取交集、等于没放宽')
  // 守卫按新名单走：新名字放行，没放行的照旧挡，拒绝时念的清单也换新
  assert.equal(h.guards[0]({ name: 'qq_space_list' }), undefined, '新名字立刻就能用')
  const blockedMsg = h.guards[0]({ name: 'subagent' })
  assert.equal(typeof blockedMsg, 'string', '不在名单里的照旧挡')
  assert.ok(blockedMsg.includes('qq_space_list'), '被挡时念的清单要是新的')
  assert.equal(readRestrictState().why, 'refreshed')
})

test('白名单热更新也管拿掉：删掉的名字下一句就挡，旧刀同时收掉', () => {
  const ctx = fakeCtx()
  registerToolRestrict(ctx, { herDir: 'C:\\her-home', extra: ['web_search', 'qq_space_list'], log: () => {} })
  const h = agentWithDisposers('C:\\her-home')
  ctx.emit('agent/created', { agent: h.agent })
  assert.equal(typeof h.guards[0]({ name: 'web_search' }), 'undefined')

  restrictMod.refreshToolRestrict({ extra: ['qq_space_list'] })
  assert.equal(h.calls.length, 2)
  assert.ok(!h.calls[1].allow.includes('web_search'), '删掉的名字不能再下给 restrict')
  assert.equal(h.disposed.length, 1)
  assert.equal(typeof h.guards[0]({ name: 'web_search' }), 'string', '删掉之后立刻要挡')
})

test('热更新之后新建的会话（轮换/群房）直接按新名单收，不用等重启', () => {
  const ctx = fakeCtx()
  registerToolRestrict(ctx, { herDir: 'C:\\her-home', extra: ['web_search'], log: () => {} })
  restrictMod.refreshToolRestrict({ extra: ['web_search', 'qq_space_list'] })
  const later = agentWithDisposers('C:\\her-home')
  ctx.emit('agent/created', { agent: later.agent })
  assert.equal(later.calls.length, 1)
  assert.ok(later.calls[0].allow.includes('qq_space_list'), '新会话读的是当下的白名单，不是注册那一刻的')
})

test('收窄关着的时候热更新什么都不做（她本来就看得见全部）', () => {
  const ctx = fakeCtx()
  registerToolRestrict(ctx, { herDir: 'C:\\her-home', enabled: false, log: () => {} })
  const r = restrictMod.refreshToolRestrict({ extra: ['qq_space_list'] })
  assert.equal(r.ok, false)
  assert.equal(r.why, 'disabled')
  assert.deepEqual(r.allow, [])
})

// 2026-11-11（用户拍板的 B 方案）：先摆已知的、齐了再换完整的；等不齐就全开，
// 这一局只靠守卫。下面三条钉住「不空刀、不放空档、超时真收手」。
test('窄刀换成完整刀：先下新刀再收旧刀，中间总有一把在岗', async () => {
  const ctx = fakeCtx()
  const order = []
  let names = new Set(['web_search'])
  const agent = {
    session: { header: { cwd: 'C:\\h' } },
    ctx: {
      effect: () => {},
      tools: {
        view: (scope) => scope === agent
          ? { restrictableNames: new Set(names), visible: new Map([...names].map((n) => [n, {}])) }
          : { restrictableNames: new Set() },
        restrict: ({ allow }) => {
          order.push(['apply', allow.join(',')])
          return () => order.push(['dispose', allow.join(',')])
        },
        guard: () => () => {},
      },
    },
  }
  registerToolRestrict(ctx, { herDir: 'C:\\h', extra: ['web_search'], retryMs: 5, retryMax: 20, log: () => {} })
  ctx.emit('agent/created', { agent })
  names = new Set([...HER_TOOLS, 'web_search'])
  await until(() => order.filter((x) => x[0] === 'apply').length >= 2, '齐了要换完整刀')

  const knives = order.filter((x) => x[0] === 'apply')
  assert.equal(knives.length, 2, '窄刀一把、完整刀一把')
  assert.ok(knives[0][1].includes('web_search'), '窄刀里有她当时真有的名字')
  assert.ok(knives[1][1].includes('her_recall'), '完整刀里有后来登记上的名字')
  const secondApply = order.findIndex((x) => x[0] === 'apply' && x[1] === knives[1][1])
  const firstDispose = order.findIndex((x) => x[0] === 'dispose')
  assert.ok(secondApply >= 0 && firstDispose > secondApply, '先下新刀、再收旧刀，中间不留空档')
})

test('3 秒等不齐：窄刀留着，不撤也不全开（2026-11-11，先B后全收窄）', async () => {
  const ctx = fakeCtx()
  const seen = []
  const calls = []
  const disposed = []
  const guards = []
  const names = new Set(['web_search'])
  const agent = {
    session: { header: { cwd: 'C:\\h' } },
    ctx: {
      effect: () => {},
      tools: {
        view: () => ({ restrictableNames: new Set(names), visible: new Map([...names].map((n) => [n, {}])) }),
        restrict: ({ allow }) => { calls.push(allow); return () => disposed.push(allow) },
        guard: (fn) => { guards.push(fn); return () => {} },
      },
    },
  }
  registerToolRestrict(ctx, { herDir: 'C:\\h', extra: ['web_search'], retryMs: 5, retryMax: 2, log: () => {}, onResult: (r) => seen.push(r) })
  ctx.emit('agent/created', { agent })
  assert.equal(calls.length, 1, '先下窄刀')
  await until(() => seen.at(-1)?.why === 'narrowed-late', '等不齐要如实报「按已认得的收着」')

  assert.equal(disposed.length, 0, '窄刀不许撤——撤了就把宿主全量工具表摆给她看')
  assert.deepEqual(seen.at(-1).effective, ['web_search'], 'effective 是她真看得见的那几件')
  assert.match(guards[0]({ name: 'subagent' }), /^这件事我做不到。/, '守卫还在，真调用仍然被拦')
})

test('晚到的工具：再对一次名册就能补进来，旧刀当场收掉（2026-11-11）', async () => {
  const ctx = fakeCtx()
  const calls = []
  const disposed = []
  const names = new Set(['web_search'])
  const agent = {
    session: { header: { cwd: 'C:\\h' } },
    ctx: {
      effect: () => {},
      tools: {
        view: () => ({ restrictableNames: new Set(names), visible: new Map([...names].map((n) => [n, {}])) }),
        restrict: ({ allow }) => { calls.push(allow); return () => disposed.push(allow) },
        guard: () => () => {},
      },
    },
  }
  registerToolRestrict(ctx, { herDir: 'C:\\h', extra: ['web_search'], retryMs: 5, retryMax: 2, log: () => {}, onResult: () => {} })
  ctx.emit('agent/created', { agent })
  assert.deepEqual(calls[0], ['web_search'], '第一刀只有已认得的')

  // 晚到：宿主终于认得 her_recall 了
  names.add('her_recall')
  const r = recheckToolRestrict()
  assert.equal(r.ok, true)
  assert.deepEqual([...calls.at(-1)].sort(), ['her_recall', 'web_search'], '再对名册要把晚到的补进来')
  assert.equal(disposed.length, 1, '旧刀收掉，先下新刀再收旧刀')
  assert.deepEqual([...r.effective].sort(), ['her_recall', 'web_search'])
})

test('一个名字都没认得：不下空刀，宁可全开也不把她焊死在桌上（2026-11-11）', async () => {
  const ctx = fakeCtx()
  const seen = []
  const calls = []
  const agent = {
    session: { header: { cwd: 'C:\\h' } },
    ctx: {
      effect: () => {},
      tools: {
        view: () => ({ restrictableNames: new Set(), visible: new Map() }),
        // 宿主此刻一个名字都不认：整份清单递过去会抛错，只能等它登记完。
        restrict: ({ allow }) => { calls.push(allow); throw new Error('tools.restrict() names unknown global tool "read_image"') },
        guard: () => () => {},
      },
    },
  }
  registerToolRestrict(ctx, { herDir: 'C:\\h', extra: ['web_search'], retryMs: 5, retryMax: 2, log: () => {}, onResult: (r) => seen.push(r) })
  ctx.emit('agent/created', { agent })
  await until(() => seen.at(-1)?.why === 'deferred', '等不齐就如实报 deferred')
  assert.ok(calls.length > 0, '试过才知道等不齐')
  assert.ok(calls.every((a) => a.length > 0), '一个都认不得时绝不下空刀（C 方案，用户明确不要）')
})

test('旧话被压成摘要了去哪儿翻：宿主真给了 search_context 才挂这一段（2026-11-13）', () => {
  // 外部真机反馈：长对话被 billion-context 压成摘要后，原话只剩 search_context /
  // decompress 能捞回来，而我们从来没跟她说过这两件工具（16 天里她只碰过 2 次）。
  // 但这两件是宿主插件注册的，不是我们的：没装、或装了没放行，念了就是空话——
  // 她会照着去做，然后撞在「没有这个工具」上。
  const agentWith = (names) => ({
    session: { header: { cwd: 'C:\\h' } },
    ctx: { tools: { view: () => ({ visible: new Map(names.map((n) => [n, {}])) }) } },
  })
  assert.equal(foldedRecallNote(agentWith([])), '', '一件都没有：一个字都不说')
  assert.equal(foldedRecallNote(agentWith(['her_note', 'web_search'])), '', '有别的工具不等于有它')
  assert.equal(foldedRecallNote({}), '', '工具表读不出来（老宿主）：宁缺勿错')
  assert.equal(foldedRecallNote(null), '')
  const onlySearch = foldedRecallNote(agentWith(['search_context']))
  assert.match(onlySearch, /search_context/)
  assert.doesNotMatch(onlySearch, /decompress/, '没有 decompress 就别教她取原文')
  const both = foldedRecallNote(agentWith(['search_context', 'decompress']))
  assert.match(both, /search_context/)
  assert.match(both, /decompress/)
  assert.match(both, /搜不到不等于没发生过/, '别让她把「搜不到」当成「没发生过」')
})
