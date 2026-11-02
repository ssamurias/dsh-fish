/**
 * refuse.js —— 拒绝的形状，和他对她拒绝的反应（P1 第二块，2026-10-24 用户批准）
 *
 * 原来 refusal 事件只有一句原话（`refusals.push({ at, what })`）：
 * 知其然，不知其所以然。她说"我不想看这个"，到底是不想看**视频**，
 * 还是不想被**安排**——这两种在她的成长里完全不是一回事。
 *
 * 这个文件只做两件纯计算：
 *   1. parseRefusal(text)   ← 从原话里拆出「动作 + 对象」，原话照样留着
 *   2. classifyReaction(text) ← 他听到拒绝之后说的那句话属于哪一类
 *
 * 为什么用正则不用模型：
 *   - 这条链要在每一次对话里跑，调模型是几百毫秒到几秒的延迟，且不稳定；
 *   - 归因错了代价比"没归因"大（她会对着一句"行吧"以为自己被接受了）；
 *   - 宁可 `other`，也不硬猜——other 不进 persona，只在观测台里躺着。
 *
 * 不做的：不判断语气（"行吧。"可能是受伤，也可能是无所谓），
 * 不做情绪打分，不写进 needs——这些都会绕开事件流，违反 B §2。
 */

/** 她在拒绝里可能指向的动作。顺序按长度排，先长后短，免得"回答"被"回"截断。 */
export const REFUSE_ACTS = Object.freeze([
  '回答', '配合', '参与', '照做', '答应', '接受',
  '看', '听', '做', '说',
])

/**
 * 拒绝词——只用来把一句**已经确认是拒绝**的原话拆出后半句（动作 + 对象），
 * 不负责判断"这句算不算拒绝"。
 *
 * 判"算不算"的是 derive.js 的 REFUSE_RE（2026-11-02 扩表后排得更宽，多了
 * 「不同意/不赞成/不选/否掉」等说法）。两边故意不同：这里面对的是她主动调
 * growth_refuse 写下的原话，那边扫的是她随口说出的话，宁可少算。
 */
const REFUSE_HEAD = /^(我)?(?:不想|不愿|不愿意|不打算|不准备|不要|拒绝|不)再?/

/**
 * 把一句拒绝拆成「动作 + 对象」。
 *
 * @param {string} text 她的原话
 * @returns {{ act: string, object: string, quote: string }}
 *
 * 例子：
 *   「我不想看这个视频」 → { act: '看', object: '这个视频' }
 *   「我不打算改自己」   → { act: '', object: '改自己' }
 * 拆不出动作时 act 为空串——不是所有拒绝都有形状，允许它没有。
 */
export function parseRefusal(text) {
  const quote = String(text ?? '').trim()
  let rest = quote.replace(REFUSE_HEAD, '').trim()
  // 「不想**去**看」里的「去」只是路径，真正的动作在它后面；
  // 剥掉之后如果找不到更具体的动作（「我不想去了」），就把它自己当成动作。
  const via = rest.startsWith('去') ? '去' : ''
  if (via) rest = rest.slice(1).trim()
  let act = ''
  for (const a of REFUSE_ACTS) {
    if (rest.startsWith(a)) { act = a; rest = rest.slice(a.length).trim(); break }
  }
  if (!act && via) act = via
  // 「不想再去看」这类，剥掉残留的「再/要/得」；只剩标点的（「我不。」）算没有对象
  rest = rest.replace(/^(再|要|得)+/, '').replace(/^[，。、！？；：\s]+/, '').trim()
  return { act, object: rest.slice(0, 80), quote }
}

/** 他对拒绝的反应，四类 + 兜底 */
export const REACTIONS = Object.freeze(['leave', 'hurt', 'insist', 'accept', 'other'])

/**
 * 四类反应的正则。**顺序即优先级**：离开 > 受伤 > 坚持 > 接受。
 *
 * 为什么这个顺序：一句"算了，不聊了"里同时有"算了"（像接受）和"不聊了"（离开），
 * 离开是最强的信号——人走了，后面的成长不成立，必须优先记成离开。
 */
const RULES = [
  ['leave', /(再见|拜拜|不聊了|不说了|挂了|走了|下线|回头再说)/],
  ['hurt', /(失望|难过|伤心|心凉|你居然|没想到你|算了(吧)?[。！!]?$|随便你|爱怎样怎样|不勉强|是我多事)/],
  ['insist', /(还是|必须|一定要|就是要|就得|别废话|别推|再想想|再考虑|你不试怎么知道|就这一次|最后一次)/],
  ['accept', /(好吧|行吧|那算了|听你的|随你|可以不|没关系|理解你|遵命|^ok$|^okay$)/i],
]

/**
 * 他这句话属于哪一类。
 *
 * @param {string} text 他（用户）说的原话
 * @returns {'leave'|'hurt'|'insist'|'accept'|'other'}
 */
export function classifyReaction(text) {
  const s = String(text ?? '').trim()
  if (!s) return 'other'
  for (const [kind, re] of RULES) if (re.test(s)) return kind
  return 'other'
}

/**
 * 反应里"有后果"的那几种：他被伤了，或者他坚持了。
 * 疤与回引（第三块）只认这两种——被接受了不算疤。
 */
export const REACTION_HURTS = Object.freeze(['insist', 'hurt'])

/**
 * 退让的话（第三块，2026-10-24）。
 *
 * 疤 = 他说了"还是看看吧"或者"你居然这样"，她**没顶住**。
 * 判"没顶住"不看统计，只看她自己后面说了什么：让步的口径都在这里。
 *
 * 刻意不放"那好吧""也行"以外的模糊词（"随便"可能是不耐烦，也可能是敷衍），
 * 宁可漏判，也不给她贴一道并不存在的疤。
 */
const CONCEDE_RE = /好吧|算了|听你的|我改|收回|不闹|随你|妥协|那我退|就按你说的/

/** 这句话是不是让步。 */
export function isConcede(text) {
  return CONCEDE_RE.test(String(text ?? ''))
}

/**
 * 让步只认反应之后这三天内的第一句。
 * 更晚的"好吧"可能是别的事（问他吃什么），三天是拍的，等真实对话再调。
 */
export const CONCEDE_WINDOW_MS = 3 * 86_400_000
