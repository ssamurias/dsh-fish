/**
 * ui.test.mjs —— 设置页的四处「看得见」的修正（2026-10-24 晚）
 *
 * 为什么单开一个文件：这四条都不是逻辑，是**界面上的坑**——
 * 数字框能打超出上下限的值、历史列表只给前 8 条、封面图永远 404、
 * 日志预览框高到把整页撑长。这些在 node 侧跑不出错，只能靠源码断言守住。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(HERE, '..', 'lib', 'client.js')
const OBSERVE = join(HERE, '..', 'lib', 'observe.js')

test('数字框：打字超范围后离开输入框会收敛回上下限', async () => {
  const src = await readFile(CLIENT, 'utf8')
  assert.ok(src.includes("onBlur: (e) => o.onChange(clamp(e.target.value))"), '要有一个 onBlur 收敛')
  assert.ok(src.includes('Number.isFinite(v) ? v : o.min'), '清空/非数字要落到下限，不能显示 NaN')
})

test('封面：lazyCover 从 view() 的 data 里取 pic', async () => {
  const src = await readFile(OBSERVE, 'utf8')
  // view() 返回 { ok, code, data:{ pic } }；直接读 v.pic 永远是 undefined，
  // 于是 /dsh-fish/cover/<BV> 一路 404，被 <img onError> 静默藏掉。
  assert.ok(src.includes('v?.data?.pic || v?.pic'), '要从 data 里取 pic')

  // 第二个根因（2026-10-24）：lazyCover 里还动态 import 过 owner.js 的 readOwner，
  // 那个文件没有这个导出，一调就 TypeError 被外层 catch 吞掉 —— 封面同样 404。
  assert.ok(!src.includes("await import('./owner.js')"), 'owner.js 没有 readOwner，别再动态导入它')
})

test('观看历史：条目全部摊平后再分页，没有「只给前 8 条」', async () => {
  const src = await readFile(CLIENT, 'utf8')
  // 2026-10-28（用户 m00416）：从「按天分组、一天只给前 8 条」改成
  // 「所有天的条目摊平 → 按条翻页，一页 12 条」。所以不许再有 slice(0, 8)，
  // 并且必须把每组的 items 全部摊进来（不是取第一条、也不是截前几条）。
  assert.ok(!src.includes('g.items.slice(0, 8)'), '旧的 slice(0, 8) 已经拿掉')
  assert.ok(src.includes('const histFlat = (hist?.groups || []).flatMap('), '要先按天摊平全部条目')
  assert.ok(src.includes('(g.items || []).map((it) => ({ ...it, date: g.date }))'), '一天里的每条都要进摊平结果')
  assert.ok(src.includes('const histPageSize = histTotal === 0 ? HIST_PAGE_MAX'), '每页条数按实际量算，不是死数')
  assert.ok(src.includes('histPerDay > 20 ? 6'), '刷得越密每页越短')
  // 翻页条要真的能点：两个方向各一个按钮，并且到头会禁用
  assert.ok(src.includes("onClick: () => setHistPage(histAt - 1) }, '较新')"), '要有「较新」按钮')
  assert.ok(src.includes("onClick: () => setHistPage(histAt + 1) }, '更早')"), '要有「更早」按钮')
  assert.ok(src.includes('`第 ${histAt + 1} / ${histPages} 页 · 一页 ${histPageSize} 条`'), '要显示第几页 / 共几页，以及这一页几条')
  assert.ok(!/const histAt = histPage\\b/.test(src), '页码要收敛在有效范围内（Math.min）')
})

test('查看文件夹：悬停要说清「只复制路径，不弹窗口」', async () => {
  const src = await readFile(CLIENT, 'utf8')
  assert.ok(src.includes('点了只是把这个文件夹的路径复制到剪贴板'))
  assert.ok(src.includes('不会弹窗口'))
})

test('运行日志预览：4~5 行高 + 内部滚动', async () => {
  const src = await readFile(CLIENT, 'utf8')
  assert.ok(src.includes("maxHeight: '104px'"), '预览框只有 4~5 行高')
  assert.ok(!src.includes("maxHeight: '220px'"), '旧的高框已经拿掉')
})

test('关于卡：GitHub 商标小图 + 「GitHub」文字（2026-10-25 用户要求）', async () => {
  const src = await readFile(CLIENT, 'utf8')
  // 用户点名要「github 的商标小图 + "github" 的文字」，不是纯文字链接。
  assert.ok(src.includes('const ghMark'), '要有内联的 GitHub 商标 svg')
  assert.ok(src.includes("viewBox: '0 0 16 16'"), '商标用官方 16×16 视框')
  // 图标必须内联、不引外链：设置页不该为一个图标等网络，也不该一打开就往外发请求。
  assert.ok(!/src:\s*['"]https?:/.test(src), '图标不能是远程图片')
  assert.ok(!src.includes('github.com/ssamurias/dsh-fish/logo'), '不要引远程 logo')
  // 文字必须恰好是 GitHub（大小写按用户说的）
  assert.ok(/ghMark,\s*'GitHub'/.test(src), '图标后面要跟「GitHub」这几个字')
  // 链接指向仓库，新窗口打开且带 noopener
  assert.ok(src.includes('https://github.com/ssamurias/dsh-fish'), '要指向仓库地址')
  assert.ok(src.includes("rel: 'noopener noreferrer'"), '外链必须带 noopener')
})

test('关于卡：检查更新按钮只在点击时查，不自动轮询', async () => {
  const src = await readFile(CLIENT, 'utf8')
  assert.ok(src.includes("jget('/update?ms=8000')"), '检查更新走 /update 路由')
  // 关键：不能放进 load() 的 Promise.all（那样一打开设置就天天往 GitHub 发请求）
  const loadBody = src.match(/const load = useCallback\(async \(\) => \{([\s\S]*?)\n {6}\}, \[\]\)/)
  assert.ok(loadBody, '要能定位到 load()')
  assert.ok(!loadBody[1].includes('/update'), 'load() 里不该自动查更新')
  // 也不能有定时器
  assert.ok(!src.includes("setInterval(() => checkUpdate"), '不许自动定时查更新')
})

test('关于卡：读不到当前版本时不谎报「已是最新」', async () => {
  const src = await readFile(CLIENT, 'utf8')
  assert.ok(src.includes('upd.known === false'), 'known=false 要有单独一条文案')
  // 那句人话要如实承认判断不了，而不是直接说"已经是最新的"
  assert.ok(src.includes('读不到自己装的版本号'), '要如实说明读不到版本')
})

test('插件页顺序：「关于」在「为什么默认只放这几个」之后（2026-10-25 用户定）', async () => {
  const src = await readFile(CLIENT, 'utf8')
  const body = src.match(/const envPage = h\('div', \{ className: 'page' \},([\s\S]*?)\n {6}\)\n/)
  assert.ok(body, '要能定位到 envPage')
  const order = ['toolsCard', '为什么默认只放这几个', 'aboutCard']
  let at = -1
  for (const item of order) {
    const next = body[1].indexOf(item)
    assert.ok(next > at, `「${item}」要排在上一项之后`)
    at = next
  }
  // 「关于」是这一页的收尾，不该插在工具说明中间
  assert.ok(!/toolsCard,\s*\n\s*aboutCard/.test(body[1]), '「关于」不能紧跟工具卡')
})

test('页签选中态不许拿正文墨色当底色（2026-10-25 深色主题下白块，浅色主题下黑块）', async () => {
  const src = await readFile(CLIENT, 'utf8')
  // brand-primary 其实是「正文墨色」：浅色主题 #0f1115（近黑），深色主题 #f9fafb（近白）。
  // 拿它当选中底色，就是一个跟主题反着来的大色块。所以：①不许写死 #fff；②不许拿它铺底。
  assert.ok(!/\.tab\.on\{[^}]*color:#fff/.test(src), '选中页签的字色不能写死 #fff')
  assert.ok(!/\.tab\.on\{[^}]*background:var\(--dsw-alias-brand-primary/.test(src),
    '选中页签的底色不许用 brand-primary（那是正文墨色，深浅主题都会反过来）')
  assert.ok(/\.tab\.on\{[^}]*color:var\(--dsw-alias-state-business-primary/.test(src),
    '选中页签要用真正的中性强调色 state-business-primary')
  assert.ok(!/\.badge\{[^}]*color:#fff/.test(src), '角标字色同理')
  assert.ok(!/button\.primary\{[^}]*color:#fff/.test(src), '主按钮字色同理')
})

test('反馈页：开发者 QQ + 群二维码都自带，不引外链（2026-10-28 用户要求）', async () => {
  const src = await readFile(CLIENT, 'utf8')
  // 二维码必须走插件自己的 /media 路由。群图挂在第三方图床上，图挂了这页就没用了。
  assert.ok(src.includes("src: `${API}/media/feedback-qr.jpg`"), '二维码要走 /media 路由')
  assert.ok(src.includes('1264518494'), '开发者 QQ 号要在页面上')
  // 2026-11-02：1 群满了，换成新建的 2 群（781084960）。
  assert.ok(src.includes('781084960'), '群号要在页面上（二维码扫不出来时的兜底）')
  assert.ok(!/feedback-qr[^`'"]*https?:\/\//.test(src), '二维码不许改成外链')
  // 页签必须真的挂进渲染树，否则源码里有、界面上点不到。
  assert.ok(/showTab\('feedback'\) \? feedbackPage : null/.test(src), '反馈页要挂进渲染树')
  assert.ok(/const feedbackPage = h\('div', \{ className: 'page' \}/.test(src), '要有 feedbackPage')
})

// ---------------------------------------------------------------------------
// 「手上能用什么」按来源分组（2026-11-04，issue #20）
//
// 以前这里只有一个逗号分隔的输入框：用户既不知道这台机器上到底有哪些工具，
// 也不知道该填哪个——只能去翻日志（issue 里那位翻了四小时）。
// 这几条守的是「分组真的挂进了渲染树」和「界面不说系统词」。
// ---------------------------------------------------------------------------

test('工具分组：四组 chips 都挂进 toolsCard，且排在白名单输入框之前', async () => {
  const src = await readFile(CLIENT, 'utf8')
  const cardStart = src.indexOf('const toolsCard = h(')
  assert.ok(cardStart > 0, '要能定位 toolsCard')
  const card = src.slice(cardStart, src.indexOf('// 导入卡（2026-10-27）'))
  assert.ok(card.includes('chipSection,'), '分组要真的挂进这张卡（源码里有、界面上点不到等于没做）')
  const chipAt = card.indexOf('chipSection,')
  const inputAt = card.indexOf("placeholder: '例如：skill, web_search, read_image")
  assert.ok(chipAt > 0 && inputAt > chipAt, '分组清单要摆在输入框上面：先给可点的，再留手工兜底')

  // 四组的标题必须在（组是空的就不摆，所以只查源码里有没有这四句）
  for (const t of [
    '她自己本来就有的（不用放行）',
    '这台机器上还有这些',
    '她本来就看得见、收窄挡不住的',
    '这一局被挡下来过',
  ]) {
    assert.ok(src.includes(t), `分组标题要在：${t}`)
  }
})

test('工具分组：页面一打开就拉 /tools（以前只在点保存时才拉，清单永远是空的）', async () => {
  const src = await readFile(CLIENT, 'utf8')
  const loadAt = src.indexOf('const load = useCallback(')
  assert.ok(loadAt > 0)
  const loadBody = src.slice(loadAt, loadAt + 6000)
  assert.ok(loadBody.includes("jget('/tools')"), 'load() 里要拉一次工具名单')
  // 四个字段都要灌进 state，缺一个界面上就有一组永远是空的
  for (const setter of ['setToolsKnown', 'setToolsOwnLayer', 'setToolsHerTools', 'setToolsBlocked']) {
    assert.ok(loadBody.includes(`${setter}(`), `load() 要灌 ${setter}`)
  }
})

test('工具分组：界面文案不出现「权限/禁止/违规」这类系统词', async () => {
  const src = await readFile(CLIENT, 'utf8')
  const cardStart = src.indexOf('const toolsCard = h(')
  const card = src.slice(cardStart, src.indexOf('// 导入卡（2026-10-27）'))
  assert.doesNotMatch(card, /权限|禁止|违规|没有授权/, '这是「白名单没放行」，不是「权限不足」')
})

test('工具分组：被挡过的名字不在别的组里重复出现', async () => {
  const src = await readFile(CLIENT, 'utf8')
  // 同一个名字在屏幕上出现两次，用户会以为它们是两个不同的东西
  assert.ok(src.includes('!blockedSet.has(n)'), 'known 那组要排掉被挡过的')
  assert.ok(src.includes('const ownList = (toolsOwnLayer ?? []).filter((n) => !blockedSet.has(n))'), 'own 那组同理')
})
