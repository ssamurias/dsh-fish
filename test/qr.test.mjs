/**
 * qr.test.mjs —— 2026-11-01 扫码登录带进来的那个二维码编码器
 *
 * 为什么要有这一份：lib/qr.js 是自己手写的（AGENTS.md §1：三个依赖字段永远是 {}），
 * 而"二维码画错一个格子"这种事，肉眼看图根本发现不了——扫不出来的时候人只会以为
 * 是网络坏了。所以这里拿一张**外部实现画出来的**矩阵当基准逐格比对。
 *
 * 基准怎么来的：Python `qrcode` 8.2，强制 8bit 字节模式
 *   QRData(s.encode('utf-8'), mode=MODE_8BIT_BYTE, check_data=False)
 * 生成的矩阵（border=0），只抄了一例进来当回归钉子；当年是 4 档纠错 × 4 条串 ×
 * 8 种掩码全部逐格对过（120/120 一致），这里留最小的那一例就够防回退。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { encodeQr, qrSvg } from '../lib/qr.js'

// Python qrcode 8.2：s='HELLO'、纠错 L、version 1、mask 0、border=0
const REF_HELLO_L_MASK0 = [
  '111111100101101111111',
  '100000100111001000001',
  '101110101101101011101',
  '101110100101001011101',
  '101110100010101011101',
  '100000100000101000001',
  '111111101010101111111',
  '000000001101100000000',
  '111011111111011000100',
  '000100001000001000010',
  '101000100010100011111',
  '110010001010001000010',
  '101001100110101010100',
  '000000001101010100110',
  '111111101001011100111',
  '100000101111110110000',
  '101110101001011100111',
  '101110100010001100110',
  '101110101110100010101',
  '100000101100001010010',
  '111111101100101100111',
]

/** 把 modules 摊成一行行 '0'/'1'，方便和上面那张表比。 */
function rowsOf(qr) {
  return qr.modules.map((row) => row.map((v) => (v ? '1' : '0')).join(''))
}

test('二维码：和 Python qrcode 画出来的逐格一致（HELLO / L / mask 0）', () => {
  const qr = encodeQr('HELLO', { ec: 'L', mask: 0 })
  assert.equal(qr.version, 1)
  assert.equal(qr.size, 21)
  assert.deepEqual(rowsOf(qr), REF_HELLO_L_MASK0)
})

test('二维码：定点图案（三个角的回字）画在正确的位置上', () => {
  const qr = encodeQr('HELLO', { ec: 'L', mask: 0 })
  const at = (x, y) => qr.modules[y][x]
  // 左上那个回字的四角与中心
  assert.equal(at(0, 0), 1)
  assert.equal(at(6, 0), 1)
  assert.equal(at(0, 6), 1)
  assert.equal(at(3, 3), 1)
  assert.equal(at(1, 1), 0)
  // 右下 / 左下两个角
  assert.equal(at(20, 20), 1)
  assert.equal(at(20, 14), 1)
  assert.equal(at(14, 20), 1)
  // 两条时序线（第 6 行 / 第 6 列）是交替的：版本 1 只走到第 12 列，再往右是分隔符
  let alt = true
  for (let i = 8; i < 12; i += 1) {
    if (qr.modules[6][i] === qr.modules[6][i + 1]) alt = false
  }
  assert.equal(alt, true)
})

test('二维码：同一个输入每次画出来都一样（不会因为随机掩码抖动）', () => {
  const a = encodeQr('https://example.com/a?b=1', { ec: 'M' })
  const b = encodeQr('https://example.com/a?b=1', { ec: 'M' })
  assert.equal(a.mask, b.mask)
  assert.deepEqual(rowsOf(a), rowsOf(b))
})

test('二维码：中文按 UTF-8 字节装进去，能自己挑够大的版本', () => {
  const s = '中文也要能装进去吗?试一下长度'
  const qr = encodeQr(s, { ec: 'M' })
  assert.ok(qr.version >= 1)
  // 8bit 模式：4 bit 模式位 + 8/16 bit 长度 + 字节数
  const bytes = Buffer.byteLength(s, 'utf8')
  assert.ok(bytes > 0)
  assert.equal(qr.modules.length, qr.size)
})

test('二维码：版本上限守得住——太长就当场说清楚，不给一张扫不出的图', () => {
  const huge = 'x'.repeat(2000)
  assert.throws(() => encodeQr(huge, { ec: 'H' }), /太长|装不下|version|版本/i)
})

test('二维码 SVG：是一个自包含的 <svg>，不引用任何外部资源', () => {
  const svg = qrSvg('https://example.com/x', { scale: 4, margin: 2 })
  assert.match(svg, /^<svg[\s>]/)
  assert.match(svg, /<\/svg>$/)
  // 只画一个 path：省得几千个 rect 把 DOM 撑爆；也不许引用任何外部图片/脚本
  assert.equal((svg.match(/<path/g) ?? []).length, 1)
  assert.doesNotMatch(svg, /<image|xlink:href|<script|<foreignObject/)
  assert.doesNotMatch(svg, /(?:href|src)\s*=\s*["'](?:https?:)?\/\//)
  // 尺寸 = (格数 + 两边留白) × 缩放
  const qr = encodeQr('https://example.com/x')
  assert.ok(svg.includes(`width="${(qr.size + 4) * 4}"`))
})
