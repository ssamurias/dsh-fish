/**
 * tool.js —— 插件自己注册工具时用的那个「定义函数」
 *
 * 为什么**不再** import 宿主的 `@deepseek-ai/dsh-tools`（2026-10-25 定）：
 *   用全新 profile 从 tarball 装一遍才暴露出来。插件以 `link:` 装在 desktop
 *   profile 里时，从插件源码目录（一个普通的本地目录）往上
 *   找不到 `@deepseek-ai/dsh-tools`——它躺在 `~/.dsh/profiles/node_modules` 里，
 *   import 失败，于是六个文件都走了 `spec => spec` 的兜底，工具正常。
 *   但 npm 装进来的插件，真实路径是 `<profile>/node_modules/dsh-fish/`，往上走
 *   一层就找到它：`defineTool` 于是真的被调用，而它要的是「简写 DSL 属性表」
 *   （`{ text: { type: 'string' } }`），我们传的是完整 JSON Schema
 *   （`{ type: 'object', properties: { … } }`）。编译时它把根上的
 *   `type: 'object'` 当成一个叫 `type` 的参数，报
 *     unsupported JSON schema: parameters.type must be a value schema object
 *   → 6 个工具全部注册失败，她连一句话都留不下来。
 *   本机一直是 link: 装的，所以这条从没在本机出现过：只有别人装了才会坏。
 *
 * 结论：注册时**直接交标准 JSON Schema**。宿主 registry 只校验 `output.schema`，
 * `parameters` 原样交给 provider，而 provider 要的就是 JSON Schema——中间不需要
 * 任何人替我们编译。所以不需要 defineTool，只要保持 `defineTool(spec)` 这个调用形状。
 *
 * 守门测试：test/tools.test.mjs 里禁止 lib/*.js 出现 `@deepseek-ai/dsh-tools`。
 */
/**
 * 注册期临时挂上的「包一层 execute」钩子（2026-11-10，外部真机 0.9.6 / 0.9.7）。
 *
 * 这是**唯一安全**的注册期包装点：`ctx.tools` 是按 ctx 现取的追踪 proxy，写属性
 * 会落到共享的服务实例上（换上去的方法会一直留着，还把 `this` 钉在插件 ctx 上），
 * 所以那边一个字节都不能动。`defineTool` 是我们自己的调用形状，包在这里只影响
 * 我们自己的定义：只在注册那段同步代码里生效，出去之后立刻摘掉，平时仍是恒等。
 */
let useWrap = null

/** 换掉注册期的包装钩子；返回上一个，供调用方恢复。 */
export function setToolUseWrap(fn) {
  const prev = useWrap
  useWrap = typeof fn === 'function' ? fn : null
  return prev
}

export const defineTool = (spec) => (useWrap ? useWrap(spec) : spec)

