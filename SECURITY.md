# 安全边界

这个文件说清楚三件事：她能把什么说出去、外面能把什么递进来、出了问题该找谁。**描述的是代码现在的实际行为**，不是承诺；改了代码请同步改这里。

## 它能碰什么，不能碰什么

- **没有自己的端口，也不监听任何地址。** 插件挂在 DSH 宿主的 HTTP 服务上（`/dsh-fish/*`），每条路由都过 `lib/observe.js` 的 `guarded()`：先问宿主的 `connection` 服务这一条该不该放行，被拒就是 403，宿主的服务取不到就是 503。也就是说**它的访问控制和宿主一致**——宿主信任的进程，就能让她听见话。
- **零依赖，不引第三方包。** `dependencies` / `peerDependencies` / `devDependencies` 永远是 `{}`（见 `AGENTS.md` §1），所以没有供应链这一层。
- **子进程只有 ffmpeg / ffprobe**（`lib/video.js`、`lib/media.js`），参数由插件自己拼，不经过 shell。**不用 yt-dlp，不下载整段视频。**
- **出站只有两处**：B 站接口（`lib/bili.js`，`https://api.bilibili.com`）与自更新时的 npm registry（`lib/selfupdate.js`，`registry.npmjs.org` / `registry.npmmirror.com`）。除此之外不往外发任何东西。

## 你的东西存在哪

全部在数据目录里：默认 `~/.dsh-fish/`（可由 `DSH_FISH_HOME` 或 `~/.dsh-fish-location.json` 指到别处）。

- `events.jsonl` —— 她经历过的事，一行一条，**只追加**。
- `config.json` —— 环境参数。
- `owner.json` —— 主人身份，**以及 B 站登录 cookie（明文）**。这点别意外：备份卡的说明里写的就是「包里原样带着 `owner.json`」，所以**把备份包发给别人，等于把 B 站登录凭证也发出去**。
- `diary/`、`out/` —— 她写的日记、她产出的文件。

这些都不上传到任何地方。要清理就删数据目录；包目录里不含你的数据。

## 她说出去的话

- 她的正文默认只留在会话里，除非你自己填了 `proactive.sendTools`、让她用某个工具发。那是你选定的工具，去向由那个工具决定。
- 任何新输入口（新工具、新接口、新外部文本源）都要过 `lib/guard.js`：秘密外发（cookie、token、`sk-` 开头的 key、Bearer、长 base64）在这里一律拦下。发现自己绕过它，请当安全问题报。
- 桥（`/dsh-fish/say`）是**本机进程**调用的接口，没有额外的密钥校验——它的安全边界就是「谁能访问宿主的 HTTP 服务」，和 DSH 本身一样。不要把宿主端口暴露到公网。

## 报安全问题

请不要开公开 issue。用仓库的 **Security → Report a vulnerability**（私有报告），或者直接发邮件给维护者（npm 包 `@ssamurias/dsh-fish` 页面上有联系方式）。三件事写清楚：能复现的最小步骤、你的 DSH 与插件版本（`node tools/check-install.mjs` 的输出就够）、你担心的后果。

确认之后会在下一个小版本修掉，发布说明里写清楚修的是什么——不回填历史版本。

## 不属于安全问题的情况

- **设置页能改参数、能重置**：这是设计，重置不删 `events.jsonl`，只改名前缀封存。
- **B 站 cookie 存在 `owner.json` 里**：见上，属已知设计；担心的话别分享备份包。
- **她记住了你不想让她记的东西**：那是产品行为，不是漏洞——用 `her_note` / 设置里的记忆参数处理，或者在事件流里降低召回，不要删 `events.jsonl`（见 `AGENTS.md` §5）。
