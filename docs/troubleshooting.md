# 出问题了看这里（dsh-fish 排查手册）

README 只留最常见的三条。这一份收的是那些「一次踩过、以后大概率不会再碰」的坑——不是每次都需要的，但真撞上了能省一晚上。

先确认一件事：**插件装没装进去**。插件自己看不见自己没被加载，所以下面这条脚本要先跑：

```
node tools/check-install.mjs                 # 扫所有 profile
node tools/check-install.mjs --profile desktop
```

零依赖，插件没加载也能跑，会说出是「正常 / 装的是旧副本 / 副本空的或装了一半」，后两种直接给修法。npm 装的话脚本在 `node_modules/@ssamurias/dsh-fish/tools/check-install.mjs`。

---

## 升级了却没变化？先看设置页顶上那张卡（0.8.0）

profile 里写 `"dsh-fish": "file:D:/DSH/plugins-src/dsh-fish"` 时，pnpm 会往 `node_modules\dsh-fish` 落一份**独立副本**，而 DSH 加载的就是副本。只把新版本覆盖到源目录、然后重启——跑起来的还是旧代码，界面没有报错，日志也不会多一行（新代码压根没执行）。

0.8.0 起启动时会比一次：profile 里那条 `file:` 指向的目录版本 vs 正在跑的 `VERSION`。对不上就

- 设置 → **数据** 页靠下的位置出现一张「升级没有真正装进去」的卡（在「导入」卡下面、最底下的重置按钮上面），写清两条修法：关掉 DSH 后 `pnpm install --force`，或者直接删掉 `node_modules\dsh-fish` 再启动；
- 启动日志里留一行 warn，`/state.upgrade` 也带着 `{stale, older, running, source, sourcePath}`。

只有 `link:` 安装、读不到源目录、`package.json` 坏了这几种情况会静默跳过，不影响启动。
**还有一种它查不到的情况：副本是空的。** 如果 pnpm 装到一半失败，`node_modules\dsh-fish` 可能是个空目录（或只有零星几个文件）——这时插件根本没被执行，那张卡也不会出现（卡是插件自己画的）。判断方法很简单：看 `node_modules/dsh-fish\package.json` 在不在、版本号对不对：

```
node -p "require('C:/Users/你/.dsh/profiles/desktop/node_modules/dsh-fish/package.json').version"
```

路径换成你自己的 profile。读不到就是空的：重装一遍（`pnpm install --force`）再启动；**装的时候不要只看命令回显——要看退出码。**

空副本让插件「连自己都没跑起来」，所以「插件自检」这条路在安装失败面前天生看不见；0.8.1 把 `userQuestions` 从 `inject` 里摘掉，就是不想再有第二条同样看不见的静默消失。

## 两个工作区、两个家（0.6.7）

一个工作区只该有一个家。如果同一个 DSH 里两个工作区都装了大肥鱼、又都落到同一个目录（最常见的原因：只搬了**插件文件夹**、没配 `root`，或 `cordis.patch.yml` 里那条 `id` 在升级后对不上），0.6.7 起会**自己认出来**：

- 加载时在数据目录里写 `instance.json`（谁占着、什么时候心跳、进程号、机器名），每 15 秒续一次；45 秒没续、或同一台机器上那个进程已经没了，就当作上一任崩了，新的立刻接管（重启不用等）。
- 认领（读声明、判断、写声明）整段在 `<root>/.instance.lock` 里做，声明用原子写，写完隔 200 毫秒再读一次确认：两个实例同时启动，只有一个当上房主，另一个当场就是只读，不用等到第一次心跳。
- **后进来的那个不写**：`growth_commit` / `her_leave` / `bili_speak` 会直接回一句「这个家被另一个实例占着」，并说明怎么分开；身份文件也不落盘。已经写进去的旧事件不动。
- 每条事件现在带 `sessionId`（谁的哪条会话写的）；工具调用前还会核对**调用者的 cwd 属不属于当前家**，不属于就拒绝并说明——「谁在写」写进事件里，事后能查。

要真的分成两个家，别复制插件目录，只改配置：在 profile 的 `cordis.patch.yml` 里给这个插件加一条 `root`（`dsh-fish` 的 loader 条目 `id` 要对得上），两个工作区各指一个目录，重启 DSH。升级插件包**不会动** `cordis.patch.yml`（插件只写自己数据目录里的文件），但升级后值得回来看一眼那条 `id` 还在不在。

## 会话被归档了，为什么不再自动重开（0.6.8）

以前「把她的会话归档」等于「下次启动重开一间」——判活只看工作区的会话清单、又把归档的排掉，归档之后就成了「这个家没有会话」，于是每启动一次多一间。0.6.8 起语义变了：

- 归档 = **收起来**。`home.json` 里记 `status: 'archived'`（含 `archivedAt`），启动时不再自动新建。设置 → 大肥鱼 →「数据」页会出现一张「会话被收起来了」的卡片，点**「重新搭一間」**才会重开（对应 `POST /dsh-fish/home/rebuild`，要带 `confirm: 'rebuild'`）。插件自己的「重置一局」（`/reset`）不受影响，它本来就是要一局新的。
- **同一间房不再并发建两条。** 启动链路和「她要说话」链路都会找会话，现在按 root 单飞（同一个 promise），另外 `home.json` 的 `createdAt` 在 10 分钟内时，即使宿主索引还没列出那条会话也按「可复用」算。
- **换家留痕。** root 改了（`cordis.patch.yml` 里的 `root`）之后，新家从零开始，旧家原封不动留在旧路径——这正是「一夜之间多了个分身」的来源。现在数据目录之外记一份 `~/.dsh-fish-homes.json`（可用 `DSH_FISH_HOMES` 覆盖），root 变了会写一条 `meta` 事件「家换了：A → B。这不是搬家……」，进日志、进 `/state.homes`，设置页数据页顶部也会并排给出两条路径。
- **归档的是那一条，不是整个家。** 以前 `home.json` 只认一条会话，它一归档，插件就说「这个家的会话被收起来了」——哪怕同一个工作区里还有另一条好好开着。现在两条归档判定（`home.json` 的 `status:'archived'` 与宿主的 `archivedSessionIds`）在拒绝之前都先看同屋：还有没归档的会话就认那一条（取 `ws.sessionIds` 里最近的一条），把 `home.json` 改指过去、清掉归档标记，并记一行日志。一条都不剩才说「被收起来了」，也不会因此硬造一条新的。

**换家 ≠ 搬家**：想把她的东西带过去，用「数据 → 迁移工作区」（写 `~/.dsh-fish-location.json` 指针），不要改 `root`。

## 两个实例同时开同一个家（0.8.0）

0.6.8 的单飞锁只在**一个进程内**有效。真把 DSH 开两遍、两边都落同一个 `root` 时，第二个进程照样会走到「建会话」那一步（房客日志里成对的 `home.json.*.tmp` 就是这么来的），于是每开一次多一条会话。0.8.0 补了两处：

- **占用中的家只读**：`instance.json` 显示这个家已被别的实例占着时，启动**什么都不建**（连空工作区也不建），只把 `home.json` 里那条会话报上去，也不叫醒她。设置 → 数据页会出现「这个家在别处也开着」的卡片；关掉另一个实例后，下次启动自动接管。
- **跨进程一把锁**：`ensureTalkSession` 从读 `home.json` 到写回整段在 `<root>/.talk-session.lock` 里跑（`wx` 独占创建、mtime 超过 30 秒算陈旧锁）。等 8 秒还拿不到就不硬建：读一眼 `home.json`，有会话就复用，没有就明确失败，下次再来。

想真正并存，还是那句话：在 `cordis.patch.yml` 给每个条目配**不同的 `root`**，不要让两个实例住同一个家。

## 适配哪些 DSH 版本（0.8.1）

`package.json` 里写了两处，跟市场上的插件用同一套写法：

```json
"engines": { "dsh": ">=0.2.0-rc.1 <0.3.0-0" },
"dsh": {
  "compatibility": {
    "dsh": ">=0.2.0-rc.1 <0.3.0-0",
    "dshReleases": { "0.2.1-rc.2": "compatible", "0.2.1-rc.3": "compatible", "...": "unknown" },
    "profiles": ["desktop", "web", "headless"]
  }
}
```

- `engines.dsh` 是宿主安装/检查时真读的那一条；不满足会作为 `engines.dsh` 报出来。
- `dsh.compatibility.dshReleases` 是逐版本的态度：只在**真跑过**的版本上写 `compatible`，其余写 `unknown`——写 `unknown` 不是「不支持」，是「没测过」。
- 当前写 `compatible` 的是 `0.2.1-rc.2`、`0.2.1-rc.3`（房客与开发机在 0.8.x 上跑过的两个），具体清单以 `package.json` 为准。

运行时还会自己对一次账（`lib/hostver.js`）：从插件所在位置向上找宿主的 `package.json`，读到版本就比范围。

- 在范围里：什么也不说。
- 比自己要求的下限还旧、或超出上限：`logger.warn` 一行，设置页「数据」页多一张卡说明**只提醒、不拦人**——插件照常跑。
- 读不到（桌面版把宿主装进 `app.asar`，从插件位置找不到）：记 `unknown`，不把「读不到」当成「不兼容」，否则每个桌面用户都会看到一张假警告。

**为什么下限是 0.2.0-rc.1 而不是更低**：插件用到的宿主接口（`tools.register/view/restrict`、`sessionController.create/prompt/rename/resolveAgent`、`workspaceRegistry`/`archiveSession`/`setTitle`）在 0.1.x 的包里其实已经有了（查过 `dsh-tools@0.1.0-rc.8`、`dsh-api-session-controller@0.1.2-alpha.2`、`dsh-workspace@0.1.0-rc.8`），但**没有在那些宿主上真跑过**。声明的意义是承诺测过的范围，不是猜一个更大的数。

**这一条管不到的事**：`inject` 里的四个服务（`sessionController`、`tools`、`webServer`、`connection`）仍然是硬依赖——缺任何一个，插件在 import 阶段就被跳过、连日志都不写。这类情况只能从外面查：`node tools/check-install.mjs`。
