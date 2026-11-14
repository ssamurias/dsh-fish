/**
 * enc-restore-route.test.mjs —— 「从备份恢复」直接吃下加密过的那份（2026-11-14，用户 m03675）
 *
 * 用户在 m03675 里把要求说到底了：绝大多数人是去网盘客户端把文件下载到随便哪个目录，
 * 再拿插件的恢复按钮去导入。所以导入按钮必须自己认 `.enc` 并解开——
 * 「从云端那一栏取回来」那条路解决不了这个问题。
 *
 * 这里测的是接口那一半，端到端走真的加解密：
 *   1. 拿一份真的备份 → 加密 → POST /backup/restore/enc → 数据真的被还原
 *   2. 没带口令、本机也没存口令 → 400，且那句人话里能看出是口令的事
 *   3. 口令错 → 400，档一个都没动
 *   4. 传一个普通 json 上来 → 400，并告诉人该走哪颗按钮
 *   5. 传一堆不是备份的字节 → 400，不是 500
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { registerObserve } from '../lib/observe.js'
import { collectBackup } from '../lib/backup.js'
import { encryptBuffer, writePass } from '../lib/cloudcrypto.js'

/** 造一个最小但合法的数据文件夹。 */
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'fish-enc-route-'))
  writeFileSync(join(root, 'events.jsonl'), JSON.stringify({
    v: 1, type: 'utterance', seq: 1, ts: '2026-11-14T00:00:00.000Z', data: { text: '原来是这一句' },
  }) + '\n')
  writeFileSync(join(root, 'config.json'), '{}\n')
  writeFileSync(join(root, 'owner.json'), '{"mid":"1"}\n')
  return root
}

function harness(root) {
  const routes = new Map()
  const ctx = {
    get(name) {
      if (name === 'connection') return { requestRejection: () => null }
      if (name === 'webServer') {
        return { register(ex) { routes.set(ex.path, ex.handler); return () => {} } }
      }
      return undefined
    },
  }
  registerObserve(ctx, { root })
  const handler = routes.get('/dsh-fish/backup/restore/enc')
  assert.ok(handler, '加密恢复那条路由要注册上')

  async function post(bytes, { headers = {}, query = '' } = {}) {
    const req = Object.assign(Readable.from([Buffer.from(bytes)]), {
      method: 'POST',
      url: '/dsh-fish/backup/restore/enc' + query,
      headers,
    })
    let status = 0
    let text = ''
    const res = {
      writableEnded: false,
      writeHead(code) { status = code },
      end(chunk) { text = String(chunk ?? ''); res.writableEnded = true },
    }
    await handler(req, res)
    return { status, json: text ? JSON.parse(text) : null }
  }
  return { post }
}

/** 拿一份真备份，加密成 `.json.enc` 的样子。 */
async function encBundleOf(root, pass) {
  const b = await collectBackup(root, { now: new Date('2026-11-14T03:00:00.000Z') })
  const text = JSON.stringify({ ...b, fileName: '大肥鱼-20261114-0300.json' })
  return encryptBuffer(Buffer.from(text, 'utf8'), pass)
}

test('加密包传进来：解开、还原、回执照实说（端到端，真加解密）', async () => {
  const root = makeRoot()
  try {
    const pass = 'a-good-pass-123'
    const enc = await encBundleOf(root, pass)
    // 先改掉事件流，证明后面真的是从包里还原回去的
    writeFileSync(join(root, 'events.jsonl'), '')
    const { post } = harness(root)
    const r = await post(enc, { headers: { 'x-fish-pass': encodeURIComponent(pass) } })
    assert.equal(r.status, 200, JSON.stringify(r.json))
    assert.equal(r.json.ok, true)
    assert.equal(r.json.restored, 3, 'events/config/owner 三个文件都该回去')
    assert.match(readFileSync(join(root, 'events.jsonl'), 'utf8'), /原来是这一句/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('本机存过口令时，界面不用再传一遍也能解开', async () => {
  const root = makeRoot()
  try {
    const pass = 'stored-on-this-machine'
    await writePass(root, pass)
    const enc = await encBundleOf(root, pass)
    writeFileSync(join(root, 'events.jsonl'), '')
    const { post } = harness(root)
    const r = await post(enc)
    assert.equal(r.status, 200, JSON.stringify(r.json))
    assert.match(readFileSync(join(root, 'events.jsonl'), 'utf8'), /原来是这一句/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('口令不对：挡住、说人话，而且现有的档一个都没动', async () => {
  const root = makeRoot()
  try {
    const enc = await encBundleOf(root, 'the-right-one-123')
    const before = readFileSync(join(root, 'events.jsonl'), 'utf8')
    const { post } = harness(root)
    const r = await post(enc, { headers: { 'x-fish-pass': encodeURIComponent('the-wrong-one-123') } })
    assert.equal(r.status, 400)
    assert.match(String(r.json.error), /解不开|口令/)
    assert.equal(readFileSync(join(root, 'events.jsonl'), 'utf8'), before, '解不开就该什么都不做')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('传上来的是普通 json：不装作解不开，直接说该走哪条路', async () => {
  const root = makeRoot()
  try {
    const b = await collectBackup(root, { now: new Date('2026-11-14T03:00:00.000Z') })
    const { post } = harness(root)
    const r = await post(Buffer.from(JSON.stringify(b), 'utf8'))
    assert.equal(r.status, 400)
    assert.match(String(r.json.error), /没加密/)
    assert.match(String(r.json.error), /从备份恢复/, '要指回那颗不用口令的按钮')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('一堆不相干的字节：400 说清楚，不是 500 也不是空回', async () => {
  const root = makeRoot()
  try {
    const { post } = harness(root)
    const r = await post(Buffer.from('这是一张图片吧，也许', 'utf8'))
    assert.equal(r.status, 400)
    assert.ok(r.json.error, '要有话说')
    assert.doesNotMatch(String(r.json.error), /undefined|null/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('空的请求体：说没收到内容，不要崩', async () => {
  const root = makeRoot()
  try {
    const { post } = harness(root)
    const r = await post(Buffer.alloc(0))
    assert.equal(r.status, 400)
    assert.match(String(r.json.error), /没收到/)
    assert.ok(existsSync(join(root, 'events.jsonl')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
