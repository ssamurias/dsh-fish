# 第三方来源与致谢

本文件从 `LICENSE` 中拆出。`LICENSE` 保持标准 MIT 全文，便于 GitHub 正确识别协议；
项目来源、引用与素材授权说明放在这里。

## 代码来源

本项目**不含上游代码派生**：`lib/` 下全部实现（事件流、四个阶段与三道瓶颈、记忆显著性与固化、
拒绝与疤、事件卡与节奏缩放等）均在本项目中新写；B 站接口的行为来自本机实测
（见 `lib/bili.js` 头部注释），不是官方 API，未拷贝任何第三方库，插件也没有任何运行时依赖。

## 思想引用

原理页引用了 Kolb / Piaget / Bowlby / Erikson / Festinger / Bartlett / Dewey / Schön 的理论，
属思想引用，页底标注了作者与年份；不含他人代码或原文。

- 主观能动性的攒劲机制灵感来自交流群 2 群的群友「无」；落进本插件时全部重新实现，没有代码或文本的直接搬运。
- 兴趣与好奇的判据为自研实现（`lib/interest.js`、`lib/curiosity.js`），未移植任何第三方插件代码；概念上参考了 Loewenstein 的信息缺口理论（1994）、Generative Agents 的记忆时间衰减排序（2023）与 Oudeyer 关于内在动机中「新奇会失效」的论述（2007）。

## 美术资源

- `media/fish.jpg`：作者提供的大肥鱼原图经 AI 生成，随本仓库以同一许可（MIT）授权。
- `media/principle-loop.svg`、`media/principle-memory.svg`：本项目自绘。
- 除此之外不含第三方美术资源——头像由用户自行上传（存在 `~/.dsh-fish/avatar.<ext>`）。
