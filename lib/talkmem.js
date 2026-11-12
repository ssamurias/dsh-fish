/**
 * talkmem.js —— 换会话时带走的那几句话（2026-10-23）
 *
 * 为什么需要：
 *   她的侧栏会话不可能无限长——上下文会撑爆。但换新会话有个残酷的副作用：
 *   上一段对话里「我们说到哪了」全部消失。她会像一个刚失忆的人面对你。
 *
 * 为什么不是「让 AI 总结上一段」：
 *   总结出来的东西是**别人替她讲的**。这份东西要做的只是把**原话**搬过去，
 *   一句都不改。搬运是诚实的，总结是不诚实的。
 *
 * 为什么存得少而不是刚好够：
 *   每句都截断，条数由设置页的「换会话时带几轮原话」决定（默认 4）。
 *   盘上按上限存（CARRY_MAX），这样用户把设置调大时立刻就有货，
 *   不必等下一次轮换才开始攒；带过去的仍然只按设置里那几条。
 *   更老的事她该用 her_recall 自己翻——翻到的才是记得的。
 *
 * 2026-11-11（外部用户反馈）：轮数以前写死 4，聊得稀的人够用，聊得勤的人
 *   换窗口时只接得上最后四句，等于断在半句话上。改为 config.chat.carry。
 *
 * 2026-11-03（一条鱼多间房）：分两桶。
 *   群里说的话不能挤掉书房里的近况——"上次我们说到这"是给换会话用的，
 *   换的永远是书房那条，所以只有书房（含桥过来的私聊）的话该进带。
 *   群聊单独存一份，观测台要看得到，但不参与换会话的搬运。
 */

import { join } from 'node:path'
import { rootDir, paths, readJson, writeAtomic, mutateJson } from './store.js'
import { dateKey, CARRY_MAX } from './settings.js'
import { fillOwner } from './pronoun.js'
import { normalizeScene } from './schema.js'

/** 默认带几轮：老版本写死的 4，现在只是「没设过时的默认值」。 */
export const TALK_KEEP = 4
/** 落盘上限 = 设置页上限。设置调大不用等新对话攒，盘上本来就有。 */
export const TALK_MAX = CARRY_MAX
export const TALK_SNIPPET = 160

/** 桶名：书房（desk/private 合为一桶）与群聊。 */
export const BUCKET_HOME = 'home'
export const BUCKET_GROUP = 'group'

function file(root) {
  return join(paths(root).root, 'talk-recent.json')
}

function cut(s) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > TALK_SNIPPET ? t.slice(0, TALK_SNIPPET - 1) + '…' : t
}

/** 场次 → 桶。desk/private 都算书房：私聊是"直接接进来"，本来就该在带里。 */
export function bucketOf(scene) {
  return normalizeScene(scene) === 'group' ? BUCKET_GROUP : BUCKET_HOME
}

/**
 * 把盘上的旧格式读成两桶。
 * 老档只有 `{list:[...]}`：那时没有群聊，全部并进书房，一句不丢。
 */
function readBuckets(saved) {
  const out = { [BUCKET_HOME]: [], [BUCKET_GROUP]: [] }
  const b = saved?.buckets
  if (b && typeof b === 'object') {
    for (const k of [BUCKET_HOME, BUCKET_GROUP]) {
      if (Array.isArray(b[k])) out[k] = b[k].filter((r) => r && typeof r === 'object')
    }
    return out
  }
  if (Array.isArray(saved?.list)) out[BUCKET_HOME] = saved.list.filter((r) => r && typeof r === 'object')
  return out
}

/**
 * 记一轮。her 为空也记（"他没说话"本身也是那天的样子），但只留 he 那句。
 * scene 不给就按书房算——老调用点（观测台）一字不变。
 */
export async function addExchange(root = rootDir(), { me, her, scene = 'desk' } = {}) {
  const a = cut(me)
  if (!a) return { ok: false, kept: 0 }
  const bucket = bucketOf(scene)
  try {
    // 排队：两条会话同时结账时，以前后写的那一轮把先写的那一轮盖掉。
    return await mutateJson(file(root), async () => {
      const saved = await readJson(file(root), null)
      const buckets = readBuckets(saved)
      const list = buckets[bucket]
      list.push({ at: new Date().toISOString(), me: a, her: cut(her), ...(bucket === BUCKET_HOME ? {} : { scene: 'group' }) })
      buckets[bucket] = list.slice(-TALK_MAX)
      await writeAtomic(file(root), JSON.stringify({ version: 2, buckets }, null, 2))
      return { ok: true, kept: buckets[bucket].length, bucket }
    })
  } catch {
    return { ok: false, kept: 0 }
  }
}

/**
 * 把她后来才说出口的话补进书房桶的最后一轮（宿主 0.2.2-rc.2 的「继续」）。
 *
 * 一轮因为限流、断流失败时，那一轮已经按「her 为空」记下了；他点「继续」，
 * 她这才答上。那不是新的一轮——他没有再说话——所以不新开一条，只把她的话
 * 接在那一轮后面（失败前已经说出口半句的，接在半句后面）。
 *
 * `me` 必须对得上最后一轮他说的那句：中间要是插进了别的一轮（/say、观测台），
 * 就不补，免得把她的话安到别的问题下面。
 */
export async function amendLastExchange(root = rootDir(), { me, her } = {}) {
  const a = cut(me)
  const more = cut(her)
  if (!a || !more) return { ok: false }
  try {
    const saved = await readJson(file(root), null)
    const buckets = readBuckets(saved)
    const list = buckets[BUCKET_HOME]
    const last = list[list.length - 1]
    if (!last || last.me !== a) return { ok: false }
    last.her = cut([last.her, more].filter(Boolean).join(' '))
    await writeAtomic(file(root), JSON.stringify({ version: 2, buckets }, null, 2))
    return { ok: true }
  } catch {
    return { ok: false }
  }
}

/**
 * 读最近 N 轮（默认 4）。
 * 默认读书房那一桶；要看群聊就传 scene='group'（第三个参数，保持老的两参数调用可用）。
 *
 * n <= 0 返回空数组：设置里写 0 表示「换会话时不带」，不能因为
 * slice(-1) 恰好也返回最后一条就变成「带一轮」。
 */
export async function recentExchanges(root = rootDir(), n = TALK_KEEP, scene = 'desk') {
  const want = Math.max(0, Math.trunc(Number(n) || 0))
  if (!want) return []
  try {
    const saved = await readJson(file(root), null)
    const buckets = readBuckets(saved)
    const list = buckets[bucketOf(scene)] ?? []
    return list.slice(-want)
  } catch {
    return []
  }
}

/**
 * 渲染成给下一段会话看的那几句。
 * 只放原话与时间，不加任何"她当时的心情是…"这类解释。
 */
export function renderCarry(list) {
  const rows = (list ?? []).filter((r) => r && (r.me || r.her))
  if (!rows.length) return ''
  const lines = ['## 上次我们说到这', '（会话刚换过，这些是原话。更早的事你自己去翻。）']
  for (const r of rows) {
    // 2026-11-03（issue #19）：`String(r.at).slice(0,10)` 切的是 UTC 日期，
    // 东八区晚上聊的话会被记成前一天。dateKey 走本地钟。
    const at = Date.parse(String(r.at ?? ''))
    const day = dateKey(new Date(Number.isFinite(at) ? at : Date.now()))
    if (r.me) lines.push(`- ${day} {T}说：${r.me}`)
    if (r.her) lines.push(`  ${day} 你说：${r.her}`)
  }
  return fillOwner(lines.join('\n'))
}
