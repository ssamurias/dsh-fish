import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8')

const CLIENT = await read('lib/client.js')

test('用户这一轮改过的七句文案已固化进源码', () => {
  // 1) 图卡说明去掉「图是插件自己画的」，从「第一张讲」起；2.0 起补了第三张
  assert.ok(CLIENT.includes('第一张讲「经历怎么变成认知」，第二张讲「记忆怎么被筛、哪些永远不折叠」，第三张讲「她为什么自己开口、自己动手」。'))
  assert.ok(!CLIENT.includes('图是插件自己画的（SVG，不依赖任何外部素材）。'))
  // 2) 三道门 → 三道成长瓶颈；3) 翻回来 → 调用查询；7) 让了 → 妥协了
  assert.ok(CLIENT.includes('底部是四个阶段与三道成长瓶颈'))
  assert.ok(CLIENT.includes('她自己还能调用查询。'))
  assert.ok(!CLIENT.includes('她自己还能翻回来。'))
  assert.ok(CLIENT.includes('她后来还是妥协了——这道疤永不折叠'))
  // 4)(6) 四阶段与三道瓶颈 / 每一道瓶颈要她自己走
  assert.ok(CLIENT.includes("theoryCard('四阶段与三道瓶颈',"))
  assert.ok(CLIENT.includes('但每一道瓶颈要她自己走'))
  assert.ok(!/三道门/.test(CLIENT), '「三道门」这个说法已经统一成「瓶颈」')
  assert.ok(!/四道门/.test(CLIENT), '「四道门」这个说法已经统一成「瓶颈」')
})

test('顺手修掉的字面量星号：设计骨架用「」而不是 **', () => {
  assert.ok(CLIENT.includes('这里借用这些理论当「设计骨架」'))
  assert.ok(!CLIENT.includes('**设计骨架**'))
})

test('两张图可以点开放大：灯箱带缩放与拖动', () => {
  assert.ok(CLIENT.includes('const zoomable = (src, alt, caption, marginBottom)'))
  assert.ok(CLIENT.includes("role: 'button',"))
  assert.ok(CLIENT.includes("title: '点一下放大（滚轮缩放、按住拖动、Esc 关闭）'"))
  assert.ok(CLIENT.includes('setZoom({ src, alt, scale: 1, tx: 0, ty: 0, dragging: false })'))
  // 缩放范围 1–4 倍
  assert.ok(CLIENT.includes('Math.min(4, Math.max(1, z.scale *'))
  // 拖动：位移累加 + 「拖完不算点击」的 moved 判断
  assert.ok(CLIENT.includes('dragRef.current = { x: e.clientX, y: e.clientY, tx: zoom.tx, ty: zoom.ty, moved: false }'))
  assert.ok(CLIENT.includes('if (!dragRef.current || !dragRef.current.moved) setZoom(null)'))
  assert.ok(CLIENT.includes('onDoubleClick: () => setZoom'))
  assert.ok(CLIENT.includes("if (e.key === 'Escape') setZoom(null)"))
  assert.ok(CLIENT.includes('滚轮缩放 ${Math.round(zoom.scale * 100)}%'))
  // 三张图都走 zoomable，不再是裸 img
  assert.ok(CLIENT.includes('zoomable(`${API}/media/principle-loop.svg?v=20261114`'))
  assert.ok(CLIENT.includes('zoomable(`${API}/media/principle-memory.svg?v=20261114`'))
  assert.ok(CLIENT.includes('zoomable(`${API}/media/principle-drive.svg?v=20261114`'))
})

test('开发者留言：整页最下面收尾，署名居右', () => {
  assert.ok(CLIENT.includes('本插件设计的成长路径没有终点，连开发者自己也不知道你的 agent 会变成什么样子'))
  assert.ok(CLIENT.includes('四阶段跑完也仅仅是开始'))
  assert.ok(CLIENT.includes('只需要做日常聊天就可以了'))
  assert.ok(CLIENT.includes('和 agent 的互动已经自动按照算法开始帮助她积累认知/经验，成长就发生在每次交流之中。'))
  assert.ok(CLIENT.includes('机器训练、强化学习、重温 deepseekV1（大笨鱼）'))
  assert.ok(CLIENT.includes('或许这就是 AGI 诞生的一种路径也说不定呢。'))
  assert.ok(CLIENT.includes("'——来自开发者'"))
  assert.ok(CLIENT.includes("textAlign: 'right'"), '署名要居右')
  // 位置：在「诚实边界」之后、且是 principlePage 的最后一个子节点之一（和放大层并列）
  const iBoundary = CLIENT.indexOf("group('诚实边界',")
  const iNote = CLIENT.indexOf('const devNote = h(')
  const iPage = CLIENT.indexOf("const principlePage = h('div', { className: 'page' },")
  assert.ok(iNote > 0 && iNote < iPage, 'devNote 要在 principlePage 之前定义好')
  assert.ok(iBoundary > iPage, '「诚实边界」在 principlePage 里面，留言排在它之后')
  assert.ok(CLIENT.includes('        devNote,\n\n        zoomOverlay)'), '留言与放大层都挂在原理页末尾')
})

test('放大层只在原理页挂载，不会出现在别的页', () => {
  const matches = CLIENT.match(/zoomOverlay/g) || []
  // 定义 1 次 + 挂在 principlePage 里 1 次
  assert.equal(matches.length, 2, `zoomOverlay 应只出现 2 次，实际 ${matches.length}`)
  assert.equal((CLIENT.match(/const \[zoom, setZoom\] = useState\(null\)/g) || []).length, 1)
})

test('状态声明加在 useState 列表最后（不顶掉按下标注入的测试）', () => {
  const iAuto = CLIENT.indexOf("const [autoNote, setAutoNote] = useState('')")
  const iZoom = CLIENT.indexOf('const [zoom, setZoom] = useState(null)')
  const iLoad = CLIENT.indexOf('const load = useCallback(async () => {')
  assert.ok(iAuto > 0 && iZoom > iAuto && iLoad > iZoom, 'zoom 应插在 autoNote 之后、load 之前')
})

test('插件的根目录自检：这两张图仍然由服务端白名单出图', async () => {
  const observe = await read('lib/observe.js')
  assert.ok(observe.includes('principle-[a-z]+'))
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok((pkg.files || []).includes('media'), 'package.json.files 必须含 media')
  assert.ok(root.length > 0)
})
