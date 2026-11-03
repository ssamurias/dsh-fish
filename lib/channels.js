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

/** 房间标题：侧栏里要能一眼看出这是哪间（不出现"他"，见 AGENTS.md §4）。 */
export function channelTitle(key, scene = 'group') {
  const label = scene === 'group' ? '群聊' : '私聊'
  const short = key.length > 28 ? `${key.slice(0, 28)}…` : key
  return `跟大肥鱼说话·${label}（${short}）`
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
export async function saveChannel(root, { channel, scene = 'group', sessionId, title = '' }) {
  const key = channelKey(channel)
  if (!key) return { ok: false, why: 'channel 是空的' }
  const sid = String(sessionId ?? '').trim()
  if (!sid) return { ok: false, why: '没有会话 id' }
  return mutate(async () => {
    const list = await readChannels(root)
    const now = new Date().toISOString()
    const entry = {
      key,
      scene: normalizeScene(scene),
      sessionId: sid,
      title: String(title || channelTitle(key, normalizeScene(scene))),
      at: now,
    }
    const rest = list.filter((r) => r.key !== key)
    rest.push(entry)
    const trimmed = rest
      .sort((a, b) => String(a.at).localeCompare(String(b.at)))
      .slice(-CHANNELS_MAX)
    try {
      await writeAtomic(channelsPath(root), JSON.stringify({ version: 1, list: trimmed }, null, 2))
      return { ok: true, entry }
    } catch (err) {
      return { ok: false, why: `记不下这间房：${String(err?.message ?? err).slice(0, 120)}` }
    }
  })
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
export async function resolveChannel(root, { channel = '', scene = '' } = {}) {
  const key = channelKey(channel)
  const want = normalizeScene(scene)
  if (!key) return { house: true, key: '', scene: want, sessionId: '', known: false }
  if (want !== 'group') {
    // private：桥过来的私聊仍进书房，这是"直接接进来"的那个选项。
    return { house: true, key, scene: 'private', sessionId: '', known: false }
  }
  const hit = await findChannel(root, key)
  if (hit?.sessionId && hit.scene === 'group') {
    return { house: false, key, scene: 'group', sessionId: hit.sessionId, known: true }
  }
  return { house: false, key, scene: 'group', sessionId: '', known: false }
}
