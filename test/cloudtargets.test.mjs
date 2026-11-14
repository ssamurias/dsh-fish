/**
 * cloudtargets.test.mjs —— 云端备份的目标形状（2026-11-14，用户 m01090）
 *
 * 为什么要有：
 *   ① 上一版吃过的亏：界面加了字段、后端白名单没登记（1.0.2 那次 backup 组），
 *      结果是「点了没反应」。这一版把字段表做成唯一真源，就得钉住「加字段只改一处」。
 *   ② 配置里躺着的是用户自己的账号密码。两件事必须有明确答案：
 *      读出来给界面的时候密码不出现；存回去的时候留空＝不改（不是清掉）。
 *   ③ 认不出的 kind 要整条丢掉，而不是留一条永远「不能用」的空壳占着列表。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  KINDS,
  KIND_ORDER,
  kindInfo,
  kindLabel,
  kindsDoc,
  mergeTargetSecrets,
  normTarget,
  normTargets,
  publicTarget,
  targetBlurb,
  targetProblem,
} from '../lib/cloudtargets.js'

test('六种目标都在，顺序固定（界面下拉按它排）', () => {
  assert.deepEqual(KIND_ORDER, ['folder', 'git', 'webdav', 'smtp', 'http', 'command'])
  for (const k of KIND_ORDER) {
    assert.ok(KINDS[k], `缺了 ${k}`)
    assert.equal(typeof KINDS[k].label, 'string')
    assert.ok(KINDS[k].label.length > 0)
    assert.ok(Array.isArray(KINDS[k].fields) && KINDS[k].fields.length > 0)
    assert.equal(kindInfo(k), KINDS[k])
    // kindLabel 是短名（列表里那一列），label 是整句（草稿标题里用）。
    assert.equal(kindLabel(k), KINDS[k].short ?? KINDS[k].label)
  }
  assert.equal(kindInfo('nope'), null)
})

test('kindsDoc 给界面的那一份：六条、每条带 kind，不许漏字段表', () => {
  const doc = kindsDoc()
  assert.equal(doc.length, 6)
  assert.deepEqual(doc.map((d) => d.kind), KIND_ORDER)
  const folder = doc.find((d) => d.kind === 'folder')
  assert.equal(folder.fields[0].key, 'dir')
  assert.equal(folder.fields[0].required, true)
})

test('密码字段在 KINDS 里被标成 pass：改这一处，界面和后端就都跟着变', () => {
  const passKeys = (k) => KINDS[k].fields.filter((f) => f.type === 'pass').map((f) => f.key)
  assert.deepEqual(passKeys('git'), ['token'])
  assert.deepEqual(passKeys('webdav'), ['pass'])
  assert.deepEqual(passKeys('smtp'), ['pass'])
  assert.deepEqual(passKeys('folder'), [])
  assert.deepEqual(passKeys('http'), [])
  assert.deepEqual(passKeys('command'), [])
})

test('空目标也能规整出形状，只是 ready:false 并说清缺什么', () => {
  const t = normTarget({ kind: 'git' }, 0)
  assert.equal(t.kind, 'git')
  assert.equal(t.enabled, true)
  assert.equal(t.ready, false)
  assert.ok(t.missing.includes('仓库'))
  assert.ok(t.missing.includes('访问令牌'))
  assert.equal(targetProblem(t), `还差：${t.missing.join('、')}`)
})

test('必填齐了就 ready，problem 是空串', () => {
  const t = normTarget({ kind: 'webdav', url: 'https://dav.jianguoyun.com/dav/', user: 'a@b.c', pass: 'app-pass' }, 0)
  assert.equal(t.ready, true)
  assert.deepEqual(t.missing, [])
  assert.equal(targetProblem(t), '')
})

test('认不出的 kind：整条丢掉，不留空壳', () => {
  assert.equal(normTarget({ kind: 's3' }, 0), null)
  assert.equal(normTarget(null, 0), null)
  assert.equal(normTarget('x', 0), null)
  assert.equal(targetProblem(null), '这个目标不完整。')
  assert.equal(targetProblem({ kind: 's3' }), '不认识这种目标。')
})

test('id：没给就按位置起名，撞了加后缀（否则「删第二个」会删到第一个）', () => {
  const list = normTargets([
    { kind: 'folder', dir: 'D:\\a' },
    { kind: 'folder', dir: 'D:\\b' },
    { kind: 'folder', dir: 'D:\\c', id: 't1' },
  ])
  assert.equal(list.length, 3)
  assert.equal(list[0].id, 't1')
  assert.equal(list[1].id, 't2')
  assert.equal(list[2].id, 't12', 'id 撞了要改成不重复的')
  assert.equal(new Set(list.map((t) => t.id)).size, 3)
})

test('最多 12 条：再多就不收（配置不该被撑大）', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ kind: 'folder', dir: `D:\\${i}` }))
  assert.equal(normTargets(many).length, 12)
  assert.deepEqual(normTargets(null), [])
  assert.deepEqual(normTargets('x'), [])
})

test('数字字段夹在上下限里；布尔字段按默认值补齐', () => {
  const lo = normTarget({ kind: 'smtp', host: 'h', user: 'u', pass: 'p', to: 't', port: -5 }, 0)
  assert.equal(lo.port, 1)
  const hi = normTarget({ kind: 'smtp', host: 'h', user: 'u', pass: 'p', to: 't', port: 999999 }, 0)
  assert.equal(hi.port, 65535)
  const dflt = normTarget({ kind: 'smtp', host: 'h', user: 'u', pass: 'p', to: 't' }, 0)
  assert.equal(dflt.port, 465)
  const hb = normTarget({ kind: 'http', url: 'https://x' }, 0)
  assert.equal(hb.bodyFile, true)
  assert.equal(hb.method, 'PUT')
})

test('name：没填就用「文件夹 / 仓库 / 邮箱」这种短名', () => {
  assert.equal(normTarget({ kind: 'git', repo: 'a/b', token: 't' }, 0).name, '仓库')
  assert.equal(normTarget({ kind: 'smtp', host: 'h', user: 'u', pass: 'p', to: 't' }, 0).name, '邮箱')
  assert.equal(normTarget({ kind: 'smtp', host: 'h', user: 'u', pass: 'p', to: 't', name: '  我的邮箱  ' }, 0).name, '我的邮箱')
})

test('发给界面的那一份：密码不回显，只回「填过没有」', () => {
  const t = normTarget({ kind: 'git', repo: 'a/b', token: 'ghp_secret', api: '', branch: 'main' }, 0)
  const pub = publicTarget(t)
  assert.equal(pub.token, '', '密码被回显给界面了')
  assert.equal(pub.filled.token, true)
  assert.equal(pub.repo, 'a/b')
  assert.equal(pub.branch, 'main')
  assert.equal(JSON.stringify(pub).includes('ghp_secret'), false, '密码出现在了发给界面的 JSON 里')

  const empty = publicTarget(normTarget({ kind: 'git', repo: 'a/b' }, 0))
  assert.equal(empty.filled.token, false)
})

test('存回去的时候密码留空＝不改，不是清掉', () => {
  const old = normTarget({ kind: 'git', repo: 'a/b', token: 'ghp_secret' }, 0)
  const next = { kind: 'git', id: old.id, repo: 'a/b2', token: '' }
  const merged = mergeTargetSecrets(next, old)
  assert.equal(merged.token, 'ghp_secret')
  assert.equal(merged.repo, 'a/b2')
})

test('存回去时填了新密码＝覆盖', () => {
  const old = normTarget({ kind: 'webdav', url: 'u', user: 'n', pass: 'old-pass' }, 0)
  const merged = mergeTargetSecrets({ kind: 'webdav', pass: 'new-pass' }, old)
  assert.equal(merged.pass, 'new-pass')
})

test('kind 变了就不合并密码（不同种类的密码框含义不同）', () => {
  const old = normTarget({ kind: 'git', repo: 'a/b', token: 'ghp_secret' }, 0)
  const merged = mergeTargetSecrets({ kind: 'webdav', pass: '' }, old)
  assert.equal(merged.pass, '')
  assert.equal(merged.token, undefined)
})

test('mergeTargetSecrets 遇到空的一头不炸', () => {
  assert.equal(mergeTargetSecrets(null, null), null)
  assert.deepEqual(mergeTargetSecrets({ kind: 'git' }, null), { kind: 'git' })
})

test('targetBlurb 给的是那一段「怎么弄」的说明；没有就空串', () => {
  assert.match(targetBlurb({ kind: 'webdav' }), /应用密码/)
  assert.equal(targetBlurb({ kind: 'nope' }), '')
  assert.equal(targetBlurb(null), '')
})

test('folder 的 dir 前后空格会被剪掉（用户从资源管理器复制常带空格）', () => {
  const t = normTarget({ kind: 'folder', dir: '  D:\\我的网盘\\大肥鱼备份  ' }, 0)
  assert.equal(t.dir, 'D:\\我的网盘\\大肥鱼备份')
  assert.equal(t.ready, true)
})
