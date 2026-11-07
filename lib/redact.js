/**
 * redact.js —— 出口脱敏：她对外说的话里，不出现她给主人起的那个名字。
 *
 * 背景（2026-11-07，用户 m00383）：只做出口脱敏，提示词 / 硬约束 / 对内对外的
 * 称呼一律保持原样。也就是：她照样可以叫他「他」「那个人」「梦尘」，
 * 但真正发到群聊、外客私聊、B 站评论区的文字，出去之前把名字换成「对方」。
 *
 * 边界：
 *   - 只处理**发出去的文字**，不改事件流、不改记忆、不改提示词。
 *   - 两字及以上：出现即替换。
 *   - 单字（猫、鱼、梨）：只替换明显在指人的句式，避免把「我喜欢猫」改成
 *     「我喜欢对方」。这条是启发式，挡不住所有写法，属于已知残留风险。
 *   - 空名字 / 空文本：原样返回。
 */

const REPLACEMENT = '对方'

/** 单字名只在这些句式里替换；顺序从长到短，避免「猫跟我说」被「猫说」截断。 */
function oneCharPatterns(name) {
  return [
    `${name}的名字`,
    `叫${name}`,
    `称呼${name}`,
    `${name}跟我说`,
    `${name}告诉我`,
    `${name}跟我`,
    `${name}和我`,
    `${name}让我`,
    `${name}不让我`,
    `${name}不肯`,
    `${name}答应`,
    `${name}同意`,
    `${name}说`,
    `问过${name}`,
    `问${name}`,
    `告诉${name}`,
  ]
}

/**
 * 把 text 里对主人的称呼换成「对方」。
 *
 * @param {string} text
 * @param {string} name  model.name（她给主人起的称呼）
 * @param {string} [replacement]
 * @returns {string}
 */
export function redactOwner(text, name, replacement = REPLACEMENT) {
  const s = String(text ?? '')
  const n = String(name ?? '').trim()
  if (!s || !n) return s

  if (n.length >= 2) return s.split(n).join(replacement)

  let out = s
  for (const pattern of oneCharPatterns(n)) {
    if (!out.includes(pattern)) continue
    // 保留句式里的其它字：「叫猫」→「叫对方」，「猫的名字」→「对方的名字」。
    out = out.split(pattern).join(pattern.split(n).join(replacement))
  }
  return out
}

/**
 * 给「带 @ 前缀」的场景用：前缀原样保留，只脱敏正文。
 * B 站评论的 @ 是账号昵称（公开的），不该被当成主人称呼替换掉。
 */
export function redactOutgoing(text, name, prefix = '', replacement = REPLACEMENT) {
  return `${prefix}${redactOwner(text, name, replacement)}`
}
