import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  HANDOFF_LIMIT,
  armHandoff,
  buildHandoff,
  disarmHandoff,
  handoffArmed,
  handoffTextSync,
  renderHandoff,
  resetHandoff,
} from '../lib/handoff.js'
import { writeNotes } from '../lib/note.js'
import { writeAppointments } from '../lib/appoint.js'
import { addExchange } from '../lib/talkmem.js'
import { paths } from '../lib/store.js'

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fish-handoff-'))
  try {
    return await fn(root)
  } finally {
    resetHandoff()
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
}

const two = [
  { at: '2026-11-14T12:00:00.000Z', me: '今天有点累', her: '那就早点睡，我在这儿' },
  { at: '2026-11-14T12:05:00.000Z', me: '嗯，我去躺一会儿', her: '去吧，醒了跟我说一声' },
]

test('交接页：最后两句在最前，原话不总结', () => {
  const text = renderHandoff({ exchanges: two, notes: [], appointments: [] })
  assert.ok(text.startsWith('## 上次停在这'), '标题在最前')
  assert.ok(text.includes('这些是你换窗口之前的事'), '要说清这是上一间屋子的事')
  assert.ok(text.includes('「嗯，我去躺一会儿」'), '他最后那句原封不动')
  assert.ok(text.includes('「去吧，醒了跟我说一声」'), '她最后那句原封不动')
  assert.ok(text.indexOf('「嗯，我去躺一会儿」') < text.indexOf('再往前'), '最后两句要排在更早的原话前面')
})

test('交接页：还挂着的事写内容、不写条数（不吃状态）', () => {
  const text = renderHandoff({
    exchanges: two,
    notes: [
      { id: 'n1', text: '买猫粮', status: 'open' },
      { id: 'n2', text: '写周报', status: 'open' },
      { id: 'n3', text: '已经做完的', status: 'done' },
    ],
    appointments: [
      { id: 'a1', what: '带猫复查', due: '2026-12-01', status: 'open' },
      { id: 'a2', what: '已经过日子的', due: '2026-11-01', status: 'done' },
    ],
  })
  assert.ok(text.includes('还挂着的事'))
  assert.ok(text.includes('买猫粮'))
  assert.ok(text.includes('写周报'))
  assert.ok(text.includes('带猫复查'))
  assert.ok(!text.includes('已经做完的'))
  assert.ok(!text.includes('已经过日子的'))
  assert.doesNotMatch(text, /还有\s*\d+\s*条/, '不许变成「你还有 N 条未完成」')
  assert.doesNotMatch(text, /共\s*\d+\s*件/)
})

test('交接页：那句「临走前留一句」已经删了，传进来也不写（2026-11-15，用户 m02909）', () => {
  const text = renderHandoff({ exchanges: two, lastWords: '我先去睡了，明天再说。' })
  assert.ok(!text.includes('你临走前留了一句'))
  assert.ok(!text.includes('我先去睡了'))
})

test('交接页：换到哪儿要说，空着就不说', () => {
  assert.match(renderHandoff({ exchanges: two, room: '群里' }), /## 上次停在这（群里）/)
  assert.match(renderHandoff({ exchanges: two, room: '群里' }), /这次换到了群里/)
  assert.doesNotMatch(renderHandoff({ exchanges: two }), /这次换到了/)
})

test('交接页：不超过 400 字，long 的原话只截不铺开', () => {
  const long = Array.from({ length: 12 }, (_, i) => ({
    at: '2026-11-14T12:00:00.000Z',
    me: `第 ${i} 句` + '啊'.repeat(200),
    her: `回第 ${i} 句` + '哦'.repeat(200),
  }))
  const text = renderHandoff({ exchanges: long })
  assert.ok(text.length <= HANDOFF_LIMIT, `实际 ${text.length}`)
  assert.ok(text.endsWith('…'), '截了要看得出来')
})

test('交接页：什么都没有、也没换房间，就是空串', () => {
  assert.equal(renderHandoff({}), '')
  assert.equal(renderHandoff({ exchanges: [], notes: [], appointments: [] }), '')
})

test('这一轮要不要摆：arm → armed → disarm', () => {
  resetHandoff()
  assert.equal(handoffArmed('s1'), false)
  armHandoff('s1')
  assert.equal(handoffArmed('s1'), true)
  assert.equal(handoffArmed('s2'), false, '按会话记，别的房间不沾')
  disarmHandoff('s1')
  assert.equal(handoffArmed('s1'), false)
})

test('buildHandoff 从盘上读便条、约定和原话', () => withRoot(async (root) => {
  await writeNotes(root, [
    { id: 'n1', text: '买猫粮', status: 'open', created: '2026-11-14T10:00:00.000Z' },
  ])
  await writeAppointments(root, [
    { id: 'a1', what: '带猫复查', due: '2026-12-01', status: 'open', created: '2026-11-14T10:00:00.000Z' },
  ])
  await addExchange(root, { me: '今天有点累', her: '那就早点睡' })
  const text = await buildHandoff(root, { turns: 2 })
  assert.ok(text.includes('今天有点累'))
  assert.ok(text.includes('买猫粮'))
  assert.ok(text.includes('带猫复查'))
}))

test('handoffTextSync：读 home.json 里的 carry，读不到就是空串', () => withRoot(async (root) => {
  assert.equal(handoffTextSync(root), '')
  await writeFile(join(paths(root).root, 'home.json'), JSON.stringify({ wsId: 'ws', sessionId: 's', carry: '## 上次停在这\n- 旧话' }), 'utf8')
  assert.match(handoffTextSync(root), /旧话/)
}))
