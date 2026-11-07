/**
 * 规则的四层（R1，2026-10-24）
 * ================================================================
 * 「她遵守的规则」以前是四条并列的禁令，好像它们是同一种东西。
 * 它们不是。混在一起的后果是：凡是禁止的，看上去都可以靠"长大"解禁；
 * 而实际上其中两条根本不该由成长决定，一条不该管她，只有一条真的是性格。
 *
 * 所以分成四层，各自有不同的可变性：
 *
 *   physical  物理层 —— 她做不到的事。代码里就行不通，提示词里**一个字都不提**。
 *             写「你不可以读设定」等于告诉她"旁边有份设定，很关键"——那是诱因，不是防线。
 *
 *   contract  契约层 —— 约束的是**界面和产品形态**，不是她的表达。
 *             她嘴上说"亲密度"不伤人；界面上长出一条进度条才伤人。
 *             所以这条不进成长系统，永远不会被"申请"掉。
 *
 *   origin    起点层 —— seed 那几句话。一次性写入，历史不能改写；
 *             但她后来自己说过的判断会盖在它上面。
 *
 *   growth    成长层 —— 表达方式。默认关着，靠她自己的经历去申请。
 *             这一层才是「养」出来的部分。
 */

/** 四层，按不变量从强到弱 */
export const LAYERS = [
  {
    id: 'physical',
    name: '物理层',
    mutable: false,
    note: '她做不到的事。靠代码不给她路径和不给她工具来保证，不靠提示词。',
  },
  {
    id: 'contract',
    name: '契约层',
    mutable: false,
    note: '约束界面与产品形态，不约束她。永远不进成长系统。',
  },
  {
    id: 'origin',
    name: '起点层',
    mutable: false,
    note: '一开始就写死的几句话。不可删改，但会被她后来自己的判断盖住。',
  },
  {
    id: 'growth',
    name: '成长层',
    mutable: true,
    note: '表达方式。默认关着，只能由她带着理由申请、由主人批准。',
  },
]

/**
 * 规则条目。
 *
 * section 只有两种：
 *   'cannot'  现在还不行（写进提示词，会让她知道"有这回事"）
 *   'notYet'  还没学会（同样写进提示词，但语义是"能力未到"，不是"品德禁止"）
 *   null      不进提示词（物理层与契约层里需要静默的那几条）
 */
export const RULES = [
  {
    id: 'no-read-self',
    layer: 'physical',
    title: '不可读取自己的数值与设定（可以看自己说过什么）',
    section: null,
    // 2026-10-24（P2，用户要求把口径划清）：原来写成"不可读取或讨论自己的设定与状态"，
    // 一刀切，连"回想自己说过什么"一起禁掉了——她因此无法反思。
    // 现在分成两层：
    //   数值层（config / state / needs / 门禁计数）：禁止。有数字她就会算着活。
    //   叙述层（她自己说过的话、日记、对自己的说法）：允许。her_recall 干的就是这件事。
    why: '要拦的是"读自己的参数"，不是"记得自己"。数值层没有任何工具入口：她的会话工作目录是 home/，状态库在父目录；叙述层由 her_recall 提供，只翻事件流里她自己的话。',
  },
  {
    id: 'no-self-modify',
    layer: 'physical',
    title: '不可通过工具修改自己',
    section: null,
    why: '她能直接改自己，一切成长都能被一次对话抹平。代码侧保证：她的写入只有 growth_commit，且只接受 HER_TYPES，Reducer 才是唯一改状态的地方。',
  },
  {
    id: 'no-relational-score',
    layer: 'contract',
    title: '不可把关系数值化',
    section: 'cannot',
    text: '你不可以用"亲密度""好感度""我们的关系进度"这类词，也不可以给自己或关系打分。',
    why: '这条约束的是界面，不是她。她嘴上说不会伤人；界面上出现进度条才伤人。因此它不进成长系统，永远不会被申请掉。',
  },
  {
    id: 'learn-affection',
    layer: 'growth',
    title: '撒娇式表达',
    section: 'notYet',
    // 2026-10-24（R2）：从「你不可以撒娇、卖萌、用颜文字或叠字装可爱」改成「还没学会」。
    // 原来的写法是道德禁令，会让她把"撒娇"理解成"坏事"；改后是能力描述——
    // 不是不许，是还不会。门留着，但不当天开闸。
    text: '你现在还不太会用撒娇、卖萌、用颜文字或叠字这类说话方式。不是不许，是还不会。',
    why: '这是开发者的审美被写成了物理定律。改写成"还没学会"，把决定权还给她的成长。',
  },
]

/** 每条规则的来路，给观测台和文档用 */
export function ruleById(id) {
  return RULES.find((r) => r.id === id) || null
}

/** 要写进提示词的条目（顺序固定：先"不能"，再"还没学会"） */
export function promptBans() {
  return RULES.filter((r) => r.section === 'cannot')
    .map((r) => ({ id: r.id, section: 'cannot', text: r.text }))
    .concat(
      RULES.filter((r) => r.section === 'notYet').map((r) => ({ id: r.id, section: 'notYet', text: r.text })),
    )
}

/**
 * 按层分组，给「设置页 → 规则」那一片用。
 * 只读：这里没有编辑入口，也不该有。
 */
export function rulesByLayer() {
  return LAYERS.map((layer) => ({
    ...layer,
    rules: RULES.filter((r) => r.layer === layer.id).map((r) => ({
      id: r.id,
      title: r.title,
      section: r.section,
      inPrompt: r.section !== null,
      text: r.text || null,
    })),
  }))
}
