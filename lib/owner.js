/**
 * 主人是谁：uid、昵称、B 站 cookie。
 *
 * 三件事分开的原因：
 *   - uid / 昵称是「写给谁看」的元数据，可以出现在设置界面上；
 *   - cookie 是钥匙，只能看见「有没有」，看不见内容；
 *   - 三者都存在 owner.json（0600），不进 config.json —— config 会被 /config
 *     原样回吐给观测台，钥匙混在里面等于挂在客厅墙上。
 */

import { readOwner, writeOwner, rootDir } from './store.js'
import { normalizeCookie } from './bili.js'

const COOKIE_NAMES = ['SESSDATA', 'bili_jct', 'buvid3', 'DedeUserID', 'DedeUserID__ckMd5', 'sid']

/** 给外面看的样子：永远不含 cookie 原文 */
export function publicOwner(ow) {
  const o = ow ?? {}
  const acct = o.account ?? {}
  return {
    mid: String(o.mid ?? o.uid ?? ''),
    name: String(o.nickname ?? o.name ?? ''),
    // 登录账号是「拿这份 cookie 登录的是谁」：只读，保存 cookie 或点测试时自动认，
    // 和上面的领养人（要 @ 的人）是两件事。2026-10-27 拆开。
    account: {
      mid: String(acct.mid ?? ''),
      name: String(acct.name ?? ''),
    },
    hasCookie: Boolean(o.cookie && String(o.cookie).length > 0),
    hasCsrf: Boolean(o.cookie && /bili_jct=/.test(String(o.cookie))),
    savedAt: String(o.savedAt ?? ''),
  }
}

/**
 * 记下「这份 cookie 登的是哪个账号」。
 * 只写 account，**绝不碰 mid / nickname**——那两格是领养人，用户手填的。
 * @param {{mid?:number|string, uname?:string, name?:string}} me client.me() 的返回
 */
export async function saveAccount(me, root = rootDir()) {
  const cur = (await readOwner(root)) ?? {}
  const next = {
    ...cur,
    account: {
      mid: String(me?.mid ?? ''),
      name: String(me?.uname ?? me?.name ?? ''),
      savedAt: new Date().toISOString(),
    },
  }
  await writeOwner(next, root)
  return publicOwner(next)
}

/**
 * 从一坨粘贴内容里抠出 cookie 字符串。
 * 允许三种来源：纯 `a=1; b=2`、浏览器 DevTools 的 `Cookie:` 头、整段 Netscape cookies.txt。
 * 认出哪些键恰好可用：只看 B 站需要的几个，别把整段浏览器 cookies 存进来。
 */
export function parseCookieInput(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return { cookie: '', missing: ['SESSDATA'] }
  const pairs = []
  const seen = new Set()
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    // Netscape 格式：domain \t flag \t path \t secure \t expiry \t name \t value
    const tab = t.split('\t')
    if (tab.length >= 7) {
      const name = tab[5].trim()
      const value = tab[6].trim()
      if (name && !seen.has(name)) { seen.add(name); pairs.push([name, value]) }
      continue
    }
    const body = t.replace(/^cookie\s*:\s*/i, '')
    for (const part of body.split(';')) {
      const i = part.indexOf('=')
      if (i <= 0) continue
      const name = part.slice(0, i).trim()
      const value = part.slice(i + 1).trim()
      if (!name || seen.has(name)) continue
      seen.add(name)
      pairs.push([name, value])
    }
  }
  const kept = pairs.filter(([n]) => COOKIE_NAMES.includes(n))
  const cookie = kept.map(([n, v]) => `${n}=${v}`).join('; ')
  const missing = COOKIE_NAMES.filter((n) => ['SESSDATA', 'bili_jct'].includes(n) && !seen.has(n))
  return { cookie: normalizeCookie(cookie), missing }
}

/**
 * 存一次。只改传进来的字段，其余保留。
 * 传 `cookie: ''` 是「清除」，不是「没传」。
 */
export async function saveOwner(patch = {}, root = rootDir()) {
  const cur = (await readOwner(root)) ?? {}
  const next = { ...cur }
  if (patch.mid !== undefined) next.mid = String(patch.mid).trim()
  if (patch.nickname !== undefined) next.nickname = String(patch.nickname).trim()
  if (patch.cookie !== undefined) {
    const c = String(patch.cookie).trim()
    if (c) {
      const parsed = parseCookieInput(c)
      if (!parsed.cookie) {
        // cookie 认不出来也不该连累上面两格：旧版这里整单返回，用户填的 mid/昵称就白填了。
        await writeOwner(next, root)
        return { ok: false, note: 'cookie 里没认出 B 站的键，只存下了上面两格。', owner: publicOwner(next) }
      }
      next.cookie = parsed.cookie
      next.savedAt = new Date().toISOString()
      const miss = parsed.missing
      await writeOwner(next, root)
      return { ok: true, note: miss.length ? `存下了，但少了 ${miss.join(' / ')}。` : '存下了。', owner: publicOwner(next), missing: miss }
    }
    delete next.cookie
    delete next.savedAt
    // 「清除登录」要把「登的是谁」一起清：只清 cookie 会留下一个看着还在登录的旧名字。
    // account 是 saveAccount 写的只读副本，跟领养人（mid / nickname）无关，那两格一个字不碰。
    delete next.account
    await writeOwner(next, root)
    return { ok: true, note: '清掉了。', owner: publicOwner(next) }
  }
  await writeOwner(next, root)
  return { ok: true, note: '存下了。', owner: publicOwner(next) }
}

/**
 * 艾特前缀：评论发出去时加在最前面。
 * 只有同时满足「开了艾特」「有昵称」才加 —— 没昵称的 @ 只是一串没人认领的字符。
 */
export function mentionPrefix(ow, cfg) {
  const on = cfg?.comment?.atOwner !== false
  const name = String(ow?.nickname ?? ow?.name ?? '').trim()
  if (!on || !name) return ''
  // 2026-11-06：原来把空格换成下划线，理由是「@ 遇到空格会断」。但 B 站解析 @ 时
  // 是按昵称原文匹配的（真机采样里 content.members 的 uname 与正文完全一致），
  // 换成下划线反而变成一个不存在的昵称 —— 昵称里带空格的用户永远 @ 不出来。
  // 改成原样保留；末尾那个空格是分隔，别删。
  return `@${name} `
}
