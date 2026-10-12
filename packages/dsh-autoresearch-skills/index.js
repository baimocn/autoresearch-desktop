/**
 * dsh-autoresearch-skills —— AutoResearch 合规审查与经验理论技能供应插件。
 *
 * 把三份来源登记为模型可调用的技能：
 *   · 教程 V3 附件的质检技能（autoresearch-task-qa、autoresearch-baseline-quality）
 *   · autoresearch-skills 上游 0.3.4 的完整 8 技能
 *   · SOP 出题实战经验（34 条执行规则、L1–L32 实战教训、失败模式、沙盒隔离、GPU 预算）
 *
 * 技能只提供决策规则和工作流，不扩大任务授权：安装质检技能不等于允许它运行不受信容器，
 * 安装运行隔离技能也不等于允许购买 GPU 或修改远端平台状态。
 *
 * @module dsh-autoresearch-skills
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { listSkills, readSkill, listSopResources, readSopSkill } from './lib/catalog.js'

export const name = 'autoresearch-skills'

export const inject = ['skills', 'tools']

/** 默认配置；见 dsh-autoresearch 中关于不导出 schemastery Config 的说明。 */
const DEFAULT_CONFIG = Object.freeze({
  /** 技能在目录中的排序权重；数值越大越靠后。 */
  rank: 550,
  /** 是否允许模型自动调用；关闭后仅用户可显式调用。 */
  modelInvocable: true,
  /** 是否注入 SOP 经验理论技能。 */
  includeSop: true,
})

/** 技能正文过长时截断，避免一次把整套参考资料塞进上下文。 */
const MAX_SKILL_CHARS = 240_000

export function apply(ctx, rawConfig) {
  const config = { ...DEFAULT_CONFIG, ...(rawConfig ?? {}) }
  const providerName = 'autoresearch'
  const rank = config.rank

  /** 惰性缓存目录扫描结果，避免每次列目录都打盘。 */
  let cachedList = null
  const listAll = async () => {
    if (cachedList === null) cachedList = await listSkills()
    return cachedList
  }

  const provider = {
    name: providerName,

    async list() {
      const { skills } = await listAll()
      const candidates = skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        whenToUse: skill.whenToUse ?? undefined,
        // 顶层 source / provider / invocation 是注册表校验的必需字段：
        // 缺 source 会被判 non-string 而拒绝注册，导致整个技能目录失效。
        source: skill.source,
        provider: providerName,
        invocation: { modelInvocable: config.modelInvocable, userInvocable: true },
        rank,
        locator: { source: skill.source, directory: skill.directory },
        metadata: {
          sourceLabel: skill.sourceLabel,
          produces: skill.produces,
          stops: skill.stops,
        },
      }))

      if (config.includeSop) {
        candidates.push({
          name: 'autoresearch-task-sop',
          description: '根据论文或获批任务制作 AutoResearch 科研题包：出题 SOP、验证检查表、五道里程碑门禁与 GPU 租用预算；' +
            '含 34 条执行规则与 L1–L32 实战教训。用于制作、验证、返修或梳理一道 AutoResearch 题目。',
          whenToUse: '制作、验证、返修或梳理一道 AutoResearch 题目时',
          source: 'bundled',
          provider: providerName,
          invocation: { modelInvocable: config.modelInvocable, userInvocable: true },
          rank: rank + 10,
          locator: { source: 'sop', directory: 'sop' },
          metadata: {
            sourceLabel: 'autoresearch-sop 出题实战经验',
            produces: '题包实现、五道里程碑判定、检查表与预算估算',
            stops: '任一里程碑未过不得进入下一阶段；不做总分补偿',
          },
        })
      }

      return candidates
    },

    async get(candidate) {
      if (candidate.name === 'autoresearch-task-sop') {
        const sop = await readSopSkill()
        if (sop === undefined) return undefined
        const resources = await listSopResources()
        return {
          name: 'autoresearch-task-sop',
          description: candidate.description,
          whenToUse: candidate.whenToUse,
          source: candidate.source,
          provider: providerName,
          content: composeSopContent(sop, resources),
          metadata: candidate.metadata,
        }
      }

      const skill = await readSkill(candidate.name)
      if (skill === undefined) return undefined
      return {
        name: skill.name,
        description: skill.description,
        whenToUse: skill.whenToUse ?? undefined,
        source: skill.source,
        provider: providerName,
        content: composeSkillContent(skill),
        metadata: {
          ...candidate.metadata,
          resources: skill.resources.map((resource) => resource.path),
        },
      }
    },
  }

  ctx.effect(() => ctx.skills.registerProvider(() => provider), 'autoresearch-skills: provider')

  // ── 工具：技能清单 ────────────────────────────────────────────────────────

  // ── 工具：读取单个技能正文 ────────────────────────────────────────────────

  ctx.logger?.info?.('autoresearch-skills: provider registered')
}

/** 组装技能正文：前置路由信息，正文后附资源索引。 */
function composeSkillContent(skill) {
  const header = [
    `<skill_routing name="${skill.name}" source="${skill.source}">`,
    `何时使用：${skill.whenToUse ?? '（见正文）'}`,
    `主要产出：${skill.produces ?? '（见正文）'}`,
    `停止条件：${skill.stops ?? '（见正文）'}`,
    '</skill_routing>',
    '',
  ].join('\n')

  const resources = skill.resources.length === 0
    ? ''
    : `\n\n<skill_resources>\n${skill.resources.map((resource) => `  ${resource.path}（${resource.bytes} 字节）`).join('\n')}\n</skill_resources>\n`

  const body = skill.content.length > MAX_SKILL_CHARS
    ? `${skill.content.slice(0, MAX_SKILL_CHARS)}\n\n[正文超长已截断；完整内容见 ${skill.skillDir}]`
    : skill.content

  return `${header}${body}${resources}`
}

/** 组装 SOP 技能正文：主入口 + 五道里程碑 + 资源索引。 */
function composeSopContent(sop, resources) {
  const byGroup = new Map()
  for (const resource of resources) {
    const group = resource.path.includes('/') ? resource.path.split('/')[0] : '（根）'
    if (!byGroup.has(group)) byGroup.set(group, [])
    byGroup.get(group).push(resource)
  }

  const index = [...byGroup.entries()]
    .map(([group, entries]) => `  ${group}/（${entries.length} 个文件）`)
    .join('\n')

  return [
    '<skill_routing name="autoresearch-task-sop" source="sop">',
    '何时使用：制作、验证、返修或梳理一道 AutoResearch 题目时',
    '主要产出：题包实现、五道里程碑判定、检查表与预算估算',
    '停止条件：任一里程碑未过不得进入下一阶段；不做总分补偿',
    '</skill_routing>',
    '',
    sop.content,
    '',
    '<skill_resources>',
    index,
    '',
    '关键文件：',
    '  references/production-sop.md      完整制作与验证流程（V01–V14）',
    '  references/field-lessons.md       实战教训 L1–L32',
    '  references/failure-patterns.md    跨题目失败模式（六类死因过滤器）',
    '  references/sandbox-isolation.md   隔离执行沙盒的五条判据与 11 类坑',
    '  references/gpu-budget.md          GPU 选型与预算',
    '  assets/checklist.md               制作与验证检查表',
    '  tools/milestone_gate.py           M1–M5 门禁（exit 0/1/2）',
    '  tools/nop_preflight.py            原生 NOP 环境前置预检',
    '  tools/paper_screen.py             选题期零成本筛查',
    '  tools/feasibility_gate.py         可行性闸门（判定门是否闭合）',
    '  tools/harbor_task_contract.py     task.toml 原生契约预检',
    '  tools/dockerfile_preflight.py     构建前静态预检',
    '  tools/replay_contract_gate.py     可复算契约预检',
    '  tools/sandbox_probe_gate.py       隔离沙盒实测自检',
    '  tools/candidate_surface_audit.py  候选空间枚举-勾选审计',
    '  tools/numeric_backsolve.py        跨规模参数数值反推',
    '</skill_resources>',
  ].join('\n')
}
