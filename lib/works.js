/**
 * works.js —— 她留下的东西（2026-11-16，1.0.4）
 *
 * 由来：doing（lib/doing.js）记的是「今天干了什么」——一行 `did:consume:…`，
 * 一件做完就过去了。但用户要的是另一样东西：她**留下了什么**。
 * 一张自己写的文案、一幅画、一段曲子、一个她反复改的方案——它有名字、
 * 能出第二版、能没做完、能被回头看。这是「说」和「干了点什么」之外的一层。
 *
 * 为什么单独一个账，不并进 doing / notes：
 *   doing 是流水，note 是待办，日记是给自己看的记录。
 *   作品是**做出来的东西本身**——正文在 `works/<id>/vN-标题.md`，账里只有索引。
 *
 * 五条边界（用户 2026-11-16 拍板）：
 *   1. **不进事件流**。和 notes.json / appointments.json 一条线：它不参与成长判定，
 *      derive.js 不该看见它。作品多一件，不等于她长大一点。
 *   2. **只留在家里**。默认落点是她自己的工作目录；要发出去（发评论、发动态），
 *      得用户自己点头，这条路这个模块不开。
 *   3. **被看见不改变任何事**。用户点开只是读，账里不记、她不知道、桌上不摆、
 *      不计分、不催下一版——「他看过了」本身就会把留下的东西变成交出去的东西。
 *   4. **不评分、不报进度**。没有好坏分数；也不写「今天做了几件」「还差多少」，
 *      只有这一版本身。她跟人说的只有「有这么一件东西」，不是进度条。
 *   5. **上限全是硬的，而且故意很松**：一天最多一件新的、一周最多三件新的、
 *      一天最多改两版、同时最多两件在手、一件 2000 字。到顶就说不行——
 *      这条线是为了不让她变成刷量的，不是催她产出。
 *
 * 落盘形状（照 keepsake.js 的范式）：台账在根目录，正文在子目录。
 *   works.json          { version:1, items:[...] }
 *   works/<id>/v1-标题.md
 *   works/<id>/v2-标题.md   ← 改过的第二版，第一版不覆盖
 */

import { join, extname, isAbsolute, resolve } from 'node:path'
import { readFile, copyFile, mkdir, stat } from 'node:fs/promises'
import { paths, readJson, writeAtomic, mutateJson } from './store.js'
import { dateKey } from './settings.js'
import { clipText, cleanText } from './clip.js'

/** 名字最多四十个字。再长列表里就摆不下了。 */
export const WORK_TITLE_MAX = 40
/** 一版正文最多两千字。够了——比这长的东西她也一次写不完。 */
export const WORK_TEXT_MAX = 2000
/** 手上最多同时两件在弄的。第三件会被挡回去。 */
export const WORK_WIP_MAX = 2
/** 一天最多起一件新的。 */
export const WORK_PER_DAY = 1
/** 一周最多起三件新的（按最近七天算）。 */
export const WORK_NEW_PER_WEEK = 3
/** 一件东西一天最多改两版。 */
export const WORK_VERSIONS_PER_DAY = 2
/** 账里最多两百件**还留着的**。放下的不算占地方——内容还在，但不挡新的。 */
export const WORK_TOTAL_MAX = 200
/** 列表里那行摘要的长度。 */
export const WORK_LINE = 120
/** 一页最多摆这么多件。 */
export const WORK_LIST_MAX = 30
/** 手上那件多久没动就不再说「摊着」了，改说「有些天没动了」。不是不摆，是不装成今天还在弄。 */
export const WORK_DESK_DAYS = 14
/** 一件作品带的文件最多二十兆，跟出门带回来的东西同一条线。 */
export const WORK_FILE_MAX_BYTES = 20 * 1024 * 1024

const DAY = 24 * 60 * 60 * 1000
const FILE = 'works.json'
const DIR = 'works'
const STATE_TEXT = { wip: '还在弄', done: '收起来了', dropped: '放下了' }

/**
 * 作品类型：她手边有什么工具，就可能留下什么。
 *   文字 → 正文；图/声音/影像/文件 → 一份她自己做出来的文件，正文位置放说明。
 */
const KIND_BY_EXT = {
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.webp': 'image', '.gif': 'image',
  '.avif': 'image', '.bmp': 'image', '.svg': 'image',
  '.mp3': 'audio', '.wav': 'audio', '.m4a': 'audio', '.ogg': 'audio', '.flac': 'audio',
  '.mp4': 'video', '.webm': 'video', '.mov': 'video',
}
export const KIND_TEXT = { text: '文字', image: '图', audio: '声音', video: '影像', file: '文件' }

/** 按扩展名猜类型。猜不出来当普通文件——不假装它是图。 */
export function kindOfPath(p) {
  return KIND_BY_EXT[extname(String(p ?? '')).toLowerCase()] || 'file'
}

/**
 * 把「做出来的那份文件」找出来。
 *
 * 路径可能是她所在会话的 cwd（home/）下的相对路径，也可能是工具给的绝对路径。
 * 只做两件事：确认它是文件、确认它没超过上限；真正的复制在锁里做。
 * 为什么允许 home 之外的绝对路径：画图/剪辑这类工具的输出目录由工具决定，
 * 不一定是她的屋子；不认就等于「放行了工具也留不下东西」。
 */
async function resolveArtifact(root, file) {
  const raw = String(file ?? '').trim()
  if (!raw) return { ok: true, abs: '', kind: 'text', bytes: 0 }
  // 相对路径按两种习惯试：从她自己的屋子算（home/x.png），
  // 和从根算（home/drawings/x.png、works/<id>/v1-….md）。
  // 工具返回的路径常常是后者，她照着抄过来——只认一种会白丢一次。
  const bases = isAbsolute(raw)
    ? [raw]
    : [resolve(paths(root).herDir, raw), resolve(root, raw)]
  let sawDir = false
  for (const abs of bases) {
    try {
      const st = await stat(abs)
      if (!st.isFile()) { sawDir = true; continue }
      if (st.size > WORK_FILE_MAX_BYTES) {
        return { ok: false, note: `这个文件太大了（超过 ${Math.round(WORK_FILE_MAX_BYTES / 1024 / 1024)}MB）。` }
      }
      return { ok: true, abs, kind: kindOfPath(abs), bytes: st.size }
    } catch {
      // 这一种算法下没有，换下一种
    }
  }
  if (sawDir) return { ok: false, note: '那个路径不是一个文件。' }
  return { ok: false, note: '翻不到那个文件。给绝对路径，或者从自己屋子算起的相对路径。' }
}

export function worksFile(root) {
  return join(root, FILE)
}

export function worksDir(root) {
  return join(root, DIR)
}

/** 一件东西的目录：works/<id>/。 */
export function workDir(root, id) {
  return join(worksDir(root), String(id))
}

/** 空账 / 坏账都当空的用——读永远不抛。 */
function sane(raw) {
  const items = Array.isArray(raw?.items) ? raw.items.filter((it) => it && it.id) : []
  return { version: 1, items }
}

export async function readWorks(root) {
  try {
    return sane(await readJson(worksFile(root), null))
  } catch {
    return sane(null)
  }
}

function byUpdated(a, b) {
  return (Number(b?.updatedAt) || 0) - (Number(a?.updatedAt) || 0)
}

/** 全部，最近的在前。 */
export async function worksOf(root) {
  const db = await readWorks(root)
  return db.items.slice().sort(byUpdated)
}

/** 一句话摘要：换行压成空格，截到 WORK_LINE。 */
function oneLine(text) {
  const t = cleanText(String(text ?? '')).replace(/\s*\n+\s*/g, ' ').trim()
  return clipText(t, WORK_LINE)
}

/** 文件名里不能有的字符换掉；中文照留（Windows 没问题）。 */
function slugFor(title) {
  const s = String(title ?? '')
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, WORK_TITLE_MAX)
  return s || '无题'
}

/**
 * 名字比对用的键：去掉书名号、引号、空白。
 * 她记东西不用 id，只说「《那条广告》」——所以按名字找是主路径，id 是备选。
 */
function keyOf(text) {
  return String(text ?? '')
    .replace(/[《》〈〉「」『』【】“”"'’]/g, '')
    .replace(/\s+/g, '')
    .trim()
}

/**
 * 按 id 或名字找一件。名字只认**精确**（去掉书名号、引号、空白之后）。
 *
 * 为什么不做「包含也算」：`《一件》` 和 `《另一件》` 一包含就把后者吞成前一版的第二版，
 * 她会以为自己在改旧东西，其实把一件新东西写丢了。宁可找不到、让她看一眼 list 再写对名字，
 * 也不要悄悄改错东西。
 */
export function findWork(items, wanted) {
  const list = Array.isArray(items) ? items : []
  const raw = String(wanted ?? '').trim()
  if (!raw) return null
  const byId = list.find((it) => it.id === raw)
  if (byId) return byId
  const k = keyOf(raw)
  if (!k) return null
  const exact = list.filter((it) => keyOf(it.title) === k).sort(byUpdated)
  return exact[0] ?? null
}

function versionOf(item) {
  return Array.isArray(item?.versions) ? item.versions.length : 1
}

function fileText({ title, intent, version, at, body }) {
  const d = new Date(at)
  const when = Number.isFinite(d.getTime())
    ? `${dateKey(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    : ''
  const head = [`# ${title}`, '', `第 ${version} 版${when ? ` · ${when}` : ''}`]
  if (intent) head.push('', `想做成：${intent}`)
  return `${head.join('\n')}\n\n---\n\n${body}\n`
}

/**
 * 留一件东西，或者给一件旧东西出下一版。
 *
 * @param {string} root
 * @param {object} o
 * @param {string} o.title   名字（改版时用它指认原来那件）
 * @param {string} o.text    正文，或者对做出来的那份东西的说明（图/音/影像可以是空的）
 * @param {string} [o.file]  做出来的那份文件（绝对路径，或从她屋子算起的相对路径）
 * @param {string} [o.intent] 想把它做成什么样（一句话）
 * @param {string} [o.basedOn] 也可以给 id
 * @param {string[]} [o.refs] 做它的时候她说的那几句话（事件 id）
 * @param {boolean} [o.newName] 改版时顺手换个名字（默认不换）
 * @param {number} [o.now]
 * @returns {Promise<{ok:boolean,id?:string,version?:number,state?:string,note:string}>}
 */
export async function makeWork(root, {
  title,
  text,
  file = '',
  intent = '',
  basedOn = '',
  refs = [],
  newName = false,
  now = Date.now(),
} = {}) {
  const t = String(title ?? '').trim()
  const body = cleanText(String(text ?? '')).trim()
  const aim = oneLine(intent)
  const art = await resolveArtifact(root, file)
  if (!art.ok) return { ok: false, note: art.note }
  if (!t) return { ok: false, note: '得给它一个名字（title），不然以后翻不到。' }
  if (t.length > WORK_TITLE_MAX) return { ok: false, note: `名字太长了，${WORK_TITLE_MAX} 个字以内。` }
  if (!body && !art.abs) return { ok: false, note: '东西是空的。写下来，或者把做好的那一份的文件路径给 file。' }
  if (body.length > WORK_TEXT_MAX) {
    return { ok: false, note: `一次最多 ${WORK_TEXT_MAX} 个字。先把开头放下，剩下的下一版再接。` }
  }

  const db = await readWorks(root)
  const at = Number(now)
  const dk = dateKey(new Date(at))

  // 全部校验与写盘都放在同一把锁里：她可能在同一轮里同时发两个 her_make，
  // 版本号、上限、文件名都必须按「锁里的那一份账」算，不能按锁外的快照算。
  let out = { ok: false, note: '没写成。' }
  await mutateJson(worksFile(root), async () => {
    const fresh = await readWorks(root)
    const wanted = basedOn || t
    // 换名字（newName）不另起一件：还是同一件东西长到了下一版，只是改了名。
    // 另起一件会把「改了十遍」拆成十个陌生人，回头看不见它是怎么长出来的。
    const parent = findWork(fresh.items, wanted)
    if (!parent && basedOn) {
      out = { ok: false, note: '翻不到叫这个名字的旧东西。要么给 id，要么不带 based_on 单独留一件。' }
      return
    }
    // 「堆到两百件」只算还留着的：放下的一直在账里（内容不删），但不占地方。
    // 不然「放不下」那句会变成死胡同——她能做的只有放下，而放下并不腾地方。
    const kept = fresh.items.filter((it) => it.state !== 'dropped').length
    if (kept >= WORK_TOTAL_MAX) {
      out = { ok: false, note: `家里已经留了 ${WORK_TOTAL_MAX} 件了。放下几件以前不想再弄的，它们就不占地方了。` }
      return
    }
    // 一天一件新的、一周三件新的：按**建件**的本地日期数，改版另算。
    if (!parent) {
      const bornToday = fresh.items.filter((it) => dateKey(new Date(Number(it.createdAt) || 0)) === dk).length
      if (bornToday >= WORK_PER_DAY) {
        out = { ok: false, note: '今天已经起过一件了。想接着弄，就改手上那件；不然搁到明天。' }
        return
      }
      const bornThisWeek = fresh.items.filter((it) => (
        Math.max(Number(it.createdAt) || 0, 0) >= at - 7 * DAY
      )).length
      if (bornThisWeek >= WORK_NEW_PER_WEEK) {
        out = { ok: false, note: '这七天里起的东西够多了。先把手上的弄完，或者搁一搁。' }
        return
      }
    }
    // 改版也有一天上限：一天两版，急事也一样。
    const versionsToday = fresh.items.reduce((n, it) => (
      n + (Array.isArray(it.versions) ? it.versions.filter((v) => dateKey(new Date(Number(v?.at) || 0)) === dk).length : 0)
    ), 0)
    if (parent && versionsToday >= WORK_VERSIONS_PER_DAY) {
      out = { ok: false, note: `今天已经改过 ${WORK_VERSIONS_PER_DAY} 版了。剩下的明天再动。` }
      return
    }
    if (!parent) {
      const wip = fresh.items.filter((it) => it.state === 'wip')
      if (wip.length >= WORK_WIP_MAX) {
        out = {
          ok: false,
          note: `手上还摊着 ${wip.length} 件（${wip.map((w) => `《${w.title}》`).join('、')}）。先弄它们，或者放下其中一件。`,
        }
        return
      }
    }

    const version = parent ? versionOf(parent) + 1 : 1
    const workId = parent ? parent.id : `w-${at}-${Math.random().toString(16).slice(2, 6)}`
    const finalTitle = parent && !newName ? String(parent.title || t) : t
    const kind = art.abs ? art.kind : 'text'
    let rel = ''
    if (art.abs) {
      // 她做出来的那份文件原样搬进 works/<id>/，不引用外部路径：
      // 工具的输出目录常是临时的，过两天被清掉，引用它等于没留下。
      const ext = extname(art.abs).toLowerCase() || '.bin'
      rel = join(DIR, workId, `v${version}-${slugFor(finalTitle)}${ext}`).split('\\').join('/')
      // copyFile 不会自己建目录（writeAtomic 会）——先建好，再搬。
      await mkdir(join(root, DIR, workId), { recursive: true })
      await copyFile(art.abs, join(root, rel))
    } else {
      rel = join(DIR, workId, `v${version}-${slugFor(finalTitle)}.md`).split('\\').join('/')
      await writeAtomic(join(root, rel), fileText({ title: finalTitle, intent: aim || parent?.intent || '', version, at, body }))
    }
    // 图/声音/影像的文字部分存成说明（caption），不塞进文件里——
    // 那份文件是她做出来的东西本身，改它就不是她的东西了。
    const versionRow = art.abs
      ? { v: version, at, kind, file: rel, title: finalTitle, chars: body.length, caption: body, bytes: art.bytes }
      : { v: version, at, kind: 'text', file: rel, title: finalTitle, chars: body.length }

    const patch = (item) => ({
      ...item,
      title: finalTitle,
      intent: aim || item?.intent || '',
      kind,
      state: 'wip',
      updatedAt: at,
      day: item?.day || dk,
      line: oneLine(body) || `（${KIND_TEXT[kind] || KIND_TEXT.file}）`,
      refs: Array.isArray(refs) && refs.length ? refs.slice(0, 6) : item?.refs || [],
      versions: [
        ...(Array.isArray(item?.versions) ? item.versions : []),
        versionRow,
      ],
    })

    if (parent) {
      const idx = fresh.items.findIndex((it) => it.id === parent.id)
      // 两次写撞在一起时，parent 可能已经被删了：退化成新的一件，不丢内容。
      if (idx >= 0) {
        fresh.items[idx] = patch(fresh.items[idx])
        await writeAtomic(worksFile(root), JSON.stringify({ version: 1, items: fresh.items }))
        out = {
          ok: true,
          id: workId,
          version,
          state: 'wip',
          note: `《${finalTitle}》改了第 ${version} 版。`,
        }
        return
      }
    }
    const item = patch({
      id: workId,
      title: finalTitle,
      intent: aim,
      state: 'wip',
      day: dk,
      createdAt: at,
      updatedAt: at,
      finishedAt: 0,
      basedOn: '',
      line: oneLine(body),
      refs: Array.isArray(refs) ? refs.slice(0, 6) : [],
      versions: [],
    })
    fresh.items = [...fresh.items.filter((it) => it.id !== workId), item]
    await writeAtomic(worksFile(root), JSON.stringify({ version: 1, items: fresh.items }))
    out = {
      ok: true,
      id: workId,
      version: 1,
      state: 'wip',
      note: `留下了《${finalTitle}》。`,
    }
  })
  return out
}

/**
 * 收一件，或者放下。
 * @param {'done'|'dropped'} state
 */
export async function closeWork(root, { title, state = 'done', reason = '', now = Date.now() } = {}) {
  const wanted = String(title ?? '').trim()
  if (!wanted) return { ok: false, note: '要说是哪一件（title）。' }
  const why = oneLine(reason)
  if (state === 'dropped' && !why) {
    // 放下总得说一句为什么：以后桌上摆出来、日报里写一笔时，
    // 「为什么没弄了」比「没弄完」有用得多。
    return { ok: false, note: '放下的时候说一句为什么（reason）。' }
  }
  let out = { ok: false, note: '翻不到叫这个名字的东西。' }
  await mutateJson(worksFile(root), async () => {
    const db = await readWorks(root)
    const item = findWork(db.items, wanted)
    if (!item) return
    const at = Number(now)
    item.state = state === 'dropped' ? 'dropped' : 'done'
    item.updatedAt = at
    if (item.state === 'done') item.finishedAt = at
    else item.droppedAt = at
    if (why) item.droppedReason = why
    await writeAtomic(worksFile(root), JSON.stringify({ version: 1, items: db.items }))
    out = {
      ok: true,
      id: item.id,
      state: item.state,
      note: item.state === 'done' ? `《${item.title}》收了尾。` : `《${item.title}》放下了。`,
    }
  })
  return out
}

/** 读回某一版的正文。她回头改之前得先看见自己上次写了什么。 */
export async function readWorkText(root, { title = '', id = '', version = 0 } = {}) {
  const db = await readWorks(root)
  const item = findWork(db.items, id || title)
  if (!item) return { ok: false, note: '翻不到这件东西。' }
  const versions = Array.isArray(item.versions) ? item.versions : []
  const asked = Number(version) > 0
  const want = asked ? Number(version) : versionOf(item)
  const one = versions.find((v) => Number(v?.v) === want)
  if (asked && !one) {
    // 要第 9 版却只有两版：明说，不要拿最后一版冒充——她会以为自己在改那一版。
    return { ok: false, note: `《${item.title}》没有第 ${want} 版，一共 ${versions.length || 1} 版。` }
  }
  const use = one ?? versions[versions.length - 1]
  if (!use?.file) return { ok: false, note: '这一版没有落盘。' }
  const kind = String(use.kind || item.kind || 'text')
  let text = String(use.caption ?? '')
  if (kind === 'text') {
    try {
      text = await readFile(join(root, use.file), 'utf8')
    } catch {
      return { ok: false, note: '这一版的文件翻不到了。' }
    }
  }
  return {
    ok: true,
    id: item.id,
    title: item.title,
    version: Number(use.v) || versionOf(item),
    versions: versions.map((v) => Number(v?.v) || 0),
    state: item.state,
    kind,
    file: String(use.file),
    intent: String(item.intent ?? ''),
    text,
    note: '',
  }
}

/** 给界面用：标题、第几版、状态、一句话、有没有新的。 */
export async function listWorks(root, { limit = WORK_LIST_MAX } = {}) {
  const items = await worksOf(root)
  return items.slice(0, Math.max(1, Math.min(WORK_LIST_MAX, Number(limit) || WORK_LIST_MAX))).map((it) => ({
    id: it.id,
    title: it.title,
    state: it.state || 'wip',
    stateText: STATE_TEXT[it.state] || STATE_TEXT.wip,
    version: versionOf(it),
    // 界面要能点开旧版：给的是版本号列表（[1,2,3]），不是个数。
    versions: (Array.isArray(it.versions) ? it.versions : []).map((v) => Number(v?.v) || 0).filter(Boolean),
    line: it.line || '',
    kind: it.kind || 'text',
    day: it.day || '',
    createdAt: Number(it.createdAt) || 0,
    updatedAt: Number(it.updatedAt) || 0,
  }))
}

/** 状态页那一栏：一共几件、第一件、最近一件。 */
export async function worksSummary(root) {
  const items = await worksOf(root)
  const kept = items.filter((it) => it.state !== 'dropped')
  const first = kept.length ? kept[kept.length - 1] : null
  const latest = kept.length ? kept[0] : null
  return {
    count: kept.length,
    wip: items.filter((it) => it.state === 'wip').length,
    first: first ? { id: first.id, title: first.title, at: Number(first.createdAt) || 0 } : null,
    latest: latest ? { id: latest.id, title: latest.title, at: Number(latest.updatedAt) || 0, version: versionOf(latest) } : null,
  }
}

/**
 * 桌上那一行事实：手上还摊着的那件。
 *
 * 只给这一样，而且很短——桌子是「醒来时摆在眼前的东西」，不是作品集。
 * 为什么不摆「他看过了」：看见了就得回应，回应就成了交差；留下的东西
 * 一旦有「他看过」这层反馈，她下一件就会照着这个反馈做。所以读就是读，
 * 账里不记，她也不知道。
 *
 * 为什么不再按十四天筛掉：筛掉会产生「看不见的堵死」——两件没弄完的
 * 早就过了十四天，桌上一条都不摆，她想不起它们；而「手上最多同时两件」
 * 照样把它们算在内，新的一件起不来。摆出来但说清「有些天没动了」，
 * 比让它凭空消失诚实。十四天只决定用哪一句话。
 */
export async function worksForDesk(root, { now = Date.now() } = {}) {
  const db = await readWorks(root)
  const at = Number(now)
  const wipItem = db.items.filter((it) => it.state === 'wip').sort(byUpdated)[0] || null
  if (!wipItem) return { wip: null }
  const touched = Math.max(Number(wipItem.updatedAt) || 0, Number(wipItem.createdAt) || 0)
  return {
    wip: {
      id: wipItem.id,
      title: wipItem.title,
      stale: touched < at - WORK_DESK_DAYS * DAY,
      kind: wipItem.kind || 'text',
    },
  }
}
