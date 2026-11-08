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
    return [head, ...kept.slice(0, 60).map((d) => `- ${d}`)].join('\n')
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
        '不给日期就是最近那一篇；也可以只要一份日期清单。一次给你一份，太长的会截断。',
      parameters: toJsonSchema({
        date: {
          type: 'string',
          required: false,
          description: '想看哪一天，写成 YYYY-MM-DD。不写就是最近那一篇。',
        },
        list: {
          type: 'boolean',
          required: false,
          description: '只想知道写过哪些天：给 true 就只回一份日期清单。',
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
