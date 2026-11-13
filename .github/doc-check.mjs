#!/usr/bin/env node
/**
 * .github/doc-check.mjs —— 文档里写死的基线数字，必须等于实际条数（2026-11-13，用户 m04019）
 *
 * 为什么要有这个：`README.md`、`AGENTS.md`、`CONTRIBUTING.md`、PR 模板里都写着
 * 「全量 N 条」「当前基线 N 个」这种数字。它不是文档修辞，是别人判断「我这儿跑出来
 * 的是不是对的」的唯一参照。写错了，别人看到 2502 而文档说 2473，第一反应是自己装坏了。
 *
 * 这类数字只会往一个方向漂：往上。每次加测试都得记得手改五处，漏一处没人发现——
 * 2026-11-13 一次排查里就抓到过 1674、1512、2473 三个不同年代的陈年数字同时躺在仓库里。
 * 所以交给 CI：对不上就红，红在 PR 上，而不是红在某个读者的终端里。
 *
 * 只查「当前基线」这一种说法，不碰历史记录：
 *   - `CHANGELOG.md` / `RELEASE-NOTES-*.md` 里每一条都带着当时那一版的条数，
 *     那些数字**本来就该不一样**，查它们是错的。
 *   - 同理 `docs/` 下的说明文字不查。
 *
 * 用法：
 *   node .github/doc-check.mjs              # 跑一遍全量测试，拿实际条数来比
 *   node .github/doc-check.mjs --actual 2521 # 已知条数时跳过跑测试（本地快查）
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 只查这几个文件——它们的读者会把里面的数字当成「当下的事实」。 */
const FILES = [
  'README.md',
  'AGENTS.md',
  'CONTRIBUTING.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
]

/**
 * 三种写法，都是「现在有多少条测试」：
 *   全量 2480 条 / 当前基线 **2490 个** / `node --test` 2490 全绿
 * 加上第四种：`173 个测试文件`（这是文件数，不是条数，单列一条规则）。
 */
const CASE_PATTERNS = [
  { re: /全量\s*\**\s*(\d{3,5})/g, what: '全量 N' },
  { re: /基线\s*\**\s*(\d{3,5})/g, what: '基线 N' },
  { re: /(\d{3,5})\s*全绿/g, what: 'N 全绿' },
]
const FILE_COUNT_RE = /(\d{2,4})\s*个测试文件/g

function actualCases() {
  const arg = process.argv.indexOf('--actual')
  if (arg > -1) {
    const n = Number(process.argv[arg + 1])
    if (!Number.isFinite(n) || n <= 0) {
      console.error('--actual 后面要跟一个正整数')
      process.exit(2)
    }
    return n
  }
  console.log('跑全量测试拿实际条数…（约 35 秒）')
  let out = ''
  try {
    out = execFileSync(process.execPath, ['--test', '--test-reporter=tap'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
    })
  } catch (e) {
    // 测试本身红了也要能读到输出——这里报的是文档的事，测试的红由 test job 负责。
    out = String(e?.stdout ?? '')
    if (!out) {
      console.error('跑不起来 node --test：', e?.message ?? e)
      process.exit(2)
    }
  }
  const fail = /^# fail (\d+)$/m.exec(out)
  if (fail && Number(fail[1]) > 0) {
    console.error(`注意：这次跑测试本身有 ${fail[1]} 条失败，数字仅供参照。`)
  }
  const pass = /^# pass (\d+)$/m.exec(out)
  if (!pass) {
    console.error('没从 TAP 输出里读到 "# pass N"。换一个 --test-reporter 的话，这个脚本要跟着改。')
    process.exit(2)
  }
  return Number(pass[1])
}

function actualFiles() {
  return fs.readdirSync(path.join(ROOT, 'test')).filter((f) => /\.test\.(mjs|cjs|js)$/.test(f)).length
}

const cases = actualCases()
const files = actualFiles()
console.log(`实际：${cases} 条测试 / ${files} 个测试文件\n`)

const problems = []
for (const rel of FILES) {
  const abs = path.join(ROOT, rel)
  if (!fs.existsSync(abs)) {
    problems.push(`${rel}：文件不存在（FILES 表要不要更新？）`)
    continue
  }
  const lines = fs.readFileSync(abs, 'utf8').split('\n')
  lines.forEach((line, i) => {
    const where = `${rel}:${i + 1}`
    for (const { re, what } of CASE_PATTERNS) {
      re.lastIndex = 0
      for (const m of line.matchAll(re)) {
        if (Number(m[1]) !== cases) problems.push(`${where}  ${what} = ${m[1]}，实际 ${cases}`)
      }
    }
    FILE_COUNT_RE.lastIndex = 0
    for (const m of line.matchAll(FILE_COUNT_RE)) {
      if (Number(m[1]) !== files) problems.push(`${where}  测试文件数 = ${m[1]}，实际 ${files}`)
    }
  })
}

if (problems.length) {
  console.error('文档里的基线数字和实际对不上：')
  for (const p of problems) console.error(`  ✖ ${p}`)
  console.error(`\n改法：把上面这些数字改成 ${cases} 条 / ${files} 个测试文件。`)
  console.error('如果只是加了几条测试，动文档就够；如果数字差得远，先确认测试真的跑全了。')
  process.exit(1)
}
console.log('✔ 文档里的基线数字都对得上。')
