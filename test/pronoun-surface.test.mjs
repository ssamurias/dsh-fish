/**
 * pronoun-surface.test.mjs —— 换了代词以后，她读到的工具说明和约定处境里不能还剩写死的「他」
 *
 * `test/pronoun.test.mjs` 守的是身份文档和 `fillOwner` 本身。工具说明、参数说明、
 * 约定到点那段处境走的是另外两条出口（`lib/use.js` 的 `withUse`、`appointPrompt` 自己的
 * `fillOwner`），出口都会填 `{T}`，可模板里要是直接写了「他」，填完还是「他」。
 * 1.0.4 / 1.0.5 新加的几处就是这样漏的：设成「她」以后，growth_commit 的说明里
 * 「回她的某句话（他先提的）」两种叫法挨在一起，约定到点写「你问过他，他还没答」。
 *
 * 所以这里不按文件挑，按她真的读得到的东西扫：
 *   ① 照 `lib/index.js` 的顺序把全部工具注册一遍（走 `withUseDuringRegistration`，和真机一样填），
 *      扫 description / brief / parameters；源码里每个 `defineTool` 都得在这里注册到，免得新工具漏扫；
 *   ② `appointPrompt` 的每一种答复、有没有时刻、晚没晚，都渲染一遍；
 *   ③ 约定被驳回时存进预约簿的那句理由：它是存下来的数据，不是模板，所以既不能写死「他」，
 *      也不能把 `{T}` 原样存进去。
 *
 * 词素（其他 / 其它 / 他人 / 他们……）不算；ask_pronoun 列出三个选项的「他 / 她 / TA」不算，
 * 那里是在列选项，不是在称呼人。解析用的正则不在这些文本里，不受影响。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { OWNER_SLOT, pronounFor, resetPronounCache } from '../lib/pronoun.js'
import { normalizeConfig, dateKey } from '../lib/settings.js'
import { writeConfig } from '../lib/store.js'
import { withUseDuringRegistration } from '../lib/use.js'
import { forgetRegisteredTools } from '../lib/toolreg.js'
import { appointPrompt, makeAppointment, readAppointments } from '../lib/appoint.js'
import { settleAsk } from '../lib/ask.js'

import { registerCapture } from '../lib/capture.js'
import { registerLook } from '../lib/look.js'
import { registerSpeak } from '../lib/speak.js'
import { registerRecall } from '../lib/recall.js'
import { registerHerDiary } from '../lib/herdiary.js'
import { registerHerStance } from '../lib/stance.js'
import { registerWatch } from '../lib/watch.js'
import { registerSub } from '../lib/sub.js'
import { registerLetter } from '../lib/letter.js'
import { registerNote } from '../lib/note.js'
import { registerAppoint } from '../lib/appoint.js'
import { registerMake } from '../lib/make.js'
import { registerBringBack } from '../lib/keep.js'
import { registerAsk } from '../lib/ask.js'
import { registerPronounAsk } from '../lib/pronounask.js'
import { registerDream } from '../lib/dream.js'
import { registerProactive } from '../lib/proactive.js'

const LIB = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib')

/** 不是在称呼人的「他」：词素，以及 ask_pronoun 列的三个选项。 */
const NOT_OWNER = /其他|其它|他人|他者|他们|他日|他乡|他处|他方|他杀|吉他|他\s*\/\s*她\s*\/\s*TA/g

/** 一段文字里还剩几处指人的「他」。 */
function strayHe(text) {
  return (String(text ?? '').replace(NOT_OWNER, '').match(/他/g) ?? []).length
}

async function withPronoun(pronoun, fn) {
  const root = mkdtempSync(join(tmpdir(), 'fish-pron-surface-'))
  try {
    writeFileSync(join(root, 'events.jsonl'), '', 'utf8')
    resetPronounCache()
    await writeConfig(normalizeConfig({ owner: { pronoun } }), root)
    assert.equal(pronounFor(root), pronoun, '配置要先读进来')
    return await fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    resetPronounCache()
  }
}

/** 照 `lib/index.js` 那张表注册全部工具，收回交给宿主的定义（已经过 withUse 填过 `{T}`）。 */
function registerAllTools(root) {
  const defs = []
  const ctx = {
    tools: {
      register(def) {
        defs.push(def)
        return () => {}
      },
    },
  }
  forgetRegisteredTools()
  withUseDuringRegistration(ctx, root, () => {
    registerCapture(ctx, { root })
    registerLook(ctx, { root, client: {} })
    registerSpeak(ctx, { root, client: {}, speakEnabled: true })
    registerRecall(ctx, { root })
    registerHerDiary(ctx, { root })
    registerHerStance(ctx, { root })
    registerWatch(ctx, { root })
    registerSub(ctx, { root })
    registerLetter(ctx, { root })
    registerNote(ctx, { root })
    registerAppoint(ctx, { root })
    registerMake(ctx, { root })
    registerBringBack(ctx, { root })
    registerAsk(ctx, { root })
    registerPronounAsk(ctx, { root })
    registerDream(ctx, { root })
    registerProactive(ctx, { root })
  })
  forgetRegisteredTools()
  return defs
}

/** 源码里每一个 defineTool 的名字（和 test/toolmap.test.mjs 同一个认法）。 */
function sourceToolNames() {
  const names = new Set()
  for (const file of readdirSync(LIB).filter((n) => n.endsWith('.js'))) {
    const src = readFileSync(join(LIB, file), 'utf8')
    for (const m of src.matchAll(/defineTool\(\{\s*name:\s*'([a-z_]+)'/g)) names.add(m[1])
  }
  return names
}

for (const pronoun of ['她', 'TA']) {
  test(`代词是「${pronoun}」时，每个工具的说明和参数里都不再写死「他」`, async () => withPronoun(pronoun, async (root) => {
    const defs = registerAllTools(root)
    const got = new Set(defs.map((d) => d.name))
    for (const name of sourceToolNames()) {
      assert.ok(got.has(name), `源码里有 ${name}，这里没注册到——把它加进 registerAllTools，不然它的说明没人扫`)
    }
    const stray = []
    const unfilled = []
    let filled = 0
    for (const def of defs) {
      // 按属性读：bili_speak 的说明是 getter，得现取才是她读到的那份。
      const parts = { description: def.description, brief: def.brief, parameters: JSON.stringify(def.parameters ?? {}) }
      for (const [key, text] of Object.entries(parts)) {
        if (text == null) continue
        const n = strayHe(text)
        if (n) stray.push(`${def.name}.${key}：${n} 处，${String(text).replace(NOT_OWNER, '').match(/.{0,16}他.{0,16}/)?.[0]}`)
        if (String(text).includes(OWNER_SLOT)) unfilled.push(`${def.name}.${key}`)
        if (String(text).includes(pronoun)) filled++
      }
    }
    assert.deepEqual(stray, [], '这些说明里还写死了「他」，模板里要写 {T}')
    assert.deepEqual(unfilled, [], '这些说明里的 {T} 没填')
    assert.ok(filled > 0, `至少有一处说明真的填成了「${pronoun}」，不然这条测试什么也没扫到`)
  }))

  test(`代词是「${pronoun}」时，约定到点的处境里每一种答复都不再写死「他」`, async () => withPronoun(pronoun, async () => {
    const at = (h, m) => new Date(2026, 10, 21, h, m, 0, 0).getTime()
    const timed = { id: 'ap1', due: '2026-11-21', time: '20:00', what: '一起看一部电影' }
    const cases = []
    for (const verdict of ['approve', 'later', 'reject', 'unanswered', 'pending']) {
      cases.push([`答复 ${verdict}`, appointPrompt(timed, at(20, 0), { answer: { verdict } })])
    }
    cases.push(['问过、账上没答复', appointPrompt({ ...timed, askId: 'q1' }, at(20, 0))])
    cases.push(['没问过', appointPrompt(timed, at(20, 0))])
    cases.push(['晚了一会儿', appointPrompt(timed, at(20, 20))])
    cases.push(['过点很久', appointPrompt(timed, at(21, 30))])
    const dated = { id: 'ap2', due: '2026-11-21', what: '一起看一部电影' }
    cases.push(['只约了日子，就是今天', appointPrompt(dated, at(9, 0))])
    cases.push(['只约了日子，已经过了', appointPrompt({ ...dated, due: '2026-11-18' }, at(9, 0))])
    const stray = cases.filter(([, text]) => strayHe(text) > 0).map(([label, text]) => `${label}：${text}`)
    assert.deepEqual(stray, [], '这些处境里还写死了「他」，模板里要写 {T}')
    for (const [label, text] of cases) {
      assert.ok(!text.includes(OWNER_SLOT), `${label}：{T} 没填——${text}`)
      assert.ok(text.includes(pronoun), `${label}：应该填成「${pronoun}」——${text}`)
    }
  }))
}

test('约定被驳回作废时，存进预约簿的理由不带代词，也不带没填的 {T}', async () => withPronoun('她', async (root) => {
  const now = Date.now()
  const made = await makeAppointment(root, { what: '一起看一部电影', due: dateKey(new Date(now + 3 * 86_400_000)), now })
  assert.equal(made.ok, true)
  // 照 test/appoint-clock.test.mjs 的写法直接落一条为这条约定问过的卡
  const ask = {
    id: 'ev_ask_ap',
    v: 1,
    ts: new Date(now).toISOString(),
    day: dateKey(new Date(now)),
    stage: 1,
    type: 'ask',
    source: 'system',
    text: '这件事算数吗？',
    refs: [],
    verdict: null,
    confidence: 0.5,
    flags: [],
    ask: { kind: 'appoint', subject: made.id, appointId: made.id },
  }
  appendFileSync(join(root, 'events.jsonl'), `${JSON.stringify(ask)}\n`, 'utf8')
  const s = await settleAsk(root, { askId: ask.id, verdict: 'reject', via: 'ui' })
  assert.equal(s.ok, true)
  const row = (await readAppointments(root)).find((a) => a.id === made.id)
  assert.equal(row.status, 'cancelled', '驳回就地作废')
  assert.ok(row.reason, '作废要留一句为什么')
  // 这句存在盘上，不经过 fillOwner：写「他」会和设成「她」对不上，写 {T} 又会原样漏出去。
  assert.equal(strayHe(row.reason), 0, `理由里写死了「他」：${row.reason}`)
  assert.ok(!/她|TA|\{T\}/.test(row.reason), `理由里不该有代词或占位符：${row.reason}`)
}))
