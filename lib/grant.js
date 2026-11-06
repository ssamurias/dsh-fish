/**
 * grant.js —— 把一次「解禁裁决」真的写进事件流（0.7.5，2026-10-29）
 *
 * 以前这段只写在 `lib/observe.js` 的 `/decide` 路由里，因为裁决只有观测台一个入口。
 * 0.7.5 把裁决搬到会话里（提问卡片）之后，**两个入口必须写同一份事件**，
 * 否则同一件事会有两套实现，某天悄悄分叉。所以抽到这里。
 *
 * 两个坑都写在调用点旁边，别删：
 *   1. `appendEvent` 的第二参是 ctx、第三参才是 root。传错位 → source 落回 'tool'
 *      → schema 以 NOT_HER_TYPE 拒收（她不能写系统事件），裁决永远写不进去。
 *   2. 批准之后必须立刻重写身份文档：她下一次开口就得看得见「这件事现在可以了」。
 */

import { appendEvent, readEvents, rootDir } from './store.js'
import { validateEvent } from './schema.js'
import { deriveSelf } from './derive.js'
import { loadConfig } from './settings.js'
import { refreshSelfDoc } from './selfdoc.js'
import { pendingOffer } from './unlock.js'

/**
 * 写下一条 `grant`。
 *
 * @param {string} root
 * @param {object} opts
 * @param {string} opts.offerId 被裁决的申请 id（决定它不再出现在 pending 里）
 * @param {string} opts.rule 规则 id
 * @param {'approve'|'reject'} opts.verdict
 * @param {string} [opts.reason] 她的原话；空则用「可以。」/「这次不行。」
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function recordGrant(root = rootDir(), opts = {}) {
  const verdict = opts.verdict === 'approve' ? 'approve' : opts.verdict === 'reject' ? 'reject' : null
  if (!verdict) return { ok: false, error: 'verdict 只能是 approve 或 reject' }
  const offerId = String(opts.offerId ?? '')
  if (!offerId) return { ok: false, error: '申请 id 是空的' }

  const { config } = opts.config ? { config: opts.config } : await loadConfig(root)
  const { events } = await readEvents(root).catch(() => ({ events: [] }))
  const model = deriveSelf(events, config)
  const reason = String(opts.reason ?? '').trim()
  const text = reason || (verdict === 'approve' ? '可以。' : '这次不行。')
  const ctxArg = { day: model.day, stage: model.stage, source: 'system' }

  try {
    await appendEvent(
      validateEvent(
        {
          type: 'grant',
          text,
          grant: { rule: String(opts.rule ?? ''), offerId, verdict },
          day: model.day,
          stage: model.stage,
        },
        ctxArg,
      ),
      // 第二参是 ctx、第三参才是 root（0.7.4 的教训，见文件头）。
      ctxArg,
      root,
    )
  } catch (err) {
    return { ok: false, error: err?.message || '写入失败' }
  }

  if (verdict === 'approve') await refreshSelfDoc(root, { config }).catch(() => {})
  return { ok: true }
}

/** 会话里问这张申请时的两个选项（lib/scheduler.js 弹卡，lib/cardanswer.js 认回答，要对得上）。 */
export const GRANT_YES = '可以'
export const GRANT_NO = '这次不行'

/** 现在还有没有一张等人裁决的申请（顺手把 id 带出来，省得调用方再查一遍）。 */
export async function currentOffer(root = rootDir(), now = Date.now()) {
  const { events } = await readEvents(root).catch(() => ({ events: [] }))
  const p = pendingOffer(events, now)
  return p ? { id: p.id, rule: p.grant?.rule || '', text: p.text || '' } : null
}
