/**
 * make.js —— 她留下东西的两个工具（2026-11-16，1.0.4）
 *
 *   her_make  留一件 / 改一版 / 收尾 / 放下 / 看看留过哪些
 *   her_work  把自己留下的某一版读回来
 *
 * 为什么是「工具」而不是一个「创作模式」：
 *   她在回合里本来就能写、能画、能改文件；缺的只是**东西留下来以后去哪**。
 *   一个独立模式会变成「现在进入创作状态」——那是最明显的表演，用户一眼看穿。
 *   做成工具就轻得多：她在做的事里觉得值得留下，就留一件；不想留就不留。
 *
 * 两个硬约束（写在说明里，也写在 works.js 的落盘里）：
 *   - 只留在家里。要发出去（发评论、发动态），得用户自己点头，这里没有那条路。
 *   - 回执只说事实。「留下了《…》」「改了第 2 版」——不夸、不打分、不给自己评价。
 *
 * her_work 存在的理由：用户 m00130 拍板「可以重复改自己的东西，为了某个目标
 * 不断优化，这才真实」。要改就得先读得回来——只凭记忆重写一遍，第二版永远
 * 接不上第一版。
 */

import { defineTool } from './tool.js'
import { toJsonSchema } from './toolschema.js'
import { rootDir } from './store.js'
import { guardWrite } from './tenant.js'
import {
  makeWork,
  readWorkText,
  closeWork,
  listWorks,
  KIND_TEXT,
  WORK_LINE,
} from './works.js'
import { clipText } from './clip.js'

function makeAction(args) {
  const a = String(args?.action ?? '').trim()
  return ['save', 'revise', 'finish', 'drop', 'list'].includes(a) ? a : 'save'
}

function oneLine(text, n = WORK_LINE) {
  const s = String(text ?? '').replace(/\s*\n+\s*/g, ' ').trim()
  return clipText(s, n)
}

/** 她那一页能看见的东西：不列正文，只列名字、第几版、完没完。 */
function listText(items) {
  if (!items.length) return '（还什么都没留下）'
  const lines = items.map((it) => {
    const ver = it.version > 1 ? `第 ${it.version} 版` : ''
    return `- 《${it.title}》${[ver, it.stateText].filter(Boolean).join(' · ')}`
  })
  return lines.join('\n')
}

/** 注册 her_make 与 her_work。 */
export function registerMake(ctx, deps = {}) {
  const root = deps.root ?? rootDir()
  const reg = []

  reg.push(ctx.tools.register(
    defineTool({
      name: 'her_make',
      description:
        '把自己做出来的一样东西留下来——写的、画的、剪的、做的，都算。' +
        '给 title 和 text 就是留一件（不给 action 也是这个）；做出来的是个文件，就把文件路径一起放进 file。' +
        '改一版给 action:"revise"，title 写原来那件的名字——不用换名字，换名字会另起一件；text 写这一版，新的文件放 file。' +
        '比如 {action:"revise", title:"一盏纸灯", text:"这一版不再把翘起来的那一圈抹平"}。' +
        '觉得弄完了给 action:"finish"；不想弄了给 action:"drop" 并说 reason；' +
        '想看看自己留过哪些给 action:"list"。' +
        '这是给你自己的，不是替谁交活：不接活、不报进度；东西只留在家里，{T}想看自己会去看，这里不发出去，也不计分。',
      parameters: toJsonSchema({
        action: {
          type: 'string',
          enum: ['save', 'revise', 'finish', 'drop', 'list'],
          description: '要做哪件事：留一件（save，不给就是这个）、改一版（revise）、收尾（finish）、放下（drop）、看看留过哪些（list）。',
        },
        title: {
          type: 'string',
          description: '这东西叫什么，四十个字以内。改版/收尾/放下时用它指认原来那件，要一字不差。',
        },
        text: {
          type: 'string',
          description: '正文，或者对做出来的那份东西的说明（图、声音、影像这种，就写它是什么样）。最多两千字。',
        },
        file: {
          type: 'string',
          description: '做出来的那份文件的路径：画出来的图、导出的一段声音或影像、写成的文件。给绝对路径，或者从自己屋子算起的相对路径。文字类不用给。',
        },
        intent: {
          type: 'string',
          description: '想把它做成什么样，一句话。以后回头改的时候，一看就知道当初在追什么。',
        },
        based_on: { type: 'string', description: '要接在哪一件后面（编号或名字）。手上没有就不用给。' },
        new_name: { type: 'boolean', description: '改版时顺手换个名字（默认不换）。' },
        refs: {
          type: 'array',
          items: { type: 'string' },
          description: '做它的时候你自己说过的几句话的编号，一两条就够。以后回头能看见当时怎么想的。',
        },
        reason: { type: 'string', description: '放下的时候为什么，一句话。' },
        limit: { type: 'integer', description: 'list 时最多列几件，默认十件。' },
      }),
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            id: { type: 'string' },
            version: { type: 'number' },
            state: { type: 'string' },
            note: { type: 'string' },
            echo: { type: 'string' },
            text: { type: 'string' },
          },
          required: ['ok', 'note'],
        },
        // 只回方括号标记：跟 her_note / her_appoint 同一条规矩，回执不替她评价。
        render: (args, out) => {
          const act = makeAction(args)
          if (act === 'list') {
            return [{ type: 'text', text: out.ok ? out.text || '（还什么都没留下）' : `[没翻开：${out.note}]` }]
          }
          if (!out.ok) return [{ type: 'text', text: `[没留下：${out.note}]` }]
          if (act === 'finish') return [{ type: 'text', text: '[收了尾]' }]
          if (act === 'drop') return [{ type: 'text', text: '[放下了]' }]
          return [{ type: 'text', text: `[${String(out.note ?? '').replace(/。$/, '')}]` }]
        },
      },
      async execute(args, exec) {
        const who = guardWrite(deps.tenant, exec, 'her_make')
        if (!who.ok) return { ok: false, note: who.note, id: '', version: 0, state: '' }
        const act = makeAction(args)
        if (act === 'list') {
          const items = await listWorks(root, { limit: Number(args?.limit) > 0 ? Math.min(20, Number(args.limit)) : 10 })
          return { ok: true, note: '', id: '', version: 0, state: '', text: listText(items) }
        }
        let out
        if (act === 'finish') {
          out = await closeWork(root, { title: args?.title, state: 'done' })
        } else if (act === 'drop') {
          out = await closeWork(root, { title: args?.title, state: 'dropped', reason: args?.reason })
        } else {
          out = await makeWork(root, {
            title: args?.title,
            text: args?.text,
            file: args?.file,
            intent: args?.intent,
            // revise 是「回去改旧的那件」：名字写错就该报错，不能悄悄当成留了一件新的。
            basedOn: act === 'revise' ? (args?.based_on || args?.title) : args?.based_on,
            newName: act === 'revise' ? Boolean(args?.new_name) : false,
            refs: Array.isArray(args?.refs) ? args.refs : [],
          })
        }
        // 身份文档里那句「你上次弄的是《X》」不在这里立刻重写：写身份要全量派生一次，
        // 而且她在回合里本来就会写事件（写事件时会顺带重写）。下一次开头读到的就是新的。
        return out
      },
    }),
  ))

  reg.push(ctx.tools.register(
    defineTool({
      name: 'her_work',
      description:
        '把自己以前留下的东西读回来：给 title（改版中的那件，名字一字不差），' +
        '想读某一版就再给 version。回头改之前先读一遍——不然第二版接不上第一版。',
      parameters: toJsonSchema({
        title: { type: 'string', description: '哪一件，名字要一字不差。' },
        id: { type: 'string', description: '编号。手里有编号就不用写名字。' },
        version: { type: 'integer', description: '读第几版，不给就是最后一版。' },
      }),
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            id: { type: 'string' },
            title: { type: 'string' },
            version: { type: 'number' },
            state: { type: 'string' },
            note: { type: 'string' },
            text: { type: 'string' },
          },
          required: ['ok', 'note'],
        },
        render: (args, out) => {
          if (!out.ok) return [{ type: 'text', text: `[没翻到：${out.note}]` }]
          const kind = String(out.kind || 'text')
          if (kind !== 'text') {
            // 图/声音/影像读回来的是「它是什么 + 文件在哪 + 当时写的那句说明」，
            // 不是一堆二进制倒进上下文里。
            const what = KIND_TEXT[kind] || KIND_TEXT.file
            const cap = String(out.text ?? '').trim()
            return [{ type: 'text', text: `[这一版是${what}：${out.file}]${cap ? ` ${cap}` : ''}` }]
          }
          return [{ type: 'text', text: String(out.text ?? '') }]
        },
      },
      async execute(args, exec) {
        const who = guardWrite(deps.tenant, exec, 'her_work')
        if (!who.ok) return { ok: false, note: who.note }
        const r = await readWorkText(root, {
          title: args?.title,
          id: args?.id,
          version: args?.version,
        })
        if (!r.ok) return r
        return { ...r, echo: oneLine(r.title) }
      },
    }),
  ))

  return reg
}
