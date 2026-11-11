/**
 * grant.test.mjs —— 解禁裁决写进事件流（0.7.5，用户 m00239）
 *
 * 为什么单独测这一层：0.7.5 之后「点头」有两个入口（会话里的提问卡片、观测台规则页），
 * 两个入口都走 `recordGrant`。这里守住那条唯一的写入路径，尤其是 0.7.4 那个
 * **appendEvent 第二参是 ctx、第三参才是 root** 的坑——传错位会被 schema 以
 * NOT_HER_TYPE 拒收，表现是「点了可以但什么都没发生」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { currentOffer, recordGrant } from '../lib/grant.js'
import { readEvents } from '../lib/store.js'

/**
 * 建一个临时的「家」，跑完就删。
 *
 * ⚠️ 必须能等异步：老写法 `try { return fn(root) } finally { rmSync(root) }` 在
 * `fn` 是 async 的时候，`finally` 会在第一个 await 处**立刻**删目录——那时
 * 函数体还没跑完。读事件的 `fs.readFile` 若还没来得及 open，就撞 ENOENT，
 * 于是 `currentOffer` 返回 null，测试报 `null == true`。
 * 这是**时序**问题：本机快、open 抢在 unlink 前面就过；CI 的 ubuntu-20 慢，
 * 0.8.2 那次就红了（2026-10-30，run 41083997221 的 job 124160216212）。
 */
function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'fish-grant-'))
  const clean = () => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  let out
  try {
    out = fn(root)
  } catch (err) {
    clean()
    throw err
  }
  if (out && typeof out.then === 'function') return out.finally(clean)
  clean()
  return out
}

/** 写一条等人裁决的申请进去（模拟调度器 wake() 里那一步）。 */
function seedOffer(root, { id = 'g-1', rule = 'learn-affection', at = Date.now() } = {}) {
  mkdirSync(root, { recursive: true })
  const now = new Date(at).toISOString()
  const ev = {
    id,
    type: 'grant_offer',
    text: '我想试试「撒娇式表达：还不会」这件事。不是现在就要，是想问问你。',
    grant: { rule },
    ts: now,
  }
  const line = JSON.stringify(ev)
  const file = join(root, 'events.jsonl')
  let prev = ''
  try { prev = readFileSync(file, 'utf8') } catch { /* 新家 */ }
  writeFileSync(file, `${prev}${line}\n`, 'utf8')
  return ev
}

test('currentOffer：挂几天算搁置跟 rules.holdDays 走', async () => withRoot(async (root) => {
  const DAY = 86400000
  seedOffer(root, { id: 'g-hold', at: Date.now() - 4 * DAY })
  // 默认 3 天：4 天前提的已经算搁置。
  assert.equal(await currentOffer(root), null)
  // 设成 5 天：还在等，能裁决。
  writeFileSync(join(root, 'config.json'), JSON.stringify({ rules: { holdDays: 5 } }), 'utf8')
  assert.equal((await currentOffer(root))?.id, 'g-hold')
  assert.equal(await currentOffer(root, Date.now() + 2 * DAY), null, '过了 5 天照样搁置')
}))

test('recordGrant：裁决两个字之外的都不写', async () => withRoot(async (root) => {
  const r = await recordGrant(root, { offerId: 'g-1', rule: 'x', verdict: 'sure' })
  assert.equal(r.ok, false)
  assert.match(r.error, /approve|reject/)
}))

test('recordGrant：没有申请 id 就不写', async () => withRoot(async (root) => {
  const r = await recordGrant(root, { offerId: '', rule: 'x', verdict: 'approve' })
  assert.equal(r.ok, false)
  assert.match(r.error, /id/)
}))

test('recordGrant：批准真的落成一条 grant，且 source 是 system（第二参 ctx 的坑）', async () => withRoot(async (root) => {
  const offer = seedOffer(root)
  const r = await recordGrant(root, { offerId: offer.id, rule: 'learn-affection', verdict: 'approve' })
  assert.equal(r.ok, true, r.error)
  const { events } = await readEvents(root)
  const grant = events.find((e) => e.type === 'grant')
  assert.ok(grant, '必须写进去一条 grant')
  assert.equal(grant.grant.verdict, 'approve')
  assert.equal(grant.grant.offerId, offer.id)
  assert.equal(grant.grant.rule, 'learn-affection')
  assert.equal(grant.text, '可以。', '没给理由时的默认话')
}))

test('recordGrant：拒绝也写，话是「这次不行。」', async () => withRoot(async (root) => {
  const offer = seedOffer(root)
  const r = await recordGrant(root, { offerId: offer.id, rule: 'learn-affection', verdict: 'reject' })
  assert.equal(r.ok, true, r.error)
  const { events } = await readEvents(root)
  const grant = events.find((e) => e.type === 'grant')
  assert.equal(grant.grant.verdict, 'reject')
  assert.equal(grant.text, '这次不行。')
}))

test('recordGrant：给了理由就用理由原文（会话里选的那句）', async () => withRoot(async (root) => {
  const offer = seedOffer(root)
  await recordGrant(root, { offerId: offer.id, rule: 'learn-affection', verdict: 'approve', reason: ' 好啊 ' })
  const { events } = await readEvents(root)
  assert.equal(events.find((e) => e.type === 'grant').text, '好啊')
}))

test('currentOffer：有申请时带出 id 与规则，没有时返回 null', async () => withRoot(async (root) => {
  assert.equal(await currentOffer(root), null)
  const offer = seedOffer(root, { id: 'g-9' })
  const now = await currentOffer(root)
  assert.ok(now)
  assert.equal(now.id, 'g-9')
  assert.equal(now.rule, 'learn-affection')
}))

test('裁决完就不再是待裁决的申请（避免同一张卡片被答两次）', async () => withRoot(async (root) => {
  const offer = seedOffer(root)
  assert.ok(await currentOffer(root))
  await recordGrant(root, { offerId: offer.id, rule: 'learn-affection', verdict: 'approve' })
  assert.equal(await currentOffer(root), null)
}))
