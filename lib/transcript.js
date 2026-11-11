/**
 * transcript.js —— 把「她自己续写的对话记录」从正文里切掉（2026-11-11，W49）
 *
 * 症状（外部用户真机，dsh-fish 0.9.7-fix.1，两天内从 0% 爬到 19%）：
 *   她的回复末尾会往下接着写对话记录，形态是
 *     <她真说的话>
 *     user <凭空编的、对方「下一句」会说的话>
 *     assistant <她接着编的、自己「下一句」会说的话>
 *   后半段是纯虚构：对方没说过 those 话，有时连地名都是现编的
 *   （例：整条会话里只有她自己写出过「浙西川藏线」，下一轮她当既成事实用）。
 *
 * 为什么必须切（而不是「让她注意点」）：
 *   同一段正文有四个出口——`talk-recent.json` 的「上次我们说到这」、
 *   `events.jsonl` 的 `utterance`、`utterance` 进了 `wontCount`/`consistency`
 *   这些尺子、以及 `home.js` 问「上一个房间最后说了什么」。存下来又送回提示词，
 *   就是自增强：她每轮都看见自己以前这么写，于是越写越顺。这在源头才断得掉。
 *
 * 判据只认**行首标记**，不猜句式：
 *   - 行首（允许前置的空格、引用符 `>`、列表符、`#`、`-`）出现
 *     `user` / `assistant` / `human` / `用户` / `助手`；
 *   - 英文那几个后面必须跟冒号、行尾、或者「空格 + 非英文字母」——
 *     所以正常句子里的 `user experience`、`AI agent` 不会被当成标记；
 *   - 中文那两个只要在行首独立成词就算（真机用例是 `用户 嗯嗯`）。
 *
 * 两条纪律：
 *   - **只切不改写**：从标记那一行起整段丢掉，前面一个字符都不动。
 *     红线是「不许替她改写」，切尾巴是**少记一句**，改写是**替她说**。
 *   - 宁可少留一句真话，也不留下半句假话。假话会进账本、进提示词、
 *     下一轮被她自己引用；真话少一句，下一轮还在会话里。
 */

/** 行首允许的前缀：空格、引用、列表符、标题井号。 */
const LEAD = '(?:^|\\n)[ \\t>*+\\-#]*'

/** 中文标记：行首独立成词即可（真机形态是「用户 嗯嗯」，没有冒号）。 */
const CN = new RegExp(`${LEAD}(?:用户|助手)[ \\t]*(?=[:：\\s]|$)`, 'i')

/**
 * 英文标记：`user` / `assistant` / `human`。
 * `(?![a-z])` 挡住 `userland`、`assistants` 这类词；
 * 后面要么冒号、要么「空格 + 非英文字母」（`user 是的`）、要么行尾（`assistant` 独行）。
 */
const EN = new RegExp(
  `${LEAD}(?:user|assistant|human)(?![a-z])(?:[ \\t]*[:：]|[ \\t]+(?![A-Za-z])|[ \\t]*(?=\\n|$))`,
  'i',
)

/** 这段正文里有没有「行首对话记录标记」。给「要不要打一行日志」用。 */
export function hasTranscriptTail(text) {
  const raw = String(text ?? '')
  if (!raw) return false
  return CN.test(raw) || EN.test(raw)
}

/**
 * 从第一条行首标记切到结尾；没有标记就原样返回（**连空白都不动**）。
 *
 * 返回空串的意思是「这一步她没有正文」——只有整段都是标记时才会这样。
 *
 * @param {string} text
 * @returns {string}
 */
export function stripTranscriptTail(text) {
  const raw = String(text ?? '')
  if (!raw) return ''
  const at = firstMarkAt(raw)
  if (at < 0) return raw
  // 标记前面那半句是真话，留着；标记那行起全都不要。
  return raw.slice(0, at).replace(/[ \t]+$/, '').trimEnd()
}

/**
 * 第一条标记所在的**行首**下标；没有就是 -1。
 *
 * 流式清洗要拿这个下标当场截断，所以导出。
 *
 * @param {string} raw
 * @returns {number}
 */
export function transcriptStart(raw) {
  return firstMarkAt(String(raw ?? ''))
}

/** 第一条标记所在的**行首**下标；没有就是 -1。 */
function firstMarkAt(raw) {
  let best = -1
  for (const re of [CN, EN]) {
    const m = re.exec(raw)
    if (!m) continue
    // `(?:^|\n)` 吃掉了那个换行，切点得从换行之后开始，否则会多删一个空行。
    const at = m[0].startsWith('\n') ? m.index + 1 : m.index
    if (best < 0 || at < best) best = at
  }
  return best
}

/** 判据里的标记词。流式清洗要在 chunk 边界上认「半个词」，得知道有哪些。 */
export const MARK_WORDS = ['user', 'assistant', 'human', '用户', '助手']

/** 行首允许的前缀（与 LEAD 保持一致）。 */
const LEAD_ONLY = /^[ \t>*+?#-]*/

/**
 * 这一段**还没写完的行首**该压住多少字，等下一块拼上再判。
 *
 * 只在两种情形下压：这段尾巴本身是某个标记词的开头（`us` / `用户` 刚写了一半），
 * 或者恰好写完一个完整的标记词（后面可能跟 `s` 变成 `users`，也可能跟空格变成标记）。
 * 压住的量有上限，认不出来就一个字都不压、当场放行。
 *
 * @param {string} buf 从行首开始的这段尾巴
 * @returns {number} 要压住的尾部字符数（0 = 不用压）
 */
export function partialMarkTail(buf) {
  const raw = String(buf ?? '')
  if (!raw || raw.includes('\n')) return raw ? 0 : 0
  const lead = LEAD_ONLY.exec(raw)[0]
  const rest = raw.slice(lead.length)
  if (!rest) return 0
  const low = rest.toLowerCase()
  if (low.length > 12) return 0
  for (const w of MARK_WORDS) {
    if (w.startsWith(low)) return rest.length
  }
  return 0
}
