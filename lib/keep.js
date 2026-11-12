/**
 * keep.js —— `bring_back`：这趟出门，她想带一件东西回来（0.6.17）
 *
 * 她只负责「问」：说清看上了哪个文件、为什么。
 * 真复制由那个人点头之后才发生（keepsake.js 的 decideKeepsake）。
 * 回执只描述机器状态（`[已问]` / `[问到了：…]` / `[没问：…]`），不写成她能复述的句子——
 * 2026-10-24 那次「AI 味重」就是模型把工具回执当成自己的话接着说。
 *
 * 0.7.5（2026-10-29，用户 m00239）：点头这一步从观测台的出门页搬到会话里——
 * 她调这个工具的时候，提问卡片直接弹在那条会话的输入框上方，人选完当场落库。
 * 出门页那两个按钮保留当兜底（比如 5 分钟没人答，仍可在出门页追加裁决）。
 */

import { toJsonSchema } from './toolschema.js'
import { rootDir } from './store.js'
import { defineTool } from './tool.js'
import { callerOf } from './tenant.js'
import { activeOf, readOutings } from './outing.js'
import { askKeepsake, decideKeepsake } from './keepsake.js'
import { askInChat, picked } from './askinchat.js'
import { fillOwner } from './pronoun.js'

/** 点头的两个选项。文案用她那个人的语气，不用「批准/拒绝」。 */
export const YES = '准了'
export const NO = '算了'

/**
 * 把「想带这个回去」问进会话里，等一个人选。
 *
 * 返回值刻意分三档，因为三种结果对她意味着完全不同的事：
 *   准了 → 文件已经在家里了
 *   算了 → 这东西留在原地
 *   没答（超时/没人接）→ 还挂着，出门页里仍可以点头
 */
/** 卡开着的时候别处（观测台、接卡的插件）先答了：回执照账上的说，不照这张卡上点的说。 */
function handledElsewhere(d) {
  return { state: 'answered', note: d.item?.status === 'kept' ? '别处先答了，带回来了。' : '别处先答了，没带。', said: 'failed' }
}

async function askBack(ctx, root, { sessionId, item, signal, rawWhy }) {
  const why = String(item?.why ?? '').trim()
  const name = String(item?.rel ?? '').split(/[\\/]/).pop() || String(item?.rel ?? '')
  const r = await askInChat(ctx, {
    sessionId,
    signal,
    root,
    rawTexts: [rawWhy],
    cardId: `keepsake:${item?.id ?? ''}`,
    questions: [
      {
        id: 'keepsake',
        header: '大肥鱼想把这个带回家',
        question: `她想带走「${name}」${why ? `——${why}` : ''}`,
        options: [{ label: YES }, { label: NO }],
      },
    ],
  })
  // 超时 / 没人接 / 宿主没回答人：保持 asked，出门页仍可点头。
  if (!r.ok) return { state: 'unanswered', note: fillOwner('问了。等{T}点头。'), said: '' }

  const said = picked(r.answers, 'keepsake')
  if (said === YES) {
    const d = decideKeepsake(root, { id: item.id, yes: true })
    if (d.handled) return handledElsewhere(d)
    return d.ok
      ? { state: 'answered', note: '准了，带回来了。', said: 'yes' }
      : { state: 'answered', note: `准了，${d.note}`, said: 'failed' }
  }
  if (said === NO) {
    const d = decideKeepsake(root, { id: item.id, yes: false })
    if (d.handled) return handledElsewhere(d)
    return { state: 'answered', note: '没带。', said: 'no' }
  }
  return { state: 'unanswered', note: fillOwner('问了。等{T}点头。'), said: '' }
}

/** 注册 bring_back 工具。 */
export function registerBringBack(ctx, deps = {}) {
  const root = deps.root ?? rootDir()
  return ctx.tools.register(
    defineTool({
      name: 'bring_back',
      description:
        '想带一件东西回去。只能选你这次出门那个工作区里的文件；' +
        '带不带得回去，要那个人点头。不用为了带而带。',
      parameters: toJsonSchema({
        path: {
          type: 'string',
          required: true,
          description: '文件路径（相对这次出门那个工作区也可以）。',
        },
        why: {
          type: 'string',
          description: '为什么想带它。一句话就够，200 字以内。',
        },
      }),
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            note: { type: 'string' },
            // 会话里问到答案时才有：yes=准了 / no=算了；空表示还挂着（超时或没人接）。
            said: { type: 'string' },
          },
          required: ['ok', 'note'],
        },
        render: (_args, out) => [
          {
            type: 'text',
            text: !out.ok
              ? `[没问：${out.note}]`
              : out.said === 'yes'
                ? '[准了]'
                : out.said === 'failed'
                  ? `[${out.note}]`
                  : out.said === 'no'
                    ? '[算了]'
                    : '[已问]',
          },
        ],
      },
      async execute(args, exec) {
        // 2026-10-29 真机 bug（用户 m02517）：这里原来走 guardWrite，而 guardWrite 要求
        // 调用者的 cwd 在**她自己家**里；出门时 cwd 恰好是别人那个工作区，于是每次都被
        // 「这条调用来自另一个家」挡掉——bring_back 在唯一该起作用的场合根本用不了。
        // 这一句判断的是「她这趟在外面」，不是「写入她家」：只要调用来自当前 active
        // 那趟出门的会话就够，写进 keepsakes.json 的还是她自己家。
        if (deps.tenant?.tenant && deps.tenant.tenant.ok === false) {
          return { ok: false, note: deps.tenant.tenant.why || '这个家被另一个实例占着，这次没有写。' }
        }
        const { sessionId = '' } = callerOf(exec)
        if (!sessionId) return { ok: false, note: '这句得从外面那条会话里说。' }

        const { outings } = await readOutings(root)
        const outing = activeOf({ outings })
        if (!outing) return { ok: false, note: '现在没在外面。' }
        if (!outing.sessionId || String(outing.sessionId) !== String(sessionId)) {
          return { ok: false, note: '这句得从外面那条会话里说。' }
        }
        const r = askKeepsake(root, {
          outing,
          sessionId,
          rel: String(args?.path ?? ''),
          why: String(args?.why ?? ''),
        })
        if (!r.ok || !r.item) return { ok: false, note: r.note }

        // 0.7.5：问她那个人。这一步会等到有人选或者超时（默认 5 分钟），
        // 但无论走哪条路，台账里都已经有一条 asked——不会因为没人答就丢掉这件事。
        const back = await askBack(ctx, root, { sessionId, item: r.item, signal: exec?.signal, rawWhy: args?.why })
        return { ok: true, note: back.note, said: back.said }
      },
    }),
  )
}
