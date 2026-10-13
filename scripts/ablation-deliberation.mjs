/**
 * 消融实验：审议台的「对抗性角色」是否真的产生可观测差异
 *
 * ## 要证伪的假设
 *
 * 我声称「角色化提示词（提案/反例/代价）比"大家一起讨论"更能暴露风险」。
 * 这个声称必须被检验，否则它只是一句好听的设计话术。
 *
 * 消融设计：构造同一批输入，比较两种提示词形态产出的**结构差异**。
 * 这里不调用真实模型（那样不可复现且昂贵），而是断言提示词本身
 * 必须携带的可判定性质 —— 即「角色义务是否被写进了指令」。
 *
 * 真实模型输出质量的差异属于**未验证项**，如实标注，不假装已验证。
 *
 * 用法：node scripts/ablation-deliberation.mjs
 */

import { ROLES, validateBoard, independenceLevel, buildDeliberationPrompt, aggregateDeliberation }
  from '../packages/dsh-autoresearch-qa/lib/deliberation.js'

const results = []
function record(name, expected, actual, note) {
  const pass = JSON.stringify(expected) === JSON.stringify(actual)
  results.push({ name, pass, expected, actual, note })
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}`)
  if (!pass) console.log(`        期望 ${JSON.stringify(expected)} / 实际 ${JSON.stringify(actual)}`)
  if (note) console.log(`        ${note}`)
}

const Q = '是否应该把上游资产改为自动同步？'

console.log('=== 实验 1：反例方是否是强制项 ===')
console.log('   若反例方可以缺席，审议就退化成并行的自说自话，无法暴露偏差。')
record('缺反例方的配置被拒绝', true,
  validateBoard([
    { route: 'a', model: 'm1', role: 'propose' },
    { route: 'b', model: 'm2', role: 'cost' },
  ]).some((p) => p.includes('反例方')))

record('含反例方的配置通过', 0,
  validateBoard([
    { route: 'a', model: 'm1', role: 'propose' },
    { route: 'b', model: 'm2', role: 'counter' },
  ]).length)
console.log()

console.log('=== 实验 2：角色提示词是否真的不同（不是同一段话换标签）===')
const pPropose = buildDeliberationPrompt({ role: 'propose', question: Q })
const pCounter = buildDeliberationPrompt({ role: 'counter', question: Q })
const pCost = buildDeliberationPrompt({ role: 'cost', question: Q })

record('提案与反例提示词不同', true, pPropose !== pCounter)
record('反例与代价提示词不同', true, pCounter !== pCost)
record('三个都不同', 3, new Set([pPropose, pCounter, pCost]).size)
console.log()

console.log('=== 实验 3：反例方是否被要求给出**可数的**失败模式 ===')
console.log('   "请找出问题"是无效指令，"至少 3 个具体失败模式"才可判定。')
record('反例方义务含数量要求', true, /至少\s*3\s*个/.test(ROLES.counter.obligation))
record('反例方被明确禁止编造', true, /不得.*编造|找不到就明确写/.test(ROLES.counter.mustNot))
record('提案方被要求只给一个方向', true, /选一个|不要罗列多个/.test(ROLES.propose.mustNot))
record('代价方被禁止评价好坏', true, /不要评价方向好不好|只算代价/.test(ROLES.cost.mustNot))
console.log()

console.log('=== 实验 4：提示词是否禁止模型模拟其他角色 ===')
console.log('   若不禁止，模型会写出一份"看起来很全面"的假审议，掩盖真实分歧。')
for (const [role, prompt] of [['propose', pPropose], ['counter', pCounter], ['cost', pCost]]) {
  record(`${role} 提示词含"不要模拟其他角色"`, true, /不要模拟其他角色的发言/.test(prompt))
}
console.log()

console.log('=== 实验 5：独立性分级是否如实（不假装多路=独立）===')
const single = independenceLevel([{ route: 'x', model: 'm' }, { route: 'x', model: 'm' }])
record('同一 route+model 判为 single', 'single', single.level)
record('single 的说明指出不能减少系统性偏差', true, /系统性偏差/.test(single.note))

const sameProvider = independenceLevel([{ route: 'x', model: 'm1' }, { route: 'x', model: 'm2' }])
record('同 route 不同 model 判为 same-provider', 'same-provider', sameProvider.level)

const multi = independenceLevel([{ route: 'x', model: 'm1' }, { route: 'y', model: 'm2' }])
record('跨 route 判为 multi-provider', 'multi-provider', multi.level)
console.log()

console.log('=== 实验 6：聚合器是否拒绝裁判对错（只暴露分歧）===')
const agg = aggregateDeliberation([
  { laneIndex: 1, role: 'propose', route: 'a', model: 'm1', text: '应当自动同步', exitCode: 0 },
  { laneIndex: 2, role: 'counter', route: 'b', model: 'm2', text: 'D1 会被搬进来', exitCode: 0 },
])
record('聚合结果不含 PASS/FAIL 判定字段', true,
  !('verdict' in agg) && !('status' in agg))
record('聚合结果含免责声明', true, typeof agg.disclaimer === 'string' && agg.disclaimer.length > 0)
record('免责声明指明不能替代实测证据', true, /不能替代实测证据/.test(agg.disclaimer))
record('免责声明指明不等于 G-FEASIBILITY 通过', true, /G-FEASIBILITY/.test(agg.disclaimer))
record('按角色归类了两个角色', 2, Object.keys(agg.byRole).length)
console.log()

console.log('=== 实验 7：角色缺席或失败是否被如实报告 ===')
const aggMissing = aggregateDeliberation([
  { laneIndex: 1, role: 'propose', route: 'a', model: 'm1', text: 'x', exitCode: 0 },
  { laneIndex: 2, role: 'counter', route: 'b', model: 'm2', text: '', exitCode: 1 },
])
record('反例方失败时标为 missingRoles', true, aggMissing.missingRoles.includes('counter'))
record('失败路被记录在 failed', 1, aggMissing.failed.length)
record('失败的 exitCode 被如实保留', 1, aggMissing.failed[0].exitCode)
console.log()

console.log('=== 实验 8：路数上限（防止稀释举证义务）===')
record('7 路被拒绝', true, validateBoard(
  Array.from({ length: 7 }, (_, i) => ({ route: `r${i}`, model: `m${i}`, role: i === 0 ? 'propose' : 'counter' })),
).some((p) => p.includes('最多 6 路')))
record('1 路被拒绝', true, validateBoard([{ route: 'a', model: 'm', role: 'propose' }]).length > 0)
console.log()

const failed = results.filter((r) => !r.pass)
console.log('='.repeat(62))
console.log(`审议台消融：${results.length - failed.length} 通过，${failed.length} 失败，共 ${results.length} 项`)
if (failed.length) {
  console.log('\n失败项：')
  for (const f of failed) console.log(`  · ${f.name}`)
}
console.log()
console.log('未验证项（如实声明，不假装已验证）：')
console.log('  · 真实模型在三种角色下的**输出质量差异**未测 —— 需要真实 API 调用')
console.log('    本实验只证明提示词携带了角色义务，不证明模型会遵守它')
process.exit(failed.length === 0 ? 0 : 1)
