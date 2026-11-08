/**
 * whatseen：把「真的看过画面」和「只翻到过」分开。
 *
 * 这些测试来自一条客户反馈（2026-10-30）：日志里"看了什么"把每天所有点开的
 * 视频都算上，可她本人否认看过——她只扫了眼标题和评论，没抽帧。
 * 同时，单独指派给她看的视频反而不体现。
 *
 * 所以这里的每条断言都在钉一件事：**凭证来自哪一行事件，就只能是那一档**。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  videoUrl,
  parseWatchedLine,
  parseLookLine,
  parseHandLine,
  watchedItems,
  glancedItems,
  handedUnseen,
  seenOn,
  parseDigestLine,
  digestMentioned,
  DIGEST_PREFIX,
} from '../lib/whatseen.js'
import { buildReport } from '../lib/report.js'
import { historyFromEvents } from '../lib/history.js'
import { summarizeAway } from '../lib/away.js'

const DK = '2026-10-30'
const B1 = 'BV1xx411c7mD'
const B2 = 'BV1yy411c7mE'
const B3 = 'BV1zz411c7mF'

const meta = (text) => ({ type: 'meta', text })

test('videoUrl：只认 BV 号，别的原样空着', () => {
  assert.equal(videoUrl(B1), `https://www.bilibili.com/video/${B1}`)
  assert.equal(videoUrl('  ' + B1 + ' '), `https://www.bilibili.com/video/${B1}`)
  assert.equal(videoUrl('av123'), '')
  assert.equal(videoUrl(''), '')
})

test('parseDated：老事件（只有 BV 号）与新事件（带 JSON）都要认', () => {
  // 0.8.1 之前落的全是这种，读的一方不能因为它们老就丢
  const old = parseWatchedLine(`watched:${DK} ${B1}`)
  assert.equal(old.dk, DK)
  assert.equal(old.bvid, B1)
  assert.equal(old.info, null)

  const fresh = parseWatchedLine(`watched:${DK} ${B1} {"title":"标题","up":"某UP","duration":125,"view":9}`)
  assert.equal(fresh.bvid, B1)
  assert.equal(fresh.info.title, '标题')
  assert.equal(fresh.info.duration, 125)

  assert.equal(parseWatchedLine('watched:nope ' + B1), null)
  assert.equal(parseWatchedLine('looked:' + B1), null)
  assert.equal(parseLookLine(`look:${DK} ${B1}`).bvid, B1)
  assert.equal(parseHandLine(`hand:${DK} ${B1}`).bvid, B1)
})

test('parseDated：坏 JSON 只丢展示信息，BV 号照样能用', () => {
  const got = parseWatchedLine(`watched:${DK} ${B1} {不是json`)
  assert.equal(got.bvid, B1)
  assert.equal(got.info, null)
})

test('watchedItems：只认 watched:，老事件也能给出裸 BV 号', () => {
  const events = [
    meta(`watched:${DK} ${B1} {"title":"看了画面的","up":"某UP","duration":125,"view":9}`),
    meta(`watched:${DK} ${B2}`), // 老形状：没有标题
    meta(`browse:${DK} [{"bvid":"${B3}","title":"只翻到的"}]`),
    meta(`watched:2026-10-29 ${B3}`), // 不是今天
    meta(`watched:${DK} ${B1}`), // 同一条重复记账
  ]
  const got = watchedItems(events, DK)
  assert.deepEqual(got.map((x) => x.bvid), [B1, B2])
  assert.equal(got[0].title, '看了画面的')
  assert.equal(got[1].title, '') // 老事件没有标题，上层要能显示成裸 BV 号
  assert.equal(got[0].how, 'watch')
})

test('glancedItems：browse 与 look 都算翻到过，但已经在 watched 里的要剔除', () => {
  const events = [
    meta(`watched:${DK} ${B1}`),
    meta(`browse:${DK} [{"bvid":"${B1}","title":"看过画面的"},{"bvid":"${B2}","title":"只翻到的"}]`),
    meta(`look:${DK} ${B3}`),
  ]
  const got = glancedItems(events, DK)
  assert.deepEqual(got.map((x) => x.bvid), [B2, B3])
  assert.equal(got[0].title, '只翻到的')
  assert.equal(got[0].how, 'glance')
  // 看过的画面不该退回到"只是翻到过"
  assert.ok(!got.some((x) => x.bvid === B1))
})

test('handedUnseen：递过来、但两档都没进的那条', () => {
  const events = [
    meta(`hand:${DK} ${B1}`), // 递了，也真去看了画面
    meta(`watched:${DK} ${B1}`),
    meta(`hand:${DK} ${B2}`), // 递了，只翻到过
    meta(`browse:${DK} [{"bvid":"${B2}"}]`),
    meta(`hand:${DK} ${B3}`), // 递了，一眼没看
  ]
  const got = handedUnseen(events, DK)
  assert.deepEqual(got.map((x) => x.bvid), [B3])
})

test('handed 标记：同一天递过来又去看了，条目上要写着「你递过来的」', () => {
  const events = [meta(`hand:${DK} ${B1}`), meta(`watched:${DK} ${B1}`)]
  assert.equal(seenOn(events, DK).watched[0].handed, true)
})

test('seenOn：三档一次取齐，互不重叠', () => {
  const events = [
    meta(`watched:${DK} ${B1}`),
    meta(`browse:${DK} [{"bvid":"${B1}"},{"bvid":"${B2}"}]`),
    meta(`hand:${DK} ${B3}`),
  ]
  const seen = seenOn(events, DK)
  assert.deepEqual(seen.watched.map((x) => x.bvid), [B1])
  assert.deepEqual(seen.glanced.map((x) => x.bvid), [B2])
  assert.deepEqual(seen.handed.map((x) => x.bvid), [B3])
})

// ---------------------------------------------------------------- 报告

test('报告：三节分开写，"翻到过"不许出现在"看了什么"里', () => {
  const md = buildReport({
    dateKey: DK,
    seen: {
      watched: [{ bvid: B1, title: '看过画面的' }],
      glanced: [{ bvid: B2, title: '只翻到的' }],
      handed: [{ bvid: B3 }],
    },
    events: [],
  })
  const watchedAt = md.indexOf('## 看了什么')
  const glancedAt = md.indexOf('## 翻到过什么')
  const handedAt = md.indexOf('## 你递过来的')
  assert.ok(watchedAt >= 0 && glancedAt > watchedAt && handedAt > glancedAt, '三节顺序不对')
  // 「只翻到的」只许出现在翻到过那一节里
  assert.ok(md.indexOf('只翻到的') > glancedAt)
  assert.ok(!md.slice(watchedAt, glancedAt).includes('只翻到的'))
  assert.match(md, /翻到过不等于看过/)
  assert.match(md, /递到她手上了，她还没看/)
})

test('报告：一条画面都没看时说的是「今天没看画面」，不是「今天没看」', () => {
  const md = buildReport({
    dateKey: DK,
    seen: { watched: [], glanced: [{ bvid: B2, title: '只翻到的' }], handed: [] },
    events: [],
  })
  assert.match(md, /今天没看画面/)
})

test('报告：老调用方只传 items 时按「翻到过」处理，不炸也不太喊看过', () => {
  const md = buildReport({ dateKey: DK, items: [{ bvid: B1, title: '老调用' }], events: [] })
  assert.match(md, /今天没看画面/)
  assert.match(md, /翻到过什么/)
  assert.match(md, /老调用/)
})

// ---------------------------------------------------------------- 历史 / 不在的时候

test('历史：看过画面的排在当天最前，且带 how=watch', () => {
  const events = [
    meta(`browse:${DK} [{"bvid":"${B2}","title":"翻到的"}]`),
    meta(`watched:${DK} ${B1} {"title":"看过的"}`),
  ]
  const groups = historyFromEvents(events, { days: 7 })
  assert.equal(groups[0].date, DK)
  assert.equal(groups[0].items[0].bvid, B1)
  assert.equal(groups[0].items[0].how, 'watch')
  assert.equal(groups[0].items[1].how, 'glance')
})

test('历史：同一条既被记账又被抽帧时，只留一份且算看过', () => {
  const events = [
    meta(`browse:${DK} [{"bvid":"${B1}","title":"记账里的"}]`),
    meta(`watched:${DK} ${B1} {"title":"抽帧时的"}`),
  ]
  const items = historyFromEvents(events, { days: 7 })[0].items
  assert.equal(items.filter((x) => x.bvid === B1).length, 1)
  assert.equal(items[0].how, 'watch')
})

// 2026-11-07（用户反馈）：0.9.0 起刷站不再挂在唤醒上，她自己翻的记录写在 look: 里。
// 以前 historyFromEvents 只认 watched: 与 browse:，于是 0.9.x 之后她看过的东西
// 一条都不进列表——用户看到的是「记录停在几个月前」。
test('历史：她自己翻的（look:）也要进列表，带标题、算翻到过', () => {
  const events = [
    meta(`look:${DK} ${B1} {"title":"她自己点开的","up":"某个UP"}`),
  ]
  const groups = historyFromEvents(events, { days: 7 })
  assert.equal(groups[0].date, DK)
  assert.equal(groups[0].items.length, 1)
  assert.equal(groups[0].items[0].bvid, B1)
  assert.equal(groups[0].items[0].title, '她自己点开的')
  assert.equal(groups[0].items[0].how, 'glance')
})

test('历史：look: 与 watched: 撞同一条时，只留「看过画面」的那份', () => {
  const events = [
    meta(`look:${DK} ${B1} {"title":"翻的"}`),
    meta(`watched:${DK} ${B1} {"title":"看的"}`),
  ]
  const items = historyFromEvents(events, { days: 7 })[0].items
  assert.equal(items.filter((x) => x.bvid === B1).length, 1)
  assert.equal(items[0].how, 'watch')
})

// issue #69：v0.8.0–v0.8.7 写的 look: 只有 BV 号。它排在 browse: 前面，去重留下的是它，
// 列表就只剩裸 BV 号；glancedItems 对同一条给的却是 browse: 里的标题，两处对不上。
test('历史：老的 look:（只有 BV 号）和同一天 browse: 撞同一条时，标题和 UP 从 browse: 补上，和 glancedItems 一致', () => {
  const events = [
    meta(`look:${DK} ${B1}`),
    meta(`browse:${DK} [{"bvid":"${B1}","title":"有标题","up":"某UP","duration":61,"view":9}]`),
    // 别的天的同一条不算：展示信息只在同一天里补
    meta(`browse:2026-10-29 [{"bvid":"${B2}","title":"前一天的"}]`),
    meta(`look:${DK} ${B2}`),
  ]
  const items = historyFromEvents(events, { days: 400 }).find((g) => g.date === DK).items
  assert.equal(items.filter((x) => x.bvid === B1).length, 1)
  const one = items.find((x) => x.bvid === B1)
  assert.deepEqual([one.title, one.up, one.duration, one.view, one.how], ['有标题', '某UP', 61, 9, 'glance'])
  const g = glancedItems(events, DK).find((x) => x.bvid === B1)
  assert.deepEqual([one.title, one.up], [g.title, g.up], '历史列表和翻到过的清单给同一个标题')
  assert.equal(items.find((x) => x.bvid === B2).title, '', '别的天的记账不拿来补')

  // look: 自己带了标题、当天又没有记账：照用自己的
  const own = historyFromEvents([meta(`look:${DK} ${B3} {"title":"自己带的","up":"某个UP"}`)], { days: 7 })[0].items[0]
  assert.deepEqual([own.title, own.up], ['自己带的', '某个UP'])
})

test('历史：look: 自己带了展示信息、同一天 browse: 也有时，优先取 browse: 的；browse: 那项是空的才用 look: 自己的', () => {
  const events = [
    meta(`look:${DK} ${B1} {"title":"look 带的","up":"look 的UP","duration":5,"view":1}`),
    meta(`look:${DK} ${B2} {"title":"look 带的二","up":"look 的UP二","duration":7,"view":2}`),
    meta(`browse:${DK} [{"bvid":"${B1}","title":"记账的","up":"记账的UP","duration":61,"view":9},`
      + `{"bvid":"${B2}","title":"  ","up":"","duration":0,"view":0}]`),
  ]
  const items = historyFromEvents(events, { days: 400 }).find((g) => g.date === DK).items
  const one = items.find((x) => x.bvid === B1)
  assert.deepEqual([one.title, one.up, one.duration, one.view], ['记账的', '记账的UP', 61, 9])
  const g = glancedItems(events, DK).find((x) => x.bvid === B1)
  assert.deepEqual([one.title, one.up, one.duration, one.view], [g.title, g.up, g.duration, g.view])
  // browse: 那一项标题、UP 是空的（recordBrowse 拿不到就记空串、记 0）：不拿空的盖掉 look: 带的
  const two = items.find((x) => x.bvid === B2)
  assert.deepEqual([two.title, two.up, two.duration, two.view], ['look 带的二', 'look 的UP二', 7, 2])
})

test('历史：天数的上限放到 366，选「一年」不再被砍成半年', () => {
  const events = []
  for (let i = 0; i < 400; i++) {
    const d = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10)
    events.push(meta(`browse:${d} [{"bvid":"${B1}"}]`))
  }
  assert.equal(historyFromEvents(events, { days: 365 }).length, 365)
  assert.equal(historyFromEvents(events, { days: 400 }).length, 366)
})

test('不在的时候：看过画面与翻到过分开数', () => {
  const now = Date.parse('2026-10-30T12:00:00.000Z')
  const events = [
    { type: 'meta', ts: '2026-10-29T00:00:00.000Z', text: `browse:2026-10-29 [{"bvid":"${B2}"},{"bvid":"${B3}"}]` },
    { type: 'meta', ts: '2026-10-29T01:00:00.000Z', text: `watched:2026-10-29 ${B1}` },
  ]
  const away = summarizeAway(events, { now })
  assert.equal(away.watched, 1)
  assert.equal(away.videos, 2)
})

// ------------------------------------------------ 2026-11-08（用户 m00187）便条不重复念

test('便条：提到过谁的记录能读回来，认不出的一行返回 null', () => {
  assert.equal(DIGEST_PREFIX, 'digest:')
  assert.deepEqual(parseDigestLine(`${DIGEST_PREFIX}${DK} ${B1} ${B2}`), { dk: DK, ids: [B1, B2] })
  assert.equal(parseDigestLine(`${DIGEST_PREFIX}${DK}`), null, '一件都没念的当天不记')
  assert.equal(parseDigestLine(`browse:${DK} []`), null)
  assert.equal(parseDigestLine('digest:2026-10-30 不是 BV 号'), null, '日子不对就当不是这一行')
})

test('便条：七天内提过的还算「提过」，更早的放回去重念', () => {
  const now = Date.parse('2026-11-08T12:00:00+08:00')
  const day = 86_400_000
  const events = [
    { type: 'meta', ts: new Date(now - day).toISOString(), text: `${DIGEST_PREFIX}2026-11-07 ${B1} ${B2}` },
    { type: 'meta', ts: new Date(now - 8 * day).toISOString(), text: `${DIGEST_PREFIX}2026-10-31 ${B3}` },
    { type: 'meta', ts: new Date(now - day).toISOString(), text: `browse:2026-11-07 [{"bvid":"BV1zz411c7mF"}]` },
  ]
  const said = digestMentioned(events, { now })
  assert.ok(said.has(B1))
  assert.ok(said.has(B2))
  assert.ok(!said.has(B3), '七天以前提过的不再拦，可以再念一次')
  assert.ok(!said.has('BV1zz411c7mF'), '只翻到过、没念过的不算提过')
  assert.equal(digestMentioned(events, { now, days: 0 }).size, 0)
})
