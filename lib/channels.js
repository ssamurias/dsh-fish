/**
 * channels.js —— 一条鱼，多间房
 *
 * 为什么有这个东西（2026-11-03，github 讨论：接了 QQ 桥之后"同时养了两条鱼"）：
 *
 * 桥接以前的做法是**自己另建一条 DSH 会话**。那条会话是独立的 agent：
 * 宿主给它单独注入一份身份、它的对话历史与家里那条互不可见。
 * 于是同一个人在两扇窗里看到的是"两个人"，而 events.jsonl 只有一条 ——
 * 她自己在两边说的话都写进同一份记忆，谁也不认谁。这叫人格分裂，
 * 不是配置问题，是**会话模型用错了**。
 *
 * 正确的关系是：会话是"房间"，不是"人"。家里那间是书房，群里那间是客厅，
 * 桥接私聊还是书房（真融合，用户要的"直接接进来"就是这一条）。
 * 房间里说的话都进同一条事件流，只是**各自带场次**（见 schema.js 的 SCENES），
 * 生命体征（seen / 轮数 / 冷落）只由书房与私聊决定。
 *
 * 所以本文件只管一件事：**外部渠道（channel）→ 房间（sessionId）的映射**。
 * 桥完全不碰 instance.json，也就不存在"两个插件实例抢一个家"。
 *
 * 三条约束：
 *   1. 没有 channel 的调用（观测台、侧栏、老桥）行为一字不变，仍走家里那条会话。
 *   2. group 场次才另开房；private 一律回书房——"一个家的两个人格"正是要消灭的东西。
 *   3. 认不出来的东西一律按 desk 处理，绝不因为映射文件坏了就丢消息。
 */

import { join } from 'node:path'
import { paths, readJson, writeAtomic } from './store.js'
import { normalizeScene } from './schema.js'

/** 映射文件放在数据目录根上，与 home.json / config.json 并列。 */
const CHANNELS_FILE = 'channels.json'

/** 一个 channel 名最长认这么多字符（防止桥把整段 JSON 塞进来当 key）。 */
const KEY_MAX = 120

/** 最多记住多少间房；超了丢最久没说话的（不让映射文件无限长）。 */
export const CHANNELS_MAX = 40

/** 群房按"建了多久"轮换时用的单位。 */
const DAY_MS = 86_400_000

/** 读-改-写串行化：两条渠道同时投递时别互相覆盖。 */
let channelQueue = Promise.resolve()

function mutate(fn) {
  const next = channelQueue.then(fn, fn)
  channelQueue = next.then(() => undefined, () => undefined)
  return next
}

export function channelsPath(root) {
  return join(paths(root).root, CHANNELS_FILE)
}

/**
 * 把桥给的 channel 归一成一个稳定的 key。
 *
 * 为什么不是直接用原串：桥的实现是别人写的，可能带空格、换行、控制字符，
 * 也可能大得离谱。key 会进文件名之外的每个地方（标题、日志、返回体），
 * 所以这里做一次收敛——**但绝不因为长得丑就丢弃**：丢一条消息比留个丑 key 严重。
 */
export function channelKey(channel) {
  const s = String(channel ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, KEY_MAX)
  return s
}

/**
 * 房间标题：侧栏里要能一眼看出这是哪间（不出现"他"，见 AGENTS.md §4）。
 *
 * name 是桥给的显示名（群名 / 昵称）。有名字就用名字，用户才认得出；
 * 没有才退回 channel 键——别把 `qq-group:123456` 当成房间名摆出来。
 */
export function channelTitle(key, scene = 'group', name = '') {
  const label = scene === 'group' ? '群聊' : '私聊'
  const short = key.length > 28 ? `${key.slice(0, 28)}…` : key
  const who = String(name ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 40)
  return `跟大肥鱼说话·${label}（${who || short}）`
}

/** 读出全部映射（坏文件当空表，不抛）。 */
export async function readChannels(root) {
  let raw = null
  try {
    raw = await readJson(channelsPath(root), null)
  } catch { raw = null }
  const list = Array.isArray(raw?.list) ? raw.list : []
  return list
    .filter((r) => r && typeof r === 'object' && channelKey(r.key))
    .map((r) => ({
      key: channelKey(r.key),
      scene: normalizeScene(r.scene),
      sessionId: typeof r.sessionId === 'string' ? r.sessionId.trim() : '',
      title: typeof r.title === 'string' ? r.title : '',
      at: typeof r.at === 'string' ? r.at : '',
      // bornAt 管轮换（这间房用了多久），lastAt 管收纳（多久没说话）。
      // 老档没有这两个字段：at 是唯一可信的时间，就都拿它兜底。
      bornAt: typeof r.bornAt === 'string' && r.bornAt ? r.bornAt : (typeof r.at === 'string' ? r.at : ''),
      lastAt: typeof r.lastAt === 'string' && r.lastAt ? r.lastAt : (typeof r.at === 'string' ? r.at : ''),
    }))
}

/** 找一间房；找不到返回 null。 */
export async function findChannel(root, channel) {
  const key = channelKey(channel)
  if (!key) return null
  const list = await readChannels(root)
  return list.find((r) => r.key === key) ?? null
}

/**
 * 记住某个 channel 住在哪条会话里。
 *
 * 同一个 key 再写一次就是更新（换过房、改过名都走这里），
 * 所以桥那边不需要知道"要不要登记"——投递一次就够了。
 */
export async function saveChannel(root, { channel, scene = 'group', sessionId, title = '', bornAt = '' }) {
  const key = channelKey(channel)
  if (!key) return { ok: false, why: 'channel 是空的' }
  const sid = String(sessionId ?? '').trim()
  if (!sid) return { ok: false, why: '没有会话 id' }
  return mutate(async () => {
    const list = await readChannels(root)
    const now = new Date().toISOString()
    const prev = list.find((r) => r.key === key)
    const entry = {
      key,
      scene: normalizeScene(scene),
      sessionId: sid,
      title: String(title || channelTitle(key, normalizeScene(scene))),
      at: now,
      // 同一间房再写一次（群消息复用房间）时保留本来建的时间；
      // 只有真建了新会话才重新起算，否则轮换永远等不到。
      bornAt: String(bornAt || prev?.bornAt || now),
      lastAt: now,
    }
    const rest = list.filter((r) => r.key !== key)
    rest.push(entry)
    // 收纳按「最久没说话」丢，不按「建得最早」丢（见 AGENTS §7.2）。
    const trimmed = rest
      .sort((a, b) => String(a.lastAt || a.at).localeCompare(String(b.lastAt || b.at)))
      .slice(-CHANNELS_MAX)
    try {
      await writeAtomic(channelsPath(root), JSON.stringify({ version: 1, list: trimmed }, null, 2))
      return { ok: true, entry }
    } catch (err) {
      return { ok: false, why: `记不下这间房：${String(err?.message ?? err).slice(0, 120)}` }
    }
  })
}

/**
 * 这间房是不是用满了天数（群房按天轮换，不看轮数）。
 *
 * 为什么不用轮数：群和群的热度差几十倍，同一阈值要么小群永远换不了，
 * 要么热闹的群一天换三间。按「建了多久」更稳，也更好解释。
 * days <= 0 表示不轮换（用户关掉）。
 */
export function channelExpired(entry, days, now = Date.now()) {
  const d = Number(days)
  if (!entry || !(d > 0)) return false
  const born = Date.parse(String(entry.bornAt || entry.at || ''))
  if (!Number.isFinite(born)) return false
  return now - born >= d * DAY_MS
}

/** 某间房被用户收起来了（会话归档）：从映射里去掉，下次投递会重新建一间。 */
export async function dropChannel(root, channel) {
  const key = channelKey(channel)
  if (!key) return { ok: false, why: 'channel 是空的' }
  return mutate(async () => {
    const list = await readChannels(root)
    const rest = list.filter((r) => r.key !== key)
    if (rest.length === list.length) return { ok: true, dropped: false }
    try {
      await writeAtomic(channelsPath(root), JSON.stringify({ version: 1, list: rest }, null, 2))
      return { ok: true, dropped: true }
    } catch (err) {
      return { ok: false, why: String(err?.message ?? err).slice(0, 120) }
    }
  })
}

/**
 * 决定「这条消息该进哪间房」——本文件的核心，也是唯一被 say.js 依赖的判断。
 *
 * 返回值里的 `house: true` 表示"回书房，沿用家里那条会话"，
 * 这时 sessionId 为空，调用方按老路径 talkSessionId() 解析。
 *
 * 为什么不在这里建会话：建房要 sessionController、要工作区 id、要处理
 * "同屋还有别的活会话"这些宿主细节，那套逻辑已经在 home.js 里了。
 * 这里只做**纯判断 + 查表**，好测、好读、不碰宿主。
 */
export async function resolveChannel(root, { channel = '', scene = '', room = '' } = {}) {
  const key = channelKey(channel)
  const want = normalizeScene(scene)
  const wantRoom = String(room ?? '').trim().toLowerCase()
  if (!key) return { house: true, key: '', scene: want, sessionId: '', known: false, room: 'house' }
  // room 决定"这间算不算一间房"：
  //   channel → 一定另开（群友私聊每人一间、按人分房都走这条）
  //   house   → 一定回书房（所有群合并成一条也走这条）
  //   不传    → 老行为：群聊开房，私聊回书房
  const toChannel = wantRoom === 'channel' || (wantRoom !== 'house' && want === 'group')
  if (!toChannel) {
    // 合并回书房时仍保留原场次：群消息不该因为"没单独开房"就算他来过。
    return { house: true, key, scene: want === 'group' ? 'group' : 'private', sessionId: '', known: false, room: 'house' }
  }
  const hit = await findChannel(root, key)
  if (hit?.sessionId) {
    return { house: false, key, scene: want, sessionId: hit.sessionId, known: true, room: 'channel', entry: hit }
  }
  return { house: false, key, scene: want, sessionId: '', known: false, room: 'channel' }
}
