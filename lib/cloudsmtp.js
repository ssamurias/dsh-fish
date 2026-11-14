// 一个够用的 SMTP 客户端（2026-11-14，用户 m01090）
//
// 为什么自己写：插件是零依赖的（package.json 里三个 dependencies 全空），
// 装 nodemailer 违反那条铁律；而发一封带一个附件的信，用 node:net / node:tls 写两百行就够。
//
// 只做三件必要的事：
//   1. 465 直连 TLS，587/25 先明文再 STARTTLS（大多数邮箱走这两条之一）。
//   2. AUTH LOGIN（QQ/163/Gmail/Outlook 都支持；AUTH PLAIN 也顺手支持）。
//   3. 一封 multipart/mixed、一个 base64 附件。
// 不做：HTML 正文、多收件人分开发、DKIM、投递回执。用不上，也不该在这里长出来。

import { connect as tlsConnect } from 'node:tls'
import { connect as netConnect } from 'node:net'
import { hostname } from 'node:os'

const CRLF = '\r\n'

/** 一句话的错误：界面会原样显示。 */
class SMTPError extends Error {}

/**
 * 把「服务器说了什么」翻译成人话。
 * SMTP 的错误码对普通用户没有意义，但把它附在后面能让人拿去搜索。
 */
function explain(code, text) {
  const t = String(text ?? '').trim()
  const low = t.toLowerCase()
  if (code === 535 || low.includes('auth') && low.includes('fail')) {
    return `登录被拒了（${code}）。多半是用了登录密码——这里要的是邮箱设置里那个「授权码 / 应用专用密码」。`
  }
  if (code === 534 || low.includes('application-specific')) {
    return `邮箱要求用「授权码 / 应用专用密码」（${code}），不能用登录密码。`
  }
  if (code === 550 || code === 553) return `收件地址被拒了（${code}）：${t}`
  if (code === 552) return `附件太大了，这家邮箱收不下（${code}）。`
  if (code === 421 || code === 450 || code === 451) return `服务器暂时不收（${code}），过一会儿再试。`
  return `${code} ${t}`
}

/** 一条连接：负责把字节写进去、把服务器的话按行读回来。 */
class Conn {
  constructor(socket) {
    this.socket = socket
    this.buf = ''
    this.waiters = []
    this.err = null
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => {
      this.buf += chunk
      this.pump()
    })
    socket.on('error', (e) => {
      this.err = e
      this.pump()
    })
    socket.on('close', () => {
      this.err = this.err ?? new Error('连接被对方关掉了')
      this.pump()
    })
  }

  pump() {
    while (this.waiters.length) {
      const w = this.waiters[0]
      const r = this.takeReply()
      if (r) {
        this.waiters.shift()
        w.resolve(r)
      } else if (this.err) {
        this.waiters.shift()
        w.reject(this.err)
      } else return
    }
  }

  /** 读一条完整回复（多行回复以「码-」续行，最后一行是「码 空格」）。 */
  takeReply() {
    const lines = this.buf.split(CRLF)
    let code = null
    let text = ''
    let consumed = 0
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line.length < 3) break
      const m = /^(\d{3})([ -])(.*)$/.exec(line)
      if (!m) break
      code = Number(m[1])
      text += `${m[3]}${CRLF}`
      consumed += line.length + CRLF.length
      if (m[2] === ' ') {
        this.buf = this.buf.slice(consumed)
        return { code, text: text.trim() }
      }
    }
    return null
  }

  reply(timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      const w = { resolve, reject }
      this.waiters.push(w)
      const t = setTimeout(() => {
        const i = this.waiters.indexOf(w)
        if (i >= 0) this.waiters.splice(i, 1)
        reject(new SMTPError('服务器太久没回话（30 秒）。网络、代理、或者端口不对。'))
      }, timeoutMs)
      const done = (fn) => (v) => { clearTimeout(t); fn(v) }
      w.resolve = done(resolve)
      w.reject = done(reject)
      this.pump()
    })
  }

  write(s) {
    this.socket.write(s)
  }

  end() {
    try { this.socket.end() } catch {}
  }
}

function base64(s) {
  return Buffer.from(String(s), 'utf8').toString('base64')
}

/** 点号转义：正文里以 . 开头的行要变成 ..，否则会被当成提前结束。 */
function dotStuff(s) {
  return String(s).replace(/\r?\n/g, CRLF).replace(/^\./gm, '..')
}

function encWord(s) {
  // 中文主题要按 RFC 2047 编码，不然 Outlook 会显示成乱码。
  const text = String(s ?? '')
  if (/^[\x20-\x7e]*$/.test(text)) return text
  return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`
}

function wrap76(b64) {
  const out = []
  for (let i = 0; i < b64.length; i += 76) out.push(b64.slice(i, i + 76))
  return out.join(CRLF)
}

/**
 * 拼一封信。attachments: [{name, data: Buffer}]。
 * Content-Type 里带 name 时要做编码，但大多数客户端靠 filename* 也能认。
 */
export function buildMessage({ from, to, subject, text, attachments = [] }) {
  const boundary = `dshfish-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const head = [
    `From: <${from}>`,
    `To: ${to.map((x) => `<${x}>`).join(', ')}`,
    `Subject: ${encWord(subject)}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}@dsh-fish>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    '这一封是自动发出的备份。',
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(Buffer.from(String(text ?? ''), 'utf8').toString('base64')),
  ]
  for (const a of attachments) {
    const name = String(a.name ?? 'backup.json')
    head.push(
      `--${boundary}`,
      `Content-Type: application/octet-stream; name="${encWord(name)}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${encWord(name)}"`,
      '',
      wrap76(Buffer.from(a.data ?? Buffer.alloc(0)).toString('base64')),
    )
  }
  head.push(`--${boundary}--`, '')
  return head.join(CRLF)
}

export class SMTPSender {
  constructor({ host, port = 465, user = '', pass = '', timeoutMs = 60_000, log = () => {} } = {}) {
    this.host = String(host ?? '').trim()
    this.port = Number(port) || 465
    this.user = String(user ?? '').trim()
    this.pass = String(pass ?? '')
    this.timeoutMs = timeoutMs
    this.log = log
  }

  connect() {
    return new Promise((resolve, reject) => {
      const sock = this.port === 465
        ? tlsConnect({ host: this.host, port: this.port, servername: this.host, timeout: this.timeoutMs })
        : netConnect({ host: this.host, port: this.port, timeout: this.timeoutMs })
      let settled = false
      const fail = (e) => {
        if (settled) return
        settled = true
        try { sock.destroy() } catch {}
        reject(new SMTPError(this.friendly(e)))
      }
      sock.once('error', fail)
      sock.once('timeout', () => fail(new Error('连不上')))
      sock.once('connect', () => {
        if (settled) return
        // 465 上还要等 TLS 握手完；587 连上就能说话。
        if (this.port === 465) {
          sock.once('secureConnect', () => {
            if (settled) return
            settled = true
            sock.removeListener('error', fail)
            resolve(new Conn(sock))
          })
        } else {
          settled = true
          sock.removeListener('error', fail)
          resolve(new Conn(sock))
        }
      })
    })
  }

  friendly(e) {
    const code = e?.code ?? ''
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `找不到服务器「${this.host}」，检查一下拼写。`
    if (code === 'ECONNREFUSED') return `「${this.host}:${this.port}」不肯连——端口填错了，或者这家邮箱不支持这个端口。`
    if (code === 'ETIMEDOUT') return '连接超时。检查网络，或者这家邮箱在本机网络下要开代理。'
    if (code === 'CERT_HAS_EXPIRED' || String(e?.message ?? '').includes('certificate')) return 'TLS 证书有问题，可能是被中间人拦了。'
    return `连不上：${e?.message ?? e}`
  }

  /** 登录一次就断。给「测一下」按钮用。 */
  async verify() {
    const c = await this.connect()
    try {
      await this.hello(c)
      await this.auth(c)
      return 'ok'
    } finally {
      try { c.write('QUIT' + CRLF) } catch {}
      setTimeout(() => c.end(), 200).unref?.()
    }
  }

  async hello(c) {
    const greet = await c.reply()
    if (greet.code !== 220) throw new SMTPError(explain(greet.code, greet.text))
    const name = hostname().replace(/[^\w.-]/g, '') || 'localhost'
    c.write(`EHLO ${name}${CRLF}`)
    let ehlo = await c.reply()
    if (ehlo.code >= 400 || ehlo.code < 200) {
      // 有的老服务器只认 HELO。
      c.write(`HELO ${name}${CRLF}`)
      ehlo = await c.reply()
    }
    if (ehlo.code !== 250) throw new SMTPError(explain(ehlo.code, ehlo.text))
    // 587/25 上如果没有 STARTTLS 就明文发，等于把授权码和备份裸奔在网上——宁可不发。
    if (this.port !== 465) {
      if (!/\bSTARTTLS\b/i.test(ehlo.text)) {
        throw new SMTPError(`这家服务器不同意加密（没有 STARTTLS）。为了不让授权码和备份明文上路，这里不发。换成 465 端口试试。`)
      }
      c.write('STARTTLS' + CRLF)
      const st = await c.reply()
      if (st.code !== 220) throw new SMTPError(explain(st.code, st.text))
      await new Promise((resolve, reject) => {
        const sock = c.socket
        // net.Socket 换不了加密层，只能拿 TLS 包一层上去；包好之后这条连接的读写都走它。
        const tls = tlsConnect({ socket: sock, servername: this.host, timeout: this.timeoutMs }, () => resolve())
        tls.once('error', reject)
        c.socket = tls
        c.buf = ''
        c.waiters = []
        tls.setEncoding('utf8')
        tls.on('data', (chunk) => { c.buf += chunk; c.pump() })
        tls.on('error', (e) => { c.err = e; c.pump() })
        tls.on('close', () => { c.err = c.err ?? new Error('连接被对方关掉了'); c.pump() })
      })
      const name2 = hostname().replace(/[^\w.-]/g, '') || 'localhost'
      c.write(`EHLO ${name2}${CRLF}`)
      const again = await c.reply()
      if (again.code !== 250) throw new SMTPError(explain(again.code, again.text))
    }
  }

  async auth(c) {
    if (!this.user) return
    c.write('AUTH LOGIN' + CRLF)
    const a1 = await c.reply()
    if (a1.code !== 334) throw new SMTPError(explain(a1.code, a1.text))
    c.write(base64(this.user) + CRLF)
    const a2 = await c.reply()
    if (a2.code !== 334) throw new SMTPError(explain(a2.code, a2.text))
    c.write(base64(this.pass) + CRLF)
    const a3 = await c.reply()
    if (a3.code !== 235) throw new SMTPError(explain(a3.code, a3.text))
  }

  async send({ from, to, subject, text, attachments = [] }) {
    const c = await this.connect()
    try {
      await this.hello(c)
      await this.auth(c)
      c.write(`MAIL FROM:<${from}>${CRLF}`)
      const m = await c.reply()
      if (m.code !== 250) throw new SMTPError(explain(m.code, m.text))
      for (const r of to) {
        c.write(`RCPT TO:<${r}>${CRLF}`)
        const rr = await c.reply()
        if (rr.code !== 250 && rr.code !== 251) throw new SMTPError(explain(rr.code, rr.text))
      }
      c.write('DATA' + CRLF)
      const d = await c.reply()
      if (d.code !== 354) throw new SMTPError(explain(d.code, d.text))
      const msg = buildMessage({ from, to, subject, text, attachments })
      c.write(dotStuff(msg))
      if (!msg.endsWith(CRLF)) c.write(CRLF)
      c.write('.' + CRLF)
      const done = await c.reply(180_000)
      if (done.code !== 250) throw new SMTPError(explain(done.code, done.text))
      return { ok: true, id: done.text }
    } finally {
      try { c.write('QUIT' + CRLF) } catch {}
      setTimeout(() => c.end(), 200).unref?.()
    }
  }
}

export { SMTPError }
