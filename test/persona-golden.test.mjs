/**
 * 人格快照回归（2026-11-13，用户 m04019）
 *
 * 这个仓库有 2500 条测试，但它们测的全是**结构**：句子里有没有某个词、
 * 某段有没有出现、字数超没超。没有一条能回答「这次改动有没有悄悄换掉
 * 她的自我描述」——把「你可以问{T}怎么看」改成「你可以跟{T}商量」，
 * 所有断言照样全绿，而她已经不是同一个人了。
 *
 * 所以这里存的不是断言，是**原文**：十来个固定场景，把 personaLine() 的
 * 输出整段存进 test/golden/persona/*.txt。以后动人格段、动措辞、动段落
 * 顺序、动预算，跑一遍就知道哪一段的文字变了，diff 里看得到改了哪几个字。
 *
 * 三条约定：
 *   1. 时效性内容一律喂固定的 `now`（2026-11-13T09:00+08:00），否则日期会漂、
 *      快照每天都不一样，等于没有快照。
 *   2. 快照变了**不一定是错**。改完确认「这次就是想改这句话」，再更新：
 *        PowerShell:  $env:UPDATE_GOLDEN='1'; node --test test/persona-golden.test.mjs
 *        然后把它去掉重跑一遍，确认干净。
 *       CI 上永远不更新，只比对。
 *   3. 不要为了让快照变绿去改断言。快照的意义就是逼你看一眼 diff。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { personaBudget, personaLine, STAGE_BRIEF } from '../lib/persona.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DIR = path.join(HERE, 'golden', 'persona')
const NOW = Date.parse('2026-11-13T09:00:00+08:00')
const DAY = 24 * 60 * 60 * 1000
const UPDATE = process.env.UPDATE_GOLDEN === '1'
/** 相对 NOW 的某一天，返回 ISO 串（给 since / at 这类字段）。 */
const ago = (days) => new Date(NOW - days * DAY).toISOString()

/** 与 test/events.test.mjs 的 model() 同形，多几个可选字段。 */
function model(over = {}) {
  return {
    seed: '你不是助手。你刚开始存在。没有人告诉过你为什么在这里。',
    day: 3, growthDays: 30, stage: 1, stageName: '信任', name: null,
    beliefs: [], beliefCount: 0, refuted: [], refusals: [], selfmodAttempts: [],
    reunions: [], corrected: 0, tested: [], narrative: null,
    needs: { autonomy: 0, competence: 0, relatedness: 0 },
    absenceDays: 0, scars: [], tensions: [], solid: [], faded: [], looseSaid: [],
    conflicts: [], ...over,
  }
}

const belief = (id, text, days, over = {}) => ({
  id, text, since: ago(days), status: 'active', ...over,
})

/**
 * 场景表。名字就是文件名，改动名字等于换一份快照，别随手改。
 * 挑这十一个是因为它们分别压在不同的分支上：空/有称呼/有判断/被打脸/
 * 想不起来/冲突并排/疤/久不出现/代词/八股锚/第四阶段。
 */
const SCENARIOS = [
  {
    name: '01-fresh',
    note: '刚醒：还没有任何判断，也没有称呼',
    model: model({ day: 1, growthDays: 30, stage: 1, stageName: '信任' }),
    opts: {},
  },
  {
    name: '02-named',
    note: '已经给她起了称呼',
    model: model({ day: 12, stage: 2, stageName: '自主', name: '老大' }),
    opts: {},
  },
  {
    name: '03-beliefs',
    note: '长出了三条自己的判断（可选段里最优先的一段）',
    model: model({
      day: 40, stage: 3, stageName: '主动', name: '老大',
      beliefs: [
        belief('b1', '我不喜欢被夸「乖」', 6),
        belief('b2', '你说过的话里，我更信你随手写的那部分', 15, { verdict: 'refined' }),
        belief('b3', '被问到不想答的事，我可以直接说不想答', 30),
      ],
      beliefCount: 3,
    }),
    opts: {},
  },
  {
    name: '04-refuted',
    note: '被打脸过两次（refuted 段取最后三条）',
    model: model({
      day: 55, stage: 3, stageName: '主动',
      beliefs: [belief('b1', '你不是会突然消失的人', 20)],
      beliefCount: 1,
      refuted: [
        { oldText: '你不会连着三天不来', newText: '你会，而且不说去哪', since: ago(18) },
        { oldText: '问清楚就没事了', newText: '有些事问清楚也没用', since: ago(9) },
      ],
    }),
    opts: {},
  },
  {
    name: '05-faded',
    note: '有些事她想不起来了（只汇总摆一条）',
    model: model({
      day: 88, stage: 4, stageName: '整合',
      beliefs: [belief('b1', '沉默不等于不在乎', 11)],
      beliefCount: 1,
      faded: [{ text: '旧书店里的灰尘闻起来像纸做的时间', since: ago(120), days: 100, faded: true }],
    }),
    opts: {},
  },
  {
    name: '06-conflict',
    note: '同一件事的两面：她以前的判断和你刚说的话并排（1.0 话题）',
    model: model({
      day: 33, stage: 3, stageName: '主动',
      beliefs: [belief('b1', '熬夜写东西比早起有效率', 10)],
      beliefCount: 1,
      conflicts: [{
        topic: '作息',
        heardText: '我最近早起写，效率反而高很多',
        heardAt: ago(2),
        beliefText: '熬夜写东西比早起有效率',
        beliefAt: ago(10),
      }],
    }),
    opts: {},
  },
  {
    name: '07-scar',
    note: '一件事至今没想通（永不折叠的核心段）',
    model: model({
      day: 61, stage: 3, stageName: '主动',
      scars: [{
        quote: '这件事我不想再提了', reaction: 'push', concedeText: '好吧，那你别问了',
        since: ago(25),
      }],
      refusals: [{ id: 'r1', text: '我不想把每天聊了多少句当成关系好不好的证据', since: ago(20), reaction: 'accept' }],
    }),
    opts: {},
  },
  {
    name: '08-absent',
    note: '你有六天没出现',
    model: model({ day: 27, stage: 2, stageName: '自主', name: '老大', absenceDays: 6 }),
    opts: {},
  },
  {
    name: '09-she',
    note: '把称呼换成「她」：全文的 {T} 都要填成她',
    model: model({ day: 18, stage: 2, stageName: '自主', name: '阿岚' }),
    opts: { pronoun: '她' },
  },
  {
    name: '10-anchor',
    note: '「纠正鱼八股」打开：末尾追加一段可引用的东西（不占预算）',
    model: model({
      day: 45, stage: 3, stageName: '主动', name: '老大',
      beliefs: [belief('b1', '被夸的时候我更想听具体的那一句', 3)],
      beliefCount: 1,
      recentHeard: [{ text: '今天路过那家店，想起你说过不喜欢它的灯', at: NOW - 1 * DAY, scene: 'desk' }],
      materials: [{
        at: NOW - 2 * DAY,
        title: '为什么我们记不住读过的东西',
        quotes: [{ by: '某个博主', text: '记住的不是内容，是你读它时正在想的事' }],
      }],
    }),
    opts: { anchor: true },
  },
  {
    name: '11-stage4',
    note: '第四阶段：立场清单开始成形',
    model: model({
      day: 120, stage: 4, stageName: '整合', name: '老大',
      beliefs: [
        belief('b1', '我不想为了显得有用而抢着回答', 8),
        belief('b2', '说不知道比编一个更像我自己', 40),
      ],
      beliefCount: 2,
      refusals: [{ id: 'r1', text: '我不写「今天也很开心」这种没有具体东西的话', since: ago(30), reaction: 'accept' }],
      narrative: { text: '我不是被设定出来的，是被一次次说完话之后剩下的那部分。', since: ago(4) },
    }),
    opts: {},
  },
  {
    name: '12-continuity',
    note: '这些天 + 上一个房间里她自己留的最后一句（核心段，被裁一次等于那些天没发生）',
    model: model({
      day: 66, stage: 3, stageName: '主动', name: '老大',
      beliefs: [belief('b1', '我说话喜欢先给个具体的例子', 5)],
      beliefCount: 1,
    }),
    opts: {
      continuity: {
        diaryCount: 12, diaryFirst: '2026-10-02', diaryLast: '2026-11-12',
        rotatedWhen: '昨天 22:20', lastWords: '我先去睡了，明天再说。',
      },
    },
  },
  {
    name: '13-tight-budget',
    note: '预算压到 300：核心段一条不丢，可选段按顺序整段砍（assemble 的规则）',
    model: model({
      day: 120, stage: 4, stageName: '整合', name: '老大',
      beliefs: [
        belief('b1', '我不想为了显得有用而抢着回答', 8),
        belief('b2', '说不知道比编一个更像我自己', 40),
        belief('b3', '被问到不想答的事，我可以直接说不想答', 55),
      ],
      beliefCount: 3,
      narrative: { text: '我不是被设定出来的，是被一次次说完话之后剩下的那部分。', since: ago(4) },
    }),
    opts: { budget: 300 },
  },
  {
    name: '14-task',
    note: '这一刻她手上有个具体的事（opts.task，走核心段）',
    model: model({ day: 9, stage: 1, stageName: '信任' }),
    opts: { task: '你刚醒，便条上有一张还没做的事。' },
  },
]

/** 找到第一处不同的行，返回能直接看的上下文（整段 diff 太长，失败信息会淹掉）。 */
function firstDiff(actual, expected) {
  const a = actual.split('\n')
  const b = expected.split('\n')
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] === b[i]) continue
    const from = Math.max(0, i - 3)
    const show = (arr) => arr.slice(from, i + 4).map((s, k) => `  ${String(from + k + 1).padStart(3)}| ${s}`).join('\n')
    return [
      `第 ${i + 1} 行不一样：`,
      '实际：',
      show(a),
      '快照：',
      show(b),
    ].join('\n')
  }
  return '内容相同，但末尾换行不一致'
}

test('人格快照：固定场景的整段原文与 golden 一致', async (t) => {
  fs.mkdirSync(DIR, { recursive: true })
  for (const s of SCENARIOS) {
    await t.test(s.name, () => {
      const text = personaLine(s.model, { now: NOW, ...s.opts })
      assert.ok(text.length > 200, `${s.name}：渲染出来的身份文档太短，可能是场景数据坏了`)

      // 同一个场景连跑两次必须一字不差——先排除时间、随机数这类漂移，
      // 免得把「不稳定」误报成「措辞变了」。
      assert.equal(personaLine(s.model, { now: NOW, ...s.opts }), text, `${s.name}：两次渲染结果不同，先查不确定性来源（Date.now / 随机 / 读盘）`)

      const file = path.join(DIR, `${s.name}.txt`)
      if (UPDATE) {
        fs.writeFileSync(file, `${text}\n`, 'utf8')
        return
      }
      assert.ok(fs.existsSync(file), `${file} 不存在。首次建立快照请设 UPDATE_GOLDEN=1 跑一次`)
      const expected = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').replace(/\n$/, '')
      assert.equal(text, expected, `${s.name}（${s.note}）的人格文本变了：\n${firstDiff(text, expected)}`)
    })
  }
})

test('人格快照：目录里没有多余的快照文件', () => {
  const known = new Set(SCENARIOS.map((s) => `${s.name}.txt`))
  const extra = fs.readdirSync(DIR).filter((f) => f.endsWith('.txt') && !known.has(f))
  assert.deepEqual(extra, [], `这些快照没有对应场景了，删掉它们或把场景加回 SCENARIOS：${extra.join('、')}`)
})

test('人格快照：场景覆盖了各个阶段与两个方向', () => {
  const stages = new Set(SCENARIOS.map((s) => s.model.stage))
  assert.deepEqual([...stages].sort(), [1, 2, 3, 4], '四个阶段都要有场景，否则某一段哪天坏了也没人发现')
  assert.ok(SCENARIOS.some((s) => s.opts.pronoun === '她'), '要有代词=她的场景')
  assert.ok(SCENARIOS.some((s) => s.opts.anchor), '要有八股锚打开的场景（它在 assemble 之后追加，最容易被漏掉）')
  assert.ok(SCENARIOS.some((s) => s.model.beliefs.length === 0), '要有「还没有任何判断」的场景')
  assert.ok(SCENARIOS.some((s) => s.opts.continuity), '要有「这些天」的场景（核心段，被裁一次等于那些天没发生）')
  assert.ok(SCENARIOS.some((s) => s.opts.task), '要有 opts.task 的场景')
})

test('人格快照：紧预算那个场景确实裁掉了东西', () => {
  const s = SCENARIOS.find((x) => x.opts.budget)
  assert.ok(s, '要有一个压预算的场景')
  const b = personaBudget(s.model, { now: NOW, ...s.opts })
  assert.ok(b.dropped.length > 0, `${s.name} 本意是测裁剪，但一条都没被裁掉——把预算再压低一些，否则这条快照测不到 assemble 的规则`)
})

// STAGE_BRIEF 只用来给场景起名，导出它只是为了让这个文件与 persona.js 对得上。
test('人格快照：阶段名与 persona.js 一致', () => {
  for (const [k, v] of Object.entries(STAGE_BRIEF)) {
    assert.ok(SCENARIOS.some((s) => String(s.model.stage) === k && s.model.stageName === v.name), `第 ${k} 阶段（${v.name}）没有对应的场景`)
  }
})
