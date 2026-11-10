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
 * 注册期临时挂上的「包一层 execute」钩子（2026-11-10，外部真机 0.9.6）。
 *
 * 宿主把 `ctx.tools` 包成只读 proxy 时，`use.js` 给 `ctx.tools.register` 赋值
 * 会抛 `TypeError: 'set' on proxy: trap returned falsish`，而那个 throw 发生在
 * 工具注册循环之前，boot 当场中断——工具、观测台路由、调度器全没挂上，
 * `/dsh-fish/*` 一律 404。换成不了就不换 ctx，改在定义这一层包：
 * 只在注册那段同步代码里生效，出去之后立刻摘掉，`defineTool` 平时仍是恒等。
 */
let useWrap = null

/** 换掉注册期的包装钩子；返回上一个，供调用方恢复。 */
export function setToolUseWrap(fn) {
  const prev = useWrap
  useWrap = typeof fn === 'function' ? fn : null
  return prev
}

/**
 * 「这份定义是我们自己的」标记（2026-11-10，外部真机 0.9.7 的工具表污染报告）。
 *
 * 注册期我们仍然会换掉 `ctx.tools.register`（为了在真正下发之后记一笔 use 清单），
 * 但那个窗口里**别人**也可能在注册工具——宿主挂 preset、别的插件装工具。
 * 那些定义不是我们的：不包 execute、不记 use 账，原样从 `this` 转交。
 * 判据只能落在定义对象上，所以在这里打一个不可枚举的标记，不是按名字前缀猜。
 *
 * `defineTool(spec) === spec` 的约定不变：标记挂在同一个对象上，也不可枚举，
 * 对调用方与 JSON 序列化都不可见（test/tools.test.mjs 盯着这条）。
 */
export const OWN_TOOL = Symbol.for('dsh-fish.own-tool')

export const defineTool = (spec) => {
  try {
    if (spec && typeof spec === 'object' && spec[OWN_TOOL] !== true) {
      Object.defineProperty(spec, OWN_TOOL, { value: true, enumerable: false, configurable: true })
    }
  } catch {
    // 冻结对象之类打不上标记：退回老行为（下面 use.js 会把没标记的当别人的，注册照走、只是不记账）
  }
  return useWrap ? useWrap(spec) : spec
}

