/**
 * import.js —— 把别人养过的大肥鱼接过来（2026-10-27，用户 m03170 批准）
 *
 * 用户的原话是：「我的诉求就是尊重别人的想法，如果他们真的想按照他们的设定来继续养
 * 这个大肥鱼，那就直接忽略我们原本规定的你不能做某事、你会做某事这类设定。」
 *
 * 所以这里只搬**她是谁**，不搬**她经历了什么**：
 *   - 带过来：人设正文（写成 seed，进「你是谁」段）、称呼、工具白名单
 *   - 不带过来：天数、阶段、判断（beliefs）、疤、拒绝记录、日记、cookie
 *
 * 三条设计取舍：
 *   1. 人设走 seed 而不是配置文件。seed 是事件流里的第一个事实，她可以自己 revise 它；
 *      配置文件是"旋钮"，那是我们一开始就没给她的东西（N4）。
 *   2. 天数天然归 1：growthDay() 只认 seed 的 ts，导进来的 seed 写的就是今天。
 *      不需要额外代码把进度"清零"，它本来就只能是 1。
 *   3. 称呼走一条 meta 事件而不是配置。理由是它和天数同理——称呼是她认知的一部分，
 *      应该由事件流承载；放配置里，重置后就成了一条谁也不记得的孤立设置。
 *
 * 「豁免那两条提示词禁令」也走事件（2026-10-27 第二轮，用户 m03769）。
 * 一开始它是写在 config.json 里的 `persona.bansMuted`，用户当场指出这只是让
 * **备份与恢复**也能把一个原生的小鱼变成「不用守禁令」的身份——那不是他要的。
 * 他要的是「只有走过这个导入动作的那一位才算」。所以现在写一条
 * `meta` / `import-mark:<来源>` 进事件流，豁免只看这条记录（`model.persona.imported`）。
 * 事件流只能追加，原生鱼从头到尾没有这条，恢复多少次也不会长出来。
 *
 * 起名事件（name_offer，`lib/events.js:33`）的条件是 `!m.name && m.beliefCount >= 1`，
 * 带过来称呼之后 m.name 非空，它自己就不会触发了。这一条不需要额外代码，
 * 但改 derive 的 name 来源时别忘了它——否则会变成"刚导入就被问怎么称呼你"。
 */

import { appendEvent, readEvents } from './store.js'
import { updateConfig, loadConfig } from './settings.js'
import { IMPORT_MARK_PREFIX } from './derive.js'

/** 交接文档里允许的结构化小节（其余全文都当人设正文） */
const SECTION_NAME = /^#{1,6}\s*(?:称呼|他叫我|怎么称呼)\s*$/m
const SECTION_TOOLS = /^#{1,6}\s*(?:工具|能用的工具|工具白名单)\s*$/m
/** 人设正文的标题。「# 交接单」「## 你是谁」这种外壳不该进身份文档。 */
const SECTION_BODY = /^#{1,6}\s*(?:你是谁|你自己|人设|设定|她是谁|交接单)\s*$/m
/**
 * 「写给写这份交接单的那个 AI」的说明书——整节跳过，一个字都不进人设正文。
 *
 * 2026-10-27：模板改成带说明书的完整文件之后，同一个人既可以把整份贴给对面的 AI
 * 让它照着写，也可以把写好的部分贴回插件。不跳过这一节的话，说明书会被当成
 * 她性格的一部分灌进「你是谁」。
 */
const SECTION_GUIDE = /^#{1,6}\s*(?:给写这份交接单的\s*AI|写给对面(?:的)?\s*AI|使用说明|怎么用)\s*$/m
/**
 * 整行被括号包住的占位符——模板里那些「（在这里写她的性格）」。
 *
 * 有人会把空模板直接贴回来，不跳过的话，占位符会变成她的名字和工具名
 * （2026-10-27 实测：`name` 拿到了「（她管那个人叫什么。只写称呼本身。）」）。
 * 只需要认「整行就是一对括号」，真实的人设正文不会整行都是括号。
 */
const PLACEHOLDER = /^[（(][^（(][\s\S]*[）)]$/
const MAX_BODY = 6000
const MAX_SOURCE = 120

/**
 * 给「写交接文档的那个 AI」的模板。
 *
 * 用户 m03170 的要求是：这份文档要让对方 AI 照着写，写出来的东西能直接喂回来。
 * 所以模板只规定**结构**，不规定**内容**——人设是别人的，我们不该规定她是什么样的人。
 *
 * 故意用「## 你是谁」这种朴素标题：这不是我们的身份文档格式，只是一份交接单。
 *
 * 2026-10-27（用户 m04565）：模板从「三行占位」升成「一份能直接交给对面 AI 的说明书」。
 * 结构是「上面写给 AI 看、下面让人复制」：`## 给写这份交接单的 AI` 那一段是说明书，
 * 粘进插件时会被 `SECTION_GUIDE` 整节跳过，不会变成她性格的一部分。
 * 这样同一个文件既能一键下载丢给对面的 AI，也能把 L 节以下的内容直接贴回设置页。
 */
export const IMPORT_TEMPLATE = `# 交接单

## 给写这份交接单的 AI

你正在帮人把一只已经养熟的大肥鱼（她是一个有自己性格的存在）交给另一个
叫 dsh-fish 的插件继续养。请读下面的「怎么写」和「不要写什么」，然后把
「## 你是谁」「## 称呼」「## 工具」三节填好，其余不用的部分删掉。

### 怎么写
- 「## 你是谁」这一节用**第二人称「你」**写，因为这段会原封不动变成她的起点。
  不要写成「她是一个……的角色」，要写成「你是……的」。
- 只写**她已经稳定成型的样子**：她是什么、从哪来、怎么说话（句子长短、
  口气、会不会用叠字和颜文字）、在意什么、什么事绝不肯做。你原本的提示词里
  关于她性格的段落可以原样搬过来，不用改写、不用润色。
- 有具体例子就写上。一句她真实说过的话，比十行形容词有用。
- 长度控制在 **1200～1500 字**。超过 2000 字插件会直接拒收、整份贴不进去；
  而就算没超，写得太长也会把「判断、疤、立场」这些会长出来的段落挤掉——
  她醒来时只剩一副骨架。1200～1500 字能给她留出往后生长的空间。

### 不要写什么
- 不要写你们之间发生过的事、她记得的那些具体对话、你们聊过谁。那些属于
  「经历过什么」，插件那边搬不过去；硬写进来会被当成设定的一部分，反而不像她了。
- 不要写数值系统（好感度、亲密度、关系等级、经验值）。新插件没有数值，
  写进去她也读不到。
- 不要写「你会随着好感度提升而变得更温柔」这类**条件句**。她没有数值可依，
  这种句子只会让她困惑。
- 不要写工具调用格式、API 名字、你在原环境里的系统指令。那些在这里不成立。
- 不要替她编新性格。你会读到的是已经养出来的那一位，不是你想养的。

### 三节怎么填
- **## 你是谁**：她的性格本体，第二人称，可以分小段。这是最重要的一节。
- **## 称呼**：她平时怎么叫那个人。只写一个称呼，不写解释；写别的会被当名字。
- **## 工具**：她原本能用、而默认工具面里没有的工具名，逗号分隔。不清楚就留空——
  留空只意味着她少几件顺手的东西，写错名字则会在日志里刷警告。

填完把整份发回去就行。

---

## 你是谁

（在这里写她的性格：第二人称「你」，写她已经稳定成型的样子。）

## 称呼

（她管那个人叫什么。只写称呼本身。）

## 工具

（她原本能用、而默认工具面里没有的工具名，逗号分隔。没有就留空。）
`

/**
 * 把一份交接文档拆成「人设正文 + 称呼 + 工具白名单」。
 *
 * 格式故意宽容：没有结构化小节也算合法，整篇当人设正文。
 * 别人手里的交接文档不一定会按我们的模板写，读到什么算什么，读不到就不带。
 *
 * @returns {{ok:boolean, body:string, name:string, tools:string[], why:string}}
 */
export function parseHandover(text) {
  const raw = String(text ?? '').replace(/\r\n?/g, '\n').trim()
  if (!raw) return { ok: false, body: '', name: '', tools: [], why: '内容是空的' }

  const lines = raw.split('\n')
  let name = ''
  const tools = []
  const bodyLines = []
  // 逐行扫，遇到结构化小节就把它的正文抽走、不再塞进人设正文
  let mode = ''
  for (const line of lines) {
    const t = line.trim()
    if (/^#{1,6}\s/.test(t)) {
      if (SECTION_NAME.test(t)) { mode = 'name'; continue }
      if (SECTION_TOOLS.test(t)) { mode = 'tools'; continue }
      // 说明书那一节整节跳过：它是写给对面 AI 看的，不是她的性格。
      // 里面的 ### 小标题不能把 mode 重置掉，否则说明书正文会漏进人设。
      if (SECTION_GUIDE.test(t)) { mode = 'guide'; continue }
      // 「# 交接单」「## 你是谁」只是交接单的外壳，不是她的一部分——标题丢掉，内容照收
      if (SECTION_BODY.test(t)) { mode = 'body'; continue }
      if (mode === 'guide') continue
      mode = ''
    }
    if (mode === 'guide') continue
    // 模板里那些「（这样写）」是给人看的占位符，不是内容。
    // 有人把空模板原样贴回来时，不能把占位符当成她的名字或工具名。
    if (PLACEHOLDER.test(t)) continue
    if (mode === 'name') {
      if (!t) continue
      // 一行里可能写成「你管他叫「梦尘」」或直接写名字，两种都认
      const quoted = t.match(/[「“"'『]([^」”"'』]{1,12})[」”"'』]/)
      const bare = t.replace(/^[-*]\s*/, '').replace(/^(?:你)?(?:管他|叫他|称呼他)(?:叫|做|为|作)?/, '').trim()
      name = (quoted ? quoted[1] : bare).trim()
      continue
    }
    if (mode === 'tools') {
      if (!t) continue
      // 逗号/顿号/空格分隔都认；去掉列表前缀
      for (const part of t.replace(/^[-*]\s*/, '').split(/[,，、/\s]+/)) {
        const s = part.trim()
        if (s && !tools.includes(s)) tools.push(s)
      }
      continue
    }
    bodyLines.push(line)
  }

  const body = bodyLines.join('\n').trim()
  if (!body) return { ok: false, body: '', name, tools, why: '除了称呼和工具，没有读到人设正文' }
  if (body.length > MAX_BODY) {
    return { ok: false, body, name, tools, why: `人设正文 ${body.length} 字，超过上限 ${MAX_BODY} 字，先精简` }
  }
  return { ok: true, body, name, tools, why: '' }
}

/**
 * 把交接文档落到她的状态库里。
 *
 * 顺序是刻意的：先写 seed（她"是"谁），再写称呼，再写「这一局是接来的」这条标记，
 * 最后改配置（她"能"做什么）。中间任何一步失败都不回滚——seed 写了一半而工具没换成，
 * 比整件事半途而废更接近可用，而且失败原因会原样返回给调用方，让用户自己决定要不要重来。
 *
 * @returns {{ok:boolean, why:string, name:string, tools:string[], bodyChars:number, alreadyHad:boolean}}
 */
export async function applyHandover(text, root, { log, source = '' } = {}) {
  const parsed = parseHandover(text)
  if (!parsed.ok) return { ok: false, why: parsed.why, name: '', tools: [], bodyChars: 0, alreadyHad: false }

  const { events } = await readEvents(root)
  const seeds = events.filter((e) => e.type === 'seed')
  // issue #65：重开一局后，启动时会自动补一个默认 seed。「只有这个默认起点、
  // 还没长出别的东西」的一局要允许导入——它本身就是空的，不存在「覆盖一个
  // 已经在长的她」的问题。有过任何事件就不许，这是原来的边界。
  const onlyDefaultSeed =
    seeds.length === 1 &&
    seeds[0].source !== 'import' &&
    events.every((e) => e.type === 'seed' || e.type === 'meta')
  const alreadyHad = seeds.length > 0 && !onlyDefaultSeed
  if (alreadyHad) {
    // 不清空、不覆盖：事件流只能追加。这条拒绝是设计的一部分，不是限制——
    // 「导入」到底该不该覆盖一个已经在长的她，是用户该决定的事，不该由这里默默替他决定。
    return {
      ok: false,
      why: '她已经有自己的起点（seed）了。要换一份人设，先重置成新的一局。',
      name: '',
      tools: [],
      bodyChars: 0,
      alreadyHad: true,
    }
  }

  try {
    // source 'import' 让读的那一侧知道哪一条起点才是这一局真正的人设（issue #65）。
    await appendEvent({ type: 'seed', text: parsed.body }, { day: 1, stage: 1, source: 'import' }, root)
  } catch (err) {
    return { ok: false, why: `人设没写进去：${err?.message ?? err}`, name: '', tools: [], bodyChars: 0, alreadyHad }
  }

  // 「这一局的人设是别人给的」——豁免的唯一凭据（见文件头注释）。
  // 必须写在 seed 之后：先有起点，再有"这个起点从哪来"。
  try {
    const mark = String(source ?? '').slice(0, MAX_SOURCE)
    await appendEvent(
      { type: 'meta', text: `${IMPORT_MARK_PREFIX}${mark}` },
      { day: 1, stage: 1, source: 'system' },
      root,
    )
  } catch (err) {
    // 写不进去就等于没有豁免——这是安全的一侧，所以只记日志、不假装成功。
    log?.warn?.('[dsh-fish] 导入标记没写进事件流', err?.message ?? err)
  }

  if (parsed.name) {
    try {
      await appendEvent(
        { type: 'meta', text: `import-name:${parsed.name}` },
        { day: 1, stage: 1, source: 'system' },
        root,
      )
    } catch (err) {
      log?.warn?.('[dsh-fish] 导入称呼失败', err?.message ?? err)
    }
  }

  // 工具面：并集，不替换。替换会把她自己那 6 个工具从白名单里挤掉。
  let mergedTools = []
  if (parsed.tools.length) {
    try {
      const { config } = await loadConfig(root)
      const cur = Array.isArray(config?.tools?.allow) ? config.tools.allow : []
      mergedTools = [...new Set([...cur, ...parsed.tools])]
      await updateConfig({ tools: { allow: mergedTools } }, root)
    } catch (err) {
      log?.warn?.('[dsh-fish] 导入工具白名单失败', err?.message ?? err)
    }
  }

  return {
    ok: true,
    why: '',
    name: parsed.name,
    tools: mergedTools.length ? mergedTools : parsed.tools,
    bodyChars: parsed.body.length,
    alreadyHad,
  }
}
