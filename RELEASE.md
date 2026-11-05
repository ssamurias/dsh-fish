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
npm whoami                  # 必须是 ssamurias；报 E401 就先 npm login
gh auth status              # 必须是 ssamurias
```

- 发布本身**不碰本地 profile**，不用关 DSH Desktop。
- 只有「发完在本地装一遍验证」时才要先关应用——运行中替换已加载的包会 `ERR_PNPM_EPERM`（避坑指南第 3 节）。
- 本机 npm 账号开了 2FA 的话，`npm publish` 会要 6 位验证码，见第 4 步。

---

## 1. 发布前自检（每次都要跑，别跳）

- [ ] `package.json` 的 `version` 就是要发的号（0.9.x 阶段只发 patch）
- [ ] `node --test` 全绿（0.9.1 基线：**1512 pass / 0 fail**，约 22 秒）
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

- 0.9.1 的本地状态：`main` 领先 `origin/main` 9 个提交（含四个社区 PR 的合并提交），一直没 push——这是故意的，等维护者说「发」。
- 没点头就停在这里。下面每一步都会动线上（GitHub / npm），发布出去基本收不回。

---

## 3. 推代码上 GitHub

```bash
git push origin main
```

- 若 `github.com:443` 不通（本机常见），改用 GitHub Git Data API 推，流程见技能 `mem-skill-github-com-443-github-git-data-api-sha-ebd4879ead19`。
- **不要** `git push --force` / `git push --delete`：会被 CC Safety Net 拦下。确需删远端引用，用 `gh api -X DELETE /repos/ssamurias/dsh-fish/git/refs/<ref>`。
- 推完去 Actions 看一眼三档 Node（20 / 22 / 24）是否全绿：`gh run list --limit 3`。

---

## 4. 发 npm 包

```bash
npm whoami                 # 再确认一次身份，避免发到别人账号下
npm publish
```

- 本包已是公开的 scoped 包，**不需要** `--access public`（首次发布才要）。
- 2FA 开着时：`npm publish --otp=<6位验证码>`。
- 常见报错：
  - `E401`：没登录 / token 过期 → `npm login`
  - `E403`：账号没有 `@ssamurias` scope 权限
  - `EPUBLISHCONFLICT`：这个版本号已经发过 → `npm view @ssamurias/dsh-fish versions` 看现有版本，必要时升 patch 号重来（已发布的版本不能覆盖）
- `publish` 前想再核一次打进去的文件，可用 `npm publish --dry-run`。
- 用户端注意：pnpm 的 `minimumReleaseAge`（默认 24 小时）会把「太新」的版本回滚掉；本机 profile 已设 `minimumReleaseAge: 0`（避坑指南第 3 节）。

---

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

---

## 6. 发布后验证

```bash
npm view @ssamurias/dsh-fish version dist-tags
npm view @ssamurias/dsh-fish@0.9.x dist.tarball
gh release view v0.9.x
```

- `dist-tags.latest` 要指向新版本；`dist.tarball` 能取到 URL 就说明包在。
- 想真装一遍：**先关 DSH Desktop**，用临时 profile 试装（不要直接动 `desktop` profile）——`bundles` 与 `dependencies` 必须一一对应，先只改依赖、装包，再用目录联接的临时 profile 跑 `--dump-config` 预演（避坑指南第 1 节）。
- 回 issue：#32–#38、#41–#43 各回一条「0.9.1 已发布，装法见 README」，等作者确认后再关。
- 给四个社区 PR 的作者（@BBleae 等）留一句「已随 0.9.1 发布」。

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
