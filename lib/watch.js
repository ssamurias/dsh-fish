/**
 * watch.js —— 工具 `bili_watch`：她要「看画面」的时候用这个
 *
 * 为什么不塞进 bili_look 自动做：抽一次帧要十秒左右、还要占额度。
 * 她翻列表时看四条视频就自动抽四次，既慢又浪费。**让她自己决定哪条值得看画面**，
 * 这也正好是「自主」这个维度唯一的可验证载体——跟当初给她 bili_look 是同一个理由。
 */

import { readEvents, appendEvent, rootDir } from './store.js'
import { loadConfig, dateKey, biliOn } from './settings.js'
import { grabFrames } from './video.js'
import { logLine } from './log.js'

import { defineTool } from './tool.js'
import { slashed } from './posix.js'
import { guardWrite } from './tenant.js'

/** 今天已经看过几条（只数成功的，失败不占额度） */
export function watchedToday(events, dk) {
  const key = `watched:${dk}`
  return (events ?? []).filter((e) => e?.type === 'meta' && String(e.text ?? '').startsWith(key)).length
}

/** 没有 tenancy（单测、老调用）时自己拼一个，理由同 look.js 的 tenancyOf。 */
function tenancyOf(root, tenancy) {
  if (tenancy && typeof tenancy === 'object') {
    return { root, herDir: String(tenancy.herDir ?? ''), tenant: tenancy.tenant ?? { ok: true } }
  }
  return { root, herDir: '', tenant: { ok: true } }
}

/**
 * 贴图提示直接给成品（issue #99）。
 *
 * 原来只给裸路径、让模型自己转成 markdown。四次实测里三次蒙对、一次在前面
 * 加了 `/`（`/G:/…`），客户端把它当绝对路径 → `/api/file?path=/G:/…` →
 * Windows 上解成 `G:\G:\…` → 404 →「图片无法预览」。这一步转换对模型本来就是
 * 随机的，索性不给它转换的机会：要它贴的时候，整行照抄这一行就行。
 */
export function pasteLine(path) {
  // 真传了 `/G:/…` 也顺手去掉那一个斜杠：这一步不该靠模型记规矩。
  const p = String(path ?? '')
    .trim()
    .replace(/^\/+(?=[A-Za-z]:[\\/])/, '')
  if (!p) return ''
  return `![画面](${p})`
}

export function registerWatch(ctx, deps = {}) {
  const root = deps.root ?? rootDir()

  return ctx.tools.register(
    defineTool({
      name: 'bili_watch',
      description:
        '看一条视频的画面。会把整条视频里取几张截图拼成一张图存下来，告诉你文件在哪，' +
        '你用 read_image 打开它就能看见画面了。取画面要花十几秒，所以别每条都看，' +
        '挑你真的想知道"画面里是什么"的那条。默认在整条视频里分段随机取几张' +
        '（每次取到的时刻不一样）；想盯住某一刻就传 at（秒），只取你点的那几秒。不用它也可以。',
      // 用完整 JSON Schema（不是简写 DSL）：工具参数必须是根级 type:object，
      // 否则 provider 直接拒 "schema must be a JSON Schema of 'type: object'"。
      parameters: {
        type: 'object',
        properties: {
          bvid: { type: 'string', description: '哪条视频（形如 BV1xx411c7mD）。' },
          at: {
            type: 'array',
            items: { type: 'number' },
            description: '可选：只要这几个时刻（秒），比如 [30, 90, 120]。不传就整条视频分段随机取。',
          },
        },
        required: ['bvid'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            path: { type: 'string', description: '拼好的图在哪（用 read_image 读它）' },
            text: { type: 'string' },
            note: { type: 'string' },
          },
          required: ['ok', 'path', 'text', 'note'],
        },
        // render 必须返回 ContentBlock 数组，签名是 (args, value)
        render: (_args, out) => [{ type: 'text', text: out.ok ? out.text : `这次没看成：${out.note}` }],
      },
      async execute(args, exec) {
        // 2026-11-01（issue #16 第二半，用户 m03454）：看画面也写事件（watched:），
        // 同样要认「谁在看、看的是哪栋房子」。
        const who = guardWrite(tenancyOf(root, deps.tenant), exec, 'bili_watch')
        if (!who.ok) return { ok: false, path: '', text: '', note: who.note }

        const bvid = String(args?.bvid ?? '').trim()
        const { config } = await loadConfig(root)
        // 2026-11-07（用户反馈）：原来这里看的是 browse.enabled——那是「刷站」的开关，
        // 0.9.0 起默认关。于是设置页开着「允许她上网」，bili_look 能翻、bili_watch
        // 却永远「现在打不开」，用户看到的是「说能看，结果看不了画面」。
        // 与 lib/look.js 统一：能不能用由 bili.enabled 决定（issue #62 收进 biliOn()）。
        if (!biliOn(config)) {
          logLine('info', ['看画面：设置里关掉了 B 站'], root)
          return { ok: false, path: '', text: '', note: '现在打不开。' }
        }
        if (config?.video?.enabled === false) {
          // 2026-10-28 起每个失败分支都写一行日志。以前这里一个字都没有，
          // 用户那边「看不到画面」时导出包里完全查不出是被哪一条挡下的
          // （另一台机器的排查就卡在这儿，只能靠猜）。
          logLine('info', ['看画面：设置里关掉了看视频'], root)
          return { ok: false, path: '', text: '', note: '现在看不了画面。' }
        }
        if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) {
          logLine('info', ['看画面：视频号不合法', bvid || '(空)'], root)
          return { ok: false, path: '', text: '', note: '这不是一个视频号。' }
        }

        const ev = await readEvents(root).catch(() => ({ events: [] }))
        const dk = dateKey()
        const cap = Math.max(0, Number(config?.video?.perDay ?? 2))
        const used = watchedToday(ev.events, dk)
        // 额度用完只说"不想看了"，不报数字——她不该知道有个计数器在管她（N2）
        if (used >= cap) {
          // 日志里可以写数字：这是给人看的，不是给她看的。
          logLine('info', ['看画面：今日额度已满', `${used}/${cap}`, bvid], root)
          return { ok: false, path: '', text: '', note: '今天不想再看画面了。' }
        }

        const r = await grabFrames({
          bvid,
          root,
          frames: config?.video?.frames,
          at: args?.at,
          // issue #62：点名看的那条也要过屏蔽名单（屏蔽的 UP，标题 / UP 名 / 标签里的关键词）；
          // 最短时长只管列表，这里不查。
          avoid: config?.avoid,
          // 单测从这里塞假的客户端和假的 ffmpeg 探测结果（都不给就照常：grabFrames 自己建、自己探）。
          // 不留这个口子，测「抽帧失败」那条分支就只能真的去打 B 站。
          client: deps.client,
          ffmpeg: deps.ffmpeg,
        })
        if (!r.ok) {
          // 命中屏蔽不是抽帧失败：单记一行，写清命中了哪一项。她听到的仍只是那句理由。
          if (r.blocked) logLine('info', ['看画面：命中屏蔽，没取画面', bvid, r.blocked], root)
          else logLine('warn', ['看画面：抽帧失败', bvid, r.why ?? ''], root)
          return { ok: false, path: '', text: '', note: r.why }
        }

        await appendEvent(
          {
            type: 'meta',
            ...(who.sessionId ? { sessionId: who.sessionId } : {}),
            // 2026-10-30：原来这行只有 BV 号，于是「她真的看过画面的那几条」
            // 在报告里没法显示标题——只能退回去用 browse: 记账凑，
            // 结果又跟「只扫了眼标题」混成一片（客户反馈的那个 bug）。
            // 把展示信息跟着凭证一起落下来，报告就不必二次取数、也不必猜。
            // 老事件没有这段 JSON，读的一方必须两种形状都认（whatseen.js）。
            text: `watched:${dk} ${bvid} ${JSON.stringify({
              title: String(r.title ?? '').slice(0, 120),
              up: String(r.up ?? '').slice(0, 60),
              duration: Number(r.duration) || 0,
              view: Number(r.view) || 0,
            })}`,
          },
          { source: 'system' },
          root,
        ).catch(() => {})

        // 路径一律给正斜杠：宿主渲染 markdown 图片时会拿路径拼 /api/file，
        // C:\... 这种反斜杠写法在客户端解析后取不到文件，图片就显示成「无法预览」
        // （2026-10-26 实测：同一张图 C:\ 版失败、C:/ 版正常）。
        const posix = slashed(r.path)
        // 成功的这一条也要记：跟日志里「今日额度已满」对得上，才知道额度是怎么用掉的。
        logLine('info', ['看画面：取到了', bvid, `${used + 1}/${cap}`, posix], root)
        return {
          ok: true,
          path: posix,
          text: [
            `《${r.title || bvid}》的画面，我取了几张拼成一张图放在这儿：`,
            ...(Array.isArray(r.times) && r.times.length
              ? [`（取的是：${r.times.map((t) => `${t} 秒`).join('、')}）`]
              : []),
            posix,
            '用 read_image 读它就能看见。要在回复里贴这张图，就整行照抄下面这一行（前面不要再加斜杠，加了会找不到文件）：',
            pasteLine(posix),
          ].join('\n'),
          note: '',
        }
      },
    }),
  )
}
