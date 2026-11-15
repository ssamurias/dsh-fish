/**
 * selfrules.js —— 她自己定的规矩（2026-11-15，用户 m01412 批准）
 *
 * 和 rules.js 不是一回事：rules.js 是四条硬黑名单（我们给她的边界），
 * 这里是她自己说的「以后我要怎么做事」。
 *
 * 真源是事件流里 `topic === RULE_TOPIC` 的那些话（utterance / revise），
 * 这里只做筛选、折叠和渲染。**不另开一个可写的规矩文件**：
 *   1. 那会是第二份账——改文件绕过 revise，留痕就断了；
 *   2. 她手上只有 growth_commit，文件反而会让「谁都能写」；
 *   3. 文件要进提示词还得再写一层读，等于多一道没有必要的桥。
 * RULES.md 只是给人看的只读镜像（selfdoc.js 里同步）。
 *
 * 上限 6 条不是抠字数，是逼取舍：「什么算长期规矩」得她自己回答一次。
 */

export const RULE_TOPIC = '规矩'
export const RULES_SHOWN = 6

function sinceOf(b) {
  const t = Date.parse(String(b?.since ?? ''))
  return Number.isFinite(t) ? t : 0
}

/** 当前还没被撤掉/改掉的规矩，按立下的先后（旧 → 新）。 */
export function rulesOf(beliefs = []) {
  return (Array.isArray(beliefs) ? beliefs : [])
    .filter((b) => String(b?.topic ?? '').trim() === RULE_TOPIC)
    .filter((b) => !b?.status || b.status === 'active')
    .filter((b) => String(b?.text ?? '').trim())
    .sort((a, b) => sinceOf(a) - sinceOf(b))
}

/**
 * 身份文档里的那一段。放最末（persona 的 `## 这次` 之前），
 * 因为它是整份文档里变得最少的一节——挂尾巴只让这一小段的前缀缓存失效。
 */
export function renderRulesSection(rules = []) {
  const list = Array.isArray(rules) ? rules : []
  if (!list.length) return ''
  const shown = list.slice(-RULES_SHOWN)
  const older = list.length - shown.length
  const lines = ['## 你自己定的规矩']
  for (const r of shown) lines.push(`- ${String(r.text ?? '').trim()}`)
  if (older > 0) {
    lines.push(`- 还有 ${older} 条更早的规矩，这回没全摆出来；记不清就用 her_recall 翻「${RULE_TOPIC}」。`)
  }
  lines.push('这些是你自己定的。和眼前的事对得上就按它来；对不上，宁可按眼前的事，别硬套。想改就改，改了照新的来。')
  return lines.join('\n')
}
