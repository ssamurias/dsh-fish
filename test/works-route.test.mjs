/**
 * works-route.test.mjs —— 「她留下的东西」那三条 HTTP 接口，端到端跑一遍（1.0.5）。
 *
 * 之前只有库层测试：`makeWork` / `readWorkText` 都对，但界面上「点开一条什么都没有」
 * 恰恰是接口与界面之间的问题。所以这里不测函数，测路由：
 *   1. GET /works → 清单里带 kind，界面上才知道该画<img>还是读文字；
 *   2. POST /works → 读回某一版，图/声音/影像只回 file + 说明，不回二进制；
 *   3. GET /work-file → 把她做出来的那张图原样给出去（content-type、字节都对）；
 *   4. GET /work-file?p=../state.json → 404，不许拿这个口读 works/ 以外的任何东西。
 *
 * 用的是假 ctx + 假 req/res，不碰真实家目录。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { registerObserve } from '../lib/observe.js'
import { makeWork } from '../lib/works.js'

function harness(root, deps = {}) {
  const routes = new Map()
  const ctx = {
    get(name) {
      if (name === 'connection') return { requestRejection: () => null }
      if (name === 'agents') return { get: () => null, list: () => [] }
      if (name === 'webServer') {
        return { register(ex) { routes.set(ex.path, ex.handler); return () => {} } }
      }
      return undefined
    },
  }
  registerObserve(ctx, { root, ...deps })

  async function call(method, path, body) {
    const base = path.split('?')[0]
    const handler = routes.get(`/dsh-fish${base}`)
    assert.ok(handler, `${base} 要注册上`)
    const req = method === 'POST'
      ? Object.assign(Readable.from([Buffer.from(JSON.stringify(body ?? {}), 'utf8')]), { method, headers: {}, url: `/dsh-fish${path}` })
      : Object.assign(Readable.from([]), { method, headers: {}, url: `/dsh-fish${path}` })
    let status = 0
    let headers = {}
    let buf = Buffer.alloc(0)
    const res = {
      writableEnded: false,
      writeHead(code, h) { status = code; headers = h || {} },
      end(chunk) {
        if (Buffer.isBuffer(chunk)) buf = chunk
        else buf = Buffer.from(String(chunk ?? ''), 'utf8')
        res.writableEnded = true
      },
    }
    await handler(req, res)
    const text = buf.toString('utf8')
    let json = null
    try { json = JSON.parse(text) } catch { json = null }
    return { status, headers, buf, text, json }
  }

  return { call }
}

test('作品路由：清单带 kind / 读回给 file 与说明 / 出图只认 works/ 下的文件', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-fish-works-route-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'home'), { recursive: true })
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
  writeFileSync(join(root, 'home', 'lamp.png'), png)
  const made = await makeWork(root, {
    title: '一盏纸灯',
    text: '灯罩这里还太硬。',
    file: join(root, 'home', 'lamp.png'),
    now: new Date(2026, 10, 16, 10).getTime(),
  })
  assert.equal(made.ok, true)

  const { call } = harness(root)

  const list = await call('GET', '/works?limit=5')
  assert.equal(list.status, 200)
  assert.equal(list.json.items[0].kind, 'image', '清单里要知道它是张图')

  const one = await call('POST', '/works', { id: made.id, title: '一盏纸灯' })
  assert.equal(one.status, 200)
  assert.equal(one.json.kind, 'image')
  assert.equal(one.json.file, `works/${made.id}/v1-一盏纸灯.png`)
  assert.equal(one.json.text, '灯罩这里还太硬。', '图版读回来是那句说明，不是二进制')
  assert.ok(one.json.versions.includes(1))

  const img = await call('GET', `/work-file?p=${encodeURIComponent(one.json.file)}`)
  assert.equal(img.status, 200)
  assert.equal(img.headers['content-type'], 'image/png')
  assert.deepEqual(img.buf, png, '字节原样给出去')

  const bad = await call('GET', `/work-file?p=${encodeURIComponent('../state.json')}`)
  assert.equal(bad.status, 404, '不许拿这个口读 works/ 以外的文件')

  const missing = await call('GET', '/work-file?p=works/nope/1.png')
  assert.equal(missing.status, 404)
})

test('作品路由：清单写一行目录；/works-open 只交给服务端算好的目录', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-fish-works-open-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const made = await makeWork(root, { title: '一盏纸灯', text: '先这样。', now: Date.now() })
  assert.equal(made.ok, true)

  // 测试里绝不能真去调 explorer（会弹一堆窗口），所以注入一个记名的假动作。
  const opened = []
  const { call } = harness(root, { openFolder: (dir) => { opened.push(dir); return true } })

  const list = await call('GET', '/works?limit=5')
  assert.equal(list.status, 200)
  assert.ok(list.json.dir.endsWith('works'), `清单里要给作品目录：${list.json.dir}`)

  const one = await call('POST', '/works-open', { p: '../..' })
  assert.equal(one.status, 200)
  assert.equal(one.json.ok, true)
  assert.deepEqual(opened, [list.json.dir], '打开的就是服务端算出来的那个目录，客户端传的路径不算数')

  const bad = await call('GET', '/works-open')
  assert.equal(bad.status, 405, '只认 POST')

  const { call: plain } = harness(root, { openFolder: () => false })
  const fail = await plain('POST', '/works-open', {})
  assert.equal(fail.json.ok, false)
  assert.match(fail.json.error, /打不开文件夹/, '打不开时要直说，别让人以为点坏了')
})
