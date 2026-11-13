/**
 * 测试只钉「形状」与「边界」，不真的调 say、不真的发网络请求。
 *   - 情绪层：中文/别名/认不出时的回退、覆盖只改指定字段
 *   - 配置：夹紧、密钥掩码、`***` 保留原值、0600 落盘
 *   - 两家后端：请求体与命令行参数长什么样；失败时给一句话而不是抛
 *   - 落盘：文件名/相对路径、路径穿越被挡
 *   - 工具：空文本与超长在合成之前就被拒（不白花一次合成）
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { normalizeEmotion, emotionFor, emotionCatalog } from '../lib/emotion.js'
import { normalizeConfig, applyPatch, publicConfig, saveConfig, loadConfig } from '../lib/config.js'
import { synthesizeSay, synthesizeOpenAI } from '../lib/providers.js'
import { synthesize, resolveVoiceFile, voiceDirFor } from '../lib/tts.js'
import { fenceFor, apply as applyPlugin } from '../lib/index.js'

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'tts-test-'))
  try { await fn(dir) } finally { await rm(dir, { recursive: true, force: true }) }
}

// ---------------------------------------------------------------- 情绪层

test('情绪：中文、英文、别名都能收敛', () => {
  assert.equal(normalizeEmotion('温柔').key, 'gentle')
  assert.equal(normalizeEmotion('gentle').key, 'gentle')
  assert.equal(normalizeEmotion('轻柔').key, 'gentle')
  assert.equal(normalizeEmotion('高兴').key, 'happy')
})

test('情绪：没写 = 平静且不算错；写了认不出 = 平静且标记 matched:false', () => {
  assert.deepEqual(normalizeEmotion(''), { key: 'neutral', matched: true })
  assert.deepEqual(normalizeEmotion('暴躁'), { key: 'neutral', matched: false })
})

test('情绪：say 与 openai 拿到各自的参数', () => {
  const s = emotionFor('温柔', 'say')
  assert.equal(s.key, 'gentle')
  assert.equal(s.label, '温柔')
  assert.equal(s.args.rate, 160)
  assert.equal(s.args.pbas, -2)
  const o = emotionFor('温柔', 'openai')
  assert.equal(o.args.speed, 0.95)
  assert.match(o.args.instructions, /悄悄话/)
})

test('情绪：覆盖是逐字段合并，不把整块顶掉', () => {
  const r = emotionFor('温柔', 'say', { gentle: { say: { rate: 120 } } })
  assert.equal(r.args.rate, 120)
  assert.equal(r.args.pbas, -2, '没写的字段该保留默认')
})

test('情绪：覆盖表也认中文标签', () => {
  const r = emotionFor('温柔', 'openai', { 温柔: { openai: { speed: 0.8 } } })
  assert.equal(r.args.speed, 0.8)
  assert.match(r.args.instructions, /悄悄话/)
})

test('情绪清单：十个、顺序稳定、带覆盖后的值', () => {
  const list = emotionCatalog({ gentle: { say: { rate: 111 } } })
  assert.equal(list.length, 10)
  assert.equal(list[0].key, 'neutral')
  assert.equal(list.find((x) => x.key === 'gentle').say.rate, 111)
})

// ---------------------------------------------------------------- 配置

test('配置：坏值被夹紧或退回默认，不抛', () => {
  const c = normalizeConfig({
    provider: 'nope',
    say: { rate: 9999, voice: 'x'.repeat(500) },
    openai: { baseURL: 'ftp://x', model: '', voice: '', apiKey: 'k', instructions: 'no' },
    maxChars: 5,
    emotions: [1, 2],
  })
  assert.equal(c.provider, 'say')
  assert.equal(c.say.rate, 320)
  assert.equal(c.say.voice.length, 120)
  assert.equal(c.openai.baseURL, 'https://api.openai.com/v1')
  assert.equal(c.openai.model, 'gpt-4o-mini-tts')
  assert.equal(c.openai.apiKey, 'k')
  assert.equal(c.openai.instructions, true, '非 false 都按开处理')
  assert.equal(c.maxChars, 20)
  assert.deepEqual(c.emotions, {})
})

test('配置：publicConfig 只回 ***，不回密钥原文', () => {
  const c = normalizeConfig({ openai: { apiKey: 'sk-secret' } })
  const pub = publicConfig(c)
  assert.equal(pub.openai.apiKey, '***')
  assert.equal(pub.hasKey, true)
  assert.doesNotMatch(JSON.stringify(pub), /sk-secret/)
})

test('配置：applyPatch 收到 *** 时保留原密钥，空串才清空', () => {
  const cur = normalizeConfig({ openai: { apiKey: 'sk-old' } })
  const kept = applyPatch(cur, { openai: { apiKey: '***', model: 'tts-1' } })
  assert.equal(kept.openai.apiKey, 'sk-old')
  assert.equal(kept.openai.model, 'tts-1')
  const cleared = applyPatch(cur, { openai: { apiKey: '' } })
  assert.equal(cleared.openai.apiKey, '')
})

test('配置：落盘 0600，读回来一致', async () => {
  await withDir(async (dir) => {
    const c = normalizeConfig({ provider: 'openai', openai: { apiKey: 'k' }, maxChars: 100 })
    await saveConfig(dir, c)
    const file = join(dir, 'tts.json')
    const st = await stat(file)
    assert.equal(st.mode & 0o777, 0o600)
    const { config } = await loadConfig(dir)
    assert.equal(config.provider, 'openai')
    assert.equal(config.maxChars, 100)
  })
})

test('配置：坏 JSON 不覆盖，用默认值并说明原因', async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, 'tts.json'), '{not json')
    const { config, why } = await loadConfig(dir)
    assert.equal(config.provider, 'say')
    assert.match(why, /默认值/)
    assert.equal((await readFile(join(dir, 'tts.json'), 'utf8')), '{not json')
  })
})

// ---------------------------------------------------------------- 后端

test('say：命令行长什么样（音色/语速/pbas）', async () => {
  const calls = []
  const exec = async (cmd, args) => {
    calls.push([cmd, args])
    if (args.includes('-o')) return { ok: true, stdout: Buffer.alloc(0) }
    return { ok: true, stdout: Buffer.alloc(4096, 1) }
  }
  const r = await synthesizeSay({
    text: '你好', emotionArgs: { rate: 160, pbas: -2 },
    cfg: normalizeConfig({ say: { voice: 'Tingting', rate: 180 } }),
    deps: { exec, sayBin: 'say', ffmpegBin: 'ffmpeg' },
  })
  assert.equal(r.ok, true)
  assert.equal(r.provider, 'say')
  const sayCall = calls[0]
  assert.equal(sayCall[0], 'say')
  assert.deepEqual(sayCall[1].slice(0, 4), ['-v', 'Tingting', '-r', '160'])
  assert.match(sayCall[1][sayCall[1].length - 1], /^\[\[pbas -2\]\]你好$/)
  assert.equal(calls[1][0], 'ffmpeg')
  assert.ok(calls[1][1].includes('libmp3lame'))
})

test('say：合成失败时返回 ok:false 与原因，不抛', async () => {
  const exec = async () => ({ ok: false, why: 'boom' })
  const r = await synthesizeSay({ text: 'x', cfg: normalizeConfig({}), deps: { exec, sayBin: 'say' } })
  assert.equal(r.ok, false)
  assert.match(r.why, /say 没合成出来/)
})

test('openai：请求体与鉴权头正确', async () => {
  let seen = null
  const fetch = async (url, init) => {
    seen = { url, init }
    return { ok: true, arrayBuffer: async () => Buffer.alloc(2048, 2) }
  }
  const cfg = normalizeConfig({ provider: 'openai', openai: { apiKey: 'sk-1', model: 'gpt-4o-mini-tts', voice: 'alloy', baseURL: 'https://x.test/v1' } })
  const r = await synthesizeOpenAI({ text: '你好呀', emotionArgs: { speed: 0.95, instructions: '放轻' }, cfg, deps: { fetch } })
  assert.equal(r.ok, true)
  assert.equal(seen.url, 'https://x.test/v1/audio/speech')
  assert.equal(seen.init.headers.authorization, 'Bearer sk-1')
  const body = JSON.parse(seen.init.body)
  assert.equal(body.model, 'gpt-4o-mini-tts')
  assert.equal(body.voice, 'alloy')
  assert.equal(body.input, '你好呀')
  assert.equal(body.instructions, '放轻')
  assert.equal(body.response_format, 'mp3')
})

test('openai：没密钥直接说清楚，不发请求', async () => {
  let called = false
  const fetch = async () => { called = true }
  const r = await synthesizeOpenAI({ text: 'x', cfg: normalizeConfig({ provider: 'openai' }), deps: { fetch } })
  assert.equal(r.ok, false)
  assert.match(r.why, /密钥/)
  assert.equal(called, false)
})

test('openai：401 时把状态码与正文带回来', async () => {
  const fetch = async () => ({ ok: false, status: 401, text: async () => 'invalid api key' })
  const cfg = normalizeConfig({ provider: 'openai', openai: { apiKey: 'k' } })
  const r = await synthesizeOpenAI({ text: 'x', cfg, deps: { fetch } })
  assert.equal(r.ok, false)
  assert.match(r.why, /401/)
  assert.match(r.why, /invalid api key/)
})

// ---------------------------------------------------------------- 落盘与路径

test('落盘：文件名带日期目录与哈希，相对路径可被路由还原', async () => {
  await withDir(async (dir) => {
    const exec = async (cmd, args) => (args.includes('-o') ? { ok: true, stdout: Buffer.alloc(0) } : { ok: true, stdout: Buffer.alloc(4096, 3) })
    const cfg = normalizeConfig({ say: { voice: 'Tingting' } })
    const now = new Date(2026, 10, 13, 9, 30, 0)
    const r = await synthesize({ root: dir, text: '早', emotion: '温柔', cfg, deps: { exec, sayBin: 'say', ffmpegBin: 'ffmpeg', now } })
    assert.equal(r.ok, true)
    assert.match(r.rel, /^2026-11-13\/v-\d{8}-\d{6}-[0-9a-f]{8}\.mp3$/)
    assert.equal(r.emotion, '温柔')
    const back = resolveVoiceFile(dir, r.rel)
    assert.ok(back && back.startsWith(voiceDirFor(dir, now)))
    assert.equal((await stat(back)).size, 4096)
  })
})

test('路径：../、绝对路径、怪后缀都还原不出来', () => {
  const root = '/tmp/root'
  assert.equal(resolveVoiceFile(root, '../etc/passwd'), null)
  assert.equal(resolveVoiceFile(root, '/etc/passwd'), null)
  assert.equal(resolveVoiceFile(root, '2026-11-13/../../x.mp3'), null)
  assert.equal(resolveVoiceFile(root, '2026-11-13/x.sh'), null)
  assert.equal(resolveVoiceFile(root, '2026-11-13/a-b_c.mp3'), '/tmp/root/voice/2026-11-13/a-b_c.mp3')
})

// ---------------------------------------------------------------- 工具

test('工具：围栏文本带 src/text/emotion，且是合法的 fish-voice 代码块', () => {
  const fence = fenceFor({ url: '/dsh-fish-tts/audio/2026-11-13/a.mp3', text: '你好', emotion: '温柔' })
  assert.match(fence, /^```fish-voice\n/)
  assert.match(fence, /\n```$/)
  const json = JSON.parse(fence.split('\n')[1])
  assert.equal(json.src, '/dsh-fish-tts/audio/2026-11-13/a.mp3')
  assert.equal(json.text, '你好')
  assert.equal(json.emotion, '温柔')
})

test('工具：注册名与参数形状；空文本/超长在合成前被拒', async () => {
  await withDir(async (dir) => {
    // 预置一份 maxChars=20 的配置，execute 时会被读到
    await saveConfig(dir, normalizeConfig({ maxChars: 20 }))
    let spec = null
    // 宿主的 tools 是 ctx 上的服务；插件里直接 ctx.tools.register(...)，所以两个口都摆上
    const tools = { register: (s) => { spec = s; return () => {} } }
    const ctx = {
      tools,
      get: (k) => (k === 'tools' ? tools : undefined),
    }
    applyPlugin(ctx, { root: dir })
    assert.equal(spec.name, 'her_micro')
    assert.equal(spec.parameters.required[0], 'text')
    const empty = await spec.execute({ text: '   ' })
    assert.equal(empty.ok, false)
    const long = await spec.execute({ text: '字'.repeat(50) })
    assert.equal(long.ok, false)
    assert.match(long.why, /最多 20 个字/)
  })
})
