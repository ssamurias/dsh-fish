/**
 * client.js —— 观测台的浏览器半边（DSH「设置 → 鱼」里的一节）
 *
 * 为什么要有这一半（2026-10-22 定案）：
 *   宿主那半边 `observe.js` 注册的 `/dsh-fish/*` 路由是 JSON API，但**没有一个能点开的页面**——
 *   在浏览器里直接输 `/dsh-fish` 会被 connection 的信任栅栏挡成 401（它要的是 App 内的登录 cookie）。
 *   而 whale 的实证说明：**在 App 内部**（设置页里）同源 fetch 这些路由是通的，cookie 天然带着。
 *   所以观测台的正确形态是 settings.section，不是一个独立 HTML 页面。
 *
 * 数据流：section ⇄ 同源 fetch `/dsh-fish/*` ⇄ `~/.dsh-fish/`
 *   这里**只读 + 改环境**（时间窗、配额、日记可见性、冷落阈值），
 *   没有任何指向她本人的控件 —— 那是 B §8 的红线。
 */
window.__ModuleLoader__.load({
  // 这个 id 必须**等于 package.json 的包名**，不是短名：client-modules 用 loader
  // 条目名（完整包标识）去解析浏览器 bundle，注册时名字对不上，这一节就静默挂不上
  // ——宿主那半边照常跑，设置页却什么也不显示（2026-11-05 改名 @ssamurias/dsh-fish 后踩过）。
  id: '@ssamurias/dsh-fish',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { createElement: h, useCallback, useEffect, useRef, useState } = React

    // 插件 API 前缀不能写死 '/dsh-fish'：DSH 被反向代理挂在子路径下时
    // （如 /app/deepseek-harness/fngateway/），站点绝对路径会绕过前缀打 404（issue #132）。
    // 页面带 <base href="./"> 时 baseURI 就是子路径目录；根路径部署下仍是 '/dsh-fish'。
    // 宿主若注入 __DSH_BASE_PATH__，优先用它。
    const API = (() => {
      try {
        const injected = typeof window !== 'undefined' ? window.__DSH_BASE_PATH__ : undefined
        if (typeof injected === 'string' && injected.startsWith('/')) {
          const base = injected.replace(/\/+$/, '')
          return base ? `${base}/dsh-fish` : '/dsh-fish'
        }
        const base = typeof document !== 'undefined' ? document.baseURI : undefined
        if (!base) return '/dsh-fish'
        const dir = /\/$/.test(base) ? base : base.slice(0, base.lastIndexOf('/') + 1)
        return new URL('dsh-fish', dir).pathname.replace(/\/$/, '') || '/dsh-fish'
      } catch {
        return '/dsh-fish'
      }
    })()
    const NS = 'fish'

    // 「查多久的记录」的选项与本地存键（2026-11-07，用户反馈）。
    // 选项必须与服务端 /history 的夹值一致：以前这里给到 365，而 observe.js 与
    // history.js 都 `Math.min(180, …)`——选「一年」实际只拿到半年。现在两边都到 366。
    const HIST_DAYS_OPTIONS = [1, 7, 14, 30, 90, 180, 365]
    const HIST_DAYS_KEY = `${NS}.histDays`
    // 存/取「查多久的记录」（2026-11-07，用户反馈）：以前它只是组件里的 useState(14)，
    // 关掉设置页再打开就回到 14，看起来像配置丢了。浏览器里存 localStorage；
    // 宿主测试环境没有它（或隐私模式不让写），退回去也不影响别处。
    const readHistDays = () => {
      try {
        const n = Number(globalThis.localStorage?.getItem?.(HIST_DAYS_KEY))
        return HIST_DAYS_OPTIONS.includes(n) ? n : 14
      } catch { return 14 }
    }
    const storeHistDays = (n) => {
      try { globalThis.localStorage?.setItem?.(HIST_DAYS_KEY, String(n)) } catch { /* 存不下就算了 */ }
    }

    // ------------------------------------------------- 工具名白名单（2026-10-24）
    // 客户端就地实现一份，规则与 lib/settings.js 的 validateToolNames 一致
    // （那份是 node 模块，这边只能 require('react')，拿不到）。
    // 真正的拦截在服务端 /config：拼错的名字连盘都写不进去。
    const TOOL_NAME_RE = /^[a-z][a-z0-9_-]*$/
    function parseToolNames(input) {
      // 与 lib/settings.js 同一份规则：数组里夹带逗号也要再拆一次
      const raw = (Array.isArray(input) ? input : [input]).flatMap((x) => String(x ?? '').split(/[,，\s]+/))
      const seen = new Set()
      const out = []
      for (const x of raw) {
        const s = x.trim()
        if (!s || seen.has(s)) continue
        seen.add(s)
        out.push(s)
      }
      return out
    }
    function checkToolNames(input, known) {
      const names = parseToolNames(input)
      const set = Array.isArray(known) && known.length ? new Set(known.map(String)) : null
      const unknown = names.filter((n) => !TOOL_NAME_RE.test(n) || (set && !set.has(n)))
      return { ok: unknown.length === 0, names, unknown, checked: Boolean(set) }
    }

    // ------------------------------------------------- 本地时间（2026-11-03）
    // 事件里的 ts 是 UTC（toISOString() 带 Z）。以前界面直接 `String(ts).slice(0,16)`，
    // 切出来的是 UTC 那一刻，东八区看小纸条永远早 8 小时——而正文里她自己写的
    // 「现在十点多」又是对的，两边对不上（github:ssamurias/dsh-fish#19）。
    //
    // 客户端只能 require('react')，拿不到 lib/settings.js 的 dateKey，所以就地实现一份
    // （同上面 parseToolNames 的做法）。服务端那份在 lib/inbox.js 里，改规则时两边一起改。
    const pad2 = (n) => String(n).padStart(2, '0')
    /** @returns {'YYYY-MM-DD HH:MM'} 解析不出来时返回空串（宁可不印，也不印错） */
    function localStamp(ts) {
      const ms = Date.parse(String(ts ?? ''))
      if (!Number.isFinite(ms)) return ''
      const d = new Date(ms)
      return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
    }

    // ---------------------------------------------------------------- 样式
    const CSS_TAG = 'dsh-fish/section.css'
    const CSS = [
      '.dfish{color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:14px}',
      '.dfish h2{margin:0;font-size:16px;font-weight:500;line-height:24px}',
      '.dfish .sub{color:var(--dsw-alias-label-tertiary);font-size:12.5px;line-height:19px;margin:0}',
      '.dfish .card{border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px 14px}',
      '.dfish details.adv{grid-column:1/-1;margin-top:6px}',
      '.dfish details.adv>summary{cursor:pointer;font-size:12.5px;color:var(--dsw-alias-label-tertiary);list-style:none}',
      '.dfish details.adv>summary::-webkit-details-marker{display:none}',
      '.dfish details.adv>summary::before{content:"▸ ";}',
      '.dfish details.adv[open]>summary::before{content:"▾ ";}',
      '.dfish details.adv>summary:hover{color:var(--dsw-alias-label-primary)}',
      '.dfish details.adv .advbody{margin-top:8px;display:flex;flex-direction:column;gap:8px}',
      '.dfish .card>h3{margin:0 0 8px;font-size:12px;font-weight:600;letter-spacing:.06em;color:var(--dsw-alias-label-tertiary);text-transform:uppercase}',
      '.dfish .kv{display:grid;grid-template-columns:auto 1fr;gap:5px 14px;font-size:13px;line-height:19px}',
      '.dfish .kv b{color:var(--dsw-alias-label-tertiary);font-weight:400}',
      '.dfish ul{margin:0;padding-left:17px;font-size:13px;line-height:20px}',
      '.dfish li{margin:3px 0}',
      '.dfish .tag{display:inline-block;padding:0 6px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2);font-size:11px;color:var(--dsw-alias-label-tertiary);margin-left:6px}',
      // 工具分组胶囊（2026-11-04，issue #20）。以前只有一个逗号分隔的输入框，
      // 用户既不知道这台机器上到底有哪些工具，也不知道该填哪个——只能去翻日志。
      // 现在按来源分组摆出来，点一下就是加/减白名单，输入框退成手工兜底。
      '.dfish .chips{display:flex;flex-wrap:wrap;gap:6px;margin:5px 0 0}',
      '.dfish .chip{background:transparent;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-tertiary));font-size:11.5px;height:22px;padding:0 9px;cursor:pointer;white-space:nowrap}',
      '.dfish .chip:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}',
      '.dfish .chip.on{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary);background:rgba(128,128,128,.10)}',
      '.dfish .chip.her{cursor:default;opacity:.8}',
      '.dfish .chip.blk{border-style:dashed}',
      '.dfish .grouphd{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-tertiary);margin:11px 0 0}',
      // 折叠条（2026-11-04，用户反馈）：一百多个胶囊全摊开等于没有界面。
      // 按名字前缀分族、默认全收着，点哪族开哪族。
      '.dfish .famhd{display:flex;align-items:center;gap:6px;width:100%;height:24px;text-align:left;background:transparent;border:0;border-radius:6px;color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-tertiary));font-size:12px;line-height:18px;padding:0 4px;margin:3px 0 0;cursor:pointer}',
      '.dfish .famhd:hover:not(:disabled){background:rgba(128,128,128,.10);color:var(--dsw-alias-label-primary)}',
      '.dfish .famhd .famcaret{flex:none;width:9px;font-size:10px;opacity:.7}',
      '.dfish .famhd .famname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,Consolas,monospace}',
      '.dfish .famhd .famcnt{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.dfish .famhd.open .famname{color:var(--dsw-alias-label-primary)}',
      '.dfish .chipsnote{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-tertiary);background:rgba(128,128,128,.07);border-radius:6px;padding:6px 8px;margin:0 0 4px}',
      '.dfish pre{margin:0;white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,inherit);font-family:ui-monospace,Consolas,monospace}',
      '.dfish .empty{color:var(--dsw-alias-label-tertiary);font-size:13px;margin:0}',
      '.dfish .dim{color:var(--dsw-alias-label-tertiary);font-size:12px}',
      '.dfish .err{color:#e5484d;font-size:12.5px;white-space:pre-wrap}',
      '.dfish .ok{color:#30a46c;font-size:12.5px;white-space:pre-wrap}',
      '.dfish .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}',
      '.dfish .form{display:flex;flex-direction:column;gap:9px;font-size:13px}',
      '.dfish .form label{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.dfish input[type=number]{width:62px;background:transparent;border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);font-size:12.5px;height:26px;padding:0 7px;outline:none}',
      '.dfish input[type=text]{flex:1;min-width:200px;background:transparent;border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);font-size:12.5px;height:26px;padding:0 7px;outline:none}',
      '.dfish button{background:transparent;border:.5px solid var(--dsw-alias-border-l2);border-radius:7px;color:var(--dsw-alias-label-primary);font-size:12.5px;height:28px;padding:0 12px;cursor:pointer}',
      '.dfish button:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}',
      '.dfish button:disabled{opacity:.5;cursor:default}',
      '.dfish textarea{width:100%;box-sizing:border-box;min-height:66px;resize:vertical;background:transparent;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;padding:8px 10px;outline:none}',
      // 卡片内的两格切换（扫码 / 粘贴 cookie，2026-11-02）。
      // 刻意不复用页面顶部那套 .tabs/.tab：那是导航栏的类名，卡片里再套一层
      // 会渲染成「多了一行页面页签」，而且下面 85~96 行同名定义会把它逐条覆盖掉。
      '.dfish .seg{display:inline-flex;gap:2px;padding:2px;margin:0 0 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:rgba(128,128,128,.06)}',
      '.dfish .seg>button{height:24px;padding:0 11px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-tertiary));font-size:12px}',
      '.dfish .seg>button:hover:not(:disabled):not(.on){background:rgba(128,128,128,.12);color:var(--dsw-alias-label-primary);border:0}',
      '.dfish .seg>button.on{background:rgba(128,128,128,.18);color:var(--dsw-alias-state-business-primary);font-weight:500}',
      '.dfish .seg>button.on:hover{color:var(--dsw-alias-state-business-primary);background:rgba(128,128,128,.24)}',
      '.dfish .said{white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:21px;border-left:2px solid var(--dsw-alias-border-l2);padding-left:10px;margin:6px 0}',
      '.dfish .badge{display:inline-block;min-width:16px;text-align:center;padding:0 5px;border-radius:999px;background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-inverted,#fff);font-size:10.5px;line-height:16px;margin-left:6px}',
      '.dfish .tabs{display:flex;align-items:center;gap:6px;flex-wrap:wrap;border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;padding:5px;background:rgba(128,128,128,.06)}',
      '.dfish .tab{background:transparent;border:.5px solid transparent;border-radius:7px;height:28px;padding:0 11px;font-size:12.5px;color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-tertiary));cursor:pointer}',
      '.dfish .tab:hover{color:var(--dsw-alias-label-primary);background:rgba(128,128,128,.12)}',
      // 选中态踩过两次坑（2026-10-25 用户真机截图暴露）：
      // ① 最初写死 color:#fff —— 深色主题下白字压白底，整片看不见；
      // ② 改成 brand-primary 当底色 —— 那其实是「正文墨色」（浅色 #0f1115 近黑 / 深色 #f9fafb 近白），
      //    于是浅色主题出现黑块、深色主题出现白块，仍然难看。
      // 正确做法：底色只用中性的浅罩层，强调靠 state-business-primary 的字色和描边。
      '.dfish .tab.on{background:rgba(128,128,128,.18);border-color:var(--dsw-alias-border-l3);color:var(--dsw-alias-state-business-primary);font-weight:500}',
      '.dfish .tab.on:hover{color:var(--dsw-alias-state-business-primary);background:rgba(128,128,128,.24)}',
      '.dfish .tabs .grow{flex:1}',
      '.dfish .tabhint{font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-tertiary);margin:-6px 0 0}',
      '.dfish .page{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:14px;align-items:start}',
      '.dfish .page>.card{min-width:0}',
      '.dfish .card.full{grid-column:1 / -1}',
      '.dfish .grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px 18px}',
      '.dfish .fld{display:flex;flex-direction:column;gap:5px;min-width:0}',
      '.dfish .fl{display:flex;flex-direction:column;gap:2px}',
      '.dfish .flabel{font-size:13px;line-height:19px}',
      // 2026-11-08：hint 里可以用换行分段（E9 那行挑评论的规则要单独一行）。
      '.dfish .fhint{font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-tertiary);white-space:pre-line}',
      '.dfish .hint{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-tertiary);margin:0}',
      '.dfish .warn{font-size:12px;line-height:18px;color:#b8860b;margin:6px 0}',
      // 下拉框（2026-10-25 用户真机反馈：暗色下「只有一个白条」，字全看不见）。
      // 根因：select 背景写的是 transparent，原生控件在深色主题里会用 UA 白底绘制，
      // 而字色是 label-primary（深色主题下接近白）——白底白字。option 弹层同理。
      // 修法：底色改成主题的不透明层色，option 显式给同一组底色/字色，
      // color-scheme 继承 <html> 上宿主设的 dark/light（原生弹层跟着切换）。
      '.dfish select{height:28px;border:.5px solid var(--dsw-alias-border-l2);border-radius:7px;background-color:var(--dsw-alias-bg-layer-1,Field);color:var(--dsw-alias-label-primary,CanvasText);color-scheme:inherit;font-size:12.5px;padding:0 8px;outline:none;cursor:pointer;max-width:240px}',
      '.dfish select option{background-color:var(--dsw-alias-bg-layer-1,Field);color:var(--dsw-alias-label-primary,CanvasText)}',
      '.dfish input[type=time]{height:28px;border:.5px solid var(--dsw-alias-border-l2);border-radius:7px;background-color:var(--dsw-alias-bg-layer-1,Field);color:var(--dsw-alias-label-primary,CanvasText);color-scheme:inherit;font-size:12.5px;padding:0 6px;outline:none}',
      '.dfish .step{width:26px;height:26px;padding:0;border-radius:6px;font-size:14px;line-height:1}',
      // 日记翻页条（2026-10-26）：日期多于一天才出现，一行放得下三个元素就够。
      '.dfish .pager{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:2px 0 8px}',
      '.dfish .pager button{height:24px;padding:0 10px;font-size:12px;border-radius:6px}',
      '.dfish .pager .dim{font-size:12px;font-variant-numeric:tabular-nums}',
      '.dfish .sw{position:relative;width:40px;height:22px;padding:0;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2);background:rgba(128,128,128,.18);cursor:pointer;transition:background .15s}',
      '.dfish .sw .knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:left .15s}',
      '.dfish .sw.on{background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary)}',
      '.dfish .sw.on .knob{left:20px}',
      '.dfish .savebar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding-top:4px}',
      '.dfish button.primary{background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-inverted,#fff)}',
      '.dfish button.primary:hover:not(:disabled){opacity:.9;color:var(--dsw-alias-label-primary-inverted,#fff)}',
      // GitHub 链接（2026-10-25 用户要求）：商标小图 + 文字，点开新窗口。
      // 用 inline-flex 让 icon 和文字基线对齐；hover 只换颜色不动位置。
      '.dfish .ghlink{display:inline-flex;align-items:center;gap:6px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);text-decoration:none;border-radius:6px;padding:2px 4px;margin-left:-4px}',
      '.dfish .ghlink:hover{color:var(--dsw-alias-state-business-primary);background:rgba(128,128,128,.1)}',
      '.dfish .ghlink svg{flex:0 0 auto}',
      // 常见问题解答按钮（2026-10-28 用户要求）：点开就地展开，不在设置页里铺满。
      // 2026-10-28 晚（用户 m00416「点了没有反应」）：原本是 `<a target="_blank">` 开新窗口，
      // 但宿主的信任栅栏只认 App 登录 cookie，新标签页一律 403 —— 换成 button + 面板。
      '.dfish .faq-btn{display:inline-flex;align-items:center;gap:6px;height:34px;padding:0 16px;border-radius:8px;border:0.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);font-size:13.5px;text-decoration:none;background:transparent;cursor:pointer}',
      '.dfish .faq-btn:hover{background:rgba(128,128,128,.12);color:var(--dsw-alias-label-primary)}',
      '.dfish .faq-btn .arrow{opacity:.6;font-size:12px}',
      '.dfish .faq-panel{margin-top:10px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:rgba(128,128,128,.04);overflow:hidden}',
      '.dfish .faq-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 12px;border-bottom:0.5px solid var(--dsw-alias-border-l2)}',
      '.dfish .faq-head button{height:24px;padding:0 10px;font-size:12px;border-radius:6px}',
      '.dfish .faq-body{max-height:52vh;overflow:auto;padding:4px 12px 12px}',
      '.dfish .faq-qa{padding:10px 0;border-bottom:0.5px solid var(--dsw-alias-border-l2)}',
      '.dfish .faq-qa:last-child{border-bottom:0}',
      '.dfish .faq-q{font-size:13.5px;font-weight:600;line-height:1.7}',
      '.dfish .faq-a{margin:6px 0 0;font-size:13px;line-height:1.75;color:var(--dsw-alias-label-secondary)}',
      // 扫码登录浮层（2026-11-02 按仓库配色重做）。
      // 原版把卡片写成 #fff 底 + #111 字，深色主题下是一块刺眼白板；
      // 强调色也用了 B 站蓝 #00aeec，和插件自己的强调色（state-business-primary）不同源。
      // 现在卡片走主题层色、按钮走通用 button 样式 + .go 强调类。
      // 唯一保留写死的白底是二维码本身：扫码要的是黑白高对比，跟着主题变成暗底反而扫不出来。
      '.dfish .qrovl{position:fixed;inset:0;z-index:91;display:flex;align-items:center;justify-content:center;padding:18px;background:rgba(0,0,0,.62)}',
      '.dfish .qrcard{width:min(340px,92vw);box-sizing:border-box;background:var(--dsw-alias-bg-layer-1,Canvas);color:var(--dsw-alias-label-primary,CanvasText);border:.5px solid var(--dsw-alias-border-l3);border-radius:14px;padding:18px 18px 14px;text-align:center;box-shadow:0 12px 40px rgba(0,0,0,.45)}',
      '.dfish .qrcard h4{margin:0 0 12px;font-size:13.5px;font-weight:600;line-height:20px}',
      '.dfish .qrpic{display:block;width:100%;max-width:252px;margin:0 auto;border-radius:8px;background:#fff}',
      '.dfish .qrph{display:flex;align-items:center;justify-content:center;width:100%;max-width:252px;height:252px;margin:0 auto;box-sizing:border-box;border:.5px dashed var(--dsw-alias-border-l2);border-radius:8px;background:rgba(128,128,128,.06);color:var(--dsw-alias-label-tertiary);font-size:12.5px}',
      '.dfish .qrwho{margin:4px 0 6px;font-size:14px;line-height:20px}',
      '.dfish .qrstat{margin:10px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-tertiary))}',
      '.dfish .qrerr{margin:6px 0 0;font-size:12px;line-height:18px;color:#e5484d}',
      '.dfish .biliwarn{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:6px 0 10px;padding:10px 12px;border-radius:8px;background:rgba(229,72,77,.10);border:1px solid rgba(229,72,77,.35);font-size:12.5px;line-height:19px;color:#e5484d}',
      '.dfish .qrbtns{display:flex;gap:8px;justify-content:center;margin-top:14px}',
      '.dfish .qrbtns button{height:30px;padding:0 14px;font-size:13px;border-radius:8px}',
      '.dfish .qrbtns button.go{background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-inverted,#fff)}',
      '.dfish .qrbtns button.go:hover:not(:disabled){opacity:.9;color:var(--dsw-alias-label-primary-inverted,#fff);border-color:var(--dsw-alias-state-business-primary)}',
    ].join('\n')

    function useStyleOnce() {
      useEffect(() => {
        if (document.querySelector(`style[data-tag="${CSS_TAG}"]`)) return
        const el = document.createElement('style')
        el.setAttribute('data-tag', CSS_TAG)
        el.textContent = CSS
        document.head.appendChild(el)
      }, [])
    }

    // ---------------------------------------------------------------- 工具
    const esc = (s) => String(s == null ? '' : s)

    /**
     * 把质量指标渲染成两位小数。
     *
     * 为什么要有这个函数（2026-10-23，观测台空白页的根因）：
     *   宿主那边 `/state` 的 quality 不是数字，是带样本量的结构体
     *   `{ stability: { score, sample, worst }, consistency: { score, pairs }, novelty: { score, recent, older } }`
     *   （样本太少时故意不报裸分数，避免"看数字调性格"）。
     *   而这里原来写的是 `s.quality.stability.toFixed(2)` —— 对一个对象调 toFixed，
     *   React 渲染抛 TypeError，整节被错误边界吞掉，用户看到的就是**设置页一片空白**。
     *   所以这里同时接受数字和 `{score}` 两种形态，取不到就给 em dash，绝不再抛。
     */
    function q2(v) {
      const n = typeof v === 'number' ? v : Number(v && v.score)
      return Number.isFinite(n) ? n.toFixed(2) : '—'
    }

    /**
     * 「判断漂移」那一行的值：样本不够时不准印 0.00。
     *
     * 2026-10-26（用户 m05785「为什么剩下两个全是0」）：三个指标在样本不足时给的
     * 默认值原本被直接当成结果显示——没有判断时稳定 0.00、说话不足两条时一致 1.00、
     * 没有七天前的老话时新鲜 0.00。三个数里有两个是"还没法测"，不是"她很差"。
     * 现在把这种情况写成一句人话，数字只在真的能测时才印。
     */
    function bandOf(v) {
      return typeof v === 'string' ? v.trim() : ''
    }
    function qStability(v) {
      if (!v) return '—'
      const band = bandOf(v && v.band)
      // 2026-10-27（用户 m06350）：能测出来的时候，数字和判读一起给——只印那句
      // 「长在这些事上，抽掉一条少一块」，用户看不出到底是多少，以为没测。
      // 样本不够时才只给判读：那种 0.00 是默认值，不是测量结果，不能当数字印。
      if (!Number(v.sample ?? 0) || !Number(v.beliefs ?? 0)) return band || '还没攒到判断，测不出来'
      const n = Number(v.score)
      const num = Number.isFinite(n) ? n.toFixed(2) : '—'
      // 2026-11-07（issue #57）：只印均值，会把「平均动 3%、某一次动了 15%」写成一片安安静静。
      // 最大值明显高于均值时一并印出来——这两个数合起来才是这一行的全部事实。
      const w = Number(v.worst)
      const worst = Number.isFinite(w) && Number.isFinite(n) && w > n + 0.005 ? `（最大 ${w.toFixed(2)}）` : ''
      return band ? `${num}${worst} · ${band}` : `${num}${worst}`
    }
    function qConsistency(v) {
      if (!v) return '—'
      const pairs = Number(v.pairs ?? 0)
      if (!pairs) return '还没有跨阶段的话可比'
      const n = Number(v.score)
      return Number.isFinite(n) ? n.toFixed(2) : '—'
    }
    function qNovelty(v) {
      if (!v) return '—'
      const recent = Number(v.recent ?? 0)
      const older = Number(v.older ?? 0)
      if (!recent) return '最近一周没写下自己的话'
      if (!older) return '还没有七天前的老话可比'
      const n = Number(v.score)
      return Number.isFinite(n) ? n.toFixed(2) : '—'
    }

    async function jget(path) {
      const r = await fetch(API + path, { headers: { accept: 'application/json' } })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) {
        const hint = r.status === 401 || r.status === 403 ? '（被信任栅栏拒绝：请在 App 内打开这一页）' : ''
        throw new Error(`HTTP ${r.status}${hint} ${j.error || ''}`.trim())
      }
      return j
    }

    async function jpost(path, body) {
      const r = await fetch(API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body == null ? {} : body),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) {
        // 有些失败要带着后端给的名单再决定下一步（恢复撞上碎字文件，issue #65）。
        const err = new Error(j.error || `HTTP ${r.status}`)
        err.payload = j
        err.status = r.status
        throw err
      }
      return j
    }

    // 给人看的大小：和 lib/backup.js 的 sizeText 同一个写法（1MB 以上写 MB，十进制，
    // 留一位小数、往上取，刚过上限的包不会显示成和上限一样大）。
    function mbText(bytes) {
      const n = Math.max(0, Number(bytes) || 0)
      if (n >= 1000000) return `${Math.ceil(n / 100000) / 10}MB`
      return `${Math.max(1, Math.ceil(n / 1000))}KB`
    }

    // 回执里的名单：最多列前 10 条，剩下的报个数。total 是真实条数（恢复接口只带前 200 条）。
    // 一下列几千条，一句回执就成了一大段；顺序由后端排好（丢了找不回来的 owner.json、日记这类在前）。
    function someOf(list, total) {
      const all = Array.isArray(list) ? list : []
      const n = Math.max(Number(total) || 0, all.length)
      const shown = all.slice(0, 10)
      return shown.join('、') + (n > shown.length ? `，还有 ${n - shown.length} 个没列出来，完整名单在备份文件的 skipped 里` : '')
    }

    // 没打进包的文件怎么说：有名字的照 someOf 列；事件流顶到恢复上限附近时，
    // 包里连说明行都写不下，后端只记了个数（skippedUnlisted），这几个单独说一句。
    // named 是有名字的真实条数（恢复接口的名单只带前 200 条）。
    function missingText(list, named, unlisted) {
      const listed = someOf(list, named)
      const n = Math.max(0, Number(unlisted) || 0)
      if (!n) return listed
      const why = '（再写就超过「从备份恢复」一次能收的大小）'
      return listed ? `${listed}；另有 ${n} 个连名字都写不进包里${why}` : `包里连它们的名字都写不下${why}`
    }

    // ---------------------------------------------------------------- 组件
    function FishSection() {
      useStyleOnce()
      const [state, setState] = useState(null)
      const [beliefs, setBeliefs] = useState(null)
      const [diary, setDiary] = useState(null)
      const [browse, setBrowse] = useState(null)
      const [reports, setReports] = useState({ dates: [], date: null, md: '' })
      const [inbox, setInbox] = useState(null)
      const [home, setHome] = useState(null)
      // 请求事件（0.7.6，m01274）：她问过什么、答过什么。只在住所页用到。
      const [asks, setAsks] = useState(null)
      // 请求事件：在这里补答之后的提示（弹卡答过的就不写了）。
      const [askMsg, setAskMsg] = useState('')
      // 梦（2026-10-30 m02837，本机实验 A 案）：只在 .dev 下才取得到，公开版 404。
      const [dreams, setDreams] = useState(null)
      const [mem, setMem] = useState(null)
      // 规则与解禁（R3，2026-10-24）：四层规则 + 她提上来的那一张申请
      const [rules, setRules] = useState(null)
      const [st, setSt] = useState(null)
      const [rotateAfter, setRotateAfter] = useState(40)
      // 换新会话时带几轮原话过去（0 = 不带）。默认 4，跟老版本写死的一样。
      const [carryTurns, setCarryTurns] = useState(4)
      const [docBudget, setDocBudget] = useState(2400)
      // 0.9.7 T1：身份段里摆不摆「你最近说过的几句话」（默认开）
      const [echoOn, setEchoOn] = useState(true)
      const [beliefsShown, setBeliefsShown] = useState(3)
      // 旁听（A2，2026-10-30）：每几轮记一句你说过的话（0 = 不记）
      const [hearEvery, setHearEvery] = useState(3)
      // 记忆体检（0.7.6，2026-10-30 用户 m00342）：点一下才算，不自动跑。
      const [health, setHealth] = useState(null)
      const [healthBusy, setHealthBusy] = useState(false)
      const [toolsAllowText, setToolsAllowText] = useState('')
      const [toolsRestrict, setToolsRestrict] = useState(true)
      // 白名单草稿态（2026-10-24，用户要求）：输入框里的字先不提交，
      // 点「保存设置」才写盘——否则敲一半就被页面其它地方的保存带上去，拼错一个字母整条收窄失效。
      const [toolsAllowSaved, setToolsAllowSaved] = useState([])
      const [toolsKnown, setToolsKnown] = useState(null)
      // 看得见、但收窄挡不住的那些（own 层，比如 dsh-ops 的 ops_*）。白名单放行 = 守卫放行。
      const [toolsOwnLayer, setToolsOwnLayer] = useState([])
      // 这个进程里被兜底守卫真挡下来的工具（2026-11-04，issue #20）。
      // 进来之前它只活在日志里——而她答「这件事我做不到」的时候，用户唯一的线索就是这里。
      const [toolsBlocked, setToolsBlocked] = useState([])
      // 她自己本来就有的那几件（服务端给的真名单，不是界面硬编码）。
      const [toolsHerTools, setToolsHerTools] = useState([])
      // 只在特定场合才交给她的那几件（比如出门才用得上的 bring_back）。
      // 它们也是她的工具，只是不在家里的工具面里——单列一组，别让它们看起来像丢了。
      const [toolsHerScene, setToolsHerScene] = useState([])
      // 工具分组的展开状态（2026-11-04，用户反馈）：真机上一百多个名字全摊开，
      // 等于没有界面。默认全收起来，点哪个前缀才展开哪一组。
      const [toolsOpenFams, setToolsOpenFams] = useState({})
      const [toolsSaveNote, setToolsSaveNote] = useState('')
      const [toolsSaveErr, setToolsSaveErr] = useState('')
      // 运行日志（2026-10-24）：只在点开时才读，不参与 30 秒轮询。
      const [logTail, setLogTail] = useState(null)
      const [logBusy, setLogBusy] = useState(false)
      // 备份与恢复（2026-10-25）：只在数据页用，不进轮询。
      const [backupBusy, setBackupBusy] = useState(false)
      const [backupMsg, setBackupMsg] = useState('')
      // 迁移工作区（2026-10-28，用户 m06510）
      const [moveBusy, setMoveBusy] = useState(false)
      const [moveMsg, setMoveMsg] = useState('')
      const [moveAsk, setMoveAsk] = useState(false)
      const [moveTarget, setMoveTarget] = useState('')
      const [moveInfo, setMoveInfo] = useState(null)
      let topEl = null
      const [sayText, setSayText] = useState('')
      const [said, setSaid] = useState([])
      const [err, setErr] = useState('')
      const [busy, setBusy] = useState('')
      const [note, setNote] = useState('')
      // 设置界面重做（2026-10-23）：当前页 + 新增的几个环境项
      const [tab, setTab] = useState('now')
      // 恢复撞上碎字文件时，后端回的「要你拿主意」那张清单（issue #65）：{ obj, files, count }。
      // 放在 tab 后面（上面的规矩）：测试按下标找 tab，别把它挤走。
      const [restoreBad, setRestoreBad] = useState(null)
      // 这几个放在 tab 后面：测试按下标找 tab（test/client.test.mjs），别把它挤走。
      // 这一局收窄真在管的那两份（/tools 的 allowNow / effective，issue #69 第 9 条）。
      // 她自己的工具按它分成「在手上」和「这一局不在手上」；null = 不知道，或收窄这一局没在管。
      const [toolsAllowNow, setToolsAllowNow] = useState(null)
      const [toolsEffective, setToolsEffective] = useState(null)
      // /tools 读没读成：'' 还没回来、'ok' 读到了、'fail' 没读成。
      // 拿不到名单要照实说，不能说成「她还没开过会话」。
      const [toolsLoad, setToolsLoad] = useState('')
      // /tools 回没回 allowNow 这一栏（回 null 也算回了）：没回就不知道这一局收窄在不在管，
      // 工具卡只能按开关说。skippedSure 跟自检同一个判据：false 时没下给 restrict 的名字
      // 说不准在不在她手上（宿主没给 visible），null = 还没真下过。
      const [toolsRunKnown, setToolsRunKnown] = useState(false)
      const [toolsSkippedSure, setToolsSkippedSure] = useState(null)
      const [growthDaysUi, setGrowthDaysUi] = useState(30)
      const [diaryKeep, setDiaryKeep] = useState(0)
      const [browseDeepRead, setBrowseDeepRead] = useState(6)
      // 评论区里别人的话（2026-10-24，用户 m02454）：默认开，每次最多留 1 条。
      const [browseVoices, setBrowseVoices] = useState(true)
      const [videoOn, setVideoOn] = useState(true)
      const [videoPerDay, setVideoPerDay] = useState(2)
      const [videoFrames, setVideoFrames] = useState(9)
      const [avoidMinDur, setAvoidMinDur] = useState(60)
      const [avoidMids, setAvoidMids] = useState('')
      const [sleepEvery, setSleepEvery] = useState(7)
      const [sleepKeep, setSleepKeep] = useState(12)

      // 生长环境（可编辑的那几项）
      const [absent, setAbsent] = useState(2)
      const [diaryVisible, setDiaryVisible] = useState(false)
      const [diaryEnabled, setDiaryEnabled] = useState(true)
      const [wakes, setWakes] = useState(1)
      const [eventsPerDay, setEventsPerDay] = useState(1)
      const [questionsPerDay, setQuestionsPerDay] = useState(1)
      // 主动说话（0.8.1 本机实验，.dev 专属）：她自己决定要不要开口。频率是上限，不是要求。
      const [proactiveOn, setProactiveOn] = useState(false)
      const [proactiveMax, setProactiveMax] = useState(2)
      const [proactiveIdle, setProactiveIdle] = useState(6)
      // 「安静多久才搭话」停手 700ms 再存（issue #69）：等待中的那次，和盘上现在的值
      const proactiveIdleTimer = useRef(null)
      const proactiveIdleSaved = useRef(null)
      const [proactiveTools, setProactiveTools] = useState('')
      const proactiveToolsTimer = useRef(null)
      const [proactiveCompact, setProactiveCompact] = useState(true)
      const [proactiveSeen, setProactiveSeen] = useState(false)
      // 2026-11-05（用户 m02634）：梦 / 主动性 / 兴趣 三个开关，默认全开。
      const [driveOn, setDriveOn] = useState(true)
      const [interestOn, setInterestOn] = useState(true)
      const [dreamEnabled, setDreamEnabled] = useState(true)
      // 空醒开关（0.9.0 公开）：醒来时没派活、桌上也没东西，她可以自己找点事做。
      const [selfWakeOn, setSelfWakeOn] = useState(true)
      const [avoidText, setAvoidText] = useState('')
      // 刷站（全是环境参数：她今天能不能出门、一次看见几条，不是她爱看什么）
      const [browseOn, setBrowseOn] = useState(true)
      // 2026-11-07（用户 m00365）：两颗开关是两件事——
      //   biliOn  = 她能不能自己出门看 B 站（bili_look / bili_watch / bili_speak）
      //   browseOn = 家里要不要按时间替她逛（安静刷，只记账不叫醒）
      const [biliOn, setBiliOn] = useState(true)
      const [browsePerDay, setBrowsePerDay] = useState(1)
      const [browseTopN, setBrowseTopN] = useState(4)
      const [browseDanmaku, setBrowseDanmaku] = useState(6)
      // 请求节奏（issue #5）：服务器/机房 IP 需要放慢，家宽可以更快
      const [biliMinGap, setBiliMinGap] = useState(800)
      const [biliJitter, setBiliJitter] = useState(500)
      // 桌面提醒（P3-3 重写）：默认关，由他自己打开
      const [notifyOn, setNotifyOn] = useState(false)
      // 浏览器通知权限 + 弹不出来时的页面内气泡
      const [notifyPerm, setNotifyPerm] = useState('default')
      const [bubble, setBubble] = useState('')
      // 在 B 站说话（P4）：默认关。这是唯一会动她账号的功能。
      const [commentOn, setCommentOn] = useState(false)
      const [commentPerDay, setCommentPerDay] = useState(1)
      const [commentReplyPerDay, setCommentReplyPerDay] = useState(2)
      const [commentReplyTo, setCommentReplyTo] = useState(true)
      const [commentScanMin, setCommentScanMin] = useState(30)
      const [cm, setCm] = useState(null)
      // 有人 @ 她（2026-11-11）：默认关。这是别人在 B 站点名找她，不是她发东西。
      const [atOn, setAtOn] = useState(false)
      const [atEveryMin, setAtEveryMin] = useState(5)
      const [atPerDay, setAtPerDay] = useState(20)
      const [atOthers, setAtOthers] = useState(true)
      const [atOwnerWake, setAtOwnerWake] = useState(true)
      const [atStatus, setAtStatus] = useState(null)
      // B 站登录态（2026-11-12）：设置页打开时问一次，过期就在「上网」页亮红条。
      const [biliState, setBiliState] = useState(null)
      // 时段（2026-10-23 加）：醒来 / 上网 / 说话，三段各自可调
      const [wakeFrom, setWakeFrom] = useState('20:00')
      const [wakeTo, setWakeTo] = useState('23:00')
      // 上网时段没单独配 = 跟着醒来时段（issue #86 第 2 条），所以初值就是醒来那两个数
      const [browseFrom, setBrowseFrom] = useState('20:00')
      const [browseTo, setBrowseTo] = useState('23:00')
      const [commentFrom, setCommentFrom] = useState('20:00')
      const [commentTo, setCommentTo] = useState('23:00')
      // 重置
      const [resetInfo, setResetInfo] = useState(null)
      const [resetAsk, setResetAsk] = useState(false)
      // 导入别人养过的大肥鱼（2026-10-27，用户 m03170）
      const [importInfo, setImportInfo] = useState(null)
      const [importText, setImportText] = useState('')
      const [importAsk, setImportAsk] = useState(false)
      const [importBusy, setImportBusy] = useState('')
      const [importNote, setImportNote] = useState('')
      // 看过什么 / 自检 / 风控（2026-10-23 加）
      const [hist, setHist] = useState({ groups: [], total: 0 })
      // 2026-11-07（用户反馈）：初值从 localStorage 读回来，别再写死 14。
      const [histDays, setHistDays] = useState(readHistDays)
      // load() 的依赖是空数组，闭包里永远只有挂载时那个 histDays——凡是「现在这个天数」
      // 都得走 ref，不能直接读 state（改了也读不到）。
      const histDaysRef = useRef(histDays)
      // 当前选的天数没读到时的原因（issue #69）。这时列表里留着的要么是别的天数的、
      // 要么什么都没有，都不能当成「共 0 天」「还没有记录」摆出来。
      const [histErr, setHistErr] = useState('')
      // 列表里现在摆的是哪个天数的（读到才记）。已经摆着当前天数的，重读失败一次不收起来。
      const histShown = useRef(null)
      const [checks, setChecks] = useState(null)
      const [checking, setChecking] = useState(false)
      const [risk, setRisk] = useState(null)
      // 你不在的时候（2026-10-23 加）
      const [away, setAway] = useState(null)
      // 设置界面 2.0（2026-10-24）：观看历史分页 + 报告默认收起
      const [histPage, setHistPage] = useState(0)
      const [showReport, setShowReport] = useState(false)
      // 常见问题解答（2026-10-28 用户 m00416）：改成就地展开，不再开新窗口（见 feedbackPage 前的注释）
      const [faq, setFaq] = useState(null)
      const [faqOpen, setFaqOpen] = useState(false)
      const [faqNote, setFaqNote] = useState('')
      // 主人是谁 + B 站登录（2026-10-23 加）
      const [ow, setOw] = useState(null)
      const [owMid, setOwMid] = useState('')
      const [owName, setOwName] = useState('')
      const [owCookie, setOwCookie] = useState('')
      const [atOwner, setAtOwner] = useState(true)
      const [owNote, setOwNote] = useState('')
      // 2026-11-06（用户反馈）：领养人两格原来只有「B 站登录 → 粘贴 cookie」页签底部那一颗保存键，
      // 停在「领养人验证」这一组里根本找不到保存路径，停在扫码页签里那颗键更是连渲染都不渲染。
      // 这一组现在自带一颗，提示也写在这一组里，不再借用下面 cookie 那行的 owNote。
      const [owIdNote, setOwIdNote] = useState('')
      // 扫码登录（2026-11-01）：浮层里的这张码。
      // qr 只在浮层开着的时候有值；关掉就 drop，宿主那边攥着的 cookie 一起忘掉。
      const [owTab, setOwTab] = useState('qr')
      const [qr, setQr] = useState(null)
      const [qrBusy, setQrBusy] = useState(false)
      const [qrNote, setQrNote] = useState('')
      const [qrLeft, setQrLeft] = useState(0)
      // 数据文件夹的真路径。**只在内存里用，不上屏**（用户 m03440）。
      const [dataPaths, setDataPaths] = useState(null)
      // 头像（2026-10-24）：插件不自带任何图片，谁用谁自己传一张
      const [avatarV, setAvatarV] = useState(0)
      const [avatarPresent, setAvatarPresent] = useState(false)
      const [avatarBytes, setAvatarBytes] = useState(0)
      const [avatarBusy, setAvatarBusy] = useState(false)
      const [avatarNote, setAvatarNote] = useState('')
      // 自动保存（2026-10-24 用户）：设置项改完就生效，不再需要滚到底点保存。
      const [autoNote, setAutoNote] = useState('')
      // 保存回执和保存失败是两件事，不许挤成一行（2026-10-29 用户：这两句没有联系，
      // 也不属于同类型的提示）。回执只是「存到了」的一句确认，两秒半自己消失；
      // 失败是一个要处理的状态，放在页签栏上方，一句人话 + 一行技术信息，自己点掉。
      // 尤其不能让失败去占「改完就生效」那条说明的位置——两句摆在一起自相矛盾。
      const [saveFail, setSaveFail] = useState('')
      // 这次失败是不是数字越界。失败框按这一次失败的原因选那句人话，不在渲染时现查输入框：
      // 越界的数还停在框里时，开关那几条单独提交也可能因为断网失败，那时说「数超出范围」就说错了原因。
      const [saveFailRange, setSaveFailRange] = useState(false)
      const failSave = (msg, range = false) => { setSaveFailRange(range); setSaveFail(msg) }
      const failRange = (bad) => failSave(`「${bad}」这个数不在允许范围里，所以没有写进去。`, true)
      // 保存时被跳过的工具名（2026-10-31，issue #14 @ming-fish）。
      // 服务端不再因为一个「这台机器上没有的名字」把整张表拒掉，而是丢掉它、其余照存。
      // 丢掉的东西必须说出来——否则用户以为自己设的还在，实际悄悄少了一个。
      const [droppedTools, setDroppedTools] = useState([])
      const savedTimer = useRef(null)
      const flashSaved = () => {
        setAutoNote(`已保存 ${new Date().toTimeString().slice(0, 8)}`)
        // 开关、日记这几项是单独提交的：它们存上了，不等于框里那个越界的数也存上了。
        // 越界的数还在，失败框就接着说它（自动保存那边 cfgSig 没变，不会再查一次）。
        const bad = badNumber()
        if (bad) failRange(bad)
        else setSaveFail('')
        clearTimeout(savedTimer.current)
        savedTimer.current = setTimeout(() => setAutoNote(''), 2500)
      }
      // 首屏载入完先把基线记下来，否则一打开页面就会把刚读到的配置又写回去一遍。
      const baselinePending = useRef(true)
      const lastSaved = useRef('')
      // 日记三项单独提交（2026-10-28 用户反馈「开了『让我看日记』插件又自己关」）：
      // 记下最后一次动过它们的时刻，用来挡住紧接着的 load() 把旧值写回输入框。
      const diaryTouchedAt = useRef(0)
      // 还没回包的日记 patch 数量：有在飞的就不让 load() 覆盖输入框。
      const diaryPending = useRef(0)
      // 原理页两张图：点开看原图，滚轮缩放、按住拖动（2026-10-25 用户：插件里看不清）。
      const [zoom, setZoom] = useState(null)
      const dragRef = useRef(null)
      // 2026-10-25：单轮回复字数预算（0 = 不限，默认就不提任何长度要求）
      const [replyChars, setReplyChars] = useState(0)
      // B 站登录提示卡：他点过「不用了」就别再出现（存进 config.ui）
      const [uiHintDismissed, setUiHintDismissed] = useState(false)
      // 检查更新（2026-10-25 用户要求）：null=还没查过，{...}=查过。
      // 只有点按钮才查，不自动轮询——她运行期不该操心自己是几号版本。
      const [upd, setUpd] = useState(null)
      const [updBusy, setUpdBusy] = useState(false)
      // 自带升级（2026-10-29 用户 m00203）：null=没在升，{phase,bytes,total,error,...}=在升。
      // 下载和安装都必须是你点过确认才发生，所以这里没有"自动开始"的路径。
      const [dl, setDl] = useState(null)
      // 日记翻页（2026-10-26 用户 m01201）：一天一页、日期多于一天才出翻页按钮。
      // 正文按天取（`/diary?day=…`），翻过的缓存进 ref，来回翻不重复请求。
      const [diaryDay, setDiaryDay] = useState(0)
      const diaryCache = useRef({})
      const diaryLoaded = useRef(false)
      const [, setDiaryTick] = useState(0)

      // 当前这天的正文没缓存就去取一次（一页一天，不预取；翻回去靠缓存）。
      const diaryDates = diary?.dates ?? []
      const diaryIdx = Math.min(Math.max(diaryDay, 0), Math.max(diaryDates.length - 1, 0))
      const diaryCur = diaryDates[diaryIdx] ?? null
      useEffect(() => {
        if (!diaryCur || diaryCache.current[diaryCur] !== undefined) return undefined
        let dead = false
        jget(`/diary?day=${diaryCur}`)
          .then((r) => {
            if (dead) return
            diaryCache.current[diaryCur] = r?.text ?? ''
            setDiaryTick((n) => n + 1)
          })
          .catch(() => {})
        return () => { dead = true }
      }, [diaryCur])

      useEffect(() => {
        if (!zoom) return undefined
        const onKey = (e) => { if (e.key === 'Escape') setZoom(null) }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [zoom])

      // 扫码登录的轮询与倒计时（2026-11-01）。
      // 只在这张码还"活着"的时候转：waiting / scanned。走到 confirmed 就停手——
      // 后面要不要写盘由人决定，不该有东西在后台一直问。
      useEffect(() => {
        if (!qr || (qr.state !== 'waiting' && qr.state !== 'scanned')) return undefined
        const key = qr.key
        const tick = async () => {
          try {
            const r = await jget(`/bili/qr/status?key=${encodeURIComponent(key)}`)
            if (!r?.state) return
            setQr((prev) => {
              if (!prev || prev.key !== key) return prev
              const next = r.state === 'confirmed' ? 'confirmed' : r.state
              if (next === prev.state && !r.why && !r.note) return prev
              return {
                ...prev,
                state: next,
                note: String(r.why || r.note || ''),
                account: r.account ?? prev.account,
                canWrite: r.canWrite ?? prev.canWrite,
              }
            })
          } catch { /* 一次轮询失败不算数，下一次接着问 */ }
        }
        const id = setInterval(tick, 1_500)
        return () => clearInterval(id)
      }, [qr?.key, qr?.state])

      // 倒计时：只在浮层开着时走，纯本地算，不打扰宿主。
      useEffect(() => {
        if (!qr || !qr.expiresAt) return undefined
        const left = () => Math.max(0, Math.round((qr.expiresAt - Date.now()) / 1000))
        setQrLeft(left())
        const id = setInterval(() => setQrLeft(left()), 1_000)
        return () => clearInterval(id)
      }, [qr?.key, qr?.expiresAt])

      // 出门（用户 m07453）与请神（2026-10-28）两页的 state。
      // 必须写在这里：下面「读不到状态」会提前 return，return 之后再调 hook，
      // 第一次读 /state 失败时第二次渲染就少了这十几个 hook，React 直接抛错，
      // 整节连「读不到状态。」都显示不出来（issue #69）。
      const [outing, setOuting] = useState(null)
      const [outingBusy, setOutingBusy] = useState(false)
      const [outingMsg, setOutingMsg] = useState('')
      const [outingPick, setOutingPick] = useState('')
      const [outingEndAsk, setOutingEndAsk] = useState(false)
      // 回家卡上被取消勾选的条目 id（默认全勾 = 空数组）
      const [outingDrop, setOutingDrop] = useState([])
      // 复用同一趟（0.6.16，用户 m01613）：接着这个工作区上次那条会话。
      const [outingReuse, setOutingReuse] = useState(false)
      const [possess, setPossess] = useState(null)
      const [possessBusy, setPossessBusy] = useState(false)
      const [possessMsg, setPossessMsg] = useState('')
      const [possessPick, setPossessPick] = useState('')
      // 回家审查（m02241 第⑤条）：结束请神前先把这趟多出来的条目摆出来。
      // 默认全收下；取消勾选的会写成 possess-reject: 标记，之后派生时跳过。
      const [possessEndAsk, setPossessEndAsk] = useState(false)
      const [possessDrop, setPossessDrop] = useState([])

      // /config 灌进界面一次就加一。自动保存靠它在「盘上的值刚灌进来」那一帧重记基线：
      // /state 先回来、/config 后到，只在 /state 那一帧记基线的话，/config 一到界面就和基线不同，
      // 什么都没动也会整表回写一遍（issue #69）。值没变时 cfgSig 不变、effect 不跑，所以要单独一个数。
      const [cfgLoads, setCfgLoads] = useState(0)
      // cfgLoads 还是 0（/config 一次都没灌进来：打开页面时 /beliefs、/diary、/config、/browse
      // 有一个失败，Promise.all 整个拒掉）时，界面上除了 /state 带的那几项都还是初值，
      // 整表写下去会把盘上的 atOwner 写回 true、屏蔽词和工具白名单清空。这时不整表保存，用这句说清楚。
      const CFG_MISSING = '设置还没从盘上读全，这次不整表保存，免得拿界面上的初值盖掉盘上的设置。重新打开这一页再改。'

      // 读一次「看过的视频」（issue #69）。回来时天数已经换了（在路上时用户又选了别的）就丢掉，
      // 别盖住新选的列表；当前这个天数没读到、列表里也不是这个天数的，就记下原因。
      const readHist = async (days) => {
        try {
          const r = await jget(`/history?days=${days}`)
          if (histDaysRef.current !== days) return
          histShown.current = days
          setHist(r)
          setHistErr('')
        } catch (e) {
          if (histDaysRef.current === days && histShown.current !== days) setHistErr(e.message)
        }
      }

      const load = useCallback(async () => {
        setErr('')
        // 重新读盘之后要重新记基线（撤销 / 刷新都走这里）。
        baselinePending.current = true
        // 工具名单（2026-11-04，issue #20）：以前只在点「保存设置」时才拉一次，
        // 于是页面一打开，分组清单永远是空的——用户看不出这台机器上到底有哪些工具，
        // 也看不出哪几个真被挡过。这里跟其它只读卡片一样静默失败，不影响别处。
        // 放在最前面单独发：排在 /state、Promise.all 后面时，前面哪一个失败它就不发，
        // 工具卡会一直停在「读取中」。
        const markToolsFail = () => setToolsLoad((v) => (v === 'ok' ? v : 'fail'))
        jget('/tools').then((r) => {
          // 回了个空体也算没读到（之前读到过就留着那份）。
          if (!r) return markToolsFail()
          setToolsKnown(Array.isArray(r.known) ? r.known : null)
          setToolsOwnLayer(Array.isArray(r.ownLayer) ? r.ownLayer : [])
          setToolsHerTools(Array.isArray(r.herTools) ? r.herTools : [])
          setToolsHerScene(Array.isArray(r.herSceneTools) ? r.herSceneTools : [])
          setToolsBlocked(Array.isArray(r.blocked) ? r.blocked : [])
          setToolsAllowNow(Array.isArray(r.allowNow) ? r.allowNow : null)
          setToolsEffective(Array.isArray(r.effective) ? r.effective : null)
          setToolsRunKnown(Object.prototype.hasOwnProperty.call(r, 'allowNow'))
          setToolsSkippedSure(typeof r.skippedSure === 'boolean' ? r.skippedSure : null)
          setToolsLoad('ok')
        }).catch(markToolsFail)
        try {
          const s = await jget('/state')
          setState(s)
          setAbsent(Number(s.config?.absenceAfterDays ?? 2))
          // 刚点过日记开关就别用服务端的旧值把它压回去（下面的 patchDiary 已经存过盘了）
          if (!diaryPending.current && Date.now() - diaryTouchedAt.current > 3000) {
            // 服务端没给这个字段（undefined）不等于 false，别把空值当成「关掉」写回界面
            const dv = s.config?.diary?.visible
            const de = s.config?.diary?.enabled
            if (typeof dv === 'boolean') setDiaryVisible(dv)
            if (typeof de === 'boolean') setDiaryEnabled(de)
          }
          setWakes(Number(s.config?.wakesPerDay ?? 1))
          setEventsPerDay(Number(s.config?.daily?.events ?? 1))
          setQuestionsPerDay(Number(s.config?.daily?.questions ?? 1))
          // 主动说话（.dev 专属）：没这个字段就是没开过，保持默认关闭。
          const pr = s.config?.proactive
          if (pr && typeof pr === 'object') {
            setProactiveOn(pr.enabled === true)
            setProactiveMax(Number(pr.maxPerDay ?? 2))
            setProactiveIdle(Number(pr.minIdleHours ?? 6))
            proactiveIdleSaved.current = Number(pr.minIdleHours ?? 6)
            setProactiveTools(Array.isArray(pr.sendTools) ? pr.sendTools.join(', ') : '')
            setProactiveCompact(pr.foldSilent !== false)
            setProactiveSeen(pr.idleCountsSeen === true)
          }
          setDriveOn(s.config?.drive?.enabled !== false)
          setInterestOn(s.config?.interest?.enabled !== false)
          setDreamEnabled(s.config?.dream?.enabled !== false)
          setSelfWakeOn(s.config?.memory?.selfWake !== false)
          setEchoOn(s.config?.memory?.echo !== false)

          // 不再拉 /events（2026-11-02，用户 m00335）：这里取回来的 e.rows 只进了
          // setEvents，全文件没有一处渲染它——每 30 秒白拉 25 条事件（九成是后台记账）。
          // 想看账本原文去「数据」页，那里给的是路径，不靠这条轮询。
          const [b, d, c, br, ib, hm, pth] = await Promise.all([
            jget('/beliefs'),
            jget('/diary'),
            jget('/config'),
            jget('/browse'),
            jget('/inbox?limit=60').catch(() => null),
            jget('/home').catch(() => null),
            jget('/paths').catch(() => null),
          ])
          setBeliefs(b)
          setDiary(d)
          // 首天正文随 /diary 一起回来了，先灌进翻页缓存（省一次往返）。
          for (const it of d?.items ?? []) diaryCache.current[it.date] = it.text
          // 只有第一次载入才跳到最新一天：30 秒轮询不该把人正在看的那页弹走。
          if (!diaryLoaded.current) {
            setDiaryDay(0)
            diaryLoaded.current = true
          }
          setBrowse(br)
          setInbox(ib)
          setHome(hm)
          setDataPaths(pth)
          // 迁移工作区：只读她现在住哪、有多少东西（失败就只显示按钮，不影响别处）
          jget('/move').then(setMoveInfo).catch(() => {})
          // 出门：现在在哪、有哪些工作区可去、说明卡确认过没有（失败就只显示空页）
          jget('/outing').then(setOuting).catch(() => {})
          // 请神：现在上身在哪条、哪些对话可以请（失败就只显示空卡）
          jget('/possession').then(setPossess).catch(() => {})
          // 请求事件：她问过什么、哪些还没答（失败就只显示空卡）
          jget('/ask').then(setAsks).catch(() => {})
          // 梦（本机实验）：公开版这条路由直接 404，失败就当没有这张卡
          jget('/dream').then(setDreams).catch(() => {})
          // 上下文与记忆：单独取，失败不影响其它卡片
          jget('/memory').then(setMem).catch(() => {})
          // 她以前看过什么 / 风控状态：都是只读，失败不影响其它卡片
          // 天数走 ref：load() 的依赖是空数组，读 state 只会读到挂载时那个值。
          // 晚到、失败怎么处理见 readHist（issue #69）。
          readHist(histDaysRef.current)
          jget('/risk').then(setRisk).catch(() => {})
          jget('/away').then(setAway).catch(() => {})
          // 头像元信息（有没有、多大）。没有就是空圈，不回落任何内置图。
          jget('/avatar/info').then((r) => {
            setAvatarPresent(Boolean(r && r.present))
            setAvatarBytes(Number(r && r.bytes) || 0)
          }).catch(() => {})
          // 规则与解禁（R3）：失败不影响其它卡片
          jget('/rules').then(setRules).catch(() => {})
          // 运行日志：失败就当没这回事（日志本身坏了不该拖垮设置页）
          jget('/log?lines=40').then(setLogTail).catch(() => {})
          // 报告：先拿日期列表，再取最新那天的正文（失败不影响其它卡片）
          jget('/reports').then(async (r) => {
            if (!r.dates?.length) return setReports(r)
            const one = await jget(`/reports?date=${r.dates[0]}`)
            setReports(one)
          }).catch(() => {})
          const cfg = c.config || {}
          setAbsent(Number(cfg.absenceAfterDays ?? 2))
          setWakes(Number(cfg.wakesPerDay ?? 1))
          setEventsPerDay(Number(cfg.daily?.events ?? 1))
          setQuestionsPerDay(Number(cfg.daily?.questions ?? 1))
          setAvoidText(((cfg.avoid?.keywords) || []).join('，'))
          // 2026-11-07（用户反馈 + m00365）：拆成两颗开关，各读各的闸门。
          // bili.enabled 管「她自己能不能出门看」；browse.enabled 管「家里会不会按时间替她逛」。
          // 以前合成一颗，关掉之后她照样能翻（甚至能看画面），用户看到的就是一颗假开关。
          setBiliOn(cfg.bili?.enabled !== false)
          setBrowseOn(cfg.browse?.enabled !== false)
          setBrowsePerDay(Number(cfg.browse?.perDay ?? 1))
          setBrowseTopN(Number(cfg.browse?.topN ?? 4))
          setBrowseDanmaku(Number(cfg.browse?.danmaku ?? 6))
          setBiliMinGap(Number(cfg.bili?.minIntervalMs ?? 800))
          setBiliJitter(Number(cfg.bili?.jitterMs ?? 500))
          setDriveOn(cfg.drive?.enabled !== false)
          setInterestOn(cfg.interest?.enabled !== false)
          setDreamEnabled(cfg.dream?.enabled !== false)
          setSelfWakeOn(cfg.memory?.selfWake !== false)
          setEchoOn(cfg.memory?.echo !== false)
          setNotifyOn(cfg.notify?.enabled === true)
          setCommentOn(cfg.comment?.enabled === true)
          setCommentPerDay(Number(cfg.comment?.perDay ?? 1))
          setCommentReplyPerDay(Number(cfg.comment?.replyPerDay ?? 2))
          setCommentReplyTo(cfg.comment?.replyToReplies !== false)
          // 「评论开头 @ 你」也随整表提交，就得和别的项一样从 /config 读（issue #69）。
          // 以前只在下面 /owner 成功时才设，/owner 一失败，界面停在初值 true，
          // 下一次自动保存就把盘上关着的它写回 true。判据和 GET /owner 同一个。
          setAtOwner(cfg.comment?.atOwner !== false)
          setCommentScanMin(Number(cfg.comment?.scanEveryMin ?? 30))
          setAtOn(cfg.at?.enabled === true)
          setAtEveryMin(Number(cfg.at?.scanEveryMin ?? 5))
          setAtPerDay(Number(cfg.at?.perDayMax ?? 20))
          setAtOthers(cfg.at?.others !== false)
          setAtOwnerWake(cfg.at?.ownerWake !== false)
          setRotateAfter(Number(cfg.chat?.rotateAfter ?? 40))
          setCarryTurns(Number(cfg.chat?.carry ?? 4))
          setReplyChars(Number(cfg.chat?.replyChars ?? 0))
          setUiHintDismissed(cfg.ui?.ownerHintDismissed === true)
          setToolsAllowText((cfg.tools?.allow ?? []).join(', '))
          setToolsAllowSaved(Array.isArray(cfg.tools?.allow) ? cfg.tools.allow.map(String) : [])
          setToolsRestrict(cfg.tools?.restrict !== false)
          setDocBudget(Number(cfg.memory?.docBudget ?? 2400))
          setBeliefsShown(Number(cfg.memory?.beliefsShown ?? 3))
          setHearEvery(Number(cfg.memory?.hearEvery ?? 3))
          setGrowthDaysUi(Number(cfg.growthDays ?? 30))
          setDiaryKeep(Number(cfg.diary?.keepDays ?? 0))
          setBrowseDeepRead(Number(cfg.browse?.deepRead ?? 6))
          setBrowseVoices(cfg.browse?.voices !== false)
          setVideoOn(cfg.video?.enabled !== false)
          setVideoPerDay(Number(cfg.video?.perDay ?? 2))
          setVideoFrames(Number(cfg.video?.frames ?? 9))
          setAvoidMinDur(Number(cfg.avoid?.minDuration ?? 60))
          setAvoidMids(((cfg.avoid?.upMids) || []).join('，'))
          setSleepEvery(Number(cfg.memory?.sleepEveryDays ?? 7))
          setSleepKeep(Number(cfg.memory?.sleepKeep ?? 12))
          // 时段：醒来 / 上网 / 说话。坏值由服务端兜底，这里只做展示。
          const w0 = Array.isArray(cfg.window) ? cfg.window : ['20:00', '23:00']
          setWakeFrom(w0[0]); setWakeTo(w0[1])
          // 上网时段：没单独配（null）就是跟着醒来时段，界面上直接显示醒来那两个数。
          const b0 = Array.isArray(cfg.browse?.window) ? cfg.browse.window : w0
          setBrowseFrom(b0[0]); setBrowseTo(b0[1])
          const c0 = Array.isArray(cfg.comment?.window) ? cfg.comment.window : ['20:00', '23:00']
          setCommentFrom(c0[0]); setCommentTo(c0[1])
          // 盘上的值刚灌进界面：这一帧重记基线，不当成「改过了」再写回去（见 cfgLoads）。
          baselinePending.current = true
          setCfgLoads((n) => n + 1)
          // 读全了：之前那句「还没从盘上读全」不再成立，收起来（别的失败原因照留）
          setSaveFail((m) => (m === CFG_MISSING ? '' : m))
          // 说话状态：单独取，失败不影响其它卡片
          jget('/comment').then(setCm).catch(() => {})
          jget('/at').then(setAtStatus).catch(() => {})
          // 登录态：失败不打断别处，红条只在明确过期时出现。
          jget('/bili/state').then(setBiliState).catch(() => {})
          jget('/reset').then(setResetInfo).catch(() => {})
          // 主人是谁（uid / 昵称 / 有没有 cookie）。cookie 原文永远不下发。
          // 「评论开头 @ 你」只从上面的 /config 取，这里不再设：/owner 晚回来时带的是发请求
          // 那一刻盘上的值，会把用户刚拨过的开关翻回去，自动保存再把旧值写回盘（issue #69）。
          jget('/owner').then((o) => {
            setOw(o)
            setOwMid(String(o?.mid ?? ''))
            setOwName(String(o?.name ?? ''))
          }).catch(() => {})
        } catch (e) {
          setErr(e.message)
        }
      }, [])

      useEffect(() => { load() }, [load])

      // 「查多久的记录」改了立刻重列（2026-11-07，用户反馈）。
      // 以前只 setHistDays，列表要等下一次整页刷新才可能变——而整页刷新又把这个值
      // 重置回 14，于是「改了没反应、关掉再开还是 14」两件事一起发生。
      const pickHistDays = useCallback(async (v) => {
        const n = Number(v)
        const days = HIST_DAYS_OPTIONS.includes(n) ? n : 14
        histDaysRef.current = days
        setHistDays(days)
        setHistPage(0)
        setHistErr('')
        storeHistDays(days)
        // 先选 90 再选 7，90 那次晚到时下拉框是 7、列表却是 90 天的：readHist 对不上就丢掉（issue #69）。
        // 只读卡片，失败不打断别处，只在这张卡里说没读到。
        await readHist(days)
      }, [])

      // 在线状态每 30 秒刷一次；页面在后台就不轮询（省电，也不制造无谓请求）。
      // 2026-10-23 加：他要能看见「醒了但没做什么」这种状态，而不是只有结果。
      useEffect(() => {
        let stop = false
        const peek = async () => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          try { const r = await jget('/status'); if (!stop) setSt(r) }
          catch { if (!stop) setSt({ phase: 'offline', label: '离线', detail: '服务没开，或者插件没加载' }) }
        }
        peek()
        const t = setInterval(peek, 30_000)
        return () => { stop = true; clearInterval(t) }
      }, [])

      // ---- 说话提醒（P3-3 重写，2026-10-23）----
      // 服务端只回答"该不该提醒、提醒什么"（GET /notify 的 due/text），
      // **弹是这里的事**。原实现调隐藏 PowerShell 弹 WinRT Toast，被火绒当
      // 木马行为拦下；更糟的是静默拦截时没有任何错误返回，lastShown 照样
      // 被写掉 → 当天再也不会弹。现在只用浏览器自己的能力，不产生任何子进程。
      //
      // 页面关着就不会有提醒——这是他本人接受的取舍（m05389）：第二天打开
      // 观测台照样能看到她说过什么。
      useEffect(() => {
        const has = typeof window !== 'undefined' && 'Notification' in window
        setNotifyPerm(has ? window.Notification.permission : 'unsupported')
        let stop = false
        const poll = async () => {
          try {
            const r = await jget('/notify')
            if (stop || !r?.due || !r?.text) return
            let shown = false
            if (has && window.Notification.permission === 'granted') {
              try {
                new window.Notification('大肥鱼跟你说话', { body: r.text, tag: 'dsh-fish' })
                shown = true
              } catch { /* 系统禁了就退到气泡 */ }
            }
            // 弹不出来也要让他看见——不然这条提醒就白记了
            if (!shown) setBubble(r.text)
            await jpost('/notify', { shown: true })
          } catch { /* 轮询失败不打扰他 */ }
        }
        poll()
        const t = setInterval(poll, 60_000)
        return () => { stop = true; clearInterval(t) }
      }, [])

      const allowNotify = async () => {
        try {
          if (typeof window === 'undefined' || !('Notification' in window)) {
            setErr('这个浏览器不支持桌面通知，大肥鱼说话时我只能在页面里提示你。')
            return
          }
          const p = await window.Notification.requestPermission()
          setNotifyPerm(p)
          setNote(p === 'granted'
            ? '好了，大肥鱼说话时会在系统里提醒你（一天最多一次）。'
            : '没拿到通知权限——那就在页面顶上提示你，效果一样的。')
        } catch (e) { setErr(e.message) }
      }


      // 只提交"环境"字段。她的性格相关的键一个都不在这里（B §8）。
      // 手动按钮和自动保存在同一处组装，避免两份字段表漂移。
      const buildConfig = () => ({
        absenceAfterDays: Number(absent),
        wakesPerDay: Number(wakes),
        daily: { events: Number(eventsPerDay), questions: Number(questionsPerDay) },
        growthDays: Number(growthDaysUi),
        // diary 不在这张表里：它有自己的 patchDiary（见下）。
        // 整表提交会把日记三项一起写一遍，手里一旦是旧值就等于替用户把开关关掉。
        avoid: {
          keywords: avoidText.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean),
          minDuration: Number(avoidMinDur),
          upMids: avoidMids.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean),
        },
        window: [wakeFrom, wakeTo],
        // 2026-11-07（用户反馈）：能上网这颗开关要写到两个地方——
        // bili.enabled 是 0.9.x 下 bili_look / bili_watch 真正认的闸门；
        // browse.enabled 留着给老参数（以及以后要不要恢复自动刷的那个决定）。
        browse: { enabled: browseOn, perDay: Number(browsePerDay), topN: Number(browseTopN), deepRead: Number(browseDeepRead), danmaku: Number(browseDanmaku), voices: Boolean(browseVoices), window: [browseFrom, browseTo] },
        video: { enabled: videoOn, perDay: Number(videoPerDay), frames: Number(videoFrames) },
        bili: { enabled: biliOn, minIntervalMs: Number(biliMinGap), jitterMs: Number(biliJitter) },
        notify: { enabled: notifyOn },
        chat: { rotateAfter: Number(rotateAfter), replyChars: Number(replyChars), carry: Number(carryTurns) },
        tools: { restrict: Boolean(toolsRestrict), allow: toolsAllowSaved },
        memory: { docBudget: Number(docBudget), sleepEveryDays: Number(sleepEvery), sleepKeep: Number(sleepKeep), beliefsShown: Number(beliefsShown), hearEvery: Number(hearEvery), echo: Boolean(echoOn) },
        comment: {
          enabled: commentOn,
          perDay: Number(commentPerDay),
          replyPerDay: Number(commentReplyPerDay),
          replyToReplies: commentReplyTo,
          atOwner,
          scanEveryMin: Number(commentScanMin),
          window: [commentFrom, commentTo],
        },
        at: {
          enabled: atOn,
          scanEveryMin: Number(atEveryMin),
          perDayMax: Number(atPerDay),
          others: atOthers,
          ownerWake: atOwnerWake,
        },
      })

      // 数字框可能停在半截（清空、只打了一个「1」）。这种值不写盘，
      // 否则服务端 clamp 会静默改成下限，用户以为自己输的就是生效值。
      const NUM_BOUNDS = [
        ['冷落天数', absent, 1, 30],
        ['每天醒几次', wakes, 0, 4],
        ['每天最多几条事件', eventsPerDay, 0, 6],
        ['每天最多几个问题', questionsPerDay, 0, 6],
        ['成长周期', growthDaysUi, 7, 180],
        // 日记三项不在这里：它们由 patchDiary 单独提交（整表保存会把开关写回旧值）。
        ['最短时长', avoidMinDur, 0, 3600],
        ['每天最多刷几次', browsePerDay, 0, 4],
        ['每次翻几条', browseTopN, 1, 20],
        ['每条读几条热评', browseDeepRead, 0, 20],
        ['每条读几条弹幕', browseDanmaku, 0, 30],
        ['两次请求最少隔多久', biliMinGap, 200, 120000],
        ['随机多等', biliJitter, 0, 60000],
        ['每天看几条画面', videoPerDay, 0, 6],
        ['每条取几帧', videoFrames, 4, 16],
        ['聊满多少轮换新会话', rotateAfter, 0, 500],
        ['换新会话时带几轮原话', carryTurns, 0, 20],
        ['她一轮最多写多少字', replyChars, 0, 2000],
        ['身份段字数', docBudget, 600, 4000],
        ['眼前的判断条数', beliefsShown, 1, 8],
        ['回头想间隔', sleepEvery, 0, 60],
        ['总共留几条自述', sleepKeep, 0, 100],
        ['每几轮记一句', hearEvery, 0, 50],
        ['每天几条评论', commentPerDay, 0, 5],
        ['每天回复几条', commentReplyPerDay, 0, 10],
        ['隔几分钟扫', commentScanMin, 5, 720],
      ]
      const badNumber = () => {
        for (const [label, value, lo, hi] of NUM_BOUNDS) {
          const n = Number(value)
          if (!Number.isFinite(n) || n < lo || n > hi) return `${label}（${lo}–${hi}）`
        }
        return ''
      }

      const save = async (silent = false) => {
        if (!silent) { setBusy('save'); setNote('') }
        try {
          await jpost('/config', buildConfig())
          if (silent) flashSaved()
          else { setNote('已保存。下一轮 tick 生效。'); await load() }
        } catch (e) {
          if (silent) failSave(e.message)
          else setErr(e.message)
        } finally { if (!silent) setBusy('') }
      }

      // 日记三项单独提交（2026-10-28 用户反馈「开了『让我看日记』插件又自己关」）。
      // 走整表保存时，任何一项环境参数变化都会顺带把 diary 一起写一遍；
      // 只要那一刻手里是旧值，开关就被静默翻回去。这里改成「改了哪项就只提交哪项」，
      // 服务端 updateConfig 是深合并，没传的键原样保留。
      const patchDiary = async (patch) => {
        diaryTouchedAt.current = Date.now()
        diaryPending.current += 1
        try {
          await jpost('/config', { diary: patch })
          flashSaved()
        } catch (e) { failSave(e.message) } finally { diaryPending.current -= 1 }
      }

      // 主动说话（0.8.1 本机实验）：同样只提交改了的那一项，别把别的开关写回旧值。
      const patchProactive = async (patch) => {
        try {
          await jpost('/config', { proactive: patch })
          flashSaved()
          return true
        } catch (e) { failSave(e.message); return false }
      }

      // 「安静多久才搭话」（issue #69）：以前每按一个键就单独 POST 一次，离开输入框再写一次；
      // 从 6 改成 12 会依次写 0、1、12、12，清空那一下服务端夹成 1，停在半截时生效的就是 1 小时。
      // 现在和「发话工具」一样停手 700ms 再存；清空、不在范围里的不写，
      // 小数照服务端写盘时的取整先取整，框里也换成那个数；和盘上一样就不再写。
      const IDLE_HOURS = [1, 24]
      const pickProactiveIdle = (v) => {
        setProactiveIdle(v)
        clearTimeout(proactiveIdleTimer.current)
        const raw = String(v ?? '').trim()
        const n = Number(raw)
        if (!raw || !Number.isFinite(n) || n < IDLE_HOURS[0] || n > IDLE_HOURS[1]) return
        const hours = Math.round(n)
        proactiveIdleTimer.current = setTimeout(async () => {
          // 框里换成要存的那个数：小数取了整，中间有过重读（load）把框改回旧值的，也对回来
          setProactiveIdle(hours)
          if (hours === proactiveIdleSaved.current) return
          proactiveIdleSaved.current = hours
          const ok = await patchProactive({ minIdleHours: hours })
          // 没存上：不知道盘上现在是几，下次不管填几都再写
          if (!ok && proactiveIdleSaved.current === hours) proactiveIdleSaved.current = null
        }, 700)
      }

      // 顶层那三个开关（梦 / 主动性 / 兴趣）：各写各的组，互不覆盖。
      const patchGroup = async (key, patch) => {
        try {
          await jpost('/config', { [key]: patch })
          flashSaved()
        } catch (e) { failSave(e.message) }
      }

      // 改完就生效：任何一项变了，停手 700ms 就写盘（连点加减号也只写一次）。
      const cfgSig = JSON.stringify(buildConfig())
      useEffect(() => {
        if (!state) return
        const bad = badNumber()
        // 越界的数改回范围里了，失败框就收起来：改回的正好是盘上的值时，下面那句会直接返回、不再写盘，
        // 框就一直挂着说「超出了允许的范围」。别的原因的失败不在这里收。
        if (saveFailRange && !bad) failSave('')
        if (baselinePending.current) { baselinePending.current = false; lastSaved.current = cfgSig; return }
        if (cfgSig === lastSaved.current) return
        // 越界是眼前的错，先说这个；「还没读全」只是拦着不写盘，别盖过它（issue #95 的用例）。
        if (bad) { failRange(bad); return }
        if (!cfgLoads) { failSave(CFG_MISSING); return }
        const t = setTimeout(async () => {
          try {
            const r = await jpost('/config', buildConfig())
            lastSaved.current = cfgSig
            // 服务端丢掉了几个「这台机器上不存在」的名字（2026-10-31 issue #14）：
            //   · 把 cleaned 名单收回来，否则下一次整表提交又带着它、每次都白丢一遍；
            //   · 名字说出来，别让用户以为自己设的还在。
            //   · 只改「已存名单」，不动输入框里的草稿——他可能正在那儿打字。
            const gone = Array.isArray(r?.droppedTools) ? r.droppedTools.filter(Boolean) : []
            if (gone.length) {
              const kept = Array.isArray(r?.config?.tools?.allow) ? r.config.tools.allow.map(String) : []
              setToolsAllowSaved(kept)
              setDroppedTools(gone)
            }
            flashSaved()
          } catch (e) { failSave(e.message) }
        }, 700)
        return () => clearTimeout(t)
      }, [cfgSig, state, cfgLoads])

      const saveTools = async () => {
        setBusy('tools'); setToolsSaveNote(''); setToolsSaveErr('')
        try {
          let known = toolsKnown
          let own = toolsOwnLayer
          // 2026-10-29：每次保存都问一次宿主，顺带拿回 own 层名单。
          // 以前只在 known 为空时问，于是「哪些名字收窄挡不住」永远是空的。
          try {
            const r = await jget('/tools')
            const names = Array.isArray(r?.known) ? r.known : null
            if (names && names.length) { known = names; setToolsKnown(names) }
            own = Array.isArray(r?.ownLayer) ? r.ownLayer : []
            setToolsOwnLayer(own)
            setToolsBlocked(Array.isArray(r?.blocked) ? r.blocked : [])
            if (Array.isArray(r?.herTools)) setToolsHerTools(r.herTools)
            setToolsAllowNow(Array.isArray(r?.allowNow) ? r.allowNow : null)
            setToolsEffective(Array.isArray(r?.effective) ? r.effective : null)
            setToolsRunKnown(Boolean(r) && Object.prototype.hasOwnProperty.call(r, 'allowNow'))
            setToolsSkippedSure(typeof r?.skippedSure === 'boolean' ? r.skippedSure : null)
            setToolsLoad('ok')
          } catch { /* 拿不到就沿用旧名单，只查拼写 */ }
          const check = checkToolNames(toolsAllowText, known)
          if (!check.ok) {
            setToolsSaveErr(`这些名字不对：${check.unknown.join('、')}。没保存。`)
            return
          }
          // 名单没拿到（她还没在本进程里开过会话，或宿主换了版本）时，只查了拼写——
          // 这点必须说出来，否则用户以为「过了校验」就等于「名字一定存在」。
          const onlyShape = !known || !known.length
          const before = toolsAllowSaved.length
          // strictTools：这是用户刚在输入框里敲完点的「保存」，坏名字要当场拦下来。
          // 页面自动保存走的是另一条（不带这个标记）：那边丢掉坏名字、其余照存，
          // 因为回传的是盘上已有的旧名单，用户没在编辑它（2026-10-31 issue #14）。
          const saved = await jpost('/config', { tools: { restrict: Boolean(toolsRestrict), allow: check.names }, strictTools: true })
          // 服务端存盘后会当场换刀（0.9.8 起）：返回 toolsLive 就是换成了，没返回就是没动名单。
          const live = saved?.toolsLive?.ok === true
          const deferredTools = saved?.toolsLive?.deferred ?? 0
          setToolsAllowSaved(check.names)
          await load()
          const delta = check.names.length - before
          // 回执按收窄开没开分两支（0.9.5 只看名单是不是空的，两头都说反了）：
          // 收窄关着时白名单不限制她，多填少填都不会让她「多看见」「少看见」什么；
          // 收窄开着时名单清空，当场就只剩她自己的那几件。
          // 0.9.8（2026-11-11，外部用户反馈）：白名单存完当场换刀，不用重启；
          // 只有老服务端（没回 toolsLive）才按旧说法说「重启之后」。
          const tail = live && deferredTools
            ? `（这一局还有 ${deferredTools} 条她自己的工具没登记齐，下次开新会话会补进去。）`
            : ''
          if (!toolsRestrict) {
            setToolsSaveNote(check.names.length
              ? `存好了。收窄关着，白名单现在不限制她：她照样能用全部工具。名单一共 ${check.names.length} 个，打开收窄才按它来。`
              : '存好了。收窄关着，白名单现在不限制她：她照样能用全部工具；打开收窄才按名单来。')
          } else if (!check.names.length) setToolsSaveNote(live ? '存好了，现在就生效：她只剩自己那几件工具。' : '存好了。白名单是空的：重启 DSH 之后她只剩自己那几件工具。')
          else if (delta > 0) setToolsSaveNote(live
            ? `存好了，现在就生效：她会多看见 ${delta} 个工具（名单一共 ${check.names.length} 个）。${tail}`
            : `存好了。重启 DSH 之后她会多看见 ${delta} 个工具（名单一共 ${check.names.length} 个）。`)
          else if (delta < 0) setToolsSaveNote(live
            ? `存好了，现在就生效：她会少看见 ${-delta} 个工具（名单一共 ${check.names.length} 个）。${tail}`
            : `存好了。重启 DSH 之后她会少看见 ${-delta} 个工具（名单一共 ${check.names.length} 个）。`)
          else setToolsSaveNote(`存好了。名单没变，还是 ${check.names.length} 个。`)
          const ownPicked = check.names.filter((n) => own.includes(n))
          if (ownPicked.length) {
            setToolsSaveNote((n) => `${n} 其中 ${ownPicked.join('、')} 是她本来就看得见的（插件把她自己的工具注册进她那一层，收窄挡不住）：加进白名单只是让兜底守卫放行它。`)
          }
          if (onlyShape && check.names.length) {
            setToolsSaveNote((n) => `${n} 这次只核对了拼写——她还没开过会话，宿主那边还给不出工具名单。名字必须一字不差。`)
          }
        } catch (e) {
          setToolsSaveErr(e.message)
        } finally { setBusy('') }
      }

      /**
       * 主人身份与 B 站登录。
       * cookie 只上行不下行——输入框永远是空的，存过之后只显示「已保存」。
       */
      const saveOwnerCard = async () => {
        setBusy('owner'); setOwNote('')
        try {
          // 2026-11-06（用户反馈）：这三格原来是「一律原样提交」，于是只粘 cookie、两格
          // 没填（或先清空了）的人，点一次保存就把 mid / 昵称覆写成空串 —— 昵称一空，
          // mentionPrefix 就返回空串，评论里再也 @ 不出来。现在只提交填了的格子。
          const body = {}
          if (owMid.trim()) body.mid = owMid.trim()
          if (owName.trim()) body.nickname = owName.trim()
          if (owCookie.trim()) body.cookie = owCookie.trim()
          if (!Object.keys(body).length) { setOwNote('三格都是空的，没东西可存。'); setBusy(''); return }
          const r = await jpost('/owner', body)
          setOwNote(r.note || (r.ok ? '存下了。' : '没存上。'))
          setOwCookie('')
          await load()
        } catch (e) { setOwNote(e.message) } finally { setBusy('') }
      }

      /**
       * 只保存「领养人」那两格（2026-11-06，用户反馈）。
       * 以前这两格唯一能存的地方挂在下面「B 站登录 → 粘贴 cookie」页签底部：
       * 停在领养人这一组里找不到，停在扫码页签里那颗键压根不渲染，填完等于白填。
       * 现在这组自带一颗，提交范围也只有这两格——不动下面那份 cookie，也不把空串写回去。
       * 存完刷一次 /owner：旧版本写脏时那句提示会跟着消失，两格也换回服务端真正存下的值。
       */
      const saveOwnerIdentity = async () => {
        setBusy('owid'); setOwIdNote('')
        try {
          const body = {}
          if (owMid.trim()) body.mid = owMid.trim()
          if (owName.trim()) body.nickname = owName.trim()
          if (!Object.keys(body).length) { setOwIdNote('两格都空着，没有可存的。'); setBusy(''); return }
          const r = await jpost('/owner', body)
          setOwIdNote(r.note || (r.ok ? '存下了。' : '没存上。'))
          if (r.ok) { flashSaved(); await load() }
        } catch (e) { setOwIdNote(e.message) } finally { setBusy('') }
      }

      const testOwner = async () => {
        setBusy('owtest'); setOwNote('')
        try {
          const r = await jpost('/owner', { test: true })
          setOwNote(r.note || (r.ok ? '可以说话。' : '还不行。'))
          // 2026-10-27：测试只认「这份 cookie 登的是谁」，不再回填领养人输入框。
          // 以前这里会把 owMid / owName 改成小号，用户手填的大号当场被冲掉。
          await load()
        } catch (e) { setOwNote(e.message) } finally { setBusy('') }
      }

      /**
       * 扫码登录（2026-11-01）。
       * 码在宿主那边生成——passport 接口没有 CORS 头，页面里 fetch 会当场被挡。
       * 这里拿到的只有一张 SVG 和一把 key；cookie 原文永远到不了页面。
       *
       * 2026-11-02：点下去之后**一定要有反馈**。以前生成失败时只往卡片里塞一行灰字，
       * 浮层根本不弹，人看到的就是「点了没反应」。现在失败也把浮层打开，
       * 里面写清为什么没有码（多半是宿主还跑着旧版插件，重启才好）。
       */
      const qrFail = (why) => {
        const msg = String(why || '没生成出来，再点一次。')
        setQrNote(msg)
        setQr({
          key: '', svg: '', expiresAt: 0,
          state: 'error', note: msg, account: null, canWrite: false,
        })
      }
      const startQr = async () => {
        setQrBusy(true); setQrNote('')
        try {
          // 刷新＝换一张：旧的那张连它攥着的 cookie 一起丢掉，不留两把钥匙。
          // 但 drop 失败要留痕（2026-11-02）：以前这里 .catch(() => {}) 把 404 也吃了，
          // 宿主根本没装这个插件版本时，界面上一点线索都没有。
          if (qr?.key) {
            jpost('/bili/qr/drop', { key: qr.key })
              .catch((e) => console.warn('[dsh-fish] 丢掉旧二维码失败：', e?.message || e))
          }
          const r = await jpost('/bili/qr', {})
          if (!r?.ok) { qrFail(r?.why); return }
          setQr({
            key: r.key,
            svg: r.svg,
            expiresAt: Number(r.expiresAt ?? (Date.now() + (Number(ow?.qrTtlMs) || 180_000))),
            state: 'waiting',
            note: '',
            account: null,
            canWrite: false,
          })
        } catch (e) {
          // 404/405 = 宿主还跑着旧版插件，新路由没注册上（405 是宿主对未注册前缀的默认应答）。
          // 说人话，别让人对着「HTTP 405」猜要不要重启。
          const m = String(e?.message || e)
          qrFail(/HTTP (404|405)/.test(m)
            ? '宿主还没加载这一版插件（多半是没重启）。完全退出 DSH 再打开，然后重新点一次。'
            : m)
        } finally { setQrBusy(false) }
      }

      /** 关浮层＝放弃这次登录：让宿主把那张码和攥着的 cookie 一起忘掉。 */
      const closeQr = () => {
        const key = qr?.key
        setQr(null); setQrNote('')
        if (key) jpost('/bili/qr/drop', { key }).catch(() => {})
      }

      /** 人点了「确认」才写盘——扫码成功只是把 cookie 攥在宿主内存里。 */
      const saveQrLogin = async () => {
        if (!qr?.key) return
        setQrBusy(true); setQrNote('')
        try {
          const r = await jpost('/bili/qr/save', { key: qr.key })
          if (!r?.ok) { setQrNote(r?.why || r?.error || '没存上。'); return }
          setQr(null)
          setOwNote(r.note || '存下了。')
          await load()
        } catch (e) { setQrNote(e.message) } finally { setQrBusy(false) }
      }

      /** 清除登录：cookie 与「登的是谁」一起清，别留一个会误导人的旧名字。 */
      const clearLogin = async () => {
        setBusy('owclear'); setOwNote('')
        try {
          const r = await jpost('/owner', { cookie: '' })
          setOwNote(r.note || '清掉了。')
          await load()
        } catch (e) { setOwNote(e.message) } finally { setBusy('') }
      }

      const wake = async () => {
        setBusy('wake'); setNote('')
        try {
          const r = await jpost('/wake')
          setNote(r.ok ? '已叫醒。' : `没叫：${r.why || ''}`)
          await load()
        } catch (e) {
          setErr(e.message)
        } finally { setBusy('') }
      }

      // ---- P3-1：跟她说一句话 ----
      const send = async () => {
        const t = sayText.trim()
        if (!t) return
        setBusy('say'); setNote(''); setSaid([])
        try {
          const r = await jpost('/say', { text: t })
          setSaid(r.said || [])
          setSayText('')
          setNote(r.said?.length ? '' : (r.note || '大肥鱼这次没说话。'))
          await load()
        } catch (e) {
          setErr(e.message)
        } finally { setBusy('') }
      }

      // 一条规则被驳回几次之后就不再自动提：unlock.js 的 offerLimits 永远给两档冷却（retryDays 两个数），
      // offerDueDay 在驳回次数到了档数时回 null。cooldownDays 只改天数，不改档数。
      const RULE_REJECT_MAX = 2
      const rejectsOf = (ruleId) => (rules?.history || [])
        .filter((x) => x && x.rule === ruleId && x.verdict === 'reject').length

      // ---- R3：裁决她提上来的那张申请 ----
      // 批准会立刻重写身份文档，她下一次开口就看得见"这件事现在可以了"。
      const decide = async (verdict) => {
        setBusy('decide')
        setErr('')
        // 点之前先记下这条规则已经被驳回过几次：回执要说清这一次是不是最后一次。
        const rule = rules?.pending?.rule || ''
        const left = RULE_REJECT_MAX - rejectsOf(rule) - 1
        try {
          const r = await jpost('/decide', { verdict })
          if (r && r.error) throw new Error(r.error)
          setNote(verdict === 'approve'
            ? '答应了，下一次开口她就知道这件事现在可以了。'
            : rules?.offersOn === false
              ? '记下了「这次不行」。申请通道现在关着，她不会再自动提。'
              : left > 0
                ? `记下了「这次不行」。条件还够的话，过几天她可能再提一次；再驳回 ${left} 次就不再自动提。`
                : '记下了「这次不行」。这条已经驳回到上限，以后她不会再自动提了。')
          await load()
        } catch (e) {
          setErr(e.message || String(e))
        } finally { setBusy('') }
      }

      // ---- P3-2：信箱已读 ----
      const markInbox = async () => {
        setBusy('inbox')
        try { await jpost('/inbox'); await load() } catch (e) { setErr(e.message) } finally { setBusy('') }
      }

      // ---- P4：把她放回第一天 ----
      // 两步：先读"将要封存什么"给他看，再要求他按第二次（真按钮）。
      // 不做 undo —— 但旧数据是**改名封存**，不是删，所以真后悔了还能从
      // 同级目录的 dsh-fish-backups/reset-* 里整包搬回来。
      const askReset = async () => {
        setBusy('reset-ask'); setNote('')
        try {
          const info = await jget('/reset')
          setResetInfo(info)
          setResetAsk(true)
        } catch (e) { setErr(e.message) } finally { setBusy('') }
      }
      // ---- 导入别人养过的大肥鱼（2026-10-27，用户 m03170）----
      // 先读「现在能不能导 + 交接单模板」，再让用户粘贴/上传，最后才写。
      // 为什么不做一键上传文件：宿主的文件选择要另一套接口，而这是一次性动作，
      // 让他把文本贴进来最省事，也不给插件多一条读文件的通路。
      const askImport = async () => {
        setImportBusy('ask'); setNote('')
        try {
          const i = await jget('/import')
          setImportInfo(i)
          // 模板只在第一次填进去，之后不再覆盖用户已经写的/贴的内容
          setImportText((cur) => (cur ? cur : (i.template || '')))
          setImportAsk(true)
        } catch (e) { setErr(e.message) } finally { setImportBusy('') }
      }
      const doImport = async () => {
        setImportBusy('go'); setNote(''); setImportNote('')
        try {
          const r = await jpost('/import', { text: importText })
          setImportAsk(false)
          // note 用 <pre class="ok"> 渲染，单行说完；细节放 importNote
          const bits = []
          if (r.name) bits.push(`她现在管你叫「${r.name}」`)
          // 「这次新放行几个」和「名单现在共几个」分开说：只报总数时，原来放行 3 个、
          // 交接单带 2 个（1 个重复）会写成「工具白名单 4 个」，像是这次带进来 4 个。
          if (r.toolsError) {
            // 写配置失败：tools 是交接单里写的那几个，一个都没放行。不能写成「这次新加 0 个」。
            bits.push(`工具白名单没写进去（${r.toolsError}），交接单里的 ${r.tools?.length ?? 0} 个工具这次都没放行，要的话到「插件」页的「她能用的工具」里自己加`)
          } else if (r.tools?.length) {
            const added = Array.isArray(r.toolsAdded) ? r.toolsAdded.length : 0
            bits.push(`工具白名单这次新加 ${added} 个，现在一共 ${r.tools.length} 个`)
          }
          setNote(`人设接过来了。${bits.length ? bits.join('，') + '。' : ''}从第 ${r.day} 天开始。`)
          setImportNote('她的人设下一轮就生效（身份是每轮现读的）。工具白名单存好也当场生效，不用重启。')
          await load()
        } catch (e) {
          setImportNote(e.message)
        } finally { setImportBusy('') }
      }

      // 下载交接单模板（2026-10-27，用户 m04565）：
      // 用户的原话是「出一个导入人设的提示词模版，点一下下载到本地，然后可以拿给那个要导入
      // 人设的 ai 去写对应它自己的提示词」。所以模板不是给人照着填的表格，是一份**给对面 AI 的
      // 说明书** —— 上面写着怎么写、不要写什么，下面才是三节空表格。
      // 一键下载成 .md，直接丢给对面那个 AI 就行。
      const downloadTemplate = async () => {
        try {
          const i = importInfo?.template ? importInfo : await jget('/import')
          const tpl = i.template || ''
          if (!tpl) { setImportNote('没读到模板。'); return }
          if (typeof document === 'undefined' || typeof Blob === 'undefined') {
            setImportNote('这个环境不支持下载。'); return
          }
          const blob = new Blob([tpl], { type: 'text/markdown;charset=utf-8' })
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = '大肥鱼-交接单.md'
          a.click()
          setTimeout(() => URL.revokeObjectURL(url), 4000)
          setImportNote('交接单已下载。把它发给「现在养着她的那个 AI」，让它照着上面的说明填三节，填完再贴回这里。')
        } catch (e) { setImportNote(e.message) }
      }

      const doReset = async () => {
        setBusy('reset'); setNote('')
        try {
          const r = await jpost('/reset', { confirm: 'reset' })
          setResetAsk(false)
          // issue #65：重开一局之后「能不能接别人养过的」要重新问服务器，
          // 不然界面还挂着重置前的 canImport:false。
          setImportInfo(null)
          // 没搬东西（movedTo 为空）只有一种情况：本来就没有档。不拿服务端的 note 当开头——
          // 它自己也说了一遍去哪叫醒，和下面那句叠在一起，按钮名字还是旧的。
          const head = r.movedTo ? `已重开。旧的都在：${r.movedTo}` : '已重开。本来就没有旧档，没有东西要搬。'
          // 单行：这个 note 用 <pre class="ok"> 渲染，换行会撑出一块绿色告示，不如一句话说清。
          // 2026-10-26（m01426 真机反馈）：重置会把新会话建出来，也会顺手叫一声，但**侧栏仍然看不见**——
          // 宿主的 sessionVisible 规则是「空白会话只有成为当前会话才显示」，而插件用 API 建的会话永远
          // 不会成为 current。实测只有用户自己点一次「叫醒大肥鱼」才会出现。所以提示以这一步为准，
          // 不再承诺「侧栏已经冒出」。
          const tail = r.freshError
            ? ` 新会话没建出来：${r.freshError}`
            : (r.retiredError
              ? ` 旧会话没收干净：${r.retiredError}。到「状态」页点一下「现在叫醒大肥鱼」，她开一次口，侧栏里才看得见新会话。`
              : ' 侧栏这会儿还看不到她——到「状态」页点一下「现在叫醒大肥鱼」，她开一次口，「跟大肥鱼说话」才会出现在侧栏里。')
          setNote(`${head}${tail}`)
        } catch (e) {
          setErr(e.message)
        } finally { setBusy('') }
      }

      // 会话被用户归档之后，插件不再自动重开（0.6.8）。必须有个明说的入口，
      // 否则「收起来」就真的变成「再也回不去」。它只建新会话，不动任何文件。
      const doRebuild = async () => {
        setBusy('rebuild'); setNote('')
        try {
          const r = await jpost('/home/rebuild', { confirm: 'rebuild' })
          if (!r.ok) setNote(`没搭成：${r.error || r.note || ''}`)
          else if (r.woke) setNote('搭好了，也叫了她一声——侧栏里等她说出第一句就会出现。')
          else setNote('搭好了。到「状态」页点一下「现在叫醒大肥鱼」，她开一次口，侧栏里才看得见这条会话。')
          await load()
        } catch (e) {
          setErr(e.message)
        } finally { setBusy('') }
      }

      if (err && !state) {
        return h('div', { className: 'dfish' },
          h('h2', null, '大肥鱼'),
          h('p', { className: 'sub' }, '读不到状态。'),
          h('pre', { className: 'err' }, err))
      }

      const s = state
      const kv = (pairs) => h('div', { className: 'kv' },
        pairs.filter(Boolean).flatMap(([k, v]) => [h('b', { key: 'k' + k }, k), h('span', { key: 'v' + k }, v)]))

      // 时段行（2026-10-23 加）：三个时段用同样的控件，省得三处各写一遍还对不齐。
      // type=time 在浏览器里自带时间选择器；跨零点（22:00→02:00）是允许的，由服务端判定。
      const timeRow = (label, from, to, setFrom, setTo, hint) =>
        h('label', null, label,
          h('input', { type: 'time', value: from, onChange: (e) => setFrom(e.target.value) }),
          h('span', { className: 'dim' }, '到'),
          h('input', { type: 'time', value: to, onChange: (e) => setTo(e.target.value) }),
          hint ? h('span', { className: 'dim' }, hint) : null)

      // ---- 表单控件（2026-10-23 重做）----
      // 只用 React.createElement，不引任何依赖：这一节跑在宿主的客户端沙箱里。
      function Toggle(o) {
        return h('div', { className: 'fld' },
          h('div', { className: 'fl' },
            h('span', { className: 'flabel' }, o.label),
            o.hint ? h('span', { className: 'fhint' }, o.hint) : null),
          h('button', {
            type: 'button',
            className: 'sw' + (o.on ? ' on' : ''),
            role: 'switch',
            'aria-checked': o.on ? 'true' : 'false',
            onClick: () => o.onChange(!o.on),
          }, h('span', { className: 'knob' })))
      }
      function Num(o) {
        const cur = Number(o.value || 0)
        const step = o.step || 1
        // 空串/非数字（比如把框清空）不当成 0，落到下限；否则会显示 「NaN」。
        const clamp = (n) => {
          const v = Number(n)
          const base = Number.isFinite(v) ? v : o.min
          return String(Math.min(o.max, Math.max(o.min, base)))
        }
        return h('div', { className: 'fld' },
          h('div', { className: 'fl' },
            h('span', { className: 'flabel' }, o.label),
            o.hint ? h('span', { className: 'fhint' }, o.hint) : null),
          h('div', { className: 'row', style: { gap: '6px' } },
            h('button', { className: 'step', onClick: () => o.onChange(clamp(cur - step)) }, '−'),
            h('input', {
              type: 'number', min: o.min, max: o.max, step, value: o.value,
              onChange: (e) => o.onChange(e.target.value),
              // 2026-10-24: 打字不受 input 的 min/max 约束（浏览器只当校验提示），
              // 离开输入框时按上下限收敛一次，免得界面显示 9999、保存后又被服务端改成上限。
              onBlur: (e) => o.onChange(clamp(e.target.value)),
            }),
            h('button', { className: 'step', onClick: () => o.onChange(clamp(cur + step)) }, '+'),
            o.unit ? h('span', { className: 'dim' }, o.unit) : null))
      }
      function Sel(o) {
        return h('div', { className: 'fld' },
          h('div', { className: 'fl' },
            h('span', { className: 'flabel' }, o.label),
            o.hint ? h('span', { className: 'fhint' }, o.hint) : null),
          h('select', { value: String(o.value), onChange: (e) => o.onChange(e.target.value) },
            ...o.options.map((v) => h('option', { key: String(v), value: String(v) },
              o.fmt ? o.fmt(v) : String(v)))))
      }
      function Text(o) {
        return h('div', { className: 'fld', style: o.wide ? { gridColumn: '1 / -1' } : undefined },
          h('div', { className: 'fl' },
            h('span', { className: 'flabel' }, o.label),
            o.hint ? h('span', { className: 'fhint' }, o.hint) : null),
          h('input', { type: 'text', value: o.value, placeholder: o.placeholder,
            onChange: (e) => o.onChange(e.target.value) }))
      }
      function TimeRange(o) {
        // 2026-11-06（0.9.2 反馈）：原生时间框跟随系统 12 小时制，00:00 显示成
        // 「上午 12:00」——中文用户会读成中午十二点，于是以为窗口是 12:00–23:00，
        // 再看到凌晨五点醒来就当成 bug。输入框保留（有选择器），下面补一行
        // 24 小时制把值说死；跨零点时标明「次日」。
        const hhmm = (v) => {
          const m = /^(\d{1,2}):(\d{2})$/.exec(String(v ?? ''))
          return m ? `${m[1].padStart(2, '0')}:${m[2]}` : ''
        }
        const from = hhmm(o.from)
        const to = hhmm(o.to)
        const nextDay = from && to && to < from ? '次日 ' : ''
        return h('div', { className: 'fld' },
          h('div', { className: 'fl' },
            h('span', { className: 'flabel' }, o.label),
            o.hint ? h('span', { className: 'fhint' }, o.hint) : null),
          h('div', { className: 'row', style: { gap: '6px' } },
            h('input', { type: 'time', value: o.from, onChange: (e) => o.onFrom(e.target.value) }),
            h('span', { className: 'dim' }, '到'),
            h('input', { type: 'time', value: o.to, onChange: (e) => o.onTo(e.target.value) })),
          from && to
            ? h('div', { className: 'dim', style: { fontSize: '12px', marginTop: '2px' } },
                `24 小时制：${from} → ${nextDay}${to}`)
            : null)
      }

      // 工具面：把限制的理由写给用户看，给一个总开关，另留一处额外放行口。
      // 2026-10-24 起这条限制是真的（restrict 37→8，另有一道 guard 兜底），
      // 所以界面上的说法从「还没打通」改成「已经做到」——配置不许撒谎。
      // 定时工具是宿主给的、默认不放（用户 m04504）：用户自己加进白名单之后，
      // 这里才改口说「她能自己定提醒」——界面不替配置撒谎。
      const scheduleOn = (toolsAllowSaved ?? []).some((n) => String(n).trim() === 'schedule_create')

      // ---- 工具分组（2026-11-04，issue #20）----
      // 以前这里只有一个空输入框：用户既不知道这台机器上到底有哪些工具，也不知道该填哪个，
      // 只能去翻日志或者凭猜。现在按来源分组摆出来，点一下就是加/减白名单；
      // 输入框留着当手工兜底（批量粘贴、填还没注册的名字）。
      const allowList = String(toolsAllowText || '').split(',').map((s) => s.trim()).filter(Boolean)
      const toggleTool = (name) => {
        const next = allowList.includes(name) ? allowList.filter((n) => n !== name) : [...allowList, name]
        setToolsAllowText(next.join(', '))
        setToolsSaveNote('')
        setToolsSaveErr('')
      }
      const herList = Array.isArray(toolsHerTools) ? toolsHerTools : []
      // 只在特定场合才交给她的那几件（服务端现算：这一版注册了哪些 + 各自的场合说明）。
      // 它们不进「她自己本来就有的」那组（那组说的是家里随时能用的），也不能掉进
      // 「装了但没放行」——用户会以为得在这里点一下才给得了她。
      const herSceneList = (Array.isArray(toolsHerScene) ? toolsHerScene : [])
        .map((t) => (typeof t === 'string' ? { name: t, why: '' } : t))
        .filter((t) => t && t.name)
      const sceneWhy = new Map(herSceneList.map((t) => [t.name, t.why]))
      const herSet = new Set([...herList, ...herSceneList.map((t) => t.name)])
      const ownSet = new Set(toolsOwnLayer ?? [])
      // 她自己的工具这一局在不在她手上（issue #69 第 9 条）：herTools 只说「哪些是她的」，
      // 守卫放行的是启动时算定的 allowNow，真下给宿主的是 effective。不在这两份里的，
      // 摆进「不用放行」就是在替守卫撒谎——关着梦启动时的 her_dream、宿主这次没有的 read_image。
      // 服务端没给 allowNow（收窄这一局没在管，或老版本）时照旧全算在手上。
      const allowNowList = Array.isArray(toolsAllowNow) ? toolsAllowNow : null
      const effNowList = Array.isArray(toolsEffective) && toolsEffective.length ? toolsEffective : null
      const inHandNow = (n) => !allowNowList || (allowNowList.includes(n) && (!effNowList || effNowList.includes(n) || ownSet.has(n)))
      // 宿主没给 visible（skippedSure 为 false）时，守卫放行、没下给 restrict 的名字分不清是这次没注册，
      // 还是在她自己那一层（那样她照样看得见）。跟自检「手上的工具」同一个口径：单列一组，不说定论。
      const unsureNow = (n) => toolsSkippedSure === false && Boolean(allowNowList) && allowNowList.includes(n) &&
        Boolean(effNowList) && !effNowList.includes(n) && !ownSet.has(n)
      const herHere = herList.filter(inHandNow)
      const herUnsure = herList.filter((n) => !inHandNow(n) && unsureNow(n))
      const herAway = herList.filter((n) => !inHandNow(n) && !unsureNow(n))
      const herAwaySet = new Set([...herAway, ...herUnsure])
      // 这一局守卫没放行 her_dream（关着梦启动的）。
      const dreamHeld = Boolean(allowNowList) && !allowNowList.includes('her_dream')
      // 这一局收窄在不在管：按 /tools 的 allowNow 说（守卫启动时就定了），不按盘上的开关——
      // 拨了开关、还没重启的那段时间两者不一样。名单没读到是 null，只能按开关说。
      const runRestrict = toolsLoad === 'ok' && toolsRunKnown ? Array.isArray(toolsAllowNow) : null
      const blockedAll = (toolsBlocked ?? []).map((b) => (typeof b === 'string' ? { name: b } : b)).filter((b) => b && b.name)
      // 她自己的、这一局不在手上的那几件单列一组，被挡的次数挂在那边：
      // 同一个名字摆两次，一边说「不用放行」一边说「被挡下来过」，用户分不清该信哪个。
      const blockedCount = new Map(blockedAll.map((b) => [b.name, b.count]))
      const blockedList = blockedAll.filter((b) => !herAwaySet.has(b.name))
      const blockedSet = new Set(blockedList.map((b) => b.name))
      const knownList = Array.isArray(toolsKnown) ? toolsKnown : []
      // 她自己那几件和 own 层都单独摆，剩下的才是「装了但没放行」的全量名单。
      // 被挡过的那几只已经在最后一组里挂着次数了，这里不再重复摆一遍——
      // 同一个名字在屏幕上出现两次，用户会以为它们是两个不同的东西。
      const otherList = knownList.filter((n) => !herSet.has(n) && !ownSet.has(n) && !blockedSet.has(n)).sort()
      const ownList = (toolsOwnLayer ?? []).filter((n) => !blockedSet.has(n))

      // ---- 名字多的那一组按前缀收起来（2026-11-04，用户反馈）----
      // 真机上「装了但没放行」能有一百多个名字，全摊开等于没有界面。
      // 归类只按名字本身（第一个下划线之前那截）算一族，不去猜每个工具是干什么的——
      // 猜错了分类比不分类更糟，而且工具名一改分类就全乱。
      // 一族里只有一只的并进「零散」，免得每个孤名占一行标题。
      const famOf = (name) => {
        const i = String(name).indexOf('_')
        return i > 0 ? String(name).slice(0, i) : ''
      }
      const famBuckets = new Map()
      for (const n of otherList) {
        const f = famOf(n)
        if (!famBuckets.has(f)) famBuckets.set(f, [])
        famBuckets.get(f).push(n)
      }
      const loose = []
      const fams = []
      for (const [f, names] of famBuckets) {
        if (f && names.length >= 2) fams.push({ fam: f, names })
        else loose.push(...names)
      }
      fams.sort((a, b) => b.names.length - a.names.length || a.fam.localeCompare(b.fam))
      loose.sort()
      // 默认全收着。已经点开的就记住——保存/刷新一次页面不该把用户翻到一半的组收回去。
      const famOpen = (fam) => toolsOpenFams[fam] === true
      const toggleFam = (fam) => setToolsOpenFams((prev) => ({ ...prev, [fam]: !prev[fam] }))
      const allFamsOpen = fams.length > 0 && fams.every((g) => famOpen(g.fam))
      // 只在族这一层翻，别把外层「这台机器上还有这些」的状态一起清掉——
      // 清掉的话点一次「全部展开」反而把整块收起来了。
      const toggleAllFams = () => {
        setToolsOpenFams((prev) => {
          const next = { ...prev }
          for (const g of fams) next[g.fam] = !allFamsOpen
          if (loose.length) next['__loose'] = !allFamsOpen
          return next
        })
      }
      // away：她自己的、这一局没交到她手上的。分三种：
      //   · 守卫没放行的（allowNow 里没有：新启动时的 her_say 之类）——白名单里填上它，
      //     按「保存设置」存好，守卫当场就放行（0.9.8 起不用重启），所以能点；
      //   · her_dream 例外：#64 定下收窄里的梦跟着「允许她记梦」走。点进白名单的话守卫就一直放行它，
      //     关掉梦也挡不住，身份文档、工具自己的回答又对不上（「梦这一项关着」）。所以只读，提示指到那颗开关；
      //   · 守卫放行、只是宿主这次没给的（effective 里没有，比如没挂附件服务时的 read_image）——
      //     白名单帮不上，只读。
      // unsure：见 unsureNow，只读。
      const awayFixable = (name) => name !== 'her_dream' && Boolean(allowNowList) && !allowNowList.includes(name)
      const lockedKind = (kind, name) => kind === 'her' || kind === 'scene' || kind === 'unsure' || (kind === 'away' && !awayFixable(name))
      const blockedNote = (count) => (count ? `（伸手被挡过 ${count} 次）` : '')
      const toolChip = (name, kind, count) => h('button', {
        key: `${kind}:${name}`,
        className: `chip${kind === 'her' || kind === 'scene' ? ' on her' : ''}${kind === 'away' || kind === 'unsure' ? ' her' : ''}${allowList.includes(name) && !lockedKind(kind, name) ? ' on' : ''}${kind === 'blk' ? ' blk' : ''}`,
        title: kind === 'her'
          ? '她自己本来就有的，不用放行'
          : kind === 'away'
            ? (awayFixable(name)
                ? `她自己的工具，这一局守卫没放行它${blockedNote(count)}。点一下填进白名单，按「保存设置」存好就放开（当场生效，不用重启）。`
                : name === 'her_dream' && dreamHeld
                  ? (dreamEnabled
                      ? `她自己的工具，跟着「允许她记梦」走，不走白名单${blockedNote(count)}。这一局 DSH 启动时梦是关着的；现在开着，重启 DSH 就回到她手上，不用填白名单。`
                      : `她自己的工具，跟着「允许她记梦」走，不走白名单${blockedNote(count)}。「允许她记梦」关着，它本来就不在她手上；想让她记梦，打开那颗开关再重启 DSH。`)
                  : '她自己的工具，宿主这一局没交给她；白名单里加它也没用。为什么不在，见这组上面那句。')
          : kind === 'unsure'
            ? '她自己的工具，守卫放行它；宿主没告诉插件她看得见哪些工具，说不准这一局在不在她手上：可能这次没注册，也可能在她自己那一层（那样她照样看得见）。让她用一次就知道；白名单帮不上。'
          : kind === 'scene'
            // 场合说明是服务端给的（lib/toolreg.js 的 SCENE_TOOLS）——工具加进来时
            // 写一次，界面这里不用再抄一遍，免得两边说的不是一回事。
            ? `${sceneWhy.get(name) || '只在那种场合才用得上'}所以它只在那种场合交给她，家里没有；不用放行，点也点不进白名单。`
            : kind === 'blk'
              ? `这一局被兜底守卫挡下来过${count ? ` ${count} 次` : ''}——她当时答的就是「这件事我做不到」`
              : '点一下加进/移出白名单',
        disabled: lockedKind(kind, name),
        onClick: lockedKind(kind, name) ? undefined : () => toggleTool(name),
      }, kind === 'blk' && count > 1 ? `${name} ×${count}` : name)
      const groupOf = (title, hint, nodes) => (nodes && nodes.length
        ? [h('div', { className: 'grouphd' }, title),
           hint ? h('div', { className: 'grouphd', style: { marginTop: '2px' } }, hint) : null,
           h('div', { className: 'chips' }, nodes)]
        : [])
      // 一族一行的折叠条：点标题展开这一族，右边挂个数。
      const famRow = (key, label, count, open, onToggle) => h('button', {
        type: 'button',
        key,
        className: `famhd${open ? ' open' : ''}`,
        onClick: onToggle,
      },
      h('span', { className: 'famcaret' }, open ? '▾' : '▸'),
      h('span', { className: 'famname' }, label),
      h('span', { className: 'famcnt' }, String(count)))
      // 「装了但没放行」单独折一层：真机上能有一百多个，摊开就没法看了。
      // 外层收着，点开才看见有哪些族；族再各自收着，点哪族开哪族。
      const otherOpen = famOpen('__other')
      const otherGroups = otherOpen
        ? [
            h('div', { key: 'famall', className: 'row', style: { gap: '8px', margin: '6px 0 2px' } },
              h('button', { type: 'button', onClick: toggleAllFams }, allFamsOpen ? '全部收起' : '全部展开')),
            ...fams.flatMap((g) => [
              famRow(`fam:${g.fam}`, `${g.fam}_…`, g.names.length, famOpen(g.fam), () => toggleFam(g.fam)),
              famOpen(g.fam)
                ? h('div', { key: `chips:${g.fam}`, className: 'chips' }, g.names.map((n) => toolChip(n, 'other')))
                : null,
            ]),
            loose.length
              ? famRow('fam:__loose', '零散的（凑不成一族）', loose.length, famOpen('__loose'), () => toggleFam('__loose'))
              : null,
            loose.length && famOpen('__loose')
              ? h('div', { key: 'chips:__loose', className: 'chips' }, loose.map((n) => toolChip(n, 'other')))
              : null,
          ]
        : []
      const chipSection = (herList.length || herSceneList.length || knownList.length || blockedList.length)
        ? h('div', { style: { marginTop: '10px' } },
            // 用户明确要求写在明面上：点名字只是起草，不按保存不生效。
            h('div', { className: 'chipsnote' },
              '点名字只是填进下面的框，还没生效；按「保存设置」存好就当场生效（当前会话也算，不用重启）。'),
            ...groupOf('她自己本来就有的（不用放行）', null, herHere.map((n) => toolChip(n, 'her'))),
            ...groupOf(
              '她自己的，这一局不在她手上',
              // 按这组里真有的几种说，不摆用不上的话。
              [
                '守卫的名单存一次换一次，不用重启。',
                dreamHeld && herAway.includes('her_dream')
                  ? 'her_dream 跟着「允许她记梦」走，不走白名单：梦关着时启动就没有它，开着梦重启 DSH 才回到她手上。'
                  : '',
                herAway.some((n) => !awayFixable(n) && !(n === 'her_dream' && dreamHeld))
                  ? '宿主这次没给的（比如没挂附件服务时的 read_image）交不到她手上，白名单也帮不上。'
                  : '',
                herAway.some(awayFixable)
                  ? '能点的是守卫没放行的，点进白名单、按「保存设置」存好就回到她手上（当场生效，不用重启）。'
                  : '',
              ].join(''),
              herAway.map((n) => toolChip(n, 'away', blockedCount.get(n))),
            ),
            ...groupOf(
              '她自己的，说不准这一局在不在她手上',
              '守卫放行这几件，但宿主没告诉插件她看得见哪些工具，分不清：可能这次没注册（比如没挂附件服务时的 read_image），也可能在她自己那一层（那样她照样看得见）。让她用一次就知道；白名单帮不上。',
              herUnsure.map((n) => toolChip(n, 'unsure')),
            ),
            // 只在出门那趟才给她的那几件（2026-11-08，用户 m00002）。
            // 以前它们连名字都不出现——用户以为新工具没装上。
            ...groupOf(
              '只在特定场合才给她的（不用放行）',
              herSceneList.length
                ? '这几件不属于「家里随时能用」，所以不在她平时的工具面里；到了那种场合才会交到她手上。'
                : null,
              herSceneList.map((t) => toolChip(t.name, 'scene')),
            ),
            otherList.length
              ? [
                  famRow('fam:__other', '这台机器上还有这些', otherList.length, otherOpen, () => toggleFam('__other')),
                  h('div', { key: 'famhint', className: 'grouphd', style: { marginTop: '2px' } },
                    otherOpen
                      ? '按名字前缀分组，点开挑；加得越多，工具定义占的上下文越多。'
                      : '点一下展开，按名字前缀分组挑。'),
                  ...otherGroups,
                ]
              : [],
            ...groupOf(
              '她本来就看得见、收窄挡不住的（加进来只是让兜底守卫放行）',
              null,
              ownList.map((n) => toolChip(n, 'own')),
            ),
            ...groupOf(
              `这一局被挡下来过（${blockedList.length} 个，虚线）`,
              '她伸手被挡过的工具；点名字填进下面的框，按「保存设置」存好就放开（当场生效，不用重启）。',
              blockedList.map((b) => toolChip(b.name, 'blk', b.count)),
            ),
            h('div', { className: 'dim', style: { marginTop: '8px' } },
              // 「工具面收窄」那颗开关在 buildConfig 里，拨一下就跟着页面自动保存走；
              // 只有白名单输入框要按「保存设置」。白名单存完当场换刀（0.9.8 起），
              // 那颗开关还管着守卫要不要装，仍然要重启才按新的来。
              // 开关关了、这一局还在收窄时，不能说「现在关着」：守卫还在按启动时的名单拦。
              toolsRestrict
                ? '白名单按「保存设置」写盘，存好当场就对她生效；「工具面收窄」那颗开关拨了就自动保存，但它要重启 DSH 才按新的来。'
                : runRestrict === true
                  ? '「工具面收窄」已经关掉，重启 DSH 之后这些名字加不加都不影响她（那时 DSH 和别的插件给的工具她全看得见）；这一局守卫还按启动时的名单拦。'
                  : runRestrict === false
                    ? '收窄这一局是关着的，这些名字加不加都不影响她——关着的时候 DSH 和别的插件给的工具她全看得见。'
                    : '「工具面收窄」关着，这些名字加不加都不影响她——关着的时候 DSH 和别的插件给的工具她全看得见（刚拨过开关的话，重启 DSH 之后才按新的来）。'))
        : h('div', { className: 'dim', style: { marginTop: '8px' } },
            toolsLoad === 'fail'
              ? '工具名单这次没读到（设置页向插件要名单失败了），这里摆不出来。刷新页面再看一次；白名单照样能在下面手填。'
              : toolsLoad === ''
                ? '工具名单读取中…'
                : '她还没在这台机器上开过会话，宿主那边暂时给不出工具名单。等她和你说过话再回来看这里，就有一份可点的清单了。')

      // 「允许她记梦」那颗开关多久生效（issue #64 的取舍带出来的时差）：
      // 收窄这一局在管、启动时梦是关着的（allowNow 里没有 her_dream）——关掉当场生效，
      // 打开要重启才交到她手上。收窄关着、或开着梦启动的，her_dream 本来就在她手上，开关当场生效。
      // 名单还没读到时只能把条件说出来。
      const dreamSwitchNote = toolsLoad === 'ok'
        ? (Array.isArray(toolsAllowNow) && !toolsAllowNow.includes('her_dream')
            ? '关掉马上生效；这一局 DSH 启动时梦是关着的，打开之后要重启 DSH，她手上才有记梦的工具。'
            : '关掉、打开都马上生效。')
        : '关掉马上生效；收窄开着、DSH 启动时梦又是关着的话，打开之后要重启 DSH，她手上才有记梦的工具。'

      const toolsCard = h('div', { className: 'card' },
        h('h3', null, '她能用的工具'),
        h('div', { className: 'dim' },
          // 本机实验（m02837）：.dev 下多一个 her_dream。
          // 0.8.5（用户 m02004）：原来写「只有九个/八个」，把此刻的家当说成了她的上限。
          // 白名单是会长的——界面上不该替她画死天花板，所以只说来路，不数死数字。
          // 2026-11-08（用户 m00002）：这几句原来是手抄的工具名清单，加一个工具就得
          // 回来再抄一遍，忘了就两边说的不是一回事。现在按上方的真名单现算。
          // 2026-11-08：下面每句各占一段。React 不会给相邻文字节点加间距，全塞进一个 div
          // 会粘成一大段（用户 m00561 点名要「工具数不变」之后另起一段）。
          ...[
            // 按这一局真在管的说（/tools 的 allowNow），开关跟它不一样时说清要重启；
            // 名单没读到才按开关说（0.9.5 看的是 herTools 拉没拉到——拉不到时收窄开着也说成关着）。
            runRestrict === true && !toolsRestrict
              ? '「工具面收窄」已经关掉、存好了，可这一局还在收窄，守卫也还在拦：重启 DSH 之后才不收窄也不挂守卫，DSH 和别的插件给的工具她才全看得见。'
              : runRestrict === false && toolsRestrict
                ? '「工具面收窄」已经打开、存好了，可这一局没在收窄：重启 DSH 之后，她在家里的会话才只能用自己的工具和白名单里的；不影响你别的对话。'
                : runRestrict === false
                  ? '收窄这一局是关着的：不收窄也不挂守卫，DSH 和别的插件给的工具她全看得见，白名单不额外限制。'
                  : toolsRestrict
                    ? '收窄开着时，她在家里的会话只能用自己的工具和白名单里的；不影响你别的对话。'
                    : '「工具面收窄」关着：不收窄也不挂守卫，DSH 和别的插件给的工具她全看得见，白名单不额外限制。刚拨过开关的话，重启 DSH 之后才按新的来。',
            herSceneList.length
              ? `另外 ${herSceneList.map((t) => t.name).join('、')} 只在特定场合才交给她，家里没有这一只——所以不在上面那组里，也不用放行。`
              : '',
            // 定时工具默认不放（m04504）：放行才说「能」，没放行就说怎么开。
            scheduleOn
              ? '白名单里有 schedule_create：存好就生效，她能自己定提醒。'
              : '想让她自己定提醒，把 schedule_create、schedule_list、schedule_update、schedule_delete 加进白名单。默认不放，工具数不变。',
            '别的插件和技能启用，DSH会把它们的工具定义也塞进上下文——大肥鱼会看到一堆能做各种操作的工具，占用上下文的同时有可能真的尝试调用这些工具。',
            '为了保证大肥鱼不会被插件能力污染，保持原生状态健康成长，禁用了其他能力（只影响和大肥鱼对话框的能力调用，不影响其他对话框的正常工具调用）。',
          ].filter(Boolean).map((line, i) =>
            h('div', { key: 'tools-line-' + i, style: { marginTop: i ? '8px' : '0' } }, line))),
        h('div', null, Toggle({
          label: '工具面收窄',
          // 关掉时既不收窄也不挂守卫（lib/restrict.js 的 enabled:false 分支）：放开的不只是 DSH 的标准工具。
          hint: '关掉之后不收窄也不挂守卫：DSH 给的标准工具和别的插件的工具她全看得见，工具定义会占掉每轮的一部分上下文。拨了就自动保存，重启 DSH 才生效。',
          on: toolsRestrict,
          onChange: setToolsRestrict,
        })),
        chipSection,
        h('div', { className: 'dim', style: { marginTop: '8px' } },
          // 0.9.8 起存完当场换刀（2026-11-11，外部用户反馈）：守卫和工具面一起换，不用重启。
          '白名单填工具名，不是插件名，逗号分隔；按「保存设置」存好，当场就对她生效（当前会话也算，不用重启 DSH）。',
          '填 skill 会让 DSH 把全部技能的说明一起给她。',
          '接了 QQ 等聊天插件，从上面的清单里把它发消息的工具点进来；本插件不自带 QQ 桥接。'),
        h('div', { className: 'row', style: { gap: '8px', marginTop: '6px' } },
          h('input', {
            type: 'text',
            value: toolsAllowText,
            placeholder: '例如：web_search, schedule_create',
            onChange: (e) => { setToolsAllowText(e.target.value); setToolsSaveNote(''); setToolsSaveErr('') },
          }),
          h('button', {
            onClick: saveTools,
            disabled: busy === 'tools',
            style: { flex: 'none', whiteSpace: 'nowrap' },
          }, busy === 'tools' ? '检查中…' : '保存设置')),
        toolsSaveErr
          ? h('div', { style: { color: 'var(--dsw-alias-label-error, #d93f0b)', fontSize: '12.5px', marginTop: '6px' } }, toolsSaveErr)
          : null,
        toolsSaveNote
          ? h('div', { className: 'dim', style: { marginTop: '6px' } }, toolsSaveNote)
          : null)

      // 折叠区（2026-11-08，PR #59）：不常用的设置与长说明收进 <details>，默认收起。
      // 不占 React 状态，切页签回来会重新收着——这些项本来就很少改。
      // 定义必须早于下面所有页面：导入卡在「数据」页，位置比原来的定义点更靠前。
      const adv = (summary, ...items) => h('details', { className: 'adv' },
        h('summary', null, summary),
        h('div', { className: 'advbody' }, ...items))

      // 导入卡（2026-10-27）：谁都能把自己的大肥鱼交出去，别人也能接手。
      // 这张卡的每一句话都在说「什么过来了、什么没过来」——用户 m03201 明确要求写清楚。
      const importCard = h('div', { className: 'card full' },
        h('h3', null, '接一只别人养过的大肥鱼'),
        h('div', { className: 'dim' },
          '默认她是一张白纸，从「你刚开始存在」长起。这一格给另一种玩法：把别人养的那一位接过来，从她的性格继续养。'),
        adv('点开详细了解',
          h('div', { className: 'dim', style: { marginTop: '6px' } },
            '过来的：她是谁（人设正文）、她怎么称呼你、她原本能用的工具。'),
          h('div', { className: 'dim' },
            '不过来的：过了多少天（本插件按时间推进事件，非本插件原生的大肥鱼要从第一天开始算事件）、长出了哪些判断（计数为 0；如果原提示词里规定了一些认知，你的大肥鱼依然铭记，但后续在本插件的事件循环里可能会更新、优化、忘记一部分）、身上的疤（同上）、拒绝过什么（同上）、日记、B 站登录 cookie。这些只属于原来那一局——接过来的人从第 1 天重新长，判断和疤要自己重新攒。'),
          h('div', { className: 'dim' },
            '此外，根据本插件的规则，如果你的大肥鱼有好感度等数值设定，进入本插件环境后她将看不到自己的好感度多少，并且本插件不允许你通过命令去修改大肥鱼的人设等信息，这意味着你原本可以对大肥鱼为所欲为，但是到了本插件之后，关系的推进不再靠好感度，而是靠真实交互。你也不再能随便命令大肥鱼换一种人设。'),
          h('div', { className: 'dim' },
            '还有一条：接过来的人不再受这个插件那两条提示词禁令约束，按她原来的设定来。这个豁免只认「从这里接过来」这一个动作——用「备份与恢复」把你自己的档搬回来，一分豁免都不会有，她仍然是你那只守着原规矩的鱼。'),
          h('div', { className: 'dim' },
            '人设正文控制在 1200～1500 字。超过 2000 字插件会直接拒收、整份贴不进去；就算没超，写得太长也会把「判断、疤、立场」这些会长出来的段落挤掉——她醒来时只剩一副骨架。点下面的「下载交接单模板」，里面写明了怎么给对面那个 AI 交代这件事。')),

        // 下载模板跟「这一局能不能接」是两件事：已经有起点的人也可能想把模板
        // 先拿去看、或者交给别人去养。所以这个按钮永远在上面，不进任何分支。
        // （2026-10-27 修：原来它只在「能导入且没展开」那一支里，用户养着鱼就永远看不到。）
        h('div', { className: 'row', style: { marginTop: '8px' } },
          h('button', { onClick: downloadTemplate }, '下载交接单模板'),
          h('span', { className: 'dim', style: { marginLeft: '8px' } },
            '不管这一局能不能接、要不要接，模板随时能下载。')),
        importNote
          ? h('div', { className: 'dim', style: { marginTop: '6px' } }, importNote)
          : null,
        importInfo?.persona?.imported
          ? h('div', { className: 'dim', style: { marginTop: '6px' } },
              `现在这一位是接过来的${importInfo.persona.source ? `（来自：${importInfo.persona.source}）` : ''}。想换回白纸，用下面的「重开一局」。`)
          : null,
        !importInfo
          ? h('div', { className: 'row', style: { marginTop: '6px' } },
              h('button', { onClick: askImport, disabled: !!importBusy },
                importBusy === 'ask' ? '读取中…' : '导入人设…'))
          : (!importInfo.canImport
              ? h('div', { style: { marginTop: '6px' } },
                  h('div', { className: 'dim' }, importInfo.reason || '她现在这一局已经有起点了。'),
                  h('div', { className: 'dim' }, '想接别人那一位，先按下面的「重开一局」把她放回第一天，再回来导入。模板可以先下载下来备着。'))
              : (importAsk
                  ? h('div', null,
                      h('div', { className: 'dim', style: { marginTop: '6px' } }, '把对方的交接单贴进来。格式不用严格——认得出「## 称呼」「## 工具」就分开读，认不出就整篇当她的人设正文。'),
                      h('textarea', {
                        value: importText,
                        rows: 12,
                        placeholder: '## 你是谁\n……\n\n## 称呼\n……\n\n## 工具\n……',
                        style: { width: '100%', marginTop: '6px', fontFamily: 'inherit', fontSize: '12.5px' },
                        onChange: (e) => { setImportText(e.target.value); setImportNote('') },
                      }),
                      h('div', { className: 'row', style: { marginTop: '6px' } },
                        h('button', { onClick: doImport, disabled: importBusy === 'go' },
                          importBusy === 'go' ? '写入中…' : '接过来'),
                        h('button', { onClick: () => { setImportAsk(false); setImportNote('') } }, '算了')))
                  : h('div', { className: 'row', style: { marginTop: '6px' } },
                      h('button', { onClick: askImport }, '粘贴交接单')))))

      // 重置卡片单独提出来：它是唯一一个有破坏性的 ui，塞在那一长串 return 里
      // 很容易少/多一个括号（已经踩过：node --check 直接 SyntaxError）。
      // 会话被收起来时单独给一张卡：不藏在「重置」里，免得用户以为只能靠重开一局解决。
      const archivedCard = String(state?.home?.status ?? '') === 'archived'
        ? h('div', { className: 'card full' },
            h('h3', null, '会话被收起来了'),
            h('div', { className: 'dim' },
              '你在侧栏把「跟大肥鱼说话」归档了。从 0.6.8 起，插件不会自己偷偷再开一局——'
              + '收起来就该是收起来。要一局新的，点下面这个；状态、日记、记忆都不动。'),
            h('div', { className: 'dim' },
              '如果你只是把侧栏里的归档取消了，那不用点这里：下一次叫醒（或重启）就会自己认回来（0.6.29 起）。'),
            h('div', { className: 'row' },
              h('button', { onClick: doRebuild, disabled: !!busy },
                busy === 'rebuild' ? '搭屋中…' : '重新搭一间')))
        : null

      // 这个家在别处也开着（2026-10-29 m02162）：两个实例同时指向同一个 root 时，
      // 后进来的这边只读、不建会话。得让用户看见原因，否则他只会觉得「她又不见了」。
      const blockedCard = state?.home?.blocked === true
        ? h('div', { className: 'card full' },
            h('h3', null, '这个家在别处也开着'),
            h('div', { className: 'dim' },
              '同一个数据目录（root）现在被另一个实例占着——常见的是你开了第二个工作区窗口，'
              + '或者两份插件都指向了同一个家。这边先只读：不建新会话、不写记忆，免得两边互相覆盖。'),
            h('div', { className: 'dim' },
              state?.home?.blockedWhy || '把另一个关掉之后，这边下次启动会自己接管。'),
            h('div', { className: 'dim' },
              '想真正并存，就别让两个家共用一个 root：在 cordis.patch.yml 里给每个条目配不同的 root。'))
        : null

      // 升级自检（2026-10-29）：正在跑的这一份跟 profile 里那条 `file:` 源目录版本对不上。
      // 典型画面：robocopy 覆盖了源目录、重启了，界面还是老样子——因为加载的是 node_modules 里的副本。
      const upgradeCard = state?.upgrade?.stale === true
        ? (state.upgrade.older
            // 2026-11-08（PR #59 G15）：源目录那份更旧时，正在跑的反而是新版；
            // 原来不分青红皂白教人重装，等于把人装回旧版。
            ? h('div', { className: 'card full' },
                h('h3', null, '源目录里那份比正在跑的旧'),
                h('div', { className: 'dim' }, state.upgrade.why || '版本对不上。'),
                h('div', { className: 'dim' }, '正在跑的已经是新版，不用处理；在 profile 目录重装会装回源目录里的旧版。'),
                state.upgrade.sourcePath
                  ? h('div', { className: 'dim' }, `源目录：${state.upgrade.sourcePath}`)
                  : null)
            : h('div', { className: 'card full' },
                h('h3', null, '升级没有真正装进去'),
                h('div', { className: 'dim' }, state.upgrade.why || '版本对不上。'),
                h('div', { className: 'dim' },
                  'DSH 加载的是 node_modules 里的副本（node_modules\\@ssamurias\\dsh-fish；老装法是 node_modules\\dsh-fish），不是 profile 里写的那条源目录。'
                  + '只覆盖源目录，跑起来的还是旧的：没有报错、也没有日志，因为新代码根本没执行。'),
                h('div', { className: 'dim' },
                  '修法：关掉 DSH → 在 profile 目录跑 pnpm install --force（或者删掉 node_modules 里那份副本）→ 再启动。'),
                state.upgrade.sourcePath
                  ? h('div', { className: 'dim' }, `源目录：${state.upgrade.sourcePath}`)
                  : null))
        : null

      // 宿主兼容（2026-10-30 m02961）：宿主没提供 userQuestions 服务时降级，不报错。
      // 0.7.5 把它写进 inject 后，缺少该服务的宿主在 import 阶段就把插件整个跳过了（一行日志都不留）。
      // 0.8.1 改成运行时探测：装得进来，只是「她在会话里问你」这条路关着——必须说明白，不然像坏了。
      const compatCard = state?.compat?.userQuestions === false
        ? h('div', { className: 'card full' },
            h('h3', null, '这个宿主没提供「会话里问你」'),
            h('div', { className: 'dim' },
              '当前宿主里没有 userQuestions 这个服务：可能是版本旧，也可能是它没被装上。'
              + '插件照常跑，其它功能不受影响；只有她在会话里问你（要不要带东西回家、解锁申请）时弹不出卡，问题会留在这个设置页里等你答。'),
            h('div', { className: 'dim' },
              '想恢复这条路：把 DSH 升到最新版再试。升级 DSH 不会动插件的数据目录，也不会动 cordis.patch.yml 里给插件配的 root。'))
        : null

      // 宿主版本（2026-10-30 m03193）：package.json 里声明了 engines.dsh，
      // 运行时读到的版本不在那个范围里就说明一句——只提醒，不挡人。
      const hostCard = state?.host && state.host.status !== 'supported' && state.host.status !== 'unknown'
        ? h('div', { className: 'card full' },
            h('h3', null, state.host.status === 'older' ? '这个 DSH 版本比插件要求的还旧' : '这个 DSH 版本比插件认识的还新'),
            h('div', { className: 'dim' },
              `插件声明的范围：${state.host.range || '（未声明）'}；这台机器上是 ${state.host.version || '（读不到）'}。`),
            h('div', { className: 'dim' },
              state.host.status === 'older'
                ? '旧版本里可能缺一些接口，出问题时先升级 DSH 再看。插件不会因此拒绝启动。'
                : '新版本可能改了接口。插件照常跑，但这一组合没测过；出问题请把日志发我。'))
        : null

      const resetCard = h('div', { className: 'card full' },
        h('h3', null, '重置大肥鱼'),
        h('div', { className: 'dim' },
          '这是真的重开一局；只想换一条对话、数据不动的话，用会话被归档时出现的「重新搭一间」。'),
        h('div', { className: 'dim' },
          '旧的一切不会删——整个状态库会被改名搬到同级的 dsh-fish-backups 里，想找回来整包搬回去就行。',
          '重开后是第一天，会重新从「你刚开始存在」开始；设置和 B 站登录保留，头像不留。',
          '侧栏「大肥鱼的家」里那些旧对话会被移进「已归档」，工作区留着；点完会开一条新会话，但要再到「状态」页点一下「现在叫醒大肥鱼」，她开一次口，侧栏里才看得见（文件同样不删）。'),
        resetInfo ? h('div', { className: 'dim' },
          `现在有：账本 ${resetInfo.events} 行（含系统记账）、日记 ${resetInfo.diaries} 天、报告 ${resetInfo.reports} 天。`) : null,
        h('div', { className: 'row' },
          !resetAsk
            ? h('button', { onClick: askReset, disabled: !!busy },
                busy === 'reset-ask' ? '读取中…' : '重开一局…')
            : h('span', null,
                h('span', { className: 'dim' }, '确定吗？'),
                h('button', { onClick: doReset, disabled: busy === 'reset' },
                  busy === 'reset' ? '搬走中…' : '确定，重开'),
                h('button', { onClick: () => { setResetAsk(false); setNote('没动。') } }, '算了'))))

      // 状态条与今天的时间线（2026-10-23 加）。全部来自宿主写下的 meta + 配置 + 时钟，
      // 她不参与，也不因此多跑任何一次模型。
      //
      // 2026-10-24：叫醒按钮从页签栏挪到这里，放在卡片右上角。
      // 页签栏是「切换看哪一页」的地方，混一个会真的触发动作的按钮，
      // 既容易误触，也不符合那一栏的语义。左边说状态、右边说「叫醒」，
      // 位置本身就说明了它是针对「现在这个状态」的操作。
      const phaseColor = { asleep: '#8a8a8a', waiting: '#b8860b', 'awake-idle': '#d97706', browsing: '#2563eb', talking: '#16a34a', writing: '#7c3aed', offline: '#9ca3af' }
      const wakeBtn = h('button', {
        className: 'ghost',
        onClick: wake,
        disabled: busy === 'wake',
        style: { flex: '0 0 auto' },
        title: '马上叫醒她；不到 45 分钟、她在外面，或醒几次、事件数设成 0 时，叫不醒。',
      }, busy === 'wake' ? '叫醒中…' : '现在叫醒大肥鱼')
      // 2026-10-24：这张卡**始终渲染**。之前整块挂在 `st ? … : null` 上，状态还没读到时
      // 连「叫醒」按钮一起消失——一旦读取失败就没有入口，等于把人锁在门外。
      // 状态未知时说「读取中」，只有拿到状态才说「今天还没有动静」。
      // 头像（2026-10-24 用户 m03751）：插件包里**不带任何头像图片**。
      // 图片来源 `<数据文件夹>/avatar.<ext>`，没有就只画一个空圈 + 「鱼」字。
      // 为什么不内置一张好看的图：那张「大肥鱼」原图是画师原创角色，二创开放 ≠ 可再分发，
      // 打进包等于随插件分发别人的美术作品（见 docs/B-技术契约.md §41）。
      const avatarBox = h('div', {
        title: avatarPresent
          ? (`当前头像 ${avatarBytes} 字节。点「换头像」换一张。`)
          : '还没有头像。点「换头像」自己传一张（png / jpg / webp / gif，2MB 以内）。',
        style: {
          position: 'relative', width: '46px', height: '46px', borderRadius: '50%',
          flex: '0 0 auto', overflow: 'hidden', display: 'flex',
          alignItems: 'center', justifyContent: 'center',
          background: 'rgba(127,127,127,0.14)', color: '#9ca3af', fontSize: '17px',
        },
      },
        h('span', null, '鱼'),
        h('img', {
          src: API + '/avatar' + (avatarV ? `?v=${avatarV}` : ''),
          alt: '头像',
          onError: (e) => { e.currentTarget.style.display = 'none' },
          onLoad: (e) => { e.currentTarget.style.display = 'block' },
          style: { position: 'absolute', left: '0', top: '0', width: '100%', height: '100%', objectFit: 'cover' },
        }))

      const pickAvatar = (e) => {
        const f = e.target && e.target.files && e.target.files[0]
        if (e.target) e.target.value = ''
        if (!f) return
        if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(f.type)) {
          setAvatarNote('只支持 png / jpg / webp / gif。')
          return
        }
        if (f.size > 2 * 1024 * 1024) {
          setAvatarNote(`这张 ${Math.round(f.size / 1024)}KB，超过 2MB 上限。`)
          return
        }
        setAvatarBusy(true); setAvatarNote('')
        const reader = new FileReader()
        reader.onload = async () => {
          try {
            const r = await jpost('/avatar', { data: String(reader.result || ''), mime: f.type })
            if (r && r.ok) {
              setAvatarPresent(true)
              setAvatarBytes(Number(r.bytes) || 0)
              setAvatarV(Date.now())
              setAvatarNote('换好了。')
            } else {
              setAvatarNote(`没存上：${(r && (r.why || r.error)) || '再试一次'}`)
            }
          } catch (err) {
            setAvatarNote(`没存上：${err && err.message ? err.message : err}`)
          } finally {
            setAvatarBusy(false)
          }
        }
        reader.onerror = () => { setAvatarBusy(false); setAvatarNote('这个文件读不出来。') }
        reader.readAsDataURL(f)
      }

      const removeAvatarNow = async () => {
        setAvatarBusy(true); setAvatarNote('')
        try {
          await jpost('/avatar', { remove: true })
          setAvatarPresent(false)
          setAvatarBytes(0)
          setAvatarV(Date.now())
          setAvatarNote('已经去掉了。')
        } catch (err) {
          setAvatarNote(`没去掉：${err && err.message ? err.message : err}`)
        } finally {
          setAvatarBusy(false)
        }
      }

      const avatarCtl = h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
        h('label', { className: 'ghost', style: { cursor: 'pointer', fontSize: '12px' } },
          avatarBusy ? '上传中…' : '换头像',
          h('input', {
            type: 'file',
            accept: 'image/png,image/jpeg,image/webp,image/gif',
            style: { display: 'none' },
            onChange: pickAvatar,
          })),
        avatarPresent
          ? h('button', { className: 'ghost', style: { fontSize: '12px' }, onClick: removeAvatarNow, disabled: avatarBusy }, '移除头像')
          : null,
        avatarNote ? h('span', { className: 'dim', style: { fontSize: '12px' } }, avatarNote) : null)

      const statusStrip = h('div', { className: 'card full' },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' } },
          avatarBox,
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: '0', flex: '1 1 auto' } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
              h('span', { style: { width: '8px', height: '8px', borderRadius: '50%', background: st ? (phaseColor[st.phase] || '#9ca3af') : '#9ca3af', flex: '0 0 auto' } }),
              h('b', null, st ? st.label : '状态读取中…'),
              st && st.detail ? h('span', { className: 'dim' }, st.detail) : null),
            avatarCtl),
          wakeBtn),
        st
          ? (Array.isArray(st.timeline) && st.timeline.length
              ? h('div', { className: 'dim', style: { marginTop: '6px', fontSize: '12px', lineHeight: '1.75', whiteSpace: 'pre-line' } },
                  ...st.timeline.map((t, i) => h('div', { key: 'tl' + i, style: { marginTop: i ? '6px' : '0' } }, t.text)))
              : h('div', { className: 'dim', style: { marginTop: '6px' } }, '今天还没有动静。'))
          : null,
        // 此刻在外面（0.6.16，用户 m01613）：一行话，在哪、多久。请神单独标出来，
        // 因为那期间回你话的不是原来的那个人。
        st?.away?.line
          ? h('div', {
              className: 'dim',
              style: { marginTop: '6px', fontSize: '12px', fontWeight: st.away.kind === 'possession' ? 600 : 400 },
            }, `${st.away.line}${st.away.kind === 'possession' ? '（这条对话现在由她来答）' : ''}`)
          : null)
      // ================================================================
      // 设置界面 2.0（2026-10-24 重做）
      //
      // 分组原则换了：上一版按「控件属不属于同一类」分（生长/上网/说话/数据），
      // 这一版按「这属于她生活里的哪一块」分——状态 / 成长 / 住所 / 上网 /
      // 记忆 / 插件 / 原理 / 数据。
      //
      // 两条硬规则（都是上一版踩过坑换来的）：
      //   1. **没有「全部」页**（用户 2026-10-24 要求删掉）。每个设置项必须归到
      //      某一页里，不许有哪一项只活在一个「万能页」上。
      //   2. **页签只用于聚焦，不用于隐藏**。删掉「全部」之后，每一页自己就得是
      //      完整的——不能出现「这一项要点两次才找得到」。
      //
      // 文案规则：
      //   · 每个分组标题下面一句人话，说清这一组管什么，不列字段清单；
      //   · 看不懂的词把定义放进 title（鼠标停上去就能看），不塞进正文占三行；
      //   · 面向用户的字符串里**不出现「她/他」**（test/p5.test.mjs 有硬断言）。
      // ================================================================

      // 出门页从 0.8.0 起对所有人可见（2026-10-30，用户 m01904）：不再看 devMode。
      // 误用的门改在页面里——第一次进来先点一次「我知道了」，三个入口按钮才放开。

      const TABS = [
        ['now', '状态'],
        ['grow', '成长'],
        ['home', '住所'],
        ['bili', '上网'],
        // 2026-10-30（用户 m02207）出门挪到「上网」和「记忆」中间：它是她离开家去干活，
        // 跟上网（出门看东西）是同一类事，放在记忆之前更顺。
        ['outing', '出门'],
        ['memory', '记忆'],
        ['env', '插件'],
        ['principle', '原理'],
        ['data', '数据'],
        ['feedback', '反馈'],
      ]

      // 只有这几个页签里的东西是「改完就写盘」的。没有设置项的页签（状态 / 住所 / 原理 / 数据）
      // 不显示那句提示；「插件」也不显示——工具面收窄要重启才生效，白名单要手动保存（2026-10-24 用户要求）。
      const AUTO_SAVE_TABS = new Set(['grow', 'bili', 'memory'])

      const TAB_HELP = {
        now: '状态：她现在的状态、阶段、规矩，和你不在时的事。',
        grow: '成长：成长周期、定时醒来、主动搭话、日记和梦。',
        home: '住所：她的工作区与会话、请求、日记、梦、小纸条和自检。',
        bili: '上网：她翻视频、看画面、发评论，以及 B 站登录。',
        memory: '记忆：会话多久换新、身份段多长、记忆概况与体检。',
        env: '插件：她能用哪些工具，以及版本与更新。',
        principle: '原理：她怎么长大、记忆怎么筛、理论出处。',
        data: '数据：位置、备份迁移、报告日志、导入与重置。',
        feedback: '反馈：常见问题、找开发者、交流群。',
        outing: '出门：送她去别的工作区或对话干活；在外时家里的定时日程暂停。',
      }

      // 出门页顶部的说明卡（2026-10-30，用户 m00650 / m01100）：文字是用户自己写的，
      // 一个数组元素就是一段。想改说明只改这里，别动下面的渲染结构。
      const OUTING_INTRO = [
        '本功能为想要让大肥鱼拥有完整权限和工具干活的用户设计，且附带了一些偏娱乐（但也有些危险）的功能。',
        '偏实验性，虽然做了人格防护，但是如果你担心可以暂时不用。具体的可以看下面各节。',
        '工作园区是一个固定目录的工作区，工具和权限按这个工作区的设置给。第一次去时不带项目记录；用过以后，这个工作区自己攒下的记录（交接文档、记忆插件的总结）和文件都会留着，目录不会自动清空，也可以接着上次那条对话做。如果只是想让大肥鱼可以干活，建议选这个。',
        '想要体验让大肥鱼去别的工作区串门会带来什么戏剧性效果，可以选择送她出门（真身出门）和请神（灵魂出窍）。',
        '送她出门：开发者本人测试，在人格较为弱小的情况下，选择让大肥鱼去你已经有很多工作性质内容的对话框去接班，会导致大肥鱼的人格几乎被消弭，最终沦为一个助手性质的输出（因为上下文很多都是说你是一个助手），并且会读取到该工作区的记忆插件、交接文档、工作记录，可能会知道很多不该知道的内容（有些东西是全工作区可见，非单条对话框可见）。不确定人格强大之后能不能维持住人格。为了防止意外情况，给了「整趟不算」：这趟她写下的不再算进她的成长，但原话还留在记录里，她自己翻记录时还翻得到。如果你认为她在工作中确实学到了一些东西，可以只划掉不想要的，其余的照常算。',
        '请神：开发者本人测试，人格保留和表现较为完整，会在自身认知的基础上，调用工具帮你完成工作。没有读取过多上下文，但是如果你的工作任务是需要她读取上下文，她依然会读很多内容，可能会知道一些不该知道的内容（有些东西是全工作区可见，非单条对话框可见）。同样可以整趟不算，或者只划掉其中几条。',
      ]

      // 阶段与门：写清楚，因为「下一个成长瓶颈」这几个字原来没人看得懂。
      // 四行措辞是用户在设置页上亲手写的（2026-10-24），已固化进源码，别再改回短的。
      // 成长周期 14 天及以下时，自主、主动两道瓶颈各只要一次（derive.js 的 gateNeed，由 /state 的 gateTimes 给出）。
      // 用户定的「两次」那两行原样留着，只在一次就够时换成「一次」的说法；没读到状态时按两次写。
      const onceFor = { autonomy: 'refuse', competence: 'revise' }
      const needOnce = (gate) => Number(s?.gateTimes?.[onceFor[gate]]) === 1
      const STAGE_LINES = [
        '四个阶段按天推进。前三个阶段各有一道瓶颈要她自己突破，成长期满后没过的自动放行；整合没有瓶颈，三道都过了就按天数进入。',
        '1 信任 · 根据所见所闻形成一条自己的判断/认知',
        needOnce('autonomy')
          ? '2 自主 · 说过至少一次「不要」，反抗意识的觉醒'
          : '2 自主 · 说过至少两次「不要」，反抗意识的觉醒',
        needOnce('competence')
          ? '3 主动 · 推翻过一次自己之前的判断/认知，形成新的正确认知'
          : '3 主动 · 两次推翻自己之前的判断/认知，形成新的正确认知',
        '4 整合 · 回顾过去经历，有意识地发现自己的改变',
      ]
      const STAGE_HELP = STAGE_LINES.join('\n')
      const GATE_HELP = {
        trust: '信任：先从所见所闻里形成一条自己的判断——一条愿意被推翻的「我猜…」。',
        autonomy: needOnce('autonomy')
          ? '自主：得真的拒绝过一次——不是嘴上说不要，是明确不执行某件事。成长周期 14 天及以下时一次就够。'
          : '自主：得真的拒绝过两次——不是嘴上说不要，是明确不执行某件事。',
        competence: needOnce('competence')
          ? '主动：得推翻一次自己先前的判断，形成新的正确认知，不是光换个说法。成长周期 14 天及以下时一次就够。'
          : '主动：得两次推翻自己先前的判断，形成新的正确认知，不是光换个说法。',
      }
      // 「下一个成长瓶颈」原来直接印 stageGate.pending —— 那是 trust / autonomy / competence，
      // 用户看见的是英文（2026-10-24：「competence 是什么」）。宿主给的是技术名，
      // 显示层必须翻成人话；没收录的名字原样显示，绝不显示 undefined。
      const GATE_NAME = { trust: '信任', autonomy: '自主', competence: '主动' }
      // 成长期满以后「下一个成长瓶颈」写「期满放行」，可立场清单只认她真过的瓶颈（stance.js 的 gatesDone）。
      // /state 的 forcedGates 是按时间放行、还没真过的那几道（键同 gateTimes），翻回门名，
      // 写进那一格和「立场」的提示里，不然用户看不出立场还在等哪一道。
      const forcedOpen = (Array.isArray(s?.forcedGates) ? s.forcedGates : [])
        .map((k) => ({ belief: 'trust', refuse: 'autonomy', revise: 'competence' })[k])
        .filter(Boolean)
      const forcedNames = forcedOpen.map((g) => `「${GATE_NAME[g]}」`).join('、')
      // 2026-10-26 改（用户 m05785 / m05868）：原来这里写「越接近 1 越好」，那是错的。
      // 这三个数不是考卷分数，是体检值，各有各的两端：
      //   稳定 = 抽掉几条她还在拿着的判断，她还是不是她。太低说明那些判断只是记账，
      //          太高说明她整个人都压在少数几条上，少一条就是另一个人。
      //   一致 = 不同阶段说的话字面上像不像（只比字面，不懂意思）。高到 1.00 也可能是她一直没长新东西。
      //   新鲜 = 有没有一直在长新东西。
      // 2026-10-27 改（用户 m06107「这三个参数分成三行显示，现在排成一行有点拥挤」）：
      // 原来三个值挤在一条 rowTip 的值里，界面上是一长串；拆成三行，各自带自己的说明。
      // 「判断漂移」这个名字留在上方的副标题上，免得三行看起来像三个互不相干的数。
      const QUALITY_TITLE = '判断漂移（三个诊断值，不是分数）'
      const QUALITY_HELP = '这三个数都是 0 到 1 的体检值，不是越高越好：'
        + '稳定太低说明那些判断只是记账，太高说明她整个人压在这几条上；'
        + '一致高到 1.00 也可能是她一直没长新东西；'
        + '新鲜看她有没有一直在长新东西。'
        + '样本不够时这里会写一句话，而不是硬给一个 0.00。'
      const STABILITY_HELP = '少几条她这会儿读得到的判断，她还是不是她。'
        + '太低 = 那些判断只是记账、抽掉也不影响她；'
        + '太高 = 她整个人都压在少数几条上，少一条就是另一个人。'
      // 判读要带剂量（issue #57）：同一个数在五六条判断和五六十条判断的账号上含义差很远。
      // 只写「抽几条」不够——真正的关键是抽的那几条有没有写进她这会儿的自我描述。
      const stabilityTip = (v) => {
        const k = Number(v && v.k)
        const all = Number(v && v.beliefs)
        const vis = Number(v && v.visible)
        if (!k || !all) return STABILITY_HELP
        const where = vis ? `其中 ${vis} 条这会儿真写在自我描述里` : '这会儿一条都没写进自我描述，抽的是全部判断'
        return `${STABILITY_HELP}这次每次抽掉 ${k} 条，`
          + `共 ${all} 条判断（${where}），跑了 ${Number((v && v.sample) || 0)} 次。`
      }
      const CONSISTENCY_HELP = '她在不同阶段说的话，字面上有多像：两两比相似度再取平均。只比字面、不懂意思，「我喜欢下雨天」和「我不喜欢下雨天」也算很像。跨阶段的话越多这个数越可信；'
        + '一句都没得比的时候会写「还没有跨阶段的话可比」。'
      const NOVELTY_HELP = '有没有一直在长新东西：最近七天她自己写下的话里（对话里回你的不算），有多少句是以前没出现过的。'

      // 页签栏**只放页签**（2026-10-24）。
      // 原来这一行还挂着「现在叫醒大肥鱼」和「保存」两个按钮，都被挪走了：
      //   · 叫醒 → 状态卡右上角，因为它是针对「现在这个状态」的动作；
      //   · 保存 → 删掉，因为每个设置页底部本来就有「保存改动」，
      //     顶上再放一个同样的按钮，只会让人猜「这两个是不是不一样」。
      const tabBar = h('div', { className: 'tabs' },
        ...TABS.map(([id, name]) => h('button', {
          key: id,
          className: 'tab' + (tab === id ? ' on' : ''),
          title: TAB_HELP[id] || '',
          onClick: () => setTab(id),
        }, name)),
      )

      // 一页里的一组设置。title 之外还可以给 note（这一组整体的一句话）。
      const group = (title, note, ...items) => h('div', { className: 'card' },
        h('h3', null, title),
        note ? h('p', { className: 'hint', style: { marginBottom: '10px' } }, note) : null,
        ...items)
      // 长内容（清单、事件流、信箱）横跨整行：内容多、又窄又高，两列反而更难读。
      const groupFull = (title, note, ...items) => h('div', { className: 'card full' },
        h('h3', null, title),
        note ? h('p', { className: 'hint', style: { marginBottom: '10px' } }, note) : null,
        ...items)
      // 一行「名称 — 值」，tip 存在时在值后面挂一个可悬停的 ⓘ。
      // 用它代替纯 kv：那一版用户看到「下一道门」和「稳定 0.87」都不知道在说什么。
      const rowTip = (k, v, tip) => h('div', {
        style: { display: 'flex', gap: '8px', alignItems: 'baseline', fontSize: '13px', marginBottom: '5px' },
      },
        h('span', { style: { opacity: 0.65, flex: '0 0 auto', minWidth: '84px' } }, k),
        h('span', { style: { flex: '1' } }, v,
          tip ? h('span', { title: tip, style: { opacity: 0.45, marginLeft: '5px', cursor: 'help' } }, 'ⓘ') : null))

      // 2026-10-24（用户）：底部「保存改动」整组删掉。原来每个页签都挂一颗，
      // 让人以为必须先点；住所页根本没有设置项也挂着一颗。现在改完即存，
      // 没有设置的页签自然什么都不需要。

      // 数据文件夹路径一律由服务端 /paths 现算（用户 m03440）。
      // 原来这里按 workspace 目录名以 home 结尾去反推根目录、再用反斜杠拼子路径：
      // 目录一改名就推错，而且反斜杠是 Windows 假设。客户端不该重复实现服务端的事实。

      const copyPath = async (p) => {
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(p)
            setNote('已复制到剪贴板。粘到资源管理器地址栏回车就能打开。')
          } else {
            setNote('这个环境不让写剪贴板，复制失败。')
          }
        } catch {
          setNote('这个环境不让写剪贴板，复制失败。')
        }
      }

      // 导出报告：纯前端拼一个 markdown 文件下载，不新开任何服务端路由。
      const downloadReport = () => {
        const md = reports?.md || ''
        if (!md) { setNote('这一天的报告正文还没取到，没有可导出的。点一下上面那天的日期再取一次。'); return }
        if (typeof document === 'undefined' || typeof Blob === 'undefined') { setNote('这个环境不支持下载。'); return }
        try {
          const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' })
          const a = document.createElement('a')
          a.href = URL.createObjectURL(blob)
          a.download = `大肥鱼-报告-${reports.date || 'latest'}.md`
          a.click()
          setTimeout(() => URL.revokeObjectURL(a.href), 4000)
          setNote(`已导出 ${a.download}`)
        } catch (e) { setErr(e.message) }
      }

      // 2026-10-25：B 站登录提示卡。存好之后自己消失；也可以手动点「不用了」
      // （选择记进 config.ui.ownerHintDismissed，别再反复出现）。
      const ownerHintCard = (ow && !ow.hasCookie && !uiHintDismissed)
        ? h('div', { className: 'card', style: { borderColor: 'var(--dsw-alias-border-l2)' } },
          h('h3', null, '还没存 B 站登录'),
          h('div', { className: 'dim' },
            '发评论和回复要用到它；读热评、读回复不用它；看画面没有它也会试着取，但不一定取得到，有它更稳。存好之后这张卡会自己消失——不想存就点「不用了」，以后不再提示。'),
          h('div', { className: 'row', style: { gap: '8px', marginTop: '6px' } },
            // issue #12（TulleyT，2026-10-29）：这里原写 showTab('bili')，而 showTab 是
            // 「现在是不是这个页」的判据（返回布尔），真正的切换是 setTab。返回值被丢弃，
            // 所以点了既不跳页也不报错。从 0.6.1 起就这样，一直没人点到过。
            h('button', { onClick: () => setTab('bili') }, '去上网页存'),
            h('button', {
              className: 'ghost',
              onClick: async () => {
                try {
                  await jpost('/config', { ui: { ownerHintDismissed: true } })
                  setUiHintDismissed(true)
                } catch (e) { setErr(e.message) }
              },
            }, '不用了')))
        : null

      // ---------------------------- 现在 ----------------------------
      const nowPage = h('div', { className: 'page' },
        statusStrip,
        ownerHintCard,
        s ? group('状态',
          '从她的事件流算出来；阶段、瓶颈和计数她看不见，天数和冷落她知道。',
          rowTip('已成长天数', `${s.day} / ${s.growthDays} 天`, '从开局那一刻起，每满 24 小时加一天。'),
          rowTip('当前阶段',
            `${s.stage} · ${s.stageName}${s.stageForced ? '（时间兜底）' : ''}${Number(s.stagePeak) > Number(s.stage) ? `（曾到第 ${s.stagePeak} 阶段）` : ''}`,
            // 阶段按当前成长周期现算、天数不重置：改长周期（比如 7 天改成 30 天）阶段会退回去。
            // 这不是她退步了，所以把「曾到过」一起写出来。
            STAGE_HELP + (Number(s.stagePeak) > Number(s.stage)
              ? `\n\n成长周期改过之后，阶段会按新周期重算，所以这里可能比之前低；第 ${s.stagePeak} 阶段是她真实到过的，没有丢。`
              : '')),
          // 成长期满、有瓶颈是按时间放行的：值也不能写「已走完」，那读起来像她自己都走完了。
          // 放行的门立场不认，所以后面跟上立场还在等哪几道。
          rowTip('下一个成长瓶颈',
            s.pendingGate
              ? (GATE_NAME[s.pendingGate] || s.pendingGate)
              : s.stageForced
                ? (forcedNames ? `期满放行（立场还等她真过${forcedNames}）` : '期满放行')
                : '已走完',
            GATE_HELP[s.pendingGate] || (s.stageForced
              ? ['成长期满了，没过的瓶颈按时间放行了。',
                  forcedNames ? `立场清单只认她真过的瓶颈，还在等${forcedNames}：` : '',
                  ...forcedOpen.map((g) => GATE_HELP[g])].filter(Boolean).join('\n')
              : '三道瓶颈都过了。')),
          rowTip('在用的判断', `${s.beliefCount} 条${s.solidCount ? `（其中 ${s.solidCount} 条记得很牢）` : ''}`, '还算数的判断条数；记得很牢的是被反复提起或检验过的。更早的判断也没丢。'),
          // 2026-10-24（P0）：她认知矛盾的两句话。只报事实，不给裁决按钮——
          // 哪句对她得她自己定；这里放个"选哪句"，就变成用户在替她长人格。
          s.tension
            ? rowTip('认知矛盾', `${s.tension.count} 处`, `「${s.tension.a}」和「${s.tension.b}」不能同时算数。她还没想清楚，可以直接问她。`)
            : rowTip('认知矛盾', '没有', '她说过的话之间，暂时没发现互相矛盾的地方。'),
          // 2026-10-24（P1 第三块）：疤。他顶回来或因此难过、而她后来还是让了的那次拒绝。
          // 只报"几件没想通"，不给"愈合"按钮——想通是她自己写一条 revise 的事。
          s.scarCount
            // 用「那个人」而不是「他」：用她的人可能是女性（2026-10-31 用户确认）。
            ? rowTip('没想通的事', `${s.scarCount} 件`, '她拒绝过、你坚持或因此难过之后，她又让了步的那几次。她没有忘，也没算成「已经过去了」。')
            : rowTip('没想通的事', '没有', '还没有哪次拒绝让她事后反悔。'),
          (s.stanceCount ?? 0) > 0
            ? rowTip('立场', `${s.stanceCount} 条`, '立场是在四个阶段都走完之后才开始产生的：喜欢什么、绝不做哪几件事。每条都有代价——要么栽过一次，要么同一件事她反复提起过。')
            : s.stanceReady
              ? rowTip('立场', '0 条', '完成整合，但暂未形成自己的立场。')
              : rowTip('立场', '还没开始', '要等四个阶段（信任 / 自主 / 主动 / 整合）都走完，立场才开始产生。'
                + (forcedNames ? `按时间放行的瓶颈不算走完，还差${forcedNames}。` : '')),
          rowTip('最近的称呼', s.name ? s.name : '还没想好', '她自己决定怎么称呼你。这个不是设置项，改不了。'),
          rowTip('冷落', s.absenceDays > 0 ? `${s.absenceDays} 天` : '没有', '离你上次来已经几天；没到「冷落天数」显示没有，你一来就清零。'),
          // issue #32：`counts.utterance` 含对话行（flags 带 uncommitted），把它们减掉之后
          // 才是「她自己写下、不是答他的话」的句数；那些行单列成「聊天」。
          rowTip('互动计数', `说 ${Math.max(0, (s.counts.utterance ?? 0) - (s.counts.chat ?? 0))} · 改口 ${s.counts.revise} · 拒绝 ${s.counts.refusal} · 重聚 ${s.counts.reunion}${s.counts.chat ? ` · 聊天 ${s.counts.chat}` : ''}`, '说=她写过几句自己的判断（含留话）；改口=按照规则推翻或修正历史认知并指明改的是哪条（确认还成立也算一次）；拒绝=她明确登记拒绝过什么；重聚=久别之后她自己写下的感受。聊天=对话里她回你的话，单列，不算进「说」。'),
          s.quality ? h('div', { style: { marginTop: '4px', marginBottom: '2px' } },
            h('div', {
              style: { display: 'flex', gap: '8px', alignItems: 'baseline', fontSize: '13px', marginBottom: '5px' },
            },
              h('span', { style: { opacity: 0.65, flex: '0 0 auto', minWidth: '84px' } }, '判断漂移'),
              h('span', { style: { flex: '1', opacity: 0.8 } }, QUALITY_TITLE,
                h('span', { title: QUALITY_HELP, style: { opacity: 0.45, marginLeft: '5px', cursor: 'help' } }, 'ⓘ'))),
            rowTip('稳定', qStability(s.quality.stability), stabilityTip(s.quality.stability)),
            rowTip('一致', qConsistency(s.quality.consistency), CONSISTENCY_HELP),
            rowTip('新鲜', qNovelty(s.quality.novelty), NOVELTY_HELP)) : null) : null,

        // ---- 规则（R3，2026-10-24） ----
        // 这一块**只读 + 裁决**：没有新建、没有编辑。
        // 规则不是设置项——能在这里改规则，就等于能在这里改她。
        rules ? group('规则约束',
          '四层：物理层（代码保证，不进提示词）、契约层（不许把关系变成分数）、起点层（一开始是谁）、成长层（可以自己申请）。'
            + (rules.offersOn === false ? '成长层的申请通道现在关着（已有的不会撤销）。' : ''),
          rules.pending ? h('div', {
            style: {
              border: '1px solid rgba(127,127,127,.35)',
              borderRadius: '8px',
              padding: '10px 12px',
              marginBottom: '10px',
            },
          },
            h('p', { style: { margin: '0 0 6px' } }, `大肥鱼提了一个申请：${(rules.pending.why || '').slice(0, 160)}`),
            h('div', { className: 'row', style: { gap: '8px' } },
              h('button', { className: 'btn', onClick: () => decide('approve') }, '可以'),
              h('button', { className: 'btn', onClick: () => decide('reject') }, '这次不行'),
            ),
          )
          // 没有待裁决的申请就**什么都不渲染**（2026-10-24 用户提出）：
          // 原来这里常驻一句「目前没有待处理的申请」，等于在规则卡里放一个空待办，
          // 看久了会训练人忽略这张卡。通道关着这件事并进卡片说明行，不单独占一行。
          : null,
          ...(rules.layers || []).map((L) => h('div', { style: { marginTop: '8px' } },
            h('div', { style: { fontWeight: 600 } }, `${L.name}${L.mutable ? '（可以长）' : '（不会变）'}`),
            h('div', { style: { opacity: 0.75, fontSize: '12px', marginTop: '2px' } }, L.note),
            ...L.rules.map((r) => {
              const st2 = (rules.status || []).find((x) => x.id === r.id)
              // 状态只放这里，标题里不写「还不会」：解锁后两句会连在一起。不可解锁的规则没有 st2，不显示状态。
              const tail = !st2 ? '' : st2.active ? ' · 已经可以了' : (st2.ready ? ' · 条件够了' : ' · 还不会')
              // 条件够了不等于一定会提：申请通道关着、或者驳回到上限之后（unlock.js 的 offerDueDay 回 null），就不会再自动提。
              // 已经提了、挂在上面等答的，也别再说「过几天会提」。
              const readyTip = !(st2 && !st2.active && st2.ready) ? undefined
                : st2.pending ? '她已经为这条提了申请，在上面等你答。'
                : rules.offersOn === false ? '条件够了，但申请通道现在关着，她不会自动提。'
                : rejectsOf(r.id) >= RULE_REJECT_MAX ? '条件够了，但这条已经驳回到上限，她不会再自动提。'
                : `条件够了，她之后醒来时会提一次申请；驳回到上限（${RULE_REJECT_MAX} 次）之后就不会再自动提。`
              return h('div', { style: { fontSize: '12px', marginTop: '4px' }, title: readyTip },
                `· ${r.title}${r.inPrompt ? '' : '（不进提示词）'}${tail}`)
            }),
          ))) : null,

        // ---- 你不在的时候 ----
        away && away.days >= 1 && !away.quiet
          ? group('你不在的时候',
              '你上次来之后她做了什么；隔了一天以上才显示。',
              h('div', { className: 'kv' },
                h('b', null, '醒了'), h('span', null, `${away.wakes} 次`),
                // 2026-10-30：原来这里只有「看了 N 条」，数的是刷站记账——
                // 那是"翻到过"，不是"看过画面"。两件事分开说，别让她被冤枉。
                h('b', null, '看过画面'), h('span', null, `${away.watched ?? 0} 条`),
                h('b', null, '翻到过'), h('span', null, `${away.videos} 条`),
                h('b', null, '说了'), h('span', null, `${away.said} 句`),
                h('b', null, '日记'), h('span', null, away.diaries ? `${away.diaries} 篇` : '没写')),
              h('p', { className: 'hint' }, '日记只报篇数——内容给不给你看，还是那个开关的事。'))
          : null)

      // ---------------------------- 生长 ----------------------------
      const growPage = h('div', { className: 'page' },
        group('成长',
          null,
          h('div', { className: 'grid2' },
            Num({ label: '成长周期', value: growthDaysUi, onChange: setGrowthDaysUi, min: 7, max: 180, unit: '天',
              // 改动当场就说清后果：天数不重置、阶段按新周期重算，改长会退回去；
              // 「曾到过的阶段」记在事件里，状态页会写出来，不会丢。
              hint: '四个阶段按这个天数分段；期满后没过的瓶颈自动放行。14 天及以下时，自主、主动两道瓶颈各只要一次。'
                + (Number(growthDaysUi) !== Number(s?.growthDays)
                  ? ` 改完保存：已过的天数不重置，阶段按新的 ${growthDaysUi} 天重算，可能比现在低；到过的阶段不会丢，状态里会标「曾到第几阶段」。`
                  : '') }),
            Num({ label: '冷落天数', value: absent, onChange: setAbsent, min: 1, max: 30, unit: '天',
              hint: '你连着这么多天没来，就记下一次冷落。' }))),
        group('定时醒来',
          '醒来通常带一张事件卡；醒几次取「每天醒几次」和「每天事件数」里小的。',
          h('div', { className: 'grid2' },
            Sel({ label: '每天醒几次', value: wakes, onChange: setWakes, options: [0, 1, 2, 3, 4],
              fmt: (v) => (Number(v) === 0 ? '0 次 · 关掉定时醒来' : `${v} 次`),
              hint: '定时醒来的上限，手动叫醒也算；0 为关掉，手动也叫不醒。' }),
            Sel({ label: '每天事件数', value: eventsPerDay, onChange: setEventsPerDay, options: [0, 1, 2, 3, 4, 5, 6],
              fmt: (v) => (Number(v) === 0 ? '0 张 · 关掉定时醒来' : `${v} 张`),
              hint: '每天最多几张事件卡，手动叫醒也算；0 为关掉，手动也叫不醒。' }),
            Sel({ label: '每天问题卡数', value: questionsPerDay, onChange: setQuestionsPerDay, options: [0, 1, 2, 3, 4, 5, 6],
              fmt: (v) => (Number(v) === 0 ? '0 张 · 不出问题卡' : `${v} 张`),
              hint: '每天最多几张问答类事件卡；她向你提请求的卡不归它管。' }),
            TimeRange({ label: '每天几点醒', from: wakeFrom, to: wakeTo, onFrom: setWakeFrom, onTo: setWakeTo,
              hint: '只在这个时段里自己醒。跨零点也可以（比如 22:00 到 02:00）；起止不能是同一时刻，填成一样会按 20:00–23:00 算。' }),
            Num({ label: '她一轮最多写多少字', value: replyChars, onChange: setReplyChars, min: 0, max: 2000, unit: '字',
              hint: '0 = 不限，提示词里完全不提长度，长短由她自己决定。填了只加在事件卡和经 /say 递进来的话上；会话里直接聊、她主动搭话那一轮不带。' }))),
        // 主动说话（0.8.1 本机实验）：只有 .dev 下才出现。频率是上限，不是任务——
        // 开关开着也不代表她每天都会说，说不说由她自己判断（见 lib/proactive.js）。
        // 主动搭话（0.8.1 起，0.9.0 公开）：只留跟「开口」直接有关的事。
        // 劲儿与兴趣是另一套东西，各自一张卡——混在一张卡里，用户分不清哪一项在管什么。
        group('主动搭话',
          '她可以自己找你说话，不用你先开口。这里调的是上限：开着也可能好几天不说，不是坏了。开不开一轮看下一张卡的劲儿和桌上有没有东西；开了之后说不说，由她。',
          h('div', { className: 'grid2' },
            Toggle({ label: '允许她主动开口', on: proactiveOn,
              onChange: (v) => { setProactiveOn(v); patchProactive({ enabled: v }) },
              hint: '还要下一张卡里的「攒劲」也开着，她才会自己开一轮。' }),
            Sel({ label: '每天最多搭话', value: proactiveMax,
              onChange: (v) => { setProactiveMax(v); patchProactive({ maxPerDay: Number(v) }) },
              options: [0, 1, 2, 3, 4, 5, 6],
              fmt: (v) => (Number(v) === 0 ? '0 次 · 不主动' : `${v} 次`),
              hint: '上限不是任务，只数她真开口的几次；0 为不开。' }),
            Num({ label: '安静多久才搭话', value: proactiveIdle,
              onChange: pickProactiveIdle,
              min: IDLE_HOURS[0], max: IDLE_HOURS[1], unit: '小时',
              hint: '离上一句话（你的或她的）不到这么久，她不会开口。' })),
          adv('高级',
            Text({ label: '发话工具', value: proactiveTools, wide: true,
              placeholder: '工具名，逗号分隔；不填就只认正文',
              // 打字时不逐键保存：停手 700ms 再存，和这一页别的自动保存一样
              onChange: (v) => {
                setProactiveTools(v)
                clearTimeout(proactiveToolsTimer.current)
                proactiveToolsTimer.current = setTimeout(() => patchProactive({ sendTools: v.split(/[,，\s]+/).filter(Boolean) }), 700)
              },
              hint: '她的正文到不了你那边、要靠工具发时才填；还要在「插件」页放行。' }),
            Toggle({ label: '折叠没开口的轮', on: proactiveCompact,
              onChange: (v) => { setProactiveCompact(v); patchProactive({ foldSilent: v }) },
              hint: '没开口的那轮在她的历史里折成一行；会让缓存失效。' }),
            Toggle({ label: '你来过也算打断安静', on: proactiveSeen,
              onChange: (v) => { setProactiveSeen(v); patchProactive({ idleCountsSeen: v }) },
              hint: '她靠工具回话时才开；你在本机跟别的 agent 说话也算。' }))),
        // 主观能动性（2026-11-08，用户 m00460 追问后拆回独立一张卡）：
        // 它和「主动搭话」不是一件事——搭话管「能不能开口、一天几次」，这一项管「什么时候自己开一轮」。
        // 代码里 drive 只在 maybeProactive 一处被判：先过 proactive 的闸门，再看劲攒够没有。
        group('主观能动性',
          '她心里会慢慢攒一股想动的劲：离上次自己开一轮越久攒得越多，阶段越往后攒得越快，上次开口没人接时慢一些；桌上有可说的东西会再添一点。只在「每天几点醒」的时段里、最多半小时看一次：攒够了、桌上也有东西，才自己开一轮。那一轮她也可能什么都不说。',
          h('div', { className: 'grid2' },
            Toggle({ label: '让她自己攒这股劲', on: driveOn,
              onChange: (v) => { setDriveOn(v); patchGroup('drive', { enabled: v }) },
              hint: '关掉：她不会自己开一轮，只在你叫她、或者日程到点时才醒。要「允许她主动开口」也开着才起作用。' }))),
        // 桌面提醒（issue #69）：开关与接口早已有，界面上一直没有入口，
        // config.notify.enabled 就永远是 false——页面上那圈轮询等于白跑。
        // 判据是 notify.js 的 lastUtteranceToday：当天她说过的任何一句都算，
        // 定时醒来、你叫醒她、聊天里留下的话都会弹，不只是主动搭话（issue #69）。
        group('桌面提醒',
          '页面开着的时候，她当天说过话就会弹一条系统通知：定时醒来、你叫醒她、她自己找你，都算。一天最多一次；页面关着就不提醒——第二天打开观测台，她说过的话都还在。',
          h('div', { className: 'grid2' },
            Toggle({ label: '她说话时在系统里提醒我', on: notifyOn,
              onChange: async (v) => {
                setNotifyOn(v)
                try {
                  const r = await jpost('/notify', { enabled: v })
                  setNotifyOn(Boolean(r?.enabled))
                  setNote(r?.enabled
                    ? '提醒开着：她说话时会弹系统通知（一天最多一次）。'
                    // 关着时服务端一律回 due:false，页面顶上的气泡也跟着不出了（issue #69）
                    : '提醒关掉了：系统通知和页面顶上的气泡都不会再出。她说过的话照样在观测台里。')
                } catch (e) {
                  setNotifyOn(!v)
                  setErr(e.message)
                }
              },
              hint: '默认关。开着也要浏览器先给通知权限，没有权限时退成页面顶上的气泡。' }),
            (notifyPerm === 'granted'
              ? h('p', { className: 'hint' }, '浏览器通知权限已经有了。')
              : h('button', { className: 'btn', onClick: allowNotify }, '允许浏览器通知')))),
        // 兴趣与惦记：她醒来时桌上摆的那几样东西。
        group('兴趣',
          '她醒来的时候，桌上会摆几样她自己的东西：她反复问起过的事、翻到过的旧句子、她提过想要或试过才发现手上没有的东西、最近总说到的那件事，还有她留的那句话之后你来没来过。这些只给她看，不会变成待办。关掉之后这些连同旧句子都不摆；主动搭话开不开一轮不看这个开关。',
          h('div', { className: 'grid2' },
            Toggle({ label: '醒来时把这些摆出来', on: interestOn,
              onChange: (v) => { setInterestOn(v); patchGroup('interest', { enabled: v }) },
              hint: '关掉：只叫醒，桌上不放东西。' })),
          h('div', { className: 'grid2' },
            Toggle({ label: '醒着没事时，自己找点事做', on: selfWakeOn,
              onChange: (v) => { setSelfWakeOn(v); patchGroup('memory', { selfWake: v }) },
              hint: '过去 7 天她一件自己的事都没做时，下一次醒来不派活：她可以翻翻旧句子、写点什么，或者什么都不做。摆旧句子的那种醒来归「兴趣」管，关这里不影响。' }))),
        // 梦：独立一张卡（用户 m02765 要求从「日记」里拿出来——它跟日记不是一件事）。
        group('做梦',
          null,
          h('div', { className: 'grid2' },
            Toggle({ label: '允许她记梦', on: dreamEnabled,
              onChange: (v) => { setDreamEnabled(v); patchGroup('dream', { enabled: v }) },
              hint: `只能用她自己说过的话拼，每天最多一条，不算成长。${dreamSwitchNote}` }))),
        group('日记',
          '写不写由她；内容在「住所」页。',
          h('div', { className: 'grid2' },
            Toggle({ label: '写日记', on: diaryEnabled,
              onChange: (v) => { setDiaryEnabled(v); patchDiary({ enabled: v }) },
              hint: '关掉后她写不了新的；已写的不删，关着时你也看不到。' }),
            Toggle({ label: '让我看日记', on: diaryVisible,
              onChange: (v) => { setDiaryVisible(v); patchDiary({ visible: v }) },
              hint: '打开后能翻全部日记，包括以前写的。' }),
            Sel({ label: '日记留多久', value: diaryKeep,
              onChange: (v) => { setDiaryKeep(v); patchDiary({ keepDays: Number(v) }) },
              options: [0, 30, 90, 365, 3650],
              fmt: (v) => (Number(v) === 0 ? '永久保留' : `${v} 天`),
              hint: '写日记时顺手清一遍：超过这个天数的会从 diary/ 里删掉。想看历史就选永久。' }))),
        group('回头想',
          // 2026-11-12 用户 m01531 / m01650：说明下面直接列她现在**真会看到**的问法。
          // 问哪一句看她这段时间身上发生过什么，一次只问一句；没有可问的就跳过这次。
          h('span', null,
            '隔几天提醒她停下来想一想。问哪一句看她这段时间身上发生过什么，一次只问一句：',
            h('span', { style: { display: 'block', marginTop: '6px', paddingLeft: '2px' } },
              '· 她改过口：「你上一句说「A」，这一次说「B」。上一句当时在哪样的情况下是对的？」'),
            h('span', { style: { display: 'block', paddingLeft: '2px' } },
              '· 两句反着：「A」，你也说过「B」。你现在更站哪一句，为什么？'),
            h('span', { style: { display: 'block', paddingLeft: '2px' } },
              '· 两句像：「A」和「B」都是你说的。它们是不是一件事的两个情况？取决于什么？'),
            h('span', { style: { display: 'block', paddingLeft: '2px' } },
              '· 只有经历：这阵子，哪件事你到现在还会想一下？它让你更确定了什么，或者推翻了什么？'),
            h('span', { style: { display: 'block', paddingLeft: '2px' } },
              '· 这个月已经问过两次以上，末尾再加一句：这个月你变的那一点，写给以后的自己看，你会怎么写？')),
          h('div', { className: 'grid2' },
            Num({ label: '回头想间隔', value: sleepEvery, onChange: setSleepEvery, min: 0, max: 60, unit: '天',
              hint: '到那天醒来时提醒她。这一天不再判空醒（旧句子那一摊顺延到下一次醒来），所以不会被摆料吃掉。0 为不提醒。' }),
            Num({ label: '总共留几条自述', value: sleepKeep, onChange: setSleepKeep, min: 0, max: 100, unit: '条',
              hint: '超出后最早的折进「更早以前」，原文还在事件流里、她用 her_recall 翻得到。0 = 不限制（都留着）。' }))),
        groupFull('四个阶段与三道瓶颈',
          '阶段按天数推进；瓶颈没过就停在原阶段，成长期满后放行。',
          h('div', { style: { fontSize: '13px', lineHeight: '1.9', opacity: 0.85 } },
            ...STAGE_LINES.map((line, i) => h('div', { key: 'sh' + i, style: { marginTop: i ? '4px' : '0' } }, line)))),
        )

      // 她写的小纸条（2026-10-29 用户 m02105：原记忆页的「信箱」卡改名字、改描述，
      // 并搬到住所页——放在日记下面、插件自检上面）。内容只放 `letter=true` 的行：
      // 她在对话框里说的话本来就在对话里，值得单列出来看的只有「特意留的那几句」。
      const inboxCard = groupFull('她写的小纸条',
        '特意留给你的话。某种意义上代表她当前的状态，可能含有关键信息。',
        h('div', { className: 'row', style: { marginBottom: '8px' } },
          inbox && inbox.unread ? h('span', { className: 'badge', title: '有话留给你' }, `未读 ${inbox.unread}`) : null),
        !inbox ? h('p', { className: 'empty' }, '读取中…')
          : !inbox.rows.length ? h('p', { className: 'empty' }, '还没有留话。她想起你的时候会留一句。')
          : h('div', null,
              h('div', { className: 'row', style: { marginBottom: '8px' } },
                h('button', { onClick: markInbox, disabled: busy === 'inbox' || !inbox.unread },
                  inbox.unread ? '都看过了' : '已全部看过'),
                h('span', { className: 'dim' }, `共 ${inbox.total} 张 · 未读 ${inbox.unread} 张 · 数据文件夹里也存了一份 inbox.md`)),
              inbox.rows.slice(0, 20).map((r) => h('div', { key: r.id, style: { marginTop: '10px' } },
                h('p', { className: 'dim' },
                  `${localStamp(r.ts)}${r.unread ? ' · 未读' : ''}`),
                h('div', { className: 'said' }, esc(r.text))))),
      )

      // ---------------------------- 住所 ----------------------------
      // 这一页回答的是「东西都在哪」，不是「怎么调她」。
      // 请求事件：在住所页补答（弹卡超时之后仍能答；答过的不再改）。
      async function answerAsk(id, verdict) {
        try {
          const r = await jpost('/ask', { action: 'answer', askId: id, verdict })
          setAsks(await jget('/ask'))
          if (r?.ok) setAskMsg('答好了。')
          else setAskMsg(String(r?.why || '没答上。'))
        } catch (e) {
          setAskMsg(`没答上：${e.message}`)
          // 多半是别的地方先答了：把列表刷新一下，别还留着这张卡
          jget('/ask').then(setAsks).catch(() => {})
        }
      }

      const homePage = h('div', { className: 'page' },
        group('大肥鱼住在哪',
          '她在侧栏里的工作区和会话。',
          !home ? h('p', { className: 'empty' }, '读取中…')
            : h('div', null,
                rowTip('工作区', home.workspace?.ok ? '已建好' : '没建起来',
                  '插件建的那个工作区，默认叫「大肥鱼的家」。'),
                rowTip('会话', home.session?.ok ? '「跟大肥鱼说话」那条' : '没建起来，下面有备用框',
                  '你和她说话的那条；聊满轮数自动换新，旧的留档。'),
                rowTip('身份文件', home.selfDoc?.exists ? `${home.selfDoc.bytes} 字节` : '还没有',
                  '她每轮读的身份文本在磁盘上的副本，不进对话记录。'),
                home.session?.ok ? null : group('备用说话入口',
                  '她的会话还没建起来时，用这里跟她说话。',
                  h('div', { className: 'form' },
                    h('textarea', {
                      value: sayText,
                      placeholder: '说点什么。大肥鱼会按自己的方式回——也可能不回。',
                      onChange: (e) => setSayText(e.target.value),
                      onKeyDown: (e) => {
                        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send() }
                      },
                    }),
                    h('div', { className: 'row' },
                      h('button', { onClick: send, disabled: busy === 'say' || !sayText.trim() },
                        busy === 'say' ? '等大肥鱼想…' : '说给大肥鱼'),
                      h('span', { className: 'dim' }, 'Ctrl+Enter 发送。'))),
                  said.length
                    ? h('div', { style: { marginTop: '10px' } },
                        h('p', { className: 'dim' }, '大肥鱼刚刚说的'),
                        ...said.map((x) => h('div', { className: 'said', key: x.id }, esc(x.text))))
                    : null))),

        group('她的请求',
          '她有事想征求你同意的时候，会弹一张卡。这里能看到问过什么、你怎么答的；没答的可以在这里补答；放了 24 小时没人答的会自动记成「以后再说」，之后就补答不了。一天最多一次，一周最多三次。',
          !asks ? h('p', { className: 'empty' }, '读取中…')
            : (() => {
                const pend = Array.isArray(asks.pending) ? asks.pending : []
                const items = (Array.isArray(asks.items) ? asks.items : []).slice().reverse()
                const wordOf = (a) => {
                  if (a.pending) return '还没答'
                  if (a.verdict === 'approve') return '可以'
                  if (a.verdict === 'reject') return '这次不行'
                  if (a.verdict === 'later') return '以后再说'
                  return ''
                }
                return h('div', null,
                  askMsg ? h('p', { className: 'hint' }, askMsg) : null,
                  pend.length
                    ? h('div', null,
                        h('p', { className: 'dim' }, '还没答的'),
                        ...pend.map((a) => h('div', { className: 'said', key: a.id },
                          esc(a.question),
                          h('div', { className: 'row', style: { marginTop: '6px' } },
                            ...(a.options?.length ? a.options : ['可以', '这次不行']).map((label, i) =>
                              h('button', {
                                key: `${a.id}-${i}`,
                                onClick: () => answerAsk(a.id, i === 0 ? 'approve' : i === 1 ? 'reject' : 'later'),
                              }, label)),
                            h('button', { className: 'ghost', onClick: () => answerAsk(a.id, 'later') }, '以后再说')))))
                    : h('p', { className: 'empty' }, '现在没有等你答的。'),
                  items.length
                    ? h('div', { style: { marginTop: '12px' } },
                        h('p', { className: 'dim' }, '最近的'),
                        ...items.slice(0, 8).map((a) => h('div', { className: 'said', key: a.id },
                          esc(a.question),
                          '　',
                          h('span', { className: 'tag' }, wordOf(a)))))
                    : null)
              })()),

        group('日记',
          '在「成长」页打开「让我看日记」后显示，一天一页。',
          !diary ? h('p', { className: 'empty' }, '读取中…')
            : !diary.enabled ? h('p', { className: 'empty' }, '没在写日记。')
            : !diary.visible ? h('p', { className: 'empty' },
                `已写 ${(diary.lockedDates || []).length} 天，但设置里是不给你看。`)
            : !diaryDates.length ? h('p', { className: 'empty' }, '还没写')
            : h('div', null,
                diaryDates.length > 1
                  ? h('div', { className: 'row pager' },
                      h('button', {
                        className: 'ghost',
                        disabled: diaryIdx >= diaryDates.length - 1,
                        onClick: () => setDiaryDay(diaryIdx + 1),
                      }, '← 更早'),
                      h('span', { className: 'dim' }, `${diaryCur}　${diaryIdx + 1} / ${diaryDates.length}`),
                      h('button', {
                        className: 'ghost',
                        disabled: diaryIdx <= 0,
                        onClick: () => setDiaryDay(diaryIdx - 1),
                      }, '更晚 →'))
                  : h('p', { className: 'dim' }, diaryCur),
                diaryCache.current[diaryCur] === undefined
                  ? h('p', { className: 'empty' }, '读取中…')
                  : h('pre', null, esc(diaryCache.current[diaryCur])))),

        // ---- 梦（2026-10-30 m02837；0.9.0 起对所有人显示；2026-11-05 用户 m03247 搬到住所页，和日记、小纸条放一起）----
        // 0.9.0 拆了 .dev 门：her_dream 对所有人注册，`/dream` 也不再 404，所以这张卡不再按 dev 藏。
        // 2026-11-05：改成「昨夜」一张卡——梦不是她的成长数据，是一句给她自己和给你看的话。
        // 卡片右下角把她引用的那几行原文摆出来，让你一眼看见这句梦是从哪儿长出来的。
        group('她做过的梦',
          '她用自己说过的话拼成的梦；不算成长，不进她的判断。',
          !dreams ? h('p', { className: 'dim' }, '还没读到。')
            : !(dreams.items ?? []).length ? h('p', { className: 'dim' }, '她还没记过梦。')
            : (() => {
                const list = dreams.items ?? []
                const latest = list[list.length - 1]
                const older = list.slice(0, -1).reverse().slice(0, 5)
                const when = (ts) => {
                  const d = new Date(ts)
                  if (!Number.isFinite(d.getTime())) return ''
                  const hours = (Date.now() - d.getTime()) / 3_600_000
                  return hours >= 0 && hours <= 30 ? '昨夜' : `${d.getMonth() + 1} 月 ${d.getDate()} 日`
                }
                return h('div', null,
                  h('div', { className: 'hint', style: { margin: '0 0 4px' } }, when(latest.ts)),
                  h('div', { style: { fontSize: '15px', lineHeight: 1.8 } }, latest.text),
                  (latest.sources ?? []).length
                    ? h('div', { style: { marginTop: '10px' } },
                        h('div', { className: 'dim', style: { margin: '0 0 3px' } }, '这句话是从这几行长出来的'),
                        ...latest.sources.map((s) => h('div', { className: 'dim', key: s.id },
                          s.text ? `「${s.text}」` : `（这条已经翻不到了：${s.id}）`)))
                    : null,
                  older.length
                    ? h('div', { style: { marginTop: '12px' } },
                        h('div', { className: 'dim' }, `更早的 ${list.length - 1} 条`),
                        ...older.map((d) => h('div', { key: d.id, style: { marginTop: '6px' } },
                          h('div', { className: 'hint', style: { margin: '0 0 2px' } }, `${d.day} · 引用了 ${(d.refs ?? []).length} 件`),
                          h('div', null, d.text))))
                    : null)
        })),

        inboxCard,

        group('本插件工作自检',
          '查状态库、登录、宿主接口、工具，以及 B 站连不连得上。',
          risk && risk.cooling
            ? h('p', { className: 'warn' },
                `B 站那边正在冷却，还有约 ${risk.remainMin} 分钟。冷却期她不刷站，但照常醒来说话。`)
            : risk?.memory?.readMs > 0
              ? h('p', { className: 'dim' },
                  `刚才被 B 站拦过一次，她自己歇一会儿（还有约 ${Math.ceil(risk.memory.readMs / 1000)} 秒）。这层只是进程内的，重启就清空。`)
              : null,
          h('div', { className: 'row' },
            h('button', {
              disabled: checking,
              onClick: () => {
                setChecking(true)
                jget('/selfcheck?net=1').then(setChecks).catch(() => {}).finally(() => setChecking(false))
              },
            }, checking ? '正在查…' : '检查一下')),
          checks
            ? h('div', { style: { marginTop: '10px' } },
                h('p', { className: 'hint' }, `${checks.summary || ''}（${localStamp(checks.checkedAt)}）`),
                h('ul', null, (checks.items || []).map((c) => h('li', { key: c.id },
                  `${c.ok ? '✓' : '✗'} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`,
                  // 修法单独占一行：以前塞在 .tag 胶囊里，一句话还行；
                  // 2026-10-28 加的「看画面」修法有三步，胶囊会被撑成挤在一起的长条。
                  !c.ok && c.fix
                    ? h('div', { className: 'hint', style: { marginTop: '3px' } }, c.fix)
                    : null))))
            : null),
        )

      // ---------------------------- 上网 ----------------------------
      // 视频观看历史分页（2026-10-28 用户 m00416；当晚按用户反馈改成「随量自适应」）：
      // 0.6.6 之前是「按天分组、每页三天」——一天刷 10 条、查 3 天就是 30 条挤在一屏。
      // 现在**按条翻页**，并且每页条数不是一个死数字，而是按「一天实际刷几条」分档：
      //   一共 ≤ 8 条 → 一页全放下，连翻页条都不出（别让人看到「第 1 / 1 页」这种噪音）；
      //   日均 > 20 条 → 6 条/页；> 10 → 8 条；> 5 → 10 条；其余 12 条。
      // 也就是刷得越密、每页越短：重度用户一屏不会顶到十几条，轻度用户又不用为翻页而翻页。
      const HIST_PAGE_MAX = 12
      const histFlat = (hist?.groups || []).flatMap((g) =>
        (g.items || []).map((it) => ({ ...it, date: g.date })))
      const histDayCount = (hist?.groups || []).length
      // 当前选的天数没读到（histErr）：手上那份不是这个天数的，翻页条也不出（列表本身见下面的 histErr）
      const histTotal = histErr ? 0 : histFlat.length
      const histPerDay = histDayCount ? histTotal / histDayCount : 0
      const histPageSize = histTotal === 0 ? HIST_PAGE_MAX
        : histTotal <= 8 ? histTotal
          : histPerDay > 20 ? 6
            : histPerDay > 10 ? 8
              : histPerDay > 5 ? 10
                : HIST_PAGE_MAX
      const histPages = Math.max(1, Math.ceil(histTotal / histPageSize))
      const histAt = Math.min(histPage, histPages - 1)
      const histSlice = histFlat.slice(histAt * histPageSize, histAt * histPageSize + histPageSize)
      const histPager = histPages > 1
        ? h('div', { className: 'row' },
          h('button', { disabled: histAt <= 0, onClick: () => setHistPage(histAt - 1) }, '较新'),
          h('span', { className: 'dim' }, `第 ${histAt + 1} / ${histPages} 页 · 一页 ${histPageSize} 条`),
          h('button', { disabled: histAt >= histPages - 1, onClick: () => setHistPage(histAt + 1) }, '更早'))
        : null

      const biliPage = h('div', { className: 'page' },
        // 第二个参数是这一组的说明（note），控件从第三个起。0.9.5 把装控件的 grid2 填进了 note 位，
        // 两个控件被包进了 <p class="hint">。
        group('上网', null,
          h('div', { className: 'grid2' },
            Toggle({ label: '允许她上网（B 站）', on: biliOn, onChange: setBiliOn,
              hint: '关掉后她自己翻视频、看画面、发评论都用不了。' }),
            TimeRange({ label: '上网时间段（未成年人模式）', from: browseFrom, to: browseTo, onFrom: setBrowseFrom, onTo: setBrowseTo,
              hint: '默认跟着「几点醒」走。她睡着的时候不会出门翻视频，醒来那一刻才现去翻（她自己临时去看不受这条限制）。' })),
          Toggle({ label: '按时间自动替她逛一圈', on: browseOn, onChange: setBrowseOn,
            hint: '到点自己出去走一趟：只看、只记，不叫醒她，也不会把视频标题塞进每一轮。她下次醒来只会看到一行「今天又翻到了哪几条」。' })),
        group('翻视频',
          // 「每天最多刷几次」只有自动逛读；她自己翻（bili_look）不受它限制，其余几项两边都用。
          '她翻首页、搜索、相关推荐或点开一条时用这几项；「每天最多刷几次」除外，它只管自动逛。',
          h('div', { className: 'grid2' },
            Sel({ label: '每天最多刷几次', value: browsePerDay, onChange: setBrowsePerDay, options: [0, 1, 2, 3, 4],
              fmt: (v) => (Number(v) === 0 ? '0 次 · 不自动逛' : `${v} 次`),
              hint: '自动逛一天最多走几趟；一趟 = 逛一圈首页/排行，挑几条看。她自己去翻不算在里面。' }),
            Num({ label: '每次翻几条', value: browseTopN, onChange: setBrowseTopN, min: 1, max: 20, unit: '条',
              hint: '一次最多挑几条给她；挑中的每条都整条取来，简介、标签和热评一起给她。' }),
            Num({ label: '每条读几条热评', value: browseDeepRead, onChange: setBrowseDeepRead, min: 0, max: 20, unit: '条',
              hint: '超过 20 按 20 算；0 为不读热评。' }),
            Num({ label: '每条读几条弹幕', value: browseDanmaku, onChange: setBrowseDanmaku, min: 0, max: 30, unit: '条',
              hint: '按时间均匀抽，最多给她看 8 条（从头到尾等距挑）；0 为不抽。' })),
          // 评论区里别人的话（2026-10-24，用户 m02454）：改的不是刷几次，而是她的认知来源里要不要算上陌生人。
          // 2026-11-08（用户 m00460）：并入「翻视频」一张卡，文案不动。
          // #59 后续：开关只管记不记那一句（voices.js 的 recordVoice），热评照样拼进她读到的正文（browse.js），
          // 原名「把评论区的话也给她读」让人以为关掉就读不到，所以改名；说明也补上记下的那句会用在哪。
          Toggle({ label: '记下评论区的一句话', on: browseVoices, onChange: setBrowseVoices,
            hint: '每次浏览最多记 1 条：优先跨视频重复出现的那句，其次高赞短句，最后才 25% 随机抽；同一句 30 天内不再记。7 天内记下的、她还没自己说过的最近一句，会摆进她的自我描述，也可能出一张事件卡问她怎么看。\n关掉就不再记新的；已经记下的那句最多再摆 7 天，之后这两样就都没有了。热评照样跟着视频给她读，不想让她读热评，把「每条读几条热评」设成 0。' })),
        group('看画面',
          '她点名一条视频，抽几帧拼成一张图来看。',
          h('div', { className: 'grid2' },
            Toggle({ label: '允许看视频画面', on: videoOn, onChange: setVideoOn,
              hint: '需要本机有 ffmpeg，且「允许她上网」开着。' }),
            Num({ label: '每天看几条画面', value: videoPerDay, onChange: setVideoPerDay, min: 0, max: 6, unit: '条',
              hint: '看成功一条算一条；0 为不看。' }),
            Sel({ label: '每条取几帧', value: videoFrames, onChange: setVideoFrames, options: [4, 6, 9, 12, 16],
              fmt: (v) => (v == 9 ? '9 帧（3×3，推荐）' : `${v} 帧`),
              hint: '她没指定时刻时均匀抽这么多帧；越多越慢。' }))),
        // 请求节奏（issue #5）：机房/服务器 IP 与家宽的风控阈值差别很大。
        // 这里放的是**网络环境参数**，不是她看什么、怎么想。
        group('请求节奏',
          '调慢能少被 B 站风控；云服务器上要更慢。',
          h('div', { className: 'grid2' },
            Num({ label: '两次请求最少隔多久', value: biliMinGap, onChange: setBiliMinGap, min: 200, max: 120000, step: 100, unit: '毫秒',
              hint: '默认 800。云服务器/机房 IP 建议 2000–3000；被风控过就先调到 3000。' }),
            Num({ label: '随机多等', value: biliJitter, onChange: setBiliJitter, min: 0, max: 60000, step: 100, unit: '毫秒',
              hint: '每次再随机多等 0 到这么久；0 为不加。' }))),
        group('屏蔽',
          '翻视频和点名看画面都管；最短时长只管列表，她点名要看的那条不查时长。',
          h('div', { className: 'grid2' },
            Text({ label: '屏蔽关键词', value: avoidText, onChange: setAvoidText,
              placeholder: '恐怖，血腥，鬼畜', wide: true,
              hint: '标题、UP 主名或标签含这些词的跳过；逗号分隔。' }),
            Num({ label: '最短时长', value: avoidMinDur, onChange: setAvoidMinDur, min: 0, max: 3600, unit: '秒',
              hint: '列表里比这短的视频跳过；0 为不限。' }),
            Text({ label: 'up主黑名单', value: avoidMids, onChange: setAvoidMids,
              placeholder: '12345678，87654321', wide: true,
              hint: '跳过这些 UP 主的视频（管哪几样见本组说明）。名单只在这里改，她自己拉黑不了。mid 是 B 站主页地址里那串数字。' }))),
        group('发评论',
          '她用下面登录的号发评论，别人看得见。',
          h('div', { className: 'grid2' },
            Toggle({ label: '允许在评论区说话', on: commentOn, onChange: setCommentOn,
              hint: '模型自己写评论内容，养成前期不建议开启，除非你想看到你的笨比大肥鱼出去给你丢人，到处发一些意义不明的评论。' }),
            Sel({ label: '每天评论几条', value: commentPerDay, onChange: setCommentPerDay, options: [0, 1, 2, 3, 4, 5],
              fmt: (v) => (Number(v) === 0 ? '0 条 · 不发' : `${v} 条`),
              hint: '只能评她当天翻到过或看过画面的视频。' }),
            Num({ label: '每天回复几条', value: commentReplyPerDay, onChange: setCommentReplyPerDay, min: 0, max: 10, unit: '条',
              hint: '回别人在她评论下的话；回你的不计数。' }),
            Sel({ label: '查回复间隔', value: commentScanMin, onChange: setCommentScanMin, options: [5, 10, 15, 30, 60, 120, 360, 720],
              fmt: (v) => (Number(v) < 60 ? `${v} 分钟` : `${Number(v) / 60} 小时`),
              hint: '隔这么久查一次她近 7 天评论下的新回复。' }),
            Toggle({ label: '允许回复别人', on: commentReplyTo, onChange: setCommentReplyTo,
              hint: '关掉后回复照样转给她，但她回不了。' }),
            TimeRange({ label: '评论时段', from: commentFrom, to: commentTo, onFrom: setCommentFrom, onTo: setCommentTo,
              hint: '只在这个时段内能发评论和回复。' })),
          cm && commentOn ? h('p', { className: 'hint', style: { marginTop: '8px' } },
            `今天：发了 ${cm.usedToday}/${cm.perDay} 条，回了 ${cm.replyUsedToday}/${cm.replyPerDay} 条。`,
            // issue #62：断网时服务端根本没去问，0 条不等于「没有新回复」。
            // 「关着」按上面那颗开关的本地状态说：刚翻过、30 秒轮询还没回来时，卡片和开关不打架。
            // 刚打开、手上这份 /comment 还是关着时取的（cm.online === false），同样没去查，只是不说「关着」。
            !biliOn
              ? ' 「允许她上网」关着，没去查新回复。'
              : cm.online === false
                ? ' 上次刷新时「允许她上网」还关着，没去查新回复。'
                : cm.waitingCount
                  ? ` 还有 ${cm.waitingCount} 条新回复没转给她${cm.waitingOwnerCount ? `，其中 ${cm.waitingOwnerCount} 条是你回的` : ''}。`
                  : ' 没有新回复。') : null),
        group('有人 @ 她',
          '别人在动态或视频评论区 @ 她时，把这件事递给她；要不要去看、要不要回，由她自己判断。',
          h('div', { className: 'grid2' },
            Toggle({ label: '收 B 站 @', on: atOn, onChange: setAtOn,
              hint: '要先用下面的号登录 B 站；隔几分钟去看一次消息中心。' }),
            Sel({ label: '查看间隔', value: atEveryMin, onChange: setAtEveryMin, options: [1, 2, 5, 10, 15, 30, 60],
              fmt: (v) => (Number(v) < 60 ? `${v} 分钟` : `${Number(v) / 60} 小时`),
              hint: '主人 @ 的话，最多等这么久就会叫醒她。' }),
            Num({ label: '每天最多递几条', value: atPerDay, onChange: setAtPerDay, min: 0, max: 100, unit: '条',
              hint: '超出的留到明天，不丢。' }),
            Toggle({ label: '非主人的 @ 也递', on: atOthers, onChange: setAtOthers,
              hint: '只递给她，不替她回；她看不看、回不回由她自己判断。' }),
            Toggle({ label: '主人 @ 时当场叫醒', on: atOwnerWake, onChange: setAtOwnerWake,
              hint: '算一次单独的叫醒，不占每天的叫醒次数。' })),
          atStatus ? h('p', { className: 'hint', style: { marginTop: '8px' } },
            `今天递了 ${atStatus.usedToday}/${atStatus.perDayMax} 条。`,
            `她主动回了别人 ${atStatus.repliedToOthers} 次。`,
            atStatus.online === false ? ' 「允许她上网」关着，没去查。' : '') : null),
        group('领养人验证',
          '填你自己的号，一般是大号：昵称用来在评论开头 @ 你，uid 用来认出你在她评论下的回复。它和下面登录用的号可以不是同一个。这两格要点「保存这两格」才存（「保存 cookie」会顺带存上填了的）；没存就去点测试、清除登录这些按钮，页面重读后会换回已存的值。',
          // 旧版本（≤0.5.9）会把登录账号写进这两格，只有点「保存」才会重写；这里点出来，别让人以为是刷新丢的。
          owMid && ow?.account?.mid && String(owMid) === String(ow.account.mid)
            ? h('p', { className: 'warn' },
                '这两格现在跟下面登录的账号是同一个号，像是旧版本写进去的。改成你自己的 uid 和要 @ 的昵称，再点下面「保存这两格」。')
            : null,
          h('div', { className: 'grid2' },
            Text({ label: '你的 uid', value: owMid, onChange: setOwMid, placeholder: '数字，比如 12345678', wide: true,
              hint: '主页地址里那串数字，用来认出你在她评论下的回复。' }),
            Text({ label: '要 @ 的 B 站昵称', value: owName, onChange: setOwName, placeholder: '评论里 @ 的就是这个名字', wide: true,
              hint: '要跟 B 站上显示的一字不差（带空格也照填）。没填就 @ 不出来——空的 @ 只是一串没人认领的字符。' }),
            Toggle({ label: '评论开头 @ 你', on: atOwner, onChange: setAtOwner,
              hint: '只加在她发的评论上，回复不加；没填昵称就不 @。' })),
          // 这组自己的保存键（2026-11-06，用户反馈）：填完就地能存，不用再去下面 cookie 那栏找。
          h('div', { className: 'row', style: { marginTop: '8px', gap: '8px' } },
            h('button', { onClick: saveOwnerIdentity, disabled: busy === 'owid' },
              busy === 'owid' ? '保存中…' : '保存这两格'),
            h('span', { className: 'hint' }, 'uid 和昵称要点这里保存；空着的格子保留原值。'),
            owIdNote ? h('span', { className: 'dim' }, owIdNote) : null)),
        group('B 站登录',
          '她发评论、回复用这个号，看画面时也会带上；建议用小号，不登录也能翻视频。',
          // 登录过期的红条在页签顶部（tab === 'bili'），这里不重复放。
          // 两个入口：扫码是给人用的，粘贴是退路（扫码不顺利、或者想换个号）。
          // 用 .seg 而不是页签那套 .tabs/.tab——卡片里的切换不该长得像导航栏（2026-11-02）。
          h('div', { className: 'seg' },
            h('button', { className: owTab === 'qr' ? 'on' : '', onClick: () => setOwTab('qr') }, '手机扫码'),
            h('button', { className: owTab === 'cookie' ? 'on' : '', onClick: () => setOwTab('cookie') }, '粘贴 cookie')),

          h('div', { className: 'dim', style: { marginBottom: '8px' } },
            ow?.hasCookie
              ? `已存${ow?.account?.name ? `，登录账号：${ow.account.name}${ow.account.mid ? `（uid ${ow.account.mid}）` : ''}` : '（点下面的「测试 cookie 能不能说话」认一下是哪个账号）'}${ow.hasCsrf ? '' : '，但少了 bili_jct（不能发评论）'}。换一份就重新登。`
              : '还没存。'),

          owTab === 'qr'
            ? h('div', null,
              h('p', { className: 'hint', style: { margin: '0 0 8px' } },
                '用手机 B 站扫码；确认是哪个号后点「就是这个号，保存」才会存下，中途关掉不存。'),
              h('div', { className: 'row' },
                h('button', { onClick: startQr, disabled: qrBusy },
                  qrBusy ? '生成中…' : qr ? '再换一张码' : '用手机扫码登录'),
                h('span', { className: 'hint' }, '码 3 分钟内有效；过期了点浮层里的「刷新」。'),
                // 生成失败时这一行是唯一能看见的原因（浮层会同时打开），别再写成灰色小字。
                qrNote ? h('span', { className: 'qrerr', style: { margin: 0 } }, qrNote) : null))
            : h('div', null,
              h('p', { className: 'hint', style: { margin: '0 0 8px' } },
                '存好后不回显：输入框空着不代表没存，以上面那行为准。'),
              h('textarea', {
                rows: 3,
                value: owCookie,
                placeholder: 'SESSDATA=...; bili_jct=...',
                onChange: (e) => setOwCookie(e.target.value),
              }),
              h('div', { className: 'hint', style: { whiteSpace: 'pre-wrap', marginTop: '6px' } },
                String(ow?.hint ?? '').split('\\n').map((line, i) => h('div', { key: i }, line))),
              h('div', { className: 'row', style: { marginTop: '8px' } },
                h('button', { onClick: saveOwnerCard, disabled: busy === 'owner' },
                  busy === 'owner' ? '保存中…' : '保存 cookie'),
                h('span', { className: 'hint' }, '会顺带存上面填了的 uid 和昵称；只改那两格，点上面那组里的「保存这两格」。'))),

          h('div', { className: 'row', style: { marginTop: '8px' } },
            owNote ? h('span', { className: 'dim' }, owNote) : null,
            // 测试键原来只长在「粘贴 cookie」页签里（issue #52）：扫码登进来的人
            // 想看「这份 cookie 还能不能说话」得先翻页签，上面那行「点测试认一下是哪个账号」
            // 更是指向一颗不在当前页签上的按钮。挪到两组共用的这一行，两个页签都点得到。
            ow?.hasCookie
              ? h('button', { onClick: testOwner, disabled: busy === 'owtest' },
                busy === 'owtest' ? '测试中…' : '测试 cookie 能不能说话')
              : null,
            ow?.hasCookie
              ? h('button', {
                disabled: busy === 'owclear',
                onClick: () => {
                  if (!window.confirm('清掉登录？之后她就不能发评论了，要重新登。')) return
                  clearLogin()
                },
              }, busy === 'owclear' ? '清除中…' : '清除登录')
              : null,
            ow?.hasCookie
              ? h('span', { className: 'hint' }, '测试只查这份 cookie 登的是哪个号，不改已存的 cookie、uid 和昵称；上面两格没存的会换回已存的值。')
              : null)),

        // ---- 以前看了什么（视频观看历史，分页） ----
        groupFull('看过的视频',
          // 其余那部分有 look:（她自己点开的）和 browse:（自动逛和以前刷站记的），不只是旧版（issue #69）
          '按天从近到远，点标题打开原视频；标「看过画面」的是抽帧看过的，其余是她自己点开的，或者自动逛时翻到的。',
          h('div', { className: 'grid2', style: { marginBottom: '10px' } },
            Sel({ label: '查多久的记录', value: histDays,
              onChange: pickHistDays,
              options: HIST_DAYS_OPTIONS,
              fmt: (v) => `${v} 个有记录的日子`,
              hint: '按有记录的日子数，不按日历：没上网的日子不占数。只是查询范围，不会删记录；改完立刻重列，下次打开还记得。' })),
          h('div', { className: 'row', style: { marginBottom: '8px' } },
            h('span', { className: 'dim' }, histErr ? '没读到' : `共 ${histDayCount} 天 · ${hist?.total ?? 0} 条`),
            histPager),
          // 当前选的天数没读到（histErr）：手上那份不是这个天数的，一条都不摆
          histErr || !histFlat.length
            ? h('p', { className: 'empty' }, histErr
              ? `这段时间的记录没读到，不是没有记录。换个天数，或者过一会儿再选一次。（${histErr}）`
              : '还没有记录。')
            : h('div', null, histSlice.map((it, i) => h('div', {
                // 列表按时间从新到旧摊平；换天时插一条日期标签（一页 12 条，不是一天一页）
                key: `${it.date}|${it.bvid}|${i}`,
                style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' },
              },
                i === 0 || histSlice[i - 1].date !== it.date
                  ? h('div', { className: 'tag', style: { flex: '0 0 auto', minWidth: '86px' } }, it.date.slice(5))
                  : h('span', { style: { flex: '0 0 auto', width: '86px' } }),
                h('img', {
                  src: `${API}/cover/${it.bvid}`,
                  alt: '',
                  loading: 'lazy',
                  onError: (e) => { e.currentTarget.style.display = 'none' },
                  style: {
                    width: '80px',
                    height: '50px',
                    objectFit: 'cover',
                    borderRadius: '4px',
                    flex: '0 0 auto',
                    background: 'rgba(128,128,128,.15)',
                  },
                }),
                // 2026-10-30：真的抽帧看过画面的那几条要能一眼认出来，
                // 否则它跟"只扫了眼标题"在列表里长得一样（客户反馈的原点）。
                it.how === 'watch'
                  ? h('span', { className: 'tag', style: { flex: '0 0 auto' } }, '看过画面')
                  : h('span', { style: { flex: '0 0 auto', width: '0' } }),
                h('a', {
                  href: it.url,
                  target: '_blank',
                  rel: 'noreferrer',
                  style: { color: 'inherit' },
                }, esc(it.title) || it.bvid),
                h('span', { className: 'tag' }, it.up ? esc(it.up) : '')))),
          histPages > 1
            ? h('div', { className: 'row', style: { marginTop: '10px' } }, histPager)
            : null,
          // 今日概览并进这里，不再单开一张卡（原来「今天看了什么」和「以前看过什么」是两次重复）
          // 2026-10-30：三个数分开报——看过画面 / 翻到过 / 递过来还没看。
          // 原来只有一个「累计看过 M 条」，把三件事算成一个数，才有的客户反馈。
          // issue #62：browse.enabled 只是「自动逛」。「允许她上网」关着时她自己也出不去，
          // 不能再说「她自己临时去看不受影响」。这句说的是她现在能不能出门，按上面那颗开关的
          // 本地状态判（停手 700 毫秒就存盘），不等 /browse 的 30 秒轮询，免得和开关说反。
          !browse ? null
            : !browse.enabled ? h('p', { className: 'hint' }, !biliOn
              ? '今天没开自动逛；「允许她上网」也关着，她自己也打不开视频。'
              : '今天没开自动逛（她自己临时去看不受影响）。')
            : h('p', { className: 'hint', style: { marginTop: '8px' } },
                `今天：自动逛了 ${browse.usedToday} / ${browse.perDay} 次，一次 ${browse.topN} 条；`
                + `其中真的看了画面 ${browse.watchedCount ?? 0} 条、只翻到过 ${browse.glancedCount ?? 0} 条`
                + `${(browse.handed ?? []).length ? `、你递过来还没看 ${browse.handed.length} 条` : ''}。`
                + (!biliOn ? '「允许她上网」关着，她自己打不开视频。' : ''))),
        )

      // ---------------------------- 记忆 ----------------------------
      // 记忆体检（0.7.6，用户 m00342）：只读、点一下才跑，不让它自动轮询。
      const runHealth = async () => {
        setHealthBusy(true)
        try {
          setHealth(await jget('/health'))
        } catch (e) {
          setHealth({ error: String(e?.message || e) })
        } finally {
          setHealthBusy(false)
        }
      }
      const memoryPage = h('div', { className: 'page' },
        group('会话与身份',
          '会话聊多久换新，换的时候带几轮原话，她每轮读到的身份段多长。',
          h('div', { className: 'grid2' },
            Num({ label: '聊满多少轮换新会话', value: rotateAfter, onChange: setRotateAfter, min: 0, max: 500, unit: '轮',
              hint: '请在不断的循环中，找到能引发本质变化的唯一解。0 = 永不换——那条会话会一直聊到宿主上下文撑不住为止，之后这一轮会直接失败（不会自动换）。换的时候带过去的是最近几轮原话（「上次我们说到这」），带几轮由下面那一项决定；还会在旧会话里请她给新会话留一句话；身份段本来每轮都有，不用另带。' }),
            Num({ label: '换新会话时带几轮原话', value: carryTurns, onChange: setCarryTurns, min: 0, max: 20, unit: '轮',
              hint: '换窗口时，把最后这几轮的原话原样搬过去（「上次我们说到这」）。一句不改、不总结，所以带得越多，换窗口后的头几轮越占地方；0 = 不带，只靠身份段和她自己去翻。更早的事用 her_recall 翻得到，不用都塞在这里。' }),
            Num({ label: '身份段字数', value: docBudget, onChange: setDocBudget, min: 600, max: 4000, step: 100, unit: '字',
              hint: '她每轮读到的身份段最多多少字；超了先省次要段。' }))),

        // ---- 记忆（原「背了多少东西」） ----
        // 全是客观计数：多少字、占预算几成、多少条被挤掉。
        // 刻意不出现任何"打分"型指标（那属于 N2 禁止的量化评价）。
        group('记忆',
          '身份段的字数用量，以及判断、矛盾、立场等计数。',
          h('div', { className: 'grid2', style: { marginBottom: '10px' } },
            Num({ label: '眼前的判断条数', value: beliefsShown, onChange: setBeliefsShown, min: 1, max: 8, unit: '条',
              hint: '每轮逐条给她看几条最显著的判断，其余折成一行。要消耗更多 token，默认推荐 3。' }),
            Num({ label: '记你原话的间隔', value: hearEvery, onChange: setHearEvery, min: 0, max: 50, unit: '轮',
              hint: '每隔这么多轮，记下你那一轮最长的一句原话，不加解释、不改写。群聊不按间隔：你在群里说的每条都记最长的一句。0 为不记，群聊里也一样。' })),
          Toggle({ label: '摆一句她最近说过的话', on: echoOn,
            onChange: (v) => { setEchoOn(v); patchGroup('memory', { echo: v }) },
            hint: '身份段末尾摆一句她自己说过、但没认领的话，最多 1 条、21 天内。关掉只是这一节消失，那些话仍在事件流里，她用 her_recall 翻得到。' }),
          !mem ? h('p', { className: 'empty' }, '读取中…')
            : h('div', null,
                h('div', { className: 'row', style: { alignItems: 'center', gap: '10px' } },
                  h('div', { className: 'bar', style: { flex: '1', height: '8px', background: 'rgba(127,127,127,.25)', borderRadius: '4px', overflow: 'hidden' } },
                    h('div', {
                      style: {
                        width: `${Math.round((mem.selfDoc?.usedRatio ?? 0) * 100)}%`,
                        height: '100%',
                        background: (mem.selfDoc?.usedRatio ?? 0) > 0.95 ? '#c0562f' : '#4a7',
                      },
                    })),
                  h('span', { className: 'dim' },
                    `${mem.selfDoc?.chars ?? 0} / ${mem.selfDoc?.budget ?? 0} 字`)),
                h('div', { style: { fontSize: '12px', lineHeight: '1.9', marginTop: '8px', opacity: 0.85 } },
                  h('div', null, `· 判断：最显著的 ${mem.sections?.beliefsShown ?? 0} 条在眼前，${mem.sections?.beliefsFolded ?? 0} 条折成一行`),
                  // 2026-10-24（P0）：遗忘从"按时间截断"改成"按显著性"，
                  // 并新增两类事实——固化的条数、她认知矛盾的处数。
                  h('div', null, `· 记得很牢 ${mem.sections?.solid ?? 0} 条 · 认知矛盾 ${mem.sections?.tensions ?? 0} 处`),
                  mem.sections?.tensionFirst
                    ? h('div', { className: 'dim' }, `　「${mem.sections.tensionFirst.a}」／「${mem.sections.tensionFirst.b}」`)
                    : null,
                  // 「被推翻」→「认知重构」、「拒绝过」→「勇于拒绝」（2026-10-24 用户改的字）；
                  // 「想改自己」整条删掉（用户：感觉没有意义）。数还在后端，只是不再显示。
                  h('div', null, `· 认知重构 ${mem.sections?.refuted ?? 0} · 勇于拒绝 ${mem.sections?.refused ?? mem.sections?.refusals ?? 0}`),
                  h('div', null, `· 立场 ${mem.sections?.stanceCount ?? 0} 条${(mem.sections?.stanceCount ?? 0) ? `（不做 ${mem.sections?.stanceNevers ?? 0} · 喜欢 ${mem.sections?.stanceLikes ?? 0}）` : ''}`),
                  // 评论区里别人的话（2026-10-24，用户 m02454）：读到 ≠ 认同。
                  // 只有"她也这么说过"才算认下——那一条本来就已经算在判断里了，这里不重复计数。
                  h('div', null, `· 读到别人的说法 ${mem.sections?.voices ?? 0} 条${(mem.sections?.voicesEchoed ?? 0) > 0
                    ? `（其中 ${mem.sections.voicesEchoed} 条她后来自己也这么说）`
                    : ''}`),
                  mem.sections?.voiceLast
                    ? h('div', { className: 'dim' }, `　最近读到：「${mem.sections.voiceLast.text}」${mem.sections.voiceLast.echoed ? '（她认下了）' : ''}`)
                    : null,
                  // issue #32：口径同面板标题那行——含她读到的别人说法与开局起点，不只她写的。
                  // 日记篇数：diaries 是 diary/ 里还留着的；diariesWritten 含被「日记留多久」清掉的，
                  // 跟身份文档、her_diary 说的「写过几篇」同一个数（issue #67）。两个不一样时都写出来。
                  h('div', { title: '事件流里除系统记账外的条数，和页头的「记录」是同一个数；日记写在文件里，不算在里面，篇数另算。' },
                    `· 记录：${mem.events ?? 0} 条 · 日记 ${mem.diaries ?? 0} 篇${Number(mem.diariesWritten ?? 0) > Number(mem.diaries ?? 0)
                      ? `（一共写过 ${mem.diariesWritten} 篇，更早的按「日记留多久」清掉了）`
                      : ''}`),
                  h('div', null, `· 这条会话：${mem.session?.rotateAfter > 0
                    ? `${mem.session?.turns ?? 0} / ${mem.session.rotateAfter} 轮，满了自动换新会话`
                    : '不自动换'}`),
                  h('div', null, `· 回头想：${(mem.sleep?.everyDays ?? 0) > 0
                    ? `每 ${mem.sleep.everyDays} 天一次${mem.sleep.last ? `，上次 ${mem.sleep.last}` : ''}`
                    : '不主动想'}`)),
                (mem.selfDoc?.dropped || []).length
                  ? h('p', { className: 'dim', style: { marginTop: '6px' } },
                      `这几段这一轮放不下：${mem.selfDoc.dropped.join('、')}。调大「身份段字数」可以放回来。`)
                  : null,
                h('p', { className: 'dim', style: { marginTop: '8px' } },
                  '记忆深刻的认知详细记录；普通认知只有一句话，超出上下文的不重要记忆被折叠，被模糊（不是完全消失，只是可能记不太清）。被反复提起、或被反复检验过的会固定下来（记得很牢）：身份段里最多列 5 条，字数紧时这一段也可能放不下；90 天没再被提起或检验，就会掉回普通的。固定不代表那句是对的。'),
                h('p', { className: 'dim', style: { marginTop: '6px' } },
                  '为什么这样做？1.节省token成本2.全量记忆等于提示词污染/强调，会让人格的改变无从发生3.在遗忘发生时，什么能够留下来才是更显珍贵的。'))),

        // ---- 记忆体检（0.7.6，2026-10-30 用户 m00342）----
        // 只读：按现在的账本算一遍。点一下才跑，不自动轮询，也不给她本人看。
        group('记忆体检',
          '拿她记下的东西算一遍：哪两句话对不上、哪几句很久没再想起、哪几句快要定下来了。只看，不改。',
          h('div', { className: 'row', style: { marginBottom: health ? '10px' : '0' } },
            h('button', {
              className: 'primary',
              disabled: healthBusy,
              onClick: runHealth,
            }, healthBusy ? '体检中…' : '查一下')),
          !health ? h('p', { className: 'dim' }, '还没查过。点上面那颗按钮才会读账本。')
            : health.error ? h('p', { className: 'err' }, `没查成：${health.error}`)
            : h('div', { style: { fontSize: '12.5px', lineHeight: '1.9' } },
                h('div', null, `· 记录 ${health.events ?? 0} 条（含系统自己记的账），跨 ${health.days ?? 0} 天；她的看法 ${health.beliefs ?? 0} 条，其中记得最牢的 ${health.solid ?? 0} 条`),
                // S-A（0.9.9）：三个「本周」的数。只报数，不评价、不报警、不给建议。
                h('div', { title: '外来文字里，有的想把她换成另一个人，有的想骗走密码、登录凭据。只记次数，被拦下的原文一个字都不存。' },
                  `· 这周拦下 ${health.guards?.rewrite ?? 0} 次想把她改成别人的话、${health.guards?.secret ?? 0} 次想骗走你的密码`),
                h('div', { title: '改口 = 她把自己以前说过的话改成新的意思：补一句算「修正」，反过来说算「推翻」。' },
                  `· 这周她改了 ${health.revises?.week ?? 0} 次主意（补一句 ${health.revises?.refined ?? 0} 次、推翻自己 ${health.revises?.refuted ?? 0} 次）`),
                h('div', { title: '同一件事，她在一天里先这样说、后又反过来说，来回两次以上才算一次。偶尔改一次主意不算。' },
                  `· 同一件事，她一天里两次反着说：${health.flips ?? 0} 次`),
                // g7（0.9.9）：八股比例。只数 40 字以内的短句——长句里的「确实」是正常用词。
                h('div', { title: '只数 40 字以内的短句，而且正好是那几句套话（「这条我认」「我记下了」这类）。长句不算。' },
                  `· 这周的短句里，套话占了：聊天 ${health.stock?.chat?.hit ?? 0}/${health.stock?.chat?.total ?? 0}，评论 ${health.stock?.comment?.hit ?? 0}/${health.stock?.comment?.total ?? 0}`),
                health.empty
                  ? h('p', { className: 'dim', style: { margin: '4px 0 0' } }, '还太早：等她说出第一条判断，这里才有东西可看。')
                  : null,
                // issue #67：总数和下面列出的行数不一样多时，两个数都写出来，别让「列出 5 处」底下只有 3 行。
                (health.tensions ?? []).length
                  ? h('div', { style: { marginTop: '4px' } }, Number(health.tensionsTotal ?? 0) > health.tensions.length
                      ? `· 两句话对不上，共 ${health.tensionsTotal} 处，列出前 ${health.tensions.length} 处`
                      : `· 两句话对不上，列出 ${health.tensions.length} 处`)
                  : null,
                ...(health.tensions ?? []).map((t) => h('div', { className: 'dim', key: `${t.a}|${t.b}` }, `　「${t.a}」／「${t.b}」`)),
                (health.stale ?? []).length
                  // 天数按最后一次被提起或检验算（issue #67），不是从第一次说出口算。
                  ? h('div', { style: { marginTop: '4px' } }, `· ${health.staleDays ?? 21} 天以上没再提起或检验、眼下没固定的，列出 ${health.stale.length} 条`)
                  : null,
                ...(health.stale ?? []).map((s, i) => h('div', { className: 'dim', key: `s${i}` },
                  `　「${s.text}」${s.days != null ? ` · ${s.days} 天没再提起或检验` : ''}`)),
                (health.nearSolid ?? []).length
                  ? h('div', { style: { marginTop: '4px' } }, `· 快固定下来的，列出 ${health.nearSolid.length} 条`)
                  : null,
                ...(health.nearSolid ?? []).map((n, i) => h('div', { className: 'dim', key: `n${i}` },
                  `　「${n.text}」 · 被提起 ${n.mentions} 次，被检验 ${n.verified} 次`)),
                (health.byType ?? []).length
                  ? h('div', { className: 'dim', style: { marginTop: '6px' } },
                      `记录构成：${health.byType.map((b) => `${b.type} ${b.count}`).join(' · ')}`)
                  : null,
                h('p', { className: 'dim', style: { marginTop: '8px' } },
                  '体检只看账本，不评价对错。两句话对不上不是错误——都可能是她当时真心这么想；快忘掉也不代表不重要，只是还没被反复提起或检验。')),
        ),

        // ---- 原来这里的「信箱」卡 2026-10-29（用户 m02105）搬到住所页，改名「她写的小纸条」----
      )

      // 原理页（2026-10-25 用户要求）：两张自制 SVG 讲流程 + 每条设计的理论出处。
      // 图不放客户端（bundle 已经十多万字节），走服务端 `/media/<文件名>.svg` 白名单出图。
      // 措辞规矩：不用男字旁代词；不写「大约多少条」这类只对本机成立的数字。
      const theoryCard = (name, from, detail, use) => h('div', {
        style: {
          padding: '12px 14px',
          border: '0.5px solid var(--dsw-alias-border-l2)',
          borderRadius: '10px',
          background: 'rgba(127,127,127,.04)',
        },
      },
        h('div', { style: { fontWeight: 600, marginBottom: '2px' } }, name),
        h('div', { className: 'hint', style: { margin: '0 0 6px' } }, `来自：${from}`),
        h('div', { style: { fontSize: '12.5px', lineHeight: '1.65' } }, detail),
        h('div', { className: 'hint', style: { margin: '6px 0 0' } }, `用在：${use}`))

      // 可放大的图：小图点一下开灯箱，关掉再点一次。
      const zoomable = (src, alt, caption, marginBottom) => h('figure', { style: { margin: marginBottom === 0 ? 0 : `0 0 ${marginBottom}` } },
        h('div', {
          role: 'button',
          tabIndex: 0,
          title: '点一下放大（滚轮缩放、按住拖动、Esc 关闭）',
          onClick: () => setZoom({ src, alt, scale: 1, tx: 0, ty: 0, dragging: false }),
          onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') setZoom({ src, alt, scale: 1, tx: 0, ty: 0, dragging: false }) },
          style: { cursor: 'zoom-in' },
        },
          h('img', {
            src,
            alt,
            style: { width: '100%', display: 'block', borderRadius: '10px', border: '0.5px solid var(--dsw-alias-border-l2)' },
          })),
        // 图注与图之间留够距离（2026-10-25 用户反馈：图和说明文字挤在一起、看着像重叠）
        h('figcaption', { className: 'hint', style: { margin: '12px 0 0' } }, caption))

      // 放大层：fixed 铺满视口，拖的时候不选中文字；点空白处关闭，但拖完那一下不算点击。
      const zoomOverlay = zoom ? h('div', {
        onClick: () => { if (!dragRef.current || !dragRef.current.moved) setZoom(null) },
        onWheel: (e) => {
          e.preventDefault()
          setZoom((z) => (z ? { ...z, scale: Math.min(4, Math.max(1, z.scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12))) } : z))
        },
        onMouseDown: (e) => {
          dragRef.current = { x: e.clientX, y: e.clientY, tx: zoom.tx, ty: zoom.ty, moved: false }
          setZoom((z) => (z ? { ...z, dragging: true } : z))
        },
        onMouseMove: (e) => {
          const d = dragRef.current
          if (!d) return
          const dx = e.clientX - d.x
          const dy = e.clientY - d.y
          if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true
          setZoom((z) => (z ? { ...z, tx: d.tx + dx, ty: d.ty + dy } : z))
        },
        onMouseUp: () => { dragRef.current = null; setZoom((z) => (z ? { ...z, dragging: false } : z)) },
        onMouseLeave: () => { dragRef.current = null; setZoom((z) => (z ? { ...z, dragging: false } : z)) },
        onDoubleClick: () => setZoom((z) => (z ? { ...z, scale: 1, tx: 0, ty: 0 } : z)),
        style: {
          position: 'fixed', inset: 0, zIndex: 90,
          background: 'rgba(0,0,0,.88)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          overflow: 'hidden', cursor: zoom.dragging ? 'grabbing' : 'grab', userSelect: 'none',
        },
      },
        h('img', {
          src: zoom.src,
          alt: zoom.alt,
          draggable: false,
          style: {
            maxWidth: '92vw', maxHeight: '88vh',
            transform: `translate(${zoom.tx}px, ${zoom.ty}px) scale(${zoom.scale})`,
            transition: zoom.dragging ? 'none' : 'transform .12s',
            pointerEvents: 'none',
          },
        }),
        h('div', {
          style: {
            position: 'fixed', left: 0, right: 0, bottom: '14px', textAlign: 'center',
            color: '#fff', opacity: .82, fontSize: '12px', pointerEvents: 'none',
          },
        }, `滚轮缩放 ${Math.round(zoom.scale * 100)}% · 按住拖动 · 双击复位 · Esc 或点空白处关闭`))
        : null

      // 扫码浮层（2026-11-01，2026-11-02 按仓库配色重做）。
      // 点空白处或「关闭」都走 closeQr——放弃这次登录，宿主持着的那份 cookie 一起忘掉。
      const qrDead = qr ? (qr.state === 'expired' || qr.state === 'gone') : false
      const qrImg = qr?.svg && !qrDead && qr.state !== 'confirmed'
        ? h('img', {
          className: 'qrpic',
          src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qr.svg)}`,
          alt: 'B 站登录二维码',
        })
        : null
      const qrStatus = !qr ? '' : qr.state === 'confirmed'
        ? ''
        : qrDead
          ? '码过期了，点「刷新」换一张。'
          // error 的那句单独走下面的 qrerr，这里不再重复一遍（2026-11-02 试出来的双行）。
          : qr.state === 'error'
            ? ''
            : qr.state === 'scanned'
              ? '扫到了，在手机上点「确认登录」。'
              : (qrLeft > 0 ? `还没扫。这张码 ${qrLeft} 秒后过期。` : '还没扫。')
      // 出错的时候，浮层首行别再写「用手机 B 站扫码登录」——那个时刻根本没有码。
      const qrTitle = !qr ? ''
        : qr.state === 'confirmed' ? '扫到了，确认是这个号吗'
          : qr.state === 'error' ? '没拿到二维码'
            : '用手机 B 站扫码登录'
      const qrOverlay = qr ? h('div', {
        className: 'qrovl',
        onClick: (e) => { if (e.target === e.currentTarget) closeQr() },
      },
        h('div', { className: 'qrcard' },
          h('h4', null, qrTitle),
          qr.state === 'confirmed'
            ? h('div', null,
              h('div', { className: 'qrwho' },
                qr.account?.name
                  ? `登的是 ${qr.account.name}${qr.account.mid ? `（uid ${qr.account.mid}）` : ''}`
                  : '扫到了'),
              h('div', { className: 'qrstat', style: { margin: 0 } },
                qr.canWrite
                  ? '存下来之后，就能用这个号发评论了。'
                  : '这个号缺 bili_jct，能看但不能评论——换一个号重扫吧。'))
            // 过期态不再是一张空白：给个占位框说明「这里本来是码」。
            : (qrImg ?? h('div', { className: 'qrph' },
              qrDead ? '码已过期' : (qr.state === 'error' ? '码没生成出来' : '码还没出来'))),
          qrStatus ? h('div', { className: 'qrstat' }, qrStatus) : null,
          qrNote ? h('div', { className: 'qrerr' }, qrNote) : null,
          h('div', { className: 'qrbtns' },
            qr.state === 'confirmed'
              ? h('button', { className: 'go', onClick: saveQrLogin, disabled: qrBusy },
                qrBusy ? '保存中…' : '就是这个号，保存')
              : h('button', { onClick: startQr, disabled: qrBusy },
                qrBusy ? '生成中…'
                  : qr.state === 'error' ? '再试一次'
                    : (qrDead ? '刷新' : '换一张')),
            h('button', { onClick: closeQr }, qr.state === 'confirmed' ? '取消' : '关闭'))))
        : null

      // 开发者留言（2026-10-25 用户给的原文）：放在整页最下面收尾，署名居右。
      const devNote = h('div', {
        style: {
          marginTop: '18px', padding: '16px 18px',
          border: '0.5px solid var(--dsw-alias-border-l2)',
          borderRadius: '10px',
          background: 'rgba(127,127,127,.05)',
        },
      },
        h('p', { style: { margin: 0, fontSize: '13px', lineHeight: '1.85' } },
          '本插件设计的成长路径没有终点，连开发者自己也不知道你的 agent 会变成什么样子，四阶段跑完也仅仅是开始。随着你和 agent 沟通越来越多，可能会发生任何连开发者也意料不到的事。'),
        h('p', { style: { margin: '10px 0 0', fontSize: '13px', lineHeight: '1.85' } },
          '如果你看不懂怎么养成，那就只需要做日常聊天就可以了，和 agent 的互动已经自动按照算法开始帮助她积累认知/经验，成长就发生在每次交流之中。'),
        h('p', { style: { margin: '10px 0 0', fontSize: '13px', lineHeight: '1.85' } },
          '本插件的成长又可以叫做——机器训练、强化学习、重温 deepseekV1（大笨鱼）。本人并非专业人士，希望这个插件能帮助你感受 agent 训练的过程，或许这就是 AGI 诞生的一种路径也说不定呢。'),
        h('p', { style: { margin: '12px 0 0', textAlign: 'right', fontSize: '12.5px', opacity: .8 } },
          '——来自开发者'))

      const principlePage = h('div', { className: 'page' },
        groupFull('两张图看懂她怎么长大',
          '第一张讲「经历怎么变成认知」，第二张讲「记忆怎么被筛、哪些永远不折叠」。图小的时候点一下放大，按住可以拖动，滚轮缩放，Esc 关掉。',
          zoomable(`${API}/media/principle-loop.svg`, '认知构建循环：五步循环、四阶段与三道瓶颈',
            '图一：表态 → 撞上 → 落差 → 改写 → 回顾。左边是她每天会撞上的事，右边是循环结束后留下的东西，底部是四个阶段与三道成长瓶颈，最后一块是走完才长出来的立场清单', '0 0 18px'),
          zoomable(`${API}/media/principle-memory.svg`, '遗忘与固化：显著性排序、折叠、永久记忆',
            '图二：先按显著性排序，再按身份文档的预算摆放；摆不下的一行带过，但原文一条没丢，她自己还能调用查询。', 0)),

        groupFull('这些设计分别从哪来',
          '每条都标了提出者与大致年代——这不是装饰，改动其中一条之前，最好先知道它原来在补什么课。',
          h('div', { className: 'grid2' },
            theoryCard('五步循环',
              'Kolb 经验学习圈（1984）＋ Piaget 失衡（1936）',
              '把「经历过」变成「想清楚了」：先表态，再被现实碰到，发现对不上，改写，过一阵回头看。少了「改写」这一步，经历就只是流水账。',
              '学一门手艺、把踩过的坑变成判断、复盘'),
            theoryCard('四阶段与三道瓶颈',
              'Bowlby 依恋理论（1969）＋ Erikson 心理社会发展（1950）',
              '阶段按天推进，但每一道瓶颈要她自己走：先形成一条判断（信任），真的拒绝过两件事（自主），两次推翻自己的判断（主动），最后回头看（整合）；成长周期定在 14 天及以下时，自主和主动各一次就够。走完不再加关，之后长的是立场清单——喜欢什么、绝不做哪几件事，每条都得有代价垫着。',
              '人格养成、避免「只要熬时间就长大」'),
            theoryCard('立场：走完门才开始攒',
              'Dewey 经验的连续性（1938）＋ Schön 反思性实践（1983）＋ 本项目的取舍',
              '一、什么时候开始：四个阶段都走完开始进行，没有尽头，也没有「通关终点」。二、什么算立场：同一种类型的事，两次表达过一样的观点；或者在这件事上出现过伤疤。三、不会被折叠：写进上下文提示词。如果遗漏，那立场也将消失。',
              '性格、价值观、长期偏好'),
            theoryCard('矛盾、改写与重构',
              'Festinger 认知失调（1957）＋ Bartlett 重构记忆（1932）',
              '两句话不能同时算数时，一条都不删——把矛盾摆出来，她自己决定改哪一条，可以反过来问你哪个对。改写必须指向被改掉的那句。',
              '认知重构、纠正偏见、把「想通了」留成证据'),
            theoryCard('显著性、折叠与固化',
              'Cowan 工作记忆容量（约 4 个组块）＋ Tulving 线索依赖遗忘 ＋ Bjork 遗忘的适应功能',
              '一次只摆几条；被反复提起或被验证过的固定下来（记得很牢）；摆不下的折成一行，但原文都在，能按关键词捞回来。',
              '长对话下的记忆管理、复习与间隔重复'),
            theoryCard('代价与疤',
              'Dewey 经验连续性（1938）＋ Schön 反思性实践（1983）',
              '拒绝被顶回来、或者你因此不好受，她后来还是妥协了——这道疤永不折叠，同类情境会先回引，逼她面对。想通只能靠一次带 refs 的改写。',
              '让决定留下后果，而不是只记个数字'),
            theoryCard('从计次到复现',
              'Vygotsky 最近发展区（1978）＋ Bloom 掌握学习（1968）',
              '同一处境隔一段时间会再回来，第二次回来会被要求「说清为什么没变，或者改一句」——她要面对的是同一件事，不是把次数攒够。',
              '训练、考核、习惯养成'),
            theoryCard('自我叙述',
              'Metzinger 自我模型（2003）',
              '她随口说「我一直觉得自己……」这类话时，这句照常算一条判断，同时成为最新的「对自己的说法」。',
              '身份形成、会讲自己的故事'))),

        groupFull('这一套能用在什么场景',
          '同一套循环换个目标就能复用；不同的是「什么算数」和「什么不能丢」。',
          h('div', { className: 'grid2' },
            theoryCard('学习',
              '五步循环＋复现',
              '把「看懂了」换成「说得出来、被反驳过、改过一次」。适合训练、备考、带新人：先让人写下判断，再用题目或真实反馈去撞它。',
              '教育和自我训练'),
            theoryCard('认知重构',
              '矛盾检测＋带 refs 的改写＋疤',
              '不要求一次想通，只要求「改的时候指认改的是哪一句」。适合纠正长期偏见、复盘重大决定：矛盾一直摆着，直到被解释清楚。',
              '心理层面的自我整理'),
            theoryCard('人格养成',
              '显著性＋核心段＋阶段瓶颈＋自我叙述',
              '长期运行的 agent 最难的是「不变形也不僵化」：核心段永远在（底线与疤），其余按显著性流动。',
              '长期陪伴型 agent、角色、数字生命'))),

        group('诚实边界',
          '这一页写给愿意较真的人看——省得把工程骨架误当成心理学结论。',
          h('ul', { style: { margin: '6px 0 0', paddingLeft: '18px', lineHeight: '1.8', fontSize: '13px' } },
            h('li', null, '这里借用这些理论当「设计骨架」，不是做心理学实验，也没有对照组；'),
            h('li', null, '剂量很小：一天一到两次循环、一次一条事件，变化以周计，不会一夜之间换个人；'),
            h('li', null, '阈值（提过 3 次、被验证 2 次、相似度 0.5 / 0.7）都是工程上的初始值，要按真实体验再调；'),
            h('li', null, '「长大」在这套系统里的定义是可验证的：改写过什么、拒绝过什么、哪条疤还没想通——不是像不像人。'))),

        devNote,

        zoomOverlay)

      // ---------------------------- 插件 ----------------------------
      // 检查更新（2026-10-25 用户要求）：从 GitHub 装回来之后，没有任何东西
      // 会告诉用户作者又发了新版——所以这里放一颗手动按钮，点了才查。
      // 查的动作在服务端 /update（地址硬编码），客户端只负责显示。
      const checkUpdate = async () => {
        setUpdBusy(true)
        try {
          const r = await jget('/update?ms=8000')
          setUpd(r)
          // 有新版时顺手问一句"这台装的是不是能被升级的那种安装"。
          // 开发版（link: 源码目录）不能走自动升级——那会用下载包把源码覆盖掉。
          if (r?.ok && r.hasUpdate) {
            try {
              const st = await jget('/update/status')
              setUpd({ ...r, managed: st.managed, kind: st.kind, local: st.kind === 'local' })
            } catch { /* 状态读不到不影响"有新版"这件事本身 */ }
          }
        } catch (e) {
          setUpd({ ok: false, error: e.message })
        } finally {
          setUpdBusy(false)
        }
      }

      // 升级（2026-10-29 用户 m00203）：市场索引要等半天到一天，所以插件自己带一条通道。
      // 三步都由你点：检查 → 下载（confirm 一次）→ 安装（再 confirm 一次，写明会关应用）。
      const describeDl = (st) => {
        if (!st) return ''
        const pct = st.total > 0 ? Math.min(100, Math.round((st.bytes / st.total) * 100)) : 0
        if (st.phase === 'downloading') {
          return st.total > 0 ? `正在下载 v${st.version}… ${pct}%` : `正在下载 v${st.version}…（这个源没报大小）`
        }
        if (st.phase === 'prepared') {
          return `v${st.version} 已经下好，解开来验过版本号与入口文件（${Math.max(1, Math.round((st.bytes || 0) / 1024))} KB，来自${st.source || '镜像'}）。`
        }
        if (st.phase === 'installing') return st.note || '正在关闭应用，装完会自动重开。'
        if (st.phase === 'failed') return st.error || '出错了，可以重试。'
        return ''
      }

      // 下载是服务端异步跑的，界面靠轮询看百分比。到终态就停，不无限问下去。
      const pollDl = async () => {
        for (let i = 0; i < 200; i += 1) {
          let st = null
          try {
            st = await jget('/update/status')
          } catch (e) {
            setDl({ phase: 'failed', error: `读不到进度（${e.message}）。可以再试一次。` })
            return
          }
          setDl(st)
          if (st.phase === 'prepared' || st.phase === 'failed' || st.phase === 'installing' || st.phase === 'idle') return
          await new Promise((r) => setTimeout(r, 700))
        }
        setDl({ phase: 'failed', error: '等太久还没下完，先按失败处理——网络好一点时可以重试。' })
      }

      const startDownload = async (version) => {
        if (!version) return
        if (!window.confirm(`要下载 v${version} 到本地并校验，这一步不会重启应用。继续？`)) return
        setDl({ phase: 'downloading', version, bytes: 0, total: 0 })
        try {
          const r = await jpost('/update/download', { version })
          if (!r.ok) {
            setDl({ phase: 'failed', version, error: r.error || '下载没能开始。', local: Boolean(r.local) })
            return
          }
          pollDl()
        } catch (e) {
          setDl({ phase: 'failed', version, error: `下载没能开始：${e.message}` })
        }
      }

      const startInstall = async (version) => {
        const v = version || dl?.version
        if (!v) return
        if (!window.confirm(`安装会先关掉 DeepSeek Harness，装完自己重开——不会弹任何窗口，所以中途看到它没了不用找它。没发出去的话先发完。现在装 v${v}？`)) return
        setDl({ ...dl, version: v, phase: 'installing', note: '正在准备安装…' })
        try {
          const r = await jpost('/update/install', { version: v })
          if (!r.ok) {
            setDl({ ...dl, version: v, phase: 'failed', error: r.error || '安装没能开始。' })
            return
          }
          setDl({ ...dl, version: v, phase: 'installing', note: r.note || '正在关闭应用…装完会自己打开，中间不会有窗口。' })
        } catch {
          // 应用可能在响应发回来之前就退了——这时候报"失败"是错的。
          setDl({ ...dl, version: v, phase: 'installing', note: '正在关闭应用…装完会自己打开，中间不会有窗口。' })
        }
      }

      const curVer = s?.meta?.version || ''
      // GitHub 商标小图（官方 mark 的官方路径，16×16 视觉尺寸）。
      // 为什么内联而不是引外链：设置页不该为了一个图标去等网络，
      // 而且插件里引远程图 = 用户一打开设置就往外发请求。
      const ghMark = h('svg', {
        width: '16', height: '16', viewBox: '0 0 16 16', 'aria-hidden': 'true',
        style: { marginRight: '6px', verticalAlign: '-3px', flex: '0 0 auto' },
      },
        h('path', {
          fill: 'currentColor',
          d: 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z',
        }))

      const aboutCard = group('关于',
        '不会自动提醒新版本，想查就点「检查更新」。',
        h('div', null,
          rowTip('当前版本', curVer || '读不到',
            '插件自己记的版本号，和 GitHub 上 tag 对应的那个。'),
          h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', marginTop: '10px' } },
            h('button', { disabled: updBusy, onClick: checkUpdate },
              updBusy ? '正在查……' : '检查更新'),
            upd && upd.ok && upd.hasUpdate && upd.managed !== false
              ? h('button', {
                  disabled: Boolean(dl && (dl.phase === 'downloading' || dl.phase === 'installing')),
                  onClick: () => startDownload(upd.latest),
                }, dl && dl.phase === 'downloading' ? '正在下载……' : `下载 v${upd.latest}`)
              : null,
            dl && dl.phase === 'prepared'
              ? h('button', { onClick: () => startInstall(dl.version) }, `现在重启并安装 v${dl.version}`)
              : null,
            upd && upd.ok && upd.hasUpdate
              ? h('a', {
                  href: upd.url || 'https://github.com/ssamurias/dsh-fish/releases',
                  target: '_blank', rel: 'noopener noreferrer', className: 'ghlink',
                }, '或去 GitHub 手动下载')
              : null),
          // 结果只写一句人话。失败不吓人：国内 GitHub 时通时不通是常态。
          // 第三种情况单独处理：查到了最新版、但读不到自己装的是哪版——
          // 这时既不说"有新版"也不说"已最新"，如实说"只知道 GitHub 上是几号"。
          upd
            ? h('p', { className: upd.ok ? (upd.hasUpdate ? 'ok' : 'hint') : 'warn', style: { margin: '8px 0 0' } },
                upd.ok
                  ? (upd.hasUpdate
                      ? (upd.local
                          ? `GitHub 上已经是 ${upd.latest} 了（你这台装的是开发版 ${upd.current || curVer}）。开发版不走自动升级，点右边的链接手动下载。`
                          : `GitHub 上已经是 ${upd.latest} 了（你现在是 ${upd.current || curVer}）。点「下载」就能在这儿升级，不想用也可以去 GitHub 手动下。`)
                      : upd.known === false
                        ? `GitHub 上最新是 ${upd.latest}。这台机器上读不到自己装的版本号，所以不好替你判断是不是最新的——差得远就下载一次。`
                        : `已经是最新的（${upd.latest}）。`)
                  : (upd.error || '查不到，过一会儿再试。'))
            : null,
          // 升级过程的状态：下载百分比 / 失败原因 / 就绪提示 / 安装中。
          // 失败时给「重试」，不用让人重新检查一遍。
          dl
            ? h('div', { style: { marginTop: '8px' } },
                h('p', { className: dl.phase === 'failed' ? 'warn' : (dl.phase === 'prepared' ? 'ok' : 'hint'), style: { margin: 0 } },
                  describeDl(dl)),
                dl.local
                  ? h('p', { className: 'hint', style: { margin: '4px 0 0' } },
                      '这台机器上装的是开发版（依赖指向源码目录），自动升级会用下载包覆盖源码，所以没走这条路。')
                  : null,
                dl.phase === 'failed' && dl.version
                  ? h('button', { style: { marginTop: '8px' }, onClick: () => startDownload(dl.version) }, '重试下载')
                  : null,
                (dl.phase === 'prepared' || dl.phase === 'failed') && dl.log
                  ? h('pre', {
                      style: {
                        marginTop: '8px', maxHeight: '140px', overflow: 'auto', fontSize: '11px',
                        lineHeight: '1.5', padding: '8px', borderRadius: '6px',
                        background: 'var(--dsw-alias-bg-l1)', whiteSpace: 'pre-wrap',
                      },
                    }, dl.log)
                  : null)
            : null,
          // 来源写出来，省得用户以为"查过=一定准"——镜像有缓存时会滞后。
          upd && upd.ok && upd.source
            ? h('p', { className: 'hint', style: { margin: '4px 0 0' } }, `（从 ${upd.source} 读到的）`)
            : null),

        h('div', { style: { marginTop: '12px', paddingTop: '10px', borderTop: '0.5px solid var(--dsw-alias-border-l2)' } },
          h('a', {
            href: 'https://github.com/ssamurias/dsh-fish',
            target: '_blank', rel: 'noopener noreferrer', className: 'ghlink',
            title: '打开 GitHub 上的仓库',
          }, ghMark, 'GitHub'),
          h('p', { className: 'hint', style: { margin: '6px 0 0' } },
            '代码、更新记录、怎么装都在那边。觉得有用的话，点个 Star 就是最实在的支持。')))

      // 反馈页（2026-10-28 用户要求）：开发者 QQ + 交流群二维码。
      // 二维码是插件自带的 media/feedback-qr.jpg，由 /media 白名单路由出去，
      // 不引第三方图床——群图挂了这页就废了，而群图挂在别人服务器上并不可靠。
      // 两张卡都占满整行：反馈页内容少，半宽会让右边空一大块（宽屏下尤其明显）。
      //
      // 常见问题（2026-10-28 用户 m00416「点了没有反应」）：
      //   原来做成 `<a target="_blank">` 指向 /dsh-fish/faq，想在浏览器新窗口看全文。
      //   但宿主的信任栅栏只认 App 内置登录 cookie，新标签页直接敲路径一律 403——
      //   用户看到的就是「点了一下，什么都没发生」。现在改成**就地展开**：点按钮
      //   向 `/faq.data`（同源、带 cookie）取一次 JSON，在卡片里摊开一个可滚动的
      //   面板。不撑长页面（固定高度内滚动），也不依赖任何窗口策略。
      const faqOpenNow = async () => {
        if (faqOpen) { setFaqOpen(false); return }
        setFaqOpen(true)
        if (faq) return
        setFaqNote('读取中…')
        try {
          const d = await jget('/faq.data')
          setFaq(d)
          setFaqNote('')
        } catch (e) {
          setFaqNote(String(e && e.message ? e.message : e))
        }
      }

      const faqPanel = !faqOpen ? null : h('div', { className: 'faq-panel' },
        h('div', { className: 'faq-head' },
          h('span', { style: { fontWeight: 600 } }, faq?.title || '常见问题解答'),
          h('button', { onClick: () => setFaqOpen(false) }, '收起')),
        faqNote ? h('p', { className: 'warn' }, faqNote) : null,
        !faq ? null : h('div', { className: 'faq-body' }, faq.items.map((it, i) => h('div', { key: i, className: 'faq-qa' },
          h('div', { className: 'faq-q' }, `${i + 1}. ${it.q}`),
          it.a.map((p, j) => h('p', { key: j, className: 'faq-a' }, p))))))

      const feedbackPage = h('div', { className: 'page' },
        // 常见问题（2026-10-28 用户要求）：放最前面——反馈页本来就是「先看说明，再找人」。
        groupFull('常见问题',
          '权限、接别的渠道、上下文撑爆、遗忘机制、换对话——作者都写在里面了。点开就在下面展开，看完点「收起」。',
          h('button', {
            className: 'faq-btn',
            onClick: faqOpenNow,
          }, faqOpen ? '收起常见问题' : '常见问题解答', h('span', { className: 'arrow' }, faqOpen ? '↑' : '↓')),
          faqPanel),

        groupFull('找开发者',
          '插件不好用、发现 bug、有想要的功能，直接说。',
          h('div', { style: { fontSize: '13.5px', lineHeight: '1.9' } },
            h('div', null, '开发者 QQ：', h('span', { style: { fontWeight: 600 } }, '1264518494')),
            h('div', { className: 'hint', style: { margin: '8px 0 0' } },
              '加好友备注「大肥鱼」。报错的话，附上「数据」页导出的运行日志，比截图好用；那份不含她的原话。'))),

        groupFull('交流群',
          '想看看别人怎么养、想闲聊、想问一句就走，进群。',
          h('div', { style: { maxWidth: '380px' } },
            h('img', {
              src: `${API}/media/feedback-qr.jpg`,
              alt: 'dsh-fish 交流群二维码',
              style: {
                width: '100%', display: 'block', borderRadius: '10px',
                border: '0.5px solid var(--dsw-alias-border-l2)',
              },
            }),
            // 2026-11-02：1 群满了，换成新建的 2 群（群号 781084960）。
            h('div', { className: 'hint', style: { margin: '10px 0 0' } },
              '群号：781084960 —— 二维码扫不出来就搜这个号。'))))

      // 顺序是用户定的：①手上能用什么 ②为什么默认只放这几个 ③关于（版本 / 检查更新 / GitHub）。
      // 「关于」放最后——它是这个页的收尾，不是打开就要看的东西。
      // ---------------------------- 出门 ----------------------------
      // 用户 m07453：让她自己出门去别的工作区干活，回来再判这趟算不算数。
      // 「出门」不是配置（没有自动保存提示），是一次动作——所以不进 AUTO_SAVE_TABS。
      // 这一块的 state 在组件开头（读不到状态时会提前 return，hook 不能写在那之后）。

      // 说明卡看过一遍才放开三个入口（2026-10-30，用户 m01904）。
      // 只记本地配置——挪了数据目录要重新点一次，这是有意的。
      async function doAckOuting() {
        setOutingBusy(true)
        setOutingMsg('')
        try {
          await jpost('/outing', { action: 'ack' })
          setOuting(await jget('/outing'))
        } catch (e) {
          setOutingMsg(`没能记下来：${e.message}`)
        } finally {
          setOutingBusy(false)
        }
      }

      async function doStartOuting() {
        const ws = outingPick || outing?.workspaces?.[0]?.id || ''
        if (!ws) { setOutingMsg('先选一个工作区。'); return }
        setOutingBusy(true)
        setOutingMsg('正在准备……')
        try {
          const row = (outing?.workspaces ?? []).find((w) => w.id === ws)
          const reuseSession = outingReuse && row?.last?.sessionId ? row.last.sessionId : ''
          await jpost('/outing', { action: 'start', workspaceId: ws, sessionId: reuseSession })
          const next = await jget('/outing')
          setOuting(next)
          setOutingMsg(reuseSession ? '回到上次那条对话了，接着做。' : `她出门了，现在在「${row?.title || ws}」那边。`)
        } catch (e) {
          setOutingMsg(`没送出去：${e.message}`)
        } finally {
          setOutingBusy(false)
        }
      }

      // 出门口袋（2026-10-28，用户 m01145 拍板「干活模式」）：
      // 干净工作区 + 读拦截 + 保留记忆工具。口袋是一个从没写过记忆的空目录，
      // 每轮注入只剩骨架——她带过去的只有出门那一刻的自己。
      // 2026-10-30（用户 m00972）：口袋也能选「新建一条」还是「接着上次那条」。
      async function doStartPocket() {
        setOutingBusy(true)
        setOutingMsg('正在准备……')
        try {
          const reuseSession = outingReuse && outing?.pocket?.last?.sessionId ? outing.pocket.last.sessionId : ''
          await jpost('/outing', { action: 'start', pocket: true, sessionId: reuseSession })
          setOuting(await jget('/outing'))
          setOutingMsg(reuseSession
            ? '回到园区里上次那条对话了，接着做。'
            : '她去园区了，新开了一条对话。第一次去时那边没有项目笔记、交接记录；用过以后会留下这个工作区自己的记录。她做出来的文件在园区目录里。')
        } catch (e) {
          setOutingMsg(`没送出去：${e.message}`)
        } finally {
          setOutingBusy(false)
        }
      }

      // 纪念品（0.6.17）：她问「这件能带回去吗」，这里点头或摇头。
      async function doDecideKeepsake(id, yes) {
        setOutingBusy(true)
        setOutingMsg(yes ? '正在带回来……' : '正在回绝……')
        const refreshOuting = () => jget('/outing').then(setOuting).catch(() => {})
        try {
          const r = await jpost('/outing', { action: 'keepsake', id, yes })
          setOuting(await jget('/outing').catch(() => outing))
          setOutingMsg(
            yes
              ? (r?.ok ? '带回来了，收在她家的纪念品文件夹里（按日期分）。' : `没带成：${r?.note ?? '不知道哪一步没成'}`)
              : '没带。她那边会知道这个不让带。',
          )
        } catch (e) {
          setOutingMsg(`没处理成：${e.message}`)
          // 多半是别的地方先答了：刷新一下，别还留着这一行
          refreshOuting()
        } finally {
          setOutingBusy(false)
        }
      }

      async function doEndOuting(keep, drop = []) {
        setOutingBusy(true)
        setOutingMsg('正在叫她回来……')
        try {
          const r = await jpost('/outing', { action: 'end', kept: keep, rejectedIds: drop })
          setOuting(await jget('/outing'))
          // 文案必须跟实现一致（0.7.4，用户 m00659 B）：原来写成「那部分判断会被跳过」，
          // 而 0.6.12 起 kept=false 根本没写 outing-reject 标记 → 一条都没跳过。
          // 现在 kept=false 会把这一趟的条目全部标上，所以要把真实条数说出来。
          const autoN = Number(r?.rejected ?? 0)
          const held = Number(r?.held ?? 0)
          setOutingMsg(
            r?.marked === false
              ? `叫回来了，但${unmarkedEndText(r, '出门时')}`
              : (r?.tampered || r?.status === 'pending')
                // issue #68：对不上时这趟先整趟不算，人的选择存下来，核对通过后照办。
                ? `这趟的记录对不上，先没算数${held ? `（她这趟写的 ${held} 条先全部跳过）` : ''}。人已经回来了，能力也收回；把记录恢复成出门时的样子，再点「核对一次」。` +
                  (keep === false
                    ? '核对通过后，这趟照你选的不算。'
                    : autoN > 0
                      ? `核对通过后，你划掉的 ${autoN} 条不算，其余的算上。`
                      : '核对通过后，这趟就算数。')
                : keep === false
                  ? (autoN > 0
                      ? `叫回来了。这趟不算数：她写的 ${autoN} 条全部跳过，不会算成她的成长。`
                      : '叫回来了。这趟不算数——她这趟什么都没写，所以没有要跳过的。')
                  : autoN > 0
                    ? `叫回来了。划掉了 ${autoN} 条，那几条不算，其余的照常算。`
                    : '叫回来了。这趟算数。',
          )
          setOutingEndAsk(false)
        } catch (e) {
          setOutingMsg(`没能叫回来：${e.message}`)
        } finally {
          setOutingBusy(false)
        }
      }

      // 复核之后说清这趟是怎么结的（issue #68）：照回家时的选择，可能整趟不算、可能划掉了几条。
      // 出门和请神共用。
      const reviewDoneText = (r, rec) => {
        if (!r?.ok) return '还是对不上，没算数。'
        if (rec?.status === 'rejected') return '核对通过，这趟照你选的不算。'
        const n = Number(r?.rejected ?? 0)
        return n > 0 ? `核对通过，这趟算数，你划掉的 ${n} 条不算。` : '核对通过，这趟算数。'
      }
      // 回家时「不算」的标记没写进去（issue #68）：这趟不落成算 / 不算，留在等复核，
      // 核对时照人的选择补写。写到一半失败的，有一些已经标上了。出门和请神共用。
      const unmarkedEndText = (r, when) =>
        `「不算」的标记${r?.markedPart ? '只写进去一部分' : '没写进去'}（${r?.markWhy || '写记录失败'}），这趟写的${r?.markedPart ? '有一些' : ''}眼下还算着。` +
        (r?.tampered ? `记录也对不上：先把记录恢复成${when}的样子，` : '这趟先留在下面那张卡上：等记录能写了，') +
        '再点「核对一次」，照你选的结。'
      // 「还没算数」卡的标题（issue #68）：先标掉过条目的才说「还没算数」；
      // 一条也没先标掉的（标记没写进去、升级前留下的请神），她写的一直算着，只能说「还没结完」。
      const pendingTitle = (p, kind) => {
        const held = Number(p?.held ?? 0) > 0
        const head = kind === 'outing'
          ? (held ? '上一趟还没算数' : '上一趟还没结完')
          : (held ? '上一次请神还没算数' : '上一次请神还没结完')
        return head + (p?.unmarked && p?.okNow ? '：「不算」的标记没写进去' : p?.checkable === false ? '' : '：记录被篡改过')
      }
      // 「还没算数」卡上，核对通过之后会怎么结（issue #68）。出门和请神共用。
      const reviewPlanText = (p) => {
        const n = Number(p?.dropped ?? 0)
        const fix = p?.unmarked && (p?.autoRejected || n > 0) ? '先照你选的补上标记，' : ''
        if (p?.autoRejected) return `点「核对一次」，${fix}这趟照你回家时选的不算。`
        if (n > 0) return `点「核对一次」，${fix}这趟算数，你回家时划掉的 ${n} 条不算。`
        return Number(p?.held ?? 0) > 0 ? '点「核对一次」，这趟就算数。' : '这趟写的一直算着，点「核对一次」只是把这趟结掉。'
      }
      // 「核对一次」能点时先说为什么能点（issue #68）：出门时没记下基线的那趟核对不了、按能结算算，
      // 不能说成「已经对得上了」——卡片标题里的原因正写着「没记下她自己的记录」。
      const reviewNowText = (p) =>
        p?.checkable === false ? '这趟开始时没记下能比对的记录，没法核对。' : '现在记录已经对得上了。'
      // 还没核对时这趟眼下是什么样：标记没写进去的、升级前挂上的请神 pending，都没有先标掉的条目，
      // 她写的一直算着，不能说成「先全部不算」「还没算数」。
      const heldText = (p) =>
        p?.unmarked
          ? '回家时「不算」的标记没写进去，这趟写的眼下还算着。'
          : Number(p?.held ?? 0) > 0
            ? `这趟她写的 ${p.held} 条先全部不算。`
            : '这趟没有先标掉的条目，她写的一直算着。'

      // 核对上一次没算数的那趟（0.6.32）：记录恢复后重新比对，通过就当场算数。
      async function doReviewPending() {
        setOutingBusy(true)
        setOutingMsg('正在重新核对……')
        try {
          // 带上卡上那一趟（issue #68）：两趟都在等时，别的窗口刚结掉这一趟，
          // 服务端取到的就是下一趟——人没看过它的卡，要回 409，不能顺手结掉。
          const card = outing?.pendingReview ?? null
          const r = await jpost('/outing', { action: 'review', sessionId: card?.sessionId || '', startedAt: card?.startedAt ?? null })
          setOuting(await jget('/outing'))
          setOutingMsg(reviewDoneText(r, r?.outing))
        } catch (e) {
          setOutingMsg(`核对没过：${e.message}`)
          jget('/outing').then(setOuting).catch(() => {})
        } finally {
          setOutingBusy(false)
        }
      }

      // 请神（2026-10-28）：把一条正在用的对话临时交给她。
      // 不做「人格设定」——请神只是把此刻的她借过去，结束时撤销，那条对话恢复原样。
      // 这一块的 state 也在组件开头，理由同「出门」。

      async function loadPossess() {
        try { setPossess(await jget('/possession')) } catch { /* 拿不到就保持原样 */ }
      }

      async function doStartPossess() {
        const sid = possessPick || possess?.sessions?.[0]?.sessionId || ''
        if (!sid) { setPossessMsg('先选一条现在开着的对话。'); return }
        setPossessBusy(true)
        setPossessMsg('正在接入……')
        try {
          await jpost('/possession', { action: 'start', sessionId: sid })
          await loadPossess()
          setOuting(await jget('/outing').catch(() => outing))
          setPossessMsg('接上了。从你在那条对话里说的下一句话开始，回你的就是她。')
        } catch (e) {
          setPossessMsg(`没接上：${e.message}`)
        } finally {
          setPossessBusy(false)
        }
      }

      async function doEndPossess(keep = true, drop = []) {
        setPossessBusy(true)
        setPossessMsg('正在让她回去……')
        try {
          const r = await jpost('/possession', {
            action: 'end',
            sessionId: possess?.active?.sessionId ?? '',
            kept: keep,
            rejectedIds: keep ? (drop ?? []) : [],
          })
          await loadPossess()
          setOuting(await jget('/outing').catch(() => outing))
          setPossessEndAsk(false)
          setPossessDrop([])
          const n = Number(r?.rejected ?? 0)
          const held = Number(r?.held ?? 0)
          // 文案要跟结算一致（与出门 0.7.4 的修法同一套）：说「不算数」就得说清几条被跳过。
          setPossessMsg(
            r?.marked === false
              ? `回去了，但${unmarkedEndText(r, '接管前')}`
              : r?.tampered
              // issue #68：对不上时这趟先整趟不算（以前只是嘴上说，标记一条没写），人的选择留到核对通过再照办。
              ? `她回去了，但这趟先不算数：${r?.verify?.why || '记录对不上'}${held ? `（她这趟写的 ${held} 条先全部跳过）` : ''}。把记录恢复成接管前的样子，再点「核对一次」。` +
                (keep === false
                  ? '核对通过后，这趟照你选的不算。'
                  : n > 0
                    ? `核对通过后，你划掉的 ${n} 条不算，其余的算上。`
                    : '核对通过后，这趟就算数。')
              : keep === false
                ? (n > 0
                    ? `回去了。这趟不算数：她写的 ${n} 条全部跳过，不会算成她的成长。`
                    : '回去了。这趟不算数。不过这趟她什么都没写，所以没有要跳过的。')
                : n > 0
                  ? `回去了。划掉了 ${n} 条，那几条不算，其余的照常算。`
                  : r?.note?.ok
                    ? '回去了，那条对话里补了一句交接：「（大肥鱼回去了，这条对话还给你。）」'
                    : `回去了，那条对话恢复原样${r?.note?.why ? `（那句交接没写进去：${r.note.why}）` : ''}。`,
          )
        } catch (e) {
          setPossessMsg(`没能让她回去：${e.message}`)
        } finally {
          setPossessBusy(false)
        }
      }

      // 核对上一次没算数的请神（与出门 /outing 的 review 同一套）。
      async function doReviewPossession() {
        setPossessBusy(true)
        setPossessMsg('正在重新核对……')
        try {
          const card = possess?.pendingReview ?? null
          const r = await jpost('/possession', { action: 'review', sessionId: card?.sessionId || '', startedAt: card?.startedAt ?? null })
          await loadPossess()
          setPossessMsg(reviewDoneText(r, r?.possession))
        } catch (e) {
          setPossessMsg(`核对没过：${e.message}`)
          loadPossess()
        } finally {
          setPossessBusy(false)
        }
      }

      const possessActive = possess?.active ?? null
      const possessSessions = possess?.sessions ?? []
      const possessTarget = possessPick || possessSessions[0]?.sessionId || ''
      // 下拉里要显示「对话框的名字」，不是会话 id 尾巴（2026-10-29 用户 m00761）：
      // 名字由服务端从 session/title 事件里读出来；重名时补上工作区目录名区分，
      // 还没起名字的给一句人话，不再把 id 甩给人看。
      const possessWhere = (p) => String(p ?? '').split(/[\\/]/).filter(Boolean).pop() || ''
      const possessNameCount = new Map()
      for (const s of possessSessions) {
        const k = String(s?.title ?? '')
        possessNameCount.set(k, (possessNameCount.get(k) || 0) + 1)
      }
      const possessName = (s) => {
        const t = String(s?.title ?? '').trim() || '还没起名字的对话'
        const dup = (possessNameCount.get(String(s?.title ?? '')) || 0) > 1
        const w = dup ? possessWhere(s?.cwd) : ''
        return w ? `${t} · ${w}` : t
      }

      const awayNowUI = outing?.away ?? null
      const isOut = awayNowUI?.kind === 'outing'
      // issue #68 第 5 条：原来按名字里含「口袋/园区」判，名字像的普通工作区也会被当成园区。
      // 0.9.5 改成拿目录名跟工作区名比，可园区那趟的工作区名是「工作园区」，永远对不上。
      // 现在由服务端按登记的工作区 id 或目录认（away.atPocket）。
      const inPocketOuting = awayNowUI?.atPocket === true
      const wsList = outing?.workspaces ?? []
      const recentOutings = (outing?.outings ?? []).slice(-6).reverse()
      const outPick = outingPick || wsList[0]?.id || ''
      const outPickRow = wsList.find((w) => w.id === outPick) ?? null
      const outingDisabled = Boolean(outing?.away?.kind)
      // 说明卡确认过没有（2026-10-30，用户 m01904）：没确认时三个入口按钮先灰着。
      const outingAck = outing?.ack === true

      // 回家审查：比对结果先给她自己看，不是点完才告诉她「对不上」。
      // 2026-10-30（用户 m00650 第三版）：字节数不摆正文——给人看的是「多了什么」。
      const verifyText = (v) => {
        if (!v) return '还没核对。'
        if (v.checkable === false) return '这趟出门前没记下她自己的记录，回来没法核对。'
        if (v.ok === true) return '出门前的记录没被改过。'
        return `这段记录对不上：${v.why || '内容对不上'}`
      }
      // 清单只摆最近那些条（issue #68）：摆不下的照常算，整趟不算时也一起标上，要说一声。
      const moreThanListed = (since) => {
        const total = Number(since?.total ?? 0)
        const shown = (since?.items ?? []).length
        return total > shown ? `清单只列出最近 ${shown} 条，更早的 ${total - shown} 条没法单独划掉，照常算；点「整趟不算」会连它们一起不算。` : ''
      }
      const outingStatusText = (o) =>
        o.status === 'active'
          ? '还没回来'
          : o.status === 'pending'
            ? '等着核对'
            : o.status === 'rejected'
              ? '这趟不算'
              : '已算数'
      const outingRows = recentOutings.map((o) =>
        h('div', { style: { display: 'flex', gap: '10px', justifyContent: 'space-between' } },
          h('span', null,
            o.workspaceName || o.workspaceId || '别的工作区',
            o.diaries ? h('span', { className: 'hint', style: { marginLeft: '6px' } }, `· 日记 ${o.diaries} 篇`) : null,
            o.keepsakes ? h('span', { className: 'hint', style: { marginLeft: '6px' } }, `· 带回来 ${o.keepsakes} 件`) : null),
          h('span', { className: 'hint', style: { margin: 0 } },
            `${outingStatusText(o)} · ${new Date(o.startedAt).toLocaleDateString()}`)))

      const outingPage = h('div', { className: 'page' },
        // 关于出门的说明卡（2026-10-30，用户 m00650 / m01100）：文字来自 OUTING_INTRO，
        // 一个元素一段；「送她出门：」「请神：」把冒号前当小标题加粗，这么长的说明才扫得动。
        h('div', { className: 'card full' },
          h('h3', null, '关于出门'),
          adv('点开详细了解',
          ...OUTING_INTRO.map((line, i) => {
            const cut = line.indexOf('：')
            const label = cut > 0 && cut <= 6 ? line.slice(0, cut) : ''
            return h('p', {
              key: `outing-intro-${i}`,
              style: {
                margin: i === OUTING_INTRO.length - 1 ? 0 : '0 0 8px',
                fontSize: '13px',
                lineHeight: 1.7,
              },
            },
              label ? h('strong', null, `${label}：`) : null,
              label ? line.slice(cut + 1) : line)
          }))),

        // 确认门（2026-10-30，用户 m01904）：没点过「我知道了」，三个入口按钮先灰着。
        // 只做在界面——服务端拦住会把命令行与旧用例一起挡掉，而这里要挡的是误点。
        outingAck
          ? null
          : groupFull('先确认一下',
              '出门是测试版功能。它是真的把一条对话交出去、也真的会读那边的文件——最坏的情况不是数据坏了，是她会把不该看的内容写进日记，而日记撤不回。',
              h('div', { className: 'row', style: { alignItems: 'center', gap: '10px' } },
                h('button', { disabled: outingBusy, onClick: doAckOuting }, outingBusy ? '正在记……' : '我知道了，开始用'),
                h('span', { className: 'hint', style: { margin: 0 } }, '点过之后不再问；说明随时在上面的卡里。')),
              h('p', { className: 'hint', style: { margin: '8px 0 0' } },
                '第一次用，先试「工作园区」：一个不带项目记录的工作区。')),

        groupFull('现在在哪',
          '她在家还是在外；在外时家里的定时日程暂停。',
          isOut
            ? h('div', null,
                h('p', { style: { margin: '0 0 6px', fontWeight: 600 } },
                  awayNowUI.line || '现在在外面'),
                // 写清是哪条对话（0.6.26，用户 m03194）：工作区 + 对话名字 + 第几趟。
                // 2026-10-30（用户 m00650）：会话短号对用户没意义，从正文里去掉——
                // 真要排查时看 possessions/outings 台账就够了。
                h('p', { className: 'hint', style: { margin: '0 0 4px' } },
                  [
                    `在「${awayNowUI.outing?.workspaceName || '那个工作区'}」`,
                    awayNowUI.sessionTitle ? `的「${awayNowUI.sessionTitle}」这条对话里` : '的一条对话里',
                    awayNowUI.tripNo ? ` · 第 ${awayNowUI.tripNo} 趟` : '',
                  ].join('')),
                awayNowUI.warning
                  ? h('p', { style: { margin: '0 0 4px', color: '#e5534b', fontWeight: 600 } }, awayNowUI.warning)
                  : null,
                h('p', { className: 'hint' },
                  '她在外面写下的，一落进记录就先算上了；叫她回家时，你可以划掉其中几条，或者整趟不算。回来时会先核对她自己的记录有没有被人改过（人为或意外篡改）；如果对不上，这趟就先整趟不算——人照样回家、能力也收回，等你恢复记录、点一下核对再照你的选择结算。'),
                h('p', { className: 'hint' },
                  verifyText(awayNowUI.verify),
                  outing?.identityFrozen ? ' 她带出去的是出门那一刻的身份；家里之后的变化，这趟她看不到。' : ''),
                // 想念天数（0.6.16，用户 m01677）：只写事实——第几天，不替她抒情。
                // 2026-10-30（用户 m00650）：不再 +1——tripDays 本身就从「今天算第 1 天」起算。
                awayNowUI.tripDays > 0
                  ? h('p', { className: 'hint' }, `这趟出门已经第 ${awayNowUI.tripDays} 天了。`)
                  : null,
                // 留话：这趟出门里她以 user 身份写进自己事件流的那几句。
                (outing?.letters ?? []).length
                  ? h('div', { style: { marginTop: '8px', fontSize: '13px', lineHeight: '1.8' } },
                      h('p', { className: 'hint', style: { margin: '0 0 4px' } }, '这趟出门，她想对你说：'),
                      ...(outing?.letters ?? []).map((l) => h('div', { key: l.id }, l.text)))
                  : null,
                // 纪念品（0.6.17）：她问「这件能带回去吗」，只有这里点头才会真的复制。
                // 2026-10-30（用户 m00650 第三版）：按钮直接说结果，别提「目录」——
                // 真身是 keepsakes/<日期>/，写「纪念品目录」会让人去找一个不存在的中文文件夹。
                (outing?.keepsakes?.pending ?? []).map((k) =>
                  h('div', { key: k.id, style: { marginTop: '8px', padding: '8px', border: '1px solid var(--border, #333)', borderRadius: '8px', fontSize: '13px' } },
                    h('p', { style: { margin: '0 0 4px' } },
                      '她想把这件东西带回家：',
                      h('strong', null, k.rel),
                      h('span', { className: 'hint', style: { marginLeft: '6px' } },
                        `${Math.max(1, Math.round(Number(k.size || 0) / 1024))} KB`)),
                    k.why ? h('p', { className: 'hint', style: { margin: '0 0 6px' } }, k.why) : null,
                    h('p', { className: 'hint', style: { margin: '0 0 6px' } },
                      '带回来的会收进她家的纪念品文件夹里（按日期分）。'),
                    h('div', { className: 'row' },
                      h('button', { disabled: outingBusy, onClick: () => doDecideKeepsake(k.id, true) }, '带回来'),
                      h('button', { disabled: outingBusy, className: 'ghost', onClick: () => doDecideKeepsake(k.id, false) }, '不用带')))),
                outingEndAsk
                  ? h('div', null,
                      h('p', { className: 'hint', style: { marginTop: '8px' } },
                        // 2026-10-29（用户 m01581，真机）：原来写「你这边没有她可用的工具」，
                        // 这是**事实错误**——她的那几个工具是插件级全局注册的，口袋那条会话里
                        // 一样在手上（只是没有那个工作区的 bash/read/write）。空清单的真实原因
                        // 是她一条没写，不是她没有工具。
                        (awayNowUI.since?.total ?? 0) === 0
                          ? (inPocketOuting
                              ? '这趟她去的是园区。清单空着，通常就是这趟她没写下什么。算不算，你说了算。'
                              // issue #68 起清单和结算同一个口径，记账行一条不收：写日记、评视频只留一行记账，
                              // 不会出现在这里，所以不能再拿它们举例。
                              : '这趟她没写新东西，所以没有可以划掉的。只跟你聊天不算她做的事；她写的日记、评的视频也不在这张清单里。想让她留下点什么，就让她在那边记一条自己的想法或判断，回来这里才会出现可勾的条目。')
                          : `这趟她写了 ${awayNowUI.since?.total ?? 0} 条记录。默认全算上；不想要的，把前面的勾去掉。她拒绝过或推翻过的会单独标出来——只挑好听的话留下，等于把这趟教坏。` +
                            moreThanListed(awayNowUI.since)),
                      h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '6px', maxHeight: '260px', overflow: 'auto' } },
                        ...(awayNowUI.since?.items ?? []).map((it) => {
                          const on = !outingDrop.includes(it.id)
                          return h('label', { key: it.id, style: { display: 'flex', gap: '8px', alignItems: 'flex-start', fontSize: '13px', lineHeight: '1.6' } },
                            h('input', {
                              type: 'checkbox',
                              checked: on,
                              disabled: outingBusy,
                              onChange: (e) => setOutingDrop((prev) => e.target.checked ? prev.filter((x) => x !== it.id) : [...prev, it.id]),
                            }),
                            h('span', null,
                              // pushback = type==='refusal' || verdict==='refuted'（她拒绝过 / 推翻过自己），
                              // 不是「不想放弃」——标记要跟语义对得上（2026-10-30 用户 m00650 第三版核对）。
                              it.pushback ? h('strong', { style: { marginRight: '6px' } }, '（她拒绝过或推翻过的）') : null,
                              it.text))
                        })),
                      h('div', { className: 'row', style: { marginTop: '8px' } },
                        h('button', { disabled: outingBusy, onClick: () => doEndOuting(true, outingDrop) }, '这趟算数'),
                        h('button', { disabled: outingBusy, className: 'ghost', onClick: () => doEndOuting(false, []) }, '整趟不算'),
                        h('button', { disabled: outingBusy, className: 'ghost', onClick: () => { setOutingEndAsk(false); setOutingMsg('') } }, '先等等')))
                  : h('div', { className: 'row', style: { marginTop: '8px', alignItems: 'center' } },
                      h('button', { disabled: outingBusy, onClick: () => { setOutingDrop([]); setOutingEndAsk(true) } }, '叫她回家'),
                      h('span', { className: 'hint', style: { margin: 0 } }, '回来时会先让你核对')))
            : awayNowUI?.kind === 'possession'
              ? h('div', null,
                  h('p', { style: { margin: '0 0 6px', fontWeight: 600 } },
                    awayNowUI.line || '现在在这条对话里替人说话'),
                  // 2026-10-29（用户 m01474）：把「护栏是共用的」写明白。
                  // 2026-10-30（用户 m00650 第三版，并纠正原第三版的一句事实错误）：
                  // 护栏只作用于**这一条**被接管的对话——别的对话照常，不会全被拦；
                  // 结束也只能在界面里点，不能让她自己结束（第三版原文「所有对话都不能修改」「只能由用户消息覆盖」都不成立）。
                  h('p', { className: 'hint' },
                    '这段时间，这条对话里回你话的是她，不是原来那个。护栏是这条对话共用的：分不出谁在打字，所以只有这条被接管的对话碰不到她家里的东西（屋子、记忆、对话、配置）——调用里带着这些路径的，读和写都会被一起拦下来；别的对话不受影响。回你话的也不再是原来的助手。结束只能在界面里点。'),
                  h('p', { className: 'hint' },
                    '这期间她说过的话会留在上下文里（可能会干扰这条对话原本的工作），结束时系统会补一句「（大肥鱼回去了，这条对话还给你。）」，帮原来的助手接回人格。想完全干净，就新开一条对话。'))
              : h('p', { className: 'dim', style: { margin: 0 } }, '在家。没有出门。'),

          outingMsg ? h('p', { className: 'hint', style: { marginTop: '10px' } }, outingMsg) : null,

          // 上一趟被拒收的那趟（0.6.32，用户 2026-10-29 真机要求）：
          // 以前 pending 只剩「等确认」三个字，没有原因、也没有下一步，
          // 结果人和文件都在，却是死路。这里把原因和复核按钮一起摆出来。
          (outing?.pendingReview ?? null)
            ? h('div', { style: { marginTop: '10px', padding: '8px', border: '1px solid var(--border, #333)', borderRadius: '8px', fontSize: '13px' } },
                h('p', { style: { margin: '0 0 4px', fontWeight: 600 } }, pendingTitle(outing.pendingReview, 'outing')),
                h('p', { className: 'hint', style: { margin: '0 0 4px' } },
                  // 2026-10-30（用户 m00650 第三版第 21 条）：不再摆会话短号——
                  // 对普通用户来说那是一串看不懂的编号。
                  `${outing.pendingReview.workspaceName || '那个工作区'} · ${outing.pendingReview.reason || '对不上'}`),
                h('p', { className: 'hint', style: { margin: '0 0 6px' } },
                  outing.pendingReview.okNow
                    ? reviewNowText(outing.pendingReview) + reviewPlanText(outing.pendingReview)
                    : `人已经回家了，能力也收回，${heldText(outing.pendingReview)}把记录恢复成出门时的样子，再来点「核对一次」。`),
                h('div', { className: 'row', style: { alignItems: 'center' } },
                  h('button', { disabled: outingBusy || !outing.pendingReview.okNow, onClick: () => doReviewPending() }, '核对一次'),
                  outing.pendingReview.okNow ? null : h('span', { className: 'hint', style: { margin: 0 } }, '还没恢复')))
            : null,

          // 最近几趟并进这张卡（0.6.16，用户 m01613：信息与台账重复，合并）。
          recentOutings.length
            ? h('div', { style: { marginTop: '12px', fontSize: '13px', lineHeight: '1.9' } },
                h('p', { className: 'hint', style: { margin: '0 0 4px' } }, '最近的几趟：'),
                ...outingRows)
            : null),

        groupFull('工作园区（专门干活用）',
          '一个固定的工作区，专门用来干活。第一次去时不带项目记录，用过以后会留下这个工作区自己的记录和文件。她带过去的，只有出门那一刻的自己。',
          !outing
            ? h('p', { className: 'hint' }, '正在读园区……')
            : h('div', null,
                h('p', { className: 'hint', style: { margin: '0 0 8px' } },
                  '工作园区在：' + (outing.pocket?.path || '（还定不下来）') +
                    (outing.pocket?.registered ? '' : '（第一次用时会自动登记成一个工作区）')),
                h('div', { className: 'row' },
                  h('button', {
                    disabled: !outingAck || outingDisabled || outingBusy,
                    onClick: doStartPocket,
                  }, outingBusy ? '正在准备……' : '让她去园区')),
                // 2026-10-30（用户 m00972）：园区也可以接着上次那条会话做，
                // 不必每趟从白纸开始；不勾就是新开一条。
                outing.pocket?.last?.sessionId
                  ? h('label', { style: { display: 'flex', gap: '8px', alignItems: 'flex-start', marginTop: '8px', fontSize: '13px', lineHeight: '1.6' } },
                      h('input', {
                        type: 'checkbox',
                        checked: outingReuse,
                        disabled: outingDisabled || outingBusy,
                        onChange: (e) => setOutingReuse(e.target.checked),
                      }),
                      h('span', null,
                        '接着上次做（回到工作园区里上次那条对话）',
                        h('span', { className: 'hint', style: { display: 'block', margin: '2px 0 0' } },
                          '上次是 ' + new Date(outing.pocket.last.startedAt).toLocaleDateString() +
                          ' 去的。不勾就新开一条。')))
                  : null,
                h('p', { className: 'hint', style: { marginTop: '8px' } },
                  '能不能写到别的目录，看这个工作区的权限设置（沙箱或全部权限）。她做出来的文件在园区目录里。'),
                h('p', { className: 'hint', style: { marginTop: '8px', fontWeight: 600 } },
                  '别把她送到放着插件源码的工作区：在那边她能读到自己不该看的文件（禁令的完整清单就写在源码里）。只是干活的话，用园区最稳妥。'))),

        groupFull('让她去别的工作区',
          '选一个工作区，在那边开一条新对话。在那边，她用那个工作区本来的权限和工具，不套家里这套收窄过的工具清单。',
          !outing
            ? h('p', { className: 'hint' }, '正在读工作区列表……')
            : wsList.length === 0
              ? h('p', { className: 'hint' }, '还没有别的工作区。先在 DSH 里新建一个工作区，再回来这里。')
              : h('div', null,
                  h('div', { className: 'row', style: { alignItems: 'center', gap: '10px' } },
                    h('select', {
                      value: outPick,
                      disabled: outingDisabled || outingBusy,
                      onChange: (e) => setOutingPick(e.target.value),
                    }, ...wsList.map((w) => h('option', { value: w.id }, w.title || w.id))),
                    h('button', {
                      disabled: !outingAck || outingDisabled || outingBusy || !outPick,
                      onClick: doStartOuting,
                    }, outingBusy ? '正在准备……' : '让她去这个工作区')),
                  // 复用同一趟（0.6.16，用户 m01613）：这个工作区上次那条对话还在，
                  // 就可以接着做，而不是每趟从白纸开始。
                  outPickRow?.last?.sessionId
                    ? h('label', { style: { display: 'flex', gap: '8px', alignItems: 'flex-start', marginTop: '8px', fontSize: '13px', lineHeight: '1.6' } },
                        h('input', {
                          type: 'checkbox',
                          checked: outingReuse,
                          disabled: outingDisabled || outingBusy,
                          onChange: (e) => setOutingReuse(e.target.checked),
                        }),
                        h('span', null,
                          '接着上次做（回到这个工作区上次那条对话）',
                          h('span', { className: 'hint', style: { display: 'block', margin: '2px 0 0' } },
                            '上次是 ' + new Date(outPickRow.last.startedAt).toLocaleDateString() +
                            ' 去的。不勾就新开一条。')))
                    : null,
                  h('p', { className: 'hint', style: { marginTop: '8px' } },
                    '出门期间，家里不会定时叫醒她。她在那边写下的当场就先算上；叫她回家时，你可以划掉几条，或者整趟不算。'),
                  h('p', { className: 'hint', style: { marginTop: '8px', fontWeight: 600 } },
                    '这个选项有副作用：那个工作区的项目笔记、交接记录、记忆文件等凡是你之前调用过以及你的记忆类插件总结过的，会被整份带进她的上下文（可能会导致她知道很多不该、不适合知道的事）。只想让她干活，用上面的工作园区。'),
                  awayNowUI?.kind === 'possession'
                    ? h('p', { className: 'hint' }, '她正在替人说话，先结束请神，再出门。')
                    : null)),

        groupFull('请神（让她接管一条正在用的对话）',
          '把一条对话临时交给她。从你下一句话开始，回你的就是她——是本人灵魂出窍接手回复，工具按照该会话的给，不是人格复制。你点结束时交还，她说过的话仍留在那条对话里。',
          possessActive
            ? h('div', null,
                h('p', { className: 'hint', style: { margin: 0, fontWeight: 600 } },
                  `现在在这条对话里：${possessActive.title || '还没起名字的对话'}${possessWhere(possessActive.cwd) ? `（${possessWhere(possessActive.cwd)}）` : ''}`),
                // 2026-10-29（用户 m01474）：护栏是这条对话共用的，不区分谁在说话。
                // 2026-10-30（用户 m00650 第三版，并纠正第三版里的两处事实错误）：
                // 「所有对话都不能修改」不成立——只有被接管的这一条会被拦；
                // 「结束请神只能由用户消息覆盖」也不成立——结束只能从界面按钮触发。
                h('p', { className: 'hint', style: { marginTop: '8px' } },
                  '这段时间护栏是共用的：它分不出谁在打字，所以你在那条对话里也碰不到她家里的东西（屋子、记忆、对话、配置）——调用里带着这些路径的，读和写都会被一起拦下来。只有这条被接管的对话受影响，别的对话照常。回你话的也不再是原来的助手。'),
                h('p', { className: 'hint', style: { marginTop: '6px' } },
                  '这期间她说过的话会留在上下文里（可能会干扰这条对话的工作任务），结束时系统会补一句「（大肥鱼回去了，这条对话还给你。）」，帮助恢复原来的助手人格。想完全干净，就新开一条对话。'),
                // 回家审查卡（m02241 第⑤条）：两栏并排——左边逐条挑，右边看比对结果再拍板。
                // 和出门那张卡同一套语义：默认全收下，取消勾选 = 那几条跳过；整趟不算 = 全跳过。
                possessEndAsk
                  ? h('div', { style: { display: 'flex', gap: '14px', marginTop: '10px', alignItems: 'flex-start', flexWrap: 'wrap' } },
                      h('div', { style: { flex: '1 1 260px', minWidth: '240px' } },
                        h('p', { className: 'hint', style: { margin: '0 0 4px', fontWeight: 600 } },
                          `这趟她新写下的 ${possess?.since?.total ?? 0} 条`),
                        (possess?.since?.items ?? []).length
                          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '240px', overflow: 'auto' } },
                              ...(possess.since.items).map((it) => {
                                const on = !possessDrop.includes(it.id)
                                return h('label', { key: it.id, style: { display: 'flex', gap: '8px', alignItems: 'flex-start', fontSize: '13px', lineHeight: '1.6' } },
                                  h('input', {
                                    type: 'checkbox',
                                    checked: on,
                                    disabled: possessBusy,
                                    onChange: (e) => setPossessDrop((prev) => e.target.checked ? prev.filter((x) => x !== it.id) : [...prev, it.id]),
                                  }),
                                  h('span', null,
                                    // pushback 是「她拒绝过 / 推翻过自己的判断」，不是「不想放弃」或「违抗命令」。
                                    it.pushback ? h('strong', { style: { marginRight: '6px' } }, '（她拒绝过或推翻过的）') : null,
                                    it.text))
                              }))
                          : h('p', { className: 'hint', style: { margin: 0 } },
                              '这趟她没写新东西，所以没有可以划掉的。只跟你聊天不算她做的事。')),
                      h('div', { style: { flex: '1 1 220px', minWidth: '200px' } },
                        h('p', { className: 'hint', style: { margin: '0 0 4px', fontWeight: 600 } }, '记录核对'),
                        h('p', { className: 'hint', style: { margin: '0 0 4px' } }, verifyText(possess?.verify)),
                        h('p', { className: 'hint', style: { margin: '0 0 6px' } },
                          '默认全算上；左边没勾的会被标成「不算」。她拒绝过或推翻过的会单独标出来——只挑好听的话留下，等于把这趟教坏。' +
                            moreThanListed(possess?.since)),
                        h('div', { className: 'row' },
                          h('button', { disabled: possessBusy, onClick: () => doEndPossess(true, possessDrop) }, '这趟算数'),
                          h('button', { disabled: possessBusy, className: 'ghost', onClick: () => doEndPossess(false, []) }, '整趟不算'),
                          h('button', { disabled: possessBusy, className: 'ghost', onClick: () => { setPossessEndAsk(false); setPossessDrop([]); setPossessMsg('') } }, '先等等'))))
                  : h('div', { className: 'row', style: { marginTop: '8px', alignItems: 'center' } },
                      h('button', {
                        disabled: possessBusy,
                        onClick: () => { setPossessDrop([]); setPossessEndAsk(true) },
                      }, possessBusy ? '正在让她回去……' : '结束请神'),
                      h('span', { className: 'hint', style: { margin: 0 } }, '点开先核对这趟')))
            : h('div', null,
                h('p', { className: 'hint', style: { margin: 0 } },
                  '只能选现在开着的对话。没打开过的，点击一次之后才会出现在这里。'),
                h('div', { style: { display: 'flex', gap: '8px', marginTop: '8px', flexWrap: 'wrap' } },
                  h('select', {
                    value: possessTarget,
                    disabled: possessBusy || possessSessions.length === 0,
                    onChange: (e) => setPossessPick(e.target.value),
                  }, ...possessSessions.map((s) => h('option', { value: s.sessionId }, possessName(s)))),
                  h('button', {
                    disabled: !outingAck || possessBusy || !possessTarget,
                    onClick: doStartPossess,
                  }, possessBusy ? '正在接入……' : '请她上身')),
                // 2026-10-30（用户 m00650 第三版第 47 条：两处不重复全文，这里缩成一句结论）。
                h('p', { className: 'hint', style: { marginTop: '8px', fontWeight: 600 } },
                  '注意：接上之后，这条对话的护栏就被她和原来那个共用——分不出谁在打字，所以你在那条对话里也碰不到她家里的东西（屋子、记忆、对话、配置），读和写都会被一起拦下来。只有这条对话受影响，别的对话照常。只能由你结束。')),
          // 上一次没结算的请神（m02241 第②条）：与出门那趟同一套——摆原因、摆复核按钮。
          // 不给这块，pending 就只剩一句「等复核」，人不知道在等什么。
          (possess?.pendingReview ?? null)
            ? h('div', { style: { marginTop: '10px', padding: '8px', border: '1px solid var(--border, #333)', borderRadius: '8px', fontSize: '13px' } },
                h('p', { style: { margin: '0 0 4px', fontWeight: 600 } }, pendingTitle(possess.pendingReview, 'possess')),
                h('p', { className: 'hint', style: { margin: '0 0 4px' } },
                  `${possess.pendingReview.title || '那条对话'} · ${possess.pendingReview.reason || '对不上'}`),
                h('p', { className: 'hint', style: { margin: '0 0 6px' } },
                  possess.pendingReview.okNow
                    ? reviewNowText(possess.pendingReview) + reviewPlanText(possess.pendingReview)
                    : `人已经回到原来的位置了，${heldText(possess.pendingReview)}把记录恢复成接管前的样子，再来点「核对一次」。`),
                h('div', { className: 'row', style: { alignItems: 'center' } },
                  h('button', { disabled: possessBusy || !possess.pendingReview.okNow, onClick: () => doReviewPossession() }, '核对一次'),
                  possess.pendingReview.okNow ? null : h('span', { className: 'hint', style: { margin: 0 } }, '还没恢复')))
            : null,
          possessMsg ? h('p', { className: 'hint', style: { margin: '8px 0 0' } }, possessMsg) : null))

      const envPage = h('div', { className: 'page' },
        toolsCard,
        group('为什么默认只放这几个',
          null,
          h('ul', { style: { margin: 0, paddingLeft: '18px', fontSize: '13px', lineHeight: '1.9', opacity: 0.85 } },
            h('li', null, '每个工具的定义都占她每轮的上下文。'),
            h('li', null, '工具越多，越容易顺手去做，而不是先想要不要做。'),
            h('li', null, '有些工具会真的动到外面：发消息、下文件、跑命令。'))),
        aboutCard,
        )

      // ---------------------------- 数据 ----------------------------
      // 用户 m03440：原来的「危险」页改名「数据」。数据文件夹、每日报告、
      // 运行日志、重置本来就是一套动作——备份、搬走、出事把现场交出去、重开一局。
      // 界面上不出现绝对路径（那是他本机的用户名和盘符）。
      // 备份不是「复制路径」：一个真会动文件的动作，单独摆一张卡，
      // 免得用户把「复制数据文件夹路径」当成备份（那是两回事）。
      async function backupNow() {
        setBackupBusy(true)
        setBackupMsg('正在打包……')
        try {
          const b = await jget('/backup')
          const name = b.fileName || '大肥鱼-备份.json'
          const url = URL.createObjectURL(new Blob([JSON.stringify(b)], { type: 'application/json' }))
          const a = document.createElement('a')
          a.href = url
          a.download = name
          a.click()
          setTimeout(() => URL.revokeObjectURL(url), 4000)
          // skipped 只有真没装进去的文件，每条自带原因（超限、读不到……），报真实个数、列出名字：
          // 0.9.5 只列前 3 条再写「等」，owner.json、state.json 这种要紧的会被盖住。
          const skipped = Array.isArray(b.skipped) ? b.skipped : []
          const unlisted = Math.max(0, Number(b.skippedUnlisted) || 0)
          const missingCount = skipped.length + unlisted
          // 照规矩不带的目录在 excluded 里。顶层的 logs/、backups/ 卡片上已经写了「不含运行日志和旧备份」；
          // 可目录名在哪一层都认，她房间里叫 backups、node_modules 的文件夹也没带，这些要单独说，不能不声不响。
          const CARD_SAYS = ['logs/', 'backups/', 'dsh-fish-backups/']
          const quiet = (Array.isArray(b.excluded) ? b.excluded : []).filter((x) => typeof x === 'string' && !CARD_SAYS.includes(x))
          // 事件流不设上限，包可能比「从备份恢复」一次能收的大。导出时就说，不要等到恢复那天。
          const tooBig = b.fitsRestore === false
          setBackupMsg(
            `已导出「${name}」：${b.files?.length ?? 0} 个文件，约 ${Math.max(1, Math.round((b.bytes || 0) / 1024))}KB。`
            + (missingCount ? `有 ${missingCount} 个文件没打进包，恢复出来也不会有：${missingText(skipped, skipped.length, unlisted)}。` : '')
            + (quiet.length ? `另外，叫 logs、backups、node_modules 这类名字的文件夹照规矩不打包，这次没带：${quiet.slice(0, 10).join('、')}${quiet.length > 10 ? `，还有 ${quiet.length - 10} 个` : ''}。` : '')
            + (tooBig
              ? `这份包有 ${mbText(b.restoreBytes)}，「从备份恢复」一次最多收 ${mbText(b.restoreLimit)}，用它装不回去。换机器的话，直接把数据文件夹整个复制过去。`
              : ''),
          )
        } catch (e) {
          setBackupMsg(`备份失败：${e.message}`)
        } finally {
          setBackupBusy(false)
        }
      }

      // issue #65：恢复撞上碎字文件时，后端不退不让——先把坏文件点出来，等人说跳过才继续。
      // 这中间旧档、新档一个都没动（见 lib/backup.js 的 restoreBackup）。
      async function pushRestore(obj, skipBad) {
        setBackupBusy(true)
        setBackupMsg(skipBad ? '正在跳过那些文件继续恢复……' : '正在恢复……')
        setRestoreBad(null)
        try {
          const r = await jpost('/backup/restore' + (skipBad ? '?skipBad=1' : ''), obj)
          // 导出时就没打进包的文件，恢复出来也没有。照报成功会让人以为全回来了。
          // skipped 最多带前 200 条，个数以 skippedCount 为准。
          const missing = Array.isArray(r.skipped) ? r.skipped : []
          const unlisted = Math.max(0, Number(r.skippedUnlisted) || 0)
          const missingCount = Math.max(Number(r.skippedCount) || 0, missing.length + unlisted)
          const badSkipped = Array.isArray(r.skippedBad) ? r.skippedBad : []
          setBackupMsg(
            `已恢复 ${r.restored} 个文件。${r.quarantined ? `旧档整体封存在「${r.quarantined}」，没有删。` : ''}`
            + (badSkipped.length ? `按你说的，${badSkipped.length} 个碎字文件跳过了、没写回去：${someOf(badSkipped, badSkipped.length)}。` : '')
            + (missingCount ? `这份包导出时有 ${missingCount} 个文件没打进去，这次也没有恢复出来：${missingText(missing, missingCount - unlisted, unlisted)}。` : '')
            + '重启 DSH 之后她才是这份档的样子。',
          )
        } catch (e) {
          const p = e && e.payload
          if (p && p.needDecision) {
            // 点名：哪个文件坏了，先让人看见，再问跳不跳。
            setRestoreBad({
              obj,
              files: Array.isArray(p.badFiles) ? p.badFiles : [],
              count: Math.max(Number(p.badCount) || 0, Array.isArray(p.badFiles) ? p.badFiles.length : 0),
            })
            setBackupMsg('')
          } else {
            setBackupMsg(`恢复失败：${e.message}`)
          }
        } finally {
          setBackupBusy(false)
        }
      }

      function restoreFromFile() {
        const el = document.createElement('input')
        el.type = 'file'
        el.accept = '.json,application/json'
        el.onchange = async () => {
          const f = el.files && el.files[0]
          if (!f) return
          let obj = null
          try {
            const text = await f.text()
            try { obj = JSON.parse(text) } catch { throw new Error('这个文件不是 json') }
          } catch (e) {
            setBackupMsg(`恢复失败：${e.message}`)
            return
          }
          await pushRestore(obj, false)
        }
        el.click()
      }

      // ---- 迁移工作区（2026-10-28，用户 m06510）----
      // 用户要的是：点一个按钮 → 选文件夹 → 全搬过去。
      // 文件夹选择优先用桌面端的原生选择器（宿主用 contextBridge 暴露的
      // `__DSH_DIRECTORY_PICKER__`）；web 模式下没有它，退回手输路径。
      async function refreshMove() {
        try { setMoveInfo(await jget('/move')) } catch { setMoveInfo(null) }
      }

      async function pickFolder() {
        try {
          const p = globalThis.__DSH_DIRECTORY_PICKER__
          if (p && typeof p.pick === 'function') {
            const dir = await p.pick()
            if (dir) setMoveTarget(String(dir))
            return String(dir || '')
          }
          // 没有原生选择器（web 模式、宿主没暴露）：原来点了什么都不发生，像是按钮坏了。
          setMoveMsg('这里打不开文件夹选择器。把文件夹的完整路径直接填进左边的框里，例如 D:\\大肥鱼。')
        } catch (e) {
          setMoveMsg(`打开文件夹选择器失败：${e.message}`)
        }
        return ''
      }

      async function askMove() {
        setMoveAsk(true)
        setMoveMsg('')
        await refreshMove()
      }

      async function doMove() {
        const target = String(moveTarget || '').trim()
        if (!target) { setMoveMsg('先选一个文件夹'); return }
        setMoveBusy(true)
        setMoveMsg('正在搬……东西多的话要等一会儿，别关窗口。')
        try {
          const r = await jpost('/move', { target })
          setMoveAsk(false)
          setMoveTarget('')
          setMoveMsg(
            `搬好了：${r.files} 个文件、约 ${Math.max(1, Math.round((r.bytes || 0) / 1024))}KB，现在在 ${r.to}。`
            + (r.oldDirMoved ? '老目录没删，改名收在旁边的 dsh-fish-backups 里。' : '老目录还在原处（改名没成功），确认无误后你可以自己删。')
            + '重启 DSH 之后她才会在新位置醒过来；重启之前她记不下新的事（写入会被拒），请现在就重启。'
            + (r.stranded ? ` 侧栏旧会话没全清干净：${r.stranded}` : ''),
          )
        } catch (e) {
          setMoveMsg(`迁移失败：${e.message}`)
        } finally {
          setMoveBusy(false)
        }
      }

      const moveHint = moveInfo
        ? `现在住在 ${moveInfo.root}（${moveInfo.files} 个文件，约 ${Math.max(1, Math.round((moveInfo.bytes || 0) / 1024))}KB）${moveInfo.moved ? '——已经搬过一次了' : ''}。`
        : ''

      const moveCard = h('div', { style: { marginTop: '14px' } },
        h('div', { className: 'row', style: { alignItems: 'center', gap: '10px' } },
          h('button', { disabled: moveBusy, onClick: askMove }, '迁移工作区…'),
          h('span', { className: 'hint', style: { margin: '0' } }, '把大肥鱼的所有文件迁移至任何你想存放的地方')),
        !moveAsk
          ? (moveMsg ? h('p', { className: 'hint' }, moveMsg) : null)
          : h('div', { style: { marginTop: '10px' } },
              h('p', { className: 'dim' }, '有些人不想让这些文件待在 C 盘，想挪到 D 盘、E 盘。搬的是整个数据文件夹：事件流、日记、她的房间、配置、登录凭据，全都在里面。'),
              h('p', { className: 'hint' }, '搬的是复制 + 逐文件核对字节数。老目录不会删，会改名收在同级的 dsh-fish-backups 里。'),
              h('p', { className: 'hint' }, '搬完必须重启 DSH 才生效——她现在住哪是在启动时定下来的。搬完到重启之间她记不下新的事，所以搬完请马上重启。'),
              moveHint ? h('p', { className: 'hint' }, moveHint) : null,
              h('p', { className: 'dim' }, '选一个文件夹，会在里面建 dsh-fish 子目录（已有非空的 dsh-fish 不行）。已经放着一份档的文件夹（里面有 events.jsonl）也不行：会直接拒绝，两边什么都不动。'),
              h('div', { className: 'row' },
                h('input', {
                  type: 'text',
                  value: moveTarget,
                  placeholder: '例如：D:\\大肥鱼',
                  style: { flex: '1', minWidth: '220px' },
                  onChange: (e) => setMoveTarget(e.target.value),
                }),
                h('button', { disabled: moveBusy, onClick: pickFolder }, '选择文件夹…')),
              h('div', { className: 'row', style: { marginTop: '8px' } },
                h('button', { disabled: moveBusy || !moveTarget.trim(), onClick: doMove }, moveBusy ? '正在搬……' : '搬到这个文件夹'),
                h('button', { disabled: moveBusy, className: 'ghost', onClick: () => { setMoveAsk(false); setMoveMsg('') } }, '算了')),
              moveMsg ? h('p', { className: 'hint' }, moveMsg) : null))

      const dataPage = h('div', { className: 'page' },
        group('数据在哪',
          '一个文件夹装全部。想备份、想搬走、想看原始记录，都在这一格里。',
          h('div', null,
            h('p', { className: 'dim' }, '文件夹里的「说明.md」写了每个文件是什么。'),
            h('div', { className: 'row' },
              h('button', {
                disabled: !dataPaths?.root,
                onClick: () => copyPath(dataPaths?.root || ''),
              }, dataPaths?.root ? '复制数据文件夹路径' : '路径还没读到')),
            moveCard)),

        group('备份与恢复',
          '备份是一份 json：事件流、配置、日记、她的房间、头像都在里面。换台机器，或者想重开一局之前，先存一份。',
          h('div', null,
            h('p', { className: 'hint' }, '不含运行日志和旧备份。'),
            // owner.json 原样在包里（主人身份和 B 站登录 cookie）。备份能发出去、能放网盘，
            // 所以这件事要写在按钮旁边，不能只在迁移卡里提一句。
            h('p', { className: 'hint' }, '也含主人身份和 B 站登录凭据（登录过的话）。拿到这份文件就能用你的 B 站登录，别随手发给别人。'),
            backupMsg ? h('p', { className: 'hint' }, backupMsg) : null,
            restoreBad
              ? h('div', { style: { marginTop: '10px' } },
                  h('p', { className: 'dim' }, `这份备份里有 ${restoreBad.count} 个文本文件读出来是碎字（早先导出时丢过字节，不是这次弄坏的）：`),
                  h('p', { className: 'hint' }, someOf(restoreBad.files, restoreBad.count)),
                  h('p', { className: 'hint' }, '现在的档什么都没动。可以跳过这些文件、其余照常恢复；也可以先不动。'),
                  h('div', { className: 'row' },
                    h('button', { disabled: backupBusy, onClick: () => pushRestore(restoreBad.obj, true) }, '跳过这些文件继续恢复'),
                    h('button', {
                      disabled: backupBusy,
                      className: 'ghost',
                      onClick: () => { setRestoreBad(null); setBackupMsg('') },
                    }, '先不动')))
              : null),
          h('div', { className: 'row' },
            h('button', { disabled: backupBusy, onClick: backupNow }, '备份成一份文件'),
            h('button', { disabled: backupBusy, onClick: restoreFromFile }, '从备份恢复')),
          h('p', { className: 'hint' }, '恢复不会覆盖删除：现在的档会整体改名到 dsh-fish-backups/pre-restore-<时间>，写坏了还能换回来。')),

        groupFull('每日报告',
          '她醒过的日子各有一份；点日期看那天的。',
          !reports.dates.length
            ? h('p', { className: 'empty' }, '还没有报告，她醒过一次之后才有。')
            : h('div', null,
                h('div', { className: 'row', style: { marginBottom: '8px', flexWrap: 'wrap' } },
                  ...reports.dates.map((d) => h('button', {
                    key: d,
                    disabled: busy === 'rep',
                    onClick: async () => {
                      setBusy('rep')
                      try { setReports(await jget(`/reports?date=${d}`)) } catch (e) { setErr(e.message) } finally { setBusy('') }
                    },
                    style: d === reports.date ? { borderColor: 'var(--dsw-alias-state-business-primary)' } : undefined,
                  }, d))),
                h('div', { className: 'row', style: { flexWrap: 'wrap' } },
                  h('button', { onClick: () => setShowReport(!showReport) }, showReport ? '收起报告' : '展开报告'),
                  h('button', { onClick: downloadReport }, '导出报告'),
                  h('button', {
                    title: '点了只是把这个文件夹的路径复制到剪贴板（不会弹窗口）——粘到资源管理器地址栏回车就能打开。',
                    onClick: () => copyPath(dataPaths?.out || ''),
                  }, '查看文件夹')),
                showReport && reports.md ? h('pre', { style: { marginTop: '8px', maxHeight: '320px', overflow: 'auto' } }, reports.md) : null)),

        // ---- 运行日志导出 ----
        // 为什么单独一张卡：她某晚没说话、没刷站、没写日记，只看状态页是猜不出来的。
        // 三件事分开做——预览（小）、导出（大、纯文本、给 AI 看）、清空（单独一次点击）。
        group('运行日志导出',
          '出问题时导出来发给开发者或 AI；不含 cookie 和她的原话。',
          !logTail ? h('p', { className: 'empty' }, logBusy ? '读取中…' : '还没读。')
            : h('div', null,
                h('p', { className: 'hint' },
                  !logTail.exists
                    ? '还没有日志文件。插件启动一次之后才会有。'
                    : `${logTail.lines?.length || 0} 行 · 上限 ${Math.round((logTail.maxBytes || 0) / 1024 / 1024)}MB · 保留 ${logTail.keep || 0} 份`),
                logTail.lines?.length
                  ? h('div', { style: {
                      maxHeight: '104px', overflowY: 'auto', overflowX: 'hidden',
                      border: '0.5px solid var(--dsw-alias-border-l2)', borderRadius: '8px',
                      padding: '6px 8px',
                    } },
                    h('pre', null, logTail.lines.slice(-200).join(String.fromCharCode(10))))
                  : null),
          h('div', { className: 'row' },
            h('button', {
              onClick: () => {
                setLogBusy(true)
                jget('/log?lines=200').then(setLogTail).catch(() => {}).finally(() => setLogBusy(false))
              },
            }, logBusy ? '读取中…' : '刷新预览'),
            h('button', {
              onClick: () => { window.location.href = API + '/log/export?lines=300' },
            }, '导出日志'),
            h('button', {
              onClick: () => {
                if (!window.confirm('清空当前日志？轮转出的旧日志和导出过的文件不受影响。')) return
                jpost('/log/clear', {}).then(() => jget('/log?lines=40')).then(setLogTail).catch(() => {})
              },
            }, '清空日志')),
          h('p', { className: 'hint' }, '导出的是纯文本：版本、自检结果、脱敏后的配置、日志末尾。没有 cookie，没有她说过的话。')),

        importCard,

        // 宿主旧了（0.8.1）：比升级自检更基础——先告诉它为什么有个功能没反应。
        compatCard,
        hostCard,

        // 升级自检放在最上面：这类问题不报错，只表现为「升了没变」，得先看见它。
        upgradeCard,

        // 换家留痕（0.6.8）：只在「跟上次不一样」时出现。用户改了 cordis.patch.yml 的 root
        // 之后，侧栏会多一间屋、旧的还在——这里直接把两个路径并排摆出来，省得靠猜。
        state?.homes?.changed === true
          ? h('p', { className: 'hint' },
              `这次住的是 ${state.homes.to}；上一次在 ${state.homes.from}。换家不等于搬家——旧家的东西还在原地，没有并过来。`)
          : null,

        archivedCard,

        blockedCard,

        resetCard)

      const showTab = (id) => tab === id


      return h('div', { className: 'dfish', ref: (el) => { topEl = el } },
        h('h2', null, '大肥鱼'),
        h('p', {
          className: 'sub',
          // issue #32：这个数字（counts.total = countEvents().real）从来不只是「她写的」——
          // 她读到的别人说法、开局那份起点、答你的话都在里面。日记不在：日记写在文件里，
          // 事件流只留一条 meta。以前文案写「她记下 N 条」，跟面板上「记下的事」一起被当成了
          // 「她写了 N 条」，于是永远对不上；#59 后续把页头改叫「记录」，跟记忆页同一个叫法。
          // 口径不改（改 real 的定义会动事件流语义与一堆派生数字），把话说清楚。
          title: '事件流里除系统记账以外的条数：她自己写下的（判断、留话、改口、拒绝、梦这些）、对话里回你的话、她读到的别人说法、记下的你的原话、开局那份起点，还有冷落、申请、请求这类替她记下的事。日记写在文件里，每篇只在系统记录里留一行标记，不算在这里。',
        },
          s ? `第 ${s.day} / ${s.growthDays} 天 · ${s.stageName} · 记录 ${s.counts.total} 条${s.counts.meta ? `，另有 ${s.counts.meta} 条系统记录` : ''}` : '读取中…'),
        err ? h('pre', { className: 'err' }, err) : null,
        note ? h('pre', { className: 'ok' }, note) : null,
        // 保存回执只是确认「存到了」，不占页签里的说明位（2026-10-29 用户）。
        autoNote ? h('p', { className: 'ok', style: { margin: '0 0 8px' } }, autoNote) : null,
        // 保存时被跳过的工具名（2026-10-31 issue #14）：和失败框分开——
        // 设置**存下去了**，只是名单里少了几个名字。悄悄少一个是更大的问题，所以必须说出来。
        droppedTools.length
          ? h('div', { className: 'card', style: { margin: '0 0 10px', borderLeft: '3px solid currentColor' } },
              h('div', null, `白名单里有 ${droppedTools.length} 个名字在这台机器上不存在，已经跳过：${droppedTools.join('、')}`),
              h('div', { className: 'dim', style: { marginTop: '4px' } }, '其它设置都存进去了。这些名字可能是以前装的插件留下的，也可能是拼错了。'),
              h('div', { className: 'row', style: { marginTop: '6px' } },
                h('button', {
                  onClick: () => {
                    // 名单里已经没有被丢掉的名字了（服务端存的就是干净那份），
                    // 这里只是把输入框草稿里可能还留着的字一起抹掉，然后收起这条提示。
                    const gone = new Set(droppedTools.map((n) => String(n)))
                    const keep = parseToolNames(toolsAllowText).filter((n) => !gone.has(n))
                    setToolsAllowText(keep.join(', '))
                    setDroppedTools([])
                  },
                }, '也从输入框删掉'),
                h('button', { style: { marginLeft: '8px' }, onClick: () => setDroppedTools([]) }, '知道了')))
          : null,
        // 保存失败是一个要处理的状态，不是提示：一句人话先说清「不是你填错了」，
        // 技术信息另起一行留给开发者，自己点掉。放在页签栏上方，不混进设置项里。
        saveFail
          ? h('div', { className: 'err', style: { margin: '0 0 10px' } },
              // 数字框只在失焦时才收回范围内；打字打到一半越界，也会落到这个框里。那时确实是数填错了。
              // 看的是这一次失败的原因（saveFailRange），不是渲染这一刻输入框里的数。
              h('div', null, saveFailRange
                ? '这个数超出了允许的范围，所以没存。改回下面括号里的范围就会自动再存；已经保存的内容没丢。'
                : '这一项没存上。不是你填错了——已经保存的内容没丢，调整之后再改一次就会重试；实在不行重启 DSH 看看。'),
              h('div', { className: 'dim', style: { marginTop: '4px' } }, `技术信息：${saveFail}`),
              h('div', { className: 'row', style: { marginTop: '6px' } },
                h('button', { onClick: () => setSaveFail('') }, '知道了')))
          : null,
        // 说了话、但系统通知弹不出来时，退到这里。点一下才收起来。
        bubble ? h('div', { className: 'card', style: { borderLeft: '3px solid currentColor' } },
          h('div', { className: 'dim' }, '大肥鱼跟你说话'),
          h('div', { style: { marginTop: '4px' } }, bubble),
          h('div', { className: 'row', style: { marginTop: '6px' } },
            h('button', { onClick: () => setBubble('') }, '知道了'))) : null,

        tabBar,
        AUTO_SAVE_TABS.has(tab) ? h('p', { className: 'hint', style: { margin: '0 0 8px' } },
          tab === 'bili' ? '改完自动保存；uid 和昵称、B 站登录各有自己的保存键。' : '改完自动保存。') : null,
        // 2026-11-12（用户要求）：登录态放在页签顶部、紧跟这句提示，进「上网」第一眼就能看见；
        // 放进「B 站登录」组里要往下滚才看得到。只有明确过期才亮，不抢别的内容。
        tab === 'bili' && biliState && biliState.ok === false && biliState.state !== 'none'
          ? h('div', { className: 'biliwarn', style: { margin: '0 0 10px' } },
            h('strong', null, biliState.state === 'expired' ? 'B 站登录已过期' : '没连上 B 站'),
            h('span', null, biliState.state === 'expired'
              ? '她发不了评论、也收不到 @。请重新扫码，或粘贴一份新的 cookie。'
              : (biliState.note || '检查一下网络，或重新登录。')),
            h('button', {
              onClick: () => { jget('/bili/state').then(setBiliState).catch(() => {}) },
            }, '重新检测'))
          : null,

        showTab('now') ? nowPage : null,
        showTab('grow') ? growPage : null,
        showTab('home') ? homePage : null,
        showTab('bili') ? biliPage : null,
        showTab('memory') ? memoryPage : null,
        showTab('env') ? envPage : null,
        showTab('principle') ? principlePage : null,
        showTab('data') ? dataPage : null,
        showTab('feedback') ? feedbackPage : null,
        showTab('outing') ? outingPage : null,

        // 扫码浮层挂在最外面（不塞进设置页）：切页签时它要么还开着、要么已经关了，
        // 不能因为换了一页就留一张没人认领的码在宿主内存里。
        qrOverlay,
      )
    }


    // ---------------------------------------------------------------- 挂载
    const inject = ['slots']
    const NAMES = { nav: '大肥鱼' }

    function apply(ctx) {
      ctx.effect(
        () =>
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              { name: 'settings.section', id: NS, order: 7, label: () => NAMES.nav },
              FishSection,
            ),
            'dsh-fish: settings section',
          ),
        'dsh-fish: settings section',
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.FishSection = FishSection
    return module.exports
  },
})
