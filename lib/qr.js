/**
 * qr.js —— 把一串字画成二维码（纯 JS，零依赖）
 *
 * 为什么要自己写（2026-11-01）：
 *   设置页要加「扫码登录」，B 站只给一个登录 URL，二维码图得自己画。
 *   仓库第一条铁律是零依赖（AGENTS.md §1），所以不能引 `qrcode`；
 *   也不能把登录 URL 拼给第三方图片服务——那等于把一次性的钥匙递给别人。
 *
 * 只做了什么：
 *   - 字节模式（UTF-8），不写数字/字母数字/汉字模式。登录 URL 是 ASCII，
 *     其它地方也用不上；少一种模式就少一处会算错的地方。
 *   - 版本 1–10 自动选（够装 213 字节，B 站 URL 约 110 字节）。
 *   - 纠错级默认 M（屏幕上扫，容错不用到 H），四档全支持。
 *
 * 没做什么：结构化追加、多符号、Micro QR。用不到。
 *
 * 正确性怎么保证：`test/qr.test.mjs` 拿几个已知的参考矩阵比对（不是"看着像二维码"
 * 就算过）。算法本身照 ISO/IEC 18004 写的，分块表见 ECC_BLOCKS。
 */

// ---------------------------------------------------------------- GF(256)
// 生成多项式用；本原多项式 x^8+x^4+x^3+x^2+1 = 0x11D。
const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
;(() => {
  let x = 1
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x
    LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255]
})()

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0
  return EXP[LOG[a] + LOG[b]]
}

/** 生成多项式 ∏(x - α^i)，i = 0..deg-1。系数从高次到低次，首项恒为 1。 */
function rsGenerator(deg) {
  let poly = [1]
  for (let i = 0; i < deg; i += 1) {
    const next = new Array(poly.length + 1).fill(0)
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j]
      next[j + 1] ^= gfMul(poly[j], EXP[i])
    }
    poly = next
  }
  return poly
}

/** 给一块数据算 ecLen 个纠错码字。 */
function rsEncode(data, ecLen) {
  const gen = rsGenerator(ecLen)
  const rem = new Uint8Array(data.length + ecLen)
  rem.set(data)
  for (let i = 0; i < data.length; i += 1) {
    const factor = rem[i]
    if (factor === 0) continue
    for (let j = 0; j < gen.length; j += 1) rem[i + j] ^= gfMul(gen[j], factor)
  }
  return rem.slice(data.length)
}

// ---------------------------------------------------------------- 分块表
// 每个版本 × 纠错级：[每块纠错码字数, 第一组块数, 第一组每块数据码字数, 第二组块数, 第二组每块数据码字数]
// 数值照 ISO/IEC 18004 Table 9。版本 1–10；B 站登录 URL 用不到更大的。
const ECC_BLOCKS = {
  1: { L: [7, 1, 19, 0, 0], M: [10, 1, 16, 0, 0], Q: [13, 1, 13, 0, 0], H: [17, 1, 9, 0, 0] },
  2: { L: [10, 1, 34, 0, 0], M: [16, 1, 28, 0, 0], Q: [22, 1, 22, 0, 0], H: [28, 1, 16, 0, 0] },
  3: { L: [15, 1, 55, 0, 0], M: [26, 1, 44, 0, 0], Q: [18, 2, 17, 0, 0], H: [22, 2, 13, 0, 0] },
  4: { L: [20, 1, 80, 0, 0], M: [18, 2, 32, 0, 0], Q: [26, 2, 24, 0, 0], H: [16, 4, 9, 0, 0] },
  5: { L: [26, 1, 108, 0, 0], M: [24, 2, 43, 0, 0], Q: [18, 2, 15, 2, 16], H: [22, 2, 11, 2, 12] },
  6: { L: [18, 2, 68, 0, 0], M: [16, 4, 27, 0, 0], Q: [24, 4, 19, 0, 0], H: [28, 4, 15, 0, 0] },
  7: { L: [20, 2, 78, 0, 0], M: [18, 4, 31, 0, 0], Q: [18, 2, 14, 4, 15], H: [26, 4, 13, 1, 14] },
  8: { L: [24, 2, 97, 0, 0], M: [22, 2, 38, 2, 39], Q: [22, 4, 18, 2, 19], H: [26, 4, 14, 2, 15] },
  9: { L: [30, 2, 116, 0, 0], M: [22, 3, 36, 2, 37], Q: [20, 4, 16, 4, 17], H: [24, 4, 12, 4, 13] },
  10: { L: [18, 2, 68, 2, 69], M: [26, 4, 43, 1, 44], Q: [24, 6, 19, 2, 20], H: [28, 6, 15, 2, 16] },
}

const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
  7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
}

const EC_BITS = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 }
const MAX_VERSION = 10

// ---------------------------------------------------------------- 位流
function bitBuffer() {
  const bits = []
  return {
    push(value, len) {
      for (let i = len - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1)
    },
    get length() { return bits.length },
    bits,
  }
}

/** 每个版本能装多少个数据位（字节模式的容量由它减掉模式/长度头得到）。 */
function dataCodewords(version, ec) {
  const [ecLen, blocks1, size1, blocks2, size2] = ECC_BLOCKS[version][ec]
  return { ecLen, blocks1, size1, blocks2, size2, total: blocks1 * size1 + blocks2 * size2 }
}

function chooseVersion(bytes, ec) {
  // UTF-8 字节数 + 模式头 4 位 + 长度指示（版本 1–9 是 8 位，10 起是 16 位）
  for (let v = 1; v <= MAX_VERSION; v += 1) {
    const cap = dataCodewords(v, ec).total * 8
    const header = 4 + (v <= 9 ? 8 : 16)
    if (header + bytes.length * 8 <= cap) return v
  }
  return 0
}

/** 数据码字 + 纠错码字，按块交错成一串。 */
function buildCodewords(bytes, version, ec) {
  const { ecLen, blocks1, size1, blocks2, size2 } = dataCodewords(version, ec)
  const total = blocks1 * size1 + blocks2 * size2

  const buf = bitBuffer()
  buf.push(0b0100, 4) // 字节模式
  buf.push(bytes.length, version <= 9 ? 8 : 16)
  for (const b of bytes) buf.push(b, 8)
  // 终止符最多 4 位；已经满了就不加
  const capBits = total * 8
  const term = Math.min(4, capBits - buf.length)
  if (term > 0) buf.push(0, term)
  // 补到字节边界
  while (buf.length % 8 !== 0) buf.bits.push(0)
  // 补语（两个标准填充字节交替），直到装满数据码字
  const padBits = []
  let k = 0
  while (buf.bits.length + padBits.length < capBits) {
    padBits.push(...(k % 2 === 0 ? [1, 1, 1, 0, 1, 1, 0, 0] : [0, 0, 0, 1, 0, 0, 0, 1]))
    k += 1
  }
  const all = buf.bits.concat(padBits)
  const bytesOut = new Uint8Array(total)
  for (let i = 0; i < total; i += 1) {
    let v = 0
    for (let j = 0; j < 8; j += 1) v = (v << 1) | all[i * 8 + j]
    bytesOut[i] = v
  }

  // 切块 → 每块算 ec → 交错
  const dataBlocks = []
  const ecBlocks = []
  let p = 0
  for (let b = 0; b < blocks1; b += 1) {
    const chunk = bytesOut.slice(p, p + size1)
    p += size1
    dataBlocks.push(chunk)
    ecBlocks.push(rsEncode(chunk, ecLen))
  }
  for (let b = 0; b < blocks2; b += 1) {
    const chunk = bytesOut.slice(p, p + size2)
    p += size2
    dataBlocks.push(chunk)
    ecBlocks.push(rsEncode(chunk, ecLen))
  }

  const out = []
  const maxData = Math.max(size1, size2)
  for (let i = 0; i < maxData; i += 1) {
    for (const blk of dataBlocks) if (i < blk.length) out.push(blk[i])
  }
  for (let i = 0; i < ecLen; i += 1) {
    for (const blk of ecBlocks) if (i < blk.length) out.push(blk[i])
  }
  return out
}

// ---------------------------------------------------------------- 矩阵
function blank(size) {
  return Array.from({ length: size }, () => new Array(size).fill(null))
}

function placeFinder(m, r, c) {
  // 7×7 的黑框白底黑心 + 一圈分隔符
  for (let dr = -1; dr <= 7; dr += 1) {
    for (let dc = -1; dc <= 7; dc += 1) {
      const y = r + dr
      const x = c + dc
      if (y < 0 || y >= m.length || x < 0 || x >= m.length) continue
      const inRing = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6
      const dark = inRing && (dr === 0 || dr === 6 || dc === 0 || dc === 6
        || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4))
      m[y][x] = dark ? 1 : 0
    }
  }
}

function placeAlignment(m, version) {
  const pos = ALIGN[version]
  for (const r of pos) {
    for (const c of pos) {
      // 和三个 finder 重合的位置要跳过（规范里就是这么画的）
      if ((r === 6 && c === 6) || (r === 6 && c === m.length - 7) || (r === m.length - 7 && c === 6)) continue
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) {
          const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1
          m[r + dr][c + dc] = dark ? 1 : 0
        }
      }
    }
  }
}

function placeTiming(m) {
  for (let i = 8; i < m.length - 8; i += 1) {
    const bit = i % 2 === 0 ? 1 : 0
    if (m[6][i] === null) m[6][i] = bit
    if (m[i][6] === null) m[i][6] = bit
  }
}

/** 15 位格式信息：2 位纠错级 + 3 位掩码号，BCH(15,5)，再异或常数。 */
function formatBits(ec, mask) {
  const data = (EC_BITS[ec] << 3) | mask
  let rem = data
  for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
  return ((data << 10) | rem) ^ 0x5412
}

/** 18 位版本信息（版本 7 起才有），BCH(18,6)。 */
function versionBits(version) {
  let rem = version
  for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
  return (version << 12) | rem
}

function reserveFormat(m) {
  const n = m.length
  // 先占位（null → 2 表示"留给格式信息"），真正写入在选完掩码之后
  for (let i = 0; i <= 8; i += 1) {
    if (m[8][i] === null) m[8][i] = 2
    if (m[i][8] === null) m[i][8] = 2
  }
  for (let i = 0; i < 8; i += 1) {
    if (m[8][n - 1 - i] === null) m[8][n - 1 - i] = 2
    if (m[n - 1 - i][8] === null) m[n - 1 - i][8] = 2
  }
  m[n - 8][8] = 1 // 固定深色模块
  for (let i = 0; i <= 8; i += 1) if (m[8][i] === null) m[8][i] = 2
}

function reserveVersion(m, version) {
  if (version < 7) return
  const n = m.length
  const bits = versionBits(version)
  for (let i = 0; i < 18; i += 1) {
    const bit = (bits >>> i) & 1
    const a = Math.floor(i / 3)
    const b = i % 3
    m[n - 11 + b][a] = bit
    m[a][n - 11 + b] = bit
  }
}

function placeData(m, codewords) {
  const n = m.length
  // 哪些格子是"数据格"要单独记：掩码只能盖数据格，盖到定位图案就废了。
  const isData = Array.from({ length: n }, () => new Array(n).fill(false))
  let bitIndex = 0
  const totalBits = codewords.length * 8
  let upward = true
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5 // 时序列不参与
    for (let vert = 0; vert < n; vert += 1) {
      const y = upward ? n - 1 - vert : vert
      for (let j = 0; j < 2; j += 1) {
        const x = right - j
        if (m[y][x] !== null) continue
        let bit = 0
        if (bitIndex < totalBits) bit = (codewords[bitIndex >> 3] >>> (7 - (bitIndex & 7))) & 1
        m[y][x] = bit
        isData[y][x] = true
        bitIndex += 1
      }
    }
    upward = !upward
  }
  return isData
}

const MASKS = [
  (y, x) => (y + x) % 2 === 0,
  (y) => y % 2 === 0,
  (_, x) => x % 3 === 0,
  (y, x) => (y + x) % 3 === 0,
  (y, x) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (y, x) => ((y * x) % 2) + ((y * x) % 3) === 0,
  (y, x) => (((y * x) % 2) + ((y * x) % 3)) % 2 === 0,
  (y, x) => (((y + x) % 2) + ((y * x) % 3)) % 2 === 0,
]

function applyMask(m, mask, isData) {
  const n = m.length
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      if (!isData[y][x]) continue
      if (MASKS[mask](y, x)) m[y][x] ^= 1
    }
  }
}

function writeFormat(m, ec, mask) {
  const n = m.length
  const bits = formatBits(ec, mask)
  // 左上那一份：先竖着往上走，到第 8 行拐成横的（第 6 列是时序列，跳过）
  for (let i = 0; i <= 5; i += 1) m[i][8] = (bits >>> i) & 1
  m[7][8] = (bits >>> 6) & 1
  m[8][8] = (bits >>> 7) & 1
  m[8][7] = (bits >>> 8) & 1
  for (let i = 9; i <= 14; i += 1) m[8][14 - i] = (bits >>> i) & 1
  // 右上角 / 左下角
  for (let i = 0; i <= 7; i += 1) m[8][n - 1 - i] = (bits >>> i) & 1
  for (let i = 8; i <= 14; i += 1) m[n - 15 + i][8] = (bits >>> i) & 1
  m[n - 8][8] = 1
}

// 惩罚分（标准里那四条），只用来挑掩码。
function penalty(m) {
  const n = m.length
  let score = 0
  const line = (get) => {
    let run = 1
    for (let i = 1; i < n; i += 1) {
      if (get(i) === get(i - 1)) {
        run += 1
        continue
      }
      if (run >= 5) score += 3 + (run - 5)
      run = 1
    }
    if (run >= 5) score += 3 + (run - 5)
  }
  for (let y = 0; y < n; y += 1) line((x) => m[y][x])
  for (let x = 0; x < n; x += 1) line((y) => m[y][x])

  for (let y = 0; y < n - 1; y += 1) {
    for (let x = 0; x < n - 1; x += 1) {
      const v = m[y][x]
      if (v === m[y][x + 1] && v === m[y + 1][x] && v === m[y + 1][x + 1]) score += 3
    }
  }

  const finderLike = (a, b, c, d, e, f, g) => a && !b && c && d && e && !f && g
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x + 6 < n; x += 1) {
      if (finderLike(m[y][x], m[y][x + 1], m[y][x + 2], m[y][x + 3], m[y][x + 4], m[y][x + 5], m[y][x + 6])) {
        const before = x - 1 < 0 || m[y][x - 1] === 0
        const after = x + 7 >= n || m[y][x + 7] === 0
        if (before || after) score += 40
      }
    }
  }
  for (let x = 0; x < n; x += 1) {
    for (let y = 0; y + 6 < n; y += 1) {
      if (finderLike(m[y][x], m[y + 1][x], m[y + 2][x], m[y + 3][x], m[y + 4][x], m[y + 5][x], m[y + 6][x])) {
        const before = y - 1 < 0 || m[y - 1][x] === 0
        const after = y + 7 >= n || m[y + 7][x] === 0
        if (before || after) score += 40
      }
    }
  }

  const dark = m.flat().filter((v) => v === 1).length
  const ratio = (dark * 100) / (n * n)
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10
  return score
}

/**
 * 编码。返回 { version, ec, size, modules }，modules 是 0/1 的二维数组（含静区吗？不含）。
 */
export function encodeQr(text, opts = {}) {
  const ec = String(opts.ec ?? 'M').toUpperCase()
  if (!ECC_BLOCKS[1][ec]) throw new Error(`不认识的纠错级：${ec}`)
  const bytes = new TextEncoder().encode(String(text ?? ''))
  if (!bytes.length) throw new Error('二维码内容是空的')

  let version = opts.version ?? 0
  if (version) {
    const cap = dataCodewords(version, ec).total * 8
    const header = 4 + (version <= 9 ? 8 : 16)
    if (header + bytes.length * 8 > cap) throw new Error(`内容太长，装不进版本 ${version}（${ec}）`)
  } else {
    version = chooseVersion(bytes, ec)
    if (!version) throw new Error(`内容太长，装不进版本 ${MAX_VERSION}（${ec}）`)
  }

  const codewords = buildCodewords(bytes, version, ec)
  const size = 17 + version * 4

  // opts.mask 只在测试里用：把八种掩码逐个和参考实现比对，比"挑了一个"强得多。
  const forced = Number.isInteger(opts.mask) ? opts.mask : null
  let best = null
  for (let mask = 0; mask < 8; mask += 1) {
    if (forced !== null && mask !== forced) continue
    const m = blank(size)
    placeFinder(m, 0, 0)
    placeFinder(m, 0, size - 7)
    placeFinder(m, size - 7, 0)
    placeAlignment(m, version)
    placeTiming(m)
    reserveFormat(m)
    reserveVersion(m, version)
    const isData = placeData(m, codewords)
    applyMask(m, mask, isData)
    writeFormat(m, ec, mask)
    const score = penalty(m)
    if (!best || score < best.score) best = { score, mask, modules: m }
  }

  return { version, ec, size, modules: best.modules, mask: best.mask }
}

/**
 * 直接给一段 SVG 字符串（设置页拿它当 <img src="data:..."> 或走一条路由）。
 * 深色用 currentColor 会跟着主题变，但二维码用主题色反而更难扫——所以默认写死黑白。
 */
export function qrSvg(text, opts = {}) {
  const { modules, size, version } = encodeQr(text, opts)
  const margin = opts.margin ?? 4
  const scale = opts.scale ?? 8
  const dim = (size + margin * 2) * scale
  let path = ''
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (modules[y][x] === 1) {
        path += `M${(x + margin) * scale} ${(y + margin) * scale}h${scale}v${scale}h-${scale}z`
      }
    }
  }
  const dark = opts.dark ?? '#000'
  const light = opts.light ?? '#fff'
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges" data-version="${version}" data-modules="${size}">`
    + `<rect width="${dim}" height="${dim}" fill="${light}"/>`
    + `<path d="${path}" fill="${dark}"/>`
    + '</svg>'
}
