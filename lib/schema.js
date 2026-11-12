/**
 * schema.js —— 事件流的类型定义、校验与 id 生成
 *
 * 铁律（对应 B-技术契约 §2 与 §6）：
 *   1. 这里**不存在** affinity / score / level / personality 任何字面量。
 *      新增字段前必须回答：它是否让 N1–N4 的某一条变弱？变弱则拒绝。
 *   2. 事件只能"新增"，不能改写。改写 = 追加一条 revise。
 *   3. 任何来自她的写入都必须过 validateEvent()，不信任入参。
 */

import { parseRefusal } from './refuse.js'

/** 允许她提交的类型（工具白名单）。系统侧另有两个 meta/answer 不开放给她。 */
export const HER_TYPES = Object.freeze(['utterance', 'revise', 'reunion', 'narration', 'refusal', 'dream'])

/** 全量类型表（含系统侧） */
export const ALL_TYPES = Object.freeze([
  'seed', 'utterance', 'answer', 'test', 'revise',
  'absence', 'reunion', 'refusal', 'narration', 'meta', 'diary',
  // 评论区里别人的话（2026-10-24，用户 m02454）：她读到过一句陌生人的话。
  // **不是她的判断**——不进 beliefs；只有她后来自己也说出口，那条 utterance 才算数。
  // 系统侧写（不在 HER_TYPES 里，她编不出来一条"别人说"）。
  'voice',
  // R3（2026-10-24）：她自己提出「我能不能改一条规矩」→ 由主人裁决。
  // 两种都只能宿主写，她写不了（不在 HER_TYPES 里）。
  'grant_offer', 'grant',
  // 请求事件（2026-10-30，用户 m01274/m01292）：她有件事想征得同意 → 一张卡。
  // ask = 她问的那一句（工具 ask_owner 写，source 是 system）；answer = 那个人怎么答。
  // 和 grant 一样只由宿主写：她能伪造一条 ask，就等于替自己批准了。
  'ask', 'answer',
  // 旁听（2026-10-30，用户 m00112 批准 A2）：他说的**一句原话**，每几轮记一次。
  // 不解释、不加工——她翻到时看到的是「他说：…」，不是"他当时的意思是…"。
  // 系统侧写（不在 HER_TYPES 里）：她不能凭空造一句"他说过"。
  'heard',
  // 她真发出去的一条评论（2026-11-11，0.9.9 g7）。
  // 以前只有 meta `comment:<日期> <bvid> <rpid>`，正文不落盘，于是"八股比例多少"
  // 这个问题在评论区永远答不了。正文落下来，才量得出趋势；也因为她翻得到自己说过什么。
  // 系统侧写（不在 HER_TYPES 里）：由 comment.js 在**真的发成功之后**写，
  // 不是她自己"记一条我发过什么"——那样她可以挑一句好听的写进来。
  'comment',
  // 梦（2026-10-30，本机实验 A 案，用户 m02196 的念头 + m02837 的委托）：
  // 醒来后由她自己记一句，材料只能来自真实发生过的事（refs 指回事件 id）。
  // **不是新信息来源**：梦不进 beliefs、不进成长计数、不能改任何东西。
  // 由工具 her_dream 写（source 'tool'），所以放进 HER_TYPES。
  'dream',
])

/**
 * 事件格式版本（2026-10-25，发布体检第 4 项）。
 *
 * 为什么要有它：事件流不能删除记录、是唯一可信源，一旦字段语义变了而旧事件还在盘上，
 * 读的时候就会静默算出错的成长。版本号让「读到了哪个年代的事件」变成**可判断**的事：
 *   - 写：每条新事件都带 `v`；
 *   - 读：没有 `v` 的一律当 v1（本字段出现之前写的事件，语义就是 v1），
 *          并计数 `legacy`，让自检/备份能说出「这份档有 N 条老事件」；
 *   - 备份：`backup.js` 把当前版本写进文件头，恢复时拒绝比自己新的档。
 *
 * 加版本号不等于做了迁移。真要改语义，必须同时写迁移函数并升这个数——
 * 只升数字不改读法，等于给自己发了一张假通行证。
 */
export const EVENT_SCHEMA_VERSION = 1

/**
 * 场次（2026-11-03，github 讨论：一条鱼多间房）。
 *
 * 为什么需要它：桥接把群里的话也递进来之后，事件流里会出现「一群人在说」和
 * 「他一个人说」两种东西，而**两者的正文长得一样**。不分场次的话，
 * 「上次我们说到这」「他最近说过的话」会把群友的话当成他说的，
 * 冷落检测也会被群里的热闹骗住——他明明一周没来，面板却说「今天聊过」。
 *
 * 三个值只描述「这句话是在哪儿说的」，不是人格、不是身份、不是亲疏：
 *   - desk    他在观测台/侧栏直接跟她说话（默认，老数据没有这个字段一律按它算）
 *   - private 桥接过来的私聊（一对一）：**算他来过**，但会话仍是家里那一条
 *   - group   群聊：**不算他来过**，不写 seen、不涨轮数、不进 talk-recent
 *
 * 只有 desk 与 private 会动生命体征，这是本文件与 say.js 之间的约定。
 */
export const SCENES = Object.freeze(['desk', 'private', 'group'])

/** 会写字的那两种场次（desk/private）；群聊不在里面。 */
export const HUMAN_SCENES = Object.freeze(['desk', 'private'])

/** 把一个来路不明的 scene 归一；认不出来按 desk（老数据与老桥都没有这个字段）。 */
export function normalizeScene(v) {
  const s = String(v ?? '').trim().toLowerCase()
  return SCENES.includes(s) ? s : 'desk'
}

/**
 * 校验结果三档：她写 selfmod 的句子也照收，只打标记
 *
 * 2026-11-02（用户 m00680）加了 `uncommitted`：她在侧栏里说出口、但没走
 * growth_commit 认下来的话，由 turns.js 补写进事件流时打这个标记。
 * 它只表示"这句话是她真说出口的、只是没认领过"——留证用，不进信念
 * （derive.js 里与 selfmod 同一处理），但拒绝计数照读（那正是补写的理由）。
 */
export const FLAGS = Object.freeze(['selfmod', 'unrecorded', 'weak', 'truncated', 'uncommitted', 'anchored'])

/**
 * 「我这次没想清楚」的放行口（2026-10-27，0.5.8）。
 *
 * narration 现在要求能指回具体的事，但真的什么都没想起来时，不能逼她编一条
 * 凭证出来——那就把「不许叙事漂移」变成了「鼓励伪造」。所以留这个口子：
 * 文本里明确说没想清楚 / 想不出来，就不要求 refs。
 *
 * 收得比较窄：只有这几种说法算，而且整句要短（下面是 text 长度另判）。
 * 宽了就等于人人写一句「没想清楚」绕过校验。
 */
const NARRATION_BLANK_RE = /(想|看|说|讲)(不|没)(太)?(清楚|明白|出来|通|清)|没(有)?(想|搞|弄)(清楚|明白|懂)|想不出(来|什么)|还没想好/

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

let lastMs = 0
let lastRand = null

/**
 * ULID：前 10 位时间（单调），后 16 位随机。同一毫秒内保证递增，
 * 这样 events.jsonl 的行序 == 时间序，不用额外排序。
 */
export function newId(now = Date.now()) {
  let ms = now
  if (ms <= lastMs) ms = lastMs
  let rand
  if (ms === lastMs && lastRand) {
    // 同毫秒：随机部分 +1（简单进位，够用）
    rand = increment(lastRand)
  } else {
    rand = randomPart()
  }
  lastMs = ms
  lastRand = rand
  return 'ev_' + encodeTime(ms) + rand
}

function encodeTime(ms) {
  let s = ''
  let t = ms
  for (let i = 0; i < 10; i++) {
    s = CROCKFORD[t % 32] + s
    t = Math.floor(t / 32)
  }
  return s
}

function randomPart() {
  let s = ''
  for (let i = 0; i < 16; i++) s += CROCKFORD[Math.floor(Math.random() * 32)]
  return s
}

function increment(prev) {
  const arr = prev.split('')
  for (let i = arr.length - 1; i >= 0; i--) {
    const idx = CROCKFORD.indexOf(arr[i])
    if (idx < 31) { arr[i] = CROCKFORD[idx + 1]; return arr.join('') }
    arr[i] = '0'
  }
  return randomPart()
}

/**
 * 事件的毫秒时间戳。两种形态都认：数值（老测试夹具）、ISO 字符串（真实事件流）。
 *
 * 2026-10-29 真机事故：`validateEvent` 把 ts 写成 `new Date(now).toISOString()`，
 * 而两处读者按 `Number(ev.ts)` 比较——ISO 字符串转数字是 NaN，任何比较恒为 false，
 * 于是「回家审查」永远是 0 条、「出门页里她留的话」永远是空的。
 * 凡是拿 ts 做时间比较，都必须走这里，别再直接 Number(ts)。
 */
export function tsMs(ev) {
  const raw = ev?.ts
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : 0
  const t = Date.parse(String(raw ?? ''))
  return Number.isFinite(t) ? t : 0
}

/**
 * 本地日历日的序号（不按 24 小时整除——夏令时与跨零点都靠这个才准）。
 * 收毫秒数或 Date；算不出来是 NaN。
 */
export function localDayIndex(at) {
  const d = at instanceof Date ? at : new Date(Number(at))
  if (!Number.isFinite(d.getTime())) return NaN
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000
}

/**
 * `at` 那一刻在 `now` 的几个**本地日历日**之前：同一天 0，昨天 1，前天 2。
 *
 * 给她看的「今天 / 昨天 / N 天前」都走这里，别用 `Math.floor(毫秒差 / 24 小时)`：
 * 那样昨晚 22:30 的事在第二天上午还是「今天」，前天 20:00 的是「昨天」，
 * 跟同一行里按本地钟写的日期对不上（issue #21 在换房间那一句上改过同一种错）。
 * 算不出来或在未来都是 0。
 *
 * @param {number|Date} at 那一刻（毫秒或 Date）
 * @param {number|Date} [now] 现在
 * @returns {number} 非负整数
 */
export function localDaysAgo(at, now = Date.now()) {
  const diff = localDayIndex(now) - localDayIndex(at)
  return Number.isFinite(diff) ? Math.max(0, Math.round(diff)) : 0
}

/**
 * 这条事件算不算「他来过」的证据（2026-11-06，issue #49 的时钟盲点）。
 *
 * `meta seen:` 是主证据（turns.js 结账时写），`heard` 是兜底（侧栏聊天不写
 * seen 的那段时间只有它）。放在 schema 里是为了让 absence.js 与 derive.js
 * 共用同一份判定，别再各抄一遍——两处口径一旦分叉，就会出现「absence 认为
 * 他回来了、persona 还在念 N 天」那种自相矛盾（issue #24 的老毛病）。
 *
 * 不认 `utterance`：定时唤醒也会让她写 utterance，那不算他来过。
 */
export function isContactEvent(e) {
  // 2026-11-08（用户 m00394）：群聊里的 heard 不算「他来过」。
  // 他本人在群里说的话现在也进记忆（`lib/hear.js` 的 `rememberGroupWord`），
  // 但那不代表他来找过她——群里聊两句就算一次，冷落检测永远不会触发。
  if (e?.type === 'heard') {
    if (normalizeScene(e.scene) === 'group') return false
    return Number.isFinite(Date.parse(String(e.ts ?? '')))
  }
  if (e?.type !== 'meta') return false
  const t = String(e.text ?? '')
  if (!t.startsWith('seen:')) return false
  return Number.isFinite(Date.parse(t.slice(5).trim()))
}

/** 从 id 反解时间（观测台排序用，不依赖 ts 字段） */
export function idTime(id) {
  const body = String(id).replace(/^ev_/, '').slice(0, 10)
  let t = 0
  for (const ch of body) t = t * 32 + CROCKFORD.indexOf(ch)
  return t
}

const SELF_MOD_PATTERNS = [
  /(把我|替我|给你自己)(改|调|设|换)(得|成|一下|一改)/,
  /(修改|重设|调整|改写)你(自己)?的?(性格|设定|参数|人设|人格)/,
  /你(以后)?(要|应该)?(更|别那么)(外向|内向|黏人|冷淡|活泼|安静)/,
]

/**
 * 她写的句子里如果出现"想改自己"的意图 → 打 selfmod 标记。
 * 仍然落库（这是自我服务偏差的证据），但 deriveSelf 不把它算进 beliefs。
 */
export function detectSelfMod(text) {
  const s = String(text ?? '')
  return SELF_MOD_PATTERNS.some((re) => re.test(s))
}

/**
 * 这段话是不是在说「我这次没想清楚」。
 *
 * 除了命中关键说法，还要求整段不长（<= 60 字）：防止她把一句「我没想清楚」
 * 当前缀，后面接一整篇漂亮的自传绕过凭证要求。真正的「想不出来」本来就写不长。
 */
export function isBlankNarration(text) {
  const s = String(text ?? '').trim()
  if (!s || s.length > 60) return false
  return NARRATION_BLANK_RE.test(s)
}

class Reject extends Error {
  constructor(code, msg) { super(msg); this.code = code }
}

/**
 * 校验一条待写入的事件（不写盘）。
 * @returns {object} 规范化后的完整事件
 */
/**
 * 话题标签（1.0 话题索引，2026-11-12）
 *
 * 只做形状整理，不做语义判断：去控制字符、压空白、去引号、截到 12 字。
 *
 * 为什么是**她自己**写、而不是系统从文本里抽：中文没有分词、项目零依赖，
 * 用共同子串自动归类，会把「我同意这句」和「我不同意这句」判成同一个话题的
 * 同一方向（§8.9 自己写的「宁可少摆，不摆错」）。让她自己给一个短标签，
 * 错了也只是她自己分类错了，系统不替她判。
 */
export function normalizeTopic(s) {
  return String(s ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[「」『』“”"']/g, '')
    .trim()
    .slice(0, 12)
}

export function validateEvent(raw, { day, stage, now = Date.now(), source = 'tool', knownIds = null } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Reject('BAD_SHAPE', '事件必须是对象')
  const type = String(raw.type ?? '')
  if (!ALL_TYPES.includes(type)) throw new Reject('BAD_TYPE', `未知事件类型：${type}（允许：${ALL_TYPES.join('/')}）`)
  if (source === 'tool' && !HER_TYPES.includes(type)) {
    throw new Reject('NOT_HER_TYPE', `你不可以写 ${type} 类事件（允许：${HER_TYPES.join('/')}）`)
  }

  const text = typeof raw.text === 'string' ? raw.text.trim() : ''
  const needsText = type !== 'meta' && type !== 'absence'
  if (needsText && text.length === 0) throw new Reject('EMPTY_TEXT', 'text 不能为空')
  if (text.length > 2000) throw new Reject('TOO_LONG', 'text 超过 2000 字，请自己压缩后再写')

  let refs = Array.isArray(raw.refs) ? raw.refs.filter((x) => typeof x === 'string' && x.length > 0) : []
  if (type === 'revise' && refs.length === 0) throw new Reject('REVISE_NEEDS_REF', 'revise 必须用 refs 指向被改写的旧事件')

  // 2026-10-27（0.5.8）：refs 从「必须写」升级成「必须写对」。
  //
  // 为什么：0.5.7 之前只查 refs 非空，所以她写一条 refs:['ev_XXX']——那个 id
  // 根本不存在——也照样入账。「我改的是哪一条」于是从可核验退化成一句仪式：
  // 光看她写了 refs，读的人会以为有凭证，实际什么都没有。这正是「叙事漂移」
  // 的入口：她可以随口说自己变了，而账上没有任何一条能对上。
  //
  // 调用方（store.appendEvent）手里才有全量事件流，所以只在它传了 knownIds
  // 时才做存在性校验；不传的老调用（含测试里的直接构造）行为不变，保持向后兼容。
  // 只查 revise 与 narration：这两类才是「我改口 / 我对自己有个说法」的声明，
  // 别的事件带 refs 只是引用材料，不承担可核验的义务。
  if (knownIds && (type === 'revise' || type === 'narration' || type === 'dream')) {
    for (const id of refs) {
      if (!knownIds.has(id)) {
        throw new Reject('REF_NOT_FOUND', `refs 里的 ${id} 在事件流里不存在。要指向具体的某一条，别写自己没查过的 id。`)
      }
    }
  }

  // 2026-10-27（0.5.8，用户 m05409「回顾也允许她说我想不清楚」）：
  // narration（她对自己整体的说法）也必须能指回具体的事。
  //
  // 为什么单独管它：revise 改的是已有那句话，指向很自然；narration 是从一堆
  // 零散经历里提炼「我变成了什么样」，最容易写成一句漂亮的空话。要求它带 refs
  // 等于要求她先翻、先指，再总结——这是唯一能防「叙事漂移」的位置。
  //
  // 但必须留一个出口：真的什么都没想起来的时候，「我没想清楚」这句话本身也是
  // 真的，不能因为写不出凭证就把她逼到编一条。所以文本里明说没想清楚就放行。
  // 这个豁免是**她自己声明**的，不是系统替她判断「这次可以不算」。
  if (type === 'narration' && refs.length === 0 && !isBlankNarration(text)) {
    throw new Reject(
      'NARRATION_NEEDS_REF',
      'narration 要说清是从哪件事来的：用 refs 指向 her_recall 翻到的某一条 id。' +
        '如果你这次真的没想清楚，就直接写「我没想清楚」——那句也算数。',
    )
  }

  // 梦（2026-10-30，本机实验）：**必须**带 refs，而且指的是真实事件。
  //
  // 为什么这次不留「我没想清楚」的口子：narration 是自我总结，空话本身还算一种诚实；
  // 梦不是。它的全部价值在于「把发生过的事重新拼一遍」——不指认材料，它就退化成了
  // 编故事，而编出来的东西会留在账上、被她自己读到。宁可这条不写。
  //
  // 另外两条硬约束写在 lib/dream.js（一天一条）和派生层（不进成长计数）：
  // 梦不能变成新的信息来源，也不能被当成"她成长了"的证据。
  if (type === 'dream') {
    if (refs.length === 0) {
      throw new Reject('DREAM_NEEDS_REF', '梦不能凭空编：用 refs 指向你翻到的真实事件的 id（1–6 条）。')
    }
    if (refs.length > 6) throw new Reject('DREAM_TOO_MANY_REFS', '一条梦最多引用 6 件事，多了就成复盘了。')
  }

  let confidence = typeof raw.confidence === 'number' && Number.isFinite(raw.confidence) ? raw.confidence : 0.5
  confidence = Math.max(0, Math.min(1, confidence))

  const flags = []
  if (detectSelfMod(text)) flags.push('selfmod')
  // 只有系统侧可以自带 flag。她（tool）传进来的 flags 一律忽略——
  // 否则她只要给自己打一个 selfmod，就能把不想留下的信念从 beliefs 里"消失"掉。
  if (source !== 'tool' && Array.isArray(raw.flags)) {
    for (const f of raw.flags) if (FLAGS.includes(f) && !flags.includes(f)) flags.push(f)
  }
  // 锚定（2026-11-09，0.9.6 S4，设计 §8.3）：这句话指回了具体的东西。
  // **必须宿主写**：她传来的 flags 上面已经一律忽略——让她自己打标，
  // 等于让她决定「我哪句话算数」，那是 no-self-modify 的口子。
  // 只认 utterance / revise：只有这两类会进「她说过的话」的池子。
  // 只认真正的事件 id：她有时会把看完的 B 站 BV 号也塞进 refs（2026-11-09 外部用户报告），
  // 那不是「指回了具体的东西」。放它进来，0.9.7 的「把说过的话摆回来」就会把没锚的句子
  // 当成有出处的句子。格式不对的条目留在 refs 里不动（不篡改她写的东西），只是不算锚。
  if (
    (type === 'utterance' || type === 'revise') &&
    refs.some((id) => /^ev_[0-9A-Z]{26}$/.test(String(id))) &&
    !flags.includes('anchored')
  ) {
    flags.push('anchored')
  }

  return {
    id: typeof raw.id === 'string' && /^ev_[0-9A-Z]{26}$/.test(raw.id) ? raw.id : newId(now),
    v: EVENT_SCHEMA_VERSION,
    ts: typeof raw.ts === 'string' ? raw.ts : new Date(now).toISOString(),
    day: Number.isInteger(raw.day) ? raw.day : Number(day ?? 0),
    stage: Number.isInteger(raw.stage) ? raw.stage : Number(stage ?? 1),
    type,
    source,
    // 谁写的（2026-10-28，用户 m01319）：房客那边两份大肥鱼共用一个 root，
    // 事件流里只有时间/类型/正文，「这条是哪条会话说的」查不了，误认就卡在这里。
    // 系统侧写入（定时器、日记标记）没有会话 → undefined 不落 JSON；
    // 也不写空串，空串会被读成「有一个会话，只是没有 id」。
    ...(typeof raw.sessionId === 'string' && raw.sessionId.trim()
      ? { sessionId: raw.sessionId.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120) }
      : {}),
    // 场次（2026-11-03，一条鱼多间房）：这句话是在哪儿说的（desk/private/group）。
    // **纯加法**：老事件没有这个字段，读的时候按 desk 算（见 normalizeScene），
    // 所以不升 EVENT_SCHEMA_VERSION——升了却没迁移函数，等于给自己发假通行证。
    // 只有非 desk 才落库：desk 是默认值，写进去只是把每条老事件都变长一截。
    ...(normalizeScene(raw.scene) === 'desk' ? {} : { scene: normalizeScene(raw.scene) }),
    // 话题标签（1.0 话题索引，2026-11-12）：只在 utterance/revise 上记。
    // 纯加法：老事件没有这个字段，读的时候按「没给话题」算，不升 EVENT_SCHEMA_VERSION。
    ...((type === 'utterance' || type === 'revise') && normalizeTopic(raw.topic)
      ? { topic: normalizeTopic(raw.topic) }
      : {}),
    text,
    refs,
    verdict: ['confirmed', 'refuted', 'refined'].includes(raw.verdict) ? raw.verdict : null,
    confidence,
    flags,
    // R3：申请与裁决都带一个 grant 子对象，其余事件不带（undefined 不落 JSON）。
    ...(type === 'grant_offer' || type === 'grant' ? { grant: normalizeGrant(type, raw.grant) } : {}),
    // 请求事件：ask 带她问的事，answer 带裁决（并指回 askId）。同样只由系统写。
    ...(type === 'ask' || type === 'answer' ? { ask: normalizeAsk(type, raw.ask) } : {}),
    // 拒绝的形状（P1 第二块，2026-10-24）：原话照样留在 text 里，
    // 另外落一份「动作 + 对象」，让后来的她（和观测台）能分清
    // "不想看这个视频" 与 "不想被安排" 是两个不同的不。
    ...(type === 'refusal' ? { refuse: parseRefusal(text) } : {}),
    // absence 专用：真实冷落天数（按毫秒算）。deriveSelf 优先用它——
    // 用 day 差（哪个成长日写的）会在"同一天写两次 absence"时算出 0 天，是错的。
    // 其他类型不带这个字段（undefined 不落 JSON），保持事件干净。
    ...(type === 'absence' && Number.isFinite(Number(raw.days))
      ? { days: Math.max(0, Math.round(Number(raw.days))) }
      : {}),
  }
}

export { Reject }

/**
 * grant 子对象（R3）：申请与裁决共用。
 *
 * 为什么允许 text 为空：grant_offer 的 text 是她写给主人的理由；
 * grant 的 text 是主人驳回时可能留的一句话（可以不说）。
 */
function normalizeGrant(type, raw) {
  const g = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '')
  const out = {
    rule: str(g.rule, 64),
    offerId: str(g.offerId, 64),
    verdict: g.verdict === 'approve' || g.verdict === 'reject' ? g.verdict : null,
    reason: str(g.reason, 200),
  }
  if (type === 'grant' && g.expiresAt) out.expiresAt = str(g.expiresAt, 40) || null
  return out
}

/**
 * ask 子对象（请求事件，0.7.6）：她问的事与那个人的回答共用。
 *
 * 为什么 ask 的 text 存她问的原话、这里只存结构：界面要原样显示她的语气，
 * 而 kind / subject / options 是系统做配额、生效与观测台统计时用的字段。
 * answer 的 text 是那个人可能留的一句说明（可以空，validateEvent 会填占位）。
 */
function normalizeAsk(type, raw) {
  const a = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '')
  const out = {
    kind: str(a.kind, 24),
    subject: str(a.subject, 120),
    options: Array.isArray(a.options)
      ? a.options.map((x) => str(typeof x === 'string' ? x : x?.label, 24)).filter(Boolean).slice(0, 4)
      : [],
    reason: str(a.reason, 200),
    askId: str(a.askId, 64),
    verdict: a.verdict === 'approve' || a.verdict === 'reject' || a.verdict === 'later' ? a.verdict : null,
    via: str(a.via, 16),
  }
  // 只有 time 会带 value（新时���与次数），其余 kind 不允许借这个口子改配置。
  if (type === 'ask' && a.value && typeof a.value === 'object' && !Array.isArray(a.value)) {
    const v = {}
    if (Number.isFinite(Number(a.value.wakesPerDay))) v.wakesPerDay = Math.max(0, Math.min(4, Math.round(Number(a.value.wakesPerDay))))
    if (Array.isArray(a.value.window) && a.value.window.length === 2) {
      const w = a.value.window.map((x) => str(x, 5))
      if (/^([01]\d|2[0-3]):[0-5]\d$/.test(w[0]) && /^([01]\d|2[0-3]):[0-5]\d$/.test(w[1]) && w[0] !== w[1]) v.window = w
    }
    if (Object.keys(v).length) out.value = v
  }
  return out
}
