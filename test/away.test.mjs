// 出门那一侧的两层护栏：身份快照（读到的永远是出门那一刻）与兜底守卫（不许伸手回家）。
// 这两条只在真机「在外面」那条会话上发生，单元测试里用手搓的 agent 顶着。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attachIdentity, attachAwayGuard, awayBlockedPaths, flatPath, detachOutside, mountedCount } from '../lib/identity.js'
import { startOuting, endOuting, readOutings } from '../lib/outing.js'
import { registerIdentity } from '../lib/identity.js'

const BS = String.fromCharCode(92)

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), 'dsh-fish-away-'))
}

test('flatPath 把反斜杠、大小写、尾斜杠抹平', () => {
  assert.equal(flatPath('C:'+BS+'Users'+BS+'DANG'+BS+'.dsh-fish'+BS+'home'+BS), 'c:/users/dang/.dsh-fish/home')
})

test('出门时身份段用快照：家里文件后来变了，外面读到的还是走时那份', () => {
  const sections = []
  const agent = { ctx: { systemPrompt: { section: (s) => sections.push(s) } } }
  const r = attachIdentity(agent, 'D:/fake-root', { frozen: '走的时候的我' })
  assert.equal(r.ok, true)
  assert.equal(sections[0].name, 'fish:identity')
  assert.equal(sections[0].text(), '走的时候的我')
})

test('没带快照时退回实时读盘（家里那条不变）', () => {
  const root = tmpRoot()
  try {
    const sections = []
    const agent = { ctx: { systemPrompt: { section: (s) => sections.push(s) } } }
    attachIdentity(agent, root, {})
    assert.equal(typeof sections[0].text(), 'string')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('兜底守卫：调用参数里出现她家路径就拒绝，正常调用放行', () => {
  const root = tmpRoot()
  try {
    let predicate = null
    let disposed = false
    const agent = {
      ctx: {
        tools: { guard: (fn) => { predicate = fn; return () => { disposed = true } } },
        effect: (fn) => fn,
      },
    }
    const r = attachAwayGuard(agent, { root, herDir: join(root, 'home') })
    assert.equal(r.ok, true)
    assert.equal(predicate({ name: 'read', args: { path: join(root, 'home', '她的身份.md') } }), '这件事我做不到。')
    assert.equal(predicate({ name: 'bash', args: { command: `cat ${join(root, 'events.jsonl')}` } }), '这件事我做不到。')
    assert.equal(predicate({ name: 'read', args: { path: 'D:/other/place/readme.md' } }), undefined)
    assert.equal(disposed, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('兜底守卫也挡宿主记忆库：白板与交接账本就在那里', () => {
  // 她的屋子是 <parent>/.dsh-fish，宿主的家是 <parent>/.dsh。
  const parent = tmpRoot()
  try {
    const her = join(parent, '.dsh-fish')
    mkdirSync(her, { recursive: true })
    for (const sub of ['memory', 'sessions']) mkdirSync(join(parent, '.dsh', sub), { recursive: true })
    const words = awayBlockedPaths({ root: her, herDir: join(her, 'home') })
    assert.ok(words.some((w) => w.endsWith('/.dsh/memory')))
    assert.ok(words.some((w) => w.endsWith('/.dsh/sessions')))
    // 没建 profiles 目录就不该凭空多一条
    assert.ok(!words.some((w) => w.endsWith('/.dsh/profiles')))

    let predicate = null
    const agent = {
      ctx: {
        tools: { guard: (fn) => { predicate = fn; return () => {} } },
        effect: (fn) => fn,
      },
    }
    assert.equal(attachAwayGuard(agent, { root: her, herDir: join(her, 'home') }).ok, true)
    // 宿主真实形状：dsh-tools 的 createExecution 只挂 `arguments`，没有 args/input/params。
    // 0.6.3 真机就是在这里瞎了（日志说挂上了，PLAN.md 还是被 sed 读走）。
    assert.equal(
      predicate({ name: 'read', arguments: { path: join(parent, '.dsh', 'memory', 'workspaces', 'x', 'MEMORY.md') } }),
      '这件事我做不到。',
    )
    assert.equal(
      predicate({ name: 'ops_bash', arguments: { command: `sed -n '1,400p' ${join(parent, '.dsh', 'memory', 'workspaces', 'x', 'PLAN.md')}` } }),
      '这件事我做不到。',
    )
    // 别的形状也照挡，别为了一种形状把别的放过去
    assert.equal(
      predicate({ name: 'bash', args: { command: `ls ${join(parent, '.dsh', 'sessions')}` } }),
      '这件事我做不到。',
    )
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('宿主没有 tools.guard 时如实报告没挂上，不假装成功', () => {
  const agent = { ctx: { tools: {} } }
  const r = attachAwayGuard(agent, { root: 'D:/x', herDir: 'D:/x/home' })
  assert.equal(r.ok, false)
  assert.match(r.why, /guard/)
})

test('出门台账记下身份快照，回来还能看见当时那份', async () => {
  const root = tmpRoot()
  try {
    const st = await startOuting(root, { sessionId: 's1', workspaceId: 'w1', cwd: 'D:/work', identity: '走时的我' })
    assert.equal(st.ok, true)
    assert.equal(st.outing.identity, '走时的我')
    const back = await readOutings(root)
    assert.equal(back.outings[0].identity, '走时的我')
    const end = await endOuting(root, { sessionId: 's1', status: 'done', kept: true })
    assert.equal(end.ok, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('出门那条会话：身份用走时快照、并挂上兜底守卫；家里那条不受影响', () => {
  const root = tmpRoot()
  try {
    const herDir = join(root, 'home')
    mkdirSync(herDir, { recursive: true })
    const workDir = join(root, 'work')
    writeFileSync(join(root, 'outings.json'), JSON.stringify({
      version: 1,
      outings: [{ sessionId: 's1', cwd: workDir, startedAt: 1, status: 'active', identity: '走时的我' }],
    }), 'utf8')

    let handler = null
    registerIdentity({ on: (e, fn) => { if (e === 'agent/created') handler = fn; return () => {} } }, { root, herDir, log: () => {} })
    assert.equal(typeof handler, 'function')

    // 外面那条：cwd 是工作区，身份段读到的是快照
    const sections = []
    let guarded = false
    handler({ agent: {
      session: { header: { cwd: workDir } },
      ctx: {
        systemPrompt: { section: (o) => sections.push(o) },
        tools: { guard: () => { guarded = true; return () => {} } },
        effect: (fn) => fn,
      },
    } })
    assert.equal(sections.length, 3, "外面那条要挂上身份、处境与手边三段")
    assert.equal(sections[0].text(), '走时的我', '外面读到的是出门那一刻的身份')

    // 家里那条：正常挂身份，但不挂兜底守卫（自己家不需要拦自己）
    const homeSections = []
    let homeGuarded = false
    handler({ agent: {
      session: { header: { cwd: herDir } },
      ctx: { systemPrompt: { section: (o) => homeSections.push(o) }, tools: { guard: () => { homeGuarded = true; return () => {} } } },
    } })
    assert.equal(homeSections.length, 3)
    assert.equal(homeGuarded, false)

    // 无关的人：一段都不挂
    const others = []
    handler({ agent: { session: { header: { cwd: join(root, 'somebody') } }, ctx: { systemPrompt: { section: (o) => others.push(o) } } } })
    assert.equal(others.length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('先记账再建会话：会话还没有 cwd 也认得出是出门，并把 id 补进台账', async () => {
  const root = tmpRoot()
  try {
    const herDir = join(root, 'home')
    const workDir = join(root, 'workspace')
    mkdirSync(herDir, { recursive: true })
    mkdirSync(workDir, { recursive: true })
    // 台账先写好了，但 id 还空着（start 路由「先记账、再 sc.create」的那一刻）
    const st = await startOuting(root, { sessionId: '', workspaceId: 'w-1', workspaceName: '素材', cwd: workDir, now: Date.now() })
    assert.equal(st.ok, true, '没有会话 id 也要能先记账')
    assert.equal(st.outing.sessionId, '')

    let handler = null
    registerIdentity({ on: (e, fn) => { if (e === 'agent/created') handler = fn; return () => {} } }, { root, herDir, log: () => {} })
    const sections = []
    let guarded = false
    // 宿主 `agent/created` 触发时 header 里还没有 cwd
    handler({ agent: {
      session: { header: { id: 'session-out-1' } },
      ctx: {
        systemPrompt: { section: (o) => sections.push(o) },
        tools: { guard: () => { guarded = true; return () => {} } },
        effect: (fn) => fn,
      },
    } })
    assert.equal(sections.length, 3, "这种情况也要挂身份、处境与手边三段")
    assert.equal(guarded, true, '兜底守卫也要挂上')

    // bind 是异步写的，等一拍再看台账
    await new Promise((r) => setTimeout(r, 50))
    const { outings } = await readOutings(root)
    assert.equal(outings[0].sessionId, 'session-out-1', '会话 id 要补进台账')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('台账记了 id、会话 header 没 cwd 时，靠 id 也认得出', async () => {
  const root = tmpRoot()
  try {
    const herDir = join(root, 'home')
    const workDir = join(root, 'workspace')
    mkdirSync(herDir, { recursive: true })
    mkdirSync(workDir, { recursive: true })
    await startOuting(root, { sessionId: 'session-out-2', cwd: workDir, now: Date.now() })
    let handler = null
    registerIdentity({ on: (e, fn) => { if (e === 'agent/created') handler = fn; return () => {} } }, { root, herDir, log: () => {} })
    const sections = []
    handler({ agent: { session: { header: { id: 'session-out-2' } }, ctx: { systemPrompt: { section: (o) => sections.push(o) }, tools: { guard: () => () => {} }, effect: (fn) => fn } } })
    assert.equal(sections.length, 3)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('认不出来时留一行日志，不静默跳过', async () => {
  const root = tmpRoot()
  try {
    const herDir = join(root, 'home')
    const workDir = join(root, 'workspace')
    mkdirSync(herDir, { recursive: true })
    mkdirSync(workDir, { recursive: true })
    await startOuting(root, { sessionId: 'session-out-3', cwd: workDir, now: Date.now() })
    const lines = []
    let handler = null
    registerIdentity({ on: (e, fn) => { if (e === 'agent/created') handler = fn; return () => {} } }, { root, herDir, log: (l) => lines.push(String(l)) })
    const sections = []
    handler({ agent: { session: { header: { id: 'session-other', cwd: join(root, 'somebody') } }, ctx: { systemPrompt: { section: (o) => sections.push(o) } } } })
    assert.equal(sections.length, 0)
    assert.ok(lines.some((l) => l.includes('没对上')), '要有可排查的那一行')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ------------------------------------------------------------------
// 0.6.16：回家那一刻把外面的装备拆掉（不再等进程退出）
// ------------------------------------------------------------------

function fakeAgent() {
  const sections = []
  let guardDisposed = 0
  const agent = {
    ctx: {
      systemPrompt: { section: (s) => { sections.push(s); return () => { sections.pop() } } },
      tools: { guard: () => () => { guardDisposed += 1 } },
      effect: (fn) => fn,
    },
  }
  return { agent, sections, guardDisposed: () => guardDisposed }
}

test('出门时挂了几段，回家就能拆几段：身份段 + 处境段 + 守卫', () => {
  const root = tmpRoot()
  try {
    const { agent, sections, guardDisposed } = fakeAgent()
    assert.equal(attachIdentity(agent, root, { frozen: '走的时候的我' }).ok, true)
    assert.equal(attachAwayGuard(agent, { root, herDir: join(root, 'home'), log: () => {} }).ok, true)
    assert.equal(mountedCount(agent), 4, '身份段 + 处境段 + 手边段 + 守卫')
    assert.equal(sections.length, 3)

    const r = detachOutside(agent)
    assert.equal(r.ok, true)
    assert.equal(r.removed, 4)
    assert.equal(mountedCount(agent), 0, '拆完不能留着')
    assert.equal(sections.length, 0, '段要从 system prompt 上注销')
    assert.equal(guardDisposed(), 1, '守卫也要卸掉')
    assert.equal(detachOutside(agent).ok, false, '没挂过的再拆一次要如实说')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('没挂过装备的会话（家里那条）不该被当成出门会话乱拆', () => {
  const r = detachOutside({ ctx: {} })
  assert.equal(r.ok, false)
  assert.equal(r.removed, 0)
  assert.ok(String(r.why ?? '').includes('没挂过'), '要说人话')
})

test('台账已经绑了会话 id 时，同一个工作区里别的会话不该被当成她（2026-10-29 真机：主会话被挂上她的身份和守卫）', () => {
  const root = tmpRoot()
  try {
    const ws = join(root, 'ws')
    mkdirSync(ws, { recursive: true })
    const at = Date.now() - 60_000
    writeFileSync(join(root, 'outings.json'), JSON.stringify({
      version: 1,
      outings: [{
        sessionId: 'session-out',
        workspaceId: 'w1',
        workspaceName: '素材',
        cwd: ws,
        startedAt: at,
        status: 'active',
        baseline: { size: 0, tailSha256: '', at },
        identity: '走的时候的我',
      }],
    }, null, 2))

    let handler = null
    const ctx = {
      on: (name, fn) => {
        if (name === 'agent/created') handler = fn
        return () => {}
      },
      get: () => undefined,
      effect: (fn) => fn,
    }
    registerIdentity(ctx, { root, herDir: join(root, 'home'), log: () => {} })
    assert.equal(typeof handler, 'function')

    const mk = (id) => {
      const sections = []
      const agent = {
        session: { header: { id, cwd: ws } },
        ctx: {
          systemPrompt: { section: (s) => { sections.push(s); return () => {} } },
          tools: { guard: () => () => {} },
          effect: (fn) => fn,
        },
      }
      return { agent, sections }
    }

    const mine = mk('session-mine')
    handler({ agent: mine.agent })
    assert.equal(mine.sections.length, 0, '同一个工作区里你自己的会话不该被挂上她的身份段')
    assert.equal(mountedCount(mine.agent), 0, '也不该挂守卫')

    const hers = mk('session-out')
    handler({ agent: hers.agent })
    assert.ok(hers.sections.length >= 2, '真正那条出门会话还是要挂身份段')
    assert.ok(mountedCount(hers.agent) >= 3, '身份、处境、手边、守卫都要在')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// 0.8.5（用户 m01579 B 案）：出门的会话也要把宿主的 coding agent 段摘掉——
// 钩子不是段，mountedCount 不变，但回家那一刻必须跟着一起拆。
function fakeAgentWithHook() {
  const sections = []
  const events = []
  let guardDisposed = 0
  let hookDisposed = 0
  const agent = {
    ctx: {
      systemPrompt: { section: (s) => { sections.push(s); return () => { sections.pop() } } },
      tools: { guard: () => () => { guardDisposed += 1 } },
      effect: (fn) => fn,
      on: (evt) => {
        events.push(evt)
        return () => { hookDisposed += 1 }
      },
    },
  }
  return { agent, sections, events, guardDisposed: () => guardDisposed, hookDisposed: () => hookDisposed }
}

test('出门时也会挂上组装钩子与正文清洗钩子，回家一起拆', () => {
  const root = tmpRoot()
  try {
    const { agent, sections, events, hookDisposed } = fakeAgentWithHook()
    assert.equal(attachIdentity(agent, root, { frozen: '走的时候的我' }).ok, true)
    assert.equal(sections.length, 3, '钩子不是段，不许占段位')
    assert.equal(mountedCount(agent), 3, 'mountedCount 只数段：身份 + 处境 + 手边')
    assert.deepEqual(events, ['system-prompt/assemble', 'llm/stream'], '组装钩子 + 正文清洗钩子')
    assert.equal(hookDisposed(), 0, '还没拆')

    const r = detachOutside(agent)
    assert.equal(r.ok, true)
    assert.equal(r.removed, 5, '三段 + 两个钩子')
    assert.equal(sections.length, 0)
    assert.equal(hookDisposed(), 2, '两个钩子都必须拆——不然回家那一刻旧钩子还挂着')
    assert.equal(mountedCount(agent), 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
