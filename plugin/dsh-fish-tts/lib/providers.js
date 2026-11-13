/**
 * providers.js —— 两家后端：本地 macOS `say`、OpenAI 兼容的 /audio/speech
 *
 * 两家的输出都收敛成**一段 mp3 的字节**，上面的 tts.js 只管落盘与命名。
 * 这样加第三家（Azure、火山、本地 GPT-SoVITS…）只需要在这里多一个函数，
 * 工具、路由、客户端播放器都不用动。
 *
 * 这一层刻意不抛出：所有失败都回 `{ok:false, why}`，因为一次合成失败
 * 不该让她的整轮对话断掉。
 */

import { execFile } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/** 一句语音最多多久：防止某个后端把请求挂死。 */
export const TTS_TIMEOUT_MS = 60_000
/** ffmpeg 的 stdout 上限：五分钟的 mp3 也远小于这个数。 */
const MAX_BUFFER = 32 * 1024 * 1024

/** execFile 的 Promise 版，带超时与输出上限。测试里可以整只替换掉。 */
export function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, {
      timeout: opts.timeout ?? TTS_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      encoding: 'buffer',
      windowsHide: true,
    }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, code: err.code, why: String(stderr || err.message || err).slice(0, 400), stdout })
      resolve({ ok: true, stdout })
    })
  })
}

/**
 * 本地 say：先合成 AIFF，再用 ffmpeg 转 mp3（走管道，不留中间文件）。
 * 情绪体现在语速与音高基线（`[[pbas N]]`）上——say 没有别的表达参数。
 */
export async function synthesizeSay({ text, emotionArgs = {}, cfg = {}, deps = {} }) {
  const exec = deps.exec ?? run
  const voice = String(cfg.say?.voice || '').trim()
  const rate = Math.round(Number(emotionArgs.rate ?? cfg.say?.rate ?? 180))
  const pbas = Math.round(Number(emotionArgs.pbas ?? 0))
  const sayBin = deps.sayBin ?? '/usr/bin/say'
  const ffmpeg = deps.ffmpegBin ?? 'ffmpeg'

  if (process.platform !== 'darwin' && !deps.sayBin) {
    return { ok: false, why: '本地 say 只在 macOS 上有；这台机器不是 macOS。' }
  }

  const dir = await fsp.mkdtemp(join(tmpdir(), 'dsh-tts-'))
  const aiff = join(dir, 'out.aiff')
  try {
    // pbas 必须是合成文本的最前面一条命令；正数是升调。
    const spoken = pbas === 0 ? text : `[[pbas ${pbas}]]${text}`
    const sayArgs = []
    if (voice) sayArgs.push('-v', voice)
    sayArgs.push('-r', String(rate), '-o', aiff, '--', spoken)
    const said = await exec(sayBin, sayArgs)
    if (!said.ok) return { ok: false, why: `say 没合成出来：${said.why}` }

    const conv = await exec(ffmpeg, [
      '-hide_banner', '-loglevel', 'error',
      '-i', aiff,
      '-codec:a', 'libmp3lame', '-qscale:a', '4',
      '-f', 'mp3', '-',
    ])
    if (!conv.ok) return { ok: false, why: `转 mp3 失败：${conv.why}` }
    const buf = Buffer.isBuffer(conv.stdout) ? conv.stdout : Buffer.from(conv.stdout ?? '')
    if (buf.length < 100) return { ok: false, why: '合成出来的音频是空的。' }
    return { ok: true, audio: buf, ext: 'mp3', provider: 'say', why: '' }
  } finally {
    fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * OpenAI 兼容：POST <baseURL>/audio/speech。
 * - 默认 gpt-4o-mini-tts 认 `instructions`（一句中文发声指导），关掉就不发这个字段
 * - `speed` 是 API 的硬参数（0.25–4.0），情绪与它相乘
 */
export async function synthesizeOpenAI({ text, emotionArgs = {}, cfg = {}, deps = {} }) {
  const fetchImpl = deps.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') return { ok: false, why: '这台机器上没有 fetch，发不出请求。' }
  const o = cfg.openai ?? {}
  if (!String(o.apiKey || '').trim()) {
    return { ok: false, why: '还没填 OpenAI 兼容接口的密钥：设置 → 语音 里填，或先切回本地 say。' }
  }
  const url = `${String(o.baseURL || '').replace(/\/+$/, '')}/audio/speech`
  const speed = clamp(Number(emotionArgs.speed ?? 1) * 1, 0.25, 4)
  const body = {
    model: o.model,
    voice: o.voice,
    input: text,
    response_format: 'mp3',
    speed,
  }
  if (o.instructions !== false && emotionArgs.instructions) body.instructions = String(emotionArgs.instructions)
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), TTS_TIMEOUT_MS) : null
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${o.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller?.signal,
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      return { ok: false, why: `接口回 ${res.status}：${String(detail).slice(0, 200) || '没有正文'}` }
    }
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < 100) return { ok: false, why: '接口回来了，但音频是空的。' }
    return { ok: true, audio: buf, ext: 'mp3', provider: 'openai', why: '' }
  } catch (err) {
    if (err?.name === 'AbortError') return { ok: false, why: '接口超时（60 秒），这次没合成出来。' }
    return { ok: false, why: `请求发不出去：${String(err?.message ?? err).slice(0, 200)}` }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function clamp(n, min, max) {
  if (!Number.isFinite(n)) return 1
  return Math.min(max, Math.max(min, n))
}

/** 按配置挑一家。 */
export function providerOf(cfg) {
  return cfg?.provider === 'openai' ? synthesizeOpenAI : synthesizeSay
}

/**
 * 本机有哪些 say 音色（设置页的下拉框用）。
 * 解析 `say -v '?'` 的三列：名字、语言、示例。
 */
export async function listSayVoices(deps = {}) {
  const exec = deps.exec ?? run
  const r = await exec(deps.sayBin ?? '/usr/bin/say', ['-v', '?'])
  if (!r.ok) return { ok: false, voices: [], why: `读不到音色列表：${r.why}` }
  const text = Buffer.isBuffer(r.stdout) ? r.stdout.toString('utf8') : String(r.stdout ?? '')
  const voices = []
  for (const line of text.split('\n')) {
    const m = line.match(/^(.+?)\s{2,}([a-z]{2}_[A-Z]{2}|[a-z]{2})\s{2,}/)
    if (m) voices.push({ name: m[1].trim(), locale: m[2] })
  }
  return { ok: true, voices, why: '' }
}
