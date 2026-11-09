/**
 * toolreg.js —— 「她手边到底有哪些工具」的唯一真源（2026-11-08，用户 m00002）
 *
 * 为什么要有这个文件：
 *   以前这份清单是手写在 `lib/restrict.js` 的 `FISH_TOOLS` 里的。改一个工具要记得
 *   同时去改那张表，忘了就永远漏——要她看不见（进不了 allow）、界面也不显示
 *   （白名单那组「她自己本来就有的」是从表里来的）、自检也不查它。
 *   `bring_back` 与 `her_say` 就是这么漏掉的：工具在 `index.js` 里注册了，
 *   表里没有，于是设置页永远只显示旧的那几样。
 *
 * 现在的做法：
 *   `use.js` 在注册期把 `ctx.tools.register` 包了一层（为了记 `use:` 账），
 *   顺手把 `def.name` 记到这里。清单从此按**这一版真的注册了什么**现算，
 *   加工具只改一个地方（那个工具的模块），不用再回来抄表。
 *   宿主把 `ctx.tools` 包成只读 proxy 时换不上去，那一层改在 `defineTool` 上包
 *   （2026-11-10 外部真机），记账结果一样。
 *
 * 场景工具：
 *   有些工具不是「家里随时能用」的，只有特定场合才交给她。这类要在 `SCENE_TOOLS`
 *   里登记一句场合说明——登记之后它照样出现在界面上、自检照样查它，
 *   但**不进家里的工具面**（`bring_back` 在家里调用只会答「现在没在外面。」，
 *   给她一只永远答不出的手，等于每轮都在提醒她有件事做不了）。
 */

/** 这个进程里被她注册过的工具名（按注册顺序，重复注册只记一次）。 */
const registered = new Set()

/**
 * 注册期记一笔。只记账，不改任何行为——注册失败的工具不该被记进来，
 * 所以由调用方（`withUseDuringRegistration`）在真正下发之后调用。
 * @param {string} name
 */
export function noteRegisteredTool(name) {
  const n = String(name ?? '').trim()
  if (n) registered.add(n)
}

/** 此刻记下来的全部工具名（可能为空：还没走过注册）。 */
export function registeredToolNames() {
  return [...registered]
}

/** 只给测试用：清空记账，免得上一个用例的注册漏进下一个。 */
export function forgetRegisteredTools() {
  registered.clear()
}

/**
 * 只有特定场合才给她的工具。键是工具名，值是场合说明（会原样显示在设置页）。
 * **新增这类工具时在这里加一行**；普通的（家里随时能用的）不用登记。
 */
export const SCENE_TOOLS = Object.freeze({
  bring_back: {
    scene: 'outing',
    why: '只有出门在外那趟才用得上：她在别的工区看上了某个文件，问能不能带回家。在家没有可带的东西。',
  },
})

/**
 * 这一版真的注册了哪些工具。还没注册过（比如测试里只跑路由）就退回传进来的兜底清单，
 * 保证界面与自检在没有活体的场景下仍然有一份可说的话。
 * @param {readonly string[]} [fallback]
 * @returns {string[]}
 */
export function liveFishTools(fallback = []) {
  const live = registeredToolNames()
  return live.length ? live : [...fallback]
}

/**
 * 家里随时能用的那些（场景工具除外）。
 * @param {readonly string[]} [fallback]
 * @returns {string[]}
 */
export function homeFishTools(fallback = []) {
  return liveFishTools(fallback).filter((n) => !SCENE_TOOLS[n])
}

/**
 * 场景工具连同场合说明，供设置页单列一组。
 * @param {readonly string[]} [names]
 * @returns {{name: string, scene: string, why: string}[]}
 */
export function sceneFishTools(names = registeredToolNames()) {
  return (names ?? [])
    .filter((n) => SCENE_TOOLS[n])
    .map((n) => ({ name: n, scene: SCENE_TOOLS[n].scene, why: SCENE_TOOLS[n].why }))
}
