/**
 * emotion.js —— 「情绪 → 参数」的中间层
 *
 * 为什么要有这一层：同一句「温柔」，本地 say 只能调语速和音高基线，OpenAI 兼容接口
 * 能用 instructions 说人话、还能叠 speed。工具的参数不该长成某一家平台的形状，
 * 所以这里定一套**自己的情绪名**，再各自翻译：
 *
 *   她/用户这边只写「温柔」，plugin 这边决定 say 用 rate 160 + pbas -2、
 *   OpenAI 兼容接口用 speed 0.95 + 一句中文发声指导。
 *
 * 加一家新平台 = 在 EMOTIONS 的每一项里补一个字段，不加工具参数、不改工具说明。
 * 认不出的情绪不报错，退回「平静」——说错一种语气不该让她整句话发不出来。
 */

/**
 * 十个情绪。`label` 是给人看的写法，也是工具参数接受的中文名。
 * `say` 用 macOS 的语速（词/分）与音高基线（pbas，单位 Hz 的偏移）；
 * `openai` 用 speed 与一段直接的发音指导（gpt-4o-mini-tts 这类模型会照着念）。
 */
export const EMOTIONS = Object.freeze({
  neutral: {
    label: '平静',
    aliases: ['neutral', '普通', '自然', '默认'],
    say: { rate: 180, pbas: 0 },
    openai: { speed: 1, instructions: '用平静、自然的语气说。' },
  },
  happy: {
    label: '开心',
    aliases: ['开心', '高兴', '快乐', 'happy'],
    say: { rate: 205, pbas: 6 },
    openai: { speed: 1.08, instructions: '语气轻快，带一点笑意。' },
  },
  gentle: {
    label: '温柔',
    aliases: ['温柔', '轻柔', 'gentle', 'soft'],
    say: { rate: 160, pbas: -2 },
    openai: { speed: 0.95, instructions: '放轻、放慢，像在说悄悄话。' },
  },
  sad: {
    label: '难过',
    aliases: ['难过', '伤心', '低落', 'sad'],
    say: { rate: 150, pbas: -6 },
    openai: { speed: 0.9, instructions: '声音低沉、缓慢，带着难过。' },
  },
  angry: {
    label: '生气',
    aliases: ['生气', '愤怒', '恼火', 'angry'],
    say: { rate: 200, pbas: 5 },
    openai: { speed: 1.05, instructions: '压着火气，语气硬一点。' },
  },
  surprised: {
    label: '惊讶',
    aliases: ['惊讶', '吃惊', '意外', 'surprised'],
    say: { rate: 195, pbas: 8 },
    openai: { speed: 1.1, instructions: '意外、语气上扬。' },
  },
  shy: {
    label: '害羞',
    aliases: ['害羞', '不好意思', 'shy'],
    say: { rate: 165, pbas: 2 },
    openai: { speed: 0.95, instructions: '小声、有点迟疑，像不好意思。' },
  },
  tired: {
    label: '疲惫',
    aliases: ['疲惫', '累', '困', 'tired'],
    say: { rate: 140, pbas: -8 },
    openai: { speed: 0.88, instructions: '有气无力，像很累了。' },
  },
  excited: {
    label: '兴奋',
    aliases: ['兴奋', '激动', 'excited'],
    say: { rate: 215, pbas: 9 },
    openai: { speed: 1.12, instructions: '兴奋，语速偏快。' },
  },
  serious: {
    label: '认真',
    aliases: ['认真', '严肃', '郑重', 'serious'],
    say: { rate: 170, pbas: -1 },
    openai: { speed: 0.98, instructions: '认真、清楚，不带玩笑。' },
  },
})

/** 全部可接受的写法（中文标签、英文键、别名）→ 规范键。 */
const LOOKUP = (() => {
  const map = new Map()
  for (const [key, def] of Object.entries(EMOTIONS)) {
    map.set(key.toLowerCase(), key)
    map.set(def.label, key)
    for (const a of def.aliases) map.set(String(a).toLowerCase(), key)
  }
  return map
})()

/**
 * 把用户/她写的情绪名收敛成规范键。认不出就退回 neutral（不报错）。
 * @param {string} raw
 * @returns {{key:string, matched:boolean}}
 */
export function normalizeEmotion(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return { key: 'neutral', matched: true } // 没写 = 平静，这是默认，不是错
  return { key: LOOKUP.get(s.toLowerCase()) ?? 'neutral', matched: LOOKUP.has(s.toLowerCase()) }
}

/**
 * 取某个情绪在某家后端上的参数，允许配置覆盖。
 * 覆盖是**逐字段合并**：只改 rate 就只退 rate，pbas/instructions 照旧。
 *
 * @param {string} raw 情绪名（中文/英文/别名都行）
 * @param {'say'|'openai'} provider
 * @param {object} overrides 配置里的 emotions 覆盖表（按规范键或中文标签）
 * @returns {{key:string,label:string,args:object,matched:boolean}}
 */
export function emotionFor(raw, provider, overrides = {}) {
  const { key, matched } = normalizeEmotion(raw)
  const def = EMOTIONS[key]
  const base = def[provider] ?? def.neutral ?? {}
  const ov = findOverride(overrides, key, def.label) ?? {}
  const patch = ov[provider] && typeof ov[provider] === 'object' ? ov[provider] : {}
  return { key, label: def.label, args: { ...base, ...patch }, matched }
}

/** 覆盖表里既接受规范键，也接受中文标签。 */
function findOverride(overrides, key, label) {
  if (!overrides || typeof overrides !== 'object') return null
  const byKey = overrides[key]
  if (byKey && typeof byKey === 'object') return byKey
  const byLabel = overrides[label]
  if (byLabel && typeof byLabel === 'object') return byLabel
  return null
}

/** 给设置页用的情绪清单（稳定顺序，不含函数）。 */
export function emotionCatalog(overrides = {}) {
  return Object.entries(EMOTIONS).map(([key, def]) => ({
    key,
    label: def.label,
    aliases: def.aliases.filter((a) => a !== key && a !== def.label),
    say: { ...def.say, ...(findOverride(overrides, key, def.label)?.say ?? {}) },
    openai: { ...def.openai, ...(findOverride(overrides, key, def.label)?.openai ?? {}) },
  }))
}
