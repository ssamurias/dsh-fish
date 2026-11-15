// 文档要随包一起发出去，链接也要在 npm 页面上点得开。
// 起因（2026-11-14）：1.0.1 加了 docs/插件约定.md，`files` 白名单里却没有 docs ——
// 装了这个包的人手里没有那份文档；README 里又是相对链接，在 npm 页面上指向一个打不开的地址。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

function covered(files, target) {
  return files.some((f) => !f.includes('*') && (target === f || target.startsWith(`${f}/`)))
}

test('docs/ 下的每一篇都进包，不留下只在仓库里能看的文档', () => {
  const { files } = JSON.parse(read('package.json'))
  const names = readdirSync(join(root, 'docs')).filter((n) => n.endsWith('.md'))
  assert.ok(names.length > 0, 'docs/ 下应该有文档')
  for (const name of names) {
    assert.ok(covered(files, `docs/${name}`), `docs/${name} 没进 files 白名单，装了这个包的人打不开它`)
  }
})

test('README 里指到 docs/ 的链接都写成 GitHub 绝对地址（npm 页面上相对链接打不开）', () => {
  const md = read('README.md')
  const relative = [...md.matchAll(/\]\((docs\/[^)\s#]+)\)/g)].map((m) => m[1])
  assert.deepEqual(relative, [], `这些链接在 npm 上会 404：${relative.join('、')}`)
})
