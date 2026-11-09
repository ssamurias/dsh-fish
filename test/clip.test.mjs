/**
 * clip.test.mjs —— 截断不许把一个字符切成两半（2026-11-10，外部真机）。
 *
 * 起因：一台机器上 `bili_look` 的评论按 200 个 UTF-16 单元硬截，把一个 emoji
 * 从中间切开，留下半个高位代理项。这条工具结果进了会话上下文，之后每个请求
 * 都带着它发给服务端 → 连续 400，整个会话再也发不出消息。
 *
 * 守四件事：
 *   1. clipText() 在任何切点都不留下孤立代理项，结果仍是合法 UTF-8；
 *   2. cleanText() 把已经混进来的孤立代理项换成 U+FFFD，成对的字符不动；
 *   3. 素材渲染（renderItem）输出的文字里没有孤立代理项；
 *   4. 事件流写入与读回都洗过一遍 —— 旧文件里那半个字符不会“复活”进上下文。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { cleanText, clipText, hasLoneSurrogate } from '../lib/clip.js'
import { renderItem } from '../lib/browse.js'
import { appendEvent, readEvents } from '../lib/store.js'

const FACE = '\u{1F923}' // 😂 高位 \ud83d + 低位 \ude23 —— 真机上被切开的就是它

test('clipText：切在 emoji 中间时退一格，不留半个代理项', () => {
  const text = 'a'.repeat(198) + FACE + '后面还有'
  for (let max = 1; max <= 210; max++) {
    const out = clipText(text, max)
    assert.equal(hasLoneSurrogate(out), false, `max=${max} 留下了孤立代理项`)
    assert.ok(out.length <= max, `max=${max} 超长了：${out.length}`)
    assert.equal(Buffer.from(out, 'utf8').toString('utf8'), out, `max=${max} 不是合法 UTF-8`)
  }
  // 199 = 198 个字母 + 截断标记；第 200 个单元正是 emoji 的高位，必须退掉
  assert.equal(clipText(text, 200), 'a'.repeat(198) + '…')
})

test('clipText：成对的 emoji 原样保留，整词不被吃掉', () => {
  assert.equal(clipText(FACE + FACE + FACE, 100), FACE + FACE + FACE)
  const cut = clipText(FACE.repeat(10), 5)
  assert.equal(hasLoneSurrogate(cut), false)
  assert.ok(cut.length <= 5)
})

test('cleanText：孤立代理项换成 U+FFFD，成对的原样', () => {
  assert.equal(cleanText('\ud83d'), '\uFFFD')
  assert.equal(cleanText('前半\ude23后半'), '前半\uFFFD后半')
  assert.equal(cleanText(FACE), FACE)
  assert.equal(hasLoneSurrogate('\ud83d'), true)
  assert.equal(hasLoneSurrogate(FACE), false)
  // 已经是好文本时一个字节都不改
  const good = '正常的一句话，带一个 emoji ' + FACE
  assert.equal(cleanText(good), good)
})

test('renderItem：上游带进来的半个字符不会出现在素材里', () => {
  const pack = {
    video: { bvid: 'BV1xx411c7mD', title: '标题' + FACE, up: 'UP\ud83d', duration: 100, view: 0, like: 0 },
    tags: ['标签', 'tag\ud83d'],
    desc: '简介\ud83d',
    comments: [{ text: '评论\ud83d', like: 3 }],
    danmaku: [{ t: 65, text: '弹幕\ud83d' }],
    pubdate: '2026-11-09',
  }
  const out = renderItem(pack, 0)
  assert.equal(hasLoneSurrogate(out), false, `素材里还有孤立代理项：${JSON.stringify(out)}`)
  assert.ok(out.includes('\uFFFD'), '孤立代理项应该被换成 U+FFFD，而不是整条丢掉')
})

test('事件流：写进去的半个字符，读回来已经洗干净', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-clip-'))
  try {
    await appendEvent({ type: 'utterance', source: 'tool', text: '他说：笑死\ud83d' }, { day: 1, stage: 1 }, root)
    const { events } = await readEvents(root)
    assert.equal(events.length, 1)
    assert.equal(hasLoneSurrogate(events[0].text), false, `读回来仍是非法字符串：${JSON.stringify(events[0].text)}`)
    assert.ok(events[0].text.includes('\uFFFD'))
    // 落盘那一行本身也该是干净的：写之前就洗过，文件里不该出现半个字符的转义
    const raw = await (await import('node:fs/promises')).readFile(join(root, 'events.jsonl'), 'utf8')
    assert.equal(hasLoneSurrogate(raw), false, `落盘仍是非法字符串：${JSON.stringify(raw)}`)
    assert.ok(raw.includes('\uFFFD'), `落盘应已换成 U+FFFD：${raw.slice(0, 160)}`)
    assert.equal(Buffer.from(raw, 'utf8').toString('utf8'), raw)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
