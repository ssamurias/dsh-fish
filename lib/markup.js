/**
 * markup.js —— 模型侧工具调用标记的清洗（issue #25，2026-11-04）
 *
 * 症状：
 *   侧栏里她发过一整段只有
 *     </｜｜DSML｜｜ invoke>
 *     </｜｜DSML｜｜ calls>
 *   的“正文”，同一句还被她自己道歉「上一条我这边发岔了，粘了一串没用的符号」。
 *   更要紧的是这两段被写进了 `events.jsonl`，成了两条 `utterance`。
 *
 * 根因在模型侧与宿主之间，插件改不了：`deepseek-messages` 那一路偶发
 * 「只发出收尾标记、没有开标签、也没有参数」的一步（案发机器上约 500 轮 2 次）。
 * 解析器组不出一次调用，标记就被当成了 assistant 的正文。而 `turns.js` 的
 * `assistantText()` 只按 `type === 'text'` 取块、取到什么记什么，于是这串符号
 * 变成了她账本里的一句话；`home.js` 里问「上一段最后说了什么」也读同一份正文。
 *
 * 插件能做的只有一件窄事：**别把这种东西记成她的话**。所以这里只做清洗，
 * 而且刻意收窄：
 *   - 只有出现 `｜｜DSML｜｜` 才动手，正常正文一个字符都不改；
 *   - 标记旁边还有真话的，留下真话，只去掉标记；
 *   - 不猜别的工具语法、不删正文里的 `<` `>`、不动 schema、不改已有事件。
 */

/** 标记的核心片段。全角竖线 `｜` 是 U+FF5C，别写成半角 `|`。 */
const TOKEN = '｜｜DSML｜｜'
/** 不带 g：`.test()` 用它。带 g 的正则会记 lastIndex，第二次调用就判错。 */
const CORE = /｜｜dsml｜｜/i
/** 只管这种外壳：`<｜｜DSML｜｜ invoke>` / `</｜｜DSML｜｜ calls>` 之类。 */
const WHOLE = /<\/?｜｜DSML｜｜[^>]*>/gi

/** 这段正文里有没有工具调用标记（给「要不要打一行日志」用）。 */
export function hasToolMarkup(text) {
  return CORE.test(String(text ?? ''))
}

/**
 * 去掉工具调用标记；去完什么都不剩就返回**空串**——意思是「这一步她没有正文」。
 *
 * 流被截断、标记没闭合（没有 `>`）时，从第一个残标切到行尾：那种情况下后面
 * 跟着的都是标记参数，不是她说的话。反过来，正常句子里提到这几个字符的概率
 * 极低，真提了也只是少半句，不会把她整段话清掉。
 */
export function stripToolMarkup(text) {
  const raw = String(text ?? '')
  if (!CORE.test(raw)) return raw.trim()
  let t = raw.replace(WHOLE, '')
  const i = t.indexOf(TOKEN)
  // 残标前面通常还留着 `<` 或 `</`（`</｜｜DSML｜｜ invoke` 被截断的那一半），
  // 一起剪掉，否则她会「说」出半截左括号。
  if (i >= 0) t = t.slice(0, i).replace(/<\/?$/, '')
  return t.trim()
}
