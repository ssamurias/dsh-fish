import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normVoice, voiceKey, commentsFrom, chooseVoice, recentVoiceKeys, recordVoice, findEcho,
  VOICE_MAX, VOICE_MIN_LIKE, VOICE_RANDOM, VOICE_TTL_DAYS, ECHO_MIN_SIM,
} from '../lib/voices.js'
import { deriveSelf, DAY_MS } from '../lib/derive.js'
import { personaLine } from '../lib/persona.js'
import { CATALOG, availableFor } from '../lib/events.js'
import { validateEvent } from '../lib/schema.js'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 评论区里别人的话（2026-10-24，用户 m02454）
// 用户的原话：评论可以算认知/判断/记忆的一部分，但占比要小（可以随机抽、或挑重复率高的），
// 并进入认知循环，她可能会来问我。

const T0 = Date.parse('2026-10-01T00:00:00Z')

function ev(id, type, day, text, extra = {}) {
  return {
    id, ts: new Date(T0 + (day - 1) * DAY_MS).toISOString(), day, stage: 1,
    type, source: 'system', text, refs: [], verdict: null, confidence: 0.6, flags: [], ...extra,
  }
}

function pack(bvid, comments) {
  return { video: { bvid }, comments }
}

// ------------------------------------------------------------------ 归一化

test('归一化去掉 URL、@、标点与空白，长尾截断', () => {
  assert.equal(normVoice('  https://b23.tv/abc  @小明 这个 视频 真的很好笑！！'), '这个视频真的很好笑')
  assert.equal(normVoice('「前排」'), '前排')
  assert.equal(normVoice('a'.repeat(300)).length, 120)
  assert.equal(voiceKey('好 看！'), voiceKey('好看'))
})

test('摊平评论时丢掉太短的（笑死/前排）和超过上限的', () => {
  const list = commentsFrom([pack('BV1', [
    { text: '笑死', like: 9999 },
    { text: '这条评论有足够长度', like: 12 },
    { text: 'x'.repeat(VOICE_MAX + 1), like: 9999 },
  ])])
  assert.equal(list.length, 1)
  assert.equal(list[0].text, '这条评论有足够长度')
  assert.equal(list[0].bvid, 'BV1')
})

// -------------------------------------------------------------------- 选法

test('跨视频重复的那句优先——它比单条高赞更值得读', () => {
  const comments = commentsFrom([
    pack('BV1', [{ text: '这游戏根本不值得买', like: 10 }, { text: '全是广告', like: 5000 }]),
    pack('BV2', [{ text: '这游戏根本不值得买！', like: 3000 }]),
  ])
  const v = chooseVoice(comments, { rng: () => 0.99 })
  assert.equal(v.why, 'repeated')
  assert.equal(v.across, 2)
  assert.match(v.text, /不值得买/)
})

test('没有重复时挑高赞短句，太长的不要', () => {
  const comments = commentsFrom([
    pack('BV1', [{ text: '这个剪辑真的绝了', like: VOICE_MIN_LIKE + 1 }]),
    pack('BV1', [{ text: '短'.repeat(80), like: 99999 }]),
  ])
  const v = chooseVoice(comments, { rng: () => 0.99 })
  assert.equal(v.why, 'liked')
  assert.equal(v.text, '这个剪辑真的绝了')
})

test('既没重复也不够高赞 → 25% 随机，rng 可注入', () => {
  const comments = commentsFrom([pack('BV1', [{ text: '随便说一句凑长度', like: 3 }])])
  assert.equal(chooseVoice(comments, { rng: () => 0.5 }), null, '超出 25% 就不选')
  const v = chooseVoice(comments, { rng: () => 0.1 })
  assert.equal(v.why, 'random')
  assert.equal(v.text, '随便说一句凑长度')
  assert.equal(VOICE_RANDOM, 0.25)
})

test('最近 30 天出现过的句子不再选', () => {
  const comments = commentsFrom([pack('BV1', [{ text: '这句已经读过一次了', like: 99999 }])])
  const seen = new Set([voiceKey('这句已经读过一次了')])
  assert.equal(chooseVoice(comments, { seen, rng: () => 0.1 }), null)

  const fresh = ev('ev_v1', 'voice', 1, '这句已经读过一次了')
  assert.ok(recentVoiceKeys([fresh], { now: T0 + 1 * DAY_MS }).has(voiceKey('这句已经读过一次了')))
  assert.equal(recentVoiceKeys([fresh], { now: T0 + (VOICE_TTL_DAYS + 1) * DAY_MS }).size, 0)
})

// ------------------------------------------------------------------- schema

test('voice 是系统侧类型：能落盘，但她自己写不了', () => {
  const ok = validateEvent({ type: 'voice', text: '这句话是陌生人写的。', refs: ['BV1'] }, { source: 'system', day: 2 })
  assert.equal(ok.type, 'voice')
  assert.deepEqual(ok.refs, ['BV1'])

  assert.throws(
    () => validateEvent({ type: 'voice', text: '我自己编一条别人说的话。' }, { source: 'tool' }),
    (e) => e.code === 'NOT_HER_TYPE',
  )
})

// ------------------------------------------------------------------ 认知循环

test('她认下了才叫回声：三日内说了一句意思相近的话', () => {
  const evs = [
    ev('ev_seed', 'seed', 1, '种'),
    ev('ev_v', 'voice', 2, '这游戏根本不值得买'),
    { ...ev('ev_u', 'utterance', 2, '我也觉得这游戏根本不值得买。'), source: 'tool' },
  ]
  const m = deriveSelf(evs, { now: T0 + 2 * DAY_MS })
  assert.equal(m.facts.voices, 1)
  assert.equal(m.facts.voicesEchoed, 1)
  assert.equal(m.voices[0].echoed, true)
  assert.equal(m.beliefCount, 1, '判断只来自她说的话，评论不进 beliefs')
  assert.equal(m.freshVoice, null, '认下了就不再摆在眼前')
})

test('聊天里没认领的复述不算认下：那条评论还摆在她眼前', () => {
  const evs = [
    ev('ev_seed', 'seed', 1, '种'),
    ev('ev_v', 'voice', 2, '这游戏根本不值得买'),
    ev('ev_u', 'utterance', 2, '我也觉得这游戏根本不值得买。', { flags: ['uncommitted'] }),
  ]
  const m = deriveSelf(evs, { now: T0 + 2 * DAY_MS })
  assert.equal(m.facts.voicesEchoed, 0)
  assert.equal(m.voices[0].echoed, false)
  assert.equal(m.freshVoice?.text, '这游戏根本不值得买', '信念没长，评论不能先从她眼前消失')
  assert.equal(m.beliefCount, 0)
})

test('只是读到、没表态 → 不算回声，那条要摆在她眼前', () => {
  const evs = [
    ev('ev_seed', 'seed', 1, '种'),
    ev('ev_v', 'voice', 2, '这游戏根本不值得买'),
  ]
  const m = deriveSelf(evs, { now: T0 + 2 * DAY_MS })
  assert.equal(m.facts.voicesEchoed, 0)
  assert.ok(m.freshVoice)
  assert.equal(m.freshVoice.text, '这游戏根本不值得买')
  assert.equal(m.beliefCount, 0)
})

test('隔太久才说相似的话，不算被那条评论带的', () => {
  const evs = [
    ev('ev_seed', 'seed', 1, '种'),
    ev('ev_v', 'voice', 1, '这游戏根本不值得买'),
    { ...ev('ev_u', 'utterance', 6, '我也觉得这游戏根本不值得买。'), source: 'tool' },
  ]
  const m = deriveSelf(evs, { now: T0 + 6 * DAY_MS })
  assert.equal(m.facts.voicesEchoed, 0)
  assert.equal(findEcho({ at: evs[1].ts, text: evs[1].text }, evs), null)
})

test('7 天前读到、一直没表态的，就不再摆在眼前', () => {
  const evs = [
    ev('ev_seed', 'seed', 1, '种'),
    ev('ev_v', 'voice', 1, '这游戏根本不值得买'),
  ]
  assert.ok(deriveSelf(evs, { now: T0 + 2 * DAY_MS }).freshVoice)
  assert.equal(deriveSelf(evs, { now: T0 + 10 * DAY_MS }).freshVoice, null)
})

// -------------------------------------------------------------------- persona

test('身份文档里明确写着：那是别人说的，只有她说出口才算她的判断', () => {
  const m = deriveSelf([
    ev('ev_seed', 'seed', 1, '种'),
    ev('ev_v', 'voice', 2, '这游戏根本不值得买'),
  ], { now: T0 + 2 * DAY_MS })
  const text = personaLine(m, { budget: 4000 })
  assert.match(text, /## 你读到的一句话/)
  assert.match(text, /这游戏根本不值得买/)
  assert.match(text, /陌生人在评论区写的，不是你写的/)
  assert.match(text, /只有当你自己把说法说出口/)
})

// -------------------------------------------------------------------- 模板

test('someone_said：只有读到还没认下的评论时才出，问的是「你怎么看」', () => {
  const tpl = CATALOG.find((t) => t.id === 'someone_said')
  assert.ok(tpl, '模板必须存在')
  assert.equal(tpl.asks, true, '她可能拿这条来问我')
  assert.equal(tpl.repeat.everyDays, 10)

  const m = deriveSelf([ev('ev_seed', 'seed', 1, '种'), ev('ev_v', 'voice', 2, '这游戏根本不值得买')], { now: T0 + 2 * DAY_MS })
  assert.equal(tpl.cond(m), true)
  assert.match(tpl.prompt(m), /这游戏根本不值得买/)
  assert.match(tpl.prompt(m), /别只复述他的/)

  const none = deriveSelf([ev('ev_seed', 'seed', 1, '种')], { now: T0 + 2 * DAY_MS })
  assert.equal(tpl.cond(none), false)
})

// ------------------------------------------------------------------- 落盘

test('一轮浏览只留一条；关掉开关就一条都不留', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-voice-'))
  const packs = [pack('BV1', [{ text: '这个剪辑真的绝了', like: 9999 }])]
  const v = await recordVoice({ packs, events: [], model: { day: 2, stage: 1 }, root, cfg: {}, rng: () => 0.99 })
  assert.equal(v.why, 'liked')
  const raw = await readFile(join(root, 'events.jsonl'), 'utf8')
  assert.match(raw, /"type":"voice"/)
  assert.match(raw, /这个剪辑真的绝了/)

  const root2 = await mkdtemp(join(tmpdir(), 'fish-voice-off-'))
  const off = await recordVoice({ packs, events: [], model: { day: 2, stage: 1 }, root: root2, cfg: { browse: { voices: false } }, rng: () => 0.99 })
  assert.equal(off, null)
})
