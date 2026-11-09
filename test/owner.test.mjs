/**
 * owner.test.mjs —— 2026-10-23 加的第三批：隐私红线 / 艾特主人 / cookie 设置
 *
 * 守四件事：
 *   1. **红线是代码级的**：路径、状态库文件名、凭据、账号数字、手机号、邮箱
 *      一律不进公开评论。不是"提示词里嘱咐过"。
 *   2. **cookie 只上行不下行**：接口和界面都拿不到原文，只拿得到"有没有"。
 *   3. **只存 B 站要的几个键**：别把整段浏览器 cookies 搬进来。
 *   4. **@ 只在有昵称时才加**：空的 @ 只是一串没人认领的字符。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { looksLikeLeak, screenOutgoing } from '../lib/guard.js'
import { parseCookieInput, mentionPrefix, publicOwner, saveOwner, saveAccount } from '../lib/owner.js'
import { normalizeCookie } from '../lib/bili.js'
import { readOwner } from '../lib/store.js'
import { registerObserve } from '../lib/observe.js'
import { loginMid } from '../lib/comment.js'

test('隐私红线：本机路径与状态库文件名一律拦下', () => {
  for (const s of [
    '我把东西放在 D:\\work\\my-project 里',
    'C:/Users/someone/.dsh-fish/home',
    '你看 ~/.dsh-fish/events.jsonl',
    '我住在 /Users/someone/Desktop',
    '我的 AGENTS.md 里写了',
    'config.json 里有',
    '\\\\nas\\share\\x',
  ]) {
    assert.equal(looksLikeLeak(s).hit, true, `应拦下：${s}`)
  }
})

test('隐私红线：凭据、账号数字、手机、邮箱一律拦下', () => {
  for (const s of [
    'SESSDATA=abc123',
    'cookie 是 xxx',
    'uid: 12345678',
    '我的手机 13812345678',
    '给我发邮件 a.b@c.com',
    '我们私聊说',
    '我跟你说的那些',
  ]) {
    assert.equal(looksLikeLeak(s).hit, true, `应拦下：${s}`)
  }
})

test('隐私红线不误杀正常说话', () => {
  for (const s of [
    '这个视频里的二舅让我想了很久。',
    '他们都说这条路走不通，可我觉得不一定是。',
    '今天看了四个视频，三个都在讲以前的事。',
    '我不太确定。等我哪天被讲出来的时候，会不会也是别人的版本。',
    '2026 年了我还是没想明白。',
  ]) {
    assert.equal(looksLikeLeak(s).hit, false, `不该拦：${s}`)
  }
})

test('screenOutgoing 把隐私命中单独标成 leak（与凭据区分）', () => {
  assert.equal(screenOutgoing('C:\\Users\\someone\\x.txt').why, 'leak')
  assert.equal(screenOutgoing('SESSDATA=abc').why, 'secret')
  assert.equal(screenOutgoing('今天风很大。').ok, true)
})

test('parseCookieInput 认得三种粘贴形态，且只留 B 站要的键', () => {
  const a = parseCookieInput('SESSDATA=s1; bili_jct=j1; _ga=GA1.2.3; buvid3=b1')
  assert.equal(a.cookie, 'SESSDATA=s1; bili_jct=j1; buvid3=b1')
  assert.equal(a.cookie.includes('_ga'), false)
  assert.deepEqual(a.missing, [])

  const b = parseCookieInput('Cookie: SESSDATA=s2; bili_jct=j2; theme=dark')
  assert.equal(b.cookie, 'SESSDATA=s2; bili_jct=j2')

  const c = parseCookieInput(
    ['# Netscape HTTP Cookie File', '#HttpOnly_.bilibili.com\tTRUE\t/\tTRUE\t0\tSESSDATA\ts3', '.bilibili.com\tTRUE\t/\tTRUE\t0\tbili_jct\tj3'].join('\n'),
  )
  assert.equal(c.cookie, 'SESSDATA=s3; bili_jct=j3')

  const direct = normalizeCookie(
    ['# Netscape HTTP Cookie File', '#HttpOnly_.bilibili.com\tTRUE\t/\tTRUE\t0\tSESSDATA\ts4', '.bilibili.com\tTRUE\t/\tTRUE\t0\tbili_jct\tj4'].join('\n'),
  )
  assert.equal(direct, 'SESSDATA=s4; bili_jct=j4', '直接给 B 站客户端的 cookies.txt 也不能丢 HttpOnly 行')
})

test('缺了 bili_jct 要说出来——少了它就看不了也发不了', () => {
  const r = parseCookieInput('SESSDATA=only')
  assert.deepEqual(r.missing, ['bili_jct'])
})

test('mentionPrefix：有昵称才加，昵称里的空格原样留着，关掉就不加', () => {
  assert.equal(mentionPrefix({ nickname: '大肥鱼的主人' }, {}), '@大肥鱼的主人 ')
  // 2026-11-06：原来把空格换成下划线，等于 @ 了一个不存在的昵称（B 站按原文匹配）。
  assert.equal(mentionPrefix({ nickname: 'a b' }, {}), '@a b ')
  assert.equal(mentionPrefix({ nickname: '  空格 前后  ' }, {}), '@空格 前后 ')
  assert.equal(mentionPrefix({ nickname: '' }, {}), '')
  assert.equal(mentionPrefix({}, {}), '')
  assert.equal(mentionPrefix({ nickname: 'x' }, { comment: { atOwner: false } }), '')
})

test('publicOwner 永远不含 cookie 原文，只说有没有', () => {
  const p = publicOwner({ mid: '42', nickname: '我', cookie: 'SESSDATA=s1; bili_jct=j1' })
  assert.equal(p.mid, '42')
  assert.equal(p.name, '我')
  assert.equal(p.hasCookie, true)
  assert.equal(p.hasCsrf, true)
  assert.equal(JSON.stringify(p).includes('SESSDATA'), false)
})

test('saveOwner 落盘 0600，且只存白名单里的键', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-ow-'))
  try {
    const r = await saveOwner({ mid: '42', nickname: '我', cookie: 'SESSDATA=s1; bili_jct=j1; _ga=x' }, root)
    assert.equal(r.ok, true)
    const ow = await readOwner(root)
    assert.equal(ow.cookie, 'SESSDATA=s1; bili_jct=j1')
    const st = await stat(join(root, 'owner.json'))
    // Windows 上 chmod 只影响只读位，允许 0o600 或 0o666 两种结果，但绝不能是 0o644 之外的"谁都能读"语义
    assert.ok((st.mode & 0o777) === 0o600 || (st.mode & 0o777) === 0o666, `mode=${(st.mode & 0o777).toString(8)}`)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('saveOwner 认不出 cookie 时也把 mid / 昵称存下（用户 m00802 反馈 2）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-ow3-'))
  try {
    const r = await saveOwner({ mid: '42', nickname: '大号', cookie: '{"cookies":[1,2]}' }, root)
    assert.equal(r.ok, false)
    assert.match(r.note, /没认出/)
    const ow = await readOwner(root)
    // 关键：不能因为 cookie 解析失败就把整单丢回旧值，否则界面刷新后两格"被顶掉"。
    assert.equal(ow.mid, '42')
    assert.equal(ow.nickname, '大号')
    assert.equal(ow.cookie, undefined)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('saveOwner 传空 cookie 是「清除」，不是「没传」', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-ow2-'))
  try {
    await saveOwner({ cookie: 'SESSDATA=s1; bili_jct=j1' }, root)
    const r = await saveOwner({ cookie: '' }, root)
    assert.equal(r.ok, true)
    const ow = await readOwner(root)
    assert.equal(ow.cookie, undefined)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

// 2026-11-01：设置页多了「清除登录」按钮。只清 cookie 却把 account 留着，界面会显示
// "已存，登录账号：小鱼"——一把已经不存在的钥匙配一个还在的名字，比不显示更糟。
test('清除登录：cookie 和「登录的是谁」一起清，领养人那两格不动', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-ow4-'))
  try {
    await saveOwner({ mid: '999', nickname: '领养人', cookie: 'SESSDATA=s1; bili_jct=j1' }, root)
    await saveAccount({ mid: 42, uname: '小鱼' }, root)
    assert.equal((await readOwner(root)).account.name, '小鱼')

    const r = await saveOwner({ cookie: '' }, root)
    assert.equal(r.ok, true)
    const ow = await readOwner(root)
    assert.equal(ow.cookie, undefined)
    assert.equal(ow.account, undefined, '登录账号也要清掉')
    // 领养人是用户手填的，和「拿哪份 cookie 登录」是两件事
    assert.equal(ow.mid, '999')
    assert.equal(ow.nickname, '领养人')
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

/** 极简假 ctx：只提供 observe 需要的服务 */
function fakeCtx() {
  const routes = []
  const cfg = { connection: null }
  const webServer = { register: (def) => { routes.push(def); return () => {} } }
  return {
    routes,
    cfg,
    get: (k) => (k === 'connection' ? cfg.connection : k === 'webServer' ? webServer : undefined),
    webServer,
    tools: { register: () => {} },
    slots: { inject: () => {}, register: () => {} },
    effect: (fn) => fn(),
    on: () => {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    log: () => {},
  }
}

function callRoute(routes, path, method, body) {
  const def = routes.find((d) => d.path === '/dsh-fish' + path)
  if (!def) throw new Error(`没注册这条路由：${path}`)
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  // readBody 走 EventEmitter（req.on('data'/'end')），所以用 Readable 当请求体
  const req = Readable.from(chunks)
  req.method = method
  req.url = '/dsh-fish' + path
  req.headers = { 'content-type': 'application/json' }
  let out = null
  const res = {
    statusCode: 0,
    ended: false,
    setHeader() {},
    writeHead(n) { this.statusCode = n },
    end(t) { this.ended = true; try { out = JSON.parse(String(t)) } catch { out = String(t) } },
  }
  return def.handler(req, res).then(() => ({ status: res.statusCode, body: out }))
}

test('/owner 路由：GET 只回「有没有 cookie」+ 引导文案，不回原文', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-ow3-'))
  try {
    const ctx = fakeCtx()
    ctx.cfg.connection = { requestRejection: () => null }
    registerObserve(ctx, { root })
    await saveOwner({ mid: '42', nickname: '我', cookie: 'SESSDATA=s1; bili_jct=j1' }, root)
    const r = await callRoute(ctx.routes, '/owner', 'GET')
    assert.equal(r.status, 200)
    assert.equal(r.body.hasCookie, true)
    assert.equal(r.body.mid, '42')
    assert.ok(String(r.body.hint).includes('F12'), '要给出怎么拿 cookie')
    assert.equal(JSON.stringify(r.body).includes('s1'), false, 'cookie 原文不许出现在响应里')
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('/owner 路由：POST 能存 uid 与昵称', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-ow4-'))
  try {
    const ctx = fakeCtx()
    ctx.cfg.connection = { requestRejection: () => null }
    registerObserve(ctx, { root })
    const r = await callRoute(ctx.routes, '/owner', 'POST', { mid: '777', nickname: '主人' })
    assert.equal(r.status, 200)
    const ow = await readOwner(root)
    assert.equal(ow.mid, '777')
    assert.equal(ow.nickname, '主人')
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

// ---- 2026-10-27：领养人与 cookie 账号拆开（owner.mid 是大号，account 是登录的小号） ----

test('publicOwner 带只读登录账号，且仍不含 cookie', () => {
  const p = publicOwner({ mid: '42', nickname: '大号', account: { mid: '9', name: '小号' }, cookie: 'SESSDATA=s1; bili_jct=j1' })
  assert.equal(p.mid, '42')
  assert.deepEqual(p.account, { mid: '9', name: '小号' })
  assert.equal(JSON.stringify(p).includes('SESSDATA'), false)
})

test('publicOwner 没有 account 时给空账号，不报错', () => {
  assert.deepEqual(publicOwner({ mid: '42' }).account, { mid: '', name: '' })
})

test('saveAccount 只记登录账号，不覆盖领养人', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-ow5-'))
  try {
    await saveOwner({ mid: '42', nickname: '大号', cookie: 'SESSDATA=s1; bili_jct=j1' }, root)
    const p = await saveAccount({ mid: 777, uname: '小号' }, root)
    assert.deepEqual(p.account, { mid: '777', name: '小号' })
    const ow = await readOwner(root)
    assert.equal(ow.mid, '42', '领养人 uid 不许被登录账号冲掉')
    assert.equal(ow.nickname, '大号', '领养人昵称不许被登录账号冲掉')
    assert.equal(ow.account.mid, '777')
    assert.equal(ow.account.name, '小号')
    assert.ok(ow.account.savedAt)
    // 反向：改领养人也不动登录账号
    await saveOwner({ nickname: '改个名' }, root)
    assert.equal((await readOwner(root)).account.mid, '777')
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('loginMid：认登录账号；没有账号就认 cookie，都没记时返回 0（issue #63）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-ow6-'))
  try {
    await saveOwner({ mid: '42', nickname: '大号' }, root)
    assert.equal(await loginMid(root), 0, '不能退回领养人——退回就把主人回她的话当成她自己补的丢掉')
    await saveAccount({ mid: 777, uname: '小号' }, root)
    assert.equal(await loginMid(root), 777, '存过账号后，判断「她自己」要用小号')
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
