/**
 * wakewin.js —— 「现在是不是定时器在叫醒她」
 *
 * 为什么需要这个小模块：
 *   absence（冷落天数）要靠「他有没有来」来判断。可是她写东西只有 growth_commit 一个口，
 *   定时唤醒时她也会写 —— 如果把写东西一律当"他来过"，冷落永远检测不出来。
 *
 *   所以用一个进程内的时间窗把两类来源分开：
 *     - 窗口内写入 = 定时器叫醒的（她自己在想事情，不代表他在）
 *     - 窗口外写入 = 有人跟她说话了她才写（这就是他来过）
 *
 * 局限（如实记录，别当它完美）：进程重启会丢窗口状态；若他恰好在窗口那几分钟里
 * 亲自说话，那一次会被误记成"她自己在想"。P1 接受这个误差 —— 冷落天数是个
 * 粗粒度信号（隔 2 天才触发），偶尔差一次不影响阶段判断。
 *
 * 窗口要开到**这一轮结束**，不是开到消息入队为止：`sessionController.prompt()`
 * 入队就 resolve，她还没开始想。用 withWake 包住 prompt()，窗口在她开口之前就关了，
 * 她醒来写的每一句都被记成"他来过"。唤醒用 holdWake，在 turn/end 时再关。
 */

let depth = 0

export function enterWake() {
  depth++
}

export function leaveWake() {
  depth = Math.max(0, depth - 1)
}

export function inWake() {
  return depth > 0
}

/**
 * 把窗口打开，返回关窗的函数。关窗函数只生效一次，turn/end、兜底、失败几条路都可以放心调。
 */
export function holdWake() {
  enterWake()
  let held = true
  return () => {
    if (!held) return
    held = false
    leaveWake()
  }
}

/** 包一层：fn 跑完（无论成败）就关上。fn 只是把消息排进队列时别用它，见文件头。 */
export async function withWake(fn) {
  enterWake()
  try {
    return await fn()
  } finally {
    leaveWake()
  }
}
