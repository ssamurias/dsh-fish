/**
 * local-date.test.mjs —— 「哪一天」按本地日历数，不按 UTC（同 issue #19 的口径）
 *
 * 落盘的时刻都是带 Z 的 UTC ISO 串。把它切前 10 位当日期，在 UTC 以外的时区会错开：
 * 东九区的换日落在早上 9 点，东八区落在早上 8 点。
 *
 * 守两处：
 *   1. her_note 翻桌子时，划掉 / 放下的那一行写的是本地的月-日；
 *   2. 拒绝升格成立场的「三次都没松口且跨了不止一天」，天数按本地日历数。
 *
 * 这个文件自己把时区钉在 Asia/Tokyo（node --test 每个文件一个进程，不影响别的文件）。
 * 用例里的时刻都用本地时间构造，所以断言在任何时区都成立；钉时区是为了让
 * 「切前 10 位」的旧写法在跑测试的机器是 UTC 时也会红。
 */
process.env.TZ = 'Asia/Tokyo'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { normalizeNote, writeNotes, registerNote } = await import('../lib/note.js')
const { buildStances } = await import('../lib/stance.js')

/** 本地时刻 → 落盘用的 UTC ISO 串。 */
const local = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi).toISOString()

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-fish-localdate-'))
  try {
    await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function herTool(root) {
  let def = null
  registerNote({ tools: { register: (d) => { def = d; return () => {} } } }, { root, log: () => {} })
  // 和她走的路一样：只拿 render 出来的字
  return async (args) => def.output.render(args, await def.execute(args, { session: {} }))[0].text
}

test('时区真的钉住了：本地 00:30 落盘是前一天的 UTC 日期', () => {
  assert.equal(new Date(2026, 10, 12, 0, 30).getTimezoneOffset(), -540)
  assert.equal(local(2026, 11, 12, 0, 30), '2026-11-11T15:30:00.000Z')
})

test('便条：本地凌晨划掉 / 放下的，翻桌子时写当天，不写前一天', async () => {
  await withRoot(async (root) => {
    await writeNotes(root, [
      normalizeNote({ text: '把第三章看完', status: 'done', closedAt: local(2026, 11, 12, 0, 30) }),
      normalizeNote({ text: '周末去海边', status: 'dropped', closedAt: local(2026, 11, 12, 8, 59), reason: '天气不好' }),
      normalizeNote({ text: '白天划掉的', status: 'done', closedAt: local(2026, 11, 10, 15, 0) }),
    ])
    const all = await herTool(root)({ action: 'list', filter: 'all' })
    assert.match(all, /✓ 把第三章看完（11-12 划掉）/)
    assert.match(all, /✗ 周末去海边（11-12 放下）—— 天气不好/)
    assert.match(all, /✓ 白天划掉的（11-10 划掉）/)
    assert.doesNotMatch(all, /11-11/)
  })
})

test('便条：关掉的时刻解析不出来就不写日期，行还在', async () => {
  await withRoot(async (root) => {
    await writeNotes(root, [
      normalizeNote({ text: '时刻坏了的', status: 'done', closedAt: 'not-a-date' }),
      normalizeNote({ text: '没记时刻的', status: 'dropped', reason: '算了' }),
    ])
    const all = await herTool(root)({ action: 'list', filter: 'all' })
    assert.match(all, /^✓ 时刻坏了的$/m)
    assert.match(all, /^✗ 没记时刻的—— 算了$/m)
  })
})

// ---- 拒绝升格的「跨天」----
const gated = (ats) => ({
  stage: 4,
  stageGate: { passed: ['trust', 'autonomy', 'initiative'] },
  beliefs: [],
  scars: [],
  refusals: ats.map((at, i) => ({
    id: `r${i}`, at, what: '我不想吃辣', act: '', object: '吃辣', quote: '我不想吃辣', reaction: null,
  })),
})

test('拒绝：同一个本地日的上午说了三次（跨过 UTC 的换日），不升格', () => {
  const ats = [local(2026, 11, 12, 8, 0), local(2026, 11, 12, 8, 30), local(2026, 11, 12, 10, 0)]
  // 前两次的 UTC 日期是 11-11，第三次是 11-12：切前 10 位会数成两天
  assert.deepEqual(ats.map((a) => a.slice(0, 10)), ['2026-11-11', '2026-11-11', '2026-11-12'])
  assert.equal(buildStances(gated(ats)).length, 0, '同一天里连着说，是他在追问')
})

test('拒绝：前一晚两次、第二天早上一次（UTC 还在同一天），升格', () => {
  const ats = [local(2026, 11, 11, 20, 0), local(2026, 11, 11, 21, 0), local(2026, 11, 12, 7, 0)]
  assert.deepEqual(ats.map((a) => a.slice(0, 10)), ['2026-11-11', '2026-11-11', '2026-11-11'])
  const out = buildStances(gated(ats))
  assert.equal(out.length, 1)
  assert.equal(out[0].kind, 'refused')
  assert.equal(out[0].text, '吃辣')
})

test('拒绝：时刻是毫秒数也照本地日历数；解析不出的不计入天数', () => {
  const ms = (y, mo, d, h) => new Date(y, mo - 1, d, h).getTime()
  assert.equal(buildStances(gated([ms(2026, 11, 11, 20), ms(2026, 11, 11, 21), ms(2026, 11, 12, 7)])).length, 1)
  assert.equal(buildStances(gated([ms(2026, 11, 12, 8), ms(2026, 11, 12, 8), ms(2026, 11, 12, 10)])).length, 0)
  // 一条好的 + 两条坏的：只有一个能数的日子，不够「跨天」
  assert.equal(buildStances(gated([local(2026, 11, 12, 10, 0), 'not-a-date', undefined])).length, 0)
  // 三条全坏：零天，同样不升格
  assert.equal(buildStances(gated(['', null, 'x'])).length, 0)
})
