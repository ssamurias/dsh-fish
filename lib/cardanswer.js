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
 * selected 和宿主 userQuestions 的回答同形，填选项原文。没选、对不上选项都不结算，
 * 这张卡还开着：人回的可能只是一句话，猜成同意或以后再说都可能是错的，而且只结算一次，错了改不回来。
 * 结算走的都是观测台和卡片用的同一条路，「只结算一次」也由它们管。
 * `ok: false` 不代表这张卡结了，写盘失败也是它，接卡的插件留着 id，人再答一次就再试一次。
 */

import { rootDir, readEvents } from './store.js'
import { ASK_TTL_MS, answersByAsk, asksOf, settleAsk, settleStaleAsks } from './ask.js'
import { tsMs } from './schema.js'
import { picked } from './askinchat.js'
import { decideKeepsake } from './keepsake.js'
import { YES as KEEP_YES, NO as KEEP_NO } from './keep.js'
import { recordGrant, GRANT_YES, GRANT_NO } from './grant.js'
import { pendingOffer, offerLimits } from './unlock.js'
import { loadConfig } from './settings.js'
import { applyPronounAnswer } from './pronounask.js'

const ASK_VERDICTS = ['approve', 'reject', 'later']

async function answerAsk(root, askId, label) {
  // 过期结算是定时器做的，她出门或者宿主刚起来时可能没跑。过没过期要在这里就算数。
  await settleStaleAsks(root)
  const { events } = await readEvents(root)
  const ev = asksOf(events).find((e) => e?.id === askId)
  if (!ev) return { ok: false, why: '事件流里没有这一条请求' }
  // 上面那次过期结算可能没写进去，过了一天的回答一样不算数。
  if (!answersByAsk(events).has(askId) && Date.now() - tsMs(ev) >= ASK_TTL_MS) return { ok: false, why: '放了一天没人答，算以后再说了' }
  // 只认选项原文。别的插件把人回的「1」直接传进来，不能按下标算成第二个。
  const options = Array.isArray(ev?.ask?.options) ? ev.ask.options.map((x) => String(x ?? '').trim()) : []
  const verdict = ASK_VERDICTS[options.indexOf(label)]
  if (!verdict) return { ok: false, why: '这张卡没有这个选项' }
  const r = await settleAsk(root, { askId, verdict, reason: label, via: 'relay' })
  return r.ok ? { ok: true } : { ok: false, why: r.why }
}

// issue #127 C 案：pronoun:<问的那次 meta id>。只认三个值本身，别的一概不写。
function answerPronoun(root, ref, label) {
  return applyPronounAnswer(root, ref, label)
}

function answerKeepsake(root, id, label) {
  if (label !== KEEP_YES && label !== KEEP_NO) return { ok: false, why: '这张卡没有这个选项' }
  const d = decideKeepsake(root, { id, yes: label === KEEP_YES })
  return d.ok ? { ok: true } : { ok: false, why: d.note }
}

async function answerGrant(root, offerId, label) {
  if (label !== GRANT_YES && label !== GRANT_NO) return { ok: false, why: '这张卡没有这个选项' }
  // 读不到账要照实说，不能说成申请不在了。
  const { events } = await readEvents(root)
  // 几天算搁置跟设置走（rules.holdDays），和调度器、观测台同一个口径。
  const { config } = await loadConfig(root).catch(() => ({ config: null }))
  const offer = pendingOffer(events, Date.now(), offerLimits(config))
  if (offer?.id !== offerId) return { ok: false, why: '这张申请已经不在等了' }
  const w = await recordGrant(root, { offerId, rule: offer.grant?.rule || '', verdict: label === GRANT_YES ? 'approve' : 'reject' })
  return w.ok ? { ok: true } : { ok: false, why: w.error }
}

/**
 * 结算一张被接走的卡。**绝不抛**，别的插件不用替我们兜底。
 * @param {string} root
 * @param {{id: string, selected?: Array}} answer
 * @returns {Promise<{ok: boolean, why?: string}>}
 */
export async function answerCard(root = rootDir(), answer = {}) {
  try {
    const id = String(answer?.id ?? '')
    const at = id.indexOf(':')
    const ref = at > 0 ? id.slice(at + 1) : ''
    if (!ref) return { ok: false, why: '没说是哪一张卡' }
    const label = picked([{ id, selected: answer?.selected }], id)
    if (!label) return { ok: false, why: '没选' }
    switch (id.slice(0, at)) {
      case 'ask': return await answerAsk(root, ref, label)
      case 'pronoun': return await answerPronoun(root, ref, label)
      case 'keepsake': return answerKeepsake(root, ref, label)
      case 'grant': return await answerGrant(root, ref, label)
      default: return { ok: false, why: '不认识这种卡' }
    }
  } catch (err) {
    // 原因可能转告给人，也可能送进她的对话：只说错误码，不带本机路径。
    return { ok: false, why: String(err?.code ?? err?.message ?? err).slice(0, 160) }
  }
}
