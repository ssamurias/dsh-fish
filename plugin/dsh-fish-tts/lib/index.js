/**
 * dsh-fish-tts —— 给大肥鱼一套语音
 *
 * 三块，全在这一个插件里：
 *   1. **配置**：`<数据目录>/tts.json`（0600）——后端、音色、密钥、情绪覆盖；
 *      设置页通过 `/dsh-fish-tts/config` 读写，密钥只回 `***`。
 *   2. **工具**：`her_micro`，参数是「说什么」和「用什么情绪」；合成完回一行
 *      ` ```fish-voice ` 围栏文本，交给她在回复里原样带出去。
 *   3. **路由**：`/dsh-fish-tts/audio/<日期>/<文件>` 把 mp3 递给同源的播放器。
 *
 * 情绪不在这里做：emotion.js 是中间层，say 与 OpenAI 兼容各自翻译。
 * 这里只认「后端 + 一句话 + 一个情绪名」，不把任何一家的参数形状漏给工具。
 */

import { promises as fsp } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { loadConfig, saveConfig, publicConfig, applyPatch } from './config.js'
import { emotionCatalog } from './emotion.js'
import { listSayVoices } from './providers.js'
import { synthesize, resolveVoiceFile } from './tts.js'

export const name = 'dsh-fish-tts'

/** tools 必须有；webServer/connection 缺了只是没有设置页与路由，工具照跑。 */
/**
 * tools 与 webServer 都要声明：cordis 只把声明过的服务挂到 ctx 上。
 * 少了 webServer，`ctx.get('webServer')` 会是 null，路由整段被跳过——
 * 表现就是设置页「读配置失败」（404 空 body）。connection 不声明，
 * 守卫里用 ctx.get 现取，缺了就不做信任栅栏（headless 也能只跑工具）。
 */
export const inject = ['tools', 'webServer']

const PREFIX = '/dsh-fish-tts'

/** 围栏语言：客户端用同一个 key 注册播放器。 */
export const FENCE_LANG = 'fish-voice'

function safeGet(ctx, key) {
  try { return ctx.get?.(key) ?? ctx[key] ?? null } catch { return null }
}

/** 围栏里那一行。src 是站点绝对路径，播放器直接拿来当 audio.src。 */
export function fenceFor({ url, text, emotion }) {
  const payload = JSON.stringify({ src: url, text: String(text ?? '').slice(0, 300), emotion: String(emotion ?? '') })
  return '```' + FENCE_LANG + '\n' + payload + '\n```'
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(Object.assign(new Error('请求体太大'), { statusCode: 413 })); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function send(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' })
  res.end(body)
}

export function apply(ctx, config = {}) {
  const root = String(config.root || process.env.DSH_FISH_HOME || join(homedir(), '.dsh-fish'))
  const disposers = []
  // 配置在内存里留一份；保存后当场换掉，不用重启就能用新音色/新后端。
  const state = { cfg: null, why: '' }

  const ready = loadConfig(root).then((r) => {
    state.cfg = r.config
    state.why = r.why
    return r.config
  })

  async function cfgNow() {
    if (state.cfg) return state.cfg
    return ready
  }

  // ---- 工具 ----
  const tool = ctx.tools.register({
    // 叫 mic 不叫 voice：这是「让她用麦克风说一句」的工具，不是她这个人的嗓子。
    // 她的声音属性属于身份，不该被一个工具名替她定义。
    name: 'her_micro',
    description:
      '对着麦克风说一句：生成一段语音，并把播放器放进对话里。'
      + '参数是「说什么」（text）和「用什么情绪」（emotion，可省略，默认平静；'
      + '可选：平静/开心/温柔/难过/生气/惊讶/害羞/疲惫/兴奋/认真）。'
      + '它会回你一行以 ```fish-voice 开头的围栏文本——把那一整行原样放进你的回复里，'
      + '对话里就会出现可以点的播放器；不放进去，就只有你自己知道说过这句。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要念出来的话。' },
        emotion: { type: 'string', description: '情绪语气，比如「温柔」「开心」；不写就是平静。' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          fence: { type: 'string' },
          url: { type: 'string' },
          emotion: { type: 'string' },
          provider: { type: 'string' },
          bytes: { type: 'number' },
          why: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_args, out) => {
        if (out?.ok && out.fence) return [{ type: 'text', text: out.fence }]
        return [{ type: 'text', text: String(out?.why || '这声没发出来。') }]
      },
    },
    async execute(args = {}) {
      const cfg = await cfgNow()
      const text = String(args?.text ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
      if (!text) return { ok: false, why: '没有要念的内容。' }
      if (text.length > cfg.maxChars) {
        return { ok: false, why: `太长了：一句最多 ${cfg.maxChars} 个字，这句 ${text.length} 个字。` }
      }
      const r = await synthesize({ root, text, emotion: args?.emotion, cfg })
      if (!r.ok) return { ok: false, why: r.why, emotion: r.emotion, provider: r.provider }
      const url = `${PREFIX}/audio/${r.rel}`
      return {
        ok: true,
        url,
        fence: fenceFor({ url, text, emotion: r.emotion }),
        emotion: r.emotion,
        provider: r.provider,
        bytes: r.bytes,
      }
    },
  })
  if (typeof tool === 'function') disposers.push(tool)
  else if (tool && typeof tool.dispose === 'function') disposers.push(() => tool.dispose())

  // ---- 路由 ----
  const webServer = safeGet(ctx, 'webServer')
  if (webServer?.register) {
    const guarded = (handler) => async (req, res) => {
      const conn = safeGet(ctx, 'connection')
      if (conn?.requestRejection) {
        try {
          const rejection = conn.requestRejection(req)
          if (rejection) return send(res, rejection.status ?? 403, { error: rejection.message ?? 'forbidden' })
        } catch { return send(res, 503, { error: 'trust check failed' }) }
      }
      try { await handler(req, res) } catch (err) { send(res, err?.statusCode ?? 500, { error: String(err?.message ?? err) }) }
    }

    const routes = [
      ['/config', guarded(async (req, res) => {
        if (req.method === 'GET') {
          const cfg = await cfgNow()
          return send(res, 200, {
            ...publicConfig(cfg),
            emotions: emotionCatalog(cfg.emotions),
            why: state.why,
            root,
          })
        }
        if (req.method === 'POST') {
          const raw = await readBody(req)
          let patch = {}
          try { patch = JSON.parse(raw || '{}') } catch { return send(res, 400, { error: '正文不是 JSON' }) }
          const cur = await cfgNow()
          const next = applyPatch(cur, patch)
          try {
            state.cfg = await saveConfig(root, next)
            state.why = ''
          } catch (err) {
            return send(res, 500, { error: `配置写不进去：${String(err?.message ?? err)}` })
          }
          return send(res, 200, { ok: true, ...publicConfig(state.cfg), emotions: emotionCatalog(state.cfg.emotions) })
        }
        return send(res, 405, { error: 'method not allowed' })
      })],
      ['/voices', guarded(async (req, res) => {
        const r = await listSayVoices()
        return send(res, 200, r)
      })],
      ['/audio', guarded(async (req, res) => {
        const full = String(req.url ?? '').split('?')[0]
        const rel = decodeURIComponent(full.slice((PREFIX + '/audio/').length))
        const file = resolveVoiceFile(root, rel)
        if (!file) return send(res, 400, { error: '路径不对' })
        try {
          const data = await fsp.readFile(file)
          res.writeHead(200, {
            'content-type': 'audio/mpeg',
            'content-length': data.length,
            'cache-control': 'private, max-age=86400',
          })
          res.end(data)
        } catch {
          send(res, 404, { error: '没有这段语音' })
        }
      })],
    ]

    for (const [p, handler] of routes) {
      const ex = p === '/audio'
        ? { kind: 'prefix', path: PREFIX + p, handler }
        : { kind: 'exact', path: PREFIX + p, handler }
      try {
        const d = webServer.register(ex)
        if (typeof d === 'function') disposers.push(d)
        else if (d && typeof d.dispose === 'function') disposers.push(() => d.dispose())
      } catch (err) {
        console.warn('[dsh-fish-tts] 路由注册失败', p, err?.message ?? err)
      }
    }
  }

  return () => {
    for (const d of disposers) { try { d() } catch { /* ignore */ } }
  }
}
