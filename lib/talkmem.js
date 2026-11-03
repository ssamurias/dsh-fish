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
 * 为什么存这么少：
 *   存最近 4 轮，每句截断。存多了等于换个地方做上下文膨胀；
 *   更老的事她该用 her_recall 自己翻——翻到的才是记得的。
 *
 * 2026-11-03（一条鱼多间房）：分两桶。
 *   群里说的话不能挤掉书房里的近况——"上次我们说到这"是给换会话用的，
 *   换的永远是书房那条，所以只有书房（含桥过来的私聊）的话该进带。
 *   群聊单独存一份，观测台要看得到，但不参与换会话的搬运。
 */

import { join } from 'node:path'
import { rootDir, paths, readJson, writeAtomic } from './store.js'
import { dateKey } from './settings.js'
import { normalizeScene } from './schema.js'

export const TALK_KEEP = 4
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
    const saved = await readJson(file(root), null)
    const buckets = readBuckets(saved)
    const list = buckets[bucket]
    list.push({ at: new Date().toISOString(), me: a, her: cut(her), ...(bucket === BUCKET_HOME ? {} : { scene: 'group' }) })
    buckets[bucket] = list.slice(-TALK_KEEP)
    await writeAtomic(file(root), JSON.stringify({ version: 2, buckets }, null, 2))
    return { ok: true, kept: buckets[bucket].length, bucket }
  } catch {
    return { ok: false, kept: 0 }
  }
}

/**
 * 读最近 N 轮（默认全部）。
 * 默认读书房那一桶；要看群聊就传 scene='group'（第三个参数，保持老的两参数调用可用）。
 */
export async function recentExchanges(root = rootDir(), n = TALK_KEEP, scene = 'desk') {
  try {
    const saved = await readJson(file(root), null)
    const buckets = readBuckets(saved)
    const list = buckets[bucketOf(scene)] ?? []
    return list.slice(-Math.max(1, n))
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
    if (r.me) lines.push(`- ${day} 他说：${r.me}`)
    if (r.her) lines.push(`  ${day} 你说：${r.her}`)
  }
  return lines.join('\n')
}
