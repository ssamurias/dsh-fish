/**
 * clouddrive.test.mjs —— 仓库驱动的写入口（2026-11-16，issue #145）
 *
 * 钉住的是一条很容易再犯的边界：**新建与更新不是同一个 HTTP 方法**。
 *   - Gitee：新建 POST、更新 PUT。之前一律 PUT，空仓库第一份备份必 400「sha is missing」；
 *     而「测一下」只读，所以测得出连得上、测不出写不进去。
 *   - GitHub：两种写法都认，保持 PUT，不要为了修 Gitee 把它改了。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { git } from '../lib/clouddrive.js'

const NAME = '大肥鱼-自动-20260101-000000.json'

function mockFetch(handler) {
  const calls = []
  const prev = globalThis.fetch
  globalThis.fetch = async (url, opts = {}) => {
    const call = {
      url: String(url),
      method: String(opts.method || 'GET').toUpperCase(),
      body: opts.body ? String(opts.body) : '',
      headers: opts.headers ?? {},
    }
    calls.push(call)
    const out = handler(call) ?? {}
    const ok = out.ok !== false
    return {
      ok,
      status: out.status ?? (ok ? 200 : 404),
      text: async () => out.text ?? (out.json ? JSON.stringify(out.json) : ''),
      arrayBuffer: async () => new Uint8Array(0),
    }
  }
  return { calls, restore: () => { globalThis.fetch = prev } }
}

const gitee = { kind: 'git', repo: 'gitee.com/me/repo', token: 'tok', branch: 'main' }
const github = { kind: 'git', repo: 'me/repo', token: 'tok', branch: 'main' }

test('Gitee 新建文件走 POST，不带 sha（issue #145）', async () => {
  const m = mockFetch((c) => {
    if (c.method === 'GET') return { ok: false, status: 404, text: 'not found' }
    return { json: { content: { html_url: 'https://gitee.com/me/repo/blob/main/x.json' } } }
  })
  try {
    const out = await git.put(gitee, NAME, Buffer.from('{}'))
    const write = m.calls.find((c) => c.method !== 'GET')
    assert.equal(write.method, 'POST')
    const body = JSON.parse(write.body)
    assert.equal('sha' in body, false, '新建不能带 sha')
    assert.equal(body.access_token, 'tok')
    assert.equal(body.branch, 'main')
    assert.equal(out.name, NAME)
  } finally {
    m.restore()
  }
})

test('Gitee 覆盖已有文件仍走 PUT，并带上 sha', async () => {
  const m = mockFetch((c) => {
    if (c.method === 'GET') return { json: { sha: 'abc123' } }
    return { json: { content: { html_url: 'https://gitee.com/me/repo/blob/main/x.json' } } }
  })
  try {
    await git.put(gitee, NAME, Buffer.from('{}'))
    const write = m.calls.find((c) => c.method !== 'GET')
    assert.equal(write.method, 'PUT')
    assert.equal(JSON.parse(write.body).sha, 'abc123')
  } finally {
    m.restore()
  }
})

test('GitHub 新建文件仍是 PUT（不要为了 Gitee 改坏它）', async () => {
  const m = mockFetch((c) => {
    if (c.method === 'GET') return { ok: false, status: 404, text: 'not found' }
    return { json: { content: { html_url: 'https://github.com/me/repo/blob/main/x.json' } } }
  })
  try {
    await git.put(github, NAME, Buffer.from('{}'))
    const write = m.calls.find((c) => c.method !== 'GET')
    assert.equal(write.method, 'PUT')
    assert.equal('sha' in JSON.parse(write.body), false)
  } finally {
    m.restore()
  }
})
