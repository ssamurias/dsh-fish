/**
 * 内置说明的第三个出口：一个只在本机回环上的小 HTTP 服务（2026-11-16 用户 m03816）。
 *
 * 为什么要有它。用户要的是「在设置页点一个蓝链，浏览器自动打开那份说明」。
 * 前两次尝试都撞在宿主上：
 *   · 链到插件自己的路由（/dsh-fish/wiki）——桌面版 setWindowOpenHandler 对任何
 *     http(s) 都是 openExternal + deny，链接被甩进系统浏览器；而信任栅栏要的 cookie
 *     是「按本次启动 secret 签名」的，只有 App 自己的 webContents 带着，浏览器里必然 401。
 *   · 链到 file:// ——同一个 handler 里 file: 既不 openExternal 也不放行，点了没反应。
 *
 * 这一次不一样：目标不是宿主的任何一条路由，而是**我们自己起的**一个服务。
 * 它只监听 127.0.0.1，只认 GET，只吐一份静态 HTML，不经过宿主的信任栅栏，
 * 也就没有那枚签名的 cookie 可谈——浏览器打开它，就像打开任何一个本地小站。
 *
 * 为什么默认端口写死 17321：用户会把这一页留在浏览器里反复看，地址稳定一点更方便；
 * 被占了就退回系统分配的随机端口，UI 那一头永远是现取现显示，不缓存。
 *
 * 为什么校验 Host 头：服务绑在回环上，外部连不进来，但**浏览器里任何一个网页**都能
 * 向 127.0.0.1 发请求（DNS rebinding 就是靠改 Host 把「外部域名」指过来）。
 * Host 必须正好是本服务的地址，否则 403。
 */
import { createServer } from 'node:http'

const HOST = '127.0.0.1'
const DEFAULT_PORT = 17321

// 只有一份：插件重复 apply（cordis 会重新 apply）时不该叠出第二个监听
let STATE = null

function hostOk(raw, port) {
  const h = String(raw || '').trim().toLowerCase()
  return h === `${HOST}:${port}` || h === `localhost:${port}`
}

function send(res, code, headers, body) {
  res.writeHead(code, headers)
  res.end(body)
}

function plain(res, code, text) {
  const body = Buffer.from(text, 'utf8')
  send(res, code, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  }, body)
}

/**
 * 起服务。可重复调用：已经在跑就只把新的 getHtml 换上（重启插件时根目录可能变了）。
 * @param {{getHtml: () => string | Promise<string>, port?: number}} opts
 */
export function startWikiServer(opts = {}) {
  const getHtml = typeof opts.getHtml === 'function' ? opts.getHtml : () => '<!doctype html><meta charset="utf-8"><p>说明还没准备好。</p>'
  if (STATE) {
    STATE.getHtml = getHtml
    return api(STATE)
  }

  const st = { getHtml, port: 0, url: '', server: null, triedFallback: false }

  const server = createServer(async (req, res) => {
    // 只读：别的一律不接。省得以后有人顺手在这儿加个 POST 就成了写入面。
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      plain(res, 405, '只读。')
      return
    }
    if (!hostOk(req.headers.host, st.port)) {
      plain(res, 403, '不认这个地址。')
      return
    }
    let path = '/'
    try { path = new URL(req.url || '/', 'http://127.0.0.1').pathname } catch { path = '/' }
    if (path !== '/' && path !== '/wiki' && path !== '/wiki.html') {
      plain(res, 404, '没有这一页。')
      return
    }
    let html = ''
    try {
      html = await st.getHtml()
    } catch (err) {
      plain(res, 500, `这份说明没读出来：${err?.message ?? err}`)
      return
    }
    const body = Buffer.from(String(html), 'utf8')
    send(res, 200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': body.length,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    }, req.method === 'HEAD' ? undefined : body)
  })
  st.server = server

  // 端口被占不算错：退回随机端口，地址照样能点。
  server.on('error', (err) => {
    if (err?.code === 'EADDRINUSE' && !st.triedFallback) {
      st.triedFallback = true
      try { server.listen(0, HOST) } catch { /* 下一层还有 error 事件 */ }
      return
    }
    console.warn('[dsh-fish] 说明服务起不来', err?.message ?? err)
  })
  server.on('listening', () => {
    const addr = server.address()
    st.port = typeof addr === 'object' && addr ? addr.port : 0
    st.url = `http://${HOST}:${st.port}/`
  })
  server.unref?.()

  const wanted = Number.isInteger(opts.port) && opts.port >= 0 ? opts.port : DEFAULT_PORT
  try { server.listen(wanted, HOST) } catch (err) {
    console.warn('[dsh-fish] 说明服务起不来', err?.message ?? err)
  }

  STATE = st
  return api(st)
}

function api(st) {
  return {
    /** 起来之前是空串。UI 那一头拿到空串就显示「正在准备」。 */
    get url() { return st.url },
    get port() { return st.port },
    close() {
      if (STATE === st) STATE = null
      try { st.server?.close() } catch { /* 已经关了 */ }
      st.url = ''
    },
  }
}

/** 给 /wiki.data 用：现取，不缓存。 */
export function wikiUrl() {
  return STATE?.url || ''
}

/** 停用/卸载时收干净。 */
export function closeWikiServer() {
  const st = STATE
  STATE = null
  if (!st) return
  try { st.server?.close() } catch { /* 已经关了 */ }
  st.url = ''
}

export const WIKI_PORT = DEFAULT_PORT
