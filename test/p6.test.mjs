/**
 * P6：看过什么 / 自检 / 风控（2026-10-23 用户提的三件事）
 *
 * 这三块都是"出问题时不骗人"的设施：
 *   - 她说过某条视频，用户得能点开；
 *   - 插件到底能不能工作，别等"她今天什么都没说"再去猜；
 *   - 被 B 站限流了要记住，别重启一次就当她没被锁过。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { videoUrl, historyFromEvents, renderWatchList } from '../lib/history.js'
import { riskState, noteRisk, clearRisk, browsePlan, STRIKES_MIN } from '../lib/risk.js'
import { runChecks, peersOnMachine } from '../lib/selfcheck.js'
import { lookBeforeWake } from '../lib/scheduler.js'
import { FISH_TOOLS } from '../lib/restrict.js'

const M = (text) => ({ type: 'meta', text })

test('videoUrl 只认十个字符的 BV 号', () => {
  assert.equal(videoUrl('BV1MN4y177PB'), 'https://www.bilibili.com/video/BV1MN4y177PB')
  assert.equal(videoUrl('bv1MN4y177PB'), '')
  assert.equal(videoUrl('av123'), '')
  assert.equal(videoUrl(''), '')
})

test('historyFromEvents 按日期倒序分组，并给每条补上可点的链接', () => {
  const events = [
    M('browse:2026-10-22 [{"bvid":"BV1MN4y177PB","title":"二舅","up":"衣戈猜想","duration":600,"view":100}]'),
    M('browse:2026-10-23 [{"bvid":"BV1BK411L7DJ","title":"罗翔读书","up":"罗翔说刑法"}]'),
    M('browse:2026-10-23 [{"bvid":"BV1BK411L7DJ","title":"重复的同一条"},{"bvid":"BV1ph4y1g75E","title":"火柴人VS数学"}]'),
  ]
  const groups = historyFromEvents(events, { days: 14 })
  assert.equal(groups.length, 2)
  assert.equal(groups[0].date, '2026-10-23') // 新的在前
  assert.equal(groups[0].items.length, 2)     // 同一天重复的 BV 只留一条
  assert.equal(groups[0].items[0].url, 'https://www.bilibili.com/video/BV1BK411L7DJ')
  assert.equal(groups[1].items[0].up, '衣戈猜想')
})

test('historyFromEvents 遇到坏行不崩，只是少那一条', () => {
  const events = [
    M('browse:2026-10-23 [{"bvid":"BV1ph4y1g75E"}'),
    M('browse:not-a-date []'),
    M('looked:BV1ED4y1Y7dc'),
    M('browse:2026-10-23 [{"bvid":"BV1ED4y1Y7dc","title":"影视飓风"}]'),
  ]
  const groups = historyFromEvents(events)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].items.length, 1)
})

test('renderWatchList 给标题与链接，但绝不替她标重点', () => {
  const txt = renderWatchList([
    { bvid: 'BV1MN4y177PB', title: '二舅', up: '衣戈猜想' },
    { bvid: 'BV1BK411L7DJ', title: '罗翔读书' },
  ])
  assert.match(txt, /你今天翻到过的/)
  assert.match(txt, /BV1MN4y177PB/)
  assert.match(txt, /https:\/\/www\.bilibili\.com\/video\/BV1BK411L7DJ/)
  assert.doesNotMatch(txt, /重点|关键在第|分钟处/)
  assert.equal(renderWatchList([]), '')
})

test('风控：撞一次就冷却，且罚则逐次加长', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-risk-'))
  try {
    assert.equal(riskState(root, new Date()).cooling, false)

    const t0 = new Date('2026-10-23T12:00:00Z')
    noteRisk(root, -352, t0)
    const s1 = riskState(root, t0)
    assert.equal(s1.cooling, true)
    assert.equal(s1.strikes, 1)
    assert.equal(s1.remainMin, STRIKES_MIN[0])

    // 冷却期内再撞一次：台阶升到第二级
    noteRisk(root, -412, t0)
    const s2 = riskState(root, t0)
    assert.equal(s2.strikes, 2)
    assert.equal(s2.remainMin, STRIKES_MIN[1])

    // 时间走过后自动不再冷却
    const later = new Date(t0.getTime() + (STRIKES_MIN[1] + 1) * 60_000)
    assert.equal(riskState(root, later).cooling, false)
    // 但 strikes 留着——解冻后要减半试探
    assert.equal(riskState(root, later).strikes, 2)

    clearRisk(root)
    assert.equal(riskState(root, new Date()).cooling, false)
    assert.equal(riskState(root, new Date()).strikes, 0)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('browsePlan：冷却中一条不看，刚解冻减半', () => {
  const cfg = { browse: { perDay: 2, topN: 6, deepRead: 8 } }
  assert.equal(browsePlan(cfg, { cooling: true, strikes: 0 }).skip, true)

  const warm = browsePlan(cfg, { cooling: false, strikes: 0 })
  assert.equal(warm.skip, false)
  assert.equal(warm.topN, 6)

  const careful = browsePlan(cfg, { cooling: false, strikes: 1 })
  assert.equal(careful.topN, 3)
  assert.equal(careful.deepRead, 4)
  assert.equal(careful.perDay, 1)
})

test('冷却期里她照常醒，只是没东西可看——而且会被告知，不装成没事', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-risk2-'))
  try {
    const now = new Date('2026-10-23T12:00:00Z')
    noteRisk(root, -352, now)
    const r = await lookBeforeWake(
      root,
      { name: 'x' },
      { browse: { enabled: true, perDay: 1, topN: 4, deepRead: 6 }, avoid: {} },
      '2026-10-23',
      { now, events: [], client: { popular: async () => { throw new Error('不该被调用') } } },
      () => {},
    )
    assert.equal(r.text, '')
    assert.match(r.riskNote, /不太顺/)
    assert.doesNotMatch(r.riskNote, /风控|限流|-352|接口/) // 不把技术词汇丢给她
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('自检：正常环境全绿；缺 cookie 与缺宿主接口要如实报出来', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-check-'))
  try {
    const cfg = { growthDays: 30, wakesPerDay: 1, window: ['20:00', '23:00'] }
    const good = await runChecks({
      root,
      config: cfg,
      net: false,
      now: new Date('2026-10-23T12:00:00Z'),
      host: { sessionController: {}, webServer: {}, connection: {} },
    })
    const byId = Object.fromEntries(good.items.map((x) => [x.id, x]))
    assert.equal(byId['state-dir'].ok, true)
    assert.equal(byId['host'].ok, true)
    assert.equal(byId['window'].ok, true)
    // 没存 cookie → 不算全绿，而且给出可执行的下一步
    assert.equal(byId['cookie'].ok, false)
    assert.match(byId['cookie'].fix, /粘一次 cookie/)

    const bad = await runChecks({
      root,
      config: cfg,
      net: false,
      now: new Date(),
      host: { webServer: {} },
    })
    const byId2 = Object.fromEntries(bad.items.map((x) => [x.id, x]))
    assert.equal(byId2['host'].ok, false)
    assert.match(byId2['host'].detail, /sessionController/)
    assert.match(byId2['host'].detail, /connection/)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('自检：手上的工具——以 tools.restrict 的真实结果为准，不装成收窄了', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-check-tools-'))
  try {
    const base = {
      root,
      config: { growthDays: 30, wakesPerDay: 1, window: ['20:00', '23:00'] },
      net: false,
      host: { sessionController: {}, webServer: {}, connection: {} },
    }

    // 关掉收窄：照实说"她看得到全部标准工具"，不能含糊。
    const off = await runChecks({
      ...base,
      restrictEnabled: false,
      restrict: { ok: false, applied: 0, why: 'disabled', allow: [] },
    })
    const toff = off.items.find((x) => x.id === 'tools')
    assert.equal(toff.ok, true)
    assert.match(toff.detail, /收窄是关掉的/)
    // 2026-10-30：原来这里硬断言 `/7 个/`。FISH_TOOLS 早就不是 7 个了，
    // 而且公开版与 `.dev` 开发副本的个数还不一样——硬写一个数字等于把
    // 「清单是活的」这件事钉死，改一次清单就要回来改测试。
    // 现在按实际清单算：临时 root 没有 .dev，所以是 FISH_TOOLS 去掉
    // 那个只在开发副本注册的工具（her_dream）。
    const pubCount = FISH_TOOLS.length
    assert.match(toff.detail, new RegExp(`加上我们给的 ${pubCount} 个`))

    // 已注册但还没轮到她的下一条会话：说"等下次启动"，不谎报已生效。
    const reg = await runChecks({
      ...base,
      restrictEnabled: true,
      restrict: { ok: true, applied: 0, why: 'registered', allow: ['growth_commit'] },
    })
    const treg = reg.items.find((x) => x.id === 'tools')
    assert.equal(treg.ok, true)
    assert.match(treg.detail, /等她的会话下一次启动/)

    // 真的挂上了才说收窄，并把清单摊开。
    const on = await runChecks({
      ...base,
      restrictEnabled: true,
      restrict: { ok: true, applied: 1, why: 'applied', allow: ['growth_commit', 'read_image'] },
    })
    const ton = on.items.find((x) => x.id === 'tools')
    assert.equal(ton.ok, true)
    assert.match(ton.detail, /已收窄/)
    assert.match(ton.detail, /2 个工具/)
    assert.match(ton.detail, /growth_commit/)
    assert.match(ton.detail, /read_image/)

    // 挂了但炸了：必须报红，不许静默降级成"全部工具"。
    const bad = await runChecks({
      ...base,
      restrictEnabled: true,
      restrict: { ok: false, applied: 0, why: 'failed', failed: 'requires a scoped context', allow: [] },
    })
    const tbad = bad.items.find((x) => x.id === 'tools')
    assert.equal(tbad.ok, false)
    assert.match(tbad.detail, /收窄没挂上/)
    assert.match(tbad.detail, /scoped context/)
    assert.ok(tbad.fix, '要给下一步，不能只说坏了')
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('自检：状态库写不进去要报出来，而不是等到她什么都不说', async () => {  const root = await mkdtemp(join(tmpdir(), 'fish-check2-'))
  const blocked = join(root, 'a-file')
  try {
    // 用"路径里有一段是文件"制造不可写，比权限更跨平台
    await writeFile(blocked, 'x')
    const r = await runChecks({
      root: join(blocked, 'nope'),
      config: { window: ['20:00', '23:00'] },
      net: false,
      host: { sessionController: {}, webServer: {}, connection: {} },
    })
    const st = r.items.find((x) => x.id === 'state-dir')
    assert.equal(st.ok, false)
    assert.ok(st.fix.length > 0)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('peersOnMachine：认得别的 B 站插件的状态库，但不把我们自己的算进去', async () => {
  // 用户问：装了别的大肥鱼插件，我们的设置会不会对那个生效？
  // 设置不会串（各自 config.json），但两套同时在跑会叠加请求。
  // 这条只保证「能看见别人」，不负责拦。
  const home = await mkdtemp(join(tmpdir(), 'fish-peers-'))
  try {
    for (const d of ['.dsh-fish', '.dsh-fish-backups', '.dsh-bili-whale', '.dsh-bili-scroll', 'some-other']) {
      await mkdir(join(home, d), { recursive: true })
    }
    const got = peersOnMachine(home).sort()
    assert.deepEqual(got, ['.dsh-bili-scroll', '.dsh-bili-whale'], '只看得到别的插件，我们自己的不算')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('peersOnMachine：目录读不了也不抛（自检不能因为这一项挂掉）', () => {
  assert.deepEqual(peersOnMachine('Z:\does\not\exist'), [])
})

test('browsePlan 冷却时把剩余分钟带进提示，不只说「冷却中」（反馈 4）', () => {
  const cfg = { browse: { perDay: 2, topN: 4, deepRead: 6 } }
  const t = browsePlan(cfg, { cooling: true, strikes: 0, remainMin: 17 })
  assert.equal(t.skip, true)
  assert.match(t.note, /17 分钟/)
  // 没有 remainMin 的旧调用点也不能显示 "undefined"
  const t2 = browsePlan(cfg, { cooling: true, strikes: 0 })
  assert.equal(t2.note, '风控冷却中')
})
