// 云端备份的加密（2026-11-14，用户 m01090）
//
// 为什么这件事不能省：备份包里有 owner.json，里面是她的 B 站登录 cookie。
// 任何一份**没加密**的备份传到别人家服务器上，就等于把「能登这个号的钥匙」放出去了。
//
// 取舍（写在最前面，免得以后有人来问「为什么不做成 XX」）：
// 1. 只用 node:crypto，不加依赖。AES-256-GCM + scrypt，都是内置的。
// 2. 口令不写进 config.json，单独一个 `cloud-key.txt`（0600），并且**排除在备份之外**
//    （backup.js 的 SKIP_FILES 里登记了它）。理由：口令若跟着备份走，拿到本地备份的人
//    就能解开云端那几十份——加密这件事当场归零。代价是换机器恢复要先重新填一次口令，
//    这是对的代价。
// 3. 丢了口令就真的解不开。没有后门、没有主密钥、不做密钥托管。界面上要写这一句。
// 4. 文件头带 magic 与版本，将来换算法时能认出来，不会把旧包当坏包。

import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { readFileSync, writeFileSync, chmodSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { rootDir } from './store.js'

/** 加密文件的开头这 8 个字节。认不出来的一律拒绝，不去猜。 */
export const MAGIC = Buffer.from('DSHFISH1', 'ascii')
/** 版本号：加在 magic 后面，将来换算法时靠它分流。 */
export const FORMAT_VERSION = 1
/** 口令文件：跟数据根一起走，但不进备份。 */
export const KEY_FILE = 'cloud-key.txt'
export const MIN_PASS = 8

const SALT_BYTES = 16
const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32
const HEAD_BYTES = MAGIC.length + 1 + SALT_BYTES + IV_BYTES

export function keyPath(root = rootDir()) {
  return join(root, KEY_FILE)
}

/**
 * 读口令。没设过返回 ''。
 * 读失败（权限、坏字符）也返回 ''，不抛——调用方只需要知道「有没有」。
 */
export function readPass(root = rootDir()) {
  try {
    const s = readFileSync(keyPath(root), 'utf8').replace(/^\uFEFF/, '').trim()
    return s
  } catch {
    return ''
  }
}

export function hasPass(root = rootDir()) {
  return readPass(root).length >= MIN_PASS
}

/**
 * 写口令。太短直接拒（scrypt 再强也救不了六个字符）。
 * 传空字符串 = 删掉口令文件。
 */
export function writePass(root = rootDir(), pass = '') {
  const p = String(pass ?? '').trim()
  if (!p) {
    try { unlinkSync(keyPath(root)) } catch {}
    return { ok: true, cleared: true }
  }
  if (p.length < MIN_PASS) {
    return { ok: false, why: `口令至少 ${MIN_PASS} 个字符。短了挡不住猜，等于没加。` }
  }
  const file = keyPath(root)
  writeFileSync(file, p, { encoding: 'utf8', mode: 0o600 })
  // Windows 上 mode 常被忽略，再显式试一次；失败当无事（本来也挡不住管理员）。
  try { chmodSync(file, 0o600) } catch {}
  return { ok: true }
}

/** 一串字节看着是不是我们加密出来的。不做完整校验，只看头。 */
export function isEncrypted(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? '')
  if (b.length < HEAD_BYTES + TAG_BYTES) return false
  if (!b.subarray(0, MAGIC.length).equals(MAGIC)) return false
  return b[MAGIC.length] === FORMAT_VERSION
}

function deriveKey(pass, salt) {
  // N=16384 在手机/低配笔记本上约 50–100ms，够挡住离线暴力，又不至于让「存一份」变卡。
  return scryptSync(String(pass), salt, KEY_BYTES, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
}

/**
 * 加密。输入是 Buffer（备份包的 utf8 字节），输出是可以直接落盘的 Buffer。
 * 结构：[magic 8][version 1][salt 16][iv 12][ciphertext ...][tag 16]
 */
export function encryptBuffer(buf, pass) {
  const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? '')
  const p = String(pass ?? '')
  if (p.length < MIN_PASS) throw new Error('没有可用的口令，先设一个')
  const salt = randomBytes(SALT_BYTES)
  const iv = randomBytes(IV_BYTES)
  const key = deriveKey(p, salt)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const head = Buffer.concat([MAGIC, Buffer.from([FORMAT_VERSION]), salt, iv])
  const body = Buffer.concat([cipher.update(data), cipher.final()])
  return Buffer.concat([head, body, cipher.getAuthTag()])
}

/**
 * 解密。认不出格式、口令不对、内容被改过，都在这里抛一句人话。
 * 错误信息会原样冒到界面上，所以不写「auth tag mismatch」这种话。
 */
export function decryptBuffer(buf, pass) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? '')
  if (!isEncrypted(b)) throw new Error('这不是加密过的备份（或者文件坏了）。')
  const version = b[MAGIC.length]
  if (version !== FORMAT_VERSION) throw new Error(`这份备份是用更新的版本加的密（v${version}），这一版解不开。`)
  const salt = b.subarray(MAGIC.length + 1, MAGIC.length + 1 + SALT_BYTES)
  const iv = b.subarray(MAGIC.length + 1 + SALT_BYTES, HEAD_BYTES)
  const tag = b.subarray(b.length - TAG_BYTES)
  const body = b.subarray(HEAD_BYTES, b.length - TAG_BYTES)
  const key = deriveKey(String(pass ?? ''), salt)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  try {
    return Buffer.concat([decipher.update(body), decipher.final()])
  } catch {
    throw new Error('解不开：口令不对，或者这份文件在路上被改过。')
  }
}

/** 口令校验用的小指纹：同一个口令每次算出来一样，但看不出原口令。 */
export function passFingerprint(pass) {
  const p = String(pass ?? '')
  if (!p) return ''
  return createHash('sha256').update(Buffer.from(p, 'utf8')).digest().subarray(0, 8).toString('hex')
}

/** 加密文件名：`.json` → `.json.enc`。已经带的不重复加。 */
export function encName(name) {
  const n = String(name ?? '')
  return n.endsWith('.enc') ? n : `${n}.enc`
}

export function isEncName(name) {
  return String(name ?? '').endsWith('.enc')
}

/** 两个口令是不是同一个（用量时比较，不走 early return）。 */
export function samePass(a, b) {
  const x = Buffer.from(String(a ?? ''), 'utf8')
  const y = Buffer.from(String(b ?? ''), 'utf8')
  // 两个空串不算「同一个口令」：空的意思是没有口令，不该被当成匹配上。
  if (!x.length || !y.length) return false
  if (x.length !== y.length) return false
  return timingSafeEqual(x, y)
}

/** 这个口令到底设没设够长——给界面用，返回一句人话或空。 */
export function passProblem(pass) {
  const p = String(pass ?? '')
  if (!p) return '还没设口令。没有口令就没法加密，云端那一份等于明着放。'
  if (p.length < MIN_PASS) return `口令至少 ${MIN_PASS} 个字符。`
  return ''
}
