/**
 * ask.js —— 请求事件：她有事想征得同意时，弹一张卡（0.7.6，2026-10-30）
 *
 * 用户 m01274 / m01292 的原话大意：「让她觉得自己有什么事想要询问主人同不同意的时候，
 * 可以弹这个选择卡片……结合心理学成长机制」。设计单在 docs/G-请求事件-设计单.md。
 *
 * 为什么单独一种事件，而不是复用 grant_offer：
 *   grant_offer 是 R3 的「我要改一条已有规矩」，裁决结果由 unlock.js 生效；
 *   请求事件问的是**这一件事**——今天能不能歇、能不能要一个路径、能不能换个作息。
 *   两者都能被驳回，但驳回之后 R3 是「冷却后再申请」，请求事件是「不提了」。
 *   混在一种类型里，观测台就分不清「她在改自己」和「她在跟你要东西」。
 *
 * 三条硬约束（对应设计单 §4）：
 *   1. **频率写死在代码里**：每天 1 次、每周 3 次。不进配置——
 *      一旦可调，它就变成「让她多问几次」的旋钮，而这件事的重点是她**不得不问**。
 *   2. **只有五种 kind 有效果**，而且只有 time / rest 真能改东西；
 *      其余三种（need-file / need-tool / other）只记录「问过、答过」，
 *      不落实任何权限——否则她就能借一次点头拓宽自己的工具面，那等于自改设定。
 *   3. **被拒绝不追着问**：裁决写进事件流，她下一轮从上下文里自然知道；
 *      系统不重提、不弹第二次。
 *
 * 事件怎么落：
 *   ask（system 源，文本是她问的原话，ask 子对象带 kind/subject/options）
 *   → answer（system 源，ask.askId 指回上一条，ask.verdict = approve/reject/later）
 *   为什么 ask 用 system 源：她能写的只有那五种类型（schema.js 铁律），
 *   而这条事件必须带结构化字段；由工具在自己的执行里写，她伪造不了第二条。
 */

import { toJsonSchema } from './toolschema.js'
import { rootDir, readEvents, appendEvent } from './store.js'
import { loadConfig, updateConfig, dateKey } from './settings.js'
import { deriveSelf } from './derive.js'
import { defineTool } from './tool.js'
import { callerOf } from './tenant.js'
import { askInChat, picked } from './askinchat.js'
import { tsMs } from './schema.js'
import { logLine } from './log.js'

/** 允许的用途。前三个不落实权限；time / rest 会真改东西。 */
export const ASK_KINDS = Object.freeze(['need-file', 'need-tool', 'time', 'rest', 'other', 'rule'])

/** 每天最多问几次、每周最多问几次（写死，不进配置）。 */
export const ASK_PER_DAY = 1
export const ASK_PER_WEEK = 3

/** 超过这么久还没人答，记成 later（以后再说），不占着「待处理」。 */
export const ASK_TTL_MS = 24 * 3600 * 1000

/** 默认的两个选项。第一个是同意，第二个是不同意。 */
const DEFAULT_OPTIONS = ['可以', '这次不行']

const VIA_LABEL = { chat: '会话里答的', ui: '观测台答的', timeout: '一直没人答', tool: '工具里答的', relay: '别的插件转回来的' }

/** 从事件流里拿全部 ask / answer。 */
export function asksOf(events = []) {
  return events.filter((e) => e?.type === 'ask')
}

export function answersOf(events = []) {
  return events.filter((e) => e?.type === 'answer')
}

/** askId → answer 事件。 */
export function answersByAsk(events = []) {
  const m = new Map()
  for (const a of answersOf(events)) {
    const id = String(a?.ask?.askId ?? '')
    if (id) m.set(id, a)
  }
  return m
}

/** 还没答的请求（按时间从早到晚）。 */
export function pendingAsks(events = [], now = Date.now()) {
  const done = answersByAsk(events)
  return asksOf(events)
    .filter((e) => !done.has(e.id))
    .filter((e) => now - tsMs(e) < ASK_TTL_MS)
    .sort((a, b) => tsMs(a) - tsMs(b))
}

/** 配额：今天问过没有、最近七天问过几次。 */
export function quotaOf(events = [], { now = Date.now(), dk = dateKey() } = {}) {
  const asks = asksOf(events)
  const today = asks.filter((e) => String(e.day ?? '') === dk || dayKeyOf(e, now) === dk).length
  const week = asks.filter((e) => now - tsMs(e) < 7 * 24 * 3600 * 1000).length
  return {
    day: today,
    week,
    perDay: ASK_PER_DAY,
    perWeek: ASK_PER_WEEK,
    ok: today < ASK_PER_DAY && week < ASK_PER_WEEK,
    why: today >= ASK_PER_DAY ? '今天已经问过一次了' : week >= ASK_PER_WEEK ? '这周问过三次了' : '',
  }
}

/**
 * 事件上没写 day 时（老夹具、单测直接构造）用本地日期补一个。
 * 真实写入的事件都带 day（appendEvent 由 deriveSelf 算），这里只是兜底。
 */
function dayKeyOf(ev, now = Date.now()) {
  if (ev?.day) return String(ev.day)
  return dateKey(new Date(tsMs(ev) || now))
}

/** 她今天请过假吗（rest 被同意后写一条 meta）。 */
export function restedToday(events = [], dk = dateKey()) {
  return events.some((e) => e?.type === 'meta' && String(e.text ?? '').startsWith(`rest:${dk}`))
}

/** 观测台/界面要的扁平形状。 */
export function askView(events = [], now = Date.now()) {
  const ans = answersByAsk(events)
  return asksOf(events)
    .slice(-20)
    .map((e) => {
      const a = ans.get(e.id)
      return {
        id: e.id,
        ts: e.ts,
        kind: String(e?.ask?.kind ?? ''),
        subject: String(e?.ask?.subject ?? ''),
        question: String(e.text ?? ''),
        options: Array.isArray(e?.ask?.options) ? e.ask.options : [],
        verdict: a ? String(a?.ask?.verdict ?? '') : '',
        reason: a ? String(a?.ask?.reason ?? '') : '',
        answeredAt: a ? a.ts : '',
        pending: !a && now - tsMs(e) < ASK_TTL_MS,
      }
    })
}

/** 选项列表（去掉空串，最多三个，保证第一个是「可以」）。 */
function optionsOf(raw) {
  const list = Array.isArray(raw) ? raw.map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, 3) : []
  return list.length ? list : DEFAULT_OPTIONS.slice()
}

/** 裁决落地：只有 approve 会动东西，而且只动 time / rest 两种。 */
async function applyVerdict(root, askEv, verdict, { log = () => {} } = {}) {
  const kind = String(askEv?.ask?.kind ?? '')
  const dk = dateKey()
  const day = Number(askEv?.day ?? 0) || undefined
  const ctx = { day, stage: Number(askEv?.stage ?? 1) || 1, source: 'system' }
  try {
    if (verdict !== 'approve') {
      // 驳回与「以后再说」分开记：前者是不同意，后者是「先放着」。
      // 都不重提、不进提示词，只让观测台和后来的她查得到。
      const mark = verdict === 'later' ? 'ask-later' : 'ask-no'
      await appendEvent({ type: 'meta', text: `${mark}:${askEv.id}` }, ctx, root)
      return
    }
    if (kind === 'time') {
      const v = askEv?.ask?.value
      if (v && (v.window || Number.isFinite(Number(v.wakesPerDay)))) {
        const patch = {}
        if (Array.isArray(v.window) && v.window.length === 2) patch.window = v.window
        if (Number.isFinite(Number(v.wakesPerDay))) patch.wakesPerDay = Number(v.wakesPerDay)
        await updateConfig(patch, root)
        await appendEvent({ type: 'meta', text: `ask-time:${askEv.id} ${JSON.stringify(patch)}` }, ctx, root)
        return
      }
      await appendEvent({ type: 'meta', text: `ask-ok:${askEv.id}` }, ctx, root)
      return
    }
    if (kind === 'rest') {
      // 今天不叫她。scheduler.tick 开头的闸门读这一行。
      await appendEvent({ type: 'meta', text: `rest:${dk}` }, ctx, root)
      return
    }
    if (kind === 'rule') {
      // 她自己的规矩：系统只记账，不替她说一句话——那句话必须由她自己写进事件流。
      await appendEvent({
        type: 'meta',
        text: `selfrule:${String(askEv?.ask?.subject ?? '').slice(0, 60)}`,
      }, ctx, root)
      return
    }
    await appendEvent({ type: 'meta', text: `ask-ok:${askEv.id}` }, ctx, root)
  } catch (err) {
    log(`请求事件：裁决落地失败 ${String(err?.message ?? err).slice(0, 160)}`)
  }
}

/**
 * 记下答案（这件事只做一次）。重复答会被拒。
 * @returns {Promise<{ok: boolean, why?: string, answer?: object}>}
 */
export async function settleAsk(root, { askId, verdict, reason = '', via = 'ui', now = Date.now() } = {}) {
  const id = String(askId ?? '')
  if (!id) return { ok: false, why: '没说是哪一条请求' }
  const v = verdict === 'approve' || verdict === 'reject' || verdict === 'later' ? verdict : ''
  if (!v) return { ok: false, why: 'verdict 只能是 approve / reject / later' }

  const { events } = await readEvents(root)
  const askEv = events.find((e) => e?.id === id && e?.type === 'ask')
  if (!askEv) return { ok: false, why: '事件流里没有这一条请求' }
  if (answersByAsk(events).has(id)) return { ok: false, why: '这条已经答过了' }

  const { config } = await loadConfig(root)
  const model = deriveSelf(events, { growthDays: config.growthDays })
  const word = v === 'approve' ? '可以' : v === 'reject' ? '这次不行' : '以后再说'
  const text = String(reason ?? '').trim().slice(0, 200) || word
  const answer = await appendEvent({
    type: 'answer',
    text,
    ask: { askId: id, verdict: v, reason: String(reason ?? '').slice(0, 200), via },
  }, { day: model.day, stage: model.stage, source: 'system' }, root)

  await applyVerdict(root, askEv, v, { log: (m) => logLine('warn', [m], root) })
  return { ok: true, answer }
}

/**
 * 超过 24 小时没答的，记成 later。
 *
 * 为什么要有这一步：卡只弹 5 分钟（askInChat 的超时），人没看见就永远「待处理」。
 * 一天之后还没答，说明这件事要么不重要、要么错过了——记成「以后再说」比
 * 一直挂在观测台上更诚实：她会知道这次没问到，而不是以为还在等。
 */
export async function settleStaleAsks(root, { now = Date.now() } = {}) {
  const { events } = await readEvents(root)
  const done = answersByAsk(events)
  const stale = asksOf(events)
    .filter((e) => !done.has(e.id))
    .filter((e) => now - tsMs(e) >= ASK_TTL_MS)
  let n = 0
  for (const e of stale) {
    const r = await settleAsk(root, { askId: e.id, verdict: 'later', reason: '一直没人答', via: 'timeout', now })
    if (r.ok) n += 1
  }
  return n
}

/**
 * 把卡片回来的选择换算成选项下标（对不上返回 -1）。
 *
 * 2026-10-30 真机（用户 m01756）：她问了一次，卡片消失了，事件流里却**没有** answer 行——
 * 工具回执是「[已问]」，说明我们没认出那个选择。宿主回传的形状可能不止一种
 * （字符串 / {label} / {value} / 下标），所以这里只做「宽松比对」：
 * 先按文本等值比（去首尾空白），再认纯数字下标。真的认不出来时不要再猜，
 * 上层会把原始回执写进日志，下次照着修。
 */
export function askChoiceIndex(options = [], selected = '') {
  const list = (Array.isArray(options) ? options : []).map((x) => String(x ?? '').trim())
  const raw = selected && typeof selected === 'object'
    ? selected.label ?? selected.value ?? selected.text ?? ''
    : selected
  const s = String(raw ?? '').trim()
  const i = list.indexOf(s)
  if (i >= 0) return i
  if (/^\d+$/.test(s)) {
    const n = Number(s)
    if (n >= 0 && n < list.length) return n
  }
  return -1
}

/** 把她的问题丢进会话卡片，等人选。返回 {state, note, said, code, raw}。 */
async function askInCard(ctx, { sessionId, ev, options, signal }) {
  const r = await askInChat(ctx, {
    sessionId,
    signal,
    cardId: `ask:${ev.id}`,
    detail: String(ev?.ask?.reason ?? ''),
    questions: [
      {
        id: `ask-${ev.id}`,
        header: '大肥鱼有事想问你',
        question: String(ev.text ?? ''),
        options: options.map((label) => ({ label })),
      },
    ],
  })
  if (!r.ok) return { state: 'unanswered', note: '问了，还没答。', said: '', code: r.code ?? 'NO_ANSWER', raw: '', via: r.via ?? '' }
  const pid = `ask-${ev.id}`
  // issue #35：他直接在卡片里打字回答时，宿主回的是 `{id, selected: [], custom: '…'}`
  // （dsh-user-questions 的约定：custom 覆盖选项、selected 留空）。以前这里只看
  // `Array.isArray(selected)`，空数组当成了「选了第一项里的 undefined」，于是
  // 手打的答案永远认不出来、一律记成 NO_MATCH。`askinchat.js` 的 picked() 早就
  // 按这个约定写对了（非空 selected 优先，否则退回 custom），这里复用它。
  const sel = picked(r.answers, pid)
  const idx = askChoiceIndex(options, sel)
  // issue #35 后半：这句 raw 会被 logLine 写进日志，以前是整段回执原文——
  // 他手打的自由回答（可能是私事）就这样落进了日志文件。现在只留形状：
  // 每条回执的 id、选了几个、自定义文本多长。排障够用，原文不落地。
  const raw = JSON.stringify(
    (Array.isArray(r.answers) ? r.answers : []).map((a) => ({
      id: a?.id,
      selected: Array.isArray(a?.selected) ? a.selected.length : '-',
      custom: typeof a?.custom === 'string' ? a.custom.length : 0,
    })),
  ).slice(0, 300)
  if (idx === 0) return { state: 'approved', note: '可以。', said: String(options[0] ?? ''), raw }
  if (idx === 1) return { state: 'rejected', note: '这次不行。', said: String(options[1] ?? ''), raw }
  if (idx === 2) return { state: 'later', note: '以后再说。', said: String(options[2] ?? ''), raw }
  return { state: 'unanswered', note: '问了，还没答。', said: '', code: 'NO_MATCH', raw }
}

/** 注册 ask_owner 工具。 */
export function registerAsk(ctx, deps = {}) {
  const root = deps.root ?? rootDir()
  return ctx.tools.register(
    defineTool({
      name: 'ask_owner',
      description:
        '有事想问那个人同不同意的时候用。只问真的影响你自己的事：今天要不要歇、能不能换个作息、' +
        '能不能要一个文件或一个工具、你想给自己立一条什么规矩。一天最多问一次，一周最多三次。' +
        '不需要解释你在用哪个工具，也不用道谢。',
      parameters: toJsonSchema({
        question: {
          type: 'string',
          required: true,
          description: '你要问的那句话，用你自己的口气，一句话说清。',
        },
        kind: {
          type: 'string',
          required: true,
          enum: ASK_KINDS,
          description: 'need-file / need-tool / time / rest / rule / other',
        },
        subject: {
          type: 'string',
          description: '这件事涉及的东西：文件路径、工具名、时间段，或一句规矩。',
        },
        why: {
          type: 'string',
          description: '为什么想这么做。一句话就够。',
        },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: '最多三个选项，第一个是同意。不写就是「可以 / 这次不行」。',
        },
        wakesPerDay: {
          type: 'number',
          description: '只在 kind=time 时用：你想改成每天醒几次（0–4）。',
        },
        window: {
          type: 'array',
          items: { type: 'string' },
          description: '只在 kind=time 时用：你想改的时段，两个 HH:MM。',
        },
      }),
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            note: { type: 'string' },
            said: { type: 'string' },
            askId: { type: 'string' },
            via: { type: 'string' },
          },
          required: ['ok', 'note'],
        },
        render: (_args, out) => [
          {
            type: 'text',
            text: !out.ok
              ? `[没问：${out.note}]`
              : out.said === 'approved'
                ? '[可以]'
                : out.said === 'rejected'
                  ? '[这次不行]'
                  : out.said === 'later'
                    ? '[以后再说]'
                    : out.said === 'relayed'
                      ? `[已问，送到了${out.via}，还没答]`
                      : '[已问]',
          },
        ],
      },
      async execute(args, exec) {
        // 家被另一个实例占着：不写、不弹卡。和 bring_back 同一条理由。
        if (deps.tenant?.tenant && deps.tenant.tenant.ok === false) {
          return { ok: false, note: deps.tenant.tenant.why || '这个家被另一个实例占着，这次没写。' }
        }
        const { sessionId = '' } = callerOf(exec)
        if (!sessionId) return { ok: false, note: '这句得从你自己的那条会话里说。' }

        const question = String(args?.question ?? '').trim()
        if (!question) return { ok: false, note: '把想问的那句话写出来。' }
        const kind = String(args?.kind ?? '').trim()
        if (!ASK_KINDS.includes(kind)) {
          return { ok: false, note: `kind 只能是 ${ASK_KINDS.join(' / ')}。` }
        }

        const { events } = await readEvents(root)
        const quota = quotaOf(events)
        if (!quota.ok) return { ok: false, note: quota.why }

        const options = optionsOf(args?.options)
        const value = {}
        if (kind === 'time') {
          if (Number.isFinite(Number(args?.wakesPerDay))) value.wakesPerDay = Number(args.wakesPerDay)
          if (Array.isArray(args?.window) && args.window.length === 2) value.window = args.window.map((x) => String(x))
        }

        const { config } = await loadConfig(root)
        const model = deriveSelf(events, { growthDays: config.growthDays })
        const ev = await appendEvent({
          type: 'ask',
          text: question,
          ask: {
            kind,
            subject: String(args?.subject ?? '').trim(),
            options,
            reason: String(args?.why ?? '').trim(),
            ...(Object.keys(value).length ? { value } : {}),
          },
        }, { day: model.day, stage: model.stage, source: 'system' }, root)

        // 卡片只挂在那条会话上；她这轮刚起来时 agent 可能在注册路上，askInChat 会等一小会儿。
        const r = await askInCard(ctx, { sessionId, ev, options, signal: exec?.signal })
        // 别的插件接走了：不是没人理，只是还没答。答了走 lib/cardanswer.js 结算，这里不等。
        if (r.code === 'RELAYED') return { ok: true, note: `问了，送到了${r.via}，还没答。`, said: 'relayed', askId: ev.id, via: r.via }
        if (r.state === 'unanswered') {
          // 2026-10-30 真机（用户 m01756）：卡片消失了，事件流里却没有 answer 行，
          // 回执只写「已问」——事后完全看不出是「没答」还是「认不出选择」。
          // 这里把 code 和原始回执留在日志里，下次照日志修，不再猜。
          logLine('warn', ['她问了却没结算：', r.code || 'NO_MATCH', '·', r.raw ? `回执形状 ${r.raw}` : '没有回执', '· ask=', ev.id], root)
          return { ok: true, note: '问了，等他点头。', said: '', askId: ev.id }
        }
        const verdict = r.state === 'approved' ? 'approve' : r.state === 'rejected' ? 'reject' : 'later'
        const s = await settleAsk(root, { askId: ev.id, verdict, reason: r.said, via: 'chat' })
        return {
          ok: true,
          note: s.ok ? r.note : '问了，但这次没记下来。',
          said: r.state,
          askId: ev.id,
        }
      },
    }),
  )
}
