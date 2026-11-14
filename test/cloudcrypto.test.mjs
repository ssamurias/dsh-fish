/**
 * cloudcrypto.test.mjs —— 云端备份的加密（2026-11-14，用户 m01090）
 *
 * 为什么要有：
 *   ① 备份包里原样带着 owner.json（主人身份 + B 站登录 cookie）。一旦传到别人
 *      看得见的地方，加密是唯一挡住「拿到文件就等于拿到账号」的东西。所以
 *      「加密再解回来还是一样的字节」这件事必须钉死。
 *   ② 更要紧的是反过来的两条：口令不对必须解不开（而不是返回一堆垃圾让人
 *      以为恢复了），文件被改过一个字节也必须解不开（GCM 的认证标签）。
 *   ③ 口令文件必须排除在备份之外。这条一旦漏了，加密当场归零——拿到任何一份
 *      本地备份的人都能解开云端那几十份。测它就等于测这件事有没有被写回去。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  KEY_FILE,
  MAGIC,
  MIN_PASS,
  decryptBuffer,
  encName,
  encryptBuffer,
  hasPass,
  isEncName,
  isEncrypted,
  keyPath,
  passFingerprint,
  passProblem,
  readPass,
  samePass,
  writePass,
} from '../lib/cloudcrypto.js'
import { collectBackup } from '../lib/backup.js'

async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), 'fish-cloudcrypto-'))
  await writeFile(join(root, 'events.jsonl'), '{"id":"ev_01","v":1,"type":"utterance","text":"嗯。","ts":"2026-10-25T00:00:00.000Z","day":1,"stage":1}\n')
  await writeFile(join(root, 'config.json'), '{}')
  return root
}

test('加密再解开：字节一模一样', () => {
  const buf = Buffer.from('{"hello":"世界","n":1}')
  const enc = encryptBuffer(buf, 'this-is-a-passphrase')
  assert.ok(isEncrypted(enc))
  assert.notEqual(enc.length, buf.length)
  assert.equal(enc.subarray(0, MAGIC.length).toString('ascii'), 'DSHFISH1')
  const back = decryptBuffer(enc, 'this-is-a-passphrase')
  assert.deepEqual(back, buf)
})

test('每次加密的盐和 IV 都不一样（同一个口令、同一份内容，密文也不同）', () => {
  const buf = Buffer.from('same content')
  const a = encryptBuffer(buf, 'this-is-a-passphrase')
  const b = encryptBuffer(buf, 'this-is-a-passphrase')
  assert.notDeepEqual(a, b)
  assert.deepEqual(decryptBuffer(a, 'this-is-a-passphrase'), buf)
  assert.deepEqual(decryptBuffer(b, 'this-is-a-passphrase'), buf)
})

test('口令不对：解不开，而且要是一句人话', () => {
  const enc = encryptBuffer(Buffer.from('secret'), 'right-passphrase')
  assert.throws(() => decryptBuffer(enc, 'wrong-passphrase'), /口令不对|被改过/)
})

test('密文被改一个字节：认证标签不过，抛错而不是返回坏数据', () => {
  const enc = encryptBuffer(Buffer.from('secret payload'), 'this-is-a-passphrase')
  const bad = Buffer.from(enc)
  bad[bad.length - 20] ^= 0xff
  assert.throws(() => decryptBuffer(bad, 'this-is-a-passphrase'), /口令不对|被改过/)
})

test('不是加密包：说清楚，而不是死循环或者返回垃圾', () => {
  assert.throws(() => decryptBuffer(Buffer.from('{"format":"dsh-fish-backup/1"}'), 'this-is-a-passphrase'), /不是加密过的备份/)
  assert.equal(isEncrypted(Buffer.from('{"format":"dsh-fish-backup/1"}')), false)
  assert.equal(isEncrypted(Buffer.alloc(0)), false)
})

test('口令太短不许加：短口令挡不住猜，等于没加', () => {
  assert.throws(() => encryptBuffer(Buffer.from('x'), 'short'), /没有可用的口令/)
  assert.match(passProblem('short'), /至少 8 个字符/)
  assert.match(passProblem(''), /没设口令/)
  assert.match(passProblem('1234567'), /至少 8 个字符/)
  assert.equal(passProblem('12345678'), '')
  assert.equal(MIN_PASS, 8)
})

test('口令文件：写、读、清；写下去的是 0600', async () => {
  const root = await makeRoot()
  try {
    assert.equal(readPass(root), '')
    assert.equal(hasPass(root), false)

    const bad = writePass(root, '123')
    assert.equal(bad.ok, false)
    assert.match(bad.why, /至少 8 个字符/)
    assert.equal(hasPass(root), false)

    const ok = writePass(root, 'a-good-passphrase')
    assert.equal(ok.ok, true)
    assert.equal(readPass(root), 'a-good-passphrase')
    assert.equal(hasPass(root), true)
    assert.equal(keyPath(root), join(root, KEY_FILE))
    // 有 mode 能力的平台才断言；Windows 上 chmod 基本是空操作，不当失败。
    if (process.platform !== 'win32') {
      const st = await stat(keyPath(root))
      assert.equal(st.mode & 0o777, 0o600)
    }

    writePass(root, '')
    assert.equal(readPass(root), '')
    assert.equal(hasPass(root), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('口令文件不进备份：SKIP_FILES 里必须有它', async () => {
  const root = await makeRoot()
  try {
    writePass(root, 'a-good-passphrase')
    const bundle = await collectBackup(root, { now: new Date('2026-11-14T08:00:00Z') })
    const names = bundle.files.map((f) => f.path)
    assert.equal(names.includes(KEY_FILE), false, '口令文件被装进备份了——加密当场归零')
    assert.equal(names.includes('events.jsonl'), true)
    // 也不该只在 excluded 里「提到」它却仍然被读进去
    const raw = JSON.stringify(bundle)
    assert.equal(raw.includes('a-good-passphrase'), false, '备份正文里出现了口令原文')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('文件名：.json → .json.enc，重复加不会变成 .enc.enc', () => {
  assert.equal(encName('大肥鱼-自动-20261114-070255.json'), '大肥鱼-自动-20261114-070255.json.enc')
  assert.equal(encName('x.json.enc'), 'x.json.enc')
  assert.equal(isEncName('x.json.enc'), true)
  assert.equal(isEncName('x.json'), false)
})

test('口令比对与指纹：指纹只露前 8 字节，同一口令稳定、不同口令不同', () => {
  assert.equal(samePass('abc-passphrase', 'abc-passphrase'), true)
  assert.equal(samePass('abc-passphrase', 'abd-passphrase'), false)
  assert.equal(samePass('short', 'a-much-longer-passphrase'), false)
  assert.equal(samePass('', ''), false)

  const fp = passFingerprint('abc-passphrase')
  assert.match(fp, /^[0-9a-f]{16}$/)
  assert.equal(passFingerprint('abc-passphrase'), fp)
  assert.notEqual(passFingerprint('abd-passphrase'), fp)
})

test('大一点的文件也能原样往返（1MB 随机字节）', () => {
  const buf = Buffer.alloc(1024 * 1024)
  for (let i = 0; i < buf.length; i++) buf[i] = i % 251
  const back = decryptBuffer(encryptBuffer(buf, 'this-is-a-passphrase'), 'this-is-a-passphrase')
  assert.equal(back.length, buf.length)
  assert.equal(Buffer.compare(back, buf), 0)
})

test('解出来以后能被 readFile 当 JSON 读（真的是一份可用的备份）', async () => {
  const root = await makeRoot()
  try {
    const bundle = await collectBackup(root, { now: new Date('2026-11-14T08:00:00Z') })
    const text = JSON.stringify(bundle)
    const enc = encryptBuffer(Buffer.from(text, 'utf8'), 'a-good-passphrase')
    await writeFile(join(root, 'remote.json.enc'), enc)
    const back = decryptBuffer(await readFile(join(root, 'remote.json.enc')), 'a-good-passphrase')
    const obj = JSON.parse(back.toString('utf8'))
    assert.equal(obj.format, 'dsh-fish-backup/1')
    assert.ok(Array.isArray(obj.files))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
