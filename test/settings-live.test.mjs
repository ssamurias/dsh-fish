import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pruneDiary, paths } from '../lib/store.js'
import { buildSections, keepCount, foldOlderBeliefs } from '../lib/persona.js'

// 2026-11-08（用户 m00585）：有人指出设置页上「日记留多久」与「总共留几条自述」
// 改了什么都不会变。查下来是真的：两个键从 0.1.0 起只存在于默认值/白名单/界面，
// 没有任何一行代码读它。这个文件守住「现在有人读了，而且行为对得上说法」。

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-fish-keep-'))
}

test('日记留多久：超期的删掉，没超期的留着', async () => {
  const root = tmpRoot()
  const dir = paths(root).diaryDir
  fs.mkdirSync(dir, { recursive: true })
  for (const d of ['2026-11-08', '2026-10-10', '2026-09-01']) {
    fs.writeFileSync(path.join(dir, `${d}.md`), `# ${d}\n`, 'utf8')
  }
  const removed = await pruneDiary(30, '2026-11-08', root)
  assert.equal(removed, 1, '只该删 2026-09-01（差 68 天）')
  const left = fs.readdirSync(dir).sort()
  assert.deepEqual(left, ['2026-10-10.md', '2026-11-08.md'])
})

test('日记留多久：0 = 永久保留，一个都不删', async () => {
  const root = tmpRoot()
  const dir = paths(root).diaryDir
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, '2020-01-01.md'), '很久以前\n', 'utf8')
  assert.equal(await pruneDiary(0, '2026-11-08', root), 0)
  assert.equal(await pruneDiary(undefined, '2026-11-08', root), 0)
  assert.deepEqual(fs.readdirSync(dir), ['2020-01-01.md'])
})

test('日记留多久：只动顶层 YYYY-MM-DD.md，archive/ 与别的文件不碰', async () => {
  const root = tmpRoot()
  const dir = paths(root).diaryDir
  fs.mkdirSync(path.join(dir, 'archive'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'archive', '2020-01-01.md'), '旧稿\n', 'utf8')
  fs.writeFileSync(path.join(dir, '2020-01-02.md'), '超期\n', 'utf8')
  fs.writeFileSync(path.join(dir, 'notes.md'), '不是日记\n', 'utf8')
  assert.equal(await pruneDiary(30, '2026-11-08', root), 1)
  assert.ok(fs.existsSync(path.join(dir, 'archive', '2020-01-01.md')), '归档目录不动')
  assert.ok(fs.existsSync(path.join(dir, 'notes.md')), '非日期文件不动')
})

test('写日记时真的会去清（capture.js 接上了 config.diary.keepDays）', async () => {
  const src = await fs.promises.readFile(new URL('../lib/capture.js', import.meta.url), 'utf8')
  assert.match(src, /import \{[^}]*pruneDiary[^}]*\} from '\.\/store\.js'/, '要 import pruneDiary')
  assert.match(src, /await pruneDiary\(config\.diary\.keepDays, dk, root\)/, '要拿配置里的天数去清')
})

test('keepCount：0 与非数字 = 不限制，正数夹在 1–100', () => {
  assert.equal(keepCount(0), null)
  assert.equal(keepCount(''), null)
  assert.equal(keepCount(undefined), null)
  assert.equal(keepCount(12), 12)
  assert.equal(keepCount(1000), 100)
  assert.equal(keepCount(-5), null)
})

const many = Array.from({ length: 20 }, (_, i) => ({ id: `b${i}`, text: `判断${i}`, since: '2026-10-01' }))

function model(extra = {}) {
  return {
    seed: '你是一条会自己长起来的鱼。',
    beliefs: many,
    solid: [],
    faded: [],
    tensions: [],
    refusals: [],
    scars: [],
    selfmodAttempts: [],
    refuted: [],
    narrative: null,
    facts: { refused: 0, hurts: 0, scars: 0 },
    day: 3,
    growthDays: 30,
    stage: 1,
    ...extra,
  }
}

const earlier = (text) => {
  const i = text.indexOf('## 更早以前')
  return i < 0 ? '' : text.slice(i)
}

test('总共留几条自述：留 N 条，其余折进「更早以前」且数得对', () => {
  // 留 5 条、眼前摆 3 条：更早的 2 条会念出来，另外 15 条只报数。
  const text = buildSections(model(), { shown: 3, sleepKeep: 5 }).map((s) => s.text).join('\n')
  const tail = earlier(text)
  assert.match(tail, /还有 15 条更早的/, `被挡在外面的也要算进去：${tail}`)
  // 最显著的 3 条仍然逐条摆着——两个开关不许打架。
  assert.ok(text.includes('判断0') && text.includes('判断1') && text.includes('判断2'))

  // 不设上限（0）：20 条全在里面，17 条更早的，念 3 条、报 14 条。
  const all = earlier(buildSections(model(), { shown: 3, sleepKeep: 0 }).map((s) => s.text).join('\n'))
  assert.match(all, /还有 14 条更早的/, all)
})

test('总共留几条自述：设得比眼前条数还小时，眼前这几条不被砍掉', () => {
  const text = buildSections(model(), { shown: 3, sleepKeep: 2 }).map((s) => s.text).join('\n')
  assert.ok(text.includes('判断2'), '眼前第 3 条不能因为上限是 2 就消失')
  assert.match(earlier(text), /还有 17 条更早的/)
})

test('foldOlderBeliefs：一条都不剩时也要说清还有多少', () => {
  assert.equal(foldOlderBeliefs([], 3, 3, 0), '')
  assert.equal(foldOlderBeliefs([], 3, 3, 7), '还有 7 条更早的，你记不清原话了')
})
