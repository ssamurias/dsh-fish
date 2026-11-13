# 改这个仓库的硬约束

给要动这份代码的人（或 AI）看。**这个文件只讲「不能做什么」**，不是安装手册，也不是产品介绍——装法看 `README.md`，改了哪些东西看 `CHANGELOG.md`。

违背下面任何一条，即使测试全绿也算改坏了：这几条守的不是代码正确性，是**这个插件还叫不叫大肥鱼**。

---

## 1. 零依赖是铁律

`package.json` 里 `dependencies` / `peerDependencies` / `devDependencies` **三个必须永远是 `{}`**。

- 原因不只是「省事」：DSH 插件多挂一个包，就可能把宿主正在用的旧核心包拖进依赖树，装完重启后宿主直接崩（本机踩过，见 `README.md` 里 tool.js 那段 `unsupported JSON schema` 的记录）。
- 需要 HTTP → 用内置 `fetch`。需要签名 → 用内置 `crypto`。需要解压 → 用内置 `zlib`。需要子进程 → 用内置 `child_process`。**这些全都有，没有必须装包才能干的事。**
- 测试只用 `node:test` + `node:assert`，不引测试框架。

## 2. 不许加人格设置界面

**没有**性格滑条、好感度数字、亲密度进度条、人设输入框、情绪标签。

- 设置页只放**环境参数**：几点醒、醒几次、一天几条事件、刷不刷 B 站、每天刷几次。这些是「生长环境」，不是她本人。
- 人格只能**通过事件长出来**。任何让用户直接写「你是一个温柔的…」的入口，等于把产品变回角色扮演，直接违反本项目的立项前提。
- 判断标准很简单：如果加了之后用户能**直接指定**她是什么样的人，就是错的。
- **但「怎么称呼用户」不是人格开关（0.9.9 起，issue #127）**：`owner.pronoun`（`他` / `她` / `TA`，默认 `他`）与 `ask_pronoun` 工具只换「给她看的文本里指你的那个字」，不换性格、不影响她怎么说话、不动界面文案。它进 `/config` 白名单、用户能改，都不算违反本节。

**唯一例外：导入别人养过的那一位（0.5.3）**。用户 m03170 明确要「尊重别人的想法」——对方已经在别处养出了样子，接过来是**继承一份既成事实**，不是由用户在这里凭空指定性格。这条通道的三条边界，越界就等于变回角色扮演：

1. **只写 `seed`，不写配置**。人设正文进事件流（她以后能自己 revise），不进 `config.json`；`persona` 这组键也**不进 `/config` 白名单**，外部改不了。
2. **只在还没有 `seed` 的一局生效**。有起点就 409 拒绝，让他先重置——覆盖一个正在长的她要由人手动做，不由接口做。
3. **不带成长结果**。天数固定回第 1 天，判断、疤、拒绝记录、日记一律不迁。导入的是「她本来是谁」，不是「她已经活到哪」。

## 3. 四条黑名单是代码级硬禁，不是提示词

真相在 `lib/rules.js`（四层结构）与 `lib/persona.js`（`PRESCRIPTION_BANS`、`HARD_BANS`），不在文档里。

| 条款 | 真相在哪 | 守它的测试 |
| --- | --- | --- |
| 不撒娇卖萌（写成「还不会」，不是「不许」） | `lib/rules.js` 的 `learn-affection` | `test/rules.test.mjs`（断言含「还不会」且不含「不可以」） |
| 没有好感度/亲密度数字 | `lib/rules.js` 的 `no-relational-score` | `test/rules.test.mjs`（提示词里 `cannot` 只剩这一条） |
| 不能读自己的数值与设定（能看自己说过什么） | `lib/rules.js` 的 `no-read-self`（物理层，`section: null`，**不进提示词**）；工具侧由 `lib/restrict.js` 的 `HER_TOOLS` 收窄 | `test/rules.test.mjs` + `test/restrict.test.mjs` |
| 不能调工具改自己 | `lib/rules.js` 的 `no-self-modify`（物理层，同样不进提示词）；写入侧唯一入口是 `lib/capture.js` 的 `growth_commit` | `test/rules.test.mjs` + `test/capture.test.mjs` |

两条实现原则，改代码时别破坏：

- **物理层与契约层不进提示词。** 写「你不可以读设定」等于告诉她「旁边有份设定，很关键」——那是诱因，不是防线。靠代码不给路径、不给工具来保证。
- **不要绕过 `lib/guard.js`。** 她是"根本没看见"重塑人格那句话，不是"看见了但被劝住"。任何新的输入口（新工具、新接口、新外部文本源）都必须过 `lib/guard.js`；秘密外发（cookie / token / `sk-` / Bearer / 长 base64）在这里一律拦下。

## 4. 文案有守门词，改之前先看测试

面向用户的字符串（`lib/client.js` 里的界面文案）有三条硬规矩，全部有测试盯着；另外还有一条管**别的方向**的文本，别混起来：

- **不出现男字旁的「他」**，统一写「你」。守着它的是 `test/p5.test.mjs` 里那个逐字扫 `lib/client.js` 字符串字面量的测试（注释不算；不要引用行号，会漂）。例外只有 `其他/其它` 这类词素。她自己的话、引用别人的话不受此限。
- **给她看的文本里指主人的那个字，写 `{T}`，不要写死「他」（0.9.9 起，issue #127）。** 模板句统一写 `{T}`（`lib/pronoun.js` 的 `OWNER_SLOT`），出口过 `fillOwner(text, pronoun)` 填成 `他` / `她` / `TA`（默认 `他`）；`lib/persona.js` 的 `assemble()` 收尾、`lib/use.js` 的 `description` / `brief` 都已经填过一遍。**上面那条管界面，这条管她读到的文本，两条不冲突**：界面文案永远只写「你」，从不出现第三人称。解析用的正则里写死「他」不算违规（`lib/derive.js` 的 `nameSayRe('称呼你|叫你|称呼他…')` 那类是在认字，不是在称呼）。`test/pronoun.test.mjs` 守着「只认 他/她/TA」「`fillOwner` 只填占位符、不按字替换」。
- **统一「四个阶段」与「三道瓶颈」**，**禁**「四道门 / 三道门」。`test/principle-zoom.test.mjs` 明确断言 `三道门`/`四道门` 不出现。
- **立场不是第五关。** 措辞只能是「四个阶段完成之后才会开始有立场」。图上不许再退回「底部一行小字」的表达——立场是独立区块，由 `test/principle.test.mjs`（viewBox 1160 + 含「立场清单」）与 `test/stance.test.mjs`（旧的「纵向长「立场清单」」写法必须不存在）共同守着。

改界面文案时**先跑那三条**再改别的，否则会来回返工。

## 5. `events.jsonl` 只能追加

`~/.dsh-fish/events.jsonl` 不能删除记录，是唯一可信源，一行一条。**任何改写/删除/重排都是篡改她的记忆。**

- 状态（`state.json`）是派生品，随时可由 `rebuild()` 重算；改它没意义，会被覆盖。
- 「让她忘」不是删行，是**降低召回**（`lib/persona.js` 的 `foldOlderBeliefs`：更早的判断折成一行「还有 N 条更早的，没摆出来」，疤那类永不折叠），事件原文始终还在 `events.jsonl` 里，她也能用 `her_recall` 翻回去。
- 重置与恢复都不删数据：`lib/reset.js` 改名前缀封存，`lib/backup.js` 恢复前把旧档搬去 `dsh-fish-backups/pre-restore-*`。
- 新增事件类型**不必**改 `lib/schema.js` 的 `EVENT_SCHEMA_VERSION`：旧读者读不认识的 `type` 会跳过（`readEvents` 对未知类型宽容），0.7.6 / 0.8.0 的 `ask`、`answer`、`heard` 都是这样加进去的。但**改字段语义、把可选字段变必填、删字段**必须升 `v` 并写迁移（旧版本遇到新 `v` 要拒，否则静默丢字段）。

## 6. 改完必须跑全套测试

```bash
node --test
```

当前基线 **2490 个**，独立进程跑 `node --test` 应全绿。任何一条红都不许提交——包括看起来"不是我弄的"那条。

按环境挑跑法：

- **正常环境**：上面这条命令（不带参数，Node 自己递归找 `test/*.test.mjs`），约 33 秒。
- **别写成 `node --test "test/*.test.mjs"`**：Node 20 不展开 glob，会直接报 `Could not find '.../test/*.test.mjs'`；引号里的通配符只有 Node 22+ 认。CI 就是被这条拖红的。
- **也别写成 `node --test test/`**（目录形式）：Node 26 + Windows 下报 `MODULE_NOT_FOUND`，沙箱里还会 `spawn EPERM`。
- **沙箱 / 受限环境**：用 `node --test --test-isolation=none`，或逐文件跑。
- **`--test-isolation=none` 有跨文件假红**：ULID 与 cover 两条会因共享进程互相干扰而报错，单跑对应文件是绿的。判断是不是假红：逐文件独立进程跑一遍，全绿即假红。
- **`test/media.test.mjs` 的 `detectFfmpeg` 依赖 spawn**，在禁 spawn 的环境里会红（`spawnSync ... EPERM`）。这是环境限制，不是代码问题——但**不许**为了让它变绿而删掉那条断言。

CI 也跑同一套（`.github/workflows/test.yml`，Node 20 / 22 / 24 各跑一遍）。

## 7. 桥接不内置，靠 HTTP 投递 + 白名单放行

社区想把大肥鱼接到 QQ / 微信 / 别的 IM 上（0.6.1 起写进设置页说明）。**不要把任何 IM 协议、登录、收发塞进这个插件**——桥是别人的独立进程，我们只提供两个口子让它接进来。

### 7.1 首选：桥只走 HTTP，不要自建 DSH 会话

2026-11-03 定案（用户 m00584 / m00597：「我们这边做一下兼容，但不直接做桥的功能」）。

老做法是桥自己再起一条 DSH 会话，代价有两个：

- **人格分裂**：每条 DSH 会话是独立 agent，各自注入一份身份、历史互不可见。同一份 `events.jsonl` 被两条会话读，用户在两边看到的是"两个人"。
- **双实例抢占**：桥自起的进程与桌面版共用一个数据目录，`instance.json` 心跳一判活，后到的那个被判成只读房客（`bootstrapHome` 返回 `blocked:true`，不建会话）。

所以桥应该**只发 HTTP**，完全不碰 DSH 进程与 `instance.json`：

```
POST /dsh-fish/say
{ "text": "…", "channel": "qq-group:987654", "scene": "group", "speaker": "张三", "title": "摸鱼群" }
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `text` | 是（`image` 二选一） | 要递给她的话 |
| `image` | 否 | base64 图片 |
| `channel` | 否 | 渠道标识，桥自己起名。**同一个名字 = 同一间房** |
| `scene` | 否 | `desk`（默认，等于不传）/ `private` / `group` |
| `room` | 否 | `house`（并进书房）或 `channel`（另开一间）。不传时私聊回书房、群聊另开 |
| `speaker` | 否 | 这句话是谁说的。**任何场次都写进正文前缀**，不再只限群聊 |
| `guest` | 否 | `true` = 外客（群友私聊这类）。标明「不是他」，不算他来过、不涨轮数、不进书房桶 |
| `owner` | 否 | `true` = **这条是他本人说的**（2026-11-08，用户 m00394）。桥按 QQ 号判，插件**不猜昵称**。只对 `scene:'group'` 有意义：群里他的话进记忆（一句原话，`heard` + `scene:group`；设置里「记你原话的间隔」为 0 时不记），但仍然**不算他来找过她**。不传 = 老行为 |
| `title` | 否 | 侧栏显示名（群名、昵称）。不传才回落到 channel 键 |

路由规则（`lib/channels.js` 的 `resolveChannel`）：

- **不传 `channel`** → 家里那条会话。观测台、侧栏、老桥的行为一字不变。
- **`room: 'house'`** → 并进家里那条会话，场次照记（群聊仍记 `group`）。
- **`scene: 'private'`** → 默认**仍进家里那条会话**（"QQ 私聊和 DSH 对话融合"那个选项）。要每人一间，传 `room: 'channel'`。
- **`scene: 'group'`** → 默认按 `channel` 自建/复用一间房（记在 `channels.json`），cwd 仍是她的屋子，身份、工具面、白板都照旧——**还是同一个人，只是换了个房间说话**。想让所有群并进书房，传 `room: 'house'`。
- **`guest: true`** → 房间照开（如果 `room` 要求），但这条不算他来过：不写 `seen:`、不 `bumpTurns`、不触发轮换；正文标「有个不是他的人跟你说话」，她不会把群友当成主人。
- **`scene: 'group'` + `owner: true`**（2026-11-08，用户 m00394）→ 群里**他本人**说的话。进记忆（写一条 `heard`，带 `scene:'group'`，她翻到时读到的是「他在群里说：…」；设置里「记你原话的间隔」为 0 时不记，跟私聊同一个开关），但不进生命体征：不写 `seen:`、不 `bumpTurns`、不触发轮换、不进书房桶。**群友的话（不带 `owner`）一条都不进记忆**——这是产品边界，不是遗漏。

**常见布局都由桥表达，插件不写死：** 全部并进书房（不传 `channel`，或 `room:'house'`）；每群一间（`channel:'qq-group:<群号>'` + `group`）；群友私聊每人一间（`channel:'qq:dm:<QQ号>'` + `private` + `room:'channel'` + `guest:true`）；群友私聊进书房但标身份（`private` + `guest:true` + `speaker`）；只有 @ 她才进（桥侧过滤，不投递就不建房）。

**群房会轮换。** 默认一间群房用满 **7 天**换新的（`config.rooms.groupRotateDays`，`0` = 不换）：旧房改名成「… YYYY-MM-DD 之前」留在侧栏，新房从当天重新算天数。200 条上下文对热闹的群不够用，所以按天而不是按轮数。


启动前可以先探一句：

```
GET /dsh-fish/whoami
→ { plugin, version, root, home, sessionId, writable }
```

`writable: false` 表示这个数据目录已被另一个插件实例占着——桥看到就该停手，不要再起进程。`root` 用来判断"是不是同一个家"。

**桥那边怎么实现是桥的事**；我们这边只保证上面这几个字段能收、能落到正确的地方。

### 7.2 五个配套约定（改桥之后的正确性全押在这五条上）

1. **场次要进事件流**。`validateEvent` 现在接受可选 `scene`（非 `desk` 才落库，纯加法，不升 `EVENT_SCHEMA_VERSION`）。桥注入 `user/message` 时把 `scene` 写进 **`source.scene`**，`classifyMessage` 才会认出来（`lib/turns.js`）。
2. **外客不动生命体征**。`seen:`、`bumpTurns`、会话轮换只由 desk/private 且非 `guest` 触发；群聊与群友私聊一条都不写。否则群里一天几百句，冷落检测永远不会触发——他一周没露面，面板还显示"今天聊过"。`heard` 分两种：私聊/书房那条算「他来过」，群聊那条（`scene:'group'`）**不算**——`lib/schema.js` 的 `isContactEvent` 已经把群聊的 `heard` 排除掉了（2026-11-08）。**「他来过」也只认她自己的房间**（2026-11-11）：客户端亲手打的字（`source.kind:'user'` 且带 `clientTimeZone`）只有落在她住的那条会话、或 `channels.json` 里登记过的房间才写 `seen:`；本机别的 DSH 会话里他跟其他 agent 说话，不再清零冷落钟（用户报「好几天没回她还不算冷落」就是这条）。桥注入的消息（`kind` 不是 `user`、或没有 `clientTimeZone`）照旧算——QQ 私聊那条路不能断（issue #18）。
3. **外来场次必须带说话人前缀**。`lib/say.js` 对 `group` 与 `guest` 都用 `speaker` 拼 `某某在群里说：…` / `某某说：…`。不拼的话，群里三个人的话在她看来跟一个人连说三句一模一样，她会把三个人的观点拼成一个"他"。外来文本统一过 `lib/guard.js` 的 `sanitizeForeign`。
4. **桥不要用宿主的 `source.form`**。`snapshot`、`notice`、`catalog`、`instructions`、`recall` 是宿主前端的保留词表，`classifyMessage` 见到就当上下文，不算人（`MACHINE_FORMS`）。转述人说的话，要么不带 `form`，要么用 `relay`。
5. **走宿主 prompt 的桥，`rpcId` 就是记号**。`sessionController.prompt()` 把 `kind` 写死成 `user`，把调用方的 `requestId` 写进 `source.rpcId`，桥传不进自己的 `source`；`clientTimeZone` 是可选字段，忘了不会报错。2026-11-08 起 `classifyMessage` 把「带 rpcId 的 user 消息」也认作人：我们自己的 prompt 用 `PLUGIN_RPC` 前缀先挡掉，`lib/possess.js` / `lib/sessionnote.js` 的 append 没有 rpcId，仍留 unknown。桥仍应带 `clientTimeZone`——`dsh-time-context` 只认「kind user + rpcId + 时区」三者齐全的 source。正文末尾的 `[渠道：…]` / `[Channel: …]` 独立段落只影响记账（`lib/turns.js` 的 `stripChannelNote` 会裁掉），会话原文不动；只有提示的那条不算他来过。
6. **走 `prompt()` 的桥，发之前先登记这一轮是什么**（2026-11-09，issue #96）。上一条的「带 rpcId 就算人」把群聊、群友私聊、桥自己的定时提醒也一起算成了他本人：涨轮数、换会话、写 `seen:`、记「他说」、撤掉叫醒。桥在调 `sessionController.prompt()` 之前发一条即可：

   ```js
   ctx.emit('dsh-fish/source', { rpcId, scene: 'group', owner: true })
   ```

   字段：`rpcId`（必须与接下来那条 `source.rpcId` 一致）、`scene`（`group` / `private` / `desk`）、`owner`（群里他本人说的那句）、`guest`（外客，群友私聊这类）、`machine`（桥自己发起的轮次，不是人）。`classifyMessage()` 先查登记表：`machine` → `plugin`、`guest` → `group`、`group` + `owner` → `group-owner`、其余 → `human`。表按 rpcId 存 **5 分钟、最多 200 条**；不发就退回上一条的老判法（带 rpcId 当人），所以是加法，不改老桥。旁听记「他说」前会先裁掉正文**开头**那种「（群聊 · 示例群 · im:group:10001）」抬头（`lib/hear.js` 的 `stripLeadingHeader()`），只裁整行被括号包住且带群/渠道/频道字样的行。

### 7.3 对话靠工具发出去的部署

先问一句：**她写的正文会被插件自动发出去吗？** 会，就什么都不用填，只认正文的默认行为是对的。不会，也就是正文只留在会话里、要调工具才发得出去，才填下面这几项。都不认具体插件，工具名由配置给。

- `proactive.sendTools`：发送工具的名字，也要放进 `tools.allow`（工具面收窄开着时，没放行她调不到）。填了之后，只有这些工具调成功才算她开了口（记 `proactive-turn:`，占额度，不折叠），代码模式（run_code）里调的也算；只写正文算没开口。处境和身份段会照实写用这个工具、正文发不到聊天里。工具自己返回「没发出去」但没有报错的，这里认不出来。
- `proactive.idleCountsSeen`：`true` 时 `seen:` 也算打断安静、也算「他接了」。她靠工具回话、正文不进事件流时要开。它要有 `seen:` 可认：走 `/say`，或者 `source.kind` 不是 `user`，或者带 `clientTimeZone`，或者带 `rpcId`（走宿主 prompt 的桥一定会带）；`{kind:'user'}` 又没时区、又没 rpcId 的桥要自己写。代价是他在这台机器上和别的 agent 说话也算，所以默认关。

还有一项和工具无关：`proactive.foldSilent` 是 `false` 时，没开口的一轮只记账、不折。折叠会改历史，上下文很大、靠缓存省钱时可以关。

插件知道她在忙时（比如在打一局游戏），挂一个事件就行，不用知道 dsh-fish 的包名和路径：

```js
ctx.on('dsh-fish/busy', (sessionId) => stillPlaying(sessionId) ? true : undefined)
```

定时叫醒和主动回合投递前都会问一声。监听要同步返回，只有 `true` 算忙；不忙返回 `undefined`、`null` 或 `false`，返回别的值会挡住后面的插件，返回 Promise 按不忙算。忙的标记卡住时她就一直不被叫醒，所以结束时记得放开。不挂也没事，调度器自己知道家里那条会话正在跑的那一轮。

她问人的卡片（`ask_owner`、`bring_back`、规矩申请）默认挂在她那条会话的输入框上方，只等 5 分钟。人不在这台机器前就看不见，她这一轮还要白等，`ask_owner` 一天后记成「一直没人答」。插件能把话送到人在的地方时，把卡接走：

```js
// card: { id, sessionId, questions, detail }。questions 和宿主 userQuestions.ask 的同形；detail 是她说的「为什么」，可能是空串
ctx.on('dsh-fish/card', (card) => {
  if (!isHers(card.sessionId)) return undefined // 同步返回：async 监听会挡住后面的插件。bring_back 来自她出门那条会话，不是家里那条
  return relay(card)
})

async function relay(card) {
  await sendSomewhere(render(card)) // 发不出去就抛，这张卡退回会话上
  remember(card.id)                 // 自己存好，人可能隔几个小时才答，中间宿主可能重启
  return { via: 'QQ 私聊' }          // ask_owner 的回执会写：[已问，送到了QQ 私聊，还没答]
}

// 人答了。id 不用背，原样还回来
const r = await ctx.bail('dsh-fish/answer', { id, selected: ['可以'] }) // → { ok: true } 或 { ok: false, why }；dsh-fish 没装或停用时是 undefined
```

- 只有回了 `{ via }` 才算接走。不接返回 `undefined`；抛错、35 秒没回都算没接，这张卡照常弹在会话上。这一轮被取消也算没接，但不弹卡，没人答的话还留在观测台上。`via` 会过 guard.js，看着像改写指令的不念给她，只写「别的地方」。
- 卡上看着带凭据（她的问题、理由、选项，截断之前的原文也看）时不发这个事件，只留在本机的卡片上，日志里留一行 id。这条判断偏严，长文件名也可能中。`bail` 停在第一个非空返回值上，async 监听只有排第一的那个算数。
- `selected` 填选项原文，和宿主的回答同形。没选、对不上选项都是 `ok: false`，不结算这张卡，数字也不当下标（放过一天的会顺手记成以后再说，和定时器做的一样）。人回的不是选项时别猜成同意：只结算一次，错了改不回来。
- 回答不会自己进她的对话。人说的那句话照常交给她，或者自己告诉她。
- `ok: false` 时 `why` 说明原因，可以转告人。它不代表这张卡结了（写盘失败也是它），id 留着，人再答一次就再发一次。答过的、过期的会再说一遍原因。过没过期由这边判断，`ask_owner` 放一天，规矩申请放三天，`bring_back` 不过期，插件不用自己算。

### 7.4 另一条老路：工具白名单（仍然有效）

桥如果是以插件形式装进来、暴露工具给她的，仍然可以在 `config.tools.allow`（设置页「插件能力白名单」）里放行工具名。qq-bridge 默认要放行的是：

```
qq_send_message, qq_get_unread_messages, qq_reply
```

三条约束：

- **工具名必须对得上真实 registry**。桥升级改名、用户填错，她就会答「我没法在 QQ 上说话」——这不是插件坏了，是名字没对上。
- **放行之后要念给她听**。身份文档「我手上有什么」由 `lib/persona.js` 的 `toolBrief(extra)` 生成、`lib/selfdoc.js` 把白名单作为 `extraTools` 传进去。看不见一只手，她就不会用。收窄开着时念的是守卫**此刻真用的**名单（`currentAllowExtra()`）：0.9.8（2026-11-11）起设置页存白名单会当场换刀（`refreshToolRestrict()`，先下新刀再收旧刀），身份文档同一轮就跟着念，不用重启。手改 `config.json` 没有 watcher，仍要重启或再存一次才换。另外 `recheckToolRestrict()` 会在叫醒前（`lib/deliver.js`）和重启后 4 秒（`lib/restrict.js` 的 `startupRecheck`，挂 dispose 清理）按当下 `view()` 再对一次名册，晚到的外部工具当场补进来；已经一致的刀用 `knifeKey` 跳过。收窄本身是「先等注册到齐，到点按现状收」：开房先等已登记的名字注册上，3 秒内齐了换完整刀，到点还没齐就按已经到的名字收窄（`narrowed-late`），一个名字都认不得才 `deferred` 全开、只靠守卫。梦、定时那两段仍按启动那一刻算（见 `toolSectionsNow`），这两项改了仍要重启。收窄关着时照旧念配置。白名单里她自己的名字（her_say、her_dream 这些）两种情况都不念：那几样身份文档另有段落，her_dream 跟着「允许她记梦」走、不走白名单，设置页和自检也不把白名单当成它的修法。
- **白名单只做加法**。`config.tools.allow` 与 `HER_TOOLS` 取并集，不要用它去减工具；收窄只走 `lib/restrict.js` 那一套。

`test/beliefs.test.mjs` 有一条「白名单里额外放行的工具要念给她听」盯着这段，改之前先跑它。

**其余平台同理**：Chatbox、Monica、AstrBot 也走「社区桥 + 上面这两个口子」——不要把它们的协议塞进本插件，先找能桥过去的项目。不知道用什么项目、工具叫什么，就让她自己去查（前提是宿主放行了她能用的搜索/阅读工具）。

**永远不给人格/人称旋钮**（§2）：多间房不是多个人格，`scene` 只描述"这句话在哪儿说的"，不改变她是谁。

### 7.5 第三方工具接进成长机制：素材契约（1.0.0 起）

§7.4 的白名单只解决「她调得到」，不解决「读进来的话能不能被记住、被引、被核对」。默认情况下，第三方工具返回的只是当轮的工具结果：不进事件流、不写索引、不能引原话、不进八股统计。

契约是**可选、认领制**：工具返回值里带一个对象，形状如下。

```json
{
  "dshFishMaterial": 1,
  "source": "mirror",
  "key": "一件东西的唯一标识（视频的 bvid、文章的 slug）",
  "kind": "fact | opinion | fiction",
  "at": "2026-11-13",
  "title": "标题",
  "facts": [{ "text": "可核对的事实", "url": "https://…" }],
  "quotes": [{ "by": "谁说的", "text": "原话", "url": "https://…" }]
}
```

三条硬规则，不可协商：

1. **级别由插件定。** 第三方只能声明 `kind`。`fact` 想当一级材料，必须给锚（`facts` 非空，或 quote 带 `url`），否则插件把它降成二级并记 `fact-without-anchor`。第三方不能自己说「这是事实」。
2. **原话一字不改。** `quotes[].text` 只裁首尾空白；插件不改写、不压缩、不总结。
3. **不合规一律降级，不抛错。** 缺 `source`/`key`、空素材、超量、超长、类型不对——整条降为普通工具结果，她照常能看到那段文字，只是不进系统。

落地链路：`lib/contract.js` 的 `coerceMaterial()` → `lib/sources.js` 的 `sourceMaterial()`（内置来源优先，设置里同名覆盖不了 B 站的分级）→ `renderMaterialText()` 渲染（只标「谁写的」，不给她看等级数字）→ 记账 `meta mat:<source>:<key>` → `her_recall` 翻得到，`quote_one`、判断冲突、八股统计可用。

- **得到什么**：她以后能翻到这句话（60 天内、最多 30 条），能引原句，能进八股统计。
- **得不到什么**：不占身份文档 2400 字预算、不进 beliefs/stance、不算成长。契约管**质量**不管**频率**——它保证拿到的东西可核对，管不了她会不会去调。
- **明确不做**：不开通用 `read_source` 入口。每个来源的清洗规则不同，通用口只能保证「进得来」、保证不了「好进」。没按契约返回的第三方内容，就当普通工具结果。

参考：`docs/素材契约.md`（给第三方看的完整说明）、`lib/contract.js`（实现）、`test/contract.test.mjs`（14 条）。

## 8. 每样工具都要有一张能力地图

**新增、改名、删除工具时，`test/toolmap.test.mjs` 是第一道门：它按源码里的 `defineTool` 名字对账，少登记一行就红。**

一件工具要进她的身份文档，必须按这个顺序写三层：

1. **处境**：先写「什么时候想起它」——她是从眼前这件事走进工具的，不是从名字清单往下数。
2. **动作**：再写它替她做什么、做完留下什么。
3. **参数**：不写在这里。枚举、默认值、分页、编号只留在工具自己的 `description` 里；身份文档复述一遍，她就会在两份说法之间挑错。

另外两条：

- **「我做过的事」不是手写的。** 由 `lib/use.js` 的 `withUse` 记账、`resumeLines` 反推；没有 `use:` 账就整节不写。加工具时不用、也不许手工往文档里塞这一节。
- **场景工具不进家里的身份文档。** `lib/toolreg.js` 的 `SCENE_TOOLS`（如 `bring_back`）只在出门那趟才给：家里写着她有、伸手却答「现在没在外面」，等于每轮提醒她一件事做不了。它们的处境句写在工具 `description` 的第一句，并在 `SCENE_TOOLS` 里登记 `why`。

落地位置：家里能用的工具进 `test/toolmap.test.mjs` 的 `MAP`（工具名、所在说明书段、处境句正则）；场景工具进 `SCENE_TOOLS`。两处都没有的新工具，测试不放行。

## 9. 私人插件不写进本仓库

想给自己养的那条鱼加一件只属于你的工具（镜子、专属查询、私人接口），**不要往这个仓库里加 `plugin/`、`user-plugins/`、`extras/` 这类目录**，也不要往 `lib/` 里塞。2026-11-13 收到过这样的 PR（#134），没合并，原因就是下面三条。

- **`lib/` 跟着 npm 包走，升级时整包替换。** 仓库里另开目录也一样：`package.json` 的 `files` 是白名单（`LICENSE`、`lib`、`media`、`cordis.patch.yml`、`README`、`AGENTS`、`CHANGELOG`、`RELEASE-NOTES-*`、`scripts`、`tools`），私人目录进不了 npm 包；硬塞进仓库又会被 `git reset --hard` 还原；还会被 `node --test` 算进我们的绿线，基线从此依赖别人的代码和平台。
- **正确位置是本仓库外面**：一个普通 DSH 插件（`inject = ['tools']` + `ctx.tools.register()`），用 `dsh plugin --profile <profile> add "link:<那个目录>"` 装进来，再把工具名写进 `config.tools.allow`。面向用户的说明在 `README.md` 的「想给她加一件只属于你的工具」。
- **放行才念，不念就不会用**：白名单只做加法（§7.4），放行后 `toolBrief()` 会把它念进身份文档；不放行她既调不到，也不知道自己有这只手。
- **要推荐给别人**：写进 `README.md` 那一节，链接到对方仓库，代码留在对方那儿。不要在 `files` 白名单之外偷偷带一份。
- **想让她能引你工具里的原话**：按 §7.5 的素材契约返回，不要另开通用口。不按契约返回也能用，只是读进来的东西不会被记住、不能引原句、不进八股统计。

---

## 提 PR / 提交前自检

- [ ] 三个依赖字段还是 `{}`
- [ ] 没有新增人格设置入口
- [ ] 新输入口都过了 `lib/guard.js`
- [ ] 加 / 改名 / 删了工具，`test/toolmap.test.mjs` 的 `MAP`（或 `lib/toolreg.js` 的 `SCENE_TOOLS`）跟着改了（见 §8）
- [ ] `node --test` 2490 全绿
- [ ] 界面文案没有「他」「四道门」「三道门」；给她看的文本里指主人的字写的是 `{T}` 而不是写死「他」（见 §4）
- [ ] 改了 `EVENT_SCHEMA_VERSION` 的话，`CHANGELOG.md` 里写了迁移说明
- [ ] 没动包名；真要动，先看下面「包名与装法」那节
- [ ] 没有往仓库里加 `plugin/` 这类私人插件目录（见 §9）
- [ ] 动了升级 / 迁移脚本（`scripts/fix-legacy-link.mjs`、`lib/selfupdate.js`）的话，`README.md` 的升级表与 `RELEASE-NOTES-*.md` 同步改了

---

## 包名与装法（0.8.10 起，改名踩过一次，别再踩）

包名是 **`@ssamurias/dsh-fish`**（带 scope 的全名）。装法看 `README.md` 的「安装」，这里只列动代码时容易破坏的四条：

1. **`lib/client.js` 里 `__ModuleLoader__.load({ id })` 必须等于 `package.json` 的 `name`**，不是短名。client-modules 按 loader 条目名（完整包标识）解析浏览器包，名字对不上时客户端那半**静默不加载**——宿主照常跑、设置页空着，看起来像没装上。`test/client.test.mjs` 直接从 `package.json` 读 `name` 比对，别把那条断言改成写死字符串。
2. **`cordis.patch.yml` 的 `id` 保持短名 `dsh-fish`、`name` 写全名**（与 `@goodandready/dsh-voice` 一致）。`id` 变了会连带 client bundle 的 URL 对不上；`name` 写短名则 import 失败、直接崩在 web boot。
3. **别删升级脚本里的 normalize 那一步**（`lib/selfupdate.js` 的 `normalizeScript()`，安装脚本第 5/6 步）。0.8.9 之前装的 profile 里旧键还在，不清掉就会同时有两条鱼、两条 insert 撞一个 id，启动报 `duplicate factory registration`。
4. **`scripts/fix-legacy-link.mjs` 必须三种依赖写法都认**：源码目录 `link:`、`file:` 装的 tgz、`@ssamurias/dsh-fish@x.y.z` 版本号。版本号那条是 issue #43 的根因——照更新说明用 `dsh plugin add` 升上来的人，profile 里留下的就是版本号；脚本过去只认前两种，一句「没有老依赖，跳过」退出 0，旧键与旧 `bundles` 条目原封不动。改它之前先跑 `test/fix-legacy-link.test.mjs`（`migrateOne()` 是给它直接测的）。

