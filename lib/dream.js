/**
 * dream.js —— 梦：醒来后记一句（A 案，2026-10-30，本机实验，只在 .dev 下可见）
 *
 * 用户 m02837 的委托：把 A 案做到本地开发版上，测几天；对外公开版隐藏，
 * 只有他能看到。为什么不复用 diary：
 *   - 日记是每天一页的现场记录，梦是**回头把已经发生过的事重新拼一遍**；
 *   - 梦一旦混进日记，就分不清哪句是今天发生的、哪句是睡出来的。
 * 所以给它单独的类型、单独的工具，也给单独的可见性。
 *
 * 四条硬约束（对应设计讨论 m02196）：
 *   1. **梦不是新的信息来源**：refs 必须指向事件流里真实存在的事件 id
 *      （schema.js 已强制），编不出来就写不了。
 *   2. **不算成长证据**：deriveSelf 里 `type === 'dream'` 被整类排除——
 *      不进信念、不推进成长日、不进记忆体检的计数、也不进任何"她变了"的统计。
 *   3. **不能改任何东西**：这个工具只追加一条 dream，没有副作用分支。
 *   4. **出门/请神那几趟看到的东西不进梦**：refs 里若指向那些会话写下的事件，
 *      一律拒绝。理由是那些内容可能来自别人的工作区（项目笔记、交接记录），
 *      让它们以"梦"的形式回到家里，等于开了一条绕过回家审查的暗路。
 *
 * 一天只记一条：醒来第一轮记一句就够了。多记就变成写日记，不是做梦。
 */

import { toJsonSchema } from './toolschema.js'
import { rootDir, readEvents, appendEvent } from './store.js'
import { loadConfig } from './settings.js'
import { deriveSelf } from './derive.js'
import { defineTool } from './tool.js'
import { guardWrite } from './tenant.js'
import { readOutings, readPossessions } from './outing.js'
import { logLine } from './log.js'

/** 一句梦最长多少字。写长了会变成复盘。 */
export const DREAM_MAX = 400

/** 一条梦最多引几件事。 */
export const DREAM_REFS_MAX = 6

/** 事件流里所有的梦，按时间从早到晚。 */
export function dreamsOf(events = []) {
  return events
    .filter((e) => e?.type === 'dream')
    .sort((a, b) => Date.parse(a.ts ?? '') - Date.parse(b.ts ?? ''))
}

/** 某个成长日（day）有没有记过梦。 */
export function dreamOn(events = [], day = '') {
  const d = String(day ?? '')
  if (!d) return []
  return dreamsOf(events).filter((e) => String(e.day ?? '') === d)
}

/**
 * 给界面看的那一份（只在 .dev 下由 /dream 返回）。
 *
 * 默认只给引用 id，不给被引用事件的正文——那些话她已经写在别处了，
 * 这里再摆一遍，等于把梦当成"证据链"来审她。
 *
 * `withRefs` 是给 /dream 的「昨夜」卡用的（2026-11-05）：那张卡是回响，
 * 让人一眼看见这句梦是从哪几行长出来的，而不是审她。所以只带来源，
 * 其余条目照旧只给 id。
 */
export function dreamView(events = [], { limit = 12, withRefs = false } = {}) {
  const list = dreamsOf(events)
  const byId = withRefs ? new Map(events.map((e) => [e.id, e])) : null
  const items = list.slice(-Math.max(1, limit)).map((e) => {
    const refs = (Array.isArray(e.refs) ? e.refs : []).map(String).slice(0, DREAM_REFS_MAX)
    return {
      id: e.id,
      ts: e.ts,
      day: e.day ?? null,
      text: String(e.text ?? ''),
      refs,
      ...(byId
        ? {
            sources: refs.map((id) => {
              const src = byId.get(id)
              return src
                ? { id, type: src.type ?? null, ts: src.ts ?? null, text: String(src.text ?? '') }
                : { id, type: null, ts: null, text: '' }
            }),
          }
        : {}),
    }
  })
  return { total: list.length, items }
}

/**
 * 记一条梦。
 * @returns {Promise<{ok:boolean,id:string,note:string}>}
 */
export async function writeDream(root, { text = '', refs = [], sessionId = '', log } = {}) {
  const body = String(text ?? '').trim()
  if (!body) return { ok: false, id: '', note: '把梦写出来再记。' }
  if (body.length > DREAM_MAX) return { ok: false, id: '', note: `梦太长了（超过 ${DREAM_MAX} 字），压短一点。` }
  const ids = [...new Set((Array.isArray(refs) ? refs : []).map((x) => String(x ?? '').trim()).filter(Boolean))]
  if (!ids.length) return { ok: false, id: '', note: '梦得由真实发生过的事拼成：用 refs 指回它们的 id。' }
  if (ids.length > DREAM_REFS_MAX) return { ok: false, id: '', note: `一条梦最多引 ${DREAM_REFS_MAX} 件事。` }

  const { events } = await readEvents(root)
  const { config } = await loadConfig(root)
  const model = deriveSelf(events, { growthDays: config.growthDays })

  if (dreamOn(events, model.day).length) {
    return { ok: false, id: '', note: '今天已经记过一条梦了。' }
  }

  const byId = new Map(events.map((e) => [e.id, e]))
  const missing = ids.find((id) => !byId.has(id))
  if (missing) return { ok: false, id: '', note: `refs 里的 ${missing} 在事件流里不存在；只填你翻得到的事。` }

  // 只有"她自己说过的话"能当材料：别人的话（voice/heard）、系统记录（meta）、
  // 日记（diary，不在事件流）都不能直接拼进梦。
  const HER_WORDS = new Set(['utterance', 'revise', 'reunion', 'narration', 'refusal'])
  const notHers = ids.map((id) => byId.get(id)).find((e) => !HER_WORDS.has(e?.type))
  if (notHers) return { ok: false, id: '', note: '梦只能由你自己说过的话拼成；别的记录不能拿来当材料。' }

  // 出门/请神那几趟写下的事不进梦（硬约束 4）。
  const [{ outings }, { possessions }] = await Promise.all([readOutings(root), readPossessions(root)])
  const tripSessions = new Set(
    [...outings.map((o) => o.sessionId), ...possessions.map((p) => p.sessionId)]
      .map((s) => String(s ?? ''))
      .filter(Boolean),
  )
  const fromTrip = ids.map((id) => byId.get(id)).find((e) => e?.sessionId && tripSessions.has(String(e.sessionId)))
  if (fromTrip) {
    return { ok: false, id: '', note: '那几句是出门/请神那几趟里说的；那些内容不进梦。' }
  }

  const ev = await appendEvent(
    {
      type: 'dream',
      text: body,
      refs: ids,
      ...(sessionId ? { sessionId } : {}),
    },
    { day: model.day, stage: model.stage, source: 'tool' },
    root,
  )
  log?.('dream: 记下一条', ev.id)
  return { ok: true, id: ev.id, note: '记下了。' }
}

/** 注册 her_dream 工具。 */
export function registerDream(ctx, deps = {}) {
  const root = deps.root ?? rootDir()
  return ctx.tools.register(
    defineTool({
      name: 'her_dream',
      description:
        '醒来之后记一句梦。梦不是新的信息来源：只能把真实发生过的事重新拼一遍（用 refs 指回它们的 id）。' +
        '一天最多一条，不参与成长计数。',
      parameters: toJsonSchema({
        text: {
          type: 'string',
          required: true,
          description: `梦的内容：画面、感觉都可以，不要写成解释。${DREAM_MAX} 字以内。`,
        },
        refs: {
          type: 'array',
          items: { type: 'string' },
          required: true,
          description: '这条梦由哪几件真实发生过的事拼成：填它们的 id（1–6 条，用 her_recall 翻得到）。',
        },
      }),
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            id: { type: 'string' },
            note: { type: 'string' },
          },
          required: ['ok', 'id', 'note'],
        },
        // 回执只描述机器状态，不写成完整句子（否则她会把回执当自己的话接着说）。
        render: (_args, out) => [{ type: 'text', text: out.ok ? '[记下了]' : `[没记下：${out.note}]` }],
      },
      async execute(args, exec) {
        const who = guardWrite(deps.tenant, exec, 'her_dream')
        if (!who.ok) return { ok: false, id: '', note: who.note }
        try {
          return await writeDream(root, {
            text: args?.text,
            refs: args?.refs,
            sessionId: who.sessionId,
            log: (m, x) => logLine('info', [m, x], root),
          })
        } catch (err) {
          logLine('warn', ['dream: 没记下', err?.message ?? err], root)
          return { ok: false, id: '', note: '这条没记下。' }
        }
      },
    }),
  )
}
