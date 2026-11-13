/**
 * turn-export.test.mjs —— 「导出这一轮她读到的」写出来的文件，得能对着看。
 *
 * 这条通道回答的是「她刚才那句话为什么没提到我说过的事」：身份文档有字数上限，
 * 超了是**整段不塞**（不是截断），界面上看不出来。所以导出必须做到三件事：
 *   1. 原文和 `她的身份.md` 逐字相同（不是另算一遍，不许出现两个版本）；
 *   2. 账要和原文对得上（用了多少、哪几段被裁）；
 *   3. 只读——不改事件流、不改身份文件。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { paths, writeConfig } from '../lib/store.js'
import { normalizeConfig } from '../lib/settings.js'
import { selfDocPath, writeSelfDoc } from '../lib/selfdoc.js'
import { writeTurnExport } from '../lib/turnexport.js'
import { assembleWithPlan, sectionLabel } from '../lib/persona.js'

const DAY = 86400000
const iso = (ms) => new Date(ms).toISOString()

async function makeRoot({ docBudget = 800 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'fish-turn-export-'))
  await writeConfig(normalizeConfig({
    window: ['00:00', '23:59'],
    browse: { enabled: false },
    comment: { enabled: false },
    rules: { offers: false },
    interest: { enabled: false },
    memory: { docBudget, sleepEveryDays: 0, beliefsShown: 3, sleepKeep: 3 },
  }), root)
  const base = Date.now() - 5 * DAY
  const lines = [
    { id: 'ev_seed', type: 'seed', text: '起点。', ts: iso(base - 20 * DAY), day: 1, stage: 1, source: 'system' },
    // 判断都来自她认领过的 utterance（没认领的只留证、不进信念）
    { id: 'ev_b1', type: 'utterance', text: '我不太喜欢那种一上来就问「在吗」的开场，像是试探。', ts: iso(base), day: 2, stage: 1, source: 'her', confidence: 0.8 },
    { id: 'ev_b2', type: 'utterance', text: '他说过一次，写东西卡住的时候先别看别人的成品。', ts: iso(base + DAY), day: 3, stage: 1, source: 'her', confidence: 0.7 },
    { id: 'ev_b3', type: 'utterance', text: '我觉得「随便」这两个字比沉默更难接。', ts: iso(base + 2 * DAY), day: 4, stage: 1, source: 'her', confidence: 0.6 },
    { id: 'ev_b4', type: 'utterance', text: '我记不住抽象的道理，只记得住具体那句话。', ts: iso(base + 3 * DAY), day: 5, stage: 1, source: 'her', confidence: 0.9 },
  ]
  await writeFile(paths(root).events, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  await writeSelfDoc(root)
  return root
}

test('导出的是她真读到的那一份，账对得上，事件流一个字都没动', async () => {
  const root = await makeRoot({ docBudget: 800 })
  try {
    const docText = await readFile(selfDocPath(root), 'utf8')
    const eventsBefore = await readFile(paths(root).events, 'utf8')

    const r = await writeTurnExport(root)
    assert.equal(r.ok, true, `导出应当成功：${r.why || ''}`)
    assert.ok(r.file.startsWith(paths(root).outDir), '文件必须落在数据目录的 out/ 下')

    const md = await readFile(r.file, 'utf8')
    assert.ok(md.includes(docText.trim()), '原文必须和 `她的身份.md` 逐字相同')
    assert.match(md, /\*\*预算\*\*：用了 \d+ \/ \d+ 字/)
    assert.ok(md.includes(`用了 ${r.used} / ${r.budget} 字`), '账上的数字要和返回的一致')
    assert.ok(md.includes('## 每段去了哪'))
    assert.ok(md.includes('| 段 | 字数 | 结果 |'))

    // 账与原文对得上：被裁的（有的话）必须逐条写在账里，没裁的要明说
    for (const label of r.dropped) assert.ok(md.includes(label), `被裁的段「${label}」得在账里写明`)
    if (r.dropped.length) assert.ok(md.includes('整段不塞'), '要讲清「不是截断」——这是这份文件唯一的用处')
    else assert.ok(md.includes('这一轮没有段被裁掉'))

    // 只读：事件流与身份文件都不许变
    assert.equal(await readFile(paths(root).events, 'utf8'), eventsBefore, '导出不许改事件流')
    assert.equal(await readFile(selfDocPath(root), 'utf8'), docText, '导出不许改身份文件')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('装配计划：塞不下就整段不塞，账上逐条写明', () => {
  const sections = [
    { keep: true, text: `## 不能做的\n${'x'.repeat(100)}` },
    { keep: false, text: `## 可选一\n${'y'.repeat(100)}` },
    { keep: false, text: `## 可选二\n${'z'.repeat(300)}` },
  ]
  const plan = assembleWithPlan(sections, 300)
  assert.deepEqual(plan.plan.map((s) => s.kept), [true, true, false])
  assert.deepEqual(plan.plan.map((s) => s.keep), [true, false, false])
  assert.equal(plan.plan[0].label, '不能做的', '段名去掉井号，只留第一行')
  assert.ok(plan.text.includes('可选一'))
  assert.ok(!plan.text.includes('可选二'), '被裁的段整段不出现——不是截断')
  assert.deepEqual(plan.plan.filter((s) => !s.kept).map((s) => s.label), ['可选二'])
})

test('段名截到 20 字，长标题不会把账撑破', () => {
  assert.equal(sectionLabel({ text: `## ${'很长的标题'.repeat(6)}\n正文` }), '很长的标题很长的标题很长的标题很长的标题')
  assert.equal(sectionLabel({ text: '没有井号的一行\n第二行' }), '没有井号的一行')
  assert.equal(sectionLabel(null), '')
})

test('预算宽裕时不编造「被裁」，并明说一段没裁', async () => {
  const root = await makeRoot({ docBudget: 4000 })
  try {
    const r = await writeTurnExport(root)
    assert.equal(r.ok, true)
    assert.deepEqual(r.dropped, [], '预算 4000 字时不该有段被裁')
    const md = await readFile(r.file, 'utf8')
    assert.ok(md.includes('这一轮没有段被裁掉'))
    assert.ok(!md.includes('整段不塞'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
