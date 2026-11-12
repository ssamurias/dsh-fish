/**
 * pronounask.js —— 「我该怎么称呼你」这张卡（issue #127 的 C 案，2026-11-12）
 *
 * 起因：主人换了称呼（他 → 她 / TA），但 `owner.pronoun` 只有 config.json 与
 * `POST /dsh-fish/config` 两个写入口。她自己写不进去（no-self-modify：唯一的写盘
 * 工具 growth_commit 只写事件流），也看不见配置（no-read-self）。于是会出现
 * 「她嘴上叫对了、身份文档里还写着『他』」的落差，而且她没法自己发现。
 *
 * 这里做的不是给她一个旋钮，而是让她**问一次**：
 *   她用 `ask_pronoun` 弹一张卡（他 / 她 / TA），人点了哪个，插件才写进配置。
 *   决定权在人，落盘由代码做——和 keepsake / grant 是同一种分工。
 *
 * 三条约束：
 *   1. **一次只问一句**：不给设置页加选项，也不让别的地方调这个写配置的入口。
 *   2. **不猜**：回执认不出来的（手打的「她呀」、空的、乱码）一律不结算，卡照旧开着。
 *      猜错的代价是她的身份文档整份写错，比不问更糟。
 *   3. **问过就别缠着**：答案记进事件流（`pronoun:<值> <请求 id>`），三十天内不再问；
 *      同一天里问过还没答，也不重复弹。
 *
 * 事件怎么落（events.jsonl 只追加）：
 *   meta `ask-pronoun`                 这次问的凭证（卡片 id = `pronoun:<事件 id>`）
 *   meta `pronoun:<他|她|TA> <请求 id>` 人的选择，以及它答的是哪一次
 * 不新增事件类型：她读得懂 meta，观测台也不用改。
 */

import { defineTool } from './tool.js'
import { toJsonSchema } from './toolschema.js'
import { appendEvent, readEvents, rootDir } from './store.js'
import { loadConfig, updateConfig } from './settings.js'
import { PRONOUN_VALUES, normalizePronoun } from './pronoun.js'
import { askInChat, picked } from './askinchat.js'
import { deriveSelf } from './derive.js'
import { callerOf } from './tenant.js'
import { logLine } from './log.js'

/** 问过一次之后，多久之内不再问。 */
export const PRONOUN_ASK_COOLDOWN_MS = 30 * 24 * 3600 * 1000

/** 问过、还没答：这段时间里不重复弹卡。 */
export const PRONOUN_ASK_PENDING_MS = 24 * 3600 * 1000

const META_ASK = 'ask-pronoun'
const META_ANSWER = 'pronoun:'

/** 能力地图的第二层：什么处境想起它（test/toolmap.test.mjs 会查这一句）。 */
export const PRONOUN_ASK_BRIEF =
  '**ask_pronoun** —— 什么时候想起它：你说「他」说得顺口，可他也许更想被叫「她」或者「TA」，' +
  '你又不该自己替他决定。问一次就好，他点了哪个，以后就照那个叫。'

function tsOf(ev) {
  const t = Date.parse(String(ev?.ts ?? ''))
  return Number.isFinite(t) ? t : 0
}

/** 事件流里她的代词请求：{ pending: 最近一次没答的, answered: 最近一次答了的 }。 */
export function pronounAskState(events = [], now = Date.now()) {
  const metas = events.filter((e) => e?.type === 'meta')
  const asked = metas.filter((e) => String(e?.text ?? '') === META_ASK)
  const answered = metas
    .filter((e) => String(e?.text ?? '').startsWith(META_ANSWER))
    .map((e) => {
      const rest = String(e.text).slice(META_ANSWER.length).trim()
      const bits = rest.split(/\s+/)
      const value = String(bits[0] ?? '')
      // 第三段是「问的那一次」的 meta id：卡片 id 就是 `pronoun:<它>`，
      // 认这一条才知道哪一次问过、已经答了。
      return { value: normalizePronoun(value), raw: value, at: tsOf(e), id: e.id, ref: String(bits[1] ?? '') }
    })
    .filter((a) => PRONOUN_VALUES.includes(a.raw))
  const answeredIds = new Set(answered.map((a) => a.ref).filter(Boolean))
  const pending = asked.filter((e) => !answeredIds.has(e.id) && now - tsOf(e) < PRONOUN_ASK_PENDING_MS)
  const last = answered.sort((a, b) => b.at - a.at)[0] ?? null
  return { pending: pending.sort((a, b) => tsOf(b) - tsOf(a))[0] ?? null, answered: last }
}

/** 现在能不能问。不能问时说清为什么（这句话会直接给她）。 */
export function pronounAskGate(events = [], now = Date.now()) {
  const state = pronounAskState(events, now)
  if (state.pending) return { ok: false, why: '今天刚问过，还没等到回答。' }
  if (state.answered && now - state.answered.at < PRONOUN_ASK_COOLDOWN_MS) {
    return { ok: false, why: `前些天问过了，答的是「${state.answered.raw}」；三十天内不再问。` }
  }
  return { ok: true, why: '', state }
}

/**
 * 人的选择落地：写配置 + 记一笔「谁、什么时候、答了什么」。
 * 只认三个值本身，别的一概不写。
 */
export async function applyPronounAnswer(root, ref, label) {
  const raw = String(label ?? '').trim()
  const value = PRONOUN_VALUES.includes(raw) ? raw : ''
  if (!value) return { ok: false, why: `只认 ${PRONOUN_VALUES.join(' / ')}，这次没改。` }
  try {
    await updateConfig({ owner: { pronoun: value } }, root)
  } catch (err) {
    return { ok: false, why: `没存上：${String(err?.code ?? err?.message ?? err).slice(0, 80)}` }
  }
  try {
    const { config } = await loadConfig(root).catch(() => ({ config: null }))
    const { events } = await readEvents(root)
    const model = deriveSelf(events, { growthDays: config?.growthDays })
    await appendEvent(
      { type: 'meta', text: `${META_ANSWER}${value} ${String(ref ?? '')}`.trim() },
      { day: model.day, stage: model.stage, source: 'system' },
      root,
    )
  } catch (err) {
    // 配置已经改了，这一笔只是留痕：写不进去不该让人以为「没改成」。
    logLine('warn', ['代词：配置改了，记录没写上', String(err?.code ?? err?.message ?? err).slice(0, 120)], root)
  }
  return { ok: true, value }
}

/** 注册 ask_pronoun。 */
export function registerPronounAsk(ctx, deps = {}) {
  const root = deps.root ?? rootDir()
  return ctx.tools.register(
    defineTool({
      name: 'ask_pronoun',
      description:
        '不知道怎么称呼那个人的时候，问一次：他 / 她 / TA。那个人点了哪个，以后就照那个叫。' +
        '一次问清楚，三十天内不要重复问；还没答的时候也别再弹一张。',
      parameters: toJsonSchema({
        why: {
          type: 'string',
          description: '为什么想确认这件事（可选，一句话就够）。',
        },
      }),
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            note: { type: 'string' },
            value: { type: 'string' },
          },
          required: ['ok', 'note'],
        },
        render: (_args, out) => [
          {
            type: 'text',
            text: out.ok
              ? out.value
                ? '[以后就按这个叫]'
                : '[问了，等那边说]'
              : `[没问：${out.note}]`,
          },
        ],
      },
      async execute(args, exec) {
        // 家被另一个实例占着：不写、不弹卡（和 ask_owner 同一条理由）。
        if (deps.tenant?.tenant && deps.tenant.tenant.ok === false) {
          return { ok: false, note: deps.tenant.tenant.why || '这个家被另一个实例占着，这次没写。' }
        }
        const { sessionId = '' } = callerOf(exec)
        if (!sessionId) return { ok: false, note: '这句得从你自己的那条会话里说。' }

        const { events } = await readEvents(root)
        const gate = pronounAskGate(events)
        if (!gate.ok) return { ok: false, note: gate.why }

        const { config } = await loadConfig(root).catch(() => ({ config: null }))
        const model = deriveSelf(events, { growthDays: config?.growthDays })
        const ev = await appendEvent(
          { type: 'meta', text: META_ASK },
          { day: model.day, stage: model.stage, source: 'system' },
          root,
        )
        const qid = `pronoun-${ev.id}`
        const why = String(args?.why ?? '').trim()
        const r = await askInChat(ctx, {
          sessionId,
          signal: exec?.signal,
          rawTexts: [why],
          root,
          cardId: `pronoun:${ev.id}`,
          detail: why.slice(0, 200),
          questions: [
            {
              id: qid,
              header: '大肥鱼想确认一件事',
              question: '我该怎么称呼你？',
              options: PRONOUN_VALUES.map((label) => ({ label })),
            },
          ],
        })
        if (!r?.ok) return { ok: false, note: '这次没问上，等下次有机会再说。' }
        const label = String(picked(r.answers, qid) ?? '').trim()
        if (!PRONOUN_VALUES.includes(label)) {
          // 认不出来就当没答：卡那边还开着，别替他挑一个。
          return { ok: true, note: '问了，但没听清，先不改。' }
        }
        const w = await applyPronounAnswer(root, ev.id, label)
        return w.ok
          ? { ok: true, note: `好，以后就按「${w.value}」来叫。`, value: w.value }
          : { ok: false, note: w.why }
      },
    }),
  )
}
