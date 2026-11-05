/**
 * fix-legacy-link.test.mjs —— 从裸名 `dsh-fish` 收拾到 `@ssamurias/dsh-fish`
 *
 * 这条脚本的职责不大，但它是**唯一**能让「用 plugin add 升级」之后不至于两条 fish
 * 打架的东西（issue #43）。重点验三件事：
 *   1. 版本号/ tgz 这种原来「跳过、退出码 0」的写法，现在也要清账；
 *   2. 清完 dependencies 里不能留裸名、bundles 里不能留裸名；
 *   3. 源码目录（link:）那条老路不能被改坏——它还要建 junction 并改名依赖键。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { migrateOne, specOf, specKind, dropLegacyBundle, NEW, LEGACY } from '../scripts/fix-legacy-link.mjs'

const quiet = () => {}

async function withProfile(fn, pkg = {}) {
  const root = await mkdtemp(join(tmpdir(), 'fish-legacy-'))
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8')
    await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const read = async (root) => JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

test('老的裸名依赖三种写法都认得出来（issue #43）', () => {
  assert.deepEqual(specOf({ dependencies: { [LEGACY]: '0.9.0' } }), { field: 'dependencies', spec: '0.9.0' })
  assert.deepEqual(specOf({ devDependencies: { [LEGACY]: '^0.8.9' } }), { field: 'devDependencies', spec: '^0.8.9' })
  assert.deepEqual(specOf({ dependencies: { [LEGACY]: 'file:updates/x.tgz' } }), { field: 'dependencies', spec: 'file:updates/x.tgz' })
  assert.equal(specOf({ dependencies: { [NEW]: '0.9.0' } }), null)
  assert.equal(specOf({ dependencies: {} }), null)
})

test('spec 分成源码目录 / tgz / 版本号三类：只有目录才建链接', () => {
  assert.equal(specKind('link:D:/src/fish'), 'dir')
  assert.equal(specKind('file:../fish'), 'dir')
  assert.equal(specKind('file:updates/dsh-fish-v0.8.9.tgz'), 'tarball')
  assert.equal(specKind('0.9.0'), 'spec')
  assert.equal(specKind('^0.8.9'), 'spec')
  assert.equal(specKind('github:ssamurias/dsh-fish#v0.9.0'), 'spec')
})

test('版本号依赖：清掉裸名键与 bundles 条目，不再"跳过、退出码 0"（issue #43）', async () => {
  await withProfile(
    async (root) => {
      const r = migrateOne(root, { write: true, log: quiet, tag: '20261106000000' })
      assert.equal(r.changed, true)
      const pkg = await read(root)
      assert.equal(pkg.dependencies[LEGACY], undefined, '裸名依赖必须删掉')
      assert.equal(pkg.dependencies[NEW], '0.9.0', '新包名那条要原样留着')
      assert.deepEqual(pkg.dsh.profile.bundles, ['@deepseek-ai/dsh-base', NEW], 'bundles 里不许再有裸名，别的条目原样留着')
      // 备份留着，能回滚
      const bak = JSON.parse(await readFile(join(root, 'package.json.bak-fishrename-20261106000000'), 'utf8'))
      assert.equal(bak.dependencies[LEGACY], '0.9.0')
    },
    { dependencies: { [LEGACY]: '0.9.0', [NEW]: '0.9.0' }, dsh: { profile: { bundles: [LEGACY, '@deepseek-ai/dsh-base'] } } },
  )
})

test('预览（不加 --write）一个字都不改', async () => {
  await withProfile(
    async (root) => {
      const before = await readFile(join(root, 'package.json'), 'utf8')
      const r = migrateOne(root, { write: false, log: quiet })
      assert.equal(r.changed, true)
      assert.equal(await readFile(join(root, 'package.json'), 'utf8'), before)
    },
    { dependencies: { [LEGACY]: '0.9.0' }, dsh: { profile: { bundles: [LEGACY] } } },
  )
})

test('干净的 profile 不报错、不改东西', async () => {
  await withProfile(
    async (root) => {
      const before = await readFile(join(root, 'package.json'), 'utf8')
      const r = migrateOne(root, { write: true, log: quiet, tag: 'x' })
      assert.equal(r.changed, false)
      assert.equal(await readFile(join(root, 'package.json'), 'utf8'), before)
    },
    { dependencies: { [NEW]: '0.9.1' }, dsh: { profile: { bundles: [NEW] } } },
  )
})

test('bundles 里重复的裸名一次清干净，新包名已经在就不重复加', () => {
  const pkg = { dsh: { profile: { bundles: [LEGACY, NEW, LEGACY] } } }
  const done = dropLegacyBundle(pkg, NEW)
  assert.deepEqual(pkg.dsh.profile.bundles, [NEW])
  assert.match(done.join(';'), /删掉 dsh-fish ×2/)
})

test('源码目录那条老路照样能走：改依赖键、建链接、老链接改名停用', async () => {
  const src = await mkdtemp(join(tmpdir(), 'fish-src-'))
  try {
    await writeFile(join(src, 'package.json'), JSON.stringify({ name: NEW }), 'utf8')
    await withProfile(
      async (root) => {
        await mkdir(join(root, 'node_modules', LEGACY), { recursive: true })
        const r = migrateOne(root, { write: true, log: quiet, tag: '20261106000000' })
        assert.equal(r.changed, true)
        const pkg = await read(root)
        assert.equal(pkg.dependencies[LEGACY], undefined)
        assert.match(String(pkg.dependencies[NEW]), /^(link:|file:)/)
        assert.deepEqual(pkg.dsh.profile.bundles, [NEW])
        const done = r.done.join(';')
        assert.match(done, /建链 node_modules\/@ssamurias\/dsh-fish/)
        assert.match(done, /改名停用/)
      },
      { dependencies: { [LEGACY]: `link:${src}` }, dsh: { profile: { bundles: [LEGACY] } } },
    )
  } finally {
    await rm(src, { recursive: true, force: true })
  }
})
