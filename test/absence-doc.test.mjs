/**
 * absence-doc.test.mjs —— 身份文件里的冷落天数，和算出来的那个数一起变。
 *
 * absence 写得晚（电脑关着、睡着，过了门槛才写）时，detectAbsence 的天数和 derive 的天数
 * 不在同一时刻跳。身份文件只有前者变的时候才重写，就会把 derive 的旧数再写一遍，然后等一天。
 * 判断要不要重写时不能调 deriveSelf：tick 每分钟一次，主动说话关着时特意不算它。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startScheduler } from '../lib/scheduler.js'
import { paths, writeConfig } from '../lib/store.js'
import { normalizeConfig, dateKey } from '../lib/settings.js'
import { selfDocPath, writeSelfDoc } from '../lib/selfdoc.js'

const DAY = 86400000
const MIN = 60000
const iso = (ms) => new Date(ms).toISOString()

test('天数涨了、他回来了，身份文件都跟着 derive 的数重写，不落后一天', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-absence-doc-'))
  const realNow = Date.now
  const realHomes = process.env.DSH_FISH_HOMES
  process.env.DSH_FISH_HOMES = join(root, 'homes.json')
  const base = realNow()
  // derive 这一刻读 2，三分钟之后跳到 3；detectAbsence 这段时间一直是 3，不会变。
  const absTs = base - DAY + 2 * MIN
  const lastSeen = absTs - 2 * DAY - 6 * 3600000
  await writeConfig(normalizeConfig({ window: ['00:00', '23:59'], browse: { enabled: false }, comment: { enabled: false }, rules: { offers: false }, memory: { sleepEveryDays: 0 }, interest: { enabled: false } }), root)
  const rest = (ms) => ({ id: `ev_r${ms}`, type: 'meta', text: `rest:${dateKey(new Date(ms))}`, ts: iso(lastSeen), day: 0, stage: 1, source: 'system' })
  const lines = [
    { id: 'ev_s', type: 'seed', text: '起点。', ts: iso(lastSeen - 20 * DAY), day: 1, stage: 1, source: 'system' },
    { id: 'ev_seen', type: 'meta', text: `seen:${iso(lastSeen)}`, ts: iso(lastSeen), day: 5, stage: 1, source: 'system' },
    { id: 'ev_abs', type: 'absence', text: '他有 2 天没出现。', days: 2, ts: iso(absTs), day: 7, stage: 1, source: 'system' },
    // 请假：tick 冷落检测之后就停，不叫醒。跨零点也一样
    rest(base), rest(base + DAY),
  ]
  await writeFile(paths(root).events, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  await writeSelfDoc(root)
  const doc = async () => (await readFile(selfDocPath(root), 'utf8')).match(/他有 (\d+) 天没出现/)?.[1]

  let offset = 0
  Date.now = () => realNow() + offset
  const s = startScheduler({ on: () => () => {}, sessionController: {} }, { root, sessionId: 's-main', log: () => {} })
  try {
    assert.equal(await doc(), '2')
    await s.tick()
    assert.equal(await doc(), '2', '第一拍只记下现在的数')

    offset = 3 * MIN
    await s.tick()
    assert.equal(await doc(), '3', 'derive 跳到 3 就要重写')

    offset = 4 * MIN
    await appendFile(paths(root).events, JSON.stringify({ id: 'ev_back', type: 'meta', text: `seen:${iso(Date.now())}`, ts: iso(Date.now()), day: 8, stage: 1, source: 'system' }) + '\n')
    await s.tick()
    assert.equal(await doc(), undefined, '他回来了，那句要撤掉')
  } finally {
    s.dispose()
    Date.now = realNow
    if (realHomes === undefined) delete process.env.DSH_FISH_HOMES
    else process.env.DSH_FISH_HOMES = realHomes
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
