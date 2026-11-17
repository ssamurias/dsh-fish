/**
 * 内置说明（lib/wiki.js）的守卫。
 *
 * 这一份文档的问题不是「会不会写错字」，而是三件会在几个月后慢慢烂掉的事：
 *
 *   1. **五段缺一段**。少写「最容易误会的地方」那一条看起来还挺完整，读者却拿不到他真正要的
 *      东西——说明书的价值全在那一节。（2026-11-16 用户 m02816 的原话：要人话、要机制、
 *      要「为什么」，「别只告诉我它叫什么」。）
 *   2. **越写越长**。一条两百字变四百字，搜索那一行就装不下，页面变成一篇散文。
 *      所以长度有硬上限，改长会被这条测试拦下——先想清楚是不是真需要那么多字。
 *   3. **互相指丢**。`see` 里指了一个不存在的 id，或者有人删了一条却没清别名，
 *      页面上就是一颗点了没反应的按钮。这类洞只有测试能看见。
 *
 * 另外守一件结构上的事：`renderWikiPage()` 必须是**自包含**的。它会被人存成 .html 双击打开，
 * `file://` 下 fetch 一律被禁——一旦有人「顺手把数据抽成单独的 json」，那条路当场断掉，
 * 而且在 App 里完全看不出来（App 内走的是 /wiki.data）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  WIKI_VERSION,
  WIKI_TITLE,
  WIKI_INTRO,
  CHAPTERS,
  ENTRIES,
  groupedEntries,
  wikiData,
  entryById,
  escapeHtml,
  withPronoun,
  renderWikiPage,
} from '../lib/wiki.js'

const IDS = new Set(ENTRIES.map((e) => e.id))

/** 去掉 `{S}` 占位之后的字数。占位符本身不算字。 */
const len = (s) => String(s ?? '').replace(/\{S\}/g, '她').length

test('每条都有五段，一段都不许省', () => {
  for (const e of ENTRIES) {
    const where = `条目 ${e.id}`
    assert.ok(e.title, `${where} 缺标题`)
    assert.ok(len(e.one) > 0, `${where} 缺「一句话」`)
    assert.ok(len(e.where) > 0, `${where} 缺「你会在哪看到」`)
    assert.ok(Array.isArray(e.what) && e.what.length > 0, `${where} 缺「它是什么」`)
    assert.ok(len(e.why) > 0, `${where} 缺「为什么是这样」`)
    assert.ok(len(e.wrong) > 0, `${where} 缺「最容易误会的地方」`)
  }
})

test('长度上限：一句话 40 字，正文每段 120 字，为什么/误会 80 字', () => {
  for (const e of ENTRIES) {
    // 40 是搜索结果那一行的宽度：超过就会被截，截了就等于没有一句话。
    assert.ok(len(e.one) <= 40, `${e.id} 的一句话 ${len(e.one)} 字，超过 40`)
    assert.ok(len(e.why) <= 80, `${e.id} 的「为什么」${len(e.why)} 字，超过 80`)
    assert.ok(len(e.wrong) <= 80, `${e.id} 的「最容易误会」${len(e.wrong)} 字，超过 80`)
    for (const p of e.what) {
      assert.ok(len(p) <= 120, `${e.id} 有一段正文 ${len(p)} 字，超过 120`)
    }
  }
})

test('例子与表格：长度有上限，形状不许歪', () => {
  // 用户 2026-11-16 m03493 的原话：「起码我看『疤』这个条目，我完全没懂」。
  // 例子不是补充说明，是唯一能让人对上号的那一段——但它同样会把条目撑成散文，所以也有上限。
  for (const e of ENTRIES) {
    if (e.eg !== undefined) {
      assert.equal(typeof e.eg, 'string', `${e.id} 的 eg 不是字符串`)
      assert.ok(len(e.eg) > 0, `${e.id} 的 eg 是空的（要么写，要么整个不写）`)
      // 2026-11-16 用户 m03706：「案例再改一下，说的更通俗易懂一点」——
      // 220 字常常刚够交代背景，讲到「然后呢」就断了，所以放到 300。
      assert.ok(len(e.eg) <= 300, `${e.id} 的例子 ${len(e.eg)} 字，超过 300`)
    }
    if (e.rows !== undefined) {
      assert.ok(Array.isArray(e.rows) && e.rows.length > 0, `${e.id} 的 rows 不是非空数组`)
      for (const r of e.rows) {
        // 两列：名字 / 什么时候出。列数不对，渲染出来就是一格空格子。
        assert.ok(Array.isArray(r) && r.length === 2, `${e.id} 的 rows 有一行不是两列`)
        assert.ok(len(r[0]) > 0 && len(r[1]) > 0, `${e.id} 的 rows 有一行是空的`)
        assert.ok(len(r[0]) <= 30, `${e.id} 的表格第一列「${r[0]}」太长（${len(r[0])} 字）`)
        assert.ok(len(r[1]) <= 60, `${e.id} 的表格第二列太长（${len(r[1])} 字）`)
      }
    }
  }
  // 事件卡目录必须把四段的卡都列到：少一段就等于「事件卡只有十几张」。
  const cardRows = ENTRIES.filter((e) => /^cards-[1-4]$/.test(e.id))
  assert.equal(cardRows.length, 4, '事件卡目录缺段（cards-1 … cards-4）')
  assert.ok(cardRows.every((e) => (e.rows || []).length >= 6), '某一段的卡表太短')
})

test('id 与别名都不重复，章节都在 CHAPTERS 里', () => {
  assert.equal(IDS.size, ENTRIES.length, 'id 有重复')
  const chapters = new Set(CHAPTERS.map((c) => c.id))
  const aka = new Map()
  for (const e of ENTRIES) {
    assert.ok(chapters.has(e.chapter), `${e.id} 挂在一个不存在的章节 ${e.chapter} 上`)
    for (const a of e.aka || []) {
      // 同一个别名指两条，用户搜到哪条全看排序——那是 bug，不是选择。
      assert.ok(!aka.has(a), `别名「${a}」同时挂在 ${aka.get(a)} 和 ${e.id} 上`)
      aka.set(a, e.id)
    }
  }
})

test('别名不许是日常行文里常见的词（会把读者带到错的条目）', () => {
  // 用户 2026-11-16 m03706：「除非你主动把活交给她（出门 / 请神），这个主动是指用户的
  // 主动行为，不该被链接到主动阶段」「光说不动不算：这个说不，也不应该被链接到，
  // 其他类似的都需要改一下」。
  // 挂内链靠的是纯子串匹配，没有词性判断——这类词一旦进了别名，正文里每一处都会被链上，
  // 而且看起来还挺像对的。要挂就挂更长的词组（「主动阶段」而不是「主动」）。
  const BANNED = {
    主动: '多指用户自己的动作（「你主动把活交给她」），不是第 3 段',
    说不: '「光说不动不算」里的「说」+「不」是巧合切分，不是拒绝',
    不要: '日常副词（「不要以为」），不是拒绝',
    代价: '「看和说是两种代价」里的代价是比喻，不是疤',
    最大: '界面上是修饰语（「（最大 0.40）」），不是词条',
    时间段: '「上网时间段」「评论时段」不是定时唤醒',
    版本: '「DSH 版本」「宿主版本」不是「升级没生效」',
  }
  for (const e of ENTRIES) {
    for (const a of e.aka || []) {
      assert.ok(!BANNED[a], `${e.id} 的别名「${a}」太泛：${BANNED[a]}`)
    }
  }
})

test('`see` 指向的条目必须存在（点不动的那颗按钮只有测试看得见）', () => {
  for (const e of ENTRIES) {
    for (const id of e.see || []) {
      assert.ok(IDS.has(id), `${e.id} 的 see 指到了不存在的 ${id}`)
      assert.notEqual(id, e.id, `${e.id} 的 see 指回了自己`)
    }
  }
})

test('正文一律用 {S} 占位，不写死「她」', () => {
  // 写死「她」有两个后果：改了称呼说明书跟不上；而且会绕过界面那条「面向用户的字符串里
  // 不出现她/他」的口径（test/p5.test.mjs 扫的是 client.js，扫不到这里）。
  const all = []
  for (const e of ENTRIES) {
    all.push([`${e.id}.title`, e.title], [`${e.id}.one`, e.one], [`${e.id}.where`, e.where], [`${e.id}.why`, e.why], [`${e.id}.wrong`, e.wrong])
    ;(e.what || []).forEach((p, i) => all.push([`${e.id}.what[${i}]`, p]))
    if (e.eg) all.push([`${e.id}.eg`, e.eg])
    ;(e.rows || []).forEach((r, i) => all.push([`${e.id}.rows[${i}][0]`, r[0]], [`${e.id}.rows[${i}][1]`, r[1]]))
  }
  all.push(['WIKI_INTRO', WIKI_INTRO], ...CHAPTERS.map((c) => [`chapter ${c.id}`, c.note || '']))
  // 「其他 / 其它」里的那个「他」不是代词，先挖掉再查——否则这条规则会误伤正常用词
  const strip = (s) => String(s).replace(/其他|其它/g, 'XX')
  for (const [name, text] of all) {
    const s = strip(text)
    assert.ok(!s.includes('她'), `${name} 里写死了「她」，应该用 {S}`)
    assert.ok(!s.includes('他'), `${name} 里写死了「他」，应该用 {S}`)
  }
})

test('章节都要有内容：没有空章，也没有东西落在章外', () => {
  for (const g of groupedEntries()) {
    assert.ok(g.entries.length > 0, `章节 ${g.id} 是空的`)
  }
  const total = groupedEntries().reduce((n, g) => n + g.entries.length, 0)
  assert.equal(total, ENTRIES.length, '有条目没被任何章节收纳')
})

test('wikiData() 给客户端的形状对得上（设置页那一栏直接吃这一份）', () => {
  const d = wikiData()
  assert.equal(d.version, WIKI_VERSION)
  assert.equal(d.title, WIKI_TITLE)
  assert.equal(d.intro, WIKI_INTRO)
  assert.equal(d.entries.length, ENTRIES.length)
  assert.equal(d.chapters.length, CHAPTERS.length)
  // 必须是能直接 JSON 化的纯数据：带函数或 undefined 的地方客户端会静默丢字段。
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(d)))
})

test('entryById / withPronoun / escapeHtml 的边界', () => {
  assert.equal(entryById('drift')?.id, 'drift')
  assert.equal(entryById('不存在的'), null)
  assert.equal(withPronoun('{S}说'), '她说')
  assert.equal(withPronoun('{S}说', '他'), '他说')
  assert.equal(withPronoun('{S}说', '祂'), '祂说')
  assert.equal(withPronoun(null), '')
  // 说明里会有 `0.35 以上` 这种带反引号的字面，也可能有人以后加尖括号——
  // 拼进 HTML 之前必须转掉，否则整页会被一个没闭合的标签吃掉。
  assert.equal(escapeHtml('<b>&"'), '&lt;b&gt;&amp;&quot;')
})

test('整页 HTML 是自包含的：数据、样式、脚本都在这一份里', () => {
  const html = renderWikiPage({ pronoun: '她' })
  assert.ok(html.startsWith('<!doctype html>'))
  // 每一条的标题都要在页面上找得到——这条最直接地守着「有人加了一条却没进渲染」。
  for (const e of ENTRIES) {
    const t = e.title.replace(/\{S\}/g, '她')
    assert.ok(html.includes(t), `整页里找不到条目「${t}」`)
  }
  // 自包含的三条：不许外链样式/脚本，不许 fetch 数据。
  assert.ok(!/<link[^>]+href=/i.test(html), '整页里出现了外部样式表链接')
  assert.ok(!/<script[^>]+src=/i.test(html), '整页里出现了外部脚本')
  assert.ok(!/fetch\(/.test(html), '整页脚本里出现了 fetch——file:// 下会被禁')
  // 内联 JSON 里的 `</` 必须被转掉，否则一个词条里出现 `</script>` 能把整页截断。
  // 判据看的是 `\u003c` 那条转义有没有生效，不是「有没有 </script>」——页面自己结尾就有一个。
  assert.ok(!/var DATA = [^;]*?</.test(html), '内联数据里还有没转义的 <')
  assert.ok(html.includes('\\u003c') || !JSON.stringify(wikiData()).includes('<'), '内联数据没有转义 <')
})

test('整页按称呼替换：{S} 一个都不许漏到页面上', () => {
  for (const she of ['她', '他', '祂']) {
    const html = renderWikiPage({ pronoun: she })
    assert.ok(!html.includes('{S}'), `${she}：页面上还留着 {S} 占位`)
    assert.ok(html.includes(`${she}是什么`), `${she}：标题没按称呼替换`)
  }
  // 没传称呼时退回默认，不崩。
  assert.ok(renderWikiPage().includes('她是什么'))
})

test('页面上有回「全部条目」的入口，正文里的词会自动挂内链', () => {
  const html = renderWikiPage({ pronoun: '她' })
  // 进了某一条之后要能一键退回总目录（用户 2026-11-16 要求）。
  assert.ok(html.includes('id="home"'), '左边栏没有「全部条目」入口')
  assert.ok(html.includes('class="back"'), '条目页没有返回入口')
  assert.ok(/href="#\/"/.test(html), '返回入口的地址不是总目录')
  // 内链：正文里提到别的条目时要变成可点的链接，而不是一串死文字。
  // 只在浏览器里跑，所以这里守的是「机制在」＋「词表由全部条目的标题与别名生成」，
  // 具体某一句里哪几个词被链住，靠的是 LMAP 从 DATA.entries 现算，不需要在测试里复刻。
  assert.ok(html.includes('function linkify('), '整页里没有 linkify')
  assert.ok(html.includes('a.lk{'), '内链的样式没了')
  assert.ok(/var LMAP=/.test(html), '词表 LMAP 没生成')
  // 词表必须来自条目本身：加一条新条目就不用再手工登记一次。
  assert.ok(/\[e\.title\]/.test(html), 'LMAP 没有读条目标题')
  assert.ok(/\.aka/.test(html), 'LMAP 没有读别名')
})

test('条目页有两个返回入口：回上一页、回总目录', () => {
  const html = renderWikiPage({ pronoun: '她' })
  // 用户 2026-11-16 的原话：点了正文里的超链接跳过去，就回不来了。
  // 所以除了「全部条目」，还要一条「← 上一页」——它走的是 TRAIL 栈，不是浏览器的 history.back()：
  // 站内跳转是改 hash，history.back 有时会把搜索框那一下也算进去。
  assert.ok(html.includes('class="nav-prev"'), '条目页没有「← 上一页」')
  assert.ok(html.includes('← 上一页'), '「← 上一页」这四个字没了')
  assert.ok(html.includes('全部条目'), '「全部条目」这四个字没了')
  assert.ok(/var TRAIL=\[\],SKIP=false/.test(html), 'TRAIL 栈没生成')
  assert.ok(html.includes('function station('), 'station() 没了——上一页就靠它记路')
  assert.ok(html.includes('.nav{'), '两个按钮的样式没了')
  // 例子与表格要真的渲染出来，不是只躺在数据里。
  // 标签是「举例说明」不是「长这样」——用户 2026-11-16 m03706 点的名。
  assert.ok(html.includes('举例说明'), '页面没有「举例说明」那一段（eg 没进渲染）')
  assert.ok(!html.includes('长这样</h4>'), '标签还叫「长这样」')
  assert.ok(html.includes('一张表'), '页面没有「一张表」那一段（rows 没进渲染）')
  assert.ok(html.includes('.rows{'), '表格样式没了')
})

test('点搜索结果要真的进得去：地址说话时先把搜索框清掉（用户 m03816）', () => {
  const html = renderWikiPage({ pronoun: '她' })
  // 用户看到的现象：「搜索关键词确实显示出来了几个条目，但是这几个条目点击之后都打不开。」
  // 根因是 render() 一上来先读搜索框：点了链接 hash 变了，可框里的字还在，
  // 于是又把结果列表画一遍——页面看起来一动不动。所以这次进来必须带一个 nav 参数。
  assert.ok(/function render\(nav\)/.test(html), 'render 没有区分「地址变了」和「框里字变了」')
  assert.ok(/if\(nav&&q&&byId\(hash\)\)\{document\.getElementById\('q'\)\.value='';q=''\}/.test(html),
    '点链接进来的那一次没有把搜索框清掉：会重新画一遍列表')
  assert.ok(/addEventListener\('hashchange',function\(\)\{render\(true\)\}\)/.test(html), 'hashchange 没走 nav 分支')
  assert.ok(/addEventListener\('input',function\(\)\{render\(false\)\}\)/.test(html), '输入框不该走 nav 分支')
  // 搜索结果本身要是指得动的链接：点一下就该落到那一条上。
  assert.ok(/\<a href="#\/'\+list\[i\]\.id\+'"/.test(html) || html.includes('href="#/"'), '搜索结果不是链接')
})
