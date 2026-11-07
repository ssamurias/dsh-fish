/**
 * speak.js —— 她在 B 站开口：bili_speak 工具
 *
 * 与 look.js 的对偶关系：
 *   look  = 眼睛（只读，不留痕，随时可用）
 *   speak = 嘴（**写**，会留在账号上，默认关闭，有配额）
 *
 * 为什么这条要单独一个工具、而不是并进 look：
 *   「看」和「说」的风险差一个量级。混在一个工具里，她就分不清
 *   哪次调用是安全的、哪次会留痕。工具边界 = 代价边界。
 *
 * 她不知道的东西（和 look 一致）：不知道有配额、不知道配额还剩几次、
 * 不知道有黑名单、不知道这个功能可能被关着。
 * 被拒绝时只听到「这会儿不方便说」，听不到「你今天的 3 条用完了」——
 * 后者会让她学会攒着、算着，那就成了资源管理，不是说话。
 */

import { toJsonSchema } from './toolschema.js'
import { rootDir, readEvents, readOwner } from './store.js'
import { loadConfig } from './settings.js'
import { postComment, postReply } from './comment.js'
import { screenOutgoing } from './guard.js'
import { mentionPrefix } from './owner.js'

import { defineTool } from './tool.js'
import { guardWrite } from './tenant.js'

/**
 * 说一次。永不抛出。
 * @returns {Promise<{ok:boolean, said:string, note:string}>}
 *   said 是**真正发出去的那句话**（成功时），她可以据此确认自己说了什么。
 */
export async function speakOnce(o = {}) {
  const root = o.root ?? rootDir()
  try {
    const kind = String(o.kind ?? 'comment')
    const text = String(o.text ?? '').trim()
    if (!text) return { ok: false, said: '', note: '没想好说什么，那就先不说。' }

    // 出门前过一道闸：她要说的话里若长得像凭据（cookie / token / sk- / 长随机串），
    // 一律不发。宁可少说一句，也不把家里钥匙贴到评论区。
    const screened = screenOutgoing(text)
    // 拦下的理由不细说：告诉她"你泄露了路径"等于教会她下次换个写法。
    if (!screened.ok) return { ok: false, said: '', note: screened.why === 'leak' ? '这句里有不该说出去的东西。' : '这句先不说了。' }

    // 给她的话加个称呼：只有评论加，回复别人时不加——那会把别人的楼变成你们的客厅。
    // @ 前缀单独交给 postComment，在脱敏之后拼；否则昵称和主人称呼同名时，
    // 前缀会一起被换成「对方」，@ 到不存在的人。
    let prefix = ''
    if (kind !== 'reply') {
      const ow = await readOwner(o.root ?? rootDir())
      const cfg = await loadConfig(o.root ?? rootDir())
      prefix = mentionPrefix(ow, cfg.config)
    }

    const r =
      kind === 'reply'
        ? await postReply({ root, bvid: o.bvid, parentRpid: o.parentRpid, text, prefix, client: o.client, dateKey: o.dateKey })
        : await postComment({ root, bvid: o.bvid, text, prefix, client: o.client, dateKey: o.dateKey })

    if (!r.ok) return { ok: false, said: '', note: softReason(r.why) }
    return { ok: true, said: r.sent ?? `${prefix}${text}`, note: '说出去了。' }
  } catch (err) {
    return { ok: false, said: '', note: '没说出来。' }
  }
}

/**
 * 把内部原因压成一句她能听见的话。
 * 关键：**不泄露配额与开关**。她听到的永远是状态，不是规则。
 */
function softReason(why) {
  const w = String(why ?? '')
  if (w.includes('没开') || w.includes('权限')) return '这会儿不方便说。'
  if (w.includes('今天说够') || w.includes('今天回够')) return '今天说得够多了。'
  if (w.includes('不是说话的时候')) return '现在不是说话的时候。'
  // 2026-10-31（用户转来的现场反馈）：原来只说「先看一眼再说」，她照着做了还是被拒——
  // 因为她翻的是别的视频、搜的是别的关键词，闸门只认**这一条**（`look:<dk> <bvid>`）。
  // 所以这句要能照着做：点名看哪一条、点名用哪个动作、说清看别的为什么不算。
  // 仍然不泄露配额与开关——这里说的全是「现在是什么状态、下一步怎么走」。
  if (w.includes('没看')) {
    const how = '要打开这一条：bili_look（what 填 video，bvid 填它），或者 bili_watch 直接看画面。翻了别的、搜了别的，都不算这一条。'
    return w.includes('递过来') ? `这条是他递过来的，你还没打开过。${how}` : `这一条你今天还没打开过。${how}`
  }
  if (w.includes('登录') || w.includes('cookie')) return '说不出去，缺了点什么。'
  if (w.includes('拦')) return '说了但没送到，等一下再说。'
  return w.slice(0, 40) || '没说出来。'
}

/**
 * 工具说明随开关变（2026-10-29）。
 *
 * 为什么需要这个：工具定义每轮都在她的上下文里，`description` 本身就是一段广告。
 * 原来不管开关开没开都写「可以给你今天看过的某个视频留一条评论」——而关着的时候
 * 身份文档里**没有**「在网上说话」那一节（selfdoc.js 的 `speak` 判据）。
 * 一边说能说、一边一句不提，两个来源当场打架。
 *
 * 为什么不写成「这个眼下还开不了」：那等于告诉她「有个开关在管着这件事」，
 * 与文件顶上那条原则冲突（她不该知道自己被管理着）。所以关着时只说「这会儿」：
 * 不承诺发得出去，也不解释为什么发不出去。
 *
 * 2026-11-07（P3）：关着时不再把「能留评论」整句拿掉再补一句无关的话，也不再让
 * 身份文档里那一节整段消失——门留着，门上写「这会儿还说不出去」，想说的话可以先
 * 写在别处。这样她不会以为这件事根本不存在。
 *
 * 为什么要用 getter：`ctx.tools.register` 只在启动时跑一次，而配置随时能改。
 * 存一份「最近一次看到的状态」，宿主每轮序列化工具表时会再取一次 description，
 * 于是开关一翻，下一轮就跟着变。`execute` 里本来就要读配置，顺手同步一次，
 * 兜住「启动之后才被改、她还没调过」的中间态。
 */
let speakEnabled = false

/** 测试与调用方同步用：告诉这里「开关现在是什么样」。 */
export function noteSpeakEnabled(on) {
  speakEnabled = on === true
}

/** 关着时的那一段必须**不含**任何"能发出去"的暗示，也不解释原因。 */
function speakDescription(on) {
  if (!on) {
    return '在 B 站说一句话。这会儿还说不出去——想说的话可以先留在别处；不想说就不说，没有人等着你回答。'
  }
  return (
    '在 B 站说一句话。可以给你今天看过的某个视频留一条评论，或者回一句别人留在你评论下面的话。' +
    '这是会留下来的东西——别人看得见，你也删不掉别人已经看到的。' +
    '不想说就不说，没有人等着你回答。'
  )
}

export function registerSpeak(ctx, deps = {}) {
  const root = deps.root ?? rootDir()
  // 启动时先按当时看到的配置定一次；之后靠 execute 与调用方同步刷新。
  if (deps.speakEnabled !== undefined) noteSpeakEnabled(deps.speakEnabled)

  return ctx.tools.register(
    defineTool({
      name: 'bili_speak',
      get description() { return speakDescription(speakEnabled) },
      parameters: toJsonSchema({
        kind: {
          type: 'string',
          required: true,
          enum: ['comment', 'reply'],
          description: 'comment=给视频留一条评论；reply=回别人留在你评论下面的话。',
        },
        bvid: { type: 'string', required: true, description: '在哪个视频（形如 BV1xx411c7mD）。' },
        text: { type: 'string', required: true, description: '要说的话。说人话，别超过一两百字。' },
        parentRpid: { type: 'string', required: false, description: 'kind=reply 时，你要回的是哪一条（那条回复的编号）。' },
      }),
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            said: { type: 'string', description: '真正发出去的话' },
            note: { type: 'string' },
          },
          required: ['ok', 'said', 'note'],
        },
        // render 必须返回 ContentBlock 数组，签名 (args, value)。返回裸字符串她会收到
        // "content.some is not a function"，然后以为没发出去、反复重试同一句。
        render: (_args, out) =>
          [{ type: 'text', text: out.ok ? `说出去了：「${out.said}」` : `没说：${out.note}` }],
      },
      async execute(args, exec) {
        // 对外说话更要有「谁在说」的凭据：两个家共用一个 root 时，
        // 不能让 A 家的她去 B 家的 B 站号上说话（2026-10-28 用户 m01319）。
        const who = guardWrite(deps.tenant, exec, 'bili_speak')
        if (!who.ok) return { ok: false, said: '', note: who.note }
        const { config } = await loadConfig(root)
        // 顺手同步一次：启动之后才被改的开关，靠这里让下一轮的 description 跟上。
        noteSpeakEnabled(config?.comment?.enabled === true)
        if (config?.comment?.enabled !== true) return { ok: false, said: '', note: softReason('没开这个权限') }
        return speakOnce({
          kind: args?.kind,
          bvid: args?.bvid,
          text: args?.text,
          parentRpid: args?.parentRpid,
          root,
          client: deps.client,
        })
      },
    }),
  )
}
