/**
 * voices.js —— 评论区里别人的话（2026-10-24，用户 m02454）
 *
 * 用户的要求：她在 B 站评论区扫到的回复，也能算认知/判断/记忆的一部分，
 * 但**占比要小**（评论的文本量太大，不能整包塞进去），可以随机抽、也可以挑重复率高的。
 *
 * 这里的取舍（三条，写清楚免得以后自己忘记）：
 *
 *   1. **别人的话不是她的判断。** 一条评论进事件流，但**不进 beliefs**——
 *      她要说出口，那句才算她的。否则她只是在复述陌生人。
 *   2. **量要小。** 每次浏览最多留 1 条；同一句 30 天内不再出现；
 *      优先留跨视频重复出现的那句（那说明它在人群里是共识），其次高赞短句，最后才 25% 随机抽。
 *   3. **认下来才算数。** deriveSelf 会检查：这条评论出现后三天内，她有没有说过一句
 *      意思相近的话（similarity ≥ 0.7）。说了就叫"回声"，那条 utterance 本身已经是一条判断，
 *      于是它能和旧判断打架、能被固化、能进「你有两句话对不上」——**认知循环是从这里接上的**。
 *
 * 落盘类型是 `voice`（系统侧写，她写不了，不在 HER_TYPES 里）：
 *   text = 评论原话（≤200 字），refs = [bvid]，like 数量写进 text 前的标记？不——
 *   点赞数不进 text，进不了 schema；观测台要的话从 browse 的返回值里拿。
 */

import { similarity } from './derive.js'
import { appendEvent } from './store.js'

// 不用 derive 的 DAY_MS：derive 会反过来 import 这个文件（用函数没问题），
// 但顶层 const 会在循环加载时撞上 TDZ。这里自己算一份。
const DAY_MS = 86_400_000

/** 一条评论最多留多少字——评论区里 200 字以上的基本是长文，不要 */
export const VOICE_MAX = 200
/** 「高赞」门槛：低于这个数的只能靠重复或随机进来 */
export const VOICE_MIN_LIKE = 800
/** 没有重复、也没有高赞时的随机概率——用户要的「占比比较少」就落在这里 */
export const VOICE_RANDOM = 0.25
/** 同一句话多久之内不再留（按毫秒算的天） */
export const VOICE_TTL_DAYS = 30
/** 她"回声"判定的窗口与阈值：评论之后三天内说的，相似度 ≥ 0.7 才算她认下了 */
export const ECHO_WINDOW_MS = 3 * DAY_MS
export const ECHO_MIN_SIM = 0.7
/** 身份文档里「你读到的一句话」只认 7 天内的，太久了就不该再摆在眼前 */
export const VOICE_FRESH_DAYS = 7

/**
 * 归一化：只留字。
 *
 * 为什么要去 URL / @ / 标点 / 空白：同一条评论常被复制粘贴，两边只差几个符号和空格，
 * 不归一化就会当成两句不同的话各自占一次名额。截 120 是为了做 key 时不被长尾稀释。
 */
export function normVoice(text) {
  return String(text ?? '')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/@[^\s]+/g, ' ')
    .replace(/[，。！？、；：「」『』（）()[\]{}<>《》~!?,.;:"'`~^*_+=|\\/#%&$@\-]/g, '')
    .replace(/[\s\u3000]+/g, '')
    .slice(0, 120)
}

/** 去重用的指纹（就是归一化后的串；不另做 hash，出问题时肉眼能对） */
export function voiceKey(text) {
  return normVoice(text)
}

/**
 * 从一轮浏览的素材包里把所有评论摊平。
 *
 * packs 的形状来自 browse.absorb：{ video: { bvid, … }, comments: [{ text, like }] }。
 * 少于 6 个字的不收——「笑死」「前排」这类进来只会占名额。
 */
export function commentsFrom(packs = []) {
  const out = []
  for (const p of packs) {
    const bvid = p?.video?.bvid ?? null
    for (const c of p?.comments ?? []) {
      const text = String(c?.text ?? '').trim()
      const key = normVoice(text)
      if (key.length < 6 || text.length > VOICE_MAX) continue
      out.push({ text: text.replace(/\s+/g, ' ').slice(0, VOICE_MAX), like: Number(c?.like ?? 0) || 0, bvid })
    }
  }
  return out
}

/**
 * 选一条。三级优先，任一级选中就返回：
 *   1. repeated —— 同一条归一化结果在 ≥2 个视频下出现（人群里的共识，最值得让她读到）
 *   2. liked    —— 赞数 ≥ minLike 且长度 6–60 的短句
 *   3. random   —— rng() < chance 时从池子里随机抽（用户要的"占比少"，靠这里控制）
 *
 * `seen` 是最近 30 天出现过的指纹集合；`rng` 可注入，测试里别依赖真随机。
 */
export function chooseVoice(comments = [], { seen = new Set(), rng = Math.random, minLike = VOICE_MIN_LIKE, chance = VOICE_RANDOM } = {}) {
  const pool = comments.filter((c) => c?.text && !seen.has(voiceKey(c.text)))
  if (!pool.length) return null

  // 1) 跨视频重复
  const groups = new Map()
  for (const c of pool) {
    const k = voiceKey(c.text)
    const g = groups.get(k) ?? { key: k, items: [], bvids: new Set() }
    g.items.push(c)
    if (c.bvid) g.bvids.add(c.bvid)
    groups.set(k, g)
  }
  const repeated = [...groups.values()]
    .filter((g) => g.bvids.size >= 2 && g.key.length >= 6)
    .sort((a, b) => {
      if (a.bvids.size !== b.bvids.size) return b.bvids.size - a.bvids.size
      return Math.max(...b.items.map((i) => i.like)) - Math.max(...a.items.map((i) => i.like))
    })
  if (repeated.length) {
    const g = repeated[0]
    const best = [...g.items].sort((a, b) => b.like - a.like)[0]
    return { ...best, why: 'repeated', across: g.bvids.size }
  }

  // 2) 高赞短句
  const liked = pool
    .filter((c) => c.like >= minLike)
    .filter((c) => {
      const n = voiceKey(c.text).length
      return n >= 6 && n <= 60
    })
    .sort((a, b) => b.like - a.like)
  if (liked.length) return { ...liked[0], why: 'liked', across: 1 }

  // 3) 随机
  if (rng() < chance) {
    const idx = Math.min(pool.length - 1, Math.floor(rng() * pool.length))
    return { ...pool[idx], why: 'random', across: 1 }
  }
  return null
}

/** 最近 ttlDays 天内留过的句子的指纹（去重用） */
export function recentVoiceKeys(events = [], { now = Date.now(), ttlDays = VOICE_TTL_DAYS } = {}) {
  const out = new Set()
  for (const e of events) {
    if (e?.type !== 'voice') continue
    const t = Date.parse(e.ts ?? '')
    if (Number.isFinite(t) && now - t > ttlDays * DAY_MS) continue
    out.add(voiceKey(e.text))
  }
  return out
}

/**
 * 一轮浏览结束后调用：选一条、落盘。永不抛出（记账失败不该毁掉这次浏览）。
 * @returns {object|null} 落盘的那条（带 why/across），没选到就是 null
 */
export async function recordVoice({ packs = [], events = [], model = {}, root, cfg = {}, rng = Math.random, sessionId = '' } = {}) {
  try {
    if (cfg?.browse?.voices === false) return null
    if (process.env.FISH_NO_VOICES === '1') return null
    const comments = commentsFrom(packs)
    if (!comments.length) return null
    const seen = recentVoiceKeys(events)
    const v = chooseVoice(comments, { seen, rng })
    if (!v) return null
    await appendEvent(
      {
        type: 'voice',
        text: v.text.slice(0, VOICE_MAX),
        refs: v.bvid ? [v.bvid] : [],
        // 谁让她看的（issue #16 第二半）：没有会话就不落这个字段。
        ...(String(sessionId ?? '').trim() ? { sessionId: String(sessionId).trim() } : {}),
      },
      { day: Number(model?.day ?? 0), stage: Number(model?.stage ?? 1), source: 'system' },
      root,
    )
    return v
  } catch {
    return null
  }
}

/**
 * 她有没有认下这条评论（回声）。
 *
 * 只在评论之后 ECHO_WINDOW_MS 内找她说的话，比她说过什么更重要——
 * 隔了两个月忽然说了句相似的话，那是她自己想起来的，不是被这条评论带的。
 */
export function findEcho(voice, events = []) {
  const t0 = Date.parse(voice.at ?? '')
  if (!Number.isFinite(t0)) return null
  const mine = normVoice(voice.text)
  // 只在**这条评论之后**的事件里找。按事件流里的先后判，不按毫秒：
  // 同一天里"先读到、后开口"时两条的 ts 可能只差几秒，甚至测试里是同一毫秒。
  const idx = events.findIndex((e) => e.id && e.id === voice.id)
  const after = idx >= 0 ? events.slice(idx + 1) : events
  for (const e of after) {
    if (e.type !== 'utterance' && e.type !== 'revise') continue
    // 没认领的聊天行不是信念：算认下，评论就从她眼前消失了，信念却没长
    if (Array.isArray(e.flags) && e.flags.includes('uncommitted')) continue
    const t = Date.parse(e.ts ?? '')
    if (!Number.isFinite(t) || t - t0 > ECHO_WINDOW_MS) continue
    if (similarity(mine, normVoice(e.text)) >= ECHO_MIN_SIM) return e
  }
  return null
}
