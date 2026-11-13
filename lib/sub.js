/**
 * sub.js —— 工具 `bili_sub`：这条视频里到底说了什么
 *
 * 为什么不是「看全片」：给一条还没长起来的鱼一整套已经组织好的因果链，
 * 她最容易照着走。所以按**句**给，不按篇给——一次最多三句，带时间点，
 * 前因后果她自己拼；拼错了后面还有 consistency / look_back / 冲突卡等着。
 *
 * 三条约束：
 *   1. 片段优先，但能接上：默认只挑几句；她想读完整，就按 from 一页页往后读（每页十来句），
 *      读完为止——不默认注入、不自动喂，她不问就没有。
 *   2. 一级可核对材料：带时间点，引用时要能落到"第几分钟那句"。
 *   3. 允许"不知道"：没有字幕就说没有，拼不出就说拼不出——不拿几句硬凑总结。
 */

import { createClient } from './bili.js'
import { appendEvent, readEvents, readOwner, rootDir } from './store.js'
import { loadConfig, biliOn } from './settings.js'
import { metaTitle } from './browse.js'
import { defineTool } from './tool.js'
import { guardWrite } from './tenant.js'
import { logLine } from './log.js'
import { toJsonSchema } from './toolschema.js'

/** 一次最多给几句。多了就变成"看全片"了。 */
export const SUB_MAX = 3
/** 每句最多多少字（字幕常整段没标点，太长的切一刀）。 */
export const SUB_TEXT_MAX = 90

/** 秒 → [mm:ss] / [h:mm:ss] */
export function stamp(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  const pad = (n) => String(n).padStart(2, '0')
  return h > 0 ? `[${h}:${pad(m)}:${pad(r)}]` : `[${pad(m)}:${pad(r)}]`
}

/**
 * 字幕没取到时要说的那句话（2026-11-13，外部反馈 BUG-bili-sub-NO_SUB）。
 *
 * 以前三种原因合成一句「这条可能本来没有字幕，也可能 B 站登录过期了」：
 * 追踪的人看到这句，只会去查自己是不是没设对，查不出接口到底回了什么。
 * 现在按 `code` 分开说：
 *   NEED_LOGIN  接口说「要登录才给」——登录还有效，就是设备指纹/风控没放行；
 *               登录失效就是 cookie 过期。两者都告诉她，别让她以为视频没字幕。
 *   SUB_FETCH   轨道地址拿到了，正文没拉下来（地址带 token，会过期）。
 *   NO_SUB      接口说这条本来就没有字幕轨。
 * 认不出 code 的老形状（测试、外部注入的假客户端）退回原来那句。
 */
export function subtitleFailNote(s, { loggedIn = null } = {}) {
  const code = String(s?.code ?? '')
  if (code === 'NEED_LOGIN') {
    if (loggedIn === false) {
      return '没取到字幕：B 站登录过期了（cookie 还在，但已经不认了）。没有就是没有，别猜它说了什么。'
    }
    if (loggedIn === true) {
      return '没取到字幕：登录是有效的，但 B 站没把这条的字幕轨给这次请求（设备指纹/风控没放行）。没有就是没有，别猜它说了什么。'
    }
    return '没取到字幕：B 站要登录才给这条的字幕轨，这次请求没被认成登录。没有就是没有，别猜它说了什么。'
  }
  if (code === 'SUB_FETCH') {
    return '没取到字幕：B 站给了字幕轨的地址，正文没拉下来（地址会过期）。没有就是没有，别猜它说了什么。'
  }
  if (code === 'NO_SUB') {
    return '没取到字幕：这条本来就没有字幕轨。没有就是没有，别猜它说了什么。'
  }
  return '没取到字幕：这条可能本来没有字幕，也可能 B 站登录过期了。没有就是没有，别猜它说了什么。'
}

/**
 * 字幕轨是碎句（一句常常只有几个字）。先按标点拼成整句，
 * 没有标点的长句再按上限切。返回 [{ t, text }]。
 */
export function mergeLines(lines, { max = SUB_TEXT_MAX } = {}) {
  const out = []
  let buf = ''
  let at = 0
  const flush = () => {
    const text = buf.trim()
    if (text) out.push({ t: at, text: text.slice(0, max) })
    buf = ''
  }
  for (const line of lines ?? []) {
    const text = String(line?.text ?? '').trim()
    if (!text) continue
    if (!buf) at = Number(line?.t) || 0
    buf = buf ? `${buf}${text}` : text
    if (/[。！？!?]$/.test(buf) || buf.length >= max) flush()
  }
  flush()
  return out
}

/** 查询词与句子的重合度：按两字切片算覆盖率，够用就行（不引向量）。 */
function overlap(query, text) {
  const q = String(query ?? '').replace(/\s+/g, '')
  if (q.length < 2) return 0
  const grams = new Set()
  for (let i = 0; i < q.length - 1; i += 1) grams.add(q.slice(i, i + 2))
  if (!grams.size) return 0
  let hit = 0
  for (const g of grams) if (text.includes(g)) hit += 1
  return hit / grams.size
}

/**
 * 挑哪几句：带了 query 就挑最对得上的；没带就从开头、中间、靠后各挑一处。
 * 不超过 SUB_MAX 句。
 */
export function pickSnippets(sentences, query = '', { max = SUB_MAX } = {}) {
  const list = Array.isArray(sentences) ? sentences : []
  if (!list.length) return []
  const q = String(query ?? '').trim()
  if (q) {
    const ranked = list
      .map((s, i) => ({ s, i, sim: overlap(q, s.text) }))
      .filter((x) => x.sim > 0)
      .sort((a, b) => b.sim - a.sim || a.i - b.i)
    if (ranked.length) {
      return ranked.slice(0, max).map((x) => x.s).sort((a, b) => a.t - b.t)
    }
  }
  const n = Math.min(max, list.length)
  const picked = []
  for (let k = 0; k < n; k += 1) {
    const idx = n === 1 ? 0 : Math.round((k * (list.length - 1)) / (n - 1))
    picked.push(list[idx])
  }
  return picked.filter((v, i, a) => a.indexOf(v) === i)
}

/** 想把一整条读下去时，一页给几句（约 300–600 字，读完为止）。 */
export const SUB_PAGE = 12
export const SUB_PAGE_CHARS = 700

/** "mm:ss" / "h:mm:ss" / 秒数 → 秒；认不出来返回 null。 */
export function parseFrom(v) {
  if (v === undefined || v === null || v === '') return null
  if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, Math.floor(v))
  const raw = String(v).trim().replace(/^\[|\]$/g, '')
  if (/^\d+$/.test(raw)) return Math.max(0, Number(raw))
  const m = /^(\d{1,3}):(\d{2})(?::(\d{2}))?$/.exec(raw)
  if (!m) return null
  const a = Number(m[1])
  const b = Number(m[2])
  const c = m[3] === undefined ? null : Number(m[3])
  return c === null ? a * 60 + b : a * 3600 + b * 60 + c
}

/**
 * 从某一秒开始，往后取一页（不超过 SUB_PAGE 句、不超过 SUB_PAGE_CHARS 字）。
 * 返回 { page, next, done }；next 是下一页的起点（秒），读完是 null。
 */
export function pickPage(sentences, from = 0, { max = SUB_PAGE, maxChars = SUB_PAGE_CHARS } = {}) {
  const list = Array.isArray(sentences) ? sentences : []
  const start = Math.max(0, Math.floor(Number(from) || 0))
  let i = list.findIndex((s) => Number(s.t) >= start)
  if (i < 0) return { page: [], next: null, done: true }
  const page = []
  let chars = 0
  for (; i < list.length && page.length < max; i += 1) {
    const len = String(list[i].text).length
    if (page.length && chars + len > maxChars) break
    page.push(list[i])
    chars += len
  }
  const done = i >= list.length
  let next = done ? null : Number(list[i]?.t) || null
  // 同一秒里挤着好几句时，游标可能原地打转；往后挪一秒，宁可漏半句也不要死循环。
  if (next !== null && page.length && next <= page[page.length - 1].t) {
    next = page[page.length - 1].t + 1
  }
  return { page, next, done }
}

/** 渲染一页。页尾告诉她怎么接着读，读完就说读完了。 */
export function renderPage({ page = [], next = null, done = true }, { title = '', auto = true } = {}) {
  const say = auto ? '字幕（自动识别的，可能有错字）' : '字幕'
  const lines = []
  const at = page.length ? stamp(page[0].t) : ''
  lines.push(`${title ? `《${title}》` : '这条'}的${say}。${at} 起的这一页：`)
  for (const s of page) lines.push(`${stamp(s.t)} ${s.text}`)
  if (!done && next !== null) lines.push(`（还没完。想接着读，就再调一次，from 填 ${stamp(next)}。）`)
  else lines.push('（到这里就是最后一句了。）')
  return lines.join('\n')
}

/** 渲染给她的那几行。只标时间与"谁说的"，不出现等级/可信度。 */
export function renderSnippets(picked, { title = '', auto = true, from = null } = {}) {
  const lines = []
  const say = auto ? '字幕（自动识别的，可能有错字）' : '字幕'
  if (from !== null && from !== undefined && Number.isFinite(Number(from))) {
    lines.push(`${title ? `《${title}》` : '这条'}的${say}。${stamp(from)} 往后挑的几句：`)
  } else {
    lines.push(`${title ? `《${title}》` : '这条'}的${say}。这是其中几句，不是整篇：`)
  }
  for (const s of picked) lines.push(`${stamp(s.t)} ${s.text}`)
  if (picked.length < SUB_MAX) lines.push('（一条视频里能挑出来的就这几句。）')
  return lines.join('\n')
}

/** 她已经读到第几页了：数这个视频已有的 `page=` 索引行。 */
export function pagesRead(events, bvid) {
  const head = `subs:${bvid} page=`
  let n = 0
  for (const ev of events ?? []) {
    if (ev?.type !== 'meta') continue
    if (String(ev.text ?? '').startsWith(head)) n += 1
  }
  return n
}

/**
 * 调一次「查字幕」。永不抛出（与 lookOnce 同一条约定）。
 *
 * @param {object} o
 * @param {string} o.bvid
 * @param {string} [o.query]
 * @param {string|number} [o.from] 从这一秒起按顺序读一页；不填就只挑三句
 * @param {object} [o.client]
 * @param {object} [o.cfg]
 * @param {string} [o.root]
 * @param {object} [o.model] deriveSelf 结果（只为记 day/stage）
 * @returns {Promise<{ok:boolean,text:string,note:string,snippets:object[]}>}
 */
export async function subOnce(o = {}) {
  const root = o.root ?? rootDir()
  const bvid = String(o.bvid ?? '').trim()
  const query = String(o.query ?? '').trim()
  const cfg = o.cfg ?? (await loadConfig(root)).config
  if (!biliOn(cfg)) {
    logLine('info', ['查字幕：设置里关掉了 B 站'], root)
    return { ok: false, text: '', note: '现在打不开。', snippets: [] }
  }
  // 和上网总闸分开：可以让她看标题、看画面，但不想让她读全篇台词。
  if (cfg?.bili?.sub === false) {
    logLine('info', ['查字幕：设置里关掉了读字幕'], root)
    return { ok: false, text: '', note: '字幕现在关着（设置里「允许她读字幕」）。', snippets: [] }
  }
  if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) {
    return { ok: false, text: '', note: '这不是一个视频号。', snippets: [] }
  }

  // 字幕要登录（bili.js 的文件头就写着：AI 字幕在"需登录"那一栏）。
  // 匿名能取到 cid，但取不到字幕轨——与其让她看到"这条没字幕"这种误导的话，
  // 不如在没 cookie 的时候直接说清楚。带 o.client 的调用方自己负责（测试、宿主注入）。
  let cookie = ''
  if (!o.client) {
    const ow = await readOwner(root).catch(() => null)
    cookie = String(ow?.cookie ?? '').trim()
    if (!cookie) {
      return {
        ok: false,
        text: '',
        note: '字幕要 B 站登录才能查（设置里贴一份 cookie）。没有登录，就别猜它说了什么。',
        snippets: [],
      }
    }
  }

  const client = o.client ?? createClient({ ...(cfg?.bili ?? {}), cookie })
  let view
  try {
    view = await client.view(bvid)
  } catch (err) {
    return { ok: false, text: '', note: `打不开这条：${String(err?.message ?? err).slice(0, 80)}`, snippets: [] }
  }
  if (!view?.ok) {
    return { ok: false, text: '', note: `打不开这条：${view?.message ?? '不知道原因'}`, snippets: [] }
  }
  const cid = view.data?.cid
  if (!cid) return { ok: false, text: '', note: '这条取不到分P信息。', snippets: [] }

  let s
  try {
    s = await client.subtitle(bvid, cid)
  } catch (err) {
    return { ok: false, text: '', note: `字幕没取到：${String(err?.message ?? err).slice(0, 80)}`, snippets: [] }
  }
  if (!s?.ok || !Array.isArray(s.data) || !s.data.length) {
    // 只有「接口说要登录」时再问一次登录状态：失败路径才多这一请求，正常取到字幕不会问。
    let loggedIn = null
    if (String(s?.code ?? '') === 'NEED_LOGIN' && typeof client.whoami === 'function') {
      try {
        const w = await client.whoami()
        loggedIn = w?.ok ? Boolean(w.isLogin) : null
      } catch {
        loggedIn = null
      }
    }
    return { ok: false, text: '', note: subtitleFailNote(s, { loggedIn }), snippets: [] }
  }

  const sentences = mergeLines(s.data)
  if (!sentences.length) return { ok: false, text: '', note: '字幕是空的。', snippets: [] }
  const title = metaTitle(view.data?.title)
  const wantFrom = parseFrom(o.from)
  let text
  let picked
  let page = null
  let note = ''
  if (wantFrom !== null && query) {
    // 从这一秒往后找对得上的句子：她想找"后半段讲价格的那句"，不用从头翻十页。
    const rest = sentences.filter((s) => Number(s.t) >= wantFrom)
    const hits = rest
      .map((s, i) => ({ s, i, sim: overlap(query, s.text) }))
      .filter((x) => x.sim > 0)
      .sort((a, b) => b.sim - a.sim || a.i - b.i)
      .slice(0, SUB_MAX)
      .map((x) => x.s)
      .sort((a, b) => a.t - b.t)
    if (hits.length) {
      picked = hits
      text = renderSnippets(hits, { title, from: wantFrom })
    } else {
      note = `从 ${stamp(wantFrom)} 往后没有对得上「${query}」的句子，给你这一页。`
    }
  }
  if (text === undefined) {
    if (wantFrom !== null) {
      page = pickPage(sentences, wantFrom)
      if (!page.page.length) {
        return { ok: false, text: '', note: '这一页没有内容——可能已经读到末尾了。', snippets: [] }
      }
      picked = page.page
      text = renderPage(page, { title })
    } else {
      picked = pickSnippets(sentences, query)
      text = renderSnippets(picked, { title })
    }
  }

  const who = {
    day: Number(o.model?.day ?? 0),
    stage: Number(o.model?.stage ?? 1),
    source: 'system',
  }
  // 只记一行索引：她翻得回"我查过这条的字幕"，正文留在这次结果里。
  // 翻页的行带 page=N / done=0|1，她下回自己看得出读到哪儿了。
  let seen = []
  try {
    seen = (await readEvents(root)).events
  } catch {
    seen = []
  }
  const pages = pagesRead(seen, bvid)
  const index = page
    ? `subs:${bvid} page=${pages + 1} done=${page.done ? 1 : 0}${title ? ` ${title}` : ''}`
    : `subs:${bvid}${title ? ` ${title}` : ''}`
  await appendEvent({ type: 'meta', text: index }, who, root).catch(() => {})

  if (!page && !note && query && picked.length && !picked.some((p) => overlap(query, p.text) > 0)) {
    note = `没找到和「${query}」正面对得上的句子，给你开头和中段各一句。`
  }
  const pageInfo = page ? { next: page.next, done: page.done, count: picked.length, page: pages + 1 } : null
  return { ok: true, text, note, snippets: picked, page: pageInfo }
}

export function registerSub(ctx, deps = {}) {
  const root = deps.root ?? rootDir()

  return ctx.tools.register(
    defineTool({
      name: 'bili_sub',
      description:
        '你只看了标题、简介或画面，却想知道这条视频里到底说了哪几句的时候，用这个。' +
        '给它一个视频号（BV 号或链接），它去取字幕，按句切好、带上时间点给你；' +
        '可以再带一个词（query），只要和这个词对得上的句子。一次最多三句，是片段，不是整篇。' +
        '想知道这一整条到底讲了什么，就一页页读：先要一句几句，想接着读，把上一页最后那句的时间填进 from，' +
        '每次十来句，读到它说「最后一句了」为止——别一次就把整篇要过来。' +
        '字幕是平台自动识别的，可能有错字，引用的时候要说清楚是「字幕（自动）」。' +
        '它说没有字幕，就是这条没有，别猜内容；几句话拼不出前因后果，就说拼不出来，别硬凑一个总结。' +
        '不用它也可以。',
      parameters: toJsonSchema({
        bvid: { type: 'string', required: true, description: '哪条视频（形如 BV1xx411c7mD，或{T}递过来的链接）。' },
        query: {
          type: 'string',
          required: false,
          description: '可选：你想知道的那件事的一个词或一小句（比如「定价」「为什么退出」）。不带就给你开头、中间、靠后各一句。',
        },
        from: {
          type: 'string',
          required: false,
          description: '可选：从第几分钟接着读（比如 "03:20"）。填了它就按顺序给你这一页，不再挑三句；上一页最后那句的时间就是它。',
        },
      }),
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            text: { type: 'string', description: '带时间点的几句字幕' },
            note: { type: 'string' },
          },
          required: ['ok', 'text', 'note'],
        },
        render: (_args, out) => [{ type: 'text', text: out.ok ? out.text : `这次没看到字幕：${out.note}` }],
      },
      async execute(args, exec) {
        const who = guardWrite(tenancyOf(root, deps.tenant), exec, 'bili_sub')
        if (!who.ok) return { ok: false, text: '', note: who.note }

        const r = await subOnce({
          bvid: args?.bvid,
          query: args?.query,
          from: args?.from,
          client: deps.client,
          root,
          model: deps.model,
        })
        return { ok: r.ok, text: r.text, note: r.note }
      },
    }),
  )
}

/** 没有 tenancy（单测、老调用）时自己拼一个，理由同 look.js 的 tenancyOf。 */
function tenancyOf(root, tenancy) {
  if (tenancy && typeof tenancy === 'object') {
    return { root, herDir: String(tenancy.herDir ?? ''), tenant: tenancy.tenant ?? { ok: true } }
  }
  return { root, herDir: '', tenant: { ok: true } }
}
