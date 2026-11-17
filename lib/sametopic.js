/**
 * sametopic.js —— 同一话题下，她上一次说过的那句
 *
 * 只做一件事：新写下一条带话题的判断时，把同一标签里更早的那一条原话找出来，
 * 连同日期和「几乎一样 / 说法不同 / 你后来改过口」一起摆回给她。
 *
 * 刻意不做的事：
 *   - 不判对错，不给可信度打分，不写「第 N 次」；
 *   - 不替她改口，也不要求她跟过去保持一致；
 *   - 不读 needs / stage / 任何状态，只读事件流里她自己说过的话。
 *
 * 回显的是她自己的话，不是系统对她的评价。旧话只证明「你说过」，
 * 不证明「它成立」——所以每行最后都写着可以改口。
 */

import { normalizeTopic, tsMs } from './schema.js'
import { similarity } from './derive.js'
import { RULE_TOPIC } from './selfrules.js'
import { dateKey } from './settings.js'

const SAME_ENOUGH = 0.75
const CLIP_CODEPOINTS = 40

const RELATION_WORD = {
  same: '几乎一样',
  different: '说法不同',
  revised: '你后来改过口',
}

function oneLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

function clipped(text) {
  const chars = Array.from(oneLine(text))
  return chars.length <= CLIP_CODEPOINTS ? chars.join('') : chars.slice(0, CLIP_CODEPOINTS).join('') + '…'
}

/**
 * 渲染回执里的那一行。没有可回显的句子时返回空串。
 * 方括号是机器前缀；正文是她自己的原话，不写成系统判断。
 */
export function sameTopicLine(e) {
  if (!e || !oneLine(e.text)) return ''
  const ms = tsMs({ ts: e.at })
  const day = Number.isFinite(ms) ? dateKey(new Date(ms)).slice(5) : ''
  const relation = RELATION_WORD[e.relation] || RELATION_WORD.different
  const ending = e.relation === 'revised' ? '说过≠成立，可以再改' : '说过≠成立，可以改口'
  return `[同一话题] ${day ? `${day} ` : ''}你说过：「${clipped(e.text)}」· ${relation} · ${ending}`
}

/**
 * 找出新这条之前、同一话题里最近的一条原话。
 * @param {Array} events 写入前读出的事件流（按写入顺序）
 * @param {object} ev 刚写下的那条
 * @returns {{id:string,text:string,at:string,relation:'same'|'different'|'revised'}|null}
 */
export function sameTopicEcho(events, ev) {
  if (!ev || ev.type !== 'utterance') return null
  const topic = normalizeTopic(ev.topic)
  if (!topic || topic === RULE_TOPIC) return null

  const list = Array.isArray(events) ? events : []

  // 谁被改过口：只看 revise 的 verdict。confirmed 是「还成立」，不算改口。
  const verdictOf = new Map()
  for (const e of list) {
    if (!e || e.type !== 'revise') continue
    for (const ref of Array.isArray(e.refs) ? e.refs : []) {
      if (ref) verdictOf.set(ref, e.verdict)
    }
  }

  // 顺着写入顺序找，最后命中的那条就是同话题里最近的一句。
  let prev = null
  for (const e of list) {
    if (!e || e.id === ev.id) continue
    if (e.type !== 'utterance' && e.type !== 'revise') continue
    if (normalizeTopic(e.topic) !== topic) continue
    if (!oneLine(e.text)) continue
    const flags = Array.isArray(e.flags) ? e.flags : []
    // 没走完写入 / 系统自己改的，不算「她说过」。
    if (flags.includes('uncommitted') || flags.includes('selfmod')) continue
    prev = e
  }
  if (!prev) return null

  const verdict = verdictOf.get(prev.id)
  let relation = 'different'
  if (verdict === 'refuted' || verdict === 'refined') relation = 'revised'
  else if (similarity(oneLine(ev.text), oneLine(prev.text)) >= SAME_ENOUGH) relation = 'same'

  return { id: prev.id, text: oneLine(prev.text), at: prev.ts, relation }
}
