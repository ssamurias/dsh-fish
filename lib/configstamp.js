/**
 * configstamp.js —— 「这一进程里刚写过配置」的计数器（1.0.5 起）
 *
 * 有些读取带文件缓存（`selfpronoun.js` 的 `config.json` mtime 缓存）。文件系统
 * 的 mtime 在 Windows 上只到毫秒级，同一进程里连着写两次配置（改称呼字、再改
 * 回来）可能落在同一个 mtime 上，缓存认不出变化，界面就还显示上一个称呼。
 *
 * 这里不碰文件，只记一个进程内的版本号：写配置的地方（`store.writeConfig`）
 * 调 `bumpConfigStamp()`，带缓存的读方把版本号一起当键。
 *
 * 只解决「同进程写→读」；别处（编辑器、另一个进程）改文件仍然靠 mtime。
 */

let stamp = 0

/** 配置刚被写过：版本号 +1。 */
export function bumpConfigStamp() {
  stamp += 1
  return stamp
}

/** 当前版本号。 */
export function configStamp() {
  return stamp
}
