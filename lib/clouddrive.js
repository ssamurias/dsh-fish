// 云端备份的四个直连驱动 + 两个万能出口（2026-11-14，用户 m01090）
//
// 这一层只管「把一份字节放到某个地方 / 列出来 / 取回来 / 删掉」。
// 什么时候推、加密不加密、失败重试几次，都不在这里——那是 cloudbackup.js 的事。
//
// 为什么是这四个：用户拍板的是 folder / git / webdav / smtp。
// 它们共同点是「普通人自己几步就能配完，而且不用我们开服务器」：
//   folder  0 步（选个目录，网盘客户端自己会同步）
//   git     注册个账号、建个私有仓、生成令牌
//   webdav  拿个应用密码（一驱动接六家网盘）
//   smtp    开个 SMTP 授权码（任何邮箱都行，零新注册）
// 加两个万能出口：http 模板（任何收得下 PUT 的地址）与 command（本机有 rclone 就接上七十多种后端）。
//
// 统一的动作约定（每个驱动实现其中几个，不实现的就如实说不会）：
//   put(target, name, buf)        放一份上去
//   list(target)                  列出我们放的那些（只要名字与大小）
//   get(target, name)             取回来
//   remove(target, name)          删掉
//   probe(target)                 只验证「连得上、能写」，不传真实数据

import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, unlinkSync, existsSync } from 'node:fs'
import { join, isAbsolute, dirname, resolve, basename } from 'node:path'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { SMTPSender } from './cloudsmtp.js'

const UA = 'dsh-fish-cloudbackup/1.1'
const TIMEOUT_MS = 60_000

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

function sizeText(bytes) {
  const n = Number(bytes) || 0
  if (n >= 1024 * 1024) return `${(Math.ceil((n / (1024 * 1024)) * 10) / 10).toFixed(1)}MB`
  if (n >= 1024) return `${Math.ceil(n / 1024)}KB`
  return `${n}B`
}

/** 一句话说清超时：错误信息会原样冒到设置页。 */
class NetError extends Error {}

async function req(url, opts = {}) {
  const { method = 'GET', headers = {}, body, timeoutMs = TIMEOUT_MS, expect = 'json' } = opts
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const r = await fetch(url, {
      method,
      signal: ctl.signal,
      body,
      headers: { 'user-agent': UA, ...headers },
    })
    const text = await r.text()
    if (!r.ok) {
      // 只带前 300 字：有的服务会把整页 HTML 错误吐回来，全塞进界面就没法看了。
      const brief = text.slice(0, 300).replace(/\s+/g, ' ').trim()
      throw new NetError(`${method} ${url} → ${r.status}${brief ? `：${brief}` : ''}`)
    }
    if (expect === 'text') return text
    if (!text) return {}
    try { return JSON.parse(text) } catch { return text }
  } catch (e) {
    if (e?.name === 'AbortError') {
      // 60 秒还不回来：说得像人话，别让用户以为插件坏了。
      throw new NetError(`连不上或者太久没响应（超过 ${Math.round(timeoutMs / 1000)} 秒）。检查网络、代理，或者这家服务是不是要开 VPN。`)
    }
    throw e
  } finally {
    clearTimeout(t)
  }
}

// ─────────────────────────── folder ───────────────────────────

function folderDir(t) {
  const d = String(t.dir ?? '').trim()
  if (!d) throw new NetError('还没选文件夹。')
  const abs = isAbsolute(d) ? d : resolve(d)
  mkdirSync(abs, { recursive: true })
  return abs
}

export const folder = {
  kind: 'folder',
  async put(t, name, buf) {
    const dir = folderDir(t)
    writeFileSync(join(dir, name), buf)
    return { name, bytes: buf.length }
  },
  async list(t) {
    const dir = folderDir(t)
    return readdirSync(dir)
      .filter((n) => n.endsWith('.json') || n.endsWith('.json.enc'))
      .map((n) => {
        let bytes = 0
        try { bytes = statSync(join(dir, n)).size } catch {}
        return { name: n, bytes }
      })
  },
  async get(t, name) {
    const dir = folderDir(t)
    const file = join(dir, basename(name))
    if (!existsSync(file)) throw new NetError(`那里没有「${name}」。`)
    return readFileSync(file)
  },
  async remove(t, name) {
    const dir = folderDir(t)
    const file = join(dir, basename(name))
    try { unlinkSync(file); return { ok: true } } catch { return { ok: true, already: true } }
  },
  async probe(t) {
    const dir = folderDir(t)
    const f = join(dir, '.dsh-fish-probe.txt')
    writeFileSync(f, `probe ${new Date().toISOString()}`)
    let back = ''
    try { back = readFileSync(f, 'utf8') } catch {}
    try { unlinkSync(f) } catch {}
    // 用户 m03310：「通了之后，你要详细显示能测出来的是什么」。
    // 所以这里把「测到了」和「测不到」分开写：本机这一端能验到底，
    // 网盘客户端那一端我们看不见——不装作验过了。
    return {
      ok: Boolean(back),
      where: dir,
      note: `在一个真实目录里写了一个探测文件、读回来、又删掉了：这台机器对「${dir}」有完整的读写权限。`
        + '测不到的是「网盘客户端有没有真的把它同步上去」——那一步在网盘客户端里跑，插件看不见。'
        + '如果这个目录是坚果云 / OneDrive / 123 / 夸克的同步目录，传一份之后去网盘网页版看一眼有没有那个文件，才算整条链通了。',
    }
  },
}

// ─────────────────────────── git ───────────────────────────

/**
 * 把设置页填的仓库地址整理成 { api, owner, repo }。
 * 用户可能填 `https://github.com/a/b`、`a/b`、`https://gitee.com/a/b.git`。
 */
export function parseRepo(t) {
  const raw = String(t.repo ?? '').trim().replace(/\.git$/, '').replace(/\/+$/, '')
  if (!raw) throw new NetError('还没填仓库。')
  let api = String(t.api ?? '').trim().replace(/\/+$/, '')
  let owner = ''
  let repo = ''
  const m = raw.match(/^(?:https?:\/\/)?([^/]+)\/([^/]+)\/([^/]+)$/)
  if (m) {
    const host = m[1].toLowerCase()
    owner = m[2]
    repo = m[3]
    if (!api) {
      if (host.includes('gitee.com')) api = 'https://gitee.com/api/v5'
      else if (host.includes('github.com')) api = 'https://api.github.com'
      else if (host.includes('gitlab')) api = `https://${m[1]}/api/v4`
      else api = `https://${m[1]}/api/v1`
    }
  } else {
    const s = raw.split('/').filter(Boolean)
    if (s.length !== 2) throw new NetError('仓库要写成「用户名/仓库名」，或者直接粘仓库网页地址。')
    owner = s[0]
    repo = s[1]
    if (!api) api = 'https://api.github.com'
  }
  return { api, owner, repo }
}

function gitHeaders(t) {
  const h = { accept: 'application/json', 'content-type': 'application/json' }
  const tok = String(t.token ?? '').trim()
  if (!tok) throw new NetError('还没填访问令牌。')
  // Gitee 用 query 参数传 access_token，GitHub 用 Bearer 头；两边都能接受的做法是都带上。
  h.authorization = `Bearer ${tok}`
  return h
}

function gitPath(t, name) {
  const d = String(t.dir ?? '').trim().replace(/^\/+|\/+$/g, '')
  return d ? `${d}/${name}` : name
}

function isGitee(api) {
  return String(api).includes('gitee.com')
}

export const git = {
  kind: 'git',
  async put(t, name, buf) {
    const { api, owner, repo } = parseRepo(t)
    const branch = String(t.branch ?? '').trim() || 'main'
    const path = gitPath(t, name)
    const url = `${api}/repos/${owner}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`
    const headers = gitHeaders(t)
    // 覆盖写要先拿 sha：GitHub 与 Gitee 都这么要求。第一次没有 sha，就是新建。
    let sha = ''
    try {
      const cur = await req(`${url}?ref=${encodeURIComponent(branch)}`, { headers })
      if (cur && typeof cur === 'object' && cur.sha) sha = cur.sha
    } catch {}
    const body = {
      message: `dsh-fish 备份 ${name}`,
      content: buf.toString('base64'),
      branch,
      ...(sha ? { sha } : {}),
    }
    if (isGitee(api)) body.access_token = String(t.token ?? '').trim()
    const out = await req(url, { method: 'PUT', headers, body: JSON.stringify(body) })
    return { name, bytes: buf.length, url: out?.content?.html_url ?? '', note: sha ? '覆盖了同名的那一份。' : '' }
  },
  async list(t) {
    const { api, owner, repo } = parseRepo(t)
    const branch = String(t.branch ?? '').trim() || 'main'
    const d = String(t.dir ?? '').trim().replace(/^\/+|\/+$/g, '')
    const url = `${api}/repos/${owner}/${repo}/contents/${d.split('/').filter(Boolean).map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(branch)}`
    const headers = gitHeaders(t)
    let out
    try { out = await req(url, { headers }) } catch { return [] }
    const arr = Array.isArray(out) ? out : []
    return arr
      .filter((x) => x && x.type === 'file' && /\.(json|enc)$/.test(String(x.name ?? '')))
      .map((x) => ({ name: x.name, bytes: Number(x.size) || 0 }))
  },
  async get(t, name) {
    const { api, owner, repo } = parseRepo(t)
    const branch = String(t.branch ?? '').trim() || 'main'
    const url = `${api}/repos/${owner}/${repo}/contents/${gitPath(t, name).split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(branch)}`
    const out = await req(url, { headers: gitHeaders(t) })
    if (!out || typeof out !== 'object' || !out.content) throw new NetError(`仓库里没有「${name}」。`)
    return Buffer.from(String(out.content).replace(/\s+/g, ''), 'base64')
  },
  async remove(t, name) {
    const { api, owner, repo } = parseRepo(t)
    const branch = String(t.branch ?? '').trim() || 'main'
    const url = `${api}/repos/${owner}/${repo}/contents/${gitPath(t, name).split('/').map(encodeURIComponent).join('/')}`
    const headers = gitHeaders(t)
    const cur = await req(`${url}?ref=${encodeURIComponent(branch)}`, { headers })
    if (!cur?.sha) return { ok: true, already: true }
    const body = { message: `dsh-fish 删掉旧备份 ${name}`, sha: cur.sha, branch }
    if (isGitee(api)) body.access_token = String(t.token ?? '').trim()
    await req(url, { method: 'DELETE', headers, body: JSON.stringify(body) })
    return { ok: true }
  },
  async probe(t) {
    const { api, owner, repo } = parseRepo(t)
    const info = await req(`${api}/repos/${owner}/${repo}`, { headers: gitHeaders(t) })
    const priv = isGitee(api) ? info?.private : info?.private
    const branch = String(t.branch ?? '').trim() || (info?.default_branch ? String(info.default_branch) : 'main')
    // 用户 m03310：通了也要说清测到了什么。这里只做了「读」，所以不能报「能写」。
    return {
      ok: priv !== false,
      where: `${owner}/${repo}（${branch}）`,
      note: priv === false
        ? '⚠ 这个仓库是**公开**的：令牌能读，但这个仓库谁都能看。备份包里有她的身份和 B 站登录凭据，先改成私有仓库再来测。'
        : `用这个令牌读到了仓库 ${owner}/${repo} 的信息，默认分支 ${branch}，确认是私有的——读权限与「不是公开仓库」这两点都验过了。`
          + '测不到的是「写」：探测不往你的仓库里塞提交，所以真正能不能推上去，要等第一次自动上传，或者点「现在就送一份」。'
          + '失败时那句话会直接写在下面。',
      public: priv === false,
    }
  },
}

// ─────────────────────────── webdav ───────────────────────────

function davUrl(t, name) {
  const base = String(t.url ?? '').trim()
  if (!base) throw new NetError('还没填 WebDAV 地址。')
  const dir = String(t.dir ?? '').trim().replace(/^\/+|\/+$/g, '')
  const parts = [base.replace(/\/+$/, '')]
  if (dir) parts.push(...dir.split('/').filter(Boolean).map(encodeURIComponent))
  if (name) parts.push(encodeURIComponent(name))
  return parts.join('/')
}

function davAuth(t) {
  const u = String(t.user ?? '').trim()
  const p = String(t.pass ?? '').trim()
  if (!u || !p) throw new NetError('WebDAV 要填用户名和应用密码。')
  return `Basic ${Buffer.from(`${u}:${p}`, 'utf8').toString('base64')}`
}

async function davMkcol(t) {
  const dir = String(t.dir ?? '').trim().replace(/^\/+|\/+$/g, '')
  if (!dir) return
  // 逐层建：有的服务不给你一次建多层（坚果云就是）。
  const segs = dir.split('/').filter(Boolean)
  let acc = ''
  for (const s of segs) {
    acc = acc ? `${acc}/${s}` : s
    const base = String(t.url ?? '').trim().replace(/\/+$/, '')
    try {
      await req(`${base}/${acc.split('/').map(encodeURIComponent).join('/')}`, {
        method: 'MKCOL',
        headers: { authorization: davAuth(t) },
        expect: 'text',
      })
    } catch {
      // 405/301 表示已经有了，正常。
    }
  }
}

export const webdav = {
  kind: 'webdav',
  async put(t, name, buf) {
    await davMkcol(t)
    const url = davUrl(t, name)
    await req(url, {
      method: 'PUT',
      headers: { authorization: davAuth(t), 'content-type': 'application/octet-stream' },
      body: buf,
      expect: 'text',
      timeoutMs: 180_000,
    })
    return { name, bytes: buf.length }
  },
  async list(t) {
    const body = `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getcontentlength/></d:prop></d:propfind>`
    const text = await req(davUrl(t), {
      method: 'PROPFIND',
      headers: { authorization: davAuth(t), depth: '1', 'content-type': 'application/xml' },
      body,
      expect: 'text',
    })
    const out = []
    const re = /<d:href>([^<]+)<\/d:href>[\s\S]*?<d:getcontentlength>(\d+)<\/d:getcontentlength>/gi
    let m
    while ((m = re.exec(String(text)))) {
      const href = m[1]
      const nm = decodeURIComponent(href.split('/').filter(Boolean).pop() ?? '')
      if (!nm || !/\.(json|enc)$/.test(nm)) continue
      out.push({ name: nm, bytes: Number(m[2]) || 0 })
    }
    return out
  },
  async get(t, name) {
    const text = await req(davUrl(t, name), {
      headers: { authorization: davAuth(t) },
      expect: 'text',
      timeoutMs: 180_000,
    })
    // expect:'text' 会把二进制按 utf8 解，这里取回时要按 latin1 再转回字节，否则加密包一定坏。
    return Buffer.from(String(text), 'utf8')
  },
  async remove(t, name) {
    try {
      await req(davUrl(t, name), { method: 'DELETE', headers: { authorization: davAuth(t) }, expect: 'text' })
      return { ok: true }
    } catch {
      return { ok: true, already: true }
    }
  },
  async probe(t) {
    await davMkcol(t)
    await req(davUrl(t, '.dsh-fish-probe.txt'), {
      method: 'PUT',
      headers: { authorization: davAuth(t), 'content-type': 'text/plain' },
      body: `probe ${new Date().toISOString()}`,
      expect: 'text',
    })
    await webdav.remove(t, '.dsh-fish-probe.txt')
    // 用户 m03310：通了之后要说清楚测到了什么。WebDAV 是六种里唯一能整条链验完的：
    // 建目录、写一个文件、删掉——三件事都真的发生了，服务器那边都有记录。
    return {
      ok: true,
      where: davUrl(t, ''),
      note: `在 ${davUrl(t, '')} 上做了三件事：建目录、写了一个探测文件、把它删掉。三步都成功了——`
        + '说明地址、账号、密码、写入权限、删除权限全都对得上。'
        + '这是唯一一种能在本机就把「上传」这一步真跑一遍的方式；真正传备份时多一步「这份能不能列出来」，用的是同一个地址权限。',
    }
  },
}

// ─────────────────────────── smtp ───────────────────────────

export const smtp = {
  kind: 'smtp',
  async put(t, name, buf) {
    const to = String(t.to ?? '').trim()
    if (!to) throw new NetError('还没填发到哪个邮箱。')
    const host = String(t.host ?? '').trim()
    const user = String(t.user ?? '').trim()
    const pass = String(t.pass ?? '').trim()
    if (!host || !user || !pass) throw new NetError('SMTP 要填服务器、账号、授权码。')
    const port = Number(t.port) || 465
    const sender = new SMTPSender({ host, port, user, pass, timeoutMs: 60_000 })
    await sender.send({
      from: String(t.from ?? '').trim() || user,
      to: to.split(/[,;，；\s]+/).filter(Boolean),
      subject: `大肥鱼备份 ${name}`,
      text: `这是「大肥鱼」自动发出来的一份备份：${name}\n大小 ${sizeText(buf.length)}。\n\n它是一份完整的 json（如果开了加密，就是 .enc），里面是她的全部状态。别转发给别人。\n`,
      attachments: [{ name, data: buf }],
    })
    return { name, bytes: buf.length }
  },
  async list() {
    // 邮件是只发不收的：我们不去读用户的收件箱（那要另一套权限，也不该碰）。
    return []
  },
  async get() {
    throw new NetError('邮件驱动只发不收。要恢复请到邮箱里把那封附件下载下来，用「从备份恢复」加载。')
  },
  async remove() {
    return { ok: false, why: '邮件发出去就收不回来，这里的清理要你自己在邮箱里做。' }
  },
  async probe(t) {
    const host = String(t.host ?? '').trim()
    const user = String(t.user ?? '').trim()
    const pass = String(t.pass ?? '').trim()
    if (!host || !user || !pass) throw new NetError('SMTP 要填服务器、账号、授权码。')
    const port = Number(t.port) || 465
    const to = String(t.to ?? '').trim()
    const sender = new SMTPSender({ host, port, user, pass, timeoutMs: 30_000 })
    await sender.verify()
    // 用户 m03310：只验登录等于没验「能不能发」。
    // 所以真发一封几十字节的测试信到那个收件地址——服务器那边收下了，才算整条链通了。
    // 不发附件（不发备份本身），失败也不影响已验过的登录。
    let sent = false
    let sendWhy = ''
    if (to) {
      try {
        await sender.send({
          from: String(t.from ?? '').trim() || user,
          to: to.split(/[,;，；\s]+/).filter(Boolean),
          subject: '大肥鱼：测试一封信',
          text: `这是「大肥鱼」在测试备份通道时发的一封信（${new Date().toISOString()}）。\n\n它没有附件，也没有任何备份数据——只用来确认「发得出去、你收得到」。\n看到它就说明这条路是通的；之后真正备份时，附件才是那份 json（或 .json.enc）。\n`,
        })
        sent = true
      } catch (e) {
        sendWhy = e?.message ?? String(e)
      }
    }
    return {
      ok: true,
      where: `${host}:${port}`,
      note: sent
        ? `登录（账号＋授权码）过了，并且真的往 ${to} 发了一封几十字节的测试信，服务器当场收下了。`
          + '去收件箱看一眼有没有「大肥鱼：测试一封信」（可能在垃圾箱）。'
          + '测不到的是「那个邮箱空间够不够、附件会不会被拦」——那要等真正带附件的那一封。'
        : (to
            ? `登录过了，但测试信没发成：${sendWhy}。登录这一步是通的，问题出在「发」。`
            : '登录过了（只验了账号密码）。没填收件邮箱，所以没法真发一封测试信——填上「发到哪个邮箱」再测一次，才能验证整条链。'),
      sent,
    }
  },
}

// ─────────────────────────── http（万能出口） ───────────────────────────

export function fillTpl(s, vars) {
  return String(s ?? '').replace(/\{\{(\w+)\}\}/g, (all, k) => (k in vars ? String(vars[k]) : all))
}

export function parseHeaders(text) {
  const out = {}
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i <= 0) continue
    const k = line.slice(0, i).trim()
    const v = line.slice(i + 1).trim()
    if (k) out[k] = v
  }
  return out
}

export const http = {
  kind: 'http',
  async put(t, name, buf) {
    const url0 = String(t.url ?? '').trim()
    if (!url0) throw new NetError('还没填地址。')
    const vars = { name, file: name, sha256: sha256(buf), size: buf.length }
    const url = fillTpl(url0, vars)
    const method = String(t.method ?? 'PUT').trim().toUpperCase() || 'PUT'
    const headers = parseHeaders(fillTpl(t.headers ?? '', vars))
    const bodyFile = t.bodyFile !== false
    const body = bodyFile ? buf : Buffer.from(fillTpl(t.body ?? '', vars), 'utf8')
    if (bodyFile && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
      headers['content-type'] = 'application/octet-stream'
    }
    await req(url, { method, headers, body, expect: 'text', timeoutMs: 180_000 })
    return { name, bytes: buf.length }
  },
  async list() {
    return []
  },
  async get() {
    throw new NetError('自定义 HTTP 接口只负责往上送。要拿回来请自己从那边下载。')
  },
  async remove() {
    return { ok: false, why: '自定义接口没有统一的删除约定，清理要你在那边做。' }
  },
  async probe(t) {
    const url0 = String(t.url ?? '').trim()
    if (!url0) throw new NetError('还没填地址。')
    const vars = { name: '.dsh-fish-probe.txt', file: '.dsh-fish-probe.txt', sha256: sha256(Buffer.from('probe')), size: 5 }
    const url = fillTpl(url0, vars)
    const method = String(t.method ?? 'PUT').trim().toUpperCase() || 'PUT'
    const headers = parseHeaders(fillTpl(t.headers ?? '', vars))
    const body = t.bodyFile !== false ? Buffer.from('probe') : Buffer.from(fillTpl(t.body ?? '', vars), 'utf8')
    await req(url, { method, headers, body, expect: 'text', timeoutMs: 30_000 })
    // 用户 m03310：通了也要说清测到了什么。这里只知道「对面回了 2xx」。
    return {
      ok: true,
      where: url,
      note: `用 ${method} 往上面那个地址（把 {{name}} 换成 .dsh-fish-probe.txt 之后）真的发了一次请求，对面回了 2xx。`
        + '这只能说明「地址、方法、请求头都对，对面收下了」——对面有没有把字节存住、存到哪儿，本机看不见。'
        + '真正验证要等你点「现在就送一份」，然后去你那边看有没有那个文件。',
    }
  },
}

// ─────────────────────────── command（万能出口） ───────────────────────────

function shellFor(t) {
  const s = String(t.shell ?? 'auto').trim().toLowerCase()
  if (s === 'cmd' || s === 'bash') return s
  return process.platform === 'win32' ? 'cmd' : 'bash'
}

function runCmd(cmd, shell, timeoutMs = 180_000) {
  return new Promise((resolveP) => {
    const file = shell === 'cmd' ? 'cmd.exe' : '/bin/sh'
    const args = shell === 'cmd' ? ['/d', '/s', '/c', cmd] : ['-c', cmd]
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) resolveP({ ok: false, why: String(stderr || err.message || '').trim().slice(0, 400) || '命令失败了，没有输出。', code: err.code })
      else resolveP({ ok: true, out: String(stdout ?? '').trim().slice(0, 400) })
    })
  })
}

export const command = {
  kind: 'command',
  async put(t, name, buf, { tmpDir } = {}) {
    const cmd0 = String(t.cmd ?? '').trim()
    if (!cmd0) throw new NetError('还没填命令。')
    // 文件先落一个临时位置再交给命令：这样命令里只需要「读一个路径」，不用管字节怎么传。
    const dir = tmpDir ?? join(process.env.TEMP || process.env.TMP || '.', 'dsh-fish-cloud')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, name)
    writeFileSync(file, buf)
    const vars = { file, name, sha256: sha256(buf), size: buf.length }
    const cmd = fillTpl(cmd0, vars)
    const r = await runCmd(cmd, shellFor(t))
    try { unlinkSync(file) } catch {}
    if (!r.ok) throw new NetError(`命令没成功：${r.why}`)
    return { name, bytes: buf.length, note: r.out ? `命令输出：${r.out.slice(0, 120)}` : '' }
  },
  async list() {
    return []
  },
  async get() {
    throw new NetError('命令驱动只负责往外送。要拿回来请写一条下载命令，或者用那边的客户端。')
  },
  async remove() {
    return { ok: false, why: '命令驱动没有统一的删除约定，清理要你在那边做。' }
  },
  async probe(t) {
    const cmd0 = String(t.cmd ?? '').trim()
    if (!cmd0) throw new NetError('还没填命令。')
    // 探测不跑真命令（可能很贵、可能有副作用）：只检查这台机器上那个程序在不在。
    const first = cmd0.split(/\s+/)[0].replace(/^["']|["']$/g, '')
    const shell = shellFor(t)
    const which = shell === 'cmd' ? `where "${first}"` : `command -v "${first}"`
    const r = await runCmd(which, shell, 10_000)
    if (!r.ok) {
      return {
        ok: false,
        why: `这台机器上找不到「${first}」。装好它，或者把命令改成绝对路径。`,
        where: first,
        note: '只查了「这个程序在不在」，命令本身没跑。',
      }
    }
    // 用户 m03310：通了也要说清测到了什么、测不到什么。
    return {
      ok: true,
      where: r.out || first,
      note: `在这台机器上找到了「${first}」（${r.out || '路径没回显'}），所以命令的第一段不会因为「找不到程序」直接失败。`
        + '测不到的是「这条命令跑起来会不会真的成功」——探测刻意不跑它（可能很慢、可能删东西），'
        + '要验到底就点「现在就送一份」，那时命令会真的执行一次，输出会写在下面的状态里。',
    }
  },
}

export const DRIVERS = { folder, git, webdav, smtp, http, command }

export function driver(kind) {
  return DRIVERS[String(kind ?? '')] ?? null
}

export { sha256, sizeText, NetError }
