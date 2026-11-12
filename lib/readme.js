/**
 * readme.js —— 数据文件夹里的那份「说明.md」
 *
 * 为什么是文件而不是界面（用户 m03440，2026-10-24）：
 *   界面上不显示绝对路径——路径只在他真的要用的时候才进剪贴板。
 *   但「这个文件夹里都有什么」这件事本身还得留个说明，
 *   否则打开文件夹看见 events.jsonl / out / diary 只能猜。
 *   所以说明放在**文件夹里**，跟数据待在一起，跟着备份一起走。
 *
 * 纪律：
 *   1. 只在缺失、或版本标记落后时才写——用户改过的内容不许被他升级插件时覆盖掉。
 *   2. 永不抛（观测台的 /paths 会顺手调它，一个写不进去的说明不该拖垮整页）。
 */

import fs from 'node:fs'
import { join } from 'node:path'

/** 版本标记。改了说明正文就把它加一，这样旧文件会在下次打开设置页时被重写。 */
export const README_VERSION = 3
export const README_MARK = `<!-- fish-docs:v${README_VERSION} -->`
export const README_NAME = '说明.md'

export const README_TEXT = `${README_MARK}
# 大肥鱼的文件夹里都有什么

一个文件夹装全部。想备份，把整个文件夹复制走就行；想搬去别的电脑，
把文件夹放到新地方、让插件指向它即可。下面每一项都相对于这个文件夹。

| 名字 | 是什么 |
| --- | --- |
| \`events.jsonl\` | 不能删除记录，唯一可信源。她全部经历就是这一行行的记录。 |
| \`config.json\` | 你敢在设置页上调的那些东西：时间窗、配额、开关。 |
| \`state.json\` | 宿主侧记的游标（最后一次醒来的时间之类）。 |
| \`owner.json\` | 主人是谁、B 站 cookie 存在这附近。**别外传。** |
| \`diary/\` | 她的日记，一天一个文件。给不给你看是「成长」页上的开关。 |
| \`out/\` | 每日报告，按日期一个文件。设置页「数据 → 每日报告」就是从这里读的。 |
| \`out/covers/\` | 视频封面图缓存。 |
| \`media/\` | 看视频时的画面拼图和收到的图片，只留几天。 |
| \`keepsakes/\` | 她带回来的纪念品，按日期分文件夹。你点头之后才复制进来。 |
| \`keepsakes.json\` | 带东西的台账：问过哪件、你准了还是没准。 |
| \`outings.json\` | 出门台账：每趟去了哪、回来算不算数。 |
| \`possessions.json\` | 请神台账：哪条对话被接管过、有没有结算。 |
| \`instance.json\` | 哪个实例正在用这个文件夹（防两个窗口同时跑）。 |
| \`session-notes.json\` | 她排着队、等下一次开口要说的话。 |
| \`notes.json\` | 她的便条：还没做完的事、哪天到期。有日子的到期之后每次醒来先摆在她眼前，过期不删也不催；没日子的隔些天提一次。 |
| \`talk-recent.json\` | 最近几轮聊了什么（「她开始听你说话」用的摘要）。 |
| \`home/\` | 她住的地方：身份文件 \`她的身份.md\`（插件每轮重写，别手改）、会话用过的工作区。 |
| \`inbox.md\` | 她特意留给你的话（纯文本副本）。平常说的话在对话框里，不在这里。 |
| \`logs/dsh-fish.log\` | 插件自己的运行日志，超 2MB 轮转、留两份。出事时从设置页「导出日志」。 |
| \`reset/\` | 重置大肥鱼时挪走的东西（备份），不会自动删。 |

这个文件是插件写的。你要改可以改，但改了之后版本标记对不上，
下次打开设置页时它会被重新写一遍——所以最好把改动写在别处。
`

/** 缺了、或版本标记落后 → 写一份。返回 { wrote, reason }。永不抛。 */
export function ensureDataReadme(root) {
  try {
    const file = join(root, README_NAME)
    try {
      const old = fs.readFileSync(file, 'utf8')
      if (old.includes(README_MARK)) return { wrote: false, reason: 'current', file }
    } catch {
      // 不存在 / 读不了：都当成「该写一份」
    }
    fs.mkdirSync(root, { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, README_TEXT, 'utf8')
    fs.renameSync(tmp, file)
    return { wrote: true, reason: 'stale-or-missing', file }
  } catch (err) {
    return { wrote: false, reason: String(err?.message ?? err), file: null }
  }
}
