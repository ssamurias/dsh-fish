/**
 * 桥接投递口：一个只在本机回环上的小 HTTP 服务，专给**外部桥**用（1.0.6）。
 *
 * 为什么需要它。AGENTS.md §7.1 一直写着「桥只走 HTTP，POST /dsh-fish/say」，
 * 但那条件是宿主自己的路由，套着 connection 的信任栅栏：要一枚用**本次启动的
 * secret 签名**的 cookie，而那枚 cookie 是桌面端进程内换出来、只贴在自己窗口的请求上的
 * （app.asar 的 lib/main.js 里 set-cookie 之后 headers.set("cookie", …)），
 * 外部进程根本拿不到。于是「严格照文档做」的桥，每一个请求都拿到 403。
 * 2026-11-19 由一位 QQ 桥用户实测确认（顺手修掉了 401 被压成 403 那个错）。
 *
 * 所以这里跟 lib/wikiserve.js 是同一套思路：**不经过宿主的任何一条路由**，
 * 自己绑在 127.0.0.1 上，文件头写死的那几条边就是全部攻击面：
 *   · 只认本机回环（外网连不进来）；
 *   · 校验 Host 头（挡 DNS rebinding：浏览器里任何一个网页都能向 127.0.0.1 发请求，
 *     rebinding 就是靠把「外部域名」解析过来——Host 不是本服务的地址就 403）；
 *   · 只有两条路：GET /whoami 与 POST /say，其余 404；
 *   · **默认不开启**（config.bridge.port = 0），谁要接桥谁自己填端口。
 *
 * 为什么默认关：项目的一条老规矩是「额外能力谁需要谁自己开，不在底层默认打开」。
 * 一个默认开着的写入端口等于给本机任何程序一个「以他的名义跟她说话」的入口。
 *
 * 端口写死多少：没有写死。说明站（17321）是给人反复打开的页面，地址要稳定；
 * 投递口是桥的配置项，桥自己填，填多少就用多少。被占了就退回系统分配的随机端口，
 * 状态用 bridgeUrl() 现取现显示。
 */
import { createServer } from 'node:http'

const HOST = '127.0.0.1'

// 只有一份：插件重复 apply（cordis 会重新 apply）时不该叠出第二个监听
let STATE = null

function hostOk(raw, port) {
  const h = String(raw || '').trim().toLowerCase()
  return h === `${HOST}:${port}` || h === `localhost:${port}`
}

/**
 * 挡住「浏览器里的网页」这条路（2026-11-19 复查时补的，原来的 Host 校验挡不住它）。
 *
 * Host 校验只管 DNS rebinding（外部域名解析到 127.0.0.1），可一个网页**直接**写
 * `fetch('http://127.0.0.1:PORT/say', {method:'POST', body:'{"text":"…"}'})` 时，
 * Host 就是我们自己的地址，栅栏完全认。而且 `text/plain` 属于 CORS 的「简单请求」，
 * 浏览器连预检都不发，请求直接就落地了——等于任何网页都能以主人的名义让她说话。
 *
 * 所以这里再认三件事，浏览器永远露馅：
 *   · `Origin`：跨域请求浏览器一定会带，本机脚本（Node/Python/Go 的 HTTP 客户端）不会带。
 *     带了一律拒——本服务不提供任何页面，同源场景不存在。
 *   · `Sec-Fetch-Site`：现代浏览器对这个头只读、脚本改不了，cross-site 直接拒。
 *   · 写入类请求必须 `content-type: application/json`：这样一来就算真走到浏览器，
 *     JSON 也是「非简单请求」，预检过不去（我们不应答预检），多一层。
 */
function browserGuard(req) {
  const origin = req.headers.origin
  if (origin !== undefined) return { code: 403, text: '这个口子不收浏览器发来的请求。' }
  const site = String(req.headers['sec-fetch-site'] || '').toLowerCase()
  if (site === 'cross-site' || site === 'same-site') return { code: 403, text: '这个口子不收浏览器发来的请求。' }
  return null
}

/** 写入类请求（POST/PUT/PATCH/DELETE）必须声明 JSON——不给浏览器留「简单请求」的缝。 */
function needsJson(req) {
  const m = String(req.method || 'GET').toUpperCase()
  if (m === 'GET' || m === 'HEAD') return null
  const ct = String(req.headers['content-type'] || '').toLowerCase()
  if (ct.includes('json')) return null
  return { code: 415, text: '这个口子只收 application/json。' }
}

function sendJson(res, code, obj) {
  if (res.writableEnded) return
  const body = JSON.stringify(obj, null, 2)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function plain(res, code, text) {
  const body = Buffer.from(text, 'utf8')
  res.writeHead(code, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * 起投递口。可重复调用：已经在跑就只把新的 handlers 换上（重启插件时根目录可能变了）。
 *
 * @param {{handlers?: Record<string, (req: any, res: any) => Promise<void> | void>, port?: number, log?: (...a: any[]) => void}} opts
 *        handlers 的键是路径（'/say' / '/whoami'），值是**没套 trusted 栅栏的**原始处理函数——
 *        业务逻辑全在 observe.js 里，这份文件只管「谁能连进来、路径对不对、别的方法怎么回」。
 */
export function startBridgeServer(opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : (...a) => console.log('[dsh-fish]', ...a)
  const handlers = opts.handlers && typeof opts.handlers === 'object' ? opts.handlers : {}
  if (STATE) {
    STATE.handlers = handlers
    return api(STATE)
  }

  const st = { handlers, port: 0, url: '', server: null, triedFallback: false }

  const server = createServer(async (req, res) => {
    if (!hostOk(req.headers.host, st.port)) {
      plain(res, 403, '不认这个地址。')
      return
    }
    const guard = browserGuard(req)
    if (guard) {
      plain(res, guard.code, guard.text)
      return
    }
    const media = needsJson(req)
    if (media) {
      plain(res, media.code, media.text)
      return
    }
    let path = '/'
    try { path = new URL(req.url || '/', 'http://127.0.0.1').pathname } catch { path = '/' }
    if (path === '/' || path === '/whoami') path = '/whoami'
    const fn = st.handlers[path]
    if (typeof fn !== 'function') {
      plain(res, 404, '没有这一页。')
      return
    }
    // 方法的判断留给 handler 自己做（与宿主内那两条路由共用同一份代码，
    // 两处各判一次迟早会分叉——405 的正文在 observe.js 里）。
    try {
      await fn(req, res)
    } catch (err) {
      if (err?.statusCode === 413) return sendJson(res, 413, { error: 'body too large' })
      log('桥接投递口出了个错', err?.message ?? err)
      if (!res.writableEnded) sendJson(res, err?.statusCode ?? 500, { error: String(err?.message ?? err) })
    }
  })
  st.server = server

  // 端口被占不算错：退回随机端口，桥那边从设置页读现取的地址。
  server.on('error', (err) => {
    if (err?.code === 'EADDRINUSE' && !st.triedFallback) {
      st.triedFallback = true
      try { server.listen(0, HOST) } catch { /* 下一层还有 error 事件 */ }
      return
    }
    log('桥接投递口起不来', err?.message ?? err)
  })
  server.on('listening', () => {
    const addr = server.address()
    st.port = typeof addr === 'object' && addr ? addr.port : 0
    st.url = `http://${HOST}:${st.port}`
  })
  server.unref?.()

  const wanted = Number.isInteger(opts.port) && opts.port > 0 ? opts.port : 0
  if (wanted) {
    try { server.listen(wanted, HOST) } catch (err) {
      log('桥接投递口起不来', err?.message ?? err)
    }
  }

  STATE = st
  return api(st)
}

function api(st) {
  return {
    /** 起来之前是空串。设置页拿到空串就显示「没开」。 */
    get url() { return st.url },
    get port() { return st.port },
    close() {
      if (STATE === st) STATE = null
      try { st.server?.close() } catch { /* 已经关了 */ }
      st.url = ''
    },
  }
}

/** 给设置页用：现取，不缓存。 */
export function bridgeUrl() {
  return STATE?.url || ''
}

/** 停用/卸载、或者用户把端口改回 0 时收干净。 */
export function closeBridgeServer() {
  const st = STATE
  STATE = null
  if (!st) return
  try { st.server?.close() } catch { /* 已经关了 */ }
  st.url = ''
}
