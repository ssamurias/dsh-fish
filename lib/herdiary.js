/**
 * herdiary.js —— 让她能回头翻自己的日记：her_diary 工具（issue #7 第二半，2026-10-28）
 *
 * 问题（github:ssamurias/dsh-fish#7）：
 *   日记写进 `diary/YYYY-MM-DD.md`、**不进事件流**（否则 diary.visible 这个
 *   隐私开关立刻失效，记忆也会被稀释成第二条流）。这是对的。但代价是：
 *     - her_recall 跳过 meta，翻不到日记；
 *     - 她的工具面里没有任何"读文件"的入口。
 *   于是日记写完之后她自己永远够不着，只有主人能看。而身份里对她写的是
 *   「写完自己留着」——那句话默认了她还能再打开。
 *
 * 这里只开一扇很窄的窗，**不是**给她一个读文件工具：
 *   - 只读，永远写不了；
 *   - 只能读 `diary/` 里按日期命名的那些，参数是日期不是路径（连 `../` 都传不进来）；
 *   - 一次一份（默认最近一篇），正文截断；
 *   - **不参与**身份文档拼装，也**不进** her_recall ⇒ `diary.visible` 的语义不变：
 *     那个开关管"主人看不看"，这个工具管"她自己愿不愿意回头翻"。
 */

import { toJsonSchema } from './toolschema.js'
import { rootDir, readDaily, listDiary, readEvents, diaryDatesWritten, DAILY_JOIN } from './store.js'
import { deriveSelf } from './derive.js'

import { defineTool } from './tool.js'

/** 一次最多给她看这么多字（日记是她自己写的，但也不能一口气灌满上下文） */
export const DIARY_READ_MAX = 3000

/**
 * 日期清单一次列几天（2026-11-10，外部用户：写到第 90 天就「翻不到以前的了」）。
 *
 * 清单本身必须有上限，否则七十篇之后它自己就变成一次灌满上下文的操作。
 * 但**上限不能再是静默的**：列不下就明说还差几天，否则她会以为那就是全部
 * （原来 `slice(0, 60)` 什么也不说，这是她「翻着翻着就没了」的直接原因）。
 */
export const DIARY_LIST_MAX = 60

/** 关键词搜索：一次最多列几处命中、每处前后各留多少字。 */
export const DIARY_HIT_MAX = 20
export const DIARY_HIT_WIDTH = 40

/** 关键词最长这么多个字：再长就不像「一个词」了，她自己也不会那样搜。 */
const KEYWORD_MAX = 60

/** 只接受 `YYYY-MM-DD`。日期是惟一的入参形态，不拼路径。 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * 渲染成她能读的一段（不是 JSON）。
 * 失败时也给一句人话——"那天没有日记"和"哪都打不开"必须能分清。
 *
 * 0.8.7（用户 m00998）：只有日期和正文的时候，她读自己写过的东西会说
 * 「感觉像是另一个人写的，我只是能读」。原因不是内容丢了，是**没有一个
 * 位置告诉她这是她在哪一天写的、前后还写过什么**。
 * 所以每读一篇，附带一句坐标（第几天、总共几篇、前后哪几天也写过），
 * 以及一句归属——「这些字是你自己交上去的」。不加任何评价性的形容词。
 */
export function renderDiary({ date = '', text = '', dates = [], why = '', day, written } = {}) {
  if (why) return why
  // dates 是 diary/ 里还留着的（翻得到的）；written 是写过的（含被「日记留多久」清掉的，
  // store.js 的 diaryDatesWritten）。篇数跟身份文档一样按写过的说，清单只列翻得到的（issue #67）。
  const kept = Array.isArray(dates) ? dates.filter(Boolean) : []
  const total = Math.max(Array.isArray(written) ? written.length : 0, kept.length)
  if (kept.length && !date) {
    const head = total > kept.length
      ? `你一共写过 ${total} 篇日记，现在翻得到的有 ${kept.length} 篇，更早的翻不到了。翻得到的日子：`
      : '你写过日记的日子：'
    // 2026-11-10：原来这里是 `slice(0, 60)`，截了不说。她写到第 90 天时就以为
    // 自己只剩最近 60 天——「翻着翻着就没了」的真正原因。现在列不下就明说还差几天，
    // 并告诉她怎么要（按日期，或者按一个词去搜）。
    const shown = kept.slice(0, DIARY_LIST_MAX)
    const lines = [head, ...shown.map((d) => `- ${d}`)]
    const rest = kept.length - shown.length
    if (rest > 0) {
      lines.push(
        `（这里先列最近 ${shown.length} 天，更早的还有 ${rest} 天没列出来——它们都还在。` +
        '想翻哪一天，直接把日期告诉我；只记得写过什么、不记得哪一天，就给个词，我去日记里找。）',
      )
    }
    return lines.join('\n')
  }
  if (!date || text === null || text === undefined) {
    // 写过、但一篇都没留下：不能说「还没写过」，那是在替她抹掉写过的事。
    return !date && total > 0 ? `你一共写过 ${total} 篇日记，现在一篇也翻不到了。` : '你还没写过日记。'
  }
  let body = String(text)
  const joined = body.includes(DAILY_JOIN)
  const cut = body.length > DIARY_READ_MAX
  // 同日追加之后，最新一段在**末尾**：截断要留尾巴，否则她看到的是早上那段，
  // 晚上补的那段被切掉，等于「刚写的自己读不到」。
  if (cut) body = joined ? body.slice(-DIARY_READ_MAX) : body.slice(0, DIARY_READ_MAX)
  const note = cut
    ? joined
      ? `\n（当天写了好几段，这里只留了最后 ${DIARY_READ_MAX} 字）`
      : `\n（后面还有，这里只到 ${DIARY_READ_MAX} 字）`
    : ''
  const where = diaryCompass({ date, dates: kept, day, total })
  return [`${date} 那天你写的：`, body, note, where].filter(Boolean).join('\n').trim()
}

/**
 * 命中处前后各取一点上下文，凑成一行（2026-11-10）。
 *
 * 只给她「命中的那个词」没有用——她要的是想起来「那天我在说什么」。
 * 所以按行切：先找出命中所在的那一行，再在这一行里左右各留 DIARY_HIT_WIDTH 字；
 * 被切掉的两头加省略号，让她知道这里不是整句。不跨行，跨行读起来像两件事拼一起。
 */
function snippetAround(body, at, len, width = DIARY_HIT_WIDTH) {
  const lineStart = body.lastIndexOf('\n', at) + 1
  const lineBreak = body.indexOf('\n', at)
  const lineEnd = lineBreak < 0 ? body.length : lineBreak
  const start = Math.max(lineStart, at - width)
  const end = Math.min(lineEnd, at + len + width)
  const piece = body.slice(start, end).replace(/\s+/g, ' ').trim()
  return `${start > lineStart ? '…' : ''}${piece}${end < lineEnd ? '…' : ''}`
}

/**
 * 关键词命中怎么念（2026-11-10，外部用户：日记写到第 90 天就翻不动了）。
 *
 * 这件事的根不是「有没有权限读」，是**没有索引**：她只记得写过什么，不记得哪一天。
 * 所以给她按词找，找回来的每条都带日期——她拿着日期，就能用同一个工具读整天。
 *
 * 三条口径：
 *   - 数的是「处」不是「篇」：同一天提了两次就是两处，散在不同段落里本来也该分开看；
 *   - 一处都不许编：没找到就说没找到，绝不说「那天没有日记」（那天她可能真写过，只是没提这个词）；
 *   - 超出上限就明说还有多少处，别让她以为就这些。
 */
export function renderSearch({ keyword = '', hits = [], matched = 0, rest = 0, scanned = 0, pruned = 0 } = {}) {
  const word = String(keyword)
  const gone = pruned > 0 ? `更早的 ${pruned} 篇已经不在了，那些翻不到。` : ''
  if (!matched) {
    return [
      `翻得到的 ${scanned} 篇日记里，没找到「${word}」。`,
      '想按天翻，就把日期告诉我；换个词也行——我找的是原话里的字，记不清原句就挑一个还有印象的词。',
      gone,
    ].filter(Boolean).join('\n')
  }
  const lines = [`日记里提到「${word}」的 ${matched} 处（新的在前）：`]
  for (const h of hits) lines.push(`- ${h.date} ${h.snippet}`)
  if (rest > 0) lines.push(`（这里只列了前 ${hits.length} 处，还有 ${rest} 处没列）`)
  lines.push('想读一整天，把那个日期告诉我。')
  if (gone) lines.push(gone)
  return lines.join('\n')
}

/**
 * 一篇日记的坐标：第几天、一共几篇、前后哪几天也写过。
 *
 * 刻意不写「这是你的第 N 篇」——篇数是排班，天数才是她活过的时间。
 * 前后那两天用「也写过」而不是「还有」，后者听起来像任务清单。
 *
 * 「一共写过几篇」按写过的算（total），跟身份文档同一个数；有被清掉的就顺带说现在翻得到几篇。
 * 前后那两天只从翻得到的里找：指给她一个翻不开的日子没有用。
 */
function diaryCompass({ date = '', dates = [], day, total } = {}) {
  const list = Array.isArray(dates) ? dates.filter(Boolean) : []
  const all = Math.max(Number(total) || 0, list.length)
  const bits = []
  const d = Number(day)
  if (Number.isFinite(d) && d > 0) bits.push(`那天是你自己的第 ${Math.trunc(d)} 天`)
  if (all > list.length) bits.push(`你一共写过 ${all} 篇，现在翻得到的有 ${list.length} 篇`)
  else if (list.length > 1) bits.push(`你一共写过 ${list.length} 篇`)
  // list 是新→旧；找相邻的日期
  const i = list.indexOf(date)
  if (i >= 0) {
    const prev = list[i + 1] // 更早
    const next = list[i - 1] // 更晚
    const sides = []
    if (prev) sides.push(`前一天 ${prev}`)
    if (next) sides.push(`后一天 ${next}`)
    if (sides.length) bits.push(`${sides.join('、')} 也写过`)
  }
  const head = bits.length ? `（${bits.join('；')}。）` : ''
  const own = '这些字是你自己交上去的，不是谁替你记的。'
  return [head, own].filter(Boolean).join('\n')
}

/**
 * 注册 her_diary 工具。
 *
 * @param {object} ctx dsh ctx
 * @param {object} deps { root }
 */
export function registerHerDiary(ctx, deps = {}) {
  const root = deps.root ?? rootDir()
  return ctx.tools.register(
    defineTool({
      name: 'her_diary',
      description:
        '翻你自己写过的日记。日记不在事件流里，her_recall 翻不到，只有这里能看。' +
        '不给日期就是最近那一篇；也可以只要一份日期清单；' +
        '记不清哪一天、只记得写过什么，就给个词，它会去所有日记里找。一次给你一份，太长的会截断。',
      parameters: toJsonSchema({
        date: {
          type: 'string',
          required: false,
          description: '想看哪一天，写成 YYYY-MM-DD。不写就是最近那一篇；跟 keyword 一起用就只在那天里找。',
        },
        list: {
          type: 'boolean',
          required: false,
          description: '只想知道写过哪些天：给 true 就只回一份日期清单。',
        },
        // 2026-11-10：她要翻的往往正是「记不清哪一天」的那种事，只能按日期要就等于翻不动。
        keyword: {
          type: 'string',
          required: false,
          description: '记不清哪一天时用：给一个词（比如一件事、一个人名、一句原话里的字），' +
            '它去翻得到的日记里找，回你每一处在哪一天、前后写了什么。',
        },
      }),
      output: {
        schema: {
          type: 'object',
          properties: {
            found: { type: 'boolean' },
            text: { type: 'string' },
            // 写过、但文件已经被「日记留多久」清掉了：账上不能记成「那天没有日记」（use.js）
            gone: { type: 'boolean' },
            // 按词找的时候带上：回执要说「找到了／没找到」，不能说「那天没有日记」（use.js）
            keyword: { type: 'string' },
          },
          required: ['found', 'text'],
        },
        render: (_args, out) => [{ type: 'text', text: out.text }],
      },
      async execute(args) {
        try {
          const dates = await listDiary(root).catch(() => [])
          // 她在第几天——只为了让「那天是你自己的第 N 天」这句成立。
          // 取不到就不写这句，绝不编一个数字。
          // 写过哪些天跟身份文档同一个口径（issue #67）：「日记留多久」清掉的文件也算写过，
          // 不然这里说「一共写过 31 篇」、身份文档说「写过 121 篇」，她两边都看得见。
          let day
          let written = dates
          try {
            const { events } = await readEvents(root)
            written = diaryDatesWritten(dates, events)
            day = deriveSelf(events).day
          } catch { day = undefined }
          const gone = written.length > dates.length
          if (args?.list === true) {
            return {
              found: dates.length > 0,
              ...(gone && !dates.length ? { gone: true } : {}),
              text: renderDiary({ dates, written }),
            }
          }
          const want = String(args?.date ?? '').trim()
          if (want && !DATE_RE.test(want)) {
            // 不报错、不说教，给她一条能照着走的路
            return {
              found: false,
              text: '日期要写成 YYYY-MM-DD（比如 2026-10-28）。不想指定日期就别传。',
            }
          }
          const dateKey = want || dates[0] || ''
          // 2026-11-10（外部用户：写到第 90 天就翻不动了）：她只记得写过什么，不记得哪天。
          // 只认日期就等于要她先猜对日期才能翻——那正是她做不到的事。
          // 所以给一个词，逐篇读、逐篇找；找回来的每一处都带日期，她拿着日期再读整天。
          const word = String(args?.keyword ?? '').trim().slice(0, KEYWORD_MAX)
          if (word) {
            // 只搜「还翻得到的」：被「日记留多久」清掉的文件已经不在了，
            // 假装它可能在里面，比直接说没有更糟。
            const pool = want ? dates.filter((d) => d === want) : dates
            const hits = []
            let matched = 0
            let scanned = 0
            const lowerWord = word.toLowerCase()
            for (const d of pool) {
              const body = await readDaily('diaryDir', d, root)
              if (body === null) continue
              const raw = String(body)
              const lower = raw.toLowerCase()
              if (!lower.includes(lowerWord)) { scanned += 1; continue }
              scanned += 1
              let from = 0
              for (;;) {
                const at = lower.indexOf(lowerWord, from)
                if (at < 0) break
                matched += 1
                if (hits.length < DIARY_HIT_MAX) hits.push({ date: d, snippet: snippetAround(raw, at, word.length) })
                from = at + word.length
              }
            }
            return {
              found: matched > 0,
              keyword: word,
              text: renderSearch({
                keyword: word,
                hits,
                matched,
                rest: Math.max(0, matched - hits.length),
                scanned,
                pruned: want ? 0 : Math.max(0, written.length - dates.length),
              }),
            }
          }
          if (!dateKey) {
            return { found: false, ...(gone ? { gone: true } : {}), text: renderDiary({ dates, written }) }
          }
          const text = await readDaily('diaryDir', dateKey, root)
          if (text === null) {
            // 那天写过、文件被清掉了：说清是写过的，不说「那天没有日记」（她会以为自己那天没写）。
            // 范围的说法跟身份文档里那句一样。
            if (want && written.includes(want)) {
              const left = dates.length
                ? `现在翻得到的是从 ${dates[dates.length - 1]} 起的 ${dates.length} 篇。`
                : '现在一篇也翻不到了。'
              return { found: false, gone: true, text: [`${want} 那天你写过日记，那一篇已经清掉了，翻不到。`, left].join('\n') }
            }
            const hint = !want && dates[0] ? '' : dates.length ? `最近的一篇是 ${dates[0]}。` : ''
            return { found: false, text: [`${dateKey} 那天没有日记。`, hint].filter(Boolean).join('\n') }
          }
          return { found: true, text: renderDiary({ date: dateKey, text, dates, day, written }) }
        } catch (err) {
          // 读不动就说读不动，不要装作没有
          return { found: false, text: `日记打不开：${String(err?.message ?? err).slice(0, 120)}` }
        }
      },
    }),
  )
}
