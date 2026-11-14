// 云端备份的目标形状（2026-11-14，用户 m01090）
//
// 这一份是**唯一的真源**：设置页的表单、后端的校验、配置的默认值，全都从下面这张表来。
// 以前吃过「界面加了字段、后端白名单没登记」的亏（backup 组那次），
// 所以这里刻意做成「加一个字段只改一处」的形状。
//
// 设计上只有两件事要守住：
// 1. 目标是一张列表，用户可以加任意多个、任意组合。不是「选一个渠道」。
// 2. 每个目标自己带 enabled。挂掉一个不影响别的，这就是「降级」的最小单位。

/** 字段类型：text 单行、pass 密码、num 数字、bool 开关、area 多行。 */
const F = (key, label, type, extra = {}) => ({ key, label, type, ...extra })

export const KINDS = {
  folder: {
    label: '一个文件夹',
    short: '文件夹',
    steps: '选一个文件夹。如果它正好是你网盘客户端的同步目录（坚果云、OneDrive、iCloud、123、夸克都能设），那这一份就自动跟着同步上去了——不需要任何账号或接口。',
    fields: [
      F('dir', '哪个文件夹', 'text', { required: true, placeholder: 'D:\\我的网盘\\大肥鱼备份', hint: '绝对路径。目录不存在会自动建。' }),
    ],
  },
  git: {
    label: '一个 Git 仓库',
    short: '仓库',
    steps: '在 GitHub / Gitee / GitLab / Gitea 上建一个**私有**仓库（不要公开，包里是她的身份和登录凭据），然后生成一个有写权限的令牌粘进来。',
    fields: [
      F('repo', '仓库', 'text', { required: true, placeholder: '你的名字/dafish-backup', hint: '写成「用户名/仓库名」，或者直接粘仓库网页地址。' }),
      F('token', '访问令牌', 'pass', { required: true, hint: '只勾仓库读写权限就够，别给全权限。令牌只存在本机。' }),
      F('api', '接口地址', 'text', { placeholder: '留空按仓库地址自动判断', hint: 'GitHub 是 https://api.github.com，Gitee 是 https://gitee.com/api/v5。自建 Gitea 填自己的。' }),
      F('branch', '分支', 'text', { placeholder: 'main', hint: '留空用 main；Gitee 默认分支常叫 master。' }),
      F('dir', '仓库里的目录', 'text', { placeholder: 'backups', hint: '留空就放仓库根目录。' }),
    ],
  },
  webdav: {
    label: '一个 WebDAV 目录',
    short: 'WebDAV',
    steps: '坚果云、123 云盘、InfiniCLOUD、Nextcloud、群晖、Alist 都支持 WebDAV。用「应用密码」而不是登录密码——网页密码改了应用密码还在，泄露了也能单独吊销。',
    fields: [
      F('url', 'WebDAV 地址', 'text', { required: true, placeholder: 'https://dav.jianguoyun.com/dav/', hint: '填到你要用的那一层目录。' }),
      F('user', '用户名', 'text', { required: true, hint: '坚果云是登录邮箱。' }),
      F('pass', '应用密码', 'pass', { required: true, hint: '在各家的「安全设置 / 应用密码」里生成，不是登录密码。' }),
      F('dir', '目录', 'text', { placeholder: 'dafish', hint: '在 WebDAV 地址下面再建一层。留空直接放上去。' }),
    ],
  },
  smtp: {
    label: '发到邮箱',
    short: '邮箱',
    steps: '不用注册任何新东西：你自己的邮箱就能收。要去邮箱设置里开 SMTP 并生成一个「授权码」（不是登录密码）。附件上限一般是 50MB，我们的包 8MB 左右够用。',
    fields: [
      F('host', 'SMTP 服务器', 'text', { required: true, placeholder: 'smtp.qq.com', hint: 'QQ 邮箱 smtp.qq.com、163 是 smtp.163.com、Gmail 是 smtp.gmail.com。' }),
      F('port', '端口', 'num', { dflt: 465, lo: 1, hi: 65535, hint: '465 是加密直连，587 是 STARTTLS。' }),
      F('user', '账号', 'text', { required: true, placeholder: 'you@qq.com' }),
      F('pass', '授权码', 'pass', { required: true, hint: '邮箱设置里生成的授权码，不是登录密码。' }),
      F('to', '发到哪个邮箱', 'text', { required: true, hint: '留空就发给自己。可以填多个，用逗号分开。' }),
      F('from', '发件人', 'text', { placeholder: '留空用上面的账号' }),
    ],
  },
  http: {
    label: '自定义 HTTP 接口',
    short: 'HTTP',
    steps: '万能出口：任何能收一个 PUT/POST 的地址都行（你自己的对象存储、别人给的上传链接、内网服务）。请求体里的占位符会被替换成真实内容。',
    fields: [
      F('url', '地址', 'text', { required: true, placeholder: 'https://example.com/upload/{{name}}', hint: '可以用占位符：{{name}} {{file}} {{sha256}} {{size}}。' }),
      F('method', '方法', 'text', { dflt: 'PUT', placeholder: 'PUT', hint: 'PUT 或 POST。' }),
      F('headers', '请求头', 'area', { placeholder: 'Authorization: Bearer xxx\nContent-Type: application/octet-stream', hint: '一行一个，冒号分隔。' }),
      F('bodyFile', '把文件放进请求体', 'bool', { dflt: true, hint: '关掉的话就发下面的文本模板，不发文件本身。' }),
      F('body', '文本模板', 'area', { placeholder: '{"name":"{{name}}","sha256":"{{sha256}}"}', hint: 'bodyFile 关掉时才用。' }),
    ],
  },
  command: {
    label: '跑一条命令',
    short: '命令',
    steps: '最强也最危险的出口：本机有 rclone / ossutil / 自己写的脚本，就让它去传。装 rclone 之后一行命令就能接上它支持的七十多种网盘。命令里的占位符会被替换。',
    fields: [
      F('cmd', '命令', 'area', { required: true, placeholder: 'rclone copy "{{file}}" myremote:dafish-backups/', hint: '占位符：{{file}} {{name}} {{sha256}} {{size}}。文件路径会自动加引号之外，其余要自己写对引号。' }),
      F('shell', '用哪个 shell', 'text', { dflt: 'auto', placeholder: 'auto', hint: 'auto / cmd / bash。Windows 上默认 cmd。' }),
    ],
  },
}

export const KIND_ORDER = ['folder', 'git', 'webdav', 'smtp', 'http', 'command']

export function kindInfo(kind) {
  return KINDS[String(kind ?? '')] ?? null
}

export function kindLabel(kind) {
  return kindInfo(kind)?.short ?? String(kind ?? '')
}

/** 给界面用的一份完整说明书（字段表直接从上面这张表投影出去）。 */
export function kindsDoc() {
  return KIND_ORDER.map((k) => ({ kind: k, ...KINDS[k] }))
}

function clampNum(v, lo, hi, dflt) {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.max(lo, Math.min(hi, Math.round(n)))
}

function cleanId(s) {
  return String(s ?? '').trim().replace(/[^\w-]/g, '').slice(0, 24)
}

/**
 * 把一个目标规整成规范形状。
 * 认不出的 kind 返回 null（整条丢掉，不让它占着列表让人以为能用）；
 * 必填项为空的**保留**，只是 `ready:false`——用户正在填的时候不该被吞掉。
 */
export function normTarget(raw, index = 0) {
  if (!raw || typeof raw !== 'object') return null
  const kind = String(raw.kind ?? '').trim()
  const info = KINDS[kind]
  if (!info) return null
  const out = {
    id: cleanId(raw.id) || `t${index + 1}`,
    kind,
    name: String(raw.name ?? '').trim().slice(0, 40) || info.short,
    enabled: raw.enabled !== false,
  }
  for (const f of info.fields) {
    const v = raw[f.key]
    if (f.type === 'bool') out[f.key] = v === undefined || v === null ? Boolean(f.dflt) : Boolean(v)
    else if (f.type === 'num') out[f.key] = clampNum(v, f.lo ?? 0, f.hi ?? 1e9, f.dflt ?? 0)
    else out[f.key] = String(v ?? f.dflt ?? '').replace(/^\uFEFF/, '').trim()
  }
  out.ready = info.fields.every((f) => !f.required || String(out[f.key] ?? '').trim() !== '')
  out.missing = info.fields.filter((f) => f.required && String(out[f.key] ?? '').trim() === '').map((f) => f.label)
  return out
}

export function normTargets(raw) {
  const list = Array.isArray(raw) ? raw : []
  const out = []
  const seen = new Set()
  for (let i = 0; i < list.length && out.length < 12; i++) {
    const t = normTarget(list[i], i)
    if (!t) continue
    // id 撞了就改一个：界面上靠它定位，重复会让「删第二个」删到第一个。
    let id = t.id
    let n = 2
    while (seen.has(id)) id = `${t.id}${n++}`
    t.id = id
    seen.add(id)
    out.push(t)
  }
  return out
}

/** 一个目标缺什么、为什么不能用——一句话，给人看。 */
export function targetProblem(t) {
  if (!t) return '这个目标不完整。'
  const info = KINDS[t.kind]
  if (!info) return '不认识这种目标。'
  const miss = missingOf(t)
  if (miss.length) return `还差：${miss.join('、')}`
  return ''
}

/**
 * 缺哪些必填项。
 *
 * 优先用 normTarget 算好的 t.missing；**没算过就现算**。
 * 为什么不能只看 t.missing：从 config.json 里直接读出来的那一份、或者调用方手搓的
 * 一个目标，都没有这个字段，`t.missing === undefined` 会让「缺必填」被当成「齐全」，
 * 于是一个空仓库也被判成能用，一路推到 404 才报错。这里现算一遍，判据只有一处。
 */
function missingOf(t) {
  if (Array.isArray(t.missing)) return t.missing
  const info = KINDS[t?.kind]
  if (!info) return []
  const out = []
  for (const f of info.fields) {
    if (!f.required || f.type === 'bool') continue
    const v = t[f.key]
    if (v === undefined || v === null || String(v).trim() === '') out.push(f.label)
  }
  return out
}

/** 设置页上那句话：这个目标大概会怎么用。 */
export function targetBlurb(t) {
  const info = KINDS[t?.kind]
  return info?.steps ?? ''
}

/**
 * 发给界面的那一份：**密码类字段不回显**，只回一个「填过了没有」。
 *
 * 为什么不让界面拿回原文：令牌、应用密码、授权码都是能直接把账号交出去的东西。
 * 它们已经在 config.json 里躺着（本机文件，绕不开），但没有必要再多流进一次页面 DOM 和
 * 浏览器内存——那一层还多一个「被别的脚本读到」的面。
 * 编辑时密码框留空＝不改（由 observe 的 /cloud/target 做合并）。
 */
export function publicTarget(t) {
  if (!t) return null
  const info = KINDS[t.kind]
  const out = { id: t.id, kind: t.kind, name: t.name, enabled: t.enabled !== false, ready: Boolean(t.ready), problem: targetProblem(t) }
  const filled = {}
  for (const f of info?.fields ?? []) {
    if (f.type === 'pass') {
      out[f.key] = ''
      filled[f.key] = String(t[f.key] ?? '') !== ''
    } else {
      out[f.key] = t[f.key]
    }
  }
  out.filled = filled
  return out
}

/**
 * 保存一条目标时把「留空的密码」补回原值。
 * 界面不回显密码，所以它交上来的那一项一定是空串——这时候空串的意思是「不改」，
 * 不是「清掉」。真要清，用户得把它换成一个新值。
 */
export function mergeTargetSecrets(next, old) {
  if (!next || !old || next.kind !== old.kind) return next
  const info = KINDS[next.kind]
  for (const f of info?.fields ?? []) {
    if (f.type !== 'pass') continue
    if (String(next[f.key] ?? '') === '' && String(old[f.key] ?? '') !== '') next[f.key] = old[f.key]
  }
  return next
}
