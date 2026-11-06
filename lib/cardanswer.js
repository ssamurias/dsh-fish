/**
 * cardanswer.js —— 卡片被别的插件接走之后，人的回答从这里回来
 *
 * 人不在她那条会话前的部署（都从 IM 上说话），插件可以用 `dsh-fish/card` 把卡接走
 * （lib/askinchat.js，AGENTS.md §7.3）。人可能隔几个小时才答，中间宿主可能还重启过，
 * 所以回答不靠闭包：插件记着卡的 id，答了就发
 *
 *   const r = await ctx.bail('dsh-fish/answer', { id: card.id, selected: ['可以'] })
 *
 * id 是 `种类:引用`：`ask:<事件 id>`、`keepsake:<条目 id>`、`grant:<申请 id>`。
 * selected 和宿主 userQuestions 的回答同形，空数组是「回了话，没选」：
 *   - ask 记成「以后再说」，理由写 note（不写回答原文：可能是私事，事件流只追加，见 #35）
 *   - keepsake、grant 什么都不写，还挂着，和卡片超时没答一样
 * 结算走的都是观测台和卡片用的同一条路，「只结算一次」也由它们管。
 */

import { rootDir, readEvents } from './store.js'
import { asksOf, askChoiceIndex, settleAsk } from './ask.js'
import { picked } from './askinchat.js'
import { decideKeepsake } from './keepsake.js'
import { YES as KEEP_YES, NO as KEEP_NO } from './keep.js'
import { recordGrant, currentOffer, GRANT_YES, GRANT_NO } from './grant.js'

const ASK_VERDICTS = ['approve', 'reject', 'later']

async function answerAsk(root, askId, label, note) {
  if (!label) {
    const r = await settleAsk(root, { askId, verdict: 'later', reason: String(note ?? ''), via: 'relay' })
    return r.ok ? { ok: true } : { ok: false, why: r.why }
  }
  const { events } = await readEvents(root)
  const ev = asksOf(events).find((e) => e?.id === askId)
  if (!ev) return { ok: false, why: '事件流里没有这一条请求' }
  const verdict = ASK_VERDICTS[askChoiceIndex(ev?.ask?.options, label)]
  if (!verdict) return { ok: false, why: '这张卡没有这个选项' }
  const r = await settleAsk(root, { askId, verdict, reason: label, via: 'relay' })
  return r.ok ? { ok: true } : { ok: false, why: r.why }
}

function answerKeepsake(root, id, label) {
  if (!label) return { ok: true }
  if (label !== KEEP_YES && label !== KEEP_NO) return { ok: false, why: '这张卡没有这个选项' }
  const d = decideKeepsake(root, { id, yes: label === KEEP_YES })
  return d.ok ? { ok: true } : { ok: false, why: d.note }
}

async function answerGrant(root, offerId, label) {
  if (!label) return { ok: true }
  if (label !== GRANT_YES && label !== GRANT_NO) return { ok: false, why: '这张卡没有这个选项' }
  const offer = await currentOffer(root)
  if (offer?.id !== offerId) return { ok: false, why: '这张申请已经不在等了' }
  const w = await recordGrant(root, { offerId, rule: offer.rule, verdict: label === GRANT_YES ? 'approve' : 'reject' })
  return w.ok ? { ok: true } : { ok: false, why: w.error }
}

/**
 * 结算一张被接走的卡。**绝不抛**，别的插件不用替我们兜底。
 * @param {string} root
 * @param {{id: string, selected?: Array, note?: string}} answer
 * @returns {Promise<{ok: boolean, why?: string}>}
 */
export async function answerCard(root = rootDir(), answer = {}) {
  try {
    const id = String(answer?.id ?? '')
    const at = id.indexOf(':')
    const ref = at > 0 ? id.slice(at + 1) : ''
    if (!ref) return { ok: false, why: '没说是哪一张卡' }
    const label = picked([{ id, selected: answer?.selected }], id)
    switch (id.slice(0, at)) {
      case 'ask': return await answerAsk(root, ref, label, answer?.note)
      case 'keepsake': return answerKeepsake(root, ref, label)
      case 'grant': return await answerGrant(root, ref, label)
      default: return { ok: false, why: '不认识这种卡' }
    }
  } catch (err) {
    return { ok: false, why: String(err?.message ?? err).slice(0, 160) }
  }
}
