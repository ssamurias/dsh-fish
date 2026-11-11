/**
 * transcript.test.mjs —— 她自己续写的对话记录不该被当成她的话（2026-11-11，W49）
 *
 * 案发：外部用户两天内从 0% 爬到 19%。形态是她的回复末尾接着往下写
 *   <她真说的话>
 *   user <凭空编的、对方「下一句」会说的话>
 *   assistant <她接着编的、自己「下一句」会说的话>
 * 后半段纯虚构，下一轮还会被她自己当既成事实引用（`talk-recent.json` →
 * 提示词 → 再写一遍，自增强）。
 *
 * 两条底线钉在这里：
 *   1. 只切不改写——从标记那一行起整段丢，前面一个字符都不动；
 *   2. 正常正文一个字符都不许动（`user experience`、`AI agent`、行中的 assistant）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  hasTranscriptTail,
  MARK_WORDS,
  partialMarkTail,
  stripTranscriptTail,
  transcriptStart,
} from '../lib/transcript.js'

test('末尾接了一段假对话：从 user 那行起全切掉，前面的真话一字不动', () => {
  const raw = [
    '石柱、梯田、电线、蓝天，都在。',
    'user 是的，不过我只是骑到这边，然后休息的时候拍的照片，浙西川藏线',
    'assistant',
  ].join('\n')
  assert.equal(stripTranscriptTail(raw), '石柱、梯田、电线、蓝天，都在。')
})

test('中文形态的标记也认（真机早期用例是「用户 嗯嗯」）', () => {
  assert.equal(stripTranscriptTail('我刚吃完饭。\n用户 嗯嗯'), '我刚吃完饭。')
  assert.equal(stripTranscriptTail('用户 嗯嗯'), '')
})

test('标记在中间、后面还有她的话：也一并切掉（宁可少留一句真话）', () => {
  const raw = '去吧\n（什么情况？）\nuser 门的事\nassistant 嗯，去看吧\n真有事，就照咱们说好的那三步来'
  assert.equal(stripTranscriptTail(raw), '去吧\n（什么情况？）')
})

test('正常正文一个字符都不改', () => {
  const cases = [
    '他写了一句 user experience 是用户体验的意思。',
    '我用的是一个 AI agent，不是 assistant 那种。',
    '我在行中说到 assistant 这个词，不算标记。',
    '嗯。',
    '',
    'line1\nline2\nline3',
  ]
  for (const s of cases) assert.equal(stripTranscriptTail(s), s, `不该动：${s}`)
})

test('行首允许前置的引用符、列表符、井号', () => {
  assert.equal(stripTranscriptTail('好的\n> user 你好'), '好的')
  assert.equal(stripTranscriptTail('- 用户 嗯'), '')
  assert.equal(stripTranscriptTail('## 助手 在'), '')
})

test('标记行前面多余的空行一起收掉，不留半截空行', () => {
  assert.equal(stripTranscriptTail('好的\n\nassistant'), '好的')
  assert.equal(stripTranscriptTail('嗯。\nuser: 你好'), '嗯。')
})

test('没有标记就原样返回（连空白都不动）', () => {
  const raw = ' 前面有空格\n后面也有空格  '
  assert.equal(stripTranscriptTail(raw), raw)
})

test('hasTranscriptTail 认得出脏的、认不出干净的', () => {
  assert.equal(hasTranscriptTail('真话\nuser 假话'), true)
  assert.equal(hasTranscriptTail('真话\n用户 假话'), true)
  assert.equal(hasTranscriptTail('他说 user experience 很重要'), false)
  assert.equal(hasTranscriptTail(''), false)
  // 连着调两次也要判对（带 g 的正则会记 lastIndex）
  assert.equal(hasTranscriptTail('真话\nassistant 假话'), true)
  assert.equal(hasTranscriptTail('真话\nassistant 假话'), true)
})

test('transcriptStart 给的是行首下标，不是换行本身', () => {
  assert.equal(transcriptStart('ab\nuser 你好'), 3)
  assert.equal(transcriptStart('user 你好'), 0)
  assert.equal(transcriptStart('abc'), -1)
})

test('partialMarkTail：半个标记词要压住，写完的完整词也要压一压', () => {
  assert.equal(partialMarkTail('us'), 2)
  assert.equal(partialMarkTail('用户'), 2)
  assert.equal(partialMarkTail('user'), 4)
  // 已经带标点/空格，不再是半个词
  assert.equal(partialMarkTail('user 你好'), 0)
  assert.equal(partialMarkTail('好的'), 0)
  assert.equal(partialMarkTail(''), 0)
})

test('MARK_WORDS 覆盖报告里出现过的两种形态', () => {
  for (const w of ['user', 'assistant', '用户', '助手']) {
    assert.ok(MARK_WORDS.includes(w), `漏了 ${w}`)
  }
})
