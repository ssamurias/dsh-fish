# plugin/ —— 已迁移到独立仓库

这里曾经放着两个给大肥鱼用的私人插件：

- `dsh-fish-mirror`（工具 `her_mirror`，照镜子）
- `dsh-fish-tts`（工具 `her_micro`，按情绪说一句）

按主包《第三方插件约定（v1）》§9「私人插件不写进本仓库」，它们已经迁到独立仓库维护：

**https://github.com/yamazakikaede/dsh-fish-plugin**

安装也从那边走：

```sh
dsh plugin --profile desktop add "link:<dsh-fish-plugin>/dsh-fish-mirror"
dsh plugin --profile desktop add "link:<dsh-fish-plugin>/dsh-fish-tts"
```

本目录保留作历史参考，不再更新。以后的新插件也只加在 `dsh-fish-plugin` 仓库里。
