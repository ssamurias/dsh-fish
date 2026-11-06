# 发版流程（dsh-fish）

> 适用 0.9.1 之后。本仓库的规矩是**先改在本地、后发布**：本地 `main` 改完、测试全绿，等维护者明确说「发」再执行第 3 步起的命令。没点头就只做到第 2 步。
>
> 本机环境：Windows + Git Bash；仓库在 `D:/deepseekagent/02-我的项目/大肥鱼/plugin`；`gh` 在 `/c/Users/DANG/bin/gh`（登录名 `ssamurias`）；npm 账号同名。

---

## 0. 发布前先确认三件事

```bash
cd "D:/deepseekagent/02-我的项目/大肥鱼/plugin"
git status --short          # 必须是空的
git log --oneline origin/main..HEAD   # 看看这次要发几个提交
npm whoami --registry=https://registry.npmjs.org/   # 必须是 ssamurias；报 E401 就先 npm login（见第 4 步）
gh auth status              # 必须是 ssamurias
```

- 发布本身**不碰本地 profile**，不用关 DSH Desktop。
- 只有「发完在本地装一遍验证」时才要先关应用——运行中替换已加载的包会 `ERR_PNPM_EPERM`（避坑指南第 3 节）。
- 本机 npm 账号开了 2FA 的话，`npm publish` 会要 6 位验证码，见第 4 步。

---

## 1. 发布前自检（每次都要跑，别跳）

- [ ] `package.json` 的 `version` 就是要发的号（修 bug 发 patch，如 `0.10.1`；一批改动发 minor，如 `0.10.0`）
- [ ] `node --test` 全绿（当前基线见 `AGENTS.md` 第 6 节；0.10.0 是 **1587 pass / 0 fail**，约 20 秒）
- [ ] `CHANGELOG.md` 顶部有本节，条目按 issue 编号写全
- [ ] `RELEASE-NOTES-x.y.z.md` 已写，且与 `CHANGELOG.md` 口径一致（issue 条数、PR 编号、日期）
- [ ] `README.md` 顶部「当前版本」段已换成这一版
- [ ] 升级路径有变化时，`README.md`「从旧版升到 0.9.x」表补了行，`AGENTS.md`「包名与装法」补了守门条目
- [ ] `npm pack --dry-run` 的文件清单对：`lib/`、`media/`、`scripts/`、`cordis.patch.yml`、`README.md`、`AGENTS.md`、`CHANGELOG.md`、`RELEASE-NOTES-*.md`、`RELEASE.md`；**不含 `test/`**
- [ ] 包里没有敏感文件（`.env`、profile、cookie、备份档）

```bash
node --test
npm pack --dry-run
```

`npm pack --dry-run` 只打印清单、不真打包；看完记得确认没有 `test/`、没有 `~/.dsh-fish` 相关的东西。

---

## 2. 本地提交（不 push）

```bash
git add -A
git commit -m "0.9.x：<一句话说清这一版>"
```

- 0.9.1 就是这么发出去的：先在本地攒了 10 个提交（含四个社区 PR 的合并提交），维护者说「发」之后才推。之后同样先攒、别边改边推。
- 没点头就停在这里。下面每一步都会动线上（GitHub / npm），发布出去基本收不回。

---

## 3. 推代码上 GitHub

```bash
git push origin main
```

- 若 `github.com:443` 不通（本机常见），改用 Git Data API 推：`node D:/deepseekagent/04-小工具/fish-push-generic.mjs`（逐提交建树、建 commit，并断言树 SHA 与本地一致），成功后 `node D:/deepseekagent/04-小工具/fish-realign-shas.mjs`（按 `.git/push-map.json` 把本地 SHA 对齐成服务端版本，同时更新 `origin/main`）。原理与三个坑见避坑指南第 27 节。
- **不要** `git push --force` / `git push --delete`：会被 CC Safety Net 拦下。确需删远端引用，用 `gh api -X DELETE /repos/ssamurias/dsh-fish/git/refs/<ref>`。
- 推完去 Actions 看一眼三档 Node（20 / 22 / 24）是否全绿：`gh run list --limit 3`。

---

## 4. 发 npm 包（需要你手动跑，可整段复制）

> 这一段是给维护者本人执行的：登录和 2FA 都在你的终端里完成，agent 不代跑发布。
> **本机的 2FA 是 Windows 系统密钥（安全密钥）**，所以每次发布都要走一遍完整登录流程；发完后 npm 的 CDN 大约要 **3 分钟** 才看得到新版本，核对命令等一会儿再跑。
> **本机 npm 默认 registry 是 `https://registry.npmmirror.com`，所以每条命令都必须显式带 `--registry=https://registry.npmjs.org/`**，否则会得到看似「包不存在 / 没权限」的 E404。

```bash
cd "D:/deepseekagent/02-我的项目/大肥鱼/plugin"

# 0) 确认身份：返回 ssamurias 就说明本机已经登录，可以跳过第 1 步
npm whoami --registry=https://registry.npmjs.org/

# 1) 只有第 0 步报 E401 / 不是 ssamurias 时才需要：浏览器登录
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/

# 2) 发布（开了 2FA 就在末尾加 --otp=123456）
npm publish --registry=https://registry.npmjs.org/

# 3) 核对：等约 3 分钟再跑，应为 0.9.x 和 latest -> 0.9.x
npm view @ssamurias/dsh-fish version dist-tags --registry=https://registry.npmjs.org/
```

- **不想每条都带参数**：`npm config set registry https://registry.npmjs.org/`，发完再改回 `npm config set registry https://registry.npmmirror.com/`。
- **scoped 包没有写权限时 npm 故意返回 404（不是 403）**：看到 E404 先查 `npm whoami`，别怀疑包名或网络。
- 本包已经是公开包，**不需要** `--access public`（只有首次发布才要）。
- 常见报错：
  - `E401`：没登录 / token 过期 → `npm logout --registry=...` 再 `npm login --registry=...`
  - `E403`：账号没有 `@ssamurias` scope 写权限，或开了 2FA 没给 `--otp`
  - `EPUBLISHCONFLICT`：这个版本号已经发过 → 已发布版本不能覆盖，升 patch 号重来
- `npm publish --dry-run` 可以先看会打进去哪些文件，不会真的发。
- 用户端注意：pnpm 的 `minimumReleaseAge`（默认 24 小时）会把「太新」的版本回滚掉；本机 profile 已设 `minimumReleaseAge: 0`（避坑指南第 3 节）。

## 5. 打 tag + 建 GitHub Release

**npm 发布成功之后**再做这一步，npm 失败就停住、别打 tag（免得留一个指向没发出去的版本的悬空 tag）。

```bash
git tag -a v0.9.x -m "0.9.x"
git push origin v0.9.x
export PATH="/c/Users/DANG/bin:$PATH"
gh release create v0.9.x -F RELEASE-NOTES-0.9.x.md --title "0.9.x"
```

- Release 正文直接用仓库里的 `RELEASE-NOTES-*.md`（`-F` 读文件），不要在网页上手打——两边会不一致。
- 想先存草稿：`gh release create v0.9.x -F RELEASE-NOTES-0.9.x.md --draft`，检查完再 `gh release edit v0.9.x --draft=false`。
- `git push origin v0.9.x` 若也卡在 443：用 `gh api -X POST repos/ssamurias/dsh-fish/git/tags` 在服务端建 tag 对象，再 `gh api -X POST repos/ssamurias/dsh-fish/git/refs -f ref=refs/tags/v0.9.x -f sha=<tag对象sha>`。
- 兜底也可以在网页上建 Release（会自动建 tag），但正文仍以 `RELEASE-NOTES-*.md` 为准，别手打。

---

## 6. 发布后验证

```bash
npm view @ssamurias/dsh-fish version dist-tags
npm view @ssamurias/dsh-fish@0.9.x dist.tarball
gh release view v0.9.x
```

- `dist-tags.latest` 要指向新版本；`dist.tarball` 能取到 URL 就说明包在。
- 想真装一遍：**先关 DSH Desktop**，用临时 profile 试装（不要直接动 `desktop` profile）——`bundles` 与 `dependencies` 必须一一对应，先只改依赖、装包，再用目录联接的临时 profile 跑 `--dump-config` 预演（避坑指南第 1 节）。
- 回 issue：这一版修到的每条 issue 各回一条「x.y.z 已发布，装法见 README，有问题随时回」，等作者确认后再关。
- 给这一版合入的 PR 作者留一句「已随 x.y.z 发布」；PR 没合并的不要在 GitHub 上点 merge，在回帖里说清「以提交形式合入」。

---

## 7. 出问题时怎么回滚

| 对象 | 命令 | 说明 |
| --- | --- | --- |
| npm 版本 | `npm unpublish @ssamurias/dsh-fish@0.9.x` | 72 小时内可撤；超过 72 小时改用 `npm deprecate @ssamurias/dsh-fish@0.9.x "原因，请装 x.y.z"`，不要再发同名版本 |
| git tag | `git tag -d v0.9.x` 然后 `git push --delete origin v0.9.x` | `--delete` 被拦时用 `gh api -X DELETE /repos/ssamurias/dsh-fish/git/refs/tags/v0.9.x` |
| GitHub Release | `gh release delete v0.9.x` | 加 `--cleanup-tag` 连 tag 一起删 |
| 代码 | 用 `git revert <提交>` 再正常 push | **不要** force push `main` |

---

## 8. 这个项目特有的坑（发布前扫一眼）

- **包名 / 迁移脚本别动**：`@ssamurias/dsh-fish`、`cordis.patch.yml` 的 `id: dsh-fish`、`lib/selfupdate.js` 的 `normalizeScript()` 三条都在 `AGENTS.md` 的「包名与装法」，发布前改它们等于给自己造升级事故。
- **升级说明要和脚本一致**：`scripts/fix-legacy-link.mjs` 现在认三种依赖写法（`link:` / `file:` tgz / 版本号）。改了它，`README.md` 升级表与 `RELEASE-NOTES-*.md` 必须同步改，否则用户照文档做还是会崩。
- **`desktop` profile 被应用独占**：`dsh plugin --profile desktop ...` 会被拒，验证要用别的 profile。
- **别在应用运行时替换已加载的包**：`ERR_PNPM_EPERM`，包目录会被留成「已删除」。
- 备份照旧放 `D:/deepseekagent/dsh-fix-backup/`，不要放进仓库。
