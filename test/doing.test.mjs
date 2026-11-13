import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DOING_DEFAULTS,
  classOf,
  itemKey,
  didText,
  parseDid,
  doingUsage,
  checkDoing,
  doingConfig,
  doingTurnOf,
  markDoingTurn,
  clearDoingTurn,
  doingSection,
  registerDoingHooks,
} from '../lib/doing.js'
import { searchEvents, renderRecall } from '../lib/recall.js'
import { readEvents } from '../lib/store.js'

const HOUR = 3600_000
const DAY = 24 * HOUR

function meta(text, ts) {
  return { type: 'meta', text, ts: new Date(ts).toISOString() }
}

function did({ cls = 'consume', tool = 'bili_look', key = 'bili_look:BV1', ok = true, ts }) {
  return meta(didText({ cls, tool, ok, key }), ts)
}

test('doingConfig 默认关，数值夹紧', () => {
  const cfg = doingConfig({})
  assert.equal(cfg.enabled, false)
  assert.equal(cfg.consumePerDay, DOING_DEFAULTS.consumePerDay)
  const tight = doingConfig({ proactive: { allowDoing: true, consumePerDay: 99, itemCooldownDays: -3 } })
  assert.equal(tight.enabled, true)
  assert.equal(tight.consumePerDay, 6)
  assert.equal(tight.itemCooldownDays, 0)
})

test('classOf：自家写死，设置覆盖，外部默认 effect', () => {
  assert.equal(classOf('bili_watch'), 'consume')
  assert.equal(classOf('her_diary'), 'produce')
  assert.equal(classOf('bili_speak'), 'effect')
  assert.equal(classOf('growth_commit'), 'self')
  assert.equal(classOf('novel_read'), 'effect')
  assert.equal(classOf('novel_read', { proactive: { toolClasses: { novel_read: 'consume' } } }), 'consume')
  assert.equal(classOf('novel_read', { proactive: { toolClasses: { novel_read: '乱写' } } }), 'effect')
})

test('itemKey：优先具体对象，路径里的冒号不截断', () => {
  assert.equal(itemKey('bili_look', { bvid: 'BV1xx' }), 'bili_look:BV1xx')
  assert.equal(itemKey('read_file', { path: 'C:\\a\\b.txt' }), 'read_file:C:\\a\\b.txt')
  assert.equal(itemKey('search', { query: '猫' }), 'search:猫')
  assert.equal(itemKey('thing', {}), 'thing')
})

test('didText / parseDid 往返，key 可以含冒号', () => {
  const text = didText({ cls: 'produce', tool: 'write', ok: true, key: 'write:C:\\out\\a.md' })
  assert.deepEqual(parseDid(text), { cls: 'produce', tool: 'write', ok: true, key: 'write:C:\\out\\a.md' })
  assert.equal(parseDid('不是 did'), null)
})

test('doingUsage：只数成功，消耗按当天算', () => {
  const now = Date.now()
  const events = [
    did({ ts: now - HOUR }),
    did({ ok: false, ts: now - HOUR }),
    did({ cls: 'produce', tool: 'her_diary', key: 'her_diary', ts: now - HOUR }),
    did({ ts: now - DAY }),
  ]
  const u = doingUsage(events, now)
  assert.equal(u.consumeToday, 1)
  assert.equal(u.byClass.consume, 2)
  assert.equal(u.byClass.produce, 1)
})

test('消耗类一天一次：第二次拦下，产出不占额度', () => {
  const now = Date.now()
  const events = [did({ ts: now - HOUR })]
  assert.equal(checkDoing({ name: 'bili_watch', args: { bvid: 'BV2' }, events, now }).code, 'daily')

  const withProduce = [did({ cls: 'produce', tool: 'her_diary', key: 'her_diary', ts: now - HOUR })]
  assert.equal(checkDoing({ name: 'bili_watch', args: { bvid: 'BV2' }, events: withProduce, now }).ok, true)
})

test('同一件冷却三天', () => {
  const now = Date.now()
  const events = [did({ ts: now - DAY })]
  const same = checkDoing({ name: 'bili_look', args: { bvid: 'BV1' }, events, now })
  assert.equal(same.code, 'item')
  const other = checkDoing({ name: 'bili_look', args: { bvid: 'BV9' }, events, now })
  assert.equal(other.ok, true)
})

test('连续三次同类，歇一周；过了一周又能做', () => {
  const now = Date.now()
  const three = [
    did({ key: 'bili_look:A', ts: now - 2 * DAY }),
    did({ key: 'bili_look:B', ts: now - 2 * DAY + HOUR }),
    did({ key: 'bili_look:C', ts: now - 2 * DAY + 2 * HOUR }),
  ]
  assert.equal(checkDoing({ name: 'bili_look', args: { bvid: 'D' }, events: three, now }).code, 'binge')

  const old = three.map((e, i) => meta(e.text, now - 8 * DAY + i * HOUR))
  assert.equal(checkDoing({ name: 'bili_look', args: { bvid: 'D' }, events: old, now }).ok, true)
})

test('关掉消耗额度时一律不做', () => {
  const out = checkDoing({ name: 'bili_look', args: { bvid: 'BV1' }, events: [], now: Date.now(), config: { proactive: { consumePerDay: 0 } } })
  assert.equal(out.ok, false)
  assert.equal(out.code, 'off')
})

test('动手回合标记只认那条会话，两小时后失效', () => {
  clearDoingTurn()
  const now = Date.now()
  assert.equal(doingTurnOf('s1', now), null)
  markDoingTurn('s1', now)
  markDoingTurn('s2', now)
  assert.equal(doingTurnOf('s1', now + 1000)?.sessionId, 's1')
  assert.equal(doingTurnOf('s2', now + 1000)?.sessionId, 's2')
  assert.equal(doingTurnOf('s3', now + 1000), null)
  assert.equal(doingTurnOf('s1', now + 3 * HOUR), null)
  markDoingTurn('s1', now)
  markDoingTurn('s2', now)
  clearDoingTurn('s1')
  assert.equal(doingTurnOf('s1', now), null)
  assert.equal(doingTurnOf('s2', now)?.sessionId, 's2')
  clearDoingTurn()
})

test('动手那句只在她的记录里点到工具名时才点名', () => {
  const tools = ['novel_read', 'game_play', 'write_code']
  const hit = doingSection({ material: [{ text: '想试试用 novel_read 把那本看完' }], tools })
  assert.match(hit, /novel_read/)
  assert.doesNotMatch(hit, /game_play/)
  const none = doingSection({ material: [{ text: '把窗台擦一擦' }], tools })
  assert.doesNotMatch(none, /novel_read|game_play|write_code/)
  assert.match(none, /做一件就收/)
  assert.match(none, /直接做/)
  assert.match(none, /不用先把这件事说出来/)
  // 便条/预约这类「悬着的事」里点到过，也算她写过
  assert.match(doingSection({ loose: [{ text: '周末想玩 game_play 那局' }], tools }), /game_play/)
})

test('便条只作她自己的材料：最多两张，不写「该做了」', () => {
  const text = doingSection({
    notes: [
      { text: '周末把字幕那篇看完' },
      { text: '想试试用 novel_read 把那本看完' },
      { text: '第三张不该出现' },
    ],
  })
  assert.match(text, /你自己记下的/)
  assert.match(text, /周末把字幕那篇看完/)
  assert.match(text, /novel_read/)
  assert.doesNotMatch(text, /第三张不该出现/)
  assert.doesNotMatch(text, /该做|到期/)
})

test('did: 能被 her_recall 翻到，并读成人话', () => {
  const now = Date.now()
  const evs = [
    { id: 'd1', type: 'meta', ts: new Date(now - HOUR).toISOString(), text: didText({ cls: 'consume', tool: 'novel_read', ok: true, key: 'novel_read:三体' }) },
    { id: 'd2', type: 'meta', ts: new Date(now - 2 * HOUR).toISOString(), text: didText({ cls: 'produce', tool: 'write_code', ok: false, key: 'write_code:排序脚本' }) },
  ]
  const { rows } = searchEvents(evs, 'novel_read', { now })
  assert.equal(rows.length, 1)
  assert.match(renderRecall(rows), /你用 novel_read 做成了一件事/)
  assert.match(renderRecall(searchEvents(evs, 'write_code', { now }).rows), /没成/)
})

test('钩子：动手回合里第二次消耗被拦，成功的才写 did:', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fish-doing-'))
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({
      proactive: { allowDoing: true, toolClasses: { novel_read: 'consume' } },
    }))
    const handlers = new Map()
    const ctx = { on: (name, fn) => { handlers.set(name, fn); return () => {} } }
    registerDoingHooks(ctx, { root })
    clearDoingTurn()
    markDoingTurn('s1', Date.now())

    const pre = handlers.get('tools/pre-execute')
    const res = handlers.get('tools/result')
    const exec = (callId) => ({
      name: 'novel_read',
      callId,
      agent: { session: 's1' },
      call: { arguments: JSON.stringify({ title: '三体' }) },
    })

    const first = await pre(exec('c1'), () => ({ ok: true }))
    assert.equal(first.ok, true, '第一件消耗放行')
    const second = await pre(exec('c2'), () => ({ ok: true }))
    assert.equal(second.kind, 'deny')
    assert.match(second.reason, /已经做过一件/)
    assert.equal(second.info.code, 'DOING_TURN')

    await res(exec('c1'), { isError: false })
    const { events } = await readEvents(root)
    const line = events.map((e) => String(e.text ?? '')).find((t) => t.startsWith('did:consume:novel_read:ok:'))
    assert.ok(line)
    assert.match(line, /三体/)
  } finally {
    clearDoingTurn()
    rmSync(root, { recursive: true, force: true })
  }
})
