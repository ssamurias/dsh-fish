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

// issue #69：刷站停了以后只剩 bili_look 落的 look:。历史原来不读它，
// 同一张卡底部「只翻到过 N 条」（glancedItems）却算它——两边对不上。
test('历史：bili_look 落的 look: 也进列表，标 glance，和 watched / browse 去重', () => {
  const D0 = '2026-10-29'
  const events = [
    meta(`look:${DK} ${B1} {"title":"点开的","up":"某UP","duration":61,"view":7}`),
    meta(`look:${DK} ${B2}`), // 老事件：只有 BV 号
    meta(`watched:${DK} ${B2} {"title":"后来看了画面"}`),
    meta(`browse:${DK} [{"bvid":"${B3}","title":"记账里的"}]`),
    meta(`look:${DK} ${B3} {"title":"look 行里的"}`),
    meta(`look:${DK} ${B1} {"title":"同一天又点了一次"}`),
    meta(`look:${D0} ${B1} {"title":"前一天点开的"}`),
    meta(`looked:${B3}`), // 没日期的旧凭证，不是 look:
  ]
  const groups = historyFromEvents(events, { days: 7 })
  assert.deepEqual(groups.map((g) => g.date), [DK, D0])
  const today = groups[0].items
  assert.deepEqual(today.map((x) => `${x.bvid}:${x.how}`), [`${B2}:watch`, `${B3}:glance`, `${B1}:glance`],
    '看过画面的在前、每条只出现一次')
  const b1 = today.find((x) => x.bvid === B1)
  assert.equal(b1.title, '点开的', '展示信息取 look 行自带的 JSON（同一天第一次那份）')
  assert.equal(b1.up, '某UP')
  assert.equal(b1.duration, 61)
  assert.equal(b1.url, `https://www.bilibili.com/video/${B1}`)
  assert.equal(today.find((x) => x.bvid === B3).title, '记账里的', '已在 browse: 里的不重复，展示信息照旧')
  assert.equal(groups[1].items[0].title, '前一天点开的', '换一天就是另一条')
  // 和底部那行数的是同一批
  assert.deepEqual(today.filter((x) => x.how === 'glance').map((x) => x.bvid).sort(),
    glancedItems(events, DK).map((x) => x.bvid).sort())
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
