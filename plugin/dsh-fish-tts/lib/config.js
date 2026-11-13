/**
 * config.js —— TTS 的配置：后端、音色、密钥、情绪覆盖
 *
 * 存哪：`<数据目录>/tts.json`，权限 0600（只有当前用户能读）。
 * 为什么不去写 profile 的 cordis.patch.yml：那是用户的文件，里面还有别的插件；
 * 文档也明确禁止插件改它。密钥放同一个文件里、权限 0600，和这个仓库里
 * owner.json（B 站 cookie）的做法保持一致——它们同属「本机凭据」这一档。
 *
 * 铁律：**读出来的密钥永远不回给浏览器**。GET /config 只回 `hasKey` 与 `***`，
 * 保存时收到 `***` 就当「没改」，只有真的给了新值才覆盖。
 */

import { promises as fsp } from 'node:fs'
import { join } from 'node:path'

export const CONFIG_FILE = 'tts.json'

export const DEFAULTS = Object.freeze({
  provider: 'say',
  say: { voice: '', rate: 180 },
  openai: {
    baseURL: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini-tts',
    voice: 'alloy',
    apiKey: '',
    instructions: true,
  },
  // 情绪覆盖：{ happy: { say: { rate: 220 }, openai: { speed: 1.2 } } }
  emotions: {},
  // 一句语音最多多少字：太长既不像说话，也会把请求撑爆
  maxChars: 500,
})

export function configPath(root) {
  return join(String(root || ''), CONFIG_FILE)
}

/** 夹一个数到区间；不是数就用默认值。 */
export function clampNum(v, min, max, fallback) {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function str(v, max = 200) {
  return String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max)
}

/**
 * 把任意输入收敛成合法配置。永远不抛：坏值退回默认，而不是让插件起不来。
 * @param {object} raw
 * @returns {object} 新的配置对象
 */
export function normalizeConfig(raw = {}) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const say = r.say && typeof r.say === 'object' ? r.say : {}
  const openai = r.openai && typeof r.openai === 'object' ? r.openai : {}
  const provider = r.provider === 'openai' ? 'openai' : 'say'
  const baseURL = str(openai.baseURL ?? DEFAULTS.openai.baseURL, 500).replace(/\/+$/, '') || DEFAULTS.openai.baseURL
  return {
    provider,
    say: {
      voice: str(say.voice ?? DEFAULTS.say.voice, 120),
      rate: Math.round(clampNum(say.rate, 90, 320, DEFAULTS.say.rate)),
    },
    openai: {
      baseURL: /^https?:\/\//i.test(baseURL) ? baseURL : DEFAULTS.openai.baseURL,
      model: str(openai.model ?? DEFAULTS.openai.model, 120) || DEFAULTS.openai.model,
      voice: str(openai.voice ?? DEFAULTS.openai.voice, 120) || DEFAULTS.openai.voice,
      apiKey: str(openai.apiKey ?? '', 400),
      instructions: openai.instructions !== false,
    },
    emotions: r.emotions && typeof r.emotions === 'object' && !Array.isArray(r.emotions) ? r.emotions : {},
    maxChars: Math.round(clampNum(r.maxChars, 20, 1000, DEFAULTS.maxChars)),
  }
}

/** 读盘。文件不在就返回默认值；坏 JSON 不覆盖，报一句原因。 */
export async function loadConfig(root) {
  const file = configPath(root)
  try {
    const text = await fsp.readFile(file, 'utf8')
    const raw = JSON.parse(text.replace(/^\uFEFF/, ''))
    return { config: normalizeConfig(raw), file, why: '' }
  } catch (err) {
    if (err && err.code === 'ENOENT') return { config: normalizeConfig({}), file, why: '' }
    return { config: normalizeConfig({}), file, why: `配置读不出来（${String(err?.message ?? err).slice(0, 80)}），这次用默认值。` }
  }
}

/** 写盘：先写临时文件再改名，0600。 */
export async function saveConfig(root, next) {
  const file = configPath(root)
  const cfg = normalizeConfig(next)
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  await fsp.writeFile(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 })
  await fsp.chmod(tmp, 0o600).catch(() => {})
  await fsp.rename(tmp, file)
  return cfg
}

/**
 * 回给浏览器的形状：密钥只回「有没有」，不回原值。
 * 这样设置页能显示「已保存」，而 DevTools 里也看不到凭据。
 */
export function publicConfig(config) {
  const c = normalizeConfig(config)
  const hasKey = Boolean(c.openai.apiKey)
  return {
    ...c,
    openai: { ...c.openai, apiKey: hasKey ? '***' : '' },
    hasKey,
  }
}

/**
 * 合并浏览器提交的补丁。`***` = 保留原值；空串 = 清空。
 * 只接受已知字段，避免调用方顺手塞进来的东西落盘。
 */
export function applyPatch(current, patch = {}) {
  const cur = normalizeConfig(current)
  const p = patch && typeof patch === 'object' ? patch : {}
  const next = { ...cur }
  if (p.provider === 'say' || p.provider === 'openai') next.provider = p.provider
  if (p.say && typeof p.say === 'object') {
    next.say = {
      voice: p.say.voice === undefined ? cur.say.voice : String(p.say.voice),
      rate: p.say.rate === undefined ? cur.say.rate : p.say.rate,
    }
  }
  if (p.openai && typeof p.openai === 'object') {
    const o = p.openai
    const key = o.apiKey === undefined || o.apiKey === '***' ? cur.openai.apiKey : String(o.apiKey)
    next.openai = {
      baseURL: o.baseURL === undefined ? cur.openai.baseURL : String(o.baseURL),
      model: o.model === undefined ? cur.openai.model : String(o.model),
      voice: o.voice === undefined ? cur.openai.voice : String(o.voice),
      apiKey: key,
      instructions: o.instructions === undefined ? cur.openai.instructions : Boolean(o.instructions),
    }
  }
  if (p.emotions !== undefined) next.emotions = p.emotions
  if (p.maxChars !== undefined) next.maxChars = p.maxChars
  return normalizeConfig(next)
}
