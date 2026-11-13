/**
 * turnexport.js —— 把「这一轮她读到的身份文档」导出成一份 markdown
 *
 * 为什么要有这个（2026-11-13，用户 m04163 认可缩小后的版本）：
 *   她每说一句话，背后同时有判断、疤、原话、素材、八股锚在供料，而身份文档的
 *   字数是有上限的（默认 2400 字）。超了怎么办？**整段不塞，不是截断**——
 *   所以「她为什么没提到我上周说的那件事」的答案，很可能只是那一段被挤掉了。
 *   这一点在界面上看不出来，只能把「这一轮的账」摊开给人看。
 *
 *   做成文件而不是面板，是为了守住「没有人格设置界面」：文件是死的，只能读。
 *   一旦做成面板，下一步就会有人想加「删掉她这条判断」的按钮，那就绕过事件流了。
 *
 * 两件事刻意不做：
 *   · 不往她的提示词里加任何东西（这份文件她读不到）
 *   · 不改人格逻辑（只读现成的 persona 装配结果）
 *
 * 谁调它：`GET /dsh-fish/turn/export`（设置页「说话」那一节底下的一颗只读按钮）。
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { rootDir, paths, readEvents, writeAtomic } from './store.js'
import { loadConfig } from './settings.js'
import { deriveSelf } from './derive.js'
import { buildSections, assembleWithPlan, SELF_DOC_BUDGET } from './persona.js'
import { selfDocPath, writeSelfDoc, continuityOf } from './selfdoc.js'
import { pronounOf } from './pronoun.js'

const pad = (n) => String(n).padStart(2, '0')

/** 文件名用的本地时刻：20261113-2315。用本地时间，因为人看的是本机的钟。 */
export function turnStamp(now = new Date()) {
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
}

const human = (now) => `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`

/**
 * 写一份 `out/turn-<时间戳>.md`。
 *
 * 先 `writeSelfDoc(root)` 再读文件：身份文档是派生物，落盘时才顺手重算；
 * 这样导出里的原文与「她此刻真读到的那份」是同一份，不是另算一遍。
 * 记账那部分（哪些段被裁）用 persona 装配时的同一套计算，避免两套数字。
 *
 * 永不抛：导出是调试用的旁路，失败只回报原因，不打断调用方。
 */
export async function writeTurnExport(root = rootDir(), now = new Date()) {
  const stamp = turnStamp(now)
  const file = join(paths(root).outDir, `turn-${stamp}.md`)
  try {
    await writeSelfDoc(root)

    let text = ''
    try {
      text = await fs.readFile(selfDocPath(root), 'utf8')
    } catch {
      // 第一次还没写出身份文件：下面照常出账，原文留空并说明。
    }

    const { events } = await readEvents(root)
    const { config } = await loadConfig(root)
    const model = deriveSelf(events, { growthDays: config.growthDays })
    const sections = buildSections(model, {
      budget: config?.memory?.docBudget,
      shown: config?.memory?.beliefsShown,
      sleepKeep: config?.memory?.sleepKeep,
      echo: config?.memory?.echo !== false,
      anchor: config?.chat?.anchor === true,
      pronoun: pronounOf(config),
      continuity: await continuityOf(root, now.getTime(), events),
      // 导进来的这一位跳过我方那两条提示词禁令（与 writeSelfDoc 同一判定：只看 model）
      withBans: model?.persona?.imported !== true,
      now: now.getTime(),
    })
    const budget = Number(config?.memory?.docBudget ?? SELF_DOC_BUDGET)
    const plan = assembleWithPlan(sections, budget)
    const dropped = plan.plan.filter((s) => !s.kept)

    const rows = plan.plan
      .map((s) => `| ${s.label} | ${s.chars} | ${s.keep ? '核心（必留）' : s.kept ? '保留' : '**裁掉**'} |`)
      .join('\n')

    const md = [
      '# 这一轮，她读到的身份文档',
      '',
      `导出于 ${human(now)}（本机时间）。`,
      '',
      `**预算**：用了 ${plan.used} / ${plan.budget} 字；留下 ${plan.kept} 段，裁掉 ${dropped.length} 段。`,
      '',
      '## 每段去了哪',
      '',
      '| 段 | 字数 | 结果 |',
      '| --- | --- | --- |',
      rows,
      '',
      dropped.length
        ? '被裁掉的段是**整段不塞**，不是截断——那几句她这一轮完全没看到。'
        : '这一轮没有段被裁掉：预算够，所有段都塞进去了。',
      '',
      '## 原文',
      '',
      '下面这一份和她这一轮读到的逐字相同（也就是 `她的身份.md` 本身）。',
      '',
      '---',
      '',
      text || '（这一次还没写出身份文件。）',
      '',
    ].join('\n')

    await writeAtomic(file, md)
    return {
      ok: true,
      file,
      used: plan.used,
      budget: plan.budget,
      kept: plan.kept,
      total: plan.plan.length,
      dropped: dropped.map((s) => s.label),
    }
  } catch (e) {
    return { ok: false, why: String(e?.message || e), file }
  }
}
