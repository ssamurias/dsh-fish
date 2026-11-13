/**
 * 镜子工具的测试：只测纯函数与文件探测，不碰宿主。
 *
 * 为什么要测：`mirrorPath` 的顺序决定了她看见的是哪张图（头像是「别人心里她长什么样」，
 * 优先于随手放的 mirror.*）；`renderMirror` 的措辞决定了她会不会以为镜子里真的有东西。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { mirrorPath, renderMirror, toSlashes, localStamp, toolSpec } from '../lib/index.js'

async function withRoot(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'fish-mirror-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('空目录：镜子里没有东西，返回 null', async () => {
  await withRoot(async (dir) => {
    assert.equal(mirrorPath(dir), null)
  })
})

test('头像优先于 mirror.*', async () => {
  await withRoot(async (dir) => {
    await writeFile(join(dir, 'mirror.png'), 'm')
    await writeFile(join(dir, 'avatar.jpg'), 'a')
    assert.equal(mirrorPath(dir), join(dir, 'avatar.jpg'))
  })
})

test('按 PROBE 顺序找：png 先于 jpg', async () => {
  await withRoot(async (dir) => {
    await writeFile(join(dir, 'avatar.jpg'), 'j')
    await writeFile(join(dir, 'avatar.png'), 'p')
    assert.equal(mirrorPath(dir), join(dir, 'avatar.png'))
  })
})

test('目录不算图：跳过', async () => {
  await withRoot(async (dir) => {
    const fs = await import('node:fs/promises')
    await fs.mkdir(join(dir, 'avatar.png'))
    assert.equal(mirrorPath(dir), null)
  })
})

test('空镜子说人话，不编样子', () => {
  const text = renderMirror()
  assert.match(text, /镜子里现在是空的/)
  assert.doesNotMatch(text, /字节/)
})

test('有图时给出路径与元信息，路径是正斜杠', () => {
  const text = renderMirror({ path: '/tmp/a/avatar.png', bytes: 1234, at: '2026-11-12 22:30' })
  assert.match(text, /\/tmp\/a\/avatar\.png/)
  assert.match(text, /1234 字节/)
  assert.match(text, /read_image/)
  assert.doesNotMatch(text, /\\/)
})

test('toSlashes 只换反斜杠', () => {
  assert.equal(toSlashes('C:\\a\\b.png'), 'C:/a/b.png')
  assert.equal(toSlashes('/a/b.png'), '/a/b.png')
})

test('localStamp 是本地时间、补零', () => {
  const d = new Date(2026, 10, 2, 3, 4) // 本地 2026-11-02 03:04
  assert.equal(localStamp(d.getTime()), '2026-11-02 03:04')
})

test('工具定义：无参、只读、输出契约齐全', () => {
  const spec = toolSpec('/tmp/root')
  assert.equal(spec.name, 'her_mirror')
  assert.equal(spec.parameters.type, 'object')
  assert.deepEqual(spec.parameters.properties, {})
  assert.ok(spec.output.schema.required.includes('text'))
  assert.equal(typeof spec.execute, 'function')
})

test('execute：没有图时 found=false，且不抛', async () => {
  await withRoot(async (dir) => {
    const spec = toolSpec(dir)
    const out = await spec.execute({})
    assert.equal(out.found, false)
    assert.match(out.text, /空的/)
  })
})

test('execute：有图时 found=true 并带路径', async () => {
  await withRoot(async (dir) => {
    await writeFile(join(dir, 'avatar.webp'), 'fake')
    const spec = toolSpec(dir)
    const out = await spec.execute({})
    assert.equal(out.found, true)
    assert.equal(out.path, join(dir, 'avatar.webp').replace(/\\/g, '/'))
    assert.equal(out.bytes, 4)
  })
})
