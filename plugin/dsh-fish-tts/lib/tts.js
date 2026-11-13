/**
 * tts.js —— 「一句话 → 一个 mp3 文件」的编排
 *
 * 分工：emotion.js 决定参数，providers.js 决定怎么发，这一层只做三件事：
 *   1. 挑后端、把情绪参数翻过去；
 *   2. 把音频落到 `<数据目录>/voice/<日期>/` 下（文件名带时间与内容哈希，不覆盖旧的）；
 *   3. 回一个**相对路径**，由 index.js 拼成浏览器能取的 URL。
 *
 * 不写事件流、不碰她的记忆：语音是她说出口的东西，不是她又长出来的一层。
 */

import { promises as fsp } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

import { emotionFor } from './emotion.js'
import { providerOf, synthesizeSay, synthesizeOpenAI } from './providers.js'

/** mp3 放在哪一天。用本地日期，和她写日记的口径一致。 */
export function voiceDirFor(root, date = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return join(String(root || ''), 'voice', `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`)
}

/** 音频在一次合成之后的相对路径（日期/文件名），路由与渲染都用它。 */
export function voiceRel(dateKey, name) {
  return `${dateKey}/${name}`
}

function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
}

/**
 * 合成一句。
 *
 * @param {object} o
 * @param {string} o.root   数据目录
 * @param {string} o.text   要念的话（调用方已经校验过长度）
 * @param {string} o.emotion 情绪名（中文/英文都行）
 * @param {object} o.cfg    归一化后的配置
 * @param {object} [o.deps] 单测注入：{ exec, fetch, sayBin, ffmpegBin, now }
 * @returns {Promise<{ok:boolean, why:string, rel?:string, bytes?:number, emotion?:string, provider?:string}>}
 */
export async function synthesize({ root, text, emotion = '平静', cfg, deps = {} }) {
  const provider = cfg?.provider === 'openai' ? 'openai' : 'say'
  const emo = emotionFor(emotion, provider, cfg?.emotions)
  const now = deps.now ? new Date(deps.now) : new Date()

  let out
  if (provider === 'openai') {
    out = await synthesizeOpenAI({ text, emotionArgs: emo.args, cfg, deps })
  } else {
    out = await synthesizeSay({ text, emotionArgs: emo.args, cfg, deps })
  }
  if (!out.ok) {
    return { ok: false, why: out.why || '没合成出来。', emotion: emo.label, provider }
  }

  const dir = voiceDirFor(root, now)
  await fsp.mkdir(dir, { recursive: true })
  const hash = createHash('sha1').update(`${provider}|${emo.key}|${text}`).digest('hex').slice(0, 8)
  const name = `v-${stamp(now)}-${hash}.${out.ext || 'mp3'}`
  const file = join(dir, name)
  await fsp.writeFile(file, out.audio, { mode: 0o644 })
  const st = await fsp.stat(file)
  return {
    ok: true,
    why: '',
    rel: voiceRel(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`, name),
    file,
    bytes: st.size,
    emotion: emo.label,
    provider,
  }
}

/** 路由用：把相对路径安全地还原成文件路径；越界一律 null。 */
export function resolveVoiceFile(root, rel) {
  const clean = String(rel ?? '').replace(/\\/g, '/')
  if (!/^\d{4}-\d{2}-\d{2}\/[A-Za-z0-9._-]+\.(mp3|wav|aiff|ogg)$/.test(clean)) return null
  const base = join(String(root || ''), 'voice')
  const file = join(base, clean)
  // 再确认一次：拼出来的路径必须仍在 voice/ 下面（正则已经挡了 ../，这里兜底）
  if (!file.startsWith(base + '/')) return null
  return file
}
