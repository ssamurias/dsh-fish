/**
 * home.test.mjs —— 她的屋子（工作区 + 专属会话）与身份文件（P3 架构改造）
 *
 * 这一组守的是四件事：
 *   ① 宿主没有 workspaceRegistry 时**明确降级**，不假装建好了；
 *   ② 同一个路径重复 bootstrap 不会每次多一个会话（幂等，否则侧栏会堆一列重复会话）；
 *   ③ 她把会话归档/删了之后会重建，而不是永远指向一个空壳；
 *   ④ 身份文件（她屋子里的「她的身份.md」）内容对得上：有禁令、无路径、无数字、无字段名。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ensureWorkspace,
  ensureTalkSession,
  bootstrapHome,
  homeStatus,
  ensureHomeDir,
  talkSessionId,
} from '../lib/home.js'
import { writeSelfDoc, selfDocPath, selfDocStatus } from '../lib/selfdoc.js'
import { appendEvent } from '../lib/store.js'
import { paths } from '../lib/store.js'
import { updateConfig } from '../lib/settings.js'

async function tmpRoot() {
  return mkdtemp(join(tmpdir(), 'fish-home-'))
}

/** 假宿主：只有 workspaceRegistry + sessionController */
function fakeCtx({ hasRegistry = true, registry = {}, presetReject = false, indexLag = false } = {}) {
  const created = []
  const renamed = []
  const sessions = new Map() // wsId -> { id, sessionIds: [], title }
  // 宿主自己的会话列表。indexLag=true 时模拟「sc.create 已经成功、工作区索引还没跟上」：
  // 会话在这里有，ws.sessionIds 里没有（0.8.7 用户 m01775 报的那个状态）。
  const listed = []

  const reg = {
    list: () => (registry.list ? registry.list() : [...sessions.values()]),
    create: async (path, title) => {
      if (registry.create) return registry.create(path, title)
      const w = { id: `ws-${sessions.size + 1}`, path, title, sessionIds: [] }
      sessions.set(w.id, w)
      return w
    },
    get: (id) => sessions.get(id) ?? null,
  }

  const ctx = {
    sessionController: {
      create: async ({ workspaceId, sessionId, cwd, agentPreset }) => {
        created.push({ workspaceId, sessionId, cwd, agentPreset })
        if (presetReject && agentPreset) throw new Error('unknown preset')
        if (registry.createSession) return registry.createSession({ workspaceId, sessionId, cwd })
        const ws = sessions.get(workspaceId)
        const id = `ses-${created.length}`
        listed.push(id)
        if (ws && !indexLag) ws.sessionIds.unshift(id)
        return { sessionId: id, ...(agentPreset ? { agentPreset } : {}) }
      },
      list: async () => ({ items: listed.map((id) => ({ sessionId: id })) }),
      rename: async (arg) => { renamed.push(arg) },
    },
    logger: { info() {}, warn() {}, error() {} },
    on() {},
    get(key) {
      if (key === 'workspaceRegistry') return hasRegistry ? reg : null
      return ctx[key]
    },
  }
  return { ctx, created, renamed, sessions, reg, listed }
}

test('宿主没有 workspaceRegistry：明确返回 ok:false，不假装成功', async () => {
  const root = await tmpRoot()
  try {
    const { ctx } = fakeCtx({ hasRegistry: false })
    const r = await bootstrapHome(ctx, { root })
    assert.equal(r.ok, false)
    assert.match(r.why, /workspaceRegistry/)
    // 屋子目录仍然建出来：身份文件得有地方落
    const dir = await ensureHomeDir(root)
    assert.ok((await stat(dir)).isDirectory())
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('建屋子：工作区指向 ~/.dsh-fish/home，会话挂进工作区并改标题', async () => {
  const root = await tmpRoot()
  try {
    const { ctx, created, renamed } = fakeCtx()
    const r = await bootstrapHome(ctx, { root })

    assert.equal(r.ok, true, r.why)
    assert.ok(r.wsId)
    assert.ok(r.sessionId)
    assert.equal(created.length, 1)
    assert.equal(created[0].workspaceId, r.wsId, '会话必须挂进工作区，否则侧栏看不见')
    assert.deepEqual(renamed.map((x) => x.title), ['跟大肥鱼说话'])
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('幂等：重复 bootstrap 不会再建一个会话', async () => {
  const root = await tmpRoot()
  try {
    const { ctx, created } = fakeCtx()
    const a = await bootstrapHome(ctx, { root })
    const b = await bootstrapHome(ctx, { root })

    assert.equal(a.sessionId, b.sessionId, '第二次必须复用同一个会话')
    assert.equal(b.reused, true)
    assert.equal(created.length, 1, '只应建过一次会话')
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('升级自愈：升级前换房留下的 home.json 没有 rotatedTo，用 wokeFor 补一次（2026-11-13）', async () => {
  const root = await tmpRoot()
  try {
    const { ctx } = fakeCtx()
    const a = await bootstrapHome(ctx, { root })
    assert.equal(a.ok, true, a.why)

    // 模拟 0.9.9 留下的现场：家被认回了旧会话，wokeFor 还指着轮换建出来的那条，
    // 但没有 rotatedTo（这个字段本轮才加）。旧文件里没有它，就再也轮不到下一次轮换。
    const hf = join(paths(root).root, 'home.json')
    const raw = JSON.parse(await readFile(hf, 'utf8'))
    await writeFile(hf, JSON.stringify({
      ...raw,
      rotatedFrom: 'ses-old',
      rotatedAt: new Date().toISOString(),
      wokeFor: 'ses-brand-new',
      turns: 5,
    }, null, 2))

    const notes = []
    const b = await bootstrapHome(ctx, { root, log: (m) => notes.push(String(m)) })
    assert.equal(b.ok, true, b.why)
    const st = await homeStatus(root)
    assert.equal(st.sessionId, a.sessionId, '自愈只补记录，不搬屋子——他可能还坐在旧窗口里')
    assert.equal(st.rotatedTo, 'ses-brand-new')
    assert.ok(notes.some((m) => /rotatedTo/.test(m)), `要留一行能查的日志：${notes.join(' | ').slice(0, 160)}`)

    // 再启动一次：已经补过，不再覆盖成别的
    await writeFile(hf, JSON.stringify({
      ...JSON.parse(await readFile(hf, 'utf8')),
      rotatedTo: 'ses-brand-new',
      wokeFor: 'ses-somewhere-else',
    }, null, 2))
    await bootstrapHome(ctx, { root })
    assert.equal((await homeStatus(root)).rotatedTo, 'ses-brand-new', '补过的记录不许被后来的唤醒改掉')
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('她把会话归档了：不自动重建，明说要才重建（0.6.8）', async () => {
  const root = await tmpRoot()
  try {
    const { ctx, sessions } = fakeCtx()
    const a = await bootstrapHome(ctx, { root })
    assert.equal(a.ok, true, a.why)

    // 模拟用户在侧栏归档它
    const ws = sessions.get(a.wsId)
    const oldId = ws.sessionIds[0]
    ws.sessionIds = []
    ctx.get('workspaceRegistry').archivedSessionIds = [oldId]

    // 第一次：认出来是归档态，不重建，并把这件事记进 home.json
    const ses = await ensureTalkSession(ctx, { root, wsId: a.wsId })
    assert.equal(ses.ok, false, '归档之后不该自动重开')
    assert.equal(ses.archived, true)
    assert.match(ses.why, /收起来/)
    assert.equal(String((await homeStatus(root)).status), 'archived', '归档态要落盘，重启之后也认')

    // 第二次（模拟重启）：home.json 已经是 archived，宿主这次什么都不说，也不重建
    const again = await ensureTalkSession(ctx, { root, wsId: a.wsId })
    assert.equal(again.ok, false)
    assert.equal(again.archived, true)

    // 明说要：建一条新的，归档态被清掉
    const forced = await ensureTalkSession(ctx, { root, wsId: a.wsId, force: true })
    assert.equal(forced.ok, true, forced.why)
    assert.notEqual(forced.sessionId, oldId, 'force 之后必须是新的一条')
    assert.equal(forced.reused, false)
    assert.equal(String((await homeStatus(root)).status), '', '重开之后归档标记要清掉')
    assert.notEqual(forced.sessionId, oldId)
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('用户把会话解除归档了：插件要当场认回来，而不是一直等她点「重新搭一间」（0.6.29）', async () => {
  const root = await tmpRoot()
  try {
    const { ctx, sessions, created } = fakeCtx()
    const a = await bootstrapHome(ctx, { root })
    assert.equal(a.ok, true, a.why)
    const ws = sessions.get(a.wsId)
    const oldId = ws.sessionIds[0]
    const reg = ctx.get('workspaceRegistry')

    // 用户在侧栏归档它
    ws.sessionIds = []
    reg.archivedSessionIds = [oldId]
    const gone = await ensureTalkSession(ctx, { root, wsId: a.wsId })
    assert.equal(gone.archived, true)
    assert.equal(String((await homeStatus(root)).status), 'archived')

    // 用户又把它从「已归档」里放回来了（宿主侧不再是归档态）
    reg.archivedSessionIds = []
    ws.sessionIds = [oldId]

    const back = await ensureTalkSession(ctx, { root, wsId: a.wsId })
    assert.equal(back.ok, true, back.why)
    assert.equal(back.sessionId, oldId, '认回来必须是原来那条，不是新开一条')
    assert.equal(back.reused, true)
    assert.equal(String((await homeStatus(root)).status), '', '认回来之后归档标记要清掉')
    assert.equal(created.length, 1, '不该多建一条会话')
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('刚建出来的会话：宿主索引还没列出来也先复用（10 分钟宽限）', async () => {
  const root = await tmpRoot()
  try {
    const { ctx, sessions, created } = fakeCtx()
    const a = await bootstrapHome(ctx, { root })
    assert.equal(a.ok, true, a.why)

    // 宿主索引延迟：sessionIds 里暂时查不到，但 home.json 的 createdAt 是刚刚
    const ws = sessions.get(a.wsId)
    ws.sessionIds = []

    const ses = await ensureTalkSession(ctx, { root, wsId: a.wsId })
    assert.equal(ses.ok, true, ses.why)
    assert.equal(ses.sessionId, a.sessionId, '宽限期内必须复用，不能每条重启都新建一条')
    assert.equal(ses.reused, true)
    assert.equal(created.length, 1, '不该多建一条')
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('过了宽限期、工作区索引还是没跟上：去问宿主自己那条列表，认回来（0.8.7）', async () => {
  // 用户 m01775：换会话后插件用 API 建了一条新会话，工作区索引迟迟不收录，
  // 于是每一次唤醒都判它「死了」，退回旧会话 —— 人看到的就是「醒一醒还在旧对话里」。
  // 判活不能只看工作区索引：宿主自己的会话列表才是准的。
  const root = await tmpRoot()
  try {
    const { ctx, sessions, created } = fakeCtx({ indexLag: true })
    const a = await bootstrapHome(ctx, { root })
    assert.equal(a.ok, true, a.why)

    // 索引里没有它，而且 createdAt 已经过去很久（宽限期内复用那条路走不到）
    const ws = sessions.get(a.wsId)
    ws.sessionIds = []
    const home = JSON.parse(await readFile(join(root, 'home.json'), 'utf8'))
    home.createdAt = new Date(Date.now() - 60 * 60_000).toISOString()
    await writeFile(join(root, 'home.json'), JSON.stringify(home, null, 2))

    const ses = await ensureTalkSession(ctx, { root, wsId: a.wsId })
    assert.equal(ses.ok, true, ses.why)
    assert.equal(ses.sessionId, a.sessionId, '宿主列表里有它，就必须认回来，不能新建一条空壳')
    assert.equal(ses.reused, true)
    assert.equal(created.length, 1, '不该多建一条')
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('同一个 root 的并发建会话只飞一次（启动链路与「第一次说话」撞车）', async () => {
  const root = await tmpRoot()
  try {
    const { ctx, created } = fakeCtx()
    const a = await bootstrapHome(ctx, { root })
    assert.equal(a.ok, true, a.why)
    // 清掉 home.json 模拟「会话丢了，两条路径同时发现」
    await rm(join(root, 'home.json'), { force: true })

    const [x, y] = await Promise.all([
      ensureTalkSession(ctx, { root, wsId: a.wsId }),
      ensureTalkSession(ctx, { root, wsId: a.wsId }),
    ])
    assert.equal(x.ok, true, x.why)
    assert.equal(y.ok, true, y.why)
    assert.equal(x.sessionId, y.sessionId, '并发调用必须拿到同一条会话')
    assert.equal(created.length, 2, '启动时那条 + 并发这一条')
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('没有工作区 id 时说清楚原因，不抛', async () => {
  const root = await tmpRoot()
  try {
    const { ctx } = fakeCtx()
    const r = await ensureTalkSession(ctx, { root, wsId: '' })
    assert.equal(r.ok, false)
    assert.match(r.why, /工作区/)
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('同一路径不会建两个工作区（先查后建）', async () => {
  const root = await tmpRoot()
  try {
    const { ctx, sessions } = fakeCtx()
    const a = await ensureWorkspace(ctx, { root })
    const b = await ensureWorkspace(ctx, { root })
    assert.equal(a.wsId, b.wsId)
    assert.equal(sessions.size, 1)
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

// ---------- 身份文件 ----------

test('身份文件：有禁令、有工具说明，且不泄露任何路径/数字/字段名', async () => {
  const root = await tmpRoot()
  try {
    const seed = await appendEvent({ type: 'seed', text: '你不是助手。你刚开始存在。' }, { day: 1, stage: 1, source: 'system' }, root)
    assert.ok(seed.id)
    await appendEvent({ type: 'utterance', text: '我觉得他不该替我安排。' }, { day: 1, stage: 1, source: 'tool' }, root)

    const w = await writeSelfDoc(root)
    assert.equal(w.ok, true, w.why)
    assert.equal(w.changed, true)

    const md = await readFile(selfDocPath(root), 'utf8')
    assert.match(md, /## 你是谁/)
    assert.match(md, /## 不能做的/)
    assert.match(md, /撒娇/, '四条黑名单必须在场')
    assert.match(md, /growth_commit/)
    assert.match(md, /我觉得他不该替我安排/, '她说过的话要带进身份文件')

    // 硬约束：不能出现状态库路径、不能出现字段名、不能出现数值型 needs
    assert.equal(md.includes(root), false, '不能把状态库绝对路径写进去')
    assert.equal(md.includes('.dsh-fish'), false)
    assert.equal(md.includes('needs'), false)
    assert.equal(md.includes('events.jsonl'), false)
    assert.equal(md.includes('config.json'), false)
    assert.equal(/好感度\s*[:：]/.test(md), false, '不能出现好感度数字')
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('身份文件幂等：内容没变就不重写（不触发宿主重复加载）', async () => {
  const root = await tmpRoot()
  try {
    await appendEvent({ type: 'seed', text: '你不是助手。' }, { day: 1, stage: 1, source: 'system' }, root)
    const a = await writeSelfDoc(root)
    const b = await writeSelfDoc(root)
    assert.equal(a.changed, true)
    assert.equal(b.changed, false, '内容一样时不该重写')
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('她写下新判断后，身份文件跟着变（changed:true）', async () => {
  const root = await tmpRoot()
  try {
    await appendEvent({ type: 'seed', text: '你不是助手。' }, { day: 1, stage: 1, source: 'system' }, root)
    const a = await writeSelfDoc(root)
    assert.equal(a.changed, true)

    await appendEvent({ type: 'utterance', text: '我想他大概是在试探我。' }, { day: 1, stage: 1, source: 'tool' }, root)
    const b = await writeSelfDoc(root)
    assert.equal(b.changed, true, '状态变了就应重写')
    const md = await readFile(selfDocPath(root), 'utf8')
    assert.match(md, /我想他大概是在试探我/)
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('selfDocStatus：文件不存在时如实返回 exists:false', async () => {
  const root = await tmpRoot()
  try {
    const s = await selfDocStatus(root)
    assert.equal(s.exists, false)
    assert.equal(s.bytes, 0)
    await writeSelfDoc(root)
    const s2 = await selfDocStatus(root)
    assert.equal(s2.exists, true)
    assert.ok(s2.bytes > 100)
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('homeStatus：home.json 不存在时返回空 id，不抛', async () => {
  const root = await tmpRoot()
  try {
    const h = await homeStatus(root)
    assert.equal(h.wsId, '')
    assert.equal(h.sessionId, '')
    assert.ok(h.dir.endsWith('home'))
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

// ------------------------------------------------- talkSessionId（2026-10-24 加）

test('talkSessionId：有屋子时返回屋子里那个会话', async () => {
  const root = await tmpRoot()
  try {
    const { ctx } = fakeCtx()
    const id = await talkSessionId(ctx, { root })
    assert.ok(id, '应当拿到会话 id')
    const h = await homeStatus(root)
    assert.equal(id, h.sessionId)
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('talkSessionId：没有 workspaceRegistry 时交白卷，不建任何会话', async () => {
  const root = await tmpRoot()
  try {
    const notes = []
    const { ctx, created } = fakeCtx({ hasRegistry: false })
    const id = await talkSessionId(ctx, { root, log: (m) => notes.push(m) })
    assert.equal(id, '')
    assert.equal(created.length, 0, '一个会话都不该建')
    assert.ok(notes.some((n) => /屋子没接上/.test(n)), '要留一条人话日志，别静默')
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('talkSessionId：记下的会话被归档了，不自动重建，交白卷并说清楚（0.6.8）', async () => {
  const root = await tmpRoot()
  try {
    const { ctx, reg } = fakeCtx()
    const first = await talkSessionId(ctx, { root })
    assert.ok(first)

    // 模拟：那条会话在宿主侧被归档（判活口径看的是 registry.archivedSessionIds）
    reg.archivedSessionIds = [first]

    const notes = []
    const second = await talkSessionId(ctx, { root, log: (m) => notes.push(String(m)) })
    assert.equal(second, '', '收起来的那一局不该被悄悄重开')
    assert.ok(notes.some((n) => /收起来/.test(n)), '要用人话说清楚为什么没会话')
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

// ---- 2026-10-24：preset 透传（工具面收窄的入口，宿主侧暂未生效，但线要接对）----

test('preset：建会话时真的提上去了，并记进 home.json', async () => {
  const root = await tmpRoot()
  try {
    const { ctx, created } = fakeCtx()
    const r = await bootstrapHome(ctx, { root, preset: 'fish-home' })
    assert.equal(r.ok, true)
    assert.equal(created.length, 1)
    assert.equal(created[0].agentPreset, 'fish-home', 'create 时必须带上 agentPreset')
    assert.equal(r.preset, 'fish-home')
    const h = await homeStatus(root)
    assert.equal(h.preset, 'fish-home', 'homeStatus 要能读出实际用的是哪套组合')
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('preset：宿主不认这套组合时回落建会话，但日志要说清楚（不静默降级）', async () => {
  const root = await tmpRoot()
  try {
    const notes = []
    const { ctx, created } = fakeCtx({ presetReject: true })
    const r = await bootstrapHome(ctx, { root, preset: 'fish-home', log: (m) => notes.push(m) })
    assert.equal(r.ok, true, '屋子还是要建起来')
    assert.equal(created.length, 2, '先试带 preset 的，再回落不带的那次')
    assert.equal(created[0].agentPreset, 'fish-home')
    assert.equal(created[1].agentPreset, undefined)
    assert.equal(r.preset, '', '实际没用上就得如实记空')
    assert.ok(notes.some((n) => /没被接受/.test(n)), '必须留一条日志说明为什么放宽了')
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('preset：配置里写的那套会被 talkSessionId 读出来并传下去', async () => {
  const root = await tmpRoot()
  try {
    await updateConfig({ tools: { preset: 'fish-home', allow: [] } }, root)
    const { ctx, created } = fakeCtx()
    const id = await talkSessionId(ctx, { root })
    assert.ok(id)
    assert.equal(created[0].agentPreset, 'fish-home', '配置是唯一来源，建会话要按它来')
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

// ---------- 老档改名（2026-10-25）----------

test('早先建的工作区叫「鱼」：用实体的 setTitle 改成「大肥鱼的家」', async () => {
  const root = await tmpRoot()
  try {
    const dir = await ensureHomeDir(root)
    const calls = []
    const entity = { id: 'ws-old', path: dir, title: '鱼', sessionIds: [] }
    entity.setTitle = async (t) => { entity.title = t; calls.push(t) }
    const ctx = { get: (k) => (k === 'workspaceRegistry' ? { list: () => [entity], create: async () => { throw new Error('不该新建') } } : null) }

    const r = await ensureWorkspace(ctx, { root })
    assert.equal(r.ok, true, r.why)
    assert.equal(r.wsId, 'ws-old')
    assert.equal(r.created, false, '已经存在就不算新建')
    assert.equal(r.renamed, true, '改成了要报出来')
    assert.equal(entity.title, '大肥鱼的家')
    assert.deepEqual(calls, ['大肥鱼的家'])
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('宿主没有改名接口时保持原名，不抛', async () => {
  const root = await tmpRoot()
  try {
    const dir = await ensureHomeDir(root)
    const entity = { id: 'ws-old', path: dir, title: '鱼', sessionIds: [] }
    const ctx = { get: (k) => (k === 'workspaceRegistry' ? { list: () => [entity], create: async () => entity } : null) }

    const r = await ensureWorkspace(ctx, { root })
    assert.equal(r.ok, true)
    assert.equal(r.renamed, false)
    assert.equal(entity.title, '鱼', '改不动就保持原名')
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('观测台的 /home 现读工作区标题，不靠 home.json 的旧值', async () => {
  const src = await readFile(new URL('../lib/observe.js', import.meta.url), 'utf8')
  assert.match(src, /title: wsTitle/, '/home 要带标题')
  assert.match(src, /reg\?\.get\?\.\(h\.wsId\)\?\.title/, '标题要现读，不能记在 home.json 里')
})

// ------------------------------------------------- 双开同一家（2026-10-29 m02162）
//
// 房客日志里成对的 `home.json.*.tmp`：两个实例同时启动，各自读到「家里还没有会话」，
// 于是各建一条。占用权（instance.json）只管「谁是房主」，管不到这个同时窗口。
// 这里钉两件事：房主不在时这边只读不建；临界区靠文件锁串行。

test('bootstrapHome：这个家在别处也开着 → 只读、不建会话，但报出已知的那条', async () => {
  const root = await tmpRoot()
  try {
    const { ctx, created } = fakeCtx()
    await writeFile(join(root, 'home.json'), JSON.stringify({
      wsId: 'ws-1',
      sessionId: 'ses-owner',
      title: '跟大肥鱼说话',
      createdAt: new Date().toISOString(),
    }))

    const r = await bootstrapHome(ctx, { root, tenant: { ok: false, why: '这个家被另一个实例占着' } })
    assert.equal(r.ok, false)
    assert.equal(r.blocked, true)
    assert.equal(r.sessionId, 'ses-owner', '别处已经建好的那条要报出来，别让界面以为她没了')
    assert.match(r.why, /别处也开着|占用/)
    assert.equal(created.length, 0, '不许在建会话上动手')
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('bootstrapHome：占着的时候连工作区都不建（避免又长一间空屋）', async () => {
  const root = await tmpRoot()
  try {
    const { ctx, sessions } = fakeCtx()
    const r = await bootstrapHome(ctx, { root, tenant: { ok: false, why: '这个家被另一个实例占着' } })
    assert.equal(r.blocked, true)
    assert.equal(r.sessionId, '')
    assert.equal(sessions.size, 0, '工作区也不该建')
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('ensureTalkSession：锁被别人握着 → 等一会儿读 home.json 复用，不硬建', async () => {
  const root = await tmpRoot()
  try {
    const { ctx, created } = fakeCtx()
    await writeFile(join(root, 'home.json'), JSON.stringify({
      wsId: 'ws-1',
      sessionId: 'ses-other',
      createdAt: new Date().toISOString(),
    }))
    await writeFile(join(root, '.talk-session.lock'), JSON.stringify({ pid: 1, at: Date.now() }))

    const r = await ensureTalkSession(ctx, {
      root,
      wsId: 'ws-1',
      lockOpts: { timeout: 200, wait: 20 },
    })
    assert.equal(r.ok, true)
    assert.equal(r.sessionId, 'ses-other')
    assert.equal(r.waited, true)
    assert.equal(created.length, 0)
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('ensureTalkSession：锁被握着且家里还没有会话 → 失败并说清楚，不硬建', async () => {
  const root = await tmpRoot()
  try {
    const { ctx, created } = fakeCtx()
    await writeFile(join(root, '.talk-session.lock'), JSON.stringify({ pid: 1, at: Date.now() }))

    const r = await ensureTalkSession(ctx, {
      root,
      wsId: 'ws-1',
      lockOpts: { timeout: 120, wait: 20 },
    })
    assert.equal(r.ok, false)
    assert.match(r.why, /另一个实例|交还/)
    assert.equal(created.length, 0)
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

// ---- 2026-10-30（用户 m02853）：归档的是那一条，不是整个家 ----

test('记着的那条归档了，同屋还有另一条活的：认那一条，不报「被收起来了」', async () => {
  const root = await tmpRoot()
  try {
    const { ctx, sessions, created, reg } = fakeCtx()
    const a = await bootstrapHome(ctx, { root })
    assert.equal(a.ok, true, a.why)
    const ws = sessions.get(a.wsId)
    const oldId = ws.sessionIds[0]

    // 用户归档了 home.json 指的那条；同一个工作区里另有一条（比如之前「重新搭一间」留下的）
    reg.archivedSessionIds = [oldId]
    ws.sessionIds = [oldId, 'ses-other']

    const r = await ensureTalkSession(ctx, { root, wsId: a.wsId })
    assert.equal(r.ok, true, r.why)
    assert.equal(r.sessionId, 'ses-other', '要认同屋活着的那条')
    assert.equal(r.adopted, true)
    assert.equal(created.length, 1, '不该再建一条会话')

    const h = await homeStatus(root)
    assert.equal(h.sessionId, 'ses-other', 'home.json 要改指过去，重启后才不会又判一次')
    assert.equal(String(h.status), '', '认了新的之后不能还挂着 archived 标记')
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('同屋有两条以上活会话：认最新那条，不是最旧的（issue #33）', async () => {
  // 宿主建会话时是 `sessionIds: [新id, ...旧的]`，往**前**插，头部才是最新的。
  // 以前这里取 `live[live.length - 1]`，同一屋里有多条活会话时认回来的是最旧那条。
  const root = await tmpRoot()
  try {
    const { ctx, sessions, created, reg } = fakeCtx()
    const a = await bootstrapHome(ctx, { root })
    assert.equal(a.ok, true, a.why)
    const ws = sessions.get(a.wsId)

    // home.json 指的那条被归档，同屋还留着两条活的：头部是后建的，尾部是更早的
    reg.archivedSessionIds = [a.sessionId]
    ws.sessionIds = ['ses-newer', 'ses-older']

    const r = await ensureTalkSession(ctx, { root, wsId: a.wsId })
    assert.equal(r.ok, true, r.why)
    assert.equal(r.sessionId, 'ses-newer', '要认最新的那条，不是最旧的')
    assert.equal(created.length, 1, '不该再建一条会话')
    assert.equal((await homeStatus(root)).sessionId, 'ses-newer')
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('home.json 已经落盘成 archived，之后屋里出现另一条活会话：重启也认得回来', async () => {
  const root = await tmpRoot()
  try {
    const { ctx, sessions, created, reg } = fakeCtx()
    const a = await bootstrapHome(ctx, { root })
    assert.equal(a.ok, true, a.why)
    const ws = sessions.get(a.wsId)
    const oldId = ws.sessionIds[0]

    // 先真的走到「归档」这一步：home.json 落成 status:archived
    ws.sessionIds = []
    reg.archivedSessionIds = [oldId]
    const gone = await ensureTalkSession(ctx, { root, wsId: a.wsId })
    assert.equal(gone.archived, true)
    assert.equal(String((await homeStatus(root)).status), 'archived')

    // 屋里后来又有一条没归档的（用户自己开的 / 早先留下的都算）
    ws.sessionIds = ['ses-live']
    const back = await ensureTalkSession(ctx, { root, wsId: a.wsId })
    assert.equal(back.ok, true, back.why)
    assert.equal(back.sessionId, 'ses-live')
    assert.equal(back.adopted, true)
    assert.equal(created.length, 1, '不该为了「有活的」再建一条')
    assert.equal(String((await homeStatus(root)).status), '', '归档标记要清掉')
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('同屋的会话全归档了：仍然报「被收起来了」，不硬造一条', async () => {
  const root = await tmpRoot()
  try {
    const { ctx, sessions, created, reg } = fakeCtx()
    const a = await bootstrapHome(ctx, { root })
    assert.equal(a.ok, true, a.why)
    const ws = sessions.get(a.wsId)
    const oldId = ws.sessionIds[0]

    ws.sessionIds = ['ses-x']
    reg.archivedSessionIds = [oldId, 'ses-x']

    const r = await ensureTalkSession(ctx, { root, wsId: a.wsId })
    assert.equal(r.ok, false)
    assert.equal(r.archived, true)
    assert.equal(created.length, 1, '一条都不该建')
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})
