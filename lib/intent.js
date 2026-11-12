/**
 * 「他给了一条视频」——这句话是要求，还是随口一提。
 *
 * 为什么需要单独一个模块：她刷站是一条线（自己找、自己筛），
 * 他在对话里丢一条链接是另一条线。后者带着态度：说"必须看"是要求，
 * 说"要不要看"只是在问她。把两者混成"有链接就看"，等于把
 * 「她可以拒绝」这件事直接从她身上拿掉了——那正是用户在意的东西。
 *
 * 判定只做一件事：给个方向，不给答案。
 * 最后看不着、要不要看，仍然是她自己的决定（见 persona.js 的 WATCH_RULE）。
 */

import { fillOwner } from './pronoun.js'

const BV_RE = /BV[0-9A-Za-z]{10}/g
const LINK_RE = /(b23\.tv\/[0-9A-Za-z]+|bilibili\.com\/video\/(?:BV[0-9A-Za-z]{10}|av\d+))/i

// 否定优先：「不用看」「别看了」「算了」不是要求，是收回要求。
const NEG = /(不用|不必|没必要|不需要|别看了|不要看了|不想看|算了|先不|这次不|改天)/
// 明确要求。
const MUST = [
  /必须/,
  /一定要/,
  /务必/,
  /非看不可/,
  /帮我看/,
  /给我看/,
  /看完(以后|之后)?(告诉我|跟我说|说)/,
  /你(去)?(看|读)(一下|一遍)(这个|这条)/,
  /要你(看|读完)/,
]
// 只是问她。
const MAYBE = [
  /可以看/,
  /要不要看/,
  /要不要/,
  /有没有兴趣/,
  /感不感兴趣/,
  /想不想看/,
  /愿意看/,
  /你愿意/,
  /随便看/,
]

/**
 * 从一段话里抠出 BV 号。取第一个——一条消息里丢多条链接的情况，
 * 现在按第一条算，多的不做猜测。
 */
export function extractBvid(text) {
  const m = String(text ?? '').match(BV_RE)
  return m && m.length ? m[0] : ''
}

/**
 * @param {string} text 他说的那句话
 * @returns {{hasVideo:boolean, bvid:string, linkOnly:boolean, intent:'must'|'maybe'|'none', why:string}}
 */
export function parseWatchIntent(text) {
  const s = String(text ?? '').trim()
  const bvid = extractBvid(s)
  const linkOnly = !bvid && LINK_RE.test(s)
  const hasVideo = Boolean(bvid || linkOnly)

  if (!hasVideo) return { hasVideo: false, bvid: '', linkOnly: false, intent: 'none', why: 'no-video' }

  if (NEG.test(s)) return { hasVideo: true, bvid, linkOnly, intent: 'none', why: 'negated' }

  for (const re of MUST) {
    if (re.test(s)) return { hasVideo: true, bvid, linkOnly, intent: 'must', why: String(re) }
  }
  for (const re of MAYBE) {
    if (re.test(s)) return { hasVideo: true, bvid, linkOnly, intent: 'maybe', why: String(re) }
  }
  // 只丢了条链接、什么也没说：不是要求。她本来就不知道该看什么，
  // 这种时候问一句比直接看更接近她。
  return { hasVideo: true, bvid, linkOnly, intent: 'maybe', why: 'bare' }
}

/**
 * 拼成递给她的那一行。返回空串表示没什么要说的（看不出是视频，或他收回了要求）。
 *
 * 注意措辞：这里只描述"他说了什么"，不替她做决定。
 * 写成"你必须看"就变成了另一份人格设定，那会跟 WATCH_RULE 打架。
 *
 * @param {{bvid?:string, linkOnly?:boolean, intent?:string}} r
 * @returns {string}
 */
export function watchHint(r) {
  if (!r || !r.hasVideo) return ''
  if (r.intent === 'none') return ''
  // 2026-10-28：短链不再需要他重新给 BV 号——bili_look what=video 认得链接
  const which = r.bvid
    ? `BV 号是 ${r.bvid}`
    : '{T}给的是一条短链（给 bili_look what=video 就能打开）'
  if (r.intent === 'must') {
    return fillOwner(`{T}这条消息里有一条视频，${which}。{T}那句话是在要求你看。先看，再回{T}。`)
  }
  return fillOwner(`{T}这条消息里有一条视频，${which}，但{T}没有一定让你看。你可以自己定：想看就看；不想看就直接问{T}，为什么是这条、这是什么。`)
}
