/**
 * principle.test.mjs —— 原理页 + 两张自制 SVG（2026-10-25）
 *
 * 守五件事：
 *   1. 两张图真的在包里（`media/principle-*.svg`），且是合法 XML 片段（标签闭合、无裸 &）；
 *   2. 出图走服务端白名单路由，客户端不内联图（bundle 已经十多万字节，别再塞 SVG）；
 *   3. 页签顺序：插件 → 原理 → 数据（2026-10-25 文案页下线，原理仍夹在设置页与数据页之间）；
 *   4. 页面上把理论出处写全了（提出者不是装饰，改设计前要能看见）；
 *   5. 图与页面都不出现男字旁代词（沿用 p5 的口径）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const CLIENT = join(ROOT, 'lib', 'client.js')
const OBSERVE = join(ROOT, 'lib', 'observe.js')
const LOOP = join(ROOT, 'media', 'principle-loop.svg')
const MEMORY = join(ROOT, 'media', 'principle-memory.svg')
const DRIVE = join(ROOT, 'media', 'principle-drive.svg')
const PKG = join(ROOT, 'package.json')

test('三张原理图在包里，而且是完整的 svg', async () => {
  for (const [file, viewBox, must] of [
    // 图一 2026-10-25 重做：立场从底部一行字改成独立区块，画布 980 → 1160
    [LOOP, 'viewBox="0 0 1400 1160"', ['认知是怎么长出来的', '五步循环', '表态', '撞上', '落差', '改写', '回顾', '1 信任', '4 整合', '立场清单']],
    [MEMORY, 'viewBox="0 0 1400 980"', ['遗忘是怎么发生的', '记得很牢', '折叠 ≠ 删除', 'events.jsonl', 'her_recall']],
    // 图三 2026-11-14（1.0.1）：主动性的劲儿、桌子与两个出口
    [DRIVE, 'viewBox="0 0 1400 900"', ['她为什么会自己动起来', '劲从哪来', '这一轮开不开', '开口', '动手', '什么拦着', 'did:']],
  ]) {
    const svg = await readFile(file, 'utf8')
    assert.ok(svg.startsWith('<svg'), `${file} 必须以 <svg 开头`)
    assert.ok(svg.trimEnd().endsWith('</svg>'), `${file} 必须完整闭合`)
    assert.ok(svg.includes(viewBox), `${file} 要有固定 viewBox（大屏小屏都按比例缩）`)
    for (const word of must) assert.ok(svg.includes(word), `${file} 里缺少「${word}」`)
    // 裸 & 会把 SVG 变成解析错误（XML 里 & 必须转义）
    assert.ok(!/&(?!amp;|lt;|gt;|quot;|#)/.test(svg), `${file} 里有未转义的 &`)
    // 组标签必须成对，否则浏览器会静默截断后半张图
    const open = (svg.match(/<g[\s>]/g) || []).length
    const close = (svg.match(/<\/g>/g) || []).length
    assert.equal(open, close, `${file} 的 <g> 开合不配对：${open} vs ${close}`)
    assert.ok(!svg.includes('他'), `${file} 不许出现男字旁代词`)
  }
})

test('出图走服务端白名单路由，客户端不内联图', async () => {
  const ob = await readFile(OBSERVE, 'utf8')
  assert.ok(ob.includes("['/media', async (req, res)"), '必须有 /media 路由')
  // 2026-10-28：反馈页的交流群二维码也走这条白名单路由（只多放一个文件名，仍不做通用文件服务）。
  // 2026-11-14：原理页图片带 ?v= 版本号做缓存失效，路由要允许查询串。
  assert.ok(ob.includes('/^\\/dsh-fish\\/media\\/((?:principle-[a-z]+\\.svg)|(?:feedback-qr\\.jpg))'),
    '文件名必须白名单匹配')
  assert.ok(ob.includes('(?:\\?[^#]*)?$/'), '图片路由要放行 ?v= 查询串')
  // 2026-10-28 起同一条路由既出 svg 也出 jpg，类型按扩展名给，不再是一句写死的常量。
  assert.ok(ob.includes("'image/svg+xml; charset=utf-8'"), '必须声明 svg 类型')
  assert.ok(ob.includes("'image/jpeg'"), '二维码那张必须声明 jpeg 类型')
  assert.ok(ob.includes('fileURLToPath(new URL(`../media/'), '必须从包内 media/ 读文件')

  const cl = await readFile(CLIENT, 'utf8')
  assert.ok(cl.includes('`${API}/media/principle-loop.svg?v=20261114`'), '图一必须走 /media 路由')
  assert.ok(cl.includes('`${API}/media/principle-memory.svg?v=20261114`'), '图二必须走 /media 路由')
  assert.ok(cl.includes('`${API}/media/principle-drive.svg?v=20261114`'), '图三必须走 /media 路由')
  assert.ok(cl.includes('`${API}/media/feedback-qr.jpg`'), '反馈页二维码必须走 /media 路由，不引外链')
  assert.ok(!cl.includes('<svg'), '客户端里不许内联 SVG（会让 bundle 无谓变大）')
})

test('页签顺序：插件 → 原理 → 数据 → 反馈；出门排在「上网」和「记忆」中间（对所有人可见）', async () => {
  const cl = await readFile(CLIENT, 'utf8')
  const tabs = cl.match(/const TABS = \[([\s\S]*?)\n {6}\]/)
  assert.ok(tabs, '必须能定位到 TABS')
  const ids = [...tabs[1].matchAll(/\['([a-z]+)', '[^']+'\]/g)].map((m) => m[1])
  // 2026-10-28 用户要求加第 9 个页签「反馈」（开发者 QQ + 交流群二维码），排在最后；
  // 出门页从 2026-10-30（用户 m01904）起对所有人可见，2026-10-30（m02207）挪到「上网」和「记忆」之间。
  assert.deepEqual(ids, ['now', 'grow', 'home', 'bili', 'outing', 'memory', 'env', 'principle', 'data', 'feedback'])
  // 门从「藏页签」改成「页面里一次性确认」：说明卡没点过，三个入口按钮先灰着。
  assert.ok(!cl.includes('const [devMode, setDevMode] = useState(null)'), '不再有藏页签的 devMode 开关')
  assert.ok(cl.includes('...TABS.map(([id, name]) =>'), '页签栏不过滤，出门页常驻')
  assert.ok(cl.includes('const outingAck = outing?.ack === true'), '页面要读一次性确认')
  assert.ok(cl.includes("jpost('/outing', { action: 'ack' })"), '确认按钮要能写回 ack')
  assert.ok(cl.includes("groupFull('先确认一下'"), '没确认时要有一张确认卡')
  // 收起的是入口，不是功能：说明、页面、渲染树都还在，重新放出来不用重写。
  assert.ok(cl.includes("outing: '出门："), 'TAB_HELP 必须有出门页说明')
  assert.ok(/showTab\('outing'\) \? outingPage : null/.test(cl), '出门页要挂进渲染树')
  assert.ok(cl.includes('const outingPage = h('), '出门页面代码要保留')
  // 动作面板不是配置：不许进 AUTO_SAVE_TABS（否则会多一句「改完就生效」的错误提示）
  assert.ok(!/AUTO_SAVE_TABS = new Set\(.*outing/.test(cl), '出门不进自动保存页签')
  assert.ok(cl.includes("principle: '原理："), 'TAB_HELP 必须有原理页说明')
  assert.ok(cl.includes("showTab('principle') ? principlePage : null"), '必须真的挂上渲染')
  assert.ok(cl.indexOf("showTab('principle')") > cl.indexOf("showTab('env')"), '原理在插件之后')
  assert.ok(cl.indexOf("showTab('principle')") < cl.indexOf("showTab('data')"), '原理在数据之前')
})

test('原理页把理论出处写全了', async () => {
  const cl = await readFile(CLIENT, 'utf8')
  for (const name of [
    'Kolb 经验学习圈', 'Piaget 失衡', 'Bowlby 依恋理论', 'Erikson 心理社会发展',
    'Festinger 认知失调', 'Bartlett 重构记忆', 'Cowan 工作记忆容量', 'Tulving 线索依赖遗忘',
    'Bjork 遗忘的适应功能', 'Dewey 经验连续性', 'Schön 反思性实践', 'Vygotsky 最近发展区',
    'Bloom 掌握学习', 'Metzinger 自我模型',
    'Deci & Ryan 自我决定论', 'White 效能动机', 'Horvitz 中断成本',
    'Domhoff 梦的连续性假设', 'Wamsley 离线重组',
    'Roediger & Karpicke 提取练习', 'Cepeda 间隔效应',
    'Hidi & Renninger 兴趣发展', 'Zajonc 单纯曝光',
    'Thaler & Shefrin 计划者-行动者',
  ]) {
    assert.ok(cl.includes(name), `原理页必须提到「${name}」`)
  }
  for (const scene of ['学习', '认知重构', '人格养成']) {
    assert.ok(cl.includes(scene), `用途里必须有「${scene}」`)
  }
  assert.ok(cl.includes('诚实边界'), '必须写明这只是借理论当骨架')
  assert.ok(!/他/.test(cl.slice(cl.indexOf('const principlePage'), cl.indexOf('const envPage'))), '原理页文字不许出现男字旁代词')
})

test('package.json 会一起发布 media/', async () => {
  const pkg = JSON.parse(await readFile(PKG, 'utf8'))
  assert.ok(pkg.files.includes('media'), 'files 里必须带上 media，否则装出去没有图')
})
