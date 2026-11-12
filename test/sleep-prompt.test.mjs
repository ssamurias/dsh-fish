/**
 * sleep-prompt.test.mjs —— 「每 N 天的想一想」会不会被空醒吃掉（issue #101，2026-11-09）
 *
 * 真机：`memory.sleepEveryDays = 7`，可十几天的成长日里只响过一次（那次还是 manual-idle）。
 * 原因是两段判断互相排斥，而其中一段几乎恒真：
 *   - `lib/freewake.js` 只要旧句子摆得出来就判 `table`（空醒），而摆料对每天醒一次的机器
 *     天然成立；
 *   - `lib/scheduler.js` 那句提示被 `!free` 挡着——空醒时整段不执行，也不记 `sleep:<dk>`，
 *     这一天就这么过去了，没有「延后补发」。
 *
 * 现在倒过来：这一天先不判空醒，摆料顺延到下一次醒来，仍按正常叫醒把这句递出去。
 * 判据因此要早于「判空醒」算好，并且要能单测——所以抽成了 `sleepPromptDue()`。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import { sleepPromptDue, monthlyDue, wakeNow } from '../lib/scheduler.js'
import { growthDay } from '../lib/derive.js'
import { validateEvent } from '../lib/schema.js'
import { appendEvent, readEvents, writeConfig } from '../lib/store.js'
import { normalizeConfig, dateKey } from '../lib/settings.js'
import { clearWakeSection, getWakeSection } from '../lib/identity.js'
import { SLEEP_TODAY } from '../lib/persona.js'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'lib', 'scheduler.js'), 'utf8')

const meta = (text) => ({ type: 'meta', text })

test('成长日取模对上的那一天，就该问一次（不是自然日）', () => {
  assert.equal(sleepPromptDue({ every: 7, day: 14, dk: '2026-11-10' }), true)
  assert.equal(sleepPromptDue({ every: 7, day: 7, dk: '2026-11-03' }), true)
  // 13 天不是 7 的整数倍：本来就不该有。
  assert.equal(sleepPromptDue({ every: 7, day: 13, dk: '2026-11-09' }), false)
})

test('还没立住的那一天不问：day 1 与 every=0', () => {
  assert.equal(sleepPromptDue({ every: 1, day: 1, dk: '2026-10-28' }), false)
  assert.equal(sleepPromptDue({ every: 0, day: 14, dk: '2026-11-10' }), false)
  assert.equal(sleepPromptDue({ every: 7, day: 14, dk: '2026-11-10' }), true)
})

test('同一天递过一次就不再问（meta sleep:<dk> 兜住）', () => {
  const events = [meta('sleep:2026-11-10')]
  assert.equal(sleepPromptDue({ every: 7, day: 14, dk: '2026-11-10', events }), false)
  // 昨天递过的那个 key 不算今天。
  assert.equal(sleepPromptDue({ every: 7, day: 14, dk: '2026-11-10', events: [meta('sleep:2026-11-09')] }), true)
})

test('摆料不许顶掉这一天：table 分支与 freeWakeFor 都让开', () => {
  // 空醒几乎每天都成立；这一天要是不让开，提示就永远轮不到（issue #101 的根因）。
  assert.match(src, /if \(staleOn && !sleepDue && !dreamOn\(evs, model\.day\)\.length\)/)
  assert.match(src, /free = sleepDue \? null : freeWakeFor\(/)
  // 旧的写法（空醒里才不叠、其余时候被 `!free` 挡着）不能再回来。
  assert.doesNotMatch(src, /!\s*free && every > 0/)
})

test('判据要早于判空醒算，且这一天照常把这句推进正文', () => {
  const at = src.indexOf('const dayDue = sleepPromptDue(')
  const table = src.indexOf('if (staleOn && !sleepDue')
  assert.ok(at >= 0 && table >= 0 && at < table, 'sleepDue 必须先算、table 才判')
  // 0.9.9（S-B）：这一天除了时机句，还要把那句问法一起递出去。
  // 1.0（用户 m01648）：问哪一句由 `sleepAsk` 定（跟着素材走），月末那句由 `monthDue` 决定。
  assert.match(src, /if \(sleepDue\) \{/)
  assert.match(
    src,
    /parts\.push\('', SLEEP_TODAY, sleepPrompt\(model, \{ now: now\.getTime\(\), question: sleepAsk, monthly: monthDue \}\)\)/,
  )
  assert.match(src, /askedSleep = true/)
  // 没素材就当今天不是「想一想」的那天：sleepDue 要跟 sleepAsk 一起判。
  assert.match(src, /sleepDue = dayDue && sleepAsk\.kind !== 'none'/)
})

// ---- 成长日和本地日期对不齐：同一个成长日跨本地零点只递一次 ----
//
// growthDay 从 seed 的钟点起每 24 小时一格（lib/derive.js），不跟着本地零点翻。
// seed 在中午的话，「第 14 天」是某天 12:00 到第二天 12:00：15:00 醒一次、第二天 10:00 再醒一次，
// 两次都在第 14 天，本地日期却不一样。只按 `sleep:<dk>` 去重时两次都递「（今天停下来，想一想。）」，
// 两轮也都因此不摆旧句子。

const L = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime()
const SEED_AT = L(2026, 10, 29, 12)

test('同一个成长日跨本地零点：零点前递过，零点后不再递（真的 growthDay + 真的信封）', () => {
  const events = [validateEvent({ type: 'seed', text: '种子' }, { day: 1, stage: 1, now: SEED_AT, source: 'system' })]
  const wakeAt = (t) => {
    const day = growthDay(events, t)
    const dk = dateKey(new Date(t))
    const due = sleepPromptDue({ every: 7, day, dk, events })
    // 和 scheduler.js 里递过之后记的那一笔同一个写法
    if (due) events.push(validateEvent({ type: 'meta', text: `sleep:${dk}` }, { day, stage: 2, now: t, source: 'timer' }))
    return { day, dk, due }
  }
  assert.deepEqual(wakeAt(L(2026, 11, 11, 10)), { day: 13, dk: '2026-11-11', due: false })
  assert.deepEqual(wakeAt(L(2026, 11, 11, 15)), { day: 14, dk: '2026-11-11', due: true })
  assert.deepEqual(wakeAt(L(2026, 11, 11, 21)), { day: 14, dk: '2026-11-11', due: false })
  // 本地日期换了，成长日还是第 14 天：修之前这里是 true。
  assert.deepEqual(wakeAt(L(2026, 11, 12, 10)), { day: 14, dk: '2026-11-12', due: false })
  assert.deepEqual(wakeAt(L(2026, 11, 12, 15)), { day: 15, dk: '2026-11-12', due: false })
  // 下一个 7 的倍数那天照常递，第 14 天那一笔不挡它。
  assert.deepEqual(wakeAt(L(2026, 11, 18, 15)), { day: 21, dk: '2026-11-18', due: true })
  assert.equal(events.filter((e) => e.type === 'meta').length, 2)
})

test('月末收束：这个月真问过两次以上才加，且必须落在「想一想」那一天', () => {
  const two = [meta('sleep:2026-11-04'), meta('sleep:2026-11-11')]
  // 不是「想一想」的那天不加：它只搭那张卡，不自己排一次醒来。
  assert.equal(monthlyDue({ sleepDue: false, dk: '2026-11-18', events: two }), false)
  // 这个月只问过一次：还没攒够。
  assert.equal(monthlyDue({ sleepDue: true, dk: '2026-11-18', events: [meta('sleep:2026-11-04')] }), false)
  // 问过两次了：这一次加那句收束。
  assert.equal(monthlyDue({ sleepDue: true, dk: '2026-11-18', events: two }), true)
  // 上个月问过的不算这个月的。
  const lastMonth = [meta('sleep:2026-10-28'), meta('sleep:2026-10-21')]
  assert.equal(monthlyDue({ sleepDue: true, dk: '2026-11-04', events: lastMonth }), false)
  // 别的前缀不算（比如 `wake:` 那笔）。
  assert.equal(monthlyDue({ sleepDue: true, dk: '2026-11-18', events: [meta('wake:2026-11-04 x'), meta('wake:2026-11-11 x')] }), false)
  // 日期不成形就不认——宁可这次不加，也不能拿半个 key 去数。
  assert.equal(monthlyDue({ sleepDue: true, dk: '', events: two }), false)
})

test('信封 day 认数字也认数字串；别的成长日的、不是 sleep: 的不算', () => {
  const m = (text, day) => ({ type: 'meta', text, day })
  assert.equal(sleepPromptDue({ every: 7, day: 14, dk: '2026-11-12', events: [m('sleep:2026-11-11', 14)] }), false)
  assert.equal(sleepPromptDue({ every: 7, day: 14, dk: '2026-11-12', events: [m('sleep:2026-11-11', '14')] }), false)
  assert.equal(sleepPromptDue({ every: 7, day: 14, dk: '2026-11-12', events: [m('sleep:2026-11-04', 7)] }), true)
  assert.equal(sleepPromptDue({ every: 7, day: 14, dk: '2026-11-12', events: [m('wake:2026-11-11 x', 14), m('table:2026-11-11', 14)] }), true)
  assert.equal(sleepPromptDue({ every: 7, day: 14, dk: '2026-11-12', events: [{ type: 'utterance', text: 'sleep:2026-11-11', day: 14 }] }), true)
  // 没带 day 的记录只按日期认（和原来一样）
  assert.equal(sleepPromptDue({ every: 7, day: 14, dk: '2026-11-12', events: [m('sleep:2026-11-11')] }), true)
  assert.equal(sleepPromptDue({ every: 7, day: 14, dk: '2026-11-12', events: [m('sleep:2026-11-12')] }), false)
})

test('真的叫醒两次（零点前、零点后，同一个成长日）：「想一想」只递一次，只记一笔', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'fish-sleep-'))
  const oldHomes = process.env.DSH_FISH_HOMES
  process.env.DSH_FISH_HOMES = join(root, 'homes.json')
  t.mock.timers.enable({ apis: ['Date'], now: SEED_AT })
  const prompts = []
  const ctx = {
    on: () => () => {},
    sessionController: {
      create: async () => { throw new Error('exists') },
      // 叫醒的正文挂在处境段里（递进去那一刻的那份），消息本身只是个引子：两处都收着看。
      resolveAgent: async () => ({
        agent: { followup: (message) => { prompts.push([message?.content?.[0]?.text ?? '', getWakeSection()].join('\n')) } },
      }),
    },
  }
  try {
    await writeConfig(normalizeConfig({
      window: ['00:00', '23:59'],
      browse: { enabled: false },
      comment: { enabled: false },
      rules: { offers: false },
      interest: { enabled: false },
      memory: { sleepEveryDays: 7 },
    }), root)
    await appendEvent({ type: 'seed', text: '种子' }, { day: 1, stage: 1, source: 'system' }, root)
    // 1.0（用户 m01648）：没素材就不递卡——先放一句她说的话，窗口里才有东西可问。
    await appendEvent({ type: 'utterance', text: '今天不太想解释' }, { day: 13, stage: 2, source: 'system' }, root)

    const wakeAt = async (ms) => {
      t.mock.timers.setTime(ms)
      const before = prompts.length
      const r = await wakeNow(ctx, { root, sessionId: 's-main', log: () => {} })
      assert.equal(r.ok, true, r.why)
      assert.equal(prompts.length, before + 1, '这一次要真的递进去')
      clearWakeSection()
      return prompts[prompts.length - 1]
    }
    const first = await wakeAt(L(2026, 11, 11, 15))
    assert.ok(first.includes(SLEEP_TODAY), '第 14 天头一次叫醒要带这句')
    const second = await wakeAt(L(2026, 11, 12, 10))
    assert.ok(!second.includes(SLEEP_TODAY), '还是第 14 天，本地日期换了也不再递')

    const { events } = await readEvents(root)
    const marks = events.filter((e) => e.type === 'meta' && String(e.text).startsWith('sleep:'))
    assert.deepEqual(marks.map((e) => [e.text, e.day]), [['sleep:2026-11-11', 14]])
    assert.equal(events.filter((e) => e.type === 'meta' && /^wake:2026-11-1[12] /.test(String(e.text))).length, 2)
  } finally {
    t.mock.timers.reset()
    clearWakeSection()
    if (oldHomes === undefined) delete process.env.DSH_FISH_HOMES
    else process.env.DSH_FISH_HOMES = oldHomes
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

// 1.0（用户 m01648 / m01650）：月末那句收束只在「这个月已经真问过两次以上」时加。
// 只测函数不够：这条的风险在接线——卡上到底加没加，要真递一次才看得见。
test('真机叫醒：这个月已经问过两次，这次多一句收束（不再写 monthnar）', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'fish-month-'))
  const oldHomes = process.env.DSH_FISH_HOMES
  process.env.DSH_FISH_HOMES = join(root, 'homes.json')
  t.mock.timers.enable({ apis: ['Date'], now: SEED_AT })
  const prompts = []
  const ctx = {
    on: () => () => {},
    sessionController: {
      create: async () => { throw new Error('exists') },
      resolveAgent: async () => ({
        agent: { followup: (message) => { prompts.push([message?.content?.[0]?.text ?? '', getWakeSection()].join('\n')) } },
      }),
    },
  }
  try {
    await writeConfig(normalizeConfig({
      window: ['00:00', '23:59'],
      browse: { enabled: false },
      comment: { enabled: false },
      rules: { offers: false },
      interest: { enabled: false },
      memory: { sleepEveryDays: 7 },
    }), root)
    await appendEvent({ type: 'seed', text: '种子' }, { day: 1, stage: 1, source: 'system' }, root)
    // 这个自然月里已经问过两次（第 7 天、第 13 天），今天（第 14 天）是第三次。
    await appendEvent({ type: 'meta', text: 'sleep:2026-11-04' }, { day: 7, stage: 2, source: 'timer' }, root)
    await appendEvent({ type: 'meta', text: 'sleep:2026-11-10' }, { day: 13, stage: 2, source: 'timer' }, root)
    // 素材：上一次想一想之后她说过话（否则按新规则这张卡不递）。
    await appendEvent({ type: 'utterance', text: '今天不太想解释' }, { day: 13, stage: 2, source: 'system' }, root)

    const wakeAt = async (ms) => {
      t.mock.timers.setTime(ms)
      const before = prompts.length
      const r = await wakeNow(ctx, { root, sessionId: 's-main', log: () => {} })
      assert.equal(r.ok, true, r.why)
      assert.equal(prompts.length, before + 1, '这一次要真的递进去')
      clearWakeSection()
      return prompts[prompts.length - 1]
    }

    const first = await wakeAt(L(2026, 11, 11, 15))
    assert.ok(first.includes(SLEEP_TODAY), '第 14 天这一天是「想一想」')
    assert.match(first, /这个月你变的那一点/, '本月已经问过两次，末尾要加那句收束')
    assert.match(first, /写给以后的自己看/)

    // 同一个成长日第二次醒来：整张卡都不再递。
    const second = await wakeAt(L(2026, 11, 12, 10))
    assert.ok(!second.includes(SLEEP_TODAY))
    assert.doesNotMatch(second, /这个月你变的那一点/)

    const { events } = await readEvents(root)
    // 旧写法（每月一记 `monthnar:`）已经取消：判据改成数这个月的 `sleep:`。
    assert.equal(events.filter((e) => e.type === 'meta' && String(e.text).startsWith('monthnar:')).length, 0)
    const marks = events.filter((e) => e.type === 'meta' && String(e.text).startsWith('sleep:'))
    assert.ok(marks.some((e) => String(e.text) === 'sleep:2026-11-11'), '这一次递过要记一笔')
  } finally {
    t.mock.timers.reset()
    clearWakeSection()
    if (oldHomes === undefined) delete process.env.DSH_FISH_HOMES
    else process.env.DSH_FISH_HOMES = oldHomes
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

