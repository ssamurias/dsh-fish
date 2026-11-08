/**
 * unlock.js —— 「她能不能长出新规矩」这一件事的全部逻辑（R3，2026-10-24）
 * ================================================================
 * 三条硬原则，写在最前面免得后来的人改错：
 *
 * 1. **不是随机抽卡**。
 *    随机 = 运气决定人格，和"教育引导成长"是两件事。卡的**内容**由她走过的路决定，
 *    什么时候冒出来才交给时间随机（1–3 天后的某次唤醒）。内容不可随机，时机可以。
 *
 * 2. **证据是行为计数，不是分数**。
 *    每个开锁条件都必须能写成"发生过几次 X"。凡是写成"达到多少分"的，都是把关系数值化，
 *    撞契约层。所以这里没有 0–1 的阈值。
 *
 * 3. **一次只给一张**。
 *    同时冒出三张卡，等于让她在一次对话里同时变成三个人。未决的卡没处理掉之前，不出新卡。
 */

import { RULES } from './rules.js'

/** 可以"申请解禁"的规则：只有成长层 */
export function grantableRules() {
  return RULES.filter((r) => r.layer === 'growth')
}

/**
 * 每条规则的开锁证据。
 *
 * 字段含义（全部是"次数"，不是分数）：
 *   revises      她自己把说过的话改对了几次
 *   corrected    被"我记错了"纠正过几次
 *   refusals     她说过"不要"几次
 *   narrations   她写过几段"关于自己"的叙事
 *   spanDays     这些事至少要跨几天（防一天之内刷满）
 *
 * 缺失的字段按 0 算；spanDays 缺省 1（即不需要跨天）。
 */
export const EVIDENCE = Object.freeze({
  'learn-affection': { revises: 2, corrected: 1, refusals: 2, narrations: 1, spanDays: 3 },
})

/** 每张卡自己的冷却（R3）：驳回后等几天、等多久自动过期为"搁置" */
export const OFFER_LIMITS = Object.freeze({
  holdDays: 3,        // 三天不处理 = 搁置（不算驳回，不加重冷却）
  retryDays: [3, 7],  // 驳回后 3 天可以再提；第二次驳回 7 天；第三次起不再自动提
})

/** 把事件流里所有 grant 相关的东西摘出来 */
function grantEvents(events) {
  return (events || []).filter((e) => e && (e.type === 'grant_offer' || e.type === 'grant'))
}

function dayOf(e) {
  return Number.isInteger(e?.day) ? e.day : 0
}

/**
 * 当前还挂着的申请（没有对应裁决、也没过期的那一张）。
 * 一天只可能有一张——旧的不处理，新的不生成。
 */
export function pendingOffer(events, now = Date.now()) {
  const list = grantEvents(events)
  const decided = new Set(list.filter((e) => e.type === 'grant').map((e) => e.grant?.offerId))
  const offers = list.filter((e) => e.type === 'grant_offer' && !decided.has(e.id))
  if (!offers.length) return null
  const last = offers[offers.length - 1]
  const ageMs = now - Date.parse(last.ts || '')
  if (Number.isFinite(ageMs) && ageMs > OFFER_LIMITS.holdDays * 86400000) return null
  return last
}

/** 某一类裁决的历史：approve / reject / expire */
export function offerHistory(events) {
  const list = grantEvents(events)
  const offers = list.filter((e) => e.type === 'grant_offer')
  const byId = new Map(list.filter((e) => e.type === 'grant').map((e) => [e.grant?.offerId, e]))
  return offers.map((o) => {
    const d = byId.get(o.id)
    return {
      id: o.id,
      rule: o.grant?.rule || '',
      why: o.text || '',
      day: dayOf(o),
      ts: o.ts,
      verdict: d ? d.grant?.verdict : 'pending',
      reason: d ? d.grant?.reason || '' : '',
    }
  })
}

/**
 * 现在生效的"已解禁"规则。
 * 驳回不撤销既有授权（已经长出来的东西不能被没收），只有 approve 才加。
 */
export function activeGrants(events, now = Date.now()) {
  const out = []
  for (const e of grantEvents(events)) {
    if (e.type !== 'grant' || e.grant?.verdict !== 'approve') continue
    const exp = e.grant?.expiresAt ? Date.parse(e.grant.expiresAt) : NaN
    if (Number.isFinite(exp) && exp < now) continue
    const rule = e.grant?.rule
    if (rule && !out.includes(rule)) out.push(rule)
  }
  return out
}

/**
 * 算某个规则离解锁还差什么。
 * 返回 {rule, ready, checks:[{key, need, have, ok}], blockedDays}
 */
export function assess(ruleId, model, events = []) {
  const need = EVIDENCE[ruleId] || {}
  const f = model?.facts || {}
  const checks = []
  for (const key of ['revises', 'corrected', 'refusals', 'narrations']) {
    const want = Number(need[key] || 0)
    if (!want) continue
    const have = Number(f[key] || 0)
    checks.push({ key, need: want, have, ok: have >= want })
  }
  // 跨天：首条相关事件到最后一条相关事件之间跨了几天
  const span = Number(need.spanDays || 0)
  if (span > 1) {
    const days = (events || [])
      .filter((e) => e && ['revise', 'refusal', 'narration'].includes(e.type))
      .map(dayOf)
      .filter((d) => d > 0)
    const have = days.length ? Math.max(...days) - Math.min(...days) + 1 : 0
    checks.push({ key: 'spanDays', need: span, have, ok: have >= span })
  }
  return { rule: ruleId, ready: checks.length > 0 && checks.every((c) => c.ok), checks }
}

/** 稳定哈希 → [0,1)，用来给「隔几天冒出来」定一个固定的偏移 */
function h01(s) {
  let x = 2166136261
  for (let i = 0; i < s.length; i++) {
    x ^= s.charCodeAt(i)
    x = Math.imul(x, 16777619)
  }
  return ((x >>> 0) % 10000) / 10000
}

/** 那些"算证据"的事件里最晚的一天 */
export function evidenceLastDay(events) {
  const days = (events || [])
    .filter((e) => e && ['revise', 'refusal', 'narration'].includes(e.type))
    .map(dayOf)
    .filter((d) => d > 0)
  return days.length ? Math.max(...days) : 0
}

/**
 * 这张卡最早可以在「第几天」冒出来。null = 现在根本不该出。
 *
 * 为什么用成长日而不是毫秒：她会的话是"我第几天说的话"，
 * 卡也该挂在那条时间线上；用毫秒会让"改一次 growthDays 就提前/推后"。
 *
 * 偏移（+1~3 天）用规则 id 和驳回次数做稳定哈希，**不用 Math.random**：
 * 每次 tick 都重算的话，随机数会让"今天该不该提"来回抖。
 */
export function offerLimits(config) {
  const raw = Number(config?.rules?.cooldownDays)
  const base = Number.isFinite(raw) ? Math.max(1, Math.min(30, Math.round(raw))) : OFFER_LIMITS.retryDays[0]
  // 第二次翻倍再加一天：默认 3 → [3, 7]，和 0.1.0 起写死的那对数值一模一样。
  return { holdDays: OFFER_LIMITS.holdDays, retryDays: [base, base * 2 + 1] }
}

export function offerDueDay(ruleId, model, events, limits = OFFER_LIMITS) {
  const hist = offerHistory(events).filter((h) => h.rule === ruleId)
  if (hist.some((h) => h.verdict === 'approve')) return null // 已经给了
  const rejects = hist.filter((h) => h.verdict === 'reject').length
  const retry = Array.isArray(limits?.retryDays) && limits.retryDays.length ? limits.retryDays : OFFER_LIMITS.retryDays
  if (rejects >= retry.length) return null // 驳回到上限，不再自动提
  const a = assess(ruleId, model, events)
  if (!a.ready) return null

  const lastReject = hist.filter((h) => h.verdict === 'reject').pop()
  if (lastReject) {
    const wait = retry[rejects - 1] || retry.at(-1)
    const extra = Math.floor(h01(`${ruleId}:${rejects}`) * 3)
    return dayOf(lastReject) + wait + extra
  }
  const base = evidenceLastDay(events)
  const extra = 1 + Math.floor(h01(`${ruleId}:0`) * 3) // 1–3 天
  return base + extra
}

/** 给观测台用：每条可解锁规则现在什么状态 */
export function ruleStatus(events, model, now = Date.now()) {
  const active = activeGrants(events, now)
  const pending = pendingOffer(events, now)
  return grantableRules().map((r) => {
    const a = assess(r.id, model, events)
    return {
      id: r.id,
      title: r.title,
      active: active.includes(r.id),
      ready: a.ready,
      checks: a.checks,
      pending: pending && pending.grant?.rule === r.id ? pending.id : null,
    }
  })
}
