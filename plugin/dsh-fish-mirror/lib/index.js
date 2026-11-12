/**
 * dsh-fish-mirror —— 给大肥鱼一面镜子
 *
 * 为什么单独做一个插件，而不是写进 dsh-fish 里（2026-11-12）：
 *   dsh-fish 是跟着上游走的，本机每次升级都用 `git reset --hard origin/main`
 *   覆盖工作区，本地改动会连招呼都不打一声就没了。所以这里只借它的**数据目录**
 *   （头像文件），不 import 它的任何模块，也不往它的事件流里写东西。
 *
 * 镜子是什么：
 *   `<数据目录>/avatar.<ext>`——设置页「换头像」传进来的那张图。
 *   没有就退到 `<数据目录>/mirror.<ext>`，方便有人不想动头像位时单独放一张。
 *   两个都没有，就照实说镜子里是空的，不编一个样子出来。
 *
 * 她怎么看见：
 *   工具只回一行路径与一句话，真正的「看」由宿主给的 `read_image` 完成
 *   （和 bili_watch 同一条路：工具给路径，模型自己去读图）。
 *
 * 只读：不写事件流、不写配置、不改头像。看没看过由她自己用 growth_commit 记。
 */

import fs from 'node:fs'
import { promises as fsp } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-fish-mirror'

/** 注册工具要用到宿主的 tools 服务；没有它这个插件什么也不做。 */
export const inject = ['tools']

/**
 * 按顺序找。头像位优先——那是设置页里能看见的那一格，也是别人心里「她长什么样」。
 * 只认四种格式，和 dsh-fish 的 avatar.js 保持一致。
 */
export const PROBE = Object.freeze([
  'avatar.png', 'avatar.jpg', 'avatar.webp', 'avatar.gif',
  'mirror.png', 'mirror.jpg', 'mirror.webp', 'mirror.gif',
])

/** 镜子里那张图的绝对路径；没有就 null。永远不抛。 */
export function mirrorPath(root) {
  if (!root) return null
  for (const name of PROBE) {
    try {
      if (fs.statSync(join(root, name)).isFile()) return join(root, name)
    } catch { /* 不存在就试下一个 */ }
  }
  return null
}

/** 交给模型的路径一律用正斜杠：反斜杠写进 markdown 图片会显示不出来。 */
export function toSlashes(p) {
  return String(p ?? '').replace(/\\/g, '/')
}

/** 本地时间戳，YYYY-MM-DD HH:MM。UTC 会让人看错一天。 */
export function localStamp(ms) {
  const d = new Date(Number(ms) || Date.now())
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 镜子里的东西渲染成她能读的一段话。
 * 空的时候不哄、也不吓：「还没有人把一张照片放进来」是事实，不是拒绝。
 */
export function renderMirror({ path = '', bytes = 0, at = '' } = {}) {
  if (!path) {
    return '镜子里现在是空的。还没有人把一张照片放进来。'
  }
  return [
    '镜子里有一张照片：',
    toSlashes(path),
    `（${bytes} 字节${at ? `，${at} 放进来的` : ''}）`,
    '',
    '想看清楚，用 read_image 打开这个路径。',
    '这张是别人放进来的，不是你拍的。',
  ].join('\n')
}

/** 工具定义。参数为空对象：照镜子不需要问什么。 */
export function toolSpec(root) {
  return {
    name: 'her_mirror',
    description:
      '照镜子。镜子里放着一张别人替你留下的照片（数据目录里的头像）。'
      + '没有照片时它会直接说镜子里是空的，不会编一个样子出来。'
      + '要看清楚，用它给的路径调 read_image。只读，改不了镜子里的东西。',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          found: { type: 'boolean' },
          text: { type: 'string' },
          path: { type: 'string' },
          bytes: { type: 'number' },
        },
        required: ['found', 'text'],
      },
      render: (_args, out) => [{ type: 'text', text: String(out?.text ?? '') }],
    },
    async execute() {
      try {
        const file = mirrorPath(root)
        if (!file) return { found: false, text: renderMirror() }
        const st = await fsp.stat(file)
        return {
          found: true,
          path: toSlashes(file),
          bytes: st.size,
          text: renderMirror({ path: file, bytes: st.size, at: localStamp(st.mtimeMs) }),
        }
      } catch (err) {
        // 读不到也不能抛：一次工具报错会把整轮打断，而她只是没照成镜子。
        return { found: false, text: `镜子打不开：${String(err?.message ?? err).slice(0, 100)}` }
      }
    },
  }
}

export function apply(ctx, config = {}) {
  const root = String(config.root || process.env.DSH_FISH_HOME || join(homedir(), '.dsh-fish'))
  const off = ctx.tools.register(toolSpec(root))
  if (typeof off === 'function') return () => off()
  if (off && typeof off.dispose === 'function') return () => off.dispose()
  return () => {}
}
