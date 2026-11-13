# dsh-fish-mirror

给 [dsh-fish](../../dsh-fish) 里的「大肥鱼」一面镜子：一个只读工具 `her_mirror`，让她看一眼别人替她留下的那张照片。

## 为什么单独一个插件

`dsh-fish` 跟着上游走，本机升级会 `git reset --hard` 覆盖它的工作区。所以这里只读它的**数据目录**，不 import 它的模块，也不往它的事件流里写东西。

## 镜子里的图

按顺序找 `<数据目录>/` 下的：

1. `avatar.png` / `avatar.jpg` / `avatar.webp` / `avatar.gif`（设置 → 大肥鱼 → 状态 → 换头像 传进来的那张）
2. `mirror.png` / `mirror.jpg` / `mirror.webp` / `mirror.gif`（不想动头像位时单独放一张）

两个都没有，工具就照实回「镜子里现在是空的」，不编一个样子出来。

## 怎么用

装好之后，把工具名加进 dsh-fish 的 `config.json`：

```json
{ "tools": { "allow": ["her_mirror"] } }
```

（设置页「手上能用什么 → 白名单」里加也行。）她多一只手，就能自己照镜子了。

## 边界

- **只读**：不写事件流、不写配置、不改头像。看没看过由她自己用 `growth_commit` 记。
- **不替她解释**：工具只给路径和事实（多大、什么时候放的），不说「这就是你」。
- 真正「看见」靠宿主提供的 `read_image`；宿主没有这个工具时，她只能拿到路径。
