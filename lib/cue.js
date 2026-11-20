/**
 * cue.js —— 他一开口，碰到她有过判断的话题，就把那句旧话摆到她眼前（1.0.4）
 *
 * 这不是「近三天」那种常驻频道。它只在**他这一句话**碰到某个 topic 时出现，
 * 随这一轮结束就消失；不占身份文档、不每轮都摆、也不替她判对错。
 *
 * 设计边界：
 *   - 只认她自己的判断（deriveSelf 的 active beliefs），且要和他这句话碰得上；
 *   - 最多 1 条，按主题词/近义词/原话关键词给分，过了门槛才摆；
 *   - 只给她原话和日期，加一句「只是当时说过，不代表现在也这么想」；
 *   - 「规矩」不摆：规矩是硬约束，不是可对照的旧判断；
 *   - 拿不到最新派生（进程刚起、还没写过身份文档）就不摆，不猜。
 *
 * 为什么用 memory 里的最新派生，而不是每句话都重算事件流：
 *   身份文档每次写盘都会 deriveSelf 一次，结果已经是最新的；他一开口只要同步
 *   匹配文本即可。cueFor 第一次求值后把结果缓存到这一轮结束，避免她这一轮中途
 *   写下的新判断反过来被当成「旧话」。
 *
 * 1.0.7：匹配从「topic 原词出现在句子里」扩成三路给分——原词 1.0、近义词 0.7、
 * 原话关键词（中文二字组，去掉常用虚词）重合三条以上 0.6。原因：她自己的 topic
 * 往往只有两三个字（「叫老大」「怕黑」），他换一种说法就撞不上了；而只把匹配
 * 放宽成「句子里有任意汉字」又会天天乱摆。
 */

import { dateKey, configCache } from './settings.js'
import { lastDerived } from './derive.js'
import { logLine } from './log.js'

const RULE_TOPIC = '规矩'
const OLD_TEXT_MAX = 80
/** 兜底过期：turn/end 丢了、进程刚起，也不让上一句的 cue 一直挂着。 */
export const CUE_TTL_MS = 15 * 60_000
/** 过这个分数才摆。原词 1.0、近义词 0.7、关键词 0.6 —— 刚好卡在 0.6。 */
export const CUE_MIN_SCORE = 0.6

/**
 * 同一个意思的另一种说法。只收「她可能真的会这么说」的对子，
 * 不收下位词（「猫」收进「动物」会天天误撞）。这张表故意很短。
 */
const CUE_SYNONYMS = {
  生气: ['恼火', '气死', '有气'],
  烦: ['心烦', '烦躁', '受不了'],
  累: ['困', '乏', '撑不住', '扛不住'],
  开心: ['高兴', '痛快', '乐呵'],
  难过: ['伤心', '失落', '难受'],
  喜欢: ['爱', '中意', '偏疼'],
  讨厌: ['烦', '受不了', '看不惯'],
  害怕: ['怕', '慌', '发怵'],
  孤单: ['寂寞', '没人陪', '冷清'],
  担心: ['不放心', '怕出事'],
}

/** 关键词打分只数有信息量的二字组：这些撞上了不算数。 */
const CUE_STOP_BI = new Set([
  '什么', '不是', '可以', '我们', '你们', '他们', '这个', '那个', '时候',
  '知道', '觉得', '一个', '没有', '就是', '还是', '因为', '所以', '但是',
  '如果', '真的', '自己', '事情', '东西', '现在', '已经', '一点', '有点',
  '怎么', '这样', '那样', '可能', '应该', '需要', '喜欢', '不要', '不会',
])

const latestText = new Map()
const latestAt = new Map()
const cueCache = new Map()

/** 他这一句话里的二字组（去标点、去常用词）。 */
function bigrams(s) {
  const chars = [...String(s ?? '').replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, '')]
  const out = new Set()
  for (let i = 0; i + 1 < chars.length; i++) {
    const g = chars[i] + chars[i + 1]
    if (!CUE_STOP_BI.has(g)) out.add(g)
  }
  return out
}

/**
 * 一条判断和他这句话有多碰得上。纯函数，给测试与日志用。
 * @returns {{ score: number, via: 'topic'|'synonym'|'words' }|null}
 */
export function cueScore(belief, humanLower) {
  if (!belief || belief.status !== 'active') return null
  const topic = String(belief.topic ?? '').trim()
  if (!topic || topic === RULE_TOPIC) return null
  // 单字 topic 太容易撞（「好」「人」），不拿它当 cue。
  if ([...topic].length < 2) return null
  const lower = String(humanLower ?? '')
  if (!lower) return null

  const t = topic.toLowerCase()
  if (lower.includes(t)) return { score: 1, via: 'topic' }

  const syn = CUE_SYNONYMS[topic] ?? []
  if (syn.some((w) => w && lower.includes(w))) return { score: 0.7, via: 'synonym' }

  // 原话关键词：她自己那句里至少有三个二字组在他这句话里也出现。
  const said = String(belief.text ?? '')
  if (said) {
    const shared = [...bigrams(said)].filter((g) => lower.includes(g)).length
    if (shared >= 3) return { score: 0.6, via: 'words' }
  }
  return null
}

/** 他一开口就记下这句话（同步，能在宿主组装提示词之前跑到）。 */
export function rememberHuman(sessionId, text, { at = Date.now() } = {}) {
  const sid = String(sessionId ?? '')
  const t = String(text ?? '').trim()
  if (!sid) return
  if (!t) {
    latestText.delete(sid)
    latestAt.delete(sid)
    cueCache.delete(sid)
    return
  }
  latestText.set(sid, t)
  latestAt.set(sid, at)
  cueCache.delete(sid)
}

/** 这一轮结束（或他离开）就撤掉，免得下一轮还挂着上一句的旧话。 */
export function clearHuman(sessionId) {
  const sid = String(sessionId ?? '')
  latestText.delete(sid)
  latestAt.delete(sid)
  cueCache.delete(sid)
}

/**
 * 这一轮要摆的那一行；没有就空串。同步，可安全给 systemPrompt.section 的 text()。
 *
 * 开关（`cue.enabled`，1.0.7）读的是 loadConfig 留下的那份缓存：cueFor 是同步的，
 * 不能 await 读盘；设置页改完会立刻更新缓存，下一次求值就生效。
 */
export function cueFor(sessionId, { now = Date.now(), model, root } = {}) {
  const sid = String(sessionId ?? '')
  if (!sid) return ''
  if (configCache()?.cue?.enabled === false) return ''
  const text = latestText.get(sid) ?? ''
  if (!text) return ''
  const at = latestAt.get(sid) ?? 0
  if (now - at > CUE_TTL_MS) {
    latestText.delete(sid)
    latestAt.delete(sid)
    cueCache.delete(sid)
    return ''
  }
  if (cueCache.has(sid)) return cueCache.get(sid)
  let line = ''
  try {
    line = cueLineFrom(model === undefined ? lastDerived() : model, text, { root })
  } catch {
    line = ''
  }
  cueCache.set(sid, line)
  return line
}

/**
 * 纯函数：从派生结果和他这句话里找一条旧判断。
 * @param {object|null} model deriveSelf 的结果
 * @param {string} text 他这一句
 * @param {{ now?: number, root?: string }} [opts]
 * @returns {string} 空串表示不摆
 */
export function cueLineFrom(model, text, { now = Date.now(), root } = {}) {
  const t = String(text ?? '').trim()
  if (!t) return ''
  const lower = t.toLowerCase()
  const scored = []
  for (const b of model?.beliefs ?? []) {
    const hit = cueScore(b, lower)
    if (hit && hit.score >= CUE_MIN_SCORE) scored.push({ b, ...hit })
  }
  if (!scored.length) return ''
  scored.sort((x, y) => (y.score - x.score) || ((Date.parse(y.b.since) || 0) - (Date.parse(x.b.since) || 0)))
  const { b, score, via } = scored[0]
  const said = String(b.text ?? '').replace(/\s+/g, ' ').trim()
  if (!said) return ''
  // 命中留一行日志：只给通道、分数、主题词，不打他的原话（H，1.0.7）。
  try {
    if (root) logLine('info', ['cue', `via=${via}`, `score=${score.toFixed(2)}`, `topic=${String(b.topic ?? '')}`], root)
  } catch { /* 日志挂了不挡 cue */ }
  const clipped = [...said].length > OLD_TEXT_MAX
    ? `${[...said].slice(0, OLD_TEXT_MAX).join('')}…`
    : said
  const at = Date.parse(b.since)
  const when = Number.isFinite(at) ? dateKey(new Date(at)).slice(5) : ''
  const stamp = when ? `（${when}）` : ''
  return [
    '## 这一句碰到的旧话',
    `- 你以前说过：「${clipped}」${stamp}。只是你当时说过，不代表现在也这么想。`,
  ].join('\n')
}
