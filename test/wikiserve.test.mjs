/**
 * 说明小站（lib/wikiserve.js）的守卫。
 *
 * 这一份只测服务本身的边：绑在回环上、只认 GET、认 Host、只吐那一页、出错给一句话。
 * 「能不能被浏览器打开」这件事测不了（那要靠 Electron 的 openExternal），
 * 能测的是「它确实是一个别人能直连的 http 服务」，而这一点正是它唯一的价值。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { startWikiServer, closeWikiServer, wikiUrl, WIKI_PORT } from '../lib/wikiserve.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function up(opts) {
  const st = startWikiServer(opts)
  for (let i = 0; i < 200 && !st.url; i++) await sleep(10)
  assert.ok(st.url, '服务必须在 2 秒内起来')
  return st
}

/** 拿一个能指定 Host 头的最小请求器：fetch 不让改 Host。 */
function get(url, { method = 'GET', host } = {}) {
  const u = new URL(url)
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method,
      headers: host ? { host } : {},
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end()
  })
}

test('默认端口是个固定的回环地址，不是随便挑的', () => {
  assert.equal(WIKI_PORT, 17321, '写在文件头里的那个数，用户会把这一页留在浏览器里')
})

test('起来之后：/ 与 /wiki 都吐那一页，头部不缓存', async () => {
  const st = await up({ port: 0, getHtml: () => '<!doctype html><p>说明正文</p>' })
  const r = await get(st.url)
  assert.equal(r.status, 200)
  assert.match(r.headers['content-type'], /text\/html; charset=utf-8/)
  assert.equal(r.headers['cache-control'], 'no-store', '每次现渲染，不能被缓存钉住')
  assert.match(r.body, /说明正文/)
  assert.ok(st.url.startsWith('http://127.0.0.1:'), '绑定的是回环，不是 0.0.0.0')
  const w = await get(new URL('/wiki', st.url).href)
  assert.equal(w.status, 200)
  assert.equal(wikiUrl(), st.url, 'wikiUrl() 给的就是同一个地址（/wiki.data 从这里取）')
  closeWikiServer()
  assert.equal(wikiUrl(), '', '停掉之后不该还留着一个能点的地址')
})

test('只读：POST/PUT 一律 405，不给写入面留门', async () => {
  const st = await up({ port: 0, getHtml: () => 'x' })
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const r = await get(st.url, { method })
    assert.equal(r.status, 405, `${method} 不该被接`)
  }
  closeWikiServer()
})

test('Host 头不对就 403：挡的是 DNS rebinding，不是「防外人」', async () => {
  const st = await up({ port: 0, getHtml: () => 'x' })
  const bad = await get(st.url, { host: 'evil.example.com' })
  assert.equal(bad.status, 403)
  const good = await get(st.url, { host: `localhost:${st.port}` })
  assert.equal(good.status, 200, 'localhost 与 127.0.0.1 都算自己')
  closeWikiServer()
})

test('别的路径 404；渲染炸了给 500 和一句人话', async () => {
  const st = await up({ port: 0, getHtml: () => 'x' })
  const nf = await get(new URL('/dsh-fish/wiki', st.url).href)
  assert.equal(nf.status, 404)
  closeWikiServer()

  const boom = await up({ port: 0, getHtml: () => { throw new Error('读不到数据') } })
  const r = await get(boom.url)
  assert.equal(r.status, 500)
  assert.match(r.body, /读不到数据/, '错在哪儿要写出来，不要只剩一个 500')
  closeWikiServer()
})

test('重复启动不会叠出第二个监听：换掉的只是 getHtml', async () => {
  const a = await up({ port: 0, getHtml: () => '第一版' })
  const b = startWikiServer({ getHtml: () => '第二版' })
  assert.equal(b.port, a.port, '同一个服务，不是新开一个')
  assert.equal((await get(a.url)).body, '第二版', '新的渲染函数要立刻生效（重启插件后根目录可能变了）')
  closeWikiServer()
})
