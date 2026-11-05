// 2026-11-05（用户 m02634）：梦 / 主动性 / 兴趣 各有一个开关，默认全开。
// 开关只决定「以后还做不做」，已经发生的记录一条都不删。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { normalizeConfig, DEFAULTS } from '../lib/settings.js'

const here = dirname(fileURLToPath(import.meta.url))
const src = (name) => readFileSync(join(here, '..', 'lib', name), 'utf8')

test('三个开关默认全开', () => {
  assert.equal(DEFAULTS.drive.enabled, true)
  assert.equal(DEFAULTS.interest.enabled, true)
  assert.equal(DEFAULTS.dream.enabled, true)
  const cfg = normalizeConfig({})
  assert.equal(cfg.drive.enabled, true)
  assert.equal(cfg.interest.enabled, true)
  assert.equal(cfg.dream.enabled, true)
})

test('关掉之后保存下来还是关着（不是被默认值盖回去）', () => {
  const cfg = normalizeConfig({ drive: { enabled: false }, interest: { enabled: false }, dream: { enabled: false } })
  assert.equal(cfg.drive.enabled, false)
  assert.equal(cfg.interest.enabled, false)
  assert.equal(cfg.dream.enabled, false)
})

test('三个开关都能从设置页存进去（白名单里有）', () => {
  const observe = src('observe.js')
  assert.match(observe, /'proactive', 'drive', 'interest', 'dream'/)
})

test('能关的地方真的会关：主动性、兴趣、梦', () => {
  assert.match(src('scheduler.js'), /config\?\.drive\?\.enabled === false/)
  assert.match(src('scheduler.js'), /config\?\.interest\?\.enabled !== false/)
  assert.match(src('dream.js'), /config\?\.dream\?\.enabled === false/)
})
