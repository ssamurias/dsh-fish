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
- **不要绕过 `lib/guard.js`。** 她是"根本没看见"重塑人格那句话，不是"看见了但被劝住"。任何新的输入口（新工具、新接口、新外部文本源）都必须过 `guard.js`；秘密外发（cookie / token / `sk-` / Bearer / 长 base64）在这里一律拦下。

## 4. 文案有守门词，改之前先看测试

面向用户的字符串（`lib/client.js` 里的界面文案）有三条硬规矩，全部有测试盯着：

- **不出现男字旁的「他」**，统一写「你」。`test/p5.test.mjs:187` 逐字扫。例外只有 `其他/其它` 这类词素。她自己的话、引用别人的话不受此限。
- **统一「四个阶段」与「三道瓶颈」**，**禁**「四道门 / 三道门」。`test/principle-zoom.test.mjs` 明确断言 `三道门`/`四道门` 不出现。
- **立场不是第五关。** 措辞只能是「四个阶段完成之后才会开始有立场」。图上不许再退回「底部一行小字」的表达——立场是独立区块，由 `test/principle.test.mjs`（viewBox 1160 + 含「立场清单」）与 `test/stance.test.mjs`（旧的「纵向长「立场清单」」写法必须不存在）共同守着。

改文案时**先跑这三条**再改别的，否则会来回返工。

## 5. `events.jsonl` 只能追加

`~/.dsh-fish/events.jsonl` 不能删除记录，是唯一可信源，一行一条。**任何改写/删除/重排都是篡改她的记忆。**

- 状态（`state.json`）是派生品，随时可由 `rebuild()` 重算；改它没意义，会被覆盖。
- 「让她忘」不是删行，是**降低召回**（`lib/persona.js` 的 `foldOlderBeliefs`：更早的判断折成一行「记不清原话了」，疤那类永不折叠），事件原文始终还在 `events.jsonl` 里，她也能用 `her_recall` 翻回去。
- 重置与恢复都不删数据：`reset.js` 改名前缀封存，`backup.js` 恢复前把旧档搬去 `dsh-fish-backups/pre-restore-*`。
- 新增事件类型**不必**改 `lib/schema.js` 的 `EVENT_SCHEMA_VERSION`：旧读者读不认识的 `type` 会跳过（`readEvents` 对未知类型宽容），0.7.6 / 0.8.0 的 `ask`、`answer`、`heard` 都是这样加进去的。但**改字段语义、把可选字段变必填、删字段**必须升 `v` 并写迁移（旧版本遇到新 `v` 要拒，否则静默丢字段）。

## 6. 改完必须跑全套测试

```bash
node --test
```

当前基线 **1394 个**，独立进程跑 `node --test` 应全绿。任何一条红都不许提交——包括看起来"不是我弄的"那条。

按环境挑跑法：

- **正常环境**：上面这条命令（不带参数，Node 自己递归找 `test/*.test.mjs`），约 17–18 秒。
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
{ "text": "…", "channel": "qq-group:987654", "scene": "group", "speaker": "张三" }
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `text` | 是（`image` 二选一） | 要递给她的话 |
| `image` | 否 | base64 图片 |
| `channel` | 否 | 渠道标识，桥自己起名。**同一个名字 = 同一间房** |
| `scene` | 否 | `desk`（默认，等于不传）/ `private` / `group` |
| `speaker` | 否 | 群聊里这句话是谁说的，写进正文前缀 |

路由规则（`lib/channels.js` 的 `resolveChannel`）：

- **不传 `channel`** → 家里那条会话。观测台、侧栏、老桥的行为一字不变。
- **`scene: 'private'`** → **仍进家里那条会话**（这就是"QQ 私聊和 DSH 对话融合在一起"那个选项，真融合，不会分裂）。
- **`scene: 'group'`** → 插件按 `channel` 自建/复用一间房（记在 `channels.json`），房间 cwd 仍是她的屋子，所以身份、工具面、白板都照旧——**还是同一个人，只是换了个房间说话**。

启动前可以先探一句：

```
GET /dsh-fish/whoami
→ { plugin, version, root, home, sessionId, writable }
```

`writable: false` 表示这个数据目录已被另一个插件实例占着——桥看到就该停手，不要再起进程。`root` 用来判断"是不是同一个家"。

**桥那边怎么实现是桥的事**；我们这边只保证上面这几个字段能收、能落到正确的地方。

### 7.2 三个配套约定（改桥之后的正确性全押在这三条上）

1. **场次要进事件流**。`validateEvent` 现在接受可选 `scene`（非 `desk` 才落库，纯加法，不升 `EVENT_SCHEMA_VERSION`）。桥注入 `user/message` 时把 `scene` 写进 **`source.scene`**，`classifyMessage` 才会认出来（`lib/turns.js`）。
2. **群聊不动生命体征**。`seen:`、`heard`、`bumpTurns`、会话轮换只由 desk/private 触发；群聊一条都不写。否则群里一天几百句，冷落检测永远不会触发——他一周没露面，面板还显示"今天聊过"。
3. **群聊必须带说话人前缀**。`lib/say.js` 用 `speaker` 拼 `某某在群里说：…`。不拼的话，群里三个人的话在她看来跟一个人连说三句一模一样，她会把三个人的观点拼成一个"他"。外来文本统一过 `lib/guard.js` 的 `sanitizeForeign`。

### 7.3 另一条老路：工具白名单（仍然有效）

桥如果是以插件形式装进来、暴露工具给她的，仍然可以在 `config.tools.allow`（设置页「插件能力白名单」）里放行工具名。qq-bridge 默认要放行的是：

```
qq_send_message, qq_get_unread_messages, qq_reply
```

三条约束：

- **工具名必须对得上真实 registry**。桥升级改名、用户填错，她就会答「我没法在 QQ 上说话」——这不是插件坏了，是名字没对上。
- **放行之后要念给她听**。身份文档「我手上有什么」由 `lib/persona.js` 的 `toolBrief(extra)` 生成、`lib/selfdoc.js` 把 `config.tools.allow` 作为 `extraTools` 传进去。看不见一只手，她就不会用。
- **白名单只做加法**。`config.tools.allow` 与 `HER_TOOLS` 取并集，不要用它去减工具；收窄只走 `lib/restrict.js` 那一套。

`test/beliefs.test.mjs` 有一条「白名单里额外放行的工具要念给她听」盯着这段，改之前先跑它。

**其余平台同理**：Chatbox、Monica、AstrBot 也走「社区桥 + 上面这两个口子」——不要把它们的协议塞进本插件，先找能桥过去的项目。不知道用什么项目、工具叫什么，就让她自己去查（前提是宿主放行了她能用的搜索/阅读工具）。

**永远不给人格/人称旋钮**（§2）：多间房不是多个人格，`scene` 只描述"这句话在哪儿说的"，不改变她是谁。


---

## 提 PR / 提交前自检

- [ ] 三个依赖字段还是 `{}`
- [ ] 没有新增人格设置入口
- [ ] 新输入口都过了 `guard.js`
- [ ] `node --test` 1394 全绿
- [ ] 界面文案没有「他」「四道门」「三道门」
- [ ] 改了 `EVENT_SCHEMA_VERSION` 的话，`CHANGELOG.md` 里写了迁移说明
