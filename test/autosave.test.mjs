import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

// 2026-10-24（用户 m03888）：设置项改成「改完就生效」。
// 原来的问题是：每个页签底部挂一颗「保存改动」，住所页没有设置项也挂着一颗，
// 让人以为必须点；上网页设置项很多，只改一半、没滚到底，改动就不生效且没有任何提示。
const CLIENT = new URL('../lib/client.js', import.meta.url)
const STATUS = new URL('../lib/status.js', import.meta.url)

test('设置页不再有底部保存条，改成改完即存', async () => {
  const src = await readFile(CLIENT, 'utf8')
  assert.ok(!src.includes(": '保存改动'"), '「保存改动」按钮必须删掉（已改为自动保存）')
  assert.ok(!src.includes('saveBar'), 'saveBar 必须整个删掉，不要留空壳')
  // 2026-11-08：措辞压短；上网页另说明 uid、昵称和登录有自己的保存键（那两处要手点）。
  assert.ok(src.includes("'改完自动保存。'"), '页面顶部要写明不需要点保存')
  assert.ok(src.includes('uid 和昵称、B 站登录各有自己的保存键'), '上网页要说清哪几样不是自动保存')
  assert.ok(src.includes('const buildConfig = () => ({'), '字段表要集中在一处（自动保存与手动保存共用）')
  assert.ok(src.includes('const badNumber = () =>'), '数字框半截值要先判，不写盘')
  assert.ok(src.includes('}, 700)'), '自动保存要防抖（连点加减号只写一次）')
  assert.ok(src.includes('setAutoNote(`已保存 '), '保存成功后要有回执，而不是静默')
})

test('自动保存不会在首屏载入时把配置回写一遍', async () => {
  const src = await readFile(CLIENT, 'utf8')
  assert.ok(src.includes('baselinePending.current = true'), '每次 load 都要重置基线')
  assert.ok(src.includes('if (baselinePending.current) { baselinePending.current = false; lastSaved.current = cfgSig; return }'),
    '首屏那次只记基线，不发请求')
  assert.ok(src.includes('if (cfgSig === lastSaved.current) return'), '签名没变就不发请求')
})

test('状态卡的四个句子按用户定稿改了', async () => {
  const src = await readFile(STATUS, 'utf8')
  for (const s of ['上次行动是在 ${minutesAgo} 分钟前', '会睡醒', '虽然什么都没干，但是累了，不会再醒了', '醒了，在发呆']) {
    assert.ok(src.includes(s), `status.js 里应有「${s}」`)
  }
  for (const s of ['上次动是', '会醒${mins', '今天不会再醒了', '醒了，但什么也没做']) {
    assert.ok(!src.includes(s), `status.js 里不该再有「${s}」`)
  }
})

test('「改完就生效」那句话只出现在真有设置项的页签', async () => {
  const src = await readFile(CLIENT, 'utf8')
  assert.ok(src.includes("const AUTO_SAVE_TABS = new Set(['grow', 'bili', 'memory'])"),
    '只有成长 / 上网 / 记忆三页是自动保存')
  assert.ok(src.includes("AUTO_SAVE_TABS.has(tab) ? h('p'"),
    '提示行要按当前页签判断')
  // 2026-10-29 用户：「没保存：不允许修改：bili」和「改完就生效，不需要点保存」挤在一起，
  // 两句没有联系、也不是同类型的提示。回执与失败框因此都搬到页签栏上方。
  assert.ok(!src.includes("AUTO_SAVE_TABS.has(tab) && autoNote ?"),
    '回执不许再塞回页签内容里（会和「改完就生效」混成一堆）')
  assert.ok(src.includes("h('p', { className: 'ok', style: { margin: '0 0 8px' } }, autoNote)"),
    '「已保存」回执放在页签栏上方')
  for (const t of ['now', 'home', 'env', 'data']) {
    assert.ok(!src.includes(`AUTO_SAVE_TABS = new Set(['grow', 'bili', 'memory', '${t}'`),
      `${t} 不该加进自动保存页签`)
  }
})

test('保存失败不再冒充提示行：一句人话 + 一行技术信息 + 自己点掉', async () => {
  const src = await readFile(CLIENT, 'utf8')
  // 失败文案先说「不是你填错了」，再给原因；技术字段名只出现在「技术信息」那一行。
  //
  // 2026-10-31（issue #14）：原来那句「可能是插件这一版还没接上它 / 改别的照样会存」
  // 已经删了——真实失败源是白名单里有这台机器上不存在的工具名，而「改别的照样会存」
  // 恰恰说反了：自动保存是整表提交，改别的也一起存不进去。
  assert.ok(src.includes('这一项没存上。不是你填错了'), '失败要说人话')
  assert.ok(src.includes('不是你填错了'), '不能让用户以为是自己填错了')
  assert.ok(!src.includes('改别的照样会存'), '「改别的照样会存」是假的：自动保存是整表提交')
  assert.ok(!src.includes('可能是插件这一版还没接上它'), '别再把责任推给「插件还没接上」')
  assert.ok(src.includes('技术信息：${saveFail}'), '技术信息单独一行，别混进人话里')
  assert.ok(src.includes("onClick: () => setSaveFail('')"), '失败框要点得掉，不能一直挂着')
  assert.ok(!src.includes('没保存：${e.message}'), '别再把原始报错直接拼在「没保存：」后面')
  // 回执会自己消失（2.5 秒），不会一直停在页签下面。
  assert.ok(src.includes('setTimeout(() => setAutoNote(\'\'), 2500)'), '回执要自动消失')
})
